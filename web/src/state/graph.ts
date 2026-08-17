/**
 * The node graph's model: which rows have been opened, what came back, and where the reader has
 * dragged the boxes to.
 *
 * PURE and DOM-FREE, like `state/chat.ts` and for the same reason — `bun test` drives it directly
 * under the root tsconfig, so the orderings that are awkward in a live window (an answer landing
 * after its row was folded, a refresh arriving while a second page is being read) are testable
 * rather than anecdotal. Every function takes a state and returns one, and returns the SAME object
 * when nothing changed, so a subscriber comparing snapshots does not re-render the panel — and the
 * layout memoized on this slice's identity is not recomputed — when a 500ms refresh says nothing new.
 *
 * FOUR ROOTS, NOT ONE. Column zero is `recipe`, `thesis`, `information_source` and `script`, in
 * that order: a specification, an idea, a place facts come from, and a program. Those are the four
 * things somebody sits down already knowing they want, and everything else in the schema is reached
 * by walking out of one of them. Each is read and merged INDEPENDENTLY, so a `script` read that
 * failed is a refusal on the `script` box and says nothing about the other three — one shared
 * `error` would have made a single unreachable table look like a window that had lost the database.
 *
 * A ROOT IS SPELLED `root:<table>`, WITH A COLON. Every reading of a path here is a segment count or
 * a `/`-prefix test — which column a box sits in, whether one path is beneath another — and a root
 * spelled `root/recipe` would be two segments where a root box has to be one, putting its rows a
 * column too deep and making one root read as an ancestor of the others' rows. The colon is not a
 * separator in this grammar, so `root:recipe` is one segment and `root:recipe/recipe:ab12` is
 * two, which is exactly what a row inside a box should be.
 *
 * IDENTITY IN THIS GRAPH IS A ROUTE, NOT A ROW. A record legitimately appears in two places at once:
 * the same report is referred to by two theses, so it sits in a `report` box under each of them, and
 * a reader may open one copy and leave the other closed. Keying expansions by `table:id` would fuse
 * those two boxes into one — opening either would open both, and folding either would fold both,
 * which is the graph lying about what was clicked. So the key is the PATH that was walked to reach
 * the row: "root:recipe/recipe:ab12/report/report:cd34". Row segment, box segment, alternating,
 * so the key of a box is its source row plus a table and the key of a row is its box plus a record.
 * That also makes folding a subtree a string test — everything under a row is spelled with that
 * row's path as a prefix — and makes `state.offsets`, which is keyed the same way, fall away with it.
 *
 * THE SELECTION IS A ROW, AND THE WHOLE OF IT IS AN OUTLINE. A single click both opens a row and
 * marks it — one gesture, two facts, because a reader who has just clicked a row has told you which
 * row they mean. The mark is drawn inside that row and nowhere else: nothing dims, nothing moves,
 * nothing repacks. A selection that restyled the rest of the picture would be the re-jitter this
 * panel was built to avoid, wired to a click.
 *
 * A record's id goes into its segment PERCENT-ENCODED. Nothing this schema mints needs it — the ids
 * are hex and tickers, and every one of them survives raw — but every reading of a key here is a
 * segment count or a prefix test: the column a box belongs in, whether one path is beneath another.
 * An id holding a `/` would contribute two segments instead of one and make both readings wrong for
 * exactly those rows, so the escape stays and costs a call. NOTHING here decodes one: every question
 * this module answers about a record is answered from the cards in the state, and a path is only
 * ever compared against another path.
 *
 * MERGING APPENDS, IT NEVER RE-SORTS. This is the objection that kept this panel from being built:
 * the record tables are read newest-first, so a graph that re-sorted on every refresh would move the
 * row under the reader's cursor a half-second after they put it there, and a click meant for one
 * record would open another. So a refresh is a DIFF BY ID IN PLACE — a record still present keeps
 * its position and gets its card updated, a record that has gone is removed, and a record that is
 * new is appended AT THE BOTTOM of the box it belongs to. Position stability beats newest-first
 * inside a box; the group's own `total`, which the box draws in its title, stays the truth about how
 * many there are. There is exactly ONE exception, it is scoped to the three column-zero boxes whose
 * rows carry a standing, and the whole of the argument for it is written at `activeFirst` rather
 * than assumed here.
 *
 * A TRUNCATED PAGE IS EVIDENCE ABOUT WHAT EXISTS, NOT ABOUT WHAT DOES NOT. The refresh asks for
 * `shownLimit` rows, so a page that comes back saying `hasMore` is a window onto the newest of them
 * and says nothing about the rows below its edge. Deleting the rows a reader paged in with "show
 * more" because the first page does not mention them would make paging undo itself every half
 * second. So absence removes a row only from a page that claims to be complete.
 */

