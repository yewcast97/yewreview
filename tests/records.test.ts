/**
 * The record browser, against a real database.
 *
 * The first two tests are the point of the file. `src/repo/records.ts` carries a hand-written copy
 * of every foreign key in the schema, and a hand-written copy of anything is a lie waiting for the
 * next change — so the map is compared against `pragma foreign_key_list` in BOTH directions: an
 * edge the database does not have is a browser drawing provenance that is not there, and a key the
 * map does not have is a browser silently hiding it. Either way this file fails the day somebody
 * edits `schema.ts` and stops there.
 *
 * The tables the pragma is asked about come from `sqlite_master`, not from a list in the source.
 * Reading them out of `schema.ts` would have compared one hand-written list against another and
 * been blind to exactly the change the lock is for: a new table, with new keys, added to the DDL
 * and to nothing else.
 *
 * Everything else is exercised through the repository rather than through SQL, because the
 * questions worth getting wrong — does a keyset page survive a row inserted mid-walk, does a
 * report's detail hand back the document it is supposed to be withholding, does a thesis's standing
 * come off its ledger when no column holds it, does an edge with nothing at the far end still come
 * back as a group the browser can draw — are properties of those functions.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { Refused, type ScriptStatus } from "../src/db/models.ts";
import { newId, nowMs } from "../src/db/tx.ts";
import { createScript, setScriptStatus } from "../src/repo/scripts.ts";
import {
  FOREIGN_KEYS,
  ID_COLUMNS,
  JUNCTION_TABLES,
  LOG_TABLES,
  MAX_GROUP,
  RECORD_TABLES,
  REFERENTS,
  REFERRERS,
  getRecord,
  listReferrers,
  listTable,
} from "../src/repo/records.ts";
import {
  harness,
  seedAssessment,
  seedScriptRun,
  seedSeikanRun,
  seedShellRun,
  seedSource,
  seedTarget,
  seedThesis,
  type Harness,
} from "./helpers.ts";

let h: Harness;
afterEach(() => h?.cleanup());

// -- seeds ----------------------------------------------------------------------------------------
//
// Rows are written directly wherever the repository that owns them would demand a whole publication
// or a real measurement to get one row on disk. This file is about what points at what, so an
// invocation is written without a generation run behind it and an assessment without an engine to
// have produced its report — the schema's CHECKs are the whole of what those columns have to
// satisfy here, and more than the browser ever reads.
//
// A script is the exception and goes through `createScript`: its program is a column, uniqueness
// among active scripts is global, and both are rules a fixture has no business going around.
//
// Every one of these tables opens with `name`, so every INSERT writes one. A recipe's is the human
// string the caller passed, because other tables' labels EMBED it — a report reads `under Semis` —
// and a report or a preparation gets a generated one, because nothing reads those and they only
// have to be unique.

/** A report specification. Its `content` is what a reader sees as the label, so the caller supplies
 * it wherever a test is about what the browser draws; `at` is exposed because ordering is. */
function seedRecipe(
  db: Database,
  name: string,
  at = nowMs(),
  content = "Write a report.",
): string {
  const id = newId();
  db.query(
    "INSERT INTO recipe (name, id, content, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
  ).run(name, id, content, at, at);
  return id;
}

/** The same, retired. Written active and moved, because `recipe_is_not_born_inactive` says a recipe
 * is never stored that way and a fixture has no business going around it. */
function seedRetiredRecipe(db: Database, name: string, content = "Write a report."): string {
  const id = seedRecipe(db, name, nowMs(), content);
  db.query("UPDATE recipe SET status = 'inactive', updated_at = ? WHERE id = ?").run(nowMs(), id);
  return id;
}

/** The document a seeded report holds. Real HTML rather than a placeholder, because its LENGTH is
 * the one thing a detail response is allowed to say about it. */
function reportHtml(title: string): string {
  return `<article><h1>${title}</h1><p id="c1">it goes up</p></article>`;
}

function seedReport(db: Database, recipeId: string, title: string, at = nowMs()): string {
  const id = newId();
  db.query(
    "INSERT INTO report (name, id, recipe_id, title, content, created_at) VALUES ('rpt-' || lower(hex(randomblob(5))), ?, ?, ?, ?, ?)",
  ).run(id, recipeId, title, reportHtml(title), at);
  return id;
}

/** A stored script. No recipe is named because a script belongs to the installation — and the
 * program is spun out of the name because uniqueness among active scripts is over the source
 * itself, so two fixtures saving the same bytes would collide across the whole database. */
function seedScript(db: Database, name: string, status: ScriptStatus = "active"): string {
  const script = createScript(db, { name, domain: "prices", source: `print("${name}")` });
  // Reached the way real code reaches it: nothing is born inactive.
  if (status !== "active") setScriptStatus(db, script.id, status);
  return script.id;
}

/** What produced one of an assessment's inputs: the script, and what it was told. `''` is an honest
 * argument — it means the run took none. */
function seedPreparation(
  db: Database,
  assessmentId: string,
  scriptId: string,
  argument = "",
  at = nowMs(),
): string {
  const id = newId();
  db.query(
    `INSERT INTO series_preparation (name, id, thesis_assessment_id, script_id, argument, created_at)
     VALUES ('prep-' || lower(hex(randomblob(5))), ?, ?, ?, ?, ?)`,
  ).run(id, assessmentId, scriptId, argument, at);
  return id;
}

// What a report RAN comes from `helpers.ts`: `seedScriptRun` for a run of a stored script,
// `seedSeikanRun` for a measurement, and `seedShellRun` for everything else the shell was asked to
// do. They are the three kinds of command the schema records and nothing here needs a second
// spelling of any of those INSERTs.

function measure(db: Database, thesisId: string, ticker: string): void {
  db.query("INSERT INTO regime (thesis_id, ticker) VALUES (?, ?)").run(thesisId, ticker);
}

/** What a refusal said, so a test can assert on the sentence the user would read. */
function refusal(fn: () => unknown): Refused {
  try {
    fn();
  } catch (err) {
    if (err instanceof Refused) return err;
    throw err;
  }
  throw new Error("expected a refusal, got a result");
}

// -- the honesty lock -----------------------------------------------------------------------------

/** `table.column -> parent(column) ON DELETE action`, the one spelling both sides of the lock use.
 * The parent COLUMN is in it because every join in `records.ts` assumes the key points at the
 * column the browser addresses by: repointed at a different unique column of the same table, the
 * edge would still be a key to that table and the join would be nonsense. SQLite lets the parent
 * column be left implicit; `schema.ts` never does, and a key that started to would fail here rather
 * than be guessed at. */
function edgeText(table: string, column: string, to: string, toColumn: string, onDelete: string) {
  return `${table}.${column} -> ${to}(${toColumn}) ON DELETE ${onDelete}`;
}

type PragmaKey = { table: string; from: string; to: string; on_delete: string; on_update: string };

/** Every table the open file actually has — asked of the database, so a table added to `schema.ts`
 * and to nothing else is inside the lock rather than outside it. */
function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

/** Every foreign key the open file holds, table by table. */
function schemaKeys(db: Database): { table: string; key: PragmaKey }[] {
  return tableNames(db).flatMap((table) =>
    db
      .query<PragmaKey, []>(`PRAGMA foreign_key_list(${table})`)
      .all()
      .map((key) => ({ table, key })),
  );
}

