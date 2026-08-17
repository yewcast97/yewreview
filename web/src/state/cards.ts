/**
 * The record panel's model: what the reader has open, in the order they opened it, and how each of
 * those readings went.
 *
 * PURE and DOM-FREE, like `state/graph.ts` and `state/chat.ts`, and for the same reason — `bun test`
 * drives it directly under the root tsconfig, so the orderings that are miserable to reproduce in a
 * live window (an answer landing on a card that was closed while it was in flight, a half-second
 * refresh of five cards answering out of order, a card reopened between the request and its reply)
 * are asserted rather than hoped for. Every function takes a state and returns one, and returns the
 * SAME object when nothing moved, so a subscriber comparing snapshots does not redraw a stack of
 * open editors because a poll about a different card said nothing.
 *
 * THE PANEL HOLDS A STACK, and that is what this module exists for. It stands on the reading
 * argument alone: following "what is this report standing on" means opening the thing it stands on,
 * and a single cursor — one `selected`, one `detail`, one `error`, with opening anything closing
 * whatever was there — makes that a matter of remembering what the other one said. A reader checking
 * a published number against the source it came from wants both on screen, and neither of them is
 * being written.
 *
 * The two-cursor layout underneath is the whole point: opening a row in the GRAPH expands it — that
 * is what a click there means — so a record read whole has nowhere to live over there without making
 * one gesture mean two things. The centre column walks the keys; this column holds what was found,
 * and "what was found" is plural.
 *
 * WHAT AN EDGE CLICK MEANS FOLLOWS FROM THAT. Clicking an edge drawn inside a card opens the record
 * it names as a card of its own beside the one it was clicked in, rather than RE-POINTING the panel —
 * so following "what is this report standing on" leaves the report on screen, and the trail somebody
 * walked is readable as a stack when they get there. A cursor that re-pointed would make walking two
 * steps out and back the only way to see a record and the thing it stands on together.
 *
 * ONE KIND OF CARD, AND IT IS A RECORD READ WHOLE. There were four: a record, and three blank forms
 * — the one that made a place to publish into, the one that recorded an information source, and
 * the one that wrote a specification. Nothing in this window writes to the database any more; a record is
 * created, corrected, renamed and deleted by asking the agent for it in the conversation, so a card
 * that held a form would be a card holding a gesture that no longer exists. What is left is what
 * this panel was always for, which is READING one.
 *
 * `kind` SURVIVES THE COLLAPSE, and its one member is not a formality. The store, the board and the
 * two refresh loops all branch on "is this card a reading" before they do anything — a re-read, a
 * resize grip, a Bin payload — and a discriminant that is present is what makes the compiler
 * complain rather than the panel go quiet if a second kind is ever added back. A union of one is
 * also exactly what a switch over it should be exhaustive against.
 *
 * NO CARD IS A DRAFT, and the emptiness where a draft vocabulary would be is the point. Nothing here
 * is held on the server under a key of its own, edited in this panel and committed from it, so this
 * header names no server-spelled key, no revision to compare against, and no edit draft riding
 * inside the record card it corrects. A card holds a READING and the reading's own staleness token;
 * unfinished writing lives in the conversation, where it is a sentence somebody said.
 *
 * NOTHING HERE EVER READS A KEY BACK, which is what separates this grammar from the graph's. A
 * `NodePath` is parsed constantly — how many segments, whose descendant, which row it was
 * reached through — so ids are percent-encoded into it. A card key is a map key and nothing else, so
 * an id with a slash or a colon in it needs no escaping: two different cards can only collide by
 * being the same table and the same id, which is being the same card.
 *
 * AND THAT IS THE OTHER HALF OF THE CONTRAST. The graph deliberately draws one record twice when two
 * routes reach it, because over there identity is a ROUTE and folding one copy must not fold the
 * other. Here identity is the record: a report opened from its thesis and the same report opened from
 * a mention pill are one reading of one row, so the second gesture FOCUSES the card that is already
 * open rather than stacking a duplicate of it beside itself.
 *
 * OPENING NEVER MOVES WHAT IS ALREADY OPEN. Insertion order is stack order and a new card lands at
 * the bottom — the same doctrine `mergeRoot` follows in the graph, for the same reason: the reader is
 * mid-sentence in an editor somewhere on this stack, and a panel that inserted at the top would slide
 * that editor down the screen every time a report finished. `focused` is how a new card announces
 * itself instead; the panel scrolls to it and leaves everything else exactly where it was.
 *
 * THE STALENESS TOKEN, ONE PER CARD. Guarding an in-flight read by the OBJECT IDENTITY of what it
 * was started for is enough while there is one reading at a time: a second click mints a second
 * selection object and the older answer, arriving late, finds the field pointing somewhere else and
 * drops itself. A stack needs that trick once per card, and it cannot be the
 * card object doing the work — the card's state is replaced by every unrelated change to it, so a
 * nonce bump or a focus would silently cancel a read that is still perfectly good. So each card
 * carries a token, minted per read, and an answer must present the token the card is holding. A
 * SYMBOL rather than a counter, because a counter can be compared to a revision or a nonce and be
 * accidentally right; a symbol is equal to nothing but itself, so the only way to satisfy the guard
 * is to be the read that was actually started. A card opened fresh is given one nobody holds, which
 * is what makes closing a card and reopening it drop the answer to the read from before it closed.
 *
 * A FAILED READ IS NEVER RENDERED AS AN EMPTY ANSWER, per card. The `error` sits on the card it
 * is about and is drawn in place of that card's body with a retry — never as a toast, which expires
 * while the empty space it explained stays on screen, and never on the panel, which would blame five
 * cards for one row that has been deleted since it was drawn. Whatever detail was already in hand is
 * kept underneath: it is not drawn while the error stands, and it is what a retry that lands puts
 * back without the card having gone blank in between.
 *
 * THE NONCE IS PER CARD, and it is the one number here that is not about reading. A report republished
 * under the same id is new bytes at the same URL, so the panel keys its `<iframe>` on `${id}:${nonce}`
 * and a bump remounts it; without one the frame would keep showing the document it already had. One
 * per card because two reports can be open at once and only one of them was just rewritten.
 *
 * EVERY FIELD ON A CARD IS NOW ABOUT READING ONE ROW, which is what the collapse bought. `detail`,
 * `loading` and `error` used to be carried by the three blank forms as well — always null, always
 * false, always null — because the panel walked one list and a stack whose entries answered
 * different questions would have had to branch before it could ask any of them. There is one kind of
 * entry now, so there is nothing on a card that is not an answer about the row it is showing.
 */