import type { RecordCard, RecordGroup, RecordTable } from "../lib/records.ts";
import { DEFAULT_GROUP, MAX_GROUP } from "../lib/records.ts";

// -- paths ----------------------------------------------------------------------------------------

/**
 * The four tables a reader starts from, in the order column zero stacks them.
 *
 * Not a preference and not a subset of `RECORD_TABLES` chosen for room: these are the four things
 * somebody opens this window already wanting, and every other table in the schema is something you
 * arrive at from one of them. Adding a fifth means claiming there is a fifth starting point.
 */
export const ROOT_TABLES = ["recipe", "thesis", "information_source", "script"] as const;

export type RootTable = (typeof ROOT_TABLES)[number];

/**
 * Where a node is, spelled as the route walked to reach it.
 *
 * "root:recipe" | "root:recipe/recipe:ab12" | "root:recipe/recipe:ab12/report"
 * | "root:recipe/recipe:ab12/report/report:cd34"
 *
 * Alternating: a ROW segment names a record inside the box before it, a BOX segment names the table
 * of one referrer group of the row before it. A root box is the only path with no row in it.
 */
export type NodePath = string;

/** What a root path begins with. A colon rather than a slash — see this file's header. */
const ROOT_PREFIX = "root:";

/** Column zero's box for one of the four tables. */
export function rootPath(table: RootTable): NodePath {
  return `${ROOT_PREFIX}${table}`;
}

/**
 * The root a path names, or null when the path is not a root box.
 *
 * Exported because the panel asks it of every box it draws, and `box.table` cannot answer it: a
 * `script` box hanging off a `thesis` row carries the same table name that column zero's `script`
 * box does, and the two read their rows from different halves of the state. The path is the only
 * thing that tells them apart, so the test on it lives here with the rest of the grammar.
 */
export function rootTableOf(path: NodePath): RootTable | null {
  if (!path.startsWith(ROOT_PREFIX)) return null;
  const rest = path.slice(ROOT_PREFIX.length);
  // A deeper path starts with the same five characters — `root:recipe/recipe:ab12` — and fails
  // here because what follows the prefix is not one of the four names.
  return (ROOT_TABLES as readonly string[]).includes(rest) ? (rest as RootTable) : null;
}

/** The row a record occupies inside a box. */
export function rowPath(parentBox: NodePath, card: RecordCard): NodePath {
  return `${parentBox}/${card.table}:${encodeURIComponent(card.id)}`;
}

/** One referrer group of a row, drawn as its own box in the next column. */
export function boxPath(sourceRow: NodePath, table: RecordTable): NodePath {
  return `${sourceRow}/${table}`;
}

/**
 * The path one segment shorter — a box's source row, a row's box.
 *
 * Exported because the panel reads it: a `LayoutBox` carries its path and its table, and finding the
 * group it draws means asking the expansion one segment up. Spelling that as a `lastIndexOf("/")`
 * over there would be a second copy of the grammar this module owns.
 */
export function parentPath(path: NodePath): NodePath | null {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? null : path.slice(0, cut);
}

/** How many segments a path is made of. The column a box sits in is half of this, rounded down. */
function segments(path: NodePath): number {
  let count = 1;
  for (let i = 0; i < path.length; i += 1) if (path.charCodeAt(i) === 47) count += 1;
  return count;
}

