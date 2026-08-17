/**
 * The HTTP layer: one function per request this window actually makes, and nothing else.
 *
 * THIS WINDOW READS. Every record in the archive — a recipe, an information source, a thesis, a
 * report, and the tables that were never the reader's to write — is created,
 * corrected, renamed and deleted by ASKING THE AGENT for it in the conversation, and the agent
 * writes the row through its own tools once the reader has seen what it is about to write. So there
 * is no `createWorkshop` here, no `revisePlaybook`, no `createSource`, no `renameRecord`, and no
 * delete of anything: the ROUTES those wrapped are gone from the server too, which is what makes
 * their absence a fact about the product rather than a habit of this file. `lib/awareness.ts` holds
 * what a `+` says instead.
 *
 * WHAT IS LEFT THAT IS NOT A GET IS FOUR THINGS, AND NONE OF THEM WRITES A RECORD. An upload puts a
 * dropped file where the agent can read it; the model pool is a credential file rather than a table;
 * the venv retry re-runs an install; and resuming, clearing or deleting a session says which
 * conversation the next turn belongs to. Every one of those is a DECISION about the installation or
 * the conversation, and not a claim about the world that would land in the archive.
 *
 * STARTING A GENERATION USED TO BE THE FIFTH, and was described here as the one authority boundary
 * this window held: the agent could not open a procedure, so "published only inside a generation"
 * had somebody outside the conversation turning the key. It is asked for in the conversation now
 * (`start_generation`), and what actually holds a report up was never the route — it is that the
 * account of what produced it comes off a log the machine kept, that the recipe it names cannot be
 * edited, and that the archive is frozen while it runs.
 *
 * THE READS ARE VERY NEARLY ONE PER ROUTE. There are no per-table ones — `/api/theses`,
 * `GET /api/sources`, `/api/reports` and five more — because the record browser reads every table
 * through `/api/records/**`. Those eight are absent from the SERVER rather than merely uncalled here
 * — a read with no caller is not a smaller surface, it is a larger one nobody is checking — and
 * `tests/server.test.ts` pins them as absent. Beside them is the reading side of things this window
 * does not own at all: the conversation is the agent SDK's own session store, read back whole; the
 * session list is a directory of those conversations; the two logs are capped ledgers of what went
 * wrong and what was destroyed.
 *
 * Every URL is RELATIVE. The window is served by the same process that answers `/api`, which is the
 * whole reason there is no CORS header on that server and no base URL to configure here — see the
 * header of `src/server/serve.ts`. A dev build and the compiled binary are the same origin, so
 * there is no environment to get wrong.
 *
 * NO ROW TYPE IS DECLARED OR IMPORTED HERE ANY MORE. `Recipe`, `Source` and their
 * schemas were here to spell the BODIES of writes and to read the rows those writes answered with;
 * with the writes gone, every row this window sees arrives through the record browser as a
 * `RecordDetail` — a card, a row of columns, and the edges on both sides of it — which is one shape
 * for eleven tables and the only one a reader is ever shown. The record-browser shapes come from
 * `lib/records.ts`, the mirror that exists because their repository does not typecheck without Bun's
 * globals; see that file's header. The transcript, the session rows and the two kinds of log row come
 * from `lib/protocol.ts` for the same reason and with a stronger guarantee — a test assigns those
 * declarations to the server's own in both directions, so a field renamed over there fails a
 * typecheck. Between the two of them there is no third declaration of a response shape here, which
 * is the point: a hand-written copy is where a window keeps believing a field the server stopped
 * sending.
 *
 * EVERY ANSWER IS PARSED BEFORE IT IS BELIEVED. `getJson` and `sendJson` each take the schema for
 * what they are asking for, so there is no path through this file where a body reaches a caller
 * having only been ASSERTED to be the right shape. A body that does not match is an `ApiError` of
 * kind `internal` — the same thing the window already shows for a server answering something it
 * cannot use — rather than an exception of a new kind for every call site to learn about, and an
 * abort is still rethrown untouched from the body read as well as from the request. The schemas
 * themselves are `z.object` rather than `z.strictObject`: see the section that holds them.
 *
 * Every failure arrives as an `ApiError`. The server answers a refusal as `{error, message}` with
 * the repository's own kind in `error`, and that kind is what the UI branches on — a `conflict` from
 * resuming a conversation while the agent is mid-turn is a toast, a `not_found` on a session the SDK
 * has pruned is an empty state, and neither is a malfunction. `message` is written for a person to
 * read and is shown verbatim; it is the server's sentence, and rewording it here would be inventing a
 * friendlier lie.
 *
 * Anything a newer request supersedes takes an `AbortSignal`, and an abort is rethrown untouched: a
 * superseded call is not a failure and must never be reported as one.
 */

