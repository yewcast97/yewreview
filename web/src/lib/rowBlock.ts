/**
 * The row block: the one grammar a record row is rendered in, parsed.
 *
 * A `~~~row` fence in the agent's prose carries a record laid out as an indent outline — the table
 * name at the margin, each field name two spaces in, its value two spaces further, `****` for a
 * field not filled in yet, and a code value as its own backtick fence inside the block. The prompt
 * teaches the grammar (`src/claudecode/prompts/system.md`, "Showing a row") and the consent rule on
 * every writing tool restates it (`CONSENT` in `src/tools/common.ts`); this module is the window's
 * half of that contract, and `components/rowCard.ts` is what draws the result.
 *
 * PURE and DOM-FREE, like `lib/highlight.ts`: `bun test` drives it directly under the root
 * tsconfig, which has no DOM in its libs. The DOM half lives in `components/`, which is the whole
 * reason this is two files.
 *
 * TOLERANT ON PURPOSE. The author is a model, so the indentation arrives approximately: three
 * spaces where the grammar says two, a tab, a value whose own lines wander. The parser therefore
 * MEASURES rather than requires — the first indented line decides where field names sit, the first
 * line under a field decides where its value sits, and anything deeper is that value's own shape.
 * What it does NOT do is invent structure that is not there: a second line at the margin is not a
 * sloppy row but a different document, and the answer is `null`.
 *
 * `null` IS THE WHOLE ERROR CONTRACT. The caller falls back to the plain code-block chrome, which
 * shows every character the model wrote — so a defect here costs the card and never the text. That
 * is also why `parseRowBlock` never throws: it runs inside the paint of every message, where an
 * exception would take the transcript down with it.
 */

/** One field's value: not filled in yet, a fenced program, or prose (rendered as markdown). */
export type RowValue =
  | { kind: "empty" }
  | { kind: "code"; lang: string; code: string }
  | { kind: "text"; text: string };

export type RowField = { name: string; value: RowValue };

export type RowBlock = { table: string; fields: RowField[] };

/** The mark for a field nobody has filled in yet. One spelling, shared with the card that draws it
 * and with the doctrine that tells the agent to write it. */
export const UNFILLED = "****";

/** A backtick fence opener: the run, then an info word with no backtick in it — a fourth backtick
 * belongs to the run rather than to the language. */
const FENCE_OPEN = /^(`{3,})([^`]*)$/;

