import { type Currency, type Producer, ScaleOn, ScalingMethod, type Upgrade } from "../models/base";
import { type GenericNumberInput, NR } from "../nums";
import { type GameState, createInitialState } from "../state";

/**
 * Scale fixture for tests and benchmarks: builds a state with N producers, M
 * currencies and K upgrades (30 of them on `produces.*.persec`, the rest on
 * `amount`). `magnitude` sets the starting order of magnitude (producer
 * amount and per-second output): the defaults match a small game; a
 * benchmark can also ask for magnitudes typical of a late-game incremental
 * (e.g. 1e50).
 */
export function makeScaleState(
  producers = 100,
  currencies = 5,
  upgrades = 50,
  magnitude: { amount: GenericNumberInput; persec: GenericNumberInput } = { amount: 100, persec: 1 },
): GameState {
  const cs: Currency[] = Array.from({ length: currencies }, (_, i) => ({ code: `c${i}`, name: `C${i}`, amount: NR(0), resetsOn: [] }));
  const ps: Producer[] = Array.from({ length: producers }, (_, i) => ({
    code: `p${i}`,
    name: `P${i}`,
    sub: "scale",
    amount: NR(magnitude.amount),
    bought: NR(100),
    currencyCode: cs[i % currencies]!.code,
    scaling: { base: NR(10), coeff: NR(1.1), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
    produces: [{ code: cs[i % currencies]!.code, persec: NR(magnitude.persec) }],
    priority: 0,
    resetsOn: [],
  }));

  const ups: Upgrade[] = [];
  // First 30 upgrades: mult on produces.*.persec of p0..p29 (stage 0).
  for (let i = 0; i < Math.min(30, upgrades); i++) {
    ups.push({
      code: `u_persec_${i}`,
      name: `Upersec${i}`,
      desc: "mult persec",
      currencyCode: cs[i % currencies]!.code,
      scaling: { base: NR(1), coeff: NR(0), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
      amount: NR(1),
      bought: NR(1),
      effects: [
        {
          stage: 0,
          target: { kind: "producer", code: `p${i}`, path: "produces.*.persec" },
          type: "mult",
          func: { base: NR(1), coeff: NR(0.05), func: ScalingMethod.Linear, scaleOn: ScaleOn.self }, // +5%
        },
      ],
      resetsOn: [],
    });
  }
  // Remaining upgrades up to 50: mult on amount of p30..p49 (stage 2).
  for (let i = 30; i < Math.min(50, upgrades); i++) {
    ups.push({
      code: `u_amount_${i}`,
      name: `Uamount${i}`,
      desc: "mult amount",
      currencyCode: cs[i % currencies]!.code,
      scaling: { base: NR(1), coeff: NR(0), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
      amount: NR(1),
      bought: NR(1),
      effects: [
        {
          stage: 2,
          target: { kind: "producer", code: `p${i}`, path: "amount" },
          type: "mult",
          func: { base: NR(1), coeff: NR(0.01), func: ScalingMethod.Linear, scaleOn: ScaleOn.self }, // +1%
        },
      ],
      resetsOn: [],
    });
  }

  return {
    ...createInitialState(),
    producers: ps,
    currencies: cs,
    upgrades: ups,
  };
}