import type { RecordDetail, RecordTable } from "../lib/records.ts";

// -- what a card is -------------------------------------------------------------------------------

/**
 * One thing the panel is holding open.
 *
 * Carries what is needed to DRAW it and to address the server about it, and nothing that can be read
 * back out of the database: a record card holds the label the row that was clicked was showing, so
 * the card has a title from the instant it appears rather than after its fetch lands, and the detail
 * carries the record as it stands now for the panel to prefer once it has one.
 */
export type Card = {
  readonly kind: "record";
  readonly table: RecordTable;
  readonly id: string;
  readonly label: string;
};

/** How a card is addressed. See the header: a map key, never parsed. */
export type CardKey = string;

/**
 * What a card is called.
 *
 * Exported because the store addresses cards it did not just build — the report that was published,
 * the record a rename or a deletion moved — and computing the name from the card is the only way
 * those callers avoid keeping a second index from records to keys.
 *
 * A SWITCH OVER ONE MEMBER, deliberately. It is what makes a second kind of card a compile error
 * here — the one place a key is minted — rather than a card that quietly shares a key with a record
 * of the same id.
 */
export function cardKey(card: Card): CardKey {
  switch (card.kind) {
    case "record":
      return `record:${card.table}:${card.id}`;
  }
}

// -- the state ------------------------------------------------------------------------------------

/**
 * What a read presents to prove it is still the read the card is waiting for.
 *
 * A symbol, and see the header for why nothing else will do: it is equal to nothing but itself, so
 * there is no value in the window — a revision, a nonce, an id — that can be handed over here and
 * accidentally match.
 */
export type ReadToken = symbol;

