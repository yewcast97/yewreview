/**
 * Where each open note is pinned to the board, and which of them is in front.
 *
 * PURE and DOM-FREE, like `state/cards.ts` and `state/chatDock.ts`, and for the same reason: `bun
 * test` drives it directly under the root tsconfig, so the orderings that are miserable to reproduce
 * by hand — a note dragged off the bottom of a laptop screen, a viewport that shrinks under six open
 * notes, a cascade that has to wrap because the reader has given the board the narrow end of the
 * split — are asserted rather than hoped for.
 * Nothing in here reads `window`; the store passes the viewport in, the way `ChatDock` does.
 *
 * WHY THIS IS NOT A FIELD OF `state/cards.ts`, which is the obvious place to put it and is the wrong
 * one. That module's identity discipline is about NETWORK races: a card's state object is replaced
 * when a read lands, and every open editor under it redraws when that happens. Geometry changes at
 * sixty hertz while a note is being dragged. Threading a moving `x` through the same objects would
 * replace every card's state on every pointer event and redraw a stack of open records to move one
 * sheet of paper four pixels. Two facts, two change rates, two slices — the same argument the store
 * already makes for keeping `graphView` out of `graph`.
 *
 * OPEN RECORDS ARE NOTES ON A BOARD, and that is what this module exists for. A fixed column down
 * the right edge with one scrollbar for the lot of them would make the stack a single document, and
 * where a note sat would be a fact nobody owned — defensible for a list, and not for notes: a sticky
 * note that cannot be moved is a list item wearing paper. So each one gets a place on the board, the
 * reader moves it by its head, and this module holds where they put it.
 *
 * Z IS A COUNTER THAT ONLY GOES UP, and never a re-sort of the whole map. Raising a note takes the
 * next number and leaves every other entry's `NotePlace` object EXACTLY as it was — which is what
 * lets the component subscribe per note and redraw only the one that moved. A scheme that renumbered
 * 1..n on every raise would be correct and would also replace every note's place object on every
 * click, which is the redraw this whole file is arranged to avoid. The counter is a float64 integer
 * incremented once per open and once per raise; a reader would have to raise a note every second for
 * two hundred and eighty million years to reach the point where it stops counting.
 *
 * THE CASCADE IS DETERMINISTIC AND SO IS EVERYTHING ELSE HERE. A note's first position is a function
 * of how many have been opened before it, the viewport, and where the dock's left edge is — never a
 * random offset — so the same sequence of gestures puts the same notes in the same places, and a
 * test can say where the fourth one lands.
 */

import type { CardKey } from "./cards.ts";
import type { Box } from "./chatDock.ts";

// -- the shape ------------------------------------------------------------------------------------

/**
 * Where one note is, how big it is, and how far forward. Viewport pixels, like the dock's rectangle.
 *
 * `h` IS NULLABLE AND `w` IS NOT, and the asymmetry is the whole design of the resize. A note's width
 * has always been a number this module owns — `NOTE_W`, mirrored into the stylesheet — so a resized
 * note is just a different number in the same slot. Its HEIGHT was never anybody's: the sheet grows
 * to whatever is written on it and stops at a cap against the viewport, which is what a note showing
 * three fields and a note showing a thesis should both do. `null` is that arrangement, and it is what
 * every note is born with; a number appears the first time somebody drags the corner, and from then
 * on the note is exactly that tall because they said so. There is no gesture back to `null`, and that
 * is honest: a reader who wants the automatic height again closes the note and opens it.
 */
export type NotePlace = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number | null;
};

export type NotesState = {
  /** Where each open card's note sits. Kept in step with `cards.cards` by the store: a card that is
   * opened is placed, a card that is closed is dropped. A key with no entry is a note the component
   * must not draw yet — which lasts at most one frame, and only if a caller forgot the pairing. */
  readonly placed: ReadonlyMap<CardKey, NotePlace>;
  /** The next z to hand out. See the header: it only ever goes up. */
  readonly nextZ: number;
  /** How many notes have been PUT UP, ever — the cascade's index, and not `placed.size`.
   *
   * Size would count what is on the board rather than what has been opened, so closing the third of
   * four notes and opening another would drop the new one exactly on top of a note that is already
   * there. A counter that only goes up cannot collide with the note before it, which is the one
   * collision a cascade exists to prevent. */
  readonly spawns: number;
};

