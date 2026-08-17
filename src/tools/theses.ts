/**
 * Theses: mechanical statements the engine can measure, and the ledger of readings each has
 * collected.
 *
 * Five rules shape this surface.
 *
 * **A thesis's identity is the engine's to compute.** `create_thesis` spawns the venv interpreter to
 * obtain seikan's canonical hash and the tickers the document measures (see `seikanCli.ts`). A DSL
 * that does not validate therefore has no hash and cannot be stored at all, which is what keeps the
 * table from filling with documents nothing can run. When the engine is not installed it refuses
 * rather than storing a thesis without an identity — a thesis nobody can measure is not a thesis,
 * and inventing a hash would make two different documents look like one.
 *
 * **A thesis never changes after it is stored.** Statement, document and hash are fixed at creation
 * — the schema's triggers make that true of the file rather than of this surface — so identity is
 * settled once and every measurement is evidence about exactly those bytes forever. A thesis that
 * needs a different document is a different thesis: create it, and file the old one `abandoned`.
 * Only its NAME moves, because a name is a summary of the thesis rather than part of it.
 *
 * **A thesis is BORN MEASURED, and judgement is a LEDGER.** `create_thesis` stores the container
 * and files the first round in one transaction: measure the document first — `run_seikan` takes
 * the `dsl_json` itself while nothing is stored — and hand the run here with the tag and the
 * reasoning, so a thesis you store is never on record unmeasured. What the one act does NOT change
 * is the ledger: the first assessment is a row like any other, appended to and never overwritten,
 * so a thesis re-read in June does not erase what was thought of it in March. `assess_thesis`
 * files every round after the first. A thesis with an empty ledger remains a readable state, though
 * not one this surface mints — and `abandoned` is the LAST row a ledger can take, a first row
 * included.
 *
 * **The container is the user's claim; the ledger is this surface's reading of it.** That is why
 * `create_thesis` carries `CONSENT` and `assess_thesis` deliberately does not. A thesis states what
 * the USER believes is happening, in their terms and about their money, so both halves are shown and
 * agreed before anything is stored: the statement, and the DSL, which is only this surface's
 * translation of that statement into something the engine can run. What does NOT bend to agreement
 * is the translation. A document nudged toward the answer its commissioner hoped for still measures
 * something, looks exactly like a measurement, and is wrong in every future reading of it — so a
 * flattering formulation is argued with and left unstored rather than written down as a measurement
 * of a claim it does not test. Mistakes in the claim itself are a different thing and are corrected
 * out loud while drafting; the user is not served by a hypothesis they did not mean to state. How
 * the measurement then READS is judged on this surface's own authority, which is why the ledger asks
 * nobody — and the first round riding the consented call does not move that seam: the reading is
 * SHOWN beside the draft, because the last thing on their screen is what they are agreeing to, but
 * consent is to the STORING, and a tag is not theirs to bargain up. A thesis they will only store
 * under a friendlier reading than the numbers earned goes unstored.
 *
 * **A thesis's targets are its REGIME.** They are the measured instruments, never a search axis —
 * the conjunction the thesis must hold across or, in basket mode, the basket it ranks within.
 * `tickers` exists as an override for the case the document's own target keys cannot answer, not as
 * a place to list everything the idea touches. Like everything else here it is written once.
 */

import { z } from "zod";

import { TAGS } from "../db/models.ts";
import {
  assessThesis,
  createAssessedThesis,
  deleteThesis,
  getThesis,
  latestAssessment,
  listAssessments,
  listPreparations,
  listTheses,
  searchTheses,
} from "../repo/theses.ts";
import type { ToolDeps } from "../protocol/types.ts";
import { fail, ok } from "../protocol/types.ts";
import { attempt, CONSENT, count, ref, refDoc, unconfirmed } from "./common.ts";
import { defineTool } from "./def.ts";
import { dslIdentity } from "./seikanCli.ts";

