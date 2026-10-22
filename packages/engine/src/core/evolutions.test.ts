import { describe, expect, it } from "vitest";

import type { Currency, Effect, GrowthFunction, Prestige, Producer, Target, Upgrade, UpgradeBehavior } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { N, NR } from "../nums";
import { type GameState, createInitialState } from "../state";
import { applyPrestigeDrips, grantedLevels, keptLevelsFraction, levelsAfterPrestige, runAutoPrestiges, runUpgradeAutobuyers } from "./behaviors";
import { Engine } from "./engine";
import { collectModifiers } from "./modifiers";
import { advancePrestigeRuns, resolveTargetCode } from "./prestige-run";

const lin = (base: number, coeff = 0): GrowthFunction => ({ base: NR(base), coeff: NR(coeff), func: ScalingMethod.Linear, scaleOn: ScaleOn.self });
const IDENTITY = lin(0, 1);
const currency = (code: string, amount: number, extra: Partial<Currency> = {}): Currency => ({ code, name: code, amount: NR(amount), ...extra });
const producer = (code: string, amount: number, extra: Partial<Producer> = {}): Producer => ({
  code,
  name: code,
  amount: NR(amount),
  bought: NR(0),
  currencyCode: "one",
  scaling: lin(10),
  produces: [{ code: "one", persec: NR(1) }],
  ...extra,
});
const upgrade = (code: string, extra: Partial<Upgrade> = {}): Upgrade => ({
  code,
  name: code,
  amount: NR(0),
  bought: NR(0),
  currencyCode: "one",
  scaling: lin(10),
  effects: [],
  ...extra,
});
const prestige = (): Prestige => ({
  code: "frag",
  currencyCode: "if",
  source: { kind: "currency", code: "one", path: "amount" },
  target: { kind: "currency", code: "if", path: "amount" },
  func: IDENTITY,
  effects: [],
});
const owner = (behaviors: UpgradeBehavior[], extra: Partial<Upgrade> = {}): Upgrade => upgrade("owner", { bought: NR(1), amount: NR(1), behaviors, ...extra });
const stateOf = (parts: Partial<GameState>): GameState => ({ ...createInitialState(), ...parts });

describe("Target.select (highestOwnedOf)", () => {
  const select: Target = { kind: "producer", code: "e1", path: "produces.*.persec", select: { highestOwnedOf: ["e1", "e2", "e3"] } };
  const multAll: Effect = { stage: 0, target: select, type: "mult", func: lin(2) };

  it("resolves to the last owned producer, or to nothing", () => {
    const state = stateOf({ producers: [producer("e1", 0), producer("e2", 0), producer("e3", 0)] });
    expect(resolveTargetCode(state, select)).toBeNull();
    state.producers[0]!.amount = NR(1);
    expect(resolveTargetCode(state, select)).toBe("e1");
    state.producers[1]!.amount = NR(4);
    expect(resolveTargetCode(state, select)).toBe("e2");
    expect(resolveTargetCode(state, { kind: "producer", code: "e3", path: "x" })).toBe("e3");
  });

  it("the modifier follows tier changes and a static target keeps a distinct cache entry", () => {
    const engine = new Engine();
    const state = stateOf({
      producers: [producer("e1", 1), producer("e2", 0), producer("e3", 0)],
      upgrades: [upgrade("chain", { bought: NR(1), effects: [multAll] })],
    });
    const mods = () => collectModifiers(state, engine.services);

    expect(mods().has(state.producers[0]!.produces[0]!)).toBe(true);
    expect(mods().has(state.producers[1]!.produces[0]!)).toBe(false);

    state.producers[1]!.amount = NR(1);
    expect(mods().has(state.producers[0]!.produces[0]!)).toBe(false);
    expect(mods().has(state.producers[1]!.produces[0]!)).toBe(true);

    // The same effect on a static target of the same code/path resolves independently of the selection.
    state.upgrades.push(upgrade("static", { bought: NR(1), effects: [{ ...multAll, target: { kind: "producer", code: "e1", path: "produces.*.persec" } }] }));
    expect(mods().has(state.producers[0]!.produces[0]!)).toBe(true);
    expect(mods().has(state.producers[1]!.produces[0]!)).toBe(true);
  });

  it("nothing owned: the effect resolves to nothing without error", () => {
    const engine = new Engine();
    const state = stateOf({ producers: [producer("e1", 0), producer("e2", 0), producer("e3", 0)], upgrades: [upgrade("chain", { bought: NR(1), effects: [multAll] })] });
    expect(collectModifiers(state, engine.services).size).toBe(0);
  });
});

