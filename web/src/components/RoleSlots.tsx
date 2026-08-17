/**
 * The row of role slots: which model answers in each of the roles opencode routes by, on the line
 * directly above the box somebody is about to type into.
 *
 * WHY IT IS HERE AND NOT IN THE POOL. opencode answers a turn as one agent and hands parts of the
 * work to others — a plan, an explore — and which model each of those IS decides what the reader is
 * about to get back. That is the same class of fact as the model picker in the caption above it, and
 * it is read in the same moment for the same reason: this is where somebody decides what to say. The
 * pool is where models are KEPT; the slots are where they are put to work, and keeping the two apart
 * is what lets the pool be a panel you open and this be a line you never have to.
 *
 * ONE ROW AND FIVE SLOTS, in the order the server sent them, which is opencode's own. The vocabulary
 * is not a list this bundle declares — see `state/opencode.ts` — so a role that is renamed or added
 * on the server's side appears here without an edit, and a slot for a role opencode does not have
 * cannot appear at all. IT NEITHER SCROLLS NOR WRAPS: every slot is a drop target, and a target that
 * has to be scrolled into view during a drag is a target nobody can hit — so the five share one line
 * whatever the dock is wide, shrinking together and cutting their two words short. What settled it
 * against the wrap is the edge the reader can now drag: the conversation narrows to a third of the
 * window, a second line of slots is a line of transcript spent, and this is the rack the carried
 * note has to cross to get here. The price is a narrow slot on a narrow dock — paid in ellipsis
 * rather than in layout, and still wide enough to let go over.
 *
 * WHAT A SLOT SAYS IS THREE DIFFERENT THINGS AND THEY ARE NOT INTERCHANGEABLE. A model's name when
 * the role resolves to one; the bare id when the assignment DANGLES, because a config that routes
 * `plan` at a model this window cannot find is still routing it somewhere and a slot reading `—`
 * would be a lie about what answers; and `—` when the role is genuinely empty, which is opencode's
 * own default answering. `assignmentFor` is what tells the three apart.
 *
 * ── TWO WAYS TO SET ONE, AND THE SLOW ONE IS THE ONE THAT MATTERS ─────────────────────────────────
 *
 * The fast path is the DRAG: a model note is dragged out of the pool by its top strip and let go
 * over a slot. It is the gesture the whole board is built around and it is the one that reads as
 * putting a thing somewhere. It is also pointer-only — a captured pointer, no keyboard equivalent,
 * nothing at all on a touch screen — so it cannot be the only way, and the model name in every slot
 * is therefore also a `Picker`: the same short list of models plus a row that clears the slot,
 * writing the same `assignRole`. A keyboard reaches it, a screen reader reads it as a listbox, and
 * the drag is left to be what it is good at rather than being the only door.
 *
 * The picker's clear row is drawn as the same em dash an empty slot shows, so choosing it and then
 * looking at the result are the same mark rather than two words for one state.
 *
 * ── WHAT THE ROW IS NOT ───────────────────────────────────────────────────────────────────────────
 *
 * IT IS NOT DISABLED WHILE THE AGENT WORKS, unlike the three controls in the caption above it. Those
 * are refused by the AGENT because a model swapped mid-turn leaves one answer written half by each;
 * this is refused by the ROUTE, in a sentence, because the pool is rendered into the config the
 * child was started with. The difference is worth keeping: a reader can perfectly well decide what
 * `explore` should be while a turn runs, and the honest answer to trying is the server's sentence
 * rather than a control that was dimmed before they got there.
 */

import { useEffect, useRef, type ReactElement } from "react";

import type { Assignment, OpencodeState } from "../state/opencode.ts";
import { assignmentFor, modelLabel, primaryRole } from "../state/opencode.ts";
import { assignRole, clearRole, useOpencode } from "../state/store.ts";
import type { PickerOption } from "./Picker.tsx";
import { Picker } from "./Picker.tsx";
import { forgetSlot, registerSlot } from "./slotTarget.ts";
import "./RoleSlots.css";

/** What an unassigned slot shows, and what the row that empties one is drawn as. One mark for one
 * state, said in the two places that state can be read. */
const NOTHING = "—";

