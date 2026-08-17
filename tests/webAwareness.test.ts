/**
 * The sentences this window says on the reader's behalf when they press something.
 *
 * NOTHING IS FAKED HERE AND NOTHING NEEDS TO BE: the module is six sentences and no I/O. What the file
 * is actually about is not the strings but the DECISION they encode, which is the one thing about
 * them a compiler cannot hold — so every test below is an argument about wording, written down where
 * a rewrite has to meet it.
 *
 * WHAT THESE ARE. This window no longer writes to the database. A recipe, an information source, a
 * script, a rename, a deletion — every one of them is asked for in the conversation, and
 * the agent writes the row once the reader has seen what it is about to write and agreed. That left
 * the `+` buttons and the Bin with no route to call, and this is what they do instead: they compose
 * one of these and send it as an ORDINARY USER MESSAGE. No new socket frame, no flag on a turn, no
 * server-side constant. Which buys three things worth having — the transcript is honest, because the
 * click really was an utterance and reads as one; the same words typed by hand work identically; and
 * none of it is a channel that could ever carry authority, since a message opening a subject
 * authorises nothing on the agent's side.
 *
 * WHY THEY ARE OPENINGS AND NOT ORDERS, which is the property most of this file defends. A sentence
 * that reads as a completed instruction — "create a recipe called X", "delete this" — is one an
 * agent could act on before showing anybody anything, and the entire arrangement rests on the draft
 * coming FIRST: the reader presses `+`, is shown the empty row, sees what is about to be written,
 * and says yes. So each of the four `+` sentences that raise a document says what the reader wants
 * to start, and none of them says "create" or "delete" at all.
 *
 * AND WHY THEY SAY NOTHING ELSE. Each is one sentence naming the act, and EVERY ONE OF THEM IS SPOKEN
 * INTO THE CONVERSATION ON SCREEN. Four of them used not to be: a creation once got a session of its
 * own, put the current conversation down and began a fresh one with the line. The argument was that a
 * creation should read afterwards as itself rather than as a digression, which is true about the
 * session list and false about the person, who was in the middle of something when they pressed it.
 * So there is one rule here now instead of two, and none of these sentences is an opening line in a
 * sense the others are not. What the agent does with an opening is a protocol and lives in the
 * prompt: it answers with the empty row block and ONE SHORT LINE asking for the details. These used
 * to carry that protocol themselves — "interview me for it", followed by the fields to ask about —
 * which made four paraphrases of one rule, in a place the reader could not see and the agent had no
 * reason to prefer over its own instructions. A sentence that re-specifies the agent's behaviour on
 * every press is a sentence that can disagree with the doctrine, so these state the want and stop.
 *
 * TWO SENTENCES ARE NOT OPENINGS, and each is tested for being the kind of thing it is. The Bin is
 * the near one — a row dragged onto it IS a specific request about a specific record, so its sentence
 * names the row — and it still asks first, because the useful thing an agent can say before a
 * deletion is what else goes with it. `newReport` is the real exception: it orders. What makes that
 * safe is the same argument that makes the others ask — the draft-first rule protects documents the
 * READER authors, and nobody authors a report. A generation names the recipe it works to, records
 * every command it runs, and writes its own provenance from that log, so there is no draft to show
 * and an interview would be the agent asking permission for work it was just told to do.
 *
 * AND THE ONES THAT NAME A ROW BORROW THE GRAMMAR RATHER THAN SPELLING IT. `newReport` and `binDrop`
 * lead with `buildMention`, on its own first line, so the agent knows which record without
 * being told twice — and so a name with a space or a comma in it, which is what a renamed row spells,
 * is quoted by the module that owns the quoting rules instead of being concatenated here and read
 * back as prose. The round-trip through `parseMention` is the only check of that which does not
 * depend on somebody keeping two hand-written expectations in step.
 */

import { describe, expect, test } from "bun:test";

import {
  NEW_RECIPE,
  NEW_SCRIPT,
  NEW_SOURCE,
  NEW_THESIS,
  binDrop,
  newReport,
} from "../web/src/lib/awareness.ts";
import { buildMention, findMentions, parseMention } from "../web/src/lib/mention.ts";

/**
 * The four sentences a `+` sends: the recipe box, the information-source box, the thesis box and the
 * script box. Held as a list so that the properties which must hold for ALL of them — they open a
 * subject, they ask for nothing, they order nothing — are asserted over the list rather than over
 * whichever one was written first.
 *
 * All four are CONSTANTS now. One of them used to be a function, because a playbook version was
 * raised under a named workshop and the sentence had to say which; there is no such row any more —
 * a recipe is one immutable document standing on its own — so every opening here names nothing.
 */
