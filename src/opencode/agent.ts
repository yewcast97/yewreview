/**
 * The opencode harness: the same conversation, answered by a different program.
 *
 * It satisfies the `Agent` interface `src/server/chat.ts` declares — the same eleven methods the
 * Claude session does — so the window, the routes and the frames above it do not know which harness
 * is running. What differs is everything below: a child process instead of an SDK, an HTTP request
 * instead of a generator, models out of a pool instead of out of a CLI.
 *
 * **What it SHARES is deliberate and short.** The generation gate (`src/generation.ts`) and the run
 * log inside it, because provenance is a rule about the archive rather than a property of a
 * conversation; the tools (`src/tools/`), because they are the database's write surface; the
 * database and the measurement engine themselves. Nothing else — not the prompt, not the transcript
 * store, not the model list.
 *
 * **Lazily started, exactly like the Claude session.** No child process is spawned at boot: the
 * first turn starts one, and a machine that opens the window to read the archive never pays for a
 * coding agent it did not ask a question of.
 *
 * **A dead child is not a dead conversation.** The opencode session id survives in memory, so the
 * next turn spawns a fresh server and reopens the same session — the transcript is on disk and
 * belongs to opencode, which is the same trade the Claude path makes with the SDK's store.
 */

import type { Database } from "bun:sqlite";

import type { EffortLevel, Settings } from "../config.ts";
import { paths } from "../config.ts";
import type { ProcessMode } from "../db/lock.ts";
import { GenerationGate } from "../generation.ts";
import { toolSummary } from "../protocol/summary.ts";
import type {
  Emit,
  EventsFrame,
  ModelOption,
  OutboundFrame,
  ToolDeps,
} from "../protocol/types.ts";
import { logError } from "../repo/logs.ts";
import type { VenvStatus } from "../sandbox/venv.ts";
import { announcing } from "../tools/index.ts";
import type { AnyToolDefinition } from "../tools/def.ts";
import type { OpencodeRole, PoolStore } from "./config.ts";
import { PRIMARY_ROLE } from "./config.ts";
import type { OpencodeStatus } from "./probe.ts";
import { firstTurn } from "./prompt.ts";
import type { OpencodeEvent, OpencodeServer, ServerFactory } from "./server.ts";
import { spawnOpencodeServer } from "./server.ts";

export type OpencodeAgentOptions = {
  db: Database;
  settings: Settings;
  venv: () => VenvStatus;
  pool: PoolStore;
  status: () => OpencodeStatus;
  /** Whether this process holds the var root's write claim — see `db/lock.ts`. Optional on the
   * `events?` argument: tests overwhelmingly mean the writer, and the boot always says. */
  mode?: ProcessMode | undefined;
  events?: ((frame: EventsFrame) => void) | undefined;
  /** The transport seam a test replaces — the analogue of `queryFn` on the Claude path, faked for
   * the same stated reason: the cost of a real model, and a child process a suite must not need. */
  serverFactory?: ServerFactory | undefined;
  /** The tools this harness serves. Defaults to the shared, announcing-wrapped set. */
  tools?: readonly AnyToolDefinition[] | undefined;
};

type Turn = { text: string };

export class OpencodeAgent {
  private readonly db: Database;
  private readonly settings: Settings;
  private readonly pool: PoolStore;
  private readonly status: () => OpencodeStatus;
  private readonly serverFactory: ServerFactory;
  private readonly gate: GenerationGate;
  private readonly tools: readonly AnyToolDefinition[];

  private events: (frame: EventsFrame) => void;
  private readonly listeners = new Set<Emit>();
  private readonly queued: Turn[] = [];

  private server: OpencodeServer | null = null;
  private streaming: AbortController | null = null;
  private sessionId: string | null = null;
  private busy = false;
  private draining = false;
  private disposed = false;
  private fresh = true;
  private modelId: string | null = null;
  private totalCostUsd = 0;
  /**
   * The secret guarding both directions, minted once per boot.
   *
   * It has to exist before the config is written, because the config tells the child what bearer to
   * present at `/mcp` — so it cannot be something the spawn invents. One value rather than two: the
   * trust relationship is "this process started that child", and both doors are that relationship.
   */
  private readonly secret = crypto.randomUUID();

