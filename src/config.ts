/**
 * Settings and the derived shape of `var/`.
 *
 * Every runtime path YewReview touches hangs off ONE root (`YEWREVIEW_VAR_DIR`, defaulting to `./var`
 * in a checkout and `~/.yewreview` for the installed binary — see `defaultVarDir`), so a
 * second instance is a second `--var-dir` and nothing else. Paths are derived, never configured
 * individually: a database somewhere other than `var/db/` would be a database the sandbox policy,
 * the startup sweep and the landing guard each have to be told about separately, and one of them
 * would eventually not be told.
 */

import { basename, dirname, join, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";

import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

export type LogLevel = "debug" | "info" | "warning" | "error";

/** How hard the model works before it answers. The SDK owns the vocabulary, so it is re-exported
 * from here rather than restated: this module is where a setting's type belongs, and a second
 * hand-written union would be a copy that drifts the first time the SDK adds a level. */
export type { EffortLevel };

/**
 * Which harness answers this installation's conversation.
 *
 * The two share the database and the measurement engine and nothing else — a different session, a
 * different transcript store, a different set of models. Named at the command line and never
 * defaulted, so "which one wrote this" is not a question anybody has to reconstruct afterwards.
 */
export const HARNESSES = ["claudecode", "opencode"] as const;

export type Harness = (typeof HARNESSES)[number];

export function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}

export type Settings = {
  readonly harness: Harness;
  readonly varDir: string;
  readonly host: string;
  readonly port: number;
  readonly model: string;
  /** How hard the model works when a conversation has expressed no preference. Always a level:
   * nothing configures this one, and the reader moves it per conversation from the composer rather
   * than per installation — see `Agent.setEffort`. */
  readonly effort: EffortLevel;
  readonly maxTurns: number;
  readonly logLevel: LogLevel;
  readonly openBrowser: boolean;
  /** Explicit interpreter for the sandbox venv, handed to `uv venv --python`; when unset, uv
   * resolves one itself, downloading a suitable version if the machine has none. */
  readonly python: string | undefined;
  /** Escape hatch for a compiled binary that cannot extract or exec its embedded Claude CLI. */
  readonly claudeCli: string | undefined;
  /** The same escape hatch for the opencode executable — a platform the packages do not cover, or
   * an extracted binary something on the machine refuses to run. */
  readonly opencodeCli: string | undefined;
  /** And for uv. A dev checkout has no embedded copy and finds one on PATH; this overrides both. */
  readonly uv: string | undefined;
};

export type Overrides = Partial<{
  harness: Harness;
  varDir: string;
  host: string;
  port: number;
  model: string;
  logLevel: LogLevel;
  openBrowser: boolean;
}>;

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  model: "claude-opus-5",
  // `satisfies` rather than a bare string, for the reason `EFFORT_LEVELS` below carries one: this is
  // the only place a level is written down outside that list, and the SDK's own union is what says
  // whether it is still a level. Misspell it, or outlive the day the SDK renames one, and it stops
  // compiling here rather than reaching a session as a flag the CLI has never heard of. `as const`
  // is what stops the property widening to `string` on the way into this object, which would defer
  // the same failure to every reader of it.
  effort: "high" as const satisfies EffortLevel,
  maxTurns: 100,
  logLevel: "info" as LogLevel,
};

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warning", "error"];

// `satisfies` rather than an annotation, so this list stays honest against the SDK's own union:
// misspell a level and it stops compiling, and the day the SDK adds one, adding it here is a
// one-line change made deliberately rather than a value that quietly started being accepted.
//
// Exported because the window draws a picker over these five names and cannot import this module —
// nothing in the browser bundle may reach the SDK. `web/src/lib/protocol.ts` therefore restates the
// list, and `tests/webProtocol.test.ts` compares the two value for value against THIS one, which is
// the only copy the SDK's union is checked against.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies
  readonly EffortLevel[];

