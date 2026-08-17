/**
 * A modal confirmation, for the destructive things in this window.
 *
 * Driven by the store rather than by props: `requestConfirm()` returns a promise, this renders
 * whatever is pending, and the caller reads as one sentence — `if (await requestConfirm(…)) …`.
 * A per-caller dialog component would put a copy of the focus handling below into every panel that
 * deletes something.
 *
 * CANCEL takes the focus, not Confirm. A dialog that acts on Enter, opened by a stray keystroke, is
 * a dialog that deletes on a stray keystroke. Focus returns to whatever opened it, which matters
 * more here than the trap does: the controls that open these are revealed on hover and focus, so a
 * keyboard that lost its place would have nothing visible to come back to.
 *
 * THE MAGNET IN THE CORNER IS A THIRD WAY TO CANCEL, and it used to be a drawing of one. This dialog
 * is a sheet of paper held up to the reader, and on every other sheet in this window the rust stone
 * at the top right takes the paper down — the board teaches that once, in words, for all of them
 * (`GraphPanel.tsx`). A decorative stone in the one place the reader has been taught to press is the
 * worst version of that vocabulary: it answers a learned gesture with nothing. So it is a real
 * button, it cancels, and it is `aria-label`led with the dialog's own cancel word rather than a
 * generic "close" — the two are the same act and must not read as two.
 *
 * IT CANCELS AND COULD NEVER CONFIRM. Taking a sheet off a board is the gesture that puts the
 * question away; wiring the destructive answer to a stone the hand reaches for by habit is how
 * somebody deletes a record by tidying up.
 */

import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, MouseEvent, ReactElement } from "react";

import { resolveConfirm, useConfirm } from "../state/store.ts";
import "../styles/paper.css";
import "./ConfirmDialog.css";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog(): ReactElement | null {
  const request = useConfirm();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const open = request !== null;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      // The opener may have gone with the row it belonged to; the browser then focuses the body,
      // which is the right answer rather than something to work around.
      opener?.focus();
    };
  }, [open]);

  if (request === null) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      resolveConfirm(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    ).filter((element) => !element.hasAttribute("disabled"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Only a press on the backdrop ITSELF dismisses, so a drag that ends outside the box does not.
  // Dismissing is the safe direction anyway: it cancels.
  const onBackdropMouseDown = (event: MouseEvent<HTMLElement>): void => {
    if (event.target === event.currentTarget) resolveConfirm(false);
  };

  return (
    <div className="confirm__backdrop" onMouseDown={onBackdropMouseDown} onKeyDown={onKeyDown}>
      <div
        className="confirm paper"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        ref={boxRef}
      >
        {/* A question is a note held up under a rust magnet: the sheet is a trim layer under the
            words and the magnet is the close, same construction as every note (see NoteBoard.tsx).
            It is FIRST in the box, so a tab from the focused Cancel walks Confirm and then reaches
            it — the destructive answer is never the thing Tab lands on out of the gate. */}
        <span className="paper__sheet" data-deckle={0} aria-hidden="true" />
        <button
          type="button"
          className="confirm__close paper__magnet paper__magnet--red"
          aria-label={request.cancelLabel}
          title={request.cancelLabel}
          onClick={() => resolveConfirm(false)}
        />
        <h2 className="confirm__title" id={titleId}>
          {request.title}
        </h2>
        <p className="confirm__body" id={bodyId}>
          {request.body}
        </p>
        <div className="confirm__actions">
          <button
            type="button"
            className="btn btn--ghost"
            ref={cancelRef}
            onClick={() => resolveConfirm(false)}
          >
            {request.cancelLabel}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => resolveConfirm(true)}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
