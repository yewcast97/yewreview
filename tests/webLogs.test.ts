/**
 * The log read-out's ledgers, driven by answers and pokes.
 *
 * The reducer alone — no store, no fetch, no DOM — because the sequences that decide whether this
 * panel can be trusted are all about ARRIVAL ORDER, and none of them are reproducible by clicking. An
 * error is logged while the reader is three pages back through the deletions; a refetch of the newest
 * fifty overlaps forty-nine rows that are already on screen; the server prunes past the cap between
 * two requests. Each of those is a sequence of two or three calls below.
 *
 * The other property asserted throughout is STABILITY. Both ledgers are refetched on every poke and
 * the agent pokes constantly, so the common case is an answer that says exactly what the window
 * already had — and the window is a list of rows somebody is reading. A landing that minted a new
 * state anyway would redraw both sections several times a minute, forever.
 */

import { describe, expect, test } from "bun:test";

import type { DeletionLogEntry, ErrorLogEntry } from "../web/src/lib/protocol.ts";
import type { LogAnswer, LogsState } from "../web/src/state/logs.ts";
import {
  appendOlder,
  beginPage,
  createLogsState,
  deletedName,
  failPage,
  groupDeletions,
  landHead,
  noteLogged,
  setLogView,
} from "../web/src/state/logs.ts";

/** An error row as `/api/logs?category=errors` answers one. The message is the server's sentence and
 * is never reworded — house rule — so the fixture makes it identifiable rather than pretty. */
function err(id: number, message = `refused ${id}`): ErrorLogEntry {
  return { id, at: 1_700_000_000_000 + id, scope: "tool", message, detail: null };
}

/** A deletion row. `row_json` is the whole deleted record; nothing here reads it, so it is the
 * smallest document that is still valid JSON. */
function gone(id: number, table: string): DeletionLogEntry {
  return {
    id,
    at: 1_700_000_000_000 + id,
    table_name: table,
    row_id: `${table}-${id}`,
    row_json: `{"id":"${table}-${id}"}`,
  };
}

/** What one keyset request came back with. `hasMore` defaults to the honest answer for a short page:
 * there is nothing below it. */
function answer(entries: readonly (ErrorLogEntry | DeletionLogEntry)[], hasMore = false): LogAnswer {
  return { entries, hasMore };
}

/** The ids the errors section would draw, top to bottom. */
function errorIds(state: LogsState): number[] {
  return state.errors.entries.map((entry) => entry.id);
}

