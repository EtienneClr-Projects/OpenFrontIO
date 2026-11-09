import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { emptyAdvisor, GameObserver, rawTroops, sameTeam } from "./Observer";
import type { AdvisorSnapshot, RemoteGame, RemotePlayer } from "./Observer";

interface RemoteTransformHandler {
  scale: number;
  worldToScreenCoordinates(cell: { x: number; y: number }): {
    x: number;
    y: number;
  };
}

interface RemoteBuildMenu extends Element {
  game?: RemoteGame;
  transformHandler?: RemoteTransformHandler;
}

export interface EnemySiloMarker {
  id: number;
  x: number;
  y: number;
  radius: number;
}

// A warship that captured more than this many of our trade ships is a pirate.
const PIRATE_CAPTURE_THRESHOLD = 10;
// Max manhattan distance between a stolen trade ship and the warship that
// stole it, to cover movement between two polls.
const PIRATE_ATTRIBUTION_RANGE = 25;

// A player holding at least this much gold can afford several nukes/MIRVs.
const RICH_GOLD_THRESHOLD = 25_000_000n;
const MAX_WARNED_PLAYER_NAMES = 5;
const ABANDONED_MAX_RADIUS = 400;

interface RemoteRichCandidate extends RemotePlayer {
  gold(): bigint | number;
  nameLocation(): { x: number; y: number; size: number } | undefined;
}

interface NamedPlayer {
  id: number;
  name: string;
}

type WarningType =
  | "OPENFRONT_OVERLAY_FIRST_ENEMY_SILO"
  | "OPENFRONT_OVERLAY_INCOMING_BOAT"
  | "OPENFRONT_OVERLAY_PIRATE_ALERT"
  | "OPENFRONT_OVERLAY_RICH_PLAYER"
  | "OPENFRONT_OVERLAY_ABANDONED_RICH_PLAYER"
  | "OPENFRONT_OVERLAY_INACTIVE_NEIGHBOR"
  | "OPENFRONT_OVERLAY_TRAITOR_NEIGHBOR";

function postWarning(type: WarningType, playerNames?: string[]): void {
  window.postMessage(
    playerNames ? { type, playerNames } : { type },
    window.location.origin,
  );
}

declare global {
  interface Window {
    __openfrontOverlayBridgeStarted?: boolean;
  }
}

export function isControl(data: unknown): data is {
  type: "OPENFRONT_OVERLAY_CONTROL";
  enabled: boolean;
  requestId?: number;
} {
  if (!data || typeof data !== "object") return false;
  const value = data as Record<string, unknown>;
  return (
    Object.keys(value).every((key) =>
      ["type", "enabled", "requestId"].includes(key),
    ) &&
    value.type === "OPENFRONT_OVERLAY_CONTROL" &&
    typeof value.enabled === "boolean" &&
    (value.requestId === undefined ||
      (Number.isSafeInteger(value.requestId) && Number(value.requestId) > 0))
  );
}

