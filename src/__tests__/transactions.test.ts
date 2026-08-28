import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type DatabaseConnection, Kysely, sql } from "kysely";
import { BunSqliteDialect, BunSqliteDriver } from "../index.js";
import { createDatabase, createKysely, recordSql, type TestDB } from "./helpers.js";

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

const names = () => db.selectFrom("person").select("name").orderBy("name").execute();

describe("BunSqliteDialect transactions", () => {
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
    // Two Kysely instances over one Database each get their own connection
    // mutex, so they do not serialize against each other. Fine here because
    // usage is sequential; not a pattern to copy into concurrent code.
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

describe("BunSqliteDialect transaction contract", () => {
  it("does not roll back a transaction that failed to begin", async () => {
    const base = new BunSqliteDialect({ database });
    let rollbacks = 0;
    let callbackRuns = 0;

    class FailingBeginDriver extends BunSqliteDriver {
      override async beginTransaction(): Promise<void> {
        throw new Error("could not begin");
      }

      override async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
        rollbacks++;
        await super.rollbackTransaction(connection);
      }
    }

    const failing = new Kysely<TestDB>({
      dialect: {
        createDriver: () => new FailingBeginDriver({ database }),
        createAdapter: () => base.createAdapter(),
        createIntrospector: (kysely) => base.createIntrospector(kysely),
        createQueryCompiler: () => base.createQueryCompiler(),
      },
    });

    await expect(
      failing.transaction().execute(async () => {
        callbackRuns++;
      }),
    ).rejects.toThrow("could not begin");

    expect(callbackRuns).toBe(0);
    expect(rollbacks).toBe(0);
  });

  it("refuses to run a query after the transaction is committed", async () => {
    let escaped: Kysely<TestDB> | undefined;

    await db.transaction().execute(async (trx) => {
      escaped = trx;
      await trx.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
    });

    await expect(escaped?.insertInto("person").values({ name: "Arnold", age: 63 }).execute()).rejects.toThrow(
      /already committed/,
    );
  });

  it("refuses to run a query after the transaction is rolled back", async () => {
    let escaped: Kysely<TestDB> | undefined;

    await db
      .transaction()
      .execute(async (trx) => {
        escaped = trx;
        await trx.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
        throw new Error("rollback");
      })
      .catch(() => {});

    await expect(escaped?.insertInto("person").values({ name: "Arnold", age: 63 }).execute()).rejects.toThrow(
      /rolled back/,
    );
  });

  it("keeps work done before a released savepoint", async () => {
    const trx = await db.startTransaction().execute();

    await trx.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
    const savepoint = await trx.savepoint("after_jennifer").execute();
    await savepoint.insertInto("person").values({ name: "Arnold", age: 63 }).execute();
    await savepoint.releaseSavepoint("after_jennifer").execute();
    await trx.commit().execute();

    expect(await names()).toEqual([{ name: "Arnold" }, { name: "Jennifer" }]);
  });

  it("rolls the whole transaction back even after a savepoint was released", async () => {
    const trx = await db.startTransaction().execute();

    await trx.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
    const savepoint = await trx.savepoint("after_jennifer").execute();
    await savepoint.insertInto("person").values({ name: "Arnold", age: 63 }).execute();
    await savepoint.releaseSavepoint("after_jennifer").execute();
    await trx.rollback().execute();

    expect(await names()).toEqual([]);
  });

  it("keeps a failed statement inside a transaction from killing the transaction", async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

      await expect(trx.insertInto("person").values({ name: "Jennifer", age: 42 }).execute()).rejects.toMatchObject({
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });

      await trx.insertInto("person").values({ name: "Arnold", age: 63 }).execute();
    });

    expect(await names()).toEqual([{ name: "Arnold" }, { name: "Jennifer" }]);
  });

  it("retains the userland stack on an error raised inside a transaction", async () => {
    try {
      await db.transaction().execute(async (trx) => {
        await trx.selectFrom("person").select(sql<string>`no_such_column`.as("x")).execute();
      });
      throw new Error("expected the transaction to fail");
    } catch (error) {
      expect((error as Error).stack).toContain("transactions.test.ts");
    }
  });
});
