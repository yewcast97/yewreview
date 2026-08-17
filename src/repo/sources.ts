/**
 * Information sources — the address book of where numbers come from, and how far to trust each one.
 *
 * `source` is the site, `domain` says what kind of information it publishes, and `method` is prose
 * telling the agent how to actually get it. There are no preset rows and no vendor clients: every
 * row here was written down by somebody working, which is why `method` is free text rather than a
 * code path.
 *
 * Somebody, and that somebody is the person the reports belong to. A row here is a CLAIM: this table
 * is the standing account of what an installation treats as a source, every report ever published
 * leans on it, and it is an asset of whoever the reports are for. The writers below are reached from
 * the `create_information_source` / `update_information_source` / `delete_information_source` tools,
 * and what keeps the row theirs is stated there rather than here: the agent does the looking, renders
 * the row as a row block in the conversation, and writes it once the user has agreed to it.
 *
 * Self-reported is exactly as weak as it sounds, and `hosts` is ADVISORY. It used to have teeth:
 * publishing refused a reference whose url's hostname was not one of the cited source's hosts, so a
 * report could not say it read a number at some address AND attribute that address to a source
 * which, by its own written-down account, publishes somewhere else. That check went with the
 * citations themselves — what it proved was that a report was internally consistent about who said
 * what, which is a smaller claim than the rows implied, and nothing ever checked either half
 * against the world. What the column is now is the reader's own note of where a source publishes:
 * worth writing down, worth reading while working, and enforced nowhere.
 *
 * `normalizeHosts` is what keeps the column worth reading: the stored form is lowercase, punycode,
 * and nothing but a hostname, so two spellings of one address are one entry rather than two.
 *
 * Two OTHER columns carry the trust question — `hosts` answers none of it — and they are why this
 * table is not a bookmark list. `type` places the source relative to the fact — the issuer and the
 * regulator publish it, a data vendor republishes it, and sell-side, buy-side and independent
 * research each interpret it from somewhere. `failure_cases` accumulates the times it turned out to
 * be wrong, because a source that has been wrong before is a different source from one that has
 * not, and nothing else in YewReview would remember. Between them they answer the two questions
 * worth asking about a place numbers come from: how far it sits from what it reports, and how it
 * has actually done.
 *
 * `type` IS EDITABLE, and the argument against editing it is worth keeping because it is true of the
 * consequence. The type is how far the source sits from the fact, and everything written while
 * trusting it was weighed against that distance — a report that leaned on an issuer's own filing was
 * making a different bet from one that leaned on a stranger's newsletter, even where the numbers
 * agreed. Reclassifying a standing row does silently re-weigh every report that drew on it.
 *
 * What settles it is who is holding the pen. A rule against editing, and a schema trigger behind it,
 * would stop the AGENT relabelling a row mid-argument; with the address book the user's, its only
 * effect is to make a person delete a row and retype six fields to correct a misfiling of their own
 * — and deleting throws away every failure case that row had accumulated, so that "remedy" costs
 * more than the misfiling did. The consequence is said beside the field in the form instead, where
 * somebody can weigh it. Nor is the drastic act guarded: no report names the sources it drew on, so
 * a row here can be deleted whatever has been written near it, and what keeps both acts honest is
 * that the user asked for them and the agent said back what it was about to do.
 *
 * `source` is UNIQUE case-insensitively, so the same site cannot be filed twice under different
 * capitalisation. A site publishing several kinds of information describes them all in one `domain`
 * string rather than earning a second row.
 *
 * A source behind a credential records `auth_env`: the NAME of the environment variable holding
 * that credential, never the value. A database that holds secrets is a database that leaks them —
 * the value stays in the environment YewReview was started from, where a script can read it as `$NAME`
 * without anyone having written the secret down.
 */

import type { Database } from "bun:sqlite";

import type { Source, SourceType } from "../db/models.ts";
import { Refused, SOURCE_TYPES } from "../db/models.ts";
import { likePattern, newId, nowMs, tx } from "../db/tx.ts";
import { logDeletion } from "./logs.ts";
import { mintName } from "./naming.ts";

export type SourceInput = {
  source: string;
  type: SourceType;
  domain: string;
  method: string;
  /** The hostnames this source publishes at. Required, and at least one: a source nobody can name
   * an address for is a source nobody can go and check. */
  hosts: string[];
  failureCases?: string | null | undefined;
  authEnv?: string | null | undefined;
};

