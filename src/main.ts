#!/usr/bin/env bun
/**
 * The `yewreview` command: bring one local installation up, and say honestly what it can do.
 *
 * The order below is load-bearing in two places. The environment is scrubbed FIRST, before any
 * module has read it — the measurement engine refuses to construct when it meets an undeclared
 * variable in its own namespace, and a stray one in a shell profile would otherwise fail every
 * measurement with an error that names the variable but not the reason. And the database is opened
 * BEFORE the sandbox is provisioned, because a refused database is a reason not to start at all
 * while a missing Python is only a reason to start with less.
 *
 * Which is the standing decision here: exactly one condition is fatal. A database this build
 * cannot read means stopping, because the alternative is writing into a file whose shape we
 * guessed. Everything else — no Python, no network on first run, no OS sandbox — degrades a
 * capability, and the health endpoint and the agent's own instructions say which one is missing.
 */

import { parseArgs } from "node:util";
import { rmSync } from "node:fs";

import { dropEmptyApiKey, scrubSeikanEnv } from "./env.ts";
import {
  HARNESSES,
  defaultVarDir,
  ensureDirs,
  isHarness,
  loadSettings,
  parseLogLevel,
  paths,
  type Overrides,
} from "./config.ts";
import { claimWriter, readWriterNote, writeWriterNote, type ProcessMode } from "./db/lock.ts";
import { DatabaseRefused, openDb } from "./db/open.ts";
import { extractResources } from "./resources/embed.ts";
import { probeVenv, provisionVenv, type VenvStatus } from "./sandbox/venv.ts";
import { sandboxAvailability } from "./sandbox/exec.ts";
import type { Database } from "bun:sqlite";

import { ClaudecodeAgent } from "./claudecode/session.ts";
import { OpencodeAgent } from "./opencode/agent.ts";
import { poolStore } from "./opencode/config.ts";
import { probeOpencode } from "./opencode/probe.ts";
import { opencodeSessions } from "./opencode/sessions.ts";
import type { Agent as HarnessAgent, ServerDeps } from "./server/chat.ts";
import type { EventsFrame } from "./protocol/types.ts";
import type { SessionsApi } from "./server/sessions.ts";
import type { Settings } from "./config.ts";
import type { Resources } from "./resources/embed.ts";
import { attachLogAnnouncer } from "./repo/logs.ts";
import { sdkSessions } from "./claudecode/sessions.ts";
import { startServer } from "./server/serve.ts";

const USAGE = `yewreview — a local agent that writes market research reports

  yewreview claudecode [options]   answer with the Claude Agent SDK, using this machine's Claude login
  yewreview opencode [options]     answer with opencode, using the models in the window's pool

  --host <addr>       interface to bind (default 127.0.0.1)
  --port <n>          port (default 8787)
  --model <name>      the model to converse with (claudecode only; default claude-opus-5)
  --var-dir <path>    runtime data root (default ${defaultVarDir()})
  --no-browser        do not open a browser on startup
  --log-level <lvl>   debug | info | warning | error
  --help

The harness is named rather than defaulted. The two share the archive and the measurement engine
and nothing else — a different conversation, a different transcript, and different models — so
which one answered is not a thing to be unsure about afterwards.
`;

/**
 * The flags and the one positional, or null when the answer was `--help`.
 *
 * **The harness is a required positional and has no default**, which is the whole of the decision:
 * a flag with a default would be a hidden default harness, and "drop the legacy path" means there
 * is no such thing as the one you get by not saying. Bare `yewreview` prints the usage and exits
 * non-zero, the way a command missing its subcommand does.
 *
 * Argument validation throwing here is not a new fatal STARTUP path — the rule against those is
 * about capability degrading after boot. Nothing has been opened yet; this is the same class as
 * `--port lots`, which has always thrown.
 */
function parse(argv: string[]): Overrides | null {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      model: { type: "string" },
      "var-dir": { type: "string" },
      "no-browser": { type: "boolean" },
      "log-level": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(USAGE);
    return null;
  }
  const named = positionals[0];
  if (positionals.length !== 1 || named === undefined || !isHarness(named)) {
    const got = positionals.length === 0 ? "none" : positionals.join(" ");
    throw new Error(
      `name the harness to answer with: ${HARNESSES.join(" or ")} (got ${got}). ` +
        `Run yewreview --help for the rest.`,
    );
  }
  const overrides: Overrides = { harness: named };
  if (values.host) overrides.host = values.host;
  if (values.port) {
    const port = Number.parseInt(values.port, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`--port must be a port number, got ${values.port}`);
    }
    overrides.port = port;
  }
  if (values.model) {
    // Claude-only, and refused rather than ignored under opencode. That path takes its models from
    // a pool the user edits in the window, with a model per role; a flag naming one model would
    // have to either lose to the pool silently or quietly overwrite somebody's routing.
    if (named !== "claudecode") {
      throw new Error(
        "--model is for the claudecode harness. The opencode harness answers with the model its pool " +
          "assigns to the build role — edit the pool in the window.",
      );
    }
    overrides.model = values.model;
  }
  if (values["var-dir"]) overrides.varDir = values["var-dir"];
  if (values["no-browser"]) overrides.openBrowser = false;
  if (values["log-level"]) overrides.logLevel = parseLogLevel(values["log-level"], "--log-level");
  return overrides;
}

