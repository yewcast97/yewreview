/**
 * Targets: the instruments everything else in YewReview is ABOUT.
 *
 * Deliberately global rather than per-recipe. A ticker is an identity — one NVDA, whichever
 * conversation is talking about it — and a per-recipe copy would give the same company two unit
 * labels and two identities to file measurements under. Theses are global for the same reason. A
 * recipe's own attention is recorded nowhere directly: it is readable back through the reports it
 * published and the theses those reports declared they apply, not from a list kept alongside them.
 *
 * Metadata only ever accumulates: a field left out means "not known", never "clear it", so a later
 * call knowing only the ticker cannot erase what somebody looked up. That is why every optional
 * field here says to leave it out rather than guessing.
 *
 * THE NAME IS NOT METADATA AND IS THE ONE FIELD THAT IS NOT OPTIONAL. It is the instrument's
 * official full name, and it is the one name in this archive nothing can edit afterwards — not this
 * tool, no rename anywhere, not the window. A first call has to carry it; a later one may omit it,
 * or repeat it, but a DIFFERENT one is refused rather than quietly kept or quietly written over.
 */

import { z } from "zod";

import { Refused } from "../db/models.ts";
import { deleteTarget, getTarget, listTargets, upsertTarget } from "../repo/targets.ts";
import { listTheses } from "../repo/theses.ts";
import type { ToolDeps } from "../protocol/types.ts";
import { ok } from "../protocol/types.ts";
import { attempt, count, unconfirmed } from "./common.ts";
import { defineTool } from "./def.ts";

export function build(deps: ToolDeps) {
  const { db } = deps;

  const upsertTargetTool = defineTool(
    "upsert_target",
    "Record an instrument, or fill in what is now known about one. Safe to call repeatedly: it " +
      "adds what you supply and never overwrites a field with a blank, so a call that knows only " +
      "the ticker cannot erase what an earlier one supplied. Recording a NEW instrument needs its " +
      "official name — look it up rather than guessing, because it is the one name here that " +
      "cannot be corrected later; a wrong one has to be deleted and recorded again.",
    {
      ticker: z.string().describe("1-10 characters of A-Z, 0-9, '.' or '-'."),
      name: z
        .string()
        .optional()
        .describe(
          "The instrument's OFFICIAL FULL NAME, as its filings carry it — 'NVIDIA Corporation', " +
            "not 'Nvidia'. Required the first time a ticker is recorded. Afterwards leave it out: " +
            "it is immutable, and a different one is refused.",
        ),
      market: z.string().optional().describe("For example US or TW."),
      unit: z
        .string()
        .optional()
        .describe(
          "What one step of this instrument's own series means — 'dollar', 'percent'. A chart " +
            "prints it beside the axis; it never licenses rescaling anything. Leave it out rather " +
            "than guessing.",
        ),
    },
    async (args) =>
      attempt(() => {
        const target = upsertTarget(db, {
          ticker: args.ticker,
          name: args.name,
          market: args.market,
          unit: args.unit,
        });
        return ok(`${target.ticker} recorded.`, target);
      }),
  );

  const getTargetTool = defineTool(
    "get_target",
    "Everything YewReview holds about one instrument: what it is, and the theses measuring it.",
    { ticker: z.string() },
    async (args) =>
      attempt(() => {
        const target = getTarget(db, args.ticker);
        if (!target) {
          throw new Refused(
            "not_found",
            `${args.ticker} is not recorded; upsert_target adds it, and list_targets shows what ` +
              `is already here`,
          );
        }
        return ok(`${target.ticker}.`, {
          target,
          theses: listTheses(db, { ticker: target.ticker }),
        });
      }),
    { readOnly: true },
  );

  const listTargetsTool = defineTool(
    "list_targets",
    "Every instrument YewReview knows about, with how many theses measure it.",
    {},
    async () =>
      attempt(() => {
        const rows = listTargets(db);
        return ok(`${count(rows.length, "target")}.`, { targets: rows });
      }),
    { readOnly: true },
  );

  const deleteTargetTool = defineTool(
    "delete_target",
    "Remove an instrument. Refused while a thesis measures it — re-point or delete those first, " +
      "because a regime naming a ticker this database no longer has is a measurement of nothing. " +
      "Not recoverable.",
    {
      ticker: z.string(),
      confirm: z.boolean().describe("Must be true."),
    },
    async (args) =>
      attempt(() => {
        const refusal = unconfirmed(args.confirm, "an instrument");
        if (refusal) return refusal;
        const removed = deleteTarget(db, args.ticker);
        if (!removed) {
          throw new Refused("not_found", `${args.ticker} is not recorded`);
        }
        return ok("Removed.", { deleted: true });
      }),
  );

  return [upsertTargetTool, getTargetTool, listTargetsTool, deleteTargetTool];
}
