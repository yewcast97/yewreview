/**
 * Where the Bin is on screen, for the one gesture that cannot be told by the browser.
 *
 * A MODULE-LEVEL REGISTRY RATHER THAN STATE: this holds a DOM element, and the store is a DOM-free
 * module that `bun test` drives directly. Nothing renders from what is in here — it is read once,
 * inside a pointer handler, and never subscribed to — so putting it in the store would buy nothing
 * and cost that module its testability.
 *
 * WHY IT EXISTS AT ALL: there are two ways to drop something on the Bin in this window and they are
 * different mechanisms. A record ROW is dragged with the browser's own drag-and-drop, so the Bin
 * hears `dragover` and `drop` and needs none of this. A NOTE is dragged with a captured pointer —
 * it has to be, because HTML5 drag and pointer capture cannot share one gesture — and a captured
 * pointer fires no drop events at all: the element under the cursor never hears about it, because
 * that is precisely what capture means. So the note's own handler has to ask where the Bin is and
 * work out for itself whether the pointer ended up inside it.
 *
 * THE RECTANGLE IS READ AT THE PRESS, once, by the caller — see `NoteBoard.tsx`. Not because the Bin
 * cannot move (it is bolted to the bottom-left corner and nothing moves it mid-gesture) but because
 * `getBoundingClientRect` forces a layout, and doing that on every pointermove is sixty of them a
 * second for a rectangle that is not changing.
 */

import type { Rect } from "../state/notes.ts";

let element: HTMLElement | null = null;

/** The Bin's own section, as it mounts. */
export function registerBinElement(next: HTMLElement): void {
  element = next;
}

/**
 * Let go on unmount — but ONLY of the element that is actually registered.
 *
 * The identity check is the ordinary React double-mount trap rather than defensiveness: in a
 * strict-mode remount the new element registers BEFORE the old one's cleanup runs, so an unguarded
 * clear would throw away the element that had just arrived and leave the board unable to find the
 * Bin at all — which fails as a drag that silently refuses to delete anything.
 */
export function forgetBinElement(gone: HTMLElement): void {
  if (element === gone) element = null;
}

/**
 * Where the Bin is right now, or null when there is no Bin.
 *
 * Null is not a failure case to guard against so much as the honest answer during the frames before
 * the corner column mounts — and `overRect` reads it as "the pointer is not over the Bin", which is
 * the safe direction: a gesture that began before the Bin existed must not say anything on the
 * reader's behalf.
 */
export function binRect(): Rect | null {
  if (element === null) return null;
  const box = element.getBoundingClientRect();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}
