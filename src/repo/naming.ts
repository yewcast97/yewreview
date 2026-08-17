/**
 * The names: minting one when a record is written, resolving one somebody has said, and changing
 * one when the user asks.
 *
 * WHAT A NAME IS. A short line that says, condensed, what the row holds — `semis-inventory-glut`,
 * `nvda-q3`, `sec-gov-filings`. It is minted from a hint the writer supplies and it is the user's to
 * reword afterwards, because the writer's first summary of a thing is often not the one a reader
 * wants six months later. A suffix of four random base36 characters is appended ONLY when the
 * obvious name is already taken: a name that reads as a summary is the point, and `nvda-q3-4k7p`
 * reads as a summary with a serial number stapled to it.
 *
 * WHAT IT IS FOR, AND HOW THAT CHANGED. It used to be true that nothing read this column — it was a
 * label for a human eye and every address was an id. That is no longer the contract. A name is now
 * how a row is ADDRESSED: the window draws it, a drag puts it on the wire as `@table:name`, and
 * `resolveRecordId` below turns the pair back into an id for a tool. Ids did not go away and are
 * still what a tool result hands back — they are stable under a rename, and a name is not — but a
 * reader and the model now share one vocabulary for pointing at a row instead of two.
 *
 * UNIQUENESS IS ONE MECHANISM AND IT IS THE INDEX. Within a table, a UNIQUE index makes duplication
 * impossible even for SQL written by hand. Across tables nothing is claimed and nothing needs to be:
 * a name is never read on its own, only ever alongside the table it belongs to, so a recipe and a
 * thesis may both be called `semis inventory` without either being ambiguous. `nameTaken` below is
 * the pre-check that turns the index's constraint error into a sentence, not a second guarantee.
 *
 * `target` IS THE EXEMPTION. Its name is the instrument's official full name — a fact somebody
 * looked up rather than a summary anybody composed — so it is never minted here and never renamed:
 * `renameRecord` refuses the table outright, and `db/schema.ts` has a trigger saying the same thing
 * to whoever reaches the database another way.
 *
 * A RENAME DOES NOT TOUCH `updated_at`. On a script that column means "when its standing last
 * changed" and on a source it means "when what we know about it last changed"; a rename is neither,
 * and letting it move the stamp would make the archive's own history slightly false in order to
 * record something no rule reads.
 */

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

import { Refused } from "../db/models.ts";
import { tx } from "../db/tx.ts";
import { ID_COLUMNS, requireRecordTable, validateRecordId } from "./records.ts";
import type { RecordTable } from "./records.ts";

/**
 * The longest name a rename may set.
 *
 * A rule about the UI rather than about the database, which is why the schema has no CHECK for it:
 * this is drawn in a 260px graph row and in a composer chip, and past this it is an ellipsis with a
 * uuid's worth of characters hidden behind it. Minted names sit well under it.
 */
export const MAX_NAME_LENGTH = 80;

/** How much of the writer's hint a minted name is allowed to be. A handful of words. */
const HINT_MAX = 40;

/** Base36, so 1.7 million per slug. Long enough that a second collision is a curiosity rather than
 * a thing that happens, short enough to read as noise rather than as an id. */
const SUFFIX_LENGTH = 4;

/** How many suffixed names to try before admitting something is wrong. A second collision on four
 * base36 characters is already implausible; twenty is a loop bound rather than a policy. */
const MINT_ATTEMPTS = 20;

/**
 * A hint reduced to a name: lowercase, alphanumeric runs joined by hyphens, cut to `HINT_MAX`.
 *
 * MAY COME BACK EMPTY, and that is a supported answer rather than a failure. A thesis named in
 * Chinese, a ticker that is all punctuation, a title of nothing but symbols — each slugifies to
 * nothing, and `composeName` falls back to the suffix alone. A transliteration would be this module
 * inventing a name for something it cannot read, and a placeholder like `untitled` would collide
 * with the next one.
 *
 * The cut is on a character count and not on a word boundary, deliberately: a hint is a hint, and a
 * name that is one character longer because a word survived intact is not worth the branch. A
 * trailing hyphen left by the cut is trimmed, because `nvda--4k7p` reads as a mistake.
 */
export function slugify(hint: string): string {
  const runs = hint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return runs.slice(0, HINT_MAX).replace(/-+$/g, "");
}

/** Four random base36 characters. `randomBytes` rather than `Math.random`, not because a name is a
 * secret but because the whole job of this string is not to collide. */
function suffix(): string {
  const bytes = randomBytes(SUFFIX_LENGTH);
  let out = "";
  for (const byte of bytes) out += (byte % 36).toString(36);
  return out;
}

/**
 * The slug on its own, or the slug with a fresh suffix once the plain one is spoken for.
 *
 * The bare form first is the whole point of the shape: a name is a condensed summary, and the
 * summary of the first thesis about NVDA's third quarter should be `nvda-q3` rather than
 * `nvda-q3-4k7p`. Only the second such thesis pays for the ambiguity it created.
 */
export function composeName(hint: string, distinguish: boolean): string {
  const slug = slugify(hint);
  if (slug === "") return suffix();
  return distinguish ? `${slug}-${suffix()}` : slug;
}

/**
 * Whether this table already holds a row of this name.
 *
 * One indexed lookup. The column is `COLLATE NOCASE`, so `=` here is case-insensitive and matches
 * what the unique index enforces — a check that were case-sensitive would pass and then be aborted
 * by the index, turning a readable refusal into a constraint error. `except` is what makes a rename
 * to the name a row already has a no-op rather than a conflict with itself.
 */