/** The minimum an assessment can be and still be an account of anything. The schema insists the
 * column is there and non-blank; the length is this surface's rule, because a two-word assessment
 * passes every constraint and tells a future reader nothing. */
const MIN_ASSESSMENT = 20;

const TAG_DOC =
  "approven = statistically solid across the whole declared grid; insightful = worth considering " +
  "but short of solid; abandoned = out of service, emptied out by the evidence or superseded by a " +
  "replacement — the LAST row a ledger can take, never a deletion, and nothing may be filed after " +
  "it.";

/** What `list_theses` may be narrowed by: the three tags, and the state of never having been read.
 * An empty ledger is a real answer to "how does this thesis stand", so it is a filter value rather
 * than something a caller has to notice by its absence. */
const TAG_FILTERS = [...TAGS, "unassessed"] as const;

const TICKERS_DOC =
  "Override the instruments this thesis is about. Leave it out: they are read off the target keys " +
  "the document declares, which is right whenever those keys are the symbols themselves. Supply it " +
  "only when the keys genuinely cannot say — a document whose targets are named descriptively — " +
  "and name only what the thesis MEASURES; the benchmark is not one. Whichever way they are " +
  "arrived at, every one of them has to be RECORDED ALREADY: call upsert_target first, with the " +
  "instrument's official name, because storing a thesis will not invent one.";

/** The preparations block, ONE schema for the two tools that file a round. The first reading rides
 * `create_thesis` and every later one rides `assess_thesis`; a copy each would be the same shape
 * twice, drifting apart one describe-edit at a time. */
const PREPARATIONS_SCHEMA = z
  .array(
    z.strictObject({
      script_id: z
        .string()
        .describe(
          "The recorded script whose program produced this input series — its id or its name.",
        ),
      argument: z
        .string()
        .describe('The argument line that run was given. Pass "" when it took none.'),
    }),
  )
  .optional()
  .describe(
    "What prepared the series this round was measured over — one entry per input, naming the " +
      "script and what it was told. This is what makes the numbers reproducible: where the " +
      "CSV sat while the engine read it is an argument to a run, not a fact about a thesis, " +
      "so what is recorded is the pair that would produce it again. Leave it out when the " +
      "round measured series somebody else prepared and this round has nothing of its own to " +
      "declare — that is honest; inventing entries is not.",
  );

/** How a spent or unknown run id is refused, by both redeemers, in one sentence. */
const NO_SUCH_RUN = (runId: string): string =>
  `no run ${runId} is waiting to be filed. A run is redeemable once, and only until this process ` +
  `restarts — if it has been spent or the server was restarted since, measure again and file that ` +
  `run's reading.`;