describe("landing the newest page", () => {
  test("the head is held newest-first whatever order it arrived in", () => {
    // The route sorts by `id DESC` and this module sorts again — not from suspicion, but because the
    // order is a property of the list rather than of whoever filled it, and the merge below needs one
    // total order it can rely on.
    const state = landHead(createLogsState(), "errors", answer([err(7), err(9), err(8)]));
    expect(errorIds(state)).toEqual([9, 8, 7]);
  });

  test("a refetch that overlaps what is already held stacks no second copy", () => {
    // This is the ordinary case, not the corner one: every `error_logged` poke refetches the newest
    // page, and the newest page is almost entirely rows the viewer is already showing.
    let state = landHead(createLogsState(), "errors", answer([err(3), err(2), err(1)], true));
    state = landHead(state, "errors", answer([err(4), err(3), err(2)], true));
    expect(errorIds(state)).toEqual([4, 3, 2, 1]);
  });

  test("a truncated head keeps the older pages held underneath it", () => {
    // `hasMore` is the whole content of the claim: this page is a window onto the newest rows and
    // says NOTHING about the ones below its edge, so the pages somebody scrolled back through stay.
    let state = landHead(createLogsState(), "errors", answer([err(9), err(8)], true));
    state = appendOlder(state, "errors", answer([err(7), err(6)], true));
    state = landHead(state, "errors", answer([err(10), err(9)], true));
    expect(errorIds(state)).toEqual([10, 9, 8, 7, 6]);
  });

  test("a complete head deletes what was held below it", () => {
    // The other half of the same doctrine. A page that says there is nothing more is a claim about
    // what EXISTS, and the ledger is capped: rows fall off the bottom, and a viewer left open would
    // otherwise show them for as long as nobody closed it.
    let state = landHead(createLogsState(), "errors", answer([err(9), err(8)], true));
    state = appendOlder(state, "errors", answer([err(7)], false));
    expect(errorIds(state)).toEqual([9, 8, 7]);

    state = landHead(state, "errors", answer([err(9), err(8)], false));
    expect(errorIds(state)).toEqual([9, 8]);
  });

  test("`hasMore` is whatever the newest answer said, in either direction", () => {
    let state = landHead(createLogsState(), "errors", answer([err(2), err(1)], true));
    expect(state.errors.hasMore).toBe(true);
    state = landHead(state, "errors", answer([err(2), err(1)], false));
    expect(state.errors.hasMore).toBe(false);
    state = landHead(state, "errors", answer([err(2), err(1)], true));
    expect(state.errors.hasMore).toBe(true);
  });

  test("landing the same rows again returns the identical state", () => {
    // The one-mutation rule. Several pokes a minute answer exactly this, and a new object for each of
    // them is the section re-rendering under the reader for as long as the agent is working.
    const state = landHead(createLogsState(), "errors", answer([err(2), err(1)]));
    expect(landHead(state, "errors", answer([err(2), err(1)]))).toBe(state);
    // Including the very first landing, when the answer is as empty as the state already is.
    const blank = createLogsState();
    expect(landHead(blank, "errors", answer([]))).toBe(blank);
  });

  test("one category's answer never touches the other", () => {
    const before = landHead(createLogsState(), "deletions", answer([gone(1, "thesis")]));
    const after = landHead(before, "errors", answer([err(5)]));
    expect(after.deletions).toBe(before.deletions);
    expect(after.errors.entries).toHaveLength(1);
  });
});

describe("paging backwards", () => {
  test("show more takes only rows older than the oldest held", () => {
    // The request is keyset — `before` is the oldest id in hand — so an overlap means rows were
    // written between the two requests. Those belong to the head, and the head is refetched by the
    // frame that announced them.
    let state = landHead(createLogsState(), "errors", answer([err(9), err(8)], true));
    state = appendOlder(state, "errors", answer([err(9), err(7), err(6)], true));
    expect(errorIds(state)).toEqual([9, 8, 7, 6]);
  });

  test("a page repeating what is already held adds nothing and returns the identical state", () => {
    let state = landHead(createLogsState(), "errors", answer([err(9), err(8)], true));
    const before = state;
    state = appendOlder(state, "errors", answer([err(9), err(8)], true));
    expect(state).toBe(before);
  });

  test("the first page can be appended into an empty ledger", () => {
    // There is no oldest id to be older than, so nothing is filtered out. The store never does this —
    // it lands a head first — but a function whose behaviour on an empty list is undefined is a
    // function waiting for the one caller that gets the order wrong.
    const state = appendOlder(createLogsState(), "errors", answer([err(3), err(2)], true));
    expect(errorIds(state)).toEqual([3, 2]);
    expect(state.errors.hasMore).toBe(true);
  });

  test("the end of the ledger is recorded even when the page it came with is empty", () => {
    let state = landHead(createLogsState(), "errors", answer([err(2), err(1)], true));
    state = appendOlder(state, "errors", answer([], false));
    expect(errorIds(state)).toEqual([2, 1]);
    expect(state.errors.hasMore).toBe(false);
  });
});

