import type { Currency, Effect } from "../models/base";
import { type Decimal, N, NR, type Numerus } from "../nums";
import type { GameState } from "../state";
import type { EngineServices } from "./di/types";
import { computeGrowthFunction } from "./growth";
import { prestigeDrive } from "./prestige-gain";

/**
 * Modifier pipeline for effects that target *persistent* state paths (e.g. a
 * producer's `produces.*.persec`).
 *
 * The tick pipeline re-applies every upgrade/prestige effect on every tick
 * (stages "Upgrades(0)"/"Upgrades(1)"/"Upgrades(2)"). An effect that writes
 * its result back to a persistent path would compound — the same `mult`/`add`
 * effect re-applied on top of the already-modified value, tick after tick.
 * `persecDelta` targets never had this problem: the "Produce" stage zeroes
 * them out every tick before anything re-adds to them.
 *
 * Effects on persistent paths are therefore never written to state. They are
 * collected here into a per-tick map keyed by the resolved target object, and
 * folded on top of the immutable base value at the single point of read (see
 * `Engine.computeProducers`). The state value itself stays exactly what
 * content declared it to be, forever — a true, never-mutated base.
 */
export interface Modifier {
  effect: Effect;
  amount: Numerus;
}

/**
 * An effect target path is "transient" iff its last segment is
 * `persecDelta` — the one channel the "Produce" stage already zeroes every
 * tick, giving it "derived value, recomputed each tick" semantics for free.
 * Every other path is "persistent": never written by the effect system,
 * folded at its point of read instead.
 */
export function isTransientTargetPath(path: string): boolean {
  return path.split(".").pop() === "persecDelta";
}

/**
 * Collects every upgrade/prestige effect targeting a persistent path into a
 * map from resolved target object to its ordered modifier list.
 *
 * Must be rebuilt every tick: a state's containers can be replaced by fresh
 * references between ticks (immutable updates), so cached resolved objects
 * would silently point at stale, detached data.
 *
 * Ordering within each target object's modifier list:
 *   1. Primary — effect.stage ascending (0 -> 1 -> 2)
 *   2. Secondary — effect type priority ascending
 *   3. Tertiary — declaration order: upgrades in array order, then prestiges
 *      in array order (upgrade effects always sort before prestige effects).
 *
 * Amount driving each effect's growth function:
 *   - upgrade effects: `upgrade.bought` (skipped if `bought <= 0`)
 *   - prestige effects: `prestigeDrive(currency)` (skipped if `<= 0` — the
 *     passive must already apply at exactly the currency's first unit)
 */
export function collectModifiers(state: GameState, services: EngineServices): Map<object, Modifier[]> {
  interface Entry {
    effect: Effect;
    amount: Numerus;
    stage: 0 | 1 | 2;
    priority: number;
  }
  const entries: Entry[] = [];

  for (const upgrade of state.upgrades) {
    if (N(upgrade.bought).lte(0)) continue;
    for (const effect of upgrade.effects) {
      if (isTransientTargetPath(effect.target.path)) continue;
      entries.push({
        effect,
        amount: upgrade.bought,
        stage: effect.stage,
        priority: services.effectTypes.lookup(effect.type)?.priority ?? 100,
      });
    }
  }

  for (const prestige of state.prestiges) {
    const curr = services.registry.getByCode(state, "currency", prestige.currencyCode) as Currency | undefined;
    if (!curr) continue;
    const drive = NR(prestigeDrive(curr));
    if (N(drive).lte(0)) continue;
    for (const effect of prestige.effects) {
      if (isTransientTargetPath(effect.target.path)) continue;
      entries.push({
        effect,
        amount: drive,
        stage: effect.stage,
        priority: services.effectTypes.lookup(effect.type)?.priority ?? 100,
      });
    }
  }

  // Stable sort: Array#sort preserves relative order of equal elements, so
  // declaration order (upgrades pushed before prestiges, each in array
  // order) survives as the tertiary key for free.
  entries.sort((a, b) => (a.stage !== b.stage ? a.stage - b.stage : a.priority - b.priority));

  const mods = new Map<object, Modifier[]>();
  for (const entry of entries) {
    const resolved = services.registry.getAccessor(entry.effect.target).resolve(state);
    if (!resolved) continue;
    for (const obj of resolved.objects) {
      if (typeof obj !== "object" || obj === null) continue;
      const mod: Modifier = { effect: entry.effect, amount: entry.amount };
      const list = mods.get(obj);
      if (list) list.push(mod);
      else mods.set(obj, [mod]);
    }
  }

  return mods;
}

/**
 * Folds `base` through every modifier in order, using each effect type's
 * registered `apply` — so custom effect types compose correctly, not just
 * the built-in add/mult. An unknown effect type is logged and skipped.
 */
export function applyModifiers(base: Numerus | Decimal, mods: Modifier[], services: EngineServices): Decimal {
  let value = N(base);
  for (const { effect, amount } of mods) {
    const effectDef = services.effectTypes.lookup(effect.type);
    if (!effectDef) {
      services.logger.error(`Effect type not found: "${effect.type}". Skipping modifier.`);
      continue;
    }
    const computed = computeGrowthFunction(effect.func, amount, services.growths);
    value = N(effectDef.apply(value, computed));
  }
  return value;
}
