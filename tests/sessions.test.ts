/**
 * Turning the SDK's stored transcript into the lines a window draws.
 *
 * `toTranscriptItems` is pure, and these tests are pure with it — no server, no disk, no store of
 * any kind. That is the whole reason the function is separate from the route that calls it: what
 * is genuinely hard here is the PAIRING, and pairing is a property of a sequence of messages rather
 * than of an HTTP handler.
 *
 * The hard part is worth stating before the cases. A tool call and its answer arrive in DIFFERENT
 * messages — the assistant opens it with a `tool_use` block, and a later user message carries the
 * `tool_result` — with any number of other messages, and other calls, in between. The live socket
 * has the same problem and solves it the same way, with a map from tool-use id to the call awaiting
 * its answer, so what these tests really assert is that an old conversation reads the way it read
 * while it was happening.
 */

import { describe, expect, test } from "bun:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import { toTranscriptItems } from "../src/claudecode/sessions.ts";

/**
 * One stored message, in the shape `getSessionMessages` hands back.
 *
 * `message` is typed `unknown` by the SDK — it is the raw payload off the transcript — so the fields
 * below are spelled exactly as the API writes them, snake_case and all, rather than as anything this
 * codebase would have chosen.
 */
function stored(
  type: "user" | "assistant" | "system",
  message: unknown,
  extra: Record<string, unknown> = {},
): SessionMessage {
  return {
    type,
    uuid: `u-${Math.random().toString(16).slice(2)}`,
    session_id: "s-1",
    message,
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...extra,
  } as SessionMessage;
}

const said = (text: string) => stored("user", { role: "user", content: text });

const replied = (...content: unknown[]) =>
  stored("assistant", { role: "assistant", content });

const answered = (...content: unknown[]) => stored("user", { role: "user", content });

