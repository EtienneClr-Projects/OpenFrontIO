import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { NuclearBudget } from "src/client/advisor/NuclearBudget";
import { describe, expect, it } from "vitest";

const COST = 60_000n;
const TYPE = UnitType.AtomBomb;

function fundedBudget(until = 2700, workerRate = 100n) {
  const budget = new NuclearBudget();
  budget.observe(0, workerRate, 0n);
  expect(budget.canSpend(TYPE, COST, 1_000_000n)).toBe(false);
  for (let tick = 100; tick <= until; tick += 100)
    budget.observe(tick, workerRate, 0n);
  return budget;
}

describe("nuclear economy budget", () => {
  it("requires two minutes of observations and earns no initial allowance", () => {
    const budget = fundedBudget(1200);
    expect(budget.canSpend(TYPE, COST, 1_000_000n)).toBe(false);
    for (let tick = 1300; tick <= 2600; tick += 100)
      budget.observe(tick, 100n, 0n);
    expect(budget.canSpend(TYPE, COST, 1_000_000n)).toBe(false);
    budget.observe(2700, 100n, 0n);
    expect(budget.canSpend(TYPE, COST, 1_000_000n)).toBe(true);
  });

  it("requires income/minute to cover the actual weapon price", () => {
    const budget = fundedBudget(5000);
    expect(budget.canSpend(TYPE, COST + 1n, 500_000_000n)).toBe(false);
    expect(budget.canSpend(TYPE, COST, 500_000_000n)).toBe(true);
  });

  it("preserves at least another purchase cost after spending", () => {
    const budget = fundedBudget();
    expect(budget.canSpend(TYPE, COST, COST * 2n - 1n)).toBe(false);
    expect(budget.canSpend(TYPE, COST, COST * 2n)).toBe(true);
  });

  it("preserves half a minute of income when that exceeds the cost", () => {
    const budget = fundedBudget(2700, 400n);
    expect(budget.canSpend(TYPE, COST, 179_999n)).toBe(false);
    expect(budget.canSpend(TYPE, COST, 180_000n)).toBe(true);
  });

  it("shares the 40% budget across missiles and silos", () => {
    const budget = fundedBudget();
    expect(budget.canSpend(UnitType.MissileSilo, COST, 1_000_000n)).toBe(true);
    budget.spend(COST);
    for (const type of [
      UnitType.MissileSilo,
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRV,
    ])
      expect(budget.canSpend(type, COST, 1_000_000n)).toBe(false);
    for (let tick = 2800; tick <= 4200; tick += 100)
      budget.observe(tick, 100n, 0n);
    expect(budget.canSpend(UnitType.MIRV, COST, 1_000_000n)).toBe(true);
  });

  it("caps saved allowance at two supported purchases", () => {
    const budget = fundedBudget(10_000);
    budget.spend(COST);
    expect(budget.canSpend(TYPE, COST, 1_000_000n)).toBe(true);
    budget.spend(COST);
    expect(budget.canSpend(TYPE, COST, 1_000_000n)).toBe(false);
  });

  it("counts actual trade receipts even when they arrive in batches", () => {
    const budget = new NuclearBudget();
    budget.observe(0, 0n, 0n);
    budget.canSpend(TYPE, COST, 1_000_000n);
    for (let tick = 100; tick <= 2700; tick += 100)
      budget.observe(tick, 0n, BigInt(Math.floor(tick / 300)) * 30_000n);
    expect(budget.canSpend(TYPE, COST, 1_000_000n)).toBe(true);
  });

  it("clears saved allowance after recurring income collapses", () => {
    const budget = fundedBudget(4200);
    budget.observe(4300, 0n, 0n);
    for (let tick = 4400; tick <= 5500; tick += 100)
      budget.observe(tick, 0n, 0n);
    expect(budget.canSpend(TYPE, COST, 1_000_000n)).toBe(false);
    budget.observe(5600, 100n, 0n);
    for (let tick = 5700; tick <= 6800; tick += 100)
      budget.observe(tick, 100n, 0n);
    expect(budget.canSpend(TYPE, COST, 1_000_000n)).toBe(false);
  });

  it("does not earn budget while the simulation tick is paused", () => {
    const budget = fundedBudget();
    budget.spend(COST);
    for (let i = 0; i < 10; i++) budget.observe(2700, 100n, 100_000_000n);
    expect(budget.canSpend(TYPE, COST, 1_000_000n)).toBe(false);
  });

  it("keeps a full two-minute window when called every simulation tick", () => {
    const budget = new NuclearBudget();
    budget.observe(0, 0n, 0n);
    budget.canSpend(TYPE, 30_000n, 1_000_000n);
    for (let tick = 1; tick <= 2700; tick++)
      budget.observe(tick, 0n, BigInt(Math.floor(tick / 600)) * 60_000n);
    expect(budget.canSpend(TYPE, 30_000n, 1_000_000n)).toBe(true);
  });
});