/**
 * How wide a note starts out.
 *
 * THIS IS THE ONLY COPY OF THE FIGURE, NOT A MIRROR OF THE STYLESHEET. The corner can be dragged, so
 * the width is a fact per note rather than a rule for all of them: the component writes it onto the
 * element inline and `NoteBoard.css` declares none of it — exactly the bargain `state/chatDock.ts`
 * makes with `ChatDock.css` about the dock's rectangle, and for the same reason: one copy of the
 * figure, and no way for two of them to drift. A sheet declaring `width: 400px` with this constant
 * repeating it so the clamp could do the sums the cascade needs would be two copies, because
 * arithmetic cannot read a stylesheet. What lives here is the number a note is BORN at, and it is
 * this number because narrower makes a record row's head wrap.
 */
export const NOTE_W = 400;

/**
 * The smallest a note may be dragged, on both axes.
 *
 * The width floor is the HEAD's requirement rather than the body's: the strip carries the kind word,
 * a reload and sometimes an open-in-a-tab, and the magnet reserves the last 32px of the corner —
 * below about this the controls start eating the word that says what the note is. The body is
 * unbothered either way, because a field grid reflows and a `<pre>` scrolls.
 *
 * The height floor is the head plus enough body to see that there IS a body. Anything shorter is a
 * note the reader has effectively closed, and closing is what the magnet is for.
 */
const MIN_W = 320;
const MIN_H = 160;

/**
 * The margin every floating thing keeps off the window's edges, mirrored from `--float-inset`.
 *
 * `state/chatDock.ts` mirrors the same number as its own `EDGE`, and the two are deliberately not
 * imported from each other: they are separate pieces of arithmetic that happen to agree about how
 * far in from the glass this window's furniture sits, and one importing the other would make a
 * change to either of them a change to both.
 */
const MARGIN = 12;

/**
 * The board's tool corner: the reset and the reload live in the first `--header-height` of the top
 * edge, and a note's first position must not land on them.
 */
const HEADER = 44;

/** Where the cascade starts from, downward. */
const TOP = MARGIN + HEADER;

/**
 * The least of a note that must stay reachable, however far it is dragged.
 *
 * A note IS its head as far as this module is concerned — the head is the handle, the magnet that
 * closes it and the buttons that reload it — so the clamp guarantees a grabbable strip of that head
 * and nothing about the body. A reader who drags a note most of the way off the right edge to get it
 * out of the way has done something deliberate, and a clamp that snapped it back would be this
 * window overruling them; a note dragged entirely off the glass would be a record that can only be
 * closed by reloading the page, which is a different thing.
 */
const GRAB_W = 96;
const HEAD_H = 34;

/** How far each note in the cascade steps from the one before it: down, and to the left. */
const STEP_X = 26;
const STEP_Y = 30;

const NO_PLACES: ReadonlyMap<CardKey, NotePlace> = new Map();

export function createNotesState(): NotesState {
  return { placed: NO_PLACES, nextZ: 1, spawns: 0 };
}

/** Where one note is, or null while it has not been placed. */
export function placeAt(state: NotesState, key: CardKey): NotePlace | null {
  return state.placed.get(key) ?? null;
}

// -- putting one up -------------------------------------------------------------------------------

/**
 * Where the `index`-th note put up on this board lands.
 *
 * ANCHORED TOP-RIGHT OF THE BOARD'S OWN HALF, and stepping down and to the left from there. The
 * anchor is muscle memory — a reader who has used this window before looks to the right for what
 * they just opened — and the direction is the only one that walks INTO the board rather than off it:
 * the corner instruments are bottom-left, so a cascade heading down-left away from the board's
 * top-right corner crosses the emptiest part of the slate.
 *
 * `dockLeft` IS WHERE THE BOARD ENDS AND THE CONVERSATION BEGINS, and the anchor is a note's width
 * clear of it. Notes are painted OVER the conversation, so a note landing to the right of that line
 * would not arrive hidden — it would arrive covering the thing the reader was reading, which is what
 * this keeps off. It is the dock's LEFT edge and not its top because the dock is a full-height panel
 * down the right of the window; the board's free space is a column beside it rather than a strip
 * above it, so the bound the cascade has to respect is horizontal — wherever the reader has dragged
 * that edge to.
 *
 * IT WRAPS RATHER THAN WALKING OFF, and both bounds are computed from the screen it is landing on: a
 * short viewport runs out of vertical room before a narrow one runs out of horizontal, and whichever
 * runs out first decides how many rungs the ladder has.
 *
 * Exported because it is the half of `placeNote` worth asserting directly: everything else that
 * function does is bookkeeping.
 */
