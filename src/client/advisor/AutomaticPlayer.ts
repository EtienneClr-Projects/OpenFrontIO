import {
  PlayerType,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import type {
  PlayerActions,
  PlayerBuildableUnitType,
} from "@openfront/engine-api/game/GameTypes";
import type { GameEvent } from "@openfront/shared/EventBus";
import {
  BuildUnitIntentEvent,
  counterAttackTroops,
  MoveWarshipIntentEvent,
  SendAllianceExtensionIntentEvent,
  SendAllianceRequestIntentEvent,
  SendAttackIntentEvent,
  SendBoatAttackIntentEvent,
  SendUpgradeStructureIntentEvent,
} from "../Transport";
import type { GameView } from "../view";
import { buildingSites } from "./BuildingSites";
import { gamePhase } from "./GamePhase";
import { NuclearBudget } from "./NuclearBudget";
import { SpatialIndex } from "./SpatialIndex";
import type { AdvisorObservation } from "./Types";

interface Proposal {
  key: string;
  kind: "attack" | "build" | "boat" | "move" | "diplomacy";
  tile: number;
  owner?: number;
  type?: PlayerBuildableUnitType;
  ship?: number;
  fraction?: number;
  opening?: boolean;
  emergency?: boolean;
  newOnly?: boolean;
  railway?: boolean;
  waterTarget?: number;
  purpose?: "capacity" | "economy" | "naval";
}

export function isAdvisorHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}

/** Opt-in policy. Async checks never send: dispatch waits for a new tick. */
export class AutomaticPlayer {
  private enabled = false;
  private generation = 0;
  private pending = false;
  private checked: {
    proposal: Proposal;
    result: PlayerActions;
    tick: number;
  } | null = null;
  private lastTick = -1;
  private lastAction = -Infinity;
  private actionDelay = 30;
  private lastCheck = -Infinity;
  private lastEconomicTurn: number | null = null;
  private nuclearBudget = new NuclearBudget();
  private cooldown = new Map<string, number>();
  private readonly friendlyLandCells = new Map<number, number[]>();

  constructor(
    private readonly game: GameView,
    private readonly emit: (event: GameEvent) => void,
    private readonly report: (enabled: boolean, state: string) => void,
  ) {}

  setEnabled(enabled: boolean): void {
    this.generation++;
    this.enabled =
      enabled &&
      isAdvisorHost(location.hostname) &&
      !this.game.config().isReplay();
    this.pending = false;
    this.checked = null;
    this.lastTick = -1;
    this.lastAction = -Infinity;
    this.actionDelay = 30;
    this.lastCheck = -Infinity;
    this.lastEconomicTurn = null;
    this.nuclearBudget = new NuclearBudget();
    this.cooldown.clear();
    this.friendlyLandCells.clear();
    this.report(
      this.enabled,
      this.enabled ? "waiting" : enabled ? "unavailable" : "off",
    );
  }

  private safe(): boolean {
    const me = this.game.myPlayer();
    return (
      this.enabled &&
      isAdvisorHost(location.hostname) &&
      !this.game.config().isReplay() &&
      !this.game.gameOver() &&
      !this.game.inSpawnPhase() &&
      !this.game.isCatchingUp() &&
      !!me?.isAlive()
    );
  }

  tick(o: AdvisorObservation, spatial: SpatialIndex): void {
    if (!this.safe() || o.tick === this.lastTick) return;
    this.lastTick = o.tick;
    const player = this.game.myPlayer()!;
    this.nuclearBudget.observe(
      o.tick,
      this.game.config().goldAdditionRate(player),
      BigInt(player.tradeGold()) + BigInt(player.trainGold()),
    );
    this.lastEconomicTurn ??= o.tick;
    if (o.tick - this.lastAction < this.actionDelay) return;
    if (!this.checked && (this.pending || o.tick - this.lastCheck < 10)) return;
    const proposals = this.proposals(o, spatial).filter(
      (p) => (this.cooldown.get(p.key) ?? 0) <= o.tick,
    );
    const checked = this.checked;
    this.checked = null;
    if (checked && o.tick - checked.tick <= 10) {
      const current =
        proposals[0]?.key === checked.proposal.key &&
        (proposals[0].tile === checked.proposal.tile ||
          proposals[0].kind === "move")
          ? proposals[0]
          : undefined;
      if (current && this.dispatch(current, checked.result, o)) {
        if (current.purpose === "economy" || current.purpose === "capacity")
          this.lastEconomicTurn = o.tick;
        this.lastAction = o.tick;
        this.actionDelay = current.emergency ? 10 : current.opening ? 15 : 30;
        this.cooldown.set(
          current.key,
          o.tick +
            (current.kind === "diplomacy"
              ? 600
              : current.kind === "move"
                ? 10
                : current.opening
                  ? 30
                  : 100),
        );
        this.report(true, current.purpose ?? current.kind);
        return;
      }
      this.cooldown.set(checked.proposal.key, o.tick + 100);
      if (
        checked.proposal.purpose === "economy" ||
        checked.proposal.purpose === "capacity"
      ) {
        this.lastEconomicTurn = o.tick;
        return;
      }
    }
    if (this.pending || o.tick - this.lastCheck < 10) return;
    const proposal = proposals.find(
      (p) => (this.cooldown.get(p.key) ?? 0) <= o.tick,
    );
    if (!proposal) {
      this.lastCheck = o.tick;
      this.report(true, "waiting");
      return;
    }
    const generation = this.generation;
    this.pending = true;
    this.lastCheck = o.tick;
    this.report(true, "checking");
    void this.game.worker
      .playerInteraction(
        this.game.myPlayer()!.id(),
        this.game.x(proposal.tile),
        this.game.y(proposal.tile),
        proposal.type ? [proposal.type] : null,
      )
      .then((result) => {
        if (generation === this.generation && this.safe()) {
          this.checked = { proposal, result, tick: o.tick };
        }
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        console.error(
          "Automatic play stopped: eligibility check failed",
          error,
        );
        this.setEnabled(false);
        this.report(false, "error");
      })
      .finally(() => {
        if (generation === this.generation) this.pending = false;
      });
  }

