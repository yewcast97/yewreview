/**
 * The chrome a block of machine text wears in rendered prose, built by hand.
 *
 * TWO PASSES NEED THE SAME OBJECT, which is the whole reason this is its own module. `MarkdownView`
 * replaces every completed fence in an answer with it, and `rowCard` puts one inside a row block's
 * card wherever a field's value is a program — a script's source, a thesis's `dsl_json`. Those are
 * the same thing on screen and they must not be two builders that drift on the first tweak.
 *
 * BUILT WITH `createElement` RATHER THAN AS A COMPONENT because there is no React root at either
 * call site: both are decorating DOM that came out of `innerHTML`. `CodeBlock.tsx` is the React
 * component that draws a stored script on a note, and it wears the same classes from the same
 * stylesheet — this is that object, made where React cannot reach.
 *
 * THE ONE `innerHTML` HERE SKIPS THE SANITISER ON PURPOSE, and the argument is `lib/highlight.ts`'s:
 * shiki never parses its input, it matches a grammar against text and builds the tree itself, so
 * every character of the source comes out as an escaped text node. Passing it through DOMPurify
 * instead would strip the `style` attributes the colours live in and protect nothing. The source
 * that reaches the tokeniser is always `textContent` off already-sanitised markup, or a string a
 * parser collected from it.
 */

import { fenceLang, highlightFence, needsLineNumbers } from "../lib/highlight.ts";

/**
 * What a completed fence tokenised to last time, keyed by the language and the code together.
 *
 * A live paint rebuilds the whole document once per animation frame, so an answer that has been
 * streaming for a minute repaints its earlier fences several thousand times — and a row card is
 * rebuilt with them, so its code value pays the same toll. Tokenising is linear in the source and
 * cheap, but not three thousand times cheap. Cleared on the settled paint, which is also when the
 * message stops changing, so the map's whole life is one turn.
 */
const tokenised = new Map<string, string>();

/** Forget what this turn tokenised. Called once per settled paint, before the passes run. */
export function clearFenceMemo(): void {
  tokenised.clear();
}

/** The word after the backticks, as `marked` leaves it: a `language-…` class on the `<code>`. An
 * unlabelled fence has none, and is reported as plain text rather than as a guess. */
export function languageOf(code: Element): string {
  for (const name of code.classList) {
    if (name.startsWith("language-")) return name.slice("language-".length);
  }
  return "";
}

/**
 * One block of machine text, coloured and dressed.
 *
 * The language shown is the writer's OWN word rather than the grammar it resolved to: they said
 * `sql`, nothing here can colour sql, and a header claiming `text` would be this window quietly
 * correcting them. `fenceLang` decides the colouring; the header reports the claim.
 */
export function buildCodeBlock(source: string, token: string, live: boolean): HTMLElement {
  const key = `${token} ${source}`;
  let html = tokenised.get(key);
  if (html === undefined) {
    html = highlightFence(source, token);
    if (live) tokenised.set(key, html);
  }

  const wrapper = document.createElement("div");
  wrapper.className = needsLineNumbers(source) ? "codeblock codeblock--numbered" : "codeblock";

  const head = document.createElement("div");
  head.className = "codeblock__head";

  const lang = document.createElement("span");
  lang.className = "codeblock__lang";
  // As TEXT, so a fence labelled `<script>` writes those characters rather than becoming one.
  lang.textContent = token === "" ? fenceLang(token) : token;
  head.append(lang);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "codeblock__copy";
  copy.textContent = "copy";
  copy.title = "Copy this block";
  copy.setAttribute("aria-label", "Copy this code block");
  // The source rides on the button rather than being read back off the coloured markup at press
  // time: what the reader gets is what went to the tokeniser, before it was cut into spans.
  copy.dataset["code"] = source;
  head.append(copy);

  const body = document.createElement("div");
  body.className = "codeblock__body";
  body.innerHTML = html;

  wrapper.append(head, body);
  return wrapper;
}
