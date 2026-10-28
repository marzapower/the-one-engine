import { silentLogger } from "../core/di/defaults";
import { Engine } from "../core/engine";
import { buyProducer, buyUpgrade } from "../core/purchase";
import { type Decimal, N, NR } from "../nums";
import type { GameState } from "../state";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import type { ResolvedClickable } from "./definition";
import { MetricsCollector } from "./metrics";
import { nextUnitCost } from "./queries";
import { DEFAULT_HARNESS_PARAMS } from "./types";
import type { BalanceReport, BotIntent, BotPolicy, GameMove, HarnessParams, SimAction } from "./types";

export interface RunBalanceSimOptions {
  state: GameState;
  bot: BotPolicy;
  params?: Partial<HarnessParams>;
  engine?: Engine;
  collector?: MetricsCollector;
  /**
   * Manual-tap parameters. Taps happen ONLY when this option is passed — a
   * `GameDefinition.clickable` declared on the definition is not enough by
   * itself: callers resolve it with `resolveClickable` (definition.ts) and
   * pass the result explicitly. A tap adds `gain` raw to the currency's
   * `amount` (no gainMult, no effects, no `earned`), like The One
   * Incremental's `gameSlice` tap.
   */
  clickable?: ResolvedClickable;
  /**
   * When given and false for the chunk ending at `tSimMs`, no taps happen in
   * that chunk (the tap clock is left untouched). Default: taps are always allowed.
   */
  canTap?: (tSimMs: number) => boolean;
  /** Registry of game-specific moves a bot can request with `{ kind: "move", code }`. */
  moves?: GameMove[];
  /**
   * Evaluated after every decision point (including ones that applied
   * nothing). When true the loop ends and the report closes normally at the
   * current `tSimMs`.
   */
  shouldStop?: (state: GameState, tSimMs: number) => boolean;
  /**
   * When a decision point applied at least one move, ask the bot once more at
   * the same `tSimMs`: a move can reset what the bot priced (a micro-prestige
   * wipes the currency), and the player keeps playing right after it.
   */
  redecideAfterMoves?: boolean;
}

/**
 * Runs a headless balance simulation: a bot plays a scripted run against a
 * plain `GameState` and a `MetricsCollector` turns the samples/actions into
 * a `BalanceReport`. The default engine logs nowhere (`silentLogger`): a
 * simulation run never writes to the console.
 */
export function runBalanceSim(opts: RunBalanceSimOptions): BalanceReport {
  const params: HarnessParams = { ...DEFAULT_HARNESS_PARAMS, ...opts.params };
  const engine = opts.engine ?? new Engine(params.tickLengthMs, { time: new MockTimeProvider(params.tickLengthMs), logger: silentLogger });
  const collector = opts.collector ?? new MetricsCollector(engine);
  const { state, bot, clickable, canTap, moves, shouldStop, redecideAfterMoves } = opts;

  let droppedIntents = 0;
  let tSimMs = 0;
  let nextDecisionMs = 0;
  let nextTapMs = 0;

  while (tSimMs < params.durationMs) {
    const chunk = Math.min(params.sampleIntervalMs, params.durationMs - tSimMs);
    engine.advance(state, chunk);
    tSimMs += chunk;

    if (clickable && (!canTap || canTap(tSimMs))) {
      nextTapMs = applyTaps(state, engine, clickable, collector, tSimMs, chunk, nextTapMs);
    }

    collector.onSample(state, tSimMs);

    if (tSimMs >= nextDecisionMs) {
      for (let round = 0; round < (redecideAfterMoves ? 2 : 1); round++) {
        const intents = bot.decide({ state, engine, tSimMs });
        const applied = intents.slice(0, params.maxActionsPerDecision);
        droppedIntents += intents.length - applied.length;

        let movesApplied = 0;
        for (const intent of applied) {
          const action = applyIntent(state, engine, intent, tSimMs, moves);
          if (action) {
            collector.onAction(action, state);
            if (action.kind === "move") movesApplied++;
          } else {
            droppedIntents++;
          }
        }
        if (movesApplied === 0) break;
      }

      nextDecisionMs += params.decisionIntervalMs;

      if (shouldStop?.(state, tSimMs)) break;
    }
  }

  const report = collector.finalize(state, tSimMs);
  report.meta.botId = bot.id;
  report.meta.params = params;
  report.meta.droppedIntents = droppedIntents;
  report.meta.validationErrors = state.stats.validationErrors;

  return report;
}

/**
 * Applies manual taps for the chunk that just ended at `tSimMs` (length
 * `chunk`), per the "click only when stuck" rhythm, and returns the updated
 * `nextTapMs`.
 *
 * Stuck (evaluated once per chunk, before tapping): the click's currency
 * exists; at least one producer is priced in it; NONE of those producers'
 * next single unit is affordable (`nextUnitCost`, same cost function
 * `queries.ts` uses, MAIN cost only: tapping is a local policy that ignores
 * `extraCosts`); AND that currency's `persecDelta` is <= 0. Upgrades and
 * prestiges are ignored. A currency that can't be found never taps and never
 * throws. If not stuck, `nextTapMs` is left untouched.
 *
 * Rhythm: a tap is "due" every `cooldownMs`. `nextTapMs` never accumulates a
 * backlog across chunks — if it lags behind the start of this chunk it is
 * pulled up to the chunk start first, so the first tap of a chunk is ready at
 * the chunk's own start. The tap count for the chunk is then capped so the
 * currency never overshoots past the cheapest blocking producer by more than
 * one tap's worth (`ceil(minDeficit / gain)`, `minDeficit` = the smallest
 * `nextUnitCost - currency.amount` across the blocking producers — positive
 * by construction, since the currency is stuck).
 */