/**
 * Whether `path` is at or beneath `ancestor` — what folding a subtree tests.
 *
 * Named and exported rather than inlined into `fold`, so the relation the whole subtree logic rests
 * on can be exercised on its own instead of only through the thing that folds a graph.
 */
export function isBeneath(path: NodePath, ancestor: NodePath): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

// -- the state ------------------------------------------------------------------------------------

/**
 * One opened row.
 *
 * It carries the CARD that was clicked, not just the path, so the box stays drawable when the row
 * itself vanishes from the parent between the click and the answer: a refusal that cannot name what
 * was asked about is a refusal about nothing.
 */
export type Expansion = {
  /** The row that was clicked. The key in `expansions`, repeated here so an entry stands alone. */
  path: NodePath;
  card: RecordCard;
  /** Referrers only — what points AT this record. Null while the first read is in flight. */
  groups: RecordGroup[] | null;
  loading: boolean;
  /** The server's sentence, shown in place of the box with a retry. Never a toast: it is an answer
   * about the row that was clicked. */
  error: string | null;
};

/** How far the reader has dragged a box from where the packing put it. */
export type NodeOffset = { dx: number; dy: number };

/** One of the four boxes of column zero: what has been read of its table, and how the read went. */
export type RootState = {
  /** Null until the first read of this table lands. */
  box: { records: RecordCard[]; hasMore: boolean } | null;
  loading: boolean;
  /** The server's sentence about the last failed read of THIS table, and of no other. */
  error: string | null;
};

export type GraphState = {
  /** Column zero, keyed by table. All four are always present, so nothing downstream has to answer
   * "and what if this one has no entry". */
  roots: ReadonlyMap<RootTable, RootState>;
  /** Insertion order is CLICK order, and the layout breaks ties in a column with it, so two boxes
   * that want the same y sit in the order they were opened. */
  expansions: ReadonlyMap<NodePath, Expansion>;
  /** Box paths the reader has dragged, root boxes included. */
  offsets: ReadonlyMap<NodePath, NodeOffset>;
  /** The row a single click last landed on, which is the one drawn with an outline. Null before the
   * first click, and again as soon as that row is folded or refreshed away. */
  selection: NodePath | null;
};

const NO_EXPANSIONS: ReadonlyMap<NodePath, Expansion> = new Map();
const NO_OFFSETS: ReadonlyMap<NodePath, NodeOffset> = new Map();
/** Shared by all four at rest, which is safe because every state in this module is immutable. */
const UNREAD: RootState = { box: null, loading: false, error: null };

export function createGraphState(): GraphState {
  return {
    roots: new Map(ROOT_TABLES.map((table) => [table, UNREAD])),
    expansions: NO_EXPANSIONS,
    offsets: NO_OFFSETS,
    selection: null,
  };
}

// -- the root boxes -------------------------------------------------------------------------------

/** One root's state. */
export function rootOf(state: GraphState, table: RootTable): RootState {
  return state.roots.get(table) ?? UNREAD;
}

/** Whether any of the four is mid-read. What the ↻ button dims itself on, and what the surface says
 * as `aria-busy` — one table still reading is the honest answer to "is this picture settled". */
export function isReading(state: GraphState): boolean {
  for (const table of ROOT_TABLES) if (rootOf(state, table).loading) return true;
  return false;
}

/**
 * Replace one root, and only when it actually moved.
 *
 * The identity check is PER ROOT, which is what makes the four independent: a poll where three
 * tables said nothing new and the fourth gained a row leaves three `RootState` objects untouched,
 * and returns the whole graph unchanged when all four said nothing. That last case is the load
 * bearing one — it is what stops the half-second refresh from relaying out the graph forever.
 */
function withRoot(state: GraphState, table: RootTable, next: RootState): GraphState {
  const held = rootOf(state, table);
  if (held.box === next.box && held.loading === next.loading && held.error === next.error) {
    return state;
  }
  const roots = new Map(state.roots);
  roots.set(table, next);
  return { ...state, roots };
}

