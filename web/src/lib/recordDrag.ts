/**
 * What makes anything on screen carry a record into a sentence.
 *
 * A LIBRARY AND NOT A COMPONENT. Nothing here draws a record as a card with a name, a description
 * and an age — the graph draws every join in this database as a line between two boxes, on the board
 * the notes are stuck to, so no list of joins needs a row to put in it. What this holds is the part
 * that was never about a row: the two `dataTransfer` writes that make an element mean "this record".
 *
 * So it is `lib/`, and a `.ts`. There is no JSX in it, nothing here reads the store or the
 * DOM, and three different shapes in two components ask it the same question — a row in one of the
 * graph's node boxes, a field row on a note, a promoted prose block on the same note. A helper that
 * three unrelated callers share, that renders nothing and holds no state, is not a component.
 */

import type { DragEvent, DragEventHandler } from "react";

import type { RecordCard } from "./api.ts";
import { MENTION_MIME, type RecordPayload } from "./dragPayload.ts";
import { COLUMN_NAME, mentionFor } from "./mention.ts";

/**
 * What makes an element carry a record — or one of its columns.
 *
 * A function returning props rather than a component, because three unrelated shapes drag the same
 * record — a row inside one of the graph's node boxes, the heading row of a promoted prose block on a
 * note, and the `<dt>`/`<dd>` pair of one of its field rows — and wrapping all three in a shared
 * element would be inventing a box none of them wants. The field rows are why `column` exists: a
 * `<dl>`'s children are its grid, so there is nothing there to wrap even if wrapping were wanted.
 *
 * TWO REPRESENTATIONS RIDE EVERY DRAG, and the pair is the design rather than a belt-and-braces
 * habit:
 *
 *   - `MENTION_MIME` is the RICHER OFFER, and only this window knows to accept it. It is what the
 *     composer reads to build a highlighted chip above the textarea instead of dropping raw grammar
 *     into the middle of a sentence.
 *   - `text/plain` is what EVERY OTHER DROP TARGET IN THE WORLD understands — the composer's own
 *     textarea when the drop is not intercepted, a comment box in another tab, an editor in another
 *     application. A drag that carried only the custom type would be a record you could no longer
 *     drop into a text editor, and the mention grammar exists precisely so that a record can be
 *     written down anywhere.
 *
 * The composer therefore calls `preventDefault` ONLY when `MENTION_MIME` is on the transfer; every
 * other drag still lands natively at the caret, with the undo entry and the input event the browser
 * gives it for free. Neither representation is the fallback for a broken other — they are the same
 * record said in two languages, and they must not disagree, which is why an implausible column is
 * dropped from BOTH here rather than only from the text `buildMention` would refuse to spell.
 */
export function dragHandlers(
  card: RecordCard,
  column?: string,
): {
  draggable: true;
  onDragStart: DragEventHandler<HTMLElement>;
} {
  const named = column !== undefined && COLUMN_NAME.test(column) ? { column } : {};
  const payload: RecordPayload = {
    kind: "record",
    table: card.table,
    id: card.id,
    name: card.name,
    ...named,
  };
  return {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.setData(MENTION_MIME, JSON.stringify(payload));
      // The trailing space is deliberate: a mention dropped at the end of a half-typed sentence
      // would otherwise weld itself to the next word and stop being a mention at all.
      event.dataTransfer.setData("text/plain", `${mentionFor(card, column)} `);
      event.dataTransfer.effectAllowed = "copy";
    },
  };
}