/** A backtick fence closer: a bare run, at least as long as the one that opened it. */
function closesFence(line: string, run: number): boolean {
  const trimmed = line.trim();
  return /^`{3,}$/.test(trimmed) && trimmed.length >= run;
}

/**
 * The body of a `~~~row` fence as a typed tree, or `null` when it is not one.
 *
 * `null` on nothing but blank lines, on an indented first line (no table at the margin), and on a
 * second line at the margin. Everything else is read as generously as the indentation allows.
 */
export function parseRowBlock(body: string): RowBlock | null {
  try {
    return parse(body);
  } catch {
    // A defect in this parser costs the card and not the transcript: the caller's fallback renders
    // every character as a plain code block, which is also what an honest failure looks like.
    return null;
  }
}

/** One line, split where the structure is decided: how far in it starts, and what it says. */
type Line = { indent: number; lead: string; text: string; blank: boolean };

/**
 * A tab counts for two columns — the grammar's own unit — so a tabbed outline still lines up.
 *
 * The leading whitespace is KEPT as it was written rather than rewritten as spaces, because these
 * lines include the interior of a code fence: a program indented with tabs must reach the copy
 * button as the bytes its author typed. `indent` is for structure; `lead` is for fidelity.
 */
function readLine(raw: string): Line {
  const line = raw.replace(/\r$/, "");
  const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
  let indent = 0;
  for (const ch of lead) indent += ch === "\t" ? 2 : 1;
  const text = line.slice(lead.length);
  return { indent, lead, text, blank: text.trim() === "" };
}

/** The line with `width` columns of indent taken off the front — never more than it has, so a line
 * shallower than the value's margin (a program's column-zero brace) arrives whole. */
function dedent(line: Line, width: number): string {
  let consumed = 0;
  let at = 0;
  while (at < line.lead.length && consumed < width) {
    consumed += line.lead[at] === "\t" ? 2 : 1;
    at += 1;
  }
  // A tab straddling the boundary gives back the columns it overshot, as spaces: half a tab is not
  // a character, and the alternative is a program that shifts left by one stop.
  const overshoot = consumed > width ? " ".repeat(consumed - width) : "";
  return overshoot + line.lead.slice(at) + line.text;
}

function parse(body: string): RowBlock | null {
  const lines = body.split("\n").map(readLine);

  // The table name: the first written line, which has to sit at the margin.
  let at = 0;
  while (at < lines.length && (lines[at]?.blank ?? true)) at += 1;
  const head = lines[at];
  if (head === undefined || head.indent !== 0) return null;
  const table = head.text.trim();
  at += 1;

  const fields: RowField[] = [];
  let fieldIndent: number | null = null;
  let name: string | null = null;
  let valueIndent: number | null = null;
  let value: string[] = [];
  let fenceRun = 0; // the run that opened an inner fence, 0 while none is open

  const close = (): void => {
    if (name === null) return;
    fields.push({ name, value: classify(value) });
    name = null;
    valueIndent = null;
    value = [];
    fenceRun = 0;
  };

  for (; at < lines.length; at += 1) {
    const line = lines[at];
    if (line === undefined) continue;

    // INSIDE A FENCE THE INDENT RULES ARE SUSPENDED, which is the one branch that has to come
    // first. Real code has lines at column zero and blank lines that mean something, and a `}` at
    // the margin is the program's rather than a second table.
    if (fenceRun > 0) {
      const kept = dedent(line, valueIndent ?? 0);
      value.push(kept);
      if (closesFence(kept, fenceRun)) fenceRun = 0;
      continue;
    }

    if (line.blank) {
      // A blank line inside a value is the author's paragraphing; one between fields divides
      // nothing, and one before any value at all is not the start of a value.
      if (name !== null && value.length > 0) value.push("");
      continue;
    }

    if (line.indent === 0) return null;

    if (fieldIndent === null || line.indent <= fieldIndent) {
      // Where the field names sit is wherever the first one sat.
      fieldIndent ??= line.indent;
      close();
      name = line.text.trim();
      continue;
    }

    // Deeper than the field names: a value line. Its own first line sets the value's margin, and
    // whatever a later line has past that margin is the value's own shape.
    if (name === null) return null;
    valueIndent ??= line.indent;
    const kept = dedent(line, valueIndent);
    value.push(kept);
    const opener = FENCE_OPEN.exec(kept.trim())?.[1];
    if (opener !== undefined) fenceRun = opener.length;
  }
  close();

  return { table, fields };
}

/**
 * What a field's collected value IS: nothing yet, one fenced program, or prose.
 *
 * `****` alone is the empty mark, and so is no value at all — both draw as the placeholder, because
 * a field the agent left out and a field it marked unanswered are the same question to whoever is
 * reading.
 *
 * A value that is exactly one fence, blank lines aside, is code: the opener's word is the language,
 * and an unclosed fence is read to the end, because the model stopped writing and the program is
 * still the program. ANYTHING ELSE IS TEXT, kept whole — including writing after a closed fence.
 * The markdown renderer shows a stray fence legibly, and a parser that dropped "the rest" would be
 * deciding what the author meant to say.
 */
function classify(collected: string[]): RowValue {
  // Trailing and leading blanks are padding; the ones between are the value's own.
  const lines = [...collected];
  while (lines[0]?.trim() === "") lines.shift();
  while (lines[lines.length - 1]?.trim() === "") lines.pop();
  if (lines.length === 0) return { kind: "empty" };

  const joined = lines.join("\n");
  if (joined.trim() === UNFILLED) return { kind: "empty" };

  const open = FENCE_OPEN.exec(lines[0]?.trim() ?? "");
  const run = open?.[1]?.length;
  if (run !== undefined && lines.length > 1) {
    const rest = lines.slice(1);
    const closeAt = rest.findIndex((line) => closesFence(line, run));
    const trailing = closeAt === -1 ? [] : rest.slice(closeAt + 1);
    if (trailing.every((line) => line.trim() === "")) {
      return {
        kind: "code",
        lang: (open?.[2] ?? "").trim(),
        code: (closeAt === -1 ? rest : rest.slice(0, closeAt)).join("\n"),
      };
    }
  }
  return { kind: "text", text: joined };
}
