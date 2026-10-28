import type { Engine } from "../../core/engine";
import { rateRulePrestige } from "../../core/prestige-run";
import { isUnlocked, upgradePurchaseBlock } from "../../core/purchase";
import { type Decimal, N } from "../../nums";
import type { GameState } from "../../state";
import type { BotContext, BotIntent, BotPolicy, GameMove } from "../types";
import { type PresenceProfile, isOpen, isVisit } from "./presence";
import type { ShopOrder } from "./types";

/**
 * When the policy prestiges: `rate` follows the engine's rate rule, `target`
 * fires at a delivered gain, `bestRate` looks ahead and fires at the visit with
 * the most delivered gain per hour of run (see `createRunPolicy`).
 */
export type CalibrationPrestigeRule =
  | { kind: "rate"; minRunMs?: number; drop?: number }
  | { kind: "target"; minGain: number }
  | {
      kind: "bestRate";
      /** How far to look ahead, as a multiple of the time the run has lasted so far (default 1). */
      horizonFactor?: number;
      /** Least time to look ahead, in ms (default 3 600 000). */
      minHorizonMs?: number;
    };

/**
 * Plays the run on from a copy of `state` at `tSimMs`, the same way but
 * without prestiging, for `durationMs`, and calls `onVisit` at every later
 * visit with the copy and its engine. Provided by `simulateOrder`.
 */
export type RunLookahead = (state: GameState, tSimMs: number, durationMs: number, onVisit: (state: GameState, engine: Engine, tSimMs: number) => void) => void;

/** What the game does by itself while the page is open, without the player visiting. */
export interface RunAutomation {
  /** Moves the game performs by itself while the page is open. */
  moves?: (state: GameState) => ReadonlySet<string>;
  /** Producers (in `producerCurrency`) the game buys at max by itself while the page is open. */
  producers?: (state: GameState) => ReadonlySet<string>;
}

export interface RunPolicyOptions {
  /** Time between two visits of the policy, a multiple of 60 000 ms. */
  visitMs: number;
  prestigeCode: string;
  prestigeRule: CalibrationPrestigeRule;
  /** Codes of the moves, in the order they are tried. */
  movePriority: string[];
  /** Producers paid in this currency are bought at buy max, from the highest open one. */
  producerCurrency: string;
  /** The player's presence; absent = a visit every `visitMs`, as before. */
  presence?: PresenceProfile;
  automation?: RunAutomation;
}

/**
 * The generic run played during a calibration. Each visit, in order:
 * (1) buys the shop items of `order` while the next one can be paid, stopping
 * at the first one that cannot; (2) prestiges when the rule says so, and then
 * returns only the purchases and the prestige; (3) uses the ready moves in
 * `movePriority` and, if any is ready, ends the visit (the harness decides again
 * right after the moves); (4) buys the producers of `producerCurrency` at buy max,
 * from the highest unlocked one.
 *
 * With `presence` the harness calls `decide` every minute: a closed page decides
 * nothing; a visit runs the four steps; an open minute without a visit only runs
 * `automation` (the ready moves it covers, else the producers it covers), never
 * the shop nor the prestige.
 *
 * The cursor into the order is read from the state (`bought`) at every visit,
 * so a dropped intent never desynchronises the policy. Within one visit the
 * state does not change, so the budget of each pool is tracked here; only the
 * main cost line of an item is budgeted (the harness drops what it cannot pay).
 */