function applyTaps(state: GameState, engine: Engine, clickable: ResolvedClickable, collector: MetricsCollector, tSimMs: number, chunk: number, nextTapMs: number): number {
  const currency = state.currencies.find((c) => c.code === clickable.currencyCode);
  if (!currency) return nextTapMs;

  const blockingProducers = state.producers.filter((p) => p.currencyCode === clickable.currencyCode);
  if (blockingProducers.length === 0) return nextTapMs;

  if (N(currency.persecDelta ?? 0).gt(0)) return nextTapMs;

  let minDeficit: Decimal | null = null;
  for (const producer of blockingProducers) {
    const deficit = N(nextUnitCost(engine, producer)).sub(N(currency.amount));
    if (deficit.lte(0)) return nextTapMs; // this producer is affordable — not stuck.
    if (minDeficit === null || deficit.lt(minDeficit)) minDeficit = deficit;
  }
  if (minDeficit === null) return nextTapMs;

  let updatedNextTapMs = nextTapMs;
  if (updatedNextTapMs <= tSimMs - chunk) updatedNextTapMs = tSimMs - chunk;
  if (updatedNextTapMs > tSimMs) return updatedNextTapMs;

  const due = Math.floor((tSimMs - updatedNextTapMs) / clickable.cooldownMs) + 1;
  const cap = Math.ceil(minDeficit.div(clickable.gain).toNumber());
  // A non-numeric cost (NaN) must not poison the currency and the tap clock for the rest of the run.
  if (Number.isNaN(cap)) return updatedNextTapMs;
  const n = Math.min(due, cap);

  currency.amount = NR(N(currency.amount).add(N(clickable.gain).mul(n)));
  updatedNextTapMs += n * clickable.cooldownMs;
  collector.onClick(tSimMs, n);

  return updatedNextTapMs;
}

/**
 * Single point of mutation for bot intents: never throws, unaffordable or
 * invalid intents are silently rejected (return undefined), and the caller
 * counts the drop.
 */
function applyIntent(state: GameState, engine: Engine, intent: BotIntent, tSimMs: number, moves?: GameMove[]): SimAction | undefined {
  switch (intent.kind) {
    case "buyProducer":
      return applyBuyProducer(state, engine, intent.code, intent.amount, tSimMs);
    case "buyUpgrade":
      return applyBuyUpgrade(state, engine, intent.code, tSimMs);
    case "prestige":
      return applyPrestige(state, engine, intent.code, tSimMs);
    case "move":
      return applyMove(state, engine, intent.code, tSimMs, moves);
  }
}

function applyBuyProducer(state: GameState, engine: Engine, code: string, amount: number, tSimMs: number): SimAction | undefined {
  if (amount <= 0) return undefined;

  const producer = state.producers.find((p) => p.code === code);
  if (!producer) return undefined;

  const cost = engine.costToBuyNext(producer, amount);
  const costs = producer.extraCosts?.length ? engine.costLinesToBuyNext(producer, amount) : undefined;
  if (!buyProducer(engine, state, code, amount)) return undefined;

  return { kind: "buyProducer", code, amount, cost, ...(costs && { costs }), tSimMs };
}

function applyBuyUpgrade(state: GameState, engine: Engine, code: string, tSimMs: number): SimAction | undefined {
  const upgrade = state.upgrades.find((u) => u.code === code);
  if (!upgrade) return undefined;

  const cost = engine.costToBuyNext(upgrade, 1);
  const costs = upgrade.extraCosts?.length ? engine.costLinesToBuyNext(upgrade, 1) : undefined;
  if (!buyUpgrade(engine, state, code)) return undefined;

  return { kind: "buyUpgrade", code, cost, ...(costs && { costs }), tSimMs };
}

function applyPrestige(state: GameState, engine: Engine, code: string, tSimMs: number): SimAction | undefined {
  const prestige = state.prestiges.find((p) => p.code === code);
  if (!prestige) return undefined;

  const gain = engine.prestigeGain(state, prestige);
  if (gain.lte(0)) return undefined;

  const performed = engine.performPrestige(state, prestige);
  if (!performed) return undefined;

  return { kind: "prestige", code, gain: NR(gain), tSimMs };
}

function applyMove(state: GameState, engine: Engine, code: string, tSimMs: number, moves?: GameMove[]): SimAction | undefined {
  const move = moves?.find((m) => m.code === code);
  if (!move || !move.ready(state, engine)) return undefined;
  if (!move.apply(state, engine)) return undefined;

  return { kind: "move", code, tSimMs };
}
