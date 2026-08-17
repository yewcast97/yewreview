/**
 * The HTTP surface.
 *
 * Deliberately small, and getting smaller: **the agent is the interface to this product, and this
 * window does not write to the database at all.** Every record — a recipe, a thesis, a source, a
 * report, a name — is created, corrected and removed in conversation, by tools
 * that already hold every rule about what each of those is. A REST endpoint that wrote one would be
 * a second implementation of those rules, and the two would disagree within a month.
 *
 * THE SPECIFICATION AND THE ADDRESS BOOK WERE THE LAST TWO TO GO, and they are worth a paragraph
 * because they went the other way for so long. Both are the USER's documents rather than the agent's
 * account of anything: a recipe is the specification they are commissioning work against, and the
 * address book is their standing account of where their numbers come from. The form was the way that was
 * expressed — their text, their Save button — and the form was never what protected them. A button
 * is one click away wherever it sits, and a form let somebody press Save on text nobody had read out
 * loud. What holds instead is stated on the tools themselves: the whole of what is about to be
 * written is rendered in the conversation first, and the user says afterwards that it is what they
 * want. Everything about WHAT a recipe or an entry is still lives one layer down, in
 * `repo/recipes.ts` and `repo/sources.ts`.
 *
 * So what is left here is READS, plus a short list of writes that touch no record row. It is worth
 * being able to say which reason applies before adding another.
 *
 * `POST /api/venv/retry` re-runs provisioning, which is operational: the engine's absence is exactly
 * the condition in which the agent cannot fix anything for you. `POST /api/uploads` puts a file the
 * reader dragged in where the agent can read it. `POST /api/sessions/clear` and
 * `POST /api/sessions/:id/resume` decide WHICH conversation the next turn belongs to, which cannot
 * be said inside a conversation without the sentence landing in the one being left, and
 * `DELETE /api/sessions/:id` throws one away for the same reason plus one more: a transcript is not
 * a record, so no ledger witnesses its going and no tool could have written it in the first place.
 * `PUT /api/opencode/models` writes the model pool, which is a config file rather than a table.
 *
 * GENERATING A REPORT USED TO BE HERE and was described as the sharpest example of the rule — the
 * one write on this surface that was about authority rather than plumbing, because a procedure the
 * agent could open would make "publish only inside a generation" a sentence about nothing. It has
 * moved into the conversation: `start_generation` opens one, and stopping it is interrupting the
 * turn it rides. What actually holds a report's provenance up was never the pair of routes — it is
 * that the account is written from the machine's own log, that the recipe is named and immutable, and that the
 * archive is frozen for the duration (`src/generation.ts`, `src/tools/index.ts`). This surface now
 * touches no part of it.
 *
 * Three routes here do not answer JSON, and which is which is worth knowing. `GET /reports/<id>`
 * hands back a published document, because a report is a ROW — content and all — and there is no
 * file for a static server to reach for. The other two answer with bytes off a disk, and are
 * therefore the two places in this server where a URL becomes a path: `/reports/assets/**` is the
 * chart library a published document loads (`reportsStatic.ts`), and `/api/files/**` is a file the
 * agent wrote in its home and named in its reply (`homeFiles.ts`). Both are matched by prefix in
 * `handle` below rather than by pattern, because either may sit any depth down and a `:param` cannot
 * span a slash, and each keeps its own containment check in the module that serves it.
 *
 * Every error is `{error, message}` with the refusal's own kind as `error`. The kinds come from the
 * repositories unchanged — a browser and the model get the same refusal for the same rule, which is
 * what stops one of them from being told a friendlier lie. A `Refused` is an ANSWER and is never
 * filed in the error log; only the exceptions nobody planned for are.
 */

import pkg from "../../package.json";
import type { ServerDeps } from "./chat.ts";
import { FILES_URL_PREFIX, serveHomeFile } from "./homeFiles.ts";
import { ASSETS_URL_PREFIX, serveAsset } from "./reportsStatic.ts";
import { MAX_UPLOAD_BYTES, storeUpload } from "./uploads.ts";
import type { RefusalKind } from "../db/models.ts";
import { Refused } from "../db/models.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import { listDeletions, listErrors, logError } from "../repo/logs.ts";
import type { PoolDocument, PoolEntry } from "../opencode/config.ts";
import { OPENCODE_ROLES } from "../opencode/config.ts";
import { findByName } from "../repo/naming.ts";
import { getRecord, listReferrers, listTable, requireRecordTable } from "../repo/records.ts";
import { getReportContent } from "../repo/reports.ts";

