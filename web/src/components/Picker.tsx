/**
 * A short list of words to choose one of, drawn on the board rather than by the machine.
 *
 * WHAT THIS REPLACES IS A `<select>`, and the reason is the one thing about a native select that no
 * stylesheet can reach: the closed control is the page's, and the OPEN LIST IS THE OPERATING
 * SYSTEM'S. Everything else in this window is chalk on slate — a caption in the composer can be
 * stripped of its border, its chrome and its disclosure triangle until it reads as a word in a
 * sentence — and then the moment somebody presses it, a grey system menu in the platform's own
 * typeface lands on the blackboard. A control that is dressed as part of the board for as long as
 * nobody touches it is worse than one that never pretended: the reader learns what this window is
 * made of at exactly the moment they act on it.
 *
 * SO THE LIST IS DRAWN HERE, and drawing it is what buys the rest — it takes the panel's own dust
 * fill and chalk hairline, it can mark which row is current with something other than the platform's
 * blue bar, and the closed control can go on being a caption. What it costs is everything a select
 * gets for nothing: placement, the keyboard, the focus, and knowing when to close. Those are the
 * body of this file, and each of them is a bargain rather than a feature.
 *
 * IT IS `position: fixed` AND PLACED BY MEASUREMENT, which is not a preference. This lives in the
 * conversation dock, whose body is a grid that CLIPS its overflow, and an absolutely
 * positioned sheet is cut off at the composer's own edge — which is to say the list would be
 * invisible, since it opens away from the box it belongs to. Fixed is not clipped by an ancestor's
 * overflow, and it is safe here for the reason `ChatDock.tsx` already states about the dock itself:
 * nothing between this and the body carries a transform, a filter or a `will-change`, so `fixed`
 * still resolves against the viewport.
 *
 * IT OPENS UPWARD by default, which is the opposite of `InfoDot`'s answer and is the same arithmetic
 * asked about a different place. That sheet hangs off a form field somewhere in a note and has room
 * below it far more often than not; this one hangs off a strip pinned to the BOTTOM of the window,
 * where there is never room below and always room above. Downward is kept as the flip, for the
 * window short enough that neither direction is comfortable.
 *
 * THE SHEET IS ALWAYS MOUNTED and hidden by `visibility`, exactly as the window's two popovers are:
 * hidden that way it still has a box, so it can be MEASURED before anybody has seen it, which is
 * what the placement above needs. A keyboard still cannot land in a list nobody has opened, because
 * a `visibility: hidden` subtree is not focusable.
 *
 * OPTION IDS COME FROM THE INDEX AND NEVER FROM THE VALUE. `aria-activedescendant` points at a row
 * by id, and the values this picker is fed are model identifiers off the SDK — strings this window
 * did not choose and has no promise about. An id built out of one is a document id built out of a
 * stranger's string, which collides with whatever else is on the page the day two of them agree.
 * `useId` plus the row's position is a name this component owns outright.
 *
 * THE LIST TAKES THE FOCUS AND THE ROWS NEVER DO, which is the shape every listbox has for a good
 * reason: a menu of five focusable rows is five tab stops in a caption strip, and the reader who
 * tabs into the composer would walk through the model list on the way to the box they wanted to type
 * in. One focusable element and a pointer at the active row says the same thing to a screen reader
 * and costs the tab order nothing.
 *
 * IT CLOSES ON SIX THINGS, and each is a way the sheet could otherwise be left pointing at nothing:
 * a press outside it, a scroll anywhere else in the window, the window being resized, the dock's own
 * edge being dragged, Escape, and focus leaving. The one that is easy to leave out is the scroll, and
 * it is taken in the CAPTURE phase because the scroll that matters is the transcript's rather than
 * the document's, and those do not bubble.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";

import { useDockSplit } from "../state/store.ts";
import "./Picker.css";

/** How far the sheet stays off the window's edges, and off the control it belongs to. The pair
 * `InfoDot` measures with, because this window has one popover geometry drawn in two places. */
const MARGIN = 12;
const GAP = 4;

/** One row: the string that would be sent, and the words the reader chooses by. The two are
 * separate because a model's identifier is not what anybody calls it. */
export type PickerOption = { value: string; label: string };

