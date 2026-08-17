/**
 * Where the open notes sit on the board, and which of them is in front.
 *
 * Pure arithmetic over a viewport, which is why it is testable at all: a note's place is decided in
 * `state/notes.ts` rather than by a layout, so the cases that are miserable to stage in a browser —
 * a note dragged off the bottom of a laptop, six notes on a viewport that halves, a cascade with
 * only half a narrow window to run down — are assertions here instead of things somebody once
 * checked by hand.
 *
 * Two properties every test below is really about. A NOTE IS ALWAYS REACHABLE: the head is the only
 * handle it has and the only place its close magnet lives, so a rectangle that put that head off the
 * glass would be a record nobody can put away. And NOTHING MOVES THAT WAS NOT MOVED: every function
 * hands back the state it was given when it changed nothing, and the untouched notes keep their
 * place objects, because the component subscribes per note and identity is what stops a drag from
 * redrawing five open editors sixty times a second.
 */

import { describe, expect, test } from "bun:test";

import type { Box } from "../web/src/state/chatDock.ts";
import type { NotesState } from "../web/src/state/notes.ts";
import {
  NOTE_W,
  clampNotes,
  createNotesState,
  dragNoteLeft,
  dragNoteRight,
  dragNoteSize,
  dragNoteSizeLeft,
  dropNote,
  moveNote,
  noteDeckle,
  overRect,
  placeAt,
  placeNote,
  raiseNote,
  scaleNotes,
  sizeNote,
  sizeNoteAt,
  spawnPoint,
} from "../web/src/state/notes.ts";

/**
 * A comfortable laptop, with the conversation dock's left edge where `dockRect` puts it AT THE
 * DEFAULT SPLIT — the midline, which is where a window opens rather than where it has to stay. The
 * board is everything to the left of that, and the cascade lives on it.
 */
const WIDE: Box = { width: 1440, height: 900 };
const DOCK_LEFT = 1440 / 2;

/** Put `n` notes up in a row, the way the store does when somebody opens several records. */
function board(n: number, viewport: Box = WIDE, dockLeft = DOCK_LEFT): NotesState {
  let state = createNotesState();
  for (let i = 0; i < n; i++) state = placeNote(state, `record:thesis:${i}`, viewport, dockLeft);
  return state;
}

describe("where a note lands when it is first put up", () => {
  test("top-right of the BOARD's half, at the edge the reader's eye goes to", () => {
    // Muscle memory: a reader who has used this window before looks to the right for what they just
    // opened — but the right of the board is now the dock's left edge rather than the glass. 12 is
    // the float inset, 56 is that plus the board's tool corner.
    expect(spawnPoint(0, WIDE, DOCK_LEFT)).toEqual({ x: DOCK_LEFT - 12 - NOTE_W, y: 56 });
  });

  test("each one steps down and to the left of the one before it", () => {
    const first = spawnPoint(0, WIDE, DOCK_LEFT);
    const second = spawnPoint(1, WIDE, DOCK_LEFT);
    expect(second.x).toBeLessThan(first.x);
    expect(second.y).toBeGreaterThan(first.y);
  });

  test("the ladder wraps rather than walking off the board", () => {
    // Whatever the rung count works out to on this screen, the cascade must come back to its anchor
    // rather than marching into the corner instruments or onto the conversation.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const at = spawnPoint(i, WIDE, DOCK_LEFT);
      seen.add(`${at.x},${at.y}`);
      // The WHOLE note stays clear of the dock, not just its left edge: notes paint over the
      // conversation, so one that overlapped would arrive covering what was being read.
      expect(at.x + NOTE_W).toBeLessThanOrEqual(DOCK_LEFT - 12);
      expect(at.x).toBeGreaterThanOrEqual(12);
    }
    // It repeats, which is what "wraps" means — and it uses more than one rung on a laptop.
    expect(seen.size).toBeGreaterThan(1);
    expect(seen.size).toBeLessThan(200);
  });

  test("a viewport with no room for a second position still has room for a first", () => {
    // A window whose board half is narrower than a note: there is no room to step left at all, so
    // the ladder is one rung and the clamp is what keeps that one on the glass. The bound that runs
    // out first is horizontal now — a full-height dock leaves the cascade the whole height.
    const short: Box = { width: 700, height: 320 };
    const at = spawnPoint(3, short, 350);
    expect(at.y).toBeGreaterThanOrEqual(12);
    expect(at.y).toBeLessThanOrEqual(320 - 12 - 34);
  });

  test("a viewport narrower than a note pins it to the left margin", () => {
    const narrow: Box = { width: 320, height: 800 };
    expect(spawnPoint(0, narrow, 160).x).toBe(12);
  });
});

