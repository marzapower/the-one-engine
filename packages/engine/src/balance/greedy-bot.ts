import type { Engine } from "../core/engine";
import { DEFAULT_PRESTIGE_DRIVE } from "../core/prestige-gain";
import type { Prestige, Producer, Upgrade } from "../models/base";
import { type Decimal, N, NR } from "../nums";
import type { GameState } from "../state";
import { horizonValueOfProducerUnit, horizonValueOfUpgrade } from "./horizon-value";
import { primaryCurrencyOf } from "./queries";
import type { BotContext, BotIntent, BotPolicy } from "./types";

export interface GreedyBotOptions {
  /** Time horizon (ms) used to value producers/upgrades (see horizon-value.ts). Default 10min. */
  horizonMs?: number;
  /**
   * Prestige triggers when the post-prestige compound multiplier is at least
   * this many times the current one (m'/m >= prestigeRatio). Default 1.5.
   */
  prestigeRatio?: number;
  /**
   * If no action (buy or prestige) has been taken for longer than this (ms)
   * and a prestige would yield gain >= 1, prestige anyway (anti-stall).
   * Default 5min.
   */
  stallPrestigeAfterMs?: number;
  /**
   * Opportunity-cost guard for prestige-currency purchases: skip a shop buy
   * if it would shrink the passive production multiplier by more than this
   * fraction (only meaningful when the prestige currency's `drive` gives
   * unspent stock a weight). Default Infinity — the naive spender.
   */
  maxPassiveLossPct?: number;
}

/** GreedyBotOptions with every default resolved — the bot's live, mutable knob set. */
export type ResolvedGreedyBotOptions = Required<GreedyBotOptions>;

/** The expert-player defaults, exported so bot definitions (bot-definition.ts) can layer phases on top. */
export const GREEDY_DEFAULTS: ResolvedGreedyBotOptions = {
  horizonMs: 600_000,
  prestigeRatio: 1.5,
  stallPrestigeAfterMs: 300_000,
  maxPassiveLossPct: Number.POSITIVE_INFINITY,
};

/** Safety cap on purchase intents per decision point, matching HarnessParams.maxActionsPerDecision default. */
const MAX_INTENTS_PER_DECISION = 50;

interface PrestigeEvaluation {
  /** Prestige-currency gain from performing this prestige now. */
  gain: Decimal;
  /** Current compound multiplier of the prestige's effects, at the current prestige-currency drive. */
  m: Decimal;
  /** Compound multiplier if the prestige were performed now (prestige-currency drive + gain). */
  mPrime: Decimal;
}

interface PurchaseCandidate {
  kind: "producer" | "upgrade";
  code: string;
  currencyCode: string;
  cost: Decimal;
  efficiency: Decimal;
}

/**
 * Greedy — approximates an expert player: at every decision point, buy the
 * affordable producer/upgrade with the best value/cost ratio over a fixed
 * time horizon, and prestige once the payback is worth it (or after a long
 * stall, as long as it's not worthless).
 */
export class GreedyBot implements BotPolicy {
  readonly id = "greedy";

  private readonly options: ResolvedGreedyBotOptions;

  /** Sim time (ms) of the last decision that produced at least one intent. */
  private lastActionTsSimMs = 0;

  /** Peak log10(primary) seen so far, and when it last moved by >= 0.1 decades. */
  private peakPrimaryLog = 0;
  private lastProgressTsSimMs = 0;

  constructor(options: GreedyBotOptions = {}) {
    this.options = { ...GREEDY_DEFAULTS };
    this.setOptions(options);
  }

  /**
   * Live knob mutation, for phase-driven bot definitions (bot-definition.ts):
   * changing options mid-run keeps the bot's internal state (stall clocks,
   * progress peaks) — a phase switch is a change of mind, not a new player.
   * `undefined` entries are ignored (they mean "keep the current value").
   */
  setOptions(partial: GreedyBotOptions): void {
    for (const key of Object.keys(GREEDY_DEFAULTS) as (keyof ResolvedGreedyBotOptions)[]) {
      const value = partial[key];
      if (value !== undefined) this.options[key] = value;
    }
  }

