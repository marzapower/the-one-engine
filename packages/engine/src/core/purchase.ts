import type { Buyable, Effect, Producer, Upgrade } from "../models/base";
import type { Unlock } from "../models/base";
import { N, NR, type Numerus } from "../nums";
import type { GameState } from "../state";
import type { Engine } from "./engine";
import { computeGrowthFunction } from "./growth";

export type { Unlock } from "../models/base";

/** Why a purchase cannot happen right now. `null` means it can. */
export type PurchaseBlock = "unknown" | "maxed" | "locked" | "noPool" | "unaffordable";

/**
 * Resolves the pool an entity's cost is paid FROM: a currency, or a
 * producer's unit stock (`amount`) — upgrades and producers may cost producer units.
 */
export function findCostPool(state: GameState, code: string): { amount: Numerus } | undefined {
  return state.currencies.find((c) => c.code === code) ?? state.producers.find((p) => p.code === code);
}

/** True when the entity has no `unlock`, or the referenced `field` is strictly above `gt`. A missing referenced entity locks. */
export function isUnlocked(state: GameState, entity: { unlock?: Unlock }): boolean {
  const unlock = entity.unlock;
  if (!unlock) return true;
  const list: { code: string; amount: Numerus; earned?: Numerus; bought?: Numerus }[] =
    unlock.kind === "currency" ? state.currencies : unlock.kind === "producer" ? state.producers : state.upgrades;
  const found = list.find((e) => e.code === unlock.code);
  if (!found) return false;
  const value = unlock.field === "earned" ? (found.earned ?? found.amount) : unlock.field === "bought" ? (found.bought ?? 0) : found.amount;
  return N(value).gt(N(unlock.gt));
}

/** One defined cost line of a purchase: its pool code, what it pays (0 for an extra still free), and the pool when it resolves. */
interface QuotedLine {
  currencyCode: string;
  cost: Numerus;
  pool: { amount: Numerus } | undefined;
}

/**
 * Single source for block, shortfall and debit: one entry per defined line
 * (main, then every extra in order), including extras that are free for this
 * span (cost 0). Pools resolve with `findCostPool`.
 */
function quoteLines(engine: Engine, state: GameState, item: Buyable, amount: number): QuotedLine[] {
  const priced = engine.costLinesToBuyNext(item, amount);
  const main = priced[0];
  const quoted: QuotedLine[] = [{ currencyCode: item.currencyCode, cost: main?.cost ?? NR(0), pool: findCostPool(state, item.currencyCode) }];
  // Pools are distinct (validation), so the priced extras can be matched by code.
  const pricedExtras = new Map(priced.slice(1).map((l) => [l.currencyCode, l.cost]));
  for (const extra of item.extraCosts ?? []) {
    quoted.push({ currencyCode: extra.currencyCode, cost: pricedExtras.get(extra.currencyCode) ?? NR(0), pool: findCostPool(state, extra.currencyCode) });
  }
  return quoted;
}

/** A line whose pool is missing, or whose cost exceeds the pool. */
function lineShort(line: QuotedLine): boolean {
  return !line.pool || N(line.cost).gt(N(line.pool.amount));
}

/** `noPool` when any defined pool does not resolve (even for a free extra), else `unaffordable` when any line exceeds its pool. */
function costBlock(lines: QuotedLine[]): "noPool" | "unaffordable" | null {
  if (lines.some((l) => !l.pool)) return "noPool";
  if (lines.some(lineShort)) return "unaffordable";
  return null;
}

/** Subtracts every line from its pool. Call only after `costBlock` returned null, with the same lines. */
function debit(lines: QuotedLine[]): void {
  lines.forEach((line, index) => {
    if (index > 0 && N(line.cost).lte(0)) return;
    line.pool!.amount = NR(N(line.pool!.amount).sub(N(line.cost)));
  });
}

/**
 * Pool codes (in line order) that are missing or too short for `amount` units
 * of `item`: the main pool and every extra. Free extras with a present pool
 * are not listed. Empty when the cost can be paid.
 */
export function costShortfalls(engine: Engine, state: GameState, item: Buyable, amount: number): string[] {
  return quoteLines(engine, state, item, amount)
    .filter((line) => (line.pool ? N(line.cost).gt(0) && lineShort(line) : true))
    .map((line) => line.currencyCode);
}