import { z } from "zod";

import type { RecordDetail, RecordGroup, RecordPage, RecordTable } from "./records.ts";
import { recordDetailSchema, recordGroupSchema, recordPageSchema } from "./records.ts";
import type {
  DeletionLogEntry,
  ErrorLogEntry,
  RefusalKind,
  SessionCard,
  TranscriptItem,
} from "./protocol.ts";
import {
  deletionLogEntrySchema,
  errorLogEntrySchema,
  refusalKindSchema,
  sessionCardSchema,
  transcriptItemSchema,
} from "./protocol.ts";
import { exact } from "./schema.ts";
/**
 * Which ledger `/api/logs` is being asked for — the two words the route itself takes.
 *
 * Imported from the pure model that HOLDS the two ledgers rather than declared again here, and the
 * import direction is deliberate even though it points at `state/`: `state/logs.ts` is where the
 * category means something (it selects a page, a nonce and a section of the viewer), this file only
 * spells it into a query string, and a second declaration is exactly where the two spellings would
 * come to disagree by one letter. It is a type-only import, so nothing crosses at runtime.
 */
import type { LogCategory } from "../state/logs.ts";

export type {
  JunctionTable,
  RecordCard,
  RecordDetail,
  RecordGroup,
  RecordPage,
  RecordTable,
} from "./records.ts";

/** The status an `ApiError` carries when the request never reached the server at all. */
const NETWORK_ERROR_STATUS = 0;

/** The uniform refusal body: the kind the repository raised, and a sentence for a person. */
export type RefusalBody = { error?: string; message?: string };

/**
 * A request YewReview answered with a non-2xx, or could not make at all.
 *
 * `kind` is the branch point and it is always populated: the router's own `error` string when the
 * server sent one, `"network"` when the server could not be reached, and `"internal"` for a body
 * that was not the uniform shape. A caller that wants to treat a refusal differently from a
 * malfunction reads `kind`; a caller that just wants to say something reads `message`.
 */
export class ApiError extends Error {
  readonly kind: RefusalKind;
  readonly status: number;
  readonly body: RefusalBody | null;

  constructor(kind: RefusalKind, status: number, message: string, body: RefusalBody | null = null) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.body = body;
  }

  /** Whether the server refused because the thing asked about is not there. The one check common
   * enough — a deleted recipe, a conversation the SDK has pruned — to be worth a name. */
  get isNotFound(): boolean {
    return this.kind === "not_found";
  }
}

/** Whether a rejection is an abort rather than a failure. Callers that race requests check this
 * before reporting anything, because an abort is a request the app itself withdrew. */
export function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

// -- the response shapes ----------------------------------------------------------------------------

export type VenvHealth = { ready: boolean; seikanVersion: string | null; error: string | null };

/**
 * Which harness answers this installation's conversation.
 *
 * A HAND-MIRROR of `Harness` in `src/config.ts`, on the `lib/protocol.ts` precedent and for a
 * blunter version of the same reason: that module cannot be imported here at all — it reaches the
 * agent SDK and `node:path`, and this project declares no server types — so the two words are
 * written again. `tests/webOpencode.test.ts` assigns this to the server's own in both directions,
 * so a third harness fails a typecheck rather than landing in the window as a string nothing
 * branches on.
 */
export type Harness = "claudecode" | "opencode";

/**
 * Whether the server's process may write the archive, or is read-only for its life.
 *
 * A hand-mirror of `ProcessMode` in `src/db/lock.ts`, on the `Harness` precedent above: the first
 * process on a var root holds the write claim for as long as it runs, and every later one serves
 * the same archive read-only until a restart after the writer exits.
 */
export type ProcessMode = "writer" | "reader";

/** Whether the opencode binary is here and drivable, and what to do about it when it is not. Absent
 * from `Health` entirely on the Claude path: a status for a program that boot never looked for
 * would be an answer to a question nobody asked. */
export type OpencodeHealth = {
  installed: boolean;
  version: string | null;
  ok: boolean;
  hint: string | null;
};

