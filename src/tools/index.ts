/**
 * The tools, assembled — and assembled for NO PARTICULAR HARNESS.
 *
 * What comes out of here is an array of `ToolDefinition`s: name, description, Zod shape, handler.
 * The Claude session turns them into an in-process MCP server (`src/claudecode/mcp.ts`); the opencode
 * session serves the same array over its own bridge. Neither adaptation is visible from this
 * directory, and neither harness may be imported into it. That is the whole reason these tools live
 * under `src/tools` rather than under one of the two harnesses that call them: they are the
 * DATABASE's write surface, and the database is the thing both paths share.
 *
 * Built per session rather than defined at import time, because every tool closes over the database,
 * the settings and the run log of the process it belongs to. It closes over no RECIPE, and that
 * absence is the shape of this whole layer: there is ONE conversation for the installation and
 * it works across every recipe the archive holds, so a recipe is named in an argument and
 * refused by name when nothing is stored under it. The single call that must NOT be told which
 * recipe — `publish_report` — reads it off the generation procedure it is running inside, because
 * that procedure named the recipe the report will be recorded against.
 *
 * What is here is deliberately narrow. The agent also has Bash, Write, Edit, Read, Glob, Grep,
 * WebSearch and WebFetch, and it does its actual work with those — reading pages, drafting a report
 * as a file, running a script. These tools are the ones that touch what YewReview REMEMBERS: the
 * record of what was published, what it rests on, and where every number came from.
 *
 * EVERY TABLE OF THAT RECORD IS WRITTEN THROUGH THESE TOOLS, and until recently two were not. What
 * the agent writes is mostly its ACCOUNT OF WHAT IT DID: the theses it stored, the readings it
 * filed, the reports it published and everything each one declared it stood on. There is no approval
 * step over any of that and there should not be, because a queue of proposed findings is a
 * conversation with extra ceremony — what keeps it honest is the ARCHIVE. Recipes and reports are
 * immutable by trigger, a report names the exact recipe that produced it, a thesis's
 * standing is a ledger rather than a column, and every deletion is witnessed in a log. Authority is
 * broad; nothing it does is quiet.
 *
 * THREE OF THEM ARE NOT ITS ACCOUNT OF ANYTHING, and those are written differently. A recipe is
 * the SPECIFICATION the user is commissioning work against — the one document here that says what
 * they want. The address book is their standing account of where their numbers come from, which
 * every report ever published leans on. A thesis is their claim about the market, in their terms;
 * the DSL beside it is only this surface's translation of that claim into something measurable. All
 * three are assets of the person the reports belong to. The first two used to be written from
 * browser forms and are now written from here, on one condition, stated on each of those tools as
 * `CONSENT` in `common.ts`: the whole of what is about to be stored is rendered in the conversation
 * first, and the user says afterwards that it is what they want.
 *
 * THE THESIS SPLITS ALONG THAT LINE RATHER THAN SITTING ON ONE SIDE OF IT, which is why
 * `create_thesis` carries the rule and `assess_thesis` deliberately does not. What the thesis CLAIMS
 * is theirs and is agreed; how it READS once the engine has measured it is this surface's own
 * judgement and asks nobody. The one thing agreement does not reach is the translation itself: a
 * document bent toward the answer its commissioner wanted measures nothing while looking exactly
 * like a measurement, so it is argued with and left unstored rather than written down.
 *
 * THE FORM WAS NEVER THE THING THAT PROTECTED THEM, which is why moving the pen costs less than it
 * reads. A button is one click away wherever it sits, and a form let somebody press Save on text
 * nobody had read out loud. What actually holds is that the change has to be SHOWN and AGREED, and
 * that the archive keeps both halves afterwards. Permission is not what makes a writer honest — a
 * draft store the agent types into and the user commits from would be ceremony, because committing
 * another party's text is not writing.
 */

import { Refused } from "../db/models.ts";
import { logError, logWrites } from "../repo/logs.ts";
import type { ToolDeps, ToolResult } from "../protocol/types.ts";
import { fail } from "../protocol/types.ts";
import type { AnyToolDefinition } from "./def.ts";
import { invoke } from "./def.ts";
import * as generation from "./generation.ts";
import * as records from "./records.ts";
import * as reports from "./reports.ts";
import * as runs from "./runs.ts";
import * as scripts from "./scripts.ts";
import * as sources from "./sources.ts";
import * as targets from "./targets.ts";
import * as recipes from "./recipes.ts";
import * as theses from "./theses.ts";

/** Every tool, in the order a reader should meet them: what a recipe IS, then what it produces,
 * then the objects it reasons over, then the programs that produce the numbers they are reasoned
 * over with. The array is heterogeneous — each `defineTool` call carries its own argument type,
 * checked where it was written — and widens to `AnyToolDefinition` here, where nothing needs it
 * again. */
export function definitions(deps: ToolDeps): AnyToolDefinition[] {
  return [
    ...recipes.build(deps),
    ...records.build(deps),
    ...generation.build(deps),
    ...reports.build(deps),
    ...runs.build(deps),
    ...targets.build(deps),
    ...theses.build(deps),
    ...sources.build(deps),
    ...scripts.build(deps),
  ];
}

