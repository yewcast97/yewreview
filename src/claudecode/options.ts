/**
 * How the agent is configured — and, more to the point, what it is allowed to do.
 *
 * **`tools` is left unset, so the agent gets the whole builtin toolset.** The alternative — no shell
 * and no file writer at all, every byte on disk the output of a script YewReview had recorded first —
 * buys total provenance and makes ordinary work, read a page, reshape a CSV, try a fetch, cost a
 * recorded program each time. The trade is taken the other way here, and what stands in that
 * guarantee's place is narrower and is enforced by the operating system rather than by the absence
 * of a tool: `sandbox` below confines every command the agent's Bash runs to its home directory and
 * scratch, and the two trees that carry provenance carry it as a DECLARATION anchored to a hash
 * rather than as a proof. Say that honestly; it is a real weakening, taken on purpose, for a real
 * gain.
 *
 * **Network is unrestricted.** Research means fetching from places nobody enumerated in advance,
 * and an allow-list the agent can ask to extend is an allow-list in name only. The sandbox here
 * bounds writes, not curiosity.
 *
 * **Permission mode is `dontAsk`.** Nothing can answer a permission prompt in a headless server, so
 * anything outside the allow list is denied with an error the model can read and work around.
 * `bypassPermissions` would approve whatever the scoping missed, which is exactly the wrong default
 * for a capability list that will grow.
 *
 * **The agent may delegate, and does unless the conversation says otherwise.** `SUBAGENT_TOOLS`
 * below is the whole of that surface, and it is granted as one group because the pieces are useless
 * apart. What it does NOT do is widen anything else: a delegate is spawned by the same subprocess
 * under the same options, so the sandbox that bounds this session's writes bounds every agent it
 * starts, and the permission mode that denies an unlisted tool denies it to all of them. The one
 * thing that genuinely changes is how much can be in flight at once, which is why `Agent.setSubagents`
 * exists rather than this being a fact about the installation.
 *
 * **No settings sources, no skills, no foreign MCP.** This repository's `CLAUDE.md`, its skills and
 * any `.mcp.json` it grows are for people working ON YewReview, not for YewReview. `strictMcpConfig` matters
 * more than it looks: the session's cwd is the agent's own home directory, which it may write
 * freely, so a project-scoped MCP config discovered from there would be a server the agent had
 * granted itself — and, now that it can delegate, one it had granted to every agent it starts.
 */

import type { McpServerConfig, Options, SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

import type { EffortLevel, Settings } from "../config.ts";
import { homeDir, paths } from "../config.ts";
import type { Resources } from "../resources/embed.ts";
import { sandboxSettings } from "./sandbox.ts";
import type { VenvStatus } from "../sandbox/venv.ts";
import { systemPrompt } from "./prompt.ts";
import { agentHooks } from "./hooks.ts";
// The server's name is imported rather than spelled again: it is half of every tool's address, and
// two spellings of it would disagree as a session where nothing is allowed and nothing says why.
import { SERVER_NAME } from "../protocol/types.ts";

/**
 * The builtin tools, listed rather than inherited.
 *
 * `tools` stays unset so the agent has the full set; this list is what `allowedTools` auto-approves,
 * and writing it out is what makes the capability surface readable in one place. A tool absent from
 * here still exists — it is simply one the agent would need permission for, and nothing in a
 * headless session can grant it.
 */
const BUILTIN_TOOLS: readonly string[] = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
];

/**
 * The tools that let a session delegate, listed as ONE GROUP because they are one capability.
 *
 * `Agent` and `Workflow` are the capability itself: a question that decomposes into six independent
 * readings is answered better by six contexts than by one that has to hold all six at once, and a
 * workflow is the same fan-out written down before it runs.
 *
 * The three beside them are not optional companions, and calling them that is how a surface ends up
 * half-granted. An agent runs in the BACKGROUND by default, so what it produced is FETCHED rather
 * than returned — a session allowed to start work but not to read it back would spend real money on
 * answers it can never see, which is exactly what leaving `TaskOutput` out would buy. `TaskStop` is
 * the other half of that: work started in the background and unstoppable is work that runs until the
 * session ends. `SendMessage` is the only way to steer an agent that is already running, which is
 * what a long delegation needs the moment the question turns out to have been asked badly.
 *
 * `MONITOR IS DELIBERATELY ABSENT, and it is the one exclusion here made on safety rather than on
 * shape. Its input carries a shell command of its own, which makes it a SECOND way to run one — and
 * the generation-time engine guard in `claudecode/hooks.ts` is matched on the tool named `Bash`, so a
 * command arriving under any other name is a command that guard never reads. What that guard is
 * holding up is the provenance promise: while a report is being generated the engine is reached
 * through the run tools that write the run log, and a second door into the shell is a way for the
 * same work to happen unlogged. Nothing is lost by refusing it, because waiting is what `TaskOutput`
 * already does when asked to block.
 *
 * The task-board CRUD — `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` — is deliberately not here
 * either. That board is for work several parties coordinate over, and there is no second party in
 * this installation: `TodoWrite` already carries the model's own plan bookkeeping, and the loop these
 * five describe — spawn, steer, collect — never needs a row somebody else could read.
 */
