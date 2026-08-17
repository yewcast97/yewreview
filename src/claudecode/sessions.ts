/**
 * The Claude Agent SDK's session store, read back through the server's seam.
 *
 * **The transcript is not ours.** YewReview keeps no record of what was said — there is no `message`
 * table, deliberately, so that what the model remembers and what the user is shown cannot drift
 * apart. The consequence is that "show me that conversation again" is a question about somebody
 * else's files: JSONL under `<var-dir>/claudecode/projects/<the agent's home>`, written by the CLI
 * subprocess on a flush cadence nothing here controls. Four SDK functions reach it, and everything
 * below is either a thin call into those four or a pure mapping of what they hand back. The fourth
 * is the only one that writes: `deleteSession` unlinks the transcript and any subagent transcripts
 * under it, which is what a conversation dragged onto the Bin asks for.
 *
 * This module is the counterpart to `opencodeSessions` in `src/opencode/sessions.ts`: one harness,
 * one store, one implementation of `SessionsApi`. The interface itself lives in
 * `src/server/sessions.ts`, on the consumer's side, because it is the server that knows which four
 * fields a session panel draws.
 *
 * One fidelity loss is worth naming rather than discovering. `SessionMessage` carries `type`, `uuid`
 * and the message payload, and DROPS the transcript entry's `subtype` — so a compaction boundary,
 * which the live socket surfaces as a `compacted` frame, arrives here as an unremarkable system row.
 * `isCompactBoundary` therefore looks for the SDK's own word on the row AND inside its payload, and
 * a system row that says nothing about itself is skipped: labelling an unknown row "compacted" would
 * tell a reader their history had been folded away when it had not.
 */

import {
  deleteSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Settings } from "../config.ts";
import { homeDir, paths } from "../config.ts";
import { resultSummary, toolSummary } from "../protocol/summary.ts";
import type { SessionSummary, SessionsApi, TranscriptItem } from "../server/sessions.ts";

/**
 * The Claude Agent SDK's store.
 *
 * `includeSystemMessages` is on because compaction is a system row and a reader who lost half a
 * conversation to it deserves to be told so where it happened, rather than finding the transcript
 * simply shorter than they remember.
 */
export function sdkSessions(settings: Settings): SessionsApi {
  const dir = homeDir(settings);
  // The three reader functions below take the PROJECT directory but not the store's root: they read
  // that from this process's own environment, exactly as the CLI subprocess does. So the module that
  // reads the store names the root, once, from the same `paths()` entry the session's subprocess
  // environment is built from — the alternative is a reader looking in `~/.claude` for transcripts
  // the writer put under `var/`, which fails by showing an empty list rather than by throwing.
  process.env["CLAUDE_CONFIG_DIR"] = paths(settings).claudecodeDir;
  return {
    list: async () => (await listSessions({ dir })).map(asSummary),
    info: async (sessionId) => {
      const info = await getSessionInfo(sessionId, { dir });
      return info === undefined ? undefined : asSummary(info);
    },
    items: async (sessionId) =>
      toTranscriptItems(await getSessionMessages(sessionId, { dir, includeSystemMessages: true })),
    delete: async (sessionId) => {
      try {
        await deleteSession(sessionId, { dir });
      } catch (err) {
        // GONE IS DONE. The SDK throws when the id names nothing, and the route asks `info` before
        // it asks for this — so the only way to arrive here is the store pruning the transcript in
        // between, which is a race whose outcome is exactly what the caller wanted. Anything else
        // (a permission error, a directory that moved) is a real failure and keeps travelling.
        if ((await getSessionInfo(sessionId, { dir })) === undefined) return;
        throw err;
      }
    },
  };
}

function asSummary(info: {
  sessionId: string;
  summary: string;
  createdAt?: number | undefined;
  lastModified: number;
}): SessionSummary {
  return {
    sessionId: info.sessionId,
    summary: info.summary,
    createdAt: info.createdAt ?? null,
    lastModified: info.lastModified,
  };
}

/** A tool item while it is still open, so the result can settle the object already in the list. */
type OpenTool = { kind: "tool"; tool: string; summary: string; ok: boolean };

/** The handful of fields actually read out of a message payload, spelled locally. Everything here
 * arrives as `unknown` from the SDK and is checked before it is believed. */