/**
 * One of the four tables is being read.
 *
 * Whatever is already in hand STAYS on screen while it is: a refresh that blanked a root box would
 * fold everything opened out of it twice a second.
 */
export function beginRoot(state: GraphState, table: RootTable): GraphState {
  return withRoot(state, table, { ...rootOf(state, table), loading: true, error: null });
}

export function landRoot(
  state: GraphState,
  table: RootTable,
  page: { records: RecordCard[]; hasMore: boolean },
): GraphState {
  return withRoot(state, table, {
    box: { records: page.records, hasMore: page.hasMore },
    loading: false,
    error: null,
  });
}

/**
 * The read failed.
 *
 * The records already in hand are kept. With none, the layout draws that root box as a refusal with
 * a retry — a failed read is never rendered as an empty answer, because "there are no scripts" is a
 * claim about the database this window cannot back. The other three boxes are untouched, because
 * this answer was about one table.
 */
export function failRoot(state: GraphState, table: RootTable, message: string): GraphState {
  return withRoot(state, table, { ...rootOf(state, table), loading: false, error: message });
}

// -- opening and closing rows ---------------------------------------------------------------------

/**
 * A row was clicked open.
 *
 * Called on a path that is not expanded — the panel toggles on `isExpanded` — but re-expanding an
 * open row is a refetch rather than a duplicate: the entry keeps its place in click order and the
 * rows already drawn stay up until the answer replaces them.
 */
export function expand(state: GraphState, path: NodePath, card: RecordCard): GraphState {
  const held = state.expansions.get(path);
  const next: Expansion = {
    path,
    card,
    groups: held?.groups ?? null,
    loading: true,
    error: null,
  };
  return { ...state, expansions: withExpansion(state.expansions, path, next) };
}

/**
 * The referrers came back.
 *
 * Dropped when the row is no longer open. A read is not cancelled by folding — the request is in
 * flight and its answer arrives regardless — and letting it land would make a box the reader
 * deliberately closed reappear a second later with no click behind it.
 */
export function land(state: GraphState, path: NodePath, groups: RecordGroup[]): GraphState {
  const held = state.expansions.get(path);
  if (held === undefined) return state;
  return {
    ...state,
    expansions: withExpansion(state.expansions, path, { ...held, groups, loading: false, error: null }),
  };
}

/** The read failed. Same guard, and the groups already in hand are kept: a refresh that fails leaves
 * the graph as it was and says so on the box it failed for. */
export function fail(state: GraphState, path: NodePath, message: string): GraphState {
  const held = state.expansions.get(path);
  if (held === undefined) return state;
  return {
    ...state,
    expansions: withExpansion(state.expansions, path, { ...held, loading: false, error: message }),
  };
}

/**
 * A row was clicked shut, with everything opened beneath it.
 *
 * The offsets go too. A box the reader dragged and then folded away has no place on screen any more,
 * and resurrecting that drag when the row is opened again would drop the box wherever it sat in a
 * layout nobody is looking at.
 *
 * THE SELECTION GOES WITH THEM when it was under here. An outline owed to a row that nothing draws
 * any more is a mark the reader cannot see and cannot clear; dropping it puts the picture back the
 * way it was before anything was clicked.
 */
export function fold(state: GraphState, path: NodePath): GraphState {
  const expansions = new Map(state.expansions);
  let changed = false;
  for (const key of state.expansions.keys()) {
    if (!isBeneath(key, path)) continue;
    expansions.delete(key);
    changed = true;
  }
  const offsets = new Map(state.offsets);
  for (const key of state.offsets.keys()) {
    if (!isBeneath(key, path)) continue;
    offsets.delete(key);
    changed = true;
  }
  const selection =
    state.selection !== null && isBeneath(state.selection, path) ? null : state.selection;
  if (!changed && selection === state.selection) return state;
  return { ...state, expansions, offsets, selection };
}

export function isExpanded(state: GraphState, path: NodePath): boolean {
  return state.expansions.has(path);
}