/** Mint one. Called by whoever is about to start a read, and handed back with the answer. */
export function newToken(): ReadToken {
  return Symbol("card read");
}

/**
 * Whether the reader is being shown that a read is happening.
 *
 * `shown` is somebody who asked — they opened the card, or pressed ↻ — and a spinner is the honest
 * answer while the request is out. `quiet` is the half-second refresh that fires after the database
 * moved: it happens to every open record card several times a minute, and a panel that flickered
 * through "loading" on each of them would be unreadable exactly while the agent was working.
 */
export type ReadStyle = "shown" | "quiet";

/** One open card: what it is, how its reading went, and the two counters that are not about reading. */
export type CardState = {
  /** The key in `cards`, repeated here so an entry stands alone — the panel maps over the values. */
  readonly key: CardKey;
  readonly card: Card;
  /** The read this card is waiting for. See the header. */
  readonly token: ReadToken;
  /** The record as it stands, once a read landed. Null on a card that has never been answered. */
  readonly detail: RecordDetail | null;
  readonly loading: boolean;
  /** Why this card's body is not on screen, in the card and never as a toast. */
  readonly error: string | null;
  /** Bumped when a report is republished under this id, so the panel's `<iframe>` key moves. */
  readonly nonce: number;
};

export type CardsState = {
  /** INSERTION ORDER IS STACK ORDER, top to bottom. Overwriting an entry keeps its place, which is
   * what makes an answer landing on the first card leave it where the reader put it. */
  readonly cards: ReadonlyMap<CardKey, CardState>;
  /** The card the panel scrolls to and marks — the one the last gesture was about. Null before the
   * first card is opened, and again the moment that card is closed. */
  readonly focused: CardKey | null;
};

const NO_CARDS: ReadonlyMap<CardKey, CardState> = new Map();

export function createCardsState(): CardsState {
  return { cards: NO_CARDS, focused: null };
}

/** One card, or null when it is not open. The guard every answer arriving from the network runs
 * first. */
export function cardAt(state: CardsState, key: CardKey): CardState | null {
  return state.cards.get(key) ?? null;
}

export function isOpen(state: CardsState, key: CardKey): boolean {
  return state.cards.has(key);
}

/** The stack, top to bottom. What the panel draws and what the refresh loop walks. */
export function cardStack(state: CardsState): CardState[] {
  return [...state.cards.values()];
}

/**
 * Replace one card in place.
 *
 * `set` on a key that is already present keeps its position in the map, and that is the whole reason
 * every mutation here goes through this function: a card that answers is a card that must not move.
 */
function withCard(state: CardsState, next: CardState): CardsState {
  const cards = new Map(state.cards);
  cards.set(next.key, next);
  return { ...state, cards };
}

// -- opening, closing, focusing -------------------------------------------------------------------

/**
 * Put a card on the stack, or focus the one that is already there.
 *
 * The dedupe is the gesture's meaning: opening a record that is already open is somebody saying
 * "that one", not asking for a second copy of it. The held card is kept exactly as it is — its
 * detail, its error and its place in the stack — because everything a second open could bring is
 * either already on screen or about to be confirmed by the read the store starts anyway.
 *
 * A fresh card is given a token NOBODY IS HOLDING, which is what makes close-then-reopen safe: the
 * read that was in flight when the card closed cannot land on the card that replaced it.
 *
 * Opening a record and reading it happen in ONE breath at the call site —
 * `beginRead(openCard(state, card), key, token)` — so the card never draws a blank body in the gap
 * between appearing and being asked about. This function stays out of that all the same: putting a
 * card on the stack and asking the server about it are two facts, and a module that did both would
 * have no way to express the first without the second.
 */
export function openCard(state: CardsState, card: Card): CardsState {
  const key = cardKey(card);
  if (state.cards.has(key)) return focus(state, key);
  const cards = new Map(state.cards);
  cards.set(key, {
    key,
    card,
    token: newToken(),
    detail: null,
    loading: false,
    error: null,
    nonce: 0,
  });
  return { cards, focused: key };
}