function schemaEdges(db: Database): string[] {
  return schemaKeys(db)
    .map(({ table, key }) => edgeText(table, key.from, key.table, key.to, key.on_delete))
    .sort();
}

function mappedEdges(): string[] {
  return FOREIGN_KEYS.map((fk) =>
    edgeText(fk.from, fk.column, fk.to, ID_COLUMNS[fk.to], fk.onDelete),
  ).sort();
}

describe("the foreign-key map", () => {
  test("every edge it claims is a key the database actually has", () => {
    h = harness();
    const actual = schemaEdges(h.db);
    for (const edge of mappedEdges()) expect(actual).toContain(edge);
  });

  test("every key the database has is in it — this is what fails when schema.ts changes", () => {
    h = harness();
    const mapped = mappedEdges();
    for (const edge of schemaEdges(h.db)) expect(mapped).toContain(edge);
    expect(mapped.length).toBe(schemaEdges(h.db).length);
    // The count is spelled out as well as compared: an edge deleted from the schema and from the
    // map in one edit agrees with itself perfectly, and this is the line that notices.
    expect(mapped.length).toBe(10);
    // The one CASCADE worth a sentence, because it is the one that does not behave like one. An
    // invocation dies with its report, and it is declared CASCADE towards the SCRIPT as well — yet
    // a standing report still blocks deleting that script: the cascade fires the schema's
    // `script_invocations_leave_only_with_their_report` trigger, the trigger finds the report still
    // there and aborts, and the script's deletion goes down with it. The map states the action the
    // pragma reports, because that is the only thing this lock can compare; what actually happens
    // is the schema's business, and has a test of its own further down.
    expect(mapped).toContain("script_invocation.script_id -> script(id) ON DELETE CASCADE");
  });

  test("the records, the junctions and the logs are exactly the schema's tables", () => {
    h = harness();
    // Three lists, and every table in the file is in exactly one of them. A table added to the
    // schema and to none of them fails here, which is the point: the decision a new table forces —
    // is this something the browser addresses, an edge between two things it addresses, or neither —
    // is one somebody has to make in writing rather than by default.
    expect(tableNames(h.db)).toEqual([...RECORD_TABLES, ...JUNCTION_TABLES, ...LOG_TABLES].sort());
    expect(RECORD_TABLES.length).toBe(11);
    expect(tableNames(h.db).length).toBe(14);
  });

  test("the log tables appear in no foreign key, on either side", () => {
    // Both directions are asserted because they fail differently. A key OUT of a log would tie a
    // deletion row to a record that is, by construction, gone — the row exists to outlive its
    // subject. A key INTO one would put a log in the graph the browser walks: `referrerEdges` and
    // `referentEdges` are derived from `FOREIGN_KEYS`, so a table in no key is in no edge, and that
    // is the whole mechanism keeping these two out without any code here excluding them by name.
    h = harness();
    for (const { table, key } of schemaKeys(h.db)) {
      expect(LOG_TABLES as readonly string[]).not.toContain(table);
      expect(LOG_TABLES as readonly string[]).not.toContain(key.table);
    }
  });

  test("no key updates its dependents, which is why the map has no column for it", () => {
    // Nothing here is addressed by a column that can be rewritten in place — a uuid, a ticker, a
    // transcript number — so an ON UPDATE action would be a rule the browser has never heard of.
    h = harness();
    for (const { table, key } of schemaKeys(h.db)) {
      expect(`${table}.${key.from} ON UPDATE ${key.on_update}`).toBe(
        `${table}.${key.from} ON UPDATE NO ACTION`,
      );
    }
  });

  test("no two tables are joined twice, which is what lets a table name an edge", () => {
    for (const table of RECORD_TABLES) {
      for (const side of [REFERRERS[table], REFERENTS[table]]) {
        const tables = side.map((edge) => edge.table);
        expect(tables.length).toBe(new Set(tables).size);
      }
    }
  });

  test("every junction is drawn exactly twice, on the side that declared it and the other", () => {
    // A thesis declares the targets in its regime; the target is what gets pointed at. The same
    // list appearing under both sides of either record would put the declaring in the wrong place
    // on one of them. Every junction is walked rather than the one a reader thinks of first: a
    // junction nobody names here is one that could lose its edge entirely and say nothing.
    for (const junction of JUNCTION_TABLES) {
      const keys = FOREIGN_KEYS.filter((fk) => fk.from === junction);
      const owner = keys.find((fk) => fk.onDelete === "CASCADE");
      const object = keys.find((fk) => fk !== owner);
      if (!owner || !object) throw new Error(`${junction} has no declaring end in the map`);

      const via = (edges: { via?: string; table: string }[]) =>
        edges.filter((edge) => edge.via === junction);
      expect(via(REFERENTS[owner.to]).map((e) => e.table)).toEqual([object.to]);
      expect(via(REFERRERS[object.to]).map((e) => e.table)).toEqual([owner.to]);
      expect(via(REFERRERS[owner.to])).toEqual([]);
      expect(via(REFERENTS[object.to])).toEqual([]);

      // And nowhere else: two ends is the whole of a link row.
      const drawn = RECORD_TABLES.flatMap((table) => [...REFERRERS[table], ...REFERENTS[table]]);
      expect(drawn.filter((e) => e.via === junction).length).toBe(2);
    }

    // Spelled out for the only junction left, because the loop above would be just as happy with
    // the wrong pair of tables and with the two ends the wrong way round. `regime` joins a THESIS
    // to the targets it measures, and the thesis is the declaring end: the regime is part of what
    // the thesis says, it dies with the thesis, and the ticker is what may not be deleted while
    // some thesis still names it. Drawn the other way round, a target would appear to have declared
    // the theses about it.
    expect(REFERENTS["thesis"].filter((e) => e.via === "regime").map((e) => e.table)).toEqual([
      "target",
    ]);
    expect(REFERRERS["target"].filter((e) => e.via === "regime").map((e) => e.table)).toEqual([
      "thesis",
    ]);
    expect(REFERRERS["thesis"].some((e) => e.via === "regime")).toBe(false);
    expect(REFERENTS["target"].some((e) => e.via === "regime")).toBe(false);
  });
});

// -- listing one table ----------------------------------------------------------------------------

