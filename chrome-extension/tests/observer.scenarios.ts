import {
  GameMode,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import assert from "node:assert/strict";
import test from "node:test";
import { AdvisorEngine } from "../../src/client/advisor/AdvisorEngine";
import { gamePhase } from "../../src/client/advisor/GamePhase";
import { SpatialIndex } from "../../src/client/advisor/SpatialIndex";
import { isControl, startBridge } from "../src/Main";
import { analyze, GameObserver, observe, rawTroops } from "../src/Observer";
import type {
  AdvisorSnapshot,
  ObserverScheduler,
  RemoteGame,
  RemotePlayer,
  RemoteUnit,
} from "../src/Observer";
import { goldValue, StrategyAdvisor } from "../src/Strategy";
import type { StrategySnapshot } from "../src/Strategy";

function fixture(size = 32) {
  let tick = 1;
  let catchup = false;
  let over = false;
  let spawn = false;
  let present = true;
  let incoming = 0;
  let outgoing = 0;
  let cap = 1000;
  let reads = 0;
  let landTotal = size * 16;
  let elapsed = 2000;
  let clockEnabled = false;
  const owners = new Array<number>(size).fill(0);
  owners[0] = 1;
  if (size > 1) owners[1] = 2;
  const me = player(1, 100);
  const enemy = player(2, 200);
  const ally = player(3, 300);
  const players = [me, enemy, ally];
  const units: RemoteUnit[] = [];
  let changed: number[] = [];
  const calls: { receiver: unknown; args: unknown[] }[] = [];
  const result = {};
  const game: RemoteGame = {
    width: () => size,
    height: () => 1,
    x: (tile) => tile,
    y: () => 0,
    isLand: () => {
      reads++;
      return true;
    },
    isImpassable: () => false,
    tileState: () => 0,
    terrainByte: () => 0,
    ownerID: (tile) => owners[tile],
    update(...args) {
      calls.push({ receiver: this, args });
      if (args[0] === "throw") throw result;
      tick++;
      const input = args[0];
      changed = Array.isArray(input)
        ? input
        : input &&
            typeof input === "object" &&
            "changed" in input &&
            Array.isArray(input.changed)
          ? input.changed
          : [];
      return result;
    },
    myPlayer: () => (present ? me : null),
    players: () => players,
    units: () => units,
    ticks: () => tick,
    ticksSinceStart: () => elapsed,
    elapsedGameSeconds: () => elapsed / 10,
    numLandTiles: () => landTotal,
    numTilesWithFallout: () => 0,
    recentlyUpdatedTiles: () => changed,
    gameOver: () => over,
    inSpawnPhase: () => spawn,
    isCatchingUp: () => catchup,
    config: () => ({
      maxTroops: () => cap,
      gameConfig: () => ({ gameMode: GameMode.Team }),
      percentageTilesOwnedToWin: () => 80,
      doomsdayClockConfig: () => ({ enabled: clockEnabled }),
      nukeMagnitudes: () => ({ outer: 3 }),
      isUnitDisabled: () => true,
    }),
  };
  me.incomingAttacks = () =>
    incoming ? [{ troops: incoming, attackerID: enemy.smallID() }] : [];
  me.outgoingAttacks = () => (outgoing ? [{ troops: outgoing }] : []);
  me.buildables = async (_tile, types) =>
    types.map((type) => ({ type, cost: 125000n, canBuild: false }));
  const queued = new Map<number, () => void>();
  let time = 0;
  let next = 0;
  const scheduler: ObserverScheduler = {
    now: () => {
      time += 0.3;
      return time;
    },
    schedule: (callback) => {
      queued.set(++next, callback);
      return next;
    },
    cancel: (handle) => {
      queued.delete(handle as number);
    },
  };
  const snapshots: { snapshot: AdvisorSnapshot; urgent: boolean }[] = [];
  const observer = new GameObserver(
    game,
    (snapshot, urgent) => snapshots.push({ snapshot, urgent }),
    scheduler,
    16,
  );
  const drain = () => {
    for (let count = 0; queued.size; count++) {
      assert.ok(count < 10000, "bounded initialization eventually completes");
      const [key, callback] = queued.entries().next().value!;
      queued.delete(key);
      callback();
    }
  };
  return {
    game,
    me,
    enemy,
    ally,
    units,
    owners,
    observer,
    snapshots,
    queued,
    calls,
    result,
    drain,
    setIncoming: (n: number) => {
      incoming = n;
    },
    setOutgoing: (n: number) => {
      outgoing = n;
    },
    setCap: (n: number) => {
      cap = n;
    },
    setCatchup: (value: boolean) => {
      catchup = value;
    },
    setOver: (value: boolean) => {
      over = value;
    },
    setSpawn: (value: boolean) => {
      spawn = value;
    },
    setPresent: (value: boolean) => {
      present = value;
    },
    setElapsed: (n: number) => {
      elapsed = n;
    },
    setLandTotal: (n: number) => {
      landTotal = n;
    },
    enableClock: () => {
      clockEnabled = true;
    },
    reads: () => reads,
  };
}

function player(id: number, troops: number): RemotePlayer {
  return Object.assign(basePlayer(id, troops), {
    gold: (): bigint => 0n,
    nameLocation: (): { x: number; y: number; size: number } | undefined => ({
      x: id * 2,
      y: 3,
      size: 10,
    }),
  });
}

function basePlayer(id: number, troops: number): RemotePlayer {
  return {
    smallID: () => id,
    displayName: () => `<b>Player ${id}</b>`,
    type: () => PlayerType.Human,
    team: () => null,
    isAlive: () => true,
    isFriendly: () => false,
    numTilesOwned: () => 1,
    troops: () => troops,
    incomingAttacks: () => [],
    outgoingAttacks: () => [],
    isTraitor: () => false,
    state: { isDisconnected: false, inDoomsdayClock: false },
  };
}

function unit(
  owner: RemotePlayer,
  type: UnitType,
  target?: number,
): RemoteUnit {
  return {
    id: () => 1,
    owner: () => owner,
    type: () => type,
    tile: () => 1,
    targetTile: () => target,
    isActive: () => true,
    isUnderConstruction: () => false,
    level: () => 1,
    state: { retreating: false },
  };
}

function strategyFixture() {
  const f = fixture(64 * 64);
  f.game.width = () => 64;
  f.game.height = () => 64;
  f.game.x = (tile) => tile % 64;
  f.game.y = (tile) => Math.floor(tile / 64);
  f.game.isLand = (tile) => tile >= 64;
  f.owners.fill(1);
  for (let y = 0; y < 64; y++) f.owners[y * 64 + 63] = 2;
  f.me.troops = () => 400;
  const config = f.game.config();
  f.game.config = () => ({
    ...config,
    isUnitDisabled: () => false,
    unitInfo: (type) => ({
      constructionDuration: type === UnitType.SAMLauncher ? 300 : 20,
    }),
    msPerTick: () => 100,
    defensePostRange: () => 30,
    samRange: () => 70,
  });
  let gold = 125000n;
  let cost = 125000n;
  let changes = 0;
  const queries: { tile: number | undefined; types: readonly UnitType[] }[] =
    [];
  f.me.gold = () => gold;
  f.me.buildables = async (tile, types) => {
    queries.push({ tile, types });
    return types.map((type) => ({
      type,
      cost,
      canBuild: tile !== undefined && f.game.ownerID(tile) === 1 ? tile : false,
    }));
  };
  const spatial = new SpatialIndex(f.game, 1);
  spatial.initialize(4096);
  const strategy = new StrategyAdvisor(f.game, () => changes++);
  const flush = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const add = (
    type: UnitType,
    tile = 32 * 64 + 32,
    owner = f.me,
    pending = false,
  ) => {
    const u = unit(owner, type);
    u.id = () => f.units.indexOf(u) + 1;
    u.tile = () => tile;
    u.isUnderConstruction = () => pending;
    u.level = () => 1;
    f.units.push(u);
    return u;
  };
  return {
    ...f,
    spatial,
    strategy,
    queries,
    flush,
    add,
    setGold: (value: bigint) => {
      gold = value;
    },
    setCost: (value: bigint) => {
      cost = value;
    },
    changes: () => changes,
  };
}

void test("strategy uses exact worker prices, strict affordability and validated sites", async () => {
  const f = strategyFixture();
  try {
    assert.equal(goldValue(123n), 123n);
    assert.equal(goldValue(123), 123n);
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "123", null])
      assert.throws(() => goldValue(invalid));
    f.setGold(124999n);
    f.strategy.poll(f.spatial, 0);
    await f.flush();
    assert.equal(f.strategy.snapshot.status, "ready");
    let plan = f.strategy.snapshot.builds[0];
    assert.equal(plan.type, UnitType.City);
    assert.equal(plan.reason, "foundation");
    assert.equal(plan.cost, "125000");
    assert.equal(plan.shortfall, "1");
    assert.equal(plan.affordable, false);
    assert.equal(plan.tile, null);
    assert.equal(
      f.queries.length,
      1,
      "saving does not query eligible locations",
    );
    f.setGold(125000n);
    f.strategy.poll(f.spatial, 1500);
    await f.flush();
    plan = f.strategy.snapshot.builds[0];
    assert.equal(plan.affordable, true, "equality is affordable");
    assert.equal(plan.placement, "valid");
    assert.equal(plan.shortfall, "0");
    assert.equal(plan.constructionSeconds, 2);
    assert.ok(
      f.queries.some((q) => q.tile === plan.tile && q.types[0] === plan.type),
    );
    f.setGold(0n);
    f.strategy.poll(f.spatial, 1600);
    assert.equal(
      f.strategy.snapshot.builds[0].tile,
      null,
      "spend clears marker without waiting for next query",
    );
    assert.equal(f.strategy.snapshot.builds[0].shortfall, "125000");
  } finally {
    f.strategy.dispose();
  }
});

