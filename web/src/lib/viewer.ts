/**
 * What a record's columns MEAN, for the one panel that draws a record whole.
 *
 * Pure, DOM-free and store-free — like `lib/mention.ts`, and for the same reason: `bun test` drives
 * it directly, and a promotion rule is exactly the kind of decision that is argued over once in a
 * review and then never checked again unless a test is holding it.
 *
 * The problem this exists to solve is that a raw row is not a reading of a record. A
 * `thesis_assessment` keeps its reading in `assessment` and the engine's own words in
 * `seikan_report`, and both are paragraphs; a `recipe` is nothing BUT its `content`. Drawn
 * as `<dt>/<dd>` in a field grid those are unreadable, and drawn as the whole record the ids and
 * hashes beside them vanish. So the prose columns are PROMOTED out of the row and rendered as blocks,
 * and whatever is left is rendered as the grid it always was.
 *
 * `PRIMARY_TEXT` IS ADVISORY, and the trap is treating it as schema. It names columns by string while
 * the schema moves underneath it, so a name that is not on the row is SKIPPED rather than drawn as an
 * empty section, and a table with no entry here is drawn entirely as fields. Being wrong here costs a
 * paragraph shown in the grid, which is ugly; refusing to render would cost a record the database was
 * perfectly happy to return.
 *
 * `report` is the one table deliberately left out despite holding the longest text in the database.
 * Its document is not prose to be read in a field grid — it is a document, and the panel renders it
 * as one, in an iframe. The row the browser hands over carries `content_bytes` instead of the bytes
 * themselves for exactly that reason.
 *
 * `primaryTextEntries`, `restFields` and `isRowAddress` are COMPLEMENTARY by construction — every
 * column of the row is prose, or a field, or an address — which is what stops a column somebody adds
 * to the schema from quietly failing to appear anywhere at all.
 *
 * AN ADDRESS IS NOT A FIELD, and that is the newest of the three destinations. A record's `id` and
 * every `*_id` on it are uuids: the same length and the same shape for every row in the database,
 * carrying nothing a reader can check, recognise or repeat. Worse, they are the two dozen characters
 * that a reader's eye has to cross to reach the columns that do say something. What an `*_id`
 * actually means to somebody auditing a record is "this points at that", and the panel already draws
 * that as an edge list with the target's NAME on it — "Points to", "Pointed at by", one group per
 * foreign key, empty ones included. So the address columns are dropped from the grid, and nothing is
 * lost: `src/repo/records.ts` builds those groups from the same foreign-key map the columns come
 * from, so every one of them is represented over there already.
 */

import { reportUrl } from "./api.ts";
import type { RecordDetail, RecordTable } from "./records.ts";

/**
 * The columns worth reading as prose, per table, in the order they should be read in.
 *
 * The order is the argument's order and not the row's: an assessment is the reading somebody wrote
 * and then the engine's report that reading came off, a thesis is what it argues, a recorded command
 * is the line that ran and then what it printed. Tables absent from this map hold no prose worth
 * promoting — an `information_source` is an address book entry, and a `series_preparation` is a key
 * and a one-line argument, which is what the field grid is for.
 */
export const PRIMARY_TEXT: Partial<Record<RecordTable, readonly string[]>> = {
  thesis: ["content"],
  thesis_assessment: ["assessment", "seikan_report"],
  recipe: ["content"],
  seikan_invocation: ["command", "return"],
  trivial_shell_history_for_report: ["command", "return"],
  script: ["source"],
};

/** One promoted column: the column's own name, kept because the reader is auditing a database and
 * "content" is where that paragraph lives. */
export type TextEntry = { name: string; text: string };

/** One field of the row as stored. `null` survives as null rather than becoming `""` — a column
 * holding nothing and a column holding the empty string are different audit findings. */
export type Field = { name: string; value: string | number | null };

/**
 * The record's prose, in reading order, with nothing invented.
 *
 * Absent and blank are the same answer to "is there prose in this column": no. The first happens when
 * the schema has moved under the map above, the second when the column was written empty, and neither
 * earns a heading over a void.
 */
export function primaryTextEntries(detail: RecordDetail): TextEntry[] {
  const names = PRIMARY_TEXT[detail.card.table];
  if (names === undefined) return [];
  const entries: TextEntry[] = [];
  for (const name of names) {
    const value = detail.row[name];
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (text.trim() === "") continue;
    entries.push({ name, text });
  }
  return entries;
}

/**
 * Whether this column is a ROW ADDRESS: the record's own id, or a foreign key to another row.
 *
 * A NAME TEST AGAINST A MOVING SCHEMA, and advisory in exactly the way `PRIMARY_TEXT` is — the same
 * trap and the same trade. A column that ends `_id` and is not a key would be hidden from the grid,
 * which costs a field nobody can see; a rule that tried to be exact would need the foreign-key map on
 * the client, which is a second copy of the schema kept honest by nothing.
 *
 * `target.ticker` DELIBERATELY SURVIVES, and it is the case that makes the suffix test right rather
 * than a `name.includes("id")`. That table is keyed by its ticker: `2330.TW` is the row's address AND
 * the thing the row is about, it is what somebody would type to find it, and hiding it would leave a
 * target record that says nothing at all.
 */
export function isRowAddress(name: string): boolean {
  return name === "id" || name.endsWith("_id");
}

/**
 * Whether this field is a MOMENT: an epoch-ms stamp rather than a number worth reading as one.
 *
 * The suffix and the type both, because either alone is wrong in a way that shows. `content_bytes`
 * is a number and not a time; a text column that happened to end `_at` would be a sentence, not a
 * stamp. What passes is `created_at`, `updated_at` and `added_at` holding integers, which is all
 * three of the moment columns in the schema.
 */
export function isMoment(field: Field): boolean {
  return typeof field.value === "number" && field.name.endsWith("_at");
}

/**
 * Everything the prose blocks and the edge lists did not take, in the order the row hands it over.
 *
 * Row order rather than alphabetical, because that order is the table's own declaration order and it
 * groups a record's identity, its keys and its stamps the way whoever wrote the schema grouped them.
 */
export function restFields(detail: RecordDetail): Field[] {
  const promoted = new Set(primaryTextEntries(detail).map((entry) => entry.name));
  const fields: Field[] = [];
  for (const [name, value] of Object.entries(detail.row)) {
    if (promoted.has(name) || isRowAddress(name)) continue;
    fields.push({ name, value });
  }
  return fields;
}

/**
 * Where this record's document is, when this record IS a document.
 *
 * A report is served BY ITS ID, out of the database, so the URL is built from the record's own
 * identity and there is nothing for a bad value to redirect: the only thing to decide is
 * whether this record is a report at all. A URL built out of a STORED PATH would need a containment
 * check on that path instead, because a row saying anything else would point an `<iframe>` at an
 * arbitrary file.
 */
export function reportSource(detail: RecordDetail): string | null {
  if (detail.card.table !== "report") return null;
  return reportUrl(detail.card.id);
}