describe("autoPrestige rule rate", () => {
  it("fires on a falling run rate and not on the ratio", () => {
    const engine = new Engine();
    const state = stateOf({
      currencies: [currency("one", 100, { resetsOn: ["frag"] }), currency("if", 0, { earned: NR(0) })],
      prestiges: [prestige()],
      upgrades: [owner([{ kind: "autoPrestige", prestigeCode: "frag", rule: "rate" }])],
    });
    advancePrestigeRuns(engine, state, 60_000);
    runAutoPrestiges(engine, state);
    expect(N(state.currencies[1]!.amount).toNumber()).toBe(0); // rate at its peak

    state.currencies[0]!.amount = NR(110);
    advancePrestigeRuns(engine, state, 60_000); // 55/min < 95% of 100
    runAutoPrestiges(engine, state);
    expect(N(state.currencies[1]!.amount).toNumber()).toBe(110);
  });

  it("default rule still needs a ratio and behaves as before", () => {
    const engine = new Engine();
    const state = stateOf({
      currencies: [currency("one", 5, { resetsOn: ["frag"] }), currency("if", 0, { earned: NR(0) })],
      prestiges: [prestige()],
      upgrades: [owner([{ kind: "autoPrestige", prestigeCode: "frag", ratio: 2 }])],
    });
    runAutoPrestiges(engine, state);
    expect(N(state.currencies[1]!.amount).toNumber()).toBe(5);
  });

  it("a ratio-rule autoPrestige without ratio is ignored", () => {
    const engine = new Engine();
    const state = stateOf({
      currencies: [currency("one", 5), currency("if", 0, { earned: NR(0) })],
      prestiges: [prestige()],
      upgrades: [owner([{ kind: "autoPrestige", prestigeCode: "frag" }])],
    });
    runAutoPrestiges(engine, state);
    expect(N(state.currencies[1]!.amount).toNumber()).toBe(0);
  });
});

describe("autobuyUpgrades upgradeCodes", () => {
  it("buys only the listed upgrades, respecting unlock", () => {
    const engine = new Engine();
    const state = stateOf({
      currencies: [currency("one", 1000), currency("dd", 0, { earned: NR(0) })],
      upgrades: [
        owner([{ kind: "autobuyUpgrades", upgradeCodes: ["a", "locked"] }]),
        upgrade("a", { resetsOn: ["frag"] }),
        upgrade("b", { resetsOn: ["frag"] }),
        upgrade("locked", { resetsOn: ["frag"], unlock: { kind: "currency", code: "dd", field: "earned", gt: NR(0) } }),
      ],
    });
    runUpgradeAutobuyers(engine, state);
    expect(N(state.upgrades[1]!.bought).toNumber()).toBe(1);
    expect(N(state.upgrades[2]!.bought).toNumber()).toBe(0);
    expect(N(state.upgrades[3]!.bought).toNumber()).toBe(0);
  });
});

