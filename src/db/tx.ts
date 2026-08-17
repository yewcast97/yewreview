/**
 * Transactions and the two id conventions.
 *
 * `BEGIN IMMEDIATE` rather than the default deferred begin: a transaction that reads and then
 * writes can be told "busy" halfway under a deferred begin, and by then it has already decided
 * what to write. Nesting joins the outer transaction — `bun:sqlite` implements a nested call as a
 * SAVEPOINT — so a repository function that opens a transaction is safe to call from inside one.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export function tx<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate();
}

/** uuid4 as bare hex — the id shape every non-natural key in the schema uses. */
export function newId(): string {
  return randomUUID().replaceAll("-", "");
}

/** Epoch milliseconds UTC — the only time representation this database stores. */
export function nowMs(): number {
  return Date.now();
}

/**
 * Escape a user string for use inside a LIKE pattern. Callers MUST pair this with
 * `LIKE ? ESCAPE '\'` — without the ESCAPE clause the backslashes this adds become literal
 * characters to match, which fails closed (finds nothing) rather than open, but still surprises.
 */
export function likePattern(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
