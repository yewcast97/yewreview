/**
 * The seam between a harness, its tools, and whatever is watching.
 *
 * One rule shapes all of it: a tool never talks to a socket and a socket never talks to the model.
 * Tools emit frames into an `Emit` they were handed, a session emits frames as a turn unfolds,
 * and the server decides who is currently listening — which is why a conversation survives a closed
 * tab, and why a turn runs to its end whether or not anybody was watching it.
 *
 * What a turn SAID is not this layer's business. The harness's own session store is the
 * transcript, read back over HTTP by whoever wants it, so every frame below is news about a
 * conversation in flight rather than the record of one. Nothing here has to be durable, and nothing
 * here is.
 *
 * It lives under `src/protocol` rather than beside either harness because it belongs to the SERVER.
 * Two harnesses answer this window — the Claude Agent SDK and opencode — and both speak exactly
 * these frames, hold exactly this `RunLog`, and hand their tools exactly this `ToolDeps`. A file
 * under `src/claudecode` would have made one harness the owner of the vocabulary the other has to
 * borrow; nothing here imports a harness, and nothing here may start.
 */

import type { Database } from "bun:sqlite";

import type { EffortLevel, Settings } from "../config.ts";
import type { ProcessMode } from "../db/lock.ts";
import type { VenvStatus } from "../sandbox/venv.ts";

/**
 * What YewReview's tool server is called, wherever a name for it is needed.
 *
 * It is spelled in four places and they are not interchangeable spellings of a preference: the
 * Claude path registers an MCP server under this name and therefore qualifies its tools
 * `mcp__<name>__*`; the opencode path answers `initialize` with it, keys the rendered config's
 * `mcp` block by it, and teaches the model `<name>_*` because that is how opencode addresses a
 * remote server's tools. Renaming the server means all four move together or the model calls tools
 * that are not there.
 */
export const SERVER_NAME = "yewreview";

/** Frames the server sends a watching client. */
/**
 * One model the reader may pick, as the picker draws it.
 *
 * Two fields of the SDK's four: `resolvedModel` and `description` are chrome this window does not
 * draw, and a mirror carries what is used rather than what is available.
 */
export type ModelOption = { value: string; displayName: string };

