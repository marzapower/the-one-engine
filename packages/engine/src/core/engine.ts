import { MAX_CATCHUP_MS_PER_TICK, MAX_OFFLINE_MS, MOVING_AVG_WINDOW, TICK_MS_INTERVAL } from "../constants";
import type { Buyable, Currency, Effect, GrowthFunction, Prestige, Producer, Unlock, Upgrade } from "../models/base";
import { Decimal, type GenericNumberInput, N, NR, type Numerus } from "../nums";
import { type GameState, type StageMetrics } from "../state";
import { applyPrestigeDrips, levelsAfterPrestige, runAutoPrestiges, runUpgradeAutobuyers } from "./behaviors";
import { DefaultEffectResolver, DefaultEntityRegistry, DefaultStateAdapter, DefaultTimeProvider, consoleLogger } from "./di/defaults";
import type { EffectResolver, EngineDependencies, EngineServices, Logger, TimeProvider } from "./di/types";
import { computeGrowthFunction } from "./growth";
import { type Modifier, applyModifiers, collectModifiers, isTransientTargetPath } from "./modifiers";
import { type OfflineReport, offlineTickLength } from "./offline";
import { deliveredPrestigeGain, prestigeDrive, prestigeGainMultiplier } from "./prestige-gain";
import { advancePrestigeRuns, reinitPrestigeRuns } from "./prestige-run";
import { type CostLine, costLinesToBuyNext, costToBuy, costToBuyNext, maxBuyableAcrossPools, maxBuyableAmount } from "./pricing";
import { type PurchaseBlock, buyProducer, buyUpgrade, costShortfalls, findCostPool, isUnlocked, producerPurchaseBlock, upgradePurchaseBlock } from "./purchase";
import { EffectRegistry } from "./registries/effect";
import { GrowthRegistry } from "./registries/growth";
import { StageRegistry } from "./registries/stage";
import { capacityPush, dragFactor as computeDragFactor, supportRatio as computeSupportRatio, coolingDelta } from "./saturation";
import { validateBootstrap } from "./validation";

