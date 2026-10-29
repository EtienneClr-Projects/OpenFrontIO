import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { PlayerLike } from "@openfront/engine-api/game/ReadViews";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { Config } from "@openfront/engine-lib/configuration/Config";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { describe, expect, it } from "vitest";

describe("EngineConfig.unitInfo", () => {
  for (const instantBuild of [false, true]) {
    const gameConfig = { instantBuild } as unknown as GameConfig;
    const shared = new Config(gameConfig, false);
    const engine = new EngineConfig(gameConfig, false);

    it(`adds a cost to the shared unit stats (instantBuild=${instantBuild})`, () => {
      for (const type of Object.values(UnitType)) {
        const { cost, ...stats } = engine.unitInfo(type);
        expect(stats).toEqual(shared.unitInfo(type));
        expect(typeof cost).toBe("function");
      }
    });
  }

  it("caches per unit type", () => {
    const engine = new EngineConfig({} as unknown as GameConfig, false);
    expect(engine.unitInfo(UnitType.City)).toBe(engine.unitInfo(UnitType.City));
  });

  it.each([
    [PlayerType.Human, false, 1, 100n],
    [PlayerType.Bot, false, 1, 50n],
    [PlayerType.Nation, false, 1.235, 123n],
    [PlayerType.Human, false, 2, 200n],
    [PlayerType.Human, true, 2, 375n],
  ] as const)(
    "shares worker gold rules for %s (host=%s, multiplier=%s)",
    (playerType, isLobbyCreator, goldMultiplier, expected) => {
      const gameConfig = {
        goldMultiplier,
        hostCheats: { goldMultiplier: 3.75 },
      } as GameConfig;
      const shared = new Config(gameConfig, false);
      const engine = new EngineConfig(gameConfig, false);
      const player: PlayerLike = {
        id: () => "player",
        smallID: () => 1,
        isPlayer: () => true,
        type: () => playerType,
        isLobbyCreator: () => isLobbyCreator,
        numTilesOwned: () => 1,
        troops: () => 100_000,
        gold: () => 0n,
        units: () => [],
      };
      expect(shared.goldAdditionRate(player)).toBe(expected);
      expect(engine.goldAdditionRate(player)).toBe(expected);
    },
  );
});
