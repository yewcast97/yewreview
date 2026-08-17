/**
 * Theses, their regime, and the ledger of assessments each one has collected.
 *
 * **The DSL arrives already canonicalised; this module never computes a hash.** `dsl_hash` is
 * seikan's canonical identity — it normalises the document through seikan's schema before
 * hashing, so two spellings of the same rules share a hash and a document that fails validation
 * has no hash at all. seikan is Python and lives in the sandbox venv, so the hash and the measured
 * tickers are produced by the seikan CLI *before* a write reaches here and are stored verbatim.
 * Re-deriving either in this process would mean importing seikan into Bun, which is not possible,
 * or reimplementing it, which is the same rule written twice and eventually two rules.
 *
 * **`dsl_json` is stored exactly as the caller wrote it.** Not re-serialised: the hash already
 * carries identity across spellings, so rewriting the text here would gain nothing and would throw
 * away the document the author actually reads when they open the thesis.
 *
 * **The regime is the measured instruments, never a search axis.** Depending on the thesis's
 * `target_mode` it is the conjunction the thesis must hold across or the basket it ranks within —
 * either way the measured ones only. A thesis that measures NVDA against SPY is a thesis about
 * NVDA, and filing it under SPY as well would list it among SPY's measurements and return it from
 * every browse for SPY. It is written once, by `createThesis`, and never moves again, because the
 * document it was read off never moves either.
 *
 * **A thesis is a CONTAINER and is never edited.** Its statement, document and identity are fixed
 * at creation — the schema's `thesis_is_immutable` trigger makes that true of the file rather than
 * of this module — so every measurement ever recorded against a thesis is evidence about exactly
 * those bytes. A thesis whose document needs correcting is a DIFFERENT thesis: abandon this one and
 * store the replacement. Only the NAME moves, and it moves because it is a summary of the thesis
 * rather than part of it.
 *
 * **Judgement is a LEDGER, not a column.** `assessThesis` appends one row: a tag, the reasoning
 * behind it, the engine's own report for the run it was read off, and the declarations of what
 * prepared that run's inputs. Nothing is overwritten, which is what one standing account per thesis
 * could never offer: a thesis re-read in June does not erase what was thought of it in March, and
 * "when did this stop being approven" is a question the rows can answer. What the thesis is
 * currently worth is the NEWEST row — derived on every read, never stored, because a column here
 * would be a second copy of the ledger's answer and second copies go stale.
 *
 * **A thesis with no assessment is live and untagged.** An empty ledger is a real, readable state
 * rather than a broken one — `createThesis` writes the container and no judgement, and
 * `"unassessed"` browses for exactly that — but not a state the tool surface mints: it stores
 * through `createAssessedThesis`, so a thesis an agent files arrives with its first round already
 * under it.
 *
 * **`abandoned` is a filing, not a deletion — and it is FINAL.** The document, the regime and every
 * assessment stay readable, and a report published while it stood says what it always said. It
 * releases nothing: a name is unique across the abandoned and the standing alike, which is a
 * stronger rule than one that let an abandonment release the name, and one nobody has to reason
 * about a ledger to apply. Nothing may be filed after an abandonment — not even a better-worded
 * one: in a ledger the last row is the answer, so appending to a closed one is exactly the revival
 * the rule forbids. Runs recorded before an abandonment and runs recorded after it would end up
 * under a single identity, as if the measurement had never ended.
 *
 * Nothing on disk belongs to a thesis: runs write no files this database describes, and no column
 * anywhere names one. `deleteThesis` therefore returns no paths — the rows-then-bytes ordering
 * other deletions in this codebase obey simply never comes up here.
 */

import type { Database } from "bun:sqlite";

import type { SeriesPreparation, Tag, Thesis, ThesisAssessment } from "../db/models.ts";
import { Refused, TAGS } from "../db/models.ts";
import { likePattern, newId, nowMs, tx } from "../db/tx.ts";
import { logDeletion } from "./logs.ts";
import { getTarget, normalizeTicker } from "./targets.ts";
import { mintName } from "./naming.ts";

/** A thesis row as the table stores it, before the regime and the ledger's answer are hydrated on. */
type ThesisRow = Omit<Thesis, "regime" | "latest_tag" | "assessed_at">;

const COLUMNS = "id, name, content, dsl_json, dsl_hash, created_at";

const ASSESSMENT_COLUMNS = "id, name, thesis_id, tag, assessment, seikan_report, created_at";

