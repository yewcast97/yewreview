/**
 * The sandbox Python environment: where the measurement engine lives, and the one place the agent
 * may run Python.
 *
 * YewReview itself never imports or executes seikan. It provisions a virtual environment, installs the
 * engine into it READ-ONLY, and then only ever spawns it — `seikan run`, `seikan check-data`,
 * `seikan schema` — as a subprocess. The agent does the same through sandboxed Bash. That means
 * the engine's version, its numba cache and its strict `SEIKAN_*` namespace are all properties of
 * a directory rather than of this process, and a broken environment degrades YewReview instead of
 * killing it.
 *
 * Which is the second decision worth stating: provisioning failure is NOT fatal. Making the engine a
 * hard startup requirement would be right if every capability the agent had ran through it, but the
 * engine is one capability among many: an agent that cannot measure a thesis can still research,
 * write and publish a report, and it can say honestly that measurement is unavailable. Refusing to
 * start would take the other ninety percent away to punish the ten.
 *
 * The honest cost, stated where a reader meets it: the engine's dependencies (numba, scipy, numpy,
 * pandas) come from PyPI on first provision, along with the handful of libraries the agent's own
 * scripts are entitled to — see `EXTRAS`. That needs network and takes minutes. Embedding
 * per-platform wheels for all of them would triple the binary to save a one-time wait.
 *
 * What the binary DOES carry is uv itself, which is why everything below runs through exactly one
 * tool rather than a ladder of fallbacks. The machine requirement is gone; the network one is not,
 * and pretending otherwise would be the dishonest half of a closed ecosystem. Note that the
 * fingerprint below does not cover uv's version: uv is the installer, not the installed artefact,
 * and reprovisioning every installation because the build machine upgraded uv would be a rebuild
 * with nothing behind it.
 */

import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Settings } from "../config.ts";
import { paths } from "../config.ts";

export type VenvStatus = {
  ready: boolean;
  /** Absolute path to the venv's python, present once the venv itself exists. */
  python: string | null;
  /** Absolute path to the venv's `seikan` CLI, present once it is installed and answering. */
  seikanBin: string | null;
  seikanVersion: string | null;
  /** The engine's own DSL guide, read out of the installed package for the system prompt. */
  dslGuide: string | null;
  error: string | null;
};

export type ProvisionInput = {
  /**
   * The `uv` every operation below runs, absolute.
   *
   * Passed in rather than searched for, because in a compiled binary it is not on PATH at all: it
   * was extracted out of the bundle into `var/bin`. A dev checkout hands over whatever `Bun.which`
   * found. Null means neither — the one shape of this that degrades rather than throws.
   */
  uv: string | null;
  /** The seikan wheel to install. In dev mode this is the source tree instead. */
  wheel: string;
  /** A pinned requirements file for the engine's dependencies, when one was built. */
  requirements?: string | undefined;
  /** True when `wheel` is a source directory to install editable (dev mode). */
  editable?: boolean;
};

const MARKER = ".yewreview-provision.json";
const MIN_PYTHON = [3, 13] as const;

type Marker = {
  wheel_fingerprint: string;
  python_version: string;
  seikan_version: string;
};

function unavailable(error: string): VenvStatus {
  return { ready: false, python: null, seikanBin: null, seikanVersion: null, dslGuide: null, error };
}

async function run(
  cmd: string[],
  opts: { cwd?: string } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  // The environment is inherited as-is: `main.ts` scrubbed `SEIKAN_*` before anything read it, and
  // the engine refuses to construct when it meets a variable under that prefix it does not
  // declare — so a subprocess started here would fail as `thresholds_invalid` if that had not
  // already happened.
  // Spread rather than passed as `cwd: opts.cwd`: Bun's own option is "a directory or nothing at
  // all", and handing it an explicit `undefined` is a third thing its type does not describe.
  const proc = Bun.spawn(cmd, {
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr };
}

/** Does this interpreter exist and satisfy the engine's floor? Returns its version, or null. */
async function probePython(candidate: string): Promise<string | null> {
  const res = await run([
    candidate,
    "-c",
    "import sys; print('%d.%d.%d' % sys.version_info[:3])",
  ]).catch(() => null);
  if (!res?.ok) return null;
  const version = res.stdout.trim();
  const [major = 0, minor = 0] = version.split(".").map((n) => Number.parseInt(n, 10));
  if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) return version;
  return null;
}

