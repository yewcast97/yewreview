/**
 * The line that names a file, read back out of a message.
 *
 * Nothing here is faked and nothing needs to be: the module under test is pure and DOM-free, and the
 * convention it reads is one string of text. What the last two tests do reach for is REAL and is the
 * whole reason they exist — the server's own URL prefix, and the prompt the agent is taught — because
 * the only way this arrangement can fail is by the three places that string is written drifting
 * apart, and none of them fails at runtime where anybody would notice.
 *
 * A LINE AND NOT A FRAME, which is what shapes every test below. A live frame lasts as long as a
 * socket; the transcript is rebuilt on reload out of the agent SDK's store, which carries turns and
 * tool calls and nothing this window invented. So the fact that a message hands over a file has to
 * be IN the message, and the tests are therefore about a grammar rather than about a payload: what
 * the composer writes (`serializeOutgoing`), what the prompt teaches, and what this module reads had
 * better be one language, and the round-trip test at the end is the only proof of that which does
 * not depend on somebody keeping two hand-written expectations in step.
 */

import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { FILES_URL_PREFIX } from "../src/server/homeFiles.ts";
import { fileHref, splitAttachments } from "../web/src/lib/attachments.ts";
import type { ComposerChip } from "../web/src/lib/outgoing.ts";
import { FILE_PREFIX, serializeOutgoing } from "../web/src/lib/outgoing.ts";

