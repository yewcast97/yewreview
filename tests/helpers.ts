/**
 * Shared test scaffolding: a real database and a real `var/` tree, both in a temp directory that
 * dies with the test. Nothing here mocks SQLite — the schema's CHECKs, triggers and cascades ARE
 * most of what the repositories promise, so a fake would test the wrong thing.
 *
 * EVERY RECORD TABLE NOW OPENS WITH `name`, unique within that table and nowhere wider, so every
 * seed below writes one. Where the caller supplies a human string it goes in VERBATIM — these rows
 * are read back through labels that embed one another (`of margins hold`, `in Semis`), and a
 * generated `th-4k7p` in the middle of a failing assertion says nothing. A repeat is distinguished
 * with a number rather than left to abort on the unique index, because a fixture called twice in one
 * harness is an ordinary thing for a test to do. Where no human string exists — a measurement,
 * one round of a ledger, a recorded command — the name is generated: nothing reads it and it only
 * has to be unique.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { openDb } from "../src/db/open.ts";
import { ensureDirs, loadSettings, type Settings } from "../src/config.ts";
import { newId, nowMs } from "../src/db/tx.ts";

export type Harness = {
  db: Database;
  settings: Settings;
  varDir: string;
  /** Write a file under var/, creating parents. Returns the var-relative POSIX path. */
  putFile(relPath: string, contents: string): string;
  cleanup(): void;
};

