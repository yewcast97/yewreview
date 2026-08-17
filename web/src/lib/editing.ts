/**
 * The rules the record panel's forms are made of, with no React in them.
 *
 * Pure and DOM-free, like `lib/viewer.ts` and `lib/mention.ts`, and here for the same reason: every
 * rule below is one that is argued about once, agreed to, and then quietly broken by a later edit
 * that looks harmless. `bun test` drives them directly.
 *
 * The one that matters most is `seedDraft`. Every card in the record panel re-reads what it is
 * showing every five hundred milliseconds — that is what keeps a record open and honest while the
 * agent writes to it — so a form that took its value from each of those reads would delete what
 * somebody was typing the instant anything anywhere in the database moved. The text a form holds is
 * therefore seeded ONCE PER KEY and never again, and the seeding is a function rather than a
 * `useEffect` on the fetched value, because that effect is exactly the thing that gets written back
 * in a fortnight.
 *
 * THREE FUNCTIONS RATHER THAN ONE, because three rules are worth separating: a value is seeded once,
 * "different" is exact, and "worth writing" means different AND not blank. Every form on a card — a
 * record's readable name, an address-book entry, a recipe —
 * asks those three questions of text it holds itself. None of it is a DRAFT on the server, saved per
 * keystroke against the revision it was written on and committed through a route holding the rules
 * about what a revision is; the rules here are about a value in a box.
 */

/**
 * Something being typed, and which key it belongs to.
 *
 * The key is the whole mechanism: it is the identity of the thing being written — a table and a
 * record's id, for a form on a card — so moving to another one seeds afresh and coming back seeds from whatever now
 * stands there. A value with no key would either be reseeded by every refresh or carried between two
 * records that have nothing to do with each other.
 */
export type Draft<T> = { readonly key: string; readonly value: T };

/**
 * The draft to hold, given what is held and what the server now says.
 *
 * Returns the SAME object when the key has not moved, however far the stored value has — that is the
 * whole rule, and the identity is what makes it visible to a caller storing this in component state.
 * A refresh cannot reseed; only a change of key can.
 */
export function seedDraft<T>(held: Draft<T> | null, key: string, committed: T): Draft<T> {
  if (held !== null && held.key === key) return held;
  return { key, value: committed };
}

/** Whether a draft says something the record does not. Exact, and deliberately not trimmed: a name
 * that differs only by a trailing space is still a name somebody chose to type, and the form's mark
 * for "closing this would lose something" has to believe them. */
export function isDirty(draft: string, committed: string): boolean {
  return draft !== committed;
}

/**
 * Whether what is typed is worth writing: it differs, AND it says something.
 *
 * The blank case is not a nicety. An emptied field is one keystroke away from a select-all, and a
 * record with no name is a row nothing in this window can point at — the graph draws its label, the
 * record panel titles its card with it, and both would be blank on a record that is perfectly real.
 * The two clauses are asked together here rather than at the call site because they are one question,
 * and a form that enabled its button on `dirty` alone would be a form that saves a deletion.
 */
export function canCommit(draft: string, committed: string): boolean {
  return isDirty(draft, committed) && draft.trim() !== "";
}
