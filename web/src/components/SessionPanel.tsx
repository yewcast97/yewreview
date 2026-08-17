/**
 * Every conversation this installation has had, as a corner unit that opens on demand.
 *
 * IT IS THE ONLY WAY BACK INTO A CONVERSATION. The agent SDK owns the history: it names each session
 * from what was said in it, folds long ones into summaries on its own initiative, and hands one back
 * whole when asked by id. Nothing in this database records any of that. So a conversation that is
 * not in this list is a conversation this window has no address for — and the BUTTON is always on
 * screen even though the list is not: the list shares the corner slot with the two ledgers
 * (`state/logs.ts`), so it is one press away in exactly the sense the log is, and opening it puts
 * the ledgers away with the same single write that keeps that corner honest. The unit
 * borrows `Ledgers.css`'s whole reveal — the chip-to-panel width, the `0fr ↔ 1fr` rise, the
 * displacement up the stack — by wearing the same classes, so there is no second animation to keep
 * in step with the first.
 *
 * THE BROOM IS IN THE CONVERSATION AND NOT HERE, and the argument for it is the reason. Starting a
 * fresh conversation must not require reading the earlier ones — and the dock's header is on screen
 * at all times, where this corner unit is one press away, so a control for clearing the desk belongs
 * on the conversation rather than on the filing cabinet the swept-up ones are kept in. What this
 * instrument is, whole, is the toggle: a way back into a conversation that has been put down.
 *
 * THE MAGNET IN THE CORNER IS THE CLOSE, and it is the same rust stone as every other magnet in this
 * window for the reason the board states outright (`GraphPanel.tsx`'s how-to line — "the red magnet
 * takes a note down"): a unit that wore a decorative stone in the one place the reader has been
 * taught to press would be spending the vocabulary on nothing. Trim at the top centre in this
 * instrument's own colour would only be right if the corner were reserved for a gesture the unit does
 * not have. The head toggles as well — pressing the word is the way in, and the way out is either the
 * word again or the magnet, which is what the reader's hand already knows from the notes on the
 * board.
 *
 * THE SHEET IS THE WINDOW'S ONE PAPER, and this instrument no longer names a tint of its own. It wore
 * lavender as the log wore pink, on the argument that an instrument's dress is its identity; the
 * engraved word is that identity, and it is on screen in both states. `styles/paper.css` makes the
 * case for the single pad.
 *
 * FIXED AND NOT DRAGGABLE, over the board's canvas — see `lcd.css` for the compositing rule that
 * makes this a child of `App` rather than of anything inside `.graph__surface`. It has no header of
 * its own beyond the engraved word: it is not a panel of the application, it is a gauge showing
 * what the machine has been doing.
 *
 * THE ROWS ARE NOT SORTED HERE and the panel does not derive anything. `state/sessions.ts` decides the
 * order — live first, then newest-modified — and hands back the same row objects for every session a
 * refresh did not change. That discipline is what makes this list safe to refetch several times a
 * turn: the list is a column of clickable targets, and a reader aiming at one must not have it rebuilt
 * under the cursor because a summary somewhere else in the list moved.
 *
 * ONLY THE ROWS THAT ARE NOT LIVE ARE CONTROLS. Clicking one RESUMES it: the next turn belongs to
 * that conversation, the agent re-emits `ready` with its id, and the dock repaints from the SDK's
 * store. The live row is a read-out and nothing else — that conversation is already the one the
 * agent is in AND already on screen in the permanent dock, so there is nothing left for a click to
 * do, and a dead affordance is worse than none. Asking the server to resume it would be spending a
 * refusal on a no-op.
 *
 * THE TIME IS THE ONLY MEASURED THING IN HERE, and it is the SDK's `lastModified` rather than
 * anything this window observed. It ticks once a minute from the shared `useTicker`, in tabular
 * numerals, because a column of ages that jitters sideways is movement in the corner of the eye on a
 * list nobody is looking at directly.
 */

import type { ReactElement } from "react";

import type { SessionPayload } from "../lib/dragPayload.ts";
import { SESSION_MIME } from "../lib/dragPayload.ts";
import { formatAbsolute, formatRelative, useTicker } from "../lib/time.ts";
import type { SessionCard } from "../lib/protocol.ts";
import { resumeSession, toggleSessionsViewer, useLogs, useSessions } from "../state/store.ts";
import "./lcd.css";
import "../styles/chalk.css";
import "../styles/paper.css";
import "./Ledgers.css";
import "./SessionPanel.css";

/** A minute is the finest thing `formatRelative` distinguishes, so it is the finest thing worth
 * re-rendering for. */
