/**
 * The log read-out's model: two capped ledgers, paged backwards, and a nonce each.
 *
 * PURE and DOM-FREE, like `state/cards.ts` and `state/graph.ts` and for the same reason — `bun test`
 * drives it directly under the root tsconfig, so the orderings that are awkward to reproduce in a
 * live window (a head refetch landing on top of pages somebody scrolled back through, two frames
 * arriving between one fetch and its answer) are assertions rather than hopes. Every function takes a
 * state and returns one, and returns the SAME object when nothing moved, so the viewer does not
 * re-render a hundred rows because a poll about the other category said nothing new.
 *
 * TWO CATEGORIES, ONE SHAPE, ONE MODULE. Errors and deletions are different rows about different
 * things — one is the machine saying what went wrong, the other is the ledger of what was destroyed —
 * but they are the same LEDGER: capped at a thousand, keyed by a rowid the database hands out in
 * order, and read newest-first through one keyset route. Splitting them into two modules would be
 * writing the paging twice, and the second copy is where the dedupe quietly stops matching.
 *
 * THREE INSTRUMENTS, ONE SLOT. The two ledgers are expanding units in the corner column rather than
 * two sections of one panel, because they answer questions nobody asks together: "what
 * went wrong" is debugging and "what was destroyed" is an audit, and scrolling past a hundred
 * deletions to reach the traceback serves neither. The session list shares the same
 * slot for the same reason: which conversation to swap in is a third question glanced
 * at singly, not worked beside the others. What does NOT follow is a flag per unit. These are
 * instruments, so opening one IS closing the others — and `view` being one slot holding whichever
 * is being read, or nothing, is what makes that a fact of the model rather than choreography among
 * three components: flipping the slot is the one write that animates one unit open and the rest
 * shut in the same frame. The slot holds `CornerView` — a ledger category or `"sessions"` — while
 * everything below this header stays spelled in `LogCategory`, because the session list has no
 * pages, no nonces and no fetch: it borrowed the slot, not the machinery.
 *
 * THE HEAD IS AUTHORITATIVE ABOUT THE NEWEST ROWS AND SILENT ABOUT THE REST. `landHead` is what a
 * refetch produces — the newest page, asked for again because a frame said something was logged — and
 * it REPLACES rather than appends: the rows it names are the truth about that region, and the rows
 * held from earlier pages are kept underneath it. Dedupe is by id, because a refetch overlaps
 * everything the viewer already had and a merge that trusted position would stack a second copy of
 * every row on every poke. Ids are what the two lists have in common and the only total order they
 * agree on, so the merged list is sorted by id descending rather than by concatenation — the server
 * sorts too, and this module does not need to know that to be right.
 *
 * A PAGE THAT SAYS `hasMore: false` IS A CLAIM ABOUT WHAT EXISTS. It is the whole ledger, so anything
 * held below it is gone and is dropped — the same doctrine `state/graph.ts` argues at length for
 * record pages, and the same asymmetry: a TRUNCATED page says nothing about the rows under its edge,
 * so it never deletes anything, and only a complete one may. Without that rule the viewer would show
 * rows the log no longer holds for as long as somebody left it open.
 *
 * THE NONCES ARE NOT A CACHE KEY. `error_logged` and `deletion_logged` are bodyless pokes — the
 * server says something happened and nothing about what — and the button in the corner has to be able
 * to say "there is something new" without the viewer being open and without a fetch. So each poke
 * bumps its category's counter and nothing else: a deletion must not make the error section look
 * stale, or the mark stops meaning anything within a minute of the agent starting work. They are
 * bumped unconditionally, viewer open or closed, because the alternative is the store deciding what a
 * fact about the server means before it is recorded.
 *
 * WHAT IS NOT HERE: fetching. This module never knows a URL, a category string on the wire or an
 * abort signal. The store owns all three and hands the answers in, which is what makes every sequence
 * below expressible as three function calls in a test.
 */

import type { DeletionLogEntry, ErrorLogEntry } from "../lib/protocol.ts";

// -- what a page is --------------------------------------------------------------------------------

