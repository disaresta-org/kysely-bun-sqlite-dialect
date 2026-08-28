import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Kysely } from "kysely";
import { BunSqliteDialect } from "../index.js";
import { createDatabase, createKysely, recordSql, type TestDB } from "./helpers.js";

describe("BunSqliteDialect transactions", () => {
  let database: Database;
  let db: Kysely<TestDB>;

  beforeEach(() => {
    database = createDatabase();
    db = createKysely({ database });
  });

  afterEach(async () => {
    await db.destroy();
  });

  const names = () => db.selectFrom("person").select("name").orderBy("name").execute();

  it("commits a transaction", async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
      await trx.insertInto("person").values({ name: "Arnold", age: 63 }).execute();
    });

    expect(await names()).toEqual([{ name: "Arnold" }, { name: "Jennifer" }]);
  });

  it("rolls a transaction back when the callback throws", async () => {
    const boom = new Error("boom");

    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
        throw boom;
      }),
    ).rejects.toThrow(boom);

    expect(await names()).toEqual([]);
  });

  it("returns the callback's value from a transaction", async () => {
    const result = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("person")
        .values({ name: "Jennifer", age: 41 })
        .returning("id")
        .executeTakeFirstOrThrow();
      return row.id;
    });

    expect(result).toBe(1);
  });

  it("rolls back to a savepoint without losing the enclosing transaction", async () => {
    const trx = await db.startTransaction().execute();

    await trx.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    const afterJennifer = await trx.savepoint("after_jennifer").execute();
    await afterJennifer.insertInto("person").values({ name: "Arnold", age: 63 }).execute();
    await afterJennifer.rollbackToSavepoint("after_jennifer").execute();
    await afterJennifer.releaseSavepoint("after_jennifer").execute();

    await trx.commit().execute();

    expect(await names()).toEqual([{ name: "Jennifer" }]);
  });

  it("quotes a savepoint name instead of interpolating it", async () => {
    const recorded = recordSql(database);
    const trx = await db.startTransaction().execute();

    const savepoint = await trx.savepoint('he said "hi"').execute();
    await savepoint.releaseSavepoint('he said "hi"').execute();
    await trx.commit().execute();

    expect(recorded).toContain('savepoint "he said ""hi"""');
    expect(recorded).toContain('release "he said ""hi"""');
  });

  it("begins a plain deferred transaction by default", async () => {
    const recorded = recordSql(database);

    await db.transaction().execute(async () => {});

    expect(recorded).toContain("begin");
  });

  it("begins an immediate transaction when configured to", async () => {
    const recorded = recordSql(database);
    const immediate = createKysely({ database, transactionBehavior: "immediate" });

    await immediate.transaction().execute(async () => {});

    expect(recorded).toContain("begin immediate");
  });

  it("begins an exclusive transaction when configured to", async () => {
    const recorded = recordSql(database);
    const exclusive = createKysely({ database, transactionBehavior: "exclusive" });

    await exclusive.transaction().execute(async () => {});

    expect(recorded).toContain("begin exclusive");
  });

  it("rejects an unknown transaction behavior when constructed", () => {
    expect(
      () =>
        new BunSqliteDialect({
          database,
          transactionBehavior: "eventually" as never,
        }),
    ).toThrow(/transactionBehavior/);
  });
});
