/**
 * The record panel's stack, driven by clicks and answers.
 *
 * The reducer alone — no store, no fetch, no DOM — which is what lets the sequences that decide
 * whether this panel is usable be written down rather than described. All of them come from the same
 * property: the panel holds SEVERAL records, read independently, answering in whatever order the
 * network hands them back — where a panel holding one record could only ever get an answer about the
 * thing on screen. The card that was closed while its request was out, the card read twice
 * whose first answer arrives second, the card closed and reopened in between — those are the three
 * that put the wrong record under somebody's editor, and each of them is a test below.
 *
 * The other property asserted throughout is STABILITY: the reader is typing somewhere on this stack
 * while a report finishes and five refreshes land, and nothing about any of that is allowed to move
 * the card under their cursor.
 *
 * ONE KIND OF CARD, AND THIS FILE USED TO ARGUE FOR FOUR. Three of them were blank forms — the one
 * that made a folder, the one that recorded an information source, the one that wrote a set of
 * instructions — and the suites that pinned them are gone with them: a form's key never colliding
 * with a record's, two folders each holding their own blank draft, a second `+` focusing the box
 * already being typed into rather than emptying it. Nothing in this window writes to the database any more, so
 * there is no half-filled thing for this panel to hold. A record is opened, corrected, renamed and
 * thrown away by asking for it in the conversation; what is left here is the panel's original job,
 * which is READING one, and every test below is about a reading.
 *
 * WHAT THAT LEAVES IS NOT LESS BUT NARROWER. Every field on a card is now an answer about the row it
 * shows — `detail`, `loading`, `error` — where a form carried all three at rest forever because the
 * panel walked one list. The orderings are the same orderings, and they are the whole file.
 */

import { describe, expect, test } from "bun:test";

import type { RecordDetail, RecordTable } from "../web/src/lib/records.ts";
import type { Card, CardsState } from "../web/src/state/cards.ts";
import * as cards from "../web/src/state/cards.ts";
import {
  beginRead,
  bumpNonce,
  cardAt,
  cardKey,
  cardStack,
  closeCard,
  createCardsState,
  failRead,
  focus,
  isOpen,
  landDetail,
  newToken,
  openCard,
} from "../web/src/state/cards.ts";

/** A record card as the four doors into the panel build one: a row in the graph, a mention pill, a
 * report chip, an edge drawn inside another card. */
function record(table: RecordTable, id: string, label = id): Card {
  return { kind: "record", table, id, label };
}

/** A detail as the record API answers one. The edges are empty because nothing in this module reads
 * them — what is being asserted here is WHICH card an answer lands on, not what is in it. */
function detailOf(table: RecordTable, id: string, label = id): RecordDetail {
  return {
    card: { table, id, name: `${table}-${id}`, label },
    row: { id },
    referents: [],
    referrers: [],
  };
}

/** The stack, top to bottom, as the panel would draw it. */
function keys(state: CardsState): string[] {
  return cardStack(state).map((held) => held.key);
}

const THESIS = record("thesis", "t1", "TSMC is undervalued");
const REPORT = record("report", "r1", "TSMC Q3");
const SOURCE = record("information_source", "s1", "TSMC investor relations");

describe("what a card is called", () => {
  test("a record is named by its table and its id", () => {
    // Table first, because an id is unique inside a table and nowhere else: `report:1` and
    // `recipe:1` would be two records and must be two cards.
    expect(cardKey(THESIS)).toBe("record:thesis:t1");
    expect(cardKey(record("recipe", "t1"))).toBe("record:recipe:t1");
    expect(cardKey(record("thesis", "t1", "renamed since"))).toBe("record:thesis:t1");
  });

  test("every key this module mints is a reading, because there is nothing else to open", () => {
    // THE COLLAPSE, PINNED FROM BOTH SIDES. There was a second grammar here — `create:workshop`,
    // `create:source`, `create:playbook:<workshop>` — kept disjoint from `record:` so that the store,
    // which addresses cards it did not just build, could never confuse a blank form with the row it
    // would have written. Both the forms and the routes behind them are gone, so the disjointness has
    // nothing left to protect and the two constants that spelled the singletons are not exported any
    // more. A `+` that opened a card again would have to argue with this.
    const surface: Record<string, unknown> = cards;
    for (const name of ["CREATE_WORKSHOP_KEY", "CREATE_SOURCE_KEY", "createPlaybookKey"]) {
      expect(surface[name]).toBeUndefined();
    }
    for (const card of [THESIS, REPORT, SOURCE, record("recipe", "rc1")]) {
      expect(cardKey(card).startsWith("record:")).toBe(true);
    }
  });

  test("an id that would need escaping in the graph needs none here", () => {
    // A `NodePath` is parsed — segment counts, prefix tests — so ids are percent-encoded into it. A
    // card key is a map key and nothing reads it back, so the id goes in as it is and two cards can
    // only collide by being the same record.
    expect(cardKey(record("report", "weekly/2026 q3"))).toBe("record:report:weekly/2026 q3");
  });
});

