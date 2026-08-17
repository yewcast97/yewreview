/**
 * A script, coloured, on a note.
 *
 * WHY THIS IS NOT A `<pre>` LIKE EVERY OTHER PROMOTED COLUMN. The prose blocks on a record — a
 * thesis, a recipe, an assessment, the line a recorded command ran — are written by somebody to be
 * read as language, and `NoteBoard.tsx` argues at its own rule why they get a `<pre>` and nothing
 * else: a markdown pass over them would turn an underscore in a ticker into italics and change what
 * the record says. A script is the one promoted column that is not language. It is a program, the
 * reader is auditing it, and the things they are auditing for — which of these is a string, is that
 * `=` or `==`, where does this block end — are exactly what colour answers at a glance and what a
 * uniform grey wall hides. So this is the carve-out, and it is one table wide.
 *
 * THE SECOND `innerHTML` IN THIS WINDOW, and the only other one is `MarkdownView.paint`. That one
 * runs its input through DOMPurify because it is turning somebody's markdown into markup and the
 * markup is the point. This one must NOT: shiki does not parse the source, it tokenises it and
 * builds the tree itself, so every character of the program comes out escaped — and the colours are
 * inline `style` attributes, which is precisely what that sanitiser's config strips. Running it here
 * would produce a correctly-sanitised grey block. `lib/highlight.ts` states the safety claim at the
 * function that makes it.
 *
 * THE COPY BUTTON COPIES WHAT IS STORED, not what is shown. The trailing newline the display drops
 * goes back on, because the reader pressing it is taking the program somewhere to run it, and a
 * script is a file rather than a picture of one.
 */

import { useLayoutEffect, useRef, type ReactElement } from "react";

import { copyToClipboard, useCopied } from "../lib/clipboard.ts";
import { SCRIPT_LANG, highlightScript, needsLineNumbers } from "../lib/highlight.ts";
import "./CodeBlock.css";

export function CodeBlock({ code }: { code: string }): ReactElement {
  const host = useRef<HTMLDivElement | null>(null);
  const { copied, flash } = useCopied();

  // Layout rather than passive, for `MarkdownView.paint`'s reason: the block is measured by the note
  // it is in — a sized note gives its body the leftover room — and painting after the browser has
  // already shown an empty div is a visible reflow on every open.
  useLayoutEffect(() => {
    const node = host.current;
    if (node === null) return;
    node.innerHTML = highlightScript(code);
  }, [code]);

  function copy(): void {
    // The whole gesture — the absent-clipboard check, the copy that answers instead of throwing, and
    // the one moment every copy control in this window says "copied" for — is `lib/clipboard.ts`'s,
    // stated there once. A copy that did not land leaves the label alone: the word is a report of
    // what happened, not of what was pressed.
    void copyToClipboard(code).then((landed) => {
      if (landed) flash();
    });
  }

  return (
    <div className={needsLineNumbers(code) ? "codeblock codeblock--numbered" : "codeblock"}>
      <div className="codeblock__head">
        <span className="codeblock__lang">{SCRIPT_LANG}</span>
        <button
          type="button"
          className="codeblock__copy"
          // The head of the note is a drag handle and so is the corner; this block sits between
          // them and its own presses are nobody else's business.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={copy}
          aria-label="Copy this script"
          title="Copy the whole script"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <div className="codeblock__body" ref={host} />
    </div>
  );
}
