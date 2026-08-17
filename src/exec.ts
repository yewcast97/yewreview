/**
 * The one door every command a report stands on goes through.
 *
 * **Nothing a generation procedure runs may run any other way.** That sentence used to be almost
 * true — the two run tools spawned through a helper of their own and everything else the agent
 * typed into its shell simply happened, unwatched, unrecorded, and invisible to the report it went
 * into. What this module is for is closing that: `execRecorded` confines, spawns, captures, and
 * writes the run into the generation's log in the same motion, and during a procedure the agent's
 * own Bash is refused outright (`claudecode/hooks.ts`) so there is no second way in. A command that ran
 * and left no row is therefore not a gap in a report's account of itself; it is a command that was
 * refused.
 *
 * **It is overloaded because there are exactly three kinds of command and they are three tables.**
 * A run of a STORED script can name the program it ran, and that name is worth having: the script's
 * source is a column of this database, immutable, so the row says precisely what executed. A run of
 * the MEASUREMENT ENGINE names no row, because it is always the same program — what it earns a kind
 * for is the reader, who asks "which of these were measurements" before anything else, and the
 * capture, which is the one place output is kept whole. Anything else — a checksum, a directory
 * listing, an ad-hoc one-liner — can only name the line. All three are recorded; none is optional;
 * the caller picks by what it actually knows.
 *
 * **The log entry is written in two phases, and that is a race rather than tidiness.** The entry is
 * appended when the process is SPAWNED and completed when it exits. Publishing refuses while any
 * entry is still open, so a model cannot publish in the window between starting a long command and
 * its finishing and leave the report's procedure missing exactly the run that was still going. The
 * finalizer runs in a `finally`, so a command that throws on its way out lands as a finished entry
 * rather than an open one nothing will ever close. Shell-history recorders learn the same lesson
 * from `preexec`/`precmd`: what a command IS can be known before it runs, and how it WENT cannot.
 *
 * **Confinement is not optional and never degrades.** `confine()` refuses on a platform with no OS
 * sandbox, and this refuses with it. Nothing here has a path that runs a command unconfined.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { Settings } from "./config.ts";
import { homeDir } from "./config.ts";
import { credentialFreeEnv } from "./env.ts";
import { Refused } from "./db/models.ts";
import { newId } from "./db/tx.ts";
import type { RunLog, RunStart } from "./protocol/types.ts";
import type { VenvStatus } from "./sandbox/venv.ts";
import { confine, scientificCaches } from "./sandbox/exec.ts";

/**
 * How long a run may take before it is killed.
 *
 * Generous, because a full-grid measurement over a long index legitimately takes minutes and the
 * first one on a machine pays numba's compilation on top. It exists so a script that waits on a
 * socket nobody is answering cannot hold the conversation open forever, not to police how long
 * honest work takes.
 */
const RUN_TIMEOUT_MS = Number(process.env["YEWREVIEW_RUN_TIMEOUT_MS"] ?? 10 * 60 * 1000);

/** How much of a stream rides back in the tool result. The whole of it is on disk either way. */
const STREAM_HEAD = 8_000;
const STREAM_TAIL = 4_000;

/**
 * How much of a command's output is KEPT IN THE DATABASE, when it is kept clipped.
 *
 * Bigger than what rides back to the model, because these two numbers answer different questions.
 * The tool result is bounded by what is worth spending context on; the stored row is bounded by
 * what a database should hold, and an auditor reading a report's history years later has no run
 * directory left to go to. Sixty-four kilobytes of head is most of any honest program's output.
 */
const KEPT_HEAD = 64_000;
const KEPT_TAIL = 16_000;

/** How much of stderr is appended to a kept output when the command wrote any. A traceback's actual
 * message is at the end, which is the part worth having beside an exit code. */
const KEPT_STDERR = 2_000;

/**
 * Whether a command's output is stored whole or clipped.
 *
 * `verbatim` is for the ENGINE and nothing else, and it is not a knob a caller turns: it follows
 * from the SPEC KIND below, because "kept whole" is a fact about what a measurement report is
 * rather than a preference about one run of it. A measurement report is a document — the same
 * document `thesis_assessment.seikan_report` keeps in full, for the same reason — and a clipped one
 * is not a smaller version of it but a broken one. Everything else is clipped, because a chatty
 * script can print hundreds of megabytes and a database that swallows them is a database nobody can
 * open. The middle is named where it is dropped rather than silently vanishing.
 */
