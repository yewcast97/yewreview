/**
 * The HTTP and WebSocket surface, against a REAL `Bun.serve` on a real port.
 *
 * Nothing here mocks the server. The three things most likely to be wrong — the containment check
 * on `/reports/assets/`, the keyset page, and the order frames arrive in on a socket — are all
 * properties of the wire rather than of a function, and a handler called directly would exercise
 * none of them.
 *
 * TWO things are faked, and only two. `FakeAgent` implements the `Agent` interface the server
 * declares, which is how this file double-checks that the interface is one an implementation can
 * satisfy — and it is faked because a real conversation costs money and takes minutes.
 * `FakeSessions` implements `SessionsApi` over in-memory arrays, because a real store is written
 * only by a real CLI subprocess having really answered — the same minutes and the same money, to
 * get a list back that the routes are the interesting part of.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Server } from "bun";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { Emit, EventsFrame, OutboundFrame } from "../src/protocol/types.ts";
import { homeDir, paths, type Settings } from "../src/config.ts";
import type { ProcessMode } from "../src/db/lock.ts";
import { newId, nowMs } from "../src/db/tx.ts";
import { attachLogAnnouncer, logError } from "../src/repo/logs.ts";
import { renameRecord } from "../src/repo/naming.ts";
import { createRecipe, deleteRecipe, setRecipeStatus } from "../src/repo/recipes.ts";
import type { ReportDeclarations } from "../src/repo/reports.ts";
import { deleteReport, recordReport } from "../src/repo/reports.ts";
import { createScript, getScript } from "../src/repo/scripts.ts";
import type { Resources } from "../src/resources/embed.ts";
import type { VenvStatus } from "../src/sandbox/venv.ts";
import type { Agent, ChatSocketData, ServerDeps } from "../src/server/chat.ts";
import { makeRoom } from "../src/server/chat.ts";
import { resolveAssetFile } from "../src/server/reportsStatic.ts";
import { startServer } from "../src/server/serve.ts";
import { toTranscriptItems } from "../src/claudecode/sessions.ts";
import type { SessionsApi, SessionSummary, TranscriptItem } from "../src/server/sessions.ts";
import { MAX_UPLOAD_BYTES } from "../src/server/uploads.ts";
import {
  harness,
  seedAssessment,
  seedSource,
  seedTarget,
  seedThesis,
  type Harness,
} from "./helpers.ts";

// -- the fake agent -------------------------------------------------------------------------------

/**
 * The installation's one agent, with the model taken out of it.
 *
 * It records what it was ASKED rather than only what it answered, because most of what the routes
 * owe is exactly that: `resume` has to be handed the session id out of the path, and a fake that
 * only reported success would let a route pass the wrong one and still be green.
 *
 * IT USED TO CARRY A GENERATION PROCEDURE and no longer knows what one is. Two routes started and
 * stopped procedures, so this fake had a gate's worth of state — a refusal to script, a throw to
 * provoke a 500 with, the specification ids both routes passed down. The agent opens its own now, with a
 * tool, and this surface touches no part of it.
 */
class FakeAgent implements Agent {
  readonly watchers = new Set<Emit>();
  readonly turns: string[] = [];
  interrupts = 0;
  queued = 0;
  busy = false;
  fresh = true;
  sessionId: string | null = null;


  /** Every session id `resume` was handed, and how many times `clear` was reached. */
  readonly resumed: string[] = [];
  clears = 0;
  /** What `resume` and `clear` refuse with while the agent is working. */
  switchRefusal: { code: string; message: string } | null = null;

  /** Every model `setModel` was handed, and what it refuses with. */
  readonly modelsSet: string[] = [];
  modelRefusal: { code: string; message: string } | null = null;

  /** Every effort level `setEffort` was handed, and what it refuses with — the model pair above,
   * kept separate rather than folded into it, because the socket has two frames and a shared list
   * would let one of them be routed to the other without a test noticing. */
  readonly effortsSet: string[] = [];
  effortRefusal: { code: string; message: string } | null = null;

  /** Every answer `setSubagents` was handed, and what it refuses with — a third list rather than a
   * shared one, for the reason the pair above gives: three frames routed through one recorder is
   * three chances for the switch to send one of them to the wrong handler unnoticed. */
  readonly subagentsSet: boolean[] = [];
  subagentsRefusal: { code: string; message: string } | null = null;

  attach(emit: Emit): () => void {
    this.watchers.add(emit);
    // Part of the interface, not a nicety: the real agent delivers `ready` to an arriving listener
    // before anything else can reach it, and a fake that skipped it would let the server drop its
    // own duplicate of that frame without a single test noticing.
    emit({
      type: "ready",
      model: "fake-model",
      models: [{ value: "fake-model", displayName: "Fake" }],
      // Where every conversation starts, and the only state a real agent could be in: there is no
      // level to be without, so a fixture carrying one is carrying what the wire actually holds.
      effort: "high",
      // And whether it may delegate, which starts on: a session either carries the subagent tools
      // or it does not, so there is no absence for a fixture to stand in for.
      subagents: true,
      fresh: this.fresh,
      venvReady: true,
      sessionId: this.sessionId,
    });
    return () => this.watchers.delete(emit);
  }

  submitTurn(text: string): void {
    this.turns.push(text);
  }

  interrupt(): Promise<void> {
    this.interrupts += 1;
    return Promise.resolve();
  }


  resume(sessionId: string): { ok: true } | { ok: false; code: string; message: string } {
    this.resumed.push(sessionId);
    if (this.switchRefusal !== null) return { ok: false, ...this.switchRefusal };
    this.sessionId = sessionId;
    this.fresh = false;
    return { ok: true };
  }

  clear(): { ok: true } | { ok: false; code: string; message: string } {
    this.clears += 1;
    if (this.switchRefusal !== null) return { ok: false, ...this.switchRefusal };
    this.sessionId = null;
    this.fresh = true;
    return { ok: true };
  }

  async setModel(model: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    this.modelsSet.push(model);
    if (this.modelRefusal !== null) return { ok: false, ...this.modelRefusal };
    return { ok: true };
  }

  /** The level is taken as a bare string, exactly as the real agent takes it: narrowing it to one
   * of the five is the AGENT's job — the socket has nothing but JSON to go on — so a fake that
   * insisted on the union here would be testing a guard the server does not have. */
  async setEffort(
    effort: string,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    this.effortsSet.push(effort);
    if (this.effortRefusal !== null) return { ok: false, ...this.effortRefusal };
    return { ok: true };
  }

  /** A boolean rather than a bare value, because this is the one of the three the SOCKET judges:
   * there are two meaningful answers and no vocabulary to keep in step with the SDK, so anything
   * else is refused before the agent hears about it. */
  async setSubagents(
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    this.subagentsSet.push(enabled);
    if (this.subagentsRefusal !== null) return { ok: false, ...this.subagentsRefusal };
    return { ok: true };
  }

  snapshot() {
    return {
      model: "fake-model",
      fresh: this.fresh,
      busy: this.busy,
      queued: this.queued,
      sessionId: this.sessionId,
    };
  }

  /** What the session would do as a turn unfolds. */
  emit(frame: OutboundFrame): void {
    for (const watcher of [...this.watchers]) watcher(frame);
  }
}

// -- the fake session store -------------------------------------------------------------------------

/**
 * The SDK's store of conversations, in memory.
 *
 * Faked for the same reason the agent is: a real store is a real subprocess's leavings, and the
 * routes are what these tests are about. Every `dir` it is handed is recorded, which is what locks
 * the one fact this seam exists to get right: the routes ask about the agent's HOME directory,
 * because that is the SDK's project key — the store's ROOT is a separate question, answered under
 * `var/claudecode` by the reader itself.
 */
class FakeSessions implements SessionsApi {
  readonly infos: SessionSummary[] = [];
  readonly transcripts = new Map<string, SessionMessage[]>();
  /** Every question asked of the store, in order — the seam is four methods wide and which one a
   * route reaches for is part of what these tests pin. */
  readonly asked: string[] = [];

  list(): Promise<SessionSummary[]> {
    this.asked.push("list");
    return Promise.resolve([...this.infos]);
  }

  info(sessionId: string): Promise<SessionSummary | undefined> {
    this.asked.push(`info:${sessionId}`);
    return Promise.resolve(this.infos.find((info) => info.sessionId === sessionId));
  }

  /**
   * The STORE is faked; the mapping is real.
   *
   * `toTranscriptItems` is a pure function over what a store hands back, so faking it too would mean
   * these routes were never tested against the lines a window actually draws. What this class stands
   * in for is ownership of the files, not the reading of them.
   */
  items(sessionId: string): Promise<TranscriptItem[]> {
    this.asked.push(`items:${sessionId}`);
    return Promise.resolve(toTranscriptItems(this.transcripts.get(sessionId) ?? []));
  }

  /** The one method that WRITES. It throws nothing for an id it does not hold: the route asks
   * `info` first, and a store that pruned the row in between has given the caller the state they
   * asked for — the real implementations resolve there too. */
  delete(sessionId: string): Promise<void> {
    this.asked.push(`delete:${sessionId}`);
    const at = this.infos.findIndex((info) => info.sessionId === sessionId);
    if (at >= 0) this.infos.splice(at, 1);
    this.transcripts.delete(sessionId);
    return Promise.resolve();
  }
}

// -- the fixture ----------------------------------------------------------------------------------

const VENV: VenvStatus = {
  ready: true,
  python: "/nowhere/bin/python",
  seikanBin: "/nowhere/bin/seikan",
  seikanVersion: "9.9.9",
  dslGuide: null,
  error: null,
};

const RESOURCES: Resources = {
  claudeCli: "/nowhere/claude",
  uv: null,
  seikanWheel: "/nowhere/seikan.whl",
  seikanEditable: false,
  requirements: undefined,
  echarts: "/nowhere/echarts.min.js",
};

type Fixture = {
  h: Harness;
  settings: Settings;
  server: Server<ChatSocketData>;
  agent: FakeAgent;
  sessions: FakeSessions;
  /** How many times `POST /api/venv/retry` actually reached provisioning, and what it should do
   * when it gets there. `failWith` is this suite's way of provoking a genuine 500. */
  provisioning: { runs: number; failWith: string | null };
  base: string;
  wsBase: string;
};

let fixture: Fixture | null = null;

function boot(opts: { mode?: ProcessMode } = {}): Fixture {
  const h = harness();
  // Port 0 so suites never collide, and the host pinned to loopback like the real boot.
  const settings: Settings = { ...h.settings, port: 0 };
  const agent = new FakeAgent();
  const sessions = new FakeSessions();
  const provisioning: { runs: number; failWith: string | null } = { runs: 0, failWith: null };
  const deps: ServerDeps = {
    db: h.db,
    settings,
    // The writer unless a test says otherwise — the mode is the boot's writer claim (`db/lock.ts`),
    // and the read-only refusals have their own describe.
    mode: opts.mode ?? "writer",
    agent,
    sessions,
    resources: RESOURCES,
    venv: () => VENV,
    sandbox: { available: true, hint: null },
    reprovision: async () => {
      provisioning.runs += 1;
      if (provisioning.failWith !== null) throw new Error(provisioning.failWith);
      return VENV;
    },
    // Wired exactly as `main.ts` wires it, and it is the only copy of anything in this fixture: the
    // logs announce on the installation-wide channel, and the assertion that a deletion or a
    // failure reaches an open window cannot be made without that one line.
    attachEvents: (send) => {
      attachLogAnnouncer(h.db, send);
    },
  };
  const server = startServer(deps);
  fixture = {
    h,
    settings,
    agent,
    sessions,
    provisioning,
    server,
    base: `http://127.0.0.1:${server.port}`,
    wsBase: `ws://127.0.0.1:${server.port}`,
  };
  return fixture;
}

afterEach(() => {
  if (!fixture) return;
  const done = fixture;
  fixture = null;
  // NOT awaited. As of Bun 1.3, `stop()` never settles once the server has closed a WebSocket
  // itself — which the socket tests here do on purpose — and awaiting it would hang the whole suite
  // on the cases most worth testing. Every server is on its own port and its own temp var-dir, so a
  // few milliseconds of overlap costs nothing.
  void done.server.stop(true);
  done.h.cleanup();
});

/**
 * `body` IS `any`, HERE AND IN THE TWO HELPERS BELOW, and it is the only `any` in the repository.
 *
 * What these read is a JSON response whose shape the SERVER owns, and a test's whole job is to say
 * what that shape turned out to be — so the alternative is `unknown` plus a cast at every one of a
 * few hundred access sites, which is the same absence of checking written three hundred times
 * instead of three, and harder to read at each of them. The assertions are the check: a body that
 * is not the shape a test expected fails on the value, which is the sentence somebody wants anyway.
 * The window's own view of these shapes is typed, in `web/src/lib/api.ts`, and pinned separately.
 */
