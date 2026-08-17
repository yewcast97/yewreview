/**
 * Which platform package holds the opencode executable — the rule the build and the dev run share.
 *
 * The counterpart to `claudePlatform.test.ts`, and it exists for the same reason: this is a table
 * rather than a behaviour, and WHERE it is wrong is what makes it worth a suite. `scripts/build.ts`
 * reads it to decide whose bytes get sealed into a binary handed to somebody else, so a mistake here
 * does not fail on the machine that made it — it fails at first run, on a machine nobody here can
 * see, as a harness that cannot start.
 *
 * Twelve rows instead of eight, because opencode splits x64 a second way: an AVX2 build and a
 * `-baseline` one for CPUs without it. That second axis is the reason for most of what is below —
 * getting it backwards produces an ILLEGAL INSTRUCTION at startup rather than a readable failure,
 * and it does so only on hardware nobody testing this is likely to be sitting at.
 *
 * The mapping is pure and takes the host as an argument, which is what lets every row be checked
 * from one laptop; the last cases check the real machine and the real file.
 */

import { describe, expect, test } from "bun:test";

import {
  PUBLISHED_PACKAGES,
  describeOpencodeHost,
  hasAvx2,
  opencodeBinaryPath,
  opencodeHost,
  opencodePackageCandidates,
  opencodePlatformToken,
  type OpencodeHost,
} from "../src/resources/opencodePlatform.ts";

import { opencodeBinary } from "../src/resources/opencodeBinary.ts";

function host(platform: string, arch: string, musl = false, avx2 = true): OpencodeHost {
  return { platform, arch, musl, avx2 };
}

