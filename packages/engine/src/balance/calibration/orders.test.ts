import { describe, expect, it } from "vitest";

import { anticipate, delay, expandItems, isValidOrder, randomOrders, referenceOrder } from "./orders";
import type { OrderItem, ShopEntry, ShopOrder } from "./types";

const shop: ShopEntry[] = [
  { code: "a", maxLevel: 2 },
  { code: "b", maxLevel: 1 },
  { code: "c", maxLevel: 3 },
];
const costs: Record<string, number> = { a1: 1, a2: 10, b1: 3, c1: 2, c2: 4, c3: 20 };
const costOf = (item: OrderItem): number => costs[`${item.code}${item.level}`]!;
const text = (order: ShopOrder): string => order.map((i) => `${i.code}${i.level}`).join(" ");

describe("calibration orders", () => {
  it("expands the shop into items, levels in order", () => {
    const items = expandItems(shop);
    expect(items).toHaveLength(6);
    expect(text(items)).toBe("a1 a2 b1 c1 c2 c3");
  });

  it("builds the reference order by increasing cost", () => {
    expect(text(referenceOrder(shop, costOf))).toBe("a1 c1 b1 c2 a2 c3");
  });

  it("anticipates the first level of a code", () => {
    const ref = referenceOrder(shop, costOf);
    expect(text(anticipate(ref, "b"))).toBe("b1 a1 c1 c2 a2 c3");
  });

  it("delays every level of a code to the end", () => {
    const ref = referenceOrder(shop, costOf);
    expect(text(delay(ref, "a"))).toBe("c1 b1 c2 c3 a1 a2");
  });

  it("validates level sequencing", () => {
    expect(isValidOrder(referenceOrder(shop, costOf))).toBe(true);
    expect(
      isValidOrder([
        { code: "a", level: 2 },
        { code: "a", level: 1 },
      ]),
    ).toBe(false);
    expect(
      isValidOrder([
        { code: "a", level: 1 },
        { code: "a", level: 1 },
      ]),
    ).toBe(false);
  });

  it("generates valid, distinct, seeded random orders", () => {
    const first = randomOrders(shop, 20, 42);
    expect(first).toHaveLength(20);
    expect(first.every(isValidOrder)).toBe(true);
    expect(first.every((o) => o.length === 6)).toBe(true);
    expect(new Set(first.map(text)).size).toBe(20);
    expect(randomOrders(shop, 20, 42)).toEqual(first);
    expect(randomOrders(shop, 20, 43).map(text)).not.toEqual(first.map(text));
  });

  it("returns at most the distinct valid orders, without hanging", () => {
    const small: ShopEntry[] = [
      { code: "x", maxLevel: 1 },
      { code: "y", maxLevel: 1 },
    ];
    expect(randomOrders(small, 10, 1).length).toBeLessThanOrEqual(2);
    expect(randomOrders(small, 10, 1)).toHaveLength(2);
    expect(randomOrders(small, 0, 1)).toEqual([]);
  });
});