function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // A browser that will not open is not a reason to stop serving; the URL is printed above.
  }
}

/** What the boot needs from whichever harness was named. */
type StartedHarness = {
  /**
   * The harness, as the server's interface plus the two methods the BOOT owns.
   *
   * `attachEvents` and `dispose` are not on `Agent` deliberately: the server's interface is what
   * an HTTP route or a socket may do to a conversation, and neither of those is. Handing the
   * broadcaster over and shutting down are the boot's business, so they are named here, where the
   * boot is.
   */
  agent: HarnessAgent & {
    attachEvents(broadcast: (frame: EventsFrame) => void): void;
    dispose(): void;
  };
  sessions: SessionsApi;
  /** The opencode surface the server mounts routes from, absent on the Claude path. */
  opencode?: ServerDeps["opencode"];
};

/**
 * Build the harness the command line named.
 *
 * The two branches are deliberately asymmetric in one way and identical in every other. Both hand
 * back something satisfying `Agent` and something satisfying `SessionsApi`, so nothing downstream
 * branches again. Only the opencode one carries a third thing — its pool and its status — because
 * only it has routes and chrome of its own.
 *
 * An opencode installation that cannot be driven is reported here and started anyway: the server
 * runs, the archive is readable, and the chat refuses each turn with the probe's own sentence. That
 * is the venv's pattern, and the argument is the same — a boot that died because one capability is
 * missing takes away the nine that are not.
 */
async function startHarness(
  settings: Settings,
  db: Database,
  resources: Resources,
  venv: () => VenvStatus,
  mode: ProcessMode,
): Promise<StartedHarness> {
  if (settings.harness === "claudecode") {
    return {
      agent: new ClaudecodeAgent({ db, settings, resources, venv, mode }),
      sessions: sdkSessions(settings),
    };
  }

  const status = await probeOpencode(settings);
  if (status.ok) {
    console.log(`  opencode ${status.version}`);
  } else {
    console.warn(`\nnote: ${status.hint}\n`);
  }
  const pool = poolStore(settings);
  // Rendered at boot as well as after every write, so a config edited by hand — or left behind by
  // an older build — is replaced by one this build actually wrote before any child reads it. A
  // read-only process skips it: the writer's child was started from the config the writer rendered,
  // and rewriting it from here would move that config under a process that is live on top of it.
  if (mode === "writer") pool.materialize();

  const agent = new OpencodeAgent({ db, settings, venv, pool, status: () => status, mode });
  return {
    agent,
    sessions: opencodeSessions(() => agent.liveServer()),
    opencode: {
      pool,
      status: () => status,
      mcpSecret: () => agent.mcpSecret(),
      tools: () => agent.toolDefinitions(),
      reloadable: () => agent.reloadable(),
    },
  };
}

