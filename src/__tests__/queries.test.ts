import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Kysely } from "kysely";
import { createDatabase, createKysely, type TestDB } from "./helpers.js";

describe("BunSqliteDialect queries", () => {
  let database: Database;
  let db: Kysely<TestDB>;

  beforeEach(() => {
    database = createDatabase();
    db = createKysely({ database });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns rows from a select", async () => {
    database.run(`insert into "person" ("name", "age") values ('Jennifer', 41)`);

    const rows = await db.selectFrom("person").selectAll().execute();

    expect(rows).toEqual([{ id: 1, name: "Jennifer", age: 41 }]);
  });

  it("returns rows from a select with parameters", async () => {
    database.run(`insert into "person" ("name", "age") values ('Jennifer', 41), ('Arnold', 63)`);

    const rows = await db.selectFrom("person").select("name").where("age", ">", 50).execute();

    expect(rows).toEqual([{ name: "Arnold" }]);
  });

  it("returns an empty array when a select matches nothing", async () => {
    const rows = await db.selectFrom("person").selectAll().execute();

    expect(rows).toEqual([]);
  });

  it("returns rows from a join", async () => {
    database.run(`insert into "person" ("name", "age") values ('Jennifer', 41)`);
    database.run(`insert into "pet" ("name", "owner_id") values ('Catto', 1)`);

    const rows = await db
      .selectFrom("person")
      .innerJoin("pet", "pet.owner_id", "person.id")
      .select(["person.name as owner", "pet.name as pet"])
      .execute();

    expect(rows).toEqual([{ owner: "Jennifer", pet: "Catto" }]);
  });
});
