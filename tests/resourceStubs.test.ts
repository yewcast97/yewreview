/**
 * The four committed stubs are committed in STUB form — the tripwire for a killed build.
 *
 * `scripts/build.ts` rewrites four modules into real `with { type: "file" }` imports, compiles, and
 * restores them in a `finally` with signal handlers behind it. That is careful, and it is still not
 * a guarantee: `kill -9`, a full disk, a laptop lid at the wrong moment. What is left behind is a
 * checkout whose source imports files that only exist mid-build — and it does not merely fail, it
 * fails LATER and somewhere else, because `git status` shows four modified files that look like work
 * in progress and a commit of one is a commit of a path into somebody's `build/` directory.
 *
 * The build refuses to start when it meets one (`readStub`), which protects the next build. This
 * protects the next COMMIT, which is the failure that travels.
 *
 * Nothing here mocks anything: these are the real files, read off the real disk, and the assertion
 * is the same string the build writes.
 */

import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { extractExecutable } from "../src/resources/embed.ts";

const RESOURCES = resolve(import.meta.dir, "../src/resources");

/** The first words `scripts/build.ts` writes into a module it has rewritten. */
const REWRITTEN = "// Rewritten by scripts/build.ts";

/** Every module the build swaps. Named here rather than globbed, because the point is to notice a
 * FIFTH one being added to the build without being added to this list — a glob would silently
 * cover it and silently stop covering it the day somebody moved a file. */
const SHIMS = ["seikanWheel.ts", "claudeBinary.ts", "opencodeBinary.ts", "uvBinary.ts"];

describe("the committed resource stubs", () => {
  test("none of them is the form a build writes", () => {
    for (const shim of SHIMS) {
      const text = readFileSync(join(RESOURCES, shim), "utf8");
      expect(text.startsWith(REWRITTEN)).toBe(false);
    }
  });

  test("the two that resolve at runtime export a function, and the two that cannot export null", () => {
    // The split is the whole design of these four. A wheel and a uv are BUILD PRODUCTS: a checkout
    // has neither, so the honest dev value is null and the caller falls back — to an editable
    // install of the engine's source, and to whatever uv is on PATH. The two executables are
    // resolvable in a checkout, out of node_modules, but only once the machine is known, so they
    // are functions rather than imports: a static import would name one platform's package and be a
    // hardcoded fact about the machine the file was written on.
    for (const nullish of ["seikanWheel.ts", "uvBinary.ts"]) {
      expect(readFileSync(join(RESOURCES, nullish), "utf8")).toContain("null as string | null");
    }
    for (const resolved of ["claudeBinary.ts", "opencodeBinary.ts"]) {
      expect(readFileSync(join(RESOURCES, resolved), "utf8")).toContain("createRequire");
    }
  });
});

describe("extracting an executable", () => {
  test("a path that is already on disk is handed back untouched", async () => {
    // The dev-mode case, and the escape-hatch case with it. Outside a compiled binary these paths
    // are real files — in node_modules, or wherever YEWREVIEW_OPENCODE_CLI points — and copying one
    // would leave a second copy that goes stale the next time `bun install` runs.
    const real = resolve(import.meta.dir, "../package.json");
    expect(await extractExecutable(real, "/nonexistent-bin-root", "package.json")).toBe(real);
  });

  test("nothing is written for a passthrough, so a read-only var/ is not a failure", async () => {
    // The bin root named above does not exist and must stay that way: a passthrough that created
    // its destination directory would make `bun run dev` mkdir a tree it never uses.
    expect(await Bun.file("/nonexistent-bin-root").exists()).toBe(false);
  });
});
