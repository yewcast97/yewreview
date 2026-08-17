/**
 * The graph's geometry, computed from states built by hand.
 *
 * Every number below is arithmetic on the constants — nothing here measures anything, which is the
 * property being defended: a layout that asked the DOM how tall a box turned out would relay out
 * under the reader's cursor, and could not be checked without a browser. So the packing rules are
 * asserted directly: a column is a function of depth, boxes in one column never overlap, a child
 * starts beside the row it was opened from, and a refresh that changes no topology moves nothing.
 *
 * COLUMN ZERO IS FOUR BOXES, and it is the same packing as every other column with `PAD` in
 * place of a source row. That is worth asserting rather than assuming, because it is the one place
 * where the stacking is not driven by a row somewhere to the left.
 *
 * EVERY BOX IS A LIST OF ROWS, and one of them used not to be. A `playbook` box drew as a stack of
 * version cards — one row face up whatever it held, an eighteen-pixel strip that fanned the rest
 * out, and a suppressed pager — and it had a whole describe block here for the arithmetic in both
 * states. Instructions are one immutable recipe now, so there are no versions to stack: `STACK_H`,
 * `LayoutBox.stack` and the fold went with them, and the only things left that reorder anything are
 * column zero's `recipe` and `script` boxes — the two whose rows carry a standing — which are drawn
 * active-first and asserted below.
 *
 * THE PACKING RULES ARE STATED IN `DEFAULT_METRICS` and the METRICS ARE TESTED SEPARATELY, at the
 * foot of this file. Splitting them that way is the point of `metricsFor` being its own function:
 * how a panel's size becomes four distances is one small piece of arithmetic with its own boundary
 * cases, and every rule about where a box goes given those distances is true whatever they are.
 */

import { describe, expect, test } from "bun:test";

import type { RecordCard, RecordGroup, RecordTable } from "../web/src/lib/records.ts";
import type { GraphLayout, LayoutBox } from "../web/src/lib/graphLayout.ts";
import {
  BOX_GAP,
  COL_GAP,
  DEFAULT_METRICS,
  FOOTER_H,
  NODE_W,
  NOTE_H,
  PAD,
  REFUSAL_H,
  ROW_H,
  TITLE_H,
  bezierPath,
  layoutGraph as packGraph,
  metricsFor,
} from "../web/src/lib/graphLayout.ts";
import type { GraphState, RootTable } from "../web/src/state/graph.ts";
import {
  INACTIVE,
  ROOT_TABLES,
  boxPath,
  createGraphState,
  expand,
  extendGroup,
  fail,
  failRoot,
  land,
  landRoot,
  mergeRoot,
  rootPath,
  rowPath,
  setOffset,
} from "../web/src/state/graph.ts";

/**
 * The layout at the default packing, which is what every coordinate below is arithmetic on.
 *
 * `DEFAULT_METRICS` is exactly `PAD`/`COL_GAP`/`BOX_GAP`, so a test written against the constants is
 * a test of the packing rules and nothing else — the proportional margins a real panel gets are
 * `metricsFor`'s business and are asserted on their own at the foot of the file.
 */
function layoutGraph(state: GraphState): GraphLayout {
  return packGraph(state, DEFAULT_METRICS);
}

/** A row is `ROW_H` tall whether or not it can be opened, so nothing in the packing depends on which
 * table a card names. The fixture says the least a card can say. */
function card(table: RecordTable, id: string, label = id): RecordCard {
  return { table, id, name: `${table}-${id}`, label };
}

function group(
  table: RecordTable,
  records: RecordCard[],
  extra: Partial<RecordGroup> = {},
): RecordGroup {
  return {
    table,
    column: `${table}_id`,
    onDelete: "CASCADE",
    total: records.length,
    records,
    hasMore: false,
    ...extra,
  };
}

function cards(table: RecordTable, count: number): RecordCard[] {
  return Array.from({ length: count }, (_, i) => card(table, `${table}${i}`));
}

function boxAt(layout: GraphLayout, path: string): LayoutBox {
  const found = layout.boxes.find((box) => box.path === path);
  if (found === undefined) throw new Error(`no box at ${path}`);
  return found;
}

