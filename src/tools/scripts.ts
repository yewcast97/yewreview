/**
 * Scripts: the recorded programs that data reaches the measurement engine through.
 *
 * Be honest about what this is. Giving the agent no shell and no file writer at all — every byte of
 * data the output of a recorded script run under an OS sandbox — would make provenance PROVEN, at
 * the cost of making ordinary work expensive. That trade is taken the other way here, so what this
 * is is a pipeline the agent FOLLOWS rather than one it is confined to:
 *
 *   1. `create_script` stores the program — the source itself, as a column of a row nothing can
 *      edit;
 *   2. `get_script` hands that program back; the agent writes it into a scratch directory inside
 *      its home directory and runs THAT copy with `"$YEWREVIEW_VENV/bin/python"`;
 *   3. what the run wrote stays in the home directory as a working file, and what gets RECORDED is
 *      the pair that would produce it again — the script, and the argument it was given.
 *
 * **A script's outputs are not a ledger this database keeps.** There is no dataset tree, no series
 * table and no column anywhere naming a CSV: where bytes sat while the engine read them is an
 * argument to a run, not a fact about a thesis, and a recorded location is a fact that goes stale
 * the first time somebody moves a directory. What records a script's part in a measurement is a
 * `series_preparation` row on the assessment its output fed — declared with `assess_thesis` — and a
 * `script_invocation` row on the report that published the numbers, written from the log the
 * generation kept. Both name this script and the argument, and both outlive the file.
 *
 * The strong link is the program. It is stored immutably, so what `get_script` hands back years from
 * now is byte for byte what was saved, and no edit anywhere can make a recorded script drift away
 * from the runs recorded against it — there is no copy on disk for the row and a file to disagree
 * about, because the row IS the script. The weak link is step 2: nothing watches the agent run the
 * copy it fetched rather than something else. Say so plainly; do not oversell it.
 *
 * **A script is never edited**, and the descriptions say so. The stored source is what every
 * declaration answers to, and an editable script is a provenance that says whatever it was edited to
 * say. A failing or superseded script is REPLACED: save the corrected program as a new script, set
 * the old one `inactive`, run the new one. The retired script keeps every preparation and every
 * invocation recorded against it — its code is still stored and still explains those numbers — but
 * it is refused a RUN, because a superseded method should not go on quietly producing numbers.
 */

import { z } from "zod";

import type { Script } from "../db/models.ts";
import { Refused, SCRIPT_STATUSES } from "../db/models.ts";
import {
  createScript,
  deleteScript,
  getScript,
  listScripts,
  setScriptStatus,
} from "../repo/scripts.ts";
import type { ToolDeps } from "../protocol/types.ts";
import { fail, ok } from "../protocol/types.ts";
import { attempt, count, ref, refDoc, unconfirmed } from "./common.ts";
import { defineTool } from "./def.ts";

/** A script is code, not data. Anything larger is a different kind of object than this table holds
 * — and a script nobody can read is a script nobody can audit. */
const MAX_SCRIPT_BYTES = 256 * 1024;

/** The pipeline, in one line, carried by the one tool on this surface that records a program. */
const PIPELINE =
  "Save the program here, fetch it back with get_script, write it into a scratch directory inside " +
  'your home directory and run that copy with "$YEWREVIEW_VENV/bin/python". What it writes is a ' +
  "working file in your home directory that nothing here tracks; what records the run is naming " +
  "this script and its argument in the assessment the output was measured for. A saved script is " +
  "never edited: a fix is a new script, with the old one set inactive.";