describe("opening a card", () => {
  test("cards stack in the order they were opened, newest at the bottom", () => {
    let state = openCard(createCardsState(), THESIS);
    state = openCard(state, REPORT);
    state = openCard(state, SOURCE);
    expect(keys(state)).toEqual(["record:thesis:t1", "record:report:r1", "record:information_source:s1"]);
    expect(state.focused).toBe("record:information_source:s1");
  });

  test("opening a record that is already open focuses it rather than stacking a second copy", () => {
    // The same report is reachable from its thesis, from a mention pill and from a chip, and the
    // graph deliberately draws it in as many places as there are routes to it. A record READ WHOLE is
    // one reading of one row, so the second gesture means "that one".
    let state = openCard(createCardsState(), THESIS);
    state = openCard(state, REPORT);
    const before = state;

    state = openCard(state, record("report", "r1", "TSMC Q3"));
    expect(keys(state)).toEqual(["record:thesis:t1", "record:report:r1"]);
    expect(state.focused).toBe("record:report:r1");
    // The held card is untouched — same entry, same place, same everything it had read.
    expect(state.cards.get("record:report:r1")).toBe(before.cards.get("record:report:r1"));
  });

  test("opening what is already open AND already focused returns the identical state", () => {
    // The one-mutation rule: a gesture that moved nothing must not mint a snapshot, or every open
    // editor on the stack re-renders because somebody clicked the card they were already looking at.
    const state = openCard(createCardsState(), THESIS);
    expect(openCard(state, THESIS)).toBe(state);
  });

  test("re-opening a card deeper in the stack does not move it to the bottom", () => {
    // The reader is mid-sentence in an editor on this stack. A panel that reordered on a click would
    // slide that editor down the screen; the focus is how the panel says which card it means.
    let state = openCard(createCardsState(), THESIS);
    state = openCard(state, REPORT);
    state = openCard(state, SOURCE);
    state = openCard(state, THESIS);
    expect(keys(state)).toEqual(["record:thesis:t1", "record:report:r1", "record:information_source:s1"]);
    expect(state.focused).toBe("record:thesis:t1");
  });

  test("a card arrives empty and not reading, so the store opens and asks in one breath", () => {
    const state = openCard(createCardsState(), THESIS);
    expect(cardAt(state, "record:thesis:t1")).toMatchObject({
      card: THESIS,
      detail: null,
      loading: false,
      error: null,
      nonce: 0,
    });
    expect(cardAt(state, "record:report:r1")).toBeNull();
    expect(isOpen(state, "record:thesis:t1")).toBe(true);
  });
});