/** Outcome of `Engine.tick`: game ms played this call, and backlog still owed. */
export type TickResult = { processedMs: number; pendingMs: number };

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a finite number > 0, got ${value}`);
}

/**
 * The engine facade: owns the per-instance registries, the tick pipeline and
 * every pure-math helper a host needs (pricing, prestige gain, saturation).
 * Nothing here is keyed on a producer/currency/upgrade code — every mechanic
 * reads its parameters from the state (`GameRules`, `ProducerCapacity`,
 * `UpgradeBehavior`) and the registries.
 */
export class Engine {
  readonly growths: GrowthRegistry;
  readonly effectTypes: EffectRegistry;
  readonly stages: StageRegistry;
  readonly logger: Logger;
  readonly services: EngineServices;
  /** URLs of plugins already loaded into this engine. */
  readonly plugins: Set<string> = new Set();

  private tickLength: number;
  private readonly time: TimeProvider;
  private readonly effects: EffectResolver;
  private readonly onPrestigeHook?: (state: GameState, prestige: Prestige) => void;
  private validated = false;

  constructor(tickLength = TICK_MS_INTERVAL, deps?: EngineDependencies) {
    assertPositiveFinite(tickLength, "tickLength");
    this.tickLength = tickLength;
    this.time = deps?.time ?? new DefaultTimeProvider(tickLength);
    this.logger = deps?.logger ?? consoleLogger;
    this.growths = deps?.growths ?? new GrowthRegistry();
    this.effectTypes = deps?.effectTypes ?? new EffectRegistry();
    this.stages = deps?.stages ?? new StageRegistry();
    this.effects = deps?.effects ?? new DefaultEffectResolver();
    this.onPrestigeHook = deps?.onPrestige;

    const registry = deps?.registry ?? new DefaultEntityRegistry();
    const adapter = deps?.state ?? new DefaultStateAdapter(registry);
    adapter.setRegistry(registry);

    this.services = { adapter, registry, growths: this.growths, effectTypes: this.effectTypes, logger: this.logger };
  }

  public setTickLength(ms: number): void {
    assertPositiveFinite(ms, "tickLength");
    this.tickLength = ms;
    this.time.setTickLength(ms);
  }

  /**
   * Plays the backlog `now - lastTick` in fixed steps of `tickLength`, so the
   * simulation never sees a variable step. At most `budgetMs` of game time is
   * played per call (default `MAX_CATCHUP_MS_PER_TICK`); the remainder stays
   * pending in `lastTick` and is reported as `pendingMs`. A sub-step residue
   * also stays pending. If `tickLength > budgetMs`, one step runs per call.
   * Does nothing while the clock is paused. With `lastTick` undefined it plays
   * one step and starts the clock.
   */
  public tick(state: GameState, options?: { budgetMs?: number }): TickResult {
    if (state.pausedAt !== undefined) return { processedMs: 0, pendingMs: 0 };
    this.ensureValidated(state);

    const budgetMs = options?.budgetMs ?? MAX_CATCHUP_MS_PER_TICK;
    assertPositiveFinite(budgetMs, "budgetMs");

    const step = this.tickLength;
    const now = this.time.now();

    if (state.lastTick === undefined) {
      this.singleTick(state, step);
      state.lastTick = now;
      return { processedMs: step, pendingMs: 0 };
    }

    const backlog = now - state.lastTick;
    if (backlog < 0) {
      state.lastTick = now;
      state.stats.fastSkippedFrames++;
      return { processedMs: 0, pendingMs: 0 };
    }

    const due = Math.floor(backlog / step + 1e-6);
    if (due === 0) {
      state.stats.fastSkippedFrames++;
      return { processedMs: 0, pendingMs: backlog };
    }

    const budget = Math.max(1, Math.floor(budgetMs / step + 1e-6));
    const steps = Math.min(due, budget);
    if (due > budget) state.stats.slowSkippedFrames++;

    for (let i = 0; i < steps; i++) this.singleTick(state, step);
    state.lastTick += steps * step;

    const diff = this.time.now() - now;
    state.stats.totalTime += diff;
    state.stats.avgTime = state.stats.totalTime / state.stats.ticks;
    state.stats.minTime = Math.min(state.stats.minTime, diff / steps);
    state.stats.maxTime = Math.max(state.stats.maxTime, diff / steps);

    return { processedMs: steps * step, pendingMs: Math.max(0, now - state.lastTick) };
  }

  /** Game time owed to the simulation: `now - lastTick`. 0 when the clock is not started or paused; never negative. */
  public backlogMs(state: GameState): number {
    if (state.lastTick === undefined || state.pausedAt !== undefined) return 0;
    return Math.max(0, this.time.now() - state.lastTick);
  }

  /** Freezes the clock: `tick()` and `simulateOffline()` do nothing until `resumeClock`. No-op if already paused. */
  public pauseClock(state: GameState): void {
    if (state.pausedAt === undefined) state.pausedAt = this.time.now();
  }

  /** Unfreezes the clock, shifting `lastTick` by the paused time so the pause creates no backlog. No-op if not paused. */
  public resumeClock(state: GameState): void {
    if (state.pausedAt === undefined) return;
    if (state.lastTick !== undefined) state.lastTick += this.time.now() - state.pausedAt;
    state.pausedAt = undefined;
  }

  /** Drops up to `ms` of backlog without simulating it. Returns the ms dropped; 0 when paused or the clock is not started. */
  public consumeBacklog(state: GameState, ms: number): number {
    if (!Number.isFinite(ms)) throw new RangeError(`ms must be a finite number, got ${ms}`);
    if (state.lastTick === undefined || state.pausedAt !== undefined) return 0;
    const consumed = Math.min(Math.max(ms, 0), this.backlogMs(state));
    state.lastTick += consumed;
    return consumed;
  }

  /**
   * Headless: advances the simulation by `totalMs`, running
   * `floor(totalMs / tickLength)` ticks deterministically against the
   * injected `TimeProvider` rather than the wall clock.
   */
  public advance(state: GameState, totalMs: number): void {
    this.ensureValidated(state);
    const step = this.tickLength;
    const ticksToRun = Math.floor(totalMs / step);
    for (let i = 0; i < ticksToRun; i++) {
      this.time.advance?.(step);
      this.singleTick(state, step);
      state.lastTick = this.time.now();
    }
  }

  /**
   * Simulates offline progression with an adaptive coarse-tick strategy (see
   * `OfflineReport`). Requires a deterministic `TimeProvider` for accurate
   * timing; with the default wall-clock provider, state progression is
   * best-effort. Does nothing (zero report) while the clock is paused.
   * `tickLengthMs` overrides the step (default `offlineTickLength`);
   * `preserveClock` restores `state.lastTick` afterwards, so real time elapsed
   * meanwhile stays pending.
   */
  public simulateOffline(state: GameState, elapsedMs: number, options?: { tickLengthMs?: number; preserveClock?: boolean }): OfflineReport {
    const startedAt = this.time.now();

    const durationCapped = elapsedMs >= MAX_OFFLINE_MS;
    const requestedMs = Math.min(elapsedMs, MAX_OFFLINE_MS);
    const tickLengthUsed = options?.tickLengthMs ?? offlineTickLength(requestedMs);
    assertPositiveFinite(tickLengthUsed, "tickLengthMs");

    if (state.pausedAt !== undefined) {
      return { durationMs: 0, durationRequestedMs: elapsedMs, durationCapped: false, tickLengthUsed, ticksRun: 0, deltaCurrencies: {}, startedAt, finishedAt: this.time.now() };
    }
    const durationMs = requestedMs;

    const initialCurrencies: Record<string, Numerus> = {};
    const currencies = this.services.adapter.getCurrencies(state);
    for (const curr of currencies) {
      initialCurrencies[curr.code] = NR(curr.amount);
    }

    const originalTickLength = this.tickLength;
    const originalLastTick = state.lastTick;
    this.setTickLength(tickLengthUsed);
    try {
      this.advance(state, durationMs);
    } finally {
      this.setTickLength(originalTickLength);
      if (options?.preserveClock) state.lastTick = originalLastTick;
    }

    const deltaCurrencies: Record<string, Numerus> = {};
    for (const curr of currencies) {
      const initial = N(initialCurrencies[curr.code] ?? 0);
      const final = N(curr.amount);
      deltaCurrencies[curr.code] = NR(final.sub(initial));
    }

    const finishedAt = this.time.now();
    const ticksRun = Math.floor(durationMs / tickLengthUsed);

    return {
      durationMs,
      durationRequestedMs: elapsedMs,
      durationCapped,
      tickLengthUsed,
      ticksRun,
      deltaCurrencies,
      startedAt,
      finishedAt,
    };
  }

  public getStageReport(state: GameState): [string, StageMetrics][] {
    return Object.entries(state.stats.stageMetrics).sort((a, b) => b[1].avgMs - a[1].avgMs);
  }

  // --- growth & pricing -----------------------------------------------

  public growthValue(func: GrowthFunction, quantity: GenericNumberInput): Decimal {
    return computeGrowthFunction(func, quantity, this.growths);
  }

  public costToBuyNext(item: Buyable, amount: GenericNumberInput, otherQuantity?: Numerus): Numerus {
    return costToBuyNext(this.growths, item, amount, otherQuantity);
  }

  public maxBuyableAmount(item: Buyable, pool: { amount: Numerus }, otherQuantity?: Numerus): Numerus {
    return maxBuyableAmount(this.growths, item, pool, otherQuantity);
  }

  public costToBuy(item: Buyable, pool: { amount: Numerus }, amount?: GenericNumberInput, otherQuantity?: Numerus): { cost: Numerus; amount: Numerus } {
    return costToBuy(this.growths, item, pool, amount, otherQuantity);
  }

  /** Cost per pool of the next `amount` units: main line first, then each extra with a payable span. See `costLinesToBuyNext`. */
  public costLinesToBuyNext(item: Buyable, amount: GenericNumberInput, otherQuantity?: Numerus): CostLine[] {
    return costLinesToBuyNext(this.growths, item, amount, otherQuantity);
  }

  /** Most units every cost line allows, pools resolved in `state`. Ignores `max` and `unlock`. See `maxBuyableAcrossPools`. */
  public maxBuyableAcrossPools(state: GameState, item: Buyable, otherQuantity?: Numerus): Numerus {
    return maxBuyableAcrossPools(this.growths, item, (code) => findCostPool(state, code), otherQuantity);
  }

  /** Codes of the pools missing or too short for `amount` units, in line order. See `costShortfalls`. */
  public costShortfalls(state: GameState, item: Buyable, amount = 1): string[] {
    return costShortfalls(this, state, item, amount);
  }

  // --- prestige ----------------------------------------------------------

  public prestigeDrive(currency: Pick<Currency, "amount" | "earned" | "drive">): Decimal {
    return prestigeDrive(currency);
  }

  public prestigeGainMultiplier(state: GameState, prestige: Prestige): Decimal {
    return prestigeGainMultiplier(state, prestige, this.services);
  }

  /** The gain a prestige would deliver right now: gate + `gainMult` fold + whole-unit floor, 0 if the source does not resolve. */
  public prestigeGain(state: GameState, prestige: Prestige): Decimal {
    const source = this.services.adapter.getTargetValue(state, prestige.source);
    if (!source || Array.isArray(source)) return N(0);
    const raw = this.growthValue(prestige.func, source);
    return deliveredPrestigeGain(raw, this.prestigeGainMultiplier(state, prestige));
  }

  /**
   * Converts the prestige's source into its target currency, resets every
   * entity the prestige lists in `resetsOn`, applies head-start grants and
   * restores kept upgrade levels. Returns false (logged) when the source or
   * target does not resolve, or the delivered gain is non-positive.
   */
  public performPrestige(state: GameState, prestige: Prestige): boolean {
    const source = this.getThing(state, prestige.source.code);
    const target = this.getThing(state, prestige.target.code);
    if (!source || !target) {
      this.logger.error(`Cannot perform prestige "${prestige.code}": unresolved source or target.`);
      return false;
    }

    const sourceValue = this.services.adapter.getTargetValue(state, prestige.source);
    if (!sourceValue || Array.isArray(sourceValue)) {
      this.logger.error(`Cannot perform prestige "${prestige.code}": unresolved source value.`);
      return false;
    }

    const gain = this.prestigeGain(state, prestige);
    if (gain.lte(0)) {
      this.logger.error(`Cannot perform prestige "${prestige.code}": non-positive gain.`);
      return false;
    }

    this.services.adapter.setTargetValue(state, prestige.target, (amount) => NR(gain.add(amount)));

    const prestigeCurrency = this.services.registry.getByCode(state, "currency", prestige.currencyCode) as Currency | undefined;
    if (prestigeCurrency) {
      prestigeCurrency.earned = NR(N(prestigeCurrency.earned ?? 0).add(gain));
    }

    const keptLevels = new Map<string, Numerus>();
    for (const upgrade of state.upgrades) {
      if (!upgrade.resetsOn?.includes(prestige.code)) continue;
      const levels = levelsAfterPrestige(state, prestige.code, upgrade);
      if (levels.gt(0)) keptLevels.set(upgrade.code, NR(levels));
    }

    this.services.adapter.resetForPrestige(state, prestige.code);
    this.applyPostPrestigeGrants(state, prestige.code, keptLevels);
    reinitPrestigeRuns(this, state, prestige.code);

    this.onPrestigeHook?.(state, prestige);
    return true;
  }

  /**
   * Head-start grants: modifiers targeting a reset producer's `resetsTo`
   * path are folded onto its base `resetsTo` and become its starting stock
   * (never lowering it below what the reset already applied). Then the
   * upgrade levels snapshotted before the reset are restored.
   */
  private applyPostPrestigeGrants(state: GameState, prestigeCode: string, keptLevels: Map<string, Numerus>): void {
    const mods = collectModifiers(state, this.services);

    for (const producer of this.services.adapter.getProducers(state)) {
      if (!producer.resetsOn?.includes(prestigeCode)) continue;
      const grants = (mods.get(producer) ?? []).filter((m) => m.effect.target.path === "resetsTo");
      if (grants.length === 0) continue;
      const start = applyModifiers(N(producer.resetsTo ?? 0), grants, this.services);
      if (start.gt(N(producer.amount))) {
        producer.amount = NR(start);
      }
    }

    for (const [code, levels] of keptLevels) {
      const upgrade = this.services.registry.getByCode(state, "upgrade", code) as Upgrade | undefined;
      if (!upgrade || N(levels).lte(0)) continue;
      upgrade.bought = levels;
      upgrade.amount = levels;
    }
  }

  // --- purchases ---------------------------------------------------------

  /** Buys one level of an upgrade (see `core/purchase.ts`). False when blocked. */
  public buyUpgrade(state: GameState, code: string): boolean {
    return buyUpgrade(this, state, code);
  }

  /** Buys `amount` units of a producer (see `core/purchase.ts`). False when blocked. */
  public buyProducer(state: GameState, code: string, amount = 1): boolean {
    return buyProducer(this, state, code, amount);
  }

  /** True when the entity's `unlock` gate (if any) is open. */
  public isUnlocked(state: GameState, entity: { unlock?: Unlock }): boolean {
    return isUnlocked(state, entity);
  }

  /** Why the upgrade's next level cannot be bought, or null. */
  public upgradePurchaseBlock(state: GameState, upgrade: Upgrade): PurchaseBlock | null {
    return upgradePurchaseBlock(this, state, upgrade);
  }

  /** Why `amount` units of the producer cannot be bought, or null. */
  public producerPurchaseBlock(state: GameState, producer: Producer, amount = 1): PurchaseBlock | null {
    return producerPurchaseBlock(this, state, producer, amount);
  }

  // --- saturation ----------------------------------------------------------

  /** False without `rules.saturation`, or when its `gate` currency is missing or below the threshold. */
  public saturationActive(state: GameState): boolean {
    const sat = state.rules?.saturation;
    if (!sat) return false;
    if (!sat.gate) return true;
    const gateCurrency = state.currencies.find((c) => c.code === sat.gate!.currencyCode);
    if (!gateCurrency) return false;
    return N(gateCurrency.earned ?? 0).gte(sat.gate.earnedAtLeast);
  }

  /** The push × shop-channel multiplier applied to every producer's capacity. 1 without the respective rule/currency. */
  public capacityMultiplier(state: GameState): Decimal {
    return this.capacityMultiplierWithMods(state, collectModifiers(state, this.services));
  }

  private capacityMultiplierWithMods(state: GameState, mods: Map<object, Modifier[]>): Decimal {
    const sat = state.rules?.saturation;
    if (!sat) return N(1);

    const pushValue = sat.push ? capacityPush(N(this.currencyDriveValue(state, sat.push.currencyCode)), sat.push.exponent) : N(1);

    const overflowCurrency = sat.overflowCurrencyCode ? state.currencies.find((c) => c.code === sat.overflowCurrencyCode) : undefined;
    const shopMult = overflowCurrency
      ? applyModifiers(
          N(overflowCurrency.capacityMult ?? 1),
          (mods.get(overflowCurrency) ?? []).filter((m) => m.effect.target.path === "capacityMult"),
          this.services,
        )
      : N(1);

    return pushValue.mul(shopMult);
  }

  private currencyDriveValue(state: GameState, code: string): Decimal {
    const currency = state.currencies.find((c) => c.code === code);
    return N(currency?.earned ?? currency?.amount ?? 0);
  }

  /** The overflow-currency drag currently applied. 1 without `rules.saturation.drag` or the overflow currency. */
  public dragFactor(state: GameState): Decimal {
    const sat = state.rules?.saturation;
    const overflowCurrency = sat?.overflowCurrencyCode ? state.currencies.find((c) => c.code === sat.overflowCurrencyCode) : undefined;
    if (!sat?.drag || !overflowCurrency) return N(1);
    return computeDragFactor(N(overflowCurrency.amount), sat.drag);
  }

  /** `{ 1, 1 }` when the producer has no capacity, or saturation is inactive. */
  public supportRatio(state: GameState, producer: Producer): { smooth: Decimal; raw: Decimal } {
    if (!producer.capacity || !this.saturationActive(state)) return { smooth: N(1), raw: N(1) };
    const sat = state.rules!.saturation!;
    return computeSupportRatio({
      amount: N(producer.amount),
      bought: N(producer.bought),
      capacity: producer.capacity,
      capacityMultiplier: this.capacityMultiplier(state),
      decayExponent: sat.decayExponent ?? 2,
    });
  }

  // --- stage bodies --------------------------------------------------------

  /**
   * Applies every *transient* (`persecDelta`-target) upgrade effect declared
   * for `stage`, ordered by effect-type priority then upgrade declaration
   * order. Effects on persistent paths are folded at their point of read
   * (see `modifiers.ts` and `computeProducers`) and never applied here.
   */
  public applyUpgrades(state: GameState, stage: 0 | 1 | 2): void {
    const effectsToApply: { effect: Effect; amount: Numerus; upgradePriority: number }[] = [];

    for (let i = 0; i < state.upgrades.length; i++) {
      const upgrade = state.upgrades[i];
      if (!upgrade || N(upgrade.bought).lte(0)) continue;
      for (const effect of upgrade.effects) {
        if (effect.stage !== stage) continue;
        if (!isTransientTargetPath(effect.target.path)) continue;
        effectsToApply.push({ effect, amount: upgrade.bought, upgradePriority: i });
      }
    }

    effectsToApply.sort((a, b) => {
      const aPriority = this.effectTypes.lookup(a.effect.type)?.priority ?? 100;
      const bPriority = this.effectTypes.lookup(b.effect.type)?.priority ?? 100;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.upgradePriority - b.upgradePriority;
    });

    for (const { effect, amount } of effectsToApply) {
      this.applyEffect(state, effect, amount);
    }
  }

  /** Applies each prestige's passive effects on transient targets, driven by `prestigeDrive`. */
  public applyPrestiges(state: GameState): void {
    for (const prestige of state.prestiges) {
      const curr = this.services.registry.getByCode(state, "currency", prestige.currencyCode) as Currency | undefined;
      if (!curr) continue;
      const drive = NR(prestigeDrive(curr));
      if (N(drive).lte(0)) continue;
      for (const effect of prestige.effects) {
        if (!isTransientTargetPath(effect.target.path)) continue;
        this.applyEffect(state, effect, drive);
      }
    }
  }

  /**
   * Computes every producer's output for this tick: folds persistent-path
   * modifiers onto `persec`, applies the saturation drag and efficiency
   * decay (data-driven — no producer/currency code is ever read for its
   * meaning), accumulates overflow into its currency and cools it down.
   */
  public computeProducers(state: GameState, elapsed: number): void {
    this.resetGrowables(state);

    const mods = collectModifiers(state, this.services);
    const sat = state.rules?.saturation;
    const active = this.saturationActive(state);
    const drag = this.dragFactor(state);
    const capMult = active ? this.capacityMultiplierWithMods(state, mods) : N(1);

    const overflowByProducer: Record<string, number> = {};
    let overflowTotal = N(0);

    for (const producer of state.producers) {
      let producerOverflow = N(0);

      for (const produced of producer.produces) {
        const target = this.services.registry.findGrowableByCode(state, produced.code);
        if (!target) continue;

        const effectivePersec = applyModifiers(produced.persec, mods.get(produced) ?? [], this.services);
        produced.persecEffective = NR(effectivePersec);

        const base = effectivePersec.mul(N(producer.amount)).mul(drag);

        const ratio =
          active && producer.capacity
            ? computeSupportRatio({
                amount: N(producer.amount),
                bought: N(producer.bought),
                capacity: producer.capacity,
                capacityMultiplier: capMult,
                decayExponent: sat?.decayExponent ?? 2,
              }).smooth
            : N(1);

        const delivered = base.mul(ratio);
        this.services.adapter.addPersecDelta(state, target, NR(delivered));

        const lost = base.sub(delivered);
        if (lost.gt(0) && producer.capacity?.overflowRate) {
          producerOverflow = producerOverflow.add(lost.mul(producer.capacity.overflowRate));
        }
      }

      if (producerOverflow.gt(0)) {
        overflowByProducer[producer.code] = (overflowByProducer[producer.code] ?? 0) + producerOverflow.toNumber();
        overflowTotal = overflowTotal.add(producerOverflow);
      }
    }

    const overflowCurrency = sat?.overflowCurrencyCode ? (this.services.registry.getByCode(state, "currency", sat.overflowCurrencyCode) as Currency | undefined) : undefined;

    if (overflowCurrency) {
      const overflowDelta = NR(overflowTotal.mul(elapsed / 1000));
      this.services.adapter.incrementAmount(state, overflowCurrency, overflowDelta);
      overflowCurrency.earned = NR(N(overflowCurrency.earned ?? 0).add(N(overflowDelta)));

      if (sat?.cooling) {
        const coolMult = applyModifiers(
          N(overflowCurrency.coolingMult ?? 1),
          (mods.get(overflowCurrency) ?? []).filter((m) => m.effect.target.path === "coolingMult"),
          this.services,
        );
        const cooled = coolingDelta(N(overflowCurrency.amount), elapsed, sat.cooling.halfLifeMs).mul(coolMult);
        if (cooled.lt(0)) {
          this.services.adapter.incrementAmount(state, overflowCurrency, NR(cooled));
        }
      }
    }

    state.stats.overflowPerSec = overflowTotal.toNumber();
    state.stats.overflowByProducer = overflowByProducer;
  }

  /** Applies accrued `persecDelta` values to every growable's `amount`. */
  public applyGrowth(state: GameState, elapsed: number): void {
    const growables = this.services.registry.getAllGrowables(state);
    for (const thing of growables) {
      const delta = NR(N(thing.persecDelta ?? 0).mul(elapsed / 1000));
      this.services.adapter.incrementAmount(state, thing, delta);
    }
  }

  /** Runs, in order, the prestige run clocks, the upgrade autobuyers, the prestige drips and the auto-prestige checks. */
  public runAutomation(state: GameState, elapsed: number): void {
    advancePrestigeRuns(this, state, elapsed);
    runUpgradeAutobuyers(this, state);
    applyPrestigeDrips(this, state, elapsed);
    runAutoPrestiges(this, state);
  }

  // --- internals -------------------------------------------------------

  private getThing(state: GameState, code: string): Producer | Currency | Upgrade | undefined {
    return (
      this.services.registry.getByCode(state, "producer", code) ??
      this.services.registry.getByCode(state, "currency", code) ??
      this.services.registry.getByCode(state, "upgrade", code)
    );
  }

  private applyEffect(state: GameState, effect: Effect, amount: Numerus): void {
    this.effects.apply(state, effect, amount, this.services);
  }

  private singleTick(state: GameState, elapsed: number): void {
    for (const stage of this.stages.list()) {
      this.measureStage(state, stage.id, () => stage.run({ state, elapsed, engine: this }));
    }

    state.stats.ticks += 1;
    state.stats.lastTicks.push(elapsed);
    if (state.stats.lastTicks.length > MOVING_AVG_WINDOW) state.stats.lastTicks.shift();
    state.stats.movingAvgTime = state.stats.lastTicks.reduce((a, b) => a + b, 0) / state.stats.lastTicks.length;
  }

  private resetGrowables(state: GameState): void {
    const growables = this.services.registry.getAllGrowables(state);
    for (const thing of growables) {
      this.services.adapter.setPersecDelta(state, thing, undefined);
    }
  }

  private measureStage(state: GameState, name: string, fn: () => void): void {
    const start = this.time.now();
    fn();
    const d = this.time.now() - start;

    state.stats.lastCallTimes.push([name, d]);
    if (state.stats.lastCallTimes.length > MOVING_AVG_WINDOW * 10) state.stats.lastCallTimes.shift();

    const metrics = state.stats.stageMetrics[name];
    if (metrics) {
      metrics.count++;
      metrics.totalMs += d;
      metrics.avgMs = metrics.totalMs / metrics.count;
      metrics.minMs = Math.min(metrics.minMs, d);
      metrics.maxMs = Math.max(metrics.maxMs, d);
      metrics.lastMs = d;
    } else {
      state.stats.stageMetrics[name] = { count: 1, totalMs: d, avgMs: d, minMs: d, maxMs: d, lastMs: d };
    }
  }

  private ensureValidated(state: GameState): void {
    if (this.validated) return;
    this.validated = true;

    const result = validateBootstrap(state, this.services);
    state.stats.validationErrors = result.errors;
    state.stats.validationWarnings = result.warnings;
    state.stats.bootstrapReport = result.report;

    if (result.errors.length > 0) this.logger.error("[engine.validate] Bootstrap validation errors:", result.errors);
    if (result.warnings.length > 0) this.logger.warn("[engine.validate] Bootstrap validation warnings:", result.warnings);
  }
}