/** Every open row, in the order it was opened. What the refresh loop walks. */
export function expandedPaths(state: GraphState): NodePath[] {
  return [...state.expansions.keys()];
}

// -- refreshing -----------------------------------------------------------------------------------

/**
 * A fresh read of one of the four root tables, folded into what is on screen.
 *
 * Diffed by id in place — see this file's header. The state comes back IDENTICAL when the page says
 * nothing new, which is what stops a half-second poll from re-rendering the panel and relaying out
 * the graph forever. Four of these fire per refresh, so that has to hold four times over.
 */
export function mergeRoot(
  state: GraphState,
  table: RootTable,
  page: { records: RecordCard[]; hasMore: boolean },
): GraphState {
  const held = rootOf(state, table);
  if (held.box === null) return landRoot(state, table, page);
  const records = mergeRecords(held.box.records, page.records, page.hasMore);
  const box =
    records === held.box.records && held.box.hasMore === page.hasMore
      ? held.box
      : { records, hasMore: page.hasMore };
  const next = withRoot(state, table, { box, loading: false, error: null });
  const path = rootPath(table);
  return foldVanished(next, path, surviving(path, records), 1);
}

/**
 * A fresh read of one row's referrers.
 *
 * Groups are matched BY TABLE, which is the granularity a box is drawn at. A table that has stopped
 * referring to this record loses its box, and anything opened inside that box is folded with it —
 * the alternative is a column of boxes hanging off a row nothing can draw.
 */
export function mergeExpansion(
  state: GraphState,
  path: NodePath,
  groups: RecordGroup[],
): GraphState {
  const held = state.expansions.get(path);
  if (held === undefined) return state;
  if (held.groups === null) return land(state, path, groups);

  const merged = mergeGroups(held.groups, groups);
  const settled = held.loading || held.error !== null;
  const next =
    merged === held.groups && !settled
      ? state
      : {
          ...state,
          expansions: withExpansion(state.expansions, path, {
            ...held,
            groups: merged,
            loading: false,
            error: null,
          }),
        };
  return foldVanished(next, path, survivingUnder(path, merged), 2);
}

/**
 * One more page of one group, appended.
 *
 * Appended rather than merged: these are the rows BELOW the ones on screen, read with a keyset
 * cursor, and the box is already in the order the reader is looking at. `total` and `hasMore` come
 * from the newer answer — it is the one that just asked.
 */
export function extendGroup(
  state: GraphState,
  rowP: NodePath,
  table: RecordTable,
  more: RecordGroup,
): GraphState {
  const held = state.expansions.get(rowP);
  if (held === undefined || held.groups === null) return state;
  const at = held.groups.findIndex((group) => group.table === table);
  if (at === -1) return state;
  const group = held.groups[at]!;
  const known = new Set(group.records.map(segmentFor));
  const added = more.records.filter((record) => !known.has(segmentFor(record)));
  if (added.length === 0 && group.hasMore === more.hasMore && group.total === more.total) return state;
  const groups = [...held.groups];
  groups[at] = {
    ...group,
    records: [...group.records, ...added],
    hasMore: more.hasMore,
    total: more.total,
  };
  return { ...state, expansions: withExpansion(state.expansions, rowP, { ...held, groups }) };
}

/** One more page of one root table. Same rule as `extendGroup`. */
export function extendRoot(
  state: GraphState,
  table: RootTable,
  more: { records: RecordCard[]; hasMore: boolean },
): GraphState {
  const held = rootOf(state, table);
  if (held.box === null) return landRoot(state, table, more);
  const known = new Set(held.box.records.map(segmentFor));
  const added = more.records.filter((record) => !known.has(segmentFor(record)));
  if (added.length === 0 && held.box.hasMore === more.hasMore) return state;
  return withRoot(state, table, {
    ...held,
    box: { records: [...held.box.records, ...added], hasMore: more.hasMore },
  });
}

