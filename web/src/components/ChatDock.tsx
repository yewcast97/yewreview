/**
 * The conversation, as a permanent panel down the right of the window.
 *
 * IT IS ALWAYS ON SCREEN, and that is what this file is for. A window — opened by a double click,
 * dragged by a title bar, dismissed by a ✕ — would say that a conversation is something you fetch
 * and put away. It is the other way round: there is one conversation, it belongs to the
 * installation, and the reader is always entitled to glance at it. So there is no furniture: no open
 * flag, no close button, nothing to drag it by and nowhere to put it down. The one thing the store
 * holds about this dock is HOW MUCH OF THE DESK IT TAKES, which is a fact of a different kind — it
 * says what the reader is working on this minute, not whether the conversation is on screen at all.
 *
 * WHERE IT SITS IS A RULE; HOW WIDE IT IS, IS A POSTURE. Three of its edges are the window's — top,
 * right and bottom, inset by the float margin, full height, permanently — and the fourth is the
 * board's, which is why that is the one edge with a grip on it. `state/chatDock.ts` does the
 * arithmetic from the viewport and the store's split, so the dock re-splits the window when it is
 * resized and never needs to know what else is on the board. The whole rectangle is written as an
 * inline style; `ChatDock.css` declares none of it — one copy of each figure, and no way for them to
 * drift.
 *
 * THE GRIP MOVES THE BOARD AS WELL AS THE DOCK, and the store is where that is arranged rather than
 * here: one mutation writes the split, the graph's transform and every note's place together, so the
 * two halves of the window are never a frame apart about where their boundary is. `dragDockTo` holds
 * the argument, and this component only reports the gesture.
 *
 * A CHILD OF `App` AND NOT A PORTAL, and that is a fact about the DOM rather than a preference:
 * `position: fixed` is resolved against the viewport only while no ancestor carries a transform,
 * and every element between this and the body — `.app`, and nothing else — is untransformed. The
 * one place in this window where that is NOT true is `.graph__surface`, which is translated and
 * scaled by the reader's pan; rendering the dock in there would make it a thing that pans with the
 * graph, at whatever the current zoom is.
 *
 * IT OWNS THE FRAME AND NOTHING INSIDE IT. `MessageList`, `ModelPool` and `Composer` read the store
 * directly, so nothing is passed to them. The header is what says whether the thing below is
 * listening: the conversation's name and the two status chips, none of it a handle.
 *
 * THE NAME COMES OUT OF THE SESSION LIST, WHICH IS THE ONE JOIN IN THIS FILE. There is one
 * conversation and the SDK names it — a summary written after a turn, changed by the SDK on its own
 * initiative, listed beside every other conversation this installation has had. The `ready` frame
 * deliberately does NOT carry that summary (see `lib/protocol.ts`), because the window already
 * holds one per session in its session list and `sessionId` is the join. So the title is looked up
 * rather than pushed, which means one authority for a conversation's name instead of two that can
 * disagree by a turn.
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";

import { usePointerDrag } from "../lib/pointerDrag.ts";
import type { Box } from "../state/chatDock.ts";
import { DEFAULT_SPLIT, MAX_SPLIT, MIN_SPLIT, dockRect } from "../state/chatDock.ts";
import {
  beginDockDrag,
  dragDockTo,
  newSession,
  useChat,
  useConnection,
  useDockSplit,
  useHealth,
  useOpencode,
  useSessions,
} from "../state/store.ts";
import type { ConnectionState } from "../state/ws.ts";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import { ModelPool } from "./ModelPool.tsx";
import "../styles/chalk.css";
import "./chat.css";
import "./ChatDock.css";

/**
 * What the header says while the socket is not carrying a conversation.
 *
 * `ready` is absent on purpose, and the header shows nothing at all in that state: a working
 * connection is not news, and the thing that IS worth reading once it works — which model — is said
 * by the context strip above the composer, next to the box it is about. What is left up here is the
 * conversation's name and, when there is one, the reason nothing is listening.
 *
 * THERE IS NO `gone`, and there is no state for it to name. A socket opened under a record's id
 * could be hung up with a 4004 when that record was deleted; the agent belongs to the
 * installation, so nothing in the database can take the conversation away.
 */