describe("keepLevels upgradeCodes and grantLevels", () => {
  const base = (behaviors: UpgradeBehavior[]): GameState =>
    stateOf({
      currencies: [currency("one", 10, { resetsOn: ["frag"] }), currency("if", 0, { earned: NR(0) })],
      prestiges: [prestige()],
      upgrades: [owner(behaviors), upgrade("a", { resetsOn: ["frag"], bought: NR(10), amount: NR(10) }), upgrade("b", { resetsOn: ["frag"], bought: NR(10), amount: NR(10) })],
    });

  it("keptLevelsFraction without a list is unchanged; with a list it applies only to the listed codes", () => {
    const plain = base([{ kind: "keepLevels", prestigeCode: "frag", fraction: 0.5 }]);
    expect(keptLevelsFraction(plain, "frag")).toBe(0.5);
    expect(keptLevelsFraction(plain, "frag", "b")).toBe(0.5);

    const listed = base([{ kind: "keepLevels", prestigeCode: "frag", fraction: 0.5, upgradeCodes: ["a"] }]);
    expect(keptLevelsFraction(listed, "frag", "a")).toBe(0.5);
    expect(keptLevelsFraction(listed, "frag", "b")).toBe(0);
  });

  it("restores the listed upgrade only after a prestige", () => {
    const engine = new Engine();
    const state = base([{ kind: "keepLevels", prestigeCode: "frag", fraction: 0.5, upgradeCodes: ["a"] }]);
    expect(engine.performPrestige(state, state.prestiges[0]!)).toBe(true);
    expect(N(state.upgrades[1]!.bought).toNumber()).toBe(5);
    expect(N(state.upgrades[2]!.bought).toNumber()).toBe(0);
  });

  it("grantLevels gives max(kept, levels)", () => {
    const engine = new Engine();
    const state = base([
      { kind: "keepLevels", prestigeCode: "frag", fraction: 0.2 },
      { kind: "grantLevels", prestigeCode: "frag", upgradeCode: "a", levels: 5 },
      { kind: "grantLevels", prestigeCode: "frag", upgradeCode: "b", levels: 1 },
    ]);
    expect(grantedLevels(state, "frag", "a")).toBe(5);
    // The announced levels (UI) are the levels the prestige leaves.
    expect(levelsAfterPrestige(state, "frag", state.upgrades[1]!).toNumber()).toBe(5);
    expect(levelsAfterPrestige(state, "frag", state.upgrades[2]!).toNumber()).toBe(2);
    expect(levelsAfterPrestige(state, "frag", state.upgrades[0]!).toNumber()).toBe(N(state.upgrades[0]!.bought).toNumber());
    engine.performPrestige(state, state.prestiges[0]!);
    expect(N(state.upgrades[1]!.bought).toNumber()).toBe(5); // kept 2 < 5
    expect(N(state.upgrades[1]!.amount).toNumber()).toBe(5);
    expect(N(state.upgrades[2]!.bought).toNumber()).toBe(2); // kept 2 > 1
  });

  it("grantLevels alone works without keepLevels, and skips upgrades the prestige does not reset", () => {
    const engine = new Engine();
    const state = base([{ kind: "grantLevels", prestigeCode: "frag", upgradeCode: "a", levels: 3 }]);
    state.upgrades[2]!.resetsOn = [];
    state.upgrades.push(owner([], {}));
    state.upgrades[state.upgrades.length - 1]!.code = "c";
    engine.performPrestige(state, state.prestiges[0]!);
    expect(N(state.upgrades[1]!.bought).toNumber()).toBe(3);
    expect(N(state.upgrades[2]!.bought).toNumber()).toBe(10);
  });
});

