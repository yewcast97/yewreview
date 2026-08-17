/**
 * The download half of file transfer: a real `Bun.serve`, a real home directory, real bytes.
 *
 * Nothing here mocks the filesystem or the server, because what this route is FOR is containment —
 * which paths on a real disk a URL can be made to reach — and a handler run against a fake tree
 * would be answering a question nobody asked. The one thing checked below the wire is the traversal
 * spelling no browser will send: a URL parser rewrites a literal `../` segment before the request
 * leaves, so `resolveHomeFile` is called directly for those, exactly as the assets tree's own tests
 * do next door in `server.test.ts`.
 *
 * TWO seams are faked and neither is under test. The agent is a stub because a real conversation
 * costs money and no download goes anywhere near one, and the SDK's session store is a stub because
 * the real one reads whoever-is-running-the-suite's own `~/.claude`. They exist only because
 * `startServer` takes them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { homeDir, paths, type Settings } from "../src/config.ts";
import type { Resources } from "../src/resources/embed.ts";
import type { VenvStatus } from "../src/sandbox/venv.ts";
import type { Agent, ChatSocketData, ServerDeps } from "../src/server/chat.ts";
import { resolveHomeFile } from "../src/server/homeFiles.ts";
import { startServer } from "../src/server/serve.ts";
import type { SessionsApi } from "../src/server/sessions.ts";
import { storeUpload } from "../src/server/uploads.ts";
import { harness, type Harness } from "./helpers.ts";

/** The refusal every stubbed agent call answers with. Nothing in this file asks for one; the shape
 * is here so the stub satisfies the interface rather than because a test reads it. */
const NOT_HERE = {
  ok: false,
  code: "conflict",
  message: "this suite does not run a conversation",
} as const;

const IDLE_AGENT: Agent = {
  // No frame is emitted, because nothing here opens a chat socket: a `ready` nobody receives would
  // be an invention rather than a fake.
  attach: () => () => {},
  submitTurn: () => {},
  interrupt: () => Promise.resolve(),
  resume: () => NOT_HERE,
  clear: () => NOT_HERE,
  setModel: () => Promise.resolve(NOT_HERE),
  setEffort: () => Promise.resolve(NOT_HERE),
  setSubagents: () => Promise.resolve(NOT_HERE),
  snapshot: () => ({
    model: "fake-model",
    fresh: true,
    busy: false,
    queued: 0,
    sessionId: null,
  }),
};

const NO_SESSIONS: SessionsApi = {
  list: () => Promise.resolve([]),
  info: () => Promise.resolve(undefined),
  delete: () => Promise.resolve(),
  items: () => Promise.resolve([]),
};

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
  base: string;
};

let fixture: Fixture | null = null;

function boot(): Fixture {
  const h = harness();
  // Port 0 so suites never collide, and loopback like the real boot.
  const settings: Settings = { ...h.settings, port: 0 };
  const deps: ServerDeps = {
    db: h.db,
    settings,
    mode: "writer",
    agent: IDLE_AGENT,
    sessions: NO_SESSIONS,
    resources: RESOURCES,
    venv: () => VENV,
    sandbox: { available: true, hint: null },
    reprovision: () => Promise.resolve(VENV),
  };
  const server = startServer(deps);
  fixture = { h, settings, server, base: `http://127.0.0.1:${server.port}` };
  return fixture;
}

afterEach(() => {
  if (!fixture) return;
  const done = fixture;
  fixture = null;
  // Not awaited, for the reason `server.test.ts` gives: `stop()` can outlive the test, every server
  // is on its own port and its own temp var-dir, and a few milliseconds of overlap costs nothing.
  void done.server.stop(true);
  done.h.cleanup();
});

/** Write a file into the agent's home the way the agent would, and answer with the home-relative
 * path its reply would name. */