const STATUS: Record<Exclude<ConnectionState, "ready">, string> = {
  idle: "not connected",
  connecting: "connecting…",
  awaiting_ready: "waking the agent…",
  reconnecting: "reconnecting…",
  closed: "not connected",
};

/**
 * How far an arrow key moves the edge.
 *
 * The keyboard's whole share of this gesture, and it is a step rather than a jump to a stop: a held
 * key crosses the range in about a second, which is the drag done slowly, and a single press moves
 * the boundary by something a reader can see happen and undo with the opposite key.
 */
const NUDGE = 24;

export function ChatDock(): ReactElement {
  const viewport = useViewport();
  // Where the boundary is. Read here because this is where the rectangle is written, and until
  // there was a gesture nothing but a window resize could MOVE that rectangle — plenty re-renders
  // this component (every text delta does), but none of it used to change where the dock sits.
  const split = useDockSplit();
  const chat = useChat();
  const connection = useConnection();
  const health = useHealth();
  // Read for one thing: whether the model pool is up. It is mounted from here rather than from the
  // composer that opens it because it is a DRAWER IN THIS PANEL — a row of the body's grid, between
  // the transcript and the composer — and the body is this component's own markup.
  const poolOpen = useOpencode().poolOpen;
  // The slice comes back whole and the row is picked out HERE, per the store's selector rule: a
  // selector that returned a `find` would mint a new value on every call and hang the tab.
  const sessions = useSessions();
  // In this component and not in the store, because nothing else in the window draws it: it is a
  // control being pressed, not a fact about the installation.
  const [starting, setStarting] = useState(false);

  async function startNew(): Promise<void> {
    setStarting(true);
    try {
      await newSession();
    } finally {
      setStarting(false);
    }
  }

  const rect = dockRect(viewport, split);

  /*
   * THE DOCK PUBLISHES NO CLEARANCE, and no property for one lives on the root element. A stylesheet
   * rule saying the board stops at `50vw` would be a second opinion about a split that already has
   * one, and it would be the one that drifted — the more so now that the reader can move it. Notes
   * are placed individually: the store asks `dockRect` where the LEFT EDGE is when it puts a fresh
   * one down, at the very split this component is drawing from, so there is nothing to publish and
   * nobody to read it. The one custom property below is about the INSIDE of this panel and says
   * nothing to the board.
   */

  /*
   * The gesture itself, which is `usePointerDrag`'s and not this file's — the pointer capture and
   * the total-distance-since-the-press contract are both stated there. What is remembered at the
   * press is the store's whole snapshot, and every move applies the gesture's total travel to it, so
   * the answer is a function of where the pointer is rather than a sum over how it got there.
   */
  const grip = usePointerDrag(
    () => beginDockDrag(),
    (from, dx) => dragDockTo(from, dx),
  );

  /*
   * The dock's own scale, published to everything inside it.
   *
   * 1 at the default split and roughly [2/3, 4/3] across the range, so a thing in this panel that is
   * sized in fixed pixels — the model pool's notes, the role slots' rack — can be written as that
   * size TIMES this and shrink with the panel instead of overflowing it. It is a geometry multiplier
   * and never a type scale: ink stays at the window's size, because a narrow dock is still read at
   * arm's length. The reference width is `dockRect` at `DEFAULT_SPLIT` rather than half the viewport,
   * so it is the same rounding the rectangle above went through; a window with no room for the
   * margins has no reference to divide by and is handed 1.
   */
  const full = dockRect(viewport, DEFAULT_SPLIT).width;
  const style = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    "--dock-scale": full > 0 ? rect.width / full : 1,
  } as CSSProperties;

  /*
   * The dock's body, held across a drag — the same bargain `GraphPanel` makes with its `drawn` memo,
   * and for the same reason: the grip re-renders this component sixty times a second, and every one
   * of those renders would otherwise reconcile a whole transcript to move a rectangle. Nothing in
   * here reads the rectangle or the split. `MessageList`, `ModelPool` and `Composer` take no props
   * and read the store themselves, so the one thing this subtree depends on is whether the drawer is
   * open.
   */
  const body = useMemo(
    () => (
      <div className="chat__body">
        <MessageList />
        {/*
         * The model pool, when it is up: a drawer between the transcript and the composer, so the
         * panel a reader opened from the composer's caption arrives directly above the ROLE SLOTS
         * its notes are dragged onto, rather than in the middle of the board.
         *
         * IN THE FLOW RATHER THAN OVER IT, which is what the full-height dock made possible and
         * what the bottom dock could not allow: there, a panel drawn above the composer from INSIDE
         * the panel would have been cut off at the dock's own top edge by `.panel`'s clip — the
         * trap `Picker.tsx` describes about its sheet — so it had to be a fixed sibling positioned
         * against the dock's rectangle. A row of the body's grid needs no rectangle at all, and the
         * two copies of that arithmetic go with it.
         *
         * Nothing gates this on the harness, and nothing needs to: the one thing that can open it is
         * a word in the composer that is itself drawn only on the opencode path, so the flag cannot
         * be true anywhere else.
         */}
        {poolOpen ? <ModelPool /> : null}
        <Composer />
      </div>
    ),
    [poolOpen],
  );

  // Null in two quite different situations, and the header says the same general thing in both: a
  // fresh conversation has no id until its first turn mints one, and a conversation whose id is
  // known may not be in the list yet, because the list is a directory the SDK flushes on its own
  // cadence.
  const name =
    sessions.list.find((card) => card.sessionId === chat.sessionId)?.summary ?? null;

  return (
    <section
      className="panel chatdock"
      style={style}
      // A labelled region rather than a dialog, because that is what it is: it cannot be
      // dismissed and nothing opened it, so it is furniture of the window — and it is not modal,
      // so nothing about focus changes.
      aria-label={name === null ? "Conversation" : `Conversation — ${name}`}
    >
      {/* The drawn box: chalk border and wobble on an inert layer, never on an ancestor of the
          words — the same construction as every box in the graph. */}
      <span className="chalk-frame chalk-frame--bright chalk-frame--hollow" aria-hidden="true" />
      {/*
       * The edge, as something to hold. A `separator` and not a slider: what it divides is two parts
       * of a window rather than a quantity somebody is setting. It still has to SAY where it sits —
       * a separator that takes focus and answers the arrows is a widget, and one that reports no
       * value tells a reader it moved without telling them where to. The number is the split as a
       * percentage of the window, which is the same figure its two clamps are stated in.
       *
       * Drawn after the frame so its tint lands over the chalk rather than under it; what keeps the
       * strip REACHABLE is the `z-index` in `ChatDock.css`, because the header and the body come
       * later in this markup than it does.
       */}
      <div
        className="chatdock__grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Drag to widen or narrow the conversation"
        aria-valuenow={Math.round(split * 100)}
        aria-valuemin={Math.round(MIN_SPLIT * 100)}
        aria-valuemax={Math.round(MAX_SPLIT * 100)}
        title="Drag to widen or narrow the conversation"
        // Reachable from the keyboard, because nothing else in this window moves this edge: without
        // the two arrows the split would be a fact only a pointer could change. They go through the
        // same action the drag does, so there is one place the edge is moved from.
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          dragDockTo(beginDockDrag(), event.key === "ArrowLeft" ? -NUDGE : NUDGE);
        }}
        {...grip}
      />
      <header className="panel__header">
        {/* The SDK's summary of this conversation, which is the nearest thing it has to a name. It
            is missing until the first turn has been summarised, and the header says the general
            thing rather than showing a gap where a name goes. */}
        <h2 className="panel__title">{name ?? "Conversation"}</h2>
        <span className="panel__spacer" />
        {/* The agent said it came up without its measurement engine, so it can read and reason but
            cannot compute. Said here rather than left to the first refusal, because the refusal
            arrives after somebody has asked for numbers.

            Two sources, and both have to agree, because `venvReady` arrives ONLY on a `ready`
            frame: a user who installs the engine from the health badge gets no new one, and the
            chip would go on telling them to do the thing they just did until they reloaded. The
            health poll is what knows the answer has changed. */}
        {chat.ready && !chat.venvReady && !(health?.venv.ready ?? false) ? (
          <span
            className="chip chat__chip--warn"
            title="The measurement engine is not installed, so this agent cannot compute. Retry the install from the status cluster."
          >
            no engine
          </span>
        ) : null}
        {connection === "ready" ? null : <span className="chip">{STATUS[connection]}</span>}
        {/*
         * PUT THIS ONE DOWN AND START ANOTHER. Starting a fresh conversation must not require
         * reading the earlier ones, so it does not live on the session list in the corner beside the
         * toggle that opens it: the dock is on screen at all times, and a control for starting a
         * conversation belongs on the conversation rather than on the cabinet the earlier ones are
         * filed in.
         *
         * LAST IN THE HEADER, PAST THE CHIPS, because it is the only thing up here that DOES
         * anything. Everything to its left is the conversation reporting on itself — its name, and
         * why nothing is listening — so a control set among them would read as one more piece of
         * status, and it would sit between the reader and the name they came up here to read.
         */}
        <button
          type="button"
          className="btn btn--icon"
          disabled={starting}
          aria-label="Start a new conversation"
          // Says what it does NOT do, because that is the part somebody hesitates over: a control
          // that puts the current conversation down looks destructive and is not.
          title="Start a new conversation — this one is kept, and Sessions reopens it"
          onClick={() => void startNew()}
        >
          <NewConversation />
        </button>
      </header>

      {body}
    </section>
  );
}

