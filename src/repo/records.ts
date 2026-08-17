/**
 * The record browser — every addressable row in this database, reached by walking its foreign keys,
 * and nothing else.
 *
 * ONE map, WRITTEN BY HAND. `FOREIGN_KEYS` below mirrors the DDL in `src/db/schema.ts`, key for
 * key. The alternative was to read `pragma foreign_key_list` at startup and build the graph out of
 * whatever the open file happened to contain, which is the same idea as asking a database to
 * describe itself: it always agrees with the file, including a file this build did not write, and
 * it can never disagree loudly enough to be a bug. A hand-written map can be READ by a person, can
 * carry the one thing the pragma has no column for — which junction an edge travels through — and
 * can be WRONG, which is why `tests/records.test.ts` reads every key back out of the open file with
 * `pragma foreign_key_list` and compares the two in both directions, and fails the day somebody
 * edits the schema without editing it.
 *
 * ELEVEN tables address records, and the other three are not records in two different ways.
 * `regime` is a junction, and a junction row is an EDGE: it has no identity of its own, nothing
 * points at it, and its entire content is the two ends it joins. It surfaces as the `via` on an edge
 * ("via regime"), and `getRecord` refuses to open one, because a browser that let you click into a
 * link row would be showing you two ids you were already holding. Which WAY such an edge points is
 * read off the junction's own keys rather than chosen here — see `junctionSides`.
 * `deletion_log` and `error_log` are not edges but LOGS: an account of what went wrong and what
 * left, written ABOUT records rather than being any. See `LOG_TABLES` below.
 *
 * The three run tables and `series_preparation` are records rather than not-records, which is worth
 * saying because they look like link rows at a glance. Each has an identity and a payload of its
 * own — the command that ran, what it printed, what it exited with, how long it took — so a reader
 * clicking into one learns something they were not already holding. The junction machinery could not
 * represent any of them.
 *
 * Every row leaves here as a `RecordCard` — table, id, name, label, sublabel, meta — so that one
 * component in the window draws a script, a ticker and an assessment without knowing which is which.
 * What a card does NOT carry is a census of what points at it: whether a row can be opened is a
 * property of its TABLE, read off `REFERRERS` by whoever is drawing, and whether anything is
 * actually there is the expansion's own answer. The id is ALWAYS a string on the wire. No record table
 * in this schema numbers its rows, so that costs exactly nothing; it is stated as a rule anyway,
 * because a client that had to remember which tables number theirs would get it wrong on whichever
 * one it remembered last, and the release that adds a numbered table is not the release to discover
 * that in.
 *
 * Paging is KEYSET, `before=<record id>`, never OFFSET. That is the transcript's rule for the
 * transcript's reason and one more: the agent inserts rows while this panel is open, and an offset
 * then hands the same row back on the next page or skips one entirely. A record id is a place in
 * the ordering that does not move. The ordering is (recorded-at DESC, id DESC), so the id is also
 * what separates two rows written in the same millisecond.
 *
 * ONE COLUMN IS WRITTEN AND IT IS NOT WRITTEN HERE. Every card carries `name`, the line a person
 * actually reads a row by and the word they address it with, and that column is the user's to
 * reword — but the write lives in `repo/naming.ts`, which owns minting one, the per-table
 * uniqueness check, and the refusal when a name is taken. This file projects it and nothing more,
 * which keeps the paragraph below true: the rule about what a name IS has exactly one
 * implementation, and it is not this one.
 *
 * Reads only, and one implementation per rule is the whole of why. Every write to this database goes
 * through the module that holds the rules about what such a row IS — `repo/sources.ts` for an
 * information source, `repo/recipes.ts` for a recipe, and so on for each of the rest —
 * and a write endpoint here would be a second implementation of exactly those rules. The two would
 * disagree within a month, with this one winning, since it is the surface the window believes when
 * it wants to know what is actually stored.
 */

import type { Database } from "bun:sqlite";

import { Refused } from "../db/models.ts";
import { normalizeTicker } from "./targets.ts";

/** The tables that address a record. A row in one of these has an identity, a label, and a place
 * in the browser; a row in any other table is an edge between two of them. */
export const RECORD_TABLES = [
  "information_source",
  "recipe",
  "report",
  "script",
  "script_invocation",
  "seikan_invocation",
  "series_preparation",
  "target",
  "thesis",
  "thesis_assessment",
  "trivial_shell_history_for_report",
] as const;

export type RecordTable = (typeof RECORD_TABLES)[number];

/** The link tables. Together with `RECORD_TABLES` and `LOG_TABLES` these are exactly the tables
 * the schema creates, which `tests/records.test.ts` locks against the open file — a table added to
 * the schema and to none of the three lists here would be invisible to the browser without anything
 * saying so. */
export const JUNCTION_TABLES = ["regime"] as const;

export type JunctionTable = (typeof JUNCTION_TABLES)[number];