describe("listing a table", () => {
  test("a table is the whole database's, and is never sliced by recipe", () => {
    h = harness();
    const mine = seedRecipe(h.db, "Mine");
    const theirs = seedRecipe(h.db, "Theirs");
    seedReport(h.db, mine, "Mine");
    seedReport(h.db, theirs, "Theirs");

    // A report is reached through the recipe that specified it, and a command through the report it
    // ran for, which is the provenance chain this browser exists to make walkable. A recipe-shaped
    // slice of a table would be a flat dump wearing a graph's clothes, so there is nothing to ask
    // for: the table answers with the table.
    expect(listTable(h.db, "report").records.map((r) => r.label).sort()).toEqual([
      "Mine",
      "Theirs",
    ]);
    expect(listTable(h.db, "recipe").records.length).toBe(2);
  });

  test("a ledger listed whole says which thesis each round judged", () => {
    h = harness();
    const revenue = seedThesis(h.db, "revenue accelerates");
    const margins = seedThesis(h.db, "margins hold");
    seedAssessment(h.db, revenue, "insightful", 1_000);
    seedAssessment(h.db, margins, "approven", 2_000);

    // A whole-table listing of `thesis_assessment` is every round of judgement anybody has ever
    // recorded, in the order they were recorded. On their own those rows are three words and a
    // timestamp, so the spec joins the thesis to put its name in the sublabel — which is the only
    // thing telling two 'approven's apart when the table is read end to end rather than from the
    // thesis they hang off.
    expect(
      listTable(h.db, "thesis_assessment").records.map((r) => ({
        label: r.label,
        sublabel: r.sublabel,
      })),
    ).toEqual([
      { label: "approven · Measured once and it held.", sublabel: "of margins hold" },
      { label: "insightful · Measured once and it held.", sublabel: "of revenue accelerates" },
    ]);
  });

  test("an unknown table names the whitelist; a junction says it is an edge", () => {
    h = harness();
    // A table that really is in the file and is still not a record — the whitelist is a whitelist,
    // not a check that the name resolves.
    const unknown = refusal(() => listTable(h.db, "sqlite_master"));
    expect(unknown.kind).toBe("not_found");
    expect(unknown.message).toContain("information_source");

    const junction = refusal(() => getRecord(h.db, "regime", newId()));
    expect(junction.kind).toBe("not_found");
    expect(junction.message).toContain("via regime");
    for (const table of JUNCTION_TABLES) {
      expect(refusal(() => listTable(h.db, table)).kind).toBe("not_found");
    }
  });

  test("limit is bounded at both ends", () => {
    h = harness();
    for (const name of ["Semis", "Elsewhere"]) seedRecipe(h.db, name);
    // Two rows, so a limit of one is a limit that bit rather than a table that was short.
    const one = listTable(h.db, "recipe", { limit: 1 });
    expect(one.records.length).toBe(1);
    expect(one.hasMore).toBe(true);
    // The ceiling is a number you may ask for, not one past it.
    expect(listTable(h.db, "recipe", { limit: MAX_GROUP }).records.length).toBe(2);
    for (const limit of [0, -1, MAX_GROUP + 1, 1.5]) {
      expect(refusal(() => listTable(h.db, "recipe", { limit })).kind).toBe("invalid_request");
    }
  });
});

// -- paging ---------------------------------------------------------------------------------------

describe("keyset paging", () => {
  test("a row inserted mid-walk does not push a page back over one already read", () => {
    h = harness();
    const recipe = seedRecipe(h.db, "Semis");
    const at = nowMs();
    const written: string[] = [];
    for (const n of [0, 1, 2, 3, 4]) {
      written.push(seedReport(h.db, recipe, `R${n}`, at + n));
    }

    const first = listTable(h.db, "report", { limit: 2 });
    expect(first.records.map((r) => r.id)).toEqual([written[4]!, written[3]!]);
    expect(first.hasMore).toBe(true);

    // The agent publishes while the panel is open. An OFFSET page would now hand back "R3" a
    // second time, because everything below it has shifted down by one.
    seedReport(h.db, recipe, "R5", at + 5);

    const second = listTable(h.db, "report", { limit: 2, before: first.records[1]!.id });
    expect(second.records.map((r) => r.id)).toEqual([written[2]!, written[1]!]);
    expect(second.hasMore).toBe(true);

    const third = listTable(h.db, "report", { limit: 2, before: second.records[1]!.id });
    expect(third.records.map((r) => r.id)).toEqual([written[0]!]);
    expect(third.hasMore).toBe(false);
  });

  test("rows written in the same millisecond still have an order to page along", () => {
    h = harness();
    const recipe = seedRecipe(h.db, "Semis");
    const at = nowMs();
    for (const n of [1, 2, 3]) seedReport(h.db, recipe, `R${n}`, at);

    const walked: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = listTable(h.db, "report", { limit: 1, before });
      if (page.records.length === 0) break;
      walked.push(page.records[0]!.id);
      before = page.records[0]!.id;
      if (!page.hasMore) break;
    }
    expect(walked.length).toBe(3);
    expect(new Set(walked).size).toBe(3);
  });

  test("paging before a record that has since been deleted is refused, not restarted", () => {
    h = harness();
    const gone = seedReport(h.db, seedRecipe(h.db, "Semis"), "Withdrawn");
    h.db.query("DELETE FROM report WHERE id = ?").run(gone);
    const refused = refusal(() => listTable(h.db, "report", { before: gone }));
    expect(refused.kind).toBe("not_found");
    expect(refused.message).toContain("already in hand");
  });

  test("a referrer group pages, and its total is of the whole group rather than the page", () => {
    h = harness();
    const report = seedReport(h.db, seedRecipe(h.db, "Semis"), "NVDA");
    const at = nowMs();
    // A report's shell history is the group that actually grows with use: a long procedure runs
    // dozens of commands, and the panel draws a page of them with "show more" behind it. The three
    // land in the same millisecond on purpose — the cursor is read off the record the caller
    // already holds, id and all, so a group whose rows share a clock reading still pages cleanly.
    for (const n of [1, 2, 3]) seedShellRun(h.db, report, `ls dataset/q${n}`, at);

    const first = listReferrers(h.db, "report", report, "trivial_shell_history_for_report", {
      limit: 2,
    });
    expect(first.total).toBe(3);
    expect(first.records.length).toBe(2);
    expect(first.hasMore).toBe(true);

    const second = listReferrers(h.db, "report", report, "trivial_shell_history_for_report", {
      limit: 2,
      before: first.records[1]!.id,
    });
    // The total is the group's, not the page's: a reader who has walked two of three still needs to
    // be told there are three.
    expect(second.total).toBe(3);
    expect(second.records.length).toBe(1);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.records, ...second.records].map((r) => r.id)).size).toBe(3);
  });

  test("a referrer group over a table that points nowhere near says so", () => {
    h = harness();
    const report = seedReport(h.db, seedRecipe(h.db, "Semis"), "NVDA");
    // A recorded command is the end of a chain: it points at its report and nothing in the schema
    // points back at it. Asking for its referrers is asking about an edge that does not exist,
    // which is a different answer from an edge that exists and is empty.
    const command = seedShellRun(h.db, report, "ls -la dataset");
    const refused = refusal(() =>
      listReferrers(h.db, "trivial_shell_history_for_report", command, "report"),
    );
    expect(refused.kind).toBe("not_found");
    expect(refused.message).toContain(
      "nothing in this schema points at a trivial_shell_history_for_report",
    );
  });
});

// -- labels ---------------------------------------------------------------------------------------

