/**
 * What a chip turns back into on its way out.
 *
 * The composer holds two things that look nothing alike: a list of chips above the textarea, and the
 * string the person typed in it. The wire carries one string. `serializeOutgoing` is the single seam
 * between those two facts, and it is worth its own file because everything downstream of it —
 * `UserMessage`'s pills, the agent reading `system.md`'s grammar, whatever quotes the transcript a
 * year from now — sees only what it wrote. A chip that serialised to something `findMentions` cannot
 * read back would be a record the user believes they attached and nobody can resolve, and the
 * failure would be silent in both directions.
 *
 * THE NAME IS WHAT TRAVELS, and this file used to lock in the opposite. A record chip carries both
 * halves — an `id` and a `name` — and which one goes out is the whole question the module answers.
 * It was the id: a name was read by no rule, and a rename could not be allowed to break a reference.
 * A name is unique within its table now and `resolveRecordId` turns one back into a row, so the word
 * on the chip is the word the agent is handed and the id never leaves the window — it is what opens
 * a card locally, which is a different question from what the sentence says. The cost is real and is
 * stated in `web/src/lib/mention.ts`: a message written before a rename names something that has
 * moved.
 *
 * So the tests below assert the exact bytes AND scan them back. The bytes are the contract the
 * composer and the agent share; the scan is the proof that the grammar module agrees, which is the
 * half a hand-written expectation cannot check.
 *
 * TWO KINDS OF CHIP, AND THERE WERE THREE. The third was a DRAFT: a half-filled editor's contents in
 * a fenced `yewreview-draft` JSON block, dragged into the conversation so the agent could look at
 * values that were not in the database and might never be. The suite that pinned it — the fence, the
 * `row` that said which record it would correct, the ordering of records before drafts, the proof
 * that `findMentions` deliberately found nothing inside one — is gone with the editors that produced
 * it. No editor in this window holds values any more: a record is written by asking for it, so what
 * the agent is given is the reader's own sentences and its own questions about them. What is left is
 * an ADDRESS (a record) and a PLACE ON DISK (a file), and the message is the reader's words in
 * between.
 */

import { describe, expect, test } from "bun:test";

import { findMentions } from "../web/src/lib/mention.ts";
import type { ComposerChip } from "../web/src/lib/outgoing.ts";
import { FILE_PREFIX, chipKey, serializeOutgoing } from "../web/src/lib/outgoing.ts";

/** The chip kind this file is mostly about, named so a fixture can be read for its `id` without a
 * narrowing dance every time — the point of several tests below is that the id is THERE and still
 * does not travel. */
type RecordChip = Extract<ComposerChip, { kind: "record" }>;

/** A record row dragged from the graph: the whole row, under the name it answers to. */
const THESIS: RecordChip = {
  kind: "record",
  table: "thesis",
  id: "9f2c0a71e3b8465d8c1a4f7d206be5a1",
  name: "semis-inventory-glut",
};

/** A field row dragged from the record viewer: the same kind of chip, one column of the row named. */
const SOURCE: RecordChip = {
  kind: "record",
  table: "script",
  id: "4a1d90c2f7bb4e6ea0d3915c7f2e88b1",
  name: "fetch-revenue",
  column: "source",
};

/**
 * A chip whose name has to be double-quoted, and it is an ORDINARY one now.
 *
 * A target's name is the instrument's official full name — looked up rather than composed, and never
 * slugified — so the first target anybody records already spells a quoted mention, and every rename
 * the reader types can put a space or a comma in any other table's name. What the fixture is here to
 * catch has not changed: this module DEFERS the spelling to `buildMention` instead of deciding it. A
 * composer that concatenated `@${table}:${name}` itself would pass every other test in this file and
 * write an unreadable mention the first time it met a name with a space in it — which is now the
 * first target it meets.
 */
const TARGET: RecordChip = {
  kind: "record",
  table: "target",
  id: "2330.TW",
  name: "Taiwan Semiconductor Manufacturing Company Limited",
};

