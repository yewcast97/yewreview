/**
 * Colouring a script, and colouring a fence in the conversation.
 *
 * The interesting assertions here are not about which token comes out purple — that is the theme's
 * business and testing it would be testing shiki. They are about the two contracts this window
 * depends on and would not notice breaking:
 *
 * EVERY CHARACTER IS ESCAPED, because both callers put this string into `innerHTML` without a
 * sanitiser in front of it. That is safe precisely and only because shiki tokenises its input rather
 * than parsing it, and the tests below are what hold that claim to account against a version bump.
 *
 * IT MATTERS MORE FOR A FENCE THAN FOR A SCRIPT, which is why the escaping tests run over both. A
 * stored script was written through `create_script` by an agent this installation is already
 * trusting with a shell; a fence is prose in a chat message, and the agent has WebSearch and
 * WebFetch, so its contents can be HTML quoted verbatim off the open web without anybody intending
 * anything by it. `lib/markdown.ts` sanitises the prose around it — and cannot be used ON it,
 * because it strips the `style` attributes the colours live in — so this is the whole of the
 * argument for that block.
 *
 * AND THE LINE COUNT AGREES WITH THE MARKUP. `needsLineNumbers` decides whether to draw a gutter and
 * CSS counters draw it off the `.line` spans in the HTML, so two different pieces of code are
 * counting the same lines. They agree because both normalise through the same private function; the
 * test pins that, because a shiki release that changed how a trailing newline becomes a span would
 * otherwise show up as numbers running one past the end of a program nobody thought had changed.
 */

import { describe, expect, test } from "bun:test";

import {
  SCRIPT_LANG,
  fenceLang,
  highlightFence,
  highlightScript,
  needsLineNumbers,
  scriptLineCount,
} from "../web/src/lib/highlight.ts";

/** Ten lines, which is exactly the threshold — the shortest program that gets a gutter. */
const TEN = Array.from({ length: 10 }, (_, i) => `x${i} = ${i}`).join("\n");

describe("what a script is written in", () => {
  test("python, and it is not a guess", () => {
    // Every run in this product is `[venv.python, program, ...]` and the `script` table has no
    // interpreter column, so there is nothing to sniff and nothing to choose.
    expect(SCRIPT_LANG).toBe("python");
  });
});

describe("counting a program's lines", () => {
  test("a trailing newline is a terminator, not another line", () => {
    // Left alone it becomes a final empty `.line` span: a numbered blank row under the last
    // statement, and one more line than the reader would say the program has.
    expect(scriptLineCount("a = 1\nb = 2\n")).toBe(2);
    expect(scriptLineCount("a = 1\nb = 2\n\n\n")).toBe(2);
  });

  test("a program with nothing in it has no lines", () => {
    expect(scriptLineCount("")).toBe(0);
    expect(scriptLineCount("\n")).toBe(0);
  });

  test("one statement is one line", () => {
    expect(scriptLineCount("import pandas")).toBe(1);
  });

  test("blank lines inside the program are lines", () => {
    // They are the author's paragraphing and they occupy a row on screen, so a gutter has to number
    // them or every number below the gap is wrong.
    expect(scriptLineCount("a = 1\n\nb = 2")).toBe(3);
  });
});

describe("whether a program gets a gutter", () => {
  test("ten lines is the threshold", () => {
    expect(needsLineNumbers(TEN)).toBe(true);
    expect(needsLineNumbers(TEN.split("\n").slice(0, 9).join("\n"))).toBe(false);
  });

  test("a trailing newline does not push a short program over it", () => {
    // The stored form of a script almost always ends in one, so this is the ordinary case rather
    // than the edge one: nine lines plus a terminator must not draw a gutter for ten.
    expect(needsLineNumbers(`${TEN.split("\n").slice(0, 9).join("\n")}\n`)).toBe(false);
  });

  test("nothing at all gets no gutter", () => {
    expect(needsLineNumbers("")).toBe(false);
  });
});