describe("putting a note up", () => {
  test("it is placed, and in front of everything already up", () => {
    const state = board(3);
    const first = placeAt(state, "record:thesis:0");
    const third = placeAt(state, "record:thesis:2");
    expect(first).not.toBeNull();
    expect(third!.z).toBeGreaterThan(first!.z);
  });

  test("putting up a note that is already up changes nothing at all", () => {
    // This pairs with `openCard`'s dedupe: opening a record that is open is somebody saying "that
    // one", and a note that jumped to the cascade's next slot would be the window moving the thing
    // they were pointing at. Raising it is a separate call.
    const state = board(2);
    expect(placeNote(state, "record:thesis:1", WIDE, DOCK_LEFT)).toBe(state);
  });

  test("the cascade counts what has been opened, not what is still open", () => {
    // Closing the last note and opening another must not drop the new one exactly where a note is
    // already sitting — which is what `placed.size` as the index would do.
    let state = board(2);
    const second = placeAt(state, "record:thesis:1")!;
    state = dropNote(state, "record:thesis:1");
    state = placeNote(state, "record:report:x", WIDE, DOCK_LEFT);
    const fresh = placeAt(state, "record:report:x")!;
    expect(placeAt(state, "record:thesis:0")).not.toBeNull();
    expect({ x: fresh.x, y: fresh.y }).not.toEqual({ x: second.x, y: second.y });
  });
});

describe("bringing a note to the front", () => {
  test("the raised note goes above the rest and nobody else's place object is replaced", () => {
    // Identity, not equality: the component subscribes per note, and renumbering the whole board on
    // every click would redraw every open editor on it.
    const state = board(3);
    const untouched = placeAt(state, "record:thesis:1");
    const next = raiseNote(state, "record:thesis:0");
    expect(placeAt(next, "record:thesis:0")!.z).toBeGreaterThan(placeAt(next, "record:thesis:2")!.z);
    expect(placeAt(next, "record:thesis:1")).toBe(untouched);
  });

  test("raising the note that is already in front is a no-op", () => {
    // This fires on every pointerdown anywhere in a note, including each keystroke into a form on
    // it, so the guard is what keeps typing from minting a state per character.
    const state = board(3);
    expect(raiseNote(state, "record:thesis:2")).toBe(state);
  });

  test("raising a note that is not up is a no-op", () => {
    const state = board(1);
    expect(raiseNote(state, "record:thesis:9")).toBe(state);
  });

  test("z only ever goes up, so an old note never overtakes a new one by accident", () => {
    let state = board(2);
    const before = placeAt(state, "record:thesis:1")!.z;
    state = raiseNote(state, "record:thesis:0");
    expect(placeAt(state, "record:thesis:1")!.z).toBe(before);
    expect(placeAt(state, "record:thesis:0")!.z).toBeGreaterThan(before);
  });
});

describe("moving a note", () => {
  const key = "record:thesis:0";

  test("it goes where it was put", () => {
    const state = moveNote(board(1), key, 300, 200, WIDE);
    expect(placeAt(state, key)).toMatchObject({ x: 300, y: 200 });
  });

  test("a head-sized strip stays on the glass at every edge", () => {
    // 96 of the head's width and 34 of its height: what is left of a note dragged as far as this
    // window will let it go, and the whole of what the reader needs to grab it back.
    const left = placeAt(moveNote(board(1), key, -9_000, 400, WIDE), key)!;
    expect(left.x + NOTE_W).toBe(12 + 96);

    const right = placeAt(moveNote(board(1), key, 9_000, 400, WIDE), key)!;
    expect(right.x).toBe(1440 - 12 - 96);

    const up = placeAt(moveNote(board(1), key, 400, -9_000, WIDE), key)!;
    expect(up.y).toBe(12);

    const down = placeAt(moveNote(board(1), key, 400, 9_000, WIDE), key)!;
    expect(down.y).toBe(900 - 12 - 34);
  });

  test("moving a note nowhere hands back the same state", () => {
    const state = board(1);
    const at = placeAt(state, key)!;
    expect(moveNote(state, key, at.x, at.y, WIDE)).toBe(state);
  });

  test("moving a note that is not up is a no-op", () => {
    const state = board(1);
    expect(moveNote(state, "record:thesis:9", 10, 10, WIDE)).toBe(state);
  });

  test("a move never changes which note is in front", () => {
    const state = board(2);
    const moved = moveNote(state, key, 40, 40, WIDE);
    expect(moved.nextZ).toBe(state.nextZ);
    expect(placeAt(moved, key)!.z).toBe(placeAt(state, key)!.z);
  });

  test("it lands on whole pixels", () => {
    const state = moveNote(board(1), key, 300.4, 200.6, WIDE);
    expect(placeAt(state, key)).toMatchObject({ x: 300, y: 201 });
  });
});

