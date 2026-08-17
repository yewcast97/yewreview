/**
 * The model pool: which models this installation can reach, and which one answers in which role.
 *
 * **It is a FILE, not a table, and that is a decision about secrets.** Every record deletion in
 * this database is witnessed — the whole vanished row goes into `deletion_log` as JSON, which is
 * what makes the archive honest about what left. A pool entry holds an API key. Putting one in a
 * record table would mean that deleting a model copies its credential into a log that is never
 * revised and is read through a route in the window. The pool is also not research provenance: it
 * is configuration, the same kind of thing `--port` is, and nothing published ever points at it.
 * So it lives at `var/opencode/models.json`, written atomically, mode 600.
 *
 * **What YewReview writes for opencode is DERIVED and never hand-edited.** `materialize()` renders
 * `var/opencode/opencode.json` from the pool: one custom provider per entry, the role assignments,
 * and the tool restrictions the generation gate depends on. opencode is pointed at that file with
 * `OPENCODE_CONFIG`, so it reads exactly what this module wrote and nothing from the user's own
 * `~/.config/opencode` — a machine's global opencode settings must not reach in and change how a
 * report was produced.
 *
 * **A key may be an environment variable name, and usually should be.** opencode's config supports
 * `{env:NAME}` substitution, so an entry whose `apiKey` looks like an ALL-CAPS variable name is
 * rendered as a reference rather than as the secret itself. That keeps the rendered config free of
 * credentials for the common case, and the pool file remains the only place one is written down.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Settings } from "../config.ts";
import { paths } from "../config.ts";
import { Refused } from "../db/models.ts";
import { SERVER_NAME } from "../protocol/types.ts";

/**
 * The roles opencode routes by, as opencode itself defines them.
 *
 * Two are PRIMARY — the ones a turn can be answered in — and three are SUBAGENTS the primary
 * delegates to. They are listed here rather than discovered because the window draws a slot per
 * role and a slot for a role opencode does not have would be a control that does nothing.
 *
 * `build` is the one that must always be assigned: it answers the ordinary turn, and the pool
 * refuses to be saved without it. The rest fall back to opencode's own default when unassigned,
 * which is the honest behaviour for "I have not thought about this one yet".
 */
export const OPENCODE_ROLES = ["build", "plan", "general", "explore", "scout"] as const;

export type OpencodeRole = (typeof OPENCODE_ROLES)[number];

/** The role a turn is answered in when nobody has said otherwise. */
export const PRIMARY_ROLE: OpencodeRole = "build";

/** One model the pool can reach. */
export type PoolEntry = {
  /** Minted by the window, stable for the life of the entry, and the provider id in the rendered
   * config. Never parsed for meaning. */
  id: string;
  /** What the picker draws. */
  name: string;
  /** The OpenAI-compatible base url — `https://openrouter.ai/api/v1` and the like. */
  url: string;
  /** The credential, or the NAME of an environment variable holding one. */
  api: string;
  /** The provider's own id for the model, e.g. `openai/gpt-5.6-luna-pro`. */
  model: string;
};

export type PoolDocument = {
  entries: PoolEntry[];
  /** Role → entry id. A role with no entry is absent rather than null: the window and the renderer
   * both read "not assigned" the same way, and a null would be a third state neither uses. */
  roles: Partial<Record<OpencodeRole, string>>;
};

export type PoolStore = {
  read(): PoolDocument;
  /** Validate and replace the whole document. Throws `Refused` with a full sentence. */
  write(next: PoolDocument): PoolDocument;
  /**
   * Render `opencode.json` from the current pool. Called after every write and before every spawn.
   *
   * `secret` is the bearer the child must present at YewReview's own `/mcp`, and it is a PARAMETER
   * rather than something this module invents because the ordering matters: the config has to carry
   * the credential the server will then check, so the harness mints it, writes it here, and starts
   * the child with the same value. Null renders the MCP block disabled, which is the honest config
   * for "no child is running and none is about to" — a block naming a door with no key would have
   * the child fail its handshake at startup rather than simply not having the tools.
   */
  materialize(secret?: string | null): void;
  /** The entry a role resolves to, or null. */
  entryFor(role: OpencodeRole): PoolEntry | null;
};

const EMPTY: PoolDocument = { entries: [], roles: {} };

