import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameMapImpl } from "@openfront/engine-lib/game/GameMapImpl";
import { AdvisorEngine } from "src/client/advisor/AdvisorEngine";
import { gamePhase } from "src/client/advisor/GamePhase";
import { SpatialIndex } from "src/client/advisor/SpatialIndex";
import type {
  AdvisorObservation,
  AdvisorPlayer,
  AdvisorUnit,
} from "src/client/advisor/Types";
import { describe, expect, it } from "vitest";

function player(id: number, extra: Partial<AdvisorPlayer> = {}): AdvisorPlayer {
  return {
    id,
    name: `player-${id}`,
    type: PlayerType.Human,
    team: null,
    alive: true,
    disconnected: false,
    friendly: id === 1,
    tiles: 100,
    troops: id === 1 ? 100_000 : 10_000,
    incoming: 0,
    outgoing: 0,
    traitor: false,
    doomed: false,
    alliances: [],
    ...extra,
  };
}

function unit(extra: Partial<AdvisorUnit> = {}): AdvisorUnit {
  return {
    id: 1,
    owner: 2,
    type: UnitType.TransportShip,
    tile: 8,
    target: 34,
    active: true,
    retreating: false,
    constructing: false,
    level: 1,
    ready: 1,
    range: 0,
    troops: 10_000,
    arrivalTick: null,
    ...extra,
  };
}

function fixture() {
  const terrain = new Uint8Array(32 * 32).fill(128);
  terrain.fill(32, 0, 32);
  const map = new GameMapImpl(32, 32, terrain, 32 * 31);
  map.setOwnerID(34, 1);
  map.setOwnerID(35, 2);
  const spatial = new SpatialIndex(map, 1);
  spatial.initialize(Infinity);
  const engine = new AdvisorEngine(map, spatial);
  const observation: AdvisorObservation = {
    tick: 100,
    elapsed: 80,
    myID: 1,
    players: [player(1), player(2)],
    units: [],
    cap: 150_000,
    growth: 200,
    gold: 1_000_000n,
    builds: [],
    queryState: "ready",
    attackable: new Set([0, 2]),
    landShare: 0.1,
    winShare: 0.8,
    clockEnabled: false,
  };
  const evaluate = () => engine.evaluate(observation);
  return { map, spatial, engine, observation, evaluate };
}