function envStr(name: string): string | undefined {
  const raw = process.env[`YEWREVIEW_${name}`];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function envInt(name: string, fallback: number): number {
  const raw = envStr(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) {
    throw new Error(`YEWREVIEW_${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Narrowing predicate over the level names. Both routes into `logLevel` — the environment below
 * and `--log-level` on the command line — go through it, so neither can seat a value the type says
 * is impossible. */
function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Parse a level name from either route, naming the source in the refusal so the message points at
 * the thing the reader actually typed. */
export function parseLogLevel(raw: string, source: string): LogLevel {
  const value = raw.toLowerCase();
  if (!isLogLevel(value)) {
    throw new Error(`${source} must be one of ${LOG_LEVELS.join(", ")}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Narrowing predicate over the effort levels.
 *
 * There is exactly one route by which an unvalidated string becomes a level, and it is the chat
 * socket: a `set_effort` frame arrives as JSON and nothing about the wire narrows it.
 * `Agent.setEffort` is where this is called, so a name that is not one of the five is refused as the
 * stale window it came from rather than passed to the SDK. Nothing configures the level, so no flag
 * and no environment variable reaches this.
 */
export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Where the runtime root goes when nothing says otherwise.
 *
 * A checkout keeps it beside the source — `./var`, which is what the docs, `.env.example` and every
 * suite describe, and what makes `rm -rf var/` a complete reset of a development machine.
 *
 * An installed binary cannot use that default. It lives on `$PATH` and is run from wherever the
 * shell happens to be, so a cwd-relative root would strew a database, an agent home and a
 * several-hundred-megabyte venv across every directory it was ever invoked from — each one a
 * separate installation wearing the same name, none of them able to see the reports written by the
 * others. So the installed command hangs its root off `$HOME`, the one path that means the same
 * thing from every prompt. `--var-dir` and `YEWREVIEW_VAR_DIR` override it in both modes, which is
 * still how a second instance is made.
 *
 * `/$bunfs/root` is where `bun build --compile` mounts the bundle, so this module's own directory
 * already answers the only question being asked: is there a source tree next to me to put `var/` in?
 */
export function defaultVarDir(): string {
  return import.meta.dir === "/$bunfs/root" ? join(homedir(), ".yewreview") : "var";
}

function envLogLevel(): LogLevel | undefined {
  const raw = envStr("LOG_LEVEL");
  if (raw === undefined) return undefined;
  return parseLogLevel(raw, "YEWREVIEW_LOG_LEVEL");
}

/**
 * Build settings from the environment, then apply CLI overrides on top.
 *
 * `harness` is the one field with NO environment variable and no default worth the name. It is
 * named at the invocation or the command does not run (`main.ts`), and defaulting it here would
 * quietly reintroduce the hidden default that positional exists to remove. The fallback below is
 * for tests, which build settings directly and overwhelmingly mean the Claude path.
 */
export function loadSettings(overrides: Overrides = {}): Settings {
  return {
    harness: overrides.harness ?? "claudecode",
    varDir: resolve(overrides.varDir ?? envStr("VAR_DIR") ?? defaultVarDir()),
    host: overrides.host ?? envStr("HOST") ?? DEFAULTS.host,
    port: overrides.port ?? envInt("PORT", DEFAULTS.port),
    model: overrides.model ?? envStr("MODEL") ?? DEFAULTS.model,
    effort: DEFAULTS.effort,
    maxTurns: envInt("MAX_TURNS", DEFAULTS.maxTurns),
    logLevel: overrides.logLevel ?? envLogLevel() ?? DEFAULTS.logLevel,
    openBrowser: overrides.openBrowser ?? true,
    python: envStr("PYTHON"),
    claudeCli: envStr("CLAUDE_CLI"),
    opencodeCli: envStr("OPENCODE_CLI"),
    uv: envStr("UV"),
  };
}

/**
 * The layout of `var/`, derived from the root.
 *
 * There is no data tree. A script's output is a working file in the agent's home, and what the
 * database keeps about it is the script and argument that would produce it again — so nothing here
 * is a location some row is vouching for. `reports/` holds no documents: a report is a row, content
 * and all, and `reports/assets/` is the served chart library that published HTML loads from.
 *
 * `home/` is where the agent actually works: downloads, drafts of documents, scratch, and the one
 * place its sandbox may write. There is ONE of it, because there is one conversation. A directory
 * per recipe — `recipes/<id>/` — would quietly decide two things it has no business deciding:
 * that a piece of work cannot span two recipes, and that deleting a recipe deletes files nobody
 * had said were disposable. A recipe is a record, not a place.
 */
export type Paths = {
  readonly dbPath: string;
  /**
   * The writer claim for this var root — a dedicated lock database, held `BEGIN IMMEDIATE` by the
   * one process allowed to write the archive. See `db/lock.ts` for the whole design. It lives under
   * `var/db/` so the sandbox rules that deny the agent the database deny it the lock too, with no
   * second rule to keep in step.
   */
  readonly writerLockPath: string;
  /** Who holds the pen, as prose for banners and refusals — `{pid, startedAt}`, written by the
   * writer at boot and consulted for authority by nothing. The lock is the authority. */
  readonly writerNotePath: string;
  readonly reportsDir: string;
  readonly reportAssetsDir: string;
  readonly homeDir: string;
  readonly venvDir: string;
  readonly cacheDir: string;
  readonly resourcesDir: string;
  readonly numbaCacheDir: string;
  readonly tmpDir: string;
  /**
   * Where the claudecode harness keeps everything of its own: the Claude CLI's config directory,
   * and with it the transcript store under `projects/<the agent's home>`.
   *
   * The CLI would otherwise keep that store in the machine's `~/.claude`, which made two things
   * untrue at once — `rm -rf var/` was advertised as a complete reset and left every conversation
   * behind, and two installations pointed at different var-dirs shared one history. It is pinned
   * here with `CLAUDE_CONFIG_DIR` on the session's subprocess environment.
   *
   * Credentials deliberately do NOT move with it. See the environment block in
   * `claudecode/options.ts`: this installation borrows the machine's Claude login rather than
   * asking for one of its own.
   */
  readonly claudecodeDir: string;
  /**
   * Where the executables this process spawns are extracted to.
   *
   * DELIBERATELY OUTSIDE EVERY WRITABLE SET, and that placement is the whole guarantee. `var/cache`
   * is writable by every confined child — the engine's kernel cache lives there — so an executable
   * kept in it could be overwritten by the agent and re-spawned by this process on the next boot.
   * Nothing writes here but the extraction in `resources/embed.ts`, and the sandbox rules name it
   * as denied for the same belt-and-braces reason they name the venv.
   *
   * Not created by `ensureDirs`, like `venvDir`: extraction makes it, content-addressed, so an
   * upgraded build lands beside the old one instead of overwriting a file a running process is
   * paging in.
   */
  readonly binDir: string;
  /**
   * Where the opencode harness keeps everything of its own.
   *
   * Derived here with the rest rather than configured, for the reason the whole layout is: the
   * sandbox rule, the child's environment and the config writer must agree about it, and three
   * settings that could disagree is how a harness ends up writing outside its own sandbox. Both
   * harness directories are created unconditionally — an empty one costs nothing, and a branch in
   * `ensureDirs` would be a second place that knows which harness is running.
   */
  readonly opencodeDir: string;
  /** The config file YewReview writes for opencode, from the pool. Never hand-edited. */
  readonly opencodeConfigPath: string;
  /** The model pool, as the window edits it. The one file here a person owns. */
  readonly opencodePoolPath: string;
  /** Where opencode keeps its own state — sessions included, which is what makes it a transcript
   * store this installation can read back. */
  readonly opencodeStateDir: string;
};

export function paths(settings: Settings): Paths {
  const v = settings.varDir;
  return {
    dbPath: resolve(v, "db/yewreview.sqlite"),
    writerLockPath: resolve(v, "db/writer.lock.db"),
    writerNotePath: resolve(v, "db/writer.json"),
    reportsDir: resolve(v, "reports"),
    reportAssetsDir: resolve(v, "reports/assets"),
    homeDir: resolve(v, "home"),
    venvDir: resolve(v, "venv"),
    cacheDir: resolve(v, "cache"),
    resourcesDir: resolve(v, "cache/resources"),
    numbaCacheDir: resolve(v, "cache/numba"),
    tmpDir: resolve(v, "tmp"),
    claudecodeDir: resolve(v, "claudecode"),
    binDir: resolve(v, "bin"),
    opencodeDir: resolve(v, "opencode"),
    opencodeConfigPath: resolve(v, "opencode/opencode.json"),
    opencodePoolPath: resolve(v, "opencode/models.json"),
    opencodeStateDir: resolve(v, "opencode/state"),
  };
}

/**
 * A path with every symlink in it resolved, whether or not the path itself exists yet.
 *
 * `realpathSync` throws on a path whose last segments are not there, which is the ordinary case for
 * something about to be written — so the walk climbs to the deepest ancestor that DOES exist,
 * resolves that, and puts the remainder back on.
 *
 * It lives here, beside the layout, because three different guards need it and a private copy in
 * any of them is the same mistake three times over. On macOS a temp directory is reached through
 * `/var` and `/tmp`, both symlinks into `/private`, so a rule written against the unresolved
 * spelling is a rule the kernel never matches: the file guard would deny every legitimate write,
 * and the sandbox profile would silently permit everything it means to forbid. A guard that
 * resolves only one side of its comparison is measuring two different filesystems.
 */
export function realPath(path: string): string {
  const trail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...trail);
    } catch {
      const parent = dirname(current);
      // The filesystem root failing to resolve means something is very wrong; judging the
      // unresolved path is the conservative answer, not a pass.
      if (parent === current) return path;
      trail.unshift(basename(current));
      current = parent;
    }
  }
}

/** Create every directory the layout promises. Idempotent; safe to call on every boot. */
export function ensureDirs(settings: Settings): Paths {
  const p = paths(settings);
  mkdirSync(resolve(settings.varDir, "db"), { recursive: true });
  for (const dir of [
    p.reportsDir,
    p.reportAssetsDir,
    p.homeDir,
    p.cacheDir,
    p.resourcesDir,
    p.numbaCacheDir,
    p.tmpDir,
    p.claudecodeDir,
    p.opencodeDir,
    p.opencodeStateDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return p;
}

/**
 * The agent's working directory — its home on disk, and its session's cwd.
 *
 * The cwd is not only where files land: the SDK keys its own session store by it, so this one path
 * is also what makes every conversation this installation has ever had appear in one project bucket
 * that the session list can read. Two homes would be two histories.
 */
export function homeDir(settings: Settings): string {
  return paths(settings).homeDir;
}
