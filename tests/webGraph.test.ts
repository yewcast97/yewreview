/**
 * The node graph's model, driven by clicks and answers.
 *
 * The reducer alone — no store, no fetch, no DOM — which is what lets the sequences that are awkward
 * in a live window be written down here: an answer landing after its row was folded, a half-second
 * refresh arriving on top of a page somebody scrolled a box open to, a row deleted out from under a
 * subtree that was opened from it. Two of them are the reasons this panel exists in the shape it
 * does, so they are asserted rather than described: a record reached two ways is two boxes, and a
 * refresh appends instead of re-sorting.
 *
 * The four root tables are asserted the same way, and the property that matters about them is
 * INDEPENDENCE: a read of one must not touch the state of another, and a poll where all four said
 * nothing new must return the identical object it was handed.
 *
 * ONE ORDERING IS ALLOWED TO BREAK THAT LAW and it is `activeFirst`, which draws the three
 * column-zero boxes whose rows carry a standing — `recipe`, `script` and `thesis` — active-first. It
 * has its own block below, and so does the question of which boxes it applies to, because an
 * exception nobody wrote the boundaries of becomes a habit.
 */

import { describe, expect, test } from "bun:test";

import type { RecordCard, RecordGroup, RecordTable } from "../web/src/lib/records.ts";
import { DEFAULT_GROUP, MAX_GROUP } from "../web/src/lib/records.ts";
import type { GraphState, RootTable } from "../web/src/state/graph.ts";
import {
  ABANDONED,
  INACTIVE,
  ROOT_TABLES,
  activeFirst,
  beginRoot,
  boxPath,
  cardKey,
  createGraphState,
  expand,
  expandedPaths,
  extendGroup,
  extendRoot,
  fail,
  failRoot,
  fold,
  isBeneath,
  isExpanded,
  isReading,
  isRetired,
  land,
  landRoot,
  mergeExpansion,
  mergeRoot,
  ordersByStanding,
  rootOf,
  rootPath,
  rootTableOf,
  rowPath,
  select,
  setOffset,
  shownLimit,
} from "../web/src/state/graph.ts";

/** A card as the record API hands one over. `sublabel` is set only when it is given, because absent
 * and present-but-undefined are different keys to `mergeRecords`, which compares them. */
