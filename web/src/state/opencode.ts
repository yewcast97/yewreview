/**
 * The model pool and the role slots: which models this installation can reach, and which of them
 * answers in which of opencode's roles.
 *
 * PURE and DOM-FREE, like `state/sessions.ts` and `state/notes.ts` and for the same reason — `bun
 * test` drives it directly under the root tsconfig, so the orderings that are miserable to reproduce
 * by hand (a save landing while another is in flight, a role left naming a model somebody deleted in
 * another tab) are asserted rather than hoped for. Nothing here reads `window` and nothing here
 * fetches; the store owns both.
 *
 * ONLY ONE HARNESS HAS ANY OF THIS. The Claude path does not mount the routes behind it and draws
 * none of the controls, so every field below is at its initial value there for the life of the
 * window — which costs nothing and is why there is no second store to switch between.
 *
 * ── THE POOL IS CONFIGURATION, AND THAT DECIDES WHEN IT IS READ ───────────────────────────────────
 *
 * NOTHING POLLS IT AND NO FRAME ANNOUNCES IT. Every other read in this window is push-driven cache
 * invalidation: the socket says the database moved and the store asks again. The pool is not in that
 * database — it is a file of credentials beside it, the same kind of thing `--port` is — so
 * `records_changed` does not cover it and there is no poke that would. It is read exactly twice:
 * when the window learns from `/api/health` that it is on the opencode harness, because the row of
 * role slots above the composer is drawn from it whether or not the pool is open; and whenever the
 * reader opens the pool, which is the moment another tab's edit would matter. After that the only
 * thing that moves it is a save, and A SAVE ANSWERS WITH THE WHOLE DOCUMENT — the route replaces the
 * pool wholesale and hands back what it stored — so what a PUT returns is landed directly rather
 * than triggering a re-read. Two tabs cannot disagree about a document that only ever arrives whole.
 *
 * ── WHAT IS AND IS NOT HELD HERE ──────────────────────────────────────────────────────────────────
 *
 * NO DRAFT STATE. The four boxes on a model note hold what somebody is typing in the component that
 * draws them, seeded once per entry and committed on blur, exactly as the record panel's forms work.
 * A half-typed API key kept in the store would be a keystroke's worth of re-render across the whole
 * window, and it would still not be a draft in any sense the server knows about.
 *
 * THE ROLES ARE A PLAIN RECORD keyed by whatever words the server sent in `roles_vocabulary`, never
 * by a union this bundle declares. They are opencode's own agents, read off the binary on the
 * server's side; a window carrying its own list would draw a slot for a role that had been renamed
 * and quietly stop drawing one that had appeared. THE FIRST WORD IN THE VOCABULARY IS THE ROLE THAT
 * ANSWERS an ordinary turn — the server's `PRIMARY_ROLE`, and `tests/webOpencode.test.ts` pins that
 * coupling against the server's own constants, because one thing below depends on it: see
 * `addedModel`.
 *
 * AN ASSIGNMENT MAY DANGLE. `roles` names a model by id, and nothing here guarantees the id is in
 * `models` — a pool edited in another tab between two reads is enough. `assignmentFor` reports that
 * as its own case rather than as "empty", so the slot can show the bare id: a slot that read `—`
 * over a role the config actually routes somewhere would be the window lying about what answers.
 */

import type { OpencodeModel, OpencodePool, OpencodePoolWrite } from "../lib/api.ts";

/** The four boxes on a model note, in the order they are drawn. `id` is not among them: it is minted
 * when the note is pinned up and is never shown, let alone typed. */
export const MODEL_FIELDS = ["name", "url", "api", "model"] as const;

export type ModelField = (typeof MODEL_FIELDS)[number];