describe("incremental frontier and coast", () => {
  it("keeps sparse building sites consistent after capture, fallout and flooding", () => {
    const { map, spatial } = fixture();
    map.setOwnerID(528, 1);
    spatial.ingest([528]);
    expect(spatial.sites.has(528)).toBe(true);
    map.setFallout(528, true);
    spatial.ingest([528]);
    expect(spatial.sites.has(528)).toBe(false);
    map.setFallout(528, false);
    spatial.ingest([528]);
    expect(spatial.sites.has(528)).toBe(true);
    map.setWater(528);
    spatial.ingest([528]);
    const rebuilt = new SpatialIndex(map, 1);
    rebuilt.initialize(Infinity);
    expect(spatial.sites).toEqual(rebuilt.sites);
    expect(spatial.sites.has(528)).toBe(false);
  });

  it("samples distinct coastal regions rather than only the first coastline entries", () => {
    const terrain = new Uint8Array(128 * 128).fill(32);
    terrain.fill(128, 64 * 128, 65 * 128);
    const map = new GameMapImpl(128, 128, terrain, 128);
    for (let x = 0; x < 128; x++) map.setOwnerID(64 * 128 + x, 1);
    const index = new SpatialIndex(map, 1);
    index.initialize(Infinity);
    const sites = index.coastalSites(0);
    expect(sites).toHaveLength(2);
    expect(
      Math.abs((sites[0] % 128) - (sites[1] % 128)),
    ).toBeGreaterThanOrEqual(64);
    expect(index.coastalSites(5)).not.toEqual(sites);
  });
  it("rotates foreign landing sites and removes captured, flooded and fallout shores", () => {
    const { map, spatial } = fixture();
    const initial = spatial.landingSites(0, 0);
    expect(initial).toHaveLength(3);
    expect(spatial.landingSites(0, 1)).not.toEqual(initial);
    expect(spatial.landingSites(1, 0)).toEqual([]);
    expect(spatial.landingSites(2, 0)).toEqual([35]);
    map.setOwnerID(35, 1);
    map.setFallout(initial[0], true);
    map.setWater(initial[1]);
    map.setMagnitude(initial[2], 31);
    spatial.ingest([35, ...initial]);
    expect(spatial.landingSites(2, 0)).toEqual([]);
    const rebuilt = new SpatialIndex(map, 1);
    rebuilt.initialize(Infinity);
    expect(new Set(spatial.landingSites(0, 0, 1024))).toEqual(
      new Set(rebuilt.landingSites(0, 0, 1024)),
    );
    for (const tile of initial)
      expect(spatial.landingSites(0, 0, 1024)).not.toContain(tile);
  });
  it("finds neutral and player fronts without including own tiles", () => {
    const { spatial } = fixture();
    expect(spatial.fronts.get(2)?.has(35)).toBe(true);
    expect(spatial.fronts.get(0)?.has(33)).toBe(true);
    expect(spatial.fronts.has(1)).toBe(false);
    expect(spatial.coast.has(34)).toBe(true);
  });

  it("processes a captured tile and its neighbors exactly like a full rebuild", () => {
    const { map, spatial } = fixture();
    map.setOwnerID(35, 1);
    spatial.ingest([35, 35]);
    const rebuilt = new SpatialIndex(map, 1);
    rebuilt.initialize(Infinity);
    expect(spatial.fronts).toEqual(rebuilt.fronts);
    expect(spatial.coast).toEqual(rebuilt.coast);
    for (const owner of [0, 1, 2])
      expect(new Set(spatial.landingSites(owner, 0, 1024))).toEqual(
        new Set(rebuilt.landingSites(owner, 0, 1024)),
      );
  });

  it("matches rebuilds through deterministic ownership and terrain changes", () => {
    const { map, spatial } = fixture();
    for (let i = 0; i < 100; i++) {
      const ref = 32 + ((i * 17) % 960);
      map.setOwnerID(ref, i % 3);
      if (i % 7 === 0) map.setWater(ref);
      spatial.ingest([ref]);
      const rebuilt = new SpatialIndex(map, 1);
      rebuilt.initialize(Infinity);
      expect(spatial.fronts).toEqual(rebuilt.fronts);
      expect(spatial.coast).toEqual(rebuilt.coast);
    }
  });

  it("does not make impassable terrain an expansion candidate", () => {
    const { map, spatial } = fixture();
    map.setMagnitude(33, 31);
    spatial.ingest([33]);
    expect(spatial.fronts.get(0)?.has(33)).toBe(false);
  });

  it("supports bounded baseline construction with live changes", () => {
    const { map } = fixture();
    const index = new SpatialIndex(map, 1);
    index.initialize(16);
    expect(index.ready).toBe(false);
    map.setOwnerID(35, 1);
    index.ingest([35]);
    index.initialize(Infinity);
    const rebuilt = new SpatialIndex(map, 1);
    rebuilt.initialize(Infinity);
    expect(index.fronts).toEqual(rebuilt.fronts);
    expect(index.coast).toEqual(rebuilt.coast);
    expect(index.ready).toBe(true);
  });

  it("detects overlapping blast footprints even when the center is not ours", () => {
    const { spatial } = fixture();
    expect(spatial.blastTouches(35, 2)).toBe(true);
    expect(spatial.blastTouches(900, 2)).toBe(false);
    expect(spatial.nearCoast(2, 2)).toBe(34);
    expect(spatial.nearCoast(900, 2)).toBeUndefined();
  });

  it("measures nearest coast across cells and updates distances after capture", () => {
    const terrain = new Uint8Array(160 * 160).fill(32);
    const sources = [10 * 160 + 10, 70 * 160 + 140];
    for (const tile of sources) terrain[tile] = 128;
    const map = new GameMapImpl(160, 160, terrain, sources.length);
    for (const tile of sources) map.setOwnerID(tile, 1);
    const spatial = new SpatialIndex(map, 1);
    spatial.initialize(Infinity);
    const target = 74 * 160 + 140;
    expect(spatial.nearCoast(target)).toBe(sources[1]);
    expect(spatial.coastDistance(target)).toBe(4);
    expect(spatial.nearCoast(target, 3)).toBeUndefined();
    expect(spatial.nearCoast(target, 4)).toBe(sources[1]);
    map.setOwnerID(sources[1], 2);
    spatial.ingest([sources[1]]);
    expect(spatial.nearCoast(target)).toBe(sources[0]);
    expect(spatial.coastDistance(target)).toBe(Math.hypot(130, 64));
    map.setOwnerID(sources[0], 2);
    spatial.ingest([sources[0]]);
    expect(spatial.nearCoast(target)).toBeUndefined();
    expect(spatial.coastDistance(target)).toBe(Infinity);
  });
});