describe("reading a card", () => {
  test("the stack does not move when an answer lands on it", () => {
    // Three cards open and the FIRST one answers last, which is the ordinary case: the panel is
    // drawn from the map's insertion order, and an entry that is overwritten keeps its place.
    let state = openCard(createCardsState(), THESIS);
    state = openCard(state, REPORT);
    state = openCard(state, SOURCE);

    const first = newToken();
    const third = newToken();
    state = beginRead(state, "record:thesis:t1", first);
    state = beginRead(state, "record:information_source:s1", third);
    state = landDetail(state, "record:information_source:s1", third, detailOf("information_source", "s1"));
    state = landDetail(state, "record:thesis:t1", first, detailOf("thesis", "t1"));

    expect(keys(state)).toEqual(["record:thesis:t1", "record:report:r1", "record:information_source:s1"]);
    expect(cardAt(state, "record:thesis:t1")?.detail?.card.id).toBe("t1");
    expect(cardAt(state, "record:information_source:s1")?.detail?.card.id).toBe("s1");
    // The card nobody read is exactly as it was opened.
    expect(cardAt(state, "record:report:r1")?.detail).toBeNull();
  });

  test("an answer to a superseded read is dropped", () => {
    // Press ↻ twice on a slow record. The second request is the one the reader is waiting for, and
    // the first answer — which may arrive after it — is about a state of the world nobody asked
    // about any more.
    let state = openCard(createCardsState(), THESIS);
    const first = newToken();
    state = beginRead(state, "record:thesis:t1", first);
    const second = newToken();
    state = beginRead(state, "record:thesis:t1", second);

    const stale = landDetail(state, "record:thesis:t1", first, detailOf("thesis", "t1", "the old title"));
    expect(stale).toBe(state);
    expect(cardAt(stale, "record:thesis:t1")?.loading).toBe(true);

    const landed = landDetail(state, "record:thesis:t1", second, detailOf("thesis", "t1", "the new title"));
    expect(cardAt(landed, "record:thesis:t1")?.detail?.card.label).toBe("the new title");
    expect(cardAt(landed, "record:thesis:t1")?.loading).toBe(false);
  });

  test("a refusal for a superseded read is dropped too", () => {
    // The same guard on the other answer, and it matters more: a read that failed while a second one
    // was already in flight would otherwise paint a refusal over a card that is about to be fine.
    let state = openCard(createCardsState(), THESIS);
    const first = newToken();
    state = beginRead(state, "record:thesis:t1", first);
    state = beginRead(state, "record:thesis:t1", newToken());
    expect(failRead(state, "record:thesis:t1", first, "no such record")).toBe(state);
  });

  test("an answer for a card that closed mid-flight is dropped, and reopening does not let it in", () => {
    // Closing a card does not cancel the request; the answer arrives regardless. Landing it would put
    // a card the reader deliberately closed back on the stack — and the reopened card must not
    // inherit it either, which is what the fresh token at open buys.
    let state = openCard(createCardsState(), REPORT);
    const token = newToken();
    state = beginRead(state, "record:report:r1", token);

    const closed = closeCard(state, "record:report:r1");
    expect(landDetail(closed, "record:report:r1", token, detailOf("report", "r1"))).toBe(closed);
    expect(failRead(closed, "record:report:r1", token, "gone")).toBe(closed);
    expect(isOpen(closed, "record:report:r1")).toBe(false);

    const reopened = openCard(closed, REPORT);
    expect(landDetail(reopened, "record:report:r1", token, detailOf("report", "r1"))).toBe(reopened);
    expect(cardAt(reopened, "record:report:r1")?.detail).toBeNull();
  });

  test("a read of a card that is not open changes nothing", () => {
    const state = openCard(createCardsState(), THESIS);
    expect(beginRead(state, "record:report:r1", newToken())).toBe(state);
  });

  test("a quiet refresh neither spins nor blanks what is on screen", () => {
    // The half-second refresh fires against every open record card whenever the database moves. A
    // spinner per card several times a minute is a panel nobody can read while the agent works, and
    // the detail in hand has to stay drawn until a better one replaces it.
    let state = openCard(createCardsState(), THESIS);
    const shown = newToken();
    state = beginRead(state, "record:thesis:t1", shown);
    state = landDetail(state, "record:thesis:t1", shown, detailOf("thesis", "t1", "as it stands"));

    const quiet = newToken();
    state = beginRead(state, "record:thesis:t1", quiet, "quiet");
    expect(cardAt(state, "record:thesis:t1")?.loading).toBe(false);
    expect(cardAt(state, "record:thesis:t1")?.detail?.card.label).toBe("as it stands");
  });

  test("a quiet refresh leaves a standing refusal standing", () => {
    // Clearing it would blank the sentence explaining an empty card and then write the same sentence
    // back half a second later, which reads as a panel flickering at a record that is simply gone.
    let state = openCard(createCardsState(), THESIS);
    const first = newToken();
    state = beginRead(state, "record:thesis:t1", first);
    state = failRead(state, "record:thesis:t1", first, "no thesis with that id");
    state = beginRead(state, "record:thesis:t1", newToken(), "quiet");
    expect(cardAt(state, "record:thesis:t1")?.error).toBe("no thesis with that id");
  });

  test("a read somebody asked for clears the refusal it is retrying", () => {
    let state = openCard(createCardsState(), THESIS);
    const first = newToken();
    state = beginRead(state, "record:thesis:t1", first);
    state = failRead(state, "record:thesis:t1", first, "no thesis with that id");
    state = beginRead(state, "record:thesis:t1", newToken());
    expect(cardAt(state, "record:thesis:t1")).toMatchObject({ loading: true, error: null });
  });

  test("a failed read keeps what the card was showing", () => {
    // Not drawn while the refusal stands, and there so that a retry which lands puts it back without
    // the card having gone blank in between.
    let state = openCard(createCardsState(), THESIS);
    const first = newToken();
    state = beginRead(state, "record:thesis:t1", first);
    state = landDetail(state, "record:thesis:t1", first, detailOf("thesis", "t1", "still readable"));
    const second = newToken();
    state = beginRead(state, "record:thesis:t1", second, "quiet");
    state = failRead(state, "record:thesis:t1", second, "the database is not answering");

    expect(cardAt(state, "record:thesis:t1")?.detail?.card.label).toBe("still readable");
    expect(cardAt(state, "record:thesis:t1")?.error).toBe("the database is not answering");
  });

  test("the same refusal arriving again returns the identical state", () => {
    // A record deleted out from under an open card fails identically twice a second for as long as
    // the card is left open. A new snapshot per failure would redraw the whole stack that whole time.
    let state = openCard(createCardsState(), THESIS);
    const first = newToken();
    state = beginRead(state, "record:thesis:t1", first);
    state = failRead(state, "record:thesis:t1", first, "no thesis with that id");

    const second = newToken();
    const again = beginRead(state, "record:thesis:t1", second, "quiet");
    expect(failRead(again, "record:thesis:t1", second, "no thesis with that id")).toBe(again);
  });
});

