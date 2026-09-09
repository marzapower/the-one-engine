import { describe, expect, it } from "vitest";

import { N, NR } from "../../nums";
import { BUILT_IN_EFFECTS, EffectRegistry, type EffectTypeDef } from "./effect";

describe("EffectRegistry", () => {
  describe("built-in types", () => {
    it("seeds 'add' and 'mult' by default", () => {
      const registry = new EffectRegistry();
      expect(registry.list()).toHaveLength(2);
      expect(registry.lookup("add")).toBeDefined();
      expect(registry.lookup("mult")).toBeDefined();
    });

    it("can be built empty", () => {
      const registry = new EffectRegistry(false);
      expect(registry.list()).toHaveLength(0);
    });

    it("'add' has priority 100 and applies addition", () => {
      const registry = new EffectRegistry();
      const add = registry.lookup("add")!;
      expect(add.priority).toBe(100);
      expect(N(add.apply(N(10), N(5))).eq(15)).toBe(true);
    });

    it("'mult' has priority 200 and applies multiplication", () => {
      const registry = new EffectRegistry();
      const mult = registry.lookup("mult")!;
      expect(mult.priority).toBe(200);
      expect(N(mult.apply(N(10), N(2))).eq(20)).toBe(true);
    });
  });

  describe("register / lookup / list / unregister", () => {
    it("registers a custom type; a duplicate id is last-write-wins", () => {
      const registry = new EffectRegistry();
      const pow: EffectTypeDef = { id: "pow", version: "1.0.0", priority: 150, apply: (prev, computed) => NR(prev.pow(computed)) };
      registry.register(pow);
      expect(registry.lookup("pow")?.priority).toBe(150);

      registry.register({ ...pow, priority: 175 });
      expect(registry.lookup("pow")?.priority).toBe(175);
    });

    it("rejects an invalid id", () => {
      const registry = new EffectRegistry();
      expect(() => registry.register({ id: "123bad", version: "1.0.0", priority: 100, apply: () => NR(0) })).toThrow();
      expect(() => registry.register({ id: "bad@id", version: "1.0.0", priority: 100, apply: () => NR(0) })).toThrow();
      expect(() => registry.register({ id: "", version: "1.0.0", priority: 100, apply: () => NR(0) })).toThrow();
    });

    it("lists sorted by priority ascending", () => {
      const registry = new EffectRegistry();
      registry.register({ id: "custom", version: "1.0.0", priority: 150, apply: () => NR(0) });

      const ids = registry.list().map((t) => t.id);
      expect(ids).toEqual(["add", "custom", "mult"]);
    });

    it("filters by allowed stage", () => {
      const registry = new EffectRegistry();
      registry.register({ id: "early", version: "1.0.0", priority: 50, apply: () => NR(0), allowedStages: [0, 1] });
      registry.register({ id: "late", version: "1.0.0", priority: 250, apply: () => NR(0), allowedStages: [2] });

      expect(registry.list(0).find((t) => t.id === "early")).toBeDefined();
      expect(registry.list(0).find((t) => t.id === "late")).toBeUndefined();
      expect(registry.list(2).find((t) => t.id === "late")).toBeDefined();
      expect(registry.list(2).find((t) => t.id === "early")).toBeUndefined();
    });

    it("unregisters a type, returning false when it was not registered", () => {
      const registry = new EffectRegistry();
      expect(registry.unregister("add")).toBe(true);
      expect(registry.lookup("add")).toBeUndefined();
      expect(registry.unregister("add")).toBe(false);
    });
  });

  describe("instance isolation", () => {
    it("two registries do not share state", () => {
      const a = new EffectRegistry();
      const b = new EffectRegistry();

      a.register({ id: "only_on_a", version: "1.0.0", priority: 100, apply: () => NR(0) });

      expect(a.lookup("only_on_a")).toBeDefined();
      expect(b.lookup("only_on_a")).toBeUndefined();

      a.unregister("add");
      expect(a.lookup("add")).toBeUndefined();
      expect(b.lookup("add")).toBeDefined();
    });
  });

  it("BUILT_IN_EFFECTS exposes the same ids the default registry seeds", () => {
    const registry = new EffectRegistry();
    expect(BUILT_IN_EFFECTS.map((t) => t.id).sort()).toEqual(
      registry
        .list()
        .map((t) => t.id)
        .sort(),
    );
  });
});
