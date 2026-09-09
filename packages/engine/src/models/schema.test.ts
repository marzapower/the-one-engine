import { describe, expect, it } from "vitest";

import { NR } from "../nums";
import { createInitialState } from "../state";
import { ScaleOn, ScalingMethod } from "./base";
import { Factory } from "./base/factory";
import {
  CurrencySchema,
  DataPackSchema,
  GameStateSchema,
  GrowthFunctionSchema,
  NumerusSchema,
  PrestigeSchema,
  ProducerSchema,
  TargetSchema,
  UpgradeBehaviorSchema,
  UpgradeSchema,
  parseDataPack,
  parseGameState,
} from "./schema";

describe("NumerusSchema", () => {
  it("validates number, numeric string and raw form", () => {
    expect(NumerusSchema.safeParse(42).success).toBe(true);
    expect(NumerusSchema.safeParse("1e10").success).toBe(true);
    expect(NumerusSchema.safeParse({ sign: 1, layer: 0, mag: 42 }).success).toBe(true);
  });

  it("rejects null and the legacy {sign, array} form", () => {
    expect(NumerusSchema.safeParse(null).success).toBe(false);
    expect(NumerusSchema.safeParse({ sign: 1, array: [42] }).success).toBe(false);
  });
});

describe("GrowthFunctionSchema", () => {
  it("validates every built-in method within its domain", () => {
    expect(GrowthFunctionSchema.safeParse({ base: 10, coeff: 1.2, func: "linear", scaleOn: "self" }).success).toBe(true);
    expect(GrowthFunctionSchema.safeParse({ base: 2, coeff: 1.5, func: "geometric", scaleOn: "self" }).success).toBe(true);
    expect(GrowthFunctionSchema.safeParse({ base: 1.5, coeff: 2, func: "exponential", scaleOn: "self" }).success).toBe(true);
    expect(GrowthFunctionSchema.safeParse({ base: 2, coeff: 1.2, func: "double_exponential", scaleOn: "self" }).success).toBe(true);
  });

  it("still enforces the built-in domain (base > 0, double_exponential base > 1, coeff > 0)", () => {
    expect(GrowthFunctionSchema.safeParse({ base: 0, coeff: 1.2, func: "linear", scaleOn: "self" }).success).toBe(false);
    expect(GrowthFunctionSchema.safeParse({ base: 10, coeff: 0, func: "geometric", scaleOn: "self" }).success).toBe(false);
    expect(GrowthFunctionSchema.safeParse({ base: 0.5, coeff: 1.2, func: "double_exponential", scaleOn: "self" }).success).toBe(false);
  });

  it("accepts a custom growth method id, domain unchecked", () => {
    const result = GrowthFunctionSchema.safeParse({ base: 0, coeff: 0, offset: 1, func: "cubic", scaleOn: "self" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty func id", () => {
    const result = GrowthFunctionSchema.safeParse({ base: 10, coeff: 1.2, func: "", scaleOn: "self" });
    expect(result.success).toBe(false);
  });

  it("allows optional offset and the 'other' scaleOn", () => {
    expect(GrowthFunctionSchema.safeParse({ base: 10, coeff: 1.2, offset: 5, func: "linear", scaleOn: "self" }).success).toBe(true);
    expect(GrowthFunctionSchema.safeParse({ base: 10, coeff: 1.2, func: "linear", scaleOn: "other" }).success).toBe(true);
  });
});

describe("TargetSchema", () => {
  it("validates a target and its wildcard path form", () => {
    expect(TargetSchema.safeParse({ kind: "producer", code: "e1", path: "amount" }).success).toBe(true);
    expect(TargetSchema.safeParse({ kind: "producer", code: "e1", path: "produces.*" }).success).toBe(true);
  });

  it("rejects an invalid path or kind", () => {
    expect(TargetSchema.safeParse({ kind: "producer", code: "e1", path: "123invalid" }).success).toBe(false);
    expect(TargetSchema.safeParse({ kind: "unknown", code: "x", path: "a" }).success).toBe(false);
  });
});

describe("ProducerSchema", () => {
  it("validates a producer built by the factory, with and without a capacity block", () => {
    expect(ProducerSchema.safeParse(Factory.buildProducer({ code: "e1" })).success).toBe(true);
    expect(
      ProducerSchema.safeParse(
        Factory.buildProducer({
          code: "e1",
          capacity: { base: NR(100), factor: NR(1.1), decayScale: 2, overflowRate: 0.05 },
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects a producer without a code and strips unknown fields", () => {
    const prod = Factory.buildProducer({ code: "e1" });
    const { code: _code, ...rest } = prod;
    expect(ProducerSchema.safeParse(rest).success).toBe(false);

    const withExtra = { ...prod, unknownField: "dropped" };
    const result = ProducerSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>).unknownField).toBeUndefined();
  });
});

describe("CurrencySchema", () => {
  it("validates a currency with drive, capacityMult, gainMult and coolingMult", () => {
    const curr = Factory.buildCurrency({
      code: "dd",
      primary: true,
      earned: NR(0),
      drive: { unspentWeight: 0, earnedWeight: 1 },
      capacityMult: NR(1),
      gainMult: NR(1),
      coolingMult: NR(1),
    });
    expect(CurrencySchema.safeParse(curr).success).toBe(true);
  });

  it("rejects a currency without a code", () => {
    const curr = Factory.buildCurrency({ code: "dd" });
    const { code: _code, ...rest } = curr;
    expect(CurrencySchema.safeParse(rest).success).toBe(false);
  });
});

describe("UpgradeBehaviorSchema", () => {
  it("validates every kind with its own required fields", () => {
    expect(UpgradeBehaviorSchema.safeParse({ kind: "autobuyUpgrades" }).success).toBe(true);
    expect(UpgradeBehaviorSchema.safeParse({ kind: "autobuyUpgrades", prestigeCode: "p" }).success).toBe(true);
    expect(UpgradeBehaviorSchema.safeParse({ kind: "prestigeDrip", prestigeCode: "p", ratePerSecond: 0.001 }).success).toBe(true);
    expect(UpgradeBehaviorSchema.safeParse({ kind: "autoPrestige", prestigeCode: "p", ratio: 1.5 }).success).toBe(true);
    expect(UpgradeBehaviorSchema.safeParse({ kind: "keepLevels", prestigeCode: "p", fraction: 0.5 }).success).toBe(true);
  });

  it("rejects a behavior missing the fields its kind requires", () => {
    expect(UpgradeBehaviorSchema.safeParse({ kind: "prestigeDrip", prestigeCode: "p" }).success).toBe(false);
    expect(UpgradeBehaviorSchema.safeParse({ kind: "keepLevels", fraction: 0.5 }).success).toBe(false);
    expect(UpgradeBehaviorSchema.safeParse({ kind: "somethingElse" }).success).toBe(false);
  });
});

describe("UpgradeSchema", () => {
  it("validates an upgrade with behaviors", () => {
    const upg = Factory.buildUpgrade({
      code: "if-autoupgrader",
      behaviors: [{ kind: "autobuyUpgrades", prestigeCode: "reset" }],
    });
    expect(UpgradeSchema.safeParse(upg).success).toBe(true);
  });

  it("rejects an upgrade without a code", () => {
    const upg = Factory.buildUpgrade({ code: "u1" });
    const { code: _code, ...rest } = upg;
    expect(UpgradeSchema.safeParse(rest).success).toBe(false);
  });
});

describe("PrestigeSchema", () => {
  it("validates a prestige", () => {
    const prest = {
      code: "reset",
      currencyCode: "if",
      source: { kind: "currency" as const, code: "dd", path: "amount" },
      target: { kind: "currency" as const, code: "if", path: "amount" },
      effects: [],
      func: { base: NR(2), coeff: NR(1.5), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
    };
    expect(PrestigeSchema.safeParse(prest).success).toBe(true);

    const { code: _code, ...rest } = prest;
    expect(PrestigeSchema.safeParse(rest).success).toBe(false);
  });
});

describe("GameStateSchema", () => {
  it("round-trips a full state with rules, capacity, behaviors and drive", () => {
    const state = {
      ...createInitialState(),
      producers: [
        Factory.buildProducer({
          code: "e1",
          capacity: { base: NR(100), factor: NR(1.1), decayScale: 2, overflowRate: 0.05 },
        }),
      ],
      currencies: [
        Factory.buildCurrency({ code: "dd", capacityMult: NR(1), coolingMult: NR(1) }),
        Factory.buildCurrency({ code: "if", primary: true, earned: NR(0), drive: { unspentWeight: 0, earnedWeight: 1 } }),
      ],
      upgrades: [Factory.buildUpgrade({ code: "if-autoupgrader", behaviors: [{ kind: "autobuyUpgrades" }] })],
      prestiges: [
        {
          code: "reset",
          currencyCode: "if",
          source: { kind: "currency" as const, code: "dd", path: "amount" },
          target: { kind: "currency" as const, code: "if", path: "amount" },
          effects: [],
          func: { base: NR(2), coeff: NR(1.5), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
        },
      ],
      rules: {
        saturation: {
          overflowCurrencyCode: "dd",
          gate: { currencyCode: "if", earnedAtLeast: 0 },
          push: { currencyCode: "if", exponent: 0.3 },
          drag: { onset: 1e6, scale: 44, exponent: 4, floor: 0.05 },
          cooling: { halfLifeMs: 5_400_000 },
        },
      },
    };

    const result = GameStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it("rejects a legacy state shaped with 'erasers' and without 'producers'", () => {
    const legacy = {
      ...createInitialState(),
      erasers: [],
      fps: 60,
      paused: false,
      clickCooldown: { currentProgress: 0, isClickable: true, totalDuration: 0 },
      buyMode: 1,
    } as Record<string, unknown>;
    delete legacy.producers;

    const result = GameStateSchema.safeParse(legacy);
    expect(result.success).toBe(false);
  });

  it("passes through extra stats fields", () => {
    const state = { ...createInitialState(), stats: { ...createInitialState().stats, futureField: "kept" } };
    const result = GameStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });
});

describe("DataPackSchema", () => {
  it("validates a versioned payload and rejects a malformed version", () => {
    expect(DataPackSchema.safeParse({ schemaVersion: "1.0.0", payload: { some: "data" } }).success).toBe(true);
    expect(DataPackSchema.safeParse({ schemaVersion: "1.0", payload: {} }).success).toBe(false);
  });
});

describe("parseGameState", () => {
  it("returns a valid result for an initial state", () => {
    const result = parseGameState(createInitialState());
    expect(result.valid).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.errors).toHaveLength(0);
  });

  it("returns errors, never throws, for invalid input", () => {
    expect(() => parseGameState(null)).not.toThrow();
    expect(parseGameState(null).valid).toBe(false);
    expect(parseGameState({ ...createInitialState(), producers: "not-an-array" }).errors.length).toBeGreaterThan(0);
  });
});

describe("parseDataPack", () => {
  it("returns a valid result for a valid pack and errors for an invalid one", () => {
    const ok = parseDataPack({ schemaVersion: "1.0.0", payload: { some: "data" } });
    expect(ok.valid).toBe(true);

    const bad = parseDataPack({ schemaVersion: "1.0", payload: {} });
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it("never throws on invalid input", () => {
    expect(() => parseDataPack(null)).not.toThrow();
    expect(() => parseDataPack("invalid")).not.toThrow();
  });
});
