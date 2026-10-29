import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import type { PlayerActions } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { Config } from "@openfront/engine-lib/configuration/Config";
import type { GameEvent } from "@openfront/shared/EventBus";
import {
  AdvisorController,
  isAdvisorHost,
} from "src/client/advisor/AdvisorController";
import { AdvisorPanel } from "src/client/advisor/AdvisorPanel";
import { AutomaticPlayer } from "src/client/advisor/AutomaticPlayer";
import { NuclearBudget } from "src/client/advisor/NuclearBudget";
import { SpatialIndex } from "src/client/advisor/SpatialIndex";
import type {
  AdvisorObservation,
  AdvisorUnit,
  Recommendation,
} from "src/client/advisor/Types";
import {
  BuildUnitIntentEvent,
  SendAttackIntentEvent,
  SendUpgradeStructureIntentEvent,
  MoveWarshipIntentEvent,
  SendAllianceRequestIntentEvent,
  SendBoatAttackIntentEvent,
} from "src/client/Transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeEmptyGu,
  makeGameView,
  makePlayerUpdate,
  makeUnitUpdate,
} from "../../util/viewStubs";

vi.mock("src/client/Utils", async (original) => ({
  ...(await original<typeof import("src/client/Utils")>()),
  translateText: (key: string) => key,
}));

