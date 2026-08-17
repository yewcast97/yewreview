/**
 * The one fact that belongs to the WINDOW rather than to either panel, at the foot of the corner
 * stack.
 *
 * Whether this app can do its work. It is not about the graph or about the record being read, so it
 * has no header to sit in — a column present no matter what the reader is doing would be the place
 * for one, and this window has none. A small cluster does that job instead:
 * it is on screen in every state of the window, it costs a corner rather than a column, and nothing in
 * it is part of the work.
 *
 * ONE FACT, AND NO THEME TOGGLE BESIDE IT. The window is dark, `tokens.css` is one `:root`, and
 * `color-scheme: dark` in render-blocking CSS paints the caret, the form controls and the canvas
 * beyond the body. A control cycling light, dark and auto would be offering a preference the product
 * does not have, which is worse than no control.
 *
 * A CLUSTER OF ONE IS STILL A CLUSTER, and that is deliberate rather than laziness about deleting a
 * wrapper. What the `.status` box provides is the SURFACE — a filled pill with a hairline and a shadow
 * over a graph canvas whose links and boxes run underneath — and unfilled text over a moving picture
 * is unreadable at exactly the moment somebody looks for it. It is also the seat this corner keeps for
 * whatever fact about the window comes next.
 *
 * THE LAST CHILD OF `.lcd-stack`, WHICH IS HOW IT KEEPS THE BOTTOM-LEFT CORNER. Pinning itself there
 * with a `position: fixed` of its own would leave the read-outs above clearing it by a hard-coded
 * constant two stylesheets promised each other. As the bottom of the column it holds the corner
 * structurally: the column is anchored to the edge this pill sits on, so a ledger
 * expanding above it displaces everything except this. The corner is the one nothing else
 * wants — the graph's controls are at the top right of its header, the toasts come up from the
 * bottom right, and the conversation sits centred on the bottom edge, clear of all of them.
 *
 * THE WORDMARK IS THE BADGE. Naming the product to somebody who has just opened it is a job nothing
 * in this corner is for; what the badge says is "YewReview 1.0.0" — the name where it is
 * actually load-bearing, welded to the version somebody is about to quote in a bug report, and the
 * one fact on screen that says WHICH build this is. Everything else the panel knows is behind the
 * hover, because everything else is a capability rather than an identity.
 */

import type { ReactElement } from "react";

import { HealthBadge } from "./HealthBadge.tsx";
import "../styles/paper.css";
import "./StatusCluster.css";

export function StatusCluster(): ReactElement {
  return (
    <div className="status" role="group" aria-label="Server">
      <HealthBadge />
    </div>
  );
}
