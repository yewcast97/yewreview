/**
 * Which platform package holds the agent's executable — the one rule the build and the dev run share.
 *
 * This is a table rather than a behaviour, and it is worth a suite because of WHERE it is wrong when
 * it is wrong. `scripts/build.ts` reads it to decide whose bytes get sealed into a binary that is
 * then handed to someone else, so a mistake here does not fail on the machine that made it: it fails
 * at first run, on a machine nobody here can see, as an agent that cannot start. Every row below is
 * a platform this checkout will not otherwise be tested on until somebody stands on it.
 *
 * The mapping is pure and takes the host as an argument, which is the whole reason it can be tested
 * from a laptop at all — the eight rows are checked here, and the last case checks the real one.
 */

import { describe, expect, test } from "bun:test";

import {
  claudeBinaryName,
  claudePackageCandidates,
  describeHost,
  hostTriple,
  isMusl,
  type HostTriple,
} from "../src/resources/claudePlatform.ts";

import { claudeBinary } from "../src/resources/claudeBinary.ts";

const SDK = "@anthropic-ai/claude-agent-sdk";

function host(platform: string, arch: string, musl = false): HostTriple {
  return { platform, arch, musl };
}

describe("the packages a host could use", () => {
  test("macOS has exactly one candidate per architecture", () => {
    expect(claudePackageCandidates(host("darwin", "arm64"))).toEqual([`${SDK}-darwin-arm64`]);
    expect(claudePackageCandidates(host("darwin", "x64"))).toEqual([`${SDK}-darwin-x64`]);
  });

  test("Windows has one too, even though the build refuses to make one", () => {
    // The mapping answers what the SDK ships; whether YewReview will build for a platform is
    // `scripts/build.ts`'s call, and it says no to Windows because there is no sandbox there. Those
    // are two different questions and only one of them is answered here.
    expect(claudePackageCandidates(host("win32", "x64"))).toEqual([`${SDK}-win32-x64`]);
    expect(claudePackageCandidates(host("win32", "arm64"))).toEqual([`${SDK}-win32-arm64`]);
  });

  test("Linux has two, and the libc decides which is tried first", () => {
    // Order is load-bearing because presence is not evidence: `bun.lock` carries only `os` and `cpu`
    // for these two, so both can be installed on the same machine, and a glibc executable sitting on
    // an Alpine box is a file that exists and does not run. The libc decides, not the filesystem.
    expect(claudePackageCandidates(host("linux", "x64", false))).toEqual([
      `${SDK}-linux-x64`,
      `${SDK}-linux-x64-musl`,
    ]);
    expect(claudePackageCandidates(host("linux", "x64", true))).toEqual([
      `${SDK}-linux-x64-musl`,
      `${SDK}-linux-x64`,
    ]);
    expect(claudePackageCandidates(host("linux", "arm64", true))).toEqual([
      `${SDK}-linux-arm64-musl`,
      `${SDK}-linux-arm64`,
    ]);
  });

  test("the fallback is always the other libc, never nothing", () => {
    // Preference, not exclusion: if the preferred package turns out not to be installed, the other
    // one actually running beats a refusal.
    for (const musl of [true, false]) {
      expect(claudePackageCandidates(host("linux", "x64", musl))).toHaveLength(2);
    }
  });

  test("a platform the SDK does not publish for gets an empty list, not a guess", () => {
    // Which is a different failure from "not installed" and is reported as one — a fabricated
    // package name would send the reader to look for something that was never published.
    expect(claudePackageCandidates(host("freebsd", "x64"))).toEqual([]);
    expect(claudePackageCandidates(host("openbsd", "arm64"))).toEqual([]);
    expect(claudePackageCandidates(host("sunos", "x64"))).toEqual([]);
  });

  test("every candidate is a real package name from the SDK's eight", () => {
    // Pinned against the list in the SDK's own optionalDependencies. A typo in an interpolation is
    // invisible to the type system and shows up as a package that cannot be resolved.
    const published = new Set([
      `${SDK}-darwin-arm64`,
      `${SDK}-darwin-x64`,
      `${SDK}-linux-arm64`,
      `${SDK}-linux-arm64-musl`,
      `${SDK}-linux-x64`,
      `${SDK}-linux-x64-musl`,
      `${SDK}-win32-arm64`,
      `${SDK}-win32-x64`,
    ]);
    const rows: HostTriple[] = [
      host("darwin", "arm64"),
      host("darwin", "x64"),
      host("linux", "x64"),
      host("linux", "x64", true),
      host("linux", "arm64"),
      host("linux", "arm64", true),
      host("win32", "x64"),
      host("win32", "arm64"),
    ];
    const seen = new Set(rows.flatMap((row) => [...claudePackageCandidates(row)]));
    expect([...seen].sort()).toEqual([...published].sort());
  });
});

describe("what the executable is called", () => {
  test("`claude` everywhere the build will run, `claude.exe` on Windows", () => {
    expect(claudeBinaryName("darwin")).toBe("claude");
    expect(claudeBinaryName("linux")).toBe("claude");
    expect(claudeBinaryName("win32")).toBe("claude.exe");
  });
});

describe("naming a host in a refusal", () => {
  test("the libc is said only when it is the unusual one", () => {
    expect(describeHost(host("darwin", "arm64"))).toBe("darwin-arm64");
    expect(describeHost(host("linux", "x64", false))).toBe("linux-x64");
    expect(describeHost(host("linux", "x64", true))).toBe("linux-x64 (musl)");
  });
});

describe("this machine", () => {
  test("musl is a Linux question and is answered `no` anywhere else", () => {
    if (process.platform !== "linux") expect(isMusl()).toBe(false);
    expect(hostTriple()).toEqual({ platform: process.platform, arch: process.arch, musl: isMusl() });
  });

  test("the executable this checkout would use is really there", () => {
    // The one row the table cannot check for itself, and the row that matters most on whichever
    // machine is running: that the package the mapping picks is installed, and that the path it
    // resolves to is a file. Every contributor re-runs this row for their own platform, which is as
    // close to testing all eight as a single machine gets.
    const path = claudeBinary();
    expect(Bun.file(path).size).toBeGreaterThan(0);
    const name = claudeBinaryName(process.platform);
    expect(path.endsWith(`/${name}`)).toBe(true);
    expect(claudePackageCandidates().some((pkg) => path.includes(pkg))).toBe(true);
  });
});