describe("balanced opportunity and defense advice", () => {
  it("labels an opening tribe frontier even after adjacent neutral land is exhausted", () => {
    const { observation, spatial, evaluate } = fixture();
    spatial.fronts.delete(0);
    observation.players[1].type = PlayerType.Bot;
    expect(evaluate().context).toBe("opening");
    observation.players[1].type = PlayerType.Nation;
    expect(evaluate().context).toBe("economy");
    observation.players[1].type = PlayerType.Bot;
    observation.players[1].alive = false;
    expect(evaluate().context).toBe("economy");
  });

  it("keeps the opening phase while neutral or tribe frontiers remain", () => {
    const { observation, spatial, map, evaluate } = fixture();
    expect(gamePhase(observation, map, spatial)).toBe(evaluate().context);
    observation.elapsed = 1800;
    expect(evaluate().context).toBe("economy");
    spatial.fronts.set(0, new Set(Array.from({ length: 8 }, (_, i) => i)));
    expect(evaluate().context).toBe("opening");
    spatial.fronts.delete(0);
    observation.players[1].type = PlayerType.Bot;
    expect(evaluate().context).toBe("opening");
    spatial.fronts.delete(2);
    expect(evaluate().context).toBe("economy");
    spatial.fronts.set(0, new Set([33]));
    spatial.fronts.delete(2);
    observation.players[1].type = PlayerType.Human;
    expect(evaluate().context).toBe("economy");
    spatial.fronts.set(2, new Set([35]));
    observation.players[1].troops = 200_000;
    expect(evaluate().context).toBe("contested");
    observation.players[1].friendly = true;
    spatial.fronts.set(0, new Set(Array.from({ length: 8 }, (_, i) => i)));
    expect(evaluate().context).toBe("opening");
    observation.players[0].incoming = 1;
    expect(evaluate().context).toBe("contested");
    observation.units = [unit({ type: UnitType.AtomBomb, range: 30 })];
    expect(evaluate().context).toBe("nuclear");
    observation.landShare = 0.7;
    expect(evaluate().context).toBe("endgame");
  });

  it("suggests adjacent unclaimed expansion and a weaker neighbor", () => {
    const { evaluate } = fixture();
    expect(evaluate().items.map((i) => i.rule)).toEqual(
      expect.arrayContaining(["neutral", "weak_neighbor"]),
    );
  });

  it("withholds attacks until the worker confirms eligibility", () => {
    const { observation, evaluate } = fixture();
    observation.attackable = new Set();
    expect(evaluate().items).toHaveLength(0);
  });

  it("does not suggest attacking allies or eliminated players", () => {
    const { observation, evaluate } = fixture();
    observation.players[1].friendly = true;
    expect(evaluate().items.some((i) => i.rule === "weak_neighbor")).toBe(
      false,
    );
    observation.players[1].friendly = false;
    observation.players[1].alive = false;
    expect(evaluate().items.some((i) => i.rule === "weak_neighbor")).toBe(
      false,
    );
  });

  it("distinguishes disconnected teammates from disconnected opponents", () => {
    const { observation, evaluate } = fixture();
    observation.players[1].disconnected = true;
    expect(evaluate().items.some((i) => i.rule === "disconnected")).toBe(true);
    observation.players[0].team = "red";
    observation.players[1].team = "red";
    expect(evaluate().items.some((i) => i.rule === "reclaim")).toBe(true);
  });

  it("retracts a disconnection opportunity on reconnect", () => {
    const { observation, evaluate } = fixture();
    observation.players[1].disconnected = true;
    evaluate();
    observation.tick++;
    observation.players[1].disconnected = false;
    expect(evaluate().items.some((i) => i.rule === "disconnected")).toBe(false);
  });

  it("incoming attacks outrank and suppress another expansion commitment", () => {
    const { observation, evaluate } = fixture();
    observation.players[0].incoming = 80_000;
    const items = evaluate().items;
    expect(items[0].rule).toBe("defense");
    expect(
      items.some((i) => ["neutral", "weak_neighbor"].includes(i.rule)),
    ).toBe(false);
  });

  it("recognizes overcommitment instead of advising a full send", () => {
    const { observation, evaluate } = fixture();
    observation.players[0].troops = 10_000;
    observation.players[0].outgoing = 90_000;
    expect(evaluate().items[0].rule).toBe("exposure");
  });

  it("warns about a stronger land neighbor even with a high reserve and no eligibility result", () => {
    const { observation, evaluate } = fixture();
    observation.players[1].troops = 100_001;
    observation.attackable = new Set();
    const item = evaluate().items.find((i) => i.rule === "strong_neighbor");
    expect(item).toMatchObject({
      id: "strong_neighbor:2",
      confidence: "estimate",
      tile: 35,
      params: {
        name: "player-2",
        troops: 100_001,
        reserve: 100_000,
        advantage: 1,
      },
    });
    expect(evaluate().items.some((i) => i.rule === "exposure")).toBe(false);
  });

  it("distinguishes stronger allies and disconnected teammates from hostile neighbors", () => {
    const { observation, evaluate } = fixture();
    observation.players[1].troops = 150_000;
    const hostile = evaluate().items.find((i) => i.rule === "strong_neighbor")!;
    observation.players[1].friendly = true;
    const allied = evaluate().items.find(
      (i) => i.rule === "strong_friendly_neighbor",
    )!;
    expect(allied.priority).toBeLessThan(hostile.priority);
    expect(evaluate().items.some((i) => i.rule === "strong_neighbor")).toBe(
      false,
    );
    observation.players[1].friendly = false;
    observation.players[1].disconnected = true;
    observation.players[0].team = "red";
    observation.players[1].team = "red";
    expect(
      evaluate().items.some((i) => i.rule === "strong_friendly_neighbor"),
    ).toBe(true);
  });

  it("removes the warning for equal/weaker reserves, eliminated players or lost adjacency", () => {
    const { observation, evaluate, map, spatial } = fixture();
    const warned = () =>
      evaluate().items.some((i) => i.id === "strong_neighbor:2");
    observation.players[1].troops = 150_000;
    expect(warned()).toBe(true);
    observation.players[1].troops = 100_000;
    expect(warned()).toBe(false);
    observation.players[1].troops = 99_999;
    expect(warned()).toBe(false);
    observation.players[1].troops = 150_000;
    observation.players[1].alive = false;
    expect(warned()).toBe(false);
    observation.players[1].alive = true;
    map.setOwnerID(35, 0);
    spatial.ingest([35]);
    expect(warned()).toBe(false);
  });

  it("handles zero reserve and keeps active attacks above stronger-neighbor warnings", () => {
    const { observation, evaluate } = fixture();
    observation.players[0].troops = 0;
    observation.players[0].incoming = 1;
    observation.players[1].troops = 1;
    const items = evaluate().items;
    expect(items[0].rule).toBe("defense");
    expect(
      items.find((i) => i.rule === "strong_neighbor")?.params.reserve,
    ).toBe(0);
  });

  it("does not call a sampled defended or irradiated front a weak target", () => {
    const { observation, map, evaluate } = fixture();
    observation.units = [
      unit({
        type: UnitType.DefensePost,
        tile: 35,
        range: 30,
      }),
    ];
    expect(evaluate().items.some((i) => i.rule === "weak_neighbor")).toBe(
      false,
    );
    observation.units = [];
    map.setFallout(35, true);
    expect(evaluate().items.some((i) => i.rule === "weak_neighbor")).toBe(
      false,
    );
  });
});