type Payload = { content?: unknown; subtype?: unknown };

type Block = {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
};

/**
 * A stored conversation, as lines to draw. Pure, and exported so the pairing can be tested without a
 * disk.
 *
 * The tool pairing is the only stateful part, and it is deliberately the SAME algorithm the live
 * session runs: a map from `tool_use` id to the call awaiting its answer, filled when an assistant
 * message opens a call and emptied when a later user message carries the matching `tool_result`.
 * Pairing by id across messages rather than by position is what makes it correct when two calls are
 * in flight at once, which parallel tool use makes ordinary. A result that matches no open call is
 * DROPPED rather than drawn: it is the tail of a call whose opening half compaction already folded
 * away, and inventing a line for it would put a tool in the transcript that this conversation cannot
 * show you the request for.
 */
export function toTranscriptItems(messages: readonly SessionMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const open = new Map<string, OpenTool>();

  for (const message of messages) {
    if (isCompactBoundary(message)) {
      items.push({ kind: "compacted" });
      continue;
    }
    const payload = payloadOf(message.message);
    if (payload === null) continue;

    if (message.type === "assistant") {
      const blocks = blocksOf(payload.content);
      // The text first and the calls after, in block order, because that is the order the live
      // stream produced them: deltas arrive while the model writes, and a tool call is the thing it
      // does next. One item per message rather than one per block — two text blocks are one thing
      // said, and a window that drew them as two replies would invent a pause nobody took.
      const said = textOf(blocks);
      if (said !== "") items.push({ kind: "assistant", text: said });
      for (const block of blocks) {
        if (block.type !== "tool_use" || typeof block.id !== "string") continue;
        const item: OpenTool = {
          kind: "tool",
          tool: typeof block.name === "string" ? block.name : "",
          summary: toolSummary(block.input),
          ok: true,
        };
        items.push(item);
        open.set(block.id, item);
      }
      continue;
    }

    if (message.type === "user") {
      // A user message is a string when a person typed it and a list of blocks when the SDK is
      // handing tool results back to the model. Both spellings are ordinary, and the second one
      // usually produces NO user item at all — a page of tool output is not something anybody said.
      if (typeof payload.content === "string") {
        const text = payload.content.trim();
        if (text !== "") items.push({ kind: "user", text });
        continue;
      }
      const blocks = blocksOf(payload.content);
      const asked = textOf(blocks);
      if (asked !== "") items.push({ kind: "user", text: asked });
      for (const block of blocks) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const waiting = open.get(block.tool_use_id);
        if (waiting === undefined) continue;
        open.delete(block.tool_use_id);
        waiting.ok = block.is_error !== true;
        // The result's summary replaces the call's when it has one, which is exactly what the live
        // window does with `tool_end`: the answer knows what happened and the request only knew what
        // was asked for.
        const answered = resultSummary(block.content);
        if (answered !== "") waiting.summary = answered;
      }
      continue;
    }
    // Anything else — a system row that did not identify itself, a shape this build does not know —
    // is skipped rather than guessed at.
  }

  return items;
}

/**
 * Whether this row is the SDK saying it folded the conversation up.
 *
 * Both places are checked because the local JSONL reader strips the entry's `subtype` on its way
 * into `SessionMessage` (see the module header), so in practice this is answered by the payload when
 * it is answered at all — and by the row itself if the SDK ever carries it through.
 */
function isCompactBoundary(message: SessionMessage): boolean {
  if (message.type !== "system") return false;
  const row = message as unknown as { subtype?: unknown };
  if (row.subtype === "compact_boundary") return true;
  return payloadOf(message.message)?.subtype === "compact_boundary";
}

function payloadOf(message: unknown): Payload | null {
  return typeof message === "object" && message !== null ? (message as Payload) : null;
}

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

/**
 * The prose of a message: its text blocks, trimmed, blanks dropped, joined by one newline.
 *
 * A newline rather than nothing between them. Two text blocks in one message are two things the
 * model chose to separate, and gluing them would run the last word of one into the first word of the
 * next — which is what a reader would notice, and the only thing they could not put right by reading
 * more carefully.
 */
function textOf(blocks: readonly Block[]): string {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => (block.text as string).trim())
    .filter((text) => text !== "")
    .join("\n");
}
