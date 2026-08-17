/**
 * The pan and the zoom, as arithmetic.
 *
 * There is exactly one thing a zoom has to get right and it cannot be checked by looking at it: THE
 * GRAPH POINT UNDER THE POINTER MUST NOT MOVE. Get it wrong and the canvas slides away from the
 * cursor by an amount proportional to how far you have already panned, which reads as "the zoom is
 * a bit off" rather than as a solved equation with a sign error in it. So it is asserted here, from
 * several different starting transforms, at both ends of the clamp — and that is the whole reason
 * `lib/graphView.ts` is a module of pure functions rather than four lines inside an event handler.
 */

import { describe, expect, test } from "bun:test";

import {
  DELTA_LINE,
  DELTA_PAGE,
  DELTA_PIXEL,
  IDENTITY_VIEW,
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  fitView,
  panBy,
  scaleAboutOrigin,
  toGraph,
  wheelPixels,
  zoomAt,
} from "../web/src/lib/graphView.ts";
import type { Point, ViewTransform } from "../web/src/lib/graphView.ts";

/** A few transforms that are not the identity, so nothing below can pass by accident on zeroes. */
const VIEWS: ViewTransform[] = [
  IDENTITY_VIEW,
  { scale: 1, tx: -240, ty: 96 },
  { scale: 0.4, tx: 317, ty: -1_042 },
  { scale: 1.8, tx: -55.5, ty: -12.25 },
];

const POINTERS: Point[] = [
  { x: 0, y: 0 },
  { x: 412, y: 233 },
  { x: 19.5, y: 700 },
];

/** The forward transform the stylesheet applies: `translate(tx, ty) scale(s)` on an origin of 0 0. */
function toScreen(view: ViewTransform, point: Point): Point {
  return { x: point.x * view.scale + view.tx, y: point.y * view.scale + view.ty };
}

describe("screen and graph coordinates are inverses", () => {
  test("toGraph undoes what the surface's transform does", () => {
    for (const view of VIEWS) {
      for (const point of POINTERS) {
        const back = toGraph(view, toScreen(view, point));
        expect(back.x).toBeCloseTo(point.x, 9);
        expect(back.y).toBeCloseTo(point.y, 9);
      }
    }
  });
});

describe("a wheel zoom holds the graph still under the pointer", () => {
  test("whatever was under the cursor is still under it afterwards", () => {
    // The invariant, from four transforms and three cursor positions, zooming both ways. A sign
    // error or a forgotten pan term survives exactly one of these twelve and none of the rest.
    for (const view of VIEWS) {
      for (const pointer of POINTERS) {
        for (const delta of [-100, -13, 7, 240]) {
          const before = toGraph(view, pointer);
          const after = toGraph(zoomAt(view, pointer, delta), pointer);
          expect(after.x).toBeCloseTo(before.x, 6);
          expect(after.y).toBeCloseTo(before.y, 6);
        }
      }
    }
  });

  test("it still holds on the step that hits the limit", () => {
    // The clamp changes the scale after the exponential has been applied, and the translation is
    // solved from the CLAMPED scale. Solving it from the wanted one would make the last notch of a
    // zoom — the one where the reader is already pushing against the end — the one that jumps.
    const view = { scale: 0.3, tx: 88, ty: -40 };
    const pointer = { x: 260, y: 140 };
    const pinned = zoomAt(view, pointer, 10_000);
    expect(pinned.scale).toBe(MIN_SCALE);
    expect(toGraph(pinned, pointer).x).toBeCloseTo(toGraph(view, pointer).x, 6);
    expect(toGraph(pinned, pointer).y).toBeCloseTo(toGraph(view, pointer).y, 6);
  });

  test("scrolling down zooms out and up zooms in", () => {
    // A wheel scrolled down reports a positive deltaY, and down has meant smaller since the first
    // map. The sign lives in one place and this is what says which way it points.
    const pointer = { x: 100, y: 100 };
    expect(zoomAt(IDENTITY_VIEW, pointer, 100).scale).toBeLessThan(1);
    expect(zoomAt(IDENTITY_VIEW, pointer, -100).scale).toBeGreaterThan(1);
  });
});

describe("the zoom is exponential, so it feels the same everywhere", () => {
  test("in and back out returns to exactly where it started", () => {
    for (const view of VIEWS) {
      const pointer = { x: 333, y: 210 };
      const back = zoomAt(zoomAt(view, pointer, -137), pointer, 137);
      expect(back.scale).toBeCloseTo(view.scale, 9);
      expect(back.tx).toBeCloseTo(view.tx, 6);
      expect(back.ty).toBeCloseTo(view.ty, 6);
    }
  });

  test("one notch is the same proportional step at every scale", () => {
    // The reason it is `scale * exp(-d * k)` rather than `scale + k`: an additive step doubles the
    // graph in one notch down at the bottom of the range and does nothing at the top.
    const pointer = { x: 40, y: 40 };
    const ratio = (from: number): number =>
      zoomAt({ scale: from, tx: 0, ty: 0 }, pointer, -100).scale / from;
    expect(ratio(0.5)).toBeCloseTo(ratio(1), 12);
    expect(ratio(1)).toBeCloseTo(ratio(2), 12);
  });
});

