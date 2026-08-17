/**
 * The mirror lock — all four of them.
 *
 * The window restates four things the server declares: the frame unions (`web/src/lib/protocol.ts`
 * against `src/protocol/types.ts`), the record-browser shapes (`web/src/lib/records.ts` against
 * `src/repo/records.ts`), the two log rows (against `src/repo/logs.ts`), and the two session shapes
 * (against `src/server/sessions.ts`). Not one of those modules can be imported into the browser
 * project — they reach `bun:sqlite`, `node:crypto` through `db/tx.ts`, or the agent SDK, and the web
 * tsconfig declares no server types at all, deliberately. A copy is only safe while something makes
 * it impossible to edit one side alone; this file is that something.
 *
 * The assertions are almost entirely COMPILE-TIME: each type is assigned to the other in both
 * directions, which fails `bun run typecheck` the moment a field is added, renamed or retyped on
 * either side. Mutual assignability is what makes it exact rather than merely compatible — one
 * direction alone would let the web copy quietly grow a field the server never sends, or drop one it
 * does. The runtime body exists so `bun test` reports the file at all, and to compare the things
 * types cannot: the table list itself, value for value, and the exact key set that goes over a wire.
 *
 * The server imports below are TYPE-ONLY except for the three lists whose VALUES are the thing being
 * compared — the record tables, the group bounds and the effort levels — and those come from modules
 * that touch nothing at runtime: a table of names and a tuple of level names. Which is what lets this
 * file run under `bun test` without a database or an SDK anywhere near it. What it is mostly checking
 * is a compile, and the compile happens under the root tsconfig where both projects are visible at
 * once.
 */

import { expect, test } from "bun:test";

import type {
  EventsFrame as ServerEvents,
  InboundFrame as ServerInbound,
  OutboundFrame as ServerOutbound,
} from "../src/protocol/types.ts";
import type { EffortLevel as ServerEffortLevel } from "../src/config.ts";
import { EFFORT_LEVELS as SERVER_EFFORT_LEVELS } from "../src/config.ts";
import type {
  DeletionLogRow as ServerDeletionLogRow,
  ErrorLogRow as ServerErrorLogRow,
  ErrorScope as ServerErrorScope,
} from "../src/repo/logs.ts";
import type {
  JunctionTable as ServerJunctionTable,
  OnDelete as ServerOnDelete,
  RecordCard as ServerRecordCard,
  RecordDetail as ServerRecordDetail,
  RecordGroup as ServerRecordGroup,
  RecordPage as ServerRecordPage,
  RecordTable as ServerRecordTable,
  Row as ServerRow,
} from "../src/repo/records.ts";
import {
  DEFAULT_GROUP as SERVER_DEFAULT_GROUP,
  JUNCTION_TABLES as SERVER_JUNCTION_TABLES,
  MAX_GROUP as SERVER_MAX_GROUP,
  RECORD_TABLES as SERVER_RECORD_TABLES,
  REFERRERS,
} from "../src/repo/records.ts";
import type {
  SessionSummary,
  TranscriptItem as ServerTranscriptItem,
} from "../src/server/sessions.ts";
import type {
  DeletionLogEntry as WebDeletionLogEntry,
  EffortLevel as WebEffortLevel,
  ErrorLogEntry as WebErrorLogEntry,
  ErrorScope as WebErrorScope,
  EventsFrame as WebEvents,
  InboundFrame as WebInbound,
  OutboundFrame as WebOutbound,
  SessionCard as WebSessionCard,
  TranscriptItem as WebTranscriptItem,
} from "../web/src/lib/protocol.ts";
import { EFFORT_LEVELS } from "../web/src/lib/protocol.ts";
import type {
  JunctionTable as WebJunctionTable,
  OnDelete as WebOnDelete,
  RecordCard as WebRecordCard,
  RecordDetail as WebRecordDetail,
  RecordGroup as WebRecordGroup,
  RecordPage as WebRecordPage,
  RecordTable as WebRecordTable,
  Row as WebRow,
} from "../web/src/lib/records.ts";
import {
  DEFAULT_GROUP,
  EXPANDABLE_TABLES,
  JUNCTION_TABLES,
  MAX_GROUP,
  RECORD_TABLES,
} from "../web/src/lib/records.ts";

/** Fails to instantiate — a compile error — unless what it is given is exactly `true`. */
type AssertTrue<T extends true> = T;

