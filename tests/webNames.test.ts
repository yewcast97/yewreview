/**
 * Which row a name in a sentence points at, so a mention pill can be clicked.
 *
 * THE DIRECTORY RUNS THE OTHER WAY ROUND NOW, and the header it replaced said the opposite: a
 * mention used to carry an id, so the window's problem was finding a NAME to draw and this module
 * answered it. The wire carries the name now — `serializeOutgoing` writes it and `resolveRecordId`
 * reads it — so a pill draws itself out of the mention with nothing to look up, and what it still
 * needs is the other direction. Every read route in this window is addressed by id, so `lookupId` is
 * what stands between a pill being pressed and a card opening. There is no `mentionFallback` any
 * more: a pill that knows no id still knows what to say.
 *
 * LEARNED, NOT FETCHED, in the ordinary case — every card the window receives carries both halves,
 * and it receives cards constantly. `resolveId` in the store is the exception: one fetch for a record
 * the reader has a pill for and has never had on screen.
 *
 * The tests below are about the two things a directory like this can still get wrong: making the
 * window flicker, and sending a click at the wrong row. So they pin identity-stability as hard as
 * they pin the lookups, plus the case-folding the database's `COLLATE NOCASE` obliges, plus the
 * negative cache that keeps a pill for a deleted record from firing a fetch per repaint.
 */

import { describe, expect, test } from "bun:test";

import type { RecordCard } from "../web/src/lib/records.ts";
import {
  createNameIndex,
  isMissing,
  lookupId,
  markMissing,
  nameKey,
  rememberCards,
} from "../web/src/state/names.ts";

/** What a name resolves to is a table and an id, and a leaf row answers to its name exactly as one
 * that can be opened does — the directory reads neither. */
function card(table: RecordCard["table"], id: string, name: string): RecordCard {
  return { table, id, name, label: name };
}

const THESIS = card("thesis", "9f2c0a71e3b8465d8c1a4f7d206be5a1", "semis-inventory-glut");

describe("learning ids from traffic the window was already receiving", () => {
  test("a card teaches the directory which row answers to a name", () => {
    const index = rememberCards(createNameIndex(), [THESIS]);
    expect(lookupId(index, "thesis", "semis-inventory-glut")).toBe(THESIS.id);
  });

  test("a name the window has never seen has no id, and that is not an error", () => {
    // The store's answer to this is a fetch, not a failure — see `openNamedRecord`. A directory that
    // threw would make a pill for a record nobody has scrolled past into a bug report.
    expect(lookupId(createNameIndex(), "report", "never-drawn")).toBeNull();
  });

  test("two tables may hold the same name without colliding", () => {
    // Uniqueness is claimed WITHIN a table and nowhere else — `src/repo/naming.ts` says so — so a
    // thesis and a report may both be called `semis-inventory`, and the table is half the key.
    const index = rememberCards(createNameIndex(), [
      card("thesis", "t-1", "semis-inventory"),
      card("report", "r-1", "semis-inventory"),
    ]);
    expect(lookupId(index, "thesis", "semis-inventory")).toBe("t-1");
    expect(lookupId(index, "report", "semis-inventory")).toBe("r-1");
    expect(nameKey("thesis", "semis-inventory")).not.toBe(nameKey("report", "semis-inventory"));
  });

  test("a name is matched however it was capitalised, because the column is COLLATE NOCASE", () => {
    // Two spellings differing only in case name the same row in the database, so a directory that
    // was case-sensitive would answer "never seen it" about a record sitting on screen — and the
    // store would then fetch a record it already had. The grammar itself folds nothing; this is where
    // the folding lives.
    const index = rememberCards(createNameIndex(), [THESIS]);
    expect(lookupId(index, "thesis", "SEMIS-INVENTORY-GLUT")).toBe(THESIS.id);
    expect(lookupId(index, "thesis", "Semis-Inventory-Glut")).toBe(THESIS.id);
    expect(nameKey("thesis", "Semis-Inventory-Glut")).toBe(nameKey("thesis", "semis-inventory-glut"));

    // And a card arriving in a different case teaches nothing new, because it is not new.
    const shouted = rememberCards(index, [card("thesis", THESIS.id, "SEMIS-INVENTORY-GLUT")]);
    expect(shouted).toBe(index);
  });

  test("learning nothing new hands back the same index", () => {
    // This is called from every landing site in the store — the graph's roots are re-read twice a
    // second while the agent works — so a new index per refresh would re-render every pill in the
    // transcript for as long as a turn lasted.
    const index = rememberCards(createNameIndex(), [THESIS]);
    expect(rememberCards(index, [THESIS])).toBe(index);
    expect(rememberCards(index, [])).toBe(index);
    expect(rememberCards(createNameIndex(), [])).toEqual(createNameIndex());
  });

  test("a rename adds the new name and leaves the old one pointing where it did", () => {
    // The asymmetry worth stating: the sentence a pill sits in was written when the record answered
    // to the old name, and opening the row it MEANT is more use than refusing to. So a rename teaches
    // a second way in rather than closing the first.
    const index = rememberCards(createNameIndex(), [THESIS]);
    const renamed = rememberCards(index, [card("thesis", THESIS.id, "the-glut-clears")]);
    expect(renamed).not.toBe(index);
    expect(lookupId(renamed, "thesis", "the-glut-clears")).toBe(THESIS.id);
    expect(lookupId(renamed, "thesis", "semis-inventory-glut")).toBe(THESIS.id);
  });

  test("a name that has moved to another row points at the row that answers to it now", () => {
    // The other half of a rename: one thesis is renamed away from `semis-inventory-glut` and another
    // takes the name. The row that answers to a name NOW is the row a click should open, so the later
    // card wins outright.
    const index = rememberCards(createNameIndex(), [THESIS]);
    const moved = rememberCards(index, [card("thesis", "4a1d", "semis-inventory-glut")]);
    expect(moved).not.toBe(index);
    expect(lookupId(moved, "thesis", "semis-inventory-glut")).toBe("4a1d");
  });

  test("a card with no name teaches nothing rather than teaching an empty key", () => {
    // Nothing in the schema mints an empty name, but a projection that stopped selecting the column
    // would hand one over — and an entry under `script:` would then have every unnamed script
    // fighting over one key.
    const index = rememberCards(createNameIndex(), [card("script", "s1", "")]);
    expect(index).toEqual(createNameIndex());
    expect(lookupId(index, "script", "")).toBeNull();
  });

  test("a batch teaches everything in it at once, in one new index", () => {
    // Cards arrive by the page — a graph expansion, a record's whole edge list — and one new object
    // per page is the point of doing it in a batch.
    const index = rememberCards(createNameIndex(), [
      THESIS,
      card("target", "2330.TW", "Taiwan Semiconductor Manufacturing Company Limited"),
      card("script", "sc-1", "fetch-revenue"),
    ]);
    expect(lookupId(index, "target", "Taiwan Semiconductor Manufacturing Company Limited")).toBe(
      "2330.TW",
    );
    expect(lookupId(index, "script", "fetch-revenue")).toBe("sc-1");
    expect(lookupId(index, "thesis", "semis-inventory-glut")).toBe(THESIS.id);
  });
});

