/**
 * What the composer's chips become on the way out: text, in the one grammar everything here reads.
 *
 * A chip is a drawing. It exists so that a record dropped into a message is something the reader can
 * see, point at and take back out again — which a mention spliced into the middle of a sentence is
 * not. It exists in the window, for the length of one draft, and it is flattened HERE, at the last
 * moment before the frame leaves.
 *
 * THE FLATTENING IS THE POINT. What crosses the wire is a message, and three separate readers make
 * sense of it: `state/chat.ts` puts it in the transcript, the message list draws its mentions as
 * pills, and the agent resolves them with the matching read tool because `src/claudecode/prompts/system.md`
 * taught it this grammar. All three already speak it. Sending the chips ALONGSIDE the text as a
 * structured field would mean the same fact travelling twice, in two spellings, over one socket — a
 * server that must merge them into the stored row, a transcript that must re-separate them to draw
 * them, a prompt that must explain both, and a permanent question about which one is authoritative
 * when they disagree. They would disagree: somebody will type `@thesis:x` by hand, and the moment two
 * channels carry the same kind of fact the code that reads only one of them is already wrong.
 *
 * So the chips have no life past this function. Nothing downstream knows what a chip is, and nothing
 * has to be kept in step with anything — which is also why the `busy` refusal's hand-back returns
 * text and not chips: there is no reverse of this function, on purpose.
 *
 * PURE and DOM-FREE, so `bun test` drives it directly under the root tsconfig — no store, no React.
 */

import { buildMention } from "./mention.ts";
import type { RecordTable } from "./records.ts";

/**
 * One record riding along with the message being written.
 *
 * `name` is the row's own name, and it is what TRAVELS: `serializeOutgoing` writes the mention, a
 * mention is `@table:name`, and the agent resolves the pair. It used to be the opposite — the chip
 * drew the name and put the id on the wire, because a name was read by no rule and a rename could
 * not be allowed to break a reference. A name is unique within its table and the tools have a
 * resolver for one, so the word the reader sees on the chip is the word the agent is handed. The
 * cost is real and is stated where it falls, in `lib/mention.ts`: a message written before a rename
 * names something that has moved.
 *
 * `id` rides along and never leaves this window. It is what opens a card locally, which is a
 * different question from what the sentence says.
 *
 * `column` names ONE FIELD of that record, which is what the field rows inside a record card drag.
 * Absent — never the empty string — when the chip is the whole record; see `lib/mention.ts` for why
 * the column is a suffix rather than an address of its own.
 */
export type ComposerChip =
  | {
      readonly kind: "record";
      readonly table: RecordTable;
      readonly id: string;
      readonly name: string;
      readonly column?: string;
    }
  | {
      /**
       * A FILE THE READER DRAGGED IN FROM OUTSIDE THE WINDOW. The third kind of thing a message can
       * carry, and the only one whose contents were never in this database at all.
       *
       * `path` is where the server put it, relative to the agent's home — and it is `null` for as
       * long as the upload is still in flight, which is what the chip draws as "uploading…" and what
       * stops a message going out naming a file that is not there yet. There is no reverse gesture:
       * a chip whose upload fails is removed rather than left on screen in a state nobody can act
       * on.
       *
       * `token` is the chip's identity for its whole life, minted here rather than derived from the
       * name or the path. It has to be minted, because the path does not exist yet at the moment the
       * chip appears — and it must not be the name, because two files called `data.csv` from two
       * folders are two attachments and collapsing them would silently drop one.
       */
      readonly kind: "file";
      readonly token: string;
      readonly name: string;
      readonly path: string | null;
    };

/**
 * What makes two chips the same chip: the text they would write.
 *
 * The mention itself rather than a key assembled beside it. A separate spelling — table, name and
 * column joined with a separator — would be a second answer to "are these the same record", and it
 * would have to pick a separator no name can contain and go on being right about that while the
 * reader renames things. The mention grammar already settled that question, by quoting whatever
 * cannot go bare. And the identity it gives is exactly the one that matters: two chips that would
 * put the same words on the wire ARE one chip, whatever the reader did to produce them both.
 */
export function chipKey(chip: ComposerChip): string {
  // A file's identity is its DROP and not its name or its path: two files called `data.csv` are two
  // attachments, and the path does not exist yet when the chip first appears. The key is therefore
  // stable across the upload landing, which is what lets the resolution find the chip it belongs to.
  if (chip.kind === "file") return `file:${chip.token}`;
  return buildMention(chip.table, chip.name, chip.column);
}

/**
 * The message: the records first, then the words.
 *
 * The mentions go on their OWN LINE above the prose, rather than being woven into it. The reader
 * dropped them beside their sentence and not inside it, so there is no insertion point to honour —
 * and a message that opens with what it is about, then says what to do with it, is the shape the
 * agent is best at reading anyway.
 *
 * Trimmed, because the draft accumulates whitespace nobody typed: a mention dropped as plain text
 * arrives with a trailing space, an Enter that sends leaves the newline behind it, and none of that
 * is part of what somebody said. With no chips this is exactly the message as typed; with no text it is the
 * records alone, which is a real message — "these" is a sentence when the agent can see what is being
 * pointed at.
 *
 * A FILE STILL UPLOADING WRITES NOTHING. It is one of two gates and the composer holds the other: the
 * send button is disabled while any file chip is pending, so this line is the one that would matter
 * if that ever broke, and what it prevents is a message naming a path the server has not created.
 */
export function serializeOutgoing(chips: readonly ComposerChip[], text: string): string {
  const typed = text.trim();
  if (chips.length === 0) return typed;
  const records = chips.filter((chip) => chip.kind === "record");
  const files = chips.filter((chip) => chip.kind === "file");
  const parts: string[] = [];
  if (records.length > 0) parts.push(records.map((chip) => chipKey(chip)).join(" "));
  for (const file of files) {
    if (file.path !== null) parts.push(fileLine(file.path));
  }
  if (typed !== "") parts.push(typed);
  return parts.join("\n");
}

/**
 * One dropped file, as the agent reads it.
 *
 * A LINE OF PLAIN TEXT AND NOT A MENTION, because a mention names a row and a file is not one — there
 * is nothing to look up, no table it belongs to, and no id. What the agent needs is the path and the
 * knowledge that it is a path, which `src/claudecode/prompts/system.md` teaches with this exact prefix.
 *
 * One per line rather than several on one, unlike the mentions above: a filename may contain spaces,
 * so a space-joined list of paths is a list nothing can take apart again.
 */
function fileLine(path: string): string {
  return `${FILE_PREFIX} ${path}`;
}

/** How a dropped file announces itself. Exported so the prompt's wording and this one cannot drift
 * apart without a test noticing. */
export const FILE_PREFIX = "Attached file:";

/*
 * THERE IS NO DRAFT BLOCK, and the fenced grammar that used to be written here has gone with the
 * forms that fed it. A draft block was a half-filled editor's contents in a JSON body, dragged into
 * the conversation so the agent could check values that were not in the database yet. No editor in
 * this window holds values any more: a record is written by asking for it, so what the agent is
 * given is the reader's own sentences and the questions it asked about them — which is a message,
 * in the one grammar above, rather than a second one nested inside it.
 */
