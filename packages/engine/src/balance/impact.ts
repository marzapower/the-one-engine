import type { Engine } from "../core/engine";
import { rateRulePrestige } from "../core/prestige-run";
import { isUnlocked, producerPurchaseBlock, upgradePurchaseBlock } from "../core/purchase";
import type { Prestige, Producer, Upgrade } from "../models/base";
import { type Decimal, N, NR } from "../nums";
import type { GameState } from "../state";
import { type ValueOptions, horizonValueOfProducerUnit, horizonValueOfUpgrade } from "./horizon-value";
import { anyActionAvailable, nextUnitCost, primaryCurrencyOf } from "./queries";

/**
 * Purchase relevance and prestige worth — the pure rules shared by the
 * GreedyBot (what a profile bothers to do) and the MetricsCollector (when the
 * run counts as "waiting"). One helper, two consumers: bot and metric cannot
 * drift apart.
 *
 * "Impact" is an ESTIMATE OF PRODUCTIVE RELEVANCE — the net value of a
 * purchase as a fraction of the primary production over the horizon. It
 * ignores the price and the payback time: a cheap tweak and a ruinous one
 * with the same effect have the same impact.
 */

/** Options of the waiting metric (`isWaiting`). */
export interface WaitingOptions {
  /** Minimum fraction of the primary production over the horizon (0.01 = 1%). <= 0: today's metric (`!anyActionAvailable`). */
  minImpact: number;
  /** Horizon of the values, ms (> 0). */
  horizonMs: number;
  /** m'/m ratio above which a prestige is worth taking (same meaning as `GreedyBotOptions.prestigeRatio`). */
  prestigeRatio: number;
  /** Per-prestige rule, same meaning as `GreedyBotOptions.prestigeRules`. Missing code: ratio. */
  prestigeRules?: Record<string, PrestigeRule>;
  /** Same meaning as `GreedyBotOptions.ignoreUnownedTargets`. */
  ignoreUnownedTargets?: boolean;
  /** True when a shop policy owns the prestige-currency purchases (`GreedyBotOptions.shopPriority`): they are not "relevant purchases" and not part of the shop factor. */
  excludePrestigeShop?: boolean;
}

/** When a profile takes a prestige: by compound-multiplier ratio, by run rate (core `rateRulePrestige`), or at a minimum delivered gain. */
export type PrestigeRule = "ratio" | "rate" | { minGain: number };

/** Options of `meaningfulPurchases`. */
export interface ScanOptions extends ValueOptions {
  /** Skip every purchase paid in a prestige currency (a shop policy owns them). */
  excludePrestigeShop?: boolean;
}

/** Identity of a purchase candidate: `producer:<code>` or `upgrade:<code>`. */
export type PurchaseKey = `producer:${string}` | `upgrade:${string}`;

/** Fails early (at construction) on values that would corrupt a whole run. */
export function assertValidImpactParams(minImpact: number, horizonMs: number): void {
  if (!Number.isFinite(minImpact) || minImpact < 0) {
    throw new Error(`minImpact must be a finite number >= 0 (got ${String(minImpact)})`);
  }
  if (!Number.isFinite(horizonMs) || horizonMs <= 0) {
    throw new Error(`horizonMs must be a finite number > 0 (got ${String(horizonMs)})`);
  }
}

export type PurchaseTarget = { kind: "producer"; producer: Producer } | { kind: "upgrade"; upgrade: Upgrade };

/** Net value and greedy efficiency of a purchase, or null when the greedy would not buy it. */
export interface PurchaseValuation {
  /** Net value in primary over the horizon (see `netPurchaseValue`). */
  net: Decimal;
  /** Value / cost, or value / (cost x unit value) for producer-paid upgrades. The bot ranks candidates by this. */
  efficiency: Decimal;
}

/**
 * Shared pricing of a candidate, used by `netPurchaseValue` and by the bot's
 * ranking so both read the very same numbers. `target.upgrade` / `.producer`
 * must already be quoted at the offset-shifted `bought`.
 */