  private proposals(o: AdvisorObservation, spatial: SpatialIndex): Proposal[] {
    // Share overlapping blast scans only within this live-state evaluation.
    this.friendlyLandCells.clear();
    const me = o.players.find((p) => p.id === o.myID)!;
    const own = o.units.filter((u) => u.active && u.owner === me.id);
    const friendlyOwners = new Set(
      o.players
        .filter((p) => p.friendly || (me.team !== null && p.team === me.team))
        .map((p) => p.id),
    );
    friendlyOwners.add(me.id);
    const friendly = (id: number) => friendlyOwners.has(id);
    const distance = (a: number, b: number) =>
      Math.hypot(
        this.game.x(a) - this.game.x(b),
        this.game.y(a) - this.game.y(b),
      );
    const hostile = o.units.filter((u) => u.active && !friendly(u.owner));
    const launchSites = own.filter(
      (u) => u.type === UnitType.MissileSilo && !u.constructing && u.ready > 0,
    );
    const nuclearDistance = (tile: number) => {
      let nearest = Infinity;
      for (const source of launchSites.length > 0 ? launchSites : own)
        nearest = Math.min(nearest, distance(source.tile, tile));
      const spawn = this.game.myPlayer()!.state.spawnTile;
      return nearest === Infinity && spawn !== undefined
        ? distance(spawn, tile)
        : nearest;
    };
    const nuclearTargets = hostile
      .filter((u) => Structures.has(u.type))
      .map((u) => {
        const protectedBySAM = hostile.some(
          (sam) =>
            sam.type === UnitType.SAMLauncher &&
            !sam.constructing &&
            distance(sam.tile, u.tile) <= sam.range,
        );
        const priority =
          u.type === UnitType.MissileSilo
            ? 0
            : u.type === UnitType.SAMLauncher
              ? 1
              : u.level > 1
                ? 2
                : 3;
        return {
          u,
          priority,
          distance: nuclearDistance(u.tile),
          protectedBySAM,
        };
      })
      .filter(
        ({ u, protectedBySAM }) =>
          u.type === UnitType.MissileSilo ||
          u.type === UnitType.SAMLauncher ||
          !protectedBySAM,
      )
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.distance - b.distance ||
          b.u.level - a.u.level ||
          a.u.id - b.u.id,
      )
      .map(({ u }) => u);
    const proposals: Proposal[] = [];
    const build = (
      type: PlayerBuildableUnitType,
      tile: number,
      options: Partial<Proposal> = {},
    ) => {
      if (this.game.ownerID(tile) === me.id)
        proposals.push({
          key: `build:${type}:${tile}`,
          kind: "build",
          type,
          tile,
          ...options,
        });
    };
    const incomingAttacks = this.game
      .myPlayer()!
      .incomingAttacks()
      .filter((attack) => {
        const attacker = o.players.find((p) => p.id === attack.attackerID);
        return (
          !attack.retreating &&
          attacker?.alive &&
          !friendly(attacker.id) &&
          attack.troops > 0
        );
      });
    const incomingAttack = incomingAttacks[incomingAttacks.length - 1];
    if (incomingAttack) {
      const tile = spatial.sample(incomingAttack.attackerID);
      const available = Math.max(
        0,
        Math.min(me.troops * 0.4, me.troops - o.cap * 0.35),
      );
      const troops = counterAttackTroops(incomingAttack.troops, available);
      if (tile !== undefined && troops > 0)
        proposals.push({
          key: `counter:${incomingAttack.attackerID}`,
          kind: "attack",
          owner: incomingAttack.attackerID,
          tile,
          fraction: troops / Math.max(1, me.troops),
          emergency: true,
        });
    }
    const landings = hostile.filter(
      (u) =>
        u.type === UnitType.TransportShip &&
        !u.retreating &&
        u.target !== null &&
        this.game.ownerID(u.target) === me.id,
    );
    landings.sort(
      (a, b) =>
        (a.arrivalTick ?? Infinity) - (b.arrivalTick ?? Infinity) ||
        distance(a.tile, a.target!) - distance(b.tile, b.target!) ||
        a.id - b.id,
    );
    const landing = landings.length > 0 ? landings[0] : undefined;
    const missiles = o.units.filter(
      (u) =>
        u.active &&
        u.range > 0 &&
        u.target !== null &&
        [
          UnitType.AtomBomb,
          UnitType.HydrogenBomb,
          UnitType.MIRVWarhead,
        ].includes(u.type) &&
        spatial.blastTouches(u.target!, u.range),
    );
    const defensiveMissiles = missiles.filter((u) => !friendly(u.owner));
    const silo = hostile.find((u) => u.type === UnitType.MissileSilo);
    const asset =
      own.find((u) => Structures.has(u.type))?.tile ??
      this.game.myPlayer()!.state.spawnTile;
    // A confirmed landing gets a complete move -> warship -> port response.
    const assignedShips = new Set<number>();
    for (const landing of landings) {
      if (this.game.isLand(landing.tile)) continue;
      const ships = own
        .filter((u) => u.type === UnitType.Warship && !u.constructing)
        .sort(
          (a, b) =>
            distance(a.tile, landing.tile) - distance(b.tile, landing.tile),
        );
      const guarding = ships.find((u) => {
        const patrol = this.game.unit(u.id)?.warshipState().patrolTile;
        return (
          patrol !== undefined &&
          patrol === landing.tile &&
          this.waterConnected(u.tile, landing.tile)
        );
      });
      if (guarding) assignedShips.add(guarding.id);
      const availableShips = guarding
        ? []
        : ships.filter(
            (u) =>
              !assignedShips.has(u.id) &&
              !landings.some(
                (other) =>
                  other.id !== landing.id &&
                  this.game.unit(u.id)?.warshipState().patrolTile ===
                    other.tile,
              ) &&
              this.waterConnected(u.tile, landing.tile),
          );
      const ship = availableShips[0];
      const nearbyShip = availableShips.find((u) => {
        const patrol =
          this.game.unit(u.id)?.warshipState().patrolTile ?? u.tile;
        return distance(patrol, landing.tile) <= 80;
      });
      if (nearbyShip) assignedShips.add(nearbyShip.id);
      else if (ship) assignedShips.add(ship.id);
      if (nearbyShip)
        proposals.push({
          key: `move:${nearbyShip.id}:${landing.id}`,
          kind: "move",
          ship: nearbyShip.id,
          tile: landing.tile,
          emergency: true,
        });
      else if (!guarding) {
        const shore = this.connectedShore(landing.tile, me.id);
        const ports = own
          .filter((u) => u.type === UnitType.Port && shore.has(u.tile))
          .sort(
            (a, b) =>
              distance(a.tile, landing.tile) - distance(b.tile, landing.tile),
          );
        const port = ports.find((u) => !u.constructing);
        const water =
          port &&
          this.game
            .neighbors(port.tile)
            .find(
              (tile) =>
                !this.game.isLand(tile) &&
                this.waterConnected(tile, landing.tile),
            );
        if (water !== undefined)
          proposals.push({
            key: `build:warship:${port!.id}`,
            kind: "build",
            type: UnitType.Warship,
            tile: water,
            emergency: true,
            purpose: "naval",
          });
        else if (ports.length === 0) {
          const portSite = [...shore]
            .sort(
              (a, b) =>
                distance(a, landing.target!) - distance(b, landing.target!),
            )
            .find(
              (tile) =>
                !own.some(
                  (u) =>
                    Structures.has(u.type) &&
                    distance(u.tile, tile) <
                      this.game.config().structureMinDist(),
                ),
            );
          if (portSite !== undefined)
            build(UnitType.Port, portSite, {
              emergency: true,
              newOnly: true,
              waterTarget: landing.tile,
              purpose: "naval",
            });
          else if (ship)
            proposals.push({
              key: `move:${ship.id}:${landing.id}`,
              kind: "move",
              ship: ship.id,
              tile: landing.tile,
              emergency: true,
            });
        } else if (ship)
          proposals.push({
            key: `move:${ship.id}:${landing.id}`,
            kind: "move",
            ship: ship.id,
            tile: landing.tile,
            emergency: true,
          });
      }
    }
    if (asset !== undefined && (silo || defensiveMissiles.length > 0)) {
      const target = defensiveMissiles[0]?.target ?? asset;
      const position = this.game.ownerID(target) === me.id ? target : asset;
      if (
        !own.some(
          (u) =>
            u.type === UnitType.SAMLauncher &&
            distance(u.tile, position) <= u.range,
        )
      ) {
        build(UnitType.SAMLauncher, position, {
          emergency: defensiveMissiles.length > 0,
        });
      }
    }
    const diplomacy: Proposal[] = [];
    for (const p of o.players) {
      const tile = spatial.sample(p.id);
      if (p.id === me.id || !p.alive || tile === undefined) continue;
      if (
        !p.disconnected &&
        p.type !== PlayerType.Bot &&
        !(me.team !== null && p.team === me.team) &&
        (friendly(p.id) || p.troops > me.troops)
      ) {
        diplomacy.push({
          key: `diplomacy:${p.id}`,
          kind: "diplomacy",
          owner: p.id,
          tile,
        });
      }
    }
    const reserve = me.troops / Math.max(1, o.cap);
    const phase = gamePhase(o, this.game, spatial);
    const fundedOpening =
      phase === "opening" &&
      this.lastAction === -Infinity &&
      o.builds.some(
        (b) =>
          b.affordable &&
          b.connected &&
          [UnitType.City, UnitType.Port, UnitType.Factory].includes(b.type) &&
          b.cost * 5n <= this.game.myPlayer()!.gold() * 4n,
      );
    const danger = me.incoming > 0 || !!landing || missiles.length > 0;
    const nuclearBackground =
      phase === "nuclear" && me.incoming < me.troops * 0.2 && !landing;
    const economicSafe =
      me.incoming < me.troops * 0.2 && !landing && missiles.length === 0;
    if (danger && !economicSafe && !nuclearBackground)
      return [...proposals, ...diplomacy];
    const expansionSafe = !danger || nuclearBackground;
    const sites = buildingSites(this.game, spatial, Math.floor(o.tick / 20));
    const eligibleTarget = (id: number) =>
      !this.game
        .myPlayer()!
        .outgoingAttacks()
        .some((a) => a.targetID === id && !a.retreating);
    const strength = (p: AdvisorObservation["players"][number]) =>
      p.troops + p.outgoing;
    if (
      phase !== "opening" &&
      o.players.some((p) => p.id !== me.id && p.alive && !friendly(p.id))
    ) {
      const ports = own.filter(
        (u) => u.type === UnitType.Port && !u.constructing,
      );
      const warshipLimit = Math.ceil(ports.length / 3);
      const warshipCount = own.filter(
        (u) => u.type === UnitType.Warship,
      ).length;
      if (warshipCount < warshipLimit) {
        for (const port of ports) {
          const water = this.game
            .neighbors(port.tile)
            .find((tile) => !this.game.isLand(tile));
          if (water === undefined) continue;
          const covered = own.some((u) => {
            if (u.type !== UnitType.Warship) return false;
            const patrol =
              this.game.unit(u.id)?.warshipState().patrolTile ?? u.tile;
            return (
              distance(patrol, water) <= 80 &&
              this.waterConnected(u.tile, water)
            );
          });
          if (!covered)
            proposals.push({
              key: `build:patrol:${port.id}`,
              kind: "build",
              type: UnitType.Warship,
              tile: water,
              purpose: "naval",
            });
        }
      }
    }
    // Break troop stalemates before spending the treasury on more economy.
    if (!danger && phase !== "opening" && reserve >= 0.5) {
      const strikeStart = proposals.length;
      const rivals = o.players
        .filter(
          (p) =>
            p.id !== me.id &&
            p.alive &&
            !friendly(p.id) &&
            !p.disconnected &&
            p.type !== PlayerType.Bot &&
            strength(p) >= me.troops * 0.5,
        )
        .sort((a, b) => strength(b) - strength(a) || a.id - b.id);
      const ready = own.some(
        (u) =>
          u.type === UnitType.MissileSilo && !u.constructing && u.ready > 0,
      );
      const strikeRivals = rivals.filter(
        (rival) =>
          !own.some(
            (u) =>
              [
                UnitType.AtomBomb,
                UnitType.HydrogenBomb,
                UnitType.MIRV,
                UnitType.MIRVWarhead,
              ].includes(u.type) &&
              u.target !== null &&
              this.game.ownerID(u.target) === rival.id,
          ),
      );
      const mirvRival = strikeRivals[0];
      for (const rival of rivals) {
        if (
          own.some(
            (u) =>
              [
                UnitType.AtomBomb,
                UnitType.HydrogenBomb,
                UnitType.MIRV,
                UnitType.MIRVWarhead,
              ].includes(u.type) &&
              u.target !== null &&
              this.game.ownerID(u.target) === rival.id,
          )
        )
          continue;
        const targets = nuclearTargets
          .filter((u) => u.owner === rival.id)
          .map((u) => u.tile);
        // MIRVs and troop attrition remain useful against rivals without structures.
        const territory = this.game.playerBySmallID(rival.id);
        if (territory.isPlayer()) {
          const center = territory.nameLocation();
          if (center) {
            const x = Math.round(center.x);
            const y = Math.round(center.y);
            if (
              x >= 0 &&
              y >= 0 &&
              x < this.game.width() &&
              y < this.game.height()
            )
              targets.push(y * this.game.width() + x);
          }
          if (territory.state.spawnTile !== undefined)
            targets.push(territory.state.spawnTile);
        }
        const front = spatial.sample(rival.id);
        if (front !== undefined) targets.push(front);
        if (ready) {
          for (const type of [
            UnitType.MIRV,
            UnitType.HydrogenBomb,
            UnitType.AtomBomb,
          ] as const) {
            if (type === UnitType.MIRV && rival.id !== mirvRival?.id) continue;
            const target = targets.find(
              (tile) =>
                (type === UnitType.MIRV ||
                  nuclearTargets.some((u) => u.tile === tile)) &&
                this.game.ownerID(tile) === rival.id &&
                this.game.isLand(tile) &&
                !this.game.isImpassable(tile) &&
                (type === UnitType.MIRV
                  ? !this.mirvFriendlyBlast(tile, rival.id, friendly)
                  : !this.friendlyBlast(
                      tile,
                      this.game.config().nukeMagnitudes(type).outer,
                      friendly,
                    )),
            );
            if (target !== undefined)
              proposals.push({
                key: `build:strike:${type}:${rival.id}`,
                kind: "build",
                type,
                owner: rival.id,
                tile: target,
              });
          }
        }
        const targetRank = (tile: number) => {
          const index = nuclearTargets.findIndex((u) => u.tile === tile);
          return index < 0 ? Infinity : index;
        };
        proposals.push(
          ...proposals
            .splice(strikeStart)
            .sort(
              (a, b) =>
                Number(b.type === UnitType.MIRV) -
                  Number(a.type === UnitType.MIRV) ||
                targetRank(a.tile) - targetRank(b.tile),
            ),
        );
      }
      if (
        rivals.length > 0 &&
        !own.some((u) => u.type === UnitType.MissileSilo) &&
        own.filter((u) => u.type === UnitType.City && !u.constructing).length >=
          2
      ) {
        for (const tile of sites.inland.slice(0, 3))
          build(UnitType.MissileSilo, tile, { newOnly: true });
      }
    }
    const opening =
      phase === "opening" &&
      !o.players.some(
        (p) =>
          p.alive &&
          !friendly(p.id) &&
          spatial.fronts.has(p.id) &&
          p.troops > me.troops * (p.type === PlayerType.Bot ? 0.5 : 0.75),
      );
    // Until we touch water we cannot build ports, so landlocked openings push harder.
    const landlocked = spatial.coast.size === 0;
    const neutralFront = spatial.fronts.has(0);
    if (
      !danger &&
      opening &&
      reserve >= (landlocked ? 0.4 : 0.45) &&
      me.outgoing < me.troops * 0.5
    ) {
      const fraction = (desired: number) =>
        Math.max(
          0,
          Math.min(
            desired,
            (me.troops - o.cap * (landlocked ? 0.3 : 0.35)) /
              Math.max(1, me.troops),
          ),
        );
      const neutral = spatial.sample(0);
      if (
        neutral !== undefined &&
        eligibleTarget(0) &&
        (this.game.tileState(neutral) & (1 << 13)) === 0
      ) {
        proposals.push({
          key: "attack:0",
          kind: "attack",
          owner: 0,
          tile: neutral,
          fraction: fraction(landlocked ? 0.35 : 0.25),
          opening: true,
        });
      }
      // Owned land costs troops; tribes are only taken once free land is gone.
      const tribes = (neutralFront ? [] : o.players)
        .filter(
          (p) =>
            p.alive &&
            !friendly(p.id) &&
            !p.disconnected &&
            p.type === PlayerType.Bot &&
            spatial.fronts.has(p.id),
        )
        .sort((a, b) => strength(a) - strength(b) || a.id - b.id);
      for (const p of tribes) {
        const tile = spatial.sample(p.id);
        const sendFraction = fraction(0.3);
        if (
          tile === undefined ||
          !eligibleTarget(p.id) ||
          strength(p) >= me.troops * 0.15 ||
          Math.floor(me.troops * sendFraction) <= strength(p) * 1.5 ||
          (this.game.tileState(tile) & ((1 << 13) | (1 << 14))) !== 0 ||
          o.units.some(
            (u) =>
              u.active &&
              u.owner === p.id &&
              u.type === UnitType.DefensePost &&
              distance(u.tile, tile) <= u.range,
          )
        )
          continue;
        proposals.push({
          key: `attack:${p.id}`,
          kind: "attack",
          owner: p.id,
          tile,
          fraction: sendFraction,
          opening: true,
        });
      }
    }
    if (expansionSafe && reserve >= 0.5 && me.outgoing < me.troops * 0.35) {
      const neutral = spatial.sample(0);
      if (
        neutral !== undefined &&
        eligibleTarget(0) &&
        (this.game.tileState(neutral) & (1 << 13)) === 0
      )
        proposals.push({
          key: "attack:0",
          kind: "attack",
          owner: 0,
          tile: neutral,
          fraction: 0.15,
        });
      const floor = o.cap * 0.35;
      const traitorDebuff = this.game.config().traitorDefenseDebuff();
      const naval: Proposal[] = [];
      const landingSites = (owner: number) => {
        const alreadyLanding = own.some(
          (u) =>
            u.type === UnitType.TransportShip &&
            !u.retreating &&
            u.target !== null &&
            this.game.ownerID(u.target) === owner,
        );
        return spatial.coast.size > 0 && !alreadyLanding
          ? spatial.landingSites(owner, 0, 3)
          : [];
      };
      const targets = o.players
        .filter((p) => p.id !== me.id && p.alive && eligibleTarget(p.id))
        .flatMap((p) => {
          const tile = spatial.sample(p.id);
          const candidates: { tile: number; kind: "attack" | "boat" }[] = [
            ...(tile === undefined ? [] : [{ tile, kind: "attack" as const }]),
            ...landingSites(p.id)
              .map((tile) => ({
                tile,
                kind: "boat" as const,
              }))
              .filter(({ tile }) => !spatial.fronts.get(p.id)?.has(tile)),
          ];
          return candidates.map(({ tile, kind }) => {
            const defended = o.units.some(
              (u) =>
                u.active &&
                u.owner === p.id &&
                u.type === UnitType.DefensePost &&
                distance(u.tile, tile) <= u.range,
            );
            // Both land and naval invasions use the same defensive cost.
            const effective =
              strength(p) *
              (p.traitor ? traitorDebuff : 1) *
              (defended ? 2 : 1);
            return { p, tile, kind, effective };
          });
        })
        .sort(
          (a, b) =>
            Number(a.kind === "boat") - Number(b.kind === "boat") ||
            Number(b.p.traitor) - Number(a.p.traitor) ||
            a.effective - b.effective ||
            a.p.id - b.p.id,
        );
      for (const { p, tile, kind, effective } of targets) {
        if ((this.game.tileState(tile) & ((1 << 13) | (1 << 14))) !== 0)
          continue;
        const key = kind === "boat" ? `boat:${p.id}:${tile}` : `attack:${p.id}`;
        const type = kind === "boat" ? UnitType.TransportShip : undefined;
        const destination = kind === "boat" ? naval : proposals;
        const teammate =
          p.disconnected && me.team !== null && me.team === p.team;
        if (teammate) {
          destination.push({
            key,
            kind,
            type,
            owner: p.id,
            tile,
            fraction: 0.1,
          });
          continue;
        }
        if (friendly(p.id) || p.disconnected) continue;
        // A measured push can grow territory without requiring enough troops
        // to overwhelm the opponent's entire force in one attack.
        const available = Math.min(
          me.troops * (p.traitor ? 0.5 : 0.4),
          me.troops - floor,
        );
        if (
          me.troops < effective * 1.5 ||
          available < effective * (p.traitor ? 1.25 : 0.75)
        )
          continue;
        const send = Math.min(
          available,
          Math.max(me.troops * 0.2, effective * 1.5),
        );
        destination.push({
          key,
          kind,
          type,
          owner: p.id,
          tile,
          fraction: send / Math.max(1, me.troops),
        });
      }
      if (!neutralFront && eligibleTarget(0))
        for (const tile of landingSites(0)) {
          if ((this.game.tileState(tile) & (1 << 14)) !== 0) continue;
          naval.push({
            key: `boat:0:${tile}`,
            kind: "boat",
            type: UnitType.TransportShip,
            owner: 0,
            tile,
            fraction: 0.15,
          });
        }
      proposals.push(
        ...naval
          .map((proposal) => ({
            proposal,
            distance: spatial.coastDistance(proposal.tile),
          }))
          .sort((a, b) => a.distance - b.distance)
          .map(({ proposal }) => proposal),
      );
    }
    const range = this.game.config().trainStationMaxRange();
    const ports = own.filter((u) => u.type === UnitType.Port);
    const factories = own.filter((u) => u.type === UnitType.Factory);
    const stations = own.filter(
      (u) => [UnitType.City, UnitType.Port].includes(u.type) && !u.constructing,
    );
    const factoryNear = (tile: number) =>
      factories.some((u) => distance(u.tile, tile) <= range);
    const economy = reserve >= 0.3;
    // Cities and ports only earn rail income once a factory is in range.
    if (economy && !factories.some((u) => u.constructing)) {
      const unconnected = stations.filter((u) => !factoryNear(u.tile));
      const clusters = unconnected
        .map((u) => ({
          u,
          size: unconnected.filter((v) => distance(u.tile, v.tile) <= range)
            .length,
        }))
        .filter((c) => c.size >= 2)
        .sort((a, b) => b.size - a.size);
      for (const { u } of clusters.slice(0, 2))
        for (const tile of sites.near(u.tile).slice(0, 2))
          build(UnitType.Factory, tile, {
            newOnly: true,
            railway: true,
            purpose: "economy",
          });
    }
    // Expansion comes first at capacity; an unavailable attack falls through to cities.
    if (reserve >= 0.9) {
      const citySite =
        factories
          .filter((u) => !u.constructing)
          .flatMap((u) => sites.near(u.tile))[0] ??
        sites.inland[0] ??
        asset;
      if (
        citySite !== undefined &&
        !own.some((u) => u.type === UnitType.City && u.constructing)
      )
        build(UnitType.City, citySite, { purpose: "capacity" });
    }
    if (phase === "contested") proposals.push(...diplomacy);
    // Secure a first port as soon as the coast is reached, even while expanding.
    if (spatial.coast.size > 0 && ports.length === 0)
      for (const tile of sites.coast.slice(0, 3))
        build(UnitType.Port, tile, { newOnly: true, purpose: "economy" });
    if (economy) {
      // Trade ships scale with port count, so cover the coastline generously.
      const desiredPorts = Math.min(
        20,
        Math.max(4, Math.ceil(spatial.coast.size / 50)),
      );
      if (
        ports.length > 0 &&
        ports.length < desiredPorts &&
        ports.filter((u) => u.constructing).length < 2
      ) {
        for (const tile of sites.coast.slice(0, 3))
          build(UnitType.Port, tile, { newOnly: true, purpose: "economy" });
      }
      // Rails into foreign stations earn more per visit than domestic trains.
      if (!factories.some((u) => u.constructing)) {
        const foreign = o.units.filter(
          (u) =>
            u.active &&
            !u.constructing &&
            u.owner !== me.id &&
            [UnitType.City, UnitType.Port, UnitType.Factory].includes(u.type) &&
            spatial.fronts.has(u.owner) &&
            !factoryNear(u.tile),
        );
        let frontier = 0;
        for (const station of foreign) {
          if (frontier >= 2) break;
          const border = this.ownBorderNear(
            spatial.fronts.get(station.owner)!,
            station.tile,
            range - 20,
            me.id,
          );
          if (border === undefined) continue;
          const site = sites
            .near(border, [12, 24])
            .find((tile) => distance(tile, station.tile) <= range - 10);
          if (site === undefined) continue;
          frontier++;
          build(UnitType.Factory, site, {
            newOnly: true,
            railway: true,
            purpose: "economy",
          });
        }
      }
      const desiredFactories = Math.min(
        12,
        Math.max(1, Math.ceil(stations.length / 3)),
      );
      if (
        stations.length >= 2 &&
        factories.length < desiredFactories &&
        !factories.some((u) => u.constructing)
      ) {
        for (const tile of sites.railway.slice(0, 3))
          build(UnitType.Factory, tile, {
            newOnly: true,
            railway: true,
            purpose: "economy",
          });
      }
    }
    if (phase !== "contested") proposals.push(...diplomacy);
    if (reserve >= 0.7) {
      for (const b of o.builds)
        if (
          b.affordable &&
          b.connected &&
          (b.type === UnitType.City ||
            b.type === UnitType.Port ||
            b.type === UnitType.Factory) &&
          (b.type !== UnitType.City || reserve >= 0.85)
        )
          build(b.type, b.tile, {
            railway: b.type === UnitType.Factory,
            purpose: "economy",
          });
      // Nuclear targets are hostile infrastructure only; reject friendly blast overlap.
      const target =
        !danger &&
        nuclearTargets.find(
          (u) =>
            (u.type === UnitType.MissileSilo ||
              u.type === UnitType.SAMLauncher ||
              u.level > 1) &&
            !own.some(
              (missile) =>
                [
                  UnitType.AtomBomb,
                  UnitType.HydrogenBomb,
                  UnitType.MIRV,
                  UnitType.MIRVWarhead,
                ].includes(missile.type) &&
                missile.target !== null &&
                this.game.ownerID(missile.target) === u.owner,
            ) &&
            !this.friendlyBlast(
              u.tile,
              this.game.config().nukeMagnitudes(UnitType.AtomBomb).outer,
              friendly,
            ),
        );
      if (target) {
        if (
          own.some(
            (u) =>
              u.type === UnitType.MissileSilo && !u.constructing && u.ready > 0,
          )
        ) {
          proposals.push({
            key: `build:atom:${target.id}`,
            kind: "build",
            type: UnitType.AtomBomb,
            owner: target.owner,
            tile: target.tile,
          });
        } else if (
          asset !== undefined &&
          !own.some((u) => u.type === UnitType.MissileSilo) &&
          own.filter((u) => u.type === UnitType.City && !u.constructing)
            .length >= 2
        )
          build(UnitType.MissileSilo, asset);
      }
    }
    if (economy) {
      if (!own.some((u) => u.type === UnitType.City && u.constructing)) {
        const citySite =
          factories
            .filter((u) => !u.constructing)
            .flatMap((u) => sites.near(u.tile))[0] ??
          sites.inland[0] ??
          asset;
        if (citySite !== undefined)
          build(UnitType.City, citySite, { purpose: "economy" });
      }
      for (const unit of own
        .filter((u) => !u.constructing)
        .sort((a, b) => a.level - b.level || a.id - b.id))
        if (
          unit.type === UnitType.City ||
          unit.type === UnitType.Port ||
          unit.type === UnitType.Factory
        )
          build(unit.type, unit.tile, {
            railway: unit.type === UnitType.Factory,
            purpose: "economy",
          });
    }
    if (fundedOpening || o.tick - (this.lastEconomicTurn ?? o.tick) >= 100)
      return [
        ...proposals.filter((p) => p.emergency),
        ...proposals.filter(
          (p) =>
            !p.emergency &&
            (p.purpose === "economy" || p.purpose === "capacity"),
        ),
        ...proposals.filter(
          (p) =>
            !p.emergency && p.purpose !== "economy" && p.purpose !== "capacity",
        ),
      ];
    return proposals;
  }
  private friendlyBlast(
    tile: number,
    radius: number,
    friendly: (id: number) => boolean,
  ): boolean {
    const x = this.game.x(tile),
      y = this.game.y(tile);
    return (
      this.friendlyLandBlast(tile, radius, friendly) ||
      this.game
        .units()
        .some(
          (u) =>
            u.isActive() &&
            friendly(u.owner().smallID()) &&
            Math.hypot(this.game.x(u.tile()) - x, this.game.y(u.tile()) - y) <
              radius,
        )
    );
  }

  private friendlyLandBlast(
    tile: number,
    radius: number,
    friendly: (id: number) => boolean,
  ): boolean {
    const x = this.game.x(tile);
    const y = this.game.y(tile);
    const size = 32;
    const columns = Math.ceil(this.game.width() / size);
    for (
      let cy = Math.max(0, Math.floor((y - radius) / size));
      cy <=
      Math.min(
        Math.floor((this.game.height() - 1) / size),
        Math.floor((y + radius) / size),
      );
      cy++
    ) {
      for (
        let cx = Math.max(0, Math.floor((x - radius) / size));
        cx <= Math.min(columns - 1, Math.floor((x + radius) / size));
        cx++
      ) {
        const key = cy * columns + cx;
        let tiles = this.friendlyLandCells.get(key);
        if (!tiles) {
          tiles = [];
          for (
            let yy = cy * size;
            yy < Math.min((cy + 1) * size, this.game.height());
            yy++
          )
            for (
              let xx = cx * size;
              xx < Math.min((cx + 1) * size, this.game.width());
              xx++
            ) {
              const ref = yy * this.game.width() + xx;
              if (friendly(this.game.ownerID(ref))) tiles.push(ref);
            }
          this.friendlyLandCells.set(key, tiles);
        }
        if (
          tiles.some(
            (ref) =>
              (this.game.x(ref) - x) ** 2 + (this.game.y(ref) - y) ** 2 <=
              radius ** 2,
          )
        )
          return true;
      }
    }
    return false;
  }

  private mirvFriendlyBlast(
    target: number,
    owner: number,
    friendly: (id: number) => boolean,
  ): boolean {
    // MIRVs scatter over the target owner's land within 1500 tiles, not just
    // the clicked tile. Check boundary blasts and friendly mobile units too.
    const radius = this.game
      .config()
      .nukeMagnitudes(UnitType.MIRVWarhead).outer;
    const reach = 1500 + radius;
    const x = this.game.x(target);
    const y = this.game.y(target);
    const units = this.game
      .units()
      .filter((u) => u.isActive() && friendly(u.owner().smallID()));
    // Mobile units may be over the interior of enemy territory, not a border.
    for (const unit of units) {
      const ux = this.game.x(unit.tile());
      const uy = this.game.y(unit.tile());
      if ((ux - x) ** 2 + (uy - y) ** 2 > (reach + radius) ** 2) continue;
      for (
        let yy = Math.max(0, uy - radius);
        yy <= Math.min(this.game.height() - 1, uy + radius);
        yy++
      )
        for (
          let xx = Math.max(0, ux - radius);
          xx <= Math.min(this.game.width() - 1, ux + radius);
          xx++
        ) {
          const tile = yy * this.game.width() + xx;
          if (
            (xx - ux) ** 2 + (yy - uy) ** 2 <= radius ** 2 &&
            (xx - x) ** 2 + (yy - y) ** 2 <= reach ** 2 &&
            this.game.ownerID(tile) === owner &&
            this.game.isLand(tile)
          )
            return true;
        }
    }
    const size = 32;
    const maxX = Math.min(this.game.width() - 1, x + reach);
    const maxY = Math.min(this.game.height() - 1, y + reach);
    for (let top = Math.max(0, y - reach); top <= maxY; top += size)
      for (let left = Math.max(0, x - reach); left <= maxX; left += size) {
        // A cell without friendly land anywhere in its expanded blast area
        // cannot contain a friendly-land collision at any warhead destination.
        if (
          !this.friendlyLandBlast(
            top * this.game.width() + left,
            radius + (size - 1) * Math.SQRT2,
            friendly,
          )
        )
          continue;
        for (let yy = top; yy <= Math.min(top + size - 1, maxY); yy++)
          for (let xx = left; xx <= Math.min(left + size - 1, maxX); xx++) {
            const tile = yy * this.game.width() + xx;
            if (
              (xx - x) ** 2 + (yy - y) ** 2 > reach ** 2 ||
              this.game.ownerID(tile) !== owner ||
              !this.game.isLand(tile)
            )
              continue;
            if (
              this.game
                .neighbors(tile)
                .some((n) => this.game.ownerID(n) !== owner) &&
              this.friendlyLandBlast(tile, radius, friendly)
            )
              return true;
          }
      }
    return false;
  }

  /** Own tile touching the given foreign front, nearest to a target tile. */
  private ownBorderNear(
    front: ReadonlySet<number>,
    target: number,
    maxDistance: number,
    me: number,
  ): number | undefined {
    let best: number | undefined;
    let bestDistance = maxDistance;
    let count = 0;
    for (const tile of front) {
      if (++count > 512) break;
      const d = Math.hypot(
        this.game.x(tile) - this.game.x(target),
        this.game.y(tile) - this.game.y(target),
      );
      if (d > bestDistance) continue;
      const own = this.game
        .neighbors(tile)
        .find((n) => this.game.ownerID(n) === me && this.game.isLand(n));
      if (own === undefined) continue;
      best = own;
      bestDistance = d;
    }
    return best;
  }

  private waterConnected(from: number, to: number): boolean {
    // Open seas should not fail just because a breadth-first flood fills its
    // budget before reaching a distant ship. Only accept a verified water path.
    const distance = (tile: number) =>
      Math.abs(this.game.x(tile) - this.game.x(to)) +
      Math.abs(this.game.y(tile) - this.game.y(to));
    let direct = from;
    for (let i = 0; i < 4096 && direct !== to; i++) {
      const remaining = distance(direct);
      const next = this.game
        .neighbors(direct)
        .find((tile) => !this.game.isLand(tile) && distance(tile) < remaining);
      if (next === undefined) break;
      direct = next;
    }
    if (direct === to) return true;
    const seen = new Set([from]);
    const queue = [from];
    for (let i = 0; i < queue.length && i < 4096; i++) {
      const tile = queue[i];
      if (tile === to) return true;
      for (const n of this.game.neighbors(tile))
        if (!seen.has(n) && !this.game.isLand(n)) {
          seen.add(n);
          queue.push(n);
        }
    }
    return false;
  }

  private connectedShore(water: number, owner: number): Set<number> {
    const shore = new Set<number>();
    const visited = new Set([water]);
    const queue = [water];
    for (let i = 0; i < queue.length && i < 4096; i++) {
      for (const tile of this.game.neighbors(queue[i])) {
        if (this.game.isLand(tile)) {
          if (
            this.game.ownerID(tile) === owner &&
            !this.game.isImpassable(tile) &&
            (this.game.tileState(tile) & (1 << 13)) === 0
          )
            shore.add(tile);
        } else if (!visited.has(tile)) {
          visited.add(tile);
          queue.push(tile);
        }
      }
    }
    return shore;
  }

  private dispatch(
    p: Proposal,
    result: PlayerActions,
    o: AdvisorObservation,
  ): boolean {
    const me = this.game.myPlayer()!;
    if (p.owner !== undefined && this.game.ownerID(p.tile) !== p.owner)
      return false;
    if (p.kind === "attack") {
      if (!result.canAttack) return false;
      const troops = Math.floor(me.troops() * p.fraction!);
      if (troops <= 0) return false;
      const recipient = this.game.playerBySmallID(p.owner!);
      this.emit(
        new SendAttackIntentEvent(
          recipient.isPlayer() ? recipient.id() : null,
          troops,
        ),
      );
    } else if (p.kind === "move") {
      const ship = this.game.unit(p.ship!);
      if (
        !ship?.isActive() ||
        ship.owner() !== me ||
        ship.type() !== UnitType.Warship ||
        ship.isUnderConstruction()
      )
        return false;
      this.emit(new MoveWarshipIntentEvent([p.ship!], p.tile));
    } else if (p.kind === "diplomacy") {
      const recipient = this.game.playerBySmallID(p.owner!);
      if (!recipient.isPlayer()) return false;
      if (result.interaction?.allianceInfo?.canExtend)
        this.emit(new SendAllianceExtensionIntentEvent(recipient));
      else if (result.interaction?.canSendAllianceRequest)
        this.emit(new SendAllianceRequestIntentEvent(me, recipient));
      else return false;
    } else {
      const nuclear =
        p.type === UnitType.AtomBomb ||
        p.type === UnitType.HydrogenBomb ||
        p.type === UnitType.MIRV;
      const b = result.buildableUnits.find((b) => b.type === p.type);
      const nuclearSpending = nuclear || p.type === UnitType.MissileSilo;
      if (
        !b ||
        b.cost > me.gold() ||
        (!p.emergency &&
          p.type !== UnitType.SAMLauncher &&
          b.cost * 5n > me.gold() * 4n) ||
        (p.newOnly && b.canUpgrade !== false)
      )
        return false;
      if (
        nuclearSpending &&
        !this.nuclearBudget.canSpend(b.type, b.cost, me.gold())
      )
        return false;
      if (p.railway && b.canUpgrade === false) {
        // Own factories add no new paying stop; foreign ones do.
        const stations = o.units.filter(
          (u) =>
            u.active &&
            !u.constructing &&
            (u.owner === o.myID
              ? u.type === UnitType.City || u.type === UnitType.Port
              : [UnitType.City, UnitType.Port, UnitType.Factory].includes(
                  u.type,
                )),
        );
        if (
          !b.ghostRailPaths.some(
            (path) =>
              path.length > 1 &&
              stations.some(
                (u) => u.tile === path[0] || u.tile === path[path.length - 1],
              ),
          )
        )
          return false;
      }
      if (p.kind === "boat") {
        if (b.canBuild === false) return false;
        const troops = Math.floor(me.troops() * p.fraction!);
        if (troops <= 0) return false;
        this.emit(new SendBoatAttackIntentEvent(p.tile, troops));
      } else if (b.canUpgrade !== false && !nuclear) {
        const unit = this.game.unit(b.canUpgrade);
        if (
          !unit?.isActive() ||
          unit.owner() !== me ||
          unit.type() !== b.type ||
          unit.isUnderConstruction()
        )
          return false;
        this.emit(new SendUpgradeStructureIntentEvent(b.canUpgrade, b.type, 1));
      } else if (b.canBuild !== false) {
        if (
          p.waterTarget !== undefined &&
          !this.connectedShore(p.waterTarget, o.myID).has(b.canBuild)
        )
          return false;
        const destinationTarget = nuclear || p.type === UnitType.Warship;
        const tile = destinationTarget ? p.tile : b.canBuild;
        if (!nuclear && this.game.ownerID(b.canBuild) !== o.myID) return false;
        this.emit(new BuildUnitIntentEvent(b.type, tile));
      } else return false;
      if (nuclearSpending) this.nuclearBudget.spend(b.cost);
    }
    return true;
  }
}
