import { describe, expect, it } from "vitest";

import { type Effect, type GrowthFunction, ScaleOn, ScalingMethod, type Upgrade } from "../models/base";
import { N, NR } from "../nums";
import { type GameState, createInitialState } from "../state";
import { Engine } from "./engine";
import { foldCurrencyChannel } from "./prestige-gain";

const constant = (value: number): GrowthFunction => ({ base: NR(value), coeff: NR(0), func: ScalingMethod.Linear, scaleOn: ScaleOn.self });
const onGain = (type: string, value: number, stage: 0 | 1 | 2 = 0): Effect =>
  ({ stage, target: { kind: "currency", code: "if", path: "gainMult" }, type, func: constant(value) }) as Effect;
const owned = (effects: Effect[]): Upgrade => ({
  code: "u",
  name: "u",
  currencyCode: "if",
  amount: NR(1),
  bought: NR(1),
  scaling: constant(1),
  effects,
  resetsOn: [],
});
/** Upgrades fold before currencies in declaration order: each case below declares against the expected order. */
const fold = (upgradeEffects: Effect[], currencyEffects: Effect[]) => {
  const state: GameState = {
    ...createInitialState(),
    currencies: [
      { code: "tock", name: "tock", amount: NR(1), effects: currencyEffects },
      { code: "if", name: "if", amount: NR(0) },
    ],
    upgrades: [owned(upgradeEffects)],
  };
  return N(foldCurrencyChannel(state, "if", "gainMult", new Engine().services)).toNumber();
};

describe("foldCurrencyChannel", () => {
  it("applies type priority within a stage: an upgrade pow declared first still lands after a currency mult", () => {
    expect(fold([onGain("pow", 2)], [onGain("mult", 3)])).toBe(9); // (1 · 3)^2, not 1^2 · 3
  });

  it("applies stage before priority: a stage-1 mult lands after a stage-0 add declared later", () => {
    expect(fold([onGain("mult", 3, 1)], [onGain("add", 2, 0)])).toBe(9); // (1 + 2) · 3, not 1 · 3 + 2
  });

  it("keeps declaration order for equal stage and priority", () => {
    expect(fold([onGain("mult", 3)], [onGain("mult", 5)])).toBe(15);
  });
});
