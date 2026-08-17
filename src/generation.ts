/**
 * The generation procedure: the authority boundary, and the only thing that makes report provenance
 * mean anything.
 *
 * **The agent opens one, with `start_generation`, when the user asks for a report.** That is a
 * change from what this file used to say, and the old sentence is worth stating because the
 * replacement has to carry its weight: a procedure could once be opened only by
 * `POST /api/workshops/:id/generation`, on the argument that a model able to open one would always
 * open one first and "published only inside a generation" would be a sentence about nothing.
 *
 * What was actually load-bearing in that argument was never WHO turns the key. `publish_report`
 * takes no account of the model's own work: the report's account of what produced its numbers is
 * written from the runs the machine logged while the procedure was open, the recipe it was written
 * to is named when the procedure opens and cannot change, and — since the freeze in
 * `tools/index.ts` — the rest of the archive is held still, so what the report was read against cannot
 * move underneath it. None of that depends on the request arriving over HTTP. A button was a poor
 * way to hold it up in any case: it could be pressed on a specification whose report nobody had
 * discussed, and it could not be pressed by somebody who had just spent four turns saying exactly
 * what they wanted written.
 *
 * So what the gate still refuses is everything that would actually rot the record: publishing
 * outside a procedure, two procedures at once, a procedure with no turn to ride, opening one under
 * a retired specification, and writing anything else into the archive while one is open.
 *
 * **It lives here, above both harnesses, because it is a rule about the ARCHIVE rather than about a
 * conversation.** The Claude session and the opencode session each compose one of these; both get
 * the same refusals, the same named recipe, and the same run log, so a report cannot be told
 * apart by which harness produced it. Two implementations of this — one per harness, drifting — is
 * exactly how provenance rots, and it would rot silently, because the rows would still look fine.
 *
 * What it deliberately does NOT do is submit or send anything. `start` hands back the brief and the
 * caller — a tool, whose result is already on its way to the model — delivers it. The gate stays
 * free of transports.
 */

import type { Database } from "bun:sqlite";

import { newId, nowMs } from "./db/tx.ts";
import type {
  GenerationEnd,
  OutboundFrame,
  ProcedureStart,
  RunLog,
  RunLogEntry,
  SeikanRun,
} from "./protocol/types.ts";
import { logError } from "./repo/logs.ts";
import { getRecipe } from "./repo/recipes.ts";
import type { VenvStatus } from "./sandbox/venv.ts";

/** How many finished engine runs stay redeemable at once. See `retained` below. */
const RETAINED_RUNS = 16;

/**
 * What a generation procedure is asked to do, in words nobody outside this file chose.
 *
 * A constant rather than something a caller composes, and that is the point: the request says
 * "produce the report this recipe specifies", and letting the caller word the instruction would
 * make the recorded procedure a function of whatever text somebody typed. It was the browser that
 * would otherwise have worded it; it is the model itself now, which is a stronger reason rather than
 * a weaker one — an instruction the model wrote for itself is not an instruction. The recipe the
 * procedure works to is prefixed to it by `procedureBrief`; this half only has to name the procedure
 * and its rules, and it is identical for every recipe and every harness.
 */
const GENERATION_PROCEDURE =
  "Generation procedure. Produce and publish the report this recipe specifies.\n\n" +
  "While this procedure is running, every command goes through `run_shell`, `run_script` or " +
  "`run_seikan`, and your own Bash is closed for the duration: this report records what actually " +
  "ran to produce it — the line, the exit code, the duration and the output — so one door is what " +
  "makes that record complete rather than partial. `run_shell` is an ordinary shell and nothing " +
  "you would otherwise type is denied. `publish_report` is available only here, it asks nothing " +
  "about your work because the log already has it, and publishing ends the procedure. Wait for " +
  "any command still running before you publish.\n\n" +
  "The archive holds still for the duration. Every tool that writes a record is refused while this " +
  "is open — the four above are the exceptions, because they are the procedure — so that the report " +
  "is written against an archive that cannot move underneath it. Store the scripts and theses you " +
  "will need before you start; file assessments and revisions after it ends, where a measurement " +
  "taken here is still redeemable by its run id.\n\n" +
  "The procedure lives inside the turn that opened it: when this turn ends, the procedure ends with " +
  "it. So publish before you stop, and do not offer to carry on in the next message — there will be " +
  "no procedure left to carry on inside.\n\n" +
  "If the report cannot be produced — the data is not there, the measurement does not support the " +
  "argument, the recipe asks for something the archive cannot answer — say plainly why and " +
  "stop. A procedure that ends without a report is a finished answer, not a failure.";