const PREPARATION_COLUMNS = "id, name, thesis_assessment_id, script_id, argument, created_at";

/**
 * One column of the NEWEST assessment of a thesis, as a scalar subquery.
 *
 * Newest is `(created_at DESC, rowid DESC)`. The rowid tiebreak is sound only because assessments
 * never leave on their own — the schema's leave-only-with-their-thesis trigger sees to that — so
 * within a surviving thesis the rowids are monotone in filing order and two rows written in the
 * same millisecond keep the order they were written in.
 */
const LATEST = (thesis: string, column: string) =>
  `(SELECT la.${column} FROM thesis_assessment la WHERE la.thesis_id = ${thesis} ` +
  `ORDER BY la.created_at DESC, la.rowid DESC LIMIT 1)`;

export type ThesisDraft = {
  /** What the thesis should be CALLED, roughly — a few words the name is minted from. */
  name: string;
  /** The natural-language statement. A thesis is an idea first; the DSL is how it gets measured. */
  content: string;
  /** The DSL document as text, stored byte-for-byte. */
  dslJson: string;
  /** seikan's canonical identity hash for that document, computed by the CLI. */
  dslHash: string;
  /** The tickers the document measures, as the CLI read them off its declared target keys. */
  tickers: readonly string[];
};

/** What prepared one of a round's input series: the program, and what it was told. */
export type PreparationDecl = {
  scriptId: string;
  /** The argument line that run was given; `''` when it took none. */
  argument: string;
};

export type AssessmentDraft = {
  tag: Tag;
  /** Why that tag is the right reading of this round's numbers. */
  assessment: string;
  /** The engine's own report for the run this reading came off, verbatim. */
  seikanReport: string;
  /** What produced the series the run measured over. May be empty — a thesis measured over series
   * somebody else prepared has nothing of its own to declare, and saying so is honest. */
  preparations: readonly PreparationDecl[];
};

function required(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Refused("invalid_request", what);
  return trimmed;
}

/** Normalise and de-duplicate a regime. The regime is a SET — its primary key says so — and a
 * caller naming one ticker twice is asserting the same conjunct twice, which is not a mistake with
 * some other meaning. A ticker that is not a ticker is still refused, unnormalised, by
 * `normalizeTicker`. */
function regimeOf(tickers: readonly string[]): string[] {
  return [...new Set(tickers.map(normalizeTicker))];
}

/**
 * Replace a thesis's regime wholesale.
 *
 * A THESIS NO LONGER CONJURES AN INSTRUMENT, and what closed that door is what a target became
 * rather than a tightening for its own sake. `regime.ticker` carries no ON DELETE and its foreign
 * key demands the row exist, and a thesis used to upsert one on the way past — which was harmless
 * while a target was a ticker and some optional metadata. It is not harmless now: a target's
 * `name` is the instrument's OFFICIAL name and cannot be corrected afterwards, so a row conjured
 * out of a document's target keys would be a permanent claim about the world that nobody made.
 * Recording an instrument is its own act, and the refusal below says so.
 */
function replaceRegime(db: Database, thesisId: string, tickers: readonly string[]): void {
  db.query("DELETE FROM regime WHERE thesis_id = ?").run(thesisId);
  const insert = db.query("INSERT INTO regime (thesis_id, ticker) VALUES (?, ?)");
  for (const ticker of tickers) {
    if (getTarget(db, ticker) === null) {
      throw new Refused(
        "not_found",
        `${ticker} is not recorded, and a thesis measures instruments this database already ` +
          `holds. Record it first, with the instrument's official name — a target's name cannot ` +
          `be corrected once written, which is why one is never invented from a document's ` +
          `target keys`,
      );
    }
    insert.run(thesisId, ticker);
  }
}

/** Attach each row's regime and the ledger's current answer, in two queries for the whole page
 * rather than two per thesis. */
function hydrate(db: Database, rows: ThesisRow[]): Thesis[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const holes = ids.map(() => "?").join(", ");
  const byThesis = new Map<string, string[]>(ids.map((id) => [id, []]));
  const links = db
    .query<{ thesis_id: string; ticker: string }, string[]>(
      `SELECT thesis_id, ticker FROM regime
        WHERE thesis_id IN (${holes})
        ORDER BY ticker`,
    )
    .all(...ids);
  for (const link of links) byThesis.get(link.thesis_id)?.push(link.ticker);

  const standing = new Map<string, { tag: Tag; created_at: number }>();
  const latest = db
    .query<{ thesis_id: string; tag: Tag; created_at: number }, string[]>(
      `SELECT thesis_id, tag, created_at FROM thesis_assessment ta
        WHERE ta.thesis_id IN (${holes})
          AND ta.id = ${LATEST("ta.thesis_id", "id")}`,
    )
    .all(...ids);
  for (const row of latest) standing.set(row.thesis_id, row);

  return rows.map((row) => ({
    ...row,
    regime: byThesis.get(row.id) ?? [],
    latest_tag: standing.get(row.id)?.tag ?? null,
    assessed_at: standing.get(row.id)?.created_at ?? null,
  }));
}