/**
 * How many rows this connection has written that were rows of the ARCHIVE.
 *
 * `total_changes()` is SQLite's own count of every row inserted, updated or deleted since the
 * connection was opened — the whole database's traffic, asked of the database rather than tallied by
 * hand. THE LOG TABLES ARE THIS ARITHMETIC'S ONE EXCLUSION, and `repo/logs.ts` counts its own
 * writes for exactly this subtraction. An error logged in the middle of a handler is not the archive
 * moving: a window told otherwise would re-read its whole record browser every time a run exited
 * nonzero, and a frame that cries wolf is a frame the person reading it learns to ignore. The two
 * log tables sit structurally outside the record browser anyway (`repo/records.ts`), so a
 * `records_changed` fired by one would be pointing at nothing a browser draws.
 *
 * The prunes are in the log's count as well as the inserts, which is what keeps the subtraction from
 * coming out too LOW — the one error that would suppress a real announcement. Cascades and triggers
 * are in the total and in no count of ours, so the result can only ever come out too HIGH, and too
 * high costs one re-read of what a window already has open where too low is a window drawing a
 * database that has moved without it.
 */
function archiveWrites(deps: ToolDeps): number {
  const row = deps.db.query<{ n: number }, []>("SELECT total_changes() AS n").get();
  return (row?.n ?? 0) - logWrites(deps.db);
}

/**
 * The archive holds still while a report is being written: every writing tool refused for the
 * length of a generation procedure, or null when the call may proceed.
 *
 * WHY A REPORT NEEDS THE REST OF THE ARCHIVE TO STOP MOVING. A report is not only the document it
 * publishes — it is that document read against everything it cites: the recipe it was
 * written to, the theses whose measurements it quotes, the sources those numbers came from, the
 * scripts that prepared them. A procedure that could rename a thesis halfway through, revise the
 * source it had already quoted, or delete the script it ran would publish a document whose own
 * archive no longer says what the document says it says. Nothing would look broken; the rows would
 * all be there, and every one of them would be about something slightly different.
 *
 * THE FOUR EXCEPTIONS ARE THE PROCEDURE ITSELF. `run_shell`, `run_script` and `run_seikan` are the
 * only shell there is while one is open, and `publish_report` is what ends it — refusing those would
 * not be a stricter rule, it would be a procedure that cannot do anything. `start_generation` is
 * exempt too, so that asking for a second procedure is answered by the gate's own sentence, which
 * names the recipe holding the first, rather than by this one.
 *
 * DECLARED PER TOOL AND ENFORCED HERE, ONCE. The flag lives on the definition (`def.ts`) beside
 * `readOnly`, which is the same kind of fact about the same kind of thing; the enforcement is here,
 * because this wrapper is the one place BOTH serving surfaces go through and a rule in the two MCP
 * layers would be the drift `def.ts` exists to prevent. It refuses as a RESULT rather than a throw:
 * a frozen call is the model being told the archive is closed, which is an answer it should act on,
 * not a defect worth an error-log row.
 *
 * WHAT REPLACED IT. Two tools used to carry a narrow version of this — the ones that revised and
 * deleted a report specification, each refusing only when the open procedure was for THEIR
 * specification — which was this rule discovered twice and scoped too tightly both times. A write
 * to any other record still moves the archive a report is being read against; a deleted script did,
 * and nothing was stopping it.
 *
 * AND NOTHING CARRIES A NARROW ONE NOW. The recipe tools were written with the same shape at first
 * — "a procedure is running under this very recipe" — and it could never fire: this wrapper
 * evaluates the freeze BEFORE the handler, so a frozen tool never reaches its own check, and
 * outside a procedure there is nothing for one to collide with. The refusal below names the recipe
 * the procedure works to, which is the sentence those guards were reaching for anyway.
 */
/**
 * A read-only process refuses every write, for the length of its life — or null when this process
 * holds the pen, which is almost every process.
 *
 * The mode is decided ONCE, at boot, by the writer claim (`db/lock.ts`): the first process on a
 * var root writes, every later one reads, and nothing promotes a reader mid-life. So where the
 * freeze below is scoped to a procedure, this is scoped to the process — same shape, same
 * chokepoint, same kind of answer. Evaluated BEFORE the freeze because a reader can never open a
 * procedure, so its sentence is the one that is actually true.
 *
 * `definition.readOnly` is the whole test, the five `openDuringProcedure` tools included: the two
 * that ARE writes (`start_generation`, `publish_report`) obviously, and the three run tools too,
 * because a shell run from a reader works in the writer's live home directory and feeds a
 * procedure this process can never hold. One rule beats a matrix.
 *
 * NO CALLER IDENTITY REACHES THIS. Both MCP surfaces serve the same wrapped definitions from one
 * `announcing(deps)` call, and the refusal is a function of `(deps.mode, definition)` alone — no
 * session, no agent, no caller. That absence is the inheritance guarantee: a subagent dispatched
 * by the main agent writes with exactly the main agent's pen, and a reader's subagents are
 * refused exactly as its main agent is.
 */