async function getJson(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${fixture!.base}${path}`);
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${fixture!.base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

/**
 * A recipe, THROUGH THE REPOSITORY, because no route makes one any more.
 *
 * These used to go through `POST /api/workshops`, on the principle that a fixture should reach a
 * state the product can actually reach. That principle is intact and the door moved: a recipe is
 * written in conversation now, by a tool, and this file fakes the agent — so seeding through a
 * FakeAgent would be seeding through a fixture's own invention. `createRecipe` is the same
 * function the tool calls, one layer below either of them, which is as close to the real path as
 * anything in this file can honestly get. What the tool adds on top is tested in
 * `tests/tools.test.ts`; what is under test HERE is what the routes do with rows that exist.
 *
 * ONE CALL RATHER THAN TWO, which is the whole of what the schema change did to this file. A report
 * used to need a workshop and then a first playbook version written into it, so every fixture below
 * seeded a pair; the specification IS the row now, so a recipe arrives able to be published under.
 */
function newRecipe(name = "Semis"): string {
  return createRecipe(
    fixture!.h.db,
    name,
    "Lead with the numbers, then say what they do not show.",
  ).id;
}

/** The bytes every fixture report is published as, marked so a response carrying the document by
 * accident is recognisable on sight. Nothing in the schema reads inside them: the document is a
 * column, and no row anywhere claims to name an element within it. */
const DOCUMENT = (title: string) =>
  `<!doctype html><title>${title}</title><p>the document itself</p>`;

/**
 * A published report, without going near the agent that would normally write one.
 *
 * One call and one row: the document is a column, so there is nothing to write to disk first and no
 * ordering between bytes and a record that a fixture could get wrong. Declarations ride along
 * because they can only ride along — publishing is the one act that writes them.
 *
 * A stored recipe is the precondition, not something this can supply: a report names the
 * specification it was written to, and there is no writing one without one. Callers get one from
 * `newRecipe`, and may name it here when it matters which.
 */
function publishReport(
  title = "NVDA Q2",
  declarations: ReportDeclarations = {},
  recipeId?: string,
  content = DOCUMENT(title),
): string {
  const { h } = fixture!;
  const under =
    recipeId ??
    (h.db.query<{ id: string }, []>("SELECT id FROM recipe ORDER BY rowid LIMIT 1").get() as {
      id: string;
    }).id;
  return recordReport(h.db, under, title, content, declarations).id;
}

/**
 * A thesis with one round of judgement already filed, and the id of that ROUND.
 *
 * The ledger row is what the rest of the archive hangs off — a `series_preparation` names the round
 * whose inputs it prepared, never the container — so the id these tests carry around is the
 * reading's. Both rows go in directly: storing a thesis properly needs the engine, and what is under
 * test here is what points at the record rather than how it came to exist.
 */
function judgedThesis(db: Database, name: string): { thesisId: string; assessmentId: string } {
  const thesisId = seedThesis(db, name);
  return { thesisId, assessmentId: seedAssessment(db, thesisId) };
}

/** The installation-wide socket, and every frame it is sent. Opened rather than stubbed for the one
 * assertion that cannot be made any other way: whether a request told the OTHER windows. */
function openEvents(): { ws: WebSocket; frames: EventsFrame[] } {
  const ws = new WebSocket(`${fixture!.wsBase}/ws/events`);
  const frames: EventsFrame[] = [];
  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as EventsFrame);
  });
  return { ws, frames };
}

async function until(predicate: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// -- health, index, routing ----------------------------------------------------------------------

describe("the surface", () => {
  test("health reports the schema, the model, the engine and the sandbox", async () => {
    boot();
    const { status, body } = await getJson("/api/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // The number the boot refuses a mismatch on, handed to the window as it stands: there is no
    // migration ladder, so a build and a database agree on exactly one value.
    expect(body.schemaVersion).toBe(1);
    expect(body.model).toBe(fixture!.settings.model);
    expect(body.venv).toEqual({ ready: true, seikanVersion: "9.9.9", error: null });
    expect(body.sandbox).toEqual({ available: true, hint: null });
    // The write claim, the same kind of fact as the three above: fixed at boot, and what the
    // window's health panel draws its read-only chrome from.
    expect(body.mode).toBe("writer");
    expect(typeof body.version).toBe("string");
  });

  test("/ is the window's shell, carrying nothing out of the database", async () => {
    boot();
    newRecipe("<script>alert(1)</script>");
    const reportId = publishReport();

    const response = await fetch(`${fixture!.base}/`);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    // A mount point and a bundle, and that is the whole page. Every row the window draws it fetches
    // over the API for itself, which is why a recipe named like a payload cannot reach this
    // document at all — there is no server-side rendering here left to escape.
    expect(html).toContain('id="app"');
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain(reportId);
    // Local-first: nothing on this page may come from another host.
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
  });

  test("an unknown path is a 404 and a known path with the wrong method is a 405", async () => {
    boot();
    const missing = await getJson("/api/nothing");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_found");

    const wrongMethod = await send("DELETE", "/api/health");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body.error).toBe("method_not_allowed");
  });

  test("no route answers for a table this schema does not have", async () => {
    boot();
    const id = newRecipe();
    // Fundamental events are not a table, so there is nothing behind either spelling of a route
    // that would read them — an empty list would say they exist and happen to be empty.
    for (const path of ["/api/events", "/api/events?ticker=NVDA", "/api/events/anything"]) {
      const absent = await getJson(path);
      expect(absent.status).toBe(404);
      expect(absent.body.error).toBe("not_found");
    }
    // A recipe is not a slice of the archive: the record browser walks foreign keys, so nothing
    // groups one specification's rows behind a route of their own — under either spelling, since
    // the table this route named was renamed out of the schema rather than given a new door.
    for (const path of [`/api/recipes/${id}/records`, `/api/workshops/${id}/records`]) {
      const records = await getJson(path);
      expect(records.status).toBe(404);
      expect(records.body.error).toBe("not_found");
    }
  });

  test("there is no draft store, and there is no longer anything for one to stand between", async () => {
    boot();
    const id = newRecipe();

    // THERE IS NO DRAFT APPARATUS: no text held on the server so a model and a person can have
    // their hands on one document, no leases, no submit, no verification job behind it. The answer
    // this product gives is that they do not share a document — and the answer got SHARPER rather
    // than moot when the forms went. A draft store would have been the obvious way to keep a human
    // hand on the recipe once the agent held the pen: the model types a specification into a box and
    // the user presses save. That is ceremony, because committing another party's text is not
    // writing. What replaced the form is a rule on the tool — render the whole of it, wait, record
    // it once they have said so — and it needs no table.
    //
    // The transcript route is missing for a different reason: YewReview keeps no transcript, and
    // the SDK's store is the record, read through /api/sessions.
    for (const [method, path] of [
      ["GET", "/api/drafts"],
      ["POST", "/api/drafts"],
      ["GET", `/api/drafts/${encodeURIComponent(`recipe:${id}`)}`],
      ["PUT", `/api/drafts/${encodeURIComponent(`recipe:${id}`)}`],
      ["POST", `/api/drafts/${encodeURIComponent(`recipe:${id}`)}/lease`],
      ["POST", `/api/drafts/${encodeURIComponent(`recipe:${id}`)}/submit`],
      ["GET", "/api/source-verifications/job-1"],
      ["GET", `/api/recipes/${id}/messages`],
    ] as const) {
      const absent = await send(method, path, method === "GET" ? undefined : {});
      expect(`${method} ${path} → ${absent.status}`).toBe(`${method} ${path} → 404`);
      expect(absent.body.error).toBe("not_found");
    }
  });

  test("there are no per-table read routes; the record browser is the one door", async () => {
    // EIGHT READS ARE ABSENT, for one reason: `/api/records/**` walks every table and every foreign
    // key between them, so each of these would be a second, narrower answer to a question already
    // answered — with no caller but the tests calling them. A read that no caller has is not a
    // smaller API surface, it is a larger one nobody is checking.
    boot();
    const id = newRecipe();
    for (const path of [
      "/api/reports",
      "/api/targets",
      "/api/theses",
      `/api/theses/${newId()}`,
      `/api/recipes/${id}/reports`,
      // THESE THREE USED TO BE 405s, and the difference is worth reading rather than editing away.
      // A 405 means the PATH is routed and the method is not, so the router can name what it does
      // answer; three of these once took `POST /api/sources`, `PATCH /api/sources/:id` and
      // `DELETE /api/reports/:id`. Those writes are gone with every other record write, so nothing
      // is mounted on the path at all and 404 is the honest answer — there is no surviving method
      // for a 405 to name.
      "/api/sources",
      `/api/sources/${newId()}`,
      `/api/reports/${newId()}`,
    ]) {
      const absent = await getJson(path);
      expect(`GET ${path} → ${absent.status}`).toBe(`GET ${path} → 404`);
      expect(absent.body.error).toBe("not_found");
    }
  });

  test("a refusal keeps the repository's own kind and message", async () => {
    boot();
    // Through a route that still exists. It used to be the generation one — a specification checked
    // out of the path before the agent was reached — and that pair went the way of every other write
    // here, so the reader is the record browser: a table nothing is stored under is the
    // repository's own `not_found`, carried through with its sentence rather than flattened.
    const missing = await getJson(`/api/records/recipe/${newId()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_found");
    expect(missing.body.message).toContain("no recipe");

    // And a repository refusal that is not a `not_found`, so the status map is exercised rather
    // than one row of it: an unparseable limit is the browser's own `invalid_request`.
    const bad = await getJson("/api/records/report?limit=lots");
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("invalid_request");
    expect(bad.body.message).toContain("must be an integer");
  });
});

// -- the writes that are gone ----------------------------------------------------------------------

/**
 * THE LARGEST ABSENCE THIS FILE PINS, and the one most worth writing down rather than deleting the
 * tests for. Twelve routes wrote records here — a workshop, a playbook version, an address-book
 * entry, a report's removal, a record's name — and every one of them is gone, because **this window
 * does not write to the database at all.** Each was a second implementation of rules the tools
 * already hold, and two implementations of one rule disagree within a month.
 *
 * TWO OF THOSE PATHS NOW NAME A TABLE THAT NO LONGER EXISTS EITHER, and they are pinned anyway.
 * `workshop` and `playbook` became one `recipe`, so `/api/workshops/**` is doubly absent — no route
 * and no table — and an old window sending one has to meet the same 404 as before rather than
 * anything that reads as a server fault.
 *
 * What replaced them is not a permission check. The specification and the address book are the
 * USER's documents rather than the agent's account of anything, and the form was never what
 * protected them: a button is one click away wherever it sits, and a form let somebody press Save on
 * text nobody had read out loud. The rule that replaced it is on the tools — render the whole of
 * what will be stored, wait, and record it once the user has said so — and it is pinned in
 * `tests/tools.test.ts` beside the behaviour of each write.
 *
 * The pins below are all about STATUS, because that is the part a caller acts on and the part that
 * is easy to get subtly wrong. A path with no route at all is a 404; a path whose pattern still has
 * SOME method is a 405 naming the survivors. After this change almost every removed write leaves no
 * pattern behind, so almost every one is a 404 — the exception is the generation pair, which is why
 * it is exercised here too.
 */
describe("the writes that are gone", () => {
  test("no route creates, reads, renames or deletes a recipe", async () => {
    boot();
    const id = newRecipe("Semis");

    for (const [method, path] of [
      ["POST", "/api/recipes"],
      ["GET", "/api/recipes"],
      ["GET", `/api/recipes/${id}`],
      ["PATCH", `/api/recipes/${id}`],
      ["DELETE", `/api/recipes/${id}`],
      // AND THE SPELLING THIS SURFACE USED TO ANSWER, which is a stronger absence rather than a
      // stale one: `PATCH /api/workshops/:id` was the record-shaped rename and answered 405 for as
      // long as GET and DELETE lived on the same path. The routes went, and then the table did, so
      // the whole pattern is unrouted and 404 is the only honest answer left.
      ["POST", "/api/workshops"],
      ["GET", "/api/workshops"],
      ["GET", `/api/workshops/${id}`],
      ["PATCH", `/api/workshops/${id}`],
      ["DELETE", `/api/workshops/${id}`],
      // The two that wrote instructions, when instructions were an append-only ledger. There is
      // nothing to append to now — a recipe's text is immutable and a moved method is a new row —
      // so these name neither a route nor a table.
      ["POST", `/api/workshops/${id}/playbook`],
      ["DELETE", `/api/playbooks/${id}`],
    ] as const) {
      const absent = await send(method, path, method === "GET" ? undefined : { name: "Renamed" });
      expect(`${method} ${path} → ${absent.status}`).toBe(`${method} ${path} → 404`);
      expect(absent.body.error).toBe("not_found");
    }

    // The row is untouched by any of it, which is what makes those 404s about routing rather than
    // about a recipe that was never there — and its text says what it said, because nothing on this
    // surface can move it. It is read through the record browser like every other row in the
    // archive, and that is the door that did not move.
    const card = await getJson(`/api/records/recipe/${id}`);
    expect(card.body.card.id).toBe(id);
    expect(card.body.row.content).toBe("Lead with the numbers, then say what they do not show.");
    expect((await getJson("/api/records/recipe")).body.records).toHaveLength(1);
  });

  test("no route writes the address book, and none deletes a report", async () => {
    boot();
    newRecipe();
    const reportId = publishReport("NVDA Q2");
    const sourceId = seedSource(fixture!.h.db, "NVIDIA IR", ["ir.example"]);

    for (const [method, path] of [
      ["POST", "/api/sources"],
      ["PATCH", `/api/sources/${sourceId}`],
      ["DELETE", `/api/sources/${sourceId}`],
      ["DELETE", `/api/reports/${reportId}`],
    ] as const) {
      const absent = await send(method, path, { domain: "filings" });
      expect(`${method} ${path} → ${absent.status}`).toBe(`${method} ${path} → 404`);
      expect(absent.body.error).toBe("not_found");
    }

    // Both rows are still there, and the document is still served — so the 404s above are about
    // routes rather than about rows, and the archive is unmoved by a browser trying to write it.
    expect((await getJson(`/api/records/information_source/${sourceId}`)).status).toBe(200);
    expect((await fetch(`${fixture!.base}/reports/${reportId}`)).status).toBe(200);
  });

  test("no route renames a record, and the browser is reads only", async () => {
    boot();
    const id = newRecipe("Semis");
    const before = (await getJson(`/api/records/recipe/${id}`)).body.card.name as string;
    expect(before).toBe("semis");

    // `PATCH /api/records/:table/:id/name` was the LAST write in this file to go, and it was the
    // one with the best case for staying: a name asserts nothing about the world, nothing joins on
    // it, and a form could not implement that rule wrongly. It went anyway, because "the window
    // writes nothing" is a simpler thing to hold than "the window writes nothing except names" —
    // and a rename asked for in conversation is a rename with a reason attached to it.
    const renamed = await send("PATCH", `/api/records/recipe/${id}/name`, { name: "macro" });
    expect(renamed.status).toBe(404);
    expect(renamed.body.error).toBe("not_found");
    expect((await getJson(`/api/records/recipe/${id}`)).body.card.name).toBe("semis");

    // And no write of any shape reaches the browser's own patterns, which is the general form of
    // the rule: `/api/records/**` answers GET and nothing else, so a POST to a routed path is the
    // one 405 in this suite — the pattern survives, the method does not.
    const wrongMethod = await send("POST", "/api/records/report", {});
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body.error).toBe("method_not_allowed");
    expect(wrongMethod.body.message).toBe("that path answers GET");
  });

  test("the generation pair has gone the way of every other write on this surface", async () => {
    // IT WAS THE CONTRAST THAT MADE EVERY 404 ABOVE MEAN SOMETHING, and now it is one of them.
    // `POST` and `DELETE` on this path were the two writes that survived the teardown, on the
    // argument that starting a procedure was exactly the authority that must NOT be the agent's.
    // The agent opens its own with `start_generation`; what holds a report's provenance up is the
    // machine-kept log, the named recipe and the archive freezing for the duration, none of
    // which needed a route. So the pattern is unmounted like the rest — under the spelling it had,
    // and under the one the table carries now.
    boot();
    const id = newRecipe();
    for (const method of ["GET", "POST", "DELETE"] as const) {
      for (const path of [`/api/workshops/${id}/generation`, `/api/recipes/${id}/generation`]) {
        const absent = await send(method, path);
        expect(`${method} ${path}: ${absent.status}`).toBe(`${method} ${path}: 404`);
        expect(absent.body.error).toBe("not_found");
      }
      const gone = await send(method, `/api/generation`);
      expect(`${method}: ${gone.status}`).toBe(`${method}: 404`);
      expect(gone.body.error).toBe("not_found");
    }
  });

  test("a routed path still says what it answers, which is what a 405 is for", async () => {
    // The contrast the test above used to carry, kept alive on a path that legitimately survives:
    // deciding which conversation the next turn belongs to cannot be said INSIDE a conversation
    // without the sentence landing in the one being left, so it is a POST and nothing else.
    boot();
    fixture!.sessions.infos.push(storedSession("s-1", "About semis", 1_700_000_000_000));
    const read = await getJson("/api/sessions/s-1/resume");
    expect(read.status).toBe(405);
    expect(read.body.error).toBe("method_not_allowed");
    expect(read.body.message).toBe("that path answers POST");
    expect((await send("POST", "/api/sessions/s-1/resume")).status).toBe(200);

    // AND THE ONE OVERLAP WORTH KNOWING ABOUT: `/api/sessions/clear` is also a `:id`, so that path
    // answers DELETE as well — as a request to delete a conversation called "clear", which is a
    // 404 because no store mints an id like that. Harmless, and stated here rather than left for
    // somebody to discover in a 405 message that reads oddly.
    const both = await getJson("/api/sessions/clear");
    expect(both.status).toBe(405);
    expect(both.body.message).toBe("that path answers DELETE, POST");
    expect((await send("DELETE", "/api/sessions/clear")).status).toBe(404);
  });
});