const SUBAGENT_TOOLS: readonly string[] = [
  "Agent",
  "Workflow",
  "TaskOutput",
  "TaskStop",
  "SendMessage",
];

export type AgentOptionsInput = {
  settings: Settings;
  /**
   * Which model this session answers with. Absent means the installation's default.
   *
   * `settings.model` is the DEFAULT and not the value, because the env var and the CLI flag
   * configure the installation while which model is writing is a fact about one conversation — see
   * `Agent.setModel`. Passing it in rather than reading the agent's field keeps this function what
   * it is: options assembled from its arguments, with no opinion of its own.
   */
  model?: string;
  /**
   * How hard this session's model is asked to work. Absent means the installation's level, which is
   * always one of the five — nothing configures it, and `config.ts` seats it.
   *
   * Here for the same reason `model` is: `settings.effort` is where a conversation starts, while how
   * hard to work on the question in front of the agent is a fact about one conversation — see
   * `Agent.setEffort`. Spelled `| undefined` rather than left bare because `exactOptionalPropertyTypes`
   * is on and a caller may hold the field without holding a value for it; requiring it to be omitted
   * instead would push a conditional spread into the caller to say a thing this function already
   * knows how to say.
   */
  effort?: EffortLevel | undefined;
  /**
   * Whether this session may delegate — the six tools above, and the workflow feature they need.
   * Absent means the default, which is on.
   *
   * A per-conversation fact like `model` and `effort`, and here for the same reason: nothing about
   * the installation configures it, while whether the question in front of the agent is worth
   * fanning out over is a decision about one conversation — see `Agent.setSubagents`. Unlike those
   * two it cannot be moved under a live session at all, because an allow list is what the subprocess
   * was STARTED with; the agent ends the session instead and the next turn reopens the same
   * conversation with options built from the new answer.
   */
  subagents?: boolean | undefined;
  /** Only the executable is read here; the rest of the bundle is no concern of the session's. */
  resources: Pick<Resources, "claudeCli">;
  /** Read at session start, so an installation with no engine says so in the system prompt. */
  venv: VenvStatus;
  /** YewReview's own tools, or null when this boot has none to give. */
  mcpServer: McpServerConfig | null;
  /** Fully qualified (`mcp__yewreview__…`), as the tools module derives them from its own definitions. */
  toolNames: readonly string[];
  /** The conversation to reopen — one the user picked out of the session list, or the one this boot
   * already minted. Absent means a fresh one. */
  resume?: string | undefined;
  /** Whether a generation procedure is in progress, read at each hook call rather than captured:
   * the options are built once per session and a session sees many procedures. */
  generating?: (() => boolean) | undefined;
};

/**
 * Options for the agent's session.
 *
 * Everything here is stable for the life of the installation except `resume`, which names the
 * conversation being reopened. The system prompt is byte-stable across sessions as well, so the
 * provider's cache survives a restart; anything a particular piece of work needs — the recipe a
 * generation is written to, the records a question is about — rides in the turn that asks for it.
 */
