/**
 * The database as a node graph: boxes of records, links along the foreign keys that join them.
 *
 * A graph rather than a schema strip over a drill-down stack, and the objection to a graph is never
 * that it is the wrong picture — it is exactly the right picture of a schema
 * whose whole value is its edges. It is that a graph re-jitters. A layout measured from the DOM
 * moves the rows a frame after they are painted; a list re-sorted newest-first moves them twice a
 * second while the agent writes. Either one takes the row out from under the cursor of somebody
 * about to drag it into the composer, which is the single interaction this panel exists for. Both
 * are answered outside this file — `lib/graphLayout.ts` computes every coordinate in closed form
 * from constants, and `state/graph.ts` merges a refresh in place instead of replacing it — and what
 * is left here is drawing.
 *
 * SO THIS COMPONENT MEASURES NO BOX. No ref reads an offsetHeight, and the boxes are absolutely
 * positioned at coordinates that were decided before React saw them. The stylesheet holds up the
 * other end of that bargain: a row is exactly `--graph-row-h` tall and never wraps, a title bar is
 * exactly `--graph-title-h`, and the constants are published onto the surface as custom properties
 * so there is one number rather than two that must agree. A box past `MAX_ROWS` scrolls its rows,
 * and that is not a hole in the rule: the box is a fixed height the layout computed from the same
 * row count, and what scrolls inside it is content the arithmetic already decided not to make room
 * for.
 *
 * The CANVAS's own rectangle IS read, in three places and for three reasons: a wheel event has to
 * know where in the canvas the pointer is, a fit has to know how big the viewport is, and
 * `useCanvasSize` watches it so the packing's margins and gaps can be fractions of the panel rather
 * than constants (`metricsFor` in `lib/graphLayout.ts`). That third one is a
 * different animal from measuring a box: what comes back is the panel, not the content, so a
 * coordinate still cannot depend on what a row rendered as. The graph re-packs when the PANEL
 * changes size — a window resize, a divider drag — which is a frame in which everything on screen is
 * moving anyway, and never when a read lands.
 *
 * THE GRAPH IS GLOBAL, AND SO IS THE CONVERSATION, so the two have nothing to say to each other.
 * Column zero is four whole tables and a recipe is one row of one of them; no row is "current" and
 * none is marked. An accent bar on the recipe whose chat was open would be claiming that a
 * recipe is the thing you are INSIDE while you look at records: there is one agent, it belongs to
 * the installation, and it is attached to no row in this picture.
 *
 * COLOUR SAYS KIND AND NOTHING ELSE. Every box, every header strip, every port dot and every link
 * takes its hue from one of five FAMILIES — `lib/family.ts` — written onto the DOM as a single
 * `data-family` attribute and resolved to custom properties by `graph.css`. Five rather than one per
 * table, because the table's name is written on the box already and a thirteen-entry legend is a
 * legend nobody reads. A LINK TAKES THE FAMILY OF THE BOX IT ARRIVES AT, which is what makes the link,
 * the input dot it lands on and that box's strip agree — and a row with three outgoing links gets
 * three distinguishable wires.
 *
 * ONE CLICK SELECTS AND EXPANDS, TWO OPEN THE RECORD, and the row is a drag source throughout. Three
 * gestures on one element sounds like one too many, and the resolution is what makes it work:
 * expansion is deferred by a quarter of a second so a double click can cancel it, the drag is
 * HTML5's and starts only once the pointer moves, and the node drag is bound to the TITLE BAR alone
 * so it can never compete with a row. A row that started a node drag would be a row you could not
 * drag into the composer, and that trade is not available.
 *
 * THE `+` BUTTONS LEAVE THIS PANEL, always, and nothing ever opens inside a box. That is not a
 * preference: a box's height is closed-form arithmetic over constants — `TITLE_H + rows * ROW_H + …` —
 * computed before React sees it and never measured back from the DOM, which is what stops the graph
 * re-packing itself a frame after it is painted, under the cursor of somebody about to drag a row out
 * of it. Anything that grew inside a box would change a height the packing does not know about, so its
 * own rows would spill past where the links arrive and every box below it in the column would be drawn
 * in the wrong place.
 *
 * A `+` THAT GREW A FORM INSIDE A BOX WOULD BE THE ILLEGAL VERSION of that rule, because no
 * arithmetic upstream would know the box had changed size. Which is one of the reasons every `+`
 * here speaks into the conversation instead.
 *
 * WHERE THEY GO IS THE CONVERSATION, every one of them. They opened forms in the record panel once,
 * on the argument that neither a recipe nor an information source is a FINDING — the specification
 * the work is commissioned against and the standing account of where the numbers come from are the
 * reader's own documents, so the thing to ask why is the person, and they are the one pressing the
 * button. What that argument left out is the ACCOUNT: a row typed into boxes and saved arrives in
 * the archive with nothing behind it, and a row asked for in the conversation arrives with the whole
 * exchange behind it. So a press sends a sentence and the interview happens in the dock below.
 *
 * THE REPORT `+` IS THE ONE THAT DOES NOT ASK, and it is on the same argument rather than an
 * exception to it. Nobody authors a report: a generation procedure names the recipe it works to,
 * records every command it runs, and writes the report's provenance from that log — so there
 * is no draft for the reader to see first, and an interview would be the agent asking permission for
 * work it has just been told to do. It still goes to the conversation, because that is where the
 * procedure runs and where it can be read and stopped. See `lib/awareness.ts`, which argues the
 * exception where the sentence is written.
 *
 * FOUR GESTURES SHARE THE POINTER over this canvas, and they are kept apart by ONE hit test —
 * `closest(".graph__node")`. Inside a node the pointer belongs to the node: to the title bar's drag,
 * or to a row's HTML5 drag into the composer. Outside it, on bare canvas, it pans. That single test
 * is why the pan can be a plain pointer capture on the canvas rather than a set of exclusions that
 * would have to be revisited every time a control is added to a box. The middle button ignores the
 * test and pans from anywhere, which is ComfyUI's rule and the escape hatch for a canvas that has
 * been filled with nodes.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
} from "react";

import type { RecordCard, RecordGroup } from "../lib/api.ts";
import { familyOf } from "../lib/family.ts";
import type { GraphLayout, LayoutBox } from "../lib/graphLayout.ts";
import {
  FOOTER_H,
  MAX_ROWS,
  NODE_W,
  NOTE_H,
  ROW_H,
  SCROLLBAR_W,
  TITLE_H,
  bezierPath,
  layoutGraph,
  metricsFor,
} from "../lib/graphLayout.ts";
import type { ViewTransform } from "../lib/graphView.ts";
import { IDENTITY_VIEW, fitView, panBy, wheelPixels, zoomAt } from "../lib/graphView.ts";
import { usePointerDrag, type PointerDragHandlers } from "../lib/pointerDrag.ts";
import { dragHandlers } from "../lib/recordDrag.ts";
import { expands } from "../lib/records.ts";
import { formatAbsolute } from "../lib/time.ts";
import type { Expansion, GraphState, NodeOffset, NodePath, RootTable } from "../state/graph.ts";
import {
  isExpanded,
  isReading,
  parentPath,
  rootOf,
  isRetired,
  activeFirst,
  ordersByStanding,
  rootTableOf,
  rowPath,
} from "../state/graph.ts";
import {
  currentGraphView,
  dragNode,
  graphShowMore,
  graphShowMoreRoots,
  refreshGraph,
  sendAwareness,
  setGraphView,
  toggleNode,
  useGraph,
  useGraphView,
  viewRecord,
} from "../state/store.ts";
/** What each `+` says on the reader's behalf. The sentences are `lib/awareness.ts`'s, so this panel
 * decides WHICH one a button sends and never what it says — see that file on why they are ordinary
 * user messages and why none of them reads as a completed instruction. */
