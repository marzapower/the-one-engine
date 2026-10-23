import { beforeEach, describe, expect, it } from "vitest";

import { ScaleOn, ScalingMethod } from "../models/base";
import { type GenericNumberInput, N, NR } from "../nums";
import { type GameState, createInitialState } from "../state";
import { DefaultEntityRegistry, DefaultStateAdapter, silentLogger } from "./di/defaults";
import type { EngineServices } from "./di/types";
import { EffectRegistry } from "./registries/effect";
import { GrowthRegistry } from "./registries/growth";
import { validateBootstrap } from "./validation";

const buildServices = (): EngineServices => {
  const registry = new DefaultEntityRegistry();
  return {
    adapter: new DefaultStateAdapter(registry),
    registry,
    growths: new GrowthRegistry(),
    effectTypes: new EffectRegistry(),
    logger: silentLogger,
  };
};

describe("validateBootstrap", () => {
  let state: GameState;
  let services: EngineServices;

  beforeEach(() => {
    state = createInitialState();
    services = buildServices();
  });

  describe("duplicate codes", () => {
    it("detects duplicate producer codes", () => {
      state.producers = [
        {
          code: "e1",
          name: "Producer 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.15), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          produces: [],
        },
        {
          code: "e1",
          name: "Producer 2",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.15), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          produces: [],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining("Duplicate producer code: e1"));
    });

    it("detects duplicate currency codes", () => {
      state.currencies = [
        { code: "one", name: "One", amount: NR(0) },
        { code: "one", name: "One 2", amount: NR(0) },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining("Duplicate currency code: one"));
    });

    it("detects duplicate upgrade codes", () => {
      state.upgrades = [
        {
          code: "up1",
          name: "Upgrade 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.1), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          effects: [],
        },
        {
          code: "up1",
          name: "Upgrade 2",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.1), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          effects: [],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining("Duplicate upgrade code: up1"));
    });

    it("detects duplicate prestige codes", () => {
      state.currencies = [{ code: "one", name: "One", amount: NR(0) }];
      state.prestiges = [
        {
          code: "pres1",
          currencyCode: "one",
          source: { kind: "currency", code: "one", path: "amount" },
          target: { kind: "currency", code: "one", path: "amount" },
          effects: [],
          func: { base: NR(2), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
        },
        {
          code: "pres1",
          currencyCode: "one",
          source: { kind: "currency", code: "one", path: "amount" },
          target: { kind: "currency", code: "one", path: "amount" },
          effects: [],
          func: { base: NR(2), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining("Duplicate prestige code: pres1"));
    });
  });

  describe("target references", () => {
    it("detects unknown producer.produces reference", () => {
      state.producers = [
        {
          code: "e1",
          name: "Producer 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.15), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          produces: [{ code: "unknown", persec: NR(1) }],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining('produces reference to unknown code "unknown"'));
    });

    it("detects unknown upgrade effect target code", () => {
      state.upgrades = [
        {
          code: "up1",
          name: "Upgrade 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.1), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          effects: [
            {
              stage: 0,
              target: { kind: "currency", code: "unknown", path: "amount" },
              type: "add",
              func: { base: NR(1), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
            },
          ],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining("effect targets unknown currency"));
    });

    it("detects unknown prestige source code", () => {
      state.currencies = [{ code: "one", name: "One", amount: NR(0) }];
      state.prestiges = [
        {
          code: "pres1",
          currencyCode: "one",
          source: { kind: "currency", code: "unknown", path: "amount" },
          target: { kind: "currency", code: "one", path: "amount" },
          effects: [],
          func: { base: NR(2), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining("source targets unknown currency"));
    });

    it("detects unknown prestige target code", () => {
      state.currencies = [{ code: "one", name: "One", amount: NR(0) }];
      state.prestiges = [
        {
          code: "pres1",
          currencyCode: "one",
          source: { kind: "currency", code: "one", path: "amount" },
          target: { kind: "currency", code: "unknown", path: "amount" },
          effects: [],
          func: { base: NR(2), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining("target targets unknown currency"));
    });
  });

  describe("growth function domains", () => {
    it("detects an unknown growth method id", () => {
      state.producers = [
        {
          code: "e1",
          name: "Producer 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.15), func: "made_up", scaleOn: ScaleOn.self },
          produces: [],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining('unknown growth method "made_up"'));
    });

    it("detects a base below the registered domain", () => {
      state.producers = [
        {
          code: "e1",
          name: "Producer 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(0), coeff: NR(1.15), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          produces: [],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors.some((e) => e.includes("base must be >="))).toBe(true);
    });

    it("detects a coeff below the registered domain", () => {
      state.upgrades = [
        {
          code: "up1",
          name: "Upgrade 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(0), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          effects: [],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors.some((e) => e.includes("coeff must be >="))).toBe(true);
    });

    it("warns when coeff is exactly 1 for geometric/exponential/double_exponential", () => {
      state.producers = [
        {
          code: "e1",
          name: "Producer 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          produces: [],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.warnings.some((w) => w.includes("coeff is 1"))).toBe(true);
    });

    it("does not warn about coeff 1 for linear", () => {
      state.producers = [
        {
          code: "e1",
          name: "Producer 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
          produces: [],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.warnings.some((w) => w.includes("coeff is 1"))).toBe(false);
    });

    it("passes a custom growth method with coeff 0, registered on the services' registry", () => {
      const growths = new GrowthRegistry();
      growths.register({
        id: "flat",
        version: "1.0.0",
        compute: (base: unknown) => N(base as GenericNumberInput),
        capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false },
      });
      services.growths = growths;

      state.currencies = [{ code: "one", name: "One", amount: NR(0) }];
      state.producers = [
        {
          code: "e1",
          name: "Producer 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(0), func: "flat", scaleOn: ScaleOn.self },
          produces: [{ code: "one", persec: NR(1) }],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("effect types", () => {
    it("detects an unknown effect type id", () => {
      state.currencies = [{ code: "one", name: "One", amount: NR(0) }];
      state.upgrades = [
        {
          code: "up1",
          name: "Upgrade 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.1), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          effects: [
            {
              stage: 0,
              target: { kind: "currency", code: "one", path: "amount" },
              type: "made_up",
              func: { base: NR(1), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
            },
          ],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining('unknown effect type "made_up"'));
    });
  });

  describe("behavior references", () => {
    it("detects a behavior referencing an unknown prestige", () => {
      state.upgrades = [
        {
          code: "up1",
          name: "Upgrade 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.1), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          effects: [],
          behaviors: [{ kind: "autoPrestige", prestigeCode: "unknown", ratio: 2 }],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining('references unknown prestige "unknown"'));
    });
  });

  describe("saturation rules references", () => {
    it("detects unknown overflowCurrencyCode, gate and push currency codes", () => {
      state.rules = {
        saturation: {
          overflowCurrencyCode: "missing_overflow",
          gate: { currencyCode: "missing_gate", earnedAtLeast: 10 },
          push: { currencyCode: "missing_push", exponent: 2 },
        },
      };

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining('overflowCurrencyCode: unknown currency "missing_overflow"'));
      expect(result.errors).toContainEqual(expect.stringContaining('gate.currencyCode: unknown currency "missing_gate"'));
      expect(result.errors).toContainEqual(expect.stringContaining('push.currencyCode: unknown currency "missing_push"'));
    });
  });

  describe("producer capacity", () => {
    it("detects non-positive base/factor/decayScale and negative overflowRate", () => {
      state.producers = [
        {
          code: "e1",
          name: "Producer 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.15), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          produces: [],
          capacity: { base: NR(0), factor: NR(0), decayScale: 0, overflowRate: -1 },
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toContainEqual(expect.stringContaining("capacity.base must be > 0"));
      expect(result.errors).toContainEqual(expect.stringContaining("capacity.factor must be > 0"));
      expect(result.errors).toContainEqual(expect.stringContaining("capacity.decayScale must be > 0"));
      expect(result.errors).toContainEqual(expect.stringContaining("capacity.overflowRate must be >= 0"));
    });

    it("accepts valid capacity parameters", () => {
      state.currencies = [{ code: "one", name: "One", amount: NR(0) }];
      state.producers = [
        {
          code: "e1",
          name: "Producer 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.15), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          produces: [{ code: "one", persec: NR(1) }],
          capacity: { base: NR(1e6), factor: NR(2), decayScale: 44, overflowRate: 0.05 },
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("happy path", () => {
    it("passes validation with minimal valid state", () => {
      state.currencies = [{ code: "one", name: "One", amount: NR(0) }];
      state.producers = [
        {
          code: "e1",
          name: "Producer 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.15), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          produces: [{ code: "one", persec: NR(1) }],
        },
      ];

      const result = validateBootstrap(state, services);
      expect(result.errors).toHaveLength(0);
    });

    it("populates the bootstrap report with correct counts", () => {
      state.currencies = [{ code: "one", name: "One", amount: NR(0) }];
      state.producers = [
        {
          code: "e1",
          name: "Producer 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.15), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          produces: [{ code: "one", persec: NR(1) }],
        },
      ];
      state.upgrades = [
        {
          code: "up1",
          name: "Upgrade 1",
          amount: NR(0),
          bought: NR(0),
          currencyCode: "one",
          scaling: { base: NR(10), coeff: NR(1.1), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
          effects: [],
        },
      ];

      const result = validateBootstrap(state, services);
      const report = result.report;

      expect(report.producers).toBe(1);
      expect(report.currencies).toBe(1);
      expect(report.upgrades).toBe(1);
      expect(report.prestiges).toBe(0);
      expect(report.timeMs).toBeGreaterThanOrEqual(0);
      expect(report.validationErrors).toEqual(result.errors);
      expect(report.validationWarnings).toEqual(result.warnings);
    });
  });
});

describe("validateBootstrap — exact output on a broken state (pins the messages across refactors)", () => {
  const growth = (func: string, base: number, coeff: number) => ({ base: NR(base), coeff: NR(coeff), func, scaleOn: ScaleOn.self });
  const effect = (kind: "producer" | "currency" | "upgrade", code: string, path: string, type = "mult") => ({
    stage: 0 as const,
    target: { kind, code, path },
    type,
    func: growth("linear", 1, 1),
  });

  const buildBrokenState = (): GameState => {
    const state = createInitialState();
    state.currencies = [
      { code: "one", name: "One", amount: NR(0), primary: true },
      { code: "one", name: "One again", amount: NR(0) },
    ];
    state.producers = [
      {
        code: "p1",
        name: "P1",
        amount: NR(0),
        bought: NR(0),
        currencyCode: "one",
        scaling: growth("geometric", 10, 1),
        produces: [{ code: "ghost", persec: NR(1) }],
        capacity: { base: NR(0), factor: NR(-1), decayScale: 0, overflowRate: -0.5 },
      },
      { code: "p1", name: "P1 again", amount: NR(0), bought: NR(0), currencyCode: "one", scaling: growth("nope", 1, 1), produces: [] },
      {
        code: "p2",
        name: "P2",
        amount: NR(0),
        bought: NR(0),
        currencyCode: "one",
        scaling: growth("exponential", 0, 0),
        produces: [{ code: "one", persec: NR(1) }],
        capacity: { base: NR(5), factor: NR(5), decayScale: 2, overflowRate: 0.5 },
      },
    ];
    state.upgrades = [
      {
        code: "u1",
        name: "U1",
        amount: NR(0),
        bought: NR(0),
        currencyCode: "one",
        scaling: growth("double_exponential", 1, 2),
        effects: [
          effect("currency", "missing", "amount"),
          effect("producer", "missing", "amount"),
          effect("upgrade", "missing", "amount"),
          effect("currency", "one", "a.b.c"),
          effect("currency", "one", "amount", "made_up"),
          { ...effect("currency", "one", "amount"), func: growth("linear", -1, 1) },
        ],
        behaviors: [{ kind: "prestigeDrip", prestigeCode: "ghost", ratePerSecond: 1 }, { kind: "keepLevels", prestigeCode: "pr1", fraction: 0.5 }, { kind: "autobuyUpgrades" }],
      },
      { code: "u1", name: "U1 again", amount: NR(0), bought: NR(0), currencyCode: "one", scaling: growth("geometric", 10, 1), effects: [] },
    ];
    state.prestiges = [
      {
        code: "pr1",
        currencyCode: "one",
        source: { kind: "currency", code: "nowhere", path: "earned" },
        target: { kind: "producer", code: "p1", path: "x.y" },
        effects: [effect("upgrade", "missing", "amount", "bogus")],
        func: growth("logarithmic", 1, 0),
      },
      {
        code: "pr1",
        currencyCode: "one",
        source: { kind: "currency", code: "one", path: "earned" },
        target: { kind: "upgrade", code: "gone", path: "amount" },
        effects: [],
        func: growth("exponential", 2, 1),
      },
    ];
    state.rules = {
      saturation: {
        overflowCurrencyCode: "no-overflow",
        gate: { currencyCode: "no-gate", earnedAtLeast: 1 },
        push: { currencyCode: "no-push", exponent: 1 },
      },
    };
    return state;
  };

  it("reports exactly these errors and warnings, in this order", () => {
    const result = validateBootstrap(buildBrokenState(), buildServices());

    expect(result.errors).toEqual([
      "Duplicate producer code: p1",
      "Duplicate currency code: one",
      "Duplicate upgrade code: u1",
      "Duplicate prestige code: pr1",
      'Producer p1: produces reference to unknown code "ghost"',
      "Producer p1: capacity.base must be > 0",
      "Producer p1: capacity.factor must be > 0",
      "Producer p1: capacity.decayScale must be > 0",
      "Producer p1: capacity.overflowRate must be >= 0",
      'producer p1 scaling: unknown growth method "nope"',
      "producer p2 scaling: base must be >= 1e-10",
      'Upgrade u1: effect targets unknown currency "missing"',
      'Upgrade u1: effect targets unknown producer "missing"',
      'Upgrade u1: effect targets unknown upgrade "missing"',
      "Upgrade u1: effect target path cannot be resolved for currency:one:a.b.c",
      'Upgrade u1: unknown effect type "made_up"',
      "Upgrade u1 func: base must be >= 0",
      'Upgrade u1: behavior "prestigeDrip" references unknown prestige "ghost"',
      'Prestige pr1: source targets unknown currency "nowhere"',
      "Prestige pr1: target path cannot be resolved for producer:p1:x.y",
      "prestige pr1: coeff must be >= 1e-10",
      'Prestige pr1: effect targets unknown upgrade "missing"',
      'Prestige pr1: unknown effect type "bogus"',
      'Prestige pr1: target targets unknown upgrade "gone"',
      'rules.saturation.overflowCurrencyCode: unknown currency "no-overflow"',
      'rules.saturation.gate.currencyCode: unknown currency "no-gate"',
      'rules.saturation.push.currencyCode: unknown currency "no-push"',
    ]);
    expect(result.warnings).toEqual([
      "producer p1 scaling: coeff is 1 (may indicate configuration error)",
      "upgrade u1 scaling: coeff is 1 (may indicate configuration error)",
      "prestige pr1: coeff is 1 (may indicate configuration error)",
    ]);
    expect(result.report.validationErrors).toEqual(result.errors);
    expect(result.report.validationWarnings).toEqual(result.warnings);
    expect(result.report).toMatchObject({ producers: 3, currencies: 2, upgrades: 2, prestiges: 2, pathsCompiled: 0 });
  });

  it("reports upper domain bounds and non-numeric parameters of a custom growth method", () => {
    const services = buildServices();
    services.growths.register({
      id: "bounded",
      version: "1.0.0",
      compute: (base: unknown) => N(base as GenericNumberInput),
      capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false, domain: { base: { max: 5 }, coeff: { min: 1, max: 2 } } },
    });
    const state = createInitialState();
    state.currencies = [{ code: "one", name: "One", amount: NR(0) }];
    state.producers = [
      { code: "a", name: "A", amount: NR(0), bought: NR(0), currencyCode: "one", scaling: growth("bounded", 9, 0), produces: [] },
      { code: "b", name: "B", amount: NR(0), bought: NR(0), currencyCode: "one", scaling: growth("bounded", 1, 3), produces: [] },
      {
        code: "c",
        name: "C",
        amount: NR(0),
        bought: NR(0),
        currencyCode: "one",
        scaling: { base: "abc" as unknown as ReturnType<typeof NR>, coeff: NR(1.5), func: "bounded", scaleOn: ScaleOn.self },
        produces: [],
      },
    ];

    const result = validateBootstrap(state, services);
    expect(result.errors).toEqual([
      "producer a scaling: base must be <= 5",
      "producer a scaling: coeff must be >= 1",
      "producer b scaling: coeff must be <= 2",
      "producer c scaling: base must be <= 5",
    ]);
    expect(result.warnings).toEqual([]);
  });
});

describe("validateBootstrap — extra costs", () => {
  const geo = { base: NR(10), coeff: NR(2), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self };
  const withExtras = (extraCosts: NonNullable<GameState["producers"][number]["extraCosts"]>): GameState => ({
    ...createInitialState(),
    currencies: [
      { code: "one", name: "One", amount: NR(0) },
      { code: "two", name: "Two", amount: NR(0) },
    ],
    producers: [{ code: "p", name: "P", amount: NR(0), bought: NR(0), currencyCode: "one", scaling: geo, produces: [], extraCosts }],
    upgrades: [{ code: "u", name: "U", amount: NR(0), bought: NR(0), currencyCode: "one", scaling: geo, effects: [], extraCosts }],
  });
  const errorsOf = (state: GameState) => validateBootstrap(state, buildServices()).errors;

  it("accepts extras paid in a currency or a producer's stock", () => {
    expect(errorsOf(withExtras([{ currencyCode: "two", scaling: geo, fromBought: 1 }]))).toEqual([]);
    const state = withExtras([{ currencyCode: "p2", scaling: geo }]);
    state.producers.push({ ...state.producers[0]!, code: "p2", extraCosts: undefined });
    expect(errorsOf(state)).toEqual([]);
  });

  it("reports an unknown pool on producers and upgrades", () => {
    const errors = errorsOf(withExtras([{ currencyCode: "ghost", scaling: geo }]));
    expect(errors).toContainEqual(expect.stringContaining('Producer p: extra cost pool "ghost"'));
    expect(errors).toContainEqual(expect.stringContaining('Upgrade u: extra cost pool "ghost"'));
  });

  it("reports a pool equal to the main one or repeated among the extras", () => {
    expect(errorsOf(withExtras([{ currencyCode: "one", scaling: geo }]))).toContainEqual(expect.stringContaining("already paid"));
    const repeated = errorsOf(
      withExtras([
        { currencyCode: "two", scaling: geo },
        { currencyCode: "two", scaling: geo },
      ]),
    );
    expect(repeated.filter((e) => e.includes("already paid"))).toHaveLength(2);
  });

  it("reports a negative or fractional fromBought", () => {
    expect(errorsOf(withExtras([{ currencyCode: "two", scaling: geo, fromBought: -1 }]))).toContainEqual(expect.stringContaining("fromBought"));
    expect(errorsOf(withExtras([{ currencyCode: "two", scaling: geo, fromBought: 1.5 }]))).toContainEqual(expect.stringContaining("fromBought"));
  });

  it("validates the extra's growth function", () => {
    const errors = errorsOf(withExtras([{ currencyCode: "two", scaling: { ...geo, func: "nope" } }]));
    expect(errors).toContainEqual(expect.stringContaining('unknown growth method "nope"'));
  });
});
