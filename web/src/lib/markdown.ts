/**
 * Text rendered as markdown — the agent's answers and the recipe preview, both reaching the DOM
 * through the one component (`MarkdownView`) that consumes this module.
 *
 * Sanitising is mandatory here, and not as a matter of hygiene. The agent has WebSearch and
 * WebFetch: what it says can quote HTML it found on the open web, verbatim, without either the agent
 * or the user intending anything by it — and a recipe is a stored document whose bytes this
 * window did not write either. This origin is not a document — it drives an agent that
 * spends money, reads files and writes scripts. A single injected `<script>` on this page would be
 * running with the whole app's reach, so every string that reaches `innerHTML` goes through
 * DOMPurify, with no path around it.
 *
 * Three specifics of the configuration:
 *   - `style`, `form` and `input` are forbidden outright. Nothing legitimate in an assistant's
 *     answer needs them, and each is a way to make this page look like it is asking for something.
 *   - Links are forced to open in a new tab with `rel="noopener noreferrer"`, so a cited page can
 *     neither reach back into this window nor take it over.
 *   - The default URI filter is kept rather than replaced, which is what keeps `javascript:` out of
 *     an `href` — the one rewrite here happens after that filter has already run.
 */

import DOMPurify from "dompurify";
import type { Config } from "dompurify";
import { marked } from "marked";

/** GFM, because tables and fenced code are how the agent shows a grid of cells and a script. */
marked.setOptions({ gfm: true, breaks: false });

const SANITIZE_CONFIG: Config = {
  // HTML only: an answer has no need of inline SVG or MathML, and both are large attack surfaces.
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    "style",
    "form",
    "input",
    "button",
    "select",
    "textarea",
    "label",
    "iframe",
    "object",
    "embed",
    "link",
    "meta",
    "base",
  ],
  FORBID_ATTR: ["style", "srcset", "formaction", "action", "ping"],
};

let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // Runs after the URI filter, so an href that survives to here is one of the allowed schemes.
    if (!(node instanceof Element) || node.tagName !== "A") return;
    if (!node.hasAttribute("href")) return;
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  });
}

/** Markdown to HTML that is safe to set as `innerHTML`. The only way this module renders text. */
export function renderMarkdown(text: string): string {
  installHooks();
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

// -- streaming -------------------------------------------------------------------------------------

const FRAME_MS = 16;

export type MarkdownStream = {
  /** The whole text so far. Parsing happens at most once per animation frame, not once per token. */
  update(text: string): void;
  /** Parse now. A finished message must not wait for a frame that a hidden tab will never run. */
  flush(): void;
  cancel(): void;
};

/**
 * A markdown parse per animation frame, whatever the token rate.
 *
 * Deltas arrive far faster than a display refreshes, and parsing plus sanitising a growing document
 * for each of them is the one place this UI could plausibly fall behind the agent. Coalescing to a
 * frame keeps the cost proportional to what is actually seen.
 */
export function createMarkdownStream(emit: (html: string) => void): MarkdownStream {
  let pending: string | null = null;
  let handle: number | null = null;
  let usedFrame = false;

  const run = (): void => {
    handle = null;
    if (pending === null) return;
    const text = pending;
    pending = null;
    emit(renderMarkdown(text));
  };

  const cancel = (): void => {
    if (handle === null) return;
    if (usedFrame) cancelAnimationFrame(handle);
    else window.clearTimeout(handle);
    handle = null;
  };

  return {
    update(text: string): void {
      pending = text;
      if (handle !== null) return;
      // A hidden tab has no useful rAF; a 16 ms timer is the same budget and still runs there.
      usedFrame = typeof requestAnimationFrame === "function";
      handle = usedFrame ? requestAnimationFrame(run) : window.setTimeout(run, FRAME_MS);
    },
    flush(): void {
      cancel();
      run();
    },
    cancel(): void {
      cancel();
      pending = null;
    },
  };
}