/**
 * How many rows a refresh of this row must ask for.
 *
 * The largest box wins, because one request answers the whole row and asking for less than is on
 * screen would make the merge treat everything below the page's edge as deleted. Floored at a
 * screenful so a row opened a moment ago still asks for one, and clamped at the ceiling the API
 * enforces so the request is not refused outright.
 */
export function shownLimit(exp: Expansion): number {
  let largest = 0;
  for (const group of exp.groups ?? []) largest = Math.max(largest, group.records.length);
  return Math.min(MAX_GROUP, Math.max(DEFAULT_GROUP, largest));
}

// -- the selection --------------------------------------------------------------------------------

/**
 * The row a click landed on.
 *
 * Selecting is not opening, and the click does both: one gesture, two facts, because a reader who
 * has just clicked a row has told you which row they mean and asking them to say it twice with a
 * modifier would be furniture. Set AFTER the fold or the expand, so clicking an open row shuts it
 * and still leaves it as the selection.
 */
export function select(state: GraphState, path: NodePath | null): GraphState {
  if (state.selection === path) return state;
  return { ...state, selection: path };
}

// -- dragging -------------------------------------------------------------------------------------

/** Where the reader has put a box. Applied after packing, and inherited by everything beneath it —
 * see `graphLayout.ts`. */
export function setOffset(state: GraphState, path: NodePath, offset: NodeOffset): GraphState {
  const held = state.offsets.get(path);
  if (held !== undefined && held.dx === offset.dx && held.dy === offset.dy) return state;
  const offsets = new Map(state.offsets);
  offsets.set(path, offset);
  return { ...state, offsets };
}

// -- the one ordering ----------------------------------------------------------------------------

/**
 * The two words the wire uses for a row that has been PUT DOWN, and there are two because this
 * schema keeps a standing in two different places.
 *
 * `inactive` is the `status` column of `recipe` and of `script`, which the server copies into the
 * sublabel only when it is true — a row still in use has no sublabel at all. `abandoned` is the
 * newest tag in a thesis's assessment ledger, and a thesis's sublabel always carries one of that
 * ledger's words (`unassessed` while nobody has read it). Two spellings of one meaning: nothing is
 * written against this row any more. The thesis one is the STRONGER of the two — the schema refuses
 * to revive an abandoned thesis at all, where a retired recipe can be made active again — which is
 * the reason it is the one most worth marking.
 */
export const INACTIVE = "inactive";
export const ABANDONED = "abandoned";

/** Whether this card is one that has been put down: a recipe nobody writes reports to any more, a
 * script that has been replaced, a thesis whose ledger closed. Drawn with its name struck through,
 * and sorted below the rows still in play in the three boxes that can hold one. */
export function isRetired(card: RecordCard): boolean {
  return card.sublabel === INACTIVE || card.sublabel === ABANDONED;
}

/**
 * The boxes drawn active-first: the three column-zero tables whose rows carry a standing.
 *
 * `recipe` and `script` carry a status a person can move, and the server says so by putting
 * `inactive` in the sublabel. `thesis` carries one too — it just does not live in a column of its
 * own: what a thesis is currently worth is the newest row of its assessment ledger, and `abandoned`
 * is that ledger's terminus. All three answer "which of these am I still working with", and
 * `information_source` is the one root that does not: its sublabel is the source's TYPE, which is a
 * fact about how far it sits from the numbers rather than about whether it is still in use.
 *
 * Asked of the ROOT table rather than of a box's own, because these three are the only tables
 * nothing points at: none can appear as a group box, and asking the root is what keeps the panel and
 * the layout asking the same question of the same string.
 */
export function ordersByStanding(table: RootTable | null): boolean {
  return table === "recipe" || table === "script" || table === "thesis";
}