export function RoleSlots(): ReactElement | null {
  const opencode = useOpencode();

  // Nothing at all until the server has said what the roles are. A row of slots for a vocabulary
  // this window has not been told yet would be furniture inventing its own contents, and the read
  // that fills it is made the moment health names the harness.
  if (opencode.vocabulary.length === 0) return null;

  const primary = primaryRole(opencode);

  return (
    <div className="slots" role="group" aria-label="Which model answers in which role">
      {opencode.vocabulary.map((role) => (
        <Slot key={role} role={role} primary={role === primary} state={opencode} />
      ))}
    </div>
  );
}

function Slot({
  role,
  primary,
  state,
}: {
  role: string;
  /** The role that answers an ordinary turn. Marked rather than sorted — it is already first — and
   * said in words on the control's title, because "the one that answers" is not something a reader
   * can be expected to know about a word like `build`. */
  primary: boolean;
  state: OpencodeState;
}): ReactElement {
  const element = useRef<HTMLDivElement | null>(null);
  const assignment = assignmentFor(state, role);
  const hot = state.slotHot === role;

  /*
   * The slot's own rectangle, findable by a drag that the browser will tell nobody about. Registered
   * from an effect rather than from the `ref` itself so the unregister is paired with it — see
   * `slotTarget.ts` for the identity guard that makes a double mount safe.
   */
  useEffect(() => {
    const held = element.current;
    if (held === null) return;
    registerSlot(role, held);
    return () => forgetSlot(role, held);
  }, [role]);

  // Every model in the pool, then the row that empties the slot. Built per render rather than
  // memoized: it is five or six short rows off a slice that changes only when the pool is saved, and
  // a memo keyed on that slice would be bookkeeping to avoid building a five-element array.
  const options: PickerOption[] = [
    ...state.models.map((model) => ({ value: model.id, label: modelLabel(model) })),
    { value: "", label: NOTHING },
  ];

  return (
    <div ref={element} className={hot ? "slots__slot slots__slot--hot" : "slots__slot"}>
      <span className="slots__role">{role}</span>
      <Picker
        className="slots__pick"
        value={valueOf(assignment)}
        options={options}
        // Only when there is nothing to choose. A pool with no models in it can have no roles
        // assigned either — the route refuses a role naming a model that is not there — so there is
        // nothing to set and nothing to clear, and the title says where models come from.
        disabled={state.models.length === 0}
        ariaLabel={`Which model answers as ${role}`}
        title={slotTitle(role, primary, state.models.length === 0, assignment)}
        onChange={(chosen) => {
          // The empty string is the clear row, and it is the only value the pool can never hold: an
          // entry with no id is refused by the route, so nothing else can arrive here as blank.
          if (chosen === "") void clearRole(role);
          else void assignRole(role, chosen);
        }}
      />
    </div>
  );
}

/** What the picker is currently showing: a model's id, a dangling one, or the empty string that
 * matches the clear row. The dangling id is handed over as-is on purpose — the picker draws a value
 * its options do not carry verbatim, which is exactly the honest thing to show. */
function valueOf(assignment: Assignment): string {
  switch (assignment.kind) {
    case "model":
      return assignment.model.id;
    case "dangling":
      return assignment.id;
    case "empty":
      return "";
  }
}

/**
 * What this slot is, and what is in it, on the control.
 *
 * The three assignment cases read differently on purpose. A resolved one names the model; a dangling
 * one says the route points at something not in the pool, which is the only place a reader would
 * ever learn that; an empty one says what actually happens, which is that opencode answers with its
 * own default rather than that nothing does.
 */
function slotTitle(
  role: string,
  primary: boolean,
  empty: boolean,
  assignment: Assignment,
): string {
  const what = primary
    ? `${role} answers an ordinary turn`
    : `${role} is one of the roles opencode routes to`;
  if (empty) return `${what} — the pool has no models in it yet, so open it and pin one up`;
  switch (assignment.kind) {
    case "model":
      return `${what}, and is answered by ${modelLabel(assignment.model)}`;
    case "dangling":
      return `${what}, and is routed to ${assignment.id}, which is not in the pool`;
    case "empty":
      return `${what}. Nothing is assigned, so opencode's own default answers there`;
  }
}
