import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { BunSqliteDialect, BunSqliteDriver } from "../index.js";
import { createDatabase, createKysely } from "./helpers.js";

describe("BunSqliteDialect lifecycle", () => {
  it("accepts a database instance", async () => {
    const database = createDatabase();
    const db = createKysely({ database });

    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    expect(await db.selectFrom("person").select("name").execute()).toEqual([{ name: "Jennifer" }]);

    await db.destroy();
  });

  it("does not call a database factory until the first query", async () => {
    let calls = 0;
    const db = createKysely({
      database: async () => {
        calls++;
        return createDatabase();
      },
    });

    expect(calls).toBe(0);

    await db.selectFrom("person").selectAll().execute();

    expect(calls).toBe(1);

    await db.destroy();
  });

  it("calls a database factory only once across many queries", async () => {
    let calls = 0;
    const db = createKysely({
      database: async () => {
        calls++;
        return createDatabase();
      },
    });

    await db.selectFrom("person").selectAll().execute();
    await db.selectFrom("person").selectAll().execute();
    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    expect(calls).toBe(1);

    await db.destroy();
  });

  it("runs onCreateConnection once, before the first query", async () => {
    const order: string[] = [];
    const db = createKysely({
      database: createDatabase(),
      onCreateConnection: async (connection) => {
        order.push("onCreateConnection");
        expect(connection).toBeDefined();
      },
    });

    await db.selectFrom("person").selectAll().execute();
    order.push("query");
    await db.selectFrom("person").selectAll().execute();

    expect(order).toEqual(["onCreateConnection", "query"]);

    await db.destroy();
  });

  it("closes the database on destroy", async () => {
    const database = createDatabase();
    const db = createKysely({ database });

    await db.selectFrom("person").selectAll().execute();
    await db.destroy();

    expect(() => database.query("select 1").all()).toThrow();
  });

  it("does not throw when destroying a driver that was never initialized", async () => {
    const driver = new BunSqliteDriver({ database: new Database(":memory:") });

    await driver.destroy();
  });

  it("refuses to hand out a connection before init", async () => {
    const driver = new BunSqliteDriver({ database: new Database(":memory:") });

    await expect(driver.acquireConnection()).rejects.toThrow(/init/);
  });
});

describe("BunSqliteDialect config validation", () => {
  it("rejects a missing database", () => {
    expect(() => new BunSqliteDialect({ database: undefined as never })).toThrow(/database/);
  });

  it("rejects an object that is not a bun:sqlite Database", () => {
    // The likeliest wrong value is a better-sqlite3 Database, mid-migration.
    // It has `prepare` but no `query`.
    expect(() => new BunSqliteDialect({ database: { prepare: () => {} } as never })).toThrow(/database/);
  });

  it("accepts a database factory", () => {
    expect(() => new BunSqliteDialect({ database: async () => createDatabase() })).not.toThrow();
  });

  it("validates the database when the driver is constructed directly", () => {
    expect(() => new BunSqliteDriver({ database: {} as never })).toThrow(/database/);
  });

  it("validates transactionBehavior when the driver is constructed directly", () => {
    expect(
      () =>
        new BunSqliteDriver({
          database: new Database(":memory:"),
          transactionBehavior: "whenever" as never,
        }),
    ).toThrow(/transactionBehavior/);
  });
});
