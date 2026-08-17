/**
 * Where the five role slots are on screen, for the one gesture that cannot be told by the browser.
 *
 * `binTarget.ts` GENERALISED TO MORE THAN ONE TARGET, and everything that file argues holds here
 * word for word: a module-level registry rather than store state, because this holds DOM elements
 * and the store is a DOM-free module `bun test` drives directly; nothing renders from what is in
 * here, since it is read inside a pointer handler and never subscribed to.
 *
 * WHY IT EXISTS AT ALL is the Bin's reason exactly. A model note is dragged out of the pool with a
 * CAPTURED pointer — it has to be, because HTML5 drag-and-drop and pointer capture cannot share one
 * gesture — and a captured pointer fires no drop events: the element under the cursor never hears
 * about it, which is what capture means. So the note's own handler has to ask where the slots are
 * and work out for itself which one the pointer ended up in.
 *
 * WHAT IS NEW HERE IS THAT THERE ARE FIVE OF THEM, which changes one thing: the rectangles are read
 * ONCE PER PRESS as a batch — `slotRects()` — rather than one at a time per move. Five
 * `getBoundingClientRect` calls are five forced layouts, and doing that on every pointermove is
 * three hundred a second for a row of controls that is bolted to the composer and does not move
 * while a drag runs. The batch is then hit-tested with `overRect`, the same arithmetic the Bin uses,
 * so both gestures answer "is the pointer inside that box" the same way.
 *
 * The row wraps, so two slots can be on two lines and a slot can be anywhere; nothing here assumes an
 * order or a geometry. It answers the FIRST rectangle the point falls in, and `overRect` is
 * half-open on its far edges, so two slots sharing a border cannot both claim the pixel on it.
 */

import type { Rect } from "../state/notes.ts";
import { overRect } from "../state/notes.ts";

/** One slot, as it is on screen at the moment a drag began. */
export type SlotRect = { readonly role: string; readonly rect: Rect };

/** Keyed by role, which is the only name a slot has. A role is drawn at most once, so an element
 * replacing another under the same key is a remount rather than a collision. */
const elements = new Map<string, HTMLElement>();

/** One slot's own element, as it mounts. */
export function registerSlot(role: string, next: HTMLElement): void {
  elements.set(role, next);
}

/**
 * Let go on unmount — but ONLY of the element that is actually registered.
 *
 * `binTarget.ts`'s identity check, and the same trap: in a double mount the new element registers
 * BEFORE the old one's cleanup runs, so an unguarded delete would throw away the element that had
 * just arrived and leave that role unhittable. The failure mode is a drag that silently refuses to
 * assign anything to one slot, which is exactly the kind of bug nobody can reproduce.
 */
export function forgetSlot(role: string, gone: HTMLElement): void {
  if (elements.get(role) === gone) elements.delete(role);
}

/**
 * Every slot's rectangle, right now.
 *
 * READ ONCE, AT THE PRESS, by the caller — see `ModelPool.tsx`. An empty list is not a failure to
 * guard against so much as the honest answer while the row has not mounted, or on the harness that
 * draws no slots at all, and `slotAt` reads it as "the pointer is over no slot": a gesture that
 * began before there was anywhere to drop must not assign anything.
 */
export function slotRects(): readonly SlotRect[] {
  const rects: SlotRect[] = [];
  for (const [role, element] of elements) {
    const box = element.getBoundingClientRect();
    rects.push({ role, rect: { x: box.x, y: box.y, width: box.width, height: box.height } });
  }
  return rects;
}

/** Which slot a pointer at (px, py) is over, or null. Pure rect math on rectangles read at the
 * press; `state/notes.ts` owns the test, so the Bin and the slots agree about what "inside" means. */
export function slotAt(rects: readonly SlotRect[], px: number, py: number): string | null {
  for (const slot of rects) {
    if (overRect(slot.rect, px, py)) return slot.role;
  }
  return null;
}