export function valuePurchase(engine: Engine, state: GameState, target: PurchaseTarget, cost: Decimal, horizonMs: number, opts?: ValueOptions): PurchaseValuation | null {
  if (cost.lte(0)) return null;

  if (target.kind === "producer") {
    const value = horizonValueOfProducerUnit(engine, state, target.producer.code, horizonMs);
    if (value.lte(0)) return null; // excludes dead-end chains
    return { net: value, efficiency: value.div(cost) };
  }

  const { upgrade } = target;
  const value = horizonValueOfUpgrade(engine, state, upgrade, horizonMs, opts);
  if (value.lte(0)) return null; // excludes effects with no impact on the primary chain

  // Producer-paid upgrades: the price is production itself, so express the
  // cost in primary-value (units burned x their horizon value) and require
  // the trade to net out positive.
  if (state.producers.some((p) => p.code === upgrade.currencyCode)) {
    const unitValue = horizonValueOfProducerUnit(engine, state, upgrade.currencyCode, horizonMs);
    const costValue = cost.mul(unitValue);
    if (costValue.lte(0)) return null;
    const efficiency = value.div(costValue);
    if (efficiency.lte(1)) return null;
    return { net: value.sub(costValue), efficiency };
  }

  return { net: value, efficiency: value.div(cost) };
}

/**
 * Net value (in primary, over `horizonMs`) of buying the next unit of the
 * target; null when the greedy would not buy it (no value, or a
 * producer-paid upgrade that does not repay the units it burns).
 * `target` is already quoted: `bought` shifted by the caller's local offsets.
 */
export function netPurchaseValue(engine: Engine, state: GameState, target: PurchaseTarget, cost: Decimal, horizonMs: number, opts?: ValueOptions): Decimal | null {
  return valuePurchase(engine, state, target, cost, horizonMs, opts)?.net ?? null;
}

/**
 * True when `value >= minImpact x primary persecDelta x H` (H in seconds).
 * Equality counts as relevant. When the primary production is not positive
 * (or there is no primary) any positive value is relevant.
 */
export function isMeaningfulValue(state: GameState, value: Decimal, minImpact: number, horizonMs: number): boolean {
  const persec = N(primaryCurrencyOf(state)?.persecDelta ?? 0);
  if (persec.lte(0)) return value.gt(0);
  return value.gte(persec.mul(horizonMs / 1000).mul(minImpact));
}

/**
 * Keys of the candidates that are affordable NOW and relevant, utilities
 * included. Purchasability is checked first (the core's `*PurchaseBlock`: max,
 * lock, cost pool, affordability), then the value.
 * Utility upgrades (paid in a prestige currency, unpriced by the horizon
 * math) are always relevant when affordable: "not priced" is not "useless".
 */
export function meaningfulPurchases(engine: Engine, state: GameState, minImpact: number, horizonMs: number, opts?: ScanOptions): Set<PurchaseKey> {
  const found = new Set<PurchaseKey>();
  scanMeaningful(engine, state, minImpact, horizonMs, found, opts);
  return found;
}

/** Early-exit twin of `meaningfulPurchases`: true as soon as one relevant candidate is found. */
function hasMeaningfulPurchase(engine: Engine, state: GameState, minImpact: number, horizonMs: number, opts?: ScanOptions): boolean {
  return scanMeaningful(engine, state, minImpact, horizonMs, null, opts);
}

/** Collects into `sink` (or stops at the first hit when `sink` is null). Returns whether anything was found. */
function scanMeaningful(engine: Engine, state: GameState, minImpact: number, horizonMs: number, sink: Set<PurchaseKey> | null, opts?: ScanOptions): boolean {
  let any = false;
  const prestigeCurrencies = new Set(state.prestiges.map((p) => p.currencyCode));

  for (const producer of state.producers) {
    if (opts?.excludePrestigeShop && prestigeCurrencies.has(producer.currencyCode)) continue;
    // Max, lock, pool and affordability: the core's purchase rules.
    if (producerPurchaseBlock(engine, state, producer, 1) !== null) continue;
    const cost = N(nextUnitCost(engine, producer));

    const value = netPurchaseValue(engine, state, { kind: "producer", producer }, cost, horizonMs, opts);
    if (value === null || !isMeaningfulValue(state, value, minImpact, horizonMs)) continue;

    any = true;
    if (!sink) return true;
    sink.add(`producer:${producer.code}`);
  }

  for (const upgrade of state.upgrades) {
    if (opts?.excludePrestigeShop && prestigeCurrencies.has(upgrade.currencyCode)) continue;
    if (upgradePurchaseBlock(engine, state, upgrade) !== null) continue;
    const cost = N(engine.costToBuyNext(upgrade, 1));

    const value = netPurchaseValue(engine, state, { kind: "upgrade", upgrade }, cost, horizonMs, opts);
    const relevant = value !== null ? isMeaningfulValue(state, value, minImpact, horizonMs) : isUtilityUpgrade(engine, state, upgrade, prestigeCurrencies, cost, horizonMs);
    if (!relevant) continue;

    any = true;
    if (!sink) return true;
    sink.add(`upgrade:${upgrade.code}`);
  }

  return any;
}

