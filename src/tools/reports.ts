/**
 * Publishing: the one door a draft goes through to become a report.
 *
 * The agent writes its draft with ordinary tools inside its home directory, which is the only place
 * its sandbox may write. Publishing READS those bytes and STORES them: the row is the report,
 * content and all, and it names the recipe the procedure opened against.
 *
 * **WHICH RECIPE A REPORT IS PUBLISHED UNDER IS NOT AN ARGUMENT AND MUST NOT BECOME ONE.** The
 * conversation is global and works across every recipe in the archive, so every other tool here
 * takes a recipe id from the model — and this one reads it off the generation procedure it is
 * running inside (`RunLog.recipeId`). A model free to name the recipe could name one this procedure
 * never opened against, and the document would go out claiming provenance from instructions nobody
 * was working to. Taking it from the procedure makes that unrepresentable rather than discouraged.
 *
 * THERE IS NO LONGER A PIN TO CHECK, and that absence is worth stating because a check used to live
 * here. Instructions were an append-only version ledger, so publishing re-read the operative version
 * and refused when the head had moved since the procedure opened. A recipe's text cannot change at
 * all, so naming the row names the bytes: there is nothing to re-read and nothing for a revision to
 * have done underneath the report.
 *
 * Nothing is written to disk here — no path to mint, no directory to create, no file to unlink when
 * a declaration turns out to name nothing. A failed publication leaves NOTHING AT ALL — there is no
 * half-done state available to it — which is why the whole call is a single transaction with no
 * cleanup hanging off it. The draft itself stays where the agent wrote it: the home directory is
 * scratch, and a published report depends on not a byte of it.
 *
 * The chart library is rewritten on the way through. A draft references it however the agent found
 * it convenient; a stored report is served at `/reports/<report_id>`, so every reference becomes the
 * ABSOLUTE `/reports/assets/echarts.min.js` — a relative href would be resolved against whatever URL
 * the reader happened to arrive at, and a report whose chart library 404s is a report of blank
 * rectangles. `inline_assets` pastes the library into the document instead, for a report that has to
 * survive being saved out and sent to someone.
 *
 * **NOTHING IS DECLARED. What produced the report is OBSERVED.** `publish_report` takes a draft, a
 * title and one formatting choice, and no account whatsoever of the caller's own work. It used to
 * take two: the readings the argument stood on, and the materials it said it had drawn from where.
 * Both were the model's word, nothing verified either, and rows that look like evidence and are not
 * are worse than no rows — so the tables and the arguments were deleted together.
 *
 * What is written instead comes from the log the generation procedure kept while the report was
 * being produced: `script_invocation` for every stored program that ran, `seikan_invocation` for
 * every measurement — its report kept whole — and `trivial_shell_history_for_report` for every
 * other command, each carrying when it started, how
 * long it took, what it exited with and what it printed. A model asked what it ran answers with
 * what it MEANT to run, and the difference only shows up where nobody can check it. Failed runs are
 * recorded too, because a command that refused is part of what producing the report involved.
 *
 * Publishing again produces a SECOND report; there is no revision, and the report row is
 * trigger-immutable so that is true of the database rather than merely of this surface.
 *
 * **Which is why publishing happens only inside a generation procedure.** Outside one there is no
 * log, so a report would be minted whose invocation record is empty for a reason nothing in the
 * record explains. A procedure is opened by `start_generation`, in the conversation where the
 * report was asked for, and publishing outside one is refused.
 *
 * Deletion is rows and only rows — the document among them, because the document IS one of the
 * rows — and leaves nothing behind for anyone to clean up.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { Settings } from "../config.ts";
import { paths } from "../config.ts";
import { Refused } from "../db/models.ts";
import { tx } from "../db/tx.ts";
import { deleteReport, getReport, listReports, recordReport } from "../repo/reports.ts";
import { ECHARTS_FILENAME } from "../resources/embed.ts";
import type { ToolDeps } from "../protocol/types.ts";
import { fail, ok } from "../protocol/types.ts";
import { attempt, count, ref, refDoc, unconfirmed } from "./common.ts";
import { defineTool } from "./def.ts";
import { resolveInHome } from "./homeFile.ts";

/** Where a stored report reaches the served chart library from, whatever URL it is being read at.
 * Absolute on purpose: the document has no directory of its own to be relative to. */
