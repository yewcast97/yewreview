/**
 * Handing a file the agent wrote back to the person it wrote it for.
 *
 * The mirror image of `server/uploads.ts`, and deliberately the same shape. A file the reader drags
 * in lands in the agent's home and the message names it; a file the agent produces goes the other
 * way — it writes it under that same home, names it in its reply on a line of its own, and the
 * window turns that line into a link to this route. One directory answers both directions, which is
 * what keeps the arrangement small: there is no outbox, nothing is registered anywhere, no token is
 * minted, and the path in the sentence is the whole of the handover.
 *
 * **THE `attachment` DISPOSITION IS THE SECURITY HERE, AND IT MAY NEVER BE RELAXED TO `inline`.**
 * The agent authors arbitrary files, `.html` and `.svg` among them, and this route is on the origin
 * that also serves `/api/**` — so a document served inline would run its own scripts with the whole
 * archive in reach, which is exactly the boundary the published-report route buys back with a
 * `sandbox` CSP. A download has no such problem to solve: the bytes land in the reader's downloads
 * folder and nothing executes in this origin. `nosniff` rides along for the same reason it rides on
 * every asset, one rule for every file being one fewer rule to get wrong.
 *
 * CONTAINMENT IS THE WHOLE RULE, and there is deliberately no second one. Nothing here excludes
 * dotfiles, `.git`, or anything else that looks private, because there is nothing under the home to
 * be private FROM: it holds what the agent wrote and what the reader uploaded, the SDK's transcript
 * store lives elsewhere under `~/.claude`, the database and the engine are in other trees this
 * cannot reach, and the server binds loopback for the one person who owns both ends of the
 * conversation. A hidden-file exclusion would be a rule that hid the reader's own files from the
 * reader while stopping nothing, and its existence would suggest the containment check needed help.
 * It does not: what is inside the home is theirs, and what is outside it is unreachable.
 *
 * The order of operations is the one `reportsStatic.ts` argues for at length, for the same reason
 * and with the same consequence if it is disturbed: DECODE the remainder first, RESOLVE it through
 * the filesystem second, and only then ask whether what came back is still under the home. Spelling
 * checked before decoding passes `%2e%2e%2f`; spelling checked before resolving passes a symlink
 * pointing anywhere at all.
 *
 * Missing, outside the home, and unresolvable are one answer: 404. A 403 would confirm that
 * something is there, and 404 is also simply true — what this route serves is files under the home,
 * and a path naming anything else names no file this route has.
 */

import { realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import { CONTENT_TYPES } from "./reportsStatic.ts";
import type { Settings } from "../config.ts";
import { homeDir } from "../config.ts";

/**
 * The URL prefix a handed-back file is served under.
 *
 * Under `/api/` because it is part of the machinery the window drives rather than part of the
 * archive: `/reports/` is where published documents live for ever at their own addresses, and a
 * working file the agent wrote this afternoon is not one of those. The rest of the URL is the path
 * under the home, percent-encoded — so the line in the reply and the link in the window differ by
 * this prefix and nothing else.
 */
export const FILES_URL_PREFIX = "/api/files/";

/**
 * The absolute file an `/api/files/...` URL names, or null when it names nothing servable.
 *
 * Exported so the containment rule can be tested on the spellings a browser will not even send: a
 * URL parser rewrites `/api/files/../../db/yewreview.sqlite` before it reaches the wire, which would
 * otherwise leave the most important case here with no test at all.
 */
export function resolveHomeFile(settings: Settings, urlPath: string): string | null {
  if (!urlPath.startsWith(FILES_URL_PREFIX)) return null;

  let rest: string;
  try {
    rest = decodeURIComponent(urlPath.slice(FILES_URL_PREFIX.length));
  } catch {
    // A malformed escape is not a path anybody meant to type.
    return null;
  }
  if (rest === "" || rest.includes("\0")) return null;

  let root: string;
  try {
    root = realpathSync(homeDir(settings));
  } catch {
    // No home directory: there is nothing under it to hand back.
    return null;
  }

  let target: string;
  try {
    // realpath, not resolve: a lexical answer is satisfied by any symlink, and the agent writes in
    // this tree — so it is the one tree where a link out of it is something that can actually get
    // made — and only the real path can be compared against the real root.
    target = realpathSync(resolve(root, rest));
  } catch {
    return null;
  }

  const inside = relative(root, target);
  if (inside === "" || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) {
    return null;
  }
  return target;
}

/**
 * One file out of the agent's home, as a download.
 *
 * `Bun.file` rather than the bytes, so a large one streams: the agent writes CSVs the size of the
 * data it fetched, and reading one into memory to hand it over would make the size of a download a
 * property of this process rather than of the disk.
 *
 * Directories are a 404 like everything else — there is no listing to hand out, and a reader who
 * asked for one was following a link that pointed at a folder.
 */
export function serveHomeFile(settings: Settings, urlPath: string): Response {
  const file = resolveHomeFile(settings, urlPath);
  if (file === null || statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
    return new Response(JSON.stringify({ error: "not_found", message: `no file at ${urlPath}` }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return new Response(Bun.file(file), {
    headers: {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-disposition": disposition(basename(file)),
      "x-content-type-options": "nosniff",
      // The agent rewrites its own outputs in place — a second pass over `outputs/report.md` under
      // the name the reply already named — so a cached copy would hand back the draft before the
      // correction, from a URL whose bytes had genuinely changed.
      "cache-control": "no-cache",
    },
  });
}

/** Everything a filename may not carry into a quoted `filename=`: anything outside printable ASCII,
 * and the two characters that would end the quoting early. */
const NOT_PLAIN_ASCII = /[^\u0020-\u007e]|["\\]/g;

/**
 * The disposition header, saying the name twice.
 *
 * `filename=` is a quoted string of bytes, which is a promise no unicode name can keep — so it
 * carries a flattened spelling with everything outside printable ASCII replaced, and RFC 5987's
 * `filename*=` carries the real one. A browser that understands the starred form prefers it and the
 * reader gets `財報.csv`; one that does not gets `__.csv`, which is a file they can still find.
 * Sending only the starred form would leave the older reader with no name at all.
 *
 * The name being flattened is a BASENAME off the resolved path rather than anything from the URL, so
 * a quote or a newline in it would have had to be a quote or a newline in a real filename on disk;
 * the substitution is what makes that a name rather than a way to write a second header.
 */
function disposition(name: string): string {
  const plain = name.replace(NOT_PLAIN_ASCII, "_");
  return `attachment; filename="${plain}"; filename*=UTF-8''${extended(name)}`;
}

/**
 * A filename as RFC 5987 spells it.
 *
 * `encodeURIComponent` gets almost all of the way there and leaves four characters behind — `'`,
 * `(`, `)` and `*` — which are legal in a URI component and are not `attr-char`, so they are escaped
 * on top of it rather than left for a header parser to disagree about.
 */
function extended(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
