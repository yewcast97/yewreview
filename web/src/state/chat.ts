/**
 * The transcript model: frames in, an ordered list of items out.
 *
 * PURE and DOM-FREE, so `bun test` drives it directly under the root tsconfig — no store, no React,
 * no socket. Every function here takes a state and returns one; the same sequence of frames always
 * produces the same state, which is what makes the awkward orderings testable rather than
 * anecdotal. Ids are minted from a counter held IN the state for the same reason.
 *
 * THE DURABLE COPY IS THE SDK'S, NOT OURS, and that is what this module is shaped around.
 * There is no message table: the conversation lives in the agent SDK's own session store,
 * and `GET /api/sessions/:id/messages` hands back the WHOLE post-compaction conversation as a flat
 * `TranscriptItem[]`. So the state below holds two things — what the server has written down, and
 * what has happened on this socket since — and the join between them is a REPLACEMENT rather than an
 * id: `adoptTranscript` throws away the persisted list it was holding and takes the new one
 * entire. There is no pairing machinery, no keyset, no
 * `hasMore`, no back-paging, and no `messageId` on `turn_result`, because there is no page to be a
 * page OF and no row for a turn to name.
 *
 * THE ONE RULE EVERYTHING ELSE OBEYS: **streamed prose is never the durable copy.** `text_delta` is
 * the only frame the server will drop under backpressure (see `makeRoom` in `src/server/chat.ts`),
 * so what a tab has on screen mid-turn may be missing a sentence and there is no way for the tab to
 * know. `turn_result` therefore sets `resyncNeeded`, the store refetches the transcript, and adoption
 * replaces the streamed text with what the SDK actually recorded. A reconnect mid-turn is the same
 * situation arriving by a different door — `connectionLost` sets the same flag — because the agent
 * belongs to the server and finishes the turn into its store whether or not anybody was listening.
 *
 * TOOL LINES ARE DURABLE, so nothing here preserves them.
 * A `TranscriptItem` may be a tool line, so the server's copy of a turn already contains "here is
 * what it did" as well as "here is what it concluded". A `trail` — tool lines kept aside under
 * the id of the assistant row that replaced their streamed text — would draw every one of them
 * twice. What does have to be done is SETTLING: a tool that was in flight when a turn was cut short
 * has no `tool_end` coming, because the server clears its pairing map at the bottom of a turn rather
 * than inventing ends it never got, and a line left spinning is this window claiming work is still
 * happening.
 *
 * An assistant turn is a list of ORDERED BLOCKS rather than a message with a text field and some
 * decorations. That is what makes text-after-a-tool-line, a report published before a word has been
 * said, and two paragraphs separated by three tool calls all ordinary: each is a block appended in
 * the order it happened, with no special case anywhere. The persisted side is read the same way — a
 * run of assistant and tool items between two user lines is ONE turn, because that is what it was.
 *
 * A COMPACTION IS AN ITEM, not a block and not a silence. The SDK folds a long conversation down to a
 * summary on its own initiative; the transcript that comes back afterwards is missing its first half,
 * and a window that drew nothing there would be inviting the reader to conclude the model had simply
 * forgotten. It is not a block inside an assistant turn because the agent did not do it, and it is
 * not attached to either speaker because it happened TO the conversation rather than in it.
 */

import type { EffortLevel, ModelOption, OutboundFrame, TranscriptItem } from "../lib/protocol.ts";

// -- blocks and items ---------------------------------------------------------------------------

/**
 * `stopped` is a line that will never end: the server clears its pairing map at the bottom of a
 * turn rather than inventing the `tool_end` frames it never got (`openTools.clear()`), so a tool
 * that was in flight when the user hit Stop — or when a failed session resume restarted the
 * session — has no end coming. Drawn as a mark rather than a spinner, because a spinner in a
 * finished transcript is this window claiming work is still happening.
 */
export type ToolStatus = "running" | "ok" | "failed" | "stopped";

export type TextBlock = { kind: "text"; id: string; text: string };

export type ToolBlock = {
  kind: "tool";
  id: string;
  /** What `tool_end` matches on. The only handle the protocol gives, and the one thing the durable
   * copy does not carry — a tool line read back from the session store is already finished, so it
   * has nothing left to be matched with. */
  toolUseId: string;
  tool: string;
  summary: string;
  status: ToolStatus;
};

