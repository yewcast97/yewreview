/**
 * What the server says, MIRRORED — the two socket protocols, and the three answer shapes that ride
 * beside them on ordinary HTTP.
 *
 * A copy, and a copy on purpose. Every server module that declares one of these is reached from
 * something that imports `bun:sqlite` or the agent SDK, so pulling one into the browser bundle would
 * drag a native database binding — or a whole CLI subprocess wrapper — through the bundler. The
 * shapes are therefore written out a second time here, and the second copy is only safe because
 * something makes it impossible to edit one side alone: `tests/webProtocol.test.ts` assigns each
 * type to the server's own declaration in BOTH directions under the root tsconfig, so a field added,
 * renamed or retyped over there fails `bun run typecheck` rather than arriving in a browser as
 * `undefined`.
 *
 * THIS FILE SHARES NO LINE WITH `src/db/models.ts`, and the reason is the shape of the transcript. A
 * window reading the conversation out of a `message` table would take the row type straight from the
 * models module — which imports nothing and is safe to share — and copy only the frames. The
 * transcript is the SDK's own session store, read back over HTTP as
 * `TranscriptItem[]`; there is no row, so there is nothing to import. What is mirrored below is
 * the whole of what this window is told.
 *
 * THE LOG ENTRIES KEEP THEIR snake_case, alone among the answer shapes here, and that is deliberate
 * rather than an oversight. They ARE rows — `error_log` and `deletion_log` are two tables read
 * straight off disk and handed over as they stand — and renaming a row's columns on the way to a
 * browser would be a second vocabulary for the same fact, kept in step by hand for as long as anybody
 * remembered it existed. `table_name` is what the column is called; it is what the reader will grep
 * for when the viewer shows them something surprising.
 *
 * EVERY TYPE BELOW HAS A SCHEMA THAT CHECKS IT, in the section just above the two parsers. The
 * mirror lock makes these declarations agree with the server's at COMPILE time; the schemas are what
 * make an arriving frame agree with them at RUN time, which is the half a type cannot do — a socket
 * hands over bytes, and `as OutboundFrame` on the far side of `JSON.parse` is a claim nobody
 * checked.
 */

import { z } from "zod";

import { exact } from "./schema.ts";

/** Frames the server sends a watching client. */
/**
 * One model the reader may pick, as the picker draws it.
 *
 * Two fields of the SDK's four: `resolvedModel` and `description` are chrome this window does not
 * draw, and a mirror carries what is used rather than what is available.
 */
export type ModelOption = { value: string; displayName: string };

/**
 * How hard the model is asked to work, MIRRORED from `EffortLevel` in `src/config.ts` — which
 * re-exports it from the agent SDK rather than restating it.
 *
 * So this union is a copy of a copy, and it is the one place in this file where that is worth
 * saying out loud: the names are the SDK's vocabulary, not YewReview's, and the thing standing
 * between the two spellings is `tests/webProtocol.test.ts`. It compares this union to the server's
 * in both directions AND the array below to the server's array value for value, so a level added to
 * the SDK arrives as a failed typecheck rather than as a picker quietly missing an option the agent
 * would have accepted.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The five levels in the order a picker offers them, weakest first.
 *
 * Order is a decision rather than an accident: these are a SCALE, and a control that listed them
 * any other way would be asking the reader to work out which direction "more" was in.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies
  readonly EffortLevel[];

/**
 * Narrowing predicate over the level names — the guard a `<select>` handler needs.
 *
 * `event.target.value` is a `string` however narrow the options were, so a composer that sent one
 * straight back as a `set_effort` would be trusting the DOM about a union. This is where that
 * becomes a check instead.
 */
export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

