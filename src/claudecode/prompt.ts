/**
 * The system prompt: assembled once, and byte-for-byte identical on every turn of every session.
 *
 * That stability is the design constraint, not a nicety. The provider caches a prompt by its
 * prefix, a research conversation runs to dozens of turns, and a single varying byte up here — a
 * timestamp, a recipe's name, a count of anything — pays for the whole prefix again on every
 * one of them. Everything that varies per piece of work is delivered inside the turn that needs it
 * instead; `start_generation` does that with the recipe.
 *
 * The middle section is not written here and deliberately cannot be. The engine ships its DSL guide
 * as package data and `provisionVenv` reads it out of the INSTALLED package, so what the agent
 * works from is the reference of the engine it is actually calling. A guide maintained in this repo
 * would drift from the engine the first time either moved, and the drift would surface as a thesis
 * the agent wrote confidently and seikan refused.
 *
 * When there is no engine, that slot says so. The agent needs to learn that measurement is
 * unavailable in the same place it would otherwise have learned to measure — not from a tool
 * refusal three turns into a plan built on being able to.
 */

import type { VenvStatus } from "../sandbox/venv.ts";

// Bun resolves text imports and `bun build --compile` embeds the bytes, which is the whole reason
// these are imported rather than read off disk at boot: a compiled binary has no `prompts/` beside
// it. The `*.md` declaration in `resources/files.d.ts` is what gives them a type: an ambient
// declaration IS consulted for a relative specifier, so neither line needs a `@ts-ignore`.
import systemMarkdown from "./prompts/system.md" with { type: "text" };
import reportGuideMarkdown from "./prompts/report_guide.md" with { type: "text" };

const SYSTEM: string = systemMarkdown;
const REPORT_GUIDE: string = reportGuideMarkdown;

/**
 * What stands in for the DSL reference when the engine is not installed.
 *
 * Written as instructions rather than as an apology: the agent's job in that installation is to say
 * plainly that a thesis cannot be measured here, and to keep doing the other ninety percent.
 */
const NO_ENGINE = `# The thesis DSL

The measurement engine is not installed in this environment, so there is no DSL reference to give
you and no thesis can be measured here.

This changes what you may say, not what you may do. Research, sources, scripts, references and
reports all work exactly as described — what stops is measuring, and with it any assessment of a
thesis, since an assessment carries the engine's own report for the run it was read off and there
is no run. A thesis may still be stored; it simply stands unassessed. What you must not do is
describe a measurement you could
not run: no estimated statistics, no "this would likely show", no numbers reconstructed by hand. If
the user asks for a thesis to be measured, tell them the engine is unavailable in this installation
and stop there — a stated absence is worth more to them than a plausible number.`;

/**
 * Cached across turns, keyed on the guide itself.
 *
 * A plain once-and-forever cache would be wrong in one real case: the engine can be provisioned
 * after the process is already serving, and the first conversation of that boot would then keep
 * telling the agent measurement is unavailable for as long as YewReview ran. Keying on the guide keeps
 * the prompt byte-stable for as long as the engine is, which is the property that matters, and
 * pays for one re-cache on the transition.
 */
let cached: { key: string; prompt: string } | null = null;

/** The agent's system prompt: identity and doctrine, the engine's own reference, the report guide. */
export function systemPrompt(venv: VenvStatus): string {
  const guide = venv.dslGuide ?? NO_ENGINE;
  if (cached?.key === guide) return cached.prompt;
  const prompt = [SYSTEM.trim(), guide.trim(), REPORT_GUIDE.trim()].join("\n\n");
  cached = { key: guide, prompt };
  return prompt;
}
