/**
 * How a tool call is described in one line — live, and afterwards.
 *
 * A call is summarised twice by two different readers: a harness summarises it as it happens, into
 * the `tool_start` / `tool_end` frames a watching window draws, and the server summarises it again
 * when it maps a stored transcript back for a window opening an old conversation. Those two
 * descriptions must be the SAME description. A second summariser on either side would mean a call
 * read one way while it ran and another way once it was history, and the difference would look like
 * the record having changed.
 *
 * So it lives here, under the protocol rather than under a harness: both transcript readers
 * (`src/claudecode/sessions.ts`, `src/opencode/sessions.ts`) read it, and so do both live sessions,
 * none of them through each other.
 */

/**
 * A one-line description of a tool call, short enough to sit beside the text of a turn.
 *
 * The key order is not alphabetical and each position is a judgement. `script_id` comes before
 * anything carrying source, because saving a script passes both an id and a whole program and the
 * program would otherwise be pasted, newlines and all, into a one-line label. `description` comes
 * before `command` because Bash carries both and one of them is a heredoc. A call this finds
 * nothing in gets an empty label rather than a guess: the frame already names the tool.
 */
export function toolSummary(input: unknown): string {
  const payload = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  for (const key of [
    "name",
    "ticker",
    "thesis_id",
    "script_id",
    "report_id",
    "title",
    "file_path",
    "path",
    "url",
    "query",
    "pattern",
    "description",
    "command",
    "source",
    "tag",
  ]) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") return oneLine(value);
  }
  return "";
}

function oneLine(text: string, limit = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** The first readable line of a tool result, for the frame that closes the call out. Here for the
 * same reason `toolSummary` is: one description of a call, live and afterwards. */
export function resultSummary(content: unknown): string {
  if (typeof content === "string") return oneLine(content, 200);
  if (Array.isArray(content)) {
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        return oneLine(block.text, 200);
      }
    }
  }
  return "";
}