/**
 * Every field is optional; one left out is left alone. `failureCases` and `authEnv` read blank or
 * null as "clear it", which is the only way to say a source has no credential to read. `hosts` is
 * the one field a patch REPLACES wholesale rather than adds to — see `updateSource`.
 *
 * `type` IS PATCHABLE, with its consequence stated rather than forbidden: the type is how far a
 * source sits from the fact, everything written while trusting it was weighed against that distance,
 * and reclassifying a standing row silently re-weighs every report that drew on it. What settles it
 * is who is holding the pen. Freezing the field would be a rule about what the AGENT may do to a row
 * mid-argument, and the address book is the user's — they edit it in a form with that consequence
 * written beside the field, and a rule whose only effect is to make a person delete a row and retype
 * six fields to fix a misfiling protects nothing.
 */
export type SourcePatch = Partial<SourceInput>;

/**
 * The row as the table actually holds it: `hosts` is a JSON array in a TEXT column.
 *
 * The column is text because SQLite has no array type and a second table for two hostnames would be
 * a join on every publish; the CHECK in `schema.ts` keeps the shape honest. Everything above this
 * module sees `string[]`, and `hydrate` is the single place the two forms meet — which is why every
 * read below goes through it rather than handing a caller a `Source` whose `hosts` is secretly a
 * string.
 */
type SourceRow = Omit<Source, "hosts"> & { hosts: string };

function hydrate(row: SourceRow): Source {
  return { ...row, hosts: JSON.parse(row.hosts) as string[] };
}

/** A POSIX environment variable name. Anything else could not be exported, let alone read. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Namespaces a credential can never live in, because something scrubs them before a script runs.
 * `SEIKAN_` is stripped from this process at startup (the engine owns it and refuses to construct
 * when it meets one it does not declare); `YEWREVIEW_` is stripped from every script's own environment,
 * which is where the credential would actually be read. A source naming either would record a
 * variable guaranteed to be missing at the moment it is wanted — and the failure surfaces as a
 * fetch returning nothing, which names neither cause.
 */
const UNREADABLE_PREFIXES = ["SEIKAN_", "YEWREVIEW_"] as const;

function requireText(value: string | undefined, field: string): string {
  const text = (value ?? "").trim();
  if (text === "") {
    throw new Refused("invalid_request", `an information source needs a non-empty ${field}`);
  }
  return text;
}

function isSourceType(value: unknown): value is SourceType {
  return typeof value === "string" && (SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * The vocabulary check, and the point at which an unknown value BECOMES a `SourceType`.
 *
 * It takes `unknown` on purpose. The values reaching it from the HTTP boundary are whatever a
 * client sent, and a signature promising they are already a `SourceType` would make this check read
 * as dead code while pushing the real narrowing out to a cast somewhere that cannot perform it.
 */
function checkType(value: unknown): SourceType {
  if (!isSourceType(value)) {
    throw new Refused(
      "invalid_request",
      `unknown source type ${JSON.stringify(value)}; expected one of ${SOURCE_TYPES.join(", ")}`,
    );
  }
  return value;
}

/**
 * Characters that mean an entry is not a hostname, and the reason each one has to be refused rather
 * than parsed away.
 *
 * `new URL("http://" + entry)` is the normalizer below, and it is a URL parser: handed
 * `example.com/filings` it returns `example.com` and throws nothing away audibly. So does
 * `example.com?x`, `example.com#x` and `example.com\filings` — the parser cuts at all four and the
 * caller learns nothing. A silently truncated host would then match urls the source never claimed,
 * which is the one failure this whole column exists to prevent, so a delimiter is refused with a
 * sentence naming the entry instead. `:` and `@` are the same argument for a port and for
 * credentials — a host is neither — and whitespace is not part of any hostname.
 *
 * `*` is here for a different reason and is the one entry a reader might expect to work.
 * `http://*.example.com` parses in this engine and hands back the asterisk verbatim, so a wildcard
 * would be stored as literal characters nothing could ever match, and every reader
 * under it would be refused with a message about hosts that visibly contains the host. It is also
 * unnecessary: matching is exact OR subdomain already, so `example.com` covers what somebody
 * writing `*.example.com` meant.
 */
const NOT_A_HOSTNAME = /[/\\?#:@*\s]/;

/**
 * The hostnames a source publishes at, in the one form the publish check compares against.
 *
 * Lowercase and punycode, because that is what `new URL(...).hostname` gives for a reference url
 * too: both sides of the comparison are normalized by the same parser, so `INVESTOR.Apple.com` and
 * an IDN written in its own script match what a browser would resolve them to rather than what
 * somebody typed. Trailing dots are stripped — `example.com.` is the fully qualified spelling of
 * `example.com`, and storing both would make one of them silently not match.
 *
 * Order is preserved through the dedupe because the list is read by a person in a refusal message,
 * and the order it was written in is the order it makes sense in. An empty result is refused: the
 * schema's CHECK would refuse it too, but as a sentence about `json_array_length`.
 *
 * It takes `unknown` for the same reason `checkType` does: the shape checks below are the ones that
 * establish this is a list of strings, and a signature claiming that already were true would leave
 * them unreachable on paper while the real narrowing happened in a cast at the HTTP boundary.
 */
export function normalizeHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Refused(
      "invalid_request",
      "hosts is a list of hostnames; pass one hostname per element, as in " +
        '["investor.apple.com"]',
    );
  }
  const entries: readonly unknown[] = raw;
  const hosts: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new Refused(
        "invalid_request",
        `hosts holds hostnames as text, and ${JSON.stringify(entry)} is not text`,
      );
    }
    const text = entry.trim();
    if (text === "") {
      throw new Refused(
        "invalid_request",
        "a blank hostname is not one; drop the empty entry, or name the host this source publishes " +
          "at, as in investor.apple.com",
      );
    }
    if (NOT_A_HOSTNAME.test(text)) {
      throw new Refused(
        "invalid_request",
        `${JSON.stringify(entry)} is not a bare hostname; hosts holds the HOST alone — no scheme, ` +
          `no path, no port, no credentials and no wildcard — so write investor.apple.com rather ` +
          `than https://investor.apple.com/filings. A subdomain of a listed host already matches`,
      );
    }
    let hostname: string;
    try {
      hostname = new URL(`http://${text}`).hostname;
    } catch {
      throw new Refused(
        "invalid_request",
        `${JSON.stringify(entry)} is not a hostname anything could resolve; write the host this ` +
          `source publishes at, as in investor.apple.com`,
      );
    }
    // One trailing dot only: `example.com..` is not the fully qualified spelling of anything.
    const bare = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
    if (bare === "") {
      throw new Refused(
        "invalid_request",
        `${JSON.stringify(entry)} is not a hostname anything could resolve; write the host this ` +
          `source publishes at, as in investor.apple.com`,
      );
    }
    if (!hosts.includes(bare)) hosts.push(bare);
  }
  if (hosts.length === 0) {
    throw new Refused(
      "invalid_request",
      "an information source needs at least one host — the hostname it publishes at — because " +
        "where a source publishes is the first thing a reader checks it by",
    );
  }
  return hosts;
}