function readOne(db: Database, id: string): Thesis {
  const row = db.query<ThesisRow, [string]>(`SELECT ${COLUMNS} FROM thesis WHERE id = ?`).get(id);
  if (!row) throw new Refused("not_found", `no thesis ${id}`);
  return hydrate(db, [row])[0]!;
}

/**
 * Store a new thesis: the statement, the document that makes it measurable, and its regime.
 *
 * THE INNER HALF. The tool surface stores through `createAssessedThesis` below, so a thesis
 * reaches the archive with its first round already under it; this half stays its own function
 * because the container and the ledger have different writers — `assessThesis` files every round,
 * the first included — and because an empty ledger is a readable state rather than a broken one.
 *
 * There is no name collision to refuse: `draft.name` is a HINT, and `mintName` distinguishes it
 * from whatever this table already holds. A second thesis about the same idea is an ordinary thing
 * to store — the first one may still be standing, and which of the two is live is the ledger's
 * answer rather than a naming rule's.
 */
export function createThesis(db: Database, draft: ThesisDraft): Thesis {
  const hint = required(draft.name, "a thesis needs a name");
  const content = required(
    draft.content,
    "a thesis needs its natural-language statement, not just a DSL; the statement is the idea " +
      "and the DSL is only how it gets measured",
  );
  const dslJson = required(draft.dslJson, "a thesis needs a DSL document");
  const dslHash = required(
    draft.dslHash,
    "a thesis needs seikan's canonical hash of its DSL; run the seikan CLI on the document " +
      "first, which also proves the document validates",
  );
  const regime = regimeOf(draft.tickers);

  return tx(db, () => {
    const id = newId();
    db.query(`INSERT INTO thesis (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`).run(
      id,
      mintName(db, "thesis", hint),
      content,
      dslJson,
      dslHash,
      nowMs(),
    );
    replaceRegime(db, id, regime);
    return readOne(db, id);
  });
}

/**
 * File one round of judgement on a thesis, with everything that round rests on, in one write.
 *
 * The tag, the reasoning, the engine's report and the preparation declarations are one act: an
 * assessment that landed without its evidence would be an opinion the database presents as a
 * measurement. A blank assessment or a blank report is refused here and only here — the schema can
 * insist the columns are there, not that they say anything — which makes the checks below
 * load-bearing rather than belt-and-braces.
 *
 * Appending after an `abandoned` row is refused OUTRIGHT. Abandonment ends a measurement, and rows
 * filed either side of it would put runs recorded before and after under one identity as if nothing
 * had ended. The `abandoned_theses_are_never_revived` trigger is the guarantee; this pre-check is
 * the sentence, and it has to be a sentence because the way forward is not obvious from a
 * constraint failure: the replacement is a NEW thesis.
 */
