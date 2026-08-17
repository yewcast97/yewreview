/**
 * Where the reader is standing: how far the graph has been panned and how far it has been zoomed.
 *
 * PURE and DOM-FREE, like `graphLayout.ts` beside it, and for a reason that is not the same one. The
 * layout is pure so that it cannot measure; this is pure so that the one invariant a zoom has can be
 * written down and checked. THE GRAPH POINT UNDER THE POINTER DOES NOT MOVE — that is what makes a
 * wheel zoom feel like leaning in rather than like the canvas being yanked — and it is an equation
 * about three numbers, not a thing to eyeball. `tests/webGraphView.test.ts` asserts it directly.
 *
 * THE TRANSFORM IS ITS OWN SLICE OF THE STORE, deliberately not part of `GraphState`. The panel
 * memoizes `layoutGraph` on the graph slice's identity, so a pan written in there would recompute
 * every box's coordinates on every pointer event of a gesture that moves no box at all. Two facts
 * that change at completely different rates have no business sharing an identity.
 *
 * SCREEN COORDINATES IN, SCREEN COORDINATES OUT. Everything here is measured from the top-left of
 * the canvas, because that is what `translate(tx, ty) scale(s)` on a `transform-origin: 0 0` surface
 * means, and because a pointer event is a screen fact. `toGraph` is the one crossing, and it is the
 * only place the inverse is spelled out: a node drag's pointer movement is screen-space and its
 * offset is graph-space, so the drag divides by the scale, and a pan does not because it moves the
 * surface itself.
 */

export type ViewTransform = { scale: number; tx: number; ty: number };

export type Point = { x: number; y: number };

export type Size = { width: number; height: number };

/**
 * The zoom limits.
 *
 * Below a quarter the row labels are unreadable and the graph is a diagram of itself, which is worth
 * having; below that it is a smudge. Above two and a half a 260px box fills a third of the panel and
 * there is nothing left to navigate. ComfyUI's own range is wider at the bottom, and it can afford to
 * be — its nodes are shapes with sockets, and this one's are text.
 */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2.5;

/** Unzoomed, unpanned. What the reset control puts back. */
export const IDENTITY_VIEW: ViewTransform = { scale: 1, tx: 0, ty: 0 };

/**
 * How much of a zoom one pixel of wheel is worth, as an exponent.
 *
 * EXPONENTIAL, never additive. `scale + k` doubles the graph in one notch at 0.25 and moves it
 * imperceptibly at 2.5; `scale * exp(-delta * k)` is the same proportional step everywhere, which is
 * what makes zooming out and back in feel like one gesture rather than two differently geared ones.
 * The sign is negative because a wheel scrolled DOWN reports a positive `deltaY`, and scrolling down
 * has meant "smaller" since the first map application.
 *
 * At 0.001 a mouse notch — 100px in Chrome — is a step of about 1.105, close enough to the 1.1 per
 * notch ComfyUI uses that the two feel the same, and a trackpad's much smaller per-event deltas come
 * out as the smooth continuous zoom that hardware is for.
 */
const ZOOM_RATE = 0.001;

/**
 * `WheelEvent.deltaMode`, spelled here rather than read off the DOM enum so this module can be
 * tested without one. A wheel reporting LINES gives single digits, and treating those as pixels
 * would make a Firefox notch a rounding error.
 */
export const DELTA_PIXEL = 0;
export const DELTA_LINE = 1;
export const DELTA_PAGE = 2;

/** What a line and a page are worth in pixels. The pair every wheel normalizer has used since
 * jQuery, and they are conventions rather than measurements: nothing reports what a line is. */
const LINE_PX = 40;
const PAGE_PX = 800;

/** A wheel's `deltaY`, in pixels, whatever unit it arrived in. */
export function wheelPixels(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === DELTA_LINE) return deltaY * LINE_PX;
  if (deltaMode === DELTA_PAGE) return deltaY * PAGE_PX;
  return deltaY;
}