/**
 * The column a path names, read off the path itself: a box sits as deep as it has row segments.
 *
 * A root is one segment and no rows, so it floors to zero — which is what the colon in `root:<table>`
 * buys. Spelled `root/recipe` it would count two and this helper, and the panel's own reading of
 * the same path, would put every root box in column one.
 */
function depthOf(path: string): number {
  return Math.floor(path.split("/").length / 2);
}

/** The four root tables, each landed with rows. What every fixture below starts from. */
function withRoots(rows: Partial<Record<RootTable, RecordCard[]>>): GraphState {
  let state = createGraphState();
  for (const table of ROOT_TABLES) {
    state = landRoot(state, table, { records: rows[table] ?? [], hasMore: false });
  }
  return state;
}

const A = card("recipe", "a");
const B = card("recipe", "b");
const RECIPES = rootPath("recipe");
const A_ROW = rowPath(RECIPES, A);
const B_ROW = rowPath(RECIPES, B);
const A_REPORTS = boxPath(A_ROW, "report");
const B_REPORTS = boxPath(B_ROW, "report");

/**
 * Two recipes, the first opened onto three reports (with a page still unread) and the second onto
 * one. The second box wants the same column as the first and is pushed under it.
 *
 * `report` really does point at a recipe, and it is the ONLY table that does — which is what a
 * reader walking out of the recipe box actually meets. The geometry would be the same for any table,
 * but a fixture that draws an edge the schema does not have teaches the next reader something false
 * about the panel. The other three roots are left empty so this file's arithmetic stays about the
 * packing rather than about them.
 *
 * NEITHER RECIPE CARRIES A `meta` OR A STANDING, so `activeFirst` hands column zero back the array it
 * was given and A stays the first row. The ordering it does apply is asserted in its own block
 * below, where the fixture says so on purpose.
 */
function twoOpenRows(): GraphState {
  let state = withRoots({ recipe: [A, B] });
  state = land(expand(state, A_ROW, A), A_ROW, [
    group("report", cards("report", 3), { total: 9, hasMore: true }),
  ]);
  state = land(expand(state, B_ROW, B), B_ROW, [group("report", cards("report", 1))]);
  return state;
}

const RECIPES_H = TITLE_H + 2 * ROW_H;
/** An empty root box is a title bar over one line of prose, and there are three of those below the
 * recipe box in every fixture here. */
const EMPTY_ROOT_H = TITLE_H + NOTE_H;
// Three rows and a "show more" strip.
const A_REPORTS_H = TITLE_H + 3 * ROW_H + FOOTER_H;
const B_REPORTS_H = TITLE_H + ROW_H;

describe("the layout is a function of the state and nothing else", () => {
  test("the same state gives a bit-identical layout", () => {
    const state = twoOpenRows();
    expect(layoutGraph(state)).toEqual(layoutGraph(state));
  });

  test("a refresh that changes no topology moves nothing", () => {
    // The half-second poll comes back with a renamed recipe. Nothing about where a box goes may
    // depend on what a row is called, or the graph would twitch every time the agent writes.
    const before = layoutGraph(twoOpenRows());
    const renamed = mergeRoot(twoOpenRows(), "recipe", {
      records: [card("recipe", "a", "TSMC"), B],
      hasMore: false,
    });
    expect(layoutGraph(renamed)).toEqual(before);
  });

  test("x is a function of depth alone", () => {
    let state = twoOpenRows();
    const report = cards("report", 3)[0]!;
    const reportRow = rowPath(A_REPORTS, report);
    state = land(expand(state, reportRow, report), reportRow, [
      group("script_invocation", cards("script_invocation", 2)),
    ]);

    const layout = layoutGraph(state);
    expect(layout.boxes.length).toBeGreaterThan(6);
    for (const box of layout.boxes) {
      expect(box.x).toBe(PAD + depthOf(box.path) * (NODE_W + COL_GAP));
    }
  });
});