export function assessThesis(
  db: Database,
  thesisId: string,
  draft: AssessmentDraft,
): ThesisAssessment {
  if (!TAGS.includes(draft.tag)) {
    throw new Refused(
      "invalid_request",
      `unknown tag ${JSON.stringify(draft.tag)}; expected one of ${TAGS.join(", ")}`,
    );
  }
  const assessment = required(
    draft.assessment,
    "an assessment must carry the reasoning that produced its tag; the tag says what was decided " +
      "and the assessment is the only record of why",
  );
  const seikanReport = required(
    draft.seikanReport,
    "an assessment carries the engine's own report for the run it was read off; without it the " +
      "row is a verdict with nothing under it, and nobody can check the reading later",
  );

  return tx(db, () => {
    const thesis = readOne(db, thesisId);
    if (thesis.latest_tag === "abandoned") {
      throw new Refused(
        "conflict",
        `${thesis.name} is abandoned, and an abandoned thesis is never revived or re-judged: ` +
          `abandoning was its last assessment. Store the replacement as a new thesis.`,
      );
    }
    const id = newId();
    const stamp = nowMs();
    db.query(
      `INSERT INTO thesis_assessment (${ASSESSMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      // The thesis and the verdict: `semis-inventory-approven`. A reading has nothing else to be
      // named after, and which thesis and which way is what somebody scanning a ledger wants.
      mintName(db, "thesis_assessment", `${thesis.name} ${draft.tag}`),
      thesisId,
      draft.tag,
      assessment,
      seikanReport,
      stamp,
    );

    const insert = db.query(
      `INSERT INTO series_preparation (${PREPARATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const decl of draft.preparations) {
      const scriptId = required(
        decl.scriptId,
        "a preparation names the script that produced the series; list_scripts has the ids",
      );
      if (typeof decl.argument !== "string") {
        throw new Refused(
          "invalid_request",
          "a preparation's argument is the line that run was given; pass '' when it took none " +
            "rather than leaving it out",
        );
      }
      // The name comes back with the existence, because it is what this preparation's label is
      // minted from — a preparation is named after the program that produced the series.
      const script = db
        .query<{ name: string }, [string]>("SELECT name FROM script WHERE id = ?")
        .get(scriptId);
      if (!script) {
        throw new Refused(
          "not_found",
          `no script ${scriptId}; a preparation names a script this database holds, and ` +
            `list_scripts is where the ids are`,
        );
      }
      insert.run(
        newId(),
        mintName(db, "series_preparation", script.name),
        id,
        scriptId,
        decl.argument,
        stamp,
      );
    }
    return getAssessment(db, id)!;
  });
}

/**
 * Store a thesis WITH its first round of judgement: container, regime, assessment and its
 * preparations, one transaction — a thesis you store is never on record unmeasured.
 *
 * COMPOSED, NOT REWRITTEN. `createThesis` writes the container and `assessThesis` stays the
 * ledger's one writer for every round, the first included — so the blank-field refusals, the
 * unknown-script and unrecorded-ticker refusals, and the preparation writes are the same code
 * either way, and an act that any part refuses rolls back WHOLE: no thesis without its first
 * reading, no reading without its evidence. The outer `tx` is what makes that true (`db/tx.ts` —
 * nesting joins as a SAVEPOINT), and the re-read at the end is what puts the first round's
 * `latest_tag` on the returned row.
 *
 * The abandoned pre-check inside `assessThesis` reads a one-row-old empty ledger and passes, which
 * also means a first round tagged `abandoned` stores and closes the ledger at birth — legal, and
 * occasionally right: a replacement thesis whose first honest reading is that the evidence already
 * emptied it out.
 */
export function createAssessedThesis(
  db: Database,
  draft: ThesisDraft,
  first: AssessmentDraft,
): { thesis: Thesis; assessment: ThesisAssessment } {
  return tx(db, () => {
    const stored = createThesis(db, draft);
    const assessment = assessThesis(db, stored.id, first);
    return { thesis: readOne(db, stored.id), assessment };
  });
}

export function getAssessment(db: Database, id: string): ThesisAssessment | null {
  return (
    db
      .query<ThesisAssessment, [string]>(
        `SELECT ${ASSESSMENT_COLUMNS} FROM thesis_assessment WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

/** The reading a thesis currently stands under, or null while nobody has judged it. */
export function latestAssessment(db: Database, thesisId: string): ThesisAssessment | null {
  return (
    db
      .query<ThesisAssessment, [string]>(
        `SELECT ${ASSESSMENT_COLUMNS} FROM thesis_assessment
          WHERE thesis_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(thesisId) ?? null
  );
}

/** The whole ledger, OLDEST first — the order it was written in, which is the order it reads as a
 * history. Callers wanting the current answer ask `latestAssessment` rather than taking an end off
 * this list. */
export function listAssessments(db: Database, thesisId: string): ThesisAssessment[] {
  return db
    .query<ThesisAssessment, [string]>(
      `SELECT ${ASSESSMENT_COLUMNS} FROM thesis_assessment
        WHERE thesis_id = ? ORDER BY created_at, rowid`,
    )
    .all(thesisId);
}

export function listPreparations(db: Database, assessmentId: string): SeriesPreparation[] {
  return db
    .query<SeriesPreparation, [string]>(
      `SELECT ${PREPARATION_COLUMNS} FROM series_preparation
        WHERE thesis_assessment_id = ? ORDER BY created_at, rowid`,
    )
    .all(assessmentId);
}

export function getThesis(db: Database, id: string): Thesis | null {
  const row = db.query<ThesisRow, [string]>(`SELECT ${COLUMNS} FROM thesis WHERE id = ?`).get(id);
  return row ? hydrate(db, [row])[0]! : null;
}

/**
 * Browse theses, optionally by how they currently read or by a ticker in their regime.
 *
 * Most recently JUDGED first, falling back to when the container was stored for one nobody has
 * assessed; `rowid` breaks a tie between two written in the same millisecond so a page boundary
 * lands in the same place every time. `"unassessed"` is a filter value beside the three tags,
 * because an empty ledger is a state worth browsing for rather than an absence. Abandoned theses
 * list like any others — an audit that hid them would answer a different question than the one
 * asked — so a caller who wants only live ones filters by tag.
 */
export function listTheses(
  db: Database,
  filter: { tag?: Tag | "unassessed" | undefined; ticker?: string | undefined } = {},
): Thesis[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.tag !== undefined) {
    if (filter.tag === "unassessed") {
      where.push(`${LATEST("thesis.id", "tag")} IS NULL`);
    } else {
      if (!TAGS.includes(filter.tag)) {
        throw new Refused(
          "invalid_request",
          `unknown tag ${JSON.stringify(filter.tag)}; expected one of ${TAGS.join(", ")} or ` +
            `"unassessed"`,
        );
      }
      where.push(`${LATEST("thesis.id", "tag")} = ?`);
      params.push(filter.tag);
    }
  }
  if (filter.ticker !== undefined) {
    where.push("id IN (SELECT thesis_id FROM regime WHERE ticker = ?)");
    params.push(normalizeTicker(filter.ticker));
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .query<ThesisRow, string[]>(
      `SELECT ${COLUMNS} FROM thesis${clause}
        ORDER BY COALESCE(${LATEST("thesis.id", "created_at")}, thesis.created_at) DESC,
                 rowid DESC`,
    )
    .all(...params);
  return hydrate(db, rows);
}

/**
 * Substring search over a thesis's name and its statement — NEVER over its DSL.
 *
 * The DSL is not prose: searching it would match on column names, operator spellings and series
 * keys, so a search for "revenue" would rank a thesis that merely reads a `revenue` series above
 * one that argues about revenue. What a person is searching for is the idea, and the idea is in the
 * two prose columns.
 */
export function searchTheses(db: Database, q: string): Thesis[] {
  const text = required(
    q,
    "a blank search matches every thesis; call listTheses if that is what you want",
  );
  const pattern = `%${likePattern(text)}%`;
  const rows = db
    .query<ThesisRow, [string, string]>(
      `SELECT ${COLUMNS} FROM thesis
        WHERE name LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
        ORDER BY COALESCE(${LATEST("thesis.id", "created_at")}, thesis.created_at) DESC,
                 rowid DESC`,
    )
    .all(pattern, pattern);
  return hydrate(db, rows);
}

/**
 * Delete a thesis with its whole ledger and its regime. False if there was nothing to delete.
 *
 * NOTHING REFUSES IT, and the argument for that stands beside the delete itself. What leaves is the
 * whole record: the container, every round of judgement ever filed against it, and every regime row
 * naming an instrument it measured — the ledger and the regime by cascade. The deletion log's copy
 * of the container is all that is left afterwards, which is why the tool makes the caller confirm.
 *
 * Abandoning is not deleting, and nothing about how much is in the way decides between them —
 * nothing ever is. What decides is what happened: deletion is for a thesis that should never have
 * been stored, and a measured one that the evidence emptied out is abandoned instead, which keeps
 * the document and every reading of it on the shelf where somebody can still learn from them.
 */
export function deleteThesis(db: Database, id: string): boolean {
  // NO REPORT GUARD, and its absence is the decision rather than an oversight. A report used to
  // point at the readings it said it applied, and a thesis with a standing report over it could
  // not be deleted; that table was the model's own account of its argument, nothing verified it,
  // and it is gone. What a published document says about a thesis now lives in the document,
  // which is immutable — so deleting the thesis cannot change what any report claims, only what
  // the archive can still show you about it. The deletion log holds the whole row.
  return tx(db, () => {
    const row = db
      .query<Record<string, string | number | null>, [string]>("SELECT * FROM thesis WHERE id = ?")
      .get(id);
    if (row === null) return false;

    db.query("DELETE FROM thesis WHERE id = ?").run(id);
    // The ledger and the regime go by cascade and are deliberately not logged; the argument for
    // that lives on `deleteRecipe` in `repo/recipes.ts`.
    logDeletion(db, "thesis", id, row);
    return true;
  });
}
