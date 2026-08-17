/**
 * Published reports, against a real database and a real `var/` tree.
 *
 * Nothing here is faked. The CHECKs, the cascades and the six triggers over the three run tables ARE
 * most of what this repository promises, so the rules that matter are proved twice: once through the
 * refusal the repository raises, for the sentence it says, and once through SQL written by hand
 * straight past it, for the abort the database raises whatever the caller was.
 *
 * The document is a COLUMN, so the filesystem is checked for what it must NOT contain — a test that
 * only read the column back would pass just as happily against a copy on disk.
 *
 * What a publication records is only what a machine watched happen: three run tables, each row
 * carrying the moment its command started, how long it took, the code it exited with and what it
 * printed. A report used also to declare the readings it applied and the sentences it said it had
 * quoted from where, and several tests below pin the ABSENCE of those — no counts on the card, no
 * links to hydrate, no deletion guard standing over a thesis or a source. That absence is the
 * decision, so it is a test rather than a gap where a test used to be.
 *
 * THE RECIPE A REPORT NAMES IS PINNED HERE TOO, and it belongs here rather than in a file of its
 * own because the whole reason a recipe's text cannot be edited is what it would do to a report: a
 * document naming instructions that had changed underneath it would be stating a provenance nobody
 * could check. So the last describe below stands over the two triggers that carry what the playbook
 * ledger used to — a recipe is born active, and only its status moves — and over the listing order
 * a reader picks a live specification out of.
 */

