/**
 * The installation's one agent session: the thing that turns what the user typed into what the
 * assistant said.
 *
 * Four properties shape everything below, and none of them is obvious from the SDK's shape.
 *
 * **ONE SESSION FOR THE INSTALLATION, not one per recipe.** A recipe is a record — a
 * specification and the reports published under it — and it is not a conversation; treating it as
 * one would mean a person who wanted to compare two of them saying the same thing twice, to two
 * contexts that cannot see each other, each paying for its own cold start. So there is a single
 * conversation here, it works across every recipe the archive holds, and a recipe reaches it as
 * an ARGUMENT to a tool rather than as something the session closed over. What a closed-over id
 * would enforce by construction — this agent cannot touch that recipe — is enforced by naming:
 * a tool refuses an id nothing is stored under, and `publish_report`, the one call where the
 * model's word about a recipe must not be taken, reads it off the generation procedure it is
 * running inside.
 *
 * **THE SDK'S SESSION STORE IS THE ONLY TRANSCRIPT.** YewReview writes down nothing of what was said,
 * and that is a real trade rather than a simplification. It COSTS: the transcript is on disk in a
 * format and a location this process does not own, it cannot be queried — no SQL over what was
 * said, no message to mention by id, no chip carrying an old answer into a new question — and the
 * SDK may compact it out from under a window that is drawing it, which is why compaction earns a
 * frame of its own below. It BUYS the thing two writers can never have: what the model remembers
 * and what the user is shown are one artefact, so they cannot drift. Resuming a conversation by
 * name, auto-summarised titles and compaction of a session too long to send all arrive with it,
 * none of them reimplemented against a table that would only ever be an optimistic copy.
 *
 * **The conversation outlives the socket.** Frames go to whoever is currently attached, and a turn
 * runs to completion whether or not anyone is: the subprocess finishes it either way, the words
 * were produced and paid for, and the SDK is writing them down for whoever comes back. Attaching is
 * a subscription, not a session.
 *
 * **The recipe rides back as a tool result — never the system prompt, never the first turn of a
 * session.** The system prompt is byte-stable so the provider can cache its prefix across every turn
 * of every boot, and per-recipe text in it would defeat that for all of them. The first turn of a
 * session is no place for one either: this conversation has no single recipe, so there is no
 * specification that is "the" one to inject. A generation procedure, though, IS about exactly one
 * recipe, so `start_generation` answers with that recipe's whole text — which cannot have moved
 * since, because a recipe is immutable, so what the report is recorded as having been written to is
 * word for word what was handed over. The cost is one copy of a specification per procedure instead
 * of one per session, and what it buys is a prompt prefix every turn of every boot can share.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { EffortLevel, Settings } from "../config.ts";
import { EFFORT_LEVELS, homeDir, isEffortLevel } from "../config.ts";
import type { ProcessMode } from "../db/lock.ts";
import { GenerationGate } from "../generation.ts";
import { logError } from "../repo/logs.ts";
import type { Resources } from "../resources/embed.ts";
import { resultSummary, toolSummary } from "../protocol/summary.ts";
import type {
  Emit,
  EventsFrame,
  ModelOption,
  OutboundFrame,
  ToolDeps,
} from "../protocol/types.ts";
import type { VenvStatus } from "../sandbox/venv.ts";
import { buildAgentOptions } from "./options.ts";
import { announcing } from "../tools/index.ts";
import { sdkToolNames, toSdkServer } from "./mcp.ts";

/**
 * Whether a conversation may delegate before anybody says otherwise.
 *
 * On, because the work this agent does is the shape delegation is for: a question about six
 * companies is six readings that do not need to see each other, and one context holding all of them
 * is the slower and more expensive way to answer it. A default of off would make the capability
 * something a reader had to know existed before it could ever help them.
 */
const SUBAGENTS_DEFAULT = true;

/** One thing the user sent. */
type Turn = { text: string };

/**
 * Claude Fable 5, offered whether or not the installed CLI has heard of it.
 *
 * Written once because two lists need it and a second literal is a second thing to keep right. The
 * id carries no date suffix; that is the whole of the name rather than an alias for a dated one.
 * Its label is already in the form `label` produces, because curation appends this row AFTER the
 * step that strips the rows it was handed — a row joining a list past that point has to arrive
 * spelled the way the rest of the list has been left, or it is the one entry wearing a vendor name.
 */
const FABLE: ModelOption = { value: "claude-fable-5", displayName: "Fable 5" };

/**
 * The single gate every offered list passes through: Haiku never appears, Fable always does, and no
 * label carries the vendor's name.
 *
 * It is one function rather than two edits in two places because the two lists it governs are two
 * AGES OF THE SAME LIST — the hand-written fallback below stands only until the SDK answers, and
 * `supportedModels()` overwrites it the moment a session opens. Curating just the fallback would
 * therefore hold for the first few hundred milliseconds of a boot and then silently stop, which is
 * the worst shape a rule can have: right exactly as long as somebody is looking at it. Everything
 * downstream reads through the same pair — `setModel`'s whitelist and `readyFrame`'s list are both
 * `this.models ?? fallbackModels(...)` — so curating here curates the picker, the guard deciding
 * what may be switched to, and every open window, without any of the three knowing about it.
 *
 * BOTH MATCHES ARE SUBSTRINGS, AND BOTH READ BOTH NAMES A ROW HAS, because a model's id is not one
 * string. The CLI answers with an id to select by and, separately, the canonical id that selects:
 * this checkout's lists Fable as `claude-fable-5[1m]` resolving to `claude-fable-5`, and Haiku as
 * the bare alias `haiku` resolving to `claude-haiku-4-5-20251001`. Neither half is reliably the
 * canonical spelling, so a rule reading only one of them is a rule that works on whichever models
 * happen to be spelled the way it expects. Equality is worse still: it was equality on the exact id
 * that first let a SECOND Fable into the picker, because `claude-fable-5[1m]` is not
 * `claude-fable-5` and the gate concluded the CLI had never heard of the model it had just offered.
 * A suffix, a date, or a bracketed context size is a spelling of a name, not a different model.
 *
 * Nothing else in a model list is named after either model, so there is nothing for the substrings
 * to catch by accident — and the failure they guard against is asymmetric anyway. A missed Haiku is
 * a model on offer that should not be; a missed Fable is the same model twice, which reads to
 * whoever opens the picker as a bug in the window rather than a name it did not recognise.
 *
 * The honest edge, and it is a consequence rather than an oversight: an installation launched with
 * `--model claude-haiku-4-5` gets a picker that does not contain its own default. Nothing lies to
 * the reader about who is answering — the composer draws a stray option for a current model the
 * list does not hold, so the true name is still on screen — but once they pick something else,
 * picking Haiku back is refused by `setModel`, in words ("not one this installation can reach")
 * that are then wrong about the reason. That is what "Haiku never appears" costs, and it is the
 * cheaper of the two rules on offer: "Haiku appears when you asked for it" is one whose behaviour
 * nobody can predict from reading the list it produced.
 */
