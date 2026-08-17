#!/usr/bin/env bun
/**
 * Build the distributable: one file that carries everything it needs to start.
 *
 * What goes in is a closed ecosystem: after this, the machine that RUNS the binary needs nothing
 * installed. The measurement engine is built as a wheel here rather than shipped as source, so the
 * binary installs a fixed artifact instead of depending on a checkout being present and intact. A
 * constraints file is compiled beside it so the first-run PyPI install resolves to the same versions
 * on every machine and every day, which is the difference between "it needs the network once" and
 * "it needs the network and some luck". The chart library rides along so a published report renders
 * with no network at all. And THREE EXECUTABLES are sealed in: the Claude Code CLI, opencode, and
 * this machine's own `uv`, which is what lets the binary provision a measurement environment on a
 * host that has never heard of Python packaging.
 *
 * The one thing a closed ecosystem does not close is the first venv provision, which still reaches
 * PyPI. Embedding per-platform wheels for numba, scipy, numpy and pandas would triple the binary to
 * save a one-time wait, and pretending otherwise would be the dishonest half of the claim.
 *
 * The build is for the machine it runs on, and cross-compiling is deliberately not offered. What
 * goes in is host-shaped in four places now: the Claude Code executable is one platform binary out
 * of eight, opencode is one of twelve — sorted by libc AND by whether this CPU has AVX2 — the
 * embedded uv is literally this machine's, and the engine's constraints are resolved by the
 * interpreter that will run them. A macOS host emitting a Linux target would get all four wrong, and
 * every failure would appear at first run, on someone else's machine. Building on the target is not
 * a limitation of this script — it is why `git pull && bun run install:cli` is a complete update on
 * every platform, and why rebuilding is how an installation catches up with new dependency
 * versions.
 *
 * With `--install [dir]` the finished binary is also placed on `$PATH` (default `~/.local/bin`, or
 * `$YEWREVIEW_BIN_DIR`). It is COPIED rather than symlinked: an installed command that points into
 * a checkout stops working the day the checkout is moved, renamed or cleaned, and it would do so
 * long after anyone remembers wiring the two together.
 */

import { $ } from "bun";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";

import {
  claudeBinaryName,
  claudePackageCandidates,
  describeHost,
  hostTriple,
} from "../src/resources/claudePlatform.ts";
import {
  describeOpencodeHost,
  opencodeBinaryPath,
  opencodeHost,
  opencodePackageCandidates,
} from "../src/resources/opencodePlatform.ts";

const root = resolve(import.meta.dir, "..");
const buildDir = join(root, "build/resources");
const wheelShim = join(root, "src/resources/seikanWheel.ts");
const claudeShim = join(root, "src/resources/claudeBinary.ts");
const opencodeShim = join(root, "src/resources/opencodeBinary.ts");
const uvShim = join(root, "src/resources/uvBinary.ts");
const outFile = join(root, "dist/yewreview");

function log(step: string): void {
  console.log(`\n\x1b[1m${step}\x1b[0m`);
}

/**
 * The committed text of every module this build has swapped out, and putting it back.
 *
 * A `finally` alone is not enough, and the gap is not theoretical: the compile is the long step, so
 * it is the one that gets interrupted, and a Ctrl-C there kills this process without unwinding. What
 * would be left behind is two TRACKED files holding a rewritten form — no `.gitignore` rule can
 * cover a tracked file — and neither of them looks wrong afterwards. The rewritten `claudeBinary.ts`
 * typechecks and runs perfectly well on the machine that made it, so the next `git commit -a`
 * quietly re-hardcodes the single platform this build exists to stop hardcoding, and the failure is
 * somebody else's, on a machine nobody here can see.
 *
 * `splice` empties the list as it restores, so the handler and the `finally` can both run and the
 * second is a no-op.
 */
const swapped: { path: string; stub: string }[] = [];

function restoreShims(): void {
  for (const { path, stub } of swapped.splice(0)) writeFileSync(path, stub);
}

/** The first line of every form this script writes, so a rewritten module can be recognised as one
 * by the next build. Both templates below are built from it rather than repeating the sentence. */
const REWRITTEN = "// Rewritten by scripts/build.ts for this compile;";
const REWRITTEN_HEADER = `${REWRITTEN} the committed stub returns immediately after.\n`;

