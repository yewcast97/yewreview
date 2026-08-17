/**
 * The two environment scrubs, which run before anything else in the process reads `process.env`.
 *
 * Both defend against a variable somebody put in a shell profile years ago, and both failures are
 * ugly at a distance rather than loud at the source: a stray `SEIKAN_*` fails EVERY measurement with
 * an envelope naming a variable the user does not remember setting, and a blank `ANTHROPIC_API_KEY`
 * authenticates with nothing while a perfectly good login sits unused beside it. Neither shows up as
 * a bad line of code, which is exactly why they are worth pinning.
 *
 * Every case here passes its own object rather than touching the real environment: `process.env` is
 * this process's, the suite runs in it, and a test that deleted a variable out of it would be
 * mutating the thing every other test is standing on.
 */

import { describe, expect, test } from "bun:test";

import { SEIKAN_ENV_PREFIX, dropEmptyApiKey, scrubSeikanEnv } from "../src/env.ts";

describe("scrubbing the engine's namespace", () => {
  test("every variable under the prefix goes, and their names come back", () => {
    // The names are returned so the boot can SAY what it removed. Silently deleting a variable
    // somebody set on purpose is the same surprise in the other direction.
    const env: Record<string, string | undefined> = {
      SEIKAN_MIN_TRADES: "30",
      SEIKAN_ANYTHING: "x",
      YEWREVIEW_PORT: "8787",
      PATH: "/usr/bin",
    };
    expect(scrubSeikanEnv(env)).toEqual(["SEIKAN_ANYTHING", "SEIKAN_MIN_TRADES"]);
    expect(env).toEqual({ YEWREVIEW_PORT: "8787", PATH: "/usr/bin" });
  });

  test("the names come back sorted, so the sentence the boot prints is stable", () => {
    const env: Record<string, string | undefined> = { SEIKAN_C: "3", SEIKAN_A: "1", SEIKAN_B: "2" };
    expect(scrubSeikanEnv(env)).toEqual(["SEIKAN_A", "SEIKAN_B", "SEIKAN_C"]);
  });

  test("an environment with none of them is untouched, and answers with an empty list", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", HOME: "/home/a" };
    expect(scrubSeikanEnv(env)).toEqual([]);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/a" });
  });

  test("the prefix is matched at the START and nothing else is taken", () => {
    // `MY_SEIKAN_THING` is somebody else's variable. The engine only refuses to construct over what
    // it reads as its own, and taking more than that would be this process deleting a stranger's
    // configuration.
    const env: Record<string, string | undefined> = {
      MY_SEIKAN_THING: "keep",
      seikan_lower: "keep",
      SEIKAN_: "go",
    };
    expect(scrubSeikanEnv(env)).toEqual(["SEIKAN_"]);
    expect(env).toEqual({ MY_SEIKAN_THING: "keep", seikan_lower: "keep" });
  });

  test("a variable set to the empty string still counts as set, and still goes", () => {
    // pydantic-settings reads the NAME being present, not what is in it — an empty `SEIKAN_X` fails
    // a run exactly as a filled one does.
    const env: Record<string, string | undefined> = { SEIKAN_MIN_TRADES: "" };
    expect(scrubSeikanEnv(env)).toEqual(["SEIKAN_MIN_TRADES"]);
    expect("SEIKAN_MIN_TRADES" in env).toBe(false);
  });

  test("the prefix is the one the engine actually owns", () => {
    expect(SEIKAN_ENV_PREFIX).toBe("SEIKAN_");
  });
});

describe("dropping a blank API key", () => {
  test("a key that is present but empty is removed", () => {
    // Worse than absent: the SDK treats "" as a key and authenticates with nothing, which shadows
    // the subscription login already on the machine and fails at the first turn.
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "" };
    expect(dropEmptyApiKey(env)).toBe(true);
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
  });

  test("a key that is only whitespace is treated as blank", () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "   \t " };
    expect(dropEmptyApiKey(env)).toBe(true);
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
  });

  test("a real key is left exactly as it was", () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-real" };
    expect(dropEmptyApiKey(env)).toBe(false);
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-real");
  });

  test("no key at all is not a key to drop", () => {
    // The ordinary case for a subscription login, and it must not be reported as having changed
    // anything — the boot says a sentence when this returns true.
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    expect(dropEmptyApiKey(env)).toBe(false);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("a key with real content and surrounding whitespace is kept whole", () => {
    // Trimming is how the blank is DETECTED, not something done to the value: a key is passed on
    // exactly as the user wrote it, and it is not this function's business to tidy credentials.
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: " sk-ant-real " };
    expect(dropEmptyApiKey(env)).toBe(false);
    expect(env["ANTHROPIC_API_KEY"]).toBe(" sk-ant-real ");
  });
});