export function Picker({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  title,
  className,
}: {
  /** What is current. A value the options do not carry is still shown, raw — see the trigger. */
  value: string;
  options: readonly PickerOption[];
  /** Called with the chosen value, and never with the one that is already current. */
  onChange: (value: string) => void;
  disabled: boolean;
  /** What is being chosen, for a reader who cannot see the caption this sits in. */
  ariaLabel: string;
  /** The sentence on the closed control, which on a disabled one is where the reason goes. */
  title: string;
  /** The caller's own class on the root, so a strip can cap the width of the control it holds. */
  className?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  /** Which row the keyboard is on. Not the selection: nothing is chosen until it is committed, so
   * arrowing past four models does not ask the agent to answer in four of them. */
  const [active, setActive] = useState(0);
  const root = useRef<HTMLSpanElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const id = useId();
  const labelId = `${id}-label`;
  const triggerId = `${id}-trigger`;
  const sheetId = `${id}-list`;
  const rowId = (index: number): string => `${id}-row${index}`;

  const chosen = options.find((option) => option.value === value);

  const show = (): void => {
    // Opening lands on what is current rather than on the top of the list: the reader's next
    // keystroke is then a step away from where they are, which is the question they are asking.
    const current = options.findIndex((option) => option.value === value);
    setActive(current < 0 ? 0 : current);
    setOpen(true);
  };

  const commit = (index: number): void => {
    setOpen(false);
    const picked = options[index];
    // Choosing what is already chosen is not a change, and the frames behind these menus are
    // refused or costly enough that asking for one twice is worth not doing.
    if (picked === undefined || picked.value === value) return;
    onChange(picked.value);
  };

  /**
   * Where the sheet goes, decided once per opening.
   *
   * A LAYOUT EFFECT so the placement lands before the browser paints — a passive effect would show
   * the list at its last position for one frame, which on the first open is the corner of the
   * window. It is measured while still hidden by `visibility`, which is what being always mounted
   * is for.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current;
    const sheet = list.current;
    if (button === null || sheet === null) return;
    const b = button.getBoundingClientRect();
    const p = sheet.getBoundingClientRect();
    const left = Math.min(
      Math.max(b.left, MARGIN),
      Math.max(MARGIN, window.innerWidth - p.width - MARGIN),
    );
    // Above the control, because the strip this sits in is at the bottom of the window; below it
    // only when a short window leaves no room above, and then clamped so a list taller than the
    // space it has pins to the margin rather than hanging off the bottom edge.
    const above = b.top - GAP - p.height;
    const top =
      above >= MARGIN
        ? above
        : Math.min(b.bottom + GAP, Math.max(MARGIN, window.innerHeight - p.height - MARGIN));
    setAt({ top, left });
  }, [open]);

  /**
   * The active row, kept in sight.
   *
   * The sheet scrolls when the list is longer than its cap, and a menu that answered the arrow keys
   * by moving a highlight the reader cannot see would be a control operating itself in private.
   * Scrolled by hand rather than with `scrollIntoView`, which is allowed to scroll every ancestor
   * that can move — including the transcript behind this, whose scroll is one of the things that
   * closes the menu.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const sheet = list.current;
    if (sheet === null) return;
    const row = sheet.children.item(active);
    if (!(row instanceof HTMLElement)) return;
    const r = row.getBoundingClientRect();
    const s = sheet.getBoundingClientRect();
    if (r.top < s.top) sheet.scrollTop -= s.top - r.top;
    else if (r.bottom > s.bottom) sheet.scrollTop += r.bottom - s.bottom;
  }, [open, active]);

  /**
   * The focus follows the state: into the list when it opens, back to the control when it closes.
   * The restore is conditional on the focus still being IN the list, so a press that landed
   * somewhere else in the window is not answered by pulling the caret back here.
   *
   * `preventScroll`, because the browser's own idea of bringing a focused element into view is a
   * scroll this component has already made unnecessary — the sheet is placed against the viewport
   * by measurement — and a scroll anywhere in this window is one of the things that CLOSES the menu.
   * Left to itself it is a widget that shuts the moment it opens.
   */
  useLayoutEffect(() => {
    const sheet = list.current;
    if (sheet === null) return;
    if (open) sheet.focus({ preventScroll: true });
    else if (sheet.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
  }, [open]);

  /** A control that has just been dimmed must not be left standing open over the reason it was
   * dimmed. The agent starting a turn is exactly when this happens. */
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && root.current?.contains(target)) return;
      setOpen(false);
    };
    // Capture, because the scroll that would carry this control out from under its own list is the
    // transcript's, and a scroll on an element does not bubble. The sheet's OWN scroll is not one of
    // those: a reader running the wheel down a long list of models is using the menu, not leaving
    // it, and the effect above scrolls it from here as well.
    const onScroll = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && list.current?.contains(target)) return;
      setOpen(false);
    };
    // A fixed sheet is placed against a rectangle read once. The window changing size moves that
    // rectangle without telling this component, and what would be left is a list floating beside
    // nothing. It is not the only thing that can move it any more — the dock's rectangle is a
    // function of the viewport AND the split, and the split has a gesture — so this listener is one
    // half of that guard and the effect below is the other.
    const onResize = (): void => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  /**
   * The other half of the resize guard: the conversation's own edge.
   *
   * EVERY PICKER IN THIS WINDOW SITS INSIDE THE DOCK — the composer's caption strip and the role
   * slots — and dragging the dock's grip moves the strip this sheet was measured against without
   * changing the window's size at all. None of the other five closers reaches that gesture: the
   * drag stops the pointerdown at the grip (`usePointerDrag` captures the pointer and takes the
   * event out of the tree), so the press never arrives as an outside press, and nothing scrolls,
   * resizes or blurs. A subscription is the whole fix, because the split is a store scalar and the
   * store already tells this component when it moves.
   */
  const split = useDockSplit();
  useEffect(() => {
    setOpen(false);
  }, [split]);

  /**
   * The keyboard, on the root rather than on either half of it, because the control and its list are
   * one widget and which of them holds the focus depends on whether it is open.
   *
   * TAB IS NOT SWALLOWED. The menu closes and the keystroke goes on to whatever is next in the
   * strip: a reader tabbing through the composer is on their way somewhere, and a widget that
   * trapped them in a five-row menu to make them confirm a choice they had not made would be the
   * modal this caption is not.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (disabled) return;
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (!open) {
      // Either arrow opens it, which is the one gesture a reader who has landed on a closed menu is
      // certain to try. Enter and Space are the button's own click and open it that way.
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      show();
      return;
    }
    switch (event.key) {
      case "Escape":
        // Stopped, so an Escape spent putting this list away is not also spent on the editor or the
        // dialog around it — the same bargain `InfoDot` strikes, for the same reason.
        event.stopPropagation();
        setOpen(false);
        return;
      case "ArrowDown":
        event.preventDefault();
        setActive((row) => Math.min(row + 1, options.length - 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive((row) => Math.max(row - 1, 0));
        return;
      case "Home":
        event.preventDefault();
        setActive(0);
        return;
      case "End":
        event.preventDefault();
        setActive(options.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(active);
        return;
      default:
        return;
    }
  };

  return (
    <span
      className={className === undefined ? "picker" : `picker ${className}`}
      ref={root}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Moving focus WITHIN the widget — control to list and back — is not leaving it.
        const next = event.relatedTarget;
        if (next instanceof Node && root.current?.contains(next)) return;
        setOpen(false);
      }}
    >
      {/* WHAT IS BEING CHOSEN, SAID ONCE AND POINTED AT TWICE. The control is a bare word in a
          caption with no label beside it, so the question it answers has to be carried in the markup
          — and it is carried as an ELEMENT rather than as an `aria-label` on the button, because a
          label attribute would REPLACE the button's own text and a reader would then be told what
          the control is for without ever being told what it currently says. Named by the pair, the
          button reads out as the question and then the answer. The list borrows the same span, so
          the menu that opens is not an unnamed list of five words. */}
      <span id={labelId} className="sr-only">
        {ariaLabel}
      </span>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        className="picker__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={sheetId}
        aria-labelledby={`${labelId} ${triggerId}`}
        title={title}
        onClick={() => (open ? setOpen(false) : show())}
      >
        {/* The label if this value has one, and the value itself if it does not. A picker fed
            something its list has never heard of is not a picker showing nothing: it is showing the
            truth, which is that the conversation is being answered by a model this installation can
            no longer name. */}
        {chosen === undefined ? value : chosen.label}
      </button>

      {/* Always mounted and hidden by `visibility`, so it can be measured before it is seen. */}
      <ul
        ref={list}
        id={sheetId}
        className="picker__sheet"
        role="listbox"
        tabIndex={-1}
        aria-labelledby={labelId}
        aria-activedescendant={open ? rowId(active) : undefined}
        data-open={open || undefined}
        style={at === null ? undefined : { top: at.top, left: at.left }}
        // The press that chooses a row must not first take the focus off the list, because focus
        // leaving is one of the things that closes this — and a row clicked in a sheet that has
        // already been hidden is a click that lands on nothing at all.
        onMouseDown={(event) => event.preventDefault()}
      >
        {options.map((option, index) => (
          <li
            key={option.value}
            id={rowId(index)}
            className="picker__option"
            role="option"
            aria-selected={option.value === value}
            data-active={index === active || undefined}
            // The pointer moves the active row rather than a `:hover` rule doing it behind the
            // component's back: `aria-activedescendant` is what a screen reader is following, and a
            // highlight the state knows nothing about would be a second, contradicting answer to
            // which row this menu is on.
            onPointerEnter={() => setActive(index)}
            onClick={() => commit(index)}
          >
            <span className="picker__mark" aria-hidden="true">
              {option.value === value ? "✓" : ""}
            </span>
            <span className="picker__label">{option.label}</span>
          </li>
        ))}
      </ul>
    </span>
  );
}
