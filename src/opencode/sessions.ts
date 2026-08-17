/**
 * opencode's session store, read from the server side.
 *
 * The counterpart to `sdkSessions` in `claudecode/sessions.ts` and it exists for the same reason: this
 * installation keeps no transcript of its own, so "show me that conversation again" is a question
 * about somebody else's records. opencode's happen to be reachable over the same HTTP API the
 * harness drives, which is better than reading its files — a documented endpoint is a contract, and
 * a JSON layout on disk is an implementation detail that changes without anybody being told.
 *
 * **It asks the child, so it can only answer while one is running.** A window opened before the
 * first turn gets an empty list rather than an error: there are no conversations to show, because
 * nothing has started one. That is honest rather than degraded — the alternative, spawning a coding
 * agent to answer a question about history, would make opening the archive cost a subprocess.
 */

import { Refused } from "../db/models.ts";
import type { SessionSummary, SessionsApi, TranscriptItem } from "../server/sessions.ts";
import { resultSummary, toolSummary } from "../protocol/summary.ts";

/** What the harness lends this module: the live server, when there is one. */
export type SessionSource = () => {
  request(method: string, path: string): Promise<Response>;
} | null;

export function opencodeSessions(source: SessionSource): SessionsApi {
  const get = async (path: string): Promise<unknown | null> => {
    const server = source();
    if (server === null) return null;
    try {
      const response = await server.request("GET", path);
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      return (await response.json()) as unknown;
    } catch {
      // A child that died between the question and the answer is not an error to show a reader
      // looking at a session list; it is a list that cannot be built right now.
      return null;
    }
  };

  return {
    async list(): Promise<SessionSummary[]> {
      const body = await get("/session");
      return Array.isArray(body) ? body.flatMap(asSummary) : [];
    },

    async info(sessionId: string): Promise<SessionSummary | undefined> {
      const body = await get(`/session/${encodeURIComponent(sessionId)}`);
      const [summary] = asSummary(body);
      return summary;
    },

    async items(sessionId: string): Promise<TranscriptItem[]> {
      const body = await get(`/session/${encodeURIComponent(sessionId)}/message`);
      return Array.isArray(body) ? toTranscriptItems(body) : [];
    },

    /**
     * Ask the child to forget a conversation, permanently.
     *
     * THE ONE CALL HERE THAT REFUSES RATHER THAN ANSWERING EMPTILY, and the asymmetry is the point.
     * A list nobody can build is honestly empty — there are no conversations, because nothing has
     * started one — but a DELETION nobody performed is not "deleted", and answering 204 would tell
     * a reader their transcript is gone while it sits on disk waiting for the next boot.
     */
    async delete(sessionId: string): Promise<void> {
      const server = source();
      if (server === null) {
        throw new Refused(
          "conflict",
          "there is no opencode session running, so its store cannot be reached; start a " +
            "conversation and try again",
        );
      }
      const response = await server.request(
        "DELETE",
        `/session/${encodeURIComponent(sessionId)}`,
      );
      await response.body?.cancel();
      if (!response.ok) {
        throw new Refused(
          "conflict",
          `opencode refused to delete conversation ${sessionId} (HTTP ${response.status})`,
        );
      }
    },
  };
}

/** One session row, or nothing when the shape is not one. Returns an array so it composes with
 * `flatMap` and a malformed row drops out rather than becoming an undefined in a list. */
function asSummary(value: unknown): SessionSummary[] {
  if (typeof value !== "object" || value === null) return [];
  const row = value as { id?: unknown; title?: unknown; time?: { created?: unknown; updated?: unknown } };
  if (typeof row.id !== "string") return [];
  const created = typeof row.time?.created === "number" ? row.time.created : null;
  const updated = typeof row.time?.updated === "number" ? row.time.updated : (created ?? 0);
  return [
    {
      sessionId: row.id,
      // opencode titles a session from its first message, and an untitled one is a session that
      // has not been spoken to yet — which is exactly what the panel should say about it.
      summary: typeof row.title === "string" && row.title !== "" ? row.title : "(untitled)",
      createdAt: created,
      lastModified: updated,
    },
  ];
}

/**
 * opencode's messages as the lines a window draws.
 *
 * Deliberately its OWN mapper rather than the Claude store's: the two formats agree about nothing
 * except that a conversation has turns in it, and one function trying to read both would be a
 * function that is subtly wrong about each. What they share is the OUTPUT — `TranscriptItem` — and
 * the two summary helpers, so a tool call reads the same way whichever harness ran it.
 *
 * A message here carries its parts inline, so the pairing problem the SDK mapper solves does not
 * arise: a tool part holds its own state and its own result.
 */
function toTranscriptItems(messages: readonly unknown[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const row = message as { info?: { role?: unknown }; parts?: unknown };
    const role = row.info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts = Array.isArray(row.parts) ? row.parts : [];

    // The prose of one message is one item, however many text parts it arrived in: two text parts
    // are one thing said, and drawing them separately would invent a pause nobody took.
    const said = parts
      .filter((part): part is { type: string; text: string } => isText(part))
      .map((part) => part.text.trim())
      .filter((text) => text !== "")
      .join("\n");
    if (said !== "") items.push({ kind: role, text: said });

    for (const part of parts) {
      if (typeof part !== "object" || part === null) continue;
      const shape = part as {
        type?: unknown;
        tool?: unknown;
        state?: { status?: unknown; input?: unknown; output?: unknown } | undefined;
      };
      if (shape.type !== "tool") continue;
      const status = shape.state?.status;
      // A call still pending or running belongs to a turn in flight rather than to history; a
      // transcript drawing one would show a reader a call that never finishes.
      if (status !== "completed" && status !== "error") continue;
      const answered = resultSummary(shape.state?.output);
      items.push({
        kind: "tool",
        tool: typeof shape.tool === "string" ? shape.tool : "",
        summary: answered !== "" ? answered : toolSummary(shape.state?.input),
        ok: status === "completed",
      });
    }
  }
  return items;
}

function isText(part: unknown): part is { type: string; text: string } {
  if (typeof part !== "object" || part === null) return false;
  const shape = part as { type?: unknown; text?: unknown };
  return shape.type === "text" && typeof shape.text === "string";
}
