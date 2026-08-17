/**
 * The record browser's shapes, MIRRORED from `src/repo/records.ts`.
 *
 * A copy, for the same reason `protocol.ts` is one and with the same guard. The repository imports
 * `bun:sqlite` and reaches `node:crypto` through `db/tx.ts`, so type-checking it inside the web
 * project — which deliberately declares no server types at all — fails before it starts, and giving
 * the window Bun's globals to fix that would be paying for thirteen strings with the whole reason the
 * two projects are separate.
 *
 * `tests/webProtocol.test.ts` holds this honest: it asserts every type below is mutually assignable
 * with the repository's own, and that `RECORD_TABLES` here is exactly the array there. Edit them in
 * the same commit; the test will insist.
 *
 * Under each shape is the SCHEMA that checks an answer has it, locked to the declaration above it by
 * `exact` so the two cannot drift. That lock and the mirror lock answer different questions: the
 * mirror says this window and the repository mean the same shape, and the schema says the bytes that
 * arrived are one. A record page is drawn straight into a graph, so a `records` that turned out to be
 * a string, or a card with no `label`, would be a browser rendering `undefined` at the reader with
 * every appearance of confidence.
 */

import { z } from "zod";

import { exact } from "./schema.ts";

/** The tables that address a record. A junction row is an EDGE and is not one of these, and neither
 * is a log row: `deletion_log` and `error_log` describe records rather than being any, have no id on
 * the wire and no card, and are read through `GET /api/logs` alone. */
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

/** Built from the array rather than spelled again, which is the whole reason the array is a value:
 * a schema listing eleven names by hand is a twelfth place for a table to be missing from. */
const recordTableSchema = exact<RecordTable>()(z.enum(RECORD_TABLES));

/** The link tables. They surface as the `via` on an edge, never as a record. */
export const JUNCTION_TABLES = ["regime"] as const;

export type JunctionTable = (typeof JUNCTION_TABLES)[number];

const junctionTableSchema = exact<JunctionTable>()(z.enum(JUNCTION_TABLES));

/** What the database does to the dependent row when the row it points at is deleted. Exactly the
 * three values `pragma foreign_key_list` can produce: every edge the browser draws is a real key. */
export type OnDelete = "CASCADE" | "RESTRICT" | "NO ACTION";

const onDeleteSchema = exact<OnDelete>()(z.enum(["CASCADE", "RESTRICT", "NO ACTION"]));

export type RecordCard = {
  table: RecordTable;
  /** ALWAYS a string, whatever the column holds — today a uuid or a ticker, either way text. The
   * rule is stated rather than derived because a window that had to remember which tables number
   * their rows would get it wrong on whichever one it remembered last. */
  id: string;
  /**
   * The row's own name, verbatim, and what every list row, graph row, chip
   * and drag in this window is TITLED by.
   *
   * Not a replacement for `label` and not the same job. This one is an IDENTITY — unique across
   * every record table, stable while the row lives, and the user's to change. `label` is a
   * DESCRIPTION the server computes from the row's own columns, so it moves when the record does.
   * The window draws the name first and the description under it, and neither side reads either for
   * anything but drawing. See `src/repo/naming.ts`.
   */
  name: string;
  label: string;
  sublabel?: string;
  /** The moment shown beside this record, epoch ms. On the three run tables it is when the command
   * STARTED rather than when the report was published: those rows come off the generation log, so
   * the moment is when the work actually happened. */
  meta?: number;
};

