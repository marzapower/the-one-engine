# Engine benchmark

Measures the engine's performance, reproducible before and after a change (e.g. swapping the number library it computes with).

## Scenarios

- **tick-scale**: 2000 ticks over a "scale" state (100 producers, 5 currencies, 50 upgrades) — the cost of `Engine.tick` with many effects and targets.
- **tick-scale-big**: same as tick-scale but with amount 1e50 and persec 1e48 — the regime of a late-game incremental, where the numbers no longer fit a safe double and no fast path through `Number` is possible.
- **tick-small**: 20000 ticks over a small state (8 producers, 2 currencies, 4 upgrades) — per-tick overhead at the same useful work, isolated from scale.
- **buy-quotes**: for each of the 4 growth functions (linear, geometric, exponential, double_exponential), repeatedly calls `costToBuy`/`costToBuyNext` while the currency grows past 1e300 — the cost of the pricing formulas at increasing numeric scale.
- **balance-sim**: one `runBalanceSim` run (greedy bot, 30 simulated minutes) over a minimal state — the end-to-end cost of the balance harness.

Each scenario runs a discarded warmup and then 3 measured runs with `performance.now()`; the median is reported.

## Usage

```sh
pnpm --filter the-one-engine bench -- --label <label> --out bench/results/<date>-<label>.json
```

To compare against a previous run:

```sh
pnpm --filter the-one-engine bench -- --label <label> --out bench/results/<new-file>.json --baseline bench/results/<old-file>.json
```

`--label` (default `"run"`) and `--out` are optional; without `--out` the result only goes to stdout.

## Reading the delta

With `--baseline`, every row of the table reports `delta % = (current median − baseline median) / baseline median × 100`: negative means faster, positive means slower.

## Results

`bench/results/` holds committed runs as historical data, including the baseline from before and after the engine switched its number library.
