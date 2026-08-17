/**
 * Recipes — the report specifications reports are written to.
 *
 * A RECIPE IS THE UNIT, and it used to be two. Instructions lived in a `playbook` table hung off a
 * `workshop`, appended version by version, and the operative one was derived as the newest row. The
 * workshop owned nothing but a name; the version counter asked a reader to hold a number in their
 * head in order to tell two rows apart; and "which one is in force" was a `MAX()` rather than
 * something anybody could read off a row. What the ledger actually bought was that no report is left
 * pointing at text that changed underneath it — and immutability buys that outright, which is what
 * this table does instead.
 *
 * **So the text is fixed and only the status moves**, exactly as a script's program is fixed and
 * only its status moves. A method that has moved on is a NEW recipe with the old one set
 * `inactive`: the old text stays readable, every report published under it goes on naming the
 * instructions it was actually written to, and the generation gate refuses to open a procedure
 * under a retired specification. `recipe_moves_only_its_status` enforces it, so this is not a
 * convention only this module keeps.
 *
 * **Deleting one takes its reports**, which is the one destructive act here and the reason
 * `deleteRecipe` counts first. `report.recipe_id` is ON DELETE CASCADE, so the specification and
 * everything published to it leave together — documents included, because a report IS a row here.
 * That is the correct meaning of the act rather than an accident of a key: a report whose
 * instructions are gone is a document nothing can say the terms of. A recipe that has merely been
 * superseded is not deleted at all; it is set inactive.
 *
 * **A recipe is the SPECIFICATION one person is commissioning work against**, so the text is theirs
 * whoever types it. That rule is not enforced HERE — these functions would write for whoever
 * reached them — which is precisely why `createRecipe` has exactly one caller, the `create_recipe`
 * tool, where the whole text is rendered in the conversation and recorded only once the user has
 * said so. It is written down so that a second caller appearing above reads as the decision it
 * would be rather than as plumbing.
 */

import type { Database } from "bun:sqlite";

import type { Recipe, RecipeCard, RecipeStatus } from "../db/models.ts";
import { RECIPE_STATUSES, Refused } from "../db/models.ts";
import { newId, nowMs, tx } from "../db/tx.ts";
import { logDeletion } from "./logs.ts";
import { mintName } from "./naming.ts";

function requireStatus(status: RecipeStatus): RecipeStatus {
  if (!RECIPE_STATUSES.includes(status)) {
    throw new Refused(
      "invalid_request",
      `unknown status ${JSON.stringify(status)}; expected one of ${RECIPE_STATUSES.join(", ")}`,
    );
  }
  return status;
}

/**
 * Store a recipe. It is born ACTIVE, and the trigger says so independently.
 *
 * `hint` is what the recipe should be CALLED, roughly; the name it ends up with is minted from it
 * and comes back on the row, because a hint two recipes share is a hint only one of them can have
 * verbatim. The content is the whole specification and is never trimmed into shape beyond its
 * edges — it is markdown the user agreed to, and the bytes stored are the bytes they read.
 */
