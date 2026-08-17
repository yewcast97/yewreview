/**
 * The scripts the agent writes — what each one is for, and the program itself.
 *
 * A script is the ONLY way data reaches the measurement engine. Every series a round was measured
 * over was produced by one of these, which is what makes "where did this number come from"
 * answerable without qualification: an assessment names the preparations behind its round, each
 * preparation names a script and the argument it was given, and the script carries the program.
 * Where the bytes sat while the engine read them is part of that argument, not a fact about
 * anything, so what gets recorded is the pair that would produce them again.
 *
 * **The program is a column, and this table IS it.** `source` holds the exact bytes; there is no
 * path, no digest, and no canonical copy on disk for the row and the file to disagree about. Keeping
 * the address and the hash and never the text is the other way to avoid owning two answers to "what
 * does this script say"; owning one copy, in a row that cannot be rewritten, is the shorter way to
 * the same end. A digest here would be a checksum of a value against itself, and drift needs
 * somewhere to drift from.
 *
 * **A script is never edited, and there is no commit history either.** Its program is fixed when it
 * is saved, which is what makes a years-old `script_invocation.script_id` worth following: a
 * rewritable script is a provenance that says whatever it was rewritten to say, and a version list
 * is an archive of programs sitting in the row that is supposed to answer "what runs now". The
 * `script_moves_only_its_status` trigger enforces it, so this is not a convention only this module
 * keeps.
 *
 * **Scripts are GLOBAL.** They belong to the installation, not to a conversation: a program is a
 * program whoever wrote it, uniqueness among active scripts is checked across all of them, and no
 * recipe's deletion takes one with it. The collision message therefore has to stay readable even
 * when the script it names came from a conversation the reader cannot see — `list_scripts` is
 * global for exactly that reason.
 *
 * **A script that failed or was superseded is REPLACED, then retired.** Save the corrected
 * program as a new script and set the old one `inactive` — the only write a stored script has.
 * An inactive script is refused a run, because a method that has been superseded should not go on
 * quietly producing numbers somebody might read as current.
 * Retiring frees the program-identity for the replacement, and takes nothing away: the retired
 * script keeps every run and every preparation recorded against it, because its program is still
 * here and still explains those numbers. It does NOT free the name, and does not need to: a name is
 * unique across the active and the inactive alike and is the user's to reword either way.
 *
 * **Deletion is rows and nothing else.** There is no disk work to hand back and no ordering to get
 * right: the program was a column and it leaves with the row, and nothing a script ever produced is
 * something this database knows the name of. So `deleteScript` answers with a bare boolean, and no
 * crash can strand anything, because there is no second step for it to crash between.
 *
 * **The domain is load-bearing.** It is what a later pass has to work out from whether two scripts
 * overlap; it is required and it is meant to be true. The name is a summary and is minted from the
 * hint a caller supplies, so two callers reaching for the same words is not a collision.
 */

import type { Database } from "bun:sqlite";

import type { Script, ScriptStatus } from "../db/models.ts";
import { Refused, SCRIPT_STATUSES } from "../db/models.ts";
import { likePattern, newId, nowMs, tx } from "../db/tx.ts";
import { logDeletion } from "./logs.ts";
import { mintName } from "./naming.ts";

function requireText(value: string | undefined, field: string): string {
  const text = (value ?? "").trim();
  if (text === "") {
    throw new Refused("invalid_request", `a script needs a non-empty ${field}`);
  }
  return text;
}

/** The source, unmodified. Trimmed only to decide whether it is empty: leading whitespace is part
 * of a program's bytes, and the column has to hold what would actually run — which is also what the
 * active-source index compares one script against another by. */
