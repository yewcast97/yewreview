/**
 * A row block, drawn as a card.
 *
 * THIS IS THE WINDOW'S HALF OF A CONTRACT WITH THE AGENT. The doctrine tells it that every row it
 * shows — a draft on its way to being recorded, a correction to a standing row, a row somebody
 * asked to see whole — is written as a `~~~row` fence holding an indent outline
 * (`src/claudecode/prompts/system.md`, "Showing a row"; `CONSENT` in `src/tools/common.ts` says it
 * again on every tool that writes one of the user's documents). `lib/rowBlock.ts` reads that
 * outline; this builds what the reader sees.
 *
 * A CONVENTION ON THE WIRE IS EXACTLY WHAT THIS SHEET USED TO REFUSE, and the refusal is worth
 * naming because it was argued and is now reversed. Every table in an answer used to be dressed as
 * a record card on the theory that a table is usually a row put up for agreement — no fence, no tag,
 * nothing to detect, because "a convention only the model remembers is a convention that fails
 * silently on the turn it forgets". What changed is that the fallback is no longer silence: a fence
 * this parser cannot read is left as a code block, so a forgotten grammar costs the CARD and shows
 * the outline as typed, `****` and all. That is a legible failure, and it buys the thing plain
 * markdown could not give — one shape for every row, with the unfilled fields visible as questions
 * and a program inside a value still a program.
 *
 * BUILT BY HAND, like the mention pills and the code chrome beside it: the call site is a pass over
 * DOM that came out of `innerHTML`, where there is no React root to mount into.
 *
 * THREE KINDS OF VALUE REACH THE PAGE THREE DIFFERENT WAYS, and each is the safe one for what it
 * carries. A table name, a field name and the `****` mark go through `textContent`, because they are
 * short identifiers and nothing about them is markup. Prose goes through `renderMarkdown`, so a
 * recipe's headings and lists arrive as headings and lists — sanitised, the same path every other
 * word the agent says takes. A program goes through the shared code chrome, which colours it with a
 * tokeniser that escapes every character. There is no fourth path, and no string reaches
 * `innerHTML` here that has not been through one of those two.
 */

import { renderMarkdown } from "../lib/markdown.ts";
import { UNFILLED } from "../lib/rowBlock.ts";
import type { RowBlock, RowValue } from "../lib/rowBlock.ts";
import { buildCodeBlock } from "./codeChrome.ts";
import "./RowCard.css";

/** The row as a card: the table it belongs to, then a field at a time. */
export function buildRowCard(block: RowBlock, live: boolean): HTMLElement {
  const card = document.createElement("div");
  card.className = "rowcard";

  const head = document.createElement("div");
  head.className = "rowcard__table";
  head.textContent = block.table;
  card.append(head);

  for (const field of block.fields) {
    const row = document.createElement("div");
    row.className = "rowcard__field";

    const name = document.createElement("div");
    name.className = "rowcard__name";
    name.textContent = field.name;

    row.append(name, valueOf(field.value, live));
    card.append(row);
  }

  return card;
}

function valueOf(value: RowValue, live: boolean): HTMLElement {
  if (value.kind === "code") {
    const holder = document.createElement("div");
    holder.className = "rowcard__value rowcard__value--code";
    holder.append(buildCodeBlock(value.code, value.lang, live));
    return holder;
  }

  const holder = document.createElement("div");
  if (value.kind === "empty") {
    holder.className = "rowcard__value rowcard__value--empty";
    holder.textContent = UNFILLED;
    holder.title = "Not filled in yet";
    return holder;
  }

  // NO SECOND SET OF PROSE RULES. The card is drawn inside the `.markdown` host, so `markdown.css`'s
  // paragraph, list and heading rules already reach in here as descendants — a long value, and a
  // recipe is a whole document, is set exactly like the prose around it. `RowCard.css`
  // adds only the margin trim at the value's edges.
  holder.className = "rowcard__value";
  holder.innerHTML = renderMarkdown(value.text);
  return holder;
}
