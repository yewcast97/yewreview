/**
 * Which of five families a record table belongs to — the graph's only colour vocabulary.
 *
 * PURE and DOM-FREE, a total function from a table to a name, and that is the whole module. It lives
 * beside `graphLayout.ts` rather than inside it because the layout is arithmetic that must not know
 * about paint, and this is paint that must not know about arithmetic: every hue below is a
 * pseudo-element, a stroke or a background, and not one of them changes a box's height by a pixel.
 * `tests/webGraphLayout.ts` and `tests/webGraphView.ts` pass untouched, which is the proof.
 *
 * FIVE FAMILIES RATHER THAN A HUE PER TABLE. Colour on a canvas is a legend, and a legend with
 * thirteen entries is a legend nobody reads — the table's name is written on every box already, so a
 * per-table hue would be a second, worse copy of a label the reader can just read. What colour can
 * say that a name cannot is KIND: this box is about the conversation, that one is about an idea, that
 * one is about where the numbers came from, that one is a program, and that one is something the
 * machine produced. Those are the five, they are the five the schema is actually built out of, and
 * the graph's four root boxes stand in column zero wearing four of them — which makes the legend the
 * canvas itself rather than a panel somewhere explaining it.
 *
 * The groupings are the schema's, not a designer's:
 *
 *   - `recipe` — the specification a report is written to. On its own: what is published under one
 *     is a report, and a report belongs with everything else a generation MADE.
 *   - `thesis`, `thesis_assessment`, `target` — the claim, the ledger of how it has held up, and the
 *     company it is about. Reading a thesis means reading all three.
 *   - `information_source` — the address book, on its own now that nothing cites it.
 *   - `script` and `script_invocation` — the program and the times it was run.
 *   - `report`, `seikan_invocation`, `trivial_shell_history_for_report`, `series_preparation` —
 *     everything a generation MADE. These are one family because they share a provenance rather
 *     than a subject: what they have in common is that nobody typed them. A measurement belongs
 *     here rather than with the scripts because, unlike `script_invocation`, it names no program
 *     row to borrow a meaning from — the engine is not a record in this archive.
 *
 * `neutral` is not a sixth family, it is the absence of one, and taking `null` is why this function
 * needs it: a graph box is `RecordTable | null`, null being a note box ("none recorded") or a
 * refusal, which are about a row rather than about a table and have no kind to be. Falling through
 * the switch rather than being listed also means a table added to the schema tomorrow draws grey
 * instead of borrowing a meaning it has not earned.
 */

import type { RecordTable } from "./records.ts";

export type NodeFamily = "recipe" | "thesis" | "source" | "script" | "derived" | "neutral";

/** The family a box, a strip, a port dot or a link takes its colour from. */
export function familyOf(table: RecordTable | null): NodeFamily {
  switch (table) {
    case "recipe":
      return "recipe";
    case "thesis":
    case "thesis_assessment":
    case "target":
      return "thesis";
    case "information_source":
      return "source";
    case "script":
    case "script_invocation":
      return "script";
    case "report":
    case "seikan_invocation":
    case "trivial_shell_history_for_report":
    case "series_preparation":
      return "derived";
    default:
      return "neutral";
  }
}