/**
 * What opening a procedure hands back: the recipe, then the procedure.
 *
 * The recipe is named by BOTH its name and its id because this text has two readers with different
 * needs — the user reads the transcript and knows the recipe by name, and the model calls tools
 * that take a recipe id and would otherwise have to go looking for one it was never told. The
 * specification comes first and the procedure last so that the instruction is the final thing read,
 * which is where an instruction belongs when a specification of unknown length precedes it.
 *
 * It rides back as a TOOL RESULT rather than as a new turn, which is what changed when the agent
 * took over opening these. Both readers still get it — a tool result is in the transcript too — and
 * the model reads the specification in the turn it is already working in, rather than being handed
 * it at the top of a turn it did not ask for.
 */
function procedureBrief(recipeId: string, recipeName: string, recipeContent: string): string {
  return (
    `The recipe ${recipeName} (id ${recipeId}) — the report specification this procedure works ` +
    `to. A recipe's text is immutable, so these are the exact words this report will be recorded ` +
    `as having been written to.\n\n` +
    `${recipeContent}\n\n${GENERATION_PROCEDURE}`
  );
}

/** A generation procedure: which recipe it works to, and what has run under it. */
type Generation = {
  id: string;
  /**
   * The recipe this procedure will publish under. A global conversation touches many; this is the
   * only one with a claim on the report being written, and `publish_report` reads it from here
   * rather than from anything the model says.
   *
   * IT IS ALSO THE WHOLE PIN. Instructions used to be a version ledger, so the procedure had to hold
   * both the workshop and the exact version row in force when it opened, and publishing had to check
   * the head had not moved underneath it. A recipe's text cannot change, so naming the row names the
   * bytes: there is no second identifier to carry and no drift to check for.
   */
  recipeId: string;
  runLog: RunLogEntry[];
  startedAt: number;
};

/** What a caller must tell the gate about the world it is guarding. */
export type GenerationGateDeps = {
  db: Database;
  /** Frames to whoever is watching this conversation. */
  emit: (frame: OutboundFrame) => void;
  venv: () => VenvStatus;
  /** Whether the harness is shut down — a procedure started against a dead session would never
   * run, and the refusal should say so rather than the turn silently vanishing. */
  closed: () => boolean;
  /**
   * Whether a turn is actually in flight.
   *
   * A PROCEDURE RIDES THE TURN THAT OPENS IT, and this is what stops one being opened with no turn
   * to ride. The tool that opens a procedure is called from inside a turn, so on the Claude path
   * this can only ever be true; opencode's tools arrive over HTTP at `/mcp`, where a call racing an
   * abort can land with nothing running. A procedure opened there would be a zombie — nothing would
   * reach the turn-end that closes it, so the archive would stay frozen and `resume` and `clear`
   * would refuse for the rest of the boot.
   *
   * It replaced the opposite question. The gate used to refuse when the harness was busy AT ALL,
   * which was right when a route opened procedures from outside the conversation: an unrelated turn
   * still going would have put its runs in the report's log. In-turn, the work in flight IS the
   * caller, and queued turns are taken only after the turn-end that closes the procedure.
   */
  turnInFlight: () => boolean;
};

/**
 * The procedure in flight, and everything a tool is allowed to know about it.
 *
 * One per harness instance, at most one procedure open at a time, installation-wide.
 */
export class GenerationGate {
  private readonly deps: GenerationGateDeps;
  private current: Generation | null = null;

  /**
   * Finished engine runs an assessment may still redeem, newest last.
   *
   * Boot-lifetime and bounded: a restart between measuring and filing loses the token, and the
   * remedy is to measure again — which is cheap and honest, where persisting it would mean keeping
   * a report nobody has decided to keep. `RETAINED_RUNS` is generous enough that a normal session
   * never notices and small enough that a long one does not accumulate megabytes of JSON.
   */
  private readonly retained = new Map<string, SeikanRun>();

  constructor(deps: GenerationGateDeps) {
    this.deps = deps;
  }

  /** The one `RunLog` every tool is handed. */
  readonly runLog: RunLog = {
    recording: () => this.current !== null,
    recipeId: () => this.current?.recipeId ?? null,
    begin: (start, at) => {
      const generation = this.current;
      if (generation === null) return () => {};
      const entry: RunLogEntry = { ...start, at, outcome: null };
      generation.runLog.push(entry);
      // Closes over the ENTRY rather than an index, so a finalizer still settles the right run when
      // several are in flight at once — which parallel tool calls make ordinary.
      return (outcome) => {
        entry.outcome = outcome;
      };
    },
    entries: () => this.current?.runLog ?? [],
    retain: (run) => {
      const runId = newId();
      this.retained.set(runId, { ...run, runId });
      while (this.retained.size > RETAINED_RUNS) {
        const oldest = this.retained.keys().next();
        if (oldest.done) break;
        this.retained.delete(oldest.value);
      }
      return runId;
    },
    redeem: (runId) => {
      const run = this.retained.get(runId) ?? null;
      if (run) this.retained.delete(runId);
      return run;
    },
    end: (reason) => this.end(reason),
  };