describe("dripMult", () => {
  it("multiplies the drip through the shared channel fold", () => {
    const engine = new Engine();
    const make = (withBoost: boolean): GameState =>
      stateOf({
        currencies: [currency("one", 100), currency("if", 0, { earned: NR(0) })],
        prestiges: [prestige()],
        upgrades: [
          owner([{ kind: "prestigeDrip", prestigeCode: "frag", ratePerSecond: 0.1 }]),
          upgrade("boost", { bought: NR(withBoost ? 2 : 0), effects: [{ stage: 0, target: { kind: "currency", code: "if", path: "dripMult" }, type: "mult", func: lin(1.5) }] }),
        ],
      });
    const plain = make(false);
    const boosted = make(true);
    applyPrestigeDrips(engine, plain, 1000);
    applyPrestigeDrips(engine, boosted, 1000);
    expect(N(plain.currencies[1]!.amount).toNumber()).toBeCloseTo(10, 8);
    expect(N(boosted.currencies[1]!.amount).toNumber()).toBeCloseTo(15, 8);
  });

  it("also folds another currency's own effects, driven by its amount", () => {
    const engine = new Engine();
    const effect = { stage: 0 as const, target: { kind: "currency" as const, code: "if", path: "dripMult" }, type: "mult", func: lin(1.5) };
    const state = stateOf({
      currencies: [currency("one", 100), currency("if", 0, { earned: NR(0) }), currency("time", 2, { effects: [effect] })],
      prestiges: [prestige()],
      upgrades: [owner([{ kind: "prestigeDrip", prestigeCode: "frag", ratePerSecond: 0.1 }])],
    });
    const expected = N(engine.growthValue(effect.func, NR(2))).toNumber();
    applyPrestigeDrips(engine, state, 1000);
    expect(N(state.currencies[1]!.amount).toNumber()).toBeCloseTo(10 * expected, 8);
  });
});

describe("Currency.effects", () => {
  it("folds a persistent effect driven by the currency amount, after upgrades", () => {
    const engine = new Engine();
    const target = { kind: "producer" as const, code: "e1", path: "produces.*.persec" };
    const state = stateOf({
      currencies: [
        currency("one", 0),
        currency("time", 16, { effects: [{ stage: 0, target, type: "mult", func: { base: NR(1), coeff: NR(0.5), func: ScalingMethod.Linear, scaleOn: ScaleOn.self } }] }),
      ],
      producers: [producer("e1", 1)],
    });
    // linear: base + coeff*x = 1 + 0.5*16 = 9
    const mods = collectModifiers(state, engine.services).get(state.producers[0]!.produces[0]!)!;
    expect(mods).toHaveLength(1);
    state.currencies[1]!.amount = NR(0);
    expect(collectModifiers(state, engine.services).size).toBe(0);
  });

  it("speeds production in a real tick", () => {
    const engine = new Engine();
    const make = (time: number): GameState =>
      stateOf({
        currencies: [
          currency("one", 0),
          currency("time", time, { effects: [{ stage: 0, target: { kind: "producer", code: "e1", path: "produces.*.persec" }, type: "mult", func: lin(3) }] }),
        ],
        producers: [producer("e1", 1)],
      });
    const slow = make(0);
    const fast = make(5);
    engine.advance(slow, 1000);
    engine.advance(fast, 1000);
    expect(N(fast.currencies[0]!.amount).toNumber()).toBeCloseTo(3 * N(slow.currencies[0]!.amount).toNumber(), 6);
  });
});

describe("resetsEarnedOn", () => {
  it("zeroes earned (and amount via resetsOn) when the prestige fires, leaving other currencies", () => {
    const engine = new Engine();
    const state = stateOf({
      currencies: [
        currency("one", 10, { resetsOn: ["frag"] }),
        currency("if", 0, { earned: NR(0) }),
        currency("dd", 5, { earned: NR(40), resetsEarnedOn: ["frag"] }),
        currency("keep", 5, { earned: NR(9) }),
      ],
      prestiges: [prestige()],
    });
    engine.performPrestige(state, state.prestiges[0]!);
    expect(N(state.currencies[2]!.earned ?? -1).toNumber()).toBe(0);
    expect(N(state.currencies[2]!.amount).toNumber()).toBe(5);
    expect(N(state.currencies[3]!.earned ?? -1).toNumber()).toBe(9);
  });
});