export type Health = {
  ok: boolean;
  version: string;
  schemaVersion: number;
  model: string;
  venv: VenvHealth;
  sandbox: { available: boolean; hint: string | null };
  /** Which chrome to draw. The window is written once for both harnesses; this is the one fact that
   * decides the handful of controls that exist on one path and not the other. */
  harness: Harness;
  /** Whether this process holds the pen — `reader` means every write here is refused and the
   * writing process's window is where changes happen. */
  mode: ProcessMode;
  /** Only on the opencode harness — see `OpencodeHealth`. */
  opencode?: OpencodeHealth;
};

/**
 * One model this installation can reach: everything needed to call it, and the id the window minted
 * for it.
 *
 * FIVE FIELDS, THOUGH THE READER FILLS IN FOUR. `id` is minted here and never shown — it is the
 * provider id in the config rendered for opencode and the string a role assignment names — and the
 * other four are the note's boxes. Every one of them may be blank: a note pinned to the board is
 * empty until somebody types in it, and the pool refuses only what could not be rendered into a
 * coherent config.
 */
export type OpencodeModel = {
  id: string;
  name: string;
  url: string;
  api: string;
  model: string;
};

/**
 * The whole pool as the route answers it: the models, which role each one answers in, and the roles
 * there are to answer in.
 *
 * `roles_vocabulary` is snake_case because that is what crosses the wire, and it comes back on every
 * answer rather than from a constant in this bundle: the roles are opencode's own agents, verified
 * against the binary on the server's side, and a window that carried its own list would draw a slot
 * for a role that had been renamed. It arrives in the server's order, which is the order the slots
 * are drawn in — and the FIRST of them is the role that answers an ordinary turn, which
 * `tests/webOpencode.test.ts` pins against the server's own `PRIMARY_ROLE`.
 *
 * `roles` is a plain record rather than a union-keyed one, for the reason above: the keys are the
 * vocabulary the server sent, not a vocabulary this build knows.
 */
export type OpencodePool = {
  entries: OpencodeModel[];
  roles: Record<string, string>;
  roles_vocabulary: string[];
};

/** What a save SENDS: the whole document, because the route replaces it whole. There is no patch
 * and no per-entry route — see `putOpencodePool`. */
export type OpencodePoolWrite = {
  entries: readonly OpencodeModel[];
  roles: Readonly<Record<string, string>>;
};

/**
 * One conversation, whole.
 *
 * `sessionId` rides back beside the items even though the caller asked by it, and that is not
 * redundancy: the window fetches by an id it was told over a socket, and an answer that names itself
 * is what lets a late reply be dropped rather than adopted into whichever conversation is on screen
 * by the time it lands.
 */
export type TranscriptAnswer = { sessionId: string; items: TranscriptItem[] };

/**
 * Every conversation this installation has had, and which one is live.
 *
 * `current` says the same thing the rows' `live` flag does, and both are the server's word rather
 * than this window's. It is there for the case the rows cannot cover: a client with an empty list
 * still learns that a conversation is in progress.
 */
export type SessionList = { sessions: SessionCard[]; current: string | null };

/** What `/api/logs` answers: which ledger it read, the rows newest first, and whether the ledger
 * continues below them. Deliberately not called a page — `state/logs.ts` reserves that word for a
 * ledger as the VIEWER holds it, which additionally knows whether a read is in flight. */
export type LogRead = {
  category: LogCategory;
  entries: (ErrorLogEntry | DeletionLogEntry)[];
  hasMore: boolean;
};

// -- what an answer has to be ----------------------------------------------------------------------
//
// One schema per shape above, each tied to its declaration by `exact`, which fails the typecheck
// unless the schema parses precisely that type. The types stay the source of truth — several of them
// are pinned to the server's own by `tests/webProtocol.test.ts` — and the schemas are how the window
// finds out whether the bytes that arrived are one of them.
//
// EVERY OBJECT IS `z.object`, NEVER `z.strictObject`, which is the opposite of the choice the agent's
// tools make in `src/tools/common.ts` and opposite on purpose. A tool's arguments come from a
// model, and an undeclared one there is a mistake worth refusing outright: a `publish_report` that
// silently dropped a misspelled field would publish a report missing half its declarations. These are
// ANSWERS, from a server that may be NEWER than the window reading it — a tab left open across an
// upgrade is the ordinary case, not the exotic one — so a response refused for carrying a field this
// build has never heard of would turn a compatible addition into an app that stops drawing. Unknown
// keys are dropped on the way in rather than carried through, which is what stops anything downstream
// from coming to depend on one without declaring it.
//
// What that leniency does NOT extend to is a field this window actually reads: a missing one, a
// string where a number belongs, or a null in a column declared non-null is a refusal, because those
// are the answers a window draws `undefined` from and reports nothing about.