/**
 * The tables that hold a log rather than anything addressable.
 *
 * The structural job this list does is worth naming: a table that is in the schema and in NONE of
 * the browsable lists is a table this browser cannot reach, and that has to be a decision somebody
 * wrote down rather than an omission. The panel walks `RECORD_TABLES`, so a row in one of these has
 * no card, no id on the wire, no edges, and no way to be opened; the list is here so the honesty
 * lock has somewhere to put them, and a table in the schema and in none of the three lists fails
 * `tests/records.test.ts`.
 *
 * What lands a table here is what it IS. A log is a FINISHED ACCOUNT of what went wrong and what
 * left: it describes records rather than being one, and the description outlives its subject on
 * purpose — a deletion row's whole content is a row that has been deleted, so an edge to it could
 * only ever dangle. That is also why these two tables
 * carry no foreign key in either direction (see `schema.ts`): they add no edges to `FOREIGN_KEYS`
 * and no branches to anything below. `src/repo/logs.ts` is the only module that reads or writes
 * them, and `GET /api/logs` is the only door.
 */
export const LOG_TABLES = ["deletion_log", "error_log"] as const;

/**
 * What the database does to the dependent row when the row it points at is deleted.
 *
 * Every member is spelled the way `pragma foreign_key_list` spells it, so the honesty lock compares
 * strings instead of translating between two vocabularies and getting the translation wrong. Every
 * edge this file draws is something SQLite is actually holding. `RESTRICT` is in the vocabulary and
 * in no key today: the union is the pragma's word list rather than an inventory of this schema, so a
 * key declared RESTRICT tomorrow is a line in the map below and nothing else.
 */
export type OnDelete = "CASCADE" | "RESTRICT" | "NO ACTION";

export type ForeignKey = {
  from: RecordTable | JunctionTable;
  column: string;
  to: RecordTable;
  onDelete: OnDelete;
};

/**
 * EVERY foreign key in the schema. Mirrors `src/db/schema.ts`; edit them together.
 *
 * Grouped the way the DDL groups them, so the two files can be read side by side. Nothing points
 * at a junction, which is what makes a junction an edge rather than a record.
 */
export const FOREIGN_KEYS: readonly ForeignKey[] = [
  { from: "report", column: "recipe_id", to: "recipe", onDelete: "CASCADE" },
  { from: "thesis_assessment", column: "thesis_id", to: "thesis", onDelete: "CASCADE" },
  { from: "series_preparation", column: "thesis_assessment_id", to: "thesis_assessment", onDelete: "CASCADE" },
  { from: "series_preparation", column: "script_id", to: "script", onDelete: "CASCADE" },
  { from: "regime", column: "thesis_id", to: "thesis", onDelete: "CASCADE" },
  { from: "regime", column: "ticker", to: "target", onDelete: "NO ACTION" },
  { from: "script_invocation", column: "report_id", to: "report", onDelete: "CASCADE" },
  // CASCADE, and yet a standing report still blocks deleting the script: the cascade fires the
  // schema's leave-only-with-their-report trigger, which finds the report still there and aborts.
  // The declared action and the effective one differ here, which is exactly why the map states the
  // action the pragma reports and the schema states the reason.
  { from: "script_invocation", column: "script_id", to: "script", onDelete: "CASCADE" },
  { from: "seikan_invocation", column: "report_id", to: "report", onDelete: "CASCADE" },
  { from: "trivial_shell_history_for_report", column: "report_id", to: "report", onDelete: "CASCADE" },
];

// -- what a record looks like on the wire ---------------------------------------------------------

export type RecordCard = {
  table: RecordTable;
  /** ALWAYS a string, whatever the column holds — today a uuid or a ticker, either way text. */
  id: string;
  /**
   * The row's own name, verbatim: unique within its table, the user's to reword, and what every
   * list row, graph row, chip and drag is TITLED by.
   *
   * It is not the same job as `label` and does not replace it. This one is an identity — within its
   * table it names this row and no other, and a mention on the wire is this name and its table.
   * `label` is a DESCRIPTION computed from the row's own columns, so it says what the record
   * currently is and moves when the record does. The browser shows the name first and the
   * description under it. See `repo/naming.ts`.
   */
  name: string;
  /** What the record is, in one line. */
  label: string;
  /** What tells it apart from another record carrying the same label. Absent when the table has
   * nothing to add — a recipe still active, a script still active. */
  sublabel?: string;
  /** The moment shown beside this record, epoch ms. For most tables that is when the row was
   * recorded; for the two parts of a publication that carry no moment of their own it is the
   * report's, which is when they became true, while the ORDERING falls back to declaration order. A
   * number rather than a rendered date: what "yesterday" means depends on where the reader is
   * sitting. */
  meta?: number;
};

