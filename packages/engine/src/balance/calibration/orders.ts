/**
 * Purchase orders of a prestige shop: reference, perturbations and seeded
 * random orders. Pure functions, no dependency on the Engine.
 */
import type { OrderItem, ShopEntry, ShopOrder } from "./types";

/** Stable key of an order, used to compare and cache orders. */
export const keyOf = (order: ShopOrder): string => order.map((i) => `${i.code}:${i.level}`).join("|");

/** Every item of the shop, levels in order (1..maxLevel), codes in shop order. */
export function expandItems(shop: ShopEntry[]): OrderItem[] {
  const items: OrderItem[] = [];
  for (const entry of shop) {
    for (let level = 1; level <= entry.maxLevel; level++) items.push({ code: entry.code, level });
  }
  return items;
}

/** Level k+1 of a code always follows level k, and each item appears once. */
export function isValidOrder(order: ShopOrder): boolean {
  const next = new Map<string, number>();
  for (const { code, level } of order) {
    if (level !== (next.get(code) ?? 1)) return false;
    next.set(code, level + 1);
  }
  return true;
}

/**
 * Increasing cost; ties keep the shop order. Picks the cheapest available
 * next level each time, so level order holds even if costs are not monotonic.
 */
export function referenceOrder(shop: ShopEntry[], costOf: (item: OrderItem) => number): ShopOrder {
  const next = shop.map(() => 1);
  const order: ShopOrder = [];
  const total = shop.reduce((sum, e) => sum + e.maxLevel, 0);
  while (order.length < total) {
    let best = -1;
    let bestCost = Infinity;
    for (let i = 0; i < shop.length; i++) {
      if (next[i]! > shop[i]!.maxLevel) continue;
      const cost = costOf({ code: shop[i]!.code, level: next[i]! });
      if (best === -1 || cost < bestCost) {
        best = i;
        bestCost = cost;
      }
    }
    order.push({ code: shop[best]!.code, level: next[best]! });
    next[best]!++;
  }
  return order;
}

/** The first level of `code` moves to the head. */
export function anticipate(order: ShopOrder, code: string): ShopOrder {
  const index = order.findIndex((i) => i.code === code);
  if (index <= 0) return [...order];
  return [order[index]!, ...order.slice(0, index), ...order.slice(index + 1)];
}

/** Every level of `code` moves to the tail, internal order unchanged. */
export function delay(order: ShopOrder, code: string): ShopOrder {
  return [...order.filter((i) => i.code !== code), ...order.filter((i) => i.code === code)];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Valid, distinct random orders from a seeded PRNG: at most
 * min(count, distinct valid orders); attempts are capped, so it never loops.
 */
export function randomOrders(shop: ShopEntry[], count: number, seed: number): ShopOrder[] {
  const result: ShopOrder[] = [];
  const seen = new Set<string>();
  const random = mulberry32(seed);
  const total = shop.reduce((sum, e) => sum + e.maxLevel, 0);
  const maxAttempts = Math.max(count, 1) * 50 + 100;
  for (let attempt = 0; attempt < maxAttempts && result.length < count; attempt++) {
    const next = shop.map(() => 1);
    const order: ShopOrder = [];
    while (order.length < total) {
      const open = shop.map((_, i) => i).filter((i) => next[i]! <= shop[i]!.maxLevel);
      const pick = open[Math.floor(random() * open.length)]!;
      order.push({ code: shop[pick]!.code, level: next[pick]! });
      next[pick]!++;
    }
    const key = keyOf(order);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(order);
  }
  return result;
}