describe("a read in flight, and one that failed", () => {
  test("a read leaves the rows on screen and clears the sentence explaining the last failure", () => {
    let state = landHead(createLogsState(), "errors", answer([err(1)]));
    state = failPage(state, "errors", "The log could not be read.");
    state = beginPage(state, "errors");
    expect(state.errors.loading).toBe(true);
    expect(state.errors.error).toBeNull();
    expect(errorIds(state)).toEqual([1]);
  });

  test("beginning a read that is already happening returns the identical state", () => {
    const state = beginPage(createLogsState(), "errors");
    expect(beginPage(state, "errors")).toBe(state);
  });

  test("a failure keeps what was already read", () => {
    // A log that cannot be refreshed is still a true log of what was there a moment ago, and the
    // rows are the only reason the panel is open.
    let state = landHead(createLogsState(), "deletions", answer([gone(1, "report")]));
    state = failPage(state, "deletions", "offline");
    expect(state.deletions.entries).toHaveLength(1);
    expect(state.deletions.error).toBe("offline");
    expect(state.deletions.loading).toBe(false);
  });

  test("the same refusal twice returns the identical state", () => {
    const state = failPage(createLogsState(), "errors", "offline");
    expect(failPage(state, "errors", "offline")).toBe(state);
    expect(failPage(state, "errors", "still offline")).not.toBe(state);
  });

  test("an answer that lands clears the failure it landed on", () => {
    let state = failPage(createLogsState(), "errors", "offline");
    state = landHead(state, "errors", answer([err(1)]));
    expect(state.errors.error).toBeNull();
    expect(state.errors.loading).toBe(false);
  });
});

describe("what a poke means", () => {
  test("a logged error bumps the error nonce and nothing else", () => {
    // The frames are bodyless: the server says something happened and nothing about what. Two
    // counters rather than one because a deletion must not make the error section look stale — the
    // mark would stop meaning anything within a minute of the agent starting work.
    const before = landHead(createLogsState(), "deletions", answer([gone(1, "thesis")]));
    const after = noteLogged(before, "errors");
    expect(after.errorsNonce).toBe(before.errorsNonce + 1);
    expect(after.deletionsNonce).toBe(before.deletionsNonce);
    expect(after.deletions).toBe(before.deletions);
    expect(after.errors).toBe(before.errors);
  });

  test("a logged deletion bumps the deletion nonce and nothing else", () => {
    const before = createLogsState();
    const after = noteLogged(before, "deletions");
    expect(after.deletionsNonce).toBe(1);
    expect(after.errorsNonce).toBe(0);
  });

  test("a poke counts while neither viewer is open", () => {
    // The whole point of the counter: the chip in the corner has to be able to say there is
    // something new without its panel being open and without a fetch.
    const state = noteLogged(noteLogged(createLogsState(), "errors"), "errors");
    expect(state.view).toBe(null);
    expect(state.errorsNonce).toBe(2);
  });

  test("a poke about one ledger says nothing about the other's chip", () => {
    // Two counters rather than one, so a deletion cannot light the Log chip. Without this the mark
    // stops meaning anything within a minute of the agent starting work.
    const state = noteLogged(noteLogged(createLogsState(), "deletions"), "deletions");
    expect(state.deletionsNonce).toBe(2);
    expect(state.errorsNonce).toBe(0);
  });
});

describe("which ledger is on screen", () => {
  test("the pages survive a close", () => {
    // Closing is a fact about the screen. A reader who closes a ledger and opens it again is not
    // asking to re-read a thousand rows.
    let state = landHead(createLogsState(), "errors", answer([err(1)]));
    state = setLogView(state, "errors");
    const open = state;
    state = setLogView(state, null);
    expect(state.view).toBe(null);
    expect(state.errors).toBe(open.errors);
  });

  test("setting the view it already has changes nothing", () => {
    const state = createLogsState();
    expect(setLogView(state, null)).toBe(state);
    expect(setLogView(state, "errors")).not.toBe(state);
  });

  test("one slot, so opening one ledger closes the other", () => {
    // Not a rule either unit keeps: these are instruments glanced at singly, and one slot is what
    // makes opening one expand while the other collapses, in the same write.
    const state = setLogView(setLogView(createLogsState(), "errors"), "deletions");
    expect(state.view).toBe("deletions");
  });

  test("the session list shares the slot, so opening it puts an open ledger away", () => {
    // The third instrument in the corner. It borrowed the slot, not the machinery — no page moves
    // in either direction — so the assertions are the slot's and the ledgers' rows are untouched.
    let state = landHead(createLogsState(), "errors", answer([err(1)]));
    const before = state;
    state = setLogView(setLogView(state, "errors"), "sessions");
    expect(state.view).toBe("sessions");
    expect(state.errors).toBe(before.errors);
    state = setLogView(state, "errors");
    expect(state.view).toBe("errors");
  });

  test("switching between them disturbs neither ledger's rows", () => {
    // The chips share a slot, not a page. A reader comparing an error against the deletion it caused
    // switches back and forth, and re-reading a thousand rows each way would be unusable.
    let state = landHead(createLogsState(), "errors", answer([err(1)]));
    state = landHead(state, "deletions", answer([gone(2, "thesis")]));
    const before = state;
    state = setLogView(setLogView(setLogView(state, "errors"), "deletions"), "errors");
    expect(state.errors).toBe(before.errors);
    expect(state.deletions).toBe(before.deletions);
  });
});

