/**
 * The two logs — what went WRONG, and what LEFT.
 *
 * One module for both, because they are the same machinery twice: a capped append, a prune that
 * keeps the newest thousand, a keyset read backwards from newest, and one counter that the tools
 * wrapper subtracts. Two modules would have been two copies of all four, kept in step by hand.
 *
 * NEITHER LOG IS A RECORD, and `repo/records.ts` says so structurally by listing both in
 * `LOG_TABLES`. The distinction is worth stating in the one place that writes them: a record is
 * immutable, addressable and kept for ever, and these rows are none of the three. They are pruned,
 * they are read as a stream rather than addressed, and what they describe is precisely the moments
 * the archive is silent about — an exception nobody planned for, and a row that no longer exists.
 *
 * WHAT IS NOT LOGGED IS AS DELIBERATE AS WHAT IS. A refusal is not an error: the model asked for
 * something it may not have and was told so in a sentence, which is the system working. Filing those
 * here would bury six real failures a month under a thousand ordinary conversations, and a log
 * nobody trusts to be short is a log nobody reads. The same reasoning bounds the deletion log to the
 * row actually deleted: the children a foreign key took with it are the schema's consequence of one
 * act, not six more acts, and logging them would describe plumbing where this is meant to describe a
 * decision.
 *
 * `logError` NEVER THROWS and `logDeletion` DELIBERATELY DOES. Every caller of `logError` is already
 * inside a failure handler, and a logger that throws there destroys the original exception to report
 * its own — so the whole body is wrapped and the last resort is the console. `logDeletion` runs
 * inside the transaction that deletes the row, where the opposite is true: a deletion nobody could
 * witness must not happen, and letting the throw escape is what rolls it back.
 */

import type { Database } from "bun:sqlite";

import type { EventsFrame } from "../protocol/types.ts";
import { Refused } from "../db/models.ts";

/**
 * How many rows each log keeps.
 *
 * A ring rather than a table that grows for ever, because the thousandth-newest failure has never
 * once been the one somebody was looking for, and an unbounded log on a local single-user database
 * is a file that quietly becomes the largest thing in it.
 */
export const LOG_CAP = 1000;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** How much structured context one error row may carry. Long enough for a stack, short enough that
 * a runaway payload cannot fill the ring by itself. */
const MAX_DETAIL_BYTES = 16_000;

/**
 * Which layer noticed the failure.
 *
 * Deliberately coarse. `run` says a program the agent started came back non-zero and the message
 * says which and how; splitting that into script-versus-engine would be a taxonomy that is wrong the
 * first time a third kind of program appears.
 */
export type ErrorScope = "http" | "turn" | "generation" | "tool" | "run";

export type ErrorLogRow = {
  id: number;
  at: number;
  scope: ErrorScope;
  message: string;
  detail: string | null;
};

export type DeletionLogRow = {
  id: number;
  at: number;
  table_name: string;
  row_id: string;
  row_json: string;
};

/** One page of a log, newest first, with the honest answer to "is there more behind this". */
export type LogPage<T> = {
  entries: T[];
  hasMore: boolean;
};

/**
 * How many rows THIS MODULE has written on a connection, inserts and prunes together.
 *
 * `tools/index.ts` announces `records_changed` by watching SQLite's own `total_changes()`, which
 * counts every row anything wrote. Log rows are in that number and are not the archive, so the
 * wrapper subtracts this — otherwise an error logged in the middle of a tool call would tell every
 * open window to re-read a database that had not moved. The prunes have to be in the count for the
 * same arithmetic to hold in the other direction: a pruning insert deletes a row too, and a count
 * that missed it would come out too LOW, which is the one error that suppresses a real announcement.
 *
 * Per connection, because `total_changes()` is per connection — a `WeakMap` rather than a module
 * variable so two databases in one test process never share a tally.
 */
const written = new WeakMap<Database, number>();

/**
 * The window announcer, per connection.
 *
 * Set by `attachLogAnnouncer` at boot, on the same settable-slot pattern the rest of the server uses
 * for a broadcast that does not exist yet when the stores are built.
 */
const announcers = new WeakMap<Database, (frame: EventsFrame) => void>();

function count(db: Database, rows: number): void {
  written.set(db, (written.get(db) ?? 0) + rows);
}

export function logWrites(db: Database): number {
  return written.get(db) ?? 0;
}

/**
 * Tell every open window a log moved.
 *
 * AFTER the transaction, not inside it. `bun:sqlite` is synchronous, so by the time a microtask
 * runs, the transaction that queued it has committed or rolled back — which means the alternative,
 * announcing inline, would announce deletions that never happened AND would do it while the
 * transaction still held the write, sending windows to fetch a database mid-flight. The cost of
 * this order is that a rolled-back deletion still pokes: the frames carry no body, so a spurious one
 * costs exactly one fetch that finds nothing new.
 */
function announce(db: Database, frame: EventsFrame): void {
  const send = announcers.get(db);
  if (send === undefined) return;
  queueMicrotask(() => {
    try {
      send(frame);
    } catch {
      // A window that cannot be told is not a reason to fail the write that happened.
    }
  });
}

