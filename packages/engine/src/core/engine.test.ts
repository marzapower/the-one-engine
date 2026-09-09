import { describe, expect, it } from "vitest";

import { N, NR } from "../nums";
import type { StageMetrics } from "../state";
import { createInitialState } from "../state";
import { Engine } from "./engine";

describe("Engine", () => {
  it("gets created", () => {
    expect(new Engine()).toBeDefined();
  });

  describe("tick & stage metrics", () => {
    it("populates stageMetrics for all stages", () => {
      const engine = new Engine();
      const state = createInitialState();

      engine.tick(state);

      for (const stage of engine.stages.list()) {
        expect(state.stats.stageMetrics[stage.id]).toBeDefined();
      }
    });

    it("aggregates metrics correctly within multiple tick calls", () => {
      const engine = new Engine();
      const state = createInitialState();

      engine.tick(state);
      const afterFirstTick = state.stats.stageMetrics["Produce"]?.count ?? 0;

      engine.tick(state);
      const afterSecondTick = state.stats.stageMetrics["Produce"]?.count ?? 0;

      expect(afterSecondTick).toBeGreaterThanOrEqual(afterFirstTick);
    });

    it("tracks min/max metrics per stage", () => {
      const engine = new Engine();
      const state = createInitialState();

      engine.tick(state);

      const metrics = state.stats.stageMetrics["Produce"];
      expect(metrics).toBeDefined();
      if (metrics) {
        expect(metrics.minMs).toBeGreaterThanOrEqual(0);
        expect(metrics.maxMs).toBeGreaterThanOrEqual(metrics.minMs);
        expect(metrics.lastMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("getStageReport", () => {
    it("returns stages sorted by avgMs descending", () => {
      const engine = new Engine();
      const state = createInitialState();

      const metrics1: StageMetrics = { count: 1, totalMs: 5, avgMs: 5, minMs: 5, maxMs: 5, lastMs: 5 };
      const metrics2: StageMetrics = { count: 1, totalMs: 10, avgMs: 10, minMs: 10, maxMs: 10, lastMs: 10 };
      const metrics3: StageMetrics = { count: 1, totalMs: 2, avgMs: 2, minMs: 2, maxMs: 2, lastMs: 2 };
      state.stats.stageMetrics["Upgrades(0)"] = metrics1;
      state.stats.stageMetrics["Produce"] = metrics2;
      state.stats.stageMetrics["Upgrades(1)"] = metrics3;

      const report = engine.getStageReport(state);

      expect(report).toHaveLength(3);
      expect(report[0]?.[0]).toBe("Produce");
      expect(report[1]?.[0]).toBe("Upgrades(0)");
      expect(report[2]?.[0]).toBe("Upgrades(1)");
    });

    it("handles empty stageMetrics", () => {
      const engine = new Engine();
      const state = createInitialState();

      const report = engine.getStageReport(state);
      expect(report).toEqual([]);
    });
  });

  describe("registries are per instance", () => {
    it("a stage registered on one engine is not seen by another", () => {
      const engineA = new Engine();
      const engineB = new Engine();

      engineA.stages.register({ id: "Custom", version: "1.0.0", priority: 50, run: () => {} });

      expect(engineA.stages.lookup("Custom")).toBeDefined();
      expect(engineB.stages.lookup("Custom")).toBeUndefined();
    });

    it("a growth method registered on one engine is not seen by another", () => {
      const engineA = new Engine();
      const engineB = new Engine();

      engineA.growths.register({
        id: "custom_cubic",
        version: "1.0.0",
        compute: (base, coeff, offset, quantity) =>
          N(base)
            .add(N(coeff).mul(N(quantity).pow(3)))
            .add(N(offset)),
        capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false },
      });

      expect(engineA.growths.lookup("custom_cubic")).toBeDefined();
      expect(engineB.growths.lookup("custom_cubic")).toBeUndefined();
    });

    it("an effect type registered on one engine is not seen by another", () => {
      const engineA = new Engine();
      const engineB = new Engine();

      engineA.effectTypes.register({ id: "pow", version: "1.0.0", priority: 300, apply: (prev, computed) => NR(prev.pow(computed)) });

      expect(engineA.effectTypes.lookup("pow")).toBeDefined();
      expect(engineB.effectTypes.lookup("pow")).toBeUndefined();
    });
  });
});
