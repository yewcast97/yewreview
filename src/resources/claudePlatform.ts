/**
 * Which of the SDK's platform packages holds the `claude` executable for a given machine.
 *
 * The Claude Agent SDK publishes the executable as eight separate packages — one per platform — and
 * chooses between them at import time with a resolver it does not export. This mirrors that choice,
 * because two callers need the same answer: `claudeBinary.ts`, resolving one out of `node_modules`
 * for a dev run, and `scripts/build.ts`, deciding whose bytes to seal into the compiled binary. Two
 * spellings of the rule would agree on this laptop and disagree on Alpine, and the disagreement
 * would surface as a binary that cannot exec its own agent — on someone else's machine, at first
 * use. So it is written once and both callers read it.
 *
 * Nothing here decides POLICY. Whether a platform is one YewReview will build for at all is
 * `scripts/build.ts`'s call — the sandbox is what settles that — and this module answers only the
 * narrower question of what the SDK ships and what it is called.
 */

import { existsSync } from "node:fs";

const SDK = "@anthropic-ai/claude-agent-sdk";

export type HostTriple = {
  /** `process.platform`, or the platform being asked about. */
  readonly platform: string;
  /** `process.arch`, or the architecture being asked about. */
  readonly arch: string;
  /** Linux only: whether this machine's libc is musl rather than glibc. */
  readonly musl: boolean;
};

/**
 * Is this a musl machine — Alpine and friends?
 *
 * The SDK's own test first: a Node report carries the glibc version the runtime was linked against,
 * and it is the ABSENCE of that field which identifies musl. A runtime without `process.report`
 * would answer "glibc" to that question by default, so the loader is checked directly as a fallback
 * the SDK does not have. The extra care is worth it here: a wrong answer inside the SDK costs one
 * failed resolve before its fall-through finds the other package, while a wrong answer at BUILD time
 * decides which bytes get sealed into a binary that is then handed to somebody else.
 */
export function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
  const header = (report as { header?: { glibcVersionRuntime?: string } } | null)?.header;
  if (header) return header.glibcVersionRuntime === undefined;
  return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1");
}

/** This machine, as the three facts that pick a package. */
export function hostTriple(): HostTriple {
  return { platform: process.platform, arch: process.arch, musl: isMusl() };
}

/** What the executable is called inside the package — the SDK appends `.exe` on Windows. */
export function claudeBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "claude.exe" : "claude";
}

/**
 * The packages that could carry this host's executable, best match first.
 *
 * Linux gets two candidates rather than one, and the ORDER is what decides between them. The glibc
 * and musl builds are separate packages carrying the same `os` and `cpu`; the registry does mark
 * them apart with a `libc` field, but `bun.lock` records only `os` and `cpu`, so how many of the two
 * end up installed is a question about the package manager rather than about the machine. Being
 * present is therefore not evidence of being right — a glibc executable can perfectly well be sitting
 * on an Alpine box, where it does not run — so the libc is asked directly and the answer sorts the
 * list. The second candidate stays as a fallback: if the preferred package is not installed, the
 * other one actually running beats refusing.
 *
 * Everything else gets a single candidate, and an empty list means the SDK publishes nothing for this
 * machine at all — a different failure from "not installed", and reported as one by the callers.
 */
export function claudePackageCandidates(host: HostTriple = hostTriple()): readonly string[] {
  const { platform, arch, musl } = host;
  if (platform === "linux") {
    const glibc = `${SDK}-linux-${arch}`;
    const alpine = `${SDK}-linux-${arch}-musl`;
    return musl ? [alpine, glibc] : [glibc, alpine];
  }
  if (platform === "darwin" || platform === "win32") return [`${SDK}-${platform}-${arch}`];
  return [];
}

/** The machine as a refusal should name it, so both callers' messages read the same. */
export function describeHost(host: HostTriple): string {
  return `${host.platform}-${host.arch}${host.musl ? " (musl)" : ""}`;
}
