/**
 * Everything the reader has open, as sticky notes stuck to the board: records, read whole.
 *
 * A NOTE IS A THING ON A BOARD, NOT A ROW IN A RAIL. A fixed column down the right edge, one
 * scrollbar for the lot of them, arriving in the order they were opened and leaving in it, describes
 * a LIST — and a sticky note that cannot be moved is a list item wearing paper. So each open card is
 * an `<article>` with a place of its own: it lands on an empty part of the slate, the reader drags it
 * anywhere by its head, notes overlap the way paper overlaps, and touching one brings it forward.
 * Where each of them sits is `state/notes.ts`'s; what is here is the drawing.
 *
 * NOTHING IS TRANSPARENT, so a note simply covers what is under it — the graph's boxes, the chalk
 * instructions written on the slate, the conversation. That is the deal the board offers and it is
 * why the instructions can be written on the board at all: a reader with six notes open has buried
 * them, and moving a note is how you read what is underneath, exactly as it would be on a real one.
 *
 * EVERY NOTE IS THE SAME PAPER and only its TORN EDGE is dealt — one of three, hashed from the
 * card's key, so a note tears the same way across re-renders and reloads without a random number
 * ever being drawn during a render. There were ten tints here once, under a paragraph explaining
 * that the colour meant nothing: not the record's family, not its age. One sage pad says that with
 * nothing left to read into, and what tells two notes apart is what is written on them — starting
 * with the table, which is a chip on every note's head.
 *
 * THE PANEL IS A BOARD RATHER THAN A SINGLE CURSOR. One selection, one detail, one error, and
 * opening anything closing whatever was there is defensible while a record is read alone; it stops
 * being defensible the moment a reader follows edges — a report and the thesis it stands on are read
 * one after the other, and a panel that can hold one thing makes that a feat of memory. The rules
 * about what is open live in `state/cards.ts`.
 *
 * AN EDGE CLICK FOLLOWS FROM THAT. Clicking an edge drawn inside a card opens the record it names as
 * a card of its own rather than RE-POINTING this panel, so following "what is this report standing
 * on" leaves the report on screen and the trail is readable as a stack when you get there. A panel
 * that re-pointed would make walking two steps out and back the only way to see a record and the
 * thing it stands on together.
 *
 * ONE KIND OF CARD, AND IT IS A READING. There were four — a record, and the three blank forms that
 * made a place to publish into, recorded an information source and wrote a specification. Nothing in this
 * window writes to the database now: a record is created, corrected, renamed and deleted by asking
 * the agent in the conversation. There is still no whole-panel precedence — error, then loading,
 * then the document — because a per-card state machine is the only shape that works once two cards
 * can be in different states at once.
 *
 * A REPORT IS NOT A ROW, and this is the one place that difference is drawn. A published report is
 * this product's OUTPUT — a self-contained HTML file the agent wrote, served same-origin with
 * `nosniff` and no-store — so it is displayed by pointing an `<iframe>` at it and doing nothing else.
 * Nothing here fetches the file, parses it or restyles it; any of those would show a rendering of the
 * report rather than the report, and the reader is auditing what was published. There is deliberately
 * no `sandbox` attribute: the reports embed ECharts and run it on load, and sandboxing would be
 * protecting the app from its own output while the same bytes open unsandboxed the moment anybody
 * double-clicks the file.
 *
 * THE FRAME NEEDS AN EXPLICIT HEIGHT and this is the one piece of CSS trivia worth stating in a
 * component. An iframe is `height: 100%` OF something, and a stack has nothing to offer it: its rows
 * are auto-sized, so `height: 100%` inside an auto row resolves against nothing and collapses to the
 * iframe's own default — a report through a letterbox. `.viewer__frame` therefore states a height,
 * and the narrow layout in `base.css` documents the same failure from the other end.
 *
 * The frame is REMOUNTED rather than re-pointed, keyed on the record, that card's own publish nonce
 * and its own reload counter. A report IS its id, so republishing puts new bytes behind the SAME
 * `/reports/<id>` URL: `src` does not change, and assigning it again would show the document already
 * in hand. Re-pointing a live iframe also pushes an entry onto the joint session history, which
 * quietly turns the browser's back button into "previous report". The nonce is per card because two
 * reports can be open at once and only one of them was just rewritten.
 *
 * ── THE MAGNET IS THE CLOSE, AND CLOSING LOSES NOTHING ────────────────────────────────────────────
 *
 * A RUST MAGNET AT THE TOP RIGHT OF EVERY NOTE, and pressing it takes the note down. It is the
 * control and not trim: a magnet is what holds a piece of paper to a board, taking it off is what a
 * hand does to get the paper back, and a window that draws one and then asks the reader to press a
 * `✕` beside it is drawing furniture it does not mean. One colour and one corner — and the same one
 * colour and corner on every sheet in the window, not only on these, because a control that moved
 * between corners or hues by surface is a close button somebody has to look for.
 *
 * IT ASKS NOTHING, AND THAT IS A CONSEQUENCE RATHER THAN A SIMPLIFICATION. A note used to be able to
 * hold a half-typed name or seven half-filled fields — text that existed in this window and nowhere
 * else, one `PATCH` away from being a record and with nothing on the server to come back to — so
 * closing over it was a silent discard and a confirmation was the gesture's second half. Every note
 * is a READING now, so there is nothing on one that closing can lose, and a question with only one
 * safe answer is a question not worth asking.
 *
 * THERE IS NO "CLOSE EVERYTHING" ALL THE SAME. A board of things somebody placed does not want a
 * button that sweeps it: the notes are on screen because a reader put each of them there, and taking
 * six down in one press is a gesture that is only ever right by accident.
 *
 * ── DRAGGING, WHICH IS TWO GESTURES THAT MUST NOT MEET ────────────────────────────────────────────
 *
 * THE HEAD MOVES THE NOTE AND THE BODY CARRIES THE RECORD. A note is moved with a captured pointer
 * (`usePointerDrag`), and the identity band, the prose blocks and the field rows inside it are
 * HTML5 drag sources that put a mention in the composer. Those two mechanisms cannot share one
 * gesture — `GraphPanel.tsx` documents the same collision, which is why only a node's title bar
 * moves the box — so they are kept to different halves of the note: the head is the handle, and
 * nothing in the head is draggable in the browser's sense.
 *
 * LETTING GO OVER THE BIN SAYS SO IN THE CONVERSATION, which is the one thing hung off the end of a
 * drag in this window and the reason `usePointerDrag` distinguishes a pointerup from a pointercancel
 * at all. A captured pointer fires no drop events, so the Bin's rectangle is read at the press and
 * hit-tested here; the store's `dropOnBin` is the same entry a dragged graph row reaches, so both
 * gestures say the same sentence and get the same answer.
 * ── AND WHAT THE PANEL WILL WRITE, WHICH IS NOTHING ──────────────────────────────────────────────
 *
 * NOTHING SHOWN HERE WAS WRITTEN BY THE THING SHOWING IT, which is the property that makes an audit
 * surface trustworthy — and it is now true without qualification. Three tables used to carry a form,
 * on the grounds that a specification and an information source are the READER's own
 * documents rather than the agent's account of what it did. That distinction still holds and is no
 * longer the whole question: a row typed into a form arrives in the archive with no account of what
 * it was for, and a row asked for in the conversation arrives with the whole exchange behind it. So
 * every write moved to the chat, and this panel reads.
 *
 * THE ONE COLUMN DRAWN AS A DOCUMENT IS DRAWN ONCE. `recipe.content` is rendered as the document
 * it is rather than as a paragraph in the field grid, so it is not also drawn as a promoted prose
 * block or a grid row — the same text twice would be one record making two claims about itself.
 * `RecordDocument.tsx` is where that list lives, one table long.
 *
 * CARRYING A RECORD INTO A SENTENCE IS A COLUMN'S GESTURE HERE, and only a column's. A field row
 * drags as `@table:id#column` and a promoted prose block drags as the same thing, so "look at the
 * `seikan_report` on this assessment" is one gesture instead of a mention plus a sentence naming the
 * column. There is no WHOLE-record version on a note — no ⧉ that puts this card in the composer, no
 * identity band dragging as the bare `@table:id` — because that gesture belongs where a whole record
 * is a thing you point at rather than a thing you are reading: every row in the GRAPH drags. A note
 * is the record OPENED, and a control that copies its address is furniture at that point.
 *
 * The field grid is where that gets awkward, and the awkwardness is worth naming because it looks
 * like an oversight otherwise. `<dt>` and `<dd>` are DIRECT CHILDREN of the grid; wrapping a pair in
 * a `<div>` breaks the two-column track, and `display: contents` on that wrapper fixes the layout and
 * then hands the browser a drag source with no box — no drag image, nothing under the cursor. So both
 * halves of a pair carry the same handlers and are paired back together IN CSS with `:has`, rather
 * than by a `hovered` column in React state: the pointer already knows which row it is over, and
 * mirroring that into a store would re-render the whole record — every edge list under it — on each
 * crossing of a 20-row grid, to paint a background the stylesheet can paint by itself.
 *
 * WHAT THE GRAPH ALREADY SAYS, THIS NOTE DOES NOT REPEAT. No record closes with a "Points to" and a
 * "Pointed at by" section — every edge in both directions, listed with the column that carries it,
 * what the database does when either end is deleted, and their own pagination. The board this note
 * is stuck to IS that picture, and every one of those edges is a line the reader is looking at.
 */

