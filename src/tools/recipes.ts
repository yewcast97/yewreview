/**
 * Recipes: the report specifications, stored, retired and taken away from here.
 *
 * A RECIPE IS THE SPECIFICATION THE USER IS COMMISSIONING WORK AGAINST. It is the one document in
 * this database that says what THEY want, and a contractor who edits the brief between jobs is not
 * being dishonest, they are being the wrong kind of useful. So `create_recipe` carries `CONSENT`:
 * the whole text is rendered in the conversation as a row block and recorded only once the user has
 * said, in a later message, that this is what they want stored.
 *
 * THE TEXT IS IMMUTABLE, WHICH IS WHAT REPLACED A VERSION LEDGER. Instructions used to live in a
 * `playbook` table hung off a `workshop`, appended version by version, with the operative one
 * derived as the newest row and every report naming the exact version that wrote it. Two tables and
 * a counter were carrying what one immutable row carries here. What the ledger bought — that no
 * report is left pointing at text that changed underneath it — immutability buys outright, and
 * without asking a reader to hold a number in their head to tell two rows apart.
 *
 * So there is no `revise_recipe` and there must not be one. A method that has moved on is a NEW
 * recipe with the old one set inactive: `set_recipe_status` retires it, its text stays readable,
 * every report published under it goes on naming the instructions it was actually written to, and
 * `start_generation` refuses to open a procedure under it.
 *
 * DELETING ONE TAKES ITS REPORTS, which is why `delete_recipe` counts them first and says the
 * number out loud before it asks. That cascade is the correct meaning of the act rather than an
 * accident of a key — a report whose specification is gone is a document nothing can say the terms
 * of — but it is also the most destructive thing on this surface, and a caller who wanted the
 * milder move almost always wanted `set_recipe_status`.
 *
 * NEITHER WRITE CARRIES ITS OWN MID-PROCEDURE REFUSAL, and the absence is deliberate. Both used to,
 * in the shape their workshop-era ancestors had: "a procedure is running under this very recipe, so
 * retiring or deleting it would strand the report being written." Every word of that is true and
 * none of it could ever be reached — `announcing` in `index.ts` evaluates the freeze BEFORE the
 * handler, and neither of these is exempt, so a call made while a procedure records is answered by
 * the freeze and a call made outside one finds no procedure to collide with. A guard that cannot
 * fire is worse than none: it reads as the thing keeping the rule, and the thing keeping the rule is
 * somewhere else.
 *
 * There is no rename tool here. What a recipe is CALLED is its `name`, the column every record
 * carries, and it is written by `rename_record` — one tool for every table rather than one per
 * table.
 */

import { z } from "zod";

import type { RecipeCard } from "../db/models.ts";
import { RECIPE_STATUSES } from "../db/models.ts";
import {
  countRecipeReports,
  createRecipe,
  deleteRecipe,
  listRecipes,
  requireRecipe,
  setRecipeStatus,
} from "../repo/recipes.ts";
import type { ToolDeps } from "../protocol/types.ts";
import { ok } from "../protocol/types.ts";
import { attempt, count, CONSENT, ref, refDoc, unconfirmed } from "./common.ts";
import { defineTool } from "./def.ts";

/** What a listing says about a recipe. The TEXT is deliberately not here — `get_recipe` hands one
 * back whole, and a browse carrying every specification's full text would answer "what recipes are
 * there" with several pages of prose. */
function view(card: RecipeCard) {
  return {
    recipe_id: card.id,
    name: card.name,
    status: card.status,
    report_count: card.report_count,
    created_at: card.created_at,
    updated_at: card.updated_at,
  };
}

