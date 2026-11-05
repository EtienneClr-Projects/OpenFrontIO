import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { emptyAdvisor, GameObserver, rawTroops } from "./Observer";
import type { AdvisorSnapshot, RemoteGame } from "./Observer";

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

type WarningType =
  | "OPENFRONT_OVERLAY_FIRST_ENEMY_SILO"
  | "OPENFRONT_OVERLAY_INCOMING_BOAT";

function postWarning(type: WarningType): void {
  window.postMessage({ type }, window.location.origin);
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
    observer = new GameObserver(game, (snapshot, urgent) => {
      advisor = snapshot;
      if (!snapshot.enabled) requestedEnabled = false;
      if (urgent) publish();
    });
    observer.setEnabled(true);
    advisor = observer.snapshot;
  };

  const readEnemySilos = (): EnemySiloMarker[] => {
    let missileSilos: EnemySiloMarker[] = [];
    try {
      if (inGame && game) {
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
      if (inGame && game) {
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
              typeof owner.isAlive !== "function"
            ) {
              throw new Error("Missing transport owner data.");
            }
            if (
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
    if (stopped || !inGame || !game || !hasEnemySilos || siloFrame !== null)
      return;
    siloFrame = window.requestAnimationFrame(() => {
      siloFrame = null;
      if (!inGame || !game || stopped) return;
      publishSiloMarkers();
      scheduleSiloFrame();
    });
  };
  const poll = () => {
    discover();
    enableObserver();
    observer?.poll();
    warnIncomingBoats();
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