export function spawnPoint(
  index: number,
  viewport: Box,
  dockLeft: number,
): { x: number; y: number } {
  const anchorX = Math.max(MARGIN, dockLeft - MARGIN - NOTE_W);
  const downRoom = Math.max(0, viewport.height - MARGIN - HEAD_H - TOP);
  const leftRoom = Math.max(0, anchorX - MARGIN);
  // At least one rung, because a viewport with no room for a second position still has room for a
  // first one — the clamp below is what keeps that first one on the glass.
  const rungs = Math.max(
    1,
    Math.min(Math.floor(downRoom / STEP_Y), Math.floor(leftRoom / STEP_X)) + 1,
  );
  const rung = ((index % rungs) + rungs) % rungs;
  return clampPoint(anchorX - rung * STEP_X, TOP + rung * STEP_Y, viewport, NOTE_W);
}

/*
 * `clampPoint` above bounds the cascade against the GLASS and not against the dock, which is
 * deliberate and is the one place these two rules differ. A fresh note is kept off the conversation
 * because that is where the window chose to put it; a note the reader then DRAGS over the dock stays
 * where they put it, because the dock is the bottom of the floating layers and moving the note is
 * the way back. The cascade is a default, not a fence.
 */

/**
 * Put a note up, unless it is already up.
 *
 * The no-op for a key that is already placed is the gesture's meaning, and it pairs with
 * `openCard`'s dedupe: opening a record that is open is somebody saying "that one", and a note that
 * jumped back to the cascade's next slot when they said it would be this window moving the thing
 * they were pointing at. Raising it is what answers them, and the store does that separately.
 */
export function placeNote(
  state: NotesState,
  key: CardKey,
  viewport: Box,
  dockLeft: number,
): NotesState {
  if (state.placed.has(key)) return state;
  const { x, y } = spawnPoint(state.spawns, viewport, dockLeft);
  const placed = new Map(state.placed);
  // Off the pad at the pad's size: every note starts the width the stylesheet was written around and
  // as tall as what is on it. See `NotePlace` on why only one of those two is a number.
  placed.set(key, { x, y, z: state.nextZ, w: NOTE_W, h: null });
  return { placed, nextZ: state.nextZ + 1, spawns: state.spawns + 1 };
}

/** Take a note's place with it. A key that was never placed is not an error — the store closes cards
 * that may never have been placed, and a close is a fact about the screen either way. */
export function dropNote(state: NotesState, key: CardKey): NotesState {
  if (!state.placed.has(key)) return state;
  const placed = new Map(state.placed);
  placed.delete(key);
  return { ...state, placed };
}

// -- moving one -----------------------------------------------------------------------------------

/**
 * Bring a note to the front.
 *
 * A NO-OP WHEN IT IS ALREADY THERE, which is not an optimisation: this fires on every pointerdown
 * anywhere in a note, so a reader selecting their way through a long thesis on the front note would
 * otherwise mint a new state — and a new place object for that note — on every press.
 */
export function raiseNote(state: NotesState, key: CardKey): NotesState {
  const held = state.placed.get(key);
  if (held === undefined) return state;
  if (held.z === state.nextZ - 1) return state;
  const placed = new Map(state.placed);
  placed.set(key, { ...held, z: state.nextZ });
  return { ...state, placed, nextZ: state.nextZ + 1 };
}

/** Move one note, clamped to the glass. The caller has already added the gesture's total distance to
 * the position it read at the press — see `usePointerDrag` on why a drag is a function of where it
 * started rather than a sum over the moves it has seen. */