describe("column zero is the four tables a reader starts from", () => {
  test("all four are drawn, always, in ROOT_TABLES order", () => {
    // Even before anything has been read. There is no state of this panel in which one of the four
    // starting points is simply absent — an unread box says "reading…", it does not disappear.
    const layout = layoutGraph(createGraphState());
    expect(layout.boxes.map((box) => box.path)).toEqual([
      "root:recipe",
      "root:thesis",
      "root:information_source",
      "root:script",
    ]);
    expect(layout.boxes.map((box) => box.table)).toEqual([...ROOT_TABLES]);
    for (const box of layout.boxes) {
      expect(box).toMatchObject({ kind: "root", x: PAD, h: EMPTY_ROOT_H });
    }
  });

  test("they stack down the column with the same gap every other box gets", () => {
    const layout = layoutGraph(twoOpenRows());
    let expected = PAD;
    for (const table of ROOT_TABLES) {
      const box = boxAt(layout, rootPath(table));
      expect(box.y).toBe(expected);
      expected = box.y + box.h + BOX_GAP;
    }
    expect(boxAt(layout, RECIPES).h).toBe(RECIPES_H);
    expect(boxAt(layout, rootPath("thesis")).y).toBe(PAD + RECIPES_H + BOX_GAP);
  });

  test("one table that could not be read is one refusal, not four", () => {
    // The whole reason each root carries its own error. A shared one would have made a single
    // unreachable table look like a window that had lost the database.
    const layout = layoutGraph(failRoot(createGraphState(), "script", "could not reach YewReview"));
    expect(boxAt(layout, rootPath("script"))).toMatchObject({
      kind: "refusal",
      table: "script",
      title: "script",
      h: REFUSAL_H,
    });
    for (const table of ["recipe", "thesis", "information_source"] as const) {
      expect(boxAt(layout, rootPath(table)).kind).toBe("root");
    }
    expect(layout.edges).toEqual([]);
  });

  test("a refused table that still has rows in hand keeps drawing them", () => {
    // A refusal is what a root box becomes when it has NOTHING — a failed refresh of a box already
    // holding rows leaves the rows, and the panel puts the sentence on the title bar instead.
    const state = failRoot(withRoots({ recipe: [A, B] }), "recipe", "could not reach YewReview");
    expect(boxAt(layoutGraph(state), RECIPES)).toMatchObject({ kind: "root", h: RECIPES_H });
  });

  test("every root can be opened out of, independently", () => {
    const thesis = card("thesis", "t1");
    const thesisRow = rowPath(rootPath("thesis"), thesis);
    let state = withRoots({ recipe: [A], thesis: [thesis] });
    state = land(expand(state, A_ROW, A), A_ROW, [group("report", cards("report", 1))]);
    state = land(expand(state, thesisRow, thesis), thesisRow, [
      group("thesis_assessment", cards("thesis_assessment", 2)),
    ]);

    const layout = layoutGraph(state);
    const assessments = boxPath(thesisRow, "thesis_assessment");
    expect(boxAt(layout, A_REPORTS).x).toBe(PAD + NODE_W + COL_GAP);
    expect(boxAt(layout, assessments).x).toBe(PAD + NODE_W + COL_GAP);
    // The second column packs across the two roots in source-row order, so the box hanging off the
    // thesis root — which is lower down column zero — lands below the one hanging off the recipe.
    expect(boxAt(layout, assessments).y).toBeGreaterThan(boxAt(layout, A_REPORTS).y);
  });
});

/**
 * The one ordering in this graph, and the one place the layout does not draw the rows it was handed.
 *
 * `activeFirst` is called by `layoutGraph` for the two column-zero boxes `ordersByStanding` names —
 * `recipe` and `script` — and by the panel for the same boxes, and the two calls must agree because
 * a link arrives at a row BY INDEX: an ordering applied in one of those places and not the other
 * would draw every edge out of the wrong row. So what is asserted here is the coordinate, not the
 * array — the array is `tests/webGraph.test.ts`'s business.
 */