function upgradeCheck(engine: Engine, state: GameState, upgrade: Upgrade): { block: PurchaseBlock | null; lines: QuotedLine[] } {
  if (!state.upgrades.some((u) => u.code === upgrade.code)) return { block: "unknown", lines: [] };
  if (upgrade.max && N(upgrade.amount).add(1).gt(N(upgrade.max))) return { block: "maxed", lines: [] };
  if (!isUnlocked(state, upgrade)) return { block: "locked", lines: [] };
  const lines = quoteLines(engine, state, upgrade, 1);
  return { block: costBlock(lines), lines };
}

/** Why the next level of `upgrade` cannot be bought, in order: unknown, maxed, locked, noPool, unaffordable. Every cost line must resolve and be covered. */
export function upgradePurchaseBlock(engine: Engine, state: GameState, upgrade: Upgrade): PurchaseBlock | null {
  return upgradeCheck(engine, state, upgrade).block;
}

/** Buys one level of the upgrade, paying every cost line at once. False when any block applies. */
export function buyUpgrade(engine: Engine, state: GameState, code: string): boolean {
  const upgrade = state.upgrades.find((u) => u.code === code);
  if (!upgrade) return false;
  const { block, lines } = upgradeCheck(engine, state, upgrade);
  if (block !== null) return false;

  const oldBought = N(upgrade.bought);

  debit(lines);
  upgrade.bought = NR(oldBought.add(1));
  upgrade.amount = NR(N(upgrade.amount).add(1));

  if (upgrade.grantOnPurchase) grantOnPurchase(engine, state, upgrade, oldBought);
  return true;
}

/**
 * For every `add` effect on a producer's `resetsTo`, adds the increment of the
 * new level (`v(new) − v(old)`, `v(0)` counting as 0) to the producer's
 * `amount`. Never touches `bought`: the producer's price does not change.
 */
function grantOnPurchase(engine: Engine, state: GameState, upgrade: Upgrade, oldBought: ReturnType<typeof N>): void {
  const newBought = N(upgrade.bought);
  for (const effect of upgrade.effects as Effect[]) {
    if (effect.type !== "add" || effect.target.kind !== "producer" || effect.target.path !== "resetsTo") continue;
    const newValue = computeGrowthFunction(effect.func, newBought, engine.growths);
    const oldValue = oldBought.gt(0) ? computeGrowthFunction(effect.func, oldBought, engine.growths) : N(0);
    const delta = newValue.sub(oldValue);
    if (!delta.isFinite() || delta.lte(0)) continue;
    const resolved = engine.services.registry.getAccessor(effect.target).resolve(state);
    if (!resolved) continue;
    for (const obj of resolved.objects) {
      const producer = obj as Producer;
      producer.amount = NR(N(producer.amount).add(delta));
    }
  }
}

function producerCheck(engine: Engine, state: GameState, producer: Producer, amount: number): { block: PurchaseBlock | null; lines: QuotedLine[] } {
  // Whole units only: a fractional or non-finite amount would break the free positions of the extra costs.
  if (!Number.isInteger(amount) || amount < 1 || !state.producers.some((p) => p.code === producer.code)) return { block: "unknown", lines: [] };
  // Against `bought`, not `amount`: a producer fed by a higher tier grows on its own, and `max` caps purchases.
  if (producer.max && N(producer.bought).add(amount).gt(N(producer.max))) return { block: "maxed", lines: [] };
  if (!isUnlocked(state, producer)) return { block: "locked", lines: [] };
  const lines = quoteLines(engine, state, producer, amount);
  return { block: costBlock(lines), lines };
}

/** Why `amount` units of `producer` cannot be bought. Same codes as `upgradePurchaseBlock`; `amount` must be a whole number >= 1, else `unknown`. */
export function producerPurchaseBlock(engine: Engine, state: GameState, producer: Producer, amount: number): PurchaseBlock | null {
  return producerCheck(engine, state, producer, amount).block;
}

/** Buys `amount` units of the producer in one go, paying every cost line at once. False when any block applies. */
export function buyProducer(engine: Engine, state: GameState, code: string, amount: number): boolean {
  const producer = state.producers.find((p) => p.code === code);
  if (!producer) return false;
  const { block, lines } = producerCheck(engine, state, producer, amount);
  if (block !== null) return false;

  debit(lines);
  producer.bought = NR(N(producer.bought).add(amount));
  producer.amount = NR(N(producer.amount).add(amount));
  return true;
}