/**
 * A row of an offered list before it is narrowed to what the picker draws.
 *
 * `resolvedModel` is the SDK's own field, and its documentation states this exact use: it is there
 * so a host can match an explicit id against the alias row covering it. The wire type stays the two
 * fields it always was — this shape exists to be READ during curation and then dropped, because the
 * canonical id is how the rule recognises a model and not something any window needs drawn.
 */
type ModelListing = ModelOption & { resolvedModel?: string | undefined };

/** Whether a row names a model under either id it can be spelled by. */
function names(listing: ModelListing, model: string): boolean {
  if (listing.value.includes(model)) return true;
  return listing.resolvedModel !== undefined && listing.resolvedModel.includes(model);
}

/** What the picker prints for a row, with the vendor prefix taken off: every row in that menu is a
 * Claude model, so the word is noise repeated down the list rather than anything that tells them
 * apart. Only the label moves — `value` is what a choice is made by and what the SDK is handed. */
function label(name: string): string {
  return name.replace(/^claude[-\s]/i, "");
}

function curateModels(options: readonly ModelListing[]): readonly ModelOption[] {
  const kept = options.filter((option) => !names(option, "haiku"));
  const offered = kept.map(({ value, displayName }) => ({ value, displayName: label(displayName) }));
  return kept.some((option) => names(option, "fable")) ? offered : [...offered, FABLE];
}

/**
 * What the picker offers before the SDK has been asked, and if asking fails.
 *
 * A hardcoded list is a compromise and is written here rather than hidden in the component so the
 * compromise is somewhere a reader trips over it. Two things make it tolerable: the real list is
 * fetched the moment a session opens, and the installation's own default is first — so the entry
 * that is certainly reachable is the one already in use, and a stale name in this list costs a
 * refusal from `setModel` rather than a broken turn. The exception to that ordering is the one
 * `curateModels` makes: an installation whose default is a Haiku is not offered that default, and
 * the head of this list is then merely the first name that survived.
 *
 * Every entry labels itself with its own id, which the gate then strips the vendor prefix from
 * exactly as it strips a label the CLI wrote. Fable is spelled here as a bare name rather than as
 * `FABLE` for that reason: a list assembled without asking anything has nothing better to call a
 * model than the string it would be selected by, and one entry wearing a prettier label than its
 * neighbours would read as knowledge this list does not have.
 */
function fallbackModels(installed: string): readonly ModelOption[] {
  const names = [installed, "claude-opus-5", "claude-sonnet-5", "claude-fable-5"];
  return curateModels([...new Set(names)].map((value) => ({ value, displayName: value })));
}

/**
 * The slice of the SDK's `Query` this module actually drives.
 *
 * Narrowed so a test can supply a scripted driver without implementing a control plane it will
 * never call. The real `Query` satisfies it structurally.
 *
 * THE LAST THREE ARE THE CONTROL PLANE, and they earned their place by being the only way to answer
 * the two questions a window asks about a turn before it has been written: which model is writing
 * this, and how hard it was asked to work. `setModel` is documented by the SDK as streaming-input
 * only, which this agent always is — the prompt is an `InputQueue`'s stream — and `supportedModels`
 * is what turns a picker from a hardcoded list into one that follows whatever the installed CLI can
 * actually reach. Each is called at most once per session and never inside a turn; a driver in a
 * test that implements them as no-ops loses nothing.
 *
 * `applyFlagSettings` is narrowed HARDEST of the three. The real one merges any slice of the CLI's
 * whole settings object into a layer sitting above the user's own files, and this module wants
 * exactly one key of it — so the signature says exactly that key, and a later edit reaching for a
 * second one has to widen this declaration first, deliberately, rather than discovering it was
 * already allowed. The real `Query` satisfies the narrow form structurally, `effortLevel` included:
 * its own mapped type special-cases that key to admit `'max'`, which is session-scoped and never
 * written to a settings file.
 */
export type AgentQuery = {
  next(): Promise<IteratorResult<SDKMessage, void>>;
  interrupt(): Promise<unknown>;
  return(value?: unknown): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  supportedModels(): Promise<readonly ModelInfo[]>;
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>;
};

/**
 * What `supportedModels` hands back, narrowed to the two fields a picker draws plus the one the
 * curation reads. `resolvedModel` never reaches a window — see `ModelListing`.
 */
type ModelInfo = { value: string; displayName: string; resolvedModel?: string | undefined };

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AgentQuery;

/**
 * How this boot's tool surface is built.
 *
 * The real one is the default; the seam exists so a test can drive a session without one. `names`
 * are FULLY QUALIFIED (`mcp__yewreview__…`) because the tools module derives them from the same
 * definitions it builds the server from — a second list, qualified somewhere else, is the one that
 * eventually leaves a tool out, and a tool missing from `allowedTools` fails at the moment the
 * model reaches for it.
 */
export type ToolsFactory = (deps: ToolDeps) => {
  server: McpServerConfig;
  names: readonly string[];
};

/** The real one. Exported so a test can wrap it rather than substitute for it — what a test
 * usually wants from this seam is the DEPS on their way past, not a different roster. */