import { NEW_RECIPE, NEW_SCRIPT, NEW_SOURCE, NEW_THESIS, newReport } from "../lib/awareness.ts";
import "../styles/chalk.css";
import "./graph.css";

/**
 * Which of the three chalkbox seeds a box's frame wobbles with — a hash of the path, never a
 * random number, so a box keeps its wobble across every re-render and refresh. Same bargain as the
 * notes' deckles (state/notes.ts).
 */
function chalkSeed(path: string): number {
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
  return h % 3;
}

/**
 * How long a single click waits to find out it was the first half of a double one.
 *
 * The platform gives no "this click was final" event, so the choice is this or a modifier key.
 * 250ms is a shade under the usual system threshold: long enough that a deliberate double click is
 * never mistaken for two single ones, short enough that expanding a row still feels like a click
 * rather than a request.
 */
const DOUBLE_CLICK_MS = 250;

export function GraphPanel(): ReactElement {
  const graph = useGraph();
  const view = useGraphView();
  const canvas = useRef<HTMLDivElement | null>(null);
  const reading = isReading(graph);

  // Exact by construction rather than by luck: every function in `state/graph.ts` returns the state
  // it was handed when nothing changed, so this identity check misses no move and recomputes for no
  // poll that said nothing. `size` is identity-stable for the same reason — `useCanvasSize` hands
  // back the object it already had when the rectangle has not moved — so a panel that is not being
  // resized re-packs exactly as often as it did before margins were proportional.
  const size = useCanvasSize(canvas);
  const metrics = useMemo(() => metricsFor(size), [size]);
  const layout = useMemo<GraphLayout>(() => layoutGraph(graph, metrics), [graph, metrics]);

  useWheelZoom(canvas);
  const pan = usePan();

  /**
   * The drawn graph, held across a pan.
   *
   * A pan writes the store sixty times a second and re-renders this component every time, and every
   * one of those renders would otherwise reconcile several hundred rows to translate one CSS
   * transform. None of what is inside depends on the transform — that is the whole point of putting
   * it on the surface — so the elements are built once per thing that actually changes them and
   * handed back unchanged in between, and React skips the subtree on identity.
   *
   * NOTHING IN HERE GOES STALE ON ITS OWN ANY MORE. A minute timer used to be in these dependencies
   * so that every "4m" in the graph re-rendered as it aged; the rows no longer draw one — see the
   * note where the label went — and the only moment still drawn in this panel is the exact one in a
   * tooltip, which is as true in an hour as it is now. So the memo depends on what actually changes
   * it and nothing else.
   */
  const drawn = useMemo(() => {
    /*
     * Which family each box wears, by path — built HERE because this is where both readers of it are.
     *
     * `edge.key` IS the target box's path, which is what makes this a lookup rather than a search:
     * the layout keys an edge by where it arrives, so a link and the box it lands on are the same
     * string. Built once per layout rather than once per edge, because a graph with fifty boxes opens
     * a few hundred edges and `boxes.find` per link is the one quadratic this panel could grow.
     */
    const familyByPath = new Map(layout.boxes.map((box) => [box.path, familyOf(box.table)]));

    return (
      <>
        {/*
         * One svg for every link, drawn FIRST so the boxes stack above it — ComfyUI's z-order,
         * and the reason a link appears to run behind a node rather than across its face. It
         * takes no pointer events at all: a link is a statement about two boxes, and there is
         * nothing to do to one.
         */}
        <svg
          className="graph__edges"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
          focusable="false"
        >
          {layout.edges.map((edge) => {
            const d = bezierPath(edge);
            return (
              <g
                key={edge.key}
                className="graph__edgegroup"
                // A link takes its HUE from the box it ARRIVES at, because a link, the input dot it
                // lands on and that box's header strip are one visual statement — see this file's
                // header — and a link coloured by its source would give a row with three outgoing
                // links three wires of the same colour.
                data-family={familyByPath.get(edge.key) ?? "neutral"}
              >
                {/* Two strokes of one path: a wide faint pass under a narrow bright one, which is
                    how a chalk line actually lands — dust around a core. The group wears the
                    family; the stylesheet deals the two strokes their shades of it. */}
                <path className="graph__edge-under" d={d} />
                <path className="graph__edge" d={d} />
              </g>
            );
          })}
        </svg>

        {layout.boxes.map((box) => (
          <GraphNode key={box.path} box={box} graph={graph} />
        ))}
      </>
    );
  }, [layout, graph]);

  return (
    /*
     * The board, which is what the panel became: no header row, no card chrome — the canvas fills
     * the section and the title and tools are written ON it, the way everything on a blackboard is.
     * The title is inert handwriting; the tools float at the top-right corner and are the only
     * things up there the pointer can land on.
     */
    <section className="board" aria-label="Resources">
      <div
        ref={canvas}
        className={pan.panning ? "graph__canvas graph__canvas--panning" : "graph__canvas"}
        onPointerDown={pan.onPointerDown}
        onPointerMove={pan.onPointerMove}
        onPointerUp={pan.onPointerUp}
        onPointerCancel={pan.onPointerUp}
      >
        {/*
         * The board's ruling, and the FIRST thing in the canvas, so everything else in here lands on
         * top of it: ruling goes under writing, and under the boxes as well.
         *
         * It is a sibling of the surface rather than a background ON it, and `graph.css` argues why
         * at both rules: a background on the transformed element is clipped to the layout's extent,
         * so it would stop wherever the boxes do. This fills the canvas and takes the pan through
         * `background-position` instead, which is the same parallax with nothing to run out of.
         */}
        <div
          className={gridIsFine(view.scale) ? "graph__grid" : "graph__grid graph__grid--coarse"}
          style={gridStyle(view)}
          aria-hidden="true"
        />

        {/*
         * The board's title, and under it what a hand would write on a blackboard to say how the
         * room works. Seven lines rather than a single hint, and the reason it can be seven
         * is that NOTHING IN THIS WINDOW IS TRANSPARENT: anything laid over these words
         * covers them outright, so instructions on the slate cost the reader nothing once they have
         * stopped needing them — they get buried by the work, the way writing on a real board does.
         * There is no dismiss button for the same reason there is no dismiss button on a blackboard.
         *
         * EACH LINE IS ONE GESTURE AND ITS RESULT, in the fewest words that stay true. They are read
         * once, by somebody who has never seen this board, and every word past the gesture is a word
         * between them and trying it — but a line trimmed past the point of being accurate is worse
         * than a long one, which is why the Bin still says it ASKS: dropping a row there opens the
         * question rather than carrying out the deletion.
         *
         * IT IS INSIDE THE CANVAS AND BEFORE THE SURFACE, which is the whole of how it gets buried.
         * The canvas paints the slate, the ruling above paints on the slate, this paints on top of
         * both, and the surface — a later positioned sibling — paints every wire and box on top of
         * THIS. So a node panned over the instructions covers them, which is what writing underneath
         * the work means. It cannot be a sibling of the canvas instead: the canvas's own fill is the
         * slate, and anything drawn under that is drawn under the board itself. And it is outside the
         * SURFACE, so it does not pan or zoom with the boxes — it is written on the board, not on the
         * drawing, which is the one way it differs from the ruling it sits over.
         *
         * Inert: `aria-hidden` here and `pointer-events: none` in the sheet, because it is writing on
         * the board rather than a control — the pans land on the canvas underneath it. A screen
         * reader gets every one of these gestures from the labels and titles on the things that
         * perform them, which is where an announcement belongs.
         */}
        <div className="board__title" aria-hidden="true">
          <div className="board__title-word">resources</div>
          <div className="board__title-rule" />
          <div className="board__howto">
            <div className="board__howto-line">magnifier or double-click pins a row as a note</div>
            <div className="board__howto-line">the arrow shows what points at a row</div>
            <div className="board__howto-line">drag a row into the chat to mention it</div>
            <div className="board__howto-line">drag a row or a note onto the Bin to ask about deleting it</div>
            <div className="board__howto-line">drag an old conversation onto the Bin to delete it</div>
            <div className="board__howto-line">the red magnet takes a note down</div>
            <div className="board__howto-line">the circled + starts a new conversation</div>
          </div>
        </div>

        <div className="graph__surface" style={surfaceStyle(layout, view)} aria-busy={reading}>
          {drawn}
        </div>
      </div>

      <div className="board__tools">
        <button
          type="button"
          className="btn btn--icon"
          aria-label="Reset the view"
          title="Reset the zoom and the pan — hold shift to fit the whole graph instead"
          onClick={(event) => resetOrFit(event, canvas.current, layout)}
        >
          <span aria-hidden="true">⌖</span>
        </button>
        <button
          type="button"
          className="btn btn--icon"
          aria-label="Read the graph again"
          // Why it is dimmed, on the control itself. A button that is greyed out and silent is a
          // puzzle — the same rule the composer's send button follows.
          title={reading ? "Reading…" : "Read every open node again"}
          onClick={() => void refreshGraph()}
          disabled={reading}
        >
          <span aria-hidden="true">↻</span>
        </button>
      </div>
    </section>
  );
}