const venvHealthSchema = exact<VenvHealth>()(
  z.object({
    ready: z.boolean(),
    seikanVersion: z.string().nullable(),
    error: z.string().nullable(),
  }),
);

/** Whether an OS sandbox is available here, and what to do about it when it is not. Its own schema
 * rather than an object spelled inside `healthSchema`, because a shape nested inside another has to
 * be one — see `lib/schema.ts` on why `exact` compares one level at a time. */
const sandboxSchema = exact<Health["sandbox"]>()(
  z.object({ available: z.boolean(), hint: z.string().nullable() }),
);

/** The opencode block, its own schema for the reason the sandbox one above is: a shape nested inside
 * another has to be one. `.optional()` is what makes the Claude path's silence legal — and the only
 * legal way to be silent, since a `null` here would be a third state nothing reads. */
const opencodeHealthSchema = exact<OpencodeHealth>()(
  z.object({
    installed: z.boolean(),
    version: z.string().nullable(),
    ok: z.boolean(),
    hint: z.string().nullable(),
  }),
);

const healthSchema = exact<Health>()(
  z.object({
    ok: z.boolean(),
    version: z.string(),
    schemaVersion: z.number(),
    model: z.string(),
    venv: venvHealthSchema,
    sandbox: sandboxSchema,
    // Checked against the two words rather than against "some string", on the `sourceSchema`
    // precedent: this is read as a branch, and a third harness from a newer server is something this
    // build cannot draw chrome for. Saying so beats filing it under whichever branch is last.
    harness: z.enum(["claudecode", "opencode"]),
    // Two words, on the `harness` argument one line up: a third mode is chrome this build cannot
    // draw, and `exact<Health>()` keeps this line and the type moving together.
    mode: z.enum(["writer", "reader"]),
    opencode: opencodeHealthSchema.optional(),
  }),
);

const opencodeModelSchema = exact<OpencodeModel>()(
  z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    api: z.string(),
    model: z.string(),
  }),
);

/** Both the read and the write answer this, which is the whole point of the route: a PUT hands back
 * the document it stored, so the window lands what came back instead of asking again. */
const opencodePoolSchema = exact<OpencodePool>()(
  z.object({
    entries: z.array(opencodeModelSchema),
    roles: z.record(z.string(), z.string()),
    roles_vocabulary: z.array(z.string()),
  }),
);

const venvAnswerSchema = exact<{ venv: VenvHealth }>()(z.object({ venv: venvHealthSchema }));

/*
 * THERE ARE NO PER-TABLE ROW SCHEMAS HERE, and there is nothing left for one to check. A
 * a `recipeSchema` and a `sourceSchema` existed to read the row a write answered
 * with — and every write has gone to the agent. A row now arrives one way only, inside a
 * `RecordDetail`, whose schema `lib/records.ts` owns for all eleven tables at once; a second
 * declaration of three of those tables here would be a copy kept in step by hand for no reading it
 * makes possible.
 */

const transcriptAnswerSchema = exact<TranscriptAnswer>()(
  z.object({ sessionId: z.string(), items: z.array(transcriptItemSchema) }),
);

const sessionListSchema = exact<SessionList>()(
  z.object({ sessions: z.array(sessionCardSchema), current: z.string().nullable() }),
);

const resumedSchema = exact<{ sessionId: string; summary: string }>()(
  z.object({ sessionId: z.string(), summary: z.string() }),
);

const logCategorySchema = exact<LogCategory>()(z.enum(["errors", "deletions"]));

/**
 * One page of one ledger.
 *
 * The rows are a UNION of the two shapes rather than a page-shaped guess from `category`, and the two
 * share only `id` and `at` — so a page that said `deletions` and carried error rows is refused here
 * rather than drawn in the wrong viewer. Which is worth the check precisely because the route takes
 * the category as a query parameter: it is the one field of this answer a caller can get wrong.
 */
const logReadSchema = exact<LogRead>()(
  z.object({
    category: logCategorySchema,
    entries: z.array(z.union([errorLogEntrySchema, deletionLogEntrySchema])),
    hasMore: z.boolean(),
  }),
);

const uploadedSchema = exact<{ path: string }>()(z.object({ path: z.string() }));

