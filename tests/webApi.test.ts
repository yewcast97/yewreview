/**
 * What the window actually puts on the wire.
 *
 * These are wrappers, and a wrapper is worth testing for exactly one reason: it is a hand-made claim
 * about a shape the server owns. The claims that can go wrong SILENTLY are the ones checked here —
 * which path an id lands on, whether a required query parameter is spelled the way the router reads
 * it, and whether a keyset page asks for the rows it means to. Every one of those failures looks like
 * nothing at all from this side: the request goes out, the server answers a refusal about something
 * the window thought it sent, and the sentence the reader gets blames them for what the wrapper did.
 *
 * WHAT IS ON THE WIRE HERE is mostly the reading side of three things this window does not own: the
 * SDK's transcript, its session store, and the two logs. All but one of them is a GET, which is the
 * shape of this whole surface in one line.
 *
 * AND THAT LINE IS NOW THE WHOLE MODULE. THIS WINDOW DOES NOT WRITE A RECORD. There were suites here
 * for the records the user wrote — a folder created by name, a set of instructions posted whole to
 * that folder's own path, an information source and a rename — and every one of those ROUTES has
 * gone from the server. A recipe, a source, a new name and a deletion are asked for in
 * the conversation now; the agent shows the reader what it is about to write and writes it with its
 * own tools. So those suites are gone and what stands in their place is the last describe below,
 * which pins the wrappers as ABSENT — because the failure worth catching is no longer a misspelled
 * body but a wrapper quietly reappearing, and a wrapper is a door.
 *
 * `fetch` is replaced for the duration rather than mocked at a lower level, because what is being
 * checked IS the request. Nothing here starts a server: this file is about the bytes, and the routes
 * that receive them have their own suite in `tests/server.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as api from "../web/src/lib/api.ts";

/** One request, as this file wants to talk about it: what was asked of whom, with what in its hand.
 * A JSON body arrives parsed; anything else — the one wrapper that sends a `File` — arrives as it
 * was handed to `fetch`, because reading it as JSON would be this file inventing a shape. */
type Call = { method: string; path: string; body: unknown };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let answers: Response[] = [];

/** The next canned answer, or a bare 200 — a test that does not queue one is a test about the
 * request rather than about the reply, and making it queue an empty body anyway would be ceremony. */
function nextAnswer(): Response {
  return answers.shift() ?? new Response("{}", { status: 200 });
}

