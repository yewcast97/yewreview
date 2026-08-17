/**
 * The two ledgers: what went wrong, and what was destroyed. Two instruments, one file.
 *
 * EACH LEDGER IS ONE ELEMENT THAT EXPANDS IN PLACE, and that is what this file is arranged around.
 * A chip in the corner column plus a separate fixed viewer opening above the column would be two
 * components hanging in two places, coupled by a hard-coded clearance constant telling the viewer how
 * tall the chips are. The chip IS the panel's head:
 * pressing it grows the same element up and to the right, with its left and bottom edges pinned,
 * and pressing it again shrinks it back to the engraved word. Nothing is told how tall anything
 * else is, because nothing needs to know.
 *
 * THE DISPLACEMENT IS THE COLUMN'S, NOT THIS FILE'S. `.lcd-stack` is a fixed flex column anchored
 * to the bottom edge, so a unit growing taller pushes everything ABOVE it — the other ledger, the
 * session read-out — upward in lockstep with the column's own gap, while everything below it (the
 * status pill) is pinned by the edge the column hangs from. No JavaScript measures anything; the
 * geometry is the layout doing what a bottom-anchored column does.
 *
 * THE BODY IS ALWAYS MOUNTED, OPEN OR NOT, and that is what makes the collapse animatable at all:
 * a conditional-null viewer blinks its rows out on the first frame of a close. The reveal is a grid
 * row animated between `0fr` and `1fr` (see `Ledgers.css`), so the rows are on screen throughout
 * the shrink and the `visibility` flip at the end is what keeps a keyboard from tabbing into a
 * collapsed body.
 *
 * ONLY ONE IS OPEN AT A TIME, and that is enforced by there being one slot in the state rather than
 * by either unit policing the other: `state/logs.ts` holds `view` as a single value, so opening one
 * ledger IS closing the other, and the two units animate their halves of that fact in the same
 * frame. The column has room for both — one open at a time is the product decision that these are
 * instruments glanced at singly, not panels worked in side by side.
 *
 * EACH HEAD'S MARK WATCHES ITS OWN NONCE. A deletion must not light the Log head, or the mark stops
 * meaning anything within a minute of the agent starting work — which is exactly the argument
 * `state/logs.ts` makes for keeping the two counters apart in the first place.
 *
 * THE MAGNET IN EACH CORNER IS THE CLOSE, which is what keeps it out of each unit's dress. Trim — the
 * log in red and the bin in yellow, chosen to go with the sheet, sitting at the top centre — would be
 * right only for units with no such gesture to offer, because the top-right corner of a sticky note
 * means CLOSE on this board. They have the gesture, so the stone is in the corner and rust on
 * both: the colour is the half of that convention that carries the meaning. `GraphPanel.tsx` teaches
 * the reader "the red magnet takes a note down" once, for every note in the window, and a yellow one
 * on the Bin would be asking them to learn it twice. The head toggles too; this is the second way
 * out, and it is the one the reader already has in their hand from the board.
 *
 * NEITHER UNIT HAS A PAPER OF ITS OWN ANY MORE. Each used to name a tint — the Log pink, the Bin
 * peach — on the argument that an instrument's dress is its identity. There is one paper in the
 * window now (`styles/paper.css` argues it), and the argument does not survive the change: what
 * identifies an instrument is the word engraved on its chip, which is on screen in both states and
 * is the thing the reader presses. A colour behind it was never doing that work.
 *
 * WHY THERE ARE INSTRUMENTS FOR THESE AT ALL. Everything else this window shows is a RECORD:
 * something the agent wrote down on purpose, reachable in the graph, pointed at by other records. A
 * log row is neither. `error_log` and `deletion_log` have no foreign keys and nothing in the archive
 * points at them, which is exactly what lets them outlive the things they describe — the whole value
 * of a deletion ledger is that the record it is about is gone. So they cannot be browsed the way
 * records are, and they get instruments in the corner instead.
 *
 * THE ERROR MESSAGE IS DRAWN VERBATIM, and this is the one place in the window where that rule is
 * absolute rather than merely house style. Somebody who opens that panel is trying to find out what
 * the machine said. A paraphrase is the single thing that cannot help them, and a friendlier wording
 * would be this window inventing a sentence the server never wrote.
 *
 * DELETIONS ARE GROUPED BY TABLE and errors are not, and the asymmetry is about how each is read. An
 * error is one event with a scope on it, and the scope is a chip on the row. A deletion is almost
 * never alone: the agent deleting a thesis takes its assessments with it, and twenty amber rows in
 * three tables scroll past as an undifferentiated wall. Grouped, the same twenty rows read as "a
 * thesis, its assessments, its targets", which is what actually happened. `groupDeletions` does the
 * walk; see its header for why the group order falls out of it rather than being sorted for.
 *
 * THE WHOLE DELETED ROW IS BEHIND A DISCLOSURE, and it is JSON on purpose. A record that no longer
 * exists cannot be linked to and must not be summarised — a summary would be somebody's opinion about
 * which columns mattered, decided before anybody knew what the row would be needed for. So the ledger
 * stores the row entire and this draws it entire, pretty-printed, closed. What is drawn OUTSIDE the
 * disclosure is the row's `name` out of that same JSON — what the record was called
 * while it lived — rather than the uuid it was keyed by, which is the same length and shape for every
 * row in the database and recognisable to nobody.
 *
 * ── THE BIN IS ALSO A PLACE YOU CAN PUT THINGS ────────────────────────────────────────────────────
 *
 * IT WRITES NOTHING TO THE DATABASE, AND IT IS STILL WHERE DELETING STARTS. Dropping a record here
 * SAYS SO IN THE CONVERSATION — "I dragged this to the bin, tell me what would go with it, and
 * delete it if nothing is in the way" — and the agent answers with the four reports published under
 * that recipe before anything is gone. The sentence is `lib/awareness.ts`'s and the
 * store's `dropOnBin` is what sends it.
 *
 * A CONVERSATION IS THE ONE THING IT DELETES OUTRIGHT, and the exception is exactly as wide as the
 * reason for it. A transcript is not a record: nothing in the archive points at one, no report was
 * written from it, there is no cascade to enumerate — and the agent could not answer a question
 * about it anyway, because the store belongs to the harness rather than to the database it reads. So
 * there is nothing for a question to be about, and `dropSessionOnBin` calls the route directly. The
 * live conversation is not draggable, and the server refuses it besides.
 *
 * WHICH IS WHY THE DROP IS STILL WORTH HAVING RATHER THAN JUST TYPING IT. The gesture names a
 * specific row without the reader spelling a mention, it is the one gesture in the window that means
 * "this, gone", and it puts every deletion in ONE place — so what the reader learns is "things go in
 * the Bin" rather than "some tables have a button somewhere in their form". No record card carries a
 * Delete button, and none ever did: a Delete inside the thing it destroys is on screen the whole
 * time somebody is reading or auditing, one mis-aimed click from whatever sits beside it.
 *
 * NOTHING ASKS BEFORE THE DROP. A confirmation dialog was the gesture's second half while letting go
 * destroyed a row — a drag is easy to make by accident in a way a button press is not. Letting go
 * asks a QUESTION now, in the place where the answer arrives with the count of what would go with
 * it, so a drop made by mistake is a sentence the reader answers "no" to.
 *
 * A CONVERSATION HAS NO SUCH SECOND HALF, and it gets no dialog either. There is nothing for the
 * agent to say first, so a confirmation here would be a bare "are you sure" — the weakest form of
 * the thing this window replaced, and one that trains people to click through it. What stands in its
 * place is that the gesture is deliberate, the live conversation cannot be dragged at all, and the
 * toast names what went.
 *
 * IT CATCHES BOTH KINDS OF DRAG, AND THEY ARE GENUINELY DIFFERENT MECHANISMS. A record ROW — from a
 * node on the graph, from an edge list, from a row inside a note — travels by the browser's own
 * drag-and-drop and lands in the handlers below. A whole NOTE travels by captured pointer, which
 * fires no drop events on anything, so `NoteBoard.tsx` hit-tests this section's rectangle itself and
 * calls the same `dropOnBin`. One highlight for both, which is why `binHot` is in the store rather
 * than in this component's state.
 *
 * THE HIGHLIGHT IS NOT A PROMISE THAT ANYTHING WILL BE DELETED. It says the Bin has caught what is
 * over it; what happens next is a conversation, and the rules about what may be deleted are the
 * repository's — a source a published report cites cannot go, and the refusal says so with the
 * count. Pre-empting that here would mean this window holding a copy of rules it does not own.
 */

