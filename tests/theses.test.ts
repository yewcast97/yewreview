/**
 * Theses, their regime and their assessment ledger, against a real database — nothing here is
 * faked, because what is being pinned is mostly the schema's own: the immutability triggers over
 * the three tables, the terminus trigger on the ledger, one unique index, and a cascade that has to
 * reach a ledger without ever letting a row out of one.
 *
 * A THESIS IS A CONTAINER AND JUDGEMENT IS A LEDGER. The statement, the document and the identity
 * are fixed at creation; what the thesis is currently worth is the newest row of another table,
 * derived on every read. `abandoned` is the last row a ledger can take, and this file pins both
 * halves of that: the repository's sentence, and the trigger that would refuse a revival reaching
 * the database another way.
 *
 * WHAT A NAME IS HERE, AND WHAT IT IS NOT. `draft.name` is a HINT the row's name is minted from,
 * unique within `thesis` and claiming nothing wider — so a create NEVER conflicts on a name, two
 * live theses may be summarised in exactly the same words, and abandoning one releases nothing
 * because nothing was being held. That is the inversion of what this file used to say: liveness
 * lives in the ledger, and no rule reads it to decide what a row may be called.
 */

import { test, expect, describe } from "bun:test";
import type { Database } from "bun:sqlite";

import { Refused } from "../src/db/models.ts";
import type { Thesis } from "../src/db/models.ts";
import { newId, nowMs } from "../src/db/tx.ts";
import { findByName } from "../src/repo/naming.ts";
import { createScript } from "../src/repo/scripts.ts";
import { getTarget, listTargets, upsertTarget } from "../src/repo/targets.ts";
import {
  assessThesis,
  createAssessedThesis,
  createThesis,
  deleteThesis,
  getAssessment,
  getThesis,
  latestAssessment,
  listAssessments,
  listPreparations,
  listTheses,
  searchTheses,
} from "../src/repo/theses.ts";
import type { AssessmentDraft, ThesisDraft } from "../src/repo/theses.ts";
import { harness, seedAssessment, seedRecipe, seedThesis } from "./helpers.ts";

function refusal(fn: () => unknown): Refused {
  try {
    fn();
  } catch (err) {
    if (err instanceof Refused) return err;
    throw err;
  }
  throw new Error("expected a Refused, got a result");
}

