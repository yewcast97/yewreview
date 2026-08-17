/**
 * The sentences the window says on the reader's behalf when they press something.
 *
 * NOTHING IN THIS WINDOW WRITES TO THE DATABASE. A recipe, a source, a script, a rename, a
 * deletion — every one of them is asked for in the conversation, and the agent writes the row once
 * the reader has seen what it is about to write and said yes. That left the `+` buttons and the bin
 * with nothing to open, and this is what they do instead: they SAY THE THING, as an ordinary message
 * from the user, in the transcript, where the reader can see it and edit the course of it afterwards.
 *
 * THEY ARE PLAIN MESSAGES AND THAT IS THE WHOLE MECHANISM. No new socket frame, no server-side
 * constant, no flag on a turn. A press composes one of these and sends it exactly as if it had been
 * typed, which means three things worth having: the transcript is HONEST (the click really was an
 * utterance, and it reads as one), the same words typed by hand work identically, and none of this
 * is a channel that could ever carry authority — because the agent's rule is that a message opening
 * a subject authorises nothing, and only a later message about a rendered draft does.
 *
 * EVERY ONE OF THEM SPEAKS INTO THE CONVERSATION ON SCREEN, and four of them used not to. A creation
 * once got a conversation of its OWN: pressing `+` put the current one down, opened a fresh session
 * and began it with the line. The argument was that a creation has a beginning and an end and should
 * read afterwards as itself rather than as a digression — which is true about the session list and
 * false about the person, who was in the middle of something when they pressed it and had the
 * context they were working in taken away. A reader raising a recipe while looking at a thesis is
 * usually doing ONE piece of work. So the openings stay put, the bin and the report `+` are no
 * longer exceptions, and there is one rule here instead of two.
 *
 * They are still as short as a line can be while naming the act. What the agent does with an opening
 * is doctrine, not wording: it answers with the empty row and one short line asking for the details,
 * which is a protocol that has to hold whether the line arrived from a button or was typed, and
 * cannot be re-specified per press by a sentence the reader did not write.
 *
 * NONE OF THEM SAYS "CREATE" OR "DELETE", because a sentence that reads as a completed instruction
 * is one an agent could act on before showing anybody anything — and the whole arrangement rests on
 * the draft coming first. The two that are not openings say so in their own words and are argued
 * where they are written.
 */

import { buildMention } from "./mention.ts";
import type { RecordTable } from "./records.ts";

/** Pressing `+` on the graph's `recipe` box. */
export const NEW_RECIPE = "I'd like to store a new recipe.";

/** Pressing `+` on the graph's `information_source` box. */
export const NEW_SOURCE = "I'd like to record a new information source.";

/** Pressing `+` on the graph's `thesis` box. */
export const NEW_THESIS = "I'd like to put a new thesis on record.";

/**
 * Pressing `+` on the graph's `script` box.
 *
 * The newest of the four, and the one that was argued against for a while: a program is arrived at
 * in service of a measurement somebody already wanted, so there is rarely a moment when a reader
 * wants to START one in the abstract. What that missed is that this is a SENTENCE rather than a
 * form — somebody who has decided they need a fetcher can say so as reasonably as they can say they
 * have thought of a thesis, and the agent's answer is the same empty row either way.
 */
export const NEW_SCRIPT = "I'd like to save a new script.";

/**
 * Pressing `+` on a recipe's report box.
 *
 * THE ONE SENTENCE HERE THAT IS AN ORDER, and the exception is worth stating rather than smuggling.
 * Every other sentence in this module opens a subject and asks to be drafted with, because what
 * would follow is a row somebody AUTHORS: a specification, an address book entry, a claim about the
 * market, a program. Nobody authors a report. A generation procedure runs the archive's own
 * machinery — it names the recipe it works to, records every command it runs while it runs, and
 * writes the report's account of itself from that log rather than from anything the agent says
 * afterwards — so there is no draft to show and nothing for the reader to agree to that they have
 * not already said by asking. An interview here would be the agent asking permission for work it has
 * been told to do.
 *
 * It still names the recipe rather than assuming one: a report is published under exactly one
 * specification, and a mention is how this window says which.
 */
export function newReport(recipeName: string): string {
  return (
    `${buildMention("recipe", recipeName)}\n` +
    "Generate the report this recipe specifies: start the procedure now."
  );
}

/**
 * Dropping a record on the bin.
 *
 * Names the row and asks what goes with it. The reader has made a specific request and the sentence
 * says so; what it does not do is presume the answer, because the useful thing an agent can do here
 * is say "these four reports were published under it" before anything is gone.
 */
export function binDrop(table: RecordTable, name: string): string {
  return (
    `${buildMention(table, name)}\n` +
    "I dragged this to the bin. Tell me what would go with it, and delete it if nothing is in the " +
    "way."
  );
}
