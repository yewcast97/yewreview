/**
 * Environment hygiene, applied once before anything else reads `process.env`.
 *
 * Two namespaces need active defending and both bite at a distance:
 *
 * `SEIKAN_*` is owned by the measurement engine, and owned STRICTLY — its settings model refuses
 * to construct when it meets a variable under that prefix it does not declare, and it re-reads the
 * environment on every construction. The engine runs as a subprocess inside the sandbox venv,
 * which inherits this process's environment, so one stray `SEIKAN_` variable in a shell profile
 * would fail every measurement the agent attempts with a `thresholds_invalid` envelope that names
 * the variable but not the reason it is there.
 *
 * A BLANK `ANTHROPIC_API_KEY` is worse than an absent one: the SDK treats the empty string as a
 * key and authenticates with nothing, shadowing the credentials the user already has. An empty
 * value is never what someone meant, so it is removed rather than passed on.
 */

export const SEIKAN_ENV_PREFIX = "SEIKAN_";

/** Remove every `SEIKAN_*` variable, returning the names removed so a caller can say so out loud. */
export function scrubSeikanEnv(env: Record<string, string | undefined> = process.env): string[] {
  const removed = Object.keys(env)
    .filter((name) => name.startsWith(SEIKAN_ENV_PREFIX))
    .sort();
  for (const name of removed) delete env[name];
  return removed;
}

/** Unset `ANTHROPIC_API_KEY` when it is present but blank. Returns true when it was dropped. */
export function dropEmptyApiKey(env: Record<string, string | undefined> = process.env): boolean {
  const key = env["ANTHROPIC_API_KEY"];
  if (key !== undefined && key.trim() === "") {
    delete env["ANTHROPIC_API_KEY"];
    return true;
  }
  return false;
}

/** The credentials that answer AS this installation, and must not travel into anything it spawns. */
const AGENT_CREDENTIALS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/**
 * `process.env` minus this installation's own credentials — the base every child gets.
 *
 * Two callers, one rule, and it is worth stating once because the two arrive at it from different
 * directions. A run tool spawns a program the AGENT WROTE: a key in its environment is a key the
 * agent can spend or exfiltrate through a program nothing reviewed. The opencode child is a whole
 * second agent answering through somebody else's models: this machine's Claude login is no use to
 * it and holding one only gives a credential a longer reach than the thing needing it.
 *
 * Note what this does NOT strip. The Claude session's own subprocess is built elsewhere and keeps
 * the key deliberately — it is the thing the key is for.
 */
export function credentialFreeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if ((AGENT_CREDENTIALS as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  return env;
}