void test("economy balances real construction counts, coastal trade and factory production", async () => {
  const f = strategyFixture();
  try {
    f.add(UnitType.City);
    f.strategy.poll(f.spatial, 0);
    await f.flush();
    assert.equal(f.strategy.snapshot.builds[0].type, UnitType.Port);
    f.add(UnitType.Port, 64 + 20);
    f.strategy.poll(f.spatial, 1500);
    await f.flush();
    assert.equal(f.strategy.snapshot.builds[0].type, UnitType.Factory);
    f.add(UnitType.Factory, 1000, f.me, true);
    f.me.troops = () => 800;
    f.strategy.poll(f.spatial, 3000);
    await f.flush();
    assert.equal(f.strategy.snapshot.builds[0].type, UnitType.City);
    assert.equal(f.strategy.snapshot.builds[0].reason, "capacity");
    f.add(UnitType.City, 2000, f.me, true);
    f.strategy.poll(f.spatial, 4500);
    await f.flush();
    assert.ok(
      !f.strategy.snapshot.builds.some(
        (b) => b.type === UnitType.City || b.type === UnitType.Factory,
      ),
      "do not recommend duplicate builds already under construction",
    );
  } finally {
    f.strategy.dispose();
  }
});

void test("strategy distinguishes actual humans, retreat, teammates, allies and strength boundaries", async () => {
  const f = strategyFixture();
  try {
    f.enemy.troops = () => 799;
    f.me.incomingAttacks = () => [
      { attackerID: 2, troops: 900, retreating: true },
    ];
    f.strategy.poll(f.spatial, 0);
    await f.flush();
    assert.equal(f.strategy.snapshot.threats.length, 0);
    f.enemy.troops = () => 800;
    f.strategy.poll(f.spatial, 100);
    assert.equal(f.strategy.snapshot.threats[0].kind, "neighbor");
    f.me.incomingAttacks = () => [
      { attackerID: 2, troops: 5 },
      { attackerID: 2, troops: 7 },
    ];
    f.strategy.poll(f.spatial, 200);
    assert.equal(f.strategy.snapshot.threats[0].kind, "attack");
    assert.equal(f.strategy.snapshot.threats[0].troops, 12);
    assert.equal(f.strategy.snapshot.builds[0].paused, true);
    assert.equal(f.strategy.snapshot.builds[0].tile, null);
    for (const type of [PlayerType.Bot, PlayerType.Nation]) {
      f.enemy.type = () => type;
      f.strategy.poll(f.spatial, 300);
      assert.equal(f.strategy.snapshot.threats.length, 0);
    }
    f.enemy.type = () => PlayerType.Human;
    f.me.team = f.enemy.team = () => "same";
    f.enemy.state.isDisconnected = true;
    f.strategy.poll(f.spatial, 400);
    assert.equal(f.strategy.snapshot.threats.length, 0);
    f.enemy.team = () => "different";
    f.me.isFriendly = () => true;
    f.strategy.poll(f.spatial, 500);
    assert.equal(f.strategy.snapshot.threats.length, 0);
  } finally {
    f.strategy.dispose();
  }
});

void test("missile blast overlap differs from silo capability and SAM suggestions cover uncovered assets", async () => {
  const f = strategyFixture();
  try {
    f.add(UnitType.City);
    const silo = f.add(UnitType.MissileSilo, 100, f.enemy, true);
    const missile = f.add(UnitType.AtomBomb, 101, f.enemy);
    missile.targetTile = () => 32 * 64 + 63;
    f.strategy.poll(f.spatial, 0);
    await f.flush();
    assert.deepEqual(
      f.strategy.snapshot.threats.map((t) => t.kind),
      ["missile", "capability"],
    );
    let sam = f.strategy.snapshot.builds.find(
      (b) => b.type === UnitType.SAMLauncher,
    )!;
    assert.equal(sam.reason, "coverage");
    assert.equal(sam.placement, "valid");
    assert.equal(sam.constructionSeconds, 30);
    assert.equal(f.strategy.snapshot.builds[0].paused, true);
    const existing = f.add(UnitType.SAMLauncher);
    f.strategy.poll(f.spatial, 1500);
    await f.flush();
    assert.ok(
      !f.strategy.snapshot.builds.some((b) => b.type === UnitType.SAMLauncher),
      "completed positional coverage avoids duplicates",
    );
    existing.isUnderConstruction = () => true;
    silo.isActive = () => false;
    missile.isActive = () => false;
    f.strategy.poll(f.spatial, 3000);
    await f.flush();
    assert.equal(f.strategy.snapshot.threats.length, 0);
    assert.ok(
      !f.strategy.snapshot.builds.some((b) => b.type === UnitType.SAMLauncher),
    );
  } finally {
    f.strategy.dispose();
  }
});

void test("Defense Posts cover the actual human frontier from owned setback tiles", async () => {
  const f = strategyFixture();
  try {
    f.me.incomingAttacks = () => [{ attackerID: 2, troops: 123 }];
    f.strategy.poll(f.spatial, 0);
    await f.flush();
    const plan = f.strategy.snapshot.builds.find(
      (b) => b.type === UnitType.DefensePost,
    )!;
    assert.equal(plan.placement, "valid");
    assert.equal(f.game.ownerID(plan.tile!), 1);
    const distanceToEnemy = 63 - (plan.tile! % 64);
    assert.ok(
      distanceToEnemy >= 3 && distanceToEnemy <= 30,
      "inside protection range, not on the border",
    );
    assert.ok(
      f.queries.length <= 10,
      "one prices query plus at most three probes per recommendation",
    );
    f.add(UnitType.DefensePost, plan.tile!);
    f.strategy.poll(f.spatial, 1500);
    await f.flush();
    const next = f.strategy.snapshot.builds.find(
      (b) => b.type === UnitType.DefensePost,
    );
    if (next?.tile !== null && next?.tile !== undefined)
      assert.ok(
        Math.hypot(
          (next.tile % 64) - (plan.tile! % 64),
          Math.floor(next.tile / 64) - Math.floor(plan.tile! / 64),
        ) >= 15,
      );
  } finally {
    f.strategy.dispose();
  }
});

void test("invalid sites stay unmarked; missing APIs and rejected queries are explicit and retryable", async () => {
  const f = strategyFixture();
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args) => {
    errors.push(args);
  };
  try {
    const query = f.me.buildables!;
    f.me.buildables = async (tile, types) =>
      (await query(tile, types)).map((r) => ({ ...r, canBuild: false }));
    f.strategy.poll(f.spatial, 0);
    await f.flush();
    assert.equal(f.strategy.snapshot.builds[0].placement, "not-found");
    assert.equal(f.strategy.snapshot.builds[0].tile, null);
    assert.equal(f.queries.length, 4);
    f.me.buildables = async () => {
      throw new Error("worker unavailable");
    };
    f.strategy.poll(f.spatial, 1500);
    await f.flush();
    assert.equal(f.strategy.snapshot.status, "unavailable");
    assert.match(f.strategy.snapshot.error!, /worker unavailable/);
    assert.equal(f.strategy.snapshot.builds.length, 0);
    assert.ok(errors.length > 0);
    f.me.buildables = undefined;
    f.strategy.poll(f.spatial, 3000);
    await f.flush();
    assert.match(f.strategy.snapshot.error!, /buildables/);
    f.me.buildables = query;
    f.strategy.poll(f.spatial, 4500);
    await f.flush();
    assert.equal(f.strategy.snapshot.status, "ready");
    assert.equal(f.strategy.snapshot.error, null);
  } finally {
    f.strategy.dispose();
    console.error = originalError;
  }
});

