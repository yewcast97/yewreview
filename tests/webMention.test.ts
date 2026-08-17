/**
 * The mention grammar.
 *
 * `@table:name` is the one piece of syntax shared by three parties that never talk to each other
 * directly: the record panel writes it into a drag payload, the composer serialises a chip into it,
 * and the agent reads it in `system.md` and hands the pair to `resolveRecordId`. Nothing enforces
 * agreement at runtime, so the round trip — every name shape this schema holds, built and then
 * parsed back — is the enforcement.
 *
 * IT NAMES THE ROW BY ITS NAME, and it used to name it by its id, which is what makes the second
 * spelling matter now. When the address was a uuid or a ticker, every mention went bare and the
 * quoted branch was a museum piece kept alive by a hand-built fixture. A NAME IS THE READER'S TO
 * WRITE: a target's is the instrument's official full name and arrives with spaces already in it,
 * and anything the reader renames a row to is a name — commas, slashes, quotes and all. So the
 * quoted branch below is exercised with names this database really holds, and the escaping is a live
 * rule rather than a precaution.
 *
 * `@table:name#column` is the same string with one field of the row named on the end, which is what a
 * field row in the record viewer drags. It gets its own block below because it is the one place two
 * rules in this module have to stay out of each other's way: the class that matches a bare name holds
 * the punctuation a sentence ends with, and the suffix is what says where the name stopped.
 *
 * The bound on a bare name is imported from `src/repo/naming.ts` rather than spelled again: it is
 * `MAX_NAME_LENGTH`, the longest name a rename may set, so every name the database will accept can be
 * written bare if its characters allow it. Raising one without the other is what these tests are here
 * to notice.
 */

import { describe, expect, test } from "bun:test";

import { MAX_NAME_LENGTH } from "../src/repo/naming.ts";
import type { RecordTable } from "../src/repo/records.ts";
import { RECORD_TABLES } from "../src/repo/records.ts";
import {
  BARE_NAME,
  buildMention,
  COLUMN_NAME,
  findMentions,
  isMentionTable,
  MENTION_TABLES,
  mentionFor,
  parseMention,
} from "../web/src/lib/mention.ts";

/**
 * The names that go bare, one per way of coming by one rather than one per table.
 *
 * Every minted name is a slug — lowercase, hyphen-joined, sometimes with four base36 characters
 * stapled on where the obvious name was taken — so the bare branch carries the ordinary traffic. The
 * two that are not slugs are the interesting ones: a target's name is looked up rather than composed,
 * and a renamed row carries whatever the reader typed, which is how `.` and `_` get in.
 */
const BARE: Array<[RecordTable, string, string]> = [
  ["thesis", "semis-inventory-glut", "a minted slug"],
  ["thesis", "nvda-q3-4k7p", "a minted slug carrying the suffix a collision earned it"],
  ["information_source", "sec-gov-filings", "a source's minted name"],
  ["information_source", "sec.gov", "a source reworded to the host itself, dot and all"],
  ["script_invocation", "fetch-revenue", "a run named after the script it ran"],
  ["trivial_shell_history_for_report", "ls", "a shell line named after its first word"],
  ["script", "fetch_revenue", "a script reworded with an underscore"],
  ["target", "NVIDIA", "an instrument's official name that happens to be one word"],
];

/**
 * The names that have to be double-quoted, and every one of them is a name this schema really holds.
 *
 * That is the fact worth stating plainly, because the file it replaced said the opposite: NO ID
 * NEEDED QUOTING and now most prose does. A target's name is the instrument's official full name —
 * nobody composed it and nothing slugified it — so the very first target recorded already spells a
 * quoted mention. Everything under it is a rename, which the reader may do at any moment to anything
 * that is one line and eighty characters or fewer.
 */
const QUOTED: Array<[RecordTable, string, string]> = [
  ["target", "Taiwan Semiconductor Manufacturing Company Limited", "an official name, which is prose"],
  ["recipe", "semis, the second pass", "a rename with a comma in it"],
  ["script", "fetch revenue/v2", "a rename with a space and a slash"],
  ["thesis", 'the "glut" thesis', "a rename with quotes inside it"],
  ["script", "back\\slash", "a rename with a backslash in it"],
];

/** The one used wherever a single quoted name is wanted. */
const QUOTED_NAME = "fetch revenue/v2";