describe("the report nonce", () => {
  test("each card counts its own republishes", () => {
    // Two reports can be open at once and only one of them was just rewritten. A nonce on the panel
    // would remount both iframes and lose the reader's place in the document nobody touched.
    let state = openCard(createCardsState(), REPORT);
    state = openCard(state, record("report", "r2", "TSMC Q4"));
    state = bumpNonce(state, "record:report:r1");
    state = bumpNonce(state, "record:report:r1");

    expect(cardAt(state, "record:report:r1")?.nonce).toBe(2);
    expect(cardAt(state, "record:report:r2")?.nonce).toBe(0);
    expect(keys(state)).toEqual(["record:report:r1", "record:report:r2"]);
  });

  test("a bump does not disturb the read the card is waiting for", () => {
    // The guard is a token per card and NOT the card's own identity, for exactly this: republishing a
    // report while its record is being reread must not cancel the reread.
    let state = openCard(createCardsState(), REPORT);
    const token = newToken();
    state = beginRead(state, "record:report:r1", token);
    state = bumpNonce(state, "record:report:r1");
    state = landDetail(state, "record:report:r1", token, detailOf("report", "r1"));
    expect(cardAt(state, "record:report:r1")?.detail?.card.id).toBe("r1");
    expect(cardAt(state, "record:report:r1")?.nonce).toBe(1);
  });

  test("a bump for a report nobody has open changes nothing", () => {
    const state = openCard(createCardsState(), THESIS);
    expect(bumpNonce(state, "record:report:r1")).toBe(state);
  });
});