export function moveNote(
  state: NotesState,
  key: CardKey,
  x: number,
  y: number,
  viewport: Box,
): NotesState {
  const held = state.placed.get(key);
  if (held === undefined) return state;
  const at = clampPoint(x, y, viewport, held.w);
  if (at.x === held.x && at.y === held.y) return state;
  const placed = new Map(state.placed);
  placed.set(key, { ...held, x: at.x, y: at.y });
  return { ...state, placed, nextZ: state.nextZ };
}

/**
 * Pull every note back onto a viewport that has changed size — its SIZE first, then its position.
 *
 * THE SIZE HAS TO BE RE-CLAMPED AND NOT ONLY THE POSITION, and getting that wrong is a note the
 * reader cannot recover. A size is chosen against one screen and outlives it: a note dragged to fill
 * a 1440-wide monitor and then redrawn on a 700-wide laptop is 1416 pixels of paper on a 700 pixel
 * window, and because the grip is at its bottom-right corner the one control that could make it
 * smaller is now off the glass — on the vertical axis irrecoverably so, since no position the clamp
 * allows can bring a note taller than the window back into reach. The reader would be left with a
 * sheet covering the whole screen and no way out but closing the record. A screen outliving the
 * screen a size was chosen on is the ORDINARY case rather than the edge one — an external monitor
 * unplugged at the end of a day — which is why both halves of a note's box are re-clamped on every
 * read rather than trusted.
 *
 * SIZE BEFORE POSITION, because the position's own bound is computed FROM the width — a note that
 * has just been narrowed may sit further right than its old width allowed — so clamping them the
 * other way round would leave the position solving against a width that is about to change.
 *
 * THE SAME OBJECT WHEN NOTHING CHANGED, and per note as well as for the state as a whole: a window
 * resize with six notes open where only one was hanging off the right edge replaces one place object
 * and redraws one note. A note stranded outside the glass is a record that cannot be closed.
 */
export function clampNotes(state: NotesState, viewport: Box): NotesState {
  let placed: Map<CardKey, NotePlace> | null = null;
  for (const [key, held] of state.placed) {
    const size = clampSize(held.w, held.h, viewport);
    const at = clampPoint(held.x, held.y, viewport, size.w);
    if (at.x === held.x && at.y === held.y && size.w === held.w && size.h === held.h) continue;
    placed ??= new Map(state.placed);
    placed.set(key, { ...held, x: at.x, y: at.y, w: size.w, h: size.h });
  }
  return placed === null ? state : { ...state, placed };
}

/**
 * Rescale every note across a board that has changed width, by a ratio.
 *
 * WHAT THIS IS FOR is the conversation dock's grip: the boundary moves, the board gets a different
 * share of the window, and the notes on it should end up arranged as they were at a proportional
 * size — not a fixed cascade with its right-hand column suddenly under the conversation. The ratio
 * is the board's new width over its old one, and the store is what knows both.
 *
 * X, W AND H ONLY. Y AND Z ARE LEFT EXACTLY ALONE, and that is the whole shape of the gesture rather
 * than an economy. The board's HEIGHT did not change — the dock is full height and the grip only
 * moves sideways — so a horizontal drag that also slid every note up or down would read as the board
 * tipping. `z` is order rather than geometry: there is nothing about a pile that a change of width
 * reorders. A null `h` passes through untouched for the reason `clampSize` states — it means "as
 * tall as what is written on it", which is not a number to be scaled.
 *
 * NO FLOOR AND NO CEILING ARE APPLIED HERE. `clampNotes` owns `MIN_W`, `MIN_H` and the viewport's
 * bounds, the store composes it after this, and two places clamping a note's rectangle would be two
 * answers to how small one may be. The consequence is worth stating: a note squeezed down to `MIN_W`
 * on a hard shrink no longer scales with the board and can end up overlapping the dock. That is the
 * standing bargain rather than a defect — notes float above the conversation (`--z-note` over
 * `--z-dock`) precisely so that a reader can park one there, and moving the note is the way back.
 *
 * THE SAME OBJECT WHEN NOTHING MOVED, per note as well as for the state as a whole, like everything
 * else in this file: a drag on the grip fires this sixty times a second, and a rounding that landed
 * on the same pixel must not replace a note's place object and redraw its open editor.
 */