// -- recipes, as rows this surface can only read -----------------------------------------------------

describe("recipes", () => {
  test("a recipe's card is its own opening words, and its standing only once it is retired", async () => {
    boot();
    const id = newRecipe();

    // THE SPECIFICATION DESCRIBES ITSELF, which is what one immutable row bought over a workshop
    // and a ledger. The card used to read "no playbook yet" here, because a workshop was born empty
    // and what it was to a reader lived in a version that might not exist; a recipe cannot exist
    // without its text, so the label is the first line of that text and there is no empty state.
    const card = await getJson(`/api/records/recipe/${id}`);
    expect(card.body.card.label).toContain("Lead with the numbers");
    // No sublabel while it is active: the line is spent on the word that carries information, and
    // "active" on almost every row carries none.
    expect(card.body.card.sublabel).toBeUndefined();
    // And the card says nothing at all about what points at it: whether a row can be opened is a
    // fact about its TABLE, read off the schema by whoever is drawing, so a recipe with no report
    // draws the same arrow as one with nine and opens onto a box that says "none recorded". That
    // the box is empty is the disclosure — it is how a reader tells an edge that is empty from an
    // edge this schema does not have.
    expect("hasReferrers" in card.body.card).toBe(false);
    // ONE EDGE, and it is the reports. A playbook version used to hang off the specification and be
    // the thing pointed at; the specification is the row now, so the only thing under it is what was
    // published to it.
    expect(card.body.referrers.map((g: { table: string }) => g.table)).toEqual(["report"]);
    expect(card.body.referrers[0].total).toBe(0);
    // And nothing on disk. There is one agent with one home, so a recipe is purely a record —
    // which is why there is no create-time rollback and no delete-time unlink to get wrong.
    expect(existsSync(resolve(fixture!.h.varDir, "workshops"))).toBe(false);
    expect(existsSync(resolve(fixture!.h.varDir, "recipes"))).toBe(false);

    // Publishing to it moves the edge and nothing else: the text is immutable, so a card cannot
    // change what it says about the work.
    publishReport("NVDA Q2", {}, id);
    const published = await getJson(`/api/records/recipe/${id}`);
    expect(published.body.card.label).toContain("Lead with the numbers");
    expect(published.body.referrers[0].total).toBe(1);

    // RETIRING IT IS THE ONE THING THAT MOVES, and the card is where a reader sees it: the status
    // is the only column that can change on this table, and an inactive recipe is one nothing new
    // will be written to.
    setRecipeStatus(fixture!.h.db, id, "inactive");
    const retired = await getJson(`/api/records/recipe/${id}`);
    expect(retired.body.card.sublabel).toBe("inactive");
    expect(retired.body.row.status).toBe("inactive");
    expect(retired.body.card.label).toContain("Lead with the numbers");
  });

  test("a deleted recipe takes its documents with it, and the served report goes too", async () => {
    boot();
    const id = newRecipe();
    const reportId = publishReport("NVDA Q2", {}, id);
    expect((await fetch(`${fixture!.base}/reports/${reportId}`)).status).toBe(200);

    // Through the repository, because the route that did this is gone and `delete_recipe` is the
    // tool that reaches it now. What is under test here is the SERVER's half: a document is a row,
    // so the address that served it stops answering the moment the row leaves, with no second step
    // in which a crash could strand published bytes on a disk.
    deleteRecipe(fixture!.h.db, id);
    expect((await getJson(`/api/records/recipe/${id}`)).status).toBe(404);
    expect((await getJson("/api/records/report")).body.records).toEqual([]);
    expect((await fetch(`${fixture!.base}/reports/${reportId}`)).status).toBe(404);
  });
});

// -- conversations ---------------------------------------------------------------------------------

/** One row of a session store's list. */
function storedSession(
  sessionId: string,
  summary: string,
  lastModified: number,
  createdAt?: number,
): SessionSummary {
  return { sessionId, summary, lastModified, createdAt: createdAt ?? null };
}

/**
 * The session list, one transcript, and the two ways to say which conversation the next turn is in.
 *
 * All four routes read a store this process does not own — the SDK writes the transcripts, on a
 * flush cadence nothing here controls — which is what makes the synthetic row and the 404s the
 * interesting cases rather than the happy path.
 */
/**
 * The opencode surface, on a server that is not running it.
 *
 * The suite pins ABSENCES as tests, and this is one: the pool routes and the MCP door are mounted
 * from `deps.opencode`, which the Claude path does not supply, so their absence is structural
 * rather than a condition inside a handler. A 404 here is the design working.
 */
describe("what the claudecode harness does not serve", () => {
  test("there is no model pool, and no door for a child that does not exist", async () => {
    boot();
    expect((await getJson("/api/opencode/models")).status).toBe(404);
    const put = await fetch(`${fixture!.base}/api/opencode/models`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: [], roles: {} }),
    });
    expect(put.status).toBe(404);
    // `/mcp` is how the opencode child reaches YewReview's tools. On this path the tools are in
    // process and there is nothing for an HTTP endpoint to serve, so the route is simply not there.
    const mcp = await fetch(`${fixture!.base}/mcp`, { method: "POST", body: "{}" });
    expect(mcp.status).toBe(404);
  });

  test("health names the harness, so the window knows which chrome to draw", async () => {
    boot();
    const { body } = await getJson("/api/health");
    expect(body.harness).toBe("claudecode");
    // And says nothing about opencode, because there is nothing to say: an `opencode` block on a
    // Claude installation would be a status for a program this boot never looked for.
    expect(body).not.toHaveProperty("opencode");
  });
});

/**
 * The read-only process, on the HTTP surface.
 *
 * The mode is the boot's writer claim (`db/lock.ts`): the first process on a var root writes, and
 * every later one serves the same archive read-only for its whole life. The routes here write no
 * record rows in ANY mode — that absence has its own describe below — so what a reader refuses is
 * the three writes to var FILES another process is live on top of, and what it deliberately still
 * answers is pinned too, because an allow that nobody asserted is an accident waiting to invert.
 */
describe("a read-only server", () => {
  test("says so on health, and refuses the routes that write var files", async () => {
    boot({ mode: "reader" });
    const { sessions, provisioning } = fixture!;
    sessions.infos.push(storedSession("old", "Last week", 1_700_000_000_000));

    expect((await getJson("/api/health")).body.mode).toBe("reader");

    // Provisioning writes var/venv under the writer's runs; the refusal precedes the single-flight
    // closure, so the counter proves the guard fired before anything was attempted.
    const retry = await send("POST", "/api/venv/retry");
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe("conflict");
    expect(retry.body.message).toContain("read-only");
    expect(provisioning.runs).toBe(0);

    // A transcript is a file in the writer's store, and destroying one from here would reach
    // across processes exactly the way the tmp sweep must not.
    const removed = await send("DELETE", "/api/sessions/old");
    expect(removed.status).toBe(409);
    expect(sessions.asked.filter((q) => q.startsWith("delete:"))).toEqual([]);
  });

  test("still takes an upload and still moves between conversations, on purpose", async () => {
    boot({ mode: "reader" });
    const { agent, sessions } = fixture!;
    sessions.infos.push(storedSession("s-1", "margins", 1_700_000_000_000));

    // An upload lands in a fresh hex slot and overwrites nothing, and the reader's conversation is
    // real — the agent reads what was dropped even when it cannot write a row about it.
    const uploaded = await fetch(`${fixture!.base}/api/uploads?filename=notes.txt`, {
      method: "POST",
      body: "hello",
    });
    expect(uploaded.status).toBe(201);

    // Which conversation the next turn belongs to is in-process agent state, not a var write.
    const resumed = await send("POST", "/api/sessions/s-1/resume");
    expect(resumed.status).toBe(200);
    expect(agent.resumed).toContain("s-1");
    expect((await send("POST", "/api/sessions/clear")).status).toBe(204);
  });
});