export type ReportBlock = {
  kind: "report";
  id: string;
  reportId: string;
  title: string;
  /** Same-origin, under the reports prefix — what the report panel opens. */
  url: string;
};

export type AssistantBlock = TextBlock | ToolBlock | ReportBlock;

/**
 * What the chat panel draws, whether it came from the socket or the transcript.
 *
 * NO TIMESTAMP ON ANY OF THEM, and that is the SDK's contract rather than a simplification here: a
 * `TranscriptItem` records the order things were said and not the moments they were said at, so a
 * relative stamp beside a line would be this window inventing one. The order is what is known.
 */
export type ChatItem =
  | {
      kind: "user";
      id: string;
      text: string;
      /** Sent, and not yet acknowledged by a `turn_started`. */
      pending: boolean;
    }
  | {
      kind: "assistant";
      id: string;
      blocks: AssistantBlock[];
      /** True while this turn is still being written. */
      live: boolean;
    }
  /** The history was folded here. See the header for why it is an item of its own. */
  | { kind: "compacted"; id: string };

/** An item that came from the socket rather than the transcript. */
type LiveItem =
  /** `origin` is who wrote the words: `typed` is the reader's own draft, `spoken` is a sentence a
   * control sent on their behalf — a `+` opener, a bin drop. The refusal path reads it: a refused
   * draft goes back to the composer, and a refused spoken sentence just leaves, because handing a
   * control's doctrine text to the composer would put words in the reader's mouth. */
  | { kind: "user"; id: string; text: string; pending: boolean; origin: "typed" | "spoken" }
  | {
      kind: "assistant";
      id: string;
      blocks: AssistantBlock[];
      done: boolean;
    }
  | { kind: "compacted"; id: string };

export type ChatError = { code: string; message: string };

export type ChatState = {
  /**
   * The SDK session this conversation is, named by `ready` — null until the first turn mints one.
   *
   * It is what the transcript is fetched by and what the session list marks as live, and it is
   * remembered here rather than derived because the store needs an answer between a resume landing
   * and the frame that confirms it.
   */
  sessionId: string | null;
  /** Which model is answering this conversation. Null until the first `ready` frame. */
  model: string | null;
  /** What the picker may offer: what this installation's CLI can actually reach, as the agent
   * reports it. Empty until the first `ready`, and it may grow between two of them — the real list
   * comes from the SDK and arrives a moment after the fallback one. */
  models: readonly ModelOption[];
  /**
   * How hard the model is being asked to work in this conversation. Null until the first `ready`
   * frame, exactly as `model` is and for exactly that reason: the agent always has a level, and this
   * window does not know which one until it is told.
   *
   * It is never written from this side: the picker asks, the agent answers with another `ready`, and
   * that frame is the only thing that moves this field — so a level on screen is always one the agent
   * confirmed.
   */
  effort: EffortLevel | null;
  /**
   * Whether this conversation may delegate to subagents and workflows.
   *
   * Seeded `true` rather than null, alone among the answering facts here, because there is no third
   * state for it to be in and the seed is the default the agent will confirm on its first `ready`:
   * a boolean drawn as a toggle has to say something before the frame lands, and "on" is what the
   * agent is about to say. Never written from this side after that — the toggle asks, the agent
   * answers with another `ready`, and that frame is the only thing that moves this field, which
   * matters more here than for the two above because honouring the change ends the agent's session.
   */
  subagents: boolean;
  /** The agent session was minted this boot, so it began with no memory of anything said before. */
  fresh: boolean;
  venvReady: boolean;
  ready: boolean;
  /** The durable conversation, oldest first, exactly as the SDK's store holds it. Replaced whole on
   * every adoption — see the header. */
  persisted: TranscriptItem[];
  /** What has happened on this socket since the last adoption, in the order it happened. */
  live: LiveItem[];
  /** The durable transcript is behind what has been said; refetch it. */
  resyncNeeded: boolean;
  lastError: ChatError | null;
  /**
   * Text the server refused, so the composer can offer it back. It never became a turn, and losing
   * what somebody typed because the agent was mid-answer would be losing their words. Only ever a
   * TYPED message's text — a refused spoken sentence leaves the transcript and hands nothing over.
   */
  refusedText: string | null;
  /** Minted ids, so the reducer is a function of its inputs and nothing else. */
  seq: number;
};

