/**
 * What happens to a file the reader drops on the composer, before the agent ever hears about it.
 *
 * Two things are being pinned here and they pull in opposite directions. The NAME must survive —
 * `Read` decides whether it is looking at an image, a document or bytes by the extension, so a
 * sanitiser that mangled `q3.pdf` into something safe-but-anonymous would break the feature it is
 * protecting. And the name must never be able to decide WHERE the file lands, because it is the one
 * string in this path that came from outside.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { homeDir } from "../src/config.ts";
import { Refused } from "../src/db/models.ts";
import { MAX_UPLOAD_BYTES, sanitizeUploadName, storeUpload } from "../src/server/uploads.ts";
import { harness } from "./helpers.ts";

/** A control character, built rather than typed, so this file holds none of its own. */
const ctrl = (code: number): string => String.fromCharCode(code);

describe("the name a dropped file is stored under", () => {
  test("an ordinary name comes through untouched", () => {
    // Including the extension, which is the part with a job to do downstream.
    expect(sanitizeUploadName("q3-earnings.pdf")).toBe("q3-earnings.pdf");
    expect(sanitizeUploadName("Prices 2026 (final).csv")).toBe("Prices 2026 (final).csv");
  });

  test("only the last segment survives, whichever slash was used", () => {
    // The browser does not hand over a directory today. This is the one function between a string
    // from outside and `resolve()`, so it does not depend on that staying true.
    expect(sanitizeUploadName("/etc/passwd")).toBe("passwd");
    expect(sanitizeUploadName("../../secrets.txt")).toBe("secrets.txt");
    expect(sanitizeUploadName("..\\..\\windows\\hosts")).toBe("hosts");
    expect(sanitizeUploadName("a/b/c/report.pdf")).toBe("report.pdf");
  });

  test("control characters are stripped", () => {
    // A newline in a filename is a name that lies about itself in every listing that prints it.
    expect(sanitizeUploadName(`no${ctrl(10)}tes.txt`)).toBe("notes.txt");
    expect(sanitizeUploadName(`tab${ctrl(9)}bed.csv`)).toBe("tabbed.csv");
    expect(sanitizeUploadName(`nul${ctrl(0)}l.bin`)).toBe("null.bin");
  });

  test("surrounding whitespace goes", () => {
    expect(sanitizeUploadName("  spaced.md  ")).toBe("spaced.md");
  });

  test("a name with nothing in it is refused rather than invented", () => {
    // A reader who somehow dropped one of these is better told than quietly handed a file called
    // something this module made up.
    for (const raw of ["", "   ", ".", "..", "/", "///", ctrl(0)]) {
      expect(() => sanitizeUploadName(raw)).toThrow(Refused);
    }
  });

  test("a very long name is cut down and keeps its extension", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const safe = sanitizeUploadName(long);
    expect(safe.length).toBeLessThanOrEqual(128);
    expect(safe.endsWith(".pdf")).toBe(true);
  });

  test("a long name with no extension is simply cut", () => {
    const safe = sanitizeUploadName("b".repeat(400));
    expect(safe.length).toBe(128);
    expect(safe).toBe("b".repeat(128));
  });

  test("a leading dot is a name, not an extension", () => {
    expect(sanitizeUploadName(".gitignore")).toBe(".gitignore");
  });
});

describe("writing a dropped file into the home directory", () => {
  test("the bytes land, and the path names where", async () => {
    const h = harness();
    try {
      const path = await storeUpload(h.settings, "report.pdf", new TextEncoder().encode("hello").buffer);
      expect(path).toMatch(/^uploads\/[0-9a-f]{8}\/report\.pdf$/);
      const absolute = resolve(homeDir(h.settings), path);
      expect(await Bun.file(absolute).text()).toBe("hello");
    } finally {
      h.cleanup();
    }
  });

  test("the same name twice is two files, not one overwritten", async () => {
    // A fresh directory per upload is what buys this: dropping `data.csv` from two folders is two
    // different files, and a reader who meant both must get both.
    const h = harness();
    try {
      const first = await storeUpload(h.settings, "data.csv", new TextEncoder().encode("one").buffer);
      const second = await storeUpload(h.settings, "data.csv", new TextEncoder().encode("two").buffer);
      expect(first).not.toBe(second);
      const home = homeDir(h.settings);
      expect(await Bun.file(resolve(home, first)).text()).toBe("one");
      expect(await Bun.file(resolve(home, second)).text()).toBe("two");
    } finally {
      h.cleanup();
    }
  });

  test("a name that tried to climb out lands inside anyway", async () => {
    const h = harness();
    try {
      const path = await storeUpload(
        h.settings,
        "../../../../../../tmp/escaped.txt",
        new TextEncoder().encode("x").buffer,
      );
      expect(path).toMatch(/^uploads\/[0-9a-f]{8}\/escaped\.txt$/);
      const absolute = resolve(homeDir(h.settings), path);
      expect(absolute.startsWith(homeDir(h.settings))).toBe(true);
      expect(existsSync(absolute)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("an empty file is still a file", async () => {
    const h = harness();
    try {
      const path = await storeUpload(h.settings, "empty.txt", new ArrayBuffer(0));
      expect(existsSync(resolve(homeDir(h.settings), path))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("the cap is a round number of mebibytes", () => {
    // Named here so a change to it is a change somebody made on purpose: the composer shows this
    // figure to the reader in its refusal.
    expect(MAX_UPLOAD_BYTES).toBe(32 * 1024 * 1024);
  });
});