export function createRunPolicy(opts: RunPolicyOptions, order: ShopOrder, moves: GameMove[], lookahead?: RunLookahead): BotPolicy {
  const moveByCode = new Map(moves.map((move) => [move.code, move]));
  if (opts.prestigeRule.kind === "bestRate" && !lookahead) throw new Error("createRunPolicy: the bestRate prestige rule needs a lookahead");
  /** Start of the current run, and the gain `bestRate` waits for in it (null: not planned yet). */
  let runStartMs = 0;
  let plan: { gain: number; atMs: number } | null = null;

  /**
   * `bestRate`: the first time the prestige pays, plays the run on and picks the
   * visit with the most gain per hour of run, "now" included (ties: the
   * earliest). Then fires as soon as that gain is reached, or at the first
   * paying visit past the planned time.
   */
  const bestRateFires = (
    rule: Extract<CalibrationPrestigeRule, { kind: "bestRate" }>,
    state: GameState,
    engine: Engine,
    prestige: GameState["prestiges"][number],
    tSimMs: number,
  ): boolean => {
    const gain = engine.prestigeGain(state, prestige).toNumber();
    if (!(gain >= 1)) return false;
    if (!plan) {
      const elapsed = tSimMs - runStartMs;
      let best = { gain, atMs: tSimMs, rate: gain / Math.max(elapsed, 1) };
      const horizon = Math.max(elapsed * (rule.horizonFactor ?? 1), rule.minHorizonMs ?? 3_600_000);
      lookahead!(state, tSimMs, horizon, (copy, copyEngine, t) => {
        const prestigeThere = copy.prestiges.find((p) => p.code === prestige.code);
        if (!prestigeThere) return;
        const g = copyEngine.prestigeGain(copy, prestigeThere).toNumber();
        const rate = g / Math.max(t - runStartMs, 1);
        if (g >= 1 && rate > best.rate) best = { gain: g, atMs: t, rate };
      });
      plan = { gain: best.gain, atMs: best.atMs };
    }
    return gain >= plan.gain || tSimMs > plan.atMs;
  };

  /** (3) Queues the ready moves of `movePriority` (only those in `allowed`, when given); true if any. */
  const queueMoves = (state: GameState, engine: BotContext["engine"], intents: BotIntent[], allowed?: ReadonlySet<string>): boolean => {
    let queued = false;
    for (const code of opts.movePriority) {
      if (allowed && !allowed.has(code)) continue;
      const move = moveByCode.get(code);
      if (move?.ready(state, engine)) {
        intents.push({ kind: "move", code });
        queued = true;
      }
    }
    return queued;
  };

  /** (4) Queues the producers of `producerCurrency` (only those in `allowed`, when given) at buy max, highest unlocked first. */
  const buyProducers = (
    state: GameState,
    engine: BotContext["engine"],
    intents: BotIntent[],
    poolBudget: (code: string) => Decimal,
    budget: Map<string, Decimal>,
    allowed?: ReadonlySet<string>,
  ): void => {
    for (const producer of [...state.producers].reverse()) {
      if (producer.currencyCode !== opts.producerCurrency || !isUnlocked(state, producer)) continue;
      if (allowed && !allowed.has(producer.code)) continue;
      const left = poolBudget(producer.currencyCode);
      const amount = Math.floor(N(engine.maxBuyableAmount(producer, { amount: left })).toNumber());
      if (!(amount > 0)) continue;
      budget.set(producer.currencyCode, left.sub(N(engine.costToBuyNext(producer, amount))));
      intents.push({ kind: "buyProducer", code: producer.code, amount });
    }
  };

  return {
    id: "calibration-run",
    decide({ state, engine, tSimMs }: BotContext): BotIntent[] {
      const intents: BotIntent[] = [];
      const budget = new Map<string, Decimal>();
      const poolBudget = (code: string): Decimal => {
        let value = budget.get(code);
        if (value === undefined) {
          value = N(state.currencies.find((c) => c.code === code)?.amount ?? 0);
          budget.set(code, value);
        }
        return value;
      };

      const presence = opts.presence;
      if (presence && !isVisit(presence, tSimMs)) {
        // Closed page: nothing. Open between two visits: only what the game does by itself.
        if (!isOpen(presence, tSimMs)) return intents;
        const autoMoves = opts.automation?.moves?.(state);
        const autoProducers = opts.automation?.producers?.(state);
        if (autoMoves && queueMoves(state, engine, intents, autoMoves)) return intents;
        if (autoProducers) buyProducers(state, engine, intents, poolBudget, budget, autoProducers);
        return intents;
      }

      // (1) Shop items, in order, up to the first one that is blocked.
      const planned = new Map<string, number>();
      for (const item of order) {
        const upgrade = state.upgrades.find((u) => u.code === item.code);
        if (!upgrade) throw new Error(`calibration order refers to unknown upgrade "${item.code}"`);
        const pending = planned.get(item.code) ?? 0;
        const bought = N(upgrade.bought).toNumber();
        if (bought >= item.level) continue; // already owned (a dropped intent, or an earlier visit)
        if (bought + pending + 1 !== item.level) break; // an earlier level is still missing

        let cost: Decimal;
        if (pending === 0) {
          if (upgradePurchaseBlock(engine, state, upgrade) !== null) break;
          cost = N(engine.costToBuyNext(upgrade, 1));
        } else {
          if (
            upgrade.max &&
            N(upgrade.amount)
              .add(pending + 1)
              .gt(N(upgrade.max))
          )
            break;
          if (!isUnlocked(state, upgrade)) break;
          cost = N(engine.costToBuyNext(upgrade, pending + 1)).sub(N(engine.costToBuyNext(upgrade, pending)));
        }
        const left = poolBudget(upgrade.currencyCode);
        if (left.lt(cost)) break;
        budget.set(upgrade.currencyCode, left.sub(cost));
        planned.set(item.code, pending + 1);
        intents.push({ kind: "buyUpgrade", code: item.code });
      }

      // (2) Prestige.
      const prestige = state.prestiges.find((p) => p.code === opts.prestigeCode);
      if (prestige) {
        const rule = opts.prestigeRule;
        const fires =
          rule.kind === "rate"
            ? rateRulePrestige(engine, state, prestige, { minRunMs: rule.minRunMs, drop: rule.drop })
            : rule.kind === "target"
              ? engine.prestigeGain(state, prestige).gte(rule.minGain)
              : bestRateFires(rule, state, engine, prestige, tSimMs);
        if (fires) {
          runStartMs = tSimMs;
          plan = null;
          return [...intents, { kind: "prestige", code: prestige.code }];
        }
      }

      // (3) + (4)
      const movesQueued = queueMoves(state, engine, intents);
      if (!movesQueued) buyProducers(state, engine, intents, poolBudget, budget);

      return intents;
    },
  };
}
