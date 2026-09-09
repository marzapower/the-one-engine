import { NR } from "../../nums";
import type { Currency, Producer, Upgrade } from "./";
import { ScaleOn, ScalingMethod } from "./";

/** Builds entities with sensible defaults, for tests and quick prototyping. */
export class Factory {
  static buildCurrency(currency: Partial<Currency>): Currency {
    return {
      code: "currency",
      name: "Currency",
      amount: NR(0),
      ...currency,
    };
  }

  static buildProducer(producer: Partial<Producer>): Producer {
    return {
      code: "producer",
      name: "Producer",
      currencyCode: "currency",
      amount: NR(0),
      bought: NR(0),
      produces: [],
      scaling: producer.scaling ?? {
        base: NR(10),
        coeff: NR(1.2),
        scaleOn: ScaleOn.self,
        func: ScalingMethod.Linear,
      },
      ...producer,
    };
  }

  static buildUpgrade(upgrade: Partial<Upgrade>): Upgrade {
    return {
      code: "upgrade",
      name: "Upgrade",
      currencyCode: "currency",
      amount: NR(0),
      bought: NR(0),
      effects: [],
      scaling: upgrade.scaling ?? {
        base: NR(10),
        coeff: NR(1.2),
        scaleOn: ScaleOn.self,
        func: ScalingMethod.Linear,
      },
      ...upgrade,
    };
  }
}