export type OutboundFrame =
  /**
   * The state of the one conversation, sent the moment a window attaches and again whenever the
   * session underneath it changes identity.
   *
   * There is deliberately no `summary` here. `attach()` answers SYNCHRONOUSLY — that is the contract
   * the chat socket is written against — and a session's summary is a file the SDK writes beside its
   * transcript, so carrying one would mean either an async disk read in a path that has nowhere to
   * await, or a field stale exactly as often as it is interesting. The window already holds
   * summaries keyed by `sessionId` from its session list. `sessionId` is the join, and the join is
   * enough.
   *
   * That id is null until the SDK mints one, which happens on the first turn — which is why this
   * frame is re-sent when it appears. A window that attached before turn one has no other way to
   * learn the id it needs in order to fetch the transcript it just watched arrive.
   *
   * `models` is what the picker in the composer draws, and it rides on this frame rather than on a
   * route of its own because it is a property of the CONVERSATION's world: which models this
   * installation's CLI can actually reach. It may be a fallback list on the first `ready` a window
   * ever sees — the real one comes from the SDK and cannot be awaited in a synchronous `attach` —
   * and the frame is re-sent when it lands.
   *
   * `effort` is the third thing a window has to be told before it draws a control: how hard the
   * model is being asked to work in THIS conversation. It is always one of the five levels and never
   * null, because there is no state in which the agent has no level — a conversation starts at the
   * installation's, which is `high` and which nothing configures, and the reader moves it from the
   * composer. A picker drawn from a nullable field would need a sixth option nobody has an honest
   * name for.
   *
   * `subagents` is the fourth, and it is a plain boolean for the same reason `effort` is never null:
   * a session either carries the delegation tools or it does not. It rides here rather than on a
   * route of its own because it is the same kind of fact as the other three — how this conversation
   * is being answered — and because the agent may put it back to the default without anybody asking:
   * resuming another conversation and clearing this one both do.
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
   * It earns a frame because it is the one thing that happens to a conversation with nobody asking:
   * a window that refetches the transcript afterwards finds its earlier half gone, and without a
   * marker in the stream that reads as amnesia rather than as compaction. `trigger` is the SDK's own
   * word for why it fired, passed through rather than interpreted — the layer that made the decision
   * has a better name for it than this one does.
   */
  | { type: "compacted"; trigger: string }
  /**
   * A generation procedure has begun, under the recipe it will publish to.
   *
   * `recipeId` rides on the frame because the conversation is GLOBAL and the procedure is not. One
   * chat works across every recipe in the archive, so "a generation started" without saying which
   * specification is a sentence no window can draw.
   *
   * There is no companion frame announcing that a recipe changed, and that is a decision. A recipe's
   * text cannot change at all — it is immutable, and a method that has moved on is a new recipe with
   * the old one set inactive — so the only thing that CAN move is a status, which announces itself to
   * every window through `records_changed` like any other record write.
   *
   * IT CARRIED `playbookVersion` AND NO LONGER DOES, WHICH IS WHAT THE MIRROR IS FOR. Nothing in the
   * window drew a version number — not the record labels, not the field grid, not the sentence about
   * a running procedure — so the field was arriving on every start to be assigned into a store slice
   * and read by nobody. A field nothing draws is a field this frame should not be carrying: a
   * protocol is a promise about what the two sides agree on, and one side promising something the
   * other has no use for is a promise that goes stale without failing. Versions have since gone
   * altogether, which is the same lesson one level up.
   *
   * Dropping it was ONE edit on BOTH sides — here, `web/src/lib/protocol.ts`, and the zod copy
   * beside it — precisely because `tests/webProtocol.test.ts` compares the two unions at COMPILE
   * time in both directions. Removing it from one side alone does not typecheck, so a two-sided drop
   * is cheap and atomic and a one-sided one is impossible; that is the whole return on hand-mirroring
   * these types.
   */
  | { type: "generation_started"; generationId: string; recipeId: string }
  | { type: "generation_ended"; generationId: string; reason: GenerationEnd }
  /**
   * A turn finished, and how it ended.
   *
   * It names no message row, because there is no row to name. The transcript is the harness's own
   * session store and the window reads it back whole rather than assembling it out of frames, so the
   * pairing problem — which streamed turn became which persisted message — has no subject. What is
   * left for this frame to carry is the one thing a stream cannot be reconstructed into: that the
   * turn is over, and the subtype saying how.
   *
   * IT CARRIED `costUsd`, `usage` AND `numTurns`, ON THE SAME ARGUMENT AS `playbookVersion` ABOVE.
   * The cost drew a figure under every message, which is a running meter on a local tool the reader
   * is not billed by the message for — noise beside the answer rather than information about it —
   * and `usage` and `numTurns` were never read by anything at all. What the harness spends is still
   * accumulated where it is actually useful, on the session's own snapshot; it is simply not
   * broadcast per turn any more.
   */
  | { type: "turn_result"; subtype: string }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

/**
 * How a generation procedure finished.
 *
 * Four outcomes and no fifth, because the client draws a different thing for each: `published` is
 * the one the button was pressed for; `cancelled` is the user stopping it; `completed` is the turn
 * ending with the agent having said why it could not produce a report, which is a finished answer
 * and not a failure; `error` is the session falling over underneath it.
 */
export type GenerationEnd = "published" | "cancelled" | "completed" | "error";

/**
 * Frames the events socket carries — what happened anywhere in the installation, to every open
 * window.
 *
 * `records_changed` carries no table list on purpose. The window's record browser re-reads exactly
 * what it has open, so a list would be a second description of the same event, kept accurate by
 * every write site knowing which tables its transaction touched. "The database moved, look again"
 * is all a watcher needs and all this can honestly promise.
 *
 * `error_logged` and `deletion_logged` are POKES of the same kind, and the temptation they exist to
 * refuse is the obvious one — carrying the row that was just written. A frame that did would be a
 * SECOND COPY of a row that already exists, broadcast to every window whether or not any of them had
 * the log open, and the viewer would still have to fetch the page around it before it could draw
 * anything at all. So the window GETs `/api/logs` when it cares, and only then. They are separate
 * from `records_changed` rather than folded into it because the log tables sit structurally outside
 * the record browser: nothing drawing records should redraw because an error was written, and
 * nothing watching the log should have to sift every write in the installation to notice one.
 *
 * `sessions_changed` carries nothing at all, not even a time. The session list lives on disk in the
 * SDK's store, flushed by the CLI subprocess on a cadence nobody here controls, so "look again" is
 * the only true thing this frame can say — an `at` would read as a claim about when that disk moved,
 * which is precisely the fact this side does not have.
 */
