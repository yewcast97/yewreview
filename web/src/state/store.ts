/**
 * The one store. Everything the window knows lives here, and every panel reads it through
 * `useStore(selector)`.
 *
 * Hand-rolled over `useSyncExternalStore`, with no query library. That is a deliberate trade rather
 * than an omission: this app already has a push channel that says exactly when server state has
 * moved — `tool_end`, `report_published`, `turn_result`, and `records_changed` on the events socket
 * — so cache invalidation is a switch statement over frames rather than a policy about staleness. A library's refetch
 * heuristics would be a second, weaker answer to a question the socket already answers precisely.
 *
 * ONE MUTATION RULE: `state` is replaced, never edited. Every slice is a new object when it changes
 * and the SAME object when it does not, which is what makes `useStore((s) => s.cards)` re-render
 * the record panel and nothing else.
 *
 * ONE SELECTOR RULE, and violating it hangs the tab: **a selector must return something stable.**
 * `useStore((s) => s.graph)` is right; `useStore((s) => ({ ...s.graph }))` and
 * `useStore((s) => s.toasts.filter(…))` are wrong — they mint a new value on every call, and
 * `useSyncExternalStore` compares snapshots by identity. Derive inside the component from the slice
 * the selector returned.
 *
 * The store also owns the SINGLE chat socket. One per window, and one per INSTALLATION: there is
 * one process-lifetime agent behind `/ws/chat` with no id in the URL, so opening the chat is opening
 * a window onto a conversation that was already happening rather than starting one. Every panel wants
 * its frames, so they are fanned out from here to the slices that care.
 *
 * THE CONVERSATION IS NOT THIS WINDOW'S TO KEEP, and that is what every awkward line below is
 * paying for. The agent SDK owns the history: it names sessions, folds them into summaries when they
 * grow, and hands one back whole when asked by id. So this store never assembles a transcript out of
 * frames and never pages one — it learns the session's id from `ready`, fetches that conversation
 * entire, and refetches it whenever a turn ends. `chat.sessionId` changing is the ONE trigger for a
 * fetch, which is why connecting the socket does not start one: there is nothing to ask for until
 * the socket says what it is attached to.
 *
 * NOTHING IN THIS FILE WRITES A RECORD, and that is the largest single fact about it. There is no
 * `createWorkshop`, no `savePlaybookVersion`, no `renameRecord` and no delete: every change to the
 * archive is asked for in the CONVERSATION, and the agent writes the row with its own tools once the
 * reader has seen what it is about to write. So the `+` buttons and the Bin do not open forms and do
 * not call routes to write anything — they send a sentence, which is an ordinary user message and
 * reads as one in the transcript. `lib/awareness.ts` holds the sentences.
 *
 * EVERY ONE OF THEM SPEAKS WHERE THE READER IS STANDING, through `sendAwareness`. Four used to go
 * through a `startCreation` that put the current conversation down and opened a fresh one for the
 * opening line — on the argument that a creation is a piece of work with a beginning and an end. The
 * cost landed on the reader, who was mid-thought when they pressed the button; the report `+` and
 * the Bin never moved, and now nothing does.
 *
 * WHAT IS LEFT THAT THIS STORE DOES WRITE is the installation and the conversation, never a claim
 * about the world: the model pool (a credential file rather than a table), the venv retry, and which
 * session the next turn belongs to. Generating a report was on that list — the one authority this
 * window was said to hold and the agent did not — and it moved to the conversation with everything
 * else: the report box's `+` sends a sentence like every other `+`, and the agent opens the
 * procedure itself. What holds a report's provenance up was never which side of the socket the
 * request came from.
 *
 * NO UNFINISHED WRITING LIVES HERE EITHER, and its absence is a decision rather than a
 * simplification. Drafts are not server state: nothing is held on the SERVER for the agent to read,
 * saved per keystroke against the revision it was written on, leased while a cursor sits in it, or
 * committed by the one person allowed to. There is nothing to lease, because there is no document
 * two writers have their hands on — the reader says what they want and the agent writes it, and a
 * conversation needs no revision arithmetic.
 *
 * TWO SLICES ARE READ-ONLY MIRRORS OF THINGS THIS WINDOW DOES NOT OWN: the session list, which is
 * a directory the SDK writes on its own cadence, and the two logs, which are capped ledgers on the
 * server. Both are refreshed by bodyless pokes on the events socket — the frame says something moved
 * and nothing about what — and the pure modules behind them (`state/sessions.ts`, `state/logs.ts`)
 * exist so that "nothing actually changed" costs no re-render, which is the common case several times
 * a turn.
 */

import { useSyncExternalStore } from "react";

import * as api from "../lib/api.ts";
import type { Health, RecordCard, RecordTable } from "../lib/api.ts";
import { ApiError, isAbort } from "../lib/api.ts";
/** The sentences a press says on the reader's behalf. See `lib/awareness.ts`: they are ordinary user
 * messages, which is the whole mechanism by which a `+` writes anything. */
import { binDrop } from "../lib/awareness.ts";
import type { ComposerChip } from "../lib/outgoing.ts";
import { chipKey, serializeOutgoing } from "../lib/outgoing.ts";
import { DEFAULT_GROUP, MAX_GROUP, expands } from "../lib/records.ts";
import type { EffortLevel, EventsFrame, OutboundFrame } from "../lib/protocol.ts";
import type { ChatState } from "./chat.ts";
import {
  adoptTranscript,
  agentWorking,
  appendUserMessage,
  applyFrame,
  clearError,
  connectionLost,
  createChatState,
  takeRefusedText,
} from "./chat.ts";
import type { ViewTransform } from "../lib/graphView.ts";
import { IDENTITY_VIEW, scaleAboutOrigin } from "../lib/graphView.ts";
import type { GraphState, NodeOffset, NodePath, RootTable } from "./graph.ts";
import {
  ROOT_TABLES,
  beginRoot,
  createGraphState,
  expand,
  expandedPaths,
  extendGroup,
  extendRoot,
  fail,
  failRoot,
  fold,
  isExpanded,
  land,
  mergeExpansion,
  mergeRoot,
  rootOf,
  select,
  setOffset,
  shownLimit,
} from "./graph.ts";
import type { EventsClient } from "./events.ts";
import { createEventsClient } from "./events.ts";
/**
 * The record panel's stack, imported name by name like the graph's — with two renames. `closeCard`
 * keeps its name as this file's ACTION (a card is closed from a component, and the pure function is
 * one step of that), so the pure one arrives as `removeCard`; `focus` is aliased because a bare
 * `focus` in a module that also talks to the DOM's own is a word that means two things.
 */
import type { Card, CardKey, CardsState, ReadToken } from "./cards.ts";
import {
  beginRead,
  bumpNonce,
  cardAt,
  cardKey,
  cardStack,
  closeCard as removeCard,
  createCardsState,
  failRead,
  focus as markFocused,
  landDetail,
  newToken,
  openCard,
} from "./cards.ts";
/** The two read-out slices, both pure, both already argued in their own headers. `beginPage`/
 * `failPage` and `beginLoad`/`failLoad` say the same thing about different ledgers and are imported
 * under their own names, because the one thing that would make them confusable is calling them the
 * same. */
import type { LogCategory, LogsState } from "./logs.ts";
import {
  appendOlder,
  beginPage,
  createLogsState,
  failPage,
  landHead,
  noteLogged,
  setLogView,
} from "./logs.ts";
/** Where each open note sits on the board, and how it is dressed. A slice of its own rather than a
 * field of `cards`, for the reason `state/notes.ts` argues: geometry moves sixty times a second
 * while a note is dragged, and a card's state object moving that often would redraw every open
 * editor on the board. */
import type { NotePlace, NotesState, Rect } from "./notes.ts";
import {
  clampNotes,
  createNotesState,
  dropNote,
  moveNote,
  overRect,
  placeNote,
  raiseNote,
  scaleNotes,
  sizeNote,
  sizeNoteAt,
} from "./notes.ts";
/**
 * The model pool and the role slots, which exist on one harness. Imported name by name like the
 * graph's, with the hot-slot writer renamed: `setSlotHot` is this file's ACTION — a component lights
 * a slot from a drag, and the pure function is one step of that — so the pure one arrives as
 * `markSlotHot`, exactly as `cards.focus` arrives as `markFocused` above.
 */
import type { OpencodeState } from "./opencode.ts";
import {
  addedModel,
  assignedRole,
  beginPoolRead,
  clearedRole,
  createOpencodeState,
  failPoolRead,
  landPool,
  modelLabel,
  removedModel,
  setPoolOpen,
  setSlotHot as markSlotHot,
  updatedModel,
} from "./opencode.ts";
/** What every record the window has seen is CALLED, so nothing shows the reader a uuid. */
import type { NameIndex } from "./names.ts";
import {
  createNameIndex,
  isMissing,
  lookupId,
  markMissing,
  nameKey,
  rememberCards,
} from "./names.ts";
import type { RecordPayload, SessionPayload } from "../lib/dragPayload.ts";
import type { Box } from "./chatDock.ts";
import { DEFAULT_SPLIT, clampSplit, dockRect } from "./chatDock.ts";
import type { SessionsState } from "./sessions.ts";
import { beginLoad, createSessionsState, failLoad, landSessions } from "./sessions.ts";
import type { ConnectionState } from "./ws.ts";
import { ChatSocket } from "./ws.ts";

// -- the shape ------------------------------------------------------------------------------------

export type Toast = {
  id: number;
  text: string;
  /** The server's own wording, kept on its own line and never merged into the sentence above it. */
  detail: string | null;
};

export type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
};

/*
 * THERE IS NO WORKSHOP LIST IN THIS STATE, and its going is worth a line because three fields left
 * together. `workshops`, `workshopsLoading` and `workshopsError` were fetched from `GET
 * /api/workshops`, refreshed several times a turn, and READ BY NOTHING — the record browser already
 * had every workshop as a row, and a workshop is edited as a record like any other. The route has
 * gone from the server, so what was written-and-never-read is now unwritable as well.
 *
 * The rule those fields were kept for still holds everywhere it applies: **a failed read must never
 * render as an empty answer.** A toast says what went wrong and then expires; the pane it was about
 * goes on saying "nothing here yet", which is a claim about the database this window cannot back. So
 * every list that CAN come back empty carries why beside it — `transcriptError`, the graph (one
 * `error` per root box and one per opened node inside it), one per open card in `cards`, one on the
 * session list, and one per ledger in `logs`.
 */

