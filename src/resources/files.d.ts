/**
 * Declarations for the resources the bundle carries.
 *
 * `import x from "..." with { type: "file" }` yields a path string at runtime, but TypeScript has
 * no idea what a `.whl` or a platform binary is, so each one is declared here rather than silenced
 * at the import site with a comment nobody will maintain.
 */

/** One pattern for all eight of the SDK's platform packages, because which one is imported is
 * decided per machine — see `claudePlatform.ts`. Only the build-time rewritten form of
 * `claudeBinary.ts` imports one, so on a committed tree this declaration describes nothing; it is
 * here so a `tsc` run during a build, or over a checkout an interrupted build left rewritten, is
 * about the code rather than about the interruption. */
declare module "@anthropic-ai/claude-agent-sdk-*" {
  const path: string;
  export default path;
}

/** The same, for all twelve of opencode's platform packages — see `opencodePlatform.ts`. Only the
 * rewritten form of `opencodeBinary.ts` imports one. */
declare module "opencode-*" {
  const path: string;
  export default path;
}

declare module "*.min.js" {
  const path: string;
  export default path;
}

declare module "*.whl" {
  const path: string;
  export default path;
}

declare module "*.txt" {
  const path: string;
  export default path;
}

/** The host's own `uv`, copied into `build/resources/uv.bin` by the build so the compiled binary can
 * provision a measurement environment on a machine that has no uv. Only the rewritten form of
 * `uvBinary.ts` imports it; the extension is invented for this one file, which is why the pattern is
 * narrow enough not to catch anything else. */
declare module "*.bin" {
  const path: string;
  export default path;
}

/** The odd one out: `with { type: "text" }` yields the CONTENTS rather than a path, which is what
 * `claudecode/prompt.ts` imports its two markdown prompts as. Same mechanism, different payload. */
declare module "*.md" {
  const content: string;
  export default content;
}
