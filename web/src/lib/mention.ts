/**
 * The record-mention grammar: `@<table>:<name>`, optionally `#<column>`.
 *
 * This is the whole of how a record gets from the audit panel into a sentence. A row is dragged, the
 * drag payload is `text/plain` holding exactly what this module builds, and any textarea in the
 * window accepts it natively with no drop handler at all. The same text is what the agent reads —
 * `src/claudecode/prompts/system.md` teaches this grammar and tells the model that a mention names a
 * record rather than its contents, to be resolved with the matching read tool.
 *
 * IT NAMES THE ROW BY ITS NAME, and it used to name it by its id. The id was the safer address on
 * one axis — a rename cannot break one — and it was unreadable on every other: a uuid is the same
 * length and shape for every row in the database, the user could not check a mention they had just
 * dropped, and the model was told the name it could see in a tool result was the one thing it must
 * not address anything by. A name is unique within its table and the reader's to reword, so both
 * sides now point at a row with the same word. The cost is stated where it falls: a mention written
 * before a rename dangles, where an id never did.
 *
 * Two spellings, and the choice between them is mechanical rather than stylistic:
 *
 *   - BARE, when the name matches `[A-Za-z0-9._-]{1,80}` — every minted name, and `2330.TW`.
 *   - DOUBLE-QUOTED otherwise, and this branch is now REACHED rather than theoretical. A name is the
 *     user's to write and they write English: `@recipe:"semis, the second pass"` is what a renamed
 *     row spells. A space cannot go bare, because the mention would run into whatever follows it and
 *     there would be no telling where it ended.
 *
 * Either spelling may carry a `#column` tail — `@script:9f2c…#source` — which is what the field rows
 * inside a record card drag. It names ONE FIELD of that record, and it is a suffix rather than a
 * table of its own on purpose: a column has no identity without the row it belongs to, so a grammar
 * that could name one without naming the other would be able to spell something that is not a thing.
 *
 * The table vocabulary is `RECORD_TABLES` — the eleven tables that address a record — taken from
 * `lib/records.ts`, which mirrors the repository's own list and is locked against it by
 * `tests/webProtocol.test.ts`. It is not spelled again here: one copy of that list in the window is
 * already one more than ideal, and two would be a bug waiting for the next table.
 *
 * THERE IS NO `@message`, and no mention of a session or of a line within one — a decision rather
 * than an omission: this grammar names records, a conversation is the SDK's to hold, and a spelling
 * that addressed a line of it would be an address the record browser cannot open. Prose carrying
 * `@message:417` reads back as prose, which is the honest reading — the row it names does not exist.
 */

import type { RecordTable } from "./records.ts";
import { RECORD_TABLES } from "./records.ts";

export type { RecordTable } from "./records.ts";

/** The vocabulary, longest first — see `MENTION_RE` for why the order matters. */
export const MENTION_TABLES: readonly RecordTable[] = [...RECORD_TABLES].sort(
  (a, b) => b.length - a.length || a.localeCompare(b),
);

export function isMentionTable(value: string): value is RecordTable {
  return (RECORD_TABLES as readonly string[]).includes(value);
}

/**
 * The names that may be written without quotes.
 *
 * Eighty characters is `MAX_NAME_LENGTH` in `src/repo/naming.ts` — the longest name a rename may
 * set — so the bare form is available to every name the database will accept whose characters allow
 * it, and the bound still stops an unquoted mention from swallowing a paragraph when somebody
 * hand-types one and forgets the quotes.
 */
export const BARE_NAME = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * The column names a mention may name, and the bound on one.
 *
 * A column is an identifier in this schema, never a path or a sentence, so the class is deliberately
 * narrower than the name class — no `.` and no `-`. That narrowness is what makes the suffix
 * unambiguous after a bare name: `#` cannot appear in one, and nothing in a column name can be
 * mistaken for the punctuation that ended a sentence.
 */
export const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export type Mention = {
  table: RecordTable;
  /** The row's own `name`, which is what the wire carries and what the agent resolves. */
  name: string;
  /**
   * One column of that record, when the user pointed at a single field rather than the whole row.
   * Absent for a plain record mention — NOT the empty string, so "no column" has one spelling.
   */
  column?: string;
};

/** A mention found in a body of text, with where it sits — what a pill renderer needs to replace it
 * in place without searching for it a second time. */
export type FoundMention = Mention & {
  /** The matched text exactly as written, quotes and all. */
  text: string;
  start: number;
  /** Exclusive, so `text.slice(start, end)` is the match. */
  end: number;
};

