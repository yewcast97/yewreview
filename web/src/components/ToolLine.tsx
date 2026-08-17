/**
 * One thing the agent did, on one line.
 *
 * A tool line is the only place this window shows work in progress, and it is deliberately not a
 * disclosure widget: the server already collapsed the call into a sentence (`summary`), and a panel
 * that offered to expand it would be promising arguments and results the protocol never sends. What
 * a reader gets is what the server knows — which tool, what it was about, and whether it worked.
 *
 * The mark carries the state twice: a shape (ring / ✓ / ✗) and a colour. Colour alone would say
 * nothing to a reader who cannot separate the two greens, and this line is the audit trail.
 */

import type { ReactElement } from "react";

import type { ToolBlock, ToolStatus } from "../state/chat.ts";

/** Read out beside the mark, which is decorative. "done" rather than "ok": it is a sentence about
 * work, not a status code. */
const SPOKEN: Record<ToolStatus, string> = {
  running: "running",
  ok: "done",
  failed: "failed",
  stopped: "no result",
};

/** The mark for a line that will never end: the turn closed while the tool was in flight, so what
 * became of it is not something this window was ever told. A dash rather than a cross, because a
 * cross would be reporting a failure nobody observed. */
const MARK: Record<Exclude<ToolStatus, "running">, string> = {
  ok: "✓",
  failed: "✗",
  stopped: "–",
};

export function ToolLine({ block }: { block: ToolBlock }): ReactElement {
  return (
    <div className="chat__tool" data-status={block.status}>
      <span className="chat__tool-mark" aria-hidden="true">
        {block.status === "running" ? <span className="chat__spinner" /> : MARK[block.status]}
      </span>
      <span className="chat__tool-name">{block.tool}</span>
      {block.summary === "" ? null : <span className="chat__tool-summary">{block.summary}</span>}
      <span className="sr-only">{SPOKEN[block.status]}</span>
    </div>
  );
}