export type Capture = "clipped" | "verbatim";

/** What the caller needs back: everything about how the command went, and where the whole of it is
 * on disk. */
export type ExecOutcome = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** The directory holding the untouched streams, absolute and home-relative. */
  run: { dir: string; relative: string };
};

/** The slice of `ToolDeps` this needs. Narrow on purpose: nothing here reaches the database, and a
 * wrapper that could would be a wrapper that could write a row outside the publish transaction. */
export type ExecDeps = {
  settings: Settings;
  venv: () => VenvStatus;
  runs: RunLog;
};

/** A run of a stored script: the program is named, so the row can name it. */
export type ScriptSpec = {
  script: { id: string };
  /** The argument line as the caller gave it — recorded as typed, whatever argv it became. */
  argument: string;
  argv: readonly string[];
  /** The run directory the caller already staged files into — see `staging` on `SeikanSpec`. */
  staging: { dir: string; relative: string };
};

/**
 * A run of the measurement engine. The caller built the argv; the line is recorded as what ran.
 *
 * The one kind captured VERBATIM, and that is not a field here because it is not a choice: a
 * measurement report is a document, and a clipped document is a broken one. `seikan: true` rather
 * than a `kind` string so the three specs are told apart the way `ScriptSpec` already is — by a
 * property only one of them has.
 */
export type SeikanSpec = {
  seikan: true;
  command: string;
  argv: readonly string[];
  /**
   * The run directory the caller already staged files into — the program, the document, the paths
   * its argv names. ONE DIRECTORY PER RUN is the contract the tests pin: the streams land beside
   * what was staged, and `ExecOutcome.run` names the directory holding the whole of it. Without
   * this the spawn minted a second directory, and `output_directory` pointed at two logs sitting
   * apart from everything else the run left behind.
   */
  staging: { dir: string; relative: string };
};

/** Everything else: only the line is knowable. `argv` when the caller built one, otherwise the
 * command is handed to `/bin/sh -c` and the line is both what ran and what is recorded. */
export type ShellSpec = {
  command: string;
  argv?: readonly string[] | undefined;
};

export function execRecorded(deps: ExecDeps, spec: ScriptSpec): Promise<ExecOutcome>;
export function execRecorded(deps: ExecDeps, spec: SeikanSpec): Promise<ExecOutcome>;
export function execRecorded(deps: ExecDeps, spec: ShellSpec): Promise<ExecOutcome>;
export async function execRecorded(
  deps: ExecDeps,
  spec: ScriptSpec | SeikanSpec | ShellSpec,
): Promise<ExecOutcome> {
  const isScript = "script" in spec;
  const isSeikan = "seikan" in spec;
  const start: RunStart = isScript
    ? { kind: "script", scriptId: spec.script.id, argument: spec.argument }
    : isSeikan
      ? { kind: "seikan", command: spec.command }
      : { kind: "shell", command: spec.command };
  const command =
    isScript || isSeikan ? [...spec.argv] : [...(spec.argv ?? ["/bin/sh", "-c", spec.command])];
  const capture: Capture = isSeikan ? "verbatim" : "clipped";

  const startedAt = Date.now();
  const finish = deps.runs.begin(start, startedAt);
  // A command that never launched is still a line in the history. Confinement refusing, a binary
  // that is not there, a spawn that throws — each is something the procedure tried to do, and a log
  // that recorded only the commands that got as far as a process would be a log that quietly
  // flatters the run. -1 is not an exit code any shell produces, which is what makes it readable as
  // "did not get that far" rather than as an ordinary failure.
  let outcome: ExecOutcome | null = null;
  try {
    outcome = await spawnConfined(deps, command, "staging" in spec ? spec.staging : undefined);
    return outcome;
  } finally {
    if (outcome === null) {
      finish({
        ok: false,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        return: "did not run: the command could not be started",
      });
    } else {
      finish({
        ok: outcome.exitCode === 0,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        return: kept(outcome, capture),
      });
    }
  }
}

/**
 * What goes in the `"return"` column.
 *
 * stdout is the answer and stderr is the context, so they are one column with the second appended
 * under a marker rather than two columns one of which is almost always blank. A verbatim capture
 * keeps both whole.
 */
