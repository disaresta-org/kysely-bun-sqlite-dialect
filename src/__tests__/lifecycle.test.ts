import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { BunSqliteDriver } from "../index.js";
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