import { Fragment, useEffect, useRef, useState, type ReactElement } from "react";

import type { RecordCard, RecordDetail } from "../lib/api.ts";
import { formatAbsolute, formatRelative, useTicker } from "../lib/time.ts";
import type { Field, TextEntry } from "../lib/viewer.ts";
import { isMoment, primaryTextEntries, reportSource, restFields } from "../lib/viewer.ts";
import type { Card, CardState } from "../state/cards.ts";
import { cardStack } from "../state/cards.ts";
import { usePointerDrag } from "../lib/pointerDrag.ts";
import { dragHandlers } from "../lib/recordDrag.ts";
import {
  NOTE_W,
  dragNoteLeft,
  dragNoteRight,
  dragNoteSize,
  dragNoteSizeLeft,
  noteDeckle,
} from "../state/notes.ts";
import type { EdgePress, LeftSizePress, Rect, SizePress } from "../state/notes.ts";
import {
  clampNotesToViewport,
  closeCard,
  dropOnBin,
  moveNoteTo,
  overBin,
  raiseNoteAction,
  recordPayloadOf,
  reloadCard,
  resizeNoteAt,
  resizeNoteTo,
  setBinHot,
  useCards,
  useNotePlace,
} from "../state/store.ts";
import { binRect } from "./binTarget.ts";
import { CodeBlock } from "./CodeBlock.tsx";
import { InfoDot } from "./InfoDot.tsx";
import { fieldNote } from "../lib/fieldNotes.ts";
import { RecordDocument, editedColumns } from "./RecordDocument.tsx";
import "../styles/paper.css";
import "./NoteBoard.css";