/** Both directions at once, which is the only assertion this file ever wants. Written as a helper
 * rather than spelled twice per type because there are twenty of them and a hand-written pair
 * that got one side backwards would silently check half of what it claims. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/*
 * The frame unions. The tuple brackets stop the conditional from distributing over a union: without
 * them each member would be tested on its own, and a union that had LOST a member entirely would
 * still pass.
 */
export type OutboundFits = AssertTrue<Mutual<ServerOutbound, WebOutbound>>;
export type InboundFits = AssertTrue<Mutual<ServerInbound, WebInbound>>;

/*
 * The other socket. `EventsFrame` is a second union sent down a second connection — installation-wide
 * news rather than one conversation's — and it is watched here for the same reason the first one is.
 */
export type EventsFits = AssertTrue<Mutual<ServerEvents, WebEvents>>;

/** One member of a frame union, picked by its discriminant — so a member's KEYS can be compared,
 * which the union's own `keyof` cannot do: `keyof (A | B)` is the keys A and B have in common, so a
 * field on one member alone is invisible to it. */
type Frame<U, T extends string> = Extract<U, { type: T }>;

/** The same, for the shapes that discriminate on `kind` rather than `type`. */
type Item<U, K extends string> = Extract<U, { kind: K }>;

/*
 * Three frame members, member by member, through the hole assignability has: an OPTIONAL property on
 * one side alone is invisible to it, since `{key}` and `{key, at?}` are assignable in both
 * directions. Comparing KEYS closes that, and it has to be done per member because `keyof (A | B)` is
 * the keys the members have in common — for a frame union, `type` and nothing else.
 *
 * These three because their shapes are the easiest to get half-right. `ready` carries a session id
 * and no recipe id; `generation_started` carries the recipe id, since the conversation is global and
 * a procedure is not, and carries nothing else, since a recipe is immutable and there is no version
 * of it for a frame to pin; `turn_result` names no message id, there being no message table for it
 * to name a row in, and no cost, usage or turn count either. Each of those is exactly the kind of
 * field an edit can land on one side of the mirror and not the other.
 *
 * These assertions are SYMMETRIC, which is exactly what makes a two-sided drop cheap: removing
 * `costUsd` from one copy alone does not compile, and removing it from both keeps this passing. What
 * that cannot see is the field going back on both sides at once, so the runtime tests below write
 * the frames out and lock their key sets — the absence pinned as a test, like every other absence in
 * this suite.
 */
export type ReadyKeysFit = AssertTrue<
  Mutual<keyof Frame<ServerOutbound, "ready">, keyof Frame<WebOutbound, "ready">>
>;
export type GenerationStartedKeysFit = AssertTrue<
  Mutual<
    keyof Frame<ServerOutbound, "generation_started">,
    keyof Frame<WebOutbound, "generation_started">
  >
>;
export type TurnResultKeysFit = AssertTrue<
  Mutual<keyof Frame<ServerOutbound, "turn_result">, keyof Frame<WebOutbound, "turn_result">>
>;

/*
 * The effort level, which is the one mirrored type whose far side is not YewReview's at all: the
 * server's `EffortLevel` is re-exported straight from the agent SDK, so this assertion compares a
 * hand-written union in a browser bundle to a DEPENDENCY's vocabulary.
 *
 * That is exactly why it is worth spelling out on its own rather than leaving it to `OutboundFits`,
 * which would catch it too. An SDK release that adds a sixth level is a version bump, not an edit
 * anybody made to this repository — and it lands here as a typecheck failure on one line that names
 * the thing that moved, rather than as a picker in the window that silently cannot offer a level the
 * agent would accept. Adding the name in `web/src/lib/protocol.ts` and in `EFFORT_LEVELS` in
 * `src/config.ts` is then the deliberate two-line answer.
 */
export type EffortLevelFits = AssertTrue<Mutual<ServerEffortLevel, WebEffortLevel>>;

/*
 * The frame that asks for one, member by member and then by its keys — the same treatment the three
 * outbound members above get, and for the same reason. `set_effort` carries exactly one field
 * besides its discriminant, so a mirror that grew a second on one side alone would be a window
 * sending something the server drops on the floor without saying so.
 */
