/**
 * Where every box and every link goes, computed from the graph state and the panel's proportions.
 *
 * PURE and DOM-FREE. It takes a `GraphState` and four numbers and returns coordinates; it never
 * touches an element, and the panel's only job is to draw what comes back at `position: absolute`.
 * The four numbers are a measurement, but they arrive the way `state/chatDock.ts` is handed a
 * viewport — as an argument, from the component that owns the element — so nothing here reads the DOM and the
 * awkward cases below stay assertions in `tests/webGraphLayout.test.ts` rather than things somebody
 * eyeballs in a browser.
 *
 * MARGINS AND GAPS ARE FRACTIONS OF THE PANEL, NOT CONSTANTS, and that is what `metricsFor` is for.
 * A graph packed against `PAD` in both directions huddles in the top-left corner of a panel that is
 * mostly empty, which reads as a graph that has not finished loading. So the first column clears an
 * eighth of the panel's width, the first box in every column clears a quarter of its height, and
 * boxes stand a twelfth apart — of the width between columns, of the height between packed boxes,
 * because that is the axis each gap is measured along. The constants below are the FLOORS of
 * those fractions: a narrow panel gets a tight packing rather than something tighter still.
 *
 * HEIGHTS ARE CLOSED-FORM, NEVER MEASURED. A box is a title bar, some rows and maybe a footer, and every one of those is a fixed number of pixels, so its height is arithmetic:
 * `TITLE_H + rows * ROW_H + (hasMore ? FOOTER_H : 0)`. HOW MANY ROWS is
 * part of the same arithmetic and not a separate question — a page the reader has not extended
 * draws only what came back,
 * draws exactly one — which is why `boxesFor` decides what is drawn rather than the panel.
 * The alternative is measuring the rendered
 * boxes and packing from what comes back, and that fails twice over. It relays out UNDER THE CURSOR:
 * the first paint puts the boxes somewhere, the measurement moves them, and a click aimed at a row
 * during that frame lands on a different one — the same objection that shapes the append-only merge
 * in `state/graph.ts`. And it cannot be tested without a DOM, which means the packing rules would be
 * verified by looking at them. Rows are therefore not allowed to wrap; the panel's stylesheet holds
 * up its end with a fixed row height and an ellipsis, and that is the contract between the two.
 *
 * X IS A FUNCTION OF DEPTH AND THE METRICS ALONE. Column d sits at
 * `padX + d * (NODE_W + gapX)`, so the graph reads as generations left to right no matter what has
 * been opened, and a box never lands between two columns where a link would have to run backwards
 * to reach it.
 *
 * Y PACKS PER COLUMN, BESIDE ITS SOURCE ROW. Each box wants to start level with the row it was
 * opened from — that is what makes the link read as "these came from that" — and takes the first
 * free y at or below that when the column is already occupied. Boxes are placed in source-row order,
 * ties broken by click order, which is what makes the packing a function of the state rather than of
 * the order a hash map happened to iterate in.
 *
 * OFFSETS ARE APPLIED AFTER PACKING, and a box's offset is inherited by everything beneath it.
 * Packing a dragged box's neighbours around it would make the graph rearrange itself while the box
 * is still under the pointer — the reader drags one node and the other five move. So the packing is
 * computed as if nothing had been dragged, and drags translate the finished layout: a node carries
 * its subtree, and the links are computed from the FINAL coordinates, which is the whole reason they
 * stay attached at both ends while a node is being moved.
 */

import type { Expansion, GraphState, NodeOffset, NodePath } from "../state/graph.ts";
import {
  ROOT_TABLES,
  activeFirst,
  boxPath,
  ordersByStanding,
  rootOf,
  rootPath,
  rowPath,
} from "../state/graph.ts";
import type { RecordCard, RecordTable } from "./records.ts";

/** The geometry, in pixels. Every one of these is also a rule the panel's stylesheet must keep:
 * a row that wraps, or a title bar that grows with its text, puts the drawing and the arithmetic
 * out of step and there is nothing to notice it.
 *
 * `NODE_W` is a width the stylesheet declares and this file must agree with. The three below it are
 * different: they are the FLOORS of the metrics `metricsFor` computes, the packing a panel too
 * narrow for proportional margins falls back to. */
