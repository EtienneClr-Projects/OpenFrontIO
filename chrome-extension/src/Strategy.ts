import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { SpatialIndex } from "../../src/client/advisor/SpatialIndex";
import { rawTroops, sameTeam } from "./Observer";
import type { RemoteGame, RemotePlayer, RemoteUnit } from "./Observer";

const economyTypes = [UnitType.City, UnitType.Port, UnitType.Factory];
const buildTypes = [
  ...economyTypes,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
];
const missiles = [
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRVWarhead,
];
const SAMPLE_LIMIT = 48;
const QUERY_TIMEOUT_MS = 3000;

export interface StrategyThreat {
  kind: "attack" | "neighbor" | "capability" | "missile";
  id: number;
  name: string;
  troops: number;
}

export interface BuildPlan {
  type: UnitType;
  reason:
    | "foundation"
    | "capacity"
    | "trade"
    | "production"
    | "frontier"
    | "coverage";
  cost: string;
  shortfall: string;
  affordable: boolean;
  paused: boolean;
  placement: "saving" | "paused" | "checking" | "valid" | "not-found";
  tile: number | null;
  constructionSeconds: number | null;
}

export interface StrategySnapshot {
  status: "checking" | "ready" | "unavailable";
  error: string | null;
  threatError: string | null;
  threats: StrategyThreat[];
  builds: BuildPlan[];
}

export function goldValue(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n && value.toString().length <= 80)
    return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  throw new Error("Missing or invalid exact gold amount.");
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`Missing or invalid ${label}.`);
  return value;
}

function constructing(unit: RemoteUnit): boolean {
  if (typeof unit.isUnderConstruction !== "function")
    throw new Error("Missing unit.isUnderConstruction().");
  const result = unit.isUnderConstruction();
  if (typeof result !== "boolean")
    throw new Error("Invalid construction state.");
  return result;
}

function take<T>(values: Iterable<T>, limit = SAMPLE_LIMIT): T[] {
  const result: T[] = [];
  for (const value of values) {
    result.push(value);
    if (result.length === limit) break;
  }
  return result;
}

export class StrategyAdvisor {
  snapshot: StrategySnapshot = {
    status: "checking",
    error: null,
    threatError: null,
    threats: [],
    builds: [],
  };
  private disposed = false;
  private generation = 0;
  private pending = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private lastScan = -Infinity;
  private lastTick = -1;
  private lastError: string | null = null;
  private revision = "";
  private round = 0;

  constructor(
    private readonly game: RemoteGame,
    private readonly changed: () => void,
  ) {}

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private invalidate(): void {
    this.cancelScan();
    this.lastScan = -Infinity;
    this.snapshot = {
      status: "checking",
      error: null,
      threatError: null,
      threats: [],
      builds: [],
    };
  }

  private cancelScan(): void {
    this.generation++;
    this.pending = false;
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
  }

  poll(spatial: SpatialIndex | null, now = performance.now()): void {
    try {
      this.work(spatial, now);
    } catch (error) {
      this.cancelScan();
      this.fail(error);
      this.snapshot.threatError = this.message(error);
      this.snapshot.threats = [];
    }
  }