/** The uniform refusal body. Both fields are optional because a refusal is the one answer that may
 * arrive from something other than this router — a proxy, a dev server — with only a status to its
 * name, and the status alone is still worth showing. */
const refusalBodySchema = exact<RefusalBody>()(
  z.object({ error: z.string().optional(), message: z.string().optional() }),
);

// -- the machinery ------------------------------------------------------------------------------------

async function refusalFor(response: Response): Promise<ApiError> {
  let body: RefusalBody | null = null;
  try {
    const text = await response.text();
    if (text) {
      const read = refusalBodySchema.safeParse(JSON.parse(text));
      if (read.success) body = read.data;
    }
  } catch {
    // A non-JSON body is not worth a second failure; the status still says enough to show.
  }
  // The kind is READ rather than asserted, and it is the one string in this file most worth reading:
  // every branch the UI makes about a failure turns on it. A word outside the union — a kind a newer
  // server invented, a value that is not a word at all — lands on `internal`, which is exactly where
  // a refusal that named no kind lands, rather than on a value none of the switches downstream have a
  // case for.
  const kind = refusalKindSchema.safeParse(body?.error);
  // Blank counts as absent. A refusal whose sentence is an empty string tells the reader nothing,
  // and the status line at least says what happened.
  const message =
    body?.message !== undefined && body.message.trim() !== ""
      ? body.message
      : `${response.status} ${response.statusText || "request failed"}`.trim();
  return new ApiError(kind.success ? kind.data : "internal", response.status, message, body);
}

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    // A local server the user restarts is down often enough that this is an ordinary answer rather
    // than an exception: it arrives as an ApiError like every other failure, told apart by `kind`.
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ApiError(
      "network",
      NETWORK_ERROR_STATUS,
      detail || "could not reach YewReview — is the server still running?",
    );
  }
  if (!response.ok) throw await refusalFor(response);
  return response;
}

/**
 * The body of an answer the server was happy with, READ against the shape that was asked for.
 *
 * A 2xx says the request was understood; it says nothing about whether what came back is what this
 * build knows how to draw. So the body is parsed, and a body that is not the shape becomes an
 * `ApiError` of kind `internal` — the same thing every other unusable answer is, arriving at the same
 * `catch` the caller already has, rather than a `TypeError` from somewhere three components deep
 * where the missing field was finally read.
 *
 * An abort is rethrown untouched. A body read is where a superseded request usually dies — the
 * headers arrived before the newer call went out and the bytes did not — and reporting that as a
 * malfunction would put a toast on screen for a request the app itself withdrew.
 */
async function readJson<T>(response: Response, schema: z.ZodType<T>, path: string): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw new ApiError("internal", response.status, `${path} answered something that is not JSON`);
  }
  const read = schema.safeParse(payload);
  if (read.success) return read.data;
  // The first complaint, with the field it is about. Zod reports every fault; a sentence naming one
  // of them and where it is beats a page of them in a toast, and the field is the part that says
  // which side of the wire to go and look at.
  const fault = read.error.issues[0];
  const where = fault && fault.path.length > 0 ? ` at ${fault.path.map(String).join(".")}` : "";
  throw new ApiError(
    "internal",
    response.status,
    `${path} answered a body this window cannot read${where}: ` +
      `${fault?.message ?? "it is not the shape this build expects"}`,
  );
}

/**
 * A GET, and what it must answer with.
 *
 * The schema is an ARGUMENT rather than a type parameter because a type parameter is a claim and a
 * schema is a check — `getJson<Health>(…)` would compile against a route that answers anything at
 * all, and this cannot.
 *
 * `signal ?? null` because `RequestInit.signal` is `AbortSignal | null`: null is the platform's own
 * spelling for "no signal", and an absent parameter means the same thing.
 */
