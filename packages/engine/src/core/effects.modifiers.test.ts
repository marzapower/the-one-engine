import { describe, expect, it } from "vitest";

import { ScaleOn, ScalingMethod } from "../models/base";
import { N, NR } from "../nums";
import { type GameState, createInitialState } from "../state";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import { Engine } from "./engine";
import { applyModifiers, collectModifiers, isTransientTargetPath } from "./modifiers";
import type { EffectTypeDef } from "./registries/effect";

/**
 * Regression coverage for the "effects compound every tick" bug and its
 * structural fix: the modifier pipeline.
 *
 * Effects that target a *persistent* state path (e.g. a producer's
 * `produces.*.persec`) are never written back to state — writing one back
 * would compound, the same `mult`/`add` effect re-applied on top of the
 * already-modified value, tick after tick. `collectModifiers` gathers them
 * into a per-tick map keyed by the resolved target object, and
 * `applyModifiers` folds them onto the genuinely immutable base value at the
 * single point of read (see `Engine.computeProducers`). There is no snapshot
 * to go stale.
 */

/**
 * State with a single upgrade `u1` whose effect targets a *persistent* path:
 * `produces.*.persec` on producer `e1`. Effect is `mult` with a linear
 * growth function (base=1, coeff=2, scaleOn=self), so the applied factor is
 * `1 + 2*bought`.
 */
