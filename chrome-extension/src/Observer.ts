import {
  GameMode,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { gamePhase } from "../../src/client/advisor/GamePhase";
import { SpatialIndex } from "../../src/client/advisor/SpatialIndex";
import type {
  AdviceContext,
  AdvisorMap,
  AdvisorObservation,
} from "../../src/client/advisor/Types";

export interface AdvisorSnapshot {
  status:
    | "disabled"
    | "waiting"
    | "indexing"
    | "active"
    | "catchup"
    | "finished"
    | "unsupported"
    | "error";
  enabled: boolean;
  cap: number | null;
  reservePercent: number | null;
  incoming: number | null;
  recommendation: "push" | "retain" | null;
  context: AdviceContext | null;
  neighbors: { id: number; name: string; friendly: boolean; troops: number }[];
  error?: string;
}

export interface RemotePlayer {
  smallID(): number;
  displayName(): string;
  type(): PlayerType;
  team(): string | null;
  isAlive(): boolean;
  isFriendly(player: RemotePlayer): boolean;
  numTilesOwned(): number;
  troops(): number;
  incomingAttacks(): { troops: number; attackerID: number }[];
  outgoingAttacks(): { troops: number }[];
  state: { isDisconnected: boolean; inDoomsdayClock: boolean };
}

export interface RemoteUnit {
  id(): number;
  owner(): RemotePlayer;
  type(): UnitType;
  tile(): number;
  targetTile(): number | undefined;
  targetUnitId?(): number | undefined;
  isActive(): boolean;
  state: { retreating: boolean };
}

export interface RemoteConfig {
  maxTroops(player: RemotePlayer): number;
  gameConfig(): { gameMode: GameMode };
  percentageTilesOwnedToWin(seconds: number): number;
  doomsdayClockConfig(): { enabled: boolean };
  nukeMagnitudes(type: UnitType): { outer: number };
}

export interface RemoteGame extends AdvisorMap {
  update(...args: unknown[]): unknown;
  x(tile: number): number;
  y(tile: number): number;
  myPlayer(): RemotePlayer | null;
  players(): RemotePlayer[];
  units(...types: UnitType[]): RemoteUnit[];
  config(): RemoteConfig;
  ticks(): number;
  ticksSinceStart(): number;
  elapsedGameSeconds(): number;
  numLandTiles(): number;
  numTilesWithFallout(): number;
  recentlyUpdatedTiles(): readonly number[];
  gameOver(): boolean;
  inSpawnPhase(): boolean;
  isCatchingUp(): boolean;
}

class UnsupportedClient extends Error {}

function methods(value: unknown, names: string[], label: string): void {
  if (!value || typeof value !== "object")
    throw new UnsupportedClient(`Missing ${label}.`);
  const object = value as Record<string, unknown>;
  for (const name of names) {
    if (typeof object[name] !== "function")
      throw new UnsupportedClient(`Missing ${label}.${name}().`);
  }
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new UnsupportedClient(`Invalid ${label}.`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new UnsupportedClient(`Invalid ${label}.`);
  }
  return value;
}

export function rawTroops(value: unknown): number {
  const raw = Math.floor(finite(value, "troop count"));
  if (!Number.isSafeInteger(raw))
    throw new UnsupportedClient("Invalid troop count.");
  return raw;
}

export function emptyAdvisor(
  status: AdvisorSnapshot["status"] = "disabled",
  enabled = false,
): AdvisorSnapshot {
  return {
    status,
    enabled,
    cap: null,
    reservePercent: null,
    incoming: null,
    recommendation: null,
    context: null,
    neighbors: [],
  };
}

function validateGame(game: RemoteGame): void {
  methods(
    game,
    [
      "update",
      "myPlayer",
      "players",
      "units",
      "config",
      "ticks",
      "ticksSinceStart",
      "elapsedGameSeconds",
      "numLandTiles",
      "numTilesWithFallout",
      "recentlyUpdatedTiles",
      "gameOver",
      "inSpawnPhase",
      "isCatchingUp",
      "width",
      "height",
      "ownerID",
      "isLand",
      "isImpassable",
      "tileState",
    ],
    "GameView",
  );
  const size = game.width() * game.height();
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isSafeInteger(game.width()) ||
    !Number.isSafeInteger(game.height()) ||
    game.width() <= 0 ||
    game.height() <= 0
  ) {
    throw new UnsupportedClient("Invalid map dimensions.");
  }
  methods(
    game.config(),
    [
      "maxTroops",
      "gameConfig",
      "percentageTilesOwnedToWin",
      "doomsdayClockConfig",
      "nukeMagnitudes",
    ],
    "config",
  );
}

