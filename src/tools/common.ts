/**
 * The four things every tool module needs, in one place so they cannot drift apart.
 *
 * The important one is `attempt`. Repositories throw `Refused` because a repository has no idea who
 * is calling; a tool has to hand the model a RESULT instead, because an exception teaches it only
 * that something went wrong while a refusal naming its kind carries the remediation hint with it.
 * Only `Refused` is converted, deliberately: anything else is a defect in YewReview rather than a
 * mistake in the call, and a defect dressed up as `invalid_request` would send the model round the
 * loop rewriting arguments that were never the problem.
 *
 * `REF` IS THE OTHER ONE WORTH READING. Every `*_id` argument on this surface takes either an id or
 * the record's own NAME, because a name is what a mention on the wire carries and a user saying
 * "the semis recipe" is pointing at something as precisely as any uuid does. `ref` is where that
 * is turned back into an id, once, so no tool decides for itself what an argument is allowed to be.
 * Ids remain what every tool RESULT hands back: they survive a rename, and a name does not.
 *
 * The strictness rule that used to live here is now `strictSchema` in `def.ts`, because it is a
 * property of the DEFINITION rather than of a handler body, and both serving surfaces have to apply
 * it identically.
 */

import type { Database } from "bun:sqlite";

import { Refused } from "../db/models.ts";
import { resolveRecordId } from "../repo/naming.ts";
import type { RecordTable } from "../repo/records.ts";
import type { ToolResult } from "../protocol/types.ts";
import { fail } from "../protocol/types.ts";

/** An id or a name, as an id. Refuses with `not_found` naming both ways in. */
export function ref(db: Database, table: RecordTable, value: string): string {
  return resolveRecordId(db, table, value);
}

/** What every `*_id` argument's description says, so eleven of them cannot say it eleven ways. */
export function refDoc(table: string, lister: string): string {
  return `The ${table}'s id or its name — ${lister} has both.`;
}

/**
 * The consent rule, on every tool that writes one of the user's own documents.
 *
 * IT LIVES ON THE TOOLS AND NOT ONLY IN THE PROMPT, and that is the point of it being a constant.
 * The system prompt tells the model its tool list is authoritative wherever the two disagree, so a
 * rule that existed only in the prompt is a rule the model is entitled to treat as out of date. It
 * is one string rather than three so the three tools cannot come to say slightly different things
 * about what agreement is.
 *
 * There is no mechanical half to this and there is deliberately no attempt at one. A `confirm: true`
 * boolean would be a checkbox the caller ticks, which is what the delete tools already have and is
 * doctrine wearing a schema; a draft table the user commits from would be ceremony, because
 * committing another party's text is not writing. What actually keeps this honest is that the
 * archive keeps every recipe, none is editable, and a report names the one that produced it.
 *
 * THE PIN IS REPETITION ON PURPOSE. Agreement is given to what the user can see, and a conversation
 * scrolls: a draft settled four messages ago is read through whatever has been said since, which is
 * how somebody comes to approve wording they are no longer looking at. Restating the whole draft at
 * the end of every reply costs tokens and reads as redundant, and that is the price of the last
 * thing on their screen being the thing they are answering.
 *
 * ONE GRAMMAR RATHER THAN THE MODEL'S CHOICE OF LAYOUT, which is the half of this that changed and
 * is worth the argument. A draft used to be asked for as ordinary markdown and explicitly not as a
 * fence, on the grounds that a fence shows the bytes while hiding the shape — headings in a
 * recipe, paragraphs in a thesis. What that reasoning missed is that the SHAPE OF THE ROW is a
 * different thing from the shape of the values in it: laid out freehand, a field the model had not
 * filled in could be a heading with nothing under it, or a sentence apologising for the gap, or
 * simply absent, and the user was left inferring which fields were still open from the prose around
 * them. The row block fixes the row's shape — table, field, value, `****` where nothing is settled
 * yet — and leaves the values' own shape alone, because a document value is still markdown inside
 * it and a program is still a fence inside it. The window draws it as a card
 * (`web/src/lib/rowBlock.ts`); a block it cannot parse keeps the ordinary code chrome, so the
 * failure mode is the outline shown as typed rather than a promise the window did not keep.
 */
export const CONSENT =
  "CALL THIS ONLY AFTER THE USER HAS AGREED TO WHAT IT WILL WRITE. Ask them for what you are " +
  "missing, then render the COMPLETE thing in your reply as a row block — a ~~~row fence holding " +
  "the table name at the margin, each field name indented two spaces, its value indented two more, " +
  "**** on any field not filled in yet, and a code value as its own backtick fence inside — and " +
  "wait. EVERY field the tool takes is in the block, the unsettled ones as ****, and none of the " +
  "machine's: no id, no timestamp, nothing the database writes for itself. Record it only once " +
  "they have said, in a message sent after seeing that, that this is what " +
  "they want stored. A message that merely opens the subject authorises nothing, and neither does " +
  "their silence; if they change something, render the whole of it again rather than the diff. " +
  "While the drafting is open — from the message that raised it until this is recorded or they call " +
  "it off — END EVERY REPLY with the complete current draft, one whole row block, updated, however " +
  "little changed. The last thing on their screen is what they are agreeing to, and a draft three " +
  "messages up is a draft nobody is reading. ONCE IT IS RECORDED THE DRAFTING IS OVER: answer with " +
  "what the tool's result said and do not render the block again — a draft shown after saving " +
  "reads as a question still open.";

/** Run a handler body, converting a repository refusal into a result the model can act on. */
export async function attempt(
  fn: () => ToolResult | Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Refused) return fail(err.kind, err.message);
    throw err;
  }
}

/**
 * The refusal a destructive tool returns when `confirm` was not set.
 *
 * Checked in the handler as well as being required by the schema, because "required" only means
 * the field is present: `confirm: false` satisfies the schema and means the opposite of what the
 * tool is about to do.
 */
export function unconfirmed(confirm: boolean, what: string): ToolResult | null {
  if (confirm) return null;
  return fail(
    "invalid_request",
    `deleting ${what} needs confirm: true. Nothing here is undoable — say what you are about to ` +
      `remove and why, then call again.`,
  );
}

/** A count with its noun agreeing — the summary line is what a transcript shows. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
