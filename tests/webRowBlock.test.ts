/**
 * Reading a row block.
 *
 * EVERYTHING HERE IS REAL: the parser is pure and DOM-free, so these tests are the function itself
 * with no seam of any kind. Nothing is faked because there is nothing to fake.
 *
 * WHAT IS BEING PINNED IS TOLERANCE, and it is worth saying why that is the interesting property.
 * The author of a row block is a language model writing markdown into a chat message; the grammar
 * asks it for two-space indents and it will sometimes give three, or a tab, or a value whose second
 * line does not line up with its first. A parser that required the grammar exactly would answer
 * `null` on a row that reads perfectly well to a person, and the reader would be shown a grey code
 * block instead of the record they are being asked to agree to.
 *
 * SO THE TWO HALVES OF THE CONTRACT ARE TESTED TOGETHER. It reads sloppy input the way a person
 * would; and where the input is not a row at all it answers `null` rather than guessing, because
 * `null` is what puts every character on screen through the fallback. The last test in the file is
 * the one that matters most in production: this runs inside the paint of every message, so it must
 * never throw, whatever it is handed.
 */

import { describe, expect, test } from "bun:test";

import { UNFILLED, parseRowBlock } from "../web/src/lib/rowBlock.ts";
import type { RowBlock } from "../web/src/lib/rowBlock.ts";

/** The example the doctrine teaches, byte for byte — the shape the agent is told to write, every
 * field the tool takes included, the unsettled ones as `****`. */
const SPEC = `information_source
  source
    FRED
  type
    ****
  domain
    US macro series: policy rates, employment, CPI, industrial production.
  method
    Download the CSV endpoint under /graph/fredgraph.csv rather than scraping the chart page.
  hosts
    fred.stlouisfed.org
  failure_cases
    ****
  auth_env
    ****
`;

/** Field names in order, which is the thing a reader scans for. */
function names(block: RowBlock | null): string[] {
  return (block?.fields ?? []).map((field) => field.name);
}

function valueOf(block: RowBlock | null, name: string): RowBlock["fields"][number]["value"] {
  const field = (block?.fields ?? []).find((candidate) => candidate.name === name);
  if (field === undefined) throw new Error(`no field called ${name}`);
  return field.value;
}

describe("the shape the doctrine teaches", () => {
  test("the example in the prompt parses into the row it draws", () => {
    const block = parseRowBlock(SPEC);
    expect(block?.table).toBe("information_source");
    expect(names(block)).toEqual([
      "source",
      "type",
      "domain",
      "method",
      "hosts",
      "failure_cases",
      "auth_env",
    ]);
    expect(valueOf(block, "source")).toEqual({ kind: "text", text: "FRED" });
    expect(valueOf(block, "hosts")).toEqual({ kind: "text", text: "fred.stlouisfed.org" });
    // The optional fields the drafter has not settled are IN the block as the question they are —
    // the completeness rule the prompt states, carried by its own example.
    expect(valueOf(block, "failure_cases")).toEqual({ kind: "empty" });
    expect(valueOf(block, "auth_env")).toEqual({ kind: "empty" });
  });

  test("`****` is a field nobody has filled in yet", () => {
    // The one mark for it, and the reason the agent is told to write it rather than leave the line
    // out: an absent field reads as a decision, and this reads as the question it is.
    expect(valueOf(parseRowBlock(SPEC), "type")).toEqual({ kind: "empty" });
    expect(UNFILLED).toBe("****");
  });

  test("a field with no value under it is the same question", () => {
    const block = parseRowBlock("workshop\n  name\n  created_at\n    ****\n");
    expect(names(block)).toEqual(["name", "created_at"]);
    expect(valueOf(block, "name")).toEqual({ kind: "empty" });
    expect(valueOf(block, "created_at")).toEqual({ kind: "empty" });
  });

  test("a table with no fields yet is still a row", () => {
    // The agent naming what it is about to fill in. Nothing is wrong with it, and the card draws
    // the header on its own.
    expect(parseRowBlock("thesis\n")).toEqual({ table: "thesis", fields: [] });
  });
});

