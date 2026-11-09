(() => {
  const overlayId = "openfront-advisor-ui";
  const enemySiloWarningId = "openfront-enemy-silo-warning";
  const incomingBoatWarningId = "openfront-incoming-boat-warning";
  const pirateWarningId = "openfront-pirate-warning";
  const richPlayerWarningId = "openfront-rich-player-warning";
  const abandonedRichWarningId = "openfront-abandoned-rich-warning";
  const inactiveNeighborWarningId = "openfront-inactive-neighbor-warning";
  const traitorNeighborWarningId = "openfront-traitor-neighbor-warning";
  const reserveMarkerSelector = '[data-openfront-reserve-marker="42"]';
  let state = { status: "idle", troops: null };
  let findEnemySilos = true;
  let monitorPirates = true;
  let watchRichPlayers = true;
  let watchInactiveNeighbors = true;
  // Each kind of map marker gets its own fixed, click-through layer.
  const markerKinds = {
    silo: {
      layerId: "openfront-enemy-silos",
      datasetKey: "openfrontEnemySilo",
      arrowKey: "openfrontEnemySiloArrow",
      animation: "openfront-silo-pulse",
      color: "#ff8c00",
      glow: "#ff5e00",
      circle: false,
      isEnabled: () => findEnemySilos,
      layer: null,
      elements: new Map(),
    },
    pirate: {
      layerId: "openfront-pirate-warships",
      datasetKey: "openfrontPirateWarship",
      arrowKey: "openfrontPirateWarshipArrow",
      animation: "openfront-pirate-pulse",
      color: "#ef4444",
      glow: "#b91c1c",
      circle: true,
      isEnabled: () => monitorPirates,
      layer: null,
      elements: new Map(),
    },
    abandoned: {
      layerId: "openfront-abandoned-territories",
      datasetKey: "openfrontAbandonedTerritory",
      arrowKey: "openfrontAbandonedTerritoryArrow",
      animation: "openfront-abandoned-pulse",
      color: "#ff8c00",
      glow: "#ff5e00",
      circle: true,
      maxRadius: 400,
      isEnabled: () => watchRichPlayers,
      layer: null,
      elements: new Map(),
    },
  };
  // Warnings naming players: message type -> label, layer id and position.
  const playerWarnings = {
    OPENFRONT_OVERLAY_RICH_PLAYER: {
      id: richPlayerWarningId,
      label: "richPlayerWarning",
      top: "20%",
      isEnabled: () => watchRichPlayers,
    },
    OPENFRONT_OVERLAY_ABANDONED_RICH_PLAYER: {
      id: abandonedRichWarningId,
      label: "abandonedRichPlayerWarning",
      top: "50%",
      isEnabled: () => watchRichPlayers,
    },
    OPENFRONT_OVERLAY_INACTIVE_NEIGHBOR: {
      id: inactiveNeighborWarningId,
      label: "inactiveNeighborWarning",
      top: "80%",
      isEnabled: () => watchInactiveNeighbors,
    },
    OPENFRONT_OVERLAY_TRAITOR_NEIGHBOR: {
      id: traitorNeighborWarningId,
      label: "traitorNeighborWarning",
      top: "35%",
      isEnabled: () => true,
    },
  };
  let hudControlPanel = null;
  let hudBodyObserver = null;
  let hudPanelObserver = null;
  let hudPanelParentObserver = null;
  let warnedMissingHudAnchor = false;
  const originalFillBackgrounds = new WeakMap();
  const troopFormatter = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  });

  function translateText(key, substitutions) {
    const text = chrome.i18n.getMessage(key, substitutions);
    if (!text) {
      throw new Error(`[OpenFront Overlay] Missing translation: ${key}`);
    }
    return text;
  }

  // Chrome invalidates extension APIs on reload, but this tab's listener can
  // still receive bridge messages until the page is refreshed.
  const advisorKeys = [
    "advisorTitle",
    "collapseAdvisor",
    "expandAdvisor",
    "findEnemySilos",
    "monitorPirates",
    "watchRichPlayers",
    "richPlayerWarning",
    "abandonedRichPlayerWarning",
    "watchInactiveNeighbors",
    "inactiveNeighborWarning",
    "traitorNeighborWarning",
    "firstEnemySiloWarning",
    "incomingBoatWarning",
    "pirateWarning",
    "advisor_disabled",
    "advisor_waiting",
    "advisor_indexing",
    "advisor_catchup",
    "advisor_finished",
    "advisor_unsupported",
    "advisor_error",
    "strongNeighbors",
    "noStrongNeighbors",
    "friendlyNeighbor",
    "hostileNeighbor",
    "phase_opening",
    "phase_economy",
    "phase_contested",
    "phase_nuclear",
    "phase_endgame",
  ];
  const advisorLabels = Object.fromEntries(
    advisorKeys.map((key) => [key, translateText(key)]),
  );
  let panel;
  let enabled = false;
  let requestId = 0;
  let pendingRequest = null;
  let lastDetails = "";
  const defaultAdvisor = {
    status: "disabled",
    enabled: false,
    cap: null,
    reservePercent: null,
    incoming: null,
    recommendation: null,
    context: null,
    neighbors: [],
  };
  let advisor = defaultAdvisor;
  let displayedRecommendation = null;

  function validAdvisor(value) {
    if (!value || typeof value !== "object") return false;
    const statuses = [
      "disabled",
      "waiting",
      "indexing",
      "active",
      "catchup",
      "finished",
      "unsupported",
      "error",
    ];
    const rawNumber = (number) =>
      number === null || (Number.isSafeInteger(number) && number >= 0);
    return (
      statuses.includes(value.status) &&
      typeof value.enabled === "boolean" &&
      rawNumber(value.cap) &&
      rawNumber(value.incoming) &&
      [null, "push", "retain"].includes(value.recommendation) &&
      (value.reservePercent === null ||
        (Number.isFinite(value.reservePercent) && value.reservePercent >= 0)) &&
      (value.context === null ||
        ["opening", "economy", "contested", "nuclear", "endgame"].includes(
          value.context,
        )) &&
      (value.error === undefined ||
        (typeof value.error === "string" && value.error.length <= 1000)) &&
      Array.isArray(value.neighbors) &&
      value.neighbors.length <= 512 &&
      value.neighbors.every(
        (neighbor) =>
          Number.isSafeInteger(neighbor.id) &&
          neighbor.id >= 0 &&
          typeof neighbor.name === "string" &&
          neighbor.name.length <= 200 &&
          typeof neighbor.friendly === "boolean" &&
          Number.isSafeInteger(neighbor.troops) &&
          neighbor.troops >= 0,
      ) &&
      (value.status !== "active" ||
        (value.cap !== null &&
          value.incoming !== null &&
          value.recommendation !== null &&
          value.reservePercent !== null &&
          value.context !== null))
    );
  }

  function node(tag, text, parent) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (parent) parent.appendChild(element);
    return element;
  }

  function validMarkers(value, maxRadius = 100) {
    if (!Array.isArray(value) || value.length > 10000) return false;
    const ids = new Set();
    for (const marker of value) {
      if (
        !marker ||
        !Number.isSafeInteger(marker.id) ||
        marker.id < 0 ||
        ids.has(marker.id) ||
        !Number.isFinite(marker.x) ||
        Math.abs(marker.x) > 100000 ||
        !Number.isFinite(marker.y) ||
        Math.abs(marker.y) > 100000 ||
        !Number.isFinite(marker.radius) ||
        marker.radius < 4 ||
        marker.radius > maxRadius
      ) {
        return false;
      }
      ids.add(marker.id);
    }
    return true;
  }

  function createMarkerLayer(kind) {
    const config = markerKinds[kind];
    if (document.getElementById(config.layerId)) return;
    const layer = node("div");
    config.layer = layer;
    layer.id = config.layerId;
    layer.setAttribute("aria-hidden", "true");
    layer.style.position = "fixed";
    layer.style.inset = "0";
    layer.style.zIndex = "2147483646";
    layer.style.overflow = "hidden";
    layer.style.pointerEvents = "none";
    layer.style.display = config.isEnabled() ? "block" : "none";
    node(
      "style",
      `
      @keyframes ${config.animation} {
        from {
          scale: 1;
          filter: drop-shadow(0 0 1px #fff) drop-shadow(0 0 3px #111);
        }
        to {
          scale: 1.18;
          filter: drop-shadow(0 0 3px #fff) drop-shadow(0 0 9px ${config.color}) drop-shadow(0 0 15px ${config.glow});
        }
      }
      @media (prefers-reduced-motion: reduce) {
        [data-${config.datasetKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}] { animation: none !important; }
      }
    `,
      layer,
    );
    document.body.appendChild(layer);
  }

  function showWarning(id, text, top = "50%") {
    let warning = document.getElementById(id);
    if (!warning) {
      warning = node("div");
      warning.id = id;
      warning.setAttribute("role", "alert");
      warning.style.position = "fixed";
      warning.style.left = "50%";
      warning.style.top = top;
      warning.style.transform = "translate(-50%, -50%)";
      warning.style.zIndex = "2147483647";
      warning.style.maxWidth = "calc(100vw - 32px)";
      warning.style.boxSizing = "border-box";
      warning.style.padding = "14px 22px";
      warning.style.border = "2px solid #ff8c00";
      warning.style.borderRadius = "12px";
      warning.style.background = "#101827f2";
      warning.style.color = "#fff";
      warning.style.font = "700 20px/1.35 system-ui, sans-serif";
      warning.style.textAlign = "center";
      warning.style.pointerEvents = "none";
      warning.style.boxShadow = "0 0 12px #ff8c00, 0 4px 24px #000b";
      const style = node(
        "style",
        `
        @keyframes openfront-silo-warning-fade {
          0%, 75% { opacity: 1; scale: 1; }
          100% { opacity: 0; scale: 0.96; }
        }
        @media (prefers-reduced-motion: reduce) {
          #${id} { animation-duration: 2s !important; }
        }
      `,
      );
      document.body.appendChild(style);
      document.body.appendChild(warning);
    }
    warning.textContent = text;
    warning.style.animation = "none";
    void warning.offsetWidth;
    warning.style.animation =
      "openfront-silo-warning-fade 2.4s ease-out forwards";
  }

  function projectSiloMarker(marker) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (
      !Number.isFinite(width) ||
      width <= 0 ||
      !Number.isFinite(height) ||
      height <= 0
    ) {
      return { x: marker.x, y: marker.y, offscreen: false, angle: 0 };
    }

    // Large territory circles must not push their off-screen arrow to the center.
    const margin = Math.min(marker.radius, 42) + 4;
    const offscreen =
      marker.x < margin ||
      marker.x > width - margin ||
      marker.y < margin ||
      marker.y > height - margin;
    if (!offscreen) {
      return { x: marker.x, y: marker.y, offscreen, angle: 0 };
    }

    const centerX = width / 2;
    const centerY = height / 2;
    const dx = marker.x - centerX;
    const dy = marker.y - centerY;
    const scale = Math.min(
      dx === 0 ? Infinity : Math.max(0, centerX - margin) / Math.abs(dx),
      dy === 0 ? Infinity : Math.max(0, centerY - margin) / Math.abs(dy),
    );
    return {
      x: centerX + dx * scale,
      y: centerY + dy * scale,
      offscreen,
      angle: Math.atan2(dy, dx),
    };
  }

  function syncMarkers(kind, markers) {
    const config = markerKinds[kind];
    const layer = config.layer;
    if (!layer) return;
    layer.style.display = config.isEnabled() ? "block" : "none";
    const visibleIds = new Set();
    for (const marker of markers) {
      visibleIds.add(marker.id);
      let ring = config.elements.get(marker.id);
      if (!ring) {
        ring = node("span", undefined, layer);
        ring.dataset[config.datasetKey] = String(marker.id);
        ring.style.position = "absolute";
        ring.style.transform = "translate(-50%, -50%)";
        ring.style.boxSizing = "border-box";
        if (config.circle) {
          ring.style.border = `3px solid ${config.color}`;
          ring.style.borderRadius = "50%";
        } else {
          ring.style.backgroundColor = config.color;
          ring.style.clipPath = "polygon(50% 0, 100% 100%, 0 100%)";
        }
        ring.style.filter =
          "drop-shadow(0 0 1px #fff) drop-shadow(0 0 3px #111)";
        ring.style.animation = `${config.animation} 900ms ease-in-out infinite alternate`;
        ring.style.pointerEvents = "none";
        const arrow = node("span", undefined, ring);
        arrow.dataset[config.arrowKey] = "";
        arrow.style.position = "absolute";
        arrow.style.left = "50%";
        arrow.style.top = "50%";
        arrow.style.width = "0";
        arrow.style.height = "0";
        arrow.style.borderTop = "5px solid transparent";
        arrow.style.borderBottom = "5px solid transparent";
        arrow.style.borderLeft = `8px solid ${config.color}`;
        arrow.style.filter =
          "drop-shadow(0 0 1px #fff) drop-shadow(0 0 3px #111)";
        arrow.style.pointerEvents = "none";
        ring.arrow = arrow;
        config.elements.set(marker.id, ring);
      }
      const position = projectSiloMarker(marker);
      ring.dataset.offscreen = String(position.offscreen);
      ring.style.left = `${position.x}px`;
      ring.style.top = `${position.y}px`;
      ring.style.width = `${marker.radius * 2}px`;
      ring.style.height = `${marker.radius * 2}px`;
      ring.arrow.style.display = position.offscreen ? "block" : "none";
      ring.arrow.style.transform = `translate(-50%, -50%) rotate(${position.angle}rad) translateX(${marker.radius + 6}px)`;
    }
    for (const [id, ring] of config.elements) {
      if (visibleIds.has(id)) continue;
      ring.remove();
      config.elements.delete(id);
    }
  }

  function renderAdvisor() {
    if (!panel) return;
    const minimized = !enabled && advisor.status !== "finished";
    panel.host.dataset.minimized = String(minimized);
    panel.collapse.textContent =
      advisorLabels[minimized ? "expandAdvisor" : "collapseAdvisor"];
    panel.collapse.disabled =
      state.status === "idle" ||
      ["finished", "unsupported", "error"].includes(advisor.status);
    panel.collapse.setAttribute("aria-expanded", String(!minimized));
    panel.collapse.setAttribute("aria-pressed", String(enabled));
    panel.siloVisibilityLabel.hidden = minimized;
    panel.pirateMonitorLabel.hidden = minimized;
    panel.richWatchLabel.hidden = minimized;
    panel.inactiveWatchLabel.hidden = minimized;
    panel.body.hidden = minimized;
    const terminal = ["finished", "unsupported", "error"].includes(
      advisor.status,
    );
    panel.status.hidden =
      advisor.status === "active" || (!enabled && !terminal);
    panel.status.textContent =
      advisor.status === "active"
        ? ""
        : advisorLabels[`advisor_${advisor.status}`];
    if (terminal && advisor.error)
      panel.status.textContent += ` ${advisor.error}`;
    const signature = JSON.stringify({ advisor, troops: state.troops });
    if (signature === lastDetails) return;
    lastDetails = signature;
    panel.details.replaceChildren();
    if (advisor.status === "unsupported" || advisor.status === "error") {
      return;
    }
    if (advisor.status !== "active") return;
    const troops = (raw) => troopFormatter.format(raw / 10);
    node("h3", advisorLabels[`phase_${advisor.context}`], panel.details);
    node("h3", advisorLabels.strongNeighbors, panel.details);
    if (advisor.neighbors.length === 0) {
      node("p", advisorLabels.noStrongNeighbors, panel.details);
    }
    const list = node("ul", undefined, panel.details);
    const neighbors = [...advisor.neighbors].sort(
      (a, b) => Number(a.friendly) - Number(b.friendly),
    );
    for (const neighbor of neighbors) {
      const relation =
        advisorLabels[
          neighbor.friendly ? "friendlyNeighbor" : "hostileNeighbor"
        ];
      const item = node(
        "li",
        `${neighbor.name} - ${relation}: ${troops(neighbor.troops)}`,
        list,
      );
      item.className = neighbor.friendly ? "friendly" : "hostile";
    }
  }

  function mountAdvisor() {
    const host = node("div");
    host.id = overlayId;
    const root = host.attachShadow({ mode: "open" });
    node(
      "style",
      `
      :host { all: initial; position: fixed; left: calc(16px + env(safe-area-inset-left, 0px)); bottom: calc(16px + env(safe-area-inset-bottom, 0px)); z-index: 2147483647; width: min(330px, calc(100vw - 32px)); color: #fff; font: 13px/1.45 system-ui, sans-serif; pointer-events: auto; }
      [hidden] { display: none !important; }
      :host([data-minimized="true"]) { width: auto; max-width: calc(100vw - 32px); }
      section { box-sizing: border-box; border: 1px solid #526985; border-radius: 10px; background: #0a1628f2; padding: 12px; max-height: 60vh; overflow: auto; overflow-wrap: anywhere; }
      header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 12px; }
      header > [role="status"] { grid-column: 1 / -1; min-width: 0; margin: 0; }
      .settings { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
      button { background: #30445e; color: white; border: 1px solid #7085a0; border-radius: 4px; padding: 4px 7px; cursor: pointer; font: inherit; }
      button:disabled { cursor: default; opacity: 0.6; }
      header > button { grid-column: 2; justify-self: end; flex-shrink: 0; }
      h3 { margin: 12px 0 4px; font-size: 14px; }
      p { margin: 6px 0; }
      ul { margin: 6px 0; padding-left: 20px; }
      li { margin: 6px 0; }
      li.friendly { color: #86efac; }
      li.hostile { color: #fca5a5; }
      [data-urgent="true"] { border-left: 3px solid #f6a34b; padding-left: 8px; }
      button:focus-visible { outline: 2px solid #f6cf64; outline-offset: 2px; }
      .silo-visibility { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; cursor: pointer; }
      .silo-visibility input { flex: 0 0 auto; accent-color: #ff8c00; }
    `,
      root,
    );
    const section = node("section", undefined, root);
    section.setAttribute("aria-label", advisorLabels.advisorTitle);
    const header = node("header", undefined, section);
    const status = node("p", undefined, header);
    status.setAttribute("role", "status");
    const settings = node("div", undefined, header);
    settings.className = "settings";
    const siloVisibilityLabel = node("label", undefined, settings);
    siloVisibilityLabel.className = "silo-visibility";
    const siloVisibility = node("input", undefined, siloVisibilityLabel);
    siloVisibility.type = "checkbox";
    siloVisibility.checked = true;
    siloVisibility.setAttribute("aria-label", advisorLabels.findEnemySilos);
    node("span", advisorLabels.findEnemySilos, siloVisibilityLabel);
    siloVisibility.addEventListener("change", () => {
      findEnemySilos = siloVisibility.checked;
      const layer = markerKinds.silo.layer;
      if (layer) layer.style.display = findEnemySilos ? "block" : "none";
    });
    const pirateMonitorLabel = node("label", undefined, settings);
    pirateMonitorLabel.className = "silo-visibility";
    const pirateMonitor = node("input", undefined, pirateMonitorLabel);
    pirateMonitor.type = "checkbox";
    pirateMonitor.checked = true;
    pirateMonitor.setAttribute("aria-label", advisorLabels.monitorPirates);
    node("span", advisorLabels.monitorPirates, pirateMonitorLabel);
    pirateMonitor.addEventListener("change", () => {
      monitorPirates = pirateMonitor.checked;
      const layer = markerKinds.pirate.layer;
      if (layer) layer.style.display = monitorPirates ? "block" : "none";
    });
    const richWatchLabel = node("label", undefined, settings);
    richWatchLabel.className = "silo-visibility";
    const richWatch = node("input", undefined, richWatchLabel);
    richWatch.type = "checkbox";
    richWatch.checked = true;
    richWatch.setAttribute("aria-label", advisorLabels.watchRichPlayers);
    node("span", advisorLabels.watchRichPlayers, richWatchLabel);
    richWatch.addEventListener("change", () => {
      watchRichPlayers = richWatch.checked;
      const layer = markerKinds.abandoned.layer;
      if (layer) layer.style.display = watchRichPlayers ? "block" : "none";
    });
    const inactiveWatchLabel = node("label", undefined, settings);
    inactiveWatchLabel.className = "silo-visibility";
    const inactiveWatch = node("input", undefined, inactiveWatchLabel);
    inactiveWatch.type = "checkbox";
    inactiveWatch.checked = true;
    inactiveWatch.setAttribute(
      "aria-label",
      advisorLabels.watchInactiveNeighbors,
    );
    node("span", advisorLabels.watchInactiveNeighbors, inactiveWatchLabel);
    inactiveWatch.addEventListener("change", () => {
      watchInactiveNeighbors = inactiveWatch.checked;
    });
    const collapse = node("button", advisorLabels.collapseAdvisor, header);
    collapse.type = "button";
    const body = node("div", undefined, section);
    const details = node("div", undefined, body);
    panel = {
      host,
      body,
      collapse,
      status,
      siloVisibilityLabel,
      pirateMonitorLabel,
      richWatchLabel,
      inactiveWatchLabel,
      details,
    };
    collapse.addEventListener("click", () => {
      if (panel.collapse.disabled) return;
      enabled = !enabled;
      pendingRequest = ++requestId;
      if (!enabled) displayedRecommendation = null;
      renderAdvisor();
      syncHudColor();
      window.postMessage(
        { type: "OPENFRONT_OVERLAY_CONTROL", enabled, requestId },
        window.location.origin,
      );
    });
    document.body.appendChild(host);
    renderAdvisor();
  }

  function watchControlPanel(controlPanel) {
    if (controlPanel === hudControlPanel) return;
    hudPanelObserver?.disconnect();
    hudPanelParentObserver?.disconnect();
    if (hudControlPanel) restoreHudColors(hudControlPanel);
    hudControlPanel = controlPanel;
    if (!controlPanel) return;

    hudPanelObserver = new MutationObserver(syncHudColor);
    hudPanelObserver.observe(controlPanel, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });

    if (controlPanel.parentElement) {
      hudPanelParentObserver = new MutationObserver(syncHudColor);
      hudPanelParentObserver.observe(controlPanel.parentElement, {
        childList: true,
      });
    }
  }

  function restoreHudColors(controlPanel) {
    for (const fill of controlPanel.querySelectorAll(".bg-malibu-blue")) {
      if (!originalFillBackgrounds.has(fill)) continue;
      fill.style.backgroundColor = originalFillBackgrounds.get(fill);
      originalFillBackgrounds.delete(fill);
    }
  }

  function removeReserveMarkers(controlPanel) {
    controlPanel
      .querySelectorAll(reserveMarkerSelector)
      .forEach((marker) => marker.remove());
  }

  function createReserveMarker() {
    const marker = node("span");
    marker.dataset.openfrontReserveMarker = "42";
    marker.setAttribute("aria-hidden", "true");
    marker.style.position = "absolute";
    marker.style.top = "0";
    marker.style.bottom = "0";
    marker.style.left = "42%";
    marker.style.width = "2px";
    marker.style.backgroundColor = "#fbbf24";
    marker.style.boxShadow = "0 0 0 1px #111827";
    marker.style.pointerEvents = "none";
    return marker;
  }

  function syncHudColor() {
    const controlPanel = document.querySelector("control-panel");
    watchControlPanel(controlPanel);
    if (!controlPanel) return;

    const inGame = document.body?.classList.contains("in-game") ?? false;
    if (!inGame) {
      restoreHudColors(controlPanel);
      removeReserveMarkers(controlPanel);
      return;
    }

    const canPush =
      state.status === "playing" &&
      enabled &&
      displayedRecommendation === "push";
    const troopBars = Array.from(
      controlPanel.querySelectorAll(".bg-malibu-blue"),
    )
      .map((fill) => fill.parentElement?.parentElement)
      .filter(
        (bar) =>
          bar?.classList.contains("overflow-hidden") &&
          bar.classList.contains("relative"),
      );
    if (troopBars.length === 0) {
      if (!warnedMissingHudAnchor) {
        console.warn(
          "[OpenFront Overlay] Native troop bar anchor not found; HUD indicators are unavailable.",
        );
        warnedMissingHudAnchor = true;
      }
      return;
    }

    warnedMissingHudAnchor = false;
    for (const bar of troopBars) {
      const fill = bar.querySelector(".bg-malibu-blue");
      if (!fill) continue;
      if (!bar.querySelector(reserveMarkerSelector)) {
        const troopLabels = Array.from(bar.children).find(
          (child) =>
            child.classList.contains("absolute") &&
            child.classList.contains("inset-0") &&
            child.classList.contains("flex"),
        );
        bar.insertBefore(createReserveMarker(), troopLabels ?? null);
      }
      if (canPush) {
        if (!originalFillBackgrounds.has(fill)) {
          originalFillBackgrounds.set(fill, fill.style.backgroundColor);
        }
        if (fill.style.backgroundColor !== "#22c55e") {
          fill.style.backgroundColor = "#22c55e";
        }
      } else if (originalFillBackgrounds.has(fill)) {
        fill.style.backgroundColor = originalFillBackgrounds.get(fill);
        originalFillBackgrounds.delete(fill);
      }
    }
  }

  function startHudColorSync() {
    syncHudColor();
    hudBodyObserver = new MutationObserver(syncHudColor);
    hudBodyObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    window.addEventListener("pagehide", stopHudColorSync, { once: true });
  }

  function stopHudColorSync() {
    hudBodyObserver?.disconnect();
    hudPanelObserver?.disconnect();
    hudPanelParentObserver?.disconnect();
    if (hudControlPanel) {
      restoreHudColors(hudControlPanel);
      removeReserveMarkers(hudControlPanel);
    }
    hudControlPanel = null;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin)
      return;
    if (event.data?.type === "OPENFRONT_OVERLAY_FIRST_ENEMY_SILO") {
      if (findEnemySilos)
        showWarning(enemySiloWarningId, advisorLabels.firstEnemySiloWarning);
      return;
    }
    if (event.data?.type === "OPENFRONT_OVERLAY_INCOMING_BOAT") {
      showWarning(
        incomingBoatWarningId,
        advisorLabels.incomingBoatWarning,
        "35%",
      );
      return;
    }
    if (event.data?.type === "OPENFRONT_OVERLAY_PIRATE_ALERT") {
      if (monitorPirates)
        showWarning(pirateWarningId, advisorLabels.pirateWarning, "65%");
      return;
    }
    const playerWarning = Object.hasOwn(playerWarnings, event.data?.type)
      ? playerWarnings[event.data.type]
      : null;
    if (playerWarning) {
      const names = event.data.playerNames;
      if (
        !Array.isArray(names) ||
        names.length === 0 ||
        names.length > 5 ||
        !names.every((name) => typeof name === "string" && name.length <= 200)
      ) {
        console.error("[OpenFront Overlay] Invalid player warning message.");
        return;
      }
      if (!playerWarning.isEnabled()) return;
      showWarning(
        playerWarning.id,
        advisorLabels[playerWarning.label].replace("{name}", names.join(", ")),
        playerWarning.top,
      );
      return;
    }
    if (event.data?.type === "OPENFRONT_OVERLAY_ABANDONED_TERRITORIES") {
      if (
        !validMarkers(
          event.data.abandonedPlayers,
          markerKinds.abandoned.maxRadius,
        )
      ) {
        console.error(
          "[OpenFront Overlay] Invalid abandoned territory message.",
        );
        return;
      }
      syncMarkers(
        "abandoned",
        document.body?.classList.contains("in-game")
          ? event.data.abandonedPlayers
          : [],
      );
      return;
    }
    if (event.data?.type === "OPENFRONT_OVERLAY_SILOS") {
      if (!validMarkers(event.data.missileSilos)) {
        console.error("[OpenFront Overlay] Invalid enemy silo message.");
        return;
      }
      syncMarkers(
        "silo",
        document.body?.classList.contains("in-game")
          ? event.data.missileSilos
          : [],
      );
      return;
    }
    if (event.data?.type === "OPENFRONT_OVERLAY_PIRATE_WARSHIPS") {
      if (!validMarkers(event.data.pirateWarships)) {
        console.error("[OpenFront Overlay] Invalid pirate warship message.");
        return;
      }
      syncMarkers(
        "pirate",
        document.body?.classList.contains("in-game")
          ? event.data.pirateWarships
          : [],
      );
      return;
    }
    if (event.data?.type !== "OPENFRONT_OVERLAY_STATE") return;
    const { status, troops } = event.data;
    const valid =
      status === "playing"
        ? Number.isSafeInteger(troops) && troops >= 0
        : ["idle", "waiting", "unavailable"].includes(status) &&
          troops === null;
    if (!valid) {
      console.error("[OpenFront Overlay] Invalid state message.");
      return;
    }
    if (event.data.advisor !== undefined && !validAdvisor(event.data.advisor)) {
      console.error("[OpenFront Overlay] Invalid advisor message.");
      return;
    }
    const missileSilos = event.data.missileSilos ?? [];
    if (!validMarkers(missileSilos)) {
      console.error("[OpenFront Overlay] Invalid enemy silo message.");
      return;
    }
    if (
      event.data.controlId !== undefined &&
      (!Number.isSafeInteger(event.data.controlId) || event.data.controlId < 0)
    ) {
      console.error("[OpenFront Overlay] Invalid control acknowledgement.");
      return;
    }
    if (
      pendingRequest !== null &&
      (event.data.controlId ?? 0) < pendingRequest
    ) {
      return;
    }
    state = { status, troops };
    syncMarkers("silo", status === "idle" ? [] : missileSilos);
    advisor = event.data.advisor ?? defaultAdvisor;
    pendingRequest = null;
    enabled = advisor.enabled;
    if (status === "idle") {
      enabled = false;
      advisor = defaultAdvisor;
    }
    if (status !== "playing") {
      displayedRecommendation = null;
    } else if (advisor.status === "active") {
      displayedRecommendation = advisor.recommendation;
    } else if (!["indexing", "catchup"].includes(advisor.status)) {
      displayedRecommendation = null;
    }
    renderAdvisor();
    syncHudColor();
  });

  function mountOverlay() {
    if (document.getElementById(overlayId)) {
      return;
    }

    mountAdvisor();
    createMarkerLayer("silo");
    createMarkerLayer("pirate");
    createMarkerLayer("abandoned");
    startHudColorSync();
    console.info("[OpenFront Overlay] Advisor overlay mounted.");
  }

  // At document_start, the parser may not have created the body yet.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountOverlay, { once: true });
  } else {
    mountOverlay();
  }
})();