describe("names the server has refused", () => {
  test("asked once, remembered as gone, never asked again", () => {
    // Without this, a streaming answer containing a pill for a name nothing answers to would fire a
    // fetch on every repaint of every frame of it.
    const index = markMissing(createNameIndex(), "thesis", "ghost-thesis");
    expect(isMissing(index, "thesis", "ghost-thesis")).toBe(true);
    expect(markMissing(index, "thesis", "ghost-thesis")).toBe(index);
  });

  test("a refusal is remembered case-insensitively, like everything else here", () => {
    const index = markMissing(createNameIndex(), "thesis", "Ghost-Thesis");
    expect(isMissing(index, "thesis", "ghost-thesis")).toBe(true);
  });

  test("marking one name missing says nothing about any other", () => {
    const index = markMissing(createNameIndex(), "thesis", "ghost-thesis");
    expect(isMissing(index, "thesis", "another-name")).toBe(false);
    expect(isMissing(index, "report", "ghost-thesis")).toBe(false);
  });

  test("a refusal does not unlearn an id, because the two answer different questions", () => {
    // `markMissing` records that the SERVER refused a name; it is not a retraction of a card the
    // window was handed. The store reads the id first, so a record the reader has on screen keeps
    // opening — and the negative cache stays what it is, a way of not asking twice.
    let index = rememberCards(createNameIndex(), [THESIS]);
    index = markMissing(index, "thesis", "some-other-name");
    expect(lookupId(index, "thesis", "semis-inventory-glut")).toBe(THESIS.id);
    expect(isMissing(index, "thesis", "semis-inventory-glut")).toBe(false);
  });

  test("learning after a refusal keeps the refusal, and the two do not share a map", () => {
    const missing = markMissing(createNameIndex(), "report", "ghost-report");
    const learned = rememberCards(missing, [THESIS]);
    expect(isMissing(learned, "report", "ghost-report")).toBe(true);
    expect(lookupId(learned, "thesis", "semis-inventory-glut")).toBe(THESIS.id);
  });
});