describe("conversations", () => {
  test("nothing stored and nothing running is an empty list, honestly", async () => {
    boot();
    const { status, body } = await getJson("/api/sessions");
    expect(status).toBe(200);
    expect(body).toEqual({ sessions: [], current: null });
    // The store was actually consulted rather than an empty list being invented. WHERE it looked is
    // no longer assertable here, and no longer needs to be: the directory used to travel as an
    // argument on every call, and a route could in principle have passed the wrong one. It is now
    // closed over when the seam is built — `sdkSessions(settings)` reads `homeDir` once, which is
    // the SDK's project key — so asking about another installation's conversations is not a thing a
    // route can express.
    expect(fixture!.sessions.asked).toEqual(["list"]);
  });

  test("the list is newest first, and the conversation in progress is marked on the row and beside it", async () => {
    boot();
    const { sessions, agent } = fixture!;
    sessions.infos.push(
      storedSession("older", "margins in the second quarter", 1_700_000_000_000, 1_699_000_000_000),
      storedSession("newest", "the float compounds", 1_700_000_900_000),
      storedSession("middle", "TSMC capacity", 1_700_000_600_000),
    );
    agent.sessionId = "middle";

    const { body } = await getJson("/api/sessions");
    expect(body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([
      "newest",
      "middle",
      "older",
    ]);
    expect(body.current).toBe("middle");
    expect(body.sessions.map((s: { live: boolean }) => s.live)).toEqual([false, true, false]);
    // The whole row, locked. `createdAt` is null rather than absent when the store has no birthday
    // for a conversation: a window drawing "started" has to be able to tell "the SDK does not know"
    // from "the key is missing because this build forgot it".
    expect(body.sessions[2]).toEqual({
      sessionId: "older",
      summary: "margins in the second quarter",
      createdAt: 1_699_000_000_000,
      lastModified: 1_700_000_000_000,
      live: false,
    });
    expect(body.sessions[0].createdAt).toBeNull();
  });

  test("a conversation the store has not flushed yet is still listed, as itself", async () => {
    boot();
    const { sessions, agent } = fixture!;
    sessions.infos.push(storedSession("old", "last week's reading", 1_700_000_000_000));
    agent.sessionId = "minted-a-minute-ago";

    const { body } = await getJson("/api/sessions");
    // Prepended rather than left out. The SDK's list is a directory of files written by the CLI
    // subprocess on its own cadence, so the conversation somebody is looking at RIGHT NOW is
    // routinely missing from it — and a panel that showed every old conversation and not that one
    // would be wrong in the only way a user would notice immediately.
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).toEqual({
      sessionId: "minted-a-minute-ago",
      // Only what is certainly true: this is the current one, it was touched now, and nobody has
      // written a summary of it yet.
      summary: "(current conversation)",
      createdAt: null,
      lastModified: expect.any(Number),
      live: true,
    });
    expect(body.sessions[1].live).toBe(false);
    expect(body.current).toBe("minted-a-minute-ago");
  });

  test("a transcript comes back whole, as lines to draw", async () => {
    boot();
    const { sessions } = fixture!;
    sessions.infos.push(storedSession("s-1", "margins", 1_700_000_000_000));
    sessions.transcripts.set("s-1", [
      {
        type: "user",
        uuid: "u1",
        session_id: "s-1",
        message: { role: "user", content: "how many theses?" },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: "assistant",
        uuid: "u2",
        session_id: "s-1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look." },
            { type: "tool_use", id: "t1", name: "list_theses", input: { tag: "insightful" } },
          ],
        },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: "user",
        uuid: "u3",
        session_id: "s-1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "3" }] },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ] as SessionMessage[]);

    const { status, body } = await getJson("/api/sessions/s-1/messages");
    expect(status).toBe(200);
    // No paging, and none possible: a `tool_use` and the `tool_result` that settles it live in
    // different messages, so an offset drawn between them would render a call that never finished.
    expect(Object.keys(body).sort()).toEqual(["items", "sessionId"]);
    expect(body.sessionId).toBe("s-1");
    expect(body.items).toEqual([
      { kind: "user", text: "how many theses?" },
      { kind: "assistant", text: "Let me look." },
      { kind: "tool", tool: "list_theses", summary: "3", ok: true },
    ]);

    const gone = await getJson("/api/sessions/never-existed/messages");
    expect(gone.status).toBe(404);
    expect(gone.body.message).toContain("no conversation never-existed");
  });

  test("resuming one checks the store first, then hands the id to the agent", async () => {
    boot();
    const { sessions, agent } = fixture!;
    sessions.infos.push(storedSession("s-1", "margins in the second quarter", 1_700_000_000_000));

    // The store is asked BEFORE the agent, so an id naming nothing is a 404 rather than an agent
    // quietly holding a conversation it will fail to resume on the next turn.
    const gone = await send("POST", "/api/sessions/s-9/resume");
    expect(gone.status).toBe(404);
    expect(gone.body.message).toContain("no conversation s-9 to resume");
    expect(agent.resumed).toEqual([]);

    const resumed = await send("POST", "/api/sessions/s-1/resume");
    expect(resumed.status).toBe(200);
    // The summary rides back so the window can title the conversation it just opened without a
    // second request, and before any `ready` frame has had to arrive.
    expect(resumed.body).toEqual({ sessionId: "s-1", summary: "margins in the second quarter" });
    expect(agent.resumed).toEqual(["s-1"]);
    expect(agent.snapshot().sessionId).toBe("s-1");
  });

  test("switching conversations mid-turn is a 409 in the agent's own words", async () => {
    boot();
    const { sessions, agent } = fixture!;
    sessions.infos.push(storedSession("s-1", "margins", 1_700_000_000_000));
    agent.switchRefusal = {
      code: "conflict",
      message: "the agent is still working — interrupt it, or wait for it to finish",
    };

    const resumed = await send("POST", "/api/sessions/s-1/resume");
    expect(resumed.status).toBe(409);
    expect(resumed.body.error).toBe("conflict");
    expect(resumed.body.message).toContain("still working");

    const cleared = await send("POST", "/api/sessions/clear");
    expect(cleared.status).toBe(409);
    expect(cleared.body.message).toContain("still working");
    // Both reached the agent — the refusal is the AGENT's, which is the only place that can see a
    // turn queued behind the one in flight.
    expect(agent.resumed).toEqual(["s-1"]);
    expect(agent.clears).toBe(1);
  });

  test("deleting one asks the store first, so an unknown id is a 404 and nothing is removed", async () => {
    boot();
    const { sessions } = fixture!;
    sessions.infos.push(storedSession("s-1", "About semis", 1_700_000_000_000));

    const gone = await send("DELETE", "/api/sessions/s-9");
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe("not_found");
    expect(gone.body.message).toContain("no conversation s-9 to delete");
    // ASKED, THEN NOT TOLD. The store was consulted and the destructive half never reached it,
    // which is the property worth pinning: an id nobody recognises must not become a delete call
    // whose own implementation happens to be forgiving about ids nobody recognises.
    expect(sessions.asked).toEqual(["info:s-9"]);
    expect(sessions.infos).toHaveLength(1);
  });

  test("the conversation the agent is in cannot be deleted, flushed to the store or not", async () => {
    boot();
    const { agent, sessions } = fixture!;
    agent.sessionId = "live";

    // THE FLUSHED CASE: the store has it, and it is still refused, because what is on the reader's
    // screen is being written into right now.
    sessions.infos.push(storedSession("live", "The one on screen", 1_700_000_000_000));
    const held = await send("DELETE", "/api/sessions/live");
    expect(held.status).toBe(409);
    expect(held.body.error).toBe("conflict");
    expect(held.body.message).toContain("the one the agent is in right now");
    expect(held.body.message).toContain("start a new one first");

    // AND THE UNFLUSHED CASE, which is why the conflict is checked before the 404 rather than after
    // it. The CLI writes its transcript on its own cadence, so a conversation minted seconds ago
    // exists only as an id this process is holding — and answering "no conversation live" about the
    // one being drawn would be a lie in the only place a reader would notice.
    sessions.infos.length = 0;
    const unflushed = await send("DELETE", "/api/sessions/live");
    expect(unflushed.status).toBe(409);
    expect(unflushed.body.message).toContain("the one the agent is in right now");

    expect(sessions.asked.filter((q) => q.startsWith("delete:"))).toEqual([]);
  });

  test("deleting an old conversation is a 204, the store forgets it, and every window is poked", async () => {
    boot();
    const { agent, sessions } = fixture!;
    agent.sessionId = "live";
    sessions.infos.push(
      storedSession("live", "On screen", 1_700_000_900_000),
      storedSession("old", "Last week", 1_700_000_000_000),
    );
    const socket = openEvents();

    const removed = await send("DELETE", "/api/sessions/old");
    expect(removed.status).toBe(204);
    expect(removed.body).toBeNull();
    expect(sessions.asked).toEqual(["info:old", "delete:old"]);
    expect((await getJson("/api/sessions")).body.sessions.map((s: { sessionId: string }) => s.sessionId))
      .not.toContain("old");

    // THE POKE, because a second window is drawing the same list. It goes on the events socket
    // rather than the chat one for the reason every installation-wide fact does: a deletion is not
    // about the conversation anybody is in.
    await until(
      () => socket.frames.some((f) => f.type === "sessions_changed"),
      "the sessions poke",
    );

    // AND NOTHING IS WITNESSED, which is the half worth asserting rather than assuming. Every
    // record deletion in this database leaves the whole vanished row in `deletion_log`; a
    // transcript is not a record, nothing in the archive points at it, and there is no row to log.
    expect(socket.frames.some((f) => f.type === "deletion_logged")).toBe(false);
    expect((await getJson("/api/logs?category=deletions")).body.entries).toEqual([]);
    socket.ws.close();
  });

  test("clearing is 204, because nothing was created and nothing was thrown away", async () => {
    boot();
    const { agent } = fixture!;
    agent.sessionId = "s-1";

    const cleared = await send("POST", "/api/sessions/clear");
    expect(cleared.status).toBe(204);
    expect(cleared.body).toBeNull();
    expect(agent.clears).toBe(1);
    // The old conversation is still in the store, still listed and still resumable: "clear" is
    // about what the model is carrying into the next turn, not about what the archive keeps.
    expect(agent.snapshot().sessionId).toBeNull();
    expect(agent.snapshot().fresh).toBe(true);
  });
});

// -- files dragged into the conversation ---------------------------------------------------------

describe("uploads", () => {
  /** POST bytes the way the browser does it: the file as the whole body, the name on the query. */
  async function upload(
    filename: string,
    bytes: string | Uint8Array,
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(
      `${fixture!.base}/api/uploads?filename=${encodeURIComponent(filename)}`,
      { method: "POST", body: bytes },
    );
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  }

  test("a dropped file lands in the agent's home and the path says where", async () => {
    const { settings } = boot();
    const created = await upload("q3-earnings.pdf", "the numbers");
    expect(created.status).toBe(201);
    expect(created.body.path).toMatch(/^uploads\/[0-9a-f]{8}\/q3-earnings\.pdf$/);
    // Inside the HOME directory specifically, which is the session's cwd and what makes the path in
    // the message resolvable by `Read` without anything else being opened up.
    const absolute = resolve(homeDir(settings), created.body.path);
    expect(await Bun.file(absolute).text()).toBe("the numbers");
  });

  test("binary survives the round trip byte for byte", async () => {
    // The body is raw bytes rather than anything encoded, so this would only fail if something in
    // the path decided to treat it as text.
    const { settings } = boot();
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const created = await upload("blob.bin", bytes);
    expect(created.status).toBe(201);
    const back = new Uint8Array(
      await Bun.file(resolve(homeDir(settings), created.body.path)).arrayBuffer(),
    );
    expect([...back]).toEqual([...bytes]);
  });

  test("the same filename twice is two files", async () => {
    const { settings } = boot();
    const first = await upload("data.csv", "one");
    const second = await upload("data.csv", "two");
    expect(first.body.path).not.toBe(second.body.path);
    expect(await Bun.file(resolve(homeDir(settings), first.body.path)).text()).toBe("one");
    expect(await Bun.file(resolve(homeDir(settings), second.body.path)).text()).toBe("two");
  });

  test("a filename that tries to climb out of the home lands inside it", async () => {
    const { settings } = boot();
    const created = await upload("../../../../../../tmp/escaped.txt", "x");
    expect(created.status).toBe(201);
    expect(created.body.path).toMatch(/^uploads\/[0-9a-f]{8}\/escaped\.txt$/);
    const absolute = resolve(homeDir(settings), created.body.path);
    expect(absolute.startsWith(homeDir(settings))).toBe(true);
    expect(existsSync(absolute)).toBe(true);
    // And nothing was written where the name was aiming.
    expect(existsSync("/tmp/escaped.txt")).toBe(false);
  });

  test("a missing or blank filename is refused", async () => {
    boot();
    const bare = await fetch(`${fixture!.base}/api/uploads`, { method: "POST", body: "x" });
    expect(bare.status).toBe(422);
    expect(((await bare.json()) as { error: string }).error).toBe("invalid_request");
    const blank = await upload("", "x");
    expect(blank.status).toBe(422);
  });

  test("a name with no usable characters is refused", async () => {
    boot();
    const refused = await upload("..", "x");
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe("invalid_request");
  });

  test("a file past the cap is refused with both figures, and nothing is written", async () => {
    const { settings } = boot();
    const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    const refused = await upload("huge.bin", tooBig);
    expect(refused.status).toBe(413);
    expect(refused.body.error).toBe("invalid_request");
    // The reader is told what they sent AND what the limit is; "too large" alone is not actionable.
    expect(refused.body.message).toContain("32.0 MiB");
    expect(existsSync(resolve(homeDir(settings), "uploads"))).toBe(false);
  });

  test("a file exactly at the cap is accepted", async () => {
    // The boundary belongs to the reader: a cap of 32 MiB that refuses 32 MiB is a cap of 32 MiB
    // minus one byte, and nobody could tell which from the sentence.
    const { settings } = boot();
    const created = await upload("edge.bin", new Uint8Array(MAX_UPLOAD_BYTES));
    expect(created.status).toBe(201);
    expect(Bun.file(resolve(homeDir(settings), created.body.path)).size).toBe(MAX_UPLOAD_BYTES);
  });

  test("the path answers POST and nothing else", async () => {
    boot();
    const read = await getJson("/api/uploads");
    expect(read.status).toBe(405);
    expect(read.body.error).toBe("method_not_allowed");
  });

  test("an upload announces nothing — it is not a record", async () => {
    // Nothing in any table changed, so a `records_changed` frame would send every open window off to
    // re-read the graph for a file that appears in none of it.
    boot();
    const socket = new WebSocket(`${fixture!.wsBase}/ws/events`);
    const frames: EventsFrame[] = [];
    await new Promise<void>((done) => {
      socket.addEventListener("open", () => done());
    });
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String(event.data)) as EventsFrame);
    });
    const created = await upload("quiet.txt", "x");
    expect(created.status).toBe(201);
    await Bun.sleep(50);
    expect(frames).toEqual([]);
    socket.close();
  });
});