describe("the boxes with a standing are drawn active-first, and the links follow the rows", () => {
  /** Held newest-first-and-retired, which is the order the merge legitimately leaves behind: the
   * retired recipe was stored later, so it is the one a fresh read puts at the top. */
  const RETIRED = { ...card("recipe", "ret"), sublabel: INACTIVE, meta: 2_000 };
  const ACTIVE = { ...card("recipe", "act"), meta: 1_000 };

  function held(): GraphState {
    return withRoots({ recipe: [RETIRED, ACTIVE] });
  }

  test("a box opened from the retired recipe hangs off the second row, not the first", () => {
    const row = rowPath(RECIPES, RETIRED);
    const state = land(expand(held(), row, RETIRED), row, [group("report", cards("report", 1))]);
    const layout = layoutGraph(state);
    const box = boxPath(row, "report");
    // Row ONE: the active recipe is drawn above it however the state holds them.
    expect(layout.edges.find((edge) => edge.key === box)?.sy).toBe(
      PAD + TITLE_H + ROW_H + ROW_H / 2,
    );
  });

  test("and the active one, held second, is the row every link leaves first", () => {
    const row = rowPath(RECIPES, ACTIVE);
    const state = land(expand(held(), row, ACTIVE), row, [group("report", cards("report", 1))]);
    const layout = layoutGraph(state);
    const box = boxPath(row, "report");
    expect(layout.edges.find((edge) => edge.key === box)?.sy).toBe(PAD + TITLE_H + ROW_H / 2);
  });

  test("the reordering costs no height, because a box is as tall as its rows", () => {
    // Stated because the box that used to reorder itself — the playbook stack — also changed size
    // doing it. This one does not: two rows are two rows whichever way round they are drawn.
    expect(boxAt(layoutGraph(held()), RECIPES).h).toBe(TITLE_H + 2 * ROW_H);
  });

  test("the script box is reordered too, and its links move with its rows", () => {
    // The other box with a standing, asserted here rather than assumed from the recipe one: a
    // program that has been replaced is drawn under the ones still being run, and a box opened from
    // it hangs off the row it is DRAWN in. Column zero packs the script box last of the four, so its
    // own y is the sum of the three above it.
    const retiredScript = { ...card("script", "s1"), sublabel: INACTIVE, meta: 2_000 };
    const activeScript = { ...card("script", "s2"), meta: 1_000 };
    const state = withRoots({ script: [retiredScript, activeScript] });
    const row = rowPath(rootPath("script"), retiredScript);
    const opened = land(expand(state, row, retiredScript), row, [
      group("script_invocation", cards("script_invocation", 1)),
    ]);
    const layout = layoutGraph(opened);
    const box = boxPath(row, "script_invocation");
    const scripts = boxAt(layout, rootPath("script"));
    // Row ONE: the active script is drawn above it however the state holds them.
    expect(layout.edges.find((edge) => edge.key === box)?.sy).toBe(
      scripts.y + TITLE_H + ROW_H + ROW_H / 2,
    );
  });

  test("no box without a standing is reordered", () => {
    // The law this is the exception to. A thesis has no standing to sort by — its sublabel carries
    // the newest assessment — and its box is not sorted by anything else either: the newest row
    // stays where the merge left it, which is where the reader last saw it.
    const older = { ...card("thesis", "t1"), sublabel: "supported", meta: 1_000 };
    const newer = { ...card("thesis", "t2"), sublabel: "unassessed", meta: 2_000 };
    const state = withRoots({ thesis: [older, newer] });
    const row = rowPath(rootPath("thesis"), newer);
    const opened = land(expand(state, row, newer), row, [
      group("thesis_assessment", cards("thesis_assessment", 1)),
    ]);
    const layout = layoutGraph(opened);
    const box = boxPath(row, "thesis_assessment");
    const theses = boxAt(layout, rootPath("thesis"));
    // Row ONE, where it is HELD — not row zero, which is where a newest-first sort would have put
    // it. The thesis box is never re-sorted, by a standing or by anything else.
    expect(layout.edges.find((edge) => edge.key === box)?.sy).toBe(
      theses.y + TITLE_H + ROW_H + ROW_H / 2,
    );
  });
});

