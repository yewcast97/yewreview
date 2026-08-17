/**
 * Targets — the instruments everything else here is ABOUT, keyed by their ticker.
 *
 * A ticker is an identity, not an attribute, so it is the primary key and there is no surrogate id
 * to keep in sync with it. Every symbol that enters YewReview passes through `normalizeTicker` first:
 * the same company arrives from a chat message, a DSL path and a filename, and unless all three
 * normalise to one string it gets filed three times. The grammar is deliberately permissive about
 * what a market may call a symbol — dots and dashes are real (`BRK.B`, `RDS-A`) — and
 * deliberately strict about length, because anything longer is a sentence, not a ticker.
 *
 * Metadata only ever accumulates. `upsertTarget` COALESCEs `market` and `unit` over the stored
 * ones, because a later call with less information must not erase what an earlier one supplied.
 * `added_at` is likewise never rewritten on conflict — it is when YewReview first heard of the
 * instrument.
 *
 * THE NAME IS THE EXCEPTION TO ALL OF THAT, and it is the one exemption in this database's naming
 * rule. Every other record's name is a summary somebody composed and may recompose; a target's is
 * the instrument's OFFICIAL FULL NAME, which is a fact about the world. So it is required when the
 * row is first written — a target nobody could name is a target nobody looked up — it is never
 * minted, and it never moves: re-stating a ticker with a DIFFERENT name is refused here rather than
 * silently kept or silently overwritten, and the schema has a trigger saying the same to anything
 * that reaches the database another way. A wrong one is corrected by deleting the target and
 * recording it again, which the deletion log witnesses.
 *
 * A target owns nothing downstream: `regime.ticker` is the only foreign key pointing at it, and it
 * carries no ON DELETE action precisely so that a thesis can never end up naming a ticker in its
 * DSL that the database no longer knows. Deleting a target is therefore either a refusal or the
 * removal of one leaf row, never a cascade. The refusal is raised here, before the foreign key
 * fires, only so the message can say how many theses are in the way instead of naming a table the
 * caller never mentioned.
 */

import type { Database } from "bun:sqlite";

import type { Target, TargetWithCounts } from "../db/models.ts";
import { Refused } from "../db/models.ts";
import { nowMs, tx } from "../db/tx.ts";
import { logDeletion } from "./logs.ts";

/** The symbol grammar: upper-case letters, digits, dots and dashes, and never more than ten
 * characters — the one spelling every stored ticker is matched against. */
const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;

export type TargetFacts = {
  ticker: string;
  /** The instrument's official full name. Required the first time a ticker is recorded, and after
   * that either omitted or repeated verbatim — never contradicted. See the header. */
  name?: string | null | undefined;
  market?: string | null | undefined;
  /** What one step of this instrument's own series means ("dollar", "percent"). A display fact;
   * omitting it means "unknown", never "same as its neighbour". */
  unit?: string | null | undefined;
};

/**
 * Strip and upcase a symbol, refusing anything that is not one.
 *
 * Throws rather than returning a fallback. A malformed ticker is a question for the user, and
 * storing it anyway would put a row in `target` that no dataset path, chart or DSL can ever
 * match — a silent dead end instead of a loud one.
 */
export function normalizeTicker(raw: string): string {
  const ticker = raw.trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) {
    throw new Refused(
      "invalid_request",
      `${JSON.stringify(raw)} is not a usable ticker: expected 1-10 characters of A-Z, 0-9, ` +
        `'.' or '-'`,
    );
  }
  return ticker;
}

/** A supplied metadata field, or null when the caller did not know it. A blank string is refused
 * rather than read as "unknown": the two are different claims, and COALESCE would happily store
 * the empty one over a name somebody already looked up. */
function fact(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Refused(
      "invalid_request",
      `a blank ${field} is not a ${field}; omit the field entirely to mean "not known", which is ` +
        `what keeps an earlier caller's ${field} from being overwritten`,
    );
  }
  return trimmed;
}