// -- the two logs ------------------------------------------------------------------------------------

describe("the logs", () => {
  test("a category is required, and an unknown one is refused by name", async () => {
    boot();
    const missing = await getJson("/api/logs");
    expect(missing.status).toBe(422);
    // Both spellings quoted back, because a client that forgot the parameter has not seen them —
    // and there is no default, since the two answer different row shapes and a viewer handed the
    // wrong one would draw an empty section rather than a mistake.
    expect(missing.body.message).toContain("category=errors");
    expect(missing.body.message).toContain("category=deletions");

    expect((await getJson("/api/logs?category=warnings")).status).toBe(422);
  });

  test("errors page backwards from the newest by id", async () => {
    boot();
    const { db } = fixture!.h;
    for (let i = 1; i <= 5; i += 1) logError(db, "turn", `failure ${i}`);

    const newest = (await getJson("/api/logs?category=errors&limit=2")).body;
    expect(newest.category).toBe("errors");
    expect(newest.entries.map((e: { message: string }) => e.message)).toEqual([
      "failure 5",
      "failure 4",
    ]);
    expect(newest.hasMore).toBe(true);

    const older = (
      await getJson(`/api/logs?category=errors&limit=2&before=${newest.entries[1].id}`)
    ).body;
    expect(older.entries.map((e: { message: string }) => e.message)).toEqual([
      "failure 3",
      "failure 2",
    ]);
    expect(older.hasMore).toBe(true);

    const oldest = (
      await getJson(`/api/logs?category=errors&limit=2&before=${older.entries[1].id}`)
    ).body;
    expect(oldest.entries.map((e: { message: string }) => e.message)).toEqual(["failure 1"]);
    expect(oldest.hasMore).toBe(false);
    // A row is handed over as it stands, snake_case and all: these ARE two tables read straight off
    // disk, and renaming their columns on the way to a browser would be a second vocabulary for the
    // same fact.
    expect(Object.keys(oldest.entries[0]).sort()).toEqual([
      "at",
      "detail",
      "id",
      "message",
      "scope",
    ]);
  });

  test("a limit that is not a number, or is absurd, is refused rather than clamped", async () => {
    boot();
    expect((await getJson("/api/logs?category=errors&limit=lots")).status).toBe(422);
    expect((await getJson("/api/logs?category=errors&limit=0")).status).toBe(422);
    expect((await getJson("/api/logs?category=errors&limit=201")).status).toBe(422);
    expect((await getJson("/api/logs?category=errors&limit=200")).status).toBe(200);
  });

  test("each log keeps a thousand rows and drops the oldest", async () => {
    boot();
    const { db } = fixture!.h;
    for (let i = 1; i <= 1001; i += 1) logError(db, "run", `failure ${i}`);

    // A ring rather than a table that grows for ever: the thousandth-newest failure has never once
    // been the one somebody was looking for.
    expect(db.query("SELECT COUNT(*) AS n FROM error_log").get()).toEqual({ n: 1000 });
    const newest = (await getJson("/api/logs?category=errors&limit=1")).body;
    expect(newest.entries[0].message).toBe("failure 1001");
    expect(
      db.query("SELECT COUNT(*) AS n FROM error_log WHERE message = 'failure 1'").get(),
    ).toEqual({ n: 0 });
  });

  test("a deletion comes back as the whole row that left", async () => {
    boot();
    // With a report published under it, because that is what makes the count below say something:
    // the document leaves by cascade and is deliberately not a second entry in the log. The
    // deletion itself goes through the repository, since no route deletes a record any more — what
    // this route owes is the READING of the log, which is a question about the archive rather than
    // about which caller moved it.
    const id = newRecipe("Semis");
    publishReport("NVDA Q2", {}, id);
    deleteRecipe(fixture!.h.db, id);

    const { body } = await getJson("/api/logs?category=deletions");
    expect(body.category).toBe("deletions");
    // ONE row, for a recipe that took its reports with it: the log answers "what did somebody
    // delete", and the answer is a recipe. The cascade is the schema's consequence of that single
    // act, and logging it would say two things happened when one did.
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ table_name: "recipe", row_id: id });
    // The whole row as it stood — its id, the name it answered to (the minted one, because that is
    // what the column held rather than the hint it was minted from), and the specification itself,
    // which is the part that could not have been read back any other way once the row was gone.
    expect(JSON.parse(body.entries[0].row_json)).toMatchObject({
      id,
      name: "semis",
      content: "Lead with the numbers, then say what they do not show.",
    });
    // And the report went with it rather than being left pointing at nothing.
    expect((await getJson("/api/records/report")).body.records).toEqual([]);
  });
});

// -- what the installation announces ------------------------------------------------------------------