describe("the deletion ledger, grouped by table", () => {
  test("rows are gathered under the table they came out of", () => {
    const groups = groupDeletions([
      gone(9, "thesis"),
      gone(8, "thesis_assessment"),
      gone(7, "thesis_assessment"),
      gone(6, "thesis"),
    ]);
    expect(groups.map((group) => group.table)).toEqual(["thesis", "thesis_assessment"]);
    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual([9, 6]);
    expect(groups[1]?.entries.map((entry) => entry.id)).toEqual([8, 7]);
  });

  test("the group order is the order the newest row of each table arrived in", () => {
    // Which falls out of the walk rather than being sorted for: entries arrive newest-first, a group
    // is created the first time its table is seen, and the table something was just deleted from is
    // where somebody who watched it happen will look.
    const groups = groupDeletions([gone(5, "report"), gone(4, "script"), gone(3, "report")]);
    expect(groups.map((group) => group.table)).toEqual(["report", "script"]);
  });

  test("nothing deleted is no groups at all", () => {
    expect(groupDeletions([])).toEqual([]);
  });

  test("a table this schema does not have is still named", () => {
    // The log has NO foreign keys — its rows outlive the tables they describe, which is the entire
    // point of writing them down — so `table_name` is a plain string and this function must not be
    // able to fail to name one.
    const groups = groupDeletions([gone(1, "message")]);
    expect(groups[0]?.table).toBe("message");
  });
});

describe("what a destroyed record was called", () => {
  /** A ledger row for a record that had a name while it lived. */
  function named(name: string): DeletionLogEntry {
    return {
      id: 1,
      at: 1_700_000_000_000,
      table_name: "thesis",
      row_id: "9f2c8a4e3b1d4e5f8a7b6c5d4e3f2a1b",
      row_json: JSON.stringify({ id: "9f2c8a4e3b1d4e5f8a7b6c5d4e3f2a1b", name }),
    };
  }

  test("the name it wore, out of the row the ledger kept", () => {
    // The whole row is stored, so the one thing a reader can recognise is sitting right there. A
    // uuid is the same length and shape as every other row's and identifies nothing to a person.
    expect(deletedName(named("semis-inventory-glut"))).toBe("semis-inventory-glut");
  });

  test("a row that never had one falls back to its id", () => {
    // Written before the naming scheme, or out of a table this schema does not speak. The id is
    // then the only surviving identity, and answering "unnamed" would destroy the record twice.
    expect(deletedName(gone(4, "message"))).toBe("message-4");
  });

  test("an empty name is not a name", () => {
    const entry = named("");
    expect(deletedName(entry)).toBe(entry.row_id);
  });

  test("unparseable bytes fall back to the id rather than throwing", () => {
    // The database has a `json_valid` check on that column, so bytes that will not parse mean
    // something upstream is wrong — and this read-out must still draw the row rather than break.
    const entry = { ...gone(7, "report"), row_json: "{not json" };
    expect(deletedName(entry)).toBe("report-7");
  });

  test("a row_json that is not an object is not searched for a name", () => {
    for (const json of ["[1,2,3]", '"a string"', "null", "12"]) {
      expect(deletedName({ ...gone(2, "script"), row_json: json })).toBe("script-2");
    }
  });
});
