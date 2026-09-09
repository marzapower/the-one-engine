import type { Engine } from "../core/engine";
import type { Currency, Producer, Upgrade } from "../models/base";
import { N, type Numerus } from "../nums";
import type { GameState } from "../state";

/**
 * The currency the game declares as its own point (`Currency.primary`) —
 * the anchor of the whole balance value model. Data-driven: no code is ever
 * assumed. Undefined when the state declares none (dead-end for the value
 * model: chains never resolve, horizon values are 0).
 */
export function primaryCurrencyOf(state: GameState): Currency | undefined {
  return state.currencies.find((c) => c.primary);
}

/** Cost of the next single unit of a producer. */
export function nextUnitCost(engine: Engine, producer: Producer): Numerus {
  return engine.costToBuyNext(producer, 1);
}

/** Cost of the next level of an upgrade. */
export function upgradeCost(engine: Engine, upgrade: Upgrade): Numerus {
  return engine.costToBuyNext(upgrade, 1);
}

/**
 * Resolves the pool an entity's cost is paid FROM: a currency, or a
 * producer's unit stock (`amount`) — upgrades may cost producer units.
 */
export function findCostPool(state: GameState, code: string): { amount: Numerus } | undefined {
  return state.currencies.find((c) => c.code === code) ?? state.producers.find((p) => p.code === code);
}

/**
 * A sample point is "dead" when NO action is available: no producer's next
 * single unit is affordable, no upgrade is affordable (respecting `max`),
 * and no prestige would yield a positive gain. See types.ts DeadTimeWindow.
 */
export function anyActionAvailable(engine: Engine, state: GameState): boolean {
  for (const producer of state.producers) {
    const currency = state.currencies.find((c) => c.code === producer.currencyCode);
    if (!currency) continue;
    if (N(nextUnitCost(engine, producer)).lte(N(currency.amount))) {
      return true;
    }
  }

  for (const upgrade of state.upgrades) {
    if (upgrade.max && N(upgrade.amount).add(1).gt(N(upgrade.max))) continue;
    const pool = findCostPool(state, upgrade.currencyCode);
    if (!pool) continue;
    if (N(upgradeCost(engine, upgrade)).lte(N(pool.amount))) {
      return true;
    }
  }

  for (const prestige of state.prestiges) {
    if (engine.prestigeGain(state, prestige).gt(0)) {
      return true;
    }
  }

  return false;
}