describe("colouring it", () => {
  test("the block wears One Dark Pro's own ground", () => {
    // The stylesheet states the same hex, so the head strip and the rounded corners have something
    // to sit on before this has painted. If the theme moves, they have to move together.
    const html = highlightScript("x = 1");
    expect(html).toContain('class="shiki');
    expect(html).toContain("background-color:#282c34");
  });

  test("tokens are actually coloured", () => {
    expect(highlightScript("def f():\n    return 1")).toContain('style="color:');
  });

  test("every character of the program arrives as text", () => {
    // The claim `CodeBlock.tsx` relies on to skip the sanitiser: shiki builds the tree from tokens,
    // so markup in a script is six characters somebody typed and never a tag.
    const html = highlightScript('s = "<script>alert(1)</script>&"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)</script>");
    expect(html).toContain("&#x3C;");
    expect(html).toContain("&#x26;");
  });

  test("the markup has exactly as many lines as the count says", () => {
    // The one that matters across a version bump: the gutter is drawn off these spans and the
    // decision to draw it at all is made off `scriptLineCount`, and the two must not drift.
    for (const code of ["a = 1\nb = 2\n", "a = 1\n\nb = 2", "import pandas", TEN]) {
      const spans = highlightScript(code).match(/class="line"/g)?.length ?? 0;
      expect(spans).toBe(scriptLineCount(code));
    }
  });
});

describe("which grammar a fence's own word resolves to", () => {
  test("the three machine texts written here, and their ordinary spellings", () => {
    // Three grammars because three are what gets written in this conversation: a DSL document is
    // json, a command being explained is a shell line, a program is python. The aliases are the
    // spellings a writer actually types rather than an exhaustive list — `py` and `sh` are how
    // fences get labelled in practice, and a word this map misses costs the colour and nothing else.
    expect(fenceLang("python")).toBe("python");
    expect(fenceLang("py")).toBe("python");
    expect(fenceLang("python3")).toBe("python");
    expect(fenceLang("json")).toBe("json");
    expect(fenceLang("jsonc")).toBe("json");
    expect(fenceLang("bash")).toBe("bash");
    expect(fenceLang("sh")).toBe("bash");
    expect(fenceLang("shell")).toBe("bash");
    expect(fenceLang("zsh")).toBe("bash");
    expect(fenceLang("console")).toBe("bash");
  });

  test("case and surrounding space are the writer's, not the grammar's", () => {
    // A fence is typed by hand into prose. `Python` is the same claim as `python`, and a trailing
    // space is a typo rather than a different language.
    expect(fenceLang("Python")).toBe("python");
    expect(fenceLang("  JSON  ")).toBe("json");
    expect(fenceLang("BASH")).toBe("bash");
  });

  test("everything else is plaintext, including the unlabelled fence", () => {
    // `text` is shiki's OWN plaintext grammar rather than a failure path: it returns the same
    // markup, with the same escaping and the same one span per line, so the chrome, the gutter and
    // the safety argument all hold for a language nobody here can colour.
    expect(fenceLang("")).toBe("text");
    expect(fenceLang("sql")).toBe("text");
    expect(fenceLang("rust")).toBe("text");
    expect(fenceLang("yewreview-draft")).toBe("text");
  });

  test("`row` is plaintext too, which is what makes the card's fallback legible", () => {
    // A row block is a `~~~row` fence that `MarkdownView` normally replaces with a card. When
    // `parseRowBlock` cannot read it the block stays a fence and comes through here instead, so the
    // reader gets the outline as the agent typed it — indentation, `****` and all — rather than a
    // card built out of a guess. There is deliberately no `row` grammar: what a fallback owes the
    // reader is every character, not colour.
    expect(fenceLang("row")).toBe("text");
  });
});

describe("colouring one fence out of a conversation", () => {
  /**
   * The load-bearing one. Fence contents are model-authored prose, and the model quotes the web.
   *
   * Asserted by RECOVERING the text rather than by looking for forbidden substrings, which is the
   * difference between testing the property and testing a guess about it. `onerror` survives in the
   * output as five characters of a token span's text, and a test banning the word would fail on a
   * block that is perfectly safe while passing on one that wrote `<b>` as an actual element. What
   * matters is that every `<` the source carried is a `&#x3C;` in the output: strip the markup shiki
   * built, put the entities back, and the input has to come out the other side unchanged.
   */
  test("hostile contents come out as characters, in every registered grammar", () => {
    const hostile = "<script>alert(1)</script> & <img src=x onerror=alert(1)> \u00e9";
    for (const token of ["python", "json", "bash", "sql", ""]) {
      const html = highlightFence(hostile, token);
      // The text comes back byte for byte, so nothing was swallowed or transformed on the way…
      expect(textOf(html)).toBe(hostile);
      // …and the only ELEMENTS in the output are the three shiki builds itself. Together these say
      // the whole thing: every `<` the source carried is a character in the result, not a tag.
      expect([...new Set([...html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1]))].sort()).toEqual(
        ["code", "pre", "span"],
      );
    }
  });

  test("a fence is shiki's own block, so one stylesheet dresses both callers", () => {
    // `MarkdownView` puts this inside the same `.codeblock` chrome a script note wears, and that
    // only works because the two calls return the same shape.
    const html = highlightFence("print('hi')", "python");
    expect(html).toContain('<pre class="shiki');
    expect(html).toContain("<code>");
    expect(html).toContain('class="line"');
  });

  test("an unknown language still gets the block, just not the colour", () => {
    const known = highlightFence("SELECT 1", "sql");
    expect(known).toContain('<pre class="shiki');
    expect(known).toContain("SELECT 1");
  });

  test("a fence past the cap falls to plaintext rather than freezing the tab", () => {
    // The same argument as `highlightScript`'s: tokenising is synchronous, and a quarter of a
    // megabyte is not a slow render but a window that stops answering. Above the cap the identical
    // call runs against the plaintext grammar, which does no matching at all.
    const huge = `x = 1\n`.repeat(20_000);
    const html = highlightFence(huge, "python");
    expect(html).toContain('<pre class="shiki');
    // Plaintext emits one span per line and no token spans inside them, which is what makes the
    // cheap path cheap. A coloured pass over the same source would carry `style` on the tokens.
    expect(html.split('class="line"').length - 1).toBe(20_000);
  });

  test("the line count it draws is the count the gutter is decided by", () => {
    // Two different pieces of code counting the same lines: `needsLineNumbers` decides whether the
    // wrapper gets `--numbered`, and CSS counters draw the digits off the `.line` spans. They agree
    // because both normalise the trailing newline through the same private function.
    const ten = `${Array.from({ length: 10 }, (_, i) => `x${i} = ${i}`).join("\n")}\n`;
    expect(needsLineNumbers(ten)).toBe(true);
    expect(scriptLineCount(ten)).toBe(10);
    expect(highlightFence(ten, "python").split('class="line"').length - 1).toBe(10);
  });
});

/**
 * The text a browser would show, recovered from shiki's markup without a DOM.
 *
 * Deliberately naive about entities — five named forms and the numeric ones shiki actually emits —
 * because a general HTML parser here would be a second implementation of the thing under test. If
 * shiki ever emitted an entity this misses, the round-trip fails loudly rather than passing on a
 * comparison neither side understood.
 */
function textOf(html: string): string {
  return html
    .replace(/^<pre[^>]*><code>/, "")
    .replace(/<\/code><\/pre>$/, "")
    .replace(/<\/?span[^>]*>/g, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
