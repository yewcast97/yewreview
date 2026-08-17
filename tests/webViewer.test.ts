/**
 * The record viewer's reading of a row.
 *
 * `lib/viewer.ts` is the whole of how a stored row becomes a record somebody can read: which columns
 * are prose, which are fields, and which record is a document rather than a row. All three are
 * decisions about column NAMES, held in one map while the schema moves underneath it, so what is
 * tested here is mostly what happens when the map and the row DISAGREE — the case nobody exercises
 * by hand, and the one that decides whether a panel draws a record or a blank.
 */

import { describe, expect, test } from "bun:test";

import type { RecordDetail, RecordTable, Row } from "../web/src/lib/records.ts";
import {
  isMoment,
  isRowAddress,
  primaryTextEntries,
  reportSource,
  restFields,
} from "../web/src/lib/viewer.ts";

/** A detail as the record API answers one: a card, the row exactly as stored, and its edges. The
 * edges are empty throughout, because nothing in this module looks at them: the viewer draws
 * fields. */
function detailOf(table: RecordTable, id: string, row: Row): RecordDetail {
  return {
    card: { table, id, name: `${table}-${id}`, label: id },
    row,
    referents: [],
    referrers: [],
  };
}

describe("finding the document behind a report", () => {
  test("a report is reached by its own id, and by nothing the row says", () => {
    // The document lives in the database and is served from there, so the URL is built out of the
    // record's identity. The row here carries `content_bytes` — the size of the document rather
    // than the document — which is exactly what the browser hands over, and none of it is consulted.
    const detail = detailOf("report", "4931024728004487ad0e647f038bbb10", {
      id: "4931024728004487ad0e647f038bbb10",
      recipe_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      title: "Weekly",
      content_bytes: 18_204,
      created_at: 1_754_179_200_000,
    });
    expect(reportSource(detail)).toBe("/reports/4931024728004487ad0e647f038bbb10");
  });

  test("a record that is not a report has no document", () => {
    // The check is on the TABLE, and it has to be: every id in this schema is a hex string, so a
    // record's id says nothing at all about whether there is a document behind it. A `script` is the
    // record most nearly tempting — it holds a long text column of its own — and pointing the panel's
    // one iframe at `/reports/<a script's id>` would serve a program under the word "report", or
    // nothing at all.
    const detail = detailOf("script", "cccccccccccccccccccccccccccccccc", {
      id: "cccccccccccccccccccccccccccccccc",
      name: "revenue.py",
      domain: "fundamentals",
      source: "import sys\nprint(sys.argv[1])\n",
      status: "active",
      created_at: 1_754_179_200_000,
      updated_at: 1_754_179_200_000,
    });
    expect(reportSource(detail)).toBeNull();
  });

  test("an id that would need escaping is escaped rather than pasted into the URL", () => {
    // Every id this schema mints for a report is 32 hex characters, so this is a habit outliving
    // the guarantee that made it safe — which is the point: the day a report is addressed by
    // anything else, the URL is still one segment and still names the record it was built from.
    const detail = detailOf("report", "weekly report/2026 q3", {
      id: "weekly report/2026 q3",
      title: "Weekly",
    });
    expect(reportSource(detail)).toBe("/reports/weekly%20report%2F2026%20q3");
  });
});