  constructor(options: OpencodeAgentOptions) {
    this.db = options.db;
    this.settings = options.settings;
    this.pool = options.pool;
    this.status = options.status;
    this.serverFactory = options.serverFactory ?? spawnOpencodeServer;
    this.events = options.events ?? (() => {});
    this.tools =
      options.tools ??
      announcing({
        db: options.db,
        settings: options.settings,
        mode: options.mode ?? "writer",
        venv: options.venv,
        emit: (frame) => this.emit(frame),
        runs: this.gateRunLog(),
        // Lazy for the same reason `gateRunLog` is, and it needs no forwarder object: the arrow
        // body reads `this.gate` when a tool calls it, which is long after the constructor.
        procedure: { start: (recipeId) => this.gate.start(recipeId) },
        events: (frame) => this.events(frame),
      } as ToolDeps);
    this.gate = new GenerationGate({
      db: options.db,
      emit: (frame) => this.emit(frame),
      venv: options.venv,
      closed: () => this.disposed,
      turnInFlight: () => this.busy,
    });
    this.modelId = this.pool.entryFor(PRIMARY_ROLE)?.id ?? null;
  }

  /**
   * The gate's run log, reached before the gate exists.
   *
   * `tools` and `gate` are both constructed here and each wants the other: the tools are handed a
   * `RunLog` and the gate owns it. The indirection is one line and the alternative is a two-phase
   * construction that a reader has to hold in their head. The `procedure` capability beside it
   * survives the same ordering for the same reason, and needs no object of its own — a single
   * method is one arrow, and the arrow reads `this.gate` when it is called.
   */
  private gateRunLog(): ToolDeps["runs"] {
    const self = this;
    return {
      recording: () => self.gate.runLog.recording(),
      recipeId: () => self.gate.runLog.recipeId(),
      begin: (start, at) => self.gate.runLog.begin(start, at),
      entries: () => self.gate.runLog.entries(),
      retain: (run) => self.gate.runLog.retain(run),
      redeem: (runId) => self.gate.runLog.redeem(runId),
      end: (reason) => self.gate.runLog.end(reason),
    };
  }

  attachEvents(broadcast: (frame: EventsFrame) => void): void {
    this.events = broadcast;
  }

  /** The tool definitions this harness serves, for the MCP bridge the server mounts. */
  toolDefinitions(): readonly AnyToolDefinition[] {
    return this.tools;
  }

  /**
   * The running server, for the session seam to read transcripts through.
   *
   * Null before the first turn, which is the honest answer to "what conversations are there": none
   * have been started. Spawning a coding agent to answer a question about history would make
   * opening the archive cost a subprocess.
   */
  liveServer(): OpencodeServer | null {
    return this.server !== null && this.server.alive ? this.server : null;
  }

  /**
   * Whether the pool can be rewritten right now.
   *
   * The pool is rendered into the config the child was started with, so saving one mid-turn would
   * mean a conversation whose model changed underneath it. Same guard the model picker uses, for
   * the same reason.
   */
  reloadable(): { ok: true } | { ok: false; code: string; message: string } {
    return this.refuseWhileWorking("saving the model pool") ?? { ok: true };
  }

  /**
   * The bearer the MCP bridge accepts, or null while no child is running.
   *
   * Null closes the door rather than opening it: with no child there is nothing legitimate calling
   * `/mcp`, and a bridge that answered anyway would be answering whatever else on the machine
   * found the port.
   */
  mcpSecret(): string | null {
    return this.server === null ? null : this.secret;
  }

  attach(emit: Emit): () => void {
    this.listeners.add(emit);
    // Synchronously, before anything else can reach this socket — the contract the chat surface is
    // written against.
    emit(this.readyFrame());
    return () => {
      this.listeners.delete(emit);
    };
  }