/**
 * Take a card off the stack.
 *
 * THE FOCUS GOES WITH IT when it was on this card, and does not move to a neighbour. Sliding it
 * sideways would scroll the panel to a card nobody asked about and mark it as the thing the last
 * gesture was about, which is a lie: the last gesture was a close. Nothing is focused until the
 * reader opens or touches something.
 *
 * Closing loses nothing, and no longer has to say so carefully: a card is a reading, so taking one
 * off the stack is purely a fact about the screen.
 */
export function closeCard(state: CardsState, key: CardKey): CardsState {
  if (!state.cards.has(key)) return state;
  const cards = new Map(state.cards);
  cards.delete(key);
  return { cards, focused: state.focused === key ? null : state.focused };
}

/**
 * Mark the card the last gesture was about, or nothing at all.
 *
 * A key that is not open is ignored rather than stored: focus is drawn by finding that card in the
 * stack, and a focus on a card that closed while its answer was in flight would mark nothing and
 * scroll nowhere while claiming the panel was pointing somewhere.
 */
export function focus(state: CardsState, key: CardKey | null): CardsState {
  if (state.focused === key) return state;
  if (key !== null && !state.cards.has(key)) return state;
  return { ...state, focused: key };
}

// -- reading ---------------------------------------------------------------------------------------

/**
 * This card is being read.
 *
 * The token replaces whatever the card was holding, so the newer read wins and the older answer is
 * dropped when it arrives — a reader who presses ↻ twice sees the second answer, not whichever
 * request the network happened to finish last.
 *
 * `quiet` leaves both the spinner and the standing error alone: the refresh nobody asked for must not
 * flash the card, and must not blank the sentence explaining why the card is empty only to write the
 * same sentence back half a second later. Whatever detail is in hand stays on screen under either
 * style — a card that emptied itself while it refreshed would blink out from under the cursor twice a
 * second while the agent worked.
 */
export function beginRead(
  state: CardsState,
  key: CardKey,
  token: ReadToken,
  style: ReadStyle = "shown",
): CardsState {
  const held = state.cards.get(key);
  if (held === undefined) return state;
  return withCard(state, {
    ...held,
    token,
    loading: style === "shown" ? true : held.loading,
    error: style === "shown" ? null : held.error,
  });
}

/**
 * The record came back.
 *
 * Dropped on a card that has closed, and on one that has been read again since — the two cases the
 * token exists for, and they are checked in that order because a card that is gone has no token to
 * check. A read is not cancelled by closing a card; the request is in flight and its answer arrives
 * regardless, and letting it land would put a card the reader deliberately closed back on the stack.
 */
export function landDetail(
  state: CardsState,
  key: CardKey,
  token: ReadToken,
  detail: RecordDetail,
): CardsState {
  const held = state.cards.get(key);
  if (held === undefined || held.token !== token) return state;
  if (held.detail === detail && !held.loading && held.error === null) return state;
  return withCard(state, { ...held, detail, loading: false, error: null });
}

/**
 * The read failed, and the card says so.
 *
 * Same two guards, and the detail already in hand is kept: see the header on why a card showing a
 * refusal has not forgotten what it was showing before.
 *
 * A REPEAT OF THE SAME SENTENCE RETURNS THE STATE UNCHANGED, which is not a micro-optimisation. The
 * refresh fires against every open card twice a second; a record deleted out from under one of them
 * fails identically every time, and a new state object per failure would redraw the whole stack for
 * as long as the reader left that card open.
 */
export function failRead(
  state: CardsState,
  key: CardKey,
  token: ReadToken,
  message: string,
): CardsState {
  const held = state.cards.get(key);
  if (held === undefined || held.token !== token) return state;
  if (!held.loading && held.error === message) return state;
  return withCard(state, { ...held, loading: false, error: message });
}

/**
 * New bytes arrived for this card's document.
 *
 * Ignored on a card that is not open, because the frame that causes it — a report finishing —
 * arrives whether or not anybody has that report on screen, and the store opens the card first.
 */
export function bumpNonce(state: CardsState, key: CardKey): CardsState {
  const held = state.cards.get(key);
  if (held === undefined) return state;
  return withCard(state, { ...held, nonce: held.nonce + 1 });
}