/** Which ledger. The same two words the route takes, so nothing here translates one spelling of a
 * category into another. */
export type LogCategory = "errors" | "deletions";

/** What the corner slot can hold: a ledger being read, or the session list. The session list is not
 * a category — it pages nothing and pokes nothing — so this union exists instead of a third
 * `LogCategory`, and only `view` speaks it. */
export type CornerView = LogCategory | "sessions";

/** A row of either ledger. The only thing this module needs of one is that it has an id. */
type LogEntry = ErrorLogEntry | DeletionLogEntry;

/**
 * What a fetch answered: the rows, and whether the ledger continues below them.
 *
 * Deliberately not `LogPage` — a page in flight is a fact about the window, and this is a fact about
 * the server. Keeping them separate is what lets `landHead` and `appendOlder` take exactly what the
 * route returns without the caller having to invent a `loading` for it.
 */
export type LogAnswer = {
  readonly entries: readonly LogEntry[];
  readonly hasMore: boolean;
};

/** One ledger as the viewer holds it: what has been read, whether there is more, and how the last
 * read went. */
export type LogPage<T> = {
  /** NEWEST FIRST, and every id distinct. Both properties are this module's job to keep. */
  readonly entries: readonly T[];
  /** Whether the server says there are older rows than the oldest held here. */
  readonly hasMore: boolean;
  readonly loading: boolean;
  /** Why the last read did not land, in the viewer and never as a toast: a log that cannot be read is
   * a fact about the log, and it belongs in the panel that is empty because of it. */
  readonly error: string | null;
};

export type LogsState = {
  /** Which corner unit is open, or null for none. All three units are always drawn; this is what
   * their heads toggle, and one slot is what makes opening any one of them close the others. */
  readonly view: CornerView | null;
  readonly errors: LogPage<ErrorLogEntry>;
  /** Bumped by every `error_logged` frame and by nothing else. See the header. */
  readonly errorsNonce: number;
  readonly deletions: LogPage<DeletionLogEntry>;
  readonly deletionsNonce: number;
};

const EMPTY_PAGE = { entries: [], hasMore: false, loading: false, error: null } as const;

export function createLogsState(): LogsState {
  return {
    view: null,
    errors: EMPTY_PAGE,
    errorsNonce: 0,
    deletions: EMPTY_PAGE,
    deletionsNonce: 0,
  };
}

// -- the ledger a category holds -------------------------------------------------------------------

/**
 * Reach one of the two pages, and keep the state object when the page did not move.
 *
 * The generic callback is what makes this one traversal instead of two: `f` is written once against
 * `LogPage<T>` and applied to whichever slot the category names, so nothing below has to say
 * "errors" and "deletions" a second time. Comparing by IDENTITY rather than by field is the whole
 * discipline of this module — a function that decided nothing changed returns the page it was given,
 * and that answer travels all the way out to the subscriber.
 */
function mapPage(
  state: LogsState,
  category: LogCategory,
  f: <T extends LogEntry>(page: LogPage<T>) => LogPage<T>,
): LogsState {
  if (category === "errors") {
    const next = f(state.errors);
    return next === state.errors ? state : { ...state, errors: next };
  }
  const next = f(state.deletions);
  return next === state.deletions ? state : { ...state, deletions: next };
}

/**
 * THE ONE UNCHECKED STEP IN THIS MODULE, named so nobody has to find it.
 *
 * A category and a row type are the same fact spelled twice, and the type system cannot see that
 * across the `LogAnswer` union: the caller asked `/api/logs?category=errors` and got error rows back,
 * but by the time the answer is here it is only "rows of one of the two kinds". The alternative is a
 * runtime guard sniffing for a `scope` field, which would SILENTLY DROP a page handed to the wrong
 * category — a bug that shows up as an empty section rather than as a type error at the one call site
 * that could have made it. So the pairing is asserted here, once, and the store is the thing that has
 * to keep it: one fetcher, keyed by the same category it lands under.
 */
function ofKind<T extends LogEntry>(entries: readonly LogEntry[]): readonly T[] {
  return entries as readonly T[];
}