/**
 * The committed text of a shim, refusing to proceed if what is on disk is a rewritten form.
 *
 * The handlers above cover every interrupt that can be caught, but SIGKILL and a power cut cannot be,
 * and this is what stops that residue from becoming permanent. Without the check the next build would
 * take the rewritten form to BE the stub, put it back faithfully after compiling, and leave a
 * checkout that is now wrong in a way no later build repairs — silently, since the leftover
 * typechecks and runs perfectly on the machine that made it. Refusing costs one `git checkout`;
 * the alternative costs someone the platform independence this script exists to provide.
 */
function readStub(path: string): string {
  const text = readFileSync(path, "utf8");
  if (text.startsWith(REWRITTEN)) {
    throw new Error(
      `${relative(root, path)} holds the form a build writes, not the committed one — an earlier ` +
        `build was killed before it could put the stub back. Taking this as the stub would make that ` +
        `permanent, so it is refused: run \`git checkout -- ${relative(root, path)}\` and build again.`,
    );
  }
  return text;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    restoreShims();
    // 128 + the signal number, the convention a shell reads back — and an exit rather than a
    // rethrow, because the point is to be gone as quickly as the checkout is safe.
    process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
  });
}

// Refused here rather than at first run. Windows has neither of the two sandboxes the agent's shell
// stands behind — Seatbelt on macOS, bubblewrap on Linux — so a binary would compile, install, start,
// and then decline every command the agent tried to run. Handing someone that is worse than handing
// them a build that stopped and said why. WSL2 is a Linux host and builds like one.
if (process.platform === "win32") {
  throw new Error(
    "yewreview needs an OS sandbox to confine the agent's shell, and Windows has neither of the two " +
      "it knows (macOS Seatbelt, Linux bubblewrap). Build and run inside WSL2 instead.",
  );
}

/**
 * Where `--install` will put the binary, resolved and tested for writability BEFORE the build.
 *
 * The destination is the one part of an install that depends on this machine's permissions, and
 * `/usr/local/bin` — which the README offers as the example of installing elsewhere — is root-owned
 * on stock macOS and on most Linux distributions. `mkdirSync` on a directory that already exists
 * succeeds whether or not it can be written to, so the first thing that would actually fail is the
 * copy, several minutes and one 300-megabyte artifact later, as a raw EACCES. Everything that can be
 * known at the start is checked at the start.
 */
const installFlag = Bun.argv.indexOf("--install");
const installArg = Bun.argv[installFlag + 1];
const installDir =
  installFlag === -1
    ? null
    : resolve(
        // A token beginning with `-` is another flag rather than a path: `--install --help` should
        // not silently create a directory named `--help` and report success.
        (installArg?.startsWith("-") === false ? installArg : undefined) ??
          process.env["YEWREVIEW_BIN_DIR"] ??
          join(homedir(), ".local/bin"),
      );
if (installDir !== null) {
  try {
    mkdirSync(installDir, { recursive: true });
    accessSync(installDir, constants.W_OK);
  } catch {
    throw new Error(
      `${installDir} cannot be written to by this user, so a build would have nowhere to go. Pick a ` +
        `directory you own — \`bun run install:cli ~/.local/bin\` — or set YEWREVIEW_BIN_DIR to one.`,
    );
  }
}

// Read now rather than at step 4, for the same reason the destination above is checked now: a
// checkout an interrupted build left rewritten is knowable in the first second, and a refusal is
// worth more there than after a wheel has been built.
const wheelStub = readStub(wheelShim);
const claudeStub = readStub(claudeShim);
const opencodeStub = readStub(opencodeShim);
const uvStub = readStub(uvShim);

// uv is checked at the start for the reason the install directory is: it builds the wheel below, it
// pins the constraints, and its own bytes are embedded — three failures several minutes apart if it
// turns out to be missing. The path is captured rather than re-resolved so the uv that BUILT the
// engine is byte-for-byte the uv that ships with it.
const uvPath = Bun.which("uv");
if (uvPath === null) {
  throw new Error(
    "uv is required to build: it builds the engine's wheel, pins its constraints, and its own " +
      "binary is embedded so the compiled yewreview can provision a measurement environment on a " +
      "machine that has no uv. Install it from https://docs.astral.sh/uv/ and build again.",
  );
}

