/**
 * The model pool as the WINDOW holds it: what a read lands, what a change would save, and what a
 * slot says.
 *
 * Everything here is the pure slice alone — no store, no socket, no DOM, no server. That is the
 * point of `web/src/state/opencode.ts` being what it is: the store fetches and the component draws,
 * and the rules worth asserting are in neither of those places. What is REAL below is the reducer
 * and the five document builders; what is FAKED is the wire, as literal `OpencodePool` objects,
 * because the shape they stand in for is checked by zod at the boundary (`lib/api.ts`) and by the
 * server's own tests on the far side of it. A test that started a server to add a sticky note would
 * be asserting the route, which `tests/server.test.ts` already does.
 *
 * ONE THING HERE IS NOT PURE AND IT IS THE POINT OF THE FILE'S FIRST TEST: the server's own
 * `OPENCODE_ROLES` and `PRIMARY_ROLE` are imported as VALUES and compared against the assumption
 * this window makes about them — that the vocabulary arrives in that order and that the FIRST word
 * in it is the role which answers an ordinary turn. `state/opencode.ts` depends on that in one place
 * (`addedModel` fills the primary slot with the first model, because the route refuses a pool that
 * has models in it and nothing answering that role), and a coupling nothing checks is a coupling
 * that breaks silently. Those constants come from a module that reaches `node:fs`, which is exactly
 * why the window cannot import them and this file can: it runs under the root tsconfig, in Bun.
 *
 * The two properties every test below is really about are the ones the panel is unusable without.
 * NOTHING MOVES THAT WAS NOT MOVED — a landing that changed nothing hands back the same state and
 * every unchanged entry keeps its object, because each of those notes holds four boxes somebody may
 * be typing in. And A DOCUMENT IS ALWAYS COHERENT: the route validates what it is given as a whole,
 * so a change that would leave a role naming a model that is not there has to fix both halves in the
 * one document it sends.
 */

import { describe, expect, test } from "bun:test";

import { OPENCODE_ROLES, PRIMARY_ROLE } from "../src/opencode/config.ts";
import type { PoolEntry } from "../src/opencode/config.ts";
import type { Harness } from "../web/src/lib/api.ts";
import type { Harness as ServerHarness } from "../src/config.ts";
import type { OpencodeModel, OpencodePool } from "../web/src/lib/api.ts";
import type { OpencodeState } from "../web/src/state/opencode.ts";
import {
  addedModel,
  assignedRole,
  assignmentFor,
  beginPoolRead,
  clearedRole,
  createOpencodeState,
  failPoolRead,
  landPool,
  modelLabel,
  primaryRole,
  removedModel,
  setPoolOpen,
  setSlotHot,
  updatedModel,
} from "../web/src/state/opencode.ts";

/** Fails to instantiate — a compile error — unless what it is given is exactly `true`. */
type AssertTrue<T extends true> = T;

/** Both directions at once, so neither side can quietly grow a word the other does not have. The
 * `tests/webProtocol.test.ts` helper, borrowed rather than imported: that file is the mirror lock
 * for four shapes and this is a fifth that belongs beside the thing it is about. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/*
 * The harness word, mirrored by hand in `lib/api.ts` because `src/config.ts` reaches the agent SDK
 * and `node:path` and cannot be imported into a browser bundle. A third harness — or a rename — is a
 * typecheck failure on this line rather than a window drawing the wrong chrome for it.
 */
export type HarnessFits = AssertTrue<Mutual<ServerHarness, Harness>>;

/*
 * And the pool entry itself, which crosses the wire whole. The window's `OpencodeModel` is the
 * server's `PoolEntry`: a field added to one is a note with a box missing, which is the kind of
 * mismatch that shows up as a saved credential that quietly does nothing.
 */
export type PoolEntryFits = AssertTrue<Mutual<PoolEntry, OpencodeModel>>;

function model(id: string, name = "", extra: Partial<OpencodeModel> = {}): OpencodeModel {
  return { id, name, url: "", api: "", model: "", ...extra };
}

/** A pool as the route answers it. The vocabulary is the server's own, which is what the window
 * draws slots from. */
function pool(
  entries: OpencodeModel[],
  roles: Record<string, string> = {},
): OpencodePool {
  return { entries, roles, roles_vocabulary: [...OPENCODE_ROLES] };
}