/**
 * Those boxes' rows: ACTIVE FIRST, newest first within each standing.
 *
 * THIS IS A SORT IN THE MODULE WHOSE LAW IS THAT ROWS ARE NEVER RE-SORTED, and it is written here,
 * exported, and used by exactly two callers so that the exception is one thing rather than a habit.
 * The law (this file's header, "MERGING APPENDS") exists because the record tables are read
 * newest-first and a box that took that order would move the row under the reader's cursor half a
 * second after they put it there. Every word of that still holds for every other box in the graph.
 *
 * WHY THESE BOXES ARE WHERE IT DOES NOT BITE. A recipe's text, a script's program and a thesis's
 * statement are all IMMUTABLE — a fix is a new script, not an edited one — so nothing a refresh can
 * bring back about a row already on screen changes where this sort puts it. What CAN move a row is
 * storing one and putting one down, and both are deliberate acts by the person looking at the box,
 * at most once each, never twice a second behind a poll.
 *
 * A THESIS IS THE ONE WHOSE SUBLABEL MOVES ON ITS OWN, and it still does not move the row: an
 * assessment lands as a new tag, and `approven` and `insightful` are the same side of this
 * comparison as `unassessed`. Only an abandonment crosses the boundary, and the schema allows
 * exactly one of those per thesis, ever.
 *
 * And what the ordering says is the thing a reader is actually looking for: the specifications still
 * being written to, the programs still being run and the claims still being tested, newest at the
 * top, then the ones that have been put down. A box that interleaved them by age would make "which
 * of these am I still working with" a question you answer by reading every row.
 *
 * THE SORT IS STABLE — ECMAScript requires `Array.prototype.sort` to be — which is what settles two
 * rows stored in the same millisecond: they keep the order the box already has, which is the merge's
 * own append order, so the tie is broken by the same rule that governs every other box. `meta` is
 * `created_at` on all three tables; a card that somehow arrived without one sorts oldest rather than
 * crashing the comparison.
 *
 * It hands back the array it was given when that array is already in this order, so a box drawn
 * every frame of a pan is not re-sorted into a new array sixty times a second.
 */
export function activeFirst(records: readonly RecordCard[]): readonly RecordCard[] {
  const sorted = [...records].sort((a, b) => {
    const standing = Number(isRetired(a)) - Number(isRetired(b));
    return standing !== 0 ? standing : (b.meta ?? 0) - (a.meta ?? 0);
  });
  for (let i = 0; i < sorted.length; i += 1) if (sorted[i] !== records[i]) return sorted;
  return records;
}

// -- the merge ------------------------------------------------------------------------------------

/** What a card is matched on. The table is part of it because a box may one day hold more than one:
 * an id is unique within a table and nowhere else. */
function segmentFor(card: RecordCard): string {
  return `${card.table}:${card.id}`;
}

function withExpansion(
  expansions: ReadonlyMap<NodePath, Expansion>,
  path: NodePath,
  next: Expansion,
): ReadonlyMap<NodePath, Expansion> {
  const copy = new Map(expansions);
  // `set` on a key already present keeps its position, which is what preserves click order across a
  // refresh of a row that was opened first and answered last.
  copy.set(path, next);
  return copy;
}

/**
 * One box's rows, refreshed in place.
 *
 * Returns the array it was given when the answer says nothing new, so an unchanged poll costs one
 * comparison and no re-render anywhere above it.
 */
function mergeRecords(
  held: RecordCard[],
  incoming: RecordCard[],
  truncated: boolean,
): RecordCard[] {
  const fresh = new Map<string, RecordCard>();
  for (const record of incoming) fresh.set(segmentFor(record), record);

  const kept: RecordCard[] = [];
  let changed = false;
  for (const record of held) {
    const updated = fresh.get(segmentFor(record));
    if (updated === undefined) {
      // Absent from a page that carries everything means deleted. Absent from a truncated page means
      // only that it is below the page's edge — see this file's header.
      if (truncated) kept.push(record);
      else changed = true;
      continue;
    }
    if (!sameCard(record, updated)) changed = true;
    kept.push(updated);
  }

  const known = new Set(kept.map(segmentFor));
  for (const record of incoming) {
    if (known.has(segmentFor(record))) continue;
    // At the bottom, never in the server's order: a new record must not push the row under the
    // cursor down the box.
    kept.push(record);
    changed = true;
  }
  return changed ? kept : held;
}