/**
 * An agent's refusal code as a repository refusal kind, so one status map covers both.
 *
 * The agent has codes of its own — `conflict`, `not_found`, `closed`, `engine_unavailable` — because
 * it refuses things a repository has no opinion about. The two that already mean the same thing map
 * straight across; everything else is a request this installation cannot honour right now, which is
 * what `conflict` says.
 */
function refusalKind(code: string): RefusalKind {
  if (code === "not_found") return "not_found";
  return "conflict";
}

const REFUSAL_STATUS: Record<RefusalKind, number> = {
  invalid_request: 422,
  not_found: 404,
  conflict: 409,
  invalid_path: 422,
  data_invalid: 422,
};

export type RouterHooks = {
  /**
   * Tell every open window that the database moved.
   *
   * The agent's writes announce themselves through the tool wrapper; these are the ones that do
   * not go through a tool at all. A window watching only its own conversation would otherwise draw
   * a recipe list that a second tab had already changed.
   */
  announce(): void;
  /**
   * Tell every open window that the list of conversations moved.
   *
   * A separate poke from `announce` because it is a separate list with a separate refresh: the
   * record browser and the session panel are drawn from different reads, and a window told the
   * archive had changed would re-read every graph box to learn that a transcript was deleted.
   * Emitted by the agent for every other change to that list; the one this surface makes is a
   * deletion, which no conversation can announce because it may be about a conversation nobody is
   * in.
   */
  sessionsChanged(): void;
};

/**
 * The `:name` segments of a route pattern, as a union of the names it declares.
 *
 * This is what makes a handler's parameters exact. `"/api/records/:table/:id"` yields
 * `"table" | "id"`, so the params object a handler receives has those two keys and no others —
 * reading `p.id` needs no non-null assertion because the pattern guarantees it, and a typo like
 * `p.tableName` does not compile rather than evaluating to `undefined` on its way into a query.
 */
type ParamName<P extends string> = P extends `${string}:${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}`
    ? Name | ParamName<`/${Tail}`>
    : Rest
  : never;

type Params<P extends string> = { readonly [K in ParamName<P>]: string };

type Handler<P extends string> = (
  req: Request,
  url: URL,
  params: Params<P>,
) => Response | Promise<Response>;

/** The erased form the table holds. The pattern's literal type has done its work by the time a
 * route is in the list, and only `route()` may build one — see the cast there. */
type AnyHandler = (
  req: Request,
  url: URL,
  params: Record<string, string>,
) => Response | Promise<Response>;
type Route = { method: string; pattern: string[]; handler: AnyHandler };

/**
 * Build this server's request handler.
 *
 * A closure rather than a module-level table, because the in-flight provisioning run is per-SERVER
 * state. Module state would make one test's server answer for the next one's, and in a process
 * running two var-dirs it would let one installation's retry satisfy the other's.
 */