export type OutboundFrame =
  /**
   * The state of the ONE conversation, sent the moment a window attaches and again whenever the
   * session underneath it changes identity.
   *
   * `sessionId` is null until the SDK mints one, which happens on the first turn — which is why this
   * frame arrives more than once. A window that attached before turn one has no other way to learn
   * the id it needs in order to fetch the transcript it just watched arrive. There is deliberately
   * no summary: the window already holds one per session in its session list, and `sessionId` is the
   * join.
   *
   * `models` is what the picker in the composer draws, and it rides on this frame rather than on a
   * route of its own because it is a property of the CONVERSATION's world: which models this
   * installation's CLI can actually reach. It may be a fallback list on the first `ready` a window
   * ever sees — the real one comes from the SDK and cannot be awaited in a synchronous `attach` —
   * and the frame is re-sent when it lands.
   *
   * `effort` is always one of the five levels: a conversation starts at the installation's, which
   * nothing configures, and the reader moves it from the composer. There is no null and no absence
   * to draw, which is what lets the picker be five options rather than five and a nameless sixth.
   *
   * `subagents` is a plain boolean for the same reason: a session either carries the delegation
   * tools or it does not. It rides here rather than on a route of its own because it is the same
   * kind of fact as the other three — how this conversation is being answered — and because the
   * agent may put it back to the default without anybody asking, which resuming another conversation
   * and clearing this one both do.
   */
  | {
      type: "ready";
      model: string;
      models: readonly ModelOption[];
      effort: EffortLevel;
      subagents: boolean;
      fresh: boolean;
      venvReady: boolean;
      sessionId: string | null;
    }
  | { type: "turn_started" }
  /** The only droppable frame: under backpressure, prose may be thinned but nothing else may. */
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; tool: string; toolUseId: string; summary: string }
  | { type: "tool_end"; tool: string; toolUseId: string; ok: boolean; summary: string }
  | { type: "report_published"; reportId: string; title: string; url: string }
  /**
   * The SDK folded the conversation's history down to a summary.
   *
   * Worth a frame, and worth drawing, because it is the one thing that happens to a conversation
   * with nobody asking for it: a window that refetches the transcript afterwards finds its earlier
   * half gone, and without a marker in the stream that reads as the model having forgotten rather
   * than as the history having been folded. `trigger` is the SDK's own word for why it fired, passed
   * through rather than reworded — the layer that made the decision has the better name for it.
   */
  | { type: "compacted"; trigger: string }
  /** A generation procedure has begun, under the recipe it will publish to. The conversation is
   * GLOBAL and the procedure is not, so "a generation started" without saying which specification is
   * a sentence no window can draw. It carried a pinned `playbookVersion` until nothing in this
   * window drew a version number, and versions have since gone altogether; see the frame's own note
   * in `src/protocol/types.ts` for why the mirror is what made dropping a field from both sides one
   * edit. */
  | { type: "generation_started"; generationId: string; recipeId: string }
  | { type: "generation_ended"; generationId: string; reason: GenerationEnd }
  /**
   * A turn finished, and how it ended.
   *
   * It names no message row, because there is no row to name: the transcript is the harness's own
   * session store and this window reads it back whole rather than assembling it out of frames, so
   * the question of which streamed turn became which persisted message has no subject. What is left
   * for it to carry is that the turn is over — which a stream cannot be reconstructed into — and the
   * subtype saying how.
   *
   * IT CARRIED `costUsd`, `usage` AND `numTurns`. The cost drew a figure under every message, and a
   * running meter is noise beside the answer rather than information about it; the other two were
   * never read by anything. See the frame's own note in `src/protocol/types.ts`.
   */
  | { type: "turn_result"; subtype: string }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

/**
 * How a generation procedure finished. Mirrors `GenerationEnd` in `src/protocol/types.ts`.
 *
 * Four outcomes and no fifth, because the window draws a different thing for each: `published` is
 * what the button was pressed for, `cancelled` is the user stopping it, `completed` is the agent
 * finishing its turn having said why no report was possible — a finished answer, not a failure —
 * and `error` is the session falling over underneath it.
 */
export type GenerationEnd = "published" | "cancelled" | "completed" | "error";

/** Frames a client may send. */
export type InboundFrame =
  | { type: "user_message"; text: string }
  | { type: "interrupt" }
  /** Answer the next turn with another model. Refused while the agent is working — see
   * `Agent.setModel`, which is where the guard and the whitelist live. */
  | { type: "set_model"; model: string }
  /** Work the next turn at another effort level. Refused while the agent is working, on the same
   * guard `set_model` uses. There is no frame for going back to "no level" because there is no such
   * state: a conversation starts at the installation's level, resuming or clearing returns it there,
   * and every one of those is a name the picker draws. */
  | { type: "set_effort"; effort: EffortLevel }
  /** Let this conversation delegate, or stop it delegating. Refused while the agent is working, on
   * the same guard the two above use — and it is the one frame here that ends the agent's session
   * when it is honoured, because an allow list is baked into the subprocess at startup. The
   * conversation survives that: the next turn reopens the same one with the options rebuilt. */
  | { type: "set_subagents"; enabled: boolean }
  | { type: "ping" };

