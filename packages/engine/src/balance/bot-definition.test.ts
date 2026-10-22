import { describe, expect, it } from "vitest";

import { NR } from "../nums";
import type { GameState } from "../state";
import { botFromDefinition, parseBotDefinition, phaseConditionHolds, resolveBotOptions } from "./bot-definition";
import type { BotDefinition } from "./bot-definition";
import { GREEDY_DEFAULTS } from "./greedy-bot";

const stateWith = (currencies: { code: string; amount: unknown; earned?: unknown }[]): GameState => ({ currencies }) as unknown as GameState;

describe("parseBotDefinition", () => {
  it("rejects unknown policies and missing meta", () => {
    expect(() => parseBotDefinition({ meta: { id: "x", version: 1 }, policy: "alpha-zero" })).toThrow(/unknown policy/);
    expect(() => parseBotDefinition({ policy: "greedy" })).toThrow(/meta.id/);
    expect(() =>
      parseBotDefinition({
        meta: { id: "x", version: 1 },
        policy: "greedy",
        phases: [{ when: { currencies: [{ atLeast: 3 }] }, options: {} }],
      }),
    ).toThrow(/code \+ atLeast/);
  });
});

describe("phaseConditionHolds", () => {
  const state = stateWith([{ code: "gold", amount: NR(50), earned: NR(80) }]);

  it("checks elapsed time and currency thresholds (amount and earned)", () => {
    expect(phaseConditionHolds({ minElapsedMs: 1000 }, state, 999)).toBe(false);
    expect(phaseConditionHolds({ minElapsedMs: 1000 }, state, 1000)).toBe(true);

    expect(phaseConditionHolds({ currencies: [{ code: "gold", atLeast: 50 }] }, state, 0)).toBe(true);
    expect(phaseConditionHolds({ currencies: [{ code: "gold", atLeast: 51 }] }, state, 0)).toBe(false);
    expect(phaseConditionHolds({ currencies: [{ code: "gold", field: "earned", atLeast: 80 }] }, state, 0)).toBe(true);
    expect(phaseConditionHolds({ currencies: [{ code: "missing", atLeast: 1 }] }, state, 0)).toBe(false);
  });
});

describe("resolveBotOptions", () => {
  const def: BotDefinition = {
    meta: { id: "phased", name: "Phased", version: 1 },
    policy: "greedy",
    options: { prestigeRatio: 2 },
    phases: [
      { when: { minElapsedMs: 3_600_000 }, options: { prestigeRatio: 3 } },
      { when: { currencies: [{ code: "gold", atLeast: 100 }] }, options: { horizonMs: 60_000 } },
    ],
  };

  it("layers defaults, base options and the currently-holding phases in order", () => {
    const poor = stateWith([{ code: "gold", amount: NR(0) }]);
    const rich = stateWith([{ code: "gold", amount: NR(100) }]);

    expect(resolveBotOptions(def, poor, 0)).toEqual({ ...GREEDY_DEFAULTS, prestigeRatio: 2 });
    expect(resolveBotOptions(def, poor, 3_600_000).prestigeRatio).toBe(3);
    expect(resolveBotOptions(def, rich, 0).horizonMs).toBe(60_000);
    // Conditions are re-evaluated: dropping below the threshold deactivates the phase.
    expect(resolveBotOptions(def, poor, 0).horizonMs).toBe(GREEDY_DEFAULTS.horizonMs);
  });
});

describe("botFromDefinition", () => {
  it("builds a BotPolicy whose id is the definition id", () => {
    const bot = botFromDefinition({ meta: { id: "my-bot", name: "My bot", version: 1 }, policy: "greedy" });
    expect(bot.id).toBe("my-bot");
  });
});

describe("new profile options in definitions", () => {
  const meta = { id: "expert", version: 1 };

  it("accepts prestigeRules, shopPriority, crumbFraction and ignoreUnownedTargets, in options and phases", () => {
    const options = {
      prestigeRules: { fragmentation: "rate", compression: { minGain: 1 } },
      shopPriority: ["upgrade:a", "producer:t0"],
      crumbFraction: 0.2,
      ignoreUnownedTargets: true,
    };
    const def = parseBotDefinition({ meta, policy: "greedy", options, phases: [{ when: {}, options: { shopPriority: null } }] });
    expect(def.options).toEqual(options);
    expect(() => botFromDefinition(def)).not.toThrow();
  });

  it("rejects malformed new options", () => {
    const parse = (options: unknown) => parseBotDefinition({ meta, policy: "greedy", options });
    expect(() => parse({ prestigeRules: { x: "sometimes" } })).toThrow(/prestigeRules/);
    expect(() => parse({ prestigeRules: { x: { minGain: -1 } } })).toThrow(/prestigeRules/);
    expect(() => parse({ shopPriority: ["nope"] })).toThrow(/shopPriority/);
    expect(() => parse({ crumbFraction: -0.1 })).toThrow(/crumbFraction/);
    expect(() => parseBotDefinition({ meta, policy: "greedy", phases: [{ when: {}, options: { crumbFraction: Number.NaN } }] })).toThrow(/crumbFraction/);
  });

  it("GREEDY_DEFAULTS carries the neutral values of the new options", () => {
    expect(GREEDY_DEFAULTS.prestigeRules).toEqual({});
    expect(GREEDY_DEFAULTS.shopPriority).toBeNull();
    expect(GREEDY_DEFAULTS.crumbFraction).toBe(0.1);
    expect(GREEDY_DEFAULTS.ignoreUnownedTargets).toBe(false);
  });
});
