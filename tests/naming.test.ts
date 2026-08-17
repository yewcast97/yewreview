/**
 * The name every record carries, and the three things ever done to one: minting it when the row is
 * written, resolving one somebody has said back to a row, and changing it when the user asks.
 *
 * THE PROPERTY MOST OF THIS FILE IS ABOUT: A NAME MEANS EXACTLY ONE ROW OF ITS OWN TABLE, AND
 * CLAIMS NOTHING WIDER. The mechanism is one UNIQUE index per record table, so duplication inside a
 * table is impossible even for SQL written by hand — `nameTaken` is the pre-check that turns that
 * index's constraint error into a sentence, not a second guarantee. Across tables nothing is
 * promised and the tests below pin the ABSENCE of a promise: a recipe and a script may both be
 * called `semis`, because a name is never read on its own, only ever alongside the table it belongs
 * to. That is the inversion of what this file used to say, and it is the reason `resolveRecordId`
 * takes a table and a reference rather than a reference alone.
 *
 * `target` IS THE EXEMPTION. Its name is the instrument's official full name — a fact somebody
 * looked up rather than a summary anybody composed — so it is never minted and never renamed:
 * `renameRecord` refuses the table outright and the schema's `target_name_is_immutable` trigger says
 * the same thing to whoever reaches the database another way. Both are pinned, because a refusal in
 * one layer only is a rule with a way round it.
 *
 * The other property, and the reason renaming is safe at all: A RENAME WAKES NO RULE. Nine tables in
 * this schema abort every UPDATE that names a column carrying meaning, and each of those triggers
 * had to be narrowed by hand to a column list. A list that missed a column would leave it writable;
 * a list that still carried `name` would make that table's rows unrenameable. The sweep at the foot
 * of this file is what would notice either.
 */

import { describe, expect, test } from "bun:test";

import { Refused } from "../src/db/models.ts";
import {
  MAX_NAME_LENGTH,
  composeName,
  findByName,
  mintName,
  nameTaken,
  renameRecord,
  resolveRecordId,
  slugify,
} from "../src/repo/naming.ts";
import { createRecipe } from "../src/repo/recipes.ts";
import { RECORD_TABLES, getRecord, listTable } from "../src/repo/records.ts";
import { recordReport } from "../src/repo/reports.ts";
import { createScript } from "../src/repo/scripts.ts";
import { createSource } from "../src/repo/sources.ts";
import { upsertTarget } from "../src/repo/targets.ts";
import { harness } from "./helpers.ts";