export function scaleNotes(state: NotesState, r: number): NotesState {
  // A ratio of zero or worse is a board with no width, or a rectangle measured before there was one;
  // scaling by it would put every note at 0 or NaN and lose them. `lib/graphView.ts` refuses the same
  // three values in the same breath, for the same reason.
  if (r === 1 || !Number.isFinite(r) || r <= 0) return state;
  let placed: Map<CardKey, NotePlace> | null = null;
  for (const [key, held] of state.placed) {
    const x = Math.round(held.x * r);
    const w = Math.round(held.w * r);
    const h = held.h === null ? null : Math.round(held.h * r);
    if (x === held.x && w === held.w && h === held.h) continue;
    placed ??= new Map(state.placed);
    placed.set(key, { ...held, x, w, h });
  }
  return placed === null ? state : { ...state, placed };
}

// -- sizing one -----------------------------------------------------------------------------------

/**
 * What the corner grip remembers at pointerdown: the note's size at the press and the viewport it is
 * being clamped against. Both read ONCE, for the reason `lib/pointerDrag.ts` states in its contract
 * — a size re-read mid-gesture would change the meaning of a distance measured from a fixed start,
 * and the corner would run away from the pointer.
 *
 * `h` IS A NUMBER HERE THOUGH `NotePlace.h` IS NULLABLE, and that is the component's job to resolve:
 * a note that has never been resized is as tall as its content, and only the browser knows how tall
 * that is. `NoteBoard` measures the article once, at the press, and hands the answer in — which is
 * the same one-read-at-the-start bargain, and the reason this module never has to touch an element.
 */
export type SizePress = { w: number; h: number; viewport: Box };

/**
 * The size after the corner has been dragged (dx, dy) from the press.
 *
 * Both distances are TOTALS since pointerdown, per `usePointerDrag`'s contract, so this is a function
 * of the gesture rather than a sum over its history. The bounds are `clampSize`'s: a note may be
 * dragged as large as the glass it is on and no larger, because a note bigger than the window is one
 * whose corner cannot be reached to make it smaller again.
 */
export function dragNoteSize(from: SizePress, dx: number, dy: number): { w: number; h: number } {
  const at = clampSize(from.w + dx, from.h + dy, from.viewport);
  // `h` is only ever null for a note nobody has sized, and a gesture that sizes one always has a
  // number to add its distance to — so this narrowing is the type stating what the caller knows.
  return { w: at.w, h: at.h as number };
}

/**
 * What a SIDE edge remembers at the press.
 *
 * IT CARRIES `h` THOUGH IT NEVER CHANGES IT, and that is the point: a width drag hands back the
 * height it found, `null` included. Freezing a note's height as a side effect of widening it would
 * spend the one-way conversion in `NotePlace` on a gesture that was never about the height — the
 * reader would drag an edge to fit a table and silently lose the sheet's growth for good. So the
 * height rides along in the snapshot, and the whole answer stays a function of the press.
 *
 * `x` rides along for the left edge, which needs the note's right border and can only get it from
 * where the note was when the gesture started.
 */
export type EdgePress = { x: number; w: number; h: number | null; viewport: Box };

/**
 * Where the left border goes, and what that leaves the note's width, after a drag of `dx`.
 *
 * THE RIGHT BORDER IS THE ANCHOR AND IT IS TAKEN FROM THE PRESS. `right` is computed once from the
 * snapshot rather than read back off the note between moves, and that is what makes the clamp behave:
 * at `MIN_W`, or against the glass, the width stops and `x` stops with it, because `x` is derived
 * from a total rather than accumulated from steps. An implementation that read the live place each
 * move would fold every clamped pixel into the anchor, and the right border would creep left each
 * time the reader pushed past the floor and came back.
 */
export function dragNoteLeft(from: EdgePress, dx: number): { x: number; w: number } {
  const right = from.x + from.w;
  const w = clampSize(from.w - dx, null, from.viewport).w;
  return { x: right - w, w };
}

/** The width after the right border is dragged `dx`. The left border is simply not touched, so
 * unlike its mirror this needs no anchor and hands back no `x`. */
