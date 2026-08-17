/**
 * The chat socket, and the seam between the installation's one agent and whoever happens to be
 * watching it.
 *
 * TWO ARCHITECTURAL FACTS carry this whole module, and both are easy to get wrong when reading it.
 *
 * **The agent belongs to the SERVER, not to the socket.** Giving every connection its own client
 * would mean a closed tab had to be answered by draining the turn in the background for ten minutes
 * so the transcript would not lose it, and two tabs would be two conversations. Here a socket
 * ATTACHES to a long-lived agent as an observer and detaches when it closes. Disconnect-drain,
 * multi-tab fan-out, and "the turn happens whether or not anyone was watching" are then not features
 * but consequences.
 *
 * **There is ONE conversation, and therefore one socket path.** `/ws/chat` names no recipe,
 * because a recipe is a record the conversation works ON rather than a place the conversation
 * happens IN. So there is no id segment and no decoder for one, no 4004 close for "no recipe by
 * that id", no map of which sockets watch which recipe, and no sweep closing them when one is
 * deleted. A chat SURVIVES the deletion of any recipe it has been talking about, which is the
 * point rather than an accident — the person is mid-sentence, the recipe was one of several things
 * they were discussing, and a socket that hung up on them would be answering a question they did not
 * ask.
 *
 * **Nothing here writes to a transcript**, and nothing anywhere does: the SDK's session store is the
 * record, read back over HTTP by `/api/sessions/:id/messages`. A socket that recorded messages would
 * record them once per attached tab, and not at all for a turn nobody watched.
 *
 * The outbound queue is per SOCKET and its ordering is absolute. `text_delta` is the only frame this
 * module will drop under backpressure, because the finished text is in the SDK's store anyway; a
 * chart, a published report or a turn result is the thing the reader is actually waiting for, and
 * arriving late is recoverable where arriving out of order is not.
 *
 * `Agent` is DECLARED here and implemented twice, once per harness: `src/claudecode/session.ts` and
 * `src/opencode/agent.ts`. The interface lives on the consumer's side on purpose: the server is what
 * knows when a socket attaches and how deep a turn queue may get, and an interface owned by either
 * implementation would grow whatever that implementation found convenient — and the other one would
 * then be implementing its neighbour's habits.
 */

import type { Database } from "bun:sqlite";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";

import type { Emit, EventsFrame, OutboundFrame } from "../protocol/types.ts";
import type { Settings } from "../config.ts";
import type { ProcessMode } from "../db/lock.ts";
import type { OpencodeStatus } from "../opencode/probe.ts";
import type { PoolStore } from "../opencode/config.ts";
import type { AnyToolDefinition } from "../tools/def.ts";
import { logError } from "../repo/logs.ts";
import type { Resources } from "../resources/embed.ts";
import type { VenvStatus } from "../sandbox/venv.ts";
import type { SessionsApi } from "./sessions.ts";

/**
 * The installation's agent, for as long as this process lives.
 *
 * NARROW ON PURPOSE, and narrower than the class that satisfies it: what the HTTP and socket
 * surfaces are allowed to do to a conversation is exactly this list. `attach` returns its own detach
 * rather than taking a token back, so a socket cannot detach somebody else's emit — and cannot
 * forget which one was its own.
 *
 * IT USED TO CARRY TWO MORE, and their going is the whole of what moving generation into the
 * conversation cost this layer. `startGeneration` and `cancelGeneration` were here because a route
 * opened procedures; the agent opens its own now, with a tool, and stopping one is interrupting the
 * turn it rides — which is `interrupt`, already on this list. The one method still taking an id
 * is none of them: `resume` takes a SESSION id, and nothing on this interface names a recipe
 * any more.
 */
