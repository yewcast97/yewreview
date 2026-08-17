/**
 * Targets, against a real database — nothing here is faked, because the rules being pinned are the
 * schema's own: a foreign key with no ON DELETE, a CHECK on the ticker's shape, and one trigger.
 *
 * THE NAME IS WHAT MOST OF THIS FILE IS ABOUT, and it is the one exemption in this database's
 * naming rule. Every other record's name is a summary this codebase minted and the user may reword;
 * a target's is the instrument's OFFICIAL FULL NAME, which is a fact somebody looked up. So it is
 * required the first time a ticker is recorded, it is never minted, and it never moves: a later
 * call may omit it or repeat it in any capitalisation, and a call that CONTRADICTS it is refused
 * rather than silently kept or silently overwritten. Both layers are pinned — the repository's
 * refusal for the sentence it says, and `target_name_is_immutable` for the rule itself — because a
 * refusal in one layer only is a rule with a way round it.
 *
 * `market` and `unit` keep the accumulating semantics the name gave up: a later caller that knows
 * less must not erase what an earlier one supplied.
 */

import { test, expect, describe } from "bun:test";
import type { Database } from "bun:sqlite";

import { Refused } from "../src/db/models.ts";
import { newId } from "../src/db/tx.ts";
import {
  deleteTarget,
  getTarget,
  listTargets,
  normalizeTicker,
  upsertTarget,
} from "../src/repo/targets.ts";
import { createThesis } from "../src/repo/theses.ts";
import { harness } from "./helpers.ts";

/** Assert a call refuses, and hand back the refusal so the test can read its kind and message. */
function refusal(fn: () => unknown): Refused {
  try {
    fn();
  } catch (err) {
    if (err instanceof Refused) return err;
    throw err;
  }
  throw new Error("expected a Refused, got a result");
}

/**
 * A thesis measuring these instruments, with each of them recorded first.
 *
 * The regime's foreign key demands the target row exist, and a target cannot be conjured from a
 * ticker alone any more — `upsertTarget` refuses to write a row it has no official name for. So
 * this fixture names each instrument, and only the ones the caller has not already recorded, since
 * re-stating a name that differs from the standing one is itself a refusal.
 */
function seedThesis(db: Database, name: string, tickers: string[]): string {
  for (const ticker of tickers) {
    if (getTarget(db, ticker) === null) upsertTarget(db, { ticker, name: `${ticker} Corp.` });
  }
  return createThesis(db, {
    name,
    content: "It goes up.",
    dslJson: '{"version":1}',
    dslHash: newId(),
    tickers,
  }).id;
}

describe("normalizeTicker", () => {
  test("trims and upcases, and keeps the punctuation real symbols carry", () => {
    expect(normalizeTicker("  aapl ")).toBe("AAPL");
    expect(normalizeTicker("brk.b")).toBe("BRK.B");
    expect(normalizeTicker("rds-a")).toBe("RDS-A");
    expect(normalizeTicker("2330")).toBe("2330");
  });

  test("refuses rather than falling back, so a bad symbol never becomes an unmatched row", () => {
    const bads = ["", "   ", "not a ticker", "AAPL US EQUITY", "A".repeat(11), "AA PL", "$AAPL"];
    for (const bad of bads) {
      const err = refusal(() => normalizeTicker(bad));
      expect(err.kind).toBe("invalid_request");
      expect(err.message).toContain("not a usable ticker");
    }
  });
});