log("1/5  building the seikan wheel");
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
await $`${uvPath} build --wheel ${join(root, "vendor/seikan")} -o ${buildDir}`.quiet();
const wheel = readdirSync(buildDir).find((f) => f.endsWith(".whl"));
if (!wheel) throw new Error(`uv build produced no wheel in ${buildDir}`);
console.log(`     ${wheel}`);

log("2/5  pinning the engine's dependencies");
// Compiled against the wheel itself, so the pins are exactly what the engine declares plus the two
// libraries the agent's own scripts are entitled to find (a script reaching for pandas and not
// finding it is a failure the agent cannot fix from inside the sandbox).
const requirementsIn = join(buildDir, "requirements.in");
await Bun.write(requirementsIn, `${join(buildDir, wheel)}\npandas\nrequests\n`);
let haveRequirements = false;
try {
  // `--no-emit-package seikan` keeps the engine OUT of its own constraints file. Resolution still
  // runs against the wheel, so the pins below it are the ones the engine actually requires — but
  // emitting it would write a `file:///…` line naming this build machine's disk, and uv refuses an
  // unnamed requirement as a constraint anyway. The install names the wheel explicitly; the
  // constraints exist to pin what it drags in.
  await $`${uvPath} pip compile ${requirementsIn} --python-version 3.13 --no-emit-package seikan --output-file ${join(buildDir, "requirements.txt")} --quiet`.quiet();
  haveRequirements = true;
  console.log("     requirements.txt");
} catch {
  // A lockfile is an improvement, not a requirement: without one the install resolves fresh, which
  // is what every pip install does anyway. Failing the build over it would be disproportionate.
  console.log("     (skipped — uv pip compile failed; first-run install will resolve fresh)");
}

log("3/5  choosing the executables for this host");
// Looked up BEFORE anything is rewritten, because this is the one input the build cannot substitute
// for and finding out afterwards would leave the checkout holding a rewritten module. The SDK ships
// the executable as one package per platform; `claudePlatform.ts` says which could be this one, in
// the order the machine's own libc puts them — first INSTALLED is not the same question as first
// correct, and on Linux both packages can be sitting there.
const host = hostTriple();
const binName = claudeBinaryName(host.platform);
const candidates = claudePackageCandidates(host);
const claudePkg = candidates.find((pkg) => existsSync(join(root, "node_modules", pkg, binName)));
if (!claudePkg) {
  throw new Error(
    candidates.length === 0
      ? `The Claude Agent SDK publishes no executable for ${describeHost(host)}, so there is nothing ` +
        `to embed. A binary built here could not run its own agent.`
      : `No Claude Code executable for ${describeHost(host)} in node_modules — looked for ` +
        `${candidates.map((pkg) => `${pkg}/${binName}`).join(" and ")}. Run \`bun install\` first.`,
  );
}
console.log(`     ${claudePkg}`);

// The same question for opencode, which publishes twelve packages rather than eight: two libcs and,
// on x64, an AVX2 build beside a `-baseline` one for CPUs without it. Running a non-baseline build
// on a machine that lacks AVX2 is an illegal instruction at startup, so the flag is asked directly
// rather than assumed — see `opencodePlatform.ts`.
const oHost = opencodeHost();
const oRel = opencodeBinaryPath(oHost.platform);
const oCandidates = opencodePackageCandidates(oHost);
const opencodePkg = oCandidates.find((pkg) => existsSync(join(root, "node_modules", pkg, oRel)));
if (!opencodePkg) {
  throw new Error(
    oCandidates.length === 0
      ? `opencode publishes no executable for ${describeOpencodeHost(oHost)}, so there is nothing ` +
        `to embed. A binary built here could not offer that harness.`
      : `No opencode executable for ${describeOpencodeHost(oHost)} in node_modules — looked for ` +
        `${oCandidates.map((pkg) => `${pkg}/${oRel}`).join(" and ")}. Run \`bun install\` first.`,
  );
}
console.log(`     ${opencodePkg}`);

// And uv, which is not a package choice but a copy of the one that just built the wheel.
// `copyFileSync` follows symlinks, so what lands here is the real executable rather than a link into
// a Homebrew cellar that the compiled binary would have no way to follow.
const uvVersion = (await $`${uvPath} --version`.text()).trim();
copyFileSync(uvPath, join(buildDir, "uv.bin"));
console.log(`     ${uvVersion} — ${uvPath}`);

