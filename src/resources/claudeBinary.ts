/**
 * The Claude Code executable this installation runs its agent with.
 *
 * This is the DEV form, and it is a function rather than an import for one reason: which package
 * holds the executable is not knowable until the machine is known. A single static import named one
 * platform's package, which made the checkout buildable on exactly that platform and `bun run dev`
 * broken on every other — a hardcoded fact about the machine the file was first written on.
 *
 * `scripts/build.ts` rewrites this module with a real `with { type: "file" }` import of the host's
 * package, compiles, and restores the stub — the same swap `seikanWheel.ts` gets, for the same
 * reason. A static import is only honest on a machine that has the file, so the committed form names
 * no package and `tsc --noEmit` is true in both modes.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { claudeBinaryName, claudePackageCandidates, describeHost, hostTriple } from "./claudePlatform.ts";

const resolveFrom = createRequire(import.meta.url);

/**
 * Where the executable is on this machine.
 *
 * Every candidate is tried rather than only the best one, because on Linux both the glibc and the
 * musl package install and only their order says which is right — and if the preferred one turns out
 * not to be there, the other one running is better than a refusal. The refusal, when it comes, names
 * what was looked for: "no Claude Code executable" with nothing after it sends a reader to search
 * the wrong half of the system.
 */
export function claudeBinary(): string {
  const host = hostTriple();
  const candidates = claudePackageCandidates(host);
  const name = claudeBinaryName(host.platform);
  for (const pkg of candidates) {
    try {
      const path = resolveFrom.resolve(`${pkg}/${name}`);
      if (existsSync(path)) return path;
    } catch {
      // Not installed. The next candidate may be; on Linux that is the ordinary case rather than the
      // exceptional one.
    }
  }
  throw new Error(
    candidates.length === 0
      ? `The Claude Agent SDK publishes no executable for ${describeHost(host)}. Set ` +
        `YEWREVIEW_CLAUDE_CLI to a \`claude\` already on this machine to use that instead.`
      : `No Claude Code executable for ${describeHost(host)} in node_modules — looked for ` +
        `${candidates.map((pkg) => `${pkg}/${name}`).join(" and ")}. Run \`bun install\`, or set ` +
        `YEWREVIEW_CLAUDE_CLI to a \`claude\` already on this machine.`,
  );
}