export const NODE_W = 260;
export const COL_GAP = 48;
export const BOX_GAP = 16;
export const PAD = 12;
/** The title bar's height: room for one line of the primary label plus the ruled underline beneath
 * it.
 *
 * THE 34 WAS MEASURED ON A HANDWRITING FACE AT 20px, and the title is now the sans at 16px —
 * `styles/fonts.css` names the families and `styles/tokens.css` argues which gets what. The number
 * is inherited unchanged on purpose, and there is more slack inside it than there was: nothing here
 * can measure a line box, because this module is pure and DOM-free by the argument at the top of the
 * file, so a constant retuned by eye would be a guess that LOOKS measured, which is worse than an
 * inherited one that says where it came from. And the tests pin arithmetic on it. What it is, is a
 * BUDGET rather than a floor: `.graph__node-title` is `flex: 0 0` at exactly this height and
 * `.graph__node` clips its own overflow, so a taller face never grows the box — it pushes ink into
 * the ruled underline and off the top edge instead. At `font-size: 1rem` and `line-height: 1` that
 * leaves 18px of slack around a 16px line box, where the old pairing left 14 around 20. */
export const TITLE_H = 34;
export const ROW_H = 40;
/** The "show more" strip at the foot of a box that has not read all of its rows. */
export const FOOTER_H = 26;
/** One line of prose where the rows would be: "nothing refers to this", or "reading…". */
export const NOTE_H = 26;
/** A sentence and a retry button. Taller than a note because a refusal that cannot be acted on is
 * just a shrug. */
export const REFUSAL_H = 96;

/**
 * One drawn box.
 *
 * It carries no rows. The panel looks those up in the state by path — `parentPath` gives the
 * expansion, `table` gives the group — because copying them here would mean the drawing and the
 * state could disagree about what is in a box, and the state is the one that knows.
 *
 * `kind` says what to draw inside: `root` and `group` are rows; `note` is one line of prose, either
 * because the read is still in flight or because nothing refers to this record (the expansion's own
 * `loading` tells them apart); `refusal` is the failure with a retry.
 */
export type LayoutBox = {
  path: NodePath;
  kind: "root" | "group" | "note" | "refusal";
  /** What the box is about. Null for a note or a refusal, which are about a row rather than a table. */
  table: RecordTable | null;
  /** The title bar's text: the table for a box of records, the clicked record's label otherwise. The
   * count beside it comes from the group's own `total` — see the merge rules in `state/graph.ts`. */
  title: string;
  x: number;
  y: number;
  h: number;
};

/** A link, from the right edge of a source row to the left edge of the box it opened. */
export type LayoutEdge = { key: string; sx: number; sy: number; tx: number; ty: number };

/**
 * The four distances the packing is spelled in, all in pixels.
 *
 * `padX` clears the left edge of the panel before column zero and `padY` clears the top before the
 * first box in any column; `gapX` separates columns and `gapY` separates boxes stacked in one. They
 * are four numbers rather than a viewport because that is what keeps this module pure — the panel
 * measures itself, `metricsFor` turns that into these, and everything downstream is arithmetic.
 */
export type LayoutMetrics = { padX: number; padY: number; gapX: number; gapY: number };

/**
 * The packing to use before the panel has been measured, and the one the tests state their
 * coordinates in. Exactly the constants above, so a layout computed with these is the layout this
 * module produced before margins were proportional at all.
 */
export const DEFAULT_METRICS: LayoutMetrics = {
  padX: PAD,
  padY: PAD,
  gapX: COL_GAP,
  gapY: BOX_GAP,
};

/**
 * The metrics for a panel of this size: an eighth of the width to the left of the graph, a quarter
 * of the height above it, and a twelfth between neighbours along whichever axis separates them.
 *
 * FLOORED AT THE CONSTANTS, so a narrow panel never gets a packing tighter than those. Rounded,
 * because these land in `left`/`top` pixels through the boxes' transforms and a column at 175.33px
 * is a column drawn on a half pixel.
 *
 * A null or degenerate viewport — before the first measurement, or an element measured while it is
 * display:none — gets `DEFAULT_METRICS`. The comparisons are written so that `NaN` takes that same
 * branch instead of poisoning every coordinate downstream of it.
 */
export function metricsFor(viewport: { width: number; height: number } | null): LayoutMetrics {
  if (viewport === null) return DEFAULT_METRICS;
  const { width, height } = viewport;
  if (!(width > 0) || !(height > 0)) return DEFAULT_METRICS;
  return {
    padX: Math.round(Math.max(PAD, width / 8)),
    padY: Math.round(Math.max(PAD, height / 4)),
    gapX: Math.round(Math.max(COL_GAP, width / 12)),
    gapY: Math.round(Math.max(BOX_GAP, height / 12)),
  };
}

export type GraphLayout = { boxes: LayoutBox[]; edges: LayoutEdge[]; width: number; height: number };

/** A box that has been placed, in PRE-OFFSET space, plus the drag it and its ancestors carry. */
type Placed = { depth: number; packedY: number; carried: NodeOffset };

