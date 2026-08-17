/**
 * Serving the furniture a published document loads — `var/reports/assets/**` and nothing else, ever.
 *
 * **A published report is a row.** Its HTML lives in the `report` table and reaches a reader
 * straight out of the database, by id, on a route the router answers itself. So nothing here turns a
 * report's stored path into bytes off a disk that has to be kept in step with the table, and there
 * is no sweep making the two agree. What lives under `reports/assets/` is the handful of things that
 * genuinely ARE files: the chart library a document loads rather than inlines, and whatever other
 * shared furniture goes with it. This module serves those, and nothing else is reachable through it.
 *
 * It is the ONE route that turns a URL into a filesystem path, so it is the one route where a
 * mistake hands out the database. The order of operations is the whole defence: DECODE the
 * path first, RESOLVE it through the filesystem second, and only then ask whether the result is
 * still under the assets root. Checking the spelling before decoding would pass `%2e%2e%2f`;
 * checking it before resolving would pass a symlink pointing anywhere at all.
 *
 * Anything that fails any of those is a 404 rather than a 403. A "forbidden" answer confirms what
 * is there, and the reader who typed it has no business knowing either way.
 *
 * `X-Content-Type-Options: nosniff` goes on EVERY response, not just the HTML-ish ones. The risk
 * here runs the other way round: a `.csv` sidecar sniffed as HTML would execute in the same origin
 * as every published document. One rule for every file is one fewer rule to get wrong.
 */

import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import type { Settings } from "../config.ts";
import { paths } from "../config.ts";

/**
 * The URL prefix the assets tree is served under. It matches `reports/assets/` by name, so an
 * asset's place on disk is its URL with a slash in front.
 *
 * It sits UNDER `/reports/`, where the router serves documents by id, and the two cannot collide:
 * a document's URL is one segment, `assets` is a segment no id can be spelled as, and this prefix
 * is tested first. A published report linking `assets/chart.js` beside itself therefore resolves
 * exactly the way its author wrote it.
 */
export const ASSETS_URL_PREFIX = "/reports/assets/";

/**
 * What an extension means, for every route in this server that turns a file into a response.
 *
 * Exported because `homeFiles.ts` asks the identical question of a file the agent wrote, and a
 * second map would drift the first time either learned about an extension the other did not: the
 * day a `.parquet` arrived as itself from one route and as anonymous bytes from the other is a day
 * somebody spends finding out why. What is NOT shared is what each route does with the answer — an
 * asset is served inline because a published document is loading it, a home file is always an
 * attachment, and that module's header says why the difference is load-bearing rather than a taste.
 */
export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
};

/**
 * The absolute file a `/reports/assets/...` URL names, or null when it names nothing servable.
 *
 * Exported so the containment rule can be tested directly on the spellings a browser will not even
 * send: a URL parser rewrites `/reports/assets/../../db/yewreview.sqlite` before it reaches the
 * wire, which would otherwise make the most important case here untestable over HTTP.
 */
export function resolveAssetFile(settings: Settings, urlPath: string): string | null {
  if (!urlPath.startsWith(ASSETS_URL_PREFIX)) return null;

  let rest: string;
  try {
    rest = decodeURIComponent(urlPath.slice(ASSETS_URL_PREFIX.length));
  } catch {
    // A malformed escape is not a path anybody meant to type.
    return null;
  }
  if (rest === "" || rest.includes("\0")) return null;

  let root: string;
  try {
    root = realpathSync(paths(settings).reportAssetsDir);
  } catch {
    // No assets directory yet: nothing under it can be served.
    return null;
  }

  let target: string;
  try {
    // realpath, not resolve: a lexical answer is satisfied by any symlink, and only the real one
    // can be compared against the real root.
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

/** One asset, or a 404. Directories are 404 too — there is no index to hand out. */
export function serveAsset(settings: Settings, urlPath: string): Response {
  const file = resolveAssetFile(settings, urlPath);
  if (file === null || statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
    return new Response(
      JSON.stringify({ error: "not_found", message: `no report asset at ${urlPath}` }),
      { status: 404, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
  return new Response(Bun.file(file), {
    headers: {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      // An asset is furniture rather than a publication: the chart library is REPLACED in place when
      // it is upgraded, under the name every published document already links. A cached copy would
      // draw last month's charts inside a report served fresh from the database this second.
      "cache-control": "no-cache",
    },
  });
}