  /** What a snapshot says about the procedure, or null when none is running. */
  running(): { id: string; recipeId: string } | null {
    if (this.current === null) return null;
    return { id: this.current.id, recipeId: this.current.recipeId };
  }

  /** Whether a procedure is open at all — the guard a harness folds into its own busy check. */
  open(): boolean {
    return this.current !== null;
  }

  /**
   * Begin a procedure under one named recipe, and hand back the brief that produces a report to it.
   *
   * The caller returns that brief to the model as its tool result. Nothing else has to happen for
   * the procedure to be under way — it is already open, inside the turn that asked for it, and the
   * turn's own ending closes it.
   *
   * With one conversation for the whole installation the one-at-a-time guard bites across recipes
   * as well as within one: two procedures at once would interleave their measurements in a single
   * stream of tool calls, and neither report could say which runs were its own.
   *
   * AN INACTIVE RECIPE IS REFUSED, and that refusal is the whole point of the status. A retired
   * specification is one somebody decided to stop writing reports to; publishing another under it
   * would put a document in the archive claiming instructions that are no longer in use, and the
   * decision to retire it would have changed nothing. Reviving it is one move and the refusal names
   * it, because a person who meant to write that report is one call away from being able to.
   */
  start(recipeId: string): ProcedureStart {
    if (this.deps.closed()) {
      return {
        ok: false,
        code: "closed",
        message: "the agent has been shut down; restart YewReview before starting anything",
      };
    }
    if (this.current !== null) {
      return {
        ok: false,
        code: "conflict",
        message:
          `a generation procedure is already running, under recipe ${this.current.recipeId}; ` +
          `finish it — publish, or say why the report cannot be produced — before starting another`,
      };
    }
    if (!this.deps.turnInFlight()) {
      return {
        ok: false,
        code: "conflict",
        message:
          "a generation procedure rides the turn that opens it, and no turn is in flight here. " +
          "This call arrived outside one, so nothing would ever close the procedure it opened",
      };
    }
    const recipe = getRecipe(this.deps.db, recipeId);
    if (recipe === null) {
      return { ok: false, code: "not_found", message: `no recipe ${recipeId}` };
    }
    if (recipe.status === "inactive") {
      return {
        ok: false,
        code: "conflict",
        message:
          `recipe ${recipe.name} is inactive: it is a specification somebody retired, and a report ` +
          `published under it would claim instructions that are no longer in use. Set it active ` +
          `again with set_recipe_status if it should be written to, or work to a recipe that is`,
      };
    }
    if (!this.deps.venv().ready) {
      return {
        ok: false,
        code: "engine_unavailable",
        message:
          "the measurement engine is not installed in this environment, so a report produced here " +
          "could not measure anything it claims. Retry provisioning first",
      };
    }

    this.current = { id: newId(), recipeId, runLog: [], startedAt: nowMs() };
    // The frame says a procedure has begun and under which specification. The recipe's TEXT rides in
    // the brief below and is deliberately not broadcast — a window draws the recipe as a record.
    this.deps.emit({ type: "generation_started", generationId: this.current.id, recipeId });
    return {
      ok: true,
      generationId: this.current.id,
      recipeId,
      // Handed back to the model as the opening tool's result, so the specification is read in the
      // turn that asked for it and the whole exchange — the request, the procedure, the report — is
      // one thing in the transcript rather than an instruction that appeared from nowhere.
      brief: procedureBrief(recipeId, recipe.name, recipe.content),
    };
  }

  /** Close the procedure and say why. Everything logged under it goes with it — a run log outlives
   * its generation nowhere, because the only thing that reads one is the publish it belongs to. */
  end(reason: GenerationEnd): void {
    const generation = this.current;
    if (generation === null) return;
    this.current = null;
    if (reason === "error") {
      // The only one of the four outcomes that is a DEFECT. `published` and `completed` are the
      // procedure working, and `cancelled` is a person changing their mind; filing those would bury
      // the failures under a record of ordinary use.
      logError(
        this.deps.db,
        "generation",
        `the generation procedure under recipe ${generation.recipeId} ended in error`,
        {
          generationId: generation.id,
          recipeId: generation.recipeId,
          runs: generation.runLog.length,
          startedAt: generation.startedAt,
        },
      );
    }
    this.deps.emit({ type: "generation_ended", generationId: generation.id, reason });
  }
}

/** Exported for the tests that pin the procedure's wording, which is doctrine rather than prose. */
export { GENERATION_PROCEDURE, procedureBrief };