export type AppState = {
  health: Health | null;
  /*
   * THE CONVERSATION DOCK HOLDS ONE NUMBER HERE AND NOT A FIELD MORE, and how short that list is,
   * is the design rather than an omission. Three of its edges are a rule — the glass, top to bottom,
   * inset by the float margin — so there is no open flag, no position and no height for the reader
   * to own; the fourth is the boundary with the board, and `dockSplit` below is the whole of what a
   * reader can say about it. `state/chatDock.ts` derives the rectangle from that number and the
   * viewport, and a floating window's worth of posture is still nothing this dock has to hold.
   * WHICH conversation the agent is in is not held here either: it arrives on `ready` as
   * `chat.sessionId`, and a copy would be a second answer to a question the socket already answers.
   */
  /**
   * Every conversation this installation has had, live one first.
   *
   * A MIRROR OF SOMEBODY ELSE'S DIRECTORY, which is what makes the identity discipline in
   * `state/sessions.ts` worth having: the list is refetched several times a turn — on
   * `sessions_changed`, on `ready`, on `turn_result`, on the events socket reconnecting — and almost
   * none of those refreshes change anything a person can see. The rows are also the one column of
   * clickable targets in the window that a reader is aiming at while all that happens.
   */
  sessions: SessionsState;
  /**
   * The two capped ledgers, and whether the reader is looking at them.
   *
   * The pages, the nonces and the grouping are `state/logs.ts`'s and are argued there; what lives
   * here is the fetching. Both ledgers are on the server, both are announced by bodyless pokes, and
   * neither is a record — nothing in the archive points at a log row, which is precisely why they
   * outlive the things they describe.
   */
  logs: LogsState;
  connection: ConnectionState;
  chat: ChatState;
  /**
   * The generation procedure the agent is running, or null.
   *
   * FRAME-DRIVEN AND NOW ONLY FRAME-DRIVEN. It used to be seeded from the 202 that started a
   * procedure as well, because this window started them and would otherwise have offered a second
   * one in the gap before the frame arrived. Nothing here starts one now, so the frames are the
   * whole story: `generation_started` sets it, `generation_ended` clears it whatever the reason,
   * including the endings nobody asked for.
   *
   * THE PINNED VERSION IS NOT HERE ANY MORE, and it left the FRAME in the same edit — see
   * `generation_started` in `src/protocol/types.ts`. Nothing drew a version number even then, so
   * carrying one here would be state kept warm for a sentence nobody writes. What is left is
   * exactly what the two readers ask: is a procedure running, and which one.
   */
  generation: { id: string } | null;
  /** Why the transcript is empty, when it is empty because the read failed. */
  transcriptError: string | null;
  /**
   * What is TYPED in the composer, and nothing else.
   *
   * A plain string, and keeping it one is what keeps the textarea a textarea. Everything a browser
   * does for a text box for free — a caret the user aimed at, a native undo entry, a real `input`
   * event, a plain-text drop from any other window landing exactly where it was aimed — is available
   * only to a control this app has not taken over. A record is the ONE drag that is intercepted, and
   * it does not land in here at all: it becomes a chip in `composerChips` beside these words. See
   * the header of `Composer.tsx` for the one-MIME-type test that separates the two.
   *
   * Held in the store rather than in the component so the `busy` refusal's hand-back — words that
   * never entered the server's queue — is a fact of the store rather than a component watching a
   * field for a value to appear.
   */
  composer: string;
  /**
   * The records riding along with what is being typed, drawn as chips above the box.
   *
   * BESIDE the text rather than inside it. A mention written into the middle of a paragraph can only
   * be taken back out by editing the paragraph, and it looks like grammar in a sentence somebody is
   * still composing; a chip is a thing with a name and an ×. It also keeps where a record lands
   * independent of where the caret is: text spliced into a draft has a position to argue about and a
   * chip does not.
   *
   * They live exactly as long as the draft does. `serializeOutgoing` flattens them into the message
   * at the moment of sending and nothing downstream ever hears of a chip; see `lib/outgoing.ts` for
   * why the wire carries one grammar rather than two channels saying the same thing.
   */
  composerChips: readonly ComposerChip[];
  /**
   * The node graph over the whole database, and the one slice a change of conversation does NOT
   * reset.
   *
   * It is app-level on purpose. The graph draws the four starting tables as its first column and
   * walks outwards from any row of them, so it is a picture of the database rather than of the
   * conversation; narrowing it to whatever is being talked about would delete the only view this
   * window has of how one recipe's records join another's. The conversation dock beneath it
   * never touches this slice.
   */
  graph: GraphState;
  /**
   * Where the reader is standing over that graph: the pan and the zoom.
   *
   * A slice of its own and NOT a field of `graph`, which is the only reason a pan is affordable.
   * `GraphPanel` memoizes `layoutGraph` on the graph slice's identity, so a transform written in
   * there would recompute every box's coordinates on every pointer event of a gesture that moves no
   * box at all — sixty full relayouts a second to translate one CSS transform. The two facts change
   * at completely different rates, so they get different identities.
   */
  graphView: ViewTransform;
  /**
   * The right column: everything the reader has open, in the order they opened it.
   *
   * A STACK RATHER THAN ONE CURSOR, and the rules about it — insertion order, the per-card read
   * token, the two kinds of card — are `state/cards.ts`'s and are argued there. What is left here is
   * the fetching.
   *
   * It is deliberately NOT a part of the graph. Opening a row over there EXPANDS it, so a record
   * read whole has nowhere to live in that panel without one gesture meaning two things; the centre
   * column walks the keys and this one holds what was found — and "what was found" is plural.
   */
  cards: CardsState;
  /**
   * Where each of those cards is pinned to the board, and which one is in front.
   *
   * A SEPARATE SLICE FROM `cards`, and `state/notes.ts` argues why at length: that module's identity
   * discipline is about network races and this one's is about a drag at sixty hertz, so threading a
   * moving `x` through a card's state object would replace it — and redraw every open editor under
   * it — on every pointer event. The store keeps the two maps in step: a card opened is placed, a
   * card closed is dropped.
   */
  notes: NotesState;
  /**
   * Where the conversation dock's left edge sits, as a fraction of the window's width.
   *
   * A BARE SCALAR AND NOT A SLICE, for the reason `binHot` beside it is one: a one-field object
   * would mint an identity for nothing and give a subscriber a new snapshot on every frame of a
   * drag that changed one number. `state/chatDock.ts` owns what the number MEANS — the split, the
   * bounds it is clamped to, and the rectangle derived from it — and this is only where it is held.
   *
   * SESSION-ONLY, AND NEVER WRITTEN TO `localStorage`. This window persists no view state anywhere —
   * not the pan, not the zoom, not which nodes are expanded, not where a note was dragged — and a
   * dock that alone came back from a previous visit would start a reader somewhere they did not put
   * themselves, which is worse than starting them at the midline every time.
   */
  dockSplit: number;
  /**
   * Whether something is being held over the Bin.
   *
   * ONE FLAG, TWO GESTURES, and that is the whole reason it is in the store rather than in
   * `Ledgers.tsx`. A record row is dragged with the browser's own drag-and-drop and the Bin's
   * `dragover` sees it; a NOTE is dragged with a captured pointer, which fires no drop events at all,
   * so its handler hit-tests the Bin's rectangle itself. Two different mechanisms have to light one
   * highlight, and the only thing they can both write to is here.
   */
  binHot: boolean;
  /**
   * What every record this window has seen is called.
   *
   * A DIRECTORY AND NEVER AN AUTHORITY, and it runs from a name to an id. A name is what travels — a
   * mention is `@table:name`, and `src/repo/naming.ts` is explicit that a name is how a row is
   * ADDRESSED, unique within its table and turned back into an id by `resolveRecordId` — so a pill
   * already holds the word it draws and needs nothing from here to show it. What it does not hold is
   * an id, which most of this window's read routes want — so this is the short path from a press to
   * a card, and `openNamedRecord` asks the server for the record BY NAME when the directory misses.
   * It fills itself from cards the window was already receiving; see `state/names.ts`.
   */
  names: NameIndex;
  /**
   * The model pool, and which model answers in which of opencode's roles.
   *
   * ONE HARNESS ONLY, and on the other one this slice sits at its initial value for the life of the
   * window: the routes behind it are not mounted on the Claude path and none of the controls that
   * read it are drawn. A second store switched on the harness would be two windows to maintain for
   * a handful of controls; an untouched slice costs a pointer.
   *
   * It is CONFIGURATION rather than a record table, which is the whole reason it is fetched the way
   * it is — twice, and never polled. `state/opencode.ts` argues that at length.
   */
  opencode: OpencodeState;
  toasts: Toast[];
  confirm: ConfirmRequest | null;
};

function initialState(): AppState {
  return {
    health: null,
    generation: null,
    sessions: createSessionsState(),
    logs: createLogsState(),
    connection: "idle",
    chat: createChatState(),
    transcriptError: null,
    composer: "",
    composerChips: [],
    graph: createGraphState(),
    graphView: IDENTITY_VIEW,
    cards: createCardsState(),
    notes: createNotesState(),
    dockSplit: DEFAULT_SPLIT,
    binHot: false,
    names: createNameIndex(),
    opencode: createOpencodeState(),
    toasts: [],
    confirm: null,
  };
}

// -- the store ------------------------------------------------------------------------------------

let state = initialState();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  // Copied because a listener is allowed to unsubscribe itself while being notified.
  for (const listener of [...listeners]) listener();
}

/** Read a slice. See the selector rule in this file's header — return the slice, not a derivation. */
function useStore<T>(selector: (snapshot: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export const useHealth = (): Health | null => useStore((s) => s.health);
export const useConnection = (): ConnectionState => useStore((s) => s.connection);
export const useChat = (): ChatState => useStore((s) => s.chat);
export const useTranscriptError = (): string | null => useStore((s) => s.transcriptError);
export const useComposer = (): string => useStore((s) => s.composer);
export const useComposerChips = (): readonly ComposerChip[] => useStore((s) => s.composerChips);
export const useGraph = (): GraphState => useStore((s) => s.graph);
export const useGraphView = (): ViewTransform => useStore((s) => s.graphView);
/** Everything the record panel is holding open. The whole slice, per the selector rule — the panel
 * walks it with `cardStack` and each card picks itself out of it. */
export const useCards = (): CardsState => useStore((s) => s.cards);
/**
 * Where ONE note sits, subscribed to per note.
 *
 * The exception that proves the selector rule rather than a violation of it: this returns the stored
 * `NotePlace` object itself, which `state/notes.ts` guarantees is the same object for a note that has
 * not moved. That is the whole point — a drag replaces one entry in the map, so exactly one note
 * re-renders per frame instead of every note on the board.
 */
export const useNotePlace = (key: CardKey): NotePlace | null =>
  useStore((s) => s.notes.placed.get(key) ?? null);
/** Whether something is being held over the Bin. Read by the one instrument that lights up. */
export const useBinHot = (): boolean => useStore((s) => s.binHot);
/** Where the conversation's left edge sits, as a fraction of the window. Read by the dock alone —
 * which is also what makes the dock follow the grip: this is the subscription that re-renders it
 * mid-gesture, where before only a window resize could move it. */
export const useDockSplit = (): number => useStore((s) => s.dockSplit);
/** The generation procedure in progress, or null. Read by the composer, which will not let the
 * model, the effort or the subagent setting be changed out from under a report being written. */
export const useGeneration = (): AppState["generation"] => useStore((s) => s.generation);
/** Every conversation this installation has had. The whole slice, per the selector rule: the panel
 * walks `list` and picks the live one out of it, and a selector that did the picking would mint a new
 * value on every call and hang the tab. */
export const useSessions = (): SessionsState => useStore((s) => s.sessions);
/** Both ledgers and the two nonces, in one slice for the same reason: the button reads the nonces,
 * the viewer reads the pages, and neither may derive inside the selector. */
export const useLogs = (): LogsState => useStore((s) => s.logs);
/** The model pool and the role assignments. The whole slice, per the selector rule: the panel walks
 * `models`, each slot picks its own assignment out of it with `assignmentFor`, and a selector that
 * did the picking would mint a new value on every call and hang the tab. */
export const useOpencode = (): OpencodeState => useStore((s) => s.opencode);
export const useToasts = (): Toast[] => useStore((s) => s.toasts);
export const useConfirm = (): ConfirmRequest | null => useStore((s) => s.confirm);

// -- toasts ---------------------------------------------------------------------------------------

/**
 * Everything that surfaces here is a fact about a request the reader can act on — the agent is
 * still working, that recipe is unchanged, the server is not answering. There is one style and
 * no error variant on purpose: a refusal is not a malfunction, and dressing one in red teaches
 * people to distrust the parts of this app that are working correctly.
 */
const TOAST_MS = 6_000;
let toastSeq = 0;

function pushToast(text: string, detail: string | null = null): number {
  toastSeq += 1;
  const id = toastSeq;
  set({ toasts: [...state.toasts, { id, text, detail }] });
  setTimeout(() => dismissToast(id), TOAST_MS);
  return id;
}

export function dismissToast(id: number): void {
  const remaining = state.toasts.filter((toast) => toast.id !== id);
  if (remaining.length !== state.toasts.length) set({ toasts: remaining });
}

/** Report a failure as a toast, in the server's own words. An abort is not a failure and is
 * swallowed; anything else keeps its message, because that message is what says how to repair it. */
function reportFailure(what: string, cause: unknown): void {
  const detail = messageFor(cause);
  if (detail !== null) pushToast(what, detail);
}

/** The server's own sentence about a failure, or null when the request was one this app withdrew.
 * What the panes that must not render a failed read as an empty answer put beside their heading. */
function messageFor(cause: unknown): string | null {
  if (isAbort(cause)) return null;
  return cause instanceof ApiError ? cause.message : String(cause);
}

// -- confirmation ---------------------------------------------------------------------------------

let confirmResolve: ((ok: boolean) => void) | null = null;

/**
 * Ask before doing something that cannot be undone. Awaited rather than given a callback, so the
 * caller reads as one sentence: `if (await requestConfirm(…)) await savePool(…)`.
 *
 * ONE CALLER, AND IT IS `deleteModel`. The Bin used to ask before every deletion; the Bin does not
 * delete anything now — it says a sentence in the conversation, where the reader can see what would
 * go with a row before agreeing to it — so the only irreversible act left in this window is taking a
 * model out of the pool, which destroys the one copy of a credential and has no ledger behind it.
 *
 * A second request while one is open resolves the first as cancelled — two stacked modals would
 * leave the reader confirming something they can no longer see.
 */
export function requestConfirm(request: ConfirmRequest): Promise<boolean> {
  confirmResolve?.(false);
  set({ confirm: request });
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve;
  });
}

export function resolveConfirm(ok: boolean): void {
  const resolve = confirmResolve;
  confirmResolve = null;
  set({ confirm: null });
  resolve?.(ok);
}

// -- what records are called ------------------------------------------------------------------------

/**
 * Learn the names on a batch of cards.
 *
 * CALLED FROM EVERY PLACE A CARD LANDS, which is what makes the directory fill itself from traffic
 * that was happening anyway: the graph's roots refresh several times a minute, every expansion is a
 * page of cards, every open note's detail carries its own card and every card in its edge lists.
 * Cheap by construction — `rememberCards` hands back the same index when nothing is new, and
 * `setNames` writes nothing when it does.
 */
function learnCards(cards: readonly RecordCard[]): void {
  setNames(rememberCards(state.names, cards));
}

/** Every card in one record's answer: the record itself, and everything on both sides of it. */
function learnDetail(detail: api.RecordDetail): void {
  const cards: RecordCard[] = [detail.card];
  for (const group of detail.referents) cards.push(...group.records);
  for (const group of detail.referrers) cards.push(...group.records);
  learnCards(cards);
}