  snapshot(): {
    model: string;
    effort: EffortLevel;
    subagents: boolean;
    fresh: boolean;
    busy: boolean;
    queued: number;
    sessionId: string | null;
    totalCostUsd: number;
    generation: { id: string; recipeId: string } | null;
  } {
    return {
      model: this.modelId ?? "",
      effort: this.settings.effort,
      subagents: true,
      fresh: this.fresh,
      busy: this.busy,
      queued: this.queued.length,
      sessionId: this.sessionId,
      totalCostUsd: this.totalCostUsd,
      generation: this.gate.running(),
    };
  }

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
    const unavailable = this.unavailable();
    if (unavailable !== null) {
      this.emit({ type: "error", code: unavailable.code, message: unavailable.message });
      return false;
    }
    const refusal = this.refuseWhileWorking("a second message");
    if (refusal !== null) {
      // `busy` rather than the guard's own `conflict` — the code the window's draft-restore path
      // keys on, and the same one the Claude path emits, so the two harnesses stopped disagreeing
      // about what a mid-turn message is called. One turn at a time is the rule; the Stop button
      // is the way out.
      this.emit({ type: "error", code: "busy", message: refusal.message });
      return false;
    }
    this.queued.push({ text: trimmed });
    void this.drain();
    return true;
  }

  /**
   * Why this harness cannot answer right now, or null.
   *
   * Three ways, and each is a sentence a person can act on rather than a failure mid-turn: opencode
   * is not installed or is a version this build will not drive; the pool has no model in it; or the
   * pool has models but nothing assigned to the role that answers.
   */
  private unavailable(): { code: string; message: string } | null {
    const status = this.status();
    if (!status.ok) {
      return {
        code: "opencode_unavailable",
        message: status.hint ?? "the opencode harness is not available on this machine",
      };
    }
    const document = this.pool.read();
    if (document.entries.length === 0) {
      return {
        code: "no_models",
        message:
          "no models are in the pool, so there is nothing to answer with. Open the model pool " +
          "from the composer and add one — a name, the provider's base url, an API key (or the " +
          "name of an environment variable holding one) and the model's id.",
      };
    }
    if (this.pool.entryFor(PRIMARY_ROLE) === null) {
      return {
        code: "no_models",
        message: `no model is assigned to the ${PRIMARY_ROLE} role, which is the one that answers. Drag a model from the pool onto that slot.`,
      };
    }
    return null;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const turn = this.queued.shift();
        if (turn === undefined) return;
        this.busy = true;
        this.emit({ type: "turn_started" });
        try {
          await this.runTurn(turn);
          this.gate.end("completed");
        } catch (err) {
          logError(this.db, "turn", "the opencode harness failed a turn", err);
          this.emit({
            type: "error",
            code: "turn_failed",
            message: err instanceof Error ? err.message : String(err),
          });
          this.gate.end("error");
          // The child is not trusted after a failed turn: it may be half-dead, mid-stream, or gone.
          // Dropping it costs one startup on the next turn and buys never driving a server whose
          // state nobody can describe.
          this.endServer();
        } finally {
          this.busy = false;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTurn(turn: Turn): Promise<void> {
    const server = await this.ensureServer();
    // Whether this turn opens the session decides whether it carries the doctrine, so it is asked
    // BEFORE the session is ensured — afterwards there is no way to tell a session that was just
    // created from one that was already there.
    const opening = this.sessionId === null;
    const sessionId = await this.ensureSession(server);
    const entry = this.pool.entryFor(PRIMARY_ROLE);
    if (entry === null) throw new Error("no model is assigned to the role that answers");
    const chosen = this.pool.read().entries.find((candidate) => candidate.id === this.modelId);
    const model = chosen ?? entry;

    // The event stream is opened BEFORE the prompt is sent, so the deltas of the turn's first
    // sentence are not lost to a subscription that arrived a moment late.
    const streaming = new AbortController();
    this.streaming = streaming;
    const consumed = this.consume(server, sessionId, streaming.signal);

    try {
      const response = await server.request("POST", `/session/${sessionId}/message`, {
        model: { providerID: model.id, modelID: model.model },
        // The doctrine rides the first turn of a session rather than a system prompt — see
        // `prompt.ts` for why that is the mechanism available here and what it costs.
        parts: [{ type: "text", text: opening ? firstTurn(turn.text) : turn.text }],
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`opencode refused the turn (${response.status}): ${detail}`);
      }
      // The reply body carries the finished assistant message; the frames a window drew came off
      // the event stream while it was being written.
      const message = (await response.json()) as { info?: { cost?: unknown } };
      const cost = message.info?.cost;
      // Accumulated onto the session's own snapshot rather than broadcast per turn — see
      // `finishTurn` on the Claude path, which made the same trade for the same reason.
      if (typeof cost === "number") this.totalCostUsd += cost;
      this.emit({ type: "turn_result", subtype: "success" });
    } finally {
      streaming.abort();
      this.streaming = null;
      await consumed;
    }
  }

  /**
   * Turn opencode's event bus into this window's frames.
   *
   * Four of its event types matter and the rest are somebody else's business — plugin registration,
   * catalog refreshes, integration state. Unknown types are ignored rather than logged: the stream
   * is opencode's whole internal bus, and a harness that complained about every unfamiliar frame would
   * be noisy about a feature release it is unaffected by.
   */
  private async consume(
    server: OpencodeServer,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Which tool calls have had a `tool_start` emitted, so the paired end fires once. opencode
    // reports a part repeatedly as it moves pending → running → completed.
    const open = new Set<string>();
    try {
      for await (const event of server.events(signal)) {
        if (event.properties?.["sessionID"] !== sessionId) continue;
        this.handle(event, open);
      }
    } catch {
      // An aborted stream is how every turn ends; a broken one is reported by the turn itself,
      // which is awaiting the request that matters.
    }
  }

  private handle(event: OpencodeEvent, open: Set<string>): void {
    const properties = event.properties ?? {};
    if (event.type === "message.part.delta") {
      // `field` names which of the part's fields the delta extends. Only prose is streamed to the
      // window: a reasoning delta is not what the transcript will hold, so drawing it would show a
      // reader something that vanishes when they reload.
      if (properties["field"] !== "text") return;
      const delta = properties["delta"];
      if (typeof delta === "string" && delta !== "") this.emit({ type: "text_delta", text: delta });
      return;
    }
    if (event.type !== "message.part.updated") return;

    const part = properties["part"];
    if (typeof part !== "object" || part === null) return;
    const shape = part as {
      type?: unknown;
      id?: unknown;
      tool?: unknown;
      state?: { status?: unknown; input?: unknown; error?: unknown } | undefined;
    };
    if (shape.type !== "tool" || typeof shape.id !== "string") return;

    const toolUseId = shape.id;
    const tool = typeof shape.tool === "string" ? shape.tool : "";
    const status = shape.state?.status;
    if (status === "running" && !open.has(toolUseId)) {
      open.add(toolUseId);
      this.emit({
        type: "tool_start",
        tool,
        toolUseId,
        summary: toolSummary(shape.state?.input),
      });
      return;
    }
    if (status === "completed" || status === "error") {
      if (!open.delete(toolUseId)) return;
      this.emit({
        type: "tool_end",
        tool,
        toolUseId,
        ok: status === "completed",
        summary: typeof shape.state?.error === "string" ? shape.state.error : "",
      });
    }
  }

  private async ensureServer(): Promise<OpencodeServer> {
    if (this.server !== null && this.server.alive) return this.server;
    this.server = null;
    const status = this.status();
    if (!status.ok || status.path === null) {
      throw new Error(status.hint ?? "the opencode harness is not available on this machine");
    }
    // Rendered fresh, so a pool edited while the harness was down is the pool the child reads —
    // and rendered WITH the secret, which is what puts YewReview's tools on the child's tool list.
    this.pool.materialize(this.secret);
    const server = await this.serverFactory({
      settings: this.settings,
      binary: status.path,
      configPath: paths(this.settings).opencodeConfigPath,
      secret: this.secret,
    });
    this.server = server;
    return server;
  }

  private async ensureSession(server: OpencodeServer): Promise<string> {
    if (this.sessionId !== null) return this.sessionId;
    const response = await server.request("POST", "/session", {});
    if (!response.ok) {
      throw new Error(`opencode would not open a session (${response.status})`);
    }
    const session = (await response.json()) as { id?: unknown };
    if (typeof session.id !== "string") throw new Error("opencode opened a session with no id");
    this.sessionId = session.id;
    this.fresh = false;
    this.emit(this.readyFrame());
    this.events({ type: "sessions_changed" });
    return session.id;
  }

  private endServer(): void {
    this.server?.stop();
    this.server = null;
  }

  async interrupt(): Promise<void> {
    // Stopping the turn is stopping the procedure it rides — see the same line in the Claude
    // session. Ended before the abort goes out, so nothing the child manages on its way down is
    // recorded under a report.
    if (this.gate.open()) this.gate.end("cancelled");
    const server = this.server;
    const sessionId = this.sessionId;
    if (server === null || sessionId === null) return;
    try {
      await server.request("POST", `/session/${sessionId}/abort`);
    } catch {
      // A server that will not take an abort is one the next turn will replace anyway.
    }
    this.streaming?.abort();
  }

  resume(sessionId: string): { ok: true } | { ok: false; code: string; message: string } {
    const refusal = this.refuseWhileWorking("switching conversations");
    if (refusal !== null) return refusal;
    this.sessionId = sessionId;
    this.fresh = false;
    this.modelId = this.pool.entryFor(PRIMARY_ROLE)?.id ?? null;
    this.emit(this.readyFrame());
    return { ok: true };
  }

  clear(): { ok: true } | { ok: false; code: string; message: string } {
    const refusal = this.refuseWhileWorking("clearing the conversation");
    if (refusal !== null) return refusal;
    this.sessionId = null;
    this.fresh = true;
    this.modelId = this.pool.entryFor(PRIMARY_ROLE)?.id ?? null;
    this.emit(this.readyFrame());
    this.events({ type: "sessions_changed" });
    return { ok: true };
  }

  setModel(model: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const refusal = this.refuseWhileWorking("changing the model");
    if (refusal !== null) return Promise.resolve(refusal);
    const entry = this.pool.read().entries.find((candidate) => candidate.id === model);
    if (entry === undefined) {
      return Promise.resolve({
        ok: false,
        code: "not_found",
        message: `${model} is not in this installation's model pool`,
      });
    }
    // In memory and applied per request — opencode takes the model on each message rather than
    // holding one for a session, so there is nothing to roll back if this were to fail. It is reset
    // to the pool's `build` model by `resume` and `clear`, which is what the Claude path does with
    // the installation default.
    this.modelId = entry.id;
    this.emit(this.readyFrame());
    return Promise.resolve({ ok: true });
  }

  /**
   * Refused, honestly, and it is the one interface method this harness cannot honour.
   *
   * Effort is the Claude SDK's own vocabulary. opencode routes reasoning through whatever each
   * provider exposes, per model, in the pool's own configuration — there is no installation-wide
   * dial to move, and inventing one that silently did nothing would be worse than saying so. The
   * window hides the picker on this harness; this refusal is for a stale tab that still draws it.
   */
  setEffort(effort: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    return Promise.resolve({
      ok: false,
      code: "invalid_request",
      message:
        `the opencode harness has no effort dial: how hard a model thinks is a property of the ` +
        `model and its provider here, set in the pool rather than per conversation (asked for ` +
        `${effort}).`,
    });
  }

  /**
   * Delegation is opencode's own, and cannot be turned off from here.
   *
   * Its subagents are roles in the config — `general`, `explore`, `scout` — each with a model this
   * pool assigns. Turning them off would mean rewriting the config and restarting the child, which
   * is a heavier thing than a toggle implies, and a reader who does not want delegation simply
   * leaves those roles unassigned.
   */
  setSubagents(
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    if (enabled) return Promise.resolve({ ok: true });
    return Promise.resolve({
      ok: false,
      code: "invalid_request",
      message:
        "the opencode harness delegates through roles of its own, and they are configured in the " +
        "model pool rather than switched here. Leave the subagent roles unassigned if you do not " +
        "want them used.",
    });
  }

  private refuseWhileWorking(
    because: string,
  ): { ok: false; code: string; message: string } | null {
    if (!this.busy && this.queued.length === 0 && !this.gate.open()) return null;
    return {
      ok: false,
      code: "conflict",
      message: `the agent is working; ${because} would land in the middle of a turn. Wait for it, or interrupt.`,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gate.end("error");
    this.queued.length = 0;
    this.streaming?.abort();
    this.endServer();
    this.listeners.clear();
  }

  private emit(frame: OutboundFrame): void {
    for (const listener of this.listeners) listener(frame);
  }

  private readyFrame(): OutboundFrame {
    const document = this.pool.read();
    const models: ModelOption[] = document.entries.map((entry) => ({
      value: entry.id,
      displayName: entry.name === "" ? entry.model : entry.name,
    }));
    return {
      type: "ready",
      model: this.modelId ?? "",
      models,
      effort: this.settings.effort,
      subagents: true,
      fresh: this.fresh,
      venvReady: true,
      sessionId: this.sessionId,
    };
  }
}

/** The roles a window draws slots for, re-exported so the routes have one import. */
export type { OpencodeRole };