function readerRefusal(deps: ToolDeps, definition: AnyToolDefinition): ToolResult | null {
  if (deps.mode !== "reader") return null;
  if (definition.readOnly) return null;
  return fail(
    "read_only",
    `${definition.name} is refused because this yewreview process is read-only: another process ` +
      `was already serving this var root when this one started, and the first process on a root ` +
      `holds the pen for as long as it runs. Every reading tool still answers, and the ` +
      `conversation continues — but nothing here may write the archive, run a command, or open a ` +
      `generation. Make the change from the writing process, or close it and restart this one to ` +
      `become the writer.`,
  );
}

function freezeRefusal(deps: ToolDeps, definition: AnyToolDefinition): ToolResult | null {
  if (!deps.runs.recording()) return null;
  if (definition.readOnly || definition.openDuringProcedure) return null;
  return fail(
    "conflict",
    `${definition.name} is refused while a generation procedure is recording (recipe ` +
      `${deps.runs.recipeId()}): the archive is held still until the procedure ends, so the ` +
      `report being written is read against a record that cannot move underneath it. Run commands ` +
      `with run_shell, run_script or run_seikan, publish with publish_report, and make this change ` +
      `once the procedure has ended.`,
  );
}

/**
 * The tools this server exposes, each one wrapped so a call that moved the archive tells the windows
 * and a call that CRASHED leaves a row somebody can read afterwards.
 *
 * ONE wrapper rather than a `deps.events(...)` line in thirty handlers, and the difference matters
 * more than the line count: a per-handler call is a thing to forget, and the tool somebody adds
 * next year without one is invisible to every open window with nothing saying so. Here it is
 * structural — a tool cannot be registered without it.
 *
 * WHAT IT WATCHES IS ROWS, NOT INTENT. Firing on any call that did not refuse, reads included, would
 * announce a great deal that never moved; a hand-kept list of which tools write is the same
 * forgettable thing one level up. Counting rows is better than both: it cannot be forgotten, because
 * nothing is declared, and it cannot be wrong about whether something moved, because it asks SQLite
 * what moved. The `records_changed` frame means A TABLE MOVED, and it says so only when one did. Its
 * one exclusion is the log tables, argued in `archiveWrites` above.
 *
 * The frame carries no table list (see `EventsFrame`), so there is nothing here that could be wrong
 * about WHAT changed — only that something did.
 *
 * **THE CATCH FILES DEFECTS AND NOTHING ELSE.** Only a non-`Refused` throw can reach it: `attempt`
 * in `common.ts` converts every repository refusal into a RESULT, so anything still travelling as an
 * exception here is YewReview being broken rather than the model being wrong. That is why routine
 * refusals are never logged and this is — a refusal is an answer the model acts on, and an error log
 * full of mistyped ids is one nobody reads. It is rethrown after filing, because the model still has
 * to see the crash: swallowing it would leave a turn believing a call succeeded.
 *
 * **AND THE ANNOUNCEMENT IS IN `finally`**, which is a widening rather than a tidy-up. A handler
 * that wrote rows and then threw has moved the archive exactly as much as one that wrote rows and
 * returned — the transaction that committed is committed — so a window that was not told would go on
 * drawing a database that has changed underneath it, and the crash it could blame would be nowhere
 * near the stale rows. Announcing on the success path alone would quietly make "the tool finished"
 * the condition for "the database moved", which are two different facts.
 *
 * **THIS IS WHAT A HARNESS IS HANDED**, never the bare `definitions` beneath it. Both serving
 * surfaces call this, so a tool called over opencode announces and files exactly as one called over
 * the Claude session does — the archive does not learn which harness wrote to it, and neither does
 * the window.
 */
export function announcing(deps: ToolDeps): AnyToolDefinition[] {
  return definitions(deps).map((definition) => ({
    ...definition,
    handler: async (args: never) => {
      const readerHeld = readerRefusal(deps, definition);
      if (readerHeld !== null) return readerHeld;
      const frozen = freezeRefusal(deps, definition);
      if (frozen !== null) return frozen;
      const before = archiveWrites(deps);
      try {
        // No `isError` check on the way out, and none is needed: a refusal that wrote no rows is
        // silent because the count did not move, and a handler that wrote rows and then refused has
        // moved the archive whatever it went on to return.
        return await invoke(definition, args);
      } catch (err) {
        // Belt and braces on the one thing that must never be filed. `attempt` already converts
        // refusals, so this branch should be unreachable for one — but a handler added next year
        // that forgets `attempt` would otherwise fill the error log with the model's typos, and the
        // log's whole value is that everything in it is worth reading.
        if (!(err instanceof Refused)) {
          logError(
            deps.db,
            "tool",
            `${definition.name} threw: ${err instanceof Error ? err.message : String(err)}`,
            err,
          );
        }
        throw err;
      } finally {
        if (archiveWrites(deps) > before) deps.events({ type: "records_changed", at: Date.now() });
      }
    },
  }));
}