/**
 * The reset control, and the fit hiding behind shift.
 *
 * Two readings of "put the graph back where I can see it": reset is the literal one and is what
 * somebody who has zoomed into a corner wants, fit is the one for a graph that has grown past the
 * panel. One button rather than two because they are the same intent at different scales, and the
 * `title` says so — a second icon for a gesture that is used once a session is furniture.
 *
 * This is the `getBoundingClientRect` the header admits to. It is a click, not a frame, and it asks
 * how big the viewport is rather than how tall a box turned out; `fitView` itself is pure and takes
 * both sizes as numbers.
 */
function resetOrFit(
  event: MouseEvent<HTMLButtonElement>,
  canvas: HTMLDivElement | null,
  layout: GraphLayout,
): void {
  if (!event.shiftKey || canvas === null) {
    setGraphView(IDENTITY_VIEW);
    return;
  }
  const box = canvas.getBoundingClientRect();
  setGraphView(fitView(layout, { width: box.width, height: box.height }));
}

/**
 * The canvas's own rectangle, watched — the one measurement this panel takes every frame it changes.
 *
 * It is the VIEWPORT, never a box, and that distinction is the whole reason it is allowed. What
 * comes back feeds `metricsFor`, which turns it into the pads and gaps the packing is spelled in, so
 * the graph clears a proportion of the panel rather than twelve pixels of it. Nothing about a box's
 * height or a row's width is measured here or anywhere else, so the failure this file's header is
 * built to avoid — a layout that moves a frame after paint, under the cursor of somebody about to
 * drag a row — cannot happen: coordinates change when the PANEL is resized, which is a frame in
 * which every other thing on screen is moving too.
 *
 * The setter returns the object it already had when the rounded rectangle has not moved. That
 * identity is load-bearing twice over: it keeps the layout memo from recomputing on every observer
 * callback, and it is what makes the observer safe to attach at all — the surface inside the canvas
 * is sized from the layout, and a size object that changed identity on every notification would let
 * that feed back into another notification for ever. `.graph__canvas` is a grid track with
 * `overflow: hidden`, so the surface cannot push it either way.
 */
function useCanvasSize(canvas: {
  current: HTMLDivElement | null;
}): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const land = (width: number, height: number): void => {
      const next = { width: Math.round(width), height: Math.round(height) };
      setSize((held) =>
        held !== null && held.width === next.width && held.height === next.height ? held : next,
      );
    };
    const box = element.getBoundingClientRect();
    land(box.width, box.height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      land(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvas]);
  return size;
}

/**
 * The wheel, attached BY HAND and not passively.
 *
 * React registers `onWheel` through a passive root listener, so `preventDefault()` from JSX is
 * silently ignored and the browser goes on doing what it was going to do — which on a canvas that
 * has swallowed the wheel for zooming is the page rubber-banding under a graph that never moves.
 * There is no prop for this; the listener has to be added to the element itself with
 * `{ passive: false }`, which is what this effect is for and the only reason it exists.
 *
 * macOS pinch arrives here as a wheel event with `ctrlKey` set and needs no special case at all: it
 * is a smaller `deltaY` through the same exponential, which is exactly what a pinch should be.
 *
 * ONE THING ON THE BOARD KEEPS ITS OWN WHEEL, and it is the same hit test the pan makes: a box past
 * `MAX_ROWS` draws a scrolling list, and a wheel that landed inside one belongs to that list. This
 * handler swallows the event for every reader of the canvas, so without the test a long box would be
 * one the reader can see the top of and never reach the bottom of. The list stops the chain itself
 * (`overscroll-behavior` in `graph.css`), so running out of rows does not hand the wheel back to the
 * zoom half a gesture later.
 */
function useWheelZoom(canvas: { current: HTMLDivElement | null }): void {
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest(".graph__rows--scrolls") !== null) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const pointer = { x: event.clientX - box.left, y: event.clientY - box.top };
      setGraphView(zoomAt(currentGraphView(), pointer, wheelPixels(event.deltaY, event.deltaMode)));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [canvas]);
}

/**
 * Dragging the canvas itself.
 *
 * The hit test is the whole design: a pointerdown that landed inside a `.graph__node` belongs to
 * that node — to the title bar's own capture, or to a row that is about to start an HTML5 drag into
 * the composer — and this must not take it. One `closest` covers both, and covers every control
 * added to a box in future without this function hearing about it. The middle button is the
 * exception and pans from wherever it is pressed, which is what a reader whose canvas is entirely
 * covered in nodes reaches for.
 *
 * The offset is absolute from the drag start, like `useNodeDrag`: `panBy` is applied to the view the
 * gesture BEGAN with, and the total screen distance travelled since. Accumulating per event drifts
 * by a whole event whenever moves are coalesced.
 */