describe("indentation as the model actually writes it", () => {
  test("the field indent is measured rather than required", () => {
    // Three spaces, and the values four past that. The grammar says two; this reads the same.
    const block = parseRowBlock("script\n   name\n       nvda-close\n   domain\n       prices\n");
    expect(block?.table).toBe("script");
    expect(names(block)).toEqual(["name", "domain"]);
    expect(valueOf(block, "name")).toEqual({ kind: "text", text: "nvda-close" });
  });

  test("a tab is two columns, which is the grammar's own unit", () => {
    const block = parseRowBlock("target\n\tticker\n\t\tNVDA\n\tmarket\n\t\tNASDAQ\n");
    expect(names(block)).toEqual(["ticker", "market"]);
    expect(valueOf(block, "ticker")).toEqual({ kind: "text", text: "NVDA" });
  });

  test("a value whose later lines wander keeps the shape it was given", () => {
    // The first value line sets the margin; what a later line has PAST that margin is the value's
    // own — a markdown list under a playbook heading has to survive this.
    const block = parseRowBlock(
      "playbook\n  content\n    ## Scope\n    - semis only\n      - and their suppliers\n",
    );
    expect(valueOf(block, "content")).toEqual({
      kind: "text",
      text: "## Scope\n- semis only\n  - and their suppliers",
    });
  });

  test("a blank line inside a value belongs to it, and one between fields divides nothing", () => {
    const block = parseRowBlock(
      "playbook\n  content\n    one\n\n    two\n\n  name\n    semis playbook\n",
    );
    expect(names(block)).toEqual(["content", "name"]);
    expect(valueOf(block, "content")).toEqual({ kind: "text", text: "one\n\ntwo" });
    expect(valueOf(block, "name")).toEqual({ kind: "text", text: "semis playbook" });
  });

  test("windows line endings are the same document", () => {
    const block = parseRowBlock("workshop\r\n  name\r\n    semis quarterly\r\n");
    expect(valueOf(block, "name")).toEqual({ kind: "text", text: "semis quarterly" });
  });

  test("blank lines around the whole thing are padding", () => {
    expect(parseRowBlock("\n\nworkshop\n  name\n    semis\n\n\n")?.table).toBe("workshop");
  });
});

