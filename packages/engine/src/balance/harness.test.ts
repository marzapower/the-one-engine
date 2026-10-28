import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { silentLogger } from "../core/di/defaults";
import { Engine } from "../core/engine";
import type { Currency, Prestige, Producer, Upgrade } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { N, NR } from "../nums";
import { createInitialState } from "../state";
import type { GameState } from "../state";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import type { ResolvedClickable } from "./definition";
import { GreedyBot } from "./greedy-bot";
import { runBalanceSim } from "./harness";
import { MetricsCollector } from "./metrics";
import type { BotPolicy, GameMove, SimAction } from "./types";

const linearScaling = (base: number, coeff: number) => ({
  base: NR(base),
  coeff: NR(coeff),
  func: ScalingMethod.Linear,
  scaleOn: ScaleOn.self,
});

function tinyState(): GameState {
  const primary: Currency = { code: "primary", name: "Primary", primary: true, amount: NR(0), persecDelta: NR(0) };
  const prestigeCurrency: Currency = { code: "prestige", name: "Prestige", amount: NR(0), earned: NR(0) };

  const producer: Producer = {
    code: "p1",
    name: "Producer",
    currencyCode: "primary",
    amount: NR(0),
    bought: NR(0),
    produces: [{ code: "primary", persec: NR(1) }],
    scaling: linearScaling(5, 1.1),
  };

  const prestige: Prestige = {
    code: "convert",
    currencyCode: "prestige",
    source: { kind: "currency", code: "primary", path: "amount" },
    target: { kind: "currency", code: "prestige", path: "amount" },
    func: { base: NR(0), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
    effects: [],
  };

  return {
    ...createInitialState(),
    producers: [producer],
    currencies: [primary, prestigeCurrency],
    prestiges: [prestige],
  };
}

describe("runBalanceSim", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("produces milestones, series and purchaseRotation on a tiny scripted run", () => {
    const report = runBalanceSim({
      state: tinyState(),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
    });

    expect(report.series.length).toBeGreaterThan(0);
    expect(report.meta.botId).toBe("greedy");
    expect(report.purchaseRotation).toEqual({ switches: expect.any(Number), perHour: expect.any(Number) });
    expect(Array.isArray(report.milestones)).toBe(true);
  });

  it("never writes to the console", () => {
    runBalanceSim({
      state: tinyState(),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
    });

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// clickable
// ---------------------------------------------------------------------------

/** Constant-cost linear scaling (coeff 0): `nextUnitCost` is `base` forever, regardless of `bought`. */
const constCostScaling = (base: number) => ({ base: NR(base), coeff: NR(0), func: ScalingMethod.Linear, scaleOn: ScaleOn.self });

/** A primary currency + one producer priced (in `producerCurrencyCode`) at a constant cost, producing primary. */
function stuckState(opts: { primaryAmount: number; cost?: number; producerCurrencyCode?: string; extraCurrencies?: Currency[] }): GameState {
  const primary: Currency = { code: "primary", name: "Primary", primary: true, amount: NR(opts.primaryAmount), persecDelta: NR(0) };
  const producer: Producer = {
    code: "p1",
    name: "Producer",
    currencyCode: opts.producerCurrencyCode ?? "primary",
    amount: NR(0),
    bought: NR(0),
    produces: [{ code: "primary", persec: NR(1) }],
    scaling: constCostScaling(opts.cost ?? 100),
  };

  return { ...createInitialState(), producers: [producer], currencies: [primary, ...(opts.extraCurrencies ?? [])], prestiges: [], upgrades: [] };
}

describe("runBalanceSim with clickable", () => {
  it("without clickable the producer is never bought; with it, it is bought around 85-90s and clicks.count is 85-90", () => {
    const clickable: ResolvedClickable = { currencyCode: "primary", gain: 1, cooldownMs: 1000 };
    const params = { durationMs: 120_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 };

    const without = runBalanceSim({ state: stuckState({ primaryAmount: 15 }), bot: new GreedyBot(), params });
    expect(without.actionsCount.p1).toBeUndefined();
    expect(without.clicks).toEqual({ count: 0, lastMs: null });

    const withClick = runBalanceSim({ state: stuckState({ primaryAmount: 15 }), bot: new GreedyBot(), params, clickable });
    expect(withClick.actionsCount.p1).toBe(1);
    expect(withClick.clicks.count).toBeGreaterThanOrEqual(85);
    expect(withClick.clicks.count).toBeLessThanOrEqual(90);

    const buy = withClick.actions.find((a) => a.kind === "buyProducer");
    expect(buy?.tSimMs).toBeGreaterThanOrEqual(84_000);
    expect(buy?.tSimMs).toBeLessThanOrEqual(91_000);
  });

  it("never taps when the primary is already rich (nothing is stuck)", () => {
    const clickable: ResolvedClickable = { currencyCode: "primary", gain: 1, cooldownMs: 1000 };
    const report = runBalanceSim({
      state: stuckState({ primaryAmount: 10_000 }),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
      clickable,
    });

    expect(report.clicks).toEqual({ count: 0, lastMs: null });
  });

  it("taps 3 times in the first 1000ms chunk, then 2 per chunk, at cooldownMs 500 with 1000ms chunks", () => {
    const clickable: ResolvedClickable = { currencyCode: "primary", gain: 1, cooldownMs: 500 };
    const report = runBalanceSim({
      state: stuckState({ primaryAmount: 0, cost: 100_000 }),
      bot: new GreedyBot(),
      // decisionIntervalMs way past durationMs: the producer is never remotely affordable, so the bot never fires.
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000_000, tickLengthMs: 250 },
      clickable,
    });

    // 3 taps in chunk 1 (catch-up from nextTapMs = 0), then a steady 2/chunk in chunks 2-5.
    expect(report.clicks.count).toBe(3 + 2 * 4);
  });

  it("caps taps at the deficit: gain 10 against a 25 deficit taps exactly 3 times, then the producer is bought", () => {
    const clickable: ResolvedClickable = { currencyCode: "primary", gain: 10, cooldownMs: 1000 };
    const report = runBalanceSim({
      state: stuckState({ primaryAmount: 75, cost: 100 }),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
      clickable,
    });

    expect(report.clicks.count).toBe(3);
    expect(report.actionsCount.p1).toBe(1);
  });

  it("never taps when the only blocking producer is priced in another currency", () => {
    const motes: Currency = { code: "motes", name: "Motes", amount: NR(0) };
    const clickable: ResolvedClickable = { currencyCode: "primary", gain: 1, cooldownMs: 1000 };

    const report = runBalanceSim({
      state: stuckState({ primaryAmount: 15, producerCurrencyCode: "motes", extraCurrencies: [motes] }),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
      clickable,
    });

    expect(report.clicks).toEqual({ count: 0, lastMs: null });
  });

  it("never throws and never taps when the clickable's currency does not exist", () => {
    const clickable: ResolvedClickable = { currencyCode: "phantom", gain: 1, cooldownMs: 1000 };

    const report = runBalanceSim({
      state: stuckState({ primaryAmount: 15 }),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
      clickable,
    });

    expect(report.clicks).toEqual({ count: 0, lastMs: null });
  });
});

describe("runBalanceSim canTap", () => {
  const clickable: ResolvedClickable = { currencyCode: "primary", gain: 1, cooldownMs: 1000 };
  const params = { durationMs: 120_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 };

  it("never taps when canTap is false", () => {
    const report = runBalanceSim({ state: stuckState({ primaryAmount: 15 }), bot: new GreedyBot(), params, clickable, canTap: () => false });
    expect(report.clicks).toEqual({ count: 0, lastMs: null });
    expect(report.actionsCount.p1).toBeUndefined();
  });

  it("taps as without it when canTap is true", () => {
    const plain = runBalanceSim({ state: stuckState({ primaryAmount: 15 }), bot: new GreedyBot(), params, clickable });
    const allowed = runBalanceSim({ state: stuckState({ primaryAmount: 15 }), bot: new GreedyBot(), params, clickable, canTap: () => true });
    expect(allowed.clicks).toEqual(plain.clicks);
    expect(allowed.actions).toEqual(plain.actions);
  });

  it("taps only in the chunks it allows", () => {
    const seen: number[] = [];
    const report = runBalanceSim({
      state: stuckState({ primaryAmount: 0 }),
      bot: new GreedyBot(),
      params: { ...params, durationMs: 10_000 },
      clickable,
      canTap: (t) => {
        seen.push(t);
        return t > 5_000;
      },
    });
    expect(seen).toHaveLength(10);
    expect(report.clicks.lastMs).toBeGreaterThan(5_000);
    expect(report.clicks.count).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Non-regression reference: GreedyBot with default options
// ---------------------------------------------------------------------------

/**
 * Small fixture exercising every candidate kind the bot prices: a producer
 * chain, a currency-paid upgrade, a producer-paid upgrade, a prestige with
 * a shop upgrade (utility-free), and a prestige-currency mult upgrade.
 */
function referenceState(): GameState {
  const lin = (base: number, coeff: number) => ({ base: NR(base), coeff: NR(coeff), func: ScalingMethod.Linear, scaleOn: ScaleOn.self });
  const primary: Currency = { code: "primary", name: "Primary", primary: true, amount: NR(10), persecDelta: NR(0) };
  const gems: Currency = { code: "gems", name: "Gems", amount: NR(0), earned: NR(0) };
  const p1: Producer = { code: "p1", name: "P1", currencyCode: "primary", amount: NR(0), bought: NR(0), produces: [{ code: "primary", persec: NR(1) }], scaling: lin(10, 4) };
  const p2: Producer = { code: "p2", name: "P2", currencyCode: "primary", amount: NR(0), bought: NR(0), produces: [{ code: "p1", persec: NR(0.2) }], scaling: lin(300, 150) };
  const u1: Upgrade = {
    code: "u1",
    name: "U1",
    currencyCode: "primary",
    amount: NR(0),
    bought: NR(0),
    max: NR(5),
    scaling: lin(500, 400),
    effects: [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func: lin(1, 0.3) }],
  };
  const u2: Upgrade = {
    code: "u2",
    name: "U2",
    currencyCode: "p1",
    amount: NR(0),
    bought: NR(0),
    max: NR(3),
    scaling: lin(5, 3),
    effects: [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func: lin(1, 0.6) }],
  };
  const shop: Upgrade = {
    code: "shop",
    name: "Shop",
    currencyCode: "gems",
    amount: NR(0),
    bought: NR(0),
    scaling: lin(50, 50),
    effects: [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func: lin(1, 0.05) }],
  };
  const prestige: Prestige = {
    code: "convert",
    currencyCode: "gems",
    source: { kind: "currency", code: "primary", path: "amount" },
    target: { kind: "currency", code: "gems", path: "amount" },
    func: { base: NR(0), coeff: NR(0.0004), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
    effects: [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func: lin(1, 0.01) }],
  };
  return { ...createInitialState(), currencies: [primary, gems], producers: [p1, p2], upgrades: [u1, u2, shop], prestiges: [prestige] };
}

describe("GreedyBot default behaviour reference (non-regression)", () => {
  it("fixes actions per code, prestige times and dead time of a 30-minute fixture run", () => {
    const report = runBalanceSim({
      state: referenceState(),
      bot: new GreedyBot(),
      params: { durationMs: 30 * 60_000, sampleIntervalMs: 1_000, decisionIntervalMs: 5_000, tickLengthMs: 250 },
    });
    const prestigeTimes = report.actions.filter((a) => a.kind === "prestige").map((a) => a.tSimMs);
    // Expected values were computed on the code BEFORE the waiting/impact work (HEAD 1e3fde4).
    expect(report.actionsCount).toEqual({ p1: 857, p2: 286, u1: 5, u2: 3, convert: 37 });
    // Prestiges run back to back every decision (5 s) from 1620 s to the end.
    expect(prestigeTimes).toEqual(Array.from({ length: 37 }, (_, i) => 1_620_000 + i * 5_000));
    expect(report.deadTime.totalMs).toBe(129_000);
    expect(report.deadTime.windows).toHaveLength(55);
    expect(report.deadTime.windows[0]).toEqual({ fromMs: 2_000, toMs: 15_000 });
    expect(report.milestones).toHaveLength(59);
  });
});

describe("MetricsCollector waiting option", () => {
  /** Feeds a second collector (other waiting options) the very same samples as the run collector. */
  class TeeCollector extends MetricsCollector {
    constructor(
      engine: Engine,
      private readonly other: MetricsCollector,
    ) {
      super(engine);
    }

    override onSample(state: GameState, tSimMs: number): void {
      super.onSample(state, tSimMs);
      this.other.onSample(state, tSimMs);
    }
  }

  const params = { durationMs: 30 * 60_000, sampleIntervalMs: 1_000, decisionIntervalMs: 5_000, tickLengthMs: 250 };

  it("on the same trajectory, waiting with a threshold is >= waiting without it", () => {
    const engine = new Engine(250, { time: new MockTimeProvider(250), logger: silentLogger });
    const gated = new MetricsCollector(engine, {}, [], { minImpact: 0.05, horizonMs: 600_000, prestigeRatio: 1.5 });
    const collector = new TeeCollector(engine, gated);
    const report = runBalanceSim({ state: referenceState(), bot: new GreedyBot(), params, engine, collector });
    const gatedReport = gated.finalize(referenceState(), params.durationMs);

    expect(gatedReport.deadTime.totalMs).toBeGreaterThanOrEqual(report.deadTime.totalMs);
    expect(gatedReport.deadTime.totalMs).toBeGreaterThan(0);
  });

  /** Buys strictly inside a waiting window (a buy at `toMs` is the one that ends it). */
  function buysInsideWaits(minPurchaseImpact: number, maxWaitMs: number) {
    const engine = new Engine(250, { time: new MockTimeProvider(250), logger: silentLogger });
    const collector = new MetricsCollector(engine, {}, [], { minImpact: minPurchaseImpact, horizonMs: 600_000, prestigeRatio: 1.5 });
    const report = runBalanceSim({ state: referenceState(), bot: new GreedyBot({ minPurchaseImpact, maxWaitMs }), params, engine, collector });
    const buys = report.actions.filter((a) => a.kind !== "prestige").map((a) => a.tSimMs);
    const inside = buys.filter((t) => report.deadTime.windows.some((w) => t > w.fromMs && t < w.toMs));
    return { buys, inside, report };
  }

  it("with the same threshold on bot and collector, the gated bot never buys while waiting", () => {
    const { buys, inside, report } = buysInsideWaits(0.05, Number.POSITIVE_INFINITY);
    expect(report.deadTime.totalMs).toBeGreaterThan(0);
    expect(buys.length).toBeGreaterThan(0);
    expect(inside).toEqual([]);
  });

  it("buys inside a waiting window only as catch-up visits, at least maxWaitMs after the previous buy", () => {
    const maxWaitMs = 60_000;
    const { buys, inside } = buysInsideWaits(0.05, maxWaitMs);
    expect(inside.length).toBeGreaterThan(0);
    const visits = [...new Set(buys)];
    for (const t of new Set(inside)) {
      const previous = visits.filter((v) => v < t).at(-1) ?? 0;
      expect(t - previous).toBeGreaterThanOrEqual(maxWaitMs);
    }
  });

  it("rejects invalid waiting options at construction", () => {
    const engine = new Engine(250, { time: new MockTimeProvider(250), logger: silentLogger });
    const ok = { minImpact: 0.01, horizonMs: 600_000, prestigeRatio: 1.5 };
    expect(() => new MetricsCollector(engine, {}, [], { ...ok, minImpact: -1 })).toThrow(/minImpact/);
    expect(() => new MetricsCollector(engine, {}, [], { ...ok, minImpact: Number.NaN })).toThrow(/minImpact/);
    expect(() => new MetricsCollector(engine, {}, [], { ...ok, horizonMs: 0 })).toThrow(/horizonMs/);
    expect(() => new MetricsCollector(engine, {}, [], { ...ok, horizonMs: Number.POSITIVE_INFINITY })).toThrow(/horizonMs/);
  });
});

describe("runBalanceSim — extra costs in actions", () => {
  it("adds `costs` to an action only for entities with extra costs", () => {
    const state = tinyState();
    state.currencies = [
      { code: "primary", name: "Primary", primary: true, amount: NR(1000), persecDelta: NR(0) },
      { code: "gems", name: "Gems", amount: NR(1000) },
    ];
    const plain = { ...state.producers[0], code: "plain", scaling: linearScaling(5, 0) } as Producer;
    const rich = { ...plain, code: "rich", extraCosts: [{ currencyCode: "gems", scaling: linearScaling(3, 0) }] } as Producer;
    const up = (code: string, extraCosts?: Upgrade["extraCosts"]): Upgrade => ({
      code,
      name: code,
      currencyCode: "primary",
      amount: NR(0),
      bought: NR(0),
      scaling: linearScaling(7, 0),
      effects: [],
      extraCosts,
    });
    state.producers = [plain, rich];
    state.upgrades = [up("uPlain"), up("uRich", [{ currencyCode: "gems", scaling: linearScaling(2, 0) }])];
    state.prestiges = [];

    let decided = false;
    const bot = {
      id: "scripted",
      decide: () => {
        if (decided) return [];
        decided = true;
        return [
          { kind: "buyProducer" as const, code: "plain", amount: 1 },
          { kind: "buyProducer" as const, code: "rich", amount: 2 },
          { kind: "buyUpgrade" as const, code: "uPlain" },
          { kind: "buyUpgrade" as const, code: "uRich" },
        ];
      },
    };
    const engine = new Engine(250, { time: new MockTimeProvider(250), logger: silentLogger });
    const collector = new MetricsCollector(engine);
    const actions: SimAction[] = [];
    const original = collector.onAction.bind(collector);
    collector.onAction = (action, s) => {
      actions.push(action);
      original(action, s);
    };

    runBalanceSim({ state, bot, engine, collector, params: { durationMs: 2000, sampleIntervalMs: 1000, decisionIntervalMs: 1000 } });

    const byCode = (code: string) => actions.find((a) => a.kind !== "prestige" && a.code === code) as Extract<SimAction, { cost: unknown }>;
    expect(actions).toHaveLength(4);
    expect(byCode("plain").costs).toBeUndefined();
    expect("costs" in byCode("plain")).toBe(false);
    expect(byCode("uPlain").costs).toBeUndefined();
    expect(byCode("rich").cost).toEqual(NR(10));
    expect(byCode("rich").costs?.map((l) => [l.currencyCode, N(l.cost).toNumber()])).toEqual([
      ["primary", 10],
      ["gems", 6],
    ]);
    expect(byCode("uRich").costs?.map((l) => l.currencyCode)).toEqual(["primary", "gems"]);
  });
});

describe("runBalanceSim moves and shouldStop", () => {
  const primaryOf = (state: GameState) => state.currencies.find((c) => c.code === "primary")!;

  it("move intents apply registered moves and are recorded", () => {
    const state = tinyState();
    primaryOf(state).amount = NR(10);
    const double: GameMove = {
      code: "double",
      ready: (s) => N(s.currencies.find((c) => c.code === "primary")!.amount).gte(10),
      apply: (s) => {
        const c = s.currencies.find((x) => x.code === "primary")!;
        c.amount = NR(N(c.amount).mul(2));
        return true;
      },
    };
    const never: GameMove = { code: "never", ready: () => false, apply: () => true };
    const bot: BotPolicy = {
      id: "mover",
      decide: () => [
        { kind: "move", code: "double" },
        { kind: "move", code: "ghost" },
        { kind: "move", code: "never" },
      ],
    };

    const report = runBalanceSim({
      state,
      bot,
      moves: [double, never],
      params: { durationMs: 1000, sampleIntervalMs: 1000, decisionIntervalMs: 1000 },
    });

    const moves = report.actions.filter((a) => a.kind === "move");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: "move", code: "double" });
    expect(N(primaryOf(state).amount).toNumber()).toBe(20);
    expect(report.meta.droppedIntents).toBe(2);
  });

  it("move intents are dropped when apply returns false or no registry is given", () => {
    const refuse: GameMove = { code: "refuse", ready: () => true, apply: () => false };
    const bot: BotPolicy = { id: "mover", decide: () => [{ kind: "move", code: "refuse" }] };
    const params = { durationMs: 1000, sampleIntervalMs: 1000, decisionIntervalMs: 1000 };

    const refused = runBalanceSim({ state: tinyState(), bot, moves: [refuse], params });
    const noRegistry = runBalanceSim({ state: tinyState(), bot, params });

    expect(refused.actions).toHaveLength(0);
    expect(refused.meta.droppedIntents).toBe(1);
    expect(noRegistry.meta.droppedIntents).toBe(1);
  });

  it("shouldStop ends the run early", () => {
    const sampleIntervalMs = 5_000;
    const report = runBalanceSim({
      state: tinyState(),
      bot: new GreedyBot(),
      shouldStop: (_s, tSimMs) => tSimMs >= 30_000,
      params: { durationMs: 120_000, sampleIntervalMs, decisionIntervalMs: 5_000 },
    });

    const last = report.series[report.series.length - 1]!;
    expect(last.tSimMs).toBeLessThanOrEqual(30_000 + sampleIntervalMs);
    expect(last.tSimMs).toBeLessThan(120_000);
  });
});

describe("runBalanceSim — redecideAfterMoves", () => {
  it("asks the bot again at the same time after a move, only once, and only when asked", () => {
    const run = (redecideAfterMoves: boolean) => {
      const state = tinyState();
      state.currencies.find((c) => c.code === "primary")!.amount = NR(10);
      const calls: number[] = [];
      const bot: BotPolicy = {
        id: "mover",
        decide: ({ tSimMs }) => {
          calls.push(tSimMs);
          return [{ kind: "move", code: "noop" }];
        },
      };
      const moves: GameMove[] = [{ code: "noop", ready: () => true, apply: () => true }];
      runBalanceSim({ state, bot, moves, redecideAfterMoves, params: { durationMs: 2_000, tickLengthMs: 1_000, decisionIntervalMs: 1_000, sampleIntervalMs: 1_000 } });
      return calls;
    };
    expect(run(true)).toEqual([1_000, 1_000, 2_000, 2_000]);
    expect(run(false)).toEqual([1_000, 2_000]);
  });
});
