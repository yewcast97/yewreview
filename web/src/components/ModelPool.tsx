/**
 * The model pool: every model this installation can reach, as mini sticky notes on a shelf of slate
 * inside the conversation panel, between the transcript and the composer.
 *
 * A DRAWER AND NOT A FLOATING PANEL, which is what the full-height dock made possible. While the
 * conversation was a strip along the bottom of the window this had to be `position: fixed` against
 * the dock's own rectangle: a panel drawn ABOVE the composer from inside the dock would have been
 * cut off at the dock's top edge by `.panel`'s clip. A row of the body's grid needs no rectangle at
 * all, so the second copy of that arithmetic is gone and the drawer opens exactly where the gesture
 * wants it — one row above the ROLE SLOTS its notes are dragged onto.
 *
 * ONE HARNESS HAS THIS AND THE OTHER HAS NOTHING LIKE IT. The Claude path answers with whatever the
 * CLI it was installed beside can reach, and the composer's picker is the whole of that story; the
 * opencode path reaches models through providers this installation is configured with, so what is
 * reachable is a document somebody has to write. This is where they write it. It is not a settings
 * page: it is a board with paper on it, opened by a word in the composer and closed by the same
 * word, and the reason it is a board is the gesture at the end of this file — a model is put to work
 * by being dragged onto a slot.
 *
 * ── FOUR BOXES, NOT THREE ─────────────────────────────────────────────────────────────────────────
 *
 * A model note carries a name, a base url, a credential and the provider's own id for the model.
 * The fourth is not optional and cannot be inferred: `https://openrouter.ai/api/v1` says where to
 * knock and says nothing about which model to ask for, and opencode's config wants both. The `id` is
 * a fifth field and is never drawn — it is minted when the note goes up, it is the provider id in
 * the rendered config, and it is what a role assignment names.
 *
 * EVERY BOX MAY BE BLANK and the pool saves anyway. A note somebody has just pinned up is empty
 * until they type in it, and a form that refused to keep a half-filled row would lose the row every
 * time anybody was interrupted. What the SERVER refuses is a document that could not be rendered
 * into a coherent config, and those refusals arrive as sentences.
 *
 * THE API KEY IS SHOWN. It comes back from the route unredacted, by decision on the server's side —
 * this window binds loopback, the pool file is the reader's own, and a form that cannot show what it
 * is editing forces sentinel values and blind overwrites. So it is a plain text box like the other
 * three, and the sentence the reader most wants beside it is on its label's title: an ALL-CAPS value
 * is read as the name of an environment variable rather than as the secret itself, which is how a
 * credential stays out of the rendered config.
 *
 * COMMITTED ON BLUR, and the draft lives in the component. Nothing half-typed is in the store: the
 * four boxes are seeded once per entry with `seedDraft` — the same discipline every form on a record
 * card keeps, and for the same reason, since the pool can be re-read underneath somebody's hands —
 * and a box that says something different from what is stored writes the whole document when it
 * loses the caret. Per keystroke would be a request per character, the whole pool each time.
 *
 * ── THE TWO GESTURES ──────────────────────────────────────────────────────────────────────────────
 *
 * DOUBLE-CLICKING THE SLATE PINS UP A NEW NOTE. Plain `onDoubleClick`, which the graph's rows
 * deliberately do NOT use: over there a single click already means "expand this row", so both
 * handlers firing for one double click would expand a box nobody asked for, and `event.detail` has
 * to arbitrate. Nothing competes for a single click on this surface — it is empty slate, and the
 * only things on it that mean anything are the notes, which are guarded out below — so the plain
 * handler is exactly right here and the arbitration would be machinery for a conflict that does not
 * exist.
 *
 * A NOTE IS DRAGGED BY ITS TOP STRIP AND NEVER BY ITS BOXES. The four inputs need the caret, text
 * selection and a native undo entry, all of which a captured pointer takes away; the strip has
 * nothing in it to select. Letting go over a role slot assigns the model to that role — and `end`
 * fires on a pointerup and never on a pointercancel, which is `usePointerDrag`'s one asymmetry and
 * buys the whole safety property here for free: a gesture the browser took away (the pen left the
 * tablet, the OS claimed the pointer) cannot route a role at a model nobody dropped there. The LIGHT
 * is put out on both endings, because a slot left glowing after a cancelled drag is furniture lying
 * about a gesture that is over.
 *
 * WHAT MOVES IS A GHOST, AND THE NOTE STAYS WHERE IT IS. The shelf is one non-wrapping row that
 * scrolls sideways, and a note that left it would be a note dragged out of a scroll container — the
 * shelf's own clip cuts it off at the edge, and the gap it left behind reflows every neighbour under
 * the reader's hand. So the press takes the note's rectangle, the moves draw a TRANSLUCENT COPY of
 * it at that rectangle plus the gesture's distance, and the copy is portalled to the document body
 * where no clip in this panel can reach it. The pool underneath never changes: what is being carried
 * is a choice about a role, not the note, and the note is still there to be carried again.
 */