export function startBridge(): () => void {
  let game: RemoteGame | null = null;
  let buildMenu: RemoteBuildMenu | null = null;
  let observer: GameObserver | null = null;
  let advisor: AdvisorSnapshot = emptyAdvisor();
  let stopped = false;
  let inGame = false;
  let lastError: string | null = null;
  let lastSiloError: string | null = null;
  let lastBoatError: string | null = null;
  let incomingBoatIds = new Set<number>();
  let lastPirateError: string | null = null;
  let myTradeShipIds = new Set<number>();
  let tradeShipHunters = new Map<number, number>();
  let pirateCounts = new Map<number, number>();
  let lastPirateSignature: string | null = "[]";
  let hasPirates = false;
  let lastRichError: string | null = null;
  let lastNeighborError: string | null = null;
  let warnedInactiveNeighborIds = new Set<number>();
  let pendingTraitors = new Set<number>();
  let observedTraitors = new Set<number>();
  let richPlayers: NamedPlayer[] | null = [];
  let traitorNeighbors: NamedPlayer[] | null = [];
  let lastTraitorError: string | null = null;
  let warnedRichIds = new Set<number>();
  let warnedAbandonedIds = new Set<number>();
  let abandonedRichPlayers: RemoteRichCandidate[] = [];
  let lastAbandonedSignature: string | null = "[]";
  let hasAbandoned = false;
  let lastSiloSignature: string | null = null;
  let hasEnemySilos = false;
  let hasWarnedFirstEnemySilo = false;
  let discoveryError: Error | null = null;
  let requestedEnabled = false;
  let controlId = 0;
  let siloFrame: number | null = null;

  const discover = () => {
    try {
      readDiscovery();
      discoveryError = null;
    } catch (error) {
      observer?.dispose();
      observer = null;
      game = null;
      requestedEnabled = false;
      discoveryError = new Error(
        `Cannot discover GameView: ${error instanceof Error ? error.message : String(error)}`,
      );
      advisor = {
        ...emptyAdvisor("error"),
        error: discoveryError.message.slice(0, 240),
      };
    }
  };

  const readDiscovery = () => {
    const playing = !!document.body?.classList.contains("in-game");
    const foundMenu = playing
      ? (document.querySelector("build-menu") as RemoteBuildMenu | null)
      : null;
    const found = foundMenu?.game ?? null;
    if (found !== game || playing !== inGame) {
      if (!playing || playing !== inGame || game !== null) {
        requestedEnabled = false;
      }
      observer?.dispose();
      observer = null;
      game = found;
      buildMenu = foundMenu;
      inGame = playing;
      lastSiloError = null;
      lastBoatError = null;
      incomingBoatIds = new Set();
      lastPirateError = null;
      myTradeShipIds = new Set();
      tradeShipHunters = new Map();
      pirateCounts = new Map();
      lastPirateSignature = "[]";
      hasPirates = false;
      lastRichError = null;
      lastNeighborError = null;
      warnedInactiveNeighborIds = new Set();
      pendingTraitors = new Set();
      observedTraitors = new Set();
      richPlayers = [];
      traitorNeighbors = [];
      lastTraitorError = null;
      warnedRichIds = new Set();
      warnedAbandonedIds = new Set();
      abandonedRichPlayers = [];
      lastAbandonedSignature = "[]";
      hasAbandoned = false;
      lastSiloSignature = null;
      hasEnemySilos = false;
      hasWarnedFirstEnemySilo = false;
      advisor = emptyAdvisor(
        requestedEnabled ? "waiting" : "disabled",
        requestedEnabled,
      );
    } else {
      buildMenu = foundMenu;
    }
  };

  const enableObserver = () => {
    if (!game || observer || !requestedEnabled) return;
    observer = new GameObserver(
      game,
      (snapshot, urgent) => {
        advisor = snapshot;
        if (!snapshot.enabled) requestedEnabled = false;
        if (urgent) publish();
      },
      undefined,
      undefined,
      collectBetrayals,
    );
    observer.setEnabled(true);
    advisor = observer.snapshot;
  };

  const collectBetrayals = (args: unknown[]) => {
    try {
      if (!game || !requestedEnabled || game.isCatchingUp()) return;
      const update = args[0];
      if (!update || typeof update !== "object" || !("updates" in update))
        throw new Error("Missing GameView update data.");
      const updates = update.updates;
      if (!updates || typeof updates !== "object")
        throw new Error("Invalid GameView updates.");
      const breaks = (updates as Record<number, unknown>)[
        GameUpdateType.BrokeAlliance
      ];
      if (breaks === undefined) {
        lastTraitorError = null;
        return;
      }
      if (!Array.isArray(breaks))
        throw new Error("Invalid alliance break updates.");
      if (breaks.length === 0) {
        lastTraitorError = null;
        return;
      }
      const me = game.myPlayer();
      if (!me) return;
      const players = new Map(game.players().map((p) => [p.smallID(), p]));
      for (const entry of breaks) {
        if (
          !entry ||
          typeof entry !== "object" ||
          !Number.isSafeInteger(entry.traitorID) ||
          !Number.isSafeInteger(entry.betrayedID)
        )
          throw new Error("Invalid alliance break update.");
        if (entry.betrayedID === me.smallID()) {
          pendingTraitors.delete(entry.traitorID);
          observedTraitors.delete(entry.traitorID);
          continue;
        }
        const traitor = players.get(entry.traitorID);
        const betrayed = players.get(entry.betrayedID);
        if (
          !traitor ||
          !betrayed ||
          typeof traitor.isTraitor !== "function" ||
          typeof betrayed.isTraitor !== "function" ||
          typeof betrayed.state?.isDisconnected !== "boolean"
        )
          throw new Error("Missing betrayal player data.");
        // Breaking an alliance with a traitor or disconnected player does not
        // apply a debuff, even though it produces the same event.
        if (
          traitor.isTraitor() &&
          !betrayed.isTraitor() &&
          !betrayed.state.isDisconnected
        ) {
          pendingTraitors.add(entry.traitorID);
          observedTraitors.add(entry.traitorID);
        }
      }
      lastTraitorError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastTraitorError) {
        console.error("[OpenFront Overlay] Cannot read betrayals:", error);
        lastTraitorError = message;
      }
    }
  };

  const warnTraitorNeighbors = () => {
    if (!requestedEnabled || !game || !inGame) {
      pendingTraitors.clear();
      observedTraitors.clear();
      traitorNeighbors = [];
      return;
    }
    const fronts = observer?.frontOwnerIds();
    traitorNeighbors = null;
    if (!fronts) return;
    try {
      const me = game.myPlayer();
      if (!me) return;
      const frontIds = new Set(fronts);
      const names: string[] = [];
      const current: NamedPlayer[] = [];
      const stillTraitors = new Set<number>();
      for (const candidate of game.players()) {
        const id = candidate.smallID();
        if (!observedTraitors.has(id)) continue;
        if (!candidate.isAlive() || !candidate.isTraitor()) continue;
        stillTraitors.add(id);
        if (
          frontIds.has(id) &&
          id !== me.smallID() &&
          !sameTeam(me.team(), candidate.team())
        ) {
          const name = candidate.displayName().slice(0, 200);
          current.push({ id, name });
          if (pendingTraitors.has(id)) names.push(name);
        }
      }
      observedTraitors = stillTraitors;
      traitorNeighbors = current.sort((a, b) => a.id - b.id);
      pendingTraitors.clear();
      if (names.length)
        postWarning(
          "OPENFRONT_OVERLAY_TRAITOR_NEIGHBOR",
          names.slice(0, MAX_WARNED_PLAYER_NAMES),
        );
    } catch (error) {
      console.error(
        "[OpenFront Overlay] Cannot read traitor neighbors:",
        error,
      );
      pendingTraitors.clear();
    }
  };

  const readEnemySilos = (): EnemySiloMarker[] => {
    let missileSilos: EnemySiloMarker[] = [];
    try {
      if (inGame && game && requestedEnabled) {
        const currentGame = game;
        if (typeof currentGame.myPlayer !== "function")
          throw new Error("Missing GameView.myPlayer().");
        const player = currentGame.myPlayer();
        if (!player) {
          hasEnemySilos = false;
          return missileSilos;
        }
        const transform = buildMenu?.transformHandler;
        if (
          !transform ||
          typeof transform.worldToScreenCoordinates !== "function" ||
          !Number.isFinite(transform.scale) ||
          transform.scale <= 0
        ) {
          throw new Error("Missing BuildMenu.transformHandler.");
        }
        if (
          typeof currentGame.units !== "function" ||
          typeof currentGame.x !== "function" ||
          typeof currentGame.y !== "function" ||
          typeof player.smallID !== "function" ||
          typeof player.isFriendly !== "function"
        ) {
          throw new Error("Missing GameView unit coordinates.");
        }
        const units = currentGame.units(UnitType.MissileSilo);
        if (!Array.isArray(units)) throw new Error("Invalid GameView units.");
        missileSilos = [];
        for (const unit of units) {
          if (typeof unit.isActive !== "function")
            throw new Error("Missing unit.isActive().");
          if (!unit.isActive()) continue;
          if (
            typeof unit.id !== "function" ||
            typeof unit.owner !== "function" ||
            typeof unit.tile !== "function"
          ) {
            throw new Error("Missing enemy silo data.");
          }
          const owner = unit.owner();
          if (
            !owner ||
            typeof owner.smallID !== "function" ||
            typeof owner.isAlive !== "function"
          ) {
            throw new Error("Missing enemy silo owner data.");
          }
          const ownerID = owner.smallID();
          if (!Number.isSafeInteger(ownerID))
            throw new Error("Invalid enemy silo owner.");
          if (
            !owner.isAlive() ||
            ownerID === player.smallID() ||
            player.isFriendly(owner)
          ) {
            continue;
          }
          const tile = unit.tile();
          if (!Number.isSafeInteger(tile) || tile < 0)
            throw new Error("Invalid enemy silo tile.");
          const world = {
            x: currentGame.x(tile) + 0.5,
            y: currentGame.y(tile) + 0.5,
          };
          const screen = transform.worldToScreenCoordinates(world);
          const marker = {
            id: unit.id(),
            x: screen.x,
            y: screen.y,
            radius: Math.max(12, Math.min(42, transform.scale * 1.7)),
          };
          if (
            !Number.isSafeInteger(marker.id) ||
            !Number.isFinite(marker.x) ||
            !Number.isFinite(marker.y)
          ) {
            throw new Error("Invalid enemy silo position.");
          }
          missileSilos.push(marker);
        }
      }
      lastSiloError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastSiloError) {
        console.error(
          "[OpenFront Overlay] Cannot read enemy silo positions:",
          error,
        );
        lastSiloError = message;
      }
    }
    hasEnemySilos = missileSilos.length > 0;
    if (hasEnemySilos && !hasWarnedFirstEnemySilo) {
      hasWarnedFirstEnemySilo = true;
      postWarning("OPENFRONT_OVERLAY_FIRST_ENEMY_SILO");
    }
    return missileSilos;
  };

  const warnIncomingBoats = () => {
    if (stopped) return;
    const current = new Set<number>();
    let hasNew = false;
    try {
      if (inGame && game && requestedEnabled) {
        const currentGame = game;
        const player = currentGame.myPlayer?.();
        if (player) {
          if (
            typeof currentGame.units !== "function" ||
            typeof currentGame.ownerID !== "function" ||
            typeof player.smallID !== "function" ||
            typeof player.isFriendly !== "function"
          ) {
            throw new Error("Missing GameView transport data.");
          }
          const units = currentGame.units(UnitType.TransportShip);
          if (!Array.isArray(units)) throw new Error("Invalid GameView units.");
          const myID = player.smallID();
          for (const unit of units) {
            if (
              typeof unit.isActive !== "function" ||
              typeof unit.id !== "function" ||
              typeof unit.owner !== "function" ||
              typeof unit.targetTile !== "function"
            ) {
              throw new Error("Missing transport unit data.");
            }
            if (!unit.isActive() || unit.state?.retreating !== false) continue;
            const owner = unit.owner();
            if (
              !owner ||
              typeof owner.smallID !== "function" ||
              typeof owner.isAlive !== "function" ||
              typeof owner.type !== "function"
            ) {
              throw new Error("Missing transport owner data.");
            }
            if (
              owner.type() === PlayerType.Bot ||
              !owner.isAlive() ||
              owner.smallID() === myID ||
              player.isFriendly(owner)
            ) {
              continue;
            }
            const target = unit.targetTile();
            if (
              target === undefined ||
              target === null ||
              !Number.isSafeInteger(target) ||
              currentGame.ownerID(target) !== myID
            ) {
              continue;
            }
            const id = unit.id();
            if (!Number.isSafeInteger(id))
              throw new Error("Invalid transport ID.");
            current.add(id);
            if (!incomingBoatIds.has(id)) hasNew = true;
          }
        }
      }
      lastBoatError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastBoatError) {
        console.error(
          "[OpenFront Overlay] Cannot read incoming transports:",
          error,
        );
        lastBoatError = message;
      }
      return;
    }
    incomingBoatIds = current;
    if (hasNew) postWarning("OPENFRONT_OVERLAY_INCOMING_BOAT");
  };

  const trackPirates = () => {
    if (stopped) return;
    try {
      if (!requestedEnabled) {
        // Ignore ownership changes that happen while minimized.
        myTradeShipIds = new Set();
        tradeShipHunters = new Map();
        return;
      }
      if (!inGame || !game) return;
      const currentGame = game;
      const player = currentGame.myPlayer?.();
      if (!player) return;
      if (
        typeof currentGame.units !== "function" ||
        typeof currentGame.x !== "function" ||
        typeof currentGame.y !== "function" ||
        typeof player.smallID !== "function" ||
        typeof player.isFriendly !== "function"
      ) {
        throw new Error("Missing GameView trade ship data.");
      }
      const myID = player.smallID();
      const ships = currentGame.units(UnitType.TradeShip);
      const warships = currentGame.units(UnitType.Warship);
      if (!Array.isArray(ships) || !Array.isArray(warships)) {
        throw new Error("Invalid GameView units.");
      }
      const activeWarships = new Map<number, (typeof warships)[number]>();
      for (const warship of warships) {
        if (
          typeof warship.isActive !== "function" ||
          typeof warship.id !== "function" ||
          typeof warship.owner !== "function" ||
          typeof warship.tile !== "function"
        ) {
          throw new Error("Missing warship data.");
        }
        if (warship.isActive()) activeWarships.set(warship.id(), warship);
      }
      const distance = (a: number, b: number) =>
        Math.abs(currentGame.x(a) - currentGame.x(b)) +
        Math.abs(currentGame.y(a) - currentGame.y(b));

      const mine = new Set<number>();
      const hunters = new Map<number, number>();
      for (const ship of ships) {
        if (
          typeof ship.isActive !== "function" ||
          typeof ship.id !== "function" ||
          typeof ship.owner !== "function" ||
          typeof ship.tile !== "function"
        ) {
          throw new Error("Missing trade ship data.");
        }
        if (!ship.isActive()) continue;
        const shipID = ship.id();
        const owner = ship.owner();
        if (!owner || typeof owner.smallID !== "function") {
          throw new Error("Missing trade ship owner data.");
        }
        const ownerID = owner.smallID();
        if (ownerID === myID) {
          mine.add(shipID);
          continue;
        }
        if (!myTradeShipIds.has(shipID) || player.isFriendly(owner)) continue;
        // One of our trade ships changed hands: find the warship that took it.
        let pirate = activeWarships.get(tradeShipHunters.get(shipID) ?? -1);
        if (pirate?.owner().smallID() !== ownerID) {
          pirate = undefined;
          let best = PIRATE_ATTRIBUTION_RANGE + 1;
          for (const warship of activeWarships.values()) {
            if (warship.owner().smallID() !== ownerID) continue;
            const d = distance(warship.tile(), ship.tile());
            if (d < best) {
              best = d;
              pirate = warship;
            }
          }
        }
        if (!pirate) continue;
        const pirateID = pirate.id();
        const count = (pirateCounts.get(pirateID) ?? 0) + 1;
        pirateCounts.set(pirateID, count);
        if (count === PIRATE_CAPTURE_THRESHOLD + 1) {
          postWarning("OPENFRONT_OVERLAY_PIRATE_ALERT");
        }
      }
      // Remember who is chasing each of our ships: the target is cleared the
      // moment the ship is captured.
      for (const warship of activeWarships.values()) {
        const targetID = warship.targetUnitId?.();
        if (
          targetID !== undefined &&
          mine.has(targetID) &&
          warship.owner().smallID() !== myID
        ) {
          hunters.set(targetID, warship.id());
        }
      }
      myTradeShipIds = mine;
      tradeShipHunters = hunters;
      lastPirateError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastPirateError) {
        console.error("[OpenFront Overlay] Cannot track pirates:", error);
        lastPirateError = message;
      }
    }
  };

  const readPirateMarkers = (): EnemySiloMarker[] => {
    const markers: EnemySiloMarker[] = [];
    try {
      if (inGame && game && requestedEnabled && pirateCounts.size > 0) {
        const currentGame = game;
        const transform = buildMenu?.transformHandler;
        if (
          !transform ||
          typeof transform.worldToScreenCoordinates !== "function" ||
          !Number.isFinite(transform.scale) ||
          transform.scale <= 0
        ) {
          throw new Error("Missing BuildMenu.transformHandler.");
        }
        for (const warship of currentGame.units(UnitType.Warship)) {
          const id = warship.id();
          if (
            !warship.isActive() ||
            (pirateCounts.get(id) ?? 0) <= PIRATE_CAPTURE_THRESHOLD
          ) {
            continue;
          }
          const tile = warship.tile();
          const screen = transform.worldToScreenCoordinates({
            x: currentGame.x(tile) + 0.5,
            y: currentGame.y(tile) + 0.5,
          });
          if (
            !Number.isSafeInteger(id) ||
            !Number.isFinite(screen.x) ||
            !Number.isFinite(screen.y)
          ) {
            throw new Error("Invalid pirate warship position.");
          }
          markers.push({
            id,
            x: screen.x,
            y: screen.y,
            radius: Math.max(12, Math.min(42, transform.scale * 1.7)),
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastPirateError) {
        console.error(
          "[OpenFront Overlay] Cannot read pirate warship positions:",
          error,
        );
        lastPirateError = message;
      }
    }
    hasPirates = markers.length > 0;
    return markers;
  };

  const publishPirateMarkers = (force = false) => {
    if (stopped) return;
    const pirateWarships = readPirateMarkers();
    const signature = JSON.stringify(pirateWarships);
    if (!force && signature === lastPirateSignature) return;
    lastPirateSignature = signature;
    window.postMessage(
      { type: "OPENFRONT_OVERLAY_PIRATE_WARSHIPS", pirateWarships },
      window.location.origin,
    );
  };

  const scanRichPlayers = () => {
    if (stopped) return;
    richPlayers = null;
    const richIds = new Set<number>();
    const abandonedIds = new Set<number>();
    const richNames: string[] = [];
    const abandonedNames: string[] = [];
    const abandoned: RemoteRichCandidate[] = [];
    const current: NamedPlayer[] = [];
    try {
      if (inGame && game && requestedEnabled) {
        const me = game.myPlayer();
        if (me) {
          for (const candidate of game.players() as RemoteRichCandidate[]) {
            if (
              typeof candidate.gold !== "function" ||
              typeof candidate.smallID !== "function" ||
              typeof candidate.isAlive !== "function" ||
              typeof candidate.type !== "function" ||
              typeof candidate.isFriendly !== "function" ||
              typeof candidate.displayName !== "function"
            ) {
              throw new Error("Missing player gold data.");
            }
            if (
              !candidate.isAlive() ||
              candidate.type() === PlayerType.Bot ||
              candidate.smallID() === me.smallID() ||
              sameTeam(me.team(), candidate.team())
            ) {
              continue;
            }
            const gold = candidate.gold();
            if (typeof gold !== "bigint" && typeof gold !== "number")
              throw new Error("Invalid player gold.");
            if (BigInt(Math.floor(Number(gold))) < RICH_GOLD_THRESHOLD) {
              continue;
            }
            const id = candidate.smallID();
            current.push({ id, name: candidate.displayName().slice(0, 200) });
            if (typeof candidate.state?.isDisconnected !== "boolean")
              throw new Error("Missing player disconnection state.");
            if (candidate.state.isDisconnected) {
              abandonedIds.add(id);
              abandoned.push(candidate);
              if (!warnedAbandonedIds.has(id))
                abandonedNames.push(candidate.displayName());
            } else {
              richIds.add(id);
              if (!warnedRichIds.has(id))
                richNames.push(candidate.displayName());
            }
          }
        }
      }
      lastRichError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastRichError) {
        console.error("[OpenFront Overlay] Cannot read player gold:", error);
        lastRichError = message;
      }
      return;
    }
    warnedRichIds = richIds;
    richPlayers = current.sort((a, b) => a.id - b.id);
    warnedAbandonedIds = abandonedIds;
    abandonedRichPlayers = abandoned;
    if (abandonedNames.length > 0)
      postWarning(
        "OPENFRONT_OVERLAY_ABANDONED_RICH_PLAYER",
        abandonedNames.slice(0, MAX_WARNED_PLAYER_NAMES),
      );
    if (richNames.length > 0)
      postWarning(
        "OPENFRONT_OVERLAY_RICH_PLAYER",
        richNames.slice(0, MAX_WARNED_PLAYER_NAMES),
      );
  };

  const scanInactiveNeighbors = () => {
    if (stopped) return;
    const frontIds =
      inGame && game && requestedEnabled ? observer?.frontOwnerIds() : null;
    if (!frontIds) {
      if (!requestedEnabled) warnedInactiveNeighborIds = new Set();
      return;
    }
    const inactiveIds = new Set<number>();
    const names: string[] = [];
    try {
      const me = game!.myPlayer();
      if (me) {
        const fronts = new Set(frontIds);
        for (const candidate of game!.players()) {
          if (
            typeof candidate.smallID !== "function" ||
            typeof candidate.isAlive !== "function" ||
            typeof candidate.isFriendly !== "function" ||
            typeof candidate.displayName !== "function"
          ) {
            throw new Error("Missing neighbor data.");
          }
          const id = candidate.smallID();
          if (
            !fronts.has(id) ||
            id === me.smallID() ||
            !candidate.isAlive() ||
            me.isFriendly(candidate)
          ) {
            continue;
          }
          if (typeof candidate.state?.isDisconnected !== "boolean")
            throw new Error("Missing player disconnection state.");
          if (!candidate.state.isDisconnected) continue;
          inactiveIds.add(id);
          if (!warnedInactiveNeighborIds.has(id))
            names.push(candidate.displayName());
        }
      }
      lastNeighborError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastNeighborError) {
        console.error(
          "[OpenFront Overlay] Cannot read inactive neighbors:",
          error,
        );
        lastNeighborError = message;
      }
      return;
    }
    warnedInactiveNeighborIds = inactiveIds;
    if (names.length > 0)
      postWarning(
        "OPENFRONT_OVERLAY_INACTIVE_NEIGHBOR",
        names.slice(0, MAX_WARNED_PLAYER_NAMES),
      );
  };

  const readAbandonedMarkers = (): EnemySiloMarker[] => {
    const markers: EnemySiloMarker[] = [];
    try {
      if (
        inGame &&
        game &&
        requestedEnabled &&
        abandonedRichPlayers.length > 0
      ) {
        const transform = buildMenu?.transformHandler;
        if (
          !transform ||
          typeof transform.worldToScreenCoordinates !== "function" ||
          !Number.isFinite(transform.scale) ||
          transform.scale <= 0
        ) {
          throw new Error("Missing BuildMenu.transformHandler.");
        }
        for (const player of abandonedRichPlayers) {
          const location = player.nameLocation?.();
          if (!location) continue;
          const screen = transform.worldToScreenCoordinates({
            x: location.x + 0.5,
            y: location.y + 0.5,
          });
          const id = player.smallID();
          const tiles = player.numTilesOwned();
          if (
            !Number.isSafeInteger(id) ||
            !Number.isFinite(tiles) ||
            !Number.isFinite(screen.x) ||
            !Number.isFinite(screen.y)
          ) {
            throw new Error("Invalid abandoned territory position.");
          }
          markers.push({
            id,
            x: screen.x,
            y: screen.y,
            // Radius of a disc covering the same area as the territory.
            radius: Math.max(
              16,
              Math.min(
                ABANDONED_MAX_RADIUS,
                Math.sqrt(tiles / Math.PI) * transform.scale,
              ),
            ),
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastRichError) {
        console.error(
          "[OpenFront Overlay] Cannot read abandoned territory positions:",
          error,
        );
        lastRichError = message;
      }
    }
    hasAbandoned = markers.length > 0;
    return markers;
  };

  const publishAbandonedMarkers = (force = false) => {
    if (stopped) return;
    const abandonedPlayers = readAbandonedMarkers();
    const signature = JSON.stringify(abandonedPlayers);
    if (!force && signature === lastAbandonedSignature) return;
    lastAbandonedSignature = signature;
    window.postMessage(
      { type: "OPENFRONT_OVERLAY_ABANDONED_TERRITORIES", abandonedPlayers },
      window.location.origin,
    );
  };

  const publishSiloMarkers = (force = false) => {
    if (stopped) return;
    const missileSilos = readEnemySilos();
    const signature = JSON.stringify(missileSilos);
    if (!force && signature === lastSiloSignature) return;
    lastSiloSignature = signature;
    window.postMessage(
      { type: "OPENFRONT_OVERLAY_SILOS", missileSilos },
      window.location.origin,
    );
  };

  const publish = () => {
    if (stopped) return;
    publishPirateMarkers();
    publishAbandonedMarkers();
    let status: "idle" | "waiting" | "playing" | "unavailable" = "idle";
    let troops: number | null = null;
    try {
      if (discoveryError) throw discoveryError;
      if (inGame) {
        status = "waiting";
        if (game) {
          if (typeof game.myPlayer !== "function")
            throw new Error("Missing myPlayer().");
          const me = game.myPlayer();
          if (me) {
            if (typeof me.troops !== "function")
              throw new Error("Missing player.troops().");
            troops = rawTroops(me.troops());
            status = "playing";
          }
        }
      }
      lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) {
        console.error("[OpenFront Overlay] Cannot read game state:", error);
        lastError = message;
      }
      status = "unavailable";
    }
    const missileSilos = readEnemySilos();
    lastSiloSignature = JSON.stringify(missileSilos);
    window.postMessage(
      {
        type: "OPENFRONT_OVERLAY_STATE",
        status,
        troops,
        advisor,
        controlId,
        missileSilos,
        playerLists: {
          richPlayers: requestedEnabled ? richPlayers : [],
          traitorNeighbors: requestedEnabled ? traitorNeighbors : [],
        },
      },
      window.location.origin,
    );
  };

  const control = (event: MessageEvent) => {
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      !isControl(event.data)
    )
      return;
    discover();
    controlId = event.data.requestId ?? controlId;
    requestedEnabled = inGame && !discoveryError && event.data.enabled;
    pendingTraitors.clear();
    observedTraitors.clear();
    richPlayers = [];
    traitorNeighbors = [];
    if (!game) {
      if (!discoveryError) {
        advisor = emptyAdvisor(
          requestedEnabled ? "waiting" : "disabled",
          requestedEnabled,
        );
      }
      publish();
      return;
    }
    observer?.dispose();
    observer = null;
    advisor = emptyAdvisor();
    enableObserver();
    publish();
  };
  const scheduleSiloFrame = () => {
    if (
      stopped ||
      !inGame ||
      !game ||
      !(hasEnemySilos || hasPirates || hasAbandoned) ||
      siloFrame !== null
    )
      return;
    siloFrame = window.requestAnimationFrame(() => {
      siloFrame = null;
      if (!inGame || !game || stopped) return;
      publishSiloMarkers();
      publishPirateMarkers();
      publishAbandonedMarkers();
      scheduleSiloFrame();
    });
  };
  const poll = () => {
    discover();
    enableObserver();
    observer?.poll();
    warnIncomingBoats();
    trackPirates();
    scanRichPlayers();
    scanInactiveNeighbors();
    warnTraitorNeighbors();
    publish();
    scheduleSiloFrame();
  };
  const stop = () => {
    stopped = true;
    observer?.dispose();
    window.clearInterval(timer);
    if (siloFrame !== null) window.cancelAnimationFrame(siloFrame);
    window.removeEventListener("message", control);
    window.removeEventListener("pagehide", stop);
    window.__openfrontOverlayBridgeStarted = false;
  };
  window.addEventListener("message", control);
  window.addEventListener("pagehide", stop);
  poll();
  const timer = window.setInterval(poll, 500);
  return stop;
}

if (typeof window !== "undefined" && !window.__openfrontOverlayBridgeStarted) {
  window.__openfrontOverlayBridgeStarted = true;
  startBridge();
}