async function getJson<T>(schema: z.ZodType<T>, path: string, signal?: AbortSignal): Promise<T> {
  const response = await send(path, {
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
  return readJson(response, schema, path);
}

async function sendJson<T>(
  schema: z.ZodType<T>,
  method: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await send(path, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    signal: signal ?? null,
  });
  return readJson(response, schema, path);
}

/** Only defined keys reach the wire: the router reads a blank parameter as "not sent" anyway, and
 * a URL carrying `?limit=undefined` is a refusal waiting to happen. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

// -- health -------------------------------------------------------------------------------------------

export function fetchHealth(signal?: AbortSignal): Promise<Health> {
  return getJson(healthSchema, "/api/health", signal);
}

/** Re-run the measurement engine's provisioning. The server runs one at a time however many times
 * this is called, so a second click costs nothing. */
export function retryVenv(signal?: AbortSignal): Promise<{ venv: VenvHealth }> {
  return sendJson(venvAnswerSchema, "POST", "/api/venv/retry", {}, signal);
}

// -- the model pool, which exists on one harness ------------------------------------------------------
//
// TWO CALLS AGAINST ROUTES THAT ARE NOT MOUNTED ON THE CLAUDE PATH, where both are a plain 404. That
// is the server's design rather than a condition inside a handler, and nothing here papers over it:
// the two controls that reach these are drawn only when health says `harness: "opencode"`, so a 404
// from either is a bug in that gate rather than a state to render.
//
// The pool is CONFIGURATION — the same kind of thing `--port` is — and not a record table. So it is
// not on the `records_changed` fan-out, there is no poke that announces it, and the store reads it
// when the window learns which harness it is on and again whenever the reader opens the pool. See
// `state/opencode.ts`.

/** Every model this installation can reach, and which role each answers in. */
export function fetchOpencodePool(signal?: AbortSignal): Promise<OpencodePool> {
  return getJson(opencodePoolSchema, "/api/opencode/models", signal);
}

/**
 * Replace the whole pool.
 *
 * THE WHOLE DOCUMENT, ALWAYS, and the answer IS the new truth — the route stores what it is given
 * and hands back what it stored, so the caller lands the response rather than refetching and there
 * is no window in which two tabs disagree about what was saved. A patch route would need a merge on
 * the server, and the thing being merged holds API keys.
 *
 * Refused with a 409 while the agent is working: the pool is rendered into the config the child was
 * started with, and rewriting it mid-turn would be a conversation whose model changed underneath it.
 * Refused as an `invalid_request` for a document that could not be rendered — two models sharing an
 * id, a role naming a model that is not there, models in the pool with nothing answering the primary
 * role. Every one of those sentences is written for a person and is shown verbatim.
 *
 * THE API KEYS COME BACK UNREDACTED, by decision on the server's side: this window binds loopback,
 * the pool is the reader's own credential file, and a form that cannot show what it is editing
 * forces sentinel values and blind overwrites.
 */
export function putOpencodePool(
  document: OpencodePoolWrite,
  signal?: AbortSignal,
): Promise<OpencodePool> {
  return sendJson(opencodePoolSchema, "PUT", "/api/opencode/models", document, signal);
}

/*
 * THERE IS NO WORKSHOP SECTION, NO PLAYBOOK SECTION AND NO ADDRESS-BOOK SECTION, and what is missing
 * is not wrappers but ROUTES. `POST /api/workshops`, `GET /api/workshops`, `PATCH /api/workshops/:id`,
 * `POST /api/workshops/:id/playbook`, `POST /api/sources`, `PATCH /api/sources/:id`,
 * `PATCH /api/records/:table/:id/name` and the four deletes are gone from the server; calling any of
 * them now would be a 404 or a 405.
 *
 * WHAT REPLACED THEM IS A SENTENCE. Storing a recipe, recording a source, saving a script,
 * renaming a row and throwing one away are all asked for in the conversation: the
 * agent interviews the reader, shows them what it is about to write, and writes it with its own
 * tools once they agree. `lib/awareness.ts` holds the sentences the `+` buttons and the Bin send,
 * and they are ordinary user messages — so the transcript is the record of what was asked for, and
 * there is no second, silent channel by which this window could have written a row.
 *
 * A RECIPE AS A RECORD IS STILL READ HERE, like every other row, through `/api/records/recipe/:id`
 * — which is what the note card and the graph already do.
 */

// -- the conversation, and the ones before it ------------------------------------------------------
//
// The transcript is the agent SDK's own session store, read back over HTTP. Nothing in this database
// records what was said: there is no `message` table, no page to ask for and no id for a
// window to keep. What that buys is that the conversation survives a restart of this process, gets
// summarised and folded by the SDK on its own initiative, and is resumable weeks later — and what it
// costs is that this window can only ever read it whole, by name.

/**
 * One conversation, entire.
 *
 * NO PAGING, AND THERE CANNOT HONESTLY BE ANY. The SDK hands back the whole post-compaction array,
 * and a tool line is paired with its result by walking that array from the top — so an offset page
 * would cut pairs in half and draw calls that never finished. Compaction is what bounds the length,
 * which is why the fold is an item of its own in what comes back.
 *
 * A 404 is an ordinary answer rather than a malfunction: the session was pruned, or belongs to
 * another project directory, or has not been flushed to disk yet by a CLI subprocess writing on a
 * cadence nothing here controls. Callers branch on `ApiError.isNotFound`.
 */
export function fetchTranscript(
  sessionId: string,
  signal?: AbortSignal,
): Promise<TranscriptAnswer> {
  return getJson(
    transcriptAnswerSchema,
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    signal,
  );
}

/** Every conversation the SDK's store holds, newest first, with the live one prepended even when it
 * has not been written to disk yet. What the session panel draws. */
export function listSessions(signal?: AbortSignal): Promise<SessionList> {
  return getJson(sessionListSchema, "/api/sessions", signal);
}

/**
 * Make an old conversation the one the next turn belongs to.
 *
 * 404 when the store no longer has it — a conversation can be pruned between the list being drawn
 * and a row in it being clicked — and 409 while the agent is working, because resuming then would
 * abandon a turn already in flight. Both are the server's own sentence and both are for the reader
 * rather than for a retry: the second one means "wait", and waiting is something only a person can
 * decide to do.
 *
 * Nothing is drawn from what comes back. The agent re-emits `ready` with the new id, the window
 * notices its session changed and fetches that transcript, and the summary arrives with the next
 * refresh of the list — which is one authority for the conversation's name rather than two.
 */
export function resumeSession(
  id: string,
  signal?: AbortSignal,
): Promise<{ sessionId: string; summary: string }> {
  return sendJson(
    resumedSchema,
    "POST",
    `/api/sessions/${encodeURIComponent(id)}/resume`,
    {},
    signal,
  );
}

/**
 * Put the current conversation down and start the next turn with no memory of it.
 *
 * 204, because nothing was created: the old session is still in the store, still listed and still
 * resumable, and what changed is only what the next turn will be carrying. Refused with a 409 while
 * a turn is in flight, for the reason `resumeSession` gives.
 *
 * No body is read back, so this goes through `send` rather than `sendJson` — asking a 204 for JSON
 * throws on the empty body, and the window would report a failure for a request that worked.
 */
export async function clearSession(signal?: AbortSignal): Promise<void> {
  await send("/api/sessions/clear", { method: "POST", signal: signal ?? null });
}

/**
 * Throw a stored conversation away, for good.
 *
 * THE ONE DELETE THIS MODULE HAS, and the reason it can exist beside so many deliberate absences is
 * that a transcript is not a record. Every record deletion is asked for in the conversation, so the
 * agent can say what else goes with it and the archive can witness the row leaving; a conversation
 * has nothing pointing at it, nothing to enumerate, and no ledger that could hold it. So the drag IS
 * the asking, and this is the whole of the doing.
 *
 * Refused with a 409 for the conversation the agent is in — deleting the transcript being written
 * into is not a state anything can be left in — and with a 404 for one the store no longer has.
 */
export async function deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
  await send(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    signal: signal ?? null,
  });
}