/**
 * One edge, with the records at the far end of it.
 *
 * `column` and `onDelete` are one fact read together: the key that carries this edge, and what the
 * database does with it. In a referrer group the key points AT the record being browsed, so
 * `onDelete` says what becomes of these rows when it is deleted; in a referent group the key points
 * away from it, so `onDelete` says what becomes of THIS row when the far one goes. Either way it is
 * the declared action of the key named by `column`, which is the only reading that stays true when
 * the edge travels through a junction.
 */
export type RecordGroup = {
  table: RecordTable;
  column: string;
  onDelete: OnDelete;
  /** The junction the edge travels through, when it travels through one. */
  via?: JunctionTable;
  /** How many there are altogether, however few of them `records` carries. */
  total: number;
  records: RecordCard[];
  /** Whether `records` stops short of `total`. Page on with `before=<the last id here>`. */
  hasMore: boolean;
};

export type RecordDetail = {
  card: RecordCard;
  /** The row as the table holds it, in the types the table holds it in. Every column, for every
   * table but the one whose column is a whole document; see `rowColumns`. The addressable,
   * always-string form is on the card. */
  row: Row;
  /** What this record points at. Every edge appears, including the empty ones: an edge that exists
   * and holds nothing is an audit finding, not an absence. */
  referents: RecordGroup[];
  /** What points at this record, grouped by the table doing the pointing. */
  referrers: RecordGroup[];
};

export type RecordPage = {
  table: RecordTable;
  records: RecordCard[];
  hasMore: boolean;
};

/** A raw row. STRICT tables store text, integers and nulls, and nothing here stores a blob. */
export type Row = Record<string, string | number | null>;

/** One screenful of records with room to scroll before the next request. */
export const DEFAULT_GROUP = 20;

/** The most any single request may take. Beyond this, page with `before`. */
export const MAX_GROUP = 100;

// -- the per-table spec ---------------------------------------------------------------------------

type Bind = string | number;

type TableSpec = {
  /** The FROM clause, joins and all, so one card query serves every caller. */
  from: string;
  /** This table's alias inside `from`. */
  alias: string;
  /** The column that IS the id: a uuid, a ticker, a path, a transcript number. */
  idColumn: string;
  /** The column every listing is ordered by, newest first. */
  timeColumn: string;
  /** The projection: `id`, `name`, `label`, `sublabel`, `meta`, in that shape and no other. */
  select: string;
  /**
   * What `readRow` projects in place of `*`, for the one table where `*` is the wrong answer.
   *
   * A record's detail hands back the whole row, and for ten of the eleven tables that is exactly
   * what an auditor came for — `script.source` most of all: the program IS the record, and a
   * browser that showed everything about a script except what it does would be an index of nothing.
   * `report.content` is the opposite case. The document is the largest thing in the database, it is
   * served by id on a route of its own, and shipping it inside every detail response would make a
   * panel drawing five edges pay for megabytes of HTML nobody in it is reading. So the report
   * projects `length(content) AS content_bytes`: the reader still learns the document is there and
   * how big it is, which is the auditable fact, and the bytes are one click away.
   *
   * A projection here must keep every column `REFERENTS` names for this table — `outgoing` reads an
   * edge's value straight off this row, and a dropped key column would draw that edge as honestly
   * empty when it is nothing of the kind.
   */
  rowColumns?: string;
  /** Turn a URL-shaped id into one that can be bound. Refuses rather than returning a fallback:
   * a malformed id that reaches the query comes back as an empty result, which reads as "deleted"
   * when it means "mistyped". */
  validate: (raw: string) => Bind;
};

const UUID_HEX = /^[0-9a-f]{32}$/;

/** The uuid4-as-bare-hex shape `newId()` mints and every non-natural key in the schema uses. */
function uuidHex(table: RecordTable): (raw: string) => string {
  return (raw: string) => {
    const id = raw.trim();
    if (!UUID_HEX.test(id)) {
      throw new Refused(
        "invalid_request",
        `${JSON.stringify(raw)} is not a ${table} id; ids here are uuid4 written as 32 hex ` +
          `characters, lower case and without dashes`,
      );
    }
    return id;
  };
}

/** The first `n` characters of a text column, on one line. Newlines are folded to spaces because a
 * label is a row in a list: an assessment that starts with a blank line would otherwise draw as
 * one. */
function oneLine(column: string, n: number): string {
  return (
    `substr(replace(replace(${column}, char(13), ' '), char(10), ' '), 1, ${n}) || ` +
    `CASE WHEN length(${column}) > ${n} THEN '…' ELSE '' END`
  );
}

/** How the newest assessment read a thesis, or 'unassessed' while nobody has. Derived on every
 * read: the ledger is where a thesis's standing lives, and a column here would be a second copy. */
const LATEST_TAG = (thesis: string) =>
  `COALESCE((SELECT ta.tag FROM thesis_assessment ta WHERE ta.thesis_id = ${thesis} ` +
  `ORDER BY ta.created_at DESC, ta.rowid DESC LIMIT 1), 'unassessed')`;

