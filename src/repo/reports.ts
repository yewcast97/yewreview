/**
 * Published reports — the HTML a procedure actually produced, and the recipe it was written under.
 *
 * **The row IS the document.** `content` holds the published bytes, so there is no file to go
 * missing, no digest to check them against and no sweep to make the table honest about a disk it no
 * longer says anything about. A report row and the report are one thing, and `reports_are_immutable`
 * makes "a publication does not change" true of the database rather than of whichever code path
 * happened to write. Publishing is always a new document; there is no revision.
 *
 * The bytes come back through `getReportContent` and through nothing else. Every other read here —
 * cards, briefs, links — enumerates its columns and leaves `content` out, because a listing that
 * carried the document would ship megabytes of HTML to draw a row of titles.
 *
 * **A publication is one act, and NOTHING IN IT IS THE MODEL'S ACCOUNT OF ITSELF.** Three tables
 * hang off a report and all are written HERE, in the transaction that records it, rather than by
 * repositories of their own: `script_invocation` names the stored programs that ran,
 * `seikan_invocation` the measurements — its output kept whole — and
 * `trivial_shell_history_for_report` every other command. They follow the `regime` precedent — no
 * module, no tool and no endpoint of their own — because there is no moment at which declaring one
 * is a separate act from publishing the document it is about. An id naming nothing takes the whole
 * publication down rather than leaving a report that half-declares its own foundations.
 *
 * A report used to carry two more: the readings it said it applied, and the sentences it said it
 * had quoted from where. Both were the model's word. Nothing fetched a cited page or compared a
 * quoted sentence against it, and the checks that did exist — the anchor is in the bytes, the
 * hostname is one the named source publishes at — proved only that the account was internally
 * consistent, which is not the thing a reader would take it for. So they are gone, and with them
 * the deletion guards they implied: a thesis or a source can now be deleted whatever has been
 * written near it, and the deletion log is the witness.
 *
 * **What is left is what a machine watched happen.** All three run tables come from the log the
 * generation procedure kept while the report was produced, which is why each row carries a moment
 * of its own rather than the report's restated: the moment is the RUN's. Each also carries how long
 * it took, the code it exited with, and what it printed. A command that failed is recorded exactly
 * as carefully as one that worked — a report leaning on a failed run is precisely what an auditor
 * is looking for — and during a procedure the shell has one door, so a command that ran and left no
 * row is a command that was refused rather than a gap.
 *
 * Deletion is rows and only rows. It takes the document with it because the document is one of the
 * rows, and there is nothing left over for a caller to unlink afterwards.
 */

import type { Database } from "bun:sqlite";

import type { ReportCard, ScriptRunBrief, SeikanRunBrief, ShellRunBrief } from "../db/models.ts";
import { Refused } from "../db/models.ts";
import { newId, nowMs, tx } from "../db/tx.ts";
import { logDeletion } from "./logs.ts";
import { mintName } from "./naming.ts";

/**
 * What every recorded command carries, whichever table it lands in.
 *
 * `at` is when it STARTED and `durationMs` how long it took, which together say when it finished
 * without a second clock to disagree with the first. `return` is what it printed; '' is an answer,
 * because a silent command said nothing and that is different from nobody having looked.
 */
type RunOutcomeColumns = {
  at: number;
  return: string;
  exitCode: number;
  durationMs: number;
};

/** One run of a stored script, off the generation log: which program, what it was told, what
 * happened. */
export type ScriptRunEntry = RunOutcomeColumns & { scriptId: string; argument: string };

/** One run of the measurement engine, off the same log. Recorded as the line that ran — the table
 * it lands in is what says it was a measurement. */
export type SeikanRunEntry = RunOutcomeColumns & { command: string };

/** Every other command the procedure ran, off the same log. The line is all there is to name it
 * by — there is no stored program for it to point at. */
export type ShellRunEntry = RunOutcomeColumns & { command: string };

/**
 * Everything a publication records having done. Every list is optional, and none is a SET: the
 * same program legitimately runs twice, and twice with the SAME argument is a fact about the
 * procedure worth keeping.
 *
 * Absent and empty mean the same thing here: nothing ran, or nothing was logged. Every publish
 * writes its parts from scratch, so "leave what was there" is not a state this type could express
 * even if it wanted to.
 */
