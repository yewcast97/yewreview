/**
 * The writer claim and the read-only open — `src/db/lock.ts` and the readonly branch of
 * `src/db/open.ts`.
 *
 * REAL SQLITE, REAL FILES, in a mkdtemp directory per test; nothing is mocked. Two connections in
 * one test process stand in for two processes, and the stand-in is faithful rather than
 * convenient: SQLite's unix VFS keeps a per-inode lock table precisely so its own connections
 * serialize against each other before fcntl is consulted, which gives an in-process second claim
 * the identical `SQLITE_BUSY` a second process gets. One test spawns a genuinely separate process
 * to pin that equivalence, because the whole feature rests on it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimWriter, readWriterNote, writeWriterNote } from "../src/db/lock.ts";
import { DatabaseRefused, openDb } from "../src/db/open.ts";
import { logError } from "../src/repo/logs.ts";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "yewreview-lock-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("one writer per var root", () => {
  test("the first claim on a root is the writer, and a second is a reader while it holds", () => {
    const { dir, cleanup } = tempDir();
    try {
      const lockPath = join(dir, "db/writer.lock.db");
      const first = claimWriter(lockPath);
      expect(first.mode).toBe("writer");

      // Decided immediately rather than after a busy wait: a boot must not stall five seconds to
      // learn what it is, so the probe runs at busy_timeout 0 and the elapsed time proves it.
      const asked = Date.now();
      const second = claimWriter(lockPath);
      expect(second.mode).toBe("reader");
      expect(Date.now() - asked).toBeLessThan(1000);

      // A reader's release is a no-op, and releasing it must not free the WRITER's claim.
      second.release();
      expect(claimWriter(lockPath).mode).toBe("reader");

      first.release();
    } finally {
      cleanup();
    }
  });

  test("a released claim frees the pen for the next boot, which is what a restart is", () => {
    const { dir, cleanup } = tempDir();
    try {
      const lockPath = join(dir, "writer.lock.db");
      const first = claimWriter(lockPath);
      first.release();
      // Idempotent: shutdown paths call it without checking, and a double release must not throw.
      first.release();

      const next = claimWriter(lockPath);
      expect(next.mode).toBe("writer");
      next.release();
    } finally {
      cleanup();
    }
  });

  test("the claim holds against a genuinely separate process", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const lockPath = join(dir, "writer.lock.db");
      const held = claimWriter(lockPath);
      expect(held.mode).toBe("writer");

      // The child speaks the same probe by hand rather than importing the module, so what is being
      // tested is the LOCK — a kernel fact about the file — and not the module agreeing with
      // itself in two processes.
      const probe = `
        import { Database } from "bun:sqlite";
        const db = new Database(${JSON.stringify(lockPath)}, { create: true, strict: false });
        db.exec("PRAGMA busy_timeout = 0");
        try {
          db.exec("BEGIN IMMEDIATE");
          console.log("acquired");
        } catch (err) {
          console.log("refused " + err.code);
        }
      `;
      const child = Bun.spawnSync(["bun", "-e", probe]);
      expect(child.stdout.toString().trim()).toBe("refused SQLITE_BUSY");

      held.release();
      const after = Bun.spawnSync(["bun", "-e", probe]);
      expect(after.stdout.toString().trim()).toBe("acquired");
    } finally {
      cleanup();
    }
  });

  test("the note names the writer for the banner, and is never the authority", () => {
    const { dir, cleanup } = tempDir();
    try {
      const notePath = join(dir, "writer.json");
      expect(readWriterNote(notePath)).toBeNull();
      writeWriterNote(notePath);
      const note = readWriterNote(notePath);
      expect(note?.pid).toBe(process.pid);
      // An unreadable note is an absent one — the sentence goes without the pid, nothing decides
      // anything by it.
      writeFileSync(notePath, "not json at all");
      expect(readWriterNote(notePath)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("the read-only database open", () => {
  test("a reader opens the writer's database and reads what it wrote, and a write throws", () => {
    const { dir, cleanup } = tempDir();
    try {
      const dbPath = join(dir, "db/yewreview.sqlite");
      const writer = openDb(dbPath);
      writer
        .query(
          "INSERT INTO recipe (name, id, content, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
        )
        .run("weekly", "rc-1", "Write it.", 1, 1);

      const reader = openDb(dbPath, { readonly: true, waitMs: 0 });
      expect(reader.query("SELECT name FROM recipe").get()).toEqual({ name: "weekly" });

      // The belt under the braces: the tool layer refuses first, and a write that slipped every
      // guard above still cannot land, because the CONNECTION is read-only.
      expect(() =>
        reader
          .query(
            "INSERT INTO recipe (name, id, content, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
          )
          .run("second", "rc-2", "No.", 2, 2),
      ).toThrow();
      expect(writer.query("SELECT COUNT(*) AS n FROM recipe").get()).toEqual({ n: 1 });

      // `logError` gives up into the console rather than throwing — the promise it makes everywhere
      // ("never throws") is the one the reader's 500 path depends on.
      expect(() => logError(reader, "http", "a defect in a read-only process")).not.toThrow();
      expect(writer.query("SELECT COUNT(*) AS n FROM error_log").get()).toEqual({ n: 0 });

      reader.close();
      writer.close();
    } finally {
      cleanup();
    }
  });

  test("a reader refuses a database that is not there yet, naming the writer's boot", () => {
    const { dir, cleanup } = tempDir();
    try {
      const missing = join(dir, "db/yewreview.sqlite");
      expect(() => openDb(missing, { readonly: true, waitMs: 0 })).toThrow(DatabaseRefused);
      expect(() => openDb(missing, { readonly: true, waitMs: 0 })).toThrow(/does not exist yet/);
    } finally {
      cleanup();
    }
  });

  test("a reader never applies schema, so a fresh file has one writer by construction", () => {
    const { dir, cleanup } = tempDir();
    try {
      // An empty file where the database should be: the writer mid-creation, as a reader booting a
      // moment behind it sees the world. Stamping it is the writer's one privilege, so the reader
      // refuses with the sentence that says wait — and the file is left exactly as it was.
      const dbPath = join(dir, "yewreview.sqlite");
      writeFileSync(dbPath, "");
      expect(() => openDb(dbPath, { readonly: true, waitMs: 0 })).toThrow(/not stamped yet/);

      // The writer then stamps it, and the same reader open now works.
      const writer = openDb(dbPath);
      const reader = openDb(dbPath, { readonly: true, waitMs: 0 });
      expect(reader.query("SELECT COUNT(*) AS n FROM recipe").get()).toEqual({ n: 0 });
      reader.close();
      writer.close();
    } finally {
      cleanup();
    }
  });
});