export type SetEffortFits = AssertTrue<
  Mutual<Frame<ServerInbound, "set_effort">, Frame<WebInbound, "set_effort">>
>;
export type SetEffortKeysFit = AssertTrue<
  Mutual<keyof Frame<ServerInbound, "set_effort">, keyof Frame<WebInbound, "set_effort">>
>;

/*
 * The frame that turns delegation on and off, given the same treatment for the same reason — and
 * with more riding on it than either of the two above. The server judges this payload itself rather
 * than passing it to the agent to narrow, so a mirror whose field was named or typed differently on
 * one side would produce a window whose every press came back as `bad_frame`.
 */
export type SetSubagentsFits = AssertTrue<
  Mutual<Frame<ServerInbound, "set_subagents">, Frame<WebInbound, "set_subagents">>
>;
export type SetSubagentsKeysFit = AssertTrue<
  Mutual<keyof Frame<ServerInbound, "set_subagents">, keyof Frame<WebInbound, "set_subagents">>
>;

/*
 * The transcript, which is not a frame and is mirrored anyway.
 *
 * It is the body of `GET /api/sessions/:id/messages`, and it is the shape the whole chat reducer is
 * written against — the window has no other copy of what was said, since nothing persists a
 * conversation on this side of the wire. The keys of the `tool` member are compared as well because
 * it is the one with three fields, and `ok` in particular is the kind of thing that grows a `?` when
 * somebody is unsure: a window reading `undefined` there would draw every tool call as a failure.
 */
export type TranscriptItemFits = AssertTrue<Mutual<ServerTranscriptItem, WebTranscriptItem>>;
export type TranscriptToolKeysFit = AssertTrue<
  Mutual<keyof Item<ServerTranscriptItem, "tool">, keyof Item<WebTranscriptItem, "tool">>
>;

/*
 * One row of the session list — the one mirrored shape with no single declaration on the other side
 * to point at, and the lock is built rather than imported for exactly that reason. `GET /api/sessions`
 * composes its rows inline out of two sources: the four fields of a `SessionSummary`, which is what
 * every session store this server can read answers in, and one the route alone knows — whether this
 * is the conversation the agent is currently in.
 *
 * It is pinned to `SessionSummary` rather than to the SDK's `SDKSessionInfo` because the seam is no
 * longer the SDK's: two harnesses answer this window, and the summary type is where they meet. A
 * field renamed there fails the typecheck here rather than emptying a panel.
 *
 * Every field is required and every field is drawn or clicked, which is why the key comparison
 * matters as much as the assignability — a `summary?` on one side alone would pass the first and
 * leave a list of rows labelled `undefined`.
 */
type ProjectedSession = SessionSummary & { live: boolean };
export type SessionCardFits = AssertTrue<Mutual<ProjectedSession, WebSessionCard>>;
export type SessionCardKeysFit = AssertTrue<Mutual<keyof ProjectedSession, keyof WebSessionCard>>;

/*
 * The two logs, which are ROWS rather than response shapes — which is why the window's copies keep
 * their snake_case names. `table_name` is what the column is called; renaming it on the way to a
 * browser would be a second vocabulary for one fact, and this lock would be the only thing keeping
 * the two spellings in step.
 */
export type ErrorScopeFits = AssertTrue<Mutual<ServerErrorScope, WebErrorScope>>;
export type ErrorLogFits = AssertTrue<Mutual<ServerErrorLogRow, WebErrorLogEntry>>;
export type ErrorLogKeysFit = AssertTrue<Mutual<keyof ServerErrorLogRow, keyof WebErrorLogEntry>>;
export type DeletionLogFits = AssertTrue<Mutual<ServerDeletionLogRow, WebDeletionLogEntry>>;
export type DeletionLogKeysFit = AssertTrue<
  Mutual<keyof ServerDeletionLogRow, keyof WebDeletionLogEntry>
>;

export type RecordTableFits = AssertTrue<Mutual<ServerRecordTable, WebRecordTable>>;
export type JunctionTableFits = AssertTrue<Mutual<ServerJunctionTable, WebJunctionTable>>;
export type OnDeleteFits = AssertTrue<Mutual<ServerOnDelete, WebOnDelete>>;
export type RowFits = AssertTrue<Mutual<ServerRow, WebRow>>;
export type RecordCardFits = AssertTrue<Mutual<ServerRecordCard, WebRecordCard>>;
export type RecordGroupFits = AssertTrue<Mutual<ServerRecordGroup, WebRecordGroup>>;
export type RecordDetailFits = AssertTrue<Mutual<ServerRecordDetail, WebRecordDetail>>;
export type RecordPageFits = AssertTrue<Mutual<ServerRecordPage, WebRecordPage>>;