const SPECS: Record<RecordTable, TableSpec> = {
  // What a recipe IS, to a reader, is the work it commissions — and the specification's own opening
  // words say that better than anything derived could. The sublabel carries the standing and ONLY
  // when it is `inactive`, on the script's precedent: putting 'active' on almost every row would
  // spend the line on the word that carries no information.
  recipe: {
    from: "recipe rc",
    alias: "rc",
    idColumn: "id",
    timeColumn: "created_at",
    select: `rc.id AS id,
             rc.name AS name,
             ${oneLine("rc.content", 60)} AS label,
             CASE WHEN rc.status = 'inactive' THEN 'inactive' END AS sublabel,
             rc.created_at AS meta`,
    // No `rowColumns`: the whole row is what an auditor came for. `content` IS the record — a
    // browser that showed everything about a recipe except what it asks for would be an index of
    // nothing — and `status` is what a reader is checking when they open one.
    validate: uuidHex("recipe"),
  },

  // The title is what a reader picks a document by; the recipe is what it was written to. The
  // document itself is a column of this table and is deliberately not in the row a detail hands
  // back — see `rowColumns`.
  report: {
    from: "report r JOIN recipe rc ON rc.id = r.recipe_id",
    alias: "r",
    idColumn: "id",
    timeColumn: "created_at",
    select: `r.id AS id,
             r.name AS name,
             r.title AS label,
             'under ' || rc.name AS sublabel,
             r.created_at AS meta`,
    rowColumns: "id, name, recipe_id, title, length(content) AS content_bytes, created_at",
    validate: uuidHex("report"),
  },

  // All three run tables carry a moment of their own rather than borrowing the report's: these rows
  // come off the generation run log, so the moment is the run's own and ordering by it is ordering
  // by what actually happened.
  script_invocation: {
    from: "script_invocation si JOIN script sc ON sc.id = si.script_id",
    alias: "si",
    idColumn: "id",
    timeColumn: "created_at",
    select: `si.id AS id,
             si.name AS name,
             sc.name || ' ' || ${oneLine("si.argument", 40)} AS label,
             CASE WHEN si.exit_code <> 0 THEN 'exit ' || si.exit_code END AS sublabel,
             si.created_at AS meta`,
    validate: uuidHex("script_invocation"),
  },

  // The engine's runs, labelled the way the shell history below is, and for the same reason: the
  // command line is the whole of what the row identifies. What it does NOT do is say "seikan" in the
  // sublabel — the table it is in has already said that, and a sublabel repeating the table's own
  // name is a line spent on the one thing the reader cannot be unsure about.
  seikan_invocation: {
    from: "seikan_invocation sk",
    alias: "sk",
    idColumn: "id",
    timeColumn: "created_at",
    select: `sk.id AS id,
             sk.name AS name,
             ${oneLine("sk.command", 60)} AS label,
             CASE WHEN sk.exit_code <> 0 THEN 'exit ' || sk.exit_code END AS sublabel,
             sk.created_at AS meta`,
    validate: uuidHex("seikan_invocation"),
  },

  // The command line is the whole of what this row identifies, so it is the label. The sublabel
  // carries the exit code and ONLY when it is not zero: putting 'exit 0' on almost every row would
  // spend the line saying nothing, where a nonzero code beside a command is the one thing an auditor
  // scanning a report's history is looking for.
  trivial_shell_history_for_report: {
    from: "trivial_shell_history_for_report sh",
    alias: "sh",
    idColumn: "id",
    timeColumn: "created_at",
    select: `sh.id AS id,
             sh.name AS name,
             ${oneLine("sh.command", 60)} AS label,
             CASE WHEN sh.exit_code <> 0 THEN 'exit ' || sh.exit_code END AS sublabel,
             sh.created_at AS meta`,
    validate: uuidHex("trivial_shell_history_for_report"),
  },

  // What the program is FOR is the description; the status rides the sublabel only when it is
  // 'inactive', because putting 'active' on almost every row would spend the line on the word that
  // carries no information — the same rule the recipe spec above follows, in the same word.
  script: {
    from: "script sc",
    alias: "sc",
    idColumn: "id",
    timeColumn: "created_at",
    select: `sc.id AS id,
             sc.name AS name,
             sc.domain AS label,
             CASE WHEN sc.status = 'inactive' THEN 'inactive' END AS sublabel,
             sc.created_at AS meta`,
    validate: uuidHex("script"),
  },

  // What produced one of a round's inputs: the program, and what it was told. The thesis beside it
  // is what tells two preparations of two rounds apart in a whole-table listing.
  series_preparation: {
    from:
      "series_preparation sp JOIN script sc ON sc.id = sp.script_id " +
      "JOIN thesis_assessment ta ON ta.id = sp.thesis_assessment_id " +
      "JOIN thesis th ON th.id = ta.thesis_id",
    alias: "sp",
    idColumn: "id",
    timeColumn: "created_at",
    select: `sp.id AS id,
             sp.name AS name,
             sc.name || ' ' || ${oneLine("sp.argument", 40)} AS label,
             'for ' || th.name AS sublabel,
             sp.created_at AS meta`,
    validate: uuidHex("series_preparation"),
  },

  // The statement itself is the description — it is what the thesis SAYS, and no other column comes
  // close. A thesis carries no standing of its own, so the sublabel asks the ledger for it, and says
  // 'unassessed' where the ledger is empty, which is a real state a container can be in.
  thesis: {
    from: "thesis th",
    alias: "th",
    idColumn: "id",
    timeColumn: "created_at",
    select: `th.id AS id,
             th.name AS name,
             ${oneLine("th.content", 60)} AS label,
             ${LATEST_TAG("th.id")} AS sublabel,
             th.created_at AS meta`,
    validate: uuidHex("thesis"),
  },

  // The verdict, then the reading behind it, in the row's own words. What tells two assessments
  // apart in a whole-table listing is which thesis they judge.
  thesis_assessment: {
    from: "thesis_assessment ta JOIN thesis th ON th.id = ta.thesis_id",
    alias: "ta",
    idColumn: "id",
    timeColumn: "created_at",
    select: `ta.id AS id,
             ta.name AS name,
             ta.tag || ' · ' || ${oneLine("ta.assessment", 40)} AS label,
             'of ' || th.name AS sublabel,
             ta.created_at AS meta`,
    validate: uuidHex("thesis_assessment"),
  },

  // The one table whose name is not ours: `name` is the instrument's official full name, so the
  // ticker — the thing everything else addresses it by — is what describes it, and the market is
  // what tells two listings of one company apart.
  target: {
    from: "target tg",
    alias: "tg",
    idColumn: "ticker",
    timeColumn: "added_at",
    select: `tg.ticker AS id,
             tg.name AS name,
             tg.ticker AS label,
             tg.market AS sublabel,
             tg.added_at AS meta`,
    validate: (raw) => normalizeTicker(raw),
  },

  information_source: {
    from: "information_source isrc",
    alias: "isrc",
    idColumn: "id",
    timeColumn: "created_at",
    select: `isrc.id AS id,
             isrc.name AS name,
             isrc.source AS label,
             isrc.type AS sublabel,
             isrc.created_at AS meta`,
    validate: uuidHex("information_source"),
  },
};