/** The credential variable's NAME, or null for "this source needs no credential". */
function checkAuthEnv(value: string | null | undefined): string | null {
  const name = (value ?? "").trim();
  if (name === "") return null;
  if (!ENV_NAME.test(name)) {
    throw new Refused(
      "invalid_request",
      `${JSON.stringify(name)} is not an environment variable name; expected letters, digits and ` +
        `underscores, not starting with a digit`,
    );
  }
  // Case-insensitively, because a name differing only in case is still the one the operator meant
  // to export, and they would spend the afternoon on why the export "did not take".
  const upper = name.toUpperCase();
  for (const prefix of UNREADABLE_PREFIXES) {
    if (upper.startsWith(prefix)) {
      throw new Refused(
        "invalid_request",
        `${JSON.stringify(name)} cannot hold a credential: YewReview removes every ${prefix}-prefixed ` +
          `variable from the environment a script runs with, so this one would never be readable. ` +
          `Export it under a name of the source's own, such as EXAMPLE_API_KEY.`,
      );
    }
  }
  return name;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

export function createSource(db: Database, input: SourceInput): Source {
  const id = newId();
  const stamp = nowMs();
  const values = [
    id,
    requireText(input.source, "source"),
    checkType(input.type),
    requireText(input.domain, "domain"),
    requireText(input.method, "method"),
    JSON.stringify(normalizeHosts(input.hosts)),
    (input.failureCases ?? "").trim() || null,
    checkAuthEnv(input.authEnv),
    stamp,
    stamp,
  ] as const;
  try {
    db.query(
      `INSERT INTO information_source
         (id, name, source, type, domain, method, hosts, failure_cases, auth_env,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(values[0], mintName(db, "information_source", input.source), ...values.slice(1));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Refused(
        "conflict",
        `an information source for ${input.source} already exists; update it instead of filing ` +
          `the same site twice`,
      );
    }
    throw err;
  }
  return getSource(db, id)!;
}

export function getSource(db: Database, id: string): Source | null {
  const row = db
    .query<SourceRow, [string]>("SELECT * FROM information_source WHERE id = ?")
    .get(id);
  return row === null ? null : hydrate(row);
}

export function listSources(db: Database, filters: { type?: SourceType | undefined } = {}): Source[] {
  if (filters.type !== undefined) {
    return db
      .query<SourceRow, [string]>(
        "SELECT * FROM information_source WHERE type = ? ORDER BY source COLLATE NOCASE",
      )
      .all(checkType(filters.type))
      .map(hydrate);
  }
  return db
    .query<SourceRow, []>("SELECT * FROM information_source ORDER BY source COLLATE NOCASE")
    .all()
    .map(hydrate);
}

/**
 * Substring search over the prose columns — the agent's browse before it adds a duplicate.
 *
 * `hosts` is deliberately not among them. It holds JSON, so a search over it would match the
 * brackets and quotes as readily as the hostnames, and a reader looking for a publisher is looking
 * at `source` and `domain`.
 */
export function searchSources(db: Database, q: string): Source[] {
  const pattern = `%${likePattern(q.trim())}%`;
  return db
    .query<SourceRow, [string, string, string, string]>(
      `SELECT * FROM information_source
        WHERE source        LIKE ? ESCAPE '\\'
           OR domain        LIKE ? ESCAPE '\\'
           OR method        LIKE ? ESCAPE '\\'
           OR failure_cases LIKE ? ESCAPE '\\'
        ORDER BY source COLLATE NOCASE`,
    )
    .all(pattern, pattern, pattern, pattern)
    .map(hydrate);
}

/**
 * Edit the fields that were named. A field left out is left alone.
 *
 * The UPDATE names every editable column and writes the current value back for any the patch did
 * not mention, so one statement covers every combination of fields and there is no assembled SQL
 * for a mistake to hide in. `name` is not among them: a name is written by `repo/naming.ts` and by
 * nothing else, because it is a summary of the row rather than part of what the source says about
 * itself.
 *
 * A `hosts` patch REPLACES the whole list rather than adding to it, and so does a `failure_cases`
 * one — a patch carries the whole field or leaves it alone. The two fields want opposite habits
 * from whoever is editing them: a failure that happened stays true forever, so lines are added and
 * none removed; where a source publishes is a fact about the present, and a company that moved its
 * filings needs the old host GONE, because an append-only host list would go on naming an address
 * the source has left.
 */
export function updateSource(db: Database, id: string, patch: SourcePatch): Source {
  return tx(db, () => {
    const current = getSource(db, id);
    if (!current) throw new Refused("not_found", `no information source ${id}`);

    const values = [
      patch.source !== undefined ? requireText(patch.source, "source") : current.source,
      patch.type !== undefined ? checkType(patch.type) : current.type,
      patch.domain !== undefined ? requireText(patch.domain, "domain") : current.domain,
      patch.method !== undefined ? requireText(patch.method, "method") : current.method,
      JSON.stringify(patch.hosts !== undefined ? normalizeHosts(patch.hosts) : current.hosts),
      patch.failureCases !== undefined
        ? (patch.failureCases ?? "").trim() || null
        : current.failure_cases,
      patch.authEnv !== undefined ? checkAuthEnv(patch.authEnv) : current.auth_env,
      nowMs(),
      id,
    ] as const;

    try {
      db.query(
        `UPDATE information_source
            SET source = ?, type = ?, domain = ?, method = ?, hosts = ?, failure_cases = ?,
                auth_env = ?, updated_at = ?
          WHERE id = ?`,
      ).run(...values);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Refused(
          "conflict",
          `another information source is already recorded for ${patch.source}`,
        );
      }
      throw err;
    }
    return getSource(db, id)!;
  });
}

/**
 * Remove a source.
 *
 * NOTHING IN THE ARCHIVE POINTS AT A SOURCE, so this always succeeds; why that is true rather than
 * an oversight is argued at the delete itself. What it costs is the row — the method somebody
 * worked out, the hosts they wrote down, every failure case the source had earned — surviving
 * afterwards only in the deletion log. That is why the tool says what the row is and asks first:
 * nothing downstream will object once it is gone.
 *
 * It is also the remedy for a source that has to GO rather than be corrected in place: every field
 * here is editable, so wanting the row gone means the address book should never have held it.
 * Delete and record afresh, which with nothing standing in the way costs no more than the retyping.
 */
export function deleteSource(db: Database, id: string): boolean {
  // NO REPORT GUARD. A report used to name the addresses it said it had read and the source that
  // publishes at each, and a source with a standing citation could not be deleted. Those rows were
  // the model's account of its own reading — nothing fetched a page, nothing compared a quoted
  // sentence to one — so they are gone, and nothing points here from a report any more. What a
  // published document says about a source is in the document, which is immutable.
  return tx(db, () => {
    // The RAW row, `hosts` still the JSON text the column holds, because the deletion log stores
    // what the table stored rather than what this module hands its callers.
    const row = db
      .query<Record<string, string | number | null>, [string]>(
        "SELECT * FROM information_source WHERE id = ?",
      )
      .get(id);
    if (row === null) return false;

    db.query("DELETE FROM information_source WHERE id = ?").run(id);
    logDeletion(db, "information_source", id, row);
    return true;
  });
}