describe("naval detection", () => {
  it("warns about a real hostile destination with unknown ETA labeled explicitly", () => {
    const { observation, evaluate } = fixture();
    observation.units = [unit()];
    const warning = evaluate().items[0];
    expect(warning.rule).toBe("landing");
    expect(warning.confidence).toBe("observed");
    expect(warning.params.eta).toBe("unknown");
  });

  it("computes ETA only from supplied route arrival ticks", () => {
    const { observation, evaluate } = fixture();
    observation.units = [unit({ arrivalTick: 150 })];
    expect(evaluate().items[0].params.eta).toBe("5.0");
  });

  it.each([
    { retreating: true },
    { active: false },
    { owner: 1 },
    { type: UnitType.TradeShip },
  ])("ignores nonthreatening boats: %j", (change) => {
    const { observation, evaluate } = fixture();
    observation.units = [unit(change)];
    expect(
      evaluate().items.some((i) => i.rule === "landing" || i.rule === "boat"),
    ).toBe(false);
  });

  it("ignores friendly transports", () => {
    const { observation, evaluate } = fixture();
    observation.players[1].friendly = true;
    observation.units = [unit()];
    expect(evaluate().items.some((i) => i.rule === "landing")).toBe(false);
  });

  it.each([100, null])(
    "ignores a passing transport with destination %s",
    (target) => {
      const { observation, evaluate } = fixture();
      observation.units = [unit({ target })];
      expect(evaluate().items.some((i) => i.id.startsWith("transport:"))).toBe(
        false,
      );
    },
  );

  it("revalidates changing landing ownership", () => {
    const { observation, map, evaluate } = fixture();
    observation.units = [unit()];
    evaluate();
    map.setOwnerID(34, 2);
    expect(evaluate().items.some((i) => i.rule === "landing")).toBe(false);
  });

  it("does not warn about warship proximity alone", () => {
    const { observation, evaluate } = fixture();
    observation.units = [
      unit({ type: UnitType.Warship }),
      unit({ id: 2, type: UnitType.Warship }),
    ];
    expect(evaluate().items.filter((i) => i.rule === "navy")).toHaveLength(0);
  });
});