export function createChatState(): ChatState {
  return {
    sessionId: null,
    model: null,
    models: [],
    effort: null,
    subagents: true,
    fresh: false,
    venvReady: false,
    ready: false,
    persisted: [],
    live: [],
    resyncNeeded: false,
    lastError: null,
    refusedText: null,
    seq: 0,
  };
}

// -- reading it ---------------------------------------------------------------------------------

/**
 * The whole conversation, in order: what the server wrote down, then what has happened since.
 *
 * Recomputed rather than maintained, and cheap enough to be: compaction bounds the persisted list and
 * this runs once per render, not once per delta.
 *
 * The persisted half is GROUPED on the way through. The SDK's list is flat — an assistant paragraph,
 * three tool lines and another paragraph are five entries — and drawing five bubbles for one answer
 * would make a turn that used tools look like an argument between strangers. A run of assistant and
 * tool items is one turn, ended by a user line or by a compaction, which is exactly how it happened.
 */
export function transcript(state: ChatState): ChatItem[] {
  const items: ChatItem[] = [];
  // Where the turn currently being filled sits in `items`, or -1 between turns. Only a user line or a
  // compaction closes one; everything else the agent did belongs to the answer it was doing it for.
  let open = -1;
  for (const entry of state.persisted) {
    if (entry.kind === "user") {
      open = -1;
      items.push({ kind: "user", id: `p${items.length}`, text: entry.text, pending: false });
      continue;
    }
    if (entry.kind === "compacted") {
      open = -1;
      items.push({ kind: "compacted", id: `p${items.length}` });
      continue;
    }
    if (open === -1) {
      open = items.length;
      items.push({ kind: "assistant", id: `p${open}`, blocks: [], live: false });
    }
    const turn = items[open] as Extract<ChatItem, { kind: "assistant" }>;
    const id = `p${open}b${turn.blocks.length}`;
    turn.blocks.push(
      entry.kind === "assistant"
        ? { kind: "text", id, text: entry.text }
        : {
            kind: "tool",
            id,
            // A tool line read back from the store is already finished, so there is no pairing left
            // to do and nothing to pair with. The empty handle says exactly that rather than
            // inventing one: `closeTool` only ever walks blocks built from a `tool_start`.
            toolUseId: "",
            tool: entry.tool,
            summary: entry.summary,
            status: entry.ok ? "ok" : "failed",
          },
    );
  }
  for (const item of state.live) {
    if (item.kind === "user") {
      open = -1;
      items.push({ kind: "user", id: item.id, text: item.text, pending: item.pending });
      continue;
    }
    if (item.kind === "compacted") {
      open = -1;
      items.push({ kind: "compacted", id: item.id });
      continue;
    }
    // A live answer JOINS the turn the persisted list left open, when it left one open. That happens
    // in exactly one situation and it is the one worth drawing correctly: `adoptTranscript` held this
    // answer's prose back because the store had written the turn's tool calls and not yet its words,
    // so the two halves are one turn and a second bubble would say the agent spoke twice. An ordinary
    // turn in flight cannot hit this — the question that started it closed the group.
    if (open !== -1) {
      (items[open] as Extract<ChatItem, { kind: "assistant" }>).blocks.push(...item.blocks);
      continue;
    }
    items.push({
      kind: "assistant",
      id: item.id,
      blocks: item.blocks,
      live: !item.done,
    });
  }
  return items;
}

/** Whether a turn is being written right now. What the composer's send/stop button reads. */
export function isTurnActive(state: ChatState): boolean {
  return state.live.some((item) => item.kind === "assistant" && !item.done);
}

/** How many messages have been sent and not yet started — the window between a send and its
 * `turn_started`, when `isTurnActive` is still false and a turn nonetheless exists. A term of
 * `agentWorking` below, which is what closes that gap. */
export function queuedCount(state: ChatState): number {
  return state.live.filter((item) => item.kind === "user" && item.pending).length;
}

/**
 * Whether the agent is doing something a new message would land in the middle of.
 *
 * ONE TURN AT A TIME: the server refuses a message sent while a turn is in flight, and this
 * predicate is how the window keeps that refusal from ever being needed — the composer's send, the
 * `+` openers and the bin drop all read it before speaking. Three terms, each a state the others
 * miss: a generation procedure (its own slice, handed in by the store), a turn being written, and
 * a message sent but not yet started. The server's answer is still the authority; this is the
 * window not asking a question it already knows the answer to.
 */
export function agentWorking(state: ChatState, generation: { id: string } | null): boolean {
  return generation !== null || isTurnActive(state) || queuedCount(state) > 0;
}