/** A state holding that pool, which is how every test below starts: the window knows nothing until
 * a read lands. */
function held(entries: OpencodeModel[], roles: Record<string, string> = {}): OpencodeState {
  return landPool(createOpencodeState(), pool(entries, roles));
}

describe("what this window assumes about the server's roles", () => {
  test("the vocabulary's first word is the role that answers", () => {
    // The one coupling `state/opencode.ts` cannot check for itself. `primaryRole` reads
    // `vocabulary[0]`, and `addedModel` puts the first model in the pool into that slot because the
    // route refuses a pool with models and nothing answering it. Reordering OPENCODE_ROLES on the
    // server would silently move which slot this window fills; it fails here instead.
    // Widened to `string` on the way in: the tuple's first member is the literal `"build"` and
    // `PRIMARY_ROLE` is declared as the union, so a direct comparison is a type error rather than
    // the runtime check this wants to be — and a compile-time version cannot be written, because
    // the constant this is pinning does not carry its own value in its type.
    const first: string = OPENCODE_ROLES[0];
    expect(first).toBe(PRIMARY_ROLE);
    expect(primaryRole(held([]))).toBe(PRIMARY_ROLE);
  });

  test("a window that has been told nothing has no roles and no primary", () => {
    // Not a defensive branch: it is every window's first frame, before health has even named the
    // harness. The row of slots draws nothing at all rather than five empty ones for a vocabulary
    // nobody has sent.
    const fresh = createOpencodeState();
    expect(fresh.vocabulary).toEqual([]);
    expect(primaryRole(fresh)).toBeNull();
    // And a document built in that state assigns nothing, rather than inventing a role name.
    expect(addedModel(fresh, "m1").roles).toEqual({});
  });
});

