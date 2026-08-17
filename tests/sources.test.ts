import { test, expect, describe } from "bun:test";

import { Refused, SOURCE_TYPES } from "../src/db/models.ts";
import { newId, nowMs } from "../src/db/tx.ts";
import {
  createSource,
  deleteSource,
  getSource,
  listSources,
  normalizeHosts,
  searchSources,
  updateSource,
} from "../src/repo/sources.ts";
import type { SourceInput } from "../src/repo/sources.ts";
import { harness, seedSource, seedRecipe } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

function refusal(fn: () => unknown): Refused {
  try {
    fn();
  } catch (err) {
    if (err instanceof Refused) return err;
    throw err;
  }
  throw new Error("expected a refusal, got a result");
}

/** A published report, standing while a source is deleted out from under it. The document is a
 * column, so a fixture writing the row directly supplies the bytes like the publish path does;
 * nothing here reads them back. */
function seedReport(h: Harness): string {
  const recipeId = seedRecipe(h.db);
  const id = newId();
  h.db
    .query("INSERT INTO report (name, id, recipe_id, title, content, created_at) VALUES ('rpt-' || lower(hex(randomblob(5))), ?, ?, ?, ?, ?)")
    .run(id, recipeId, "A report", "<article><p>A report.</p></article>", nowMs());
  return id;
}

/** Every table holding a foreign key into `table`, read off the live database rather than off a
 * list somebody remembered to keep up to date. */
function referrersOf(h: Harness, table: string): string[] {
  const names = h.db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  const out: string[] = [];
  for (const { name } of names) {
    const keys = h.db.query<{ table: string }, []>(`PRAGMA foreign_key_list(${name})`).all();
    if (keys.some((key) => key.table === table)) out.push(name);
  }
  return out.sort();
}

