import type { AdvisorMap } from "./Types";

/** Retain frontiers, coasts and sparse build sites, not a second full map. */
export class SpatialIndex {
  readonly fronts = new Map<number, Set<number>>();
  readonly coast = new Set<number>();
  readonly sites = new Set<number>();
  private readonly landingCoasts = new Map<number, Set<number>>();
  private readonly landingOwners = new Map<number, number>();
  private readonly frontierOwners = new Map<number, number>();
  private readonly coastCells = new Map<number, Set<number>>();
  private readonly scratch = new Set<number>();
  private cursor = 0;
  private readonly width: number;
  private readonly size: number;
  private readonly columns: number;

  constructor(
    private readonly map: AdvisorMap,
    private readonly myID: number,
  ) {
    this.width = map.width();
    this.size = this.width * map.height();
    this.columns = Math.ceil(this.width / 64);
  }

  get ready(): boolean {
    return this.cursor === this.size;
  }

  /** Bounded baseline work; callers choose how many tiles fit their budget. */
  initialize(count = 8192): void {
    const end = Math.min(this.size, this.cursor + count);
    for (; this.cursor < end; this.cursor++) this.refresh(this.cursor);
  }

  ingest(changed: readonly number[]): void {
    this.scratch.clear();
    for (const tile of changed) {
      this.scratch.add(tile);
      this.neighbors(tile, (n) => this.scratch.add(n));
    }
    for (const tile of this.scratch) this.refresh(tile);
  }

  private neighbors(tile: number, visit: (n: number) => void): void {
    const x = tile % this.width;
    if (tile >= this.width) visit(tile - this.width);
    if (tile + this.width < this.size) visit(tile + this.width);
    if (x > 0) visit(tile - 1);
    if (x + 1 < this.width) visit(tile + 1);
  }

  private cell(tile: number): number {
    return (
      Math.floor((tile % this.width) / 64) +
      Math.floor(tile / this.width / 64) * this.columns
    );
  }

  private refresh(tile: number): void {
    this.sites.delete(tile);
    const oldLandingOwner = this.landingOwners.get(tile);
    if (oldLandingOwner !== undefined) {
      const coast = this.landingCoasts.get(oldLandingOwner)!;
      coast.delete(tile);
      if (coast.size === 0) this.landingCoasts.delete(oldLandingOwner);
      this.landingOwners.delete(tile);
    }
    const oldOwner = this.frontierOwners.get(tile);
    if (oldOwner !== undefined) {
      const front = this.fronts.get(oldOwner)!;
      front.delete(tile);
      if (front.size === 0) this.fronts.delete(oldOwner);
      this.frontierOwners.delete(tile);
    }
    if (this.coast.delete(tile)) {
      const cell = this.cell(tile);
      const entries = this.coastCells.get(cell)!;
      entries.delete(tile);
      if (entries.size === 0) this.coastCells.delete(cell);
    }
    if (!this.map.isLand(tile) || this.map.isImpassable(tile)) return;
    const owner = this.map.ownerID(tile);
    if (
      owner === this.myID &&
      (tile % this.width) % 16 === 0 &&
      Math.floor(tile / this.width) % 16 === 0 &&
      (this.map.tileState(tile) & (1 << 13)) === 0
    )
      this.sites.add(tile);
    let ownNeighbor = false;
    let waterNeighbor = false;
    this.neighbors(tile, (n) => {
      if (this.map.ownerID(n) === this.myID && this.map.isLand(n)) {
        ownNeighbor = true;
      }
      if (!this.map.isLand(n)) waterNeighbor = true;
    });
    if (owner !== this.myID && ownNeighbor) {
      let front = this.fronts.get(owner);
      if (!front) this.fronts.set(owner, (front = new Set()));
      front.add(tile);
      this.frontierOwners.set(tile, owner);
    }
    if (owner === this.myID && waterNeighbor) {
      this.coast.add(tile);
      const cell = this.cell(tile);
      let entries = this.coastCells.get(cell);
      if (!entries) this.coastCells.set(cell, (entries = new Set()));
      entries.add(tile);
    } else if (
      owner !== this.myID &&
      waterNeighbor &&
      (this.map.tileState(tile) & (1 << 13)) === 0
    ) {
      let coast = this.landingCoasts.get(owner);
      if (!coast) this.landingCoasts.set(owner, (coast = new Set()));
      coast.add(tile);
      this.landingOwners.set(tile, owner);
    }
  }

