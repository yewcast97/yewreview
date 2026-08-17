/**
 * Running things where the record can see them: a stored script, the engine, and anything else.
 *
 * The agent has a shell and could do all three itself, and outside a generation procedure it may.
 * DURING one it may not — the built-in Bash is denied outright by `claudecode/hooks.ts` for the duration,
 * and these three tools are the only way a command runs. That is what makes a report's record of
 * what produced it a record of everything rather than of the parts somebody remembered to route
 * through a tool. What these tools add is a WITNESS. A model asked afterwards what it ran will answer with what it meant
 * to run: not from dishonesty, but because an intention is what a conversation actually remembers,
 * and the difference only shows up in the one place nobody can check it later. So during a
 * generation the run log is written HERE, by the machine, from the calls that actually happened —
 * and `publish_report` reads it rather than asking.
 *
 * Three things follow from that, and all three are load-bearing.
 *
 * **A run is confined.** These spawn out of the server process, which can reach the database, the
 * venv and every published report's chart library — so the argv is wrapped in the platform's own
 * sandbox first (`sandbox/exec.ts`), writable in the agent's home directory and the caches and
 * nowhere else. A recorded run that could edit the record would be worse than an unrecorded one.
 * Where no sandbox exists the run is refused rather than run unconfined.
 *
 * **A run's output lands on disk, and the tool result is a digest of it.** Tool results are capped,
 * and an engine report is routinely larger than the cap; a truncated one reaching the model is how
 * a number gets read off a document that stops mid-sentence. Both tools therefore write everything
 * into the run's own directory, hand back a summary, and say where the rest is.
 *
 * **The engine's report is retained rather than returned.** `assess_thesis` redeems it by id, so
 * the bytes stored beside a judgement are the bytes the engine wrote — never a copy that went
 * through a model on the way and came back rounded, summarised or improved.
 *
 * A run that exits nonzero writes an ERROR-LOG row as well as refusing. The refusal is the model's
 * answer and carries the streams; the log row is for the person reading the installation's failures
 * afterwards, who has no transcript in front of them and who is precisely the one who notices that
 * the same script has been exiting 1 all week. It is the only writer here that logs, because it is
 * the only failure that is not an argument mistake: an id naming nothing or a path outside the home
 * directory is a `Refused` the model corrects on its next attempt, and filing those would bury the
 * runs that really broke under a list of typos.
 */

import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { z } from "zod";

import { homeDir } from "../config.ts";
import { Refused } from "../db/models.ts";
import { nowMs } from "../db/tx.ts";
import { logError } from "../repo/logs.ts";
import { getScript } from "../repo/scripts.ts";
import { getThesis } from "../repo/theses.ts";
import { argv, clip, execRecorded, makeRunDir, shellJoin } from "../exec.ts";
import type { ToolDeps } from "../protocol/types.ts";
import { fail, ok } from "../protocol/types.ts";
import { attempt, ref, refDoc } from "./common.ts";
import { defineTool } from "./def.ts";
import { resolveInHome } from "./homeFile.ts";
import { dslIdentity } from "./seikanCli.ts";

/** The output files `seikan run` can be asked for beyond its report. */
const EXTRA_OUTPUTS = {
  trades: "--trades-out",
  root_series: "--root-series-out",
  entry_flags: "--entry-flags-out",
} as const;

/** How much of stderr rides into the error log beside a nonzero exit. The whole of it is on disk in
 * the run's own directory; what the log needs is the last thing the program said, which is where a
 * traceback's actual message lives. */
const LOGGED_STDERR = 2_000;