/*
 * The same two shapes again, compared by their KEYS, because both of them carry optional fields and
 * assignability cannot see one.
 *
 * That is not hypothetical. A `sentinel?` on `RecordGroup` — the key an edge would want if a column
 * held a marker instead of an id — is exactly such a field. There is no such key on either side, and
 * this is what says so: a `sentinel?` added to one copy alone fails here and nowhere else in the
 * file. `RecordCard` gets the same
 * treatment for `sublabel` and `meta`, which are optional for honest reasons and equally unwatched
 * without it.
 */
export type RecordGroupKeysFit = AssertTrue<Mutual<keyof ServerRecordGroup, keyof WebRecordGroup>>;
export type RecordCardKeysFit = AssertTrue<Mutual<keyof ServerRecordCard, keyof WebRecordCard>>;

test("the web protocol mirrors the server's frame unions", () => {
  // Every outbound frame the server can build is a value of the web union too, and vice versa. The
  // typecheck already proved it; this keeps one concrete witness of each side in the file, so a
  // reader can see what the type-level assertions above are about.
  const fromServer: ServerOutbound = { type: "tool_end", tool: "x", toolUseId: "u1", ok: true, summary: "" };
  const asWeb: WebOutbound = fromServer;
  const backAgain: ServerOutbound = asWeb;
  expect(backAgain).toEqual(fromServer);

  const said: WebInbound = { type: "user_message", text: "hello" };
  const asServer: ServerInbound = said;
  expect(asServer).toEqual(said);

  // The frame that says a window's session id has arrived, or changed under it. Written out because
  // every field on it carries weight, and because the null is the ordinary case rather than the
  // edge one: the SDK mints an id on the first turn, so a window that attached before turn one is
  // told exactly this.
  // `effort` is a level for the same reason `sessionId` is null here: this is the ORDINARY case. A
  // conversation nobody has touched runs at the level every conversation starts at, so there is no
  // state in which the frame has none to name — which is what lets the key set below be fixed
  // whatever has been chosen. `subagents` is `true` on the same grounds: a conversation nobody has
  // touched may delegate, because that is the default the agent seats.
  const attached: ServerOutbound = {
    type: "ready",
    model: "claude-opus-5",
    models: [{ value: "claude-opus-5", displayName: "Opus 5" }],
    effort: "high",
    subagents: true,
    fresh: true,
    venvReady: true,
    sessionId: null,
  };
  const drawn: WebOutbound = attached;
  expect(Object.keys(drawn).sort()).toEqual([
    "effort",
    "fresh",
    "model",
    "models",
    "sessionId",
    "subagents",
    "type",
    "venvReady",
  ]);

  // The frame that asks for a level, both ways round. One field beside the discriminant, and it is
  // a level rather than a string: the socket receives JSON and the narrowing happens in the agent,
  // but nothing that builds this frame in the window is allowed to guess at a sixth name.
  const asked: WebInbound = { type: "set_effort", effort: "xhigh" };
  const heard: ServerInbound = asked;
  expect(heard).toEqual(asked);
  expect(Object.keys(heard).sort()).toEqual(["effort", "type"]);

  // And the frame that turns delegation off. `enabled` is the field's name on both sides, which is
  // the whole of what the runtime can check here — and the whole of what the server looks for
  // before it answers `bad_frame`.
  const delegating: WebInbound = { type: "set_subagents", enabled: false };
  const received: ServerInbound = delegating;
  expect(received).toEqual(delegating);
  expect(Object.keys(received).sort()).toEqual(["enabled", "type"]);
});