export function poolStore(settings: Settings): PoolStore {
  const p = paths(settings);

  const store: PoolStore = {
    read(): PoolDocument {
      let raw: string;
      try {
        raw = readFileSync(p.opencodePoolPath, "utf8");
      } catch {
        // Missing is the ordinary state of a fresh installation, not an error: the window opens
        // with an empty pool and the reader adds the first model by double-clicking the board.
        return { entries: [], roles: {} };
      }
      try {
        return normalize(JSON.parse(raw));
      } catch {
        // A file this build cannot read is refused rather than overwritten. It is the one place a
        // person's API keys are written down, and silently replacing it with an empty pool would
        // lose them to a typo.
        throw new Refused(
          "data_invalid",
          `${p.opencodePoolPath} is not readable as a model pool. Fix or move it — it is where ` +
            `this installation's model credentials are kept, so nothing here will overwrite it.`,
        );
      }
    },

    write(next: PoolDocument): PoolDocument {
      const document = validate(next);
      mkdirSync(dirname(p.opencodePoolPath), { recursive: true });
      // Written beside and renamed over, so a crash mid-write leaves the previous pool intact
      // rather than a half-file that the reader above would then refuse.
      const temporary = `${p.opencodePoolPath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      chmodSync(temporary, 0o600);
      renameSync(temporary, p.opencodePoolPath);
      // Rendered without a bearer: a pool saved while a child is running is a pool the NEXT child
      // reads, and the harness re-renders with its own secret when it spawns one.
      store.materialize(null);
      return document;
    },

    materialize(secret: string | null = null): void {
      mkdirSync(p.opencodeDir, { recursive: true });
      const config = renderConfig(store.read(), settings, secret);
      const temporary = `${p.opencodeConfigPath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      chmodSync(temporary, 0o600);
      renameSync(temporary, p.opencodeConfigPath);
    },

    entryFor(role: OpencodeRole): PoolEntry | null {
      const document = store.read();
      const id = document.roles[role];
      if (id === undefined) return null;
      return document.entries.find((entry) => entry.id === id) ?? null;
    },
  };

  return store;
}

/** A parsed document, with anything unrecognised dropped rather than trusted. */
function normalize(value: unknown): PoolDocument {
  if (typeof value !== "object" || value === null) return { ...EMPTY };
  const raw = value as { entries?: unknown; roles?: unknown };
  const entries = Array.isArray(raw.entries)
    ? raw.entries.filter(isEntry).map((entry) => ({
        id: entry.id,
        name: entry.name,
        url: entry.url,
        api: entry.api,
        model: entry.model,
      }))
    : [];
  const roles: Partial<Record<OpencodeRole, string>> = {};
  if (typeof raw.roles === "object" && raw.roles !== null) {
    for (const role of OPENCODE_ROLES) {
      const id = (raw.roles as Record<string, unknown>)[role];
      if (typeof id === "string" && entries.some((entry) => entry.id === id)) roles[role] = id;
    }
  }
  return { entries, roles };
}

function isEntry(value: unknown): value is PoolEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["id"] === "string" &&
    typeof entry["name"] === "string" &&
    typeof entry["url"] === "string" &&
    typeof entry["api"] === "string" &&
    typeof entry["model"] === "string"
  );
}

/**
 * What a pool must satisfy to be saved.
 *
 * Blank fields are ALLOWED on purpose: a note the reader has just pinned to the board is empty
 * until they type in it, and a form that refused to save a half-filled row would be a form that
 * loses work every time somebody is interrupted. What is refused is a pool that could not be
 * rendered into a coherent config — a duplicate provider id, a role naming an entry that is not
 * there, or a name this build reserves.
 */