function card(table: RecordTable, id: string, label = id, sublabel?: string): RecordCard {
  const name = `${table}-${id}`;
  return sublabel === undefined
    ? { table, id, name, label }
    : { table, id, name, label, sublabel };
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

/** The graph with the recipe table already read, and the other three landed empty — which is what
 * a first refresh of a database with nothing else in it leaves behind. */
function withRoot(records: RecordCard[], hasMore = false): GraphState {
  let state = landRoot(createGraphState(), "recipe", { records, hasMore });
  for (const table of ROOT_TABLES) {
    if (table !== "recipe") state = landRoot(state, table, { records: [], hasMore: false });
  }
  return state;
}

function ids(records: readonly RecordCard[] | undefined): string[] {
  return (records ?? []).map((record) => record.id);
}

/** What one root box holds. */
function rootIds(state: GraphState, table: RootTable): string[] {
  return ids(rootOf(state, table).box?.records);
}

/** What one box holds, found the way the panel finds it: the expansion, then the table. */
function rowsOf(state: GraphState, path: string, table: RecordTable): RecordCard[] {
  const found = state.expansions.get(path)?.groups?.find((g) => g.table === table);
  return found?.records ?? [];
}

const RECIPES = rootPath("recipe");
const RC = card("recipe", "ab12", "TSMC quarterly capacity");
const RC_PATH = rowPath(RECIPES, RC);

describe("the path grammar", () => {
  test("a root is one segment, so its rows sit in the column beside it", () => {
    // The colon is what buys that. Spelled `root/recipe` the box would be two segments and every
    // reading of a path in this module — which column, whether one path is beneath another — would
    // put its rows one column too deep.
    expect(RECIPES).toBe("root:recipe");
    expect(RECIPES.split("/")).toHaveLength(1);
    expect(RC_PATH).toBe("root:recipe/recipe:ab12");
    expect(RC_PATH.split("/")).toHaveLength(2);
  });

  test("a root path names its table, and nothing else does", () => {
    for (const table of ROOT_TABLES) expect(rootTableOf(rootPath(table))).toBe(table);
    // A row inside a root box starts with the same five characters and is not a root.
    expect(rootTableOf(RC_PATH)).toBeNull();
    expect(rootTableOf(boxPath(RC_PATH, "report"))).toBeNull();
    // Nor is a table that is real but is not one of the four starting points.
    expect(rootTableOf("root:report")).toBeNull();
  });

  test("the four roots are not beneath one another", () => {
    // What keeps them four independent trees rather than one: nothing under `root:script` can ever
    // be folded, dimmed or deleted by something happening to `root:recipe`.
    expect(isBeneath(RC_PATH, RECIPES)).toBe(true);
    expect(isBeneath(RECIPES, RECIPES)).toBe(true);
    expect(isBeneath(rootPath("script"), RECIPES)).toBe(false);
    expect(isBeneath(rowPath(rootPath("script"), card("script", "s1")), RECIPES)).toBe(false);
  });
});

/**
 * The other key in this module, and why one is not enough.
 *
 * A PATH SAYS WHERE A ROW IS, `cardKey` SAYS WHAT IT DRAWS. The path is the identity — two routes to
 * one record are two rows, which the block below this one asserts at length — and that is exactly why
 * something else has to be able to say those two rows are the same record after all. Three readers
 * depend on it: the merge diffs a box by it, the panel keys a row with it, and `useTwinRows` marks
 * every row carrying it while the pointer is on one of them.
 */
describe("cardKey is what says two rows are one record", () => {
  test("the table and the id, and the table is not decoration", () => {
    expect(cardKey(RC)).toBe("recipe:ab12");
    // An id is unique WITHIN its table. Two tables may hand out the same one, and a key that dropped
    // the table would make two unrelated rows each other's twin.
    expect(cardKey(card("report", "ab12"))).not.toBe(cardKey(RC));
  });

  test("two reads of one record agree, however far apart the rows are", () => {
    // The shape the marking exists for. A `series_preparation` is drawn under the script that ran it
    // and under the assessment it was prepared for, from two separate reads — so the two rows hold two
    // card objects, in boxes that may be a screen apart, and what says they are one record is neither
    // the path nor the identity of the card.
    const fromScript = card("series_preparation", "sp1", "orats-vol-surface-daily");
    // The same row as another read saw it: a label the server composed differently is still that row.
    const fromAssessment = { ...fromScript, label: "orats-vol-surface-daily 2026-08-01" };
    const viaScript = rowPath(
      boxPath(rowPath(rootPath("script"), card("script", "sc1")), "series_preparation"),
      fromScript,
    );
    const assessmentRow = rowPath(
      boxPath(rowPath(rootPath("thesis"), card("thesis", "t1")), "thesis_assessment"),
      card("thesis_assessment", "ta1"),
    );
    const viaAssessment = rowPath(boxPath(assessmentRow, "series_preparation"), fromAssessment);

    expect(viaScript).not.toBe(viaAssessment);
    expect(cardKey(fromScript)).toBe(cardKey(fromAssessment));
  });

  test("the name is not what matches, because a name is unique in its table and no wider", () => {
    // A `script_invocation` and the `series_preparation` that ran the same program with the same
    // argument are drawn identically, and they are not the same row. Matching on what a row SHOWS
    // would mark each as the other's twin — which is why the key is the pair and not the label.
    const run = { ...card("script_invocation", "si1"), name: "orats-vol-surface-daily-mnqt" };
    const prep = { ...card("series_preparation", "sp1"), name: "orats-vol-surface-daily-mnqt" };
    expect(run.name).toBe(prep.name);
    expect(cardKey(run)).not.toBe(cardKey(prep));
  });
});

/**
 * The one reading this module used to do that no longer exists.
 *
 * A function here once answered "which folder was this node reached through" by decoding the id out
 * of the path, and it was the only place a key was ever read back as data rather than compared
 * against another key. Its caller was a `+` on a box, which handed the id to a route; every one of
 * those buttons now sends a MENTION, a mention names a record by NAME, and a name is on the card the
 * graph already holds. So the caller reads the card and the function is gone — see `GraphPanel.addFor`.
 *
 * Pinned as an absence because the property it leaves behind is worth keeping: nothing in this
 * module decodes a path segment, so the escaping in `rowPath` has one job (keeping a `/` from
 * becoming a boundary) rather than two, and no reading here can be wrong about an id.
 */
describe("nothing reads an id back out of a path", () => {
  test("a percent-encoded id is one segment, and that is all the escaping is for", () => {
    // The escape earns its place by making the segment COUNT right. Nothing this schema mints holds
    // a `/`, but a path is compared by prefix and counted by segment everywhere in this module, and
    // both readings would be wrong for exactly the rows that did.
    const odd = card("recipe", "a/b c%2Fd");
    const path = rowPath(RECIPES, odd);
    expect(path.split("/")).toHaveLength(2);
    // And it is still beneath the box it was added to, which is the question the path is actually
    // asked — rather than "what id is in it".
    expect(isBeneath(path, RECIPES)).toBe(true);
  });
});

describe("a row opens into the boxes of what refers to it", () => {
  test("a click puts a loading box in the state, and the answer lands in it", () => {
    let state = expand(withRoot([RC]), RC_PATH, RC);
    expect(isExpanded(state, RC_PATH)).toBe(true);
    expect(state.expansions.get(RC_PATH)).toMatchObject({
      card: RC,
      groups: null,
      loading: true,
      error: null,
    });

    // What points at a recipe is the reports published under it, and nothing else — a specification
    // is immutable, so there is no ledger of revisions hanging off it to walk into first.
    state = land(state, RC_PATH, [group("report", [card("report", "r1", "Q3 capacity")])]);
    expect(state.expansions.get(RC_PATH)).toMatchObject({ loading: false, error: null });
    expect(ids(rowsOf(state, RC_PATH, "report"))).toEqual(["r1"]);
  });

  test("the same record reached two ways is two independent boxes", () => {
    // The whole reason expansions are keyed by path: two theses whose regimes cover the same ticker
    // each draw a `target` box holding that one row, and opening one of those copies must not open
    // the other. The pair of edges is real — `regime` is the junction that carries them — and it is
    // the last junction in the schema, so it is also the only shape this property can be written
    // against honestly.
    const first = card("thesis", "t1", "Margin expansion holds");
    const second = card("thesis", "t2", "Capacity is the constraint");
    const target = card("target", "2330.TW");

    const theses = rootPath("thesis");
    let state = landRoot(createGraphState(), "thesis", {
      records: [first, second],
      hasMore: false,
    });
    for (const thesis of [first, second]) {
      const path = rowPath(theses, thesis);
      state = land(expand(state, path, thesis), path, [
        group("target", [target], { column: "ticker", onDelete: "NO ACTION", via: "regime" }),
      ]);
    }

    const underFirst = rowPath(boxPath(rowPath(theses, first), "target"), target);
    const underSecond = rowPath(boxPath(rowPath(theses, second), "target"), target);
    expect(underFirst).not.toBe(underSecond);

    state = expand(state, underFirst, target);
    expect(isExpanded(state, underFirst)).toBe(true);
    expect(isExpanded(state, underSecond)).toBe(false);
  });

  test("the same record under two different roots is two boxes as well", () => {
    // The multi-root version of the rule above. A script reached from the `script` box and the same
    // script reached from a thesis are two routes, and opening one must not open the other.
    const script = card("script", "sc1");
    const thesis = card("thesis", "t1");
    let state = landRoot(createGraphState(), "script", { records: [script], hasMore: false });
    state = landRoot(state, "thesis", { records: [thesis], hasMore: false });
    const thesisRow = rowPath(rootPath("thesis"), thesis);
    state = land(expand(state, thesisRow, thesis), thesisRow, [group("script", [script])]);

    const direct = rowPath(rootPath("script"), script);
    const viaThesis = rowPath(boxPath(thesisRow, "script"), script);
    state = expand(state, direct, script);
    expect(isExpanded(state, direct)).toBe(true);
    expect(isExpanded(state, viaThesis)).toBe(false);
  });

  test("an id holding a slash takes one segment, not three", () => {
    // No table mints an id like this: records are addressed by uuid hex and by ticker, and both of
    // those survive a path segment raw. The escaping stays
    // because every reading of a key here is a segment count or a prefix test — the column a box sits
    // in, whether one path is beneath another — and one `/` inside an id would make the row look two
    // columns deeper than it is and put both readings wrong for exactly those rows. So the id below
    // is built by hand, and this is the test that says the guard is still there when it is needed.
    const script = card("script", "fetch revenue/v2");
    const path = rowPath(boxPath(RC_PATH, "script"), script);
    expect(path.split("/")).toHaveLength(4);
    expect(path.startsWith(`${RC_PATH}/`)).toBe(true);
  });

  test("an answer that lands after its row was folded is dropped", () => {
    // Folding does not cancel the request; the answer arrives regardless. Letting it land would
    // reopen a box the reader deliberately closed, a second later, with no click behind it.
    const folded = fold(expand(withRoot([RC]), RC_PATH, RC), RC_PATH);
    expect(land(folded, RC_PATH, [group("report", [card("report", "r1")])])).toBe(folded);
    expect(fail(folded, RC_PATH, "gone")).toBe(folded);
  });
});

describe("folding takes everything under the row with it", () => {
  /**
   * The recipe box -> the reports published under it -> one report's script runs, with three boxes
   * dragged.
   *
   * The chain the schema actually has, which is why it is the one used to test folding: a run row
   * names the report it was recorded for, and that report names the recipe it was written to.
   */
  function deepGraph(): GraphState {
    const report = card("report", "r1", "Q3 capacity");
    const run = card("script_invocation", "si1", "revenue.py 2330");
    let state = land(expand(withRoot([RC]), RC_PATH, RC), RC_PATH, [group("report", [report])]);
    const reportRow = rowPath(boxPath(RC_PATH, "report"), report);
    state = land(expand(state, reportRow, report), reportRow, [
      group("script_invocation", [run]),
    ]);
    state = setOffset(state, RECIPES, { dx: 4, dy: 4 });
    state = setOffset(state, boxPath(RC_PATH, "report"), { dx: 10, dy: 20 });
    state = setOffset(state, boxPath(reportRow, "script_invocation"), { dx: 30, dy: 40 });
    return state;
  }

  test("descendants and the offsets they were dragged to go with it", () => {
    const state = fold(deepGraph(), RC_PATH);
    expect(expandedPaths(state)).toEqual([]);
    // The root box's own drag survives — it is not under the row that was folded.
    expect([...state.offsets.keys()]).toEqual([RECIPES]);
  });

  test("folding one branch leaves its sibling alone", () => {
    const other = card("recipe", "ef56");
    const otherPath = rowPath(RECIPES, other);
    let state = expand(deepGraph(), otherPath, other);
    state = setOffset(state, otherPath, { dx: 1, dy: 1 });
    state = fold(state, RC_PATH);
    expect(expandedPaths(state)).toEqual([otherPath]);
    expect([...state.offsets.keys()]).toEqual([RECIPES, otherPath]);
  });

  test("opening a row and closing it again leaves the state as it was", () => {
    const before = withRoot([RC]);
    const after = fold(expand(before, RC_PATH, RC), RC_PATH);
    expect(after).toEqual(before);
    expect(fold(before, RC_PATH)).toBe(before);
  });
});

/**
 * The three boxes that draw what is still in use first, and the one re-sort in a module whose law is
 * that rows never move.
 *
 * `activeFirst` is that exception and the argument for it is written at the function: a recipe's
 * text, a script's program and a thesis's statement are all immutable, so the only things that can
 * reorder any of the three boxes are storing a row and putting one down — both deliberate acts by
 * the person looking at it, never a poll landing under their cursor. What it buys is that "which of
 * these am I still working with" is answered by looking at the top of the box rather than by reading
 * every row.
 *
 * WHICH BOXES IT APPLIES TO IS ITS OWN QUESTION, asked of `ordersByStanding` and asserted below over
 * all four roots: `information_source` is the one root whose sublabel is not a standing at all, and
 * it is governed by the law rather than by the exception.
 *
 * The block that used to sit here pinned a `playbook` box that FOLDED — a stack of version cards
 * with the operative one face up and a strip that fanned the rest out — and it went with the
 * versions: instructions are one immutable recipe now, so there is nothing to stack, no `unstacked`
 * set, and no toggle.
 */
describe("the boxes with a standing draw what is still in use first", () => {
  /** A recipe as the record API hands one over: `meta` is `created_at`, and the sublabel carries the
   * standing ONLY when it is `inactive` — an active recipe has no sublabel at all. */
  function recipe(id: string, meta: number, retired = false): RecordCard {
    return { ...card("recipe", id, id, retired ? INACTIVE : undefined), meta };
  }

  /** A script, which the server spells the same way and for the same reason. */
  function script(id: string, meta: number, retired = false): RecordCard {
    return { ...card("script", id, id, retired ? INACTIVE : undefined), meta };
  }

  /** A thesis, which the server spells DIFFERENTLY: its sublabel is always the newest tag in its
   * assessment ledger, so a row still in play carries a word too — `unassessed` until somebody has
   * read it, `approven` or `insightful` after. Only `abandoned` puts it down. */
  function thesis(id: string, meta: number, tag = "unassessed"): RecordCard {
    return { ...card("thesis", id, id, tag), meta };
  }

  const old = recipe("rc1", 1_000);
  const mid = recipe("rc2", 2_000);
  const fresh = recipe("rc3", 3_000);
  const retiredOld = recipe("rc4", 1_500, true);
  const retiredNew = recipe("rc5", 2_500, true);

  test("a row put down is the one the sublabel says so about, and nothing else is", () => {
    expect(isRetired(retiredOld)).toBe(true);
    expect(isRetired(old)).toBe(false);
    // The two words on the wire, spelled once each. A card labelled anything else is a row still in
    // play as far as these boxes are concerned, which is the honest reading of a sublabel the server
    // did not send — and the two words that mean the most on a thesis, `approven` and `insightful`,
    // are exactly that case.
    expect(INACTIVE).toBe("inactive");
    expect(ABANDONED).toBe("abandoned");
    expect(isRetired({ ...old, sublabel: "under something" })).toBe(false);
    expect(isRetired(thesis("t1", 1_000, "insightful"))).toBe(false);
    expect(isRetired(thesis("t2", 1_000, "unassessed"))).toBe(false);
    expect(isRetired(thesis("t3", 1_000, ABANDONED))).toBe(true);
  });

  test("the three tables with a standing are the three boxes that reorder, and no others", () => {
    // The boundary of the exception, over the whole of column zero. An information source carries
    // its TYPE in the sublabel — how far it sits from the numbers — and that is not a standing: a
    // box that sorted on it would be re-sorting rows the merge is holding still on purpose.
    expect(ROOT_TABLES.filter(ordersByStanding)).toEqual(["recipe", "thesis", "script"]);
    // And a path that names no root at all — every group box in the graph — is governed by the law.
    expect(ordersByStanding(null)).toBe(false);
  });

  test("a thesis box is newest-first, with the abandoned ones under it", () => {
    // The two things a reader asked of this box in one sort: the claim written most recently is the
    // one at the top, and a claim whose ledger has closed is below every claim still being tested.
    const closed = thesis("t1", 4_000, ABANDONED);
    const judged = thesis("t2", 1_000, "approven");
    const newest = thesis("t3", 3_000);
    const older = thesis("t4", 2_000, "insightful");
    expect(ids(activeFirst([closed, judged, newest, older]))).toEqual(["t3", "t4", "t2", "t1"]);
  });

  test("a new assessment that is not an abandonment moves no thesis", () => {
    // Why the exception is safe on a table whose sublabel a poll CAN change: the tags a thesis
    // collects while it is being worked on are all on the same side of the comparison, so the row
    // the reader is pointing at stays where it is. Crossing the boundary happens once, ever — the
    // schema refuses to revive an abandoned thesis.
    const before = [thesis("t3", 3_000), thesis("t2", 2_000), thesis("t1", 1_000, "approven")];
    const after = [thesis("t3", 3_000, "insightful"), before[1]!, before[2]!];
    expect(ids(activeFirst(before))).toEqual(["t3", "t2", "t1"]);
    expect(ids(activeFirst(after))).toEqual(["t3", "t2", "t1"]);
  });

  test("the active rows come first, whatever order the box holds them in", () => {
    expect(ids(activeFirst([retiredNew, old, retiredOld, fresh]))).toEqual([
      "rc3",
      "rc1",
      "rc5",
      "rc4",
    ]);
  });

  test("a script box is read the same way, because the standing is spelled the same way", () => {
    // The `script` root box was drawn in the merge's own order until it was not, and the sort itself
    // asks the card rather than the table — so what this pins is that a script's `inactive` is the
    // same word, and that the rows the panel and the layout draw are therefore active-first.
    const running = script("sk1", 1_000);
    const replaced = script("sk2", 2_000, true);
    const newer = script("sk3", 3_000);
    expect(ids(activeFirst([replaced, running, newer]))).toEqual(["sk3", "sk1", "sk2"]);
  });

  test("within each standing the newest is on top", () => {
    expect(ids(activeFirst([old, fresh, mid]))).toEqual(["rc3", "rc2", "rc1"]);
    expect(ids(activeFirst([retiredOld, retiredNew]))).toEqual(["rc5", "rc4"]);
  });

  test("the sort is stable, so two rows stored in the same millisecond keep the box's order", () => {
    // Not a curiosity: `created_at` is milliseconds and the merge's append order is the tie-break
    // every other box in this graph is ordered by, so a tie has to fall back to it rather than to
    // whatever a sort happened to do with equal keys.
    const a = recipe("rca", 2_000);
    const b = recipe("rcb", 2_000);
    expect(ids(activeFirst([a, b, old]))).toEqual(["rca", "rcb", "rc1"]);
    expect(ids(activeFirst([b, a, old]))).toEqual(["rcb", "rca", "rc1"]);
  });

  test("a card that arrived with no moment sorts oldest rather than breaking the comparison", () => {
    const undated = card("recipe", "rcx");
    expect(ids(activeFirst([undated, old]))).toEqual(["rc1", "rcx"]);
  });

  test("an order that is already right is handed back as the same array", () => {
    // What keeps a box that is redrawn on every frame of a pan from being re-sorted into a new array
    // sixty times a second.
    const rows = [fresh, mid, old, retiredNew, retiredOld];
    expect(activeFirst(rows)).toBe(rows);
    const one = [fresh];
    expect(activeFirst(one)).toBe(one);
    const none: RecordCard[] = [];
    expect(activeFirst(none)).toBe(none);
  });

  test("a recipe stored while the box is on screen arrives at the bottom and is drawn on top", () => {
    // Both laws at once, which is the point. The merge appends the new row at the BOTTOM so nothing
    // already on screen moves under the cursor; the box reads the same rows active-and-newest-first.
    // Neither is negotiable and they do not conflict, because the reordering happens where the box
    // is drawn rather than where the rows are held.
    let state = landRoot(createGraphState(), "recipe", { records: [old, mid], hasMore: false });
    state = mergeRoot(state, "recipe", { records: [fresh, mid, old], hasMore: false });
    expect(rootIds(state, "recipe")).toEqual(["rc1", "rc2", "rc3"]);
    expect(ids(activeFirst(rootOf(state, "recipe").box!.records))).toEqual(["rc3", "rc2", "rc1"]);
  });

  test("retiring a recipe moves it below the active ones without moving anything held", () => {
    // A `set_recipe_status` lands as a sublabel appearing on a card already on screen. The held
    // order does not change — the merge updates the card where it sits — and the drawn order does,
    // which is the whole of the exception this block exists for.
    let state = landRoot(createGraphState(), "recipe", { records: [old, mid], hasMore: false });
    state = mergeRoot(state, "recipe", {
      records: [{ ...mid, sublabel: INACTIVE }, old],
      hasMore: false,
    });
    expect(rootIds(state, "recipe")).toEqual(["rc1", "rc2"]);
    expect(ids(activeFirst(rootOf(state, "recipe").box!.records))).toEqual(["rc1", "rc2"]);
  });

  test("replacing a script does the same to the script box", () => {
    // The other half of the same act: `set_script_status` retires the fetcher a new one supersedes,
    // and the box the reader is looking at redraws with the program they can still run on top —
    // while the rows themselves stay exactly where the merge put them.
    const running = script("sk1", 1_000);
    const doomed = script("sk2", 2_000);
    let state = landRoot(createGraphState(), "script", {
      records: [doomed, running],
      hasMore: false,
    });
    expect(ids(activeFirst(rootOf(state, "script").box!.records))).toEqual(["sk2", "sk1"]);
    state = mergeRoot(state, "script", {
      records: [{ ...doomed, sublabel: INACTIVE }, running],
      hasMore: false,
    });
    expect(rootIds(state, "script")).toEqual(["sk2", "sk1"]);
    expect(ids(activeFirst(rootOf(state, "script").box!.records))).toEqual(["sk1", "sk2"]);
  });

  test("abandoning a thesis does the same to the thesis box", () => {
    // The third of the three, through the merge rather than through the sort alone: an assessment
    // tagged `abandoned` lands as a sublabel changing on a card already on screen, the held order
    // does not move, and the drawn order puts the closed claim under the ones still being tested.
    const kept = thesis("t1", 1_000);
    const doomed = thesis("t2", 2_000);
    let state = landRoot(createGraphState(), "thesis", { records: [doomed, kept], hasMore: false });
    expect(ids(activeFirst(rootOf(state, "thesis").box!.records))).toEqual(["t2", "t1"]);
    state = mergeRoot(state, "thesis", {
      records: [{ ...doomed, sublabel: ABANDONED }, kept],
      hasMore: false,
    });
    expect(rootIds(state, "thesis")).toEqual(["t2", "t1"]);
    expect(ids(activeFirst(rootOf(state, "thesis").box!.records))).toEqual(["t1", "t2"]);
  });
});

describe("the four roots are read and merged independently", () => {
  const w = card("recipe", "w1");
  const t = card("thesis", "t1");

  test("a fresh state carries all four, unread", () => {
    const state = createGraphState();
    expect([...state.roots.keys()]).toEqual([...ROOT_TABLES]);
    for (const table of ROOT_TABLES) {
      expect(rootOf(state, table)).toEqual({ box: null, loading: false, error: null });
    }
    expect(isReading(state)).toBe(false);
  });

  test("landing one table leaves the other three exactly as they were", () => {
    const before = createGraphState();
    const after = landRoot(before, "thesis", { records: [t], hasMore: false });
    expect(rootIds(after, "thesis")).toEqual(["t1"]);
    for (const table of ["recipe", "information_source", "script"] as const) {
      expect(rootOf(after, table)).toBe(rootOf(before, table));
    }
  });

  test("a table that could not be read refuses on its own box only", () => {
    // The reason `error` is per root rather than per graph. One unreachable table must not read as
    // a window that has lost the database.
    let state = withRoot([w]);
    state = failRoot(state, "script", "could not reach YewReview");
    expect(rootOf(state, "script").error).toBe("could not reach YewReview");
    expect(rootOf(state, "recipe").error).toBeNull();
    expect(rootIds(state, "recipe")).toEqual(["w1"]);
  });

  test("a failed read keeps the rows already in hand, and the next one clears the sentence", () => {
    const state = failRoot(withRoot([RC]), "recipe", "could not reach YewReview");
    expect(rootIds(state, "recipe")).toEqual(["ab12"]);
    expect(rootOf(state, "recipe").loading).toBe(false);
    const recovered = mergeRoot(state, "recipe", { records: [RC], hasMore: false });
    expect(rootOf(recovered, "recipe").error).toBeNull();
    expect(rootIds(recovered, "recipe")).toEqual(["ab12"]);
  });

  test("a refresh where every table says nothing new returns the identical state", () => {
    // The load-bearing one, at 500ms. Four merges that each found nothing must leave the graph slice
    // the same OBJECT, or the panel re-renders and the layout is recomputed twice a second forever.
    let state = withRoot([RC]);
    let next = state;
    for (const table of ROOT_TABLES) {
      next = mergeRoot(next, table, {
        records: table === "recipe" ? [RC] : [],
        hasMore: false,
      });
    }
    expect(next).toBe(state);

    // And one table that DID move produces a new state, with the other three's objects untouched.
    state = next;
    next = mergeRoot(state, "thesis", { records: [t], hasMore: false });
    expect(next).not.toBe(state);
    expect(rootOf(next, "recipe")).toBe(rootOf(state, "recipe"));
  });

  test("isReading answers for the panel's spinner and its disabled refresh", () => {
    // One table still in flight is the honest answer to "is this picture settled" — the refresh
    // button stays dimmed until all four have come back, because it re-reads all four.
    const state = withRoot([RC]);
    expect(isReading(state)).toBe(false);
    const reading = beginRoot(state, "script");
    expect(isReading(reading)).toBe(true);
    expect(isReading(landRoot(reading, "script", { records: [], hasMore: false }))).toBe(false);
    // And the rows already drawn stay up while it reads — a refresh that blanked a root box would
    // fold everything opened out of it twice a second.
    expect(rootIds(reading, "recipe")).toEqual(["ab12"]);
  });

  test("each root pages on its own", () => {
    let state = landRoot(createGraphState(), "script", {
      records: [card("script", "s1")],
      hasMore: true,
    });
    state = extendRoot(state, "script", { records: [card("script", "s2")], hasMore: false });
    expect(rootIds(state, "script")).toEqual(["s1", "s2"]);
    expect(rootOf(state, "script").box?.hasMore).toBe(false);
    expect(rootOf(state, "recipe").box).toBeNull();
  });
});

describe("a live refresh must not move the row under the cursor", () => {
  const a = card("recipe", "a");
  const b = card("recipe", "b");
  const c = card("recipe", "c");

  test("rows keep their place, cards are updated where they sit, and new rows land at the bottom", () => {
    // The server answers newest-first. Taking that order would put the new record above everything
    // and move the row the reader's cursor is over, half a second after they put it there.
    const state = mergeRoot(withRoot([a, b, c]), "recipe", {
      records: [card("recipe", "d"), card("recipe", "b", "renamed"), a, c],
      hasMore: false,
    });
    expect(rootIds(state, "recipe")).toEqual(["a", "b", "c", "d"]);
    expect(rootOf(state, "recipe").box?.records[1]?.label).toBe("renamed");
  });

  test("a complete page removes what it does not mention", () => {
    const state = mergeRoot(withRoot([a, b, c]), "recipe", { records: [c, a], hasMore: false });
    expect(rootIds(state, "recipe")).toEqual(["a", "c"]);
  });

  test("a truncated page is evidence about what exists, not about what does not", () => {
    // The rows below the page's edge were read by scrolling the box to the end of its list. Deleting
    // them because the newest page does not mention them would make paging undo itself twice a second.
    let state = withRoot([a, b], true);
    state = extendRoot(state, "recipe", { records: [c], hasMore: false });
    expect(rootIds(state, "recipe")).toEqual(["a", "b", "c"]);
    expect(rootOf(state, "recipe").box?.hasMore).toBe(false);

    state = mergeRoot(state, "recipe", { records: [a, b], hasMore: true });
    expect(rootIds(state, "recipe")).toEqual(["a", "b", "c"]);
  });

  test("a refresh of one table that says nothing new returns the same state", () => {
    const state = withRoot([a, b]);
    expect(mergeRoot(state, "recipe", { records: [a, b], hasMore: false })).toBe(state);
    expect(
      mergeRoot(state, "recipe", {
        records: [card("recipe", "b"), card("recipe", "a")],
        hasMore: false,
      }),
    ).toBe(state);
  });

  test("an expansion whose row has gone is folded, with everything under it", () => {
    const report = card("report", "r1", "Q3 capacity");
    let state = land(expand(withRoot([a, RC]), RC_PATH, RC), RC_PATH, [group("report", [report])]);
    const reportRow = rowPath(boxPath(RC_PATH, "report"), report);
    state = land(expand(state, reportRow, report), reportRow, [
      group("script_invocation", [card("script_invocation", "si1")]),
    ]);
    state = setOffset(state, boxPath(RC_PATH, "report"), { dx: 8, dy: 8 });

    state = mergeRoot(state, "recipe", { records: [a], hasMore: false });
    expect(rootIds(state, "recipe")).toEqual(["a"]);
    expect(expandedPaths(state)).toEqual([]);
    expect(state.offsets.size).toBe(0);
  });

  test("a group refreshed in place keeps its rows where they are", () => {
    // A report's card carries the recipe it was published under — `under <name>` — which is a
    // sublabel derived from ANOTHER row, so renaming the recipe moves it on every report at once.
    // That is a card changing under a row already on screen, and it must be drawn where that row
    // already sits: the report the reader is pointing at does not slide down the box because the
    // specification above it was reworded.
    const r1 = card("report", "r1", "Q3 capacity", "under quarterly-capacity");
    const r2 = card("report", "r2", "Q4 capacity", "under quarterly-capacity");
    let state = land(expand(withRoot([RC]), RC_PATH, RC), RC_PATH, [group("report", [r1, r2])]);
    state = mergeExpansion(state, RC_PATH, [
      group(
        "report",
        [
          card("report", "r3", "Q1 capacity", "under capacity-review"),
          card("report", "r2", "Q4 capacity", "under capacity-review"),
          card("report", "r1", "Q3 capacity", "under capacity-review"),
        ],
        { total: 3 },
      ),
    ]);
    expect(ids(rowsOf(state, RC_PATH, "report"))).toEqual(["r1", "r2", "r3"]);
    expect(rowsOf(state, RC_PATH, "report")[0]?.sublabel).toBe("under capacity-review");
    expect(rowsOf(state, RC_PATH, "report")[1]?.sublabel).toBe("under capacity-review");
    expect(state.expansions.get(RC_PATH)?.groups?.[0]?.total).toBe(3);
  });

  test("a table that has stopped referring loses its box, and what was opened in it", () => {
    // A thesis is the row with two referrer tables: its assessment ledger, and the tickers its
    // regime covers. Withdrawing the regime is what takes the `target` box away, and the box opened
    // out of one of its rows goes with it.
    const thesis = card("thesis", "t1", "Margin expansion holds");
    const target = card("target", "2330.TW");
    const theses = rootPath("thesis");
    const thesisRow = rowPath(theses, thesis);
    let state = landRoot(createGraphState(), "thesis", { records: [thesis], hasMore: false });
    state = land(expand(state, thesisRow, thesis), thesisRow, [
      group("thesis_assessment", [card("thesis_assessment", "ta1")]),
      group("target", [target], { column: "ticker", onDelete: "NO ACTION", via: "regime" }),
    ]);
    const targetRow = rowPath(boxPath(thesisRow, "target"), target);
    state = land(expand(state, targetRow, target), targetRow, [group("thesis", [thesis])]);
    state = setOffset(state, boxPath(targetRow, "thesis"), { dx: 5, dy: 5 });

    state = mergeExpansion(state, thesisRow, [
      group("thesis_assessment", [card("thesis_assessment", "ta1")]),
    ]);
    expect(state.expansions.get(thesisRow)?.groups?.map((g) => g.table)).toEqual([
      "thesis_assessment",
    ]);
    expect(expandedPaths(state)).toEqual([thesisRow]);
    expect(state.offsets.size).toBe(0);
  });

  test("a table that has appeared is a new box at the end", () => {
    const thesis = card("thesis", "t1", "Margin expansion holds");
    const theses = rootPath("thesis");
    const thesisRow = rowPath(theses, thesis);
    let state = landRoot(createGraphState(), "thesis", { records: [thesis], hasMore: false });
    state = land(expand(state, thesisRow, thesis), thesisRow, [
      group("thesis_assessment", [card("thesis_assessment", "ta1")]),
    ]);
    state = mergeExpansion(state, thesisRow, [
      group("target", [card("target", "2330.TW")], {
        column: "ticker",
        onDelete: "NO ACTION",
        via: "regime",
      }),
      group("thesis_assessment", [card("thesis_assessment", "ta1")]),
    ]);
    expect(state.expansions.get(thesisRow)?.groups?.map((g) => g.table)).toEqual([
      "thesis_assessment",
      "target",
    ]);
  });
});

describe("paging within a box", () => {
  // A recipe's reports, which is the box that actually grows without bound: every generation
  // procedure that finishes publishes one, and scrolling a box open is a route for exactly this.
  const r1 = card("report", "417", "TSMC — Q3 capacity");
  const r2 = card("report", "418", "TSMC — pricing power");

  function opened(): GraphState {
    return land(expand(withRoot([RC]), RC_PATH, RC), RC_PATH, [
      group("report", [r1, r2], { total: 4, hasMore: true }),
    ]);
  }

  test("a page appends, and the counts come from the newer answer", () => {
    const state = extendGroup(
      opened(),
      RC_PATH,
      "report",
      group("report", [card("report", "419"), card("report", "420")], {
        total: 4,
        hasMore: false,
      }),
    );
    expect(ids(rowsOf(state, RC_PATH, "report"))).toEqual(["417", "418", "419", "420"]);
    expect(state.expansions.get(RC_PATH)?.groups?.[0]?.hasMore).toBe(false);
  });

  test("a page that overlaps what is already held does not draw a row twice", () => {
    const state = extendGroup(
      opened(),
      RC_PATH,
      "report",
      group("report", [r2, card("report", "419")], { total: 4, hasMore: false }),
    );
    expect(ids(rowsOf(state, RC_PATH, "report"))).toEqual(["417", "418", "419"]);
  });

  test("rows paged in survive the next refresh", () => {
    let state = extendGroup(
      opened(),
      RC_PATH,
      "report",
      group("report", [card("report", "419")], { total: 3, hasMore: false }),
    );
    // The refresh reads the newest page only, and it is truncated: it says nothing about 419.
    state = mergeExpansion(state, RC_PATH, [group("report", [r1, r2], { total: 3, hasMore: true })]);
    expect(ids(rowsOf(state, RC_PATH, "report"))).toEqual(["417", "418", "419"]);
  });

  test("the refresh asks for at least what is on screen, and never more than the API allows", () => {
    const exp = opened().expansions.get(RC_PATH)!;
    expect(shownLimit(exp)).toBe(DEFAULT_GROUP);

    const many = (count: number, table: RecordTable) =>
      group(
        table,
        Array.from({ length: count }, (_, i) => card(table, `${table}${i}`)),
      );
    // The groups are replaced wholesale below, so they are a REPORT's rather than a recipe's — what
    // is under test is the arithmetic over however many groups a box happens to have, and a recipe
    // has exactly one.
    expect(shownLimit({ ...exp, groups: [many(7, "seikan_invocation"), many(31, "script_invocation")] })).toBe(31);
    expect(shownLimit({ ...exp, groups: [many(MAX_GROUP + 40, "report")] })).toBe(MAX_GROUP);
    expect(shownLimit({ ...exp, groups: null })).toBe(DEFAULT_GROUP);
  });
});

describe("a failed read is an answer about the box it failed for", () => {
  test("the refusal lands on the row that was clicked, and a later answer clears it", () => {
    let state = fail(expand(withRoot([RC]), RC_PATH, RC), RC_PATH, "record not found");
    expect(state.expansions.get(RC_PATH)).toMatchObject({
      loading: false,
      error: "record not found",
      groups: null,
      card: RC,
    });

    state = land(state, RC_PATH, [group("report", [card("report", "r1")])]);
    expect(state.expansions.get(RC_PATH)?.error).toBeNull();
  });

  test("a refresh that fails leaves the rows already drawn alone", () => {
    let state = land(expand(withRoot([RC]), RC_PATH, RC), RC_PATH, [
      group("report", [card("report", "r1")]),
    ]);
    state = fail(state, RC_PATH, "could not reach YewReview");
    expect(ids(rowsOf(state, RC_PATH, "report"))).toEqual(["r1"]);
    expect(state.expansions.get(RC_PATH)?.error).toBe("could not reach YewReview");
  });
});

describe("a click marks the row it landed on", () => {
  test("the selection is the path that was clicked, and moves when another one is", () => {
    const other = card("recipe", "ef56");
    const state = select(withRoot([RC, other]), RC_PATH);
    expect(state.selection).toBe(RC_PATH);
    expect(select(state, rowPath(RECIPES, other)).selection).toBe(rowPath(RECIPES, other));
  });

  test("selecting the row that is already selected changes nothing at all", () => {
    // The identity guard the store leans on: `toggleNode` selects after every click, including the
    // clicks that only folded something, and a new state object each time would redraw the board.
    const state = select(withRoot([RC]), RC_PATH);
    expect(select(state, RC_PATH)).toBe(state);
  });

  test("nothing is selected before the first click", () => {
    expect(withRoot([RC]).selection).toBeNull();
  });
});

describe("the selection is cleared when the row it marked goes away", () => {
  const report = card("report", "r1", "Q3 capacity");
  const REPORT_ROW = rowPath(boxPath(RC_PATH, "report"), report);

  function opened(): GraphState {
    const state = land(expand(withRoot([RC]), RC_PATH, RC), RC_PATH, [group("report", [report])]);
    return land(expand(state, REPORT_ROW, report), REPORT_ROW, []);
  }

  test("folding an ancestor of the selection clears it", () => {
    // An outline owed to a row that is no longer drawn is a mark the reader can neither see nor
    // clear.
    const state = fold(select(opened(), REPORT_ROW), RC_PATH);
    expect(state.selection).toBeNull();
  });

  test("folding somewhere else leaves it alone", () => {
    const other = card("recipe", "ef56");
    const state = fold(select(opened(), REPORT_ROW), rowPath(RECIPES, other));
    expect(state.selection).toBe(REPORT_ROW);
  });

  test("folding the selected row itself clears it, so the store re-selects after folding", () => {
    // `toggleNode` relies on this order: fold, then select. A click that shut a row and left no
    // selection behind would unmark a row every time somebody tidied up.
    const folded = fold(select(opened(), REPORT_ROW), REPORT_ROW);
    expect(folded.selection).toBeNull();
    expect(select(folded, REPORT_ROW).selection).toBe(REPORT_ROW);
  });

  test("a refresh that deleted the selected row clears it, expanded or not", () => {
    // The case folding cannot cover: a row can be SELECTED without ever having been opened, so it
    // appears in no expansion key and nothing else would notice it had gone.
    const other = card("recipe", "ef56");
    let state = select(withRoot([RC, other]), rowPath(RECIPES, other));
    expect(isExpanded(state, state.selection!)).toBe(false);
    state = mergeRoot(state, "recipe", { records: [RC], hasMore: false });
    expect(state.selection).toBeNull();
  });

  test("a refresh that changed nothing leaves the selection where it was", () => {
    const state = select(withRoot([RC]), RC_PATH);
    expect(mergeRoot(state, "recipe", { records: [RC], hasMore: false })).toBe(state);
  });
});