void test("late worker replies cannot resurrect placements after disposal, catchup or rollback", async () => {
  for (const mode of ["dispose", "catchup", "rollback"]) {
    const f = strategyFixture();
    const query = f.me.buildables!;
    let resolve!: (value: Awaited<ReturnType<typeof query>>) => void;
    let count = 0;
    f.me.buildables = async (tile, types) => {
      count++;
      return new Promise((done) => {
        resolve = done;
      });
    };
    try {
      f.strategy.poll(f.spatial, 0);
      assert.equal(count, 1);
      if (mode === "dispose") f.strategy.dispose();
      if (mode === "catchup") {
        f.setCatchup(true);
        f.strategy.poll(null, 500);
      }
      if (mode === "rollback") {
        f.game.ticks = () => 0;
        f.strategy.poll(null, 500);
      }
      resolve(
        await query(undefined, [
          UnitType.City,
          UnitType.Port,
          UnitType.Factory,
          UnitType.DefensePost,
          UnitType.SAMLauncher,
        ]),
      );
      await f.flush();
      assert.equal(f.strategy.snapshot.builds.length, 0);
      assert.equal(f.changes(), 0);
      assert.equal(
        count,
        1,
        "stale queries cannot issue more placement requests",
      );
    } finally {
      f.strategy.dispose();
    }
  }
});

void test("strategy timeouts surface an error and late replies cannot restart the expired scan", async (t) => {
  const f = strategyFixture();
  const originalError = console.error;
  console.error = () => {};
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve!: (
    value: { type: UnitType; cost: bigint; canBuild: false }[],
  ) => void;
  let count = 0;
  f.me.buildables = async () => {
    count++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  try {
    f.strategy.poll(f.spatial, 0);
    t.mock.timers.tick(3000);
    assert.equal(f.strategy.snapshot.status, "unavailable");
    assert.match(f.strategy.snapshot.error!, /timed out/);
    resolve(
      [
        UnitType.City,
        UnitType.Port,
        UnitType.Factory,
        UnitType.DefensePost,
        UnitType.SAMLauncher,
      ].map((type) => ({ type, cost: 125000n, canBuild: false })),
    );
    await f.flush();
    assert.equal(f.strategy.snapshot.status, "unavailable");
    assert.equal(count, 1);
    assert.equal(f.changes(), 1);
  } finally {
    f.strategy.dispose();
    console.error = originalError;
    t.mock.timers.reset();
  }
});

void test("later scans explore beyond rejected sites and never mark stale placement replies", async () => {
  const f = strategyFixture();
  const query = f.me.buildables!;
  const rejected = new Set<number>();
  f.me.buildables = async (tile, types) => {
    const result = await query(tile, types);
    if (tile === undefined) return result;
    if (rejected.size < 3) {
      rejected.add(tile);
      return result.map((r) => ({ ...r, canBuild: false }));
    }
    return result;
  };
  try {
    f.strategy.poll(f.spatial, 0);
    await f.flush();
    assert.equal(f.strategy.snapshot.builds[0].placement, "not-found");
    f.strategy.poll(f.spatial, 1500);
    await f.flush();
    assert.equal(f.strategy.snapshot.builds[0].placement, "valid");
    assert.equal(rejected.has(f.strategy.snapshot.builds[0].tile!), false);

    let resolve!: (value: Awaited<ReturnType<typeof query>>) => void;
    let checkingTile: number | undefined;
    f.me.buildables = async (tile, types) => {
      if (tile === undefined) return query(tile, types);
      checkingTile = tile;
      return new Promise((done) => {
        resolve = done;
      });
    };
    f.strategy.poll(f.spatial, 3000);
    await f.flush();
    assert.notEqual(checkingTile, undefined);
    f.setGold(0n);
    resolve(await query(checkingTile, [UnitType.City]));
    await f.flush();
    assert.equal(f.strategy.snapshot.builds[0].tile, null);
    assert.equal(f.strategy.snapshot.builds[0].affordable, false);
    assert.equal(f.strategy.snapshot.builds[0].shortfall, "125000");

    f.setGold(125000n);
    f.strategy.poll(f.spatial, 4500);
    await f.flush();
    const changes = f.changes();
    f.strategy.dispose();
    resolve(await query(checkingTile, [UnitType.City]));
    await f.flush();
    assert.equal(f.strategy.snapshot.builds.length, 0);
    assert.equal(
      f.changes(),
      changes,
      "late location replies do not publish or issue more probes",
    );
  } finally {
    f.strategy.dispose();
  }
});

void test("nuclear evidence handles MIRVs and launched missiles even after their owner dies", async () => {
  const f = strategyFixture();
  try {
    const mirv = f.add(UnitType.MIRV, 100, f.enemy);
    mirv.targetTile = () => 2000;
    f.strategy.poll(f.spatial, 0);
    await f.flush();
    assert.equal(f.strategy.snapshot.threats[0].kind, "missile");
    f.enemy.isAlive = () => false;
    f.strategy.poll(f.spatial, 500);
    assert.equal(f.strategy.snapshot.threats[0].kind, "missile");
    mirv.targetTile = () => 63;
    f.strategy.poll(f.spatial, 1000);
    assert.equal(
      f.strategy.snapshot.threats.length,
      0,
      "MIRV targeting someone else is not a confirmed local blast",
    );
    mirv.isActive = () => false;
    const warhead = f.add(UnitType.MIRVWarhead, 101, f.enemy);
    warhead.targetTile = () => 32 * 64 + 63;
    f.strategy.poll(f.spatial, 1500);
    await f.flush();
    assert.equal(
      f.strategy.snapshot.threats[0].kind,
      "missile",
      "warhead blast can overlap land outside the target owner's territory",
    );
    f.me.isFriendly = () => true;
    f.strategy.poll(f.spatial, 2000);
    assert.equal(f.strategy.snapshot.threats.length, 0);
  } finally {
    f.strategy.dispose();
  }
});

void test("bridge publishes coherent plans, camera-follow placements and deduplicated human warnings", async () => {
  const f = strategyFixture();
  const messages: {
    type: string;
    advisor?: AdvisorSnapshot;
    strategy?: StrategySnapshot | null;
    buildMarkers?: {
      id: number;
      type: UnitType;
      x: number;
      y: number;
      radius: number;
    }[];
  }[] = [];
  let camera = 0;
  let poll!: () => void;
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const frames = new Map<number, () => void>();
  let frameID = 0;
  const fakeWindow = {
    location: { origin: "https://openfront.io" },
    postMessage: (message: (typeof messages)[number]) => messages.push(message),
    setInterval: (callback: () => void) => {
      poll = callback;
      return 1;
    },
    clearInterval: () => {},
    requestAnimationFrame: (callback: () => void) => {
      frames.set(++frameID, callback);
      return frameID;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    addEventListener: (name: string, callback: (event: MessageEvent) => void) =>
      listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { classList: { contains: () => true } },
      querySelector: () => ({
        game: f.game,
        transformHandler: {
          scale: 2,
          worldToScreenCoordinates: (point: { x: number; y: number }) => ({
            x: point.x * 2 + camera,
            y: point.y * 2,
          }),
        },
      }),
    },
  });
  const stop = startBridge();
  try {
    for (let i = 0; i < 20; i++) {
      await f.flush();
      poll();
      if (messages.some((m) => m.strategy?.status === "ready")) break;
    }
    const state = messages
      .filter(
        (m) =>
          m.type === "OPENFRONT_OVERLAY_STATE" &&
          m.strategy?.status === "ready",
      )
      .at(-1)!;
    assert.ok(state);
    const plan = state.strategy!.builds[0];
    const marker = messages
      .filter((m) => m.type === "OPENFRONT_OVERLAY_BUILDS")
      .at(-1)!.buildMarkers![0];
    assert.equal(marker.type, plan.type);
    assert.equal(marker.x, (f.game.x(plan.tile!) + 0.5) * 2);
    const queries = f.queries.length;
    camera = 100;
    const [frame, callback] = frames.entries().next().value!;
    frames.delete(frame);
    callback();
    assert.equal(
      messages.filter((m) => m.type === "OPENFRONT_OVERLAY_BUILDS").at(-1)!
        .buildMarkers![0].x,
      marker.x + 100,
    );
    assert.equal(
      f.queries.length,
      queries,
      "animation frames only project; never query eligibility",
    );
    f.me.incomingAttacks = () => [{ attackerID: 2, troops: 50 }];
    poll();
    poll();
    assert.equal(
      messages.filter((m) => m.type === "OPENFRONT_OVERLAY_HUMAN_ATTACK")
        .length,
      1,
    );
    const underAttack = messages
      .filter((m) => m.type === "OPENFRONT_OVERLAY_STATE")
      .at(-1)!.strategy!;
    assert.equal(underAttack.threats[0].kind, "attack");
    assert.equal(underAttack.builds[0].tile, null);
    listeners.get("message")!({
      source: fakeWindow,
      origin: "https://openfront.io",
      data: { type: "OPENFRONT_OVERLAY_CONTROL", enabled: false, requestId: 1 },
    } as MessageEvent);
    assert.equal(
      messages.filter((m) => m.type === "OPENFRONT_OVERLAY_STATE").at(-1)!
        .strategy,
      null,
    );
    assert.equal(
      messages.filter((m) => m.type === "OPENFRONT_OVERLAY_BUILDS").at(-1)!
        .buildMarkers!.length,
      0,
    );
  } finally {
    stop();
    f.strategy.dispose();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  }
});

