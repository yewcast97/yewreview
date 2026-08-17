/**
 * Information sources: the address book of where numbers come from, and how far to trust each one.
 *
 * There are no preset rows and no vendor clients. Every row here was written down during a
 * conversation, which is why `method` is prose rather than a code path — it is instructions to
 * somebody's future self about which page, which link, which form.
 *
 * A ROW HERE IS A STANDING CLAIM, not a note made in passing. The address book is the account of
 * what this installation treats as a source and how far each one sits from the fact, and every
 * report ever published leans on it. It belongs to the person whose reports they are — which used to
 * mean they typed it into a form, and now means they say what goes in it and the row is written from
 * here once they have. The interview is the work: go to the place, read what it actually publishes,
 * render the row as a row block in the conversation, and record it when they agree to it.
 *
 * READING IS STILL MOST OF WHAT THESE TOOLS ARE FOR. `list_information_sources` and `search_sources`
 * are how the agent finds out whether a place is already recorded, and the rule they serve is
 * absolute: USE NOTHING FROM A PLACE THAT IS NOT RECORDED. A draft in the conversation is not a
 * recorded source — the row exists when `create_information_source` has succeeded and not before.
 *
 * `hosts` is ADVISORY, and it used to have teeth. A row says which hostnames a source publishes at,
 * and publishing once refused a citation whose url was not on the named source's list. That check
 * went with the citations themselves: what it proved was that a report was internally consistent
 * about who said what, which is a much smaller claim than the rows implied, and nothing ever
 * checked either half against the world. What the field is now is the reader's own note of where a
 * source publishes — worth writing down, worth reading while working, and enforced nowhere.
 *
 * `type` IS EDITABLE ON A STANDING ROW, and the consequence is a sentence to say out loud rather
 * than a refusal: reclassifying a row silently re-weighs every report that drew on it. Freezing it
 * at creation would only mean deleting a row and dictating six fields again to correct a misfiling.
 * What keeps the change honest is that the user has to ask for it and the agent has to say back what
 * it is about to do.
 *
 * FAILURES ARE APPENDED, NEVER REPLACED: a failure that happened stays true for ever, so
 * `failure_cases` only ever grows, a dated line at a time. A patch carries the WHOLE field, so
 * appending means sending what is there plus the new line — read the row first.
 */

import { z } from "zod";

import { SOURCE_TYPES } from "../db/models.ts";
import { Refused } from "../db/models.ts";
import {
  createSource,
  deleteSource,
  getSource,
  listSources,
  searchSources,
  updateSource,
} from "../repo/sources.ts";
import type { SourcePatch } from "../repo/sources.ts";
import type { ToolDeps } from "../protocol/types.ts";
import { ok } from "../protocol/types.ts";
import { attempt, count, CONSENT, ref, refDoc, unconfirmed } from "./common.ts";
import { defineTool } from "./def.ts";

const HOSTS_DOC =
  "Bare hostnames this source publishes at, at least one — 'www.sec.gov', not 'https://www.sec.gov/" +
  "edgar'. No scheme, no path, no port, no wildcard; a subdomain of a listed host already matches. " +
  "A patch REPLACES the whole list, so send every host you want the row to end up with.";

const AUTH_ENV_DOC =
  "The NAME of an environment variable holding the credential, never the value — 'EXAMPLE_API_KEY'. " +
  "A database that holds secrets is a database that leaks them. Blank clears it.";

