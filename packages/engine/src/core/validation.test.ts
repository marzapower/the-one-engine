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