describe("the label of each table", () => {
  test("every table names its rows the way the panel reads them", () => {
    h = harness();
    const recipe = seedRecipe(h.db, "Semis", nowMs(), "Write a report on the semis basket.");
    const retired = seedRetiredRecipe(h.db, "Old semis", "Write a report the old way.");
    const source = seedSource(h.db, "Apple IR");
    // The official name goes in at INSERT, because nothing can move it afterwards. The market can:
    // `target_name_is_immutable` is scoped to the one column that is a claim about the world, and
    // which exchange a listing is on is an ordinary fact to learn later.
    const ticker = seedTarget(h.db, "AAPL", "Apple Inc.");
    h.db.query("UPDATE target SET market = 'NASDAQ' WHERE ticker = ?").run(ticker);
    const thesis = seedThesis(h.db, "revenue accelerates");
    const assessed = seedAssessment(h.db, thesis, "insightful");
    const script = seedScript(h.db, "prices.py");
    const shelved = seedScript(h.db, "old prices.py", "inactive");
    const prepared = seedPreparation(h.db, assessed, script, "--window 30");
    const report = seedReport(h.db, recipe, "NVDA Q2");
    const scriptRun = seedScriptRun(h.db, report, script, "--full");
    const failedRun = seedScriptRun(h.db, report, script, "--since 2019", nowMs(), 2);
    const measured = seedSeikanRun(h.db, report, "/opt/venv/bin/seikan run thesis.json");
    const failedMeasure = seedSeikanRun(
      h.db,
      report,
      "/opt/venv/bin/seikan run broken.json",
      nowMs(),
      4,
    );
    const command = seedShellRun(h.db, report, "shasum -a 256 data/nvda.csv");
    const failedCommand = seedShellRun(h.db, report, "curl -sf https://ir.example/q1", nowMs(), 7);

    const label = (table: string, id: string) => getRecord(h.db, table, id).card;

    // WHAT A RECIPE IS, to a reader, is the work it commissions — and the specification's own
    // opening words say that better than anything derived could, which is why they are the label.
    // The name beside them is the recipe's own, the word somebody addresses it by. NO VERSION
    // NUMBER, and that is the change rather than an omission: instructions used to be a ledger of
    // playbook rows labelled `v2`, which asked a reader to hold a count in their head in order to
    // tell two rows apart. A recipe's text cannot be edited, so there is nothing for a number to
    // count.
    expect(label("recipe", recipe)).toMatchObject({
      name: "Semis",
      label: "Write a report on the semis basket.",
    });
    // The sublabel carries the standing and ONLY when it is `inactive`, on the script's precedent:
    // 'active' is almost every row, and spending the second line on it would say nothing.
    expect(label("recipe", recipe).sublabel).toBeUndefined();
    expect(label("recipe", retired)).toMatchObject({
      label: "Write a report the old way.",
      sublabel: "inactive",
    });

    // The title is what a reader picks a document by; the recipe is what it was written TO, and it
    // is named rather than numbered. Two things used to ride here and both are gone: the playbook
    // version, for the reason above, and a count of what the report stood on — which counted the
    // model's own account of what it had read, a number that looked like an audit and was a claim.
    expect(label("report", report)).toMatchObject({
      label: "NVDA Q2",
      sublabel: "under Semis",
    });

    // What the program is FOR is the description; its name is what it is called. The status rides
    // the sublabel ALONE and only where it carries information — the same rule, in the same word,
    // as the recipe above.
    expect(label("script", script)).toMatchObject({ name: "prices-py", label: "prices" });
    expect(label("script", script).sublabel).toBeUndefined();
    expect(label("script", shelved).sublabel).toBe("inactive");

    // A preparation is the pair that would produce the series again: the program, and what it was
    // told. Nothing in it is a file path — where the bytes landed is not what the record is for —
    // so what tells two preparations apart in a whole-table listing is the thesis they were for.
    // Both halves are somebody else's NAME, read through the join rather than copied here.
    expect(label("series_preparation", prepared)).toMatchObject({
      label: "prices-py --window 30",
      sublabel: "for revenue accelerates",
    });

    // The statement is what a thesis SAYS and no other column comes close, so it is the label; the
    // name is the summary somebody addresses it by. A thesis has no standing of its own to wear, so
    // the sublabel asks the ledger for it.
    expect(label("thesis", thesis)).toMatchObject({
      name: "revenue accelerates",
      label: "Something measurable.",
      sublabel: "insightful",
    });

    // The verdict, then the reading behind it, in the row's own words: a tag with no argument
    // behind it is a mood, and the label is where an auditor sees whether there is one.
    expect(label("thesis_assessment", assessed)).toMatchObject({
      label: "insightful · Measured once and it held.",
      sublabel: "of revenue accelerates",
    });

    // The one table whose name is not ours. It is the instrument's official full name, so the
    // ticker — the thing everything else addresses it by — is what DESCRIBES it, and the market is
    // what tells two listings of one company apart.
    expect(label("target", ticker)).toMatchObject({
      id: "AAPL",
      name: "Apple Inc.",
      label: "AAPL",
      sublabel: "NASDAQ",
    });
    expect(label("information_source", source)).toMatchObject({
      name: "Apple IR",
      label: "Apple IR",
      sublabel: "issuer_primary",
    });

    // A run of a stored script is named by the program and what it was given; a command that names
    // no program is named by the line that was typed. The two tables are already the answer to
    // "what kind of command was this", which one table for both kinds would have to spend a
    // sublabel saying — so the sublabel is free for the one thing a reader scanning a procedure is
    // looking for, and carries it ONLY when there is something to say. 'exit 0' on almost every row
    // would hide the row that failed among the rows that did not.
    expect(label("script_invocation", scriptRun).label).toBe("prices-py --full");
    expect(label("script_invocation", scriptRun).sublabel).toBeUndefined();
    expect(label("script_invocation", failedRun)).toMatchObject({
      label: "prices-py --since 2019",
      sublabel: "exit 2",
    });

    // A measurement is labelled by its line too, and says nothing about being one: the table it
    // came out of has already answered that, and a sublabel repeating it would spend the line on
    // the one thing the reader cannot be unsure about.
    expect(label("seikan_invocation", measured).label).toBe(
      "/opt/venv/bin/seikan run thesis.json",
    );
    expect(label("seikan_invocation", measured).sublabel).toBeUndefined();
    expect(label("seikan_invocation", failedMeasure)).toMatchObject({
      label: "/opt/venv/bin/seikan run broken.json",
      sublabel: "exit 4",
    });

    expect(label("trivial_shell_history_for_report", command).label).toBe(
      "shasum -a 256 data/nvda.csv",
    );
    expect(label("trivial_shell_history_for_report", command).sublabel).toBeUndefined();
    expect(label("trivial_shell_history_for_report", failedCommand)).toMatchObject({
      label: "curl -sf https://ir.example/q1",
      sublabel: "exit 7",
    });
  });

  test("a recipe's label is the first sixty characters of the specification, cut and marked", () => {
    // A recipe's whole text is the largest thing a reader could put on a card, and a specification
    // that runs to paragraphs is the ordinary case rather than the exception. So the label is the
    // opening of it and says so with an ellipsis — a silent cut would read as a specification that
    // stops mid-sentence.
    h = harness();
    const specification =
      "Write a quarterly read-through of the semiconductor basket, then say what it misses.";
    const long = seedRecipe(h.db, "Semis", nowMs(), specification);
    const short = seedRecipe(h.db, "Short", nowMs(), "Write a report.");

    expect(getRecord(h.db, "recipe", long).card.label).toBe(`${specification.slice(0, 60)}…`);
    expect(getRecord(h.db, "recipe", long).card.label).toHaveLength(61);
    // And a specification that fits is handed over whole, with nothing appended to say so.
    expect(getRecord(h.db, "recipe", short).card.label).toBe("Write a report.");
  });

  test("a thesis wears the newest row of its ledger, and 'unassessed' while it has none", () => {
    h = harness();
    const judged = seedThesis(h.db, "revenue accelerates");
    const bare = seedThesis(h.db, "margins hold");
    seedAssessment(h.db, judged, "insightful", 1_000);
    seedAssessment(h.db, judged, "approven", 2_000);

    // Derived on every read, never stored. A column here would be a second copy of the ledger's
    // newest row, and the whole reason judgement moved into a ledger is that the second copy is the
    // one that goes stale — a thesis re-read in March would still be wearing what January thought.
    expect(getRecord(h.db, "thesis", judged).card.sublabel).toBe("approven");

    // A container nobody has judged yet is a real state and says so, rather than drawing blank and
    // leaving the reader to guess whether the tag is missing or the panel is.
    expect(getRecord(h.db, "thesis", bare).card.sublabel).toBe("unassessed");

    seedAssessment(h.db, judged, "abandoned", 3_000);
    expect(getRecord(h.db, "thesis", judged).card.sublabel).toBe("abandoned");
  });

  test("the moment beside a command is the run's own, never the report it was written with", () => {
    h = harness();
    const script = seedScript(h.db, "prices.py");
    const report = seedReport(h.db, seedRecipe(h.db, "Semis"), "NVDA", 5_000);
    const early = seedScriptRun(h.db, report, script, "--full", 1_000);
    const late = seedScriptRun(h.db, report, script, "--full", 2_000);
    const measured = seedSeikanRun(h.db, report, "/opt/venv/bin/seikan run t.json", 2_500);
    const command = seedShellRun(h.db, report, "shasum -a 256 data/nvda.csv", 3_000);

    // Every one of these rows comes off the generation's run log, so the moment is when the command
    // ACTUALLY STARTED — which is the fact that makes the record worth keeping. A panel showing the
    // publication time beside all four would say the commands happened in an order nobody
    // observed, and all at an instant when none of them was still running.
    expect(getRecord(h.db, "script_invocation", early).card.meta).toBe(1_000);
    expect(getRecord(h.db, "script_invocation", late).card.meta).toBe(2_000);
    expect(getRecord(h.db, "seikan_invocation", measured).card.meta).toBe(2_500);
    expect(getRecord(h.db, "trivial_shell_history_for_report", command).card.meta).toBe(3_000);
    expect(getRecord(h.db, "report", report).card.meta).toBe(5_000);

    // And the ordering follows the moment, so the table reads back as the run log. The two script
    // runs are the same program with the same argument twice, which the schema allows on purpose:
    // running something twice is a fact about the procedure, not a duplicate row.
    expect(listTable(h.db, "script_invocation").records.map((r) => r.id)).toEqual([late, early]);
  });

  test("a label is one line however many the column had", () => {
    h = harness();
    const report = seedReport(h.db, seedRecipe(h.db, "Semis"), "NVDA");
    // A label is a row in a list, so a value that arrived with newlines in it draws on one line or
    // it pushes every row below it down. A shell command is the one column most likely to have
    // them, being a command line somebody could have pasted as three. Both spellings are folded,
    // because a command line written on one machine and read on another has whichever one that
    // machine writes. Each becomes a SPACE rather than nothing: a newline between two words is a
    // boundary, and folding it away would draw two arguments as one word nobody typed.
    const command = seedShellRun(h.db, report, "uv run seikan \\\nrun dsl.json\r\n--alpha 0.05");
    expect(getRecord(h.db, "trivial_shell_history_for_report", command).card.label).toBe(
      "uv run seikan \\ run dsl.json  --alpha 0.05",
    );
  });
});

