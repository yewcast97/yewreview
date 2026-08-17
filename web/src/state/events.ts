/**
 * The events socket: one connection per window, carrying the fact that the database moved.
 *
 * Much simpler than the chat socket, and simpler in a way worth naming rather than just noticing.
 * There is no id to connect under, so no `ready` to wait for and no terminal close code — a failed
 * connection is always worth retrying, because the thing on the other end is the installation
 * rather than one conversation in it. There is no `onLost` either: the frames say nothing this
 * client would have to catch up on. Missing one costs a refresh that the next one asks for anyway.
 *
 * What it does share is the reconnect discipline, because the reason is the same: a laptop that
 * slept for an hour comes back to a socket the server hung up on, and a window that silently stops
 * refreshing is a window drawing a database that has moved on without it — confidently, which is
 * the part that matters.
 *
 * Everything from the outside — the socket constructor, the clock, the jitter — is injectable, so
 * the machine can be driven deterministically with no DOM at all.
 */

import type { EventsFrame } from "../lib/protocol.ts";
import { parseEventsFrame } from "../lib/protocol.ts";
import type { SocketFactory, SocketLike } from "./ws.ts";

/** The same backoff shape the chat socket uses, and for the same reason: two tabs must not retry
 * in lockstep. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const BACKOFF_JITTER = 0.25;

const PING_INTERVAL_MS = 30_000;
const SILENCE_LIMIT_MS = 45_000;

const OPEN = 1;

export type EventsClientOptions = {
  /** Where the frames go. Called once per frame, in arrival order. */
  onFrame: (frame: EventsFrame) => void;
  /**
   * The socket is open and listening again.
   *
   * Raised on EVERY open, the first one included, so a caller has one path rather than two. This is
   * the `onLost` the header below says this client does not need — and the header was right when it
   * was written: the frames said nothing a window had to catch up on, because everything they
   * announced could be re-derived by asking again on the next one. The draft LOCKS broke that. A
   * lock is drawn rather than acted on, and its release is the one announcement here that is
   * genuinely allowed never to arrive, so a window that slept through one comes back drawing a film
   * over an editor nobody is holding — and nothing later will contradict it.
   */
  onConnect?: (() => void) | undefined;
  socketFactory?: SocketFactory;
  now?: () => number;
  random?: () => number;
};

export type EventsClient = {
  connect(): void;
  disconnect(): void;
};

export function createEventsClient(options: EventsClientOptions): EventsClient {
  const factory = options.socketFactory ?? browserSocket;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => Math.random());

  let socket: SocketLike | null = null;
  let attempt = 0;
  let lastHeard = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let wanted = false;

  function clearTimers(): void {
    if (retry !== null) clearTimeout(retry);
    if (heartbeat !== null) clearInterval(heartbeat);
    retry = null;
    heartbeat = null;
  }

  function scheduleRetry(): void {
    if (!wanted || retry !== null) return;
    const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
    const jitter = 1 + (random() * 2 - 1) * BACKOFF_JITTER;
    attempt += 1;
    retry = setTimeout(() => {
      retry = null;
      open();
    }, base * jitter);
  }

  function open(): void {
    if (!wanted || socket !== null) return;
    const ws = factory(url());
    socket = ws;
    lastHeard = now();

    ws.onopen = () => {
      attempt = 0;
      lastHeard = now();
      // After the bookkeeping, before the heartbeat: whatever this does is a read, and a read that
      // throws must not take the connection down with it.
      options.onConnect?.();
      // The heartbeat starts with the connection rather than with the client: a socket that never
      // opened has no silence to measure, and a timer running against a null socket is a timer
      // that eventually decides a connection nobody made has gone quiet.
      heartbeat = setInterval(() => {
        if (socket === null) return;
        if (now() - lastHeard > SILENCE_LIMIT_MS) {
          // Nothing has arrived, not even a pong, so whatever is on the other end is not there any
          // more. Closing is what starts the reconnect; waiting would leave a socket that is open
          // as far as the browser knows and dead as far as anything else is.
          socket.close();
          return;
        }
        if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: "ping" }));
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      lastHeard = now();
      const frame = parseEventsFrame(event.data);
      // A frame this build does not know is ignored rather than reported. This channel is a hint to
      // look again; a newer server saying something in a shape we cannot read costs nothing, and
      // erroring on it would turn a compatible addition into a broken window.
      if (frame !== null && frame.type !== "pong") options.onFrame(frame);
    };

    ws.onclose = () => {
      socket = null;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      scheduleRetry();
    };

    ws.onerror = () => {
      // `onclose` always follows, and it is the one that schedules. Closing here as well would
      // double-schedule the retry.
    };
  }

  return {
    connect(): void {
      wanted = true;
      open();
    },
    disconnect(): void {
      wanted = false;
      clearTimers();
      attempt = 0;
      const open = socket;
      socket = null;
      open?.close();
    },
  };
}

function url(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws/events`;
}

function browserSocket(target: string): SocketLike {
  return new WebSocket(target) as unknown as SocketLike;
}
