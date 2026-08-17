/**
 * The chat socket: one connection to the one agent, and the state machine that keeps it up.
 *
 * THERE IS NOTHING TO IDENTIFY. The conversation is global — one process-lifetime agent, one
 * `/ws/chat` with no id in it — so `connect()` takes no argument, the URL is a constant, and this
 * module has no notion of which conversation it is attached to. That is not a simplification so much
 * as a failure mode this client does not have: a socket that named a record could be pointed at one
 * somebody deleted, and would need a set of ids known to name nothing and a terminal state
 * for reaching one. A name that cannot go stale needs none of it. Which
 * session the agent is in is a fact about the agent, arrives on `ready`, and changes under
 * this socket without the socket changing at all.
 *
 * Four properties of the server's protocol shape everything below:
 *
 *   - **`ready` arrives after the socket opens**, because the server attaches the connection to a
 *     long-lived agent and that agent may still be starting. So `awaiting_ready` is a state of its
 *     own rather than a detail folded into `connecting`: an open socket is not yet a usable one, and
 *     the window has to say something honest during those seconds.
 *   - **A dropped connection loses the channel, not the work.** The agent belongs to the server and
 *     finishes the turn into the SDK's session store with nobody listening, and does not replay it.
 *     So a reconnect raises `onLost`, and the store answers by refetching the transcript.
 *   - **Every close is retryable.** There is no code this client treats as final: the server has one
 *     agent and one route, so a socket that cannot be opened is a server that is not up yet, and
 *     giving up would be this window deciding the process is never coming back.
 *   - **The server hangs up after 240 s of silence** (`WS_IDLE_TIMEOUT_S`). The 30 s ping below is
 *     what keeps a quiet conversation alive inside that window, and it is safe mid-turn: the server
 *     runs its receiver independently of the agent, so a pong is not queued behind a measurement.
 *     Which in turn is what makes 45 s of silence mean "gone" rather than "busy".
 *
 * Everything from the outside world — the socket constructor, the clock, the jitter — is injectable,
 * so the machine can be driven deterministically with no DOM at all.
 */

import type { EffortLevel, InboundFrame, OutboundFrame } from "../lib/protocol.ts";
import { parseFrame } from "../lib/protocol.ts";

/** Backoff: half a second, doubling, capped at eight, ±25% so two tabs do not retry in lockstep. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const BACKOFF_JITTER = 0.25;

const PING_INTERVAL_MS = 30_000;
const SILENCE_LIMIT_MS = 45_000;

/** `WebSocket.OPEN`, spelled out so this module never depends on the constructor being a browser's. */
const OPEN = 1;

/** As much of `WebSocket` as this client uses. The DOM's handler properties are typed with full
 * event objects, which is stricter than anything here needs, so the browser factory casts once. */
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type SocketFactory = (url: string) => SocketLike;

/** `awaiting_ready` is the gap between an open socket and the agent's first frame. There is no
 * terminal member: see the header on why every close here is worth retrying. */
export type ConnectionState =
  | "idle"
  | "connecting"
  | "awaiting_ready"
  | "ready"
  | "reconnecting"
  | "closed";

export type ChatSocketHandlers = {
  /** Every frame the server sent, `ready` and `pong` included. */
  onFrame(frame: OutboundFrame): void;
  onState(state: ConnectionState): void;
  /** The connection dropped and will be retried. A turn that was in flight has to be refetched. */
  onLost(): void;
};

export type ChatSocketOptions = {
  createSocket?: SocketFactory;
  /** Where the socket lives. Defaults to this page's own origin — same-origin by construction, which
   * is what lets the server carry no CORS header. */
  urlFor?: () => string;
  /** Jitter source, injected so a test can pin the backoff schedule. */
  random?: () => number;
};

/**
 * The page's own origin as a WebSocket URL.
 *
 * `location` is read off `globalThis` through a cast rather than as a global, so this module
 * compiles under the ROOT tsconfig — which has no DOM lib — and can therefore be driven by
 * `bun test` with an injected factory and no browser at all.
 */
