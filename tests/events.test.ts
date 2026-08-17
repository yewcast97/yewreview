/**
 * The events socket's backpressure, which is the part of it that cannot be seen from outside.
 *
 * `tests/server.test.ts` already drives this hub over a real socket and asserts that a window is
 * told when the database moves. What it cannot stage is a SLOW window: a browser whose send buffer
 * is full, so that `ws.send` refuses the frame and the hub has to hold it, keep holding the ones
 * behind it, and hand them over in order when `drain` arrives. That path is three lines of a closure
 * and every one of them fails silently — a lost frame is a window that quietly stops redrawing, and
 * a frame delivered out of order is one that redraws the wrong thing.
 *
 * The socket is a stand-in with a `send` this file controls, which is the only way to say "refuse
 * this one" on purpose. Everything else — the hub, the queue, the ordering — is the real thing.
 */

import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

import type { EventsFrame } from "../src/protocol/types.ts";
import type { EventsSocketData } from "../src/server/events.ts";
import { createEventsHub } from "../src/server/events.ts";

/** How many frames the hub holds for one slow socket before it starts dropping. Mirrored from
 * `events.ts`, on purpose: a test that imported the constant would agree with the module by
 * construction and would not notice it changing. */
const OUTBOUND_MAX = 64;

/**
 * A socket that records what it was handed and can be told to stop accepting.
 *
 * `send` answers a negative number while `stalled`, which is what Bun does for a backpressured
 * socket and what the hub reads as "hold everything from here".
 */
function fakeSocket(): ServerWebSocket<EventsSocketData> & { sent: string[]; stalled: boolean } {
  const socket = {
    sent: [] as string[],
    stalled: false,
    send(text: string): number {
      if (socket.stalled) return -1;
      socket.sent.push(text);
      return text.length;
    },
  };
  return socket as unknown as ServerWebSocket<EventsSocketData> & {
    sent: string[];
    stalled: boolean;
  };
}

const MOVED: EventsFrame = { type: "records_changed", at: 1 };

describe("who hears a broadcast", () => {
  test("every attached window, and nobody who has closed", () => {
    const hub = createEventsHub();
    const first = fakeSocket();
    const second = fakeSocket();
    hub.handlers.open?.(first);
    hub.handlers.open?.(second);

    hub.broadcast(MOVED);
    expect(first.sent).toEqual([JSON.stringify(MOVED)]);
    expect(second.sent).toEqual([JSON.stringify(MOVED)]);

    hub.handlers.close?.(second, 1000, "");
    hub.broadcast({ type: "sessions_changed" });
    expect(first.sent).toHaveLength(2);
    expect(second.sent).toHaveLength(1);
  });

  test("a window that has said nothing at all still hears everything", () => {
    // It is a subscription. Nothing is done TO this socket, so there is no handshake a client could
    // forget and no state a broadcast has to wait for.
    const hub = createEventsHub();
    const ws = fakeSocket();
    hub.handlers.open?.(ws);
    hub.broadcast(MOVED);
    expect(ws.sent).toEqual([JSON.stringify(MOVED)]);
  });

  test("a ping is answered with a pong and nothing else is", () => {
    const hub = createEventsHub();
    const ws = fakeSocket();
    hub.handlers.open?.(ws);

    hub.handlers.message?.(ws, JSON.stringify({ type: "ping" }));
    expect(ws.sent).toEqual([JSON.stringify({ type: "pong" })]);

    // Anything else is IGNORED rather than refused: closing a window's only sync channel over a
    // stray frame would cost it every later event, and this socket has no command surface to guard.
    hub.handlers.message?.(ws, JSON.stringify({ type: "user_message", text: "hello" }));
    hub.handlers.message?.(ws, "not json at all");
    expect(ws.sent).toHaveLength(1);
  });
});