describe("boxes pack down a column, beside the row they came from", () => {
  test("a child starts level with its source row when the column is free", () => {
    const layout = layoutGraph(twoOpenRows());
    const recipes = boxAt(layout, RECIPES);
    expect(recipes).toMatchObject({ kind: "root", table: "recipe", x: PAD, y: PAD });
    // The first row of the recipe box, which is where the first child box lines up.
    expect(boxAt(layout, A_REPORTS).y).toBe(recipes.y + TITLE_H);
    expect(boxAt(layout, A_REPORTS).h).toBe(A_REPORTS_H);
  });

  test("a child packs below when the column is already occupied", () => {
    const layout = layoutGraph(twoOpenRows());
    const second = boxAt(layout, B_REPORTS);
    // Its source row is the second row of the recipe box, at PAD + TITLE_H + ROW_H = 86 — but the
    // first report box is still there, so it takes the first free y under it instead.
    expect(second.y).toBe(PAD + TITLE_H + A_REPORTS_H + BOX_GAP);
    expect(second.y).toBeGreaterThan(PAD + TITLE_H + ROW_H);
    expect(second.h).toBe(B_REPORTS_H);
  });

  test("no two boxes in a column overlap", () => {
    let state = twoOpenRows();
    const report = cards("report", 3)[0]!;
    const reportRow = rowPath(A_REPORTS, report);
    state = land(expand(state, reportRow, report), reportRow, [
      group("script_invocation", cards("script_invocation", 2)),
    ]);

    const columns = new Map<number, LayoutBox[]>();
    for (const box of layoutGraph(state).boxes) {
      const column = columns.get(box.x) ?? [];
      column.push(box);
      columns.set(box.x, column);
    }
    for (const column of columns.values()) {
      const sorted = [...column].sort((first, second) => first.y - second.y);
      for (let i = 1; i < sorted.length; i += 1) {
        const above = sorted[i - 1]!;
        expect(sorted[i]!.y).toBeGreaterThanOrEqual(above.y + above.h + BOX_GAP);
      }
    }
  });

  test("appending a row moves only what is below it in that column", () => {
    // The reader pages in two more reports. The box they landed in must not move, because the rows
    // above them did not move — that is the whole point of appending rather than re-sorting.
    const before = layoutGraph(twoOpenRows());
    const state = extendGroup(
      twoOpenRows(),
      A_ROW,
      "report",
      group("report", [card("report", "report3"), card("report", "report4")], {
        total: 5,
        hasMore: false,
      }),
    );
    const after = layoutGraph(state);

    expect(boxAt(after, RECIPES)).toEqual(boxAt(before, RECIPES));
    expect(boxAt(after, A_REPORTS).y).toBe(boxAt(before, A_REPORTS).y);
    expect(boxAt(after, A_REPORTS).h).toBe(TITLE_H + 5 * ROW_H);
    expect(boxAt(after, B_REPORTS).y).toBe(
      boxAt(after, A_REPORTS).y + boxAt(after, A_REPORTS).h + BOX_GAP,
    );
    expect(boxAt(after, B_REPORTS).y).toBeGreaterThan(boxAt(before, B_REPORTS).y);
  });

  test("a root box growing pushes the three under it down, and nothing else", () => {
    // Column zero packs like every other column, so a recipe box that gained a row moves the
    // three roots below it — and leaves the boxes hanging off its own first row exactly where they
    // were, because their source row did not move.
    const before = layoutGraph(twoOpenRows());
    const after = layoutGraph(
      mergeRoot(twoOpenRows(), "recipe", {
        records: [A, B, card("recipe", "c")],
        hasMore: false,
      }),
    );
    expect(boxAt(after, RECIPES).y).toBe(boxAt(before, RECIPES).y);
    expect(boxAt(after, rootPath("thesis")).y).toBe(boxAt(before, rootPath("thesis")).y + ROW_H);
    expect(boxAt(after, A_REPORTS)).toEqual(boxAt(before, A_REPORTS));
  });

  test("a box is a title bar, its rows and maybe a pager, and that is the whole closed form", () => {
    // The shape EVERY box in this graph has. There is no second one — the fold that a playbook box
    // used to draw was the only exception and it left with the versions — so a reader can read a
    // height off a row count anywhere on the canvas.
    const state = withRoots({ recipe: [A] });
    const paged = land(expand(state, A_ROW, A), A_ROW, [
      group("report", cards("report", 3), { total: 9, hasMore: true }),
    ]);
    expect(boxAt(layoutGraph(paged), A_REPORTS)).toEqual({
      path: A_REPORTS,
      kind: "group",
      table: "report",
      title: "report",
      x: PAD + NODE_W + COL_GAP,
      y: PAD + TITLE_H,
      h: TITLE_H + 3 * ROW_H + FOOTER_H,
    });
    // And with everything read, the pager's pixels are not spent.
    const whole = land(expand(state, A_ROW, A), A_ROW, [group("report", cards("report", 3))]);
    expect(boxAt(layoutGraph(whole), A_REPORTS).h).toBe(TITLE_H + 3 * ROW_H);
  });
});