/**
 * One turn as the markdown it was written in — what the copy button on a settled answer hands over.
 *
 * TEXT BLOCKS ONLY. A tool line and a published report are the record of what the agent DID, and
 * this is what it SAID: pasted into somebody's document, "run_script · revenue.py" is a line nobody
 * wrote as prose and the agent never offered as one. The report is a record with an address of its
 * own, and the tool lines are the transcript's business rather than the clipboard's.
 *
 * JOINED BY A BLANK LINE, which is the join the turn already had on screen. Consecutive deltas
 * accumulate into ONE text block (`appendText`), so a second block exists exactly when one of those
 * doings interrupted the prose — and whatever ended a paragraph on screen is a paragraph break in
 * what is copied. In markdown that break is one empty line; a single newline would fold the two into
 * one paragraph when the text is rendered again somewhere else.
 *
 * A BLOCK'S TEXT GOES WHOLE, attachment lines included. The chip the panel draws in their place is a
 * rendering of a line the agent WROTE (`lib/attachments.ts`), and what this hands over is the source
 * rather than the drawing of it — a turn copied into a document should say which file it left
 * behind.
 */
export function messageMarkdown(blocks: readonly AssistantBlock[]): string {
  const said: string[] = [];
  for (const block of blocks) if (block.kind === "text") said.push(block.text);
  return said.join("\n\n");
}

// -- local events -------------------------------------------------------------------------------

/**
 * Show a message the moment it is sent, so the conversation reads as it is typed.
 *
 * Called after the frame reached the wire, not before: a message that never left is not part of the
 * conversation, and drawing it would make the composer's own failure look like the agent ignoring
 * somebody.
 */
export function appendUserMessage(
  state: ChatState,
  text: string,
  origin: "typed" | "spoken" = "typed",
): ChatState {
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    live: [...state.live, { kind: "user", id: `u${seq}`, text, pending: true, origin }],
    refusedText: null,
  };
}

/**
 * The socket dropped. A turn that was in flight is not lost — the server finishes it into the SDK's
 * store with nobody listening — but its remaining text will never arrive here, so the live copy is
 * closed and the durable one is asked for.
 */
export function connectionLost(state: ChatState): ChatState {
  if (!isTurnActive(state)) return { ...state, ready: false };
  return {
    ...state,
    ready: false,
    resyncNeeded: true,
    live: state.live.map((item) =>
      item.kind === "assistant" && !item.done ? { ...item, done: true, blocks: settle(item.blocks) } : item,
    ),
  };
}

/**
 * Close every tool line that is still running.
 *
 * A `tool_end` only arrives while somebody is listening, and the turn this closes is one nobody will
 * hear the end of. Left alone the line spins for the rest of the session, in a turn that has plainly
 * finished.
 */
function settle(blocks: readonly AssistantBlock[]): AssistantBlock[] {
  if (!blocks.some((block) => block.kind === "tool" && block.status === "running")) {
    return [...blocks];
  }
  return blocks.map((block) =>
    block.kind === "tool" && block.status === "running" ? { ...block, status: "stopped" } : block,
  );
}

/**
 * The durable transcript, replacing everything the socket streamed.
 *
 * A FULL REPLACE, because that is what the route answers with: the SDK hands back the entire
 * post-compaction conversation, so anything held here that the new list does not contain is
 * something the store no longer holds — folded into a summary, or never recorded at all. Merging
 * would be this window preserving a history the agent has stopped having.
 *
 * What survives from `live` is what the server has NOT written down: a turn still in flight, and any
 * message whose frame never reached it. Everything else is dropped, tool lines included — they come
 * back inside the persisted list, and keeping a second copy would draw each of them twice.
 *
 * A queued message is written down BEFORE its turn runs: `submitTurn` records the user line the
 * moment the turn enters the queue, so a message still waiting behind three others is already in
 * this list. Trusting `pending` here — as though "not yet acknowledged" meant "not yet seen" — would
 * draw it twice, once from the transcript and once from `live` as "sending…", for as long as it
 * waited. So the transcript is asked instead.
 */