describe("telling the other windows", () => {
  test("a witnessed deletion pokes the log viewer wherever the deletion came from", async () => {
    boot();
    const id = newRecipe();
    const watching = openEvents();
    await until(() => watching.ws.readyState === WebSocket.OPEN, "the events socket");

    // Through the repository, because that is the only way a record leaves now — and the poke is
    // attached where the WRITE is rather than where the request was, which is exactly what makes
    // this still true. `attachLogAnnouncer` hangs off the log itself, so a row witnessed leaving
    // reaches every open window whether a tool call, a route or a cascade put it there.
    deleteRecipe(fixture!.h.db, id);

    await until(
      () => watching.frames.some((frame) => frame.type === "deletion_logged"),
      "the deletion poke",
    );
    // No body on it — the window fetches when it cares, and only then. A frame carrying the row
    // would be a second copy of the deletion log for every window to keep in step.
    expect(watching.frames.every((frame) => Object.keys(frame).length <= 2)).toBe(true);

    // AND NO `records_changed` FROM THIS SURFACE, which is an absence worth pinning rather than a
    // gap. That frame means "a table moved", and it is now raised by the tool wrapper, off SQLite's
    // own `total_changes()` — because the agent is what moves tables. The only writer left in the
    // router is the opencode model pool, which is a config file rather than a row, and it is not
    // mounted on this harness at all.
    expect(watching.frames.some((frame) => frame.type === "records_changed")).toBe(false);
    watching.ws.close();
  });

  test("a 500 is filed and announced; a refusal is neither", async () => {
    boot();
    const { db } = fixture!.h;
    const watching = openEvents();
    await until(() => watching.ws.readyState === WebSocket.OPEN, "the events socket");

    // A refusal first. Somebody asked for a recipe that is not there and was told so in a
    // sentence they can act on — that is the system working, and filing it would bury the real
    // failures under a month of ordinary use.
    expect((await getJson(`/api/records/recipe/${newId()}`)).status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS n FROM error_log").get()).toEqual({ n: 0 });

    fixture!.provisioning.failWith = "pip could not reach the index";
    const broken = await send("POST", "/api/venv/retry");
    expect(broken.status).toBe(500);
    // One line to the caller, the whole thing to the log: the stack belongs to whoever is running
    // YewReview, not to whoever is looking at the window.
    expect(broken.body).toEqual({ error: "internal", message: "pip could not reach the index" });

    const row = db
      .query<{ scope: string; message: string; detail: string | null }, []>(
        "SELECT scope, message, detail FROM error_log ORDER BY id DESC LIMIT 1",
      )
      .get()!;
    expect(row.scope).toBe("http");
    expect(row.message).toContain("POST /api/venv/retry failed: pip could not reach the index");
    expect(row.detail).toContain("pip could not reach the index");

    await until(
      () => watching.frames.some((frame) => frame.type === "error_logged"),
      "the error poke",
    );
    watching.ws.close();
  });
});

// -- reports and the browse views --------------------------------------------------------------------

describe("reports and browse views", () => {
  test("deleting a report takes its whole record with it and touches no disk", async () => {
    boot();
    newRecipe();
    const db = fixture!.h.db;
    const script = createScript(db, { name: "prices.py", domain: "prices", source: "print(1)" });
    const reportId = publishReport("NVDA Q2", {
      scriptRuns: [
        {
          scriptId: script.id,
          argument: "--full",
          at: 1_700_000_000_000,
          return: "gross margin 74.6%\n",
          exitCode: 0,
          durationMs: 812,
        },
      ],
      seikanRuns: [
        {
          command: "/opt/venv/bin/seikan run thesis.json --report-out report.json",
          at: 1_700_000_030_000,
          return: '{"cells": []}',
          exitCode: 0,
          durationMs: 5_100,
        },
      ],
      shellRuns: [
        {
          command: "curl -sS https://ir.example/q2",
          at: 1_700_000_060_000,
          return: "<html>…</html>",
          exitCode: 0,
          durationMs: 240,
        },
      ],
    });
    const asset = fixture!.h.putFile("reports/assets/chart.js", "export const chart = 1;\n");

    // Through the repository, since `DELETE /api/reports/:id` went with every other record write —
    // `delete_report` is the door now. What is under test here is the SERVER's half of a deletion:
    // the browser stops answering for the row, and so does the address that served the document,
    // because the document IS one of the rows rather than a file somebody has to remember to unlink.
    expect(deleteReport(db, reportId)).toBe(true);
    expect((await getJson(`/api/records/report/${reportId}`)).status).toBe(404);
    expect((await fetch(`${fixture!.base}/reports/${reportId}`)).status).toBe(404);
    // THREE tables, which is the whole of what hangs off a publication: the stored programs that
    // ran, the measurements, and every other command. All went with the report they were about,
    // without anyone naming them — while the script one of them ran is untouched, because what
    // died is the account of what this document did, not the things it pointed at.
    for (const table of [
      "script_invocation",
      "seikan_invocation",
      "trivial_shell_history_for_report",
    ]) {
      expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(getScript(db, script.id)).not.toBeNull();
    // And ONE witness for the one act. The three run rows left by cascade, which is the schema's
    // consequence of deleting the report rather than a second thing somebody did.
    const witnessed = (await getJson("/api/logs?category=deletions")).body.entries;
    expect(witnessed).toHaveLength(1);
    expect(witnessed[0]).toMatchObject({ table_name: "report", row_id: reportId });
    // Nothing follows the delete: the document was one of the rows, and the only thing left under
    // reports/ is the furniture every published page links, which is nobody's report to remove.
    expect(existsSync(resolve(fixture!.h.varDir, asset))).toBe(true);
    expect((await fetch(`${fixture!.base}/reports/assets/chart.js`)).status).toBe(200);

    // False rather than a refusal the second time: "it is not there" is the state the caller asked
    // for, and the tool above turns that into an ordinary answer.
    expect(deleteReport(db, reportId)).toBe(false);
  });

  test("a source answers with the hostnames it publishes at, and stands at the edge of the graph", async () => {
    // Through the record browser, which is the one door onto every table: there is no per-table
    // read to reach a source by, and the absence of one is pinned elsewhere in this file.
    boot();
    newRecipe();
    const db = fixture!.h.db;
    const sourceId = seedSource(db, "NVIDIA IR", ["ir.example"]);
    publishReport("NVDA Q2");

    const source = await getJson(`/api/records/information_source/${sourceId}`);
    expect(source.status).toBe(200);
    expect(source.body.row.source).toBe("NVIDIA IR");
    // THE ROW AS STORED, which is what the record browser promises and what makes it one door for
    // eleven tables: `hosts` arrives as the JSON text in the column rather than as a parsed array,
    // because a browser that hydrated one table's columns would owe the same for all of them.
    expect(JSON.parse(source.body.row.hosts)).toEqual(["ir.example"]);
    // AND NOTHING POINTS AT IT, IN EITHER DIRECTION — an absence pinned rather than a test deleted.
    // A report used to name the addresses it said it had read and the source publishing at each,
    // and those rows were the model's account of its own reading: nothing fetched the page and
    // nothing compared the quoted sentence to it. They are gone, so the address book is a leaf of
    // the graph, and what a published document says about a source is in the document.
    expect(source.body.referrers).toEqual([]);
    expect(source.body.referents).toEqual([]);

    const missing = await getJson(`/api/records/information_source/${newId()}`);
    expect(missing.status).toBe(404);
  });

  test("targets and sources are readable through the record browser", async () => {
    boot();
    const db = fixture!.h.db;
    seedTarget(db, "NVDA");
    seedTarget(db, "AMD");
    seedSource(db, "NVIDIA IR", ["ir.example"]);

    expect((await getJson("/api/records/target")).body.records).toHaveLength(2);
    expect((await getJson("/api/records/information_source")).body.records).toHaveLength(1);
    expect((await getJson("/api/records/thesis")).body.records).toEqual([]);
  });

  test("retrying the venv re-runs provisioning and answers with its state", async () => {
    boot();
    const { status, body } = await send("POST", "/api/venv/retry");
    expect(status).toBe(200);
    expect(body.venv).toEqual({ ready: true, seikanVersion: "9.9.9", error: null });
    expect(fixture!.provisioning.runs).toBe(1);
  });
});

// -- the two records that are the user's, and are no longer written here ---------------------------

/**
 * TWO WHOLE SUITES USED TO LIVE HERE, and what happened to them is the clearest statement this file
 * can make about the change. `POST /api/workshops/:id/playbook` and `POST|PATCH|DELETE /api/sources`
 * were the last write routes in this server, and they were the last for a real reason: the
 * specification its owner is commissioning work against, and the address book that is their standing
 * account of where their numbers come from. Neither is the agent's account of anything, so both were
 * typed into forms.
 *
 * They are written from the conversation now, and every rule those suites pinned is still pinned —
 * one layer down, where it always lived. Empty content refused, the text immutable once stored, a
 * retired specification refused a procedure; hostname normalisation, the type vocabulary, the
 * credential-by-name rule, a duplicate site refused, a patch that leaves out what it leaves out.
 * `repo/recipes.ts` and `repo/sources.ts` hold them, `tests/tools.test.ts` exercises them through
 * the tools the user now agrees to, and `tests/sources.test.ts` and `tests/reports.test.ts` hold the
 * repositories directly. Nothing was dropped; one caller was.
 *
 * ONE OF THOSE SUITES PINNED A LINEAGE, AND THERE IS NO LINEAGE LEFT TO PIN. A specification was an
 * append-only ledger of versions, so this file asserted that every version read back, that exactly
 * one was marked operative, and that the oldest still said what it said. A recipe's text cannot
 * change at all — `recipe_moves_only_its_status` refuses the UPDATE — so "the oldest still says what
 * it said" is a statement about every row rather than a property this route can demonstrate, and it
 * is pinned in the schema's own tests. What is left for this file to say is that both archives READ,
 * because reading them is what this window still does and the record browser is the only door onto
 * either.
 */
describe("the two records the user agrees to, read through the one door", () => {
  test("a recipe reads back whole, and what was published to it is one walk away", async () => {
    boot();
    const id = newRecipe();
    const reportId = publishReport("NVDA Q2", {}, id);

    const listed = (await getJson("/api/records/recipe")).body.records;
    expect(listed.map((row: { id: string }) => row.id)).toEqual([id]);

    // THE WHOLE ROW, TEXT INCLUDED, which is the one place this browser hands back a document
    // rather than a summary of one: a recipe IS its content, and a detail that showed everything
    // except what the reports were written to would be an index of nothing.
    const detail = await getJson(`/api/records/recipe/${id}`);
    expect(detail.body.row.content).toBe(
      "Lead with the numbers, then say what they do not show.",
    );
    expect(detail.body.row.status).toBe("active");

    // And the documents published to it are the edge, which is how a reader gets from the
    // instructions to the work — and, from the other end, from a document back to the exact words
    // it was written to.
    const published = detail.body.referrers.find((g: { table: string }) => g.table === "report");
    expect(published).toMatchObject({ table: "report", total: 1, onDelete: "CASCADE" });
    expect(published.records[0].id).toBe(reportId);
    const report = await getJson(`/api/records/report/${reportId}`);
    expect(
      report.body.referents.find((g: { table: string }) => g.table === "recipe").records[0].id,
    ).toBe(id);
  });

  test("the address book reads back as rows, with the hostnames each says it publishes at", async () => {
    boot();
    const db = fixture!.h.db;
    const id = seedSource(db, "Apple IR", ["investor.apple.com"]);

    const listed = (await getJson("/api/records/information_source")).body.records;
    expect(listed.map((row: { id: string }) => row.id)).toEqual([id]);
    const detail = await getJson(`/api/records/information_source/${id}`);
    expect(detail.body.row.source).toBe("Apple IR");
    // THE ROW AS STORED, which is what the record browser promises and what makes it one door for
    // twelve tables: `hosts` arrives as the JSON text the column holds rather than as a parsed
    // array, because a browser that hydrated one table's columns would owe the same for all of them.
    expect(JSON.parse(detail.body.row.hosts)).toEqual(["investor.apple.com"]);
  });
});
// -- the record browser ------------------------------------------------------------------------------

describe("the record browser", () => {
  test("a table lists, a record opens, and a referrer group pages on its own", async () => {
    boot();
    newRecipe();
    const reportId = publishReport("NVDA Q2", {
      shellRuns: [
        {
          command: "curl -sS https://ir.example/q2",
          at: 1_700_000_000_000,
          return: "<html>…</html>",
          exitCode: 0,
          durationMs: 240,
        },
        {
          command: "python -c 'print(1)'",
          at: 1_700_000_060_000,
          return: "1\n",
          exitCode: 0,
          durationMs: 31,
        },
      ],
    });

    const listed = await getJson("/api/records/report");
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ table: "report", hasMore: false });
    expect(listed.body.records[0]).toMatchObject({ table: "report", id: reportId, label: "NVDA Q2" });
    // WHAT THE DOCUMENT WAS WRITTEN TO, and nothing else. The sublabel used to count the citations
    // the report declared; those rows are gone, and a card that still promised a number beside every
    // report would be a listing making a claim the schema cannot answer. It carries no version
    // number either — there are none to carry now, and a number on a card asked a reader to hold a
    // count in their head to tell two documents apart. The recipe is what somebody scanning a list
    // of reports is actually sorting by.
    expect(listed.body.records[0].sublabel).toBe("under semis");

    const detail = await getJson(`/api/records/report/${reportId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.card.id).toBe(reportId);
    // The row a detail hands back is every column but the one that is a whole document: the browser
    // says how big it is and leaves reading it to the URL that serves it.
    expect(detail.body.row).not.toHaveProperty("content");
    expect(detail.body.row.content_bytes).toBe(DOCUMENT("NVDA Q2").length);

    // A report's shell history is the group that grows without bound — every command a generation
    // procedure ran lands in it — so it is the one "show more" exists for, and the one worth paging
    // here. `total` counts the whole edge whatever the page carries.
    const page = await getJson(
      `/api/records/report/${reportId}/referrers/trivial_shell_history_for_report?limit=1`,
    );
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      table: "trivial_shell_history_for_report",
      onDelete: "CASCADE",
      total: 2,
      hasMore: true,
    });
    expect(page.body.records).toHaveLength(1);
    // Newest first, and the label is the command line itself — which is the whole of what names a
    // row in this table, there being no stored program for it to point at.
    expect(page.body.records[0].label).toBe("python -c 'print(1)'");
  });

  test("an edge that travels through a junction says which one, from both ends", async () => {
    // `regime` is the last junction in the schema, and it is drawn ONCE: as a referent of the
    // thesis that declares the tickers it is measured against, and as a referrer of each target.
    // Deriving it in both directions from both ends would put the same list under a record's
    // "points to" and its "pointed at by", where one of the two is always a lie about who declared
    // the link.
    boot();
    const db = fixture!.h.db;
    const thesisId = seedThesis(db, "NVDA compounds");
    seedTarget(db, "NVDA");
    db.query("INSERT INTO regime (thesis_id, ticker) VALUES (?, 'NVDA')").run(thesisId);

    const thesis = await getJson(`/api/records/thesis/${thesisId}`);
    const measured = thesis.body.referents.find((g: { via?: string }) => g.via === "regime");
    // NO ACTION at this end: a target may not be deleted out from under a thesis whose regime
    // covers it, and the group says so beside the rows rather than only at deletion time.
    expect(measured).toMatchObject({ table: "target", onDelete: "NO ACTION", total: 1 });
    expect(measured.records[0].id).toBe("NVDA");
    // And the junction is not among the things the thesis is pointed at BY — an edge is drawn from
    // the declaring end only.
    expect(thesis.body.referrers.some((g: { via?: string }) => g.via === "regime")).toBe(false);

    const back = await getJson(`/api/records/target/NVDA/referrers/thesis?limit=1`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ table: "thesis", via: "regime", total: 1 });
    expect(back.body.records[0].id).toBe(thesisId);
  });

  test("a record opens by the name it answers to, and the answer is the same detail", async () => {
    // THE OTHER WAY IN, and the one a mention on the wire uses: a drag puts `@table:name` in the
    // composer, so the window has a name where it needs a record. This route is what turns the pair
    // back into the detail, and it answers the SAME shape as the id route rather than a lookup
    // result somebody would then have to fetch with — one round trip, and no second projection of a
    // record to keep in step with the first.
    boot();
    const id = newRecipe("Semis");
    const byId = await getJson(`/api/records/recipe/${id}`);
    const byName = await getJson("/api/records/recipe/named?name=semis");
    expect(byName.status).toBe(200);
    expect(byName.body).toEqual(byId.body);

    // Case-insensitive, like the unique index that makes the name mean one row.
    expect((await getJson("/api/records/recipe/named?name=SEMIS")).body.card.id).toBe(id);

    // A name is unique WITHIN a table and nowhere wider, so the table in the path is half the
    // question: the same word in another table is a different record or none at all.
    const missing = await getJson("/api/records/thesis/named?name=semis");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("not_found");
    expect(missing.body.message).toBe('no thesis is called "semis"');

    // Asking without saying what for is a refusal rather than a listing: a bare `named` is a
    // question that was not finished, and answering it with the whole table would be inventing the
    // rest of it.
    const bare = await getJson("/api/records/recipe/named");
    expect(bare.status).toBe(422);
    expect(bare.body.error).toBe("invalid_request");
    expect(bare.body.message).toContain("?name=");

    // And a junction refuses the way it refuses on every other route here — an edge is not a record
    // and has no name to be asked for — rather than answering "nothing is called that", which would
    // say the table is a place a name could live.
    const junction = await getJson("/api/records/regime/named?name=semis");
    expect(junction.status).toBe(404);
    expect(junction.body.message).toContain("link between records");
  });

  test("a name with a slash or a space in it is asked for whole", async () => {
    // WHY THE NAME RIDES A QUERY PARAMETER rather than a third path segment. It is the user's to
    // write and this route is declared beside `/:id`, so a name holding a `/` would be split into
    // two segments by the router before anything had decided what it was looking at — and a name
    // holding a space would be a path that only works percent-encoded by luck.
    boot();
    const id = newRecipe();
    const wanted = "semis / q3 notes";
    // Renamed through the repository, because `PATCH /api/records/:table/:id/name` is gone with
    // every other write here and `rename_record` is the door. What this route owes is unchanged:
    // whatever a row ends up called, asking for it by that name has to reach it.
    renameRecord(fixture!.h.db, "recipe", id, wanted);

    const found = await getJson(`/api/records/recipe/named?name=${encodeURIComponent(wanted)}`);
    expect(found.status).toBe(200);
    expect(found.body.card.id).toBe(id);
    expect(found.body.card.name).toBe(wanted);
  });

  test("a minted name is the bare slug, and this surface has no way to change it", async () => {
    boot();
    const id = newRecipe();
    const before = await getJson(`/api/records/recipe/${id}`);
    // THE BARE SLUG, with nothing stapled to it. A name is a condensed summary of what the row
    // holds, and the summary of the first recipe about semiconductors is `semis`; only a second
    // one asking for the same words pays for the ambiguity it created, with a four-character
    // suffix. There is no table prefix either — a name is never read on its own, only ever
    // alongside the table it belongs to.
    expect(before.body.card.name).toBe("semis");

    // AND THE RENAME ROUTE IS GONE, WHICH IS THE HARDEST OF THESE ABSENCES TO ARGUE AND THEREFORE
    // WORTH ARGUING. A name asserts nothing about the world, nothing joins on it, and every id
    // survives one — so `PATCH /api/records/:table/:id/name` was the one write a browser could not
    // implement wrongly, and it was the last one standing here for exactly that reason. It went
    // because "this window writes nothing" is a rule that holds, where "this window writes nothing
    // except names" is a rule with an edge somebody eventually argues about; and because a rename
    // asked for in conversation arrives with a reason attached, which a text field never does.
    const renamed = await send("PATCH", `/api/records/recipe/${id}/name`, { name: "macro" });
    expect(renamed.status).toBe(404);
    expect((await getJson(`/api/records/recipe/${id}`)).body.card.name).toBe("semis");

    // The uniqueness rule it enforced did NOT go with it: names are unique within a table, by a
    // UNIQUE index, so two recipes asking for the same words is settled by the minting rather than
    // by whoever was writing the route. The second one pays for the ambiguity it created.
    const twin = newRecipe("Semis");
    expect((await getJson(`/api/records/recipe/${twin}`)).body.card.name).toMatch(
      /^semis-[a-z0-9]{4}$/,
    );
  });

  test("the whole provenance chain is one walk, from the document to the program", async () => {
    boot();
    const recipeId = newRecipe();
    const db = fixture!.h.db;
    const { thesisId, assessmentId } = judgedThesis(db, "NVDA compounds");
    const script = createScript(db, { name: "prices.py", domain: "prices", source: "print(1)" });
    const preparationId = newId();
    db.query(
      `INSERT INTO series_preparation (name, id, thesis_assessment_id, script_id, argument, created_at)
       VALUES ('prep-' || lower(hex(randomblob(5))), ?, ?, ?, '--ticker NVDA', ?)`,
    ).run(preparationId, assessmentId, script.id, nowMs());
    const reportId = publishReport(
      "NVDA Q2",
      {
        scriptRuns: [
          {
            scriptId: script.id,
            argument: "--ticker NVDA",
            at: 1_700_000_000_000,
            return: "74.6\n",
            exitCode: 0,
            durationMs: 903,
          },
        ],
      },
      recipeId,
    );

    // Report → the recipe it was written to. ONE STEP, where it used to be two: the document
    // pointed at a playbook version and the version at its workshop, and a reader wanting the
    // instructions behind a report walked through a row whose only content was a number. This is
    // still why the browser refuses to slice a table by recipe — the recipe is REACHED, through the
    // key that actually records the relationship, rather than filtered for.
    const report = await getJson(`/api/records/report/${reportId}`);
    expect(report.body.row.recipe_id).toBe(recipeId);
    const under = report.body.referents.find((g: { table: string }) => g.table === "recipe");
    expect(under).toMatchObject({ table: "recipe", total: 1, onDelete: "CASCADE" });
    expect(under.records[0].id).toBe(recipeId);

    // Report ← the run it recorded → the program that ran. THE DOCUMENT-TO-PROGRAM WALK, and the
    // only one a report has: what is kept about a publication is what a machine watched happen, so
    // the chain out of a document leads to a stored program and what it printed rather than to
    // anything the model said about its own reading.
    const ran = report.body.referrers.find(
      (g: { table: string }) => g.table === "script_invocation",
    );
    expect(ran).toMatchObject({ total: 1, onDelete: "CASCADE" });
    const invocation = await getJson(`/api/records/script_invocation/${ran.records[0].id}`);
    expect(invocation.body.row).toMatchObject({
      argument: "--ticker NVDA",
      return: "74.6\n",
      exit_code: 0,
      duration_ms: 903,
      created_at: 1_700_000_000_000,
    });
    expect(
      invocation.body.referents.find((g: { table: string }) => g.table === "script"),
    ).toMatchObject({ total: 1 });

    // Assessment → the thesis it judges, and ← the preparation that says what produced its inputs.
    const assessment = await getJson(`/api/records/thesis_assessment/${assessmentId}`);
    expect(assessment.body.card.label).toContain("insightful");
    expect(
      assessment.body.referents.find((g: { table: string }) => g.table === "thesis"),
    ).toMatchObject({ total: 1 });
    const prepared = assessment.body.referrers.find(
      (g: { table: string }) => g.table === "series_preparation",
    );
    expect(prepared).toMatchObject({ total: 1, onDelete: "CASCADE" });
    expect(prepared.records[0].id).toBe(preparationId);

    // And the preparation names the program, which is the last link: what produced the numbers the
    // reading was read off, still stored and still readable years later.
    const preparation = await getJson(`/api/records/series_preparation/${preparationId}`);
    expect(preparation.body.card.label).toContain("--ticker NVDA");
    expect(
      preparation.body.referents.find((g: { table: string }) => g.table === "script"),
    ).toMatchObject({ total: 1 });
    expect((await getJson(`/api/records/thesis/${thesisId}`)).body.card.sublabel).toBe("insightful");
  });

  test("a table is the whole table, and naming a recipe narrows nothing", async () => {
    boot();
    const mine = newRecipe("Mine");
    const theirs = newRecipe("Theirs");
    publishReport("Mine's", {}, mine);
    publishReport("Theirs'", {}, theirs);

    const whole = await getJson("/api/records/report");
    expect(whole.body.records).toHaveLength(2);
    // A report is reached through the recipe it was written to and a recorded command through its
    // report, which is the walk the browser exists for. So there is no filter to apply, and a
    // client still sending one is answered with the table rather than refused: the parameter names
    // nothing this route reads, under either the word this schema uses or the one it used to.
    for (const stale of [mine, theirs, "NOT-A-UUID"]) {
      for (const param of ["recipe", "workshop"]) {
        const asked = await getJson(`/api/records/report?${param}=${stale}`);
        expect(asked.status).toBe(200);
        expect(asked.body.records).toHaveLength(2);
      }
    }
  });

  test("a target is addressed by the ticker itself, decoded but never re-spelled", async () => {
    boot();
    // No recipe: an instrument is global, so there is nothing for one to add here. Every id in
    // this schema is a uuid or a ticker and none of them can contain a slash — but the segment
    // is still DECODED, so a client that percent-encodes a dot is asking about the same instrument.
    const db = fixture!.h.db;
    seedTarget(db, "BRK.B");
    const thesisId = seedThesis(db, "the float compounds");
    db.query("INSERT INTO regime (thesis_id, ticker) VALUES (?, 'BRK.B')").run(thesisId);

    const { status, body } = await getJson(`/api/records/target/BRK%2EB`);
    expect(status).toBe(200);
    expect(body.card.id).toBe("BRK.B");
    // And a ticker is normalised on the way in, the way every other symbol in YewReview is: one
    // company, however the client happened to spell it.
    expect((await getJson("/api/records/target/brk.b")).body.card.id).toBe("BRK.B");
    const measuring = body.referrers.find((g: { via?: string }) => g.via === "regime");
    expect(measuring).toMatchObject({ table: "thesis", onDelete: "NO ACTION", total: 1 });
    expect(measuring.records[0].id).toBe(thesisId);
  });

  test("the two logs are not records, and the browser says so", async () => {
    boot();
    logError(fixture!.h.db, "http", "something went wrong");

    // They are tables in this schema with rows in them right now, and they are still refused here:
    // a log is read as a stream through `/api/logs`, has no card, and is named by nothing. Listing
    // one beside the archive would say the two are the same kind of thing.
    for (const table of ["error_log", "deletion_log"]) {
      const refused = await getJson(`/api/records/${table}`);
      expect(refused.status).toBe(404);
      expect(refused.body.message).toContain("information_source");
    }
  });

  test("the refusals a browser can provoke arrive as themselves", async () => {
    boot();
    newRecipe();

    const unknown = await getJson("/api/records/sqlite_master");
    expect(unknown.status).toBe(404);
    // The refusal names the whitelist, so a mistyped table is answered with the ones that exist.
    expect(unknown.body.message).toContain("information_source");
    expect(unknown.body.message).toContain("thesis_assessment");
    // And a name this schema does not have is not in it either, which is the half of the sentence
    // that tells a reader the table does not exist rather than that they mistyped one that does.
    expect(unknown.body.message).not.toContain("series,");
    expect(unknown.body.message).not.toContain("message");

    const junction = await getJson(`/api/records/regime/${newId()}`);
    expect(junction.status).toBe(404);
    expect(junction.body.message).toContain("via regime");
    // And a junction this schema USED to have is refused as a table nobody has heard of rather than
    // as an edge: `application` named the readings a report said it applied, and no such row exists
    // to be reached by any spelling.
    expect((await getJson(`/api/records/application/${newId()}`)).body.message).toContain(
      "information_source",
    );

    for (const limit of ["0", "101", "lots"]) {
      expect((await getJson(`/api/records/report?limit=${limit}`)).status).toBe(422);
    }
    expect((await getJson(`/api/records/report/${newId()}`)).status).toBe(404);
    expect((await getJson("/api/records/report/not-a-uuid")).status).toBe(422);
    // Reads only: the browser has no write surface at all.
    expect((await send("POST", "/api/records/report")).status).toBe(405);
  });
});

// -- the published document ------------------------------------------------------------------------

describe("serving a published report", () => {
  test("the document comes out of the database, byte for byte, in a sandbox", async () => {
    boot();
    newRecipe();
    const document =
      '<!doctype html><meta charset="utf-8"><title>NVDA Q2</title>' +
      '<p id="claim-margin">毛利率 74.6% — “as reported”.</p>';
    const id = publishReport("NVDA Q2", {}, undefined, document);

    const response = await fetch(`${fixture!.base}/reports/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // This origin holds the whole archive and a published document runs in it.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // The row is immutable, so the bytes behind one id never change — but the id can stop naming
    // anything, and a cached copy would go on serving a document its owner asked to forget.
    expect(response.headers.get("cache-control")).toBe("no-cache");
    // The exact policy, character for character. `sandbox` drops the document into an opaque origin
    // so its own JavaScript is no longer same-origin with `/api/**`; `allow-scripts` keeps the
    // charts drawing; the two popup directives keep `target="_blank"` citation links opening as
    // ordinary tabs; `connect-src 'none'` is what stops a published page fetching the API that
    // served it. A test on the whole string rather than on a substring, because dropping one
    // directive is exactly how this stops meaning anything.
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; connect-src 'none'",
    );
    expect(await response.text()).toBe(document);
  });

  test("an id naming nothing is a 404, and a report is one segment and never a path", async () => {
    boot();
    newRecipe();
    const id = publishReport();

    const missing = await fetch(`${fixture!.base}/reports/${newId()}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("not_found");

    // A report is addressed by its id and by nothing else, so anything deeper matches no pattern
    // rather than being read as a path inside a document.
    expect((await fetch(`${fixture!.base}/reports/${id}/index.html`)).status).toBe(404);
    expect((await fetch(`${fixture!.base}/reports/${id}`, { method: "DELETE" })).status).toBe(405);
  });
});

// -- the assets tree ---------------------------------------------------------------------------------

describe("serving var/reports/assets", () => {
  test("the furniture a document loads is still a file, will not be sniffed, and is not sandboxed", async () => {
    boot();
    fixture!.h.putFile("reports/assets/echarts.min.js", "export const chart = 1;\n");
    const response = await fetch(`${fixture!.base}/reports/assets/echarts.min.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // The library is REPLACED in place under the name every published document already links, so a
    // cached copy would draw last month's charts inside a report served fresh from the database.
    expect(response.headers.get("cache-control")).toBe("no-cache");
    // No CSP here, deliberately. The policy belongs to the DOCUMENT — a sandboxed page carries its
    // opaque origin to everything it loads — and a `sandbox` directive on the chart library itself
    // would put the script in an origin of its own, which is not a place a document can call into.
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(await response.text()).toContain("chart");
  });

  test("a document and the assets tree share a prefix without colliding", async () => {
    boot();
    newRecipe();
    const id = publishReport();
    fixture!.h.putFile("reports/assets/echarts.min.js", "export const chart = 1;\n");

    const document = await fetch(`${fixture!.base}/reports/${id}`);
    expect(document.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const asset = await fetch(`${fixture!.base}/reports/assets/echarts.min.js`);
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    // `assets` is a segment no report id can be spelled as, and it is matched first.
    expect((await fetch(`${fixture!.base}/reports/assets`)).status).toBe(404);
  });

  test("an escaped traversal cannot reach the database", async () => {
    boot();
    // `%2e%2e%2f` rather than `../`: a URL parser rewrites a real double-dot segment before it
    // reaches the wire, so this is the spelling an attacker would actually send — and the one that
    // survives until the server decodes it.
    const escaped = await fetch(
      `${fixture!.base}/reports/assets/%2e%2e%2f%2e%2e%2fdb/yewreview.sqlite`,
    );
    // 404 and never 403: a "forbidden" answer confirms what is there, and whoever typed it has no
    // business knowing either way.
    expect(escaped.status).toBe(404);
    expect(((await escaped.json()) as { error: string }).error).toBe("not_found");

    // And the literal forms, checked below the wire because no HTTP client will send them intact.
    const { settings } = fixture!;
    expect(resolveAssetFile(settings, "/reports/assets/../../db/yewreview.sqlite")).toBeNull();
    expect(resolveAssetFile(settings, "/reports/assets/../../../etc/hosts")).toBeNull();
    // A malformed escape is not a path anybody meant to type.
    expect(resolveAssetFile(settings, "/reports/assets/%zz")).toBeNull();
    // And this module serves the assets tree and nothing else: a report is not a file it can reach.
    expect(resolveAssetFile(settings, "/reports/nvda.html")).toBeNull();
  });

  test("a symlink out of the assets tree is refused even though its spelling is innocent", async () => {
    boot();
    const { settings, h } = fixture!;
    const outside = resolve(h.varDir, "db/yewreview.sqlite");
    const link = resolve(paths(settings).reportAssetsDir, "escape.js");
    Bun.spawnSync(["ln", "-s", outside, link]);
    // A lexical answer is satisfied by any symlink; only the real path can be compared against the
    // real root.
    expect(resolveAssetFile(settings, "/reports/assets/escape.js")).toBeNull();
    expect((await fetch(`${fixture!.base}/reports/assets/escape.js`)).status).toBe(404);
  });

  test("a directory, a missing file and a non-GET are all refused", async () => {
    boot();
    fixture!.h.putFile("reports/assets/vendor/echarts.min.js", "export const chart = 1;\n");
    // There is no index to hand out.
    expect((await fetch(`${fixture!.base}/reports/assets/vendor/`)).status).toBe(404);
    expect((await fetch(`${fixture!.base}/reports/assets/gone.js`)).status).toBe(404);
    expect(
      (await fetch(`${fixture!.base}/reports/assets/gone.js`, { method: "DELETE" })).status,
    ).toBe(405);
  });
});

// -- the chat socket -----------------------------------------------------------------------------------

/** Open the chat socket and collect every frame it is sent, in arrival order. No id in the path:
 * there is one conversation for the installation. */
function openSocket(): {
  ws: WebSocket;
  frames: OutboundFrame[];
  closed: Promise<CloseEvent>;
} {
  const ws = new WebSocket(`${fixture!.wsBase}/ws/chat`);
  const frames: OutboundFrame[] = [];
  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as OutboundFrame);
  });
  const closed = new Promise<CloseEvent>((done) => {
    ws.addEventListener("close", (event) => done(event as CloseEvent));
  });
  return { ws, frames, closed };
}

