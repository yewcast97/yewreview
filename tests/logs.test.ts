import { test, expect, describe } from "bun:test";

import { Refused } from "../src/db/models.ts";
import { tx } from "../src/db/tx.ts";
import {
  attachLogAnnouncer,
  listDeletions,
  listErrors,
  logDeletion,
  logError,
  logWrites,
  LOG_CAP,
} from "../src/repo/logs.ts";
import type { EventsFrame } from "../src/protocol/types.ts";
import { harness } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

function refusal(fn: () => unknown): Refused {
  try {
    fn();
  } catch (err) {
    if (err instanceof Refused) return err;
    throw err;
  }
  throw new Error("expected a refusal, got a result");
}

/** The announcer is deliberately a microtask behind the write, so a test that asserts on frames has
 * to let the queue drain first. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function frames(h: Harness): EventsFrame[] {
  const seen: EventsFrame[] = [];
  attachLogAnnouncer(h.db, (frame) => seen.push(frame));
  return seen;
}

describe("the error log", () => {
  test("keeps what it was given, word for word", () => {
    const h = harness();
    logError(h.db, "run", "seikan exited 2 and said the document names a key nothing bound");

    const page = listErrors(h.db);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.scope).toBe("run");
    expect(page.entries[0]?.message).toBe(
      "seikan exited 2 and said the document names a key nothing bound",
    );
    expect(page.entries[0]?.detail).toBeNull();
    h.cleanup();
  });

  test("reads newest first", () => {
    const h = harness();
    logError(h.db, "http", "first");
    logError(h.db, "tool", "second");
    logError(h.db, "turn", "third");

    expect(listErrors(h.db).entries.map((e) => e.message)).toEqual(["third", "second", "first"]);
    h.cleanup();
  });

  test("renders an Error as its stack, and anything else as JSON", () => {
    const h = harness();
    logError(h.db, "tool", "a handler threw", new Error("no such thesis"));
    logError(h.db, "run", "a script failed", { exit_code: 2, script: "prices" });

    const [structured, thrown] = listErrors(h.db).entries;
    expect(structured?.detail).toBe(`{"exit_code":2,"script":"prices"}`);
    expect(thrown?.detail).toContain("no such thesis");
    h.cleanup();
  });

  test("never throws, whatever it is handed", async () => {
    const h = harness();
    const circular: Record<string, unknown> = { name: "loop" };
    circular["self"] = circular;

    expect(() => logError(h.db, "http", "a request failed", circular)).not.toThrow();
    expect(listErrors(h.db).entries).toHaveLength(1);

    // A database closed underneath it is the shape of the failure this promise is really about: a
    // logger reached from a shutdown path must not become the exception nobody catches.
    h.db.close();
    expect(() => logError(h.db, "http", "too late")).not.toThrow();
    await settle();
  });

  test("keeps the newest thousand and drops the rest", () => {
    const h = harness();
    for (let i = 0; i < LOG_CAP + 5; i += 1) logError(h.db, "turn", `failure ${i}`);

    const total = h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM error_log").get();
    expect(total?.n).toBe(LOG_CAP);

    const newest = listErrors(h.db, { limit: 1 }).entries[0];
    expect(newest?.message).toBe(`failure ${LOG_CAP + 4}`);

    const oldest = h.db
      .query<{ message: string }, []>("SELECT message FROM error_log ORDER BY id ASC LIMIT 1")
      .get();
    expect(oldest?.message).toBe("failure 5");
    h.cleanup();
  });
});

describe("the deletion log", () => {
  test("holds the whole row as JSON, including what nobody reads", () => {
    const h = harness();
    logDeletion(h.db, "report", "r1", {
      id: "r1",
      title: "A report",
      content: "<article>the whole document</article>",
    });

    const entry = listDeletions(h.db).entries[0];
    expect(entry?.table_name).toBe("report");
    expect(entry?.row_id).toBe("r1");
    expect(JSON.parse(entry?.row_json ?? "null")).toEqual({
      id: "r1",
      title: "A report",
      content: "<article>the whole document</article>",
    });
    h.cleanup();
  });

  test("takes the transaction down with it rather than letting a delete go unwitnessed", () => {
    const h = harness();
    // The name is the instrument's official one and is written at INSERT, because nothing can move
    // it afterwards — which is why this fixture states it rather than generating one.
    h.db
      .query("INSERT INTO target (name, ticker, added_at) VALUES ('Apple Inc.', 'AAPL', 1)")
      .run();

    expect(() =>
      tx(h.db, () => {
        h.db.query("DELETE FROM target WHERE ticker = 'AAPL'").run();
        // A row_json that is not JSON is a witness that witnesses nothing, and the CHECK says so.
        h.db
          .query("INSERT INTO deletion_log (at, table_name, row_id, row_json) VALUES (?, ?, ?, ?)")
          .run(1, "target", "AAPL", "not json");
      }),
    ).toThrow();

    const still = h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM target").get();
    expect(still?.n).toBe(1);
    expect(listDeletions(h.db).entries).toHaveLength(0);
    h.cleanup();
  });

  test("has its own thousand, and neither log crowds the other out", () => {
    const h = harness();
    logError(h.db, "tool", "one failure");
    for (let i = 0; i < LOG_CAP + 3; i += 1) logDeletion(h.db, "target", `T${i}`, { ticker: `T${i}` });

    const deletions = h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM deletion_log").get();
    const errors = h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM error_log").get();
    expect(deletions?.n).toBe(LOG_CAP);
    expect(errors?.n).toBe(1);
    h.cleanup();
  });

  test("outlives everything it describes, because it points at nothing", () => {
    const h = harness();
    logDeletion(h.db, "recipe", "gone", { id: "gone", name: "A recipe" });

    // Nothing in the schema can reach these rows, so nothing in the schema can take them away.
    const keys = h.db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM pragma_foreign_key_list('deletion_log')",
      )
      .get();
    expect(keys?.n).toBe(0);
    expect(listDeletions(h.db).entries).toHaveLength(1);
    h.cleanup();
  });
});

describe("paging a log", () => {
  test("walks backwards from a row the caller is holding", () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) logError(h.db, "turn", `failure ${i}`);

    const first = listErrors(h.db, { limit: 2 });
    expect(first.entries.map((e) => e.message)).toEqual(["failure 4", "failure 3"]);
    expect(first.hasMore).toBe(true);

    const next = listErrors(h.db, { limit: 2, before: first.entries[1]?.id });
    expect(next.entries.map((e) => e.message)).toEqual(["failure 2", "failure 1"]);
    expect(next.hasMore).toBe(true);

    const last = listErrors(h.db, { limit: 2, before: next.entries[1]?.id });
    expect(last.entries.map((e) => e.message)).toEqual(["failure 0"]);
    expect(last.hasMore).toBe(false);
    h.cleanup();
  });

  test("refuses a limit that asks for the whole log at once", () => {
    const h = harness();
    expect(refusal(() => listErrors(h.db, { limit: 0 })).kind).toBe("invalid_request");
    expect(refusal(() => listDeletions(h.db, { limit: 5000 })).message).toContain("between 1 and 200");
    expect(refusal(() => listErrors(h.db, { limit: 1.5 })).kind).toBe("invalid_request");
    h.cleanup();
  });
});

describe("what the tools wrapper subtracts", () => {
  test("counts the prune as well as the insert", () => {
    const h = harness();
    const before = logWrites(h.db);
    for (let i = 0; i < LOG_CAP; i += 1) logError(h.db, "turn", `failure ${i}`);
    const filled = logWrites(h.db) - before;
    expect(filled).toBe(LOG_CAP);

    // The thousand-and-first insert prunes one, so the counter has to move by two — a count that
    // missed the prune would come out too low, and a low count suppresses a real records_changed.
    logError(h.db, "turn", "one more");
    expect(logWrites(h.db) - before).toBe(LOG_CAP + 2);
    h.cleanup();
  });

  test("is kept per connection", () => {
    const one = harness();
    const other = harness();
    logError(one.db, "http", "only on the first");

    expect(logWrites(one.db)).toBeGreaterThan(0);
    expect(logWrites(other.db)).toBe(0);
    one.cleanup();
    other.cleanup();
  });
});

describe("announcing", () => {
  test("pokes once per write, after the transaction rather than inside it", async () => {
    const h = harness();
    const seen = frames(h);

    tx(h.db, () => {
      logDeletion(h.db, "target", "AAPL", { ticker: "AAPL" });
      // Still inside the transaction: nothing has been announced yet.
      expect(seen).toHaveLength(0);
    });
    await settle();

    expect(seen.map((f) => f.type)).toEqual(["deletion_logged"]);
    h.cleanup();
  });

  test("carries no body, so a window learns only that it should look", async () => {
    const h = harness();
    const seen = frames(h);
    logError(h.db, "tool", "a handler threw");
    await settle();

    expect(seen[0]).toEqual({ type: "error_logged", at: expect.any(Number) });
    h.cleanup();
  });

  test("tells only the connection it was attached to", async () => {
    const one = harness();
    const other = harness();
    const seen = frames(one);

    logError(other.db, "http", "on the other database");
    await settle();
    expect(seen).toHaveLength(0);

    logError(one.db, "http", "on this one");
    await settle();
    expect(seen).toHaveLength(1);
    one.cleanup();
    other.cleanup();
  });
});