/**
 * Create the venv if it is absent.
 *
 * ONE PATH, through uv, because uv is now always here: a compiled binary carries a copy and a
 * checkout that can build the engine's wheel already has one. What that removes is the ladder this
 * used to be — `python -m venv`, then `python3.13`, then `python3` — every rung of which existed to
 * survive uv being missing, and each of which produced a different environment from the others.
 *
 * uv is also the only one of them that can DOWNLOAD an interpreter, which matters more than it
 * sounds: the engine needs Python 3.13, and a Mac shipping 3.9 at `/usr/bin/python3` is the common
 * case rather than the exotic one. The old fallbacks turned that into "no suitable python found" on
 * exactly the machines least able to do anything about it.
 *
 * `YEWREVIEW_PYTHON` survives as the one argument to that one path. It is probed first only so the
 * refusal can name the variable — `uv venv --python /nonsense` reports its own way, which is fine
 * and says nothing about where the value came from.
 */
async function ensureVenv(settings: Settings, venvDir: string, uv: string): Promise<string> {
  const venvPython = join(venvDir, "bin", "python");
  if (existsSync(venvPython)) return venvPython;

  if (settings.python) {
    const version = await probePython(settings.python);
    if (!version) {
      throw new Error(
        `YEWREVIEW_PYTHON points at ${settings.python}, which is not a Python ` +
          `${MIN_PYTHON.join(".")}+ interpreter (the measurement engine requires it)`,
      );
    }
  }

  const res = await run([uv, "venv", "--python", settings.python ?? MIN_PYTHON.join("."), venvDir]);
  if (!res.ok) {
    throw new Error(`uv could not create the venv: ${res.stderr.trim().slice(-800)}`);
  }
  return venvPython;
}

/**
 * The libraries the agent's scripts are entitled to expect, beside the engine itself.
 *
 * Three, and each earns its place by being something every fetcher needs: `requests` to go and get
 * the data, `pandas` to shape it, and `pydantic` to say what shape it was supposed to arrive in. The
 * third is the newest and the least obvious, so the argument is written down: a script that fetches
 * JSON from a filing endpoint and slices it straight into a frame will happily carry a renamed field
 * or a string where a number was into a CSV, and the engine will measure it. A model the payload is
 * parsed through turns that into a traceback at the point the data was wrong, which is the only place
 * anybody can act on it. `src/claudecode/prompts/system.md` makes it a rule rather than an option.
 *
 * A MODULE CONSTANT because `fingerprint` reads it too — see the note there. Two copies of this list
 * would mean a library added here that no existing installation ever gets.
 */
const EXTRAS = ["pandas", "requests", "pydantic>=2"];

/** Install (or reinstall) the engine and the libraries the agent's scripts are entitled to expect. */
async function installEngine(
  uv: string,
  venvPython: string,
  input: ProvisionInput,
): Promise<void> {
  const target = input.editable ? ["--editable", input.wheel] : [input.wheel];
  // The engine's own constraint file still governs resolution below, so a version seikan pins wins
  // over anything asked for here — which is what keeps these from quietly upgrading a dependency the
  // engine was built against.
  const extras = EXTRAS;
  const cmd = [uv, "pip", "install", "--python", venvPython, ...target, ...extras];
  if (input.requirements && existsSync(input.requirements)) {
    cmd.push("--constraint", input.requirements);
  }
  const res = await run(cmd);
  if (!res.ok) {
    throw new Error(
      `installing the measurement engine failed. Run it by hand to see why:\n  ` +
        `${cmd.join(" ")}\n${res.stderr.trim().slice(-1500)}`,
    );
  }
}

/**
 * Make the installed engine read-only.
 *
 * Two layers, because they fail differently. The sandbox policy denies writes under `var/venv/**`
 * and is enforced by the OS on every process the agent's Bash starts — that is the guarantee. The
 * `chmod` is defense in depth for the case the sandbox is unavailable and a user has chosen to run
 * anyway: it stops an accident, not an adversary.
 */
function lockEngine(venvDir: string): void {
  const libRoot = join(venvDir, "lib");
  if (!existsSync(libRoot)) return;
  for (const pyDir of readdirSync(libRoot)) {
    const sitePackages = join(libRoot, pyDir, "site-packages");
    if (!existsSync(sitePackages)) continue;
    for (const entry of readdirSync(sitePackages)) {
      if (!entry.startsWith("seikan")) continue;
      chmodReadOnly(join(sitePackages, entry));
    }
  }
}