describe("a window that cannot keep up", () => {
  test("frames refused by the socket are held, and drain hands them over in order", () => {
    const hub = createEventsHub();
    const ws = fakeSocket();
    hub.handlers.open?.(ws);

    ws.stalled = true;
    hub.broadcast({ type: "records_changed", at: 1 });
    hub.broadcast({ type: "error_logged", at: 2 });
    hub.broadcast({ type: "deletion_logged", at: 3 });
    expect(ws.sent).toEqual([]);

    ws.stalled = false;
    hub.handlers.drain?.(ws);
    expect(ws.sent).toEqual([
      JSON.stringify({ type: "records_changed", at: 1 }),
      JSON.stringify({ type: "error_logged", at: 2 }),
      JSON.stringify({ type: "deletion_logged", at: 3 }),
    ]);
  });

  test("a drain that only gets partway through leaves the rest queued", () => {
    // The socket accepts one frame and backs up again, which is the ordinary shape of a drain on a
    // real connection. The frame at the head must not be dropped for having been offered once.
    const hub = createEventsHub();
    const ws = fakeSocket();
    hub.handlers.open?.(ws);

    ws.stalled = true;
    hub.broadcast({ type: "records_changed", at: 1 });
    hub.broadcast({ type: "error_logged", at: 2 });

    let allowed = 1;
    const send = (text: string): number => {
      if (allowed <= 0) return -1;
      allowed -= 1;
      ws.sent.push(text);
      return text.length;
    };
    (ws as unknown as { send: (t: string) => number }).send = send;
    hub.handlers.drain?.(ws);
    expect(ws.sent).toEqual([JSON.stringify({ type: "records_changed", at: 1 })]);

    allowed = 5;
    hub.handlers.drain?.(ws);
    expect(ws.sent).toEqual([
      JSON.stringify({ type: "records_changed", at: 1 }),
      JSON.stringify({ type: "error_logged", at: 2 }),
    ]);
  });

  test("past the cap the OLDEST are dropped, because the newest is the one still true", () => {
    // Every frame here is a poke with no payload, so a backlog is one fact repeated. If any of them
    // has to go it must be the stale end: a window that receives the last poke re-reads and is
    // correct, and one that receives only the first is confidently out of date.
    const hub = createEventsHub();
    const ws = fakeSocket();
    hub.handlers.open?.(ws);

    ws.stalled = true;
    for (let at = 1; at <= OUTBOUND_MAX + 10; at++) hub.broadcast({ type: "records_changed", at });

    ws.stalled = false;
    hub.handlers.drain?.(ws);
    expect(ws.sent).toHaveLength(OUTBOUND_MAX);
    expect(ws.sent[0]).toBe(JSON.stringify({ type: "records_changed", at: 11 }));
    expect(ws.sent.at(-1)).toBe(
      JSON.stringify({ type: "records_changed", at: OUTBOUND_MAX + 10 }),
    );
  });

  test("closing a stalled window throws its backlog away", () => {
    // Nothing is owed to a socket that is gone, and a queue kept against one is a leak that grows
    // for as long as the process runs.
    const hub = createEventsHub();
    const ws = fakeSocket();
    hub.handlers.open?.(ws);
    ws.stalled = true;
    hub.broadcast(MOVED);

    hub.handlers.close?.(ws, 1000, "");
    ws.stalled = false;
    hub.handlers.drain?.(ws);
    expect(ws.sent).toEqual([]);
  });

  test("one slow window does not hold up a fast one", () => {
    const hub = createEventsHub();
    const slow = fakeSocket();
    const fast = fakeSocket();
    hub.handlers.open?.(slow);
    hub.handlers.open?.(fast);

    slow.stalled = true;
    hub.broadcast(MOVED);
    expect(slow.sent).toEqual([]);
    expect(fast.sent).toEqual([JSON.stringify(MOVED)]);
  });
});

describe("the path this hub answers", () => {
  test("it is the events path and nothing else", () => {
    const hub = createEventsHub();
    expect(hub.isEventsPath("/ws/events")).toBe(true);
    expect(hub.isEventsPath("/ws/chat")).toBe(false);
    expect(hub.isEventsPath("/api/events")).toBe(false);
    expect(hub.isEventsPath("/ws/events/")).toBe(false);
  });
});