describe("a dragged node carries its subtree", () => {
  /** The report box opened onto one report's script runs, so there is something to carry. */
  function threeColumns(): GraphState {
    const report = cards("report", 3)[0]!;
    const reportRow = rowPath(A_REPORTS, report);
    const state = twoOpenRows();
    return land(expand(state, reportRow, report), reportRow, [
      group("script_invocation", cards("script_invocation", 2)),
    ]);
  }

  const RUNS = boxPath(rowPath(A_REPORTS, cards("report", 3)[0]!), "script_invocation");

  test("the offset translates the box and everything under it, and nothing else", () => {
    const before = layoutGraph(threeColumns());
    const after = layoutGraph(setOffset(threeColumns(), A_REPORTS, { dx: 500, dy: 300 }));

    for (const path of [A_REPORTS, RUNS]) {
      expect(boxAt(after, path).x).toBe(boxAt(before, path).x + 500);
      expect(boxAt(after, path).y).toBe(boxAt(before, path).y + 300);
    }
    // The sibling packed under it stays where the packing put it: a drag must not reshuffle the
    // boxes around the one under the pointer.
    expect(boxAt(after, B_REPORTS)).toEqual(boxAt(before, B_REPORTS));
    expect(boxAt(after, RECIPES)).toEqual(boxAt(before, RECIPES));
  });

  test("a root box can be dragged too, and takes its own subtree", () => {
    const before = layoutGraph(threeColumns());
    const after = layoutGraph(setOffset(threeColumns(), RECIPES, { dx: 60, dy: -20 }));
    for (const path of [RECIPES, A_REPORTS, RUNS, B_REPORTS]) {
      expect(boxAt(after, path).x).toBe(boxAt(before, path).x + 60);
      expect(boxAt(after, path).y).toBe(boxAt(before, path).y - 20);
    }
    // Its three siblings in column zero are not beneath it and do not follow.
    expect(boxAt(after, rootPath("thesis"))).toEqual(boxAt(before, rootPath("thesis")));
  });

  test("the canvas grows to cover a box dragged past the columns", () => {
    const before = layoutGraph(threeColumns());
    const after = layoutGraph(setOffset(threeColumns(), A_REPORTS, { dx: 500, dy: 300 }));
    expect(after.width).toBe(boxAt(after, RUNS).x + NODE_W + PAD);
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.height).toBeGreaterThan(before.height);
    // With nothing dragged, the canvas is exactly the columns that exist.
    expect(before.width).toBe(PAD + 3 * (NODE_W + COL_GAP));
  });

  test("links are computed from the final coordinates, so they stay attached", () => {
    const dragged = setOffset(threeColumns(), A_REPORTS, { dx: 500, dy: 300 });
    const layout = layoutGraph(dragged);
    const edge = layout.edges.find((candidate) => candidate.key === RUNS);
    const reports = boxAt(layout, A_REPORTS);
    const runs = boxAt(layout, RUNS);
    // Out of the right edge of the dragged box's first row, into the middle of the child's title bar.
    expect(edge).toEqual({
      key: RUNS,
      sx: reports.x + NODE_W,
      sy: reports.y + TITLE_H + ROW_H / 2,
      tx: runs.x,
      ty: runs.y + TITLE_H / 2,
    });
  });
});