  landingSites(owner: number, round: number, limit = 3): number[] {
    const coast = [...(this.landingCoasts.get(owner) ?? [])]
      .map((tile) => ({ tile, distance: this.coastDistance(tile) }))
      .sort((a, b) => a.distance - b.distance || a.tile - b.tile);
    const result: number[] = [];
    for (let i = 0; i < Math.min(limit, coast.length); i++)
      result.push(coast[(round * limit + i) % coast.length].tile);
    return result;
  }

  sample(owner: number): number | undefined {
    let best: number | undefined;
    let magnitude = Infinity;
    let count = 0;
    for (const tile of this.fronts.get(owner) ?? []) {
      const m =
        (this.map.terrainByte(tile) & 31) +
        ((this.map.tileState(tile) & (1 << 13)) !== 0 ? 100 : 0);
      if (m < magnitude) {
        best = tile;
        magnitude = m;
      }

      if (++count === 32) break;
    }
    return best;
  }

  coastalSites(round: number, limit = 8): number[] {
    const cells = [...this.coastCells.values()];
    if (cells.length === 0) return [];
    const result: number[] = [];
    for (let i = 0; i < Math.min(limit, cells.length); i++) {
      const entries = cells[(round + i) % cells.length];
      const offset = round % Math.min(32, entries.size);
      let index = 0;
      for (const tile of entries) {
        if (index++ === offset) {
          result.push(tile);
          break;
        }
      }
    }
    return result;
  }

  coastDistance(tile: number): number {
    const nearest = this.nearCoast(tile);
    return nearest === undefined
      ? Infinity
      : Math.hypot(
          (nearest % this.width) - (tile % this.width),
          Math.floor(nearest / this.width) - Math.floor(tile / this.width),
        );
  }

  nearCoast(tile: number, radius = Infinity): number | undefined {
    const x = tile % this.width;
    const y = Math.floor(tile / this.width);
    let nearest: number | undefined;
    let distance = radius * radius;
    for (const [cell, entries] of this.coastCells) {
      const left = (cell % this.columns) * 64;
      const top = Math.floor(cell / this.columns) * 64;
      const dx = Math.max(left - x, 0, x - (left + 63));
      const dy = Math.max(top - y, 0, y - (top + 63));
      if (dx * dx + dy * dy > distance) continue;
      for (const ref of entries) {
        const d =
          ((ref % this.width) - x) ** 2 +
          (Math.floor(ref / this.width) - y) ** 2;
        if (
          d < distance ||
          (d === distance && (nearest === undefined || ref < nearest))
        ) {
          nearest = ref;
          distance = d;
        }
      }
    }
    return nearest;
  }

  /** Test blast overlap against current ownership, including outside targets. */
  blastTouches(tile: number, radius: number): boolean {
    const x = tile % this.width;
    const y = Math.floor(tile / this.width);
    for (
      let yy = Math.max(0, y - radius);
      yy <= Math.min(this.map.height() - 1, y + radius);
      yy++
    ) {
      const span = Math.floor(Math.sqrt(radius ** 2 - (yy - y) ** 2));
      for (
        let xx = Math.max(0, x - span);
        xx <= Math.min(this.width - 1, x + span);
        xx++
      ) {
        const ref = yy * this.width + xx;
        if (this.map.isLand(ref) && this.map.ownerID(ref) === this.myID) {
          return true;
        }
      }
    }
    return false;
  }
}