describe("reading a stored conversation", () => {
  test("what was typed and what was said come back as two lines", () => {
    const items = toTranscriptItems([
      said("what happened to margins?"),
      replied({ type: "text", text: "Gross margin was 74.6%." }),
    ]);

    expect(items).toEqual([
      { kind: "user", text: "what happened to margins?" },
      { kind: "assistant", text: "Gross margin was 74.6%." },
    ]);
  });

  test("two text blocks in one message are one thing said, joined rather than glued", () => {
    const items = toTranscriptItems([
      replied(
        { type: "text", text: "  First paragraph.  " },
        { type: "text", text: "" },
        { type: "text", text: "Second paragraph." },
      ),
    ]);

    // One item, because one message is one turn of speech — and a newline between the blocks,
    // because the model chose to separate them and running the last word of one into the first of
    // the next is the one mistake a reader could not undo by reading more carefully.
    expect(items).toEqual([{ kind: "assistant", text: "First paragraph.\nSecond paragraph." }]);
  });

  test("a call and its answer are paired across messages, and the answer settles the line", () => {
    const items = toTranscriptItems([
      said("how many theses are there?"),
      replied(
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "t1", name: "list_theses", input: { tag: "insightful" } },
      ),
      // The result arrives in its own message, which is what makes this pairing rather than
      // adjacency — and it carries no text of its own, so nothing is drawn as something a person
      // said. A page of tool output is not a remark.
      answered({ type: "tool_result", tool_use_id: "t1", content: "3 theses" }),
      replied({ type: "text", text: "Three." }),
    ]);

    expect(items).toEqual([
      { kind: "user", text: "how many theses are there?" },
      { kind: "assistant", text: "Let me look." },
      // The result's own summary replaced the call's, exactly as `tool_end` does on the live socket:
      // the answer knows what happened and the request only knew what was asked for.
      { kind: "tool", tool: "list_theses", summary: "3 theses", ok: true },
      { kind: "assistant", text: "Three." },
    ]);
  });

  test("two calls in flight at once settle by id rather than by order", () => {
    const items = toTranscriptItems([
      replied(
        { type: "tool_use", id: "t1", name: "get_thesis", input: { thesis_id: "th-1" } },
        { type: "tool_use", id: "t2", name: "get_target", input: { ticker: "NVDA" } },
      ),
      // Answered in the other order, which parallel tool use makes ordinary. Pairing by position
      // would mark the wrong one failed.
      answered(
        { type: "tool_result", tool_use_id: "t2", content: "NVDA", is_error: false },
        { type: "tool_result", tool_use_id: "t1", is_error: true, content: "no thesis th-1" },
      ),
    ]);

    expect(items).toEqual([
      { kind: "tool", tool: "get_thesis", summary: "no thesis th-1", ok: false },
      { kind: "tool", tool: "get_target", summary: "NVDA", ok: true },
    ]);
  });

  test("a call with no answer stays open and reads as unfinished rather than failed", () => {
    // The tail of a transcript that ends mid-turn — the process died, or the SDK is still writing.
    const items = toTranscriptItems([
      replied({ type: "tool_use", id: "t1", name: "run_script", input: { script_id: "prices.py" } }),
    ]);

    // `ok: true` because nothing has said otherwise. A call drawn as failed on no evidence would be
    // this module inventing a verdict the conversation never reached. The summary is the CALL's,
    // since no answer arrived to replace it.
    expect(items).toEqual([
      { kind: "tool", tool: "run_script", summary: "prices.py", ok: true },
    ]);
  });

  test("an answer to a call this transcript does not contain is dropped", () => {
    const items = toTranscriptItems([
      answered({ type: "tool_result", tool_use_id: "gone", content: "it worked" }),
      said("carry on"),
    ]);

    // This is what compaction leaves behind: the opening half of the call was folded into a summary
    // and the answer survived it. Drawing a line for it would put a tool in the transcript whose
    // request cannot be shown.
    expect(items).toEqual([{ kind: "user", text: "carry on" }]);
  });

  test("a user message may be blocks as well as a string, and may be both at once", () => {
    const items = toTranscriptItems([
      replied({ type: "tool_use", id: "t1", name: "get_recipe", input: {} }),
      answered(
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "semis, active" }] },
        { type: "text", text: "and now compare it with the other one" },
      ),
    ]);

    expect(items).toEqual([
      { kind: "tool", tool: "get_recipe", summary: "semis, active", ok: true },
      { kind: "user", text: "and now compare it with the other one" },
    ]);
  });

  test("a compaction boundary is a line of its own, and other system rows are skipped", () => {
    const items = toTranscriptItems([
      said("first"),
      // The SDK's local reader drops the entry's `subtype` on its way into `SessionMessage`, so
      // both spellings are recognised — the row's own field, and the payload's.
      stored("system", { subtype: "compact_boundary", compact_metadata: { trigger: "auto" } }),
      stored("system", undefined, { subtype: "compact_boundary" }),
      // A system row that does not say what it is gets skipped rather than labelled: telling a
      // reader their history was folded away when it was not is worse than saying nothing.
      stored("system", { content: "something the CLI noted to itself" }),
      said("second"),
    ]);

    expect(items).toEqual([
      { kind: "user", text: "first" },
      { kind: "compacted" },
      { kind: "compacted" },
      { kind: "user", text: "second" },
    ]);
  });

  test("shapes nothing here understands are skipped rather than guessed at", () => {
    const items = toTranscriptItems([
      stored("assistant", null),
      stored("assistant", { role: "assistant", content: "a string where blocks were expected" }),
      replied({ type: "thinking", thinking: "…" }, { type: "tool_use", name: "no_id_here" }),
      said("   "),
      stored("user", { role: "user", content: 42 }),
    ]);

    // Nothing survives: an assistant message whose content is not blocks says nothing this can
    // draw, a `tool_use` with no id can never be settled, and a blank message is a stray keypress.
    expect(items).toEqual([]);
  });

  test("an empty transcript is an empty list, not an error", () => {
    expect(toTranscriptItems([])).toEqual([]);
  });
});