/** The refusal kinds the HTTP surface answers with, from `RefusalKind` in `src/db/models.ts`, plus
 * the two the router adds for itself and the one `api.ts` mints when the server is unreachable. */
export type RefusalKind =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "invalid_path"
  | "data_invalid"
  | "method_not_allowed"
  | "internal"
  | "network";

/**
 * Frames the events socket carries — what happened anywhere in the installation. Mirrors
 * `EventsFrame` in `src/protocol/types.ts`.
 *
 * Every one of them is a POKE, and that is the shape of the whole channel rather than a property of
 * any single member. `records_changed` carries no table list, `error_logged` and `deletion_logged`
 * carry no row, and `sessions_changed` carries not even a time. Each could have carried its payload;
 * each would then be a SECOND copy of something that already exists, broadcast to every window
 * whether or not any of them had that panel open, and stale the moment two writes crossed. "It
 * moved, look again" is all a watcher needs and all this channel can honestly promise.
 *
 * `sessions_changed` is the one where that is not a preference but a fact: the session list lives on
 * disk in the SDK's own store, flushed on a cadence nothing here controls, so an `at` would be a
 * claim about when that disk moved — which is precisely what this side does not know.
 */
export type EventsFrame =
  | { type: "records_changed"; at: number }
  | { type: "error_logged"; at: number }
  | { type: "deletion_logged"; at: number }
  | { type: "sessions_changed" }
  | { type: "pong" };

/**
 * One line of a conversation as the SDK's store holds it, MIRRORED from `src/server/sessions.ts` —
 * what `GET /api/sessions/:id/messages` answers with.
 *
 * THE WHOLE ARRAY, ALWAYS, and the absence of paging here is a contract rather than a simplification.
 * `getSessionMessages` hands back the entire post-compaction conversation in one piece, and a tool
 * line is only paired with its result by walking that piece from the top — so an offset page would
 * cut pairs in half and report tools that never finished. Compaction is what bounds the length, which
 * is exactly why the fold gets an item of its own down here.
 *
 * NO TIMESTAMP ON ANY MEMBER, and nothing downstream may invent one. The SDK's transcript records the
 * order things were said and not the moments they were said at; a window that drew "4m ago" beside a
 * line would be making it up. The order is the whole of what is known, and the order is enough.
 */
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; tool: string; summary: string; ok: boolean }
  | { kind: "compacted" };

/**
 * One conversation in the session list, MIRRORED from `src/server/sessions.ts` — a row of
 * `GET /api/sessions`.
 *
 * `createdAt` is nullable and `lastModified` is not, which reads like an accident and is not: the
 * server SYNTHESISES a row for the live session when the SDK has not flushed it to disk yet, and
 * such a row has no birthday to report. It has a `lastModified` because "now" is the honest answer
 * for a conversation that is happening. `live` is the server's word for which one that is, never
 * this window's — a tab that decided for itself by comparing ids would be wrong for the second
 * between a resume landing and the `ready` that confirms it.
 */
export type SessionCard = {
  sessionId: string;
  summary: string;
  createdAt: number | null;
  lastModified: number;
  live: boolean;
};

/** Where an error came from, MIRRORED from `ErrorScope` in `src/repo/logs.ts`. Five origins and no
 * "unknown": a row nobody can place is a row nobody acts on. */
export type ErrorScope = "http" | "turn" | "generation" | "tool" | "run";

/**
 * One row of `error_log`, MIRRORED from `ErrorLogRow` in `src/repo/logs.ts`.
 *
 * `message` is the server's own sentence and is drawn verbatim — this window never rewords it,
 * because the reader opening the log is trying to find out what the machine said, and a paraphrase
 * is the one thing that cannot help them. `detail` is the long form, folded away behind a
 * disclosure: null when there was nothing to add.
 */