function validate(next: PoolDocument): PoolDocument {
  const entries = Array.isArray(next.entries) ? next.entries : [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isEntry(entry)) {
      throw new Refused(
        "invalid_request",
        "each model in the pool carries an id, a name, a url, an api key and a model id; pass " +
          "empty strings for the ones not filled in yet rather than leaving them out",
      );
    }
    if (entry.id.trim() === "") {
      throw new Refused("invalid_request", "each model in the pool needs an id of its own");
    }
    if (seen.has(entry.id)) {
      throw new Refused(
        "conflict",
        `two models in the pool share the id ${entry.id}; each one becomes a provider in the ` +
          `config written for opencode, and two providers cannot have one name`,
      );
    }
    seen.add(entry.id);
    // The engine owns this namespace and refuses to run on an unrecognised entry (`src/env.ts`
    // scrubs it at boot). A pool key named this way would be scrubbed out from under opencode.
    if (entry.api.startsWith("SEIKAN_")) {
      throw new Refused(
        "invalid_request",
        `${entry.api} is in the measurement engine's own namespace, which this installation scrubs ` +
          `from the environment at startup — a key held under that name would not survive to be ` +
          `read. Rename the variable.`,
      );
    }
  }

  const roles: Partial<Record<OpencodeRole, string>> = {};
  for (const role of OPENCODE_ROLES) {
    const id = next.roles?.[role];
    if (id === undefined) continue;
    if (!seen.has(id)) {
      throw new Refused(
        "invalid_request",
        `the ${role} role is assigned to a model that is not in the pool. Assign one of the ` +
          `models on the board, or leave the slot empty.`,
      );
    }
    roles[role] = id;
  }
  if (entries.length > 0 && roles[PRIMARY_ROLE] === undefined) {
    throw new Refused(
      "invalid_request",
      `the ${PRIMARY_ROLE} role answers the ordinary turn, so a pool with models in it has to ` +
        `assign one. Drag a model onto the ${PRIMARY_ROLE} slot.`,
    );
  }
  return { entries, roles };
}

/** `{env:NAME}` when the key looks like an environment variable name, the literal otherwise. */
function apiKeyRef(api: string): string {
  return /^[A-Z][A-Z0-9_]*$/.test(api) ? `{env:${api}}` : api;
}

/**
 * The config opencode is started with.
 *
 * Three parts, and the third is load-bearing rather than tidy.
 *
 * The providers come one per pool entry, each an OpenAI-compatible endpoint. The roles become
 * `model`, `small_model` and a per-agent `model`, which is how opencode routes.
 *
 * **`tools.bash: false` is what makes the generation gate true on this path.** The Claude harness
 * closes its built-in shell with a PreToolUse hook; opencode has no such hook, so the shell is
 * removed from its toolset instead and YewReview's own `run_shell` — which confines, captures and
 * writes the run log — is the only way a command runs. Without this line a report on the opencode
 * path could be published having run commands nothing recorded, which is the one thing the gate
 * exists to make impossible.
 */
function renderConfig(
  pool: PoolDocument,
  settings: Settings,
  secret: string | null,
): Record<string, unknown> {
  const provider: Record<string, unknown> = {};
  for (const entry of pool.entries) {
    provider[entry.id] = {
      npm: "@ai-sdk/openai-compatible",
      name: entry.name === "" ? entry.id : entry.name,
      options: { baseURL: entry.url, apiKey: apiKeyRef(entry.api) },
      models: { [entry.model]: { name: entry.name === "" ? entry.model : entry.name } },
    };
  }

  const named = (role: OpencodeRole): string | undefined => {
    const id = pool.roles[role];
    if (id === undefined) return undefined;
    const entry = pool.entries.find((candidate) => candidate.id === id);
    return entry === undefined ? undefined : `${entry.id}/${entry.model}`;
  };

  const agent: Record<string, unknown> = {};
  for (const role of OPENCODE_ROLES) {
    const model = named(role);
    if (model !== undefined) agent[role] = { model };
  }

  const primary = named(PRIMARY_ROLE);
  return {
    $schema: "https://opencode.ai/config.json",
    ...(primary === undefined ? {} : { model: primary, small_model: named("plan") ?? primary }),
    provider,
    ...(Object.keys(agent).length === 0 ? {} : { agent }),
    // See the doc comment: this is the generation gate on the opencode path.
    tools: { bash: false },
    // Everything else is allowed without asking. There is no human at the keyboard to answer a
    // permission prompt mid-turn — the authority argument for this whole product is the ARCHIVE,
    // not an approval step — and a prompt nobody can answer is a turn that hangs.
    permission: { edit: "allow", webfetch: "allow" },
    // YewReview's own tools, reached back over loopback. The bearer is the same per-boot secret the
    // child was started with, so the door only opens for the process this one spawned.
    mcp: {
      [SERVER_NAME]: {
        type: "remote",
        url: `http://${settings.host}:${settings.port}/mcp`,
        enabled: secret !== null,
        ...(secret === null ? {} : { headers: { Authorization: `Bearer ${secret}` } }),
      },
    },
  } satisfies Record<string, unknown> & { $schema: string };
}