describe("the chat socket", () => {
  test("ready, then a turn, then its frames in the order the agent produced them", async () => {
    boot();
    const { ws, frames } = openSocket();
    await until(() => frames.length >= 1, "the ready frame");

    // Which model is speaking, whether it remembers anything, and WHICH conversation this is —
    // delivered before any other frame, because the browser needs the session id to fetch the
    // transcript it is about to draw over.
    expect(frames[0]).toEqual({
      type: "ready",
      model: "fake-model",
      // What the picker in the composer may offer. It rides on this frame because it is a fact
      // about the conversation's world rather than about the archive.
      models: [{ value: "fake-model", displayName: "Fake" }],
      // And how hard it is being asked to work, which is always one of the five and never null:
      // `toEqual` here is the assertion that a window is told the level before it draws a picker,
      // rather than being left to guess at what a conversation nobody has touched runs at.
      effort: "high",
      // And whether it may delegate, told on the same frame and for the same reason: a toggle drawn
      // before the agent has said which way it is pointing is a toggle drawn from a guess.
      subagents: true,
      fresh: true,
      venvReady: true,
      sessionId: null,
    });

    ws.send(JSON.stringify({ type: "user_message", text: "  what happened to margins?  " }));
    const agent = fixture!.agent;
    await until(() => agent.turns.length === 1, "the turn to reach the agent");
    // Trimmed, and that is the whole of what rides with a turn: there are no carried-context chips,
    // because with no message table there are no rows for one to name.
    expect(agent.turns[0]).toBe("what happened to margins?");

    agent.emit({ type: "turn_started" });
    agent.emit({ type: "text_delta", text: "Gross " });
    agent.emit({ type: "text_delta", text: "margin " });
    agent.emit({ type: "compacted", trigger: "auto" });
    agent.emit({
      type: "report_published",
      reportId: "r1",
      title: "NVDA Q2",
      url: "/reports/r1",
    });
    // THE WHOLE FRAME, WHICH IS TWO FIELDS. It used to carry what the turn cost, its token usage
    // and how many turns the SDK took; nothing in the window drew any of them, and a frame carrying
    // a number nobody reads is a promise between the two sides that goes stale without ever
    // failing. What survived is how the turn ended, which a window does draw.
    agent.emit({ type: "turn_result", subtype: "success" });

    await until(() => frames.length >= 7, "the whole turn");
    expect(frames.slice(1).map((f) => f.type)).toEqual([
      "turn_started",
      "text_delta",
      "text_delta",
      "compacted",
      "report_published",
      "turn_result",
    ]);
    ws.close();
  });

  test("ping, interrupt, blank text and malformed frames", async () => {
    boot();
    const { ws, frames } = openSocket();
    await until(() => frames.length >= 1, "the ready frame");
    const agent = fixture!.agent;

    ws.send(JSON.stringify({ type: "ping" }));
    await until(() => frames.some((f) => f.type === "pong"), "a pong");

    ws.send(JSON.stringify({ type: "interrupt" }));
    await until(() => agent.interrupts === 1, "the interrupt");

    // A blank message is a stray keypress: nothing is submitted and nothing is said about it.
    ws.send(JSON.stringify({ type: "user_message", text: "   " }));
    ws.send("not json at all");
    await until(() => frames.some((f) => f.type === "error"), "a refusal for the bad frame");
    expect(agent.turns).toHaveLength(0);
    expect(frames.filter((f) => f.type === "error")).toHaveLength(1);
    ws.close();
  });

  test("set_model reaches the agent, and only a refusal comes back down this socket", async () => {
    boot();
    const { ws, frames } = openSocket();
    await until(() => frames.length >= 1, "the ready frame");
    const agent = fixture!.agent;

    ws.send(JSON.stringify({ type: "set_model", model: "  claude-sonnet-5  " }));
    await until(() => agent.modelsSet.length === 1, "the model change");
    // Trimmed on the way through, and nothing is pushed on success: the agent re-emits `ready` to
    // EVERY window, which is what makes a second tab agree with the first.
    expect(agent.modelsSet).toEqual(["claude-sonnet-5"]);
    expect(frames.some((f) => f.type === "error")).toBe(false);

    // The refusal is the one thing that comes back here, because only the window that asked is
    // waiting for one.
    agent.modelRefusal = { code: "conflict", message: "the agent is still working" };
    ws.send(JSON.stringify({ type: "set_model", model: "claude-opus-5" }));
    await until(() => frames.some((f) => f.type === "error"), "the refusal");
    expect(frames.find((f) => f.type === "error")).toMatchObject({ code: "conflict" });

    // A frame with nothing to set is a bad frame rather than a model named "".
    agent.modelRefusal = null;
    ws.send(JSON.stringify({ type: "set_model", model: "   " }));
    await until(
      () => frames.filter((f) => f.type === "error").length === 2,
      "the bad-frame refusal",
    );
    expect(frames.filter((f) => f.type === "error").at(-1)).toMatchObject({ code: "bad_frame" });
    // Two reached the agent — the one it accepted and the one it refused, since refusing is the
    // AGENT's job — and the blank one never left this socket.
    expect(agent.modelsSet).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    ws.close();
  });

  test("set_effort reaches the agent the same way, and is not checked against the five here", async () => {
    boot();
    const { ws, frames } = openSocket();
    await until(() => frames.length >= 1, "the ready frame");
    const agent = fixture!.agent;

    ws.send(JSON.stringify({ type: "set_effort", effort: "  xhigh  " }));
    await until(() => agent.effortsSet.length === 1, "the effort change");
    // Trimmed on the way through, and nothing is pushed on success: the agent re-emits `ready` to
    // EVERY window, and a confirmation down this one socket would be a second answer that only the
    // tab which asked could hear.
    expect(agent.effortsSet).toEqual(["xhigh"]);
    expect(frames.some((f) => f.type === "error")).toBe(false);

    // The refusal is the one thing that comes back here, because only the window that asked is
    // waiting for one. `conflict` is the refusal that matters most: the agent will not change how
    // hard it works while it is working.
    agent.effortRefusal = { code: "conflict", message: "the agent is still working" };
    ws.send(JSON.stringify({ type: "set_effort", effort: "max" }));
    await until(() => frames.some((f) => f.type === "error"), "the refusal");
    expect(frames.find((f) => f.type === "error")).toMatchObject({ code: "conflict" });

    // A frame with nothing to set is a bad frame rather than a level named "". That is the ONLY
    // thing this socket judges about a level: whether the five names are the five is the agent's
    // to answer, and a second list here would be a second thing to keep in step with the SDK.
    agent.effortRefusal = null;
    ws.send(JSON.stringify({ type: "set_effort", effort: "   " }));
    await until(
      () => frames.filter((f) => f.type === "error").length === 2,
      "the bad-frame refusal",
    );
    expect(frames.filter((f) => f.type === "error").at(-1)).toMatchObject({ code: "bad_frame" });
    expect(agent.effortsSet).toEqual(["xhigh", "max"]);
    ws.close();
  });

  test("set_subagents reaches the agent, and a payload that is not a boolean never does", async () => {
    boot();
    const { ws, frames } = openSocket();
    await until(() => frames.length >= 1, "the ready frame");
    const agent = fixture!.agent;

    ws.send(JSON.stringify({ type: "set_subagents", enabled: false }));
    await until(() => agent.subagentsSet.length === 1, "the change to reach the agent");
    // Nothing comes back on success: the agent re-emits `ready` to EVERY window, which is what makes
    // a second tab agree with the first about what this conversation may do.
    expect(agent.subagentsSet).toEqual([false]);
    expect(frames.some((f) => f.type === "error")).toBe(false);

    // The refusal is the one thing that comes back down this socket, and for this frame it is the
    // likeliest answer of the three: honouring the change ends the agent's session, so it cannot
    // happen while a turn is in flight.
    agent.subagentsRefusal = { code: "conflict", message: "the agent is still working" };
    ws.send(JSON.stringify({ type: "set_subagents", enabled: true }));
    await until(() => frames.some((f) => f.type === "error"), "the refusal");
    expect(frames.find((f) => f.type === "error")).toMatchObject({ code: "conflict" });

    // And the payload check, which is this socket's own rather than the agent's — unlike a level,
    // there are exactly two meaningful answers and nothing for the agent to narrow, so a string that
    // reads like one is a bad frame and never reaches it.
    agent.subagentsRefusal = null;
    ws.send(JSON.stringify({ type: "set_subagents", enabled: "yes" }));
    await until(
      () => frames.filter((f) => f.type === "error").length === 2,
      "the bad-frame refusal",
    );
    expect(frames.filter((f) => f.type === "error").at(-1)).toMatchObject({ code: "bad_frame" });
    expect(agent.subagentsSet).toEqual([false, true]);
    ws.close();
  });

  test("a message sent while the agent is working is refused as busy", async () => {
    boot();
    const { ws, frames } = openSocket();
    await until(() => frames.length >= 1, "the ready frame");
    const agent = fixture!.agent;

    // ONE TURN AT A TIME. A turn in flight refuses the message before the agent ever sees it —
    // the socket reads the snapshot, and the refusal goes down this socket alone.
    agent.busy = true;
    ws.send(JSON.stringify({ type: "user_message", text: "one more" }));
    await until(() => frames.some((f) => f.type === "error"), "the busy refusal");
    const refusal = frames.find((f) => f.type === "error") as { code: string; message: string };
    expect(refusal.code).toBe("busy");
    expect(refusal.message).toContain("stop it");
    expect(agent.turns).toHaveLength(0);

    // The handoff window counts too: a turn submitted but not yet started is a turn, and `queued`
    // is the only field that can see it while `busy` is still false.
    agent.busy = false;
    agent.queued = 1;
    ws.send(JSON.stringify({ type: "user_message", text: "still too soon" }));
    await until(() => frames.filter((f) => f.type === "error").length === 2, "the second refusal");
    expect(agent.turns).toHaveLength(0);

    // And an idle agent takes the message: the refusal is about the work, never about the words.
    agent.queued = 0;
    ws.send(JSON.stringify({ type: "user_message", text: "now it goes" }));
    await until(() => agent.turns.length === 1, "the accepted turn");
    expect(agent.turns).toEqual(["now it goes"]);
    ws.close();
  });

  test("two tabs share the one agent and both see every frame", async () => {
    boot();
    const first = openSocket();
    const second = openSocket();
    await until(() => first.frames.length >= 1 && second.frames.length >= 1, "both ready frames");

    expect(fixture!.agent.watchers.size).toBe(2);
    fixture!.agent.emit({ type: "text_delta", text: "shared" });
    await until(
      () => first.frames.length >= 2 && second.frames.length >= 2,
      "the delta on both sockets",
    );
    expect(first.frames[1]).toEqual({ type: "text_delta", text: "shared" });
    expect(second.frames[1]).toEqual({ type: "text_delta", text: "shared" });

    // A closed tab detaches and leaves the agent alone — that is the point of it being the
    // server's rather than the socket's.
    first.ws.close();
    await until(() => fixture!.agent.watchers.size === 1, "the first tab to detach");
    second.ws.close();
  });

  test("deleting a recipe leaves the chat socket open", async () => {
    boot();
    const id = newRecipe();
    const { ws, frames } = openSocket();
    await until(() => frames.length >= 1, "the ready frame");

    // Deleted through the repository the `delete_recipe` tool reaches, since no route does this
    // any more. What the socket owes is the same either way — it is not attached to a recipe, so
    // there is nothing for a recipe's disappearance to invalidate.
    deleteRecipe(fixture!.h.db, id);

    // The point of a global conversation. A chat belonging to one specification would have to hang
    // up on everybody watching it with a 4004 the moment that specification was deleted; this
    // conversation is the installation's and works across every recipe in the archive, so closing
    // it because one of the things being discussed has gone would be answering a question nobody
    // asked. A turn already in flight meets an ordinary `not_found` from whichever tool
    // names the recipe, which is a sentence the model can act on.
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.send(JSON.stringify({ type: "user_message", text: "so what else did that one publish?" }));
    await until(() => fixture!.agent.turns.length === 1, "the turn after the deletion");
    ws.close();
  });

  test("the path names no recipe, and a plain GET to it is not an upgrade", async () => {
    boot();
    const response = await fetch(`${fixture!.base}/ws/chat`);
    expect(response.status).toBe(426);
    // And nothing hangs off it. `/ws/chat/<anything>` is not the chat socket wearing an argument —
    // it is a path this server does not serve, which is what stops an old window from opening a
    // conversation nobody would ever be attached to.
    expect((await fetch(`${fixture!.base}/ws/chat/some-recipe`)).status).toBe(404);
  });
});