export type EventsFrame =
  | { type: "records_changed"; at: number }
  | { type: "error_logged"; at: number }
  | { type: "deletion_logged"; at: number }
  | { type: "sessions_changed" }
  | { type: "pong" };

/** Frames a client may send. */
export type InboundFrame =
  | { type: "user_message"; text: string }
  | { type: "interrupt" }
  /** Answer the next turn with another model. Refused while the agent is working — see
   * `Agent.setModel`, which is where the guard and the whitelist live. */
  | { type: "set_model"; model: string }
  /**
   * Work the next turn at another effort level. Refused while the agent is working, on the same
   * guard `set_model` uses and for the same reason — see `Agent.setEffort`.
   *
   * There is no frame for going back to "no level", because there is no such state to go back to.
   * A conversation starts at the installation's level, `resume` and `clear` restore it, and every
   * one of those is one of the five names the picker draws.
   */
  | { type: "set_effort"; effort: EffortLevel }
  /**
   * Let this conversation delegate, or stop it delegating. Refused while the agent is working, on
   * the same guard the two above use — see `Agent.setSubagents`.
   *
   * It is the one frame here that ENDS THE SESSION when it is honoured, because an allow list is
   * baked into the subprocess at startup and there is no way to move it afterwards. The conversation
   * survives: the session id is kept, so the next turn reopens the same one with the options
   * rebuilt, and what goes with the old subprocess is its working state — including any subagent
   * still running in the background.
   */
  | { type: "set_subagents"; enabled: boolean }
  | { type: "ping" };

export type Emit = (frame: OutboundFrame) => void;

/**
 * Everything a tool is allowed to reach.
 *
 * There is no `recipeId` here, and the absence is the design rather than an oversight. Closing one
 * over would stop a tool being pointed at another conversation's recipe, which is a real guarantee
 * only for as long as a conversation belongs to exactly one. There is ONE conversation and it works
 * across every recipe the archive holds, so a closed-over recipe would be a lie the tools told
 * themselves — whichever one happened to be current, silently applied to a call that was about a
 * different one.
 *
 * A recipe is therefore an explicit argument to the tools that need one: named by the model,
 * refused by name when it does not exist. That is the honest shape for a conversation that can work
 * across several. The single tool that must NOT be told — `publish_report`, where taking the model's
 * word would let a report land under a recipe the procedure never opened against — reads it off the
 * generation it is running inside instead. See `RunLog.recipeId`.
 */
export type ToolDeps = {
  db: Database;
  settings: Settings;
  /**
   * Whether this PROCESS holds the var root's write claim — see `db/lock.ts`.
   *
   * A value rather than a probe, beside `venv`'s function deliberately: the venv can become ready
   * after boot, and the mode cannot — it is decided once, before the database is opened, and holds
   * for the process's life. Every tool call from anywhere in the process tree reads this one field,
   * which is what makes a subagent's authority the main agent's: there is no caller here for it to
   * vary by.
   */
  mode: ProcessMode;
  /** The sandbox environment, so a tool can refuse honestly when measurement is unavailable. */
  venv: () => VenvStatus;
  emit: Emit;
  /** What a run tool writes into and what publishing reads back out. See `RunLog`. */
  runs: RunLog;
  /**
   * Open a generation procedure under one recipe, or say why it cannot open.
   *
   * THE TOOL SURFACE'S ONE DOOR ONTO THE GATE, and it is deliberately this narrow. A tool can start
   * a procedure; it cannot observe the harness that owns it, cancel one, or ask anything about the
   * conversation. Everything a tool is allowed to know about a procedure already open is on `runs`.
   */
  procedure: Procedure;
  /**
   * Tell every open window that the database moved.
   *
   * Distinct from `emit`, which reaches whoever is watching the conversation. A tool call writes
   * rows that a window with no chat open is drawing, so what a record browser needs is a channel
   * belonging to the installation rather than to a conversation. Called by the wrapper in
   * `tools/index.ts` rather than by any handler, for every call that actually moved a row of the
   * archive.
   */
  events: (frame: EventsFrame) => void;
};

