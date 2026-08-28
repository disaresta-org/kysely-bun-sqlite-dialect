import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Kysely } from "kysely";
import { createDatabase, createKysely, type TestDB } from "./helpers.js";

describe("BunSqliteDialect writes", () => {
  let database: Database;
  let db: Kysely<TestDB>;

  beforeEach(() => {
    database = createDatabase();
    db = createKysely({ database });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("reports the inserted row id", async () => {
    const result = await db.insertInto("person").values({ name: "Jennifer", age: 41 }).executeTakeFirstOrThrow();

    expect(result.insertId).toBe(1n);
    expect(result.numInsertedOrUpdatedRows).toBe(1n);
  });

  it("reports the row id of the most recent insert", async () => {
    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
    const result = await db.insertInto("person").values({ name: "Arnold", age: 63 }).executeTakeFirstOrThrow();

    expect(result.insertId).toBe(2n);
  });

  it("reports the number of rows an update affected", async () => {
    await db
      .insertInto("person")
      .values([
        { name: "Jennifer", age: 41 },
        { name: "Arnold", age: 63 },
      ])
      .execute();

    const result = await db.updateTable("person").set({ age: 50 }).where("age", ">", 40).executeTakeFirstOrThrow();

    expect(result.numUpdatedRows).toBe(2n);
  });

  it("reports the number of rows a delete affected", async () => {
    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    const result = await db.deleteFrom("person").where("name", "=", "Jennifer").executeTakeFirstOrThrow();

    expect(result.numDeletedRows).toBe(1n);
  });

  it("reports zero affected rows when an update matches nothing", async () => {
    const result = await db
      .updateTable("person")
      .set({ age: 50 })
      .where("name", "=", "nobody")
      .executeTakeFirstOrThrow();

    expect(result.numUpdatedRows).toBe(0n);
  });

  it("returns rows from an insert with a returning clause", async () => {
    const row = await db
      .insertInto("person")
      .values({ name: "Jennifer", age: 41 })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();

    expect(row).toEqual({ id: 1, name: "Jennifer" });
  });

  it("returns rows from a delete with a returning clause", async () => {
    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    const rows = await db.deleteFrom("person").returning("name").execute();

    expect(rows).toEqual([{ name: "Jennifer" }]);
  });

  it("applies on conflict do update", async () => {
    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    await db
      .insertInto("person")
      .values({ name: "Jennifer", age: 42 })
      .onConflict((oc) => oc.column("name").doUpdateSet({ age: 42 }))
      .execute();

    const rows = await db.selectFrom("person").select(["name", "age"]).execute();

    expect(rows).toEqual([{ name: "Jennifer", age: 42 }]);
  });

  it("executes ddl through the schema builder", async () => {
    await db.schema
      .createTable("toy")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    expect(database.query(`select name from sqlite_master where name = 'toy'`).all()).toEqual([{ name: "toy" }]);
  });
});
