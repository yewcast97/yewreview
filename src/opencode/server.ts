/**
 * The opencode server, as a child of this process: spawning it, and talking to it.
 *
 * opencode's headless mode is an HTTP server with a server-sent-event stream beside it, so this is
 * a transport rather than a protocol implementation — the shapes below were read off a running
 * opencode 1.18 and each is named where it is parsed.
 *
 * **It runs inside YewReview's own sandbox, and refuses rather than running outside one.** opencode
 * has no OS sandbox of its own and every tool it carries — its file writer, its editor, whatever a
 * plugin adds — runs with whatever the process has. The Claude path solves that with the SDK's
 * sandbox plus a hook; here there is one process to confine, so `confine()` wraps the whole server
 * and the writable set is the agent's home and the caches. Where no sandbox exists (`exec.ts`
 * refuses on any platform without one) the harness refuses with it. Nothing degrades to unconfined.
 *
 * **Its own state goes under `var/opencode`, never the user's home.** `OPENCODE_CONFIG` points at
 * the config YewReview renders from the pool, and the XDG variables point at this installation's
 * var tree — so a machine's global opencode settings cannot reach in and change how a report was
 * produced, two checkouts do not share a transcript store, and everything the child writes lands
 * inside the sandbox's writable set. `HOME` is redirected for the last of those reasons especially:
 * under Seatbelt a stray write to the real `~/.cache` is a denial that surfaces as an opencode bug.
 *
 * **The credential for the Claude path is stripped.** An opencode child has no business holding
 * this machine's Claude login; it answers with the pool's models, through the pool's keys.
 */

import { join } from "node:path";

import type { Settings } from "../config.ts";
import { homeDir, paths } from "../config.ts";
import { credentialFreeEnv } from "../env.ts";
import { confine, scientificCaches } from "../sandbox/exec.ts";

/** How long to wait for the child to say it is listening before giving up on it. */
const READY_TIMEOUT_MS = 30_000;

/** One line of the event stream, as far as anything here reads it. */
export type OpencodeEvent = {
  type: string;
  properties?: Record<string, unknown> | undefined;
};

export type OpencodeServer = {
  /** `http://127.0.0.1:<port>`, the base every request is made against. */
  readonly baseUrl: string;
  /**
   * The per-boot shared secret, which is also the bearer the child must present at `/mcp`.
   *
   * One secret rather than two because there is one trust relationship: this process started that
   * child and handed it a password, and the tools it may call are the ones that password opens.
   */
  readonly secret: string;
  readonly alive: boolean;
  /** A JSON request against the server, with the shared secret attached. */
  request(method: string, path: string, body?: unknown): Promise<Response>;
  /** Every event, until `stop()` or the child exits. Iterated once, by the agent's own loop. */
  events(signal: AbortSignal): AsyncGenerator<OpencodeEvent>;
  stop(): void;
};

export type SpawnOptions = {
  settings: Settings;
  /** The binary a probe already approved, absolute. Never re-resolved through PATH. */
  binary: string;
  /** Where the pool's rendered config sits. */
  configPath: string;
  /** The per-boot shared secret, minted by the harness so the config could carry it too. */
  secret: string;
  onExit?: ((code: number | null) => void) | undefined;
};

/** The seam a test replaces: everything above this line is real HTTP, and a fake server satisfies
 * the same three methods without a child process anywhere. */
export type ServerFactory = (options: SpawnOptions) => Promise<OpencodeServer>;