describe("the scale is clamped at both ends", () => {
  test("no amount of wheel goes past either limit", () => {
    const pointer = { x: 200, y: 120 };
    let out = IDENTITY_VIEW;
    let into = IDENTITY_VIEW;
    for (let i = 0; i < 200; i += 1) {
      out = zoomAt(out, pointer, 100);
      into = zoomAt(into, pointer, -100);
    }
    expect(out.scale).toBe(MIN_SCALE);
    expect(into.scale).toBe(MAX_SCALE);
  });

  test("a wheel spun at the limit returns the view it was given", () => {
    // Identity, not equality: this is what stops a reader who is already zoomed all the way out and
    // still spinning from re-rendering the panel sixty times a second for no movement at all.
    const pointer = { x: 200, y: 120 };
    const pinned = zoomAt({ scale: MIN_SCALE, tx: 12, ty: 34 }, pointer, 100);
    expect(pinned).toEqual({ scale: MIN_SCALE, tx: 12, ty: 34 });
    expect(zoomAt(pinned, pointer, 100)).toBe(pinned);
  });

  test("clampScale answers for junk as well as for numbers", () => {
    expect(clampScale(0.001)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.25)).toBe(1.25);
    // A NaN can only come from arithmetic on an event that reported nothing, and a canvas that has
    // vanished is a worse answer than one that has gone back to life size.
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("a wheel's units are normalized before any of that", () => {
  test("lines and pages are not pixels", () => {
    // Firefox reports a notch as three LINES. Treating that as three pixels would make a whole
    // notch of wheel a rounding error, and the zoom would look broken in one browser only.
    expect(wheelPixels(3, DELTA_PIXEL)).toBe(3);
    expect(wheelPixels(3, DELTA_LINE)).toBe(120);
    expect(wheelPixels(1, DELTA_PAGE)).toBe(800);
    expect(wheelPixels(-3, DELTA_LINE)).toBe(-120);
    expect(wheelPixels(Number.NaN, DELTA_PIXEL)).toBe(0);
  });

  test("a line-mode notch is a real zoom step rather than nothing", () => {
    const pointer = { x: 10, y: 10 };
    const raw = zoomAt(IDENTITY_VIEW, pointer, wheelPixels(-3, DELTA_PIXEL)).scale;
    const normalized = zoomAt(IDENTITY_VIEW, pointer, wheelPixels(-3, DELTA_LINE)).scale;
    expect(raw).toBeLessThan(1.01);
    expect(normalized).toBeGreaterThan(1.1);
  });
});

describe("a pan moves the surface in screen pixels", () => {
  test("the scale does not divide it", () => {
    // The counterpart of the division in `useNodeDrag`. A pan translates the surface itself, so a
    // pointer that travelled 100 screen pixels drags the canvas 100 screen pixels at every zoom;
    // dividing here would make the canvas crawl when zoomed out and bolt when zoomed in.
    for (const scale of [0.25, 1, 2.5]) {
      const moved = panBy({ scale, tx: 10, ty: -20 }, 100, 40);
      expect(moved).toEqual({ scale, tx: 110, ty: 20 });
    }
  });

  test("applied to the view the drag started from, it is the absolute offset", () => {
    // How the panel uses it: the START transform, and the TOTAL distance travelled since. Two moves
    // of a gesture that has reached the same place put the canvas in the same place, whether the
    // pointer got there in one event or in two.
    const start = { scale: 0.8, tx: 5, ty: 5 };
    expect(panBy(start, 30, 12)).toEqual(panBy(panBy(start, 20, 8), 10, 4));
  });

  test("a pointer that has not moved returns the view it was given", () => {
    const view = { scale: 1, tx: 3, ty: 4 };
    expect(panBy(view, 0, 0)).toBe(view);
  });
});

describe("rescaling the board when the dock's edge moves", () => {
  const ORIGIN: Point = { x: 0, y: 0 };

  test("the graph point under the canvas's corner does not move", () => {
    // The counterpart of the wheel zoom's invariant, about the other anchor: the board grows and
    // shrinks from its top-left corner, so that is the point the picture must be held still under.
    // Get it wrong and every drag of the grip slides the graph away from wherever it was panned to.
    for (const view of VIEWS) {
      for (const r of [0.5, 0.82, 1.25, 2]) {
        const before = toGraph(view, ORIGIN);
        const after = toGraph(scaleAboutOrigin(view, r), ORIGIN);
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
      }
    }
  });

  test("it still holds when the zoom clamp binds at either limit", () => {
    // The translation is multiplied by the factor that was ACTUALLY APPLIED — `scale / view.scale`
    // — rather than by the ratio that was asked for. Using the wanted ratio would leave the
    // transform inconsistent with its own scale exactly when the reader is at a limit, and the
    // board would jump on the frame the clamp first bit.
    for (const [view, r] of [
      [{ scale: 2, tx: -300, ty: 140 }, 4],
      [{ scale: 0.3, tx: 88, ty: -40 }, 0.2],
    ] as const) {
      const scaled = scaleAboutOrigin(view, r);
      expect(scaled.scale).toBe(r > 1 ? MAX_SCALE : MIN_SCALE);
      expect(toGraph(scaled, ORIGIN).x).toBeCloseTo(toGraph(view, ORIGIN).x, 6);
      expect(toGraph(scaled, ORIGIN).y).toBeCloseTo(toGraph(view, ORIGIN).y, 6);
    }
  });

  test("a board already at a zoom limit tracks the edge sub-proportionally", () => {
    // The honest degradation, asserted so it stays honest: a view pinned at MAX_SCALE cannot grow
    // by another quarter, so the picture follows the dock part of the way and no further. What it
    // must never do is follow it by pretending to a scale it does not have.
    const pinned = { scale: MAX_SCALE, tx: -120, ty: 60 };
    const scaled = scaleAboutOrigin(pinned, 1.25);
    expect(scaled.scale).toBe(MAX_SCALE);
    expect(scaled).toBe(pinned);
  });

  test("a ratio of exactly one, or of junk, returns the view it was given", () => {
    // Identity, not equality. A grip held still, a gesture over a degenerate board, a rectangle
    // measured before layout: none of them is a reason to re-render the panel, and two of them are
    // arithmetic that would lose the canvas for good if it were carried through.
    const view = { scale: 0.8, tx: 42, ty: -17 };
    expect(scaleAboutOrigin(view, 1)).toBe(view);
    expect(scaleAboutOrigin(view, Number.NaN)).toBe(view);
    expect(scaleAboutOrigin(view, 0)).toBe(view);
    expect(scaleAboutOrigin(view, -2)).toBe(view);
    expect(scaleAboutOrigin(view, Number.POSITIVE_INFINITY)).toBe(view);
  });

  test("a proportional widening is a proportional zoom", () => {
    // The whole gesture in one line: a board that got a quarter wider shows the same picture a
    // quarter larger, pan and all, so nothing the reader had lined up leaves the glass.
    expect(scaleAboutOrigin({ scale: 1, tx: -240, ty: 96 }, 1.25)).toEqual({
      scale: 1.25,
      tx: -300,
      ty: 120,
    });
  });
});

describe("fitting the graph to the viewport", () => {
  test("a graph twice the viewport is halved and centred", () => {
    const fitted = fitView({ width: 1_600, height: 900 }, { width: 800, height: 600 });
    expect(fitted.scale).toBe(0.5);
    // Limited by the width, so the fitted graph fills it exactly and is centred in the leftover
    // height: 900 * 0.5 = 450 in a 600 viewport.
    expect(fitted.tx).toBe(0);
    expect(fitted.ty).toBe(75);
  });

  test("the whole graph lands inside the viewport", () => {
    // Awkward on both axes and inside the clamp, so what is being checked is the arithmetic rather
    // than the floor: an eight-column graph is about this shape.
    const bounds = { width: 2_396, height: 1_374 };
    const viewport = { width: 720, height: 540 };
    const fitted = fitView(bounds, viewport);
    for (const corner of [
      { x: 0, y: 0 },
      { x: bounds.width, y: bounds.height },
    ]) {
      const at = toScreen(fitted, corner);
      expect(at.x).toBeGreaterThanOrEqual(-0.001);
      expect(at.y).toBeGreaterThanOrEqual(-0.001);
      expect(at.x).toBeLessThanOrEqual(viewport.width + 0.001);
      expect(at.y).toBeLessThanOrEqual(viewport.height + 0.001);
    }
  });

  test("it never magnifies", () => {
    // One box in an empty window would otherwise be fitted to two and a half times size, which is
    // not a fit — it is a zoom nobody asked for. A graph that already fits is shown as drawn, and
    // centred, which is the part of "fit" that was actually wanted.
    const fitted = fitView({ width: 300, height: 200 }, { width: 900, height: 600 });
    expect(fitted.scale).toBe(1);
    expect(fitted.tx).toBe(300);
    expect(fitted.ty).toBe(200);
  });

  test("an enormous graph stops at the zoom floor rather than becoming a smudge", () => {
    const fitted = fitView({ width: 100_000, height: 80_000 }, { width: 800, height: 600 });
    expect(fitted.scale).toBe(MIN_SCALE);
  });

  test("nothing to fit, or nowhere to fit it into, is the identity", () => {
    // The panel can ask for a fit before the canvas has been laid out, or of a graph that has not
    // been read yet. Dividing by that zero would put the surface at NaN and lose it for good.
    expect(fitView({ width: 0, height: 0 }, { width: 800, height: 600 })).toBe(IDENTITY_VIEW);
    expect(fitView({ width: 900, height: 600 }, { width: 0, height: 0 })).toBe(IDENTITY_VIEW);
  });
});