import { test, expect, describe, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { Refused } from "../src/db/models.ts";
import { newId, nowMs } from "../src/db/tx.ts";
import {
  createRecipe,
  deleteRecipe,
  getRecipe,
  listRecipes,
  setRecipeStatus,
} from "../src/repo/recipes.ts";
import {
  deleteReport,
  getReport,
  getReportContent,
  listReports,
  recordReport,
  reportLinks,
} from "../src/repo/reports.ts";
import type {
  ReportDeclarations,
  ScriptRunEntry,
  SeikanRunEntry,
  ShellRunEntry,
} from "../src/repo/reports.ts";
import { createScript, deleteScript, setScriptStatus } from "../src/repo/scripts.ts";
import { deleteSource } from "../src/repo/sources.ts";
import { deleteThesis } from "../src/repo/theses.ts";
import {
  harness,
  seedAssessment,
  seedScriptRun,
  seedSeikanRun,
  seedShellRun,
  seedRecipe,
  seedSource,
  seedThesis,
  type Harness,
} from "./helpers.ts";

let h: Harness;
function fresh(): Harness {
  h = harness();
  return h;
}
afterEach(() => h?.cleanup());

function refusal(fn: () => unknown): Refused {
  try {
    fn();
  } catch (err) {
    if (err instanceof Refused) return err;
    throw err;
  }
  throw new Error("expected a refusal, got a result");
}

function count(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

/** The three tables a publication writes, named once so a test that means "and nothing survived"
 * cannot quietly check only part of what it published. */
const RUN_TABLES = [
  "script_invocation",
  "seikan_invocation",
  "trivial_shell_history_for_report",
] as const;

/**
 * A published document.
 *
 * Real HTML, but nothing reads INSIDE these bytes any more: publishing used to search the document
 * for the id of every passage a citation claimed to be anchored at, and there are no citations left
 * to anchor. The document is stored and served, and that is the whole of what happens to it.
 */
const DOC =
  `<h1>Q1 read-through</h1>\n` +
  `<p>The backlog covers two quarters.</p>\n` +
  `<p>Margins hold through the year.</p>\n`;

/**
 * A recorded script: one row, program included. It takes no recipe — scripts belong to the
 * installation, so "whose script is this" is not a question a report's provenance can ask.
 * `inactive` is reached by moving the status, because nothing is born inactive.
 *
 * The real `createScript`, so `name` here is a HINT and the row is filed under the name minted from
 * it: `their prices` becomes `their-prices`. What a run brief names the program by is that minted
 * name, which is why the assertions below spell the slug rather than the hint.
 */
function seedScript(db: Database, name: string, status = "active"): string {
  const script = createScript(db, { name, domain: "prices", source: `print("${name}")\n` });
  if (status !== "active") setScriptStatus(db, script.id, status as "active" | "inactive");
  return script.id;
}

/**
 * A complete script-run log entry, of the shape the publish tool hands over off the run log.
 *
 * Every field is required, which is exactly why the fixture is complete: a test that wants one
 * refused takes a field AWAY from something that would otherwise have been accepted, rather than
 * hand-building a half-entry and hoping the missing field is the one the refusal is about.
 */
function scriptRun(scriptId: string, over: Partial<ScriptRunEntry> = {}): ScriptRunEntry {
  return {
    scriptId,
    argument: "--ticker NVDA",
    at: nowMs(),
    return: "AAPL,187.4\n",
    exitCode: 0,
    durationMs: 431,
    ...over,
  };
}

/** The same, for a measurement. The line is the engine spawned by absolute path out of the venv,
 * which is what a real one looks like; its `return` is the engine's report, kept whole. */
function seikanRun(over: Partial<SeikanRunEntry> = {}): SeikanRunEntry {
  return {
    command: "/opt/venv/bin/seikan run 9f2c.json --report-out report.json --data close=nvda.csv",
    at: nowMs(),
    return: '{"cells": 4}\n',
    exitCode: 0,
    durationMs: 5_100,
    ...over,
  };
}

/** The same, for every other command. There is no stored program for one of these to point at, so
 * the line it ran is all there is to name it by. Deliberately NOT an engine line: measurements
 * have a table of their own again, and a fixture still telling the old story would be the one
 * place in this file that disagreed with the schema. */
function shellRun(over: Partial<ShellRunEntry> = {}): ShellRunEntry {
  return {
    command: "shasum -a 256 data/nvda.csv",
    at: nowMs(),
    return: "9f2c  data/nvda.csv\n",
    exitCode: 0,
    durationMs: 90,
    ...over,
  };
}

/** What every kind of entry carries, and therefore what all of them are checked for in one place. */
type Outcome = { at: number; return: string; exitCode: number; durationMs: number };

/** One bad field, in each of the three kinds. All go through the same four checks, so a rule proved
 * for only one of them would be a rule nobody had actually written down. */
function allKinds(scriptId: string, over: Partial<Outcome>): ReportDeclarations[] {
  return [
    { scriptRuns: [scriptRun(scriptId, over)] },
    { seikanRuns: [seikanRun(over)] },
    { shellRuns: [shellRun(over)] },
  ];
}

describe("a report row IS the published document", () => {
  test("the document round-trips byte for byte, and comes back by one door only", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    // Untrimmed, multi-line, and not ASCII: the bytes stored are the bytes a reader is served, so
    // nothing here may be normalised on the way in or on the way out.
    const document = `\n  <h1>營收</h1>\n  <p id="x">up 12%\t— "as reported"</p>\n\n`;
    const card = recordReport(db, recipe, "A", document);

    expect(getReportContent(db, card.id)).toBe(document);
    expect(getReportContent(db, "nope")).toBeNull();
  });

  test("a listing must not ship megabytes: no card carries the document", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const card = recordReport(db, recipe, "A", DOC);

    // Every reader of this table goes through CARD_SQL, which enumerates its columns precisely so
    // that the one column nobody drawing a row of titles wants is not in any of them.
    expect(card).not.toHaveProperty("content");
    expect(getReport(db, card.id)).not.toHaveProperty("content");
    expect(listReports(db)[0]).not.toHaveProperty("content");

    // And the row does hold it: the card is missing the document, not the database.
    expect(
      db.query<{ n: number }, [string]>("SELECT length(content) AS n FROM report WHERE id = ?")
        .get(card.id)!.n,
    ).toBe(DOC.length);
  });

  test("nothing has to exist on disk first, and nothing is left there afterwards", () => {
    const { db, varDir } = fresh();
    const recipe = seedRecipe(db);
    const card = recordReport(db, recipe, "A", DOC);
    expect(getReportContent(db, card.id)).toBe(DOC);

    // No path and no digest on the card, because there is no second copy for either to be about.
    expect(Object.keys(card)).not.toContain("path");
    expect(Object.keys(card)).not.toContain("sha256");
    // A published document has no filesystem life: only the static furniture lives under reports/.
    expect(readdirSync(resolve(varDir, "reports"))).toEqual(["assets"]);
  });

  test("a report with no document is refused: the row is not a description of one", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    for (const empty of ["", "   \n\t "]) {
      expect(refusal(() => recordReport(db, recipe, "A", empty)).message).toMatch(
        /a report needs its document/,
      );
    }
    expect(refusal(() => recordReport(db, recipe, "A", undefined as never)).kind).toBe(
      "invalid_request",
    );
    expect(listReports(db)).toEqual([]);
  });

  test("an empty title is refused; it is what a reader picks the document by", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    expect(refusal(() => recordReport(db, recipe, "  ", DOC)).message).toMatch(/a report needs a title/);
    expect(recordReport(db, recipe, "  Trimmed  ", DOC).title).toBe("Trimmed");
  });

  test("an unknown recipe is refused, so provenance cannot be invented", () => {
    const { db } = fresh();
    seedRecipe(db);
    expect(refusal(() => recordReport(db, "nope", "A", DOC)).message).toMatch(
      /a report names the exact specification that wrote it/,
    );
    expect(listReports(db)).toEqual([]);
  });

  test("a card carries the recipe it was written to, by id and by name, and three counts of nothing", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db, "Semis");
    const card = recordReport(db, recipe, "A", DOC);
    expect(card.recipe_id).toBe(recipe);
    // The name beside the id is the half a person reads, and it is the recipe's own — read through
    // the join rather than copied, so a rename moves it and the id it is beside does not.
    expect(card.recipe_name).toBe("Semis");
    // NO VERSION, and that is the change rather than an omission. A report used to name a playbook
    // version, a number a reader had to hold in their head to tell two rows of instructions apart;
    // a recipe's text cannot be edited, so naming the recipe names the exact words.
    expect(card).not.toHaveProperty("playbook_version");
    expect(card).not.toHaveProperty("workshop_id");
    // Three tables hang off a report, and a report whose procedure ran nothing says three zeroes
    // rather than leaving a reader to wonder which of them the card forgot to ask about.
    expect(card.script_invocation_count).toBe(0);
    expect(card.seikan_invocation_count).toBe(0);
    expect(card.shell_command_count).toBe(0);
    // And exactly three. The counts of what a report CLAIMED — the readings it applied, the
    // addresses it said it had quoted — went with the tables behind them, and those stay gone. The
    // engine's count is back, and it counts something different from what the earlier one did: not
    // measurements the model said it had made, but engine commands a machine watched run.
    for (const gone of ["application_count", "reference_count"]) {
      expect(card).not.toHaveProperty(gone);
    }
    expect(getReport(db, card.id)).toEqual(card);
  });

  test("publishing again is a second document, never a revision of the first", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    // Empty and absent are the same statement — nothing ran, or nothing was logged — so the draft
    // declaring an empty log is as complete a publication as the one that declares none.
    const draft = recordReport(db, recipe, "A", "<h1>draft</h1>", {
      scriptRuns: [],
      seikanRuns: [],
      shellRuns: [],
    });
    const final = recordReport(db, recipe, "A", "<h1>final</h1>");

    expect(final.id).not.toBe(draft.id);
    expect(getReportContent(db, draft.id)).toBe("<h1>draft</h1>");
    expect(getReportContent(db, final.id)).toBe("<h1>final</h1>");
    expect(listReports(db)).toHaveLength(2);
  });

  test("a published report cannot be updated, its document least of all", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const card = recordReport(db, recipe, "A", DOC);
    for (const [column, value] of [
      ["title", "'x'"],
      ["content", "'<h1>rewritten</h1>'"],
      ["recipe_id", "'x'"],
      ["created_at", "0"],
      ["id", "'x'"],
    ]) {
      expect(() =>
        db.query(`UPDATE report SET ${column} = ${value} WHERE id = ?`).run(card.id),
      ).toThrow(/immutable/);
    }
    expect(getReport(db, card.id)!.title).toBe("A");
    expect(getReportContent(db, card.id)).toBe(DOC);
  });
});

