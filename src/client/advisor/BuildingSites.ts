import { Structures, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { GameView } from "../view";
import type { SpatialIndex } from "./SpatialIndex";

/** Spread new structures across territory and around potential rail stations. */
export function buildingSites(
  game: GameView,
  spatial: SpatialIndex,
  round: number,
) {
  const me = game.myPlayer()!;
  const stations = me
    .units(UnitType.City, UnitType.Port, UnitType.Factory)
    .filter((u) => u.isActive());
  const occupied = me
    .units()
    .filter((u) => u.isActive() && Structures.has(u.type()));
  const minDistance = game.config().structureMinDist();
  const distance = minDistance + 4;
  const anchors = [me.state.spawnTile, ...stations.map((u) => u.tile())].filter(
    (tile): tile is number => tile !== undefined,
  );
  const candidates = new Set<number>();
  for (let i = 0; i < Math.min(4, anchors.length); i++) {
    const anchor = anchors[(round + i) % anchors.length];
    for (const [dx, dy] of [
      [distance, 0],
      [0, distance],
      [-distance, 0],
      [0, -distance],
    ]) {
      const x = game.x(anchor) + dx,
        y = game.y(anchor) + dy;
      if (x >= 0 && y >= 0 && x < game.width() && y < game.height())
        candidates.add(y * game.width() + x);
    }
  }
  const grid = [...spatial.sites];
  for (let i = 0; i < Math.min(16, grid.length); i++)
    candidates.add(grid[(round * 7 + i) % grid.length]);
  for (const anchor of anchors.slice(0, 4)) candidates.add(anchor);
  const available = (tile: number) =>
    game.ownerID(tile) === me.smallID() &&
    game.isLand(tile) &&
    !game.isImpassable(tile) &&
    (game.tileState(tile) & (1 << 13)) === 0 &&
    !occupied.some(
      (u) =>
        Math.hypot(
          game.x(u.tile()) - game.x(tile),
          game.y(u.tile()) - game.y(tile),
        ) < minDistance,
    );
  const inland = [...candidates].filter(available);
  const coast = spatial.coastalSites(round, 16).filter(available);
  /** Owned free sites in rings around an anchor, nearest ring first. */
  const near = (anchor: number, rings = [distance, distance * 2]) => {
    const result: number[] = [];
    for (const r of rings)
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        const x = game.x(anchor) + Math.round(Math.cos(angle) * r),
          y = game.y(anchor) + Math.round(Math.sin(angle) * r);
        if (x < 0 || y < 0 || x >= game.width() || y >= game.height()) continue;
        const tile = y * game.width() + x;
        if (available(tile)) result.push(tile);
      }
    return result;
  };
  const railway = inland.filter((tile) =>
    stations.some(
      (u) =>
        !u.isUnderConstruction() &&
        (u.type() === UnitType.City || u.type() === UnitType.Port) &&
        Math.hypot(
          game.x(u.tile()) - game.x(tile),
          game.y(u.tile()) - game.y(tile),
        ) <= game.config().trainStationMaxRange(),
    ),
  );
  return { inland, coast, railway, near };
}