function usePan(): {
  panning: boolean;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
} {
  const from = useRef<{ x: number; y: number; view: ViewTransform } | null>(null);
  // In component state rather than on the ref because it is drawn — the canvas's cursor is the only
  // thing saying the surface is being held rather than clicked through.
  const [panning, setPanning] = useState(false);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    if (from.current === null) return;
    from.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return {
    panning,
    onPointerDown: (event) => {
      const middle = event.button === 1;
      if (event.button !== 0 && !middle) return;
      if (!middle && (event.target as Element).closest(".graph__node") !== null) return;
      from.current = { x: event.clientX, y: event.clientY, view: currentGraphView() };
      setPanning(true);
      // Refusable, same as `usePointerDrag`'s: a pointer no longer active when the handler runs
      // must degrade the pan to hover-scoped, not throw through a React event.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* uncaptured — the pan still tracks while the pointer stays over the canvas */
      }
      // A drag across the canvas would otherwise paint a text selection through every box it
      // crossed, the same way a title-bar drag would.
      event.preventDefault();
    },
    onPointerMove: (event) => {
      const start = from.current;
      if (start === null) return;
      setGraphView(panBy(start.view, event.clientX - start.x, event.clientY - start.y));
    },
    onPointerUp,
  };
}

/**
 * The layout's constants, handed to the stylesheet, and the reader's transform.
 *
 * The constants are published rather than duplicated: `graph.css` sizes a title bar, a row and a
 * footer, and every one of those numbers is also an arithmetic term in `layoutGraph`. Two copies
 * would agree until one of them was tuned, and the failure — boxes whose drawn contents no longer
 * end where the packing said they do — has nothing to notice it.
 *
 * The transform goes on the SURFACE, which the stylesheet already gives `transform-origin: 0 0`, so
 * `translate` then `scale` composes exactly as `lib/graphView.ts` solves it: graph point p is drawn
 * at `p * scale + t`, and `toGraph` inverts it. Reversing the two here would silently make the pan
 * scale-dependent and every zoom-at-cursor drift.
 */
function surfaceStyle(layout: GraphLayout, view: ViewTransform): CSSProperties {
  return {
    width: layout.width,
    height: layout.height,
    transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
    "--graph-node-w": `${NODE_W}px`,
    "--graph-title-h": `${TITLE_H}px`,
    "--graph-row-h": `${ROW_H}px`,
    "--graph-footer-h": `${FOOTER_H}px`,
    "--graph-note-h": `${NOTE_H}px`,
    // The gutter a scrolling box's rows give up, which the packing has already taken out of every
    // link leaving one of them. It is published for the same reason the four above it are: the
    // stylesheet sizes the graph's own scrollbars with it, so the width the wires were solved
    // against and the width the browser draws are one number.
    "--graph-scrollbar-w": `${SCROLLBAR_W}px`,
  } as CSSProperties;
}

/**
 * How far apart the ruling's two scales are, at 1×, and the point at which the fine one is dropped.
 *
 * These live here rather than in `graph.css` for the reason `surfaceStyle`'s constants do: the zoom
 * multiplies them, so they are arithmetic terms before they are style, and a copy in the stylesheet
 * would be a second answer to what a 24-pixel square measures at two and a half times.
 *
 * The floor is where a fine line stops being a line. Twelve device pixels between rules is about the
 * least that still reads as a grid rather than as a lighter shade of board; below it the fine pair is
 * dropped and the coarse pair carries the plane alone — which is the whole reason there are two
 * scales, since the coarse one is still 30px apart at the furthest zoom out.
 */
const GRID_MINOR = 24;
const GRID_MAJOR = 120;
const GRID_MIN_PX = 12;

/** Whether the fine ruling is worth drawing at this zoom. */
function gridIsFine(scale: number): boolean {
  return GRID_MINOR * scale >= GRID_MIN_PX;
}

/**
 * The ruling's own transform, expressed as a background rather than as one.
 *
 * A grid is periodic, so it does not need to be moved — it needs to be OFFSET, and `translate(tx,ty)
 * scale(s)` on a tiled pattern is exactly `background-position: tx ty` with the tile multiplied by
 * `s`. That equivalence is the whole trick: the layer never moves, never clips, and never runs out,
 * and the squares still land precisely where the same transform puts the boxes on the surface above.
 *
 * Four sizes are always written even when only the coarse pair is drawn; the cascade takes as many
 * layers as `background-image` declares and ignores the rest, so the class can drop the fine pair
 * without this having to know that it did.
 */
function gridStyle(view: ViewTransform): CSSProperties {
  const minor = GRID_MINOR * view.scale;
  const major = GRID_MAJOR * view.scale;
  return {
    backgroundPosition: `${view.tx}px ${view.ty}px`,
    backgroundSize: `${major}px ${major}px, ${major}px ${major}px, ${minor}px ${minor}px, ${minor}px ${minor}px`,
  };
}

// -- one box ---------------------------------------------------------------------------------------

type GraphNodeProps = {
  box: LayoutBox;
  graph: GraphState;
};

/**
 * One node, placed at coordinates it does not get a say in.
 *
 * It carries no rows of its own: the layout hands it a path, and the rows are looked up in the state
 * from that path. Copying them into the box would let the drawing and the state disagree about what
 * is in it, and the state is the one that knows.
 *
 * TWO ATTRIBUTES CARRY EVERYTHING THE STYLESHEET NEEDS TO PAINT IT, and both are decided here rather
 * than there because both are facts about the schema rather than about CSS. `data-family` is the box's
 * kind, resolved to a hue pair by `graph.css`; `graph__node--child` says the box RECEIVES a link,
 * which is true of every box that is not one of the four in column zero — and that is what earns it an
 * input port dot on the left of its strip. A root box has nothing arriving at it, so a dot there would
 * be a socket for a wire that cannot exist.
 */