export type ReportDeclarations = {
  /** The script runs the generation log recorded. */
  scriptRuns?: readonly ScriptRunEntry[] | undefined;
  /** The measurements that same log recorded. */
  seikanRuns?: readonly SeikanRunEntry[] | undefined;
  /** Every other command that same log recorded. */
  shellRuns?: readonly ShellRunEntry[] | undefined;
};

/** The other side of the same tables, hydrated for a reader: what one report stands on. */
export type ReportLinks = {
  scriptRuns: ScriptRunBrief[];
  seikanRuns: SeikanRunBrief[];
  shellRuns: ShellRunBrief[];
};

/**
 * Record `content` as the report `title`, written under `recipeId`.
 *
 * The document is stored, not described: nothing has to exist anywhere else first, and no ordering
 * between a write and a row can go wrong, because there is only the row. A report is immutable once
 * this returns, so everything it is going to say — the HTML, the title, and every declaration —
 * arrives in this one call.
 *
 * `declarations` are written here and nowhere else, inside this transaction, so an id naming
 * nothing takes the whole publication down rather than leaving a report that half-declares its own
 * foundations.
 */
export function recordReport(
  db: Database,
  recipeId: string,
  title: string,
  content: string,
  declarations: ReportDeclarations = {},
): ReportCard {
  const name = title.trim();
  if (name === "") {
    throw new Refused("invalid_request", "a report needs a title; it is what a reader picks it by");
  }
  // The bytes are stored exactly as passed — untrimmed — because the claim anchors are searched for
  // in them and a reader is served them; only the emptiness test looks past the whitespace.
  if (typeof content !== "string" || content.trim() === "") {
    throw new Refused(
      "invalid_request",
      "a report needs its document; pass the published HTML as content — the row is the report, " +
        "not a description of one kept somewhere else",
    );
  }
  return tx(db, () => {
    const recipe = db
      .query<{ id: string }, [string]>("SELECT id FROM recipe WHERE id = ?")
      .get(recipeId);
    if (!recipe) {
      throw new Refused(
        "not_found",
        `no recipe ${recipeId}; a report names the exact specification that wrote it`,
      );
    }
    const id = newId();
    db.query(
      "INSERT INTO report (id, name, recipe_id, title, content, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, mintName(db, "report", name), recipeId, name, content, nowMs());
    declareRuns(db, id, declarations);
    return getReport(db, id)!;
  });
}

/**
 * Write what the procedure ran, from the generation log rather than from anything a caller wrote
 * down.
 *
 * Not sets: the same program run twice is two runs, and flattening them would understate what the
 * report actually did. Insertion order is the log's order, which is the order things happened.
 *
 * Every field is checked rather than defaulted, and the moments are the sharp ones. `at` is
 * required: a log entry with no moment is a run nobody logged, which is precisely the state these
 * tables exist to make unrepresentable, so a missing or nonsensical one is refused rather than
 * filled in from the report's own clock. `exitCode` and `durationMs` are refused the same way, for
 * the smaller version of the same reason — a zero invented here would read afterwards as a command
 * that succeeded instantly.
 */
function declareRuns(db: Database, reportId: string, declarations: ReportDeclarations): void {
  const scripts = list(declarations.scriptRuns, "script_invocations");
  const insertScript = db.query(
    'INSERT INTO script_invocation (id, name, report_id, script_id, argument, ' +
      '"return", exit_code, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const run of scripts) {
    const scriptId = trimmed(run, "scriptId");
    if (scriptId === "") {
      throw new Refused(
        "invalid_request",
        "each script invocation names the script that ran; list_scripts shows the ids",
      );
    }
    const argument = (run as { argument?: unknown }).argument;
    if (typeof argument !== "string") {
      throw new Refused(
        "invalid_request",
        'each invocation carries the argument it was run with; pass "" when it took none',
      );
    }
    // Existence only: scripts are global, so a program another conversation recorded is a perfectly
    // good answer to "what produced these numbers". The foreign key would refuse an invented id
    // anyway; this is what turns that into a sentence naming the tool that lists them.
    // The name comes back as well as the existence, because it is what this run's label is minted
    // from — a run is named after the program it ran.
    const script = db
      .query<{ name: string }, [string]>("SELECT name FROM script WHERE id = ?")
      .get(scriptId);
    if (!script) {
      throw new Refused(
        "not_found",
        `no script ${scriptId}; list_scripts shows the ones a report can record running`,
      );
    }
    insertScript.run(
      newId(),
      mintName(db, "script_invocation", script.name),
      reportId,
      scriptId,
      argument,
      output(run),
      exitCode(run),
      durationMs(run),
      moment(run),
    );
  }

  const seikans = list(declarations.seikanRuns, "seikan_invocations");
  const insertSeikan = db.query(
    'INSERT INTO seikan_invocation (id, name, report_id, command, ' +
      '"return", exit_code, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const run of seikans) {
    const command = trimmed(run, "command");
    if (command === "") {
      throw new Refused(
        "invalid_request",
        "each recorded measurement carries the engine command line that ran; a blank one records nothing",
      );
    }
    insertSeikan.run(
      newId(),
      // Named after the program invoked, exactly as a shell line is — and every program in this
      // table is the engine, so the name says so in a word rather than repeating the venv path the
      // command line happens to begin with.
      mintName(db, "seikan_invocation", "seikan"),
      reportId,
      command,
      output(run),
      exitCode(run),
      durationMs(run),
      moment(run),
    );
  }

  const shell = list(declarations.shellRuns, "shell_commands");
  const insertShell = db.query(
    'INSERT INTO trivial_shell_history_for_report (id, name, report_id, command, ' +
      '"return", exit_code, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const run of shell) {
    const command = trimmed(run, "command");
    if (command === "") {
      throw new Refused(
        "invalid_request",
        "each recorded command carries the line that ran; a blank one records nothing",
      );
    }
    insertShell.run(
      newId(),
      // Named after the program invoked rather than the whole line: `curl` is what a reader is
      // scanning for, and the rest of a command line is arguments and quoting.
      mintName(db, "trivial_shell_history_for_report", command.split(/\s+/)[0] ?? command),
      reportId,
      command,
      output(run),
      exitCode(run),
      durationMs(run),
      moment(run),
    );
  }
}

/** What a run printed. Any string is an answer, '' included; anything else is a caller that did not
 * finalize its log entry. */
function output(run: unknown): string {
  const value = (run as { return?: unknown }).return;
  if (typeof value !== "string") {
    throw new Refused(
      "invalid_request",
      "each recorded command carries what it printed, off the generation run log; a command with " +
        'no output recorded is one nobody watched. Pass "" when it printed nothing',
    );
  }
  return value;
}

/** The code a run exited with. Any integer, negative included — a killed process is a real
 * outcome. */
function exitCode(run: unknown): number {
  const value = (run as { exitCode?: unknown }).exitCode;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Refused(
      "invalid_request",
      "each recorded command carries the code it exited with, off the generation run log",
    );
  }
  return value;
}