/**
 * The column each table is ADDRESSED by — the one an id on the wire names.
 *
 * Every join in this file assumes a foreign key points at exactly this column: `outgoing` matches
 * the value it read off a row against it, and `throughJunction` feeds a junction's column into it.
 * A key repointed at some other unique column of the same parent would leave both spellings legal
 * SQL and the join wrong, so `tests/records.test.ts` checks the pragma's parent column against this
 * list. Derived from `SPECS` rather than written a second time beside it.
 */
export const ID_COLUMNS = Object.fromEntries(
  RECORD_TABLES.map((table) => [table, SPECS[table].idColumn]),
) as Record<RecordTable, string>;

// -- the two directions, derived once from the one map --------------------------------------------

/**
 * One edge, without the records at the end of it — a `RecordGroup` minus the page.
 *
 * The junction's two column names are NOT here and are looked up when a query needs them. They are
 * derivable from `via` and `table` (see `junctionColumns`), and a derivable field carried around is
 * a second copy of a fact that has to be kept in step with the first.
 */
export type RecordEdge = {
  table: RecordTable;
  column: string;
  onDelete: OnDelete;
  /** The junction the edge travels through, when it travels through one. */
  via?: JunctionTable;
};

function isJunction(table: string): table is JunctionTable {
  return (JUNCTION_TABLES as readonly string[]).includes(table);
}

/**
 * A junction's two ends, told apart by what the schema does when each is deleted.
 *
 * The CASCADE end DECLARES the link and the link dies with it; the other end is what the link
 * points AT, and cannot be deleted while it stands. A report declares the theses it applies; a
 * thesis declares the targets in its regime. So a junction edge is drawn once, as a referent of the
 * declaring record and a referrer of the declared-upon one — the alternative, deriving it in both
 * directions from both ends, puts the same list of theses under a report's "points to" and its
 * "pointed at by", where one of the two is always a lie about who did the declaring.
 */
function junctionSides(junction: JunctionTable): { owner: ForeignKey; object: ForeignKey } {
  const keys = FOREIGN_KEYS.filter((fk) => fk.from === junction);
  const owner = keys.find((fk) => fk.onDelete === "CASCADE");
  const object = keys.find((fk) => fk !== owner);
  if (owner === undefined || object === undefined) {
    // Unreachable while the map matches the schema, and thrown for the same reason
    // `junctionColumns` throws: a junction with no declaring end would otherwise drop its edge out
    // of the browser in silence, and drawing a smaller graph without saying so is the one thing a
    // hand-written map is supposed to be better at than the pragma.
    throw new Error(`the foreign-key map gives ${junction} no declaring end`);
  }
  return { owner, object };
}

