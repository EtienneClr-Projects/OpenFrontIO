import { GameMode, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { PlayerBuildableUnitType } from "@openfront/engine-api/game/GameTypes";
import type { GameEvent } from "@openfront/shared/EventBus";
import type { GameView } from "../view";
import { AdvisorEngine } from "./AdvisorEngine";
import { AdvisorPanel } from "./AdvisorPanel";
import { AutomaticPlayer } from "./AutomaticPlayer";
import { buildingSites } from "./BuildingSites";
export { isAdvisorHost } from "./AutomaticPlayer";
import { SpatialIndex } from "./SpatialIndex";
import type { AdvisorObservation, BuildAdvice } from "./Types";

export class AdvisorController {
  readonly panel = new AdvisorPanel();
  private spatial: SpatialIndex | null = null;
  private engine: AdvisorEngine | null = null;
  private enabled = false;
  private stopped = false;
  private generation = 0;
  private lastTick = -1;
  private lastQuery = -Infinity;
  private lastVerified = -Infinity;
  private queryPending = false;
  private queryState: AdvisorObservation["queryState"] = "checking";
  private builds: BuildAdvice[] = [];
  private legal = new Map<number, { tile: number; until: number }>();
  private signature = "";
  private observed: AdvisorObservation | null = null;
  private readonly timings: number[] = [];
  private readonly automatic: AutomaticPlayer | null;

  constructor(
    private readonly game: GameView,
    focus: (tile: number) => void,
    emit?: (event: GameEvent) => void,
  ) {
    this.automatic = emit
      ? new AutomaticPlayer(game, emit, (enabled, state) => {
          this.panel.automatic = enabled;
          this.panel.automaticState = state;
        })
      : null;
    this.panel.canAutomate = !!emit && !game.config().isReplay();
    this.panel.onAutomatic = (enabled) => {
      if (enabled && !this.enabled) this.panel.onToggle(true);
      this.automatic?.setEnabled(enabled);
    };
    this.panel.diagnostics = () => this.performance();
    this.panel.onFocus = focus;
    this.panel.onToggle = (enabled) => {
      this.enabled = enabled;
      this.panel.enabled = enabled;
      this.reset();
      this.panel.status = enabled ? "waiting" : "disabled";
    };
    this.panel.onHide = (id, snooze) => {
      this.engine?.hide(id, this.game.ticks(), snooze);
      if (this.observed && this.engine) {
        this.publish(this.engine.evaluate(this.observed));
      }
    };
    document.body.append(this.panel);
  }

  private reset(): void {
    this.automatic?.setEnabled(false);
    this.generation++;
    this.spatial = null;
    this.engine = null;
    this.lastTick = -1;
    this.lastQuery = -Infinity;
    this.lastVerified = -Infinity;
    this.queryPending = false;
    this.queryState = "checking";
    this.builds = [];
    this.legal.clear();
    this.observed = null;
    this.signature = "";
    this.panel.result = { context: "opening", items: [] };
    this.timings.length = 0;
  }

  dispose(): void {
    this.stopped = true;
    this.enabled = false;
    this.reset();
    this.panel.remove();
    this.panel.diagnostics = () => ({ samples: 0, p95Ms: 0 });
  }

  /** Local diagnostics only; no telemetry or network traffic. */
  performance(): { samples: number; p95Ms: number } {
    const sorted = [...this.timings].sort((a, b) => a - b);
    return {
      samples: sorted.length,
      p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    };
  }

  tick(): void {
    if (!this.enabled || this.stopped) return;
    const tick = this.game.ticks();
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    const me = this.game.myPlayer();
    if (this.game.gameOver() || (me && !me.isAlive())) {
      this.panel.status = "finished";
      this.reset();
      return;
    }
    if (!me || this.game.inSpawnPhase()) {
      this.panel.status = "waiting";
      return;
    }
    if (this.game.isCatchingUp()) {
      // A rebuilt baseline prevents catch-up transitions becoming "new" alerts.
      this.reset();
      this.panel.status = "catchup";
      return;
    }
    const start = performance.now();
    try {
      if (!this.spatial) {
        this.spatial = new SpatialIndex(this.game, me.smallID());
        this.engine = new AdvisorEngine(this.game, this.spatial);
      }
      this.spatial.ingest(this.game.recentlyUpdatedTiles());
      if (!this.spatial.ready) {
        const deadline = performance.now() + 2;
        do {
          this.spatial.initialize();
        } while (!this.spatial.ready && performance.now() < deadline);
        this.panel.status = "indexing";
        return;
      }
      this.panel.status = "active";
      if (!this.queryPending && tick - this.lastQuery >= 20) {
        void this.query();
      }
      const observation = this.observe();
      this.observed = observation;
      const result = this.engine!.evaluate(observation);
      this.publish(result);
      this.automatic?.tick(observation, this.spatial);
      this.timings.push(performance.now() - start);
      if (this.timings.length > 300) this.timings.shift();
    } catch (error) {
      console.error("Strategy adviser stopped:", error);
      this.enabled = false;
      this.reset();
      this.panel.enabled = false;
      this.panel.status = "error";
    }
  }

  private publish(result: ReturnType<AdvisorEngine["evaluate"]>): void {
    // Tick labels update twice a simulated second; urgent changes publish now.
    const signature = JSON.stringify({
      context: result.context,
      bucket: Math.floor(this.game.ticks() / 5),
      items: result.items.map(({ firstTick, lastTick, ...item }) => item),
    });
    if (signature !== this.signature) {
      this.signature = signature;
      this.panel.result = result;
    }
    this.panel.queryState = this.observed?.queryState ?? this.queryState;
  }

  private observe(): AdvisorObservation {
    const game = this.game;
    const me = game.myPlayer()!;
    const config = game.config();
    const tick = game.ticks();
    const teamGame = config.gameConfig().gameMode !== GameMode.FFA;
    const players = game.players().map((p) => ({
      id: p.smallID(),
      name: p.displayName(),
      type: p.type(),
      team: p.team(),
      alive: p.isAlive(),
      disconnected: p.state.isDisconnected,
      friendly: p === me || (!p.state.isDisconnected && me.isFriendly(p)),
      tiles: p.numTilesOwned(),
      troops: p.troops(),
      incoming: p.incomingAttacks().reduce((n, a) => n + a.troops, 0),
      outgoing: p.outgoingAttacks().reduce((n, a) => n + a.troops, 0),
      traitor: p.state.isTraitor,
      doomed: p.state.inDoomsdayClock,
      alliances: p.alliances().map((a) => ({
        id: a.id,
        name: game.player(a.other).displayName(),
        remaining: a.expiresAt - tick,
      })),
    }));
    const units = game.units().map((u) => {
      const type = u.type();
      const state = u.state;
      const plan = game.motionPlans().get(u.id());
      const validPlan =
        plan && plan.path[plan.path.length - 1] === u.targetTile();
      return {
        id: u.id(),
        owner: u.owner().smallID(),
        type,
        tile: u.tile(),
        target: u.targetTile() ?? null,
        active: u.isActive(),
        retreating: state.retreating,
        constructing: u.isUnderConstruction(),
        level: u.level(),
        ready: u.isUnderConstruction()
          ? 0
          : Math.max(0, u.level() - u.missileTimerQueue().length),
        range:
          type === UnitType.DefensePost
            ? config.defensePostRange()
            : type === UnitType.SAMLauncher
              ? state.samUpgradeStartTick !== null
                ? (state.samUpgradeStartRange ?? config.samRange(u.level()))
                : config.samRange(u.level())
              : [
                    UnitType.AtomBomb,
                    UnitType.HydrogenBomb,
                    UnitType.MIRVWarhead,
                  ].includes(type)
                ? config.nukeMagnitudes(type).outer
                : 0,
        troops: u.troops(),
        arrivalTick: validPlan
          ? plan.startTick + (plan.path.length - 1) * plan.ticksPerStep
          : null,
      };
    });
    const sideTiles = players
      .filter(
        (p) =>
          p.id === me.smallID() ||
          (teamGame && me.team() !== null && p.team === me.team() && p.alive),
      )
      .reduce((n, p) => n + p.tiles, 0);
    const attackable = new Set<number>();
    for (const [owner, legal] of this.legal) {
      if (
        legal.until >= tick &&
        game.ownerID(legal.tile) === owner &&
        this.spatial!.fronts.get(owner)?.has(legal.tile)
      ) {
        attackable.add(owner);
      }
    }
    return {
      tick,
      elapsed: game.ticksSinceStart(),
      myID: me.smallID(),
      players,
      units,
      cap: config.maxTroops(me),
      growth: config.troopIncreaseRate(me),
      gold: me.gold(),
      builds: this.builds.filter(
        (b) =>
          tick - this.lastVerified <= 20 &&
          game.ownerID(b.tile) === me.smallID() &&
          b.cost <= me.gold(),
      ),
      queryState:
        this.queryState === "ready" && tick - this.lastVerified > 20
          ? "checking"
          : this.queryState,
      attackable,
      landShare:
        sideTiles /
        Math.max(1, game.numLandTiles() - game.numTilesWithFallout()),
      winShare:
        config.percentageTilesOwnedToWin(game.elapsedGameSeconds()) / 100,
      clockEnabled: config.doomsdayClockConfig().enabled,
    };
  }

  private async query(): Promise<void> {
    const me = this.game.myPlayer()!;
    const spatial = this.spatial!;
    const generation = this.generation;
    const tick = this.game.ticks();
    this.lastQuery = tick;
    this.queryPending = true;
    try {
      const buildTypes: readonly PlayerBuildableUnitType[] = [
        UnitType.City,
        UnitType.Port,
        UnitType.Factory,
      ];
      const owners = [...spatial.fronts.keys()].sort((a, b) => {
        const pa = this.game.playerStates().get(a);
        const pb = this.game.playerStates().get(b);
        return (
          Number(pb?.isDisconnected ?? false) -
            Number(pa?.isDisconnected ?? false) || a - b
        );
      });
      const offset = Math.floor(tick / 20) % Math.max(1, owners.length);
      const sampledOwners = new Set([
        ...owners
          .filter((id) => this.game.playerStates().get(id)?.isDisconnected)
          .slice(0, 1),
        ...owners.slice(offset, offset + 2),
        ...owners.slice(0, 2),
      ]);
      const candidates = [...sampledOwners].slice(0, 3).flatMap((owner) => {
        const tile = spatial.sample(owner);
        return tile === undefined ? [] : [{ owner, tile }];
      });
      const ownStructures = me.units(
        UnitType.City,
        UnitType.Factory,
        UnitType.Port,
      );
      const round = Math.floor(tick / 20);
      const sites = buildingSites(this.game, spatial, round);
      const inland =
        sites.inland[0] ??
        ownStructures[round % Math.max(1, ownStructures.length)]?.tile() ??
        me.state.spawnTile;
      const coast = sites.coast[0] ?? spatial.coastalSites(round)[0];
      const positions = [
        ...new Set(
          [inland, coast, sites.railway[0]].filter(
            (tile): tile is number => tile !== undefined,
          ),
        ),
      ];
      const [attacks, builds] = await Promise.all([
        Promise.all(
          candidates.map(async ({ owner, tile }) => ({
            owner,
            tile,
            result: await this.game.worker.playerInteraction(
              me.id(),
              this.game.x(tile),
              this.game.y(tile),
              null,
            ),
          })),
        ),
        Promise.all(
          positions.map(async (tile) => ({
            tile,
            result: await this.game.worker.playerInteraction(
              me.id(),
              this.game.x(tile),
              this.game.y(tile),
              buildTypes,
            ),
          })),
        ),
      ]);
      if (this.stopped || !this.enabled || generation !== this.generation)
        return;
      if (this.game.ticks() - tick > 20 || this.game.isCatchingUp()) {
        this.queryState = "checking";
        this.builds = [];
        this.legal.clear();
        return;
      }
      this.legal.clear();
      for (const { owner, tile, result } of attacks) {
        if (result.canAttack) this.legal.set(owner, { tile, until: tick + 20 });
      }
      this.builds = builds.flatMap(({ result }) =>
        result.buildableUnits.flatMap((b): BuildAdvice[] => {
          const destination =
            b.canBuild === false
              ? b.canUpgrade === false
                ? undefined
                : this.game.unit(b.canUpgrade)?.tile()
              : b.canBuild;
          if (destination === undefined || !buildTypes.includes(b.type))
            return [];
          return [
            {
              type: b.type,
              tile: destination,
              cost: b.cost,
              affordable: b.cost <= me.gold(),
              connected:
                b.type === UnitType.City ||
                (b.type === UnitType.Port
                  ? this.game.units(UnitType.Port).some((p) => p.owner() !== me)
                  : b.ghostRailPaths.length > 0),
            },
          ];
        }),
      );
      this.lastVerified = tick;
      this.queryState = "ready";
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      console.warn("Strategy adviser eligibility query failed:", error);
      this.queryState = "error";
      this.builds = [];
      this.legal.clear();
    } finally {
      if (generation === this.generation) this.queryPending = false;
    }
  }
}