/** Prestige-currency upgrade the horizon math cannot price (the bot's utility pass buys these). */
function isUtilityUpgrade(engine: Engine, state: GameState, upgrade: Upgrade, prestigeCurrencies: Set<string>, cost: Decimal, horizonMs: number): boolean {
  if (!prestigeCurrencies.has(upgrade.currencyCode)) return false;
  if (cost.lte(0)) return false;
  return horizonValueOfUpgrade(engine, state, upgrade, horizonMs).lte(0);
}

/** Result of `evaluatePrestige`. */
interface PrestigeEvaluation {
  /** Prestige-currency gain from performing this prestige now. */
  gain: Decimal;
  /** Current compound multiplier of the prestige's effects, at the current prestige-currency drive. */
  m: Decimal;
  /** Compound multiplier if the prestige were performed now (prestige-currency drive + gain). */
  mPrime: Decimal;
}

/**
 * Evaluates a prestige: `gain` mirrors `Engine.performPrestige`'s delivered
 * gain (via `engine.prestigeGain`); `m`/`m'` = compound multiplier of the
 * prestige's effects, evaluated at the current and post-gain prestige
 * currency drive respectively (mirrors `Engine.applyPrestiges`, which
 * multiplies the target by each effect's `engine.growthValue(effect.func,
 * drive)` in sequence).
 *
 * Assumption: only "mult"-type effects are composed into m/m' — an "add"
 * effect on a prestige doesn't have a well-defined "compound multiplier"
 * (the engine applies it additively, not multiplicatively). Defensive
 * default for games with no such content.
 */
export function evaluatePrestige(engine: Engine, state: GameState, prestige: Prestige, opts?: { skipShop?: boolean }): PrestigeEvaluation | null {
  const gain = engine.prestigeGain(state, prestige);

  // Mirror Engine.applyPrestiges: passive effects are driven by the
  // prestige currency's `drive`. Weights sum to 1, so a prestige — which
  // raises amount AND earned by `gain` — raises the drive by `gain`.
  const prestigeCurrency = state.currencies.find((c) => c.code === prestige.currencyCode);
  const driveBefore = prestigeCurrency ? engine.prestigeDrive(prestigeCurrency) : N(0);
  const driveAfter = driveBefore.add(gain);

  const multEffects = prestige.effects.filter((effect) => effect.type === "mult");
  const m = multEffects.reduce((acc, effect) => acc.mul(engine.growthValue(effect.func, NR(driveBefore))), N(1));
  let mPrime = multEffects.reduce((acc, effect) => acc.mul(engine.growthValue(effect.func, NR(driveAfter))), N(1));

  // Shop-aware valuation: the post-prestige budget (spendable amount +
  // gain) can buy levels of prestige-currency upgrades whose multipliers
  // dwarf the passive effect. Ignoring this made the bot systematically
  // prestige LATER than optimal play.
  const spendable = prestigeCurrency ? N(prestigeCurrency.amount) : N(0);
  if (!opts?.skipShop) mPrime = mPrime.mul(shopFactorWithBudget(engine, state, prestige.currencyCode, spendable.add(gain)));

  return { gain, m, mPrime };
}

/**
 * Compound multiplier obtainable by greedily buying levels of upgrades paid
 * in `currencyCode`, within `budget`. Only "mult" effects on PRODUCTION
 * channels (persec/persecDelta targets) are composed — a mult on a
 * non-production channel (e.g. capacityMult, gainMult) is not production
 * and counting it inflated mPrime, making the bot prestige early whenever
 * such an upgrade sat affordable-but-unbought. Bounded to 64 levels.
 */