export function observe(game: RemoteGame): AdvisorObservation {
  const me = game.myPlayer()!;
  methods(me, ["smallID", "isFriendly"], "myPlayer");
  const config = game.config();
  const remotePlayers = game.players();
  if (!Array.isArray(remotePlayers) || remotePlayers.length > 512) {
    throw new UnsupportedClient("Invalid or unsupported player roster size.");
  }
  const players = remotePlayers.map((p) => {
    methods(
      p,
      [
        "smallID",
        "displayName",
        "type",
        "team",
        "isAlive",
        "numTilesOwned",
        "troops",
        "incomingAttacks",
        "outgoingAttacks",
      ],
      "player",
    );
    const id = finite(p.smallID(), "player ID");
    if (!Number.isSafeInteger(id) || id === 0)
      throw new UnsupportedClient("Invalid player ID.");
    const name = p.displayName();
    const team = p.team();
    const type = p.type();
    if (
      typeof name !== "string" ||
      (team !== null && typeof team !== "string") ||
      !Object.values(PlayerType).includes(type)
    )
      throw new UnsupportedClient("Invalid player identity.");
    const disconnected = bool(p.state?.isDisconnected, "player disconnection");
    const sum = (attacks: { troops: number }[]) => {
      if (!Array.isArray(attacks))
        throw new UnsupportedClient("Invalid attacks.");
      return rawTroops(
        attacks.reduce((n, a) => n + finite(a.troops, "attack troops"), 0),
      );
    };
    return {
      id,
      name,
      team,
      type,
      alive: bool(p.isAlive(), "player alive"),
      disconnected,
      friendly:
        p === me || (!disconnected && bool(me.isFriendly(p), "friendship")),
      tiles: finite(p.numTilesOwned(), "player territory"),
      troops: rawTroops(p.troops()),
      incoming: 0,
      outgoing: sum(p.outgoingAttacks()),
      doomed: bool(p.state?.inDoomsdayClock, "doomsday state"),
      traitor: false,
      alliances: [],
    };
  });
  const playerTypes = new Map(players.map((p) => [p.id, p.type]));
  for (const [index, p] of remotePlayers.entries()) {
    const attacks = p.incomingAttacks();
    if (!Array.isArray(attacks))
      throw new UnsupportedClient("Invalid attacks.");
    players[index].incoming = rawTroops(
      attacks.reduce((total, attack) => {
        const troops = finite(attack.troops, "attack troops");
        if (!Number.isSafeInteger(attack.attackerID) || attack.attackerID <= 0)
          throw new UnsupportedClient("Invalid attack sender.");
        return playerTypes.get(attack.attackerID) === PlayerType.Bot
          ? total
          : total + troops;
      }, 0),
    );
  }
  const myID = me.smallID();
  const own = players.find((p) => p.id === myID);
  if (!own) throw new UnsupportedClient("Local player absent from players().");
  const tile = (value: unknown) => {
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 0 ||
      (value as number) >= game.width() * game.height()
    )
      throw new UnsupportedClient("Invalid unit tile.");
    return value as number;
  };
  const units = game.units().map((u) => {
    methods(
      u,
      ["id", "owner", "type", "tile", "targetTile", "isActive"],
      "unit",
    );
    methods(u.owner(), ["smallID"], "unit owner");
    const type = u.type();
    if (!Object.values(UnitType).includes(type))
      throw new UnsupportedClient("Invalid unit type.");
    const target = u.targetTile();
    const nuclear = [
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRVWarhead,
    ].includes(type);
    return {
      id: finite(u.id(), "unit ID"),
      owner: finite(u.owner().smallID(), "unit owner ID"),
      type,
      tile: tile(u.tile()),
      target: target === null || target === undefined ? null : tile(target),
      active: bool(u.isActive(), "unit active"),
      retreating:
        type === UnitType.TransportShip
          ? bool(u.state?.retreating, "transport retreating")
          : false,
      range: nuclear
        ? finite(config.nukeMagnitudes(type).outer, "blast radius")
        : 0,
      constructing: false,
      level: 0,
      ready: 0,
      troops: 0,
      arrivalTick: null,
    };
  });
  const mode = config.gameConfig()?.gameMode;
  if (!Object.values(GameMode).includes(mode))
    throw new UnsupportedClient("Invalid game mode.");
  const sideTiles = players
    .filter(
      (p) =>
        p.id === myID ||
        (mode !== GameMode.FFA &&
          own.team !== null &&
          p.team === own.team &&
          p.alive),
    )
    .reduce((n, p) => n + p.tiles, 0);
  return {
    tick: finite(game.ticks(), "tick"),
    elapsed: finite(game.ticksSinceStart(), "elapsed ticks"),
    myID,
    players,
    units,
    cap: rawTroops(config.maxTroops(me)),
    landShare:
      sideTiles /
      Math.max(
        1,
        finite(game.numLandTiles(), "land tiles") -
          finite(game.numTilesWithFallout(), "fallout tiles"),
      ),
    winShare:
      finite(
        config.percentageTilesOwnedToWin(
          finite(game.elapsedGameSeconds(), "elapsed seconds"),
        ),
        "win percentage",
      ) / 100,
    clockEnabled: bool(
      config.doomsdayClockConfig()?.enabled,
      "doomsday enabled",
    ),
    growth: 0,
    gold: 0n,
    builds: [],
    queryState: "checking",
    attackable: new Set(),
  };
}

