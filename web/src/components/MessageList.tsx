/**
 * The transcript, bottom-anchored.
 *
 * ONE SCROLL BEHAVIOUR, AND ONLY ONE. The list PINS ITSELF TO THE BOTTOM while the
 * newest turn is being written — but only while the reader has not scrolled up, because a list that
 * forces itself down mid-stream takes the paragraph somebody is reading away from them, and the agent
 * writes for minutes at a time. The opposite behaviour — an anchor holding the line under the cursor
 * still while an older PAGE is prepended above it — has nothing to do here, because there are no
 * pages. The route answers the whole post-compaction conversation in one piece — a tool line is
 * paired with its result by walking that piece from the top, so an offset page would draw calls that
 * never finished — and what bounds the length is the SDK folding its own history, which arrives as a
 * marker in the stream rather than as a list that stops.
 *
 * The pin is held in a ref rather than in state, because state would re-render the list to decide
 * where to put the list.
 *
 * Growth is watched with a `ResizeObserver` as well as after each render, because prose is painted
 * imperatively by `AssistantMessage` on an animation frame — outside React's commit, where a layout
 * effect would never see it.
 *
 * NEITHER MECHANISM RUNS WHILE THE TRANSCRIPT IS EMPTY. What the scroller holds then is one
 * invitation, and the stylesheet centres it in the blank space rather than this file placing it —
 * `chat.css` does the arithmetic against the dock's minimum height. Pinning that block to the bottom
 * would scroll its one sentence off the top of a short dock and leave the reader looking at the
 * padding underneath it, which is the whole of what a fresh installation would see. So the empty
 * pass leaves the scroll position alone and holds the pin flag true rather than reading it back off
 * that position: whatever anybody managed to scroll past while nothing had been said, the first
 * message to arrive still arrives at the bottom.
 *
 * NOTHING IN HERE IS STAMPED WITH A TIME, and that is the SDK's contract rather than an omission: its
 * transcript records the ORDER things were said and not the moments they were said at. A relative
 * stamp beside a line would be this window inventing one, so there is no minute timer in this file at
 * all.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactElement, UIEvent } from "react";

import { transcript } from "../state/chat.ts";
import {
  refreshTranscript,
  useChat,
  useConnection,
  useTranscriptError,
} from "../state/store.ts";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { UserMessage } from "./UserMessage.tsx";

/** How close to the bottom still counts as "at the bottom". A couple of lines of slack, so a
 * fractional scroll position or a one-pixel rounding error does not unpin a list nobody moved. */
const PIN_SLACK_PX = 48;

