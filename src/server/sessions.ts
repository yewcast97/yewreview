/**
 * The seam a harness's session store is read through: the list of conversations, and one
 * conversation's transcript in the shape a window draws.
 *
 * **This seam exists because the transcript is not ours.** YewReview keeps no record of what was
 * said — there is no `message` table, deliberately, so that what the model remembers and what the
 * user is shown cannot drift apart. The consequence is that "show me that conversation again" is a
 * question about somebody else's files, answered by whichever harness is running:
 * `src/claudecode/sessions.ts` reads the Claude Agent SDK's store, `src/opencode/sessions.ts` asks
 * the opencode child over its HTTP API. Only the interface lives here.
 *
 * **It is a seam so that a test never touches a real store.** `SessionsApi` is four methods wide
 * and each implementation is a few lines; what it buys is that `tests/server.test.ts` can hand the
 * routes an in-memory array of sessions and assert the sorting, the live marking and the synthetic
 * prepend without a real agent ever having run on the machine running the suite — a store is written
 * only by a real CLI subprocess, and that is a cost a route test should not have to pay.
 *
 * **It answers in ITS OWN vocabulary, not the SDK's, because two harnesses answer it.** opencode
 * keeps its transcripts in a shape of its own, and a seam typed in `SDKSessionInfo` and
 * `SessionMessage` would have forced that implementation to either fabricate SDK rows or lie in its
 * types. So the seam names the four fields the routes actually read, and the mapping from a store's
 * own shape into `TranscriptItem[]` happens BEHIND it, in the harness that owns the store.
 *
 * **THERE IS NO PAGING, and that is the honest shape rather than a shortcut.** There is no cursor a
 * store would answer consistently, and worse, an offset would CUT A TOOL CALL AWAY FROM ITS RESULT:
 * a `tool_use` block and the `tool_result` that settles it live in two different messages, sometimes
 * several apart, so a page boundary drawn between them would render a call that never finished and,
 * on the next page, a result belonging to nothing. The array is bounded by compaction — a long
 * conversation gets folded down and the older half stops existing — so "the whole thing" is a
 * bounded thing, and the window virtualises what it draws.
 */

/**
 * One stored conversation, as the session panel needs it.
 *
 * `createdAt` is null rather than absent when a store cannot say: the SDK reports a birthday only
 * when a transcript's first entry carries a timestamp, and a route that has to distinguish "unknown"
 * from "missing field" would be distinguishing nothing.
 */
export type SessionSummary = {
  sessionId: string;
  summary: string;
  createdAt: number | null;
  lastModified: number;
};

/**
 * The three questions this server asks a harness's session store, and the one instruction it gives.
 *
 * Where the store LIVES is closed over rather than passed in. It used to be a `dir` argument, on the
 * argument that a seam remembering it would be a second opinion about where sessions live — but with
 * two harnesses that reasoning inverts: a directory is the Claude store's own idea of identity (the
 * SDK's project key, which is the agent's home) and opencode's is a base URL. The one answer to
 * "which installation's conversations are these" now lives where it always did, in `paths()`, and
 * each implementation reads it once at construction.
 *
 * **`delete` IS THE ONE THING THIS SEAM DOES RATHER THAN ASKS, and it is worth saying plainly what
 * that costs.** Every other destruction in YewReview is witnessed: a deleted record leaves the whole
 * vanished row in `deletion_log`, because a record is the archive and an archive that forgets
 * silently is not one. A transcript is not a record. It lives in somebody else's store, nothing in
 * the database points at it, no report was ever written from it, and there is no row to log — so a
 * conversation dropped on the Bin is gone, and the toast is the only account of it there will ever
 * be. That is the same decision as having no `message` table, followed through: what was said was
 * never the archive.
 */
export type SessionsApi = {
  list(): Promise<SessionSummary[]>;
  /** Undefined when the id names nothing the store still holds — pruned, rotated, or never real. */
  info(sessionId: string): Promise<SessionSummary | undefined>;
  /** The whole conversation, already mapped. See the header for why there is no paging. */
  items(sessionId: string): Promise<TranscriptItem[]>;
  /**
   * Remove one stored conversation, for good.
   *
   * Resolving when the conversation is gone, INCLUDING when it was already gone: the caller asked
   * for a state rather than for an event, and a store that pruned the row a millisecond earlier has
   * given them exactly what they wanted. Refuses only when this harness cannot reach its store at
   * all.
   */
  delete(sessionId: string): Promise<void>;
};

/**
 * One line of a conversation as a window draws it.
 *
 * Four kinds and no more, because four is what the chat window has ever drawn: somebody said
 * something, the model said something, a tool ran, and the history was folded up. Everything else in
 * a transcript — thinking blocks, retry notices, a store's own bookkeeping — is either not the
 * user's business or is already reflected in one of these, and a fifth kind would be a fifth thing
 * the window has to decide how to render.
 *
 * A tool item carries ONE summary, settled the way the live socket settles it: the call's own
 * summary while it is open, replaced by the result's when the result has one to give.
 */
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; tool: string; summary: string; ok: boolean }
  | { kind: "compacted" };