  private work(spatial: SpatialIndex | null, now: number): void {
    if (this.disposed) return;
    const me = this.game.myPlayer();
    const tick = this.game.ticks();
    if (
      !spatial ||
      !me ||
      this.game.isCatchingUp() ||
      this.game.inSpawnPhase() ||
      this.game.gameOver() ||
      !me.isAlive()
    ) {
      this.invalidate();
      return;
    }
    if (tick < this.lastTick) this.invalidate();
    this.lastTick = tick;
    const revision = this.structureRevision(me);
    if (revision !== this.revision) {
      this.invalidate();
      this.revision = revision;
    }
    try {
      this.snapshot.threats = this.readThreats(me, spatial);
      this.snapshot.threatError = null;
    } catch (error) {
      this.report(error);
      this.snapshot.threats = [];
      this.snapshot.threatError = this.message(error);
    }
    // Hide stale placements immediately on spend, ownership loss, or new pressure.
    try {
      this.snapshot.builds = this.reconcile(this.snapshot.builds, me);
    } catch (error) {
      this.cancelScan();
      this.fail(error);
      return;
    }
    if (this.pending || now - this.lastScan < 1500) return;
    this.lastScan = now;
    this.pending = true;
    const generation = ++this.generation;
    this.timeout = setTimeout(() => {
      if (generation !== this.generation || this.disposed) return;
      this.generation++;
      this.pending = false;
      this.timeout = null;
      this.fail(new Error("Build query timed out."));
      this.changed();
    }, QUERY_TIMEOUT_MS);
    void this.plan(me, spatial, generation)
      .then((builds) => {
        if (this.disposed || generation !== this.generation) return;
        if (
          this.game.isCatchingUp() ||
          this.game.myPlayer() !== me ||
          this.game.ticks() < tick ||
          this.structureRevision(me) !== revision
        ) {
          this.invalidate();
        } else {
          this.snapshot.threats = this.readThreats(me, spatial);
          this.snapshot.threatError = null;
          this.snapshot.builds = this.reconcile(builds, me);
          this.snapshot.status = "ready";
          this.snapshot.error = null;
          this.lastError = null;
        }
      })
      .catch((error: unknown) => {
        if (!this.disposed && generation === this.generation) this.fail(error);
      })
      .finally(() => {
        if (this.disposed || generation !== this.generation) return;
        if (this.timeout !== null) clearTimeout(this.timeout);
        this.timeout = null;
        this.pending = false;
        this.changed();
      });
  }

  private structureRevision(me: RemotePlayer): string {
    return this.game
      .units()
      .filter(
        (u) =>
          u.isActive() &&
          u.owner().smallID() === me.smallID() &&
          buildTypes.includes(u.type()),
      )
      .map(
        (u) =>
          `${u.id()}:${u.type()}:${u.tile()}:${u.level?.()}:${u.isUnderConstruction?.()}`,
      )
      .join("|");
  }

  private reconcile(builds: BuildPlan[], me: RemotePlayer): BuildPlan[] {
    const gold = goldValue(me.gold?.());
    const paused = this.pressure(me);
    return builds
      .filter((build) =>
        build.type === UnitType.DefensePost
          ? this.snapshot.threats.some(
              (t) => t.kind === "attack" || t.kind === "neighbor",
            )
          : build.type === UnitType.SAMLauncher
            ? this.snapshot.threats.some(
                (t) => t.kind === "capability" || t.kind === "missile",
              )
            : true,
      )
      .map((build) => {
        const cost = BigInt(build.cost);
        const affordable = gold >= cost;
        const hold = economyTypes.includes(build.type) && paused;
        const valid = build.tile !== null && this.owned(build.tile, me);
        return {
          ...build,
          affordable,
          paused: hold,
          shortfall: (cost > gold ? cost - gold : 0n).toString(),
          tile: affordable && !hold && valid ? build.tile : null,
          placement: !affordable
            ? "saving"
            : hold
              ? "paused"
              : valid
                ? build.placement
                : build.placement === "not-found"
                  ? "not-found"
                  : "checking",
        };
      });
  }