export interface Agent {
  /**
   * Start listening, and receive a `ready` frame SYNCHRONOUSLY before any other.
   *
   * That delivery is part of the contract rather than a convenience. A tab attaching mid-turn must
   * not be handed a `text_delta` from the middle of a sentence before anything has said which model
   * is speaking, which conversation this is, or whether it remembers the one the browser is already
   * drawing — and the agent is the only thing that knows the truthful answer to any of the three.
   */
  attach(emit: Emit): () => void;
  submitTurn(text: string): void;
  interrupt(): Promise<void>;
  /** Reopen a conversation the user picked out of the session list. Refused while anything is in
   * flight, because switching then would leave an answer being written into a conversation nobody
   * is reading. */
  resume(sessionId: string): { ok: true } | { ok: false; code: string; message: string };
  /** Put the current conversation down and start the next turn empty. The old one is still in the
   * SDK's store and still resumable — this is about what the model carries, not what is kept. */
  clear(): { ok: true } | { ok: false; code: string; message: string };
  /** Answer the next turn with another model. Refused while the agent is working, and refused for a
   * model this installation cannot reach — the picker draws its options from the `ready` frame, so
   * a request outside that list is a stale window rather than a choice. */
  setModel(model: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** Work the next turn at another effort level. Refused while the agent is working, on the same
   * guard `setModel` uses, and refused for anything that is not one of the SDK's five levels — the
   * picker draws its options from the `ready` frame, so a request outside them is a stale window
   * rather than a choice. Same result shape as `setModel` because it is the same kind of answer:
   * one that succeeded silently, or one sentence saying why it did not. */
  setEffort(effort: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** Let this conversation delegate, or stop it delegating. Refused while the agent is working, on
   * the guard the two above share — and here the refusal matters more, because honouring the change
   * ends the session the agent is answering out of. The same result shape as its neighbours: one
   * that succeeded silently, or one sentence saying why it did not. */
  setSubagents(
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  snapshot(): {
    model: string;
    fresh: boolean;
    busy: boolean;
    queued: number;
    sessionId: string | null;
  };
}

/**
 * Everything the HTTP and WebSocket surfaces are allowed to reach.
 *
 * Declared here, beside the agent interface, because `agent` is the reason this type is not just
 * "the database and the settings" — and because putting it in `serve.ts` would make `routes.ts`
 * import the module that imports it.
 */
export type ServerDeps = {
  db: Database;
  settings: Settings;
  agent: Agent;
  /**
   * Whether this process holds the var root's write claim — see `db/lock.ts`.
   *
   * A value rather than a probe, on the `sandbox` argument below: the answer is decided once at
   * boot and only changes with a restart, which is also when a reader would become the writer.
   * Health reports it, and `requireWriter` in `routes.ts` refuses the var-file writes with it.
   */
  mode: ProcessMode;
  /**
   * Whichever harness's session store, behind a seam.
   *
   * Here rather than reached for directly by the routes so the suite can hand them an in-memory list
   * of conversations: a real store is written only by a real subprocess having really answered, and
   * a route test asserting on sorting and live-marking should not have to buy a turn to get one.
   * See `server/sessions.ts` for the interface and each harness's `sessions.ts` for a reader.
   */
  sessions: SessionsApi;
  /**
   * The extracted embedded resources. Held rather than read: nothing on the HTTP surface serves an
   * embedded asset today, and the seam carries it so the boot has exactly one place to hand it over
   * when the report surface does.
   */
  resources: Resources;
  venv: () => VenvStatus;
  /**
   * Whether an OS sandbox is actually available here, answered once at boot.
   *
   * A value rather than a probe: on Linux the answer costs two subprocesses, health is what a
   * window polls, and the answer only changes when somebody installs bubblewrap — which is also
   * when they restart YewReview to see whether it worked.
   */
  sandbox: { available: boolean; hint: string | null };
  /**
   * The opencode harness's own surface, present only when that is the harness running.
   *
   * Absent on the Claude path, which is what makes `GET /api/opencode/models` a 404 there rather
   * than a route answering about a pool nothing reads. The routes are mounted from this, so the
   * absence is structural rather than a condition inside a handler.
   */
  opencode?: {
    pool: PoolStore;
    status: () => OpencodeStatus;
    /** The bearer the MCP bridge accepts, or null while no child is running. */
    mcpSecret: () => string | null;
    tools: () => readonly AnyToolDefinition[];
    /** Whether the agent is settled enough for the pool to be rewritten under it. */
    reloadable: () => { ok: true } | { ok: false; code: string; message: string };
  } | undefined;
  /**
   * Re-run venv provisioning, for `POST /api/venv/retry`. Provisioning failure is not fatal — see
   * `sandbox/venv.ts` — so the first thing a user does about a failed one is ask for it again, and
   * the boot is the only thing holding the wheel and the requirements to do it with.
   */
  reprovision: () => Promise<VenvStatus>;
  /**
   * Hand the boot the events broadcaster, once the server owns one.
   *
   * Inverted on purpose. The things that need to say "the installation moved" — the agent's tools,
   * the two logs — are built BEFORE the server, so they cannot be handed a broadcaster that does not
   * exist yet; instead the boot keeps a settable slot and the server fills it at startup. Optional
   * because the test server has nobody to tell.
   */
  attachEvents?: (broadcast: (frame: EventsFrame) => void) => void;
};

/** The URL the one chat socket connects to. No id: there is one conversation per installation. */
const CHAT_PATH = "/ws/chat";

/**
 * How many frames may wait for one slow socket before the queue starts shedding prose. A thousand
 * deltas is a few paragraphs; a socket that far behind is a tab the machine has suspended.
 */
const OUTBOUND_MAX = 1000;

/** A user message larger than this is not a question. Enforced by Bun before we see the frame. */
const MAX_INBOUND_BYTES = 1024 * 1024;

/** Built in `open`, because the socket does not exist before then. */
export type ChatSocketData = { connection: ChatConnection | null };

export type ChatHub = {
  /** Whether a request path is the chat socket at all. Asked before `upgrade`. */
  isChatPath(pathname: string): boolean;
  /**
   * Take the request over as a WebSocket. Returns `undefined` when Bun has it — which is what the
   * fetch handler must then return, since replying twice to one request is a protocol error.
   */
  upgrade(server: Server<ChatSocketData>, req: Request, pathname: string): Response | undefined;
  handlers: WebSocketHandler<ChatSocketData>;
};

export function createChatHub(deps: ServerDeps): ChatHub {
  return {
    isChatPath(pathname: string): boolean {
      return pathname === CHAT_PATH;
    },

    upgrade(
      server: Server<ChatSocketData>,
      req: Request,
      pathname: string,
    ): Response | undefined {
      // Nothing is looked up before the upgrade, because there is nothing to look up: the path
      // names the installation's conversation, which exists as surely as the process does.
      const data: ChatSocketData = { connection: null };
      if (server.upgrade(req, { data })) return undefined;
      return new Response(
        JSON.stringify({
          error: "invalid_request",
          message: `${pathname} is a WebSocket endpoint; connect to it with a WebSocket`,
        }),
        { status: 426, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    },

    handlers: {
      maxPayloadLength: MAX_INBOUND_BYTES,

      open(ws) {
        let connection: ChatConnection;
        try {
          connection = new ChatConnection(ws, deps);
          connection.start();
        } catch (err) {
          // Attaching can fail — a listener that throws, an agent already disposed by a shutdown
          // racing this connection. A socket left open on an agent it never reached would take the
          // user's next message and lose it, so it is closed with the reason instead, and the
          // failure is filed: a socket that would not open is exactly the kind of thing nobody is
          // watching a console for at the moment it happens.
          const message = err instanceof Error ? err.message : String(err);
          console.error("could not open the chat socket", err);
          logError(deps.db, "turn", `a chat socket could not be opened: ${message}`, err);
          ws.close(1011, "the agent could not be reached");
          return;
        }
        ws.data.connection = connection;
      },

      message(ws, raw) {
        ws.data.connection?.receive(typeof raw === "string" ? raw : raw.toString());
      },

      close(ws) {
        const connection = ws.data.connection;
        if (!connection) return;
        ws.data.connection = null;
        connection.stop();
      },

      drain(ws) {
        ws.data.connection?.resume();
      },
    },
  };
}

/**
 * One browser watching the conversation.
 *
 * The queue is the whole of it. Frames go in from the agent (through the emit this attached) and
 * from the socket's own replies, and exactly one pump takes them out in order — which is what keeps
 * a chart from arriving in the middle of the sentence that introduces it.
 */
class ChatConnection {
  private readonly ws: ServerWebSocket<ChatSocketData>;
  private readonly agent: Agent;
  private readonly queue: OutboundFrame[] = [];
  /** True while Bun is holding a buffered message; cleared by `drain`. */
  private paused = false;
  private stopped = false;
  private detach: (() => void) | null = null;

  constructor(ws: ServerWebSocket<ChatSocketData>, deps: ServerDeps) {
    this.ws = ws;
    this.agent = deps.agent;
  }

  /**
   * Start listening.
   *
   * `ready` is not sent from here. `attach` delivers one to the arriving listener synchronously,
   * before any other frame can reach it, which is exactly the ordering this socket needs: a second
   * tab opening mid-turn must not receive a `text_delta` from the middle of a sentence before
   * anything has told it which model is speaking or which conversation it is watching.
   *
   * Sending a second one here would put two `ready` frames on every connection, and would say them
   * less well: the agent is the only honest source of `fresh` and `sessionId`, and the only thing
   * that can know when a resume failed mid-turn and the frame has to be said AGAIN.
   */
  start(): void {
    this.detach = this.agent.attach((frame) => this.push(frame));
  }

  /** Detach and go quiet. The agent keeps working — that is the point of it being the server's. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.detach?.();
    this.detach = null;
  }

  // -- outbound --------------------------------------------------------------------------------

  private push(frame: OutboundFrame): void {
    if (this.stopped) return;
    const shed = makeRoom(this.queue, frame, OUTBOUND_MAX);
    if (shed.dropped !== null && shed.dropped.type !== "text_delta") {
      console.warn(
        `a chat socket is ${OUTBOUND_MAX} frames behind and had no prose left to shed; ` +
          `dropped a ${shed.dropped.type} frame`,
      );
    }
    if (!shed.admit) return;
    this.queue.push(frame);
    this.pump();
  }

  /** Bun has flushed its buffer; keep going from where the pump stopped. */
  resume(): void {
    this.paused = false;
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && !this.paused && this.queue.length > 0) {
      const frame = this.queue[0]!;
      const sent = this.ws.send(JSON.stringify(frame));
      if (sent === 0) {
        // Refused outright — the socket is closing or over its backpressure limit. The frame stays
        // at the head so `drain` resends it rather than skipping it.
        this.paused = true;
        return;
      }
      this.queue.shift();
      if (sent === -1) {
        // Accepted into Bun's buffer, which is now full enough to say so. Wait for `drain`.
        this.paused = true;
        return;
      }
    }
  }

  // -- inbound ---------------------------------------------------------------------------------

  receive(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.push({ type: "error", code: "bad_frame", message: "expected one JSON object per frame" });
      return;
    }
    if (typeof frame !== "object" || frame === null) {
      this.push({ type: "error", code: "bad_frame", message: "expected one JSON object per frame" });
      return;
    }
    const body = frame as Record<string, unknown>;
    switch (body["type"]) {
      case "user_message":
        this.submit(body);
        return;
      case "interrupt":
        // Interrupting stops the model, not a tool: a measurement already running is a compiled
        // numeric routine with no cancellation point, and finishes.
        this.agent.interrupt().catch((err: unknown) => {
          this.push({ type: "error", code: "interrupt_failed", message: String(err) });
        });
        return;
      case "set_model":
        this.changeModel(body);
        return;
      case "set_effort":
        this.changeEffort(body);
        return;
      case "set_subagents":
        this.changeSubagents(body);
        return;
      case "ping":
        this.push({ type: "pong" });
        return;
      default:
        this.push({
          type: "error",
          code: "bad_frame",
          // Every accepted type, named. A message that listed five of the six would be a lie about
          // the vocabulary told to the one reader — somebody debugging a frame by hand — who has
          // nothing else to go on, so a frame added to the switch above is added here in the same
          // edit.
          message:
            `unknown frame type ${JSON.stringify(body["type"])}; expected user_message, ` +
            `interrupt, set_model, set_effort, set_subagents or ping`,
        });
    }
  }

  private submit(body: Record<string, unknown>): void {
    const raw = body["text"];
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      // Silently ignored rather than refused. A blank send is a stray keypress, not a request, and
      // an error frame for it would be a line in the conversation the reader can do nothing about.
      return;
    }
    // Read from the agent rather than counted here: the turn belongs to the agent, and a
    // per-socket flag would let two tabs each believe the agent was theirs to interrupt. ONE TURN
    // AT A TIME: a message sent while the agent is working is refused, not queued — a parked
    // question is answered minutes later out of a conversation that has moved on. `queued` covers
    // the handoff window between a submit and the drive loop picking it up, when `busy` is still
    // false and a turn nonetheless exists. The refusal goes down THIS socket only; the harness's
    // own guard broadcasts, and that pair is what keeps a race between two tabs from stranding
    // either one.
    const snapshot = this.agent.snapshot();
    if (snapshot.busy || snapshot.queued > 0) {
      this.push({
        type: "error",
        code: "busy",
        message:
          "the agent is still working on the last message; stop it, or wait for it to finish, " +
          "before sending another",
      });
      return;
    }
    this.agent.submitTurn(text);
  }

  /**
   * Ask the agent to answer with another model.
   *
   * Nothing is pushed on success: the agent re-emits `ready` to EVERY window, which is what makes a
   * second tab agree with the first. Only the refusal comes back down this socket, because only the
   * window that asked is waiting for one.
   */
  private changeModel(body: Record<string, unknown>): void {
    const raw = body["model"];
    const model = typeof raw === "string" ? raw.trim() : "";
    if (model === "") {
      this.push({ type: "error", code: "bad_frame", message: "set_model needs a model to set" });
      return;
    }
    void this.agent
      .setModel(model)
      .then((result) => {
        if (!result.ok) this.push({ type: "error", code: result.code, message: result.message });
      })
      .catch((err: unknown) => {
        this.push({ type: "error", code: "internal", message: String(err) });
      });
  }

  /**
   * Ask the agent to work the next turn at another effort level.
   *
   * The same shape as `changeModel` above and for the same reasons: nothing is pushed on success,
   * because the agent re-emits `ready` to EVERY window and that frame is the sole authority on what
   * the level now is — a confirmation down this socket would be a second answer, and the one tab
   * that heard it would be the only one drawing from it. Only the refusal comes back here, because
   * only the window that asked is waiting for one.
   *
   * The level is not checked against the five names here. That guard belongs to the agent, where
   * the value is actually seated, and duplicating it would mean two lists to keep in step with the
   * SDK's union — this half only has to notice a frame that named no level at all.
   */
  private changeEffort(body: Record<string, unknown>): void {
    const raw = body["effort"];
    const effort = typeof raw === "string" ? raw.trim() : "";
    if (effort === "") {
      this.push({ type: "error", code: "bad_frame", message: "set_effort needs a level to set" });
      return;
    }
    void this.agent
      .setEffort(effort)
      .then((result) => {
        if (!result.ok) this.push({ type: "error", code: result.code, message: result.message });
      })
      .catch((err: unknown) => {
        this.push({ type: "error", code: "internal", message: String(err) });
      });
  }

  /**
   * Ask the agent to start or stop delegating.
   *
   * The same shape as the two above, and silent on success for the same reason: the agent re-emits
   * `ready` to EVERY window and that frame is the sole authority on what this conversation may do,
   * so a confirmation down this one socket would be a second answer that only the tab which asked
   * could hear. Only the refusal comes back here — and it is the likeliest of the three to arrive,
   * because honouring the change ends the session and the agent will not do that under a turn.
   *
   * The payload is judged here and only here, unlike the level a `set_effort` carries: there are two
   * booleans and both are meaningful, so there is no vocabulary to keep in step with the SDK and
   * nothing for the agent to narrow. Anything that is not one of them is a hand-written frame or a
   * window this build has never shipped.
   */
  private changeSubagents(body: Record<string, unknown>): void {
    const enabled = body["enabled"];
    if (typeof enabled !== "boolean") {
      this.push({
        type: "error",
        code: "bad_frame",
        message: "set_subagents needs enabled to be true or false",
      });
      return;
    }
    void this.agent
      .setSubagents(enabled)
      .then((result) => {
        if (!result.ok) this.push({ type: "error", code: result.code, message: result.message });
      })
      .catch((err: unknown) => {
        this.push({ type: "error", code: "internal", message: String(err) });
      });
  }
}

/** What a full queue did to make room: whether the incoming frame goes in, and what was lost. */
export type Shed = { admit: boolean; dropped: OutboundFrame | null };

/**
 * Make room in a full outbound queue, in place.
 *
 * Three rules, in the order it costs to break them: never reorder, never drop something the reader
 * is waiting for, never grow without bound.
 *
 * `text_delta` is the only frame willingly dropped, because the finished text is in the SDK's
 * session store and re-readable from there. An arriving delta is dropped outright — it is the
 * cheapest thing in the queue and the socket is already behind. Otherwise the OLDEST delta is
 * spliced out, which makes room while leaving every surviving frame in the order it was produced.
 * Only a queue with no prose in it at all loses something that mattered, and that is chosen over
 * reordering or over holding a socket's worth of memory for a tab that has stopped reading.
 *
 * Exported because it is the one rule in this module that cannot be observed from outside a socket
 * that is behaving normally, and it is precisely the rule worth a test.
 */
export function makeRoom(queue: OutboundFrame[], incoming: OutboundFrame, max: number): Shed {
  if (queue.length < max) return { admit: true, dropped: null };
  if (incoming.type === "text_delta") return { admit: false, dropped: incoming };
  const oldestProse = queue.findIndex((queued) => queued.type === "text_delta");
  if (oldestProse >= 0) {
    return { admit: true, dropped: queue.splice(oldestProse, 1)[0] ?? null };
  }
  return { admit: true, dropped: queue.shift() ?? null };
}