import { useEffect, useRef, useState, type DragEvent, type ReactElement } from "react";

import {
  MENTION_MIME,
  SESSION_MIME,
  classifyDrag,
  readDragPayload,
  readSessionDrag,
} from "../lib/dragPayload.ts";
import type { DeletionLogEntry, ErrorLogEntry } from "../lib/protocol.ts";
import { formatAbsolute, formatRelative, useTicker } from "../lib/time.ts";
import type { LogCategory, LogPage } from "../state/logs.ts";
import { deletedName, groupDeletions } from "../state/logs.ts";
import {
  closeLogViewer,
  dropOnBin,
  dropSessionOnBin,
  logsShowMore,
  openLogViewer,
  setBinHot,
  useBinHot,
  useLogs,
} from "../state/store.ts";
import { forgetBinElement, registerBinElement } from "./binTarget.ts";
import "./lcd.css";
import "../styles/chalk.css";
import "../styles/paper.css";
import "./Ledgers.css";

/** A minute is the finest thing `formatRelative` distinguishes. Both ledgers tick from this one
 * timer rather than one per row — see the note on `useTicker`. */
const STAMP_INTERVAL_MS = 60_000;

/**
 * One ledger: an engraved head that is also the toggle, and the body it reveals.
 *
 * THE MARK IS COMPUTED FROM ONE NONCE AND FROM NOTHING ELSE, which is what `state/logs.ts` keeps two
 * of them for: `error_logged` and `deletion_logged` are bodyless pokes, so the only thing a window
 * with both ledgers closed knows is that a counter went up. It deliberately does not fetch to find
 * out how many — the agent writes to both ledgers all day, and a closed panel holding a thousand
 * rows nobody is reading is the thing the nonce exists to avoid. (The ROWS being mounted while
 * closed is different: they are whatever the last open read, kept for the collapse animation, not
 * refetched — the store refreshes a ledger only while `view` names it.)
 *
 * WHAT COUNTS AS "SEEN" IS THE NONCE AT THE MOMENT THIS LEDGER WAS LAST OPEN, held here rather than
 * in the store because it is a fact about this tab's reader: two windows onto the same installation
 * have genuinely seen different amounts, and a shared answer would clear one reader's mark because
 * the other one looked.
 */