export function build(deps: ToolDeps) {
  const { db } = deps;

  const createThesisTool = defineTool(
    "create_thesis",
    "Store a thesis with its first reading — one act, one transaction, so a thesis you store is " +
      "never on record unmeasured: what it claims in plain language, the measurement document " +
      "that makes it checkable, and the first round of judgement off a run of that document. " +
      "Measure the document FIRST: run_seikan takes the dsl_json itself while nothing is stored, " +
      "and the run you hand here must be of these exact bytes, verified by the engine's canonical " +
      "hash. The document is validated and hashed before anything is stored, so a DSL that does " +
      "not validate is refused with the engine's own complaint. It is born finished: statement and " +
      "document never change after this call. A correction is a NEW thesis: store the replacement " +
      "and abandon the old one with assess_thesis. " +
      CONSENT +
      " BOTH HALVES ARE AGREED, not the statement alone: the DSL is your translation of their claim " +
      "into something measurable, so show it beside the statement and say in words what it will " +
      "actually measure. Correct their mistakes out loud while you draft — a forgotten lag, a " +
      "benchmark that flatters, a window drawn around the answer — because a claim they did not " +
      "mean to make is not the one they want on record. But the translation is where agreement " +
      "stops being the test: never bend the document toward a formulation because they pushed for " +
      "it. A measurement shaped to please whoever commissioned it measures nothing, and storing one " +
      "files a document whose every future reading is already wrong. Say what the flattering form " +
      "would really measure, and store it only as a measurement of the claim it does test. The " +
      "first reading is SHOWN beside the draft — a second row block, for the assessment — but it " +
      "is not theirs to bargain: consent is to storing the thesis, and the tag is your own reading " +
      "of the run. If they want it stored under a friendlier tag than the numbers earned, it goes " +
      "unstored.",
    {
      name: z
        .string()
        .describe(
          "A few words the thesis's name is minted from — what it claims, condensed. The name " +
            "actually recorded comes back on the row, and may carry a suffix if those words were " +
            "already taken; it is never a collision, and the user can reword it afterwards.",
        ),
      content: z
        .string()
        .describe(
          "What the thesis claims, in the user's own terms, including the mechanism they believe " +
            "is behind it. The statement is the idea; the DSL is only how it gets measured.",
        ),
      dsl_json: z
        .string()
        .describe(
          "The measurement document as JSON text. Stored byte-for-byte as you write it, and never " +
            "editable afterwards — this document is the thesis's identity.",
        ),
      tickers: z.array(z.string()).optional().describe(TICKERS_DOC),
      tag: z.enum(TAGS).describe(TAG_DOC),
      assessment: z
        .string()
        .min(MIN_ASSESSMENT)
        .describe(
          "Why this tag is the right reading of the first run's numbers: the specific evidence, " +
            "and what it does NOT support. This opens the ledger, so the round after it is read " +
            "as the answer to it. Never tag approven on one flattering cell out of many.",
        ),
      seikan_run_id: z
        .string()
        .describe(
          "The run this first reading came off — run_seikan, handed this same dsl_json, since " +
            "nothing is stored yet for an id to name. The engine's report is redeemed by this id " +
            "and stored exactly as the engine wrote it — you never retype it. The run must be of " +
            "THIS document, verified by its canonical hash. No run, no thesis.",
        ),
      series_preparations: PREPARATIONS_SCHEMA,
    },
    async (args) => {
      const identity = await dslIdentity(deps, args.dsl_json);
      if (!identity.ok) return fail(identity.kind, identity.message);
      return attempt(() => {
        // Redeemed before the write, like `assess_thesis` below and with the same consequence,
        // stated rather than fixed: a write the transaction then refuses has still spent the run,
        // and every refusal here says "measure again". Redeem-once is the fidelity rule; a
        // peek-then-commit split would move gate state around a transaction for no user-visible
        // win.
        const run = deps.runs.redeem(args.seikan_run_id);
        if (run === null) return fail("not_found", NO_SUCH_RUN(args.seikan_run_id));
        // Equality by construction: `identity.hash` and `run.dslHash` both come out of the same
        // engine function, so byte-different spellings of one document still agree and a genuinely
        // different document cannot.
        if (run.dslHash !== identity.hash) {
          return fail(
            "invalid_request",
            `run ${args.seikan_run_id} measured a different document; the first reading is filed ` +
              `against the exact bytes being stored, and a report from another document says ` +
              `nothing about these. Measure this dsl_json with run_seikan and store with that run.`,
          );
        }
        const { thesis, assessment } = createAssessedThesis(
          db,
          {
            name: args.name,
            content: args.content,
            dslJson: args.dsl_json,
            dslHash: identity.hash,
            tickers: args.tickers ?? identity.tickers,
          },
          {
            tag: args.tag,
            assessment: args.assessment,
            seikanReport: run.report,
            preparations: (args.series_preparations ?? []).map((prep) => ({
              scriptId: ref(db, "script", prep.script_id),
              argument: prep.argument,
            })),
          },
        );
        return ok(`Stored ${thesis.name} and filed ${args.tag} as its first reading.`, {
          thesis,
          assessment,
          preparations: listPreparations(db, assessment.id),
        });
      });
    },
  );

  const assessThesisTool = defineTool(
    "assess_thesis",
    "File one round of judgement on a stored thesis — every round after the first, which " +
      "create_thesis files with the container: how it read this time, why, and the measurement " +
      "the reading came off. This APPENDS — it does not replace the last one — so the ledger is " +
      "the thesis's history and re-reading it costs nothing that was already written down. Read the " +
      "rounds already there first and say what has changed since, because the row after them is " +
      "read as the answer to them. abandoned is how a thesis leaves service, emptied out by the " +
      "evidence or superseded by a corrected thesis; it is the last row a ledger can take, so say " +
      "which of the two it was and name the replacement when there is one. Abandoning deletes " +
      "nothing; reports written while this thesis stood say what they say, and they are immutable.",
    {
      thesis_id: z.string().describe(refDoc("thesis", "list_theses")),
      tag: z.enum(TAGS).describe(TAG_DOC),
      assessment: z
        .string()
        .min(MIN_ASSESSMENT)
        .describe(
          "Why this tag is the right reading of THIS round's numbers: the specific evidence, what " +
            "it does NOT support, and how the reading has moved since the rounds already in the " +
            "ledger. Never tag approven on one flattering cell out of many.",
        ),
      seikan_run_id: z
        .string()
        .describe(
          "The run this reading came off, as run_seikan handed it back. The engine's report is " +
            "redeemed by this id and stored exactly as the engine wrote it — you never retype it, " +
            "which is the point: what is filed beside a judgement has to be the numbers rather " +
            "than a copy that went through a summary on the way. The run must be of THIS thesis's " +
            "document. No run, no assessment: measure first.",
        ),
      series_preparations: PREPARATIONS_SCHEMA,
    },
    async (args) =>
      attempt(() => {
        const run = deps.runs.redeem(args.seikan_run_id);
        if (run === null) return fail("not_found", NO_SUCH_RUN(args.seikan_run_id));
        if (run.thesisId === null) {
          // A document-mode run belongs to `create_thesis`: it measured bytes nothing had stored,
          // and this ledger files readings of theses the archive holds. The id check below could
          // not say this — null equals no thesis id — so the sentence is its own.
          return fail(
            "invalid_request",
            `run ${args.seikan_run_id} measured a document that was not stored yet; that ` +
              `measurement belongs to create_thesis, which files the first reading with the ` +
              `container. This ledger takes readings of stored theses — measure this thesis by ` +
              `its id and file that run.`,
          );
        }
        const thesisId = ref(db, "thesis", args.thesis_id);
        if (run.thesisId !== thesisId) {
          return fail(
            "invalid_request",
            `run ${args.seikan_run_id} measured a different thesis; a reading is filed against the ` +
              `document it was read off, and a report from another one says nothing about this one`,
          );
        }
        const assessment = assessThesis(db, thesisId, {
          tag: args.tag,
          assessment: args.assessment,
          seikanReport: run.report,
          preparations: (args.series_preparations ?? []).map((prep) => ({
            scriptId: ref(db, "script", prep.script_id),
            argument: prep.argument,
          })),
        });
        return ok(`Filed ${args.tag}.`, {
          assessment,
          preparations: listPreparations(db, assessment.id),
        });
      }),
  );

  const getThesisTool = defineTool(
    "get_thesis",
    "One thesis in full: its statement, its measurement document, its regime, every round of " +
      "judgement it has collected oldest first, and what prepared the inputs of the newest round. " +
      "The ledger is the thesis's history — read it before assessing again, because the round you " +
      "are about to file is read as the answer to the ones already there.",
    { thesis_id: z.string().describe(refDoc("thesis", "list_theses")) },
    async (args) =>
      attempt(() => {
        const thesis = getThesis(db, ref(db, "thesis", args.thesis_id));
        if (!thesis) return fail("not_found", `no thesis ${args.thesis_id}`);
        const newest = latestAssessment(db, thesis.id);
        // UNSCOPED, because there is no boundary here for a scope to draw. A thesis is global,
        // there is one conversation, and every report in the archive is reachable from it — so a
        // filtered list would hide rows the very next `delete_thesis` refusal counts, which reads
        // as a bug rather than as a boundary. There is no separate count either: this list IS the
        // count.
        return ok(`${thesis.name} (${thesis.latest_tag ?? "unassessed"}).`, {
          thesis,
          assessments: listAssessments(db, thesis.id),
          latest_assessment_id: newest?.id ?? null,
          // The newest round's only, because that is the round a report may apply and the one the
          // next reading has to better. Every other round's are on the assessment they were filed
          // with, in the record browser.
          latest_preparations: newest ? listPreparations(db, newest.id) : [],
        });
      }),
    { readOnly: true },
  );

  const listThesesTool = defineTool(
    "list_theses",
    "Stored theses, most recently judged first, optionally narrowed to how the newest round of a " +
      "thesis read it or to one instrument in the regime. 'unassessed' is a filter beside the " +
      "three tags, because a container nobody has measured yet is a state worth browsing for " +
      "rather than an absence. Abandoned theses list like any others — filter by tag when only the " +
      "ones still standing matter.",
    {
      tag: z
        .enum(TAG_FILTERS)
        .optional()
        .describe(
          "How the NEWEST round read it — the ledger's current answer, not a tag the thesis " +
            "carries. unassessed = a container nobody has measured yet.",
        ),
      ticker: z.string().optional(),
    },
    async (args) =>
      attempt(() => {
        const rows = listTheses(db, { tag: args.tag, ticker: args.ticker });
        return ok(`${count(rows.length, "thesis", "theses")}.`, { theses: rows });
      }),
    { readOnly: true },
  );

  const searchThesesTool = defineTool(
    "search_theses",
    "Search theses by name and statement — never by their DSL. What you are looking for is the " +
      "idea, and searching the document would rank a thesis that merely reads a 'revenue' series " +
      "above one that argues about revenue.",
    { q: z.string().describe("A substring of a name or a statement.") },
    async (args) =>
      attempt(() => {
        const rows = searchTheses(db, args.q);
        return ok(`${count(rows.length, "thesis", "theses")}.`, { theses: rows });
      }),
    { readOnly: true },
  );

  const deleteThesisTool = defineTool(
    "delete_thesis",
    "Remove a thesis with its whole ledger and its regime. This is for a MISTAKE, not a verdict: a " +
      "duplicate, the wrong instrument, a document stored in error. A thesis the evidence emptied " +
      "out is not a mistake — it was measured, and the measurement is worth the shelf space, so " +
      "assess it abandoned and let that last round say what the evidence was. Nothing here is " +
      "recoverable; every round of judgement ever filed against it goes too, and no report stands " +
      "in the way — a published document is immutable, so what it says about this thesis is not " +
      "changed by the thesis leaving, only by nobody being able to look the measurement up any " +
      "more. The deletion log keeps the row.",
    {
      thesis_id: z.string().describe(refDoc("thesis", "list_theses")),
      confirm: z.boolean().describe("Must be true."),
    },
    async (args) =>
      attempt(() => {
        const refusal = unconfirmed(args.confirm, "a thesis and every round of judgement on it");
        if (refusal) return refusal;
        if (!deleteThesis(db, ref(db, "thesis", args.thesis_id))) {
          return fail("not_found", `no thesis ${args.thesis_id}`);
        }
        return ok("Removed, with its ledger and its regime.", { deleted: true });
      }),
  );

  return [
    createThesisTool,
    assessThesisTool,
    getThesisTool,
    listThesesTool,
    searchThesesTool,
    deleteThesisTool,
  ];
}