describe("recording a source", () => {
  test("stores the credential variable's NAME, and has nowhere to put the value itself", () => {
    const h = harness();
    try {
      const source = createSource(h.db, {
        source: "Nasdaq Data Link",
        type: "trusted_data_vendor",
        domain: "prices",
        method: "GET /api/v3/datasets/{code}.json?api_key=$NDL_KEY",
        hosts: ["data.nasdaq.com"],
        authEnv: "NDL_KEY",
      });
      expect(source.auth_env).toBe("NDL_KEY");
      expect(getSource(h.db, source.id)!.auth_env).toBe("NDL_KEY");

      // Listing the columns rather than asserting that one particular secret is absent: "the value
      // never lands in the database" is a promise about every write there will ever be, and the
      // only way to keep it is to have nowhere the value could go. These eleven are the whole row,
      // and the closest any of them comes to a credential is the NAME of a variable.
      expect(Object.keys(source).sort()).toEqual([
        "auth_env",
        "created_at",
        "domain",
        "failure_cases",
        "hosts",
        "id",
        "method",
        "name",
        "source",
        "type",
        "updated_at",
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("refuses the same site twice, whatever the capitalisation", () => {
    const h = harness();
    try {
      createSource(h.db, {
        source: "Apple IR",
        type: "issuer_primary",
        domain: "filings",
        method: "browse investor.apple.com",
        hosts: ["investor.apple.com"],
      });
      const err = refusal(() =>
        createSource(h.db, {
          source: "apple ir",
          type: "issuer_primary",
          domain: "filings",
          method: "same place",
          hosts: ["investor.apple.com"],
        }),
      );
      expect(err.kind).toBe("conflict");
      expect(err.message).toContain("already exists");
    } finally {
      h.cleanup();
    }
  });
});

describe("where a source publishes", () => {
  test("normalizes to what a URL parser would resolve, so one host is one entry", () => {
    // HOSTS ARE ADVISORY, and this test is about the column that is left. There is no publish check
    // to agree with any more: a report used to declare the addresses it said it had read, and
    // publishing refused one whose hostname was not on the cited source's list — but nothing ever
    // fetched a page, so that check only ever compared the model's account of its reading against
    // the user's account of where a source publishes. What `hosts` is now is the address book entry
    // a person reads and the agent is pointed at, and normalization is what keeps one host from
    // being filed as two: case and IDN spelling are the two ways the same host gets written
    // differently by a person and by a browser, and the parser settles both the way a browser
    // would.
    expect(normalizeHosts(["  investor.apple.com  "])).toEqual(["investor.apple.com"]);
    expect(normalizeHosts(["INVESTOR.Apple.COM"])).toEqual(["investor.apple.com"]);
    expect(normalizeHosts(["投資.jp"])).toEqual(["xn--oru425g.jp"]);
    // Already-punycode passes through untouched, so a source recorded twice — once in the script,
    // once in the ASCII form — does not end up with two rows meaning one host.
    expect(normalizeHosts(["xn--oru425g.jp"])).toEqual(["xn--oru425g.jp"]);

    // A trailing dot is the fully qualified spelling of the same host, so it collapses — and the
    // dedupe runs after that, which is what makes these three one entry rather than three.
    expect(normalizeHosts(["example.com.", "EXAMPLE.com", "example.com"])).toEqual(["example.com"]);

    // Order survives the dedupe, because the list is read back to a person in a refusal.
    expect(normalizeHosts(["b.example", "a.example", "b.example"])).toEqual([
      "b.example",
      "a.example",
    ]);
  });

  test("refuses anything that is not a bare hostname, naming the entry", () => {
    // Each of these would otherwise be SILENTLY truncated by the URL parser to something shorter
    // than what was written — `https://x` to `x`, `x/path` to `x`, `x?y` to `x` — so the row would
    // end up naming a whole domain where somebody wrote down one page of it. Advisory or not, an
    // entry that quietly becomes something other than what was typed is worse than a refusal: it is
    // read as the address of record by the next person and by the agent alike. So each is refused
    // with the entry in the sentence.
    for (const bad of [
      "https://investor.apple.com",
      "investor.apple.com/filings",
      "investor.apple.com:8080",
      "user@investor.apple.com",
      "investor.apple.com?q=1",
      "investor.apple.com#top",
      "investor.apple.com\\filings",
      "investor apple com",
      "*.apple.com",
    ]) {
      const err = refusal(() => normalizeHosts([bad]));
      expect(err.kind).toBe("invalid_request");
      expect(err.message).toContain(JSON.stringify(bad));
    }

    // A blank entry is its own complaint: nothing was truncated, the caller simply left a gap.
    for (const blank of ["", "   ", "\n"]) {
      expect(refusal(() => normalizeHosts([blank])).message).toContain("a blank hostname is not one");
    }

    // And no hosts at all is refused here rather than being left to the schema's CHECK, which would
    // answer in the vocabulary of json_array_length.
    expect(refusal(() => normalizeHosts([])).message).toContain("at least one host");
  });

  test("the column holds JSON and every read path hands back an array", () => {
    const h = harness();
    try {
      const source = createSource(h.db, {
        source: "Apple IR",
        type: "issuer_primary",
        domain: "filings",
        method: "browse",
        hosts: ["Investor.Apple.com", "apple.com."],
      });
      const expected = ["investor.apple.com", "apple.com"];
      expect(source.hosts).toEqual(expected);

      // Three doors out of this module, and a caller must not have to remember which one hydrates.
      expect(getSource(h.db, source.id)!.hosts).toEqual(expected);
      expect(listSources(h.db)[0]!.hosts).toEqual(expected);
      expect(listSources(h.db, { type: "issuer_primary" })[0]!.hosts).toEqual(expected);
      expect(searchSources(h.db, "filings")[0]!.hosts).toEqual(expected);

      // And the column itself is text, which is why the hydration has to exist at all.
      const raw = h.db
        .query<{ hosts: string }, [string]>("SELECT hosts FROM information_source WHERE id = ?")
        .get(source.id)!;
      expect(typeof raw.hosts).toBe("string");
      expect(JSON.parse(raw.hosts)).toEqual(expected);
    } finally {
      h.cleanup();
    }
  });

  test("a patch replaces the whole list, because a source that moved is not there any more", () => {
    const h = harness();
    try {
      const source = createSource(h.db, {
        source: "Apple IR",
        type: "issuer_primary",
        domain: "filings",
        method: "browse",
        hosts: ["old.apple.example", "investor.apple.com"],
      });
      const moved = updateSource(h.db, source.id, { hosts: ["investor.apple.com"] });
      // Not a union with what was there. A company that moved its filings needs the old host GONE,
      // or the address book goes on sending the next reader — and the agent — to an address the
      // source abandoned.
      expect(moved.hosts).toEqual(["investor.apple.com"]);
      expect(getSource(h.db, source.id)!.hosts).toEqual(["investor.apple.com"]);

      // A patch that does not mention hosts leaves them exactly as they were, round-tripping
      // through the JSON without the list quietly becoming a string of one.
      expect(updateSource(h.db, source.id, { method: "the JSON endpoint" }).hosts).toEqual([
        "investor.apple.com",
      ]);

      // And the refusals reach through the patch, so a bad host cannot be edited in where it could
      // not have been created.
      expect(refusal(() => updateSource(h.db, source.id, { hosts: [] })).kind).toBe(
        "invalid_request",
      );
      expect(refusal(() => updateSource(h.db, source.id, { hosts: ["https://x"] })).kind).toBe(
        "invalid_request",
      );
      expect(getSource(h.db, source.id)!.hosts).toEqual(["investor.apple.com"]);
    } finally {
      h.cleanup();
    }
  });
});

describe("there is no credential column", () => {
  test("a raw INSERT naming it finds no such column, and no search reaches the words it would hold", () => {
    const h = harness();
    try {
      // A `credential` column would be prose about what stands behind a source's access — "paid
      // subscription", "the issuer itself". It answers no question this table exists to answer, and
      // it would sit one careless write away from holding the secret itself, which is the one thing
      // a database must never be handed. The answer is not a shorter column but no column:
      // `auth_env` names the environment variable, and the value stays in the environment.
      expect(() =>
        h.db
          .query(
            `INSERT INTO information_source
               (name, id, source, type, domain, method, credential, created_at, updated_at)
             VALUES ('src-' || lower(hex(randomblob(5))), ?, 'Some vendor', 'trusted_data_vendor', 'prices', 'GET', ?, 0, 0)`,
          )
          .run(newId(), "paid subscription"),
      ).toThrow(/no column named credential/);

      // `searchSources` LIKEs across the columns this table has, and an access note is not one of
      // them, so no source can be found by the words of one. The miss below is the pin; the hit
      // beside it is what makes the miss mean something, because a search that had simply broken
      // would also return nothing — and the phrase it does find lives in `method`, where a note
      // about HOW to fetch belongs.
      createSource(h.db, {
        source: "Nasdaq Data Link",
        type: "trusted_data_vendor",
        domain: "prices",
        method: "GET /api/v3/datasets/{code}.json?api_key=$NDL_KEY",
        hosts: ["data.nasdaq.com"],
        authEnv: "NDL_KEY",
      });
      expect(searchSources(h.db, "paid subscription")).toEqual([]);
      expect(searchSources(h.db, "api_key").map((s) => s.source)).toEqual(["Nasdaq Data Link"]);
    } finally {
      h.cleanup();
    }
  });
});

describe("auth_env", () => {
  const base: SourceInput = {
    source: "Vendor",
    type: "trusted_data_vendor",
    domain: "prices",
    method: "GET",
    hosts: ["vendor.example"],
  };

  test("refuses a name that is not a POSIX environment variable name", () => {
    const h = harness();
    try {
      for (const name of ["1KEY", "my key", "KEY-1", "$KEY"]) {
        const err = refusal(() => createSource(h.db, { ...base, authEnv: name }));
        expect(err.kind).toBe("invalid_request");
        expect(err.message).toContain("environment variable name");
      }
    } finally {
      h.cleanup();
    }
  });

  test("refuses the two namespaces that are stripped before a script runs, case-insensitively", () => {
    const h = harness();
    try {
      for (const name of ["SEIKAN_TOKEN", "seikan_token", "YEWREVIEW_KEY", "YewReview_Key"]) {
        const err = refusal(() => createSource(h.db, { ...base, authEnv: name }));
        expect(err.message).toContain("never be readable");
      }
    } finally {
      h.cleanup();
    }
  });

  test("an empty string takes a source off its credential", () => {
    const h = harness();
    try {
      const source = createSource(h.db, { ...base, authEnv: "VENDOR_KEY" });
      expect(updateSource(h.db, source.id, { authEnv: "" }).auth_env).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe("how far a source sits from the fact", () => {
  test("the vocabulary is six values, and every one of them is a source you can actually file", () => {
    const h = harness();
    try {
      // `SOURCE_TYPES` is a hand-written copy of a CHECK constraint, and a hand-written copy of
      // anything is a lie waiting for the next change. Filing a row under each is what keeps the
      // two lists one list: a value added to the array and not to the schema fails on the INSERT
      // here rather than the first time a user picks it.
      for (const type of SOURCE_TYPES) {
        const source = createSource(h.db, {
          source: `Somewhere publishing ${type}`,
          type,
          domain: "filings",
          method: "browse",
          hosts: [`${type.replace(/_/g, "-")}.example`],
        });
        expect(source.type).toBe(type);
      }
      expect(listSources(h.db)).toHaveLength(6);
    } finally {
      h.cleanup();
    }
  });

  test("the two individual types are not in it, and neither layer will take one", () => {
    const h = harness();
    try {
      // `individual_verified` and `individual_unverified` are not values on this scale. They would
      // be a fact about a PERSON rather than about the distance from the fact, which is what every
      // other value here measures, and no report would be weighed differently for meeting one — so
      // the vocabulary does not carry them at all. A caller asking for one is holding a vocabulary
      // this table does not speak, and the refusal hands back the whole of the real one because
      // picking again is the only move from here.
      for (const absent of ["individual_verified", "individual_unverified"] as const) {
        const err = refusal(() =>
          createSource(h.db, {
            source: `Some blog (${absent})`,
            type: absent as never,
            domain: "commentary",
            method: "read it",
            hosts: ["blog.example"],
          }),
        );
        expect(err.kind).toBe("invalid_request");
        expect(err.message).toContain(`unknown source type "${absent}"`);
        for (const type of SOURCE_TYPES) expect(err.message).toContain(type);

        // And past the repository, the way a future writer of some other path would go. The
        // readable sentence is above; this is the rule.
        expect(() =>
          h.db
            .query(
              `INSERT INTO information_source
                 (name, id, source, type, domain, method, hosts, created_at, updated_at)
               VALUES ('src-' || lower(hex(randomblob(5))), ?, ?, ?, 'commentary', 'read it', '["blog.example"]', 0, 0)`,
            )
            .run(newId(), `raw ${absent}`, absent),
        ).toThrow(/CHECK constraint failed/);
      }
      expect(listSources(h.db)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("is not fixed at creation, and the database does not pretend it is", () => {
    const h = harness();
    try {
      const sourceId = seedSource(h.db);
      // THE PIN IS ON A PERMISSION, and it is written down rather than left implicit because a rule
      // this consequential must not be able to arrive quietly either. The type is how far a source
      // sits from the fact, and reclassifying a standing row re-weighs every report that drew on
      // it — so the consequence is written beside the field in the form, where the person deciding
      // reads it, rather than enforced by a trigger. The address book is the user's, and a rule
      // whose only effect would be to make them delete a row and retype six fields to fix a
      // misfiling protects nothing — the more so since deleting is not guarded either: what a
      // published report said about a source is in the document, and the archive keeps the row that
      // left in the deletion log.
      h.db
        .query("UPDATE information_source SET type = 'trusted_data_vendor' WHERE id = ?")
        .run(sourceId);
      expect(getSource(h.db, sourceId)!.type).toBe("trusted_data_vendor");

      // And there is no such trigger at all, rather than one sitting quiet, so nothing can wake one.
      const triggers = h.db
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND tbl_name = 'information_source'`,
        )
        .all();
      expect(triggers.map((row) => row.name)).not.toContain(
        "information_source_type_is_immutable",
      );
    } finally {
      h.cleanup();
    }
  });

  test("a patch touching everything else round-trips without waking the rule", () => {
    const h = harness();
    try {
      const source = createSource(h.db, {
        source: "TWSE",
        type: "regulatory_government",
        domain: "monthly revenue",
        method: "MOPS query form",
        hosts: ["mops.twse.com.tw"],
        failureCases: "2026-01-02: served a stale page",
        authEnv: "TWSE_KEY",
      });
      const updated = updateSource(h.db, source.id, {
        source: "TWSE MOPS",
        domain: "monthly revenue and filings",
        method: "MOPS JSON endpoint",
        failureCases: "2026-01-02: served a stale page\n2026-03-04: 500s for an hour",
        authEnv: "MOPS_KEY",
      });
      expect(updated).toMatchObject({
        source: "TWSE MOPS",
        domain: "monthly revenue and filings",
        method: "MOPS JSON endpoint",
        auth_env: "MOPS_KEY",
      });
      expect(updated.failure_cases).toContain("500s for an hour");
      // Every editable column moved at once and the type stayed exactly where it was filed.
      expect(updated.type).toBe("regulatory_government");
      expect(getSource(h.db, source.id)!.type).toBe("regulatory_government");
    } finally {
      h.cleanup();
    }
  });

  test("a field left out is left alone", () => {
    const h = harness();
    try {
      const source = createSource(h.db, {
        source: "TWSE",
        type: "regulatory_government",
        domain: "monthly revenue",
        method: "MOPS query form",
        hosts: ["mops.twse.com.tw"],
        failureCases: "2026-01-02: served a stale page",
      });
      const updated = updateSource(h.db, source.id, { method: "MOPS JSON endpoint" });
      expect(updated.method).toBe("MOPS JSON endpoint");
      expect(updated.domain).toBe("monthly revenue");
      expect(updated.failure_cases).toBe("2026-01-02: served a stale page");
      expect(updated.updated_at).toBeGreaterThanOrEqual(source.updated_at);
    } finally {
      h.cleanup();
    }
  });
});

describe("failure cases", () => {
  test("are a field the user edits, and the whole column is replaced by a patch", () => {
    // There is no `appendFailureCase`, because this pen is not the agent's. An append and a patch
    // are different acts: a failure that happened stays true forever, so an appending column only
    // ever grows. What this field is instead is a textarea, and the dated-line habit is the user's —
    // which is the honest arrangement, since the person deciding they do not trust a source is the
    // person who has to remember why.
    const h = harness();
    try {
      const id = seedSource(h.db);
      const first = updateSource(h.db, id, {
        failureCases: "2026-01-02: reported Q1 revenue before restating it",
      });
      expect(first.failure_cases).toContain("reported Q1 revenue");

      // Replaced wholesale, not appended to — which is what a form's Save means, and why the field
      // is a textarea holding every line rather than a box for the next one.
      const second = updateSource(h.db, id, {
        failureCases:
          "2026-01-02: reported Q1 revenue before restating it\n2026-02-11: PDF was truncated",
      });
      expect(second.failure_cases!.split("\n")).toHaveLength(2);

      // And blank clears it, which is how a source stops having a history of being wrong.
      expect(updateSource(h.db, id, { failureCases: "" }).failure_cases).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe("deleting a source", () => {
  test("goes through with published reports standing, because none of them points at a source", () => {
    const h = harness();
    try {
      const id = seedSource(h.db);
      const reportId = seedReport(h);

      // THE PIN IS ON AN ABSENCE, and it is the decision rather than an oversight. A report used to
      // declare the addresses it said it had read and the source publishing at each, the foreign
      // key on that table carried no ON DELETE, and a source with a standing citation could not be
      // deleted at all. Those rows were the model's own account of its reading — nothing fetched a
      // page, and nothing ever compared a quoted sentence to one — so they were dropped. What a
      // published document says about a source is now IN the document, which is immutable, so
      // deleting the row cannot change what any report claims; it changes only what the archive can
      // still show a reader about where those numbers were said to come from.
      expect(deleteSource(h.db, id)).toBe(true);
      expect(getSource(h.db, id)).toBeNull();
      expect(
        h.db.query<{ id: string }, [string]>("SELECT id FROM report WHERE id = ?").get(reportId),
      ).not.toBeNull();

      // Read off the live schema rather than off the one delete above, because what is being
      // pinned is that NOTHING holds the address book down: no table anywhere keeps a foreign key
      // into it, which is why there is no guard left to write and none to forget.
      expect(referrersOf(h, "information_source")).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("returns false for a source that is already gone", () => {
    const h = harness();
    try {
      expect(deleteSource(h.db, "nothing")).toBe(false);
      const id = seedSource(h.db);
      expect(deleteSource(h.db, id)).toBe(true);
      expect(getSource(h.db, id)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("writes exactly one deletion-log row, holding the row that left", () => {
    const h = harness();
    try {
      const source = createSource(h.db, {
        source: "A newsletter",
        type: "independent_research",
        domain: "commentary",
        method: "read the weekly email",
        hosts: ["news.example"],
        failureCases: "2026-02-01: reprinted a rumour as fact",
      });
      expect(deleteSource(h.db, source.id)).toBe(true);

      const logged = h.db
        .query<{ table_name: string; row_id: string; row_json: string }, []>(
          "SELECT table_name, row_id, row_json FROM deletion_log ORDER BY id",
        )
        .all();
      expect(logged).toHaveLength(1);
      expect(logged[0]!.table_name).toBe("information_source");
      expect(logged[0]!.row_id).toBe(source.id);

      // The whole row, as the TABLE held it — `hosts` is the JSON text of the column rather than
      // the array this module hands its callers, because what is being witnessed is what was
      // stored. Every field survives, which is the difference between a log and a note that
      // something happened.
      const row = JSON.parse(logged[0]!.row_json) as Record<string, unknown>;
      expect(row["id"]).toBe(source.id);
      expect(row["source"]).toBe("A newsletter");
      expect(row["type"]).toBe("independent_research");
      expect(row["hosts"]).toBe('["news.example"]');
      expect(row["failure_cases"]).toContain("reprinted a rumour");

      // A delete that removed nothing witnesses nothing: the log records acts, not attempts, and
      // this is the only way left to ask for one that does not happen — there is no refusal to
      // provoke here any more.
      expect(deleteSource(h.db, "nothing")).toBe(false);
      expect(
        h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM deletion_log").get()!.n,
      ).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});

describe("listing and searching", () => {
  test("lists by name case-insensitively and narrows by type", () => {
    const h = harness();
    try {
      createSource(h.db, {
        source: "zeta filings",
        type: "regulatory_government",
        domain: "filings",
        method: "browse",
        hosts: ["zeta.example"],
      });
      createSource(h.db, {
        source: "Alpha IR",
        type: "issuer_primary",
        domain: "filings",
        method: "browse",
        hosts: ["alpha.example"],
      });
      expect(listSources(h.db).map((s) => s.source)).toEqual(["Alpha IR", "zeta filings"]);
      expect(listSources(h.db, { type: "issuer_primary" }).map((s) => s.source)).toEqual([
        "Alpha IR",
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("search treats % and _ as characters, not wildcards", () => {
    const h = harness();
    try {
      createSource(h.db, {
        source: "Percent Co",
        type: "independent_research",
        domain: "yields quoted in %",
        method: "read",
        hosts: ["percent.example"],
      });
      createSource(h.db, {
        source: "Other Co",
        type: "independent_research",
        domain: "equities",
        method: "read",
        hosts: ["other.example"],
      });
      expect(searchSources(h.db, "in %").map((s) => s.source)).toEqual(["Percent Co"]);
      expect(searchSources(h.db, "%")).toHaveLength(1);
      expect(searchSources(h.db, "equit").map((s) => s.source)).toEqual(["Other Co"]);
    } finally {
      h.cleanup();
    }
  });
});