/**
 * A junction's two columns, as seen from an edge: `far` names the record at the other end, `near`
 * the one being browsed from. Derived rather than stored — see `RecordEdge`.
 */
function junctionColumns(via: JunctionTable, far: RecordTable): { near: string; far: string } {
  const keys = FOREIGN_KEYS.filter((fk) => fk.from === via);
  const toFar = keys.find((fk) => fk.to === far);
  const toNear = keys.find((fk) => fk !== toFar);
  if (!toFar || !toNear) {
    // Unreachable while the map matches the schema, which is what `tests/records.test.ts` keeps
    // true. Thrown rather than refused: a map that disagrees with itself is a bug in this file,
    // not something the caller asked for wrongly.
    throw new Error(`the foreign-key map has ${via} not joining ${far}`);
  }
  return { near: toNear.column, far: toFar.column };
}

/** What points at `table`, with the key that does the pointing. */
function referrerEdges(table: RecordTable): RecordEdge[] {
  const edges: RecordEdge[] = [];
  for (const fk of FOREIGN_KEYS) {
    if (fk.to !== table || isJunction(fk.from)) continue;
    edges.push({ table: fk.from, column: fk.column, onDelete: fk.onDelete });
  }
  for (const junction of JUNCTION_TABLES) {
    const sides = junctionSides(junction);
    if (sides.object.to !== table) continue;
    edges.push({
      table: sides.owner.to,
      column: sides.object.column,
      onDelete: sides.object.onDelete,
      via: junction,
    });
  }
  return edges;
}

/** What `table` points at, with the key that does the pointing. */
function referentEdges(table: RecordTable): RecordEdge[] {
  const edges: RecordEdge[] = [];
  for (const fk of FOREIGN_KEYS) {
    if (fk.from !== table) continue;
    edges.push({ table: fk.to, column: fk.column, onDelete: fk.onDelete });
  }
  for (const junction of JUNCTION_TABLES) {
    const sides = junctionSides(junction);
    if (sides.owner.to !== table) continue;
    edges.push({
      table: sides.object.to,
      column: sides.object.column,
      onDelete: sides.object.onDelete,
      via: junction,
    });
  }
  return edges;
}

/**
 * The two indexes over `FOREIGN_KEYS`, built once.
 *
 * No pair of tables is joined twice, which is what lets an edge be named by the table at its far
 * end alone — the shape `/records/:table/:id/referrers/:refTable` depends on. `tests/records.test.ts`
 * locks it, because a schema that grew a second key between the same two tables would otherwise
 * make this file quietly answer with the wrong one.
 */
export const REFERRERS = Object.fromEntries(
  RECORD_TABLES.map((table) => [table, referrerEdges(table)]),
) as Record<RecordTable, RecordEdge[]>;

export const REFERENTS = Object.fromEntries(
  RECORD_TABLES.map((table) => [table, referentEdges(table)]),
) as Record<RecordTable, RecordEdge[]>;

// -- reads ----------------------------------------------------------------------------------------

/**
 * One table, newest first.
 *
 * Whole-database, because that is what a table is. Nothing here narrows by recipe: a report is
 * reached through the recipe that wrote it and a run through its report, which is
 * the provenance chain the browser exists to make walkable, and a recipe-shaped slice of a table
 * would be a flat dump wearing a graph's clothes.
 */