function browserUrl(): string {
  const loc = (globalThis as { location?: { protocol: string; host: string } }).location;
  const scheme = loc?.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc?.host ?? ""}/ws/chat`;
}

function browserSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export class ChatSocket {
  private readonly createSocket: SocketFactory;
  private readonly urlFor: () => string;
  private readonly random: () => number;
  private readonly handlers: ChatSocketHandlers;

  private socket: SocketLike | null = null;
  private phase: ConnectionState = "idle";
  /** How many reconnects have been attempted since the last `ready`. */
  private attempt = 0;
  /** Set by `disconnect`: nothing may reconnect after it. */
  private stopped = true;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(handlers: ChatSocketHandlers, options: ChatSocketOptions = {}) {
    this.handlers = handlers;
    this.createSocket = options.createSocket ?? browserSocket;
    this.urlFor = options.urlFor ?? browserUrl;
    this.random = options.random ?? Math.random;
  }

  get state(): ConnectionState {
    return this.phase;
  }

  /**
   * Attach to the agent.
   *
   * Idempotent, and that is what the call site relies on: opening the chat window calls this whether
   * or not it was already open, and rebuilding a live connection would drop frames for nothing.
   */
  connect(): void {
    if (!this.stopped && this.socket !== null) return;
    this.teardown();
    this.stopped = false;
    this.attempt = 0;
    this.open("connecting");
  }

  /** Stop, and stay stopped. What closing the chat window and leaving the page both do. */
  disconnect(): void {
    this.stopped = true;
    this.teardown();
    this.setState("closed");
  }

  dispose(): void {
    this.stopped = true;
    this.teardown();
    this.phase = "idle";
  }

  /**
   * Put one frame on the wire, reporting whether it got there.
   *
   * A frame sent while `awaiting_ready` is fine: it waits in the server's receive buffer and is read
   * the moment the connection's receiver starts, which is immediately after `ready` goes out.
   */
  send(frame: InboundFrame): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      // A socket that died between the readyState check and here reports itself through `onclose`;
      // there is nothing to add to that.
      return false;
    }
  }

  /** Say something. The text is the whole of it: a message carries no selection of records beside
   * the words, because nothing in the window produces one and the agent reads the mentions
   * written into the text itself. */
  sendUserMessage(text: string): boolean {
    return this.send({ type: "user_message", text });
  }

  /** Ask the agent to answer with another model. Nothing comes back on success — the agent re-emits
   * `ready` to every window, which is the authority for what this one draws. */
  setModel(model: string): boolean {
    return this.send({ type: "set_model", model });
  }

  /**
   * Ask the agent to work the next turn at another effort level.
   *
   * The same silence on success as `setModel`, for the same reason, and the argument is an
   * `EffortLevel` rather than a `string` because by this line the value has already been narrowed:
   * a `<select>` hands back a `string` however narrow its options were, and `isEffortLevel` in the
   * composer is where that becomes one of the five. A signature that took a bare string here would
   * make the wire the place the DOM's word was taken on trust.
   */
  setEffort(effort: EffortLevel): boolean {
    return this.send({ type: "set_effort", effort });
  }

  /**
   * Ask the agent to start or stop delegating to subagents.
   *
   * The same silence on success as the two above, for the same reason: the `ready` the agent
   * broadcasts is what every window draws from. The argument needs no narrowing — a toggle produces
   * a boolean and there is nothing else it could produce — but the frame is the one on this socket
   * that ends the agent's session when it is honoured, so a window that sent it speculatively would
   * be spending somebody's conversation state on a guess.
   */
  setSubagents(enabled: boolean): boolean {
    return this.send({ type: "set_subagents", enabled });
  }

  /** Stop the model at its next step. A measurement already running has no cancellation point and
   * finishes. */
  interrupt(): boolean {
    return this.send({ type: "interrupt" });
  }

  // -- connecting ---------------------------------------------------------------------------------

  private open(phase: "connecting" | "reconnecting"): void {
    this.setState(phase);
    const socket = this.createSocket(this.urlFor());
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.setState("awaiting_ready");
      this.armKeepalive();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.bumpSilence();
      this.receive(event.data);
    };
    // The close CODE is deliberately not read. Nothing the server can send here is final — see the
    // header — so branching on it would only be a way to get one of them wrong.
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.handleClose();
    };
    socket.onerror = () => {
      // A close always follows, and the close is where this client acts.
    };
  }

  private receive(data: unknown): void {
    const frame = parseFrame(data);
    // A malformed frame is the server's bug to fix. Taking the window down over one would lose a
    // conversation to a stray byte.
    if (frame === null) return;
    if (frame.type === "ready") {
      this.attempt = 0;
      this.setState("ready");
    }
    this.handlers.onFrame(frame);
  }

  // -- keepalive ----------------------------------------------------------------------------------

  private armKeepalive(): void {
    this.clearKeepalive();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), PING_INTERVAL_MS);
    this.bumpSilence();
  }

  /**
   * Restart the silence clock. Any frame counts, not just a pong: a turn streaming prose is the
   * loudest possible evidence that the socket is alive.
   */
  private bumpSilence(): void {
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      // Nothing has arrived in 45 s, not even an answer to a ping sent 15 s ago. The socket is gone
      // whatever its readyState claims, so it is torn down and rebuilt rather than waited on.
      this.teardown();
      this.lost();
    }, SILENCE_LIMIT_MS);
  }

  private clearKeepalive(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    this.pingTimer = null;
    this.silenceTimer = null;
  }

  // -- closing and reconnecting -------------------------------------------------------------------

  private handleClose(): void {
    this.clearKeepalive();
    if (this.stopped) {
      this.setState("closed");
      return;
    }
    this.lost();
  }

  private lost(): void {
    if (this.stopped) return;
    this.setState("reconnecting");
    this.handlers.onLost();
    this.scheduleReconnect();
  }

  private backoffDelay(): number {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const jitter = 1 + (this.random() * 2 - 1) * BACKOFF_JITTER;
    return Math.max(0, Math.round(base * jitter));
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = this.backoffDelay();
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.open("reconnecting");
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private teardown(): void {
    const socket = this.socket;
    this.socket = null;
    this.clearKeepalive();
    this.clearReconnect();
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // Closing a socket that is already gone is not a failure worth reporting.
    }
  }

  private setState(phase: ConnectionState): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.handlers.onState(phase);
  }
}
