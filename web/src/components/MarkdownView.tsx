/**
 * Rendered markdown, as one component — every painted-prose surface in the window goes through
 * here, which is what keeps the safety argument in one place.
 *
 * PROSE REACHES THE DOM THROUGH `innerHTML`, so the sanitising in `lib/markdown.ts` is the whole of
 * this component's safety and there is deliberately no path around it. `paint` below is the only
 * assignment to `innerHTML` ON THIS PATH, and it lives here rather than in each consumer — the
 * agent's answers and the recipe preview are two of them — because two copies of an `innerHTML`
 * site is two places a sanitiser can quietly stop being in front of.
 *
 * THERE IS EXACTLY ONE OTHER `innerHTML` IN THE WINDOW, and it is named here so that "the only one"
 * never has to be re-established by grepping. `CodeBlock.tsx` paints a highlighted script, and it
 * deliberately does NOT use the sanitiser above — which is the opposite decision to this file's and
 * is sound for the opposite reason. This component turns somebody's markdown INTO markup, so the
 * markup is the payload and has to be filtered. That one never parses its input at all: shiki
 * tokenises the source and builds the tree itself, so every character of the program is escaped on
 * the way out, and the thing DOMPurify would strip on the way through is the `style` attribute
 * carrying the colours. A sanitiser there would remove the whole point and protect nothing.
 *
 * Rendering is imperative rather than `dangerouslySetInnerHTML`, because the mention pass has to
 * walk the sanitised tree afterwards anyway. Walking text nodes AFTER DOMPurify has run is the only
 * correct order: rewriting the markdown first would let a mention-shaped string decide what the
 * sanitiser sees, and re-serialising the sanitised tree back through `innerHTML` would hand it a
 * second chance to parse. Mention pills are built with `createElement`/`textContent`, never by
 * splicing markup into a string — a record id is server data, and the only way to be sure it lands
 * as text is to put it there as text.
 *
 * `live` is for a turn still streaming: the text goes through `createMarkdownStream`, which parses
 * at most once per animation frame. Deltas arrive far faster than a display refreshes, and parsing
 * plus sanitising a growing document per delta is the one place this window could fall behind the
 * agent.
 *
 * `mentions` is opt-in because the two consumers disagree about what an `@table:id` in the prose
 * IS. In the agent's answer it is the agent pointing at a record, and a pill that opens it is the
 * point; in a recipe it is the DOCUMENT quoting its own grammar — instructions about mentions,
 * not mentions — and rewriting a specification's text into live controls would be this window
 * editing what the document says.
 *
 * A PILL SAYS WHAT THE RECORD IS CALLED, AND THE PROSE ALREADY SAYS IT. The mention carries
 * `@table:name`, so the paint below has nothing to look up: it writes the name it read. That was not
 * true while the wire carried a uuid, and the directory this file used to consult on every paint —
 * plus the fetch it fired for a miss, plus the subscription that repainted when one landed — went
 * with the grammar. What is left is a walk that turns text into buttons.
 *
 * OPENING ONE IS THE STORE'S JOB, because that is where turning a name back into an id lives. It
 * happens on the press and not on sight — see `MentionPill.tsx`, which makes the same argument for
 * the React-rendered pills.
 *
 * A FENCED CODE BLOCK IS COLOURED AFTER SANITISING, which is the one thing in this file that looks
 * like a shortcut and is not. The colours shiki emits are inline `style` attributes and
 * `lib/markdown.ts` forbids that attribute outright, so highlighting BEFORE the sanitiser would mean
 * either losing every colour or letting `style` through on markup the model wrote — and `style` on
 * model-authored markup is a fixed overlay over this page. So the fence is highlighted afterwards,
 * from its own `textContent`: the string that skips the sanitiser is not the model's markup, it is
 * built here from text that has already been through it, by a tokeniser that escapes every character
 * it emits. That is the same argument `CodeBlock.tsx` makes for a stored script, and it does not
 * weaken when the author is the model rather than the archive.
 *
 * WHAT IS NOT TOKENISED IS THE FENCE STILL BEING WRITTEN. A live paint rebuilds the whole document
 * every animation frame, and the last block of an unfinished message is a fence whose contents change
 * on every one of them — so the trailing block is left plain while the turn streams and coloured when
 * it lands. Every earlier fence is complete and is coloured immediately, memoised so the sixty
 * repaints a long answer costs pay for one pass each rather than sixty.
 *
 * A `~~~row` FENCE IS A RECORD RATHER THAN A PROGRAM, and it is claimed one pass earlier. The agent
 * writes every row it shows in that one grammar — an indent outline, `****` where a field is not
 * filled in yet, a program inside a value as its own backtick fence — and `decorateRowCards` turns
 * it into the card in `rowCard.ts`. The interception is by INFO STRING and not by fence character,
 * so a row block written with backticks is read the same way; the tildes are what let the inner
 * fences nest without escaping. A block this window cannot parse keeps the ordinary code chrome,
 * which is the whole fallback: the reader sees the outline as the agent typed it rather than a card
 * built out of a guess.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import type { MouseEvent, ReactElement } from "react";

import type { MarkdownStream } from "../lib/markdown.ts";
import { COPIED_MS, copyToClipboard } from "../lib/clipboard.ts";
import { createMarkdownStream, renderMarkdown } from "../lib/markdown.ts";
import { findMentions, isMentionTable } from "../lib/mention.ts";
import { parseRowBlock } from "../lib/rowBlock.ts";
import { openNamedRecord } from "../state/store.ts";
import { buildCodeBlock, clearFenceMemo, languageOf } from "./codeChrome.ts";
import { buildRowCard } from "./rowCard.ts";
import "./CodeBlock.css";
import "./markdown.css";

export function MarkdownView({
  text,
  live = false,
  mentions = false,
}: {
  text: string;
  live?: boolean;
  mentions?: boolean;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MarkdownStream | null>(null);

  // Layout rather than passive, so the height is right before anything that watches its own scroll
  // position — the message list deciding whether it is still at the bottom — reads it. An effect
  // that ran after paint would let a finished message land one frame below the fold.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    if (!live) {
      // The final text, parsed now. A document that is done must not wait for a frame a hidden tab
      // will never run.
      streamRef.current?.cancel();
      paint(host, renderMarkdown(text), mentions, false);
      return;
    }
    streamRef.current ??= createMarkdownStream((html) => {
      const target = hostRef.current;
      if (target !== null) paint(target, html, mentions, true);
    });
    streamRef.current.update(text);
  }, [text, live, mentions]);

  useEffect(() => () => streamRef.current?.cancel(), []);

  // One delegated handler for however many pills the prose grew, because the pills are DOM this
  // component wrote by hand and React has no listener to attach to them.
  //
  // Keyed on `data-mention-table` and reading only the table and the name, which is the whole of
  // what opening a record needs. `data-mention-column` is carried on the pill for the same reason
  // the label shows it — it is what the sentence said — and is deliberately not part of what the
  // click asks for: the field is on screen already once the record is open, and a column selection
  // beside the record selection would be a second thing that can disagree with the first.
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    // One handler for both kinds of hand-built control, because both are DOM this component wrote
    // and React has nothing to attach a listener to.
    const copyButton =
      event.target instanceof Element ? event.target.closest(".codeblock__copy") : null;
    if (copyButton instanceof HTMLElement) {
      copyFence(copyButton);
      return;
    }
    if (!mentions) return;
    const target =
      event.target instanceof Element ? event.target.closest("[data-mention-table]") : null;
    if (!(target instanceof HTMLElement)) return;
    const table = target.dataset["mentionTable"];
    const name = target.dataset["mentionName"];
    if (table === undefined || name === undefined || !isMentionTable(table)) return;
    void openNamedRecord(table, name);
  };

  return <div className="markdown" ref={hostRef} onClick={onClick} />;
}

/** Sanitised HTML in, decorated DOM out. The only assignment to `innerHTML` on the PROSE path; the
 * one other in this window is `CodeBlock.tsx`, argued in both files' headers.
 *
 * ROW CARDS BEFORE CODE BLOCKS, because a card puts a code block of its own into the document and
 * the pass below must find those already dressed rather than dress them twice. Both run before the
 * mention walk: replacing a `<pre>` wholesale would otherwise invalidate text nodes the walker had
 * already collected. Mentions skip `pre` and `code` anyway, so the passes never touch the same node
 * — the order is about the walker, not about the rules.
 *
 * The memo is cleared here rather than inside a pass, because two passes share it now and the turn
 * it belongs to is the one this paint is settling. */