describe("sizing a note", () => {
  const key = "record:thesis:0";
  /** What the corner grip remembers at a press on a fresh note: the width off the pad, and a height
   * the component measured off the sheet because an unsized note has none of its own. */
  const press = { w: NOTE_W, h: 300, viewport: WIDE };

  test("a note is born at the pad's width, and as tall as what is on it", () => {
    const at = placeAt(board(1), key)!;
    expect(at.w).toBe(NOTE_W);
    // Null rather than a number: the sheet grows to its content until somebody says otherwise, and
    // there is no gesture back to this once they have.
    expect(at.h).toBeNull();
  });

  test("the corner goes where it is dragged", () => {
    expect(dragNoteSize(press, 120, 80)).toEqual({ w: NOTE_W + 120, h: 380 });
  });

  test("it stops at a head's worth of width and a head plus a body of height", () => {
    // 320 is what the head needs before the controls start eating the word that says what the note
    // is; 160 is the head plus enough body to see that there is one.
    expect(dragNoteSize(press, -9_000, -9_000)).toEqual({ w: 320, h: 160 });
  });

  test("it stops at the glass it is on", () => {
    // As large as the window less its margins, because a note bigger than the screen is one whose
    // corner cannot be reached to make it smaller again.
    expect(dragNoteSize(press, 9_000, 9_000)).toEqual({ w: 1440 - 24, h: 900 - 24 });
  });

  test("a viewport smaller than the floor overhangs rather than collapsing", () => {
    const tiny = { w: NOTE_W, h: 300, viewport: { width: 200, height: 100 } };
    expect(dragNoteSize(tiny, 9_000, 9_000)).toEqual({ w: 320, h: 160 });
  });

  test("it lands on whole pixels", () => {
    expect(dragNoteSize(press, 10.4, 10.6)).toEqual({ w: NOTE_W + 10, h: 311 });
  });

  test("the size is written onto the note", () => {
    const state = sizeNote(board(1), key, 640, 500, WIDE);
    expect(placeAt(state, key)).toMatchObject({ w: 640, h: 500 });
  });

  test("sizing a note to the size it already is hands back the same state", () => {
    // This fires on every pointermove, and a gesture that has reached the floor keeps reporting the
    // size it is already at for as long as the reader keeps pushing.
    const state = sizeNote(board(1), key, 640, 500, WIDE);
    expect(sizeNote(state, key, 640, 500, WIDE)).toBe(state);
  });

  test("sizing a note that is not up is a no-op", () => {
    const state = board(1);
    expect(sizeNote(state, "record:thesis:9", 640, 500, WIDE)).toBe(state);
  });

  test("only the sized note gets a new place object", () => {
    const state = board(2);
    const other = placeAt(state, "record:thesis:1");
    const next = sizeNote(state, key, 640, 500, WIDE);
    expect(placeAt(next, key)).not.toBe(placeAt(state, key));
    expect(placeAt(next, "record:thesis:1")).toBe(other);
  });

  test("a resize never changes which note is in front", () => {
    const state = board(2);
    const sized = sizeNote(state, key, 640, 500, WIDE);
    expect(sized.nextZ).toBe(state.nextZ);
    expect(placeAt(sized, key)!.z).toBe(placeAt(state, key)!.z);
  });

  test("a wide note may sit further off the left edge than a narrow one", () => {
    // The strip that stays reachable is measured back from the note's RIGHT edge, so how far left it
    // may go is a fact about its own width.
    const wide = sizeNote(board(1), key, 800, 400, WIDE);
    const at = placeAt(moveNote(wide, key, -9_000, 400, WIDE), key)!;
    expect(at.x + 800).toBe(12 + 96);
  });

  test("shrinking a note parked off the left edge pulls it back", () => {
    // Growing can never break the bound; shrinking can, and it would strand the head — the one
    // handle the note has — past the edge of the glass.
    let state = sizeNote(board(1), key, 800, 400, WIDE);
    state = moveNote(state, key, -9_000, 400, WIDE);
    const shrunk = placeAt(sizeNote(state, key, NOTE_W, 400, WIDE), key)!;
    expect(shrunk.x + NOTE_W).toBe(12 + 96);
  });
});