describe("the message that leaves the composer", () => {
  test("a message with no chips is the text and nothing else", () => {
    expect(serializeOutgoing([], "measure 2330 over five years")).toBe("measure 2330 over five years");
    // Whitespace INSIDE the message survives. The composer is not a formatter, and a paragraph
    // break somebody typed is something they meant.
    expect(serializeOutgoing([], "two lines\n\nand a gap")).toBe("two lines\n\nand a gap");
    expect(serializeOutgoing([], "")).toBe("");
  });

  test("chips with nothing typed after them are the whole message", () => {
    // Dragging a record and pressing send is a real thing to do — it means "this one" — and it must
    // not produce a message with an empty line hanging off the end of it.
    expect(serializeOutgoing([THESIS], "")).toBe("@thesis:semis-inventory-glut");
    expect(serializeOutgoing([THESIS, SOURCE], "")).toBe(
      "@thesis:semis-inventory-glut @script:fetch-revenue#source",
    );
  });

  test("the mentions come first, then one newline, then what was typed", () => {
    // The chips sit above the textarea on screen, so they read above the sentence on the wire too:
    // what the reader saw is the order the agent gets.
    expect(serializeOutgoing([THESIS], "what does this rest on?")).toBe(
      "@thesis:semis-inventory-glut\nwhat does this rest on?",
    );
    expect(serializeOutgoing([THESIS, TARGET], "compare these")).toBe(
      '@thesis:semis-inventory-glut @target:"Taiwan Semiconductor Manufacturing Company Limited"\ncompare these',
    );
  });

  test("a chip dragged from a field row carries its column", () => {
    expect(serializeOutgoing([SOURCE], "is this fetching adjusted prices?")).toBe(
      "@script:fetch-revenue#source\nis this fetching adjusted prices?",
    );
  });

  test("a name that cannot go bare is double-quoted, because the grammar says so and not because this module decides", () => {
    expect(serializeOutgoing([TARGET], "")).toBe(
      '@target:"Taiwan Semiconductor Manufacturing Company Limited"',
    );
    // Whatever the reader renamed a row to, including the characters the grammar has to escape.
    const awkward: RecordChip = { ...THESIS, name: 'the "glut", revisited/again' };
    expect(serializeOutgoing([awkward], "")).toBe('@thesis:"the \\"glut\\", revisited/again"');
  });

  test("everything it writes is read back as the chip that wrote it", () => {
    // The whole point. `findMentions` is what `UserMessage` renders with and what the agent is
    // taught in `system.md`, so a chip it cannot recover is a record the user attached to nothing.
    const chips: RecordChip[] = [THESIS, SOURCE, TARGET];
    const found = findMentions(serializeOutgoing(chips, "read all three"));
    expect(found).toHaveLength(chips.length);
    for (const [index, chip] of chips.entries()) {
      expect(found[index]).toMatchObject({ table: chip.table, name: chip.name });
      expect(found[index]?.column).toBe(chip.column);
    }
  });

  test("the id the window was holding never reaches the wire", () => {
    // The inversion, pinned from the other side. An id is how this window opens a card and it is
    // meaningless to the reader and unnecessary to the agent, which resolves the name itself. Two
    // chips for the same row that disagree about the id therefore send the same message — and a chip
    // dragged from a card whose id nobody looked at sends the right one anyway.
    const sent = serializeOutgoing([THESIS, SOURCE, TARGET], "read all three");
    for (const chip of [THESIS, SOURCE, TARGET]) expect(sent).not.toContain(chip.id);
    const restaled: RecordChip = { ...THESIS, id: "0681f8efbf0c4dd49bf96c9a7b352dcc" };
    expect(serializeOutgoing([restaled], "go")).toBe(serializeOutgoing([THESIS], "go"));
  });
});

describe("the key that tells two chips apart", () => {
  test("tells the whole record apart from one field of it", () => {
    // Dragging a script and then dragging its `source` row is two chips, not one dragged twice.
    // Deduplicating them together would silently drop whichever arrived second.
    const record: RecordChip = { kind: "record", table: "script", id: SOURCE.id, name: SOURCE.name };
    expect(chipKey(record)).not.toBe(chipKey(SOURCE));
  });

  test("tells two fields of one record apart", () => {
    const domain: RecordChip = { ...SOURCE, column: "domain" };
    expect(chipKey(SOURCE)).not.toBe(chipKey(domain));
  });

  test("tells two tables that happen to share a name apart", () => {
    // Uniqueness is claimed WITHIN a table and nowhere else, so a report and a thesis may both be
    // called `semis-inventory` — and the table is part of the mention, so it is part of the key.
    const name = "semis-inventory";
    expect(chipKey({ kind: "record", table: "report", id: "r-1", name })).not.toBe(
      chipKey({ kind: "record", table: "thesis", id: "t-1", name }),
    );
  });

  test("is the words it would write, so the same record dragged twice is one chip", () => {
    // The two rows that drag a record — the graph row and the viewer's field row, or the same row
    // twice — may hold different IDS for it, if one was picked up from a stale card. The key is what
    // makes the second drag a no-op instead of a duplicate pill to remove twice, and it does not
    // consult the id at all.
    expect(chipKey({ ...SOURCE, id: "picked-up-elsewhere" })).toBe(chipKey(SOURCE));
    expect(chipKey({ ...THESIS, id: "picked-up-elsewhere" })).toBe(chipKey(THESIS));
  });

  test("a record dragged again after a rename is a DIFFERENT chip", () => {
    // The exact cost of keying on the words: the reader renames a thesis with a chip for it already
    // in the composer, drags it again, and gets two chips naming one row. That is the honest outcome
    // rather than a bug to paper over — the two chips would write two different sentences, and a key
    // that called them one would have to choose which sentence to send.
    const renamed: RecordChip = { ...THESIS, name: "the-glut-clears" };
    expect(chipKey(renamed)).not.toBe(chipKey(THESIS));
    expect(serializeOutgoing([THESIS, renamed], "")).toBe(
      "@thesis:semis-inventory-glut @thesis:the-glut-clears",
    );
  });
});

