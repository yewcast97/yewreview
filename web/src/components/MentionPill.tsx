/**
 * A record named in a sentence, drawn as what it is CALLED and opened by a click.
 *
 * THE NAME IS WHAT TRAVELS, so drawing needs nothing. A mention on the wire is `@table:name` — that
 * grammar is what the agent reads, what a drag carries and what `serializeOutgoing` puts in the
 * sentence — so the pill has the word it should show before it has anything else. It used to be the
 * other way round: the wire carried a uuid and this component looked the name up to avoid showing a
 * reader thirty-two hex characters. A name is unique within its table and both sides address a row
 * by it, so the lookup this pill existed around has nothing left to do.
 *
 * WHAT IT STILL LOOKS UP IS THE ID, and only when clicked. Every read route in this window is
 * addressed by id, so opening the record means turning the name back into one — from
 * `state/names.ts`, which learns both halves off cards the window was already receiving, and failing
 * that from one fetch. That work is deferred to the press rather than done on sight: a streaming
 * answer can contain a dozen pills nobody will click, and a pill that draws correctly without asking
 * anything should not be asking anything.
 *
 * A NAME THAT ANSWERS TO NOTHING still draws as itself. The sentence was written when the record
 * answered to that name, and the name is what was meant — showing "a deleted thesis" instead would
 * throw away the only word the reader has. The press is what reports it, as a toast, because that is
 * where somebody has asked a question worth answering.
 *
 * A COLUMN MENTION KEEPS ITS COLUMN and opens the RECORD. The tail is what the reader dragged and is
 * how they check they dragged the field they meant to, so dropping it would answer a different
 * question than the one they asked. But the field is already on screen the moment the record is open
 * — the note draws the whole row — so a column-selection concept would buy nothing except a second
 * thing that can disagree with the first.
 */

import type { ReactElement } from "react";

import type { RecordTable } from "../lib/records.ts";
import { openNamedRecord } from "../state/store.ts";

export function MentionPill({
  table,
  name,
  column,
}: {
  table: RecordTable;
  name: string;
  column?: string;
}): ReactElement {
  const label = column === undefined ? name : `${name} #${column}`;

  return (
    <button
      type="button"
      className="markdown__mention"
      title={`Open this ${table} in a note`}
      onClick={() => void openNamedRecord(table, name)}
    >
      {label}
    </button>
  );
}