export function analyze(
  o: AdvisorObservation,
  map: AdvisorMap,
  spatial: SpatialIndex,
): AdvisorSnapshot {
  const me = o.players.find((p) => p.id === o.myID)!;
  const context = gamePhase(o, map, spatial);
  const reserveThreshold = context === "opening" ? 0.33 : 0.42;
  const strongerNeighbors = o.players.filter(
    (p) =>
      p.id !== me.id &&
      p.alive &&
      spatial.fronts.has(p.id) &&
      p.troops > me.troops,
  );
  return {
    status: "active",
    enabled: true,
    cap: rawTroops(o.cap),
    reservePercent: Math.round((me.troops / Math.max(1, o.cap)) * 100),
    incoming: rawTroops(me.incoming),
    recommendation:
      me.incoming === 0 &&
      strongerNeighbors.length === 0 &&
      me.troops > o.cap * reserveThreshold
        ? "push"
        : "retain",
    context,
    neighbors: strongerNeighbors
      .map((p) => ({
        id: p.id,
        name: p.name.slice(0, 200),
        troops: rawTroops(p.troops),
        friendly: p.friendly || (me.team !== null && p.team === me.team),
      }))
      .sort((a, b) => a.id - b.id),
  };
}

export interface ObserverScheduler {
  now(): number;
  schedule(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

const scheduler: ObserverScheduler = {
  now: () => performance.now(),
  schedule: (callback) => setTimeout(callback, 0),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const observers = new WeakMap<RemoteGame, GameObserver>();

/** Instance-local, read-only observer. Only the display snapshot escapes it. */
export class GameObserver {
  snapshot = emptyAdvisor();
  private spatial: SpatialIndex | null = null;
  private readonly pending = new Set<number>();
  private original: RemoteGame["update"] | null = null;
  private wrapper: RemoteGame["update"] | null = null;
  private ownUpdate = false;
  private handle: unknown = null;
  private lastTick = -1;
  private lastSeenTick = -1;
  private myID: number | null = null;
  private active = false;
  private rebuilding = false;

  constructor(
    readonly game: RemoteGame,
    private readonly onSnapshot: (
      snapshot: AdvisorSnapshot,
      urgent: boolean,
    ) => void,
    private readonly clock: ObserverScheduler = scheduler,
    private readonly maxPending = 32768,
  ) {}

  setEnabled(enabled: boolean): void {
    this.stop();
    this.snapshot = emptyAdvisor(enabled ? "waiting" : "disabled", enabled);
    if (!enabled) {
      this.emit();
      return;
    }
    observers.get(this.game)?.dispose();
    observers.set(this.game, this);
    this.active = true;
    this.guard(() => {
      validateGame(this.game);
      this.original = this.game.update;
      this.ownUpdate = Object.hasOwn(this.game, "update");
      const original = this.original;
      const completed = (receiver: RemoteGame) => {
        if (receiver === this.game && this.active)
          this.guard(() => this.updated());
      };
      this.wrapper = function (this: RemoteGame, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args);
        // Do not catch, transform or retry the original update's exceptions.
        completed(this);
        return result;
      };
      this.game.update = this.wrapper;
      this.work();
    });
    this.emit();
  }

  dispose(): void {
    this.stop();
    this.snapshot = emptyAdvisor();
  }

  /** Discovery-loop health check also handles paused games and replaced hooks. */
  poll(): void {
    if (!this.active) return;
    this.guard(() => {
      if (this.game.update !== this.wrapper)
        throw new UnsupportedClient("GameView.update observer was replaced.");
      this.work();
    });
  }

  private clearIndex(): void {
    this.spatial = null;
    this.pending.clear();
    this.lastTick = -1;
    if (this.handle !== null) this.clock.cancel(this.handle);
    this.handle = null;
  }

  private stop(): void {
    this.active = false;
    if (observers.get(this.game) === this) observers.delete(this.game);
    this.clearIndex();
    if (this.wrapper && this.game.update === this.wrapper && this.original) {
      if (this.ownUpdate) this.game.update = this.original;
      else delete (this.game as Partial<RemoteGame>).update;
    }
    this.wrapper = this.original = null;
    this.lastSeenTick = -1;
    this.myID = null;
    this.rebuilding = false;
  }

  private emit(urgent = false): void {
    try {
      this.onSnapshot(this.snapshot, urgent);
    } catch {
      /* Host callbacks cannot affect the game. */
    }
  }

  private guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.stop();
      this.snapshot = {
        ...emptyAdvisor(
          error instanceof UnsupportedClient ? "unsupported" : "error",
        ),
        error:
          error instanceof Error
            ? error.message.slice(0, 240)
            : "Advisor observation failed.",
      };
      this.emit(true);
    }
  }