describe("dragging a note's side edge", () => {
  /** A note parked mid-board at its birth width, never resized — so its height is still `null`. */
  const press = { x: 500, w: NOTE_W, h: null, viewport: WIDE };
  /** Where its right border is, and where every assertion below says it stayed. */
  const RIGHT = 500 + NOTE_W;

  test("the left border follows the pointer and the right one does not move", () => {
    expect(dragNoteLeft(press, -100)).toEqual({ x: 400, w: 500 });
    expect(dragNoteLeft(press, 60)).toEqual({ x: 560, w: 340 });
  });

  test("at the width floor it is the LEFT border that stops", () => {
    // The whole point of anchoring off the press: a reader who pushes past the floor and comes back
    // must find the right border exactly where they left it, not walked left by the clamped pixels.
    const at = dragNoteLeft(press, 9_000);
    expect(at.w).toBe(320);
    expect(at.x + at.w).toBe(RIGHT);
  });

  test("at the glass it is the left border that stops too", () => {
    const at = dragNoteLeft(press, -9_000);
    expect(at.w).toBe(1440 - 24);
    expect(at.x + at.w).toBe(RIGHT);
  });

  test("the two borders stay coupled through the rounding", () => {
    // Both numbers come off one rounded width rather than being rounded apart, so a fractional
    // distance cannot open a one-pixel gap between where the note ends and where it was anchored.
    for (const dx of [10.4, 10.5, -0.5, 33.3]) {
      const at = dragNoteLeft(press, dx);
      expect(at.x + at.w).toBe(RIGHT);
      expect(Number.isInteger(at.x)).toBe(true);
    }
  });

  test("the right edge changes the width and nothing else", () => {
    // No anchor and no `x`: the left border is simply not touched.
    expect(dragNoteRight(press, 120)).toEqual({ w: NOTE_W + 120 });
    expect(dragNoteRight(press, -9_000)).toEqual({ w: 320 });
    expect(dragNoteRight(press, 9_000)).toEqual({ w: 1440 - 24 });
  });
});

describe("the bottom-left corner", () => {
  const press = { x: 500, w: NOTE_W, h: 300, viewport: WIDE };

  test("all three numbers move together, with the right border held", () => {
    expect(dragNoteSizeLeft(press, -100, 50)).toEqual({ x: 400, w: 500, h: 350 });
  });

  test("both floors hold the right border as well", () => {
    const at = dragNoteSizeLeft(press, 9_000, -9_000);
    expect(at).toEqual({ x: 500 + NOTE_W - 320, w: 320, h: 160 });
    expect(at.x + at.w).toBe(500 + NOTE_W);
  });
});