describe("the vocabulary", () => {
  test("is exactly the record tables, and nothing else", () => {
    // The web module cannot import the array — it would drag a server module into the bundle — so
    // it holds a type-checked copy. This is the runtime half of that lock.
    expect([...MENTION_TABLES].sort()).toEqual([...RECORD_TABLES].sort());
    for (const table of RECORD_TABLES) expect(isMentionTable(table)).toBe(true);
    // A junction is a link between records, not a record, and cannot be mentioned. Neither can a
    // LOG: `deletion_log` and `error_log` describe records rather than being any, and their rows are
    // read as a stream through one route rather than addressed.
    expect(isMentionTable("regime")).toBe(false);
    expect(isMentionTable("workbench")).toBe(false);
    expect(isMentionTable("deletion_log")).toBe(false);
    expect(isMentionTable("error_log")).toBe(false);

    // Neither can a name this schema does not have. This matters where a near-miss does not: prose
    // in a conversation can hold `@claim:…`, and the honest reading of that text is prose — no record
    // answers to it, and drawing a pill that resolves to a 404 would be the window insisting on an
    // address the database has never heard of.
    //
    // `message` is the one somebody will trip over: the transcript lives in the SDK's own session
    // store rather than in a table, so `@message:417` names nothing at all.
    for (const absent of ["claim", "series", "tool_invocation", "workflow", "message"]) {
      expect(isMentionTable(absent)).toBe(false);
      expect(findMentions(`@${absent}:semis-inventory-glut`)).toEqual([]);
    }
    expect(findMentions("@message:417")).toEqual([]);
  });

  test("is ordered longest-first, so no table name shadows a longer one", () => {
    const lengths = MENTION_TABLES.map((table) => table.length);
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });
});

describe("building and parsing", () => {
  for (const [table, name, what] of [...BARE, ...QUOTED]) {
    test(`round-trips ${what}`, () => {
      const text = buildMention(table, name);
      expect(parseMention(text)).toEqual({ table, name });
      expect(mentionFor({ table, name })).toBe(text);
    });
  }

  test("a name that can be written bare is written bare", () => {
    expect(buildMention("thesis", "semis-inventory-glut")).toBe("@thesis:semis-inventory-glut");
    expect(buildMention("information_source", "sec.gov")).toBe("@information_source:sec.gov");
    expect(buildMention("target", "NVIDIA")).toBe("@target:NVIDIA");
    for (const [, name] of BARE) expect(BARE_NAME.test(name)).toBe(true);
  });

  test("a name that cannot is double-quoted", () => {
    // The rule turns on the CHARACTERS and never on the table: a space and a slash are what put this
    // name outside `BARE_NAME`, and the same name on any of the other eleven tables would be quoted
    // the same way. Which is why a target — the one table whose name nothing slugifies — needs no
    // rule of its own here.
    expect(buildMention("script", QUOTED_NAME)).toBe('@script:"fetch revenue/v2"');
    expect(buildMention("target", "Taiwan Semiconductor Manufacturing Company Limited")).toBe(
      '@target:"Taiwan Semiconductor Manufacturing Company Limited"',
    );
    for (const [, name] of QUOTED) expect(BARE_NAME.test(name)).toBe(false);
  });

  test("a quote or a backslash inside a name survives the round trip", () => {
    // Not a hypothetical: a rename takes any line of text, so `the "glut" thesis` is a name somebody
    // will write. Both characters are escaped on the way out and unescaped on the way back, and a
    // name carrying one of each is what proves the two rules compose.
    const name = 'fetch "revenue"\\v2';
    const text = buildMention("script", name);
    expect(text).toBe('@script:"fetch \\"revenue\\"\\\\v2"');
    expect(parseMention(text)).toEqual({ table: "script", name });
  });

  test("a `#` inside a name is part of the name and not a column", () => {
    // The suffix's separator cannot appear in a bare name — the class excludes it — so a name
    // carrying one is quoted, and the closing quote is what says the name ended. Without that, a row
    // renamed `q3 #2` would be read as a mention of `q3` naming a column called `2`.
    const name = "q3 #2";
    const text = buildMention("report", name);
    expect(text).toBe('@report:"q3 #2"');
    expect(parseMention(text)).toEqual({ table: "report", name });
    expect(parseMention(buildMention("report", name, "title"))).toEqual({
      table: "report",
      name,
      column: "title",
    });
  });

  test("the bare bound is the bound on a name, so every name that can go bare does", () => {
    // `MAX_NAME_LENGTH` is imported rather than spelled: raising the length a rename accepts without
    // widening the bare class would quietly start quoting names that used to go bare, and every
    // mention written before the change would still parse — which is exactly the kind of drift
    // nothing else would notice.
    const longest = "a".repeat(MAX_NAME_LENGTH);
    expect(BARE_NAME.test(longest)).toBe(true);
    expect(buildMention("script", longest)).toBe(`@script:${longest}`);
    expect(parseMention(buildMention("script", longest))).toEqual({ table: "script", name: longest });

    // And the scanner agrees with the builder about where the bound is: a bare name of the full
    // length is matched whole rather than clipped short by a narrower class inside the regex.
    const found = findMentions(`see @script:${longest} first`);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe(longest);
  });

  test("a name longer than the bound is quoted rather than truncated", () => {
    // The database will not hand one out — `renameRecord` refuses past `MAX_NAME_LENGTH` — so this
    // is about the grammar staying TOTAL. A builder that truncated would emit a mention naming a row
    // that does not exist, which is worse than a long one.
    const name = "a".repeat(MAX_NAME_LENGTH + 1);
    expect(buildMention("script", name)).toBe(`@script:"${name}"`);
    expect(parseMention(buildMention("script", name))).toEqual({ table: "script", name });
  });

  test("the grammar carries the case it was written in, and folds nothing", () => {
    // Names are `COLLATE NOCASE` in the database, so these two spellings name the same row — but
    // that is the database's rule and `state/names.ts`'s key, not this module's. A grammar that
    // lowercased would make `text` no longer equal to what it spans, and a pill would redraw the
    // reader's sentence in a case they did not write.
    expect(buildMention("thesis", "Semis-Inventory-Glut")).toBe("@thesis:Semis-Inventory-Glut");
    expect(parseMention("@thesis:Semis-Inventory-Glut")).toEqual({
      table: "thesis",
      name: "Semis-Inventory-Glut",
    });
    expect(findMentions("@thesis:SEMIS-INVENTORY-GLUT")[0]?.name).toBe("SEMIS-INVENTORY-GLUT");
  });

  test("parseMention takes the whole string, or nothing", () => {
    expect(parseMention("@target:NVIDIA")).toEqual({ table: "target", name: "NVIDIA" });
    // Prose that CONTAINS a mention is `findMentions`' question, not this one's.
    expect(parseMention("look at @target:NVIDIA")).toBeNull();
    expect(parseMention("@target:NVIDIA ")).toBeNull();
    expect(parseMention("@nosuchtable:x")).toBeNull();
    expect(parseMention("")).toBeNull();
  });
});