describe("the package a host needs", () => {
  test("apple silicon has exactly one, because there is only one to have", () => {
    // No libc question on darwin and no baseline build for arm64: AVX2 is an x86 extension, so the
    // second axis does not exist here and a second candidate would be a package that is not published.
    expect(opencodePackageCandidates(host("darwin", "arm64"))).toEqual(["opencode-darwin-arm64"]);
  });

  test("an intel mac is ordered by AVX2, and Rosetta is the reason that is not academic", () => {
    // Rosetta 2 does not expose AVX2 to the x86_64 code it translates, so "an Intel Mac" and "a Mac
    // running an Intel binary" are different machines and only one of them can run the fast build.
    expect(opencodePackageCandidates(host("darwin", "x64", false, true))).toEqual([
      "opencode-darwin-x64",
      "opencode-darwin-x64-baseline",
    ]);
    expect(opencodePackageCandidates(host("darwin", "x64", false, false))).toEqual([
      "opencode-darwin-x64-baseline",
      "opencode-darwin-x64",
    ]);
  });

  test("linux x64 has four, and the libc outranks the instruction set", () => {
    // The two preferences are not equal in weight, and this is where that is pinned. Getting the
    // libc wrong means a binary that does not run at all; getting AVX2 wrong within a libc means a
    // binary that runs slower. So every musl build sorts ahead of every glibc one on a musl box,
    // and the AVX2 preference only orders the pair inside each libc.
    expect(opencodePackageCandidates(host("linux", "x64", false, true))).toEqual([
      "opencode-linux-x64",
      "opencode-linux-x64-baseline",
      "opencode-linux-x64-musl",
      "opencode-linux-x64-baseline-musl",
    ]);
    expect(opencodePackageCandidates(host("linux", "x64", false, false))).toEqual([
      "opencode-linux-x64-baseline",
      "opencode-linux-x64",
      "opencode-linux-x64-baseline-musl",
      "opencode-linux-x64-musl",
    ]);
    expect(opencodePackageCandidates(host("linux", "x64", true, true))).toEqual([
      "opencode-linux-x64-musl",
      "opencode-linux-x64-baseline-musl",
      "opencode-linux-x64",
      "opencode-linux-x64-baseline",
    ]);
    expect(opencodePackageCandidates(host("linux", "x64", true, false))).toEqual([
      "opencode-linux-x64-baseline-musl",
      "opencode-linux-x64-musl",
      "opencode-linux-x64-baseline",
      "opencode-linux-x64",
    ]);
  });

  test("linux arm64 has two, by libc alone", () => {
    expect(opencodePackageCandidates(host("linux", "arm64", false))).toEqual([
      "opencode-linux-arm64",
      "opencode-linux-arm64-musl",
    ]);
    expect(opencodePackageCandidates(host("linux", "arm64", true))).toEqual([
      "opencode-linux-arm64-musl",
      "opencode-linux-arm64",
    ]);
  });

  test("windows is spelled `windows`, which is not what process.platform calls it", () => {
    // The one naming trap in the table: Node says `win32` after the API, opencode names its packages
    // after the operating system. A candidate spelled `opencode-win32-x64` resolves to nothing and
    // reads afterwards as "not installed", which is the wrong diagnosis entirely.
    expect(opencodePlatformToken("win32")).toBe("windows");
    expect(opencodePlatformToken("linux")).toBe("linux");
    expect(opencodePackageCandidates(host("win32", "x64", false, true))).toEqual([
      "opencode-windows-x64",
      "opencode-windows-x64-baseline",
    ]);
    expect(opencodePackageCandidates(host("win32", "arm64"))).toEqual(["opencode-windows-arm64"]);
  });

  test("a platform opencode does not publish for gets an empty list, not a guess", () => {
    // Empty is a DIFFERENT failure from "not installed" and the callers say so differently: one
    // sends a reader to `bun install`, the other tells them no such build exists. A fabricated
    // candidate would collapse the two into the message that wastes their time.
    for (const absent of [host("freebsd", "x64"), host("darwin", "ppc64"), host("sunos", "x64")]) {
      expect(opencodePackageCandidates(absent)).toEqual([]);
    }
  });

  test("every candidate this table can name is a package opencode actually publishes", () => {
    // The lock that a typo cannot survive. `PUBLISHED_PACKAGES` is opencode's own
    // `optionalDependencies` list; a candidate outside it resolves to nothing on every machine, and
    // the failure it produces — "not installed" — points at the wrong half of the problem.
    const published = new Set(PUBLISHED_PACKAGES);
    for (const platform of ["darwin", "linux", "win32"]) {
      for (const arch of ["x64", "arm64"]) {
        for (const musl of [false, true]) {
          for (const avx2 of [false, true]) {
            for (const pkg of opencodePackageCandidates(host(platform, arch, musl, avx2))) {
              expect(published.has(pkg)).toBe(true);
            }
          }
        }
      }
    }
    expect(PUBLISHED_PACKAGES).toHaveLength(12);
  });

  test("the binary is at bin/opencode, with the extension Windows needs", () => {
    expect(opencodeBinaryPath("darwin")).toBe("bin/opencode");
    expect(opencodeBinaryPath("linux")).toBe("bin/opencode");
    expect(opencodeBinaryPath("win32")).toBe("bin/opencode.exe");
  });

  test("a host describes itself the way a refusal should read", () => {
    expect(describeOpencodeHost(host("darwin", "arm64"))).toBe("darwin-arm64");
    expect(describeOpencodeHost(host("linux", "x64", true, true))).toBe("linux-x64 (musl)");
    expect(describeOpencodeHost(host("linux", "x64", false, false))).toBe("linux-x64 (no avx2)");
    expect(describeOpencodeHost(host("linux", "x64", true, false))).toBe(
      "linux-x64 (musl, no avx2)",
    );
  });
});

describe("this machine", () => {
  test("answers the AVX2 question without asking about non-x64 CPUs", () => {
    // True for anything that is not x64, and it is not a claim about the silicon: there is no
    // baseline package for those arches, so there is no second candidate for a false answer to
    // reorder. "No baseline preference" is the only thing a caller does with it.
    expect(hasAvx2("arm64", "darwin")).toBe(true);
    expect(hasAvx2("arm64", "linux")).toBe(true);
    // And on x64 it answers something, from the machine rather than from a guess.
    expect(typeof hasAvx2("x64", process.platform)).toBe("boolean");
  });

  test("resolves the executable the build would embed, and it is a real file", () => {
    // The live row: everything above is a table, and this is the one case that proves the table
    // agrees with what `bun install` actually put on this disk.
    const resolved = opencodeBinary();
    expect(resolved).toContain(opencodeBinaryPath());
    expect(Bun.file(resolved).size).toBeGreaterThan(0);
    expect(opencodePackageCandidates(opencodeHost()).length).toBeGreaterThan(0);
  });
});
