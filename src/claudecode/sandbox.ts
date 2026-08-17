/**
 * The confinement the agent's Bash runs under.
 *
 * The agent has a full toolset — Bash, Write, Edit, the lot. That is deliberate: making it record a
 * script for every trivial action would buy provenance at the cost of making ordinary work
 * expensive, and the trade is taken the other way. So the guarantee is not "no shell at all" but a
 * NARROWER one, enforced by the operating system rather than by the absence of a tool: the agent may
 * write in its own home directory and in scratch, and nowhere else.
 *
 * There is one home and it belongs to the installation rather than to a recipe. The conversation
 * is global — it works across every recipe the archive holds — so a directory per recipe would
 * partition files that nothing partitions the WORK of, and the sandbox would be enforcing a line the
 * agent crosses in its own head every other sentence. One writable place, honestly stated, beats a
 * boundary that means nothing.
 *
 * Everything on the deny list is somewhere a WRITE would break a record rather than produce one:
 *
 *   db/          the ledger itself; a direct write is indistinguishable from corruption
 *   venv/        the measurement engine — one the agent can edit is not evidence about anything
 *   reports/     not the published documents — those are rows — but the served chart library,
 *                and an agent that can edit echarts.min.js can script every report ever published
 *   claudecode/  the transcript of this conversation; a record that can be edited is not one
 *   bin/         the executables this process spawns, extracted out of the compiled binary
 *
 * The network is deliberately unrestricted. Research means fetching from places nobody enumerated
 * in advance, and a host allow-list that the agent can request additions to is an allow-list in
 * name only. What the sandbox is doing here is bounding the blast radius of a WRITE, not policing
 * where a number came from — that is what information sources and references are for.
 */

import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

import type { Settings } from "../config.ts";
import { homeDir, paths } from "../config.ts";

/**
 * This is the CLAUDE HARNESS'S half of the write rule, which is why it lives here rather than under
 * `src/sandbox/`. `SandboxSettings` is the SDK's vocabulary and the SDK is the only thing that reads
 * it; the opencode harness reaches the same guarantee by a different route entirely (its child is
 * wrapped in `confine()` and its built-in shell is switched off in the rendered config). What the
 * two paths share is `src/sandbox/exec.ts` — the confinement every spawn out of the server process
 * gets — and the rule itself, stated in three places that must be changed together.
 */
export function sandboxSettings(settings: Settings): SandboxSettings {
  const p = paths(settings);
  const home = homeDir(settings);
  return {
    enabled: true,
    // No silent fallback to an unsandboxed shell. If the OS sandbox is unavailable, Bash fails
    // loudly and the system prompt has already told the agent to say so, which is a better outcome
    // than a confinement that quietly is not there.
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      // The engine's compiled-kernel cache is writable on purpose. `NUMBA_CACHE_DIR` is handed to
      // every session, and a cache directory the process cannot write is worse than no cache: the
      // first measurement fails outright rather than merely recompiling, and the agent's only way
      // forward is to redirect the variable somewhere else — which it will do, correctly, and then
      // every run pays full compilation because nothing it writes survives the turn. A cache is
      // not a record; nothing here is evidence about anything.
      allowWrite: [`${home}/**`, `${p.tmpDir}/**`, `${p.numbaCacheDir}/**`],
      denyWrite: [
        `${p.dbPath}*`,
        `${settings.varDir}/db/**`,
        `${p.venvDir}/**`,
        `${p.reportsDir}/**`,
        // The transcript of this very conversation. It is outside `allowWrite` already, and named
        // here for the same reason its neighbours are: an agent that can edit the record of what
        // was said can make the record disagree with what happened, which is the one failure this
        // archive has no way to notice.
        `${p.claudecodeDir}/**`,
        // The executables this process spawns, extracted out of the compiled binary. An agent that
        // can replace one is an agent that chooses what the NEXT boot runs as its own harness or as
        // its measurement environment's installer — the one write on this list that would still be
        // there after a restart.
        `${p.binDir}/**`,
      ],
      // Reading the ledger as a file is reading AROUND the tools, which are the only interface the
      // archive has. Every list tool hydrates and joins before it answers, so a raw read returns
      // rows that mean less than the tool's answer does — and it quietly makes the on-disk shape an
      // interface the schema is then not free to change.
      denyRead: [`${p.dbPath}*`, `${settings.varDir}/db/**`],
    },
    network: {
      // Explicit, and it has to be. The sandbox pre-allows NO domain by default and asks for each
      // new one the first time it is needed — which works at a terminal and fails silently here,
      // because a headless session running `dontAsk` has nobody to ask and the request simply does
      // not happen. Left unset, the agent quietly loses every fetch it makes through a shell, which
      // is most of how a research agent gets data.
      allowedDomains: ["*"],
    },
    credentials: {
      // The agent's own API credential is not an input to any research it does, and a subprocess
      // that can read it can spend it.
      envVars: [{ name: "ANTHROPIC_API_KEY", mode: "deny" }],
    },
    allowAppleEvents: false,
  };
}