describe("upsertTarget", () => {
  test("accumulates metadata and never downgrades a field a later caller does not know", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "aapl", name: "Apple Inc.", market: "NASDAQ" });
      // The common caller: a DSL path that knows the symbol and nothing else. Leaving the name out
      // is the ordinary way to call this once the instrument is recorded — it is a fact about the
      // world that was looked up once, not something every caller has to carry.
      const after = upsertTarget(h.db, { ticker: "AAPL" });
      expect(after.name).toBe("Apple Inc.");
      expect(after.market).toBe("NASDAQ");
      expect(after.unit).toBeNull();

      const withUnit = upsertTarget(h.db, { ticker: "AAPL", unit: "dollar" });
      expect(withUnit.unit).toBe("dollar");
      expect(withUnit.name).toBe("Apple Inc.");
    } finally {
      h.cleanup();
    }
  });

  test("a ticker nobody has recorded needs the instrument's official name", () => {
    const h = harness();
    try {
      // A target nobody could name is a target nobody looked up. The name is not minted from the
      // ticker and there is no placeholder for it, because this is the one name here that cannot be
      // corrected later — an invented one would sit in the archive looking like a fact.
      const err = refusal(() => upsertTarget(h.db, { ticker: "AAPL" }));
      expect(err.kind).toBe("invalid_request");
      expect(err.message).toContain("official name");
      // And the refusal left nothing behind, metadata included.
      expect(getTarget(h.db, "AAPL")).toBeNull();
      expect(refusal(() => upsertTarget(h.db, { ticker: "AAPL", market: "NASDAQ" })).kind).toBe(
        "invalid_request",
      );
      expect(listTargets(h.db)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("a name that contradicts the standing one is refused; repeating it is not", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc." });

      // Not silently kept and not silently overwritten. Reports have been published citing this
      // name, so relabelling it would rewrite what those documents appear to be about — the way out
      // is to delete the target and record it again, which the deletion log witnesses.
      const err = refusal(() => upsertTarget(h.db, { ticker: "AAPL", name: "Apple Computer" }));
      expect(err.kind).toBe("conflict");
      expect(err.message).toContain("already recorded as");
      expect(err.message).toContain("Apple Inc.");
      expect(getTarget(h.db, "AAPL")?.name).toBe("Apple Inc.");

      // The same name in another capitalisation is the same name — the column is COLLATE NOCASE, so
      // a caller who typed it differently is agreeing rather than contradicting.
      expect(upsertTarget(h.db, { ticker: "AAPL", name: "APPLE INC." }).name).toBe("Apple Inc.");
      // Repeating it verbatim goes through too, and the metadata beside it still accumulates.
      expect(
        upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc.", market: "NASDAQ" }).market,
      ).toBe("NASDAQ");
      expect(getTarget(h.db, "AAPL")?.name).toBe("Apple Inc.");
    } finally {
      h.cleanup();
    }
  });

  test("the refusal is for the message; the trigger is the rule", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc." });
      // Straight past the repository, the way a future writer of some other path would go. Every
      // other record in this schema is renameable and nine triggers are written `BEFORE UPDATE OF`
      // every column BUT the name; this table is the one where the name is inside the list, and it
      // is the whole trigger.
      expect(() =>
        h.db.query("UPDATE target SET name = 'Apple Computer' WHERE ticker = 'AAPL'").run(),
      ).toThrow(/never edited/);
      expect(getTarget(h.db, "AAPL")?.name).toBe("Apple Inc.");

      // The columns that are not the name still move, which is what makes the trigger's column
      // scoping load-bearing rather than decorative.
      h.db.query("UPDATE target SET market = 'NASDAQ' WHERE ticker = 'AAPL'").run();
      expect(getTarget(h.db, "AAPL")?.market).toBe("NASDAQ");
    } finally {
      h.cleanup();
    }
  });

  test("keeps added_at from the first sighting", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc." });
      h.db.query("UPDATE target SET added_at = 1000 WHERE ticker = 'AAPL'").run();
      expect(upsertTarget(h.db, { ticker: "AAPL" }).added_at).toBe(1000);
    } finally {
      h.cleanup();
    }
  });

  test("refuses a blank field instead of storing it over what is already known", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc.", market: "NASDAQ" });
      // A blank is a different claim from an omission, and only the omission means "not known".
      const err = refusal(() => upsertTarget(h.db, { ticker: "AAPL", name: "  " }));
      expect(err.kind).toBe("invalid_request");
      expect(refusal(() => upsertTarget(h.db, { ticker: "AAPL", market: "" })).kind).toBe(
        "invalid_request",
      );
      expect(getTarget(h.db, "AAPL")).toMatchObject({ name: "Apple Inc.", market: "NASDAQ" });
    } finally {
      h.cleanup();
    }
  });

  test("getTarget normalizes its argument too", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc." });
      expect(getTarget(h.db, " aapl ")?.ticker).toBe("AAPL");
      expect(getTarget(h.db, "MSFT")).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe("listTargets", () => {
  test("counts the theses measuring it, which is the only count an instrument earns", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc." });
      seedThesis(h.db, "Apple grows", ["AAPL"]);
      seedThesis(h.db, "Apple stalls", ["AAPL"]);
      // A thesis measuring two instruments counts once against each, never twice against one.
      seedThesis(h.db, "Apple beats Microsoft", ["AAPL", "MSFT"]);

      const rows = listTargets(h.db);
      expect(rows.map((t) => t.ticker)).toEqual(["AAPL", "MSFT"]);
      const aapl = rows[0]!;
      expect(aapl.thesis_count).toBe(3);
      expect(aapl.name).toBe("Apple Inc.");
      expect(rows[1]).toMatchObject({ thesis_count: 1 });
    } finally {
      h.cleanup();
    }
  });

  test("orders by ticker and reports zero for a bare target", () => {
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "MSFT", name: "Microsoft Corporation" });
      upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc." });
      expect(listTargets(h.db).map((t) => t.ticker)).toEqual(["AAPL", "MSFT"]);
      expect(listTargets(h.db)[0]).toMatchObject({ thesis_count: 0 });
    } finally {
      h.cleanup();
    }
  });
});