function setNames(next: NameIndex): void {
  if (next !== state.names) set({ names: next });
}

/** In flight right now, so a pill pressed twice does not ask twice. Module-level rather than state
 * because nothing renders it: it is a fact about the network, not about the window. */
const resolving = new Set<string>();

/**
 * Open the record a mention names. What a pill's press does.
 *
 * THE NAME IS WHAT THE SENTENCE HAS AND THE ID IS WHAT A CARD NEEDS, so this is where one becomes
 * the other. Almost always for free: the directory learns both halves off every card the window
 * receives, so a record the reader has had on screen — which is most of them — opens without a
 * request. The fetch is the exception, for a record named in a sentence and never drawn.
 *
 * A NAME THAT ANSWERS TO NOTHING is a toast and not a card. The alternative would be opening a note
 * whose every read 404s, which says the same thing in a shape the reader then has to close. A name
 * refused once is remembered, so the second press is silent about the network and says the same
 * sentence.
 */
export async function openNamedRecord(table: RecordTable, name: string): Promise<void> {
  const known = lookupId(state.names, table, name);
  if (known !== null) {
    viewRecord(table, known, name);
    return;
  }
  const key = nameKey(table, name);
  if (resolving.has(key)) return;
  if (isMissing(state.names, table, name)) {
    reportGone(table, name);
    return;
  }
  resolving.add(key);
  try {
    const detail = await api.fetchRecordNamed(table, name, { limit: 1 });
    learnDetail(detail);
    viewRecord(table, detail.card.id, detail.card.name);
  } catch (cause) {
    if (cause instanceof ApiError && cause.isNotFound) {
      setNames(markMissing(state.names, table, name));
      reportGone(table, name);
      return;
    }
    reportFailure(`Could not open ${name}.`, cause);
  } finally {
    resolving.delete(key);
  }
}

/** The one sentence for a mention that no longer names anything. A rename is the ordinary cause and
 * the message says so, because "not found" alone would read as a bug in the window. */
function reportGone(table: RecordTable, name: string): void {
  pushToast(
    `No ${table} is called ${name} any more`,
    "It may have been renamed or deleted since that message was written.",
  );
}

/*
 * THERE IS NO THEME SECTION, and there is no theme. The window is dark, `tokens.css` is one `:root`,
 * and `color-scheme: dark` in render-blocking CSS is what paints the caret, the form controls and the
 * canvas beyond the body. A stored preference, a resolved system value, a toggle that cycles three
 * ways and a media-query watcher to keep "auto" honest would be four moving parts serving a choice
 * this app does not offer.
 */

// -- health -------------------------------------------------------------------------------------------

export async function refreshHealth(): Promise<void> {
  try {
    // Awaited into a local, per the trap `readRoot` spells out — and here it also has to be read
    // BEFORE `set`, because what comes back decides whether the pool is asked for below.
    const health = await api.fetchHealth();
    set({ health });
    // THE ONE PLACE THE WINDOW LEARNS WHICH HARNESS IT IS ON, and therefore the only honest moment
    // to make the pool's first read. The row of role slots above the composer is drawn from that
    // document whether or not anybody has opened the pool, and nothing announces it — see
    // `state/opencode.ts` on why it is configuration rather than a record. Once, because this is
    // polled: `poolAsked` is a fact about the network rather than about the window, so it lives
    // beside the read like `resolving` does.
    if (health.harness === "opencode" && !poolAsked) {
      poolAsked = true;
      void refreshOpencodePool();
    }
  } catch (cause) {
    // A failed health check IS the health answer: the badge shows unreachable, and a toast for it
    // would fire every fifteen seconds while the user restarts their own server.
    if (!isAbort(cause)) set({ health: null });
  }
}

/** Re-run the measurement engine's provisioning, then say what came of it. */
export async function retryVenv(): Promise<void> {
  try {
    const { venv } = await api.retryVenv();
    await refreshHealth();
    pushToast(venv.ready ? "The measurement engine is installed." : "The engine is still unavailable.", venv.error);
  } catch (cause) {
    reportFailure("Could not re-run the engine install.", cause);
  }
}

/**
 * THERE IS NO `openChat` AND NO `closeChat`, and their absence is the shape of this window. The
 * conversation is a permanent dock: nothing gates it, so there is no flag to flip, no gesture
 * that summons it, and no moment at which a socket should be attached later than boot —
 * `initStore` connects it, because a window that always shows the conversation is always its
 * observer. Blanking and fetching are not side-effects of opening: the transcript is fetched when
 * `ready` says which conversation the agent is in, and `blankConversation` below is the
 * resuming/clearing half.
 */

/**
 * Everything that belongs to the conversation ITSELF, emptied.
 *
 * Shared by resuming and clearing, so the two cannot come to disagree about what a conversation
 * consists of. `connection` is pointedly NOT in here, and that is a consequence of the socket
 * outliving the conversation: resuming an old session blanks everything below while the same
 * socket stays up, and a `connection: "idle"` written under a live connection would never be
 * contradicted — `ChatSocket` reports transitions, and it would not be making one.
 */
function blankConversation(): Partial<AppState> {
  const fresh = initialState();
  return {
    // Procedure state belongs to the run that is producing a report, so leaving forgets it rather
    // than carrying a stale "generating" into a conversation that is not.
    generation: null,
    chat: fresh.chat,
    transcriptError: null,
    composer: "",
    composerChips: fresh.composerChips,
  };
}

/*
 * THERE IS NO WORKSHOP SECTION AT ALL, AND NO RECORD-WRITING SECTION ANYWHERE IN THIS FILE.
 *
 * `createWorkshop`, `deleteWorkshop`, `forgetWorkshop` and `renameRecord` stood here, each wrapping
 * a route that has since been taken off the server. Every one of them is now a SENTENCE: the `+` on
 * the graph's recipe box says the reader would like to store one, the Bin says which row they
 * dragged onto it, and the agent interviews them, shows them the draft and writes the row. Nothing
 * about that needs a function here, which is why there is not one.
 *
 * WHAT A WRITE COSTS THIS STORE IS THEREFORE NOTHING BUT A REFRESH. A row the agent writes is
 * announced by `records_changed` like every other change to the database — the same frame another
 * tab's write would send — so the graph and the open cards ask again on the ordinary debounce, and
 * there is no longer any write this window has to nudge them about itself.
 *
 * THERE IS NO `probeWorkshop` EITHER. Nothing is bound to a workshop, so nothing wants a read that
 * throws the body away for the STATUS — a 404 is how a window BOUND to a workshop would discover
 * somebody had deleted it in another tab. A row that stops existing is discovered the way every
 * other change to the database is, and the conversation is not among the things that has to be told.
 */

// -- the conversation -------------------------------------------------------------------------------------

/**
 * The durable transcript, whole, replacing whatever was streamed.
 *
 * FETCHED BY SESSION ID, and there is deliberately nothing to fetch while that id is null. A fresh
 * conversation has no name until its first turn mints one, so a window that attached before then is
 * watching a conversation the SDK cannot yet be asked about. That is not a gap to be papered over
 * with a retry: `noteSession` re-emits `ready` the moment the id exists, `handleFrame` sees an id
 * that differs from the one in state, and this runs then. The same comparison covers resuming an old
 * conversation, where the id changes under a socket that never moved.
 *
 * Guarded against landing on the wrong conversation the ordinary way — the id is read before the
 * request and checked after it — because a resume can happen while this is in flight, and adopting
 * one conversation's transcript into another would be the worst kind of quiet.
 *
 * A 404 IS A TIMING FACT, NOT A FAILURE, and is the one refusal swallowed whole. The session store is
 * a directory of files written by a subprocess on a cadence nothing here controls, so a conversation
 * minted thirty seconds ago may genuinely not be on disk yet. Nothing is drawn about it: what is held
 * stays held, and the next turn's `turn_result` asks again. Everything else is kept beside the pane,
 * because the transcript is the one place whose empty state makes a claim about what was said.
 */
export async function refreshTranscript(): Promise<void> {
  const id = state.chat.sessionId;
  if (id === null) return;
  try {
    const answer = await api.fetchTranscript(id);
    if (state.chat.sessionId !== id) return;
    set({ chat: adoptTranscript(state.chat, answer.items), transcriptError: null });
  } catch (cause) {
    if (cause instanceof ApiError && cause.isNotFound) return;
    if (state.chat.sessionId === id) set({ transcriptError: messageFor(cause) });
    reportFailure("Could not load the conversation.", cause);
  }
}

/*
 * THERE IS NO `loadOlderMessages`, AND THERE IS NO PAGE TO BE A PAGE OF. The route answers the whole
 * post-compaction conversation in one piece, because a tool line is paired with its result by walking
 * that piece from the top and an offset drawn between them would render a call that never finished.
 * What bounds the list is the SDK folding its own history, which is announced as a `compacted` frame
 * and drawn as a marker in the transcript rather than as a keyset and a sentinel at the top of the
 * scroller.
 */

/**
 * Say something: the records that were dragged in, then the words that were typed.
 *
 * The two are flattened into one string HERE, at the boundary, by `serializeOutgoing` — which is
 * also what the optimistic bubble is given, so the transcript shows exactly what was sent rather
 * than a tidied version of it. Chips are a drawing in this window and stop existing at this line.
 *
 * Returns whether it reached the wire, so the composer keeps what was typed when it did not — a
 * message that never left is not part of the conversation. THE CHIPS ARE CLEARED BY THE SAME RULE
 * and in the same breath: they are as much of the draft as the sentence is, and a send that failed
 * must leave the whole draft intact or the reader repairs half a message.
 *
 * A FILE STILL UPLOADING HOLDS THE MESSAGE BACK. The composer disables its button for the same
 * condition, so this is the second of two gates rather than the reader's first news — but it is the
 * one that cannot be got around by an Enter key arriving in the same frame as the drop, and what it
 * prevents is a message going out about a file the agent will not find.
 */
export function sendMessage(text: string): boolean {
  if (state.composerChips.some((chip) => chip.kind === "file" && chip.path === null)) {
    pushToast("That file is still uploading.", "The message will go as soon as it lands.");
    return false;
  }
  // ONE TURN AT A TIME. The server refuses a message sent mid-turn, so asking would only spend a
  // round trip on an answer the window already has; the draft stays where it is, per this
  // function's own contract, and the Stop button is the way out.
  if (agentWorking(state.chat, state.generation)) {
    pushToast("The agent is still working.", "Stop it, or wait for it to finish — your message is still in the composer.");
    return false;
  }
  const outgoing = serializeOutgoing(state.composerChips, text);
  if (outgoing === "" || socket === null) return false;
  if (!socket.sendUserMessage(outgoing)) {
    pushToast("Not connected — that message was not sent.", "It is still in the composer.");
    return false;
  }
  set({ chat: appendUserMessage(state.chat, outgoing), composer: "", composerChips: [] });
  return true;
}

/**
 * Say something on the reader's behalf: what the `+` buttons and the bin do now.
 *
 * THE COMPOSER IS NOT TOUCHED, and that is the one rule this has that `sendMessage` does not need.
 * A reader who is halfway through typing something when they press `+` must not lose it, and must
 * not have their half-sentence sent — so this composes and sends its own text, leaves the draft and
 * its chips exactly where they were, and appends the message to the transcript itself.
 *
 * A closed socket is a toast and nothing else. There is no fallback card to open any more: writing
 * happens in the conversation, so when there is no conversation to speak into, the honest answer is
 * to say so.
 *
 * EVERY `+` AND THE BIN COME THROUGH HERE NOW. Four of them used to go through a `startCreation`
 * that put the conversation down and opened a fresh one to say the opening line into — staged across
 * the clear, said from the `ready` frame that confirmed the swap. The argument was that a creation is
 * a piece of work with a beginning and an end and should read afterwards as itself; the cost landed
 * on the reader, who was in the middle of something when they pressed the button and had the context
 * they were working in taken away. A person raising a recipe while looking at a thesis is usually
 * doing one piece of work. So there is one path here instead of two, no opener to stage, and no
 * frame that has to remember to say something.
 */
export function sendAwareness(text: string): void {
  // The same one-turn-at-a-time gate `sendMessage` holds, with a toast instead of a kept draft —
  // there is no draft, and the press is repeatable the moment the agent finishes. The buttons stay
  // enabled: a busy agent is a transient no, not the retired-recipe kind of no that removes a
  // control (`GraphPanel`), and dimming five buttons for the length of every turn would flicker
  // the graph chrome all day.
  if (agentWorking(state.chat, state.generation)) {
    pushToast("The agent is still working.", "Stop it, or wait for it to finish, then ask again.");
    return;
  }
  if (socket === null || !socket.sendUserMessage(text)) {
    pushToast("Not connected — ask the agent when the conversation is back.");
    return;
  }
  // `spoken` is what keeps a race-refused sentence out of the composer: if the server still says
  // busy, the sentence leaves the transcript and hands nothing back.
  set({ chat: appendUserMessage(state.chat, text, "spoken") });
}