void test("opt-in, raw integer snapshot, incoming totals and safe original update behavior", () => {
  const f = fixture();
  const original = f.game.update;
  assert.equal(f.observer.snapshot.status, "disabled");
  assert.equal(f.game.update, original);
  f.observer.setEnabled(true);
  f.drain();
  assert.equal(f.observer.snapshot.cap, 1000);
  assert.equal(f.observer.snapshot.reservePercent, 10);
  assert.equal(f.observer.snapshot.neighbors[0].troops, 200);
  const argument = [2];
  assert.equal(f.game.update(argument, "second"), f.result);
  assert.deepEqual(f.calls.at(-1), {
    receiver: f.game,
    args: [argument, "second"],
  });
  assert.throws(
    () => f.game.update("throw"),
    (error) => error === f.result,
  );
  f.setIncoming(50);
  f.game.update([]);
  assert.equal(f.observer.snapshot.incoming, 50);
  assert.equal(f.snapshots.at(-1)?.urgent, true);
  f.observer.setEnabled(false);
  assert.equal(f.game.update, original);
  assert.equal(f.observer.snapshot.status, "disabled");
  assert.equal(rawTroops(1234.99), 1234);
  assert.throws(() => rawTroops(NaN));
  assert.throws(() => rawTroops(-1));
  assert.throws(() => rawTroops(Number.MAX_SAFE_INTEGER + 1));
});

void test("bounded sliced baseline retains every delta across updates before publishing", () => {
  const f = fixture(100000);
  f.observer.setEnabled(true);
  assert.equal(f.observer.snapshot.status, "indexing");
  assert.ok(f.reads() < 5000, "first slice does not scan the whole map");
  f.owners[1] = 3;
  f.game.update([1]);
  f.owners[2] = 1;
  f.game.update([2]);
  f.owners[3] = 2;
  f.game.update([3]);
  f.drain();
  assert.equal(f.observer.snapshot.status, "active");
  assert.deepEqual(
    f.observer.snapshot.neighbors.map((p) => p.id),
    [2, 3],
  );
  f.owners[3] = 0;
  f.game.update([3]);
  assert.deepEqual(
    f.observer.snapshot.neighbors.map((p) => p.id),
    [3],
  );
  f.observer.dispose();
});

void test("backlog overflow rebuilds the live baseline; catchup and pause recover", () => {
  const f = fixture(10000);
  f.observer.setEnabled(true);
  f.owners[1] = 3;
  const before = f.observer.snapshot.status;
  f.game.update(Array.from({ length: 17 }, (_, i) => i));
  assert.equal(
    f.observer.snapshot.status,
    before === "active" ? "active" : "catchup",
    "an established snapshot is retained during a rebuild",
  );
  f.drain();
  assert.deepEqual(
    f.observer.snapshot.neighbors.map((p) => p.id),
    [3],
  );
  f.setCatchup(true);
  f.owners[1] = 2;
  f.game.update([1]);
  assert.equal(
    f.observer.snapshot.status,
    "active",
    "catchup keeps the index and the last guidance",
  );
  f.setCatchup(false);
  f.observer.poll();
  f.drain();
  assert.deepEqual(
    f.observer.snapshot.neighbors.map((p) => p.id),
    [2],
  );
  const count = f.snapshots.length;
  f.observer.poll();
  assert.equal(f.snapshots.length, count, "no reevaluation on a paused tick");
  f.observer.dispose();
});

void test("spawn, spectator, death, completion and re-enable reset lifecycle", () => {
  const f = fixture();
  f.setPresent(false);
  f.observer.setEnabled(true);
  assert.equal(f.observer.snapshot.status, "waiting");
  f.setPresent(true);
  f.setSpawn(true);
  f.game.update([]);
  assert.equal(f.observer.snapshot.status, "waiting");
  f.setSpawn(false);
  f.game.update([]);
  f.drain();
  assert.equal(f.observer.snapshot.status, "active");
  f.me.isAlive = () => false;
  f.game.update([]);
  assert.equal(f.observer.snapshot.status, "finished");
  assert.equal(f.observer.snapshot.enabled, false);
  f.me.isAlive = () => true;
  f.observer.setEnabled(true);
  f.drain();
  assert.equal(f.observer.snapshot.status, "active");
  f.setOver(true);
  f.observer.poll();
  assert.equal(f.observer.snapshot.status, "finished");
  assert.equal(f.queued.size, 0);
});

void test("pre-spawn game-over state remains enabled until spawning is available", () => {
  const f = fixture();
  f.setSpawn(true);
  f.setOver(true);
  f.observer.setEnabled(true);
  assert.equal(f.observer.snapshot.status, "waiting");
  assert.equal(f.observer.snapshot.enabled, true);

  f.setOver(false);
  f.setSpawn(false);
  f.observer.poll();
  f.drain();
  assert.equal(f.observer.snapshot.status, "active");
  assert.equal(f.observer.snapshot.enabled, true);
});

void test("unsupported APIs and analysis failures never throw through updates", () => {
  const f = fixture();
  const original = f.game.update;
  Object.defineProperty(f.game, "numTilesWithFallout", { value: undefined });
  f.observer.setEnabled(true);
  assert.equal(f.observer.snapshot.status, "unsupported");
  assert.match(f.observer.snapshot.error!, /numTilesWithFallout/);
  assert.equal(f.game.update, original);
  const g = fixture();
  g.observer.setEnabled(true);
  g.drain();
  g.enemy.state.isDisconnected = undefined!;
  assert.equal(g.game.update([]), g.result);
  assert.equal(g.observer.snapshot.status, "unsupported");
  const h = fixture();
  h.observer.setEnabled(true);
  h.drain();
  h.game.units = () => {
    throw new Error("fixture failure");
  };
  assert.equal(h.game.update([]), h.result);
  assert.equal(h.observer.snapshot.status, "error");
  assert.match(h.observer.snapshot.error!, /fixture failure/);
});

void test("restores inherited methods without overwriting a subsequent observer", () => {
  const f = fixture();
  const original = f.game.update;
  delete (f.game as Partial<RemoteGame>).update;
  Object.setPrototypeOf(f.game, { update: original });
  f.observer.setEnabled(true);
  f.observer.setEnabled(true);
  assert.equal(f.game.update([]), f.result);
  assert.equal(f.calls.length, 1, "reenabling does not duplicate wrappers");
  f.observer.setEnabled(false);
  assert.equal(Object.hasOwn(f.game, "update"), false);
  f.observer.setEnabled(true);
  const other = () => "another observer";
  f.game.update = other;
  f.observer.dispose();
  assert.equal(f.game.update, other);
});

void test("all five phases and relevant stronger-neighbor rules match reference", () => {
  const f = fixture(32);
  const spatial = new SpatialIndex(f.game, 1);
  spatial.initialize(32);
  const compare = (expected: string) => {
    const observation = observe(f.game);
    const snapshot = analyze(observation, f.game, spatial);
    const reference = new AdvisorEngine(f.game, spatial).evaluate(observation);
    assert.equal(snapshot.context, expected);
    assert.equal(snapshot.context, gamePhase(observation, f.game, spatial));
    assert.equal(snapshot.context, reference.context);
    const rules = reference.items.filter((item) =>
      ["strong_neighbor", "strong_friendly_neighbor"].includes(item.rule),
    );
    assert.equal(snapshot.neighbors.length, rules.length);
    for (const neighbor of snapshot.neighbors) {
      const rule = rules.find(
        (item) => item.id === `strong_neighbor:${neighbor.id}`,
      )!;
      assert.equal(
        rule.rule,
        neighbor.friendly ? "strong_friendly_neighbor" : "strong_neighbor",
      );
      assert.equal(neighbor.troops, rule.params.troops);
    }
  };
  compare("contested");
  f.enemy.troops = () => 100;
  compare("economy");
  f.owners[1] = 0;
  spatial.ingest([1]);
  f.setElapsed(1799);
  compare("opening");
  f.setElapsed(1800);
  compare("economy");
  f.units.push(unit(f.enemy, UnitType.MissileSilo));
  compare("nuclear");
  f.me.state.inDoomsdayClock = true;
  f.enableClock();
  compare("endgame");
  f.me.state.inDoomsdayClock = false;
  f.setLandTotal(1);
  compare("endgame");
  f.setLandTotal(100);
  f.units.length = 0;
  f.units.push(unit(f.enemy, UnitType.AtomBomb, 0));
  compare("nuclear");
  f.units.length = 0;
  f.setIncoming(1);
  compare("contested");
  f.setIncoming(0);
  f.units.push(unit(f.enemy, UnitType.TransportShip, 0));
  compare("contested");
  f.units[0].state.retreating = true;
  compare("economy");
});