export type OpencodeState = {
  /** The pool, in the order the server holds it — which is the order the notes are drawn in, so a
   * note does not move under the pointer when the one beside it is edited. */
  readonly models: readonly OpencodeModel[];
  /** Role → model id. A role with no model is ABSENT rather than null, which is how the server
   * spells it too: a null would be a third state neither side reads. */
  readonly roles: Readonly<Record<string, string>>;
  /** The roles there are, in the server's order. Empty until the first read, which is the honest
   * state for "this window has not been told what the roles are" — the slots draw nothing. */
  readonly vocabulary: readonly string[];
  /** Whether the pool panel is up. Session-lifetime and deliberately not persisted: it is a thing
   * the reader opened a moment ago, not a preference. */
  readonly poolOpen: boolean;
  readonly loading: boolean;
  /** Why the pool is empty, when the reason is that the read failed — drawn in the panel it explains
   * rather than as a toast, on the rule every other read-out in this window follows. */
  readonly error: string | null;
  /** Which role slot a dragged model is being held over, or null. One field for one gesture, in the
   * store rather than in the row, because the thing being dragged and the thing lighting up are two
   * components with no ancestor between them but the dock. */
  readonly slotHot: string | null;
};

const NO_MODELS: readonly OpencodeModel[] = [];
const NO_ROLES: Readonly<Record<string, string>> = {};
const NO_VOCABULARY: readonly string[] = [];

export function createOpencodeState(): OpencodeState {
  return {
    models: NO_MODELS,
    roles: NO_ROLES,
    vocabulary: NO_VOCABULARY,
    poolOpen: false,
    loading: false,
    error: null,
    slotHot: null,
  };
}

// -- reading it ---------------------------------------------------------------------------------------

/**
 * A read has started.
 *
 * What is held stays on screen and the standing error goes. The pool is read again every time the
 * panel is opened, and a panel that emptied itself for the length of a loopback request would blink
 * its whole contents at the reader for no news.
 */
export function beginPoolRead(state: OpencodeState): OpencodeState {
  if (state.loading && state.error === null) return state;
  return { ...state, loading: true, error: null };
}

/**
 * The read failed, or a save was refused.
 *
 * The models already in hand stay: a pool that could not be re-read is still a true account of what
 * this installation could reach a moment ago, and blanking it would take the reader's own
 * credentials off the screen because a request timed out. A repeat of the same sentence hands back
 * the same state, so a server that is down does not redraw the panel per attempt.
 */
export function failPoolRead(state: OpencodeState, message: string): OpencodeState {
  if (!state.loading && state.error === message) return state;
  return { ...state, loading: false, error: message };
}

/**
 * The pool came back — from a read or from a save, which answer with the same shape on purpose.
 *
 * RECONCILED RATHER THAN REPLACED, entry by entry: a model that reads the same as the one already
 * held keeps the object it already had, so a save that changed one url hands the panel one new note
 * and leaves the rest alone. If every entry survives that, the order is unchanged, and the roles and
 * the vocabulary say what they said, the state itself is returned — which matters because each of
 * those notes holds four boxes somebody may be typing in.
 *
 * The answer is taken as the COMPLETE document: a model it does not name is gone, and a role it does
 * not name is unassigned. That is the honest reading of a route that replaces the pool whole.
 */
export function landPool(state: OpencodeState, pool: OpencodePool): OpencodeState {
  const held = new Map(state.models.map((entry) => [entry.id, entry]));
  const reconciled = pool.entries.map((entry) => {
    const before = held.get(entry.id);
    return before !== undefined && sameModel(before, entry) ? before : entry;
  });
  const modelsUnmoved =
    reconciled.length === state.models.length &&
    reconciled.every((entry, index) => entry === state.models[index]);
  const rolesUnmoved = sameRoles(state.roles, pool.roles);
  const vocabularyUnmoved =
    pool.roles_vocabulary.length === state.vocabulary.length &&
    pool.roles_vocabulary.every((role, index) => role === state.vocabulary[index]);

  if (
    modelsUnmoved &&
    rolesUnmoved &&
    vocabularyUnmoved &&
    !state.loading &&
    state.error === null
  ) {
    return state;
  }
  return {
    ...state,
    models: modelsUnmoved ? state.models : reconciled,
    roles: rolesUnmoved ? state.roles : { ...pool.roles },
    vocabulary: vocabularyUnmoved ? state.vocabulary : [...pool.roles_vocabulary],
    loading: false,
    error: null,
  };
}