export function listTable(
  db: Database,
  table: string,
  options: { limit?: number | undefined; before?: string | undefined } = {},
): RecordPage {
  const name = requireRecordTable(table);
  const limit = checkLimit(options.limit);
  const clauses: string[] = [];
  const params: Bind[] = [];

  if (options.before !== undefined) {
    const seek = cursor(db, name, options.before);
    clauses.push(seek.clause);
    params.push(...seek.params);
  }

  const rows = cards(db, name, clauses.join(" AND "), params, limit + 1);
  return { table: name, records: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * One record: the whole row, what it points at, and what points back.
 *
 * A junction is refused here rather than rendered, which is the counter-design's one hard edge: a
 * `regime` row is the sentence "this thesis is about this ticker" and it is already drawn, on both
 * of the records it joins.
 *
 * `limit` pages the REFERRERS, which are the side that grows with use — a report accumulates
 * commands, a script accumulates invocations, and "show more" is a route. The referents are drawn whole (to
 * `MAX_GROUP`, which nothing here approaches): every outgoing edge in this schema is either a single
 * column or a declaration somebody wrote by hand, so there is no second page to ask for. `hasMore`
 * is still filled in honestly, in case that ever stops being true.
 */
export function getRecord(
  db: Database,
  table: string,
  id: string,
  options: { limit?: number | undefined } = {},
): RecordDetail {
  const name = requireRecordTable(table);
  const spec = SPECS[name];
  const key = spec.validate(id);
  const limit = checkLimit(options.limit);

  const row = readRow(db, name, key);
  if (!row) throw new Refused("not_found", `no ${name} ${id}`);

  return {
    card: cards(db, name, `${qualifiedId(spec)} = ?`, [key], 1)[0]!,
    row,
    referents: REFERENTS[name].map((edge) =>
      group(db, edge, outgoing(edge, row, key), { limit: MAX_GROUP }),
    ),
    referrers: REFERRERS[name].map((edge) => group(db, edge, incoming(edge, key), { limit })),
  };
}

/**
 * One group of referrers on its own, paged. What "show more" asks for.
 *
 * The referring TABLE names the edge, because no two tables in this schema are joined twice. The
 * record is looked up first so that asking about a record that is gone is a 404 rather than a group
 * that is honestly empty — the two mean opposite things to somebody auditing.
 */
export function listReferrers(
  db: Database,
  table: string,
  id: string,
  refTable: string,
  options: { limit?: number | undefined; before?: string | undefined } = {},
): RecordGroup {
  const name = requireRecordTable(table);
  const from = requireRecordTable(refTable);
  const spec = SPECS[name];
  const key = spec.validate(id);
  const limit = checkLimit(options.limit);

  if (!readRow(db, name, key)) throw new Refused("not_found", `no ${name} ${id}`);

  const edge = REFERRERS[name].find((candidate) => candidate.table === from);
  if (!edge) {
    const known = REFERRERS[name].map((candidate) => candidate.table);
    throw new Refused(
      "not_found",
      known.length === 0
        ? `nothing in this schema points at a ${name}`
        : `nothing in ${from} points at a ${name}; what does is ${known.join(", ")}`,
    );
  }
  return group(db, edge, incoming(edge, key), { limit, before: options.before });
}

// -- the machinery --------------------------------------------------------------------------------

type Selection = { where: string; params: Bind[] };

/** Rows of the far table that point AT `nearId`. Junction-mediated or not, the selection is the
 * same shape; only which key's `onDelete` is reported differs, and that was settled in the map. */
function incoming(edge: RecordEdge, nearId: Bind): Selection {
  const spec = SPECS[edge.table];
  if (edge.via) return { where: throughJunction(edge, spec), params: [nearId] };
  return { where: `${spec.alias}.${edge.column} = ?`, params: [nearId] };
}

/** Rows of the far table that the near record points at. A direct edge reads its value off the row
 * already in hand rather than re-selecting it; a junction edge is selected by the near record's own
 * key. */
function outgoing(edge: RecordEdge, row: Row, nearId: Bind): Selection {
  const spec = SPECS[edge.table];
  if (edge.via) return { where: throughJunction(edge, spec), params: [nearId] };
  const value = row[edge.column];
  // No foreign key column in this schema is nullable, so nothing reaches this branch today. It
  // stays because the branch a graph walker needs when a key becomes optional is this one, and
  // discovering that at the point of the change is cheaper than discovering it in a stack trace.
  if (value === null || value === undefined) return { where: NOTHING, params: [] };
  return { where: `${qualifiedId(spec)} = ?`, params: [value] };
}

/** A WHERE that selects nothing, so an edge with nothing at the far end is still a group with a
 * total of zero rather than a special case every caller has to remember. */
const NOTHING = "0 = 1";

/** The far records joined to one near record through a junction. Identical in both directions —
 * a link row says the same thing read either way; only the key whose action is reported differs. */
function throughJunction(edge: RecordEdge, spec: TableSpec): string {
  const columns = junctionColumns(edge.via!, edge.table);
  return (
    `${qualifiedId(spec)} IN ` +
    `(SELECT j.${columns.far} FROM ${edge.via!} j WHERE j.${columns.near} = ?)`
  );
}

function group(
  db: Database,
  edge: RecordEdge,
  selection: Selection,
  page: { limit: number; before?: string | undefined },
): RecordGroup {
  const spec = SPECS[edge.table];
  const total =
    db
      .query<{ n: number }, Bind[]>(
        `SELECT COUNT(*) AS n FROM ${spec.from} WHERE ${selection.where}`,
      )
      .get(...selection.params)?.n ?? 0;

  const clauses = [selection.where];
  const params = [...selection.params];
  if (page.before !== undefined) {
    const seek = cursor(db, edge.table, page.before);
    clauses.push(seek.clause);
    params.push(...seek.params);
  }
  const rows = cards(db, edge.table, clauses.join(" AND "), params, page.limit + 1);

  const made: RecordGroup = {
    table: edge.table,
    column: edge.column,
    onDelete: edge.onDelete,
    total,
    records: rows.slice(0, page.limit),
    hasMore: rows.length > page.limit,
  };
  if (edge.via) made.via = edge.via;
  return made;
}

type CardRow = {
  id: string;
  name: string;
  label: string;
  sublabel: string | null;
  meta: number;
};

/**
 * EVERY CARD ON THE WIRE IS BUILT HERE, and a card is exactly what its table's `select` says a row
 * of that table IS — `id`, `name`, `label`, `sublabel`, `meta`, in that shape and no other.
 *
 * IT USED TO CARRY ONE DERIVED COLUMN MORE. A `has_referrers` bit rode every card, probing each
 * referrer key to say whether anything actually pointed at this row, because the window drew a row's
 * expand arrow from it. The window now draws that arrow from the SCHEMA — a table whose rows can be
 * pointed at gets one whether or not anything has been recorded yet — so the bit had nothing left to
 * decide. Which is the better disclosure as well as the cheaper query: an edge that exists and holds
 * nothing is a fact about this archive worth being able to see, and a reader who could not open it
 * had no way to tell an empty edge from an absent one.
 */
function cards(
  db: Database,
  table: RecordTable,
  where: string,
  params: Bind[],
  limit: number,
): RecordCard[] {
  const spec = SPECS[table];
  const clause = where === "" ? "" : ` WHERE ${where}`;
  return db
    .query<CardRow, Bind[]>(
      `SELECT ${spec.select} FROM ${spec.from}${clause}
        ORDER BY ${qualified(spec, spec.timeColumn)} DESC, ${qualifiedId(spec)} DESC
        LIMIT ?`,
    )
    .all(...params, limit)
    .map((row) => {
      const card: RecordCard = {
        table,
        id: String(row.id),
        name: row.name,
        label: row.label,
        meta: row.meta,
      };
      if (row.sublabel !== null) card.sublabel = row.sublabel;
      return card;
    });
}

/**
 * Where to resume from, given the id of the last record the caller already holds.
 *
 * The cursor is the record's own place in the ordering — its timestamp and its id — read back out
 * of the table, which is why `before` names a record rather than a position. A record that has been
 * deleted since the caller drew it is refused rather than silently restarting the walk at the top,
 * because a page that begins again reads as new records arriving.
 */
function cursor(
  db: Database,
  table: RecordTable,
  before: string,
): { clause: string; params: Bind[] } {
  const spec = SPECS[table];
  const key = spec.validate(before);
  const time = qualified(spec, spec.timeColumn);
  const row = db
    .query<{ at: number }, [Bind]>(
      `SELECT ${time} AS at FROM ${spec.from} WHERE ${qualifiedId(spec)} = ?`,
    )
    .get(key);
  if (!row) {
    throw new Refused(
      "not_found",
      `no ${table} ${before} to page before; 'before' names the last record already in hand, and ` +
        `that one is gone`,
    );
  }
  return {
    clause: `(${time} < ? OR (${time} = ? AND ${qualifiedId(spec)} < ?))`,
    params: [row.at, row.at, key],
  };
}

function readRow(db: Database, table: RecordTable, key: Bind): Row | null {
  const spec = SPECS[table];
  return db
    .query<Row, [Bind]>(
      `SELECT ${spec.rowColumns ?? "*"} FROM ${table} WHERE ${spec.idColumn} = ?`,
    )
    .get(key);
}

function qualified(spec: TableSpec, column: string): string {
  return `${spec.alias}.${column}`;
}

function qualifiedId(spec: TableSpec): string {
  return qualified(spec, spec.idColumn);
}

/**
 * The table name, or a refusal that names the whitelist.
 *
 * A junction gets its own sentence. "regime is not a table" would be a lie the user could check,
 * and "not found" alone would leave them looking for a typo in a name that is spelled right.
 */
export function requireRecordTable(table: string): RecordTable {
  if ((RECORD_TABLES as readonly string[]).includes(table)) return table as RecordTable;
  if (isJunction(table)) {
    throw new Refused(
      "not_found",
      `${table} is a link between records rather than a record: it is drawn as the "via ${table}" ` +
        `edge on each of the two records it joins, and the row itself holds nothing else. The ` +
        `tables that address records are ${RECORD_TABLES.join(", ")}`,
    );
  }
  throw new Refused(
    "not_found",
    `${JSON.stringify(table)} is not a record table; the ones that address records are ` +
      `${RECORD_TABLES.join(", ")}`,
  );
}

/**
 * A URL-shaped id turned into one that can be bound, by whichever rule this table's ids follow.
 *
 * Exported for `repo/naming.ts`, which writes the one column this module does not own and has to
 * reach a row by the same id the reads do. Going through the spec rather than around it is the whole
 * point: a ticker is normalised on the way in, so `PATCH /api/records/target/nvda/name` and
 * `.../NVDA/name` reach the same row, exactly as `getRecord` already makes them do.
 */
export function validateRecordId(table: RecordTable, raw: string): Bind {
  return SPECS[table].validate(raw);
}

function checkLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_GROUP;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_GROUP) {
    throw new Refused(
      "invalid_request",
      `limit must be a whole number between 1 and ${MAX_GROUP}; page on with 'before' rather than ` +
        `asking for a whole table at once`,
    );
  }
  return limit;
}
