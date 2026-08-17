/**
 * Resolving a path the model named, against the one directory it owns.
 *
 * Every tool that takes a path takes a home-relative one, and every one of them has the same job to
 * do first: refuse an absolute path, resolve what is left through symlinks, and check that what it
 * resolved to is still inside the home directory. Resolving BEFORE judging is the whole point — a
 * check on the spelling of a path only ever catches an honest spelling, and `../` and a symlink
 * planted in the home directory are both spellings that look fine.
 *
 * There is ONE such directory for the whole installation, not one per recipe, and containment does
 * not care: it is a claim about a TREE — this path, once resolved, is under that root — and it does
 * not depend on which conversation named the path. Recipes are rows; the agent's files live where
 * the agent lives, and a path that leaves that tree is refused.
 *
 * The refusals say "your home directory" in those words on purpose: the sandbox's deny reason and
 * the `invalid_path` hint say the same thing, and a model told three different names for one place
 * has to guess which of them it is allowed to write in.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Settings } from "../config.ts";
import { homeDir, realPath } from "../config.ts";
import { Refused } from "../db/models.ts";

/**
 * The path a home-relative name actually points at, or a refusal.
 *
 * `what` names the thing in the refusal — "draft", "data file" — because a path refusal the model
 * cannot tell apart from another path refusal is one it will answer by trying the same thing again.
 */
export function resolveInHome(settings: Settings, path: string, what: string): string {
  const raw = (path ?? "").trim();
  if (raw === "") {
    throw new Refused("invalid_path", `name the ${what}, relative to your home directory`);
  }
  if (isAbsolute(raw)) {
    throw new Refused(
      "invalid_path",
      `a ${what} is named relative to your home directory (for example data/prices.csv); got ` +
        `the absolute ${JSON.stringify(raw)}`,
    );
  }
  const home = realPath(homeDir(settings));
  const target = resolve(home, raw);
  if (!existsSync(target)) {
    throw new Refused(
      "invalid_path",
      `there is no file at ${JSON.stringify(raw)} in your home directory; write the ${what} ` +
        `before naming it`,
    );
  }
  const absolute = realPath(target);
  const rel = relative(home, absolute);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Refused(
      "invalid_path",
      `${JSON.stringify(raw)} resolves outside your home directory; a ${what} lives inside it`,
    );
  }
  if (!statSync(absolute).isFile()) {
    throw new Refused("invalid_path", `${JSON.stringify(raw)} is a directory, not a ${what}`);
  }
  return absolute;
}
