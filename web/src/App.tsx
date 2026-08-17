/**
 * The window: one board, and the things that float over it.
 *
 * App owns exactly one thing — bringing the store up, which is the events channel, the single chat
 * socket, and the four reads that fill the window. It decides nothing else. Everything below is a
 * component reading the store for itself, which is why nothing here passes props: a panel that took
 * its data through App would make App the place five different panels' requirements accumulate.
 *
 * THE BOARD IS THE WHOLE WINDOW, edge to edge. What is open floats over the slate as notes
 * (`NoteBoard`), which unmounts itself while nothing is open, and the slate runs to the glass. There
 * is no split, no divider, no frame and no solo state: the graph always has the full window, and
 * opening a record costs it nothing.
 *
 * THE FLOATING LAYERS DO NOT STACK IN SOURCE ORDER, and the order below says nothing about what
 * covers what. One shared `--z-float` settling by the order this file writes them in would put the
 * corner instruments on top of everything — a rule invisible from the four stylesheets it actually
 * governs, and one that decides the question backwards. Each layer carries
 * its own token and `tokens.css` holds the argument: the conversation lowest (`--z-dock`), the
 * desk everything else is laid on; the corner column over it (`--z-corner`); notes over both
 * (`--z-note`), because a note is the work and must not vanish under anything the reader dragged it
 * across; and the toasts and the dialog above all of them, because a refusal and a question are
 * about something that has already been asked for and must not be hidden by the thing that asked.
 *
 * The Bin's placement is a knowing trade. It lives in the corner column, so a note dragged onto it
 * passes over it rather than under; the drop still lands, because the
 * Bin's rectangle is read at the press and hit-tested arithmetically rather than by asking what is
 * under the cursor, and the lit edge shows around the held note instead of through it.
 *
 * THE READ-OUTS ARE RENDERED HERE AND COULD NOT BE RENDERED ANYWHERE ELSE. The column they stack in
 * is `position: fixed` against the viewport. `.graph__surface` carries the reader's pan and zoom,
 * and a transform RE-ROOTS `position: fixed` to the transformed element: a read-out rendered inside
 * the graph would ride away with the canvas and scale with the zoom, which looks like a bug in the
 * graph rather than in the overlay. `lcd.css` states the rule; this is the file that has to obey it.
 *
 * NOTHING IS AUTO-SELECTED AND NOTHING IS AUTO-OPENED. Nothing needs opening: the window boots onto
 * the database with the dock already attached to whatever conversation the agent is in — and the
 * session list in the corner is how the reader swaps an earlier one into it.
 */

import { useEffect, type ReactElement } from "react";

import { ChalkDefs } from "./components/ChalkDefs.tsx";
import { ConfirmDialog } from "./components/ConfirmDialog.tsx";
import { ChatDock } from "./components/ChatDock.tsx";
import { GraphPanel } from "./components/GraphPanel.tsx";
import { BinPanel, LogPanel } from "./components/Ledgers.tsx";
import { NoteBoard } from "./components/NoteBoard.tsx";
import { SessionPanel } from "./components/SessionPanel.tsx";
import { StatusCluster } from "./components/StatusCluster.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { initStore } from "./state/store.ts";

export function App(): ReactElement {
  useEffect(() => initStore(), []);

  return (
    <div className="app">
      {/* The filter defs every chalk line and deckled edge in the window resolves against. First,
          and in the one component that never unmounts — see ChalkDefs.tsx. */}
      <ChalkDefs />
      <GraphPanel />
      <ChatDock />
      <NoteBoard />
      {/*
       * The bottom-left column, and the only element in this file that is furniture rather than a
       * component: it is a POSITION, and the things positioned by it are the ones that own the
       * material they are made of. The class is `lcd.css`'s, which the corner read-outs import — a
       * sheet shared by two components, argued in its own header — so the rule is present whenever
       * there is anything in the column to dress. `pointer-events` is handled there too: the column
       * is transparent to the pointer and its children are not, so the gaps between them do not
       * swallow drags meant for the canvas underneath.
       *
       * The status pill is the column's LAST child, which is how it keeps the corner itself: the
       * column is anchored to the bottom edge the pill sits on, so anything growing above displaces
       * everything except it. It is not an `.lcd` — it dresses itself opaquely in its own sheet —
       * but where it hangs is this column's business, not a fixed rule of its own.
       */}
      <div className="lcd-stack">
        <SessionPanel />
        <LogPanel />
        <BinPanel />
        <StatusCluster />
      </div>
      <Toasts />
      <ConfirmDialog />
    </div>
  );
}
