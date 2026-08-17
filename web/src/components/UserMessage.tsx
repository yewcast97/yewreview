/**
 * What the person said.
 *
 * Rendered as TEXT and never as markdown. The agent's prose is authored to be formatted; a person's
 * is not, and running it through a parser would turn an underscore in a filename into italics and a
 * hash at the start of a line into a heading — this window would be editing what somebody wrote.
 * Newlines survive through `white-space: pre-wrap`, which is the only formatting a composer offers.
 *
 * TWO THINGS ARE INTERPRETED, and they are the two the user did not type. A record mention arrived
 * as a dragged chip, serialised into the message text at send, and turning it back into something
 * clickable is how they check they dragged the record they meant to — a chip dragged from a field
 * row carries a `#column` tail, and that tail is part of what they need to check. A line naming an
 * uploaded file is the same fact one step further: the composer wrote it, `lib/outgoing.ts`
 * flattened it, and drawing it back as a download is what lets somebody take out again what they
 * dropped in three turns ago. Both exceptions are the composer's own words rather than the reader's,
 * which is exactly why neither is this window editing what somebody wrote.
 */

import { Fragment } from "react";
import type { ReactElement, ReactNode } from "react";

import { splitAttachments } from "../lib/attachments.ts";
import { findMentions } from "../lib/mention.ts";
import type { ChatItem } from "../state/chat.ts";
import { AttachmentChip } from "./AttachmentChip.tsx";
import { MentionPill } from "./MentionPill.tsx";
// For `.markdown__mention` only — the pill must be the same pill as in rendered prose, and the
// sheet's header names this file as its one guest importer.
import "./markdown.css";

export type UserItem = Extract<ChatItem, { kind: "user" }>;

export function UserMessage({ item }: { item: UserItem }): ReactElement {
  return (
    <article className="chat__msg chat__msg--user">
      <h3 className="sr-only">You</h3>
      <div className={item.pending ? "chat__bubble chat__bubble--pending" : "chat__bubble"}>
        {/* Split first, then decorate what is left. The other order would run the mention scanner
            over a path, which is prose to it — and would leave the attachment line to be drawn as
            the sentence it is not. A sent message never changes, so the position of a segment is
            its identity for as long as it is on screen. */}
        {splitAttachments(item.text).map((segment, index) =>
          segment.kind === "file" ? (
            <AttachmentChip key={index} path={segment.path} name={segment.name} />
          ) : (
            <Fragment key={index}>{withMentions(segment.text)}</Fragment>
          ),
        )}
      </div>
      {/* SENT AND NOT YET ACKNOWLEDGED, or nothing at all. There is no timestamp to draw beside a
          message — the SDK's transcript records the order things were said and not the moments, see
          `lib/protocol.ts` — so this line exists only while a message is in flight, and the whole
          row goes once a turn has started on it. */}
      {item.pending ? (
        <div className="chat__meta">
          <span>sending…</span>
        </div>
      ) : null}
    </article>
  );
}

/**
 * The text, with every mention in it swapped for a button that opens the record in the record panel.
 *
 * Built as React children rather than as HTML, because there is no sanitising step in this path and
 * there must never be a reason to want one: every character of a user message reaches the DOM as a
 * text node, and the two controls drawn among them — this pill and the attachment chip — are built
 * from what was parsed out of the message rather than from markup found in it.
 */
function withMentions(text: string): ReactNode[] {
  const found = findMentions(text);
  if (found.length === 0) return [text];

  const parts: ReactNode[] = [];
  let at = 0;
  for (const mention of found) {
    if (mention.start > at) parts.push(text.slice(at, mention.start));
    parts.push(
      <MentionPill
        // The offset is unique within this string and stable for as long as the string is, which is
        // for the life of the message: a sent message is never edited.
        key={mention.start}
        table={mention.table}
        name={mention.name}
        {...(mention.column === undefined ? {} : { column: mention.column })}
      />,
    );
    at = mention.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
