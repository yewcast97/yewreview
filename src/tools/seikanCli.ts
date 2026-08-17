/**
 * A thesis's identity, obtained by SPAWNING the engine rather than by reimplementing it.
 *
 * `dsl_hash` is seikan's canonical hash — sha256 over the document normalised through seikan's own
 * schema, so two spellings of the same rules share one identity and a document that does not
 * validate has no hash at all. That normalisation is the engine's schema, in Python, and there are
 * exactly two ways to get it from Bun: spawn the venv interpreter, or write the schema a second
 * time in TypeScript. The second is the same rule in two places, which is eventually two rules —
 * and the one that would drift is the one deciding whether two theses are the same thesis.
 *
 * So this module runs `<venv>/bin/python -c <script>` with the document on stdin and reads one JSON
 * object off stdout. Nothing here imports seikan and nothing here parses the DSL schema.
 *
 * The one piece of judgement that stays on this side is which TICKER a measured target belongs to.
 * A seikan document names its targets and locates none of them, so the target KEY is the whole of
 * what the engine can say about which instrument a thesis is about — and whether a key is a symbol
 * is YewReview's grammar, decided by `normalizeTicker` in the target repository. Duplicating THAT
 * into the Python would be the same mistake in the other direction.
 */

import { join } from "node:path";

import { homeDir } from "../config.ts";
import { credentialFreeEnv } from "../env.ts";
import { normalizeTicker } from "../repo/targets.ts";
import { confine, scientificCaches } from "../sandbox/exec.ts";
import type { ToolDeps } from "../protocol/types.ts";

/** What the engine reported, or why it could not. Never an exception: both outcomes are results a
 * tool hands back to the model. */
export type DslIdentity =
  | { ok: true; hash: string; tickers: string[] }
  | { ok: false; kind: string; message: string };

/**
 * Keys that name no instrument however they are spelled.
 *
 * `normalizeTicker` accepts any short alphanumeric word, so a placeholder key would sail through as
 * a symbol and file the thesis under an instrument nobody trades. These are the two words a caller
 * reaches for when it is not naming one: seikan's own reserved benchmark key, and the DSL's generic
 * name for a single unnamed target.
 */
const NOT_INSTRUMENTS = new Set(["benchmark", "target"]);

/**
 * Read the document, hash it, and report the target keys it MEASURES.
 *
 * External feeds and the benchmark are deliberately left out: they are inputs to a decision, not
 * things the thesis is about. A thesis that measures NVDA against SPY is a thesis about NVDA, and
 * filing it under SPY as well would list it among SPY's own measurements.
 */
const IDENTITY_SCRIPT = `
import json, sys

def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()
    sys.exit(code)

raw = sys.stdin.read()
try:
    dsl = json.loads(raw)
except Exception as exc:
    emit({"error": "dsl_invalid", "message": "the thesis document is not JSON: %s" % exc}, 3)
if not isinstance(dsl, dict):
    emit({"error": "dsl_invalid", "message": "the thesis document must be a JSON object"}, 3)

try:
    from seikan.gate import canonical_dsl_hash
except Exception as exc:
    emit({"error": "venv_unavailable", "message": "seikan is not importable: %s" % exc}, 4)

try:
    digest = canonical_dsl_hash(dsl)
except Exception as exc:
    emit({"error": "dsl_invalid", "message": str(exc)}, 3)

data = dsl.get("data")
data = data if isinstance(data, dict) else {}
declared = data.get("targets")
targets = [t for t in declared if isinstance(t, str)] if isinstance(declared, list) else []

emit({"hash": digest, "targets": targets})
`;

export async function dslIdentity(deps: ToolDeps, dslJson: string): Promise<DslIdentity> {
  const venv = deps.venv();
  if (!venv.ready || venv.python === null) {
    return {
      ok: false,
      kind: "venv_unavailable",
      message:
        `the measurement engine is not installed in this environment, so a thesis cannot be given ` +
        `its canonical identity${venv.error ? ` (${venv.error})` : ""}. Say so plainly rather ` +
        `than storing a thesis nothing can measure.`,
    };
  }

  // CONFINED like every other spawn out of this process, and NOT recorded like most of them.
  //
  // Confined because this runs from the privileged server, which can reach the database, the venv
  // and every published report's chart library; the interpreter it starts is the one the agent's
  // own programs run in, and "it only imports a module" is a property of the script we pass rather
  // than of the process that results. Unrecorded because it produces no number a report stands on:
  // it asks the engine what a document's canonical hash and target keys are, and the answer becomes
  // a column of the thesis row, checkable there for ever. A history line for it would be noise in
  // the one place noise is expensive.
  const wrapped = confine([venv.python, "-c", IDENTITY_SCRIPT], {
    writable: homeDir(deps.settings),
    alsoWritable: scientificCaches(deps.settings.varDir),
    denyRead: [join(deps.settings.varDir, "db")],
  });
  if (!wrapped.ok) {
    return { ok: false, kind: "invalid_request", message: wrapped.message };
  }
  const env = credentialFreeEnv();
  // The same cache home every other engine spawn gets (`exec.ts`), and load-bearing here too:
  // seikan's kernels are `@njit(cache=True)`, numba refuses to compile a cacheable kernel with
  // nowhere writable to put it, and inside the sandbox the package's own directory is not
  // writable. Without this the import itself dies on the first machine whose cache is cold.
  env["NUMBA_CACHE_DIR"] = join(deps.settings.varDir, "cache", "numba");
  const proc = Bun.spawn(wrapped.command, {
    env,
    stdin: new TextEncoder().encode(dslJson),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    // The engine is silent on success and prints ONE envelope on failure, so unparseable stdout
    // means the interpreter itself fell over — which is not something the model can fix by
    // rewriting its document.
    return {
      ok: false,
      kind: "venv_unavailable",
      message:
        `the measurement engine did not answer: ${stderr.trim().slice(-800) || "no output"}. ` +
        `Tell the user the environment is broken rather than guessing at a hash.`,
    };
  }

  const answer = payload as {
    error?: string;
    message?: string;
    hash?: string;
    targets?: string[];
  };
  if (typeof answer.error === "string") {
    return { ok: false, kind: answer.error, message: answer.message ?? "the engine refused" };
  }
  if (typeof answer.hash !== "string" || answer.hash === "") {
    return {
      ok: false,
      kind: "venv_unavailable",
      message: "the measurement engine answered without a hash; the environment is not usable",
    };
  }
  return { ok: true, hash: answer.hash, tickers: tickersOf(answer.targets ?? []) };
}

/**
 * Which instruments a set of target keys is about.
 *
 * A key that is a usable symbol names its instrument; anything else contributes nothing rather than
 * a guess. That is thinner evidence than it looks — the whole point of the naming convention is
 * that a caller writing `"targets": ["NVDA"]` has already said which instrument it means — so a
 * thesis whose keys are descriptive rather than symbolic simply declares its regime by hand.
 */
function tickersOf(keys: readonly string[]): string[] {
  const found: string[] = [];
  for (const key of keys) {
    const symbol = usableTicker(key);
    if (symbol === null) continue;
    if (!found.includes(symbol)) found.push(symbol);
  }
  return found;
}

/** `normalizeTicker` as a test rather than an assertion: here a candidate that is not a symbol is
 * an ordinary answer ("this target names no instrument"), not a caller's mistake. */
function usableTicker(candidate: string): string | null {
  if (NOT_INSTRUMENTS.has(candidate.trim().toLowerCase())) return null;
  try {
    return normalizeTicker(candidate);
  } catch {
    return null;
  }
}