export function build(deps: ToolDeps) {
  const { db } = deps;

  const listSourcesTool = defineTool(
    "list_information_sources",
    "The recorded sources, optionally narrowed to one type, each with the hostnames it publishes " +
      "at. Read it before recording a new entry: the same site filed twice under two spellings is " +
      "two half-records of one place — and before citing an address, because the source you cite " +
      "has to be the one whose hosts that address is on.",
    { type: z.enum(SOURCE_TYPES).optional() },
    async (args) =>
      attempt(() => {
        const rows = listSources(db, { type: args.type });
        return ok(`${count(rows.length, "source")}.`, { sources: rows });
      }),
    { readOnly: true },
  );

  const searchSourcesTool = defineTool(
    "search_sources",
    "Search the address book by site, domain, method or recorded failures — the browse to do " +
      "before recording a duplicate. Hosts are deliberately not searched: they hold JSON, and " +
      "'which source publishes at this host' has an exact answer rather than a substring one.",
    { q: z.string() },
    async (args) =>
      attempt(() => {
        const rows = searchSources(db, args.q);
        return ok(`${count(rows.length, "source")}.`, { sources: rows });
      }),
    { readOnly: true },
  );

  const createSourceTool = defineTool(
    "create_information_source",
    "Record a place this installation is allowed to take numbers from, and how far it sits from " +
      "the fact. Do the looking FIRST: go to the site, find the page the numbers are actually on, " +
      "and write the method as instructions somebody could follow next year. " +
      CONSENT +
      " Search first — the same site filed twice under two spellings is two half-records of one " +
      "place, and a second entry for a recorded site is refused.",
    {
      source: z
        .string()
        .describe(
          "What the place is called, as somebody would say it — 'SEC EDGAR', 'TSMC investor " +
            "relations'. Unique: one row per place.",
        ),
      type: z
        .enum(SOURCE_TYPES)
        .describe(
          "How far this source sits from the fact. issuer_primary is the company's own filing; " +
            "regulatory_government is a regulator's; trusted_data_vendor is a vendor's " +
            "redistribution; sellside_research and buyside_public_disclosure are interested " +
            "parties; independent_research is everything else. Everything written while trusting " +
            "this row is weighed against this field, so it is the one to be careful about.",
        ),
      domain: z.string().describe("What this source is good FOR, in one line."),
      method: z
        .string()
        .describe(
          "How to actually get the numbers: which page, which link, which form, which quirks. " +
            "Prose, for a person to follow — not a code path.",
        ),
      hosts: z.array(z.string()).describe(HOSTS_DOC),
      failure_cases: z
        .string()
        .optional()
        .describe("What this source is known to get wrong or omit, if anything is known yet."),
      auth_env: z.string().optional().describe(AUTH_ENV_DOC),
    },
    async (args) =>
      attempt(() => {
        const source = createSource(db, {
          source: args.source,
          type: args.type,
          domain: args.domain,
          method: args.method,
          hosts: args.hosts,
          failureCases: args.failure_cases,
          authEnv: args.auth_env,
        });
        // The stored row rather than the arguments, because `hosts` is normalised on the way in and
        // what matters afterwards is what the database actually holds.
        return ok(`Recorded ${source.name}.`, { source });
      }),
  );

  const updateSourceTool = defineTool(
    "update_information_source",
    "Correct or add to a recorded source. A field left out is left ALONE, so send only what is " +
      "changing. " +
      CONSENT +
      " Two fields need care. `hosts` replaces the whole list rather than adding to it — read the " +
      "row and send every host you want it to end up with, because a company that moved its filings " +
      "needs the old address gone. `type` re-weighs every report that ever drew on this source, so " +
      "say that out loud before you change it.",
    {
      source_id: z.string().describe(refDoc("information_source", "list_information_sources")),
      source: z.string().optional(),
      type: z.enum(SOURCE_TYPES).optional(),
      domain: z.string().optional(),
      method: z.string().optional(),
      hosts: z.array(z.string()).optional().describe(HOSTS_DOC),
      failure_cases: z
        .string()
        .optional()
        .describe(
          "What this source is known to get wrong. Append rather than replace: read the row first " +
            "and send what is there plus the new dated line. Blank clears it.",
        ),
      auth_env: z.string().optional().describe(AUTH_ENV_DOC),
    },
    async (args) =>
      attempt(() => {
        const id = ref(db, "information_source", args.source_id);
        // Assembled key by key rather than spread, because `exactOptionalPropertyTypes` and the
        // repository agree on one thing that matters here: a key PRESENT and undefined is not the
        // same as absent, and absent is what means "leave this alone".
        const patch: SourcePatch = {};
        if (args.source !== undefined) patch.source = args.source;
        if (args.type !== undefined) patch.type = args.type;
        if (args.domain !== undefined) patch.domain = args.domain;
        if (args.method !== undefined) patch.method = args.method;
        if (args.hosts !== undefined) patch.hosts = args.hosts;
        if (args.failure_cases !== undefined) patch.failureCases = args.failure_cases;
        if (args.auth_env !== undefined) patch.authEnv = args.auth_env;
        const source = updateSource(db, id, patch);
        return ok(`Updated ${source.name}.`, { source });
      }),
  );

  const deleteSourceTool = defineTool(
    "delete_information_source",
    "Remove a source from the address book. Nothing in the archive points at one — a report does " +
      "not name the sources it drew on — so this always succeeds and the deletion log is the " +
      "only witness. Which is exactly why it needs asking about first: say what the row is and " +
      "that nothing will notice it is gone. A source that has gone WRONG is not a source to " +
      "delete; record the failure on it instead, so the next person to reach for it is warned.",
    {
      source_id: z.string().describe(refDoc("information_source", "list_information_sources")),
      confirm: z.boolean().describe("Must be true."),
    },
    async (args) =>
      attempt(() => {
        const refusal = unconfirmed(args.confirm, "a source from the address book");
        if (refusal) return refusal;
        const id = ref(db, "information_source", args.source_id);
        const row = getSource(db, id);
        if (row === null) throw new Refused("not_found", `no information source ${args.source_id}`);
        deleteSource(db, id);
        return ok(`Removed ${row.name}.`, { deleted: true });
      }),
  );

  return [
    listSourcesTool,
    searchSourcesTool,
    createSourceTool,
    updateSourceTool,
    deleteSourceTool,
  ];
}
