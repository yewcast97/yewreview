/**
 * Colouring a script, so that reading one is reading a program rather than a wall.
 *
 * PURE and DOM-FREE, like `lib/viewer.ts` and the state modules: `bun test` drives it directly under
 * the root tsconfig, which has no DOM in its libs. It hands back a STRING of HTML and never touches
 * an element — `CodeBlock.tsx` is what puts it on the page, and it is the only thing that knows there
 * is a page.
 *
 * A STORED SCRIPT'S LANGUAGE IS PYTHON AND IS NOT A GUESS. The `script` table has no interpreter
 * column and never had one (`src/db/schema.ts`), because there is nothing to choose between: every
 * run in this product is `[venv.python, program, ...]` (`src/tools/runs.ts`), and the field
 * description the agent writes source against says so in as many words — "It runs with the venv
 * python" (`src/tools/scripts.ts`). A sniffer for a shebang would therefore be code that answers a
 * question nobody can ask, and would be wrong the first time somebody pasted a comment that looked
 * like one. `highlightScript` takes no language argument for that reason.
 *
 * A FENCE IN THE CONVERSATION IS THE OTHER CALLER, and it does say what it is. `highlightFence` takes
 * the word off the ``` line and maps it to a registered grammar, which is a different question with a
 * different answer: the agent writes json for a DSL document, bash for a command it is explaining,
 * python for a script it is proposing, and prose fences for everything else. Three grammars are
 * registered and everything else — including every language nobody here writes — falls to shiki's own
 * plaintext, which returns the same markup with the same escaping, so an unknown word costs the
 * colour and nothing else.
 *
 * SYNCHRONOUS AND WITHOUT WASM, which is a choice about this window rather than about speed. Shiki's
 * default engine is oniguruma compiled to WebAssembly, which arrives as a binary the bundler has to
 * emit beside the script and the page has to fetch before it can colour anything — so the note would
 * open with a plain grey block and repaint. The JavaScript engine transpiles the same TextMate
 * patterns to native `RegExp` at startup, which makes the highlighter constructible in one turn and
 * `highlightScript` an ordinary function that returns a value. The published compatibility table
 * lists Python as producing output identical to the WASM engine.
 *
 * THE HIGHLIGHTER IS BUILT ON FIRST USE AND KEPT. Transpiling two hundred-odd patterns is tens of
 * milliseconds and it is paid once, by whoever opens the first script note, rather than by everyone
 * who loads the window — most sessions never open one at all.
 */