// -- files dragged into the conversation -------------------------------------------------------------

/**
 * Put one dropped file where the agent can read it, and answer with the path to name in the message.
 *
 * THE FILE IS THE BODY. `fetch` takes a `File` — it is a `Blob` — and sends the bytes with the
 * length and the type already on the request, so there is no multipart to assemble here and none to
 * parse at the other end. What the server cannot get from the body is what the reader called it,
 * which is why the name is on the query string.
 *
 * ONE REQUEST PER FILE, so a reader who drops four gets four answers: four chips that settle
 * independently, and one file too large refuses on its own rather than taking the other three with
 * it.
 *
 * The answer goes through the same reading as every other body: the path it names is written into
 * the next message the agent is sent, so a `path` that arrived as something other than a string
 * would become a sentence pointing at nothing.
 */
export function uploadFile(file: File, signal?: AbortSignal): Promise<{ path: string }> {
  const path = `/api/uploads${query({ filename: file.name })}`;
  return send(path, {
    method: "POST",
    body: file,
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  }).then((response) => readJson(response, uploadedSchema, path));
}

// -- the two logs ----------------------------------------------------------------------------------

/**
 * One page of one ledger, newest first.
 *
 * ONE FUNCTION FOR BOTH CATEGORIES, because it is one route and one question — "what has this
 * installation been quiet about" — asked of two tables with identical machinery. The category is
 * REQUIRED and has no default here either: the two answer different row shapes, and a defaulted
 * parameter would let a caller that forgot it draw deletions in an error viewer and never notice.
 *
 * Paging is keyset: `before` names the oldest id already in hand, never a position. Rows arrive while
 * the viewer is open — that is what the whole panel is for — and an offset would then repeat a row or
 * skip one every time the agent did something.
 */