export function adoptTranscript(state: ChatState, items: TranscriptItem[]): ChatState {
  const written = writtenUserLines(state.live, items);
  const keep: LiveItem[] = [];
  for (let i = 0; i < state.live.length; i += 1) {
    const item = state.live[i]!;
    if (item.kind === "user") {
      if (item.pending && !written.get(i)?.written) keep.push(item);
      continue;
    }
    if (item.kind !== "assistant") continue;
    if (!item.done) {
      keep.push(item);
      continue;
    }
    // An answer the store has not finished writing down. Only the paragraphs it is missing are kept,
    // and its tool lines are dropped rather than kept — the transcript already carries those, and it
    // is only the PROSE that can be missing.
    const held = unwritten(items, written, state.live, i, item.blocks);
    if (held.length === 0) continue;
    keep.push({ ...item, blocks: held });
  }
  return { ...state, persisted: items, live: keep, resyncNeeded: false };
}

/**
 * The paragraphs of a finished live turn that this transcript is not holding yet.
 *
 * THE SDK'S STORE IS FLUSHED BY A SUBPROCESS ON ITS OWN SCHEDULE, and `turn_result` arrives over a
 * socket that does not wait for it — so the fetch a finished turn triggers can land before the
 * agent's own words are on disk. A full replace would then throw away the only copy of an answer the
 * reader just watched appear, which is the one thing adoption must never do.
 *
 * WHAT LAGS IS THE LAST MESSAGE, NOT THE LAST PARAGRAPH, and that is what makes this answerable
 * rather than a guess. The store is written a message at a time — a message's text and the tool calls
 * it made are recorded together — so a turn whose stored copy ENDS IN SPEECH is a turn whose last
 * recorded message called no tools, and a message that called no tools is how a turn ends. Ending in
 * a tool line means the answer to it has not landed yet. The question is therefore asked of the
 * stored turn's LAST entry, never of whether it contains speech anywhere: the shape the agent
 * actually talks in is a sentence, some tool calls, then the answer, and that opening sentence is on
 * disk long before the answer is. Reading it as "something was said, so everything was said" is what
 * used to drop the closing paragraph of every turn that opened with one.
 *
 * WHEN IT DOES LAG, THE TOOL LINES SAY BY HOW MUCH. A message is recorded whole, so a tool line on
 * disk means the words of the message that called it are on disk too — everything up to and
 * including the last recorded tool call is written down, and what this window may still be the only
 * copy of is the prose after it. So the two lists are lined up on their TOOL LINES and the prose past
 * that point is what is kept.
 *
 * Lined up on tools rather than on paragraphs because a tool line is the one thing the two copies
 * count the same way. Speech they do not: adjacent deltas merge into one block here, while the store
 * keeps one entry per message, so a paragraph on screen can be two entries on disk or the other way
 * about. Neither is wrong, and neither can be counted against the other.
 *
 * NEITHER LIST IS ASSUMED TO START WHERE THE OTHER DOES. A window that joined the conversation
 * mid-answer — a reload, a second tab, a socket that dropped and came back — holds the tail of a turn
 * whose beginning it never saw, so it shows FEWER tool lines than the store recorded. Counting the
 * store's from the front and taking that many off this list would then eat the very paragraph this is
 * here to save. What is taken off is `min` of the two counts, which is the only stretch both lists
 * are known to cover.
 *
 * ALIGNED BY POSITION, NEVER COMPARED BY TEXT, and the difference is the whole point. The streamed
 * copy and the durable one legitimately DIFFER: the server sheds `text_delta` frames under
 * backpressure, so the words on screen can be a sentence short of the words on disk — and repairing
 * exactly that is what adoption is for. Comparing them would read every repaired answer as a missing
 * one and draw the short copy underneath the full one for ever.
 */
function unwritten(
  items: readonly TranscriptItem[],
  written: Map<number, { written: boolean; line: number }>,
  live: readonly LiveItem[],
  from: number,
  blocks: readonly AssistantBlock[],
): AssistantBlock[] {
  const stored = storedTurn(items, written, live, from);
  if (stored[stored.length - 1]?.kind === "assistant") return [];
  const recorded = stored.reduce((n, entry) => (entry.kind === "tool" ? n + 1 : n), 0);
  const shown = blocks.reduce((n, block) => (block.kind === "tool" ? n + 1 : n), 0);
  let passed = Math.min(recorded, shown);
  let start = 0;
  for (let i = 0; passed > 0 && i < blocks.length; i += 1) {
    if (blocks[i]!.kind !== "tool") continue;
    passed -= 1;
    if (passed === 0) start = i + 1;
  }
  return blocks.slice(start).filter((block) => block.kind === "text");
}

