/**
 * The transcript reducer, driven by frame sequences.
 *
 * Everything here is the reducer alone — no store, no socket, no DOM — which is the point of it
 * being pure. The sequences are the ones that are awkward in a real session and impossible to
 * reproduce by hand: a delta the server shed under backpressure, a tool that ends after the answer
 * has moved on, a reconnect in the middle of a turn, a fifth message refused while four wait.
 *
 * The durable half is the SDK's session store, and its shape is what makes this reducer what it is:
 * a flat `TranscriptItem[]` with no ids and no timestamps, handed back WHOLE, so adoption is a
 * replacement rather than a merge and there is nothing to page or to pair. There is no pairing to
 * assert — which streamed turn wrote which stored row, and whose tool lines therefore belong to
 * whom — so what is asserted instead is the GROUPING, because a flat list of five entries is one
 * answer that used tools and has to read as one.
 */

import { describe, expect, test } from "bun:test";

import type { OutboundFrame, TranscriptItem } from "../web/src/lib/protocol.ts";
import type { AssistantBlock, ChatState } from "../web/src/state/chat.ts";
import {
  adoptTranscript,
  agentWorking,
  appendUserMessage,
  applyFrame,
  connectionLost,
  createChatState,
  isTurnActive,
  messageMarkdown,
  queuedCount,
  takeRefusedText,
  transcript,
} from "../web/src/state/chat.ts";

const READY: OutboundFrame = {
  type: "ready",
  model: "claude-opus-5",
  models: [
    { value: "claude-opus-5", displayName: "Opus 5" },
    { value: "claude-sonnet-5", displayName: "Sonnet 5" },
  ],
  // Where every conversation starts, and what the agent reports until the reader moves it: there is
  // no level to be without. The fixture carries it so that every sequence below starts where a real
  // conversation starts.
  effort: "high",
  // On, because that is what a conversation starts able to do and what the agent reports until
  // somebody turns it off. Carried by the fixture for the same reason the level is: every sequence
  // below then starts where a real conversation starts.
  subagents: true,
  fresh: false,
  venvReady: true,
  sessionId: "s1",
};

/** A finished turn. It names nothing it wrote, because the SDK's store holds the conversation and
 * this window reads it back whole rather than assembling it out of frames — and it reports no meter
 * either: the cost, the SDK's usage object and the turn count all left the frame, so what a turn
 * ending says is that it ended and how. */
const RESULT: OutboundFrame = { type: "turn_result", subtype: "success" };

function play(state: ChatState, frames: OutboundFrame[]): ChatState {
  return frames.reduce(applyFrame, state);
}

function said(text: string): TranscriptItem {
  return { kind: "user", text };
}

function answered(text: string): TranscriptItem {
  return { kind: "assistant", text };
}

function ran(tool: string, summary: string, ok = true): TranscriptItem {
  return { kind: "tool", tool, summary, ok };
}

/** The text of every text block in an item, joined — what the reader actually sees. */
function textOf(state: ChatState, index: number): string {
  const item = transcript(state)[index];
  if (item === undefined) return "";
  if (item.kind === "user") return item.text;
  if (item.kind === "compacted") return "";
  return item.blocks
    .filter((block) => block.kind === "text")
    .map((block) => (block.kind === "text" ? block.text : ""))
    .join("");
}