log("4/5  wiring them into the bundle");
// All four modules ship a committed stub that names no build product — two returning null, two
// resolving out of node_modules — so a dev run works and `tsc` is honest in both modes. Here each is
// swapped for the static import that makes `--compile` embed the bytes, and all four are restored
// below, so the checkout is never left holding an import of a file that only exists mid-build.
swapped.push({ path: wheelShim, stub: wheelStub });
swapped.push({ path: claudeShim, stub: claudeStub });
swapped.push({ path: opencodeShim, stub: opencodeStub });
swapped.push({ path: uvShim, stub: uvStub });
try {
  await Bun.write(
    wheelShim,
    REWRITTEN_HEADER +
      `import wheel from "../../build/resources/${wheel}" with { type: "file" };\n` +
      (haveRequirements
        ? `import req from "../../build/resources/requirements.txt" with { type: "file" };\n` +
          `export const requirements: string | null = req;\n`
        : `export const requirements: string | null = null;\n`) +
      // The name travels separately because it is load-bearing: a wheel filename encodes the
      // package, the version and the compatibility tags, and pip reads it. Whatever path the
      // bundle hands back at runtime, the file has to be put somewhere still called this.
      `export const wheelName: string | null = ${JSON.stringify(wheel)};\n` +
      `export default wheel as string | null;\n`,
  );
  await Bun.write(
    claudeShim,
    REWRITTEN_HEADER +
      `import embedded from ${JSON.stringify(`${claudePkg}/${binName}`)} with { type: "file" };\n` +
      `export function claudeBinary(): string {\n  return embedded;\n}\n`,
  );
  await Bun.write(
    opencodeShim,
    REWRITTEN_HEADER +
      `import embedded from ${JSON.stringify(`${opencodePkg}/${oRel}`)} with { type: "file" };\n` +
      `export function opencodeBinary(): string {\n  return embedded;\n}\n`,
  );
  await Bun.write(
    uvShim,
    REWRITTEN_HEADER +
      `import embedded from "../../build/resources/uv.bin" with { type: "file" };\n` +
      `export default embedded as string | null;\n`,
  );

  log("5/5  compiling");
  mkdirSync(join(root, "dist"), { recursive: true });
  await $`bun build --compile --minify ${join(root, "src/main.ts")} --outfile ${outFile}`;
} finally {
  // Restored even when the compile fails: leaving the rewritten forms behind would make the next dev
  // run import a wheel that a later `rm -rf build/` deletes out from under it, and pin the agent to
  // whichever platform's executable this machine happened to be.
  restoreShims();
}

if (!existsSync(outFile)) throw new Error("bun build --compile produced no binary");
const size = Bun.file(outFile).size;
console.log(`\n\x1b[32m✓\x1b[0m dist/yewreview — ${(size / 1024 / 1024).toFixed(1)} MB`);

if (installDir === null) {
  console.log(`  smoke test:  dist/yewreview claudecode --no-browser --var-dir /tmp/yewreview-check`);
  console.log(`  install:     bun run install:cli\n`);
} else {
  const dest = join(installDir, "yewreview");
  // Copied to a neighbour and renamed over the target rather than written in place: replacing the
  // bytes of a binary that is currently RUNNING is how a live process gets a different program's
  // instructions paged in under it. A rename swaps the name and leaves the open file alone.
  const staging = `${dest}.${process.pid}.tmp`;
  try {
    copyFileSync(outFile, staging);
    chmodSync(staging, 0o755);
    renameSync(staging, dest);
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
  console.log(`\x1b[32m✓\x1b[0m installed — ${dest}`);

  // Worth checking rather than assuming: a binary in a directory the shell never searches is the
  // one failure mode of this step, and it presents as "command not found" with no clue attached.
  const onPath = (process.env["PATH"] ?? "").split(delimiter).some((entry) => entry && resolve(entry) === installDir);
  if (onPath) {
    console.log(`\n  run it from anywhere:  yewreview\n`);
  } else {
    console.log(`\nnote: ${installDir} is not on your PATH. Add it to your shell profile:`);
    console.log(`  export PATH="${installDir}:$PATH"\n`);
  }
}