const controllers: AdvisorController[] = [];
afterEach(() => {
  controllers.forEach((c) => c.dispose());
  controllers.length = 0;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setup(
  width = 10,
  emit?: (event: GameEvent) => void,
  gameType = GameType.Singleplayer,
) {
  const config = new Config(
    {
      gameMap: GameMapType.World,
      difficulty: Difficulty.Medium,
      gameType,
      gameMode: GameMode.FFA,
      gameMapSize: GameMapSize.Normal,
      donateGold: false,
      donateTroops: false,
      nations: "disabled",
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    },
    false,
  );
  const game = makeGameView({ myClientID: "me", config, width, height: width });
  const gu = makeEmptyGu(1);
  gu.updates[GameUpdateType.Player] = [
    makePlayerUpdate({
      id: "me",
      clientID: "me",
      spawnTile: 11,
      troops: 100_000,
      tilesOwned: 1,
      gold: 500_000n,
    }),
  ];
  gu.updates[GameUpdateType.SpawnPhaseEnd] = [
    {
      type: GameUpdateType.SpawnPhaseEnd,
      startTick: 1,
    },
  ];
  gu.packedTileUpdates = Uint32Array.from([11, 1 | (128 << 16), 12, 128 << 16]);
  game.update(gu);
  const response: PlayerActions = {
    canAttack: true,
    buildableUnits: [],
    canSendEmojiAllPlayers: false,
  };
  const query = vi.fn<typeof game.worker.playerInteraction>(
    async () => response,
  );
  game.worker.playerInteraction = query;
  const focus = vi.fn();
  const controller = new AdvisorController(game, focus, emit);
  controllers.push(controller);
  const advance = (tick: number) => {
    game.update(makeEmptyGu(tick));
    controller.tick();
  };
  return { game, controller, query, focus, advance };
}

describe("local adviser lifecycle", () => {
  it("automatic opt-in enables observation, while disabling advice invalidates pending automatic work", async () => {
    const emit = vi.fn();
    const { controller, advance } = setup(10, emit);
    expect(controller.panel.automatic).toBe(false);
    controller.panel.onAutomatic(true);
    expect(controller.panel.enabled).toBe(true);
    expect(controller.panel.automatic).toBe(true);
    advance(2);
    advance(3);
    controller.panel.onToggle(false);
    await new Promise((r) => setTimeout(r, 0));
    advance(4);
    expect(controller.panel.automatic).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
  it("is disabled by default and performs no analysis or worker requests", () => {
    const { controller, advance, query } = setup();
    advance(2);
    expect(query).not.toHaveBeenCalled();
    expect(controller.performance().samples).toBe(0);
    expect(controller.panel.status).toBe("disabled");
  });

  it("observes only after opting in and does not repeat a paused tick", async () => {
    const { controller, advance, query } = setup();
    controller.panel.onToggle(true);
    advance(2);
    advance(3);
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    const count = query.mock.calls.length;
    controller.tick();
    expect(query).toHaveBeenCalledTimes(count);
    expect(controller.panel.status).toBe("active");
    expect(controller.performance().samples).toBe(1);
  });

  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])(
    "permits loopback %s",
    (host) => {
      expect(isAdvisorHost(host)).toBe(true);
    },
  );

  it.each(["openfront.io", "localhost.attacker.test", "192.168.1.2"])(
    "does not enable on %s",
    (host) => {
      expect(isAdvisorHost(host)).toBe(false);
    },
  );

  it("offers opt-in automatic play in multiplayer games", () => {
    const { controller } = setup(10, vi.fn(), GameType.Public);
    expect(controller.panel.canAutomate).toBe(true);
    controller.panel.onAutomatic(true);
    expect(controller.panel.automatic).toBe(true);
  });

  it("discards pending query results on disable and cleans up the panel", async () => {
    const { controller, query, advance } = setup();
    let resolve!: (result: PlayerActions) => void;
    const pending = new Promise<PlayerActions>((r) => {
      resolve = r;
    });
    query.mockImplementation(() => pending);
    controller.panel.onToggle(true);
    advance(2);
    advance(3);
    controller.panel.onToggle(false);
    resolve({
      canAttack: true,
      buildableUnits: [],
      canSendEmojiAllPlayers: false,
    });
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    advance(4);
    expect(controller.panel.status).toBe("disabled");
    expect(controller.panel.result.items).toHaveLength(0);
    controller.dispose();
    expect(document.querySelector("strategy-advisor")).toBeNull();
  });

  it("reports query errors explicitly without manufacturing attack eligibility", async () => {
    const { controller, advance, query } = setup();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    query.mockRejectedValue(new Error("worker unavailable"));
    controller.panel.onToggle(true);
    advance(2);
    advance(3);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    advance(4);
    expect(controller.panel.queryState).toBe("error");
    expect(controller.panel.result.items).toHaveLength(0);
  });

  it("removes an affordable build when current gold falls below its quoted cost", async () => {
    const { controller, game, advance, query } = setup();
    query.mockResolvedValue({
      canAttack: false,
      canSendEmojiAllPlayers: false,
      buildableUnits: [
        {
          type: UnitType.City,
          canBuild: 11,
          canUpgrade: false,
          cost: 100n,
          overlappingRailroads: [],
          ghostRailPaths: [],
        },
      ],
    });
    controller.panel.onToggle(true);
    advance(2);
    advance(3);
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    advance(4);
    expect(controller.panel.result.items.some((i) => i.rule === "city")).toBe(
      true,
    );
    game.myPlayer()!.state.gold = 0;
    advance(5);
    expect(controller.panel.result.items.some((i) => i.rule === "city")).toBe(
      false,
    );
  });

  it("does not renew old eligibility by merely starting a slow query", async () => {
    const { controller, advance, query } = setup();
    controller.panel.onToggle(true);
    advance(2);
    advance(3);
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    advance(4);
    expect(controller.panel.queryState).toBe("ready");
    let resolve!: (result: PlayerActions) => void;
    const pending = new Promise<PlayerActions>((r) => {
      resolve = r;
    });
    query.mockImplementation(() => pending);
    advance(24);
    expect(controller.panel.queryState).toBe("checking");
    advance(45);
    resolve({
      canAttack: true,
      buildableUnits: [],
      canSendEmojiAllPlayers: false,
    });
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    advance(46);
    expect(controller.panel.queryState).toBe("checking");
    expect(controller.panel.result.items).toHaveLength(0);
  });

  it("withholds catch-up transitions and stops normal advice after game over", () => {
    const { game, controller, advance } = setup();
    controller.panel.onToggle(true);
    const catchup = vi.spyOn(game, "isCatchingUp").mockReturnValue(true);
    advance(2);
    expect(controller.panel.status).toBe("catchup");
    catchup.mockReturnValue(false);
    vi.spyOn(game, "gameOver").mockReturnValue(true);
    advance(3);
    expect(controller.panel.status).toBe("finished");
    expect(controller.panel.result.items).toHaveLength(0);
  });

  it("requests only observational worker messages and camera focus", async () => {
    const { controller, game, advance, focus, query } = setup();
    const owner = game.ownerID(11);
    controller.panel.onToggle(true);
    advance(2);
    advance(3);
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    expect(query.mock.calls.length).toBeLessThanOrEqual(5);
    controller.panel.onFocus(11);
    expect(focus).toHaveBeenCalledWith(11);
    expect(game.ownerID(11)).toBe(owner);
    expect(Object.keys(game.worker)).toEqual(["playerInteraction"]);
  });
});

describe("quiet advice panel", () => {
  it("keeps automatic play off by default and exposes a separate opt-in control", async () => {
    const panel = new AdvisorPanel();
    document.body.append(panel);
    panel.canAutomate = true;
    panel.onAutomatic = vi.fn();
    await panel.updateComplete;
    const inputs =
      panel.shadowRoot!.querySelectorAll<HTMLInputElement>("input");
    expect(inputs).toHaveLength(2);
    expect(inputs[1].checked).toBe(false);
    inputs[1].checked = true;
    inputs[1].dispatchEvent(new Event("change"));
    expect(panel.onAutomatic).toHaveBeenCalledWith(true);
  });
  it("keeps strike coverage and infrastructure visible without expanding evidence", async () => {
    const panel = new AdvisorPanel();
    document.body.append(panel);
    panel.enabled = true;
    panel.status = "active";
    panel.result = {
      context: "nuclear",
      items: [
        {
          id: "nuke:2",
          rule: "nuke",
          confidence: "observed",
          priority: 100,
          firstTick: 1,
          lastTick: 1,
          params: { coverage: "none", [UnitType.City]: 2 },
        },
      ],
    };
    await panel.updateComplete;
    const article = panel.shadowRoot!.querySelector("article")!;
    expect(article.textContent).toContain("advisor.coverage_none");
    expect(article.textContent).toContain("advisor.nuke_assets");
    expect(article.querySelector("details")!.open).toBe(false);
    expect(AdvisorPanel.styles.cssText).toContain("left: 12px");
    expect(AdvisorPanel.styles.cssText).toContain("bottom: 12px");
    expect(AdvisorPanel.styles.cssText).not.toMatch(/^\s*top:/m);
  });

  function automaticFixture(width = 10, enforceNuclearBudget = false) {
    // Tactical scenarios isolate the economy gate; economy tests exercise it live.
    if (!enforceNuclearBudget)
      vi.spyOn(NuclearBudget.prototype, "canSpend").mockReturnValue(true);
    const { game, query } = setup(width);
    const emit = vi.fn();
    const report = vi.fn();
    const auto = new AutomaticPlayer(game, emit, report);
    const spatial = new SpatialIndex(game, 1);
    spatial.initialize(Infinity);
    const observation: AdvisorObservation = {
      tick: 1,
      elapsed: 1,
      myID: 1,
      players: [
        {
          id: 1,
          name: "me",
          type: PlayerType.Human,
          team: null,
          alive: true,
          disconnected: false,
          friendly: true,
          tiles: 1,
          troops: 100_000,
          incoming: 0,
          outgoing: 0,
          traitor: false,
          doomed: false,
          alliances: [],
        },
      ],
      units: [],
      cap: 150_000,
      growth: 100,
      gold: 500_000n,
      builds: [],
      queryState: "ready",
      attackable: new Set(),
      landShare: 0.01,
      winShare: 0.8,
      clockEnabled: false,
    };
    const tick = (value: number) => {
      game.update(makeEmptyGu(value));
      observation.tick = value;
      auto.tick(observation, spatial);
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const territory = (tile: number, owner: number) => {
      const gu = makeEmptyGu(1);
      gu.packedTileUpdates = Uint32Array.from([tile, owner | (128 << 16)]);
      game.update(gu);
      spatial.ingest([tile]);
    };
    const fill = (
      x0: number,
      x1: number,
      y0: number,
      y1: number,
      owner: number,
    ) => {
      const tiles: number[] = [];
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) tiles.push(y * width + x);
      const gu = makeEmptyGu(1);
      gu.packedTileUpdates = Uint32Array.from(
        tiles.flatMap((tile) => [tile, owner | (128 << 16)]),
      );
      game.update(gu);
      spatial.ingest(tiles);
    };
    const neighbor = (troops = 10_000, tile = 12, id = 2) => {
      const gu = makeEmptyGu(1);
      gu.updates[GameUpdateType.Player] = [
        makePlayerUpdate({
          id: id === 2 ? "enemy" : `enemy-${id}`,
          clientID: `other-${id}`,
          smallID: id,
          troops,
        }),
      ];
      game.update(gu);
      observation.players.push({
        ...observation.players[0],
        id,
        name: "enemy",
        friendly: false,
        troops,
      });
      territory(tile, id);
    };
    const addUnit = (
      type: UnitType,
      tile: number,
      owner = 1,
      extra: Partial<AdvisorUnit> = {},
    ) => {
      const id = observation.units.length + 1;
      const gu = makeEmptyGu(1);
      gu.updates[GameUpdateType.Unit] = [
        makeUnitUpdate({
          id,
          unitType: type,
          pos: tile,
          ownerID: owner,
          underConstruction: extra.constructing,
          warshipState:
            type === UnitType.Warship
              ? {
                  state: "patrolling",
                  patrolTile: tile,
                  lastCombatTick: 0,
                  veterancy: 0,
                  veterancyProgress: 0,
                }
              : undefined,
        }),
      ];
      game.update(gu);
      observation.units.push({
        id,
        type,
        tile,
        owner,
        target: null,
        active: true,
        retreating: false,
        constructing: false,
        level: 1,
        ready: 1,
        range: 0,
        troops: 0,
        arrivalTick: null,
        ...extra,
      });
      return id;
    };
    return {
      game,
      query,
      emit,
      report,
      auto,
      spatial,
      observation,
      tick,
      flush,
      neighbor,
      territory,
      fill,
      addUnit,
    };
  }

  describe("automatic nuclear economy", () => {
    function economyFixture(silo = true) {
      const f = automaticFixture(300, true);
      f.observation.elapsed = 2000;
      f.observation.cap = 100_000;
      f.game.myPlayer()!.state.gold = 500_000_000;
      f.observation.gold = 500_000_000n;
      f.fill(0, 100, 0, 100, 1);
      f.neighbor(100_000, 75_250);
      f.addUnit(UnitType.City, 75_250, 2);
      f.addUnit(UnitType.City, 11);
      f.addUnit(UnitType.City, 18_060);
      f.addUnit(UnitType.Factory, 9_030);
      if (silo) f.addUnit(UnitType.MissileSilo, 30_050);
      f.query.mockImplementation(async (_id, x, y, types) => ({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: (types ?? [])
          .filter((type) =>
            [UnitType.MIRV, UnitType.MissileSilo, UnitType.City].includes(type),
          )
          .map((type) => ({
            type,
            canBuild: y! * 300 + x!,
            canUpgrade: false,
            cost: type === UnitType.City ? 100n : 100_000n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          })),
      }));
      const purchases = () =>
        f.emit.mock.calls
          .map(([event]) => event)
          .filter(
            (event): event is BuildUnitIntentEvent =>
              event instanceof BuildUnitIntentEvent &&
              [UnitType.MIRV, UnitType.MissileSilo].includes(event.unit),
          );
      const advanceEconomy = async (
        from: number,
        until: number,
        source: "tradeGold" | "trainGold" | null = "tradeGold",
      ) => {
        for (let tick = from; tick <= until; tick += 50) {
          if (source) f.game.myPlayer()!.state[source] = (tick - 2) * 100;
          f.tick(tick);
          await f.flush();
          if (source) f.game.myPlayer()!.state[source] = (tick - 1) * 100;
          f.tick(tick + 1);
          await f.flush();
        }
      };
      return { ...f, purchases, advanceEconomy };
    }

    it.each([true, false])(
      "withholds %s silo capability spending despite a rich treasury and windfalls",
      async (silo) => {
        const f = economyFixture(silo);
        f.auto.setEnabled(true);
        f.tick(2);
        await f.flush();
        f.tick(3);
        f.game.myPlayer()!.state.goldEarned = 500_000_000;
        f.game.myPlayer()!.state.piracyGold = 500_000_000;
        await f.advanceEconomy(53, 4003, null);
        expect(f.purchases()).toHaveLength(0);
        expect(
          f.emit.mock.calls.some(
            ([event]) =>
              event instanceof BuildUnitIntentEvent &&
              event.unit === UnitType.City,
          ),
        ).toBe(true);
      },
    );

    it.each(["tradeGold", "trainGold"] as const)(
      "funds launches from %s plus workers without spending the economy allocation",
      async (source) => {
        const f = economyFixture();
        f.auto.setEnabled(true);
        f.tick(2);
        await f.flush();
        f.tick(3);
        await f.advanceEconomy(53, 2403, source);
        expect(f.purchases()).toHaveLength(0);
        await f.advanceEconomy(2453, 3003, source);
        expect(f.purchases()).toHaveLength(1);
        expect(f.purchases()[0].unit).toBe(UnitType.MIRV);
        await f.advanceEconomy(3053, 4003, source);
        expect(f.purchases()).toHaveLength(2);
      },
    );

    it("funds the first offensive silo from recurring income rather than the treasury", async () => {
      const f = economyFixture(false);
      f.auto.setEnabled(true);
      f.tick(2);
      await f.flush();
      f.tick(3);
      await f.advanceEconomy(53, 2403);
      expect(f.purchases()).toHaveLength(0);
      await f.advanceEconomy(2453, 3003);
      expect(f.purchases()).toHaveLength(1);
      expect(f.purchases()[0].unit).toBe(UnitType.MissileSilo);
    });

    it("rechecks the treasury before dispatch and does not charge rejected purchases", async () => {
      const f = economyFixture();
      const implementation = f.query.getMockImplementation()!;
      let drained = false;
      f.query.mockImplementation(async (...args) => {
        const result = await implementation(...args);
        if (f.observation.tick >= 2453 && args[3]?.[0] === UnitType.MIRV) {
          f.game.myPlayer()!.state.gold = 180_000;
          drained = true;
        }
        return result;
      });
      f.auto.setEnabled(true);
      f.tick(2);
      await f.flush();
      f.tick(3);
      await f.advanceEconomy(53, 3003);
      expect(drained).toBe(true);
      expect(f.purchases()).toHaveLength(0);
      f.query.mockImplementation(implementation);
      f.game.myPlayer()!.state.gold = 500_000_000;
      await f.advanceEconomy(3053, 3303);
      expect(f.purchases()).toHaveLength(1);
    });

    it("uses the current worker price rather than a previously affordable quote", async () => {
      const f = economyFixture();
      const implementation = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (...args) => {
        const result = await implementation(...args);
        if (f.observation.tick >= 2403)
          for (const b of result.buildableUnits)
            if (b.type === UnitType.MIRV) b.cost = 200_000n;
        return result;
      });
      f.auto.setEnabled(true);
      f.tick(2);
      await f.flush();
      f.tick(3);
      await f.advanceEconomy(53, 4003);
      expect(f.purchases()).toHaveLength(0);
    });

    it("resets observation and allowance when automatic play is re-enabled", async () => {
      const f = economyFixture();
      f.auto.setEnabled(true);
      f.tick(2);
      await f.flush();
      f.tick(3);
      await f.advanceEconomy(53, 3003);
      expect(f.purchases()).toHaveLength(1);
      f.auto.setEnabled(false);
      f.auto.setEnabled(true);
      await f.advanceEconomy(3053, 4003);
      expect(f.purchases()).toHaveLength(1);
    });
  });

  describe("opt-in automatic play", () => {
    it("does nothing until enabled, checks eligibility, sends a bounded attack on the next tick and rate limits", async () => {
      const { auto, emit, query, tick, flush } = automaticFixture();
      tick(2);
      expect(query).not.toHaveBeenCalled();
      auto.setEnabled(true);
      tick(3);
      expect(emit).not.toHaveBeenCalled();
      await flush();
      tick(4);
      expect(emit).toHaveBeenCalledWith(
        new SendAttackIntentEvent(null, 25_000),
      );
      tick(5);
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it("counterattacks a hostile incoming push while keeping its troop reserve", async () => {
      const { auto, emit, tick, flush, neighbor, observation, game } =
        automaticFixture();
      neighbor(10_000);
      observation.players[0].incoming = 20_000;
      game.myPlayer()!.state.incomingAttacks = [
        {
          id: "incoming",
          attackerID: 2,
          targetID: 1,
          troops: 20_000,
          retreating: false,
        },
      ];
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendAttackIntentEvent("enemy", 20_000),
      );
    });

    it.each(["friendly", "retreating"])(
      "does not counterattack a %s incoming push",
      async (reason) => {
        const { auto, emit, tick, flush, neighbor, observation, game } =
          automaticFixture();
        neighbor(10_000);
        observation.players[0].incoming = 20_000;
        if (reason === "friendly") observation.players[1].friendly = true;
        game.myPlayer()!.state.incomingAttacks = [
          {
            id: "incoming",
            attackerID: 2,
            targetID: 1,
            troops: 20_000,
            retreating: reason === "retreating",
          },
        ];
        auto.setEnabled(true);
        tick(2);
        await flush();
        tick(3);
        expect(
          emit.mock.calls.some(
            ([event]) => event instanceof SendAttackIntentEvent,
          ),
        ).toBe(false);
      },
    );

    it.each(["disable", "replay", "gameover", "catchup", "spawn"])(
      "blocks pending actions after %s",
      async (reason) => {
        const { game, auto, tick, flush, emit } = automaticFixture();
        auto.setEnabled(true);
        tick(2);
        await flush();
        if (reason === "disable") auto.setEnabled(false);
        if (reason === "replay")
          vi.spyOn(game.config(), "isReplay").mockReturnValue(true);
        if (reason === "gameover")
          vi.spyOn(game, "gameOver").mockReturnValue(true);
        if (reason === "catchup")
          vi.spyOn(game, "isCatchingUp").mockReturnValue(true);
        if (reason === "spawn")
          vi.spyOn(game, "inSpawnPhase").mockReturnValue(true);
        tick(3);
        expect(emit).not.toHaveBeenCalled();
      },
    );

    it("can send an opted-in action in multiplayer", async () => {
      const { game, auto, tick, flush, emit } = automaticFixture();
      game.config().gameConfig().gameType = GameType.Public;
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendAttackIntentEvent(null, 25_000),
      );
    });

    it("does not send async results while simulation is paused or after they become stale", async () => {
      const { auto, tick, flush, emit } = automaticFixture();
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(2);
      expect(emit).not.toHaveBeenCalled();
      tick(20);
      expect(emit).not.toHaveBeenCalled();
    });

    it("reconsiders a commitment when a manual attack leaves too little reserve", async () => {
      const { auto, tick, flush, emit, game, observation } = automaticFixture();
      auto.setEnabled(true);
      tick(2);
      await flush();
      game.myPlayer()!.state.troops = 1000;
      observation.players[0].troops = 1000;
      tick(3);
      expect(emit).not.toHaveBeenCalled();
    });

    it("rejects illegal attacks and stops visibly on query failure", async () => {
      const { auto, tick, flush, emit, query, report } = automaticFixture();
      query.mockResolvedValue({
        canAttack: false,
        buildableUnits: [],
        canSendEmojiAllPlayers: false,
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).not.toHaveBeenCalled();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      query.mockRejectedValue(new Error("worker failure"));
      tick(200);
      await flush();
      expect(log).toHaveBeenCalled();
      expect(report).toHaveBeenLastCalledWith(false, "error");
    });

    it.each([UnitType.City, UnitType.Port, UnitType.Factory] as const)(
      "builds eligible %s with a spare-gold budget",
      async (type) => {
        const { auto, tick, flush, emit, query, observation, addUnit } =
          automaticFixture();
        observation.cap = 115_000;
        // An existing port keeps the first-port priority out of this check.
        addUnit(UnitType.Port, 88);
        if (type === UnitType.Factory) addUnit(UnitType.City, 11);
        observation.players[0].outgoing = 100_000;
        observation.builds = [
          { type, tile: 11, cost: 100n, affordable: true, connected: true },
        ];
        query.mockResolvedValue({
          canAttack: false,
          canSendEmojiAllPlayers: false,
          buildableUnits: [
            {
              type,
              canBuild: 11,
              canUpgrade: false,
              cost: 100n,
              ghostRailPaths: type === UnitType.Factory ? [[11, 12]] : [],
              overlappingRailroads: [],
            },
          ],
        });
        auto.setEnabled(true);
        tick(2);
        await flush();
        tick(3);
        expect(emit).toHaveBeenCalledWith(new BuildUnitIntentEvent(type, 11));
      },
    );

    it("does not spend gold that was spent manually while a build was being checked", async () => {
      const { auto, tick, flush, emit, query, observation, game } =
        automaticFixture();
      observation.cap = 100_000;
      observation.players[0].outgoing = 100_000;
      observation.builds = [
        {
          type: UnitType.City,
          tile: 11,
          cost: 100n,
          affordable: true,
          connected: true,
        },
      ];
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.City,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      game.myPlayer()!.state.gold = 0;
      tick(3);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe("automatic action categories", () => {
    it.each([1000, 50_000])(
      "permits capacity investment only under minor incoming land pressure (%s)",
      async (incoming) => {
        const { auto, tick, flush, emit, query, observation } =
          automaticFixture();
        observation.cap = 100_000;
        observation.players[0].incoming = incoming;
        query.mockResolvedValue({
          canAttack: true,
          canSendEmojiAllPlayers: false,
          buildableUnits: [
            {
              type: UnitType.City,
              canBuild: 11,
              canUpgrade: false,
              cost: 100n,
              ghostRailPaths: [],
              overlappingRailroads: [],
            },
          ],
        });
        auto.setEnabled(true);
        tick(2);
        await flush();
        tick(3);
        if (incoming === 1000)
          expect(emit).toHaveBeenCalledWith(
            new BuildUnitIntentEvent(UnitType.City, 11),
          );
        else expect(emit).not.toHaveBeenCalled();
        expect(
          emit.mock.calls.some(
            ([event]) => event instanceof SendAttackIntentEvent,
          ),
        ).toBe(false);
      },
    );

    it("prioritizes a newly detected landing over an economic action already checked", async () => {
      const { auto, tick, flush, emit, query, observation, neighbor, addUnit } =
        automaticFixture();
      observation.cap = 100_000;
      observation.players[0].outgoing = 100_000;
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.City,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      neighbor();
      addUnit(UnitType.TransportShip, 23, 2, { target: 11, troops: 10_000 });
      addUnit(UnitType.Warship, 22);
      tick(3);
      expect(emit).not.toHaveBeenCalled();
    });

    it("builds multiple distinct ports after opening instead of repeatedly upgrading one", async () => {
      const {
        auto,
        tick,
        flush,
        emit,
        query,
        observation,
        territory,
        addUnit,
      } = automaticFixture(128);
      observation.elapsed = 2000;
      observation.cap = 170_000;
      observation.players[0].outgoing = 100_000;
      for (let x = 1; x < 127; x++) territory(64 * 128 + x, 1);
      query.mockImplementation(async (_id, x, y) => ({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Port,
            canBuild: y! * 128 + x!,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      }));
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      const first = emit.mock.calls[0]?.[0];
      expect(first).toBeInstanceOf(BuildUnitIntentEvent);
      expect(first.unit).toBe(UnitType.Port);
      addUnit(UnitType.Port, first.tile);
      tick(33);
      await flush();
      tick(34);
      const second = emit.mock.calls[1]?.[0];
      expect(second.unit).toBe(UnitType.Port);
      expect(second.tile).not.toBe(first.tile);
      expect(
        Math.hypot(
          (second.tile % 128) - (first.tile % 128),
          Math.floor(second.tile / 128) - Math.floor(first.tile / 128),
        ),
      ).toBeGreaterThanOrEqual(15);
    });

    it.each([
      "paying-station",
      "no-preview",
      "foreign-station",
      "upgrade-only",
    ])("validates new factory railway evidence: %s", async (evidence) => {
      const {
        auto,
        tick,
        flush,
        emit,
        query,
        observation,
        territory,
        addUnit,
      } = automaticFixture(128);
      observation.elapsed = 2000;
      observation.cap = 170_000;
      observation.players[0].outgoing = 100_000;
      const city = 32 * 128 + 32;
      const site = city + 19;
      territory(city, 1);
      territory(site, 1);
      const id = addUnit(UnitType.City, city);
      for (const x of [1, 64, 100]) {
        const tile = 64 * 128 + x;
        territory(tile, 1);
        addUnit(UnitType.Port, tile);
      }
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Factory,
            canBuild: site,
            canUpgrade: evidence === "upgrade-only" ? id : false,
            cost: 100n,
            overlappingRailroads: [],
            ghostRailPaths:
              evidence === "no-preview"
                ? []
                : [[site, evidence === "foreign-station" ? 9000 : city]],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      if (evidence === "paying-station")
        expect(emit).toHaveBeenCalledWith(
          new BuildUnitIntentEvent(UnitType.Factory, site),
        );
      else expect(emit).not.toHaveBeenCalled();
    });

    it("ranks land targets by total relative strength rather than player ordering", async () => {
      const { auto, tick, flush, emit, neighbor, observation } =
        automaticFixture();
      observation.elapsed = 2000;
      neighbor(10_000, 12);
      neighbor(1000, 10, 3);
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendAttackIntentEvent("enemy-3", 20_000),
      );
    });

    it.each([
      "near-equal",
      "committed-strength",
      "already-attacking",
      "became-stronger",
    ])("does not add an attack against a %s target", async (reason) => {
      const { auto, tick, flush, emit, neighbor, observation, game } =
        automaticFixture();
      observation.elapsed = 2000;
      neighbor(reason === "near-equal" ? 95_000 : 5000);
      if (reason === "committed-strength")
        observation.players[1].outgoing = 80_000;
      if (reason === "already-attacking")
        game.myPlayer()!.state.outgoingAttacks = [
          {
            id: "existing",
            attackerID: 1,
            targetID: 2,
            troops: 1000,
            retreating: false,
          },
        ];
      auto.setEnabled(true);
      tick(2);
      await flush();
      if (reason === "became-stronger") observation.players[1].troops = 95_000;
      tick(3);
      expect(emit).not.toHaveBeenCalled();
    });

    it("prioritizes expansion at capacity, then falls back to a city if that attack is illegal", async () => {
      const { auto, tick, flush, emit, query, observation } =
        automaticFixture();
      observation.cap = 100_000;
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.City,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      expect(query).toHaveBeenLastCalledWith("me", 2, 1, null);
      await flush();
      tick(3);
      tick(12);
      await flush();
      tick(13);
      expect(emit).toHaveBeenCalledWith(
        new BuildUnitIntentEvent(UnitType.City, 11),
      );
    });

    it("adds capacity without waiting for a cached economy suggestion when no invasion is feasible", async () => {
      const { auto, tick, flush, emit, query, observation, territory } =
        automaticFixture();
      observation.cap = 100_000;
      territory(12, 1);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.City,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new BuildUnitIntentEvent(UnitType.City, 11),
      );
    });

    it("starts a funded economy investment immediately during opening expansion", async () => {
      const { auto, tick, flush, emit, query, observation } =
        automaticFixture();
      observation.builds = [
        {
          type: UnitType.Port,
          tile: 11,
          cost: 125_000n,
          affordable: true,
          connected: true,
        },
      ];
      query.mockResolvedValue({
        canAttack: true,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Port,
            canBuild: 11,
            canUpgrade: false,
            cost: 125_000n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new BuildUnitIntentEvent(UnitType.Port, 11),
      );
      tick(33);
      await flush();
      tick(34);
      expect(emit).toHaveBeenLastCalledWith(
        new SendAttackIntentEvent(null, 25_000),
      );
    });

    it("reserves economy turns even when opening expansion remains available", async () => {
      const { auto, tick, flush, emit, query } = automaticFixture();
      query.mockResolvedValue({
        canAttack: true,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Port,
            canBuild: 11,
            canUpgrade: false,
            cost: 125_000n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenLastCalledWith(
        new SendAttackIntentEvent(null, 25_000),
      );
      tick(103);
      await flush();
      tick(104);
      expect(emit).toHaveBeenLastCalledWith(
        new BuildUnitIntentEvent(UnitType.Port, 11),
      );
      tick(204);
      await flush();
      tick(205);
      expect(
        emit.mock.calls.filter(
          ([event]) => event instanceof BuildUnitIntentEvent,
        ),
      ).toHaveLength(2);
    });

    it("keeps considering economy upgrades without cached advice or high troop reserves", async () => {
      const { auto, tick, flush, emit, query, observation, addUnit } =
        automaticFixture();
      observation.cap = 250_000;
      observation.players[0].outgoing = 100_000;
      const port = addUnit(UnitType.Port, 11);
      query.mockImplementation(async (_id, _x, _y, types) => ({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: (types ?? []).map((type) => ({
          type,
          canBuild: false,
          canUpgrade: type === UnitType.Port ? port : false,
          cost: 125_000n,
          ghostRailPaths: [],
          overlappingRailroads: [],
        })),
      }));
      auto.setEnabled(true);
      for (
        let time = 2;
        time <= 62 && emit.mock.calls.length === 0;
        time += 10
      ) {
        tick(time);
        await flush();
        tick(time + 1);
      }
      expect(emit).toHaveBeenCalledWith(
        new SendUpgradeStructureIntentEvent(port, UnitType.Port, 1),
      );
    });

    it("yields an unaffordable economy turn without starving opening expansion", async () => {
      const { auto, tick, flush, emit, query } = automaticFixture();
      query.mockResolvedValue({
        canAttack: true,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Port,
            canBuild: 11,
            canUpgrade: false,
            cost: 400_001n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      tick(103);
      await flush();
      tick(104);
      expect(emit).toHaveBeenCalledTimes(1);
      tick(114);
      await flush();
      tick(115);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenLastCalledWith(
        new SendAttackIntentEvent(null, 25_000),
      );
    });

    it("builds a port, waits for construction, then builds a warship for a confirmed landing", async () => {
      const {
        auto,
        tick,
        flush,
        emit,
        query,
        observation,
        territory,
        neighbor,
        addUnit,
      } = automaticFixture(100);
      territory(5050, 1);
      neighbor(1000, 12);
      addUnit(UnitType.TransportShip, 5250, 2, {
        target: 5050,
        troops: 10_000,
      });
      query.mockImplementation(async () => ({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Port,
            canBuild: 5050,
            canUpgrade: false,
            cost: 400_000n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
          {
            type: UnitType.Warship,
            canBuild: 5050,
            canUpgrade: false,
            cost: 400_000n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      }));
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenLastCalledWith(
        new BuildUnitIntentEvent(UnitType.Port, 5050),
      );
      addUnit(UnitType.Port, 5050, 1, { constructing: true });
      tick(33);
      await flush();
      tick(34);
      expect(emit).toHaveBeenCalledTimes(1);
      observation.units[1].constructing = false;
      tick(44);
      await flush();
      tick(45);
      const event = emit.mock.calls[1]?.[0];
      expect(event).toBeInstanceOf(BuildUnitIntentEvent);
      expect(event.unit).toBe(UnitType.Warship);
      expect(event.tile).not.toBe(5050);
    });

    it("ignores a port in disconnected water and builds on the threatened shore instead", async () => {
      const { auto, tick, flush, emit, query, territory, neighbor, addUnit } =
        automaticFixture(100);
      for (let x = 0; x < 100; x++) territory(5000 + x, 0);
      territory(7050, 1);
      addUnit(UnitType.Port, 11);
      neighbor(1000, 12);
      addUnit(UnitType.TransportShip, 7250, 2, {
        target: 7050,
        troops: 10_000,
      });
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Port,
            canBuild: 7050,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new BuildUnitIntentEvent(UnitType.Port, 7050),
      );
    });

    it("rejects an emergency port result on a different sea", async () => {
      const { auto, tick, flush, emit, query, territory, neighbor, addUnit } =
        automaticFixture(100);
      for (let x = 0; x < 100; x++) territory(5000 + x, 0);
      territory(7050, 1);
      neighbor(1000, 12);
      addUnit(UnitType.TransportShip, 7250, 2, {
        target: 7050,
        troops: 10_000,
      });
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Port,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).not.toHaveBeenCalled();
    });

    it("reduces a pending tribe attack to the normal policy when the opening phase ends", async () => {
      const { auto, tick, flush, emit, observation, neighbor } =
        automaticFixture();
      neighbor(5000);
      observation.players[1].type = PlayerType.Bot;
      auto.setEnabled(true);
      tick(2);
      await flush();
      observation.elapsed = 1800;
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendAttackIntentEvent("enemy", 20_000),
      );
    });

    it("keeps the opening reserve floor on neutral expansion too", async () => {
      const { auto, tick, flush, emit, observation, game } = automaticFixture();
      observation.players[0].troops = 67_500;
      game.myPlayer()!.state.troops = 67_500;
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendAttackIntentEvent(null, 15_000),
      );
      expect(67_500 - emit.mock.calls[0][0].troops).toBe(
        observation.cap * 0.35,
      );
    });

    it("prefers free land over a weak tribe and keeps the opening reserve floor", async () => {
      const {
        auto,
        tick,
        flush,
        emit,
        observation,
        neighbor,
        territory,
        game,
      } = automaticFixture();
      neighbor(5000);
      observation.players[1].type = PlayerType.Bot;
      territory(10, 0);
      observation.players[0].troops = 67_500;
      game.myPlayer()!.state.troops = 67_500;
      observation.players[0].outgoing = 20_000;
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendAttackIntentEvent(null, 15_000),
      );
      expect(67_500 - emit.mock.calls[0][0].troops).toBeGreaterThanOrEqual(
        observation.cap * 0.35,
      );
    });

    it("pushes free-land expansion harder while no coast is owned yet", async () => {
      const { auto, tick, flush, emit, territory, spatial } =
        automaticFixture();
      for (const tile of [0, 1, 2, 10, 20, 21, 22]) territory(tile, 0);
      expect(spatial.coast.size).toBe(0);
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendAttackIntentEvent(null, 35_000),
      );
    });

    it("attacks a much weaker bordering nation with a decisive force", async () => {
      const { auto, tick, flush, emit, observation, neighbor, game } =
        automaticFixture();
      observation.elapsed = 2000;
      observation.cap = 430_000;
      observation.players[0].troops = 300_000;
      game.myPlayer()!.state.troops = 300_000;
      neighbor(50_000);
      observation.players[1].type = PlayerType.Nation;
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendAttackIntentEvent("enemy", 75_000),
      );
    });

    it("keeps a second island push available while a transport is heading to another rival", async () => {
      const { auto, tick, flush, emit, neighbor, addUnit } = overseasFixture(2);
      neighbor(1000, 32, 3);
      addUnit(UnitType.TransportShip, 21, 1, { target: 92 });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendBoatAttackIntentEvent(32, 20_000),
      );
    });

    it.each([true, false])(
      "exploits the traitor defense debuff (traitor: %s)",
      async (traitor) => {
        const { auto, tick, flush, emit, observation, neighbor } =
          automaticFixture();
        observation.elapsed = 2000;
        neighbor(40_000);
        observation.players[1].type = PlayerType.Nation;
        observation.players[1].traitor = traitor;
        auto.setEnabled(true);
        tick(2);
        await flush();
        tick(3);
        if (traitor)
          expect(emit).toHaveBeenCalledWith(
            new SendAttackIntentEvent("enemy", 30_000),
          );
        else
          expect(emit).toHaveBeenCalledWith(
            new SendAttackIntentEvent("enemy", 40_000),
          );
      },
    );

    it("connects a cluster of unlinked cities with a factory in rail range", async () => {
      const { auto, tick, flush, emit, query, observation, fill, addUnit } =
        automaticFixture(128);
      observation.elapsed = 2000;
      observation.cap = 170_000;
      observation.players[0].outgoing = 100_000;
      fill(20, 80, 10, 54, 1);
      const cities = [32 * 128 + 32, 32 * 128 + 60];
      for (const city of cities) addUnit(UnitType.City, city);
      query.mockImplementation(async (_id, x, y) => ({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Factory,
            canBuild: y! * 128 + x!,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [[y! * 128 + x!, cities[0]]],
            overlappingRailroads: [],
          },
        ],
      }));
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      const event = emit.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(BuildUnitIntentEvent);
      expect(event.unit).toBe(UnitType.Factory);
      for (const city of cities)
        expect(
          Math.hypot(
            (event.tile % 128) - (city % 128),
            Math.floor(event.tile / 128) - Math.floor(city / 128),
          ),
        ).toBeLessThanOrEqual(110);
    });

    it("places new capacity cities in range of an existing factory", async () => {
      const { auto, tick, flush, emit, query, observation, fill, addUnit } =
        automaticFixture(128);
      observation.elapsed = 2000;
      observation.cap = 100_000;
      observation.players[0].outgoing = 100_000;
      fill(10, 90, 10, 90, 1);
      const factory = 50 * 128 + 50;
      addUnit(UnitType.Factory, factory);
      query.mockImplementation(async (_id, x, y) => ({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.City,
            canBuild: y! * 128 + x!,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      }));
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      const event = emit.mock.calls[0]?.[0];
      expect(event.unit).toBe(UnitType.City);
      expect(
        Math.hypot((event.tile % 128) - 50, Math.floor(event.tile / 128) - 50),
      ).toBeLessThanOrEqual(110);
    });

    it("builds a frontier factory that links to a foreign city by rail", async () => {
      const {
        auto,
        tick,
        flush,
        emit,
        query,
        observation,
        fill,
        neighbor,
        addUnit,
        game,
      } = automaticFixture(128);
      observation.elapsed = 2000;
      observation.cap = 170_000;
      observation.players[0].outgoing = 100_000;
      fill(10, 60, 10, 54, 1);
      neighbor(50_000, 61 * 128 + 61);
      fill(61, 100, 10, 54, 2);
      const foreign = 32 * 128 + 80;
      addUnit(UnitType.City, foreign, 2);
      addUnit(UnitType.Port, 10 * 128 + 10);
      query.mockImplementation(async (_id, x, y) => ({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Factory,
            canBuild: y! * 128 + x!,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [[y! * 128 + x!, foreign]],
            overlappingRailroads: [],
          },
        ],
      }));
      auto.setEnabled(true);
      let event: BuildUnitIntentEvent | undefined;
      for (let t = 2; t < 1000 && !event; t++) {
        tick(t);
        await flush();
        event = emit.mock.calls.find(
          ([e]) =>
            e instanceof BuildUnitIntentEvent && e.unit === UnitType.Factory,
        )?.[0];
      }
      expect(event).toBeDefined();
      expect(game.ownerID(event!.tile)).toBe(1);
      expect(
        Math.hypot(
          (event!.tile % 128) - 80,
          Math.floor(event!.tile / 128) - 32,
        ),
      ).toBeLessThanOrEqual(110);
    });

    it.each([
      "nation",
      "late",
      "low-reserve",
      "overcommitted",
      "incoming",
      "defended",
      "strong-tribe",
      "strong-neighbor",
    ])("withholds faster tribe expansion when %s", async (reason) => {
      const { auto, tick, flush, emit, observation, neighbor, game, addUnit } =
        automaticFixture();
      neighbor(5000);
      observation.players[1].type = PlayerType.Bot;
      observation.players[0].troops = 67_500;
      game.myPlayer()!.state.troops = 67_500;
      if (reason === "nation") observation.players[1].type = PlayerType.Nation;
      if (reason === "late") observation.elapsed = 1800;
      if (reason === "low-reserve") {
        observation.players[0].troops = 67_499;
        game.myPlayer()!.state.troops = 67_499;
      }
      if (reason === "overcommitted") observation.players[0].outgoing = 33_750;
      if (reason === "incoming") observation.players[0].incoming = 1;
      if (reason === "defended")
        addUnit(UnitType.DefensePost, 12, 2, { range: 30 });
      if (reason === "strong-tribe") observation.players[1].troops = 40_000;
      if (reason === "strong-neighbor") {
        observation.players[1].type = PlayerType.Human;
        observation.players[1].troops = 80_000;
      }
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).not.toHaveBeenCalled();
    });

    it("sends up to 30% to a weak tribe and repeats faster only after the opening cooldown", async () => {
      const { auto, tick, flush, emit, observation, neighbor, addUnit } =
        automaticFixture();
      neighbor(5000);
      observation.players[1].type = PlayerType.Bot;
      // An existing port keeps the first-port priority out of this sequence.
      addUnit(UnitType.Port, 88);
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendAttackIntentEvent("enemy", 30_000),
      );
      tick(18);
      expect(emit).toHaveBeenCalledTimes(1);
      tick(33);
      await flush();
      tick(34);
      expect(emit).toHaveBeenCalledTimes(2);
    });

    it("builds a warship using a water patrol target, not its source port", async () => {
      const { auto, tick, flush, emit, neighbor, addUnit, query } =
        automaticFixture();
      neighbor();
      addUnit(UnitType.TransportShip, 23, 2, { target: 11, troops: 10_000 });
      addUnit(UnitType.Port, 11);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Warship,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      const event = emit.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(BuildUnitIntentEvent);
      expect(event.unit).toBe(UnitType.Warship);
      expect(event.tile).not.toBe(11);
    });

    it.each(["weak", "reclaim"] as const)(
      "attacks an eligible %s neighbor without exhausting reserves",
      async (kind) => {
        const { auto, tick, flush, emit, observation, neighbor } =
          automaticFixture();
        neighbor();
        if (kind === "reclaim") {
          observation.players[0].team = "red";
          observation.players[1].team = "red";
          observation.players[1].disconnected = true;
        }
        auto.setEnabled(true);
        tick(2);
        await flush();
        tick(3);
        expect(emit).toHaveBeenCalledWith(
          new SendAttackIntentEvent(
            "enemy",
            kind === "reclaim" ? 10_000 : 20_000,
          ),
        );
      },
    );

    it("retracts an attack when its target becomes an ally", async () => {
      const { auto, tick, flush, emit, observation, neighbor } =
        automaticFixture();
      neighbor();
      auto.setEnabled(true);
      tick(2);
      await flush();
      observation.players[1].friendly = true;
      tick(3);
      expect(emit).not.toHaveBeenCalled();
    });

    it("uses the returned upgrade id instead of building on an existing city", async () => {
      const { auto, tick, flush, emit, query, observation, addUnit } =
        automaticFixture();
      observation.cap = 100_000;
      observation.players[0].outgoing = 100_000;
      observation.builds = [
        {
          type: UnitType.City,
          tile: 11,
          cost: 100n,
          affordable: true,
          connected: true,
        },
      ];
      const id = addUnit(UnitType.City, 11);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.City,
            canBuild: false,
            canUpgrade: id,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendUpgradeStructureIntentEvent(id, UnitType.City, 1),
      );
    });

    it("builds defensive SAM coverage when hostile silos exist", async () => {
      const { auto, tick, flush, emit, query, neighbor, addUnit } =
        automaticFixture();
      neighbor();
      addUnit(UnitType.MissileSilo, 12, 2);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.SAMLauncher,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new BuildUnitIntentEvent(UnitType.SAMLauncher, 11),
      );
    });

    it("keeps bounded nearby pushes available during an active nuclear threat", async () => {
      const { auto, tick, flush, emit, query, neighbor, addUnit } =
        automaticFixture();
      neighbor(10_000);
      addUnit(UnitType.AtomBomb, 11, 2, { target: 11, range: 1 });
      addUnit(UnitType.SAMLauncher, 11, 1, { range: 70 });
      query.mockResolvedValue({
        canAttack: true,
        canSendEmojiAllPlayers: false,
        buildableUnits: [],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendAttackIntentEvent("enemy", 20_000),
      );
    });

    it("continues safe economy building during an active nuclear threat", async () => {
      const {
        auto,
        tick,
        flush,
        emit,
        query,
        neighbor,
        addUnit,
        observation,
        spatial,
      } = automaticFixture();
      neighbor(100_000);
      addUnit(UnitType.AtomBomb, 11, 2, { target: 11, range: 1 });
      addUnit(UnitType.SAMLauncher, 11, 1, { range: 70 });
      spatial.coast.clear();
      observation.cap = 115_000;
      observation.builds = [
        {
          type: UnitType.City,
          tile: 11,
          cost: 100n,
          affordable: true,
          connected: true,
        },
      ];
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.City,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new BuildUnitIntentEvent(UnitType.City, 11),
      );
    });

    it("moves a connected own warship to a confirmed hostile landing", async () => {
      const { auto, tick, flush, emit, neighbor, addUnit } = automaticFixture();
      neighbor();
      addUnit(UnitType.TransportShip, 23, 2, { target: 11, troops: 10_000 });
      const ship = addUnit(UnitType.Warship, 22);
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(new MoveWarshipIntentEvent([ship], 23));
    });

    it("builds a warship near a landing before moving a distant ship", async () => {
      const { auto, tick, flush, emit, query, territory, addUnit, game } =
        automaticFixture(300);
      territory(75250, 1);
      addUnit(UnitType.Port, 75250);
      addUnit(UnitType.TransportShip, 75253, 2, {
        target: 75250,
        troops: 10_000,
      });
      addUnit(UnitType.Warship, 1000);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Warship,
            canBuild: 75250,
            canUpgrade: false,
            cost: 400_000n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      const event = emit.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(BuildUnitIntentEvent);
      expect(event.unit).toBe(UnitType.Warship);
      expect(game.isLand(event.tile)).toBe(false);
      expect(
        Math.hypot(game.x(event.tile) - 250, game.y(event.tile) - 250),
      ).toBeLessThanOrEqual(2);
    });

    it("follows a transport that moves while the warship check is pending", async () => {
      const { auto, tick, flush, emit, neighbor, addUnit, observation } =
        automaticFixture();
      neighbor();
      const boat = addUnit(UnitType.TransportShip, 23, 2, {
        target: 11,
        troops: 10_000,
      });
      const ship = addUnit(UnitType.Warship, 22);
      auto.setEnabled(true);
      tick(2);
      await flush();
      observation.units.find((u) => u.id === boat)!.tile = 24;
      tick(3);
      expect(emit).toHaveBeenCalledWith(new MoveWarshipIntentEvent([ship], 24));
    });

    it("requests a legal alliance with a stronger neighbor", async () => {
      const { auto, tick, flush, emit, neighbor, query, game } =
        automaticFixture();
      neighbor(200_000);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [],
        interaction: {
          sharedBorder: true,
          canSendEmoji: false,
          canSendAllianceRequest: true,
          canBreakAlliance: false,
          canTarget: false,
          canDonateGold: false,
          canDonateTroops: false,
          canEmbargo: false,
        },
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendAllianceRequestIntentEvent(
          game.myPlayer()!,
          game.player("enemy"),
        ),
      );
    });

    it("launches one legal transport toward a weak nonadjacent port", async () => {
      const {
        auto,
        tick,
        flush,
        emit,
        neighbor,
        addUnit,
        territory,
        query,
        observation,
      } = automaticFixture();
      addUnit(UnitType.Warship, 21);
      observation.cap = 120_000;
      territory(12, 1);
      neighbor(1000, 92);
      addUnit(UnitType.Port, 11);
      addUnit(UnitType.Port, 92, 2);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.TransportShip,
            canBuild: 92,
            canUpgrade: false,
            cost: 0n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledWith(
        new SendBoatAttackIntentEvent(92, 20_000),
      );
    });

    function overseasFixture(owner = 0, troops = 1000) {
      const f = automaticFixture();
      f.observation.cap = 100_000;
      f.territory(12, 1);
      if (owner === 0) f.territory(92, 0);
      else f.neighbor(troops, 92);
      f.query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.TransportShip,
            canBuild: 11,
            canUpgrade: false,
            cost: 0n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      return f;
    }

    it("invades a nearer owned island before a farther unclaimed island", async () => {
      const { auto, tick, flush, emit, territory } = overseasFixture(2);
      territory(32, 2);
      territory(92, 0);
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new SendBoatAttackIntentEvent(32, 20_000),
      );
    });

    it.each([2, 1002, 12002])(
      "prefers a nearby unclaimed island over a distant enemy at tick %s",
      async (start) => {
        const { auto, tick, flush, emit, territory } = overseasFixture(2);
        territory(32, 0);
        auto.setEnabled(true);
        tick(start);
        await flush();
        tick(start + 1);
        expect(emit).toHaveBeenCalledExactlyOnceWith(
          new SendBoatAttackIntentEvent(32, 15_000),
        );
      },
    );

    it.each([false, true])(
      "prefers a nearer viable enemy over a weaker distant enemy with traitor=%s",
      async (traitor) => {
        const { auto, tick, flush, emit, neighbor, observation } =
          overseasFixture(2);
        observation.players[1].traitor = traitor;
        neighbor(10_000, 32, 3);
        auto.setEnabled(true);
        tick(2);
        await flush();
        tick(3);
        expect(emit).toHaveBeenCalledExactlyOnceWith(
          new SendBoatAttackIntentEvent(32, 20_000),
        );
      },
    );

    it("ranks islands from the full coastline, including beyond the eight sampled regions", async () => {
      const { auto, tick, flush, emit, territory, query, spatial } =
        automaticFixture(640);
      territory(12, 1);
      for (let cell = 0; cell < 10; cell++) territory(64 * 640 + cell * 64, 1);
      const near = 68 * 640 + 576;
      const far = 10 * 640 + 11;
      territory(near, 0);
      territory(far, 0);
      expect(spatial.coastalSites(0)).not.toContain(64 * 640 + 576);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.TransportShip,
            canBuild: 64 * 640 + 576,
            canUpgrade: false,
            cost: 0n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(12002);
      await flush();
      tick(12003);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new SendBoatAttackIntentEvent(near, 15_000),
      );
    });

    it("prefers the nearest unclaimed island for a transport landing", async () => {
      const { auto, tick, flush, emit, territory } = overseasFixture();
      territory(92, 0);
      territory(32, 0);
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new SendBoatAttackIntentEvent(32, 15_000),
      );
    });

    it("prefers the nearby owned island when enemies have equal strength", async () => {
      const { auto, tick, flush, emit, neighbor } = overseasFixture(2);
      neighbor(1000, 32, 3);
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new SendBoatAttackIntentEvent(32, 20_000),
      );
    });

    it("samples nearby enemy shores before distant ones of the same owner", async () => {
      const { auto, tick, flush, emit, territory } = overseasFixture(2);
      territory(32, 2);
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new SendBoatAttackIntentEvent(32, 20_000),
      );
    });

    it.each([
      "normal",
      "defended",
      "traitor",
      "teammate",
      "commitments",
      "home-reserve",
      "insufficient-force",
    ])("uses identical land and boat invasion rules: %s", async (scenario) => {
      for (const kind of ["land", "boat"]) {
        const {
          auto,
          tick,
          flush,
          emit,
          territory,
          observation,
          addUnit,
          query,
          game,
        } = overseasFixture(
          2,
          scenario === "insufficient-force" ? 50_000 : 10_000,
        );
        observation.elapsed = 2000;
        const target = kind === "land" ? 12 : 92;
        if (kind === "land") {
          territory(92, 1);
          territory(12, 2);
        }
        if (scenario === "defended")
          addUnit(UnitType.DefensePost, target, 2, { range: 0 });
        if (scenario === "traitor") observation.players[1].traitor = true;
        if (scenario === "teammate") {
          observation.players[0].team = observation.players[1].team = "team";
          observation.players[1].disconnected = true;
        }
        if (scenario === "commitments")
          observation.players[0].outgoing = 10_000;
        if (scenario === "home-reserve") observation.cap = 200_000;
        if (scenario === "insufficient-force") {
          observation.players[0].troops = 70_000;
          game.myPlayer()!.state.troops = 70_000;
        }
        if (kind === "land")
          query.mockResolvedValue({
            canAttack: true,
            canSendEmojiAllPlayers: false,
            buildableUnits: [],
          });
        auto.setEnabled(true);
        tick(2);
        await flush();
        tick(3);
        if (scenario === "insufficient-force") {
          expect(emit).not.toHaveBeenCalled();
          continue;
        }
        const troops =
          scenario === "teammate"
            ? 10_000
            : scenario === "defended"
              ? 30_000
              : 20_000;
        expect(emit).toHaveBeenCalledExactlyOnceWith(
          kind === "land"
            ? new SendAttackIntentEvent("enemy", troops)
            : new SendBoatAttackIntentEvent(target, troops),
        );
      }
    });

    it("makes a bounded push against a weaker enemy when a decisive force is unavailable", async () => {
      const { auto, tick, flush, emit, game, observation } = overseasFixture(
        2,
        50_000,
      );
      observation.elapsed = 2000;
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new SendBoatAttackIntentEvent(92, 40_000),
      );
      expect(game.myPlayer()!.troops() - 40_000).toBeGreaterThanOrEqual(35_000);
    });

    it("can land on an island even when its owner also shares a land frontier", async () => {
      const { auto, tick, flush, emit, territory, query } = overseasFixture(2);
      territory(12, 2);
      query.mockResolvedValueOnce({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).not.toHaveBeenCalled();
      tick(12);
      await flush();
      tick(13);
      expect(emit).toHaveBeenCalledWith(
        new SendBoatAttackIntentEvent(92, 20_000),
      );
    });

    it.each([0, 2])(
      "launches to a portless shore owned by %s before capacity or economy spending",
      async (owner) => {
        const { auto, tick, flush, emit, query, addUnit, observation } =
          overseasFixture(owner);
        observation.builds.push({
          type: UnitType.City,
          tile: 11,
          cost: 100n,
          affordable: true,
          connected: true,
        });
        auto.setEnabled(true);
        tick(2);
        expect(query).toHaveBeenLastCalledWith("me", 2, 9, [
          UnitType.TransportShip,
        ]);
        expect(emit).not.toHaveBeenCalled();
        await flush();
        tick(3);
        expect(emit).toHaveBeenCalledExactlyOnceWith(
          new SendBoatAttackIntentEvent(92, owner === 0 ? 15_000 : 20_000),
        );
        addUnit(UnitType.TransportShip, 21, 1, { target: 92 });
        tick(103);
        await flush();
        tick(104);
        expect(
          emit.mock.calls.filter(
            ([event]) => event instanceof SendBoatAttackIntentEvent,
          ),
        ).toHaveLength(1);
      },
    );

    it("sizes a landing stack for a weaker enemy while preserving home reserves", async () => {
      const { auto, tick, flush, emit, observation } = overseasFixture(
        2,
        20_000,
      );
      observation.players[1].outgoing = 5000;
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new SendBoatAttackIntentEvent(92, 37_500),
      );
    });

    it.each([
      "friendly",
      "team",
      "disconnected",
      "dead",
      "strong",
      "incoming",
      "overcommitted",
      "low-reserve",
      "existing-transport",
      "fallout",
    ])("does not launch at an unsafe overseas target: %s", async (reason) => {
      const { auto, tick, flush, emit, observation, addUnit, game, spatial } =
        overseasFixture(2);
      const me = observation.players[0];
      const enemy = observation.players[1];
      if (reason === "friendly") enemy.friendly = true;
      if (reason === "team") me.team = enemy.team = "team";
      if (reason === "disconnected") enemy.disconnected = true;
      if (reason === "dead") enemy.alive = false;
      if (reason === "strong") enemy.troops = 70_000;
      if (reason === "incoming") me.incoming = 1000;
      if (reason === "overcommitted") me.outgoing = 35_000;
      if (reason === "low-reserve") observation.cap = 200_001;
      if (reason === "existing-transport")
        addUnit(UnitType.TransportShip, 21, 1, { target: 92 });
      if (reason === "fallout") {
        const gu = makeEmptyGu(1);
        gu.packedTileUpdates = Uint32Array.from([
          92,
          2 | (1 << 13) | (128 << 16),
        ]);
        game.update(gu);
        spatial.ingest([92]);
      }
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(
        emit.mock.calls.some(
          ([event]) => event instanceof SendBoatAttackIntentEvent,
        ),
      ).toBe(false);
    });

    it.each(["ownership", "strength", "friendship", "reserve"])(
      "rechecks overseas %s before dispatch",
      async (change) => {
        const { auto, tick, flush, emit, territory, observation } =
          overseasFixture(2);
        auto.setEnabled(true);
        tick(2);
        await flush();
        if (change === "ownership") territory(92, 1);
        if (change === "strength") observation.players[1].troops = 100_000;
        if (change === "friendship") observation.players[1].friendly = true;
        if (change === "reserve") observation.cap = 200_001;
        tick(3);
        expect(emit).not.toHaveBeenCalled();
      },
    );

    it.each([
      [200_000, true],
      [200_001, false],
    ])(
      "requires at least 50%% reserve like land invasions (capacity %s)",
      async (cap, launches) => {
        const { auto, tick, flush, emit, observation } = overseasFixture();
        observation.cap = cap;
        auto.setEnabled(true);
        tick(2);
        await flush();
        tick(3);
        expect(
          emit.mock.calls.some(
            ([event]) => event instanceof SendBoatAttackIntentEvent,
          ),
        ).toBe(launches);
      },
    );

    it("prefers adjacent neutral expansion over an overseas landing", async () => {
      const { auto, tick, flush, emit, territory, query } = overseasFixture();
      territory(12, 0);
      query.mockResolvedValue({
        canAttack: true,
        canSendEmojiAllPlayers: false,
        buildableUnits: [],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new SendAttackIntentEvent(null, 25_000),
      );
    });

    it("falls through to capacity investment when no overseas route is legal", async () => {
      const { auto, tick, flush, emit, query } = overseasFixture();
      query.mockImplementation(async (_id, _x, _y, types) => ({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: types![0],
            canBuild: types![0] === UnitType.TransportShip ? false : 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      }));
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).not.toHaveBeenCalled();
      tick(12);
      await flush();
      tick(13);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new BuildUnitIntentEvent(UnitType.City, 11),
      );
    });

    it("tries another coast after a rejected route instead of getting stuck", async () => {
      const { auto, tick, flush, emit, query, territory } = overseasFixture(2);
      territory(94, 2);
      query.mockResolvedValueOnce({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.TransportShip,
            canBuild: false,
            canUpgrade: false,
            cost: 0n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).not.toHaveBeenCalled();
      tick(12);
      expect(query).toHaveBeenLastCalledWith("me", 4, 9, [
        UnitType.TransportShip,
      ]);
      await flush();
      tick(13);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new SendBoatAttackIntentEvent(94, 20_000),
      );
    });

    it.each([false, true])(
      "handles a checked nuclear launch with friendly blast overlap=%s",
      async (overlap) => {
        const {
          auto,
          tick,
          flush,
          emit,
          neighbor,
          addUnit,
          query,
          observation,
          territory,
        } = automaticFixture(100);
        observation.cap = 125_000;
        observation.players[0].outgoing = 100_000;
        neighbor(10_000, 8800);
        observation.players[1].outgoing = 0;
        addUnit(UnitType.MissileSilo, 8800, 2);
        addUnit(UnitType.MissileSilo, 11);
        addUnit(UnitType.SAMLauncher, 11, 1, { range: 70 });
        query.mockResolvedValue({
          canAttack: false,
          canSendEmojiAllPlayers: false,
          buildableUnits: [
            {
              type: UnitType.AtomBomb,
              canBuild: 11,
              canUpgrade: false,
              cost: 100n,
              ghostRailPaths: [],
              overlappingRailroads: [],
            },
          ],
        });
        auto.setEnabled(true);
        tick(2);
        await flush();
        if (overlap) territory(8801, 1);
        tick(3);
        if (overlap) expect(emit).not.toHaveBeenCalled();
        else
          expect(emit).toHaveBeenCalledWith(
            new BuildUnitIntentEvent(UnitType.AtomBomb, 8800),
          );
      },
    );

    it.each(["silo", "SAM", "level", "unprotected", "nearby"] as const)(
      "prioritizes nuclear target infrastructure by %s",
      async (priority) => {
        const {
          auto,
          tick,
          flush,
          emit,
          query,
          observation,
          neighbor,
          addUnit,
          territory,
        } = automaticFixture(300);
        observation.cap = 125_000;
        observation.players[0].outgoing = 100_000;
        const near = 30100;
        const far = 75250;
        neighbor(10_000, near);
        observation.players[1].outgoing = 0;
        territory(far, 2);
        addUnit(UnitType.MissileSilo, 11);
        addUnit(UnitType.SAMLauncher, 11, 1, { range: 400 });
        const expected = priority === "nearby" ? near : far;
        if (priority === "silo") {
          addUnit(UnitType.City, near, 2, { level: 10 });
          addUnit(UnitType.MissileSilo, far, 2);
        } else if (priority === "SAM") {
          addUnit(UnitType.City, near, 2, { level: 10 });
          addUnit(UnitType.SAMLauncher, far, 2);
        } else if (priority === "level") {
          addUnit(UnitType.City, near, 2);
          addUnit(UnitType.Factory, far, 2, { level: 8 });
        } else if (priority === "unprotected") {
          addUnit(UnitType.City, near, 2, { level: 10 });
          addUnit(UnitType.Factory, far, 2, { level: 3 });
          const samTile = near + 100;
          territory(samTile, 2);
          addUnit(UnitType.TransportShip, samTile);
          addUnit(UnitType.SAMLauncher, samTile, 2, { range: 100 });
        } else {
          addUnit(UnitType.Factory, far, 2, { level: 8 });
          addUnit(UnitType.Factory, near, 2, { level: 3 });
        }
        query.mockResolvedValue({
          canAttack: false,
          canSendEmojiAllPlayers: false,
          buildableUnits: [
            {
              type: UnitType.AtomBomb,
              canBuild: 11,
              canUpgrade: false,
              cost: 100n,
              ghostRailPaths: [],
              overlappingRailroads: [],
            },
          ],
        });
        auto.setEnabled(true);
        tick(2);
        await flush();
        tick(3);
        expect(query).toHaveBeenLastCalledWith(
          "me",
          expected % 300,
          Math.floor(expected / 300),
          [UnitType.AtomBomb],
        );
        expect(emit).toHaveBeenCalledExactlyOnceWith(
          new BuildUnitIntentEvent(UnitType.AtomBomb, expected),
        );
      },
    );

    it("builds a standing coastal patrol before an invasion is launched", async () => {
      const {
        auto,
        tick,
        flush,
        emit,
        neighbor,
        addUnit,
        query,
        observation,
        game,
      } = automaticFixture();
      observation.elapsed = 2000;
      neighbor(100_000);
      addUnit(UnitType.Port, 11);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.Warship,
            canBuild: 11,
            canUpgrade: false,
            cost: 250_000n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      const event = emit.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(BuildUnitIntentEvent);
      expect(event.unit).toBe(UnitType.Warship);
      expect(game.isLand(event.tile)).toBe(false);
    });

    it.each([false, true])(
      "does not duplicate a coastal patrol while constructing=%s",
      async (constructing) => {
        const { auto, tick, flush, query, neighbor, addUnit, observation } =
          automaticFixture();
        observation.elapsed = 2000;
        neighbor(100_000);
        addUnit(UnitType.Port, 11);
        addUnit(UnitType.Warship, 21, 1, { constructing });
        auto.setEnabled(true);
        tick(2);
        await flush();
        expect(
          query.mock.calls.every(
            (call) => !call[3]?.includes(UnitType.Warship),
          ),
        ).toBe(true);
      },
    );

    it("caps standing patrols at one warship per three completed Ports", async () => {
      const {
        auto,
        tick,
        flush,
        query,
        neighbor,
        addUnit,
        territory,
        observation,
      } = automaticFixture(300);
      observation.elapsed = 2000;
      neighbor(100_000, 75250);
      for (const port of [30100, 50100, 70100]) {
        territory(port, 1);
        addUnit(UnitType.Port, port);
      }
      addUnit(UnitType.Warship, 1000);
      auto.setEnabled(true);
      tick(2);
      await flush();
      expect(
        query.mock.calls.every((call) => !call[3]?.includes(UnitType.Warship)),
      ).toBe(true);
    });

    it("defends a second invasion when the first already has an assigned ship", async () => {
      const { auto, tick, flush, emit, neighbor, addUnit } = automaticFixture();
      neighbor();
      addUnit(UnitType.TransportShip, 23, 2, {
        target: 11,
        arrivalTick: 20,
      });
      addUnit(UnitType.Warship, 23);
      addUnit(UnitType.TransportShip, 26, 2, {
        target: 11,
        arrivalTick: 30,
      });
      const ship = addUnit(UnitType.Warship, 25);
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new MoveWarshipIntentEvent([ship], 26),
      );
    });

    it.each([80, 81])(
      "treats a patrol %s tiles from a port according to the coverage radius",
      async (offset) => {
        const {
          auto,
          tick,
          flush,
          query,
          observation,
          neighbor,
          addUnit,
          territory,
          game,
        } = automaticFixture(300);
        observation.elapsed = 2000;
        neighbor(100_000, 75250);
        const port = 30100;
        territory(port, 1);
        addUnit(UnitType.Port, port);
        const water = game.neighbors(port).find((tile) => !game.isLand(tile))!;
        for (let i = 0; i < 3; i++) addUnit(UnitType.Port, port);
        addUnit(UnitType.Warship, water + offset);
        auto.setEnabled(true);
        tick(2);
        await flush();
        expect(
          query.mock.calls.some((call) => call[3]?.includes(UnitType.Warship)),
        ).toBe(offset > 80);
      },
    );

    it("does not count a nearby ship across a land barrier as coastal coverage", async () => {
      const {
        auto,
        tick,
        flush,
        query,
        observation,
        neighbor,
        addUnit,
        territory,
        fill,
      } = automaticFixture(300);
      observation.elapsed = 2000;
      neighbor(100_000, 75250);
      fill(101, 101, 0, 299, 0);
      territory(30100, 1);
      addUnit(UnitType.Port, 30100);
      for (const port of [29800, 30099, 30400]) {
        territory(port, 1);
        addUnit(UnitType.Port, port);
      }
      addUnit(UnitType.Warship, 29802);
      auto.setEnabled(true);
      tick(2);
      await flush();
      expect(query).toHaveBeenCalledWith(
        "me",
        expect.any(Number),
        expect.any(Number),
        [UnitType.Warship],
      );
    });

    it("intercepts across open water beyond the flood-search radius", async () => {
      const { auto, tick, flush, emit, neighbor, addUnit } =
        automaticFixture(300);
      neighbor(100_000, 75250);
      addUnit(UnitType.TransportShip, 60000, 2, { target: 11 });
      const ship = addUnit(UnitType.Warship, 1000);
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new MoveWarshipIntentEvent([ship], 60000),
      );
    });

    it("updates an interception after one second rather than waiting ten seconds", async () => {
      const { auto, tick, flush, emit, neighbor, addUnit, observation } =
        automaticFixture();
      neighbor();
      addUnit(UnitType.TransportShip, 23, 2, { target: 11 });
      const ship = addUnit(UnitType.Warship, 22);
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      observation.units[0].tile = 24;
      tick(13);
      await flush();
      tick(14);
      expect(emit).toHaveBeenLastCalledWith(
        new MoveWarshipIntentEvent([ship], 24),
      );
      expect(emit).toHaveBeenCalledTimes(2);
    });

    it.each([UnitType.MIRV, UnitType.HydrogenBomb, UnitType.AtomBomb] as const)(
      "prioritizes an economically funded %s against a comparable rival before economy",
      async (type) => {
        const {
          auto,
          tick,
          flush,
          emit,
          query,
          observation,
          neighbor,
          addUnit,
          territory,
          game,
        } = automaticFixture(300);
        observation.elapsed = 2000;
        observation.cap = 100_000;
        observation.gold = 500_000_000n;
        game.myPlayer()!.state.gold = Number(observation.gold);
        const target = type === UnitType.AtomBomb ? 350 : 75250;
        neighbor(100_000, target);
        if (type !== UnitType.MIRV) territory(12, 2);
        addUnit(UnitType.City, target, 2);
        addUnit(UnitType.MissileSilo, 11);
        query.mockResolvedValue({
          canAttack: false,
          canSendEmojiAllPlayers: false,
          buildableUnits: [
            {
              type,
              canBuild: 11,
              canUpgrade: false,
              cost: 100_000_000n,
              ghostRailPaths: [],
              overlappingRailroads: [],
            },
          ],
        });
        auto.setEnabled(true);
        tick(2);
        await flush();
        tick(3);
        expect(emit).toHaveBeenCalledExactlyOnceWith(
          new BuildUnitIntentEvent(type, target),
        );
      },
    );

    it("targets a MIRV at the strongest eligible rival", async () => {
      const { auto, tick, flush, emit, query, observation, neighbor, addUnit } =
        automaticFixture(300);
      observation.elapsed = 2000;
      observation.cap = 100_000;
      neighbor(150_000, 75_250);
      neighbor(100_000, 45_168, 3);
      addUnit(UnitType.City, 75_250, 2);
      addUnit(UnitType.City, 45_168, 3);
      addUnit(UnitType.MissileSilo, 11);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.MIRV,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new BuildUnitIntentEvent(UnitType.MIRV, 75_250),
      );
    });

    it("ranks direct strikes by infrastructure value across rivals, not troop strength", async () => {
      const { auto, tick, flush, emit, query, observation, neighbor, addUnit } =
        automaticFixture(300);
      observation.elapsed = 2000;
      neighbor(150_000, 75250);
      neighbor(60_000, 30100, 3);
      addUnit(UnitType.City, 75250, 2, { level: 8 });
      addUnit(UnitType.MissileSilo, 30100, 3);
      addUnit(UnitType.MissileSilo, 11);
      addUnit(UnitType.SAMLauncher, 11, 1, { range: 100 });
      query.mockImplementation(async (_id, _x, _y, types) => ({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: (types ?? []).map((type) => ({
          type,
          canBuild: 11,
          canUpgrade: false,
          cost: type === UnitType.MIRV ? 600_000_000n : 100n,
          ghostRailPaths: [],
          overlappingRailroads: [],
        })),
      }));
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).not.toHaveBeenCalled();
      tick(12);
      await flush();
      tick(13);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new BuildUnitIntentEvent(UnitType.HydrogenBomb, 30100),
      );
    });

    it.each([300, 900])(
      "bounds collateral map reads on a fragmented %s-wide map",
      async (width) => {
        const {
          auto,
          tick,
          flush,
          emit,
          query,
          observation,
          neighbor,
          addUnit,
          fill,
          game,
        } = automaticFixture(width);
        const target = width * (width - 50) + width - 50;
        observation.elapsed = 2000;
        neighbor(100_000, target);
        fill(100, width - 20, 100, width - 20, 2);
        addUnit(UnitType.City, target, 2);
        addUnit(UnitType.MissileSilo, 11);
        const originalOwnerID = game.ownerID.bind(game);
        let reads = 0;
        game.ownerID = (tile) => {
          reads++;
          const owner = originalOwnerID(tile);
          return owner === 2 && game.x(tile) % 2 !== 0 ? 0 : owner;
        };
        query.mockResolvedValue({
          canAttack: false,
          canSendEmojiAllPlayers: false,
          buildableUnits: [
            {
              type: UnitType.MIRV,
              canBuild: 11,
              canUpgrade: false,
              cost: 100n,
              ghostRailPaths: [],
              overlappingRailroads: [],
            },
          ],
        });
        auto.setEnabled(true);
        tick(2);
        const checkReads = reads;
        reads = 0;
        await flush();
        tick(3);
        expect(emit).toHaveBeenCalledExactlyOnceWith(
          new BuildUnitIntentEvent(UnitType.MIRV, target),
        );
        expect(checkReads).toBeLessThan(width * width * 6);
        expect(reads).toBeLessThan(width * width * 6);
      },
    );

    it.each([
      { dx: 18, dy: 0, blocked: true },
      { dx: 19, dy: 0, blocked: false },
      { dx: 13, dy: 13, blocked: false },
    ])(
      "keeps circular MIRV collateral checks at offset $dx,$dy",
      async ({ dx, dy, blocked }) => {
        const {
          auto,
          tick,
          flush,
          emit,
          query,
          observation,
          neighbor,
          addUnit,
          territory,
        } = automaticFixture(300);
        observation.elapsed = 2000;
        neighbor(100_000, 75250);
        territory(45150, 2);
        territory(45150 + dy * 300 + dx, 1);
        addUnit(UnitType.City, 75250, 2);
        addUnit(UnitType.MissileSilo, 11);
        query.mockResolvedValue({
          canAttack: false,
          canSendEmojiAllPlayers: false,
          buildableUnits: [
            {
              type: UnitType.MIRV,
              canBuild: 11,
              canUpgrade: false,
              cost: 100n,
              ghostRailPaths: [],
              overlappingRailroads: [],
            },
          ],
        });
        auto.setEnabled(true);
        tick(2);
        await flush();
        tick(3);
        expect(
          emit.mock.calls.some(
            ([event]) =>
              event instanceof BuildUnitIntentEvent &&
              event.unit === UnitType.MIRV,
          ),
        ).toBe(!blocked);
      },
    );

    it("rechecks alliances before dispatching a cached MIRV proposal", async () => {
      const {
        auto,
        tick,
        flush,
        emit,
        query,
        observation,
        neighbor,
        addUnit,
        territory,
      } = automaticFixture(300);
      observation.elapsed = 2000;
      neighbor(100_000, 75250);
      neighbor(10_000, 45168, 3);
      territory(45150, 2);
      addUnit(UnitType.City, 75250, 2);
      addUnit(UnitType.MissileSilo, 11);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.MIRV,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      observation.players[2].friendly = true;
      tick(3);
      expect(emit).not.toHaveBeenCalled();
    });

    it("rechecks friendly units over the interior of MIRV target territory", async () => {
      const {
        auto,
        tick,
        flush,
        emit,
        query,
        observation,
        neighbor,
        addUnit,
        fill,
      } = automaticFixture(300);
      observation.elapsed = 2000;
      neighbor(100_000, 75250);
      fill(100, 280, 100, 280, 2);
      addUnit(UnitType.City, 75250, 2);
      addUnit(UnitType.MissileSilo, 11);
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.MIRV,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      addUnit(UnitType.AtomBomb, 45150);
      tick(3);
      expect(emit).not.toHaveBeenCalled();
    });

    it("falls back from an unaffordable MIRV to a legal hydrogen bomb", async () => {
      const {
        auto,
        tick,
        flush,
        emit,
        query,
        observation,
        neighbor,
        addUnit,
        game,
      } = automaticFixture(300);
      observation.elapsed = 2000;
      observation.gold = 500_000_000n;
      game.myPlayer()!.state.gold = Number(observation.gold);
      neighbor(100_000, 75250);
      addUnit(UnitType.City, 75250, 2);
      addUnit(UnitType.MissileSilo, 11);
      query.mockImplementation(async (_id, _x, _y, types) => ({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: (types ?? []).map((type) => ({
          type,
          canBuild: 11,
          canUpgrade: false,
          cost: type === UnitType.MIRV ? 600_000_000n : 5_000_000n,
          ghostRailPaths: [],
          overlappingRailroads: [],
        })),
      }));
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).not.toHaveBeenCalled();
      tick(12);
      await flush();
      tick(13);
      expect(emit).toHaveBeenCalledExactlyOnceWith(
        new BuildUnitIntentEvent(UnitType.HydrogenBomb, 75250),
      );
    });

    it.each([
      "allied",
      "team",
      "incoming",
      "in-flight",
      "warheads",
      "not-ready",
      "low-reserve",
    ])("withholds strategic nuclear launches when %s", async (reason) => {
      const { auto, tick, flush, emit, query, observation, neighbor, addUnit } =
        automaticFixture(300);
      observation.elapsed = 2000;
      neighbor(100_000, 75250);
      addUnit(UnitType.City, 75250, 2);
      addUnit(UnitType.MissileSilo, 11, 1, {
        ready: reason === "not-ready" ? 0 : 1,
      });
      if (reason === "allied") observation.players[1].friendly = true;
      if (reason === "team") {
        observation.players[0].team = "red";
        observation.players[1].team = "red";
      }
      if (reason === "incoming") observation.players[0].incoming = 100_000;
      if (reason === "in-flight")
        addUnit(UnitType.MIRV, 22, 1, { target: 75250 });
      if (reason === "warheads")
        addUnit(UnitType.MIRVWarhead, 22, 1, { target: 75250 });
      if (reason === "low-reserve") observation.cap = 250_000;
      query.mockResolvedValue({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: UnitType.MIRV,
            canBuild: 11,
            canUpgrade: false,
            cost: 100n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      });
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      expect(emit).not.toHaveBeenCalled();
    });

    it("builds a silo on a free site to prepare for a troop stalemate", async () => {
      const {
        auto,
        tick,
        flush,
        emit,
        query,
        observation,
        neighbor,
        addUnit,
        fill,
        game,
      } = automaticFixture(300);
      observation.elapsed = 2000;
      observation.cap = 100_000;
      observation.gold = 500_000_000n;
      game.myPlayer()!.state.gold = Number(observation.gold);
      fill(0, 100, 0, 100, 1);
      neighbor(100_000, 75250);
      addUnit(UnitType.City, 11);
      addUnit(UnitType.City, 300 * 60 + 60);
      query.mockImplementation(async (_id, x, y, types) => ({
        canAttack: false,
        canSendEmojiAllPlayers: false,
        buildableUnits: [
          {
            type: types![0],
            canBuild: y! * 300 + x!,
            canUpgrade: false,
            cost: 1_000_000n,
            ghostRailPaths: [],
            overlappingRailroads: [],
          },
        ],
      }));
      auto.setEnabled(true);
      tick(2);
      await flush();
      tick(3);
      const event = emit.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(BuildUnitIntentEvent);
      expect(event.unit).toBe(UnitType.MissileSilo);
      expect(event.tile).not.toBe(11);
      expect(game.ownerID(event.tile)).toBe(1);
    });

    it.each([UnitType.HydrogenBomb, UnitType.MIRV] as const)(
      "rechecks friendly collateral before dispatching %s",
      async (type) => {
        const {
          auto,
          tick,
          flush,
          emit,
          query,
          observation,
          neighbor,
          addUnit,
          territory,
        } = automaticFixture(300);
        observation.elapsed = 2000;
        neighbor(100_000, 75250);
        addUnit(UnitType.City, 75250, 2);
        addUnit(UnitType.MissileSilo, 11);
        // Make MIRV unsafe at another enemy border without excluding hydrogen.
        if (type === UnitType.HydrogenBomb) territory(12, 2);
        query.mockResolvedValue({
          canAttack: false,
          canSendEmojiAllPlayers: false,
          buildableUnits: [
            {
              type,
              canBuild: 11,
              canUpgrade: false,
              cost: 100n,
              ghostRailPaths: [],
              overlappingRailroads: [],
            },
          ],
        });
        auto.setEnabled(true);
        tick(2);
        await flush();
        territory(75251, 1);
        tick(3);
        expect(emit).not.toHaveBeenCalled();
      },
    );
  });

  it("shows exactly three recommendations by default with more on demand", async () => {
    const panel = new AdvisorPanel();
    document.body.append(panel);
    panel.enabled = true;
    panel.status = "active";
    panel.queryState = "ready";
    panel.result = {
      context: "opening",
      items: Array.from({ length: 5 }, (_, i): Recommendation => ({
        id: String(i),
        rule: "neutral",
        priority: 46,
        confidence: "estimate",
        params: {},
        firstTick: 1,
        lastTick: 1,
      })),
    };
    await panel.updateComplete;
    expect(panel.shadowRoot!.querySelectorAll("article")).toHaveLength(3);
    expect(
      panel.shadowRoot!.querySelector(".phase-name")?.textContent,
    ).toContain("advisor.context_opening");
    expect(
      panel.shadowRoot!.querySelector(".posture")?.getAttribute("data-action"),
    ).toBe("push");
    expect(panel.shadowRoot!.textContent).toContain(
      "advisor.phase_opening_detail",
    );
    const more = [...panel.shadowRoot!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("advisor.more"),
    )!;
    more.click();
    await panel.updateComplete;
    expect(panel.shadowRoot!.querySelectorAll("article")).toHaveLength(5);
  });

  it("recommends retaining when defense overrides an expansion opportunity", async () => {
    const panel = new AdvisorPanel();
    document.body.append(panel);
    panel.enabled = true;
    panel.status = "active";
    panel.queryState = "ready";
    panel.result = {
      context: "opening",
      items: [
        {
          id: "neutral",
          rule: "neutral",
          priority: 46,
          confidence: "estimate",
          params: {},
          firstTick: 1,
          lastTick: 1,
        },
        {
          id: "defense",
          rule: "defense",
          priority: 96,
          confidence: "observed",
          params: {},
          firstTick: 1,
          lastTick: 1,
        },
      ],
    };
    await panel.updateComplete;
    expect(
      panel.shadowRoot!.querySelector(".posture")?.getAttribute("data-action"),
    ).toBe("retain");
  });

  it("provides independent dismiss, snooze and camera-focus callbacks", async () => {
    const panel = new AdvisorPanel();
    document.body.append(panel);
    panel.enabled = true;
    panel.status = "active";
    panel.onHide = vi.fn();
    panel.onFocus = vi.fn();
    panel.result = {
      context: "contested",
      items: [
        {
          id: "landing:1",
          rule: "landing",
          priority: 92,
          confidence: "observed",
          params: {},
          tile: 11,
          firstTick: 1,
          lastTick: 1,
        },
      ],
    };
    await panel.updateComplete;
    for (const button of panel.shadowRoot!.querySelectorAll<HTMLButtonElement>(
      "article button",
    )) {
      button.click();
    }
    expect(panel.onFocus).toHaveBeenCalledWith(11);
    expect(panel.onHide).toHaveBeenCalledWith("landing:1", true);
    expect(panel.onHide).toHaveBeenCalledWith("landing:1", false);
  });
});
