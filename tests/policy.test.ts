/**
 * The sandbox policy, checked as a VALUE.
 *
 * Nothing here starts a sandbox — the operating system enforces the policy and there is no way to
 * ask it a hypothetical. What can be pinned is the shape YewReview hands over, and every assertion
 * below exists because getting that shape wrong fails SILENTLY: a denied write announces itself,
 * but a rule that was never sent looks exactly like a rule that was never needed.
 */

import { describe, expect, test } from "bun:test";

import { homeDir, loadSettings, paths } from "../src/config.ts";
import { sandboxSettings } from "../src/claudecode/sandbox.ts";

const settings = loadSettings({ varDir: "/tmp/yewreview-policy-test" });
const p = paths(settings);
const policy = sandboxSettings(settings);

/** Does this `dir/**` rule stand between the sandbox and that file? Asked of a file rather than of
 * a directory because a tree is denied for the sake of what is INSIDE it. */
function denies(rule: string, file: string): boolean {
  return rule.endsWith("/**") && file.startsWith(rule.slice(0, -2));
}

describe("the sandbox policy", () => {
  test("is on, and has no way to fall back to an unsandboxed shell", () => {
    expect(policy.enabled).toBe(true);
    // Without both of these a missing sandbox degrades to no sandbox, and the only signal is a
    // warning nobody is reading on a headless server.
    expect(policy.failIfUnavailable).toBe(true);
    expect(policy.allowUnsandboxedCommands).toBe(false);
  });

  test("permits writes in the agent's home, in scratch, and in the engine's kernel cache", () => {
    expect(policy.filesystem?.allowWrite).toEqual([
      `${homeDir(settings)}/**`,
      `${p.tmpDir}/**`,
      // Found by running the compiled binary: NUMBA_CACHE_DIR is handed to every session, and a
      // cache the process cannot write makes the first measurement fail rather than merely
      // recompile — after which the agent redirects the variable and every run pays full
      // compilation. A cache is not a record.
      `${p.numbaCacheDir}/**`,
    ]);
  });

  test("denies every tree where a write would break a record rather than produce one", () => {
    const denied = policy.filesystem?.denyWrite ?? [];
    // The ledger, the measurement engine, the tree the published documents are served out of, and
    // the transcript of the conversation doing the writing. Scripts and reports are not files at
    // all — they are columns — and neither is the data: nothing the agent produces has a durable
    // home outside the home directory, so there is no fifth tree for a rule to be about.
    for (const tree of [p.dbPath, p.venvDir, p.reportsDir, p.claudecodeDir, p.binDir]) {
      expect(denied.some((rule) => rule.startsWith(tree))).toBe(true);
    }
    // What is under reports/ is the chart library every published document loads from, and an
    // agent that can edit echarts.min.js can script every report ever published. It is covered by
    // the tree rule rather than by one of its own, which is exactly the kind of coverage that
    // disappears the day somebody narrows the rule to a subdirectory.
    expect(denied.some((rule) => denies(rule, `${p.reportAssetsDir}/echarts.min.js`))).toBe(true);
    // The ledger is the one tree denied for reading too. Not because the agent is owed less than
    // the archive holds — it has a tool for every table — but because a raw read goes around the
    // tools, and the tools are where the joins, the hydration and the refusals live.
    expect((policy.filesystem?.denyRead ?? []).length).toBeGreaterThan(0);
  });

  test("states the network allowance explicitly, because the default is deny", () => {
    // The regression this exists for: with `network` omitted the sandbox pre-allows NO domain and
    // asks about each new one the first time it is needed. That is right at a terminal and wrong
    // here — a headless session has nobody to ask, so the request never happens and the agent
    // simply loses every fetch it makes through a shell. Verified against a live sandbox: omitted
    // gives a refused CONNECT, ["*"] connects.
    expect(policy.network?.allowedDomains).toEqual(["*"]);
  });

  test("keeps the agent's own credential out of the subprocesses it starts", () => {
    expect(policy.credentials?.envVars).toEqual([{ name: "ANTHROPIC_API_KEY", mode: "deny" }]);
  });

  test("gives the agent a directory of its own rather than the whole of var/", () => {
    // There is one home, and the temptation that comes with one is to point it at `var/` and
    // let the deny list do the work. It would not: `allowWrite` is the allow-list, so widening it
    // to the root would hand the agent every tree that has no explicit rule — the resource cache,
    // the numba cache's parent, whatever `var/` grows next — and leave three deny rules as the only
    // thing between it and the ledger. Home is a subdirectory, and the deny rules are the second
    // line rather than the first.
    const home = homeDir(settings);
    expect(home.startsWith(settings.varDir + "/")).toBe(true);
    expect(home).not.toBe(settings.varDir);
    for (const tree of [p.dbPath, p.venvDir, p.reportsDir, p.cacheDir, p.claudecodeDir, p.binDir]) {
      expect(tree.startsWith(home + "/")).toBe(false);
    }
  });
});