describe("the runs behind the numbers", () => {
  test("all three kinds of run are written, and read back in the order they happened", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const prices = seedScript(db, "prices");
    const filings = seedScript(db, "filings");
    const ran = nowMs() - 86_400_000;

    const card = recordReport(db, recipe, "A", DOC, {
      scriptRuns: [
        scriptRun(prices, { argument: "--ticker NVDA", at: ran }),
        // The same program with the SAME argument twice: two runs, and flattening them would
        // understate what the report actually did.
        scriptRun(prices, { argument: "--ticker NVDA", at: ran + 60_000 }),
        scriptRun(filings, { argument: "", at: ran + 30_000 }),
      ],
      // The engine IS a kind of its own again — not because the model says a command was a
      // measurement, but because the tool that spawns the engine is the one that records it.
      // What an earlier design got wrong was recording the request; what this records is the
      // line that ran.
      seikanRuns: [
        seikanRun({ at: ran + 90_000 }),
        seikanRun({ command: "/opt/venv/bin/seikan run 4b1e.json", at: ran + 45_000 }),
      ],
      shellRuns: [shellRun({ command: "ls -la data", at: ran + 15_000 })],
    });
    expect(card.script_invocation_count).toBe(3);
    expect(card.seikan_invocation_count).toBe(2);
    expect(card.shell_command_count).toBe(1);

    const links = reportLinks(db, card.id);
    // Three lists and no others: what a report SAID it stood on is not something there is a link to
    // hydrate any more.
    expect(Object.keys(links).sort()).toEqual(["scriptRuns", "seikanRuns", "shellRuns"]);

    // Read in the order things HAPPENED, which is what these rows have a clock of their own for.
    expect(links.scriptRuns.map((r) => r.created_at)).toEqual([ran, ran + 30_000, ran + 60_000]);
    expect(links.scriptRuns.map((r) => r.script_name)).toEqual(["prices", "filings", "prices"]);
    expect(links.seikanRuns.map((r) => r.created_at)).toEqual([ran + 45_000, ran + 90_000]);
    expect(links.shellRuns.map((r) => r.command)).toEqual(["ls -la data"]);
    // '' is an answer — a program run with no arguments — not a missing value.
    expect(links.scriptRuns[1]!.argument).toBe("");
    // And that clock is the RUN's, not the report's restated: this generation ran yesterday.
    expect(links.scriptRuns[0]!.created_at).toBeLessThan(card.created_at);
    expect(links.shellRuns[0]!.created_at).toBeLessThan(card.created_at);
  });

  test("two commands that started in the same millisecond keep the log's order", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const prices = seedScript(db, "prices");
    const at = nowMs();

    const card = recordReport(db, recipe, "A", DOC, {
      scriptRuns: [
        scriptRun(prices, { argument: "--first", at }),
        scriptRun(prices, { argument: "--second", at }),
      ],
      shellRuns: [
        shellRun({ command: "first", at }),
        shellRun({ command: "second", at }),
        shellRun({ command: "third", at }),
      ],
    });

    // A millisecond clock cannot separate commands issued this close together, so the tie is broken
    // by rowid — insertion order, which is the log's order, which is the order the procedure did
    // them in. Handed back in any other order these would describe a different procedure.
    const links = reportLinks(db, card.id);
    expect(links.shellRuns.map((r) => r.command)).toEqual(["first", "second", "third"]);
    expect(links.scriptRuns.map((r) => r.argument)).toEqual(["--first", "--second"]);
  });

  test("what a command DID is recorded as carefully as the fact that it ran", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const prices = seedScript(db, "prices");
    const at = nowMs();

    const card = recordReport(db, recipe, "A", DOC, {
      scriptRuns: [scriptRun(prices, { at, return: "AAPL,187.4\n", exitCode: 0, durationMs: 431 })],
      shellRuns: [
        shellRun({
          command: "curl -sS https://ir.example/q1",
          at: at + 1,
          return: "curl: (6) could not resolve host\n",
          exitCode: 6,
          durationMs: 12,
        }),
        // '' is an answer here too: a command that printed nothing said nothing, and that is a
        // different fact from nobody having looked. Zero milliseconds is likewise a duration.
        shellRun({ command: "true", at: at + 2, return: "", exitCode: 0, durationMs: 0 }),
        // A killed process is a real outcome, and the code it comes back with is not a positive
        // integer — a check that assumed one would refuse to record exactly the runs worth reading.
        shellRun({ command: "sleep 600", at: at + 3, return: "", exitCode: -9, durationMs: 600_000 }),
      ],
    });

    const links = reportLinks(db, card.id);
    // The whole brief, in one assertion, because it is the shape a reader is handed: which program,
    // what it was told, what it printed, how it went, and when it started.
    expect(links.scriptRuns[0]).toEqual({
      id: expect.any(String),
      script_id: prices,
      script_name: "prices",
      argument: "--ticker NVDA",
      return: "AAPL,187.4\n",
      exit_code: 0,
      duration_ms: 431,
      created_at: at,
    });
    expect(links.shellRuns[0]).toEqual({
      id: expect.any(String),
      command: "curl -sS https://ir.example/q1",
      // A failure is kept exactly as carefully as a success. A report leaning on a command that
      // exited nonzero is precisely what an auditor is looking for, and a record that quietly
      // dropped the failures would be the one shape of this table worth distrusting.
      return: "curl: (6) could not resolve host\n",
      exit_code: 6,
      duration_ms: 12,
      created_at: at + 1,
    });
    expect(links.shellRuns[1]!.return).toBe("");
    expect(links.shellRuns[1]!.duration_ms).toBe(0);
    expect(links.shellRuns[2]!.exit_code).toBe(-9);

    // `created_at` is when the command STARTED, never when it finished: with `duration_ms` beside
    // it, when it finished needs no second column, and a second column is a second clock to
    // disagree with the first. Ten minutes of sleeping, stamped at the moment it began.
    expect(links.shellRuns[2]!.created_at).toBe(at + 3);
    expect(links.shellRuns[2]!.duration_ms).toBe(600_000);
  });

  test("a run with no moment is a run nobody logged, and is refused rather than stamped", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const prices = seedScript(db, "prices");

    // Filling one in from the report's own clock would manufacture a log entry, which is precisely
    // the thing these two tables exist to make unrepresentable.
    for (const bad of [undefined, 0, -1, 1.5, Number.NaN, "1700000000000"]) {
      for (const declarations of allKinds(prices, { at: bad as never })) {
        expect(refusal(() => recordReport(db, recipe, "A", DOC, declarations)).message).toMatch(
          /a run nobody logged/,
        );
      }
    }
    expect(listReports(db)).toEqual([]);
  });

  test("a run with half an outcome is refused: nothing about it is defaulted", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const prices = seedScript(db, "prices");

    // A zero invented here would read afterwards as a command that succeeded instantly, and an
    // empty string as one that ran silently — three lies a reader has no way to tell from the
    // truth. So every one of them is refused, and the sentence names the field that is missing.
    const bad: [Partial<Outcome>, RegExp][] = [
      [{ return: undefined as never }, /carries what it printed/],
      [{ return: 0 as never }, /carries what it printed/],
      [{ exitCode: undefined as never }, /the code it exited with/],
      [{ exitCode: 1.5 }, /the code it exited with/],
      [{ exitCode: "0" as never }, /the code it exited with/],
      [{ durationMs: undefined as never }, /how long it took/],
      [{ durationMs: 1.5 }, /how long it took/],
      [{ durationMs: "12" as never }, /how long it took/],
      // Not a duration. Zero is legitimate and is proved elsewhere; this is the other side of it.
      [{ durationMs: -1 }, /how long it took/],
    ];
    for (const [over, message] of bad) {
      for (const declarations of allKinds(prices, over)) {
        expect(refusal(() => recordReport(db, recipe, "A", DOC, declarations)).message).toMatch(message);
      }
    }
    expect(listReports(db)).toEqual([]);

    // The refusals exist for the sentence; the CHECK is the rule. A negative duration cannot be
    // written by hand either.
    const reportId = recordReport(db, recipe, "A", DOC).id;
    expect(() => seedShellRun(db, reportId, "ls")).not.toThrow();
    expect(() => seedSeikanRun(db, reportId)).not.toThrow();
    for (const [table, prefix] of [
      ["trivial_shell_history_for_report", "sh"],
      ["seikan_invocation", "sk"],
    ] as const) {
      expect(() =>
        db
          .query(
            `INSERT INTO ${table}
               (name, id, report_id, command, "return", exit_code, duration_ms, created_at)
             VALUES ('${prefix}-negative', ?, ?, 'ls', '', 0, -1, ?)`,
          )
          .run(newId(), reportId, nowMs()),
      ).toThrow(/CHECK/);
    }
  });

  test("each kind of run is refused for its own reason, and a blank command records nothing", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const prices = seedScript(db, "prices");

    expect(
      refusal(() =>
        recordReport(db, recipe, "A", DOC, { scriptRuns: [scriptRun(prices, { scriptId: "   " })] }),
      ).message,
    ).toMatch(/names the script that ran/);
    // Which program it was is a different complaint from what it was given.
    expect(
      refusal(() =>
        recordReport(db, recipe, "A", DOC, {
          scriptRuns: [scriptRun(prices, { argument: undefined as never })],
        }),
      ).message,
    ).toMatch(/carries the argument it was run with/);
    // A script run with no arguments is a real thing; a shell entry with no command line is not,
    // because the line is the only thing naming what ran.
    for (const blank of ["", "   ", "\n\t"]) {
      expect(
        refusal(() => recordReport(db, recipe, "A", DOC, { shellRuns: [shellRun({ command: blank })] }))
          .message,
      ).toMatch(/each recorded command carries the line that ran/);
      // The same rule for a measurement, in its own words: the two tables refuse for the same
      // reason and a reader of either sentence should be able to tell which one they hit.
      expect(
        refusal(() =>
          recordReport(db, recipe, "A", DOC, { seikanRuns: [seikanRun({ command: blank })] }),
        ).message,
      ).toMatch(/each recorded measurement carries the engine command line/);
    }
    expect(listReports(db)).toEqual([]);
  });

  test("a report may record running a script another conversation saved: scripts are global", () => {
    const { db } = fresh();
    const mine = seedRecipe(db, "Mine");
    seedRecipe(db, "Theirs");
    // Written next door, as far as anything can tell: a script row carries no recipe, so there is
    // no question here to answer wrongly.
    const neighbour = seedScript(db, "their prices");

    const card = recordReport(db, mine, "A", DOC, {
      scriptRuns: [scriptRun(neighbour, { argument: "--full" })],
    });
    const run = reportLinks(db, card.id).scriptRuns[0]!;
    expect(run.script_id).toBe(neighbour);
    // The program is named by the script's own name — minted from the hint at creation, and the
    // user's to reword afterwards, which is why the id beside it is what the record actually pins.
    expect(run.script_name).toBe("their-prices");
    expect(card.script_invocation_count).toBe(1);
  });

  test("a report may record running a retired script: a run that happened, happened", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const scriptId = seedScript(db, "old prices", "inactive");
    // Retiring a program does not unhappen the runs of it, and the program itself is immutable, so
    // the record still describes exactly what produced the numbers.
    const card = recordReport(db, recipe, "A post-mortem", DOC, {
      scriptRuns: [scriptRun(scriptId, { argument: "--full" })],
    });
    expect(card.script_invocation_count).toBe(1);
    expect(reportLinks(db, card.id).scriptRuns[0]!.script_name).toBe("old-prices");
  });
});