function queue(status: number, body: unknown): void {
  answers.push(
    body === null
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

/** The single request this test made. Asserted through a helper so that a wrapper which quietly
 * made two — a retry, a probe — fails loudly here rather than having its first call inspected and
 * its second ignored. */
function onlyCall(): Call {
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

beforeEach(() => {
  calls = [];
  answers = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    calls.push({
      method: init?.method ?? "GET",
      path: String(input),
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    });
    return nextAnswer();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("reading a conversation back", () => {
  test("the transcript is fetched by session id, whole, with no paging parameters at all", async () => {
    // The absence is the assertion. A `before` or a `limit` drawing an offset through this answer
    // would cut a `tool_use` from the `tool_result` that settles it — a call rendered as though it
    // never finished. There is nothing to ask for but the name.
    queue(200, {
      sessionId: "s1",
      items: [
        { kind: "user", text: "what moved" },
        { kind: "tool", tool: "list_theses", summary: "3 theses", ok: true },
        { kind: "assistant", text: "three, and one is stale" },
      ],
    });
    const answer = await api.fetchTranscript("s1");
    expect(onlyCall()).toEqual({
      method: "GET",
      path: "/api/sessions/s1/messages",
      body: undefined,
    });
    expect(answer.sessionId).toBe("s1");
    expect(answer.items).toHaveLength(3);
  });

  test("a session id goes on the wire as ONE escaped segment", async () => {
    // The server splits a path on the raw `/` before decoding it. Session ids are the SDK's to mint,
    // not this schema's, so nothing here can promise they stay hex — and an id that ever came to hold
    // a slash would arrive as two segments and match no route at all: a 404 about a conversation that
    // is sitting right there in the panel.
    // Queued because the reader now PARSES what comes back: this test is about the url, and an
    // unanswerable body would fail it for the one thing it is not asking about.
    queue(200, { sessionId: "a/b c", items: [] });
    await api.fetchTranscript("a/b c");
    expect(onlyCall().path).toBe("/api/sessions/a%2Fb%20c/messages");
  });

  test("a conversation the store no longer has is a not_found the caller can branch on", async () => {
    // Not a malfunction, and the store swallows it: the session directory is written by a subprocess
    // on a cadence nothing controls, so a conversation minted seconds ago may honestly not be on disk
    // yet. The KIND is what makes that distinguishable from a server that is broken.
    queue(404, {
      error: "not_found",
      message: "no conversation s9 in this installation's session store; it was compacted away, pruned, or belongs to another project directory",
    });
    const failure = await api.fetchTranscript("s9").catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(api.ApiError);
    expect((failure as api.ApiError).isNotFound).toBe(true);
  });
});

describe("the session list, and moving between conversations", () => {
  test("listing asks for the directory and nothing else", async () => {
    queue(200, {
      sessions: [
        { sessionId: "s2", summary: "(current conversation)", createdAt: null, lastModified: 20, live: true },
        { sessionId: "s1", summary: "Rates and the long end", createdAt: 1, lastModified: 9, live: false },
      ],
      current: "s2",
    });
    const answer = await api.listSessions();
    expect(onlyCall()).toEqual({ method: "GET", path: "/api/sessions", body: undefined });
    // The synthesised row for a live session that has not been flushed: a `lastModified` because
    // "now" is honest for a conversation that is happening, and no birthday, because it has none to
    // report.
    expect(answer.sessions[0]?.createdAt).toBeNull();
    expect(answer.current).toBe("s2");
  });

  test("resuming escapes the id into one segment and sends an empty body", async () => {
    queue(200, { sessionId: "a/b", summary: "Rates and the long end" });
    await api.resumeSession("a/b");
    expect(onlyCall()).toEqual({
      method: "POST",
      path: "/api/sessions/a%2Fb/resume",
      body: {},
    });
  });

  test("a resume refused mid-turn is a conflict carrying the server's sentence untouched", async () => {
    // Verbatim, because that sentence is the whole of what the reader gets: it says the agent is
    // working, which is the one thing that tells them the answer is "wait" rather than "that
    // conversation is gone".
    const said = "the agent is working; resuming now would abandon a turn already in flight";
    queue(409, { error: "conflict", message: said });
    const failure = await api.resumeSession("s1").catch((cause: unknown) => cause);
    expect((failure as api.ApiError).kind).toBe("conflict");
    expect((failure as api.ApiError).status).toBe(409);
    expect((failure as api.ApiError).message).toBe(said);
  });

  test("clearing posts to one fixed path and reads NO body back", async () => {
    // The route answers 204 with nothing in it. A wrapper that asked for JSON anyway would throw on
    // the empty body — a conversation put down correctly, reporting a failure.
    queue(204, null);
    await api.clearSession();
    expect(onlyCall()).toEqual({ method: "POST", path: "/api/sessions/clear", body: undefined });
  });
});

describe("the two logs", () => {
  test("the category is a query parameter and is always sent", async () => {
    // The route REFUSES a request without one, and rightly: the two categories answer different row
    // shapes, so a defaulted parameter would let a caller draw deletions in an error viewer and never
    // notice which it was looking at. There is no path segment to get wrong because there is one
    // route.
    queue(200, { category: "errors", entries: [], hasMore: false });
    await api.fetchLog("errors");
    expect(onlyCall()).toEqual({ method: "GET", path: "/api/logs?category=errors", body: undefined });

    calls = [];
    queue(200, { category: "deletions", entries: [], hasMore: false });
    await api.fetchLog("deletions");
    expect(onlyCall().path).toBe("/api/logs?category=deletions");
  });

  test('"show more" is keyset: `before` is an id, never an offset', async () => {
    // Rows arrive while the viewer is open — that is what the viewer is for — so an offset would
    // repeat a row or skip one every time the agent did anything. `before` names the oldest row
    // already in hand, which is a fact that does not move.
    queue(200, {
      category: "deletions",
      entries: [{ id: 40, at: 5, table_name: "thesis", row_id: "t1", row_json: "{}" }],
      hasMore: true,
    });
    const answer = await api.fetchLog("deletions", { before: 41, limit: 25 });
    expect(onlyCall().path).toBe("/api/logs?category=deletions&before=41&limit=25");
    expect(answer.hasMore).toBe(true);
  });

  test("an unmentioned bound is absent from the URL entirely", async () => {
    // `query()` drops undefined keys, and it has to: a URL carrying `?before=undefined` is a refusal
    // waiting to happen, and the router reads a missing parameter as "no bound" already.
    // Same reason as the transcript case above: the assertion is about the url, so the body has to
    // be one the reader can actually read.
    queue(200, { category: "errors", entries: [], hasMore: false });
    await api.fetchLog("errors", { limit: 200 });
    expect(onlyCall().path).toBe("/api/logs?category=errors&limit=200");
  });
});

describe("uploading a dropped file", () => {
  test("the bytes are the body and the name is on the query", async () => {
    // Both halves matter. The server reads the body with `arrayBuffer()` and can learn nothing from
    // it about what the file was called, so a wrapper that sent JSON or forgot the parameter would
    // be refused for a reason that reads like the reader's fault.
    queue(201, { path: "uploads/1a2b3c4d/q3.pdf" });
    const file = new File(["numbers"], "q3.pdf", { type: "application/pdf" });
    expect(await api.uploadFile(file)).toEqual({ path: "uploads/1a2b3c4d/q3.pdf" });
    const call = onlyCall();
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/uploads?filename=q3.pdf");
    expect(call.body).toBe(file);
  });

  test("a name with spaces and punctuation survives as one escaped parameter", () => {
    // `URLSearchParams` is what escapes it, and the assertion is that nothing splits on the way: a
    // second `&` in the query would make the server read a different name than the reader chose.
    queue(201, { path: "uploads/1a2b3c4d/a b&c.csv" });
    void api.uploadFile(new File(["x"], "a b&c.csv"));
    expect(onlyCall().path).toBe("/api/uploads?filename=a+b%26c.csv");
  });

  test("a refusal arrives with the server's own sentence, figures and all", async () => {
    // The composer shows this message verbatim in its toast, so the cap the server named is the cap
    // the reader is told about — there is no second copy of the number in this window.
    queue(413, { error: "invalid_request", message: "that file is 44.0 MiB and the cap is 32.0 MiB" });
    const failed = api.uploadFile(new File(["x"], "huge.bin"));
    await expect(failed).rejects.toThrow("that file is 44.0 MiB and the cap is 32.0 MiB");
  });
});

describe("wrappers this module does not define", () => {
  test("there is no draft, lease or commit wrapper", () => {
    // Pinned rather than merely absent, and the reason has hardened rather than changed. It was that
    // unfinished writing must not be a thing the SERVER holds under a key, with a lease to take and a
    // commit to send — the form was the reader's own and lived in this window until they pressed the
    // button. There is no form now: unfinished writing is a sentence somebody said in the
    // conversation, which is already stored, already visible and already the record of who asked. A
    // wrapper for any of these would be inventing a second place for a half-written record to live.
    const surface: Record<string, unknown> = api;
    for (const name of [
      "listDrafts",
      "fetchDraft",
      "takeDraftLease",
      "releaseDraftLease",
      "saveRecipeDraft",
      "saveSourceDraft",
      "openNewSourceDraft",
      "discardDraft",
      "submitSourceDraft",
      "commitRecipeDraft",
      "fetchVerification",
    ]) {
      expect(surface[name]).toBeUndefined();
    }
  });

  test("there is no `fetchMessages`, because there is no message table to page", () => {
    const surface: Record<string, unknown> = api;
    expect(surface["fetchMessages"]).toBeUndefined();
    expect(typeof surface["fetchTranscript"]).toBe("function");
  });

  test("there is no wrapper that CREATES a record, of any table, under any name", () => {
    // THE DOOR, PINNED SHUT. Each of these wrapped a route that has gone from the server, and each
    // of them was the window claiming something about the world on the reader's behalf: a
    // specification opened from a text box, an information source filed from a form, a document
    // posted whole. What replaced them is a SENTENCE — `lib/awareness.ts` holds the four the `+`
    // buttons send — so the agent drafts with the reader, shows them what it is about to write, and
    // writes it with its own tools. A wrapper reappearing here would be a second, silent channel by
    // which a row could reach the archive with nothing in the transcript to say who asked for it.
    const surface: Record<string, unknown> = api;
    for (const name of [
      "createRecipe",
      "createSource",
      "createScript",
      "createReport",
      "createThesis",
      // And the two spellings a REVISION would take, which is a door that cannot be opened even by
      // the agent: a recipe's content is immutable, so there is no version to post and no ledger to
      // append to.
      "reviseRecipe",
      "saveRecipe",
    ]) {
      expect(surface[name]).toBeUndefined();
    }
  });

  test("there is no wrapper that CORRECTS or RENAMES one either", () => {
    // The same door from the other side, and the rename is the sharpest case: it was one column on
    // any table, the last write the record browser held, and `PATCH /api/records/:table/:id/name`
    // has gone with it. The 409 that route answered — naming whatever already holds the name — is
    // worth more in a conversation than in a form: the agent can say which record has it and offer
    // another, where a form could only hand the sentence back to somebody who now has to invent one.
    const surface: Record<string, unknown> = api;
    for (const name of ["renameRecord", "renameRecipe", "updateSource", "patchRecord"]) {
      expect(surface[name]).toBeUndefined();
    }
  });

  test("there is no wrapper that DELETES a record, and the Bin does not call one", () => {
    // A deletion is witnessed in `deletion_log` whoever asks for it, so this is not about the
    // archive losing its account of what went. It is about who gets to decide: dropping a row on the
    // Bin sends a sentence naming it and asking what would go with it, because what a reader wants
    // before a deletion is to be told that four reports were published under this recipe and would
    // go with it — which is an answer, and a `DELETE` is not a question.
    const surface: Record<string, unknown> = api;
    for (const name of [
      "deleteRecipe",
      "deleteSource",
      "deleteReport",
      "deleteRecord",
      // Retiring one is a write too, and it is the agent's: `set_recipe_status` takes a specification
      // out of use without touching a report published under it, and a button that did it from here
      // would be the archive moving with nothing said about why.
      "setRecipeStatus",
      "setScriptStatus",
    ]) {
      expect(surface[name]).toBeUndefined();
    }
  });

  test("the one delete is a conversation's, because a transcript is not a record", async () => {
    // THE EXCEPTION, AND IT IS EXACTLY AS WIDE AS ITS REASON. Every name above is a row of the
    // archive: something points at it, a deletion cascades, and the useful thing to hear first is
    // what goes with it — none of which the agent could say about a transcript, because the store
    // belongs to the harness rather than to the database it reads. So there is nothing for a
    // question to be about, the drag IS the asking, and this is the doing.
    queue(204, null);
    await api.deleteSession("a/b");
    expect(onlyCall()).toMatchObject({ method: "DELETE", path: "/api/sessions/a%2Fb" });
    // No body is read back — a 204 asked for JSON throws on the empty body — and no `deletion_log`
    // row is written anywhere: that ledger holds records, and what was said was never one.
    expect(onlyCall().body).toBeUndefined();
  });

  test("there is no `listRecipes`, because there is no per-table read left at all", () => {
    // It was the last of them. The route it wrapped answered a folder-shaped row with a derived
    // version number and a report count — a second shape for one table, kept in step with the record
    // browser by hand — and the record browser reads every table through `/api/records/**` in one
    // shape for eleven tables. `tests/server.test.ts` pins the routes as absent; this pins that
    // nothing here would call one.
    const surface: Record<string, unknown> = api;
    for (const name of ["listRecipes", "listSources", "listReports", "listTheses"]) {
      expect(surface[name]).toBeUndefined();
    }
    expect(typeof surface["fetchTable"]).toBe("function");
  });

  test("there is no `fetchRecipe`, because nothing in this window derives anything any more", () => {
    // The wrapper it replaced had one caller: a `+` that read a folder in order to open the newest
    // set of instructions in it — a `MAX(version)` the record browser cannot ask for. There are no
    // versions left to be newest of, that `+` sends a sentence and opens no card at all, and a recipe
    // is read the way every other row is: by id, or by the name it answers to.
    const surface: Record<string, unknown> = api;
    expect(surface["fetchRecipe"]).toBeUndefined();
    expect(typeof surface["fetchRecord"]).toBe("function");
    expect(typeof surface["fetchRecordNamed"]).toBe("function");
  });

  test("what is left that is not a GET writes no record, and can be counted", () => {
    // The positive half, so the absences above are not the whole claim. Every one of these is a
    // decision about the INSTALLATION or the CONVERSATION rather than a claim about the world: a
    // dropped file put where the agent can read it, the model pool (a credential file, not a
    // table), a re-run of the venv install, and which conversation the next turn belongs to —
    // including throwing an old one away, which is a decision about the conversation rather than
    // about the archive: a transcript is not a record.
    //
    // TWO MORE USED TO BE ON THIS LIST, and they were described here as the one authority this
    // window held and could not give away, because the agent was not allowed to begin a procedure.
    // It begins its own now, with a tool, and the report box's `+` asks for one the way every other
    // `+` asks for a row. What holds a report's provenance up was never which side of the socket
    // the request came from.
    const surface: Record<string, unknown> = api;
    for (const name of [
      "uploadFile",
      "putOpencodePool",
      "retryVenv",
      "resumeSession",
      "clearSession",
      "deleteSession",
    ]) {
      expect(typeof surface[name]).toBe("function");
    }
    // And the two that left are GONE from the module rather than merely unused, which is the same
    // absence-as-a-test every other claim in this file is made of.
    expect(surface["startGeneration"]).toBeUndefined();
    expect(surface["cancelGeneration"]).toBeUndefined();
  });
});
