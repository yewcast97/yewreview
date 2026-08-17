/**
 * The composer: a context strip, a row of record chips, one growing textarea, one round button that
 * sends or stops — a card floating above the floor of the panel rather than a strip bolted to it.
 *
 * THE CONTEXT STRIP HOLDS THREE CONTROLS, and it took an argument to put the first of them there. A
 * caption — muted type, nothing clickable — would follow the rule that what a strip says is not
 * changed from a composer, because dressing a fact as a control offers an action that does not
 * exist. The rule stands, and the action exists three times over: which model answers, how hard it
 * is asked to work, and whether it may split the work across agents of its own are all things a
 * reader decides, they decide them while looking at the box they are about to type into, and the
 * strip is where all three facts are already being read. A control anywhere else would be a setting;
 * here each is a caption that is honest about being a choice.
 *
 * THE THREE ARE ONE QUESTION ASKED THREE TIMES — how should this be answered — which is why they sit
 * beside each other under one glyph rather than one here and the others behind a menu, and why they
 * share a gate: none is drawn until the agent has said what this installation can reach, because a
 * control that can never be enabled is worse than none. What does NOT belong beside them is the pair
 * that reads as though it should. The recipe a conversation is working to would be a fact about a
 * BINDING that does not exist: there is one
 * agent, belonging to the installation rather than to any record in it, so there is no recipe to
 * name here, and a recipe reaches the agent inside a generation turn — a procedure, rather than a
 * property of the box somebody is typing into.
 *
 * ALL THREE DISABLE THEMSELVES WHILE THE AGENT IS WORKING, on one condition, and the server refuses
 * every one of the changes for the same kind of reason — a model swapped under a turn in flight
 * leaves one answer written half by each of them, a level swapped under one leaves an answer thought
 * about half at each, and delegation cannot be switched at all without ending the session the answer
 * is being written into. Saying so on the control rather than only in a refusal is the difference
 * between a reader learning the rule and a reader watching a control snap back.
 *
 * THERE IS NO ATTACH BUTTON beside the box, and that is a decision rather than an omission. Every
 * thing a message can carry arrives by a gesture already in the reader's hands — a record DRAGGED
 * from a row's grip or from a card on the board, a file dragged from wherever the reader keeps
 * their files, an image PASTED from the clipboard — and a "+" would have to open either nothing or
 * a picker this window does not have. A control that opens nothing is worse than no control: it
 * teaches the reader that the thing they wanted is missing rather than that it is somewhere else,
 * and the placeholder in the box already says where.
 *
 * PASTE IS THE THIRD DOOR INTO `attachFiles` and it is the one that matters most in practice: what
 * a reader has to hand when they want to show the agent something is a screenshot, which lives on
 * the clipboard and never on the disk. `onPaste` asks the same question the drop handlers ask,
 * cancels the default only after the answer is yes, and hands the bytes to the same upload — see
 * the handler, and `named` above it on why a file the clipboard calls `image.png` is renamed.
 *
 * THE BUTTON IS ONE CONTROL, not two side by side. While a turn is running the only useful thing to
 * do with it is stop, and a send button that sat there disabled next to a stop button would be
 * telling the reader about a state rather than offering them an action.
 *
 * IT IS A DROP TARGET FOR EXACTLY TWO KINDS OF DRAG, and that narrowness is the whole safety
 * property of this file. `dragover` and `drop` ask `dataTransfer.types` one question — what is this
 * carrying? — and the three answers are not variations of each other:
 *
 *   - A RECORD: `preventDefault`, and it becomes a CHIP above the box. Taking the drop over is what
 *     buys the chip, and the chip is worth it: a record is a thing with a name, and it should land as
 *     something the reader can see, open, and take back out with an × — not as a line of grammar
 *     spliced into the middle of a sentence they are still writing, where removing it means editing
 *     prose.
 *   - FILES: `preventDefault`, and each one is uploaded into the agent's home and chipped the same
 *     way — see `attachFiles` in the store and `server/uploads.ts` for why the bytes go to disk
 *     rather than onto the wire. Left alone, a file dropped on a textarea does nothing in one
 *     browser and navigates away from the whole window in another, and the second of those loses
 *     whatever was being written.
 *   - NEITHER: NOTHING AT ALL. No `preventDefault`, no state, no early return worth the name. A
 *     paragraph dragged from another window, a URL from the address bar, a selection from the
 *     transcript above: every one of those lands in the textarea natively, at the caret the user
 *     aimed at, with the browser's own undo entry and a real `input` event behind it. A handler that
 *     cancelled the default would owe all of that back, and would pay it back badly.
 *
 * A drag that somehow carried both is read as a RECORD, decided once in `classifyDrag` rather than
 * by whichever branch happened to be written first — see the note there.
 *
 * The ORDER inside each handler carries the same weight as the test. `preventDefault` is called only
 * after the answer has come back yes. A handler written the other way round — cancel first, decide
 * afterwards — would break the plain-text drop for every drag in the window, and would break it
 * silently, because a text drop that does nothing looks exactly like a drag that missed.
 *
 * A record drag still carries its mention as `text/plain` as well (see `lib/recordDrag.ts`), which is
 * what keeps a row draggable into anything else — another app, a field this app does not own. This
 * composer is simply the one place that recognises the richer payload and does something better with
 * it.
 *
 * THE TEXT AND THE CHIPS BOTH LIVE IN THE STORE, not in this component. That is what lets an upload
 * settling in the store put its chip in the composer without this component knowing a request was in
 * flight, and it is why a `busy` refusal — which hands back words that never entered the server's
 * queue — puts them back with nothing here watching for them to appear.
 */

import { useLayoutEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactElement } from "react";

import type { ComposerChip } from "../lib/outgoing.ts";
import { chipKey } from "../lib/outgoing.ts";
import type { EffortLevel, ModelOption } from "../lib/protocol.ts";
import { EFFORT_LEVELS, isEffortLevel } from "../lib/protocol.ts";
import type { PickerOption } from "./Picker.tsx";
import { Picker } from "./Picker.tsx";
import { RoleSlots } from "./RoleSlots.tsx";
import { agentWorking, isTurnActive } from "../state/chat.ts";
import {
  addComposerChip,
  attachFiles,
  changeEffort,
  changeModel,
  changeSubagents,
  clearChatError,
  interrupt,
  removeComposerChip,
  sendMessage,
  setComposerDraft,
  toggleModelPool,
  useChat,
  useComposer,
  useComposerChips,
  useConnection,
  useGeneration,
  useHealth,
  useOpencode,
  viewRecord,
} from "../state/store.ts";
import { MENTION_MIME, classifyDrag, readDragPayload } from "../lib/dragPayload.ts";

/** Roughly eight lines. Past that the box scrolls: a composer that keeps growing eats the
 * conversation it is about. */
const MAX_HEIGHT_PX = 180;

/**
 * A pasted file, under a name a reader can tell from the next one.
 *
 * EVERY BROWSER CALLS A PASTED SCREENSHOT `image.png`, and it is the only name the clipboard offers
 * — there was no file on disk for it to be named after. Two screenshots pasted into one message
 * would be two chips reading identically and two `Attached file:` lines the reader cannot tell
 * apart when the agent answers about one of them. Nothing is at risk if they collide: the chips are
 * keyed on their own token (`chipKey`) and the server files every upload under a fresh directory,
 * so this is legibility and nothing else.
 *
 * ONLY THAT ONE SHAPE IS RENAMED. A file copied from Finder arrives with the name somebody gave it,
 * and replacing that would be the window throwing away the most useful thing it was handed.
 */
function named(file: File, index: number): File {
  const generic = /^image\.[a-z0-9]+$/i.exec(file.name);
  if (generic === null) return file;
  const ext = file.name.slice(file.name.lastIndexOf("."));
  // Seconds resolution plus the position within this paste: the pair is unique for as long as it
  // needs to be, which is the one message being assembled.
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(/[^0-9]/g, "");
  return new File([file], `pasted-${stamp}-${String(index + 1)}${ext}`, { type: file.type });
}

