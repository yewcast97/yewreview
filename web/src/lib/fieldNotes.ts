/**
 * What a column MEANS, for the handful whose name does not say.
 *
 * Pure, DOM-free and store-free, like `lib/viewer.ts` beside it, and for the same reason: the
 * decision about which columns need explaining is exactly the kind that is argued over once and then
 * never checked again unless something is holding it.
 *
 * DELIBERATELY SHORT, AND MEANT TO STAY SHORT. This is the frontend's own prose — nothing on the
 * server writes it and nothing reads it back — and the temptation it exists under is to grow a note per
 * column until it is a second copy of the schema's comments, maintained by nobody, drifting from the
 * real ones the moment a column changes meaning. So the bar is high: a note earns its place only
 * when the column's name genuinely does not say what the value is, and when getting it wrong would
 * make a reader misread the record. `created_at` needs no note; `content_bytes` does, because a
 * reader who has just been shown a document and then a number called "content bytes" reasonably
 * wonders which of the two is the report.
 *
 * ADVISORY, like `PRIMARY_TEXT`: a name that is not on the row is simply never asked about, and a
 * table with no entry gets no notes at all. Being wrong here costs an explanation nobody sees.
 *
 * WHAT IS NOT HERE, on purpose: the columns the FORMS own. Their explanations live beside their
 * inputs as `hint` props, which is where somebody about to type into one is looking, and this map is
 * for the read-only grid.
 */

import type { RecordTable } from "./records.ts";

/**
 * Notes that mean the same thing on whichever table they appear.
 *
 * `argument` is on two tables — an invocation ledger and a series preparation — and says the same
 * thing on both, so it is written once rather than twice slightly differently. So do the three
 * columns that say how a recorded command went, which are on both run tables.
 */
const COMMON_NOTES: Readonly<Record<string, string>> = {
  argument:
    "What the run was given, exactly as the generation's own log recorded it. An empty argument is " +
    "an answer rather than a gap: a program run with nothing passed to it is honestly recorded as " +
    "having been.",
  return:
    "What the command printed, off the generation's own log rather than off anybody's account of " +
    "it. Ordinary commands are kept head-and-tail with the middle named where it was dropped; an " +
    "engine run is kept whole, because a measurement report is a document rather than chatter.",
  exit_code:
    "What the shell said about the command. Anything but 0 is the program's own failure code, kept " +
    "rather than dropped: a report leaning on a run that failed is exactly what an audit is for.",
};

/*
 * THERE IS NO `version` NOTE ANY MORE, and its going is worth recording rather than silently
 * dropping. It explained which revision of the instructions a row was, that versions only append,
 * and that the highest was the one in force. Every word of it was true; the column then stopped
 * being drawn, and then versions stopped existing at all — a recipe is one immutable row with a
 * status. A note for a column no grid shows is prose maintained by nobody, which is exactly what
 * this file's header refuses.
 */
const FIELD_NOTES: Partial<Record<RecordTable, Readonly<Record<string, string>>>> = {
  report: {
    content_bytes:
      "How large the published document is, in bytes. The document itself is not in this row — it " +
      "is what the frame above is showing.",
  },
  thesis_assessment: {
    tag:
      "What this round of judgement called the thesis. Two of the three are live readings — " +
      "approven and insightful — and abandoned retires it, which is also what frees its name for a " +
      "replacement.",
  },
  recipe: {
    status:
      "Whether reports are still written to this specification. An inactive recipe keeps its text " +
      "and every report published under it; retiring one only stops a new report being generated " +
      "to it.",
  },
  script: {
    status:
      "Whether this program is still in use. An inactive script keeps its source and everything " +
      "it prepared; it is retired rather than deleted, it is refused a run, and its bytes are free " +
      "for a replacement to reuse.",
    domain:
      "What kind of data this program fetches. The agent's own word for it, used to find a script " +
      "again rather than to constrain what it may do.",
  },
  information_source: {
    hosts:
      "Where this source publishes — your own note of it, for reading while you work. Nothing is " +
      "checked against it: reports no longer record the addresses they were read at, because that " +
      "record was the model's account of its own reading and nothing ever verified it.",
  },
};

/** The note for one column, or null when it has none — which is most of them. */
export function fieldNote(table: RecordTable, column: string): string | null {
  return FIELD_NOTES[table]?.[column] ?? COMMON_NOTES[column] ?? null;
}