describe("a mention that names one column", () => {
  test("round-trips a bare name with a column", () => {
    const name = "fetch-revenue";
    const text = buildMention("script", name, "source");
    expect(text).toBe(`@script:${name}#source`);
    expect(parseMention(text)).toEqual({ table: "script", name, column: "source" });
    expect(mentionFor({ table: "script", name }, "source")).toBe(text);
  });

  test("round-trips a quoted name with a column", () => {
    // The suffix sits outside both name branches, so it works after a closing quote as well as after
    // a bare name. That is what keeps the two rules from ever having to be written twice: a name that
    // has to be quoted can still have one of its fields named, with no second pairing rule to get
    // wrong — and since a rename can put a space in any name, this is the common case now rather than
    // the odd one.
    const text = buildMention("script", QUOTED_NAME, "source");
    expect(text).toBe('@script:"fetch revenue/v2"#source');
    expect(parseMention(text)).toEqual({ table: "script", name: QUOTED_NAME, column: "source" });
    expect(mentionFor({ table: "script", name: QUOTED_NAME }, "source")).toBe(text);
  });

  test("drops a column that would not be read back, rather than writing it", () => {
    // A spelling that does not round-trip is worse than the missing detail: `@script:abc#a column`
    // scans back as a plain record mention with prose after it, so the reader is told a field was
    // named and the parser disagrees. `buildMention` refuses to write that string at all.
    const name = "fetch-revenue";
    expect(buildMention("script", name, "a column")).toBe(`@script:${name}`);
    expect(buildMention("script", name, "")).toBe(`@script:${name}`);
    expect(buildMention("script", name, "2source")).toBe(`@script:${name}`);
    expect(buildMention("script", name, "retrieved-at")).toBe(`@script:${name}`);
    expect(buildMention("script", name, "a".repeat(65))).toBe(`@script:${name}`);
    // And what it does write parses back, every time.
    for (const column of ["source", "retrieved_at", "_x", "a".repeat(64)]) {
      expect(COLUMN_NAME.test(column)).toBe(true);
      expect(parseMention(buildMention("script", name, column))).toEqual({
        table: "script",
        name,
        column,
      });
    }
  });

  test("ends at the punctuation after the column, and leaves it as prose", () => {
    const text = "@report:q3-semis#title.";
    const found = findMentions(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ table: "report", name: "q3-semis", column: "title" });
    expect(found[0]?.text).toBe("@report:q3-semis#title");
    // The full stop ended the sentence, not the column name — the class that matches a column
    // shares no character with it, so the two rules never have to negotiate.
    expect(text.slice(found[0]!.end)).toBe(".");
  });

  test("leaves the trailing-punctuation trim to the mentions that have no column", () => {
    // Without a suffix the bare-name class cannot tell its own last character from the punctuation
    // after it, so the trim runs.
    const plain = findMentions("@report:q3-semis.");
    expect(plain).toHaveLength(1);
    expect(plain[0]?.name).toBe("q3-semis");
    expect(plain[0]?.text).toBe("@report:q3-semis");
    expect(plain[0]).not.toHaveProperty("column");

    // With one, the `#` already said where the name stopped. Trimming here would corrupt a name the
    // reader spelled deliberately — nothing MINTS a name ending in a hyphen, but a rename may write
    // one — and would leave `text` no longer equal to what it spans.
    const suffixed = findMentions("@report:q3-semis-#title");
    expect(suffixed[0]).toMatchObject({ name: "q3-semis-", column: "title" });
    expect(suffixed[0]?.text).toBe("@report:q3-semis-#title");
  });

  test("a `#` after a table this window does not know is prose, suffix and all", () => {
    expect(findMentions("@nowhere:q3-semis#title")).toEqual([]);
    expect(findMentions("@regime:semis-inventory-glut#ticker")).toEqual([]);
    expect(findMentions('@report:""#title')).toEqual([]);
  });

  test("parseMention carries the column, and omits the key entirely when there is none", () => {
    const withColumn = parseMention("@script:fetch-revenue#source");
    expect(withColumn).toEqual({ table: "script", name: "fetch-revenue", column: "source" });

    // Absent, never `""` — "no column" has one spelling, so nothing downstream has to decide
    // whether an empty string meant the whole row or a field nobody named.
    const without = parseMention("@script:fetch-revenue");
    expect(without).toEqual({ table: "script", name: "fetch-revenue" });
    expect(without).not.toHaveProperty("column");
    expect(Object.keys(without!)).toEqual(["table", "name"]);

    // Still whole-string only: a column mention with a word after it is prose containing one.
    expect(parseMention("@script:fetch-revenue#source now")).toBeNull();
  });

  test("spans exactly what it matched, column and all", () => {
    const text = 'Read @script:fetch-revenue#source, then @script:"fetch revenue/v2"#domain.';
    const found = findMentions(text);
    expect(found).toHaveLength(2);
    expect(found.map((m) => m.column)).toEqual(["source", "domain"]);
    // The invariant every pill renderer stands on: replace `[start, end)` and the prose around it
    // is untouched.
    for (const mention of found) expect(text.slice(mention.start, mention.end)).toBe(mention.text);
    expect(text.slice(found[1]!.end)).toBe(".");
  });

  test("scanning text that holds both forms twice gives the same answer", () => {
    const text =
      "@target:NVIDIA and @script:fetch-revenue#source and @target:AMD and @script:fetch-revenue#domain";
    expect(findMentions(text)).toEqual(findMentions(text));
    expect(findMentions(text).map((m) => m.column)).toEqual([
      undefined,
      "source",
      undefined,
      "domain",
    ]);
  });
});

