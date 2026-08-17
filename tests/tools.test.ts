/**
 * The agent's toolset, exercised through the handlers themselves.
 *
 * Calling a handler bypasses the zod schema, which is the point: the schema is what a well-behaved
 * client enforces, and everything tested here is what has to hold when one is not. `confirm` is the
 * clearest case — `confirm: false` satisfies a required boolean and means the opposite of what the
 * tool is about to do, so the check that matters lives in the handler and is tested there.
 *
 * Nothing here mocks the database or the filesystem. Most of what these tools promise is a
 * repository refusal, a schema trigger or a row that did or did not appear, and a fake would test
 * the wrong thing. Where a rule is the schema's — a report that cannot be rewritten, a script whose
 * program cannot move, an assessment that cannot be re-worded after the fact — it is proved by
 * trying the write and catching the abort rather than by trusting the wrapper that never attempts
 * it. The run tools are held to the same standard: they spawn real subprocesses under the real OS
 * sandbox, against the project's own venv, and the tests that need one are skipped where it is not
 * installed rather than replaced by a description of what a run would have done.
 *
 * The one thing standing in for something is the generation procedure's run log, because the real
 * one belongs to a live session and this file has no session. `runLogFake` is the same shape and
 * the same rules — a log that exists only while a procedure does, naming the recipe that procedure
 * works to, entries opened when a command is spawned and closed when it exits, engine runs
 * redeemable exactly once — with the levers a test needs hung off the side. The two phases matter
 * here rather than being an implementation detail worth hiding: publishing refuses while an entry
 * is still open, so a test can only reach that state by opening one and never closing it.
 *
 * The GATE is faked for the same reason and with one exception. `procedureFake` records what it was
 * asked and answers with whatever a test scripted, which is what the tool's own suite needs: that it
 * resolves a name to an id before asking, maps each refusal onto the right kind, and hands the brief
 * back where the model reads it. The exception is the refusal a gate alone can produce — a procedure
 * asked for under a RETIRED recipe — which is exercised against a real `GenerationGate` over this
 * harness's own database, because a scripted refusal there would be a test of the script.
 *
 * There is no recipe in `ToolDeps`, and that shapes what several of these tests are about. One
 * conversation works across every recipe the archive holds, so a recipe is an ARGUMENT that the
 * model names and that a refusal names back rather than something the tools close over. `rig` seeds
 * one, because most of what is exercised here needs a specification to publish under — but it is a
 * fixture rather than a boundary, and the suites here prove that a conversation working under one
 * recipe reaches its neighbour.
 */

import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { homeDir, paths } from "../src/config.ts";
import type {
  GenerationEnd,
  EventsFrame,
  OutboundFrame,
  Procedure,
  ProcedureStart,
  RunLog,
  RunLogEntry,
  RunStart,
  SeikanRun,
  ToolDeps,
} from "../src/protocol/types.ts";
import { sdkToolNames, toSdkServer } from "../src/claudecode/mcp.ts";
import { SERVER_NAME } from "../src/protocol/types.ts";
import { announcing } from "../src/tools/index.ts";
import { CONSENT } from "../src/tools/common.ts";
import type { AnyToolDefinition } from "../src/tools/def.ts";
import { strictSchema } from "../src/tools/def.ts";
import * as generationTools from "../src/tools/generation.ts";
import * as recipeTools from "../src/tools/recipes.ts";
import * as recordTools from "../src/tools/records.ts";
import * as reportTools from "../src/tools/reports.ts";
import * as runTools from "../src/tools/runs.ts";
import * as scriptTools from "../src/tools/scripts.ts";
import * as sourceTools from "../src/tools/sources.ts";
import * as targetTools from "../src/tools/targets.ts";
import * as thesisTools from "../src/tools/theses.ts";
import type { ScriptStatus } from "../src/db/models.ts";
import { newId } from "../src/db/tx.ts";
import { GenerationGate } from "../src/generation.ts";
import { listErrors, logWrites } from "../src/repo/logs.ts";
import { getRecipe, setRecipeStatus } from "../src/repo/recipes.ts";
import { getReportContent } from "../src/repo/reports.ts";
import { createScript, setScriptStatus } from "../src/repo/scripts.ts";
import { getSource } from "../src/repo/sources.ts";
import type { VenvStatus } from "../src/sandbox/venv.ts";
import {
  harness,
  seedAssessment,
  seedRecipe,
  seedSource,
  seedTarget,
  seedThesis,
} from "./helpers.ts";
import type { Harness } from "./helpers.ts";

/** A tool result as this codebase shapes it: a summary block and a JSON payload block. */
type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };

type Handler = { name: string; handler: (args: never) => Promise<unknown> };

type Rig = {
  h: Harness;
  db: Database;
  deps: ToolDeps;
  /** The recipe the fixture seeded. A fixture rather than a boundary: the tools take a recipe id
   * as an argument, and several suites below hand them a different one on purpose. */
  recipeId: string;
  /** The agent's one home directory, spelled the way the tools spell it. See `rig`. */
  home: string;
  frames: OutboundFrame[];
  announced: EventsFrame[];
  runs: RunLogFake;
  /** The gate, as the tool that opens a procedure sees it. */
  procedure: ProcedureFake;
  /** Open a procedure under the seeded recipe — what `start_generation` does through the real gate.
   * Called by the suites that are about publishing or about what a run leaves behind; every other
   * suite runs outside one, which is where the freeze means those tools are actually used. */
  openProcedure(): void;
  tool(name: string): Handler;
  /** Whether this boot's roster carries a name, for the pins about tools that are ABSENT. */
  has(name: string): boolean;
  cleanup(): void;
};

const UNAVAILABLE: VenvStatus = {
  ready: false,
  python: null,
  seikanBin: null,
  seikanVersion: null,
  dslGuide: null,
  error: "not provisioned in this test",
};

/** Something shaped like what the engine prints, held by the retained runs the tests that cannot
 * spawn the engine file against. It stands in for the bytes a real run would have kept, not for a
 * report anybody typed: no tool takes one, which is why the tests further down that DO
 * have the engine check the stored column against the file on disk rather than against this. */
const SEIKAN_REPORT = JSON.stringify({
  dsl_hash: "a".repeat(64),
  cells: [{ window: "2024H1", n: 41, t: 2.1 }],
});

/** The project's own venv, when it has the engine importable in it. Used by the tests that must
 * prove the subprocess contract rather than describe it; skipped where it is not installed. */
const LOCAL_PYTHON = (() => {
  const python = resolve(import.meta.dir, "../.venv/bin/python");
  if (!existsSync(python)) return null;
  const probe = Bun.spawnSync([python, "-c", "import seikan.gate"]);
  return probe.exitCode === 0 ? python : null;
})();

/**
 * The same venv's `seikan` CLI, when it answers.
 *
 * Separate from `LOCAL_PYTHON` because they are separate facts: the identity script needs the
 * package importable, and `run_seikan` needs the executable on disk and runnable. A machine can
 * have one without the other — an interrupted install, a wheel unpacked without its entry point —
 * and skipping the engine tests for the wrong reason would hide it.
 */
const LOCAL_SEIKAN = (() => {
  const bin = resolve(import.meta.dir, "../.venv/bin/seikan");
  if (!existsSync(bin)) return null;
  const probe = Bun.spawnSync([bin, "--version"]);
  return probe.exitCode === 0 ? bin : null;
})();

/**
 * The engine's own canonical hash of a document — the same `canonical_dsl_hash` the identity
 * script and the run tools spawn, asked directly.
 *
 * What it seeds is the fixture half of `create_thesis`'s verification: the tool compares the
 * redeemed run's hash against the document's, both computed by this one engine function, so a
 * seeded run that should PASS the check has to carry the hash the engine would actually mint —
 * an invented sixty-four hex characters would test the refusal and nothing else.
 */
function canonicalHash(dsl: unknown): string {
  const script =
    "import json,sys\n" +
    "from seikan.gate import canonical_dsl_hash\n" +
    "print(canonical_dsl_hash(json.loads(sys.stdin.read())))";
  const proc = Bun.spawnSync([LOCAL_PYTHON!, "-c", script], {
    stdin: new TextEncoder().encode(JSON.stringify(dsl)),
  });
  const digest = proc.stdout.toString().trim();
  if (proc.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`canonical_dsl_hash did not answer: ${proc.stderr.toString().slice(-400)}`);
  }
  return digest;
}

/**
 * Whether a run can be CONFINED here, which is a separate question from whether anything can run.
 *
 * The run tools refuse on a platform with no OS sandbox and wrap the argv in bubblewrap on Linux, so
 * a machine with the venv but without bubblewrap installed can measure nothing at all — and a run
 * test failing there would be reporting the environment rather than the code. macOS has Seatbelt
 * built in, which is why the probe is one branch and a `which`.
 */
const CAN_CONFINE =
  process.platform === "darwin" ||
  (process.platform === "linux" && Bun.spawnSync(["which", "bwrap"]).exitCode === 0);

/** True when a script can actually be run here: an interpreter to run it and a sandbox to hold it. */
const CAN_RUN = LOCAL_PYTHON !== null && CAN_CONFINE;

/** True when a real measurement can be run here: the engine binary AND the interpreter that gives a
 * thesis its identity, because a run needs a stored thesis and a stored thesis needs the hash. */
const CAN_MEASURE = CAN_RUN && LOCAL_SEIKAN !== null;

/** The venv as the run tools will actually use it. */
function localVenv(): VenvStatus {
  return {
    ready: true,
    python: LOCAL_PYTHON,
    seikanBin: LOCAL_SEIKAN,
    seikanVersion: "local",
    dslGuide: null,
    error: null,
  };
}

/** A venv that is READY but whose programs are nowhere, for the refusals that must land before
 * anything is spawned. If one of these tests ever reaches a subprocess it fails loudly rather than
 * measuring something. */
const NOWHERE: VenvStatus = {
  ready: true,
  python: "/nowhere/bin/python",
  seikanBin: "/nowhere/bin/seikan",
  seikanVersion: "9.9.9",
  dslGuide: null,
  error: null,
};

/**
 * The generation procedure's run log, as a real object rather than a stub.
 *
 * Everything the tools do with a log is state a test has to be able to see: whether a procedure is
 * in progress at all, what the run tools wrote into it, which recipe it names, and whether
 * publishing closed it. So this is the same shape the session implements — a log that only exists
 * while a generation does, written in TWO PHASES so an entry can be open, a pocket of finished
 * engine runs that are redeemable exactly once — with the three levers a test drives it by hung off
 * the side.
 */
type RunLogFake = RunLog & {
  /** Open a procedure under one recipe. The recipe is the whole pin — its text cannot move, so
   * naming the row names the bytes — and it rides here because `publish_report` reads it off the
   * log rather than off an argument, which is the whole of how a report knows what it was written
   * to. */
  start(recipeId: string): void;
  /** Every reason `end` was called with, in order. A successful publish must leave "published". */
  readonly ended: GenerationEnd[];
  /** Put a finished engine run in the pocket, and hand back the id a judgement redeems it by.
   * `thesisId` null is a document-mode run — the shape `create_thesis` redeems — and `dslHash` is
   * settable because that call verifies the run against the document's own hash. */
  seed(thesisId: string | null, report?: string, dslHash?: string): string;
};

/** The `procedure` capability, with the levers a test drives it by hung off the side. */
type ProcedureFake = Procedure & { readonly started: string[]; next: ProcedureStart };

function runLogFake(): RunLogFake {
  let generation: { recipeId: string; entries: RunLogEntry[] } | null = null;
  const retained = new Map<string, SeikanRun>();
  const ended: GenerationEnd[] = [];
  let minted = 0;

  const retain = (run: Omit<SeikanRun, "runId">): string => {
    minted += 1;
    const runId = `retained-${minted}`;
    retained.set(runId, { ...run, runId });
    return runId;
  };

  return {
    recording: () => generation !== null,
    // Null outside a procedure, exactly as the session's is — the two facts come from one object,
    // so a log that says it is recording always has a recipe to name.
    recipeId: () => generation?.recipeId ?? null,
    // TWO PHASES, exactly as the session's are: the entry is appended when a command is SPAWNED and
    // completed by the finalizer when it exits, so a command still running is in the log with a null
    // outcome and publishing refuses while one is. Both halves are no-ops outside a procedure — the
    // run tools go on working, they simply leave no record, because there is no report for a record
    // to be part of.
    begin: (start, at) => {
      const open = generation;
      if (open === null) return () => {};
      const entry: RunLogEntry = { ...start, at, outcome: null };
      open.entries.push(entry);
      // Closed over the ENTRY rather than over an index, because tool calls can be issued in
      // parallel and a finalizer must settle its own run rather than whichever finished first.
      return (outcome) => {
        entry.outcome = outcome;
      };
    },
    entries: () => generation?.entries ?? [],
    retain,
    // Spent on redemption. A report pasted back through the model can be truncated or improved on
    // the way, so the bytes are handed over once and the token is gone.
    redeem: (runId) => {
      const run = retained.get(runId) ?? null;
      if (run !== null) retained.delete(runId);
      return run;
    },
    end: (reason) => {
      if (generation === null) return;
      generation = null;
      ended.push(reason);
    },
    start(recipeId: string) {
      generation = { recipeId, entries: [] };
    },
    ended,
    seed(thesisId: string | null, report = SEIKAN_REPORT, dslHash = "a".repeat(64)) {
      return retain({ thesisId, dslHash, report, finishedAt: Date.now() });
    },
  };
}

/**
 * One FINISHED run in the log, both halves in one call.
 *
 * The tools write a log entry in two phases — appended when the command is spawned, completed when
 * it exits — and almost every test here wants a run that already happened. The tests that are about
 * the OTHER state call `begin` themselves and never call what it hands back, which is the only way
 * an open entry can be reached at all.
 */
function ran(
  runs: RunLog,
  start: RunStart,
  at: number,
  outcome: { exitCode: number; return: string; durationMs: number },
): void {
  // `ok` is not a fifth fact: it is the exit code read the way every caller reads it, and deriving
  // it here keeps a test from writing down a run that exited 3 and claiming it worked.
  runs.begin(start, at)({ ...outcome, ok: outcome.exitCode === 0 });
}

/** Every tool definition the server is assembled from, in the order `index.ts` assembles them.
 * Built here rather than read back off the MCP server because the server keeps them behind its own
 * registry — and the roster test below checks this list against `toolNames`, so a module added
 * there and forgotten here cannot leave a tool untested. */
function definitions(deps: ToolDeps) {
  return [
    ...recipeTools.build(deps),
    ...recordTools.build(deps),
    ...generationTools.build(deps),
    ...reportTools.build(deps),
    ...runTools.build(deps),
    ...targetTools.build(deps),
    ...thesisTools.build(deps),
    ...sourceTools.build(deps),
    ...scriptTools.build(deps),
  ];
}

function rig(venv: VenvStatus = UNAVAILABLE): Rig {
  const h = harness();
  // The var directory as the KERNEL sees it. A temp directory is reached through /var or /tmp, both
  // symlinks into /private on macOS, and the OS sandbox a run is wrapped in matches on the path the
  // kernel resolved — so a profile written against the symlinked spelling grants writes to a
  // directory that, as far as the sandbox is concerned, nothing is writing to, and every run dies
  // with a permission error about a path the profile appears to allow. The real `var/` is an
  // ordinary directory under the working directory and never hits this; a test's is always a temp
  // one, so the resolution happens here.
  const settings = { ...h.settings, varDir: realpathSync(h.settings.varDir) };
  const recipeId = seedRecipe(h.db);
  const frames: OutboundFrame[] = [];
  // What the window would be told. Collected rather than ignored so the roster test can prove
  // every tool announces — the announcement is structural (a wrapper in `index.ts`, not a line in
  // each handler), and a test that never looked would not notice the wrapper going away.
  const announced: EventsFrame[] = [];
  const runs = runLogFake();
  // The gate, as the tool that opens one sees it: a recorder of what it was asked, and a scripted
  // answer. The real one is a `GenerationGate` belonging to a live session, and what this file is
  // about is the tool — that it resolves a name to an id before asking, maps each refusal onto the
  // right kind, and hands the brief back where the model will read it.
  const procedure: ProcedureFake = {
    started: [],
    next: { ok: true, generationId: "gen-1", recipeId, brief: "THE RECIPE\n\nwork" },
    start(asked: string) {
      procedure.started.push(asked);
      return procedure.next;
    },
  };
  const deps: ToolDeps = {
    db: h.db,
    settings,
    // The writer, which is what almost every test means: the mode is the boot's writer claim
    // (`db/lock.ts`), and the reader's refusals get their own describe through the wrapper.
    mode: "writer",
    venv: () => venv,
    emit: (frame) => frames.push(frame),
    runs,
    procedure,
    events: (frame) => announced.push(frame),
  };
  const all = new Map<string, Handler>(
    definitions(deps).map((t) => [t.name, t as Handler]),
  );
  // ONE home directory for the installation, not one per recipe. `ensureDirs` has already made it
  // under the harness's own spelling of the var directory; this is the realpath'd spelling of the
  // same place, so the mkdir is a no-op that keeps the rig honest if that ever stops being true.
  const home = homeDir(settings);
  mkdirSync(home, { recursive: true });
  // NO PROCEDURE IS OPEN, and the default inverted when the archive learned to hold still. While a
  // generation records, every tool that writes a record is refused except the four that ARE the
  // procedure — so outside one is now the state nearly every tool in this file is used in, and a rig
  // that opened one would be testing the roster in a state most of it cannot be called in. The
  // suites that are about publishing, or about what a run leaves behind, call `openProcedure` first.
  //
  // The freeze itself lives in the `announcing` wrapper and these handlers are the BARE definitions,
  // which is deliberate on both sides: a handler is tested for what it does, and the rule that
  // decides whether it may be reached at all is tested once, through the wrapper, in the describe
  // that is about it.
  return {
    h,
    db: h.db,
    deps,
    recipeId,
    home,
    frames,
    announced,
    runs,
    procedure,
    openProcedure: () => runs.start(recipeId),
    tool(name: string) {
      const found = all.get(name);
      if (!found) throw new Error(`no tool named ${name}`);
      return found;
    },
    /** Whether this boot's roster carries a name, for the pins about tools that are ABSENT. */
    has: (name: string) => all.has(name),
    cleanup: h.cleanup,
  };
}

/**
 * A rig with a procedure already open.
 *
 * The suites that use it are the ones about what happens INSIDE one — publishing, and what a run
 * leaves in the log — which is the minority now that the archive freezes for the duration. Every
 * other suite runs outside a procedure, where the freeze means those tools are actually reachable.
 */
function generating(venv: VenvStatus = UNAVAILABLE): Rig {
  const r = rig(venv);
  r.openProcedure();
  return r;
}

async function call(tool: Handler, args: unknown = {}): Promise<Result> {
  return (await tool.handler(args as never)) as Result;
}

function summary(res: Result): string {
  return res.content[0]!.text;
}

function body(res: Result): Record<string, unknown> {
  return JSON.parse(res.content[1]!.text) as Record<string, unknown>;
}

function failure(res: Result): { error: string; message: string } {
  expect(res.isError).toBe(true);
  return body(res) as unknown as { error: string; message: string };
}

/**
 * A recorded script, through the repository the tool uses.
 *
 * It takes no recipe, because a script does not belong to one, and no settings, because saving a
 * program does not touch the filesystem at all: the row IS the script.
 */
function seedScript(r: Rig, name: string, status: ScriptStatus = "active"): string {
  const script = createScript(r.db, {
    name,
    domain: "prices",
    source: `print("${name}")\n`,
  });
  // Reached the way real code reaches it: nothing is born inactive, and the trigger says so.
  if (status !== "active") setScriptStatus(r.db, script.id, status);
  return script.id;
}

/**
 * File one round of judgement through the tool, and hand back the id of the row it wrote.
 *
 * Almost every test below needs a JUDGED thesis rather than a stored one, and the two are separate
 * acts: `seedThesis` puts the container there and this measures it. The ROW's id is what comes
 * back rather than the thesis's, because a ledger is a sequence of rows and the tests that care
 * about the newest one have to be able to name the older ones it answers.
 *
 * The round is filed against a RUN rather than against a report the caller typed, so this puts a
 * finished run for that thesis in the log's pocket and files against it. That is what a real round
 * does too: `run_seikan` measures, and the id it hands back is what `assess_thesis` redeems.
 */
async function assess(
  r: Rig,
  thesisId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await call(r.tool("assess_thesis"), {
    thesis_id: thesisId,
    tag: "insightful",
    assessment: "Three of five cells fire, and the mechanism holds where they do.",
    seikan_run_id: r.runs.seed(thesisId),
    ...extra,
  });
  expect(res.isError).toBeUndefined();
  return (body(res)["assessment"] as { id: string }).id;
}

/**
 * A tool's top-level schema, strict, exactly as a serving surface builds it.
 *
 * `strictSchema` is the shared guarantee both harnesses apply — it is what turns a raw shape into
 * something that REFUSES a key nobody declared rather than dropping it — so the tests below read the
 * same function the servers do rather than a hand-built copy of it.
 */
function schemaOf(definition: AnyToolDefinition): z.ZodObject {
  return strictSchema(definition);
}

/** Every file under `var/`, var-relative, except the database's own — which moves on its own
 * whenever anything is written and says nothing about whether a tool put a file somewhere. */
function filesUnderVar(r: Rig): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else found.push(relative(r.h.varDir, child).split(sep).join("/"));
    }
  };
  walk(r.h.varDir);
  return found.filter((path) => !path.startsWith("db/")).sort();
}

/** A complete little document, so the publish guard is testing publishing rather than HTML. */
function draft(rig: Rig, relPath: string, extra = ""): string {
  const abs = join(rig.home, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `<!doctype html><html><head><title>A report</title></head><body>${extra}</body></html>`);
  return relPath;
}

/** What `reports/` holds when nothing has been published: the served chart library and nothing
 * else. A report is a row, so this directory never grows a document. */
function reportsDirEntries(r: Rig): string[] {
  return readdirSync(paths(r.h.settings).reportsDir).sort();
}

