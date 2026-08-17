/**
 * The line that names a file, read back out of a message. The other half of `lib/outgoing.ts`.
 *
 * One grammar, written by both ends and read here. The composer flattens a dropped file into
 * `Attached file: <path>` on its own line; `src/claudecode/prompts/system.md` teaches the agent the same
 * line for the other direction, so that handing the reader a CSV is writing it under the home and
 * naming it. This module is the one reader of both, which is why `FILE_PREFIX` is IMPORTED from the
 * writer rather than spelled again: two copies of a grammar agree until one of them is tuned.
 *
 * WHY THE FACT LIVES IN THE TEXT AND NOT IN A FRAME. A live frame — `report_published` is the one
 * this window already has — exists for the length of a socket. The transcript is the agent SDK's own
 * store, replayed on every reload as user turns, assistant turns, tool calls and whatever the SDK
 * folded, and a frame that once travelled beside a turn is in none of that. So a chip built from a
 * frame is a chip that disappears the first time somebody refreshes the tab, and a download the
 * reader can only take before they reload is worse than no chip at all. A line inside the message
 * survives because the message does, in both directions, for free and for ever.
 *
 * WHAT COUNTS AS THE LINE is deliberately strict, because everything that is not the line is
 * somebody's prose. It must be the prefix, one space and a non-empty path, and nothing else on the
 * row: the path runs to the end of the line because a filename may hold spaces, which is exactly why
 * nothing may follow it, and a prefix with nothing after it names no file and stays the sentence it
 * is. Leading and trailing whitespace is forgiven — an indented line is the same line — and the line
 * takes its own newline with it when it goes, so removing it leaves no blank row behind where the
 * sentence used to be.
 *
 * A LINE INSIDE A FENCED BLOCK IS QUOTED RATHER THAN USED, and stays text. It is the same doctrine
 * `decorateMentions` follows for a mention inside `code` or `pre`, for the same reason: a block that
 * shows somebody the syntax is showing it, and turning the example into a live download would be
 * this window rewriting the document it is drawing. The prompt itself teaches this grammar inside a
 * fence, so an agent quoting its own instructions is the case that arrives first.
 *
 * PURE and DOM-FREE, so `bun test` drives it directly under the root tsconfig — no store, no React.
 */

import { FILE_PREFIX } from "./outgoing.ts";

/**
 * A message cut into the parts that are prose and the parts that are files.
 *
 * `name` rides along beside `path` because the chip draws one and links to the other, and computing
 * the base name at every draw would be the same answer arrived at twice. It is the LAST SEGMENT and
 * never the whole path: what the reader recognises is `q3-earnings.pdf`, and a chip as wide as
 * `uploads/1a2b3c4d/q3-earnings.pdf` says the same thing while fitting nowhere.
 */
export type AttachmentSegment =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; name: string };

/**
 * A message, in order: its prose and the files named in it, with nothing added and nothing lost but
 * the lines that became files.
 *
 * `final` is about a turn that is still arriving. A stream is written a few characters at a time, so
 * the last line of it is routinely half a line — and half a path is a link to a file that does not
 * exist, offered to somebody who may well click it. While `final` is false the unterminated last
 * line is therefore held back as prose, and it becomes a chip on the delta that ends it. The default
 * is the other reading because the durable copy is the common one: every message read back from the
 * SDK's store has stopped growing, and a file alone on the wire is a message with no trailing
 * newline at all.
 *
 * Adjacent prose merges into one segment and empty prose is dropped, so a message that is nothing
 * but one attachment line is one file segment rather than a file between two empty paragraphs.
 */
export function splitAttachments(text: string, final = true): AttachmentSegment[] {
  const segments: AttachmentSegment[] = [];
  let prose = "";
  // The delimiter of the fenced block currently open, or null out in the open. Carried rather than
  // counted, because a block opened with four backticks is closed only by four.
  let fence: string | null = null;
  let at = 0;

  while (at < text.length) {
    const brk = text.indexOf("\n", at);
    const terminated = brk !== -1;
    const end = terminated ? brk + 1 : text.length;
    const line = text.slice(at, terminated ? brk : text.length);
    const run = fenceRun(line);

    if (run !== null) {
      // A fence line is furniture in either direction and never an attachment line. Closing takes
      // the same character and at least as many of them, which is CommonMark's rule and is what
      // keeps a ``` inside a ~~~ block from ending it.
      if (fence === null) fence = run;
      else if (run[0] === fence[0] && run.length >= fence.length) fence = null;
      prose += text.slice(at, end);
      at = end;
      continue;
    }

    const path = fence === null && (terminated || final) ? attachmentPath(line) : null;
    if (path === null) {
      prose += text.slice(at, end);
    } else {
      if (prose !== "") segments.push({ kind: "text", text: prose });
      prose = "";
      segments.push({ kind: "file", path, name: baseName(path) });
    }
    at = end;
  }

  if (prose !== "") segments.push({ kind: "text", text: prose });
  return segments;
}

/**
 * The path one line names, or null when the line is prose.
 *
 * The second space is what makes this a rejection rather than a trim: `Attached file:  x` is a line
 * that nearly says the grammar, and reading a path with a leading space out of it would hand back a
 * chip pointing at a file nobody wrote. The grammar is one space, and a line that is not it is the
 * sentence it appears to be.
 */
function attachmentPath(line: string): string | null {
  const said = line.trim();
  const head = `${FILE_PREFIX} `;
  if (!said.startsWith(head)) return null;
  const path = said.slice(head.length);
  if (path === "" || /^\s/.test(path)) return null;
  return path;
}

/**
 * The run of backticks or tildes that opens or closes a fenced block, or null.
 *
 * Three or more, indented no further than three spaces — past that a line is inside an indented code
 * block rather than starting a fence. The info string an opening fence may carry is not looked at:
 * what this rule decides is whether the lines under it are being quoted, and every fence quotes.
 */
function fenceRun(line: string): string | null {
  return /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
}

/**
 * What the file is called: the last segment of the path.
 *
 * `/` and not the platform's separator, because the path is written under the agent's home on a
 * machine this window never sees, and the two ends of this line are macOS and Linux. A path that
 * ends in a separator has no last segment, so what is drawn is the whole of it — the server will
 * answer that URL with a 404, and a chip that says what was written is a better account of that than
 * a chip with no label.
 */
function baseName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.at(-1) ?? path;
}

/**
 * Where the server hands that file back.
 *
 * The prefix is `src/server/homeFiles.ts`'s `FILES_URL_PREFIX`, spelled here rather than imported
 * for the reason `lib/protocol.ts` mirrors the server's types by hand: an import out of `src/` drags
 * the server's world — `node:fs` in that file's case — into a browser bundle. The two spellings are
 * locked against each other by `tests/webAttachments.test.ts`, which is what a hand-written mirror
 * costs.
 *
 * ENCODED SEGMENT BY SEGMENT, WITH THE SEPARATORS KEPT. Encoding the whole path would spell its
 * slashes `%2F`, which addresses one file whose name contains slashes — a file that cannot exist.
 * Per-segment is also what puts a `#` or a `?` in a filename into the path instead of starting a
 * fragment or a query, and those are the two characters that would otherwise silently hand back the
 * wrong file.
 */
export function fileHref(path: string): string {
  return FILES_URL_PREFIX + path.split("/").map(encodeURIComponent).join("/");
}

/** The server's own prefix, mirrored. Under `/api/` because a working file the agent wrote this
 * afternoon is machinery rather than archive; `/reports/` is where the documents live for ever. */
const FILES_URL_PREFIX = "/api/files/";