/**
 * The stretch of transcript that is the store's copy of one live turn.
 *
 * Located by a QUESTION, which is the only handle the two lists share, and bounded the way
 * `transcript` bounds a turn when it groups the persisted half: a user line or a compaction ends one,
 * everything between belongs to it. The bound is what makes the stretch mean ONE turn. A conversation
 * is one session and every tab is in it, so the store can be several turns further on than the turn
 * this window is still holding, and an unbounded stretch would measure this answer against somebody
 * else's.
 *
 * THE QUESTION AFTER IT LOCATES A TURN AS WELL AS THE QUESTION BEFORE IT, which matters because the
 * one before does not survive. Prose held back by an adoption outlives the user line that anchored
 * it: the store had written that line down, so the line was retired into `persisted` and the held
 * paragraph is left with nothing before it. Read forwards instead, it is the group that ends where
 * the NEXT question begins — and that is what stops an answer held over from one turn being measured
 * against the next turn's stretch and drawn a second time inside it.
 *
 * Either scan stops at the first live item that is somebody's turn rather than a question, because a
 * question with another answer between it and this one is not this one's.
 *
 * A turn with no question either side of it falls back to the store's last group, which is the only
 * stretch it could be.
 */
function storedTurn(
  items: readonly TranscriptItem[],
  written: Map<number, { written: boolean; line: number }>,
  live: readonly LiveItem[],
  from: number,
): TranscriptItem[] {
  for (let i = from - 1; i >= 0; i -= 1) {
    if (live[i]!.kind === "assistant") break;
    if (live[i]!.kind !== "user") continue;
    const claim = written.get(i);
    if (claim !== undefined && claim.written) return groupAt(items, claim.line + 1);
    break;
  }
  for (let i = from + 1; i < live.length; i += 1) {
    if (live[i]!.kind === "assistant") break;
    if (live[i]!.kind !== "user") continue;
    const claim = written.get(i);
    if (claim !== undefined && claim.written) return groupAt(items, opensAt(items, claim.line));
    break;
  }
  return groupAt(items, opensAt(items, items.length));
}

/** Where the group ending at `line` begins: just past the question or compaction before it. */
function opensAt(items: readonly TranscriptItem[], line: number): number {
  for (let i = line - 1; i >= 0; i -= 1) {
    if (items[i]!.kind === "user" || items[i]!.kind === "compacted") return i + 1;
  }
  return 0;
}

/** One turn as the store holds it: from `start` up to the next question or compaction. */
function groupAt(items: readonly TranscriptItem[], start: number): TranscriptItem[] {
  for (let i = start; i < items.length; i += 1) {
    if (items[i]!.kind === "user" || items[i]!.kind === "compacted") return items.slice(start, i);
  }
  return items.slice(start);
}

/**
 * Which live user items this transcript already holds, by index into `live`.
 *
 * Matched on the text, newest with newest, one line per item: a tab never learns any handle for its
 * own message — the SDK's store names nothing this window can address — so the text is the whole
 * join. An item that finds no line of its own is one the server never saw: a frame written into a
 * socket that died before it flushed. It stays in `live` as the unsent thing it is rather than being
 * retired into a conversation that does not contain it.
 */
function writtenUserLines(
  live: readonly LiveItem[],
  items: readonly TranscriptItem[],
): Map<number, { written: boolean; line: number }> {
  const lines: number[] = [];
  for (let i = 0; i < items.length; i += 1) if (items[i]!.kind === "user") lines.push(i);

  const claimed = new Set<number>();
  const written = new Map<number, { written: boolean; line: number }>();
  for (let i = live.length - 1; i >= 0; i -= 1) {
    const item = live[i]!;
    if (item.kind !== "user") continue;
    written.set(i, { written: false, line: -1 });
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      const line = lines[at]!;
      if (claimed.has(line) || (items[line] as { text: string }).text !== item.text) continue;
      claimed.add(line);
      written.set(i, { written: true, line });
      break;
    }
  }
  return written;
}

export function clearError(state: ChatState): ChatState {
  return state.lastError === null ? state : { ...state, lastError: null };
}

/** Take back the text a refusal returned, so the composer can restore it exactly once. */
export function takeRefusedText(state: ChatState): { state: ChatState; text: string | null } {
  if (state.refusedText === null) return { state, text: null };
  return { state: { ...state, refusedText: null }, text: state.refusedText };
}

