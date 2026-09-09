// Reproducible benchmark of the engine, run with `pnpm --filter the-one-engine bench`.
// See bench/README.md for the scenario descriptions and for how to read the output.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GreedyBot } from "../src/balance";
import { runBalanceSim } from "../src/balance/harness";
import { TICK_MS_INTERVAL } from "../src/constants";
import { Engine } from "../src/core/engine";
import type { Currency, Producer } from "../src/models/base";
import { ScaleOn, ScalingMethod } from "../src/models/base";
import { N, NR } from "../src/nums";
import { type GameState, createInitialState } from "../src/state";
import { MockTimeProvider } from "../src/testing/MockTimeProvider";
import { makeScaleState } from "../src/testing/scale-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Cli {
  label: string;
  out?: string;
  baseline?: string;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { label: "run" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--label") cli.label = argv[++i] ?? cli.label;
    else if (arg === "--out") cli.out = argv[++i];
    else if (arg === "--baseline") cli.baseline = argv[++i];
  }
  return cli;
}

function gitShortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Measurement: a discarded warmup + 3 measured runs, median
// ---------------------------------------------------------------------------

interface ScenarioResult {
  iterations: number;
  medianMs: number;
  msPerIter: number;
  runsMs: number[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Runs a discarded warmup and 3 measured runs with performance.now(),
 * reporting the median. `warmup`/`run` build state and engine from scratch
 * on every call: no state is shared between the measured runs.
 */
function measure(warmup: () => void, run: () => number): ScenarioResult {
  warmup();

  const runsMs: number[] = [];
  let iterations = 0;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    iterations = run();
    const end = performance.now();
    runsMs.push(end - start);
  }

  const medianMs = median(runsMs);
  return { iterations, medianMs, msPerIter: medianMs / iterations, runsMs };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Runs `ticks` engine advances over a fresh scale state. Returns the number of ticks run. */
function runTicks(producers: number, currencies: number, upgrades: number, ticks: number, magnitude?: Parameters<typeof makeScaleState>[3]): number {
  const time = new MockTimeProvider(TICK_MS_INTERVAL);
  const engine = new Engine(TICK_MS_INTERVAL, { time });
  const state = makeScaleState(producers, currencies, upgrades, magnitude);

  for (let i = 0; i < ticks; i++) {
    time.advance(TICK_MS_INTERVAL);
    engine.tick(state);
  }
  return ticks;
}

interface GrowthCase {
  name: string;
  func: ScalingMethod;
  base: number;
  coeff: number;
}

const BUY_QUOTES_GROWTHS: GrowthCase[] = [
  { name: "linear", func: ScalingMethod.Linear, base: 10, coeff: 1.15 },
  { name: "geometric", func: ScalingMethod.Geometric, base: 10, coeff: 1.15 },
  { name: "exponential", func: ScalingMethod.Exponential, base: 1.5, coeff: 1.01 },
  { name: "double_exponential", func: ScalingMethod.DoubleExponential, base: 1.1, coeff: 1.001 },
];

const BUY_QUOTES_MAX_ITER_PER_GROWTH = 5000;

/**
 * For each growth function: builds a scaleOn=self producer and a currency
 * that starts at 1e3 and is multiplied by 1.5 on every iteration, calling
 * costToBuy (max) and costToBuyNext(10) on each step, until the currency
 * exceeds 1e300. A growth that exceeds the iteration cap is stopped and
 * reported. Returns the sum of the iterations over the 4 growth functions.
 */
function runBuyQuotes(): { iterations: number; warnings: string[] } {
  const engine = new Engine();
  const warnings: string[] = [];
  let totalIterations = 0;

  for (const growth of BUY_QUOTES_GROWTHS) {
    const producer: Producer = {
      code: `p_${growth.name}`,
      name: growth.name,
      currencyCode: "one",
      scaling: { base: NR(growth.base), coeff: NR(growth.coeff), func: growth.func, scaleOn: ScaleOn.self },
      bought: NR(0),
      amount: NR(0),
      produces: [],
      resetsOn: [],
    };

    const currency: Currency = { code: "one", name: "One", amount: NR(1e3), resetsOn: [] };

    let iterations = 0;
    try {
      while (N(currency.amount).lte("1e300")) {
        if (iterations >= BUY_QUOTES_MAX_ITER_PER_GROWTH) {
          warnings.push(`[buy-quotes] growth=${growth.name} stopped after ${BUY_QUOTES_MAX_ITER_PER_GROWTH} iterations (never exceeded 1e300)`);
          break;
        }
        engine.costToBuy(producer, currency);
        engine.costToBuyNext(producer, 10);
        currency.amount = NR(N(currency.amount).mul(1.5));
        iterations++;
      }
    } catch (err) {
      warnings.push(`[buy-quotes] growth=${growth.name} stopped by an error: ${String(err)}`);
    }
    totalIterations += iterations;
  }

  return { iterations: totalIterations, warnings };
}

/** Minimal state for the balance-sim scenario: 3 linear producers, 1 currency, no upgrades/prestiges. */
function makeBalanceSimState(): GameState {
  const linearScaling = (base: number, coeff: number) => ({ base: NR(base), coeff: NR(coeff), func: ScalingMethod.Linear, scaleOn: ScaleOn.self });
  const producer = (code: string, persec: number, costBase: number): Producer => ({
    code,
    name: code,
    currencyCode: "one",
    amount: NR(0),
    bought: NR(0),
    produces: [{ code: "one", persec: NR(persec) }],
    scaling: linearScaling(costBase, 0),
  });

  return {
    ...createInitialState(),
    producers: [producer("A", 1, 10), producer("B", 5, 100), producer("C", 25, 1000)],
    currencies: [{ code: "one", name: "One", primary: true, amount: NR(10), resetsOn: [] }],
  };
}

function runBalanceSimOnce(durationMs: number): number {
  runBalanceSim({ state: makeBalanceSimState(), bot: new GreedyBot(), params: { durationMs } });
  return 1;
}

// ---------------------------------------------------------------------------
// Running the scenarios + report
// ---------------------------------------------------------------------------

interface ScenarioReport extends ScenarioResult {
  iterPerSec: number;
}

function toReport(result: ScenarioResult): ScenarioReport {
  return { ...result, iterPerSec: result.iterations / (result.medianMs / 1000) };
}

function runScenarios(): { scenarios: Record<string, ScenarioReport>; warnings: string[] } {
  const warnings: string[] = [];
  const scenarios: Record<string, ScenarioReport> = {};

  const TICK_SCALE_TICKS = 2000;
  scenarios["tick-scale"] = toReport(
    measure(
      () => runTicks(100, 5, 50, Math.round(TICK_SCALE_TICKS * 0.1)),
      () => runTicks(100, 5, 50, TICK_SCALE_TICKS),
    ),
  );

  // Same scale scenario but at magnitudes typical of a late-game incremental
  // (1e50): here the numbers no longer fit a "safe" double, and no fast path
  // through plain Number is possible.
  const BIG = { amount: "1e50", persec: "1e48" };
  scenarios["tick-scale-big"] = toReport(
    measure(
      () => runTicks(100, 5, 50, Math.round(TICK_SCALE_TICKS * 0.1), BIG),
      () => runTicks(100, 5, 50, TICK_SCALE_TICKS, BIG),
    ),
  );

  const TICK_SMALL_TICKS = 20000;
  scenarios["tick-small"] = toReport(
    measure(
      () => runTicks(8, 2, 4, Math.round(TICK_SMALL_TICKS * 0.1)),
      () => runTicks(8, 2, 4, TICK_SMALL_TICKS),
    ),
  );

  // buy-quotes is deterministic and has no natural notion of "10% of the
  // iterations" (the step count is decided by the stopping condition, not
  // fixed up front): the warmup runs the scenario in full and discards the
  // result, as with the other dynamic-iteration scenarios.
  scenarios["buy-quotes"] = toReport(
    measure(
      () => void runBuyQuotes(),
      () => {
        const { iterations, warnings: w } = runBuyQuotes();
        warnings.push(...w);
        return iterations;
      },
    ),
  );

  const BALANCE_SIM_DURATION_MS = 30 * 60 * 1000;
  scenarios["balance-sim"] = toReport(
    measure(
      () => void runBalanceSimOnce(BALANCE_SIM_DURATION_MS / 10),
      () => runBalanceSimOnce(BALANCE_SIM_DURATION_MS),
    ),
  );

  return { scenarios, warnings };
}

// ---------------------------------------------------------------------------
// Output: stdout table + JSON
// ---------------------------------------------------------------------------

interface BaselineFile {
  scenarios: Record<string, { medianMs: number }>;
}

function loadBaseline(path: string): BaselineFile | undefined {
  if (!existsSync(path)) {
    console.warn(`[bench] baseline not found: ${path}`);
    return undefined;
  }
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as BaselineFile;
}

function printTable(scenarios: Record<string, ScenarioReport>, baseline?: BaselineFile): void {
  const headers = ["scenario", "iterations", "median ms", "ms/iter", "iter/s"];
  if (baseline) headers.push("delta % vs baseline");

  const rows = Object.entries(scenarios).map(([name, r]) => {
    const row = [name, String(r.iterations), r.medianMs.toFixed(2), r.msPerIter.toFixed(4), r.iterPerSec.toFixed(1)];
    if (baseline) {
      const base = baseline.scenarios[name];
      if (base) {
        const delta = ((r.medianMs - base.medianMs) / base.medianMs) * 100;
        row.push(`${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`);
      } else {
        row.push("n/a");
      }
    }
    return row;
  });

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const formatRow = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ");

  console.log(formatRow(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  for (const row of rows) console.log(formatRow(row));
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const baseline = cli.baseline ? loadBaseline(cli.baseline) : undefined;

  const { scenarios, warnings } = runScenarios();

  for (const w of warnings) console.warn(w);
  printTable(scenarios, baseline);

  if (cli.out) {
    const outPath = resolve(cli.out);
    mkdirSync(dirname(outPath), { recursive: true });
    mkdirSync(resolve(__dirname, "results"), { recursive: true });

    const jsonScenarios: Record<string, { iterations: number; medianMs: number; msPerIter: number; runsMs: number[] }> = {};
    for (const [name, r] of Object.entries(scenarios)) {
      jsonScenarios[name] = { iterations: r.iterations, medianMs: r.medianMs, msPerIter: r.msPerIter, runsMs: r.runsMs };
    }

    const output = {
      date: new Date().toISOString(),
      node: process.version,
      label: cli.label,
      git: gitShortSha(),
      scenarios: jsonScenarios,
    };

    writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
    console.log(`\n[bench] results written to ${outPath}`);
  }
}

main();