describe("closing and focusing", () => {
  test("closing the focused card clears the focus rather than sliding it sideways", () => {
    // Moving it to a neighbour would scroll the panel to a card nobody asked about and mark it as
    // what the last gesture was about. The last gesture was a close.
    let state = openCard(createCardsState(), THESIS);
    state = openCard(state, REPORT);
    expect(state.focused).toBe("record:report:r1");

    state = closeCard(state, "record:report:r1");
    expect(state.focused).toBeNull();
    expect(keys(state)).toEqual(["record:thesis:t1"]);
  });

  test("closing another card leaves the focus where it is", () => {
    let state = openCard(createCardsState(), THESIS);
    state = openCard(state, REPORT);
    state = focus(state, "record:thesis:t1");
    state = closeCard(state, "record:report:r1");
    expect(state.focused).toBe("record:thesis:t1");
  });

  test("closing a card that is not open changes nothing", () => {
    const state = openCard(createCardsState(), THESIS);
    expect(closeCard(state, "record:report:r1")).toBe(state);
    const empty = createCardsState();
    expect(closeCard(empty, "record:thesis:t1")).toBe(empty);
  });

  test("focusing a card that closed while its answer was in flight is ignored", () => {
    // The store focuses a card when the gesture that opened it finishes. If the reader closed it in
    // the meantime, storing the focus would point the panel at a card it cannot draw.
    let state = openCard(createCardsState(), THESIS);
    state = openCard(state, REPORT);
    state = closeCard(state, "record:report:r1");
    expect(focus(state, "record:report:r1")).toBe(state);
    expect(state.focused).toBeNull();
  });

  test("focusing what is already focused returns the identical state", () => {
    const state = openCard(createCardsState(), THESIS);
    expect(focus(state, "record:thesis:t1")).toBe(state);
    const empty = createCardsState();
    expect(focus(empty, null)).toBe(empty);
  });

  test("the focus can be given up without closing anything", () => {
    let state = openCard(createCardsState(), THESIS);
    state = focus(state, null);
    expect(state.focused).toBeNull();
    expect(keys(state)).toEqual(["record:thesis:t1"]);
  });
});

describe("the stack the `+` buttons no longer reach", () => {
  test("every entry on the stack is a reading, whatever opened it", () => {
    // What is left after the forms. A specification, a report and an information source were the
    // rows this window used to WRITE or to launch, and each had a blank card of its own on this
    // stack; all of them are ordinary records now, opened to be read like the ones that were never
    // the reader's to write. One kind of entry means nothing on a card that is not an answer about
    // the row it is showing — which is what the suite below this one is checking about all of them.
    let state = openCard(createCardsState(), record("recipe", "rc1", "semis"));
    state = openCard(state, record("report", "r7", "rp-quiet-hare"));
    state = openCard(state, SOURCE);

    expect(keys(state)).toEqual([
      "record:recipe:rc1",
      "record:report:r7",
      "record:information_source:s1",
    ]);
    for (const held of cardStack(state)) {
      expect(held.card.kind).toBe("record");
      expect(held).toMatchObject({ detail: null, loading: false, error: null, nonce: 0 });
    }
  });

  test("a recipe opened twice is one card, as it always was and now always is", () => {
    // THE GESTURE THAT MOVED, PINNED WHERE IT USED TO LAND. The `+` that raised a set of instructions
    // opened the OPERATIVE version — a record card holding a row that already existed — so pressing
    // "add" produced something already there; then it opened a blank form on a key that could never
    // collide with a record's. It opens nothing now: it sends a sentence (`lib/awareness.ts`) and
    // the card that eventually appears is whatever the agent wrote, opened by name like any other
    // row. So the only way a recipe reaches this stack is as a reading, and reaching it twice is the
    // ordinary dedupe rather than a second grammar's problem.
    const recipe = record("recipe", "rc7", "rc-quiet-hare");
    let state = openCard(createCardsState(), recipe);
    state = openCard(state, REPORT);
    const before = state.cards.get("record:recipe:rc7");

    state = openCard(state, record("recipe", "rc7", "rc-quiet-hare"));
    expect(keys(state)).toEqual(["record:recipe:rc7", "record:report:r1"]);
    expect(state.focused).toBe("record:recipe:rc7");
    expect(state.cards.get("record:recipe:rc7")).toBe(before);
  });
});