test("the frame that opens a procedure names the recipe and nothing else", () => {
  // WHAT IS NOT ON IT IS THE POINT. A procedure works to one recipe, and it says so twice — in the
  // turn that opened it, which the reader can read in the conversation, and in the tool result the
  // agent gets back. Here it says the id and stops. There is no version to pin: a recipe's content
  // is immutable, so the id IS the specification and a number beside it would be a second name for
  // one fact. A field broadcast to every open window and read by none is a promise between the two
  // sides of this mirror that can go stale without ever failing — which the compile-time assertions
  // above are what makes cheap to drop, and which this key set is what makes permanent.
  const opened: ServerOutbound = {
    type: "generation_started",
    generationId: "6b1d4f8e2a3c4d5e6f708192a3b4c5d6",
    // The recipe rides, and must: one conversation works across every recipe in the archive, so
    // "a generation started" without saying to which specification is a sentence no window can draw.
    recipeId: "1f2e3d4c5b6a79880192a3b4c5d6e7f8",
  };
  const drawn: WebOutbound = opened;
  const backAgain: ServerOutbound = drawn;
  expect(backAgain).toEqual(opened);
  expect(Object.keys(drawn).sort()).toEqual(["generationId", "recipeId", "type"]);
});

test("the frame that ends a turn says how it ended and reports no meter", () => {
  // THE ABSENCE IS THE ASSERTION, and it is a two-sided one. This frame carried `costUsd`, the SDK's
  // `usage` object and `numTurns`. The cost drew a running figure under every message — a meter
  // beside the answer rather than information about it — and the other two were passed across the
  // wire and read by nothing at all. All three left both copies in one edit, which `TurnResultKeysFit`
  // above is what made safe; what that assertion cannot see is the three of them arriving BACK on
  // both sides at once, and this key set is what would fail then.
  //
  // The harness still accumulates a running cost on its own snapshot, where the reader can go and
  // look for it. What it does not do is put it in front of them on every turn.
  const ended: ServerOutbound = { type: "turn_result", subtype: "success" };
  const drawn: WebOutbound = ended;
  const backAgain: ServerOutbound = drawn;
  expect(backAgain).toEqual(ended);
  expect(Object.keys(drawn).sort()).toEqual(["subtype", "type"]);
});

test("a poke on the events socket carries no payload to drift", () => {
  // Three of the five members are bodyless by design — see `protocol.ts` on why a frame that carried
  // the row it announced would be a second copy of it, broadcast to windows with nothing open. What
  // the mirror has to keep in step is therefore small, and this is a witness that it is that small.
  const logged: ServerEvents = { type: "error_logged", at: 1_770_000_000_000 };
  const asWeb: WebEvents = logged;
  const backAgain: ServerEvents = asWeb;
  expect(backAgain).toEqual(logged);
  expect(Object.keys(asWeb).sort()).toEqual(["at", "type"]);

  // The one that carries not even a time: the session list lives on disk in the SDK's store, flushed
  // on a cadence nothing here controls, so an `at` would be a claim about when that disk moved.
  const moved: WebEvents = { type: "sessions_changed" };
  const asServer: ServerEvents = moved;
  expect(Object.keys(asServer)).toEqual(["type"]);
});

test("a transcript the SDK hands back is a transcript the window can draw", () => {
  // One of each kind, in the order a real turn produces them: somebody asks, the agent runs a tool,
  // the agent answers. No timestamps anywhere — the SDK records the order things were said and not
  // the moments, and the window is forbidden from inventing them.
  const fromServer: ServerTranscriptItem[] = [
    { kind: "user", text: "measure 2330" },
    { kind: "tool", tool: "run_script", summary: "revenue.py", ok: true },
    { kind: "assistant", text: "Revenue rose 12%." },
    { kind: "compacted" },
  ];
  const asWeb: WebTranscriptItem[] = fromServer;
  const backAgain: ServerTranscriptItem[] = asWeb;
  expect(backAgain).toEqual(fromServer);
  expect(Object.keys(asWeb[1]!).sort()).toEqual(["kind", "ok", "summary", "tool"]);
  // The fold is a marker and nothing else. Anything on it would be a claim about what was folded
  // away, which is precisely what nobody has.
  expect(Object.keys(asWeb[3]!)).toEqual(["kind"]);
});

