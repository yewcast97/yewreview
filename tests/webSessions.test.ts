/**
 * The session list, driven by the answers the window keeps refetching.
 *
 * The reducer alone — no store, no fetch, no DOM. There is not much to this module and the tests are
 * mostly about the two things that are: an ORDER the panel is never allowed to redecide, and an
 * identity discipline that has to hold under a refresh that fires several times a turn.
 *
 * The second is the one worth writing down. `sessions_changed`, `ready`, `turn_result` and the events
 * socket's reconnect all refetch this list, and almost none of those refreshes change anything a
 * person can see — a summary is written once and then stays. Meanwhile the list is a column of
 * clickable rows somebody is aiming at. So the assertions below are as much about what does NOT
 * happen as about what does.
 */

import { describe, expect, test } from "bun:test";

import type { SessionCard } from "../web/src/lib/protocol.ts";
import type { SessionsState } from "../web/src/state/sessions.ts";
import {
  beginLoad,
  createSessionsState,
  failLoad,
  landSessions,
} from "../web/src/state/sessions.ts";

/** A session as `GET /api/sessions` answers one. `createdAt` is null for the live session the server
 * synthesises before the SDK has flushed anything to disk; everything else is read off the store. */
function card(sessionId: string, lastModified: number, summary = sessionId, live = false): SessionCard {
  return { sessionId, summary, createdAt: lastModified - 1_000, lastModified, live };
}

/** The rows the panel would draw, top to bottom. */
function ids(state: SessionsState): string[] {
  return state.list.map((session) => session.sessionId);
}

describe("the order the list is held in", () => {
  test("the most recently touched conversation is first", () => {
    const state = landSessions(createSessionsState(), [
      card("older", 100),
      card("newest", 300),
      card("middle", 200),
    ]);
    expect(ids(state)).toEqual(["newest", "middle", "older"]);
  });

  test("the live conversation is pinned above all of them, however old its timestamp", () => {
    // It is the conversation on screen, and it also has the least reliable `lastModified` of any of
    // them: the SDK flushes its JSONL on its own cadence, and the server SYNTHESISES a row for a
    // session it has not seen on disk yet. Sorting it with the rest would let the row the reader is
    // talking in drift down the list mid-turn on the strength of a timestamp nobody promised.
    const state = landSessions(createSessionsState(), [
      card("fresh", 900),
      card("live", 100, "live", true),
      card("stale", 500),
    ]);
    expect(ids(state)).toEqual(["live", "fresh", "stale"]);
  });

  test("two sessions flushed in the same millisecond cannot swap places between refreshes", () => {
    // Without a tie-break the two orders are equally valid and the sort may hand back either, which
    // is a row moving under the pointer for no reason a reader could ever discover.
    const first = landSessions(createSessionsState(), [card("b", 500), card("a", 500)]);
    const second = landSessions(createSessionsState(), [card("a", 500), card("b", 500)]);
    expect(ids(first)).toEqual(["a", "b"]);
    expect(ids(second)).toEqual(["a", "b"]);
  });

  test("a session the server no longer names is gone", () => {
    // This route lists a directory rather than a page of one — there is no `hasMore` to hedge with —
    // so its answer is the complete list and absence means absence.
    let state = landSessions(createSessionsState(), [card("a", 200), card("b", 100)]);
    state = landSessions(state, [card("a", 200)]);
    expect(ids(state)).toEqual(["a"]);
  });
});

describe("what a refresh is allowed to move", () => {
  test("an answer that says what the window already had returns the identical state", () => {
    const state = landSessions(createSessionsState(), [card("a", 200), card("b", 100)]);
    expect(landSessions(state, [card("a", 200), card("b", 100)])).toBe(state);
    // And the same answer arriving in a different order is still the same answer.
    expect(landSessions(state, [card("b", 100), card("a", 200)])).toBe(state);
  });

  test("a rename hands the panel one new row and leaves the others exactly as they were", () => {
    const before = landSessions(createSessionsState(), [
      card("a", 300),
      card("b", 200),
      card("c", 100),
    ]);
    const after = landSessions(before, [
      card("a", 300),
      card("b", 200, "TSMC capacity, revisited"),
      card("c", 100),
    ]);
    expect(after).not.toBe(before);
    expect(after.list[0]).toBe(before.list[0]);
    expect(after.list[2]).toBe(before.list[2]);
    expect(after.list[1]).not.toBe(before.list[1]);
    expect(after.list[1]?.summary).toBe("TSMC capacity, revisited");
  });

  test("a session that stopped being the live one is a new row", () => {
    // `live` is the marker, the pin and the meaning of a click on that row, so a session that lost
    // it has changed in every way the panel cares about.
    const before = landSessions(createSessionsState(), [card("a", 200, "a", true), card("b", 100)]);
    const after = landSessions(before, [card("a", 200), card("b", 100, "b", true)]);
    expect(ids(after)).toEqual(["b", "a"]);
    expect(after.list[1]).not.toBe(before.list[0]);
  });

  test("an answer that only reorders the list keeps every row object", () => {
    const before = landSessions(createSessionsState(), [card("a", 300), card("b", 200)]);
    const after = landSessions(before, [card("a", 300), card("b", 400)]);
    expect(ids(after)).toEqual(["b", "a"]);
    expect(after.list[1]).toBe(before.list[0]);
  });
});

describe("a read in flight, and one that failed", () => {
  test("a read leaves the rows on screen and clears the last failure", () => {
    let state = landSessions(createSessionsState(), [card("a", 100)]);
    state = failLoad(state, "offline");
    state = beginLoad(state);
    expect(state.loading).toBe(true);
    expect(state.error).toBeNull();
    expect(ids(state)).toEqual(["a"]);
  });

  test("beginning a read that is already happening returns the identical state", () => {
    const state = beginLoad(createSessionsState());
    expect(beginLoad(state)).toBe(state);
  });

  test("a failure keeps the sessions it already knew about", () => {
    // The list is the only way back into a conversation, and a server that cannot be reached is the
    // worst possible moment to take that away.
    let state = landSessions(createSessionsState(), [card("a", 100)]);
    state = failLoad(state, "The session list could not be read.");
    expect(ids(state)).toEqual(["a"]);
    expect(state.error).toBe("The session list could not be read.");
    expect(state.loading).toBe(false);
  });

  test("the same refusal twice returns the identical state", () => {
    const state = failLoad(createSessionsState(), "offline");
    expect(failLoad(state, "offline")).toBe(state);
    expect(failLoad(state, "still offline")).not.toBe(state);
  });

  test("a landing settles the read it answers even when the rows are unchanged", () => {
    // The identity rule is about rows moving, not about a spinner that must stay up: a list that
    // answered has stopped loading, and that is a change the panel has to see.
    const held = landSessions(createSessionsState(), [card("a", 100)]);
    const reading = beginLoad(held);
    const settled = landSessions(reading, [card("a", 100)]);
    expect(settled).not.toBe(reading);
    expect(settled.loading).toBe(false);
    expect(settled.list).toBe(held.list);
  });
});