async function main(): Promise<void> {
  const overrides = parse(Bun.argv.slice(2));
  if (overrides === null) return;

  const removed = scrubSeikanEnv();
  const droppedKey = dropEmptyApiKey();

  const settings = loadSettings(overrides);
  const p = ensureDirs(settings);

  if (removed.length > 0) {
    console.warn(
      `note: removed ${removed.join(", ")} from the environment — the measurement engine owns ` +
        `that namespace and refuses to run when it meets a variable it does not declare.`,
    );
  }
  if (droppedKey) {
    console.warn("note: ANTHROPIC_API_KEY was set but empty; unset it rather than leaving it blank.");
  }
  // No key is NOT the same as no credentials. The agent SDK resolves them the way Claude Code does
  // — an API key if one is exported, otherwise the login already on this machine — so a Claude
  // subscription answers perfectly well with nothing set. Saying "the agent cannot answer" here
  // would be wrong, and wrong in the expensive direction: it reads as a broken install and invites
  // somebody to go find a key they do not need. What is worth saying is where the credential will
  // come from, so a failure later has somewhere to point.
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.warn(
      "note: ANTHROPIC_API_KEY is not set — the agent will use this machine's Claude login " +
        "(`claude setup-token`, or CLAUDE_CODE_OAUTH_TOKEN). If it turns out there is no login " +
        "either, turns will fail with an authentication error and this is the line to remember.",
    );
  }

  // The writer claim, taken BEFORE the database is opened — see `db/lock.ts` for the whole rule.
  // The first process on this var root holds the pen for as long as it runs; every later one is
  // read-only for its whole life, decided here and never revisited. Claiming before `openDb` is
  // also what makes a fresh database's creation single-writer by construction. The claim object is
  // held in the shutdown closure below, and that reference IS the lock — a collected handle would
  // be a released one.
  const claim = claimWriter(p.writerLockPath);
  const mode = claim.mode;
  if (mode === "writer") {
    writeWriterNote(p.writerNotePath);
  } else {
    const note = readWriterNote(p.writerNotePath);
    const holder = note === null ? "another yewreview process" : `another yewreview process (pid ${note.pid})`;
    console.warn(
      `note: ${holder} is already serving ${settings.varDir}, so this one is READ-ONLY for its ` +
        `whole life. The window works and the whole archive reads; every record write, run and ` +
        `generation is refused with a sentence saying so. There is no promotion — to write from ` +
        `here, close the other process and start this one again.`,
    );
  }

  let db;
  try {
    db = openDb(p.dbPath, { readonly: mode === "reader" });
  } catch (err) {
    if (err instanceof DatabaseRefused) {
      console.error(`\nYewReview cannot start.\n\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const resources = await extractResources(settings, { serveAssets: mode === "writer" });

  const sandbox = await sandboxAvailability();
  if (!sandbox.available && sandbox.hint) console.warn(`note: ${sandbox.hint}`);

  let venvStatus: VenvStatus = {
    ready: false,
    python: null,
    seikanBin: null,
    seikanVersion: null,
    dslGuide: null,
    error: "not provisioned yet",
  };
  // A read-only process PROBES rather than provisions — installing, chmodding and rewriting the
  // marker are the writer's to do, and a reader doing them would race the process that owns the
  // directory. The same closure serves `POST /api/venv/retry`, so the route degrades to a probe
  // in a reader too (belt and braces behind its own 409 guard).
  const provision = async (): Promise<VenvStatus> => {
    venvStatus =
      mode === "reader"
        ? await probeVenv(settings)
        : await provisionVenv(settings, {
            uv: resources.uv,
            wheel: resources.seikanWheel,
            editable: resources.seikanEditable,
            requirements: resources.requirements,
          });
    return venvStatus;
  };

  if (mode === "writer") {
    console.log("  preparing the measurement environment (first run installs it — this takes a few minutes)…");
  }
  await provision();
  if (venvStatus.ready) {
    console.log(`  measurement engine: seikan ${venvStatus.seikanVersion}`);
  } else {
    console.warn(
      `\nnote: the measurement engine is unavailable, so theses cannot be measured in this ` +
        `installation. Everything else works, and the agent has been told to say so rather than ` +
        `describe numbers it could not compute.\n  ${venvStatus.error}\n`,
    );
  }

  // ONE agent for the installation, and WHICH one was named at the command line. It is built
  // before the server because the server is handed it, which is also why it has no broadcaster yet
  // — see `attachEvents` below. Nothing is resumed here: which conversation this boot continues is
  // the user's to say, out of the session list, and a restart that silently reopened whatever was
  // last spoken to would be this process promising a conversation only a transcript store can
  // vouch for.
  //
  // The two branches share their arguments and nothing else. Everything below this point — the
  // server, the routes, the window — is written against the interface both satisfy, so this is the
  // last place in the process that knows which harness is running.
  const harness = await startHarness(settings, db, resources, () => venvStatus, mode);

  const server = startServer({
    db,
    settings,
    mode,
    agent: harness.agent,
    // The transcript store, behind the seam the routes read it through. Whose store depends on the
    // harness; the seam does not.
    sessions: harness.sessions,
    resources,
    venv: () => venvStatus,
    sandbox,
    ...(harness.opencode === undefined ? {} : { opencode: harness.opencode }),
    reprovision: provision,
    // Handed over rather than passed in: the agent and the two logs exist before the server does,
    // and what they need is where to announce, which only exists once it is listening. Both are
    // wired to the same broadcast, because both are saying the same kind of thing — something moved
    // that a window with no conversation open is nonetheless drawing.
    attachEvents: (send) => {
      harness.agent.attachEvents(send);
      attachLogAnnouncer(db, send);
    },
  });

  // The port the server BOUND, not the one it was asked for: `--port 0` means "any free port", and
  // a banner built from the request prints http://127.0.0.1:0/ — which is also what would be
  // opened in the browser.
  const url = `http://${settings.host}:${server.port}/`;
  console.log(`\n  YewReview is running at ${url}${mode === "reader" ? " (read-only)" : ""}\n`);
  if (settings.openBrowser) openUrl(url);

  const shutdown = (): void => {
    server.stop();
    harness.agent.dispose();
    db.close();
    claim.release();
    // Scratch under var/tmp belongs to runs that are over; keeping it across boots only grows. The
    // writer's job alone: this is the one shutdown line that reaches across processes, and a
    // reader running it would wipe the writer's live scratch.
    if (mode === "writer") {
      try {
        rmSync(paths(settings).tmpDir, { recursive: true, force: true });
      } catch {
        /* a temp directory we cannot remove is not worth failing a shutdown over */
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
