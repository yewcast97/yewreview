/**
 * What a drop out of this window is allowed to be.
 *
 * The property every test here defends: NOTHING IS TRUSTED BECAUSE IT ARRIVED ON THE RIGHT MIME.
 * The payload is a string written by a `dragstart` — this window's, in every case anybody planned
 * for, and in principle any other page the reader happened to drag from that uses the same MIME
 * name. A chip built from an unchecked parse puts an unknown table into the mention grammar and
 * reaches the agent as a record that cannot exist.
 *
 * ONE KIND RIDES THIS MIME AND IT IS AN ADDRESS. There were two: a record, and a DRAFT — a
 * half-filled editor's contents, a table and a label and a bag of field values, dragged in so the
 * agent could look at values that were not in the database and might never be. The suite that pinned
 * one is gone with the editors that wrote it, and so is the reason it existed: nothing in this window
 * holds a form's values any more, so nothing has contents to hand over. What crosses this boundary is
 * a row's address, and the agent reads the row itself with a tool — which is what stops it answering
 * about a stale copy, and which is now the ONLY thing this module has to check for.
 *
 * Every failure answers null, and null for all of them on purpose: the caller's move is identical
 * in every case — ignore the drop and let the browser do what it was going to do with it. A refusal
 * carrying a reason would be a sentence about a drag nobody can act on.
 */

import { describe, expect, test } from "bun:test";

import type { RecordPayload } from "../web/src/lib/dragPayload.ts";
import {
  FILES_TYPE,
  MENTION_MIME,
  SESSION_MIME,
  classifyDrag,
  readDragPayload,
  readSessionDrag,
} from "../web/src/lib/dragPayload.ts";

/** What `dragHandlers` actually writes for a whole record. */
const RECORD: RecordPayload = {
  kind: "record",
  table: "thesis",
  id: "9f2c0a71e3b8465d8c1a4f7d206be5a1",
  name: "th-margin-expansion-9x2b",
};

describe("a record", () => {
  test("comes back whole", () => {
    expect(readDragPayload(JSON.stringify(RECORD))).toEqual(RECORD);
  });

  test("keeps a column when one was dragged, and has none when it was not", () => {
    const field = { ...RECORD, column: "seikan_report" };
    expect(readDragPayload(JSON.stringify(field))).toMatchObject({ column: "seikan_report" });
    expect(readDragPayload(JSON.stringify(RECORD))).not.toHaveProperty("column");
  });

  test("is what a payload with no `kind` is read as", () => {
    // Both sides ship together, so this can only come from a window mid-reload against a newer
    // server. Reading it as the older shape is what it is.
    const { kind: _kind, ...older } = RECORD;
    expect(readDragPayload(JSON.stringify(older))).toEqual(RECORD);
  });

  test("falls back to the id when the name is missing, rather than drawing a blank pill", () => {
    const { name: _name, ...unnamed } = RECORD;
    expect(readDragPayload(JSON.stringify(unnamed))).toMatchObject({ name: RECORD.id });
  });

  test("is refused for a table this window does not address", () => {
    // The whole reason the check exists: an unknown table would reach the agent inside the mention
    // grammar as a record that cannot exist.
    expect(readDragPayload(JSON.stringify({ ...RECORD, table: "secrets" }))).toBe(null);
    // A junction is the sharper case than an invented name: `regime` is a real table this window
    // knows the word for, and it still cannot be a chip — an edge has no identity to address.
    expect(readDragPayload(JSON.stringify({ ...RECORD, table: "regime" }))).toBe(null);
  });

  test("is refused without an id, and for a column that is not a string", () => {
    expect(readDragPayload(JSON.stringify({ ...RECORD, id: "" }))).toBe(null);
    expect(readDragPayload(JSON.stringify({ ...RECORD, id: 7 }))).toBe(null);
    expect(readDragPayload(JSON.stringify({ ...RECORD, column: 3 }))).toBe(null);
  });
});

describe("contents, which nothing carries over this MIME any more", () => {
  test("a payload holding a form's values instead of a row's address is nothing at all", () => {
    // The draft that used to ride here, refused by the only rule left: it names a table and a label
    // and a bag of typed values, and it has NO ID — because it described a record that did not exist
    // yet, which was the entire point of it. `readRecord` demands a known table and a non-empty id,
    // so a payload carrying contents fails on the address it does not have rather than on a `kind`
    // this module would otherwise have to keep a list of.
    const draft = {
      kind: "draft",
      table: "information_source",
      label: "EDGAR",
      fields: { source: "EDGAR", hosts: "sec.gov\nefts.sec.gov" },
    };
    expect(readDragPayload(JSON.stringify(draft))).toBe(null);
    // And a well-formed address is still read as one whatever it CLAIMS to be, which is the other
    // half of the same rule: the kind is not the check, the address is.
    expect(readDragPayload(JSON.stringify({ ...RECORD, kind: "draft" }))).toEqual(RECORD);
  });

  test("the extra keys a draft carried are dropped rather than passed along", () => {
    // A record address with a form's leftovers stuck to it comes back as the address alone. Nothing
    // downstream declares `fields` or `label`, and a payload that smuggled them through would be a
    // second shape for the composer to grow a branch for.
    const smuggled = { ...RECORD, label: "EDGAR", fields: { source: "EDGAR" }, row: "4a1d" };
    expect(readDragPayload(JSON.stringify(smuggled))).toEqual(RECORD);
  });
});