// -- one record -----------------------------------------------------------------------------------

describe("one record", () => {
  test("a report carries its row, what it stands on, and what stands on it", () => {
    h = harness();
    const recipe = seedRecipe(h.db, "Semis");
    const script = seedScript(h.db, "prices.py");
    const report = seedReport(h.db, recipe, "NVDA Q2");
    seedScriptRun(h.db, report, script, "--full");
    seedSeikanRun(h.db, report);
    seedShellRun(h.db, report, "shasum -a 256 data/nvda.csv");

    const detail = getRecord(h.db, "report", report);
    expect(detail.row["title"]).toBe("NVDA Q2");

    // A report points OUT at exactly one thing: the recipe it was written to. It used to point at
    // the assessments it applied and, through them, at theses — an edge that recorded the model's
    // account of what it had argued from. Nothing on this side is a claim now; what remains is the
    // specification a machine can prove the report was produced under, and one edge is the honest
    // number.
    expect(
      detail.referents.map((g) => ({ table: g.table, via: g.via, onDelete: g.onDelete, n: g.total })),
    ).toEqual([{ table: "recipe", via: undefined, onDelete: "CASCADE", n: 1 }]);

    // What hangs off a report is what its procedure DID, in the order the key map declares: the
    // stored programs it ran, the measurements it made, and every other command it issued. All
    // three are machine-written and all three die with it.
    expect(detail.referrers.map((g) => g.table)).toEqual([
      "script_invocation",
      "seikan_invocation",
      "trivial_shell_history_for_report",
    ]);
    expect(detail.referrers.map((g) => g.onDelete)).toEqual(["CASCADE", "CASCADE", "CASCADE"]);
    expect(detail.referrers.map((g) => g.total)).toEqual([1, 1, 1]);
  });

  test("the document does not ride the records API: the row carries its size, never its bytes", () => {
    h = harness();
    const report = seedReport(h.db, seedRecipe(h.db, "Semis"), "NVDA Q2");
    const html = reportHtml("NVDA Q2");

    // The document is the largest thing in the database and is served by id on a route of its own.
    // A detail response drawing five edges must not pay for megabytes of HTML nobody in it reads —
    // so the reader learns the document is there and how big it is, which is the auditable fact.
    const detail = getRecord(h.db, "report", report);
    expect(Object.keys(detail.row).sort()).toEqual([
      "content_bytes",
      "created_at",
      "id",
      "name",
      "recipe_id",
      "title",
    ]);
    expect(detail.row["content_bytes"]).toBe(html.length);
    expect(Object.values(detail.row)).not.toContain(html);

    // And the projection has not dropped a key column on the way: `recipe_id` is what the
    // outgoing edge is read off, so an edge drawn honestly empty would be the price of this.
    expect(detail.referents.find((g) => g.table === "recipe")?.total).toBe(1);
  });

  test("a source is an island: nothing points at one, and it points at nothing", () => {
    h = harness();
    const source = seedSource(h.db, "Apple IR");
    seedReport(h.db, seedRecipe(h.db, "Semis"), "NVDA");

    // Pinned as an absence, because it is a decision and not an oversight. A report used to name
    // the sources it had read, through a citation row carrying an address and a quoted sentence —
    // and nothing verified either, so the archive was recording a claim about the world in the
    // shape of a fact about itself. Both went. What is left is an address book: a note of where
    // somebody publishes, for a person and for the agent to read while working, joined to nothing.
    const detail = getRecord(h.db, "information_source", source);
    expect(detail.referents).toEqual([]);
    expect(detail.referrers).toEqual([]);
    expect(detail.row["source"]).toBe("Apple IR");

    // And so a source has no edge that could hold it down: the deletion guard that used to count
    // standing reports has nothing left to count, and the deletion log is the only witness.
    expect(() =>
      h.db.query("DELETE FROM information_source WHERE id = ?").run(source),
    ).not.toThrow();
  });

  test("an invocation names the script it ran, and the script cannot leave while it does", () => {
    h = harness();
    const script = seedScript(h.db, "prices.py");
    const report = seedReport(h.db, seedRecipe(h.db, "Semis"), "NVDA");
    const ran = seedScriptRun(h.db, report, script, "--full");
    const measured = seedSeikanRun(h.db, report, "/opt/venv/bin/seikan run t.json");
    const command = seedShellRun(h.db, report, "shasum -a 256 data/nvda.csv");

    expect(
      getRecord(h.db, "script_invocation", ran).referents.map((g) => ({
        table: g.table,
        onDelete: g.onDelete,
        n: g.total,
      })),
    ).toEqual([
      { table: "report", onDelete: "CASCADE", n: 1 },
      { table: "script", onDelete: "CASCADE", n: 1 },
    ]);

    // A measurement points at its report and at NOTHING ELSE — no thesis, deliberately. The thesis
    // it measured is named in the command line the way any quoted prose carries a name; an edge
    // would either pin theses down again or let deleting one tear a hole in a publication record
    // that is supposed to be immutable.
    expect(
      getRecord(h.db, "seikan_invocation", measured).referents.map((g) => g.table),
    ).toEqual(["report"]);

    // Everything else the shell ran is a table of its own precisely because there is no stored
    // program to name — only the line that was typed. The edge is absent rather than empty, which
    // is a different sentence and the true one.
    expect(
      getRecord(h.db, "trivial_shell_history_for_report", command).referents.map((g) => g.table),
    ).toEqual(["report"]);

    const held = getRecord(h.db, "script", script).referrers.find(
      (g) => g.table === "script_invocation",
    );
    expect(held).toMatchObject({ onDelete: "CASCADE", total: 1 });

    // CASCADE is what the key says and what the browser reports, and it is NOT what happens. The
    // cascade fires the schema's `script_invocations_leave_only_with_their_report` trigger, which
    // finds the report still standing and aborts — taking the script's deletion with it. A
    // published report's numbers came out of that program, so the program stays as long as the
    // report does, and the panel's "deletion cascades" is the declared action rather than a
    // promise the schema is prepared to keep.
    expect(() => h.db.query("DELETE FROM script WHERE id = ?").run(script)).toThrow(
      /publication record/,
    );
  });

  test("a script points at nothing, and its row IS its program", () => {
    h = harness();
    const script = seedScript(h.db, "prices.py");
    const thesis = seedThesis(h.db, "revenue accelerates");
    seedPreparation(h.db, seedAssessment(h.db, thesis, "insightful"), script, "--window 30");
    const detail = getRecord(h.db, "script", script);

    // Not an edge with nothing at the end of it — no edge at all. A script names no recipe, which
    // is what makes a program the installation's: there is nothing on this side of the record.
    expect(detail.referents).toEqual([]);
    // The program IS the record, so the row hands it over. A browser that showed everything about a
    // script except what it does would be an index of nothing — and there is no path or digest
    // beside it, because there are no other bytes to check this copy against.
    expect(detail.row["source"]).toBe('print("prices.py")');
    expect(Object.keys(detail.row).sort()).toEqual([
      "created_at",
      "domain",
      "id",
      "name",
      "source",
      "status",
      "updated_at",
    ]);

    // What points back are the preparations it made and the runs that used it, both declared
    // CASCADE and only one of them meaning it: a preparation is the script's own account of what it
    // produced and has nothing left to say once the program is gone, while an invocation is part of
    // a publication record and the trigger above refuses to let it go.
    expect(
      detail.referrers.map((g) => ({ table: g.table, onDelete: g.onDelete, n: g.total })),
    ).toEqual([
      { table: "series_preparation", onDelete: "CASCADE", n: 1 },
      { table: "script_invocation", onDelete: "CASCADE", n: 0 },
    ]);
  });

  test("an assessment hangs off its thesis, and only its preparations hang off it", () => {
    h = harness();
    const script = seedScript(h.db, "prices.py");
    const thesis = seedThesis(h.db, "revenue accelerates");
    const assessed = seedAssessment(h.db, thesis, "approven");
    seedPreparation(h.db, assessed, script, "--window 30");
    seedReport(h.db, seedRecipe(h.db, "Semis"), "NVDA");

    const detail = getRecord(h.db, "thesis_assessment", assessed);
    // The measurement the reading came off is kept verbatim on the row, which is what makes "we
    // called it approven in March" checkable against numbers rather than against memory.
    expect(detail.row["seikan_report"]).toBe('{"cells": []}');
    expect(
      detail.referents.map((g) => ({ table: g.table, onDelete: g.onDelete, n: g.total })),
    ).toEqual([{ table: "thesis", onDelete: "CASCADE", n: 1 }]);

    // One round of judgement is pointed at by the preparations that made its inputs, and by nothing
    // else. A report used to hang here as well, through the junction that recorded which readings
    // it had applied — an edge with NO ACTION on this end, which the panel drew as "deletion
    // blocked". Pinned as an absence: what a report argued from was the model's account of its own
    // reasoning, and an archive that stores an account as though it were an observation is worse
    // than one that stores neither.
    expect(
      detail.referrers.map((g) => ({ table: g.table, via: g.via, onDelete: g.onDelete, n: g.total })),
    ).toEqual([{ table: "series_preparation", via: undefined, onDelete: "CASCADE", n: 1 }]);

    // And the inversion that follows from it. This delete used to be refused: the cascade would
    // have taken an applied assessment with it and pulled the ground out from under a published
    // document. Nothing points at the ledger from a report now, so the thesis, its whole ledger and
    // the preparations under it leave in one act — and the standing report is untouched, because it
    // never depended on any of them.
    expect(() => h.db.query("DELETE FROM thesis WHERE id = ?").run(thesis)).not.toThrow();
    expect(h.db.query("SELECT COUNT(*) AS n FROM thesis_assessment").get()).toEqual({ n: 0 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM series_preparation").get()).toEqual({ n: 0 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM report").get()).toEqual({ n: 1 });
  });

  test("a thesis is pointed at by its ledger and points at its regime", () => {
    h = harness();
    const ticker = seedTarget(h.db, "AAPL");
    const thesis = seedThesis(h.db, "revenue accelerates");
    measure(h.db, thesis, ticker);
    seedAssessment(h.db, thesis, "insightful", 1_000);
    seedAssessment(h.db, thesis, "approven", 2_000);

    const detail = getRecord(h.db, "thesis", thesis);
    const regime = detail.referents.find((g) => g.via === "regime");
    expect(regime).toMatchObject({ table: "target", onDelete: "NO ACTION", total: 1 });
    expect(regime?.records[0]?.label).toBe("AAPL");

    // What points at a thesis is its own history and nothing else, newest first. Two rounds of
    // judgement hang here where a single tag column would have shown one and forgotten the other.
    expect(
      detail.referrers.map((g) => ({ table: g.table, via: g.via, onDelete: g.onDelete, n: g.total })),
    ).toEqual([{ table: "thesis_assessment", via: undefined, onDelete: "CASCADE", n: 2 }]);
    expect(detail.referrers[0]?.records.map((r) => r.label)).toEqual([
      "approven · Measured once and it held.",
      "insightful · Measured once and it held.",
    ]);
  });

  test("a target is pointed at only by the theses measuring it, and they block its deletion", () => {
    h = harness();
    const ticker = seedTarget(h.db, "AAPL");
    const thesis = seedThesis(h.db, "revenue accelerates");
    measure(h.db, thesis, ticker);

    const detail = getRecord(h.db, "target", ticker);
    // One edge, through the junction, and no ON DELETE on the target end of it: a thesis whose
    // target vanished would still name that ticker in its DSL.
    expect(
      detail.referrers.map((g) => ({ table: g.table, via: g.via, onDelete: g.onDelete })),
    ).toEqual([{ table: "thesis", via: "regime", onDelete: "NO ACTION" }]);
    expect(detail.referents).toEqual([]);
    expect(() => h.db.query("DELETE FROM target WHERE ticker = ?").run(ticker)).toThrow(
      /FOREIGN KEY/,
    );
  });

  test("a recipe's reports come back newest first, so the new one is the top row", () => {
    // WHAT THE WINDOW DRAWS DEPENDS ON THIS AND HAD NOTHING PINNING IT. The graph lists a group in
    // the order the repository hands it over — `state/graph.ts` merges a refresh in place precisely
    // so nothing re-sorts under the reader — so "the newest report at the top of the box" is a
    // property of this ORDER BY and of nowhere else. This is the edge the playbook ledger's used to
    // be: a recipe is pointed at by the documents published to it, and the ordering is what says
    // which of them is the recent one.
    h = harness();
    const at = nowMs();
    const recipe = seedRecipe(h.db, "Semis", at);
    // Distinct moments, because the tie-break below a shared `created_at` is the id, which is a
    // uuid and says nothing about which report came later.
    const first = seedReport(h.db, recipe, "Q1", at);
    const second = seedReport(h.db, recipe, "Q2", at + 1_000);
    const third = seedReport(h.db, recipe, "Q3", at + 2_000);

    const published = getRecord(h.db, "recipe", recipe).referrers.find(
      (g) => g.table === "report",
    )!;
    expect(published.records.map((r) => r.id)).toEqual([third, second, first]);
    // And every one of them wears the recipe's name, which is what tells a report apart from a
    // report of the same title written to some other specification.
    expect(published.records.map((r) => r.sublabel)).toEqual([
      "under Semis",
      "under Semis",
      "under Semis",
    ]);
  });

  test("a recipe with no report still has the edge, empty, so its box keeps its `+`", () => {
    // A NEW RECIPE IS IN THIS STATE, which is why it is worth a test of its own: nothing is born
    // with a report. The group is built from the foreign key rather than from what is at the end of
    // it, so the graph draws a `report` box with no rows — "none recorded", and the `+` in its title
    // bar that asks for the report this recipe specifies. A recipe whose edge vanished with its last
    // report would be a recipe with no way back to having one.
    h = harness();
    const recipe = seedRecipe(h.db, "Semis");

    const detail = getRecord(h.db, "recipe", recipe);
    const published = detail.referrers.find((g) => g.table === "report");
    expect(published).toMatchObject({ total: 0, hasMore: false });
    expect(published?.records).toEqual([]);
    // And the row still says what it is FOR, because a recipe's description is its own text rather
    // than something derived from what has been published to it.
    expect(detail.card.label).toBe("Write a report.");
  });

  test("a limit pages the referrers and leaves the referents whole", () => {
    h = harness();
    const thesis = seedThesis(h.db, "revenue accelerates");
    for (const n of [1, 2, 3]) {
      measure(h.db, thesis, seedTarget(h.db, `T${n}`));
      seedAssessment(h.db, thesis, "insightful", 1_000 * n);
    }

    const detail = getRecord(h.db, "thesis", thesis, { limit: 1 });
    // The ledger is the side that grows with use — a thesis is re-read as often as somebody has
    // reason to — so it is the side "show more" is a route for.
    const ledger = detail.referrers.find((g) => g.table === "thesis_assessment")!;
    expect(ledger).toMatchObject({ total: 3, hasMore: true });
    expect(ledger.records.length).toBe(1);

    // Nothing pages a referent, so nothing may cut one short: a regime drawn one target short of
    // what the thesis measures would misstate what the thesis is ABOUT, and there is no second
    // request to ask for the rest with.
    const regime = detail.referents.find((g) => g.via === "regime")!;
    expect(regime).toMatchObject({ total: 3, hasMore: false });
    expect(regime.records.length).toBe(3);
  });

  test("a card's id is text whatever the column is, and a ticker is the column itself", () => {
    h = harness();
    // Nothing in this schema numbers its rows, so the promise costs nothing to keep and is asserted
    // anyway: a client that had to remember which tables number theirs would get it wrong on
    // whichever it remembered last. `target` is the interesting one, because its id is not a uuid
    // at all.
    const ticker = seedTarget(h.db, "AAPL");
    const detail = getRecord(h.db, "target", ticker);
    expect(detail.row["ticker"]).toBe("AAPL");
    expect(detail.card.id).toBe("AAPL");
    for (const table of RECORD_TABLES) {
      for (const card of listTable(h.db, table).records) expect(typeof card.id).toBe("string");
    }
  });
});

