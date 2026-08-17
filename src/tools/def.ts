/**
 * What a tool IS here, said without reference to the thing that will serve it.
 *
 * A tool used to be an SDK object: `tool()` from the agent SDK, wrapped by a `strict()` that swapped
 * its schema. That was fine while one harness existed, and wrong the moment a second one did — the
 * handlers underneath never touched the SDK for anything, they take `ToolDeps` and return a
 * `ToolResult`, and the only SDK-shaped thing about them was the envelope they were declared in.
 *
 * So a definition is now four fields and a plain Zod shape, and the two surfaces that serve them —
 * `src/claudecode/mcp.ts` for the Claude session's in-process MCP server, `src/opencode/` for the
 * host-tool bridge — each adapt the SAME array. Neither owns it. A tool added to this directory
 * appears on both harnesses without either being edited, which is the property worth having: the
 * alternative is a tool that exists on one path and silently does not on the other, and the archive
 * would then depend on which harness wrote it.
 *
 * `strictSchema` is the guarantee that survived the move, and it must survive every future one. Zod
 * 4's plain `z.object()` STRIPS unknown keys silently, so a `publish_report` handed a misspelled
 * `applied_theses` would publish a report with the declaration quietly missing and nothing anywhere
 * saying so. Every surface wraps the raw shape with this before it validates or before it advertises
 * a JSON Schema, where it becomes `additionalProperties: false`. It is written once, here, so the two
 * surfaces cannot disagree about it.
 */

import { z } from "zod";

import type { ToolResult } from "../protocol/types.ts";

/**
 * One tool: what it is called, what it is for, what it takes, and what it does.
 *
 * The shape is the RAW Zod shape rather than a built object, for the reason `tool()` wanted one too:
 * it is what keeps a handler's `args` inferred field by field, so a typo in a handler body is a
 * compile error rather than an `undefined` on its way into a query.
 */
export type ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> = {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  readonly handler: (args: z.output<z.ZodObject<S>>) => Promise<ToolResult>;
  /** Advertised to the model as a promise that calling this changes nothing. */
  readonly readOnly: boolean;
  /**
   * Answerable while a generation procedure is recording.
   *
   * DEFAULT FALSE, AND THE DEFAULT IS THE POINT. The freeze in `tools/index.ts` refuses every
   * writing tool for the length of a procedure, so a report is written against an archive that
   * cannot move underneath it; the exceptions are the four tools that ARE the procedure — the three
   * run tools and `publish_report` — plus the one that opens it, whose own refusal for an
   * already-open procedure is more useful than the freeze's. Declared here rather than as a list of
   * names in the wrapper so that a tool added next year is frozen unless somebody argues the
   * exemption where the tool's purpose is stated, and so a rename cannot silently drop a tool out of
   * an exempt set.
   */
  readonly openDuringProcedure: boolean;
};

/**
 * A definition, with the argument type inferred from the shape.
 *
 * Identity at runtime. It exists for the inference: written as an object literal the handler's
 * parameter would have to be annotated by hand at every one of the twenty-nine call sites, and a
 * hand-written annotation is a second copy of the schema that can be wrong.
 */
export function defineTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.output<z.ZodObject<S>>) => Promise<ToolResult>,
  options: { readOnly?: boolean; openDuringProcedure?: boolean } = {},
): ToolDefinition<S> {
  return {
    name,
    description,
    schema,
    handler,
    readOnly: options.readOnly ?? false,
    openDuringProcedure: options.openDuringProcedure ?? false,
  };
}

/**
 * The heterogeneous form: an array of these is what a serving surface is handed.
 *
 * `handler` takes `never` rather than a widened argument object, and that is the only way a mixed
 * array of these can exist at all: a handler is CONTRAVARIANT in its argument, so
 * `(args: {recipe_id: string}) => …` is not a `(args: Record<string, unknown>) => …` — it demands
 * more than the general form promises. `never` is the bottom every one of them accepts. The price is
 * that nothing can call one directly, which is what `invoke` is for.
 */
export type AnyToolDefinition = Omit<ToolDefinition, "handler"> & {
  readonly handler: (args: never) => Promise<ToolResult>;
};

/**
 * Call a tool's handler with arguments its own schema has already validated.
 *
 * **The one cast in the tool layer, and it is a cast about types rather than about facts.** Each
 * handler's argument type was checked where it was written, against the shape sitting beside it in
 * the same call; what is lost by the time a serving surface iterates an array is only the compiler's
 * ability to say so a second time. Every caller must parse with `strictSchema(definition)` first —
 * both surfaces do — so what arrives here is the shape the handler was declared against.
 */
export function invoke(definition: AnyToolDefinition, args: unknown): Promise<ToolResult> {
  return (definition.handler as (a: unknown) => Promise<ToolResult>)(args);
}

/**
 * The tool's arguments as a schema that REFUSES a key nobody declared.
 *
 * Strict at the top level and strict inside — the tool modules write `z.strictObject` for nested
 * shapes themselves — so the whole argument surface refuses an undeclared key rather than dropping
 * it. `tests/tools.test.ts` asserts an undeclared key is actually rejected, so neither a Zod upgrade
 * nor a new serving surface can quietly undo it.
 */
export function strictSchema(definition: AnyToolDefinition): z.ZodObject<z.ZodRawShape> {
  return z.strictObject(definition.schema);
}
