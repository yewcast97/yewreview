/**
 * Where the conversation dock is.
 *
 * PURE and DOM-FREE, like `state/chat.ts` and `state/graph.ts`, and for the same reason: `bun test`
 * drives it directly under the root tsconfig, so the cases that are miserable to reproduce by hand —
 * a viewport smaller than the margins, an odd width, a window resized under a board full of notes —
 * are asserted rather than hoped for. Nothing in here reads `window`; the callers pass the viewport
 * in.
 *
 * THE DOCK IS NOT A WINDOW, and this file holds nothing a window would need. There is no position to
 * remember, no height and no open flag — ONE scalar, the split, and everything else is a RULE: the
 * conversation runs top to bottom down the right of the glass, inset by the margin every floating
 * thing in this window keeps. What that one number says is how much of the desk each half gets,
 * which leaves the argument the earlier arrangement made with no scalar at all standing whole: a
 * conversation is not something you fetch, put away or arrange — it is something you can give more
 * or less room to without ever putting it down.
 *
 * A SPLIT RATHER THAN A WIDTH, and the difference is what makes the clamp legible from both sides.
 * The split is WHERE THE DOCK'S LEFT EDGE SITS as a fraction of the viewport's width, so the board's
 * width is exactly that edge and bounding the split to [1/3, 2/3] is the same sentence said about
 * either half: neither the conversation nor the board may be squeezed below a third of the window.
 * A held width would have to be re-derived against every screen it outlived; a fraction is already
 * the answer on all of them.
 *
 * A VERTICAL SPLIT is a bargain about the whole window rather than about this panel. The board keeps
 * the other side and keeps it WHOLE — a dock along the bottom edge cut the slate into a wide strip
 * that no cascade of notes could use, and every note put up had to dodge a rectangle whose height the
 * reader kept changing. Splitting the window down its height gives both halves a shape: a column of
 * conversation that reads like a conversation, and a field of board that a note can be dragged
 * anywhere on.
 *
 * THE LEFT EDGE IS NOT GLASS, which is why only three sides are inset. It sits against the board
 * rather than against the window, and a margin there would be a gap between two things that are
 * meant to meet. It is also the ONE edge a grip can be on, for exactly that reason: the other three
 * are the window's, and a gesture on any of them would be a gesture against the argument above
 * rather than against this panel.
 *
 * THE RECTANGLE IS ARITHMETIC HERE RATHER THAN A RULE IN THE STYLESHEET, which is the same bargain
 * `lib/graphLayout.ts` makes with `graph.css`. The component writes the whole rectangle onto the
 * element as an inline style and `ChatDock.css` declares none of it — one copy of each figure, and no
 * way for them to drift. The store reads the same function for a different number: where the dock's
 * left edge is, so a freshly opened note is never put down on the conversation.
 */

/** A width and a height. The dock's own box, and the viewport it has to stay inside. */
export type Box = { width: number; height: number };

/** The dock's whole rectangle, in viewport pixels — what `position: fixed` is given. */
export type DockRect = { x: number; y: number; width: number; height: number };

/** The margin the dock keeps off the viewport's edges — `--float-inset`, mirrored from `tokens.css`
 * on the bargain named in the header. The board runs to the glass, so this is the step every
 * floating thing keeps off the edge and nothing more. */
const EDGE = 12;

/**
 * How far the dock's left edge may be dragged, as a fraction of the window, and where it starts.
 *
 * A THIRD IS THE FLOOR ON BOTH HALVES BECAUSE THE SAME BOUND SAYS BOTH THINGS. Below a third of a
 * laptop the transcript is a column of two-word lines and the composer's own furniture — the context
 * strip, the model picker, the foot — is wider than the box it describes; below a third the OTHER
 * way the board is narrower than a single note, and the cascade has nowhere to step. Neither half is
 * worth having at less, so neither is offered it.
 *
 * The default is the midline, which is where this window has always split and what a reader who has
 * never touched the grip keeps.
 */
export const MIN_SPLIT = 1 / 3;
export const MAX_SPLIT = 2 / 3;
export const DEFAULT_SPLIT = 1 / 2;

/**
 * A split, bounded.
 *
 * A NON-FINITE SPLIT RECOVERS TO THE MIDLINE rather than propagating, on `clampScale`'s precedent in
 * `lib/graphView.ts`: the only way one can arrive is arithmetic over a gesture that reported nothing
 * — a pointer distance divided by a viewport of zero width — and a window whose conversation has
 * gone to `NaN` pixels is a worse answer than one back where it started.
 */
export function clampSplit(split: number): number {
  if (!Number.isFinite(split)) return DEFAULT_SPLIT;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, split));
}

/**
 * The dock's whole rectangle: everything right of the split, full height.
 *
 * The left edge is the split's share of the width — rounded, because it lands in `left` pixels and a
 * fractional box makes the browser resample every glyph in the transcript — and the width is
 * whatever is left after the right margin. Deriving the width from the rounded edge rather than
 * taking the same fraction of the viewport twice is what keeps the right inset exactly `EDGE` at odd
 * widths, instead of a pixel either side of it.
 *
 * THE SPLIT IS REQUIRED AND HAS NO DEFAULT HERE. A caller allowed to omit it would draw one of these
 * two rectangles at the midline while the reader had dragged the other somewhere else — the dock and
 * the board disagreeing about where the boundary is, which is the single drift this module exists to
 * make impossible. The store holds the number; everyone who needs a rectangle passes it in.
 *
 * Both sizes are floored at zero, for a window too small to hold the margins at all. That box is
 * degenerate and nothing can be read in it; what matters is that it is not NEGATIVE, which is a
 * `width` the browser rejects and a rectangle whose edges have swapped.
 */
export function dockRect(viewport: Box, split: number): DockRect {
  const x = Math.round(viewport.width * clampSplit(split));
  return {
    x,
    y: EDGE,
    width: Math.max(0, viewport.width - EDGE - x),
    height: Math.max(0, viewport.height - EDGE * 2),
  };
}