function kept(outcome: ExecOutcome, capture: Capture): string {
  if (capture === "verbatim") {
    return outcome.stderr === ""
      ? outcome.stdout
      : `${outcome.stdout}\n--- stderr ---\n${outcome.stderr}`;
  }
  const out = clipTo(outcome.stdout, KEPT_HEAD, KEPT_TAIL);
  if (outcome.stderr === "") return out;
  const err = outcome.stderr.slice(-KEPT_STDERR);
  const elided = outcome.stderr.length > KEPT_STDERR ? "… " : "";
  return `${out}\n--- stderr ---\n${elided}${err}`;
}

/** Where a run's untouched streams land: one directory per run, under the agent's own home so the
 * agent can read back what it just produced. */
export function makeRunDir(settings: Settings): { dir: string; relative: string } {
  const home = homeDir(settings);
  const dir = join(home, "runs", newId());
  mkdirSync(dir, { recursive: true });
  return { dir, relative: relative(home, dir) };
}

/**
 * Spawn under the OS sandbox, with a deadline, keeping both streams whole on disk.
 *
 * The streams are written out before they are clipped for anything, so "read the rest in
 * stderr.log" is advice the model can actually take. A timeout kills the process and is reported as
 * one: a run that was cut off produced no answer, and saying it exited is worse than saying nothing.
 */
async function spawnConfined(
  deps: ExecDeps,
  command: string[],
  staging?: { dir: string; relative: string },
): Promise<ExecOutcome> {
  const home = homeDir(deps.settings);
  const wrapped = confine(command, {
    writable: home,
    alsoWritable: scientificCaches(deps.settings.varDir),
    denyRead: [join(deps.settings.varDir, "db")],
  });
  if (!wrapped.ok) throw new Refused("invalid_request", wrapped.message);

  // The caller's staged directory when it has one, so a run's program, document, outputs and
  // streams are one directory rather than two; minted here only for the bare shell, which stages
  // nothing.
  const run = staging ?? makeRunDir(deps.settings);
  const started = Date.now();
  const proc = Bun.spawn(wrapped.command, {
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
    env: runEnv(deps),
  });
  const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const durationMs = Date.now() - started;

  writeFileSync(join(run.dir, "stdout.log"), stdout, "utf8");
  writeFileSync(join(run.dir, "stderr.log"), stderr, "utf8");
  return { exitCode, stdout, stderr, durationMs, timedOut: durationMs >= RUN_TIMEOUT_MS, run };
}

/**
 * The environment a run gets.
 *
 * The API key is stripped: a data script has no business talking to the model's provider, and a key
 * in the environment of a program the agent wrote is a key the agent can exfiltrate through it.
 * `SEIKAN_*` is scrubbed at boot (`env.ts`) because the engine owns that namespace and refuses to
 * run when it meets a variable it does not recognise.
 */
function runEnv(deps: ExecDeps): Record<string, string> {
  const env = credentialFreeEnv();
  env["YEWREVIEW_VAR_DIR"] = deps.settings.varDir;
  // The same name the agent's own shell is given (`claudecode/options.ts`), because it points at the
  // same directory: a program the agent wrote and a command the agent types resolve a relative path
  // identically, and two spellings of one place is how a script ends up writing where nobody looks.
  env["YEWREVIEW_HOME"] = homeDir(deps.settings);
  env["NUMBA_CACHE_DIR"] = join(deps.settings.varDir, "cache", "numba");
  const venv = deps.venv();
  if (venv.python !== null) env["YEWREVIEW_PYTHON"] = venv.python;
  return env;
}

/** An argument line as argv. Whitespace-split and nothing else — the tool's description says so,
 * because a caller who believes this is a shell will eventually pass a pipe and wonder where it
 * went. */
export function argv(argument: string): string[] {
  return argument.split(/\s+/).filter((part) => part !== "");
}

/** Head and tail, with the middle named rather than silently dropped. */
export function clip(stream: string): string {
  return clipTo(stream, STREAM_HEAD, STREAM_TAIL);
}

function clipTo(stream: string, head: number, tail: number): string {
  if (stream.length <= head + tail) return stream;
  const dropped = stream.length - head - tail;
  return (
    stream.slice(0, head) +
    `\n\n… ${dropped} characters omitted; the whole stream is in the run directory …\n\n` +
    stream.slice(-tail)
  );
}

/**
 * One command line, quoted so it can be read back as the thing that ran.
 *
 * The recorded `command` for a run whose argv the caller built itself. Single quotes, with the
 * shell's own escape for an embedded one, because the point is that a person reading the history
 * can paste it — not that anything here will ever parse it again.
 */
export function shellJoin(command: readonly string[]): string {
  return command
    .map((part) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}