/**
 * Whether two readings of one model say the same thing. Every field, because every one of them is
 * in a box the reader can see — including the credential, which is exactly the field somebody would
 * be checking when a refresh landed.
 *
 * Exported because the note that holds those boxes asks the same question of what is typed in them:
 * a blur that changed nothing is not a save, and "nothing" is this comparison.
 */
export function sameModel(a: OpencodeModel, b: OpencodeModel): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.url === b.url &&
    a.api === b.api &&
    a.model === b.model
  );
}

function sameRoles(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

// -- the two things a reader can be doing to it --------------------------------------------------------

/** Open the pool, or put it away. Written only on the transition, because the word in the composer
 * that toggles this is also drawn from it. */
export function setPoolOpen(state: OpencodeState, open: boolean): OpencodeState {
  if (state.poolOpen === open) return state;
  return { ...state, poolOpen: open };
}

/** Light one slot, or put them all out. Written only on the transition: the gesture that calls this
 * fires on every pointer move, and most moves are inside the slot the pointer is already over. */
export function setSlotHot(state: OpencodeState, role: string | null): OpencodeState {
  if (state.slotHot === role) return state;
  return { ...state, slotHot: role };
}

// -- what a slot says -----------------------------------------------------------------------------------

/**
 * What one role resolves to.
 *
 * THREE CASES AND NOT TWO. "Empty" and "assigned to a model that is not here" are different facts
 * about the config opencode was started with — the first routes nothing and falls back to opencode's
 * own default, the second is a pool that has moved since this window read it — and a slot that drew
 * them the same way would be reporting a route that does not exist as no route at all.
 */
export type Assignment =
  | { readonly kind: "empty" }
  | { readonly kind: "model"; readonly model: OpencodeModel }
  | { readonly kind: "dangling"; readonly id: string };

const EMPTY_ASSIGNMENT: Assignment = { kind: "empty" };

export function assignmentFor(state: OpencodeState, role: string): Assignment {
  const id = state.roles[role];
  if (id === undefined) return EMPTY_ASSIGNMENT;
  const model = state.models.find((entry) => entry.id === id);
  return model === undefined ? { kind: "dangling", id } : { kind: "model", model };
}

/**
 * What a model is CALLED wherever it is not being edited: the slot it answers in, the row in that
 * slot's menu.
 *
 * Falls back through what is filled in rather than showing a blank, and ends at the id, which is the
 * one field that is never empty. A note somebody has pinned up and not yet typed into is still a
 * thing they have to be able to point at.
 */
export function modelLabel(model: OpencodeModel): string {
  if (model.name !== "") return model.name;
  if (model.model !== "") return model.model;
  return model.id;
}

/**
 * The role that answers an ordinary turn, or null before the vocabulary has arrived.
 *
 * THE FIRST WORD THE SERVER SENT, which is a coupling and is pinned as one: `roles_vocabulary` is
 * the server's `OPENCODE_ROLES`, whose first member is its `PRIMARY_ROLE`, and
 * `tests/webOpencode.test.ts` asserts that against the server's own constants so a reordering there
 * fails a test here rather than quietly moving what this window treats as primary. The alternative —
 * hard-coding `"build"` — would be the same coupling with nothing checking it.
 */
export function primaryRole(state: OpencodeState): string | null {
  return state.vocabulary[0] ?? null;
}

// -- the documents a change would save --------------------------------------------------------------------
//
// Five functions, each answering the same question — what the whole pool would be if this happened —
// because the route takes the whole pool and nothing else. They are pure and they are HERE rather
// than in the store so the awkward halves can be asserted directly: that deleting a model takes every
// role naming it with it, and that the first model added lands in the primary slot.
//
// None of them writes to the state. The state moves when the answer comes back, which is the only
// moment this window knows what was actually stored.

/** The pool as it stands, ready to be sent back with one thing changed. Not named `document`, which
 * is a DOM global this module has no business shadowing. */
function poolWith(state: OpencodeState, entries: readonly OpencodeModel[]): OpencodePoolWrite {
  return { entries, roles: state.roles };
}

/**
 * A blank model, pinned to the end of the pool.
 *
 * AND, WHEN NOTHING ANSWERS THE PRIMARY ROLE, ASSIGNED TO IT — which is not a preference this window
 * is expressing. The server refuses to store a pool that has models in it and nothing answering the
 * role that answers turns, and its refusal says to drag a model onto that slot; for the FIRST model
 * there is no model on the board to drag, so the gesture that adds one would be refused every time
 * and the reader would never get past an empty pool. Filling the slot with the note being pinned up
 * is the one way to satisfy that rule at the moment it first bites, and it is visible the instant it
 * happens — the slot below the composer shows the new note's name — and the reader can move it.
 *
 * A pool that already routes its primary role adds models unassigned, because there is nothing to
 * satisfy: a second model is one the reader will route themselves.
 */
export function addedModel(state: OpencodeState, id: string): OpencodePoolWrite {
  const entry: OpencodeModel = { id, name: "", url: "", api: "", model: "" };
  const entries = [...state.models, entry];
  const primary = primaryRole(state);
  if (primary === null || assignmentFor(state, primary).kind === "model") {
    return poolWith(state, entries);
  }
  return { entries, roles: { ...state.roles, [primary]: id } };
}

/**
 * One note, committed. The rest of the document rides along untouched, which is what makes a
 * whole-document PUT safe to fire on a blur.
 *
 * THE WHOLE NOTE RATHER THAN THE ONE BOX THAT LOST THE CARET, and the difference is a race. A reader
 * tabbing from `name` into `url` blurs twice in the time a loopback PUT takes to answer; a
 * per-box document is built from the pool AS HELD, which for the second blur still says what the
 * first one has not landed yet — so the second save would carry the new url and quietly put the old
 * name back. The note's four boxes are one draft and are sent as one, so the later write is a
 * superset of the earlier rather than a contradiction of it.
 *
 * What that costs is the case where another tab changed a field of this same note between the seed
 * and the blur: the draft is authoritative for all four boxes, so that change is overwritten. Two
 * windows editing one model's credential at once is a rarer thing than tabbing between two boxes,
 * and the note shows exactly what it is about to send either way.
 *
 * The stored `id` is kept rather than taken from the draft: it is not a box and nothing may edit it.
 */
export function updatedModel(
  state: OpencodeState,
  id: string,
  next: OpencodeModel,
): OpencodePoolWrite {
  return poolWith(
    state,
    state.models.map((entry) => (entry.id === id ? { ...next, id: entry.id } : entry)),
  );
}

/**
 * A model taken out of the pool, and every role that named it left empty.
 *
 * BOTH HALVES IN ONE DOCUMENT, and the route is why: it validates what it is given as a whole and
 * refuses a role pointing at a model that is not there. Sending the shorter entry list on its own
 * would be refused outright, and sending the two as two requests would leave a window between them
 * in which the stored pool was exactly the thing the route exists to reject.
 *
 * A role emptied this way is emptied and nothing more. Re-homing it onto whichever model happened to
 * be next would be this window deciding what answers a turn — and if the role in question is the
 * primary one, the save is refused with a sentence saying so, which the reader can act on by
 * assigning another model first. That refusal is a real answer; a silent substitution would not be.
 */
export function removedModel(state: OpencodeState, id: string): OpencodePoolWrite {
  const roles: Record<string, string> = {};
  for (const [role, held] of Object.entries(state.roles)) {
    if (held !== id) roles[role] = held;
  }
  return { entries: state.models.filter((entry) => entry.id !== id), roles };
}

/** One role pointed at one model. The id is not checked against the pool here — the route does that,
 * and its refusal names the role. */
export function assignedRole(state: OpencodeState, role: string, id: string): OpencodePoolWrite {
  return { entries: state.models, roles: { ...state.roles, [role]: id } };
}

/** One role emptied, which is how a slot goes back to opencode's own default. Absent rather than
 * null — see `roles`. */
export function clearedRole(state: OpencodeState, role: string): OpencodePoolWrite {
  const roles: Record<string, string> = {};
  for (const [held, id] of Object.entries(state.roles)) {
    if (held !== role) roles[held] = id;
  }
  return { entries: state.models, roles };
}