/**
 * Ask the agent to answer the next turn with another model.
 *
 * NOTHING IS WRITTEN OPTIMISTICALLY. The agent answers with a fresh `ready` frame — to every window,
 * not just this one — and that frame is the authority for what the picker draws. A local write would
 * mean a select that shows the new model while the server has refused the change, which is the one
 * state a control like this must never be in.
 *
 * A refusal comes back as an `error` frame and reaches the reader through the toast every other
 * refusal uses; the only thing handled here is a socket that is not there to ask.
 */
export function changeModel(model: string): void {
  if (model === state.chat.model) return;
  if (socket === null || !socket.setModel(model)) {
    pushToast("Not connected — the model was not changed.");
  }
}

/**
 * Ask the agent to work the next turn at another effort level.
 *
 * The twin of `changeModel` above, and deliberately identical in shape because it answers the same
 * question about a conversation rather than about the installation. NOTHING IS WRITTEN
 * OPTIMISTICALLY here either: the level the picker draws comes from the `ready` frame the agent
 * sends every window, and a local write would show a level this conversation is not actually
 * working at for as long as it took a refusal to come back — which for `set_effort` is a real case
 * rather than a theoretical one, since the agent refuses the change outright while a turn is in
 * flight.
 *
 * The refusal arrives as an `error` frame and becomes a toast like every other; the only thing
 * handled here is a socket that is not there to ask. There is no path back to "no level": the
 * protocol has no frame for it, because the model's own default is the absence of a choice among
 * the five rather than a sixth one — resuming another conversation or clearing this one is what
 * restores it, and the `ready` that follows either is what tells the picker so.
 */
export function changeEffort(effort: EffortLevel): void {
  if (effort === state.chat.effort) return;
  if (socket === null || !socket.setEffort(effort)) {
    pushToast("Not connected — the effort level was not changed.");
  }
}

/**
 * Ask the agent to start or stop delegating to subagents.
 *
 * Shaped exactly like `changeEffort` above, down to the no-op when the answer is already the one
 * being asked for — which here saves more than a round trip: the agent ends and reopens its session
 * to honour a change, so a redundant ask would cost the model its working memory for nothing.
 *
 * NOTHING IS WRITTEN OPTIMISTICALLY, and that matters more here than for the model or the level.
 * Honouring this is not a setting taking effect on the next turn; it is the agent putting down the
 * subprocess it was answering out of. A toggle that drew itself as flipped before the agent said so
 * would be claiming that happened — and the agent refuses outright while it is working, which is
 * exactly when somebody is most likely to press it. The `ready` frame the agent broadcasts is the
 * authority, the refusal arrives as an `error` frame and becomes a toast like every other, and the
 * only thing handled here is a socket that is not there to ask.
 */
export function changeSubagents(enabled: boolean): void {
  if (enabled === state.chat.subagents) return;
  if (socket === null || !socket.setSubagents(enabled)) {
    pushToast("Not connected — subagents were not changed.");
  }
}

// -- the model pool, on the harness that has one ------------------------------------------------------

/**
 * Which models this installation can reach, and which one answers in which role.
 *
 * THE ROUTE TAKES THE WHOLE DOCUMENT, so every action below sends the whole document: the pure
 * module works out what the pool WOULD be after one change and this file posts it. That is why
 * deleting a model and emptying the roles that named it is one request rather than two — the route
 * validates what it is given as a whole and would refuse the halfway state — and why nothing here
 * writes optimistically. What comes back IS the stored truth, landed directly; there is no refetch
 * after a save and no window in which two tabs disagree.
 *
 * A REFUSAL IS A TOAST AND A FAILED READ IS NOT. The distinction is the one this whole file makes: a
 * save is a gesture somebody just made, and the server's sentence about it — the agent is working, a
 * role names a model that is not there, nothing answers the primary role — is an answer they can act
 * on wherever they are looking. A READ that fails goes in the panel it explains, because a pool that
 * could not be re-read is still a true account of what was reachable a moment ago and a toast would
 * expire while the panel it was about stayed on screen.
 */

/** Read once when the window learns it is on this harness — see `refreshHealth`. Module-level rather
 * than state because nothing renders it: it is a fact about a request, not about the window. */
let poolAsked = false;

/** Replace the slice, and only when it moved. Every function in `state/opencode.ts` hands back the
 * state it was given when nothing changed, which is what keeps a re-read that found the same four
 * models from redrawing four notes somebody may be typing into. */
function setOpencode(next: OpencodeState): void {
  if (next !== state.opencode) set({ opencode: next });
}

/** The pool, read whole. Fired twice in a window's life: on learning the harness, and on opening the
 * panel — the second because another tab may have edited it since the first. */
async function refreshOpencodePool(): Promise<void> {
  setOpencode(beginPoolRead(state.opencode));
  try {
    // Awaited into a local before the slice is read again — the `readRoot` trap. Opening the panel
    // while the boot read is still in flight is enough to have two of these at once.
    const pool = await api.fetchOpencodePool();
    setOpencode(landPool(state.opencode, pool));
  } catch (cause) {
    const message = messageFor(cause);
    if (message !== null) setOpencode(failPoolRead(state.opencode, message));
  }
}

/**
 * Save the whole pool, and land what the server says it stored.
 *
 * `what` is the sentence above the server's own, in the pattern every other write in this file
 * follows: this window says which gesture did not happen, and the server says why.
 */
async function savePool(next: api.OpencodePoolWrite, what: string): Promise<boolean> {
  try {
    // Awaited into a local, then the slice is read — four of these can be in flight from four
    // blurred boxes, and one landing into a snapshot taken before another started would put the
    // older document back.
    const pool = await api.putOpencodePool(next);
    setOpencode(landPool(state.opencode, pool));
    return true;
  } catch (cause) {
    reportFailure(what, cause);
    return false;
  }
}

/** Show the pool, or put it away. Opening re-reads it: the panel is the one place this document is
 * edited, and it should not open onto what another tab left behind. */
export function toggleModelPool(): void {
  const open = !state.opencode.poolOpen;
  setOpencode(setPoolOpen(state.opencode, open));
  if (open) void refreshOpencodePool();
}

/**
 * Pin a blank model to the board.
 *
 * THE ID IS MINTED HERE and never anywhere else. It is the provider id in the config rendered for
 * opencode and the string every role assignment names, so it is identity rather than decoration —
 * and a component minting one would be a second place inventing it. `crypto.randomUUID` for the same
 * reason `attachFiles` uses it: a value this window needs to be unique and never has to read.
 *
 * Blank in all four boxes, deliberately. The pool allows a half-filled entry — a note somebody has
 * just pinned up is empty until they type in it — so the gesture that creates one does not have to
 * ask any questions first.
 */
export async function createModel(): Promise<void> {
  await savePool(
    addedModel(state.opencode, crypto.randomUUID()),
    "That model was not added to the pool.",
  );
}

/** One model as its four boxes now read, committed. Called on blur rather than per keystroke: the
 * whole pool goes over the wire, and a request per character would be a request per character. The
 * note is sent whole rather than a box at a time — see `updatedModel` for the race that closes. */
export async function updateModel(id: string, next: api.OpencodeModel): Promise<void> {
  await savePool(updatedModel(state.opencode, id, next), "That change to the pool was not saved.");
}

/**
 * Take a model out of the pool, having asked.
 *
 * IT ASKS, AND THIS IS THE ONE GESTURE IN THE POOL THAT DESTROYS SOMETHING. The magnet on a record
 * note takes a note down and the record stays in the database; the magnet on a model note is the
 * only copy of a credential leaving the machine. There is no deletion ledger behind it either — the
 * pool is a file rather than a table precisely so that deleting a model does not copy an API key
 * into a log — so the question is asked here, in the same words the Bin's are written in.
 *
 * The roles that named it are emptied in the same document; see `removedModel`.
 */
export async function deleteModel(id: string): Promise<void> {
  const held = state.opencode.models.find((entry) => entry.id === id);
  if (held === undefined) return;
  const ok = await requestConfirm({
    title: `Take ${modelLabel(held)} out of the pool?`,
    body:
      "Its url and its key go with it, and the pool file is the only place either was written " +
      "down — nothing keeps a copy of this one. Any role it answers in is left empty, which means " +
      "opencode's own default answers there instead. This cannot be undone.",
    confirmLabel: "Remove the model",
    cancelLabel: "Keep it",
  });
  if (!ok) return;
  // Read AFTER the await: the reader spent the length of a dialog in front of this, and another
  // tab's save may have landed in it.
  await savePool(removedModel(state.opencode, id), "That model was not removed.");
}

/** Point one role at one model — the drop at the end of a drag, and the same write the slot's own
 * picker makes. */
export async function assignRole(role: string, id: string): Promise<void> {
  await savePool(assignedRole(state.opencode, role, id), `The ${role} role was not changed.`);
}

/** Empty one role, which hands it back to opencode's own default. Refused for the role that answers
 * an ordinary turn while there are models in the pool, in a sentence saying so. */
export async function clearRole(role: string): Promise<void> {
  await savePool(clearedRole(state.opencode, role), `The ${role} role was not cleared.`);
}

/** Light the slot a dragged model is over, or put them all out. Written only on the transition,
 * because the gesture calls it on every move — `setBinHot`'s twin, and for the same reason. */
export function setSlotHot(role: string | null): void {
  setOpencode(markSlotHot(state.opencode, role));
}

/*
 * -- the records the user used to write, and no longer does -----------------------------------------
 *
 * THE `+` BUTTONS WERE FORMS, and the case for them was a good one, which is why it is worth saying
 * what happened to it. A recipe is the specification somebody is commissioning work against and
 * the address book is their standing account of where their numbers come from; being interviewed
 * about your own specification reads like being asked to approve a transcript of what you just said.
 * So this section held `openCreateSourceCard`, `openCreatePlaybookCard`, `submitCreatePlaybook`,
 * `savePlaybookVersion`, `createSource`, `saveSource` and the three deletes behind the Bin.
 *
 * WHAT THE FORMS COULD NOT DO IS SHOW THEIR WORKING. A row written from a form is a row nobody was
 * asked about: the reader typed seven fields, pressed Save, and the archive gained a claim with no
 * account of where it came from. An interview leaves that account in the transcript — what was
 * asked, what was answered, what the agent was about to write, and the reader saying yes — and the
 * transcript is the one thing in this product that outlives every window. The DRAG that used to
 * carry a half-filled form into the conversation for checking was the good half of a form, and it is
 * now simply where the writing happens.
 *
 * SO NOTHING HERE WRITES A RECORD. The `+` buttons and the Bin say a sentence out of
 * `lib/awareness.ts`, through `sendAwareness`, into the conversation on screen — and what comes back
 * is a conversation. The refusals those functions used to surface — reports were published under
 * this recipe, a published report records running this script — are still the repository's own
 * words, and they now
 * reach the reader in the answer to a question they asked rather than as a toast over a form.
 */

/** Stop the model at its next step. A measurement already running finishes: it is compiled numeric
 * work with no cancellation point. */
export function interrupt(): void {
  socket?.interrupt();
}

export function setComposerDraft(draft: string): void {
  set({ composer: draft });
}

/** Dismiss the last thing the agent refused. The frame is a fact about a turn that is over, so
 * there is nothing to retry — only a line to take down. */
export function clearChatError(): void {
  set({ chat: clearError(state.chat) });
}

/**
 * Send a record along with the next message.
 *
 * The one way a record reaches the composer: the drop handler on the composer card. It lands as a
 * CHIP rather than as a mention spelled into the TEXT, because text has a position and a drag has to
 * choose one — the caret, mid-sentence, because that is what a drag means — and a chip has no
 * position to argue about.
 *
 * There is exactly one destination, which is why this takes no target and the store remembers no
 * last-typed-in field. There are no forms left in the window for it to have competed with either:
 * the composer is the only place a record can be dropped, so a drag that misses it lands nowhere
 * rather than in a text box that would have stored the literal characters `@thesis:9f2c…`.
 *
 * DEDUPED on `chipKey`, which for a record is the mention the chip will write. A row dragged in
 * twice is somebody making sure, not somebody asking for it twice, and two identical mentions on the
 * wire would be one fact stated twice to a model that is counting what it was given.
 *
 * A COLLIDING KEY IS DROPPED RATHER THAN REPLACING WHAT IS THERE, which used to be a branch and is
 * now the whole rule. A draft chip carried CONTENTS, so dragging the same half-filled form in twice
 * meant "the newer typing", and the later value won its slot in place. Nothing carries contents any
 * more: a record chip is an address, so the second drag says exactly what the first did, and a file
 * chip is keyed by its own drop and cannot collide with anything at all.
 */
export function addComposerChip(chip: ComposerChip): void {
  const key = chipKey(chip);
  if (state.composerChips.some((held) => chipKey(held) === key)) return;
  set({ composerChips: [...state.composerChips, chip] });
}

/** Take one back out. By position rather than by key, because position is what the reader is
 * pointing at: the × they pressed belongs to the nth chip in the row they can see. */
export function removeComposerChip(index: number): void {
  if (index < 0 || index >= state.composerChips.length) return;
  set({ composerChips: state.composerChips.filter((_, at) => at !== index) });
}