import { useId, useState, type MouseEvent, type PointerEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";

import type { Draft } from "../lib/editing.ts";
import { seedDraft } from "../lib/editing.ts";
import { usePointerDrag } from "../lib/pointerDrag.ts";
import type { OpencodeModel } from "../lib/api.ts";
import type { ModelField } from "../state/opencode.ts";
import { MODEL_FIELDS, sameModel } from "../state/opencode.ts";
import { noteDeckle } from "../state/notes.ts";
import {
  assignRole,
  createModel,
  deleteModel,
  setSlotHot,
  toggleModelPool,
  updateModel,
  useOpencode,
} from "../state/store.ts";
import type { SlotRect } from "./slotTarget.ts";
import { slotAt, slotRects } from "./slotTarget.ts";
import "../styles/chalk.css";
import "../styles/paper.css";
import "./ModelPool.css";

/** What each box says it is, and what a reader needs to know before typing in it. The order is the
 * order they are drawn in, which is the order they are filled in: what to call it, where it lives,
 * how to get in, and which model to ask for. */
const BOXES: Readonly<Record<ModelField, { placeholder: string; hint: string }>> = {
  name: {
    placeholder: "what you call it",
    hint: "What this window and the role slots call this model. Yours to choose; nothing reads it.",
  },
  url: {
    placeholder: "https://…/v1",
    hint: "The OpenAI-compatible base url this provider answers on.",
  },
  api: {
    placeholder: "sk-… or A_VARIABLE_NAME",
    hint:
      "The credential, or the NAME of an environment variable holding one — an ALL-CAPS value is " +
      "rendered as a reference, which keeps the secret out of the config file written for opencode.",
  },
  model: {
    placeholder: "provider/model-id",
    hint: "The provider's own id for the model, which is what goes on the wire when it is asked.",
  },
};

export function ModelPool(): ReactElement {
  const opencode = useOpencode();

  /**
   * A new model, from a double click on the slate.
   *
   * The guard is the whole of it: a double click that landed on a note is somebody selecting a word
   * in one of its boxes, and answering that with a new note would be the panel doing something
   * nobody asked for every time a reader picked a url apart.
   */
  const onDoubleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if ((event.target as Element).closest(".pool__note") !== null) return;
    void createModel();
  };

  return (
    <section className="pool" aria-label="The model pool">
      {/* The drawn box: chalk border and wobble on an inert layer, never on an ancestor of the
          words — the same construction as the dock below it and every box in the graph. */}
      <span className="chalk-frame chalk-frame--bright chalk-frame--hollow" aria-hidden="true" />

      <header className="pool__head">
        <h2 className="pool__title">models</h2>
        <span className="pool__spacer" />
        <button
          type="button"
          className="btn btn--icon"
          aria-label="Close the model pool"
          title="Put the pool away — nothing here is lost, it is already saved"
          onClick={toggleModelPool}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      {/* Written on the slate rather than drawn as help text, in the board's own voice and the
          board's own hand — the same three-line arrangement `GraphPanel` writes its gestures in, and
          inert for the same reason: a screen reader gets every one of these from the labels and
          titles on the things that perform them. */}
      <div className="pool__howto" aria-hidden="true">
        <div className="pool__howto-line">double-click the slate to pin a model up</div>
        <div className="pool__howto-line">drag a note by its strip onto a slot to route that role</div>
        <div className="pool__howto-line">the red magnet takes a model out of the pool</div>
      </div>

      {/* On the panel and never as a toast: a pool that could not be read is a fact about the thing
          the reader is looking at, and the notes already in hand stay underneath it. */}
      {opencode.error === null ? null : <p className="pool__refusal">{opencode.error}</p>}

      {/* `scroll-y` is deliberately NOT on this: that primitive is the window's vertical scroller,
          and this shelf is the one thing in the window that scrolls the other way. `ModelPool.css`
          declares the axis, and the notes on it never wrap. */}
      <div className="pool__surface" onDoubleClick={onDoubleClick}>
        {opencode.models.length === 0 ? (
          <p className="empty">
            {opencode.loading
              ? "Reading the pool…"
              : "Nothing here yet. Double-click this slate to pin up a model, and fill in its name, its base url, a key and the model id."}
          </p>
        ) : (
          opencode.models.map((entry) => <ModelNote key={entry.id} entry={entry} />)
        )}
      </div>
    </section>
  );
}

// -- one model ---------------------------------------------------------------------------------------