export function shopFactorWithBudget(engine: Engine, state: GameState, currencyCode: string, budget: Decimal): Decimal {
  let factor = N(1);
  let remaining = budget;

  for (const upgrade of state.upgrades) {
    if (upgrade.currencyCode !== currencyCode) continue;
    if (!isUnlocked(state, upgrade)) continue;

    let levels = N(0);
    for (let i = 0; i < 64; i++) {
      const boughtNow = N(upgrade.bought).add(levels);
      if (upgrade.max !== undefined && boughtNow.gte(N(upgrade.max))) break;

      const quoted: Upgrade = { ...upgrade, bought: NR(boughtNow) };
      const cost = N(engine.costToBuyNext(quoted, 1));
      if (cost.lte(0) || cost.gt(remaining)) break;

      let marginal = N(1);
      for (const effect of upgrade.effects) {
        if (effect.type !== "mult") continue;
        if (!effect.target.path.includes("persec")) continue;
        const before = engine.growthValue(effect.func, NR(boughtNow));
        if (before.lte(0)) continue;
        marginal = marginal.mul(engine.growthValue(effect.func, NR(boughtNow.add(1))).div(before));
      }
      if (marginal.lte(1)) break;

      remaining = remaining.sub(cost);
      factor = factor.mul(marginal);
      levels = levels.add(1);
    }
  }

  return factor;
}

/** Options of `prestigeWorthTaking` / `prestigeRuleFires`. */
export interface PrestigeTakingOptions {
  /** Per-prestige rule by code; a missing code means "ratio". */
  rules?: Record<string, PrestigeRule>;
  /** Leave the prestige-currency shop out of the m'/m ratio (a shop policy owns it). */
  skipShop?: boolean;
}

/**
 * True when the profile takes `prestige` now under its rule: "ratio" (default,
 * positive gain and m'/m >= `prestigeRatio`, shop factor included), "rate"
 * (the core's `rateRulePrestige`) or `{ minGain }` (delivered gain >= minGain).
 */
export function prestigeRuleFires(engine: Engine, state: GameState, prestige: Prestige, prestigeRatio: number, opts?: PrestigeTakingOptions): boolean {
  const rule = opts?.rules?.[prestige.code] ?? "ratio";

  if (rule === "rate") return rateRulePrestige(engine, state, prestige);
  if (typeof rule === "object") {
    const gain = engine.prestigeGain(state, prestige);
    return gain.gt(0) && gain.gte(rule.minGain);
  }

  const evaluated = evaluatePrestige(engine, state, prestige, { skipShop: opts?.skipShop });
  if (!evaluated || evaluated.gain.lte(0) || evaluated.m.lte(0)) return false;
  return evaluated.mPrime.div(evaluated.m).gte(prestigeRatio);
}

/**
 * The first prestige a profile with this `prestigeRatio` (and, optionally,
 * per-prestige rules) would take now. The anti-stall branch of the bot
 * depends on its internal clocks and is NOT part of this (declared
 * approximation for the waiting metric).
 */
export function prestigeWorthTaking(engine: Engine, state: GameState, prestigeRatio: number, opts?: PrestigeTakingOptions): Prestige | null {
  for (const prestige of state.prestiges) {
    if (prestigeRuleFires(engine, state, prestige, prestigeRatio, opts)) return prestige;
  }
  return null;
}

/**
 * True when the sample counts as waiting.
 * - `minImpact <= 0`: nothing is available at all (`!anyActionAvailable`),
 *   identical to the historical metric.
 * - `minImpact > 0`: no relevant purchase is affordable AND no prestige is
 *   worth taking by ratio.
 */
export function isWaiting(engine: Engine, state: GameState, opts: WaitingOptions): boolean {
  if (opts.minImpact <= 0) return !anyActionAvailable(engine, state);
  if (hasMeaningfulPurchase(engine, state, opts.minImpact, opts.horizonMs, opts)) return false;
  return prestigeWorthTaking(engine, state, opts.prestigeRatio, { rules: opts.prestigeRules, skipShop: opts.excludePrestigeShop }) === null;
}
