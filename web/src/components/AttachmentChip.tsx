/**
 * A file named in the conversation, drawn as something the reader can take away.
 *
 * AN ANCHOR AND NOT A BUTTON, which is the whole of the component. Saving a file is the browser's
 * own gesture and a link is how it is offered: middle-click, right-click, save-as, a keyboard, a
 * download manager — all of them work on a link and none of them work on a button that would have to
 * fabricate one. There is no JavaScript in this path at all, so a chip drawn in a turn that arrived
 * an hour ago is as clickable as one from a moment ago.
 *
 * `download` is a hint that AGREES WITH THE SERVER rather than a rule this window sets. The
 * `content-disposition: attachment` that `src/server/homeFiles.ts` sends is the authority, and it
 * argues at length why it may never be relaxed — the agent authors `.html` and `.svg`, and this
 * origin also serves `/api/**`. The attribute is here for what it says BEFORE the click: a link with
 * it reads as a file to keep rather than a page to go to, which is what stops a reader wondering
 * whether the conversation is about to be navigated away from.
 *
 * THE TARGET IS BUILT AND NEVER TAKEN, which matters because this is the one control in the
 * transcript whose destination comes out of message text. `fileHref` puts the route's own prefix in
 * front and percent-encodes what follows, so a path spelling `javascript:alert(1)` addresses a file
 * of that name under the home — a 404 — rather than a scheme. There is no branch here that could
 * ever hand an anchor something a message said verbatim.
 *
 * WHAT IT SAYS IS THE BASE NAME AND WHAT IT KNOWS IS THE PATH. `q3-earnings.pdf` is what a reader
 * recognises; the directory above it is machinery — a per-upload folder, or wherever the agent chose
 * to write — and a chip as wide as the whole path spends the transcript's width saying it. Two files
 * of the same name from two directories are still two chips, and the `title` is where the whole path
 * is available to anybody who needs to tell them apart.
 *
 * NOTHING HERE CHECKS THAT THE FILE IS THERE. A HEAD request per chip would cost one round trip for
 * every attachment in a scrolled-back conversation and would still be answering about a moment
 * before the click. A file the agent has since overwritten or removed answers the click with the
 * route's own 404, which is the truth at the only moment that matters.
 */

import type { ReactElement } from "react";

import { fileHref } from "../lib/attachments.ts";

export function AttachmentChip({ path, name }: { path: string; name: string }): ReactElement {
  return (
    <a className="chat__file" href={fileHref(path)} download={name} title={`Download ${path}`}>
      <span className="chip">file</span>
      <span className="chat__file-name">{name}</span>
    </a>
  );
}