  decide(ctx: BotContext): BotIntent[] {
    const { state, engine, tSimMs } = ctx;

    // Progress tracking: "stalled" means the primary PEAK stopped moving, not
    // that we stopped buying — at a deep-game plateau residual income keeps
    // affording token purchases forever while real progress is frozen.
    const primary = primaryCurrencyOf(state);
    if (primary && N(primary.amount).gt(1)) {
      const log = N(primary.amount).log10().toNumber();
      if (log > this.peakPrimaryLog + 0.1) {
        this.peakPrimaryLog = log;
        this.lastProgressTsSimMs = tSimMs;
      }
    }

    // 1. Prestige takes priority when it clears the convenience bar.
    const prestigeIntent = this.checkPrestigeRatio(engine, state);
    if (prestigeIntent) {
      this.lastActionTsSimMs = tSimMs;
      return [prestigeIntent];
    }

    // 2. Otherwise, greedily buy the best-payback affordable options.
    const buyIntents = this.planPurchases(engine, state);
    if (buyIntents.length > 0) {
      this.lastActionTsSimMs = tSimMs;
      return buyIntents;
    }

    // 3. Nothing prestige-worthy by the ratio bar, but the run has stopped
    // making DECADE progress for a while: prestige anyway as long as it's
    // not worthless (gain >= 1). Purchases do NOT reset this clock — at a
    // deep-game plateau residual income affords token buys forever while the
    // peak is frozen; a real player prestiges.
    if (tSimMs - this.lastProgressTsSimMs > this.options.stallPrestigeAfterMs) {
      const stallIntent = this.checkStallPrestige(engine, state);
      if (stallIntent) {
        this.lastProgressTsSimMs = tSimMs;
        this.peakPrimaryLog = 0;
        return [stallIntent];
      }
    }

    return [];
  }

  private checkPrestigeRatio(engine: Engine, state: GameState): BotIntent | null {
    for (const prestige of state.prestiges) {
      const evaluated = this.evaluatePrestige(engine, state, prestige);
      if (!evaluated || evaluated.gain.lte(0) || evaluated.m.lte(0)) continue;

      const ratio = evaluated.mPrime.div(evaluated.m);
      if (ratio.gte(this.options.prestigeRatio)) {
        return { kind: "prestige", code: prestige.code };
      }
    }
    return null;
  }