describe("a publication is one act", () => {
  test("anything naming nothing rolls the whole publication back, parts already written and all", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const scriptId = seedScript(db, "prices");
    const at = nowMs();

    /** Everything before the bad part is already inserted, so zero rows is what proves the
     * transaction unwound rather than that it never started. */
    function nothingSurvived() {
      expect(listReports(db)).toEqual([]);
      for (const table of RUN_TABLES) expect(count(db, table)).toBe(0);
    }

    const whole = {
      scriptRuns: [scriptRun(scriptId, { at })],
      seikanRuns: [seikanRun({ at: at + 500 })],
      shellRuns: [shellRun({ at: at + 1_000 })],
    };

    // An id naming nothing, reached with the report row and one good run already in the savepoint.
    // The foreign key would refuse it anyway; the sentence is what names the tool that lists the
    // ids, and the rollback is what stops a report half-declaring its own foundations.
    expect(
      refusal(() =>
        recordReport(db, recipe, "A", DOC, {
          ...whole,
          scriptRuns: [...whole.scriptRuns, scriptRun("no-such-script", { at: at + 2_000 })],
        }),
      ).message,
    ).toMatch(/no script no-such-script/);
    nothingSurvived();

    // The shell entries are written after every script row, so a blank command unwinds a savepoint
    // with more in it than the one above — including rows in the other table.
    expect(
      refusal(() =>
        recordReport(db, recipe, "A", DOC, {
          ...whole,
          shellRuns: [...whole.shellRuns, shellRun({ command: "  ", at: at + 3_000 })],
        }),
      ).message,
    ).toMatch(/a blank one records nothing/);
    nothingSurvived();

    // A declaration that is not a list at all is a sentence about the argument, not a TypeError
    // escaping the publish transaction as a crash the model cannot read.
    expect(
      refusal(() => recordReport(db, recipe, "A", DOC, { scriptRuns: "--full" as never })).message,
    ).toMatch(/script_invocations is a list/);
    expect(
      refusal(() => recordReport(db, recipe, "A", DOC, { shellRuns: [42] as never })).message,
    ).toMatch(/shell_commands is a list/);
    expect(
      refusal(() => recordReport(db, recipe, "A", DOC, { seikanRuns: 7 as never })).message,
    ).toMatch(/seikan_invocations is a list/);
    nothingSurvived();
  });

  test("deleting the report frees every part, and deleting its recipe does too", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const scriptId = seedScript(db, "prices");
    const at = nowMs();
    const stands = {
      scriptRuns: [scriptRun(scriptId, { at })],
      seikanRuns: [seikanRun({ at })],
      shellRuns: [shellRun({ at })],
    };
    const card = recordReport(db, recipe, "A", DOC, stands);

    expect(deleteReport(db, card.id)).toBe(true);
    for (const table of RUN_TABLES) expect(count(db, table)).toBe(0);
    // The program it ran was never the report's to take: a script is the installation's, and the
    // record of having run it is the only part of this that belonged to the document.
    expect(count(db, "script")).toBe(1);

    recordReport(db, recipe, "B", DOC, stands);
    // The whole cascade is one statement, and what it takes it takes together: recipe → report →
    // all three run tables, leaving the script standing with nothing dangling from it. Nothing
    // stands in the way of it any more — the specification and everything published to it are one
    // body of work, and a document nothing can state the instructions for is worse than no document.
    expect(deleteRecipe(db, recipe)).toBe(true);
    for (const table of ["recipe", "report", ...RUN_TABLES]) {
      expect(count(db, table)).toBe(0);
    }
    expect(count(db, "script")).toBe(1);

    // And ONE deletion-log row for the whole of that act, carrying the recipe. The log answers
    // "what did the agent delete", and the answer is a recipe; the report and its three run rows
    // are the schema's consequence of that single act rather than four more deletions somebody
    // performed. The other row is the report deleted by hand at the top of this test.
    expect(count(db, "deletion_log")).toBe(2);
    expect(
      db
        .query<{ table_name: string; row_id: string }, []>(
          "SELECT table_name, row_id FROM deletion_log ORDER BY id DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ table_name: "recipe", row_id: recipe });
  });

  test("a part of a publication cannot be deleted or edited on its own, its output least of all", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const scriptId = seedScript(db, "prices");
    const card = recordReport(db, recipe, "A", DOC);
    // Straight into the tables: this is a test about what a standing row holds down, and publishing
    // a document to get one would prove the repository rather than the schema.
    seedScriptRun(db, card.id, scriptId);
    seedSeikanRun(db, card.id);
    seedShellRun(db, card.id, "curl -sS https://ir.example/q1");

    // A record that can be amended piece by piece is not a record of what was published.
    for (const table of RUN_TABLES) {
      expect(() => db.query(`DELETE FROM ${table} WHERE report_id = ?`).run(card.id)).toThrow(
        /deleted only with its report/,
      );
    }
    expect(() =>
      db.query("UPDATE script_invocation SET argument = '--quiet' WHERE report_id = ?").run(card.id),
    ).toThrow(/immutable/);
    for (const table of ["seikan_invocation", "trivial_shell_history_for_report"]) {
      expect(() =>
        db.query(`UPDATE ${table} SET command = 'ls' WHERE report_id = ?`).run(card.id),
      ).toThrow(/immutable/);
    }

    // The outcome columns are inside every one of those triggers' column lists, and this is the pin
    // that proves it: `BEFORE UPDATE OF` has no "all but", so a column added to a table and
    // forgotten here is silently unguarded — and what a command printed is exactly the column an
    // amendment would want to reach for.
    for (const table of RUN_TABLES) {
      for (const set of [`"return" = 'nothing to see here'`, "exit_code = 0", "duration_ms = 1"]) {
        expect(() =>
          db.query(`UPDATE ${table} SET ${set} WHERE report_id = ?`).run(card.id),
        ).toThrow(/immutable/);
      }
    }

    // The name is the one column outside both lists, and that non-membership is what makes it safe
    // to hand to a user: renaming a row never wakes the trigger that freezes what the row says.
    // `BEFORE UPDATE OF` has no "all but", so each of those lists spells out every other column by
    // hand — and this is the assertion that would notice the day one of them grew a `name`.
    for (const table of RUN_TABLES) {
      db.query(`UPDATE ${table} SET name = ? WHERE report_id = ?`).run(
        `renamed-${table}`,
        card.id,
      );
    }

    // They leave with the report, which is the only way they leave.
    deleteReport(db, card.id);
    for (const table of RUN_TABLES) expect(count(db, table)).toBe(0);
  });

  test("a standing report holds down the scripts it ran, and nothing else any more", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const scriptId = seedScript(db, "prices");
    const thesisId = seedThesis(db, "NVDA compounds");
    seedAssessment(db, thesisId, "insightful");
    const sourceId = seedSource(db, "NVIDIA IR", ["ir.example"]);
    const card = recordReport(db, recipe, "A", DOC, { scriptRuns: [scriptRun(scriptId)] });

    // The script stays. A report records the program that produced its numbers by id, so deleting
    // that program would leave the record naming something nothing can show you; setting it
    // inactive is the way to retire it without emptying the record.
    expect(refusal(() => deleteScript(db, scriptId)).message).toMatch(
      /published report\(s\) record running this script/,
    );

    // The thesis and the source do NOT, and their release is the decision rather than an oversight.
    // Both used to be held down by a declaration — the readings a report said it applied, the
    // addresses it said it had quoted — and both declarations were the model's own account of its
    // argument, checked against nothing. The tables are gone, so nothing points here from a report
    // and the guards went with them. What the document says about either is in the document, which
    // is immutable; for the rows themselves the deletion log is the witness.
    expect(deleteThesis(db, thesisId)).toBe(true);
    expect(deleteSource(db, sourceId)).toBe(true);
    expect(count(db, "thesis_assessment")).toBe(0);
    expect(getReport(db, card.id)).not.toBeNull();
    expect(getReportContent(db, card.id)).toBe(DOC);
  });
});

