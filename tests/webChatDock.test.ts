/**
 * Where the conversation dock is.
 *
 * Pure arithmetic over a viewport and one scalar, which is why it is testable at all: the dock's
 * rectangle is decided in `state/chatDock.ts` rather than by CSS, so the cases that are miserable to
 * stage in a browser — an odd-numbered width, a window smaller than its own margins, an edge dragged
 * past its bound — are assertions here instead of things somebody once checked by hand.
 *
 * The property every test below is really about: THE DOCK IS A RULE WITH ONE POSTURE IN IT. There is
 * no held height, no position, no open flag and no z; there is exactly one number a reader can move,
 * the SPLIT, and one gesture that moves it. So what is asserted is the window's rule — three edges
 * against the glass, whole pixels, no negative box — plus the two things that number is allowed to
 * do: stay inside [1/3, 2/3], and recover to the midline when the arithmetic that produced it
 * reported nothing.
 *
 * THE SECOND CONSUMER IS THE NOTE CASCADE, and it is why `x` is asserted as carefully as the rest:
 * `state/notes.ts` anchors a fresh note a note's width to the LEFT of this number, so an `x` that
 * drifted would put every newly opened record on top of the conversation. See `webNotes.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import type { Box } from "../web/src/state/chatDock.ts";
import {
  DEFAULT_SPLIT,
  MAX_SPLIT,
  MIN_SPLIT,
  clampSplit,
  dockRect,
} from "../web/src/state/chatDock.ts";

/** A comfortable laptop. */
const WIDE: Box = { width: 1440, height: 900 };

describe("the dock's rectangle", () => {
  test("everything right of the split, top to bottom, inset by the float margin", () => {
    expect(dockRect(WIDE, DEFAULT_SPLIT)).toEqual({ x: 720, y: 12, width: 708, height: 876 });
  });

  test("12 off the three edges that are glass, and nothing off the one that is not", () => {
    // 12 is EDGE, mirrored from `--float-inset`. The left edge is the board's rather than the
    // window's, and a margin there would be a gap between two things meant to meet — which is also
    // why that is the one edge with a grip on it.
    for (const split of [MIN_SPLIT, DEFAULT_SPLIT, MAX_SPLIT]) {
      const rect = dockRect(WIDE, split);
      expect(rect.y).toBe(12);
      expect(WIDE.height - (rect.y + rect.height)).toBe(12);
      expect(WIDE.width - (rect.x + rect.width)).toBe(12);
    }
    expect(dockRect(WIDE, DEFAULT_SPLIT).x).toBe(WIDE.width / 2);
  });

  test("the left edge is the split's share of the width", () => {
    // The one line of arithmetic the whole split rests on: the board's width IS this number, so a
    // fraction of the viewport is the same statement about either half.
    expect(dockRect(WIDE, MIN_SPLIT).x).toBe(Math.round(1440 / 3));
    expect(dockRect(WIDE, MAX_SPLIT).x).toBe(Math.round((1440 * 2) / 3));
    expect(dockRect({ width: 1000, height: 900 }, 0.42).x).toBe(420);
  });

  test("the inner edge tracks the window as it is resized, at whatever split is held", () => {
    // The split is a FRACTION, which is what lets a resize move the edge without touching the
    // number: a width remembered in pixels would have to be re-fitted to every screen.
    expect(dockRect({ width: 2000, height: 900 }, DEFAULT_SPLIT).x).toBe(1000);
    expect(dockRect({ width: 900, height: 900 }, DEFAULT_SPLIT).x).toBe(450);
    expect(dockRect({ width: 2000, height: 900 }, MIN_SPLIT).x).toBe(667);
    expect(dockRect({ width: 900, height: 900 }, MIN_SPLIT).x).toBe(300);
  });

  test("a split outside the bounds draws the rectangle at the bound", () => {
    // The rectangle clamps for itself rather than trusting its caller, because two of them read it
    // — the dock and the note cascade — and a rectangle that honoured a junk split would put a
    // freshly opened note somewhere no dock ever was.
    expect(dockRect(WIDE, 0.05)).toEqual(dockRect(WIDE, MIN_SPLIT));
    expect(dockRect(WIDE, 12)).toEqual(dockRect(WIDE, MAX_SPLIT));
    expect(dockRect(WIDE, Number.NaN)).toEqual(dockRect(WIDE, DEFAULT_SPLIT));
  });

  test("everything lands on whole pixels, at odd sizes and odd splits alike", () => {
    // These end up as `left`/`width` in pixels, and a fractional box makes the browser resample
    // every glyph in the transcript. An odd width under a third is the case that catches a naive
    // multiplication left unrounded.
    for (const viewport of [WIDE, { width: 1437, height: 899 }, { width: 801, height: 601 }]) {
      for (const split of [MIN_SPLIT, DEFAULT_SPLIT, 0.5731, MAX_SPLIT]) {
        const rect = dockRect(viewport, split);
        for (const value of [rect.x, rect.y, rect.width, rect.height]) {
          expect(Number.isInteger(value)).toBe(true);
        }
      }
    }
  });

  test("an odd width keeps the right inset exact rather than splitting the rounding", () => {
    // 1437 halves to 718.5, and thirds to 479. Whichever way either rounds, the margin off the
    // right glass has to stay 12 — which is why the width is derived from the ROUNDED edge instead
    // of taking the same fraction of the viewport twice.
    const half = dockRect({ width: 1437, height: 900 }, DEFAULT_SPLIT);
    expect(half.x).toBe(719);
    expect(1437 - (half.x + half.width)).toBe(12);

    const third = dockRect({ width: 1437, height: 900 }, MIN_SPLIT);
    expect(third.x).toBe(479);
    expect(1437 - (third.x + third.width)).toBe(12);
  });

  test("a window too small for the margins gives an empty box rather than a negative one", () => {
    // Nothing can be read in this rectangle and nothing is meant to be. What matters is that its
    // edges have not swapped: a negative `width` is a value the browser refuses outright.
    const rect = dockRect({ width: 20, height: 20 }, DEFAULT_SPLIT);
    expect(rect.width).toBe(0);
    expect(rect.height).toBe(0);
    expect(rect.x).toBe(10);
    expect(rect.y).toBe(12);
  });
});

describe("the one number a reader can move", () => {
  test("neither half may be squeezed below a third of the window", () => {
    expect(clampSplit(0)).toBe(MIN_SPLIT);
    expect(clampSplit(-4)).toBe(MIN_SPLIT);
    expect(clampSplit(1)).toBe(MAX_SPLIT);
    expect(clampSplit(0.9)).toBe(MAX_SPLIT);
    expect(MIN_SPLIT).toBe(1 / 3);
    expect(MAX_SPLIT).toBe(2 / 3);
  });

  test("a split already inside the range is left exactly as it is", () => {
    // No snapping and no steps: the edge follows the pointer, and a gesture that ends between two
    // convenient numbers ends where the reader let go.
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(0.4137)).toBe(0.4137);
  });

  test("junk recovers to the midline rather than propagating", () => {
    // The only way a non-finite split can arrive is arithmetic over a gesture that reported nothing
    // — a pointer distance divided by a viewport of zero width — and a conversation at NaN pixels is
    // a window with nothing in it. `clampScale` recovers the same way for the same reason.
    expect(clampSplit(Number.NaN)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_SPLIT);
    expect(DEFAULT_SPLIT).toBe(1 / 2);
  });
});
