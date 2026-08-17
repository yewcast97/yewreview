/**
 * Opening a generation procedure: the one tool that starts the machinery a report is published by.
 *
 * THIS TOOL DID NOT EXIST, AND ITS ABSENCE WAS ARGUED FOR AT LENGTH. A procedure could be opened
 * only by an HTTP route, on the reasoning that a model able to open one would always open one
 * first, and "published only inside a generation" would then be a sentence about nothing. The
 * reasoning was about the wrong thing. What makes a report's provenance mean something is not who
 * turns the key: it is that `publish_report` asks the model nothing about its own work, that the
 * account of what produced the numbers is written from a log the machine kept while the procedure
 * was open, that the recipe it was written to is named when it opens and cannot change, and that
 * the rest of the archive is frozen for the duration. Every one of those holds identically whether
 * the request arrived over HTTP or in the conversation.
 *
 * What the button cost, meanwhile, was real: it could be pressed on a specification whose report
 * nobody had discussed, and it could NOT be pressed by somebody who had just spent four turns
 * saying exactly what they wanted written. The ask belongs where the asking happens.
 *
 * SO THERE IS NO CONSENT RULE ON THIS TOOL, and that is deliberate rather than an omission. The
 * tools that carry `CONSENT` write documents the user AUTHORS — a specification, an address book
 * entry, a claim about the market — and the rule exists so nobody's words are stored without them
 * having read them. Nobody authors a report. There is no draft to show before starting, because the
 * procedure is what produces the draft; asking again would be asking permission for work that has
 * just been requested. Being asked is the authorisation, and the window's `+` on a report box says
 * exactly that in the transcript.
 */

import { z } from "zod";

import type { ProcedureRefusal, ToolDeps } from "../protocol/types.ts";
import { fail, ok } from "../protocol/types.ts";
import { attempt, ref, refDoc } from "./common.ts";
import { defineTool } from "./def.ts";

/**
 * The gate's refusals in this surface's vocabulary.
 *
 * Exhaustive over `ProcedureRefusal`, which is why that type is a closed union: a rung added to the
 * gate's ladder cannot be returned until somebody has decided what the model should do about it.
 * `engine_unavailable` becomes `venv_unavailable` because that kind carries the right hint on this
 * surface — say so plainly rather than describing numbers you could not compute — and `closed`
 * becomes a conflict because a shut-down agent is a state, not a missing thing.
 */
const KIND: Record<ProcedureRefusal, string> = {
  closed: "conflict",
  conflict: "conflict",
  not_found: "not_found",
  engine_unavailable: "venv_unavailable",
};

export function build(deps: ToolDeps) {
  const { db } = deps;

  const startGenerationTool = defineTool(
    "start_generation",
    "Open a generation procedure under a recipe and produce the report it specifies. CALL IT AS " +
      "SOON AS THE USER ASKS FOR A REPORT — a plain request in conversation is the ask, and so is " +
      "the message their window sends when they press + on a recipe's report box. There is " +
      "nothing to confirm and no draft to show first: being asked is the authorisation, and asking " +
      "again is a question they have already answered. What comes back is the recipe's whole " +
      "specification, followed by the procedure's own rules — read it as the specification to work " +
      "to, and produce that report IN THIS TURN. An INACTIVE recipe is refused: it is one somebody " +
      "retired, and nothing new is written to it. While the procedure is open the three run tools " +
      "are the only shell you have, every other tool that writes a record is refused so the archive " +
      "cannot move under the report being written, and publish_report is available. The procedure " +
      "ends when you publish, or when this turn ends — so publish before you stop. One procedure " +
      "runs at a time, installation-wide.",
    {
      recipe_id: z.string().describe(refDoc("recipe", "list_recipes")),
    },
    async (args) =>
      attempt(() => {
        // Resolved before the gate is asked, so an unknown recipe is refused by the same sentence
        // every other `*_id` argument gets, naming both ways in. The gate keeps its own `not_found`
        // behind this: it is the one that answers for a recipe deleted between these two lines.
        const recipeId = ref(db, "recipe", args.recipe_id);
        const started = deps.procedure.start(recipeId);
        if (!started.ok) return fail(KIND[started.code], started.message);
        // THE BRIEF IS THE FIRST BLOCK, where a result's human-readable summary goes, because here
        // the summary IS the payload: the model has to read the recipe, not be told that one
        // exists. The transcript line the window draws is clipped to a couple of hundred characters
        // by `resultSummary`, so a specification of any length costs the reader nothing.
        return ok(started.brief, {
          generation_id: started.generationId,
          recipe_id: started.recipeId,
        });
      }),
    // Exempt from the freeze it opens — see `freezeRefusal` in `index.ts`. A second call while a
    // procedure is running is answered by the gate, which names the recipe holding the first.
    { openDuringProcedure: true },
  );

  return [startGenerationTool];
}