export function harness(): Harness {
  const varDir = mkdtempSync(join(tmpdir(), "yewreview-test-"));
  const settings = loadSettings({ varDir });
  ensureDirs(settings);
  const db = openDb(resolve(varDir, "db/yewreview.sqlite"));
  return {
    db,
    settings,
    varDir,
    putFile(relPath: string, contents: string) {
      const abs = resolve(varDir, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
      return relPath;
    },
    cleanup() {
      db.close();
      rmSync(varDir, { recursive: true, force: true });
    },
  };
}

/**
 * The name a seed writes: the string the caller asked for, or that string with a number after it
 * when this table already holds one.
 *
 * Not `mintName`: that slugifies, and a fixture whose `Semis` came back as `semis` would make every
 * label assertion downstream a statement about the minting rule rather than about the label.
 */
function freeName(db: Database, table: string, wanted: string): string {
  const holds = (name: string) =>
    db.query(`SELECT 1 AS one FROM ${table} WHERE name = ?`).get(name) !== null;
  if (!holds(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted} ${n}`;
    if (!holds(candidate)) return candidate;
  }
}

/** A recipe, for tests that need something to publish under but do not care which. Active, because
 * a recipe is born active and the trigger says so. */
export function seedRecipe(db: Database, name = "Test recipe", content = "Write a report."): string {
  const id = newId();
  const t = nowMs();
  db.query(
    "INSERT INTO recipe (name, id, content, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
  ).run(freeName(db, "recipe", name), id, content, t, t);
  return id;
}

/** A bare thesis container, for tests that need something to judge or to point at. No assessment:
 * an unjudged thesis is a real state, and a test that wants a tag files one with `seedAssessment`. */
export function seedThesis(
  db: Database,
  name = "Test thesis",
  content = "Something measurable.",
): string {
  const id = newId();
  db.query(
    `INSERT INTO thesis (name, id, content, dsl_json, dsl_hash, created_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run(freeName(db, "thesis", name), id, content, "a".repeat(64), nowMs());
  return id;
}

/** One row of a thesis's ledger, written straight in. `at` is exposed because the newest row is
 * what every rule reads, and a test proving that needs to be able to order two of them. */
export function seedAssessment(
  db: Database,
  thesisId: string,
  tag = "insightful",
  at = nowMs(),
): string {
  const id = newId();
  db.query(
    `INSERT INTO thesis_assessment (name, id, thesis_id, tag, assessment, seikan_report, created_at)
     VALUES ('asm-' || lower(hex(randomblob(5))), ?, ?, ?, 'Measured once and it held.', '{"cells": []}', ?)`,
  ).run(id, thesisId, tag, at);
  return id;
}

/**
 * An instrument. The NAME is required — a target's is the official full name, the one exemption in
 * this database's naming rule — and it is written at INSERT because nothing can move it afterwards:
 * `target_name_is_immutable` aborts every UPDATE that names the column.
 */
export function seedTarget(db: Database, ticker = "AAPL", name = `${ticker} Inc.`): string {
  db.query("INSERT OR IGNORE INTO target (name, ticker, added_at) VALUES (?, ?, ?)").run(
    name,
    ticker,
    nowMs(),
  );
  return ticker;
}

/**
 * A source to cite, and the hostnames it publishes at.
 *
 * `name` is written to BOTH columns it could be: the row's name, and `source` — the site itself,
 * which is what the card draws as the label. They are two different uniqueness rules over the same
 * string here, which is exactly what a fixture wants: one argument, and a second call cannot break
 * either of them.
 *
 * `issuer_primary` for no reason beyond being a plausible one — no rule turns on the type, and this
 * fixture never moves one, so a test that wants another kind seeds it as that kind rather than
 * changing this one.
 *
 * `hosts` is a parameter and not a constant because publishing checks it: a material's url has
 * to be on the cited source's list, so a test about citations has to be able to say where its
 * source publishes. It is bound as JSON text, the way the column holds it, since this fixture goes
 * straight past `createSource` and therefore past `normalizeHosts` — which is deliberate, because a
 * test wanting to know what normalization does calls that function rather than reading it back out
 * of a row.
 */
export function seedSource(
  db: Database,
  name = "Apple IR",
  hosts: string[] = ["investor.apple.com"],
): string {
  const id = newId();
  const t = nowMs();
  const site = freeName(db, "information_source", name);
  db.query(
    `INSERT INTO information_source
       (name, id, source, type, domain, method, hosts, created_at, updated_at)
     VALUES (?, ?, ?, 'issuer_primary', 'filings', 'browse the investor relations site', ?, ?, ?)`,
  ).run(site, id, site, JSON.stringify(hosts), t, t);
  return id;
}

/**
 * One command in a report's shell history, straight into the table.
 *
 * One of three — `seedScriptRun` and `seedSeikanRun` are the others — because almost every test
 * that needs a report to have DONE something needs it to have done one of exactly these three
 * things. They go past `recordReport` on purpose: a test about what a standing row holds down
 * should not have to publish a document to get one, and a test about publishing calls the real
 * path.
 */
export function seedShellRun(
  db: Database,
  reportId: string,
  command = "ls -la",
  at = nowMs(),
  exitCode = 0,
): string {
  const id = newId();
  db.query(
    `INSERT INTO trivial_shell_history_for_report
       (name, id, report_id, command, "return", exit_code, duration_ms, created_at)
     VALUES ('sh-' || lower(hex(randomblob(5))), ?, ?, ?, 'total 0', ?, 12, ?)`,
  ).run(id, reportId, command, exitCode, at);
  return id;
}

/**
 * One recorded measurement, straight into the table.
 *
 * The default command line is a real one: the engine is spawned by absolute path out of the venv,
 * so a fixture that said `seikan run ...` would be testing against a line this installation never
 * produces.
 */
export function seedSeikanRun(
  db: Database,
  reportId: string,
  command = "/opt/venv/bin/seikan run thesis.json --report-out report.json --data NVDA=data/nvda.csv",
  at = nowMs(),
  exitCode = 0,
): string {
  const id = newId();
  db.query(
    `INSERT INTO seikan_invocation
       (name, id, report_id, command, "return", exit_code, duration_ms, created_at)
     VALUES ('sk-' || lower(hex(randomblob(5))), ?, ?, ?, '{"cells": []}', ?, 1200, ?)`,
  ).run(id, reportId, command, exitCode, at);
  return id;
}

/** One recorded run of a stored script, straight into the table. */
export function seedScriptRun(
  db: Database,
  reportId: string,
  scriptId: string,
  argument = "--full",
  at = nowMs(),
  exitCode = 0,
): string {
  const id = newId();
  db.query(
    `INSERT INTO script_invocation
       (name, id, report_id, script_id, argument, "return", exit_code, duration_ms,
        created_at)
     VALUES ('run-' || lower(hex(randomblob(5))), ?, ?, ?, ?, 'done', ?, 34, ?)`,
  ).run(id, reportId, scriptId, argument, exitCode, at);
  return id;
}