describe("deleteTarget", () => {
  test("is refused while a thesis measures it, and names how many", () => {
    const h = harness();
    try {
      seedThesis(h.db, "Apple grows", ["AAPL"]);
      seedThesis(h.db, "Apple stalls", ["AAPL"]);
      const err = refusal(() => deleteTarget(h.db, "aapl"));
      expect(err.kind).toBe("conflict");
      expect(err.message).toContain("2 theses");
      expect(getTarget(h.db, "AAPL")).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("says 'thesis' when exactly one is in the way", () => {
    const h = harness();
    try {
      seedThesis(h.db, "Apple grows", ["AAPL"]);
      expect(refusal(() => deleteTarget(h.db, "AAPL")).message).toContain("1 thesis;");
    } finally {
      h.cleanup();
    }
  });

  test("goes through once the thesis that measured it is gone", () => {
    const h = harness();
    try {
      const thesisId = seedThesis(h.db, "Apple grows", ["AAPL"]);
      expect(refusal(() => deleteTarget(h.db, "AAPL")).kind).toBe("conflict");

      h.db.query("DELETE FROM thesis WHERE id = ?").run(thesisId);
      expect(deleteTarget(h.db, "AAPL")).toBe(true);
      expect(getTarget(h.db, "AAPL")).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("removes one leaf row and never a cascade — nothing hangs off a target", () => {
    const h = harness();
    try {
      seedThesis(h.db, "Apple beats Microsoft", ["AAPL", "MSFT"]);
      upsertTarget(h.db, { ticker: "TSLA", name: "Tesla" });

      expect(deleteTarget(h.db, "TSLA")).toBe(true);
      // The thesis that measures neither of them is untouched, regime and all.
      expect(h.db.query("SELECT COUNT(*) AS n FROM thesis").get()).toEqual({ n: 1 });
      expect(h.db.query("SELECT COUNT(*) AS n FROM regime").get()).toEqual({ n: 2 });
      expect(listTargets(h.db).map((t) => t.ticker)).toEqual(["AAPL", "MSFT"]);
    } finally {
      h.cleanup();
    }
  });

  test("the pre-check is for the message; the foreign key is the rule", () => {
    const h = harness();
    try {
      seedThesis(h.db, "Apple grows", ["AAPL"]);
      // Straight past the repository, the way a future writer of some other path would go. The
      // regime reference carries no ON DELETE precisely so this aborts rather than leaving a
      // thesis naming a ticker the database no longer has.
      expect(() => h.db.query("DELETE FROM target WHERE ticker = 'AAPL'").run()).toThrow(
        /FOREIGN KEY/,
      );
    } finally {
      h.cleanup();
    }
  });

  test("returns false for a target that was never there", () => {
    const h = harness();
    try {
      expect(deleteTarget(h.db, "AAPL")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("refuses a malformed ticker before deciding anything", () => {
    const h = harness();
    try {
      expect(refusal(() => deleteTarget(h.db, "not a ticker")).kind).toBe("invalid_request");
    } finally {
      h.cleanup();
    }
  });
});
