import { describe, expect, it } from "vitest";

import type { Currency, Producer, Upgrade } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { type GenericNumberInput, N, NR } from "../nums";
import { type GameState, createInitialState } from "../state";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import { Engine } from "./engine";
import { coolingDelta, dragFactor } from "./saturation";

describe("dragFactor", () => {
  const drag = { onset: 1e6, scale: 44, exponent: 4, floor: 0.05 };
  const f = (stock: number | string) => dragFactor(N(stock), drag).toNumber();

  it("is inert at or below the onset", () => {
    expect(f(1e5)).toBe(1);
    expect(f(1e6)).toBe(1);
  });

  it("matches the calibrated golden points", () => {
    expect(f(1e10)).toBeCloseTo(0.9999317009869473, 12);
    expect(f(1e20)).toBeCloseTo(0.9898028761648003, 12);
    expect(f(1e40)).toBeCloseTo(0.7000963626149211, 9);
  });

  it("clamps at the floor and never goes below it", () => {
    expect(f(1e64)).toBeCloseTo(0.05, 6);
    expect(f(1e80)).toBe(0.05);
  });

  it("decreases monotonically above the onset", () => {
    const samples = [1e6, 1e10, 1e20, 1e30, 1e40, 1e50, 1e60, 1e70];
    const values = samples.map(f);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    }
  });
});

describe("coolingDelta", () => {
  const halfLifeMs = 5_400_000;

  it("matches the calibrated golden points", () => {
    expect(coolingDelta(N(1e10), 1000, halfLifeMs).toNumber()).toBeCloseTo(-1283605.8899258247, 3);
    expect(coolingDelta(N(1e10), 60_000, halfLifeMs).toNumber()).toBeCloseTo(-77016353.39554948, 3);
  });

  it("is zero without stock", () => {
    expect(coolingDelta(N(0), 1000, halfLifeMs).toNumber()).toBe(0);
    expect(coolingDelta(N(-5), 1000, halfLifeMs).toNumber()).toBe(0);
  });
});

/**
 * Golden-parity fixture: producers e1..e8 feeding into each other (e8 -> e7
 * -> ... -> e1 -> "one") plus t0 -> "time", with e1..e7 capacities and an
 * overflow currency ("dd") slowed by drag and cooled over real time. Values
 * reproduce the numbers a saturation-aware engine produced before this data
 * model existed, now expressed entirely through `rules.saturation` and
 * `Producer.capacity` — nothing here is keyed on a code for its meaning.
 */
const K0: Record<number, number> = { 1: 1e6, 2: 1e5, 3: 3e4, 4: 1e4, 5: 3e3, 6: 1e3, 7: 300 };
const CAPACITY_FACTOR: Record<number, number> = { 1: 1.04, 2: 1.05, 3: 1.06, 4: 1.06, 5: 1.07, 6: 1.07, 7: 1.08 };
const DECAY_SCALE: Record<number, number> = { 1: 18, 2: 14, 3: 12, 4: 10, 5: 8, 6: 7, 7: 6 };

const PRODUCER_DEFS: { code: string; producesTo: string; amount: GenericNumberInput; bought: number }[] = [
  { code: "e1", producesTo: "one", amount: "1e30", bought: 500 },
  { code: "e2", producesTo: "e1", amount: "1e6", bought: 100 },
  { code: "e3", producesTo: "e2", amount: "1e20", bought: 50 },
  { code: "e4", producesTo: "e3", amount: 10, bought: 10 },
  { code: "e5", producesTo: "e4", amount: "1e12", bought: 30 },
  { code: "e6", producesTo: "e5", amount: "1e9", bought: 20 },
  { code: "e7", producesTo: "e6", amount: "1e40", bought: 5 },
  { code: "e8", producesTo: "e7", amount: "1e50", bought: 1 },
  { code: "t0", producesTo: "time", amount: 1, bought: 0 },
];