describe("a turn as it happens", () => {
  test("ready names the session before anything else arrives", () => {
    const state = applyFrame(createChatState(), READY);
    expect(state.ready).toBe(true);
    expect(state.sessionId).toBe("s1");
    expect(state.model).toBe("claude-opus-5");
    expect(state.venvReady).toBe(true);
    expect(transcript(state)).toEqual([]);
  });

  test("a second ready changes the model without disturbing the conversation", () => {
    // Two ways this frame arrives again: the reader picked another model, or the SDK finally said
    // what this installation can reach. Neither is a new conversation, so neither may blank the
    // transcript — which is what the id comparison in the store is for, and what this asserts of
    // the reducer underneath it.
    let state = applyFrame(createChatState(), READY);
    state = applyFrame(state, { type: "text_delta", text: "half a sentence" });
    const said = state.live;

    state = applyFrame(state, { ...READY, model: "claude-sonnet-5" });
    expect(state.model).toBe("claude-sonnet-5");
    expect(state.sessionId).toBe("s1");
    expect(state.live).toBe(said);
  });

  test("the models a picker may offer arrive on ready, and may grow between two of them", () => {
    // The first `ready` a window ever sees carries a fallback list — there is no session yet for the
    // agent to have asked the SDK through — and the real one lands a moment later.
    let state = applyFrame(createChatState(), { ...READY, models: [] });
    expect(state.models).toEqual([]);

    state = applyFrame(state, READY);
    expect(state.models.map((option) => option.value)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
  });

  test("the effort level arrives on ready, and a later ready may move it", () => {
    // `high` to begin with, because that is where a conversation starts and there is no state in
    // which the agent has no level. Nothing in this window writes the field — the reader picks a
    // level, the agent answers with another `ready`, and that frame is the only thing that moves it
    // — so a level on screen is always one the agent confirmed.
    let state = applyFrame(createChatState(), READY);
    expect(state.effort).toBe("high");

    state = applyFrame(state, { type: "text_delta", text: "half a sentence" });
    const streamed = state.live;
    const written = state.persisted;

    state = applyFrame(state, { ...READY, effort: "max" });
    expect(state.effort).toBe("max");
    // The rest of the slice is untouched BY IDENTITY and not merely by value. `ready` is re-sent for
    // reasons that have nothing to do with the transcript — a level chosen, a model chosen, the
    // SDK's real model list landing a moment after the fallback — and a reducer that rebuilt the
    // conversation on each of them would redraw every panel reading it several times a turn.
    expect(state.live).toBe(streamed);
    expect(state.persisted).toBe(written);
    expect(state.model).toBe("claude-opus-5");
    expect(state.sessionId).toBe("s1");

    // And back to `high`, which is what resuming another conversation or clearing this one produces:
    // a repeated frame is copied as faithfully as a changed one, or the picker would go on showing
    // the level of a conversation that is over.
    state = applyFrame(state, READY);
    expect(state.effort).toBe("high");
  });

  test("whether the agent may delegate arrives on ready, and a later ready may move it", () => {
    // True to begin with — that is where a conversation starts, and the seed in `createChatState` is
    // the same answer so a toggle drawn before the first frame is not drawn wrong. Nothing in this
    // window writes the field: the reader presses, the agent ends and reopens its session, and the
    // `ready` that follows is what moves this.
    let state = applyFrame(createChatState(), READY);
    expect(state.subagents).toBe(true);

    state = applyFrame(state, { type: "text_delta", text: "half a sentence" });
    const streamed = state.live;
    const written = state.persisted;

    state = applyFrame(state, { ...READY, subagents: false });
    expect(state.subagents).toBe(false);
    // The conversation is untouched BY IDENTITY, exactly as it is for a level or a model arriving on
    // a repeated frame: this one is re-sent whenever the agent's session changes underneath the
    // window, which is precisely what honouring this change does, and a reducer that rebuilt the
    // transcript on each of them would redraw every panel reading it.
    expect(state.live).toBe(streamed);
    expect(state.persisted).toBe(written);
    expect(state.effort).toBe("high");
    expect(state.sessionId).toBe("s1");

    // And back on, which is what resuming another conversation or clearing this one produces: a
    // repeated frame is copied as faithfully as a changed one, or the toggle would go on showing the
    // state of a conversation that is over.
    state = applyFrame(state, READY);
    expect(state.subagents).toBe(true);
  });

  test("a session id that has not been minted yet is null, and arrives on a later ready", () => {
    // The ordinary case for a window opened before the first turn: the SDK mints the id when the
    // conversation starts, and the server re-sends `ready` so every tab learns the id it needs in
    // order to fetch the transcript it just watched arrive.
    let state = applyFrame(createChatState(), { ...READY, sessionId: null });
    expect(state.ready).toBe(true);
    expect(state.sessionId).toBeNull();

    state = applyFrame(state, READY);
    expect(state.sessionId).toBe("s1");
  });

  test("a message is drawn as sent, then acknowledged by turn_started", () => {
    let state = appendUserMessage(applyFrame(createChatState(), READY), "measure 2330");
    expect(queuedCount(state)).toBe(1);
    expect(transcript(state)[0]).toMatchObject({ kind: "user", pending: true });

    state = applyFrame(state, { type: "turn_started" });
    expect(queuedCount(state)).toBe(0);
    expect(transcript(state)[0]).toMatchObject({ kind: "user", pending: false });
    expect(isTurnActive(state)).toBe(true);
  });

  test("deltas accumulate into one paragraph, and a tool line ends it", () => {
    const state = play(appendUserMessage(applyFrame(createChatState(), READY), "go"), [
      { type: "turn_started" },
      { type: "text_delta", text: "Looking " },
      { type: "text_delta", text: "at the dataset." },
      { type: "tool_start", tool: "list_scripts", toolUseId: "t1", summary: "fundamentals" },
      { type: "tool_end", tool: "list_scripts", toolUseId: "t1", ok: true, summary: "3 scripts" },
      { type: "text_delta", text: "Three scripts." },
    ]);

    const turn = transcript(state)[1];
    expect(turn?.kind).toBe("assistant");
    if (turn?.kind !== "assistant") throw new Error("expected an assistant turn");
    expect(turn.blocks.map((block) => block.kind)).toEqual(["text", "tool", "text"]);
    expect(turn.blocks[0]).toMatchObject({ text: "Looking at the dataset." });
    expect(turn.blocks[1]).toMatchObject({ status: "ok", summary: "3 scripts", toolUseId: "t1" });
    expect(turn.blocks[2]).toMatchObject({ text: "Three scripts." });
  });

  test("tool lines are matched by toolUseId, whatever order they finish in", () => {
    const state = play(applyFrame(createChatState(), READY), [
      { type: "turn_started" },
      { type: "tool_start", tool: "a", toolUseId: "t1", summary: "first" },
      { type: "tool_start", tool: "b", toolUseId: "t2", summary: "second" },
      { type: "tool_end", tool: "b", toolUseId: "t2", ok: false, summary: "refused" },
      { type: "tool_end", tool: "a", toolUseId: "t1", ok: true, summary: "done" },
    ]);

    const turn = transcript(state)[0];
    if (turn?.kind !== "assistant") throw new Error("expected an assistant turn");
    expect(turn.blocks).toMatchObject([
      { toolUseId: "t1", status: "ok", summary: "done" },
      { toolUseId: "t2", status: "failed", summary: "refused" },
    ]);
  });

  test("a report publication is a block in the turn that published it", () => {
    // The url is the report's own address and nothing else: a document lives in the database and is
    // served by id, so there is no directory on disk and no file name left in it for this frame to
    // carry a stale copy of.
    const state = play(applyFrame(createChatState(), READY), [
      { type: "turn_started" },
      { type: "report_published", reportId: "r1", title: "TSMC", url: "/reports/r1" },
    ]);
    const turn = transcript(state)[0];
    if (turn?.kind !== "assistant") throw new Error("expected an assistant turn");
    expect(turn.blocks[0]).toMatchObject({ kind: "report", reportId: "r1", url: "/reports/r1" });
  });

  test("a tab attaching mid-turn draws the frames it did arrive for", () => {
    // No `turn_started` at all: the turn was already running when this socket attached.
    const state = play(applyFrame(createChatState(), READY), [
      { type: "text_delta", text: "…and therefore" },
      { type: "tool_end", tool: "run_script", toolUseId: "t9", ok: true, summary: "ran" },
    ]);
    const turn = transcript(state)[0];
    if (turn?.kind !== "assistant") throw new Error("expected an assistant turn");
    expect(turn.live).toBe(true);
    expect(turn.blocks.map((block) => block.kind)).toEqual(["text", "tool"]);
    expect(turn.blocks[1]).toMatchObject({ status: "ok" });
  });
});

describe("streamed prose is never the durable copy", () => {
  test("turn_result closes the turn and asks for the transcript", () => {
    const state = play(appendUserMessage(applyFrame(createChatState(), READY), "go"), [
      { type: "turn_started" },
      { type: "text_delta", text: "partial" },
      RESULT,
    ]);
    expect(isTurnActive(state)).toBe(false);
    expect(state.resyncNeeded).toBe(true);
  });

  test("dropped deltas are repaired by adoption, and the tool line comes back with it", () => {
    // The server shed the middle delta under backpressure — the only frame it is allowed to drop.
    const streamed = play(appendUserMessage(applyFrame(createChatState(), READY), "go"), [
      { type: "turn_started" },
      { type: "text_delta", text: "The revenue " },
      { type: "tool_start", tool: "run_script", toolUseId: "t1", summary: "revenue.py" },
      { type: "tool_end", tool: "run_script", toolUseId: "t1", ok: true, summary: "wrote 1 file" },
      { type: "text_delta", text: "fell." },
      RESULT,
    ]);
    expect(textOf(streamed, 1)).toBe("The revenue fell.");

    const adopted = adoptTranscript(streamed, [
      said("go"),
      ran("run_script", "wrote 1 file"),
      answered("The revenue rose 12% and then fell."),
    ]);

    expect(adopted.resyncNeeded).toBe(false);
    expect(adopted.live).toEqual([]);
    const items = transcript(adopted);
    expect(items).toHaveLength(2);
    // The sentence the streamed copy was missing is back, because the SDK's store is where it is
    // written down and the socket's copy was only ever a preview of it.
    expect(textOf(adopted, 1)).toBe("The revenue rose 12% and then fell.");
    // The tool line survives without anything having kept it aside: it is IN the durable
    // transcript, so no apparatus is needed to carry it across an adoption.
    const answer = items[1];
    if (answer?.kind !== "assistant") throw new Error("expected an assistant item");
    expect(answer.blocks.map((block) => block.kind)).toEqual(["tool", "text"]);
    expect(answer.blocks[0]).toMatchObject({ tool: "run_script", status: "ok" });
    expect(answer.live).toBe(false);
  });

  test("a run of assistant and tool entries is ONE answer, not four bubbles", () => {
    // The SDK's list is flat, and a turn that ran three tools between two paragraphs arrives as five
    // entries. Drawn one per entry it reads as an argument between strangers rather than as an
    // answer; only a user line or a compaction ends a turn.
    const state = adoptTranscript(createChatState(), [
      said("compare them"),
      answered("Pulling both."),
      ran("run_script", "aapl.py"),
      ran("run_script", "tsm.py", false),
      answered("Apple leads on margin."),
      said("thanks"),
    ]);

    const items = transcript(state);
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "user"]);
    const answer = items[1];
    if (answer?.kind !== "assistant") throw new Error("expected an assistant item");
    expect(answer.blocks.map((block) => block.kind)).toEqual(["text", "tool", "tool", "text"]);
    expect(answer.blocks[2]).toMatchObject({ tool: "run_script", status: "failed" });
    // Every block and every item carries a distinct id, which is what the panel keys its list on.
    const ids = items.flatMap((item) =>
      item.kind === "assistant" ? [item.id, ...item.blocks.map((block) => block.id)] : [item.id],
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("adoption REPLACES what was held, rather than merging with it", () => {
    // The route answers with the entire post-compaction conversation, so anything held here that the
    // new list does not contain is something the store no longer holds. Merging would be this window
    // preserving a history the agent has stopped having.
    let state = adoptTranscript(createChatState(), [said("first"), answered("one")]);
    expect(transcript(state)).toHaveLength(2);

    state = adoptTranscript(state, [{ kind: "compacted" }, said("second"), answered("two")]);
    expect(transcript(state).map((item) => item.kind)).toEqual(["compacted", "user", "assistant"]);
    expect(textOf(state, 2)).toBe("two");
  });

  test("an answer the store has not flushed yet is held over rather than thrown away", () => {
    // The SDK writes its transcript from a subprocess on its own schedule, and `turn_result` reaches
    // this window over a socket that does not wait for it — so the fetch a finished turn triggers can
    // arrive before the agent's own words are on disk. Adoption must not take the reader's only copy
    // of an answer they just watched appear.
    const streamed = play(appendUserMessage(applyFrame(createChatState(), READY), "go"), [
      { type: "turn_started" },
      { type: "tool_start", tool: "list_theses", toolUseId: "t1", summary: "all" },
      { type: "tool_end", tool: "list_theses", toolUseId: "t1", ok: true, summary: "0 theses." },
      { type: "text_delta", text: "Nothing recorded yet." },
      RESULT,
    ]);

    // The store has the question and the tool call, and has not caught up with the answer.
    const early = adoptTranscript(streamed, [said("go"), ran("list_theses", "0 theses.")]);
    expect(textOf(early, 1)).toBe("Nothing recorded yet.");
    // Only the prose is held back: the tool line is in the transcript now, and keeping the live copy
    // as well would draw it twice.
    expect(transcript(early)[1]).toMatchObject({ kind: "assistant" });
    expect(early.live).toHaveLength(1);

    // The next adoption finds the answer written down and lets go of the copy it was holding.
    const settled = adoptTranscript(early, [
      said("go"),
      ran("list_theses", "0 theses."),
      answered("Nothing recorded yet."),
    ]);
    expect(settled.live).toEqual([]);
    expect(transcript(settled)).toHaveLength(2);
    expect(textOf(settled, 1)).toBe("Nothing recorded yet.");
  });

  test("a turn that OPENED with a sentence keeps the one it CLOSED with", () => {
    // The shape nearly every answer has: a line about what is about to happen, the tool calls, then
    // the answer. The opener is on disk long before the answer is, so adoption asking only whether
    // the store had said ANYTHING since the question read that opener as the whole reply and threw
    // the closing paragraph away — the turn appeared to end at its last tool line, and the words came
    // back only when the conversation was loaded again.
    const streamed = play(appendUserMessage(applyFrame(createChatState(), READY), "check orats"), [
      { type: "turn_started" },
      { type: "text_delta", text: "Checking the endpoints." },
      { type: "tool_start", tool: "run_shell", toolUseId: "t1", summary: "curl" },
      { type: "tool_end", tool: "run_shell", toolUseId: "t1", ok: true, summary: "HTTP 200" },
      { type: "text_delta", text: "11 endpoints, all live." },
      RESULT,
    ]);

    // The store has the opener and the tool call, and has not caught up with the answer: it ends on a
    // tool line, which is not how a turn ends.
    const early = adoptTranscript(streamed, [
      said("check orats"),
      answered("Checking the endpoints."),
      ran("run_shell", "HTTP 200"),
    ]);

    expect(textOf(early, 1)).toBe("Checking the endpoints.11 endpoints, all live.");
    // Only the closing paragraph is held over. The opener is the store's now, and keeping this copy
    // of it as well would draw the same sentence twice inside one answer.
    expect(early.live).toHaveLength(1);
    const answer = transcript(early)[1];
    if (answer?.kind !== "assistant") throw new Error("expected an assistant item");
    expect(answer.blocks.map((block) => block.kind)).toEqual(["text", "tool", "text"]);
    expect(transcript(early)).toHaveLength(2);

    // And the moment the store's copy ends in speech, the held one is let go.
    const settled = adoptTranscript(early, [
      said("check orats"),
      answered("Checking the endpoints."),
      ran("run_shell", "HTTP 200"),
      answered("11 endpoints, all live."),
    ]);
    expect(settled.live).toEqual([]);
    expect(textOf(settled, 1)).toBe("Checking the endpoints.11 endpoints, all live.");
  });

  test("what is held back is the tail the store lacks, however many paragraphs in", () => {
    const streamed = play(appendUserMessage(applyFrame(createChatState(), READY), "compare them"), [
      { type: "turn_started" },
      { type: "text_delta", text: "Pulling both." },
      { type: "tool_start", tool: "run_script", toolUseId: "t1", summary: "aapl.py" },
      { type: "tool_end", tool: "run_script", toolUseId: "t1", ok: true, summary: "1 file" },
      { type: "text_delta", text: "Now the other." },
      { type: "tool_start", tool: "run_script", toolUseId: "t2", summary: "tsm.py" },
      { type: "tool_end", tool: "run_script", toolUseId: "t2", ok: true, summary: "1 file" },
      { type: "text_delta", text: "Apple leads on margin." },
      RESULT,
    ]);

    const early = adoptTranscript(streamed, [
      said("compare them"),
      answered("Pulling both."),
      ran("run_script", "1 file"),
      answered("Now the other."),
      ran("run_script", "1 file"),
    ]);

    // Two paragraphs recorded, three said: the third is the only one this window is still the copy of.
    expect(early.live).toHaveLength(1);
    const held = early.live[0];
    if (held?.kind !== "assistant") throw new Error("expected an assistant item");
    expect(held.blocks.map((block) => (block.kind === "text" ? block.text : ""))).toEqual([
      "Apple leads on margin.",
    ]);
    expect(textOf(early, 1)).toBe("Pulling both.Now the other.Apple leads on margin.");
  });

  test("the two copies group speech differently, so speech is not what they are lined up on", () => {
    // Adjacent deltas merge into one block on this side; the store keeps one entry per message it
    // wrote. So a paragraph on screen can be two entries on disk, and counting the one against the
    // other would read the store as further ahead than it is — and drop the answer for having
    // supposedly been written down. The tool lines are what both sides count the same way.
    const streamed = play(appendUserMessage(applyFrame(createChatState(), READY), "go"), [
      { type: "turn_started" },
      { type: "text_delta", text: "Pulling " },
      { type: "text_delta", text: "both." },
      { type: "tool_start", tool: "run_script", toolUseId: "t1", summary: "aapl.py" },
      { type: "tool_end", tool: "run_script", toolUseId: "t1", ok: true, summary: "1 file" },
      { type: "text_delta", text: "Apple leads." },
      RESULT,
    ]);

    const early = adoptTranscript(streamed, [
      said("go"),
      answered("Pulling"),
      answered("both."),
      ran("run_script", "1 file"),
    ]);

    expect(early.live).toHaveLength(1);
    expect(textOf(early, 1)).toBe("Pullingboth.Apple leads.");
  });

  test("a window that joined the answer late keeps the end of it", () => {
    // A reload mid-answer, a second tab, a socket that dropped and came back: the turn is already
    // running, so what this window holds is its TAIL and the store holds the beginning. Counting the
    // store's paragraphs off the front of this list would take the only copy of the one paragraph
    // that is not on disk — the two lists do not start in the same place, and only the tool lines
    // say where either of them does.
    let state = applyFrame(createChatState(), READY);
    state = adoptTranscript(state, [
      said("check the endpoints"),
      answered("Checking now."),
      ran("run_shell", "HTTP 200"),
    ]);
    // No `turn_started`: that frame went to whoever was listening at the time.
    state = play(state, [{ type: "text_delta", text: "11 endpoints, all live." }, RESULT]);

    const adopted = adoptTranscript(state, [
      said("check the endpoints"),
      answered("Checking now."),
      ran("run_shell", "HTTP 200"),
    ]);

    expect(adopted.live).toHaveLength(1);
    expect(textOf(adopted, 1)).toBe("Checking now.11 endpoints, all live.");
    expect(transcript(adopted)).toHaveLength(2);
  });

  test("prose held over one turn is let go by the next, not redrawn inside it", () => {
    // Held prose OUTLIVES THE QUESTION THAT ANCHORS IT: the store had written that line down, so
    // adoption retired it into the transcript and left the paragraph with nothing before it. Located
    // by what comes after instead, it stays its own turn's — measured against the next turn's stretch
    // it would be found missing there and drawn a second time, inside somebody else's answer.
    const first = play(appendUserMessage(applyFrame(createChatState(), READY), "any theses?"), [
      { type: "turn_started" },
      { type: "tool_start", tool: "list_theses", toolUseId: "t1", summary: "all" },
      { type: "tool_end", tool: "list_theses", toolUseId: "t1", ok: true, summary: "0 theses." },
      { type: "text_delta", text: "Nothing recorded yet." },
      RESULT,
    ]);
    const held = adoptTranscript(first, [said("any theses?"), ran("list_theses", "0 theses.")]);
    expect(held.live).toHaveLength(1);

    const second = play(appendUserMessage(held, "add one"), [
      { type: "turn_started" },
      { type: "tool_start", tool: "run_script", toolUseId: "t2", summary: "add.py" },
      { type: "tool_end", tool: "run_script", toolUseId: "t2", ok: true, summary: "1 file" },
      { type: "text_delta", text: "Recorded." },
      RESULT,
    ]);
    // The store caught up with the first answer while the second turn ran, and now lags on that one.
    const adopted = adoptTranscript(second, [
      said("any theses?"),
      ran("list_theses", "0 theses."),
      answered("Nothing recorded yet."),
      said("add one"),
      ran("run_script", "1 file"),
    ]);

    expect(adopted.live).toHaveLength(1);
    const items = transcript(adopted);
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(textOf(adopted, 1)).toBe("Nothing recorded yet.");
    expect(textOf(adopted, 3)).toBe("Recorded.");
  });

  test("a queued message the server has already written down is drawn once, not twice", () => {
    // The real server records the user line when the turn is QUEUED, not when it starts, so a
    // message still waiting behind this turn is already in the transcript that comes back. Reading
    // `pending` as "the server has not seen it" would draw it twice — once from the transcript, once
    // from `live` as a "sending…" bubble — for as long as it waited.
    let state = play(appendUserMessage(applyFrame(createChatState(), READY), "first"), [
      { type: "turn_started" },
      { type: "text_delta", text: "…" },
      RESULT,
    ]);
    state = appendUserMessage(state, "second");
    state = adoptTranscript(state, [said("first"), answered("…"), said("second")]);

    const items = transcript(state);
    expect(items.map((item) => (item.kind === "user" ? item.text : "assistant"))).toEqual([
      "first",
      "assistant",
      "second",
    ]);
    expect(items[2]).toMatchObject({ kind: "user", pending: false });
    expect(state.live).toEqual([]);
    expect(queuedCount(state)).toBe(0);
  });

  test("a message the transcript does NOT hold stays queued — that frame never reached the server", () => {
    let state = play(appendUserMessage(applyFrame(createChatState(), READY), "first"), [
      { type: "turn_started" },
      { type: "text_delta", text: "…" },
      RESULT,
    ]);
    state = appendUserMessage(state, "second");
    state = adoptTranscript(state, [said("first"), answered("…")]);

    const items = transcript(state);
    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({ kind: "user", text: "second", pending: true });
    expect(queuedCount(state)).toBe(1);
  });

  test("a tool still running when the turn closes stops spinning", () => {
    // The server clears its pairing map at the bottom of a turn rather than inventing the ends it
    // never got, so a tool in flight when the user hits Stop has no `tool_end` coming. Left running
    // it spins forever in a turn that has plainly finished.
    const state = play(appendUserMessage(applyFrame(createChatState(), READY), "go"), [
      { type: "turn_started" },
      { type: "tool_start", tool: "run_script", toolUseId: "t1", summary: "slow.py" },
      { type: "text_delta", text: "Working" },
      { type: "turn_result", subtype: "interrupted" },
    ]);
    const live = transcript(state)[1];
    if (live?.kind !== "assistant") throw new Error("expected an assistant turn");
    expect(live.blocks[0]).toMatchObject({ kind: "tool", status: "stopped" });
  });

  test("a connection that drops settles the tool lines too", () => {
    const dropped = connectionLost(
      play(appendUserMessage(applyFrame(createChatState(), READY), "go"), [
        { type: "turn_started" },
        { type: "tool_start", tool: "run_script", toolUseId: "t1", summary: "slow.py" },
      ]),
    );
    const turn = transcript(dropped)[1];
    if (turn?.kind !== "assistant") throw new Error("expected an assistant turn");
    expect(turn.blocks[0]).toMatchObject({ status: "stopped" });
  });
});

describe("a compaction", () => {
  test("leaves a marker in the live trail without stopping the turn it interrupted", () => {
    // Compaction fires on the SDK's own initiative and can land mid-answer. Closing the turn to put
    // the marker after it would tell the composer the agent had stopped talking, and offer to send
    // while the model was still writing.
    const state = play(appendUserMessage(applyFrame(createChatState(), READY), "go"), [
      { type: "turn_started" },
      { type: "text_delta", text: "Working" },
      { type: "compacted", trigger: "auto" },
      { type: "text_delta", text: " on it." },
    ]);

    const items = transcript(state);
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "compacted"]);
    expect(isTurnActive(state)).toBe(true);
    // The deltas after the fold still land in the turn that was open, which is where they were said.
    expect(textOf(state, 1)).toBe("Working on it.");
    // And no refetch is asked for here: the turn's own result will ask a moment later, and
    // refetching mid-answer would replace the transcript underneath it.
    expect(state.resyncNeeded).toBe(false);
  });

  test("is retired by adoption, because the transcript carries the fold itself", () => {
    // The marker is a live echo of something the SDK writes into its own store. Keeping it after the
    // store has been read back would draw the fold twice.
    let state = play(appendUserMessage(applyFrame(createChatState(), READY), "go"), [
      { type: "turn_started" },
      { type: "compacted", trigger: "manual" },
      { type: "text_delta", text: "Done." },
      RESULT,
    ]);
    state = adoptTranscript(state, [{ kind: "compacted" }, said("go"), answered("Done.")]);

    expect(state.live).toEqual([]);
    expect(transcript(state).map((item) => item.kind)).toEqual(["compacted", "user", "assistant"]);
  });
});

