import { describe, expect, it } from "vitest";

import { Decimal, N, NR, type Numerus, print, printF } from "./nums";

describe("print / printF", () => {
  const cases: Array<{ input: number | string; print: string; printF: string; printF3: string; print3: string }> = [
    { input: 0, print: "0", printF: "0.00", printF3: "0.000", print3: "0" },
    { input: 1, print: "1", printF: "1.00", printF3: "1.000", print3: "1" },
    { input: 12.345, print: "12", printF: "12.34", printF3: "12.345", print3: "12" },
    { input: 999.999, print: "1,000", printF: "1,000.00", printF3: "999.999", print3: "1,000" },
    { input: 1234.5, print: "1,235", printF: "1,234.50", printF3: "1,234.500", print3: "1.23e3" },
    { input: 1234567.891, print: "1.23e6", printF: "1.23e6", printF3: "1.235e6", print3: "1.23e6" },
    { input: 9007199254740991, print: "9.01e15", printF: "9.01e15", printF3: "9.007e15", print3: "9.01e15" },
    { input: 1e16, print: "1.00e16", printF: "1.00e16", printF3: "1.000e16", print3: "1.00e16" },
    { input: 1.5e20, print: "1.50e20", printF: "1.50e20", printF3: "1.500e20", print3: "1.50e20" },
    { input: "1e100", print: "1.00e100", printF: "1.00e100", printF3: "1.000e100", print3: "1.00e100" },
    { input: "1e1000", print: "1.00e1,000", printF: "1.00e1,000", printF3: "1.000e1,000", print3: "1.00e1,000" },
    { input: "1.5e1000000", print: "e1.00e6", printF: "e1.00e6", printF3: "e1.000e6", print3: "e1.00e6" },
    { input: "1e1e20", print: "e1.00e20", printF: "e1.00e20", printF3: "e1.000e20", print3: "e1.00e20" },
    { input: "1e1e1e10", print: "eee10.00", printF: "eee10.00", printF3: "eee10.000", print3: "eee10.00" },
    { input: "10^^10", print: "(10^)^9 10.00", printF: "(10^)^9 10.00", printF3: "(10^)^9 10.000", print3: "(10^)^9 10.00" },
    { input: -5, print: "-5", printF: "-5.00", printF3: "-5.000", print3: "-5" },
    { input: -1.5e20, print: "-1.50e20", printF: "-1.50e20", printF3: "-1.500e20", print3: "-1.50e20" },
    { input: NaN, print: "NaN", printF: "NaN", printF3: "NaN", print3: "NaN" },
    { input: Infinity, print: "Infinity", printF: "Infinity", printF3: "Infinity", print3: "Infinity" },
    // layer >= 1 with mag < 0 -> formatted as layer 0.
    { input: 1e-20, print: "0", printF: "0.00", printF3: "0.000", print3: "0" },
    { input: -1e-20, print: "-0", printF: "-0.00", printF3: "-0.000", print3: "-0" },
    { input: 0.5, print: "1", printF: "0.50", printF3: "0.500", print3: "1" },
    { input: -0.5, print: "-1", printF: "-0.50", printF3: "-0.500", print3: "-1" },
    { input: 0.00001, print: "0", printF: "0.00", printF3: "0.000", print3: "0" },
    { input: 0.004, print: "0", printF: "0.00", printF3: "0.004", print3: "0" },
    { input: 0.006, print: "0", printF: "0.01", printF3: "0.006", print3: "0" },
  ];

  for (const c of cases) {
    it(`print(${JSON.stringify(c.input)})`, () => {
      expect(print(c.input)).toBe(c.print);
      expect(printF(c.input)).toBe(c.printF);
      expect(printF(c.input, { decimals: 3 })).toBe(c.printF3);
      expect(print(c.input, { precision: 3 })).toBe(c.print3);
    });
  }

  it("undefined is treated as 0", () => {
    expect(print(undefined)).toBe("0");
    expect(printF(undefined)).toBe("0.00");
  });
});

describe("N", () => {
  it("Decimal -> same instance", () => {
    const d = new Decimal(42);
    expect(N(d)).toBe(d);
  });

  it("number -> Decimal.fromNumber", () => {
    expect(N(42).toNumber()).toBe(42);
  });

  it("string -> Decimal.fromString", () => {
    expect(N("42").toNumber()).toBe(42);
    expect(N("10^^10").layer).toBe(8);
  });

  it("raw Numerus -> Decimal.fromComponents", () => {
    const raw: Numerus = { sign: 1, layer: 0, mag: 42 };
    expect(N(raw).toNumber()).toBe(42);
  });

  it("valid zeros do not throw", () => {
    expect(N("0").toNumber()).toBe(0);
    expect(N("0.0e5").toNumber()).toBe(0);
    expect(N(0).toNumber()).toBe(0);
  });

  it("NaN remains allowed", () => {
    expect(N(NaN).isNan()).toBe(true);
    expect(N("NaN").isNan()).toBe(true);
  });

  it.each([[undefined], [null], [[1, 1, 1]], [{ sign: 1, array: [5] }], ["abc"], [{}], [""], ["   "], ["+"], ["-"], ["."]])("throws TypeError on invalid input: %o", (input) => {
    expect(() => N(input as never)).toThrow(TypeError);
  });

  it("explicit message for the legacy {sign, array} format", () => {
    expect(() => N({ sign: 1, array: [5] } as never)).toThrow(/Legacy Numerus format/);
  });
});

describe("NR", () => {
  it("returns a flat object with Object prototype", () => {
    const raw = NR(42);
    expect(Object.getPrototypeOf(raw)).toBe(Object.prototype);
    expect(raw).toStrictEqual({ sign: 1, layer: 0, mag: 42 });
  });

  it("JSON.stringify produces {sign, layer, mag}", () => {
    expect(JSON.parse(JSON.stringify(NR(42)))).toStrictEqual({ sign: 1, layer: 0, mag: 42 });
  });

  it("round-trip N(NR(x)) preserves the value", () => {
    const x = "1e1000";
    expect(N(JSON.parse(JSON.stringify(NR(x)))).eq(N(x))).toBe(true);
  });

  it("round-trip over number/string/raw/Decimal", () => {
    expect(N(NR(100)).eq(100)).toBe(true);
    expect(N(NR("1e50")).eq(N("1e50"))).toBe(true);
    const d = new Decimal(7);
    expect(N(NR(d)).eq(d)).toBe(true);
  });
});