export function build(deps: ToolDeps) {
  const { db } = deps;

  const createScriptTool = defineTool(
    "create_script",
    "Record a script before running it. The program itself is stored — the source, in a row nothing " +
      "can edit — so what get_script returns years from now is byte for byte what you saved, and no " +
      "edit anywhere can make a recorded script drift away from the measurements declared against " +
      "it. There is no copy on disk to keep in sync with anything. State its domain truthfully: it " +
      "is what a later pass has to work out whether two scripts overlap from. Storing a program " +
      "another ACTIVE script already IS, byte for byte, is refused — scripts belong to the " +
      `installation rather than to any recipe, so run that one instead. ${PIPELINE}`,
    {
      name: z
        .string()
        .describe(
          "A few words the script's name is minted from — what it fetches or computes. The name " +
            "actually recorded comes back in the result, and may carry a suffix if those words " +
            "were already taken.",
        ),
      domain: z
        .string()
        .describe(
          "What this script is for, in one line — the sentence that should still be true a month " +
            "from now.",
        ),
      source: z
        .string()
        .describe(
          "The whole program, exactly as it will run. It runs with the venv python, so pandas, " +
            "requests and seikan are available; give it a scratch directory as its working " +
            "directory and have it write there.",
        ),
    },
    async (args) =>
      attempt(() => {
        const oversized = tooBig(args.source);
        if (oversized) return oversized;

        // One row and nothing else: a create that is refused leaves nothing behind, because there
        // is no second half of it anywhere on disk to have half-happened.
        const script = createScript(db, {
          name: args.name,
          domain: args.domain,
          source: args.source,
        });
        return ok(`Recorded ${script.name}.`, view(script));
      }),
  );

  const setScriptStatusTool = defineTool(
    "set_script_status",
    "Move a script between active and inactive. A script's code never changes after it is saved — " +
      "the stored source is what every declared preparation and every recorded invocation points " +
      "at, and an editable script is a provenance that says whatever it was edited to say. So a " +
      "failing script is not fixed in place and a superseded one is not rewritten: save the " +
      "corrected program as a NEW script, set this one inactive, and run the replacement. " +
      "Retiring frees the program-identity for the replacement and takes nothing away — every " +
      "assessment and every report that named this script goes on naming it, because the code that " +
      "produced those numbers is still stored and still explains them — but run_script REFUSES an " +
      "inactive script, so retiring one is also how you stop it being used. active un-retires a " +
      "script, and is refused when a replacement now holds its exact program. When the change " +
      "reflects a new method rather than a fix, store the matching recipe in the same movement: " +
      "the script and the recipe are two halves of one method.",
    {
      script_id: z.string().describe(refDoc("script", "list_scripts")),
      status: z
        .enum(SCRIPT_STATUSES)
        .describe(
          "active = a program that runs; inactive = retired, by replacement or " +
            "because it failed for good. Not a deletion: delete_script is that.",
        ),
    },
    async (args) =>
      attempt(() => {
        const scriptId = ref(db, "script", args.script_id);
        requireScript(deps, scriptId);
        const script = setScriptStatus(db, scriptId, args.status);
        return ok(`${script.name} is now ${script.status}.`, view(script));
      }),
  );

  const getScriptTool = defineTool(
    "get_script",
    "One script in full, the program itself included. This is where a run starts — write what comes " +
      "back into your own scratch directory and run THAT, unedited, so the code behind a number is " +
      "the code YewReview recorded. Read it before writing a replacement too: the replacement has " +
      "to answer for everything this one did.",
    { script_id: z.string().describe(refDoc("script", "list_scripts")) },
    async (args) =>
      attempt(() => {
        const script = requireScript(deps, ref(db, "script", args.script_id));
        // The source comes straight off the row, which is the only copy there is — nothing to
        // re-read, nothing to check it against, and nothing that could have drifted since.
        return ok(`${script.name} — ${script.domain}.`, {
          ...view(script),
          source: script.source,
        });
      }),
    { readOnly: true },
  );

  const listScriptsTool = defineTool(
    "list_scripts",
    "Every recorded script, with what each is for. The programs themselves are NOT listed — " +
      "get_script returns one whole. Scripts belong to the installation rather than to any " +
      "recipe, so this is the whole set whatever you are working on. Read it before writing a " +
      "new one: an " +
      "active script that already does the job is run again, and one that nearly does is the base " +
      "of its replacement — save the new program and retire the near-miss rather than keeping two " +
      "that overlap.",
    {
      query: z.string().optional().describe("A substring of a name or a domain."),
      status: z
        .enum(SCRIPT_STATUSES)
        .optional()
        .describe("Narrow to the ones still running, or to the archive. Both by default."),
    },
    async (args) =>
      attempt(() => {
        const rows = listScripts(db, { query: args.query, status: args.status });
        return ok(`${count(rows.length, "script")}.`, { scripts: rows.map(view) });
      }),
    { readOnly: true },
  );

  const deleteScriptTool = defineTool(
    "delete_script",
    "Remove a script — the row and the program with it. This is for a script that should never have " +
      "been recorded; one that merely failed or was superseded is set inactive instead, which " +
      "keeps it and everything recorded against it. Refused two ways, for one reason: what a script " +
      "leaves behind is somebody else's account of what happened. A published report that recorded " +
      "running it stands on those numbers, so the report goes first; and an assessment that " +
      "declared this script prepared its inputs would be left claiming a measurement with nothing " +
      "to say what produced the series it was read over. Not undoable. Nothing on disk is touched: " +
      "whatever this script once wrote is a working file in your home directory, and this database " +
      "never knew its name.",
    {
      script_id: z.string().describe(refDoc("script", "list_scripts")),
      confirm: z.boolean().describe("Must be true."),
    },
    async (args) =>
      attempt(() => {
        const refusal = unconfirmed(args.confirm, "a script and the program stored with it");
        if (refusal) return refusal;
        const script = requireScript(deps, ref(db, "script", args.script_id));
        if (!deleteScript(db, script.id)) {
          // Read a statement ago, so reaching here means the row left in between. Reporting a
          // removal that did not happen would be worse than saying so.
          throw new Refused("not_found", `script ${script.id} was already gone`);
        }
        return ok(`Removed ${script.name}.`, { deleted: true });
      }),
  );

  return [
    createScriptTool,
    setScriptStatusTool,
    getScriptTool,
    listScriptsTool,
    deleteScriptTool,
  ];
}

