import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Kysely } from "kysely";
import { createDatabase, createKysely, type TestDB } from "./helpers.js";

describe("BunSqliteDialect concurrency", () => {
  let database: Database;
  let db: Kysely<TestDB>;

  beforeEach(() => {
    database = createDatabase();
    db = createKysely({ database });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("runs many queries in parallel on the single connection", async () => {
    await db
      .insertInto("person")
      .values(
        Array.from({ length: 20 }, (_, index) => ({
          name: `person-${index}`,
          age: index,
        })),
      )
      .execute();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        db
          .selectFrom("person")
          .select("name")
          .where("age", "=", index % 20)
          .executeTakeFirst(),
      ),
    );

    expect(results.map((row) => row?.name)).toEqual(Array.from({ length: 50 }, (_, index) => `person-${index % 20}`));
  });

  it("runs many inserts in parallel without losing rows", async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        db
          .insertInto("person")
          .values({ name: `person-${index}`, age: index })
          .execute(),
      ),
    );

    const { count } = await db
      .selectFrom("person")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();

    expect(count).toBe(50);
  });

  it("keeps parallel transactions isolated, committing and rolling back independently", async () => {
    const threads = Array.from({ length: 40 }, (_, index) => ({
      index,
      fails: index % 2 === 0,
    }));

    const results = await Promise.allSettled(
      threads.map(async ({ index, fails }) =>
        db.transaction().execute(async (trx) => {
          const person = await trx
            .insertInto("person")
            .values({ name: `person-${index}`, age: index })
            .returning("id")
            .executeTakeFirstOrThrow();

          await trx
            .insertInto("pet")
            .values({ name: `pet-${index}`, owner_id: person.id })
            .execute();

          if (fails) {
            throw new Error(`thread ${index} fails`);
          }
        }),
      ),
    );

    for (const { index, fails } of threads) {
      expect(results[index]?.status).toBe(fails ? "rejected" : "fulfilled");

      const person = await db
        .selectFrom("person")
        .select("id")
        .where("name", "=", `person-${index}`)
        .executeTakeFirst();
      const pet = await db.selectFrom("pet").select("id").where("name", "=", `pet-${index}`).executeTakeFirst();

      if (fails) {
        expect(person).toBeUndefined();
        expect(pet).toBeUndefined();
      } else {
        expect(person).toBeDefined();
        expect(pet).toBeDefined();
      }
    }
  });

  it("does not interleave a parallel query into an open transaction", async () => {
    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    const [, outside] = await Promise.all([
      db
        .transaction()
        .execute(async (trx) => {
          await trx.deleteFrom("person").execute();
          throw new Error("rollback");
        })
        .catch(() => {}),
      db.selectFrom("person").select("name").execute(),
    ]);

    // Whichever order the mutex grants, the rolled-back delete must never be
    // visible: either the select ran before the transaction, or after it undid.
    expect(outside).toEqual([{ name: "Jennifer" }]);
    expect(await db.selectFrom("person").select("name").execute()).toEqual([{ name: "Jennifer" }]);
  });
});