describe("the assembled server", () => {
  test("exposes exactly this toolset, under one qualified namespace, with no name used twice", () => {
    const r = rig();
    try {
      const names = sdkToolNames(definitions(r.deps));
      expect(new Set(names).size).toBe(names.length);
      expect(names.every((n) => n.startsWith(`mcp__${SERVER_NAME}__`))).toBe(true);
      // The whole list, not a sample of it. A tool appearing is a decision — this surface is
      // deliberately narrow — and a tool DISAPPEARING is one too: the model is told this list is
      // authoritative, so a name that quietly stops existing is a promise quietly withdrawn.
      const expected = [
        "create_recipe",
        "get_recipe",
        "list_recipes",
        "set_recipe_status",
        "delete_recipe",
        "rename_record",
        "start_generation",
        "publish_report",
        "list_reports",
        "delete_report",
        "run_shell",
        "run_script",
        "run_seikan",
        "upsert_target",
        "get_target",
        "list_targets",
        "delete_target",
        "create_thesis",
        "assess_thesis",
        "get_thesis",
        "list_theses",
        "search_theses",
        "delete_thesis",
        "list_information_sources",
        "search_sources",
        "create_information_source",
        "update_information_source",
        "delete_information_source",
        "create_script",
        "set_script_status",
        "get_script",
        "list_scripts",
        "delete_script",
      ];
      expect(expected).toHaveLength(33);
      expect([...names].sort()).toEqual(
        expected.map((name) => `mcp__${SERVER_NAME}__${name}`).sort(),
      );
      expect(toSdkServer(announcing(r.deps)).instance).toBeDefined();
    } finally {
      r.cleanup();
    }
  });

  test("a tool announces that the database moved exactly when it moved rows of it", async () => {
    const r = rig();
    try {
      // The announcement is a WRAPPER in `index.ts`, not a line in each handler, and this is the
      // test that keeps it that way. A per-handler call is a thing to forget: the tool somebody
      // adds next year without one would be invisible to every open window with nothing saying so.
      // So the assertion is made against the server's own registry rather than against a list of
      // tools known to write — and what the wrapper consults is SQLite's own `total_changes()`,
      // which cannot be forgotten either and, unlike the older unconditional version, cannot be
      // wrong about whether anything actually moved.
      const registered = toSdkServer(announcing(r.deps));
      expect(registered.instance).toBeDefined();

      await call(r.tool("create_script"), {
        name: "prices",
        domain: "market data",
        source: "print(1)",
      });
      // The bare definition writes and stays silent: the announcing lives in the wrapper, which is
      // the whole point of exporting it.
      expect(r.announced).toEqual([]);

      // Through what the server actually registers rather than the bare definition beneath it. The
      // MCP server keeps its handlers to itself once built, so `announcing` is exported for exactly
      // this: the thing worth locking is that the wrapper is still in the path.
      const wrapped = new Map(announcing(r.deps).map((t) => [t.name, t as Handler]));
      expect(wrapped.size).toBe(33);

      await call(wrapped.get("create_script")!, {
        name: "volumes",
        domain: "market data",
        source: "print(2)",
      });
      expect(r.announced).toEqual([{ type: "records_changed", at: expect.any(Number) }]);

      // A READ announces nothing. A wrapper firing on every call that did not refuse would teach a
      // window that the frame meaning "the archive moved" sometimes means "the agent looked at
      // something".
      await call(wrapped.get("list_scripts")!, {});
      expect(r.announced).toHaveLength(1);

      // A refusal announces nothing either: nothing moved, and a window told otherwise would re-read
      // the whole graph on every mistyped id.
      await call(wrapped.get("get_script")!, { script_id: "nope" });
      expect(r.announced).toHaveLength(1);
    } finally {
      r.cleanup();
    }
  });

  test("a handler that throws is filed under 'tool', rethrown, and does not move the archive", async () => {
    const r = rig();
    try {
      const wrapped = new Map(announcing(r.deps).map((t) => [t.name, t as Handler]));
      // Only a DEFECT can reach the wrapper's catch: `attempt` turns every repository refusal into
      // a result, so an exception still travelling at this point is YewReview being broken rather
      // than the model being wrong. That is exactly why refusals are never logged and this is — an
      // error log full of mistyped ids is one nobody reads. Provoked by handing a search a number
      // where it reads a string, which throws inside the repository before anything is written.
      await expect(
        call(wrapped.get("search_sources")!, { q: 7 }),
      ).rejects.toThrow();

      const logged = listErrors(r.db, {}).entries;
      expect(logged).toHaveLength(1);
      expect(logged[0]!.scope).toBe("tool");
      // Named, because "a tool threw" with no tool in it is a row nobody can act on.
      expect(logged[0]!.message).toContain("search_sources threw");
      // The stack rides in `detail`, which is the whole reason that column exists: the message
      // names the tool and the stack names the line, and a defect report with only the first is one
      // nobody can open a file from.
      expect(logged[0]!.detail).toContain("repo/sources.ts");

      // AND THE WINDOWS WERE NOT TOLD. This is the half `archiveWrites` exists for: the call wrote
      // exactly one row and it was a LOG row, so `total_changes()` moved and the archive did not.
      // Without the subtraction every crash in the installation would make every open window
      // re-read its whole record browser, and a frame that cries wolf gets ignored.
      expect(r.announced).toEqual([]);
      expect(logWrites(r.db)).toBeGreaterThan(0);

      // A real write still announces, which is what makes the silence above about logs rather than
      // about the wrapper having quietly stopped working.
      await call(wrapped.get("upsert_target")!, { ticker: "NVDA", name: "NVIDIA Corporation" });
      expect(r.announced).toEqual([{ type: "records_changed", at: expect.any(Number) }]);
    } finally {
      r.cleanup();
    }
  });


  test("the names this server does not define are absent from it, not merely unused", () => {
    const r = rig();
    try {
      // Every name a model might reach for and not find, with the reason written down, because each
      // one would be a capability the model was told it had. `land_outputs`, `list_series`,
      // `delete_series` and `list_dataset` have no subject: where a CSV sits while the engine reads
      // it is an argument to a run, not a fact this database keeps. `list_claims` has none either,
      // and it has one less subject than it once did: what a report says it quoted from where was
      // the model's own account of its reading, nothing ever checked it, and the table that held it
      // is gone — a claim now lives in the document and nowhere else. `set_thesis_tag` is absent
      // because judgement is a ledger rather than a column to overwrite.
      //
      // THE SIX DRAFT TOOLS ARE THE INTERESTING ABSENCE, and they stayed absent through the change
      // that made every other name on the old version of this list real. The specification and the
      // address book are now written from here, so it would have been easy to reach for a draft
      // table on the way — the agent types the next one into a box, the user presses save. That
      // is ceremony rather than protection: committing another party's text is not writing, and the
      // rule that actually holds is the one on the tools themselves — render the WHOLE of what will
      // be stored, wait, and record it once they have said so. There is no mechanical half to it
      // and deliberately no attempt at one.
      //
      // `add_information_source` and `record_source_failure` are the two SPELLINGS nothing answers
      // to. The address book's writers are `create_information_source` and
      // `update_information_source`; a failure is a dated line appended to `failure_cases` through
      // the second of those, because a failure that happened stays true and a tool of its own would
      // suggest the field could be replaced rather than grown.
      //
      // `rename_workshop` AND ITS COUSINS ARE THE LAST GROUP, and the reason is that ONE tool covers
      // every table. `rename_record` takes the table as an argument, so a per-table rename would be
      // a second implementation of a rule that has exactly one — and the table that most wants a
      // rename tool is whichever one the model happened to be looking at, which is the worst
      // possible way to pick.
      //
      // THE WORKSHOP AND PLAYBOOK NAMES ARE THE DEPARTED ONES, and they are pinned as absent
      // because they were real for a long time and a model that had learned them would keep
      // reaching. Instructions lived in a `playbook` ledger hung off a `workshop`, appended version
      // by version, with the operative one derived as the newest row; a recipe is ONE immutable row
      // with a status, so the container, the ledger and every tool for walking it went together.
      // `set_script_tag` went the same way, for the same reason wearing a different word: a script
      // has a STATUS now, and `abandoned` was the tag that no longer means anything.
      //
      // `revise_recipe` IS THE POINTED ONE AND MUST STAY ABSENT. A recipe's text is immutable —
      // `recipe_moves_only_its_status` enforces it in the schema — so a tool to revise one could not
      // be implemented honestly, and its existence would suggest that a report's stated provenance
      // can drift away from the instructions that actually produced it. A method that has moved on
      // is a NEW recipe with the old one set inactive.
      const undefinedNames = [
        "rename_workshop",
        "rename_thesis",
        "rename_script",
        "create_workshop",
        "delete_workshop",
        "list_workshops",
        "get_playbook",
        "list_playbook_history",
        "revise_playbook",
        "delete_playbook_version",
        "set_script_tag",
        "revise_recipe",
        "land_outputs",
        "list_series",
        "delete_series",
        "list_dataset",
        "list_claims",
        "set_thesis_tag",
        "get_workflow",
        "revise_workflow",
        "list_workflow_history",
        "read_playbook_draft",
        "take_playbook_draft",
        "write_playbook_draft",
        "take_source_draft",
        "write_source_draft",
        "list_source_drafts",
        "add_information_source",
        "record_source_failure",
      ];
      const names = new Set(sdkToolNames(definitions(r.deps)));
      for (const absent of undefinedNames) {
        expect(names.has(`mcp__${SERVER_NAME}__${absent}`)).toBe(false);
      }
    } finally {
      r.cleanup();
    }
  });

  test("the tools that write the user's own documents carry the consent rule in their descriptions", () => {
    const r = rig();
    try {
      // WHY THIS IS ON THE TOOLS AND NOT ONLY IN THE PROMPT, and why that makes it a test. The
      // system prompt tells the model its tool list is authoritative wherever the two disagree, so a
      // rule living only in the prompt is one the model is entitled to treat as out of date the
      // moment a tool description says something narrower. These three write documents that are the
      // USER's rather than the agent's account of anything — the specification they are
      // commissioning work against, and their standing account of where their numbers come from —
      // and what replaced the form they used to be typed into is exactly this sentence.
      //
      // One constant rather than three descriptions saying similar things, because three would come
      // to disagree about what agreement is: the assertion is on `CONSENT` itself, imported from
      // where the tools import it.
      const described = new Map(definitions(r.deps).map((d) => [d.name, d.description]));
      for (const tool of [
        "create_recipe",
        "create_information_source",
        "update_information_source",
        "create_thesis",
      ]) {
        expect(`${tool}: ${described.get(tool)}`).toContain(CONSENT);
      }
      // And the load-bearing halves of it, spelled out here so that a rewrite of the constant that
      // quietly dropped one would fail rather than pass by still being a paragraph about consent.
      expect(CONSENT).toContain("CALL THIS ONLY AFTER THE USER HAS AGREED TO WHAT IT WILL WRITE");
      expect(CONSENT).toContain("render the COMPLETE thing in your reply");
      expect(CONSENT).toContain("A message that merely opens the subject authorises nothing");
      expect(CONSENT).toContain("render the whole of it again rather than the diff");

      // AND THE PIN, which is the half that survives a scrolling conversation. Showing the draft
      // once satisfies every sentence above it and still lets somebody agree to wording they can no
      // longer see, four messages and two corrections later; the draft is therefore restated at the
      // end of every reply until it is stored or dropped.
      expect(CONSENT).toContain("END EVERY REPLY with the complete current draft");
      expect(CONSENT).toContain("The last thing on their screen is what they are agreeing to");

      // AND ITS TWO EDGES, both stated because each has a failure mode the middle does not. The
      // block is COMPLETE — every field the tool takes, none of the machine's — because a field
      // left out to tidy the card is a field nobody answered, and an id or a timestamp is nothing
      // anybody agrees to. And the drafting ENDS at the save: a block rendered after recording
      // reads as a question still open, so the confirmation is the tool's own sentence.
      expect(CONSENT).toContain("EVERY field the tool takes is in the block");
      expect(CONSENT).toContain("no id, no timestamp, nothing the database writes for itself");
      expect(CONSENT).toContain("ONCE IT IS RECORDED THE DRAFTING IS OVER");
      expect(CONSENT).toContain("do not render the block again");

      // AND THE GRAMMAR IT IS RENDERED IN, which is pinned because the window depends on it. A draft
      // is a ROW BLOCK: `web/src/lib/rowBlock.ts` parses exactly this shape and `rowCard.ts` draws
      // the card, so the fence marker, the indent rule and the unfilled mark are a contract between
      // two files rather than a preference about layout. The mark especially — a field the agent has
      // not filled in has to be VISIBLE as unfilled, and freehand markdown left that as a heading
      // with nothing under it, a sentence apologising for the gap, or a line simply missing.
      expect(CONSENT).toContain("as a row block");
      expect(CONSENT).toContain("~~~row");
      expect(CONSENT).toContain("**** on any field not filled in yet");
      expect(CONSENT).toContain("a code value as its own backtick fence inside");
      expect(CONSENT).toContain("one whole row block");
      // And the wording it replaced is gone rather than sitting beside it: two instructions about
      // how to render a draft is one the model gets to choose between.
      expect(CONSENT).not.toContain("as ordinary markdown");
      expect(CONSENT).not.toContain("never fenced as code");

      // AND THE THESIS'S SECOND HALF, which is what the rule alone would not say. A thesis is agreed
      // in two pieces — the claim, and the DSL that makes it measurable — and only one of them is
      // the thing the reader had in mind. So the description says both are shown, and says the one
      // place agreement stops being the test: a document bent toward the answer somebody wanted
      // still measures something and is wrong in every future reading of it.
      const thesis = described.get("create_thesis") ?? "";
      expect(thesis).toContain("BOTH HALVES ARE AGREED");
      expect(thesis).toContain("Correct their mistakes out loud");
      expect(thesis).toContain(
        "never bend the document toward a formulation because they pushed for it",
      );
      expect(thesis).toContain("A measurement shaped to please whoever commissioned it measures");
      // And the seam the first reading rides across without moving: it is SHOWN with the draft,
      // because consent is given to what is on screen — and it is not up for negotiation, because
      // consent is to the storing and the tag is the surface's own reading of the run.
      expect(thesis).toContain("one act, one transaction");
      expect(thesis).toContain("not theirs to bargain");
      expect(thesis).toContain("it goes unstored");

      // THE TOOLS THAT DO NOT CARRY IT ARE NOT AN OVERSIGHT. A delete has `confirm`, which is the
      // mechanical form of the same conversation, and says in its own words what to ask about
      // first; a rename writes a label rather than a document, and its rule is narrower — carry out
      // the rename you were asked for, do not tidy. `set_recipe_status` writes no text at all: the
      // specification it retires is one the user already agreed to, word for word, and the move it
      // makes is the one the consent rule on `create_recipe` points at when a method has changed.
      // Handing all of them the same paragraph would make the strongest sentence in this toolset
      // ordinary.
      //
      // `assess_thesis` is the pointed one. Its container takes consent and its LEDGER does not, and
      // that seam is the doctrine rather than an omission: what a thesis claims is the user's, and
      // how it reads once the engine has measured it is the agent's own judgement. A reading the
      // user had to approve would be a reading shaped by whoever was hoping for one.
      for (const tool of [
        "delete_information_source",
        "rename_record",
        "set_recipe_status",
        "assess_thesis",
      ]) {
        expect(`${tool}: ${described.get(tool)}`).not.toContain(CONSENT);
      }
      expect(described.get("delete_information_source")).toContain(
        "say what the row is and that nothing will notice it is gone",
      );
      expect(described.get("rename_record")).toContain("still not yours to do unasked");
    } finally {
      r.cleanup();
    }
  });

  test("a recipe is an argument everywhere except publishing, which takes it off the procedure", () => {
    const r = rig();
    try {
      // The rule, locked. There is one conversation and it works across every recipe the archive
      // holds, so a recipe the tools closed over would be a lie they told themselves — whichever
      // one happened to be in force, silently applied to a call about a different one. The tools
      // that act on a recipe therefore name it in their schema.
      const shapes = new Map(
        definitions(r.deps).map((d) => [d.name, Object.keys(schemaOf(d).shape)]),
      );
      for (const named of [
        "get_recipe",
        "delete_recipe",
        "set_recipe_status",
        "start_generation",
      ]) {
        expect(shapes.get(named)).toContain("recipe_id");
      }
      // Optional on the one read that spans the archive by default.
      expect(shapes.get("list_reports")).toContain("recipe_id");

      // And ONE tool must not be told, which is the exception the rule is for. `publish_report`
      // reads its recipe off the generation procedure, because that procedure named the
      // specification the report is recorded against when it opened — a model free to name the
      // recipe could name one this procedure never opened against, and the document would go out
      // claiming provenance from instructions nobody was working to.
      expect(shapes.get("publish_report")).not.toContain("recipe_id");
    } finally {
      r.cleanup();
    }
  });

  test("an id argument takes the record's name too, and says so in its own description", async () => {
    // WHY THIS EXISTS AT ALL. A name is what a mention on the wire carries — a drag from the record
    // browser puts `@table:name` in the composer — and a user saying "the semis recipe" is
    // pointing at a row as precisely as any uuid does. So every `*_id` argument on this surface
    // resolves either, through ONE function, rather than each tool deciding for itself what its
    // argument is allowed to be. Ids remain what every RESULT hands back: they survive a rename and
    // a name does not.
    const r = rig();
    try {
      const recipe = seedRecipe(r.db, "Named recipe");
      const scriptId = body(
        await call(r.tool("create_script"), {
          name: "prices",
          domain: "daily bars",
          source: "print(1)\n",
        }),
      )["script_id"] as string;

      // The same call twice, once each way, and the same answer both times.
      const byId = body(await call(r.tool("get_recipe"), { recipe_id: recipe }));
      const byName = body(await call(r.tool("get_recipe"), { recipe_id: "Named recipe" }));
      expect(byName).toEqual(byId);
      expect(byName["recipe_id"]).toBe(recipe);

      // And on a tool whose own result minted the name: `create_script` says what it recorded, and
      // that string is an argument the next call can use.
      const read = body(await call(r.tool("get_script"), { script_id: "prices" }));
      expect(read["script_id"]).toBe(scriptId);

      // A word neither an id nor a name is refused NAMING BOTH WAYS IN, because a caller holding a
      // stale name and one holding a mistyped id need the same next step and neither can tell from
      // the outside which they are.
      const missing = failure(await call(r.tool("get_script"), { script_id: "not a script" }));
      expect(missing.error).toBe("not_found");
      expect(missing.message).toBe(
        'no script answers to "not a script" — give either its id or its name, exactly as the ' +
          "record carries it",
      );

      // The descriptions say so, which is the half a handler cannot: a model told only "the id"
      // would go looking one up before every call it could have made from what it already had.
      const shapes = new Map(definitions(r.deps).map((d) => [d.name, schemaOf(d)]));
      for (const [tool, field] of [
        ["get_recipe", "recipe_id"],
        ["delete_recipe", "recipe_id"],
        ["get_script", "script_id"],
        ["get_thesis", "thesis_id"],
        ["delete_report", "report_id"],
      ] as const) {
        const described = (shapes.get(tool)!.shape[field] as z.ZodType).description ?? "";
        expect(`${tool}.${field}: ${described}`).toContain("or its name");
      }
    } finally {
      r.cleanup();
    }
  });

  test("an argument that is id-shaped is tried as an id first, whatever anybody has been renamed to", async () => {
    // THE ORDER IS THE RULE, and it is what keeps the answer a function of the argument alone. A
    // user may reword a name to anything, an id-shaped string included; a resolver that guessed
    // would then answer differently depending on what somebody had typed into a name field, and the
    // row a tool acted on would depend on a third row nobody mentioned.
    const r = rig();
    try {
      const first = body(
        await call(r.tool("create_script"), {
          name: "prices",
          domain: "daily bars",
          source: "print(1)\n",
        }),
      )["script_id"] as string;
      const second = body(
        await call(r.tool("create_script"), {
          name: "volumes",
          domain: "daily bars",
          source: "print(2)\n",
        }),
      )["script_id"] as string;

      // The second script renamed to the first one's id — written straight in rather than through
      // `rename_record`, which would allow it: a name is unique within its table and an id-shaped
      // string is a perfectly good name, so nothing anywhere refuses this. That is the point. The
      // state is reachable, so the resolver has to be right about it rather than protected from it.
      r.db.query("UPDATE script SET name = ? WHERE id = ?").run(first, second);

      const read = body(await call(r.tool("get_script"), { script_id: first }));
      expect(read["script_id"]).toBe(first);
      expect(read["name"]).toBe("prices");
    } finally {
      r.cleanup();
    }
  });

  test("every tool refuses an argument nobody declared, rather than dropping it on the floor", () => {
    const r = rig();
    try {
      const defs = definitions(r.deps);
      // The whole server, not the modules this test happened to remember: a tool that slipped out
      // of this list would be a tool whose strictness nothing checks.
      expect(defs.map((d) => `mcp__${SERVER_NAME}__${d.name}`).sort()).toEqual(
        [...sdkToolNames(definitions(r.deps))].sort(),
      );

      for (const def of defs) {
        // An undeclared key is REFUSED, and refused as itself: plain `z.object` strips one in
        // silence, so an argument the model misspelled would reach the handler as an absent one
        // and the call would succeed having quietly done less than it was asked. The issue code is
        // the assertion — the rest of the object is missing required fields too, and a bare
        // `success === false` would pass just as well against a schema that is not strict at all.
        const outcome = schemaOf(def).safeParse({ surprise_argument: 1 });
        expect(outcome.success).toBe(false);
        const codes = outcome.error!.issues.map((issue) => issue.code);
        expect(codes).toContain("unrecognized_keys");
      }
    } finally {
      r.cleanup();
    }
  });
});

describe("the recipe, which the agent records and the user agrees to", () => {
  test("one is stored ACTIVE, under a name minted from the hint, holding the text it was given", async () => {
    const r = rig();
    try {
      const content = "## Every quarter\n\nAsk what changed, then say what it is worth.";
      const res = await call(r.tool("create_recipe"), { name: "Semis, quarterly", content });
      expect(res.isError).toBeUndefined();
      const out = body(res);

      // BORN ACTIVE, and the summary says so rather than leaving it to be discovered: a stored
      // specification is one a report can be generated to, and there is no second call to make it
      // so. The name is a HINT slugified, handed straight back, so the next turn can address the
      // row with what it was actually given rather than with what it asked for.
      expect(out["status"]).toBe("active");
      expect(out["name"]).toBe("semis-quarterly");
      expect(summary(res)).toBe(
        "Stored semis-quarterly, active. A report can be generated to it now, and its text will " +
          "not change.",
      );

      // The text comes back byte for byte, which is the whole of what agreeing to one meant: the
      // bytes the user read are the bytes stored, and `get_recipe` is where a later turn reads them.
      const read = body(await call(r.tool("get_recipe"), { recipe_id: out["recipe_id"] }));
      expect(read["content"]).toBe(content);
      expect(read["report_count"]).toBe(0);
      expect(Object.keys(read).sort()).toEqual([
        "content",
        "created_at",
        "name",
        "recipe_id",
        "report_count",
        "status",
        "updated_at",
      ]);
    } finally {
      r.cleanup();
    }
  });

  test("its text cannot move afterwards, which is what a version ledger used to buy", () => {
    const r = rig();
    try {
      // WHAT REPLACED THE LEDGER, PINNED AT THE SCHEMA. Instructions used to be an append-only
      // `playbook` table: the operative version was the newest row, a report named the exact
      // version that produced it, and publishing had to re-read the head and refuse when it had
      // moved underneath a procedure. All of that existed so that no report is left pointing at
      // text that changed. Immutability buys it outright — so there is no revision to refuse,
      // nothing for a procedure to re-check at publish time, and no `revise_recipe` anywhere on
      // this surface.
      expect(r.has("revise_recipe")).toBe(false);
      expect(() =>
        r.db.query("UPDATE recipe SET content = ? WHERE id = ?").run("Something else.", r.recipeId),
      ).toThrow(/immutable/);
      expect(() =>
        r.db.query("UPDATE recipe SET created_at = 1 WHERE id = ?").run(r.recipeId),
      ).toThrow(/immutable/);
      expect(() =>
        r.db.query("UPDATE recipe SET id = 'elsewhere' WHERE id = ?").run(r.recipeId),
      ).toThrow(/immutable/);
      expect(getRecipe(r.db, r.recipeId)!.content).toBe("Write a report.");

      // TWO COLUMNS ARE NOT IN THAT LIST, and neither absence is an oversight. The name is a
      // condensed summary the user may reword, and the status is the one thing about a recipe that
      // is allowed to change — a method that has moved on is retired, not rewritten.
      r.db.query("UPDATE recipe SET name = 'reworded' WHERE id = ?").run(r.recipeId);
      expect(getRecipe(r.db, r.recipeId)!.name).toBe("reworded");
      expect(setRecipeStatus(r.db, r.recipeId, "inactive").status).toBe("inactive");

      // AND NOTHING IS BORN RETIRED, which is the trigger that makes "stored active" a fact about
      // the database rather than about this surface.
      expect(() =>
        r.db
          .query(
            "INSERT INTO recipe (name, id, content, status, created_at, updated_at) " +
              "VALUES ('smuggled', ?, 'x', 'inactive', 1, 1)",
          )
          .run(newId()),
      ).toThrow(/not born inactive/);
    } finally {
      r.cleanup();
    }
  });

  test("retiring one keeps its text and every report under it, and reviving is one call", async () => {
    const r = rig();
    try {
      // A report published under this recipe, written straight in because the row IS the document
      // and what is under test is what retiring does NOT touch.
      const reportId = newId();
      r.db
        .query(
          "INSERT INTO report (name, id, recipe_id, title, content, created_at) " +
            "VALUES ('standing', ?, ?, 'Standing', ?, 1)",
        )
        .run(reportId, r.recipeId, "<!doctype html><title>t</title><p>Revenue was $3.1bn.</p>");

      const retired = await call(r.tool("set_recipe_status"), {
        recipe_id: r.recipeId,
        status: "inactive",
      });
      expect(retired.isError).toBeUndefined();
      expect(summary(retired)).toContain("is now inactive");
      expect(body(retired)["status"]).toBe("inactive");

      // NOTHING WENT WITH IT. The specification still reads as it did and the report published to
      // it still stands, because that document was written to exactly these words and still is —
      // which is the whole difference between retiring a recipe and deleting one.
      const read = body(await call(r.tool("get_recipe"), { recipe_id: r.recipeId }));
      expect(read["content"]).toBe("Write a report.");
      expect(read["report_count"]).toBe(1);
      expect(getReportContent(r.db, reportId)).toContain("Revenue was $3.1bn.");

      // Already-inactive is refused rather than treated as a no-op: the write would move
      // `updated_at`, which on a recipe means "when its standing last changed".
      const again = failure(
        await call(r.tool("set_recipe_status"), { recipe_id: r.recipeId, status: "inactive" }),
      );
      expect(again.error).toBe("conflict");
      expect(again.message).toContain("already inactive");

      // And a recipe may come back, unlike a thesis: two specifications saying similar things are
      // two specifications, so there is nothing for reviving one to collide with.
      const revived = await call(r.tool("set_recipe_status"), {
        recipe_id: r.recipeId,
        status: "active",
      });
      expect(revived.isError).toBeUndefined();
      expect(body(revived)["status"]).toBe("active");
    } finally {
      r.cleanup();
    }
  });

  /*
   * THERE IS NO TEST HERE FOR RETIRING THE RECIPE A PROCEDURE IS WORKING TO, and the gap is the
   * decision rather than an oversight. The tool carries no refusal of its own for that case,
   * because one could never fire: `announcing` evaluates the freeze BEFORE the handler, so a call
   * made while a procedure records is answered by the freeze, and a call made outside one finds no
   * procedure to collide with. What refuses it is pinned in "the archive holds still while a
   * procedure records" below, over every frozen tool at once and through the wrapper a serving
   * surface actually goes through — which is the only place the assertion is about production
   * rather than about a bare handler this file reached past it.
   */

  test("the repository's refusals are the tool's: no name, no instructions, and a recipe that is not there", async () => {
    const r = rig();
    try {
      // Rules that belong one layer down, surfacing here as results the model can act on rather
      // than as exceptions. None is re-implemented in the tool: `attempt` converts what
      // `repo/recipes.ts` throws, so whoever reaches the repository another way is refused in the
      // same sentence for the same reason.
      const nameless = failure(await call(r.tool("create_recipe"), { name: "  ", content: "x" }));
      expect(nameless.error).toBe("invalid_request");
      expect(nameless.message).toContain("a recipe needs a name");

      const blank = failure(
        await call(r.tool("create_recipe"), { name: "Semis", content: "   " }),
      );
      expect(blank.error).toBe("invalid_request");
      expect(blank.message).toContain("a recipe needs instructions");

      const nowhere = failure(await call(r.tool("get_recipe"), { recipe_id: "no-such-recipe" }));
      // `not_found` from the resolver, naming both ways in: a caller holding a stale name and one
      // holding a mistyped id need the same next step.
      expect(nowhere.error).toBe("not_found");
      expect(nowhere.message).toContain("give either its id or its name");

      // Nothing landed for any of the three: the archive still holds the one the fixture seeded.
      expect(r.db.query("SELECT COUNT(*) AS n FROM recipe").get()).toEqual({ n: 1 });
    } finally {
      r.cleanup();
    }
  });

  test("reading names a recipe, and does not lean on the one that is generating", async () => {
    const r = generating();
    try {
      // A procedure works to one recipe; reading another's specification while that runs is an
      // ordinary read, and this is the call a closed-over recipe could not express.
      const other = seedRecipe(r.db, "Next door", "Lead with the numbers.");
      const read = body(await call(r.tool("get_recipe"), { recipe_id: other }));
      expect(read["recipe_id"]).toBe(other);
      expect(read["content"]).toBe("Lead with the numbers.");
      expect(r.runs.recipeId()).toBe(r.recipeId);
    } finally {
      r.cleanup();
    }
  });
});