void test("friendly/disconnected/team parity, strict strength boundary and alive bordering filter", () => {
  const f = fixture();
  const spatial = new SpatialIndex(f.game, 1);
  spatial.initialize();
  const snapshot = () => analyze(observe(f.game), f.game, spatial);
  f.me.isFriendly = () => true;
  assert.equal(snapshot().neighbors[0].friendly, true);
  f.enemy.state.isDisconnected = true;
  assert.equal(snapshot().neighbors[0].friendly, false);
  f.me.team = f.enemy.team = () => "red";
  assert.equal(
    snapshot().neighbors.length,
    0,
    "disconnected teammates are excluded",
  );
  assert.equal(snapshot().context, "economy");
  f.enemy.state.isDisconnected = false;
  assert.equal(
    snapshot().neighbors.length,
    0,
    "connected teammates are excluded",
  );
  f.enemy.team = () => "blue";
  assert.equal(
    snapshot().neighbors[0].friendly,
    true,
    "allies on other teams remain listed",
  );
  f.me.team = f.enemy.team = () => null;
  assert.equal(snapshot().neighbors.length, 1, "null teams are not teammates");
  f.enemy.troops = () => 100;
  assert.equal(snapshot().neighbors.length, 0, "equal troops are not stronger");
  f.enemy.troops = () => 101;
  f.enemy.isAlive = () => false;
  assert.equal(
    snapshot().neighbors.length,
    0,
    "dead stronger border is excluded",
  );
  f.enemy.isAlive = () => true;
  f.owners[1] = 0;
  spatial.ingest([1]);
  assert.equal(
    snapshot().neighbors.length,
    0,
    "non-bordering stronger players are excluded",
  );
});

void test("reserve/cap and defense boundary scenarios retain reference raw units", () => {
  const f = fixture();
  const spatial = new SpatialIndex(f.game, 1);
  spatial.initialize();
  for (const [troops, cap, incoming] of [
    [200, 1000, 100],
    [199, 1000, 99],
    [100, 0, 0],
  ]) {
    f.me.troops = () => troops;
    f.setCap(cap);
    f.setIncoming(incoming);
    const o = observe(f.game);
    const snapshot = analyze(o, f.game, spatial);
    const reference = new AdvisorEngine(f.game, spatial).evaluate(o);
    assert.equal(
      snapshot.reservePercent,
      Math.round((troops / Math.max(1, cap)) * 100),
    );
    assert.equal(snapshot.incoming, incoming);
    const defense = reference.items.find((item) => item.rule === "defense");
    assert.equal(!!defense, incoming > 0);
    if (defense) {
      assert.equal(defense.params.troops, incoming);
      assert.equal(defense.priority, incoming >= troops * 0.5 ? 96 : 78);
    }
  }
  f.setCap(1000);
  f.me.troops = () => 199;
  f.setOutgoing(200);
  assert.equal(analyze(observe(f.game), f.game, spatial).context, "contested");
  f.me.troops = () => 200;
  assert.equal(analyze(observe(f.game), f.game, spatial).context, "economy");
});

void test("recommendation uses phase reserve thresholds and retains under attack", () => {
  const f = fixture(32);
  const spatial = new SpatialIndex(f.game, 1);
  spatial.initialize();
  f.owners[1] = 0;
  spatial.ingest([1]);
  f.setElapsed(100);

  const snapshot = () => analyze(observe(f.game), f.game, spatial);
  f.me.troops = () => 331;
  assert.equal(snapshot().context, "opening");
  assert.equal(snapshot().recommendation, "push");
  f.me.troops = () => 330;
  assert.equal(snapshot().recommendation, "retain");

  f.setElapsed(1800);
  f.me.troops = () => 421;
  assert.equal(snapshot().context, "economy");
  assert.equal(snapshot().recommendation, "push");
  f.me.troops = () => 420;
  assert.equal(snapshot().recommendation, "retain");

  f.me.troops = () => 1000;
  f.setIncoming(1);
  assert.equal(snapshot().recommendation, "retain");
});

void test("stronger living frontier players force RETAIN in every phase, including allies and tribes", () => {
  for (const phase of [
    "opening",
    "economy",
    "contested",
    "nuclear",
    "endgame",
  ]) {
    const f = fixture();
    f.owners[2] = 1;
    f.me.troops = () => 600;
    f.enemy.troops = () => 601;
    f.me.isFriendly = () => phase !== "contested";
    f.setElapsed(phase === "opening" ? 100 : 2000);
    if (phase === "nuclear") {
      f.units.push(unit(f.ally, UnitType.MissileSilo));
      f.me.isFriendly = (p) => p === f.enemy;
    }
    if (phase === "endgame") {
      f.me.state.inDoomsdayClock = true;
      f.enableClock();
    }
    const spatial = new SpatialIndex(f.game, 1);
    spatial.initialize();
    const snapshot = () => analyze(observe(f.game), f.game, spatial);
    assert.equal(snapshot().context, phase);
    assert.equal(
      snapshot().recommendation,
      "retain",
      `${phase}: stronger border`,
    );

    for (const type of [PlayerType.Human, PlayerType.Nation, PlayerType.Bot]) {
      f.enemy.type = () => type;
      assert.equal(snapshot().recommendation, "retain", `${phase}: ${type}`);
    }
    f.me.team = f.enemy.team = () => "red";
    assert.equal(
      snapshot().recommendation,
      "push",
      `${phase}: teammate is not a threat`,
    );
    assert.equal(snapshot().neighbors.length, 0);
    f.me.team = f.enemy.team = () => null;
    f.enemy.troops = () => 600;
    assert.equal(snapshot().recommendation, "push", `${phase}: equal troops`);
    f.enemy.troops = () => 601;
    f.enemy.isAlive = () => false;
    assert.equal(snapshot().recommendation, "push", `${phase}: dead border`);
    f.enemy.isAlive = () => true;
    f.owners[1] = 0;
    spatial.ingest([1]);
    assert.equal(
      snapshot().recommendation,
      "push",
      `${phase}: non-bordering player`,
    );
    f.observer.dispose();
  }
});

void test("tribe attacks do not trigger defense or override PUSH; humans and nations still do", () => {
  const f = fixture();
  f.me.troops = () => 1000;
  f.enemy.type = () => PlayerType.Bot;
  f.observer.setEnabled(true);
  f.drain();
  f.setIncoming(500);
  f.game.update([]);
  f.drain();
  assert.equal(
    f.observer.snapshot.incoming,
    0,
    "tribes are not considered under attack",
  );
  assert.equal(f.observer.snapshot.recommendation, "push");
  assert.equal(f.snapshots.at(-1)?.urgent, false);

  for (const type of [PlayerType.Human, PlayerType.Nation]) {
    f.ally.type = () => type;
    f.me.incomingAttacks = () => [
      { attackerID: f.enemy.smallID(), troops: 500 },
      { attackerID: f.ally.smallID(), troops: 50 },
    ];
    f.game.update([]);
    f.drain();
    assert.equal(
      f.observer.snapshot.incoming,
      50,
      `${type} attacks still count`,
    );
    assert.equal(f.observer.snapshot.recommendation, "retain");
  }
  f.me.incomingAttacks = () => [{ attackerID: 99, troops: 75 }];
  f.game.update([]);
  f.drain();
  assert.equal(
    f.observer.snapshot.incoming,
    75,
    "unknown attackers are conservatively counted",
  );
  assert.equal(f.observer.snapshot.recommendation, "retain");
  f.observer.dispose();
});

void test("control messages strictly accept only an explicit boolean opt-in", () => {
  assert.equal(
    isControl({ type: "OPENFRONT_OVERLAY_CONTROL", enabled: true }),
    true,
  );
  assert.equal(
    isControl({ type: "OPENFRONT_OVERLAY_CONTROL", enabled: false }),
    true,
  );
  assert.equal(
    isControl({
      type: "OPENFRONT_OVERLAY_CONTROL",
      enabled: true,
      requestId: 1,
    }),
    true,
  );
  for (const invalid of [
    null,
    {},
    [],
    "true",
    { type: "OPENFRONT_OVERLAY_CONTROL", enabled: 1 },
    { type: "OPENFRONT_OVERLAY_CONTROL", enabled: true, intent: {} },
    ...[0, -1, 1.5, "1", NaN].map((requestId) => ({
      type: "OPENFRONT_OVERLAY_CONTROL",
      enabled: true,
      requestId,
    })),
  ]) {
    assert.equal(isControl(invalid), false);
  }
});

void test("display snapshots enforce roster and name limits for isolated UI validation", () => {
  const f = fixture();
  f.enemy.displayName = () => "x".repeat(250);
  f.observer.setEnabled(true);
  f.drain();
  assert.equal(f.observer.snapshot.neighbors[0].name.length, 200);
  f.game.players = () => new Array(513).fill(f.enemy);
  f.game.update([]);
  assert.equal(f.observer.snapshot.status, "unsupported");
  assert.match(f.observer.snapshot.error!, /roster size/);
});