/** Whether two lists are the same rows in the same order. Ids only: these ledgers are append-only and
 * have no UPDATE anywhere in the repository, so a row that kept its id kept everything else too. */
function sameRows<T extends LogEntry>(held: readonly T[], next: readonly T[]): boolean {
  if (held.length !== next.length) return false;
  for (let i = 0; i < held.length; i += 1) {
    if (held[i]?.id !== next[i]?.id) return false;
  }
  return true;
}

/** Newest first, each id once, the first copy of a repeat winning. Sorting rather than trusting the
 * order two concatenated pages happen to be in: this is where the merge decides what "newest" means,
 * and the id is the only thing both pages measure it with. */
function newestFirst<T extends LogEntry>(entries: readonly T[]): readonly T[] {
  const sorted = [...entries].sort((a, b) => b.id - a.id);
  const out: T[] = [];
  let last: number | null = null;
  for (const entry of sorted) {
    if (entry.id === last) continue;
    out.push(entry);
    last = entry.id;
  }
  return out;
}

/** Swap a page's rows, returning the page itself when the swap changed nothing a subscriber could
 * see. What is compared is exactly what a landing writes — the rows, the `hasMore` that came with
 * them, and the two fields that say a read finished. */
function settle<T extends LogEntry>(
  page: LogPage<T>,
  entries: readonly T[],
  hasMore: boolean,
): LogPage<T> {
  const settled = !page.loading && page.error === null && page.hasMore === hasMore;
  if (settled && sameRows(page.entries, entries)) return page;
  return { entries, hasMore, loading: false, error: null };
}

// -- the viewer ------------------------------------------------------------------------------------

/**
 * Show one corner unit, or none.
 *
 * The pages are left exactly as they are, whichever way the slot moves: closing is a fact about the
 * screen, and a reader who closes the log and opens it again is not asking to re-read a thousand
 * rows. Switching from one unit to another disturbs no page for the same reason — the chips share a
 * slot, not a page.
 */
export function setLogView(state: LogsState, view: CornerView | null): LogsState {
  if (state.view === view) return state;
  return { ...state, view };
}

// -- reading ---------------------------------------------------------------------------------------

/**
 * A read has started.
 *
 * The standing rows stay on screen — a log that emptied itself while it refreshed would blink out
 * from under the reader every time the agent touched a tool — and the standing error goes, because a
 * sentence explaining a failure that is being retried right now is a sentence about the past.
 */
export function beginPage(state: LogsState, category: LogCategory): LogsState {
  return mapPage(state, category, (page) => {
    if (page.loading && page.error === null) return page;
    return { ...page, loading: true, error: null };
  });
}

/**
 * The newest page came back.
 *
 * Merged over what is held rather than replacing it wholesale, because the reader may have paged back
 * through older rows and a poke about one new error must not throw that away. See the header for the
 * dedupe and for why a complete answer is allowed to delete.
 */
export function landHead(state: LogsState, category: LogCategory, answer: LogAnswer): LogsState {
  return mapPage(state, category, (page) => landIn(page, answer));
}

function landIn<T extends LogEntry>(page: LogPage<T>, answer: LogAnswer): LogPage<T> {
  const head = ofKind<T>(answer.entries);
  // A complete answer is the whole ledger; anything held below it has been pruned away.
  const merged = answer.hasMore ? newestFirst([...head, ...page.entries]) : newestFirst(head);
  return settle(page, merged, answer.hasMore);
}

/**
 * "Show more" came back.
 *
 * Only rows OLDER than the oldest held are taken. The request is keyset — `before` is the oldest id in
 * hand — so an answer overlapping what is already on screen means rows were written between the two
 * requests, and appending them would put new rows at the BOTTOM of a newest-first list. `newestFirst`
 * would sort that back out, but dropping them is the honest answer: they belong to the head, and the
 * head is refetched by the frame that announced them.
 */
export function appendOlder(state: LogsState, category: LogCategory, answer: LogAnswer): LogsState {
  return mapPage(state, category, (page) => appendIn(page, answer));
}

