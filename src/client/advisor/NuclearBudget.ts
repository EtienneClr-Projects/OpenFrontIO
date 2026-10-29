import type { UnitType } from "@openfront/engine-api/game/GameTypes";
import { GoldRateTracker } from "../hud/layers/lib/GoldRateTracker";

const WINDOW_TICKS = 1200;

/** One shared allowance for offensive silos and all nuclear weapon types. */
export class NuclearBudget {
  private readonly rates = new GoldRateTracker();
  private readonly prices = new Map<UnitType, bigint>();
  private firstTick: number | null = null;
  private previous: {
    tick: number;
    workerRate: bigint;
    trade: bigint;
  } | null = null;
  private earned = 0n;
  private income = 0n;
  private lastRateTick = -Infinity;
  // Fifths of gold keep the 40% allocation exact across small updates.
  private allowance = 0n;
  private mature = false;

  observe(tick: number, workerRate: bigint, trade: bigint): void {
    const previous = this.previous;
    if (previous && tick <= previous.tick) return;
    this.firstTick ??= tick;
    const delta = previous
      ? previous.workerRate * BigInt(tick - previous.tick) +
        trade -
        previous.trade
      : 0n;
    this.previous = { tick, workerRate, trade };
    const wasQualified = this.mature && this.qualifyingPrices().length > 0;
    this.earned += delta;
    // The tracker holds 240 samples; sample once per second, not every tick.
    if (tick - this.lastRateTick >= 10) {
      this.lastRateTick = tick;
      this.rates.record(
        0,
        { income: Number(this.earned), trade: 0, train: 0, piracy: 0 },
        tick,
      );
      this.income = BigInt(Math.floor(this.rates.goldIncomePerMin(0)));
    }
    this.mature = tick - this.firstTick >= WINDOW_TICKS;
    const prices = this.qualifyingPrices();
    if (!this.mature || prices.length === 0) {
      this.allowance = 0n;
      return;
    }
    if (wasQualified) this.allowance += delta * 2n;
    const cap = prices.reduce((a, b) => (a > b ? a : b)) * 10n;
    if (this.allowance > cap) this.allowance = cap;
  }

  private qualifyingPrices(): bigint[] {
    return [...this.prices.values()].filter((cost) => cost <= this.income);
  }

  canSpend(type: UnitType, cost: bigint, gold: bigint): boolean {
    this.prices.set(type, cost);
    const remaining = gold - cost;
    return (
      this.mature &&
      this.income >= cost &&
      remaining >= cost &&
      remaining * 2n >= this.income &&
      this.allowance >= cost * 5n
    );
  }

  spend(cost: bigint): void {
    this.allowance -= cost * 5n;
  }
}
