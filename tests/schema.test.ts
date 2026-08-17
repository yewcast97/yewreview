/**
 * The schema's own constants, checked against a database that actually applied it.
 *
 * `TABLES` is a hand-written list sitting beside the DDL it describes, and a hand-written copy of
 * anything is a lie waiting for the next change. No runtime code reads it yet, so without this the
 * list would have drifted silently — a dropped table left in it reads as a table that exists.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { TABLES } from "../src/db/schema.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h?.cleanup());

describe("the schema constants", () => {
  test("TABLES names exactly the tables a fresh database has, and in the same order", () => {
    h = harness();
    const names = h.db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(names).toEqual([...TABLES]);
  });
});
