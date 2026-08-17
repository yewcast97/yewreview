/**
 * Whether this app can do its work, in one line in the corner of the window.
 *
 * Three things can be wrong and each of them changes what the agent is able to do: the database can
 * stop answering, the measurement engine can be missing, and the sandbox the agent's commands run
 * in can be unavailable. Collapsed to a dot and this build's version, because on a healthy machine
 * all three are true all day and a permanent line restating it is a line taken from the work. The
 * detail opens on hover or on click, which is the same trade the rest of this window makes for
 * timestamps: the summary is for glancing, the full answer is one gesture away.
 *
 * THE DOT CARRIES THE STATE AND THE WORDS CARRY THE BUILD, which is why the summary is a version and
 * not a health verdict. Those are two different questions and the reader asks them at different
 * moments: the dot is for the glance that happens a hundred times a day, and the version is for the
 * one moment somebody needs to say which YewReview this was.
 *
 * It is drawn inside `StatusCluster` and nowhere else, which is also where its stylesheet lives.
 *
 * The panel is in the DOM the whole time and hidden with `visibility`, so a hover reveals it with no
 * state change while a keyboard still cannot land inside something nobody has opened.
 *
 * `refreshHealth` is polled rather than pushed: health is a fact about the SERVER, and the one
 * channel that could push it is the same socket whose silence is what "not answering" means.
 */

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";

import { refreshHealth, retryVenv, useHealth } from "../state/store.ts";

/** Often enough that a server restart shows up before the user wonders, rare enough to be invisible
 * in the log of a local process. */
const POLL_MS = 15_000;

type Tone = "ok" | "warn" | "danger" | "muted";

/**
 * The dot's state IN WORDS.
 *
 * The dot is `aria-hidden` and the summary beside it is this build's version in three of the four
 * states, so without this the corner says "YewReview 1.0.0" and nothing else while the measurement
 * engine is missing. Colour is not a fact a screen reader can read out, and green-versus-amber is
 * not a distinction every sighted reader can make either — the same reasoning `ToolLine` already
 * follows, where the mark carries a shape and a word as well as a hue.
 */
const SPOKEN: Record<Tone, string> = {
  ok: "all good",
  warn: "needs attention",
  danger: "not answering",
  muted: "checking",
};

export function HealthBadge(): ReactElement {
  const health = useHealth();
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  // Null means "no answer" only once an answer has been due. Before the first reading it means the
  // window has just started, and a red dot at launch would be this component's own impatience.
  const [answered, setAnswered] = useState(health !== null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (health !== null) setAnswered(true);
  }, [health]);

  useEffect(() => {
    // The first reading is the store's own, taken when the window came up; this is the pulse after.
    const timer = window.setInterval(() => void refreshHealth(), POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
  };

  const install = async (): Promise<void> => {
    setInstalling(true);
    await retryVenv();
    setInstalling(false);
  };

  const tone: Tone =
    health === null
      ? answered
        ? "danger"
        : "muted"
      : !health.ok || !health.venv.ready || !health.sandbox.available || health.mode === "reader"
        ? "warn"
        : "ok";

  // THE BUILD, NOT THE MODEL. What this line is for is being read back — in a bug report, to
  // somebody else's window — and of the facts behind it the version is the only one
  // that identifies WHICH YEWREVIEW is on screen. The model is a setting: it changes without the
  // build changing, it is on the `ready` frame for the conversation that is actually using it, and
  // in the corner of the window it would answer a question nobody is asking.
  const summary = health === null ? (answered ? "Not answering" : "Checking…") : `YewReview ${health.version}`;

  return (
    <div
      className="health"
      ref={rootRef}
      onKeyDown={onKeyDown}
      // `open` is the ONE truth behind both the panel's visibility and what the badge announces. A
      // `:hover` rule revealing the panel behind the component's back would leave a hovered badge
      // saying `aria-expanded="false"` over a panel that is plainly open.
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => {
        if (!rootRef.current?.contains(document.activeElement)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="health__badge"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onFocus={() => setOpen(true)}
        title={`${summary} — server ${SPOKEN[tone]}`}
      >
        <span className={`health__dot health__dot--${tone}`} aria-hidden="true" />
        <span className="health__summary">{summary}</span>
        <span className="sr-only">Server: {SPOKEN[tone]}</span>
      </button>

      <div
        className="health__detail paper"
        data-open={open ? "true" : "false"}
        role="group"
        aria-label="Server health"
      >
        {health === null ? (
          <p className="health__note">
            {answered
              ? "YewReview is not answering. The window keeps asking; nothing here is lost while it does not."
              : "Asking the server how it is."}
          </p>
        ) : (
          <>
            <dl className="health__rows">
              {/* The shape of the archive this build reads and writes. It is beside the three
                  capability rows rather than in a footnote under them because it is the same kind of
                  fact: a schema the binary does not expect is a database that cannot be worked in,
                  which is the thing this whole panel is about. */}
              <div className="health__row">
                <dt>Schema</dt>
                <dd>v{health.schemaVersion}</dd>
              </div>
              <div className="health__row">
                <dt>Engine</dt>
                <dd className={health.venv.ready ? "tone-ok" : "tone-warn"}>
                  {health.venv.ready
                    ? health.venv.seikanVersion === null
                      ? "installed"
                      : `seikan ${health.venv.seikanVersion}`
                    : "not installed"}
                </dd>
              </div>
              <div className="health__row">
                <dt>Sandbox</dt>
                <dd className={health.sandbox.available ? "tone-ok" : "tone-warn"}>
                  {health.sandbox.available ? "available" : "unavailable"}
                </dd>
              </div>
              <div className="health__row">
                <dt>Database</dt>
                <dd className={health.ok ? "tone-ok" : "tone-danger"}>{health.ok ? "answering" : "not answering"}</dd>
              </div>
              {/* Whether this PROCESS may write the archive — the same kind of fact as the three
                  above: it changes what the agent is able to do, for the life of the process. */}
              <div className="health__row">
                <dt>Writing</dt>
                <dd className={health.mode === "writer" ? "tone-ok" : "tone-warn"}>
                  {health.mode === "writer" ? "this process" : "read-only — another process holds the pen"}
                </dd>
              </div>
            </dl>

            {/* The server's own sentences, verbatim: each of them says what to do about the thing it
                is reporting, and a friendlier paraphrase would say less. */}
            {health.venv.error === null ? null : <p className="health__note">{health.venv.error}</p>}
            {health.sandbox.hint === null ? null : <p className="health__note">{health.sandbox.hint}</p>}
            {health.mode !== "reader" ? null : (
              <p className="health__note">
                Another yewreview process on this data directory is the writer. Everything here
                reads; nothing here writes. Close that process and restart this one to write.
              </p>
            )}

            {health.venv.ready ? null : (
              <button
                type="button"
                className="btn btn--ghost health__action"
                onClick={() => void install()}
                disabled={installing}
              >
                {installing ? "Installing…" : "Install the engine"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