const OPENINGS: readonly string[] = [NEW_RECIPE, NEW_SOURCE, NEW_THESIS, NEW_SCRIPT];

/**
 * What a sentence SAYS, with a leading mention line taken off.
 *
 * The `+` sentences that name nothing are their own body; the ones that name a row open with an
 * address, and the address is not the part being read for tone.
 */
function body(said: string): string {
  const [first, ...rest] = said.split("\n");
  return parseMention(first ?? "") === null ? said : rest.join("\n");
}

describe("what a press says", () => {
  test("each is a sentence the reader could have typed themselves", () => {
    // Which is the whole mechanism: what goes out is a message, so it must be made of the things a
    // message is made of. No fence, no JSON, no marker for a server to read — the draft block that
    // used to carry a form's contents into the conversation is gone, and this is where its absence
    // would first be undone.
    for (const said of OPENINGS) {
      expect(said.length).toBeGreaterThan(0);
      expect(said.trim()).toBe(said);
      expect(said).not.toContain("```");
      expect(said).not.toContain("{");
      expect(body(said).endsWith(".")).toBe(true);
    }
  });

  test("each opens a subject in one sentence, and asks for nothing", () => {
    // The tone IS the safety property. "I'd like to…" states a want and hands the next move to the
    // agent, which is what makes the draft the agent's obvious first step rather than a courtesy it
    // might skip on a turn where it feels confident.
    //
    // AND THE ASKING IS DELIBERATELY GONE. These said "interview me for it" and then listed what to
    // ask about; that protocol is the prompt's now — answer an opening with the empty row block and
    // one short line asking for the details — so repeating it here would be four paraphrases of one
    // rule, each able to drift from it. The inverted pin is the load-bearing half of this test: an
    // opening that starts telling the agent how to conduct itself is the thing being prevented, not
    // a style choice.
    for (const said of OPENINGS) {
      expect(body(said)).toMatch(/^I'd like to /);
      expect(body(said)).not.toMatch(/\b(ask|interview)\b/i);
      // One sentence: the full stop the test above found at the end is the only one in it.
      expect(body(said).split(".").filter((part) => part.trim() !== "")).toHaveLength(1);
    }
  });

  test("none of them says `create` or `delete`, which is what stops it being an order", () => {
    // A completed instruction is one an agent could act on before showing anybody anything. These
    // say `store`, `record`, `put on record`, `save` — verbs about a subject being raised, not
    // about a row being made — and the words that would read as a settled command are absent on
    // purpose rather than by accident of phrasing.
    for (const said of OPENINGS) {
      expect(said).not.toMatch(/\b(create|delete|remove)\b/i);
    }
  });

  test("the thesis opener names the act and leaves both halves to the doctrine", () => {
    // A THESIS IS AGREED IN TWO — the claim in the reader's own words, and the measurement document
    // that is the agent's translation of it — and this sentence says none of that. It used to: it
    // asked to be interviewed and then asked for the statement and the document together, on the
    // argument that the second half is one the reader would not think to ask for.
    //
    // THAT ARGUMENT WAS ABOUT THE AGENT'S BEHAVIOUR, WHICH IS NOT THIS SENTENCE'S TO SPECIFY. Both
    // halves are agreed because `create_thesis` carries the rule and the prompt states it twice over
    // — including that a thesis is the one creation answered with no empty row block, because its
    // fields are the agent's translation rather than what the reader is holding. A sentence that
    // restated it here would be a fourth copy that can fall out of step with the three that bind,
    // and it would only ever be right for the presses that came from this button.
    expect(NEW_THESIS).toBe("I'd like to put a new thesis on record.");
  });

  test("the four that raise a subject name no record, because there is not one yet", () => {
    // A recipe that does not exist has no name to mention and nothing to address. These are one
    // line each for the same reason: there is no first line to keep an address on.
    for (const said of OPENINGS) {
      expect(findMentions(said)).toHaveLength(0);
      expect(said).not.toContain("\n");
    }
  });
});

describe("the sentences that name a row", () => {
  test("the mention is the whole of the first line, and reads back as the record it names", () => {
    // Its own line, above the prose, for the reason `serializeOutgoing` puts a chip's mention there:
    // a message that opens with what it is about and then says what to do with it is the shape the
    // agent reads best — and a mention woven into the middle of a sentence is one whose end the
    // grammar has to guess at.
    for (const [said, table, name] of [
      [newReport("semis"), "recipe", "semis"],
      [binDrop("recipe", "semis"), "recipe", "semis"],
      [binDrop("thesis", "th-margin-expansion-9x2b"), "thesis", "th-margin-expansion-9x2b"],
      [binDrop("target", "2330.TW"), "target", "2330.TW"],
    ] as const) {
      const [first, ...rest] = said.split("\n");
      expect(first).toBe(buildMention(table, name));
      expect(parseMention(first ?? "")).toEqual({ table, name });
      // There is prose under it, and the address appears once: a sentence that was only a mention
      // would be a record dropped on the agent with nothing asked about it.
      expect(rest.join("\n").length).toBeGreaterThan(0);
      expect(findMentions(said)).toHaveLength(1);
    }
  });

  test("a name that cannot go bare is quoted, because these do not spell the grammar", () => {
    // THE FIXTURE THAT MATTERS. A name is the reader's to write and they write English, so a renamed
    // row spells `@recipe:"semis, the second pass"` — and a module that concatenated
    // `@${table}:${name}` itself would pass every other test here and write an unreadable address the
    // first time it met a space. Deferring to `buildMention` is what these assert, and the proof is
    // that the awkward name comes back out of `parseMention` exactly as it went in.
    for (const name of [
      "semis, the second pass",
      "the second pass",
      'the "glut", revisited',
      "back\\slash",
    ]) {
      for (const said of [newReport(name), binDrop("recipe", name)]) {
        const first = said.split("\n")[0] ?? "";
        expect(first.startsWith('@recipe:"')).toBe(true);
        expect(parseMention(first)?.name).toBe(name);
      }
    }
    // And a name that can go bare still does, so the ordinary sentence is the readable one.
    expect(newReport("semis-2026").split("\n")[0]).toBe("@recipe:semis-2026");
  });

  test("the prose says `this`, so the name is written once and only inside the mention", () => {
    // One spelling of the name in the message, and it is the one the grammar owns. A sentence that
    // repeated the name in prose would put an unquoted copy of a name with a comma in it beside a
    // quoted one, and leave the agent to decide which was the address.
    const name = "semis, the second pass";
    expect(body(newReport(name))).not.toContain(name);
    expect(body(newReport(name))).toMatch(/\bthis\b/);
    expect(body(binDrop("recipe", name))).not.toContain(name);
    expect(body(binDrop("recipe", name))).toMatch(/\bthis\b/);
  });

  test("the report sentence is an order, and it is the only one", () => {
    // THE EXCEPTION, AND WHY IT IS ONE RATHER THAN A CRACK IN THE RULE. Every other sentence here
    // opens a subject because what would follow is a row somebody AUTHORS — a specification, an
    // address book entry, a claim about the market, a program — and the reader has to see the words
    // before they are stored. Nobody authors a report. The procedure names the recipe it works to,
    // records every command it runs while it runs, and writes the report's account of itself from
    // that log rather than from anything the agent says afterwards; there is no draft to show, so
    // an interview would be the agent asking permission for work it has just been told to do.
    const said = newReport("semis");
    expect(body(said)).not.toMatch(/^I'd like to /);
    expect(body(said)).not.toMatch(/\b(ask|interview) me\b/i);
    expect(body(said)).toMatch(/^Generate /);
    expect(body(said)).toMatch(/start the procedure now/);
    // And it names the specification it is to be written to, which is the whole of what the reader
    // chose by pressing this particular `+`.
    expect(body(said)).toMatch(/\brecipe\b/);

    // It still destroys nothing and still names no tool. The words that would read as a settled
    // command over the ARCHIVE — the ones every sentence in this module avoids — are as absent here
    // as anywhere else: what this orders is work, not a write.
    expect(said).not.toMatch(/\b(create|delete|remove)\b/i);

    // And it is the only one. Asserted over the openings as a set so that a sixth sentence added
    // later has to come here and say which kind it is.
    for (const opening of OPENINGS) {
      expect(body(opening)).toMatch(/^I'd like to /);
    }
  });

  test("the bin asks what goes with the row before it says the word `delete`", () => {
    // THE EXCEPTION, AND WHY IT IS STILL NOT AN ORDER. Dragging a row onto the Bin is a specific
    // request about a specific record, so unlike the four above this sentence may name the act. What
    // it must not do is presume the answer: a deletion cascades, and the useful thing an agent can say
    // here is "four reports were published under this recipe" — which it can only say if it was
    // asked before it was told. So the request for that account comes first, in the sentence itself.
    const said = body(binDrop("recipe", "semis"));
    const asks = said.toLowerCase().indexOf("tell me");
    const acts = said.toLowerCase().indexOf("delete");
    expect(asks).toBeGreaterThan(-1);
    expect(acts).toBeGreaterThan(-1);
    expect(asks).toBeLessThan(acts);
    // And the act is conditional on the answer rather than on the drag.
    expect(said).toMatch(/\bif\b/);
  });
});
