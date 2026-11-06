import {
  GameMode,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
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
      changed = Array.isArray(args[0]) ? args[0] : [];
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
    }),
  };
  me.incomingAttacks = () =>
    incoming ? [{ troops: incoming, attackerID: enemy.smallID() }] : [];
  me.outgoingAttacks = () => (outgoing ? [{ troops: outgoing }] : []);
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
    state: { retreating: false },
  };
}

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
    snapshot().neighbors[0].friendly,
    true,
    "disconnected teammate remains same-team friendly",
  );
  assert.equal(snapshot().context, "economy");
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
    assert.equal(messages.at(-1)?.advisor.status, "disabled");
    assert.equal(messages.at(-1)?.troops, 100);
    interval!();
    assert.deepEqual(
      messages.filter((message) => message.type === "OPENFRONT_OVERLAY_SILOS"),
      [],
      "silo markers are skipped while minimized",
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
    const next = fixture();
    found = next.game;
    interval!();
    assert.equal(f.game.update, original);
    assert.equal(
      messages.at(-1)?.advisor.status,
      "disabled",
      "client replacement resets opt-in",
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
    assert.equal(messages.at(-1)?.advisor.status, "active");
    assert.notEqual(
      f.game.update,
      original,
      "loading activation starts observation on discovery",
    );
    inGame = false;
    interval!();
    inGame = true;
    interval!();
    assert.equal(messages.at(-1)?.advisor.enabled, false);
    assert.equal(f.game.update, original);
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
