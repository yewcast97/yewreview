/**
 * Things YewReview ships INSIDE itself, and how they get back onto a real filesystem.
 *
 * A compiled binary carries its resources in Bun's virtual filesystem, where nothing outside the
 * process can open them — but a Python interpreter must read the engine wheel, a browser must fetch
 * the chart library, and the operating system must exec a binary to spawn it. So each resource is
 * extracted once, named by content: an unchanged build re-extracts nothing, and a new build lands
 * beside the old one instead of racing to overwrite it while it is being served or paged in.
 *
 * **Data and EXECUTABLES go to different trees, and the split is a security property rather than
 * tidiness.** Data lands in `var/cache/resources/`; `var/cache` is writable by every confined child,
 * because the engine's compiled-kernel cache lives there and a cache the process cannot write is
 * worse than no cache. An executable in a writable tree is an executable the agent can replace and
 * this process then spawns, so the three binaries go to `var/bin/<sha>/` instead — named in no
 * writable set, denied explicitly in the sandbox rules, and given mode 0555 on the way out.
 *
 * WHICH platform binary is a question only the machine can answer, so the Claude CLI and opencode
 * arrive through `claudeBinary.ts` and `opencodeBinary.ts` rather than as imports naming one.
 */

import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { Settings } from "../config.ts";
import { paths } from "../config.ts";

// Imported as files so `bun build --compile` embeds the bytes. In dev these resolve to real paths
// on disk and nothing is copied anywhere.
import echartsAsset from "../../node_modules/echarts/dist/echarts.min.js" with { type: "file" };
import seikanWheel, {
  requirements as seikanRequirements,
  wheelName as seikanWheelName,
} from "./seikanWheel.ts";
import uvEmbedded from "./uvBinary.ts";
// The two executables, behind calls rather than imports: the build rewrites those modules to name
// the host's package, and a dev run reads node_modules instead.
import { claudeBinary } from "./claudeBinary.ts";
import { opencodeBinary } from "./opencodeBinary.ts";

export const ECHARTS_FILENAME = "echarts.min.js";

export type Resources = {
  /**
   * Path to the Claude Code executable the SDK should spawn, or null when this boot will not spawn
   * one.
   *
   * Null on the opencode harness, which is not a missing value but the honest answer: extracting a
   * quarter-gigabyte executable that nothing in this process will ever exec costs disk for nothing,
   * and in a dev checkout it would also FAIL — `claudeBinary()` throws on a machine whose SDK
   * platform package is not installed, which has no business stopping the other harness from
   * booting.
   */
  claudeCli: string | null;
  /** Path to the seikan wheel, or the source tree in dev mode. */
  seikanWheel: string;
  /** True when `seikanWheel` is a source tree to install editable. */
  seikanEditable: boolean;
  /** Pinned dependency constraints for the first-run install, when the build produced them. */
  requirements: string | undefined;
  /** Absolute path to the extracted chart library. */
  echarts: string;
  /**
   * The `uv` every venv operation runs, or null when there is none to be had.
   *
   * Null only in a dev checkout on a machine without uv on PATH — a compiled binary carries its own.
   * Provisioning turns that null into a stated degradation rather than a crash.
   */
  uv: string | null;
};

async function extractFile(file: string, destDir: string, name: string): Promise<string> {
  const dest = join(destDir, name);
  if (existsSync(dest)) return dest;
  mkdirSync(destDir, { recursive: true });
  await Bun.write(dest, Bun.file(file));
  return dest;
}

async function contentDir(root: string, file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(await Bun.file(file).arrayBuffer()));
  return join(root, hasher.digest("hex").slice(0, 16));
}

/**
 * Get an embedded executable onto disk with its exec bit, or pass a real path straight through.
 *
 * The passthrough is what makes `bun run dev` work with no special case anywhere else: outside a
 * compiled binary these paths are already files on disk — in `node_modules`, or wherever an escape
 * hatch points — and copying them would only add a stale second copy.
 *
 * Written to a staging name and RENAMED, because the destination may be a file another process of
 * this installation is currently executing: `Bun.write` onto a running binary is a way to crash it,
 * while a rename swaps the directory entry and leaves the open one alone. Mode 0555 rather than
 * 0755: nothing should ever write here, and the OS sandbox is what enforces that — the mode stops an
 * accident, not an adversary.
 */