/** A box about to be placed. `rank` orders the boxes of one expansion among themselves. */
type Pending = {
  path: NodePath;
  kind: LayoutBox["kind"];
  table: RecordTable | null;
  title: string;
  h: number;
  /** The rows this box actually DRAWS, in the order it draws them. The panel draws from the same
   * order, because a link arrives at a row by index and an order computed twice is an order that
   * can differ. */
  rows: readonly RecordCard[];
  source: { box: NodePath; rowY: number } | null;
  order: number;
  rank: number;
};

const NO_DRAG: NodeOffset = { dx: 0, dy: 0 };

/** The closed form. An empty box is a line of prose rather than a title bar with nothing under it. */
function boxHeight(rows: number, hasMore: boolean): number {
  return TITLE_H + (rows === 0 ? NOTE_H : rows * ROW_H) + (hasMore ? FOOTER_H : 0);
}

/** Where a row sits inside its box, before any drag. */
function rowTop(boxY: number, index: number): number {
  return boxY + TITLE_H + index * ROW_H;
}

/**
 * The whole layout, from the whole state and the panel's metrics.
 *
 * A function of its two arguments and nothing else — no clock, no measurement of its own, no
 * iteration order that depends on anything but the state's own click order — so the same pair
 * always gives a bit-identical layout and the panel can memoize on the two identities.
 */
export function layoutGraph(state: GraphState, metrics: LayoutMetrics): GraphLayout {
  const boxes: LayoutBox[] = [];
  const edges: LayoutEdge[] = [];
  const placed = new Map<NodePath, Placed>();
  /** Row path -> which box draws it and where in that box. How an expansion finds its source. */
  const rows = new Map<NodePath, { box: NodePath; index: number }>();
  /** The first free y in each column, in pre-offset space. */
  const nextFree: number[] = [];

  const place = (pending: Pending, depth: number): void => {
    const wanted = pending.source?.rowY ?? metrics.padY;
    const packedY = Math.max(nextFree[depth] ?? metrics.padY, wanted);
    nextFree[depth] = packedY + pending.h + metrics.gapY;

    const parent = pending.source === null ? undefined : placed.get(pending.source.box);
    const inherited = parent?.carried ?? NO_DRAG;
    const own = state.offsets.get(pending.path);
    const carried =
      own === undefined ? inherited : { dx: inherited.dx + own.dx, dy: inherited.dy + own.dy };

    const x = metrics.padX + depth * (NODE_W + metrics.gapX) + carried.dx;
    const y = packedY + carried.dy;
    boxes.push({
      path: pending.path,
      kind: pending.kind,
      table: pending.table,
      title: pending.title,
      x,
      y,
      h: pending.h,
    });
    placed.set(pending.path, { depth, packedY, carried });
    for (let i = 0; i < pending.rows.length; i += 1) {
      rows.set(rowPath(pending.path, pending.rows[i]!), { box: pending.path, index: i });
    }

    if (pending.source === null || parent === undefined) return;
    // Both ends from the FINAL coordinates, which is what keeps a link attached to a node being
    // dragged — and to a node whose ancestor is being dragged, since the drag is already in
    // `carried` by the time either end is computed.
    edges.push({
      key: pending.path,
      sx: metrics.padX + parent.depth * (NODE_W + metrics.gapX) + parent.carried.dx + NODE_W,
      sy: pending.source.rowY + parent.carried.dy + ROW_H / 2,
      tx: x,
      ty: y + TITLE_H / 2,
    });
  };

  // Column zero: the four tables a reader starts from, always drawn and always in `ROOT_TABLES`
  // order. They stack because `place` takes the first free y in the column and `nextFree[0]` has
  // already been moved past the box above by the time the next one asks — the same packing every
  // other column gets, with `padY` standing in for a source row none of them has.
  //
  // A root with nothing in hand and a refusal to show IS the refusal. An empty box would be this
  // window claiming that table has no rows in it, which is exactly what the failed read means it
  // cannot know — and the other three are unaffected, because the read that failed was about one.
  for (const table of ROOT_TABLES) {
    const root = rootOf(state, table);
    const records = root.box?.records ?? [];
    const refused = root.box === null && root.error !== null;
    place(
      {
        path: rootPath(table),
        kind: refused ? "refusal" : "root",
        table,
        title: table,
        h: refused ? REFUSAL_H : boxHeight(records.length, root.box?.hasMore ?? false),
        // TWO ROOTS ARE ORDERED AND THE OTHER TWO ARE NOT. `recipe` and `script` draw their active
        // rows before their retired ones — see `activeFirst`, which owns the exception to this
        // graph's no-re-sorting law, and `ordersByStanding`, which owns which boxes it applies to —
        // and the panel draws from the same pair of calls, because a link arrives at a row by index.
        rows: ordersByStanding(table) ? activeFirst(records) : records,
        source: null,
        order: 0,
        rank: 0,
      },
      0,
    );
  }

  const opened = [...state.expansions.values()];
  for (let depth = 0; ; depth += 1) {
    const pending: Pending[] = [];
    for (let order = 0; order < opened.length; order += 1) {
      const exp = opened[order]!;
      // A row that is not on screen — the box it lived in went away between the click and this
      // frame — has nothing to hang a box off, so nothing is drawn for it. Its own descendants go
      // with it, since no rows of theirs are registered either. The state folds these away on the
      // next merge; the layout simply must not fall over in the frame before that.
      const at = rows.get(exp.path);
      if (at === undefined) continue;
      const source = placed.get(at.box);
      if (source === undefined || source.depth !== depth) continue;
      const rowY = rowTop(source.packedY, at.index);
      for (const box of boxesFor(exp, at.box, rowY, order)) pending.push(box);
    }
    if (pending.length === 0) break;
    // Source-row order, then click order: the packing must not depend on which expansion happened to
    // be iterated first, only on where its row is and when it was opened.
    pending.sort(
      (a, b) =>
        (a.source?.rowY ?? metrics.padY) - (b.source?.rowY ?? metrics.padY) ||
        a.order - b.order ||
        a.rank - b.rank,
    );
    for (const box of pending) place(box, depth + 1);
  }

  let maxDepth = 0;
  let bottom = metrics.padY;
  let right = metrics.padX;
  for (const box of boxes) {
    maxDepth = Math.max(maxDepth, placed.get(box.path)?.depth ?? 0);
    bottom = Math.max(bottom, box.y + box.h);
    right = Math.max(right, box.x + NODE_W);
  }
  return {
    boxes,
    edges,
    // The columns that exist, and then whatever a drag has put beyond them: a canvas that does not
    // cover a dragged node clips it, and a node the reader moved is the one they care about most.
    //
    // The TRAILING margin is the constant, not the metric. The proportional pads are clearance the
    // reader sees before the graph starts; a quarter of the panel's height added after the last box
    // is scrollable emptiness, and it would be inside the extent `fitView` frames.
    width: Math.max(metrics.padX + (maxDepth + 1) * (NODE_W + metrics.gapX), right + PAD),
    height: bottom + PAD,
  };
}