test("a session row the server lists is a row the panel can draw", () => {
  // The SYNTHESISED live row, spelled exactly as the route spells it: the agent holds a session id,
  // the SDK has not flushed that session to disk yet, so there is no birthday to report, nobody has
  // written a summary, and `lastModified` is "now". Written as the witness because it is the one
  // shape a reader might otherwise think impossible, and because it is the row somebody will be
  // looking at ten seconds after they put the conversation down with the dock's circled +.
  const live: ProjectedSession = {
    sessionId: "9a8b7c6d-5e4f-4021-9203-f4e5d6c7b8a9",
    summary: "(current conversation)",
    createdAt: null,
    lastModified: 1_770_000_000_000,
    live: true,
  };
  const asWeb: WebSessionCard = live;
  const backAgain: ProjectedSession = asWeb;
  expect(backAgain).toEqual(live);
  expect(Object.keys(asWeb).sort()).toEqual([
    "createdAt",
    "lastModified",
    "live",
    "sessionId",
    "summary",
  ]);
});

test("a log row crosses the wire with the column names it was stored under", () => {
  // snake_case on purpose, and this is where that decision is enforced rather than merely stated.
  // These are rows: two capped tables read straight off disk and handed over as they stand.
  const failed: ServerErrorLogRow = {
    id: 41,
    at: 1_770_000_000_000,
    scope: "tool",
    message: "publish_report threw while writing the document",
    detail: null,
  };
  const drawn: WebErrorLogEntry = failed;
  expect(Object.keys(drawn).sort()).toEqual(["at", "detail", "id", "message", "scope"]);

  const removed: ServerDeletionLogRow = {
    id: 7,
    at: 1_770_000_000_000,
    table_name: "thesis",
    row_id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    row_json: '{"id":"0f1e2d3c4b5a69788796a5b4c3d2e1f0"}',
  };
  const shown: WebDeletionLogEntry = removed;
  const backAgain: ServerDeletionLogRow = shown;
  expect(backAgain).toEqual(removed);
  expect(Object.keys(shown).sort()).toEqual(["at", "id", "row_id", "row_json", "table_name"]);
});

test("the web record vocabulary is the repository's, table for table", () => {
  // The types above cannot see this: two unions of the same eleven strings are the same type
  // however the arrays that produced them are ordered or spelled.
  expect(RECORD_TABLES).toEqual(SERVER_RECORD_TABLES);
  // Eleven. There is no `message` table: the transcript lives in the harness's session store, so there
  // is no row to address, no card to open, and nothing for `@message:417` to name.
  // The count is asserted as well as the contents because a table deleted from BOTH copies in one
  // edit would keep them equal to each other while quietly making the browser smaller than the
  // database. What guards the other direction — a table in the schema and in none of the browsable
  // lists — is `tests/records.test.ts`, which reads the open file.
  expect(RECORD_TABLES).toHaveLength(11);
  expect(RECORD_TABLES).not.toContain("message");
  // And the four that left and stayed gone. Two went first: a report's citations were the model's
  // account of its own reading, and nothing verified them, so a browser still listing them would
  // offer a door onto nothing. Two more went later, when a workshop holding a ledger of playbook
  // versions became one immutable `recipe` — there is no folder to open and no version to address,
  // so both names are as dead as the first two. `seikan_invocation` is deliberately NOT in this
  // list: the name came back for a different table, one written from the run log rather than from a
  // claim, so it belongs in the vocabulary above instead of being pinned out of it here.
  for (const gone of ["reference", "application", "workshop", "playbook"]) {
    expect(RECORD_TABLES).not.toContain(gone);
  }
  expect(RECORD_TABLES).toContain("recipe");
  expect(RECORD_TABLES).toContain("seikan_invocation");
  // ONE junction left, and it is compared value-for-value for the reason the record list is: `via`
  // on an edge is spelled from this array, and a window whose copy still said `application` would
  // draw an edge label naming a table nothing in the schema has.
  expect(JUNCTION_TABLES).toEqual(SERVER_JUNCTION_TABLES);
  expect(JUNCTION_TABLES).toEqual(["regime"]);
  expect(DEFAULT_GROUP).toBe(SERVER_DEFAULT_GROUP);
  expect(MAX_GROUP).toBe(SERVER_MAX_GROUP);
});