export function buildAgentOptions(input: AgentOptionsInput): Options {
  const { settings, resources, venv, mcpServer, toolNames, resume } = input;
  const generating = input.generating ?? (() => false);
  // The conversation's level if it has one, the installation's otherwise — and the installation
  // always has one, so this resolves to a level rather than to an absence.
  const effort = input.effort ?? settings.effort;
  // On unless this conversation turned it off. The default is stated here rather than left to the
  // caller because every caller would otherwise state it, and a session built without an opinion
  // about delegation is a session that should be able to delegate.
  const subagents = input.subagents ?? true;
  const p = paths(settings);
  const home = homeDir(settings);

  // A DEFECT rather than a refusal, and so a plain throw. `extractResources` resolves the executable
  // only when this is the harness running, so a null here means a Claude session was constructed on
  // a boot that had already decided not to have one — a wiring mistake in `main.ts`, not a machine
  // this installation could report something honest about.
  const { claudeCli } = resources;
  if (claudeCli === null) {
    throw new Error(
      "defect: a Claude session was built without its executable — extractResources resolves one " +
        "only for the claudecode harness, so this boot named the other and started this anyway",
    );
  }

  const sandbox: SandboxSettings = sandboxSettings(settings);

  return {
    systemPrompt: systemPrompt(venv),
    model: input.model ?? settings.model,
    // Always named, because a session always has a level: `high` unless this conversation moved it.
    // The value arrives already narrowed — `Agent.setEffort` refuses a name the socket carried, which
    // is the only route by which an unchecked string could get this far.
    effort,

    // `tools` is deliberately absent — see the module docstring. Its absence is the capability
    // decision; removing this comment would make it look like an oversight.
    allowedTools: [
      ...BUILTIN_TOOLS,
      // All six or none of them — see `SUBAGENT_TOOLS` for why a half-granted delegation surface is
      // worse than none. Off, the tools are still in the model's context and are simply denied at
      // permission time, which is what this session's surface was before the option existed.
      ...(subagents ? SUBAGENT_TOOLS : []),
      // With no server there is nothing to allow, and a pattern matching nothing is a rule about
      // something that is not there. The wildcard states the policy — every YewReview tool is allowed —
      // and the derived names sit beside it so this option reads as the actual surface of the
      // session rather than as a promise about one.
      ...(mcpServer ? [`mcp__${SERVER_NAME}__*`, ...toolNames] : []),
    ],
    ...(mcpServer ? { mcpServers: { [SERVER_NAME]: mcpServer } } : {}),
    strictMcpConfig: true,

    permissionMode: "dontAsk",
    sandbox,
    hooks: agentHooks(settings, generating),

    // The repository's own instructions and skills are for developers of YewReview, not for YewReview.
    settingSources: [],
    skills: [],
    // Compaction is on by default in the harness; pinning it is a statement that YewReview depends on
    // it. A research conversation is long by nature and the alternative to compacting is a session
    // that dies mid-thought.
    //
    // `enableWorkflows` is named only when delegation is on, and its absence is not the same as
    // `false`: unset means whatever the installation would have done anyway, which is what makes a
    // session with subagents off byte-identical to one built before this option existed rather than
    // merely equivalent to it.
    settings: { autoCompactEnabled: true, ...(subagents ? { enableWorkflows: true } : {}) },

    // The home directory is the agent's cwd, the one place its shell may write, and where a
    // relative path in anything it says resolves.
    //
    // It is ALSO the SDK's project key, which is the reason it must be one fixed directory rather
    // than a per-conversation one. The SDK files a session's transcript under
    // `<config dir>/projects/<sanitized cwd>/` — the config dir being the one pinned in the
    // environment below — so a stable cwd means every session this installation has ever had lands
    // in a single bucket, and that bucket, listed, IS the session list the window draws and resumes
    // from. A cwd that moved would scatter the history across directories nothing enumerates.
    cwd: home,
    maxTurns: settings.maxTurns,
    includePartialMessages: true,
    pathToClaudeCodeExecutable: claudeCli,
    ...(resume ? { resume } : {}),

    // The SDK REPLACES the subprocess environment with this rather than merging, so `process.env`
    // is spread first — without it the CLI loses PATH, HOME and the API credential. It was scrubbed
    // of the engine's `SEIKAN_*` namespace at startup, before any module read it.
    env: {
      ...process.env,
      YEWREVIEW_VAR_DIR: settings.varDir,
      YEWREVIEW_VENV: p.venvDir,
      YEWREVIEW_HOME: home,
      // The engine's compiled kernels cache here rather than wherever numba would put them under
      // the process's own `$HOME`, so the first measurement of a boot pays for compilation once and
      // every later one does not. (Nothing to do with `YEWREVIEW_HOME` above — a kernel cache is
      // not the agent's workspace, and it is deliberately outside it.)
      NUMBA_CACHE_DIR: p.numbaCacheDir,
      // Named only when there is one. A path to an interpreter that does not exist is an invitation
      // to run it and an error the agent cannot read.
      ...(venv.python ? { YEWREVIEW_PYTHON: venv.python } : {}),
      // The CLI keys its config directory — and with it the transcript store, `<dir>/projects/` —
      // off this variable. Pinning it under `var/` is what makes `rm -rf var/` a complete reset and
      // what keeps two installations with different var-dirs from sharing one history. Set AFTER
      // the spread on purpose: a value exported in somebody's shell would otherwise scatter this
      // installation's conversations somewhere nothing here can enumerate.
      CLAUDE_CONFIG_DIR: p.claudecodeDir,
      // But the LOGIN stays where the machine keeps it. The CLI derives its credential location
      // from this variable when it is defined and from the config directory when it is not — and a
      // custom config directory means a keychain entry suffixed with that directory's hash, which
      // nobody has ever logged into. Defined-but-empty means exactly "the default `~/.claude`",
      // so the moved transcript store costs no re-authentication. This installation BORROWS the
      // machine's Claude login; it does not want one of its own.
      CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] ?? "",
    },

    ...(settings.logLevel === "debug"
      ? { stderr: (data: string) => console.debug(`[YewReview] ${data.trimEnd()}`) }
      : {}),
  };
}