describe("a message cut into prose and the files named in it", () => {
  test("prose with no such line is one segment, exactly as it was written", () => {
    const said = "measure 2330 over five years\n\nand say what moved";
    expect(splitAttachments(said)).toEqual([{ kind: "text", text: said }]);
    // Nothing at all is no segments rather than one empty one: empty prose is dropped, so a message
    // that is only an attachment line is a file and not a file between two blanks.
    expect(splitAttachments("")).toEqual([]);
  });

  test("a line alone is the whole message", () => {
    expect(splitAttachments(`${FILE_PREFIX} outputs/nvda-prices.csv`)).toEqual([
      { kind: "file", path: "outputs/nvda-prices.csv", name: "nvda-prices.csv" },
    ]);
  });

  test("a line between prose keeps the order and leaves no blank row behind it", () => {
    expect(
      splitAttachments(`Here is what I found.\n${FILE_PREFIX} outputs/nvda-prices.csv\nAnything else?`),
    ).toEqual([
      { kind: "text", text: "Here is what I found.\n" },
      { kind: "file", path: "outputs/nvda-prices.csv", name: "nvda-prices.csv" },
      // The consumed line took its own newline with it, so what follows starts at the word rather
      // than at the gap the sentence used to occupy.
      { kind: "text", text: "Anything else?" },
    ]);
  });

  test("several in a row stay in the order they were written", () => {
    const said = [
      `${FILE_PREFIX} outputs/prices.csv`,
      `${FILE_PREFIX} outputs/volumes.csv`,
      `${FILE_PREFIX} outputs/chart.svg`,
      "Three of them, one per year.",
    ].join("\n");
    expect(splitAttachments(said)).toEqual([
      { kind: "file", path: "outputs/prices.csv", name: "prices.csv" },
      { kind: "file", path: "outputs/volumes.csv", name: "volumes.csv" },
      { kind: "file", path: "outputs/chart.svg", name: "chart.svg" },
      { kind: "text", text: "Three of them, one per year." },
    ]);
  });

  test("the path runs to the end of the line, spaces, unicode and all", () => {
    // Which is exactly why nothing may follow it. A filename is whatever the reader's own machine
    // called the file, and a grammar that stopped at the first space would name a file that is not
    // there — see `serializeOutgoing`, which writes one per line for this reason.
    expect(splitAttachments(`${FILE_PREFIX} uploads/1a2b3c4d/q3 財報 summary.csv\n`)).toEqual([
      { kind: "file", path: "uploads/1a2b3c4d/q3 財報 summary.csv", name: "q3 財報 summary.csv" },
    ]);
  });

  test("the name is the last segment, and the whole path when there is only one", () => {
    const [nested] = splitAttachments(`${FILE_PREFIX} uploads/1a2b3c4d/q3-earnings.pdf`);
    expect(nested).toMatchObject({ name: "q3-earnings.pdf" });
    const [bare] = splitAttachments(`${FILE_PREFIX} notes.md`);
    expect(bare).toMatchObject({ path: "notes.md", name: "notes.md" });
  });

  test("indentation and a trailing space are forgiven, because they are the same line", () => {
    expect(splitAttachments(`   ${FILE_PREFIX} outputs/prices.csv  \n`)).toEqual([
      { kind: "file", path: "outputs/prices.csv", name: "prices.csv" },
    ]);
  });

  test("a line still being written is prose until its newline arrives", () => {
    // Half a path is a link to a file that does not exist, offered to somebody who may well click
    // it. While the turn is streaming the unterminated last line is therefore held back — and the
    // delta that ends the line is what turns it into a chip.
    const growing = `here it is\n${FILE_PREFIX} outputs/nvda-pri`;
    expect(splitAttachments(growing, false)).toEqual([{ kind: "text", text: growing }]);

    const whole = `here it is\n${FILE_PREFIX} outputs/nvda-prices.csv`;
    expect(splitAttachments(whole, false)).toEqual([{ kind: "text", text: whole }]);
    expect(splitAttachments(`${whole}\n`, false)).toEqual([
      { kind: "text", text: "here it is\n" },
      { kind: "file", path: "outputs/nvda-prices.csv", name: "nvda-prices.csv" },
    ]);

    // The durable reading is the default, because every message read back from the SDK's store has
    // stopped growing and a file alone on the wire has no trailing newline at all.
    expect(splitAttachments(whole, true)).toEqual(splitAttachments(whole));
    expect(splitAttachments(whole)).toEqual([
      { kind: "text", text: "here it is\n" },
      { kind: "file", path: "outputs/nvda-prices.csv", name: "nvda-prices.csv" },
    ]);
  });

  test("a line inside a fenced block is being quoted rather than used", () => {
    // The same doctrine `decorateMentions` follows for a mention inside `code` or `pre`: a block
    // that shows somebody the syntax is showing it. The prompt teaches this grammar inside a fence,
    // so an agent quoting its own instructions is the case that arrives first.
    const quoted = `Write it like this:\n\`\`\`\n${FILE_PREFIX} outputs/prices.csv\n\`\`\``;
    expect(splitAttachments(quoted)).toEqual([{ kind: "text", text: quoted }]);

    const tilded = `~~~\n${FILE_PREFIX} outputs/prices.csv\n~~~`;
    expect(splitAttachments(tilded)).toEqual([{ kind: "text", text: tilded }]);

    // A fenced block written by the READER is the same case and the only one left. The composer
    // once wrote a fence of its own — a half-filled form's values as JSON, whose field could hold
    // this sentence and must not become a link — and both the editors and that block are gone; a
    // message is the reader's words now, so the fences in one are the ones they typed.
    const asked = `\`\`\`\n${FILE_PREFIX} is how I say it, right?\n\`\`\``;
    expect(splitAttachments(asked)).toEqual([{ kind: "text", text: asked }]);

    // And the block having closed is what lets the next one count.
    const after = `\`\`\`\n${FILE_PREFIX} outputs/quoted.csv\n\`\`\`\n${FILE_PREFIX} outputs/real.csv`;
    expect(splitAttachments(after)).toEqual([
      { kind: "text", text: `\`\`\`\n${FILE_PREFIX} outputs/quoted.csv\n\`\`\`\n` },
      { kind: "file", path: "outputs/real.csv", name: "real.csv" },
    ]);
  });

  test("the prefix with nothing after it is the sentence it appears to be", () => {
    for (const said of [
      FILE_PREFIX,
      `${FILE_PREFIX} `,
      // Two spaces is not the grammar, and reading a path with a leading space out of it would be a
      // chip pointing at a file nobody wrote.
      `${FILE_PREFIX}  outputs/prices.csv`,
      // Nor is anything glued to the front of it, or a second sentence sharing the row.
      `See: ${FILE_PREFIX} outputs/prices.csv`,
    ]) {
      expect(splitAttachments(said)).toEqual([{ kind: "text", text: said }]);
    }
  });
});

