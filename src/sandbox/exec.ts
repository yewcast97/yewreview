/**
 * Running a program the agent chose, under the same confinement its own shell gets.
 *
 * `claudecode/sandbox.ts` describes what that harness's Bash may write, and the SDK asks the
 * operating system to enforce it. The run tools do not go through the SDK: they spawn out of the
 * server process, which
 * has the server's rights — the database file, the venv, every published document's chart library.
 * A stored script is Python the agent wrote, so a run tool without this wrapper would be a hole in
 * the boundary the rest of the codebase spends its time defending, and it would be a hole in the
 * one direction that matters: the tools exist to make a run RECORDED, and a recorded run that could
 * edit the record is worse than an unrecorded one.
 *
 * So a run is wrapped in the platform's own sandbox before it is spawned. On macOS that is Seatbelt
 * (`sandbox-exec`), which is present on every machine; on Linux it is bubblewrap, which is not, and
 * whose absence `sandboxAvailability` below reports at startup — it lives here, beside the spawn it
 * governs, because both harnesses depend on it and neither owns it. The profile is deliberately
 * simpler than the SDK's: read everything, write only the run's own directory tree and the caches a
 * scientific Python stack cannot work without, and nothing else. Reads are open because a
 * measurement legitimately reads the venv it runs out of, and because nothing readable here is
 * secret — the one file that would be, the database, is closed explicitly.
 *
 * **When no sandbox is available the run is REFUSED, not run unconfined.** A measurement is not
 * worth a hole, and an installation missing bubblewrap has a fixable problem with a message
 * attached rather than a silently weaker guarantee.
 */

import { join } from "node:path";

import { realPath } from "../config.ts";

/** What a confined run needs to know about where it may write. */
export type Confinement = {
  /** The one tree the program may write in — the agent's home directory. */
  writable: string;
  /** Caches a scientific Python stack writes to and cannot be talked out of. */
  alsoWritable: readonly string[];
  /** Read is otherwise open; this is the exception, because it holds the archive, which is reached
   * through the tools and never as a file. */
  denyRead: readonly string[];
};

export type ConfinedSpawn = {
  ok: true;
  /** The argv to spawn, with the confinement wrapper already in front of it. */
  command: string[];
} | {
  ok: false;
  message: string;
};

/**
 * Wrap an argv so the operating system holds it to `confinement`.
 *
 * Returns the wrapped argv rather than spawning, so the caller keeps control of stdio, cwd, env and
 * timeouts — and so a test can read the profile that would have been applied without running
 * anything under it.
 */
export function confine(command: readonly string[], confinement: Confinement): ConfinedSpawn {
  // Every path is resolved first, and this is not a tidiness measure. The kernel enforces against
  // the REAL path, so a rule naming `/tmp/...` on macOS — where `/tmp` is a symlink into
  // `/private` — matches nothing: the writable tree is denied and the unreadable one is quietly
  // readable. Both failures are silent, and the second is the dangerous one.
  const resolved: Confinement = {
    writable: realPath(confinement.writable),
    alsoWritable: confinement.alsoWritable.map(realPath),
    denyRead: confinement.denyRead.map(realPath),
  };
  if (process.platform === "darwin") {
    return { ok: true, command: ["/usr/bin/sandbox-exec", "-p", seatbelt(resolved), ...command] };
  }
  if (process.platform === "linux") {
    return { ok: true, command: [...bubblewrap(resolved), ...command] };
  }
  return {
    ok: false,
    message:
      `no OS sandbox is available on ${process.platform}, and a run that measures something for a ` +
      `report is not worth running unconfined; this platform cannot host a measurement`,
  };
}

/**
 * A Seatbelt profile: deny writes, then allow back the trees a run legitimately owns.
 *
 * `(allow default)` then subtracting is the wrong shape — the subtraction is what has to be
 * exhaustive, and an exhaustive list of everywhere a program must not write does not exist. So the
 * write decision starts closed and only the named subtrees open. Reads stay open apart from the
 * database, per the module note above.
 */
function seatbelt(confinement: Confinement): string {
  const writes = [confinement.writable, ...confinement.alsoWritable]
    .map((path) => `  (subpath ${quote(path)})`)
    .join("\n");
  const reads = confinement.denyRead.map((path) => `  (subpath ${quote(path)})`).join("\n");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write*\n${writes})`,
    // /dev/null and the tty are writes in the kernel's eyes; a program that cannot open them fails
    // in ways that look like a bug in the program rather than a bug in this profile.
    "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))",
    reads === "" ? "" : `(deny file-read*\n${reads})`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Seatbelt profiles are s-expressions; a path becomes a quoted string with the two characters that
 * would end it escaped. */
function quote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A bubblewrap invocation: bind the whole filesystem read-only, then re-bind the writable trees.
 *
 * The last bind for a path wins, which is what makes "everything read-only, except these" a two-line
 * policy rather than a mount plan. `--die-with-parent` is what stops a measurement outliving the
 * server that started it.
 */
function bubblewrap(confinement: Confinement): string[] {
  const args = ["bwrap", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const path of [confinement.writable, ...confinement.alsoWritable]) {
    args.push("--bind", path, path);
  }
  for (const path of confinement.denyRead) {
    // An empty read-only bind over the path: it still exists, and it is empty, which is a clearer
    // failure for a program that tries to open it than a missing file that reads as "not installed".
    args.push("--ro-bind-try", "/var/empty", path);
  }
  return args;
}

/** The caches a numba/pandas stack writes to whatever anyone wants. Named here rather than at each
 * call site so the profile and the environment a run is given cannot drift apart. */
export function scientificCaches(varDir: string): string[] {
  return [join(varDir, "cache"), join(varDir, "tmp")];
}

/**
 * Is an OS sandbox actually available here?
 *
 * macOS has Seatbelt built in. Linux needs bubblewrap and socat installed, and the failure mode
 * without them is every confined run refusing — worth saying at startup, once, with the command that
 * fixes it, rather than letting the agent discover it mid-turn. Asked once by the boot, on either
 * harness: both of them spawn through `confine()` above, so neither is more entitled to the answer.
 */
export async function sandboxAvailability(): Promise<{ available: boolean; hint: string | null }> {
  if (process.platform === "darwin") return { available: true, hint: null };
  if (process.platform !== "linux") {
    return {
      available: false,
      hint: `no OS sandbox is available on ${process.platform}; the agent's shell will refuse to run commands`,
    };
  }
  const missing: string[] = [];
  for (const binary of ["bwrap", "socat"]) {
    const proc = Bun.spawn(["which", binary], { stdout: "ignore", stderr: "ignore" });
    if ((await proc.exited) !== 0) missing.push(binary);
  }
  if (missing.length === 0) return { available: true, hint: null };
  return {
    available: false,
    hint:
      `the Linux sandbox needs ${missing.join(" and ")} — install with ` +
      `'sudo apt install bubblewrap socat'. Until then the agent's shell refuses every command.`,
  };
}
