/**
 * One writer per var root, decided at boot and held for the life of the process.
 *
 * Two yewreview processes pointed at one `--var-dir` share the database, the agent home, the venv
 * and the transcript stores, and nothing about SQLite makes that safe to WRITE from twice: the
 * generation gate and the archive freeze are in-memory, so a second process could move rows under
 * a report the first was reading. The rule here is the simple one: the first process to boot on a
 * root holds the pen for as long as it runs, and every other process on that root is read-only for
 * its whole life. The decision is made ONCE, here, before the archive is opened — there is no later
 * promotion, because a process that silently became the writer mid-life would be a mode nobody was
 * told about. A restart is the answer, and every refusal downstream says so.
 *
 * THE LOCK IS A DATABASE, NOT A PIDFILE. The claim is `BEGIN IMMEDIATE` on a dedicated lock file,
 * held open and never committed: SQLite's write lock, which the KERNEL releases the moment the
 * process dies — cleanly, on a crash, or under `kill -9`. A pidfile would need staleness detection
 * and a repair path, and this codebase refuses repair paths by doctrine (`open.ts`); a lock the OS
 * itself lets go of cannot be stale. The transaction writes nothing, so holding it costs no I/O and
 * needs no table — a zero-byte file locks fine — and the file stays in default rollback-journal
 * mode because WAL would add `-wal`/`-shm` siblings for no benefit. Probes use `busy_timeout = 0`:
 * the answer is known immediately, not after a five-second wait.
 *
 * TWO CONNECTIONS IN ONE PROCESS CONTEND THE SAME WAY TWO PROCESSES DO. POSIX advisory locks are
 * per-process, which would make an in-process test a lie — except SQLite's unix VFS keeps a
 * per-inode lock table precisely so its own connections serialize against each other before fcntl
 * is ever consulted. `tests/writerLock.test.ts` pins both: the in-process refusal, and a spawned
 * subprocess getting the identical `SQLITE_BUSY`.
 *
 * THE HANDLE MUST BE RETAINED. A garbage-collected `Database` is a finalized one, and a finalized
 * handle is a released lock. The `WriterClaim` closes over it, and `main.ts` keeps the claim in its
 * shutdown closure for the life of the process — that reference is the lock.
 *
 * AUTHORITY IS THE PROCESS'S, NEVER A CALLER'S. Every tool call from anywhere in the process tree —
 * the SDK session, any subagent it dispatches, the opencode child — executes in this server process,
 * through the one `announcing()` wrapper whose `ToolDeps.mode` was set from this claim at boot. No
 * caller identity reaches the tool layer at all, so a subagent writes with exactly the main agent's
 * pen, and a reader's subagents are refused exactly as its main agent is.
 *
 * WHAT READ-ONLY DOES NOT COVER, said plainly rather than papered over: the guarantee is about the
 * DATABASE. A reader's window gets no `records_changed` pokes from the writer — the two processes
 * have separate event hubs — so its record browser refreshes on its own navigation; the rows it
 * reads are never stale (WAL readers see the latest commit), only the push is absent. And a
 * reader's agent still has a shell that may write `var/home`, because the OS sandbox is not
 * mode-aware; what it can never do is reach the archive, which its tools refuse and its read-only
 * connection could not honour anyway.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Which side of the claim this process came out on. Fixed at boot, for life. */
export type ProcessMode = "writer" | "reader";

export type WriterClaim = {
  readonly mode: ProcessMode;
  /**
   * Give the pen back: roll back the held transaction and close the handle, so the next boot on
   * this root claims it. A no-op for a reader, and idempotent — shutdown paths and tests both call
   * it without checking first.
   */
  release(): void;
};

/**
 * What the writer wrote about itself, for banners and refusal prose only.
 *
 * NEVER AUTHORITY. The lock decides who writes; this file is the sentence's way of naming the
 * process that holds it. It is overwritten by every writer boot and deleted by nobody, so it can
 * describe a writer that has since exited — which is fine, because nothing consults it to decide
 * anything.
 */
export type WriterNote = { pid: number; startedAt: number };

/**
 * Claim the pen for this var root, or learn another process holds it.
 *
 * `SQLITE_BUSY` is the one refusal that means "reader"; anything else — a directory that cannot be
 * made, a file that is not a database — rethrows, because it is a broken installation rather than
 * an answer. The code check is the `isUniqueViolation` precedent (`repo/sources.ts`): bun:sqlite
 * puts SQLite's own result name on the error.
 */
export function claimWriter(lockPath: string): WriterClaim {
  mkdirSync(dirname(lockPath), { recursive: true });
  const lock = new Database(lockPath, { create: true, strict: false });
  lock.exec("PRAGMA busy_timeout = 0");
  try {
    lock.exec("BEGIN IMMEDIATE");
  } catch (err) {
    if ((err as { code?: string }).code === "SQLITE_BUSY") {
      lock.close();
      return { mode: "reader", release: () => {} };
    }
    lock.close();
    throw err;
  }
  let released = false;
  return {
    mode: "writer",
    release: () => {
      if (released) return;
      released = true;
      try {
        lock.exec("ROLLBACK");
      } catch {
        /* a lock we cannot roll back is released by the close below, or by the kernel */
      }
      lock.close();
    },
  };
}

/** Write who holds the pen. Called by the writer, immediately after claiming. */
export function writeWriterNote(notePath: string): void {
  writeFileSync(notePath, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
}

/** Read who holds the pen, or null when the note is absent or unreadable — the sentences it feeds
 * simply go without the pid then. */
export function readWriterNote(notePath: string): WriterNote | null {
  let raw: string;
  try {
    raw = readFileSync(notePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const pid = (parsed as { pid?: unknown }).pid;
    const startedAt = (parsed as { startedAt?: unknown }).startedAt;
    if (typeof pid !== "number" || typeof startedAt !== "number") return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}