/**
 * What the strip remembers at the press: where the pointer went down, where the note itself was, and
 * where every slot was.
 *
 * ALL THREE READ ONCE — `usePointerDrag`'s contract — and each for its own reason. Five
 * `getBoundingClientRect` calls per pointermove is three hundred forced layouts a second for a row
 * that cannot move while a drag runs. The NOTE's rectangle has a second reason on top of that: it is
 * what the ghost is drawn from, and the shelf under it scrolls — a rectangle re-read mid-gesture
 * would make the ghost jump the moment the shelf moved a pixel under the pointer.
 */
type CarryPress = {
  px: number;
  py: number;
  note: { x: number; y: number; width: number };
  slots: readonly SlotRect[];
};

/** Where the ghost is on the glass, in viewport pixels. Its width is MEASURED off the note it was
 * copied from rather than restated from the stylesheet, which is what makes the copy the size of the
 * thing it is a copy of: the note's own width scales with the dock (`ModelPool.css`), and the ghost
 * is portalled to the document body where that scale does not reach — a figure written here would be
 * the unscaled one on every posture but the midline. */
type Ghost = { x: number; y: number; width: number };

function ModelNote({ entry }: { entry: OpencodeModel }): ReactElement {
  const id = useId();
  /**
   * What is typed, seeded ONCE per entry.
   *
   * The pool is re-read when the panel is opened and replaced whole by every save, so a note that
   * took its values from each of those would delete what somebody was typing the moment anything
   * moved. `seedDraft` is the record panel's answer to exactly this and is reused rather than
   * restated; the key is the entry's id, which is stable for the life of the note.
   */
  const [held, setHeld] = useState<Draft<OpencodeModel> | null>(null);
  const draft = seedDraft(held, entry.id, entry);
  /** Where the translucent copy is, while a drag is in flight, or null when none is. Local because
   * it is a picture of a gesture rather than a fact about the pool: it is gone the instant the
   * pointer is let go, and nothing else in the window needs to know it was ever drawn. */
  const [ghost, setGhost] = useState<Ghost | null>(null);
  // The torn edge is dealt from the id's hash, so a column of these does not repeat one deckle all
  // the way down. The PAPER is not dealt at all — there is one sheet in this window now — which is
  // the same answer the board notes give and for a stronger reason here: these are all one KIND of
  // thing, so a colour telling them apart would be a filing system that is not there.
  const deckle = noteDeckle(entry.id);

  const set = (field: ModelField, value: string): void => {
    setHeld({ key: entry.id, value: { ...draft.value, [field]: value } });
  };

  /**
   * Write the note, if it says something the pool does not.
   *
   * A blur that changed nothing is not a save: the whole pool goes over the wire, and a reader
   * tabbing through four boxes to READ them must not write it four times. What is compared — and
   * what is sent — is the whole note rather than the box that lost the caret, which is what stops
   * two quick blurs from racing; `updatedModel` argues that at the write.
   */
  const commit = (): void => {
    if (sameModel(draft.value, entry)) return;
    void updateModel(entry.id, draft.value);
  };

  const drag = usePointerDrag<CarryPress>(
    (event) => {
      // The strip's own rectangle would be an 18px sliver; what is being copied is the note it is
      // the top of. `closest` rather than `parentElement` because it says what is being looked for,
      // and the fallback is the pointer itself — a ghost at the cursor is still a ghost, and a
      // strip somehow outside a note is not worth refusing the gesture over. The 208 in that
      // fallback is an APPROXIMATION and is meant to be: it is the note's width at the midline
      // split, stood in for a measurement that did not happen, and the case it covers is a strip
      // that is somehow not inside a note at all.
      const at = (event.currentTarget as Element).closest(".pool__note")?.getBoundingClientRect();
      return {
        px: event.clientX,
        py: event.clientY,
        note:
          at === undefined
            ? { x: event.clientX, y: event.clientY, width: 208 }
            : { x: at.x, y: at.y, width: at.width },
        slots: slotRects(),
      };
    },
    (from, dx, dy) => {
      // The gesture's TOTAL distance from the press added to where the note was then — never a sum
      // over the moves, per the hook's contract.
      setGhost({ x: from.note.x + dx, y: from.note.y + dy, width: from.note.width });
      setSlotHot(slotAt(from.slots, from.px + dx, from.py + dy));
    },
    (from, dx, dy) => {
      setGhost(null);
      setSlotHot(null);
      const role = slotAt(from.slots, from.px + dx, from.py + dy);
      // No distance floor, and none is wanted: the slots are outside this panel, so a press that
      // never moved is never over one. What a slop would guard against here is nothing at all.
      if (role !== null) void assignRole(role, entry.id);
    },
  );

  /**
   * The strip's handlers, with the cancel taken over.
   *
   * `usePointerDrag` deliberately does not call `end` for a cancelled gesture — that asymmetry is
   * what stops a pointer the OS took away from being read as a drop on a slot — but it also means
   * nothing puts the LIGHT out or takes the GHOST off the glass. Those two are pure drawing and are
   * safe to undo on either ending; the assignment is not, and is left where the hook put it. A ghost
   * left behind by a cancelled drag would be the worse of the two: a slot stops glowing when the
   * next gesture starts, and a translucent note would simply sit there forever.
   */
  const strip = {
    ...drag,
    onPointerCancel: (event: PointerEvent<HTMLElement>): void => {
      drag.onPointerCancel(event);
      setGhost(null);
      setSlotHot(null);
    },
  };

  return (
    <article
      className="pool__note paper"
      aria-label={`Model ${draft.value.name === "" ? "with no name yet" : draft.value.name}`}
    >
      {/* The sheet is trim, not content: an absolute layer under the words, hidden from the
          accessibility tree, and the only thing the deckle filter is allowed to land on — a
          displacement filter over the boxes would smear every glyph in them. */}
      <div className="pool__sheet paper__sheet" data-deckle={deckle} aria-hidden="true" />

      {/* THE MAGNET, WHICH HERE IS A DELETE. On a record note the same stone takes the note down and
          the record stays in the database; on this one it is the only copy of a credential leaving
          the machine, so the store asks first. Two classes, because `paper.css` makes a magnet inert
          by default — most of them are decoration over a head that owns its own presses — and this
          one is the control. */}
      <button
        type="button"
        className="pool__remove paper__magnet paper__magnet--red"
        aria-label={`Remove ${draft.value.name === "" ? "this model" : draft.value.name} from the pool`}
        title="Take this model out of the pool — it asks first"
        onClick={() => void deleteModel(entry.id)}
      />

      {/* The handle, and the only part of the note a captured pointer may have. Nothing in here is
          text to select, which is the whole reason the strip exists rather than the note dragging by
          its body. */}
      <div className="pool__note-head" {...strip} title="Drag onto a role slot below" />

      <div className="pool__fields">
        {MODEL_FIELDS.map((field) => (
          <div className="pool__field" key={field}>
            {/* The label is the FIELD'S OWN WORD, the way every form in the record panel labels
                itself with the column it writes: `url` rather than "Endpoint". This is the document
                opencode is configured from, and somebody about to type in a box should be able to
                see which part of that document they are about to write. */}
            <label className="pool__label" htmlFor={`${id}-${field}`} title={BOXES[field].hint}>
              {field}
            </label>
            <input
              id={`${id}-${field}`}
              className="pool__input"
              value={draft.value[field]}
              placeholder={BOXES[field].placeholder}
              // Off, all of it: these are identifiers and a credential, not words. A browser
              // capitalising the first letter of a model id or correcting a hostname is the window
              // editing a value on its way to being stored.
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(event) => set(field, event.target.value)}
              onBlur={commit}
              // Enter commits by leaving the box, so the one key a reader is certain to press does
              // what they meant and the save has exactly one path through `onBlur`.
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </div>
        ))}
      </div>

      {/*
       * THE GHOST: a picture of the gesture, drawn on the glass rather than in this panel.
       *
       * PORTALLED TO THE BODY, and that is the whole reason it exists as a copy instead of the note
       * moving. Three ancestors would otherwise cut it off — the shelf's own `overflow-x`, the
       * dock's `.panel` clip and `.chat__body`'s — and the drag's whole purpose is to leave this
       * panel and cross the role slots below it. `position: fixed` resolves against the viewport
       * because nothing between the body and here carries a transform, which is the same fact
       * `ChatDock.tsx` states about the dock itself.
       *
       * READ-ONLY SPANS AND NOT THE INPUTS AGAIN. A copy built from the same markup would be four
       * more tab stops and four more ids inside something the accessibility tree is told to ignore;
       * what the reader needs from it is which model they are carrying, which is what the values
       * say. `aria-hidden` and `pointer-events: none` together are what make it a picture: the
       * pointer stays captured by the strip, and nothing under the ghost is shadowed by it.
       */}
      {ghost === null
        ? null
        : createPortal(
            <article
              className="pool__note pool__note--ghost paper"
              style={{ left: ghost.x, top: ghost.y, width: ghost.width }}
              aria-hidden="true"
            >
              <div className="pool__sheet paper__sheet" data-deckle={deckle} aria-hidden="true" />
              {/* The strip, quoted: the same ruled-off top the live note has, so what is being
                  carried looks like the thing it was lifted from. */}
              <div className="pool__ghost-head" />
              <div className="pool__fields">
                {MODEL_FIELDS.map((field) => (
                  <div className="pool__field" key={field}>
                    <span className="pool__label">{field}</span>
                    <span className="pool__ghost-value">{draft.value[field]}</span>
                  </div>
                ))}
              </div>
            </article>,
            document.body,
          )}
    </article>
  );
}