// -- frames -------------------------------------------------------------------------------------

/**
 * One frame, applied.
 *
 * Returns the state UNCHANGED — the same object — when a frame changes nothing, so a subscriber
 * comparing snapshots does not re-render on a `pong`.
 *
 * Every block-producing frame opens a turn if none is open. That is not defensive: a tab attaching
 * mid-turn receives `ready` and then deltas, with the `turn_started` long gone, and a reducer that
 * waited for one would draw nothing at all for the rest of the answer.
 */
export function applyFrame(state: ChatState, frame: OutboundFrame): ChatState {
  switch (frame.type) {
    case "ready":
      // Copied WHOLE, `effort` and `subagents` included and unconditionally: the frame is the
      // authority on all four of the conversation's answering facts, and a reducer that took one of
      // them only when it looked like a change would leave a control showing the last state of a
      // conversation that has since been resumed or cleared back to the installation's.
      return {
        ...state,
        sessionId: frame.sessionId,
        model: frame.model,
        models: frame.models,
        effort: frame.effort,
        subagents: frame.subagents,
        fresh: frame.fresh,
        venvReady: frame.venvReady,
        ready: true,
      };

    case "turn_started": {
      // The oldest unacknowledged message is the one that started; a later one is still waiting.
      let acknowledged = false;
      const live = state.live.map((item) => {
        if (acknowledged || item.kind !== "user" || !item.pending) return item;
        acknowledged = true;
        return { ...item, pending: false };
      });
      const seq = state.seq + 1;
      return {
        ...state,
        seq,
        live: [...live, { kind: "assistant", id: `a${seq}`, blocks: [], done: false }],
      };
    }

    case "text_delta":
      return withTurn(state, (turn, seq) => appendText(turn, frame.text, seq));

    case "tool_start":
      return withTurn(state, (turn, seq) => ({
        ...turn,
        blocks: [
          ...turn.blocks,
          {
            kind: "tool",
            id: `b${seq}`,
            toolUseId: frame.toolUseId,
            tool: frame.tool,
            summary: frame.summary,
            status: "running",
          },
        ],
      }));

    case "tool_end": {
      const closed = closeTool(state, frame.toolUseId, frame.ok, frame.summary);
      if (closed !== null) return closed;
      // No line to close: this tab attached after the tool started. The end is still worth drawing —
      // the alternative is a turn that silently omits work that happened.
      return withTurn(state, (turn, seq) => ({
        ...turn,
        blocks: [
          ...turn.blocks,
          {
            kind: "tool",
            id: `b${seq}`,
            toolUseId: frame.toolUseId,
            tool: frame.tool,
            summary: frame.summary,
            status: frame.ok ? "ok" : "failed",
          },
        ],
      }));
    }

    case "report_published":
      return withTurn(state, (turn, seq) => ({
        ...turn,
        blocks: [
          ...turn.blocks,
          {
            kind: "report",
            id: `b${seq}`,
            reportId: frame.reportId,
            title: frame.title,
            url: frame.url,
          },
        ],
      }));

    case "compacted": {
      // A marker where the fold happened, and the open turn is deliberately LEFT OPEN. Compaction can
      // fire in the middle of an answer, and closing that turn to put the marker after it would tell
      // the composer the agent had stopped talking — the button would offer to send while the model
      // was still writing. So the turn keeps growing where it is, and the marker records that the
      // history behind it is a summary now. No resync is asked for: the turn's own result will ask
      // for one in a moment, and refetching mid-answer would replace the transcript underneath it.
      const seq = state.seq + 1;
      return { ...state, seq, live: [...state.live, { kind: "compacted", id: `c${seq}` }] };
    }

    case "turn_result": {
      // Closed and resynced whatever the subtype says. An interrupted or errored turn still wrote
      // whatever it managed to say, and the SDK's store is where that is true. A tool still running
      // at this point never gets an end — the server clears its pairing map here rather than
      // inventing one — so the line is settled instead of left spinning.
      const live = state.live.map((item) =>
        item.kind === "assistant" && !item.done
          ? { ...item, done: true, blocks: settle(item.blocks) }
          : item,
      );
      return { ...state, live, resyncNeeded: true };
    }

    case "error": {
      const next: ChatState = { ...state, lastError: { code: frame.code, message: frame.message } };
      if (frame.code !== "busy") return next;
      // The agent was mid-answer, so the newest message never became a turn. It comes off the
      // transcript either way — it was not said — but only a TYPED one goes back to the composer:
      // a spoken sentence was never the reader's draft, so it just leaves.
      const index = lastPendingUser(state.live);
      if (index === -1) return next;
      const refused = state.live[index] as Extract<LiveItem, { kind: "user" }>;
      return {
        ...next,
        live: [...state.live.slice(0, index), ...state.live.slice(index + 1)],
        refusedText: refused.origin === "typed" ? refused.text : null,
      };
    }

    case "generation_started":
    case "generation_ended":
    case "pong":
      // Neither generation frame says anything about the transcript: they are procedure state, and
      // the store acts on them. Folding one in here would put a banner's state inside a
      // conversation. The generation's own TURN arrives through the ordinary frames like any
      // other, which is the point of submitting it as one.
      return state;
  }
}