export function build(deps: ToolDeps) {
  const { settings } = deps;

  return [
    defineTool(
      "run_shell",
      "Run a command line and hand back what it printed. It is the shell you would otherwise " +
        "type into: /bin/sh, in your home directory, under the same confinement, so pipes, " +
        "redirection and quoting all work. During a generation procedure it is the ONLY shell — " +
        "your built-in Bash is closed for the duration — and every call is RECORDED against the " +
        "report: the line that ran, when it started, how long it took, what it exited with and " +
        "what it printed. That is the whole reason the built-in one is closed, and nothing is " +
        "lost by it. Outside a procedure this runs the same way and records nothing, because " +
        "there is no report for a record to be part of. Use run_script for a stored program and " +
        "run_seikan to measure a thesis: those two name what they ran, which reads better in a " +
        "report's history than a command line does.",
      {
        command: z
          .string()
          .describe(
            "The command line, as a shell reads it — for example \"wc -l data/prices.csv\" or " +
              "\"head -3 out/*.csv | tee summary.txt\". Recorded exactly as written.",
          ),
      },
      async (args) =>
        attempt(async () => {
          const command = args.command.trim();
          if (command === "") {
            throw new Refused(
              "invalid_request",
              "a command line is needed; there is nothing to run and nothing to record",
            );
          }
          const outcome = await execRecorded(deps, { command });
          const payload = {
            command,
            exit_code: outcome.exitCode,
            duration_ms: outcome.durationMs,
            stdout: clip(outcome.stdout),
            stderr: clip(outcome.stderr),
            output_directory: outcome.run.relative,
            recorded: deps.runs.recording(),
          };
          if (outcome.exitCode !== 0) {
            // Filed as well as returned, exactly as a failed script run is: the person reading
            // this installation's failures later has no transcript, and a command failing the
            // same way every afternoon is the thing only they can notice.
            logError(
              deps.db,
              "run",
              `a shell command exited ${outcome.exitCode}` +
                `${outcome.timedOut ? " (timed out)" : ""}`,
              {
                command,
                exit_code: outcome.exitCode,
                timed_out: outcome.timedOut,
                output_directory: outcome.run.relative,
                stderr_tail: outcome.stderr.slice(-LOGGED_STDERR),
              },
            );
            // A REFUSAL RATHER THAN A RESULT, and the difference is worth being deliberate about:
            // a nonzero exit is how a shell says the thing did not happen, and a tool that
            // returned it as an ordinary answer would let a procedure walk past a failed step. The
            // row is written either way — the log entry was finalized before this returned — so
            // the report records the failure whatever the model does next.
            return fail(
              "script_failed",
              `the command exited ${outcome.exitCode}${outcome.timedOut ? " (timed out)" : ""}`,
              payload,
            );
          }
          return ok(
            `Exited 0${outcome.stdout.trim() === "" ? " and printed nothing" : ""}.`,
            payload,
          );
        }),
      // One of the four the freeze lets through: while a procedure records, these three are the
      // only shell there is — refusing them would not be a stricter rule, it would be a procedure
      // that cannot do anything. See `freezeRefusal` in `index.ts`.
      { openDuringProcedure: true },
    ),

    defineTool(
      "run_script",
      "Run a recorded script and hand back what it printed. The program comes out of the database " +
        "— not out of a copy in your home directory — so what runs is exactly what create_script " +
        "stored and what a later reader will read. It runs in your home directory under the same " +
        "confinement your shell has, so anything it writes lands there and nowhere else. During a " +
        "generation procedure this call is RECORDED: the report's account of what produced its " +
        "numbers is written from these calls, which is why the same run made through your shell is " +
        "refused for the duration.",
      {
        script_id: z.string().describe(`The recorded script to run. ${refDoc("script", "list_scripts")}`),
        argument: z
          .string()
          .describe(
            'What to pass it, as one command line — for example "--ticker NVDA --years 5". It is ' +
              "split on whitespace, so it is argv rather than a shell line: no quoting, no pipes, " +
              'no variables. Pass "" when the script takes none, and record the same string in the ' +
              "assessment's series_preparations so the run can be repeated.",
          ),
      },
      async (args) =>
        attempt(async () => {
          const script = getScript(deps.db, ref(deps.db, "script", args.script_id));
          if (!script) {
            throw new Refused(
              "not_found",
              `no script ${args.script_id}; list_scripts shows what this installation holds`,
            );
          }
          // AN INACTIVE SCRIPT IS NOT RUN, and the refusal lives here rather than in `getScript`
          // because reading, deleting and reviving a retired script are all ordinary. Retiring one
          // is how somebody says a method has been superseded; a run afterwards would produce
          // numbers off exactly the program they retired, and nothing downstream would show that
          // the program behind them was the abandoned half of a replacement.
          if (script.status === "inactive") {
            throw new Refused(
              "conflict",
              `${script.name} is inactive: it was retired, by replacement or because it failed for ` +
                `good, and running it would produce numbers off a program nobody is using any ` +
                `more. Run the script that replaced it, or set this one active again with ` +
                `set_script_status if retiring it was the mistake.`,
            );
          }
          const venv = deps.venv();
          if (!venv.ready || venv.python === null) {
            return fail(
              "venv_unavailable",
              "the sandbox Python environment is not installed here, so nothing can be run in it",
            );
          }

          // The program is written into a scratch directory of its own rather than run from a
          // path, because the row IS the script: what executes is what `create_script` stored.
          const staging = makeRunDir(settings);
          const program = join(staging.dir, "script.py");
          writeFileSync(program, script.source, "utf8");

          const outcome = await execRecorded(deps, {
            script: { id: script.id },
            argument: args.argument,
            argv: [venv.python, program, ...argv(args.argument)],
            staging,
          });
          const run = outcome.run;

          const payload = {
            script: { id: script.id, name: script.name },
            exit_code: outcome.exitCode,
            duration_ms: outcome.durationMs,
            stdout: clip(outcome.stdout),
            stderr: clip(outcome.stderr),
            output_directory: run.relative,
            recorded: deps.runs.recording(),
          };
          if (outcome.exitCode !== 0) {
            // Filed as well as refused. The refusal is this model's answer and it carries both
            // streams; the log row is for the person reading the installation's failures later,
            // who has no transcript and who is the one who notices that this script has been
            // exiting nonzero all week. The tail rather than the head, because a traceback's
            // message is at the end of it.
            logError(
              deps.db,
              "run",
              `${script.name} exited ${outcome.exitCode}${outcome.timedOut ? " (timed out)" : ""}`,
              {
                script_id: script.id,
                argument: args.argument,
                exit_code: outcome.exitCode,
                timed_out: outcome.timedOut,
                output_directory: run.relative,
                stderr_tail: outcome.stderr.slice(-LOGGED_STDERR),
              },
            );
            return fail(
              "script_failed",
              `${script.name} exited ${outcome.exitCode}${outcome.timedOut ? " (timed out)" : ""}`,
              payload,
            );
          }
          return ok(
            `${script.name} finished. Anything it wrote is under ${run.relative}.`,
            payload,
          );
        }),
      // One of the four the freeze lets through: while a procedure records, these three are the
      // only shell there is — refusing them would not be a stricter rule, it would be a procedure
      // that cannot do anything. See `freezeRefusal` in `index.ts`.
      { openDuringProcedure: true },
    ),

    defineTool(
      "run_seikan",
      "Measure a stored thesis by id, or a document not stored yet passed whole as dsl_json — " +
        "give exactly one of the two. The document mode is how a thesis's FIRST measurement " +
        "happens: create_thesis files a first reading with the container, and a reading needs a " +
        "run of exactly these bytes before anything is stored. Either way the CSV behind each " +
        "series the document names is supplied here, one entry per key — a thesis says WHICH " +
        "series it measures and never where they are, so this call is where they are. The " +
        "engine's own report is kept whole and handed back as a run_id: give that id to " +
        "assess_thesis — or to create_thesis, when the run measured a document on its way to " +
        "being stored — rather than retyping the report, so the bytes filed beside your judgement " +
        "are the bytes the engine wrote. What comes back here is a summary of the run, not the " +
        "report; the report itself is on disk if you want to read it. Exit 0 means the " +
        "measurement happened. It is not a verdict, and there is no verdict to look for.",
      {
        thesis_id: z
          .string()
          .optional()
          .describe(
            `The stored thesis to measure. ${refDoc("thesis", "list_theses")} Give this OR ` +
              `dsl_json, never both.`,
          ),
        dsl_json: z
          .string()
          .optional()
          .describe(
            "The measurement document itself, as JSON text — for a document nothing has stored " +
              "yet, which is the shape a thesis's first measurement has to take. The engine " +
              "validates and hashes it before running, and the run's id is what create_thesis " +
              "verifies against the bytes it is handed. Give this OR thesis_id, never both.",
          ),
        data: z
          .record(
            z.string(),
            z.union([
              z.string(),
              z.strictObject({ path: z.string(), column: z.string().optional() }),
            ]),
          )
          .describe(
            "Which file answers each series key the thesis declares, as {key: path}. The keys are " +
              "the target names, each external feed's name — FEED@TARGET when the feed is " +
              'per-target — and "benchmark" when params.benchmark is "market". The set must ' +
              "answer the thesis exactly: a missing key measures a thesis you do not have and an " +
              "unknown one means you believe it reads something it never mentions, and the engine " +
              "refuses both. Paths are relative to your home directory. A value may be that " +
              "path, or {path, column} — which is how a key says WHICH column of its CSV it " +
              "reads, and is needed only when the file holds several numeric columns, since a " +
              "file holding one value column names itself. The column is matched without regard " +
              'to case. "benchmark" never takes one: it is always measured off its file\'s open ' +
              "price, so there is nothing there to choose.",
          ),
        outputs: z
          .array(z.enum(["trades", "root_series", "entry_flags"]))
          .optional()
          .describe(
            "Extra per-bar files to write beside the report: trades (one row per observation), " +
              "root_series (the values every threshold read), entry_flags (the firing mask, and " +
              "the only output carrying a firing on the final bar). Ask for one when you are going " +
              "to read it; they are large.",
          ),
        thresholds: z
          .strictObject({
            min_trades: z.number().int().optional(),
            min_n_eff: z.number().int().optional(),
            max_concentration: z.number().optional(),
            max_hypotheses: z.number().int().optional(),
          })
          .optional()
          .describe(
            "Tighten the checklist. Canonical-as-floor: a STRICTER value is accepted and a looser " +
              "one is refused outright, so this can only ever raise the bar. Leave it out unless " +
              "the user asked for a harder exam.",
          ),
      },
      async (args) =>
        attempt(async () => {
          // The XOR before anything else, the venv included: which document is being measured is a
          // property of the REQUEST, answerable and testable on a machine with no engine at all.
          if ((args.thesis_id === undefined) === (args.dsl_json === undefined)) {
            throw new Refused(
              "invalid_request",
              "a measurement is of exactly one document: give thesis_id for a stored thesis, or " +
                "dsl_json for one not stored yet — one of the two, never both and never neither",
            );
          }
          const thesis =
            args.thesis_id === undefined
              ? null
              : getThesis(deps.db, ref(deps.db, "thesis", args.thesis_id));
          if (args.thesis_id !== undefined && thesis === null) {
            throw new Refused(
              "not_found",
              `no thesis ${args.thesis_id}; list_theses shows what this installation holds`,
            );
          }
          const venv = deps.venv();
          if (!venv.ready || venv.seikanBin === null) {
            return fail(
              "venv_unavailable",
              "the measurement engine is not installed here; say so plainly rather than " +
                "describing numbers you could not compute",
            );
          }
          // Document mode hashes FIRST, through the same function `create_thesis` will use on the
          // same bytes — so the redemption check there is equality by construction, and an invalid
          // document is the engine's own complaint before a run is ever staged. A stored thesis
          // already carries its hash; recomputing it would be the same rule run twice.
          let dslJson: string;
          let dslHash: string;
          if (thesis !== null) {
            dslJson = thesis.dsl_json;
            dslHash = thesis.dsl_hash;
          } else {
            const identity = await dslIdentity(deps, args.dsl_json!);
            if (!identity.ok) return fail(identity.kind, identity.message);
            dslJson = args.dsl_json!;
            dslHash = identity.hash;
          }

          const keys = Object.keys(args.data);
          if (keys.length === 0) {
            throw new Refused(
              "invalid_request",
              "a measurement needs the files behind the series the thesis names; pass one data " +
                "entry per key the document declares",
            );
          }
          // Resolved before anything is spawned, so a path pointing outside the home directory is
          // a refusal the model can act on rather than an engine error about a file it cannot read.
          // A column is not a path and containment has nothing to say about it — but a binding
          // that names no column at all cannot mean anything to the engine either, so it is
          // refused here too rather than paid for with a subprocess.
          const bound = keys.map((key) => {
            const entry = args.data[key]!;
            const spec = typeof entry === "string" ? { path: entry, column: undefined } : entry;
            const column = spec.column === undefined ? undefined : spec.column.trim();
            if (column === "") {
              throw new Refused(
                "invalid_request",
                `the column bound to ${key} is blank; name the column of that CSV the key reads, ` +
                  `or bind the path by itself when the file holds a single value column`,
              );
            }
            return {
              key,
              path: resolveInHome(settings, spec.path, `data file for ${key}`),
              column,
            };
          });

          const staging = makeRunDir(settings);
          const document = join(staging.dir, "thesis.json");
          writeFileSync(document, dslJson, "utf8");
          const reportOut = join(staging.dir, "report.json");

          const command = [venv.seikanBin, "run", document, "--report-out", reportOut];
          for (const { key, path } of bound) command.push("--data", `${key}=${path}`);
          for (const { key, column } of bound) {
            if (column !== undefined) command.push("--column", `${key}=${column}`);
          }
          const extras: Record<string, string> = {};
          for (const name of args.outputs ?? []) {
            const file = join(staging.dir, `${name}.csv`);
            command.push(EXTRA_OUTPUTS[name], file);
            extras[name] = relative(homeDir(settings), file);
          }
          for (const [knob, value] of Object.entries(args.thresholds ?? {})) {
            if (value !== undefined) command.push(`--${knob.replace(/_/g, "-")}`, String(value));
          }

          // The seikan spec, which is what files this run in `seikan_invocation` rather than in the
          // history of commands that name no program — and what keeps its output VERBATIM, alone
          // among the commands this installation records. A measurement report is a document rather
          // than a program's chatter — the same document `assess_thesis` files whole beside a
          // judgement — and a clipped one is not a smaller version of it but a broken one. Neither
          // is a flag here: both follow from this being a measurement.
          const outcome = await execRecorded(deps, {
            seikan: true,
            command: shellJoin(command),
            argv: command,
            staging,
          });
          const run = outcome.run;
          if (outcome.exitCode !== 0) {
            // Logged for the same reason and with the same reservation as the script branch above:
            // the engine refusing a document IS a failure of this installation's work even when it
            // is the model's document that is wrong, and the person reading the log afterwards is
            // the one who spots that every measurement of one thesis has died the same way. A
            // document-mode run has no name to die under, so the sentence says what it was instead.
            logError(
              deps.db,
              "run",
              thesis === null
                ? `the engine refused a measurement of an unstored document (exit ${outcome.exitCode})`
                : `the engine refused a measurement of ${thesis.name} (exit ${outcome.exitCode})`,
              {
                thesis_id: thesis?.id ?? null,
                exit_code: outcome.exitCode,
                envelope: parseJson(outcome.stdout),
                output_directory: run.relative,
                stderr_tail: outcome.stderr.slice(-LOGGED_STDERR),
              },
            );
            return fail(
              engineRefusal(outcome.stdout),
              `the engine refused this run (exit ${outcome.exitCode})`,
              {
                thesis: thesis === null ? null : { id: thesis.id, name: thesis.name },
                exit_code: outcome.exitCode,
                envelope: parseJson(outcome.stdout),
                stderr: clip(outcome.stderr),
              },
            );
          }

          const report = await Bun.file(reportOut).text();
          const runId = deps.runs.retain({
            thesisId: thesis?.id ?? null,
            dslHash,
            report,
            finishedAt: nowMs(),
          });
          return ok(
            thesis === null
              ? `Measured the document. Give run_id ${runId} to create_thesis with the first reading.`
              : `Measured ${thesis.name}. Give run_id ${runId} to assess_thesis with your reading.`,
            {
              run_id: runId,
              thesis: thesis === null ? null : { id: thesis.id, name: thesis.name },
              duration_ms: outcome.durationMs,
              report_path: relative(homeDir(settings), reportOut),
              extra_outputs: extras,
              recorded: deps.runs.recording(),
              ...digest(report),
            },
          );
        }),
      // One of the four the freeze lets through: while a procedure records, these three are the
      // only shell there is — refusing them would not be a stricter rule, it would be a procedure
      // that cannot do anything. See `freezeRefusal` in `index.ts`.
      { openDuringProcedure: true },
    ),
  ];
}