describe("what a box is when it has nothing to show", () => {
  test("an empty table is a line of prose, not a title bar over nothing", () => {
    const layout = layoutGraph(withRoots({}));
    expect(layout.boxes).toHaveLength(ROOT_TABLES.length);
    expect(boxAt(layout, RECIPES)).toMatchObject({ kind: "root", h: EMPTY_ROOT_H });
  });

  test("a row nothing refers to opens into a leaf note under its own path", () => {
    const state = land(expand(withRoots({ recipe: [A] }), A_ROW, A), A_ROW, []);
    const box = boxAt(layoutGraph(state), A_ROW);
    expect(box).toMatchObject({ kind: "note", table: null, title: "a", h: TITLE_H + NOTE_H });
    expect(box.x).toBe(PAD + NODE_W + COL_GAP);
  });

  test("a row still being read is the same note, held open", () => {
    const state = expand(withRoots({ recipe: [A] }), A_ROW, A);
    expect(boxAt(layoutGraph(state), A_ROW)).toMatchObject({ kind: "note", h: TITLE_H + NOTE_H });
  });

  test("a failed read is a refusal in place, with room for the sentence and the retry", () => {
    const state = fail(
      expand(withRoots({ recipe: [A] }), A_ROW, A),
      A_ROW,
      "could not reach YewReview",
    );
    expect(boxAt(layoutGraph(state), A_ROW)).toMatchObject({ kind: "refusal", h: REFUSAL_H });
  });

  test("a root that could not be read at all is a refusal rather than an empty box", () => {
    // "There are no recipes" is a claim about the database a failed read cannot make, so the box
    // says what went wrong and offers the retry instead of drawing the emptiness it never saw.
    const layout = layoutGraph(failRoot(createGraphState(), "recipe", "could not reach YewReview"));
    expect(boxAt(layout, RECIPES)).toEqual({
      path: RECIPES,
      kind: "refusal",
      table: "recipe",
      title: "recipe",
      x: PAD,
      y: PAD,
      h: REFUSAL_H,
    });
  });
});

describe("links are horizontal-tangent cubics", () => {
  test("the control arms are half the gap", () => {
    expect(bezierPath({ key: "k", sx: 0, sy: 0, tx: 100, ty: 50 })).toBe("M 0,0 C 50,0 50,50 100,50");
  });

  test("the arm is floored so a short link still bulges, and capped so a long one does not swing wide", () => {
    expect(bezierPath({ key: "k", sx: 0, sy: 0, tx: 10, ty: 0 })).toBe("M 0,0 C 24,0 -14,0 10,0");
    expect(bezierPath({ key: "k", sx: 0, sy: 0, tx: 1000, ty: 0 })).toBe("M 0,0 C 120,0 880,0 1000,0");
  });

  test("a fractional drag does not spell itself out to seventeen digits", () => {
    expect(bezierPath({ key: "k", sx: 0.1, sy: 0.2, tx: 100.3, ty: 0.2 })).toBe(
      "M 0.1,0.2 C 50.2,0.2 50.2,0.2 100.3,0.2",
    );
  });

  test("every box but a root is linked from the row that opened it", () => {
    const layout = layoutGraph(twoOpenRows());
    expect(layout.edges.map((edge) => edge.key)).toEqual([A_REPORTS, B_REPORTS]);
    const recipes = boxAt(layout, RECIPES);
    expect(layout.edges[0]).toMatchObject({
      sx: recipes.x + NODE_W,
      sy: recipes.y + TITLE_H + ROW_H / 2,
      tx: boxAt(layout, A_REPORTS).x,
      ty: boxAt(layout, A_REPORTS).y + TITLE_H / 2,
    });
    // The second link leaves the second row, one row lower.
    expect(layout.edges[1]?.sy).toBe(recipes.y + TITLE_H + ROW_H + ROW_H / 2);
  });
});