function putHomeFile(relPath: string, contents: string | Uint8Array): string {
  const absolute = resolve(homeDir(fixture!.settings), relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  return relPath;
}

/** The URL a home-relative path is fetched at: the prefix, then the path with each segment
 * percent-encoded — which is what the window will do with the line the agent wrote. */
function fileUrl(relPath: string): string {
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return `${fixture!.base}/api/files/${encoded}`;
}

describe("downloading a file out of the agent's home", () => {
  test("an uploaded file comes back byte for byte, as an attachment nothing will sniff", async () => {
    boot();
    // Bytes rather than text, with a NUL in the middle of them, because "byte for byte" is the
    // claim: a route that decoded anything on the way would be caught here and nowhere else.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0xff, 0xfe]);
    const path = await storeUpload(fixture!.settings, "chart.png", bytes.buffer);

    const response = await fetch(fileUrl(path));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="chart.png"; filename*=UTF-8''chart.png`,
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // The agent rewrites its own outputs in place, so a cached copy would be the draft before the
    // correction.
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test("a file the agent wrote under outputs downloads", async () => {
    boot();
    putHomeFile("outputs/report.md", "# NVDA\n\nthe draft itself\n");
    const response = await fetch(fileUrl("outputs/report.md"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.text()).toContain("the draft itself");
  });

  test("a name with spaces is fetched percent-encoded and named with the spaces back in", async () => {
    boot();
    // The path runs to the end of the agent's line, so a space in a filename is ordinary; what has
    // to survive is the round trip through the URL.
    putHomeFile("outputs/Q3 notes.csv", "date,close\n");
    const response = await fetch(`${fixture!.base}/api/files/outputs/Q3%20notes.csv`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="Q3 notes.csv"; filename*=UTF-8''Q3%20notes.csv`,
    );
  });

  test("a unicode name is carried by the starred form and flattened in the plain one", async () => {
    boot();
    putHomeFile("outputs/財報.csv", "date,close\n");
    const response = await fetch(fileUrl("outputs/財報.csv"));
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    // The real name, for a browser that reads RFC 5987 — and a flattened one for a browser that
    // does not, which is a file the reader can still find rather than no name at all.
    expect(disposition).toContain(`filename*=UTF-8''%E8%B2%A1%E5%A0%B1.csv`);
    expect(disposition).toContain(`filename="__.csv"`);
  });

  test("an html file the agent wrote is a download and never a page", async () => {
    boot();
    // The security decision this route rests on, pinned. The agent authors arbitrary HTML, this
    // origin also serves `/api/**`, and a document served inline would run its scripts inside it.
    putHomeFile("outputs/draft.html", "<!doctype html><script>fetch('/api/records/recipe')</script>");
    const response = await fetch(fileUrl("outputs/draft.html"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-disposition")).toStartWith("attachment");
    expect(response.headers.get("content-disposition")).not.toContain("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("what a file URL cannot reach", () => {
  test("an escaped traversal cannot climb out of the home", async () => {
    boot();
    // `%2e%2e%2f` rather than `../`: a URL parser rewrites a real double-dot segment before it
    // reaches the wire, so this is the spelling that survives until the server decodes it.
    const escaped = await fetch(
      `${fixture!.base}/api/files/%2e%2e%2f%2e%2e%2fdb/yewreview.sqlite`,
    );
    // 404 and never 403: what is not there and what is not yours are the same answer.
    expect(escaped.status).toBe(404);
    expect(((await escaped.json()) as { error: string }).error).toBe("not_found");

    // And the literal forms, below the wire, because no HTTP client will send them intact.
    const { settings } = fixture!;
    expect(resolveHomeFile(settings, "/api/files/../db/yewreview.sqlite")).toBeNull();
    expect(resolveHomeFile(settings, "/api/files/../../../etc/hosts")).toBeNull();
    expect(resolveHomeFile(settings, "/api/files/outputs/../../db/yewreview.sqlite")).toBeNull();
    // This module serves the home and nothing else: a report is not a file it can reach.
    expect(resolveHomeFile(settings, "/reports/nvda.html")).toBeNull();
  });

  test("an absolute path is not a path under the home", async () => {
    boot();
    const { settings } = fixture!;
    // The database, named in full. It exists, it is readable, and it is outside the home — which is
    // the whole of what makes it the right thing to ask for here.
    const db = paths(settings).dbPath;
    expect(resolveHomeFile(settings, `/api/files/${db}`)).toBeNull();
    expect((await fetch(`${fixture!.base}/api/files/${encodeURIComponent(db)}`)).status).toBe(404);
  });

  test("a symlink out of the home is refused even though its spelling is innocent", async () => {
    boot();
    const { settings } = fixture!;
    const link = resolve(homeDir(settings), "outputs/escape.sqlite");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(paths(settings).dbPath, link);
    // A lexical answer is satisfied by any symlink; only the real path can be compared against the
    // real root. The agent writes in this tree, so this is the one tree where such a link can
    // actually get made.
    expect(resolveHomeFile(settings, "/api/files/outputs/escape.sqlite")).toBeNull();
    expect((await fetch(fileUrl("outputs/escape.sqlite"))).status).toBe(404);
  });

  test("a missing file, a directory and a malformed escape are all the same answer", async () => {
    boot();
    putHomeFile("outputs/report.md", "# NVDA\n");

    const missing = await fetch(fileUrl("outputs/gone.csv"));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("not_found");

    // There is no listing to hand out, with or without the trailing slash.
    expect((await fetch(`${fixture!.base}/api/files/outputs`)).status).toBe(404);
    expect((await fetch(`${fixture!.base}/api/files/outputs/`)).status).toBe(404);

    // A malformed escape is not a path anybody meant to type.
    expect(resolveHomeFile(fixture!.settings, "/api/files/%zz")).toBeNull();
    expect((await fetch(`${fixture!.base}/api/files/%zz`)).status).toBe(404);
  });

  test("a download is a read, so nothing else is allowed at that path", async () => {
    boot();
    putHomeFile("outputs/report.md", "# NVDA\n");
    for (const method of ["DELETE", "POST", "PUT"]) {
      const response = await fetch(fileUrl("outputs/report.md"), { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
      expect(((await response.json()) as { error: string }).error).toBe("method_not_allowed");
    }
  });
});