/**
 * Take files dropped on the composer, put them where the agent can read them, and chip them.
 *
 * THE CHIP APPEARS BEFORE THE UPLOAD FINISHES, holding a token and no path. A reader who has just
 * dropped a file has to see that it landed — the alternative is a window that does nothing for two
 * seconds and then produces a pill — and the pending state is what `sendMessage` and the composer's
 * button both read to hold the message until there is something to name.
 *
 * EACH FILE IS ITS OWN REQUEST AND ITS OWN CHIP. Four files are four uploads that settle whenever
 * they settle, in whatever order; one that is too large refuses alone and leaves the other three.
 *
 * THE RESOLUTION LOOKS THE CHIP UP AGAIN rather than closing over it, and that is the whole of the
 * concurrency story here. Between the drop and the answer the reader may have taken the chip out
 * with its ×, or sent the message, or dropped four more — so the continuation finds its chip by
 * token in the state as it is NOW, and a token that is no longer there is a result nobody is waiting
 * for. Dropping it silently is right: the file is written and orphaned in the home directory, which
 * `server/uploads.ts` says is the arrangement anyway.
 */
export function attachFiles(files: readonly File[]): void {
  for (const file of files) {
    const token = crypto.randomUUID();
    addComposerChip({ kind: "file", token, name: file.name, path: null });
    void api
      .uploadFile(file)
      .then(({ path }) => {
        settleFileChip(token, (chip) => ({ ...chip, path }));
      })
      .catch((cause: unknown) => {
        settleFileChip(token, null);
        pushToast(
          `${file.name} was not attached.`,
          cause instanceof ApiError ? cause.message : "The upload did not finish.",
        );
      });
  }
}

/** Replace one pending file chip, or drop it when `next` is null. A token that is no longer in the
 * composer means the reader removed it or the message has gone; either way there is nothing to
 * settle and nothing to say about it. */
function settleFileChip(
  token: string,
  next: ((chip: Extract<ComposerChip, { kind: "file" }>) => ComposerChip) | null,
): void {
  const at = state.composerChips.findIndex(
    (chip) => chip.kind === "file" && chip.token === token,
  );
  if (at === -1) return;
  const held = state.composerChips[at] as Extract<ComposerChip, { kind: "file" }>;
  set({
    composerChips:
      next === null
        ? state.composerChips.filter((_, i) => i !== at)
        : state.composerChips.map((chip, i) => (i === at ? next(held) : chip)),
  });
}

/*
 * THERE IS NO ADDRESS-BOOK SECTION AND NO VERIFIER, by decision. A source is not proposed from this
 * window, checked by a short-lived agent with web access, and written only if it passes — so no job
 * ids are held here and there is no function to ask where such a check had got to for a window that
 * slept through the frame. The agent registers sources itself and self-reports the hostnames they
 * publish on, and what guards the archive is the PUBLISH check, which refuses a citation URL whose
 * host is not one of them. That is consistency rather than truth, and it is stated as such — but it
 * is enforced where it matters, at the moment a claim is made, rather than minutes earlier by a
 * model reading pages.
 */

// -- the session list ----------------------------------------------------------------------------------------

/**
 * Every conversation this installation has had, and the two ways to change which one is live.
 *
 * A MIRROR THIS WINDOW DOES NOT WRITE. The list comes off the SDK's own store, flushed to disk by a
 * subprocess on a cadence nothing here controls, which is why it is refetched from so many places:
 * `initStore`, the events socket's `sessions_changed`, the events socket RECONNECTING (a laptop that
 * slept missed every poke), `ready`, and `turn_result` — because a summary is written after a turn
 * and the row's name changes under the reader without any other announcement.
 *
 * Almost none of those refreshes change anything visible, which is the whole reason `landSessions`
 * reconciles row by row and hands back the state it was given when nothing moved. See its header: the
 * rows are clickable targets, and a list rebuilt on every poke is a list that re-renders under the
 * cursor twice a minute.
 */

/** Replace the slice, and only when it moved — the identity discipline `state/sessions.ts` exists to
 * make possible. */
function setSessions(next: SessionsState): void {
  if (next !== state.sessions) set({ sessions: next });
}

async function refreshSessions(): Promise<void> {
  setSessions(beginLoad(state.sessions));
  try {
    // Awaited into a local before the slice is read — the trap `readRoot` spells out. Several of
    // these are in flight at once whenever a turn ends, and one landing into a snapshot taken before
    // another started would put the older list back.
    const answer = await api.listSessions();
    setSessions(landSessions(state.sessions, answer.sessions));
  } catch (cause) {
    // In the read-out and never as a toast: a list that cannot be refreshed is still a true list of
    // the conversations that existed a moment ago, and the sentence belongs in the panel it explains.
    // It also fires on every reconnect attempt while a server is down, which is exactly the thing a
    // toast must not do.
    const message = messageFor(cause);
    if (message !== null) setSessions(failLoad(state.sessions, message));
  }
}

/**
 * Reopen an old conversation.
 *
 * The refusals are the interesting half. A 404 means the SDK pruned it between the list being drawn
 * and the row being clicked; a 409 means the agent is mid-turn, and resuming then would abandon work
 * already in flight. Both arrive as the server's own sentence and both are shown VERBATIM, because
 * those sentences are written to be read and the second one is asking the reader to wait — which is a
 * decision only they can make.
 *
 * WHAT HAPPENS ON SUCCESS IS DELIBERATELY ALMOST NOTHING: the window waits. The agent emits a
 * fresh `ready` carrying the new session id, `handleFrame` sees an id that differs from the one in
 * state, and THAT is what blanks the conversation and fetches the new transcript into the dock.
 *
 * BLANKING HERE INSTEAD WOULD BE A RACE, AND A LOSING ONE. The route emits `ready` while it is still
 * handling the request — `agent.resume` sets the id and announces it synchronously — so the frame and
 * the response come back over two different connections with no ordering between them, and the frame
 * usually wins. A blank written after the response would then land on top of the state the frame had
 * just repaired: the new session id wiped back to null, the transcript fetch it started dropped by
 * its own staleness guard, and nothing left to trigger another until the reader typed something. The
 * frame is the honest moment anyway — it is the agent saying which conversation it is in, rather than
 * this window assuming from a request it made.
 */
export async function resumeSession(sessionId: string): Promise<void> {
  try {
    await api.resumeSession(sessionId);
  } catch (cause) {
    reportFailure("That conversation was not reopened.", cause);
    return;
  }
  void refreshSessions();
}

/**
 * Put the current conversation down and begin the next turn with no memory of it.
 *
 * NOTHING IS DELETED. The conversation stays in the harness's store, stays in the list, and can be
 * resumed from the row it left behind — which is why this needs no confirmation, and why the mark on
 * its button is a plus rather than anything destructive: what it does is BEGIN one, and everything
 * it puts down is still filed. Deleting a conversation is a different gesture with a different
 * ending, and it is the Bin's. Same refusal as a resume while the agent is working, and
 * the same silence afterwards for the same reason: the fresh `ready` carries `sessionId: null`, which
 * differs from what was held, and the frame handler blanks the window on the strength of that.
 */
export async function newSession(): Promise<void> {
  try {
    await api.clearSession();
  } catch (cause) {
    reportFailure("That conversation was not put down.", cause);
    return;
  }
  void refreshSessions();
}

// -- the two logs --------------------------------------------------------------------------------------------

/**
 * What went wrong, and what was destroyed.
 *
 * Two capped ledgers on the server, read through one route and drawn by two instruments in the
 * corner. Everything about how they MERGE — a head refetch replacing the newest region without
 * throwing away pages somebody scrolled back through, a complete answer being allowed to delete rows
 * a truncated one may not, the two nonces that let a closed chip say "there is something new" — is
 * `state/logs.ts`'s and is argued there. What lives here is the fetching, and the one rule the pure
 * module cannot enforce for itself: THE CATEGORY A PAGE IS FETCHED FOR MUST BE THE CATEGORY IT LANDS
 * UNDER, because a page carries no evidence of which ledger it came from once it is in hand.
 *
 * A LEDGER IS REFETCHED ONLY WHILE ITS OWN VIEWER IS OPEN. The nonce is bumped either way — that is
 * what the mark on the chip is — but a window showing neither panel, or showing the other one, has
 * no reason to hold a thousand rows nobody is reading, and the agent writes to both of these all
 * day.
 */

/** Replace the slice, and only when it moved. `state/logs.ts` hands back the state it was given
 * whenever a landing changed no row a subscriber could see, which is the common case: the viewer
 * refetches its head on every poke, and most pokes are about the other ledger. */
function setLogs(next: LogsState): void {
  if (next !== state.logs) set({ logs: next });
}

/** Show one ledger, and read it. One rather than both: they are two instruments, and somebody
 * who opened the deletion ledger asked about deletions — fetching a thousand errors alongside would
 * be this store deciding they meant something broader. */
export function openLogViewer(category: LogCategory): void {
  set({ logs: setLogView(state.logs, category) });
  void refreshLogHead(category);
}

/** Close whichever is open, keeping the rows. See `setLogView`: a reader who closes a ledger and
 * opens it again is not asking to re-read a thousand rows. */
export function closeLogViewer(): void {
  set({ logs: setLogView(state.logs, null) });
}

/** Show or put away the session list. It shares the corner slot with the two ledgers — see
 * `state/logs.ts` — so opening it closes whichever ledger was open, with no second write. Nothing
 * is fetched: the list is kept fresh by its own poke, whether or not anybody is looking. */
export function toggleSessionsViewer(): void {
  set({ logs: setLogView(state.logs, state.logs.view === "sessions" ? null : "sessions") });
}

/** The newest page of one ledger, merged over whatever is held. What a poke asks for while the viewer
 * is open, and what opening it asks for. */
async function refreshLogHead(category: LogCategory): Promise<void> {
  setLogs(beginPage(state.logs, category));
  try {
    const answer = await api.fetchLog(category);
    setLogs(landHead(state.logs, category, answer));
  } catch (cause) {
    // In the section it explains and never as a toast — the same rule as the session list, and here
    // it matters more: this fires on every poke while the viewer is open, so a server that has just
    // fallen over would put up a toast per log row it wrote on the way down.
    const message = messageFor(cause);
    if (message !== null) setLogs(failPage(state.logs, category, message));
  }
}

/**
 * One page further down one ledger.
 *
 * Keyset, `before` naming the OLDEST row already in hand rather than a position, for the reason the
 * record browser pages that way: rows arrive while the panel is open — that is what the panel is for
 * — and an offset would repeat one or skip one every time the agent did anything.
 */
export async function logsShowMore(category: LogCategory): Promise<void> {
  const page = category === "errors" ? state.logs.errors : state.logs.deletions;
  const oldest = page.entries.at(-1);
  if (oldest === undefined || !page.hasMore) return;
  setLogs(beginPage(state.logs, category));
  try {
    const answer = await api.fetchLog(category, { before: oldest.id });
    setLogs(appendOlder(state.logs, category, answer));
  } catch (cause) {
    const message = messageFor(cause);
    if (message !== null) setLogs(failPage(state.logs, category, message));
  }
}

// -- the node graph ------------------------------------------------------------------------------------------

/**
 * Everything the graph panel does, and every read behind it.
 *
 * THE GRAPH IS A PICTURE OF THE DATABASE, not of one recipe. Column zero is four whole tables — the
 * four places a reader starts, listed in `ROOT_TABLES` — and every other box is one referrer group
 * of a row somebody opened. Nothing here takes a recipe id, and nothing about the conversation
 * dock touches this slice — see the note on the field.
 *
 * WHAT IS OPENED IS KEYED BY PATH, so the same record opened under two different parents is two
 * boxes. That grammar and the merge rules live in `state/graph.ts`; this file only does the fetching
 * and hands the answers to it.
 *
 * EVERY PAGE LANDS IN THE STORE, never in a component. A page held in component state would be
 * discarded by the next 500ms live refresh — the store replaces the slice, the component remounts its
 * rows, and the list shrinks back under the reader who has just scrolled it open. So `graphShowMore`
 * writes through `extendGroup`, and the merge is written to keep those extra rows.
 */

/** Replace the slice, and only when it actually moved. Every function in `state/graph.ts` returns
 * the state it was given when nothing changed, which is what makes an unchanged half-second poll
 * cost no re-render and no relayout. */
function setGraph(next: GraphState): void {
  if (next !== state.graph) set({ graph: next });
}

/**
 * How many rows a read asks for: as many as are on screen, and never fewer.
 *
 * Asking for less than is already drawn would make the merge read everything below the page's edge
 * as deleted and shrink a box the reader had paged open. Floored at a screenful so a fresh read
 * still asks for one, and clamped at the ceiling the API enforces so the request is not refused.
 */
function heldLimit(count: number): number {
  return Math.min(MAX_GROUP, Math.max(DEFAULT_GROUP, count));
}