export function fetchLog(
  category: LogCategory,
  opts: { before?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<LogRead> {
  const search = query({ category, before: opts.before, limit: opts.limit });
  return getJson(logReadSchema, `/api/logs${search}`, signal);
}

// -- reports ------------------------------------------------------------------------------------------------

/**
 * Where a published report is served from.
 *
 * A report IS its id: the document lives in the database, and the server serves it from there at
 * `/reports/<id>`. There is no stored path to join onto — which also means there is no
 * spelling of that path for a caller to get wrong, and no way for the URL to name a file the record
 * does not describe. The id is encoded even though every id this mints is hex, because a URL built
 * out of an unencoded string is a habit that outlives the guarantee that made it safe.
 *
 * The only report call in this file, and it makes no request at all. Reports are records like
 * everything else here — reached through `/api/records/report` and through the referent edges of the
 * things that stand on them — so a list endpoint has nothing to wrap: a second way to enumerate one
 * table would be a second shape to keep in step with the server for no reading it makes possible.
 */
export function reportUrl(reportId: string): string {
  return `/reports/${encodeURIComponent(reportId)}`;
}

// -- the record browser ----------------------------------------------------------------------------------------

/**
 * One table, newest first.
 *
 * Paging is keyset: `before` names the LAST record already in hand, never a position. Ids go on the
 * wire escaped — `query()` does it here, `encodeURIComponent` in the two calls below — which no id
 * this schema mints still needs, every one of them being hex, a ticker or a number. It stays because
 * `segments()` on the server splits the path on the raw `/` before decoding: an id that could hold
 * one arrives as a single segment only if it was escaped on the way out.
 */
export function fetchTable(
  table: RecordTable,
  opts: { limit?: number; before?: string } = {},
  signal?: AbortSignal,
): Promise<RecordPage> {
  const search = query({ limit: opts.limit, before: opts.before });
  return getJson(recordPageSchema, `/api/records/${table}${search}`, signal);
}

export function fetchRecord(
  table: RecordTable,
  id: string,
  opts: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<RecordDetail> {
  const search = query({ limit: opts.limit });
  return getJson(
    recordDetailSchema,
    `/api/records/${table}/${encodeURIComponent(id)}${search}`,
    signal,
  );
}

/**
 * The same record, asked for by the NAME it answers to. What a mention pill's press turns into.
 *
 * A QUERY PARAMETER RATHER THAN A PATH SEGMENT, and the route is spelled that way for the same
 * reason: a name is the user's to write and may hold a `/`, which the server splits on before
 * anything has decided what it is looking at. `query` percent-encodes it.
 *
 * The answer is the ordinary `RecordDetail`, so a caller that has one in hand cannot tell which
 * door it came through — and a 404 means what it says, that this table holds nothing of that name.
 */
export function fetchRecordNamed(
  table: RecordTable,
  name: string,
  opts: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<RecordDetail> {
  const search = query({ name, limit: opts.limit });
  return getJson(recordDetailSchema, `/api/records/${table}/named${search}`, signal);
}

/*
 * THE RECORD BROWSER IS NOW ENTIRELY A BROWSER. `renameRecord` was the one write in it — one column,
 * on any table — and `PATCH /api/records/:table/:id/name` has gone from the server with it. A rename
 * is asked for in the conversation like every other change to a row, which is also where the 409
 * naming whatever already answers to that name is worth reading: the agent can say which record
 * holds the name and offer another, where a form could only hand the sentence back.
 */

/** One referrer group on its own, paged. What a box scrolled to the end of its list asks for. */
export function fetchReferrers(
  table: RecordTable,
  id: string,
  refTable: RecordTable,
  opts: { limit?: number; before?: string } = {},
  signal?: AbortSignal,
): Promise<RecordGroup> {
  const search = query({ limit: opts.limit, before: opts.before });
  return getJson(
    recordGroupSchema,
    `/api/records/${table}/${encodeURIComponent(id)}/referrers/${refTable}${search}`,
    signal,
  );
}
