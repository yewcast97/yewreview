/**
 * An ⓘ beside a label, and the sentence it is hiding.
 *
 * WHAT THIS AVOIDS IS A WALL OF PARAGRAPHS. A field's explanation as a permanent `<p>` under the
 * input — what a hostname list may contain, what the type vocabulary means, what happens to a
 * credential name left blank — is genuinely worth reading, ONCE. Read once and then permanent, those
 * sentences turn an eight-field source form into a page of prose with boxes in it, and a reader
 * looking for the field they came to change has to scan past four explanations to find it. The note
 * is not the problem; being unable to put it away is.
 *
 * A POPOVER AND NOT A `title=`, which is the obvious cheaper answer and is wrong on three counts: a
 * title attribute is mouse-only, so half the readers never learn the explanation exists; it appears
 * after a delay the page cannot set; and it cannot be styled, so it would be the one piece of this
 * window drawn by the operating system. This is the same construction the health read-out already
 * uses in the opposite corner — a sheet of paper, always mounted, hidden by `visibility` — and it is
 * copied deliberately rather than invented, so the window has one popover and not two.
 *
 * `open` IS ONE TRUTH, and the stylesheet has exactly one selector reading it. Hover opens it, focus
 * opens it, a click toggles it (which is the whole of the touch story); it closes on Escape, on a
 * press outside, on a scroll, on the pointer leaving, and on focus leaving. It is not a `:hover`
 * rule the component knows nothing about, because then `aria-expanded` would say `false` over a
 * panel that is plainly open — the same trap `HealthBadge` documents. There is no
 * `:focus-within` rule either, for a sharper version of the same reason: Escape closes the state
 * without moving focus, so a `:focus-within` rule would hold the sheet on screen over an
 * `aria-expanded="false"` button with no second Escape able to reach it. `InfoDot.css` argues it at
 * the rule.
 *
 * THE CLICK MUST `preventDefault`, and this is the one line here that is not obvious. These sit
 * inside the `<label>` a form field wraps itself in, and a click anywhere in a label is forwarded to
 * the labelled control — so without it, reading the note about a field would also put a caret in it,
 * and on a checkbox it would toggle the thing being explained.
 *
 * IT IS `position: fixed` AND PLACED BY MEASUREMENT, which is the one piece of arithmetic in here
 * and it is not optional. These dots live on forms inside notes, and a note's body is a scroll
 * container — `overflow-y: auto` — so an absolutely positioned sheet is CLIPPED by it. In practice
 * that means the explanation on any field in the lower half of a form is cut off mid-sentence, which
 * is worse than a wall of paragraphs: at least a wall can be read. A fixed element
 * is not clipped by an ancestor's overflow, so the sheet escapes the note and is placed against the
 * viewport instead.
 *
 * Fixed costs a measurement, and the measurement is what buys the flip: the sheet goes UNDER the dot
 * unless there is no room below, in which case it goes above, and it is clamped so it never hangs
 * off either side. Read once per opening in a layout effect — before paint, so nothing is ever seen
 * at the wrong place — and never per frame.
 *
 * WHAT MAKES `fixed` SAFE HERE is that nothing between this and the viewport carries a transform, a
 * filter or a `will-change`; any of those would make an ancestor the containing block and the sheet
 * would be clipped again. The note itself is untransformed (it has no tilt — see `NoteBoard.css`),
 * and the deckle filter is on an inert SIBLING layer rather than on an ancestor. If a tilt is ever
 * given to notes, this breaks, and the symptom is exactly the clipping it exists to avoid.
 *
 * THE PAPER TRAVELS WITH IT rather than being inherited: `paper` is on the sheet's own element, so
 * the ink remap answers inside it wherever it is placed. That is also why this is not a
 * portal — a portal would work for the clipping and would put the sheet outside the note's stacking
 * context for no gain, since fixed already leaves the overflow behind.
 *
 * IT CLOSES ON SCROLL, because a fixed sheet placed against a dot that then scrolls away would sit
 * over the form pointing at nothing. Closing is the honest answer and costs the reader one hover.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";

import "./InfoDot.css";

/** How far the sheet stays off the window's edges, and off the dot it belongs to. */
const MARGIN = 12;
const GAP = 4;