/** Every field a row is DRAWN from. `name` is on the list because it is the row's title in the graph:
 * a rename that was not noticed here would leave the old label on screen until something else about
 * the row happened to move. The list is short because a card IS short — what the row shows is all of
 * it — and the one field that used to need watching hardest, the expand arrow's flag, has left the
 * card entirely: the arrow is a property of the table now, so no refresh can move it. */
function sameCard(a: RecordCard, b: RecordCard): boolean {
  return (
    a.name === b.name && a.label === b.label && a.sublabel === b.sublabel && a.meta === b.meta
  );
}

/** The referrer groups of one row, refreshed in place: surviving tables keep their order and their
 * rows, and a table that has appeared is a new box at the end. */
function mergeGroups(held: RecordGroup[], incoming: RecordGroup[]): RecordGroup[] {
  const fresh = new Map<RecordTable, RecordGroup>();
  for (const group of incoming) if (!fresh.has(group.table)) fresh.set(group.table, group);

  const kept: RecordGroup[] = [];
  let changed = false;
  for (const group of held) {
    const updated = fresh.get(group.table);
    if (updated === undefined) {
      changed = true;
      continue;
    }
    const records = mergeRecords(group.records, updated.records, updated.hasMore);
    if (
      records === group.records &&
      updated.total === group.total &&
      updated.hasMore === group.hasMore &&
      updated.column === group.column &&
      updated.onDelete === group.onDelete &&
      updated.via === group.via
    ) {
      kept.push(group);
      continue;
    }
    changed = true;
    kept.push({ ...updated, records });
  }

  const known = new Set(kept.map((group) => group.table));
  for (const group of incoming) {
    if (known.has(group.table)) continue;
    known.add(group.table);
    kept.push(group);
    changed = true;
  }
  return changed ? kept : held;
}

/** Every row path one root box still has. */
function surviving(box: NodePath, records: readonly RecordCard[]): Set<NodePath> {
  const paths = new Set<NodePath>();
  for (const record of records) paths.add(rowPath(box, record));
  return paths;
}

/** Every row path one expansion's boxes still have. */
function survivingUnder(row: NodePath, groups: readonly RecordGroup[]): Set<NodePath> {
  const paths = new Set<NodePath>();
  for (const group of groups) {
    const box = boxPath(row, group.table);
    for (const record of group.records) paths.add(rowPath(box, record));
  }
  return paths;
}

/**
 * Close whatever was opened on a row the refresh removed.
 *
 * An expansion whose source row is gone has nothing to hang off: the layout cannot find its row, and
 * its boxes would either vanish silently or float in a column with no link into them. Folding it is
 * the honest reading — the record it was about is not there any more — and folding takes its
 * descendants and its offsets with it.
 *
 * `below` is how many segments under `parent` a row of these boxes sits: one for a root box, whose
 * rows are its immediate children, and two for an expansion, whose rows sit inside a table box.
 * Deeper expansions are left alone here — they hang off rows this answer says nothing about, and
 * folding one of these takes them anyway.
 *
 * The selection is checked separately at the end, and it has to be: a row can be SELECTED without
 * ever having been expanded, so it appears in no key the loop above walks. Folding covers a
 * selection deeper down — its ancestor row goes, and `fold` clears it — but a selected leaf that
 * this refresh deleted would otherwise leave the outline owed to a row nothing draws.
 */
function foldVanished(
  state: GraphState,
  parent: NodePath,
  survivors: ReadonlySet<NodePath>,
  below: number,
): GraphState {
  const depth = segments(parent) + below;
  let next = state;
  for (const key of state.expansions.keys()) {
    if (!key.startsWith(`${parent}/`) || segments(key) !== depth) continue;
    if (survivors.has(key)) continue;
    next = fold(next, key);
  }
  const selection = next.selection;
  if (
    selection !== null &&
    selection.startsWith(`${parent}/`) &&
    segments(selection) === depth &&
    !survivors.has(selection)
  ) {
    next = { ...next, selection: null };
  }
  return next;
}