export type ErrorLogEntry = {
  id: number;
  at: number;
  scope: ErrorScope;
  message: string;
  detail: string | null;
};

/**
 * One row of `deletion_log`, MIRRORED from `DeletionLogRow` in `src/repo/logs.ts`.
 *
 * `row_json` is the WHOLE deleted row, serialised — which is what makes this ledger worth keeping:
 * the record is gone, so a reference to it would dangle, and a summary of it would be somebody's
 * opinion about which fields mattered. `table_name` is a plain string rather than a `RecordTable`
 * because these rows outlive the schema that produced them; a table dropped in a later version must
 * not make its own deletions unreadable.
 */
export type DeletionLogEntry = {
  id: number;
  at: number;
  table_name: string;
  row_id: string;
  row_json: string;
};

// -- what the server actually said -----------------------------------------------------------------
//
// Every type above says what the server MEANS to send. The schemas below are how a window finds out
// whether it did, and they are built FROM those declarations rather than beside them: `exact` fails
// the typecheck unless a schema parses precisely its type, so the two cannot drift into being
// confident descriptions of different shapes.
//
// EVERY OBJECT HERE IS PERMISSIVE ABOUT KEYS IT DOES NOT KNOW — `z.object`, never `z.strictObject`,
// which is the opposite of the choice the agent's tools make and opposite for a reason. A tool's
// arguments come from a model and an undeclared one is a mistake worth refusing, because dropping it
// silently is how a report loses half its declarations. These are ANSWERS, and the thing answering
// may be NEWER than the window reading it — a tab left open across an upgrade is the ordinary case,
// not the exotic one — so a frame refused for carrying a field this build has never heard of would
// turn a compatible addition into every un-reloaded tab going quiet. Unknown keys are dropped on the
// way in rather than carried, which is what stops anything downstream from coming to depend on one
// without declaring it.

const modelOptionSchema = exact<ModelOption>()(
  z.object({ value: z.string(), displayName: z.string() }),
);

/** The four outcomes, CHECKED rather than believed. The window draws a different thing for each, so
 * a fifth one from a newer server has to read as a frame this build cannot understand — which is a
 * frame ignored — rather than as a `reason` that falls through every branch. */
const generationEndSchema = exact<GenerationEnd>()(
  z.enum(["published", "cancelled", "completed", "error"]),
);

/** The five levels, CHECKED, and built from the array above rather than beside it so the picker and
 * the parser cannot come to disagree about what a level is. Used as it stands on the `ready` frame,
 * which always names a level — a null there would be a server this build cannot understand. */
const effortLevelSchema = exact<EffortLevel>()(z.enum(EFFORT_LEVELS));

/**
 * The chat socket's frames.
 *
 * EVERY FIELD HERE IS ONE THIS WINDOW ACTUALLY READS, which `turn_result` is the story of. It used
 * to carry the SDK's own `usage` object, passed through as `unknown` and looked at by nothing, with
 * a `.catch` so that a frame arriving without one was not dropped — a spinner would otherwise have
 * run for the rest of the session over a field nobody read. The field went instead, along with the
 * cost and the turn count. A schema that has to defend itself against its own unread fields is a
 * schema carrying fields it should not have.
 */
const outboundFrameSchema = exact<OutboundFrame>()(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("ready"),
      model: z.string(),
      models: z.array(modelOptionSchema).readonly(),
      effort: effortLevelSchema,
      subagents: z.boolean(),
      fresh: z.boolean(),
      venvReady: z.boolean(),
      sessionId: z.string().nullable(),
    }),
    z.object({ type: z.literal("turn_started") }),
    z.object({ type: z.literal("text_delta"), text: z.string() }),
    z.object({
      type: z.literal("tool_start"),
      tool: z.string(),
      toolUseId: z.string(),
      summary: z.string(),
    }),
    z.object({
      type: z.literal("tool_end"),
      tool: z.string(),
      toolUseId: z.string(),
      ok: z.boolean(),
      summary: z.string(),
    }),
    z.object({
      type: z.literal("report_published"),
      reportId: z.string(),
      title: z.string(),
      url: z.string(),
    }),
    z.object({ type: z.literal("compacted"), trigger: z.string() }),
    z.object({
      type: z.literal("generation_started"),
      generationId: z.string(),
      recipeId: z.string(),
    }),
    z.object({
      type: z.literal("generation_ended"),
      generationId: z.string(),
      reason: generationEndSchema,
    }),
    z.object({ type: z.literal("turn_result"), subtype: z.string() }),
    z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
    z.object({ type: z.literal("pong") }),
  ]),
);

