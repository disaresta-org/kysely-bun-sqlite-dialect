import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { createDatabase, createKysely, type TestDB } from "./helpers.js";

describe("BunSqliteDialect injection containment", () => {
  let database: Database;
  let db: Kysely<TestDB>;

  beforeEach(async () => {
    database = createDatabase();
    db = createKysely({ database });
    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  const tableExists = (name: string) =>
    database.query("select name from sqlite_master where name = ?").all(name).length === 1;

  it("does not drop a table through an injected table name", async () => {
    const query = sql`select * from ${sql.table(`person"; drop table person --`)}`.compile(db);

    expect(query.sql).toBe(`select * from "person""; drop table person --"`);
    await expect(db.executeQuery(query)).rejects.toThrow();

    expect(tableExists("person")).toBe(true);
  });

  it("does not drop a table through an injected column reference", async () => {
    const query = sql`select ${sql.ref(`name"; drop table person --`)} from person`.compile(db);

    expect(query.sql).toBe(`select "name""; drop table person --" from person`);

    // SQLite as bun ships it (DQS=3) accepts an unresolvable double-quoted
    // identifier as a string literal rather than raising, so this resolves to
    // the literal text. Nothing is executed and nothing is dropped.
    const result = await db.executeQuery<Record<string, string>>(query);
    expect(Object.values(result.rows[0] ?? {})).toEqual([`name"; drop table person --`]);

    expect(tableExists("person")).toBe(true);
  });

  it("treats an unknown quoted identifier as a string, not an error", async () => {
    // SQLite's double-quoted-string misfeature is enabled in Bun's build, so a
    // mistyped column silently yields its own name as a value. better-sqlite3
    // compiles with SQLITE_DQS=0 and raises "no such column" instead. Pinned so
    // the difference is visible if bun ever changes it.
    //
    // Asserted as behavior rather than by reading `pragma compile_options`:
    // which options that pragma reports varies by platform build. macOS lists
    // DQS=3 explicitly; Linux omits it and inherits the same SQLite default.
    const result = await sql<{ nope: string }>`select "nope" from "person"`.execute(db);

    expect(Object.values(result.rows[0] ?? {})).toEqual(["nope"]);
  });

  it("does not drop a table through an injected literal", async () => {
    const query = db.selectFrom("person").where("name", "=", sql.lit(`Jennifer'; drop table person --`)).selectAll();

    expect(query.compile().sql).toBe(`select * from "person" where "name" = 'Jennifer''; drop table person --'`);
    expect(await query.execute()).toEqual([]);

    expect(tableExists("person")).toBe(true);
  });

  it("runs only the first statement of a multi-statement query", async () => {
    // bun:sqlite prepares a single statement, so a trailing statement smuggled
    // past the compiler must never execute.
    await db.executeQuery(CompiledQuery.raw(`select * from "person"; drop table "person"`)).catch(() => {});

    expect(tableExists("person")).toBe(true);
  });

  it("does not execute a second statement smuggled into a write", async () => {
    await db
      .executeQuery(CompiledQuery.raw(`insert into "person" ("name", "age") values ('x', 1); drop table "pet"`))
      .catch(() => {});

    expect(tableExists("pet")).toBe(true);
  });

  it("round-trips a column name that needs quote escaping", async () => {
    await db.schema.createTable("quoted").addColumn(`odd"name`, "text").addColumn(`odder""name`, "text").execute();

    await sql`insert into "quoted" (${sql.ref(`odd"name`)}, ${sql.ref(`odder""name`)}) values (${"a"}, ${"b"})`.execute(
      db,
    );

    const result = await sql<Record<string, string>>`select * from "quoted"`.execute(db);

    expect(result.rows).toEqual([{ 'odd"name': "a", 'odder""name': "b" }]);
  });

  it("keeps a savepoint name with a quote from breaking out", async () => {
    const trx = await db.startTransaction().execute();
    const savepoint = await trx.savepoint(`sp"; drop table person --`).execute();

    await savepoint.insertInto("person").values({ name: "Arnold", age: 63 }).execute();
    await savepoint.rollbackToSavepoint(`sp"; drop table person --`).execute();
    await trx.commit().execute();

    expect(tableExists("person")).toBe(true);
    expect(await db.selectFrom("person").select("name").execute()).toEqual([{ name: "Jennifer" }]);
  });
});
