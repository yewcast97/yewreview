/**
 * Files the reader drags into the conversation.
 *
 * THE BYTES GO TO DISK AND THE MESSAGE CARRIES A PATH. The alternative was to put the file on the
 * wire as a content block inside the user's turn, and it loses on every axis that matters here: the
 * chat socket refuses a frame over a megabyte (`server/chat.ts`), the SDK's transcript keeps only
 * the text of a user message so an attached image would vanish on the next reload, and a content
 * block may only be an image or a PDF while a reader with a CSV has every reason to expect it to
 * work. A path costs one line of text, survives the round trip, and the agent already has `Read`.
 *
 * THE HOME DIRECTORY IS THE RIGHT PLACE and not merely a convenient one. It is the session's working
 * directory, it is inside the sandbox's writable tree, and it is the directory every other
 * path-taking tool resolves against — so a dropped file is reachable by exactly the sentence the
 * agent would use for a file it wrote itself. Nothing new had to be opened up for this.
 *
 * ONE FRESH DIRECTORY PER UPLOAD, named with hex, and the reader's own filename inside it. Two
 * things fall out of that arrangement and both were wanted. Nothing is ever overwritten, so dropping
 * `data.csv` twice is two files rather than a silent replacement of the first. And the NAME survives
 * intact — extension and all — which is not cosmetic: the extension is what makes `Read` hand a png
 * back as an image and a pdf as a document, and a file renamed to a hex string arrives as unreadable
 * bytes.
 *
 * THE FILES ARE NEVER CLEANED UP, deliberately. The home directory is the reader's to look in, a
 * resumed conversation still holds the path in its transcript and may want to read it again, and a
 * sweep that deleted "old" uploads would break exactly those conversations. An upload is a file
 * somebody put in a directory; it is not a record, it is in no table, and nothing here pretends to
 * own its lifetime.
 */

import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Settings } from "../config.ts";
import { homeDir } from "../config.ts";
import { Refused } from "../db/models.ts";
import { newId } from "../db/tx.ts";

/**
 * The largest file this will take, in bytes.
 *
 * Generous rather than tight, because the thing being protected is disk in the reader's own home
 * directory rather than a shared service, and the cost of guessing low is a refusal for a legitimate
 * spreadsheet. What the cap actually prevents is an accidental drop of something enormous — a disk
 * image, a video — filling the volume before anybody notices it is uploading.
 */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** The directory under the home that every upload lands in, and the first segment of every path
 * this module hands back. */
const UPLOAD_DIR = "uploads";

/** How long a stored filename may be. Comfortably longer than anything a person types and well
 * inside every filesystem's own limit, which is the only thing this is protecting against. */
const MAX_NAME = 128;

/** The C0 range and DEL, written as escapes so this file holds no literal control character of its
 * own. A newline or a tab in a filename is a name that lies about itself in every listing that ever
 * prints it. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * The reader's filename, reduced to something safe to create.
 *
 * A BASENAME ACROSS BOTH SEPARATORS. The browser sends whatever the OS called the file, and while
 * `dataTransfer` does not hand over a full path today, this is the one function standing between a
 * remote-controlled string and `resolve()` — so it takes the last segment after either slash rather
 * than trusting that there is none. `..` therefore cannot survive as a segment: it is either the
 * whole name, which is refused below, or it is not the last segment and is dropped.
 *
 * Control characters go because a newline in a filename is a filename that lies about itself in
 * every listing that ever prints it. The three names with no content — empty, `.`, `..` — are
 * refused rather than replaced with something invented, because a reader who somehow dropped one is
 * better told than quietly given a file called `file`.
 *
 * The length cap keeps the EXTENSION, which is the part with a job to do — see this file's header on
 * why `Read` cares — and truncates the stem in front of it.
 */
export function sanitizeUploadName(raw: string): string {
  const base = raw.split("/").pop()?.split("\\").pop() ?? "";
  const clean = base.replace(CONTROL_CHARS, "").trim();
  if (clean === "" || clean === "." || clean === "..") {
    throw new Refused("invalid_request", "that file arrived without a usable name");
  }
  if (clean.length <= MAX_NAME) return clean;
  const dot = clean.lastIndexOf(".");
  // A dot at the very front is a leading dot, not an extension, so there is nothing to preserve.
  const ext = dot > 0 ? clean.slice(dot) : "";
  return clean.slice(0, Math.max(1, MAX_NAME - ext.length)) + ext;
}

/**
 * Write one dropped file into the home directory, and answer with the path the message will name.
 *
 * The returned path is HOME-RELATIVE and spelled with forward slashes by construction rather than by
 * `path.join`: it is going into a sentence the agent reads and then hands to `Read`, which resolves
 * it against the same home, so the separator has to be the one both ends agree on regardless of the
 * platform underneath.
 *
 * The containment check at the end can only fail if `sanitizeUploadName` has a hole in it, which is
 * the reason to keep it: it is one `resolve` against the directory that was just created, and it
 * turns "the sanitiser was wrong" from a file written somewhere else into a refusal.
 */
export async function storeUpload(
  settings: Settings,
  filename: string,
  bytes: ArrayBuffer,
): Promise<string> {
  const name = sanitizeUploadName(filename);
  const home = homeDir(settings);
  // Eight hex characters out of the same id mint the rest of the schema uses. A whole uuid would
  // read as a record id in a directory listing, and this is not one.
  const slot = newId().slice(0, 8);
  const dir = resolve(home, UPLOAD_DIR, slot);
  const target = resolve(dir, name);
  const rel = relative(home, target);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Refused("invalid_request", "that file arrived without a usable name");
  }
  await mkdir(dir, { recursive: true });
  await Bun.write(target, bytes);
  return `${UPLOAD_DIR}/${slot}/${name}`;
}
