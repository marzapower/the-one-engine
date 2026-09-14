import { describe, expect, it } from "vitest";

import type { Currency, Prestige, Producer, Upgrade } from "../models/base";
import { NR } from "../nums";
import { MIN_CLICK_COOLDOWN_MS, parseGameDefinition, resolveClickable } from "./definition";
import type { GameDefinition } from "./definition";

function baseDefinition(overrides: Partial<GameDefinition> = {}): GameDefinition {
  const primary: Currency = { code: "gold", name: "Gold", primary: true, amount: NR(0) };
  const producers: Producer[] = [];
  const prestiges: Prestige[] = [];
  const upgrades: Upgrade[] = [];

  return {
    meta: { id: "test", name: "Test", version: 1 },
    producers,
    currencies: [primary],
    prestiges,
    upgrades,
    ...overrides,
  };
}

describe("resolveClickable", () => {
  it("defaults to the primary currency, +1 gain and a 1000ms cooldown", () => {
    const def = baseDefinition();
    expect(resolveClickable(def)).toEqual({ currencyCode: "gold", gain: 1, cooldownMs: 1000 });
  });

  it("honors an explicit currency, gain and cooldown", () => {
    const other: Currency = { code: "gems", name: "Gems", amount: NR(0) };
    const def = baseDefinition({
      currencies: [{ code: "gold", name: "Gold", primary: true, amount: NR(0) }, other],
      clickable: { currencyCode: "gems", gain: 5, cooldownMs: 2500 },
    });

    expect(resolveClickable(def)).toEqual({ currencyCode: "gems", gain: 5, cooldownMs: 2500 });
  });

  it("is undefined when the definition has no primary currency", () => {
    const def = baseDefinition({ currencies: [{ code: "gold", name: "Gold", amount: NR(0) }] });
    expect(resolveClickable(def)).toBeUndefined();
  });

  it("is undefined when clickable.currencyCode names a currency the definition does not carry", () => {
    const def = baseDefinition({ clickable: { currencyCode: "unknown" } });
    expect(resolveClickable(def)).toBeUndefined();
  });
});

describe("parseGameDefinition — clickable", () => {
  it("accepts a definition without clickable, and one with every field valid", () => {
    expect(() => parseGameDefinition(baseDefinition())).not.toThrow();
    expect(() => parseGameDefinition(baseDefinition({ clickable: { currencyCode: "gold", gain: 2, cooldownMs: 500 } }))).not.toThrow();
  });

  it("rejects an unknown clickable.currencyCode", () => {
    expect(() => parseGameDefinition(baseDefinition({ clickable: { currencyCode: "unknown" } }))).toThrow(/clickable.currencyCode/);
  });

  it("rejects a non-positive gain", () => {
    expect(() => parseGameDefinition(baseDefinition({ clickable: { gain: 0 } }))).toThrow(/clickable.gain/);
    expect(() => parseGameDefinition(baseDefinition({ clickable: { gain: -1 } }))).toThrow(/clickable.gain/);
    expect(() => parseGameDefinition(baseDefinition({ clickable: { gain: Number.POSITIVE_INFINITY } }))).toThrow(/clickable.gain/);
  });

  it("rejects a cooldown below MIN_CLICK_COOLDOWN_MS", () => {
    expect(() => parseGameDefinition(baseDefinition({ clickable: { cooldownMs: MIN_CLICK_COOLDOWN_MS - 1 } }))).toThrow(/clickable.cooldownMs/);
    expect(() => parseGameDefinition(baseDefinition({ clickable: { cooldownMs: MIN_CLICK_COOLDOWN_MS } }))).not.toThrow();
  });
});