describe("promoting the prose", () => {
  test("the mapped columns come out in reading order", () => {
    // Written with `seikan_report` FIRST, which is the whole point: the order the blocks are read in
    // is the map's argument order — the reading somebody wrote, then the engine's report that
    // reading came off — and not whatever order the row happens to arrive in.
    const detail = detailOf("thesis_assessment", "0f1e2d3c4b5a69788796a5b4c3d2e1f0", {
      seikan_report: "window 2024-01..2025-12 · 24 points · holds",
      assessment: "Margin expansion has held for three quarters.",
      id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      thesis_id: "1a2b3c4d5e6f708192a3b4c5d6e7f809",
      tag: "insightful",
      created_at: 1,
    });
    expect(primaryTextEntries(detail)).toEqual([
      { name: "assessment", text: "Margin expansion has held for three quarters." },
      { name: "seikan_report", text: "window 2024-01..2025-12 · 24 points · holds" },
    ]);
  });

  test("a script is its program, and a recorded command is the line that ran and what it printed", () => {
    // Both are records whose whole substance is long text, and a field grid renders a program as an
    // unreadable ribbon. The bytes are the record — a browser that showed everything about a script
    // except what it does would be an index of nothing.
    const script = detailOf("script", "s1", {
      id: "s1",
      name: "revenue.py",
      domain: "fundamentals",
      source: "import sys\nprint(sys.argv[1])\n",
      status: "active",
      created_at: 1,
      updated_at: 1,
    });
    expect(primaryTextEntries(script)).toEqual([
      { name: "source", text: "import sys\nprint(sys.argv[1])\n" },
    ]);
    expect(restFields(script).map((field) => field.name)).not.toContain("source");

    // A command from a report's shell history promotes BOTH of its text columns, in the order they
    // happened: the line somebody ran, and then what came back. Reading them the other way round
    // would put an answer above the question it answers.
    const command = detailOf("trivial_shell_history_for_report", "sh1", {
      id: "sh1",
      report_id: "r1",
      command: "curl -s https://mops.twse.com.tw/nas/t21/sii/t21sc03_114_11_0.html",
      return: "October consolidated revenue was NT$276.06 billion.\n",
      exit_code: 0,
      duration_ms: 412,
      created_at: 1,
    });
    expect(primaryTextEntries(command)).toEqual([
      {
        name: "command",
        text: "curl -s https://mops.twse.com.tw/nas/t21/sii/t21sc03_114_11_0.html",
      },
      { name: "return", text: "October consolidated revenue was NT$276.06 billion.\n" },
    ]);
    // What is left is what an auditor scans rather than reads: how it ended, and how long it took.
    expect(restFields(command).map((field) => field.name)).toEqual([
      "exit_code",
      "duration_ms",
      "created_at",
    ]);

    // A measurement reads the same way, and it has to: the two tables carry the same four facts and
    // differ only in which of them a machine put where. What rides in `return` here is the engine's
    // whole report rather than a program's chatter, which is the one reason the column is drawn as
    // prose at all — a clipped measurement report is not a smaller version of one but a broken one.
    const measured = detailOf("seikan_invocation", "sk1", {
      id: "sk1",
      report_id: "r1",
      command: "/opt/venv/bin/seikan run thesis.json --report-out report.json --data NVDA=nvda.csv",
      return: '{"cells": 4, "n_eff": 118.2}',
      exit_code: 0,
      duration_ms: 5_100,
      created_at: 1,
    });
    expect(primaryTextEntries(measured).map((entry) => entry.name)).toEqual(["command", "return"]);
    expect(restFields(measured).map((field) => field.name)).toEqual([
      "exit_code",
      "duration_ms",
      "created_at",
    ]);
  });

  test("a column that is absent, null or blank is skipped rather than drawn empty", () => {
    // Three ways for a mapped column to hold no prose, and one answer to all of them. ABSENT is what
    // the map being advisory looks like from here: it names columns by string, the schema moves, and
    // an assessment that arrives without the column the map asks for second is drawn with what it
    // does have rather than with a heading over a void.
    const partial = detailOf("thesis_assessment", "a1", {
      id: "a1",
      thesis_id: "t1",
      tag: "insightful",
      assessment: "It has held for three quarters.",
      created_at: 1,
    });
    expect(primaryTextEntries(partial)).toEqual([
      { name: "assessment", text: "It has held for three quarters." },
    ]);

    // BLANK: written, and written as whitespace. `thesis.content` carries no CHECK against that, so
    // it is a row the database will hold and this panel will be asked to draw — and a heading over
    // three spaces claims a paragraph is there when none is.
    const blank = detailOf("thesis", "t1", {
      id: "t1",
      name: "Margin expansion holds",
      content: "   ",
      created_at: 1,
    });
    expect(primaryTextEntries(blank)).toEqual([]);

    // NULL, which everywhere else in this panel is a different audit finding from blank — a column
    // holding nothing is not a column holding the empty string, and `restFields` keeps them apart.
    // To the question this function asks they are the same answer, and it is the row TYPE this is
    // written against rather than today's CHECK constraints: `"return"` is NOT NULL in the schema
    // right now, and this panel still has to draw the row a future schema hands it.
    const nulled = detailOf("trivial_shell_history_for_report", "sh1", {
      id: "sh1",
      command: "curl -sS https://example.invalid/filing",
      return: null,
    });
    // The null is skipped and its neighbour is still drawn, which is the whole of what "skipped"
    // has to mean: one empty column does not cost the reader the ones beside it.
    expect(primaryTextEntries(nulled)).toEqual([
      { name: "command", text: "curl -sS https://example.invalid/filing" },
    ]);
  });

  test("a table with no prose to promote degrades to fields alone", () => {
    // The graceful-degradation case, and not a hypothetical: a `series_preparation` row is the round
    // it belongs to, the program that prepared one of its inputs, and what that program was told.
    // `argument` is text and is deliberately not promoted — it is a command line, which is read as an
    // identifier rather than as prose.
    const detail = detailOf("series_preparation", "dddddddddddddddddddddddddddddddd", {
      id: "dddddddddddddddddddddddddddddddd",
      thesis_assessment_id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      script_id: "cccccccccccccccccccccccccccccccc",
      argument: "2330.TW",
      created_at: 2,
    });
    expect(primaryTextEntries(detail)).toEqual([]);
    // Nothing was eaten on the way: every column that is not an ADDRESS is still a field. The three
    // that are — the row's own id, and the two keys naming the round and the program — are drawn as
    // named edges under "Points to" instead, which is what an auditor actually reads them as.
    expect(restFields(detail).map((field) => field.name)).toEqual(["argument", "created_at"]);
  });

  test("a table the map says nothing about is all fields", () => {
    const detail = detailOf("information_source", "s1", {
      id: "s1",
      source: "TWSE",
      type: "regulatory_government",
      domain: "twse.com.tw",
      method: "REST",
    });
    expect(primaryTextEntries(detail)).toEqual([]);
    // Five columns, one of them the row's own id.
    expect(restFields(detail).map((field) => field.name)).toEqual([
      "source",
      "type",
      "domain",
      "method",
    ]);
  });
});