/**
 * Files only. Directories stay writable, and that is a decision rather than an oversight.
 *
 * A read-only directory does buy a little more: nothing can unlink a module and drop a different
 * one in its place. But it also makes `rm -rf var/` fail for the person who owns the data, which
 * is an ordinary thing to want to do and a miserable thing to be refused — and it is refused with
 * a wall of permission errors that say nothing about which subsystem set them. Since the OS
 * sandbox's `denyWrite` is the actual guarantee here and this pass is only defence in depth
 * against an accident, it is not worth taking someone's `rm -rf` away to catch an accident that
 * has to unlink a file first.
 */
function chmodReadOnly(path: string): void {
  try {
    const st = statSync(path);
    if (st.isDirectory()) {
      for (const child of readdirSync(path)) chmodReadOnly(join(path, child));
      return;
    }
    chmodSync(path, 0o444);
  } catch {
    // A file we cannot stat or chmod is not a reason to fail the boot; the sandbox denyWrite is
    // the guarantee and it does not depend on this succeeding.
  }
}

function chmodWritable(path: string): void {
  try {
    const st = statSync(path);
    chmodSync(path, st.isDirectory() ? 0o755 : 0o644);
    if (st.isDirectory()) {
      for (const child of readdirSync(path)) chmodWritable(join(path, child));
    }
  } catch {
    /* see chmodReadOnly */
  }
}

function unlockEngine(venvDir: string): void {
  const libRoot = join(venvDir, "lib");
  if (!existsSync(libRoot)) return;
  for (const pyDir of readdirSync(libRoot)) {
    const sitePackages = join(libRoot, pyDir, "site-packages");
    if (!existsSync(sitePackages)) continue;
    for (const entry of readdirSync(sitePackages)) {
      if (entry.startsWith("seikan")) chmodWritable(join(sitePackages, entry));
    }
  }
}

/**
 * A fingerprint of what should be installed, so a change to it triggers a reinstall and an unchanged
 * one does not.
 *
 * IT COVERS THE EXTRAS AND NOT ONLY THE WHEEL, which is what makes adding a library to `EXTRAS`
 * safe. The marker is what decides whether `provision` does anything at all, so a fingerprint that
 * hashed the engine alone would leave every EXISTING installation without the added library — and
 * the symptom would not be an install error, it would be the agent's next script failing on an
 * import nobody could explain from this file. The wheel's own digest still dominates; the extras are
 * appended so the pair is the whole of what was asked for.
 */
async function fingerprint(input: ProvisionInput): Promise<string> {
  const extras = `extras:${EXTRAS.join(",")}`;
  if (input.editable) return `editable:${resolve(input.wheel)}|${extras}`;
  const bytes = await Bun.file(input.wheel).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(bytes));
  return `${hasher.digest("hex")}|${extras}`;
}

/**
 * Read the marker, or `null` if there is not a usable one.
 *
 * The SHAPE is checked and not merely the parse. This file decides whether the environment gets
 * reprovisioned, and it decides it by comparing `wheel_fingerprint` — so a marker that parsed but
 * carries the wrong type there (a truncated write, a hand-edit, a file from another tool) would
 * compare unequal to every fingerprint and reinstall on every start, or worse compare equal by
 * accident and skip an install that was needed. Treating an unreadable marker as absent is the
 * honest reading: no marker and a malformed marker mean the same thing, which is that nothing here
 * knows what is installed.
 */
function readMarker(venvDir: string): Marker | null {
  const path = join(venvDir, MARKER);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const marker = parsed as Record<string, unknown>;
    if (
      typeof marker["wheel_fingerprint"] !== "string" ||
      typeof marker["python_version"] !== "string" ||
      typeof marker["seikan_version"] !== "string"
    ) {
      return null;
    }
    return {
      wheel_fingerprint: marker["wheel_fingerprint"],
      python_version: marker["python_version"],
      seikan_version: marker["seikan_version"],
    };
  } catch {
    return null;
  }
}

/**
 * What an installed engine can honestly claim, asked of the directory and touching nothing.
 *
 * The verification half of `provisionVenv`, factored so `probeVenv` can run it without the install
 * half. The smoke test IS the readiness criterion: an engine that cannot print its own schema
 * cannot run a thesis either, and finding that out here beats finding it out mid-conversation. A
 * missing version or guide degrades to null rather than failing — the engine still measures.
 */