  private checkStallPrestige(engine: Engine, state: GameState): BotIntent | null {
    for (const prestige of state.prestiges) {
      const evaluated = this.evaluatePrestige(engine, state, prestige);
      if (evaluated?.gain.gte(1)) {
        return { kind: "prestige", code: prestige.code };
      }
    }
    return null;
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
  private evaluatePrestige(engine: Engine, state: GameState, prestige: Prestige): PrestigeEvaluation | null {
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
    mPrime = mPrime.mul(this.shopFactorWithBudget(engine, state, prestige.currencyCode, spendable.add(gain)));

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
  private shopFactorWithBudget(engine: Engine, state: GameState, currencyCode: string, budget: Decimal): Decimal {
    let factor = N(1);
    let remaining = budget;

    for (const upgrade of state.upgrades) {
      if (upgrade.currencyCode !== currencyCode) continue;

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

  /**
   * Builds a list of buy intents by repeatedly picking the affordable
   * candidate (producer or upgrade) with the highest value/cost ratio,
   * tracking a local budget-per-currency and a local bought-offset so
   * subsequent picks of the same entity within this decision point are
   * quoted correctly.
   *
   * A candidate that's the current best but unaffordable is permanently
   * excluded for the rest of this decision point (the local budget only
   * shrinks, so it can never become affordable again this round).
   */
  private planPurchases(engine: Engine, state: GameState): BotIntent[] {
    const intents: BotIntent[] = [];
    const budgets = new Map<string, Decimal>();
    const producerOffsets = new Map<string, Decimal>();
    const upgradeOffsets = new Map<string, Decimal>();
    const excluded = new Set<string>();

    const getBudget = (currencyCode: string): Decimal => {
      const existing = budgets.get(currencyCode);
      if (existing) return existing;
      // Cost pools can be currencies or producer stocks (an upgrade may cost producer units).
      const pool = state.currencies.find((c) => c.code === currencyCode) ?? state.producers.find((p) => p.code === currencyCode);
      const budget = pool ? N(pool.amount) : N(0);
      budgets.set(currencyCode, budget);
      return budget;
    };

    while (intents.length < MAX_INTENTS_PER_DECISION) {
      const candidate = this.pickBestCandidate(engine, state, producerOffsets, upgradeOffsets, excluded);
      if (!candidate) break;

      const budget = getBudget(candidate.currencyCode);
      if (budget.gte(candidate.cost)) {
        budgets.set(candidate.currencyCode, budget.sub(candidate.cost));

        if (candidate.kind === "producer") {
          const offset = producerOffsets.get(candidate.code) ?? N(0);
          producerOffsets.set(candidate.code, offset.add(1));
          intents.push({ kind: "buyProducer", code: candidate.code, amount: 1 });
        } else {
          const offset = upgradeOffsets.get(candidate.code) ?? N(0);
          upgradeOffsets.set(candidate.code, offset.add(1));
          intents.push({ kind: "buyUpgrade", code: candidate.code });
        }
      } else {
        excluded.add(`${candidate.kind}:${candidate.code}`);
      }
    }

    this.planUtilityPurchases(engine, state, intents, getBudget, budgets, upgradeOffsets);

    return intents;
  }

  /**
   * Utility pass: prestige-currency upgrades whose value the horizon math
   * cannot price (custom effect types or non-production behaviours — see
   * `horizon-value.ts`). The prestige currency has no other sink, so a
   * rational player buys them as soon as affordable: cheapest first, within
   * the remaining budget.
   */
  private planUtilityPurchases(
    engine: Engine,
    state: GameState,
    intents: BotIntent[],
    getBudget: (currencyCode: string) => Decimal,
    budgets: Map<string, Decimal>,
    upgradeOffsets: Map<string, Decimal>,
  ): void {
    const prestigeCurrencies = new Set(state.prestiges.map((p) => p.currencyCode));

    for (;;) {
      if (intents.length >= MAX_INTENTS_PER_DECISION) return;

      let cheapest: { code: string; currencyCode: string; cost: Decimal } | null = null;
      for (const upgrade of state.upgrades) {
        if (!prestigeCurrencies.has(upgrade.currencyCode)) continue;

        const offset = upgradeOffsets.get(upgrade.code) ?? N(0);
        const boughtSoFar = N(upgrade.bought).add(offset);
        if (upgrade.max !== undefined && boughtSoFar.gte(N(upgrade.max))) continue;

        const quoted: Upgrade = { ...upgrade, bought: NR(boughtSoFar) };
        if (horizonValueOfUpgrade(engine, state, quoted, this.options.horizonMs).gt(0)) continue; // priced by the main pass

        const cost = N(engine.costToBuyNext(quoted, 1));
        if (cost.lte(0) || cost.gt(getBudget(upgrade.currencyCode))) continue;

        // Opportunity-cost guard (cautious buyer): when unspent prestige
        // currency drives the passive, skip buys that hurt it too much.
        if (this.passiveLossFraction(engine, state, upgrade.currencyCode, getBudget(upgrade.currencyCode), cost) > this.options.maxPassiveLossPct) continue;

        if (!cheapest || cost.lt(cheapest.cost)) {
          cheapest = { code: upgrade.code, currencyCode: upgrade.currencyCode, cost };
        }
      }

      if (!cheapest) return;
      budgets.set(cheapest.currencyCode, getBudget(cheapest.currencyCode).sub(cheapest.cost));
      upgradeOffsets.set(cheapest.code, (upgradeOffsets.get(cheapest.code) ?? N(0)).add(1));
      intents.push({ kind: "buyUpgrade", code: cheapest.code });
    }
  }

  /**
   * Fraction of the passive production multiplier lost by spending `cost`
   * out of `unspentBefore` (remaining budget) of a prestige currency. Zero
   * whenever the currency's `drive` gives unspent stock no weight (the
   * default: `{ unspentWeight: 0, earnedWeight: 1 }`).
   */
  private passiveLossFraction(engine: Engine, state: GameState, currencyCode: string, unspentBefore: Decimal, cost: Decimal): number {
    const prestige = state.prestiges.find((p) => p.currencyCode === currencyCode);
    const currency = state.currencies.find((c) => c.code === currencyCode);
    if (!prestige || !currency) return 0;

    const drive = currency.drive ?? DEFAULT_PRESTIGE_DRIVE;
    if (drive.unspentWeight <= 0) return 0;

    const earned = N(currency.earned ?? currency.amount);
    const driveAt = (unspent: Decimal) => unspent.mul(drive.unspentWeight).add(earned.mul(drive.earnedWeight));
    const multEffects = prestige.effects.filter((effect) => effect.type === "mult");
    const mAt = (driveValue: Decimal) => multEffects.reduce((acc, effect) => acc.mul(engine.growthValue(effect.func, NR(driveValue))), N(1));

    const before = mAt(driveAt(unspentBefore));
    if (before.lte(0)) return 0;
    const after = mAt(driveAt(unspentBefore.sub(cost)));
    return 1 - after.div(before).toNumber();
  }

  /** Scans all producers and upgrades for the highest positive-efficiency, non-excluded candidate. */
  private pickBestCandidate(
    engine: Engine,
    state: GameState,
    producerOffsets: Map<string, Decimal>,
    upgradeOffsets: Map<string, Decimal>,
    excluded: Set<string>,
  ): PurchaseCandidate | null {
    let best: PurchaseCandidate | null = null;

    for (const producer of state.producers) {
      const key = `producer:${producer.code}`;
      if (excluded.has(key)) continue;

      const offset = producerOffsets.get(producer.code) ?? N(0);
      const quoted: Producer = { ...producer, bought: NR(N(producer.bought).add(offset)) };
      const cost = N(engine.costToBuyNext(quoted, 1));
      if (cost.lte(0)) continue;

      const value = horizonValueOfProducerUnit(engine, state, producer.code, this.options.horizonMs);
      if (value.lte(0)) continue; // excludes dead-end chains

      const efficiency = value.div(cost);
      if (!best || efficiency.gt(best.efficiency)) {
        best = { kind: "producer", code: producer.code, currencyCode: producer.currencyCode, cost, efficiency };
      }
    }

    for (const upgrade of state.upgrades) {
      const key = `upgrade:${upgrade.code}`;
      if (excluded.has(key)) continue;

      const offset = upgradeOffsets.get(upgrade.code) ?? N(0);
      const boughtSoFar = N(upgrade.bought).add(offset);
      if (upgrade.max !== undefined && boughtSoFar.gte(N(upgrade.max))) continue;

      const quoted: Upgrade = { ...upgrade, bought: NR(boughtSoFar) };
      const cost = N(engine.costToBuyNext(quoted, 1));
      if (cost.lte(0)) continue;

      const value = horizonValueOfUpgrade(engine, state, quoted, this.options.horizonMs);
      if (value.lte(0)) continue; // excludes effects with no impact on the primary chain

      // Producer-paid upgrades: the price is production itself, so express
      // the cost in primary-value (units burned x their horizon value) and
      // require the trade to net out positive.
      const producerPool = state.producers.find((p) => p.code === upgrade.currencyCode);
      let efficiency: Decimal;
      if (producerPool) {
        const unitValue = horizonValueOfProducerUnit(engine, state, upgrade.currencyCode, this.options.horizonMs);
        const costValue = cost.mul(unitValue);
        if (costValue.lte(0)) continue;
        efficiency = value.div(costValue);
        if (efficiency.lte(1)) continue;
      } else {
        efficiency = value.div(cost);
      }

      if (!best || efficiency.gt(best.efficiency)) {
        best = { kind: "upgrade", code: upgrade.code, currencyCode: upgrade.currencyCode, cost, efficiency };
      }
    }

    return best;
  }
}