/** Run `edit` against the open turn, opening one first if there is none. */
function withTurn(
  state: ChatState,
  edit: (turn: Extract<LiveItem, { kind: "assistant" }>, seq: number) => LiveItem,
): ChatState {
  const seq = state.seq + 1;
  const index = lastOpenTurn(state.live);
  if (index === -1) {
    const opened: Extract<LiveItem, { kind: "assistant" }> = {
      kind: "assistant",
      id: `a${seq}`,
      blocks: [],
      done: false,
    };
    return { ...state, seq: seq + 1, live: [...state.live, edit(opened, seq + 1)] };
  }
  const turn = state.live[index] as Extract<LiveItem, { kind: "assistant" }>;
  return {
    ...state,
    seq,
    live: [...state.live.slice(0, index), edit(turn, seq), ...state.live.slice(index + 1)],
  };
}

/**
 * Append prose to the turn's trailing text block, or start one.
 *
 * A delta lands on the LAST block only when that block is text. Anything else between two deltas —
 * a tool line, a publication — ends the paragraph, which is exactly how the answer read as it
 * happened. Dropped deltas need no handling here and get none: this appends what arrived, and the
 * gap is closed by `adoptTranscript` replacing the whole thing with what the server wrote down.
 */
function appendText(
  turn: Extract<LiveItem, { kind: "assistant" }>,
  text: string,
  seq: number,
): LiveItem {
  const last = turn.blocks[turn.blocks.length - 1];
  if (last !== undefined && last.kind === "text") {
    return {
      ...turn,
      blocks: [...turn.blocks.slice(0, -1), { ...last, text: last.text + text }],
    };
  }
  return { ...turn, blocks: [...turn.blocks, { kind: "text", id: `b${seq}`, text }] };
}

/** Close a running tool line wherever it is, or null when no line is carrying that id. */
function closeTool(
  state: ChatState,
  toolUseId: string,
  ok: boolean,
  summary: string,
): ChatState | null {
  for (let i = state.live.length - 1; i >= 0; i -= 1) {
    const item = state.live[i]!;
    if (item.kind !== "assistant") continue;
    const at = item.blocks.findIndex(
      (block) => block.kind === "tool" && block.toolUseId === toolUseId && block.status === "running",
    );
    if (at === -1) continue;
    const block = item.blocks[at] as ToolBlock;
    const blocks = [...item.blocks];
    // The end's own summary replaces the start's when it has one — it is the one that knows what
    // happened. An empty one leaves the start's text, which said what was attempted.
    blocks[at] = {
      ...block,
      status: ok ? "ok" : "failed",
      summary: summary === "" ? block.summary : summary,
    };
    const live = [...state.live];
    live[i] = { ...item, blocks };
    return { ...state, live };
  }
  return null;
}

/**
 * Where the turn still being written is, or -1.
 *
 * Scans backwards and stops at the first ASSISTANT item, which is what makes "the open turn" mean the
 * newest one: a user line or a compaction marker sitting after it is not a turn and does not close
 * one, so both are walked past rather than treated as a boundary.
 */
function lastOpenTurn(live: readonly LiveItem[]): number {
  for (let i = live.length - 1; i >= 0; i -= 1) {
    const item = live[i]!;
    if (item.kind === "assistant") return item.done ? -1 : i;
  }
  return -1;
}

function lastPendingUser(live: readonly LiveItem[]): number {
  for (let i = live.length - 1; i >= 0; i -= 1) {
    const item = live[i]!;
    if (item.kind === "user" && item.pending) return i;
  }
  return -1;
}
