/**
 * The session list's model: every conversation this installation has had, newest first, with the one
 * that is live pinned to the top.
 *
 * PURE and DOM-FREE, like `state/cards.ts` and `state/logs.ts` and for the same reason — `bun test`
 * drives it directly under the root tsconfig. It is a small module because there is little to decide:
 * the SDK owns the history, the server reads it off disk, and this window's whole contribution is an
 * ORDER and an identity discipline. Both matter more than their size suggests, and the reason is
 * below.
 *
 * THE LIST IS REFRESHED SEVERAL TIMES A TURN. `sessions_changed` fires when a session is minted, when
 * a turn finishes and its summary moves, and when the reader resumes or clears; `ready` and
 * `turn_result` refetch it too, and the events socket refetches on reconnect. Almost none of those
 * refreshes change anything a person can see — a summary is written once and then stays — and the
 * list is a column of clickable rows that a reader is aiming at while all this happens. So the rule
 * this module exists to enforce is that a landing which changed nothing returns the SAME state, and a
 * landing which renamed one session returns the same row objects for every session it did not rename.
 * A list rebuilt from scratch on every poke is a list whose rows re-render under the cursor twice a
 * minute, and the click that lands during one of those is the reader losing their place in a
 * conversation.
 *
 * THE LIVE SESSION IS PINNED, NOT SORTED. It is the conversation on screen, and it is the one row in
 * the list whose meaning is different: clicking any other row switches conversations, and clicking
 * this one does nothing but open the window that is already showing it. It also has the least reliable
 * `lastModified` of any of them — the SDK writes its JSONL on its own cadence, and the server
 * SYNTHESISES a row for a session that has not been flushed at all yet — so sorting it with the rest
 * would let the row the reader is talking in drift down the list mid-turn, on the strength of a
 * timestamp nobody promised. Pinning is the honest answer: the live conversation is first because it
 * is the live conversation, not because it is the most recent.
 *
 * SORTING HERE RATHER THAN TRUSTING THE WIRE. The route already answers newest-first with the live
 * session prepended, and this module sorts anyway — not from suspicion, but because the ORDER IS A
 * PROPERTY OF THE LIST and this is where the list is defined. A panel that got its order from
 * whichever caller happened to fill the state would be a panel whose order is a fact about the store,
 * and the tie-break below could not live anywhere at all.
 */

import type { SessionCard } from "../lib/protocol.ts";

export type SessionsState = {
  /** LIVE FIRST, then newest-modified first. Never re-sorted by the panel that draws it. */
  readonly list: readonly SessionCard[];
  readonly loading: boolean;
  /** Why the list is empty or stale, drawn in the read-out itself — never as a toast, which would
   * expire while the empty panel it explained stayed on screen. */
  readonly error: string | null;
};

const NO_SESSIONS: readonly SessionCard[] = [];

export function createSessionsState(): SessionsState {
  return { list: NO_SESSIONS, loading: false, error: null };
}

/**
 * A read has started.
 *
 * The rows already held stay on screen and the standing error goes. The list is refetched constantly
 * and mostly answers the same thing; a panel that emptied itself or flashed a spinner on each of those
 * would be unreadable exactly while the agent was working, which is when somebody is watching it.
 */
export function beginLoad(state: SessionsState): SessionsState {
  if (state.loading && state.error === null) return state;
  return { ...state, loading: true, error: null };
}

/**
 * The read failed.
 *
 * The held rows stay: a list that cannot be refreshed is still a true list of the sessions that
 * existed a moment ago, and blanking it would take away the one way back into a conversation at
 * exactly the moment the server is unwell. A repeat of the same sentence returns the state unchanged —
 * the refetch fires on reconnect attempts, and a new object per failure would redraw the panel for as
 * long as the server stayed down.
 */
export function failLoad(state: SessionsState, message: string): SessionsState {
  if (!state.loading && state.error === message) return state;
  return { ...state, loading: false, error: message };
}

/** Live first; then newest modified first; then by id, so two sessions flushed in the same
 * millisecond cannot swap places between two refreshes and move a row under the pointer. */
function order(a: SessionCard, b: SessionCard): number {
  if (a.live !== b.live) return a.live ? -1 : 1;
  if (a.lastModified !== b.lastModified) return b.lastModified - a.lastModified;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/** Whether two readings of one session say the same thing. Every field, because every field is drawn
 * or clicked: the summary is the row's text, `lastModified` is its age, and `live` is the marker and
 * the pin. */
function same(a: SessionCard, b: SessionCard): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.summary === b.summary &&
    a.createdAt === b.createdAt &&
    a.lastModified === b.lastModified &&
    a.live === b.live
  );
}

/**
 * The list came back.
 *
 * Ordered here, and then reconciled against what is held ROW BY ROW: a session that reads the same as
 * the one already in hand keeps the object it already had, so a refresh that renamed one conversation
 * hands the panel one new row and fifteen old ones. If every row survives that and the order is
 * unchanged, the state itself is returned — which is the common case several times a turn, and the
 * whole point of the exercise.
 *
 * The server's answer is taken as the complete list, so a session it no longer names is gone from
 * here. That is the honest reading of this route: it lists a directory rather than a page of one, and
 * there is no `hasMore` to hedge with.
 */
export function landSessions(
  state: SessionsState,
  sessions: readonly SessionCard[],
): SessionsState {
  const next = [...sessions].sort(order);
  const held = new Map(state.list.map((card) => [card.sessionId, card]));
  const reconciled = next.map((card) => {
    const before = held.get(card.sessionId);
    return before !== undefined && same(before, card) ? before : card;
  });
  const unmoved =
    reconciled.length === state.list.length &&
    reconciled.every((card, index) => card === state.list[index]);
  if (unmoved && !state.loading && state.error === null) return state;
  return { list: unmoved ? state.list : reconciled, loading: false, error: null };
}