export function createRecipe(db: Database, hint: string, content: string): Recipe {
  const trimmedHint = hint.trim();
  if (trimmedHint === "") {
    throw new Refused("invalid_request", "a recipe needs a name");
  }
  const text = content.trim();
  if (text === "") {
    throw new Refused("invalid_request", "a recipe needs instructions; empty content is refused");
  }
  return tx(db, () => {
    const id = newId();
    const stamp = nowMs();
    db.query(
      `INSERT INTO recipe (id, name, content, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).run(id, mintName(db, "recipe", trimmedHint), text, stamp, stamp);
    return getRecipe(db, id)!;
  });
}

export function getRecipe(db: Database, id: string): Recipe | null {
  return db.query<Recipe, [string]>("SELECT * FROM recipe WHERE id = ?").get(id);
}

/**
 * Like `getRecipe`, but refuses instead of returning null. Generating and publishing both need one.
 */
export function requireRecipe(db: Database, id: string): Recipe {
  const recipe = getRecipe(db, id);
  if (!recipe) throw new Refused("not_found", `no recipe ${id}`);
  return recipe;
}

/**
 * Recipes for the reader, ACTIVE FIRST and newest first within each standing.
 *
 * The ordering is the listing's own answer to what a reader is looking for: the specifications
 * still being written to, then the retired ones, which are archive rather than absence. Nothing
 * derives "the current recipe" — there is no such thing, deliberately. Several may be active at
 * once, because a person doing two kinds of work has two specifications and neither supersedes the
 * other.
 */
export function listRecipes(
  db: Database,
  filters: { status?: RecipeStatus | undefined } = {},
): RecipeCard[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filters.status !== undefined) {
    where.push("rc.status = ?");
    params.push(requireStatus(filters.status));
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  return db
    .query<RecipeCard, string[]>(
      `SELECT rc.*,
              (SELECT COUNT(*) FROM report r WHERE r.recipe_id = rc.id) AS report_count
         FROM recipe rc${clause}
        ORDER BY CASE rc.status WHEN 'active' THEN 0 ELSE 1 END,
                 rc.created_at DESC, rc.id DESC`,
    )
    .all(...params);
}

/**
 * Move a recipe between `active` and `inactive`. The only write a stored recipe has.
 *
 * Nothing recorded against it moves. A retired recipe keeps its text and every report published
 * under it, because those documents were written to exactly these words and still are — which is
 * the whole difference between setting a recipe inactive and deleting one. What retiring changes is
 * what happens NEXT: the generation gate refuses to open a procedure under it.
 *
 * A recipe may be revived, unlike a thesis, and there is nothing for reviving one to collide with:
 * two recipes saying similar things are two specifications, not a duplicate, because what a recipe
 * is FOR is not derivable from its bytes the way a script's program identity is.
 */
export function setRecipeStatus(db: Database, id: string, status: RecipeStatus): Recipe {
  requireStatus(status);
  return tx(db, () => {
    const current = requireRecipe(db, id);
    if (current.status === status) {
      // Refused rather than treated as a no-op: the write would move `updated_at`, which on a
      // recipe means "when its standing last changed" and would be saying something untrue.
      throw new Refused("conflict", `${current.name} is already ${status}`);
    }
    db.query("UPDATE recipe SET status = ?, updated_at = ? WHERE id = ?").run(status, nowMs(), id);
    return getRecipe(db, id)!;
  });
}

/** How many reports stand under a recipe — what a caller about to delete one has to say out loud. */
export function countRecipeReports(db: Database, id: string): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM report WHERE recipe_id = ?")
      .get(id)?.n ?? 0
  );
}

/**
 * Delete a recipe and every report published under it. True once the row is gone.
 *
 * Downstream means the reports and the parts of those publications — the `script_invocation`,
 * `seikan_invocation` and `trivial_shell_history_for_report` rows recording what each procedure
 * ran. Nothing else: scripts, theses, sources and instruments are global and survive, because a
 * program three other recipes run was never this one's to take away.
 *
 * One `DELETE` does all of it, because every one of those tables reaches this row by a cascading
 * foreign key. The return is a bare boolean rather than a list of leftovers: nothing outside the
 * database belonged to this recipe, so when the transaction commits there is no second step in
 * which a crash could strand anything.
 *
 * ---
 *
 * ONE ROW IS LOGGED, and this is the place that argument is written down — the same three lines
 * apply to five other deletes and repeating the reasoning in each would make it five opinions
 * instead of one.
 *
 * A recipe with three reports takes something like twenty rows with it across four tables, and
 * exactly one deletion-log entry is written: this one, carrying the recipe's whole row, its
 * specification included. The log answers "what did the agent delete", and the answer is a recipe.
 * Everything else that went is the SCHEMA's consequence of that single act — the cascades are
 * declared in `schema.ts`, they are public, and anybody reading the logged row can see what hung
 * off it. Logging the cascade too would answer a question nobody asked, at a cost measured in whole
 * documents (a report's `content` would ride in `row_json`), and would say that twenty things
 * happened when one did.
 *
 * The write is inside the transaction on purpose, which is why `logDeletion` throws where
 * `logError` swallows: a deletion nobody could witness rolls back rather than happening
 * unwitnessed.
 */
export function deleteRecipe(db: Database, id: string): boolean {
  return tx(db, () => {
    const row = db
      .query<Record<string, string | number | null>, [string]>("SELECT * FROM recipe WHERE id = ?")
      .get(id);
    if (row === null) throw new Refused("not_found", `no recipe ${id}`);

    db.query("DELETE FROM recipe WHERE id = ?").run(id);
    logDeletion(db, "recipe", id, row);
    return true;
  });
}
