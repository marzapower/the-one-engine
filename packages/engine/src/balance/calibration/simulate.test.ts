import { describe, expect, it } from "vitest";

import { silentLogger } from "../../core/di/defaults";
import { Engine } from "../../core/engine";
import type { Currency, Prestige, Producer, Upgrade } from "../../models/base";
import { ScaleOn, ScalingMethod } from "../../models/base";
import { N, NR } from "../../nums";
import { createInitialState } from "../../state";
import type { GameState } from "../../state";
import { MockTimeProvider } from "../../testing/MockTimeProvider";
import type { ResolvedClickable } from "../definition";
import { runBalanceSim } from "../harness";
import { MetricsCollector } from "../metrics";
import type { GameMove } from "../types";
import { type PresenceProfile, canTapAt, isOpen, isVisit } from "./presence";
import { type RunLookahead, type RunPolicyOptions, createRunPolicy } from "./run-policy";
import { type SimulateOrderInput, simulateOrder } from "./simulate";
import type { OrderJob, ShopOrder } from "./types";

const TICK_MS = 1000;

const growth = (base: number, coeff: number, func = ScalingMethod.Linear) => ({ base: NR(base), coeff: NR(coeff), func, scaleOn: ScaleOn.self });

/** One producer, a prestige whose currency declares `gainMult`, and two shop upgrades. */
function tinyGame(opts: { gainCost?: number } = {}): GameState {
  const primary: Currency = { code: "primary", name: "Primary", primary: true, amount: NR(0), persecDelta: NR(0), resetsOn: ["convert"] };
  const prestigeCurrency: Currency = { code: "prestige", name: "Prestige", amount: NR(0), earned: NR(0), gainMult: NR(1) };

  const producer: Producer = {
    code: "p1",
    name: "Producer",
    currencyCode: "primary",
    amount: NR(0),
    bought: NR(0),
    resetsOn: ["convert"],
    produces: [{ code: "primary", persec: NR(1) }],
    scaling: growth(5, 1),
  };

  const uMult: Upgrade = {
    code: "u-mult",
    name: "Mult",
    currencyCode: "prestige",
    amount: NR(0),
    bought: NR(0),
    scaling: growth(2, 0),
    effects: [{ stage: 0, target: { kind: "producer", code: "p1", path: "produces.*.persec" }, type: "mult", func: growth(1, 2, ScalingMethod.Geometric) }],
  };
  const uGain: Upgrade = {
    code: "u-gain",
    name: "Gain",
    currencyCode: "prestige",
    amount: NR(0),
    bought: NR(0),
    scaling: growth(opts.gainCost ?? 2, 0),
    effects: [{ stage: 0, target: { kind: "currency", code: "prestige", path: "gainMult" }, type: "mult", func: growth(1, 2, ScalingMethod.Geometric) }],
  };

  const prestige: Prestige = {
    code: "convert",
    currencyCode: "prestige",
    source: { kind: "currency", code: "primary", path: "amount" },
    target: { kind: "currency", code: "prestige", path: "amount" },
    func: { base: NR(0), coeff: NR(0.05), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
    effects: [],
  };

  return { ...createInitialState(), producers: [producer], currencies: [primary, prestigeCurrency], upgrades: [uMult, uGain], prestiges: [prestige] };
}

const CLICK: ResolvedClickable = { currencyCode: "primary", gain: 1, cooldownMs: 1000 };

const POLICY: RunPolicyOptions = {
  visitMs: 60_000,
  prestigeCode: "convert",
  prestigeRule: { kind: "target", minGain: 3 },
  movePriority: [],
  producerCurrency: "primary",
};

const job = (id: string, order: ShopOrder): OrderJob => ({ id, origin: "reference", order });

const MULT_THEN_GAIN: ShopOrder = [
  { code: "u-mult", level: 1 },
  { code: "u-gain", level: 1 },
];
const GAIN_THEN_MULT: ShopOrder = [
  { code: "u-gain", level: 1 },
  { code: "u-mult", level: 1 },
];

function makeSim(opts?: { gainCost?: number; earned?: number }): { state: GameState; engine: Engine } {
  const state = tinyGame(opts);
  if (opts?.earned !== undefined) state.currencies.find((c) => c.code === "prestige")!.earned = NR(opts.earned);
  return { state, engine: new Engine(TICK_MS, { time: new MockTimeProvider(TICK_MS), logger: silentLogger }) };
}

function input(over: Partial<SimulateOrderInput> & { job: OrderJob }): SimulateOrderInput {
  return { makeSim, moves: () => [], policy: POLICY, horizonMs: 40 * 60_000, milestones: [], tickLengthMs: TICK_MS, clickable: CLICK, ...over };
}

describe("simulateOrder", () => {
  it("plays runs with growing end times and buys the shop in the given order", () => {
    for (const order of [MULT_THEN_GAIN, GAIN_THEN_MULT]) {
      const result = simulateOrder(input({ job: job("o", order) }));
      expect(result.runs.length).toBeGreaterThan(1);
      for (const [i, run] of result.runs.entries()) {
        expect(run.index).toBe(i + 1);
        expect(run.ratePerHour).toBeGreaterThan(0);
        expect(run.endMs).toBeGreaterThan(run.startMs);
        if (i > 0) expect(run.endMs).toBeGreaterThan(result.runs[i - 1]!.endMs);
      }
      expect(result.purchases.map((p) => ({ code: p.code, level: p.level }))).toEqual(order);
      expect(result.blockedAt).toBeUndefined();
      expect(result.horizonMs).toBe(40 * 60_000);
    }
  });

  it("reports blockedAt and null milestones when an item is unreachable", () => {
    const result = simulateOrder(input({ job: job("b", GAIN_THEN_MULT), makeSim: () => makeSim({ gainCost: 1e30 }), milestones: [1e20] }));
    expect(result.blockedAt).toEqual({ code: "u-gain", level: 1 });
    expect(result.purchases).toEqual([]);
    expect(result.milestoneTimes).toEqual({ [String(1e20)]: null });
  });

  it("starts every order from a fresh state (no leakage between runs)", () => {
    const a = simulateOrder(input({ job: job("i", MULT_THEN_GAIN), milestones: [5] }));
    const b = simulateOrder(input({ job: job("i", MULT_THEN_GAIN), milestones: [5] }));
    expect(b).toEqual(a);
  });

  it("delivers whole gains equal to the earned delta (no drip)", () => {
    let last: GameState | undefined;
    const result = simulateOrder(
      input({
        job: job("g", MULT_THEN_GAIN),
        makeSim: () => {
          const sim = makeSim();
          last = sim.state;
          return sim;
        },
      }),
    );
    expect(result.runs.length).toBeGreaterThan(0);
    for (const run of result.runs) {
      expect(Number.isInteger(run.gain)).toBe(true);
      expect(run.gain).toBeGreaterThan(0);
    }
    const total = result.runs.reduce((sum, run) => sum + run.gain, 0);
    expect(N(last!.currencies.find((c) => c.code === "prestige")!.earned!).toNumber()).toBe(total);
  });

  it("records milestone times at the first earned >= value", () => {
    const result = simulateOrder(input({ job: job("m", MULT_THEN_GAIN), milestones: [3, 1_000_000_000] }));
    expect(result.milestoneTimes["3"]).not.toBeNull();
    expect(result.milestoneTimes["3"]!).toBeLessThanOrEqual(result.runs[0]!.endMs);
    expect(result.milestoneTimes["1000000000"]).toBeNull();
  });

  it("runs the registered moves listed in movePriority when ready", () => {
    let calls = 0;
    const bonus: GameMove = {
      code: "bonus",
      ready: (state) => N(state.currencies.find((c) => c.code === "primary")!.amount).lt(1_000_000),
      apply: (state) => {
        calls++;
        const c = state.currencies.find((x) => x.code === "primary")!;
        c.amount = NR(N(c.amount).add(1000));
        return true;
      },
    };
    const result = simulateOrder(input({ job: job("mv", MULT_THEN_GAIN), moves: () => [bonus], policy: { ...POLICY, movePriority: ["bonus"] }, horizonMs: 10 * 60_000 }));
    expect(calls).toBeGreaterThan(0);
    expect(result.runs.length).toBeGreaterThan(0);
  });

  it("stops before the horizon when the order is complete and milestones are reached", () => {
    const result = simulateOrder(input({ job: job("s", MULT_THEN_GAIN), milestones: [3] }));
    expect(result.blockedAt).toBeUndefined();
    expect(result.endedAtMs).toBeLessThan(result.horizonMs);
    expect(result.endedAtMs).toBeGreaterThanOrEqual(result.purchases[1]!.tSimMs);
  });

  it("runs to the horizon when a milestone is never reached", () => {
    const result = simulateOrder(input({ job: job("h", MULT_THEN_GAIN), milestones: [1e9] }));
    expect(result.endedAtMs).toBe(result.horizonMs);
  });

  it("target rule: prestiges only with a gain >= minGain", () => {
    const result = simulateOrder(input({ job: job("t", MULT_THEN_GAIN), policy: { ...POLICY, prestigeRule: { kind: "target", minGain: 6 } } }));
    expect(result.runs.length).toBeGreaterThan(0);
    for (const run of result.runs) expect(run.gain).toBeGreaterThanOrEqual(6);
    const never = simulateOrder(input({ job: job("n", MULT_THEN_GAIN), policy: { ...POLICY, prestigeRule: { kind: "target", minGain: 1e12 } } }));
    expect(never.runs).toEqual([]);
  });

  it("reads a missing earned as zero: a currency starts without it until the engine credits it", () => {
    const withEarned = simulateOrder(input({ job: job("e", MULT_THEN_GAIN) }));
    const without = simulateOrder(
      input({
        job: job("e", MULT_THEN_GAIN),
        makeSim: () => {
          const sim = makeSim();
          delete sim.state.currencies.find((c) => c.code === "prestige")!.earned;
          return sim;
        },
      }),
    );
    expect(without.runs.length).toBeGreaterThan(0);
    expect(without.runs).toEqual(withEarned.runs);
  });

  it("does not count the initial earned in the first run's gain", () => {
    const base = simulateOrder(input({ job: job("a", MULT_THEN_GAIN) }));
    const withStock = simulateOrder(input({ job: job("a", MULT_THEN_GAIN), makeSim: () => makeSim({ earned: 100 }) }));
    expect(withStock.runs[0]!.gain).toBe(base.runs[0]!.gain);
  });

  it("rejects a visit interval that is not a multiple of the sample interval", () => {
    expect(() => simulateOrder(input({ job: job("v", MULT_THEN_GAIN), policy: { ...POLICY, visitMs: 90_000 } }))).toThrow(/multiple/);
  });

  it("records the run marks from the start of each run, and the run still open", () => {
    const runMarks = (state: GameState): string[] => {
      const marks: string[] = [];
      if (N(state.producers[0]!.bought).gt(0)) marks.push("p1");
      if (N(state.currencies[0]!.amount).gte(50)) marks.push("rich");
      return marks;
    };
    const result = simulateOrder(input({ job: job("m", MULT_THEN_GAIN), runMarks }));
    expect(result.runs.length).toBeGreaterThan(1);
    for (const run of result.runs) {
      const marks = run.marks!;
      expect(Object.keys(marks)).toEqual(["p1", "rich"]);
      expect(marks.p1).toBeGreaterThanOrEqual(0);
      expect(marks.p1).toBeLessThanOrEqual(marks.rich!);
      expect(marks.rich).toBeLessThanOrEqual(run.endMs - run.startMs);
    }
    expect(result.openRun?.startMs).toBe(result.runs[result.runs.length - 1]!.endMs);
  });

  it("records no marks and no open run without runMarks", () => {
    const result = simulateOrder(input({ job: job("n", MULT_THEN_GAIN) }));
    expect(result.runs.every((run) => run.marks === undefined)).toBe(true);
    expect(result.openRun).toBeUndefined();
  });
});

describe("createRunPolicy", () => {
  it("has a stable id and stays idle with nothing to do", () => {
    const { state, engine } = makeSim();
    const policy = createRunPolicy(POLICY, [], []);
    expect(policy.id).toBe("calibration-run");
    expect(policy.decide({ state, engine, tSimMs: 0 })).toEqual([]);
  });

  it("buys the order items while they are affordable and stops at the first blocked one", () => {
    const { state, engine } = makeSim();
    state.currencies.find((c) => c.code === "prestige")!.amount = NR(2);
    const policy = createRunPolicy(POLICY, GAIN_THEN_MULT, []);
    expect(policy.decide({ state, engine, tSimMs: 0 })).toEqual([{ kind: "buyUpgrade", code: "u-gain" }]);
  });
});

describe("createRunPolicy visits", () => {
  it("buys two levels of the same upgrade in one visit when the budget allows", () => {
    const order: ShopOrder = [
      { code: "u-mult", level: 1 },
      { code: "u-mult", level: 2 },
    ];
    for (const [amount, expected] of [
      [4, 2],
      [3, 1],
    ] as const) {
      const { state, engine } = makeSim();
      state.currencies.find((c) => c.code === "prestige")!.amount = NR(amount);
      const intents = createRunPolicy(POLICY, order, []).decide({ state, engine, tSimMs: 0 });
      expect(intents.filter((i) => i.kind === "buyUpgrade")).toHaveLength(expected);
    }
  });

  it("throws on an order code that does not exist in the state", () => {
    const { state, engine } = makeSim();
    const policy = createRunPolicy(POLICY, [{ code: "ghost", level: 1 }], []);
    expect(() => policy.decide({ state, engine, tSimMs: 0 })).toThrow(/ghost/);
  });

  const NO_PRESTIGE: RunPolicyOptions = { ...POLICY, prestigeRule: { kind: "target", minGain: 1e12 }, movePriority: ["reset"] };
  const reset: GameMove = {
    code: "reset",
    ready: (state) => N(state.producers[0]!.bought).gt(0),
    apply: (state) => {
      state.producers[0]!.amount = NR(0);
      state.producers[0]!.bought = NR(0);
      state.currencies.find((c) => c.code === "primary")!.amount = NR(1000);
      return true;
    },
  };

  it("queues no producer purchase while a move is ready", () => {
    const { state, engine } = makeSim();
    state.producers[0]!.bought = NR(1);
    state.currencies.find((c) => c.code === "primary")!.amount = NR(1000);
    const intents = createRunPolicy(NO_PRESTIGE, [], [reset]).decide({ state, engine, tSimMs: 0 });
    expect(intents).toEqual([{ kind: "move", code: "reset" }]);
  });

  it("after a move, producers are bought in the same visit and nothing is dropped", () => {
    const { state, engine } = makeSim();
    state.producers[0]!.bought = NR(1);
    state.currencies.find((c) => c.code === "primary")!.amount = NR(1000);
    const policy = createRunPolicy(NO_PRESTIGE, [], [reset]);
    const report = runBalanceSim({
      state,
      engine,
      bot: policy,
      collector: new MetricsCollector(engine),
      moves: [reset],
      redecideAfterMoves: true,
      params: { durationMs: 60_000, tickLengthMs: TICK_MS, decisionIntervalMs: 60_000, sampleIntervalMs: 60_000 },
    });
    expect(report.meta.droppedIntents).toBe(0);
    expect(N(state.producers[0]!.bought).toNumber()).toBeGreaterThan(0);
  });
});

describe("simulateOrder with a presence", () => {
  const MIN = 60_000;
  const phases = [
    { forMs: 3 * MIN, everyMs: MIN },
    { forMs: 7 * MIN, everyMs: 5 * MIN },
  ];
  /** Two 10-minute sessions per hour (at 0 and at 30 minutes). */
  const PRESENCE: PresenceProfile = {
    periodMs: 60 * MIN,
    sessions: [
      { startMs: 0, durationMs: 10 * MIN, visits: phases },
      { startMs: 30 * MIN, durationMs: 10 * MIN, visits: phases },
    ],
  };
  const withPresence = (over: Partial<RunPolicyOptions> = {}): RunPolicyOptions => ({ ...POLICY, presence: PRESENCE, ...over });

  /** Plays the policy the way simulateOrder wires it and returns the recorded actions. */
  function play(policy: RunPolicyOptions, order: ShopOrder, over: { primary?: number; horizonMs?: number } = {}) {
    const { state, engine } = makeSim();
    state.currencies.find((c) => c.code === "primary")!.amount = NR(over.primary ?? 100);
    state.currencies.find((c) => c.code === "prestige")!.amount = NR(1000);
    const amounts: Record<number, number> = {};
    const bot = createRunPolicy(policy, order, []);
    const spy = {
      id: bot.id,
      decide: (ctx: Parameters<typeof bot.decide>[0]) => {
        amounts[ctx.tSimMs] = N(state.currencies.find((c) => c.code === "primary")!.amount).toNumber();
        return bot.decide(ctx);
      },
    };
    const report = runBalanceSim({
      state,
      engine,
      bot: spy,
      collector: new MetricsCollector(engine),
      clickable: CLICK,
      canTap: (t) => canTapAt(PRESENCE, t),
      redecideAfterMoves: true,
      params: { durationMs: over.horizonMs ?? 3 * 60 * MIN, tickLengthMs: TICK_MS, decisionIntervalMs: MIN, sampleIntervalMs: MIN },
    });
    return { report, amounts, state };
  }

  it("advances closed minutes at a coarse tick with the same result for linear production", () => {
    const run = (closedTickMs: number) =>
      simulateOrder(input({ job: job("c", MULT_THEN_GAIN), policy: withPresence({ prestigeRule: { kind: "target", minGain: 3 } }), horizonMs: 3 * 60 * MIN, closedTickMs }));
    const exact = run(TICK_MS);
    const coarse = run(MIN);
    expect(coarse.runs.map((r) => [r.endMs, r.gain])).toEqual(exact.runs.map((r) => [r.endMs, r.gain]));
    expect(coarse.purchases).toEqual(exact.purchases);
  });

  it("validates the profile and ignores visitMs", () => {
    const bad: PresenceProfile = { periodMs: 60 * MIN, sessions: [{ startMs: 0, durationMs: 10 * MIN, visits: [] }] };
    expect(() => simulateOrder(input({ job: job("v", MULT_THEN_GAIN), policy: withPresence({ presence: bad }) }))).toThrow(/visits/);
    const odd = simulateOrder(input({ job: job("v", MULT_THEN_GAIN), policy: withPresence({ visitMs: 90_000 }), horizonMs: 2 * 60 * MIN }));
    const normal = simulateOrder(input({ job: job("v", MULT_THEN_GAIN), policy: withPresence(), horizonMs: 2 * 60 * MIN }));
    expect(odd).toEqual(normal);
  });

  it("every action falls in an open minute; shop purchases and prestiges only on visits", () => {
    const policy = withPresence({ prestigeRule: { kind: "target", minGain: 3 } });
    const { report } = play(policy, MULT_THEN_GAIN);
    expect(report.actions.length).toBeGreaterThan(0);
    for (const action of report.actions) {
      expect(isOpen(PRESENCE, action.tSimMs)).toBe(true);
      if (action.kind === "buyUpgrade" || action.kind === "prestige") expect(isVisit(PRESENCE, action.tSimMs)).toBe(true);
    }
    expect(report.actions.some((a) => a.kind === "prestige")).toBe(true);
    expect(report.actions.some((a) => a.kind === "buyUpgrade")).toBe(true);
  });

  it("without automation nothing is bought between two visits", () => {
    const { report } = play(withPresence({ prestigeRule: { kind: "target", minGain: 1e12 } }), []);
    const producerBuys = report.actions.filter((a) => a.kind === "buyProducer");
    expect(producerBuys.length).toBeGreaterThan(0);
    for (const action of producerBuys) expect(isVisit(PRESENCE, action.tSimMs)).toBe(true);
  });

  it("with producer automation, producers are also bought on open minutes without a visit", () => {
    const policy = withPresence({ prestigeRule: { kind: "target", minGain: 1e12 }, automation: { producers: () => new Set(["p1"]) } });
    const { report } = play(policy, []);
    const between = report.actions.filter((a) => a.kind === "buyProducer" && !isVisit(PRESENCE, a.tSimMs));
    expect(between.length).toBeGreaterThan(0);
    for (const action of report.actions) expect(isOpen(PRESENCE, action.tSimMs)).toBe(true);
  });

  it("automation of other producers buys nothing between visits", () => {
    const policy = withPresence({ prestigeRule: { kind: "target", minGain: 1e12 }, automation: { producers: () => new Set(["other"]) } });
    const { report } = play(policy, []);
    for (const action of report.actions) expect(isVisit(PRESENCE, action.tSimMs)).toBe(true);
  });

  it("the page closed: production goes on, no action between two sessions", () => {
    const policy = withPresence({ prestigeRule: { kind: "target", minGain: 1e12 }, automation: { producers: () => new Set(["p1"]) } });
    const { report, amounts } = play(policy, [], { horizonMs: 60 * MIN });
    const inGap = report.actions.filter((a) => a.tSimMs > 10 * MIN && a.tSimMs < 30 * MIN);
    expect(inGap).toEqual([]);
    expect(amounts[29 * MIN]!).toBeGreaterThan(amounts[11 * MIN]!);
  });

  it("taps on a visit and in the minute after it, never otherwise", () => {
    const single: PresenceProfile = {
      periodMs: 60 * MIN,
      sessions: [
        {
          startMs: 0,
          durationMs: 5 * MIN,
          visits: [
            { forMs: MIN, everyMs: MIN },
            { forMs: 4 * MIN, everyMs: 4 * MIN },
          ],
        },
      ],
    };
    // Visits at 0 and 1 min; the producer is out of reach, so the only change to `primary` is taps.
    let state: GameState | undefined;
    simulateOrder(
      input({
        job: job("t", []),
        policy: { ...POLICY, presence: single, prestigeRule: { kind: "target", minGain: 1e12 } },
        horizonMs: 6 * MIN,
        milestones: [1e9],
        makeSim: () => {
          const sim = makeSim();
          sim.state.producers[0]!.scaling = growth(1e9, 0);
          state = sim.state;
          return sim;
        },
      }),
    );
    // Tappable chunks end at t = 1 min (visit) and t = 2 min (the minute after it): 61 + 60 taps.
    expect(N(state!.currencies.find((c) => c.code === "primary")!.amount).toNumber()).toBe(121);
  });
});

describe("createRunPolicy with a presence", () => {
  const MIN = 60_000;
  const PRESENCE: PresenceProfile = {
    periodMs: 60 * MIN,
    sessions: [
      {
        startMs: 0,
        durationMs: 10 * MIN,
        visits: [
          { forMs: 3 * MIN, everyMs: 2 * MIN },
          { forMs: 6 * MIN, everyMs: 5 * MIN },
        ],
      },
    ],
  };
  const reset: GameMove = { code: "reset", ready: () => true, apply: () => true };
  const other: GameMove = { code: "other", ready: () => true, apply: () => true };
  const base: RunPolicyOptions = { ...POLICY, presence: PRESENCE, prestigeRule: { kind: "target", minGain: 1e12 }, movePriority: ["reset", "other"] };
  const rich = () => {
    const sim = makeSim();
    sim.state.currencies.find((c) => c.code === "primary")!.amount = NR(1000);
    return sim;
  };

  it("closed: nothing at all", () => {
    const { state, engine } = rich();
    const policy = createRunPolicy({ ...base, automation: { moves: () => new Set(["reset"]), producers: () => new Set(["p1"]) } }, [], [reset]);
    expect(policy.decide({ state, engine, tSimMs: 20 * MIN })).toEqual([]);
  });

  it("open without a visit: only the automated ready moves, and they end the decision", () => {
    const { state, engine } = rich();
    const policy = createRunPolicy({ ...base, automation: { moves: () => new Set(["reset"]), producers: () => new Set(["p1"]) } }, [], [reset, other]);
    expect(policy.decide({ state, engine, tSimMs: MIN })).toEqual([{ kind: "move", code: "reset" }]);
  });

  it("open without a visit: automated producers when no automated move is ready", () => {
    const { state, engine } = rich();
    const policy = createRunPolicy({ ...base, automation: { moves: () => new Set(), producers: () => new Set(["p1"]) } }, [], [reset]);
    const intents = policy.decide({ state, engine, tSimMs: MIN });
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: "buyProducer", code: "p1" });
  });

  it("open without a visit and no automation: nothing; on a visit: the moves as usual", () => {
    const { state, engine } = rich();
    const policy = createRunPolicy(base, [], [reset, other]);
    expect(policy.decide({ state, engine, tSimMs: MIN })).toEqual([]);
    expect(policy.decide({ state, engine, tSimMs: 2 * MIN })).toEqual([
      { kind: "move", code: "reset" },
      { kind: "move", code: "other" },
    ]);
  });
});