describe("nuclear capability and actual threats", () => {
  it("baselines existing structures instead of calling them new", () => {
    const { observation, evaluate } = fixture();
    observation.units = [unit({ type: UnitType.MissileSilo })];
    expect(evaluate().items.find((i) => i.rule === "silo")?.params.stage).toBe(
      "existing",
    );
  });

  it("distinguishes construction, completion and capture", () => {
    const { observation, evaluate } = fixture();
    evaluate();
    observation.tick++;
    observation.units = [
      unit({ type: UnitType.MissileSilo, constructing: true }),
    ];
    expect(evaluate().items.find((i) => i.rule === "silo")?.params.stage).toBe(
      "construction",
    );
    observation.tick++;
    observation.units[0].constructing = false;
    expect(evaluate().items.find((i) => i.rule === "silo")?.params.stage).toBe(
      "completed",
    );
    observation.players.push(player(3));
    observation.tick++;
    observation.units[0].owner = 3;
    expect(evaluate().items.find((i) => i.rule === "silo")?.params.stage).toBe(
      "captured",
    );
  });

  it("does not mistake an enemy SAM for an incoming strike", () => {
    const { observation, evaluate } = fixture();
    observation.units = [unit({ type: UnitType.SAMLauncher, range: 70 })];
    expect(evaluate().items.some((i) => i.rule === "sam")).toBe(true);
    expect(evaluate().items.some((i) => i.rule === "nuke")).toBe(false);
  });

  it("groups MIRV warheads and prioritizes blast overlap", () => {
    const { observation, evaluate } = fixture();
    observation.units = [
      unit({ type: UnitType.MIRVWarhead, target: 35, range: 18 }),
      unit({ id: 2, type: UnitType.MIRVWarhead, target: 36, range: 18 }),
    ];
    const warnings = evaluate().items.filter((i) => i.rule === "nuke");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].params.count).toBe(2);
    expect(evaluate().items[0].rule).toBe("nuke");
  });

  it("includes friendly fire but not distant strikes", () => {
    const { observation, evaluate } = fixture();
    observation.players[1].friendly = true;
    observation.units = [unit({ type: UnitType.AtomBomb, range: 30 })];
    expect(evaluate().items[0].rule).toBe("nuke");
    observation.units[0].target = 1023;
    observation.units[0].range = 2;
    expect(evaluate().items.some((i) => i.rule === "nuke")).toBe(false);
  });

  it("does not count constructing or reloading SAMs as ready defense", () => {
    const { observation, evaluate } = fixture();
    observation.units = [
      unit({ type: UnitType.AtomBomb, range: 30 }),
      unit({
        id: 2,
        owner: 1,
        type: UnitType.SAMLauncher,
        range: 70,
        constructing: true,
      }),
      unit({
        id: 3,
        owner: 1,
        type: UnitType.SAMLauncher,
        range: 70,
        ready: 0,
      }),
    ];
    expect(evaluate().items[0].params.sam).toBe(0);
    expect(evaluate().items[0].params.coverage).toBe("none");
    observation.units[1].constructing = false;
    expect(evaluate().items[0].params.sam).toBe(1);
    expect(evaluate().items[0].params.coverage).toBe("all");
  });

  it("reports partial destination coverage rather than implying an entire salvo is protected", () => {
    const { observation, evaluate } = fixture();
    observation.units = [
      unit({ type: UnitType.AtomBomb, target: 34, range: 30 }),
      unit({ id: 2, type: UnitType.AtomBomb, target: 35, range: 30 }),
      unit({ id: 3, owner: 1, type: UnitType.SAMLauncher, tile: 34, range: 0 }),
    ];
    expect(evaluate().items[0].params).toMatchObject({
      coverage: "partial",
      covered: 1,
      uncovered: 1,
      sam: 1,
    });
  });

  it("does not claim own SAM protection against friendly or self missiles", () => {
    const { observation, evaluate } = fixture();
    observation.players[1].friendly = true;
    observation.units = [
      unit({ type: UnitType.AtomBomb, range: 30 }),
      unit({ id: 2, owner: 1, type: UnitType.SAMLauncher, range: 70 }),
    ];
    expect(evaluate().items[0].params).toMatchObject({
      coverage: "friendly_fire",
      sam: 0,
    });
    observation.units[0].owner = 1;
    expect(evaluate().items[0].params.coverage).toBe("friendly_fire");
  });

  it("counts own threatened buildings once, includes construction, and respects strict outer radius", () => {
    const { observation, evaluate } = fixture();
    observation.units = [
      unit({ type: UnitType.AtomBomb, target: 34, range: 2 }),
      unit({ id: 2, type: UnitType.AtomBomb, target: 34, range: 2 }),
      unit({ id: 3, owner: 1, type: UnitType.City, tile: 35, level: 3 }),
      unit({
        id: 4,
        owner: 1,
        type: UnitType.Factory,
        tile: 34,
        constructing: true,
      }),
      unit({ id: 5, owner: 1, type: UnitType.Port, tile: 36 }),
      unit({ id: 6, owner: 2, type: UnitType.City, tile: 34 }),
      unit({ id: 7, owner: 1, type: UnitType.City, tile: 34, active: false }),
    ];
    const params = evaluate().items[0].params;
    expect(params[UnitType.City]).toBe(1);
    expect(params[UnitType.Factory]).toBe(1);
    expect(params[UnitType.Port]).toBe(0);
    observation.units[2].tile = 900;
    expect(evaluate().items[0].params[UnitType.City]).toBe(0);
    observation.units[0].active = false;
    observation.units[1].active = false;
    expect(evaluate().items.some((i) => i.rule === "nuke")).toBe(false);
  });
});