export function clampScale(scale: number): number {
  // A NaN can only arrive from arithmetic on a pointer event that reported nothing, and the honest
  // recovery is the identity scale rather than a canvas that has vanished.
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** A point on the canvas, in the graph's own coordinates — the inverse of what the surface's
 * `transform` does. What `layoutGraph` computed is what comes back out of this. */
export function toGraph(view: ViewTransform, point: Point): Point {
  return { x: (point.x - view.tx) / view.scale, y: (point.y - view.ty) / view.scale };
}

/**
 * Zoom about a point, holding the graph under it still.
 *
 * `pointer` is measured from the canvas's top-left corner and `delta` is a wheel's `deltaY` in
 * pixels. The new translation is solved rather than nudged: whatever graph point was under the
 * cursor is put back under the cursor at the new scale, which is one line of algebra and the whole
 * reason this is a function instead of two statements in an event handler.
 *
 * RETURNS THE VIEW IT WAS GIVEN at either limit. Keeping the object identity there is what stops a
 * reader who is already zoomed all the way out and still spinning the wheel from re-rendering the
 * panel sixty times a second for no movement.
 */
export function zoomAt(view: ViewTransform, pointer: Point, delta: number): ViewTransform {
  const scale = clampScale(view.scale * Math.exp(-delta * ZOOM_RATE));
  if (scale === view.scale) return view;
  const at = toGraph(view, pointer);
  return { scale, tx: pointer.x - at.x * scale, ty: pointer.y - at.y * scale };
}

/**
 * Move the surface, in SCREEN pixels.
 *
 * Undivided by the scale on purpose: this translates the surface itself, so a pointer that has
 * travelled 100 screen pixels drags the canvas exactly 100 screen pixels whatever the zoom. (A node
 * drag is the other case — it writes an offset in graph coordinates, and divides.)
 *
 * Apply it to the view the drag STARTED from, with the total offset since, never to the current view
 * with the delta since the last event. An accumulator drifts by a whole event whenever the pointer
 * capture is stolen or two moves are coalesced, and `useNodeDrag` already documents why that class of
 * bug is not worth owning twice.
 */
export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  if (dx === 0 && dy === 0) return view;
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy };
}

/**
 * Rescale the whole view about the canvas's top-left corner, by a ratio.
 *
 * WHAT THIS IS FOR is the board's half of the window changing width under a graph that is not
 * re-laid-out by it: the conversation dock's grip moves the boundary, the canvas keeps its origin at
 * the same screen point, and the picture should end up the same picture at a proportional size
 * rather than a picture with a slice of it now behind the dock. `zoomAt` holds the point under the
 * POINTER still; this holds the point under the ORIGIN still, which is the corner the board is
 * anchored at when it grows and shrinks.
 *
 * RETURNS THE VIEW IT WAS GIVEN for a ratio of exactly 1, for a non-finite one, and for anything at
 * or below zero. The last two are a degenerate board — a viewport of no width, a rectangle measured
 * before layout — and multiplying a transform by one of them loses the canvas for good; the identity
 * return is also what stops a gesture that has stopped moving from re-rendering the panel.
 *
 * THE TRANSLATION IS MULTIPLIED BY THE FACTOR THAT WAS ACTUALLY APPLIED and never by the ratio that
 * was asked for. `scale / view.scale` is the ratio itself until the zoom clamp binds, and at the
 * limit it is the smaller step the clamp allowed — which keeps the transform self-consistent and the
 * graph point under the origin exactly where it was. What degrades there is only how far the board
 * tracks the dock: a reader already zoomed to a limit sees the picture follow the edge
 * SUB-PROPORTIONALLY, and a view pinned hard against one gets the same view back, which is the
 * honest thing for a transform that has run out of zoom to give.
 */
export function scaleAboutOrigin(view: ViewTransform, r: number): ViewTransform {
  if (r === 1 || !Number.isFinite(r) || r <= 0) return view;
  const scale = clampScale(view.scale * r);
  const applied = scale / view.scale;
  if (applied === 1) return view;
  return { scale, tx: view.tx * applied, ty: view.ty * applied };
}

/**
 * The whole graph, centred in the viewport.
 *
 * `bounds` is the layout's own width and height, which already covers every dragged box, and
 * `viewport` is the canvas. Both come from the caller: measuring the canvas costs one
 * `getBoundingClientRect` on a click, and the measure-nothing doctrine next door is about LAYOUT —
 * a height that decides where a box goes — not about asking how big the window is when somebody
 * presses a button that means "how big is the window".
 *
 * NEVER MAGNIFIES. A graph with one box in it would otherwise be fitted to two and a half times
 * size, which is not a fit, it is a zoom nobody asked for; a graph that already fits is shown at the
 * size it was drawn.
 */
export function fitView(bounds: Size, viewport: Size): ViewTransform {
  if (
    !(bounds.width > 0) ||
    !(bounds.height > 0) ||
    !(viewport.width > 0) ||
    !(viewport.height > 0)
  ) {
    return IDENTITY_VIEW;
  }
  const scale = clampScale(
    Math.min(1, viewport.width / bounds.width, viewport.height / bounds.height),
  );
  return {
    scale,
    tx: (viewport.width - bounds.width * scale) / 2,
    ty: (viewport.height - bounds.height * scale) / 2,
  };
}
