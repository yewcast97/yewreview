/**
 * What the agent said, did, and published — one turn, as an ordered list of blocks.
 *
 * The blocks are drawn in the order they arrived and nothing is grouped or reordered. That is what
 * makes "two sentences, a measurement, a correction, a published report" read the way it happened
 * instead of as a summary of it, and it is why there is no special case anywhere below for
 * text-after-a-tool-line.
 *
 * THE PROSE IS `MarkdownView`'s, mentions on. Everything about how markdown reaches the DOM — the
 * one `innerHTML` site, the sanitise-then-decorate order, the per-frame parse for a streaming
 * block — lives in that component now; this one only decides WHICH blocks are prose and which of
 * them is still growing. Only the trailing block of an open turn is live; the ones before it were
 * closed by whatever interrupted them and can be parsed once.
 *
 * ONE THING IS LIFTED OUT OF THE PROSE BEFORE IT GETS THERE: a line naming a file the agent wrote,
 * which becomes a download rather than a sentence about one. `lib/attachments.ts` argues for the
 * convention and holds the grammar; what it means here is that a text block is not one run of
 * markdown but an alternation of prose and files, drawn in the order they were written.
 */

import type { ReactElement } from "react";

import { splitAttachments } from "../lib/attachments.ts";
import { copyToClipboard, useCopied } from "../lib/clipboard.ts";
import type { ChatItem, ReportBlock, TextBlock } from "../state/chat.ts";
import { messageMarkdown } from "../state/chat.ts";
import { viewRecord } from "../state/store.ts";
import { AttachmentChip } from "./AttachmentChip.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import { ToolLine } from "./ToolLine.tsx";

export type AssistantItem = Extract<ChatItem, { kind: "assistant" }>;

export function AssistantMessage({ item }: { item: AssistantItem }): ReactElement {
  const last = item.blocks.length - 1;
  return (
    <article className="chat__msg chat__msg--agent">
      <h3 className="sr-only">The agent</h3>
      {item.blocks.map((block, index) => {
        // KEYED ON THE BLOCK'S OWN ID and never on `toolUseId`. A tool line read
        // back from the SDK's store is already finished, so it carries no pairing handle at all — the
        // reducer gives it the empty string — and two finished tool calls in one turn would then be
        // two children with the same key.
        if (block.kind === "tool") return <ToolLine key={block.id} block={block} />;
        if (block.kind === "report") return <ReportLine key={block.id} block={block} />;
        return <Prose key={block.id} block={block} live={item.live && index === last} />;
      })}
      {item.live && item.blocks.length === 0 ? (
        <div className="chat__thinking">
          <span className="chat__spinner" />
          <span>working…</span>
        </div>
      ) : null}
      <Footer item={item} />
    </article>
  );
}

/**
 * One block of what the agent said: its prose, and the files it named in the middle of it.
 *
 * THE SPLIT IS REDONE ON EVERY DELTA, and it costs a scan of the block. That is what makes an
 * attachment line become a chip the moment the newline after it arrives rather than when the turn
 * ends, and it is why `final` is the block's own liveness: while the last line may still be growing,
 * a half-written path is held as prose (see `lib/attachments.ts`) instead of becoming a link to a
 * file that does not exist yet.
 *
 * WHICHEVER SEGMENT IS LAST IS THE ONE THAT MAY BE LIVE, and only in a block that is still
 * streaming. Everything before it was closed by the line that ended it and can be parsed once —
 * which is the same rule this file already applies to the blocks of a turn, one level down.
 *
 * MID-STREAM IMPERFECTION HEALS ITSELF, and that is what makes the arrangement safe to keep this
 * simple. What is on screen during a turn is the deltas as they arrive; when the turn resolves, the
 * durable copy read back from the SDK's store replaces the streamed text and every block is split
 * and drawn again from it. So a line that was momentarily prose because its newline had not landed,
 * or a fence that had opened and not yet closed, is corrected by the redraw rather than by anything
 * here having to be right the first time.
 */
function Prose({ block, live }: { block: TextBlock; live: boolean }): ReactElement {
  const segments = splitAttachments(block.text, !live);
  const last = segments.length - 1;
  return (
    <>
      {/* KEYED ON THE POSITION, which is the only handle a segment has: it is cut out of the text
          rather than carried in the frame, so it has no id of its own. A delta that only extends the
          last segment leaves every key where it was, which is the case that matters — the live
          `MarkdownView` keeps its per-frame parse. A delta that turns the last line into a chip does
          change what sits at that position, and rebuilding from there is the redraw that was wanted
          anyway. */}
      {segments.map((segment, index) =>
        segment.kind === "file" ? (
          <AttachmentChip key={index} path={segment.path} name={segment.name} />
        ) : (
          <MarkdownView key={index} text={segment.text} live={live && index === last} mentions />
        ),
      )}
    </>
  );
}