describe("landing a pool", () => {
  test("the whole document arrives, entries and roles and vocabulary alike", () => {
    const state = held([model("m1", "Sonnet"), model("m2", "Haiku")], { build: "m1" });
    expect(state.models.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(state.roles).toEqual({ build: "m1" });
    expect(state.vocabulary).toEqual([...OPENCODE_ROLES]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  test("a landing that changes nothing hands back the same state", () => {
    // The common case: the panel is opened, the pool is re-read, and it says exactly what it said.
    // A new state object here would redraw every note — and every box somebody is mid-word in.
    const state = held([model("m1", "Sonnet")], { build: "m1" });
    expect(landPool(state, pool([model("m1", "Sonnet")], { build: "m1" }))).toBe(state);
  });

  test("an entry that did not change keeps the object it had", () => {
    const state = held([model("m1", "Sonnet"), model("m2", "Haiku")], { build: "m1" });
    const before = state.models[1];
    const next = landPool(
      state,
      pool([model("m1", "Opus"), model("m2", "Haiku")], { build: "m1" }),
    );
    expect(next).not.toBe(state);
    // One note is redrawn and the other is not, which is what a save that renamed one model costs.
    expect(next.models[0]).not.toBe(state.models[0]);
    expect(next.models[1]).toBe(before);
    // And the roles were not touched, so that object survives too.
    expect(next.roles).toBe(state.roles);
  });

  test("every field of an entry is compared, the credential included", () => {
    // A key corrected in another tab and re-read here has to reach the box that shows it: this
    // window renders the api field, so a comparison that skipped it would leave the old key on
    // screen with no way to notice.
    const state = held([model("m1", "Sonnet", { api: "OLD_KEY" })]);
    const next = landPool(state, pool([model("m1", "Sonnet", { api: "NEW_KEY" })]));
    expect(next).not.toBe(state);
    expect(next.models[0]?.api).toBe("NEW_KEY");
  });

  test("the answer is the complete document, so what it does not name is gone", () => {
    const state = held([model("m1"), model("m2")], { build: "m1" });
    const next = landPool(state, pool([model("m2")], {}));
    expect(next.models.map((entry) => entry.id)).toEqual(["m2"]);
    expect(next.roles).toEqual({});
  });

  test("a read in flight, and one that failed, are both states the panel can draw", () => {
    const state = held([model("m1", "Sonnet")]);
    const reading = beginPoolRead(state);
    expect(reading.loading).toBe(true);
    // The models stay while it reads: a panel that emptied itself for the length of a loopback
    // request would blink its whole contents for no news.
    expect(reading.models).toBe(state.models);

    const failed = failPoolRead(reading, "the pool file is not readable");
    expect(failed.loading).toBe(false);
    expect(failed.error).toBe("the pool file is not readable");
    expect(failed.models).toBe(state.models);
    // The same sentence again is not a re-render: this fires on every retry while a server is down.
    expect(failPoolRead(failed, "the pool file is not readable")).toBe(failed);

    // And a landing clears it, rather than leaving a refusal standing over rows that answered.
    expect(landPool(failed, pool([model("m1", "Sonnet")])).error).toBeNull();
  });
});

describe("what a slot says", () => {
  test("a resolved role names its model, and an empty one is empty", () => {
    const state = held([model("m1", "Sonnet")], { build: "m1" });
    const assigned = assignmentFor(state, PRIMARY_ROLE);
    expect(assigned.kind).toBe("model");
    expect(assigned.kind === "model" ? assigned.model.name : null).toBe("Sonnet");
    expect(assignmentFor(state, "plan").kind).toBe("empty");
  });

  test("an assignment naming a model that is not in the pool DANGLES, and says so", () => {
    // Two tabs, or a pool file edited by hand: the roles are read from the same document as the
    // entries, but nothing guarantees the id resolves. The config still routes that role somewhere,
    // so a slot drawing `—` would be a lie about what answers — the id is what there is to show.
    const state = landPool(createOpencodeState(), {
      entries: [model("m1", "Sonnet")],
      roles: { build: "m1", plan: "gone" },
      roles_vocabulary: [...OPENCODE_ROLES],
    });
    const dangling = assignmentFor(state, "plan");
    expect(dangling.kind).toBe("dangling");
    expect(dangling.kind === "dangling" ? dangling.id : null).toBe("gone");
  });

  test("a model with nothing typed in it is still something to point at", () => {
    // The note the double-click just pinned up: blank in all four boxes, and it has to be nameable
    // in a slot and in a picker's list before anybody has typed a character.
    expect(modelLabel(model("m1"))).toBe("m1");
    expect(modelLabel(model("m1", "", { model: "openai/gpt-5.6" }))).toBe("openai/gpt-5.6");
    expect(modelLabel(model("m1", "Sonnet", { model: "openai/gpt-5.6" }))).toBe("Sonnet");
  });
});

describe("the documents a change would save", () => {
  test("the first model added takes the primary slot, because the route refuses a pool without one", () => {
    const next = addedModel(held([]), "m1");
    expect(next.entries.map((entry) => entry.id)).toEqual(["m1"]);
    expect(next.roles).toEqual({ [PRIMARY_ROLE]: "m1" });
    // Blank in every box: a note pinned to a board is empty until somebody types in it, and the
    // pool allows that.
    expect(next.entries[0]).toEqual({ id: "m1", name: "", url: "", api: "", model: "" });
  });

  test("a second model is added unassigned, because there is nothing to satisfy", () => {
    const next = addedModel(held([model("m1")], { [PRIMARY_ROLE]: "m1" }), "m2");
    expect(next.entries.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(next.roles).toEqual({ [PRIMARY_ROLE]: "m1" });
  });

  test("a model added while the primary role dangles takes it over", () => {
    // The pool would be refused as it stands, so the note being pinned up is what repairs it. The
    // same reasoning as the empty pool, one state further along.
    const state = landPool(createOpencodeState(), {
      entries: [],
      roles: { [PRIMARY_ROLE]: "gone" },
      roles_vocabulary: [...OPENCODE_ROLES],
    });
    // The route would not have answered that in the first place, but a hand-edited file can, and
    // the window must not need a second gesture to get out of it.
    expect(addedModel(state, "m1").roles[PRIMARY_ROLE]).toBe("m1");
  });

  test("a note is committed whole, and the rest of the document rides along untouched", () => {
    const state = held([model("m1", "Sonnet"), model("m2", "Haiku")], { build: "m1" });
    const next = updatedModel(state, "m2", {
      id: "m2",
      name: "Haiku",
      url: "https://example.test/v1",
      api: "A_KEY",
      model: "",
    });
    expect(next.entries[1]).toEqual({
      id: "m2",
      name: "Haiku",
      url: "https://example.test/v1",
      api: "A_KEY",
      model: "",
    });
    // The other note is the object it was — the whole document goes over the wire, so the one thing
    // that must not happen is the rest of it changing on the way.
    expect(next.entries[0]).toBe(state.models[0]);
    expect(next.roles).toBe(state.roles);
  });

  test("a commit cannot move the id, whatever it carries", () => {
    // The id is the one field that is not a box: it is the provider id in the rendered config and
    // the string every role assignment names, so a note that arrived claiming another one would
    // rename a provider out from under the roles pointing at it.
    const state = held([model("m1", "Sonnet")], { build: "m1" });
    const next = updatedModel(state, "m1", { ...model("hijacked"), name: "Renamed" });
    expect(next.entries[0]).toEqual({
      id: "m1",
      name: "Renamed",
      url: "",
      api: "",
      model: "",
    });
    expect(next.roles).toEqual({ build: "m1" });
  });

  test("deleting a model empties every role that named it, in the same document", () => {
    // The route validates what it is given as a whole and refuses a role pointing at a model that
    // is not there — so the shorter entry list on its own would be refused outright, and two
    // requests would leave a window in which the stored pool is exactly what the route rejects.
    const state = held([model("m1"), model("m2")], { build: "m1", plan: "m1", general: "m2" });
    const next = removedModel(state, "m1");
    expect(next.entries.map((entry) => entry.id)).toEqual(["m2"]);
    expect(next.roles).toEqual({ general: "m2" });
  });

  test("a deletion does not re-home the roles it emptied", () => {
    // Deliberately: choosing what answers a turn is the reader's, and if the emptied role is the
    // primary one the route refuses with a sentence they can act on. A silent substitution would
    // be this window deciding which model writes their reports.
    const state = held([model("m1"), model("m2")], { [PRIMARY_ROLE]: "m1" });
    expect(removedModel(state, "m1").roles).toEqual({});
  });

  test("assigning and clearing move one role and leave the entries alone", () => {
    const state = held([model("m1"), model("m2")], { build: "m1" });
    const assigned = assignedRole(state, "explore", "m2");
    expect(assigned.roles).toEqual({ build: "m1", explore: "m2" });
    expect(assigned.entries).toBe(state.models);

    const cleared = clearedRole(landPool(state, pool([...assigned.entries], assigned.roles)), "explore");
    // Absent rather than null: the window and the server both read "not assigned" the same way, and
    // a null would be a third state neither of them has a case for.
    expect(cleared.roles).toEqual({ build: "m1" });
    expect(Object.hasOwn(cleared.roles, "explore")).toBe(false);
  });
});

describe("the two things a reader is doing to the panel", () => {
  test("opening and closing the pool is one flag, written only when it moves", () => {
    const state = held([]);
    const open = setPoolOpen(state, true);
    expect(open.poolOpen).toBe(true);
    expect(setPoolOpen(open, true)).toBe(open);
    expect(setPoolOpen(open, false).poolOpen).toBe(false);
  });

  test("the hot slot lights, moves and goes out, and repeats cost nothing", () => {
    // This is written from a pointermove handler, so most calls say what the last one said: a new
    // state per move would redraw the whole row of slots sixty times a second for a drag that has
    // not left the slot it is over.
    const state = held([model("m1")]);
    expect(state.slotHot).toBeNull();

    const lit = setSlotHot(state, "plan");
    expect(lit.slotHot).toBe("plan");
    expect(setSlotHot(lit, "plan")).toBe(lit);

    const moved = setSlotHot(lit, "explore");
    expect(moved.slotHot).toBe("explore");

    // Let go, or the browser takes the gesture away: both put the light out, and the second is why
    // `ModelPool` takes over `onPointerCancel` — a slot left glowing is furniture lying about a
    // gesture that is over.
    const out = setSlotHot(moved, null);
    expect(out.slotHot).toBeNull();
    expect(setSlotHot(out, null)).toBe(out);
    // Nothing else about the pool moved while a drag ran over it.
    expect(out.models).toBe(state.models);
    expect(out.roles).toBe(state.roles);
  });
});