describe("writing a left-side resize onto the note", () => {
  const key = "record:thesis:0";

  test("the position and the width land together", () => {
    const state = sizeNoteAt(board(1), key, 200, 600, null, WIDE);
    expect(placeAt(state, key)).toMatchObject({ x: 200, w: 600 });
  });

  test("a height of null STAYS null — a width drag does not freeze the sheet", () => {
    // The one-way trip to a fixed height belongs to the gestures that are about the height. A reader
    // who widened a note to fit a table would otherwise lose its growth for good, having asked for
    // nothing of the sort.
    expect(placeAt(sizeNoteAt(board(1), key, 200, 600, null, WIDE), key)!.h).toBeNull();
  });

  test("a height that is a number lands as one", () => {
    expect(placeAt(sizeNoteAt(board(1), key, 200, 600, 420, WIDE), key)).toMatchObject({ h: 420 });
  });

  test("writing the rectangle a note already has hands back the same state", () => {
    // Fires on every pointermove, like the corner's — and a gesture pinned at the floor keeps
    // reporting the rectangle it is already at for as long as the reader keeps pushing.
    const state = sizeNoteAt(board(1), key, 200, 600, null, WIDE);
    expect(sizeNoteAt(state, key, 200, 600, null, WIDE)).toBe(state);
  });

  test("sizing a note that is not up is a no-op", () => {
    const state = board(1);
    expect(sizeNoteAt(state, "record:thesis:9", 200, 600, null, WIDE)).toBe(state);
  });

  test("only the resized note gets a new place object", () => {
    const state = board(2);
    const other = placeAt(state, "record:thesis:1");
    const next = sizeNoteAt(state, key, 200, 600, null, WIDE);
    expect(placeAt(next, key)).not.toBe(placeAt(state, key));
    expect(placeAt(next, "record:thesis:1")).toBe(other);
  });

  test("a left border dragged past the glass is pulled back like any other position", () => {
    // `dragNoteLeft` cannot produce this on its own — the width clamp stops first — but the writer
    // is general, and the bound it enforces is the one that keeps a strip of head in reach.
    const at = placeAt(sizeNoteAt(board(1), key, -9_000, 600, null, WIDE), key)!;
    expect(at.x + 600).toBe(12 + 96);
  });

  test("a resize never changes which note is in front", () => {
    const state = board(2);
    const sized = sizeNoteAt(state, key, 200, 600, null, WIDE);
    expect(sized.nextZ).toBe(state.nextZ);
    expect(placeAt(sized, key)!.z).toBe(placeAt(state, key)!.z);
  });
});

describe("a viewport that changes size", () => {
  test("notes stranded outside it are pulled back", () => {
    // A laptop undocked from a monitor is the ordinary case, and a note off the glass is a record
    // that can only be closed by reloading the page.
    const state = moveNote(board(1), "record:thesis:0", 1_300, 800, WIDE);
    const small: Box = { width: 700, height: 500 };
    const at = placeAt(clampNotes(state, small), "record:thesis:0")!;
    expect(at.x).toBeLessThanOrEqual(700 - 12 - 96);
    expect(at.y).toBeLessThanOrEqual(500 - 12 - 34);
  });

  test("a resize that strands nobody hands back the same state", () => {
    const state = board(3);
    expect(clampNotes(state, WIDE)).toBe(state);
    expect(clampNotes(state, { width: 1600, height: 1000 })).toBe(state);
  });

  test("the pull-back is measured against the note's OWN width", () => {
    // A wide note may legally sit further off the left edge than a narrow one, because the strip
    // that stays reachable is measured back from its right edge. Clamping every note as if it were
    // 400 wide would drag this one right for no reason.
    let state = sizeNote(board(1), "record:thesis:0", 800, 400, WIDE);
    state = moveNote(state, "record:thesis:0", -9_000, 400, WIDE);
    const at = placeAt(clampNotes(state, WIDE), "record:thesis:0")!;
    expect(at.x + 800).toBe(12 + 96);
  });

  test("a note sized on a big screen is cut down to a small one", () => {
    // The case that strands a note for good if only the position is clamped: the grip is at the
    // bottom-right corner, so a note taller than the window has no reachable corner at any position
    // the clamp allows, and the reader is left with a sheet over the whole screen and no way to
    // shrink it. A size outlives the screen it was chosen on, which is what makes this the ordinary
    // case rather than the edge one.
    const big = sizeNote(board(1), "record:thesis:0", 1_416, 876, WIDE);
    expect(placeAt(big, "record:thesis:0")).toMatchObject({ w: 1_416, h: 876 });

    const small: Box = { width: 700, height: 500 };
    const cut = clampNotes(big, small);
    const at = placeAt(cut, "record:thesis:0")!;
    expect(at.w).toBe(700 - 24);
    expect(at.h).toBe(500 - 24);

    // And the corner is now REACHABLE, which is the property that actually matters and is weaker
    // than "on screen": the clamp has never promised a whole note fits, only that enough of it does
    // to grab — a reader is allowed to park one mostly off the glass. What must be true is that some
    // position they can drag to puts the grip back in view, and with the size cut to the viewport
    // there is one. Before the size was clamped there was none on the vertical axis at any y.
    const parked = moveNote(cut, "record:thesis:0", 0, 0, small);
    const corner = placeAt(parked, "record:thesis:0")!;
    expect(corner.x + corner.w).toBeLessThanOrEqual(small.width);
    expect(corner.y + (corner.h ?? 0)).toBeLessThanOrEqual(small.height);
  });

  test("a note nobody has sized keeps its content height through a resize", () => {
    // `null` is not a number to be clamped — it means the sheet is as tall as what is written on it,
    // and the stylesheet's own cap is what keeps that on the glass.
    const at = placeAt(clampNotes(board(1), { width: 700, height: 500 }), "record:thesis:0")!;
    expect(at.h).toBeNull();
  });

  test("only the stranded notes get new place objects", () => {
    let state = board(2);
    state = moveNote(state, "record:thesis:0", 1_300, 100, WIDE);
    // Parked where it still fits after the shrink, so the two notes answer differently.
    state = moveNote(state, "record:thesis:1", 40, 100, WIDE);
    const safe = placeAt(state, "record:thesis:1");
    const next = clampNotes(state, { width: 700, height: 900 });
    expect(next).not.toBe(state);
    expect(placeAt(next, "record:thesis:0")).not.toBe(placeAt(state, "record:thesis:0"));
    expect(placeAt(next, "record:thesis:1")).toBe(safe);
  });
});

