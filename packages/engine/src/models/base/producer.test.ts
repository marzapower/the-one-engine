import { describe, expect, it } from "vitest";

import { computeGrowthFunction } from "../../core/growth";
import { GrowthRegistry } from "../../core/registries/growth";
import { N, NR } from "../../nums";
import { ScaleOn, ScalingMethod } from "./common";
import { type Producer } from "./producer";

const growths = new GrowthRegistry();

describe("Producer", () => {
  describe("with quadratic scaling", () => {
    it("has the right growth", () => {
      const producer: Producer = {
        name: "producer",
        bought: NR(0),
        amount: NR(0),
        code: "code",
        currencyCode: "cc",
        produces: [{ code: "code", persec: NR(10) }],
        scaling: {
          base: NR(10),
          coeff: NR(1.2),
          scaleOn: ScaleOn.self,
          func: ScalingMethod.Geometric,
        },
      };

      expect(NR(computeGrowthFunction(producer.scaling, producer.amount, growths))).toStrictEqual(NR(10));

      producer.amount = NR(1);
      expect(NR(computeGrowthFunction(producer.scaling, producer.amount, growths))).toStrictEqual(NR(12));

      producer.amount = NR(2);
      expect(NR(computeGrowthFunction(producer.scaling, producer.amount, growths))).toStrictEqual(NR(12 * 1.2));

      producer.amount = NR(3);
      expect(NR(computeGrowthFunction(producer.scaling, producer.amount, growths))).toStrictEqual(NR(12 * 1.2 * 1.2));

      producer.amount = NR(10);
      // Relative tolerance 1e-9: floating-point noise on the last digit, same mathematical value.
      expect(
        N(computeGrowthFunction(producer.scaling, producer.amount, growths))
          .sub(10 * 1.2 ** 10)
          .abs()
          .lte(1e-9),
      ).toBe(true);
    });
  });
});