const ASSET_HREF = `/reports/assets/${ECHARTS_FILENAME}`;

/** A `<script src="…echarts….js">` element, whether or not it carries other attributes. */
const CHART_SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*echarts[^"']*\.js["'][^>]*>\s*<\/script>/gi;

/** The `src` value alone, for the rewrite that keeps the element. */
const CHART_SRC = /(<script\b[^>]*\bsrc\s*=\s*)(["'])[^"']*echarts[^"']*\.js\2/gi;

export function build(deps: ToolDeps) {
  const { db, settings } = deps;

  const publishReportTool = defineTool(
    "publish_report",
    "Publish a finished HTML draft as a report. It is published under the recipe whose generation " +
      "procedure is running — there is no argument for choosing, because the procedure named that " +
      "recipe when it opened and the report is recorded against it. It " +
      "must be a complete document — a doctype and a <title> — because a report is read on its " +
      "own, months later, by someone who no longer has this conversation. The draft is read and " +
      "STORED as the report, so publish only when it is done: there is no revising afterwards, and " +
      "publishing again writes a second report. THERE IS NOTHING TO DECLARE: the record of what " +
      "produced this report is written from what the procedure actually ran, so nothing here asks " +
      "you what you did.",
    {
      draft_path: z
        .string()
        .describe(
          "The draft, relative to your home directory (for example drafts/nvda-q1.html). " +
            "It must be inside that directory; nothing else is publishable.",
        ),
      title: z
        .string()
        .describe("What a reader picks this report by in a list. Not a filename."),
      inline_assets: z
        .boolean()
        .optional()
        .describe(
          "Paste the chart library into the document instead of linking YewReview's served copy. " +
            "Use it for a report that has to survive being saved out and sent to someone; it makes " +
            "the stored document roughly a megabyte larger.",
        ),
    },
    async (args) =>
      attempt(() => {
        // The gate, and the first thing checked. A report's account of what produced it is written
        // from the generation's run log, so publishing outside one would mint a document whose
        // invocation record is empty for a reason nothing in the record explains. The entrance is
        // `start_generation`, and this refusal names it: it used to name a button the user pressed,
        // and a refusal pointing at a control that no longer exists would leave the model waiting.
        if (!deps.runs.recording()) {
          return fail(
            "invalid_request",
            "a report is published inside a generation procedure, and none is running here. Open " +
              "one with start_generation when the user has asked for this report — the record of " +
              "what produced a report is written from what ran while the procedure was in " +
              "progress, so a document published outside one could not account for its own " +
              "numbers.",
          );
        }
        // The recipe the procedure works to, never the model's choice — see the module header. A
        // recording log that cannot name one is a broken log rather than an argument mistake, and
        // guessing a recipe here would publish a document under a specification nothing opened
        // against.
        const recipeId = deps.runs.recipeId();
        if (recipeId === null) {
          return fail(
            "invalid_request",
            "this generation procedure does not name a recipe, so there is no specification for a " +
              "report to be published under. Say so plainly and let the user start the procedure " +
              "again from the recipe they want the report written to.",
          );
        }
        // A COMMAND STILL RUNNING IS A REPORT THAT CANNOT ACCOUNT FOR ITSELF YET. Log entries are
        // opened when a command is spawned and completed when it exits, so an open one means work
        // this report would be published without. Tool calls can be issued in parallel, which makes
        // "publish while the long one is still going" an ordinary accident rather than a contrived
        // one — and the row it would leave out is exactly the expensive run somebody would want.
        const runs = deps.runs.entries();
        const pending = runs.filter((run) => run.outcome === null);
        if (pending.length > 0) {
          return fail(
            "conflict",
            `${pending.length} command(s) this procedure started have not finished. Wait for them ` +
              `and publish afterwards: the report's account of what produced it is written from ` +
              `what actually ran, and a run still going is a run it could not describe.`,
          );
        }

        const draft = resolveInHome(settings, args.draft_path, "draft");
        const title = args.title.trim();
        if (title === "") {
          throw new Refused(
            "invalid_request",
            "a report needs a title; it is what a reader picks it by in a list",
          );
        }

        const html = readFileSync(draft, "utf8");
        assertCompleteDocument(html, args.draft_path);
        // Rewritten before the transaction, because these are the bytes that get stored AND the
        // bytes that get STORED — a rewrite afterwards would check one document and publish
        // another.
        const content = rewriteChartLibrary(html, settings, args.inline_assets === true);

        // One transaction: every argument is verified inside `recordReport` and nothing outside it
        // has been touched — so a run naming a script that is not there leaves no report, no rows
        // and no leftovers. There is no head to re-read here, because a recipe's text cannot move:
        // the row the procedure named is the row, with the words it had when the turn began.
        const card = tx(db, () => {
          // Read off the log rather than asked for. Failed runs are recorded too: a measurement
          // that refused is part of what producing this report actually involved, and a record
          // that kept only the runs that worked would read as a straight line through work that
          // was not one.
          return recordReport(db, recipeId, title, content, {
            scriptRuns: runs.flatMap((run) =>
              run.kind === "script" && run.outcome !== null
                ? [{ scriptId: run.scriptId, argument: run.argument, at: run.at, ...run.outcome }]
                : [],
            ),
            seikanRuns: runs.flatMap((run) =>
              run.kind === "seikan" && run.outcome !== null
                ? [{ command: run.command, at: run.at, ...run.outcome }]
                : [],
            ),
            shellRuns: runs.flatMap((run) =>
              run.kind === "shell" && run.outcome !== null
                ? [{ command: run.command, at: run.at, ...run.outcome }]
                : [],
            ),
          });
        });

        const url = `/reports/${card.id}`;
        deps.emit({ type: "report_published", reportId: card.id, title: card.title, url });
        // The procedure is over the moment its report exists, and the log goes with it. A second
        // publish would otherwise re-declare the same runs against a second document.
        deps.runs.end("published");
        return ok(`Published ${card.title}.`, {
          report_id: card.id,
          title: card.title,
          url,
          recipe_id: card.recipe_id,
          recipe_name: card.recipe_name,
          created_at: card.created_at,
          script_invocation_count: card.script_invocation_count,
          seikan_invocation_count: card.seikan_invocation_count,
          shell_command_count: card.shell_command_count,
          inlined_assets: args.inline_assets === true,
        });
      }),
    // One of the four the freeze lets through, because these four ARE the procedure — see
    // `freezeRefusal` in `index.ts`. This one is what ends it.
    { openDuringProcedure: true },
  );

  const listReportsTool = defineTool(
    "list_reports",
    "Published reports, newest first, with the recipe each was written under and how many runs its " +
      "numbers came out of. Everything published in this installation, unless you name a recipe — " +
      "this conversation works across all of them, so narrowing is something you ask for rather " +
      "than something that happens to you. The documents themselves are not listed; each is read " +
      "at its own url.",
    {
      recipe_id: z
        .string()
        .optional()
        .describe(
          "Narrow to the reports written under one recipe. Leave it out for everything published " +
            "in this installation.",
        ),
    },
    async (args) =>
      attempt(() => {
        // `undefined` passes straight through as "no filter", which is why there is no branch here:
        // the repository already reads an absent recipe as every recipe.
        const rows = listReports(db, {
          recipeId: args.recipe_id === undefined ? undefined : ref(db, "recipe", args.recipe_id),
        });
        return ok(`${count(rows.length, "report")}.`, {
          reports: rows.map((r) => ({
            report_id: r.id,
            title: r.title,
            url: `/reports/${r.id}`,
            recipe_id: r.recipe_id,
            recipe_name: r.recipe_name,
            script_invocation_count: r.script_invocation_count,
            seikan_invocation_count: r.seikan_invocation_count,
            shell_command_count: r.shell_command_count,
            created_at: r.created_at,
          })),
        });
      }),
    { readOnly: true },
  );

  const deleteReportTool = defineTool(
    "delete_report",
    "Remove a published report — the document itself and its whole publication record: the record " +
      "of the runs behind its numbers. That frees the scripts it recorded running to be deleted in " +
      "turn; they themselves are untouched, and so is the recipe it was published under. Nothing " +
      "about this is undoable; publishing again writes a new report, not the old one back.",
    {
      report_id: z.string().describe(refDoc("report", "list_reports")),
      confirm: z.boolean().describe("Must be true."),
    },
    async (args) =>
      attempt(() => {
        const refusal = unconfirmed(args.confirm, "a published report");
        if (refusal) return refusal;
        // Any report, not merely one this conversation published. There is one conversation, it
        // works across every recipe, and `list_reports` shows the whole archive — so a scoping
        // check here would refuse ids the model was handed a moment earlier, which reads as a bug
        // rather than as a boundary. Existence is the only question left.
        const card = getReport(db, ref(db, "report", args.report_id));
        if (!card) {
          return fail(
            "not_found",
            `no report ${args.report_id}; list_reports shows what has been published`,
          );
        }
        if (!deleteReport(db, card.id)) {
          // The card was read a statement ago, so reaching here means the row went somewhere else
          // in between. Reporting a removal that did not happen would be worse than saying so.
          throw new Refused("not_found", `report ${card.id} was already gone`);
        }
        return ok(`Removed ${card.title}.`, {
          deleted: true,
          script_invocations_removed: card.script_invocation_count,
          seikan_invocations_removed: card.seikan_invocation_count,
          shell_commands_removed: card.shell_command_count,
        });
      }),
  );

  return [publishReportTool, listReportsTool, deleteReportTool];
}

/**
 * Is this a document, or a fragment somebody meant to paste somewhere?
 *
 * Two cheap checks, both about the file being READABLE ALONE later. A fragment renders as untitled
 * plain text in a browser tab, and by the time anyone notices, the conversation that could have
 * rebuilt it is gone.
 */
function assertCompleteDocument(html: string, shown: string): void {
  const head = html.slice(0, 2000).toLowerCase();
  if (!head.includes("<!doctype html")) {
    throw new Refused(
      "invalid_request",
      `${shown} does not open with <!doctype html>, so it is a fragment rather than a document. A ` +
        `report is opened on its own months later; make it a whole page first.`,
    );
  }
  if (!/<title[\s>]/i.test(html)) {
    throw new Refused(
      "invalid_request",
      `${shown} has no <title> element. The browser tab and every bookmark of this report read ` +
        `it, so a document without one is a report nobody can find again.`,
    );
  }
}

/**
 * Point every chart-library reference at the served copy, or paste the library in.
 *
 * A draft may reference the library by any spelling — an absolute path, a home-relative one, a
 * leftover CDN URL — so the match is on the FILENAME rather than on any particular href. A report
 * whose chart library 404s is a report of blank rectangles.
 */
function rewriteChartLibrary(html: string, settings: Settings, inline: boolean): string {
  if (!inline) return html.replace(CHART_SRC, `$1$2${ASSET_HREF}$2`);

  const asset = join(paths(settings).reportAssetsDir, ECHARTS_FILENAME);
  if (!existsSync(asset)) {
    throw new Refused(
      "invalid_request",
      `the chart library has not been extracted to ${asset}, so it cannot be inlined. Publish ` +
        `without inline_assets and the report will read YewReview's served copy.`,
    );
  }
  // `</script` inside the library would end the element early. It does not occur in a minified
  // bundle, and escaping it costs one replace against a failure mode that is invisible until a
  // reader opens the page.
  const library = readFileSync(asset, "utf8").replaceAll("</script", "<\\/script");
  return html.replace(CHART_SCRIPT, () => `<script>${library}</script>`);
}
