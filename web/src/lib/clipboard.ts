/**
 * Copying, as one gesture stated once.
 *
 * THREE CONTROLS IN THIS WINDOW PUT TEXT ON THE CLIPBOARD — the stored script on a note
 * (`CodeBlock.tsx`), a fenced block inside the agent's prose (`MarkdownView.tsx`, built by hand
 * because there is no React root at that point in the document) and a whole agent turn
 * (`AssistantMessage.tsx`). They are one gesture wearing three labels, and what they share lives
 * here: the reader must not learn two durations for one word, and a guard written in three places is
 * a guard that is two edits away from being written in two.
 *
 * `navigator.clipboard` IS ABSENT ENTIRELY OUTSIDE A SECURE CONTEXT, which is not hypothetical here:
 * the server binds to localhost by default, where the API exists, but `--host` puts it on a LAN
 * address and a browser on another machine then reaches it over plain http. The absence is CHECKED
 * rather than left to a catch, because reading `.writeText` off `undefined` throws a TypeError
 * synchronously — before any promise exists to reject — so the `.catch` a caller hangs off the chain
 * is never attached to anything, and the press surfaces as an uncaught error rather than as a button
 * that quietly did nothing.
 *
 * SO THE COPY ANSWERS AND NEVER THROWS. A clipboard the browser refused is the browser's answer and
 * not a fault in this window: the caller is told the copy did not land and says nothing, rather than
 * claiming one that did not happen.
 */

import { useEffect, useRef, useState } from "react";

/** How long a control says it worked. Long enough to read after the eye comes back to it, short
 * enough that it is not still claiming it when the reader copies something else. */
export const COPIED_MS = 1_400;

/** Put `text` on the clipboard. False when it could not land — there is no clipboard in this
 * context, or the browser refused this one. See the header for why the first of those is a check
 * rather than a rejection. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const board = navigator.clipboard;
  if (board === undefined) return false;
  try {
    await board.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The React half of the gesture: the flag a label reads, and the timer that puts it back.
 *
 * THE TICK IS CLEARED ON UNMOUNT, because every surface one of these buttons sits on can go away
 * while it is pending — a note is closed or thrown at the Bin, a turn is replaced by the durable
 * copy adoption just took — and a timeout that fires into an unmounted component is a state update
 * React will warn about and nobody asked for.
 *
 * `flash` is called only when the copy actually landed, so the word is a report of what happened
 * rather than of what was attempted.
 */
export function useCopied(): { copied: boolean; flash: () => void } {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return {
    copied,
    flash: () => {
      setCopied(true);
      // A second press restarts the moment rather than adding one: two pending ticks would put the
      // label back while the newer copy is still the one on the clipboard.
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    },
  };
}