/** The events socket's frames. Three of the five carry a moment and nothing else, which is the whole
 * of what there is to check — see the union's own header on why a poke carries no payload. */
const eventsFrameSchema = exact<EventsFrame>()(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("records_changed"), at: z.number() }),
    z.object({ type: z.literal("error_logged"), at: z.number() }),
    z.object({ type: z.literal("deletion_logged"), at: z.number() }),
    z.object({ type: z.literal("sessions_changed") }),
    z.object({ type: z.literal("pong") }),
  ]),
);

/** One line of a conversation. `ok` is required and boolean because a tool item that arrived without
 * one would draw every call it describes as a failure. */
export const transcriptItemSchema = exact<TranscriptItem>()(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), text: z.string() }),
    z.object({ kind: z.literal("assistant"), text: z.string() }),
    z.object({
      kind: z.literal("tool"),
      tool: z.string(),
      summary: z.string(),
      ok: z.boolean(),
    }),
    z.object({ kind: z.literal("compacted") }),
  ]),
);

/** One row of the session list. `createdAt` is nullable and `lastModified` is not, exactly as the
 * type says and for the reason it gives: the synthesised row for a live conversation the SDK has not
 * flushed has no birthday to report. */
export const sessionCardSchema = exact<SessionCard>()(
  z.object({
    sessionId: z.string(),
    summary: z.string(),
    createdAt: z.number().nullable(),
    lastModified: z.number(),
    live: z.boolean(),
  }),
);

const errorScopeSchema = exact<ErrorScope>()(
  z.enum(["http", "turn", "generation", "tool", "run"]),
);

export const errorLogEntrySchema = exact<ErrorLogEntry>()(
  z.object({
    id: z.number(),
    at: z.number(),
    scope: errorScopeSchema,
    message: z.string(),
    detail: z.string().nullable(),
  }),
);

/** A deletion. `table_name` is a plain string rather than the record vocabulary because these rows
 * outlive the schema that produced them — a table dropped in a later version must not make its own
 * deletions unreadable, and a schema that insisted on today's twelve names would do exactly that. */
export const deletionLogEntrySchema = exact<DeletionLogEntry>()(
  z.object({
    id: z.number(),
    at: z.number(),
    table_name: z.string(),
    row_id: z.string(),
    row_json: z.string(),
  }),
);

/** The kind on a refusal body. Read rather than asserted because it is the string the whole UI
 * branches on: `lib/api.ts` falls back to `internal` for anything that is not one of these, which is
 * what it already does for a refusal that named no kind at all. */
export const refusalKindSchema = exact<RefusalKind>()(
  z.enum([
    "invalid_request",
    "not_found",
    "conflict",
    "invalid_path",
    "data_invalid",
    "method_not_allowed",
    "internal",
    "network",
  ]),
);

/** The events socket's parser. Same contract as `parseFrame`, over the other union. */
export function parseEventsFrame(raw: unknown): EventsFrame | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const read = eventsFrameSchema.safeParse(parsed);
  return read.success ? read.data : null;
}

/**
 * A parsed frame, or null when the payload was not one. Malformed frames are the server's bug to
 * fix; a client that threw on one would take the window down over a stray byte.
 *
 * NULL COVERS BOTH KINDS OF "NOT ONE", and it has to cover the second as squarely as the first:
 * bytes that are not JSON, and JSON whose `type` names no member of the union or whose payload is
 * not the shape that member promises. A check that read only for a string in `type` would leave
 * every reducer downstream switching on a discriminant nobody had verified and reading fields
 * nobody had looked for.
 */
export function parseFrame(raw: unknown): OutboundFrame | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const read = outboundFrameSchema.safeParse(parsed);
  return read.success ? read.data : null;
}