/**
 * The mark on the button that starts a new conversation: a plus on a filled chip.
 *
 * DRAWN RATHER THAN TYPED, the same call `Glyph` in `Composer.tsx` makes and for the same reason:
 * the marks this window sets in text — ✎ ✕ ↑ × — are characters every system ships, and a plus
 * inside a filled circle is not. The nearest code points are ⊕ and an emoji: one is a hairline ring
 * at whatever weight the face feels like, the other arrives in colour on one machine, as a blank box
 * on the next, and at a weight nothing beside it shares on the third.
 *
 * IT WAS A BROOM, and the argument for one is worth keeping because the replacement has to answer
 * it. A broom said this control does not MAKE a conversation, it clears the desk — what was on it is
 * filed and comes back from Sessions — where a bare plus would promise a new thing and leave the
 * reader wondering what became of the one they were reading. What answers that is the chip: a plus
 * ON something is a different mark from the bare `+`s on the board, which are how a record is added
 * to the box they sit in, and the title beside it carries the promise in words ("this one is kept,
 * and Sessions reopens it"). What it buys is that a plus is legible at fourteen pixels and reads as
 * "begin" to somebody who has never used this window, where a broom at that size is a shape people
 * have to be told the meaning of once.
 *
 * THE CHIP IS `currentColor` AND THE PLUS IS THE PANEL'S OWN INK, which is what keeps the whole mark
 * dimming with the button while a press is in flight: the fill is the button's colour, and the
 * strokes are a hole punched in it rather than a second colour that would stay bright on its own.
 *
 * Decorative, and marked so: the button carries the whole meaning in its label and its title.
 */
function NewConversation(): ReactElement {
  return (
    <svg className="chatdock__new" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="6.5" />
      {/* The two strokes of the plus, punched through the chip in the panel's own ink. */}
      <path d="M7 4.1V9.9" />
      <path d="M4.1 7H9.9" />
    </svg>
  );
}

/**
 * How big the screen is, kept up to date.
 *
 * The one thing in this component that has to come from the browser rather than from arithmetic,
 * and it is the VIEWPORT rather than any element's box — `window.innerWidth` is not a layout
 * measurement and reading it costs no reflow. It is watched because every number in the dock's
 * rectangle is a function of it, INCLUDING under a split the reader has moved: the split is a
 * fraction, so a resize puts the inner edge at a different pixel and the two glass edges with it,
 * without the split itself changing at all. That is the whole reason the store holds a fraction —
 * a held width would have to be re-fitted to every screen this window is ever opened on.
 */
function useViewport(): Box {
  const [box, setBox] = useState<Box>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  useEffect(() => {
    const onResize = (): void =>
      setBox({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return box;
}