  private updated(): void {
    const tick = this.game.ticks();
    if (tick < this.lastSeenTick) {
      this.clearIndex();
      this.rebuilding = true;
    }
    this.lastSeenTick = tick;
    if (this.spatial) {
      const tiles = this.game.recentlyUpdatedTiles();
      if (!Array.isArray(tiles))
        throw new UnsupportedClient("Invalid recentlyUpdatedTiles().");
      if (tiles.length > this.maxPending) {
        this.clearIndex();
        this.rebuilding = true;
      } else
        for (const ref of tiles) {
          if (
            !Number.isSafeInteger(ref) ||
            ref < 0 ||
            ref >= this.game.width() * this.game.height()
          ) {
            throw new UnsupportedClient("Invalid changed tile.");
          }
          this.pending.add(ref);
          if (this.pending.size > this.maxPending) {
            this.clearIndex();
            this.rebuilding = true;
            break;
          }
        }
    }
    this.work();
  }

  /** Once guidance is shown, transient catch-up/indexing keeps it instead of flickering. */
  private pause(status: "indexing" | "catchup"): void {
    if (this.snapshot.status === "active") return;
    this.snapshot = emptyAdvisor(status, true);
    this.emit();
  }

  private work(): void {
    if (!this.active) return;
    const me = this.game.myPlayer();
    if (me) methods(me, ["isAlive", "smallID"], "myPlayer");
    if (bool(this.game.inSpawnPhase(), "spawn phase")) {
      this.clearIndex();
      this.snapshot = emptyAdvisor("waiting", true);
      this.emit();
      return;
    }
    if (
      bool(this.game.gameOver(), "gameOver") ||
      (me && !bool(me.isAlive(), "player alive"))
    ) {
      this.stop();
      this.snapshot = emptyAdvisor("finished");
      this.emit(true);
      return;
    }
    if (!me) {
      this.clearIndex();
      this.snapshot = emptyAdvisor("waiting", true);
      this.emit();
      return;
    }
    if (bool(this.game.isCatchingUp(), "catchup")) {
      this.pause("catchup");
      return;
    }
    if (me.smallID() !== this.myID) {
      this.clearIndex();
      this.myID = me.smallID();
    }
    this.spatial ??= new SpatialIndex(this.game, this.myID!);
    const deadline = this.clock.now() + 2;
    // Small chunks bound overshoot, including while the baseline is incomplete.
    do {
      const batch: number[] = [];
      for (const ref of this.pending) {
        batch.push(ref);
        this.pending.delete(ref);
        if (batch.length === 128) break;
      }
      if (batch.length) this.spatial.ingest(batch);
      else if (!this.spatial.ready) this.spatial.initialize(128);
      else break;
    } while (this.clock.now() < deadline);
    if (!this.spatial.ready || this.pending.size) {
      this.pause(this.rebuilding ? "catchup" : "indexing");
      if (this.handle === null) {
        this.handle = this.clock.schedule(() => {
          this.handle = null;
          this.guard(() => this.work());
        });
      }
      return;
    }
    this.rebuilding = false;
    const tick = this.game.ticks();
    if (tick === this.lastTick) return;
    const previousIncoming = this.snapshot.incoming;
    this.snapshot = analyze(observe(this.game), this.game, this.spatial);
    this.lastTick = tick;
    this.emit(
      this.snapshot.incoming !== previousIncoming &&
        this.snapshot.incoming! > 0,
    );
  }
}