/**
 * The script named, or a refusal naming the tool that lists the ones there are.
 *
 * Existence only. Scripts are GLOBAL — they belong to the installation, not to any recipe — so a
 * program saved while working on something else is a perfectly good one to read or retire. There is
 * no containment check here, because there is no boundary for one to protect. Whether it may be RUN
 * is a different question and belongs to `run_script`, which is the tool that would be using it.
 */
function requireScript(deps: ToolDeps, scriptId: string) {
  const script = getScript(deps.db, scriptId);
  if (!script) {
    throw new Refused("not_found", `no script ${scriptId}; list_scripts shows the recorded ones`);
  }
  return script;
}

function tooBig(source: string) {
  if (Buffer.byteLength(source, "utf8") <= MAX_SCRIPT_BYTES) return null;
  return fail(
    "invalid_request",
    `the script is larger than ${MAX_SCRIPT_BYTES / 1024} KB. A script this big is doing more than ` +
      `one thing, and neither you nor anyone reading it later will be able to say what produced ` +
      `which number — split it.`,
  );
}

/**
 * What a listing shows about a script: everything except the program, which is a separate ask.
 *
 * The program is a column, so leaving it out is a deliberate projection rather than an accident
 * of where the bytes live: a browse that carried every stored source would answer "what is here"
 * with a megabyte of Python nobody asked to read. `source_bytes` says how much of it there is, and
 * `get_script` hands one back whole.
 */
function view(script: Script) {
  return {
    script_id: script.id,
    name: script.name,
    domain: script.domain,
    status: script.status,
    source_bytes: Buffer.byteLength(script.source, "utf8"),
    created_at: script.created_at,
    updated_at: script.updated_at,
  };
}
