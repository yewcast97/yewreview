/**
 * The events socket: one connection per window, carrying what happened anywhere in the database.
 *
 * The chat socket answers "what is happening in the conversation", and that would be the whole story
 * only if everything that changed the database changed it during a turn somebody was watching. It is
 * not true, in several ways at once. The HTTP surface writes rows itself, with no turn involved. A
 * second window writes rows this one is drawing. Something goes wrong or something is deleted, and
 * the two logs move without a word being said about it. And the list of
 * conversations changes on disk, in a store this process does not own, whenever a turn ends. A
 * window that only listened to its own chat would draw an installation that had moved on without it
 * — and, worse, would draw it confidently.
 *
 * So this socket carries the fact that something moved, and nothing about what. Every frame is a
 * POKE: `records_changed` has no table list, `error_logged` and `deletion_logged` carry no row, and
 * `sessions_changed` carries not even a time. That is deliberate in each case for the same reason —
 * the window re-reads exactly what it has open, so a payload would be a second description of the
 * same event that could disagree with the first, and keeping one accurate would mean every write
 * site knowing what a watcher happened to be drawing. "It moved, look again" is the whole of what a
 * watcher needs and all this can honestly promise.
 *
 * There is no inbound traffic but `ping`. Nothing is done TO this socket; it is a subscription, and
 * a client that wants to change something has an endpoint or a conversation for that.
 */

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";

import type { EventsFrame } from "../protocol/types.ts";

/** The URL an events socket connects to. No id: there is exactly one of these per window. */
const EVENTS_PATH = "/ws/events";

/**
 * How many frames may queue for one slow socket.
 *
 * Far smaller than the chat socket's, and it can be: every frame here is a poke, so a backlog of
 * sixty-four of them is one fact repeated a few times over. When the queue fills, the OLDEST are
 * dropped rather than the newest — the newest is the one that is still true.
 */
const OUTBOUND_MAX = 64;

export type EventsSocketData = { kind: "events" };

export type EventsHub = {
  isEventsPath(pathname: string): boolean;
  upgrade(server: Server<EventsSocketData>, req: Request, pathname: string): Response | undefined;
  handlers: WebSocketHandler<EventsSocketData>;
  /** Tell every attached window that something moved. */
  broadcast(frame: EventsFrame): void;
};

export function createEventsHub(): EventsHub {
  const sockets = new Set<ServerWebSocket<EventsSocketData>>();
  const backlog = new Map<ServerWebSocket<EventsSocketData>, string[]>();

  function flush(ws: ServerWebSocket<EventsSocketData>): void {
    const queue = backlog.get(ws);
    if (!queue) return;
    while (queue.length > 0) {
      // `send` returns a negative number when the socket is backpressured; the frame stays at the
      // head of the queue and `drain` comes back for it.
      if (ws.send(queue[0]!) < 0) return;
      queue.shift();
    }
    backlog.delete(ws);
  }

  function push(ws: ServerWebSocket<EventsSocketData>, text: string): void {
    const queue = backlog.get(ws) ?? [];
    queue.push(text);
    while (queue.length > OUTBOUND_MAX) queue.shift();
    backlog.set(ws, queue);
    flush(ws);
  }

  return {
    isEventsPath(pathname: string): boolean {
      return pathname === EVENTS_PATH;
    },

    upgrade(server, req, pathname): Response | undefined {
      if (pathname !== EVENTS_PATH) return new Response("not found", { status: 404 });
      if (server.upgrade(req, { data: { kind: "events" } })) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    },

    handlers: {
      open(ws) {
        sockets.add(ws);
      },
      message(ws, raw) {
        // The one thing a client may say. Anything else is ignored rather than refused: this socket
        // has no command surface to protect, and closing a window's only sync channel over a stray
        // frame would cost it every later event.
        if (typeof raw === "string" && raw.includes('"ping"')) {
          push(ws, JSON.stringify({ type: "pong" } satisfies EventsFrame));
        }
      },
      drain(ws) {
        flush(ws);
      },
      close(ws) {
        sockets.delete(ws);
        backlog.delete(ws);
      },
    },

    broadcast(frame: EventsFrame): void {
      const text = JSON.stringify(frame);
      for (const ws of sockets) push(ws, text);
    },
  };
}