function requireSource(source: string): string {
  if ((source ?? "").trim() === "") {
    throw new Refused("invalid_request", "a script needs a non-empty source");
  }
  return source;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

/**
 * What a failed write actually broke, said in the caller's terms.
 *
 * ONE uniqueness is left and it is about the PROGRAM: a source collision is the discovery that this
 * program already exists under another name, which is a discovery worth a sentence rather than a
 * constraint error. It is scoped to ACTIVE scripts, because the index is: an inactive twin is the
 * archive, and it is not in anyone's way.
 */
function collisionMessage(db: Database, source: string): string {
  const twin = db
    .query<Script, [string]>("SELECT * FROM script WHERE source = ? AND status = 'active'")
    .get(source);
  if (twin) {
    return (
      `${twin.name} already IS this exact program, byte for byte; run that script rather than ` +
      `storing a second copy of it — scripts are shared across every recipe`
    );
  }
  return (
    `this program collides with one already stored; scripts are shared across every recipe, so ` +
    `the one in the way may have been written in another conversation — list_scripts shows them all`
  );
}

/**
 * Save a program: one row, and nothing else.
 *
 * The twin check is pre-checked so that a refusal can say what actually happened, and the pre-check
 * shares a transaction with the insert so a concurrent create cannot slip between them. The partial
 * index remains the guarantee rather than the pre-check — a constraint failure is still translated
 * into the same sentence, because the caller deserves the same answer whichever of the two noticed.
 *
 * `input.name` is a HINT rather than a claim on a name: two callers reaching for the same words get
 * two names, because `mintName` distinguishes the second.
 */
export function createScript(
  db: Database,
  input: { name: string; domain: string; source: string },
): Script {
  const hint = requireText(input.name, "name");
  const domain = requireText(input.domain, "domain");
  const body = requireSource(input.source);

  try {
    return tx(db, () => {
      const taken = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM script WHERE source = ? AND status = 'active'",
        )
        .get(body);
      if (taken) throw new Refused("conflict", collisionMessage(db, body));

      const id = newId();
      const stamp = nowMs();
      db.query(
        `INSERT INTO script (id, name, domain, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).run(id, mintName(db, "script", hint), domain, body, stamp, stamp);
      return getScript(db, id)!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Refused("conflict", collisionMessage(db, body));
    }
    throw err;
  }
}

export function getScript(db: Database, id: string): Script | null {
  return db.query<Script, [string]>("SELECT * FROM script WHERE id = ?").get(id);
}

/** Scripts by name, narrowed to one standing and/or a substring of name or domain. */
export function listScripts(
  db: Database,
  filters: { query?: string | undefined; status?: ScriptStatus | undefined } = {},
): Script[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filters.status !== undefined) {
    if (!SCRIPT_STATUSES.includes(filters.status)) {
      throw new Refused(
        "invalid_request",
        `unknown status ${JSON.stringify(filters.status)}; expected one of ${SCRIPT_STATUSES.join(", ")}`,
      );
    }
    where.push("status = ?");
    params.push(filters.status);
  }
  const text = (filters.query ?? "").trim();
  if (text !== "") {
    const pattern = `%${likePattern(text)}%`;
    where.push("(name LIKE ? ESCAPE '\\' OR domain LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  return db
    .query<Script, string[]>(`SELECT * FROM script${clause} ORDER BY name COLLATE NOCASE`)
    .all(...params);
}

/**
 * Move a script between `active` and `inactive`. The only write a stored script has.
 *
 * Nothing recorded against it moves. The retired script keeps every invocation and every
 * preparation that names it, because its program is still here and still explains those numbers —
 * which is the whole difference between retiring a script and deleting one. What retiring changes
 * is what happens NEXT: `run_script` refuses it, and the PROGRAM-identity it held — unique only
 * among active scripts — is released, so a corrected copy of a retired program can be stored.
 *
 * A script may be revived, unlike a thesis: the reason abandonment is final for a thesis is that
 * runs recorded either side of it would end up under one identity, and a script has no such record
 * to confuse — its program is the same program it always was.
 *
 * Re-activating is therefore the direction that can collide, and there is exactly one way it can:
 * another active script that IS this program. The partial index is the guarantee; the pre-check is
 * the sentence, and a sentence is needed because the way out — retire the twin, or run it instead —
 * is not readable off a constraint failure.
 */
export function setScriptStatus(db: Database, id: string, status: ScriptStatus): Script {
  if (!SCRIPT_STATUSES.includes(status)) {
    throw new Refused(
      "invalid_request",
      `unknown status ${JSON.stringify(status)}; expected one of ${SCRIPT_STATUSES.join(", ")}`,
    );
  }
  return tx(db, () => {
    const current = getScript(db, id);
    if (!current) throw new Refused("not_found", `no script ${id}`);
    if (current.status === status) {
      // Refused rather than treated as a no-op: the write would move `updated_at`, which on a
      // script means "when its standing last changed" and would be saying something untrue.
      throw new Refused("conflict", `${current.name} is already ${status}`);
    }
    if (status === "active") {
      const twin = db
        .query<{ id: string; name: string }, [string, string]>(
          "SELECT id, name FROM script WHERE source = ? AND status = 'active' AND id <> ?",
        )
        .get(current.source, id);
      if (twin) {
        throw new Refused(
          "conflict",
          `${twin.name} already IS this exact program, byte for byte; reviving this one would ` +
            `file the same program twice`,
        );
      }
    }
    try {
      db.query("UPDATE script SET status = ?, updated_at = ? WHERE id = ?").run(status, nowMs(), id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Refused("conflict", collisionMessage(db, current.source));
      }
      throw err;
    }
    return getScript(db, id)!;
  });
}

/**
 * Delete a script: one row, and nothing after the commit. True once it is gone, false if there was
 * nothing to delete — a script that is already absent is not something to disagree about.
 *
 * Two kinds of standing record refuse it, for one reason wearing two shapes: what a script leaves
 * behind is somebody else's account of what happened, and it is not the script's to take away.
 *
 * A published report that recorded running it. `script_invocation.script_id` cascades, but the
 * schema's leave-only-with-their-report trigger finds the report still standing and takes the whole
 * delete down with it: the report's numbers came out of that program, and provenance pointing at a
 * script the database no longer has is provenance nobody can check.
 *
 * An assessment whose round declared this script prepared its inputs. `series_preparation.script_id`
 * cascades too, and there nothing stops it — the preparation rows would simply go, and the loss
 * would land not on the script but on the assessments, each left claiming a measurement with no
 * account of what produced the series it was read over. A round's record shrinking without anybody
 * deciding it should is exactly what a pre-check is for; the database has nothing to object with
 * here, so this module does.
 *
 * Both counts are read first so the refusal can say how many stand in the way, and can offer what
 * the caller probably wanted — setting it inactive, which retires the script and leaves both records intact.
 * Deletion is for a script that should never have been recorded at all.
 */
export function deleteScript(db: Database, id: string): boolean {
  return tx(db, () => {
    if (!getScript(db, id)) return false;
    const invoking =
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(DISTINCT report_id) AS n FROM script_invocation WHERE script_id = ?",
        )
        .get(id)?.n ?? 0;
    if (invoking > 0) {
      throw new Refused(
        "conflict",
        `${invoking} published report(s) record running this script; delete those reports first, ` +
          `or set the script inactive instead — retiring it leaves the record standing.`,
      );
    }
    const preparing =
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM series_preparation WHERE script_id = ?",
        )
        .get(id)?.n ?? 0;
    if (preparing > 0) {
      throw new Refused(
        "conflict",
        `${preparing} recorded preparation(s) name this script as what produced an assessment's ` +
          `inputs, and they would go with it — the assessments would stay, each one having been ` +
          `read off series with nothing left to say what prepared them. Set the script ` +
          `inactive instead — retiring it leaves every declaration standing.`,
      );
    }
    const row = db
      .query<Record<string, string | number | null>, [string]>("SELECT * FROM script WHERE id = ?")
      .get(id)!;
    db.query("DELETE FROM script WHERE id = ?").run(id);
    // `source` rides along, so what is witnessed is the program that was deleted rather than a note
    // that some program was — the same reasoning that keeps a report's document in its own row.
    logDeletion(db, "script", id, row);
    return true;
  });
}