/**
 * The tables a row of which can be OPENED — the ones something in the schema is able to point at.
 *
 * MIRRORS A DERIVATION RATHER THAN A LIST: it is the tables `REFERRERS` in `src/repo/records.ts`
 * gives at least one edge, and `tests/webProtocol.test.ts` computes that filter over the server's
 * own map and asserts this array equals it, order included. A hand-copied set would be a second
 * opinion about the schema, and the release that adds a foreign key is exactly the release nobody
 * remembers to update it in.
 *
 * WHY THIS IS A PROPERTY OF THE TABLE AND NOT OF THE ROW. A card used to carry `hasReferrers`, a
 * server-computed bit saying whether anything actually pointed at that row, and the arrow appeared
 * only where it was true. What that hid is the shape of the archive: a recipe nothing has been
 * published under yet, a report whose runs are all still to come, and a row nothing CAN ever point
 * at all looked identical — no arrow, nothing to open, no way to tell an empty edge from an absent
 * one. Drawing the arrow from the schema means a fresh recipe shows an empty `report` box, which is
 * a true and useful thing to be shown. It also means the arrow never moves under the reader as rows
 * arrive and leave, and that a card is one query lighter.
 */
export const EXPANDABLE_TABLES = [
  "recipe",
  "report",
  "script",
  "target",
  "thesis",
  "thesis_assessment",
] as const;

const EXPANDABLE = new Set<RecordTable>(EXPANDABLE_TABLES);

/** Whether a row of this table can be opened. The five tables absent here are the leaves of this
 * schema — the run rows, a series preparation, an information source — and a click on one has
 * nothing to draw. */
export function expands(table: RecordTable): boolean {
  return EXPANDABLE.has(table);
}

/**
 * A card, as one arrives.
 *
 * `sublabel` and `meta` are OPTIONAL rather than nullable, and the difference is the whole of what
 * this schema has to get right: the repository omits a key it has nothing for — a version that is
 * not the operative one gets no marker — so a schema demanding either would refuse most of the
 * archive. Neither may be null, which is the other half: a null arriving where a number is expected
 * is a projection that changed shape, and drawing it as a date would be worse than saying so.
 */
const recordCardSchema = exact<RecordCard>()(
  z.object({
    table: recordTableSchema,
    id: z.string(),
    name: z.string(),
    label: z.string(),
    sublabel: z.string().optional(),
    meta: z.number().optional(),
  }),
);

export type RecordGroup = {
  table: RecordTable;
  column: string;
  onDelete: OnDelete;
  via?: JunctionTable;
  /** How many there are altogether, however few of them `records` carries. */
  total: number;
  records: RecordCard[];
  hasMore: boolean;
};

/** An edge. `via` is present only on the edges that travel through a junction, which is why it is
 * optional here and named by the two link tables rather than by any string. */
export const recordGroupSchema = exact<RecordGroup>()(
  z.object({
    table: recordTableSchema,
    column: z.string(),
    onDelete: onDeleteSchema,
    via: junctionTableSchema.optional(),
    total: z.number(),
    records: z.array(recordCardSchema),
    hasMore: z.boolean(),
  }),
);

/** A raw row. STRICT tables store text, integers and nulls, and nothing here stores a blob. */
export type Row = Record<string, string | number | null>;

/** Exactly the three things a STRICT table can hand back, and no key list: the columns differ per
 * table and the viewer draws whatever it is given, so what is worth checking is that every VALUE is
 * something it can draw. */
const rowSchema = exact<Row>()(
  z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
);

export type RecordDetail = {
  card: RecordCard;
  row: Row;
  /** What this record points at. Every edge appears, empty ones included: an edge that exists and
   * holds nothing is an audit finding, not an absence. */
  referents: RecordGroup[];
  referrers: RecordGroup[];
};

export const recordDetailSchema = exact<RecordDetail>()(
  z.object({
    card: recordCardSchema,
    row: rowSchema,
    referents: z.array(recordGroupSchema),
    referrers: z.array(recordGroupSchema),
  }),
);

export type RecordPage = {
  table: RecordTable;
  records: RecordCard[];
  hasMore: boolean;
};

export const recordPageSchema = exact<RecordPage>()(
  z.object({
    table: recordTableSchema,
    records: z.array(recordCardSchema),
    hasMore: z.boolean(),
  }),
);

/** One screenful of records, and the ceiling a single request may ask for. Mirrored so the window
 * can page without discovering the limit by being refused. */
export const DEFAULT_GROUP = 20;
export const MAX_GROUP = 100;