async function verifyEngine(
  venvDir: string,
  venvPython: string,
  seikanBin: string,
): Promise<{ ok: true; status: VenvStatus; pythonVersion: string } | { ok: false; status: VenvStatus }> {
  const schema = await run([seikanBin, "schema"]);
  if (!schema.ok) {
    return {
      ok: false,
      status: unavailable(`'seikan schema' failed in ${venvDir}: ${schema.stderr.trim().slice(-800)}`),
    };
  }

  const version = await run([venvPython, "-c", "import seikan; print(seikan.__version__)"]);
  const seikanVersion = version.ok ? version.stdout.trim() : null;
  const pythonVersion = await run([
    venvPython,
    "-c",
    "import sys; print('%d.%d.%d' % sys.version_info[:3])",
  ]);

  // The engine ships its own DSL guide as package data. Reading it from the INSTALLED package is
  // what keeps the agent's instructions from drifting away from the engine they describe.
  const guide = await run([
    venvPython,
    "-c",
    "import importlib.resources as r; print((r.files('seikan')/'reference'/'dsl-schema.md').read_text())",
  ]);

  return {
    ok: true,
    pythonVersion: pythonVersion.stdout.trim(),
    status: {
      ready: true,
      python: venvPython,
      seikanBin,
      seikanVersion,
      dslGuide: guide.ok ? guide.stdout : null,
      error: null,
    },
  };
}

/**
 * Bring the sandbox environment up, and report what a caller may honestly claim about it.
 *
 * Idempotent: a marker file records the fingerprint of what was installed, so an unchanged build
 * reprovisions nothing and a new one reinstalls the engine only.
 */
export async function provisionVenv(
  settings: Settings,
  input: ProvisionInput,
): Promise<VenvStatus> {
  const { venvDir } = paths(settings);
  try {
    if (input.uv === null) {
      return unavailable(
        "uv was not found on PATH, and this build carries none — a dev checkout needs uv installed " +
          "(https://docs.astral.sh/uv/). The compiled binary embeds its own.",
      );
    }
    const venvPython = await ensureVenv(settings, venvDir, input.uv);
    const want = await fingerprint(input);
    const marker = readMarker(venvDir);

    if (!marker || marker.wheel_fingerprint !== want) {
      unlockEngine(venvDir); // a reinstall has to be able to replace what we made read-only
      await installEngine(input.uv, venvPython, input);
      lockEngine(venvDir);
    }

    const seikanBin = join(venvDir, "bin", "seikan");
    if (!existsSync(seikanBin)) {
      return unavailable(
        `the engine installed but left no 'seikan' command in ${venvDir}/bin — the environment ` +
          `is not usable for measurement`,
      );
    }

    const checked = await verifyEngine(venvDir, venvPython, seikanBin);
    if (!checked.ok) return checked.status;

    writeFileSync(
      join(venvDir, MARKER),
      JSON.stringify(
        {
          wheel_fingerprint: want,
          python_version: checked.pythonVersion,
          seikan_version: checked.status.seikanVersion ?? "unknown",
        } satisfies Marker,
        null,
        2,
      ),
    );

    return checked.status;
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err));
  }
}

/**
 * What the venv can honestly claim, touching nothing: the read-only process's path (`db/lock.ts`).
 *
 * Provisioning belongs to the writer — it installs, chmods, and rewrites the marker on every run —
 * so a reader asks the directory what is already there and claims no more. No fingerprint compare
 * and no marker write: whether the installed engine matches this build's wheel is the writer's
 * question, and a reader second-guessing it would be a reader with an opinion about files it must
 * not touch.
 */
export async function probeVenv(settings: Settings): Promise<VenvStatus> {
  const { venvDir } = paths(settings);
  const venvPython = join(venvDir, "bin", "python");
  const seikanBin = join(venvDir, "bin", "seikan");
  if (!existsSync(venvPython) || !existsSync(seikanBin)) {
    return unavailable(
      "the measurement engine is not installed in this var root yet, and this read-only process " +
        "will not install it — the writing process provisions the venv.",
    );
  }
  try {
    const checked = await verifyEngine(venvDir, venvPython, seikanBin);
    return checked.status;
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err));
  }
}
