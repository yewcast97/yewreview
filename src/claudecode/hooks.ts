/**
 * The one confinement the OS sandbox cannot provide: a guard on the SDK's own file tools.
 *
 * `claudecode/sandbox.ts` bounds what the agent's Bash may write, and the operating system enforces it.
 * `Write` and `Edit` are not shell commands. They run inside the Claude Code process, under the
 * permission system rather than under Seatbelt or bubblewrap, and this session runs `dontAsk` with
 * both tools on the allow list — so without this hook the sandbox's rule would hold for everything
 * the agent does through a shell and for nothing it does through a tool. The gap is not theoretical:
 * the chart library every published report loads sits under `var/reports/assets/`, and an agent
 * that can edit those bytes afterwards can script every document ever published from this
 * installation.
 *
 * So the sandbox's rule is spelled a second time for a second enforcement point: a file write lands
 * in the agent's home directory or in scratch, and for every other tree there is a TOOL that is the
 * door. The refusal names that tool, because a denial the model cannot act on is just a retry.
 *
 * The path is resolved through the deepest ancestor that actually exists before it is judged, so a
 * symlink planted in the home directory is measured by where it points rather than by how it is
 * spelled.
 *
 * PostToolUse observes and never denies. It is here so a developer chasing a turn can see what the
 * agent did, in order; above debug it says nothing at all.
 */

import { isAbsolute, resolve, sep } from "node:path";

import type { HookCallbackMatcher, HookEvent, HookInput } from "@anthropic-ai/claude-agent-sdk";

import type { Settings } from "../config.ts";
import { homeDir, paths, realPath } from "../config.ts";

/** The tools that write a file without going through a shell, and therefore past the sandbox. */
const FILE_TOOLS = "Write|Edit";

/**
 * What the built-in shell may run while a generation procedure is in progress: NOTHING.
 *
 * This used to be a string match against the engine binary and the venv interpreter, and the
 * comment beside it admitted what that was worth — a copied interpreter or a `python -c "import
 * seikan"` slipped straight past. It closed the accidental case and left the rest to hope.
 *
 * The narrow guard is the wrong shape entirely, not merely a leaky one. A report records EVERY
 * command its procedure ran, not only the measurements: `script_invocation` for a stored program,
 * `seikan_invocation` for a measurement, and `trivial_shell_history_for_report` for everything
 * else. A record of every command is only worth
 * having if it is a record of every command, so during a procedure there is exactly one door — the
 * `run_shell`, `run_script` and `run_seikan` tools, all three of which go through `src/exec.ts` and
 * write the log — and the built-in Bash is closed for the duration. That turns a best-effort string
 * match into a structural fact, and it is why "a command that ran and left no row" is now a
 * sentence about something that cannot happen rather than a caveat.
 *
 * Outside a procedure the shell is untouched. There is no report for a record to be part of, so
 * there is nothing to be missing from.
 */

/**
 * Where each tree's door is, for a refusal that tells the agent what to do instead.
 *
 * `reports/` holds no documents at all — a report is a row, written by `publish_report` and served
 * out of the database — so what lives under it is the chart library that published HTML loads,
 * which nothing writes but the installer.
 */
function doorFor(relative: string): string {
  const root = relative.split("/")[0] ?? "";
  if (root === "reports") {
    return (
      "a report is stored in the database and served from it, and publish_report is the door; " +
      "what lives here is the chart library your published pages load, which nothing edits"
    );
  }
  if (root === "venv") {
    return "this is the measurement engine; an engine you can edit is not evidence about anything";
  }
  if (root === "db") {
    return "the ledger is written through your tools, never as a file";
  }
  return "your home directory and var/tmp are the two places a file write lands";
}

/** Is `target` inside `root`, given both are already absolute and resolved? */
function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function resolvedTarget(cwd: string, filePath: string): string {
  return realPath(isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
}

function filePathOf(toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const value = (toolInput as { file_path?: unknown }).file_path;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The hooks the agent's session runs with.
 *
 * The permitted directory is derived from `settings` rather than read out of the hook input: the
 * input's `cwd` is where the tool call was made from, which the agent can change, and a guard that
 * takes its boundary from a value the guarded party controls is not a guard.
 *
 * `generating` is read at call time rather than captured, because a session outlives many
 * procedures: the shell guard is on for the duration of one and off either side of it, and there is
 * no moment at which rebuilding the hooks would be the right way to say that.
 */
export function agentHooks(
  settings: Settings,
  generating: () => boolean = () => false,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const home = realPath(homeDir(settings));
  const p = paths(settings);
  const scratch = realPath(p.tmpDir);
  const varRoot = realPath(settings.varDir);
  const writable = [home, scratch];
  const debug = settings.logLevel === "debug";

  return {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name !== "PreToolUse") return { continue: true };
            if (!generating()) return { continue: true };
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason:
                  "a generation procedure is running here, and this report will record every " +
                  "command that produced it — what ran, what it exited with, how long it took and " +
                  "what it printed. A command run through this shell would be in none of that, so " +
                  "the shell is closed for the duration and nothing is lost by it: run_shell runs " +
                  "any command line and records it, run_script runs a stored program, and " +
                  "run_seikan measures a thesis. Outside a generation your shell is your own.",
              },
            };
          },
        ],
      },
      {
        matcher: FILE_TOOLS,
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name !== "PreToolUse") return { continue: true };
            const filePath = filePathOf(input.tool_input);
            // A call with no path is malformed and the tool itself will say so. Denying it here
            // would answer a different complaint than the one the agent actually has.
            if (filePath === null) return { continue: true };

            const target = resolvedTarget(input.cwd, filePath);
            if (writable.some((root) => within(root, target))) return { continue: true };

            const relative = target.startsWith(varRoot + sep)
              ? target.slice(varRoot.length + 1)
              : target;
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason:
                  `${input.tool_name} may not write ${target}. Your writable places are your ` +
                  `home directory (${home}) and scratch (${scratch}). For this one, ` +
                  `${doorFor(relative.split(sep).join("/"))}.`,
              },
            };
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input: HookInput) => {
            if (debug && input.hook_event_name === "PostToolUse") {
              console.debug(`[YewReview] tool ${input.tool_name} finished`);
            }
            return { continue: true };
          },
        ],
      },
    ],
  };
}