function paint(host: HTMLElement, html: string, mentions: boolean, live: boolean): void {
  host.innerHTML = html;
  if (!live) clearFenceMemo();
  decorateRowCards(host, live);
  decorateCodeBlocks(host, live);
  if (mentions) decorateMentions(host);
}

/**
 * Turn every `@table:id` in the rendered prose — and every `@table:id#column`, which names one field
 * of one — into a button that opens that record in the record panel.
 *
 * Text nodes are collected before any of them is replaced: replacing one while the walker is
 * standing on it moves the walker into the fragment that just replaced it, and the rest of the
 * paragraph is never visited.
 *
 * Mentions inside a link, `code` or `pre` are left alone. Inside a code span the author is QUOTING
 * the grammar rather than using it — that is exactly how it would show somebody the syntax — and a
 * pill there would be this window rewriting an example into a live control.
 */
function decorateMentions(host: HTMLElement): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue;
    const parent = node.parentElement;
    if (parent !== null && parent.closest("a, code, pre") !== null) continue;
    if (node.data.includes("@")) targets.push(node);
  }
  for (const node of targets) replaceMentions(node);
}

function replaceMentions(node: Text): void {
  const text = node.data;
  const found = findMentions(text);
  if (found.length === 0) return;

  const fragment = document.createDocumentFragment();
  let at = 0;
  for (const mention of found) {
    if (mention.start > at) fragment.append(text.slice(at, mention.start));
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "markdown__mention";
    pill.dataset["mentionTable"] = mention.table;
    pill.dataset["mentionName"] = mention.name;
    // Set only when the mention had one, so "no column" stays absent from the dataset rather than
    // becoming an empty attribute — the same distinction `Mention.column` makes, kept across the
    // one hop where it would be easiest to lose.
    if (mention.column !== undefined) pill.dataset["mentionColumn"] = mention.column;
    pill.title = `Open this ${mention.table} in a note`;
    // Assigned as text, so a name that happens to contain markup is a name. The `#column` is part of
    // the label because it is part of what the author wrote: a pill that showed only the row would
    // be this window quietly generalising a sentence about one field.
    pill.textContent =
      mention.column === undefined ? mention.name : `${mention.name} #${mention.column}`;
    fragment.append(pill);
    at = mention.end;
  }
  if (at < text.length) fragment.append(text.slice(at));
  node.replaceWith(fragment);
}

