/**
 * The toast host.
 *
 * What surfaces here is a fact about a request the reader can act on — the agent is still working,
 * those instructions are already the operative version, the server is not answering. So
 * there is ONE style and no error variant: a refusal is not a malfunction, and dressing one in red
 * teaches people to distrust the parts of this window that are working correctly. A measurement that
 * came back unwelcome never reaches this component at all.
 *
 * `aria-live="polite"` rather than assertive: none of this interrupts what somebody is reading.
 *
 * DISMISSING IS A MAGNET, because a toast IS paper. It was a `✕` in a 28px icon button, which is the
 * ordinary answer and the wrong one here: every other sheet in this window — the notes, the three
 * corner instruments, the dialog — is taken down by the rust stone in its top-right corner, and the
 * board teaches that gesture once for all of them (`GraphPanel.tsx`). A scrap of the same pad that
 * asked for a different gesture in the same corner would be the one surface the reader has to look
 * at twice. The scrap is square-cut and has no deckled sheet layer under it; the stone sits on the
 * face itself, which is the one thing about it that differs from a note.
 */

import type { ReactElement } from "react";

import { dismissToast, useToasts } from "../state/store.ts";
import "../styles/paper.css";
import "./Toasts.css";

export function Toasts(): ReactElement | null {
  const toasts = useToasts();
  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        // A scrap of the pad: `paper` remaps every token inside it to ink, so the body dresses
        // itself. Square-cut — transient surfaces do not earn the deckle filter.
        <div className="toasts__item paper" key={toast.id}>
          <div className="toasts__body">
            <span>{toast.text}</span>
            {/* The server's own wording, on its own line. Merging it into the sentence above would
                make a sentence neither of them wrote. */}
            {toast.detail === null ? null : <span className="toasts__detail">{toast.detail}</span>}
          </div>
          {/* The magnet is the dismiss — see the header. Out of the flex flow entirely, because
              `.paper__magnet` is absolute; the scrap's right padding is what keeps the sentence out
              from under it. */}
          <button
            type="button"
            className="toasts__close paper__magnet paper__magnet--red"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => dismissToast(toast.id)}
          />
        </div>
      ))}
    </div>
  );
}
