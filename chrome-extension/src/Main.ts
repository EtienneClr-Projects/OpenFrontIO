import { emptyAdvisor, GameObserver, rawTroops } from "./Observer";
import type { AdvisorSnapshot, RemoteGame } from "./Observer";

declare global {
  interface Window {
    __openfrontOverlayBridgeStarted?: boolean;
  }
}

export function isControl(
  data: unknown,
): data is { type: "OPENFRONT_OVERLAY_CONTROL"; enabled: boolean } {
  if (!data || typeof data !== "object") return false;
  const value = data as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    value.type === "OPENFRONT_OVERLAY_CONTROL" &&
    typeof value.enabled === "boolean"
  );
}

export function startBridge(): () => void {
  let game: RemoteGame | null = null;
  let observer: GameObserver | null = null;
  let advisor: AdvisorSnapshot = emptyAdvisor();
  let stopped = false;
  let inGame = false;
  let lastError: string | null = null;
  let discoveryError: Error | null = null;

  const discover = () => {
    try {
      readDiscovery();
      discoveryError = null;
    } catch (error) {
      observer?.dispose();
      observer = null;
      game = null;
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
    const found = playing
      ? ((
          document.querySelector("build-menu") as
            | (Element & { game?: RemoteGame })
            | null
        )?.game ?? null)
      : null;
    if (found !== game || playing !== inGame) {
      observer?.dispose();
      observer = null;
      game = found;
      inGame = playing;
      advisor = emptyAdvisor();
    }
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
    window.postMessage(
      { type: "OPENFRONT_OVERLAY_STATE", status, troops, advisor },
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
    if (!game) {
      publish();
      return;
    }
    observer ??= new GameObserver(game, (snapshot, urgent) => {
      advisor = snapshot;
      if (urgent) publish();
    });
    observer.setEnabled(event.data.enabled);
    advisor = observer.snapshot;
    publish();
  };
  const poll = () => {
    discover();
    observer?.poll();
    publish();
  };
  const stop = () => {
    stopped = true;
    observer?.dispose();
    window.clearInterval(timer);
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
