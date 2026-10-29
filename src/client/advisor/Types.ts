import type {
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";

export interface AdvisorPlayer {
  id: number;
  name: string;
  type: PlayerType;
  team: string | null;
  alive: boolean;
  disconnected: boolean;
  friendly: boolean;
  tiles: number;
  troops: number;
  incoming: number;
  outgoing: number;
  traitor: boolean;
  doomed: boolean;
  alliances: { id: number; name: string; remaining: number }[];
}

export interface AdvisorUnit {
  id: number;
  owner: number;
  type: UnitType;
  tile: number;
  target: number | null;
  active: boolean;
  retreating: boolean;
  constructing: boolean;
  level: number;
  ready: number;
  range: number;
  troops: number;
  arrivalTick: number | null;
}

export interface BuildAdvice {
  type: UnitType;
  tile: number;
  cost: bigint;
  affordable: boolean;
  connected: boolean;
}

export interface AdvisorObservation {
  tick: number;
  elapsed: number;
  myID: number;
  players: AdvisorPlayer[];
  units: AdvisorUnit[];
  cap: number;
  growth: number;
  gold: bigint;
  builds: BuildAdvice[];
  queryState: "checking" | "ready" | "error";
  attackable: ReadonlySet<number>;
  landShare: number;
  winShare: number;
  clockEnabled: boolean;
}

export type AdviceContext =
  | "opening"
  | "economy"
  | "contested"
  | "nuclear"
  | "endgame";

export interface Recommendation {
  id: string;
  rule: string;
  priority: number;
  confidence: "observed" | "estimate";
  params: Record<string, string | number>;
  tile?: number;
  firstTick: number;
  lastTick: number;
}

export interface AdvisorResult {
  context: AdviceContext;
  items: Recommendation[];
}

export interface AdvisorMap {
  width(): number;
  height(): number;
  ownerID(tile: number): number;
  isLand(tile: number): boolean;
  isImpassable(tile: number): boolean;
  terrainByte(tile: number): number;
  tileState(tile: number): number;
}