function appendIn<T extends LogEntry>(page: LogPage<T>, answer: LogAnswer): LogPage<T> {
  const oldest = page.entries.at(-1);
  const tail = ofKind<T>(answer.entries).filter(
    (entry) => oldest === undefined || entry.id < oldest.id,
  );
  return settle(page, newestFirst([...page.entries, ...tail]), answer.hasMore);
}

/**
 * The read failed, and the section says so under whatever it already had.
 *
 * A repeat of the same sentence returns the state unchanged, which is not a micro-optimisation: a
 * viewer left open while the server is down retries on every poke, and a new state object per failure
 * would redraw both sections for as long as it stays open.
 */
export function failPage(state: LogsState, category: LogCategory, message: string): LogsState {
  return mapPage(state, category, (page) => {
    if (!page.loading && page.error === message) return page;
    return { ...page, loading: false, error: message };
  });
}

/**
 * Something was logged. Which one, and nothing else.
 *
 * Always a new state, unlike everything above it: the whole content of this call is "the server moved
 * since you last looked", and a nonce that declined to change because the viewer was closed would be
 * this module deciding the reader does not need to be told.
 */
export function noteLogged(state: LogsState, category: LogCategory): LogsState {
  if (category === "errors") return { ...state, errorsNonce: state.errorsNonce + 1 };
  return { ...state, deletionsNonce: state.deletionsNonce + 1 };
}

// -- deletions, by table ---------------------------------------------------------------------------

/** One table's worth of deleted rows, newest first inside the group. */
export type DeletionGroup = {
  readonly table: string;
  readonly entries: readonly DeletionLogEntry[];
};

/**
 * The deletion ledger, grouped by the table each row came out of.
 *
 * A flat list of deletions is unreadable in exactly the case it matters: the agent deleting a thesis
 * takes its assessments with it, and twenty rows in three tables scroll past as one undifferentiated
 * amber wall. Grouped, the same twenty rows read as "a thesis, its assessments, its targets", which is
 * what actually happened.
 *
 * GROUP ORDER IS BY THE NEWEST ROW IN EACH GROUP, and it falls out of the walk rather than being
 * sorted for: the entries arrive newest-first, a group is created the first time its table is seen, and
 * a Map iterates in insertion order. So the table something was just deleted from is at the top, which
 * is where somebody who just watched it happen will look.
 *
 * `table_name` is a plain string here rather than a `RecordTable`, and that is deliberate: the log has
 * NO foreign keys — its rows outlive the tables they describe, which is the entire point of writing
 * them down — so a schema that drops a table must not make this function unable to name what it holds.
 */
export function groupDeletions(entries: readonly DeletionLogEntry[]): readonly DeletionGroup[] {
  const groups = new Map<string, DeletionLogEntry[]>();
  for (const entry of entries) {
    const held = groups.get(entry.table_name);
    if (held === undefined) groups.set(entry.table_name, [entry]);
    else held.push(entry);
  }
  return [...groups].map(([table, rows]) => ({ table, entries: rows }));
}

/**
 * What the destroyed row was CALLED, out of the JSON the ledger kept of it.
 *
 * The ledger stores the whole row, which means the one thing a reader can recognise it by is sitting
 * right there: `name`, the line the record wore everywhere in this window while it
 * existed. A row id is a uuid — the same length and shape as every other row's, carrying nothing
 * anybody can check — and drawing it would be this ledger telling the reader that something with no
 * name was deleted, when it had one.
 *
 * THE FALLBACK IS THE ROW ID, AND IT HAS TO BE. The ledger keeps whatever the row was, and nothing
 * in the JSON guarantees that column: a row without it has the id as its only
 * surviving identity, and a ledger that answered "unnamed" would be destroying the record a second
 * time. Same doctrine as `pretty` below: when the stored bytes are all that is left, show them.
 */
export function deletedName(entry: DeletionLogEntry): string {
  try {
    const row: unknown = JSON.parse(entry.row_json);
    if (typeof row === "object" && row !== null && !Array.isArray(row)) {
      const name = (row as Record<string, unknown>)["name"];
      if (typeof name === "string" && name !== "") return name;
    }
  } catch {
    /* unparseable — the id is what is left, per the note above */
  }
  return entry.row_id;
}