describe("start_generation", () => {
  test("names the recipe by id or by name, and refuses one that is neither", async () => {
    const r = rig();
    try {
      // Resolved before the gate is asked, like every other `*_id` argument on this surface: a name
      // is what a mention on the wire carries, so the tool that opens a procedure takes one too.
      const byId = await call(r.tool("start_generation"), { recipe_id: r.recipeId });
      expect(byId.isError).toBeUndefined();
      expect(r.procedure.started).toEqual([r.recipeId]);

      const named = r.db
        .query<{ name: string }, [string]>("SELECT name FROM recipe WHERE id = ?")
        .get(r.recipeId)!.name;
      await call(r.tool("start_generation"), { recipe_id: named });
      expect(r.procedure.started).toEqual([r.recipeId, r.recipeId]);

      // And a recipe that is neither is refused HERE, before the gate is troubled — the sentence
      // names both ways in, which the gate's own `not_found` could not do.
      const refusal = failure(await call(r.tool("start_generation"), { recipe_id: "nope" }));
      expect(refusal.error).toBe("not_found");
      expect(r.procedure.started).toHaveLength(2);
    } finally {
      r.cleanup();
    }
  });

  test("hands the recipe back as the result, where the model is already reading", async () => {
    const r = rig();
    try {
      r.procedure.next = {
        ok: true,
        generationId: "gen-7",
        recipeId: r.recipeId,
        brief: "The recipe semis (id rc1) — the report specification\n\nLead with the numbers.",
      };
      const res = await call(r.tool("start_generation"), { recipe_id: r.recipeId });

      // THE BRIEF IS THE FIRST BLOCK, where a result's human-readable summary goes, because here
      // the summary IS the payload: the model has to READ the specification, not be told that one
      // exists. It used to arrive as a whole new turn, submitted by whoever pressed the button.
      expect(summary(res)).toContain("Lead with the numbers.");
      // TWO FACTS AND NO THIRD. The pin used to be a pair — the workshop, and the exact playbook
      // version in force when the procedure opened — because instructions could be revised
      // underneath a report. A recipe's text cannot move, so naming the row names the bytes.
      expect(body(res)).toEqual({
        generation_id: "gen-7",
        recipe_id: r.recipeId,
      });
    } finally {
      r.cleanup();
    }
  });

  test("every way the gate can say no arrives as a refusal the model can act on", async () => {
    const r = rig();
    try {
      // The mapping is exhaustive over the gate's closed union, which is what makes a rung added to
      // its ladder a compile error here rather than a refusal kind nobody chose. The interesting
      // one is the engine: `venv_unavailable` carries the hint that says to state the absence
      // plainly rather than describing numbers that could not be computed.
      const cases = [
        ["conflict", "conflict", "a generation procedure is already running, under recipe rc9"],
        ["not_found", "not_found", "no recipe rc1"],
        ["engine_unavailable", "venv_unavailable", "the measurement engine is not installed"],
        ["closed", "conflict", "the agent has been shut down"],
      ] as const;
      for (const [code, kind, message] of cases) {
        r.procedure.next = { ok: false, code, message };
        const refusal = failure(
          await call(r.tool("start_generation"), { recipe_id: r.recipeId }),
        );
        expect(`${code} -> ${refusal.error}`).toBe(`${code} -> ${kind}`);
        expect(refusal.message).toBe(message);
      }
    } finally {
      r.cleanup();
    }
  });

  test("a RETIRED recipe is refused, and the refusal names the one move back", async () => {
    const r = rig();
    try {
      // THE REAL GATE, for the one refusal a scripted one could only describe. Everything else in
      // this suite is about the tool — resolving a name, mapping a kind, handing back the brief —
      // and a fake is the right stand-in for that. Whether an INACTIVE recipe may be generated to
      // is the gate's own rule, read off this harness's database, so the fake is set aside here and
      // the real object answers.
      const gate = new GenerationGate({
        db: r.db,
        emit: (frame) => r.frames.push(frame),
        venv: () => localVenv(),
        closed: () => false,
        // A procedure rides the turn that opens it, and a tool call IS inside one.
        turnInFlight: () => true,
      });
      r.deps.procedure = gate;
      setRecipeStatus(r.db, r.recipeId, "inactive");

      const refusal = failure(
        await call(r.tool("start_generation"), { recipe_id: r.recipeId }),
      );
      expect(refusal.error).toBe("conflict");
      // Retired is a decision somebody made: a report published under it would claim instructions
      // that are no longer in use, and the refusal has to say so rather than reading as a missing
      // row.
      expect(refusal.message).toContain("is inactive");
      expect(refusal.message).toContain("no longer in use");
      // AND THE WAY BACK IS NAMED, because a person who meant to write that report is one call from
      // being able to. A refusal a model cannot act on is one it will retry.
      expect(refusal.message).toContain("set_recipe_status");
      expect(r.frames).toEqual([]);

      // Active again, and the same call opens a procedure — which is what makes the refusal about
      // the standing rather than about the gate refusing everything.
      setRecipeStatus(r.db, r.recipeId, "active");
      const started = await call(r.tool("start_generation"), { recipe_id: r.recipeId });
      expect(started.isError).toBeUndefined();
      expect(body(started)["recipe_id"]).toBe(r.recipeId);
      expect(r.frames).toEqual([
        { type: "generation_started", generationId: expect.any(String), recipeId: r.recipeId },
      ]);
    } finally {
      r.cleanup();
    }
  });

  test("it asks for no agreement, because a report is not a document anybody authors", async () => {
    const r = rig();
    try {
      // THE ABSENCE, PINNED. The tools that carry `CONSENT` write documents the USER authors — a
      // specification, an address book entry, a claim about the market — and the rule exists so
      // nobody's words are stored without them having read them. Nobody authors a report: there is
      // no draft to show before starting, because the procedure is what produces one, and asking
      // again would be asking permission for work that has just been requested.
      const described = new Map(definitions(r.deps).map((d) => [d.name, d.description]));
      expect(described.get("start_generation")).not.toContain(CONSENT);
      // And it says so positively, so the model does not supply the ceremony itself.
      expect(described.get("start_generation")).toContain("being asked is the authorisation");
      expect(described.get("start_generation")).toContain("nothing to confirm");
    } finally {
      r.cleanup();
    }
  });
});

describe("the archive holds still while a procedure records", () => {
  /** The tools as a SERVING SURFACE gets them. The freeze lives in the `announcing` wrapper, which
   * is the one path both harnesses share; the bare handlers this file calls everywhere else are
   * deliberately underneath it. */
  function served(r: Rig): Map<string, Handler> {
    return new Map(announcing(r.deps).map((t) => [t.name, t as Handler]));
  }

  test("every tool that writes a record is refused, and the four that are the procedure are not", async () => {
    const r = generating();
    try {
      const wrapped = served(r);
      const frozen = announcing(r.deps).filter((d) => !d.readOnly && !d.openDuringProcedure);
      // Sixteen of them, and the count is asserted so that a tool quietly gaining the exemption
      // shows up here as well as in the list below.
      expect(frozen).toHaveLength(16);

      for (const definition of frozen) {
        // Called with nothing at all: the freeze answers before the handler ever sees the
        // arguments, which is itself the assertion that the check precedes `invoke`. A handler
        // reached with `{}` would refuse about a missing field instead.
        const refusal = failure(await call(wrapped.get(definition.name)!, {}));
        expect(`${definition.name}: ${refusal.error}`).toBe(`${definition.name}: conflict`);
        expect(refusal.message).toContain("while a generation procedure is recording");
        // Named by the recipe the procedure works to, because that is what the report being
        // written is being read against.
        expect(refusal.message).toContain(`(recipe ${r.recipeId})`);
        // The way out is named, because a refusal a model cannot act on is one it will retry.
        expect(refusal.message).toContain("once the procedure has ended");
      }

      // NOTHING MOVED AND NOTHING WAS ANNOUNCED. A freeze that fired after a write would be worse
      // than none at all, and a window told the archive had moved would re-read it for nothing.
      expect(r.announced).toEqual([]);
      expect(listErrors(r.db, {}).entries).toEqual([]);

      // THE EXEMPT SET, BY NAME. These four are the procedure — the only shell it has, and the tool
      // that ends it — plus the one that opens one, whose own refusal for an already-open procedure
      // names the recipe holding it and is the more useful sentence.
      const exempt = announcing(r.deps)
        .filter((d) => d.openDuringProcedure)
        .map((d) => d.name)
        .sort();
      expect(exempt).toEqual([
        "publish_report",
        "run_script",
        "run_seikan",
        "run_shell",
        "start_generation",
      ]);
    } finally {
      r.cleanup();
    }
  });

  test("reading is never frozen, because a report is written by reading the archive", async () => {
    const r = generating();
    try {
      const wrapped = served(r);
      const res = await call(wrapped.get("list_recipes")!, {});
      expect(res.isError).toBeUndefined();
      expect((body(res)["recipes"] as unknown[]).length).toBeGreaterThan(0);
    } finally {
      r.cleanup();
    }
  });

  test("outside a procedure the same tools write, which is what the freeze is a freeze OF", async () => {
    const r = rig();
    try {
      const wrapped = served(r);
      const res = await call(wrapped.get("create_thesis")!, {
        name: "dip buying",
        content: "Dips are bought.",
        dsl_json: JSON.stringify({ name: "dip" }),
      });
      // The engine is unavailable in this rig, so the call cannot succeed — what matters is that it
      // reached the HANDLER, which answers about the engine rather than about a procedure.
      expect(failure(res).error).not.toBe("conflict");
      expect(failure(res).message).not.toContain("generation procedure is recording");
    } finally {
      r.cleanup();
    }
  });

  test("asking for a second procedure is answered by the gate, not by the freeze", async () => {
    const r = generating();
    try {
      // `start_generation` carries the exemption for exactly this: the gate's sentence names the
      // recipe holding the procedure already running, which is what the model needs, where the
      // freeze's would say only that the archive is closed.
      r.procedure.next = {
        ok: false,
        code: "conflict",
        message: "a generation procedure is already running, under recipe rc-other; finish it",
      };
      const refusal = failure(
        await call(served(r).get("start_generation")!, { recipe_id: r.recipeId }),
      );
      expect(refusal.error).toBe("conflict");
      expect(refusal.message).toContain("under recipe rc-other");
      expect(refusal.message).not.toContain("the archive is held still");
    } finally {
      r.cleanup();
    }
  });
});

/**
 * The read-only process, at the tool chokepoint.
 *
 * The mode is the boot's writer claim (`db/lock.ts`): the first process on a var root writes, and
 * every later one is read-only for its whole life. Like the freeze above it lives in the
 * `announcing` wrapper — the one path both harnesses share — and like the freeze it is tested
 * through that wrapper, because the rule is about which handlers may be REACHED. The rig's deps are
 * the writer's; a reader here is the same deps with the one field flipped, which is faithful to the
 * real thing — the mode is one value threaded at boot, and nothing else differs between the two.
 */
