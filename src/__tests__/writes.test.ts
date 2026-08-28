import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Kysely, sql } from "kysely";
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

  it("reports affected rows for a write that does not start with its verb", async () => {
    // A CTE-prefixed write is why the branch reads the statement's columns
    // rather than sniffing the SQL text: this one starts with `with`.
    const result = await db.executeQuery(
      sql`
        with source("name", "age") as (values (${"Jennifer"}, ${41}))
        insert into "person" ("name", "age") select "name", "age" from source
      `.compile(db),
    );

    expect(result.numAffectedRows).toBe(1n);
    expect(result.insertId).toBe(1n);
    expect(await db.selectFrom("person").select("name").execute()).toEqual([{ name: "Jennifer" }]);
  });

  it("reports affected rows for a CTE-prefixed update", async () => {
    await db
      .insertInto("person")
      .values([
        { name: "Jennifer", age: 41 },
        { name: "Arnold", age: 63 },
      ])
      .execute();

    const result = await db.executeQuery(
      sql`
        with old("name") as (values (${"Jennifer"}), (${"Arnold"}))
        update "person" set "age" = 50 where "name" in (select "name" from old)
      `.compile(db),
    );

    expect(result.numAffectedRows).toBe(2n);
  });

  it("returns every column from returningAll", async () => {
    const row = await db
      .insertInto("person")
      .values({ name: "Jennifer", age: 41 })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(row).toEqual({ id: 1, name: "Jennifer", age: 41 });
  });

  it("returns every column from an update with returningAll", async () => {
    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    const rows = await db
      .updateTable("person")
      .set({ age: 42 })
      .where("name", "=", "Jennifer")
      .returningAll()
      .execute();

    expect(rows).toEqual([{ id: 1, name: "Jennifer", age: 42 }]);
  });

  it("upserts on a composite conflict target using excluded values", async () => {
    await db.schema
      .createTable("recent_path")
      .addColumn("user_id", "integer", (col) => col.notNull())
      .addColumn("path", "text", (col) => col.notNull())
      .addColumn("label", "text")
      .addUniqueConstraint("recent_path_user_path", ["user_id", "path"])
      .execute();

    const upsert = (label: string) =>
      sql`
        insert into "recent_path" ("user_id", "path", "label") values (${1}, ${"/tmp"}, ${label})
        on conflict ("user_id", "path") do update set "label" = excluded."label"
      `.execute(db);

    await upsert("first");
    await upsert("second");

    const rows = await sql<{
      user_id: number;
      path: string;
      label: string;
    }>`select * from "recent_path"`.execute(db);

    expect(rows.rows).toEqual([{ user_id: 1, path: "/tmp", label: "second" }]);
  });

  it("stores a boolean-as-integer flag and a json string round-trip", async () => {
    await db.schema
      .createTable("plugin")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("enabled", "integer", (col) => col.notNull())
      .addColumn("config", "text", (col) => col.notNull())
      .execute();

    const config = { retries: 3, tags: ["a", "b"] };
    await sql`insert into "plugin" ("id", "enabled", "config") values (${"p1"}, ${1}, ${JSON.stringify(config)})`.execute(
      db,
    );

    const rows = await sql<{
      enabled: number;
      config: string;
    }>`select "enabled", "config" from "plugin"`.execute(db);

    expect(rows.rows[0]?.enabled).toBe(1);
    expect(JSON.parse(rows.rows[0]?.config ?? "")).toEqual(config);
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