/**
 * The scanner.
 *
 * Built from the vocabulary rather than written out, so a table added above is matched here without
 * a second edit. Longest-first alternation is what lets `script` and `script_invocation` share a
 * prefix: the longer name is tried first and matches whole. Written the other way round the engine
 * would match `script`, meet the `_` where it needs the `:`, and backtrack into the longer
 * alternative for the same answer — so the sort is not the only thing standing between this grammar
 * and a wrong parse. It is what makes the right parse the FIRST one attempted, rather than a
 * property of the separator that a change to the separator would quietly take away.
 *
 * The lookbehind refuses a mention glued to a word, so `someone@thesis:x` in an email address is not
 * read as one. It is not a lookahead-shaped problem: what disqualifies a match is what precedes it.
 *
 * What FOLLOWS a bare name is settled in `findMentions` rather than here: the name class must hold
 * `.`, `-` and `_`, so the regex cannot tell a name's last character from the punctuation that ended
 * the sentence containing it, and a trailing run of them is trimmed off the match afterwards.
 *
 * The optional `#column` tail is what makes `@script:daily-prices#source` name one field. It sits
 * outside both name branches so it works after a quoted name as well and not only after a bare one,
 * and its class shares no character with the punctuation the bare-name trim is about, so the two
 * rules never have to negotiate.
 */
const MENTION_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_])@(${MENTION_TABLES.join("|")}):(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9._-]{1,80}))(?:#([A-Za-z_][A-Za-z0-9_]{0,63}))?`,
  "g",
);

/**
 * Turn a record — or one of its columns — into the text that names it. The one place a mention is
 * spelled.
 *
 * A column that is not a plausible column name is DROPPED rather than written: the alternative is
 * emitting a string this module's own scanner would read back as a plain record mention followed by
 * prose, and a spelling that does not round-trip is worse than the missing detail.
 */
export function buildMention(table: RecordTable, name: string, column?: string): string {
  const head = BARE_NAME.test(name)
    ? `@${table}:${name}`
    : `@${table}:"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return column !== undefined && COLUMN_NAME.test(column) ? `${head}#${column}` : head;
}

/** The same, from a record card — the shape every row in the graph already holds. */
export function mentionFor(record: { table: RecordTable; name: string }, column?: string): string {
  return buildMention(record.table, record.name, column);
}

/**
 * The one mention a string consists of, or null.
 *
 * Whole-string: a trailing space or another word means this is prose containing a mention, which is
 * `findMentions`' question rather than this one's. Used where a single mention is the entire value —
 * a drag payload, a pasted chip.
 */
export function parseMention(text: string): Mention | null {
  const found = findMentions(text);
  const only = found.length === 1 ? found[0] : undefined;
  if (only === undefined) return null;
  if (only.start !== 0 || only.end !== text.length) return null;
  const { table, name, column } = only;
  return column === undefined ? { table, name } : { table, name, column };
}

/** Every mention in a body of text, in the order they appear. What turns an assistant's answer into
 * clickable pills, and what lists the records a recipe names. */
export function findMentions(text: string): FoundMention[] {
  const found: FoundMention[] = [];
  // A fresh regex per call: `MENTION_RE` is global, and a shared `lastIndex` would make the result
  // depend on who scanned last.
  const scanner = new RegExp(MENTION_RE.source, "g");
  for (const match of text.matchAll(scanner)) {
    const table = match[1];
    if (table === undefined || !isMentionTable(table)) continue;
    const quoted = match[2];
    const bare = match[3];
    const column = match[4];
    const withColumn = (name: string, text: string): FoundMention => ({
      table,
      name,
      ...(column === undefined ? {} : { column }),
      text,
      start: match.index,
      end: match.index + text.length,
    });
    if (quoted !== undefined) {
      const name = unescapeQuoted(quoted);
      // A quoted empty name names nothing; dropping the match leaves the text as the prose it is.
      if (name === "") continue;
      found.push(withColumn(name, match[0]));
      continue;
    }
    if (bare === undefined) continue;
    // A bare name stops before the punctuation that ended the sentence. The class that matches one
    // has to hold `.`, `-` and `_` — every minted name is hyphenated and a ticker like `2330.TW`
    // carries the dot — so a mention written where the agent is taught to write one, inline in
    // prose, otherwise swallows the full stop after it and addresses a record that does not exist.
    // Nothing minted here ends in one: `slugify` trims trailing hyphens and a suffix ends in base36.
    //
    // A `#column` tail settles the question by itself: the `#` ended the name explicitly, so there
    // is no trailing punctuation to guess about and trimming here would only corrupt a name the
    // author spelled deliberately — and would leave `text` no longer equal to what it spans.
    if (column !== undefined) {
      found.push(withColumn(bare, match[0]));
      continue;
    }
    const name = bare.replace(/[.\-_]+$/, "");
    if (name === "") continue;
    const trimmed = match[0].length - (bare.length - name.length);
    found.push(withColumn(name, match[0].slice(0, trimmed)));
  }
  return found;
}

function unescapeQuoted(raw: string): string {
  return raw.replace(/\\(.)/g, "$1");
}