/**
 * Open a row, or close it — and either way, make it the selection.
 *
 * One entry point for both, because the row is one control: the panel does not decide which of the
 * two it means, it says which row was clicked and this answers from what is already open. Folding
 * takes everything opened beneath it — and the drags applied to those boxes — with it.
 *
 * SELECTING AFTER THE FOLD, not before. `fold` clears a selection that was under the row it is
 * closing, and the row being closed is under itself; a click that shut a row and left no selection
 * behind would unmark a row every time somebody tidied up. The order says what the click meant:
 * this row, still.
 *
 * A ROW OF A TABLE NOTHING CAN POINT AT NEVER OPENS A BOX, and the rule is written HERE, once,
 * rather than in the panel. Three gestures reach this function — a single click on the row, Enter on
 * it, and the row's own disclosure arrow — so a guard in the component would be three copies of one
 * rule, and the copy somebody forgot would be a click that opened nothing at all for the reader to
 * close again. `expands` answers from the SCHEMA rather than from the row: a run row, an information
 * source and a series preparation are leaves of this graph whatever the archive holds. When it says
 * no the click still LANDS — the row becomes the selection, which is the whole of what the outline
 * claims — it just opens nothing.
 *
 * THE EXPANSION IS STILL TESTED FIRST, because this is the fold path as well as the open one and a
 * guard ahead of it would answer the wrong question about a box already on screen.
 */
export function toggleNode(path: NodePath, card: RecordCard): void {
  if (isExpanded(state.graph, path)) {
    setGraph(select(fold(state.graph, path), path));
    return;
  }
  if (!expands(card.table)) {
    setGraph(select(state.graph, path));
    return;
  }
  setGraph(select(expand(state.graph, path, card), path));
  void readNode(path, card, DEFAULT_GROUP, false);
}

/**
 * One opened row's referrers.
 *
 * REFERRERS ONLY. `fetchRecord` answers with both directions, and the referents are dropped here on
 * purpose: an edge drawn in both directions is the same link twice, and a graph that walked them
 * would grow a box for the record you just came from every time you opened one.
 *
 * The answer is guarded by `state/graph.ts` rather than here — `land`, `mergeExpansion` and `fail`
 * all drop an answer whose path is no longer open — so a read that finishes after the reader folded
 * the row cannot make a box they closed reappear.
 */
async function readNode(
  path: NodePath,
  card: RecordCard,
  limit: number,
  merging: boolean,
): Promise<void> {
  try {
    const detail = await api.fetchRecord(card.table, card.id, { limit });
    learnDetail(detail);
    setGraph(
      merging
        ? mergeExpansion(state.graph, path, detail.referrers)
        : land(state.graph, path, detail.referrers),
    );
  } catch (cause) {
    // On the box and never as a toast: a record deleted since its row was drawn, or an id the
    // server will not read, is an answer ABOUT the row that was clicked. The groups already in hand
    // are kept underneath, so a refresh that fails leaves the graph where it was.
    const message = messageFor(cause);
    if (message !== null) setGraph(fail(state.graph, path, message));
  }
}

/**
 * Read the whole graph again: all four root tables, and every row that is open under any of them.
 *
 * MERGES, NEVER REPLACES. The merge diffs by record id in place and appends what is new at the
 * bottom of its box, so a refresh does not move the row under the pointer of somebody about to drag
 * it into the composer — which is the objection this whole panel had to answer before it could be
 * built. Every read asks for what that node currently shows, for the reason in `heldLimit`.
 *
 * The four roots are read CONCURRENTLY and land independently, each into its own `RootState`. One
 * table refusing therefore refuses one box: the three that answered are drawn from their answers,
 * and nothing about them is held back waiting on the one that did not.
 *
 * Fired by the ↻ button, once at boot, and by the 500ms live refresh behind the socket's frames —
 * and that is now the whole list. It used to be fired directly by every write this window made, on
 * the grounds that no frame announces one; this window makes none, so every change to the database
 * arrives the same way a change made in another tab does, as a `records_changed` poke.
 */
export async function refreshGraph(): Promise<void> {
  const held = state.graph;
  for (const table of ROOT_TABLES) setGraph(beginRoot(state.graph, table));
  const reads: Promise<void>[] = ROOT_TABLES.map((table) =>
    readRoot(table, heldLimit(rootOf(held, table).box?.records.length ?? 0)),
  );
  for (const path of expandedPaths(held)) {
    const open = held.expansions.get(path);
    if (open !== undefined) reads.push(readNode(path, open.card, shownLimit(open), true));
  }
  await Promise.all(reads);
}

async function readRoot(table: RootTable, limit: number): Promise<void> {
  try {
    // THE PAGE IS AWAITED INTO A LOCAL FIRST, and it has to be. Written as
    // `setGraph(mergeRoot(state.graph, table, await api.fetchTable(…)))` the arguments are evaluated
    // left to right, so `state.graph` is read BEFORE the request is even sent — and four of these run
    // at once. Each would merge its answer into a snapshot that predates the other three, and the
    // last to land would write that snapshot back over all of them. The symptom is not a missing row
    // but three boxes reading "reading…" for ever: `beginRoot`'s loading flag is part of the stale
    // graph they all restore.
    const page = await api.fetchTable(table, { limit });
    learnCards(page.records);
    setGraph(mergeRoot(state.graph, table, page));
  } catch (cause) {
    // The rows already drawn stay; with none, the layout turns that one box into the refusal itself.
    // "There are no scripts" is a claim about the database a failed read cannot make — and it is a
    // claim about ONE table, which is why this lands on one box rather than on the panel.
    const message = messageFor(cause);
    if (message !== null) setGraph(failRoot(state.graph, table, message));
  }
}

/**
 * One more page of one box, appended.
 *
 * Keyset, `before` naming the last row already in hand, so the page that comes back is the rows
 * BELOW what is on screen rather than a position that has moved since it was drawn.
 */
export async function graphShowMore(rowPath: NodePath, table: RecordTable): Promise<void> {
  const open = state.graph.expansions.get(rowPath);
  const group = open?.groups?.find((held) => held.table === table);
  const last = group?.records[group.records.length - 1];
  if (open === undefined || group === undefined || last === undefined || !group.hasMore) return;
  try {
    const more = await api.fetchReferrers(open.card.table, open.card.id, table, {
      before: last.id,
      limit: DEFAULT_GROUP,
    });
    learnCards(more.records);
    setGraph(extendGroup(state.graph, rowPath, table, more));
  } catch (cause) {
    // The same place a failed read of this row goes, because that is what it is: the reader asked
    // this node for more and the node is what could not answer.
    const message = messageFor(cause);
    if (message !== null) setGraph(fail(state.graph, rowPath, message));
  }
}

/** One more page of one root box. Same rule, and it takes the table because column zero is four
 * boxes: the list that was scrolled to its end belongs to exactly one of them. */
export async function graphShowMoreRoots(table: RootTable): Promise<void> {
  const box = rootOf(state.graph, table).box;
  const last = box?.records[box.records.length - 1];
  if (box === null || last === undefined || !box.hasMore) return;
  try {
    const page = await api.fetchTable(table, { before: last.id, limit: DEFAULT_GROUP });
    learnCards(page.records);
    setGraph(extendRoot(state.graph, table, page));
  } catch (cause) {
    const message = messageFor(cause);
    if (message !== null) setGraph(failRoot(state.graph, table, message));
  }
}

/**
 * Where the reader has dragged a box to, in absolute pixels from where the packing put it.
 *
 * Session-lifetime and nowhere but this slice. A drag is a fact about the picture on screen, not
 * about the database, so it is not persisted — and it is not component state either, because the
 * layout is a pure function of this slice and a drag held outside it would not be in the layout.
 */
export function dragNode(path: NodePath, offset: NodeOffset): void {
  setGraph(setOffset(state.graph, path, offset));
}

// -- standing over the graph ------------------------------------------------------------------------

/**
 * The pan and the zoom, written whole.
 *
 * Whole rather than as `panBy`/`zoomAt` actions because the math is `lib/graphView.ts`'s and it is
 * pure: the panel computes the next transform from the gesture and hands it over. A store action per
 * gesture would be a second place the invariant "the point under the cursor does not move" could be
 * got wrong, and it is the one thing about this that is worth only being written once.
 *
 * Identity-checked, because the pure functions return the view they were given when a gesture asks
 * for nothing — a wheel spun at the zoom limit, a pointer that moved zero pixels — and this is where
 * that saves the re-render.
 */
export function setGraphView(view: ViewTransform): void {
  if (view !== state.graphView) set({ graphView: view });
}

/**
 * The transform as it is RIGHT NOW, without subscribing.
 *
 * For the node drag alone, which needs the scale to convert its screen-space pointer movement into
 * a graph-space offset, and reads it once at pointerdown. A hook there would subscribe every title
 * bar on the canvas to the pan, and every one of them would re-render sixty times a second during a
 * gesture that does not move a single node — which is the whole thing keeping the transform out of
 * `GraphState` was for.
 */
export function currentGraphView(): ViewTransform {
  return state.graphView;
}

// -- the record panel -------------------------------------------------------------------------------------------

/**
 * Everything the panel holds open, and every read behind it.
 *
 * THE PANEL IS A STACK, and `state/cards.ts` argues why at length. What that means here is
 * that every read is addressed to a CARD and guarded by that card's own token: five cards can be in
 * flight at once, a card can be closed while its answer is on the way, and a card closed and
 * reopened is a different card that the earlier answer must not land on. The token is minted by
 * whoever starts a read and presented with the answer; the pure module drops anything that cannot
 * present it.
 *
 * EVERY `+` GOES TO THE CONVERSATION, so no `+` opens a card. The three that used to — a blank
 * place to publish into, a blank information source, a blank specification — rested on the argument that
 * neither of those is a FINDING, so the person pressing the button is the one to ask why. That is
 * still true and is no longer the whole question: a row written from a form arrives in the archive
 * with no account of what it was for, and a row written from an interview arrives with the whole
 * exchange behind it in a transcript that outlives every window. So a press says a sentence
 * (`lib/awareness.ts`), the agent asks, and the CARD that eventually opens is the record that got
 * written — through `viewRecord`, like every other record in the window.
 *
 * WHICH LEAVES THIS PANEL DOING ONE THING. Every card is a reading; every read is addressed to a
 * card; nothing here has a Save button to guard, a draft to keep or a close that can lose anything.
 */

/** Replace the slice, and only when it moved. Every function in `state/cards.ts` hands back the
 * state it was given when nothing changed — an answer that missed its token, a repeat of the same
 * refusal — and this is where that saves the re-render of a stack of open editors. */
function setCards(next: CardsState): void {
  if (next !== state.cards) set({ cards: next });
}

/** A record card, spelled in one place, because a card is sometimes addressed rather than opened:
 * the report a `report_published` frame announces has to be found again to have its nonce bumped,
 * and finding it means building the same three fields into the same key. */
function recordCard(table: RecordTable, id: string, label: string): Card {
  return { kind: "record", table, id, label };
}

/**
 * Open a record, or focus the card already showing it — and either way read it again.
 *
 * THE ONE WAY IN, from all four doors: a row in the graph, a mention pill in the transcript, a report
 * chip, and an edge drawn inside a card. All four mean the same thing — "that record, on screen" —
 * and the record they name arrives BESIDE what is already open instead of on top of it, so following
 * "what is this report standing on" leaves the report on screen and the trail somebody walked is
 * readable as a stack when they get there.
 *
 * The read is always started, even for a card that is already open and already answered. A second
 * click on a record is somebody coming back to it, and the cheapest honest answer to "is this still
 * what the database says" is to ask. `beginRead`'s shown style is right here: somebody asked, and a
 * spinner is what asking looks like.
 */
export function viewRecord(table: RecordTable, id: string, label: string): void {
  const card = recordCard(table, id, label);
  const key = cardKey(card);
  const token = newToken();
  setCards(beginRead(openCard(state.cards, card), key, token));
  putUp(key);
  void readCard(key, token, table, id);
}

/**
 * Give a freshly opened card a place on the board, and bring it to the front.
 *
 * BOTH HALVES, EVERY TIME, and the pair is the point. `placeNote` is a no-op for a note that is
 * already up — a record opened twice must not jump to the cascade's next slot, because the second
 * gesture means "that one", not "another one" — and `raiseNote` is what actually answers the reader
 * in that case: the note they named comes to the top of the pile with everything else exactly where
 * they left it.
 */
function putUp(key: CardKey): void {
  setNotes(raiseNote(placeNote(state.notes, key, viewportNow(), dockLeftNow()), key));
}

/**
 * Take a card off the stack.
 *
 * NOTHING IS SENT ANYWHERE ON THE WAY OUT, and nothing can be lost by it. A draft-backed card could
 * be carrying keystrokes no blur had flushed, and closing one would have to write them to the server
 * first; a card is a READING, so closing one is purely a fact about the screen.
 */
export function closeCard(key: CardKey): void {
  setCards(removeCard(state.cards, key));
  // The place goes with the card, which is the other half of the pairing rule in the notes section
  // below: a key left in `notes.placed` after its card has gone is a rectangle nothing draws, and it
  // would put the note back where it was if the same record were opened again — which reads as the
  // window remembering something the reader took down.
  setNotes(dropNote(state.notes, key));
}

/** Mark the card the last gesture was about. What the board rings; ignored for a card that is not
 * open, per `state/cards.ts`. */
export function focusCard(key: CardKey | null): void {
  setCards(markFocused(state.cards, key));
}

// -- where the notes sit ----------------------------------------------------------------------------