describe("reading the shelf", () => {
  test("narrowed by the recipe a report was written to, and by nothing narrower", () => {
    const { db } = fresh();
    const mine = seedRecipe(db, "mine", "Write a report.");
    const yours = seedRecipe(db, "yours", "Write another report.");
    recordReport(db, mine, "Mine 1", "<h1>1</h1>");
    recordReport(db, yours, "Yours 1", "<h1>1</h1>");
    recordReport(db, mine, "Mine 2", "<h1>2</h1>");

    // ONE filter, where there used to be two. A report named a workshop and, inside it, the exact
    // playbook version — so narrowing by the workshop and narrowing by the text were different
    // questions. A recipe's text cannot be edited, so they are now the same question and there is
    // only the one.
    expect(
      listReports(db, { recipeId: mine })
        .map((r) => r.title)
        .sort(),
    ).toEqual(["Mine 1", "Mine 2"]);
    expect(listReports(db, { recipeId: yours }).map((r) => r.title)).toEqual(["Yours 1"]);
    expect(listReports(db)).toHaveLength(3);
    // And each row wears the name of the specification it was written to — read through the join,
    // so it is the recipe's own line rather than a copy taken at publication.
    expect(listReports(db, { recipeId: mine }).map((r) => r.recipe_name)).toEqual(["mine", "mine"]);
    expect(listReports(db, { recipeId: yours })[0]!.recipe_name).toBe("yours");
  });

  test("a retired recipe keeps every report written under it, and lists them still", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db, "Semis");
    recordReport(db, recipe, "Q1", DOC);
    // This is the whole difference between retiring a recipe and deleting one. Those documents were
    // written to exactly these words and still are; what retiring changes is what happens NEXT.
    db.query("UPDATE recipe SET status = 'inactive' WHERE id = ?").run(recipe);
    expect(listReports(db, { recipeId: recipe }).map((r) => r.title)).toEqual(["Q1"]);
  });
});

