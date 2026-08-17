/**
 * One drag gesture, done the only way that does not drift.
 *
 * Several things in this window are moved by holding a strip: a node box on the graph canvas, a
 * note on the board, a model in the pool, the conversation dock's inner edge. They are the same
 * gesture with different destinations, and this is that gesture — extracted rather than written five
 * times, because the discipline below is easy to get subtly wrong in a way that nobody can
 * reproduce. The dock is the odd one: three of its edges are a rule and cannot be dragged at all,
 * and the fourth is a boundary between two halves of the window rather than a side of a box, so what
 * its gesture moves is the SPLIT and everything derived from it (`state/chatDock.ts` argues the
 * rule; `dragDockTo` in the store does the moving).
 *
 * THE POINTER IS CAPTURED, so a fast drag that outruns the element keeps sending moves to it instead
 * of to whatever is now underneath. Without capture the thing being dragged is dropped the moment
 * the cursor leaves it, which during a real drag is most of the time.
 *
 * EVERY MOVE REPORTS THE TOTAL DISTANCE FROM WHERE THE DRAG STARTED, never the step since the last
 * event. An accumulator loses a whole event whenever the browser coalesces moves or the capture is
 * taken away, and the symptom is a box that ends up a few pixels from where it was dropped — a bug
 * with no reproduction. So the caller is handed `(from, dx, dy)` where `from` is whatever it decided
 * to remember at pointerdown and dx/dy are measured against that same instant: the answer is a
 * function of the gesture rather than a sum over its history, and a dropped event costs one frame of
 * smoothness and nothing else.
 *
 * WHAT `from` IS FOR is anything that must be read ONCE, at the start, rather than per move. The
 * graph reads the zoom scale into it — re-reading it mid-drag would change the divisor of an offset
 * measured from a fixed start, and the node would teleport — and a note being resized reads the
 * viewport it is being clamped against. A note reads where the pointer went down and where the Bin
 * is, so that letting go over the Bin can be told from letting go anywhere else; a model in the
 * pool reads its own rectangle, because the shelf under it scrolls. All of them are cases where
 * the value moving under the gesture would make the arithmetic mean something different halfway
 * through, which is why `begin` is handed the event rather than being asked to find it again.
 *
 * `end` FIRES ON POINTERUP AND NEVER ON POINTERCANCEL, and that asymmetry is a safety property
 * rather than a detail. A move is idempotent — the worst a lost gesture costs is a box in the wrong
 * place — but the one thing hung off the end of a drag in this window is DELETING A RECORD, and a
 * pointercancel is the browser saying the gesture was taken away: the pen left the tablet, the OS
 * took the pointer for a system gesture, the element was removed underneath it. None of those is
 * somebody letting go over the Bin, and every one of them would be read as one by a handler that
 * treated both endings the same.
 */

import { useRef } from "react";
import type { PointerEvent } from "react";

export type PointerDragHandlers = {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
};

/**
 * @param begin What to remember at pointerdown: the value being dragged, plus anything that must not
 *   be re-read while the gesture runs. Handed the press itself, for the callers that need to know
 *   where on the screen it happened.
 * @param move Called on every move with what `begin` returned and the total screen-pixel distance
 *   travelled since the press.
 * @param end Called when the pointer is LET GO, with the same three arguments the last move had.
 *   Never called for a cancelled gesture — see the header for why that distinction is load-bearing.
 */
export function usePointerDrag<T>(
  begin: (event: PointerEvent<HTMLElement>) => T,
  move: (from: T, dx: number, dy: number) => void,
  end?: (from: T, dx: number, dy: number) => void,
): PointerDragHandlers {
  const from = useRef<{ x: number; y: number; held: T } | null>(null);

  /** Let the pointer go, and hand back what the gesture had travelled — or null when there was no
   * gesture, which is every pointerup that did not follow one of our own pointerdowns. */
  const release = (
    event: PointerEvent<HTMLElement>,
  ): { held: T; dx: number; dy: number } | null => {
    const start = from.current;
    if (start === null) return null;
    from.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    return { held: start.held, dx: event.clientX - start.x, dy: event.clientY - start.y };
  };

  return {
    onPointerDown: (event) => {
      // The primary button only. A right click is the browser's own menu, and a middle click belongs
      // to whatever is listening further up — on the graph canvas that is the pan, which is entitled
      // to the middle button from anywhere.
      if (event.button !== 0) return;
      // An ancestor may be listening for the same pointerdown — the graph's canvas pan is, on the
      // element every node sits inside — and two captures of one pointer is one of them silently
      // losing its moves. The gesture belongs to the element that was pressed.
      event.stopPropagation();
      from.current = { x: event.clientX, y: event.clientY, held: begin(event) };
      // Capture can be REFUSED — `NotFoundError` when the pointer is no longer active by the time
      // the handler runs: a pen lifted in the same instant, a pointer cancelled mid-dispatch, a
      // test harness's synthetic press. A refused capture must not take the press down with it;
      // uncaptured, the drag simply degrades to working while the pointer stays over the element.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* uncaptured — see above */
      }
      // Stops the press from selecting the text under it, which on a drag paints a blue smear across
      // everything the pointer crosses.
      event.preventDefault();
    },
    onPointerMove: (event) => {
      const start = from.current;
      if (start === null) return;
      move(start.held, event.clientX - start.x, event.clientY - start.y);
    },
    onPointerUp: (event) => {
      const done = release(event);
      if (done === null) return;
      end?.(done.held, done.dx, done.dy);
    },
    onPointerCancel: (event) => {
      release(event);
    },
  };
}