/**
 * The board's geometry: where each open note is pinned, and which of them is in front.
 *
 * TWO MAPS KEPT IN STEP, and this is the only place that knows they are two. `cards` answers "what
 * is open and how did reading it go"; `notes` answers "where is it on the glass". The pairing rule
 * is one line long — a card that is opened is placed, a card that is closed is dropped — and it is
 * here rather than inside either pure module because neither of them is allowed to know about the
 * other.
 *
 * The viewport is read from `window` in this file and nowhere below it: `state/notes.ts` is DOM-free
 * on purpose, so the store is where the screen's actual size enters the arithmetic. The dock's LEFT
 * edge comes out of `dockRect` READ AT THE SPLIT THIS STORE HOLDS, which is the same arithmetic and
 * the same number the dock itself is drawn from — so a fresh note is never put down on the
 * conversation wherever the reader has dragged its edge to, and nothing has to measure an element to
 * know where the board ends.
 */
function setNotes(next: NotesState): void {
  if (next !== state.notes) set({ notes: next });
}

function viewportNow(): Box {
  return { width: window.innerWidth, height: window.innerHeight };
}

function dockLeftNow(): number {
  return dockRect(viewportNow(), state.dockSplit).x;
}

/** Bring one note to the front. Fired by a pointerdown anywhere in it, and a no-op when it is
 * already there — see `raiseNote` on why that guard is what keeps typing into a form from minting a
 * state per character. */
export function raiseNoteAction(key: CardKey): void {
  setNotes(raiseNote(state.notes, key));
}

/** Move one note. The caller has already added the gesture's total distance to the position it read
 * at the press; the clamp is `state/notes.ts`'s. */
export function moveNoteTo(key: CardKey, x: number, y: number): void {
  setNotes(moveNote(state.notes, key, x, y, viewportNow()));
}

/** Resize one note. The caller has already added the gesture's total distance to the size it read at
 * the press and clamped it with `dragNoteSize`; what happens here is the position being pulled back
 * onto the glass if the note got narrower — see `sizeNote`. */
export function resizeNoteTo(key: CardKey, w: number, h: number): void {
  setNotes(sizeNote(state.notes, key, w, h, viewportNow()));
}

/** Resize one note from its left side or its left corner: `x` and `w` arrive together, already
 * coupled by the drag helper so the right border stays where the reader left it. `h` passes straight
 * through — a side drag hands back the height it found, `null` and all, and only a gesture with a
 * vertical component brings a number. See `sizeNoteAt`. */
export function resizeNoteAt(key: CardKey, x: number, w: number, h: number | null): void {
  setNotes(sizeNoteAt(state.notes, key, x, w, h, viewportNow()));
}

/** Pull every note back onto a window that has changed size. Called from a resize listener, and a
 * no-op — down to the identity of each untouched note's place — when nothing was stranded. */
export function clampNotesToViewport(): void {
  setNotes(clampNotes(state.notes, viewportNow()));
}

/** Light the Bin, or put it out. Written only on the transition, because both gestures that call it
 * do so on every move. */
export function setBinHot(hot: boolean): void {
  if (state.binHot !== hot) set({ binHot: hot });
}

// -- the edge between the board and the conversation ------------------------------------------------

/**
 * The one gesture that moves the split, and the three facts it moves with it.
 *
 * THE BOARD IS RESCALED RATHER THAN RE-LAID-OUT, which is what makes this affordable at sixty hertz:
 * `.graph__canvas` is the whole window and no ResizeObserver fires when the dock's edge moves, so the
 * picture follows the edge through the surface's transform and the packing is never asked to run.
 * The notes ride the same ratio, because a note is pinned to the board rather than to the window.
 *
 * SNAPSHOT-BASED, per the doctrine in `lib/pointerDrag.ts`: every move applies the gesture's TOTAL
 * distance to the state the drag STARTED from. Accumulating instead would compound a rounding error
 * per frame — a note a pixel narrower on every one of the hundred moves in a long drag — and would
 * make a coalesced or stolen event a permanent offset rather than one skipped frame.
 */
export type DockDragStart = {
  readonly split: number;
  readonly viewport: Box;
  readonly view: ViewTransform;
  readonly notes: NotesState;
};

/** What the grip reads at pointerdown. All four at once, because they are the four things the move
 * below is a function of, and any of them re-read mid-gesture would change what a distance measured
 * from a fixed press MEANS. */
export function beginDockDrag(): DockDragStart {
  return {
    split: state.dockSplit,
    viewport: viewportNow(),
    view: state.graphView,
    notes: state.notes,
  };
}

/**
 * Move the edge, and take the board with it.
 *
 * ONE `set`, AND IT IS THE WHOLE POINT OF THIS FUNCTION. The dock's rectangle, the graph's transform
 * and every note's place are three answers to the same question — where the boundary is — so they are
 * written in a single mutation and no subscriber ever renders a frame with the dock on one side of
 * the ratio and the board on the other.
 *
 * The ratio is the board's new width over its old one, taken from `dockRect` at both splits so it is
 * measured on the same rounded pixels the dock is actually drawn at. A degenerate board — a window
 * with nothing to the left of the split — has no ratio to give, and the honest answer there is to
 * move the edge and touch nothing else rather than to divide by it.
 *
 * The guard is against the CURRENT split rather than the snapshot's, which is what lets a drag come
 * back to where it started: a move whose clamped answer is already on screen writes nothing, and a
 * gesture pushed past a bound and released is left exactly at the bound.
 */
export function dragDockTo(start: DockDragStart, dx: number): void {
  const split = clampSplit(start.split + dx / start.viewport.width);
  if (split === state.dockSplit) return;
  const was = dockRect(start.viewport, start.split).x;
  if (!(was > 0)) {
    set({ dockSplit: split });
    return;
  }
  const r = dockRect(start.viewport, split).x / was;
  set({
    dockSplit: split,
    graphView: scaleAboutOrigin(start.view, r),
    // `clampNotes` composed OUTSIDE the scaling, because it is the one owner of the size floors and
    // the viewport's bounds — see `scaleNotes`, which deliberately applies neither.
    notes: clampNotes(scaleNotes(start.notes, r), start.viewport),
  });
}

// -- the Bin ----------------------------------------------------------------------------------------

/**
 * One record, dropped on the Bin.
 *
 * THE BIN NO LONGER DELETES ANYTHING, AND IT IS STILL THE PLACE YOU PUT THINGS. Dragging a row onto
 * it says, in the conversation, that the reader wants that row gone and would like to know what goes
 * with it; the agent answers — four reports were published under this version, three sources are
 * cited nowhere — and deletes it if nothing is in the way. The sentence is `binDrop`'s, and it names
 * the row, because this is the one press in the window that is already about a specific record.
 *
 * EVERY TABLE, NOT FOUR. There used to be a per-table confirmation dialog here for the four tables
 * this window had a delete route for, and a refusal for the other eight saying only the agent could
 * delete those. There is no route for any of them now, so the asymmetry has gone: a thesis dropped
 * on the Bin asks the same question a report does, and the agent's own rules about what may be
 * deleted are what answer it.
 *
 * WHICH IS ALSO WHERE THE CONFIRMATION WENT. A dialog was the gesture's second half while the drop
 * destroyed a row on release — a drag is easy to make by accident in a way a button press is not.
 * The drop is now a QUESTION, so there is nothing to guard: a sentence sent by mistake is a sentence
 * the reader can answer "no" to, in the place where they can see what it was about to take with it.
 *
 * TWO DOORS, ONE SENTENCE. A row dragged out of the graph with the browser's own drag-and-drop and a
 * whole note dragged by its head with a captured pointer both end here, so the transcript says the
 * same thing however the reader got there.
 */
export function dropOnBin(payload: RecordPayload): void {
  sendAwareness(binDrop(payload.table, payload.name));
}

/**
 * A conversation dropped on the Bin: deleted, now, with no question asked.
 *
 * THE ONE DROP THAT DESTROYS SOMETHING, and it is the exception rather than a crack in the rule
 * above. A record dropped on the Bin asks a question because there is something worth asking: a
 * deletion cascades, other rows point at it, and the useful thing an agent can say first is what
 * else goes with it. A transcript has none of that. Nothing in the archive points at one, no report
 * was written from it, there is no cascade to enumerate — and the agent could not answer anyway,
 * because the store belongs to the harness rather than to the database it can read. So the drag is
 * the asking and this is the doing.
 *
 * Nothing is witnessed either, which is stated here because it is the one place a reader of this
 * file might expect a `deletion_log` row: that log holds records, and what was said was never one.
 * The toast is the whole account of it.
 */
export async function dropSessionOnBin(payload: SessionPayload): Promise<void> {
  try {
    await api.deleteSession(payload.sessionId);
  } catch (cause) {
    // The server's own sentence: the conversation on screen cannot be deleted, or the store no
    // longer has it. Both are things the reader can act on.
    reportFailure("That conversation was not deleted.", cause);
    return;
  }
  pushToast("That conversation was deleted.", payload.summary);
  void refreshSessions();
}

/** What a note carries when it is dragged onto the Bin: the record it is showing, spelled the way a
 * dragged row spells itself, so both gestures hand `dropOnBin` the same shape. It answers for every
 * card there is — a card is a reading — where it used to return null for the three blank forms,
 * which had no row behind them to be dropped on anything. */
export function recordPayloadOf(card: Card, name: string): RecordPayload {
  return { kind: "record", table: card.table, id: card.id, name };
}

/** Whether the pointer, at the end of a note's drag, was over the Bin. Pure rect math in
 * `state/notes.ts`; the rectangle itself was read at the press. */
export function overBin(rect: Rect | null, px: number, py: number): boolean {
  return overRect(rect, px, py);
}

/**
 * Read one card again because somebody asked — the ↻ on its header.
 *
 * A switch over the one kind of card there is, rather than a straight read, and the arm is worth
 * keeping: the compiler complains here — the one place a card is dispatched on — if a second kind is
 * ever added, instead of the panel quietly doing nothing for it. Shown rather than quiet, unlike the
 * live refresh: a person pressed it, and a control that does nothing visible reads as a broken one.
 */
export function reloadCard(key: CardKey): void {
  const held = cardAt(state.cards, key);
  if (held === null) return;
  switch (held.card.kind) {
    case "record": {
      const token = newToken();
      setCards(beginRead(state.cards, key, token));
      void readCard(key, token, held.card.table, held.card.id);
      return;
    }
  }
}

/**
 * Every open card, re-read silently.
 *
 * One quiet re-read per open card, and two rules matter here. It leaves `loading` and any standing
 * error alone — the `quiet` style — because this fires on a half-second debounce for as long as the
 * agent is working, and a panel that flashed through "reading…" on five cards twice a second would
 * be unreadable exactly when it is most worth watching. And every read carries its own token, so
 * five answers arriving in any order each land on the card that asked for them or on nothing at all.
 *
 * NOTHING IS SKIPPED ANY MORE. Three blank forms used to be walked past here, because none of them
 * had a row behind it and re-reading one would have written over what somebody was typing. Every
 * card is a reading now, so the loop has nothing to exclude.
 */
export async function refreshCards(): Promise<void> {
  const reads: Promise<void>[] = [];
  for (const held of cardStack(state.cards)) {
    const token = newToken();
    setCards(beginRead(state.cards, held.key, token, "quiet"));
    reads.push(readCard(held.key, token, held.card.table, held.card.id));
  }
  await Promise.all(reads);
}

/**
 * The fetch behind both, guarded by the token the card is holding.
 *
 * The guard lives in `state/cards.ts` rather than here, which is why there is no comparison in this
 * function at all: `landDetail` and `failRead` both drop an answer whose card has closed or has been
 * read again since. A read is never cancelled — the request is in flight and its answer arrives
 * regardless — so dropping it on arrival is the only place the decision can be made.
 */
async function readCard(
  key: CardKey,
  token: ReadToken,
  table: RecordTable,
  id: string,
): Promise<void> {
  try {
    // THE RECORD IS AWAITED INTO A LOCAL FIRST, and it has to be — the same trap `readRoot` spells
    // out, and it bites harder here because this fires against every open card at once. Written as
    // `setCards(landDetail(state.cards, …, await api.fetchRecord(…)))` the arguments are evaluated
    // left to right, so `state.cards` is read BEFORE the request is even sent; the answer then merges
    // into a snapshot that predates every card opened while it was in flight, and writing it back
    // deletes them. The symptom is not a missing field but a card that vanishes a moment after being
    // opened, whenever something else on the stack happened to be reading.
    const detail = await api.fetchRecord(table, id);
    learnDetail(detail);
    setCards(landDetail(state.cards, key, token, detail));
  } catch (cause) {
    // On the card and never as a toast: a record that is not there is an answer ABOUT the row this
    // card was opened on — one the agent replaced, an id that outlived it — and it belongs in the
    // space it explains rather than blaming the other four cards for it. Whatever was already in
    // hand is kept underneath and comes back when a retry lands.
    const message = messageFor(cause);
    if (message !== null) setCards(failRead(state.cards, key, token, message));
  }
}