describe("forgetting a report", () => {
  test("takes the document with it, and leaves nothing for a caller to clean up", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const card = recordReport(db, recipe, "A", DOC, { shellRuns: [shellRun()] });

    expect(deleteReport(db, card.id)).toBe(true);
    expect(getReport(db, card.id)).toBeNull();
    // The bytes went with the row, because the row was the bytes.
    expect(getReportContent(db, card.id)).toBeNull();
    expect(count(db, "trivial_shell_history_for_report")).toBe(0);
  });

  test("an id naming nothing is false, not a refusal: gone is what the caller asked for", () => {
    const { db } = fresh();
    expect(deleteReport(db, "nope")).toBe(false);
    // Nothing left, so nothing to witness: the log is a record of deletions that happened.
    expect(count(db, "deletion_log")).toBe(0);
  });

  test("writes one deletion-log row holding the document, and not one per cascaded part", () => {
    const { db } = fresh();
    const recipe = seedRecipe(db);
    const scriptId = seedScript(db, "prices");
    const at = nowMs();
    const card = recordReport(db, recipe, "A", DOC, {
      scriptRuns: [scriptRun(scriptId, { at })],
      shellRuns: [shellRun({ at }), shellRun({ command: "ls -la", at })],
    });

    expect(deleteReport(db, card.id)).toBe(true);

    // Two tables were emptied by the cascade and ONE row is logged. The log answers "what did the
    // agent delete", and the answer is a report; the three run rows are the schema's consequence of
    // that one act rather than three more deletions somebody performed.
    const logged = db
      .query<{ table_name: string; row_id: string; row_json: string }, []>(
        "SELECT table_name, row_id, row_json FROM deletion_log ORDER BY id",
      )
      .all();
    expect(logged).toHaveLength(1);
    expect(logged[0]!.table_name).toBe("report");
    expect(logged[0]!.row_id).toBe(card.id);

    // The DOCUMENT rides along, which is the expensive half of the "whole row" decision and the
    // half worth paying for: a deleted publication whose bytes were not kept is one nobody can ever
    // check the deletion of.
    const row = JSON.parse(logged[0]!.row_json) as Record<string, unknown>;
    expect(row["content"]).toBe(DOC);
    expect(row["title"]).toBe("A");
    expect(row["recipe_id"]).toBe(recipe);
  });
});