export async function spawnOpencodeServer(options: SpawnOptions): Promise<OpencodeServer> {
  const { settings, binary, configPath } = options;
  const p = paths(settings);
  const home = homeDir(settings);

  // Minted by the harness rather than here, because the config the child reads has to carry it as
  // well: one secret guards both directions — this process's requests to the child, and the child's
  // calls back into `/mcp`. opencode warns on stderr when the server password is unset, rightly.
  const password = options.secret;

  const port = await freePort();
  const wrapped = confine(
    [binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      writable: home,
      alsoWritable: [...scientificCaches(settings.varDir), p.opencodeDir],
      denyRead: [join(settings.varDir, "db")],
    },
  );
  if (!wrapped.ok) {
    throw new Error(
      `the opencode harness cannot be confined here, so it will not be run: ${wrapped.message}`,
    );
  }

  const child = Bun.spawn(wrapped.command, {
    cwd: home,
    stdout: "pipe",
    stderr: settings.logLevel === "debug" ? "inherit" : "pipe",
    env: childEnv(settings, configPath, password),
    onExit: (_proc, code) => options.onExit?.(code),
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const auth = `Basic ${btoa(`opencode:${password}`)}`;
  const request = async (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: auth,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  await waitUntilListening(request, child);

  return {
    baseUrl,
    secret: password,
    get alive() {
      return child.exitCode === null && child.signalCode === null;
    },
    request,
    async *events(signal: AbortSignal): AsyncGenerator<OpencodeEvent> {
      const response = await fetch(`${baseUrl}/event`, {
        headers: { authorization: auth, accept: "text/event-stream" },
        signal,
      });
      if (response.body === null) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      // SSE frames arrive as `data: <json>` lines and a chunk may split one anywhere, so the tail
      // of every read is carried forward rather than parsed. A partial line parsed as JSON is the
      // classic way a stream reader loses exactly the longest messages.
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf("\n");
          while (cut !== -1) {
            const line = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut + 1);
            cut = buffer.indexOf("\n");
            if (!line.startsWith("data:")) continue;
            const parsed = parse(line.slice(5).trim());
            if (parsed !== null) yield parsed;
          }
        }
      } finally {
        reader.cancel().catch(() => {
          // A stream that will not cancel politely is not worth failing a shutdown over.
        });
      }
    },
    stop(): void {
      child.kill();
    },
  };
}

function parse(text: string): OpencodeEvent | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const event = value as { type?: unknown; properties?: unknown };
    if (typeof event.type !== "string") return null;
    return {
      type: event.type,
      properties:
        typeof event.properties === "object" && event.properties !== null
          ? (event.properties as Record<string, unknown>)
          : undefined,
    };
  } catch {
    // An event this build cannot parse is skipped rather than thrown on. The stream carries
    // opencode's whole internal bus — plugins, catalogs, integrations — and a harness that died on
    // an unfamiliar frame would be a harness broken by somebody else's feature release.
    return null;
  }
}

/**
 * The child's environment.
 *
 * `process.env` first, so PATH and the pool's API-key variables reach it, then the removals and the
 * redirections. `OPENCODE_CONFIG` is the whole of what makes the pool authoritative: without it the
 * child would merge the user's own global config on top of ours.
 */
function childEnv(
  settings: Settings,
  configPath: string,
  password: string,
): Record<string, string> {
  const p = paths(settings);
  // Without this installation's own credentials: a model answering through the pool has no use for
  // this machine's Claude login, and a subprocess holding one is a credential with a longer reach
  // than the thing that needs it.
  const env = credentialFreeEnv();
  env["OPENCODE_CONFIG"] = configPath;
  env["OPENCODE_CONFIG_DIR"] = p.opencodeDir;
  env["OPENCODE_SERVER_PASSWORD"] = password;
  env["OPENCODE_SERVER_USERNAME"] = "opencode";
  // Inside the sandbox's writable set, every one of them, which is the point rather than tidiness:
  // a write to the real `$HOME` is denied by Seatbelt and surfaces as an opencode bug nobody can
  // reproduce anywhere else.
  env["HOME"] = homeDir(settings);
  env["XDG_DATA_HOME"] = join(p.opencodeStateDir, "data");
  env["XDG_STATE_HOME"] = join(p.opencodeStateDir, "state");
  env["XDG_CACHE_HOME"] = join(p.opencodeStateDir, "cache");
  env["XDG_CONFIG_HOME"] = join(p.opencodeStateDir, "config");
  env["TMPDIR"] = p.tmpDir;
  env["YEWREVIEW_VAR_DIR"] = settings.varDir;
  env["YEWREVIEW_HOME"] = homeDir(settings);
  return env;
}

/** A port nobody is on, asked of the kernel rather than guessed. opencode's own `--port 0` would
 * pick one too, but it prints it on stdout and racing a log line is a worse way to learn a number
 * than binding a socket and closing it. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  if (port === 0) throw new Error("could not find a free port for the opencode server");
  return port;
}

/**
 * Poll until the server answers, or the child dies, or the clock runs out.
 *
 * The readiness signal is an authenticated request that succeeds rather than a line on stdout: what
 * the caller needs to know is "will my next request work", and the only thing that answers that
 * question is a request.
 */
async function waitUntilListening(
  request: (method: string, path: string) => Promise<Response>,
  child: { readonly exitCode: number | null },
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`the opencode server exited (${child.exitCode}) before it began listening`);
    }
    try {
      const response = await request("GET", "/session");
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // Not up yet. A connection refused during startup is the ordinary case, not a failure.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the opencode server did not begin listening within ${READY_TIMEOUT_MS / 1000}s`,
      );
    }
    await Bun.sleep(100);
  }
}