describe("finding mentions in prose", () => {
  test("finds each one, in order, with where it sits", () => {
    const text =
      'Compare @target:"Taiwan Semiconductor Manufacturing Company Limited" against ' +
      '@thesis:semis-inventory-glut using @script:"fetch revenue/v2".';
    const found = findMentions(text);
    expect(found.map((m) => `${m.table}:${m.name}`)).toEqual([
      "target:Taiwan Semiconductor Manufacturing Company Limited",
      "thesis:semis-inventory-glut",
      "script:fetch revenue/v2",
    ]);
    for (const mention of found) expect(text.slice(mention.start, mention.end)).toBe(mention.text);
  });

  test("a mention glued to a word is not a mention", () => {
    // The address, not a record: what disqualifies it is what precedes it.
    expect(findMentions("mail someone@thesis:semis-inventory-glut")).toEqual([]);
    expect(findMentions("(@target:NVIDIA)")).toHaveLength(1);
    expect(findMentions("@target:NVIDIA")).toHaveLength(1);
  });

  test("an unknown table and an empty quoted name are prose", () => {
    expect(findMentions("@nowhere:semis-inventory-glut")).toEqual([]);
    expect(findMentions('@report:""')).toEqual([]);
  });

  test("a junction is not addressable, so it is not mentionable either", () => {
    // The vocabulary is the tables a record can BE, and `regime` — the one junction left in this
    // schema — is an edge between records rather than a record. `getRecord` refuses it for the same
    // reason, and a mention the browser cannot resolve is worse than prose that was never one.
    expect(findMentions("@regime:semis-inventory-glut")).toEqual([]);
    // And a junction this schema USED to have is now doubly not one: no table answers to the name.
    expect(findMentions("@application:semis-inventory-glut")).toEqual([]);
  });

  test("both halves of a publication's run record ARE records, and are mentionable", () => {
    // Each carries an identity and a payload — the program one names and what it was told, the line
    // the other ran — and both carry what came back, what it exited with and how long it took. So a
    // reader clicking into either learns something they were not already holding, which is the whole
    // difference from an edge.
    //
    // The pair also walks both ends of the ordering `MENTION_TABLES` is sorted into.
    // `script_invocation` is the name with a shorter table sitting inside its own prefix, and
    // `trivial_shell_history_for_report` is now the LONGEST name in the vocabulary — the first
    // alternative the scanner tries. A sort that went the other way would still parse both, by
    // backtracking; what it would cost is the guarantee that the right parse is the first one
    // attempted, which is the property the ordering test above pins.
    //
    // Their names are minted like everything else: a run takes the script's name, a shell line takes
    // the first word of the command.
    expect(findMentions("@script_invocation:fetch-revenue")[0]).toMatchObject({
      table: "script_invocation",
      name: "fetch-revenue",
    });
    expect(findMentions("@trivial_shell_history_for_report:python")[0]).toMatchObject({
      table: "trivial_shell_history_for_report",
      name: "python",
    });
  });

  test("scanning twice gives the same answer", () => {
    // The exported regex is global; a shared `lastIndex` would make the second call disagree.
    const text = "@target:NVIDIA and @target:AMD";
    expect(findMentions(text)).toEqual(findMentions(text));
  });

  test("a mention that ends a sentence does not swallow the full stop", () => {
    // The ordinary case, not an edge one: `system.md` teaches the model to write mentions inline in
    // prose, and a mention at the end of a sentence is followed by a period. The bare-name class has
    // to hold `.`, `-` and `_` — every minted name is hyphenated and a source reworded to `sec.gov`
    // carries the dot — so the trim happens after the match rather than in it.
    const text = "The document is @report:q3-2025-semis.";
    const found = findMentions(text);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("q3-2025-semis");
    expect(found[0]?.text).toBe("@report:q3-2025-semis");
    // The period is left in the prose, where it belongs — the pill replaces exactly the mention.
    expect(text.slice(found[0]!.end)).toBe(".");

    expect(findMentions("@information_source:sec.gov.")[0]?.name).toBe("sec.gov");
    expect(findMentions("@information_source:sec.gov…")[0]?.name).toBe("sec.gov");
    expect(findMentions("compare @target:NVIDIA, @target:AMD-")[0]?.name).toBe("NVIDIA");
    expect(findMentions("compare @target:NVIDIA, @target:AMD-")[1]?.name).toBe("AMD");
    // A name that is nothing but punctuation names nothing, and the text stays prose.
    expect(findMentions("@target:...")).toEqual([]);
  });

  test("a quoted mention ends at its closing quote, whatever follows", () => {
    // Where a bare name has to guess whether the character after it belongs to the name or to the
    // sentence, a quoted one never does: the closing quote said so, and the words after it are prose.
    // This is what lets a name with a space in it sit in the middle of a sentence at all.
    const found = findMentions(`see @script:"${QUOTED_NAME}" then stop`);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe(QUOTED_NAME);
    expect(found[0]?.end).toBe(`see @script:"${QUOTED_NAME}"`.length);
  });

  test("two quoted mentions in one sentence do not swallow the words between them", () => {
    // The quoted class is `[^"\\]|\\.` and not `.*`, so the first closing quote ends the first
    // mention. A greedy class would read from the first quote to the LAST one and hand back a single
    // pill covering half the sentence.
    const text = '@recipe:"semis, the second pass" then @script:"fetch revenue/v2" please';
    const found = findMentions(text);
    expect(found).toHaveLength(2);
    expect(found.map((m) => m.name)).toEqual(["semis, the second pass", "fetch revenue/v2"]);
    for (const mention of found) expect(text.slice(mention.start, mention.end)).toBe(mention.text);
  });
});