describe("what is left over", () => {
  test("exactly the promoted columns are excluded, and row order is kept", () => {
    const detail = detailOf("thesis_assessment", "a1", {
      id: "a1",
      thesis_id: "t1",
      tag: "insightful",
      assessment: "It has held for three quarters.",
      seikan_report: "window 2024-01..2025-12 · 24 points · holds",
      created_at: 2,
    });
    expect(primaryTextEntries(detail).map((entry) => entry.name)).toEqual([
      "assessment",
      "seikan_report",
    ]);
    expect(restFields(detail).map((field) => field.name)).toEqual(["tag", "created_at"]);
  });

  test("prose, fields and addresses are the whole row between them, each column once", () => {
    const row: Row = {
      id: "a1",
      thesis_id: "t1",
      tag: "insightful",
      assessment: "It has held for three quarters.",
      seikan_report: "",
      created_at: 3,
    };
    const detail = detailOf("thesis_assessment", "a1", row);
    const seen = [
      ...primaryTextEntries(detail).map((entry) => entry.name),
      ...restFields(detail).map((field) => field.name),
      ...Object.keys(row).filter(isRowAddress),
    ];
    // `seikan_report` is blank, so it is not prose — and it is therefore still a field, which is how
    // a column that was written empty stays visible to an auditor. An assessment with no measurement
    // under it is exactly the finding somebody is here to make.
    expect([...seen].sort()).toEqual(Object.keys(row).sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("a report's document arrives as a size, and draws as an ordinary field", () => {
    // `report` is deliberately absent from the map despite holding the longest text in the
    // database, and the row the browser is handed carries `length(content) AS content_bytes` in
    // place of the bytes. Both halves of that have to survive here: nothing is promoted, and the
    // one column that says the document exists is not swallowed on its way to the grid.
    const detail = detailOf("report", "4931024728004487ad0e647f038bbb10", {
      id: "4931024728004487ad0e647f038bbb10",
      recipe_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      title: "TSMC — November revenue",
      content_bytes: 18_204,
      created_at: 1_754_179_200_000,
    });
    expect(primaryTextEntries(detail)).toEqual([]);
    expect(restFields(detail).map((field) => field.name)).toEqual([
      "title",
      "content_bytes",
      "created_at",
    ]);
    // A number, not a rendered size: what "18 kB" is depends on who is reading it.
    expect(restFields(detail)).toContainEqual({ name: "content_bytes", value: 18_204 });
    // And the document itself is still one click away, from the card rather than from the row.
    expect(reportSource(detail)).toBe("/reports/4931024728004487ad0e647f038bbb10");
  });

  test("a null field keeps its null rather than becoming an empty string", () => {
    // `auth_env` holds the NAME of the environment variable a source's credential lives in, and null
    // there means the source needs none — which is a different fact from `""`, an empty variable name
    // nobody can look up. Rendering both as a blank cell would merge them on screen.
    const detail = detailOf("information_source", "s1", {
      id: "s1",
      source: "TWSE",
      type: "regulatory_government",
      domain: "twse.com.tw",
      method: "REST",
      failure_cases: null,
      auth_env: null,
    });
    expect(restFields(detail)).toContainEqual({ name: "auth_env", value: null });
    expect(restFields(detail)).toContainEqual({ name: "failure_cases", value: null });
  });
});

describe("the columns that are addresses rather than fields", () => {
  test("the row's own id, and every foreign key", () => {
    // What an `*_id` means to somebody auditing a record is "this points at that", and the panel
    // draws that as an edge list with the target's NAME on it. The uuid itself is the same length
    // and shape for every row in the database and tells the reader nothing.
    expect(isRowAddress("id")).toBe(true);
    expect(isRowAddress("recipe_id")).toBe(true);
    expect(isRowAddress("thesis_assessment_id")).toBe(true);
  });

  test("a ticker is an address AND the thing the row is about, so it survives", () => {
    // `target` is keyed by its ticker: 2330.TW is what somebody would type to find the row, and
    // hiding it would leave a target record that says nothing at all. This is the case that makes
    // the suffix test right rather than a looser one.
    //
    // AND `name` IS AN ORDINARY FIELD HERE, drawn in the grid like any other column. On a target it
    // is the instrument's official full name — a fact somebody looked up rather than a summary
    // anybody composed — so it belongs where a reader can check it against the ticker beside it.
    expect(isRowAddress("ticker")).toBe(false);
    const detail = detailOf("target", "2330.TW", {
      name: "Taiwan Semiconductor Manufacturing Company Limited",
      ticker: "2330.TW",
      market: "TW",
      unit: "dollar",
      added_at: 1_754_179_200_000,
    });
    expect(restFields(detail).map((field) => field.name)).toEqual([
      "name",
      "ticker",
      "market",
      "unit",
      "added_at",
    ]);
  });

  test("ordinary columns are not addresses, however they are spelled", () => {
    for (const name of ["title", "created_at", "content_bytes", "return", "domain", "identity"]) {
      expect(isRowAddress(name)).toBe(false);
    }
  });
});

describe("the columns that are moments", () => {
  test("an epoch stamp is one", () => {
    // Drawn as a time rather than as the integer it is stored as: `1754702400000` is a fact about
    // how the schema keeps time, and no auditor has ever checked one by eye.
    expect(isMoment({ name: "created_at", value: 1_754_179_200_000 })).toBe(true);
    expect(isMoment({ name: "updated_at", value: 0 })).toBe(true);
    expect(isMoment({ name: "added_at", value: 12 })).toBe(true);
  });

  test("a number that is not a time is not one", () => {
    expect(isMoment({ name: "content_bytes", value: 18_204 })).toBe(false);
    expect(isMoment({ name: "version", value: 3 })).toBe(false);
  });

  test("text is never one, whatever it is called", () => {
    // Both halves of the test are load-bearing: a text column ending `_at` would be a sentence, not
    // a stamp, and formatting it as a date would be this panel inventing a value.
    expect(isMoment({ name: "created_at", value: "yesterday" })).toBe(false);
    expect(isMoment({ name: "created_at", value: null })).toBe(false);
  });
});