/** The engine's exit codes, as refusal kinds. 2 is the data contract, 3 is the request, and
 * anything else is the engine failing rather than refusing. */
function engineRefusal(stdout: string): string {
  const envelope = parseJson(stdout) as { error?: { type?: string } } | null;
  const type = envelope?.error?.type;
  if (type === "data_invalid") return "data_invalid";
  if (type === "usage" || type === "dsl_invalid" || type === "thresholds_invalid") {
    return "invalid_request";
  }
  return "script_failed";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * What a reader needs from a run without reading the whole report.
 *
 * Deliberately thin, and deliberately not a verdict. `n_passed` is how many cells cleared the
 * checklist, which is a count and not a test anything passed — the engine crowns nobody, and a
 * digest that offered a headline would be the one place in this codebase that did.
 */
function digest(report: string): Record<string, unknown> {
  const doc = parseJson(report) as
    | { summary?: Record<string, unknown>; gate?: Record<string, unknown> }
    | null;
  const summary = doc?.summary ?? {};
  const gate = doc?.gate ?? {};
  return {
    dsl_hash: (doc as { identity?: { dsl_hash?: string } } | null)?.identity?.dsl_hash ?? null,
    measurement: {
      n_bars: summary["n_bars"] ?? null,
      index_start: summary["index_start"] ?? null,
      index_end: summary["index_end"] ?? null,
      n_hypotheses_attempted: summary["n_hypotheses_attempted"] ?? null,
      target_mode: summary["target_mode"] ?? null,
      outcome: summary["outcome"] ?? null,
    },
    checklist: {
      policy_version: gate["policy_version"] ?? null,
      n_cells: gate["n_cells"] ?? null,
      n_passed: gate["n_passed"] ?? null,
      run_checks: gate["run_checks"] ?? null,
    },
  };
}
