/**
 * Can this build's opencode be got onto disk, and is it a version this build knows how to drive?
 *
 * **opencode is CARRIED, exactly as the Claude CLI is.** It used to be a machine requirement,
 * standing beside `bun` and `uv` — something checked at boot and named in the README — on the
 * argument that vendoring a separate program with its own release cadence meant shipping a coding
 * agent nobody asked this project to maintain. What changed is the goal rather than the argument: a
 * compiled YewReview is a closed ecosystem, and a harness the binary offers but cannot run without
 * a separate install is an offer with a footnote. The version is pinned in `package.json`, locked in
 * `bun.lock`, and rebuilding is how an installation catches up.
 *
 * So there is no PATH search here any more. `resources/embed.ts` hands over the extracted copy — or
 * whatever `YEWREVIEW_OPENCODE_CLI` names, for a platform the packages do not cover — and what is
 * left for a probe to do is ask the binary its version and check the range.
 *
 * **Absent is not fatal.** The server starts, the archive is readable, every report ever published
 * is still served — and the chat says plainly that it cannot answer and why. That is the same shape
 * as a missing measurement engine (`sandbox/venv.ts`), and for the same reason: a startup that dies
 * because one capability is missing takes away the nine that are not.
 *
 * **A version outside the range is treated as absent rather than attempted.** The transport reads a
 * JSON API and an SSE event stream whose field names were verified against a specific release; a
 * best-effort attempt at an unknown one would fail somewhere deep in a turn, as a stream that
 * stopped saying anything the parser recognised. Refusing at boot, naming both numbers, is the
 * failure a person can act on. The range now guards a PINNED version, which does not make it
 * pointless: it is what turns a careless bump of the dependency into a boot that says so.
 */

import type { Settings } from "../config.ts";
import { opencodeCli } from "../resources/embed.ts";

/** What this build was written against, and what it will drive. */
const OPENCODE_MIN = "1.18.0";
const OPENCODE_BELOW = "2.0.0";

export type OpencodeStatus = {
  installed: boolean;
  /** The resolved absolute path, so every later spawn names the same binary a probe approved. */
  path: string | null;
  version: string | null;
  /** Installed, in range, and therefore drivable. */
  ok: boolean;
  /** What a person should do about it, or null when there is nothing to do. */
  hint: string | null;
};

/**
 * Get this build's opencode onto disk and ask its version.
 *
 * Resolved once, at boot, and the answer is not recomputed: a harness that re-resolved its own
 * binary between turns could be driving two different programs in one conversation, which is
 * exactly the kind of thing nobody would think to suspect.
 */
export async function probeOpencode(settings: Settings): Promise<OpencodeStatus> {
  let path: string;
  try {
    path = await opencodeCli(settings);
  } catch (err) {
    // The extraction or the dev-mode resolve failed, and its own message already names what was
    // looked for and what to set instead — a second sentence written here would say it worse.
    return {
      installed: false,
      path: null,
      version: null,
      ok: false,
      hint: err instanceof Error ? err.message : String(err),
    };
  }

  const version = await askVersion(path);
  if (version === null) {
    return {
      installed: true,
      path,
      version: null,
      ok: false,
      hint: `\`${path} --version\` did not answer with a version, so this build cannot tell whether it knows how to drive it.`,
    };
  }
  if (!inRange(version)) {
    return {
      installed: true,
      path,
      version,
      ok: false,
      hint:
        `opencode ${version} is outside the range this build was written against ` +
        `(>= ${OPENCODE_MIN}, < ${OPENCODE_BELOW}). Its API and event stream are read field by ` +
        `field, so driving an unknown version would fail mid-turn rather than here. This build ` +
        `carries its own opencode, so this means the pin in package.json moved without the ` +
        `transport being re-verified against it.`,
    };
  }
  return { installed: true, path, version, ok: true, hint: null };
}

async function askVersion(path: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0) return null;
    // `opencode --version` answers with the bare number, but a build that prefixed it would still
    // be readable — the first dotted triple in the output is the version by any spelling.
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Inclusive of the floor, exclusive of the ceiling, compared component by component so `1.9.0`
 * does not sort below `1.18.0` the way a string comparison would have it. */
function inRange(version: string): boolean {
  return compare(version, OPENCODE_MIN) >= 0 && compare(version, OPENCODE_BELOW) < 0;
}

function compare(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
