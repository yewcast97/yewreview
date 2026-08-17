/**
 * The rules every form in the record panel is made of.
 *
 * `lib/editing.ts` is small and every line of it is a decision that is invisible from the screen:
 * whether a refresh may touch what somebody is typing, and whether a button is bright. Neither can be
 * checked by looking at the running app — the first only misbehaves while the agent, or another tab,
 * happens to be writing to the record on screen — so they are asserted here.
 *
 * The one to read first is "a refresh does not reseed what is held". Every card in the panel re-reads
 * the record it is showing twice a second, for as long as the agent is working; a `useEffect` that
 * copied the answer into the text box would look perfectly correct and would delete a half-typed name
 * the instant anything anywhere in the database moved. That is the regression this file exists to
 * catch, and it is the reason the seeding is a pure function with an identity contract rather than an
 * effect.
 *
 * THE RULES ARE ABOUT THE KEY, NOT ABOUT THE SHAPE, which is what lets one module serve every form
 * in the window: a recipe's name, any record's label, and an address-book entry. A value is seeded
 * once per KEY whatever it is a value of, so the shape test below holds a multi-field value — the
 * address-book form is one — and says why that is the interesting case.
 */

import { describe, expect, test } from "bun:test";

import type { Draft } from "../web/src/lib/editing.ts";
import { canCommit, isDirty, seedDraft } from "../web/src/lib/editing.ts";

describe("holding what is being typed", () => {
  test("it is seeded from what is stored the first time a record is shown", () => {
    const draft = seedDraft<string>(null, "ab12", "TSMC capacity");
    expect(draft).toEqual({ key: "ab12", value: "TSMC capacity" });
  });

  test("a refresh does not reseed it, however far the record has moved", () => {
    // The failure this prevents, spelled out: the panel is showing a recipe, somebody is halfway
    // through renaming it, and a 500ms refresh lands carrying the stored name. The seeding is asked
    // again on every one of those renders and has to answer the same way every time.
    const typing: Draft<string> = { key: "ab12", value: "TSMC capacity throu" };
    const afterRefresh = seedDraft(typing, "ab12", "TSMC capacity");
    expect(afterRefresh.value).toBe("TSMC capacity throu");
    // The IDENTITY, not just the value: the caller holds this in component state, and a new object
    // with the same contents would re-render the input and move the caret to the end of it.
    expect(afterRefresh).toBe(typing);

    // Still true when the record genuinely changed underneath — another tab renamed it, the row came
    // back different — because what is in the box is what THIS reader typed, and the arbitration
    // between two renames belongs to whoever presses Save second, not to a poll.
    expect(seedDraft(typing, "ab12", "Something else entirely").value).toBe("TSMC capacity throu");
  });

  test("moving to another record seeds afresh, and coming back seeds from what is now stored", () => {
    const typing: Draft<string> = { key: "ab12", value: "abandoned mid-word" };
    const other = seedDraft(typing, "cd34", "Samsung foundry");
    expect(other).toEqual({ key: "cd34", value: "Samsung foundry" });
    // Nothing is remembered per record. A half-typed name that survived being navigated away from
    // would come back attached to a row that has since moved on, which is worse than losing it.
    expect(seedDraft(other, "ab12", "TSMC capacity").value).toBe("TSMC capacity");
  });

  test("it holds whatever the form is made of, not only a string", () => {
    // The rule is about the KEY rather than about the shape: one seeding, one identity, one record.
    // The address-book form is several fields held under one key, so the generic is load-bearing
    // rather than decoration — the identity contract has to hold for an object exactly as it does
    // for a string, or a refresh would rebuild the object and move every caret in the form.
    const held: Draft<{ source: string; domain: string }> = {
      key: "src:1",
      value: { source: "TWSE", domain: "filings" },
    };
    expect(seedDraft(held, "src:1", { source: "stale", domain: "stale" })).toBe(held);
  });
});

describe("whether there is anything worth writing", () => {
  test("identical text is not dirty, and everything else is", () => {
    expect(isDirty("TSMC capacity", "TSMC capacity")).toBe(false);
    expect(isDirty("TSMC capacity!", "TSMC capacity")).toBe(true);
  });

  test("whitespace counts", () => {
    // Not trimmed, deliberately. The two predicates part company over whitespace — `canCommit` trims
    // and this does not — because they answer different questions. `isDirty` is what marks a card as
    // holding something that would be LOST if it closed, and a reader who added a trailing space and
    // walked away has still typed something the window is about to throw out without asking.
    expect(isDirty("TSMC capacity ", "TSMC capacity")).toBe(true);
    expect(isDirty("  TSMC capacity", "TSMC capacity")).toBe(true);
  });

  test("an emptied box is dirty and still cannot be saved", () => {
    // The two predicates disagree here on purpose, and this is the case they exist for: one
    // select-all and a delete is all it takes to get here, and a recipe with no name is a row
    // nothing in this window can point at — the graph draws its label and the record panel titles
    // its card with it.
    expect(isDirty("", "TSMC capacity")).toBe(true);
    expect(canCommit("", "TSMC capacity")).toBe(false);
    expect(canCommit("   \n  ", "TSMC capacity")).toBe(false);
    expect(canCommit("Samsung foundry", "TSMC capacity")).toBe(true);
    expect(canCommit("TSMC capacity", "TSMC capacity")).toBe(false);
  });
});