// -- which rows can be opened -----------------------------------------------------------------------

/**
 * Which rows the browser draws an expand arrow on — a question this file answers about TABLES, and
 * used to answer about rows.
 *
 * WHAT CHANGED AND WHY. A card carried a `hasReferrers` bit: the repository probed every referrer
 * key and said whether anything actually pointed at that row, and the window drew the arrow only
 * where it was true. It was honest about the data and it hid the schema. A recipe nothing has been
 * published to yet, a report whose commands are all still to come, and an information source that
 * nothing in the schema CAN point at were three different facts drawn identically — no arrow,
 * nothing to open — so a reader had no way to tell an edge that is empty from an edge that does not
 * exist. The arrow is now a property of the table: six tables have one, five never do, and opening a
 * fresh recipe draws an empty `report` box, which is the disclosure.
 *
 * SO THE LOCKS HERE ARE THE ONES THE WINDOW'S MIRROR RESTS ON. The partition below is exactly what
 * `tests/webProtocol.test.ts` computes and compares `EXPANDABLE_TABLES` against, and the one-group-
 * per-edge contract is what makes an arrow on an empty table land on a box rather than on nothing.
 */
describe("which rows can be opened", () => {
  /** One row in every record table there is, so that a walk over `RECORD_TABLES` finds something in
   * each of them. A second recipe is written with nothing published to it: that is a row with a real
   * edge and nothing at the end of it, which is the state the whole change is about. */
  function seedEachTable(db: Database): void {
    const recipe = seedRecipe(db, "Semis");
    seedRecipe(db, "Elsewhere");
    const report = seedReport(db, recipe, "NVDA Q2");
    const script = seedScript(db, "prices.py");
    seedScriptRun(db, report, script, "--full");
    seedSeikanRun(db, report);
    seedShellRun(db, report, "shasum -a 256 data/nvda.csv");
    const thesis = seedThesis(db, "revenue accelerates");
    seedPreparation(db, seedAssessment(db, thesis, "insightful"), script, "--window 30");
    measure(db, thesis, seedTarget(db, "AAPL"));
    seedSource(db, "Apple IR");
  }

  test("the tables that can be pointed at are six, and the leaves are five", () => {
    // THE PARTITION THE WINDOW MIRRORS. Read off the referrer map rather than listed by hand, then
    // spelled out beside it — the filter alone would be just as happy with a map that had lost an
    // edge, and the literal alone would drift the first time the schema grew one.
    const openable = RECORD_TABLES.filter((table) => REFERRERS[table].length > 0);
    const leaves = RECORD_TABLES.filter((table) => REFERRERS[table].length === 0);
    expect(openable).toEqual([
      "recipe",
      "report",
      "script",
      "target",
      "thesis",
      "thesis_assessment",
    ]);
    expect(leaves).toEqual([
      "information_source",
      "script_invocation",
      "seikan_invocation",
      "series_preparation",
      "trivial_shell_history_for_report",
    ]);
    expect(openable.length + leaves.length).toBe(RECORD_TABLES.length);

    // AND THE JUNCTION'S DIRECTION, which is the half a partition derived from `FOREIGN_KEYS`
    // instead of from `REFERRERS` would get wrong. `regime` carries two keys and only one of them
    // is a referrer: a thesis DECLARES the regime, so the thesis points at the target and not the
    // other way. Read off the keys alone, every measured thesis would earn an arrow onto a box that
    // could never hold anything — which is the failure the old per-row flag existed to avoid, and
    // it is avoided here by the same map for the same reason.
    expect(REFERRERS.target.map((edge) => edge.table)).toEqual(["thesis"]);
    expect(REFERRERS.thesis.map((edge) => edge.table)).toEqual(["thesis_assessment"]);
  });

  test("an edge with nothing at the far end still comes back as a group, so the arrow lands", () => {
    h = harness();
    // A recipe as `create_recipe` actually makes one: stored active, with nothing published to it.
    const recipe = seedRecipe(h.db, "rc-fresh");

    // THE CONTRACT THE ARROW RESTS ON. The window draws the arrow from the schema, so it opens rows
    // nothing has been recorded under yet; what it must find there is a box saying "none recorded"
    // rather than an answer with no boxes in it, which the panel could only render as a read that
    // came back wrong. One group per edge in `REFERRERS`, in the same order, whatever the archive
    // holds.
    const fresh = getRecord(h.db, "recipe", recipe);
    expect(fresh.referrers.map((g) => g.table)).toEqual(REFERRERS.recipe.map((e) => e.table));
    expect(fresh.referrers.every((g) => g.total === 0)).toBe(true);
    expect(fresh.referrers.every((g) => g.records.length === 0)).toBe(true);

    // And the group is a real group rather than a placeholder: it names the key that carries the
    // edge and what deleting this row would do to whatever hangs off it, empty or not. That is the
    // sentence the box's title bar shows, and it is worth showing on an empty box — and on this one
    // it is the sentence that matters most, because deleting a recipe takes every report under it.
    const group = fresh.referrers[0]!;
    expect(group.column).toBe("recipe_id");
    expect(group.onDelete).toBe("CASCADE");
    expect(group.hasMore).toBe(false);

    // A row whose edges are three and all empty, which is what a report published by a procedure
    // that ran nothing would draw.
    const report = seedReport(h.db, seedRecipe(h.db, "Semis"), "NVDA Q2");
    const runs = getRecord(h.db, "report", report).referrers;
    expect(runs.map((g) => g.table)).toEqual(REFERRERS.report.map((e) => e.table));
    expect(runs).toHaveLength(3);
    expect(runs.every((g) => g.total === 0)).toBe(true);

    // Which stays the same shape once something lands, so nothing about the answer depends on
    // whether the edge is occupied.
    seedShellRun(h.db, report, "shasum -a 256 data/nvda.csv");
    const after = getRecord(h.db, "report", report).referrers;
    expect(after.map((g) => g.table)).toEqual(runs.map((g) => g.table));
    expect(after.filter((g) => g.total > 0).map((g) => g.table)).toEqual([
      "trivial_shell_history_for_report",
    ]);
  });

  test("a card is what its table projects and carries no census of the rest of the database", () => {
    h = harness();
    seedEachTable(h.db);

    // THE ABSENCE, PINNED. Every card on the wire is built by one function, and the bit it used to
    // append is gone from all four surfaces at once — a surface that still added it would be a
    // window drawing one row two ways depending on how it was asked for. The key set is asserted
    // rather than the one name, so anything else appended here has to be argued for too.
    const recipe = listTable(h.db, "report").records[0]!.id;
    const parent = getRecord(h.db, "report", recipe).row["recipe_id"] as string;
    const surfaces = [
      listTable(h.db, "report").records,
      [getRecord(h.db, "recipe", parent).card],
      getRecord(h.db, "recipe", parent).referrers.find((g) => g.table === "report")!.records,
      listReferrers(h.db, "recipe", parent, "report").records,
    ];
    // A `sublabel` is present only where the table has something to add — a retired recipe says so,
    // an active one says nothing — so the assertion is that every key is one a card is allowed to
    // have, rather than one fixed list a table without a marker would fail.
    const CARD_KEYS = ["id", "label", "meta", "name", "sublabel", "table"];
    for (const records of surfaces) {
      expect(records.length).toBeGreaterThan(0);
      for (const card of records) {
        expect("hasReferrers" in card).toBe(false);
        for (const key of Object.keys(card)) expect(CARD_KEYS).toContain(key);
      }
    }

    // And across every table, including the ones whose cards carry a sublabel: the projection is
    // the table's own and nothing rides along beside it.
    for (const table of RECORD_TABLES) {
      for (const card of listTable(h.db, table, { limit: MAX_GROUP }).records) {
        expect(`${table} ${"hasReferrers" in card}`).toBe(`${table} false`);
      }
    }
  });
});