export function createRouter(deps: ServerDeps, hooks: RouterHooks) {
  const { db, settings } = deps;

  /** One provisioning run at a time. Two clicks on "retry" must not become two pip installs into
   * the same directory. */
  let provisioning: Promise<unknown> | null = null;

  /**
   * Refuse a var-file write from a read-only process, in one sentence naming the way out.
   *
   * The routes here write no record rows — that rule predates the writer claim — but three of them
   * write var FILES another process is live on top of: the model pool is the config the writer's
   * child was started from, provisioning rewrites the venv under the writer's runs, and deleting a
   * transcript destroys a file in the writer's store. `conflict` rather than a kind of its own,
   * because `RefusalKind` is a closed union and this is exactly what `refusalKind` above folds
   * "cannot honour right now" into.
   */
  function requireWriter(doing: string): void {
    if (deps.mode !== "reader") return;
    throw new Refused(
      "conflict",
      `this yewreview process is read-only — another process on this var root holds the pen — so ` +
        `${doing} happens in that process's window, or here after the writer exits and this one ` +
        `is restarted.`,
    );
  }

  const routes: Route[] = [
    route("GET", "/api/health", () => {
      const venv = deps.venv();
      return json({
        ok: dbAnswers(deps),
        version: pkg.version,
        schemaVersion: SCHEMA_VERSION,
        // The installation's DEFAULT, which is what this route is about — how this build was
        // configured. Which model is answering the CONVERSATION is on the `ready` frame, because it
        // is a fact about that conversation and the reader can change it from the composer.
        model: settings.model,
        venv: { ready: venv.ready, seikanVersion: venv.seikanVersion, error: venv.error },
        sandbox: deps.sandbox,
        // Which harness is answering, and — when it is opencode — whether it actually can. The
        // window draws different chrome for each, and this is where it learns which; the same
        // block is how a reader finds out that the binary is missing rather than discovering it
        // when a turn refuses.
        harness: settings.harness,
        // Whether this PROCESS may write the archive — see `db/lock.ts`. On the same shelf as
        // `harness`: a fact about how this installation is being served, fixed for the process's
        // life, that the window draws chrome from.
        mode: deps.mode,
        ...(deps.opencode === undefined
          ? {}
          : {
              opencode: (() => {
                const status = deps.opencode.status();
                return {
                  installed: status.installed,
                  version: status.version,
                  ok: status.ok,
                  hint: status.hint,
                };
              })(),
            }),
      });
    }),

    // -- the model pool, on the opencode harness only ------------------------------------------
    //
    // Mounted from `deps.opencode`, so on the Claude path these are a plain 404 rather than routes
    // answering about a pool nothing reads. The absence is structural and `tests/server.test.ts`
    // pins it, the way this suite pins every other deliberate absence.
    //
    // WHOLE-DOCUMENT PUT, and the answer IS the new truth — the window lands what comes back
    // rather than refetching, so there is no window in which two tabs disagree about what was
    // saved. It is refused while the agent is working: the pool is rendered into the config the
    // child was started with, and rewriting it mid-turn would mean a conversation whose model
    // changed underneath it.
    //
    // The API keys go back in the response, unredacted, which is a decision rather than an
    // oversight. This server binds loopback with no CORS; the pool is the reader's own credential
    // file; and a form that cannot show what it is editing forces sentinel values and blind
    // overwrites. The key is going back to the person who typed it.
    ...(deps.opencode === undefined
      ? []
      : [
          route("GET", "/api/opencode/models", () =>
            json({ ...deps.opencode!.pool.read(), roles_vocabulary: OPENCODE_ROLES }),
          ),
          route("PUT", "/api/opencode/models", async (req) => {
            requireWriter("rewriting the model pool");
            const reloadable = deps.opencode!.reloadable();
            if (!reloadable.ok) throw new Refused(refusalKind(reloadable.code), reloadable.message);
            const body = (await req.json()) as { entries?: unknown; roles?: unknown };
            const saved = deps.opencode!.pool.write({
              entries: (body.entries ?? []) as PoolEntry[],
              roles: (body.roles ?? {}) as PoolDocument["roles"],
            });
            hooks.announce();
            return json({ ...saved, roles_vocabulary: OPENCODE_ROLES });
          }),
        ]),

    // -- conversations ----------------------------------------------------------------------------
    //
    // The one part of this surface that reads somebody else's store. YewReview writes down nothing
    // of what was said; the SDK keeps the transcripts, this asks it what it has, and `sessions.ts`
    // is the seam that makes those three questions answerable without a real `~/.claude`.

    // The list, newest first. `live` and `current` say the same thing twice on purpose: a row knows
    // whether it is the conversation in progress, and a client with no rows at all still learns
    // there is one.
    //
    // The SYNTHETIC PREPEND is the interesting line. The SDK's list is a directory of files written
    // by the CLI subprocess on a flush cadence nothing here controls, so a conversation that started
    // thirty seconds ago may not be in it yet — and the session panel would then show every old
    // conversation and not the one the user is looking at. So when the agent holds an id the store
    // has not caught up with, a row is invented for it, saying only what is certainly true: this is
    // the current conversation, it was touched now, and nobody has written a summary of it yet.
    route("GET", "/api/sessions", async () => {
      const current = deps.agent.snapshot().sessionId;
      const sessions = [...(await deps.sessions.list())]
        .sort((a, b) => b.lastModified - a.lastModified)
        .map((info) => ({
          sessionId: info.sessionId,
          summary: info.summary,
          createdAt: info.createdAt,
          lastModified: info.lastModified,
          live: info.sessionId === current,
        }));
      if (current !== null && !sessions.some((session) => session.sessionId === current)) {
        sessions.unshift({
          sessionId: current,
          summary: "(current conversation)",
          createdAt: null,
          lastModified: Date.now(),
          live: true,
        });
      }
      return json({ sessions, current });
    }),

    // One conversation, whole. See `sessions.ts` for why there is no paging and cannot honestly be
    // one: a `tool_use` and the `tool_result` that settles it live in different messages, and an
    // offset drawn between them would render a call that never finished.
    route("GET", "/api/sessions/:id/messages", async (_req, _url, p) => {
      const id = p.id;
      const info = await deps.sessions.info(id);
      if (info === undefined) {
        throw new Refused(
          "not_found",
          `no conversation ${id} in this installation's session store; it was compacted away, ` +
            `pruned, or belongs to another project directory`,
        );
      }
      return json({ sessionId: id, items: await deps.sessions.items(id) });
    }),

    // Reopen one. The store is asked FIRST so that an id naming nothing is a 404 rather than an
    // agent quietly holding a conversation it will fail to resume on the next turn — and the agent's
    // own one-shot retry still covers the race where it is pruned between this check and that turn.
    // Deliberately not `requireWriter`-guarded, and `clear` below likewise: which conversation the
    // next turn belongs to is in-process agent state, and a read-only process conversing is the
    // point of the mode.
    route("POST", "/api/sessions/:id/resume", async (_req, _url, p) => {
      const id = p.id;
      const info = await deps.sessions.info(id);
      if (info === undefined) {
        throw new Refused(
          "not_found",
          `no conversation ${id} to resume; the session store no longer has it`,
        );
      }
      const resumed = deps.agent.resume(id);
      if (!resumed.ok) throw new Refused(refusalKind(resumed.code), resumed.message);
      return json({ sessionId: id, summary: info.summary });
    }),

    /*
     * Delete one, for good.
     *
     * THE CONFLICT IS CHECKED BEFORE THE 404, which is a deliberate inversion of the order the two
     * routes above use. The live conversation is routinely NOT in the store yet — the CLI flushes on
     * its own cadence, and a session minted seconds ago exists only as an id this process is holding
     * — so asking the store first and answering "no conversation X" would be a lie about the one
     * thing on the reader's screen. The store is still consulted before anything is destroyed;
     * what moves is only which refusal wins when both apply.
     *
     * A transcript is not a record, so nothing is witnessed: no `deletion_log` row, because that
     * log holds the archive and what was said was never part of it. See `server/sessions.ts`.
     */
    route("DELETE", "/api/sessions/:id", async (_req, _url, p) => {
      requireWriter("deleting a conversation");
      const id = p.id;
      const info = await deps.sessions.info(id);
      if (deps.agent.snapshot().sessionId === id) {
        throw new Refused(
          "conflict",
          `conversation ${id} is the one the agent is in right now; deleting the conversation on ` +
            `screen would pull the transcript out from under it — start a new one first, then ` +
            `delete this from the list`,
        );
      }
      if (info === undefined) {
        throw new Refused(
          "not_found",
          `no conversation ${id} to delete; the session store no longer has it`,
        );
      }
      await deps.sessions.delete(id);
      hooks.sessionsChanged();
      return new Response(null, { status: 204 });
    }),

    // Put the current conversation down. 204 because nothing was created — the old session is still
    // in the store, still listed and still resumable, and what changed is only what the next turn
    // will be carrying. Refused while the agent is working, because clearing then would abandon a
    // turn already in flight.
    route("POST", "/api/sessions/clear", () => {
      const cleared = deps.agent.clear();
      if (!cleared.ok) throw new Refused(refusalKind(cleared.code), cleared.message);
      return new Response(null, { status: 204 });
    }),

    // -- files dragged into the conversation ---------------------------------------------------------
    //
    // The third kind of write, and the only one of its kind: it is neither a thing that must happen
    // before a conversation can start nor a record that is the user's rather than the model's. It is
    // the user's GESTURE — they dropped a file on the composer — and the bytes have to be somewhere
    // the agent can read before the message naming them can be sent at all. Nothing is recorded: an
    // upload is a file in a directory, in no table, announced to nobody, and `server/uploads.ts`
    // says why it is never swept up either.
    //
    // RAW BYTES, WITH THE NAME ON THE QUERY. The browser hands the `File` to `fetch` as the body, so
    // there is no multipart to parse and no boundary to get wrong; the only other thing the server
    // needs is what the reader called it. The size is checked twice, and the pair is the point: the
    // header is what lets an enormous file be refused BEFORE it is read into memory, and the actual
    // byte length is what makes the cap true, because a Content-Length may be absent and may lie.
    // Deliberately not `requireWriter`-guarded: an upload lands in a fresh hex slot and overwrites
    // nothing (`server/uploads.ts`), and a read-only process's conversation still needs its gesture.
    route("POST", "/api/uploads", async (req, url) => {
      const filename = textParam(url, "filename");
      if (filename === undefined) {
        throw new Refused("invalid_request", "say what the file is called, as ?filename=");
      }
      const declared = Number(req.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
        return tooLarge(declared);
      }
      const bytes = await req.arrayBuffer();
      if (bytes.byteLength > MAX_UPLOAD_BYTES) return tooLarge(bytes.byteLength);
      return json({ path: await storeUpload(settings, filename, bytes) }, 201);
    }),

    // -- the two logs -------------------------------------------------------------------------------
    //
    // One route for both categories, because they are one question — "what has this installation
    // been quiet about" — asked of two tables with identical machinery. `category` is REQUIRED and
    // has no default: the two answer different shapes, and a default would let a client that forgot
    // the parameter draw deletions in an error viewer and never notice which it was looking at.
    // Keyset paging on `id`, like the record browser, for the same reason: rows arrive while a panel
    // is open, and an offset then repeats a row or skips one.
    route("GET", "/api/logs", (_req, url) => {
      const category = url.searchParams.get("category");
      if (category !== "errors" && category !== "deletions") {
        throw new Refused(
          "invalid_request",
          `category says which log to read: send category=errors for what went wrong, or ` +
            `category=deletions for what was removed`,
        );
      }
      const opts = { before: integerParam(url, "before"), limit: integerParam(url, "limit") };
      const page = category === "errors" ? listErrors(db, opts) : listDeletions(db, opts);
      return json({ category, entries: page.entries, hasMore: page.hasMore });
    }),

    // -- reports -------------------------------------------------------------------------------

    // The published document itself, and the only route in this file that answers HTML.
    //
    // One segment, always: a report is addressed by its id and by nothing else, so `/reports/a/b`
    // matches no pattern and 404s rather than being read as some path inside a report. `no-cache`
    // earns its place even though the document lives in the database — the row is immutable, so the
    // bytes behind one id never change, but the id can stop naming anything. A report is deletable, and a
    // copy a browser held on to would go on serving a document its owner asked the archive to
    // forget. `nosniff` goes on for the same reason it goes on every asset: this origin holds the
    // whole archive, and a document served here runs in it.
    //
    // THE CSP IS ON DOCUMENTS AND NOTHING ELSE, and it is worth being exact about what it buys and
    // what it costs. A published report is HTML somebody's model wrote, served from the origin that
    // also serves `/api/**` — so its own JavaScript is same-origin with the entire archive. `sandbox`
    // drops the document into an OPAQUE origin, which is what severs that: `allow-scripts` keeps the
    // charts drawing, and `connect-src 'none'` means the page cannot fetch, XHR or open a socket back
    // to the API that handed it over. `allow-popups` and `allow-popups-to-escape-sandbox` keep the
    // one interaction a citation needs — `target="_blank"` links to the source, opening unsandboxed
    // as ordinary tabs. What is lost is what a sandbox always loses: no `alert` or `print`, no form
    // submission, no `<a download>`. The report guide sanctions none of the three, and a document
    // that wanted one of them was going to be a surprise rather than a report.
    route("GET", "/reports/:id", (_req, _url, p) => {
      const content = getReportContent(db, p.id);
      if (content === null) throw new Refused("not_found", `no report ${p.id}`);
      return new Response(content, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
          "cache-control": "no-cache",
          "content-security-policy":
            "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; connect-src 'none'",
        },
      });
    }),

    // -- the record browser -----------------------------------------------------------------------

    // Three reads over the same map of foreign keys, and no writes at all. Each is one of two
    // questions — "what is in this table" and "what is joined to this row" — which is the whole of
    // what auditing provenance asks. Nothing here narrows by recipe: a report is reached through
    // the recipe that wrote it and a recorded run through its report, and that walk is the
    // browser exists for, so a recipe-shaped slice of a table would be a flat dump wearing a
    // graph's clothes. Ids arrive percent-encoded where they need to be — `segments()` splits on the
    // raw `/` before decoding, so an id carrying one survives as a single segment. No table numbers
    // its rows by anything but a uuid or a ticker today, which is exactly the kind of fact that
    // stops being true quietly.

    route("GET", "/api/records/:table", (_req, url, p) =>
      json(
        listTable(db, p.table, {
          limit: integerParam(url, "limit"),
          before: textParam(url, "before"),
        }),
      ),
    ),

    // A record by the name it answers to, which is what a mention now carries.
    //
    // DECLARED BEFORE `/:id`, and it has to be: the two patterns have the same shape, and a route
    // table matched in order would otherwise send `named` to the id handler and refuse it as a
    // malformed uuid. The name rides a QUERY PARAMETER rather than a third segment because a name
    // is the user's to write and may hold a `/`, which `segments()` splits on before anything has
    // decided what it is looking at.
    route("GET", "/api/records/:table/named", (_req, url, p) => {
      const wanted = textParam(url, "name");
      if (wanted === undefined) {
        throw new Refused("invalid_request", "ask for a record by name with ?name=<the name>");
      }
      const table = requireRecordTable(p.table);
      const id = findByName(db, table, wanted);
      if (id === null) {
        throw new Refused("not_found", `no ${table} is called ${JSON.stringify(wanted)}`);
      }
      return json(getRecord(db, table, id));
    }),

    route("GET", "/api/records/:table/:id", (_req, url, p) =>
      json(getRecord(db, p.table, p.id, { limit: integerParam(url, "limit") })),
    ),

    route("GET", "/api/records/:table/:id/referrers/:refTable", (_req, url, p) =>
      json(
        listReferrers(db, p.table, p.id, p.refTable, {
          limit: integerParam(url, "limit"),
          before: textParam(url, "before"),
        }),
      ),
    ),

    // -- operational ------------------------------------------------------------------------------

    route("POST", "/api/venv/retry", async () => {
      requireWriter("installing the measurement engine");
      provisioning ??= deps.reprovision().finally(() => {
        provisioning = null;
      });
      await provisioning;
      const venv = deps.venv();
      return json({
        venv: { ready: venv.ready, seikanVersion: venv.seikanVersion, error: venv.error },
      });
    }),
  ];

  return async function handle(req: Request, url: URL): Promise<Response> {
    // The assets tree is matched by PREFIX rather than by pattern, and before anything else under
    // `/reports/`: an asset may sit any depth down, which no fixed pattern can express, and the
    // containment check that makes a URL-shaped path safe lives in one place (`reportsStatic.ts`).
    // Documents fall through to `GET /reports/:id` below, which is a pattern precisely because a
    // document is addressed by one id and never by a path.
    if (url.pathname.startsWith(ASSETS_URL_PREFIX)) {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      return serveAsset(settings, url.pathname);
    }

    // A file the agent wrote and named in its reply, matched by prefix for the same reason: the path
    // is whatever it chose under its home, at whatever depth, and this router compares segment
    // counts — so no pattern can express it and a prefix branch is the shape that works. No
    // `announcing()` around it: a download reads bytes and changes nothing anybody is drawing. The
    // containment check, and the reason the answer is always an attachment, are in `homeFiles.ts`.
    if (url.pathname.startsWith(FILES_URL_PREFIX)) {
      if (req.method !== "GET") return methodNotAllowed(["GET"]);
      return serveHomeFile(settings, url.pathname);
    }

    const asked = segments(url.pathname);
    if (asked === null) {
      return refusal(404, "not_found", `${url.pathname} is not a path this server serves`);
    }

    // Matched ONCE and carried, rather than matched to filter and matched again to call: the second
    // call was the same work returning the same answer, and the assertion it needed was a claim
    // about that sameness which nothing checked.
    const matchable = routes.flatMap((candidate) => {
      const params = match(candidate.pattern, asked);
      return params === null ? [] : [{ candidate, params }];
    });
    const chosen = matchable.find((m) => m.candidate.method === req.method);
    if (!chosen) {
      if (matchable.length > 0) return methodNotAllowed(matchable.map((m) => m.candidate.method));
      return refusal(404, "not_found", `no route for ${req.method} ${url.pathname}`);
    }

    try {
      return await chosen.candidate.handler(req, url, chosen.params);
    } catch (err) {
      if (err instanceof Refused) {
        // Not logged, and this line is the whole reason the error log stays short enough to read: a
        // refusal is an ANSWER. Somebody asked for a record that is not there, or resumed a
        // conversation mid-turn, and was told so in a sentence they can act on. Filing those would
        // bury the handful of real defects under a month of ordinary use.
        return refusal(REFUSAL_STATUS[err.kind], err.kind, err.message);
      }
      // Logged in full — to the console for whoever is running YewReview, and to the error log for
      // whoever opens it afterwards — and answered in one line: the stack belongs to the operator,
      // not to whoever is looking at the window.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${req.method} ${url.pathname} failed`, err);
      logError(db, "http", `${req.method} ${url.pathname} failed: ${message}`, err);
      return refusal(500, "internal", message);
    }
  };
}

