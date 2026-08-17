/**
 * The local server: one `Bun.serve`, one router, and two kinds of socket.
 *
 * Everything interesting is one layer down — this module's whole job is to decide, for each
 * request, whether it is a WebSocket upgrade or a request with an answer, and to hand the two
 * halves the same `deps`. That is why it takes `deps` rather than reading settings or opening a
 * database: the tests start a real server on port 0 with a fake agent, and a boot that reached for
 * its own dependencies would make that impossible.
 *
 * There is NO CORS header here, and that is a decision rather than an omission. Allowing every
 * origin would let a Vite dev server on another port talk to it — but this process binds a loopback
 * address and holds one person's research, and `Allow-Origin: *` means any page they happen to have
 * open can read all of it. When the window needs a dev-server origin, it gets that one origin by
 * name.
 */

import type { Server, ServerWebSocket } from "bun";

import indexHtml from "../../web/index.html";
import type { ChatSocketData, ServerDeps } from "./chat.ts";
import { createChatHub } from "./chat.ts";
import type { EventsSocketData } from "./events.ts";
import { createEventsHub } from "./events.ts";
import { createMcpBridge } from "../opencode/mcp.ts";
import { logError } from "../repo/logs.ts";
import { createRouter } from "./routes.ts";

/**
 * Both socket kinds, under one `Bun.serve`.
 *
 * Bun takes ONE websocket handler set for the whole server, so the two hubs are dispatched on the
 * discriminant their upgrade attached. Neither carries anything else — a chat socket holds the
 * connection built for it and an events socket holds nothing but the fact of being one — which is
 * what makes the tag rather than the shape the thing to branch on.
 */
type SocketData = ChatSocketData | EventsSocketData;

/**
 * Hand one socket to whichever hub owns it.
 *
 * THE TWO CASTS HERE ARE THE ONLY ONES, and they sit against the discriminant that justifies them.
 * `ServerWebSocket<A | B>` is not a union of `ServerWebSocket<A>` and `ServerWebSocket<B>`, so
 * testing `ws.data.kind` narrows the DATA and leaves the socket as wide as it was — which is why
 * dispatching inline needed a cast per handler per hub, and why those casts were `as never`, a
 * spelling that also silences whatever else might be wrong about the argument. Routing every
 * handler through here means the tag is read once, the cast is made once beside it, and a mistake
 * in any handler below is a type error again.
 */
function dispatch<R>(
  ws: ServerWebSocket<SocketData>,
  onEvents: (socket: ServerWebSocket<EventsSocketData>) => R,
  onChat: (socket: ServerWebSocket<ChatSocketData>) => R,
): R {
  return "kind" in ws.data && ws.data.kind === "events"
    ? onEvents(ws as ServerWebSocket<EventsSocketData>)
    : onChat(ws as ServerWebSocket<ChatSocketData>);
}

export type { Agent, ServerDeps } from "./chat.ts";

/**
 * How long a chat socket may go silent before Bun hangs up, in seconds.
 *
 * Generous because the silence is expected: an agent researching a filing can be minutes between
 * frames, and a browser that has said nothing is not a browser that has gone away. Bun's automatic
 * pings are what actually notice a dead peer.
 */
const WS_IDLE_TIMEOUT_S = 240;

/**
 * Whether this process is the compiled binary rather than a checkout.
 *
 * Bun mounts an executable's embedded files under `/$bunfs`, so `Bun.main` answers this without a
 * build-time flag to keep in step. What hangs on it is hot reloading: a binary has no source tree to
 * watch, and asking for one would inject a dev-server client script into the shipped page.
 */
const compiled = Bun.main.startsWith("/$bunfs");

export function startServer(deps: ServerDeps): Server<SocketData> {
  const hub = createChatHub(deps);
  const events = createEventsHub();
  deps.attachEvents?.(events.broadcast);
  const route = createRouter(deps, {
    announce: () => events.broadcast({ type: "records_changed", at: Date.now() }),
    sessionsChanged: () => events.broadcast({ type: "sessions_changed" }),
  });

  const chat = hub.handlers;
  const feed = events.handlers;

  // Mounted only on the opencode path. On the Claude path `/mcp` is a plain 404, because the tools
  // reach that session in-process and there is nothing for an HTTP endpoint to serve.
  const mcp =
    deps.opencode === undefined
      ? null
      : createMcpBridge(deps.opencode.tools, deps.opencode.mcpSecret);

  return Bun.serve({
    hostname: deps.settings.host,
    port: deps.settings.port,

    /**
     * The window itself, bundled from `web/index.html` by Bun's own bundler.
     *
     * An HTML import rather than a separate build step and a static-file route: the import graph
     * carries the whole frontend — the entry script, React, every stylesheet — into the compiled
     * binary with no second toolchain to keep in step, which is exactly what a local-first product
     * that ships as one file needs. `routes` matches `/` EXACTLY and claims nothing else, so
     * `/api/**`, `/reports/**` and the chat sockets are still the `fetch` handler's below.
     */
    routes: { "/": indexHtml },
    development: compiled ? false : { hmr: true, console: true },

    fetch(req, server): Response | Promise<Response> | undefined {
      const url = new URL(req.url);
      // Checked first, and by prefix: an upgrade request carries headers rather than a method the
      // router could dispatch on, and answering it with JSON would leave the browser waiting for a
      // socket it never gets.
      if (hub.isChatPath(url.pathname)) {
        return hub.upgrade(server as Server<ChatSocketData>, req, url.pathname);
      }
      if (events.isEventsPath(url.pathname)) {
        return events.upgrade(server as Server<EventsSocketData>, req, url.pathname);
      }
      // The tool surface the opencode child calls back into, when that is the harness running.
      // Checked here rather than in the router because it speaks JSON-RPC rather than this
      // server's `{error, message}` vocabulary, and because it is the one route whose caller is
      // another process rather than a browser.
      if (mcp !== null && mcp.matches(url)) return mcp.handle(req);
      return route(req, url);
    },

    websocket: {
      idleTimeout: WS_IDLE_TIMEOUT_S,
      open(ws) {
        dispatch(
          ws,
          (socket) => feed.open?.(socket),
          (socket) => chat.open?.(socket),
        );
      },
      message(ws, message) {
        dispatch(
          ws,
          (socket) => feed.message(socket, message),
          (socket) => chat.message(socket, message),
        );
      },
      drain(ws) {
        dispatch(
          ws,
          (socket) => feed.drain?.(socket),
          (socket) => chat.drain?.(socket),
        );
      },
      close(ws, code, reason) {
        dispatch(
          ws,
          (socket) => feed.close?.(socket, code, reason),
          (socket) => chat.close?.(socket, code, reason),
        );
      },
    },

    error(err): Response {
      // Reached only when the fetch handler itself throws, which the router already catches. So
      // this is the genuinely unexpected case, and it says so rather than guessing — and files it,
      // because a failure this far out is one nobody is watching a console for.
      console.error("the server failed to handle a request", err);
      logError(
        deps.db,
        "http",
        `the server failed to handle a request: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
      return new Response(
        JSON.stringify({ error: "internal", message: err instanceof Error ? err.message : String(err) }),
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    },
  });
}