describe("the fenced block that is not written any more", () => {
  test("nothing a chip can be produces a fence, so a message is prose all the way down", () => {
    // PINNED RATHER THAN MERELY ABSENT. The draft block was the one thing this function wrote that
    // was not the reader's own words — a JSON body inside a ```yewreview-draft fence — and everything
    // downstream had to know about it: `splitAttachments` skips fenced regions so a path quoted
    // inside one is not drawn as a link, `findMentions` deliberately found no addresses in one, and
    // the prompt had to teach a second grammar nested inside the first. With no editor holding
    // values there is nothing to fence, and a chip that reintroduced one would be a second channel
    // carrying what the transcript already says.
    const chips: readonly ComposerChip[] = [
      THESIS,
      SOURCE,
      TARGET,
      { kind: "file", token: "t-1", name: "q3.pdf", path: "uploads/1a2b3c4d/q3.pdf" },
    ];
    const sent = serializeOutgoing(chips, "does this look right?");
    expect(sent).not.toContain("```");
    expect(sent).not.toContain("yewreview-draft");
    // And every line of it is one of the three things a message is made of: mentions, a file line,
    // or what the reader typed.
    expect(sent.split("\n")).toEqual([
      `${chipKey(THESIS)} ${chipKey(SOURCE)} ${chipKey(TARGET)}`,
      `${FILE_PREFIX} uploads/1a2b3c4d/q3.pdf`,
      "does this look right?",
    ]);
  });
});

describe("a file, which is not an address but a place on disk", () => {
  const READY: ComposerChip = {
    kind: "file",
    token: "t-1",
    name: "q3-earnings.pdf",
    path: "uploads/1a2b3c4d/q3-earnings.pdf",
  };
  const PENDING: ComposerChip = { kind: "file", token: "t-2", name: "slow.csv", path: null };

  test("it goes out as one line naming the path", () => {
    // The prefix is what `src/claudecode/prompts/system.md` teaches, and it is exported so the two
    // spellings cannot drift apart without this failing.
    expect(serializeOutgoing([READY], "what is in this")).toBe(
      `${FILE_PREFIX} uploads/1a2b3c4d/q3-earnings.pdf\nwhat is in this`,
    );
  });

  test("a file still uploading writes nothing at all", () => {
    // The composer's button is the reader-facing gate; this is the one that would matter if that
    // broke. A message naming a path the server has not created is a message the agent cannot act
    // on.
    expect(serializeOutgoing([PENDING], "read it")).toBe("read it");
    expect(serializeOutgoing([PENDING], "")).toBe("");
  });

  test("several files keep the order they were dropped in, one per line", () => {
    // One per line rather than space-joined, unlike the mentions: a filename may contain spaces, so
    // a space-joined list of paths is a list nothing can take apart again.
    const second: ComposerChip = { ...READY, token: "t-3", path: "uploads/5e6f7a8b/a b.csv" };
    expect(serializeOutgoing([READY, second], "")).toBe(
      `${FILE_PREFIX} uploads/1a2b3c4d/q3-earnings.pdf\n${FILE_PREFIX} uploads/5e6f7a8b/a b.csv`,
    );
  });

  test("records first, then files, then what was typed, whatever order they were dropped in", () => {
    // The reader dropped these beside their sentence rather than into it, so there is no insertion
    // point to honour — and a message that opens with what it is about, then says what to do with
    // it, is the shape the agent reads best. The chips arrive here in whatever order the composer
    // holds them; the ORDER ON THE WIRE is this function's and is fixed.
    const sent = serializeOutgoing([READY, THESIS], "compare these");
    expect(sent.split("\n")).toEqual([
      chipKey(THESIS),
      `${FILE_PREFIX} uploads/1a2b3c4d/q3-earnings.pdf`,
      "compare these",
    ]);
  });

  test("a file alone is a message", () => {
    expect(serializeOutgoing([READY], "")).toBe(`${FILE_PREFIX} uploads/1a2b3c4d/q3-earnings.pdf`);
  });

  test("a path is not a mention, and `findMentions` finds nothing in one", () => {
    expect(findMentions(serializeOutgoing([READY], "read it"))).toHaveLength(0);
  });

  test("its key is the drop, so two files of the same name are two chips", () => {
    // Identity cannot be the name — two folders both hold a `data.csv` and the reader meant both —
    // and cannot be the path, which does not exist yet when the chip first appears. This is the one
    // chip whose key is not the words it writes, because a file writes a path and has no row.
    const sameName: ComposerChip = { ...READY, token: "t-9" };
    expect(chipKey(sameName)).not.toBe(chipKey(READY));
  });

  test("its key does not change when the upload lands", () => {
    // This is what lets the resolution find the chip it belongs to, and what stops React from
    // throwing the pill away and building a new one when the path arrives.
    const landed: ComposerChip = { ...PENDING, path: "uploads/aabbccdd/slow.csv" };
    expect(chipKey(landed)).toBe(chipKey(PENDING));
  });
});