export async function extractExecutable(
  file: string,
  binRoot: string,
  name: string,
): Promise<string> {
  if (!file.startsWith("/$bunfs/")) return file;
  const dir = await contentDir(binRoot, file);
  const dest = join(dir, name);
  if (existsSync(dest)) return dest;
  mkdirSync(dir, { recursive: true });
  const staging = `${dest}.${process.pid}.tmp`;
  await Bun.write(staging, Bun.file(file));
  chmodSync(staging, 0o555);
  renameSync(staging, dest);
  return dest;
}

/**
 * Put every embedded resource where the rest of the system expects to find it.
 *
 * In dev mode the wheel does not exist and the source tree is used instead, installed editable so
 * an engine edit does not need a wheel rebuild — the marker in `venv.ts` records which of the two
 * it was, so switching between them reprovisions exactly once.
 */
export async function extractResources(
  settings: Settings,
  opts: { serveAssets?: boolean } = {},
): Promise<Resources> {
  const p = paths(settings);

  // Gated on the harness, and read escape-hatch FIRST. The ordering is the whole of the hatch's
  // usefulness: an installed `claude` is the answer for a machine the SDK ships nothing for, and
  // looking for the bundled one before honouring the setting would fail before the setting could be
  // consulted. opencode's counterpart is extracted lazily by its probe, for the same reason in
  // reverse — only that harness's boot should pay for it.
  const claudeCli =
    settings.harness === "claudecode"
      ? (settings.claudeCli ?? (await extractExecutable(claudeBinary(), p.binDir, "claude")))
      : null;

  const uv =
    settings.uv ??
    (uvEmbedded === null ? Bun.which("uv") : await extractExecutable(uvEmbedded, p.binDir, "uv"));

  const echartsDir = await contentDir(p.resourcesDir, echartsAsset);
  const echarts = await extractFile(echartsAsset, echartsDir, ECHARTS_FILENAME);

  // The published pages read the library from one stable location beside the reports, so a report
  // written last month still renders after a chart-library upgrade lands a new content directory.
  // Skipped by a read-only process (`serveAssets: false`, see `db/lock.ts`): this write is
  // unconditional and not staged, so a reader from a DIFFERENT build would replace the library
  // under the writer while a published page is loading it. On a functioning root the writer has
  // already put it there, and `served` names the same place either way.
  const served = join(p.reportAssetsDir, ECHARTS_FILENAME);
  if (opts.serveAssets !== false) {
    mkdirSync(p.reportAssetsDir, { recursive: true });
    await Bun.write(served, Bun.file(echarts));
  }

  const engine = await locateSeikan(p.resourcesDir);

  return {
    claudeCli,
    seikanWheel: engine.path,
    seikanEditable: engine.editable,
    requirements: engine.requirements,
    echarts: served,
    uv,
  };
}

/**
 * The opencode executable, extracted on demand.
 *
 * Separate from `extractResources` and called only by that harness's probe, because it is 143 MB
 * that a claudecode boot has no use for. Same escape-hatch-first ordering as its neighbour.
 */
export async function opencodeCli(settings: Settings): Promise<string> {
  if (settings.opencodeCli !== undefined) return settings.opencodeCli;
  return extractExecutable(opencodeBinary(), paths(settings).binDir, "opencode");
}

/**
 * Where is the engine to install from?
 *
 * A compiled build carries a wheel, wired in by `scripts/build.ts` through `seikanWheel.ts`; a dev
 * checkout has only the source tree, which is installed EDITABLE so an engine edit is visible
 * without rebuilding a wheel first.
 */
async function locateSeikan(
  resourcesDir: string,
): Promise<{ path: string; editable: boolean; requirements: string | undefined }> {
  if (!seikanWheel) {
    return { path: join(import.meta.dir, "../../vendor/seikan"), editable: true, requirements: undefined };
  }
  // The constraints file has to reach a real path too: pip opens it like any other file.
  const requirements = seikanRequirements
    ? await extractFile(seikanRequirements, resourcesDir, "requirements.txt")
    : undefined;
  // Extracted under its REAL filename, because a wheel's filename is structured data rather than a
  // label. pip parses `name-version-python-abi-platform.whl`, so an extra segment reads as a
  // malformed build tag and the install refuses before it has looked inside the file.
  const named = seikanWheelName ?? "seikan.whl";
  const path = await extractFile(seikanWheel, resourcesDir, named);
  return { path, editable: false, requirements };
}
