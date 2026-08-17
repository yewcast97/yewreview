/**
 * Where the measurement engine comes from — the build's answer, or nothing.
 *
 * This is the DEV form. A checkout has no wheel (it is a build product), so both exports are null
 * and `embed.ts` falls back to installing `vendor/seikan` editable, which is what makes an engine
 * edit visible without a wheel rebuild.
 *
 * `scripts/build.ts` rewrites this file with real `with { type: "file" }` imports, compiles, and
 * restores the stub. Keeping a committed stub rather than generating the module from nothing means
 * no static import ever names a file that is not there, so `bunx tsc --noEmit` is honest in both
 * modes.
 */

export default null as string | null;
export const requirements: string | null = null;
export const wheelName: string | null = null;
