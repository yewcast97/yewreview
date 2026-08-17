/**
 * YewReview's tools, served to opencode over MCP.
 *
 * The Claude path hands its tools to the SDK as an in-process MCP server; opencode reaches its
 * tools over HTTP. Same definitions (`src/tools/`), same `announcing()` wrapper, same
 * `strictSchema()` validation — a different envelope, which is the whole of what this file is.
 *
 * **The handlers run HERE, in the privileged server process, not in the child.** That is the
 * property that matters: a tool call arrives over loopback, is validated, and executes against the
 * real database with the real run log, so the generation gate and the provenance rules are the
 * server's exactly as they are on the Claude path. The child holds no database handle and is denied
 * read access to `db/` by the sandbox; what it has is the ability to ask.
 *
 * **It is a small, deliberate slice of MCP.** Three methods — `initialize`, `tools/list`,
 * `tools/call` — plus the notification the handshake ends with. Everything else is answered as
 * "method not found", which is what the protocol says to do and is more honest than a partial
 * implementation of a capability we do not offer. There are no resources, no prompts, no sampling
 * and no subscriptions here, and none of them would mean anything to this tool surface.
 *
 * Auth is the same per-boot secret the child was started with: the endpoint is on the same loopback
 * server the window uses, and a bearer nobody else was told is what keeps it the child's door
 * rather than the machine's.
 */

import { z } from "zod";

import { SERVER_NAME, type ToolResult } from "../protocol/types.ts";
import type { AnyToolDefinition } from "../tools/def.ts";
import { invoke, strictSchema } from "../tools/def.ts";

/** The URL the rendered config points opencode at. */
export const MCP_PATH = "/mcp";

const PROTOCOL_VERSION = "2025-06-18";

type Request = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

export type McpBridge = {
  /** Whether this request is the bridge's. */
  matches(url: URL): boolean;
  handle(request: globalThis.Request): Promise<Response>;
};

/**
 * The bridge over one set of tool definitions.
 *
 * `defs` is read through a function rather than captured, because the harness builds its tools once
 * and the server is constructed around it: a captured array would freeze whatever existed at the
 * moment the router was assembled.
 */
export function createMcpBridge(
  defs: () => readonly AnyToolDefinition[],
  secret: () => string | null,
): McpBridge {
  return {
    matches: (url) => url.pathname === MCP_PATH,

    async handle(request: globalThis.Request): Promise<Response> {
      const expected = secret();
      if (expected === null) {
        // No child has been started, so nothing legitimate is asking. Answering anything here would
        // be answering something that came from somewhere else on the machine.
        return new Response("not found", { status: 404 });
      }
      if (request.headers.get("authorization") !== `Bearer ${expected}`) {
        return new Response("unauthorized", { status: 401 });
      }
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return rpcError(null, -32700, "the request body is not JSON");
      }
      // A batch is a list, and a single call is not. Both are answered in kind so a client that
      // batches its handshake is not left waiting for a reply shaped like something it did not send.
      if (Array.isArray(body)) {
        const answers = (await Promise.all(body.map((one) => answer(one as Request, defs())))).
          filter((one): one is object => one !== null);
        return json(answers);
      }
      const one = await answer(body as Request, defs());
      // A notification gets no body — `notifications/initialized` is the client saying it is ready
      // and expecting nothing back.
      return one === null ? new Response(null, { status: 202 }) : json(one);
    },
  };
}

async function answer(request: Request, defs: readonly AnyToolDefinition[]): Promise<object | null> {
  const id = request.id;
  const method = request.method;
  if (typeof method !== "string") return rpcBody(id ?? null, undefined, [-32600, "no method"]);
  if (method.startsWith("notifications/")) return null;

  if (method === "initialize") {
    return rpcBody(id ?? null, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: "1.0.0" },
    });
  }

  if (method === "tools/list") {
    return rpcBody(id ?? null, {
      tools: defs.map((definition) => ({
        name: definition.name,
        description: definition.description,
        // `additionalProperties: false` rides along from `strictSchema`, so the model is shown the
        // same refusal surface the validator enforces: a misspelled key is a schema error rather
        // than a silently dropped argument.
        inputSchema: z.toJSONSchema(strictSchema(definition), { io: "input" }),
        ...(definition.readOnly ? { annotations: { readOnlyHint: true } } : {}),
      })),
    });
  }

  if (method === "tools/call") {
    const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
    const definition = defs.find((candidate) => candidate.name === params.name);
    if (definition === undefined) {
      return rpcBody(id ?? null, undefined, [-32602, `no tool named ${String(params.name)}`]);
    }
    // Validated with the SAME strict schema the Claude surface uses. This is the enforcement point
    // rather than a courtesy: `invoke` casts, on the promise that its caller parsed first.
    const parsed = strictSchema(definition).safeParse(params.arguments ?? {});
    if (!parsed.success) {
      return rpcBody(id ?? null, {
        content: [
          {
            type: "text",
            text:
              `${definition.name} was called with arguments it does not accept: ` +
              parsed.error.issues
                .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
                .join("; "),
          },
        ],
        isError: true,
      });
    }
    // A `Refused` never reaches here — `attempt()` inside every handler turns one into a result —
    // so a throw is a defect, and it is reported as a tool error rather than a transport failure so
    // the model sees something it can act on and the crash is still filed by `announcing`.
    let result: ToolResult;
    try {
      result = await invoke(definition, parsed.data);
    } catch (err) {
      return rpcBody(id ?? null, {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      });
    }
    return rpcBody(id ?? null, result);
  }

  return rpcBody(id ?? null, undefined, [-32601, `unsupported method ${method}`]);
}

function rpcBody(
  id: unknown,
  result?: unknown,
  error?: [number, string],
): object {
  if (error !== undefined) {
    return { jsonrpc: "2.0", id, error: { code: error[0], message: error[1] } };
  }
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