describe("the URL the chip links to", () => {
  test("encodes each segment and keeps the separators", () => {
    expect(fileHref("outputs/q3 report.csv")).toBe("/api/files/outputs/q3%20report.csv");
    expect(fileHref("uploads/1a2b3c4d/notes.md")).toBe("/api/files/uploads/1a2b3c4d/notes.md");
    // Encoding the whole path would spell the slashes `%2F` and address one file whose name has
    // slashes in it, which is not a file this route can have.
    expect(fileHref("a/b/c.txt").split("/")).toHaveLength(6);
    // The two characters that would otherwise hand back a different file entirely: a fragment and a
    // query are not part of a path.
    expect(fileHref("outputs/q3#final?.csv")).toBe("/api/files/outputs/q3%23final%3F.csv");
    expect(fileHref("outputs/財報.csv")).toBe(
      `/api/files/outputs/${encodeURIComponent("財報.csv")}`,
    );
    // A path is a path. The prefix goes in front of every one of them and the colon of a scheme is
    // escaped with everything else, so nothing a message says can be drawn as a `javascript:` link.
    expect(fileHref("javascript:alert(1)")).toBe("/api/files/javascript%3Aalert(1)");
  });

  test("is the route the server actually answers", () => {
    // The prefix is mirrored in `lib/attachments.ts` rather than imported, for the reason
    // `lib/protocol.ts` mirrors the server's types by hand: an import out of `src/` would drag
    // `node:fs` into a browser bundle. This is what the mirror costs.
    expect(fileHref("outputs/prices.csv").startsWith(FILES_URL_PREFIX)).toBe(true);
  });
});

describe("the two directions of one grammar", () => {
  test("what the composer writes is what this reads back", () => {
    // The upload direction end to end: a chip is flattened into the message at send, the message is
    // all that crosses the wire, and the reader's own attachment is drawn from the text of it a week
    // later. A spelling either half got wrong on its own would pass every hand-written expectation
    // above and still lose the file.
    const first = "uploads/1a2b3c4d/q3 earnings.pdf";
    const second = "uploads/5e6f7a8b/財報.csv";
    const dropped: readonly ComposerChip[] = [
      { kind: "file", token: "t-1", name: "q3 earnings.pdf", path: first },
      { kind: "file", token: "t-2", name: "財報.csv", path: second },
    ];
    expect(splitAttachments(serializeOutgoing(dropped, "what is in these"))).toEqual([
      { kind: "file", path: first, name: "q3 earnings.pdf" },
      { kind: "file", path: second, name: "財報.csv" },
      { kind: "text", text: "what is in these" },
    ]);
  });

  test("the prompt teaches the same line in both directions", async () => {
    // `outgoing.ts` exports `FILE_PREFIX` on the promise that a test holds the prompt's wording to
    // it. This is that test. A model taught one spelling while the window reads another hands back
    // files nobody can download, and nothing in either half would fail on its own.
    const markdown = await Bun.file(
      resolve(import.meta.dir, "../src/claudecode/prompts/system.md"),
    ).text();

    for (const heading of ["Files the user drags in", "Files you hand back"]) {
      const taught = section(markdown, heading);
      expect(taught).toContain(FILE_PREFIX);
      // Stronger than the substring: the example the model is shown, read with the grammar the
      // window reads messages with, is one file and nothing else.
      const shown = taught.split("\n").find((line) => line.startsWith(FILE_PREFIX));
      expect(shown).toBeDefined();
      expect(splitAttachments(shown ?? "")).toMatchObject([{ kind: "file" }]);
    }
  });
});

/** One `##` section of the prompt, up to the next one. Sliced rather than searched whole, so that a
 * prefix taught in one direction and dropped from the other is a failure rather than a pass. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = markdown.slice(start + 1);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}