const makeStateWithPersistentMultEffect = (upgradeBought = 1): GameState => ({
  ...createInitialState(),
  producers: [
    {
      code: "e1",
      name: "E1",
      currencyCode: "one",
      amount: NR(1),
      bought: NR(1),
      produces: [{ code: "one", persec: NR(1) }],
      scaling: { base: NR(10), coeff: NR(1.2), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
    },
  ],
  currencies: [{ code: "one", name: "One", amount: NR(0) }],
  upgrades: [
    {
      code: "u1",
      name: "U1",
      currencyCode: "one",
      amount: NR(1),
      bought: NR(upgradeBought),
      scaling: { base: NR(100), coeff: NR(1.5), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
      effects: [
        {
          stage: 0,
          target: { kind: "producer", code: "e1", path: "produces.*.persec" },
          type: "mult",
          func: { base: NR(1), coeff: NR(2), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
        },
      ],
    },
  ],
});

/**
 * State with a single upgrade `u2` whose effect targets `persecDelta`
 * directly (currency `one`), `add` type, linear growth function
 * (base=5, coeff=2, scaleOn=self) => applied delta = 5 + 2*1 = 7.
 */
const makeStateWithPersecDeltaEffect = (): GameState => ({
  ...createInitialState(),
  producers: [
    {
      code: "e1",
      name: "E1",
      currencyCode: "one",
      amount: NR(1),
      bought: NR(1),
      produces: [{ code: "one", persec: NR(1) }],
      scaling: { base: NR(10), coeff: NR(1.2), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
    },
  ],
  currencies: [{ code: "one", name: "One", amount: NR(0) }],
  upgrades: [
    {
      code: "u2",
      name: "U2",
      currencyCode: "one",
      amount: NR(1),
      bought: NR(1),
      scaling: { base: NR(100), coeff: NR(1.5), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
      effects: [
        {
          stage: 1,
          target: { kind: "currency", code: "one", path: "persecDelta" },
          type: "add",
          func: { base: NR(5), coeff: NR(2), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
        },
      ],
    },
  ],
});

/**
 * State with an upgrade AND a prestige, both `mult`-ing the same persistent
 * target (`e1.produces.*.persec`) at the same stage/priority — used to
 * assert the "prestige effects come after upgrade effects" tiebreak.
 */
const makeStateWithUpgradeAndPrestigeMultOnSameTarget = (opts: { earned?: number; amount?: number } = {}): GameState => ({
  ...createInitialState(),
  producers: [
    {
      code: "e1",
      name: "E1",
      currencyCode: "one",
      amount: NR(1),
      bought: NR(1),
      produces: [{ code: "one", persec: NR(2) }],
      scaling: { base: NR(10), coeff: NR(1.2), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
    },
  ],
  currencies: [
    { code: "one", name: "One", amount: NR(0) },
    { code: "if", name: "Prestige currency", amount: NR(opts.amount ?? 0), earned: opts.earned !== undefined ? NR(opts.earned) : undefined },
  ],
  prestiges: [
    {
      code: "reset",
      currencyCode: "if",
      source: { kind: "currency", code: "one", path: "amount" },
      target: { kind: "currency", code: "if", path: "amount" },
      func: { base: NR(1), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
      effects: [
        {
          stage: 0,
          target: { kind: "producer", code: "e1", path: "produces.*.persec" },
          type: "mult",
          func: { base: NR(1), coeff: NR(0.1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
        },
      ],
    },
  ],
  upgrades: [
    {
      code: "u1",
      name: "U1",
      currencyCode: "one",
      amount: NR(1),
      bought: NR(1),
      scaling: { base: NR(100), coeff: NR(1.5), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
      effects: [
        {
          stage: 0,
          target: { kind: "producer", code: "e1", path: "produces.*.persec" },
          type: "mult",
          func: { base: NR(1), coeff: NR(0.5), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
        },
      ],
    },
  ],
});

const getPersecBase = (state: GameState): number => N(state.producers[0]?.produces[0]?.persec ?? NaN).toNumber();
const getPersecEffective = (state: GameState): number => N(state.producers[0]?.produces[0]?.persecEffective ?? NaN).toNumber();
const getCurrencyAmount = (state: GameState): number => N(state.currencies[0]?.amount ?? NaN).toNumber();
const getPersecDelta = (state: GameState): number => N(state.currencies[0]?.persecDelta ?? NaN).toNumber();

describe("isTransientTargetPath", () => {
  it("classifies persecDelta-terminated paths as transient", () => {
    expect(isTransientTargetPath("persecDelta")).toBe(true);
    expect(isTransientTargetPath("currency.one.persecDelta")).toBe(true);
  });

  it("classifies every other path as persistent", () => {
    expect(isTransientTargetPath("produces.*.persec")).toBe(false);
    expect(isTransientTargetPath("amount")).toBe(false);
    expect(isTransientTargetPath("bought")).toBe(false);
  });
});

describe("applyModifiers (pure fold)", () => {
  it("folds an empty modifier list to the base value unchanged", () => {
    const engine = new Engine();
    expect(applyModifiers(NR(5), [], engine.services).toNumber()).toBe(5);
  });

  it("applies modifiers in list order via each effect type's registered apply", () => {
    const engine = new Engine();
    const addEffect = {
      stage: 0,
      target: { kind: "currency", code: "one", path: "amount" },
      type: "add",
      func: { base: NR(3), coeff: NR(0), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
    } as const;
    const multEffect = {
      stage: 0,
      target: { kind: "currency", code: "one", path: "amount" },
      type: "mult",
      func: { base: NR(2), coeff: NR(0), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
    } as const;

    // (5 + 3) * 2 = 16
    const result = applyModifiers(
      NR(5),
      [
        { effect: addEffect, amount: NR(1) },
        { effect: multEffect, amount: NR(1) },
      ],
      engine.services,
    );
    expect(result.toNumber()).toBe(16);
  });
});

describe("Modifier pipeline: persistent-path effects (produces.*.persec)", () => {
  it("computes the correct effective rate and never mutates the base persec value", () => {
    const state = makeStateWithPersistentMultEffect(1);
    const time = new MockTimeProvider(16);
    const engine = new Engine(16, { time });

    engine.advance(state, 16 * 10);
    expect(getPersecEffective(state)).toBe(3); // 1 + 2*1
    expect(getPersecBase(state)).toBe(1); // base untouched by the effect system

    engine.advance(state, 16 * 90); // 100 ticks total
    expect(getPersecEffective(state)).toBe(3);
    expect(getPersecBase(state)).toBe(1);
  });

  it("grows the currency at the effect-boosted rate (x3/sec per unit of e1), not exponentially", () => {
    const state = makeStateWithPersistentMultEffect(1);
    const time = new MockTimeProvider(16);
    const engine = new Engine(16, { time });

    engine.advance(state, 16 * 10); // 10 ticks = 160ms
    expect(getCurrencyAmount(state)).toBeCloseTo(3 * (160 / 1000), 9);

    engine.advance(state, 16 * 90); // 90 more ticks => 100 total = 1600ms
    expect(getCurrencyAmount(state)).toBeCloseTo(3 * (1600 / 1000), 9);
  });
});

describe("Modifier pipeline: reference-churn regression (the compounding bug repro)", () => {
  it("never compounds across bought-count increases + array/object reference churn", () => {
    const state = makeStateWithPersistentMultEffect(1);
    const time = new MockTimeProvider(16);
    const engine = new Engine(16, { time });

    for (let i = 0; i < 5; i++) {
      engine.advance(state, 16 * 5);

      // Simulate an immutable-update reducer: bought+1 AND fresh array/object
      // references for both upgrades and producers.
      state.upgrades = state.upgrades.map((u) => (u.code === "u1" ? { ...u, bought: NR(N(u.bought).add(1)) } : { ...u }));
      state.producers = state.producers.map((p) => ({ ...p, produces: p.produces.map((pt) => ({ ...pt })) }));
    }

    expect(N(state.upgrades[0]?.bought ?? NaN).toNumber()).toBe(6);

    engine.advance(state, 16);
    // 1 + 2*6 = 13 — never 3^6 (compounded) or any other drifted value.
    expect(getPersecEffective(state)).toBe(13);
    expect(getPersecBase(state)).toBe(1);
  });
});

describe("Transient-path effects (persecDelta) — unchanged from before", () => {
  it("keeps persecDelta-target effects behaving as before (reset every tick, no compounding)", () => {
    const state = makeStateWithPersecDeltaEffect();
    const time = new MockTimeProvider(16);
    const engine = new Engine(16, { time });

    engine.advance(state, 16); // 1 tick
    // production persec(1) * amount(1) + u2 add effect(7) = 8, every tick, always.
    expect(getPersecDelta(state)).toBe(8);

    engine.advance(state, 16 * 49); // 49 more ticks => 50 total
    expect(getPersecDelta(state)).toBe(8);

    // Linear growth over time (not exponential): amount = ticks * 8 * (16/1000)
    expect(getCurrencyAmount(state)).toBeCloseTo(50 * 8 * (16 / 1000), 9);
  });
});

describe("Modifier pipeline: custom effect types compose via the fold (addon-defined types, e.g. 'pow')", () => {
  const powEffectDef: EffectTypeDef = {
    id: "pow",
    version: "1.0.0",
    priority: 300,
    apply: (prev, computed) => NR(prev.pow(computed)),
    allowedStages: [0, 1, 2],
  };

  it("folds a custom 'pow' effect on a persistent path exactly like an addon-defined extension would", () => {
    const state = makeStateWithPersistentMultEffect(1);
    // Re-target: base persec 3, custom "pow" effect with a constant exponent of 2 (base=2, coeff=0).
    state.producers[0]!.produces[0]!.persec = NR(3);
    state.upgrades[0]!.effects = [
      {
        stage: 0,
        target: { kind: "producer", code: "e1", path: "produces.*.persec" },
        type: "pow",
        func: { base: NR(2), coeff: NR(0), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
      },
    ] as unknown as GameState["upgrades"][number]["effects"];

    const time = new MockTimeProvider(16);
    const engine = new Engine(16, { time });
    engine.effectTypes.register(powEffectDef);

    engine.advance(state, 16);

    expect(getPersecEffective(state)).toBe(9); // 3^2
    expect(getPersecBase(state)).toBe(3); // untouched
  });
});

describe("Prestige effects on persistent paths", () => {
  it("drives the effect from earned (lifetime) over amount when present", () => {
    const state = makeStateWithUpgradeAndPrestigeMultOnSameTarget({ earned: 5, amount: 0 });
    const time = new MockTimeProvider(16);
    const engine = new Engine(16, { time });
    engine.advance(state, 16);

    // upgrade factor: 1 + 0.5*1 = 1.5 ; prestige factor: 1 + 0.1*5(earned) = 1.5
    // base persec 2 * 1.5 * 1.5 = 4.5
    expect(getPersecEffective(state)).toBeCloseTo(4.5, 9);
  });

  it("applies the prestige effect at drive exactly 1 and skips it at 0, mirroring applyPrestiges", () => {
    const time = new MockTimeProvider(16);
    const engine = new Engine(16, { time });

    // drive 1 (the very first prestige): prestige factor 1 + 0.1*1 = 1.1
    // base persec 2 * 1.5 (upgrade) * 1.1 = 3.3
    const atOne = makeStateWithUpgradeAndPrestigeMultOnSameTarget({ amount: 1 });
    engine.advance(atOne, 16);
    expect(getPersecEffective(atOne)).toBeCloseTo(3.3, 9);

    // drive 0: only the upgrade factor applies: 2 * 1.5 = 3
    const atZero = makeStateWithUpgradeAndPrestigeMultOnSameTarget({ amount: 0 });
    engine.advance(atZero, 16);
    expect(getPersecEffective(atZero)).toBeCloseTo(3, 9);
  });

  it("orders prestige effects after upgrade effects when stage/priority tie (declaration order)", () => {
    const state = makeStateWithUpgradeAndPrestigeMultOnSameTarget({ earned: 5 });
    const engine = new Engine();
    const mods = collectModifiers(state, engine.services);

    const producedTarget = state.producers[0]!.produces[0]!;
    const list = mods.get(producedTarget);

    expect(list).toHaveLength(2);
    expect(list?.[0]?.effect).toBe(state.upgrades[0]?.effects[0]);
    expect(list?.[1]?.effect).toBe(state.prestiges[0]?.effects[0]);
  });
});