export const defaultTools: ToolsFactory = (deps) => {
  const defs = announcing(deps);
  return { server: toSdkServer(defs), names: sdkToolNames(defs) };
};

/** What a client needs to draw the state of the conversation without waiting for a frame. */
export type AgentSnapshot = {
  model: string;
  /** How hard the model is being asked to work — always one of the five, exactly as the `ready`
   * frame carries it. */
  effort: EffortLevel;
  /** Whether this conversation may delegate. Always an answer, never an absence: a session either
   * carries the six tools or it does not. */
  subagents: boolean;
  /** True when this boot's session began with an empty context rather than resuming one. */
  fresh: boolean;
  venvReady: boolean;
  /** True while the model owes an answer. */
  busy: boolean;
  /** Turns waiting behind the one in flight. */
  queued: number;
  /** The SDK's name for the conversation, or null before the first turn of a fresh one mints it. */
  sessionId: string | null;
  /** What this boot has spent. Reported, never stored: it is what the API charged, and nothing here
   * makes a claim to track it. */
  totalCostUsd: number;
  /** The generation procedure in progress, or null. */
  generation: { id: string; recipeId: string } | null;
};

export type AgentOptions = {
  db: Database;
  settings: Settings;
  resources: Resources;
  venv: () => VenvStatus;
  /** Whether this process holds the var root's write claim — see `db/lock.ts`. Optional on the
   * `events?` argument: tests overwhelmingly mean the writer, and the boot always says. */
  mode?: ProcessMode | undefined;
  /** Tell every open window that the installation moved. Optional so a test can drive a session
   * without a server to broadcast into, and settable afterwards — see `attachEvents`. */
  events?: ((frame: EventsFrame) => void) | undefined;
  tools?: ToolsFactory | undefined;
  queryFn?: QueryFn | undefined;
};

// ---------------------------------------------------------------------------------------------
// queues
// ---------------------------------------------------------------------------------------------

/**
 * The push side of streaming input.
 *
 * `query()` wants an async iterable it can pull user messages out of for the life of the session,
 * and YewReview produces them when a person types. This is that adapter: one consumer, one producer,
 * and a close that ends the generator so the subprocess exits rather than waiting forever.
 */
class InputQueue {
  private readonly pending: SDKUserMessage[] = [];
  private waiting: ((message: SDKUserMessage | null) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter(message);
      return;
    }
    this.pending.push(message);
  }

  close(): void {
    this.closed = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter(null);
    }
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const arrived = await new Promise<SDKUserMessage | null>((resolve) => {
        this.waiting = resolve;
      });
      if (arrived === null) return;
      yield arrived;
    }
  }
}

/** A bounded queue of turns with one consumer, which wakes on a submit and on disposal. */
class TurnQueue {
  private readonly items: Turn[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;

  get size(): number {
    return this.items.length;
  }

  offer(turn: Turn): boolean {
    // ONE waiting turn, and the bound is the queue's own restatement of a rule enforced above it:
    // `submitTurn` refuses while anything is in flight, so the only way a turn waits here at all
    // is the handoff window between an offer and the drive loop picking it up. A depth the guard
    // makes unreachable would be a promise about a state that cannot exist.
    if (this.closed || this.items.length >= 1) return false;
    this.items.push(turn);
    this.wake();
    return true;
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  async take(): Promise<Turn | null> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) return next;
      if (this.closed) return null;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }

  private wake(): void {
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// message shapes
// ---------------------------------------------------------------------------------------------

/**
 * The two message payloads read here, spelled locally.
 *
 * The SDK types these as the Anthropic API's own block unions, which reach this file through a
 * transitive type package. Naming the handful of fields actually read keeps that dependency out of
 * the conversation runtime and makes it obvious how little of a message this module looks at.
 * Assistant TEXT is not collected at all, because nothing here writes a transcript and the words
 * already reach the window as deltas.
 */
type AssistantBlock = {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
};

type ResultBlock = {
  type?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
};

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

// ---------------------------------------------------------------------------------------------
// the agent
// ---------------------------------------------------------------------------------------------

export class ClaudecodeAgent {
  private readonly db: Database;
  private readonly settings: Settings;
  private readonly resources: Resources;
  private readonly venv: () => VenvStatus;
  private readonly mode: ProcessMode;
  private readonly toolsFactory: ToolsFactory;
  private readonly queryFn: QueryFn;

  /**
   * Where an announcement about the installation goes.
   *
   * Mutable, and that is the whole reason `attachEvents` exists: the agent is built at boot and the
   * socket hub does not exist until the server starts, so the alternative is a dependency cycle or
   * an agent nobody can construct until after the thing that needs it.
   */
  private events: (frame: EventsFrame) => void;

  private readonly listeners = new Set<Emit>();
  private readonly turns = new TurnQueue();

  private query: AgentQuery | null = null;
  private input: InputQueue | null = null;
  private driving: Promise<void> | null = null;

  /**
   * The SDK's name for the conversation in progress, in memory and nowhere else.
   *
   * Null at boot, always: a session is a live thing belonging to a process, and storing its name
   * would be YewReview promising the next boot a conversation it has no way to know still exists.
   * The store of sessions is the SDK's, the list of them is read back from it, and resuming one is
   * something the USER does by picking it — never something a restart does silently on their behalf.
   */
  private sessionId: string | null = null;
  private fresh = true;
  private busy = false;
  private disposed = false;
  private totalCostUsd = 0;

  /**
   * Which model answers the next turn.
   *
   * `settings.model` is the installation's DEFAULT and no more than that: the env var and the
   * CLI flag configure the installation, and which model is writing is a fact about a conversation.
   * It is reset to the default by `resume` and `clear`, so a choice made in one conversation does
   * not leak into the next — the reader picked a model for what they were doing, not for ever.
   *
   * In memory and nowhere else, exactly like `sessionId` and for the same reason: a session is a
   * live thing belonging to a process.
   */
  private model: string;

  /**
   * How hard the model is asked to work on the next turn.
   *
   * The same shape of fact as `model` immediately above, and held the same way for the same
   * reasons. `settings.effort` is where every conversation starts — nothing configures it — while
   * how hard to work on the question actually being asked is a fact about a conversation, and one
   * the reader changes mid-conversation because THIS question is harder than the last. `resume` and
   * `clear` put it back to the default, so a level picked for one piece of work does not silently
   * follow the reader into the next.
   *
   * In memory and nowhere else, exactly like `model` and `sessionId`: a session is a live thing
   * belonging to a process, and a level written down would be this installation deciding on the
   * next boot's behalf what the last one had been in the middle of.
   */
  private effort: EffortLevel;

  /**
   * Whether this conversation may delegate to subagents and workflows.
   *
   * The same shape of fact as `model` and `effort` above — per conversation, in memory and nowhere
   * else, put back to the default by `resume` and `clear` — because whether a question is worth
   * fanning out over is a property of the question rather than of the installation.
   *
   * Unlike those two the SDK has no live setter for it, and there is nothing to write one against:
   * the allow list is baked into the subprocess at `startSession`, so the only way to change what a
   * session may reach is to open another one. `setSubagents` therefore ENDS the live session, and
   * the next turn reopens the same conversation with the options rebuilt — see the note there on
   * what that costs.
   */
  private subagents = SUBAGENTS_DEFAULT;

  /**
   * What the installed CLI can actually reach, or null until it has been asked.
   *
   * BOOT-LIFETIME rather than per session, because it is a property of the binary rather than of a
   * conversation. Null until the first session opens, since there is no `Query` to ask before then
   * and `attach()` answers synchronously — so the first `ready` a window ever sees carries the
   * fallback, and a second one carries the real list a moment later.
   */
  private models: readonly ModelOption[] | null = null;

  /**
   * The generation procedure, and everything a tool may know about one.
   *
   * Composed rather than implemented, because a procedure is a rule about the archive rather than a
   * property of this harness: `src/generation.ts` holds the refusals, the named recipe and the
   * run log, and the opencode session composes the very same class. What stays here is the two
   * things only a session can answer — whether it is shut down, and whether it is already busy —
   * and the queueing of the turn the gate hands back.
   */
  private readonly gate: GenerationGate;

  /** Tool names, in the order the factory declared them. Empty when this boot has no tool surface. */
  private toolNames: readonly string[] = [];
  private mcpServer: McpServerConfig | null = null;

  /** Names the tools of a turn, so the frame that closes a call can say which one it closed. */
  private readonly openTools = new Map<string, string>();

  constructor(options: AgentOptions) {
    this.db = options.db;
    this.settings = options.settings;
    this.resources = options.resources;
    this.venv = options.venv;
    this.mode = options.mode ?? "writer";
    this.events = options.events ?? (() => {});
    this.toolsFactory = options.tools ?? defaultTools;
    this.queryFn = options.queryFn ?? (sdkQuery as unknown as QueryFn);
    this.model = options.settings.model;
    this.effort = options.settings.effort;
    this.gate = new GenerationGate({
      db: options.db,
      emit: (frame) => this.emit(frame),
      venv: options.venv,
      closed: () => this.disposed,
      turnInFlight: () => this.busy,
    });
  }

  // -- subscription --------------------------------------------------------------------------

  /**
   * Point the installation-wide channel at the server's broadcast. Called once, by the server.
   *
   * The tools built below reach it through a closure rather than holding the function they were
   * handed, so a tool minted before the server started still announces into the right place
   * afterwards.
   */
  attachEvents(broadcast: (frame: EventsFrame) => void): void {
    this.events = broadcast;
  }

  /**
   * Start listening. Returns the detach.
   *
   * A `ready` frame goes out immediately, because a client that has just connected needs to know
   * whether the model remembers this conversation — and which conversation it is — before it
   * renders a word of it.
   */
  attach(emit: Emit): () => void {
    this.listeners.add(emit);
    this.deliver(emit, this.readyFrame());
    return () => {
      this.listeners.delete(emit);
    };
  }

  snapshot(): AgentSnapshot {
    return {
      model: this.model,
      effort: this.effort,
      subagents: this.subagents,
      fresh: this.fresh,
      venvReady: this.venv().ready,
      busy: this.busy,
      queued: this.turns.size,
      sessionId: this.sessionId,
      totalCostUsd: this.totalCostUsd,
      generation: this.gate.running(),
    };
  }

  // -- which conversation this is --------------------------------------------------------------

  /**
   * Reopen a conversation the user picked out of the session list.
   *
   * Nothing is started here. The id is remembered and the next turn passes it as `resume`, which is
   * the same lazy start a boot does — and it is the honest one: a query opened now, for a
   * conversation nobody has said anything to yet, would spend a subprocess on the chance that they
   * will.
   *
   * The live session is ended FIRST because there is only ever one, and a query still holding the
   * old conversation would answer the next turn out of it.
   */
  resume(sessionId: string): { ok: true } | { ok: false; code: "conflict"; message: string } {
    const busy = this.refuseWhileWorking(
      "switching to another conversation now would leave an answer being written into one nobody " +
        "is reading",
    );
    if (busy) return busy;

    this.endSession();
    this.sessionId = sessionId;
    // Said plainly, because the whole point of resuming is that the model is NOT starting empty.
    this.fresh = false;
    // Back to the defaults: a model, a level and a decision about delegating that were chosen for
    // one conversation were chosen for THAT conversation, and carrying any of them into another
    // would be this process remembering a preference nobody expressed. The three reset together
    // because they are one decision — how this piece of work should be answered — taken apart only
    // by having three knobs.
    this.model = this.settings.model;
    this.effort = this.settings.effort;
    this.subagents = SUBAGENTS_DEFAULT;
    this.emit(this.readyFrame());
    this.events({ type: "sessions_changed" });
    return { ok: true };
  }

  /**
   * Put the current conversation down and start the next turn with an empty context.
   *
   * The old session is not deleted — it is still in the SDK's store, still in the list, still
   * resumable. "Clear" is about what the model is carrying, not about what the archive keeps.
   */
  clear(): { ok: true } | { ok: false; code: "conflict"; message: string } {
    const busy = this.refuseWhileWorking(
      "starting a new conversation now would abandon a turn already in flight",
    );
    if (busy) return busy;

    this.endSession();
    this.sessionId = null;
    this.fresh = true;
    this.model = this.settings.model;
    this.effort = this.settings.effort;
    this.subagents = SUBAGENTS_DEFAULT;
    this.emit(this.readyFrame());
    this.events({ type: "sessions_changed" });
    return { ok: true };
  }

  /**
   * Answer the next turn with another model.
   *
   * REFUSED WHILE THE AGENT IS WORKING, on the same guard `resume` and `clear` use. A model swapped
   * under a turn in flight would leave one answer written half by each, with the cost attributed to
   * whichever was current when the turn ended — and the transcript would say one model wrote a
   * paragraph the other did.
   *
   * The whitelist is the list the picker was drawn from, so a request naming something outside it
   * is a window that is out of date rather than a reader making a choice — which is why it comes
   * back as `invalid_request` and not as a conflict to retry.
   *
   * The live query is told too, and the stored value is rolled back if it refuses: the SDK's
   * `setModel` takes effect on the NEXT turn, so this and the options passed to `startSession` are
   * two ways of saying the same thing at two moments in a session's life — before it exists, and
   * after. A session that has not started yet needs only the field.
   */
  async setModel(
    model: string,
  ): Promise<{ ok: true } | { ok: false; code: "conflict" | "invalid_request"; message: string }> {
    const busy = this.refuseWhileWorking(
      "changing the model now would leave one answer written half by each of them",
    );
    if (busy) return busy;

    const known = this.models ?? fallbackModels(this.settings.model);
    if (!known.some((option) => option.value === model)) {
      return {
        ok: false,
        code: "invalid_request",
        message:
          `${JSON.stringify(model)} is not one this installation can reach; the ones it can are ` +
          known.map((option) => option.value).join(", "),
      };
    }
    if (model === this.model) return { ok: true };

    const previous = this.model;
    this.model = model;
    if (this.query !== null) {
      try {
        await this.query.setModel(model);
      } catch (err) {
        this.model = previous;
        return {
          ok: false,
          code: "conflict",
          message: `the agent would not change model: ${describe(err)}`,
        };
      }
    }
    // Every window, not just the one that asked: they are all drawing the same conversation.
    this.emit(this.readyFrame());
    return { ok: true };
  }

  /**
   * Work the next turn at another effort level.
   *
   * Shaped exactly like `setModel` above, deliberately and line for line, because it is the same
   * kind of decision: a property of the conversation rather than of the installation, changeable
   * between turns and not during one. REFUSED WHILE THE AGENT IS WORKING on the same guard — a
   * level swapped under a turn in flight would leave one answer thought about half at each, and the
   * turn result would report a cost nobody could attribute to either.
   *
   * The argument is a bare `string` rather than an `EffortLevel` because the caller is a socket:
   * the frame arrived as JSON and nothing about the wire narrows it. `isEffortLevel` is where that
   * becomes a level, and a value that is not one is `invalid_request` rather than a conflict to
   * retry — the picker was drawn from these five names, so anything else is a stale window or a
   * hand-written frame, and neither gets better by being sent again.
   *
   * The live query is told too, and the stored value is rolled back if it refuses — the same pair
   * of moments `setModel` deals with. `applyFlagSettings` merges a level into the session's flag
   * layer for the rest of the session; `startSession` passes one for a session that does not exist
   * yet. Two ways of saying one thing, at the two points in a session's life where it can be said.
   */
  async setEffort(
    effort: string,
  ): Promise<{ ok: true } | { ok: false; code: "conflict" | "invalid_request"; message: string }> {
    const busy = this.refuseWhileWorking(
      "changing how hard the model works now would leave one answer thought about half at each " +
        "level",
    );
    if (busy) return busy;

    if (!isEffortLevel(effort)) {
      return {
        ok: false,
        code: "invalid_request",
        message:
          `${JSON.stringify(effort)} is not an effort level; the levels are ` +
          EFFORT_LEVELS.join(", "),
      };
    }
    if (effort === this.effort) return { ok: true };

    const previous = this.effort;
    this.effort = effort;
    if (this.query !== null) {
      try {
        await this.query.applyFlagSettings({ effortLevel: effort });
      } catch (err) {
        this.effort = previous;
        return {
          ok: false,
          code: "conflict",
          message: `the agent would not change effort level: ${describe(err)}`,
        };
      }
    }
    // Every window, not just the one that asked: they are all drawing the same conversation.
    this.emit(this.readyFrame());
    return { ok: true };
  }

  /**
   * Let this conversation delegate, or stop it delegating.
   *
   * REFUSED WHILE THE AGENT IS WORKING, on the guard the three above share, and here the guard is
   * load-bearing in a way it is not for them: honouring this change means ENDING THE SESSION, and
   * doing that under a turn in flight would be abandoning an answer somebody is reading rather than
   * merely finishing it at the wrong setting.
   *
   * Ending the session is the whole implementation because there is nothing else it could be. What a
   * session may reach is the allow list the subprocess was started with, and the SDK offers no way
   * to move it afterwards — so this is a knob that can only be turned between sessions. `endSession`
   * touches the query and the input queue and nothing else: the session ID survives in memory, so
   * `runTurn`'s resume path reopens THE SAME CONVERSATION with options built from the new answer,
   * and the model keeps everything it was told. What is lost is the subprocess's own working state,
   * and there is one blind spot worth naming rather than hiding: a flip between turns silently kills
   * any subagent still running in the background, exactly as `clear` already does to a backgrounded
   * Bash. Nothing here waits for them, because a control that hung until somebody else's work
   * finished would be a control nobody could use.
   *
   * There is no `invalid_request` branch — the socket rejects anything that is not a boolean before
   * this is reached — and no rollback branch, because there is nothing here that can refuse: unlike
   * `setModel` and `setEffort` this asks the SDK for nothing at all.
   */
  async setSubagents(
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; code: "conflict"; message: string }> {
    const busy = this.refuseWhileWorking(
      "changing whether it may delegate ends the session it is answering out of, and the answer " +
        "would go with it",
    );
    if (busy) return busy;

    // Answered without ending anything: the session already has the surface being asked for, and
    // tearing it down to rebuild an identical one would cost the model its working memory for
    // nothing.
    if (enabled === this.subagents) return { ok: true };

    this.subagents = enabled;
    this.endSession();
    // Every window, not just the one that asked: they are all drawing the same conversation.
    this.emit(this.readyFrame());
    return { ok: true };
  }

  /**
   * The guard all of the above share — and since `submitTurn` joined them, the guard on input too:
   * nothing may change which conversation this is, how it is being answered, or what it is being
   * asked, while the conversation is doing something. A second message mid-turn is not queued any
   * more; it is refused, and the Stop button is the way out.
   *
   * It is airtight rather than best-effort. Submitting, resuming and clearing all run on the one JS
   * thread, and a turn that has been submitted but has not started driving yet is already visible in
   * `turns.size` — so there is no window in which a turn exists and this cannot see it.
   *
   * The gate's own term is provably redundant here — a procedure rides a turn, so an open gate
   * implies `busy` — and it stays because that implication is a property of the tool layer rather
   * than of this class. It costs one `&&` and it is what keeps this honest if a procedure is ever
   * opened from somewhere that is not a turn.
   */
  private refuseWhileWorking(
    because: string,
  ): { ok: false; code: "conflict"; message: string } | null {
    if (!this.busy && this.turns.size === 0 && !this.gate.open()) return null;
    return {
      ok: false,
      code: "conflict",
      message: `the agent is still working — ${because}. Interrupt it, or wait for it to finish`,
    };
  }

  // -- input ---------------------------------------------------------------------------------

  /**
   * Take one turn, or refuse it. False means it was refused and nothing happened.
   *
   * ONE TURN AT A TIME is the rule since the queue went: a message sent while the agent is working
   * is refused as `busy` rather than parked behind the reply in flight, because a parked question
   * is answered minutes later out of a conversation that has moved on — and the person who sent it
   * has usually rephrased it twice by then. The Stop button is the way out, and the refusal says so.
   *
   * Refusing is cheap. Nothing here writes anything down, so a refusal leaves no trace at all — no
   * question stranded in a transcript that nothing is going to answer, and no queue-then-record
   * ordering to get right. The frame it emits IS the whole of what the user is told. The socket
   * refuses first, per-socket (`server/chat.ts`); this is the harness keeping the rule true for
   * any caller, on the airtight predicate `refuseWhileWorking` already holds.
   */
  submitTurn(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed === "") return false;
    if (this.disposed) {
      this.emit({
        type: "error",
        code: "closed",
        message: "the agent has been shut down; restart YewReview to keep talking",
      });
      return false;
    }
    const refusal = this.refuseWhileWorking(
      "a second message would land behind an answer still being written",
    );
    if (refusal !== null) {
      // `busy` rather than the guard's own `conflict`: it is the code the window's draft-restore
      // path keys on, and what it means here is exactly "busy". Broadcast like every error frame —
      // a race-only backstop once the composer gates itself, but every tab drawing the refused
      // message needs to take it back off.
      this.emit({ type: "error", code: "busy", message: refusal.message });
      return false;
    }
    if (!this.turns.offer({ text: trimmed })) {
      // Only reachable closed-under-us: the guard above holds the queue empty, so a false offer
      // means `close()` won the race, and dispose already spoke.
      return false;
    }
    this.startDriving();
    return true;
  }

  /**
   * Stop the model.
   *
   * It stops at the next thing it would have done, not immediately: a measurement already running
   * is a compiled numeric routine with no cancellation point, and it finishes. A turn caught in
   * the handoff window — offered but not yet picked up, the only way one waits at all now — stays
   * and runs: it is a question the user asked, and dropping it silently would answer nothing while
   * looking like it had.
   */
  async interrupt(): Promise<void> {
    // STOPPING THE TURN IS STOPPING THE PROCEDURE, because a procedure rides the turn that opened
    // it and there is no other turn it could be riding. Closed HERE rather than left to the
    // turn-end below, which would close it as `completed` — "the procedure finished without
    // publishing" — when what actually happened is that somebody stopped it. Ended BEFORE the model
    // is asked to stop, so anything it manages on its way out lands in no log: the same ordering
    // the cancel route used to have.
    if (this.gate.open()) this.gate.end("cancelled");
    const query = this.query;
    if (!query) return;
    try {
      await query.interrupt();
    } catch (err) {
      this.debug(`interrupt failed: ${describe(err)}`);
    }
  }

  /** End the session and stop listening. The SDK's store is untouched; it is the part that lasts. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Before the listeners go, so anyone still attached learns why the procedure stopped rather
    // than watching it hang at "generating" until they reload.
    this.gate.end("error");
    this.turns.close();
    this.input?.close();
    void this.query?.return(undefined).catch(() => {
      // A subprocess that will not close politely is not worth failing a shutdown over.
    });
    this.query = null;
    this.input = null;
    this.listeners.clear();
  }

  // -- the turn loop -------------------------------------------------------------------------

  private startDriving(): void {
    if (this.driving) return;
    // The loop owns its own failures — a rejection escaping here would be an unhandled one, and the
    // conversation would go quiet with nothing said about why.
    this.driving = this.drive()
      .catch((err: unknown) => {
        logError(this.db, "turn", `the turn loop failed: ${describe(err)}`, detailOf(err));
        this.emit({ type: "error", code: "internal", message: describe(err) });
      })
      .finally(() => {
        this.driving = null;
      });
  }

  private async drive(): Promise<void> {
    for (;;) {
      const turn = await this.turns.take();
      if (turn === null) return;
      this.busy = true;
      this.emit({ type: "turn_started" });
      try {
        await this.runTurn(turn);
        // A generation still open here is one whose turn ended without publishing. That is a
        // finished answer — the agent was asked to produce a report and said why it could not — so
        // the procedure closes rather than waiting for a publish that is not coming.
        this.gate.end("completed");
      } catch (err) {
        // Logged as well as emitted: the frame reaches whoever is watching right now, and a turn
        // that fell over while nobody was is exactly the failure worth being able to read later.
        logError(this.db, "turn", describe(err), detailOf(err));
        this.emit({ type: "error", code: "internal", message: describe(err) });
        this.gate.end("error");
        // A turn that threw took the session with it far more often than not, and a half-dead
        // session answers every later turn with the same failure. Dropping it costs the model's
        // working memory; the id survives in memory, so the next turn tries to reopen the same
        // conversation and only falls back to a fresh one if the SDK cannot.
        this.endSession();
      } finally {
        this.busy = false;
      }
    }
  }

  /**
   * Run one turn, with exactly one retry reserved for a resume that could not be honoured.
   *
   * The SDK is asked to reopen a session it may no longer have, and that failure is expected rather
   * than exceptional. Two paths reach it and both are ordinary: a conversation the USER picked out
   * of the session list, which the SDK has since pruned, rotated or moved; and a same-boot reopen
   * after a thrown turn ended the query while leaving the id in memory. Neither is distinguishable
   * from a real error until it has been tried. So the first turn against a remembered id gets a
   * second attempt with no `resume` at all, and only that one.
   */
  /**
   * The live input queue.
   *
   * `startSession` is what creates one, and every caller below has just made sure a session is
   * open — so a null queue here is this file mis-sequencing itself, not a condition a caller could
   * have caused or could recover from. It says exactly that, rather than reading a property of
   * null several frames later where the message names neither the queue nor the turn.
   */
  private requireInput(): InputQueue {
    if (this.input === null) {
      throw new Error("no input queue: a turn was pushed before its session was started");
    }
    return this.input;
  }

  private async runTurn(turn: Turn): Promise<void> {
    const reopening = this.query === null && this.sessionId !== null;
    if (this.query === null) this.startSession(this.sessionId ?? undefined);

    this.requireInput().push(userMessage(turn.text));
    try {
      await this.consume();
      return;
    } catch (err) {
      if (!reopening) throw err;
      this.debug(`could not reopen session ${this.sessionId}: ${describe(err)}`);
    }

    this.endSession();
    // Memory only, and only here: the id named a conversation the SDK will not open, so holding it
    // would mean trying the same impossible thing on every later turn.
    this.sessionId = null;
    this.fresh = true;
    this.startSession(undefined);
    // Said again, and only here: the client drew this conversation believing the model remembered
    // it, and it does not.
    this.emit(this.readyFrame());
    // And the list is wrong too — the session it shows as current is one nothing is talking to.
    this.events({ type: "sessions_changed" });
    this.requireInput().push(userMessage(turn.text));
    await this.consume();
  }

  /**
   * Read messages until the turn's result arrives.
   *
   * Pulled with `next()` rather than walked with `for await`, and that is not a style choice:
   * leaving a `for await` early calls `return()` on the generator, which would end the session at
   * the bottom of every turn. One `Query` lives as long as the conversation does.
   */
  private async consume(): Promise<void> {
    const query = this.query;
    if (!query) throw new Error("no agent session to read from");
    for (;;) {
      const { value, done } = await query.next();
      if (done) {
        if (this.disposed) return;
        throw new Error("the agent session ended before the turn finished");
      }
      if (value.type === "result") {
        this.finishTurn(value);
        return;
      }
      this.handle(value);
    }
  }

  private handle(message: SDKMessage): void {
    switch (message.type) {
      case "stream_event": {
        const event = message.event as
          | { type?: string; delta?: { type?: string; text?: string } }
          | undefined;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const text = event.delta.text;
          if (text) this.emit({ type: "text_delta", text });
        }
        return;
      }
      case "assistant": {
        // Only tool calls are read out of an assistant message. Its text arrived as deltas already,
        // and the durable copy is the SDK's — reading it here a second time would produce nothing
        // this module has anywhere to put.
        // Guarded like the `user` case below, and for the same reason: `content` is whatever the
        // SDK put there. A string would iterate character by character and a non-iterable would
        // throw out of a reader whose whole job is to keep reading.
        const content = message.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content as AssistantBlock[]) {
          if (block.type === "tool_use" && typeof block.id === "string") {
            const name = block.name ?? "";
            this.openTools.set(block.id, name);
            this.emit({
              type: "tool_start",
              tool: name,
              toolUseId: block.id,
              summary: toolSummary(block.input),
            });
          }
        }
        return;
      }
      case "user": {
        const content = message.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content as ResultBlock[]) {
          const id = block?.tool_use_id;
          if (typeof id !== "string") continue;
          this.emit({
            type: "tool_end",
            tool: this.openTools.get(id) ?? "",
            toolUseId: id,
            ok: block.is_error !== true,
            summary: resultSummary(block.content),
          });
          this.openTools.delete(id);
        }
        return;
      }
      case "system": {
        if (message.subtype === "init") {
          this.noteSession(message.session_id);
        } else if (message.subtype === "compact_boundary") {
          // Surfaced as well as logged, because the SDK's store is the only transcript there is: a
          // window that refetches after this finds the earlier half of what it drew simply gone, and
          // without a marker in the stream that reads as amnesia rather than as compaction. The
          // trigger is the SDK's own word for why it fired, passed through rather than interpreted.
          const trigger = message.compact_metadata?.trigger ?? "auto";
          this.emit({ type: "compacted", trigger });
          this.debug(`session compacted (${trigger})`);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Close the turn out: keep what it cost, and note that the conversation on disk has moved.
   *
   * Done here, at the bottom of the turn, rather than anywhere higher up — this is also the path a
   * turn takes when nobody is watching it, and those words were produced and paid for like any
   * others.
   *
   * The cost is ACCUMULATED and not broadcast. It rides the session's own snapshot, where it answers
   * "what has this installation spent"; it used to ride the frame as well and be drawn under every
   * message, which is a running meter on a local tool the reader is not billed by the message for —
   * noise beside the answer rather than information about it.
   */
  private finishTurn(result: Extract<SDKMessage, { type: "result" }>): void {
    this.noteSession(result.session_id);
    const cost = typeof result.total_cost_usd === "number" ? result.total_cost_usd : null;
    if (cost !== null) this.totalCostUsd += cost;

    this.emit({ type: "turn_result", subtype: result.subtype });
    this.openTools.clear();
    // The SDK has just appended this turn to its store and may have renamed the conversation from
    // it — the session list's summary and modified time are both stale as of now. What moved is on
    // disk, on a flush cadence nothing here controls, so this says "look again" and nothing more.
    this.events({ type: "sessions_changed" });
  }

  // -- session lifecycle ---------------------------------------------------------------------

  private startSession(resume: string | undefined): void {
    // The home directory is this session's cwd, the only place its shell may write, and the SDK's
    // project key. Created here rather than assumed so an installation whose var directory was
    // moved or partly cleaned still opens a session instead of failing at the subprocess.
    const home = homeDir(this.settings);
    mkdirSync(home, { recursive: true });

    // Built once per boot, not once per session: a tool closes over the database, the venv and this
    // agent's emit, and none of the three is changed by starting a different conversation.
    if (this.mcpServer === null) {
      const built = this.toolsFactory({
        db: this.db,
        settings: this.settings,
        mode: this.mode,
        venv: this.venv,
        emit: (frame) => this.emit(frame),
        runs: this.gate.runLog,
        // The tool surface's one door onto the gate: opening a procedure, and nothing else about
        // it. Handed as a lambda rather than as the gate itself so that a tool holds exactly the
        // one verb — it cannot cancel a procedure, drive this session, or ask it anything.
        procedure: { start: (recipeId) => this.gate.start(recipeId) },
        // Through a closure rather than by value, so tools built before the server attached its
        // broadcast still announce into the live one.
        events: (frame) => this.events(frame),
      });
      this.mcpServer = built.server;
      this.toolNames = built.names;
    }

    const options = buildAgentOptions({
      settings: this.settings,
      resources: this.resources,
      venv: this.venv(),
      mcpServer: this.mcpServer,
      toolNames: this.toolNames,
      model: this.model,
      effort: this.effort,
      subagents: this.subagents,
      resume,
      generating: () => this.gate.open(),
    });

    this.input = new InputQueue();
    const query = this.queryFn({ prompt: this.input.stream(), options });
    this.query = query;
    this.openTools.clear();

    // What this CLI can actually reach, asked once per boot and never awaited here: `attach()` is
    // synchronous and there is no `Query` before this line, so the first `ready` any window sees
    // carries the fallback list by construction. When the real one lands, `ready` is re-emitted —
    // the same shape `noteSession` uses for the session id, and for the same reason: a fact the
    // window needs, learnable only after the moment it first asked.
    //
    // A failure leaves the fallback standing and is logged rather than surfaced. A picker offering a
    // handful of plausible names is worth more to a reader than an empty one with an explanation.
    //
    // The answer is curated on the way in rather than taken verbatim, through the same gate the
    // fallback goes through — which is what keeps the two lists saying the same thing about Haiku
    // and Fable, instead of the picker's contents depending on how long a boot has been running.
    if (this.models === null) {
      void query
        .supportedModels()
        .then((list) => {
          // Handed over whole rather than narrowed first: the curation reads a field the picker
          // does not draw, and it is `curateModels` that narrows on the way out.
          this.models = curateModels(list);
          this.emit(this.readyFrame());
        })
        .catch(() => {
          /* the fallback stands; a picker is not worth a failed turn */
        });
    }
  }

  private endSession(): void {
    this.input?.close();
    void this.query?.return(undefined).catch(() => {
      /* a subprocess that will not close politely does not get to fail the next turn */
    });
    this.query = null;
    this.input = null;
  }

  /**
   * Remember what the SDK is actually calling this conversation.
   *
   * Memory only. Nothing writes the id down, because the thing it names is a live session belonging
   * to this process and the SDK's store is the only authority on which sessions still exist.
   *
   * The re-emitted `ready` is load-bearing rather than tidy. A window that attached before the first
   * turn was told `sessionId: null`, truthfully — the session did not exist yet — and it has no
   * other way to learn the name of the one that now does. That name is what it fetches the
   * transcript by, so without this frame every tab open at the start of a fresh conversation would
   * be watching a conversation it could not afterwards read back.
   */
  private noteSession(reported: string | undefined): void {
    if (!reported || reported === this.sessionId) return;
    this.sessionId = reported;
    this.emit(this.readyFrame());
    this.events({ type: "sessions_changed" });
  }

  // -- plumbing ------------------------------------------------------------------------------

  private readyFrame(): OutboundFrame {
    return {
      type: "ready",
      model: this.model,
      models: this.models ?? fallbackModels(this.settings.model),
      effort: this.effort,
      subagents: this.subagents,
      fresh: this.fresh,
      venvReady: this.venv().ready,
      sessionId: this.sessionId,
    };
  }

  private emit(frame: OutboundFrame): void {
    for (const listener of this.listeners) this.deliver(listener, frame);
  }

  /** A listener that throws is a socket that has gone away mid-write, never a reason to stop. */
  private deliver(listener: Emit, frame: OutboundFrame): void {
    try {
      listener(frame);
    } catch (err) {
      this.debug(`a listener threw on a ${frame.type} frame: ${describe(err)}`);
    }
  }

  private debug(message: string): void {
    if (this.settings.logLevel === "debug") {
      console.debug(`[YewReview] ${message}`);
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What rides beside a logged failure.
 *
 * A message alone is what a person reads; a stack is what tells them where to look. The error log
 * takes any JSON-able value and truncates it, so handing it the whole stack costs nothing and a
 * thrown non-Error still says what it was rather than being dropped.
 */
function detailOf(err: unknown): unknown {
  return err instanceof Error
    ? { name: err.name, stack: err.stack ?? null }
    : { value: String(err) };
}