// -- row blocks -----------------------------------------------------------------------------------

/** The info string that says a fence is a record rather than a program. */
const ROW_FENCE = "row";

/**
 * Replace every readable `~~~row` fence with the card in `rowCard.ts`.
 *
 * THE LAST BLOCK IS LEFT ALONE WHILE THE TURN IS LIVE, on the same over-approximation the pass
 * below makes and for a sharper reason: a row block arrives field by field, so a card built from
 * half of one would show a record with fields missing — which is exactly what `****` is supposed to
 * mean, and it would mean it about a row the agent had not finished writing. Left as a plain fence
 * it reads as the outline it is, and the settled paint draws the card.
 *
 * A FENCE THIS CANNOT PARSE IS LEFT WHERE IT IS, which is the whole fallback and the reason the
 * grammar is safe to depend on. `parseRowBlock` answers `null` rather than guessing, the pass below
 * then gives the block the ordinary code chrome, and the reader sees every character the agent
 * typed. Nothing is ever hidden by this window failing to recognise it.
 */
function decorateRowCards(host: HTMLElement, live: boolean): void {
  const blocks = [...host.querySelectorAll("pre")];
  if (blocks.length === 0) return;
  const last = blocks.length - 1;

  for (const [index, pre] of blocks.entries()) {
    if (live && index === last) continue;
    const code = pre.querySelector("code");
    if (code === null || languageOf(code) !== ROW_FENCE) continue;
    // `textContent` for the same reason the fence pass reads it: what the parser is handed is the
    // outline as text, already through the sanitiser, never markup.
    const block = parseRowBlock(code.textContent ?? "");
    if (block === null) continue;
    pre.replaceWith(buildRowCard(block, live));
  }
}

// -- fenced code ----------------------------------------------------------------------------------

/**
 * Replace every fenced code block with the same chrome a script note wears.
 *
 * THE LAST BLOCK IS LEFT ALONE WHILE THE TURN IS LIVE. An unfinished fence is necessarily the last
 * thing `marked` has produced, so "last `pre` in the document, and the document is still arriving"
 * over-approximates "still being written" — safely, and without asking this component to parse
 * markdown a second time to find out. The settled paint colours everything.
 *
 * A `pre` ALREADY INSIDE A CODE BLOCK IS ONE THIS PASS PUT THERE, by way of a row card built a
 * moment ago: shiki's own `<pre class="shiki">` lives inside the chrome, and wrapping it a second
 * time would draw the object inside itself. A `pre` inside a row card's PROSE value is a different
 * thing — a fence the agent wrote into a field's text — and it is dressed here like any other.
 */
function decorateCodeBlocks(host: HTMLElement, live: boolean): void {
  const blocks = [...host.querySelectorAll("pre")];
  if (blocks.length === 0) return;
  const last = blocks.length - 1;

  for (const [index, pre] of blocks.entries()) {
    if (live && index === last) continue;
    if (pre.closest(".codeblock") !== null) continue;
    const code = pre.querySelector("code");
    if (code === null) continue;
    // `textContent` and not `innerHTML`: what goes to the tokeniser is the program as text, which is
    // the whole of why its output is safe to assign without a sanitiser. See this file's header.
    const source = code.textContent ?? "";
    if (source === "") continue;
    pre.replaceWith(buildCodeBlock(source, languageOf(code), live));
  }
}

/**
 * Copy one block, and say so on the button for a moment.
 *
 * THE WORD IS WRITTEN INTO THE NODE RATHER THAN INTO STATE, because there is no React root at this
 * point in the document: this button was built by hand, for the same reason the mention pills were,
 * and nothing here can hold a flag for it. That is the whole of why this is not `useCopied` — the
 * rest of the gesture is `lib/clipboard.ts`'s, absent-clipboard check and timing together, so a
 * fence and a script say "copied" for the same moment.
 */
function copyFence(button: HTMLElement): void {
  const code = button.dataset["code"];
  if (code === undefined) return;
  void copyToClipboard(code).then((landed) => {
    if (!landed) return;
    button.textContent = "copied";
    // The next paint replaces this button outright, so there is nothing to clean up on unmount:
    // the timeout writes to a node that is either still on screen or already unreachable.
    setTimeout(() => {
      button.textContent = "copy";
    }, COPIED_MS);
  });
}