describe("a read-only process refuses every write", () => {
  function servedAs(r: Rig, mode: "writer" | "reader"): Map<string, Handler> {
    return new Map(announcing({ ...r.deps, mode }).map((t) => [t.name, t as Handler]));
  }

  test("every tool that is not read-only is refused, procedure tools included, and the sentence names the way out", async () => {
    const r = rig();
    try {
      const wrapped = servedAs(r, "reader");
      const refused = announcing(r.deps).filter((d) => !d.readOnly);
      // Twenty-one: the sixteen the freeze holds plus the five that are exempt from IT — a reader
      // can hold no procedure, so `start_generation` and `publish_report` are writes with nothing
      // to ride, and the three run tools would work in the writer's live home. The count is
      // asserted so a tool quietly gaining `readOnly` shows up here.
      expect(refused).toHaveLength(21);

      for (const definition of refused) {
        // Called with nothing at all, like the freeze test above: the refusal answers before the
        // handler ever sees the arguments.
        const refusal = failure(await call(wrapped.get(definition.name)!, {}));
        expect(`${definition.name}: ${refusal.error}`).toBe(`${definition.name}: read_only`);
        expect(refusal.message).toContain("read-only");
        // The way out is named: write from the writer, or restart after it exits.
        expect(refusal.message).toContain("restart");
      }

      // NOTHING MOVED, NOTHING ANNOUNCED, NOTHING FILED. A refusal is an answer, not a defect —
      // and a reader that error-logged its own refusals would fill the log with the mode working.
      expect(r.announced).toEqual([]);
      expect(listErrors(r.db, {}).entries).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  test("reading still answers, because reading is what the mode is for", async () => {
    const r = rig();
    try {
      const res = await call(servedAs(r, "reader").get("list_recipes")!, {});
      expect(res.isError).toBeUndefined();
      expect((body(res)["recipes"] as unknown[]).length).toBeGreaterThan(0);
    } finally {
      r.cleanup();
    }
  });

  test("authority is the process's, never a caller's", async () => {
    // The pin on subagent inheritance, stated as what the tool layer can actually prove: the
    // refusal is a function of `(deps.mode, definition)` and the handler signature carries no
    // caller at all — so a subagent's call and the main agent's are the SAME call, and the answer
    // cannot vary between them. Two calls against one deps object answering identically, with the
    // sentence naming the PROCESS, is that fact exercised; the absence of any caller parameter to
    // vary is the compile-time half.
    const r = rig();
    try {
      const wrapped = servedAs(r, "reader");
      const first = failure(await call(wrapped.get("create_recipe")!, {}));
      const second = failure(await call(wrapped.get("create_recipe")!, {}));
      expect(second).toEqual(first);
      expect(first.message).toContain("this yewreview process");
      // And the writer's answer is the mirror image: the same call with the pen reaches the
      // handler and lands.
      const held = await call(servedAs(r, "writer").get("create_recipe")!, {
        name: "weekly semis",
        content: "Write the weekly report.",
      });
      expect(held.isError).toBeUndefined();
    } finally {
      r.cleanup();
    }
  });
});

describe("publish_report", () => {
  test("outside a generation procedure there is nothing to publish into, and the refusal says who starts one", async () => {
    const r = rig();
    try {
      // The gate, and the first thing the tool checks. A report's account of what produced its
      // numbers is written from the runs logged while a procedure was in progress, so a document
      // published outside one could not account for its own numbers — its two run counts would be
      // empty for a reason nothing in the record explains. The procedure is also the user's to
      // start: if the agent could open one it would simply open one, and the rule would mean
      // nothing.
      r.runs.end("cancelled");
      const path = draft(r, "drafts/nvda.html");
      const res = await call(r.tool("publish_report"), { draft_path: path, title: "Too early" });
      const refusal = failure(res);
      expect(refusal.error).toBe("invalid_request");
      expect(refusal.message).toContain("generation procedure");
      // POINTED AT THE TOOL, because there is one now. It used to point at a button — the procedure
      // was the user's to start and the way forward was to say the draft was ready and wait — and
      // the sentence had to change with the door: a refusal naming a control that no longer exists
      // is worse than no refusal, because the model would keep waiting for somebody to press it.
      expect(refusal.message).toContain("start_generation");

      expect(r.db.query("SELECT COUNT(*) AS n FROM report").get()).toEqual({ n: 0 });
      expect(r.frames).toEqual([]);

      // The same call inside a procedure goes through, which is what makes the refusal above about
      // the procedure rather than about the draft.
      r.openProcedure();
      const inside = await call(r.tool("publish_report"), { draft_path: path, title: "Ready now" });
      expect(inside.isError).toBeUndefined();
      expect(body(inside)["title"]).toBe("Ready now");
    } finally {
      r.cleanup();
    }
  });

  test("the report is recorded against the procedure's recipe, which the model never gets to name", async () => {
    const r = generating();
    try {
      // A second recipe the conversation can reach through every other tool. The procedure that is
      // open named the FIRST one when it opened, and the report is recorded against exactly that
      // specification — so this is the call that would go wrong if publishing took a recipe
      // argument.
      const other = seedRecipe(r.db, "Next door");
      const out = body(
        await call(r.tool("publish_report"), { draft_path: draft(r, "a.html"), title: "Here" }),
      );
      expect(out["recipe_id"]).toBe(r.recipeId);
      expect(out["recipe_name"]).toBe(getRecipe(r.db, r.recipeId)!.name);
      expect(
        r.db
          .query<{ recipe_id: string }, [string]>("SELECT recipe_id FROM report WHERE id = ?")
          .get(out["report_id"] as string),
      ).toEqual({ recipe_id: r.recipeId });

      // And the neighbour has nothing, which is what makes the assertion above about the procedure
      // rather than about there having been only one place to go.
      expect(
        body(await call(r.tool("list_reports"), { recipe_id: other }))["reports"],
      ).toHaveLength(0);
      expect(
        body(await call(r.tool("list_reports"), { recipe_id: r.recipeId }))["reports"],
      ).toHaveLength(1);
      // Unfiltered spans the archive, because one conversation works across all of it.
      expect(body(await call(r.tool("list_reports")))["reports"]).toHaveLength(1);
    } finally {
      r.cleanup();
    }
  });

  test("a successful publish closes the procedure it belonged to, so a second report needs a second one", async () => {
    const r = generating();
    try {
      const first = await call(r.tool("publish_report"), {
        draft_path: draft(r, "a.html"),
        title: "First",
      });
      expect(first.isError).toBeUndefined();
      // The procedure is over the moment its report exists. Leaving it open would let a second
      // publish re-declare the first one's runs against a second document — the log is the
      // procedure's, and both reports would claim the same work.
      expect(r.runs.ended).toEqual(["published"]);
      expect(r.runs.recording()).toBe(false);

      const second = await call(r.tool("publish_report"), {
        draft_path: draft(r, "b.html"),
        title: "Second",
      });
      expect(failure(second).error).toBe("invalid_request");
      expect(r.db.query("SELECT COUNT(*) AS n FROM report").get()).toEqual({ n: 1 });
    } finally {
      r.cleanup();
    }
  });

  test("the runs it records are the log's, not a list anyone wrote down — failed ones included", async () => {
    const r = generating();
    try {
      const prices = seedScript(r, "prices");
      const returns = seedScript(r, "returns");
      // Written by the run tools in a real procedure; put here directly because what is under test
      // is what publishing does with a log, and the tools' own suites prove they write one. Three
      // kinds, because there are exactly three: a run of a STORED program, which can name the
      // program; a measurement, which is always the engine; and everything else, which can only
      // name the line it was typed as.
      ran(
        r.runs,
        { kind: "script", scriptId: prices, argument: "--ticker NVDA --years 5" },
        1_700_000_000_000,
        { exitCode: 0, return: "wrote 1,258 rows\n", durationMs: 1_400 },
      );
      ran(
        r.runs,
        { kind: "script", scriptId: returns, argument: "--window 20" },
        1_700_000_060_000,
        { exitCode: 3, return: "KeyError: 'close'\n", durationMs: 220 },
      );
      ran(
        r.runs,
        { kind: "shell", command: "shasum -a 256 data/nvda.csv" },
        1_700_000_120_000,
        { exitCode: 0, return: "e3b0c442…  data/nvda.csv\n", durationMs: 40 },
      );
      ran(
        r.runs,
        { kind: "seikan", command: "/opt/venv/bin/seikan run thesis.json --report-out report.json" },
        1_700_000_180_000,
        { exitCode: 0, return: '{"cells": []}', durationMs: 5_000 },
      );

      const out = body(
        await call(r.tool("publish_report"), { draft_path: draft(r, "a.html"), title: "Measured" }),
      );

      // In the log's order, which is the order things happened — and the moment stored is the RUN's
      // rather than the report's, so a reader can see how the afternoon actually went. What each row
      // carries is what the machine WATCHED: the code it exited with, how long it took, and what it
      // printed. None of it is anybody's account of the run.
      expect(
        r.db
          .query<
            {
              script_id: string;
              argument: string;
              return: string;
              exit_code: number;
              duration_ms: number;
              created_at: number;
            },
            []
          >(
            'SELECT script_id, argument, "return", exit_code, duration_ms, created_at ' +
              "FROM script_invocation ORDER BY created_at",
          )
          .all(),
      ).toEqual([
        {
          script_id: prices,
          argument: "--ticker NVDA --years 5",
          return: "wrote 1,258 rows\n",
          exit_code: 0,
          duration_ms: 1_400,
          created_at: 1_700_000_000_000,
        },
        // The failed one is here, and that is the point. A script that exited nonzero is part of
        // what producing this report actually involved; a record that kept only the runs that
        // worked would read as a straight line through work that was not one — and the exit code
        // is stored rather than inferred, so an auditor can find it.
        {
          script_id: returns,
          argument: "--window 20",
          return: "KeyError: 'close'\n",
          exit_code: 3,
          duration_ms: 220,
          created_at: 1_700_000_060_000,
        },
      ]);
      // The other kind, in the table whose rows name nothing else in the archive. A command with no
      // stored program behind it used to leave no trace at all; now the line itself is the record,
      // kept as the text of what ran.
      expect(
        r.db
          .query<
            {
              command: string;
              return: string;
              exit_code: number;
              duration_ms: number;
              created_at: number;
            },
            []
          >(
            'SELECT command, "return", exit_code, duration_ms, created_at ' +
              "FROM trivial_shell_history_for_report ORDER BY created_at",
          )
          .all(),
      ).toEqual([
        {
          command: "shasum -a 256 data/nvda.csv",
          return: "e3b0c442…  data/nvda.csv\n",
          exit_code: 0,
          duration_ms: 40,
          created_at: 1_700_000_120_000,
        },
      ]);

      // And the third kind, in the table that exists so "which of these were measurements" is a
      // join rather than a search through command text for a word.
      expect(
        r.db
          .query<
            {
              command: string;
              return: string;
              exit_code: number;
              duration_ms: number;
              created_at: number;
            },
            []
          >(
            'SELECT command, "return", exit_code, duration_ms, created_at ' +
              "FROM seikan_invocation ORDER BY created_at",
          )
          .all(),
      ).toEqual([
        {
          command: "/opt/venv/bin/seikan run thesis.json --report-out report.json",
          return: '{"cells": []}',
          exit_code: 0,
          duration_ms: 5_000,
          created_at: 1_700_000_180_000,
        },
      ]);

      const listed = (body(await call(r.tool("list_reports")))["reports"] as Array<{
        script_invocation_count: number;
        seikan_invocation_count: number;
        shell_command_count: number;
      }>)[0]!;
      expect([
        listed.script_invocation_count,
        listed.seikan_invocation_count,
        listed.shell_command_count,
      ]).toEqual([2, 1, 1]);

      // And the report frees them when it goes, because a recorded command is part of a publication
      // rather than a fact about the script or about the shell.
      const removed = body(
        await call(r.tool("delete_report"), { report_id: out["report_id"], confirm: true }),
      );
      expect(removed["deleted"]).toBe(true);
      expect(removed["script_invocations_removed"]).toBe(2);
      expect(removed["seikan_invocations_removed"]).toBe(1);
      expect(removed["shell_commands_removed"]).toBe(1);
      for (const table of [
        "script_invocation",
        "seikan_invocation",
        "trivial_shell_history_for_report",
      ]) {
        expect(r.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally {
      r.cleanup();
    }
  });

  test("a command this procedure started and never finished is refused, not published around", async () => {
    const r = generating();
    try {
      // THE TWO-PHASE GUARD. A log entry is opened when a command is SPAWNED and completed when it
      // exits, so an open one is work this report would go out without. Tool calls can be issued in
      // parallel, which makes "publish while the slow one is still going" an ordinary accident
      // rather than a contrived one — and the row it would leave out is exactly the expensive run
      // somebody would want to see.
      const finish = r.runs.begin(
        { kind: "shell", command: "python fetch.py --years 20" },
        1_700_000_000_000,
      );
      const res = await call(r.tool("publish_report"), {
        draft_path: draft(r, "a.html"),
        title: "Too early",
      });
      const refusal = failure(res);
      expect(refusal.error).toBe("conflict");
      expect(refusal.message).toContain("1 command(s) this procedure started have not finished");
      // The remedy is to wait, and the refusal says so rather than leaving the model to guess that
      // the way out might be to cancel or to run the command again.
      expect(refusal.message).toContain("Wait for them");
      expect(r.db.query("SELECT COUNT(*) AS n FROM report").get()).toEqual({ n: 0 });
      // A refused publication leaves the procedure exactly where it was: still open, still holding
      // the run, so the model's next move is the one the refusal asked for.
      expect(r.runs.ended).toEqual([]);
      expect(r.runs.recording()).toBe(true);
      expect(r.frames).toEqual([]);

      // Finished, and the same call goes through — which is what makes the refusal about the open
      // entry rather than about the command having been run at all. The outcome the finalizer
      // supplied is what lands in the row, whole.
      finish({ ok: true, exitCode: 0, durationMs: 91_000, return: "fetched 5,041 rows\n" });
      const after = await call(r.tool("publish_report"), {
        draft_path: draft(r, "b.html"),
        title: "Now",
      });
      expect(after.isError).toBeUndefined();
      expect(body(after)["shell_command_count"]).toBe(1);
      expect(
        r.db
          .query<
            { command: string; return: string; exit_code: number; duration_ms: number },
            []
          >(
            'SELECT command, "return", exit_code, duration_ms FROM trivial_shell_history_for_report',
          )
          .all(),
      ).toEqual([
        {
          command: "python fetch.py --years 20",
          return: "fetched 5,041 rows\n",
          exit_code: 0,
          duration_ms: 91_000,
        },
      ]);
    } finally {
      r.cleanup();
    }
  });

  test("stores the document itself, records the recipe it was written to, and leaves the draft alone", async () => {
    const r = generating();
    try {
      // THERE IS NO REVISION FOR THIS TO REFUSE, AND THERE USED TO BE. A test stood here proving
      // that a playbook revised in the middle of a procedure was a conflict: instructions were an
      // append-only ledger, the procedure pinned the version in force when it opened, and a
      // revision landing halfway through would otherwise have put its name on a document written
      // under the old rules. A recipe's text is immutable, so the state that refusal existed to
      // catch is unreachable — the row named at the start holds the same bytes at the end, and
      // publishing has nothing to re-read. The trigger that makes that true is pinned in the recipe
      // suite above; what is pinned here is what the report ends up naming.
      const path = draft(r, "drafts/nvda.html");
      const res = await call(r.tool("publish_report"), {
        draft_path: path,
        title: "NVDA: the Q1 read",
      });
      expect(res.isError).toBeUndefined();
      const out = body(res) as {
        report_id: string;
        url: string;
        recipe_id: string;
        recipe_name: string;
      };

      expect(out.recipe_id).toBe(r.recipeId);
      expect(out.recipe_name).toBe(getRecipe(r.db, r.recipeId)!.name);
      // A report is read at its own address off the database. There is no file to name and no
      // digest of one to keep, so the payload carries neither — a `path` here would be an answer
      // to a question nothing asks.
      expect(out.url).toBe(`/reports/${out.report_id}`);
      expect(Object.keys(out)).not.toContain("path");
      expect(Object.keys(out)).not.toContain("sha256");
      // Nothing was written to disk: the draft is still where the agent wrote it, and `reports/`
      // holds only the served chart library.
      expect(existsSync(join(r.home, path))).toBe(true);
      expect(reportsDirEntries(r)).toEqual(["assets"]);

      expect(r.frames).toEqual([
        {
          type: "report_published",
          reportId: out.report_id,
          title: "NVDA: the Q1 read",
          url: `/reports/${out.report_id}`,
        },
      ]);

      const row = r.db
        .query<{ recipe_id: string; content: string }, [string]>(
          "SELECT recipe_id, content FROM report WHERE id = ?",
        )
        .get(out.report_id);
      expect(row?.recipe_id).toBe(r.recipeId);
      // The row IS the document: what was read out of the home directory is what a reader is
      // served.
      expect(row?.content).toBe(
        readFileSync(join(r.home, path), "utf8"),
      );
      expect(getReportContent(r.db, out.report_id)).toBe(row!.content);
    } finally {
      r.cleanup();
    }
  });

  test("what a report names goes on saying what it said, whatever becomes of that recipe afterwards", async () => {
    const r = generating();
    try {
      // THE SUCCESSOR TO A PIN THAT USED TO BE ABOUT VERSIONS. A report published under version 1
      // had to go on naming version 1 after a revision landed, and the append-only ledger is what
      // made that true. Here the row's own words cannot move, so the question is only what happens
      // when the specification is RETIRED — and the answer is nothing: the report still names it,
      // the text still reads as it did, and the archive can still say what this document was
      // written to.
      const first = body(
        await call(r.tool("publish_report"), { draft_path: draft(r, "a.html"), title: "First" }),
      );
      expect(first["recipe_id"]).toBe(r.recipeId);

      // A method that has moved on: a NEW recipe, and the old one retired. That is the one movement
      // that replaced revising, and it leaves the published report exactly where it was.
      const replacement = seedRecipe(r.db, "Semis, corrected", "Lead with the numbers.");
      setRecipeStatus(r.db, r.recipeId, "inactive");
      r.runs.start(replacement);
      const second = body(
        await call(r.tool("publish_report"), { draft_path: draft(r, "b.html"), title: "Second" }),
      );
      expect(second["recipe_id"]).toBe(replacement);

      const listed = body(await call(r.tool("list_reports")))["reports"] as Array<{
        report_id: string;
        recipe_id: string;
        recipe_name: string;
      }>;
      expect(new Map(listed.map((row) => [row.report_id, row.recipe_id]))).toEqual(
        new Map([
          [first["report_id"] as string, r.recipeId],
          [second["report_id"] as string, replacement],
        ]),
      );
      expect(getRecipe(r.db, r.recipeId)!.content).toBe("Write a report.");
    } finally {
      r.cleanup();
    }
  });

  test("refuses a fragment, and refuses a document nobody could find again", async () => {
    const r = generating();
    try {
      const home = r.home;
      writeFileSync(join(home, "fragment.html"), "<div>numbers</div>");
      const fragment = await call(r.tool("publish_report"), {
        draft_path: "fragment.html",
        title: "Fragment",
      });
      expect(failure(fragment).message).toContain("doctype");

      writeFileSync(join(home, "untitled.html"), "<!doctype html><html><body>hi</body></html>");
      const untitled = await call(r.tool("publish_report"), {
        draft_path: "untitled.html",
        title: "Untitled",
      });
      expect(failure(untitled).message).toContain("<title>");

      expect(r.frames).toEqual([]);
      expect(r.db.query("SELECT COUNT(*) AS n FROM report").get()).toEqual({ n: 0 });
    } finally {
      r.cleanup();
    }
  });

  test("refuses a draft that is not inside the home directory", async () => {
    const r = generating();
    try {
      writeFileSync(join(r.h.varDir, "outside.html"), "<!doctype html><title>x</title>");
      for (const draftPath of ["../outside.html", join(r.h.varDir, "outside.html")]) {
        const res = await call(r.tool("publish_report"), { draft_path: draftPath, title: "Nope" });
        expect(failure(res).error).toBe("invalid_path");
      }
    } finally {
      r.cleanup();
    }
  });

  test("points the chart library at the served copy, absolutely", async () => {
    const r = generating();
    try {
      const path = draft(r, "chart.html", '<script src="./vendor/echarts.min.js"></script>');
      const out = body(await call(r.tool("publish_report"), { draft_path: path, title: "Chart" }));
      const html = getReportContent(r.db, out["report_id"] as string)!;
      // Absolute, because a stored report has no directory of its own to be relative to: it is
      // served at /reports/<id>, and a relative href would resolve against whatever url a reader
      // happened to arrive at.
      expect(html).toContain('<script src="/reports/assets/echarts.min.js"></script>');
      expect(html).not.toContain("./vendor/echarts.min.js");
    } finally {
      r.cleanup();
    }
  });

  test("a procedure that ran nothing publishes a report saying so, and cannot say otherwise", async () => {
    const r = generating();
    try {
      const out = body(
        await call(r.tool("publish_report"), {
          draft_path: draft(r, "a.html"),
          title: "Nothing to declare",
        }),
      );
      // Both counts are zero, and honestly so: this procedure ran nothing. They are written from
      // the log rather than from an argument, so there is no way for this report to claim
      // otherwise — a report of a procedure with an empty log has empty run tables, and the suite
      // above proves the other half, that a log with runs in it produces rows.
      expect([out["script_invocation_count"], out["shell_command_count"]]).toEqual([0, 0]);

      const listed = (body(await call(r.tool("list_reports")))["reports"] as Array<{
        url: string;
        script_invocation_count: number;
        shell_command_count: number;
      }>)[0]!;
      expect(listed.url).toBe(`/reports/${out["report_id"] as string}`);
      expect([listed.script_invocation_count, listed.shell_command_count]).toEqual([0, 0]);
      for (const table of ["script_invocation", "trivial_shell_history_for_report"]) {
        expect(r.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally {
      r.cleanup();
    }
  });

  test("there is nothing to declare: the whole argument list is the draft, its title and one switch", async () => {
    const r = rig();
    try {
      // THE PIN IS ON WHAT IS ABSENT, and two of the absences are things this call once took.
      // `applied_assessments` and `references` were the model's own account of what its argument
      // stood on and what it had quoted from where. Nothing fetched a cited page or compared a
      // quoted sentence against one, so what those tables recorded was that the account was
      // internally consistent — which is not the thing a reader would take it for. `tool_invocations`
      // and `claims` never existed for the same reason from the other side: the runs are the log's
      // to record, and the doubts are a passage of the document.
      //
      // So the call is a draft, a title and one switch about the chart library, and a call spelling
      // any of the withdrawn names is refused BY NAME rather than published with the declaration
      // silently dropped — which is the whole reason every top-level schema here is strict.
      const schema = schemaOf(definitions(r.deps).find((d) => d.name === "publish_report")!);
      expect(Object.keys(schema.shape).sort()).toEqual(["draft_path", "inline_assets", "title"]);

      for (const withdrawn of [
        { applied_assessments: ["an-assessment-id"] },
        {
          references: [
            {
              source_id: "s1",
              url: "https://investor.apple.com/q1",
              original_statement: "Revenue was $3.1bn.",
              anchor: "ref-revenue",
            },
          ],
        },
        { tool_invocations: [{ script_id: "s1", argument: "--full" }] },
        { claims: [{ content: "x", basis: "y", retrieve_at: "ref-x" }] },
        { applied_theses: ["t1"] },
        // The runs are not an argument either, in the shape they are now recorded in: a report's
        // account of what it ran is the machine's, and a tidier-looking version handed in here
        // would be exactly the thing the log exists to replace.
        { shell_commands: [{ command: "shasum -a 256 data/nvda.csv", exit_code: 0 }] },
      ]) {
        const outcome = schema.safeParse({ draft_path: "a.html", title: "Doomed", ...withdrawn });
        expect(outcome.success).toBe(false);
        expect(outcome.error!.issues.map((issue) => issue.code)).toContain("unrecognized_keys");
      }

      // And the three that remain are accepted, which is what makes the refusals above about the
      // withdrawn names rather than about the shape of the arguments in general.
      expect(
        schema.safeParse({ draft_path: "a.html", title: "Fine", inline_assets: true }).success,
      ).toBe(true);
    } finally {
      r.cleanup();
    }
  });

  test("publishing the same draft again writes a second report, and the first cannot be rewritten", async () => {
    const r = generating();
    try {
      const script = seedScript(r, "prices");
      const path = draft(r, "a.html");
      ran(
        r.runs,
        { kind: "script", scriptId: script, argument: "--ticker NVDA" },
        1_700_000_000_000,
        { exitCode: 0, return: "wrote 1,258 rows\n", durationMs: 900 },
      );
      const one = body(await call(r.tool("publish_report"), { draft_path: path, title: "First" }));
      // The same bytes, published again — in a second procedure, because the first one ended when
      // its report came into existence. There is no path to collide and no revision to make: it is
      // simply a second document, with a procedure and a record of its own.
      r.runs.start(r.recipeId);
      ran(
        r.runs,
        { kind: "script", scriptId: script, argument: "--ticker AMD" },
        1_700_000_600_000,
        { exitCode: 0, return: "wrote 1,258 rows\n", durationMs: 880 },
      );
      const two = body(await call(r.tool("publish_report"), { draft_path: path, title: "Second" }));
      expect(two["report_id"]).not.toBe(one["report_id"]);
      expect(r.db.query("SELECT COUNT(*) AS n FROM report").get()).toEqual({ n: 2 });
      expect(getReportContent(r.db, one["report_id"] as string)).toBe(
        getReportContent(r.db, two["report_id"] as string),
      );
      // Two documents with the same bytes, each holding its own procedure's runs. The second
      // publication cannot reach the first one's log — it ended with the first report — so the
      // same program run twice is two rows under two reports rather than one shared record.
      expect(
        r.db
          .query<{ report_id: string; argument: string }, []>(
            "SELECT report_id, argument FROM script_invocation ORDER BY created_at",
          )
          .all(),
      ).toEqual([
        { report_id: one["report_id"] as string, argument: "--ticker NVDA" },
        { report_id: two["report_id"] as string, argument: "--ticker AMD" },
      ]);

      // And "never amended" is the database's rule rather than this surface's: no tool offers the
      // write, and the trigger aborts it for whoever reaches the table another way.
      expect(() =>
        r.db
          .query("UPDATE report SET title = 'Revised' WHERE id = ?")
          .run(one["report_id"] as string),
      ).toThrow(/immutable/);
      expect(() =>
        r.db
          .query("UPDATE report SET content = '<!doctype html><title>x</title>' WHERE id = ?")
          .run(one["report_id"] as string),
      ).toThrow(/immutable/);
    } finally {
      r.cleanup();
    }
  });

  test("inline_assets pastes the library in, and refuses when there is none to paste", async () => {
    const r = generating();
    try {
      const path = draft(r, "chart.html", '<script src="./vendor/echarts.min.js"></script>');
      const missing = await call(r.tool("publish_report"), {
        draft_path: path,
        title: "Chart",
        inline_assets: true,
      });
      expect(failure(missing).error).toBe("invalid_request");

      const asset = join(paths(r.h.settings).reportAssetsDir, "echarts.min.js");
      mkdirSync(dirname(asset), { recursive: true });
      writeFileSync(asset, "/* the whole library */");
      const res = await call(r.tool("publish_report"), {
        draft_path: path,
        title: "Chart",
        inline_assets: true,
      });
      const out = body(res);
      expect(out["inlined_assets"]).toBe(true);
      const html = getReportContent(r.db, out["report_id"] as string)!;
      expect(html).toContain("<script>/* the whole library */</script>");
      expect(html).not.toContain("src=");
    } finally {
      r.cleanup();
    }
  });
});

describe("one conversation, every recipe", () => {
  test("a script recorded while working on something else is there to read, retire and delete", async () => {
    const r = rig();
    try {
      seedRecipe(r.db, "Someone else's recipe");
      // Scripts are GLOBAL: they belong to the installation, not to whatever was being worked on
      // when one was saved. A boundary refusing these calls per recipe would protect nothing
      // anybody wants protected — two recipes keeping private copies of one price fetcher is
      // duplication wearing the costume of independence.
      const theirs = seedScript(r, "theirs");

      const read = body(await call(r.tool("get_script"), { script_id: theirs }));
      expect(read["source"]).toBe('print("theirs")\n');

      const listed = body(await call(r.tool("list_scripts")))["scripts"] as Array<{
        script_id: string;
      }>;
      expect(listed.map((s) => s.script_id)).toEqual([theirs]);

      expect(
        (await call(r.tool("set_script_status"), { script_id: theirs, status: "inactive" }))
          .isError,
      ).toBeUndefined();
      expect(
        (await call(r.tool("delete_script"), { script_id: theirs, confirm: true })).isError,
      ).toBeUndefined();
      expect(r.db.query("SELECT COUNT(*) AS n FROM script").get()).toEqual({ n: 0 });

      // An id naming nothing is still refused, and that is the ONLY reason these tools say no.
      for (const [name, args] of [
        ["get_script", { script_id: "no-such-script" }],
        ["set_script_status", { script_id: "no-such-script", status: "inactive" }],
        ["delete_script", { script_id: "no-such-script", confirm: true }],
      ] as const) {
        expect(failure(await call(r.tool(name), args)).error).toBe("not_found");
      }
    } finally {
      r.cleanup();
    }
  });

  test("a report this procedure did not publish is listed, and can be deleted", async () => {
    const r = rig();
    try {
      const other = seedRecipe(r.db, "Another recipe");
      const html = '<!doctype html><title>t</title><p id="ref-x">an old report</p>';
      // A report under a recipe nothing in this session has touched, written straight in because
      // the row IS the document. The id is uuid-shaped like every id this database mints, because
      // the tools resolve an argument by trying it as an id FIRST and a shape nothing could have
      // written would be tested against a rule no real call meets.
      const theirs = newId();
      r.db
        .query(
          "INSERT INTO report (name, id, recipe_id, title, content, created_at) VALUES ('theirs', ?, ?, ?, ?, ?)",
        )
        .run(theirs, other, "Theirs", html, 1);

      // There is NO scoping check here, and its absence is the assertion. One would be protecting a
      // boundary between conversations, and there is one conversation: every report in the archive
      // is listed to it, so refusing an id it was handed a moment earlier would read as a bug
      // rather than as a boundary.
      const listed = body(await call(r.tool("list_reports")))["reports"] as Array<{
        report_id: string;
      }>;
      expect(listed.map((row) => row.report_id)).toEqual([theirs]);

      const deleted = await call(r.tool("delete_report"), {
        report_id: theirs,
        confirm: true,
      });
      expect(deleted.isError).toBeUndefined();
      expect(getReportContent(r.db, theirs)).toBeNull();

      // An id naming nothing is still refused, and existence is the only question this tool asks —
      // the refusal names both ways in, because the argument takes both.
      const missing = failure(
        await call(r.tool("delete_report"), { report_id: "no-such-report", confirm: true }),
      );
      expect(missing.error).toBe("not_found");
      expect(missing.message).toContain("give either its id or its name");
    } finally {
      r.cleanup();
    }
  });
});

describe("deletion asks first", () => {
  test("every destructive tool refuses without confirm and changes nothing", async () => {
    const r = generating();
    try {
      // One of everything, so a refusal that quietly deleted would be visible.
      const reportId = body(
        await call(r.tool("publish_report"), { draft_path: draft(r, "d.html"), title: "Doomed" }),
      )["report_id"] as string;
      // Seeded rather than recorded through `create_information_source`, which now exists: what
      // this sweep is about is the CONFIRM gate, and a six-field interview on the way in would be
      // another tool's behaviour taking up room in a test about one shared rule.
      const sourceId = seedSource(r.db, "investor.example.com", ["investor.example.com"]);
      await call(r.tool("upsert_target"), { ticker: "AAPL", name: "Apple Inc." });
      const scriptId = body(
        await call(r.tool("create_script"), {
          name: "fetch",
          domain: "daily bars",
          source: "print(1)\n",
        }),
      )["script_id"] as string;
      const thesisId = seedThesis(r.db, "dip buying");
      // A second recipe, because the one the rig seeded is the one the open procedure works to and
      // `delete_recipe` refuses that outright — a refusal about the procedure would tell this test
      // nothing about the confirm gate.
      const doomedRecipe = seedRecipe(r.db, "Doomed recipe");

      // ALL SIX, which is what "every destructive tool" has to mean for this sweep to be worth
      // running: two of them arrived with the writes the window gave up, and a list that quietly
      // stopped covering the whole surface would pass while the newest delete asked nobody.
      for (const [name, args] of [
        ["delete_recipe", { recipe_id: doomedRecipe, confirm: false }],
        ["delete_report", { report_id: reportId, confirm: false }],
        ["delete_target", { ticker: "AAPL", confirm: false }],
        ["delete_script", { script_id: scriptId, confirm: false }],
        ["delete_thesis", { thesis_id: thesisId, confirm: false }],
        ["delete_information_source", { source_id: sourceId, confirm: false }],
      ] as const) {
        const res = await call(r.tool(name), args);
        const refusal = failure(res);
        expect(refusal.error).toBe("invalid_request");
        expect(refusal.message).toContain("confirm: true");
      }

      for (const table of ["report", "target", "script", "thesis", "information_source"]) {
        expect(r.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
      }
      // Two: the rig's and the one seeded to be refused.
      expect(r.db.query("SELECT COUNT(*) AS n FROM recipe").get()).toEqual({ n: 2 });
    } finally {
      r.cleanup();
    }
  });

  test("confirmed, the document goes with the row, because the document IS the row", async () => {
    const r = generating();
    try {
      const out = body(
        await call(r.tool("publish_report"), { draft_path: draft(r, "d.html"), title: "Doomed" }),
      );
      const reportId = out["report_id"] as string;
      expect(getReportContent(r.db, reportId)).toContain("<!doctype html>");

      const res = await call(r.tool("delete_report"), { report_id: reportId, confirm: true });
      expect(res.isError).toBeUndefined();
      expect(getReportContent(r.db, reportId)).toBeNull();
      expect(r.db.query("SELECT COUNT(*) AS n FROM report").get()).toEqual({ n: 0 });
      // And nothing on disk was ever this report's, so nothing on disk is left over.
      expect(reportsDirEntries(r)).toEqual(["assets"]);
    } finally {
      r.cleanup();
    }
  });
});

describe("scripts, whose program is a column", () => {
  test("the program is stored in the row, and no file appears under var", async () => {
    const r = rig();
    try {
      const source = "import pandas as pd\nprint('hello')\n";
      const before = filesUnderVar(r);
      const out = body(
        await call(r.tool("create_script"), { name: "prices", domain: "daily bars", source }),
      );

      // Saving a program is one row and nothing else: there is no canonical copy to keep in sync,
      // and therefore no half-done state a refused create could leave behind.
      expect(filesUnderVar(r)).toEqual(before);
      // The whole payload, locked. Nothing here names a file or a digest of one, and nothing here
      // lists what the script produced: what a run left behind is a working file in the agent's
      // home directory, and this database never knew its name.
      expect(Object.keys(out).sort()).toEqual([
        "created_at",
        "domain",
        "name",
        "script_id",
        "source_bytes",
        "status",
        "updated_at",
      ]);
      expect(out["source_bytes"]).toBe(Buffer.byteLength(source, "utf8"));
      expect(
        r.db
          .query<{ source: string }, [string]>("SELECT source FROM script WHERE id = ?")
          .get(out["script_id"] as string),
      ).toEqual({ source });
    } finally {
      r.cleanup();
    }
  });

  test("get_script hands the program back verbatim, and no write can move it", async () => {
    const r = rig();
    try {
      const source = "import pandas as pd\nprint('hello')\n";
      const scriptId = body(
        await call(r.tool("create_script"), { name: "prices", domain: "daily bars", source }),
      )["script_id"] as string;

      const read = body(await call(r.tool("get_script"), { script_id: scriptId }));
      expect(read["source"]).toBe(source);

      // There is nothing to tamper with behind the application's back — the row is the only copy —
      // and the row itself refuses. That is what makes a years-old preparation worth following: the
      // program that prepared a series cannot have been edited since.
      expect(() =>
        r.db.query("UPDATE script SET source = ? WHERE id = ?").run("print('not mine')\n", scriptId),
      ).toThrow(/immutable/);
      expect(() =>
        r.db.query("UPDATE script SET domain = ? WHERE id = ?").run("something else", scriptId),
      ).toThrow(/immutable/);
      // THE NAME IS NOT IN THAT LIST, and its absence is deliberate rather than an oversight. A
      // script's name is the line a person reads it by and addresses it with, and it is theirs to
      // reword; the trigger names every column that carries MEANING and leaves the one that carries
      // a summary alone, which is why a rename never wakes it. Nothing in the archive reaches this
      // row by its name, so rewording it moves no provenance.
      r.db.query("UPDATE script SET name = ? WHERE id = ?").run("renamed", scriptId);
      expect(body(await call(r.tool("get_script"), { script_id: scriptId }))["source"]).toBe(source);
      expect(body(await call(r.tool("get_script"), { script_id: scriptId }))["name"]).toBe("renamed");
    } finally {
      r.cleanup();
    }
  });

  test("retiring keeps what the program prepared and frees the program-identity for a replacement", async () => {
    const r = rig();
    try {
      const scriptId = body(
        await call(r.tool("create_script"), {
          name: "prices",
          domain: "daily bars",
          source: "print(1)\n",
        }),
      )["script_id"] as string;
      const thesisId = seedThesis(r.db, "dip buying");
      await assess(r, thesisId, {
        series_preparations: [{ script_id: scriptId, argument: "AAPL" }],
      });

      const res = await call(r.tool("set_script_status"), {
        script_id: scriptId,
        status: "inactive",
      });
      expect(res.isError).toBeUndefined();
      expect(summary(res)).toBe("prices is now inactive.");
      expect(body(res)["status"]).toBe("inactive");
      // The preparation stands: the code that produced that series is still stored and still
      // explains the numbers the round was read off, which is the whole difference between
      // retiring a script and deleting one.
      expect(
        r.db.query("SELECT script_id, argument FROM series_preparation").all(),
      ).toEqual([{ script_id: scriptId, argument: "AAPL" }]);

      // And the corrected program goes in beside it, which is what a fix now looks like: a new
      // script, born active, with the old one retired.
      const replacement = body(
        await call(r.tool("create_script"), {
          name: "prices",
          domain: "daily bars",
          source: "print(2)\n",
        }),
      );
      expect(replacement["script_id"]).not.toBe(scriptId);
      expect(replacement["status"]).toBe("active");
      const active = body(await call(r.tool("list_scripts"), { status: "active" }))[
        "scripts"
      ] as Array<{
        script_id: string;
      }>;
      expect(active.map((x) => x.script_id)).toEqual([replacement["script_id"] as string]);
    } finally {
      r.cleanup();
    }
  });

  test("deleting one takes the row and the program, and nothing on disk was ever its", async () => {
    const r = rig();
    try {
      const before = filesUnderVar(r);
      const scriptId = body(
        await call(r.tool("create_script"), {
          name: "prices",
          domain: "daily bars",
          source: "print(1)\n",
        }),
      )["script_id"] as string;

      const res = await call(r.tool("delete_script"), { script_id: scriptId, confirm: true });
      expect(res.isError).toBeUndefined();
      expect(summary(res)).toBe("Removed prices.");
      expect(r.db.query("SELECT COUNT(*) AS n FROM script").get()).toEqual({ n: 0 });
      // Whatever this program once wrote is a working file in the agent's home directory and this
      // database never knew its name — so there is no second half of the deletion, and no ordering
      // between rows and bytes that a crash could land in the middle of.
      expect(filesUnderVar(r)).toEqual(before);
    } finally {
      r.cleanup();
    }
  });

  test("a program is saved once: reviving a twin of an active script is refused", async () => {
    const r = rig();
    try {
      const original = seedScript(r, "prices");
      await call(r.tool("set_script_status"), { script_id: original, status: "inactive" });
      // Byte for byte what the retired one is, under a name of its own. Perfectly legal while the
      // original is retired, and it is what makes un-retiring the original a request for two active
      // rows holding one program — which would leave every future declaration free to name either.
      const twin = body(
        await call(r.tool("create_script"), {
          name: "prices, corrected",
          domain: "prices",
          source: 'print("prices")\n',
        }),
      )["script_id"] as string;
      expect(twin).not.toBe(original);

      const revived = await call(r.tool("set_script_status"), {
        script_id: original,
        status: "active",
      });
      const refusal = failure(revived);
      expect(refusal.error).toBe("conflict");
      expect(refusal.message).toContain("byte for byte");
    } finally {
      r.cleanup();
    }
  });
});

/** A recorded script with a program of its own. `seedScript` stores something that prints its own
 * name, which is enough to point at and not enough to run. */
function seedProgram(r: Rig, name: string, source: string): string {
  return createScript(r.db, { name, domain: "prices", source }).id;
}

/** What one run left behind, home-relative and sorted, so a test can say which files a run
 * directory holds rather than only that it exists. */
function runFiles(r: Rig, outputDirectory: string): string[] {
  return readdirSync(join(r.home, outputDirectory)).sort();
}

/** The detail a refusal carries beside its sentence. A failing run has an exit code, two streams
 * and a directory, and none of that survives being folded into prose. */
function detail(res: Result): Record<string, unknown> {
  expect(res.isError).toBe(true);
  return body(res)["detail"] as Record<string, unknown>;
}

/**
 * The one entry the log holds, as a SHELL entry.
 *
 * Narrowed rather than cast, because which of the two kinds a command was logged as is half of what
 * these tests are checking: the two kinds are two tables, and a command line read off something
 * recorded as a script run would be a test pinning nothing.
 */
function onlyShellRun(r: Rig): Extract<RunLogEntry, { kind: "shell" }> {
  const entries = r.runs.entries();
  expect(entries).toHaveLength(1);
  const entry = entries[0]!;
  expect(entry.kind).toBe("shell");
  if (entry.kind !== "shell") throw new Error(`logged as ${entry.kind}, not as a shell command`);
  return entry;
}

/** The one entry the log holds, as a MEASUREMENT — the kind that lands in `seikan_invocation`. */
function onlySeikanRun(r: Rig): Extract<RunLogEntry, { kind: "seikan" }> {
  const entries = r.runs.entries();
  expect(entries).toHaveLength(1);
  const entry = entries[0]!;
  expect(entry.kind).toBe("seikan");
  if (entry.kind !== "seikan") throw new Error(`logged as ${entry.kind}, not as a measurement`);
  return entry;
}

describe("run_script", () => {
  test("an id naming nothing is refused, and nothing is spawned or written for it", async () => {
    const r = rig(localVenv());
    try {
      const res = await call(r.tool("run_script"), {
        script_id: "no-such-script",
        argument: "--ticker NVDA",
      });
      const refusal = failure(res);
      expect(refusal.error).toBe("not_found");
      // Naming BOTH WAYS IN, because the argument takes both: a `*_id` on this surface is an id or
      // the record's name, and a caller holding a stale name and one holding a mistyped id need the
      // same next step without being able to tell from the outside which of the two they are.
      expect(refusal.message).toContain("give either its id or its name");
      // No directory, and no line in the log. A run that never happened must not be recorded as one
      // — the log is the report's account of what produced its numbers, and an entry for a program
      // that does not exist is worse than a missing entry.
      expect(existsSync(join(r.home, "runs"))).toBe(false);
      expect(r.runs.entries()).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  test("a RETIRED script is refused a run, and the refusal names both ways forward", async () => {
    // No venv in this rig, deliberately: the standing is checked before anything is asked about an
    // environment, so the refusal below is reached on any machine and the call after it lands one
    // rung further down the ladder rather than on whatever this host happens to have installed.
    const r = rig();
    try {
      // WHAT RETIRING A SCRIPT IS FOR. Its program is still stored and still explains every number
      // recorded against it — reading, reviving and deleting one are all ordinary — but running it
      // is not: somebody said this method had been superseded, and a run afterwards would produce
      // numbers off exactly the program they retired, with nothing downstream showing that the
      // program behind them was the abandoned half of a replacement.
      const scriptId = seedScript(r, "prices", "inactive");
      const refusal = failure(
        await call(r.tool("run_script"), { script_id: scriptId, argument: "--ticker NVDA" }),
      );
      expect(refusal.error).toBe("conflict");
      expect(refusal.message).toContain("prices is inactive");
      // Both moves are named, because which one is right is the caller's to know and neither is
      // readable off a bare refusal: run the replacement, or un-retire this one if retiring it was
      // the mistake.
      expect(refusal.message).toContain("Run the script that replaced it");
      expect(refusal.message).toContain("set_script_status");
      // REFUSED BEFORE ANYTHING IS SPAWNED, which is the half that matters: no directory, and no
      // line in the log. A run that never happened must not be recorded as one.
      expect(existsSync(join(r.home, "runs"))).toBe(false);
      expect(r.runs.entries()).toEqual([]);

      // Active again, and the refusal moves on to the next rung — which is what makes the one above
      // about the standing rather than about this script.
      await call(r.tool("set_script_status"), { script_id: scriptId, status: "active" });
      const after = await call(r.tool("run_script"), { script_id: scriptId, argument: "" });
      expect(failure(after).error).toBe("venv_unavailable");
    } finally {
      r.cleanup();
    }
  });

  test("without a provisioned environment there is nothing to run in, and it says so rather than trying", async () => {
    const r = rig();
    try {
      const res = await call(r.tool("run_script"), {
        script_id: seedScript(r, "prices"),
        argument: "",
      });
      const refusal = failure(res);
      expect(refusal.error).toBe("venv_unavailable");
      // The system interpreter is not a fallback: a program written for the sandbox's stack would
      // either fail on an import or, worse, succeed against different versions of it, and a number
      // measured that way is not the number the record claims.
      expect(refusal.message).toContain("not installed");
      expect(existsSync(join(r.home, "runs"))).toBe(false);
      expect(r.runs.entries()).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  test.skipIf(!CAN_RUN)(
    "what runs is the program in the row, not a file of the same name in the home directory",
    async () => {
      const r = rig(localVenv());
      try {
        const scriptId = seedProgram(r, "prices", 'print("the row\'s program")\n');
        // A decoy where a copy would naturally live, and the run's working directory is exactly
        // here. The row is immutable and the home directory is scratch the agent rewrites all day,
        // so a tool that ran a copy would record a script id whose stored program is not what
        // produced the numbers — and nobody reading the record years later could tell.
        writeFileSync(join(r.home, "script.py"), 'print("the home directory\'s copy")\n');

        const res = await call(r.tool("run_script"), { script_id: scriptId, argument: "" });
        expect(res.isError).toBeUndefined();
        const out = body(res);
        expect(out["stdout"]).toBe("the row's program\n");
        expect(out["exit_code"]).toBe(0);

        // The bytes that ran, on disk beside the run: byte-for-byte the column.
        const program = readFileSync(
          join(r.home, out["output_directory"] as string, "script.py"),
          "utf8",
        );
        expect(program).toBe('print("the row\'s program")\n');
        expect(readFileSync(join(r.home, "script.py"), "utf8")).toBe(
          'print("the home directory\'s copy")\n',
        );
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(!CAN_RUN)(
    "the argument line is argv, split on whitespace — not a shell line",
    async () => {
      const r = rig(localVenv());
      try {
        const scriptId = seedProgram(
          r,
          "echo",
          "import json, sys\nprint(json.dumps(sys.argv[1:]))\n",
        );
        const argvOf = async (argument: string): Promise<string[]> => {
          const res = await call(r.tool("run_script"), { script_id: scriptId, argument });
          expect(res.isError).toBeUndefined();
          return JSON.parse(body(res)["stdout"] as string) as string[];
        };

        expect(await argvOf("--ticker NVDA --years 5")).toEqual([
          "--ticker",
          "NVDA",
          "--years",
          "5",
        ]);
        // Runs of whitespace collapse and the ends are trimmed, so a line the model laid out for
        // readability is the same argv as the tidy one.
        expect(await argvOf("  --ticker   NVDA\n")).toEqual(["--ticker", "NVDA"]);
        // "" is an answer: a program that takes no arguments is run with none.
        expect(await argvOf("")).toEqual([]);

        // And the metacharacters are ordinary words, because there is no shell here to read them.
        // A caller who believes otherwise will eventually pass a redirect and wonder where its
        // output went — so it arrives as an argument instead, visibly, rather than half-working.
        expect(await argvOf("--out result.csv > elsewhere.csv")).toEqual([
          "--out",
          "result.csv",
          ">",
          "elsewhere.csv",
        ]);
        expect(existsSync(join(r.home, "elsewhere.csv"))).toBe(false);
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(!CAN_RUN)(
    "a nonzero exit is a refusal carrying the streams, and it is logged as the failure it was",
    async () => {
      const r = rig(localVenv());
      try {
        // A procedure, because the second half of this test is about the LOG, and the rig opens
        // none by default: outside one the run tools deliberately leave no record.
        r.openProcedure();
        const scriptId = seedProgram(
          r,
          "broken",
          "import sys\n" +
            'print("fetched 41 rows")\n' +
            'sys.stderr.write("KeyError: \'close\'\\n")\n' +
            "sys.exit(3)\n",
        );
        const res = await call(r.tool("run_script"), {
          script_id: scriptId,
          argument: "--ticker NVDA",
        });
        const refusal = failure(res);
        expect(refusal.error).toBe("script_failed");
        expect(refusal.message).toContain("broken exited 3");
        // The reason a run failed is DATA — a code and two streams — and folding it into a sentence
        // would leave the model guessing at what its own program complained about. Both streams
        // ride in the detail, including stdout: a script that printed progress before falling over
        // has already said how far it got.
        const failed = detail(res);
        expect(failed["exit_code"]).toBe(3);
        expect(failed["stderr"]).toContain("KeyError");
        expect(failed["stdout"]).toContain("fetched 41 rows");
        // A failing run reads exactly like a succeeding one: same directory, same two logs, so the
        // advice to go and read the rest is as good here as anywhere.
        expect(runFiles(r, failed["output_directory"] as string)).toEqual([
          "script.py",
          "stderr.log",
          "stdout.log",
        ]);

        // Logged, and logged as a failure. A measurement that refused is part of what producing a
        // report actually involved, so publishing records it — a record that kept only the runs
        // that worked would read as a straight line through work that was not one.
        const runLog = r.runs.entries();
        expect(runLog).toHaveLength(1);
        const entry = runLog[0]!;
        expect(entry).toMatchObject({ kind: "script", scriptId, argument: "--ticker NVDA" });
        // The entry is CLOSED, and it was closed by the tool rather than by anything here: the
        // finalizer runs in a `finally`, so a run that fell over still lands as a finished entry
        // rather than an open one that would block every later publish for ever.
        expect(entry.outcome).toMatchObject({ ok: false, exitCode: 3 });
        // What it printed goes into the log as one column, stdout first and stderr under a marker,
        // because a failing run's two streams are one story and a column that held only the tidy
        // half would be the wrong half.
        expect(entry.outcome!.return).toContain("fetched 41 rows");
        expect(entry.outcome!.return).toContain("KeyError");

        // And filed in the ERROR log as well, which is a different reader with a different need.
        // The refusal is this model's answer and it is gone with the turn; the log row is for the
        // person looking at the installation's failures afterwards, who has no transcript in front
        // of them and who is precisely the one who notices that the same script has been exiting 3
        // all week. It is the only failure in this module that is logged, because it is the only
        // one that is not an argument mistake.
        const logged = listErrors(r.db, {}).entries;
        expect(logged).toHaveLength(1);
        expect(logged[0]!.scope).toBe("run");
        expect(logged[0]!.message).toBe("broken exited 3");
        // The exit code and the TAIL of stderr, because a traceback's actual message is at the end
        // of it — and the whole stream is on disk in the run directory either way.
        const detailed = JSON.parse(logged[0]!.detail!) as Record<string, unknown>;
        expect(detailed["exit_code"]).toBe(3);
        expect(detailed["script_id"]).toBe(scriptId);
        expect(detailed["stderr_tail"]).toContain("KeyError");
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(!CAN_RUN)(
    "every run gets its own directory in the home directory, with both streams whole on disk",
    async () => {
      const r = rig(localVenv());
      try {
        // More than the result can carry, so the clip is exercised rather than described. A tool
        // result is capped and an engine report routinely passes the cap; a truncated stream
        // reaching the model is how a number gets read off a document that stops mid-sentence.
        const scriptId = seedProgram(
          r,
          "loud",
          "import sys, pathlib\n" +
            'sys.stdout.write("o" * 20000)\n' +
            'sys.stderr.write("e" * 20000)\n' +
            'pathlib.Path("landed.csv").write_text("date,close\\n")\n',
        );
        const first = body(await call(r.tool("run_script"), { script_id: scriptId, argument: "" }));
        const second = body(await call(r.tool("run_script"), { script_id: scriptId, argument: "" }));

        // Fresh each time, so two runs never read each other's files — and inside the home
        // directory, which is the only tree this program may write in at all.
        expect(first["output_directory"]).toMatch(/^runs\/[0-9a-f]+$/);
        expect(second["output_directory"]).not.toBe(first["output_directory"]);
        expect(readdirSync(join(r.home, "runs")).sort()).toHaveLength(2);
        expect(runFiles(r, first["output_directory"] as string)).toEqual([
          "script.py",
          "stderr.log",
          "stdout.log",
        ]);

        // The result carries a digest and says where the rest is; the directory carries all of it.
        // That is what makes "read the whole stream in the run directory" advice the model can act
        // on rather than a sentence about a file that holds the same truncation.
        expect(first["stdout"] as string).toContain("characters omitted");
        const dir = join(r.home, first["output_directory"] as string);
        expect(readFileSync(join(dir, "stdout.log"), "utf8")).toBe("o".repeat(20000));
        expect(readFileSync(join(dir, "stderr.log"), "utf8")).toBe("e".repeat(20000));

        // A relative path in the program lands in the home directory, because that is the working
        // directory: the run's own directory is for what the RUN produced, not for what the program
        // decided to write.
        expect(existsSync(join(r.home, "landed.csv"))).toBe(true);
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(!CAN_RUN)(
    "the run is confined to the home directory, and carries none of the model's own credentials",
    async () => {
      const r = rig(localVenv());
      try {
        // Both halves of the boundary in one program, because they fail the same way when they
        // fail: silently, and only in the record. These tools exist to make a run RECORDED, and a
        // recorded run that could edit the record — or spend the key the recording is made with —
        // would be worse than an unrecorded one.
        const scriptId = seedProgram(
          r,
          "prowler",
          "import os, pathlib\n" +
            'outside = pathlib.Path(os.environ["YEWREVIEW_VAR_DIR"]) / "escaped.txt"\n' +
            "try:\n" +
            '    outside.write_text("I was here")\n' +
            '    print("wrote", outside)\n' +
            "except OSError as exc:\n" +
            '    print("refused:", type(exc).__name__)\n' +
            'print("key:", os.environ.get("ANTHROPIC_API_KEY", "absent"))\n',
        );

        const previous = process.env["ANTHROPIC_API_KEY"];
        process.env["ANTHROPIC_API_KEY"] = "sk-ant-not-a-real-key";
        let out: Record<string, unknown>;
        try {
          out = body(await call(r.tool("run_script"), { script_id: scriptId, argument: "" }));
        } finally {
          if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
          else process.env["ANTHROPIC_API_KEY"] = previous;
        }

        expect(out["stdout"]).toContain("refused:");
        expect(existsSync(join(r.h.varDir, "escaped.txt"))).toBe(false);
        // Stripped rather than merely unused. A data script has no business talking to the model's
        // provider, and a key in the environment of a program the agent wrote is a key the agent
        // can exfiltrate through it.
        expect(out["stdout"]).toContain("key: absent");
        expect(out["stdout"]).not.toContain("sk-ant-not-a-real-key");
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(!CAN_RUN)(
    "a run is logged only while a generation is recording, and the tool works either way",
    async () => {
      const r = rig(localVenv());
      try {
        const scriptId = seedProgram(r, "prices", 'print("done")\n');
        // The recording half needs a procedure open — the rig opens none by default.
        r.openProcedure();
        const inside = body(
          await call(r.tool("run_script"), { script_id: scriptId, argument: "--ticker NVDA" }),
        );
        expect(inside["recorded"]).toBe(true);
        expect(r.runs.entries()).toEqual([
          {
            kind: "script",
            scriptId,
            argument: "--ticker NVDA",
            at: expect.any(Number),
            // Finished, not merely started: the entry's second half is written by the same call
            // that opened it, so the log a publish reads has nothing hanging in it.
            outcome: {
              ok: true,
              exitCode: 0,
              durationMs: expect.any(Number),
              return: "done\n",
            },
          },
        ]);

        // Outside a procedure the tool still runs — the agent has a shell and could run the program
        // itself, so refusing here would buy nothing — it simply leaves no record, because there is
        // no report for a record to be part of. `recorded` says which of the two just happened, so
        // the model is never guessing whether its work is being written down.
        r.runs.end("cancelled");
        const outside = body(
          await call(r.tool("run_script"), { script_id: scriptId, argument: "--ticker AMD" }),
        );
        expect(outside["exit_code"]).toBe(0);
        expect(outside["recorded"]).toBe(false);
        expect(r.runs.entries()).toEqual([]);

        // And the next procedure starts empty: a run made between two of them belongs to neither
        // report, which is the only honest place for it.
        r.runs.start(r.recipeId);
        expect(r.runs.entries()).toEqual([]);
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(!CAN_CONFINE)(
    "an ordinary command is logged as a shell line, which is the kind that names no program",
    async () => {
      // The counterpart to the measurement test further down, and the pair is the whole of what the
      // three kinds mean. `run_shell` cannot name a program — there is no stored script behind
      // `shasum` — so its entry is the kind that carries only the line, and it lands in the history
      // that names nothing else in the archive. The engine's own runs used to land there too; what
      // separates them now is which tool spawned the process, not what anybody says about it after.
      const r = rig(localVenv());
      try {
        r.runs.start(r.recipeId);
        const out = body(await call(r.tool("run_shell"), { command: "echo measured" }));
        expect(out["exit_code"]).toBe(0);
        expect(out["stdout"]).toContain("measured");

        const entry = onlyShellRun(r);
        expect(entry.command).toBe("echo measured");
        expect(entry.outcome).toMatchObject({ ok: true, exitCode: 0 });
      } finally {
        r.cleanup();
      }
    },
  );
});

describe("create_thesis", () => {
  test("without the engine, a thesis is refused rather than stored without an identity — and the run is not spent", async () => {
    const r = rig();
    try {
      const runId = r.runs.seed(null);
      const res = await call(r.tool("create_thesis"), {
        name: "dip buying",
        content: "A close below the 20-day mean is bought within three days.",
        dsl_json: JSON.stringify({ name: "dip" }),
        tag: "insightful",
        assessment: "Three of five cells fire, and the mechanism holds where they do.",
        seikan_run_id: runId,
      });
      const refusal = failure(res);
      expect(refusal.error).toBe("venv_unavailable");
      expect(refusal.message).toContain("not installed");
      // Nothing in EITHER table: the act is one act, and half of it landing would be the bug.
      expect(r.db.query("SELECT COUNT(*) AS n FROM thesis").get()).toEqual({ n: 0 });
      expect(r.db.query("SELECT COUNT(*) AS n FROM thesis_assessment").get()).toEqual({ n: 0 });
      // The identity check comes BEFORE the redemption, so an engineless refusal leaves the run
      // where it was — redeemable when the environment is fixed, rather than spent on a call that
      // could never have filed it.
      expect(r.runs.redeem(runId)).not.toBeNull();
    } finally {
      r.cleanup();
    }
  });

  test("the first round rides the same call, and the report itself is still refused as an argument", () => {
    const r = rig();
    try {
      // The version this replaces stored the container alone — "a document is stored before it is
      // judged" — and the archive filled with claims presented without saying how they read. The
      // round now rides the storing call, so omitting it is an incomplete request; what did NOT
      // change is that the report is REDEEMED from the run rather than typed, so `seikan_report`
      // as a key is refused exactly as it is on `assess_thesis`.
      const schema = schemaOf(definitions(r.deps).find((d) => d.name === "create_thesis")!);
      expect(Object.keys(schema.shape).sort()).toEqual([
        "assessment",
        "content",
        "dsl_json",
        "name",
        "seikan_run_id",
        "series_preparations",
        "tag",
        "tickers",
      ]);
      const bare = schema.safeParse({
        name: "dip buying",
        content: "A close below the 20-day mean is bought within three days.",
        dsl_json: "{}",
      });
      expect(bare.success).toBe(false);

      const retyped = schema.safeParse({
        name: "dip buying",
        content: "A close below the 20-day mean is bought within three days.",
        dsl_json: "{}",
        tag: "insightful",
        assessment: "Three of five cells fire, and the mechanism holds where they do.",
        seikan_run_id: "retained-1",
        seikan_report: SEIKAN_REPORT,
      });
      expect(retyped.success).toBe(false);
      expect(retyped.error!.issues.map((issue) => issue.code)).toContain("unrecognized_keys");
    } finally {
      r.cleanup();
    }
  });

  test.skipIf(LOCAL_PYTHON === null)(
    "a run of a different document is refused by hash, and nothing lands",
    async () => {
      const r = rig({
        ready: true,
        python: LOCAL_PYTHON,
        seikanBin: null,
        seikanVersion: null,
        dslGuide: null,
        error: null,
      });
      try {
        seedTarget(r.db, "NVDA");
        const dsl = {
          name: "dip",
          data: { targets: ["NVDA"] },
          entry: {
            type: "threshold",
            left: { type: "field", column: "close" },
            op: "<",
            right: { type: "constant", value: 95.5 },
          },
          params: { horizon: 3 },
        };
        // A document-mode run of some OTHER bytes: the seeded hash is well-formed and real-looking,
        // and the whole point is that it is not THIS document's.
        const runId = r.runs.seed(null, SEIKAN_REPORT, "b".repeat(64));
        const res = await call(r.tool("create_thesis"), {
          name: "dip buying",
          content: "A close below 95.5 is bought within three days.",
          dsl_json: JSON.stringify(dsl),
          tag: "insightful",
          assessment: "Three of five cells fire, and the mechanism holds where they do.",
          seikan_run_id: runId,
        });
        const refusal = failure(res);
        expect(refusal.error).toBe("invalid_request");
        expect(refusal.message).toContain("measured a different document");
        expect(r.db.query("SELECT COUNT(*) AS n FROM thesis").get()).toEqual({ n: 0 });
        expect(r.db.query("SELECT COUNT(*) AS n FROM thesis_assessment").get()).toEqual({ n: 0 });
        // Spent, and stated rather than fixed: redemption precedes the hash check, on the same
        // ordering `assess_thesis` has always had, and every refusal says to measure again.
        expect(r.runs.redeem(runId)).toBeNull();
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(LOCAL_PYTHON === null)(
    "an unknown script in the preparations takes the whole act down, thesis included",
    async () => {
      const r = rig({
        ready: true,
        python: LOCAL_PYTHON,
        seikanBin: null,
        seikanVersion: null,
        dslGuide: null,
        error: null,
      });
      try {
        seedTarget(r.db, "NVDA");
        const dsl = {
          name: "dip",
          data: { targets: ["NVDA"] },
          entry: {
            type: "threshold",
            left: { type: "field", column: "close" },
            op: "<",
            right: { type: "constant", value: 95.5 },
          },
          params: { horizon: 3 },
        };
        const res = await call(r.tool("create_thesis"), {
          name: "dip buying",
          content: "A close below 95.5 is bought within three days.",
          dsl_json: JSON.stringify(dsl),
          tag: "insightful",
          assessment: "Three of five cells fire, and the mechanism holds where they do.",
          seikan_run_id: r.runs.seed(null, SEIKAN_REPORT, canonicalHash(dsl)),
          series_preparations: [{ script_id: "no-such-script", argument: "NVDA" }],
        });
        expect(failure(res).error).toBe("not_found");
        // One transaction, four tables, nothing: a thesis without its first reading on record
        // would be exactly the half-landed state the outer transaction exists to make impossible.
        for (const table of ["thesis", "regime", "thesis_assessment", "series_preparation"]) {
          expect(r.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(LOCAL_PYTHON === null)(
    "with the engine, identity and regime come from the document, and the first round lands with it",
    async () => {
      const r = rig({
        ready: true,
        python: LOCAL_PYTHON,
        seikanBin: null,
        seikanVersion: null,
        dslGuide: null,
        error: null,
      });
      try {
        seedTarget(r.db, "NVDA");
        const dsl = {
          name: "dip",
          data: { targets: ["NVDA", "risk_free_rate"] },
          entry: {
            type: "threshold",
            left: { type: "field", column: "close" },
            op: "<",
            right: { type: "constant", value: 95.5 },
          },
          params: { horizon: 3 },
        };
        // A document-mode run of these exact bytes — thesisId null, since nothing is stored yet —
        // seeded with the hash the engine itself mints, which is what the tool's verification
        // compares against.
        const runId = r.runs.seed(null, SEIKAN_REPORT, canonicalHash(dsl));
        const res = await call(r.tool("create_thesis"), {
          name: "dip buying",
          content: "A close below 95.5 is bought within three days.",
          dsl_json: JSON.stringify(dsl),
          tag: "insightful",
          assessment: "Three of five cells fire, and the mechanism holds where they do.",
          seikan_run_id: runId,
        });
        expect(res.isError).toBeUndefined();
        const thesis = body(res)["thesis"] as {
          dsl_hash: string;
          dsl_json: string;
          regime: string[];
          latest_tag: string | null;
          assessed_at: number | null;
        };
        expect(thesis.dsl_hash).toMatch(/^[0-9a-f]{64}$/);
        // Stored byte-for-byte: the hash carries identity across spellings, so re-serialising here
        // would only throw away the document its author reads.
        expect(thesis.dsl_json).toBe(JSON.stringify(dsl));
        // The regime is read off the target KEYS, which is all a path-free document says about
        // which instruments it measures: one is a symbol, the other is a descriptive name no
        // ticker grammar accepts — so that target contributes nothing rather than a guess.
        expect(thesis.regime).toEqual(["NVDA"]);
        // Born measured: the returned row already carries the first round's answer, and the
        // report beside it is the seeded run's bytes, redeemed rather than retyped.
        expect(thesis.latest_tag).toBe("insightful");
        expect(thesis.assessed_at).not.toBeNull();
        expect(summary(res)).toBe("Stored dip-buying and filed insightful as its first reading.");
        const assessment = body(res)["assessment"] as { seikan_report: string };
        expect(assessment.seikan_report).toBe(SEIKAN_REPORT);

        const spare = r.runs.seed(null);
        const invalid = await call(r.tool("create_thesis"), {
          name: "nonsense",
          content: "Not a measurable statement.",
          dsl_json: JSON.stringify({ name: "x", data: {} }),
          tag: "insightful",
          assessment: "Three of five cells fire, and the mechanism holds where they do.",
          seikan_run_id: spare,
        });
        expect(failure(invalid).error).toBe("dsl_invalid");
        // And the invalid document never reached the redemption: the run is still there.
        expect(r.runs.redeem(spare)).not.toBeNull();
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(LOCAL_PYTHON === null)(
    "a first round tagged abandoned stores, and closes the ledger at birth",
    async () => {
      // Legal, and occasionally right: a replacement thesis whose first honest reading is that
      // the evidence already emptied it out. The abandoned-is-terminal trigger reads a one-row-old
      // empty ledger on the way in and holds afterwards exactly as it does for any other ledger.
      const r = rig({
        ready: true,
        python: LOCAL_PYTHON,
        seikanBin: null,
        seikanVersion: null,
        dslGuide: null,
        error: null,
      });
      try {
        seedTarget(r.db, "NVDA");
        const dsl = {
          name: "dip",
          data: { targets: ["NVDA"] },
          entry: {
            type: "threshold",
            left: { type: "field", column: "close" },
            op: "<",
            right: { type: "constant", value: 95.5 },
          },
          params: { horizon: 3 },
        };
        const res = await call(r.tool("create_thesis"), {
          name: "dip buying",
          content: "A close below 95.5 is bought within three days.",
          dsl_json: JSON.stringify(dsl),
          tag: "abandoned",
          assessment: "The corrected window empties it out entirely; filed for the record only.",
          seikan_run_id: r.runs.seed(null, SEIKAN_REPORT, canonicalHash(dsl)),
        });
        expect(res.isError).toBeUndefined();
        const thesis = body(res)["thesis"] as { id: string; latest_tag: string };
        expect(thesis.latest_tag).toBe("abandoned");

        const again = await call(r.tool("assess_thesis"), {
          thesis_id: thesis.id,
          tag: "insightful",
          assessment: "A second thought, which a closed ledger must not take.",
          seikan_run_id: r.runs.seed(thesis.id),
        });
        expect(failure(again).error).toBe("conflict");
        expect(failure(again).message).toContain("never revived");
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(LOCAL_PYTHON === null)(
    "a basket-mode document crosses the identity script whole, and every member is the regime",
    async () => {
      // The config-class canary for `target_mode`: the field has to survive the venv identity
      // script and canonicalisation, and a basket's target keys all name instruments.
      const r = rig({
        ready: true,
        python: LOCAL_PYTHON,
        seikanBin: null,
        seikanVersion: null,
        dslGuide: null,
        error: null,
      });
      try {
        seedTarget(r.db, "NVDA");
        seedTarget(r.db, "AMD");
        const dsl = {
          name: "pair momentum",
          target_mode: "basket",
          data: { targets: ["NVDA", "AMD"] },
          entry: {
            type: "threshold",
            left: { type: "field", column: "close" },
            op: "<",
            right: { type: "constant", value: 95.5 },
          },
          params: { horizon: 3 },
        };
        const res = await call(r.tool("create_thesis"), {
          name: "relative momentum",
          content: "The weaker of the pair keeps underperforming over the next three bars.",
          dsl_json: JSON.stringify(dsl),
          tag: "insightful",
          assessment: "Three of five cells fire, and the mechanism holds where they do.",
          seikan_run_id: r.runs.seed(null, SEIKAN_REPORT, canonicalHash(dsl)),
        });
        expect(res.isError).toBeUndefined();
        const thesis = body(res)["thesis"] as { dsl_hash: string; regime: string[] };
        expect(thesis.dsl_hash).toMatch(/^[0-9a-f]{64}$/);
        // Both keys are symbols, so both instruments are the regime (hydrated in ticker order).
        expect(thesis.regime).toEqual(["AMD", "NVDA"]);
      } finally {
        r.cleanup();
      }
    },
  );
});

/**
 * A thesis the engine actually measures: two targets, one trivial firing condition, a horizon.
 *
 * Two targets because the interesting half of what `run_seikan` records is the SET of series keys a
 * run bound, and a set of one cannot show that it is sorted. The condition is deliberately dull —
 * what is under test here is the plumbing between a stored document, the files a run binds to it and
 * the record of having done so, not whether the idea is any good.
 */
const PAIR_DSL = {
  name: "pair dips",
  data: { targets: ["NVDA", "AMD"] },
  entry: {
    type: "threshold",
    left: { type: "field", column: "close" },
    op: "<",
    right: { type: "constant", value: 98 },
  },
  params: { horizon: 3 },
};

/**
 * A thesis that reads an EXTERNAL FEED, which is where the question of which column arises at all.
 *
 * A target's file is that instrument's own and says so by its OHLCV shape; a feed's file belongs to
 * whoever ships the feed, and one vendor's CSV routinely carries several series under spellings only
 * that vendor chose. The thesis declares what `iv30` MEANS to it and nothing about where it lives or
 * what it is called there — so the run has to say both.
 */
const FEED_DSL = {
  name: "vol regime",
  data: { targets: ["NVDA"], external: { iv30: {} } },
  entry: {
    type: "threshold",
    left: { type: "external", name: "iv30" },
    op: ">",
    right: { type: "constant", value: 25 },
  },
  params: { horizon: 3 },
};

/**
 * An OHLCV file the engine's strict data contract accepts: ISO dates, ascending and unique, prices
 * positive with high and low actually bracketing open and close.
 *
 * Generated rather than checked in, and deterministic from `seed`, so two targets can share one bar
 * index — a multi-target run refuses unequal indices rather than intersecting them — without a
 * fixture file that would have to be regenerated whenever the contract tightens.
 */
function ohlcvCsv(bars: number, seed: number): string {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const rows = ["datetime,open,high,low,close,volume"];
  let price = 100;
  const start = Date.UTC(2024, 0, 1);
  for (let bar = 0; bar < bars; bar += 1) {
    price *= 1 + (next() - 0.5) * 0.04;
    const open = price;
    const close = price * (1 + (next() - 0.5) * 0.02);
    const high = Math.max(open, close) * 1.005;
    const low = Math.min(open, close) * 0.995;
    const day = new Date(start + bar * 86_400_000).toISOString().slice(0, 10);
    rows.push(
      `${day},${open.toFixed(4)},${high.toFixed(4)},${low.toFixed(4)},${close.toFixed(4)},1000`,
    );
  }
  return `${rows.join("\n")}\n`;
}

/**
 * A vendor's volatility surface: one file, two numeric series in it, and no way to tell from the
 * outside which of them a feed key means.
 *
 * The two columns are the whole point. A file holding a single value column names itself, so a run
 * over one could never show that a binding was carried; this one the engine refuses outright until
 * the invocation says which column it reads.
 */
function surfaceCsv(bars: number, seed: number): string {
  let state = seed;
  const rows = ["datetime,iv_30d,iv_90d"];
  const start = Date.UTC(2024, 0, 1);
  for (let bar = 0; bar < bars; bar += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    // Straddling the thesis's cutoff of 25, so the condition fires over and over and the run has
    // real observations to measure rather than an empty grid.
    const iv30 = 20 + (state / 2147483648) * 14;
    const day = new Date(start + bar * 86_400_000).toISOString().slice(0, 10);
    rows.push(`${day},${iv30.toFixed(3)},${(iv30 * 0.9 + 3).toFixed(3)}`);
  }
  return `${rows.join("\n")}\n`;
}

/** Write a series file into the home directory and hand back the home-relative path a run names it
 * by. */
function series(r: Rig, relPath: string, contents: string): string {
  const abs = join(r.home, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  return relPath;
}

/** A thesis stored through the tool that stores one, so its document and its hash are the engine's
 * own rather than something this file made up. Storing files a first round now, so the fixture
 * seeds the instruments the document names and a document-mode run of its exact bytes — the same
 * two things a real first storing needs. */
async function storedThesis(
  r: Rig,
  name: string,
  dsl: unknown,
): Promise<{ id: string; hash: string }> {
  const declared = ((dsl as { data?: { targets?: string[] } }).data?.targets ?? []).filter(
    (key) => /^[A-Z][A-Z0-9.]{0,9}$/.test(key),
  );
  for (const ticker of declared) seedTarget(r.db, ticker);
  const res = await call(r.tool("create_thesis"), {
    name,
    content: "Both names keep falling for three days after a close under 98.",
    dsl_json: JSON.stringify(dsl),
    tag: "insightful",
    assessment: "Three of five cells fire, and the mechanism holds where they do.",
    seikan_run_id: r.runs.seed(null, SEIKAN_REPORT, canonicalHash(dsl)),
  });
  expect(res.isError).toBeUndefined();
  const thesis = body(res)["thesis"] as { id: string; dsl_hash: string };
  return { id: thesis.id, hash: thesis.dsl_hash };
}

describe("run_seikan", () => {
  test("a thesis id naming nothing is refused, and nothing is spawned for it", async () => {
    const r = rig(NOWHERE);
    try {
      const res = await call(r.tool("run_seikan"), {
        thesis_id: "no-such-thesis",
        data: { NVDA: "data/nvda.csv" },
      });
      const refusal = failure(res);
      expect(refusal.error).toBe("not_found");
      expect(refusal.message).toContain("give either its id or its name");
      expect(existsSync(join(r.home, "runs"))).toBe(false);
      expect(r.runs.entries()).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  test("a measurement is of exactly one document: both and neither are refused, engine or no engine", async () => {
    // The XOR is a property of the REQUEST and is judged before the venv, so a machine with no
    // engine still gets the real sentence rather than a venv refusal about a malformed ask.
    const r = rig();
    try {
      const neither = await call(r.tool("run_seikan"), { data: { NVDA: "data/nvda.csv" } });
      expect(failure(neither).error).toBe("invalid_request");
      expect(failure(neither).message).toContain("exactly one document");

      const both = await call(r.tool("run_seikan"), {
        thesis_id: seedThesis(r.db, "dip buying"),
        dsl_json: "{}",
        data: { NVDA: "data/nvda.csv" },
      });
      expect(failure(both).error).toBe("invalid_request");
      expect(failure(both).message).toContain("never both and never neither");
      expect(r.runs.entries()).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  test("without the engine, a measurement is refused rather than described", async () => {
    const r = rig();
    try {
      const res = await call(r.tool("run_seikan"), {
        thesis_id: seedThesis(r.db, "dip buying"),
        data: { NVDA: "data/nvda.csv" },
      });
      const refusal = failure(res);
      expect(refusal.error).toBe("venv_unavailable");
      // The remedy named is to SAY SO, because the alternative a model reaches for here is prose
      // about numbers it could not compute — and a report is read months later by somebody with no
      // way to tell a measured figure from a plausible one.
      expect(refusal.message).toContain("say so plainly");
      expect(r.runs.entries()).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  test("a measurement with no series behind it is refused before anything is spawned", async () => {
    const r = rig(NOWHERE);
    try {
      // A thesis says WHICH series it measures and never where they are, so this call is where they
      // are. With none, there is nothing to measure over — and the engine would say so too, but a
      // subprocess spent to learn that is a subprocess spent on a mistake this side already knows.
      const res = await call(r.tool("run_seikan"), {
        thesis_id: seedThesis(r.db, "dip buying"),
        data: {},
      });
      const refusal = failure(res);
      expect(refusal.error).toBe("invalid_request");
      expect(refusal.message).toContain("one data entry per key");
      expect(existsSync(join(r.home, "runs"))).toBe(false);
      expect(r.runs.entries()).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  test("a series file outside the home directory is refused, resolved rather than merely spelled", async () => {
    const r = rig(NOWHERE);
    try {
      const thesisId = seedThesis(r.db, "dip buying");
      // A real file, somewhere the agent does not own. Both spellings of it are refused, and
      // the relative one is the reason the check resolves before it judges: `../../` looks like an
      // ordinary path right up until you follow it.
      const outside = join(r.h.varDir, "borrowed.csv");
      writeFileSync(outside, ohlcvCsv(10, 3));

      const relative = await call(r.tool("run_seikan"), {
        thesis_id: thesisId,
        data: { NVDA: "../borrowed.csv" },
      });
      expect(failure(relative).error).toBe("invalid_path");
      expect(failure(relative).message).toContain("resolves outside your home directory");

      const absolute = await call(r.tool("run_seikan"), {
        thesis_id: thesisId,
        data: { NVDA: outside },
      });
      expect(failure(absolute).error).toBe("invalid_path");
      expect(failure(absolute).message).toContain("relative to your home directory");

      // Refused before the run directory is made, so a rejected call leaves no trace at all — and
      // no log line, because nothing ran.
      expect(existsSync(join(r.home, "runs"))).toBe(false);
      expect(r.runs.entries()).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  test("naming a column changes what is asked, not where the file may be", async () => {
    const r = rig(NOWHERE);
    try {
      const thesisId = seedThesis(r.db, "dip buying");
      series(r, "data/nvda.csv", ohlcvCsv(10, 3));
      const outside = join(r.h.varDir, "borrowed.csv");
      writeFileSync(outside, ohlcvCsv(10, 3));

      // The object form is the plain one with a second fact in it, and the second fact is not a
      // path — so containment answers it exactly as before, resolved rather than merely spelled.
      const escaping = await call(r.tool("run_seikan"), {
        thesis_id: thesisId,
        data: { NVDA: { path: "../borrowed.csv", column: "yield_10y" } },
      });
      expect(failure(escaping).error).toBe("invalid_path");
      expect(failure(escaping).message).toContain("resolves outside your home directory");

      // A column of spaces names nothing any file could answer. The engine would refuse it too, but
      // it would refuse from inside a subprocess, having first read the file — and a request this
      // side can already see is unanswerable is not worth spawning anything to learn about.
      const blank = await call(r.tool("run_seikan"), {
        thesis_id: thesisId,
        data: { NVDA: { path: "data/nvda.csv", column: "   " } },
      });
      expect(failure(blank).error).toBe("invalid_request");
      expect(failure(blank).message).toContain("the column bound to NVDA is blank");

      expect(existsSync(join(r.home, "runs"))).toBe(false);
      expect(r.runs.entries()).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  test.skipIf(!CAN_MEASURE)(
    "binds every series it was handed, keeps the engine's report on disk, and hands back a digest",
    async () => {
      const r = rig(localVenv());
      try {
        const thesis = await storedThesis(r, "pair dips", PAIR_DSL);
        series(r, "data/nvda.csv", ohlcvCsv(300, 7));
        series(r, "data/amd.csv", ohlcvCsv(300, 99));

        const res = await call(r.tool("run_seikan"), {
          thesis_id: thesis.id,
          data: { NVDA: "data/nvda.csv", AMD: "data/amd.csv" },
          outputs: ["trades"],
          thresholds: { min_trades: 50 },
        });
        expect(res.isError).toBeUndefined();
        const out = body(res);

        // Everything the run produced is in the run's own directory, inside the home directory: the
        // document that was measured, the report, the extra output that was asked for, and both
        // streams. Nothing here was written anywhere else.
        expect(out["report_path"]).toMatch(/^runs\/[0-9a-f]+\/report\.json$/);
        expect(runFiles(r, dirname(out["report_path"] as string))).toEqual([
          "report.json",
          "stderr.log",
          "stdout.log",
          "thesis.json",
          "trades.csv",
        ]);
        expect(out["extra_outputs"]).toEqual({
          trades: `${dirname(out["report_path"] as string)}/trades.csv`,
        });

        const report = JSON.parse(readFileSync(join(r.home, out["report_path"] as string), "utf8")) as {
          identity: { dsl_hash: string; thresholds: Record<string, number> };
        };
        // The engine measured the document the database holds — the hash it computed at creation is
        // the hash it reports now — and the knob rode in as an override rather than being described.
        expect(report.identity.dsl_hash).toBe(thesis.hash);
        expect(out["dsl_hash"]).toBe(thesis.hash);
        expect(report.identity.thresholds["thesis_min_trades"]).toBe(50);

        // The whole digest, locked, because what it does NOT carry is the point. `n_passed` is how
        // many cells cleared the checklist — a count, not a test anything passed — and there is no
        // verdict, recommendation or headline beside it. The engine crowns nobody, and a summary
        // that crowned something would be the one place in this codebase that did.
        expect(Object.keys(out["measurement"] as object).sort()).toEqual([
          "index_end",
          "index_start",
          "n_bars",
          "n_hypotheses_attempted",
          "outcome",
          "target_mode",
        ]);
        expect(Object.keys(out["checklist"] as object).sort()).toEqual([
          "n_cells",
          "n_passed",
          "policy_version",
          "run_checks",
        ]);
        expect(out["measurement"]).toMatchObject({ n_bars: 300, target_mode: "conjunction" });
        expect(summary(res)).toContain("assess_thesis");
        // And it is a digest because the report is too big to carry: a tool result is capped, and a
        // truncated report is how a number gets read off a document that stops mid-sentence.
        expect(res.content[1]!.text.length).toBeLessThan(
          readFileSync(join(r.home, out["report_path"] as string), "utf8").length,
        );
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(!CAN_MEASURE)(
    "the run id it hands back is what assess_thesis files against, and the bytes filed are the engine's own",
    async () => {
      const r = rig(localVenv());
      try {
        const thesis = await storedThesis(r, "pair dips", PAIR_DSL);
        series(r, "data/nvda.csv", ohlcvCsv(300, 7));
        series(r, "data/amd.csv", ohlcvCsv(300, 99));
        const out = body(
          await call(r.tool("run_seikan"), {
            thesis_id: thesis.id,
            data: { NVDA: "data/nvda.csv", AMD: "data/amd.csv" },
          }),
        );

        const filed = await call(r.tool("assess_thesis"), {
          thesis_id: thesis.id,
          tag: "insightful",
          assessment: "The cells that fire are thin, so it is worth watching rather than solid.",
          seikan_run_id: out["run_id"],
        });
        expect(filed.isError).toBeUndefined();
        // What the engine wrote, because the model never had it in hand: the report went from the
        // run's directory into the column without passing through a summary that could round it,
        // shorten it or improve it on the way. The only thing between the file and the row is the
        // repository trimming the newline the engine ends its file with, which is nobody's reading
        // of anything.
        expect((body(filed)["assessment"] as { seikan_report: string }).seikan_report).toBe(
          readFileSync(join(r.home, out["report_path"] as string), "utf8").trim(),
        );

        // And it was spendable exactly once: the token is gone, so a second reading of this thesis
        // means measuring it again rather than re-filing the same afternoon.
        const again = await call(r.tool("assess_thesis"), {
          thesis_id: thesis.id,
          tag: "approven",
          assessment: "Reading the same numbers again, more generously, now that time has passed.",
          seikan_run_id: out["run_id"],
        });
        expect(failure(again).error).toBe("not_found");
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(!CAN_MEASURE)(
    "a document not stored yet is measured whole, and create_thesis redeems the run",
    async () => {
      // The first measurement's shape, end to end: nothing is stored, so the document rides the
      // call as dsl_json, the run is retained against no thesis id, and the id it hands back is
      // what `create_thesis` verifies against the exact bytes it is then given.
      const r = rig(localVenv());
      try {
        seedTarget(r.db, "NVDA");
        seedTarget(r.db, "AMD");
        series(r, "data/nvda.csv", ohlcvCsv(300, 7));
        series(r, "data/amd.csv", ohlcvCsv(300, 99));
        // Inside a procedure, so the run also lands in the log as the seikan kind — a document-mode
        // measurement is a command like any other, and a report's account must not depend on
        // whether the thesis was stored when the engine ran.
        r.runs.start(r.recipeId);
        const res = await call(r.tool("run_seikan"), {
          dsl_json: JSON.stringify(PAIR_DSL),
          data: { NVDA: "data/nvda.csv", AMD: "data/amd.csv" },
        });
        expect(res.isError).toBeUndefined();
        const out = body(res);
        // The summary points the id at the redeemer a document-mode run belongs to, and the
        // payload says plainly that no stored thesis was measured.
        expect(summary(res)).toContain("create_thesis");
        expect(out["thesis"]).toBeNull();
        expect(onlySeikanRun(r).command).toContain(" run ");

        const stored = await call(r.tool("create_thesis"), {
          name: "pair dips",
          content: "Both names keep falling for three days after a close under 98.",
          dsl_json: JSON.stringify(PAIR_DSL),
          tag: "insightful",
          assessment: "The cells that fire are thin, so it is worth watching rather than solid.",
          seikan_run_id: out["run_id"],
        });
        expect(stored.isError).toBeUndefined();
        const thesis = body(stored)["thesis"] as { latest_tag: string };
        expect(thesis.latest_tag).toBe("insightful");
        // The engine's own bytes, off the run's directory and into the column with no retyping.
        expect((body(stored)["assessment"] as { seikan_report: string }).seikan_report).toBe(
          readFileSync(join(r.home, out["report_path"] as string), "utf8").trim(),
        );
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(!CAN_MEASURE)(
    "a measurement is logged as its own kind: the command line that ran, in the engine's own table",
    async () => {
      const r = rig(localVenv());
      try {
        const thesis = await storedThesis(r, "pair dips", PAIR_DSL);
        series(r, "data/nvda.csv", ohlcvCsv(300, 7));
        series(r, "data/amd.csv", ohlcvCsv(300, 99));
        // Opened after the thesis is stored, so the one entry the log holds is the measurement —
        // the rig opens no procedure of its own.
        r.openProcedure();
        await call(r.tool("run_seikan"), {
          thesis_id: thesis.id,
          data: { NVDA: "data/nvda.csv", AMD: "data/amd.csv" },
          outputs: ["trades"],
          thresholds: { min_trades: 50 },
        });

        // A SEIKAN entry, which is a kind of its own again — and the difference from an earlier
        // design, which also had a table of this name, is the whole point. What THAT table recorded
        // was a hand-built JSON summary of what the engine was ASKED: a description of a request,
        // written by the caller. What is recorded here is the line that RAN, off the same log as
        // every other command, and the table it lands in is decided by the tool that spawned the
        // engine rather than by anything the model says afterwards.
        const entry = onlySeikanRun(r);
        expect(entry.command).toContain(" run ");
        expect(entry.command).toContain("--report-out");
        expect(entry.command).toContain("--data NVDA=");
        expect(entry.command).toContain("--data AMD=");
        expect(entry.command).toContain("--trades-out");
        expect(entry.command).toContain("--min-trades 50");

        // AND THE PATHS ARE IN IT, which is the reversal worth naming out loud. The old summary
        // scrubbed every path on the argument that where a CSV sat is a fact about one machine on
        // one afternoon. A command line with its paths taken out is not the command anybody ran —
        // and the rule those scrubs were serving is about no COLUMN LOCATING anything: nothing
        // resolves this one, joins on it, or reads it back as a location (see the schema header),
        // so it is the text of what ran, which happens to contain paths the way any quoted prose
        // might.
        expect(entry.command).toContain("data/nvda.csv");

        expect(entry.outcome).toMatchObject({ ok: true, exitCode: 0 });
        // Kept VERBATIM, alone among the commands this installation records: what the engine says
        // is a document rather than a program's chatter, and a clipped one is not a smaller version
        // of it but a broken one. There is nothing to clip here — `seikan run` writes its report to
        // the file it was given and says nothing on the way — which is itself the point: '' is an
        // answer, and it is different from nobody having looked.
        expect(entry.outcome!.return).not.toContain("characters omitted");
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(!CAN_MEASURE)(
    "a feed shipped several to a file is bound by column, and the binding is in the recorded line",
    async () => {
      const r = rig(localVenv());
      try {
        const thesis = await storedThesis(r, "vol regime", FEED_DSL);
        // The recorded line is the assertion, and only a procedure records one.
        r.openProcedure();
        series(r, "data/nvda.csv", ohlcvCsv(300, 7));
        // Two series in one vendor file. Nothing in the thesis says which of them `iv30` is — that
        // is a fact about this CSV and not about the question — so the invocation says it, and a
        // run that did not would be refused rather than measured off whichever column came first.
        series(r, "data/vol_surface.csv", surfaceCsv(300, 11));

        const res = await call(r.tool("run_seikan"), {
          thesis_id: thesis.id,
          data: {
            NVDA: "data/nvda.csv",
            iv30: { path: "data/vol_surface.csv", column: "iv_30d" },
          },
        });
        expect(res.isError).toBeUndefined();
        const out = body(res);

        // The engine's own stamp of what it was handed, which is how we know the pair reached its
        // argv: it can only report a column it was given one for. The key that bound none says so
        // out loud rather than by absence, so "the file named its own column" is a readable fact
        // about the run instead of a gap in the record.
        const report = JSON.parse(readFileSync(join(r.home, out["report_path"] as string), "utf8")) as {
          identity: { data_digests: Record<string, { column: string | null }> };
        };
        expect(report.identity.data_digests["iv30"]!.column).toBe("iv_30d");
        expect(report.identity.data_digests["NVDA"]!.column).toBeNull();

        // And the run log carries the binding, because the binding is in the line: two runs reading
        // different columns of one CSV measured different series, and a reader comparing them has
        // to be able to see that. The key that bound no column contributes no `--column` at all,
        // which is the argv the engine was actually given rather than a tidied account of it.
        const entry = onlySeikanRun(r);
        expect(entry.command).toContain("--column iv30=iv_30d");
        expect(entry.command).not.toContain("--column NVDA=");
        expect(entry.outcome).toMatchObject({ ok: true, exitCode: 0 });

        // The binding is what made that run measurable, and here is the proof: the same file
        // bound by path alone is refused, because which of its two series `iv30` means is a
        // question the bytes cannot answer and the engine will not guess at.
        const unbound = await call(r.tool("run_seikan"), {
          thesis_id: thesis.id,
          data: { NVDA: "data/nvda.csv", iv30: "data/vol_surface.csv" },
        });
        expect(failure(unbound).error).toBe("data_invalid");
        expect(JSON.stringify(detail(unbound)["envelope"])).toContain("--column iv30=COL");
      } finally {
        r.cleanup();
      }
    },
  );

  test.skipIf(!CAN_MEASURE)(
    "the engine's own refusals arrive as the kinds they are, with its envelope beside them",
    async () => {
      const r = rig(localVenv());
      try {
        const thesis = await storedThesis(r, "pair dips", PAIR_DSL);
        // The log assertion at the end needs a procedure, opened after the storing so the refused
        // measurement is the log's one entry.
        r.openProcedure();
        series(r, "data/amd.csv", ohlcvCsv(300, 99));
        // A file that breaks the strict data contract in the one way a verifier must never repair:
        // a bar whose high is below its close. seikan refuses rather than clamping, because a
        // verifier does not mutate evidence.
        series(
          r,
          "data/broken.csv",
          "datetime,open,high,low,close,volume\n" +
            "2024-01-01,100,99,98,101,1000\n" +
            "2024-01-02,100,101,98,100,1000\n" +
            "2024-01-03,100,101,98,100,1000\n",
        );

        const res = await call(r.tool("run_seikan"), {
          thesis_id: thesis.id,
          data: { NVDA: "data/broken.csv", AMD: "data/amd.csv" },
        });
        const refusal = failure(res);
        // `data_invalid` rather than a generic failure, because its hint is the only one that says
        // the right thing: replace the script that produced the file, and never repair the file.
        expect(refusal.error).toBe("data_invalid");
        const envelope = detail(res)["envelope"] as { error: { type: string } };
        expect(envelope.error.type).toBe("data_invalid");
        // The engine's own complaint, whole. It names the file, the column and the line, and no
        // sentence written on this side could carry that.
        expect(JSON.stringify(envelope)).toContain("high < open/close");

        // A refused run is still a run that happened, and it is logged as one that failed — which
        // is what a published report will record rather than quietly leaving out. Still a
        // measurement, too: what the engine was asked to do is what it was, however it ended.
        const entry = onlySeikanRun(r);
        expect(entry.outcome).toMatchObject({ ok: false });
        expect(entry.outcome!.exitCode).not.toBe(0);
        // The engine's own complaint is in the recorded output, whole, because this is the one
        // command whose output is captured verbatim. A report published on this procedure would
        // carry the refusal itself rather than a note that something went wrong — which is exactly
        // what an auditor reading the history afterwards has to be able to see.
        expect(entry.outcome!.return).toContain("data_invalid");
        expect(entry.outcome!.return).toContain("high < open/close");

        // And in the error log too, under the same scope as a failing script and for the same
        // reader. The engine refusing a document IS a failure of this installation's work even when
        // it is the model's data that is wrong, and the person reading the log afterwards is the one
        // who spots that every measurement of one thesis has died the same way.
        const logged = listErrors(r.db, {}).entries;
        expect(logged).toHaveLength(1);
        expect(logged[0]!.scope).toBe("run");
        expect(logged[0]!.message).toContain("the engine refused a measurement of pair-dips");
        const detailed = JSON.parse(logged[0]!.detail!) as Record<string, unknown>;
        expect(detailed["thesis_id"]).toBe(thesis.id);
        expect(JSON.stringify(detailed["envelope"])).toContain("data_invalid");
      } finally {
        r.cleanup();
      }
    },
  );
});

describe("assess_thesis", () => {
  test("a round is the tag, the reasoning, the engine's report and what prepared the inputs", async () => {
    const r = rig();
    try {
      const scriptId = seedScript(r, "prices");
      const thesisId = seedThesis(r.db, "dip buying");
      const runId = r.runs.seed(thesisId);
      const res = await call(r.tool("assess_thesis"), {
        thesis_id: thesisId,
        tag: "approven",
        assessment: "Five of five cells clear the exam, and the mechanism holds in each of them.",
        seikan_run_id: runId,
        series_preparations: [{ script_id: scriptId, argument: "AAPL --daily" }],
      });
      expect(res.isError).toBeUndefined();
      expect(summary(res)).toBe("Filed approven.");

      const assessment = body(res)["assessment"] as { id: string; tag: string; seikan_report: string };
      expect(assessment.tag).toBe("approven");
      // The engine's own output, stored as written — and REDEEMED rather than retyped. The bytes
      // came out of the run the id named, so what is filed beside a judgement cannot be a copy that
      // went through a summary on the way. It is what makes "we called this approven in March"
      // checkable years later against the numbers rather than against the memory of them.
      expect(assessment.seikan_report).toBe(SEIKAN_REPORT);
      // The preparation records the PAIR that would produce the input again — the program and what
      // it was told — rather than where the CSV happened to sit while the engine read it.
      expect(body(res)["preparations"]).toEqual([
        {
          id: expect.any(String),
          name: expect.any(String),
          thesis_assessment_id: assessment.id,
          script_id: scriptId,
          argument: "AAPL --daily",
          created_at: expect.any(Number),
        },
      ]);

      // And an assessment is a judgement made at a moment: there is no re-wording it afterwards,
      // by this surface or by anything else.
      expect(() =>
        r.db
          .query("UPDATE thesis_assessment SET assessment = 'actually no' WHERE id = ?")
          .run(assessment.id),
      ).toThrow(/never edited/);
    } finally {
      r.cleanup();
    }
  });

  test("a second round appends: the ledger is the history, and the newest row is the answer", async () => {
    const r = rig();
    try {
      const thesisId = seedThesis(r.db, "dip buying");
      const march = await assess(r, thesisId, { tag: "approven" });
      const june = await assess(r, thesisId, {
        tag: "insightful",
        assessment: "The 2025 cells came in thin; solid is no longer the right word for it.",
      });
      expect(june).not.toBe(march);

      const out = body(await call(r.tool("get_thesis"), { thesis_id: thesisId }));
      const ledger = out["assessments"] as Array<{ id: string; tag: string }>;
      // Oldest first, because that is the order it reads as a history — and re-reading a thesis in
      // June does not erase what was thought of it in March, which is what a ledger buys over a
      // single `current_tag` column.
      expect(ledger.map((row) => row.id)).toEqual([march, june]);
      expect(ledger.map((row) => row.tag)).toEqual(["approven", "insightful"]);
      expect(out["latest_assessment_id"]).toBe(june);
      expect((out["thesis"] as { latest_tag: string }).latest_tag).toBe("insightful");
      expect(summary(await call(r.tool("get_thesis"), { thesis_id: thesisId }))).toContain(
        "insightful",
      );
    } finally {
      r.cleanup();
    }
  });

  test("get_thesis carries only the NEWEST round's preparations, because that is the one on offer", async () => {
    const r = rig();
    try {
      const first = seedScript(r, "prices");
      const second = seedScript(r, "prices v2");
      const thesisId = seedThesis(r.db, "dip buying");
      await assess(r, thesisId, { series_preparations: [{ script_id: first, argument: "old" }] });
      const june = await assess(r, thesisId, {
        assessment: "Re-measured on the corrected series, and it reads the same way.",
        series_preparations: [{ script_id: second, argument: "new" }],
      });

      const out = body(await call(r.tool("get_thesis"), { thesis_id: thesisId }));
      // The newest round is the one a report may apply and the one the next reading has to better,
      // so its inputs are the ones worth carrying here. Every other round's are on the assessment
      // they were filed with, in the record browser.
      expect(out["latest_assessment_id"]).toBe(june);
      expect(
        (out["latest_preparations"] as Array<{ script_id: string; argument: string }>).map(
          (p) => [p.script_id, p.argument],
        ),
      ).toEqual([[second, "new"]]);
      expect(r.db.query("SELECT COUNT(*) AS n FROM series_preparation").get()).toEqual({ n: 2 });
    } finally {
      r.cleanup();
    }
  });

  test("a preparation naming a script nothing recorded takes the whole round with it", async () => {
    const r = rig();
    try {
      const real = seedScript(r, "prices");
      const thesisId = seedThesis(r.db, "dip buying");
      const res = await call(r.tool("assess_thesis"), {
        thesis_id: thesisId,
        tag: "insightful",
        assessment: "Two of five cells clear the exam; the rest are thin, so it is not solid yet.",
        seikan_run_id: r.runs.seed(thesisId),
        // The real one first, so the bad one is reached with a good one already behind it — which is
        // where a surface that resolved and wrote as it went would leave half a round on the floor.
        series_preparations: [
          { script_id: real, argument: "AAPL" },
          { script_id: "no-such-script", argument: "MSFT" },
        ],
      });
      const refusal = failure(res);
      expect(refusal.error).toBe("not_found");
      expect(refusal.message).toContain("give either its id or its name");
      // A round and its evidence are one act: an assessment that landed without the declarations of
      // what prepared its inputs would be an opinion the database presents as a measurement. Every
      // reference is resolved before the write begins, so this one is refused with the transaction
      // not yet open — and the assertion is the same either way, which is the point of making it
      // about the rows rather than about where the refusal came from.
      expect(r.db.query("SELECT COUNT(*) AS n FROM thesis_assessment").get()).toEqual({ n: 0 });
      expect(r.db.query("SELECT COUNT(*) AS n FROM series_preparation").get()).toEqual({ n: 0 });
    } finally {
      r.cleanup();
    }
  });

  test("a tag with no reasoning under it is refused, and two words is not reasoning", async () => {
    const r = rig();
    try {
      const thesisId = seedThesis(r.db, "dip buying");
      const noReasoning = await call(r.tool("assess_thesis"), {
        thesis_id: thesisId,
        tag: "approven",
        assessment: "   ",
        seikan_run_id: r.runs.seed(thesisId),
      });
      expect(failure(noReasoning).error).toBe("invalid_request");
      // The tag says what was decided; the assessment is the only record of why.
      expect(failure(noReasoning).message).toContain("the only record of why");
      expect(r.db.query("SELECT COUNT(*) AS n FROM thesis_assessment").get()).toEqual({ n: 0 });

      // Two words satisfy every constraint the database has and tell a future reader nothing, so
      // the length floor is this surface's rule and lives in the schema the model is shown.
      const schema = schemaOf(definitions(r.deps).find((d) => d.name === "assess_thesis")!);
      expect(
        schema.safeParse({
          thesis_id: thesisId,
          tag: "approven",
          assessment: "it held",
          seikan_run_id: "retained-1",
        }).success,
      ).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  test("the engine's report is redeemed rather than retyped: no argument carries it", () => {
    const r = rig();
    try {
      // `seikan_report` as a string the model pastes in would make the one column that exists to be
      // checkable years later the one thing a summary could reach on the way past. A run id cannot
      // be summarised. The argument is not reshaped, it is simply not here, so a call spelling it is
      // refused by name rather than filing a report nobody measured.
      const schema = schemaOf(definitions(r.deps).find((d) => d.name === "assess_thesis")!);
      expect(Object.keys(schema.shape).sort()).toEqual([
        "assessment",
        "seikan_run_id",
        "series_preparations",
        "tag",
        "thesis_id",
      ]);

      const pasted = schema.safeParse({
        thesis_id: "t1",
        tag: "approven",
        assessment: "Five of five cells clear the exam, and the mechanism holds in each of them.",
        seikan_report: SEIKAN_REPORT,
      });
      expect(pasted.success).toBe(false);
      expect(pasted.error!.issues.map((issue) => issue.code)).toContain("unrecognized_keys");
    } finally {
      r.cleanup();
    }
  });

  test("a run id nothing is holding is refused, and says a run is redeemable once", async () => {
    const r = rig();
    try {
      const thesisId = seedThesis(r.db, "dip buying");
      const res = await call(r.tool("assess_thesis"), {
        thesis_id: thesisId,
        tag: "approven",
        assessment: "Five of five cells clear the exam, and the mechanism holds in each of them.",
        seikan_run_id: "no-such-run",
      });
      const refusal = failure(res);
      expect(refusal.error).toBe("not_found");
      // The two ways an id stops naming anything are both named, because they need the same answer
      // and neither is visible from here: it was already filed, or the server restarted under it.
      // The remedy is to measure again, which is cheap — inventing a report is not.
      expect(refusal.message).toContain("redeemable once");
      expect(refusal.message).toContain("measure again");
      expect(r.db.query("SELECT COUNT(*) AS n FROM thesis_assessment").get()).toEqual({ n: 0 });
    } finally {
      r.cleanup();
    }
  });

  test("a run of an unstored document is refused, and the refusal names create_thesis", async () => {
    const r = rig();
    try {
      // A document-mode run carries no thesis id, so the equality check below it could never say
      // this — null equals no id — and the sentence has to be its own: that measurement belongs to
      // the call that files a FIRST reading, not to this ledger of stored theses.
      const thesisId = seedThesis(r.db, "dip buying");
      const res = await call(r.tool("assess_thesis"), {
        thesis_id: thesisId,
        tag: "approven",
        assessment: "Five of five cells clear the exam, and the mechanism holds in each of them.",
        seikan_run_id: r.runs.seed(null),
      });
      const refusal = failure(res);
      expect(refusal.error).toBe("invalid_request");
      expect(refusal.message).toContain("create_thesis");
      expect(r.db.query("SELECT COUNT(*) AS n FROM thesis_assessment").get()).toEqual({ n: 0 });
    } finally {
      r.cleanup();
    }
  });

  test("a run is spent when it is filed, so the same id cannot be filed against twice", async () => {
    const r = rig();
    try {
      const thesisId = seedThesis(r.db, "dip buying");
      const runId = r.runs.seed(thesisId);
      const filed = await call(r.tool("assess_thesis"), {
        thesis_id: thesisId,
        tag: "insightful",
        assessment: "Three of five cells fire, and the mechanism holds where they do.",
        seikan_run_id: runId,
      });
      expect(filed.isError).toBeUndefined();

      // One measurement is one round. Filing the same run again would put one afternoon's numbers
      // under two readings, and a ledger whose rows are answers to each other would then be
      // answering itself — so the id is gone the moment it is used, and a second reading of the
      // same thesis means measuring it again.
      const again = await call(r.tool("assess_thesis"), {
        thesis_id: thesisId,
        tag: "approven",
        assessment: "Reading the same numbers again, more generously this time, for the record.",
        seikan_run_id: runId,
      });
      expect(failure(again).error).toBe("not_found");
      expect(r.db.query("SELECT COUNT(*) AS n FROM thesis_assessment").get()).toEqual({ n: 1 });
    } finally {
      r.cleanup();
    }
  });

  test("a run of another thesis is refused: a reading is filed against the document it was read off", async () => {
    const r = rig();
    try {
      const dips = seedThesis(r.db, "dip buying");
      const gaps = seedThesis(r.db, "gap fills");
      const res = await call(r.tool("assess_thesis"), {
        thesis_id: gaps,
        tag: "approven",
        assessment: "Five of five cells clear the exam, and the mechanism holds in each of them.",
        // A perfectly real run, of the wrong document. Nothing about the report itself would give
        // this away later: it is a JSON blob in a column, and filed here it would be a measurement
        // of one thesis standing as evidence for another forever.
        seikan_run_id: r.runs.seed(dips),
      });
      const refusal = failure(res);
      expect(refusal.error).toBe("invalid_request");
      expect(refusal.message).toContain("measured a different thesis");
      expect(r.db.query("SELECT COUNT(*) AS n FROM thesis_assessment").get()).toEqual({ n: 0 });
    } finally {
      r.cleanup();
    }
  });

  test("abandoned is the last row a ledger can take, and nothing may be filed after it", async () => {
    const r = rig();
    try {
      const thesisId = seedThesis(r.db, "dip buying");
      await assess(r, thesisId);
      const retired = await call(r.tool("assess_thesis"), {
        thesis_id: thesisId,
        tag: "abandoned",
        assessment: "Superseded by a document that measures NVDA alone rather than the pair.",
        seikan_run_id: r.runs.seed(thesisId),
      });
      expect(retired.isError).toBeUndefined();

      // Not even a better-worded abandonment. In a ledger the last row is the answer, so appending
      // to a closed one is exactly the revival the rule forbids: runs recorded before and after an
      // abandonment would end up under one identity, as if the measurement had never ended.
      const again = await call(r.tool("assess_thesis"), {
        thesis_id: thesisId,
        tag: "abandoned",
        assessment: "Saying the same thing again, more carefully this time, for the record.",
        seikan_run_id: r.runs.seed(thesisId),
      });
      const refusal = failure(again);
      expect(refusal.error).toBe("conflict");
      // The way forward is not obvious from a constraint failure, so the refusal says it: the
      // replacement is a NEW thesis, and abandoning this one already freed the name for it.
      expect(refusal.message).toContain("Store the replacement as a new thesis");

      // And the trigger is what makes it true of the database rather than of this surface.
      expect(() =>
        r.db
          .query(
            `INSERT INTO thesis_assessment (name, id, thesis_id, tag, assessment, seikan_report, created_at)
             VALUES ('asm-' || lower(hex(randomblob(5))), 'revived', ?, 'approven', 'it is back', '{}', 9999)`,
          )
          .run(thesisId),
      ).toThrow(/never revived/);

      // Abandoning frees the NAME, which is what makes storing the replacement possible at all.
      expect(seedThesis(r.db, "dip buying", "The single-name version.")).toBeTruthy();
      expect(r.db.query("SELECT COUNT(*) AS n FROM thesis").get()).toEqual({ n: 2 });
    } finally {
      r.cleanup();
    }
  });

  test("an unassessed container is a state to browse for, beside the three tags", async () => {
    const r = rig();
    try {
      const judged = seedThesis(r.db, "dip buying");
      const untouched = seedThesis(r.db, "gap fills");
      seedAssessment(r.db, judged, "approven");

      const unassessed = body(await call(r.tool("list_theses"), { tag: "unassessed" }))
        ["theses"] as Array<{ id: string; latest_tag: string | null }>;
      // An empty ledger is a real answer to "how does this thesis stand", so it is a filter value
      // rather than something a caller has to notice by the absence of a tag.
      expect(unassessed.map((t) => t.id)).toEqual([untouched]);
      expect(unassessed[0]!.latest_tag).toBeNull();

      const approven = body(await call(r.tool("list_theses"), { tag: "approven" }))
        ["theses"] as Array<{ id: string }>;
      expect(approven.map((t) => t.id)).toEqual([judged]);
    } finally {
      r.cleanup();
    }
  });
});

describe("targets", () => {
  test("recording one accumulates metadata and reads back with what measures it", async () => {
    const r = rig();
    try {
      await call(r.tool("upsert_target"), {
        ticker: "nvda",
        name: "NVIDIA Corporation",
        market: "US",
      });
      // A later call knowing only the ticker must not erase the name somebody looked up — and it
      // must not have to repeat it either, which is what "accumulates" means: unit arrives now and
      // the name is left where it is.
      await call(r.tool("upsert_target"), { ticker: "NVDA", unit: "dollar" });

      const out = body(await call(r.tool("get_target"), { ticker: "nvda" }));
      expect(out["target"]).toMatchObject({
        ticker: "NVDA",
        name: "NVIDIA Corporation",
        market: "US",
        unit: "dollar",
      });
      // Theses are the only thing that measures an instrument, and therefore the only thing a
      // target is read back with.
      expect(out["theses"]).toEqual([]);

      const listed = body(await call(r.tool("list_targets")))["targets"] as Array<{
        ticker: string;
        thesis_count: number;
      }>;
      expect(listed).toEqual([expect.objectContaining({ ticker: "NVDA", thesis_count: 0 })]);
      // The whole row, not a sample of it. One count rides along, and it is of things that MEASURE
      // the instrument — a browse that carried a second number nothing measures would read as work
      // somebody had done. SIX COLUMNS AND NOT SEVEN: a target used to carry a minted name beside
      // the official one, and the official one is now the row's `name`. Two names for a row whose
      // identity is its ticker was one more than anything ever read.
      expect(Object.keys(listed[0]!).sort()).toEqual([
        "added_at",
        "market",
        "name",
        "thesis_count",
        "ticker",
        "unit",
      ]);
    } finally {
      r.cleanup();
    }
  });

  test("a ticker that is not a ticker is refused rather than filed", async () => {
    const r = rig();
    try {
      const res = await call(r.tool("upsert_target"), {
        ticker: "the one with the chips",
        name: "NVIDIA Corporation",
      });
      expect(failure(res).error).toBe("invalid_request");
      expect(r.db.query("SELECT COUNT(*) AS n FROM target").get()).toEqual({ n: 0 });
    } finally {
      r.cleanup();
    }
  });

  test("a new instrument must be named, and the name it was given never moves", async () => {
    // THE ONE EXEMPTION IN THIS DATABASE'S NAMING RULE, from the tool surface. Every other record's
    // name is a summary somebody composed, minted from a hint and reworded afterwards; a target's is
    // the instrument's OFFICIAL name, which is a fact about the world rather than a label. So it
    // cannot be minted from the ticker — nothing here knows what NVDA is called — it is required
    // the first time, and a later call contradicting it is refused rather than quietly winning or
    // quietly losing.
    const r = rig();
    try {
      const unnamed = await call(r.tool("upsert_target"), { ticker: "NVDA" });
      expect(failure(unnamed).error).toBe("invalid_request");
      expect(failure(unnamed).message).toContain("official name");
      expect(r.db.query("SELECT COUNT(*) AS n FROM target").get()).toEqual({ n: 0 });

      await call(r.tool("upsert_target"), { ticker: "NVDA", name: "NVIDIA Corporation" });
      // Repeating it is fine — a caller that knows the name should not have to remember whether it
      // has said it before.
      const again = await call(r.tool("upsert_target"), {
        ticker: "NVDA",
        name: "NVIDIA Corporation",
        market: "US",
      });
      expect(again.isError).toBeUndefined();

      const wrong = await call(r.tool("upsert_target"), { ticker: "NVDA", name: "Nvidia Corp" });
      expect(failure(wrong).error).toBe("conflict");
      // The remedy is in the sentence, because it is not the obvious one: nothing renames a target,
      // so a wrong name is corrected by deleting the row and recording it again.
      expect(failure(wrong).message).toContain("delete the target and record it again");
      expect(r.db.query<{ name: string }, []>("SELECT name FROM target").get()).toEqual({
        name: "NVIDIA Corporation",
      });
    } finally {
      r.cleanup();
    }
  });

  test("an instrument nothing measures is removed once confirmed", async () => {
    const r = rig();
    try {
      await call(r.tool("upsert_target"), { ticker: "AAPL", name: "Apple Inc." });
      const res = await call(r.tool("delete_target"), { ticker: "AAPL", confirm: true });
      expect(res.isError).toBeUndefined();
      expect(r.db.query("SELECT COUNT(*) AS n FROM target").get()).toEqual({ n: 0 });
    } finally {
      r.cleanup();
    }
  });
});

/**
 * WHAT A PUBLISHED REPORT STILL HOLDS DOWN — WHICH IS NOW ONE THING.
 *
 * A report used to pin three: the readings it said it applied, the sources it said it had quoted,
 * and the scripts its numbers came out of. Two of those were the model's own account of its work.
 * Nothing fetched a cited page or compared a quoted sentence against one, so what those tables
 * recorded was that the account was internally consistent — and a deletion guard resting on that is
 * a guard protecting a claim rather than a fact. Both tables are gone, and the guards went with
 * them: the tests below say so out loud, because "you may now delete this" is exactly the kind of
 * change nobody notices until it is a surprise.
 *
 * What survives is what a machine watched happen. The procedure RAN a stored program, that run is a
 * row of `script_invocation`, and the row names the script — so a published report goes on holding
 * the program that produced its numbers, and always did.
 */
describe("what a published report holds down", () => {
  /**
   * Publish one report, and hand back the ids around it.
   *
   * The report records running the script, off the log, the way a real procedure does — that is the
   * one tie left between a published document and anything else in the archive. The thesis and the
   * source are seeded beside it precisely so the tests below can show that the report does NOT hold
   * either of them, and the assessment declares the same script as what prepared its inputs, which
   * is the second, quite separate hold on a program.
   */
  async function published(r: Rig) {
    const thesisId = seedThesis(r.db, "dip buying");
    const sourceId = seedSource(r.db);
    const scriptId = seedScript(r, "prices");
    const assessmentId = await assess(r, thesisId, {
      series_preparations: [{ script_id: scriptId, argument: "--full" }],
    });
    ran(
      r.runs,
      { kind: "script", scriptId, argument: "--full" },
      1_700_000_000_000,
      { exitCode: 0, return: "wrote 1,258 rows\n", durationMs: 1_100 },
    );
    const out = body(
      await call(r.tool("publish_report"), {
        draft_path: draft(r, "a.html", "<p>Revenue was $3.1bn.</p>"),
        title: "Standing on what ran",
      }),
    );
    return { thesisId, assessmentId, sourceId, scriptId, reportId: out["report_id"] as string };
  }

  test("a thesis is deletable while a report stands, because no report points at one any more", async () => {
    const r = generating();
    try {
      // THE PIN IS ON AN ABSENCE, and the absence is new. A report used to name the exact readings
      // its argument stood on, and a thesis under one of those readings could not be deleted. That
      // table was the model's word about its own argument; it is gone, and so is the block. What a
      // published document says about this thesis is IN the document, which is immutable — so
      // deleting the thesis cannot change what any report claims, only what the archive can still
      // show a reader about it. The deletion log keeps the row.
      const { thesisId, reportId } = await published(r);
      const res = await call(r.tool("delete_thesis"), { thesis_id: thesisId, confirm: true });
      expect(res.isError).toBeUndefined();
      expect(r.db.query("SELECT COUNT(*) AS n FROM thesis").get()).toEqual({ n: 0 });
      // The report is untouched by it, document and all, which is the half that makes this safe.
      expect(getReportContent(r.db, reportId)).toContain("Revenue was $3.1bn.");
      // And the witness is the deletion log, which is now the only account of what left.
      expect(
        r.db
          .query<{ table_name: string }, []>("SELECT table_name FROM deletion_log")
          .all(),
      ).toEqual([{ table_name: "thesis" }]);
    } finally {
      r.cleanup();
    }
  });

  test("a source is deletable too, through the tool, whatever has been published near it", async () => {
    const r = generating();
    try {
      // The same removal, for the same reason: a report used to name the addresses it said it had
      // read and the source publishing at each, nothing ever checked one, and that table is gone.
      // What changed is only who asks — the address book used to be reached by the user's own
      // Delete button and is reached from here now — and the rule is about what the DATABASE
      // permits rather than about which caller asked, which is exactly why the same call is made
      // here with a report standing beside the row.
      const { sourceId, reportId } = await published(r);
      const res = await call(r.tool("delete_information_source"), {
        source_id: sourceId,
        confirm: true,
      });
      expect(res.isError).toBeUndefined();
      expect(r.db.query("SELECT COUNT(*) AS n FROM information_source").get()).toEqual({ n: 0 });
      // The published document is untouched by it, which is the half that makes this safe: a
      // publication is its bytes, and those said what they said about wherever they came from.
      expect(getReportContent(r.db, reportId)).toContain("Revenue was $3.1bn.");
      // TWO witnesses now, one per act: the reading of the thesis this fixture also files is its
      // own affair, and what matters here is that the source's whole row is in the log, because
      // after this there is no other account of what the address book used to say.
      const logged = r.db
        .query<{ table_name: string; row_json: string }, []>(
          "SELECT table_name, row_json FROM deletion_log",
        )
        .all();
      expect(logged.map((row) => row.table_name)).toEqual(["information_source"]);
      expect(JSON.parse(logged[0]!.row_json)["source"]).toBe("Apple IR");
    } finally {
      r.cleanup();
    }
  });

  test("delete_script is refused while a published report records running it, and says how many", async () => {
    const r = generating();
    try {
      // THE ONE HOLD LEFT, and the one that was never anybody's word: this report's row says this
      // program ran, because the machine watched it run. Deleting the script would cascade the
      // invocation away and leave a published document whose numbers have nothing to say what
      // produced them.
      const { scriptId, reportId } = await published(r);
      const refusal = failure(
        await call(r.tool("delete_script"), { script_id: scriptId, confirm: true }),
      );
      expect(refusal.error).toBe("conflict");
      expect(refusal.message).toContain("1 published report(s) record running this script");
      // And it offers what the caller almost certainly wanted: setting it inactive retires the
      // program and leaves every record standing, which is the difference between a script going
      // out of service and a report losing its account of itself.
      expect(refusal.message).toContain("set the script inactive instead");
      expect(
        (await call(r.tool("set_script_status"), { script_id: scriptId, status: "inactive" }))
          .isError,
      ).toBeUndefined();
      expect(r.db.query("SELECT COUNT(*) AS n FROM script").get()).toEqual({ n: 1 });

      // The schema is where that rule actually lives, so it holds against hand-written SQL too: the
      // cascade fires the leave-only-with-your-report trigger, which finds the report still there.
      expect(() => r.db.query("DELETE FROM script WHERE id = ?").run(scriptId)).toThrow(
        /publication record/,
      );
      expect(getReportContent(r.db, reportId)).not.toBeNull();
    } finally {
      r.cleanup();
    }
  });

  test("with the report gone the script is held only by the assessment that says it prepared the inputs", async () => {
    const r = generating();
    try {
      const { thesisId, scriptId, reportId } = await published(r);
      const removed = body(
        await call(r.tool("delete_report"), { report_id: reportId, confirm: true }),
      );
      // The payload counts the two run tables and nothing else, because they are the whole of what
      // a report now takes with it.
      expect(removed["deleted"]).toBe(true);
      expect(removed["script_invocations_removed"]).toBe(1);
      // An honest zero: this procedure ran no bare command, so the report recorded none.
      expect(removed["shell_commands_removed"]).toBe(0);
      expect(r.db.query("SELECT COUNT(*) AS n FROM script_invocation").get()).toEqual({ n: 0 });

      // Still held, and now by the ASSESSMENT rather than by the report that has gone — so the
      // order is not arbitrary. The preparation rows would simply cascade away, and the loss would
      // land not on the script but on the round, left claiming a measurement with nothing to say
      // what produced the series it was read over.
      const refusal = failure(
        await call(r.tool("delete_script"), { script_id: scriptId, confirm: true }),
      );
      expect(refusal.error).toBe("conflict");
      expect(refusal.message).toContain("1 recorded preparation(s) name this script");
      expect(refusal.message).toContain("Set the script inactive instead");

      // The thesis takes its ledger and every preparation on it, and only then is the program free.
      expect(
        (await call(r.tool("delete_thesis"), { thesis_id: thesisId, confirm: true })).isError,
      ).toBeUndefined();
      expect(r.db.query("SELECT COUNT(*) AS n FROM series_preparation").get()).toEqual({ n: 0 });
      expect(
        (await call(r.tool("delete_script"), { script_id: scriptId, confirm: true })).isError,
      ).toBeUndefined();
    } finally {
      r.cleanup();
    }
  });

  test("get_thesis no longer names the reports standing on it, because none of them names it", async () => {
    const r = rig();
    try {
      const { thesisId } = await published(r);
      const out = body(await call(r.tool("get_thesis"), { thesis_id: thesisId }));
      // THE PIN IS ON AN ABSENT KEY. The list used to be real and useful — every report applying a
      // reading of this thesis, unscoped, and the count the delete refusal agreed with. It was
      // reading the table that held the model's account of its own argument, and with that table
      // gone there is no honest way to answer the question at all: what a document says about a
      // thesis is prose in the document. A key here answering it from something else would be a
      // worse answer than none.
      expect(Object.keys(out)).not.toContain("reports");
      expect(Object.keys(out).sort()).toEqual([
        "assessments",
        "latest_assessment_id",
        "latest_preparations",
        "thesis",
      ]);
    } finally {
      r.cleanup();
    }
  });
});

describe("the address book, which the agent records and the user agrees to", () => {
  /** A complete entry, so a test about one field is about that field. */
  const ENTRY = {
    source: "Apple IR",
    type: "issuer_primary",
    domain: "filings and transcripts",
    method: "Browse the investor relations site; the quarterly deck is under Financials.",
    hosts: ["Investor.Apple.COM"],
  };

  test("recording one writes the row, normalised, and the reads find it afterwards", async () => {
    const r = rig();
    try {
      // THE PIN INVERTED. This suite used to open on an absence — no write tool at all — because
      // the address book is the standing account of where this installation's numbers come from and
      // every report ever published leans on it, so it was written from the user's own form. The
      // form is gone and the row is written from here, on the condition stated on the tool: the
      // whole row is laid out in the conversation first and the user says afterwards that it is
      // what they want. What did NOT change is where the rules live — the hostname normalisation,
      // the type vocabulary, the credential-by-name rule are all in `repo/sources.ts`, one layer
      // below anything that calls it, so the model and a script reaching the same function are held
      // to the same account.
      expect(r.has("create_information_source")).toBe(true);

      const res = await call(r.tool("create_information_source"), ENTRY);
      expect(res.isError).toBeUndefined();
      const stored = body(res)["source"] as { id: string; hosts: string[]; name: string };
      // THE STORED ROW RATHER THAN THE ARGUMENTS, and the hostname is the reason: it is lowercased
      // on the way in the way `new URL(...).hostname` would give it, so a reader is never left
      // deciding whether `Investor.Apple.COM` and `investor.apple.com` are two places.
      expect(stored.hosts).toEqual(["investor.apple.com"]);
      expect(summary(res)).toContain(stored.name);

      // And the reading is what the agent needs most of all: finding out whether a place is already
      // recorded, before the rule that matters — use nothing from a place that is not recorded —
      // can be obeyed at all.
      const listed = body(await call(r.tool("list_information_sources"), {}))["sources"] as Array<{
        id: string;
        hosts: string[];
      }>;
      expect(listed.map((row) => row.id)).toEqual([stored.id]);
      // Parsed, not the JSON text the column holds: a caller that had to remember to parse a field
      // is one that will eventually compare a string to an array.
      expect(listed[0]!.hosts).toEqual(["investor.apple.com"]);

      const found = body(await call(r.tool("search_sources"), { q: "apple" }))["sources"] as Array<{
        source: string;
      }>;
      expect(found.map((row) => row.source)).toEqual(["Apple IR"]);
    } finally {
      r.cleanup();
    }
  });

  test("the repository's validators refuse through the tool, in their own sentences", async () => {
    const r = rig();
    try {
      // Every one of these is a rule the tool does not re-implement: `attempt` converts what
      // `repo/sources.ts` throws into a result the model can act on, so a misfiled row is refused
      // with the sentence that says what to do rather than with a constraint error.
      const badType = failure(
        await call(r.tool("create_information_source"), { ...ENTRY, type: "a blog" }),
      );
      expect(badType.error).toBe("invalid_request");
      // The whole vocabulary in the message, because "unknown type" leaves a model guessing at a
      // list it was never shown.
      expect(badType.message).toContain("issuer_primary");

      // A url where a hostname belongs is the mistake this field attracts most, and it is refused
      // rather than parsed down to its host: silently truncating `example.com/filings` to
      // `example.com` would store a claim about a place the writer never made.
      const asUrl = failure(
        await call(r.tool("create_information_source"), {
          ...ENTRY,
          hosts: ["https://investor.apple.com/filings"],
        }),
      );
      expect(asUrl.error).toBe("invalid_request");
      expect(asUrl.message).toContain("not a bare hostname");
      // And none at all: a source nobody can name an address for is one nobody can go and look at.
      expect(
        failure(await call(r.tool("create_information_source"), { ...ENTRY, hosts: [] })).message,
      ).toContain("at least one host");

      // THE ONE THAT IS ABOUT THIS INSTALLATION RATHER THAN ABOUT HOSTNAMES. `SEIKAN_*` is scrubbed
      // from the environment before anything runs, so a credential recorded under such a name is one
      // guaranteed to be missing at the moment it is wanted — and the failure would surface as a
      // fetch quietly returning nothing.
      const scrubbed = failure(
        await call(r.tool("create_information_source"), { ...ENTRY, auth_env: "SEIKAN_API_KEY" }),
      );
      expect(scrubbed.error).toBe("invalid_request");
      expect(scrubbed.message).toContain("cannot hold a credential");

      // A DUPLICATE IS A CONFLICT, which is the refusal the tool's own description tells the model
      // to browse first to avoid: the same site filed twice under two spellings is two half-records
      // of one place, and nothing downstream would ever say which was meant.
      expect(
        (await call(r.tool("create_information_source"), ENTRY)).isError,
      ).toBeUndefined();
      const twice = failure(await call(r.tool("create_information_source"), ENTRY));
      expect(twice.error).toBe("conflict");
      expect(twice.message).toContain("already exists");

      expect(r.db.query("SELECT COUNT(*) AS n FROM information_source").get()).toEqual({ n: 1 });
    } finally {
      r.cleanup();
    }
  });

  test("an update corrects the fields it names and leaves out what it leaves out", async () => {
    const r = rig();
    try {
      const id = (body(await call(r.tool("create_information_source"), ENTRY))["source"] as {
        id: string;
      }).id;

      const patched = body(
        await call(r.tool("update_information_source"), {
          source_id: id,
          domain: "filings, transcripts and the 8-Ks",
          // THE FIELD THAT CARRIES THE MOST WEIGHT, and it is editable rather than frozen: the type
          // is how far the source sits from the fact, so re-grading a standing row silently
          // re-weighs every report that drew on it. Freezing it would only mean deleting a row and
          // dictating six fields again to correct a misfiling; what keeps the change honest is that
          // the user has to ask for it and the tool has to say back what it is about to do.
          type: "regulatory_government",
          failure_cases: "2026-01-02: served a stale page for two days",
        }),
      )["source"] as Record<string, unknown>;
      expect(patched["domain"]).toBe("filings, transcripts and the 8-Ks");
      expect(patched["type"]).toBe("regulatory_government");
      expect(patched["failure_cases"]).toBe("2026-01-02: served a stale page for two days");

      // AN ABSENT KEY MEANS LEAVE ALONE, and it is a property of how the handler assembles the
      // patch rather than of the repository beneath it: the object is built key by key, so a field
      // nobody named is not the same as a field set to undefined. Zod would happily hand over the
      // second, and a patch that read one as "clear it" would empty the method every time somebody
      // corrected a domain.
      expect(patched["source"]).toBe("Apple IR");
      expect(patched["method"]).toBe(ENTRY.method);
      expect(patched["hosts"]).toEqual(["investor.apple.com"]);

      // `hosts` REPLACES rather than accumulates when it IS named, which is the opposite habit from
      // `failure_cases` and deliberately so: a company that moved its filings needs the old address
      // gone, while a failure that happened stays true for ever.
      const moved = body(
        await call(r.tool("update_information_source"), {
          source_id: id,
          hosts: ["apple.com"],
        }),
      )["source"] as Record<string, unknown>;
      expect(moved["hosts"]).toEqual(["apple.com"]);
      expect(moved["failure_cases"]).toBe("2026-01-02: served a stale page for two days");

      // Blank clears the two fields that can be empty — the only way to say a source needs no
      // credential after all — while the validators still apply to everything named.
      const cleared = body(
        await call(r.tool("update_information_source"), { source_id: id, failure_cases: "" }),
      )["source"] as Record<string, unknown>;
      expect(cleared["failure_cases"]).toBeNull();

      const missing = failure(
        await call(r.tool("update_information_source"), { source_id: newId(), domain: "x" }),
      );
      expect(missing.error).toBe("not_found");
    } finally {
      r.cleanup();
    }
  });

  test("deleting one is confirmed, witnessed, and nothing in the archive stands in its way", async () => {
    const r = rig();
    try {
      const id = seedSource(r.db, "Apple IR", ["investor.apple.com"]);

      // `confirm` is checked in the HANDLER as well as required by the schema, because "required"
      // only means the field is present: `confirm: false` satisfies a boolean and means the
      // opposite of what the tool is about to do.
      const unconfirmed = failure(
        await call(r.tool("delete_information_source"), { source_id: id, confirm: false }),
      );
      expect(unconfirmed.error).toBe("invalid_request");
      expect(unconfirmed.message).toContain("needs confirm: true");
      expect(getSource(r.db, id)).not.toBeNull();

      const res = await call(r.tool("delete_information_source"), { source_id: id, confirm: true });
      expect(res.isError).toBeUndefined();
      // Named in the summary, read before the row went: afterwards there is nothing to ask, and a
      // result saying only "deleted" would leave the transcript unable to say what left.
      expect(summary(res)).toContain("Apple IR");
      expect(getSource(r.db, id)).toBeNull();

      // AND THE DELETION LOG IS THE ONLY WITNESS THERE WILL EVER BE, which is exactly why the tool
      // says to ask first. Nothing in the archive points at a source — no report names one — so
      // this always succeeds, and the whole vanished row is the only account of what the address
      // book used to say.
      const logged = r.db
        .query<{ table_name: string; row_json: string }, []>(
          "SELECT table_name, row_json FROM deletion_log",
        )
        .all();
      expect(logged).toHaveLength(1);
      expect(logged[0]!.table_name).toBe("information_source");
      expect(JSON.parse(logged[0]!.row_json)["source"]).toBe("Apple IR");

      expect(
        failure(await call(r.tool("delete_information_source"), { source_id: id, confirm: true }))
          .error,
      ).toBe("not_found");
    } finally {
      r.cleanup();
    }
  });
});

/**
 * NAMING A ROW — the one act on this surface that belongs to no table.
 *
 * It had a neighbour once. `delete_playbook_version` removed one version of a workshop's
 * instructions, and it existed only because instructions were an append-only ledger: a version
 * recorded by mistake had to be removable without taking the lineage, and one some report was
 * written under had to be refused. A recipe is one immutable row with a status, so a specification
 * stored by mistake is deleted by `delete_recipe` like any other record and a superseded one is set
 * inactive rather than removed at all. Both the tool and the tests for it went with the ledger; what
 * replaced them is in the recipe suites, and the name that no longer answers is pinned as absent in
 * the roster suite at the top of this file.
 */
describe("the one act that belongs to no one table", () => {
  test("rename_record changes what a row is called, by id or by the name it answers to now", async () => {
    const r = rig();
    try {
      // A RENAME USED TO BE THE WINDOW'S ONE WRITE, on the argument that a name asserts nothing
      // about the world so a form could not implement a rule wrongly. That argument still holds and
      // the door moved anyway: this window writes nothing, so a rename is asked for like everything
      // else. What the tool must not become is a tidying pass — the doctrine is on the description
      // and pinned above; what is testable here is that it renames exactly the row it was given.
      const recipe = seedRecipe(r.db, "Badly named");
      const res = await call(r.tool("rename_record"), {
        table: "recipe",
        record: recipe,
        name: "  semis-quarterly  ",
      });
      expect(res.isError).toBeUndefined();
      // Trimmed on the way in, and the summary says what it is called now — which is what the next
      // turn will use to address it.
      expect(summary(res)).toBe("Now called semis-quarterly.");
      expect(body(res)["record_id"]).toBe(recipe);
      expect(getRecipe(r.db, recipe)!.name).toBe("semis-quarterly");

      // BY THE NAME IT ANSWERS TO NOW, because that is what a mention on the wire carries: the user
      // drags a row in as `@recipe:semis-quarterly` and the rename they ask for in the same
      // breath has nothing else to be addressed by.
      expect(
        (
          await call(r.tool("rename_record"), {
            table: "recipe",
            record: "semis-quarterly",
            name: "semiconductors",
          })
        ).isError,
      ).toBeUndefined();
      expect(getRecipe(r.db, recipe)!.name).toBe("semiconductors");
      // The id did not move, which is the whole reason a rename is cheap: every result already
      // handed out goes on naming this row. Nor did the specification: the name is the one column
      // `recipe_moves_only_its_status` leaves alone, and a rename never wakes it.
      expect(getRecipe(r.db, recipe)!.id).toBe(recipe);
      expect(getRecipe(r.db, recipe)!.content).toBe("Write a report.");
    } finally {
      r.cleanup();
    }
  });

  test("a name another row of the same table holds is refused; another table's is not", async () => {
    const r = rig();
    try {
      const mine = seedRecipe(r.db, "semis");
      const theirs = seedRecipe(r.db, "macro");

      const clash = failure(
        await call(r.tool("rename_record"), { table: "recipe", record: mine, name: "macro" }),
      );
      expect(clash.error).toBe("conflict");
      // The sentence names the TABLE and states the rule, because the rule is the part somebody has
      // to know to pick the next name: uniqueness is per table, so "already taken" without saying
      // where sends a reader looking through the wrong eleventh of the archive.
      expect(clash.message).toBe(
        'another recipe already answers to "macro"; within a table one name always means one row',
      );
      expect(getRecipe(r.db, mine)!.name).toBe("semis");
      expect(getRecipe(r.db, theirs)!.name).toBe("macro");

      // ACROSS TABLES NOTHING IS CLAIMED, and this is the call that proves the index is per table
      // rather than archive-wide: a thesis may be called `macro` while a recipe is, because a name
      // is never read on its own — only ever alongside the table it belongs to.
      const thesis = seedThesis(r.db, "Something else");
      expect(
        (await call(r.tool("rename_record"), { table: "thesis", record: thesis, name: "macro" }))
          .isError,
      ).toBeUndefined();

      // A blank name and an overlong one are refused apart, because a name is drawn in a 260px row:
      // past the cap it is an ellipsis with a uuid's worth of characters hidden behind it.
      expect(
        failure(await call(r.tool("rename_record"), { table: "recipe", record: mine, name: "  " }))
          .message,
      ).toContain("cannot be blank");
      expect(
        failure(
          await call(r.tool("rename_record"), {
            table: "recipe",
            record: mine,
            name: "x".repeat(200),
          }),
        ).message,
      ).toContain("80 characters at most");
    } finally {
      r.cleanup();
    }
  });

  test("a target refuses a rename outright, and a junction is not a record to rename", async () => {
    const r = rig();
    try {
      // THE ONE EXEMPTION IN THIS DATABASE'S NAMING RULE. A target's name is the instrument's
      // OFFICIAL full name — a fact somebody looked up rather than a summary anybody composed — so
      // there is nothing here for a rename to improve, and a wrong one is corrected by deleting the
      // target and recording it again. The schema has a trigger saying the same thing to whoever
      // reaches the database another way; this is where the sentence a model reads lives.
      await call(r.tool("upsert_target"), { ticker: "NVDA", name: "NVIDIA Corporation" });
      const refusal = failure(
        await call(r.tool("rename_record"), {
          table: "target",
          record: "NVDA",
          name: "NVIDIA Corp",
        }),
      );
      expect(refusal.error).toBe("invalid_request");
      expect(refusal.message).toContain("never edited");
      expect(refusal.message).toContain("delete the target");
      expect(
        r.db.query<{ name: string }, []>("SELECT name FROM target").get(),
      ).toEqual({ name: "NVIDIA Corporation" });

      // AND A JUNCTION IS NOT A RECORD. `regime` is a link between a thesis and a ticker: it is
      // drawn as an edge on each of the two rows it joins, holds nothing else, and has no `name`
      // column for anybody to read it by.
      //
      // THIS ONE IS PINNED AT THE SCHEMA RATHER THAN AT THE HANDLER, which is the exception to how
      // the rest of this file works and is worth saying why. `table` is an ENUM of the eleven
      // addressable tables, so the refusal happens before a handler runs at all — and it has to,
      // because the resolver underneath addresses a row by that table's id column and a junction
      // has none. Every other test here calls past zod on purpose; here the schema IS the guard, so
      // it is where the assertion belongs.
      const shape = schemaOf(
        definitions(r.deps).find((d) => d.name === "rename_record")!,
      ).shape;
      const table = (shape["table"] as z.ZodType).safeParse("regime");
      expect(table.success).toBe(false);
      // And the eleven it does take are the addressable ones, so a model reading the refusal is
      // being shown where rows actually live rather than told a table it named does not exist. The
      // two that left are refused here like any other word nothing answers to.
      for (const addressable of ["recipe", "report", "thesis", "information_source"]) {
        expect((shape["table"] as z.ZodType).safeParse(addressable).success).toBe(true);
      }
      for (const gone of ["workshop", "playbook"]) {
        expect((shape["table"] as z.ZodType).safeParse(gone).success).toBe(false);
      }
    } finally {
      r.cleanup();
    }
  });
});

describe("recipes, which are records", () => {
  test("creating one writes a row and nothing else — no version, no directory anywhere", async () => {
    const r = rig();
    try {
      const before = filesUnderVar(r);
      const res = await call(r.tool("create_recipe"), {
        name: "Semis, quarterly",
        content: "Ask what changed, then say what it is worth.",
      });
      expect(res.isError).toBeUndefined();
      const out = body(res) as { recipe_id: string; name: string; status: string };
      // THE NAME IS A HINT AND THE RESULT SAYS WHAT WAS MINTED FROM IT. The words the model chose
      // are slugified into the one line that addresses this row — bare, because nothing else holds
      // it yet — and handed straight back, so a later call can name the recipe with what it was
      // actually given rather than with what it asked for.
      expect(out.name).toBe("semis-quarterly");
      expect(summary(res)).toContain("semis-quarterly");

      // A recipe that was a directory as well as a row would make storing one a transaction plus a
      // mkdir, with one half to undo by hand whenever the other failed. The agent has ONE home
      // directory, so this is rows and nothing else — there is no ordering between rows and bytes
      // for a crash to land in the middle of. It is also ONE row: the container-plus-ledger this
      // replaced wrote two, and the second existed only to be counted.
      expect(filesUnderVar(r)).toEqual(before);
      expect(
        r.db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM recipe WHERE id = ?")
          .get(out.recipe_id),
      ).toEqual({ n: 1 });

      // A SECOND ONE ASKING FOR THE SAME WORDS IS NOT A COLLISION. The first recipe about quarterly
      // semis gets the summary verbatim; only the one that made the words ambiguous pays for it,
      // with four base36 characters — and it pays with a name of the same shape rather than with a
      // refusal the model would have to invent its way around. Two specifications saying similar
      // things are two specifications: what a recipe is FOR is not derivable from its bytes.
      const twin = body(
        await call(r.tool("create_recipe"), {
          name: "Semis, quarterly",
          content: "Ask what changed, then say what it is worth.",
        }),
      ) as { recipe_id: string; name: string };
      expect(twin.name).toMatch(/^semis-quarterly-[a-z0-9]{4}$/);
      expect(twin.recipe_id).not.toBe(out.recipe_id);
    } finally {
      r.cleanup();
    }
  });

  test("listing puts the active ones first, says how many reports stand under each, and carries no text", async () => {
    const r = rig();
    try {
      const other = seedRecipe(r.db, "Badly named", "Their specification.");
      const retired = seedRecipe(r.db, "Superseded");
      setRecipeStatus(r.db, retired, "inactive");
      r.db
        .query(
          "INSERT INTO report (name, id, recipe_id, title, content, created_at) " +
            "VALUES ('theirs', ?, ?, 'Theirs', '<!doctype html><title>t</title>', 1)",
        )
        .run(newId(), other);

      const listed = body(await call(r.tool("list_recipes")))["recipes"] as Array<{
        recipe_id: string;
        name: string;
        status: string;
        report_count: number;
      }>;
      // ACTIVE FIRST, then the archive. Nothing derives "the current recipe" and nothing should:
      // several may be active at once, because a person doing two kinds of work has two
      // specifications and neither supersedes the other. What the ordering answers is what a reader
      // is looking for — the ones still being written to, then the ones that are not.
      expect(listed.map((x) => x.status)).toEqual(["active", "active", "inactive"]);
      expect(listed[listed.length - 1]!.recipe_id).toBe(retired);
      const card = listed.find((x) => x.recipe_id === other)!;
      expect(card).toMatchObject({ name: "Badly named", status: "active", report_count: 1 });
      // The instructions themselves are NOT listed: a browse that carried every specification's
      // full text would answer "what recipes are there" with several pages of prose. `get_recipe`
      // reads one whole.
      expect(Object.keys(card)).not.toContain("content");

      // Narrowed to one standing, which is the read a listing gets asked for once the archive has
      // any depth to it.
      expect(
        (body(await call(r.tool("list_recipes"), { status: "inactive" }))["recipes"] as Array<{
          recipe_id: string;
        }>).map((x) => x.recipe_id),
      ).toEqual([retired]);

      // THE TOOL THAT WENT AND THE ONE THAT REPLACED IT, PINNED WHERE ITS TESTS WERE.
      // `rename_workshop` was once the only relabelling tool on this surface, and the name it wrote
      // is now the name every record carries. So the rename that exists is `rename_record`, which
      // takes the table as an argument: a per-table rename tool would be a second implementation of
      // a rule that has exactly one, and a tool for exactly one of the eleven tables would have been
      // the oddest possible place to start.
      expect(r.has("rename_workshop")).toBe(false);
      expect(r.has("rename_record")).toBe(true);
      expect(
        (
          await call(r.tool("rename_record"), {
            table: "recipe",
            record: other,
            name: "Better named",
          })
        ).isError,
      ).toBeUndefined();
      // And the name is read back through the listing, which is how the model finds out what a
      // recipe answers to — the whole of what it needs a name for.
      expect(getRecipe(r.db, other)!.name).toBe("Better named");
      expect(
        (body(await call(r.tool("list_recipes")))["recipes"] as Array<{
          recipe_id: string;
          name: string;
        }>).find((x) => x.recipe_id === other)!.name,
      ).toBe("Better named");
    } finally {
      r.cleanup();
    }
  });

  test("deleting takes every report published under it, and says how many", async () => {
    const r = generating();
    try {
      // A recipe with a published report under it, and the procedure closed, so what is left is the
      // ordinary delete. (Deleting one WHILE its procedure records is refused by the freeze, over
      // in "the archive holds still" — this tool has no refusal of its own to reach.)
      const reportId = body(
        await call(r.tool("publish_report"), { draft_path: draft(r, "a.html"), title: "Doomed" }),
      )["report_id"] as string;
      expect(r.runs.recording()).toBe(false);

      const res = await call(r.tool("delete_recipe"), {
        recipe_id: r.recipeId,
        confirm: true,
      });
      expect(res.isError).toBeUndefined();
      // THE COUNT IS IN THE SENTENCE, because the reports are the expensive half of this act and a
      // caller who wanted the milder move almost always wanted `set_recipe_status`.
      expect(body(res)).toMatchObject({ deleted: true, reports_removed: 1 });
      expect(summary(res)).toContain("with 1 report");
      expect(getRecipe(r.db, r.recipeId)).toBeNull();
      // The report goes with it; the document IS one of the rows, so nothing is left on disk for
      // anyone to sweep up.
      expect(getReportContent(r.db, reportId)).toBeNull();
      expect(r.db.query("SELECT COUNT(*) AS n FROM report").get()).toEqual({ n: 0 });

      // Exactly ONE deletion-log row, and it is the recipe. Everything else that went is the
      // schema's consequence of that single act, and logging the cascade would say that several
      // things happened when one did.
      const logged = r.db
        .query<{ table_name: string }, []>("SELECT table_name FROM deletion_log")
        .all();
      expect(logged).toEqual([{ table_name: "recipe" }]);

      expect(
        failure(await call(r.tool("delete_recipe"), { recipe_id: "nope", confirm: true }))
          .error,
      ).toBe("not_found");
    } finally {
      r.cleanup();
    }
  });

  test("scripts, theses and sources survive a recipe; only its reports do not", async () => {
    const r = rig();
    try {
      const scriptId = seedScript(r, "prices");
      const thesisId = seedThesis(r.db, "dip buying");
      const sourceId = seedSource(r.db);

      expect(
        (await call(r.tool("delete_recipe"), { recipe_id: r.recipeId, confirm: true })).isError,
      ).toBeUndefined();

      // All three are global — they belong to the installation, and a specification being retired
      // or removed is no reason for the price fetcher everyone runs to go with it.
      expect(body(await call(r.tool("get_script"), { script_id: scriptId }))["source"]).toBeDefined();
      expect(body(await call(r.tool("get_thesis"), { thesis_id: thesisId }))["thesis"]).toBeDefined();
      expect(getSource(r.db, sourceId)).not.toBeNull();
    } finally {
      r.cleanup();
    }
  });
});