describe("a board that changes width under the notes", () => {
  /** The board's half of a laptop at the default split, and at the two ends of the grip's range. */
  const BOARD = 1440 / 2;
  const NARROW = 1440 / 3;

  test("x, w and h scale; y and z are left exactly alone", () => {
    // The shape of the gesture: the grip moves sideways and the dock is full height, so the board's
    // HEIGHT never changed — notes that slid up or down would read as the board tipping. `z` is
    // order rather than geometry, and a change of width reorders nothing.
    let state = moveNote(board(1), "record:thesis:0", 300, 220, WIDE);
    state = sizeNote(state, "record:thesis:0", 400, 360, WIDE);
    const was = placeAt(state, "record:thesis:0")!;
    const at = placeAt(scaleNotes(state, 0.5), "record:thesis:0")!;
    expect(at).toEqual({ x: 150, y: was.y, z: was.z, w: 200, h: 180 });
  });

  test("a note nobody has sized keeps its content height", () => {
    // `null` means "as tall as what is written on it", which is not a number to be scaled — the
    // same answer `clampSize` gives it, for the same reason.
    expect(placeAt(scaleNotes(board(1), 0.75), "record:thesis:0")!.h).toBeNull();
  });

  test("a note that fitted on the old board still fits on the new one", () => {
    // What "proportional" has to mean for it to be worth doing at all: the arrangement survives the
    // drag, so a note parked clear of the conversation is still clear of it afterwards. Asserted
    // before the MIN clamp is composed, which is where the guarantee stops — see below.
    const state = moveNote(board(1), "record:thesis:0", 300, 200, WIDE);
    const was = placeAt(state, "record:thesis:0")!;
    expect(was.x + was.w).toBeLessThanOrEqual(BOARD);
    const at = placeAt(scaleNotes(state, NARROW / BOARD), "record:thesis:0")!;
    expect(at.x + at.w).toBeLessThanOrEqual(NARROW);
  });

  test("composed with the clamp, the size floors still hold", () => {
    // `scaleNotes` applies no floor of its own on purpose — `clampNotes` is the one owner of MIN_W
    // and MIN_H — so this is the pair the store actually writes, and 320/160 is where a hard shrink
    // stops. A note held to the floor no longer scales with the board and may end up over the dock;
    // notes float above the conversation, and moving one is the way back.
    let state = moveNote(board(1), "record:thesis:0", 300, 200, WIDE);
    state = sizeNote(state, "record:thesis:0", 400, 300, WIDE);
    const at = placeAt(clampNotes(scaleNotes(state, 0.4), WIDE), "record:thesis:0")!;
    expect(at.w).toBe(320);
    expect(at.h).toBe(160);
  });

  test("a ratio of exactly one, or of junk, hands back the same state", () => {
    // Identity, not equality. This fires on every pointermove of a drag on the grip, and a ratio of
    // zero or NaN is a board with no width — scaling by one of those would put every note at 0 or
    // NaN and lose the lot.
    const state = board(3);
    expect(scaleNotes(state, 1)).toBe(state);
    expect(scaleNotes(state, Number.NaN)).toBe(state);
    expect(scaleNotes(state, 0)).toBe(state);
    expect(scaleNotes(state, -1)).toBe(state);
  });

  test("only the notes that actually moved get new place objects", () => {
    // The identity discipline the whole file is arranged around, on the one gesture that touches
    // every note at once: a nudge small enough to round away for one note must not replace its place
    // object and redraw the open editor on it.
    let state = moveNote(board(2), "record:thesis:0", 100, 100, WIDE);
    state = moveNote(state, "record:thesis:1", 1_000, 200, WIDE);
    const unmoved = placeAt(state, "record:thesis:0");
    const next = scaleNotes(state, 1.001);
    expect(next).not.toBe(state);
    expect(placeAt(next, "record:thesis:0")).toBe(unmoved);
    expect(placeAt(next, "record:thesis:1")).not.toBe(placeAt(state, "record:thesis:1"));
  });
});