/**
 * Why a procedure could not be opened. A closed union so the tool's mapping onto refusal kinds is
 * exhaustive at compile time — a rung added to the gate's ladder has to be given an answer here
 * before it can be returned.
 */
export type ProcedureRefusal = "closed" | "conflict" | "not_found" | "engine_unavailable";

/**
 * What opening a procedure answers with.
 *
 * `brief` is the pinned recipe and the procedure's own instructions, and it is what the calling
 * tool hands back as its result — the specification to work to, delivered where the model is already
 * reading. It used to be the text of a whole new TURN, which is what it was when a route opened a
 * procedure and the agent had to be told about it afterwards.
 */
export type ProcedureStart =
  | { ok: true; generationId: string; recipeId: string; brief: string }
  | { ok: false; code: ProcedureRefusal; message: string };

export type Procedure = { start: (recipeId: string) => ProcedureStart };

/**
 * What a command IS, recorded before it has done anything.
 *
 * Three kinds, and they are the three tables: a run of a stored program, which can name the program;
 * a run of the measurement engine, which is always the same program and so names itself; and
 * everything else, which can only name the line.
 */
export type RunStart =
  | { kind: "script"; scriptId: string; argument: string }
  | { kind: "seikan"; command: string }
  | { kind: "shell"; command: string };

/** What a command turned out to have done. Filled in when it exits, never before. */
export type RunOutcome = {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  /** What it printed, already clipped or not by whoever ran it — see `src/exec.ts`. */
  return: string;
};

/**
 * One run, as the log recorded it.
 *
 * **Written in two phases, and the reason is a race rather than tidiness.** The row is appended when
 * the command is SPAWNED and completed when it exits, so a command still running is in the log as an
 * entry with a null outcome. Publishing refuses while any entry is in that state: without the
 * opening half, a model could publish in the gap between starting a long command and its finishing,
 * and the report's account of its own procedure would be missing exactly the run that was still
 * going. (The shape is borrowed from shell-history recorders, which learn the same lesson from
 * `preexec`/`precmd`: what a command was is knowable before it runs, and how it went is not.)
 *
 * `at` is when the run STARTED, which is what orders a log honestly: two runs that finished out of
 * order still began in the order somebody asked for them.
 */
export type RunLogEntry = RunStart & { at: number; outcome: RunOutcome | null };

/** A completed engine run, held so a judgement can redeem it rather than retyping its report. */
export type SeikanRun = {
  runId: string;
  /** The stored thesis the run measured — or null when it measured a document not yet stored,
   * which makes it redeemable by `create_thesis` (the first reading) and by nothing else. */
  thesisId: string | null;
  dslHash: string;
  /** The engine's report document, exactly as it was written. */
  report: string;
  finishedAt: number;
};

/**
 * The generation procedure's run log, and the short-term memory of what the engine last said.
 *
 * The log is the whole reason `script_invocation` and `trivial_shell_history_for_report` are worth
 * having. A model
 * asked to list what it ran will list what it MEANT to run — not from dishonesty but because that
 * is what it remembers — so the list is taken from the tools instead, and only while a generation
 * is actually in progress. Outside one, `recording()` is false and the run tools still work; they
 * simply leave no record, because there is no report for a record to be part of.
 *
 * Retention is separate and always on: `run_seikan` keeps its report so `assess_thesis` can redeem
 * it by id. That is a fidelity measure rather than a convenience — a report pasted back through the
 * model is a report that can be truncated or improved on the way, and the one column that exists to
 * be checkable years later is exactly the wrong place for either.
 */