describe("outbound backpressure", () => {
  const delta = (text: string): OutboundFrame => ({ type: "text_delta", text });
  const result = (n: number): OutboundFrame => ({ type: "turn_result", subtype: `s${n}` });

  test("a queue with room admits anything, untouched", () => {
    const queue = [delta("a")];
    expect(makeRoom(queue, result(1), 4)).toEqual({ admit: true, dropped: null });
    expect(queue).toHaveLength(1);
  });

  test("a full queue drops an arriving delta rather than anything already in it", () => {
    const queue = [result(1), result(2)];
    const shed = makeRoom(queue, delta("z"), 2);
    expect(shed.admit).toBe(false);
    expect(queue).toEqual([result(1), result(2)]);
  });

  test("a full queue sheds its OLDEST prose and keeps everything else in order", () => {
    const queue = [delta("a"), result(1), delta("b"), result(2)];
    const shed = makeRoom(queue, result(3), 4);
    expect(shed.admit).toBe(true);
    expect(shed.dropped).toEqual(delta("a"));
    expect(queue).toEqual([result(1), delta("b"), result(2)]);
  });

  test("only a queue with no prose at all loses something that mattered", () => {
    const queue = [result(1), result(2)];
    const shed = makeRoom(queue, result(3), 2);
    expect(shed.admit).toBe(true);
    expect(shed.dropped).toEqual(result(1));
    expect(queue).toEqual([result(2)]);
  });
});
