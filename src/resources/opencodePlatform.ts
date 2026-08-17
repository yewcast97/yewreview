/**
 * Which of opencode's platform packages holds the `opencode` executable for a given machine.
 *
 * The counterpart to `claudePlatform.ts`, and it exists for the same reason: two callers need one
 * answer. `opencodeBinary.ts` resolves a package out of `node_modules` for a dev run, and
 * `scripts/build.ts` decides whose bytes to seal into the compiled binary. Two spellings of the rule
 * would agree on this laptop and disagree on Alpine, and the disagreement would surface as a binary
 * that cannot exec the harness it claims to carry — on someone else's machine, at first use.
 *
 * opencode publishes TWELVE packages where the Claude SDK publishes eight, and the extra dimension
 * is AVX2. The `-baseline` builds exist for x64 machines without it, which is a real population:
 * pre-2013 hardware, some hypervisors that mask the flag, and Rosetta 2, which does not expose AVX2
 * to the x86_64 code it translates. Running a non-baseline build on such a machine is an illegal
 * instruction at startup, not a graceful failure, so the flag is asked directly rather than assumed.
 *
 * The platform token is `windows`, not `win32` — opencode names its packages after the operating
 * system and Node names `process.platform` after the API. Nothing here decides POLICY: whether a
 * platform is one YewReview will build for at all is `scripts/build.ts`'s call, and this module
 * answers only what opencode ships and what it is called.
 */

import { readFileSync } from "node:fs";

import { isMusl } from "./claudePlatform.ts";

export type OpencodeHost = {
  /** `process.platform`, or the platform being asked about. */
  readonly platform: string;
  /** `process.arch`, or the architecture being asked about. */
  readonly arch: string;
  /** Linux only: whether this machine's libc is musl rather than glibc. */
  readonly musl: boolean;
  /** x64 only: whether this CPU has AVX2. False sends the `-baseline` builds to the front. */
  readonly avx2: boolean;
};

/**
 * Does this CPU have AVX2?
 *
 * Answered the way opencode's own installer answers it, because agreeing with the installer is the
 * whole job: `/proc/cpuinfo` on Linux, `sysctl hw.optional.avx2_0` on macOS. Anything that is not
 * x64 returns true — not because those CPUs have AVX2, but because opencode publishes no baseline
 * build for them, so there is no second candidate for a false answer to reorder. Saying "true"
 * there means "no baseline preference", which is the only thing the caller does with it.
 *
 * When the probe itself fails — no `/proc`, a sandbox that hides `sysctl` — the answer is FALSE,
 * which prefers the baseline build. Baseline runs everywhere the other one does and is merely
 * slower; guessing the other way costs an illegal instruction on a machine nobody tested.
 */
export function hasAvx2(arch: string = process.arch, platform: string = process.platform): boolean {
  if (arch !== "x64") return true;
  try {
    if (platform === "linux") {
      return /^flags\s*:.*\bavx2\b/m.test(readFileSync("/proc/cpuinfo", "utf8"));
    }
    if (platform === "darwin") {
      const probe = Bun.spawnSync(["sysctl", "-n", "hw.optional.avx2_0"], { stderr: "ignore" });
      return probe.success && probe.stdout.toString().trim() === "1";
    }
  } catch {
    return false;
  }
  // Windows, and anything else that got this far: no cheap probe, and both builds are published.
  return false;
}

/** This machine, as the four facts that pick a package. */
export function opencodeHost(): OpencodeHost {
  return {
    platform: process.platform,
    arch: process.arch,
    musl: isMusl(),
    avx2: hasAvx2(),
  };
}

/** How opencode names a platform in a package name. Node says `win32` where opencode says
 * `windows`, and every other token they agree on. */
export function opencodePlatformToken(platform: string = process.platform): string {
  return platform === "win32" ? "windows" : platform;
}

/** Where the executable sits inside the package. */
export function opencodeBinaryPath(platform: string = process.platform): string {
  return platform === "win32" ? "bin/opencode.exe" : "bin/opencode";
}

/**
 * The packages that could carry this host's executable, best match first.
 *
 * Two independent preferences order the list, and they are NOT equal in weight. The libc decides
 * whether a binary runs at all, so a musl machine takes every musl build ahead of every glibc one;
 * AVX2 orders within a libc, since a baseline build runs on an AVX2 machine perfectly well and only
 * gives up some speed. Everything published for the platform stays in the list behind those
 * preferences, because a wrong-but-installed candidate is only reached when the right one was not
 * installed at all — and one of them actually running beats refusing.
 *
 * An empty list means opencode publishes nothing for this machine, which is a different failure
 * from "not installed" and is reported as one by the callers.
 */
export function opencodePackageCandidates(
  host: OpencodeHost = opencodeHost(),
): readonly string[] {
  const { platform, arch, musl, avx2 } = host;
  const os = opencodePlatformToken(platform);

  if (platform === "linux" && arch === "x64") {
    // Four builds: two libcs times two instruction sets.
    const glibc = avx2
      ? ["opencode-linux-x64", "opencode-linux-x64-baseline"]
      : ["opencode-linux-x64-baseline", "opencode-linux-x64"];
    const alpine = avx2
      ? ["opencode-linux-x64-musl", "opencode-linux-x64-baseline-musl"]
      : ["opencode-linux-x64-baseline-musl", "opencode-linux-x64-musl"];
    return musl ? [...alpine, ...glibc] : [...glibc, ...alpine];
  }
  if (platform === "linux" && arch === "arm64") {
    // No baseline builds here: AVX2 is an x86 extension.
    const glibc = "opencode-linux-arm64";
    const alpine = "opencode-linux-arm64-musl";
    return musl ? [alpine, glibc] : [glibc, alpine];
  }
  if (platform === "darwin" && arch === "x64") {
    return avx2
      ? ["opencode-darwin-x64", "opencode-darwin-x64-baseline"]
      : ["opencode-darwin-x64-baseline", "opencode-darwin-x64"];
  }
  if (platform === "win32" && arch === "x64") {
    return avx2
      ? ["opencode-windows-x64", "opencode-windows-x64-baseline"]
      : ["opencode-windows-x64-baseline", "opencode-windows-x64"];
  }
  if ((platform === "darwin" || platform === "win32") && arch === "arm64") {
    return [`opencode-${os}-arm64`];
  }
  return [];
}

/** The machine as a refusal should name it, so both callers' messages read the same. */
export function describeOpencodeHost(host: OpencodeHost): string {
  const notes = [host.musl ? "musl" : null, host.arch === "x64" && !host.avx2 ? "no avx2" : null]
    .filter((note) => note !== null)
    .join(", ");
  return `${host.platform}-${host.arch}${notes === "" ? "" : ` (${notes})`}`;
}

/** Every package opencode publishes, as its own `optionalDependencies` list them. Written down so a
 * test can prove the candidate table never names one that does not exist — a typo there resolves to
 * nothing and reads afterwards as "not installed". */
export const PUBLISHED_PACKAGES: readonly string[] = [
  "opencode-darwin-arm64",
  "opencode-darwin-x64",
  "opencode-darwin-x64-baseline",
  "opencode-linux-arm64",
  "opencode-linux-arm64-musl",
  "opencode-linux-x64",
  "opencode-linux-x64-baseline",
  "opencode-linux-x64-baseline-musl",
  "opencode-linux-x64-musl",
  "opencode-windows-arm64",
  "opencode-windows-x64",
  "opencode-windows-x64-baseline",
];