/** The one timer behind every relative stamp on this board — see the note on `useTicker`. A minute is
 * the finest thing `formatRelative` distinguishes. */
const STAMP_INTERVAL_MS = 60_000;

export function NoteBoard(): ReactElement | null {
  const cards = useCards();
  useTicker(STAMP_INTERVAL_MS);
  useClampOnResize();
  const stack = cardStack(cards);

  // The board unmounts ITSELF while no card is open: it floats over the graph rather than sharing a
  // grid with it, so there is no divider to take with it and nobody else needs to know. The note
  // that appears IS the record appearing.
  if (stack.length === 0) return null;

  return (
    /*
     * A pane over the whole window that is transparent to the pointer, with notes that are not —
     * the `.lcd-stack` dance, for the same reason: a sheet of glass over the board must not swallow
     * the pans and double-clicks meant for the canvas under it. Notes are positioned against THIS
     * rather than the viewport, which is the same rectangle: it is `position: fixed` with no
     * transformed ancestor, so a note's `left`/`top` are viewport pixels, which is what the store
     * clamps them as.
     */
    <div className="noteboard" aria-label="Open records">
      {stack.map((held) => (
        <StickyNote key={held.key} state={held} focused={cards.focused === held.key} />
      ))}
    </div>
  );
}

/**
 * Pull the notes back onto a window that has changed size.
 *
 * A laptop undocked from a monitor is the ordinary case rather than the edge one, and a note left
 * outside the glass is a record that can only be closed by reloading the page. The clamp itself is
 * `state/notes.ts`'s and hands back the same state — down to each untouched note's own place object
 * — when nothing was stranded, so a resize that moves nobody costs no re-render at all.
 */
