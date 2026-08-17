/**
 * Opening the database, and refusing the ones that are not ours.
 *
 * `bun:sqlite` is synchronous and in-process, so there is one handle for the whole server. The
 * per-connection pragma set is the part worth reading twice — `foreign_keys` in particular is OFF
 * by default in SQLite and is not a property of the file, so every open has to turn it on or the
 * cascades in `schema.ts` are decoration.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { APPLICATION_ID, SCHEMA_V1, SCHEMA_VERSION } from "./schema.ts";

export class DatabaseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseRefused";
  }
}

const BUSY_TIMEOUT_MS = 5000;

function pragmaInt(db: Database, name: string): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, number> | null;
  if (!row) return 0;
  const value = Object.values(row)[0];
  return typeof value === "number" ? value : 0;
}

function tableCount(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view')")
    .get() as { n: number };
  return row.n;
}

/**
 * Open (creating if absent) and return a configured handle.
 *
 * The four outcomes, in the order they are decided:
 *   1. our application id + our schema version → open it;
 *   2. our application id + any other schema version → refuse. The stamp and the table shapes are
 *      one fact, so a file stamped differently is a different shape and reading it with these
 *      assumptions is how a mismatch eats data. There is no migration ladder by design (see
 *      `schema.ts`), so the remediation is to move the file aside, not to pretend a repair exists;
 *   3. an unstamped file with no tables → a fresh file; apply the schema;
 *   4. anything else → refuse. A file carrying someone else's stamp, or tables this build never
 *      wrote, is not ours to interpret; the message says what to do rather than guessing.
 *
 * `readonly` is the read-only process's open (`db/lock.ts`): the connection is opened with
 * SQLite's own read-only flag, so a write that slipped every guard above it throws instead of
 * landing. A reader never applies schema — outcome 3 becomes a refusal — which is also what closes
 * the fresh-database race two processes used to have: the writer claim precedes this call, so
 * exactly one process can ever be in the stamping branch. The file may legitimately not exist yet
 * (the writer claimed the root moments ago and is still creating it), so the reader waits briefly
 * for the file before refusing; `waitMs` exists so tests can wait not at all.
 */
export function openDb(
  dbPath: string,
  opts: { readonly?: boolean; waitMs?: number } = {},
): Database {
  if (opts.readonly) return openReadonly(dbPath, opts.waitMs ?? READONLY_WAIT_MS);

  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true, strict: false });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

  const appId = pragmaInt(db, "application_id");
  const version = pragmaInt(db, "user_version");

  if (appId === APPLICATION_ID) {
    if (version === SCHEMA_VERSION) return db;
    db.close();
    throw new DatabaseRefused(
      `${dbPath} carries schema version ${version}, and this build reads version ` +
        `${SCHEMA_VERSION} only. There is no migration by design — the stamp names a table shape, ` +
        `not just a set of column names — so nothing here will read it. Move the file aside (its ` +
        `journal siblings too), or point --var-dir somewhere else, and start fresh.`,
    );
  }

  if (appId === 0 && version === 0 && tableCount(db) === 0) {
    applySchema(db);
    return db;
  }

  db.close();
  throw new DatabaseRefused(
    `${dbPath} was not written by this application. It carries someone else's stamp, or tables ` +
      `this build never wrote, and there is no migration from a shape nothing here has a ` +
      `definition for. Move or delete the file (its journal siblings too), or point --var-dir ` +
      `somewhere else, and start again.`,
  );
}

/** How long a reader waits for a database the writer is presumably still creating. Short enough
 * that a genuinely absent file refuses while the boot is still being watched; long enough to cover
 * the writer's claim→stamp window. */
const READONLY_WAIT_MS = 3000;

function openReadonly(dbPath: string, waitMs: number): Database {
  const deadline = Date.now() + waitMs;
  while (!existsSync(dbPath)) {
    if (Date.now() >= deadline) {
      throw new DatabaseRefused(
        `${dbPath} does not exist yet. Another yewreview process holds this var root's write ` +
          `claim and is presumably still creating it — wait a moment and start this one again, ` +
          `or point --var-dir somewhere else.`,
      );
    }
    Bun.sleepSync(50);
  }

  const db = new Database(dbPath, { readonly: true, strict: false });
  // No `journal_mode = WAL` here: the writer set it when it created the file, it is a property of
  // the file, and a read-only connection asking to change it is a write. The other two pragmas are
  // per-connection and harmless.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

  const appId = pragmaInt(db, "application_id");
  const version = pragmaInt(db, "user_version");
  if (appId === APPLICATION_ID && version === SCHEMA_VERSION) return db;

  db.close();
  if (appId === 0 && version === 0) {
    // The writer is mid-creation, or the file is somebody's empty stray. A reader never stamps —
    // that is the writer's one privilege — so either way the answer is the same sentence.
    throw new DatabaseRefused(
      `${dbPath} is not stamped yet. The process holding this var root's write claim is ` +
        `presumably still creating it — wait a moment and start this one again.`,
    );
  }
  throw new DatabaseRefused(
    `${dbPath} carries schema version ${version}, and this build reads version ` +
      `${SCHEMA_VERSION} only. There is no migration by design, and a read-only process will not ` +
      `touch it — move the file aside from the writing process, or point --var-dir somewhere else.`,
  );
}

/** Apply the schema and both header stamps in one transaction — DDL and identity land together, so
 * a file can never be stamped as a version whose tables it does not have. */
function applySchema(db: Database): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA_V1);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