void test("a second observer cannot duplicate wrappers and teardown retains the current owner", () => {
  const f = fixture();
  const original = f.game.update;
  f.observer.setEnabled(true);
  const replacement = new GameObserver(f.game, () => {});
  replacement.setEnabled(true);
  assert.equal(f.observer.snapshot.enabled, false);
  f.game.update([]);
  assert.equal(f.calls.length, 1);
  f.observer.dispose();
  assert.notEqual(f.game.update, original);
  replacement.dispose();
  assert.equal(f.game.update, original);
});

void test("wrapper preserves alternate receivers and absorbs failing host callbacks", () => {
  const f = fixture();
  const observer = new GameObserver(f.game, () => {
    throw new Error("host callback");
  });
  observer.setEnabled(true);
  const alternate = {};
  assert.equal(Reflect.apply(f.game.update, alternate, [[1], 7]), f.result);
  assert.deepEqual(f.calls.at(-1), { receiver: alternate, args: [[1], 7] });
  assert.equal(f.game.update([]), f.result);
  observer.dispose();
});

void test("reference phase frontier and team-victory evidence keeps its boundary semantics", () => {
  const f = fixture();
  const spatial = new SpatialIndex(f.game, 1);
  spatial.initialize();
  f.enemy.type = () => PlayerType.Bot;
  f.enemy.numTilesOwned = () => 63;
  const phase = () => analyze(observe(f.game), f.game, spatial).context;
  assert.equal(phase(), "economy");
  f.enemy.numTilesOwned = () => 64;
  assert.equal(phase(), "opening");
  f.me.team = f.ally.team = () => "red";
  f.ally.numTilesOwned = () => 64;
  f.setLandTotal(100);
  assert.equal(
    phase(),
    "endgame",
    "alive same-team land counts toward 80% of win share",
  );
  f.ally.isAlive = () => false;
  assert.equal(phase(), "opening", "dead teammate land is excluded");
  f.enemy.type = () => PlayerType.Human;
  f.me.isFriendly = () => true;
  f.units.push(unit(f.enemy, UnitType.MissileSilo));
  assert.equal(
    phase(),
    "economy",
    "friendly silo is not a nuclear phase trigger",
  );
  f.me.isFriendly = () => false;
  f.units[0].isActive = () => false;
  f.enemy.troops = () => 100;
  assert.equal(
    phase(),
    "economy",
    "inactive silo is not a nuclear phase trigger",
  );
});

void test("MAIN bridge enforces source/origin, 500ms cadence and per-game disabled reset", () => {
  const f = fixture();
  const original = f.game.update;
  let found: RemoteGame | null = f.game;
  let inGame = true;
  let discoveryFailure = false;
  let interval: (() => void) | null = null;
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const animationFrames = new Map<number, (timestamp: number) => void>();
  let animationFrameID = 0;
  let cameraX = 0;
  const messages: {
    type: string;
    status?: string;
    troops?: number | null;
    advisor?: AdvisorSnapshot;
    controlId?: number;
    missileSilos?: { id: number; x: number; y: number; radius: number }[];
  }[] = [];
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  const fakeWindow = {
    location: { origin: "https://openfront.io" },
    postMessage: (message: (typeof messages)[number], origin: string) => {
      assert.equal(origin, "https://openfront.io");
      messages.push(message);
    },
    setInterval: (callback: () => void, delay: number) => {
      assert.equal(delay, 500);
      interval = callback;
      return 1;
    },
    clearInterval: () => {
      interval = null;
    },
    requestAnimationFrame: (callback: (timestamp: number) => void) => {
      animationFrames.set(++animationFrameID, callback);
      return animationFrameID;
    },
    cancelAnimationFrame: (id: number) => {
      animationFrames.delete(id);
    },
    addEventListener: (
      name: string,
      callback: (event: MessageEvent) => void,
    ) => {
      listeners.set(name, callback);
    },
    removeEventListener: (name: string) => {
      listeners.delete(name);
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { classList: { contains: () => inGame } },
      querySelector: () => {
        return found
          ? {
              transformHandler: {
                scale: 2,
                worldToScreenCoordinates: ({
                  x,
                  y,
                }: {
                  x: number;
                  y: number;
                }) => ({
                  x: x * 10 + cameraX,
                  y: y * 20,
                }),
              },
              get game() {
                if (discoveryFailure)
                  throw new Error("fixture discovery failure");
                return found;
              },
            }
          : null;
      },
    },
  });
  let requestId = 0;
  const message = (source: unknown, origin: string, enabled: unknown) => {
    listeners.get("message")!({
      source,
      origin,
      data: {
        type: "OPENFRONT_OVERLAY_CONTROL",
        enabled,
        requestId: ++requestId,
      },
    } as MessageEvent);
  };
  const stop = startBridge();
  try {
    assert.equal(messages.at(-1)?.advisor.enabled, true, "enabled by default");
    assert.equal(messages.at(-1)?.advisor.status, "active");
    assert.equal(messages.at(-1)?.troops, 100);
    message(fakeWindow, "https://openfront.io", false);
    assert.equal(messages.at(-1)?.advisor.status, "disabled");
    interval!();
    assert.deepEqual(
      messages.filter((message) => message.type === "OPENFRONT_OVERLAY_SILOS"),
      [],
      "silo markers are skipped while disabled",
    );
    message(fakeWindow, "https://openfront.io", true);
    f.units.push(
      unit(f.enemy, UnitType.MissileSilo),
      unit(f.ally, UnitType.MissileSilo),
      unit(f.me, UnitType.MissileSilo),
    );
    f.me.isFriendly = (player) => player === f.ally;
    interval!();
    assert.deepEqual(messages.at(-1)?.missileSilos, [
      { id: 1, x: 15, y: 10, radius: 12 },
    ]);
    assert.equal(
      messages.filter(
        (message) => message.type === "OPENFRONT_OVERLAY_FIRST_ENEMY_SILO",
      ).length,
      1,
      "first enemy silo triggers one warning",
    );
    assert.equal(
      animationFrames.size,
      1,
      "enemy silo positions should be sampled on the next animation frame",
    );
    cameraX = 30;
    const [frameID, frame] = animationFrames.entries().next().value!;
    animationFrames.delete(frameID);
    frame(16);
    assert.equal(messages.at(-1)?.type, "OPENFRONT_OVERLAY_SILOS");
    assert.equal(messages.at(-1)?.missileSilos?.[0].x, 45);
    assert.equal(animationFrames.size, 1, "silo sampling stays at frame rate");
    const markerFrameCount = messages.length;
    const [unchangedFrameID, unchangedFrame] = animationFrames
      .entries()
      .next().value!;
    animationFrames.delete(unchangedFrameID);
    unchangedFrame(32);
    assert.equal(
      messages.length,
      markerFrameCount,
      "unchanged markers are not republished",
    );
    interval!();
    assert.equal(
      messages.filter(
        (message) => message.type === "OPENFRONT_OVERLAY_FIRST_ENEMY_SILO",
      ).length,
      1,
      "polling does not repeat the first-silo warning",
    );
    message(fakeWindow, "https://openfront.io", false);
    assert.deepEqual(
      messages.at(-1)?.missileSilos,
      [],
      "minimizing clears silo markers",
    );
    f.me.troops = () => {
      throw new Error("fixture troops failure");
    };
    interval!();
    interval!();
    assert.equal(messages.at(-1)?.status, "unavailable");
    assert.equal(errors.length, 1, "identical troop failures are logged once");
    f.me.troops = () => 100;
    interval!();
    f.me.troops = () => {
      throw new Error("fixture troops failure");
    };
    interval!();
    assert.equal(
      errors.length,
      2,
      "successful reads reset error deduplication",
    );
    f.me.troops = () => 100;
    interval!();
    discoveryFailure = true;
    assert.doesNotThrow(() => interval!());
    interval!();
    assert.equal(messages.at(-1)?.status, "unavailable");
    assert.equal(
      errors.length,
      3,
      "discovery errors are reported and deduplicated",
    );
    discoveryFailure = false;
    interval!();
    assert.equal(messages.at(-1)?.status, "playing");
    message({}, "https://openfront.io", true);
    message(fakeWindow, "https://evil.example", true);
    message(fakeWindow, "https://openfront.io", 1);
    assert.equal(f.game.update, original);
    message(fakeWindow, "https://openfront.io", true);
    assert.equal(messages.at(-1)?.advisor.status, "active");
    assert.equal(messages.at(-1)?.controlId, requestId);
    message(fakeWindow, "https://openfront.io", false);
    assert.equal(f.game.update, original, "minimizing removes observation");
    assert.equal(messages.at(-1)?.advisor.enabled, false);
    message(fakeWindow, "https://openfront.io", true);
    const count = messages.length;
    f.game.update([]);
    f.game.update([]);
    f.game.update([]);
    assert.equal(
      messages.length,
      count,
      "ordinary tick snapshots wait for polling",
    );
    interval!();
    assert.equal(messages.length, count + 1, "one publish per discovery poll");
    f.setIncoming(51);
    f.game.update([]);
    assert.equal(messages.at(-1)?.advisor.incoming, 51);
    assert.equal(
      messages.length,
      count + 2,
      "new incoming attack publishes immediately",
    );
    message(fakeWindow, "https://openfront.io", false);
    const next = fixture();
    found = next.game;
    interval!();
    assert.equal(f.game.update, original);
    assert.equal(
      messages.at(-1)?.advisor.enabled,
      true,
      "client replacement resets to the enabled default",
    );
    message(fakeWindow, "https://openfront.io", true);
    inGame = false;
    interval!();
    assert.equal(messages.at(-1)?.status, "idle");
    assert.equal(messages.at(-1)?.advisor.status, "disabled");
    inGame = true;
    found = null;
    interval!();
    assert.equal(messages.at(-1)?.status, "waiting");
    message(fakeWindow, "https://openfront.io", true);
    assert.equal(messages.at(-1)?.advisor.enabled, true);
    assert.equal(messages.at(-1)?.advisor.status, "waiting");
    interval!();
    assert.equal(messages.at(-1)?.advisor.enabled, true);
    message(fakeWindow, "https://openfront.io", false);
    found = f.game;
    interval!();
    assert.equal(
      f.game.update,
      original,
      "cancelled loading activation stays off",
    );
    inGame = false;
    interval!();
    inGame = true;
    found = null;
    interval!();
    message(fakeWindow, "https://openfront.io", true);
    found = f.game;
    interval!();
    assert.equal(
      messages.filter((m) => m.type === "OPENFRONT_OVERLAY_STATE").at(-1)
        ?.advisor?.status,
      "active",
    );
    assert.notEqual(
      f.game.update,
      original,
      "loading activation starts observation on discovery",
    );
    inGame = false;
    interval!();
    inGame = true;
    interval!();
    assert.equal(
      messages.filter((m) => m.type === "OPENFRONT_OVERLAY_STATE").at(-1)
        ?.advisor?.enabled,
      true,
    );
    assert.notEqual(
      f.game.update,
      original,
      "re-entering a game observes it by default",
    );
    stop();
    assert.equal(interval, null);
    assert.equal(listeners.size, 0);
  } finally {
    stop();
    console.error = originalError;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  }
});