export function dragNoteRight(from: EdgePress, dx: number): { w: number } {
  return { w: clampSize(from.w + dx, null, from.viewport).w };
}

/** What the bottom-LEFT corner remembers: the height already measured off the sheet, as the
 * bottom-right grip's press has it, plus the `x` its anchor is computed from. */
export type LeftSizePress = SizePress & { x: number };

/** The bottom-left corner dragged (dx, dy): the width and height of `dragNoteSize`, mirrored, with
 * the right border anchored exactly as `dragNoteLeft` anchors it. */
export function dragNoteSizeLeft(
  from: LeftSizePress,
  dx: number,
  dy: number,
): { x: number; w: number; h: number } {
  const at = clampSize(from.w - dx, from.h + dy, from.viewport);
  return { x: from.x + from.w - at.w, w: at.w, h: at.h as number };
}

/**
 * The largest and smallest a note may be on this screen.
 *
 * ONE FUNCTION FOR THE GESTURE AND FOR THE WINDOW RESIZE, which is the point of extracting it: the
 * grip clamps a size the reader is choosing and `clampNotes` clamps a size they chose on a screen
 * that has since gone, and two copies of these bounds would be two answers to how big a note may be.
 *
 * A null height passes through untouched. It means "as tall as what is written on it", which is not
 * a number this module can bound and does not need to be — the content decides, and `.note__body`'s
 * own cap in the stylesheet is what keeps it on the glass.
 *
 * Where a viewport is smaller than the floor the `Math.max` decides for the floor, on the argument
 * `clampPoint` makes: the honest answer when there is nowhere to fit is to overhang.
 */
function clampSize(w: number, h: number | null, viewport: Box): { w: number; h: number | null } {
  const maxW = Math.max(MIN_W, viewport.width - MARGIN * 2);
  const maxH = Math.max(MIN_H, viewport.height - MARGIN * 2);
  return {
    w: Math.round(Math.min(Math.max(w, MIN_W), maxW)),
    h: h === null ? null : Math.round(Math.min(Math.max(h, MIN_H), maxH)),
  };
}

/**
 * Resize one note, and pull it back onto the glass if that made it narrower.
 *
 * THE POSITION IS RE-CLAMPED BECAUSE THE LEFT BOUND MOVES WITH THE WIDTH. The clamp keeps a grabbable
 * strip of head on screen, and it does that by measuring from the note's RIGHT edge — so a wide note
 * parked mostly off the left of the window is legal exactly because it is wide, and shrinking it in
 * place would strand its head past the edge. Growing never violates the bound, shrinking can, and one
 * call covers both.
 *
 * THE SIZE IS CLAMPED HERE TOO, though every caller has already been through `dragNoteSize`. It is
 * the same bargain `moveNote` makes with its own coordinates, and it buys the invariant the window
 * resize depends on: a size that reached this map is a size that fitted the screen it was chosen on,
 * so `clampNotes` re-clamping against a new screen is the only way one can ever be out of bounds.
 *
 * The identity guard is `moveNote`'s and matters for the same reason: this fires on every pointermove
 * of a resize, and a gesture that has reached the floor or the ceiling keeps reporting the size it is
 * already at for as long as the reader keeps pushing.
 */
export function sizeNote(
  state: NotesState,
  key: CardKey,
  w: number,
  h: number,
  viewport: Box,
): NotesState {
  const held = state.placed.get(key);
  if (held === undefined) return state;
  return sizeNoteAt(state, key, held.x, w, h, viewport);
}

/**
 * Resize one note whose LEFT border moved: the position and the size arrive together.
 *
 * The general writer, and the one `sizeNote` above delegates to, so there is exactly one place that
 * clamps a note's rectangle. Every gesture that changes `x` and `w` in the same breath — the left
 * edge, the bottom-left corner — comes through here with the two already coupled by its drag helper,
 * and the clamps below are only allowed to agree with them: `clampSize` cannot disturb the anchor
 * because the helper already clamped the width against the same bounds, and `clampPoint` cannot
 * either, because every place this module stores satisfies `x + w >= MARGIN + GRAB_W` and that is
 * precisely the bound it enforces.
 *
 * `h` IS NULLABLE HERE and `sizeNote`'s is not, which is the asymmetry the side edges need: a width
 * drag writes back the `null` it found rather than converting the note to a fixed height on its way
 * past. See `EdgePress`.
 */