function buildProducers(): Producer[] {
  return PRODUCER_DEFS.map((def) => {
    const tier = def.code.startsWith("e") ? Number(def.code.slice(1)) : undefined;
    const capacity =
      tier !== undefined && tier <= 7
        ? { base: NR(K0[tier]!), factor: NR(CAPACITY_FACTOR[tier]!), decayScale: DECAY_SCALE[tier]!, overflowRate: tier === 1 ? 0.05 : 0 }
        : undefined;
    return {
      code: def.code,
      name: def.code,
      currencyCode: "one",
      amount: NR(def.amount),
      bought: NR(def.bought),
      produces: [{ code: def.producesTo, persec: NR(1) }],
      scaling: { base: NR(10), coeff: NR(1.2), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
      resetsOn: def.code === "t0" ? [] : ["reset"],
      capacity,
    };
  });
}

function buildCurrencies(params: { ifEarned: GenericNumberInput; dd: GenericNumberInput }): Currency[] {
  return [
    { code: "one", name: "one", amount: NR(0), primary: true },
    { code: "if", name: "if", amount: NR(params.ifEarned), earned: NR(params.ifEarned), gainMult: NR(1) },
    { code: "dd", name: "dd", amount: NR(params.dd), earned: NR(0), capacityMult: NR(1) },
    { code: "time", name: "time", amount: NR(0) },
  ];
}

function buildUpgrades(params: { wallMemory: number; cooling: number }): Upgrade[] {
  return [
    {
      code: "u-cap",
      name: "u-cap",
      currencyCode: "if",
      amount: NR(params.wallMemory),
      bought: NR(params.wallMemory),
      scaling: { base: NR(1), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
      effects: [
        {
          stage: 0,
          target: { kind: "currency", code: "dd", path: "capacityMult" },
          type: "mult",
          func: { base: NR(1), coeff: NR(3), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
        },
      ],
    },
    {
      code: "u-cool",
      name: "u-cool",
      currencyCode: "if",
      amount: NR(params.cooling),
      bought: NR(params.cooling),
      scaling: { base: NR(1), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
      effects: [
        {
          stage: 0,
          target: { kind: "currency", code: "dd", path: "coolingMult" },
          type: "mult",
          func: { base: NR(1), coeff: NR(2), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
        },
      ],
    },
  ];
}

function buildState(params: { ifEarned: GenericNumberInput; dd: GenericNumberInput; wallMemory: number; cooling: number }): GameState {
  return {
    ...createInitialState(),
    producers: buildProducers(),
    currencies: buildCurrencies(params),
    upgrades: buildUpgrades(params),
    rules: {
      saturation: {
        decayExponent: 2,
        overflowCurrencyCode: "dd",
        gate: { currencyCode: "if", earnedAtLeast: 30 },
        push: { currencyCode: "if", exponent: 2 },
        drag: { onset: 1e6, scale: 44, exponent: 4, floor: 0.05 },
        cooling: { halfLifeMs: 5_400_000 },
      },
    },
  };
}

function persecDeltaOf(state: GameState, code: string): string {
  const entity = state.producers.find((p) => p.code === code) ?? state.currencies.find((c) => c.code === code);
  return N(entity?.persecDelta ?? 0).toString();
}

function persecEffectiveOf(state: GameState, code: string): string {
  const producer = state.producers.find((p) => p.code === code);
  return N(producer?.produces[0]?.persecEffective ?? 0).toString();
}

interface Scenario {
  name: string;
  params: { ifEarned: GenericNumberInput; dd: GenericNumberInput; wallMemory: number; cooling: number };
  persecDelta: Record<string, string>;
  ddAmountAfter: string;
  ddEarnedAfter: string;
  overflowPerSec: number;
}

const SCENARIOS: Scenario[] = [
  {
    name: "gate-closed",
    params: { ifEarned: 0, dd: 0, wallMemory: 0, cooling: 0 },
    persecDelta: {
      e1: "1000000",
      e2: "1e20",
      e3: "10",
      e4: "1000000000000",
      e5: "1000000000",
      e6: "1e40",
      e7: "1e50",
      e8: "0",
      t0: "0",
      one: "1e30",
      if: "0",
      dd: "0",
      time: "1",
    },
    ddAmountAfter: "0",
    ddEarnedAfter: "0",
    overflowPerSec: 0,
  },
  {
    name: "gate-open-30",
    params: { ifEarned: 30, dd: 0, wallMemory: 0, cooling: 0 },
    persecDelta: {
      e1: "1000000",
      e2: "4.136251108385227e19",
      e3: "10",
      e4: "712405131836.5929",
      e5: "886504924.8982706",
      e6: "5.579924131803935e25",
      e7: "1e50",
      e8: "0",
      t0: "0",
      one: "6.173618741322935e29",
      if: "0",
      dd: "0",
      time: "1",
    },
    ddAmountAfter: "1.9129450510624921e28",
    ddEarnedAfter: "1.9131906293385308e28",
    overflowPerSec: 1.9131906293385308e28,
  },
  {
    name: "gate-open-100-drag-1e40",
    params: { ifEarned: 100, dd: "1e40", wallMemory: 1, cooling: 1 },
    persecDelta: {
      e1: "700096.3626149212",
      e2: "3.6072050627075205e19",
      e3: "7.000963626149211",
      e4: "599218942485.609",
      e5: "687937016.0729747",
      e6: "6.472259440813173e26",
      e7: "7.000963626149199e49",
      e8: "0",
      t0: "0",
      one: "4.819914744337806e29",
      if: "0",
      dd: "0",
      time: "0.7000963626149211",
    },
    ddAmountAfter: "9.997432788231027e39",
    ddEarnedAfter: "1.0905244409056976e28",
    overflowPerSec: 1.0905244409056977e28,
  },
  {
    name: "gate-closed-drag-1e40",
    params: { ifEarned: 0, dd: "1e40", wallMemory: 0, cooling: 1 },
    persecDelta: {
      e1: "700096.3626149212",
      e2: "7.000963626149199e19",
      e3: "7.000963626149211",
      e4: "700096362614.9211",
      e5: "700096362.6149211",
      e6: "7.000963626149199e39",
      e7: "7.000963626149199e49",
      e8: "0",
      t0: "0",
      one: "7.000963626149199e29",
      if: "0",
      dd: "0",
      time: "0.7000963626149211",
    },
    ddAmountAfter: "9.99743278822023e39",
    ddEarnedAfter: "0",
    overflowPerSec: 0,
  },
];

// Relative tolerance for the golden comparisons: exact string equality would
// be brittle against the last floating digit of a long chain of pow/log/exp
// operations; every scenario below matches to at least 1e-9 relative, well
// inside this bound.
const RELATIVE_TOLERANCE = 1e-9;

function expectCloseToGolden(actual: string, expected: string): void {
  const a = N(actual);
  const e = N(expected);
  if (a.eq(e)) return;
  const diff = a.sub(e).abs();
  const scale = e.abs().gt(0) ? e.abs() : N(1);
  expect(diff.div(scale).toNumber()).toBeLessThan(RELATIVE_TOLERANCE);
}

describe("Engine.computeProducers — saturation golden parity", () => {
  for (const scenario of SCENARIOS) {
    it(`reproduces the golden numbers for scenario "${scenario.name}"`, () => {
      const state = buildState(scenario.params);
      const engine = new Engine(1000, { time: new MockTimeProvider(1000) });

      engine.computeProducers(state, 1000);

      for (const [code, expected] of Object.entries(scenario.persecDelta)) {
        expectCloseToGolden(persecDeltaOf(state, code), expected);
      }

      for (const producer of state.producers) {
        expectCloseToGolden(persecEffectiveOf(state, producer.code), "1");
      }

      const dd = state.currencies.find((c) => c.code === "dd")!;
      expectCloseToGolden(N(dd.amount).toString(), scenario.ddAmountAfter);
      expectCloseToGolden(N(dd.earned ?? 0).toString(), scenario.ddEarnedAfter);

      expect(Math.abs(state.stats.overflowPerSec - scenario.overflowPerSec)).toBeLessThan(Math.max(1, Math.abs(scenario.overflowPerSec)) * RELATIVE_TOLERANCE);
      expect(Math.abs((state.stats.overflowByProducer.e1 ?? 0) - scenario.overflowPerSec)).toBeLessThan(Math.max(1, Math.abs(scenario.overflowPerSec)) * RELATIVE_TOLERANCE);
    });
  }
});