describe("a turn taken as markdown", () => {
  /** The blocks of the turn at `index`, whatever produced them. */
  function blocksOf(state: ChatState, index: number): AssistantBlock[] {
    const item = transcript(state)[index];
    if (item?.kind !== "assistant") throw new Error("expected an assistant turn");
    return item.blocks;
  }

  test("what the agent said, joined by a blank line — and nothing it did", () => {
    // The turn as it happened: a sentence, a script, a report, another sentence. What the copy
    // button hands over is the prose alone — the tool line and the publication are the record of
    // what the agent DID, and neither was ever offered as something to paste.
    const state = play(appendUserMessage(applyFrame(createChatState(), READY), "go"), [
      { type: "turn_started" },
      { type: "text_delta", text: "Looking " },
      { type: "text_delta", text: "at the dataset." },
      { type: "tool_start", tool: "run_script", toolUseId: "t1", summary: "revenue.py" },
      { type: "tool_end", tool: "run_script", toolUseId: "t1", ok: true, summary: "wrote 1 file" },
      { type: "report_published", reportId: "r1", title: "TSMC", url: "/reports/r1" },
      { type: "text_delta", text: "Revenue fell." },
    ]);

    expect(blocksOf(state, 1).map((block) => block.kind)).toEqual([
      "text",
      "tool",
      "report",
      "text",
    ]);
    // One blank line and not two: the deltas that made each paragraph accumulate into a single
    // block, so the break is exactly where the doings interrupted the prose on screen.
    expect(messageMarkdown(blocksOf(state, 1))).toBe("Looking at the dataset.\n\nRevenue fell.");
  });

  test("a turn that only did things has nothing to copy", () => {
    const state = play(applyFrame(createChatState(), READY), [
      { type: "turn_started" },
      { type: "tool_start", tool: "list_theses", toolUseId: "t1", summary: "all" },
      { type: "tool_end", tool: "list_theses", toolUseId: "t1", ok: true, summary: "0 theses." },
      { type: "report_published", reportId: "r1", title: "TSMC", url: "/reports/r1" },
    ]);
    expect(messageMarkdown(blocksOf(state, 0))).toBe("");
  });

  test("the same turn read back from the store copies the same way", () => {
    // The durable copy is the one a reader presses on after a reload, and it arrives as a flat run
    // of entries rather than as frames. Grouping is what makes it one turn; this is what makes it
    // one answer on the clipboard.
    const state = adoptTranscript(createChatState(), [
      said("compare them"),
      answered("Pulling both."),
      ran("run_script", "aapl.py"),
      answered("Apple leads on margin."),
    ]);
    expect(messageMarkdown(blocksOf(state, 1))).toBe("Pulling both.\n\nApple leads on margin.");
  });
});

