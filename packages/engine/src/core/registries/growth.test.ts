import { describe, expect, it } from "vitest";

import { N, NR } from "../../nums";
import { BUILT_IN_GROWTHS, type GrowthMethodDef, GrowthRegistry } from "./growth";

describe("GrowthRegistry", () => {
  describe("built-in methods", () => {
    it("seeds the five built-in methods by default", () => {
      const registry = new GrowthRegistry();
      const ids = registry.list().map((m) => m.id);
      expect(ids).toHaveLength(5);
      expect(ids).toEqual(expect.arrayContaining(["linear", "geometric", "exponential", "double_exponential", "logarithmic"]));
    });

    it("can be built empty", () => {
      const registry = new GrowthRegistry(false);
      expect(registry.list()).toHaveLength(0);
      expect(registry.lookup("linear")).toBeUndefined();
    });

    it("looks up a built-in method by id", () => {
      const registry = new GrowthRegistry();
      const linear = registry.lookup("linear");
      expect(linear).toBeDefined();
      expect(linear?.version).toBe("1.0.0");
      expect(linear?.capabilities.hasClosedFormSum).toBe(true);
      expect(linear?.capabilities.hasClosedFormNmax).toBe(true);
    });

    it("returns undefined for an unknown method", () => {
      const registry = new GrowthRegistry();
      expect(registry.lookup("unknown_growth")).toBeUndefined();
    });

    it("every cost-curve built-in exposes a closed-form maximum; logarithmic does not", () => {
      const registry = new GrowthRegistry();
      for (const id of registry.list().map((m) => m.id)) {
        const method = registry.lookup(id);
        if (id === "logarithmic") {
          expect(method?.capabilities.hasClosedFormNmax).toBe(false);
          continue;
        }
        expect(method?.maxBuyable).toBeDefined();
        expect(method?.capabilities.hasClosedFormNmax).toBe(true);
      }
    });

    it("logarithmic declares scaleOnOther: quantity", () => {
      const registry = new GrowthRegistry();
      expect(registry.lookup("logarithmic")?.capabilities.scaleOnOther).toBe("quantity");
    });
  });

  describe("computation", () => {
    it("computes linear growth: base + coeff*C + offset", () => {
      const registry = new GrowthRegistry();
      const result = registry.lookup("linear")!.compute(NR(10), NR(2), NR(1), NR(5));
      expect(result.toNumber()).toBe(21);
    });

    it("computes geometric growth: base * coeff^C + offset", () => {
      const registry = new GrowthRegistry();
      const result = registry.lookup("geometric")!.compute(NR(2), NR(3), NR(0), NR(2));
      expect(result.toNumber()).toBe(18);
    });

    it("computes exponential growth: base^(coeff*C) + offset", () => {
      const registry = new GrowthRegistry();
      const result = registry.lookup("exponential")!.compute(NR(2), NR(3), NR(0), NR(1));
      expect(result.sub(8).abs().lte(1e-9)).toBe(true);
    });

    it("computes double exponential growth: base^(coeff^C) + offset", () => {
      const registry = new GrowthRegistry();
      const result = registry.lookup("double_exponential")!.compute(NR(2), NR(2), NR(0), NR(1));
      expect(result.toNumber()).toBe(4);
    });
  });

  describe("sums", () => {
    it("sums linear, geometric, exponential and double exponential correctly", () => {
      const registry = new GrowthRegistry();
      expect(registry.lookup("linear")!.sumToN!(NR(10), NR(2), NR(0), NR(0), NR(3)).toNumber()).toBe(36);
      expect(registry.lookup("geometric")!.sumToN!(NR(2), NR(3), NR(0), NR(0), NR(2)).toNumber()).toBe(8);
      expect(registry.lookup("exponential")!.sumToN!(NR(2), NR(1), NR(0), NR(0), NR(2)).toNumber()).toBe(3);
      expect(registry.lookup("double_exponential")!.sumToN!(NR(2), NR(2), NR(0), NR(0), NR(2)).toNumber()).toBe(6);
    });
  });

  describe("register / lookup / list / unregister", () => {
    it("registers a custom method", () => {
      const registry = new GrowthRegistry();
      const quadratic: GrowthMethodDef = {
        id: "quadratic",
        version: "1.0.0",
        compute: (base, coeff, offset, quantity) =>
          N(base)
            .mul(N(quantity).pow(N(coeff)))
            .add(N(offset)),
        capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false },
      };

      registry.register(quadratic);
      expect(registry.lookup("quadratic")?.id).toBe("quadratic");
    });

    it("rejects an invalid id", () => {
      const registry = new GrowthRegistry();
      expect(() => registry.register({ id: "1bad", version: "1.0.0", compute: () => N(0), capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false } })).toThrow();
    });

    it("throws on a duplicate id without allowOverride", () => {
      const registry = new GrowthRegistry();
      const dup: GrowthMethodDef = { id: "linear", version: "2.0.0", compute: () => N(0), capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false } };
      expect(() => registry.register(dup)).toThrow(/Growth method "linear" is already registered/);
    });

    it("allows override when allowOverride is true", () => {
      const registry = new GrowthRegistry();
      const dup: GrowthMethodDef = { id: "linear", version: "2.0.0", compute: () => N(42), capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false } };
      registry.register(dup, true);
      expect(registry.lookup("linear")?.version).toBe("2.0.0");
    });

    it("unregisters a method, returning false when it was not registered", () => {
      const registry = new GrowthRegistry();
      expect(registry.unregister("linear")).toBe(true);
      expect(registry.lookup("linear")).toBeUndefined();
      expect(registry.unregister("linear")).toBe(false);
    });
  });

  describe("instance isolation", () => {
    it("two registries do not share state", () => {
      const a = new GrowthRegistry();
      const b = new GrowthRegistry();

      a.register({ id: "only_on_a", version: "1.0.0", compute: () => N(0), capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false } });

      expect(a.lookup("only_on_a")).toBeDefined();
      expect(b.lookup("only_on_a")).toBeUndefined();

      a.unregister("linear");
      expect(a.lookup("linear")).toBeUndefined();
      expect(b.lookup("linear")).toBeDefined();
    });
  });

  it("BUILT_IN_GROWTHS exposes the same ids the default registry seeds", () => {
    const registry = new GrowthRegistry();
    expect(BUILT_IN_GROWTHS.map((m) => m.id).sort()).toEqual(
      registry
        .list()
        .map((m) => m.id)
        .sort(),
    );
  });
});