// -- ids ------------------------------------------------------------------------------------------

describe("id shapes", () => {
  test("each table refuses an id its column could never hold", () => {
    // TWO shapes address rows here, and neither of them is a path. A uuid4 as 32 lower-case hex
    // characters addresses ten of the eleven tables, and a target is addressed by the ticker,
    // which is the one natural key in the schema. Nothing is addressed by a whole number, the
    // transcript being the SDK's, and nothing by a var-relative file path: what prepared a series
    // is a script and an argument, and that row is addressed like every other one.
    h = harness();
    for (const [table, bad] of [
      ["report", "not-a-uuid"],
      ["thesis", "ABCDEF"],
      ["thesis_assessment", `${newId()}0`],
      ["series_preparation", ""],
      ["script_invocation", "dataset/AAPL/ohlcv.csv"],
      ["seikan_invocation", "var/venv/bin/seikan"],
      ["recipe", newId().toUpperCase()],
      ["script", "twelve"],
      ["trivial_shell_history_for_report", "-1"],
      ["target", "this is a sentence, not a ticker"],
    ] as const) {
      expect(refusal(() => getRecord(h.db, table, bad)).kind).toBe("invalid_request");
    }

    // A uuid refusal names the table it was asked about: "invalid id" on a panel drawing six edges
    // leaves the reader guessing which of them they mistyped. The ticker's names the shape instead,
    // because a ticker is checked by the repository that owns tickers and that refusal is the same
    // sentence wherever a symbol arrives.
    expect(refusal(() => getRecord(h.db, "series_preparation", "nope")).message).toContain(
      "series_preparation id",
    );
    expect(refusal(() => getRecord(h.db, "target", "not a ticker!")).message).toContain("ticker");
  });

  test("a well-shaped id that names nothing is a 404, and a ticker is normalised on the way in", () => {
    h = harness();
    expect(refusal(() => getRecord(h.db, "report", newId())).kind).toBe("not_found");
    seedTarget(h.db, "AAPL");
    expect(getRecord(h.db, "target", " aapl ").card.id).toBe("AAPL");
  });
});