// -- the router ---------------------------------------------------------------------------------

/**
 * Declare one route, binding the handler's parameter names to the pattern's.
 *
 * The cast is the erasure boundary and the only one in the router: `Params<P>` is a mapped type
 * over the names in `P`, and the table holds routes of every pattern together, so the literal type
 * cannot survive into `Route[]`. It is sound because `match` builds the object from these very
 * segments — every `:name` in the pattern becomes a key, and a pattern that fails to bind one
 * returns null rather than a partial object.
 */
function route<const P extends string>(method: string, pattern: P, handler: Handler<P>): Route {
  return { method, pattern: pattern.split("/").slice(1), handler: handler as AnyHandler };
}

/**
 * The decoded segments of a path, or null when one of them is not decodable.
 *
 * A single trailing slash is ignored so `/api/sessions/` and `/api/sessions` are the same request;
 * anything more is a different path and is left to 404.
 */
function segments(pathname: string): string[] | null {
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  try {
    return trimmed.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
}

function match(pattern: string[], asked: string[]): Record<string, string> | null {
  if (pattern.length !== asked.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i]!;
    const got = asked[i]!;
    if (expected.startsWith(":")) {
      if (got === "") return null;
      params[expected.slice(1)] = got;
    } else if (expected !== got) {
      return null;
    }
  }
  return params;
}