/** How long a run took. Zero is legitimate; negative is not a duration. */
function durationMs(run: unknown): number {
  const value = (run as { durationMs?: unknown }).durationMs;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Refused(
      "invalid_request",
      "each recorded command carries how long it took in milliseconds, off the generation run log",
    );
  }
  return value;
}

/** The moment a logged run happened, refused rather than defaulted. */
function moment(run: unknown): number {
  const at = (run as { at?: unknown }).at;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) {
    throw new Refused(
      "invalid_request",
      "each invocation carries the moment it ran, in epoch milliseconds, off the generation run " +
        "log; an invocation with no moment is a run nobody logged",
    );
  }
  return at;
}

/** One declared string field, trimmed, with anything that is not a string read as absent. The
 * caller decides what a missing one means; this only refuses to guess. */
function trimmed(entry: unknown, field: string): string {
  const value = (entry as Record<string, unknown>)[field];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A declared list, shape-checked rather than assumed.
 *
 * The type says list-of-objects and a well-behaved client's schema says so too, but this runs inside
 * the publish transaction: something that is not a list would otherwise leave the tool through a
 * TypeError, which reaches the model as a crash it cannot read instead of a sentence naming the
 * argument it got wrong.
 */
function list<T>(items: readonly T[] | undefined, field: string): readonly T[] {
  if (items === undefined) return [];
  if (!Array.isArray(items) || items.some((item) => typeof item !== "object" || item === null)) {
    throw new Refused(
      "invalid_request",
      `${field} is a list; pass one entry per element, or leave it out to declare nothing`,
    );
  }
  return items;
}

/**
 * What one report's procedure actually ran.
 *
 * Three queries rather than one, because they answer to three different tables and a joined row
 * would be a cross product of them. All read by the moment the command RAN, which is the order
 * things actually happened and the whole reason these rows have a clock of their own; `rowid`
 * breaks the tie for two commands that started inside the same millisecond.
 */
export function reportLinks(db: Database, reportId: string): ReportLinks {
  const scriptRuns = db
    .query<ScriptRunBrief, [string]>(
      `SELECT si.id, si.script_id, sc.name AS script_name, si.argument,
              si."return" AS "return", si.exit_code, si.duration_ms, si.created_at
         FROM script_invocation si
         JOIN script sc ON sc.id = si.script_id
        WHERE si.report_id = ?
        ORDER BY si.created_at, si.rowid`,
    )
    .all(reportId);

  const seikanRuns = db
    .query<SeikanRunBrief, [string]>(
      `SELECT sk.id, sk.command, sk."return" AS "return", sk.exit_code, sk.duration_ms,
              sk.created_at
         FROM seikan_invocation sk
        WHERE sk.report_id = ?
        ORDER BY sk.created_at, sk.rowid`,
    )
    .all(reportId);

  const shellRuns = db
    .query<ShellRunBrief, [string]>(
      `SELECT sh.id, sh.command, sh."return" AS "return", sh.exit_code, sh.duration_ms,
              sh.created_at
         FROM trivial_shell_history_for_report sh
        WHERE sh.report_id = ?
        ORDER BY sh.created_at, sh.rowid`,
    )
    .all(reportId);

  return { scriptRuns, seikanRuns, shellRuns };
}

export function getReport(db: Database, id: string): ReportCard | null {
  return db.query<ReportCard, [string]>(`${CARD_SQL} WHERE r.id = ?`).get(id);
}

/**
 * The published document itself, and the only door to it.
 *
 * It is a query of its own rather than a column on the card because every other read of this table
 * is index-sized and this one is not: a listing that carried the document would ship megabytes of
 * HTML to draw a row of titles. Only the route that serves a report to a reader calls this.
 */
export function getReportContent(db: Database, id: string): string | null {
  return (
    db
      .query<{ content: string }, [string]>("SELECT content FROM report WHERE id = ?")
      .get(id)?.content ?? null
  );
}

/** Reports newest first, optionally narrowed to the ones written under one recipe. */
export function listReports(
  db: Database,
  filter: { recipeId?: string | undefined } = {},
): ReportCard[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.recipeId !== undefined) {
    clauses.push("r.recipe_id = ?");
    params.push(filter.recipeId);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return db
    .query<ReportCard, string[]>(`${CARD_SQL}${where} ORDER BY r.created_at DESC, r.id DESC`)
    .all(...params);
}

/**
 * Forget a report — the document, its declarations, its invocation record, all of it, and nothing
 * left behind to clean up afterwards. False when there was no such report, because "it is not there" is the
 * state the caller was asking for and not an error.
 *
 * The whole row goes to the deletion log, `content` included, so what is witnessed is the document
 * that was published rather than a note that some document was. That is the expensive branch of the
 * "log the whole row" decision — a report is the largest thing in this database — and it is the
 * branch worth paying for: a deleted publication whose bytes were not kept is a publication nobody
 * can ever check the deletion of.
 */
export function deleteReport(db: Database, id: string): boolean {
  return tx(db, () => {
    const row = db
      .query<Record<string, string | number | null>, [string]>("SELECT * FROM report WHERE id = ?")
      .get(id);
    if (row === null) return false;

    db.query("DELETE FROM report WHERE id = ?").run(id);
    logDeletion(db, "report", id, row);
    return true;
  });
}

/**
 * Every column of a report card, spelled out. `r.*` is deliberately not used here: it would pull
 * `content` into every listing in the application, which is the one column this table has that no
 * caller of `getReport` or `listReports` wants and every one of them would pay for.
 */
const CARD_SQL = /* sql */ `
SELECT r.id, r.name, r.recipe_id, r.title, r.created_at,
       rc.name AS recipe_name,
       (SELECT COUNT(*) FROM script_invocation si WHERE si.report_id = r.id)
         AS script_invocation_count,
       (SELECT COUNT(*) FROM seikan_invocation sk WHERE sk.report_id = r.id)
         AS seikan_invocation_count,
       (SELECT COUNT(*) FROM trivial_shell_history_for_report sh WHERE sh.report_id = r.id)
         AS shell_command_count
  FROM report r
  JOIN recipe rc ON rc.id = r.recipe_id`;
