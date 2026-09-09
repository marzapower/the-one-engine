import type { MutationEvent } from "../core/di/types";
import type { Engine } from "../core/engine";
import { N, NR } from "../nums";
import type { GameState } from "../state";
import type { MockStateAdapter } from "./MockStateAdapter";

/**
 * Fluent, test-only runner that scripts game actions against a headless Engine.
 * Intended use:
 *   new ScenarioRunner(state, engine, adapter)
 *     .advance(60000)
 *     .buy("e1", 10)
 *     .advance(30000)
 *     .snapshot();
 */
export class ScenarioRunner {
  constructor(
    private readonly state: GameState,
    private readonly engine: Engine,
    private readonly adapter: MockStateAdapter,
  ) {}

  advance(ms: number): this {
    this.engine.advance(this.state, ms);
    return this;
  }

  buy(producerCode: string, amount: number | "max"): this {
    const producer = this.state.producers.find((p) => p.code === producerCode);
    if (!producer) throw new Error(`Producer not found: ${producerCode}`);
    const currency = this.state.currencies.find((c) => c.code === producer.currencyCode);
    if (!currency) throw new Error(`Currency not found: ${producer.currencyCode}`);

    const buyAmount = amount === "max" ? N(this.engine.maxBuyableAmount(producer, currency)).toNumber() : amount;
    if (buyAmount <= 0) return this;

    const totalCost = this.engine.costToBuyNext(producer, buyAmount);
    if (N(currency.amount).lt(N(totalCost))) {
      throw new Error(`Insufficient ${currency.code}: need ${N(totalCost).toString()}, have ${N(currency.amount).toString()}`);
    }

    this.adapter.incrementAmount(this.state, currency, NR(N(totalCost).mul(-1)));
    producer.bought = NR(N(producer.bought).add(buyAmount));
    producer.amount = NR(N(producer.amount).add(buyAmount));
    return this;
  }

  resetPrestige(prestigeCode: string): this {
    const prestige = this.state.prestiges.find((p) => p.code === prestigeCode);
    if (!prestige) throw new Error(`Prestige not found: ${prestigeCode}`);
    this.adapter.resetForPrestige(this.state, prestigeCode);
    return this;
  }

  snapshot(): GameState {
    return structuredClone(this.state);
  }

  mutations(): MutationEvent[] {
    return this.adapter.getMutations();
  }
}