export function MessageList(): ReactElement {
  const chat = useChat();
  const connection = useConnection();
  const failure = useTranscriptError();
  const items = transcript(chat);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const empty = items.length === 0;

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget;
    pinnedRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= PIN_SLACK_PX;
  };

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    // The empty state is placed by the stylesheet, which centres it in whatever height the dock has;
    // there is nothing here to follow to the bottom, and following it would take the invitation off
    // the top of the box. The flag is put back true rather than left as the scroll handler last saw
    // it, so a reader who nudged an overflowing welcome does not unpin the conversation itself.
    if (empty) {
      pinnedRef.current = true;
      return;
    }
    if (pinnedRef.current) element.scrollTop = element.scrollHeight;
  });

  useEffect(() => {
    // Nothing grows while the invitation is the only thing in the box, and re-pinning on its resize
    // would undo the centring for exactly the dock heights that need it most. `empty` is in the
    // dependencies so the observer attaches the moment the first message lands.
    if (empty) return;
    const element = scrollRef.current;
    const content = contentRef.current;
    if (element === null || content === null) return;
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [empty]);

  return (
    <div
      className="chat__list scroll-y"
      ref={scrollRef}
      onScroll={onScroll}
      role="log"
      aria-label="Conversation transcript"
      // Explicitly silent, against `log`'s implicit politeness: the agent streams a sentence a token
      // at a time, and a live region here would read the same growing paragraph dozens of times.
      aria-live="off"
    >
      <div className={empty ? "chat__items chat__items--empty" : "chat__items"} ref={contentRef}>
        {empty ? (
          <Empty
            opening={connection === "connecting" || connection === "awaiting_ready"}
            failure={failure}
          />
        ) : (
          items.map((item) =>
            item.kind === "user" ? (
              <UserMessage key={item.id} item={item} />
            ) : item.kind === "compacted" ? (
              <Compacted key={item.id} />
            ) : (
              <AssistantMessage key={item.id} item={item} />
            ),
          )
        )}
        {/* There is deliberately no "this agent was started fresh" notice here. Such a warning would
            need a transcript kept in this application's own table, outliving the SDK session that
            lived through it, so that a restart could draw a conversation the model does not hold.
            The transcript IS the session: what is on screen is read out of the store the agent is
            running from, and the two cannot disagree. A warning that can never be true is one a
            reader learns to scroll past. */}
        {connection === "reconnecting" ? (
          <p className="chat__notice">
            Reconnecting. The agent keeps working — what it says will appear when the connection
            returns.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Where the history was folded.
 *
 * DRAWN, AND DRAWN QUIETLY, which are two decisions rather than one. It is drawn because a reader who
 * refetches this conversation tomorrow will find its first half missing, and a window that showed
 * nothing there would be inviting them to conclude the model had forgotten rather than that the SDK
 * had summarised. It is quiet because nothing went wrong and nobody has to act: the agent decided its
 * own history was long enough, which is a thing that happens to a conversation rather than in it.
 *
 * A rule with a word on it and not a bubble, for the same reason — a compaction has no speaker. The
 * `trigger` the frame carried is deliberately not shown: it is the SDK's own word for its own
 * threshold, useful in a log and meaningless in a transcript.
 */
function Compacted(): ReactElement {
  return (
    <p
      className="chat__folded"
      title="The agent summarised everything above this line and dropped the detail. What it remembers of that part is the summary."
    >
      earlier messages folded into a summary
    </p>
  );
}

/**
 * An empty transcript has three quite different reasons, and saying which one is the difference
 * between a window that looks broken and a window that is explaining itself.
 *
 * "NO RECIPE IS OPEN" IS NOT ONE OF THEM. There is one conversation, belonging to the installation
 * rather than to any record in it, so there is nothing to pick first and nothing to be missing.
 */
function Empty({ opening, failure }: { opening: boolean; failure: string | null }): ReactElement {
  if (failure !== null) {
    // Ahead of "nothing said here yet", which is the one thing this pane must not say when it does
    // not know: the conversation may hold a hundred messages that simply did not arrive.
    return (
      <div className="empty chat__empty">
        <p>The conversation did not load.</p>
        <p>{failure}</p>
        <button type="button" className="btn btn--ghost" onClick={() => void refreshTranscript()}>
          Try again
        </button>
      </div>
    );
  }
  if (opening) {
    return (
      <div className="empty chat__empty">
        <span className="chat__spinner" />
        <p>Opening the conversation…</p>
      </div>
    );
  }
  /*
   * It loaded, and nothing has been said — so the panel asks rather than reports. One large quiet
   * sentence in the middle of the space, and one small one under it.
   *
   * IT NAMES NO RECORD. "What should we research in <name>?" would need a conversation that
   * belonged to one; this one belongs to the installation, so the question is the same every
   * time, which is exactly why it is short.
   *
   * THE SECOND LINE IS THE ONE THING A FRESH INSTALLATION CANNOT GUESS. Nothing in this window
   * writes to the database: a recipe, a source, a thesis and a script are all set up by asking
   * here, and a reader looking at an empty archive with no chat history has no other way to find
   * that out — the `+` buttons say it in a tooltip nobody hovers before their first sentence. It is
   * still not teaching the DRAG, which the composer's own placeholder says directly underneath.
   */
  return (
    <div className="chat__welcome">
      <p className="chat__welcome-line">What should we research?</p>
      <p className="chat__welcome-note">
        Recipes, sources, theses and scripts are all set up by asking here.
      </p>
    </div>
  );
}
