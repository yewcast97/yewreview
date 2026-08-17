/**
 * Which record a name in a sentence points at, so a pill can be clicked.
 *
 * PURE and DOM-FREE, like `state/cards.ts` and `state/logs.ts`, and for the same reason: `bun test`
 * drives it directly, and the orderings that decide whether a mention pill is clickable — an id
 * learned while the same record's fetch is in flight, a record renamed under a pill that is already
 * drawn, a record deleted after its id was learned — are asserted rather than hoped for.
 *
 * THIS MODULE USED TO RUN THE OTHER WAY. A mention was `@table:id`, so the wire carried something no
 * reader could read and this directory turned it into a name to draw. A UNIQUE index on `name` and
 * a resolver for one in the tools turned that round: `serializeOutgoing` writes the name, and the
 * agent resolves the pair with `resolveRecordId`. So the pill has nothing to look up in order to
 * DRAW itself — it says what the mention says — and what it still needs is the other direction: an
 * id to open the record with, because that is what most of this window's read routes take. Where it
 * has none, `openNamedRecord` asks the server for the record by name instead.
 *
 * LEARNED, NOT FETCHED, in the ordinary case. Every answer this window already receives carries
 * `RecordCard`s with both halves on them — the graph's roots refresh several times a minute, every
 * expansion is a page of cards, every open note's detail carries its own card and every card in its
 * edge lists — so the directory fills itself from traffic that was happening anyway. `resolveId` in
 * the store is the exception rather than the mechanism: one fetch for a record the reader has a pill
 * for but has never had on screen.
 *
 * KEYED CASE-INSENSITIVELY, because the column is `COLLATE NOCASE` and a mention typed by hand or
 * quoted out of a transcript is as likely to differ in case as in nothing at all. The key is
 * lowercased on the way in and on the way out, and the name is never read back out of the key — what
 * a pill draws is the name the mention itself carried.
 *
 * A RENAME REPOINTS AND A DELETION DOES NOT, which is the asymmetry worth stating. A card carrying a
 * new name adds an entry; the old name keeps pointing at the same row until the tab is reloaded, and
 * that is deliberate — the sentence the pill sits in was written when the record answered to that
 * name, and opening the row it meant is more use than refusing to. A record that is DELETED is
 * refused by the server the next time somebody asks, which is what `missing` remembers.
 *
 * THE NEGATIVE CACHE IS NOT AN OPTIMISATION EITHER. A pill for a name that is not there answers 404
 * every time it is asked about; without `missing`, a streaming message containing that pill would
 * fire a fetch on every repaint of every frame of the answer. Once refused, never asked again this
 * session.
 */

import type { RecordCard, RecordTable } from "../lib/records.ts";

export type NameIndex = {
  /** `table:lowercased name` → the row's id, learned from every card that has passed through the
   * window. Keyed by a joined string rather than nested maps because the only question ever asked of
   * it is about one record. */
  readonly ids: ReadonlyMap<string, string>;
  /** The names that were asked about and refused. See the header: never asked twice. */
  readonly missing: ReadonlySet<string>;
};

const NO_IDS: ReadonlyMap<string, string> = new Map();
const NO_MISSING: ReadonlySet<string> = new Set();

export function createNameIndex(): NameIndex {
  return { ids: NO_IDS, missing: NO_MISSING };
}

/** How a name is addressed in here. Not a mention and deliberately not spelled like one — a mention
 * is a grammar with quoting rules and a column tail, and this is a map key. */
export function nameKey(table: RecordTable, name: string): string {
  return `${table}:${name.toLowerCase()}`;
}

/**
 * Learn every name in a batch of cards.
 *
 * THE SAME OBJECT WHEN NOTHING IS NEW, which is what makes it safe to call from every landing site
 * in the store. The graph's roots are re-read twice a second while the agent works and almost never
 * change; a new index object per refresh would re-render every mention pill in the transcript for as
 * long as a turn lasted.
 *
 * A card whose name already points where it says is not a change. A card whose name points somewhere
 * ELSE wins: the row that answers to a name now is the row a click should open.
 */
export function rememberCards(index: NameIndex, cards: readonly RecordCard[]): NameIndex {
  let ids: Map<string, string> | null = null;
  for (const card of cards) {
    if (card.name === "") continue;
    const key = nameKey(card.table, card.name);
    if (index.ids.get(key) === card.id) continue;
    ids ??= new Map(index.ids);
    ids.set(key, card.id);
  }
  return ids === null ? index : { ...index, ids };
}

/** Nothing answers to this name. Called for a refusal that says so — a 404 — and never for a network
 * failure, which is a fact about the connection rather than about the record. */
export function markMissing(index: NameIndex, table: RecordTable, name: string): NameIndex {
  const key = nameKey(table, name);
  if (index.missing.has(key)) return index;
  const missing = new Set(index.missing);
  missing.add(key);
  return { ...index, missing };
}

/** Which row answers to this name, or null while the window has never seen it. */
export function lookupId(index: NameIndex, table: RecordTable, name: string): string | null {
  return index.ids.get(nameKey(table, name)) ?? null;
}

/** Whether asking about this name again would be asking a question already answered "no". */
export function isMissing(index: NameIndex, table: RecordTable, name: string): boolean {
  return index.missing.has(nameKey(table, name));
}