describe("a connection that drops mid-turn", () => {
  test("closes the live turn and asks for the transcript", () => {
    const streamed = play(appendUserMessage(applyFrame(createChatState(), READY), "go"), [
      { type: "turn_started" },
      { type: "text_delta", text: "half a sen" },
    ]);
    const dropped = connectionLost(streamed);

    expect(dropped.ready).toBe(false);
    expect(isTurnActive(dropped)).toBe(false);
    expect(dropped.resyncNeeded).toBe(true);

    // The server finished the turn with nobody listening, so the whole answer is in the SDK's store.
    const resumed = adoptTranscript(dropped, [
      said("go"),
      answered("half a sentence, then the rest"),
    ]);
    expect(textOf(resumed, 1)).toBe("half a sentence, then the rest");
    expect(applyFrame(resumed, READY).ready).toBe(true);
  });

  test("a drop with no turn running asks for nothing", () => {
    const idle = applyFrame(createChatState(), READY);
    expect(connectionLost(idle).resyncNeeded).toBe(false);
  });
});

describe("refusals", () => {
  test("busy takes the message back off the transcript and hands the text to the composer", () => {
    // One message racing a turn the window had not seen start — the only way a busy refusal is
    // reached now that the composer gates itself on `agentWorking`.
    const sent = appendUserMessage(applyFrame(createChatState(), READY), "too soon");
    const state = applyFrame(sent, {
      type: "error",
      code: "busy",
      message: "the agent is still working on the last message",
    });

    expect(state.lastError?.code).toBe("busy");
    expect(queuedCount(state)).toBe(0);
    expect(transcript(state).filter((item) => item.kind === "user")).toEqual([]);

    const taken = takeRefusedText(state);
    expect(taken.text).toBe("too soon");
    // Handed back exactly once: a composer that restored it on every render would fight the typist.
    expect(takeRefusedText(taken.state).text).toBeNull();
  });

  test("a refused spoken sentence leaves the transcript and hands nothing to the composer", () => {
    // A `+` opener or a bin drop is a sentence a CONTROL wrote, sent on the reader's behalf —
    // `origin: "spoken"`. Refused, it leaves the transcript like any unsaid message, but the
    // composer gets nothing: doctrine text restored into the box would put words in the reader's
    // mouth, over whatever draft they were actually writing.
    const sent = appendUserMessage(
      applyFrame(createChatState(), READY),
      "I want to record a new recipe.",
      "spoken",
    );
    const state = applyFrame(sent, {
      type: "error",
      code: "busy",
      message: "the agent is still working on the last message",
    });

    expect(transcript(state).filter((item) => item.kind === "user")).toEqual([]);
    expect(takeRefusedText(state).text).toBeNull();
  });

  test("any other error surfaces without touching the conversation", () => {
    const asked = appendUserMessage(applyFrame(createChatState(), READY), "go");
    const state = applyFrame(asked, { type: "error", code: "interrupt_failed", message: "no turn" });
    expect(state.lastError).toEqual({ code: "interrupt_failed", message: "no turn" });
    expect(state.refusedText).toBeNull();
    expect(transcript(state)).toHaveLength(1);
  });
});