describe("anything else", () => {
  test("is null rather than a throw", () => {
    for (const raw of ["", "not json", "[]", "null", '"a string"', "7"]) {
      expect(readDragPayload(raw)).toBe(null);
    }
  });
});

describe("a conversation, on a drag of its own", () => {
  test("it round-trips, and the summary is what the toast will name", () => {
    const raw = JSON.stringify({ kind: "session", sessionId: "s-1", summary: "About semis" });
    expect(readSessionDrag(raw)).toEqual({
      kind: "session",
      sessionId: "s-1",
      summary: "About semis",
    });
  });

  test("a missing summary falls back to the id, because a toast with a blank in it reads as a bug", () => {
    // The same fallback a chip makes for a record with no name, and for the same reason: the thing
    // being named is gone by the time the sentence is drawn, so there is nowhere else to read it
    // from.
    expect(readSessionDrag(JSON.stringify({ kind: "session", sessionId: "s-1" }))).toEqual({
      kind: "session",
      sessionId: "s-1",
      summary: "s-1",
    });
    expect(
      readSessionDrag(JSON.stringify({ kind: "session", sessionId: "s-1", summary: "" })),
    ).toMatchObject({ summary: "s-1" });
  });

  test("it demands its own kind, so a record handed to it is null", () => {
    // THE HALF THAT KEEPS THE TWO APART. Each reader answers only for its own MIME, so a payload
    // that somehow arrived on the wrong one is ignored rather than half-read — which is what stops
    // a conversation ever being turned into a mention, whatever a drag claims to be carrying.
    const record = JSON.stringify({ kind: "record", table: "thesis", id: "t1", name: "dip" });
    expect(readSessionDrag(record)).toBe(null);
    const session = JSON.stringify({ kind: "session", sessionId: "s-1", summary: "x" });
    expect(readDragPayload(session)).toBe(null);
  });

  test("anything else is null, the same way and for the same reason", () => {
    for (const raw of ["", "not json", "[]", "null", '"a string"', "7"]) {
      expect(readSessionDrag(raw)).toBe(null);
    }
    for (const bad of [
      { kind: "session" },
      { kind: "session", sessionId: "" },
      { kind: "session", sessionId: 7 },
    ]) {
      expect(readSessionDrag(JSON.stringify(bad))).toBe(null);
    }
  });
});

describe("what a drag is carrying, decided before it is dropped", () => {
  test("this window's own drag is a record", () => {
    expect(classifyDrag([MENTION_MIME, "text/plain"])).toBe("record");
    expect(classifyDrag([MENTION_MIME])).toBe("record");
  });

  test("a drag from the operating system is files", () => {
    expect(classifyDrag([FILES_TYPE])).toBe("files");
    expect(classifyDrag(["text/plain", FILES_TYPE])).toBe("files");
  });

  test("a conversation is its own kind, and never a record", () => {
    // THE SEPARATION THE BIN AND THE COMPOSER BOTH REST ON. A session row is not a record: nothing
    // addresses a transcript, `@session:…` names nothing, and a composer that took one would offer
    // to make a chip it could never spell. Two MIMEs is what lets that be decided from `types`, in
    // the one moment where the decision has to be made and the payload cannot be read.
    expect(classifyDrag([SESSION_MIME])).toBe("session");
    expect(classifyDrag([SESSION_MIME, FILES_TYPE])).toBe("session");
    // And a session drag carries NO `text/plain`: a record's prose is its mention grammar, and a
    // conversation has none, so a stray drop into any text box must paste nothing.
    expect(classifyDrag([SESSION_MIME, "text/plain"])).toBe("session");
  });

  test("a drag carrying BOTH is read as a record", () => {
    // Nothing in this window mints one, and the ordering is written down anyway rather than left to
    // whichever branch happened to be first: doing both would put a chip AND an upload on screen
    // for one gesture.
    expect(classifyDrag([MENTION_MIME, FILES_TYPE])).toBe("record");
    expect(classifyDrag([FILES_TYPE, MENTION_MIME])).toBe("record");
    // Including against a session, for the same reason and with the same answer: one gesture, one
    // reading, and the richer one wins.
    expect(classifyDrag([MENTION_MIME, SESSION_MIME])).toBe("record");
    expect(classifyDrag([SESSION_MIME, MENTION_MIME])).toBe("record");
  });

  test("everything else is nothing, and the composer lets the browser have it", () => {
    // The safety property of the whole composer: a paragraph from another window, a URL from the
    // address bar, a selection from the transcript — every one lands in the textarea natively, with
    // the browser's own undo entry behind it, because nothing here calls `preventDefault` for them.
    for (const types of [["text/plain"], ["text/uri-list"], ["text/html"], []]) {
      expect(classifyDrag(types)).toBe("none");
    }
  });
});