describe("the specification a report names", () => {
  test("a recipe's text is immutable, so a report's provenance cannot rot underneath it", () => {
    const { db } = fresh();
    const recipe = createRecipe(db, "Semis", "Write a report on the semis basket.");
    const card = recordReport(db, recipe.id, "Q1", DOC);

    // THIS IS WHAT THE PLAYBOOK LEDGER WAS FOR, bought outright. Instructions used to be appended
    // version by version so that no report was left pointing at text that had changed; the text is
    // simply fixed now, and the trigger is column-scoped exactly as a script's is.
    for (const [column, value] of [
      ["content", "'Write something else.'"],
      ["id", "'x'"],
      ["created_at", "0"],
    ] as const) {
      expect(() =>
        db.query(`UPDATE recipe SET ${column} = ${value} WHERE id = ?`).run(recipe.id),
      ).toThrow(/immutable/);
    }
    expect(getRecipe(db, recipe.id)?.content).toBe("Write a report on the semis basket.");
    // And the report still names it, byte for byte, which is the whole of what the rule is for.
    expect(getReport(db, card.id)!.recipe_id).toBe(recipe.id);
  });

  test("a recipe is born active, and is not born inactive", () => {
    const { db } = fresh();
    expect(createRecipe(db, "Semis", "Write a report.").status).toBe("active");
    // A specification stored already retired is one nobody ever worked to. The trigger says so to
    // anything reaching the database another way, which is the half a repository cannot promise.
    expect(() =>
      db
        .query(
          `INSERT INTO recipe (name, id, content, status, created_at, updated_at)
           VALUES ('retired', 'x', 'Write a report.', 'inactive', 0, 0)`,
        )
        .run(),
    ).toThrow(/not born inactive/);
  });

  test("setRecipeStatus moves the standing and the moment, and nothing else about the row", () => {
    const { db } = fresh();
    const recipe = createRecipe(db, "Semis", "Write a report.");
    const retired = setRecipeStatus(db, recipe.id, "inactive");
    expect(retired.status).toBe("inactive");
    expect(retired.content).toBe(recipe.content);
    expect(retired.updated_at).toBeGreaterThanOrEqual(recipe.updated_at);

    // Re-stating a standing would move `updated_at`, which on a recipe means "when its standing
    // last changed" and would then be saying something untrue.
    expect(refusal(() => setRecipeStatus(db, recipe.id, "inactive")).kind).toBe("conflict");
    // Unlike a thesis, a recipe may be revived: two specifications saying similar things are two
    // specifications, and there is nothing for the revival to collide with.
    expect(setRecipeStatus(db, recipe.id, "active").status).toBe("active");
  });

  test("recipes list ACTIVE FIRST, then newest first within each standing", () => {
    const { db } = fresh();
    // What a reader is looking for is the specifications still being written to; the retired ones
    // are archive rather than absence, so they are below rather than gone. Nothing here derives
    // "the current recipe" — several may be active at once, because a person doing two kinds of
    // work has two specifications and neither supersedes the other.
    //
    // Written straight in, because the moments have to be distinct and `created_at` is inside the
    // immutability trigger's column list: a recipe stored by `createRecipe` cannot be backdated
    // afterwards, which is the rule the test above is about.
    const at = (name: string, moment: number) => {
      const id = newId();
      db.query(
        `INSERT INTO recipe (name, id, content, status, created_at, updated_at)
         VALUES (?, ?, 'Write a report.', 'active', ?, ?)`,
      ).run(name, id, moment, moment);
      return id;
    };
    at("Older", 1_000);
    const newer = at("Newer", 3_000);
    // The newest row of the three, and still last, because standing outranks recency here.
    const retired = at("Retired", 9_000);
    setRecipeStatus(db, retired, "inactive");

    expect(listRecipes(db).map((r) => r.name)).toEqual(["Newer", "Older", "Retired"]);
    expect(listRecipes(db, { status: "active" }).map((r) => r.name)).toEqual(["Newer", "Older"]);
    expect(listRecipes(db, { status: "inactive" }).map((r) => r.name)).toEqual(["Retired"]);

    // And each row says how many reports would leave with it, which is what a caller about to
    // delete one has to be told.
    recordReport(db, newer, "Q1", DOC);
    recordReport(db, newer, "Q2", DOC);
    expect(listRecipes(db).map((r) => r.report_count)).toEqual([2, 0, 0]);
  });
});

/**
 * The card is what the type says it is.
 *
 * `ReportCard` extends `Report`, which declares `name`, and `CARD_SQL` enumerates its columns by
 * hand — so an omission there is a field typed `string` and `undefined` at runtime, which is the one
 * kind of wrongness a typecheck cannot catch and a reader will not think to look for. Enumerating
 * rather than `SELECT *` is deliberate (the document must not ride along), and this is the cost of
 * that decision paid down.
 */
test("a card carries every column its type promises, the name included", () => {
  const h = harness();
  try {
    const card = recordReport(h.db, seedRecipe(h.db), "Quarterly", DOC);
    for (const [key, value] of Object.entries(card)) {
      expect(value, `${key} is on the type and not in CARD_SQL`).toBeDefined();
    }
    // Minted from the title, which is the only thing a report has to be named after.
    expect(card.name).toBe("quarterly");
  } finally {
    h.cleanup();
  }
});