/**
 * A way to take what the turn said.
 *
 * THERE IS NO TIMESTAMP. A turn is not a row with a `created_at`: the transcript is the harness's
 * own store and it records the ORDER things were said rather than the moments — see
 * `lib/protocol.ts` — so a "4m" here would be this window making one up.
 *
 * AND THERE IS NO COST. A figure used to sit beside the copy control, printed from `turn_result`,
 * and it went for two reasons that are really one. It was a RUNNING METER on a tool the reader is
 * not billed by the message for — noise beside the answer rather than information about it, in the
 * one place where what they are reading is the answer. And it was only ever there on the handful of
 * turns this tab happened to WATCH: a conversation read back after a reload carried no figure at
 * all, so the row was inconsistent about what it showed for reasons the reader could not see. The
 * field is gone from the frame as well as from here.
 *
 * SO THE ROW IS DRAWN OFF THE PROSE, which is the only thing left in it. A turn that has settled
 * with something in it gets the control; anything else gets no footer.
 *
 * A TURN STILL BEING WRITTEN GETS NOTHING. The words are still arriving, and what the clipboard took
 * would be half of a sentence the reader is watching appear — and the streamed copy is not the
 * durable one anyway (`state/chat.ts`), so the copy of an answer worth taking is the one that is
 * there a moment later.
 */
function Footer({ item }: { item: AssistantItem }): ReactElement | null {
  const markdown = item.live ? "" : messageMarkdown(item.blocks);
  if (markdown === "") return null;
  return (
    <div className="chat__meta">
      <CopyMessage markdown={markdown} />
    </div>
  );
}

/**
 * Take the whole answer, as the markdown it was written in.
 *
 * IT IS IN REACT-OWNED CHROME AND NEVER INSIDE `.markdown`. The prose in there reaches the DOM
 * through an `innerHTML` assignment that happens outside React's commit and replaces the whole
 * document on every frame of a live turn, so a button mounted into it would be painted over by the
 * next pass — which is exactly why the copy control ON A FENCE is built by hand and delegated to
 * (`MarkdownView.tsx`). This one is a child of the turn's own footer, where React owns every node.
 *
 * IT IS VISIBLE WHENEVER THE TURN IS, and never revealed by the pointer arriving. That is the
 * argument `chat.css` already makes at `.chat__chip-remove`, and it is the same argument here: a
 * control that appears under the pointer is one a keyboard cannot find and a touch screen cannot
 * summon.
 */
function CopyMessage({ markdown }: { markdown: string }): ReactElement {
  const { copied, flash } = useCopied();
  return (
    <button
      type="button"
      className={copied ? "chat__copy chat__copy--copied" : "chat__copy"}
      onClick={() => {
        void copyToClipboard(markdown).then((landed) => {
          if (landed) flash();
        });
      }}
      // What lands on the clipboard is the markdown the agent wrote and not the prose as it was
      // painted — tables, fences and mentions in their source form — and the label says so, because
      // a reader pasting into a document is entitled to know which of the two they are getting. The
      // words live HERE rather than in the button, which is the trade a glyph makes: a screen reader
      // and a hover both still get the sentence, and the sighted reader gets 16 pixels instead of a
      // word competing with the answer above it.
      aria-label="Copy this message as markdown"
      title={copied ? "Copied" : "Copy what the agent said, as markdown"}
    >
      <CopyGlyph />
    </button>
  );
}

/**
 * Two overlapping sheets: the copy mark, drawn rather than typed.
 *
 * BY HAND, FOR THE REASON `MagnifyGlyph` IS. The unicode candidates for this are a lottery across
 * platforms — ⧉ and ⎘ are missing from enough fonts to fall back to a box, and the emoji clipboard
 * arrives coloured and vertically off — so the mark is a path, at the size it is meant to be seen,
 * inheriting the row's own colour through `currentColor`.
 *
 * THE COPIED STATE IS THE SAME MARK, FILLED. It was the word "copied" before, which is why
 * `.chat__copy` used to reserve six characters of width: a control that swapped one word for a
 * longer one would otherwise reflow the footer under the pointer at the moment of pressing it. A
 * glyph has no such problem — the acknowledgement is a fill, the geometry never moves, and the
 * reserved width went with the words.
 */
function CopyGlyph(): ReactElement {
  return (
    <svg
      className="chat__copy-glyph"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      {/* The sheet behind, showing at its top-right corner only — the one cue that says two of
          something rather than one framed thing. */}
      <path
        d="M5.5 2.5h8v8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The sheet in front, whole. Rounded, because every other frame in this window is. */}
      <rect
        x="2.5"
        y="5.5"
        width="8"
        height="8"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function ReportLine({ block }: { block: ReportBlock }): ReactElement {
  return (
    <button
      type="button"
      className="chat__report"
      title={`Open ${block.title} in the record panel`}
      // A report is a record like any other here, addressed by its table and id. The panel is what
      // knows that this particular record renders as the document it names rather than as a row —
      // and it opens as one more card, so the report a turn just published lands beside whatever the
      // reader was already looking at rather than in place of it.
      onClick={() => viewRecord("report", block.reportId, block.title)}
    >
      <span className="chip">report</span>
      <span className="chat__report-title">{block.title}</span>
    </button>
  );
}