void test("incoming transport warning ignores tribe boats but warns for nations", () => {
  const f = fixture();
  let interval: (() => void) | null = null;
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const types: string[] = [];
  const fakeWindow = {
    location: { origin: "https://openfront.io" },
    postMessage: (message: { type: string }) => {
      types.push(message.type);
    },
    setInterval: (callback: () => void) => {
      interval = callback;
      return 1;
    },
    clearInterval: () => {
      interval = null;
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    addEventListener: (
      name: string,
      callback: (event: MessageEvent) => void,
    ) => {
      listeners.set(name, callback);
    },
    removeEventListener: (name: string) => {
      listeners.delete(name);
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { classList: { contains: () => true } },
      querySelector: () => ({ game: f.game }),
    },
  });
  const stop = startBridge();
  const warnings = () =>
    types.filter((type) => type === "OPENFRONT_OVERLAY_INCOMING_BOAT").length;
  try {
    listeners.get("message")!({
      source: fakeWindow,
      origin: "https://openfront.io",
      data: {
        type: "OPENFRONT_OVERLAY_CONTROL",
        enabled: true,
        requestId: 1,
      },
    } as MessageEvent);
    f.owners[2] = f.me.smallID();
    f.units.push(unit(f.enemy, UnitType.TransportShip, 2));
    f.enemy.type = () => PlayerType.Bot;
    interval!();
    assert.equal(warnings(), 0, "tribe transports are ignored");
    f.enemy.type = () => PlayerType.Nation;
    interval!();
    assert.equal(warnings(), 1, "nation transports warn");
  } finally {
    stop();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  }
});

void test("rich players warn once, and abandoned rich players are circled", () => {
  const f = fixture();
  const rich = f.enemy as RemotePlayer & { gold: () => bigint };
  let interval: (() => void) | null = null;
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const sent: { type: string; [key: string]: unknown }[] = [];
  const fakeWindow = {
    location: { origin: "https://openfront.io" },
    postMessage: (message: { type: string }) => {
      sent.push(message);
    },
    setInterval: (callback: () => void) => {
      interval = callback;
      return 1;
    },
    clearInterval: () => {
      interval = null;
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    addEventListener: (
      name: string,
      callback: (event: MessageEvent) => void,
    ) => {
      listeners.set(name, callback);
    },
    removeEventListener: (name: string) => {
      listeners.delete(name);
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { classList: { contains: () => true } },
      querySelector: () => ({
        game: f.game,
        transformHandler: {
          scale: 2,
          worldToScreenCoordinates: (cell: { x: number; y: number }) => ({
            x: cell.x * 10,
            y: cell.y * 10,
          }),
        },
      }),
    },
  });
  const stop = startBridge();
  const count = (type: string) =>
    sent.filter((message) => message.type === type).length;
  const RICH = "OPENFRONT_OVERLAY_RICH_PLAYER";
  const ABANDONED = "OPENFRONT_OVERLAY_ABANDONED_RICH_PLAYER";
  const MARKERS = "OPENFRONT_OVERLAY_ABANDONED_TERRITORIES";
  const assertRichList = (players: { id: number; name: string }[]) =>
    assert.deepEqual(
      sent
        .filter((message) => message.type === "OPENFRONT_OVERLAY_STATE")
        .at(-1)?.playerLists,
      { richPlayers: players, traitorNeighbors: [] },
    );
  const lastMarkers = () =>
    (sent.filter((message) => message.type === MARKERS).at(-1)
      ?.abandonedPlayers ?? []) as {
      id: number;
      x: number;
      y: number;
      radius: number;
    }[];
  try {
    listeners.get("message")!({
      source: fakeWindow,
      origin: "https://openfront.io",
      data: { type: "OPENFRONT_OVERLAY_CONTROL", enabled: false, requestId: 1 },
    } as MessageEvent);
    interval!();
    rich.gold = () => 30_000_000n;
    interval!();
    assert.equal(count(RICH), 0, "nothing is reported while advice is off");
    assertRichList([]);
    listeners.get("message")!({
      source: fakeWindow,
      origin: "https://openfront.io",
      data: { type: "OPENFRONT_OVERLAY_CONTROL", enabled: true, requestId: 2 },
    } as MessageEvent);
    rich.gold = () => 24_999_999n;
    interval!();
    assert.equal(count(RICH), 0, "below the threshold is ignored");
    assertRichList([]);
    rich.gold = () => 25_000_000n;
    interval!();
    interval!();
    assert.equal(count(RICH), 1, "warns once at the threshold");
    assert.deepEqual(sent.filter((m) => m.type === RICH)[0].playerNames, [
      "<b>Player 2</b>",
    ]);
    assert.equal(count(ABANDONED), 0);
    assert.equal(lastMarkers().length, 0, "connected players are not circled");
    assertRichList([{ id: 2, name: "<b>Player 2</b>" }]);

    rich.state.isDisconnected = true;
    interval!();
    interval!();
    assert.equal(count(ABANDONED), 1, "abandoned gold warns once");
    assert.equal(count(RICH), 1);
    assertRichList([{ id: 2, name: "<b>Player 2</b>" }]);
    assert.deepEqual(lastMarkers(), [
      { id: 2, x: 45, y: 35, radius: Math.max(16, Math.sqrt(1 / Math.PI) * 2) },
    ]);

    rich.gold = () => 1n;
    interval!();
    assert.equal(lastMarkers().length, 0, "spent gold removes the circle");
    assertRichList([]);
    rich.gold = () => 30_000_000n;
    interval!();
    assert.equal(count(ABANDONED), 2, "re-arms after dropping below");

    const friend = f.ally as RemotePlayer & { gold: () => bigint };
    friend.gold = () => 99_000_000n;
    f.me.isFriendly = (other) => other === f.ally;
    f.me.team = friend.team = () => "red";
    interval!();
    assert.equal(count(RICH), 1, "teammates are ignored");
    assert.equal(count(ABANDONED), 2, "teammates are ignored");
    assertRichList([{ id: 2, name: "<b>Player 2</b>" }]);
    rich.displayName = () => "Renamed";
    interval!();
    assertRichList([{ id: 2, name: "Renamed" }]);
    rich.isAlive = () => false;
    interval!();
    assertRichList([]);
    rich.isAlive = () => true;
    f.me.isFriendly = () => true;
    rich.team = () => "red";
    interval!();
    assertRichList([]);
    f.me.isFriendly = () => false;
    rich.team = () => "blue";
    friend.gold = () => 0n;
    for (let id = 4; id <= 9; id++) {
      const other = player(id, 1);
      Object.assign(other, { gold: () => 25_000_000n });
      f.game.players().push(other);
    }
    interval!();
    assertRichList(
      [2, 4, 5, 6, 7, 8, 9].map((id) => ({
        id,
        name: id === 2 ? "Renamed" : `<b>Player ${id}</b>`,
      })),
    );
    f.me.isFriendly = () => true;
    const beforeAlliedWarning = count(RICH);
    friend.team = () => "blue";
    friend.gold = () => 99_000_000n;
    interval!();
    assert.equal(count(RICH), beforeAlliedWarning + 1, "temporary ally warns");
    assertRichList(
      [2, 3, 4, 5, 6, 7, 8, 9].map((id) => ({
        id,
        name: id === 2 ? "Renamed" : `<b>Player ${id}</b>`,
      })),
    );
    const beforeTeamWarning = count(ABANDONED);
    rich.team = () => "red";
    interval!();
    assert.equal(
      count(ABANDONED),
      beforeTeamWarning,
      "disconnected teammate does not warn",
    );
    assert.equal(
      lastMarkers().some((marker) => marker.id === 2),
      false,
    );
    rich.team = () => "blue";
    interval!();
    assert.equal(
      count(ABANDONED),
      beforeTeamWarning + 1,
      "disconnected ally warns",
    );
    f.setOver(true);
    interval!();
    assertRichList([]);
  } finally {
    stop();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  }
});