export function build(deps: ToolDeps) {
  const { db } = deps;

  const createRecipeTool = defineTool(
    "create_recipe",
    "Store a report specification: what a report written to it must be — for whom, how often, what " +
      "it must contain. This is the user's document, not your notes. " +
      CONSENT +
      " A recipe's text is IMMUTABLE once stored, which is why the whole of it is agreed first: " +
      "there is no revising one. When the method moves on, store the new specification as a new " +
      "recipe and set the old one inactive with set_recipe_status — every report published under " +
      "the old one goes on naming the exact instructions it was written to. Several recipes may be " +
      "active at once; two kinds of work are two specifications, and neither supersedes the other.",
    {
      name: z
        .string()
        .describe(
          "A few words the recipe's name is minted from — say what the reports are about rather " +
            "than when they were started. The name actually recorded comes back in the result, and " +
            "may carry a suffix if those words were already taken.",
        ),
      content: z
        .string()
        .describe(
          "The whole specification, as the user agreed to it. Markdown; it is read as prose by you " +
            "and rendered as prose in their window.",
        ),
    },
    async (args) =>
      attempt(() => {
        const recipe = createRecipe(db, args.name, args.content);
        return ok(
          `Stored ${recipe.name}, active. A report can be generated to it now, and its text will ` +
            `not change.`,
          {
            recipe_id: recipe.id,
            name: recipe.name,
            status: recipe.status,
            created_at: recipe.created_at,
          },
        );
      }),
  );

  const getRecipeTool = defineTool(
    "get_recipe",
    "Read one recipe whole — its specification, and whether it is still being written to. Read it " +
      "before writing a report to it and before proposing a replacement: it is what the user has " +
      "asked for, and a report is recorded against the exact recipe that produced it.",
    { recipe_id: z.string().describe(refDoc("recipe", "list_recipes")) },
    async (args) =>
      attempt(() => {
        const recipe = requireRecipe(db, ref(db, "recipe", args.recipe_id));
        return ok(`${recipe.name}, ${recipe.status}.`, {
          recipe_id: recipe.id,
          name: recipe.name,
          status: recipe.status,
          content: recipe.content,
          report_count: countRecipeReports(db, recipe.id),
          created_at: recipe.created_at,
          updated_at: recipe.updated_at,
        });
      }),
    { readOnly: true },
  );

  const listRecipesTool = defineTool(
    "list_recipes",
    "Every recipe, ACTIVE FIRST and newest first within each, with how many reports have been " +
      "published under it. Read it before storing one: this conversation runs across all of them, " +
      "so the specification the user means may well already exist. The text itself is not listed — " +
      "get_recipe reads one whole.",
    {
      status: z
        .enum(["active", "inactive"])
        .optional()
        .describe(
          "Narrow to one standing. Leave it out for all of them, which is the ordinary read: an " +
            "inactive recipe is archive rather than absence, and what has been retired is worth " +
            "seeing beside what has not.",
        ),
    },
    async (args) =>
      attempt(() => {
        const rows = listRecipes(db, { status: args.status });
        return ok(`${count(rows.length, "recipe")}.`, { recipes: rows.map(view) });
      }),
    { readOnly: true },
  );

  const setRecipeStatusTool = defineTool(
    "set_recipe_status",
    "Retire a recipe, or bring one back. `inactive` is how a specification is superseded: its text " +
      "stays, every report published under it stays and goes on naming it, and start_generation " +
      "refuses to open a procedure under it — so nothing new gets written to instructions nobody " +
      "is working to any more. This is the move that pairs with storing the replacement, and the " +
      "two belong in one movement. It is not a deletion and takes nothing away; say what you are " +
      "retiring and why before you call it.",
    {
      recipe_id: z.string().describe(refDoc("recipe", "list_recipes")),
      status: z
        .enum(["active", "inactive"])
        .describe(`One of ${RECIPE_STATUSES.join(", ")}.`),
    },
    async (args) =>
      attempt(() => {
        const recipeId = ref(db, "recipe", args.recipe_id);
        const recipe = setRecipeStatus(db, recipeId, args.status);
        return ok(`${recipe.name} is now ${recipe.status}.`, {
          recipe_id: recipe.id,
          name: recipe.name,
          status: recipe.status,
          updated_at: recipe.updated_at,
        });
      }),
  );

  const deleteRecipeTool = defineTool(
    "delete_recipe",
    "Remove a recipe AND EVERY REPORT PUBLISHED UNDER IT — the documents themselves included, " +
      "because a report IS a row here. Say how many reports that is and get the user's agreement " +
      "before calling: theses, scripts, sources and instruments are global and survive untouched, " +
      "but the published documents do not, and publishing again writes a new report rather than " +
      "the old one back. This is almost never what a superseded recipe wants — set_recipe_status " +
      "retires one while keeping every report readable. Refused while a generation procedure is " +
      "running under it. Not undoable.",
    {
      recipe_id: z.string().describe(refDoc("recipe", "list_recipes")),
      confirm: z.boolean().describe("Must be true."),
    },
    async (args) =>
      attempt(() => {
        const refusal = unconfirmed(
          args.confirm,
          "a recipe and every report published under it",
        );
        if (refusal) return refusal;
        const recipeId = ref(db, "recipe", args.recipe_id);
        const recipe = requireRecipe(db, recipeId);
        const reports = countRecipeReports(db, recipeId);
        deleteRecipe(db, recipeId);
        return ok(`Removed ${recipe.name}, with ${count(reports, "report")}.`, {
          deleted: true,
          reports_removed: reports,
        });
      }),
  );

  return [
    createRecipeTool,
    getRecipeTool,
    listRecipesTool,
    setRecipeStatusTool,
    deleteRecipeTool,
  ];
}
