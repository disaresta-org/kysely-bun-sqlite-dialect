import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../index.js";
import type { TestDB } from "./helpers.js";

/**
 * Everything else in this suite runs against `:memory:`. These tests use a real
 * file because WAL, `foreign_keys`, and two handles on one database are exactly
 * what an in-memory database cannot exercise — and they are what production
 * setups actually do at open time.
 */
function openDatabase(path: string): Database {
  const database = new Database(path);

  database.exec("pragma journal_mode = WAL");
  database.exec("pragma foreign_keys = ON");

  return database;
}

function applySchema(database: Database): void {
  database.run(`
    create table if not exists "person" (
      "id" integer primary key autoincrement,
      "name" text not null unique,
      "age" integer not null
    )
  `);
  database.run(`
    create table if not exists "pet" (
      "id" integer primary key autoincrement,
      "name" text not null,
      "owner_id" integer not null references "person" ("id")
    )
  `);
}

describe("BunSqliteDialect against a file-backed database", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "kysely-bun-sqlite-"));
    path = join(directory, "app.db");
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  const connect = (database: Database, behavior?: "immediate" | "exclusive") =>
    new Kysely<TestDB>({
      dialect: new BunSqliteDialect({ database, transactionBehavior: behavior }),
    });

  it("opens the database lazily through a factory that applies pragmas", async () => {
    let opened = 0;
    const db = new Kysely<TestDB>({
      dialect: new BunSqliteDialect({
        database: async () => {
          opened++;
          const database = openDatabase(path);
          applySchema(database);
          return database;
        },
      }),
    });

    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    expect(opened).toBe(1);
    expect(await db.selectFrom("person").select("name").execute()).toEqual([{ name: "Jennifer" }]);

    await db.destroy();
  });

  it("reports WAL as the journal mode", async () => {
    const database = openDatabase(path);
    applySchema(database);
    const db = connect(database);

    const result = await sql<{ journal_mode: string }>`pragma journal_mode`.execute(db);

    expect(result.rows).toEqual([{ journal_mode: "wal" }]);

    await db.destroy();
  });

  it("enforces foreign keys when the pragma is on", async () => {
    const database = openDatabase(path);
    applySchema(database);
    const db = connect(database);

    const orphan = db.insertInto("pet").values({ name: "Catto", owner_id: 999 }).execute();

    await expect(orphan).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });

    await db.destroy();
  });

  it("persists committed data across connections", async () => {
    const first = openDatabase(path);
    applySchema(first);
    const writer = connect(first);
    await writer.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
    await writer.destroy();

    const second = openDatabase(path);
    const reader = connect(second);

    expect(await reader.selectFrom("person").select("name").execute()).toEqual([{ name: "Jennifer" }]);

    await reader.destroy();
  });

  it("discards a rolled-back transaction on disk", async () => {
    const database = openDatabase(path);
    applySchema(database);
    const db = connect(database);

    await db
      .transaction()
      .execute(async (trx) => {
        await trx.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
        throw new Error("rollback");
      })
      .catch(() => {});
    await db.destroy();

    const reopened = connect(openDatabase(path));
    expect(await reopened.selectFrom("person").selectAll().execute()).toEqual([]);
    await reopened.destroy();
  });

  it("lets two handles on one database see each other's writes", async () => {
    // What an app that also hands a second connection to an auth library does.
    const first = openDatabase(path);
    applySchema(first);
    const app = connect(first);
    const auth = connect(openDatabase(path));

    await app.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    expect(await auth.selectFrom("person").select("name").execute()).toEqual([{ name: "Jennifer" }]);

    await auth.insertInto("person").values({ name: "Arnold", age: 63 }).execute();

    expect((await app.selectFrom("person").select("name").orderBy("name").execute()).map((row) => row.name)).toEqual([
      "Arnold",
      "Jennifer",
    ]);

    await app.destroy();
    await auth.destroy();
  });

  it("commits an immediate transaction while a second handle reads", async () => {
    const first = openDatabase(path);
    applySchema(first);
    const app = connect(first, "immediate");
    const auth = connect(openDatabase(path));

    await app.transaction().execute(async (trx) => {
      await trx.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
      // WAL lets a reader on another handle proceed against the last commit.
      expect(await auth.selectFrom("person").selectAll().execute()).toEqual([]);
    });

    expect(await auth.selectFrom("person").select("name").execute()).toEqual([{ name: "Jennifer" }]);

    await app.destroy();
    await auth.destroy();
  });

  it("surfaces write contention as SQLITE_BUSY rather than hanging", async () => {
    const first = openDatabase(path);
    applySchema(first);
    // busy_timeout 0 makes the contention deterministic instead of timing out.
    const second = openDatabase(path);
    second.exec("pragma busy_timeout = 0");

    const holder = connect(first, "immediate");
    const contender = connect(second, "immediate");

    const held = await holder.startTransaction().execute();
    await held.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    const blocked = contender
      .transaction()
      .execute(async (trx) => trx.insertInto("person").values({ name: "Arnold", age: 63 }).execute());

    await expect(blocked).rejects.toMatchObject({ code: "SQLITE_BUSY" });

    await held.commit().execute();

    // The write lock is free again, so the same connection now succeeds.
    await contender.insertInto("person").values({ name: "Arnold", age: 63 }).execute();
    expect(
      (await contender.selectFrom("person").select("name").orderBy("name").execute()).map((row) => row.name),
    ).toEqual(["Arnold", "Jennifer"]);

    await holder.destroy();
    await contender.destroy();
  });
});
