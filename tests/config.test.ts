/**
 * The settings that are parsed rather than merely read, and the one that is not settings at all.
 *
 * A string that arrives from a flag or a shell profile is not yet a setting — `debug` is one and
 * `chatty` is a typo, and the difference has to be found at the edge, while there is still a sentence
 * that can name the thing the reader typed. What is pinned here is that both routes into a log level
 * go through the same parse and that a refusal says which route it is refusing.
 *
 * NOTHING BELOW TOUCHES THE ENVIRONMENT, and that absence is now the whole of the discipline rather
 * than something a block-scoped `afterEach` has to buy back: the only setting that ever needed one —
 * the effort level — is no longer configurable, so there is no precedence to demonstrate and no
 * variable to set and put back. A case added here that reads `process.env` would be testing the
 * developer's machine.
 */

import { describe, expect, test } from "bun:test";

import { isEffortLevel, loadSettings, parseLogLevel } from "../src/config.ts";

describe("effort levels", () => {
  test("every level the SDK has is recognised", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(isEffortLevel(level)).toBe(true);
    }
  });

  test("nothing near a level is a level", () => {
    for (const almost of ["", " high", "highest", "none", "off", "true"]) {
      expect(isEffortLevel(almost)).toBe(false);
    }
  });
});

describe("log levels", () => {
  test("both routes parse the same, and a refusal names the one it came from", () => {
    expect(parseLogLevel("DEBUG", "--log-level")).toBe("debug");
    expect(() => parseLogLevel("chatty", "YEWREVIEW_LOG_LEVEL")).toThrow(/^YEWREVIEW_LOG_LEVEL must be one of/);
  });
});

describe("loading settings", () => {
  const VAR_DIR = "/tmp/yewreview-config-test";

  test("the effort level is high, and nothing configures it", () => {
    // The absence is the product decision, so the absence is what is pinned. How hard the model works
    // is a property of the CONVERSATION — the reader moves it in the composer, for the question in
    // front of them — and an installation-wide knob for it would be a second answer to the same
    // question, wrong in whichever conversation had not been asked.
    expect(loadSettings({ varDir: VAR_DIR }).effort).toBe("high");
    // Overriding everything that CAN be overridden leaves it where it was. `Overrides` carries no
    // `effort` key at all, so the flag this line stands in for would not compile — which is the
    // stronger half of the guarantee, and the half a runtime assertion cannot make.
    expect(loadSettings({ varDir: VAR_DIR, model: "claude-sonnet-5", logLevel: "debug" }).effort).toBe(
      "high",
    );
  });
});