function count(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

/** Every table holding a foreign key into `table`, read off the live database rather than off a
 * list somebody remembered to keep up to date. */
function referrersOf(db: Database, table: string): string[] {
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  const out: string[] = [];
  for (const { name } of names) {
    const keys = db.query<{ table: string }, []>(`PRAGMA foreign_key_list(${name})`).all();
    if (keys.some((key) => key.table === table)) out.push(name);
  }
  return out.sort();
}

/**
 * A draft whose DSL text and hash are whatever the caller says they are — which is the point: the
 * seikan CLI computes both before the repository ever sees them.
 *
 * There is no tag and no assessment here. A thesis is a container, and storing one says
 * nothing about what it is worth; that is a separate act with a row of its own.
 */
function draft(over: Partial<ThesisDraft> = {}): ThesisDraft {
  return {
    name: "NVDA compounds",
    content: "Datacenter revenue keeps beating, and the backlog says it continues.",
    dslJson: '{"version": 1, "targets": {"nvda": "nvda_close"}}',
    dslHash: "f".repeat(64),
    tickers: ["NVDA"],
    ...over,
  };
}

/**
 * The same draft, with the instruments its regime names recorded first.
 *
 * `regime.ticker` carries no ON DELETE and its foreign key demands the target row exist, and a
 * target cannot be conjured out of a symbol any more: `upsertTarget` refuses to write a row it has
 * no official name for. So every test that wants the write to SUCCEED goes through here, and the
 * ones that want a refusal call `createThesis` directly, where the refusal they are about is the
 * one they get.
 */
function store(db: Database, over: Partial<ThesisDraft> = {}): Thesis {
  const wanted = draft(over);
  for (const ticker of wanted.tickers) {
    const symbol = ticker.trim().toUpperCase();
    if (getTarget(db, symbol) === null) {
      upsertTarget(db, { ticker: symbol, name: `${symbol} Corp.` });
    }
  }
  return createThesis(db, wanted);
}

/** One round of judgement, as a caller hands it over. */
function reading(over: Partial<AssessmentDraft> = {}): AssessmentDraft {
  return {
    tag: "insightful",
    assessment: "Three of five cells fire, and the mechanism holds where they do.",
    seikanReport: '{"cells": [{"key": "beat", "fired": true}]}',
    preparations: [],
    ...over,
  };
}

/** A published report row written straight in. Its whole job below is to be STANDING while a thesis
 * is deleted out from under it, and `recordReport` would drag a generation run into a fixture that
 * reads none of it. */
function seedReport(db: Database): string {
  const id = newId();
  db.query(
    "INSERT INTO report (name, id, recipe_id, title, content, created_at) VALUES ('rpt-' || lower(hex(randomblob(5))), ?, ?, ?, ?, ?)",
  ).run(
    id,
    seedRecipe(db),
    "A report",
    "<article><p>A report.</p></article>",
    nowMs(),
  );
  return id;
}

describe("createThesis", () => {
  test("stores the document and hash verbatim and hydrates the regime", () => {
    const h = harness();
    try {
      const ugly = '{ "version":1,   "note": "spacing the author chose" }';
      const thesis = store(h.db, { dslJson: ugly, tickers: ["nvda", " amd "] });

      expect(thesis.dsl_json).toBe(ugly);
      expect(thesis.dsl_hash).toBe("f".repeat(64));
      expect(thesis.regime).toEqual(["AMD", "NVDA"]);
      // The name is minted from the hint rather than taken as it — a condensed summary, filed as a
      // slug, and the user's to reword afterwards.
      expect(thesis.name).toBe("nvda-compounds");
    } finally {
      h.cleanup();
    }
  });

  test("a regime is a set: the same ticker twice is one conjunct", () => {
    const h = harness();
    try {
      const thesis = store(h.db, { tickers: ["NVDA", "nvda", "NVDA "] });
      expect(thesis.regime).toEqual(["NVDA"]);
    } finally {
      h.cleanup();
    }
  });

  test("a regime names instruments already recorded, and will not invent one", () => {
    const h = harness();
    try {
      // The regime's foreign key demands the target row, and storing a thesis writes no target it
      // has no OFFICIAL NAME for — a target's name is a fact somebody looked up and the one name
      // here that cannot be corrected later, so it is never invented from a document's target keys.
      // Recording the instrument is a step of its own, and the refusal names which one is missing.
      const err = refusal(() => createThesis(h.db, draft()));
      expect(err.kind).toBe("not_found");
      expect(err.message).toContain("NVDA is not recorded");
      expect(err.message).toContain("official name");
      expect(listTheses(h.db)).toEqual([]);
      expect(listTargets(h.db)).toEqual([]);

      upsertTarget(h.db, { ticker: "NVDA", name: "NVIDIA Corporation" });
      expect(createThesis(h.db, draft()).regime).toEqual(["NVDA"]);
    } finally {
      h.cleanup();
    }
  });

  test("the inner half stores a container and no judgement, and an unmeasured thesis reads as one", () => {
    const h = harness();
    try {
      // `createThesis` is the INNER half now: the tool surface stores through
      // `createAssessedThesis`, so a new thesis reaches the archive with its first round under it
      // — but the container's own writer still writes no judgement, an archive may hold theses
      // stored before that rule, and the row has to say "nobody has looked" honestly rather than
      // guessing a hopeful first tag.
      const thesis = store(h.db);
      expect(thesis.latest_tag).toBeNull();
      expect(thesis.assessed_at).toBeNull();
      expect(listAssessments(h.db, thesis.id)).toEqual([]);
      expect(latestAssessment(h.db, thesis.id)).toBeNull();
      // And it is browsable AS that state, not merely absent from every tag's list.
      expect(listTheses(h.db, { tag: "unassessed" }).map((t) => t.id)).toEqual([thesis.id]);
    } finally {
      h.cleanup();
    }
  });

  test("refuses a thesis missing any of the parts that make it one", () => {
    const h = harness();
    try {
      // Four parts, not six, on the inner half: the container's writer takes neither a tag nor
      // the reasoning behind one — those ride `createAssessedThesis`, where the ledger's own
      // writer refuses their blanks.
      expect(refusal(() => createThesis(h.db, draft({ name: "  " }))).message).toContain("name");
      expect(refusal(() => createThesis(h.db, draft({ content: "" }))).message).toContain(
        "natural-language statement",
      );
      expect(refusal(() => createThesis(h.db, draft({ dslJson: "" }))).message).toContain("DSL");
      expect(refusal(() => createThesis(h.db, draft({ dslHash: "" }))).message).toContain("seikan");
      expect(listTheses(h.db)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("refuses a malformed ticker instead of filing the thesis under a guess", () => {
    const h = harness();
    try {
      expect(refusal(() => createThesis(h.db, draft({ tickers: ["NVIDIA CORP"] }))).kind).toBe(
        "invalid_request",
      );
      expect(listTargets(h.db)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("accepts a thesis whose document measures no instrument", () => {
    const h = harness();
    try {
      expect(store(h.db, { tickers: [] }).regime).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

/**
 * The combined creator: container, regime, first round and its preparations, one transaction.
 *
 * COMPOSED of the two writers above rather than a third one, which is what these tests leverage:
 * every refusal `createThesis` and `assessThesis` already make is made here too, and what is being
 * pinned is only the part composition adds — that an act any part refuses rolls back WHOLE. The
 * blank-field refusals themselves have their own tests under each half's describe.
 */
describe("createAssessedThesis", () => {
  test("stores the container and its first round in one act, and the returned row already answers", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "NVDA", name: "NVIDIA Corporation" });
      const prices = createScript(h.db, {
        name: "nvda prices",
        domain: "prices",
        source: "print('prices')\n",
      }).id;
      const { thesis, assessment } = createAssessedThesis(
        h.db,
        draft(),
        reading({ preparations: [{ scriptId: prices, argument: "--daily" }] }),
      );
      // The re-read is part of the contract: the row handed back carries the first round's answer,
      // so no caller draws "unassessed" for a thesis that was born measured.
      expect(thesis.latest_tag).toBe("insightful");
      expect(thesis.assessed_at).toBe(assessment.created_at);
      expect(listAssessments(h.db, thesis.id).map((row) => row.id)).toEqual([assessment.id]);
      expect(listPreparations(h.db, assessment.id).map((p) => [p.script_id, p.argument])).toEqual([
        [prices, "--daily"],
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("an unknown script in the first round's preparations takes the whole act down", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "NVDA", name: "NVIDIA Corporation" });
      expect(
        refusal(() =>
          createAssessedThesis(
            h.db,
            draft(),
            reading({ preparations: [{ scriptId: "no-such-script", argument: "" }] }),
          ),
        ).kind,
      ).toBe("not_found");
      // The pattern `assessThesis` already pins, one table further: the container rolls back with
      // the round, because a thesis standing without its first reading on record is exactly the
      // state the one-transaction rule exists to make impossible.
      for (const table of ["thesis", "regime", "thesis_assessment", "series_preparation"]) {
        expect(count(h.db, table)).toBe(0);
      }
    } finally {
      h.cleanup();
    }
  });

  test("an unrecorded ticker takes the whole act down, first round included", () => {
    const h = harness();
    try {
      // No target recorded, so the regime write refuses — and the refusal happens AFTER the
      // container's insert in program order, which is what makes the rollback the assertion.
      expect(refusal(() => createAssessedThesis(h.db, draft(), reading())).kind).toBe("not_found");
      for (const table of ["thesis", "regime", "thesis_assessment", "series_preparation"]) {
        expect(count(h.db, table)).toBe(0);
      }
    } finally {
      h.cleanup();
    }
  });

  test("a blank first reading refuses with no container stored", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "NVDA", name: "NVIDIA Corporation" });
      expect(
        refusal(() => createAssessedThesis(h.db, draft(), reading({ assessment: "   " }))).message,
      ).toContain("the only record of why");
      expect(count(h.db, "thesis")).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("the first round is named after the thesis's MINTED name, collision suffix included", () => {
    const h = harness();
    try {
      // Two theses from one hint: the second's name carries a suffix, and its first round has to
      // be named after the name actually recorded — the assessment's insert reads the thesis row
      // this same open transaction just wrote, which is the ordering being pinned.
      const first = store(h.db);
      const { thesis, assessment } = createAssessedThesis(h.db, draft(), reading());
      expect(thesis.name).not.toBe(first.name);
      // Minted from "<minted thesis name> <tag>" and then slugified, so the suffixed thesis name
      // leads and the tag follows it.
      expect(assessment.name.startsWith(thesis.name)).toBe(true);
      expect(assessment.name).toContain("insightful");
    } finally {
      h.cleanup();
    }
  });

  test("a first round tagged abandoned stores, and closes the ledger at birth", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "NVDA", name: "NVIDIA Corporation" });
      const { thesis } = createAssessedThesis(h.db, draft(), reading({ tag: "abandoned" }));
      expect(thesis.latest_tag).toBe("abandoned");
      // Terminal from the first row exactly as from any later one: the trigger reads an empty
      // ledger on the way in and holds ever after.
      expect(refusal(() => assessThesis(h.db, thesis.id, reading())).kind).toBe("conflict");
    } finally {
      h.cleanup();
    }
  });
});

describe("a stored thesis is immutable but for its name", () => {
  test("every column that carries meaning refuses an UPDATE, because none is a judgement", () => {
    const h = harness();
    try {
      const thesis = store(h.db);
      // The trigger is written `BEFORE UPDATE OF` every column but the name, and with judgement
      // living in a ledger in another table there is nothing else to carve out: a thesis has no
      // mutable part left. A rename mentions none of these, so it never wakes the trigger — that it
      // then LANDS is pinned in the sweep at the foot of naming.test.ts.
      for (const [column, value] of [
        ["id", "'x'"],
        ["content", "'x'"],
        ["dsl_json", "'x'"],
        ["dsl_hash", "'x'"],
        ["created_at", "0"],
      ] as const) {
        expect(() =>
          h.db.query(`UPDATE thesis SET ${column} = ${value} WHERE id = ?`).run(thesis.id),
        ).toThrow(/immutable/);
      }
      expect(getThesis(h.db, thesis.id)).toEqual(thesis);
    } finally {
      h.cleanup();
    }
  });

  test("the regime is written once and never replaced, because the document never moves", () => {
    const h = harness();
    try {
      const thesis = store(h.db, { tickers: ["NVDA", "AMD"] });
      assessThesis(
        h.db,
        thesis.id,
        reading({ tag: "abandoned", assessment: "The document measured the benchmark." }),
      );
      expect(getThesis(h.db, thesis.id)?.regime).toEqual(["AMD", "NVDA"]);
    } finally {
      h.cleanup();
    }
  });
});

describe("assessThesis files one round of judgement", () => {
  test("writes the reading, its reasoning, the engine's report and what prepared the inputs", () => {
    const h = harness();
    try {
      const prices = createScript(h.db, {
        name: "nvda prices",
        domain: "prices",
        source: "print('prices')\n",
      }).id;
      const filings = createScript(h.db, {
        name: "nvda filings",
        domain: "filings",
        source: "print('filings')\n",
      }).id;
      const thesis = store(h.db);

      const filed = assessThesis(
        h.db,
        thesis.id,
        reading({
          preparations: [
            // What produced the series, not where the series landed: a path is an argument to a
            // run, and no column in this database names a file.
            { scriptId: prices, argument: "--ticker NVDA --since 2019" },
            { scriptId: filings, argument: "" },
          ],
        }),
      );

      expect(filed.thesis_id).toBe(thesis.id);
      expect(filed.tag).toBe("insightful");
      expect(filed.seikan_report).toContain('"fired": true');
      expect(getAssessment(h.db, filed.id)).toEqual(filed);
      expect(latestAssessment(h.db, thesis.id)).toEqual(filed);

      const prepared = listPreparations(h.db, filed.id);
      expect(prepared.map((p) => [p.script_id, p.argument])).toEqual([
        [prices, "--ticker NVDA --since 2019"],
        // '' is an answer — a program run with no arguments — not a missing value.
        [filings, ""],
      ]);
      // One moment for the whole round: the reading and the declarations of what it was read off
      // were one act, and two clocks would be two accounts of when it happened.
      expect(prepared.every((p) => p.created_at === filed.created_at)).toBe(true);

      // The container did not move; the ledger grew, and the derived answer follows it.
      const after = getThesis(h.db, thesis.id)!;
      expect(after.latest_tag).toBe("insightful");
      expect(after.assessed_at).toBe(filed.created_at);
      expect(after.dsl_json).toBe(thesis.dsl_json);
      expect(after.created_at).toBe(thesis.created_at);
    } finally {
      h.cleanup();
    }
  });

  test("a re-reading adds a row; what was thought in March is still there in June", () => {
    const h = harness();
    try {
      const thesis = store(h.db);
      const march = assessThesis(
        h.db,
        thesis.id,
        reading({ tag: "approven", assessment: "Held across four quarters, every cell clean." }),
      );
      const june = assessThesis(
        h.db,
        thesis.id,
        reading({
          tag: "insightful",
          assessment: "Broke in Q4; the mechanism still explains the other three.",
        }),
      );

      // Oldest first, because that is the order it was written in and the order it reads as a
      // history. Nothing was overwritten — the March reading is still exactly what it said.
      const ledger = listAssessments(h.db, thesis.id);
      expect(ledger.map((a) => a.id)).toEqual([march.id, june.id]);
      expect(ledger[0]!.assessment).toBe("Held across four quarters, every cell clean.");

      // What the thesis is currently worth is the newest row, derived on every read.
      expect(latestAssessment(h.db, thesis.id)?.id).toBe(june.id);
      expect(getThesis(h.db, thesis.id)?.latest_tag).toBe("insightful");
    } finally {
      h.cleanup();
    }
  });

  test("refuses a reading with no reasoning, or with no measurement under it", () => {
    const h = harness();
    try {
      const thesis = store(h.db);
      // Both columns are NOT NULL in the schema, which can insist they are there and not that they
      // say anything — so these two checks are the only thing standing between the ledger and a
      // verdict nobody can weigh later.
      expect(refusal(() => assessThesis(h.db, thesis.id, reading({ assessment: "  " }))).message)
        .toContain("the only record of why");
      expect(
        refusal(() => assessThesis(h.db, thesis.id, reading({ seikanReport: "\n" }))).message,
      ).toContain("nobody can check the reading later");
      expect(listAssessments(h.db, thesis.id)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("refuses an unknown tag and an unknown thesis", () => {
    const h = harness();
    try {
      const thesis = store(h.db);
      expect(
        refusal(() => assessThesis(h.db, thesis.id, reading({ tag: "promising" as never }))).kind,
      ).toBe("invalid_request");
      expect(refusal(() => assessThesis(h.db, "nope", reading())).kind).toBe("not_found");
    } finally {
      h.cleanup();
    }
  });

  test("an unknown script in the preparations takes the whole round down with it", () => {
    const h = harness();
    try {
      const good = createScript(h.db, {
        name: "nvda prices",
        domain: "prices",
        source: "print('prices')\n",
      }).id;
      const thesis = store(h.db);

      const err = refusal(() =>
        assessThesis(
          h.db,
          thesis.id,
          reading({
            preparations: [
              { scriptId: good, argument: "--ticker NVDA" },
              { scriptId: "no-such-script", argument: "" },
            ],
          }),
        ),
      );
      expect(err.kind).toBe("not_found");
      expect(err.message).toContain("no script no-such-script");

      // The assessment row and the first preparation were already inserted when the second one was
      // refused, so zero of both is what proves the round unwound rather than never started. A
      // reading that landed without the evidence it was read off is exactly the shape these two
      // tables exist to make impossible.
      expect(listAssessments(h.db, thesis.id)).toEqual([]);
      expect(count(h.db, "series_preparation")).toBe(0);
      expect(getThesis(h.db, thesis.id)?.latest_tag).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("a filed assessment is never edited, and neither is what prepared it", () => {
    const h = harness();
    try {
      const scriptId = createScript(h.db, {
        name: "nvda prices",
        domain: "prices",
        source: "print('prices')\n",
      }).id;
      const thesis = store(h.db);
      const filed = assessThesis(
        h.db,
        thesis.id,
        reading({ preparations: [{ scriptId, argument: "--ticker NVDA" }] }),
      );

      // A judgement was made at a moment and against a measurement. Editing one in place would
      // rewrite what was thought then, which is the one thing a ledger exists to keep — so the next
      // reading is a new row and both stay readable.
      // Each column is given a value of its OWN type. A TEXT literal in `created_at` would be
      // refused by STRICT before the trigger ever ran, which would pass this assertion for the
      // wrong reason and stop proving anything the day the trigger was dropped.
      for (const [column, value] of [
        ["tag", "'abandoned'"],
        ["assessment", "'x'"],
        ["seikan_report", "'{}'"],
        ["thesis_id", "'x'"],
        ["created_at", "1"],
      ]) {
        expect(() =>
          h.db
            .query(`UPDATE thesis_assessment SET ${column} = ${value} WHERE id = ?`)
            .run(filed.id),
        ).toThrow(/never edited/);
      }
      expect(getAssessment(h.db, filed.id)).toEqual(filed);

      expect(() =>
        h.db
          .query("UPDATE series_preparation SET argument = '--all' WHERE thesis_assessment_id = ?")
          .run(filed.id),
      ).toThrow(/immutable/);
      expect(listPreparations(h.db, filed.id)[0]!.argument).toBe("--ticker NVDA");
    } finally {
      h.cleanup();
    }
  });
});

describe("abandoning a thesis", () => {
  test("releases nothing, because a name was never being held", () => {
    const h = harness();
    try {
      const first = store(h.db);
      expect(first.name).toBe("nvda-compounds");
      assessThesis(
        h.db,
        first.id,
        reading({ tag: "abandoned", assessment: "The DSL measured the benchmark by mistake." }),
      );

      // THE INVERSION. A name used to be unique among the LIVE theses, so abandoning one handed its
      // name to the replacement and the archived row quietly stopped answering to it. It is now
      // unique across the abandoned and the standing alike — a stronger rule, and one nobody has to
      // reason about a ledger to apply — so the replacement takes a name of its own and the
      // retired thesis keeps the one it was written under.
      const replacement = store(h.db, { dslHash: "a".repeat(64) });
      expect(replacement.name).not.toBe(first.name);
      expect(replacement.name).toMatch(/^nvda-compounds-[a-z0-9]{4}$/);
      expect(findByName(h.db, "thesis", "nvda-compounds")).toBe(first.id);
      expect(listTheses(h.db)).toHaveLength(2);

      // And the archived one keeps its document, its regime and every word of its ledger.
      expect(getThesis(h.db, first.id)?.regime).toEqual(["NVDA"]);
      expect(listAssessments(h.db, first.id)).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  test("two live theses may be summarised in the same words, and a create never conflicts", () => {
    const h = harness();
    try {
      const first = store(h.db);
      // A hint is not a claim on a name. Two theses about one idea is an ordinary thing to store —
      // the first may still be standing, and which of them is live is the LEDGER's answer rather
      // than a naming rule's, so nothing here is in the second one's way.
      const second = store(h.db, { tickers: ["AMD"], dslHash: "b".repeat(64) });
      expect(second.name).not.toBe(first.name);
      expect(listTheses(h.db)).toHaveLength(2);
      expect(listTheses(h.db, { tag: "unassessed" })).toHaveLength(2);

      // Judging the first does not change that in either direction: nothing about a create reads
      // the ledger, so a third lands whatever the other two currently read as.
      assessThesis(h.db, first.id, reading({ tag: "approven", assessment: "Held four quarters." }));
      const third = store(h.db, { dslHash: "c".repeat(64) });
      expect(new Set([first.name, second.name, third.name]).size).toBe(3);

      // THE PIN IS ON AN ABSENCE: the trigger that made a live name unique is gone, rather than
      // sitting quiet, so nothing can wake one. A rule about which rows are STANDING could never be
      // an index — liveness is a fact about the newest row of another table — and the rule it was
      // enforcing is not one this schema keeps any more.
      const triggers = h.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'thesis'",
        )
        .all();
      expect(triggers.map((row) => row.name)).toEqual(["thesis_is_immutable"]);
    } finally {
      h.cleanup();
    }
  });

  test("nothing is filed after an abandonment — not even a second abandonment", () => {
    const h = harness();
    try {
      const thesis = store(h.db);
      assessThesis(
        h.db,
        thesis.id,
        reading({ tag: "abandoned", assessment: "Set aside pending better data on the backlog." }),
      );

      // Reviving is refused for the reason it always was: rows filed either side of an abandonment
      // would put the runs recorded before it and the runs recorded after under one identity, as if
      // nothing had ended.
      const revive = refusal(() =>
        assessThesis(
          h.db,
          thesis.id,
          reading({ tag: "insightful", assessment: "On reflection the original was fine." }),
        ),
      );
      expect(revive.kind).toBe("conflict");
      expect(revive.message).toMatch(/never revived or re-judged/);

      // And a SECOND abandonment is refused as well, tempting though it is to let a later reading
      // improve the last word. In a ledger the last row IS the answer, so appending to a closed one
      // is the revival the rule forbids however the new row is tagged — and the correction has
      // somewhere to go already, because the replacement is a new thesis and nothing about storing
      // one is in this row's way.
      const reworded = refusal(() =>
        assessThesis(
          h.db,
          thesis.id,
          reading({
            tag: "abandoned",
            assessment: "Clearer: the backlog series was the wrong column entirely.",
          }),
        ),
      );
      expect(reworded.kind).toBe("conflict");
      expect(reworded.message).toMatch(/never revived or re-judged/);

      expect(listAssessments(h.db, thesis.id)).toHaveLength(1);
      expect(getThesis(h.db, thesis.id)?.latest_tag).toBe("abandoned");
      // The abandoned thesis is still exactly what a reader addresses by that name: the row is
      // filed, not hidden, and its name went nowhere.
      expect(findByName(h.db, "thesis", thesis.name)).toBe(thesis.id);
    } finally {
      h.cleanup();
    }
  });

  test("the pre-check is for the message; the trigger is the rule, and it refuses both", () => {
    const h = harness();
    try {
      const thesis = seedThesis(h.db, "Emptied out");
      seedAssessment(h.db, thesis, "abandoned");

      // Straight past the repository, the way a future writer of some other path would go. The
      // terminus is a trigger of its own and has to be: nothing else in the schema knows what the
      // newest row of a ledger says, so without it a revival would simply be an INSERT.
      for (const tag of ["approven", "abandoned"]) {
        expect(() =>
          h.db
            .query(
              `INSERT INTO thesis_assessment
                 (name, id, thesis_id, tag, assessment, seikan_report, created_at)
               VALUES ('asm-' || lower(hex(randomblob(5))), ?, ?, ?, 'why', '{"cells": []}', ?)`,
            )
            .run(newId(), thesis, tag, nowMs()),
        ).toThrow(/never revived/);
      }
      expect(count(h.db, "thesis_assessment")).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("a name is unique whatever the ledger says, and the index is the whole of that", () => {
    const h = harness();
    try {
      const standing = seedThesis(h.db, "NVDA compounds");
      const insert = () =>
        h.db
          .query(
            `INSERT INTO thesis (name, id, content, dsl_json, dsl_hash, created_at)
             VALUES ('NVDA compounds', ?, 'c', '{}', ?, ?)`,
          )
          .run(newId(), "b".repeat(64), nowMs());

      // One unconditional UNIQUE index, so duplication inside the table is impossible even for SQL
      // written by hand — and it stays impossible after an abandonment, which is exactly what the
      // partial rule it replaced could not offer. The column is COLLATE NOCASE, so this is one name
      // rather than two spellings of one.
      expect(insert).toThrow(/UNIQUE constraint failed: thesis\.name/);
      seedAssessment(h.db, standing, "abandoned");
      expect(insert).toThrow(/UNIQUE constraint failed: thesis\.name/);
      expect(listTheses(h.db)).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
});

describe("a ledger leaves only with its thesis", () => {
  test("no row can be dropped out of the middle, and none off the end", () => {
    const h = harness();
    try {
      const thesis = seedThesis(h.db, "NVDA compounds");
      const t = nowMs();
      const first = seedAssessment(h.db, thesis, "approven", t);
      const last = seedAssessment(h.db, thesis, "insightful", t + 1000);

      // Every rule around a thesis — which name is live, what may still be filed, how the thesis
      // currently reads — is an answer to "what is the newest row". Deleting one rewrites that
      // answer by subtraction, and taking a trailing 'abandoned' off would revive the thesis around
      // the trigger that exists to forbid exactly that.
      for (const id of [first, last]) {
        expect(() => h.db.query("DELETE FROM thesis_assessment WHERE id = ?").run(id)).toThrow(
          /deleted only with their thesis/,
        );
      }
      expect(listAssessments(h.db, thesis).map((a) => a.id)).toEqual([first, last]);
    } finally {
      h.cleanup();
    }
  });

  test("deleting the thesis takes the whole ledger, and everything hanging off it", () => {
    const h = harness();
    try {
      const scriptId = createScript(h.db, {
        name: "nvda prices",
        domain: "prices",
        source: "print('prices')\n",
      }).id;
      const thesis = store(h.db);
      assessThesis(
        h.db,
        thesis.id,
        reading({ preparations: [{ scriptId, argument: "--ticker NVDA" }] }),
      );
      assessThesis(h.db, thesis.id, reading({ tag: "approven", assessment: "Held again." }));

      // The one way a ledger legitimately leaves: with the thing it is the history of. The WHEN
      // clause on the trigger stands down during the cascade, because a foreign key action runs
      // after the parent row is already gone.
      expect(deleteThesis(h.db, thesis.id)).toBe(true);
      expect(count(h.db, "thesis_assessment")).toBe(0);
      expect(count(h.db, "series_preparation")).toBe(0);
      // The script it named outlives it: a program is global, and only the declaration was the
      // thesis's to own.
      expect(count(h.db, "script")).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});

describe("reading theses", () => {
  test("getThesis hydrates the regime and the ledger's answer, and a name resolves to its row", () => {
    const h = harness();
    try {
      const thesis = store(h.db, { tickers: ["NVDA", "AMD"] });
      assessThesis(h.db, thesis.id, reading({ tag: "approven", assessment: "Held four quarters." }));

      const byId = getThesis(h.db, thesis.id)!;
      expect(byId.regime).toEqual(["AMD", "NVDA"]);
      expect(byId.latest_tag).toBe("approven");
      expect(getThesis(h.db, "nope")).toBeNull();

      // There is no `getThesisByName` any more, and its absence is the decision: reaching a row by
      // its name is one rule for every table, so it lives in `repo/naming.ts` and hands back an id
      // the ordinary reads then take. A per-table lookup would have been that rule written twice.
      expect(findByName(h.db, "thesis", "  nvda-compounds  ")).toBe(thesis.id);
      expect(findByName(h.db, "thesis", "NVDA-COMPOUNDS")).toBe(thesis.id);
      expect(findByName(h.db, "thesis", "nope")).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("listTheses orders by the newest judgement, and by the container's own moment without one", () => {
    const h = harness();
    try {
      const t = nowMs();
      const early = seedThesis(h.db, "Judged this morning");
      const middle = seedThesis(h.db, "Judged last week");
      const unread = seedThesis(h.db, "Never measured");
      // Written last, judged first: the browse answers "what have we been thinking about", so the
      // moment that orders a thesis is when it was last READ, not when its container was stored.
      seedAssessment(h.db, early, "approven", t + 10_000);
      seedAssessment(h.db, middle, "insightful", t + 5_000);

      // The unassessed one falls back to its own created_at, which is what puts it last here rather
      // than nowhere: an empty ledger is a state to browse, not an absence to skip.
      expect(listTheses(h.db).map((x) => x.id)).toEqual([early, middle, unread]);
      expect(listTheses(h.db).map((x) => x.latest_tag)).toEqual(["approven", "insightful", null]);
      expect(listTheses(h.db, { tag: "unassessed" }).map((x) => x.id)).toEqual([unread]);
      expect(listTheses(h.db, { tag: "approven" }).map((x) => x.id)).toEqual([early]);

      // A re-reading moves a thesis, because the ordering key is the newest row of its ledger.
      seedAssessment(h.db, unread, "insightful", t + 20_000);
      expect(listTheses(h.db).map((x) => x.id)).toEqual([unread, early, middle]);
    } finally {
      h.cleanup();
    }
  });

  test("listTheses filters by how a thesis currently reads and by a ticker in its regime", () => {
    const h = harness();
    try {
      const nvda = store(h.db);
      const amd = store(h.db, { name: "AMD catches up", tickers: ["AMD"] });
      assessThesis(h.db, nvda.id, reading({ tag: "approven", assessment: "Held." }));

      expect(listTheses(h.db, { tag: "approven" }).map((t) => t.id)).toEqual([nvda.id]);
      // Nothing is born tagged: a create sets no tag at all, so the one nobody assessed answers to
      // "unassessed" rather than to a tag it could have been handed at creation.
      expect(listTheses(h.db, { tag: "insightful" })).toEqual([]);
      expect(listTheses(h.db, { tag: "unassessed" }).map((t) => t.id)).toEqual([amd.id]);
      expect(listTheses(h.db, { tag: "abandoned" })).toEqual([]);
      expect(listTheses(h.db, { ticker: "amd" }).map((t) => t.id)).toEqual([amd.id]);
      expect(listTheses(h.db, { tag: "approven", ticker: "AMD" })).toEqual([]);
      expect(listTheses(h.db)).toHaveLength(2);
      const err = refusal(() => listTheses(h.db, { tag: "promising" as never }));
      expect(err.kind).toBe("invalid_request");
      // The filter vocabulary is the three tags plus the empty ledger, and the refusal says so.
      expect(err.message).toContain("unassessed");
    } finally {
      h.cleanup();
    }
  });

  test("searchTheses reads the name and the statement, never the DSL", () => {
    const h = harness();
    try {
      const margin = store(h.db, {
        name: "100% gross margin",
        content: "Margin holds at 100% through the cycle.",
        tickers: ["NVDA"],
      });
      const share = store(h.db, {
        name: "AMD catches up",
        content: "Server share drifts across, 100 basis points a year.",
        dslJson: '{"note":"gross margin appears only in here"}',
        dslHash: "b".repeat(64),
        tickers: ["AMD"],
      });

      // Two prose columns: the statement, and the NAME — which is a slug, so it is searched the way
      // it is stored rather than the way the hint was typed.
      expect(searchTheses(h.db, "gross-margin").map((t) => t.id)).toEqual([margin.id]);
      expect(searchTheses(h.db, "cycle").map((t) => t.id)).toEqual([margin.id]);
      expect(searchTheses(h.db, "drifts").map((t) => t.id)).toEqual([share.id]);

      // The DSL is not prose and is never searched: matching it would rank a thesis that merely
      // READS a series above one that argues about it. `gross margin` appears in this database
      // exactly once, inside a document, and the search cannot see it.
      expect(searchTheses(h.db, "gross margin")).toEqual([]);
      expect(searchTheses(h.db, "appears only in here")).toEqual([]);

      // A LIKE wildcard the caller typed is a character they typed. Unescaped, this pattern would
      // also match "100 basis points" — which is how a search for a percentage would quietly become
      // a search for everything beginning "100".
      expect(searchTheses(h.db, "100%").map((t) => t.id)).toEqual([margin.id]);
      expect(refusal(() => searchTheses(h.db, " ")).message).toContain("listTheses");
    } finally {
      h.cleanup();
    }
  });
});

describe("deleteThesis", () => {
  test("takes its regime with it and frees the target for deletion", () => {
    const h = harness();
    try {
      const thesis = store(h.db);
      expect(deleteThesis(h.db, thesis.id)).toBe(true);
      expect(getThesis(h.db, thesis.id)).toBeNull();
      expect(count(h.db, "regime")).toBe(0);
      // The target outlives the thesis; only the link was the thesis's to own.
      expect(getTarget(h.db, "NVDA")).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("returns false for a thesis that was never there", () => {
    const h = harness();
    try {
      expect(deleteThesis(h.db, "nope")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("goes through with a published report standing, because no report points at a thesis", () => {
    const h = harness();
    try {
      const thesis = seedThesis(h.db, "NVDA compounds");
      seedAssessment(h.db, thesis);
      const reportId = seedReport(h.db);

      // THE PIN IS ON AN ABSENCE, and it is deliberate rather than an oversight. A report used to
      // record which readings it applied, and a thesis under one could not be deleted; that table
      // was the model's own account of its argument and nothing verified it, so it was dropped.
      // What a published document says about a thesis is now IN the document, which is immutable —
      // so deleting the thesis cannot change what any report claims, only what the archive can
      // still show a reader about it. Abandoning is no longer the only way out.
      expect(deleteThesis(h.db, thesis)).toBe(true);
      expect(getThesis(h.db, thesis)).toBeNull();
      // The ledger and the regime went with it, by cascade, exactly as they would have with no
      // report in the picture at all.
      expect(count(h.db, "thesis_assessment")).toBe(0);
      expect(count(h.db, "regime")).toBe(0);
      // And the report is untouched: nothing of it was ever the thesis's to take.
      expect(
        h.db.query<{ id: string }, [string]>("SELECT id FROM report WHERE id = ?").get(reportId),
      ).not.toBeNull();

      // One witness for one user-level act, holding the whole row that left. The cascaded ledger is
      // deliberately not logged separately — the deletion the user asked for was of a thesis.
      const logged = h.db
        .query<{ table_name: string; row_id: string; row_json: string }, []>(
          "SELECT table_name, row_id, row_json FROM deletion_log ORDER BY id",
        )
        .all();
      expect(logged).toHaveLength(1);
      expect(logged[0]!.table_name).toBe("thesis");
      expect(logged[0]!.row_id).toBe(thesis);
      const row = JSON.parse(logged[0]!.row_json) as Record<string, unknown>;
      expect(row["name"]).toBe("NVDA compounds");
      expect(row["dsl_hash"]).toBe("a".repeat(64));
    } finally {
      h.cleanup();
    }
  });

  test("has no foreign key left to bounce off: only a thesis's own rows point at it", () => {
    const h = harness();
    try {
      const thesis = seedThesis(h.db, "NVDA compounds");
      seedAssessment(h.db, thesis);
      seedReport(h.db);

      // Straight past the repository, the way a future writer of some other path would go — and
      // this is the half the repository cannot decide. The old refusal was really a foreign key
      // carrying no ON DELETE, so that the cascade into a thesis's ledger could not strand a
      // published document on a judgement the database no longer held. Both the table and that key
      // are gone, so the raw delete simply goes through.
      h.db.query("DELETE FROM thesis WHERE id = ?").run(thesis);
      expect(getThesis(h.db, thesis)).toBeNull();
      expect(count(h.db, "thesis_assessment")).toBe(0);
      expect(count(h.db, "report")).toBe(1);

      // Read off the live schema rather than asserted about the one write above, because what is
      // being pinned is that NOTHING anywhere holds a thesis down: every referrer is one of the
      // thesis's own children, each cascading, and no report-side table is among them.
      expect(referrersOf(h.db, "thesis")).toEqual(["regime", "thesis_assessment"]);
      expect(referrersOf(h.db, "thesis_assessment")).toEqual(["series_preparation"]);
    } finally {
      h.cleanup();
    }
  });
});