export function attachLogAnnouncer(db: Database, send: (frame: EventsFrame) => void): void {
  announcers.set(db, send);
}

/** Both log tables take the same four columns, so the bindings are a FOUR-tuple rather than a list:
 * the arity is half of what makes the statement correct, and a tuple is where the compiler can
 * check it against the four placeholders. */
type LogBind = [number, string, string, string | null];

/**
 * Write a row and drop whatever fell off the end.
 *
 * The prune is a second statement rather than a trigger so that its rows land in the counter above;
 * a trigger's changes are in `total_changes()` all the same and would be invisible here.
 */
function appendCapped(db: Database, table: "error_log" | "deletion_log", bind: LogBind): void {
  const columns =
    table === "error_log" ? "(at, scope, message, detail)" : "(at, table_name, row_id, row_json)";
  const inserted = db
    .query<unknown, LogBind>(`INSERT INTO ${table} ${columns} VALUES (?, ?, ?, ?)`)
    .run(...bind);
  const pruned = db
    .query(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY id DESC LIMIT ?)`)
    .run(LOG_CAP);
  count(db, inserted.changes + pruned.changes);
}

/**
 * Render whatever a caller had lying around into a detail column.
 *
 * Errors carry a stack and no enumerable properties, so `JSON.stringify` of one is `{}` — hence the
 * special case. Anything circular refuses to stringify at all, and the fallback is `String`, because
 * a detail that is merely unhelpful beats a logger that throws.
 */
function renderDetail(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  let text: string;
  if (detail instanceof Error) {
    text = detail.stack ?? `${detail.name}: ${detail.message}`;
  } else if (typeof detail === "string") {
    text = detail;
  } else {
    try {
      text = JSON.stringify(detail) ?? String(detail);
    } catch {
      text = String(detail);
    }
  }
  return text.length > MAX_DETAIL_BYTES ? `${text.slice(0, MAX_DETAIL_BYTES)}…` : text;
}

/**
 * File a defect. Never throws — see the module header.
 *
 * The message is stored VERBATIM. Every caller is a place that already has the sentence a person
 * needs, and rewording it here would put this module's guess between the failure and the reader.
 */
export function logError(
  db: Database,
  scope: ErrorScope,
  message: string,
  detail?: unknown,
): void {
  try {
    const said = message.trim();
    appendCapped(db, "error_log", [
      Date.now(),
      scope,
      said === "" ? "(no message)" : said,
      renderDetail(detail),
    ]);
    announce(db, { type: "error_logged", at: Date.now() });
  } catch (err) {
    // The last resort, and the only place in this module that is allowed to give up. A log that
    // cannot write must not take the failure it was describing down with it.
    console.error("the error log could not be written", err);
  }
}

/**
 * Witness a deletion, inside the transaction doing it.
 *
 * `row` is the whole row as SQLite handed it back, including columns nobody reads — a report's
 * document, a script's program. That is the point: this is the only copy that will exist after the
 * commit, and a projection chosen today is a question somebody cannot ask tomorrow.
 */
export function logDeletion(
  db: Database,
  tableName: string,
  rowId: string,
  row: Record<string, unknown>,
): void {
  appendCapped(db, "deletion_log", [Date.now(), tableName, rowId, JSON.stringify(row)]);
  announce(db, { type: "deletion_logged", at: Date.now() });
}

function checkLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Refused(
      "invalid_request",
      `limit must be a whole number between 1 and ${MAX_LIMIT}; page on with 'before' rather than ` +
        `asking for the whole log at once`,
    );
  }
  return limit;
}

/**
 * One page of a log, newest first.
 *
 * Keyset on the id, `before=<id>`, for the reason the record browser gives: rows arrive while a
 * panel is open, and an offset then hands back a row the reader already has or skips one entirely.
 * Fetching one row more than asked is how `hasMore` is answered without a second count.
 */
function page<T>(
  db: Database,
  table: "error_log" | "deletion_log",
  columns: string,
  opts: { before?: number | undefined; limit?: number | undefined },
): LogPage<T> {
  const limit = checkLimit(opts.limit);
  const before = opts.before;
  const rows =
    before === undefined
      ? db.query<T, [number]>(`SELECT ${columns} FROM ${table} ORDER BY id DESC LIMIT ?`).all(limit + 1)
      : db
          .query<T, [number, number]>(
            `SELECT ${columns} FROM ${table} WHERE id < ? ORDER BY id DESC LIMIT ?`,
          )
          .all(before, limit + 1);
  const hasMore = rows.length > limit;
  return { entries: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

export function listErrors(
  db: Database,
  opts: { before?: number | undefined; limit?: number | undefined } = {},
): LogPage<ErrorLogRow> {
  return page<ErrorLogRow>(db, "error_log", "id, at, scope, message, detail", opts);
}

export function listDeletions(
  db: Database,
  opts: { before?: number | undefined; limit?: number | undefined } = {},
): LogPage<DeletionLogRow> {
  return page<DeletionLogRow>(db, "deletion_log", "id, at, table_name, row_id, row_json", opts);
}