function useClampOnResize(): void {
  useEffect(() => {
    const onResize = (): void => clampNotesToViewport();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
}

// -- one note ---------------------------------------------------------------------------------------

/** What a note's head remembers at the press: where the note was, where the pointer was, and where
 * the Bin is. All three read ONCE — `usePointerDrag`'s contract — because a distance measured from a
 * fixed start means something different if what it is measured against moves halfway through. */
type NotePress = { x: number; y: number; px: number; py: number; bin: Rect | null };

/**
 * How far a pointer must travel before the gesture counts as a drag at all.
 *
 * A press that never moves is a CLICK on the head — which raises the note and does nothing else —
 * and the whole reason to tell the two apart is that letting go over the Bin says something in the
 * conversation about this record. A note whose head happens to be over the corner instruments would
 * otherwise ask about deleting itself every time somebody touched it to bring it forward.
 */
const DRAG_SLOP = 4;

/**
 * One note on the board: a head that moves it and can act on it, and a body that answers for itself.
 *
 * The head is deliberately drawn from the card rather than from what came back, so it has a title
 * from the instant it appears — a note opened from a mention pill starts with whatever the pill knew
 * to call it, and a heading that waited for the fetch would be blank for as long as the network
 * takes.
 */
function StickyNote({ state, focused }: { state: CardState; focused: boolean }): ReactElement | null {
  const [reloads, setReloads] = useState(0);
  // The one element this file measures, and only ever at a pointerdown — see the resize gesture below
  // on why a note that has never been resized has a height only the browser knows.
  const sheetRef = useRef<HTMLElement | null>(null);
  // Subscribed to PER NOTE, and the store hands back the stored object rather than a fresh one, so a
  // drag re-renders the note being dragged and no other. See `useNotePlace`.
  const place = useNotePlace(state.key);
  const deckle = noteDeckle(state.key);

  const title = cardTitle(state.card, state.detail);
  const source = state.detail === null || state.error !== null ? null : reportSource(state.detail);

  /**
   * The head's drag: move the note, light the Bin when it is over it, and act on letting go.
   *
   * `end` fires on pointerup ALONE — never on a cancelled gesture — which is `usePointerDrag`'s one
   * asymmetry and exists for this handler: a pointercancel is the browser taking the gesture away,
   * and reading that as "dropped on the Bin" would say something about a record nobody let go of.
   */
  const drag = usePointerDrag<NotePress>(
    (event) => {
      raiseNoteAction(state.key);
      return {
        x: place?.x ?? 0,
        y: place?.y ?? 0,
        px: event.clientX,
        py: event.clientY,
        // Read at the press rather than on every move: the corner column is bolted to the bottom
        // edge and nothing moves it mid-gesture, and a `getBoundingClientRect` per pointermove is a
        // forced layout sixty times a second.
        bin: binRect(),
      };
    },
    (from, dx, dy) => {
      moveNoteTo(state.key, from.x + dx, from.y + dy);
      setBinHot(overBin(from.bin, from.px + dx, from.py + dy));
    },
    (from, dx, dy) => {
      setBinHot(false);
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      if (!overBin(from.bin, from.px + dx, from.py + dy)) return;
      // Every note is a record, so every drop has a row to name. The note stays where the reader
      // dropped it: the Bin asks a question in the conversation now, and taking the note down before
      // the answer arrives would hide the record the answer is about.
      dropOnBin(recordPayloadOf(state.card, title));
    },
  );

  /**
   * What every gesture with a VERTICAL component remembers at the press.
   *
   * THE HEIGHT IS MEASURED HERE AND NEVER AGAIN, which is the one DOM read in these gestures and the
   * reason it is a read at all. A note that has not been resized has `h === null` — as tall as what
   * is written on it — and there is no number to add `dy` to until somebody asks the browser. Asking
   * once, at the press, is the same bargain `binRect()` makes two handlers up: a
   * `getBoundingClientRect` per pointermove is a forced layout sixty times a second, and a height
   * re-read mid-gesture would change the meaning of a distance measured from a fixed start.
   *
   * Measuring is also what CONVERTS a note to a fixed height, so only the gestures that are actually
   * about the height do it — the two corners and the bottom edge. The sides use `edgeBegin` below.
   */
  const sizeBegin = (): SizePress => ({
    w: place?.w ?? NOTE_W,
    h: place?.h ?? sheetRef.current?.offsetHeight ?? 0,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });

  /** What a side edge remembers: no measurement, and the height carried through exactly as it stands.
   * A drag that only changes the width must not spend the one-way trip to a fixed height — see
   * `EdgePress` in `state/notes.ts`. `x` is here because the left edge's anchor is its right border. */
  const edgeBegin = (): EdgePress => ({
    x: place?.x ?? 0,
    w: place?.w ?? NOTE_W,
    h: place?.h ?? null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });

  /**
   * The five resize gestures: two corners and three edges. The top edge is not among them — that
   * strip is the head, and dragging it moves the note.
   *
   * No `end` handler on any of them: unlike the head's drag, nothing is hung off letting go — the
   * size is already written on every move, and a cancelled resize leaves the note at the last size
   * the reader saw.
   */
  const resize = usePointerDrag<SizePress>(sizeBegin, (from, dx, dy) => {
    const size = dragNoteSize(from, dx, dy);
    resizeNoteTo(state.key, size.w, size.h);
  });

  // The bottom edge is the corner with its horizontal half discarded, rather than a fourth helper.
  const resizeBottom = usePointerDrag<SizePress>(sizeBegin, (from, _dx, dy) => {
    const size = dragNoteSize(from, 0, dy);
    resizeNoteTo(state.key, size.w, size.h);
  });

  const resizeLeft = usePointerDrag<EdgePress>(edgeBegin, (from, dx) => {
    const at = dragNoteLeft(from, dx);
    resizeNoteAt(state.key, at.x, at.w, from.h);
  });

  const resizeRight = usePointerDrag<EdgePress>(edgeBegin, (from, dx) => {
    const at = dragNoteRight(from, dx);
    resizeNoteAt(state.key, from.x, at.w, from.h);
  });

  const resizeLeftCorner = usePointerDrag<LeftSizePress>(
    () => ({ x: place?.x ?? 0, ...sizeBegin() }),
    (from, dx, dy) => {
      const at = dragNoteSizeLeft(from, dx, dy);
      resizeNoteAt(state.key, at.x, at.w, at.h);
    },
  );

  function reload(): void {
    setReloads((count) => count + 1);
    reloadCard(state.key);
  }

  // At most one frame, and only if a caller ever opened a card without placing it: a note with
  // nowhere to be would otherwise draw itself at the board's origin and then jump.
  if (place === null) return null;

  return (
    <article
      ref={sheetRef}
      className={[
        "note",
        "paper",
        focused ? "note--focused" : "",
        // Only once a height has been chosen. The modifier is what turns the note into a column that
        // gives its body the leftover room, and applying it to a note that is still content-sized
        // would be a flex container with nothing to distribute.
        place.h === null ? "" : "note--sized",
      ]
        .filter(Boolean)
        .join(" ")}
      /* The whole geometry, inline, on the bargain `state/notes.ts` names: one copy of each figure,
         and the stylesheet declares none of it. `height` stays off entirely while `h` is null, which
         is what leaves an unresized note as tall as what is written on it. */
      style={{
        left: place.x,
        top: place.y,
        zIndex: place.z,
        width: place.w,
        ...(place.h === null ? {} : { height: place.h }),
      }}
      /*
       * TOUCHING A NOTE ANYWHERE BRINGS IT FORWARD, and this is the one handler in the file that is
       * allowed to be this broad. Capture phase, so it runs before anything inside the note stops
       * the event; no `preventDefault` and no `stopPropagation`, so the press goes on to do whatever
       * it was going to do — put a caret in a textarea, start a drag, press a button. Raising is a
       * no-op for the note that is already in front, which is what stops a keystroke into a form
       * from writing to the store.
       *
       * Note this is NOT `focusCard`. Focus is the store's mark for "what the last gesture opened",
       * drawn as a ring; z-order is "what is on top". Clicking a note should do the second and not
       * the first — a ring that followed the pointer would stop meaning anything.
       */
      onPointerDownCapture={() => raiseNoteAction(state.key)}
      aria-label={title}
    >
      {/* The sheet is trim, not content: an absolute layer under the text, hidden from the
          accessibility tree. The deckle filter lands on the SHEET only, never on an ancestor of the
          words, so the paper's edge wobbles and the glyphs do not. */}
      <div className="note__paper paper__sheet" data-deckle={deckle} aria-hidden="true" />
      {/*
       * THE MAGNET, WHICH IS THE CLOSE. A real button wearing the material sheet's magnet: the same
       * glossy rust stone that closes the confirmation dialog, the corner instruments and a toast,
       * at the top right of every sheet in the window without exception. See this file's header for
       * why the ✕ it replaces was furniture the board did not mean. It sits OUTSIDE the head rather
       * than in it, so its presses never reach the head's drag handler, and `paper.css` gives it a
       * z-index that keeps it above both.
       */}
      <button
        type="button"
        className="note__close paper__magnet paper__magnet--red"
        aria-label={`Close ${title}`}
        title="Take this note down"
        onClick={() => closeCard(state.key)}
      />
      {/*
       * THE HEAD CARRIES NO TITLE, and its going is the largest single thing this note stopped
       * saying. The record's name was written here, again as the heading of the identity band under
       * it, and a third time inside the box that renamed it — one row making the same claim three
       * times in the first 300 pixels of a note 400 wide. That box has gone too, now that a rename is
       * asked for in the conversation, so the name is drawn exactly once: as the `name` row of the
       * field grid, like every other stored column. It is also on the article's `aria-label` and on
       * every control's title, where it is an accessible name rather than a line of text.
       *
       * What is left is the strip's other two jobs: the one word saying which table this record came
       * out of, and the controls at the far end. The whole strip is still the drag handle.
       */}
      <header className="note__head" {...drag}>
        {/* Which table this record came out of. A stack of notes with similar titles is unreadable
            without it, and it is the one word about a card that never changes while it is open. */}
        <span className="chip note__kind">{state.card.table}</span>
        <span className="note__spacer" />
        {/*
         * Every control on this strip stops its own pointerdown, and without it none of them work:
         * the drag `preventDefault`s the press to keep it from selecting text, and a defaulted-away
         * press is a press the browser never synthesises a click from. The same line `GraphPanel`
         * needs on the `+` in a node's title bar, for the same reason.
         */}
        <button
          type="button"
          className="btn btn--icon"
          aria-label={`Read ${title} again`}
          // Never disabled, and there is nothing left for it to be disabled FOR: it used to grey out
          // on the three blank forms, which had no row behind them to re-read. Every note is a
          // reading now, so the ↻ always has something to ask about.
          title="Read this again"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={reload}
        >
          <span aria-hidden="true">↻</span>
        </button>
        {source === null ? null : (
          <a
            className="btn btn--icon viewer__open"
            href={source}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${title} in a new tab`}
            title={`Open ${title} in its own tab`}
            onPointerDown={(event) => event.stopPropagation()}
          >
            ↗
          </a>
        )}
      </header>

      <div
        className="note__body scroll-y"
        // Only ever true for a read somebody asked for. The debounced refresh behind a live turn
        // deliberately does not set it — see `refreshCards` — so this never flickers while the agent
        // is writing to a record on screen.
        aria-busy={state.loading}
      >
        <CardBody state={state} reloads={reloads} />
      </div>

      {/*
       * THE EDGES AND THE CORNERS, ON EVERY NOTE. They were on records alone while three of the four
       * kinds of card were forms the size of the questions on them, where a grip would have offered
       * to change a number that changed nothing worth looking at. A record is the case these exist
       * for and is now the only case: a script's source, a thesis, a table of runs, all of them
       * arriving on a sheet 400 wide with a cap on how far down it may go.
       *
       * THE STRIPS COME FIRST AND THE GRIPS LAST, because none of them carries a z-index and among
       * positioned siblings the later one wins the overlap. That order is what leaves the two 18px
       * corners showing their diagonal cursors instead of the edge cursors of the strips they lie on
       * top of. The close magnet sits above the right-hand strip on its own `z-index: 3`, declared
       * with the magnet in `styles/paper.css`.
       *
       * All of them inert to the accessibility tree — a resize is a pointer affordance and there is
       * nothing here for a keyboard to land on. Their pointerdown is
       * stopped by `usePointerDrag` before the article's capture-phase raise ever sees it, which is
       * fine: raising is what that handler does and a resize should raise too, and the capture
       * listener runs first either way.
       */}
      <div className="note__edge note__edge--left" aria-hidden="true" {...resizeLeft} />
      <div className="note__edge note__edge--right" aria-hidden="true" {...resizeRight} />
      <div className="note__edge note__edge--bottom" aria-hidden="true" {...resizeBottom} />
      <div
        className="note__resize note__resize--left"
        aria-hidden="true"
        title="Drag to resize"
        {...resizeLeftCorner}
      />
      <div className="note__resize" aria-hidden="true" title="Drag to resize" {...resize} />
    </article>
  );
}

/** What a card is called: what the row says the moment the row arrives, and what the clicked label
 * said until then — which is the truth about what was clicked, and better than a placeholder naming
 * nothing. See `Card.label` in `state/cards.ts` for why an unread card has something to draw. */
function cardTitle(card: Card, detail: RecordDetail | null): string {
  return detail?.card.name ?? card.label;
}

/**
 * The per-card state machine.
 *
 * The order is an argument rather than a sequence: a failed read is not an empty answer, a record
 * that has not arrived is not a record with nothing in it, and a document is not a row.
 */
function CardBody({ state, reloads }: { state: CardState; reloads: number }): ReactElement {
  const card = state.card;

  /*
   * WHAT THE RECORD IS CALLED, IN THE TWO STATES THAT HAVE NOTHING ELSE TO SAY IT.
   *
   * Everywhere else on a note the name is the `name` row of the field grid — which is the whole
   * reason the head draws no title of its own. But a grid needs a ROW: a card that is still reading,
   * or one whose read was refused, has none and therefore nothing at all on it naming the record.
   * "no thesis 9f2c8a4e…", on a board holding five other notes, is a sentence about nothing. The
   * label the card was OPENED with is what goes here, because it is exactly what is known at that
   * moment and it is what the reader clicked.
   */
  const subject = cardTitle(card, state.detail);

  if (state.error !== null) {
    // On the card and never as a toast. A row deleted since it was drawn, or an id that outlived the
    // record, is an ANSWER about the thing being looked at — and about THIS card rather than about
    // the four others on the stack. The server's own sentence is shown verbatim; rewording it here
    // would be inventing a friendlier lie.
    return (
      <div className="resource__refusal">
        <p className="viewer__subject">{subject}</p>
        <p className="resource__refusal-text">{state.error}</p>
        <button type="button" className="btn btn--ghost" onClick={() => reloadCard(state.key)}>
          Try again
        </button>
      </div>
    );
  }

  if (state.detail === null) {
    return (
      <div className="viewer__waiting">
        <p className="viewer__subject">{subject}</p>
        <p className="empty">Reading this record&hellip;</p>
      </div>
    );
  }

  const source = reportSource(state.detail);
  if (source !== null) {
    /*
     * A report's body is its document, full bleed, and nothing is drawn above it. There used to be a
     * rename box up there — a report never reaches `RecordBody`, so without one it would have been
     * the single record in the archive nobody could rename. Nothing renames anything from this
     * window now, so the hole in the affordance has closed from the other side: a report is renamed
     * by asking, exactly like every other row.
     */
    return (
      <iframe
        // Remounted, not re-pointed. See this file's header for both halves of why, and for why
        // the stylesheet has to give this an actual height.
        key={`${card.id}:${state.nonce}:${reloads}`}
        className="viewer__frame"
        src={source}
        title={state.detail.card.name}
      />
    );
  }

  return <RecordBody detail={state.detail} />;
}

// -- a record that is not a document ---------------------------------------------------------------

/**
 * What the row stores, what it draws for itself, and what it says — in that order.
 *
 * WHAT A NOTE DOES NOT OPEN OR CLOSE WITH, AND WHY IT WOULD ALL BE ONE MISTAKE. There is no identity
 * band — the name again, the table again, the computed description, the age — and no two sections
 * listing every record this one points at and every record that points at it. Both would be answers
 * to questions the reader can already see answered:
 *
 *   The NAME is the first row of the field grid, drawn like every other stored column now that
 *   nothing on this card writes one. Two drawings of one string is not two pieces of information.
 *
 *   The TABLE is the chip on the note's own head.
 *
 *   The AGE is the `created_at` row of the record as stored, said in the same words this window says
 *   every other stamp in.
 *
 *   And the EDGES are the graph. That is what the graph IS — every join in this database drawn as a
 *   line between two boxes, on the board this note is stuck to. Re-listing them in words, under
 *   headings, with per-edge deletion notes and their own pagination, would be this panel arguing
 *   that a reader cannot see a link they are looking at.
 *
 * The order that remains is an auditor's. You check the row as stored — its name, its stamps and the
 * ids behind it — and then you read whatever prose it exists to hold, which is the longest thing on
 * the card and therefore the last, so that nothing a reader is looking for sits below a thesis. The
 * one document left sits between the two, because on the one table that has it the document IS the
 * record and the grid above it is bookkeeping.
 */
function RecordBody({ detail }: { detail: RecordDetail }): ReactElement {
  const card = detail.card;
  // A column drawn as a document is drawn there and nowhere else — see `RecordDocument.tsx`. The
  // filter
  // is applied AFTER both readings rather than inside them, because `primaryTextEntries` and
  // `restFields` are complementary by construction and narrowing one of them would quietly move a
  // column into the other.
  const edited = new Set(editedColumns(card.table));
  const prose = primaryTextEntries(detail).filter((entry) => !edited.has(entry.name));
  // In the row's own order, which is now every table's — see the note below this component on the
  // per-table reordering that used to sit here and what took its last entry away.
  const fields = restFields(detail).filter((f) => !edited.has(f.name));

  return (
    <div className="viewer__record">
      {fields.length === 0 ? null : (
        <dl className="viewer__fields">
          {fields.map((field) => (
            <FieldRow card={card} field={field} key={field.name} />
          ))}
        </dl>
      )}

      {/* What this table draws for itself, which is nothing at all on ten of the eleven tables —
          see `RecordDocument.tsx` on why the list is one long and why it is a switch. */}
      <RecordDocument detail={detail} />

      {prose.map((entry) => (
        <ProseSection card={card} entry={entry} key={entry.name} />
      ))}
    </div>
  );
}

/*
 * THERE IS NO PER-TABLE FIELD ORDER, and the absence is what is left of one that had exactly one
 * entry.
 *
 * `FIELD_ORDER` mapped a table to the columns that should come first, and one table used it: a
 * recipe, whose `created_at` was pulled above its own columns because the date is what a reader of a
 * version is actually after and the number was bookkeeping. The number then left the window
 * altogether — it is not in the row a detail hands back (`rowColumns` in `repo/records.ts`), it is
 * not in the label, and no sentence anywhere in this window says one — which left that entry
 * ordering a list of one column against nothing.
 *
 * A map with no entries and a stable partition nothing exercises is worse than neither: the next
 * table to want a different order would inherit a mechanism nobody has looked at, and this file's
 * `-- cards and rows --` neighbour in `base.css` makes the same argument about a base rule with no
 * callers. So the fields are drawn in the row's own order, and the day a table genuinely reads
 * better another way is the day to write this again — here, because `lib/viewer.ts` answers which
 * columns are prose, addresses and stamps (facts about the schema, tested as such) while "this table
 * reads better with these first" is a fact about this note.
 */

// -- one column of it -------------------------------------------------------------------------------

/**
 * A promoted paragraph, and the column it was promoted OUT OF, as one thing you can carry away.
 *
 * The drag lives on the HEADING ROW and not on the `<section>`, and that is the one decision here
 * worth arguing. A `draggable` ancestor swallows text selection inside it: the browser resolves a
 * press-and-drag over the text as "drag this element", and `draggable={false}` on the `<pre>` does
 * not win it back — Chrome walks past a non-draggable child to the draggable parent above it. A
 * thesis's argument is the most selection-worthy text in this window and the reason an auditor opens
 * the record at all — and a recipe's content is the text somebody selects a rule out of to
 * quote at the agent while asking for the next version — so the grab affordance goes where there is no
 * prose to fight with. The PAYLOAD is still the whole section's meaning — `@table:id#content` — which
 * is what "the section drags" has to mean once the pointer is taken into account.
 *
 * The field grid below cannot make the same trade: its two cells ARE the row, so its value cell drags
 * too. What is left in it after `lib/viewer.ts` has promoted the prose out is ids, digests and stamps
 * — short values a double click still takes whole, which is the selection gesture a drag source does
 * not intercept.
 */
function ProseSection({ card, entry }: { card: RecordCard; entry: TextEntry }): ReactElement {
  const drag = dragHandlers(card, entry.name);

  return (
    <section className="viewer__prose">
      <div className="viewer__prose-head" {...drag}>
        {/* The column's real name, and now also what the drag says. */}
        <h5 className="viewer__prose-name">{entry.name}</h5>
      </div>
      {/*
       * A `<pre>` and nothing else, WITH ONE EXCEPTION. The newlines are the author's, and a
       * markdown pass here would turn an underscore in a ticker into italics and a hash at the
       * start of a line into a heading — this window editing a stored value on its way to the
       * screen. That argument holds for every promoted column but one: a script's source is not
       * language, it is a program, and colouring it is not editing it — the characters are the
       * stored ones, the tokens are only told apart. `CodeBlock.tsx` argues the carve-out; `script`
       * promotes exactly one column, so naming both the table and the column is the whole test.
       */}
      {card.table === "script" && entry.name === "source" ? (
        <CodeBlock code={entry.text} />
      ) : (
        <pre className="viewer__prose-text">{entry.text}</pre>
      )}
    </section>
  );
}

/**
 * One column of the row as stored, drawn as the `<dt>`/`<dd>` pair the grid wants.
 *
 * A component that renders a `<Fragment>` rather than a wrapper: React puts nothing of its own in
 * the DOM, so the two cells stay direct children of `.viewer__fields` and the two-column track
 * survives. Both carry the same handlers because either half is a plausible place to start a drag,
 * and they are lit together by `:has` in the stylesheet — see this file's header for why that
 * pairing is not a piece of React state.
 *
 * The value cell is deliberately NOT given a grab cursor even though it drags. It is the half a
 * reader points at to read, it scrolls on its own, and a `grab` over a scrollable body of monospace
 * text promises a gesture that the wheel and the scrollbar are also competing for.
 */
function FieldRow({ card, field }: { card: RecordCard; field: Field }): ReactElement {
  const drag = dragHandlers(card, field.name);
  const note = fieldNote(card.table, field.name);

  return (
    <Fragment>
      <dt className="viewer__field-name" {...drag}>
        <span className="viewer__field-label">{field.name}</span>
        {/* Only where the column's meaning is genuinely not recoverable from its name — see
            `lib/fieldNotes.ts` on why that list is short on purpose. */}
        {note === null ? null : <InfoDot about={field.name}>{note}</InfoDot>}
      </dt>
      <dd className="viewer__field-value" {...drag}>
        <FieldValue field={field} />
      </dd>
    </Fragment>
  );
}

/**
 * One stored value, as stored — except for the moments, which are drawn as times.
 *
 * A MOMENT IS THE ONE COLUMN THIS PANEL IS ALLOWED TO RESTYLE, and the exception is worth arguing
 * because everything else here is shown byte for byte. `1754702400000` is not a fact anybody can
 * read: it is a fact about how the schema stores time, and no auditor has ever checked one by eye.
 * The absolute stamp is the same instant said in words, and the relative one is on the `title` where
 * the row's own age lives everywhere else in this window. Nothing is rounded away — the tooltip and
 * the text are two spellings of the same integer.
 */
function FieldValue({ field }: { field: Field }): ReactElement {
  if (field.value === null) return <span className="tone-muted">null</span>;
  if (isMoment(field)) {
    const at = field.value as number;
    return <span title={formatRelative(at)}>{formatAbsolute(at)}</span>;
  }
  return <>{String(field.value)}</>;
}

/*
 * THERE ARE NO ⠿ GRIPS IN THIS FILE, and the argument for them is worth recording because it is a
 * good one. A small button on every field row and every promoted block would put that column in the
 * composer with a click, sitting beside the drag as the keyboard's half of it — hidden until the row
 * is hovered or the button focused, and forced visible where there is no hover to reveal it with.
 * The case against is what the reader sees rather than what they can reach: a record note is a
 * column of a dozen rows, and a dozen buttons appearing under the pointer as it travels down the
 * note is furniture moving in the corner of the eye on every one of them. The row itself IS the drag
 * source — the `<dt>`, the `<dd>` and the heading row all carry `dragHandlers` — so a grip adds a
 * second, redundant handle to a gesture that is already there.
 *
 * WHAT THAT COSTS IS REAL. There is no pointerless way to put a single COLUMN in the composer, and
 * no way at all on a touch screen, where HTML5 drag-and-drop does not fire. The whole RECORD is
 * reachable from the graph's rows, and a reader can type the mention; a column is what has no second
 * path. If that turns out to bite, the answer is not twelve buttons — it is one control on the
 * note's head that offers the columns as a list.
 */