export function nameTaken(
  db: Database,
  table: RecordTable,
  name: string,
  except?: string | number,
): boolean {
  const idColumn = ID_COLUMNS[table];
  const row = db
    .query<{ id: string }, [string]>(`SELECT ${idColumn} AS id FROM ${table} WHERE name = ?`)
    .get(name);
  if (row === null) return false;
  return except === undefined || String(row.id) !== String(except);
}

/**
 * A fresh name for a row about to be written. Called inside the transaction that writes it.
 *
 * The plain slug is tried once and every retry after that carries a NEW suffix rather than
 * appending to the old one, so a collision produces another name of the same shape instead of a
 * visibly patched one. Throwing after twenty attempts is a loop bound: reaching it means the random
 * source is not random, and silently producing a twenty-first name would hide that.
 */
export function mintName(db: Database, table: RecordTable, hint: string): string {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    const name = composeName(hint, attempt > 0);
    if (!nameTaken(db, table, name)) return name;
  }
  throw new Error(`could not mint a unique name for a ${table} after ${MINT_ATTEMPTS} attempts`);
}

/** The id of the row this table holds under this name, or null. Case-insensitive, like the index. */
export function findByName(db: Database, table: RecordTable, name: string): string | null {
  const idColumn = ID_COLUMNS[requireRecordTable(table)];
  const row = db
    .query<{ id: string }, [string]>(`SELECT ${idColumn} AS id FROM ${table} WHERE name = ?`)
    .get(name.trim());
  return row === null ? null : String(row.id);
}

/**
 * What somebody said, turned into an id: either already one, or a name this table holds.
 *
 * THE ID IS TRIED FIRST, and deliberately. A user may rename a row to anything, id-shaped strings
 * included, and a resolver that guessed would then answer differently depending on what somebody
 * had typed into a name field. Trying the id shape first makes the answer a function of the
 * argument alone.
 *
 * The refusal names both ways in, because a caller holding a stale name and a caller holding a
 * mistyped id need the same next step and neither can tell from the outside which they are.
 */
export function resolveRecordId(db: Database, table: RecordTable, ref: string): string {
  // Checked even though the parameter is typed, because both serving surfaces validate arguments
  // with zod and the tests call handlers WITHOUT it — on purpose, to reach the refusals underneath.
  // Without this a junction name would build SQL around an `ID_COLUMNS` entry that does not exist
  // and come back as a raw constraint error, which is the one shape this surface must never emit:
  // `attempt` converts only `Refused`, so anything else is reported to the model as a defect.
  requireRecordTable(table);
  const wanted = ref.trim();
  if (wanted !== "") {
    let key: string | number | null = null;
    try {
      key = validateRecordId(table, wanted);
    } catch {
      key = null;
    }
    if (key !== null) {
      const idColumn = ID_COLUMNS[table];
      const row = db
        .query(`SELECT ${idColumn} AS id FROM ${table} WHERE ${idColumn} = ?`)
        .get(key) as { id: string } | null;
      if (row !== null) return String(row.id);
    }
    const byName = findByName(db, table, wanted);
    if (byName !== null) return byName;
  }
  throw new Refused(
    "not_found",
    `no ${table} answers to ${JSON.stringify(ref)} — give either its id or its name, exactly as ` +
      `the record carries it`,
  );
}

/**
 * Change one record's name. The only write against this column anywhere outside a row's own
 * creation.
 *
 * VALIDATION IS ABOUT BEING A NAME: present, one line, and short enough to draw. Control characters
 * are refused because a name with a newline in it is a name that is one thing in the database and
 * another on screen.
 *
 * `target` is refused outright — its name is the instrument's official name rather than a summary
 * anybody composed, so correcting one means deleting the target and recording it again. The schema
 * has a trigger saying the same thing; this is where the sentence lives.
 *
 * The UNIQUE index is caught as well as pre-checked and re-issued as the same sentence: it should
 * be unreachable, and an unreachable path that answers with a raw constraint error is one nobody
 * can act on.
 */
export function renameRecord(db: Database, table: string, id: string, rawName: string): void {
  const name = requireRecordTable(table);
  const key = validateRecordId(name, id);
  const wanted = rawName.trim();

  if (name === "target") {
    throw new Refused(
      "invalid_request",
      "a target's name is the instrument's official name and is never edited; delete the target " +
        "and record it again under the right name",
    );
  }
  if (wanted === "") {
    throw new Refused("invalid_request", "a record's name cannot be blank");
  }
  if (wanted.length > MAX_NAME_LENGTH) {
    throw new Refused(
      "invalid_request",
      `a record's name is a condensed summary rather than a description: ${MAX_NAME_LENGTH} characters at most, and this one is ${wanted.length}`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(wanted)) {
    throw new Refused("invalid_request", "a record's name is one line, with no control characters");
  }

  tx(db, () => {
    if (nameTaken(db, name, wanted, String(key))) {
      throw new Refused(
        "conflict",
        `another ${name} already answers to ${JSON.stringify(wanted)}; within a table one name ` +
          `always means one row`,
      );
    }
    let changes: number;
    try {
      changes = db.query(`UPDATE ${name} SET name = ? WHERE ${ID_COLUMNS[name]} = ?`).run(
        wanted,
        key,
      ).changes;
    } catch (cause) {
      if (String(cause).includes("UNIQUE")) {
        throw new Refused(
          "conflict",
          `another ${name} already answers to ${JSON.stringify(wanted)}`,
        );
      }
      throw cause;
    }
    if (changes === 0) throw new Refused("not_found", `no ${name} ${id}`);
  });
}