function refusal(fn: () => unknown): Refused {
  try {
    fn();
  } catch (err) {
    if (err instanceof Refused) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("the slug a name is minted from", () => {
  test("is lowercase words joined by hyphens", () => {
    expect(slugify("NVDA Q3 Revenue")).toBe("nvda-q3-revenue");
    expect(slugify("  Semis / inventory  ")).toBe("semis-inventory");
    expect(slugify("data.nasdaq.com")).toBe("data-nasdaq-com");
  });

  test("is cut short, and never left ending on a hyphen", () => {
    // The cut is on characters rather than words, so it lands mid-word — what must not happen is
    // that it lands on a separator and leaves `nvda--4k7p`, which reads as a mistake.
    const long = slugify("the quarterly revenue report for the semiconductor basket");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
  });

  test("comes back empty rather than inventing something", () => {
    // A supported answer, not a failure: a transliteration would be this module naming a thing it
    // cannot read, and `composeName` falls back to the suffix alone.
    expect(slugify("半導体在庫")).toBe("");
    expect(slugify("!!!")).toBe("");
    expect(slugify("")).toBe("");
  });
});

describe("a minted name", () => {
  test("is the bare slug until the bare slug is spoken for", () => {
    // THE SHAPE OF THE WHOLE RULE. A name is a condensed summary, so the first thesis about NVDA's
    // third quarter is `nvda-q3`; only the second one pays for the ambiguity it created.
    expect(composeName("NVDA Q3", false)).toBe("nvda-q3");
    expect(composeName("NVDA Q3", true)).toMatch(/^nvda-q3-[a-z0-9]{4}$/);
  });

  test("is the suffix alone when there is nothing to slugify, distinguished or not", () => {
    expect(composeName("!!!", false)).toMatch(/^[a-z0-9]{4}$/);
    expect(composeName("半導体在庫", true)).toMatch(/^[a-z0-9]{4}$/);
  });

  test("differs run to run once it is distinguished, which is what makes it unique", () => {
    const names = new Set(Array.from({ length: 50 }, () => composeName("prices", true)));
    expect(names.size).toBeGreaterThan(40);
  });

  test("is short enough to draw", () => {
    const name = composeName("a fetcher with a rather long and descriptive name on it", true);
    expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });
});

describe("uniqueness within a table, and nowhere wider", () => {
  test("a name held by this table is taken, and the same name in another table is not", () => {
    const h = harness();
    try {
      const recipe = createRecipe(h.db, "Semis", "Write a report.");
      expect(nameTaken(h.db, "recipe", recipe.name)).toBe(true);
      expect(nameTaken(h.db, "script", recipe.name)).toBe(false);
      expect(nameTaken(h.db, "recipe", "nothing-holds-this-9999")).toBe(false);
      // A row does not collide with itself, which is what makes renaming a row to the name it
      // already has a no-op rather than a conflict.
      expect(nameTaken(h.db, "recipe", recipe.name, recipe.id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("case does not make two names, because the columns are NOCASE", () => {
    const h = harness();
    try {
      const recipe = createRecipe(h.db, "Semis", "Write a report.");
      expect(nameTaken(h.db, "recipe", recipe.name.toUpperCase())).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("A RECIPE AND A SCRIPT MAY SHARE A NAME, and that is the guarantee rather than a gap", () => {
    // The inversion this file used to pin the other way round. Nothing reads a name on its own: the
    // window draws it beside its table, a mention on the wire is `@table:name`, and every lookup
    // below takes both. So two tables holding `semis` is not a collision, and making it one would
    // mean a script nobody could name after the recipe that runs it.
    const h = harness();
    try {
      const recipe = createRecipe(h.db, "Semis", "Write a report.");
      const script = createScript(h.db, { name: "Semis", domain: "ohlcv", source: "print(1)" });
      expect(script.name).toBe(recipe.name);
      // And each name still means exactly one row, because the pair is the address.
      expect(findByName(h.db, "recipe", "semis")).toBe(recipe.id);
      expect(findByName(h.db, "script", "semis")).toBe(script.id);
    } finally {
      h.cleanup();
    }
  });

  test("minting tries the bare slug first and distinguishes only the repeat", () => {
    const h = harness();
    try {
      // Three recipes saying three different things, because a recipe's TEXT is what a reader
      // reads and only the hint is being contested here.
      const first = createRecipe(h.db, "prices", "Write a report.");
      const second = createRecipe(h.db, "prices", "Write another report.");
      const third = createRecipe(h.db, "prices", "Write a third report.");
      expect(first.name).toBe("prices");
      expect(second.name).toMatch(/^prices-[a-z0-9]{4}$/);
      expect(third.name).toMatch(/^prices-[a-z0-9]{4}$/);
      expect(second.name).not.toBe(third.name);

      // And the check is against ONE table: `prices` is spoken for among recipes and free among
      // theses, so a mint for another table hands back the bare slug again.
      expect(mintName(h.db, "thesis", "prices")).toBe("prices");
      for (let i = 0; i < 20; i += 1) {
        expect(nameTaken(h.db, "recipe", mintName(h.db, "recipe", "prices"))).toBe(false);
      }
    } finally {
      h.cleanup();
    }
  });

  test("every row a real write produces carries a name of its own", () => {
    const h = harness();
    try {
      const first = createRecipe(h.db, "Semis", "Write a report.");
      createRecipe(h.db, "Semis", "Write another report.");
      // A report and the three kinds of command its procedure recorded, so the sweep reaches the
      // machine-written tables too — every one of those names is minted inside the publishing
      // transaction rather than supplied by anybody.
      recordReport(h.db, first.id, "NVDA Q2", "<article><h1>NVDA Q2</h1></article>", {
        seikanRuns: [
          {
            command: "/opt/venv/bin/seikan run thesis.json",
            return: '{"cells": []}',
            exitCode: 0,
            durationMs: 12,
            at: 1_000,
          },
        ],
        shellRuns: [
          { command: "ls -la", return: "total 0", exitCode: 0, durationMs: 3, at: 1_100 },
        ],
      });
      createSource(h.db, {
        source: "Apple IR",
        type: "issuer_primary",
        domain: "filings",
        method: "browse",
        hosts: ["investor.apple.com"],
      });
      createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc." });

      let rows = 0;
      for (const table of RECORD_TABLES) {
        const seen = new Set<string>();
        for (const card of listTable(h.db, table, { limit: 100 }).records) {
          expect(card.name).not.toBe("");
          expect(seen.has(card.name.toLowerCase())).toBe(false);
          seen.add(card.name.toLowerCase());
          rows += 1;
        }
      }
      // Two recipes, a report, its measurement and its one shell line, a source, a script and a
      // target. A sweep that found nothing would pass every assertion above.
      expect(rows).toBeGreaterThanOrEqual(8);
    } finally {
      h.cleanup();
    }
  });
});

describe("finding a row by what somebody called it", () => {
  test("a name comes back as an id, case-insensitively, and only from its own table", () => {
    const h = harness();
    try {
      const recipe = createRecipe(h.db, "Semis", "Write a report.");
      expect(findByName(h.db, "recipe", "semis")).toBe(recipe.id);
      expect(findByName(h.db, "recipe", "  SEMIS  ")).toBe(recipe.id);
      expect(findByName(h.db, "script", "semis")).toBe(null);
      expect(findByName(h.db, "recipe", "nothing-holds-this")).toBe(null);
    } finally {
      h.cleanup();
    }
  });

  test("a reference is either an id or a name, and a ticker is normalised like any other id", () => {
    const h = harness();
    try {
      const recipe = createRecipe(h.db, "Semis", "Write a report.");
      expect(resolveRecordId(h.db, "recipe", recipe.id)).toBe(recipe.id);
      expect(resolveRecordId(h.db, "recipe", "semis")).toBe(recipe.id);
      expect(resolveRecordId(h.db, "recipe", " SEMIS ")).toBe(recipe.id);

      // A target is addressed by its ticker, which is normalised on the way in exactly as a read
      // normalises it — and by the official name, which is not id-shaped at all.
      upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc." });
      expect(resolveRecordId(h.db, "target", " aapl ")).toBe("AAPL");
      expect(resolveRecordId(h.db, "target", "apple inc.")).toBe("AAPL");
    } finally {
      h.cleanup();
    }
  });

  test("the id shape is tried FIRST, so a name that looks like an id cannot capture it", () => {
    // A user may rename a row to anything, id-shaped strings included. Trying the id first makes
    // the answer a function of the argument alone rather than of what somebody typed into a name.
    const h = harness();
    try {
      const real = createRecipe(h.db, "Semis", "Write a report.");
      const impostor = createRecipe(h.db, "Elsewhere", "Write another report.");
      renameRecord(h.db, "recipe", impostor.id, real.id);
      expect(resolveRecordId(h.db, "recipe", real.id)).toBe(real.id);
    } finally {
      h.cleanup();
    }
  });

  test("a reference nothing answers to names both ways in", () => {
    // A caller holding a stale name and a caller holding a mistyped id need the same next step, and
    // neither can tell from the outside which of the two they are.
    const h = harness();
    try {
      const missing = refusal(() => resolveRecordId(h.db, "recipe", "semis"));
      expect(missing.kind).toBe("not_found");
      expect(missing.message).toContain("give either its id or its name");
      expect(refusal(() => resolveRecordId(h.db, "recipe", "  ")).kind).toBe("not_found");
    } finally {
      h.cleanup();
    }
  });
});

describe("renaming", () => {
  test("changes the name and nothing else about the row", () => {
    const h = harness();
    try {
      const recipe = createRecipe(h.db, "Semis", "Write a report.");
      renameRecord(h.db, "recipe", recipe.id, "  semiconductors  ");
      const card = getRecord(h.db, "recipe", recipe.id).card;
      // Trimmed, and the DESCRIPTION is untouched: a recipe's label is the opening words of the
      // specification itself, which renaming the row has no business moving — and could not, since
      // `recipe_moves_only_its_status` aborts every UPDATE that names `content`.
      expect(card.name).toBe("semiconductors");
      expect(card.label).toBe("Write a report.");
    } finally {
      h.cleanup();
    }
  });

  test("refuses a name this table already holds, and says so per table", () => {
    const h = harness();
    try {
      const a = createRecipe(h.db, "Semis", "Write a report.");
      const b = createRecipe(h.db, "Semis", "Write another report.");
      const taken = refusal(() => renameRecord(h.db, "recipe", b.id, a.name));
      expect(taken.kind).toBe("conflict");
      expect(taken.message).toContain("another recipe already answers to");
      expect(taken.message).toContain("within a table one name always means one row");
      // And the row is left as it was, rather than half-renamed.
      expect(getRecord(h.db, "recipe", b.id).card.name).toBe(b.name);
    } finally {
      h.cleanup();
    }
  });

  test("does not refuse a name another TABLE holds", () => {
    const h = harness();
    try {
      const recipe = createRecipe(h.db, "Semis", "Write a report.");
      const script = createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      renameRecord(h.db, "script", script.id, recipe.name);
      expect(getRecord(h.db, "script", script.id).card.name).toBe(recipe.name);
      expect(getRecord(h.db, "recipe", recipe.id).card.name).toBe(recipe.name);
    } finally {
      h.cleanup();
    }
  });

  test("renaming a row to the name it already has is allowed", () => {
    const h = harness();
    try {
      const recipe = createRecipe(h.db, "Semis", "Write a report.");
      renameRecord(h.db, "recipe", recipe.id, recipe.name);
      expect(getRecord(h.db, "recipe", recipe.id).card.name).toBe(recipe.name);
    } finally {
      h.cleanup();
    }
  });

  test("refuses a blank name, an overlong one, and one with a newline in it", () => {
    const h = harness();
    try {
      const recipe = createRecipe(h.db, "Semis", "Write a report.");
      expect(refusal(() => renameRecord(h.db, "recipe", recipe.id, "   ")).kind).toBe(
        "invalid_request",
      );
      expect(
        refusal(() => renameRecord(h.db, "recipe", recipe.id, "x".repeat(MAX_NAME_LENGTH + 1)))
          .kind,
      ).toBe("invalid_request");
      // A name that is one thing in the database and another on screen is not a name.
      expect(refusal(() => renameRecord(h.db, "recipe", recipe.id, "one\ntwo")).kind).toBe(
        "invalid_request",
      );
    } finally {
      h.cleanup();
    }
  });

  test("a table that is not a record table, and an id that names nothing, are refused apart", () => {
    const h = harness();
    try {
      // `regime` is the schema's one junction, and it carries no name to change: it is drawn as an
      // edge between the two records it joins, and a caller reaching for it is holding a table that
      // addresses no record at all.
      const junction = refusal(() => renameRecord(h.db, "regime", "x", "n"));
      expect(junction.kind).toBe("not_found");
      expect(junction.message).toContain("a link between records rather than a record");
      expect(refusal(() => renameRecord(h.db, "recipe", "f".repeat(32), "nothing")).kind).toBe(
        "not_found",
      );
      // A malformed id is a different mistake from a well-shaped one that names nothing, and the
      // record browser's own validator is what tells them apart.
      expect(refusal(() => renameRecord(h.db, "recipe", "not-an-id", "x")).kind).toBe(
        "invalid_request",
      );
    } finally {
      h.cleanup();
    }
  });

  test("A TARGET IS NEVER RENAMED, and both layers say so", () => {
    // The one name in this database that is not ours. A company's registered name is a fact
    // somebody looked up, reports have been published citing it, and quietly relabelling it would
    // rewrite what those reports appear to be about. Correcting a wrong one is deleting the target
    // and recording it again, which the deletion log witnesses.
    const h = harness();
    try {
      upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc." });
      const refused = refusal(() => renameRecord(h.db, "target", "aapl", "Apple Computer"));
      expect(refused.kind).toBe("invalid_request");
      expect(refused.message).toContain("official name");
      expect(getRecord(h.db, "target", "AAPL").card.name).toBe("Apple Inc.");

      // And the schema says it too, to anything reaching the database another way — a refusal in
      // one layer only is a rule with a way round it.
      expect(() =>
        h.db.query("UPDATE target SET name = ? WHERE ticker = ?").run("Apple Computer", "AAPL"),
      ).toThrow(/never edited/);
    } finally {
      h.cleanup();
    }
  });

  test("wakes no immutability trigger, on any table that has one", () => {
    // THE LOOP THIS FILE EXISTS FOR. Nine tables abort every UPDATE naming a column that carries
    // meaning, and each of those triggers was narrowed by hand to a column list when the name became
    // the one mutable column. A list that had kept `name` on it would make that table's rows
    // unrenameable, and nothing else in the suite would say so — the tool that would have noticed is
    // a user pressing Save.
    //
    // `target` is walked past rather than left out silently: its trigger is the inverse one, and the
    // test above is where it is pinned.
    const h = harness();
    try {
      const recipe = createRecipe(h.db, "Semis", "Write a report.");
      // A published report and the three kinds of command its procedure recorded, so the loop
      // reaches the four tables whose triggers freeze a publication as well as the two whose
      // triggers let only a status move.
      recordReport(h.db, recipe.id, "NVDA Q2", "<article><h1>NVDA Q2</h1></article>", {
        seikanRuns: [
          {
            command: "/opt/venv/bin/seikan run thesis.json",
            return: '{"cells": []}',
            exitCode: 0,
            durationMs: 12,
            at: 1_000,
          },
        ],
        shellRuns: [
          { command: "ls -la", return: "total 0", exitCode: 0, durationMs: 3, at: 1_100 },
        ],
      });
      createSource(h.db, {
        source: "Apple IR",
        type: "issuer_primary",
        domain: "filings",
        method: "browse",
        hosts: ["investor.apple.com"],
      });
      createScript(h.db, { name: "prices", domain: "ohlcv", source: "print(1)" });
      upsertTarget(h.db, { ticker: "AAPL", name: "Apple Inc." });

      let n = 0;
      for (const table of RECORD_TABLES) {
        if (table === "target") continue;
        for (const card of listTable(h.db, table, { limit: 100 }).records) {
          const wanted = `renamed-${table}-${n}`;
          renameRecord(h.db, table, card.id, wanted);
          expect(getRecord(h.db, table, card.id).card.name).toBe(wanted);
          n += 1;
        }
      }
      expect(n).toBeGreaterThanOrEqual(6);
      // And every DESCRIPTION survived: the recipe still wears the opening words of its own
      // specification, which is the column its rename must not have touched.
      expect(getRecord(h.db, "recipe", recipe.id).card.label).toBe("Write a report.");
    } finally {
      h.cleanup();
    }
  });
});