function GraphNode({ box, graph }: GraphNodeProps): ReactElement {
  const held = expansionFor(graph, box);
  const group = groupFor(held, box);
  const root = rootTableOf(box.path);
  const family = familyOf(box.table);
  const style: CSSProperties = { transform: `translate(${box.x}px, ${box.y}px)`, height: box.h };
  const nodeClass = ["graph__node", root === null ? "graph__node--child" : ""]
    .filter((name) => name !== "")
    .join(" ");
  // Which chalkbox seed this box's frame wobbles with, from the path so it survives every re-render
  // — the same deterministic-variety bargain the notes' deckles make (see state/notes.ts).
  const seed = chalkSeed(box.path);
  // The drawn box: an inert layer under the content, carrying the chalk border, the solid fill and
  // the displacement filter — never an ancestor of the text, which must stay crisp.
  const frame = <span className="chalk-frame" aria-hidden="true" />;

  if (box.kind === "refusal") {
    // A refusal is drawn where the box would have been, in the server's own words, with the retry
    // beside it. Never a toast: it is an answer about the row that was clicked, and it belongs where
    // the answer would have been. Rewording it here would be inventing a friendlier lie.
    const sentence =
      (root === null ? held?.error : rootOf(graph, root).error) ?? "That read failed.";
    return (
      <div
        className={`${nodeClass} graph__node--refusal`}
        style={style}
        data-family={family}
        data-chalk={seed}
      >
        {frame}
        <NodeTitle box={box} graph={graph} text={box.title} detail={sentence} />
        <div className="graph__refusal">
          <p className="graph__refusal-text" title={sentence}>
            {sentence}
          </p>
          <button
            type="button"
            className="btn btn--ghost graph__retry"
            onClick={() => void refreshGraph()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (box.kind === "note") {
    // THIS IS THE READING FACE and that is very nearly the whole of its job: a row just clicked open
    // draws here until its referrers land.
    //
    // The other sentence is UNREACHABLE while the server keeps its side of one contract — every edge
    // in `REFERRERS` comes back as a group, empty ones included — because only a table with at least
    // one edge draws an arrow at all, and an expansion of one therefore lands with at least one box.
    // It stays written rather than thrown, and stays vague on purpose: if that contract ever breaks
    // the honest thing to say is that the read came back with nothing in it, which is a bug report
    // the reader can repeat, where a blank box would read as a read that never finished.
    return (
      <div className={nodeClass} style={style} data-family={family} data-chalk={seed}>
        {frame}
        <NodeTitle box={box} graph={graph} text={box.title} detail={null} />
        <p className="graph__note">
          {held?.loading === true ? "reading…" : "this read came back with no edges"}
        </p>
      </div>
    );
  }

  // A root box reads its rows off `graph.roots`, every other box off the group its path names. The
  // TABLE cannot decide which: a `script` box hanging off a `thesis` row says `script` too, and it
  // holds four of them rather than the table entire. The path is what tells them apart.
  const rootState = root === null ? null : rootOf(graph, root);
  const records = rootState === null ? (group?.records ?? []) : (rootState.box?.records ?? []);
  const hasMore = rootState === null ? (group?.hasMore ?? false) : (rootState.box?.hasMore ?? false);
  // A group knows its own total however few rows it carries. A root box does not — the table
  // endpoint answers a page, not a count — so it says how many it is drawing and marks the count as
  // a floor rather than claiming a total it was never told.
  const count = rootState === null ? (group?.total ?? 0) : `${records.length}${hasMore ? "+" : ""}`;

  /*
   * THE TWO ORDERED BOXES. `activeFirst` under `ordersByStanding` is the same pair of calls the
   * layout made, for the same reason: the order of these rows is the order the edges were anchored
   * against, so an order computed twice is an order that can differ and links that arrive at the
   * wrong row. Every other box draws what the merge appended, which is this graph's law — see
   * `state/graph.ts`.
   */
  const shown = ordersByStanding(root) ? activeFirst(records) : records;

  return (
    <div className={nodeClass} style={style} data-family={family} data-chalk={seed}>
      {frame}
      <NodeTitle
        box={box}
        graph={graph}
        text={`${box.title} (${count})`}
        detail={group === null ? null : edgeFact(group)}
      />
      {records.length === 0 ? (
        // A group that came back empty is not waiting for anything — the server answered, and the
        // answer was none. Only a root box can be empty because it has not been read yet.
        <p className="graph__note">
          {rootState === null
            ? "none recorded"
            : rootState.loading
              ? "reading…"
              : `no ${box.title} rows yet`}
        </p>
      ) : (
        /*
         * THE ONE SCROLLER ON THIS BOARD, and it is declared rather than discovered: the class says
         * this list holds more than the box draws, which `layoutGraph` decided in closed form from
         * the same row count. Nothing here measures whether it overflows — the arithmetic already
         * knows, and asking the DOM would be the measurement the whole panel refuses.
         *
         * The class is also what the canvas's wheel handler tests. That listener swallows every
         * wheel event on the board to zoom with it, so without a way to recognise a list that
         * scrolls, a box past the cap would be one the reader could see the top of and never reach
         * the bottom of.
         */
        <div className={shown.length > MAX_ROWS ? "graph__rows graph__rows--scrolls" : "graph__rows"}>
          {shown.map((card) => (
            <GraphRow
              key={`${card.table}:${card.id}`}
              box={box.path}
              card={card}
              graph={graph}
              via={group?.via}
            />
          ))}
        </div>
      )}
      {hasMore ? (
        <button
          type="button"
          className="btn btn--quiet graph__more"
          // The page lands in the STORE, not here. A refresh half a second later replaces the slice
          // and remounts these rows, and extras held in component state would vanish under the
          // pointer of the person who had just asked for them.
          onClick={() => void showMoreOf(box)}
        >
          Show more
        </button>
      ) : null}
    </div>
  );
}

/** One more page of whichever box asked. A root box pages its own table; every other box pages one
 * referrer edge of the row one segment above it. */
function showMoreOf(box: LayoutBox): Promise<void> {
  const root = rootTableOf(box.path);
  if (root !== null) return graphShowMoreRoots(root);
  if (box.table === null) return Promise.resolve();
  const source = parentPath(box.path);
  return source === null ? Promise.resolve() : graphShowMore(source, box.table);
}

/**
 * The title bar, which is also the drag handle.
 *
 * ONLY the title bar. A node drag bound to the whole box would fight the rows for the pointer, and
 * the row would lose: an HTML5 text-drag and a pointer capture cannot both own the same gesture, and
 * the rows' drag is the one this panel exists for. So the box moves by the strip along its top, the
 * way it does in ComfyUI, and the rows are left alone.
 *
 * `detail` is the audit fact — the column carrying this edge, what a deletion does to it, and the
 * junction it runs through when it runs through one. It goes into the `title` attribute rather than
 * onto the face of the box because the box is 260px wide by contract and the fact is a sentence:
 * widening the node to hold it would mean fewer columns on screen, which is what the reader came for.
 */
function NodeTitle({
  box,
  graph,
  text,
  detail,
}: {
  box: LayoutBox;
  graph: GraphState;
  text: string;
  detail: string | null;
}): ReactElement {
  const drag = useNodeDrag(box.path, graph.offsets.get(box.path));
  // A failed refresh of a node that still has rows in hand: the rows are real and stay drawn, and
  // this says they may be a moment old. It cannot be a line of its own — a box's height is closed
  // form and a line nobody accounted for would push its own rows past where the links arrive.
  const stale = box.kind === "group" || box.kind === "root" ? staleFor(graph, box) : null;
  const add = addFor(box, graph);

  /*
   * WHAT A TITLE BAR SAYS DECIDES WHICH HAND WRITES IT. A root or group box is titled with a TABLE
   * NAME — vocabulary baked into this frontend, the same words the schema uses — and that is the
   * board's own writing, in the chalk hand. A note or refusal box is titled with the LABEL of a
   * record, which is data out of the database, and data is the machine's exactly: it goes in the
   * mono like every other stored string in this window.
   *
   * The bar's HEIGHT does not move either way. `--graph-title-h` is a fixed budget the packing has
   * already spent — see the height contract at the top of this file — so a different face inside it
   * changes glyphs and nothing the layout knows about.
   */
  const data = box.kind === "note" || box.kind === "refusal";

  return (
    <div
      className={data ? "graph__node-title graph__node-title--data" : "graph__node-title"}
      title={detail === null ? text : `${text} — ${detail}`}
      {...drag}
    >
      <span className="graph__node-name">{text}</span>
      {stale === null ? null : (
        <span
          className="graph__stale"
          role="img"
          title={stale}
          aria-label={`The last read of this box failed: ${stale}`}
        >
          ⚠
        </span>
      )}
      {add === null ? null : (
        <button
          type="button"
          className="btn btn--icon graph__add"
          aria-label={add.label}
          title={add.title}
          // The strip this sits on IS the node's drag handle, and that drag calls `preventDefault`
          // on pointerdown to stop the title text being selected — which also suppresses the
          // compatibility mouse events this button's click is synthesised from. Without this line
          // the `+` drags the box instead of opening anything, which is the same failure the chat
          // window's × had to prevent. Any control added to this strip needs the same line.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={add.run}
        >
          <span aria-hidden="true">+</span>
        </button>
      )}
    </div>
  );
}

/** A `+` on a box's title bar: what it is called, what it says it does, and the sentence it sends. */
type AddAction = { label: string; title: string; run: () => void };

/**
 * The root boxes a person may start something in, and what the button on each of them says.
 *
 * ALL FOUR OF THEM NOW. A recipe, because a report is written to one and until one exists there is
 * nothing to publish; an information source, because the address book is the part of this database
 * its owner knows better than the model does; a thesis, because the claim a thesis states is the
 * reader's rather than the model's; and a script, which used to be argued out of having one on the
 * grounds that a program is arrived at rather than started in the abstract. That was true about how
 * a script usually comes to exist and wrong about what the button is FOR: it says a sentence, and a
 * person who has decided they want a fetcher for something can say so as reasonably as they can say
 * they want a thesis. Four boxes, one gesture, no exception to remember.
 *
 * NONE OPENS A FORM. They used to open a blank card in the record panel, on the argument that a
 * specification is a name and an information source is the reader's own document. What a form could
 * not do is leave an account: a row typed into seven boxes and saved arrives in the archive with
 * nothing behind it saying what it was for. So a press SAYS SOMETHING — an ordinary user message, in
 * the transcript, opening the subject — and the agent shows the reader the empty row, asks them to
 * describe it, and records it once they agree to the draft.
 *
 * AND IT SAYS IT WHERE THE READER IS. Each of these speaks into the conversation on screen. They
 * used to put it down and open a new one, on the argument that a creation is a piece of work with a
 * beginning and an end that should read afterwards as itself — which was tidy in the session list
 * and paid for by whoever was in the middle of something when they pressed it. A person raising a
 * recipe while looking at a thesis is usually doing one piece of work, not two, and the conversation
 * they were having is the context the new row belongs in. The report `+` and the bin always worked
 * this way; now everything does, which is one rule instead of two.
 *
 * THE `title` STILL HAS TO TEACH IT, because a glyph carries none of it and because the last time
 * the reader saw a `+` it opened a form. Each says what will happen and that typing the same thing
 * works identically — the fact that turns a surprising button into an obvious one — and none of them
 * promises anything about conversations any more, because nothing moves.
 */
const ROOT_ADD: Partial<Record<RootTable, AddAction>> = {
  recipe: {
    label: "Store a recipe",
    title:
      "Asks here for a new recipe — the agent shows you the empty row, asks you to describe it, and records it once you agree to the draft. A recipe's text never changes afterwards. Saying the same thing in chat works identically.",
    run: () => sendAwareness(NEW_RECIPE),
  },
  information_source: {
    label: "Record an information source",
    title:
      "Asks here for a new information source — the agent shows you the empty row, goes and reads the place, and records it once you agree to the draft. Saying the same thing in chat works identically.",
    run: () => sendAwareness(NEW_SOURCE),
  },
  thesis: {
    label: "Put a thesis on record",
    title:
      "Asks here for a new thesis — the agent asks you to describe it in your own words, then shows the statement and the measurement document together before recording anything. Saying the same thing in chat works identically.",
    run: () => sendAwareness(NEW_THESIS),
  },
  script: {
    label: "Save a script",
    title:
      "Asks here for a new script — the agent shows you the empty row, asks what it should fetch, and records the program once you agree to it. A saved script never changes: a fix is a new script. Saying the same thing in chat works identically.",
    run: () => sendAwareness(NEW_SCRIPT),
  },
};

/**
 * The `+` for one box, or none.
 *
 * The `report` GROUP box is the one that is not a root, and it is where the generate `+` lives. A
 * group box under a recipe row lists the reports written to that recipe, so the box itself is the
 * honest place to say "and the next one".
 *
 * IT NEEDS THE RECIPE'S NAME AND THE BOX HOLDS NEITHER. A `LayoutBox` carries a path, a kind, a
 * table and a title — and a group's title is its TABLE (`report`), not the row it hangs under. The
 * path holds the recipe's ID; the sentence needs a NAME, because a mention is `@recipe:name` and an
 * id in one would name nothing. So the recipe is read off the EXPANSION the group hangs under —
 * `expansionFor` walks one segment up to the row that was clicked, and that row's `card` is the
 * recipe as the graph drew it, name and all.
 *
 * IT USED TO BE TWO HOPS AND IS NOW ONE. The path was `…/workshop:W/playbook/playbook:V/report`, so
 * this had to climb past the version row to the workshop that owned it; with the recipe standing
 * where the workshop stood and no versions between, the parent expansion IS the recipe.
 *
 * A `report` box reached by some other route answers null rather than guessing, and so does one
 * whose parent has not been read yet: a `+` that sent a mention naming nothing would ask about a
 * recipe the agent cannot find.
 */
function addFor(box: LayoutBox, graph: GraphState): AddAction | null {
  if (box.kind === "root") {
    const root = rootTableOf(box.path);
    return root === null ? null : (ROOT_ADD[root] ?? null);
  }
  if (box.kind !== "group") return null;
  if (box.table === "report") {
    // The card the group hangs under — the recipe row somebody opened. The table is checked because
    // a `report` group can only honestly hang under a recipe, and a card of any other table would
    // mean the path is not what this button assumes.
    const recipe = expansionFor(graph, box)?.card ?? null;
    if (recipe === null || recipe.table !== "recipe") return null;
    // A RETIRED RECIPE OFFERS NO BUTTON, because the gate would refuse the procedure it opened
    // (`src/generation.ts`) and the refusal would cost a turn to arrive at. This window already
    // knows the answer: the same standing that strikes the row through is on the card. A control
    // that can only be told no is worse than no control — it reads as something the reader has done
    // wrong rather than as a specification nobody is writing to any more.
    if (isRetired(recipe)) return null;
    return {
      label: "Generate a report",
      title:
        "Asks the agent to generate the next report to this recipe, starting now. Unlike the other + buttons this one is an instruction rather than a question: a report is written by the machine's own procedure, which records every command it runs, so there is no draft to agree to first and nothing to interview you about. It runs as a turn you can read and stop. Asking in chat works the same way.",
      run: () => sendAwareness(newReport(recipe.name)),
    };
  }
  return null;
}

/**
 * Dragging a node, in absolute offsets rather than deltas.
 *
 * The pointer capture, the total-distance-from-the-press arithmetic and the one-gesture-one-element
 * rule are all `usePointerDrag`'s — the conversation dock's left edge is held in exactly the same
 * way, and neither of them keeps a copy of that arithmetic. What is here is the part that is
 * only true of a node: the conversion out of screen space.
 *
 * THE POINTER MOVES IN SCREEN PIXELS AND THE OFFSET IS IN GRAPH PIXELS, so the movement is divided
 * by the scale. Zoomed out to a quarter, a node the reader drags 100px across the panel has to move
 * 400 graph units to end up under their cursor; without the division it would crawl, and the further
 * out you zoomed the less a drag would do. A pan is the opposite case and divides by nothing — it
 * translates the surface itself, in the screen's own units. This is the one place in the panel where
 * getting the two the wrong way round produces something that still works, just wrongly.
 *
 * The scale is read ONCE at pointerdown — that is what `begin` is for — rather than subscribed to.
 * Subscribing would re-render every title bar on the canvas on every frame of a pan that moves no
 * node, and reading it per move would make a zoom in the middle of a drag teleport the node: the
 * offset is measured from a fixed start, so changing its divisor changes the whole answer rather
 * than the next increment.
 */
function useNodeDrag(path: NodePath, offset: NodeOffset | undefined): PointerDragHandlers {
  return usePointerDrag(
    () => ({ dx: offset?.dx ?? 0, dy: offset?.dy ?? 0, scale: currentGraphView().scale }),
    (from, dx, dy) =>
      dragNode(path, { dx: from.dx + dx / from.scale, dy: from.dy + dy / from.scale }),
  );
}

// -- one row ---------------------------------------------------------------------------------------

type GraphRowProps = {
  /** The box this row is drawn in — half of the row's path, and the reason the same record in two
   * boxes is two independently openable rows. */
  box: NodePath;
  card: RecordCard;
  graph: GraphState;
  via?: RecordGroup["via"];
};

/**
 * A record, as a row you can expand, open, or drag into a sentence.
 *
 * THE DRAG IS LOAD-BEARING and it is the reason this component exists rather than reusing the
 * browser's row: `dragHandlers` puts the canonical `@table:id` on the drag payload as `text/plain`,
 * which is what makes every textarea in this window a drop target with no drop handler anywhere in
 * it. Nothing about the graph is allowed to take that away.
 *
 * THE ZOOM DOES NOT TOUCH THAT DRAG, and nobody should "fix" it later. What travels is TEXT and what
 * catches it is a textarea's own default handling — there is no drop coordinate anywhere in the
 * path, no canvas point to convert, and nothing that would be off by a factor of the scale. The
 * browser scales the drag image for us because it is a picture of a transformed element. A
 * coordinate correction here would be arithmetic applied to a gesture that has no coordinates.
 *
 * CLICK VERSUS DOUBLE CLICK is resolved on `event.detail`, in one handler, rather than with an
 * `onDoubleClick` beside an `onClick`. Both fire for a double click — that is the specified
 * behaviour, not a browser quirk — so a row wired both ways would expand and then open, and the
 * expansion would be a box nobody asked for. `detail === 0` is the keyboard's Enter, which has no
 * double and therefore no reason to wait.
 *
 * THE DISPATCH IS THE SAME ON EVERY ROW, including the rows that open nothing. What a single click
 * on a leaf row does is decided in `toggleNode` — it marks the row and opens no box — rather than by
 * a branch here, so the quarter-second wait, the double click that cancels it, and the record it
 * opens are one behaviour across the whole box instead of two that a reader has to tell apart by
 * which rows happen to be pointed at.
 *
 * TWO BUTTONS SIT AT THE END OF THE ROW AND BOTH ARE ALWAYS DRAWN. The magnifier is the keyboard's
 * half of the double click — it opens the record as a note — and the arrow is the disclosure, drawn
 * only where there is something to disclose. They were one glyph revealed on hover once, on the
 * argument that twenty of them in a 260px box is furniture rather than record; what that cost was
 * the two gestures this panel is for being invisible to anybody who had not yet swept a pointer
 * across a row, and absent entirely on a touch screen. They are SIBLINGS of the wide control rather
 * than children of it, so their clicks are their own and no handler has to stop anything
 * propagating. The third gesture, dragging the row into the composer, is the ROW's and has no button
 * beside it; see the note in the markup for why.
 */
function GraphRow({ box, card, graph, via }: GraphRowProps): ReactElement {
  const path = rowPath(box, card);
  const expanded = isExpanded(graph, path);
  // Whether this row has a disclosure at all — a question about the TABLE, so the answer is the same
  // for every row of it and for the whole time the row is on screen. It used to be a bit the server
  // computed per row, which meant the arrow could appear and vanish as the archive moved under the
  // reader; the control that folds an open box could go with it, and both this line and `toggleNode`
  // carried a clause to stop that happening. Neither needs one now.
  const canExpand = expands(card.table);
  // What the arrow does FROM WHERE IT IS NOW, on the label and on the tooltip alike: a disclosure
  // named "referrers" would be a control a reader has to press to find out which way it goes.
  const discloseLabel = expanded
    ? `Fold what points at this ${card.table}`
    : `Show what points at this ${card.table}`;
  const drag = dragHandlers(card);

  const pending = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    [],
  );

  /** Drop whatever single click is still waiting to find out it was half of a double one. */
  function clearPending(): void {
    if (pending.current === null) return;
    window.clearTimeout(pending.current);
    pending.current = null;
  }

  function onClick(event: MouseEvent<HTMLButtonElement>): void {
    if (event.detail === 0) {
      toggleNode(path, card);
      return;
    }
    clearPending();
    if (event.detail >= 2) {
      openRecord(card);
      return;
    }
    pending.current = window.setTimeout(() => {
      pending.current = null;
      toggleNode(path, card);
    }, DOUBLE_CLICK_MS);
  }

  const rowClass = [
    "graph__row",
    expanded ? "graph__row--expanded" : "",
    // The row the last click landed on, kept marked so a reader who has scrolled away and come back
    // can still see where they were reading from.
    graph.selection === path ? "graph__row--selected" : "",
    // PUT DOWN, AND DRAWN AS THE WORD CROSSED OUT. Read off the card's own sublabel rather than from
    // a table check here: the server says `inactive` on the two tables with a status column and
    // `abandoned` on the thesis whose ledger has closed, so this asks the wire what it already said
    // instead of keeping a second list of which tables can be retired. A shape rather than a shade,
    // on the precedent of the subagents toggle in `chat.css` — it survives a reader who cannot tell
    // two greys apart, and it is simply how anybody writing on a board says not this one.
    isRetired(card) ? "graph__row--retired" : "",
  ]
    .filter((name) => name !== "")
    .join(" ");

  return (
    <div className={rowClass} {...drag}>
      <button
        type="button"
        className="graph__open"
        // NO `aria-expanded` HERE ANY MORE, and it is not an oversight. The arrow beside this
        // control is a real disclosure button now, and one state announced by two controls is a row
        // that says "collapsed" twice. This one is also the wrong holder of it: on a row nothing
        // points at there is no disclosure at all, so `aria-expanded="false"` would be a promise of
        // a box that no gesture on this row can open. What this control IS gets said by its label
        // and its `title`; what is open gets said by the thing that opens it.
        title={rowTitle(card, via)}
        onClick={onClick}
        {...drag}
      >
        {/* The NAME, because a graph row is 260px wide and one line tall — there is room for the
            thing that identifies this row and not for both. The description is in the tooltip. */}
        {/* AND NO STAMP BESIDE IT. Every row used to carry a relative time — "2h", "yesterday" —
            which cost the row's whole right-hand end, pushed the name into an ellipsis sooner, and
            answered a question almost nobody was asking: what a reader wants from a graph of
            records is the shape of the archive, and a row's age is a fact about one row. The exact
            moment is still a keystroke away in the tooltip, where it does not compete for width,
            and it is an ABSOLUTE one there — which is the honest form for something being audited,
            and needs no timer to stay true. */}
        <span className="graph__label">{card.name}</span>
      </button>
      {/* NO GRIP SITS HERE. The ROW is the drag source, which is what the tooltip on it says, and a
          handle for a gesture the whole row already offers would be a glyph appearing under the
          pointer on every row of a twenty-row box for nothing. */}
      {/* NOR A `+` ON A RECIPE ROW: a recipe is immutable, and generating a report to one is asked
          for from the `+` on its report BOX, which is the one place that knows which recipe is being
          written to. A recipe row is a thing to read. */}
      <button
        type="button"
        className="btn btn--icon graph__magnify"
        aria-label={`Open this ${card.table} as a note`}
        title={`Open this ${card.table} as a note`}
        // The keyboard's half of the double click: a gesture that opens the record when it is
        // double-clicked must open it when the row is reached by tab and Enter, or the keyboard is
        // a second, quieter product.
        //
        // The row's deferred single click is dropped first, for the reason the arrow beside this
        // gives: every control that is NOT the row cancels the row's timer before acting, or one
        // gesture the reader made once becomes two things happening to the board.
        onClick={() => {
          clearPending();
          openRecord(card);
        }}
      >
        <MagnifyGlyph />
      </button>
      {canExpand ? (
        <button
          type="button"
          className="btn btn--icon graph__disclose"
          // The one control that carries the state, and it carries it BOTH WAYS: "collapsed" is
          // what tells a reader who cannot see the arrow that there is anything under this row at
          // all.
          aria-expanded={expanded}
          aria-label={discloseLabel}
          title={discloseLabel}
          // The row's own deferred single click is dropped first. A press here that landed a
          // quarter of a second after a press on the row would otherwise open the box and then have
          // the row's timer fold it again, from one gesture the reader made once.
          onClick={() => {
            clearPending();
            toggleNode(path, card);
          }}
        >
          {/* Two Geometric Shapes code points every system ships, SWAPPED rather than rotated: a
              transition on a mark in this box would be movement in a panel whose whole argument is
              that nothing moves under the pointer. */}
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </button>
      ) : (
        // Nothing to disclose, and the room is held anyway: magnifiers at two different distances
        // from the edge down one box read as two kinds of row rather than as one row with an extra
        // control. Inert, so it is not a stop on the way through the box by keyboard.
        <span className="graph__disclose-slot" aria-hidden="true" />
      )}
    </div>
  );
}

/**
 * The magnifier, drawn rather than typed.
 *
 * The same bargain the composer's context star makes (`Composer.tsx`), for the same reason: the
 * marks this window types — ▸ ▾ ↻ ✕ ⚠ — are characters every system ships, and a magnifier is not.
 * U+2315 arrives at a different weight from the text beside it on one machine and as a blank box on
 * the next, and 🔍 is a colour photograph, which is the one thing a chalk board cannot hold. Twelve
 * pixels of `currentColor` is two lines of markup and none of that.
 *
 * Decorative, and marked so: the button around it carries the label, so a reader who cannot see it
 * loses nothing.
 */
function MagnifyGlyph(): ReactElement {
  return (
    <svg className="graph__magnify-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <circle cx="5.1" cy="5.1" r="3.3" />
      <path d="M7.6 7.6 10.5 10.5" />
    </svg>
  );
}

/**
 * Opening a record: the card, and nothing else.
 *
 * The record OPENS, always: that is what a double click on a row means. WHERE it opens is on the
 * other side of `viewRecord`, which puts the record BESIDE whatever is already open instead of over
 * it — so a reader walking the graph accumulates the trail they walked rather than replacing it a
 * row at a time, and this file knows nothing about that.
 *
 * THE CONVERSATION IS NOT OPENED WITH IT, because there is nothing to open: the dock is permanently
 * on screen. So this line neither reads the row's PATH nor derives the record it hangs under: the
 * conversation a reader would talk about this record in is already below the graph, exactly as it
 * was a moment ago, composer draft intact.
 */
function openRecord(card: RecordCard): void {
  // The NAME as the placeholder, matching every other door into `viewRecord`: it is what the row
  // was showing, what the note's heading will settle on once the read lands, and therefore the one
  // string that does not make the heading change under the reader a moment after it appears.
  viewRecord(card.table, card.id, card.name);
}

/** Everything the row cannot fit on one 40px line, where a pointer can ask for it. The sublabel and
 * the exact instant are what an auditor wants second, after the label. */
function rowTitle(card: RecordCard, via: RecordGroup["via"]): string {
  // The name first, then what the row actually says — the row itself only had room for the first.
  const parts = [card.name, card.label];
  if (via !== undefined) parts.push(`via ${via}`);
  if (card.sublabel !== undefined) parts.push(card.sublabel);
  if (card.meta !== undefined) parts.push(formatAbsolute(card.meta));
  // LAST, AND IT IS THE ONLY PLACE THE GESTURE IS WRITTEN DOWN. A drag announces itself to nobody:
  // there is no cursor for it until it has started and no glyph beside the row, so a reader
  // who never tries it never learns the row can be carried. The tooltip is where this window says
  // every other thing a row will do.
  parts.push("drag it into the conversation to talk about it");
  return parts.join(" — ");
}

// -- reading the state off a box --------------------------------------------------------------------

/**
 * The expansion a box belongs to.
 *
 * A group box is its source row plus a table, so its expansion is one segment up; a note or a
 * refusal IS the expansion and takes the row's own path. The grammar lives in `state/graph.ts` and
 * `parentPath` is exported from there for exactly this — spelling it as a `lastIndexOf("/")` here
 * would be a second copy of a rule one module owns.
 */
function expansionFor(graph: GraphState, box: LayoutBox): Expansion | null {
  if (rootTableOf(box.path) !== null) return null;
  const key = box.kind === "group" ? parentPath(box.path) : box.path;
  if (key === null) return null;
  return graph.expansions.get(key) ?? null;
}

function groupFor(held: Expansion | null, box: LayoutBox): RecordGroup | null {
  if (held === null || box.table === null || box.kind !== "group") return null;
  return held.groups?.find((group) => group.table === box.table) ?? null;
}

/** The sentence a failed read left on a node that still has rows to show. A root box reads it off
 * its own `RootState`; every other box reads it off its own expansion. Neither borrows the other's:
 * a `script` table that could not be read says nothing about a `thesis` box. */
function staleFor(graph: GraphState, box: LayoutBox): string | null {
  const root = rootTableOf(box.path);
  if (root !== null) return rootOf(graph, root).error;
  return expansionFor(graph, box)?.error ?? null;
}

/**
 * The edge this box hangs off, in one clause: the column that carries it, the junction it runs
 * through when it runs through one, and what the database does to these rows when the record they
 * point at is deleted.
 *
 * Read straight off the key's declared action rather than guessed from the table names. A junction
 * is NEVER a row in this graph — it has no identity worth opening — so this annotation is the only
 * place it appears, which is also the only place it is true.
 */
function edgeFact(group: RecordGroup): string {
  const owner = group.via ?? group.table;
  const via = group.via === undefined ? "" : ` via ${group.via}`;
  return `${owner}.${group.column}${via}, on delete ${group.onDelete.toLowerCase()}`;
}
