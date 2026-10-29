import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { SpatialIndex } from "./SpatialIndex";
import type { AdviceContext, AdvisorMap, AdvisorObservation } from "./Types";

/** Strategic phase inferred from current evidence, not a fixed match timeline. */
export function gamePhase(
  o: AdvisorObservation,
  map: AdvisorMap,
  spatial: SpatialIndex,
): AdviceContext {
  const me = o.players.find((p) => p.id === o.myID);
  if (!me) return "economy";
  if ((o.clockEnabled && me.doomed) || o.landShare >= o.winShare * 0.8)
    return "endgame";
  const hostile = (id: number) =>
    o.players.some(
      (p) =>
        p.id === id && !p.friendly && !(me.team !== null && p.team === me.team),
    );
  const units = o.units.filter((u) => u.active);
  const neutralFrontSize = spatial.fronts.get(0)?.size ?? 0;
  const nearbyTribe = o.players.some(
    (p) =>
      p.alive &&
      hostile(p.id) &&
      p.type === PlayerType.Bot &&
      spatial.fronts.has(p.id),
  );
  const hasFrontier = neutralFrontSize > 0 || nearbyTribe;
  const hasSubstantialFrontier =
    neutralFrontSize >= 8 ||
    o.players.some(
      (p) =>
        p.alive &&
        hostile(p.id) &&
        p.type === PlayerType.Bot &&
        p.tiles >= 64 &&
        spatial.fronts.has(p.id),
    );
  if (
    units.some(
      (u) =>
        (u.type === UnitType.MissileSilo && hostile(u.owner)) ||
        (u.target !== null &&
          u.range > 0 &&
          [
            UnitType.AtomBomb,
            UnitType.HydrogenBomb,
            UnitType.MIRVWarhead,
          ].includes(u.type) &&
          spatial.blastTouches(u.target, u.range)),
    )
  )
    return "nuclear";
  if (
    me.incoming > 0 ||
    units.some(
      (u) =>
        u.type === UnitType.TransportShip &&
        hostile(u.owner) &&
        !u.retreating &&
        u.target !== null &&
        map.ownerID(u.target) === me.id,
    ) ||
    o.players.some(
      (p) =>
        p.alive &&
        hostile(p.id) &&
        p.type !== PlayerType.Bot &&
        spatial.fronts.has(p.id) &&
        p.troops > me.troops,
    ) ||
    (me.troops < o.cap * 0.2 && me.outgoing > me.troops)
  )
    return "contested";
  if ((o.elapsed < 1800 && hasFrontier) || hasSubstantialFrontier)
    return "opening";
  return "economy";
}