void test("betraying neighbors warn only for eligible observed alliance breaks", () => {
  const f = fixture();
  let interval: (() => void) | null = null;
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const sent: { type: string; [key: string]: unknown }[] = [];
  const fakeWindow = {
    location: { origin: "https://openfront.io" },
    postMessage: (message: { type: string }) => sent.push(message),
    setInterval: (callback: () => void) => {
      interval = callback;
      return 1;
    },
    clearInterval: () => {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    addEventListener: (name: string, callback: (event: MessageEvent) => void) =>
      listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { classList: { contains: () => true } },
      querySelector: () => ({ game: f.game }),
    },
  });
  const stop = startBridge();
  const alerts = () =>
    sent.filter(
      (message) => message.type === "OPENFRONT_OVERLAY_TRAITOR_NEIGHBOR",
    );
  const assertTraitorList = (players: { id: number; name: string }[] | null) =>
    assert.deepEqual(
      sent
        .filter((message) => message.type === "OPENFRONT_OVERLAY_STATE")
        .at(-1)?.playerLists,
      { richPlayers: [], traitorNeighbors: players },
    );
  const enable = (enabled: boolean) =>
    listeners.get("message")!({
      source: fakeWindow,
      origin: "https://openfront.io",
      data: { type: "OPENFRONT_OVERLAY_CONTROL", enabled },
    } as MessageEvent);
  const betray = (betrayedID: number, traitorID = 2) =>
    f.game.update({
      updates: {
        [GameUpdateType.BrokeAlliance]: [{ traitorID, betrayedID }],
      },
    });
  try {
    enable(false);
    f.enemy.isTraitor = () => true;
    betray(3);
    interval!();
    assert.equal(
      alerts().length,
      0,
      "inactive advisor does not observe events",
    );
    enable(true);
    interval!();
    assertTraitorList([]);
    betray(3);
    f.game.update({ updates: {} });
    interval!();
    interval!();
    assert.deepEqual(alerts()[0].playerNames, ["<b>Player 2</b>"]);
    assert.equal(
      alerts().length,
      1,
      "events survive later updates between polls",
    );
    assertTraitorList([{ id: 2, name: "<b>Player 2</b>" }]);
    betray(1);
    interval!();
    assert.equal(alerts().length, 1, "betrayals against us are excluded");
    assertTraitorList([]);
    f.ally.state.isDisconnected = true;
    betray(3);
    f.ally.state.isDisconnected = false;
    f.ally.isTraitor = () => true;
    betray(3);
    f.ally.isTraitor = () => false;
    f.enemy.isTraitor = () => false;
    betray(3);
    interval!();
    assert.equal(alerts().length, 1, "breaks without a debuff are excluded");
    assertTraitorList([]);
    f.enemy.isTraitor = () => true;
    f.me.isFriendly = (other) => other === f.enemy;
    f.me.team = f.enemy.team = () => "red";
    betray(3);
    interval!();
    assert.equal(alerts().length, 1, "teammates are excluded");
    assertTraitorList([]);
    f.me.isFriendly = () => false;
    f.enemy.team = () => "blue";
    f.setCatchup(true);
    betray(3);
    f.setCatchup(false);
    interval!();
    assert.equal(alerts().length, 1, "catchup events are excluded");
    betray(3);
    enable(false);
    enable(true);
    interval!();
    assert.equal(alerts().length, 1, "disabling clears pending warnings");
    assertTraitorList([]);
    f.owners[1] = 0;
    f.game.update({ updates: {}, changed: [1] });
    interval!();
    betray(3);
    interval!();
    assert.equal(alerts().length, 1, "non-neighbors are excluded");
    assertTraitorList([]);
    f.owners[1] = 2;
    f.game.update({ updates: {}, changed: [1] });
    interval!();
    betray(3);
    interval!();
    assert.equal(alerts().length, 2, "a later betrayal can alert again");
    assertTraitorList([{ id: 2, name: "<b>Player 2</b>" }]);
    f.enemy.displayName = () => "Renamed traitor";
    interval!();
    assertTraitorList([{ id: 2, name: "Renamed traitor" }]);
    f.owners[1] = 0;
    f.game.update({ updates: {}, changed: [1] });
    interval!();
    assertTraitorList([]);
    f.owners[1] = 2;
    f.game.update({ updates: {}, changed: [1] });
    interval!();
    assertTraitorList([{ id: 2, name: "Renamed traitor" }]);
    f.setCatchup(true);
    interval!();
    assertTraitorList(null);
    f.setCatchup(false);
    interval!();
    assertTraitorList([{ id: 2, name: "Renamed traitor" }]);
    f.enemy.isTraitor = () => false;
    interval!();
    assertTraitorList([]);
    f.enemy.isTraitor = () => true;
    interval!();
    assertTraitorList([]);
    betray(3);
    interval!();
    assertTraitorList([{ id: 2, name: "Renamed traitor" }]);
    f.enemy.isAlive = () => false;
    interval!();
    assertTraitorList([]);
    f.enemy.isAlive = () => true;
    f.me.isFriendly = () => true;
    const beforeAlliedAlert = alerts().length;
    betray(3);
    interval!();
    assert.equal(
      alerts().length,
      beforeAlliedAlert + 1,
      "temporary allied neighbor warns",
    );
    assertTraitorList([{ id: 2, name: "Renamed traitor" }]);
    f.enemy.team = () => "red";
    f.enemy.state.isDisconnected = true;
    betray(3);
    interval!();
    assert.equal(
      alerts().length,
      beforeAlliedAlert + 1,
      "disconnected teammate does not warn",
    );
    assertTraitorList([]);
    enable(false);
    assertTraitorList([]);
  } finally {
    stop();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  }
});

void test("disconnected players bordering us raise one inactive neighbor alert", () => {
  const f = fixture();
  let interval: (() => void) | null = null;
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const sent: { type: string; [key: string]: unknown }[] = [];
  const fakeWindow = {
    location: { origin: "https://openfront.io" },
    postMessage: (message: { type: string }) => {
      sent.push(message);
    },
    setInterval: (callback: () => void) => {
      interval = callback;
      return 1;
    },
    clearInterval: () => {
      interval = null;
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    addEventListener: (
      name: string,
      callback: (event: MessageEvent) => void,
    ) => {
      listeners.set(name, callback);
    },
    removeEventListener: (name: string) => {
      listeners.delete(name);
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { classList: { contains: () => true } },
      querySelector: () => ({ game: f.game }),
    },
  });
  const stop = startBridge();
  const TYPE = "OPENFRONT_OVERLAY_INACTIVE_NEIGHBOR";
  const alerts = () => sent.filter((message) => message.type === TYPE);
  try {
    listeners.get("message")!({
      source: fakeWindow,
      origin: "https://openfront.io",
      data: { type: "OPENFRONT_OVERLAY_CONTROL", enabled: false, requestId: 1 },
    } as MessageEvent);
    f.enemy.state.isDisconnected = true;
    interval!();
    assert.equal(alerts().length, 0, "nothing is reported while advice is off");
    listeners.get("message")!({
      source: fakeWindow,
      origin: "https://openfront.io",
      data: { type: "OPENFRONT_OVERLAY_CONTROL", enabled: true, requestId: 2 },
    } as MessageEvent);
    interval!();
    interval!();
    assert.equal(alerts().length, 1, "alerts once");
    assert.deepEqual(alerts()[0].playerNames, ["<b>Player 2</b>"]);

    f.enemy.state.isDisconnected = false;
    interval!();
    f.enemy.state.isDisconnected = true;
    interval!();
    assert.equal(alerts().length, 2, "re-arms after reconnecting");

    f.owners[1] = 0;
    f.game.update({ updates: {}, changed: [1] });
    f.enemy.state.isDisconnected = false;
    interval!();
    f.enemy.state.isDisconnected = true;
    f.ally.state.isDisconnected = true;
    interval!();
    assert.equal(
      alerts().length,
      2,
      "players not on our frontier (or friendly) are ignored",
    );
  } finally {
    stop();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  }
});