// -- answers ------------------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function refusal(status: number, error: string, message: string): Response {
  return json({ error, message }, status);
}

/** The one refusal in this file that names its own status: 413 is what an oversized body is, and
 * none of the repositories' kinds mean that. The sentence says both figures, because "too large" a
 * reader cannot act on and "18 MiB against a cap of 32" they can. */
function tooLarge(bytes: number): Response {
  const mib = (size: number): string => (size / 1024 / 1024).toFixed(1);
  return refusal(
    413,
    "invalid_request",
    `that file is ${mib(bytes)} MiB and the cap is ${mib(MAX_UPLOAD_BYTES)} MiB`,
  );
}

function methodNotAllowed(allowed: string[]): Response {
  const methods = [...new Set(allowed)].sort();
  return new Response(
    JSON.stringify({
      error: "method_not_allowed",
      message: `that path answers ${methods.join(", ")}`,
    }),
    {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8", allow: methods.join(", ") },
    },
  );
}

/** Whether the database is still answering. A file removed or locked out from under a running
 * server is the failure this exists to notice. */
function dbAnswers(deps: ServerDeps): boolean {
  try {
    return deps.db.query<{ one: number }, []>("SELECT 1 AS one").get()?.one === 1;
  } catch (err) {
    console.error("the database stopped answering", err);
    return false;
  }
}

// -- request bodies -------------------------------------------------------------------------------

/** A string query parameter, or undefined when it was not sent. Blank counts as not sent: a client
 * that puts `?before=` on a URL is asking for the first page, not to page before the record named
 * "". */
function textParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  return raw === null || raw === "" ? undefined : raw;
}

/** An integer query parameter, or undefined when it was not sent. Present-and-unparseable is a
 * refusal rather than a default: a client that sent `limit=lots` meant something by it. */
function integerParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Refused("invalid_request", `${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}