test("the tables the window will open are the tables the schema can point at", () => {
  // THE ARROW IS DRAWN FROM THIS ARRAY, so this array is the one thing in the window that has to
  // know the shape of the foreign-key graph. A card used to carry the answer per row — a bit the
  // server computed by probing every referrer key — and the arrow appeared only where something had
  // actually been recorded. That hid the schema behind the data: a recipe with no report yet, a
  // report whose runs are still to come, and a row nothing CAN ever point at were three different
  // facts drawn identically, and the reader had no way to tell an empty edge from an absent one.
  //
  // COMPARED AGAINST THE SERVER'S DERIVATION RATHER THAN AGAINST A LIST. `REFERRERS` is built from
  // the foreign-key map at module load, and the map is itself checked against `pragma
  // foreign_key_list` in `tests/records.test.ts` — so this assertion reaches all the way down to the
  // open database file. A hand-written expectation here would be a second opinion about the schema,
  // and the release that adds a key is exactly the release nobody remembers to update it in.
  const openable: string[] = SERVER_RECORD_TABLES.filter((table) => REFERRERS[table].length > 0);
  const mirrored: string[] = [...EXPANDABLE_TABLES];
  expect(mirrored).toEqual(openable);
  // Six, asserted as well as compared, because a table dropped from BOTH sides in one edit would
  // keep them equal while quietly making a row unopenable. The five that are absent are the leaves —
  // the three run tables, a series preparation, an information source — and a click on one of those
  // has nothing to draw.
  expect(EXPANDABLE_TABLES).toHaveLength(6);
  expect(SERVER_RECORD_TABLES.filter((table) => REFERRERS[table].length === 0)).toEqual([
    "information_source",
    "script_invocation",
    "seikan_invocation",
    "series_preparation",
    "trivial_shell_history_for_report",
  ]);
  // AND THE JUNCTION'S DIRECTION, which is the half a map derived from `FOREIGN_KEYS` instead of
  // from `REFERRERS` would get wrong. `regime` carries two keys, and only the target end is a
  // referrer: a thesis points AT a ticker through it. So `target` is openable and the thesis's own
  // arrow is earned by its assessments rather than by its regime — read the other way, every thesis
  // would draw an arrow onto a box that could never hold anything.
  expect(EXPANDABLE_TABLES).toContain("target");
  expect(REFERRERS.target.map((edge) => edge.table)).toEqual(["thesis"]);
});

test("the window's effort levels are the SDK's, level for level and in order", () => {
  // The type lock above cannot see this: two unions of the same five strings are the same type
  // however the arrays that produced them are ordered or spelled. The ORDER matters here in a way it
  // does not for the record tables — these are a scale, and a picker that listed them in a different
  // order from the one the settings parser names in its refusals would be describing the same five
  // levels as two different things.
  expect(EFFORT_LEVELS).toEqual(SERVER_EFFORT_LEVELS);
  // Five, asserted as well as compared, because a level dropped from BOTH copies in one edit would
  // keep them equal to each other while quietly making the window unable to ask for something the
  // SDK still accepts. What guards the other direction — a level the SDK has and neither copy does —
  // is `EffortLevelFits`, which is a typecheck failure rather than a test failure, and that is the
  // deliberate half of this arrangement: an SDK upgrade that adds a level does not compile.
  expect(EFFORT_LEVELS).toHaveLength(5);
});

test("a group the repository builds is a group the window can draw", () => {
  // One witness of the shape whose key set is locked above, carrying the optional member so that the
  // reading of `via` — a junction the edge travels through — is exercised rather than only declared.
  // A real edge, spelled as the repository derives it: a thesis's referents include the tickers its
  // regime covers, reached through `regime`, and the key at this end is NO ACTION because a target
  // may not be deleted out from under a thesis that is measured against it.
  //
  // `regime` is the ONLY junction left in the schema, which is what makes this witness worth
  // keeping concrete: if the last one ever goes, `via` becomes a key nothing can populate and this
  // is the line that will refuse to compile.
  const fromServer: ServerRecordGroup = {
    table: "target",
    column: "ticker",
    onDelete: "NO ACTION",
    via: "regime",
    total: 1,
    records: [
      {
        table: "target",
        id: "2330.TW",
        // The user's label and the computed description, side by side — the two are different
        // fields doing different jobs, and a card carries both.
        name: "tgt-tsmc-4k7p",
        label: "2330.TW",
        sublabel: "TSMC",
      },
    ],
    hasMore: false,
  };
  const asWeb: WebRecordGroup = fromServer;
  expect(asWeb).toEqual(fromServer);
  // Every key the server actually put on the wire, and nothing invented on the way across.
  expect(Object.keys(asWeb).sort()).toEqual([
    "column",
    "hasMore",
    "onDelete",
    "records",
    "table",
    "total",
    "via",
  ]);
});