describe("a value that is a program", () => {
  test("a fenced value is code, with the word the writer put on the fence", () => {
    const block = parseRowBlock(
      "script\n  source\n    ```python\n    print(1)\n    ```\n",
    );
    expect(valueOf(block, "source")).toEqual({
      kind: "code",
      lang: "python",
      code: "print(1)",
    });
  });

  test("the program is dedented against the value's margin and keeps its own indentation", () => {
    const block = parseRowBlock(
      "script\n  source\n    ```python\n    def f():\n        return 1\n    ```\n",
    );
    expect(valueOf(block, "source")).toEqual({
      kind: "code",
      lang: "python",
      code: "def f():\n    return 1",
    });
  });

  test("inside the fence the indent rules are suspended", () => {
    // The load-bearing one. A line at column zero inside a program is the program's, not a second
    // table — and a blank line in it is the author's paragraphing rather than padding between
    // fields. Without the suspension this whole block would answer `null`.
    const block = parseRowBlock(
      "script\n  source\n    ```python\nimport pandas\n\n    x = 1\n    ```\n  name\n    loader\n",
    );
    expect(valueOf(block, "source")).toEqual({
      kind: "code",
      lang: "python",
      code: "import pandas\n\nx = 1",
    });
    expect(names(block)).toEqual(["source", "name"]);
  });

  test("a field name inside the fence is a line of code", () => {
    // Two spaces in and spelled exactly like a field, and it must not end the program. It comes out
    // at the margin because it sits shallower than the value does and the dedent takes what indent
    // it has — there is no such thing as a negative column.
    const block = parseRowBlock("script\n  source\n    ```python\n  name = 1\n    ```\n");
    expect(valueOf(block, "source")).toEqual({ kind: "code", lang: "python", code: "name = 1" });
  });

  test("a fence the model never closed is still the program", () => {
    // It stopped writing — mid-stream, or because it lost count of backticks. The code is what it
    // wrote, and showing it coloured is better than showing the reader a fence.
    const block = parseRowBlock("script\n  source\n    ```python\n    print(1)\n");
    expect(valueOf(block, "source")).toEqual({ kind: "code", lang: "python", code: "print(1)" });
  });

  test("an empty fence is an empty program rather than prose", () => {
    const block = parseRowBlock("script\n  source\n    ```python\n    ```\n");
    expect(valueOf(block, "source")).toEqual({ kind: "code", lang: "python", code: "" });
  });

  test("a fence with no word on it is code in no particular language", () => {
    const block = parseRowBlock("thesis\n  dsl_json\n    ```\n    {}\n    ```\n");
    expect(valueOf(block, "dsl_json")).toEqual({ kind: "code", lang: "", code: "{}" });
  });

  test("four backticks are a longer run, not a language", () => {
    const block = parseRowBlock(
      "script\n  source\n    ````python\n    ```\n    ````\n",
    );
    expect(valueOf(block, "source")).toEqual({ kind: "code", lang: "python", code: "```" });
  });

  test("writing after a closed fence makes the whole value prose, and hides nothing", () => {
    // The alternative is a parser that decides which half of the value the author meant. The
    // markdown renderer shows a fence inside prose perfectly well, so nothing is lost by keeping
    // all of it.
    const block = parseRowBlock(
      "script\n  source\n    ```python\n    print(1)\n    ```\n    and then it prints.\n",
    );
    expect(valueOf(block, "source")).toEqual({
      kind: "text",
      text: "```python\nprint(1)\n```\nand then it prints.",
    });
  });
});

describe("what is not a row", () => {
  test("nothing at the margin, because there is no table to name", () => {
    expect(parseRowBlock("  name\n    semis\n")).toBeNull();
  });

  test("a second line at the margin, because two roots is a different document", () => {
    expect(parseRowBlock("workshop\n  name\n    semis\nthesis\n  name\n    x\n")).toBeNull();
  });

  test("nothing written at all", () => {
    expect(parseRowBlock("")).toBeNull();
    expect(parseRowBlock("\n  \n\n")).toBeNull();
  });

  test("`null` is the whole error contract, and prose is what it protects", () => {
    // A paragraph somebody fenced by mistake is several lines at the margin, which is the rule
    // above doing its job. The caller renders a `null` as an ordinary code block, so every
    // character survives — which is why this answers `null` rather than salvaging a table name and
    // throwing the rest away.
    expect(parseRowBlock("Here is what I would store:\n\nIt has four fields.\n")).toBeNull();
    expect(
      parseRowBlock("Here is what I would store.\n  It has four fields.\nAnd a name.\n"),
    ).toBeNull();
  });
});

describe("running inside every paint", () => {
  test("it never throws, whatever it is handed", () => {
    // This runs on each animation frame of a streaming answer. An exception here would take the
    // transcript down with it, so the contract is a value or `null` and never a throw.
    const nasty = [
      "",
      " ",
      "a\n".repeat(5000),
      "x\n  y\n" + "    ```\n".repeat(200),
      "```\n```\n```",
      "table\n  field\n" + " ".repeat(10_000) + "deep\n",
      "table\n\t\t\t\t\n  f\n\tv\n",
      "🙂\n  🙃\n    ****\n",
    ];
    for (const body of nasty) expect(() => parseRowBlock(body)).not.toThrow();
  });

  test("a row block the size of a playbook is still one pass", () => {
    const content = Array.from({ length: 400 }, (_, i) => `    line ${i}`).join("\n");
    const block = parseRowBlock(`playbook\n  content\n${content}\n`);
    expect(valueOf(block, "content").kind).toBe("text");
  });
});
