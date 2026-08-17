/**
 * The one act that belongs to no table: naming a record.
 *
 * RENAMING USED TO BE THE WINDOW'S AND IS NOW ASKED FOR. A record's `name` is the condensed summary
 * every row is drawn by and addressed by, and it was the one column a browser form was allowed to
 * write, on the argument that a name asserts nothing about the world so a form could not implement a
 * rule wrongly. That argument still holds — what changed is the door, not the reasoning: this
 * window writes nothing to the database, so a rename is asked for like everything else.
 *
 * WHICH MAKES THE DOCTRINE ON THIS TOOL NARROWER THAN THE OTHERS AND NOT WIDER. A name is the
 * user's, and `rename_record` exists to carry out a rename they asked for — not to tidy the archive,
 * not to make two rows read consistently, not to fix a minted name you would have chosen
 * differently. Renaming something nobody mentioned is moving the furniture in somebody else's study.
 * One table refuses outright: a `target`'s name is its instrument's official one, and correcting a
 * wrong one means deleting the target and recording it again.
 *
 * IT USED TO HAVE A NEIGHBOUR, and the neighbour left with what it was about. `delete_playbook_version`
 * removed one version of a workshop's instructions — an act that existed only because instructions
 * were an append-only ledger and a version recorded by mistake had to be removable without taking
 * the lineage. A recipe is one immutable row with a status, so a specification stored by mistake is
 * deleted by `delete_recipe` like any other record, and one that has merely been superseded is set
 * inactive rather than removed at all. There is nothing left in this file but the name.
 */

import { z } from "zod";

import { renameRecord } from "../repo/naming.ts";
import { RECORD_TABLES } from "../repo/records.ts";
import type { ToolDeps } from "../protocol/types.ts";
import { ok } from "../protocol/types.ts";
import { attempt, ref } from "./common.ts";
import { defineTool } from "./def.ts";

export function build(deps: ToolDeps) {
  const { db } = deps;

  const renameRecordTool = defineTool(
    "rename_record",
    "Change what one record is CALLED. Works on any record table. A name is a condensed summary — " +
      "it carries no claim about the world, nothing joins on it, and every id stays exactly what it " +
      "was — so this is cheap and safe, and it is still not yours to do unasked: rename what the " +
      "user asked you to rename, to the words they gave you. Do not tidy names nobody mentioned. " +
      "Names are unique WITHIN a table, so a name another row of the same table holds is refused; " +
      "two tables may share one. A target cannot be renamed at all — its name is the instrument's " +
      "official one.",
    {
      table: z.enum(RECORD_TABLES).describe("Which table the record is in."),
      record: z.string().describe("The record's id, or the name it answers to now."),
      name: z
        .string()
        .describe(
          "The new name: one line, 80 characters at most, and not blank. Whatever the user said to " +
            "call it, spelled the way they spelled it.",
        ),
    },
    async (args) =>
      attempt(() => {
        const id = ref(db, args.table, args.record);
        renameRecord(db, args.table, id, args.name);
        return ok(`Now called ${args.name.trim()}.`, {
          table: args.table,
          record_id: id,
          name: args.name.trim(),
        });
      }),
  );

  return [renameRecordTool];
}
