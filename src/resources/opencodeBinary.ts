/**
 * The opencode executable this installation runs its second harness with.
 *
 * This is the DEV form, and it is a function rather than an import for the reason `claudeBinary.ts`
 * is one: which package holds the executable is not knowable until the machine is known, and a
 * single static import would name one platform's package — a hardcoded fact about the machine the
 * file was first written on.
 *
 * `scripts/build.ts` rewrites this module with a real `with { type: "file" }` import of the host's
 * package, compiles, and restores the stub. A static import is only honest on a machine that has the
 * file, so the committed form names no package and `tsc --noEmit` is true in both modes.
 *
 * **opencode used to be a machine requirement and is now carried.** It stood beside `bun` and `uv`:
 * something the machine had, checked at boot, named in the README. What changed is the goal — a
 * compiled YewReview is a closed ecosystem, and a harness the binary claims to offer but cannot run
 * without a separate install is an offer with a footnote. The version is pinned in `package.json`
 * and locked in `bun.lock`, so rebuilding is how an installation catches up, exactly as it is for
 * the Claude CLI and for the engine's own wheel.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import {
  describeOpencodeHost,
  opencodeBinaryPath,
  opencodeHost,
  opencodePackageCandidates,
} from "./opencodePlatform.ts";

const resolveFrom = createRequire(import.meta.url);

/**
 * Where the executable is on this machine.
 *
 * Every candidate is tried rather than only the best one, for the reason the candidate list is
 * ordered rather than filtered: being installed is not evidence of being right, but a package that
 * is not installed cannot run at all, and the preferred one missing is a worse reason to refuse than
 * the second one being slower. The refusal, when it comes, names what was looked for.
 */
export function opencodeBinary(): string {
  const host = opencodeHost();
  const candidates = opencodePackageCandidates(host);
  const rel = opencodeBinaryPath(host.platform);
  for (const pkg of candidates) {
    try {
      const path = resolveFrom.resolve(`${pkg}/${rel}`);
      if (existsSync(path)) return path;
    } catch {
      // Not installed. The next candidate may be; on Linux that is the ordinary case rather than the
      // exceptional one.
    }
  }
  throw new Error(
    candidates.length === 0
      ? `opencode publishes no executable for ${describeOpencodeHost(host)}. Set ` +
        `YEWREVIEW_OPENCODE_CLI to an \`opencode\` already on this machine to use that instead.`
      : `No opencode executable for ${describeOpencodeHost(host)} in node_modules — looked for ` +
        `${candidates.map((pkg) => `${pkg}/${rel}`).join(" and ")}. Run \`bun install\`, or set ` +
        `YEWREVIEW_OPENCODE_CLI to an \`opencode\` already on this machine.`,
  );
}
