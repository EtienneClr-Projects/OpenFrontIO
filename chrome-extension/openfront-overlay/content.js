(() => {
  const overlayId = "openfront-advisor-ui";
  let state = { status: "idle", troops: null };
  const troopFormatter = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 1,
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
    "enableAdvisor",
    "collapseAdvisor",
    "expandAdvisor",
    "advisorReadOnly",
    "advisor_disabled",
    "advisor_waiting",
    "advisor_indexing",
    "advisor_active",
    "advisor_catchup",
    "advisor_finished",
    "advisor_unsupported",
    "advisor_error",
    "reserve",
    "incoming",
    "defense",
    "noIncoming",
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
  let collapsed = false;
  let lastDetails = "";
  const defaultAdvisor = {
    status: "disabled",
    enabled: false,
    cap: null,
    reservePercent: null,
    incoming: null,
    context: null,
    neighbors: [],
  };
  let advisor = defaultAdvisor;

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

  function renderAdvisor() {
    if (!panel) return;
    const minimized = state.status === "idle" || collapsed;
    panel.host.dataset.minimized = String(minimized);
    panel.toggle.checked = advisor.enabled;
    panel.toggle.disabled = ["finished", "unsupported", "error"].includes(
      advisor.status,
    );
    panel.collapse.textContent =
      advisorLabels[minimized ? "expandAdvisor" : "collapseAdvisor"];
    panel.collapse.disabled = state.status === "idle";
    panel.collapse.setAttribute("aria-expanded", String(!minimized));
    panel.body.hidden = minimized;
    panel.status.textContent = advisorLabels[`advisor_${advisor.status}`];
    const signature = JSON.stringify({ advisor, troops: state.troops });
    if (signature === lastDetails) return;
    lastDetails = signature;
    panel.details.replaceChildren();
    if (advisor.status === "unsupported" || advisor.status === "error") {
      if (advisor.error) node("p", advisor.error, panel.details);
      return;
    }
    if (advisor.status !== "active") return;
    const troops = (raw) => troopFormatter.format(raw / 10);
    const percent = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 1,
    }).format(advisor.reservePercent);
    node("h3", advisorLabels[`phase_${advisor.context}`], panel.details);
    node(
      "p",
      `${advisorLabels.reserve}: ${percent}% (${troops(state.troops)} / ${troops(advisor.cap)})`,
      panel.details,
    );
    node(
      "p",
      `${advisorLabels.incoming}: ${troops(advisor.incoming)}`,
      panel.details,
    );
    const warning = node(
      "p",
      advisorLabels[advisor.incoming > 0 ? "defense" : "noIncoming"],
      panel.details,
    );
    warning.dataset.urgent = String(advisor.incoming > 0);
    node("h3", advisorLabels.strongNeighbors, panel.details);
    if (advisor.neighbors.length === 0) {
      node("p", advisorLabels.noStrongNeighbors, panel.details);
    }
    const list = node("ul", undefined, panel.details);
    for (const neighbor of advisor.neighbors) {
      const relation =
        advisorLabels[
          neighbor.friendly ? "friendlyNeighbor" : "hostileNeighbor"
        ];
      node(
        "li",
        `${neighbor.name} - ${relation}: ${troops(neighbor.troops)}`,
        list,
      );
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
      header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
      button { background: #30445e; color: white; border: 1px solid #7085a0; border-radius: 4px; padding: 4px 7px; cursor: pointer; font: inherit; }
      button:disabled { cursor: default; opacity: 0.6; }
      input { accent-color: #3fa9f5; }
      label { display: flex; align-items: center; gap: 8px; margin: 10px 0; cursor: pointer; }
      h3 { margin: 12px 0 4px; font-size: 14px; }
      p { margin: 6px 0; }
      small { color: #b5c7dc; }
      ul { margin: 6px 0; padding-left: 20px; }
      li { margin: 6px 0; }
      [data-urgent="true"] { border-left: 3px solid #f6a34b; padding-left: 8px; }
      button:focus-visible, input:focus-visible { outline: 2px solid #f6cf64; outline-offset: 2px; }
    `,
      root,
    );
    const section = node("section", undefined, root);
    section.setAttribute("aria-label", advisorLabels.advisorTitle);
    const header = node("header", undefined, section);
    node("strong", advisorLabels.advisorTitle, header);
    const collapse = node("button", advisorLabels.collapseAdvisor, header);
    collapse.type = "button";
    const body = node("div", undefined, section);
    node("small", advisorLabels.advisorReadOnly, body);
    const label = node("label", undefined, body);
    const toggle = node("input", undefined, label);
    toggle.type = "checkbox";
    node("span", advisorLabels.enableAdvisor, label);
    const status = node("p", undefined, body);
    status.setAttribute("role", "status");
    const details = node("div", undefined, body);
    panel = { host, body, toggle, collapse, status, details };
    toggle.addEventListener("change", () => {
      window.postMessage(
        { type: "OPENFRONT_OVERLAY_CONTROL", enabled: toggle.checked },
        window.location.origin,
      );
    });
    collapse.addEventListener("click", () => {
      collapsed = !collapsed;
      renderAdvisor();
    });
    document.body.appendChild(host);
    renderAdvisor();
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      event.data?.type !== "OPENFRONT_OVERLAY_STATE"
    ) {
      return;
    }
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
    state = { status, troops };
    advisor = event.data.advisor ?? defaultAdvisor;
    if (status === "idle") {
      collapsed = false;
      advisor = defaultAdvisor;
    }
    renderAdvisor();
  });

  function mountOverlay() {
    if (document.getElementById(overlayId)) {
      return;
    }

    mountAdvisor();
    console.info("[OpenFront Overlay] Advisor overlay mounted.");
  }

  // At document_start, the parser may not have created the body yet.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountOverlay, { once: true });
  } else {
    mountOverlay();
  }
})();
