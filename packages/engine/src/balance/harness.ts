import { silentLogger } from "../core/di/defaults";
import { Engine } from "../core/engine";
import { N, NR } from "../nums";
import type { GameState } from "../state";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import { MetricsCollector } from "./metrics";
import { findCostPool } from "./queries";
import { DEFAULT_HARNESS_PARAMS } from "./types";
import type { BalanceReport, BotIntent, BotPolicy, HarnessParams, SimAction } from "./types";

export interface RunBalanceSimOptions {
  state: GameState;
  bot: BotPolicy;
  params?: Partial<HarnessParams>;
  engine?: Engine;
  collector?: MetricsCollector;
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
  const { state, bot } = opts;

  let droppedIntents = 0;
  let tSimMs = 0;
  let nextDecisionMs = 0;

  while (tSimMs < params.durationMs) {
    const chunk = Math.min(params.sampleIntervalMs, params.durationMs - tSimMs);
    engine.advance(state, chunk);
    tSimMs += chunk;
    collector.onSample(state, tSimMs);

    if (tSimMs >= nextDecisionMs) {
      const intents = bot.decide({ state, engine, tSimMs });
      const applied = intents.slice(0, params.maxActionsPerDecision);
      droppedIntents += intents.length - applied.length;

      for (const intent of applied) {
        const action = applyIntent(state, engine, intent, tSimMs);
        if (action) {
          collector.onAction(action, state);
        } else {
          droppedIntents++;
        }
      }

      nextDecisionMs += params.decisionIntervalMs;
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
 * Single point of mutation for bot intents: never throws, unaffordable or
 * invalid intents are silently rejected (return undefined), and the caller
 * counts the drop.
 */
function applyIntent(state: GameState, engine: Engine, intent: BotIntent, tSimMs: number): SimAction | undefined {
  switch (intent.kind) {
    case "buyProducer":
      return applyBuyProducer(state, engine, intent.code, intent.amount, tSimMs);
    case "buyUpgrade":
      return applyBuyUpgrade(state, engine, intent.code, tSimMs);
    case "prestige":
      return applyPrestige(state, engine, intent.code, tSimMs);
  }
}

function applyBuyProducer(state: GameState, engine: Engine, code: string, amount: number, tSimMs: number): SimAction | undefined {
  if (amount <= 0) return undefined;

  const producer = state.producers.find((p) => p.code === code);
  if (!producer) return undefined;

  const currency = state.currencies.find((c) => c.code === producer.currencyCode);
  if (!currency) return undefined;

  const cost = engine.costToBuyNext(producer, amount);
  if (N(cost).gt(N(currency.amount))) return undefined;

  currency.amount = NR(N(currency.amount).sub(N(cost)));
  producer.bought = NR(N(producer.bought).add(amount));
  producer.amount = NR(N(producer.amount).add(amount));

  return { kind: "buyProducer", code, amount, cost, tSimMs };
}

function applyBuyUpgrade(state: GameState, engine: Engine, code: string, tSimMs: number): SimAction | undefined {
  const upgrade = state.upgrades.find((u) => u.code === code);
  if (!upgrade) return undefined;
  if (upgrade.max && N(upgrade.amount).add(1).gt(N(upgrade.max))) return undefined;

  // Upgrades can be paid in a currency OR in producer units (their `amount` stock).
  const pool = findCostPool(state, upgrade.currencyCode);
  if (!pool) return undefined;

  const cost = engine.costToBuyNext(upgrade, 1);
  if (N(cost).gt(N(pool.amount))) return undefined;

  pool.amount = NR(N(pool.amount).sub(N(cost)));
  upgrade.bought = NR(N(upgrade.bought).add(1));
  upgrade.amount = NR(N(upgrade.amount).add(1));

  return { kind: "buyUpgrade", code, cost, tSimMs };
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