export function InfoDot({
  about,
  children,
}: {
  /** What the note explains — the column or control it sits beside. Read out as "About <this>", so
   * a screen reader hears which of eight ⓘ's on a form it has landed on. */
  about: string;
  /** The explanation. Frontend prose, baked at build time, in the note hand. */
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const root = useRef<HTMLSpanElement | null>(null);
  const dot = useRef<HTMLButtonElement | null>(null);
  const sheet = useRef<HTMLSpanElement | null>(null);
  /** Whether the pointer is over this dot. A ref rather than state because nothing renders from it —
   * it exists so the two ways OUT of a note can each check that the other is not still in it. */
  const hovering = useRef(false);
  const id = useId();

  /**
   * Where the sheet goes, decided once per opening.
   *
   * A LAYOUT EFFECT so the placement lands before the browser paints — a passive effect would show
   * the sheet at its last position for one frame, which on the first open is the corner of the
   * window. The sheet is measured while it is still `visibility: hidden`, which is exactly why it is
   * always mounted: hidden by visibility it still has a box, so its height is knowable before anyone
   * has seen it.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const button = dot.current;
    const pop = sheet.current;
    if (button === null || pop === null) return;
    const b = button.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const left = Math.min(
      Math.max(b.left, MARGIN),
      Math.max(MARGIN, window.innerWidth - p.width - MARGIN),
    );
    // Under the dot, unless the sheet would run off the bottom — then above it. Never both: a sheet
    // taller than the window pins to the top margin and scrolls with nothing, which is the honest
    // failure and is not reachable with the widths these notes carry.
    const below = b.bottom + GAP;
    const top =
      below + p.height > window.innerHeight - MARGIN
        ? Math.max(MARGIN, b.top - p.height - GAP)
        : below;
    setAt({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && root.current?.contains(target)) return;
      setOpen(false);
    };
    // A fixed sheet placed against a dot that then scrolls away would sit over the form pointing at
    // nothing. Capture, because the scroll that matters is a note body's rather than the document's,
    // and those do not bubble.
    const onScroll = (): void => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key !== "Escape" || !open) return;
    // Stopped, so Escape spent on this note is not also spent on the editor around it — a field
    // being edited treats Escape as "put the textarea away", and closing both at once would look
    // like the note swallowed the reader's work.
    event.stopPropagation();
    setOpen(false);
  };

  return (
    /*
     * THE TWO WAYS IN ARE HOVER AND FOCUS, AND EACH HAS TO CLOSE WITHOUT CLOSING THE OTHER'S. The
     * pointer leaving does not put the sheet away while the keyboard is still in it, and focus
     * leaving does not put it away while the pointer is still over it — otherwise a reader who
     * tabbed to a dot and then moved the mouse, or who hovered one and then tabbed the form, has the
     * explanation taken off the screen mid-sentence.
     *
     * `onBlur` IS NOT OPTIONAL, and its absence is the failure worth naming: these dots sit inside
     * the `<label>` of every hinted field, so a form's tab order runs ⓘ → input → ⓘ → input. Without
     * a close on focus loss, tabbing through a source form opens every dot in turn and leaves all of
     * them open — a stack of opaque sheets over the very inputs being tabbed into, none of which
     * Escape can reach, because Escape is bound to the dot's own span and focus is in the input by
     * then. React's `onBlur` is `focusout` and therefore bubbles, which is what lets one handler on
     * the root answer for the button inside it.
     */
    <span
      className="infodot"
      ref={root}
      onKeyDown={onKeyDown}
      onPointerEnter={() => {
        hovering.current = true;
        setOpen(true);
      }}
      onPointerLeave={() => {
        hovering.current = false;
        if (!root.current?.contains(document.activeElement)) setOpen(false);
      }}
      onBlur={(event) => {
        // Moving focus WITHIN the dot — button to sheet — is not leaving it.
        const next = event.relatedTarget;
        if (next instanceof Node && root.current?.contains(next)) return;
        if (hovering.current) return;
        setOpen(false);
      }}
    >
      <button
        ref={dot}
        type="button"
        className="btn btn--icon infodot__btn"
        aria-label={`About ${about}`}
        aria-expanded={open}
        aria-controls={id}
        onFocus={() => setOpen(true)}
        // See the header: a click in a label is forwarded to the labelled control, and reading a
        // note about a field must not also start editing it.
        onClick={(event) => {
          event.preventDefault();
          setOpen((held) => !held);
        }}
        // The forms this sits in are inside notes whose heads are drag handles; nothing here is on
        // one, but a control that stops its own press costs nothing and cannot be caught out by a
        // handler added above it later.
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span aria-hidden="true">ⓘ</span>
      </button>
      {/* Always mounted, hidden by `visibility`: a hover reveals it with no state change to wait
          for, a keyboard still cannot land inside something nobody has opened, and — the reason it
          matters here — it can be MEASURED before it is seen, which is what the placement above
          needs. */}
      <span
        ref={sheet}
        className="infodot__pop paper"
        id={id}
        role="note"
        data-open={open || undefined}
        style={at === null ? undefined : { top: at.top, left: at.left }}
      >
        {children}
      </span>
    </span>
  );
}
