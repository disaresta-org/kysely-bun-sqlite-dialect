import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Kysely } from "kysely";
import { createDatabase, createKysely, type TestDB } from "./helpers.js";

// One fresh in-memory database per test, shared by every group in this file.
let database: Database;
let db: Kysely<TestDB>;

beforeEach(() => {
  database = createDatabase();
  db = createKysely({ database });
});

afterEach(async () => {
  await db.destroy();
});

describe("BunSqliteDialect streaming", () => {
  it("streams every row of a select", async () => {
    await db
      .insertInto("person")
      .values([
        { name: "Jennifer", age: 41 },
        { name: "Arnold", age: 63 },
      ])
      .execute();

    const streamed: string[] = [];
    for await (const row of db.selectFrom("person").select("name").orderBy("name").stream()) {
      streamed.push(row.name);
    }

    expect(streamed).toEqual(["Arnold", "Jennifer"]);
  });

  it("streams rows matching a parameterized where clause", async () => {
    await db
      .insertInto("person")
      .values([
        { name: "Jennifer", age: 41 },
        { name: "Arnold", age: 63 },
      ])
      .execute();

    const streamed: string[] = [];
    for await (const row of db.selectFrom("person").select("name").where("age", ">", 50).stream()) {
      streamed.push(row.name);
    }

    expect(streamed).toEqual(["Arnold"]);
  });

  it("streams lazily, one row at a time", async () => {
    await db
      .insertInto("person")
      .values([
        { name: "Jennifer", age: 41 },
        { name: "Arnold", age: 63 },
        { name: "Sylvester", age: 76 },
      ])
      .execute();

    const stream = db.selectFrom("person").select("name").orderBy("name").stream();

    const first = await stream.next();
    expect(first.value).toEqual({ name: "Arnold" });

    await stream.return?.(undefined);
  });

  it("streams nothing when a select matches nothing", async () => {
    const streamed: unknown[] = [];
    for await (const row of db.selectFrom("person").selectAll().stream()) {
      streamed.push(row);
    }

    expect(streamed).toEqual([]);
  });

  it("refuses to stream anything but a select", async () => {
    const stream = db.insertInto("person").values({ name: "Jennifer", age: 41 }).stream();

    await expect(stream.next()).rejects.toThrow(/only supports streaming of select queries/);
  });
});

describe("BunSqliteDialect stream cursors", () => {
  it("starts a later stream of the same sql from the first row", async () => {
    await db
      .insertInto("person")
      .values([
        { name: "Jennifer", age: 41 },
        { name: "Arnold", age: 63 },
        { name: "Sylvester", age: 76 },
      ])
      .execute();

    const query = db.selectFrom("person").select("name").orderBy("name");

    // Abandoning a stream part-way leaves its cursor mid-iteration. A cached
    // statement would hand that same cursor to the next stream of this sql.
    const abandoned = query.stream();
    expect((await abandoned.next()).value).toEqual({ name: "Arnold" });
    await abandoned.return?.(undefined);

    const streamed: string[] = [];
    for await (const row of query.stream()) {
      streamed.push(row.name);
    }

    expect(streamed).toEqual(["Arnold", "Jennifer", "Sylvester"]);
  });

  it("does not disturb a stream when the same sql is executed after it ends", async () => {
    await db
      .insertInto("person")
      .values([
        { name: "Jennifer", age: 41 },
        { name: "Arnold", age: 63 },
      ])
      .execute();

    const query = db.selectFrom("person").select("name").orderBy("name");

    const first: string[] = [];
    for await (const row of query.stream()) {
      first.push(row.name);
    }
    await query.execute();
    const second: string[] = [];
    for await (const row of query.stream()) {
      second.push(row.name);
    }

    expect(first).toEqual(["Arnold", "Jennifer"]);
    expect(second).toEqual(["Arnold", "Jennifer"]);
  });
});
