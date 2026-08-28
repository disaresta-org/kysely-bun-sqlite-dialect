import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Kysely } from "kysely";
import { createDatabase, createKysely, type TestDB } from "./helpers.js";

describe("BunSqliteDialect cancellation", () => {
  let db: Kysely<TestDB>;

  beforeEach(async () => {
    db = createKysely({ database: createDatabase() });
    await db
      .insertInto("person")
      .values([
        { name: "Jennifer", age: 41 },
        { name: "Arnold", age: 63 },
      ])
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("executes normally when given a signal that is not aborted", async () => {
    const rows = await db
      .selectFrom("person")
      .select("name")
      .orderBy("name")
      .execute({ signal: new AbortController().signal });

    expect(rows).toEqual([{ name: "Arnold" }, { name: "Jennifer" }]);
  });

  it("rejects with the abort reason when the signal is already aborted", async () => {
    const reason = new Error("no longer needed");

    const query = db
      .selectFrom("person")
      .selectAll()
      .execute({ signal: AbortSignal.abort(reason) });

    await expect(query).rejects.toThrow(reason);
  });

  it("reports where an already-aborted query stopped", async () => {
    const reason = new Error("no longer needed");

    try {
      await db
        .selectFrom("person")
        .selectAll()
        .execute({ signal: AbortSignal.abort(reason) });
      throw new Error("expected the query to reject");
    } catch (error) {
      expect((error as { __kysely_timing__?: string }).__kysely_timing__).toBe("before query execution");
    }
  });

  it("does not run the query when the signal is already aborted", async () => {
    const inserted = db
      .insertInto("person")
      .values({ name: "Sylvester", age: 76 })
      .execute({ signal: AbortSignal.abort(new Error("nope")) })
      .catch(() => {});

    await inserted;

    const rows = await db.selectFrom("person").select("name").execute();
    expect(rows.map((row) => row.name).sort()).toEqual(["Arnold", "Jennifer"]);
  });

  it("streams normally when given a signal that is not aborted", async () => {
    const streamed: string[] = [];

    for await (const row of db
      .selectFrom("person")
      .select("name")
      .orderBy("name")
      .stream({ chunkSize: 1, signal: new AbortController().signal })) {
      streamed.push(row.name);
    }

    expect(streamed).toEqual(["Arnold", "Jennifer"]);
  });

  it("rejects a stream whose signal is already aborted", async () => {
    const reason = new Error("gone");

    const consume = async () => {
      for await (const _row of db
        .selectFrom("person")
        .selectAll()
        .stream({ chunkSize: 1, signal: AbortSignal.abort(reason) })) {
        // noop
      }
    };

    await expect(consume()).rejects.toThrow(reason);
  });

  it("rejects a stream aborted part-way through", async () => {
    const controller = new AbortController();
    const reason = new Error("enough");

    const consume = async () => {
      for await (const _row of db
        .selectFrom("person")
        .selectAll()
        .stream({ chunkSize: 1, signal: controller.signal })) {
        controller.abort(reason);
      }
    };

    await expect(consume()).rejects.toThrow(reason);
  });

  it("runs a query through a reserved connection", async () => {
    const rows = await db
      .connection()
      .execute(async (connection) => connection.selectFrom("person").select("name").execute());

    expect(rows.map((row) => row.name).sort()).toEqual(["Arnold", "Jennifer"]);
  });

  it("reports the mutex as where an aborted reserved connection stopped", async () => {
    const reason = new Error("never mind");

    try {
      await db.connection().execute(async (connection) => connection.selectFrom("person").selectAll().execute(), {
        signal: AbortSignal.abort(reason),
      });
      throw new Error("expected the connection to reject");
    } catch (error) {
      expect((error as { __kysely_timing__?: string }).__kysely_timing__).toBe("before acquireConnection:mutex");
    }
  });

  it("keeps working after an aborted query", async () => {
    await db
      .selectFrom("person")
      .selectAll()
      .execute({ signal: AbortSignal.abort(new Error("nope")) })
      .catch(() => {});

    const rows = await db.selectFrom("person").select("name").orderBy("name").execute();
    expect(rows).toEqual([{ name: "Arnold" }, { name: "Jennifer" }]);
  });
});