describe("economy, diplomacy, endgame and alert lifecycle", () => {
  it("requires affordable and connected sampled investments", () => {
    const { observation, evaluate } = fixture();
    observation.builds = [
      {
        type: UnitType.City,
        tile: 34,
        cost: 125_000n,
        affordable: true,
        connected: true,
      },
      {
        type: UnitType.Factory,
        tile: 34,
        cost: 250_000n,
        affordable: true,
        connected: false,
      },
      {
        type: UnitType.Port,
        tile: 34,
        cost: 500_000n,
        affordable: false,
        connected: true,
      },
    ];
    expect(
      evaluate()
        .items.filter((i) => i.id.startsWith("economy:"))
        .map((i) => i.rule),
    ).toEqual(["city"]);
    observation.queryState = "error";
    expect(evaluate().items.some((i) => i.id.startsWith("economy:"))).toBe(
      false,
    );
  });

  it("uses the supplied live cost rather than an independent price table", () => {
    const { observation, evaluate } = fixture();
    observation.builds = [
      {
        type: UnitType.Port,
        tile: 34,
        cost: 987_654n,
        affordable: true,
        connected: true,
      },
    ];
    expect(evaluate().items.find((i) => i.rule === "port")?.params.cost).toBe(
      "987654",
    );
  });

  it("prioritizes clock pressure only when the mode is enabled", () => {
    const { observation, evaluate } = fixture();
    observation.players[0].doomed = true;
    expect(evaluate().items.some((i) => i.rule === "clock")).toBe(false);
    observation.clockEnabled = true;
    expect(evaluate().items[0].rule).toBe("clock");
    expect(evaluate().context).toBe("endgame");
  });

  it("uses the observed side share and current overtime threshold", () => {
    const { observation, evaluate } = fixture();
    observation.winShare = 0.4;
    observation.landShare = 0.35;
    expect(
      evaluate().items.find((i) => i.rule === "victory")?.params.required,
    ).toBe("40.0");
  });

  it("reports expiring alliances and traitor vulnerability", () => {
    const { observation, evaluate } = fixture();
    observation.players[0].alliances = [
      { id: 1, name: "friend", remaining: 100 },
    ];
    observation.players[0].traitor = true;
    expect(evaluate().items.map((i) => i.rule)).toEqual(
      expect.arrayContaining(["alliance", "traitor"]),
    );
    observation.players[0].alliances[0].remaining = 0;
    expect(evaluate().items.some((i) => i.rule === "alliance")).toBe(false);
  });

  it("keeps stable IDs, deduplicates updates and copies observation history", () => {
    const { observation, evaluate } = fixture();
    const first = evaluate().items.find((i) => i.rule === "neutral")!;
    observation.tick++;
    const second = evaluate().items.find((i) => i.rule === "neutral")!;
    expect(second.id).toBe(first.id);
    expect(second.firstTick).toBe(first.firstTick);
    expect(first.lastTick).toBe(100);
  });

  it("snoozes for simulation ticks and allows material escalation", () => {
    const { observation, engine, evaluate } = fixture();
    observation.units = [unit()];
    evaluate();
    engine.hide("transport:1", observation.tick, true);
    observation.tick += 299;
    expect(evaluate().items.some((i) => i.rule === "landing")).toBe(false);
    observation.units[0].troops = 200_000;
    expect(evaluate().items.some((i) => i.rule === "landing")).toBe(true);
    observation.units[0].troops = 10_000;
    observation.tick++;
    expect(evaluate().items.some((i) => i.rule === "landing")).toBe(true);
  });

  it("dismisses a situation until it resolves and subsequently returns", () => {
    const { observation, engine, evaluate } = fixture();
    observation.units = [unit()];
    evaluate();
    engine.hide("transport:1", observation.tick, false);
    expect(evaluate().items.some((i) => i.rule === "landing")).toBe(false);
    observation.units = [];
    evaluate();
    observation.units = [unit()];
    expect(evaluate().items.some((i) => i.rule === "landing")).toBe(true);
  });
});
