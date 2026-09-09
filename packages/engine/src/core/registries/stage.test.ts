import { describe, expect, it } from "vitest";

import { BUILT_IN_STAGES, type StageDef, StageRegistry } from "./stage";

describe("StageRegistry", () => {
  describe("built-in stages", () => {
    it("seeds the seven built-in stages by default", () => {
      const registry = new StageRegistry();
      expect(registry.count()).toBe(7);
      expect(registry.list().map((s) => s.id)).toEqual([...BUILT_IN_STAGES]);
    });

    it("can be built empty", () => {
      const registry = new StageRegistry(false);
      expect(registry.count()).toBe(0);
    });

    it("orders built-in stages by their declared priority", () => {
      const registry = new StageRegistry();
      const stages = registry.list();
      expect(stages.map((s) => s.priority)).toEqual([100, 200, 300, 400, 500, 600, 700]);
    });

    it("every built-in stage has a run function", () => {
      const registry = new StageRegistry();
      for (const stage of registry.list()) {
        expect(typeof stage.run).toBe("function");
      }
    });
  });

  describe("register / lookup / list / unregister", () => {
    it("registers a custom stage at the given priority", () => {
      const registry = new StageRegistry();
      const custom: StageDef = { id: "Custom", version: "1.0.0", priority: 250, run: () => {} };
      registry.register(custom);

      expect(registry.lookup("Custom")?.priority).toBe(250);
    });

    it("orders a custom stage among the built-ins by priority", () => {
      const registry = new StageRegistry();
      registry.register({ id: "Between", version: "1.0.0", priority: 250, run: () => {} });

      const ids = registry.list().map((s) => s.id);
      expect(ids.indexOf("Produce")).toBeLessThan(ids.indexOf("Between"));
      expect(ids.indexOf("Between")).toBeLessThan(ids.indexOf("Upgrades(1)"));
    });

    it("rejects an invalid stage id", () => {
      const registry = new StageRegistry();
      expect(() => registry.register({ id: "", version: "1.0.0", priority: 100, run: () => {} })).toThrow();
      expect(() => registry.register({ id: "Invalid@Stage", version: "1.0.0", priority: 100, run: () => {} })).toThrow();
      expect(() => registry.register({ id: "Invalid-Stage", version: "1.0.0", priority: 100, run: () => {} })).toThrow();
    });

    it("accepts alphanumeric ids with underscores and parentheses", () => {
      const registry = new StageRegistry();
      registry.register({ id: "Stage_1", version: "1.0.0", priority: 100, run: () => {} });
      registry.register({ id: "Stage(0)", version: "1.0.0", priority: 101, run: () => {} });
      expect(registry.lookup("Stage_1")).toBeDefined();
      expect(registry.lookup("Stage(0)")).toBeDefined();
    });

    it("keeps registration order for stages with equal priority (stable sort)", () => {
      const registry = new StageRegistry();
      registry.register({ id: "First", version: "1.0.0", priority: 250, run: () => {} });
      registry.register({ id: "Second", version: "1.0.0", priority: 250, run: () => {} });

      const ids = registry.list().map((s) => s.id);
      expect(ids.indexOf("First")).toBeLessThan(ids.indexOf("Second"));
    });

    it("rejects a duplicate id by default, accepts it with allowOverride", () => {
      const registry = new StageRegistry();
      const stage1: StageDef = { id: "Duplicate", version: "1.0.0", priority: 250, run: () => {} };
      registry.register(stage1);

      const stage2: StageDef = { id: "Duplicate", version: "2.0.0", priority: 260, run: () => {} };
      expect(() => registry.register(stage2)).toThrow();
      expect(() => registry.register(stage2, true)).not.toThrow();
      expect(registry.lookup("Duplicate")?.version).toBe("2.0.0");
    });

    it("unregisters a stage, returning false when it was not registered", () => {
      const registry = new StageRegistry();
      registry.register({ id: "Temp", version: "1.0.0", priority: 250, run: () => {} });
      expect(registry.unregister("Temp")).toBe(true);
      expect(registry.lookup("Temp")).toBeUndefined();
      expect(registry.unregister("Temp")).toBe(false);
    });

    it("count() reflects registrations and removals", () => {
      const registry = new StageRegistry();
      registry.register({ id: "A", version: "1.0.0", priority: 250, run: () => {} });
      registry.register({ id: "B", version: "1.0.0", priority: 260, run: () => {} });
      expect(registry.count()).toBe(9);
      registry.unregister("A");
      expect(registry.count()).toBe(8);
    });
  });

  describe("instance isolation", () => {
    it("two registries do not share state", () => {
      const a = new StageRegistry();
      const b = new StageRegistry();

      a.register({ id: "only_on_a", version: "1.0.0", priority: 250, run: () => {} });

      expect(a.lookup("only_on_a")).toBeDefined();
      expect(b.lookup("only_on_a")).toBeUndefined();

      a.unregister("Produce");
      expect(a.lookup("Produce")).toBeUndefined();
      expect(b.lookup("Produce")).toBeDefined();
    });
  });
});
