import { describe, expect, it } from "bun:test";

import { Num } from "../index.js";

describe("Num", () => {
  it("holds its value", () => {
    expect(new Num(7).val()).toBe(7);
  });

  it("adds in place and returns itself for chaining", () => {
    const n = new Num(1);
    expect(n.add(new Num(2)).add(new Num(3))).toBe(n);
    expect(n.val()).toBe(6);
  });

  it("sums an array", () => {
    expect(Num.addAll([new Num(40), new Num(2)]).val()).toBe(42);
  });

  it("sums an empty array to zero", () => {
    expect(Num.addAll([]).val()).toBe(0);
  });

  it("stringifies to its value", () => {
    expect(`${new Num(42)}`).toBe("42");
  });
});