describe("the metrics are the panel's proportions, and the packing is spelled in them", () => {
  /** Deliberately unlike the constants in every component, so a term left hard-coded shows up. */
  const WIDE_PANEL = { padX: 100, padY: 200, gapX: 60, gapY: 24 };

  test("column zero clears padX, and the first box in it clears padY", () => {
    const layout = packGraph(createGraphState(), WIDE_PANEL);
    for (const box of layout.boxes) expect(box.x).toBe(100);
    expect(boxAt(layout, RECIPES).y).toBe(200);
  });

  test("boxes stacked in a column stand gapY apart", () => {
    const layout = packGraph(twoOpenRows(), WIDE_PANEL);
    let expected = 200;
    for (const table of ROOT_TABLES) {
      const box = boxAt(layout, rootPath(table));
      expect(box.y).toBe(expected);
      expected = box.y + box.h + 24;
    }
  });

  test("columns step by the node's width plus gapX", () => {
    const layout = packGraph(twoOpenRows(), WIDE_PANEL);
    expect(boxAt(layout, A_REPORTS).x).toBe(100 + NODE_W + 60);
  });

  test("links leave and arrive at the coordinates the metrics put the boxes at", () => {
    // The edge endpoints recompute column x rather than reading it back off the box, so this is the
    // assertion that catches a `PAD` applied in one of those two places and forgotten in the other.
    const layout = packGraph(twoOpenRows(), WIDE_PANEL);
    const recipes = boxAt(layout, RECIPES);
    expect(layout.edges[0]).toMatchObject({
      sx: recipes.x + NODE_W,
      tx: boxAt(layout, A_REPORTS).x,
    });
  });

  test("the canvas still covers the graph it was given", () => {
    const layout = packGraph(twoOpenRows(), WIDE_PANEL);
    for (const box of layout.boxes) {
      expect(layout.width).toBeGreaterThanOrEqual(box.x + NODE_W);
      expect(layout.height).toBeGreaterThanOrEqual(box.y + box.h);
    }
  });
});

describe("metricsFor turns a panel into four distances", () => {
  test("an eighth of the width, a quarter of the height, a twelfth between neighbours", () => {
    expect(metricsFor({ width: 1200, height: 960 })).toEqual({
      padX: 150,
      padY: 240,
      gapX: 100,
      gapY: 80,
    });
  });

  test("the constants are floors, so a narrow panel packs the way it always did", () => {
    // 300/8 is 37.5 and 120/4 is 30, both above their floors; 300/12 is 25 and 120/12 is 10, both
    // below. A panel small enough gets `DEFAULT_METRICS` exactly.
    expect(metricsFor({ width: 300, height: 120 })).toEqual({
      padX: 38,
      padY: 30,
      gapX: COL_GAP,
      gapY: BOX_GAP,
    });
    expect(metricsFor({ width: 40, height: 40 })).toEqual(DEFAULT_METRICS);
  });

  test("whole pixels, because these land in a transform", () => {
    const metrics = metricsFor({ width: 1007, height: 733 });
    for (const value of Object.values(metrics)) expect(Number.isInteger(value)).toBe(true);
  });

  test("a panel that has not been measured yet gets the default packing", () => {
    // Null before the first observation; zero and NaN are what an element measured while it is
    // display:none hands back. All three must give a graph that is drawn rather than one at NaN.
    expect(metricsFor(null)).toEqual(DEFAULT_METRICS);
    expect(metricsFor({ width: 0, height: 0 })).toEqual(DEFAULT_METRICS);
    expect(metricsFor({ width: Number.NaN, height: Number.NaN })).toEqual(DEFAULT_METRICS);
    expect(metricsFor({ width: -800, height: -600 })).toEqual(DEFAULT_METRICS);
  });

  test("the default metrics are the constants, which is what makes the tests above readable", () => {
    expect(DEFAULT_METRICS).toEqual({ padX: PAD, padY: PAD, gapX: COL_GAP, gapY: BOX_GAP });
  });
});
