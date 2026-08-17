/**
 * The script table, against a real database and a real `var/`.
 *
 * The program is a COLUMN. That is what this file is mostly about, and the way to prove it is not
 * to read the column back — it is to look at the filesystem and find nothing there. So the var tree
 * is walked, not sampled: a canonical copy on disk would show up as a file, and a file is exactly
 * what a script must not leave behind.
 *
 * Nothing a script produced is a file this database knows the name of either, so deleting one is
 * rows and nothing after the commit — a bare boolean, with no paths handed back for a caller to
 * unlink and no second step for a crash to land between.
 *
 * ONE UNIQUENESS IS LEFT AND IT IS ABOUT THE PROGRAM. `idx_script_active_source` is partial —
 * scoped to the scripts still in service, which is what makes retiring one free the program-identity
 * for a corrected copy — and a source collision is the discovery that this exact program already
 * exists under another name. The NAME collides with nothing: `input.name` is a hint the row's name
 * is minted from, so two callers reaching for the same words get two names rather than a refusal,
 * and `idx_script_name` is unconditional because a name means one row whether or not that row is
 * still runnable.
 *
 * Everything else here is a rule the schema holds rather than a rule this module remembers — the
 * two indexes, an immutability trigger scoped to every column but the name, and one
 * leave-only-with-their-report trigger that turns a cascading foreign key into a refusal — so each
 * one is proved by making the write and catching the abort, with the repository's refusal checked
 * separately for the sentence it says.
 */

import { test, expect, describe } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { Refused } from "../src/db/models.ts";
import { newId, nowMs } from "../src/db/tx.ts";
import { findByName } from "../src/repo/naming.ts";
import { deleteRecipe } from "../src/repo/recipes.ts";
import {
  createScript,
  deleteScript,
  getScript,
  listScripts,
  setScriptStatus,
} from "../src/repo/scripts.ts";
import { harness, seedAssessment, seedRecipe, seedScriptRun, seedThesis } from "./helpers.ts";
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