/**
 * Ensure a target exists, filling in metadata that was not known before. Idempotent, never a
 * downgrade.
 *
 * `added_at` is absent from the DO UPDATE list on purpose: it answers "since when has YewReview
 * known about this instrument", and re-stating a ticker is not learning about it again. `name` is
 * absent for a stronger reason — see the header. A first call must carry one; a later call may omit
 * it, and may repeat the stored one, but may not contradict it.
 */
export function upsertTarget(db: Database, facts: TargetFacts): Target {
  const ticker = normalizeTicker(facts.ticker);
  const name = fact(facts.name, "name");
  return tx(db, () => {
    const standing = db
      .query<{ name: string }, [string]>("SELECT name FROM target WHERE ticker = ?")
      .get(ticker);

    if (standing === null) {
      if (name === null) {
        throw new Refused(
          "invalid_request",
          `${ticker} is not recorded yet, and a new target needs the instrument's official name — ` +
            `the one its filings carry. It is the one name here that cannot be corrected later`,
        );
      }
      db.query("INSERT INTO target (name, ticker, market, unit, added_at) VALUES (?, ?, ?, ?, ?)").run(
        name,
        ticker,
        fact(facts.market, "market"),
        fact(facts.unit, "unit"),
        nowMs(),
      );
      return getTarget(db, ticker)!;
    }

    if (name !== null && name.toLowerCase() !== standing.name.toLowerCase()) {
      throw new Refused(
        "conflict",
        `${ticker} is already recorded as ${JSON.stringify(standing.name)}, and a target's name is ` +
          `the instrument's official name rather than a label to be reworded. If that one is wrong, ` +
          `delete the target and record it again`,
      );
    }
    db.query(
      `UPDATE target SET market = COALESCE(?, market), unit = COALESCE(?, unit) WHERE ticker = ?`,
    ).run(fact(facts.market, "market"), fact(facts.unit, "unit"), ticker);
    return getTarget(db, ticker)!;
  });
}

export function getTarget(db: Database, ticker: string): Target | null {
  return db
    .query<Target, [string]>("SELECT * FROM target WHERE ticker = ?")
    .get(normalizeTicker(ticker));
}

/**
 * Every target with the count a browse view needs, in one query.
 *
 * The count is of things that MEASURE the instrument — theses whose regime names it. There is
 * deliberately no count of intent: an instrument matters here because something has been measured
 * about it, and a number saying how many conversations meant to get round to it would read as work
 * that had been done.
 */
export function listTargets(db: Database): TargetWithCounts[] {
  return db
    .query<TargetWithCounts, []>(
      `SELECT t.*,
              (SELECT COUNT(*) FROM regime r WHERE r.ticker = t.ticker) AS thesis_count
         FROM target t
        ORDER BY t.ticker`,
    )
    .all();
}

/**
 * Delete a target. False if there was nothing there.
 *
 * A thesis's regime is a measurement and blocks the delete, and it is the only thing that does.
 * The count is read first so the refusal can name the obstacle — the foreign key would otherwise
 * abort with a message about `regime`, which tells the reader nothing about which theses to
 * re-point.
 */
export function deleteTarget(db: Database, ticker: string): boolean {
  const symbol = normalizeTicker(ticker);
  return tx(db, () => {
    const measuring =
      db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM regime WHERE ticker = ?")
        .get(symbol)?.n ?? 0;
    if (measuring > 0) {
      throw new Refused(
        "conflict",
        `${symbol} is measured by ${measuring} ${measuring === 1 ? "thesis" : "theses"}; ` +
          `delete them before deleting the target, or their regime would name an instrument this ` +
          `database no longer has`,
      );
    }
    const row = db
      .query<Record<string, string | number | null>, [string]>(
        "SELECT * FROM target WHERE ticker = ?",
      )
      .get(symbol);
    if (row === null) return false;

    db.query("DELETE FROM target WHERE ticker = ?").run(symbol);
    // The ticker is the id here, because the ticker is what addresses a target — the deletion log
    // holds whatever a reader would have typed to open the row while it existed.
    logDeletion(db, "target", symbol, row);
    return true;
  });
}
