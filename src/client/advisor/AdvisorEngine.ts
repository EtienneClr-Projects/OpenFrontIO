import { Structures, UnitType } from "@openfront/engine-api/game/GameTypes";
import { gamePhase } from "./GamePhase";
import { SpatialIndex } from "./SpatialIndex";
import type {
  AdviceContext,
  AdvisorMap,
  AdvisorObservation,
  AdvisorResult,
  AdvisorUnit,
  Recommendation,
} from "./Types";

export class AdvisorEngine {
  private previous = new Map<number, string>();
  private changes = new Map<number, { stage: string; until: number }>();
  private active = new Map<string, Recommendation>();
  private hidden = new Map<string, { until: number; priority: number }>();
  private initialized = false;
  private context: AdviceContext = "opening";

  constructor(
    private readonly map: AdvisorMap,
    private readonly spatial: SpatialIndex,
  ) {}

  hide(id: string, tick: number, snooze: boolean): void {
    const item = this.active.get(id);
    if (item) {
      this.hidden.set(id, {
        until: snooze ? tick + 300 : Infinity,
        priority: item.priority,
      });
    }
  }

  evaluate(o: AdvisorObservation): AdvisorResult {
    const me = o.players.find((p) => p.id === o.myID);
    if (!me) return { context: this.context, items: [] };
    const players = new Map(o.players.map((p) => [p.id, p]));
    const units = o.units.filter((u) => u.active);
    const own = units.filter((u) => u.owner === me.id);
    const items = new Map<string, Recommendation>();
    const add = (
      id: string,
      rule: string,
      priority: number,
      confidence: Recommendation["confidence"],
      params: Recommendation["params"] = {},
      tile?: number,
    ) => {
      items.set(id, {
        id,
        rule,
        priority,
        confidence,
        params,
        tile,
        firstTick: this.active.get(id)?.firstTick ?? o.tick,
        lastTick: o.tick,
      });
    };
    const distance = (a: number, b: number) =>
      Math.hypot(
        (a % this.map.width()) - (b % this.map.width()),
        Math.floor(a / this.map.width()) - Math.floor(b / this.map.width()),
      );
    const reserve = me.troops / Math.max(1, o.cap);
    const incoming = me.incoming;
    if (incoming > 0) {
      add(
        "defense",
        "defense",
        incoming >= me.troops * 0.5 ? 96 : 78,
        "observed",
        {
          troops: Math.round(incoming),
          reserve: Math.round(me.troops),
        },
      );
    } else if (
      reserve < 0.2 &&
      (me.outgoing > me.troops ||
        o.players.some(
          (p) =>
            !p.friendly &&
            p.alive &&
            this.spatial.fronts.has(p.id) &&
            p.troops > me.troops * 2,
        ))
    ) {
      add("exposure", "exposure", 76, "estimate", {
        percent: Math.round(reserve * 100),
        committed: Math.round(me.outgoing),
      });
    }

    for (const p of o.players) {
      if (
        p.id !== me.id &&
        p.alive &&
        this.spatial.fronts.has(p.id) &&
        p.troops > me.troops
      ) {
        const sameTeam = me.team !== null && me.team === p.team;
        const friendly = p.friendly || sameTeam;
        add(
          `strong_neighbor:${p.id}`,
          friendly ? "strong_friendly_neighbor" : "strong_neighbor",
          (friendly ? 55 : 71) + (p.troops > me.troops * 2 ? 4 : 0),
          "estimate",
          {
            name: p.name,
            troops: Math.round(p.troops),
            reserve: Math.round(me.troops),
            advantage: Math.round(p.troops - me.troops),
          },
          this.spatial.sample(p.id),
        );
      }
      if (
        p.id === me.id ||
        !p.alive ||
        !this.spatial.fronts.has(p.id) ||
        !o.attackable.has(p.id)
      ) {
        continue;
      }
      const tile = this.spatial.sample(p.id);
      if (p.disconnected) {
        const teammate = me.team !== null && me.team === p.team;
        add(
          `disconnected:${p.id}`,
          teammate ? "reclaim" : "disconnected",
          teammate ? 68 : 50,
          teammate ? "observed" : "estimate",
          { name: p.name, troops: Math.round(p.troops) },
          tile,
        );
      } else if (
        !p.friendly &&
        reserve > 0.35 &&
        incoming === 0 &&
        me.outgoing < me.troops * 0.5 &&
        p.troops < me.troops * 0.4 &&
        tile !== undefined &&
        !units.some(
          (u) =>
            u.owner === p.id &&
            u.type === UnitType.DefensePost &&
            !u.constructing &&
            distance(u.tile, tile) <= u.range,
        ) &&
        (this.map.tileState(tile) & (1 << 13)) === 0
      ) {
        add(
          `expand:${p.id}`,
          "weak_neighbor",
          43,
          "estimate",
          { name: p.name, troops: Math.round(p.troops) },
          tile,
        );
      }
    }
    if (
      this.spatial.fronts.has(0) &&
      o.attackable.has(0) &&
      reserve > 0.25 &&
      incoming === 0 &&
      me.outgoing < me.troops * 0.5
    ) {
      add(
        "neutral",
        "neutral",
        reserve > 0.8 ? 56 : 46,
        "estimate",
        { percent: Math.round(reserve * 100) },
        this.spatial.sample(0),
      );
    }

    for (const u of units) {
      const owner = players.get(u.owner);
      if (!owner || owner.friendly || u.retreating) continue;
      if (u.type === UnitType.TransportShip) {
        const landing =
          u.target !== null && this.map.ownerID(u.target) === me.id;
        if (!landing) continue;
        const defenders = own.filter(
          (ship) =>
            ship.type === UnitType.Warship &&
            distance(ship.tile, u.tile) <= 130,
        ).length;
        add(
          `transport:${u.id}`,
          "landing",
          u.troops > me.troops ? 95 : 92,
          "observed",
          {
            name: owner.name,
            troops: Math.round(u.troops),
            eta:
              u.arrivalTick === null
                ? "unknown"
                : Math.max(0, (u.arrivalTick - o.tick) / 10).toFixed(1),
            defenders,
          },
          u.target!,
        );
      }
    }

    const currentStructures = new Map<number, string>();
    const salvos = new Map<number, AdvisorUnit[]>();
    for (const u of units) {
      const owner = players.get(u.owner);
      if (!owner) continue;
      if (u.type === UnitType.MissileSilo || u.type === UnitType.SAMLauncher) {
        const signature = `${u.owner}:${u.level}:${u.constructing}`;
        currentStructures.set(u.id, signature);
        const old = this.previous.get(u.id);
        if (this.initialized && old !== signature) {
          const stage =
            old === undefined
              ? u.constructing
                ? "construction"
                : "appeared"
              : old.split(":")[0] !== String(u.owner)
                ? "captured"
                : u.constructing
                  ? "upgrade"
                  : "completed";
          this.changes.set(u.id, { stage, until: o.tick + 300 });
        }
        if (owner.friendly) continue;
        const change = this.changes.get(u.id);
        add(
          `structure:${u.id}`,
          u.type === UnitType.MissileSilo ? "silo" : "sam",
          change && change.until > o.tick ? 49 : 24,
          "observed",
          {
            name: owner.name,
            stage:
              change && change.until > o.tick
                ? change.stage
                : u.constructing
                  ? "construction"
                  : "existing",
            ready: u.ready,
            level: u.level,
            range: Math.round(u.range),
          },
          u.tile,
        );
      }
      if (
        u.target !== null &&
        u.range > 0 &&
        [
          UnitType.AtomBomb,
          UnitType.HydrogenBomb,
          UnitType.MIRVWarhead,
        ].includes(u.type) &&
        this.spatial.blastTouches(u.target, u.range)
      ) {
        let salvo = salvos.get(u.owner);
        if (!salvo) salvos.set(u.owner, (salvo = []));
        salvo.push(u);
      }
    }
    for (const [owner, missiles] of salvos) {
      const first = missiles[0];
      const launcher = players.get(owner)!;
      const friendlyFire =
        launcher.friendly || (me.team !== null && launcher.team === me.team);
      // Destination coverage is not a trajectory/interception simulation.
      const sams = own.filter(
        (u) =>
          !friendlyFire &&
          u.type === UnitType.SAMLauncher &&
          !u.constructing &&
          u.ready > 0,
      );
      const covered = missiles.filter((missile) =>
        sams.some((sam) => distance(sam.tile, missile.target!) <= sam.range),
      ).length;
      const sam = sams.filter((sam) =>
        missiles.some(
          (missile) => distance(sam.tile, missile.target!) <= sam.range,
        ),
      ).length;
      const threatened = own.filter(
        (u) =>
          Structures.has(u.type) &&
          missiles.some(
            (missile) => distance(u.tile, missile.target!) < missile.range,
          ),
      );
      const infrastructure: Record<string, number> = {};
      for (const type of Structures.types) {
        infrastructure[type] = threatened.filter((u) => u.type === type).length;
      }
      add(
        `nuke:${owner}`,
        "nuke",
        missiles.length > 1 ? 101 : 100,
        "observed",
        {
          name: launcher.name,
          count: missiles.length,
          sam,
          covered,
          uncovered: missiles.length - covered,
          coverage: friendlyFire
            ? "friendly_fire"
            : covered === 0
              ? "none"
              : covered === missiles.length
                ? "all"
                : "partial",
          ...infrastructure,
        },
        first.target!,
      );
    }
    this.previous = currentStructures;
    for (const [id, change] of this.changes) {
      if (!currentStructures.has(id) || change.until <= o.tick) {
        this.changes.delete(id);
      }
    }
    this.initialized = true;

    if (o.queryState === "ready" && incoming === 0) {
      for (const build of o.builds) {
        if (!build.affordable) continue;
        const city = build.type === UnitType.City;
        if (city && reserve < 0.6) continue;
        if (!city && !build.connected) continue;
        const rule =
          build.type === UnitType.City
            ? "city"
            : build.type === UnitType.Port
              ? "port"
              : "factory";
        add(
          `economy:${build.type}`,
          rule,
          city && reserve > 0.85 ? 52 : 35,
          "estimate",
          { cost: build.cost.toString(), growth: Math.round(o.growth * 10) },
          build.tile,
        );
      }
    }
    for (const alliance of me.alliances) {
      if (alliance.remaining > 0 && alliance.remaining <= 300) {
        add(`alliance:${alliance.id}`, "alliance", 62, "observed", {
          name: alliance.name,
          seconds: Math.ceil(alliance.remaining / 10),
        });
      }
    }
    if (me.traitor) add("traitor", "traitor", 80, "observed");
    if (o.clockEnabled && me.doomed) {
      add("clock", "clock", 97, "observed", {
        share: (o.landShare * 100).toFixed(1),
      });
    }
    if (o.landShare >= o.winShare * 0.8) {
      add("victory", "victory", 60, "estimate", {
        share: (o.landShare * 100).toFixed(1),
        required: (o.winShare * 100).toFixed(1),
      });
    }

    this.context = gamePhase(o, this.map, this.spatial);
    for (const id of this.hidden.keys()) {
      if (!items.has(id)) this.hidden.delete(id);
    }
    this.active = items;
    return {
      context: this.context,
      items: [...items.values()]
        .filter((item) => {
          const hidden = this.hidden.get(item.id);
          return (
            !hidden || hidden.until <= o.tick || item.priority > hidden.priority
          );
        })
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)),
    };
  }
}