/** What the Bin adds to a ledger unit: whether it is currently catching something, and the three
 * handlers that decide. Optional, and only one of the two units passes it — the Log is a read-out
 * and there is nothing a reader could sensibly drop on it. */
type CatchProps = {
  hot: boolean;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
};

function LedgerUnit({
  category,
  label,
  freshTitle,
  idleTitle,
  deckle,
  seed,
  catching,
  children,
}: {
  category: LogCategory;
  label: string;
  freshTitle: string;
  idleTitle: string;
  /** Which torn edge this instrument's sheet has. Fixed per unit rather than hashed — there are two
   * of them and they are on screen together, so the variety is chosen once here instead of being
   * derived from a key. It is all that is left of a unit's dress; see the header. */
  deckle: number;
  /** Which chalkbox seed the closed chip wobbles with, so the corner's chips do not repeat one
   * wobble up the column. */
  seed: number;
  /** Present on the one unit that is a destination as well as a read-out. */
  catching?: CatchProps;
  children: ReactElement;
}): ReactElement {
  const logs = useLogs();
  useTicker(STAMP_INTERVAL_MS);
  const nonce = category === "errors" ? logs.errorsNonce : logs.deletionsNonce;
  const open = logs.view === category;
  const [seen, setSeen] = useState(nonce);
  const section = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Guarded rather than written every time: an unguarded `setSeen` would replace the value on
    // every render while the ledger is open, and the effect would schedule another.
    if (seen === nonce) return;
    setSeen(nonce);
  }, [open, nonce, seen]);

  /*
   * The one unit that can be dropped on publishes its element, so a note being dragged by a captured
   * pointer can find out where it is — see `binTarget.ts` for why a rectangle cannot simply be
   * discovered from a `drop` event in that case. The element is the SECTION rather than anything
   * inside it, so the target is the same whether the ledger is open or shut.
   */
  const isTarget = catching !== undefined;
  useEffect(() => {
    if (!isTarget) return;
    const element = section.current;
    if (element === null) return;
    registerBinElement(element);
    return () => forgetBinElement(element);
  }, [isTarget]);

  const fresh = !open && nonce > seen;

  return (
    /*
     * The `paper` class rides only while the unit is open: it remaps every token in the subtree
     * to ink-on-paper (see paper.css), and the closed chip is chalk on the slate — one element,
     * two materials, switched by the same state that runs the reveal. The chalk frame and the
     * paper sheet are both always in the DOM (the stylesheet shows one at a time), because the
     * reveal animates and layers that mounted mid-gesture would pop rather than slide.
     */
    <section
      ref={section}
      className={[
        open ? "lcd ledger paper" : "lcd ledger",
        catching?.hot === true ? "ledger--hot" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-open={open || undefined}
      data-chalk={seed}
      aria-label={label}
      // The handlers go on the SECTION and could not go on the column: `.lcd-stack` is
      // `pointer-events: none` so the gaps between the instruments pass drags through to the canvas,
      // and a drop target has to be one of the children that opts back in.
      onDragEnter={catching?.onDragOver}
      onDragOver={catching?.onDragOver}
      onDragLeave={catching?.onDragLeave}
      onDrop={catching?.onDrop}
    >
      <span className="chalk-frame ledger__chip" aria-hidden="true" />
      <span className="paper__sheet ledger__sheet" data-deckle={deckle} aria-hidden="true" />
      {/* The magnet is the CLOSE — see the header. The same rust stone on every unit, and on every
          other sheet in the window, which is why it stopped being part of each instrument's dress. */}
      <button
        type="button"
        className="ledger__close paper__magnet paper__magnet--red"
        aria-label={`Put the ${label} away`}
        title={`Put the ${label} away`}
        onClick={() => closeLogViewer()}
      />
      <button
        type="button"
        className="lcd__head ledger__head"
        aria-expanded={open}
        title={fresh ? freshTitle : idleTitle}
        onClick={() => (open ? closeLogViewer() : openLogViewer(category))}
      >
        <span>{label}</span>
        {fresh ? (
          <span className="ledger__fresh lcd__amber" aria-label={freshTitle}>
            <span aria-hidden="true">●</span>
          </span>
        ) : null}
      </button>
      <div className="ledger__reveal">
        <div className="ledger__inner">
          <div className="ledger__body scroll-y">{children}</div>
        </div>
      </div>
    </section>
  );
}

export function LogPanel(): ReactElement {
  const logs = useLogs();
  return (
    <LedgerUnit
      category="errors"
      label="Log"
      freshTitle="Something has gone wrong since you last looked"
      idleTitle="What went wrong"
      deckle={1}
      seed={1}
    >
      <Section title="Errors" page={logs.errors} category="errors" empty="nothing has gone wrong">
        {logs.errors.entries.map((entry) => (
          <ErrorRow key={entry.id} entry={entry} />
        ))}
      </Section>
    </LedgerUnit>
  );
}

export function BinPanel(): ReactElement {
  const logs = useLogs();
  const hot = useBinHot();

  /**
   * What this drag is carrying, if it is anything the Bin takes.
   *
   * `types` RATHER THAN `getData`, which is not a preference: browsers answer `getData` with `""`
   * during a drag — the payload is only readable on the drop — so a handler that asked for the data
   * would conclude every drag was empty and refuse all of them.
   *
   * TWO KINDS LAND HERE AND THEY DO OPPOSITE THINGS. A record asks a question in the conversation; a
   * conversation is deleted outright. They ride different MIMEs precisely so this decision can be
   * made from `types`, in time to say whether the drop is taken at all.
   */
  const catches = (event: DragEvent<HTMLElement>): "record" | "session" | null => {
    const kind = classifyDrag(event.dataTransfer.types);
    return kind === "record" || kind === "session" ? kind : null;
  };

  const onDragOver = (event: DragEvent<HTMLElement>): void => {
    // THE ORDER IS LOAD-BEARING: `preventDefault` only AFTER the answer is yes, because
    // preventing the default on a dragover is precisely how an element declares itself a drop
    // target. A drag carrying something else — a file, a selection, a link from another window —
    // must fall through to whatever this window does with it, which is nothing.
    if (catches(event) === null) return;
    event.preventDefault();
    // "copy" and not "move", and a mismatch here silently cancels the drop: every source in this
    // window declares `effectAllowed = "copy"` (see `dragHandlers`), and a target answering with an
    // effect the source did not allow is a target the browser refuses to hand the payload to. The
    // record is not being MOVED into the Bin in the drag-and-drop sense — the row goes, and what
    // lands here is the ledger's account of it.
    event.dataTransfer.dropEffect = "copy";
    setBinHot(true);
  };

  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    // Crossing from the section into one of its own children fires a `dragleave` on the section, and
    // treating that as leaving would make the highlight flicker off every time the pointer passed
    // over a row. The Composer's drop zone answers the same question the same way.
    const entered = event.relatedTarget;
    if (entered instanceof Node && event.currentTarget.contains(entered)) return;
    setBinHot(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    setBinHot(false);
    const kind = catches(event);
    if (kind === null) return;
    event.preventDefault();
    // Null for anything this window did not write, on either MIME. Ignored rather than reported: a
    // drop nobody can act on is not worth a sentence — see `readDragPayload` on why every failure
    // answers the same way.
    if (kind === "session") {
      const session = readSessionDrag(event.dataTransfer.getData(SESSION_MIME));
      if (session === null) return;
      void dropSessionOnBin(session);
      return;
    }
    const payload = readDragPayload(event.dataTransfer.getData(MENTION_MIME));
    if (payload === null) return;
    dropOnBin(payload);
  };

  /*
   * A drag abandoned with Escape does not reliably fire `dragleave` on the element it was over, so
   * without this the Bin can be left lit over nothing — a claim that it is about to catch something
   * when the gesture is over. `dragend` fires on the SOURCE, hence the window listener rather than
   * another handler on the section.
   */
  useEffect(() => {
    const onDragEnd = (): void => setBinHot(false);
    window.addEventListener("dragend", onDragEnd);
    return () => window.removeEventListener("dragend", onDragEnd);
  }, []);

  return (
    <LedgerUnit
      category="deletions"
      label="Bin"
      freshTitle="Something has been deleted since you last looked"
      idleTitle="What was destroyed, and the whole of what it said — drag a record here to ask the agent to delete it"
      deckle={2}
      seed={2}
      catching={{ hot, onDragOver, onDragLeave, onDrop }}
    >
      <Section
        title="Deletions"
        page={logs.deletions}
        category="deletions"
        empty="nothing has been deleted"
      >
        {groupDeletions(logs.deletions.entries).map((group) => (
          <div className="log__group" key={group.table}>
            {/* The table's name in the second phosphor, which is this read-out's whole vocabulary
                for "something was destroyed". It is a plain string rather than a `RecordTable`,
                deliberately: these rows outlive the schema that produced them. */}
            <p className="lcd__head lcd__amber log__group-head">{group.table}</p>
            {group.entries.map((entry) => (
              <DeletionRow key={entry.id} entry={entry} />
            ))}
          </div>
        ))}
      </Section>
    </LedgerUnit>
  );
}

/**
 * A ledger's rows, with its heading, whatever it could not say, and its one way further down.
 *
 * The heading survives under the unit's own head on purpose: the head says which instrument this
 * is, and this says what the rows under it are — which stops being obvious the moment a ledger
 * grows a second section.
 */
function Section({
  title,
  page,
  category,
  empty,
  children,
}: {
  title: string;
  page: LogPage<ErrorLogEntry> | LogPage<DeletionLogEntry>;
  category: LogCategory;
  empty: string;
  children: ReactElement[];
}): ReactElement {
  return (
    <section className="log__section">
      <h3 className="lcd__head log__section-head">{title}</h3>
      {page.error === null ? null : (
        // In the section it explains and never as a toast. This fires on every poke while the ledger
        // is open, so a server that has just fallen over would otherwise put up one toast per log row
        // it wrote on the way down.
        <p className="log__note">{page.error}</p>
      )}
      {page.entries.length === 0 ? (
        <p className="log__note">{page.loading ? "reading…" : empty}</p>
      ) : (
        children
      )}
      {page.hasMore ? (
        <button
          type="button"
          className="log__more"
          disabled={page.loading}
          title="Read one page further down this ledger"
          onClick={() => void logsShowMore(category)}
        >
          Show more
        </button>
      ) : null}
    </section>
  );
}

/**
 * One thing that went wrong: when, where from, and the server's own sentence.
 *
 * The scope is a chip because it is the one field worth SCANNING for — five origins, and which one a
 * row came from is most of what decides whether it is somebody's problem. `detail` is folded away
 * because it is a stack, a stderr tail or a serialised argument: essential when this row is the one
 * being investigated, and noise in every other row on screen.
 */
function ErrorRow({ entry }: { entry: ErrorLogEntry }): ReactElement {
  return (
    <div className="lcd__row log__row">
      <span className="log__when" title={formatAbsolute(entry.at)}>
        {formatRelative(entry.at)}
      </span>
      <span className="log__scope">{entry.scope}</span>
      <span className="log__message">
        {entry.message}
        {entry.detail === null ? null : (
          <details className="log__details">
            <summary className="log__summary">detail</summary>
            <pre className="log__pre">{entry.detail}</pre>
          </details>
        )}
      </span>
    </div>
  );
}

/** One destroyed record: when, what it was CALLED, and the whole of what it said. */
function DeletionRow({ entry }: { entry: DeletionLogEntry }): ReactElement {
  return (
    <div className="lcd__row log__row">
      <span className="log__when" title={formatAbsolute(entry.at)}>
        {formatRelative(entry.at)}
      </span>
      <span className="log__message">
        {/* The name out of the stored row, falling back to the id for a row that never had one —
            see `deletedName`. The uuid is still in the JSON below, whole, for anybody who needs it. */}
        <span className="log__id">{deletedName(entry)}</span>
        <details className="log__details">
          <summary className="log__summary">row</summary>
          <pre className="log__pre">{pretty(entry.row_json)}</pre>
        </details>
      </span>
    </div>
  );
}

/**
 * The stored row, indented — or exactly the bytes that were stored, when they will not parse.
 *
 * THE FALLBACK IS THE RAW STRING AND NEVER AN APOLOGY. The database has a `json_valid` check on this
 * column, so unparseable bytes here mean something further upstream than this window is wrong; showing
 * them is what lets somebody see what. Drawing "could not read this row" instead would destroy the
 * only surviving copy of a record for the second time.
 */
function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json) as unknown, null, 2);
  } catch {
    return json;
  }
}