/**
 * The boxes one opened row produces: one per referrer table, or a single note or refusal when there
 * are none to draw.
 *
 * EVERY GROUP IS A LIST, and one of them used not to be. A `playbook` box drew as a stack of cards
 * — the operative version face up, everything it replaced folded under it as an edge, and a strip
 * that fanned them out — which was the only shape in this graph that folded, and the only reason
 * this function had to ask the state anything the expansion did not already carry. Instructions are
 * one immutable recipe now rather than a version ledger, so there is nothing to stack: the fold, the
 * strip, its eighteen pixels of height and the suppressed pager all left with the versions they were
 * standing in for.
 */
function boxesFor(
  exp: Expansion,
  sourceBox: NodePath,
  rowY: number,
  order: number,
): Pending[] {
  const source = { box: sourceBox, rowY };
  const groups = exp.groups;
  if (groups === null || groups.length === 0) {
    const refused = exp.error !== null;
    return [
      {
        path: exp.path,
        // The pseudo-box IS the expansion, so it takes the row's own path: no group of this row can
        // ever claim that path, since every one of those is the row plus a table.
        kind: refused ? "refusal" : "note",
        table: null,
        title: exp.card.label,
        h: refused ? REFUSAL_H : TITLE_H + NOTE_H,
        rows: [],
        source,
        order,
        rank: 0,
      },
    ];
  }
  return groups.map((group, rank) => {
    const path = boxPath(exp.path, group.table);
    return {
      path,
      kind: "group" as const,
      table: group.table,
      title: group.table,
      h: boxHeight(group.records.length, group.hasMore),
      rows: group.records,
      source,
      order,
      rank,
    };
  });
}

/**
 * ComfyUI's link: a cubic with HORIZONTAL tangents at both ends, so it leaves the source row going
 * right and arrives at the box going right, whatever the vertical distance between them.
 *
 * The control arm is half the horizontal gap, floored so a link between adjacent columns still
 * bulges enough to be followed and capped so a link that runs a long way across the canvas does not
 * swing out past the columns it passes.
 */
export function bezierPath(edge: LayoutEdge): string {
  const arm = Math.min(120, Math.max(24, (edge.tx - edge.sx) / 2));
  const { sx, sy, tx, ty } = edge;
  return `M ${round(sx)},${round(sy)} C ${round(sx + arm)},${round(sy)} ${round(tx - arm)},${round(ty)} ${round(tx)},${round(ty)}`;
}

/** Two decimals is finer than a pixel and keeps a drag of 3.0000000000000004 from spelling itself
 * out in the path data. */
function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}