/** Every regular file under `var/`, var-relative and sorted. */
function filesUnderVar(h: Harness, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(h.varDir, dir), { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnderVar(h, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** The same tree with YewReview's own database taken out of it — everything a script could possibly
 * have written. Saving one must leave this empty, because the program is in a row and there is
 * nowhere else for it to be. */
function filesOutsideTheDatabase(h: Harness): string[] {
  return filesUnderVar(h).filter((path) => !path.startsWith("db/"));
}

/** A published report under this recipe, so an invocation has somewhere to hang from. */
function seedReport(h: Harness, recipeId: string): string {
  const id = newId();
  h.db
    .query("INSERT INTO report (name, id, recipe_id, title, content, created_at) VALUES ('rpt-' || lower(hex(randomblob(5))), ?, ?, ?, ?, ?)")
    .run(id, recipeId, "A report", "<p id='c1'>it goes up</p>", nowMs());
  return id;
}

/** A declaration that `scriptId`, given this argument, prepared one of the series an assessment's
 * round was measured over. */
function seedPreparation(
  h: Harness,
  assessmentId: string,
  scriptId: string,
  argument = "AAPL",
): void {
  h.db
    .query(
      `INSERT INTO series_preparation (name, id, thesis_assessment_id, script_id, argument, created_at)
       VALUES ('prep-' || lower(hex(randomblob(5))), ?, ?, ?, ?, ?)`,
    )
    .run(newId(), assessmentId, scriptId, argument, nowMs());
}

describe("saving a script", () => {
  test("puts the program in the row and writes nothing to disk at all", () => {
    const h = harness();
    try {
      // Leading whitespace is part of a program's bytes: the column has to hold what would actually
      // run, and it is what the active-source index compares one script against another by.
      const source = "  import polars as pl\n\nprint(1)\n";
      // Two arguments, and neither is a Settings: there is no var/ to hand this function, because
      // there is no file for it to write.
      expect(createScript.length).toBe(2);
      const script = createScript(h.db, {
        name: "  daily prices  ",
        domain: " OHLCV for the semis basket ",
        source,
      });
      // The name is MINTED from those words rather than taken as them: a condensed summary, filed
      // as a slug, and the user's to reword afterwards. The domain is the caller's own prose and is
      // only trimmed.
      expect(script.name).toBe("daily-prices");
      expect(script.domain).toBe("OHLCV for the semis basket");
      expect(script.source).toBe(source);
      expect(
        h.db
          .query<{ source: string }, [string]>("SELECT source FROM script WHERE id = ?")
          .get(script.id)?.source,
      ).toBe(source);

      // No path, no digest: there is no second copy for the row to disagree with.
      expect(Object.keys(script).sort()).toEqual([
        "created_at",
        "domain",
        "id",
        "name",
        "source",
        "status",
        "updated_at",
      ]);
      expect(getScript(h.db, script.id)).toEqual(script);

      // The headline. Nothing under var/ but YewReview's own database — no scripts/ tree, no
      // canonical copy, nothing for a later reader to find and have to reconcile against the row.
      expect(filesOutsideTheDatabase(h)).toEqual([]);
      expect(existsSync(resolve(h.varDir, "scripts"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("the same words are two names; the same program is one script", () => {
    const h = harness();
    try {
      const first = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      expect(first.name).toBe("prices");

      // A name hint is not a claim on a name. Two callers reaching for the same words are two
      // people summarising two different programs the same way, which is an ordinary thing rather
      // than a mistake — so the second one is minted with a suffix and both rows stand.
      const second = createScript(h.db, { name: "PRICES", domain: "ohlcv", source: "print(2)" });
      expect(second.name).toMatch(/^prices-[a-z0-9]{4}$/);
      expect(second.id).not.toBe(first.id);

      // The PROGRAM is the one thing that still collides, and the sentence names the twin, because
      // the way out is to run that script rather than to rename this one.
      const byProgram = refusal(() =>
        createScript(h.db, { name: "quotes", domain: "ohlcv", source: "print(1)" }),
      );
      expect(byProgram.kind).toBe("conflict");
      expect(byProgram.message).toContain("already IS this exact program");
      expect(byProgram.message).toContain(first.name);

      expect(listScripts(h.db)).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  test("two recipes fetching the same prices independently is one script, not two", () => {
    const h = harness();
    try {
      // Scripts belong to the installation, not to a conversation. Two recipes keeping their own
      // copy of one price fetcher is duplication wearing the costume of independence — so the
      // second recording is refused and points at the twin, which may well have been written in a
      // conversation this reader cannot see.
      seedRecipe(h.db, "A");
      seedRecipe(h.db, "B");
      const first = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });

      const twin = refusal(() =>
        createScript(h.db, { name: "prices for B", domain: "ohlcv", source: "print(1)" }),
      );
      expect(twin.kind).toBe("conflict");
      expect(twin.message).toContain("already IS this exact program");
      expect(twin.message).toContain(first.name);
      expect(twin.message).toContain("every recipe");

      // A namesake is NOT that. B's own fetcher, summarised in the same words as A's, is a second
      // program and gets a name of its own — sharing an installation means sharing programs, not
      // rationing the words people describe them with.
      const namesake = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(2)" });
      expect(namesake.name).not.toBe(first.name);
      expect(listScripts(h.db)).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  test("refuses a blank source, a blank name and a blank domain", () => {
    const h = harness();
    try {
      expect(
        refusal(() => createScript(h.db, { name: "x", domain: "y", source: "  \n" })).kind,
      ).toBe("invalid_request");
      expect(refusal(() => createScript(h.db, { name: " ", domain: "y", source: "1" })).kind).toBe(
        "invalid_request",
      );
      expect(refusal(() => createScript(h.db, { name: "x", domain: " ", source: "1" })).kind).toBe(
        "invalid_request",
      );
      expect(listScripts(h.db)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe("one active program, held by the database", () => {
  test("the program's index is partial and the name's is not, and both are read back", () => {
    const h = harness();
    try {
      const first = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });

      // Two indexes doing two different jobs, and which of them is PARTIAL is the whole design — so
      // the definitions are read back rather than assumed.
      const indexes = h.db
        .query<{ name: string; sql: string }, []>(
          `SELECT name, sql FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'script' AND sql IS NOT NULL
            ORDER BY name`,
        )
        .all();
      expect(indexes.map((index) => index.name)).toEqual([
        "idx_script_active_source",
        "idx_script_name",
      ]);
      // The program's is scoped to the scripts still in service, which is why retiring one frees a
      // program-identity for its replacement. The name's is unconditional, because a name means one
      // row whether or not that row is still runnable — a stronger rule and one nobody has to
      // reason about a status to apply.
      expect(indexes[0]!.sql).toContain("WHERE status = 'active'");
      expect(indexes[1]!.sql).not.toContain("WHERE");

      const insert = (name: string, source: string) =>
        h.db
          .query(
            `INSERT INTO script (name, id, domain, source, status, created_at, updated_at)
             VALUES (?, ?, 'ohlcv', ?, 'active', 0, 0)`,
          )
          .run(name, newId(), source);

      // The repository pre-checks so the refusal can say what happened; these are the guarantee,
      // reached straight past it.
      expect(() => insert("quotes", first.source)).toThrow(
        /UNIQUE constraint failed: script\.source/,
      );
      expect(() => insert("prices", "print(2)")).toThrow(/UNIQUE constraint failed: script\.name/);
      expect(listScripts(h.db)).toHaveLength(1);

      // Retiring one frees the program and NOT the name: the twin lands, the namesake still cannot.
      setScriptStatus(h.db, first.id, "inactive");
      insert("quotes", first.source);
      expect(() => insert("prices", "print(3)")).toThrow(/UNIQUE constraint failed: script\.name/);
      expect(listScripts(h.db)).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });
});

describe("a saved script is immutable, and only its status moves", () => {
  test("its program and its identity cannot be updated; the trigger is the rule", () => {
    const h = harness();
    try {
      const script = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      // Every column but the name, which is what `BEFORE UPDATE OF` spells out: a rename mentions
      // none of these, so it never wakes the trigger, and that the rename then LANDS is pinned in
      // the sweep at the foot of naming.test.ts rather than restated here.
      for (const [column, value] of [
        ["id", "'somebody else'"],
        ["domain", "'something else'"],
        ["source", "'print(2)'"],
        ["created_at", "0"],
      ] as const) {
        expect(() =>
          h.db.query(`UPDATE script SET ${column} = ${value} WHERE id = ?`).run(script.id),
        ).toThrow(/immutable/);
      }
      expect(getScript(h.db, script.id)).toEqual(script);
    } finally {
      h.cleanup();
    }
  });

  test("the status and the moment it moved are the one write a stored script has", () => {
    const h = harness();
    try {
      const script = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      // The trigger is column-scoped on purpose: these two are outside its list, so the write lands.
      h.db.query("UPDATE script SET status = 'inactive', updated_at = 5 WHERE id = ?").run(script.id);
      expect(getScript(h.db, script.id)).toMatchObject({
        status: "inactive",
        updated_at: 5,
        source: "print(1)",
      });
    } finally {
      h.cleanup();
    }
  });

  test("a script is born active, and is not born inactive", () => {
    const h = harness();
    try {
      const script = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      expect(script.status).toBe("active");
      expect(() =>
        h.db
          .query(
            `INSERT INTO script (name, id, domain, source, status, created_at, updated_at)
             VALUES ('other', 'x', 'd', 'print(2)', 'inactive', 0, 0)`,
          )
          .run(),
      ).toThrow(/not born inactive/);
    } finally {
      h.cleanup();
    }
  });

  test("setScriptStatus moves the status and the moment, and refuses a status that is not one", () => {
    const h = harness();
    try {
      const script = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      const retired = setScriptStatus(h.db, script.id, "inactive");
      expect(retired.status).toBe("inactive");
      expect(retired.source).toBe(script.source);
      expect(retired.updated_at).toBeGreaterThanOrEqual(script.updated_at);

      // Re-stating a status would move updated_at, which means "when its standing last changed".
      expect(refusal(() => setScriptStatus(h.db, script.id, "inactive")).kind).toBe("conflict");
      expect(refusal(() => setScriptStatus(h.db, script.id, "retired" as never)).kind).toBe(
        "invalid_request",
      );
      expect(refusal(() => setScriptStatus(h.db, "nope", "inactive")).kind).toBe("not_found");
    } finally {
      h.cleanup();
    }
  });

  test("retiring one keeps every record that names it: its program still explains those numbers", () => {
    const h = harness();
    try {
      const script = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      const reportId = seedReport(h, seedRecipe(h.db));
      seedScriptRun(h.db, reportId, script.id);
      const assessmentId = seedAssessment(h.db, seedThesis(h.db));
      seedPreparation(h, assessmentId, script.id);

      setScriptStatus(h.db, script.id, "inactive");

      // This is the whole difference between retiring a script and deleting one. A report's
      // numbers came out of that program and an assessment's round was read over series that
      // program prepared; retiring it says "do not run this again", which is a statement about the
      // future and has no business editing either account of the past.
      expect(
        h.db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM script_invocation WHERE script_id = ?",
          )
          .get(script.id)?.n,
      ).toBe(1);
      expect(
        h.db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM series_preparation WHERE script_id = ?",
          )
          .get(script.id)?.n,
      ).toBe(1);
      // And the retired script's program is still right there in the row both of them point at.
      expect(getScript(h.db, script.id)?.source).toBe("print(1)");
    } finally {
      h.cleanup();
    }
  });
});

describe("retiring one frees the program for the replacement, and never the name", () => {
  test("the retired program can be stored again; its name stays where it is", () => {
    const h = harness();
    try {
      const first = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      setScriptStatus(h.db, first.id, "inactive");

      // The exact program is free again: the source index is scoped to the active rows, so a
      // corrected copy of a retired fetcher is storable and the archive keeps the original.
      const twin = createScript(h.db, { name: "prices again", domain: "ohlcv", source: "print(1)" });
      expect(twin.source).toBe(first.source);
      expect(twin.id).not.toBe(first.id);
      expect(listScripts(h.db, { status: "active" }).map((s) => s.id)).toEqual([twin.id]);

      // The NAME is not part of what retiring releases, and does not need to be: it is unique
      // across the active and the inactive alike, which is a stronger rule than the one scoped to
      // service, and the replacement's own hint mints a name of its own either way.
      const replacement = createScript(h.db, {
        name: "prices",
        domain: "ohlcv",
        source: "print(2)",
      });
      expect(replacement.name).not.toBe("prices");
      expect(findByName(h.db, "script", "prices")).toBe(first.id);
      expect(listScripts(h.db)).toHaveLength(3);
    } finally {
      h.cleanup();
    }
  });

  test("re-activating collides on the program, which is the only way it can", () => {
    const h = harness();
    try {
      const first = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      setScriptStatus(h.db, first.id, "inactive");
      createScript(h.db, { name: "quotes", domain: "ohlcv", source: "print(1)" });

      const err = refusal(() => setScriptStatus(h.db, first.id, "active"));
      expect(err.kind).toBe("conflict");
      expect(err.message).toContain("already IS this exact program");
      expect(getScript(h.db, first.id)?.status).toBe("inactive");

      expect(() =>
        h.db.query("UPDATE script SET status = 'active' WHERE id = ?").run(first.id),
      ).toThrow(/UNIQUE constraint failed: script\.source/);
    } finally {
      h.cleanup();
    }
  });

  test("re-activating is fine when nothing took the program", () => {
    const h = harness();
    try {
      const script = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      setScriptStatus(h.db, script.id, "inactive");
      expect(setScriptStatus(h.db, script.id, "active").status).toBe("active");
    } finally {
      h.cleanup();
    }
  });
});

describe("deleting a script", () => {
  test("is one row and a bare boolean, with nothing left over for the caller to do", () => {
    const h = harness();
    try {
      const script = createScript(h.db, {
        name: "filings",
        domain: "IR documents",
        source: "fetch()",
      });

      // The answer is `true`, not a list of paths to unlink. There is no disk work to hand back:
      // the program was the only thing a script ever put anywhere, it is a column, and it leaves
      // with the row inside the transaction. Nothing this database knows the name of survives the
      // commit, so no crash has a gap to strand anything in.
      expect(deleteScript(h.db, script.id)).toBe(true);
      expect(getScript(h.db, script.id)).toBeNull();
      expect(listScripts(h.db)).toEqual([]);
      expect(filesOutsideTheDatabase(h)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("deleting the recipe it was written for takes no script with it", () => {
    const h = harness();
    try {
      const recipeId = seedRecipe(h.db);
      const script = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      seedScriptRun(h.db, seedReport(h, recipeId), script.id);

      // A script belongs to the installation, not to the conversation that happened to record it —
      // the fetcher three other recipes run was never this one's to take away. What does leave
      // is the report and the log of what it ran, because that record was only ever about that
      // report.
      expect(deleteRecipe(h.db, recipeId)).toBe(true);
      expect(getScript(h.db, script.id)?.source).toBe("print(1)");
      expect(
        h.db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM script_invocation WHERE script_id = ?",
          )
          .get(script.id)?.n,
      ).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("deleting one that is already gone is not an error", () => {
    const h = harness();
    try {
      expect(deleteScript(h.db, "nope")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("a script a published report records running may not be deleted, whatever its status", () => {
    const h = harness();
    try {
      const recipeId = seedRecipe(h.db);
      const script = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      const reportId = seedReport(h, recipeId);
      seedScriptRun(h.db, reportId, script.id);

      const err = refusal(() => deleteScript(h.db, script.id));
      expect(err.kind).toBe("conflict");
      expect(err.message).toContain("1 published report(s)");
      expect(err.message).toContain("set the script inactive instead");
      expect(getScript(h.db, script.id)).not.toBeNull();

      // Retiring it is the way out that does not need the report deleted first — and it does not
      // unblock the deletion, because the report's numbers still came out of that program.
      expect(setScriptStatus(h.db, script.id, "inactive").status).toBe("inactive");
      expect(refusal(() => deleteScript(h.db, script.id)).kind).toBe("conflict");

      // The pre-check exists for the message; this is the guarantee, and it is worth reaching for
      // by hand because the way it holds is not the obvious one. `script_invocation.script_id`
      // CASCADES, so the delete does not bounce off a foreign key — it goes through, and the
      // cascade's own DELETE then wakes `script_invocations_leave_only_with_their_report`, whose
      // WHEN finds the report still standing and aborts the lot. A cascade arranged so that it
      // cannot fire is a strange-looking thing to read in the schema, so it is pinned here.
      expect(() => h.db.query("DELETE FROM script WHERE id = ?").run(script.id)).toThrow(
        /it is deleted only with its report/,
      );
      expect(getScript(h.db, script.id)).not.toBeNull();

      // Deleting the report frees it: the invocation goes with its report, this time with nothing
      // for the trigger's WHEN to find, and the count the repository reads falls to zero.
      h.db.query("DELETE FROM report WHERE id = ?").run(reportId);
      expect(deleteScript(h.db, script.id)).toBe(true);
      expect(getScript(h.db, script.id)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("a script an assessment says prepared its inputs may not be deleted either", () => {
    const h = harness();
    try {
      const script = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      const assessmentId = seedAssessment(h.db, seedThesis(h.db));
      seedPreparation(h, assessmentId, script.id, "AAPL");

      const err = refusal(() => deleteScript(h.db, script.id));
      expect(err.kind).toBe("conflict");
      expect(err.message).toContain("1 recorded preparation(s)");
      expect(err.message).toContain("Set the script inactive instead");
      expect(getScript(h.db, script.id)).not.toBeNull();

      // And here the pre-check is the ONLY thing holding the line, which is why it is not
      // belt-and-braces. `series_preparation.script_id` cascades like the invocation's does, but
      // there is no leave-only trigger behind it to notice: the rows would simply go. The loss
      // would not even land on the script — it lands on the ASSESSMENT, which stays exactly where
      // it was, still claiming a measurement, now with nothing left to say what produced the
      // series it was read over. A round's record quietly shrinking because somebody tidied up a
      // script is precisely the sort of edit the ledger exists to make impossible, and the
      // database has nothing to object with, so the repository does.
      //
      // Proving that means letting it happen once, past the repository, at the end of the test.
      h.db.query("DELETE FROM script WHERE id = ?").run(script.id);
      expect(
        h.db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM series_preparation WHERE thesis_assessment_id = ?",
          )
          .get(assessmentId)?.n,
      ).toBe(0);
      expect(
        h.db
          .query<{ id: string }, [string]>("SELECT id FROM thesis_assessment WHERE id = ?")
          .get(assessmentId),
      ).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("both counts are read, so the refusal names whichever record is actually standing", () => {
    const h = harness();
    try {
      // A script that fetched for two reports and prepared inputs for two rounds. The invocation
      // count is DISTINCT over reports, because the question is how many documents are in the way
      // rather than how many times the program ran; the preparation count is not, because each row
      // is a separate declaration some assessment made and each one would be lost on its own.
      const recipeId = seedRecipe(h.db);
      const script = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      const first = seedReport(h, recipeId);
      seedScriptRun(h.db, first, script.id, "--full");
      seedScriptRun(h.db, first, script.id, "--incremental");
      const second = seedReport(h, recipeId);
      seedScriptRun(h.db, second, script.id);
      expect(refusal(() => deleteScript(h.db, script.id)).message).toContain(
        "2 published report(s)",
      );

      // With the reports gone the invocation count falls silent and the preparations answer next —
      // the two refusals are separate rules about separate records, not one rule read twice.
      h.db.query("DELETE FROM report WHERE id IN (?, ?)").run(first, second);
      const assessmentId = seedAssessment(h.db, seedThesis(h.db));
      seedPreparation(h, assessmentId, script.id, "AAPL");
      seedPreparation(h, assessmentId, script.id, "MSFT");
      expect(refusal(() => deleteScript(h.db, script.id)).message).toContain(
        "2 recorded preparation(s)",
      );
    } finally {
      h.cleanup();
    }
  });
});

test("listScripts narrows by a substring that may contain a wildcard", () => {
  const h = harness();
  try {
    createScript(h.db, { name: "prices", domain: "ohlcv daily", source: "print(1)" });
    createScript(h.db, { name: "revenue", domain: "monthly 100% coverage", source: "print(2)" });
    expect(listScripts(h.db, { query: "ohlcv" }).map((s) => s.name)).toEqual(["prices"]);
    expect(listScripts(h.db, { query: "100%" }).map((s) => s.name)).toEqual(["revenue"]);
    // A LIKE wildcard the caller typed is a character they typed, not a search they asked for.
    expect(listScripts(h.db, { query: "%" }).map((s) => s.name)).toEqual(["revenue"]);
    expect(listScripts(h.db).map((s) => s.name)).toEqual(["prices", "revenue"]);
  } finally {
    h.cleanup();
  }
});