export type RunLog = {
  /** Whether a generation procedure is in progress. */
  recording: () => boolean;
  /**
   * The recipe the generation in progress is working to, or null when there is none.
   *
   * `publish_report` reads the recipe off the procedure it is inside rather than off `ToolDeps`,
   * because the procedure is the only place the answer is actually true: the report being written is
   * the one THIS procedure opened against, and no other recipe the conversation has touched before
   * or since has any claim on it.
   *
   * It is also the PIN. A recipe's text is immutable, so naming the row names the exact bytes the
   * report was written to — where a version ledger needed a second identifier to say which of
   * several texts under one name was meant, this needs none.
   */
  recipeId: () => string | null;
  /**
   * Open a run and hand back the way to close it.
   *
   * Called at the moment of spawning; the returned finalizer is called when the command exits, in a
   * `finally`, so a command that threw on the way out still lands as a finished entry rather than
   * an open one that would block the publish for ever. Both halves are no-ops when nothing is
   * recording, so the run tools work identically outside a generation and simply leave no record.
   */
  begin: (start: RunStart, at: number) => (outcome: RunOutcome) => void;
  /** Everything logged so far in the current generation, oldest first. */
  entries: () => readonly RunLogEntry[];
  /** Keep a finished engine run and return the id an assessment redeems it by. */
  retain: (run: Omit<SeikanRun, "runId">) => string;
  /** Take back a retained run, or null when the id is unknown or has aged out. */
  redeem: (runId: string) => SeikanRun | null;
  /** Close the current generation. A no-op when none is in progress. */
  end: (reason: GenerationEnd) => void;
};

/**
 * A tool result, in the shape the MCP layer requires.
 *
 * The payload has to ride as a SECOND text block: anything outside `content` is dropped on the way
 * to the model, so a structured-only result arrives empty. The first block is the human-readable
 * summary; the second is the JSON the model actually reasons over.
 */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const MAX_PAYLOAD_CHARS = 120_000;

export function ok(summary: string, payload: unknown = {}): ToolResult {
  let json = JSON.stringify(payload, null, 2);
  if (json.length > MAX_PAYLOAD_CHARS) {
    json = JSON.stringify({
      truncated: true,
      note:
        `the result was ${json.length} characters, over the ${MAX_PAYLOAD_CHARS} limit — ` +
        `narrow the query (a filter, a smaller limit) rather than reading it in pieces`,
    });
  }
  return { content: [{ type: "text", text: summary }, { type: "text", text: json }] };
}

/**
 * A refusal, RETURNED rather than thrown.
 *
 * A tool that throws teaches the model nothing except that something went wrong. A refusal that
 * names the kind carries a remediation hint with it, so the next attempt is different from the
 * last one.
 *
 * `detail` is for the refusals whose reason is DATA rather than prose — a run that exited nonzero
 * has an exit code, a stderr and the engine's own envelope, and none of that survives being folded
 * into a sentence. It rides beside the message rather than inside it, so a failing run reads the
 * same way a succeeding one does.
 */
export function fail(kind: string, message: string, detail?: unknown): ToolResult {
  const hint = HINTS[kind];
  const body = detail === undefined
    ? { error: kind, message, hint }
    : { error: kind, message, hint, detail };
  return {
    content: [
      { type: "text", text: message },
      { type: "text", text: JSON.stringify(body, null, 2) },
    ],
    isError: true,
  };
}

const HINTS: Record<string, string> = {
  not_found: "check the id or list what exists before naming one",
  read_only:
    "this process cannot write the archive or run commands; answer from what can be read, and " +
    "say plainly that changes need the writing process",
  invalid_request: "the arguments are the problem — reread the refusal and change them",
  conflict:
    "something still standing already holds this name or identity; read it first — reuse it, or " +
    "set it inactive and record the replacement",
  invalid_path:
    "a path is resolved before it is judged and must land inside your own home directory; " +
    "nothing outside it is yours to name",
  data_invalid:
    "the data failed the engine's strict CSV contract — replace the script that produced it with " +
    "a corrected one and set the old inactive, never repair the file it produced",
  venv_unavailable:
    "the measurement engine is not installed in this environment; say so plainly rather than " +
    "describing numbers you could not compute",
  script_failed:
    "read the script's own output; a failing script is replaced — save the corrected program as a " +
    "new script and set this one inactive — never edited and never worked around",
};
