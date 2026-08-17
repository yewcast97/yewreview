/**
 * The one table whose body is a DOCUMENT rather than a row, and the columns that document owns.
 *
 * THIS WAS A DIRECTORY OF FOUR FILES AND THE ARGUMENT THAT FILLED IT IS WORTH KEEPING. Three tables
 * carried a form — a name, a specification, an information source — on the grounds
 * that each is the READER's own document rather than the agent's account of what it did, so the
 * usual objection (a form is a second implementation of rules with none of the rules in it) did not
 * apply to them. What the forms could not do is leave an account: a row typed into seven boxes and
 * saved arrives in the archive with nothing behind it — no statement of what it was for, nobody who
 * can be asked why it says what it says. Asked for in the conversation, the same row arrives with
 * the whole exchange behind it, in a transcript that outlives every window. So every write moved to
 * the chat, and then the last two controls went the same way: generating a report is asked for like
 * everything else now, so the Generate and Stop buttons that used to stand under this document are
 * gone with the routes behind them.
 *
 * WHAT IS LEFT IS THE PART THAT WAS NEVER A FORM: drawing a record that happens to be a document.
 * One file, because one table has one, and a directory of four holding a reader and a filter was
 * scaffolding for a shape that no longer exists.
 *
 * `editedColumns` IS WHAT STOPS A RECORD BEING DRAWN TWICE. A column drawn here —
 * `recipe.content`, as rendered markdown — is not also drawn as a promoted paragraph or a row of
 * the field grid, because the same text in two places is one record making two claims about itself.
 * The names are strings against a schema that moves, exactly like `PRIMARY_TEXT` in
 * `lib/viewer.ts` — a name that is not on the row costs nothing, because filtering by it removes
 * nothing.
 *
 * `name` IS NOT ON THAT LIST, and its absence is the visible half of the teardown. It was there
 * because every record carried a `NameEditor` — a box holding the row's name with a Save beside
 * it — and a column with an input in it must not also appear in the grid underneath. There is no
 * such box: a rename is asked for in the conversation like every other change, so `name` is drawn as
 * an ordinary field-grid row on every table, which is where a stored value that nothing on the card
 * writes belongs.
 */

import type { ReactElement } from "react";

import type { RecordDetail, RecordTable, Row } from "../lib/records.ts";
import { InfoDot } from "./InfoDot.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import "./RecordDocument.css";

/** The columns drawn as a document, per table. Anything not listed is drawn as stored. One table
 * long, and the entry is a rendering rather than a control: a recipe's `content` is a
 * specification, read as the document it is. */
const EDITED_COLUMNS: Partial<Record<RecordTable, readonly string[]>> = {
  recipe: ["content"],
};

export function editedColumns(table: RecordTable): readonly string[] {
  return EDITED_COLUMNS[table] ?? [];
}

/**
 * Everything three paragraphs above the document would say, said once, behind the ⓘ.
 *
 * No number names anything here, and its absence is a decision rather than an oversight. This used
 * to be one version of a ledger, and the note had to explain that recording the next one left this
 * one standing. A recipe is one immutable row: there is no version to number, nothing to say about
 * what supersedes what, and the note is shorter for it. Nothing here may reintroduce a count.
 */
const CONTENT_NOTE =
  "The complete report specification. A recipe's text never changes after it is stored, which is " +
  "what lets every report published under it name the exact instructions it was written to. When " +
  "the method moves on, ask in the conversation for the new specification — the agent will show you " +
  "the whole of it, store it as a new recipe once you agree, and set this one inactive, which " +
  "retires it while keeping every report under it readable.";

/**
 * One column of a row as a string, or "" when it is absent or null.
 *
 * ABSENT AND NULL COLLAPSE HERE, and only here, because this is the one place in the panel where
 * they genuinely are the same thing: a document with nothing in it reads the same either way.
 * Everywhere else in this window the difference is kept — `restFields` draws a null as `null` —
 * because a column holding nothing and a column holding the empty string are different audit
 * findings.
 */
function rowText(row: Row, column: string): string {
  const value = row[column];
  if (value === undefined || value === null) return "";
  return String(value);
}

/**
 * A recipe: the whole report specification, read as the document it is.
 *
 * IT IS A READER AND NOTHING ELSE. This card used to be an editor — the document clicked into a
 * textarea, a draft held in `useState`, an unsaved mark, and a Save that appended the next version —
 * and then, for a while, a reader with two generation buttons under it. Both are gone for the same
 * reason: a revision is ASKED FOR in the conversation, where the agent reads what is in force, hears
 * which sentence is wrong and shows the whole next version before recording it; and a report is
 * asked for the same way, on the `+` of a recipe's report box or in plain words. So what is left
 * is the document as `MarkdownView` renders it — the same renderer the agent's answers go through,
 * mentions off, because a specification QUOTES the mention grammar rather than using it.
 *
 * WHY THAT IS BETTER RATHER THAN MERELY SMALLER. A recipe is the specification the work is
 * commissioned against, and the version in force is what every later report is audited by; a version
 * written from a textarea arrives in the archive with nobody's account of what it was for. Written
 * from the conversation, the whole exchange behind it is in the transcript, and the transcript
 * outlives this window.
 *
 * RECOVERY IS UNCHANGED AND IS STILL A DELIBERATE ACT. A reader who opens a superseded version,
 * finds the paragraph that got lost after it and wants it back asks for exactly that, with this card
 * on screen — which is what "save from an old version's card" always meant, said out loud.
 */
function RecipeDocument({ detail }: { detail: RecordDetail }): ReactElement {
  const content = rowText(detail.row, "content");
  return (
    <section className="document">
      <div className="document__field">
        {/* One label, one note, and no prose anywhere on the card. A heading ("These instructions"),
            a lede about how a specification is superseded and a hint under the document would be
            three paragraphs explaining one field, permanently, to a reader who needs them once. The
            note carries all of it instead. */}
        <span className="document__label">
          content
          <InfoDot about="content">{CONTENT_NOTE}</InfoDot>
        </span>
        {/* The document in its own frame rather than as a field-grid row, because it is a document:
            a specification is read end to end and its headings and lists are how it is navigated.
            Nothing here is clickable — the frame is a page, not a control. */}
        <div className="document__page">
          {content.trim() === "" ? (
            <p className="document__empty">This recipe records no instructions.</p>
          ) : (
            <MarkdownView text={content} />
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Whatever a table draws for itself beyond the field grid.
 *
 * IT STAYS A SWITCH rather than becoming a registry. The compiler is what will complain if a second
 * table is ever added to `EDITED_COLUMNS` without something to draw it, and a map anything can be
 * dropped into is precisely the shape that would let one in unargued.
 */
export function RecordDocument({ detail }: { detail: RecordDetail }): ReactElement | null {
  switch (detail.card.table) {
    case "recipe":
      return <RecipeDocument detail={detail} />;
    default:
      return null;
  }
}