describe("taking a note down", () => {
  test("its place goes with it", () => {
    const state = dropNote(board(2), "record:thesis:0");
    expect(placeAt(state, "record:thesis:0")).toBeNull();
    expect(placeAt(state, "record:thesis:1")).not.toBeNull();
  });

  test("dropping a note that was never up is not an error", () => {
    // The store closes cards that may never have been placed, and a close is a fact about the
    // screen either way.
    const state = board(1);
    expect(dropNote(state, "record:thesis:9")).toBe(state);
  });
});

describe("whether the pointer is over the Bin", () => {
  const rect = { x: 12, y: 800, width: 84, height: 40 };

  test("inside is yes and outside is no", () => {
    expect(overRect(rect, 40, 820)).toBe(true);
    expect(overRect(rect, 40, 700)).toBe(false);
    expect(overRect(rect, 400, 820)).toBe(false);
  });

  test("half-open on the far edges, so two touching rectangles do not both claim a pixel", () => {
    expect(overRect(rect, 12, 800)).toBe(true);
    expect(overRect(rect, 96, 820)).toBe(false);
    expect(overRect(rect, 40, 840)).toBe(false);
  });

  test("no rectangle is no", () => {
    // The Bin's element is read once, at the press. A gesture that began before the corner column
    // mounted must not delete anything.
    expect(overRect(null, 40, 820)).toBe(false);
  });
});

describe("how a note is torn", () => {
  test("the same card tears the same way every time", () => {
    // A hash and never a random number: a sheet that re-tore itself when an unrelated note closed
    // would be movement in the corner of the eye with no fact behind it.
    expect(noteDeckle("record:thesis:abc")).toBe(noteDeckle("record:thesis:abc"));
  });

  test("the torn edge is one of the three the board has defs for", () => {
    for (let i = 0; i < 60; i++) {
      expect(noteDeckle(`record:report:${i}`)).toBeGreaterThanOrEqual(0);
      expect(noteDeckle(`record:report:${i}`)).toBeLessThan(3);
    }
  });

  test("all three torn edges get used", () => {
    // The range is a contract with `ChalkDefs.tsx`, which declares exactly three `deckle` filters:
    // a hash that only ever answered two of them would leave one seed drawn and never referenced,
    // and a board of notes all torn the same way is a board that reads as printed.
    const seen = new Set(Array.from({ length: 400 }, (_, i) => noteDeckle(`record:thesis:${i}`)));
    expect(seen).toEqual(new Set([0, 1, 2]));
  });

  test("the paper does not vary, and that is the whole of what a note wears", () => {
    /*
     * AN ABSENCE PINNED AS A TEST, because "no changing anymore" is the requirement rather than a
     * side effect. This function used to hand back a `{ deckle, paper }` pair off two slices of the
     * hash, dealing one of ten tints per card; every sheet in the window is one sage paper now
     * (`styles/paper.css`), so the only thing a key decides is the torn edge. A number and not an
     * object is what makes that unfakeable here: a paper cannot come back without this assertion —
     * and the type — having to change with it.
     */
    expect(typeof noteDeckle("record:thesis:abc")).toBe("number");
  });
});