/*
 * THERE IS NO DRAFTS SECTION, and nothing here is the client half of a shared writing surface: no
 * save queue per key, no debounce that becomes a save-on-blur, no lease taken while a cursor sits in
 * a box and renewed on a timer, no window token so two of one person's tabs can hold a draft
 * together, no `pagehide` flush with `keepalive` requests for the keystrokes typed since the last
 * blur, no divergence mark for when the agent writes into a draft somebody is mid-sentence in, and
 * no commit path turning unfinished text into a record.
 *
 * Every one of those would exist to answer the same question: what happens when two writers — a
 * person and a model — have their hands on one document. The answer is that they never do. There is
 * ONE writer, and it is the agent: the reader says what they want in the conversation, sees the
 * whole of what is about to be written, and agrees to it. Nothing is half-written anywhere for a
 * lease to protect, nothing diverges, and there is no unfinished text for a `pagehide` to rescue —
 * an unfinished thought is a message somebody has not sent yet, which the composer has always held
 * and which needs none of that machinery.
 */

// -- the live refresh -------------------------------------------------------------------------------------------

/**
 * Refresh the graph and every open record card a beat after the database moved.
 *
 * Debounced because a turn emits `tool_end` in bursts — a script run, three records written, a
 * report published — and refetching per frame would redraw the graph under the cursor of somebody
 * about to drag a row out of it.
 *
 * BOTH columns on one timer, because they are two readings of one database and a turn moves them
 * together: the thesis open in the panel gains its newest assessment at the same moment the graph's
 * box gains the row. The right-hand column holds N records, so this fans out to N reads — the same
 * rule applied a card at a time, and the same reason it is quiet: nobody asked for it.
 *
 * THE TWO LOGS ARE NOT ON THIS TIMER, and neither is the session list. `records_changed` is about
 * the eleven record tables; a log row is not a record, and a session is not in this database at all.
 * Each of those has its own poke naming its own ledger, which is what keeps a viewer nobody has open
 * from re-reading a thousand rows every time the agent writes one.
 *
 * That the graph SURVIVES this is the whole reason `state/graph.ts` merges rather than replaces. A
 * refresh here fires against every box the reader has opened, twice a second while the agent works;
 * a re-sort, a re-pack, or a fold-and-reopen would make the panel unusable exactly when it is most
 * worth watching.
 */
const RECORDS_DEBOUNCE_MS = 500;
let recordsTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRecordsRefresh(): void {
  if (recordsTimer !== null) clearTimeout(recordsTimer);
  recordsTimer = setTimeout(() => {
    recordsTimer = null;
    void refreshGraph();
    void refreshCards();
  }, RECORDS_DEBOUNCE_MS);
}

// -- the socket -------------------------------------------------------------------------------------------------

let socket: ChatSocket | null = null;
let events: EventsClient | null = null;

/**
 * Bring the window up: the two sockets, and the four reads that fill it. Returns its own disposer.
 *
 * Called once, from `App`'s mount effect. Idempotent, because React remounts in development and a
 * second chat socket would mean a second observer on the same agent.
 *
 * BOTH SOCKETS ARE CONNECTED HERE AND STAY CONNECTED. A chat socket that waited for a gesture would
 * be answering the objection that a connection held for a window nobody is looking at is an observer
 * attached to a live agent for no reader — and the dock is always on screen, so that reader always
 * exists. The EVENTS socket is immediate for its own reason: it is what makes this window honest
 * about a database it is not the only writer of, and there is no gesture it belongs to.
 */
export function initStore(): () => void {
  socket ??= new ChatSocket({
    onFrame: handleFrame,
    onState: (connection) => set({ connection }),
    onLost: () => {
      set({ chat: connectionLost(state.chat) });
      void refreshTranscript();
    },
  });
  socket.connect();

  // `onConnect` fires on the first open too, so the boot reads below are not the only path — it is
  // worth having anyway, because the case it exists for is a laptop that slept for an hour and came
  // back to a socket the server hung up on. Everything announced while it was away was announced to
  // nobody, and these two are what catch up: the session list may have gained conversations and
  // renamed the ones it had, and the database has certainly moved.
  events ??= createEventsClient({
    onFrame: handleEvent,
    onConnect: () => {
      void refreshSessions();
      scheduleRecordsRefresh();
    },
  });
  events.connect();

  void refreshHealth();
  // Column zero, once. The graph is a picture of the whole database, so this is the only unprompted
  // read of it in the window's life — everything after it is a frame, a click, or the ↻ button.
  void refreshGraph();
  // The session panel is drawn before anybody has opened a conversation, and it is the way back into
  // one — so it is filled at boot rather than when the chat opens.
  void refreshSessions();

  return () => {
    socket?.dispose();
    socket = null;
    events?.disconnect();
    events = null;
  };
}

/**
 * One events frame.
 *
 * EVERY MEMBER IS A POKE — the server says something moved and nothing about what — so there is
 * nothing here but a decision about what to ask again. That is the whole shape of the channel rather
 * than a property of any one frame, and it is what makes this switch four lines of dispatch instead
 * of a second copy of the state the server already holds. See the header of `lib/protocol.ts` for why
 * the frames carry no payloads.
 *
 * THE THREE LEDGERS ARE ASKED ABOUT SEPARATELY, and that is the only interesting line here.
 * `records_changed` fans out to the graph and the open cards; the two log frames touch neither,
 * because a log row is not a record and nothing in the archive points at one. What a log frame always
 * does is bump its category's nonce — that is the mark on a button somebody has not pressed — and
 * what it does only WHILE THE VIEWER IS OPEN is refetch that ledger's head. A window with the log
 * closed has no business holding a thousand rows of something nobody is reading.
 */
function handleEvent(frame: EventsFrame): void {
  switch (frame.type) {
    case "records_changed":
      scheduleRecordsRefresh();
      return;

    // The nonce moves whichever panel is on screen — that is the mark on the closed chip — and the
    // rows are refetched only for the ledger somebody is actually reading.
    case "error_logged":
      set({ logs: noteLogged(state.logs, "errors") });
      if (state.logs.view === "errors") void refreshLogHead("errors");
      return;

    case "deletion_logged":
      set({ logs: noteLogged(state.logs, "deletions") });
      if (state.logs.view === "deletions") void refreshLogHead("deletions");
      return;

    // A session was minted, renamed by its own summary, resumed or put down. Which of those it was is
    // not said and does not need to be: the list is small, the route reads a directory, and the panel
    // reconciles row by row so a refresh that changed nothing costs no re-render.
    case "sessions_changed":
      void refreshSessions();
      return;

    case "pong":
      return;
  }
}

/**
 * One frame, fanned out.
 *
 * The transcript is the reducer's business; everything else here is CACHE INVALIDATION — the frame
 * is the signal that something the window is drawing has moved, and the answer is to ask the server
 * again rather than to guess what changed. That is the whole reason this app needs no polling.
 *
 * The session id is read BEFORE the reducer runs, because the `ready` case below compares it against
 * what this window thought it was attached to a moment earlier — see this file's header for why that
 * one comparison is the entire mechanism by which a transcript is ever fetched.
 */
function handleFrame(frame: OutboundFrame): void {
  const wasSession = state.chat.sessionId;
  set({ chat: applyFrame(state.chat, frame) });

  switch (frame.type) {
    /**
     * The agent said which conversation it is in. Everything about switching conversations happens
     * here, and nowhere else.
     *
     * THE ID CHANGING IS WHAT FETCHES A TRANSCRIPT, and apart from a turn ending it is the only thing
     * that does. It changes when this window attaches to a conversation already in progress, when a
     * fresh one mints its name mid-turn (`noteSession` re-emits this frame precisely so that a tab
     * which was told `null` learns the name), when somebody resumes an old one under a socket that
     * never moved, and when somebody puts the current one down and it goes back to null. Comparing
     * rather than always fetching is what stops a reconnect mid-answer replacing the transcript
     * underneath a live turn.
     *
     * BLANKING IS THE NARROWER CASE, and the difference between the two is worth the extra line. The
     * window is emptied only when it was showing a DIFFERENT, NAMED conversation — the reader clicked
     * another row, or cleared this one — because then what is on screen belongs to something they are
     * no longer looking at. Going from `null` to a name is the opposite situation: it is a fresh
     * conversation minting its id in the middle of its own first turn, and blanking there would erase
     * the answer being watched as it was written. The frame is then re-applied onto an empty
     * conversation, so the new id, model and flags survive the emptying that was about the old one.
     *
     * NOTHING IS STAGED ACROSS THIS ANY MORE. A creation used to open a conversation of its own, so
     * an opening line was written down before the clear and said from here — the first moment it
     * could be said into the conversation it was meant for. Every `+` speaks into the conversation on
     * screen now, so there is nothing waiting on a swap and nothing for this case to remember.
     *
     * Then the session list, whose live row has just moved.
     */
    case "ready": {
      if (frame.sessionId !== wasSession) {
        if (wasSession !== null) {
          set({ ...blankConversation(), chat: applyFrame(createChatState(), frame) });
        }
        void refreshTranscript();
      }
      void refreshSessions();
      return;
    }

    case "turn_result":
      void refreshTranscript();
      // The SDK writes a conversation's summary after a turn, so the row in the panel is renamed by
      // work that has just finished rather than by anything this window did.
      void refreshSessions();
      scheduleRecordsRefresh();
      return;

    case "tool_end":
      // Whether or not the call succeeded. A refused tool still ran — it may have written rows and
      // rolled back, or written some and refused on the next — and "it failed, so nothing moved" is
      // exactly the assumption a record browser must not make about a database it did not write.
      scheduleRecordsRefresh();
      return;

    // A report is what the agent was working towards, and it is finished — so it goes on the stack
    // and the panel scrolls to it. IT DOES NOT TAKE THE PANEL OVER, which is the thing a stack pays
    // for: this fires at the end of a procedure the reader has very likely spent in some other
    // record working out what to ask next, so it opens beside that record, or focuses the card
    // already showing it, and every other card is left exactly where it was.
    //
    // The nonce is bumped on that ONE card, and only that one. Republishing writes new bytes under
    // the same id, so without a bump the `<iframe>` keyed on it would keep the document it already
    // has; with two reports open, the other one has not changed and must not be remounted.
    case "report_published": {
      const key = cardKey(recordCard("report", frame.reportId, frame.title));
      viewRecord("report", frame.reportId, frame.title);
      setCards(bumpNonce(state.cards, key));
      scheduleRecordsRefresh();
      return;
    }

    // There is no `recipe_changed` case, because there is no such frame and there does not need
    // to be one. A recipe is stored or retired by the agent's own tool, that write announces
    // `records_changed` like every other one, and it reaches the panel by the ordinary path: a
    // `recipe` row like any other, reachable in the graph and through a report's own `recipe` edge.
    // Cache invalidation and nothing more.

    case "generation_started":
      // The procedure's own turn streams in through the ordinary frames, so nothing is drawn
      // differently here yet. What the state buys is the honest answer to "is a report being written
      // right now", which the window needs before it can offer to stop one. The frame names the
      // recipe it will publish under — the conversation is global and the procedure is not — and the
      // banner is not drawing that yet, which is the components' business rather than this file's.
      set({ generation: { id: frame.generationId } });
      return;

    case "generation_ended":
      set({ generation: null });
      // A published report already announces itself through `report_published`; the other three
      // endings are the ones a watcher would otherwise never learn about.
      if (frame.reason !== "published") {
        pushToast(
          frame.reason === "cancelled"
            ? "Report generation cancelled."
            : frame.reason === "completed"
              ? "The generation finished without publishing a report."
              : "Report generation stopped after an error.",
          frame.reason === "completed"
            ? "Read the conversation for what the agent found in the way."
            : null,
        );
      }
      scheduleRecordsRefresh();
      return;

    case "error":
      restoreRefusedText();
      pushToast(
        frame.code === "busy" ? "The agent is still working through what you sent." : "The agent reported a problem.",
        frame.message,
      );
      return;

    default:
      return;
  }
}

/**
 * A refusal handed back the words that never entered the queue; put them where they were typed.
 *
 * What comes back is the SERIALIZED message — the mentions on their line, then the sentence — so a
 * draft that left as two chips and a paragraph returns as text with two mentions at the top of it.
 * The chips are deliberately not reconstituted. Reading them back would mean a parser for the
 * grammar `serializeOutgoing` writes, kept in step with it forever, existing only to redraw a border
 * around something the reader can already see, edit and send again. The message is intact and it is
 * legible; that is the whole obligation here.
 *
 * Only into a composer that is EMPTY — no words and no chips. In the moment between sending and
 * being refused somebody could have started a new sentence or dragged a new record in, and splicing
 * either of those together with what came back would make a message neither of them wrote. When
 * that has happened the words go up as their own toast instead — they were typed and they were not
 * said, and this window does not get to lose them either way.
 */
function restoreRefusedText(): void {
  const taken = takeRefusedText(state.chat);
  if (taken.text === null) return;
  if (state.composer.trim() === "" && state.composerChips.length === 0) {
    set({ chat: taken.state, composer: taken.text });
    return;
  }
  set({ chat: taken.state });
  pushToast("That message was not sent, and you had started another.", taken.text);
}