const STAMP_INTERVAL_MS = 60_000;

export function SessionPanel(): ReactElement {
  const sessions = useSessions();
  const logs = useLogs();
  useTicker(STAMP_INTERVAL_MS);
  const open = logs.view === "sessions";

  return (
    /* The material layers and the class swap follow LedgerUnit exactly — see Ledgers.tsx. There is
       one paper and every unit is torn off it; only the deckle seed differs. */
    <section
      className={open ? "lcd ledger sessions paper" : "lcd ledger sessions"}
      data-open={open || undefined}
      data-chalk="0"
      aria-label="Conversations"
    >
      <span className="chalk-frame ledger__chip" aria-hidden="true" />
      <span className="paper__sheet ledger__sheet" data-deckle={0} aria-hidden="true" />
      {/* The magnet is the CLOSE — see the header. The window's one rust stone, because that is what
          it means on this board, and a button rather than trim. */}
      <button
        type="button"
        className="ledger__close paper__magnet paper__magnet--red"
        aria-label="Put the session list away"
        title="Put the session list away"
        onClick={() => toggleSessionsViewer()}
      />
      <button
        type="button"
        className="lcd__head ledger__head"
        aria-expanded={open}
        title={
          open
            ? "Put the session list away"
            : "Every conversation this installation has had — click one to swap it into the dock"
        }
        onClick={() => toggleSessionsViewer()}
      >
        <span>Sessions</span>
      </button>

      <div className="ledger__reveal">
        <div className="ledger__inner">
          <div className="ledger__body scroll-y">
            {sessions.error === null ? null : (
              // In the read-out and never as a toast: a list that cannot be refreshed is still a
              // true list of the conversations that existed a moment ago, and the sentence belongs
              // in the panel it explains. It fires on every reconnect attempt while a server is
              // down, which is exactly the thing a toast must not do.
              <p className="sessions__note" title={sessions.error}>
                {sessions.error}
              </p>
            )}

            {sessions.list.length === 0 ? (
              <p className="sessions__note">
                {sessions.loading ? "reading…" : "no conversations yet"}
              </p>
            ) : (
              <div className="sessions__list">
                {sessions.list.map((card) => (
                  <SessionRow key={card.sessionId} card={card} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SessionRow({ card }: { card: SessionCard }): ReactElement {
  // A filled dot for the live conversation and a hole for the rest, so the marker is a SHAPE
  // before it is a colour — the phosphor green is the only hue this read-out has to spend, and a
  // reader who cannot separate two greens still sees which row is filled.
  const body = (
    <>
      <span className="sessions__mark" aria-hidden="true">
        {card.live ? "●" : "○"}
      </span>
      <span className="sessions__summary">{card.summary}</span>
      <span className="sessions__when">{formatRelative(card.lastModified)}</span>
    </>
  );

  // The live row is a read-out, not a control — see the header. `aria-current` is the server's word
  // for which conversation the agent is in, never this window's: a tab that decided for itself by
  // comparing ids would be wrong for the second between a resume landing and the `ready` that
  // confirms it.
  if (card.live) {
    return (
      <div
        className="lcd__row sessions__row sessions__row--live"
        aria-current="true"
        title={`${card.summary} — the conversation the agent is in, on screen below. Last written ${formatAbsolute(card.lastModified)}.`}
      >
        {body}
      </div>
    );
  }

  // DRAGGABLE, AND ONLY THIS ROW IS. The live one above is not: deleting the transcript being
  // written into is not a state anything can be left in, the server refuses it with a 409, and a row
  // that could be dragged onto the Bin only to be told no would be an affordance that lies.
  //
  // Written inline rather than through `recordDrag.ts`, which exists because three shapes share it.
  // This one shares nothing with them: it rides its own MIME so the composer never mistakes a
  // conversation for a mention, and it writes no `text/plain`, because a transcript has no address
  // to paste. `effectAllowed` must match the Bin's `dropEffect` or the browser cancels the drop
  // without telling anybody.
  return (
    <button
      type="button"
      className="lcd__row sessions__row"
      title={`${card.summary} — reopen this conversation, or drag it to the Bin to delete it for good. Last written ${formatAbsolute(card.lastModified)}.`}
      draggable
      onDragStart={(event) => {
        const payload: SessionPayload = {
          kind: "session",
          sessionId: card.sessionId,
          summary: card.summary,
        };
        event.dataTransfer.setData(SESSION_MIME, JSON.stringify(payload));
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => void resumeSession(card.sessionId)}
    >
      {body}
    </button>
  );
}
