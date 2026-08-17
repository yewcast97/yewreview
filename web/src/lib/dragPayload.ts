/**
 * What rides on a drag out of this window, and how it is read back.
 *
 * PURE and DOM-FREE, which is the point of it being a module at all: parsing inside the composer's
 * drop handler is parsing somewhere `bun test` cannot reach, and the thing being parsed is
 * data crossing a boundary. It arrives as a string this window wrote, but a `dataTransfer` is a
 * shared surface and the only guarantee worth relying on is the MIME type.
 *
 * ONE KIND RIDES THE MENTION MIME, AND IT IS AN ADDRESS: a table, an id, and optionally one column
 * of it. The composer turns it into a chip and `serializeOutgoing` turns that into a `@table:name`
 * mention. Nothing about the row's contents travels — the agent resolves the address with a read
 * tool, which is what stops it answering about a stale copy.
 *
 * A CONVERSATION RIDES A MIME OF ITS OWN, AND THAT SEPARATION IS THE WHOLE DESIGN. A session row
 * dragged to the Bin is not a record and has no mention: nothing in the archive points at a
 * transcript, `@session:…` names nothing, and the composer must not offer to make a chip of one. The
 * decision has to be made during `dragover`, from `types` alone — see `classifyDrag` — so a second
 * MIME is what lets every existing consumer stay exactly as it is: a session drag simply does not
 * carry `MENTION_MIME`, the composer's classification falls through, and the browser's default
 * applies. A `kind` on the shared MIME would have made every one of those consumers parse before it
 * could decide, which is the thing `dragover` does not allow.
 *
 * THERE IS NO DRAFT PAYLOAD ANY MORE, and the emptiness where one was is the shape of the whole
 * window now. A draft was contents and no address — what a half-filled editor held, dragged in so
 * the agent could look at values that were not in the database and might never be. There are no
 * editors: a record is written by asking for it in the conversation, so the values the agent needs
 * to see arrive as the answers to its own questions rather than as a copy of a form. Nothing carries
 * contents over this MIME, and anything that wanted to would be inventing a second way to say what
 * the transcript already says.
 *
 * `kind` IS OPTIONAL ON THE WAY IN, and a payload is read as a RECORD whatever it claims to be. That
 * is a validation and not a guess — `readRecord` demands a known table and a non-empty id, so a
 * payload missing the field is accepted only when it is a well-formed record address and is null
 * otherwise. Nothing this window writes omits it.
 */

import type { RecordTable } from "./records.ts";
import { isMentionTable } from "./mention.ts";

export type RecordPayload = {
  kind: "record";
  table: RecordTable;
  id: string;
  /** What the chip is drawn as the moment it lands: the row's `name`. */
  name: string;
  /** One column of the record, when a field row rather than the record was dragged. */
  column?: string;
};

/**
 * One stored conversation, on its way to the Bin.
 *
 * The summary rides along because the toast that reports the deletion names it, and by the time the
 * answer comes back the row is gone from the list — so the only place left to read it from would be
 * a copy of state taken before the await, which is exactly the trap the store's own rule warns
 * about.
 */
export type SessionPayload = { kind: "session"; sessionId: string; summary: string };

/** What a drag out of this window carries. */
export type DragPayload = RecordPayload;

/**
 * The custom drag type, which is the whole of the handshake between this window and its composer.
 *
 * A private MIME rather than a flag on `text/plain`, because the question the composer asks on
 * `dragover` is "did this come from this window", and a string it would have to parse to find out is
 * a question it cannot answer in time to call `preventDefault`.
 */
export const MENTION_MIME = "application/x-yewreview-mention";

/**
 * The conversation MIME, and it deliberately carries NO `text/plain` beside it.
 *
 * A record drag writes prose too, because its prose is the mention grammar and dropping one into a
 * text field somewhere else should paste something meaningful. A conversation has no such grammar:
 * there is no `@session:…`, nothing addresses a transcript, and prose here would make a stray drop
 * into any text box paste a summary nobody asked for. The Bin is the only thing that takes one, so
 * the custom type is the whole of what it needs.
 */
export const SESSION_MIME = "application/x-yewreview-session";

/** What a drag from the operating system's own file manager puts in `types`. Not a MIME at all —
 * it is the literal string the drag-and-drop spec reserves for "there are files on this". */
export const FILES_TYPE = "Files";

/**
 * What a drag is carrying, decided from `types` alone.
 *
 * FROM `types` AND NOT FROM THE DATA, because this answer is needed during `dragover`, where
 * `getData` returns the empty string and `dataTransfer.files` is empty — the browser withholds the
 * contents of a drag until it is dropped, and the decision about whether to take the drop over has
 * to be made before then. The MIME therefore answers only "this window wrote it"; what it wrote is
 * `readDragPayload`'s business on the drop.
 *
 * A RECORD WINS A DRAG THAT SOMEHOW CARRIES BOTH. Nothing in this window mints such a drag, but the
 * ordering must be written down somewhere rather than left to whichever branch happened to be first:
 * a record dropped into the composer becomes a chip naming a row, which is the richer reading and
 * the one this window is sure about, and the alternative — doing both — would put a chip and an
 * upload on screen for one gesture.
 */
export function classifyDrag(
  types: readonly string[],
): "record" | "session" | "files" | "none" {
  if (types.includes(MENTION_MIME)) return "record";
  if (types.includes(SESSION_MIME)) return "session";
  if (types.includes(FILES_TYPE)) return "files";
  return "none";
}

/**
 * One drag's payload, or null for anything this window did not write.
 *
 * Null rather than a throw, and null for every failure: the caller's move is identical in all of
 * them — ignore the drop and let the browser do what it was going to. A refusal with a reason would
 * be a sentence about a drag nobody can act on.
 */
export function readDragPayload(raw: string): DragPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  return readRecord(value as Record<string, unknown>);
}

/**
 * One session drag's payload, or null for anything this window did not write.
 *
 * Its own reader rather than a branch of `readDragPayload`, because the two arrive on different
 * MIMEs and every caller already knows which one it asked for. A record payload handed to this
 * answers null, and a session payload handed to the other does too — which is the property that
 * keeps the composer from ever making a chip out of a conversation.
 */
export function readSessionDrag(raw: string): SessionPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { kind, sessionId, summary } = value as Record<string, unknown>;
  if (kind !== "session") return null;
  if (typeof sessionId !== "string" || sessionId === "") return null;
  // A toast with an empty name in it reads as a bug, so the id stands in — the same fallback a chip
  // makes for a record with no name.
  const named = typeof summary === "string" && summary !== "" ? summary : sessionId;
  return { kind: "session", sessionId, summary: named };
}

function readRecord(held: Record<string, unknown>): RecordPayload | null {
  const { table, id, name, column } = held;
  if (typeof table !== "string" || !isMentionTable(table)) return null;
  if (typeof id !== "string" || id === "") return null;
  // A chip draws its name and nothing else, so a missing one would be a blank pill. The id is what
  // it is a chip OF, and it is never empty.
  const drawn = typeof name === "string" && name !== "" ? name : id;
  if (column === undefined) return { kind: "record", table, id, name: drawn };
  if (typeof column !== "string") return null;
  return { kind: "record", table, id, name: drawn, column };
}