describe("prestige rules that wait for a better rate", () => {
  const HOUR = 3_600_000;
  /** A fresh game whose prestige pays `gain` now (0.05 per primary). */
  const at = (gain: number) => {
    const sim = makeSim();
    sim.state.currencies.find((c) => c.code === "primary")!.amount = NR(gain * 20);
    return sim;
  };
  const fires = (intents: { kind: string }[]) => intents.some((i) => i.kind === "prestige");

  it("bestRate waits when the look-ahead shows a better gain per hour, and fires when it is reached", () => {
    const lookahead: RunLookahead = (state, t0, _durationMs, onVisit) => {
      const copy = structuredClone(state);
      copy.currencies.find((c) => c.code === "primary")!.amount = NR(40);
      onVisit(copy, at(2).engine, t0 + HOUR / 2);
    };
    const bot = createRunPolicy({ ...POLICY, prestigeRule: { kind: "bestRate" } }, [], [], lookahead);
    const now = at(1);
    // 1 after 3 h (1/3 per hour) against 2 after 3.5 h (0.57 per hour): wait.
    expect(fires(bot.decide({ ...now, tSimMs: 3 * HOUR }))).toBe(false);
    const later = at(2);
    expect(fires(bot.decide({ ...later, tSimMs: 3.5 * HOUR }))).toBe(true);
  });

  it("bestRate fires at once when the next step comes too late", () => {
    const lookahead: RunLookahead = (state, t0, _durationMs, onVisit) => {
      const copy = structuredClone(state);
      copy.currencies.find((c) => c.code === "primary")!.amount = NR(40);
      onVisit(copy, at(2).engine, t0 + 4 * HOUR);
    };
    const bot = createRunPolicy({ ...POLICY, prestigeRule: { kind: "bestRate" } }, [], [], lookahead);
    // 1 after 3 h (0.33 per hour) against 2 after 7 h (0.29 per hour): fire now.
    expect(fires(bot.decide({ ...at(1), tSimMs: 3 * HOUR }))).toBe(true);
  });

  it("bestRate needs a look-ahead", () => {
    expect(() => createRunPolicy({ ...POLICY, prestigeRule: { kind: "bestRate" } }, [], [])).toThrow(/lookahead/);
  });

  it("estimateRate waits while the next unit, at the speed it sees, raises the gain per hour", () => {
    const bot = createRunPolicy({ ...POLICY, prestigeRule: { kind: "estimateRate" } }, [], []);
    // First look at 1.0 after 3 h: no speed yet, look again.
    expect(fires(bot.decide({ ...at(1), tSimMs: 3 * HOUR }))).toBe(false);
    // 1.5 at 3.5 h: +1 per hour, 2 at 4 h is worth 0.5 per hour against 0.29 now: wait.
    expect(fires(bot.decide({ ...at(1.5), tSimMs: 3.5 * HOUR }))).toBe(false);
    // 1.55 at 4 h: +0.1 per hour, 2 only at 8.5 h (0.24 per hour) against 0.25 now: fire.
    expect(fires(bot.decide({ ...at(1.55), tSimMs: 4 * HOUR }))).toBe(true);
  });

  it("estimateRate fires when the pending gain stands still", () => {
    const bot = createRunPolicy({ ...POLICY, prestigeRule: { kind: "estimateRate" } }, [], []);
    expect(fires(bot.decide({ ...at(1.2), tSimMs: 2 * HOUR }))).toBe(false);
    expect(fires(bot.decide({ ...at(1.2), tSimMs: 2.5 * HOUR }))).toBe(true);
  });

  it("estimateRate skips a move that would wipe the pending gain while it waits", () => {
    const wipe: GameMove = {
      code: "wipe",
      ready: () => true,
      apply: (state) => {
        state.currencies.find((c) => c.code === "primary")!.amount = NR(0);
        return true;
      },
    };
    const waiting = createRunPolicy({ ...POLICY, prestigeRule: { kind: "estimateRate" }, movePriority: ["wipe"] }, [], [wipe]);
    expect(waiting.decide({ ...at(1), tSimMs: HOUR }).some((i) => i.kind === "move")).toBe(false);
    const plain = createRunPolicy({ ...POLICY, prestigeRule: { kind: "target", minGain: 1e9 }, movePriority: ["wipe"] }, [], [wipe]);
    expect(plain.decide({ ...at(1), tSimMs: HOUR }).some((i) => i.kind === "move")).toBe(true);
  });

  it("simulateOrder plays bestRate and estimateRate to the end", () => {
    for (const prestigeRule of [{ kind: "bestRate" as const }, { kind: "estimateRate" as const }]) {
      const result = simulateOrder(input({ job: job("w", MULT_THEN_GAIN), policy: { ...POLICY, prestigeRule } }));
      // The simulation ends at the horizon, or earlier once the order is bought and no milestone is left.
      expect(result.endedAtMs).toBeLessThanOrEqual(result.horizonMs);
      for (const run of result.runs) expect(run.gain).toBeGreaterThanOrEqual(1);
    }
  });
});
