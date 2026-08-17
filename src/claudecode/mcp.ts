/**
 * YewReview's tools, as the Claude Agent SDK wants them.
 *
 * The whole SDK-shaped part of the tool layer, and the only place in the repository that still calls
 * `tool()` or `createSdkMcpServer()`. Everything underneath — `src/tools/` — is a plain array of
 * definitions that the opencode harness serves through a bridge of its own, so what this file adapts
 * is a vocabulary, not a capability.
 *
 * Two SDK facts are handled here and nowhere else.
 *
 * **The strict schema has to be swapped in after the fact.** `tool()`'s TYPE insists on a raw Zod
 * shape, while its runtime is perfectly happy with a built `ZodObject` and passes one through
 * untouched — to the validator, and into the JSON Schema the model is shown, where it becomes
 * `additionalProperties: false`. So the definition is built from the shape, keeping the handler's
 * arguments inferred, and `strictSchema` is put in its place immediately afterwards. That is the one
 * cast, and `tests/tools.test.ts` asserts an undeclared key is genuinely rejected so an SDK upgrade
 * cannot quietly undo it.
 *
 * **A tool's address is the SDK's idea, not ours.** `mcp__yewreview__<name>` is how a tool is named
 * in `allowedTools`, and the qualification lives here rather than in `src/tools/` because opencode
 * addresses the very same tool by its bare name.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";

import { SERVER_NAME, type ToolResult } from "../protocol/types.ts";
import type { AnyToolDefinition } from "../tools/def.ts";
import { invoke, strictSchema } from "../tools/def.ts";

const SERVER_VERSION = "1.0.0";

/**
 * One in-process MCP server carrying every tool it is handed.
 *
 * The cast on `tools` is the price of a heterogeneous array meeting a generic parameter: the SDK's
 * definition type is written per-tool, and a list of tools with different argument shapes has no
 * common instantiation of it that the compiler will accept in both directions. The runtime is
 * entirely happy — a server iterates its tools and hands each one its own validated arguments — and
 * the argument types were checked where each tool was defined.
 */
export function toSdkServer(defs: readonly AnyToolDefinition[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: defs.map(asSdkTool) as unknown as SdkMcpToolDefinition<z.ZodRawShape>[],
  });
}

function asSdkTool(definition: AnyToolDefinition) {
  const built = tool(
    definition.name,
    definition.description,
    definition.schema,
    async (args): Promise<ToolResult> => invoke(definition, args),
    definition.readOnly ? { annotations: { readOnlyHint: true } } : {},
  );
  return { ...built, inputSchema: strictSchema(definition) as unknown as z.ZodRawShape };
}

/**
 * The fully-qualified names of every tool the session exposes, for `allowedTools`.
 *
 * Derived from the same definitions the server is built from rather than kept as a second hand-
 * written list. A list that can drift from the tools is a list that eventually leaves one of them
 * out — and a tool missing from `allowedTools` fails at the moment the model reaches for it, which
 * is the worst time to find out.
 */
export function sdkToolNames(defs: readonly AnyToolDefinition[]): string[] {
  return defs.map((definition) => `mcp__${SERVER_NAME}__${definition.name}`);
}