  private message(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      240,
    );
  }

  private report(error: unknown): void {
    const message = this.message(error);
    if (message !== this.lastError) {
      console.error("[OpenFront Overlay] Strategy advice unavailable:", error);
      this.lastError = message;
    }
  }

  private fail(error: unknown): void {
    this.report(error);
    this.snapshot.status = "unavailable";
    this.snapshot.error = this.message(error);
    this.snapshot.builds = [];
  }

  private hostile(me: RemotePlayer, player: RemotePlayer): boolean {
    return (
      player.smallID() !== me.smallID() &&
      !sameTeam(me.team(), player.team()) &&
      !me.isFriendly(player)
    );
  }

  private pressure(me: RemotePlayer): boolean {
    return (
      this.snapshot.threatError !== null ||
      me.incomingAttacks().some((a) => !a.retreating && a.troops > 0) ||
      this.snapshot.threats.some(
        (t) => t.kind === "neighbor" || t.kind === "missile",
      )
    );
  }

  private readThreats(
    me: RemotePlayer,
    spatial: SpatialIndex,
  ): StrategyThreat[] {
    const threats: StrategyThreat[] = [];
    const players = new Map(this.game.players().map((p) => [p.smallID(), p]));
    const incoming = new Map<number, number>();
    for (const attack of me.incomingAttacks()) {
      const player = players.get(attack.attackerID);
      if (!player) throw new Error("Unknown incoming attacker.");
      if (
        attack.retreating ||
        !player.isAlive() ||
        player.type() !== PlayerType.Human ||
        !this.hostile(me, player)
      )
        continue;
      const troops = rawTroops(attack.troops);
      if (troops > 0)
        incoming.set(
          player.smallID(),
          (incoming.get(player.smallID()) ?? 0) + troops,
        );
    }
    for (const player of players.values()) {
      if (!player.isAlive() || !this.hostile(me, player)) continue;
      const id = player.smallID();
      const name = player.displayName().slice(0, 200);
      if (incoming.has(id))
        threats.push({
          kind: "attack",
          id,
          name,
          troops: rawTroops(incoming.get(id)),
        });
      else if (
        player.type() === PlayerType.Human &&
        spatial.fronts.has(id) &&
        player.troops() > 0 &&
        player.troops() >= me.troops() * 2
      )
        threats.push({
          kind: "neighbor",
          id,
          name,
          troops: rawTroops(player.troops()),
        });
    }
    const capability = new Set<number>();
    for (const unit of this.game.units()) {
      if (!unit.isActive()) continue;
      const owner = unit.owner();
      if (!this.hostile(me, owner)) continue;
      const type = unit.type();
      const id = owner.smallID();
      const name = owner.displayName().slice(0, 200);
      if (type === UnitType.MissileSilo && owner.isAlive()) capability.add(id);
      const target = unit.targetTile();
      if (!missiles.includes(type) && type !== UnitType.MIRV) continue;
      if (target === undefined || target === null) continue;
      if (
        !Number.isSafeInteger(target) ||
        target < 0 ||
        target >= this.game.width() * this.game.height()
      )
        throw new Error("Invalid missile target.");
      if (type === UnitType.MIRV && this.game.ownerID(target) === me.smallID())
        threats.push({ kind: "missile", id: unit.id(), name, troops: 0 });
      else if (missiles.includes(type)) {
        const radius = positive(
          this.game.config().nukeMagnitudes(type).outer,
          "blast radius",
        );
        if (spatial.blastTouches(target, radius))
          threats.push({ kind: "missile", id: unit.id(), name, troops: 0 });
      }
    }
    for (const id of capability)
      threats.push({
        kind: "capability",
        id,
        name: players.get(id)!.displayName().slice(0, 200),
        troops: 0,
      });
    const priority = { missile: 0, attack: 1, neighbor: 2, capability: 3 };
    return threats
      .sort((a, b) => priority[a.kind] - priority[b.kind] || a.id - b.id)
      .slice(0, 512);
  }

  private neighbors(tile: number): number[] {
    const width = this.game.width();
    const result: number[] = [];
    if (tile >= width) result.push(tile - width);
    if (tile + width < width * this.game.height()) result.push(tile + width);
    if (tile % width > 0) result.push(tile - 1);
    if ((tile % width) + 1 < width) result.push(tile + 1);
    return result;
  }

  private owned(tile: number, me: RemotePlayer): boolean {
    return (
      this.game.ownerID(tile) === me.smallID() &&
      this.game.isLand(tile) &&
      !this.game.isImpassable(tile)
    );
  }

  private distance(a: number, b: number): number {
    return Math.hypot(
      (a % this.game.width()) - (b % this.game.width()),
      Math.floor(a / this.game.width()) - Math.floor(b / this.game.width()),
    );
  }

  private async plan(
    me: RemotePlayer,
    spatial: SpatialIndex,
    generation: number,
  ): Promise<BuildPlan[]> {
    if (!me.buildables) throw new Error("Missing player.buildables().");
    const config = this.game.config();
    if (!config.isUnitDisabled)
      throw new Error("Missing config.isUnitDisabled().");
    const types = buildTypes.filter((type) => !config.isUnitDisabled!(type));
    const prices = await me.buildables(undefined, types);
    if (this.disposed || generation !== this.generation) return [];
    if (!Array.isArray(prices)) throw new Error("Invalid build prices.");
    const costs = new Map(prices.map((p) => [p.type, goldValue(p.cost)]));
    if (types.some((type) => !costs.has(type)))
      throw new Error("Incomplete build prices.");
    const own = this.game
      .units()
      .filter(
        (u) =>
          u.isActive() &&
          u.owner().smallID() === me.smallID() &&
          buildTypes.includes(u.type()),
      );
    const pending = new Set(own.filter(constructing).map((u) => u.type()));
    const count = (type: UnitType) =>
      own.filter((u) => u.type() === type).length;
    const assets = own
      .filter((u) => economyTypes.includes(u.type()) && !constructing(u))
      .slice(0, SAMPLE_LIMIT);
    const sites = new Set(take(spatial.sites));
    for (const asset of assets)
      for (const tile of this.neighbors(asset.tile())) sites.add(tile);
    for (const tile of take(spatial.coast, 8)) sites.add(tile);
    // Tiny territories may not yet contain a sparse indexed site.
    for (const front of take(spatial.fronts.values(), 8))
      for (const tile of take(front, 4))
        for (const n of this.neighbors(tile))
          if (this.owned(n, me)) sites.add(n);
    const candidates = [...sites].filter((tile) => this.owned(tile, me));
    const safeScore = (tile: number) =>
      this.neighbors(tile).filter((n) => this.owned(n, me)).length;
    candidates.sort((a, b) => safeScore(b) - safeScore(a) || a - b);
    const coast = spatial.coastalSites(Math.floor(this.game.ticks() / 15), 8);
    const can = (type: UnitType) => costs.has(type) && !pending.has(type);
    const choices: {
      type: UnitType;
      reason: BuildPlan["reason"];
      tiles: number[];
    }[] = [];
    const city = count(UnitType.City),
      ports = count(UnitType.Port),
      factories = count(UnitType.Factory);
    const reserve = me.troops() / Math.max(1, this.game.config().maxTroops(me));
    const eco =
      city === 0 && can(UnitType.City)
        ? UnitType.City
        : reserve >= 0.8 && can(UnitType.City)
          ? UnitType.City
          : coast.length && ports <= factories && can(UnitType.Port)
            ? UnitType.Port
            : ports > factories && can(UnitType.Factory)
              ? UnitType.Factory
              : can(UnitType.City)
                ? UnitType.City
                : can(UnitType.Factory) && ports > 0
                  ? UnitType.Factory
                  : coast.length && can(UnitType.Port)
                    ? UnitType.Port
                    : null;
    if (eco !== null)
      choices.push({
        type: eco,
        reason:
          eco === UnitType.City
            ? city === 0
              ? "foundation"
              : "capacity"
            : eco === UnitType.Port
              ? "trade"
              : "production",
        tiles: eco === UnitType.Port ? coast : candidates,
      });
    const fronts = this.snapshot.threats
      .filter((t) => t.kind === "attack" || t.kind === "neighbor")
      .sort(
        (a, b) =>
          Number(b.kind === "attack") - Number(a.kind === "attack") ||
          b.troops - a.troops,
      )
      .slice(0, 3);
    if (fronts.length && can(UnitType.DefensePost)) {
      const range = positive(config.defensePostRange?.(), "Defense Post range");
      const frontTiles = fronts.flatMap((t) =>
        take(spatial.fronts.get(t.id) ?? [], 8),
      );
      const queue = frontTiles
        .flatMap((tile) => this.neighbors(tile))
        .filter((tile) => this.owned(tile, me));
      const seen = new Set(queue);
      for (let i = 0; i < queue.length && i < 128; i++) {
        for (const tile of this.neighbors(queue[i])) {
          if (seen.size >= 256 || seen.has(tile) || !this.owned(tile, me))
            continue;
          seen.add(tile);
          queue.push(tile);
        }
      }
      const posts = own.filter((u) => u.type() === UnitType.DefensePost);
      const tiles = [...seen].filter(
        (tile) =>
          frontTiles.some((f) => this.distance(tile, f) <= range) &&
          !posts.some((u) => this.distance(tile, u.tile()) < range / 2),
      );
      const depth = (tile: number) =>
        Math.min(...frontTiles.map((f) => this.distance(tile, f)));
      tiles.sort(
        (a, b) =>
          safeScore(b) - safeScore(a) ||
          Math.abs(depth(a) - 5) - Math.abs(depth(b) - 5) ||
          a - b,
      );
      choices.push({
        type: UnitType.DefensePost,
        reason: "frontier",
        tiles: tiles.filter((tile) => depth(tile) >= 3),
      });
    }
    if (
      this.snapshot.threats.some(
        (t) => t.kind === "capability" || t.kind === "missile",
      ) &&
      can(UnitType.SAMLauncher)
    ) {
      const range = positive(config.samRange?.(1), "SAM range");
      const sams = own.filter(
        (u) => u.type() === UnitType.SAMLauncher && !constructing(u),
      );
      const uncovered = assets.filter(
        (asset) =>
          !sams.some((sam) => {
            const level = positive(sam.level?.(), "SAM level");
            let currentRange = positive(config.samRange?.(level), "SAM range");
            if (
              sam.state.samUpgradeStartTick !== undefined &&
              sam.state.samUpgradeStartTick !== null
            )
              currentRange = Math.min(
                currentRange,
                positive(sam.state.samUpgradeStartRange, "SAM upgrade range"),
              );
            return this.distance(sam.tile(), asset.tile()) <= currentRange;
          }),
      );
      const score = (tile: number) =>
        uncovered.reduce(
          (n, asset) =>
            n + (this.distance(tile, asset.tile()) <= range ? 1 : 0),
          0,
        );
      const tiles = candidates.filter((tile) => score(tile) > 0);
      tiles.sort(
        (a, b) => score(b) - score(a) || safeScore(b) - safeScore(a) || a - b,
      );
      if (uncovered.length)
        choices.push({ type: UnitType.SAMLauncher, reason: "coverage", tiles });
    }
    const result: BuildPlan[] = [];
    const round = this.round++;
    for (const choice of choices) {
      if (this.disposed || generation !== this.generation) return [];
      const cost = costs.get(choice.type)!;
      const gold = goldValue(me.gold?.());
      const affordable = gold >= cost;
      const paused = economyTypes.includes(choice.type) && this.pressure(me);
      const duration = config.unitInfo?.(choice.type).constructionDuration;
      const ms = config.msPerTick?.();
      const constructionSeconds =
        duration !== undefined &&
        Number.isFinite(duration) &&
        duration >= 0 &&
        ms !== undefined
          ? (duration * positive(ms, "tick duration")) / 1000
          : null;
      const plan: BuildPlan = {
        type: choice.type,
        reason: choice.reason,
        cost: cost.toString(),
        shortfall: (cost > gold ? cost - gold : 0n).toString(),
        affordable,
        paused,
        placement: !affordable ? "saving" : paused ? "paused" : "checking",
        tile: null,
        constructionSeconds,
      };
      if (affordable && !paused) {
        plan.placement = "not-found";
        const offset = (round * 3) % Math.max(1, choice.tiles.length);
        const probes = [
          ...choice.tiles.slice(offset),
          ...choice.tiles.slice(0, offset),
        ].slice(0, 3);
        for (const tile of probes) {
          if (this.disposed || generation !== this.generation) return [];
          const checks = await me.buildables(tile, [choice.type]);
          if (this.disposed || generation !== this.generation) return [];
          if (!Array.isArray(checks))
            throw new Error("Invalid placement response.");
          const check = checks.find((p) => p.type === choice.type);
          if (!check) throw new Error("Incomplete placement response.");
          const currentCost = goldValue(check.cost);
          plan.cost = currentCost.toString();
          const currentGold = goldValue(me.gold?.());
          plan.affordable = currentGold >= currentCost;
          plan.shortfall = (
            currentCost > currentGold ? currentCost - currentGold : 0n
          ).toString();
          plan.paused = economyTypes.includes(choice.type) && this.pressure(me);
          if (!plan.affordable || plan.paused) {
            plan.placement = plan.paused ? "paused" : "saving";
            break;
          }
          if (check.canBuild === false) continue;
          const actual = check.canBuild;
          if (
            !Number.isSafeInteger(actual) ||
            actual < 0 ||
            actual >= this.game.width() * this.game.height()
          )
            throw new Error("Invalid build placement.");
          if (!this.owned(actual, me) || this.distance(actual, tile) > 0)
            continue;
          plan.tile = actual;
          plan.placement = "valid";
          break;
        }
      }
      result.push(plan);
    }
    return result;
  }
}