describe("agentWorking", () => {
  // The one predicate the composer's send, the `+` openers and the bin drop all read: the window's
  // half of one-turn-at-a-time. Each term is a state the others cannot see.
  test("sees a turn in flight, a message on its way, an open procedure, and an idle agent", () => {
    const idle = applyFrame(createChatState(), READY);
    expect(agentWorking(idle, null)).toBe(false);

    // A message sent, `turn_started` not yet arrived: `isTurnActive` is false and the message is
    // pending — the gap `queuedCount` exists to cover.
    const pending = appendUserMessage(idle, "go");
    expect(isTurnActive(pending)).toBe(false);
    expect(agentWorking(pending, null)).toBe(true);

    // The turn being written.
    const streaming = applyFrame(
      applyFrame(pending, { type: "turn_started" }),
      { type: "text_delta", text: "well —" },
    );
    expect(agentWorking(streaming, null)).toBe(true);

    // A generation procedure, handed in from its own slice: the chat state alone cannot see one.
    expect(agentWorking(idle, { id: "gen-1" })).toBe(true);
  });
});

/*
 * `conversationUntouched` used to live here, with four tests under "whether there is a conversation
 * here to put down". It answered for the `+` on a creation box, which put the conversation on screen
 * DOWN and said its opening line into a fresh session — and it had to tell a brand-new conversation
 * whose first turn was already in flight from one nobody had spoken in, because the SDK mints a
 * session id part-way through turn one and "no id" alone would have sent the opening straight into a
 * turn being answered.
 *
 * A creation is raised in the conversation on screen now. Every `+` sends an ordinary message where
 * the reader already is, there is no session to swap and nothing left to ask this question on behalf
 * of, so the function and its block went together rather than being left asserting a rule the window
 * no longer has.
 */

test("a frame that changes nothing returns the same state", () => {
  // A generation frame is procedure state — the store draws a banner off it — and says nothing
  // about the transcript, whose own turn arrives through the ordinary frames like any other.
  // Returning the same object is what stops the whole message list re-rendering every time a
  // procedure opens or closes.
  const state = applyFrame(createChatState(), READY);
  expect(applyFrame(state, { type: "pong" })).toBe(state);
  expect(
    applyFrame(state, { type: "generation_started", generationId: "g1", recipeId: "rc1" }),
  ).toBe(state);
});