export function sizeNoteAt(
  state: NotesState,
  key: CardKey,
  x: number,
  w: number,
  h: number | null,
  viewport: Box,
): NotesState {
  const held = state.placed.get(key);
  if (held === undefined) return state;
  const size = clampSize(w, h, viewport);
  const at = clampPoint(x, held.y, viewport, size.w);
  if (at.x === held.x && at.y === held.y && size.w === held.w && size.h === held.h) return state;
  const placed = new Map(state.placed);
  placed.set(key, { ...held, x: at.x, y: at.y, w: size.w, h: size.h });
  return { ...state, placed };
}

/**
 * The nearest point to (x, y) that keeps a grabbable strip of the note's head on the glass.
 *
 * The bounds are computed rather than declared because a viewport can be narrower than a note is
 * wide, in which case the floor is above the ceiling and `Math.max` decides: the note pins to the
 * left margin and hangs off the right, which is the honest answer when there is nowhere for it to
 * fit. Whole pixels, for the reason the dock's rectangle rounds — a fractional left makes the
 * browser resample every glyph on the sheet.
 *
 * THE WIDTH IS PASSED IN RATHER THAN READ FROM `NOTE_W`, because notes are not all one width any
 * more. It is the note's OWN width that decides how far left it may go — the strip this protects is
 * measured back from the right edge — so a note dragged wide may sit further off the left of the
 * window than a narrow one, and both keep the same amount of head in reach.
 */
function clampPoint(x: number, y: number, viewport: Box, width: number): { x: number; y: number } {
  const minX = MARGIN + GRAB_W - width;
  const maxX = Math.max(minX, viewport.width - MARGIN - GRAB_W);
  const minY = MARGIN;
  const maxY = Math.max(minY, viewport.height - MARGIN - HEAD_H);
  return {
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, minY), maxY)),
  };
}

// -- the bin ---------------------------------------------------------------------------------------

/** A rectangle read off the screen, in viewport pixels — what `getBoundingClientRect` hands back,
 * narrowed to the four numbers this module needs. */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Whether a pointer at (px, py) is over that rectangle.
 *
 * A NULL RECT IS "NO", which is the case that matters: the bin's element is read once at the press,
 * and a gesture that began before the corner column mounted must not delete anything. Half-open on
 * the far edges, matching `elementFromPoint` and every other hit-test a browser does, so two
 * rectangles that share an edge do not both claim the pixel on it.
 */
export function overRect(rect: Rect | null, px: number, py: number): boolean {
  if (rect === null) return false;
  return px >= rect.x && px < rect.x + rect.width && py >= rect.y && py < rect.y + rect.height;
}

// -- how a note is torn ---------------------------------------------------------------------------

/**
 * Which torn edge a note has, decided once from its key.
 *
 * ONE PAPER AND THREE EDGES, which is the whole of a note's dress now. This function used to deal a
 * colour as well, off a pad of ten light tints, under a paragraph explaining at length that the
 * colour MEANT NOTHING — not the record's family, not its age, nothing. Every sheet in the window is
 * the same sage paper today (`styles/paper.css`), which says that same thing and leaves nothing to
 * read into: two notes side by side differ by what is written on them, which was always the only
 * difference either of them had. What survives is the EDGE, because a torn edge is not a code — it
 * carries no ten-way vocabulary a reader could mistake for a filing system, it is three ways for a
 * sheet to have been pulled off a pad.
 *
 * A HASH AND NEVER A RANDOM NUMBER. A note's edge must survive re-renders, reloads and the note above
 * it closing; a sheet that re-tore itself when an unrelated card left the board would be movement in
 * the corner of the eye with no fact behind it. djb2 over the card key, which is stable for as long
 * as the record is. No TILT is drawn from it either: a note is straight, and the argument for that is
 * in `NoteBoard.css`.
 *
 * The three answers are the three `deckle` filters `ChalkDefs.tsx` declares, and the range is a
 * contract between the two — a fourth seed there is a `% 4` here.
 */
export function noteDeckle(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return h % 3;
}
