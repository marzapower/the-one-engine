import type { Engine } from "../core/engine";
import type { MilestoneDetector } from "./metrics";

/**
 * `saturation:onset` milestone detector: the first sample where saturation is
 * active AND some producer's raw support ratio drops below 1 — the moment
 * capacity starts eroding efficiency. Mirrors `Engine.computeProducers` via
 * the engine's own `saturationActive`/`supportRatio`, so it always agrees
 * with the tick loop and needs no game-specific knowledge: it no-ops
 * gracefully on states without saturation rules or without any capacity.
 */
export const saturationOnsetDetector = (engine: Engine): MilestoneDetector => {
  return (state, tSimMs) => {
    if (!engine.saturationActive(state)) return undefined;

    for (const producer of state.producers) {
      if (!producer.capacity) continue;
      if (engine.supportRatio(state, producer).raw.lt(1)) {
        return { event: "saturation:onset", tSimMs, detail: { code: producer.code } };
      }
    }

    return undefined;
  };
};
