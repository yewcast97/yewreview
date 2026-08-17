/**
 * The `uv` this installation provisions its measurement environment with — the build's copy, or
 * nothing.
 *
 * This is the DEV form. A checkout carries no uv: it is a build product in the sense that matters
 * here, a copy of whatever `uv` the build machine used, so the export is null and `embed.ts` falls
 * back to the one on PATH. A checkout that is building the engine's wheel already has uv installed.
 *
 * `scripts/build.ts` rewrites this file with a real `with { type: "file" }` import, compiles, and
 * restores the stub — the same swap `seikanWheel.ts` and the two executable shims get, for the same
 * reason: no static import ever names a file that is not there, so `tsc --noEmit` is honest in both
 * modes.
 *
 * **Why uv and not the whole venv.** Embedding the environment itself would mean carrying a Python
 * interpreter and the compiled wheels of numba, scipy, numpy and pandas for every platform, which
 * triples the binary to save a one-time wait — and a venv is not relocatable anyway: `pyvenv.cfg`
 * and every shebang under `bin/` hold absolute paths, and the var-dir differs between a checkout and
 * an installation. Carrying uv instead removes the machine requirement without pretending the
 * network one is gone: the first provision still reaches PyPI, and says so.
 */

export default null as string | null;