import { createHighlighterCoreSync } from "@shikijs/core";
import type { HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import bash from "@shikijs/langs/bash";
import json from "@shikijs/langs/json";
import python from "@shikijs/langs/python";
import oneDarkPro from "@shikijs/themes/one-dark-pro";

/** What a script is written in, and the word the block writes on its own header. */
export const SCRIPT_LANG = "python";

/**
 * The fence words that get a grammar, and the spellings of each that a writer actually uses.
 *
 * THREE, because three are what gets written here. A DSL document is json, a command being explained
 * is a shell line, and a program is python — those are the machine texts this product is about, and
 * a fourth grammar is a few hundred more transpiled patterns bought for a language nobody in this
 * conversation writes. Anything not on this list resolves to `text`, which is shiki's own plaintext
 * grammar rather than a failure: same markup, same escaping, no colour.
 */
const FENCE_LANGS: Record<string, string> = {
  python: "python",
  py: "python",
  python3: "python",
  json: "json",
  jsonc: "json",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
};

/** The grammar a fence's own word resolves to. Case-folded, because a writer may type `Python`. */
export function fenceLang(token: string): string {
  return FENCE_LANGS[token.trim().toLowerCase()] ?? "text";
}

/**
 * The colours.
 *
 * ONE DARK PRO, and it is the one theme in this window that does NOT come from `tokens.css`. Every
 * other surface here is chalk on slate or ink on paper; a code block is neither, because a script is
 * not handwriting — it is the machine's own text, and the reader is auditing it against what they
 * would see in an editor. Its ground is a solid `#282c34`, which satisfies the material law on its
 * own terms: no alpha, nothing showing through.
 */
const THEME = "one-dark-pro";

let highlighter: HighlighterCore | null = null;

function getHighlighter(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    themes: [oneDarkPro],
    langs: [python, json, bash],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

/**
 * What both exports below agree to call the source, so that the number of lines counted is the number
 * of lines drawn.
 *
 * A stored script almost always ends in a newline, and a newline at the end of a file is a
 * terminator rather than another line: left alone it becomes a final empty `.line` span, which is a
 * numbered blank row under the last statement and one more line than the reader would say the
 * program has. Trimming it here — in the one place both the markup and the count are decided — is
 * what keeps those two answers from disagreeing.
 *
 * This is a DISPLAY normalisation and nothing else. The copy button copies the stored string, byte
 * for byte, because what is being audited is what was published.
 */
function forDisplay(code: string): string {
  return code.replace(/\n+$/, "");
}

/**
 * The longest program still worth colouring, in characters.
 *
 * TOKENISING IS SYNCHRONOUS AND THE WINDOW IS NOT ALLOWED TO STOP. A grammar pass is linear in the
 * source and cheap where it matters — a few milliseconds for the few kilobytes a real script runs to,
 * thirty for eight — but `src/tools/scripts.ts` lets a program be a quarter of a megabyte, and
 * at that size the pass measures near six hundred milliseconds. That is not a slow render, it is the
 * whole tab frozen: the note opens, and every other thing in the window stops answering until the
 * tokeniser is finished. Above this cap the same call is made against shiki's built-in plaintext
 * grammar, which does no matching at all and costs about ten milliseconds for the same quarter
 * megabyte.
 *
 * WHAT THE READER LOSES IS ALMOST NOTHING, which is why a cap is the right answer rather than a
 * spinner or a worker. Sixty-four kilobytes of Python is some two thousand lines; nobody is reading
 * that closely through a note four hundred pixels wide, they are scanning it or copying it out, and
 * both of those work exactly as well in one colour. Colour earns its cost on the programs somebody is
 * actually auditing, and every one of those is far under this.
 */
const HIGHLIGHT_LIMIT = 64 * 1024;

/** A script as coloured HTML: shiki's own `<pre class="shiki">` with a span per token.
 *
 * SAFE TO PUT IN `innerHTML` WITHOUT A SANITISER, and this is the claim `CodeBlock.tsx` relies on.
 * The string is built from tokens rather than parsed from the source: every character of the program
 * arrives as a text node and is escaped on the way out, so a script containing `<script>` renders as
 * the six characters somebody typed. It must NOT be passed through `lib/markdown.ts`'s DOMPurify
 * instead — that config forbids `style` attributes, and the colours ARE style attributes.
 *
 * The plaintext fall-back above the cap is the SAME call with a different grammar, deliberately: it
 * returns the same `<pre class="shiki">` with the same ground, the same escaping and the same one
 * span per line, so the stylesheet, the gutter and the safety argument all hold without a second
 * path through this file or through the component. */
export function highlightScript(code: string): string {
  const shown = forDisplay(code);
  const lang = shown.length > HIGHLIGHT_LIMIT ? "text" : SCRIPT_LANG;
  return getHighlighter().codeToHtml(shown, { lang, theme: THEME });
}

/**
 * One fenced code block from a conversation, as coloured HTML.
 *
 * SAME SAFETY CLAIM AS `highlightScript`, and it is worth being explicit about because the input is
 * different in a way that looks like it should matter and does not. A fence's contents are written
 * by the model, and the model can quote anything it found on the open web. But shiki never PARSES
 * its input: it matches a grammar against text and builds the tree itself, so every character comes
 * out as an escaped text node. A fence containing `<script>` renders as those eight characters. That
 * is the same argument that lets a stored script bypass DOMPurify, and it does not weaken when the
 * author changes.
 *
 * The same cap applies, for the same reason: a very long fence is a frozen tab rather than a slow
 * one, and above it the identical call runs against the plaintext grammar.
 */
export function highlightFence(code: string, token: string): string {
  const shown = forDisplay(code);
  const lang = shown.length > HIGHLIGHT_LIMIT ? "text" : fenceLang(token);
  return getHighlighter().codeToHtml(shown, { lang, theme: THEME });
}

/** How many lines the reader would say the program has. */
export function scriptLineCount(code: string): number {
  const shown = forDisplay(code);
  return shown === "" ? 0 : shown.split("\n").length;
}

/**
 * Whether this script is long enough to deserve a gutter.
 *
 * TEN, and the threshold is the whole argument for having one at all. Line numbers are how a reader
 * says WHERE — in a note to somebody else, in a question to the agent, in their own head while
 * scrolling back — and under about ten lines there is no "where" worth naming, because the whole
 * program is one glance. What the numbers cost at that length is a column of grey digits beside four
 * lines of code, which is furniture in a window that has spent a lot of effort not having any.
 */
export function needsLineNumbers(code: string): boolean {
  return scriptLineCount(code) >= 10;
}