/**
 * The five levels as the menu offers them: the SDK's own words, weakest first, and BARE.
 *
 * This window has no better name for `xhigh` than `xhigh`, and inventing one would be a vocabulary
 * the agent's refusals do not share. Nor does any row carry the word "effort": that word is the
 * noun the whole control is, so five rows repeating it would be a menu answering a question the
 * menu is. What the level MEANS in a sentence is on the control's title, which is where the reader
 * asks for a sentence.
 *
 * Built once at module scope because it is the same five rows in every conversation.
 */
const EFFORT_OPTIONS: readonly PickerOption[] = EFFORT_LEVELS.map((level) => ({
  value: level,
  label: level,
}));

export function Composer(): ReactElement {
  const chat = useChat();
  const connection = useConnection();
  const text = useComposer();
  const chips = useComposerChips();

  const [dragging, setDragging] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  // How many pills the last commit drew, which is the only thing that tells a chip ARRIVING from one
  // taken back out. A ref and not state: nothing renders from it, and a re-render for a number only
  // the effect below reads would be a render for nobody.
  const drawn = useRef(0);

  const active = isTurnActive(chat);
  // A procedure is a turn like any other as far as these controls are concerned, so its slice is
  // read up here where the booleans are built.
  const generation = useGeneration();
  // ONE TURN AT A TIME: the whole of what the agent is doing, as `agentWorking` states it — a turn
  // being written, a message on its way to one, or a generation procedure. What it gates below is
  // SENDING; the button swap stays on `active` alone, because in the pending window before
  // `turn_started` a Stop button would be a lie (interrupt does not drop a turn already offered).
  const working = agentWorking(chat, generation);
  // `awaiting_ready` counts as connected: a frame sent then waits in the server's receive buffer and
  // is read the moment the connection's receiver starts.
  const connected = connection === "ready" || connection === "awaiting_ready";
  // Chips alone are a message. "Look at these" is a real thing to say when the agent can see what is
  // being pointed at, and a send button dimmed over a row of records the reader has just assembled
  // would be refusing the gesture it invited.
  const said = text.trim() !== "" || chips.length > 0;
  // A file whose bytes have not reached the server yet. The message would name a path that does not
  // exist, so the button waits — and says so, because a send button that is dim for a reason the
  // reader cannot see is the puzzle every other control in this window avoids.
  const uploading = chips.some((chip) => chip.kind === "file" && chip.path === null);
  // THERE IS NO "IS A CONVERSATION OPEN" CLAUSE, and there is nothing for one to test. This component
  // is rendered by `ChatDock`, which is always on screen, and such a flag would be asking whether a
  // NO RECORD is bound — nothing is bound to anything. What is left is the honest set: is the
  // socket carrying, has anybody said anything, and is the agent free to be asked. `!working` is
  // also what holds the ENTER key, because `submit` early-returns on this.
  const sendable = connected && said && !uploading && !working;
  const error = chat.lastError;
  // What the strip says about the agent, in the header chip's own words:
  // a socket that is ready before its `ready` frame has been parsed is a window of a few
  // milliseconds, and "connected" is the honest thing to say in it. While the connection is not
  // ready the model is named only if a `ready` frame in this session already said it — the panel
  // header is what reports the connecting, and a strip that went blank and back would flicker under
  // every reconnect.
  const model = connection === "ready" ? (chat.model ?? "connected") : chat.model;
  // The agent refuses a model change while it is working, so the picker says so before the round
  // trip — on the same predicate the send gate reads, which also covers the pending window the old
  // `!active && generation === null` pair missed.
  const switchable = connected && !working && chat.models.length > 0;
  /*
   * WHICH HARNESS IS ANSWERING, which two of the controls below turn on.
   *
   * It comes from `/api/health` rather than from the `ready` frame, and that is the right authority:
   * the harness is a fact about how this process was STARTED — named at the command line and never
   * defaulted — rather than about the conversation in progress, and the same answer carries whether
   * the socket is up.
   *
   * Null while the first health read is in flight, which draws the Claude chrome for a moment. That
   * is the honest default rather than a guess: what it withholds for one round trip is two controls
   * that only one harness has, and what the alternative would withhold is the composer.
   */
  const opencode = useHealth()?.harness === "opencode";
  // Read for one thing on this line — whether the pool is up, which is what the word below reports
  // through `aria-expanded`. The slots underneath read the same slice for themselves.
  const poolOpen = useOpencode().poolOpen;

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    // Collapsed first, because `scrollHeight` measures the content against the CURRENT height and a
    // box that has already grown would never measure its way back down.
    area.style.height = "auto";
    // AND ONE PIXEL BACK, because `scrollHeight` is a rounded integer and the line it is rounding is
    // not: a 14px line at 1.6 is 22.398, so one line and its padding stand 30.398 tall and report
    // 30. Written back as the height that leaves four tenths of a pixel of real, unreachable
    // overflow under EVERY composer, including an empty one — invisible for as long as the window's
    // scrollbars were invisible, and then a full ten-pixel gutter and a thumb on an empty box the
    // moment they started taking layout width (see `styles/base.css`). Half a pixel is the most the
    // rounding can hide, so one is always enough and never two.
    area.style.height = `${Math.min(area.scrollHeight + 1, MAX_HEIGHT_PX)}px`;
  }, [text]);

  /*
   * KEEP THE NEWEST CHIP IN VIEW — the other half of the cap in `.chat__chips`, and the half that was
   * missing. The row wraps to three lines and then scrolls, for the reason stated there, but no
   * browser scrolls a container to something appended to it: a fourth line landed in the DOM below
   * the fold of a box whose three lines fit it exactly, so there was not even a cut-off pill to say
   * more was there. A paste of ten screenshots drew the three lines that fit and looked like it had
   * dropped the rest — the one thing a composer that has already taken the bytes must never look
   * like it did.
   *
   * ONLY WHEN THE ROW GREW. Taking a chip back out changes the length too, and pulling the row to its
   * bottom under the × somebody just clicked would slide the next × out from under the cursor aimed
   * at it.
   *
   * `scrollTop` on the row rather than `scrollIntoView` on the last pill, which is free to scroll
   * every scrollable ancestor along with it. This row's business is this row.
   */
  useLayoutEffect(() => {
    const row = chipsRef.current;
    const grew = chips.length > drawn.current;
    drawn.current = chips.length;
    if (row === null || !grew) return;
    row.scrollTop = row.scrollHeight;
  }, [chips.length]);

  const submit = (): void => {
    if (!sendable) return;
    // The store serializes the chips and the words into one message, empties both when the frame
    // reached the wire, and leaves both alone when it did not: a message that never left is still
    // something somebody assembled.
    sendMessage(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) return;
    // An input method's Enter commits the candidate it is showing. Sending on it would post a
    // half-typed word and swallow the keystroke that was finishing it.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  /**
   * What this drag is carrying.
   *
   * `types` and never `getData`, because a browser answers `getData` with the empty string during a
   * drag — the payload is readable only on the drop — and the decision about `preventDefault` has to
   * be made on `dragover`, long before then. The same is true of `dataTransfer.files`, which is
   * empty until the drop: `"Files"` being in `types` is the only thing there is to go on.
   */
  const carrying = (event: DragEvent<HTMLElement>): "record" | "session" | "files" | "none" =>
    classifyDrag(event.dataTransfer.types);

  const onDragOver = (event: DragEvent<HTMLElement>): void => {
    setDragging(true);
    // The one line that decides everything. Nothing this composer takes: return, and the textarea's
    // own drop does the work — see this file's header.
    //
    // A CONVERSATION IS NOTHING THIS COMPOSER TAKES, and it is left alone here rather than refused
    // on the drop. There is no `@session:…` to make a chip out of; a handler that called
    // `preventDefault` for one would light the highlight, promise a drop, and then do nothing with
    // it. The Bin is the only target for a conversation, and it says so by being the only one that
    // lights up.
    const kind = carrying(event);
    if (kind === "none" || kind === "session") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    // A `dragleave` also fires crossing from the card into the textarea or a chip inside it. Clearing
    // on those would strobe the highlight off and on under a drag that never left the composer.
    const entered = event.relatedTarget;
    if (entered instanceof Node && event.currentTarget.contains(entered)) return;
    setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    setDragging(false);
    const kind = carrying(event);
    if (kind === "none" || kind === "session") return;
    event.preventDefault();
    // One branch or the other and never both: a drag carrying a record is read as a record even if
    // it somehow also carries files, so one gesture cannot produce a chip AND an upload.
    if (kind === "record") {
      const chip = readDragPayload(event.dataTransfer.getData(MENTION_MIME));
      if (chip !== null) addComposerChip(chip);
      return;
    }
    // `Array.from` rather than an index walk: a `FileList` is not an array, and indexing one under
    // `noUncheckedIndexedAccess` is a `File | undefined` for no reason.
    attachFiles(Array.from(event.dataTransfer.files));
  };

  /**
   * A PASTE CARRYING FILES, which in practice means a screenshot.
   *
   * The same three-way question the drop handlers ask, with the same ordering rule and the same
   * answer for the third case: files are taken over, everything else is left entirely alone. A
   * paste with no files in it is prose, a url, a snippet of the transcript — all of which the
   * textarea inserts natively at the caret with a real `input` event and the browser's own undo
   * entry behind it, and a handler that cancelled the default would owe all of that back.
   *
   * `clipboardData.files` and not `items`, because it answers the only question being asked and
   * answers it on the paste itself rather than during a drag — the reason `carrying` above has to
   * settle for `types` does not apply here. A clipboard carrying an image AND its own markup reads
   * as files, which is the same precedence `classifyDrag` states for a drag carrying both.
   *
   * On the well rather than on the textarea, beside the drop handlers it mirrors: a paste fired
   * anywhere inside the composer — the box, a chip, the padding — is the same gesture, and it
   * bubbles to here from all three.
   */
  const onPaste = (event: ClipboardEvent<HTMLElement>): void => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    // Only now: a default cancelled before the answer came back would break every text paste in the
    // window, and would break it silently.
    event.preventDefault();
    attachFiles(files.map(named));
  };

  return (
    <div className="chat__dock">
      {error === null ? null : (
        <div className="chat__error" role="status">
          <span className="chat__error-text">{error.message}</span>
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Dismiss this message"
            onClick={clearChatError}
          >
            ×
          </button>
        </div>
      )}

      {/* Who is answering, how hard they are being asked to think, and whether they may bring help,
          on the line above the box — read here rather than in the panel header because this is where
          somebody is deciding what to say, and now chosen here for the same reason. Every control in
          the strip is styled to sit in the caption rather than to announce itself: they are facts
          that happen to be changeable, not a toolbar. */}
      {model === null ? null : (
        <div className="chat__context">
          <span className="chat__context-item">
            <Glyph />
            {chat.models.length === 0 ? (
              <span className="chat__context-text">{model}</span>
            ) : (
              <Picker
                className="chat__model"
                value={chat.model ?? ""}
                options={modelOptions(chat.model, chat.models)}
                disabled={!switchable}
                ariaLabel="Which model answers this conversation"
                title={modelTitle(connected, active || generation !== null, chat.model)}
                onChange={changeModel}
              />
            )}
          </span>

          {/* How hard, beside who. Gated on the same emptiness the model picker is: with no list
              from the agent nothing about this conversation can be switched — `switchable` says so
              — and a control drawn permanently dim is a promise the window cannot keep. The gate is
              also what makes the empty value below unreachable: `models` and `effort` ride on the
              same `ready` frame, so a strip that has a list to offer has a level to show.

              AND NOT AT ALL ON THE OPENCODE HARNESS, which is a stronger statement than dimming it.
              That harness has no effort dial: how hard a model thinks is a property of the model and
              the provider it is reached through, chosen in the pool rather than per conversation,
              and its `set_effort` refuses outright in exactly those words. A control that could
              never be honoured is worse than an absent one — it offers something that is not there,
              and the reader finds out by pressing it. */}
          {chat.models.length === 0 || opencode ? null : (
            <span className="chat__context-item">
              <Picker
                className="chat__effort"
                value={chat.effort ?? ""}
                options={EFFORT_OPTIONS}
                disabled={!switchable}
                ariaLabel="How hard the model works on this conversation"
                title={effortTitle(connected, active || generation !== null, chat.effort)}
                onChange={(chosen) => {
                  // The picker answers with a `string` however narrow its options were, and the
                  // frame this ends up in is typed on the union. Narrowing HERE is what keeps the
                  // send from being a cast: a value that is not one of the five is a DOM this
                  // window does not recognise, and nothing is the honest thing to do about it.
                  if (isEffortLevel(chosen)) changeEffort(chosen);
                }}
              />
            </span>
          )}

          {/* Whether the agent may hand parts of the work to agents of its own, behind the same gate
              as the level beside it and disabled by the same `switchable`. It is a TOGGLE rather
              than a picker because it is one fact with two states, and `aria-pressed` is what says
              which of them is current: a button that changed only its own styling would be a
              control whose state only a sighted reader could read.

              THE AGENT REFUSES THIS ONE HARDER THAN THE OTHER TWO, and the title says so. Honouring
              it ends the session and reopens the same conversation, so it cannot happen under a turn
              at all — where a model or a level swapped mid-turn is merely a bad idea, this would
              abandon the answer being written.

              AND NOT AT ALL ON THE OPENCODE HARNESS, for the reason the level beside it is absent
              there — stated again because the failure mode here was different and worse. That
              harness delegates through ROLES, configured in the model pool a word to the right of
              this one, so `set_subagents` refuses the off state outright and reports the on state as
              already true. Drawn, the toggle was a control that could be pressed and never
              un-pressed: the refusal arrived as a toast and the next `ready` frame put the button
              straight back down. A control that always springs back teaches the reader that the
              window is broken rather than that the setting lives somewhere else. */}
          {chat.models.length === 0 || opencode ? null : (
            <span className="chat__context-item">
              <button
                type="button"
                className="chat__subagents"
                aria-pressed={chat.subagents}
                disabled={!switchable}
                title={subagentsTitle(connected, active || generation !== null, chat.subagents)}
                onClick={() => changeSubagents(!chat.subagents)}
              >
                subagents
              </button>
            </span>
          )}

          {/*
           * WHERE THE MODELS COME FROM, on the harness where that is a question.
           *
           * The three controls to its left are all "how should this conversation be answered"; this
           * one is a door rather than an answer, and it is here anyway because what is behind it is
           * the list the picker on the far left is drawn from. On the Claude path there is nothing
           * to open — the models are whatever the CLI beside it can reach — so the word is absent
           * rather than dim.
           *
           * A WORD IN THE CAPTION, on the `subagents` pattern down to the class it borrows its shape
           * from: same face, same ink, same hover, because it is one more changeable thing in a line
           * of them and a bordered button would break the line into a word, a word, and a control.
           * `aria-expanded` is what says the pool is up — the styling says it too, but a state only
           * a sighted reader can read is half a control.
           *
           * NOT DISABLED WHILE THE AGENT WORKS, unlike its three neighbours. Opening a panel is not
           * a change to a turn in flight; the SAVE inside it is what the route refuses, in a
           * sentence, and refusing to let somebody look at their own credentials because a model is
           * mid-sentence would be a gate with nothing behind it.
           */}
          {!opencode ? null : (
            <span className="chat__context-item">
              <button
                type="button"
                className="chat__models"
                aria-expanded={poolOpen}
                title={
                  poolOpen
                    ? "Put the model pool away"
                    : "Open the model pool — the models this installation can reach, and which one answers in which role"
                }
                onClick={toggleModelPool}
              >
                models
              </button>
            </span>
          )}
        </div>
      )}

      {/* The role slots, on the line between the caption and the box: which model answers as
          `build`, as `plan`, and as each of the agents opencode delegates to. Drawn here rather than
          in the pool because it is read in the same moment the caption above it is — this is where
          somebody decides what to say — and because the notes in the pool are dragged DOWN onto it.
          It draws nothing at all until the server has said what the roles are. */}
      {!opencode ? null : <RoleSlots />}

      <div
        className={dragging ? "chat__composer chat__composer--drop" : "chat__composer"}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPaste={onPaste}
      >
        {chips.length === 0 ? null : (
          <div className="chat__chips" ref={chipsRef}>
            {chips.map((chip, index) => (
              <span
                className={
                  chip.kind === "file" && chip.path === null
                    ? "chip chat__chip chat__chip--pending"
                    : "chip chat__chip"
                }
                key={chipKey(chip)}
              >
                {/* A record chip opens the row it names; a FILE chip is drawn as a plain span,
                    because it names no row — it is a thing on disk in the agent's home, and this
                    window has nothing to show it in. */}
                {chip.kind === "record" ? (
                  <button
                    type="button"
                    className="chat__chip-open"
                    title={`Open this ${chip.table} in the record panel`}
                    onClick={() => viewRecord(chip.table, chip.id, chip.name)}
                  >
                    <span className="chat__chip-label">{chip.name}</span>
                    <span className="chat__chip-hint">{hintFor(chip)}</span>
                  </button>
                ) : (
                  <span className="chat__chip-open chat__chip-open--flat">
                    <span className="chat__chip-label">{chip.name}</span>
                    <span className="chat__chip-hint">{hintFor(chip)}</span>
                  </span>
                )}
                <button
                  type="button"
                  className="chat__chip-remove"
                  aria-label={`Do not send ${chip.name} with this message`}
                  title="Take this back out"
                  onClick={() => removeComposerChip(index)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="chat__entry">
          <textarea
            ref={areaRef}
            className="chat__area"
            rows={1}
            value={text}
            aria-label="Message the agent"
            // Never disabled. The box was greyed out while no record was bound; there is nothing to
            // bind now, and a composer that refused typing while the socket reconnected would lose a
            // sentence somebody was in the middle of. What is typed while nothing is listening simply
            // waits, and the send button says why it cannot go.
            placeholder="Ask for research, or drag a record in…"
            onChange={(event) => setComposerDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {active ? (
            <button
              type="button"
              className="chat__send"
              onClick={interrupt}
              disabled={!connected}
              aria-label="Stop the agent"
              title={connected ? "Stop the agent" : "Not connected"}
            >
              <span className="chat__stop-mark" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="chat__send"
              onClick={submit}
              disabled={!sendable}
              aria-label="Send"
              title={sendTitle(connected, said, uploading, working)}
            >
              <span aria-hidden="true">↑</span>
            </button>
          )}
        </div>
      </div>

      <div className="chat__foot">
        <span>Enter sends · Shift+Enter starts a line</span>
      </div>
    </div>
  );
}

/**
 * The context strip's icon, drawn rather than typed.
 *
 * The marks this window uses elsewhere — ✎, ✕, ↑, × — are characters every system ships. A four-point
 * star is not: the code points that come closest arrive as a colour emoji on one machine, a blank box
 * on the next, and at a different weight from the text beside them on the third. Twelve pixels of
 * `currentColor` is three lines of markup and none of that.
 *
 * IT TAKES NO `kind`, AND IT IS DRAWN ONCE — at the head of the strip rather than beside each item.
 * The controls there are one question asked three times, so a second star between any of them would
 * read as a second subject rather than as punctuation. And there is nothing for a `kind` to select
 * between: a
 * folder for the recipe a conversation is working to would
 * both be drawings of a binding that does not exist. There is no parameter kept "in case" — a switch
 * with one arm is a promise that a second is coming.
 *
 * Decorative, and marked so: it sits beside the word it illustrates, so a reader who cannot see it
 * loses nothing.
 */
function Glyph(): ReactElement {
  return (
    <svg className="chat__context-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M6 1.4 7.1 4.9 10.6 6 7.1 7.1 6 10.6 4.9 7.1 1.4 6 4.9 4.9Z" />
    </svg>
  );
}

/** What the chip is, under what it is called: the table, and the field when the chip is one field of
 * a row. Two records can share a label — a `script_invocation` and the `series_preparation` that ran
 * the same program with the same argument are drawn identically — and this is the line that says
 * which of them is about to be sent. */
function hintFor(chip: ComposerChip): string {
  // The pending state is the hint, because it is the only thing about this chip that will change and
  // the only thing holding the message up.
  if (chip.kind === "file") return chip.path === null ? "uploading…" : "file";
  return chip.column === undefined ? chip.table : `${chip.table}.${chip.column}`;
}

/**
 * The rows the model picker offers: what the agent said this installation can reach, under the names
 * it gave them.
 *
 * THE CURRENT MODEL COMES FIRST WHEN THE LIST NAMES IT NO OTHER WAY, and that stray row is the whole
 * reason this is a function rather than a `map` in the markup. Two situations reach it: a
 * conversation resumed against an installation whose CLI has since changed what it offers, and the
 * ordinary one where the CLI spells its rows as aliases — `default`, `opus[1m]` — none of which is
 * the id this installation was configured with. A menu that quietly dropped the model would be a
 * control claiming this conversation is being answered by something else.
 *
 * It is drawn under its bare identifier because that is the only name this window has for it, minus
 * the vendor prefix, which is `label` in src/claudecode/session.ts applied on this side for the one row
 * the agent never sees. The two must agree: a menu whose other rows read `opus-5` and one row reads
 * `claude-opus-5` undoes its own tidying at the exact row the reader is looking at.
 */
function modelOptions(model: string | null, models: readonly ModelOption[]): PickerOption[] {
  const offered = models.map((option) => ({ value: option.value, label: option.displayName }));
  if (model === null || models.some((option) => option.value === model)) return offered;
  return [{ value: model, label: model.replace(/^claude[-\s]/i, "") }, ...offered];
}

/** Why the picker is disabled, on the picker. Same rule as the send button below: a control that is
 * dimmed and silent is a puzzle, and this one is dimmed for a reason the reader can act on. */
function modelTitle(connected: boolean, working: boolean, model: string | null): string {
  if (!connected) return "Not connected to the agent";
  if (working) return "The agent is working — stop it, or wait, before changing models";
  return model === null ? "Which model answers this conversation" : `Answering with ${model}`;
}

/**
 * Why the effort picker is disabled, on the picker. `modelTitle`'s twin, refusing on the same two
 * conditions and in the same order, because the control is dimmed by the same two facts.
 *
 * The unset case is the window before the first `ready` frame rather than a level nobody picked —
 * every conversation is answered at some level, and this side simply has not been told which yet.
 * Naming a level there would be a guess, and guessing at the one thing this control exists to
 * report is worse than admitting the silence.
 */
function effortTitle(connected: boolean, working: boolean, effort: EffortLevel | null): string {
  if (!connected) return "Not connected to the agent";
  if (working) return "The agent is working — stop it, or wait, before changing how hard it works";
  return effort === null
    ? "Waiting to hear how hard this conversation works"
    : `Working at ${effort} effort`;
}

/**
 * What the toggle is and why it cannot be pressed, on the toggle. The third of the strip's titles,
 * refusing on the same two conditions and in the same order as the two above.
 *
 * The two live states say what the agent DOES rather than reporting the position of a switch: "on"
 * beside a word nobody outside this window has defined is a label for a state, and what a reader
 * needs is what pressing it would change about the answer they are waiting for. The working case is
 * worded harder than its neighbours on purpose — this change ends the agent's session, so waiting is
 * not politeness here but the only way it can happen at all.
 */
function subagentsTitle(connected: boolean, working: boolean, enabled: boolean): string {
  if (!connected) return "Not connected to the agent";
  if (working) {
    return "The agent is working — changing this ends its session, so stop it or wait first";
  }
  return enabled
    ? "Splitting work across agents of its own when that is faster"
    : "Answering everything in this one conversation";
}

/** Why the button is disabled, on the button. A control that is dimmed and silent is a puzzle. */
function sendTitle(connected: boolean, said: boolean, uploading: boolean, working: boolean): string {
  if (!connected) return "Not connected to the agent";
  if (working) return "The agent is working — stop it, or wait for it to finish";
  if (!said) return "Type a message, or drag a record or a file in";
  if (uploading) return "A file is still uploading";
  return "Send (Enter)";
}
