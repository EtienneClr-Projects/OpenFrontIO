import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const base = new URL("../openfront-overlay/", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("manifest.json", base), "utf8"),
);
const messages = JSON.parse(
  readFileSync(new URL("_locales/en/messages.json", base), "utf8"),
);
const source = readFileSync(new URL("content.js", base), "utf8");
const displayedTroops = (raw) =>
  new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(raw / 10);

function createContext(readyState = "complete") {
  const elements = [];
  const listeners = [];
  const windowListeners = [];
  const errors = [];
  const controls = [];
  const mutations = [];
  const bodyClasses = new Set();
  let controlPanel = null;
  const body = {
    classList: {
      contains: (name) => bodyClasses.has(name),
      add: (name) => bodyClasses.add(name),
      remove: (name) => bodyClasses.delete(name),
    },
    appendChild(element) {
      elements.push(element);
      element.parentElement = body;
    },
  };
  function makeElement(tag) {
    const element = {
      tag,
      dataset: {},
      children: [],
      textContent: "",
      attributes: {},
      listeners: {},
      className: "",
      style: { backgroundColor: "" },
      classList: {
        contains(name) {
          return element.className.split(/\s+/).includes(name);
        },
      },
      appendChild(child) {
        this.children.push(child);
        child.parentElement = this;
      },
      insertBefore(child, reference) {
        const index = reference ? this.children.indexOf(reference) : -1;
        if (index < 0) this.children.push(child);
        else this.children.splice(index, 0, child);
        child.parentElement = this;
      },
      remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter(
          (child) => child !== this,
        );
        this.parentElement = null;
      },
      replaceChildren() {
        this.children = [];
      },
      setAttribute(key, value) {
        this.attributes[key] = value;
      },
      addEventListener(event, callback) {
        this.listeners[event] = callback;
      },
      querySelectorAll(selector) {
        const found = [];
        const matches = (child) => {
          if (selector.startsWith(".")) {
            return child.classList.contains(selector.slice(1));
          }
          return (
            selector === '[data-openfront-reserve-marker="42"]' &&
            child.dataset.openfrontReserveMarker === "42"
          );
        };
        const visit = (parent) => {
          for (const child of parent.children) {
            if (matches(child)) found.push(child);
            visit(child);
            if (child.shadowRoot) visit(child.shadowRoot);
          }
        };
        visit(this);
        return found;
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      },
      attachShadow() {
        this.shadowRoot = makeElement("shadow-root");
        return this.shadowRoot;
      },
    };
    return element;
  }
  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.active = false;
      mutations.push(this);
    }
    observe(target) {
      this.target = target;
      this.active = true;
    }
    disconnect() {
      this.active = false;
    }
  }
  const document = {
    readyState,
    body: readyState === "loading" ? null : body,
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => elements.find((element) => element.id === id),
    querySelector: (selector) =>
      selector === "control-panel" ? controlPanel : null,
    addEventListener: (event, callback, options) =>
      listeners.push({ event, callback, options }),
  };
  const context = {
    document,
    MutationObserver: MockMutationObserver,
    chrome: { i18n: { getMessage: (key) => messages[key]?.message ?? "" } },
    window: {
      location: { origin: "https://openfront.io" },
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: (event, callback) =>
        windowListeners.push({ event, callback }),
      postMessage: (data, origin) => controls.push({ data, origin }),
    },
    console: { info() {}, error: (...args) => errors.push(args) },
  };
  function send(data, overrides = {}) {
    const event = {
      source: context.window,
      origin: context.window.location.origin,
      data: {
        type: "OPENFRONT_OVERLAY_STATE",
        controlId: controls.at(-1)?.data.requestId ?? 0,
        ...data,
      },
      ...overrides,
    };
    for (const listener of windowListeners) {
      if (listener.event === "message") listener.callback(event);
    }
  }
  function setControlPanel(panel) {
    controlPanel = panel;
  }
  function triggerMutation(target) {
    for (const observer of mutations) {
      if (observer.active && observer.target === target) observer.callback([]);
    }
  }
  return {
    context,
    elements,
    listeners,
    body,
    send,
    errors,
    controls,
    setControlPanel,
    triggerMutation,
  };
}

function descendants(element) {
  return [
    element,
    ...element.children.flatMap(descendants),
    ...(element.shadowRoot ? descendants(element.shadowRoot) : []),
  ];
}

function activeAdvisor(extra = {}) {
  return {
    status: "active",
    enabled: true,
    cap: 100000,
    reservePercent: 42,
    incoming: 1234,
    recommendation: "retain",
    context: "contested",
    neighbors: [
      {
        id: 2,
        name: "<img src=x onerror=alert(1)>",
        friendly: false,
        troops: 60000,
      },
      { id: 3, name: "Ally", friendly: true, troops: 80000 },
    ],
    ...extra,
  };
}

await test("localized MV3 manifest loads only the advisor and packaged bridge", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.description, "__MSG_extensionDescription__");
  assert.ok(messages.extensionDescription.message);
  assert.equal(manifest.content_scripts.length, 2);
  const [content, bridge] = manifest.content_scripts;
  assert.equal(content.run_at, "document_start");
  assert.deepEqual(content.matches, [
    "https://openfront.io/*",
    "https://*.openfront.io/*",
    "http://localhost:9000/*",
  ]);
  assert.equal(content.css, undefined);
  assert.equal(bridge.world, "MAIN");
  assert.equal(bridge.run_at, "document_start");
  assert.deepEqual(bridge.matches, content.matches);
  assert.deepEqual(bridge.js, ["inject.js"]);
  for (const entry of manifest.content_scripts) {
    for (const file of entry.js) assert.ok(existsSync(new URL(file, base)));
  }
  assert.equal(manifest.permissions, undefined);
});

for (const readyState of ["loading", "interactive", "complete"]) {
  await test(`mounts exactly one minimized advisor when DOM is ${readyState}`, () => {
    const { context, elements, listeners, body } = createContext(readyState);
    runInNewContext(source, context);
    if (readyState === "loading") {
      assert.equal(elements.length, 0);
      assert.equal(listeners[0].event, "DOMContentLoaded");
      assert.equal(listeners[0].options.once, true);
      context.document.body = body;
      context.document.readyState = "interactive";
      listeners[0].callback();
    }
    assert.equal(elements.length, 2);
    assert.equal(elements[0].id, "openfront-advisor-ui");
    assert.equal(elements[0].dataset.minimized, "true");
    assert.equal(elements[1].id, "openfront-enemy-silos");
    assert.equal(
      context.document.getElementById("openfront-overlay-ui"),
      undefined,
    );
    const style = descendants(elements[0]).find(
      (element) => element.tag === "style",
    );
    assert.match(style.textContent, /left: calc\(16px/);
    assert.match(style.textContent, /bottom: calc\(16px/);
    assert.doesNotMatch(style.textContent, /right: calc/);
    runInNewContext(source, context);
    assert.equal(elements.length, 2);
  });
}

await test("enemy silo markers track screen coordinates and disappear when cleared", () => {
  const { context, elements, send } = createContext();
  context.document.body.classList.add("in-game");
  runInNewContext(source, context);
  send({
    status: "playing",
    troops: 100,
    advisor: activeAdvisor(),
  });
  const siloMessage = (missileSilos) =>
    send({}, { data: { type: "OPENFRONT_OVERLAY_SILOS", missileSilos } });
  siloMessage([{ id: 12, x: 120, y: 80, radius: 18 }]);

  const layer = elements.find(
    (element) => element.id === "openfront-enemy-silos",
  );
  assert.ok(layer);
  assert.equal(layer.style.position, "fixed");
  assert.equal(layer.style.zIndex, "2147483646");
  assert.equal(layer.style.pointerEvents, "none");
  const findCheckbox = descendants(elements[0]).find(
    (element) => element.tag === "input",
  );
  assert.ok(findCheckbox);
  assert.equal(findCheckbox.type, "checkbox");
  assert.equal(findCheckbox.checked, true);
  assert.equal(
    findCheckbox.attributes["aria-label"],
    messages.findEnemySilos.message,
  );
  assert.equal(layer.style.display, "block");
  findCheckbox.checked = false;
  findCheckbox.listeners.change();
  assert.equal(layer.style.display, "none");
  const pulseStyles = descendants(layer).find(
    (element) => element.tag === "style",
  );
  assert.match(pulseStyles.textContent, /openfront-silo-pulse/);
  assert.match(pulseStyles.textContent, /prefers-reduced-motion/);
  const ring = descendants(layer).find(
    (element) => element.dataset.openfrontEnemySilo === "12",
  );
  assert.ok(ring);
  assert.equal(ring.style.left, "120px");
  assert.equal(ring.style.top, "80px");
  assert.equal(ring.style.width, "36px");
  assert.equal(ring.style.height, "36px");
  assert.equal(ring.style.backgroundColor, "#ff8c00");
  assert.equal(ring.style.clipPath, "polygon(50% 0, 100% 100%, 0 100%)");
  assert.match(ring.style.filter, /drop-shadow\(0 0 1px #fff\)/);
  assert.match(ring.style.filter, /drop-shadow\(0 0 3px #111\)/);
  assert.match(ring.style.animation, /900ms ease-in-out infinite alternate/);

  findCheckbox.checked = true;
  findCheckbox.listeners.change();
  assert.equal(layer.style.display, "block");
  findCheckbox.checked = false;
  findCheckbox.listeners.change();
  assert.equal(layer.style.display, "none");

  assert.equal(ring.dataset.offscreen, "false");
  const arrow = descendants(ring).find(
    (element) => element.dataset.openfrontEnemySiloArrow === "",
  );
  assert.ok(arrow);
  assert.equal(arrow.style.display, "none");

  siloMessage([{ id: 12, x: 900, y: 300, radius: 18 }]);
  assert.equal(ring.style.left, "778px");
  assert.equal(ring.style.top, "300px");
  assert.equal(ring.dataset.offscreen, "true");
  assert.equal(arrow.style.display, "block");
  assert.match(arrow.style.transform, /rotate\(0rad\)/);

  siloMessage([{ id: 12, x: 120, y: 80, radius: 18 }]);
  assert.equal(ring.style.left, "120px");
  assert.equal(ring.style.top, "80px");
  assert.equal(ring.dataset.offscreen, "false");
  assert.equal(arrow.style.display, "none");

  siloMessage([]);
  assert.equal(
    descendants(layer).some(
      (element) => element.dataset.openfrontEnemySilo === "12",
    ),
    false,
  );
});

await test("first enemy silo warning appears in the center and fades", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send({}, { data: { type: "OPENFRONT_OVERLAY_FIRST_ENEMY_SILO" } });

  const warning = elements.find(
    (element) => element.id === "openfront-enemy-silo-warning",
  );
  assert.ok(warning);
  assert.equal(warning.attributes.role, "alert");
  assert.equal(warning.textContent, messages.firstEnemySiloWarning.message);
  assert.equal(warning.style.left, "50%");
  assert.equal(warning.style.top, "50%");
  assert.equal(warning.style.pointerEvents, "none");
  assert.match(warning.style.animation, /2\.4s ease-out forwards/);

  send({}, { data: { type: "OPENFRONT_OVERLAY_FIRST_ENEMY_SILO" } });
  assert.equal(
    elements.filter((element) => element.id === "openfront-enemy-silo-warning")
      .length,
    1,
  );
  assert.match(warning.style.animation, /2\.4s ease-out forwards/);
});

await test("incoming boat warning appears above center and is idempotent", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send({}, { data: { type: "OPENFRONT_OVERLAY_INCOMING_BOAT" } });
  send({}, { data: { type: "OPENFRONT_OVERLAY_INCOMING_BOAT" } });

  const warnings = elements.filter(
    (element) => element.id === "openfront-incoming-boat-warning",
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].attributes.role, "alert");
  assert.equal(warnings[0].textContent, messages.incomingBoatWarning.message);
  assert.equal(warnings[0].style.top, "35%");
});

await test("first enemy silo warning is disabled with Find enemy silos", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  const findCheckbox = descendants(elements[0]).find(
    (element) => element.tag === "input",
  );
  assert.ok(findCheckbox);
  findCheckbox.checked = false;
  findCheckbox.listeners.change();
  send({}, { data: { type: "OPENFRONT_OVERLAY_FIRST_ENEMY_SILO" } });
  assert.equal(
    elements.some((element) => element.id === "openfront-enemy-silo-warning"),
    false,
  );
});

await test("push recommendation colors the native troop bar and resets cleanly", () => {
  const { context, body, send, setControlPanel, triggerMutation } =
    createContext();
  const controlPanel = context.document.createElement("control-panel");
  const parent = context.document.createElement("div");
  parent.appendChild(controlPanel);
  const makeTroopBar = () => {
    const bar = context.document.createElement("div");
    bar.className = "relative overflow-hidden";
    const fillContainer = context.document.createElement("div");
    const fill = context.document.createElement("div");
    fill.className = "bg-malibu-blue";
    fillContainer.appendChild(fill);
    bar.appendChild(fillContainer);
    const troopLabels = context.document.createElement("div");
    troopLabels.className =
      "absolute inset-0 flex items-center justify-between";
    bar.appendChild(troopLabels);
    return bar;
  };
  controlPanel.appendChild(makeTroopBar());
  controlPanel.appendChild(makeTroopBar());
  setControlPanel(controlPanel);
  body.classList.add("in-game");

  runInNewContext(source, context);

  let fills = controlPanel.querySelectorAll(".bg-malibu-blue");
  assert.equal(fills.length, 2);
  assert.ok(fills.every((fill) => fill.style.backgroundColor === ""));
  let markers = controlPanel.querySelectorAll(
    '[data-openfront-reserve-marker="42"]',
  );
  assert.equal(markers.length, 2);
  assert.ok(markers.every((marker) => marker.style.left === "42%"));
  assert.ok(
    markers.every((marker) => marker.attributes["aria-hidden"] === "true"),
  );
  assert.ok(
    markers.every((marker) => {
      const children = marker.parentElement.children;
      const markerIndex = children.indexOf(marker);
      const troopLabelsIndex = children.findIndex(
        (child) =>
          child.classList.contains("absolute") &&
          child.classList.contains("inset-0") &&
          child.classList.contains("justify-between"),
      );
      return markerIndex > 0 && markerIndex + 1 === troopLabelsIndex;
    }),
  );

  send({
    status: "playing",
    troops: 42000,
    advisor: activeAdvisor({ recommendation: "push" }),
  });
  assert.ok(fills.every((fill) => fill.style.backgroundColor === "#22c55e"));

  fills[0].style.backgroundColor = "";
  triggerMutation(controlPanel);
  assert.equal(fills[0].style.backgroundColor, "#22c55e");

  controlPanel.children = [];
  controlPanel.appendChild(makeTroopBar());
  controlPanel.appendChild(makeTroopBar());
  triggerMutation(controlPanel);
  fills = controlPanel.querySelectorAll(".bg-malibu-blue");
  assert.equal(fills.length, 2);
  assert.ok(fills.every((fill) => fill.style.backgroundColor === "#22c55e"));
  markers = controlPanel.querySelectorAll(
    '[data-openfront-reserve-marker="42"]',
  );
  assert.equal(markers.length, 2);
  assert.ok(markers.every((marker) => marker.style.left === "42%"));

  send({
    status: "playing",
    troops: 42000,
    advisor: activeAdvisor({ recommendation: "retain" }),
  });
  assert.ok(fills.every((fill) => fill.style.backgroundColor === ""));

  send({
    status: "playing",
    troops: 42000,
    advisor: activeAdvisor({ recommendation: "push" }),
  });
  assert.ok(fills.every((fill) => fill.style.backgroundColor === "#22c55e"));
  body.classList.remove("in-game");
  triggerMutation(body);
  assert.ok(fills.every((fill) => fill.style.backgroundColor === ""));
  assert.equal(
    controlPanel.querySelectorAll('[data-openfront-reserve-marker="42"]')
      .length,
    0,
  );
  assert.equal(
    descendants(controlPanel).some((element) => element.textContent === "EXT"),
    false,
  );
});

await test("per-game opt-in, safe names and returning home reset the panel", () => {
  const { context, elements, send, controls } = createContext();
  runInNewContext(source, context);
  const host = elements[0];
  send({ status: "playing", troops: 42000 });
  assert.equal(host.dataset.minimized, "true");
  const siloVisibilityLabel = descendants(host).find(
    (element) => element.tag === "label",
  );
  assert.ok(siloVisibilityLabel);
  assert.equal(siloVisibilityLabel.hidden, true);
  const button = descendants(host).find((element) => element.tag === "button");
  assert.equal(button.textContent, messages.expandAdvisor.message);
  button.listeners.click();
  assert.equal(host.dataset.minimized, "false");
  assert.equal(siloVisibilityLabel.hidden, false);
  assert.equal(button.attributes["aria-pressed"], "true");
  assert.equal(controls[0].data.type, "OPENFRONT_OVERLAY_CONTROL");
  assert.equal(controls[0].data.enabled, true);
  assert.equal(controls[0].origin, "https://openfront.io");
  send({ status: "playing", troops: 42000, advisor: activeAdvisor() });
  assert.equal(button.textContent, messages.collapseAdvisor.message);
  const neighbor = descendants(host).find((element) => element.tag === "li");
  assert.ok(neighbor.textContent.startsWith("<img src=x onerror=alert(1)>"));
  assert.equal(neighbor.children.length, 0);
  button.listeners.click();
  assert.equal(host.dataset.minimized, "true");
  assert.equal(siloVisibilityLabel.hidden, true);
  assert.equal(button.attributes["aria-expanded"], "false");
  assert.equal(controls.at(-1).data.enabled, false);
  send({ status: "playing", troops: 42000 });
  send({ status: "idle", troops: null });
  assert.equal(host.dataset.minimized, "true");
  assert.equal(button.disabled, true);
  send({ status: "playing", troops: 42000 });
  assert.equal(host.dataset.minimized, "true");
  assert.equal(button.disabled, false);
});

await test("advisor stays enabled while waiting for spawn", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send({
    status: "playing",
    troops: 0,
    advisor: activeAdvisor({
      status: "waiting",
      cap: null,
      reservePercent: null,
      incoming: null,
      recommendation: null,
      context: null,
      neighbors: [],
    }),
  });
  const button = descendants(elements[0]).find(
    (element) => element.tag === "button",
  );
  assert.equal(elements[0].dataset.minimized, "false");
  assert.equal(button.attributes["aria-pressed"], "true");
  assert.equal(button.disabled, false);
  assert.ok(
    descendants(elements[0]).some(
      (element) => element.textContent === messages.advisor_waiting.message,
    ),
  );
});

await test("advisor panel does not display PUSH or RETAIN badges", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send({ status: "playing", troops: 42000, advisor: activeAdvisor() });
  for (const recommendation of ["push", "retain"]) {
    send({
      status: "playing",
      troops: 60000,
      advisor: activeAdvisor({ recommendation }),
    });
    const nodes = descendants(elements[0]);
    assert.equal(
      nodes.some((element) => Object.hasOwn(element.dataset, "recommendation")),
      false,
    );
    assert.equal(
      nodes.some((element) => ["PUSH", "RETAIN"].includes(element.textContent)),
      false,
    );
  }
});

await test("advisor panel does not display recommendation during a map re-index", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send({
    status: "playing",
    troops: 60000,
    advisor: activeAdvisor({ recommendation: "push" }),
  });
  send({
    status: "playing",
    troops: 60000,
    advisor: activeAdvisor({
      status: "indexing",
      recommendation: null,
      reservePercent: null,
      incoming: null,
      context: null,
    }),
  });
  send({
    status: "playing",
    troops: 60000,
    advisor: activeAdvisor({
      status: "catchup",
      recommendation: null,
      reservePercent: null,
      incoming: null,
      context: null,
    }),
  });
  send({
    status: "playing",
    troops: 60000,
    advisor: activeAdvisor({ recommendation: "retain" }),
  });
  send({
    status: "playing",
    troops: 60000,
    advisor: activeAdvisor({
      status: "unsupported",
      enabled: false,
      error: "Unsupported client",
    }),
  });
  send({
    status: "playing",
    troops: 60000,
    advisor: activeAdvisor({ recommendation: "retain" }),
  });
  send({ status: "idle", troops: null });
  assert.equal(
    descendants(elements[0]).some((element) =>
      Object.hasOwn(element.dataset, "recommendation"),
    ),
    false,
  );
});

await test("pre-mount state and cached labels survive Chrome context invalidation", () => {
  const { context, elements, send, body, listeners } = createContext("loading");
  runInNewContext(source, context);
  context.chrome.i18n.getMessage = () => {
    throw new Error("Extension context invalidated.");
  };
  send({ status: "playing", troops: 42, advisor: activeAdvisor() });
  context.document.body = body;
  listeners[0].callback();
  assert.equal(elements[0].dataset.minimized, "false");
  assert.doesNotThrow(() =>
    send({ status: "playing", troops: 12345, advisor: activeAdvisor() }),
  );
  assert.doesNotThrow(() => send({ status: "idle", troops: null }));
});

await test("foreign and malformed messages cannot replace active advice", () => {
  const { context, elements, send, errors } = createContext();
  runInNewContext(source, context);
  send({ status: "playing", troops: 42, advisor: activeAdvisor() });
  const before = descendants(elements[0]).map((element) => element.textContent);
  send({ status: "idle", troops: null }, { origin: "https://example.com" });
  send({ status: "idle", troops: null }, { source: {} });
  send({}, { data: { type: "OTHER" } });
  assert.equal(errors.length, 0);
  for (const extra of [
    { status: "invalid" },
    { reservePercent: NaN },
    { cap: -1 },
    { incoming: null },
    { recommendation: null },
    { context: "invalid" },
    { neighbors: [{}] },
  ]) {
    send({ status: "playing", troops: 1000, advisor: activeAdvisor(extra) });
  }
  send({ status: "playing", troops: -1 });
  send({ status: "playing", troops: 1.5 });
  send({
    status: "playing",
    troops: 42,
    advisor: activeAdvisor(),
    controlId: -1,
  });
  assert.equal(errors.length, 10);
  assert.deepEqual(
    descendants(elements[0]).map((element) => element.textContent),
    before,
  );
});

await test("terminal states collapse and retain explicit diagnostics", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  for (const status of ["unsupported", "error", "finished"]) {
    send({
      status: "playing",
      troops: 42,
      advisor: activeAdvisor({
        status,
        enabled: false,
        error: "Missing game API",
      }),
    });
    const nodes = descendants(elements[0]);
    assert.ok(
      nodes.some(
        (element) =>
          element.textContent ===
          `${messages[`advisor_${status}`].message} Missing game API`,
      ),
    );
    const collapse = nodes.find((element) => element.tag === "button");
    assert.equal(collapse.disabled, true);
    const diagnostic = nodes.find(
      (element) => element.attributes.role === "status",
    );
    assert.equal(diagnostic.hidden, false);
    const header = nodes.find((element) => element.tag === "header");
    assert.ok(header.children.includes(diagnostic));
    collapse.listeners.click();
    assert.equal(collapse.attributes["aria-expanded"], "false");
    assert.equal(collapse.textContent, messages.expandAdvisor.message);
    assert.equal(elements[0].dataset.minimized, "true");
  }
});

await test("UI keeps accessible names and renders the silo visibility checkbox", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send({ status: "playing", troops: 42, advisor: activeAdvisor() });
  const nodes = descendants(elements[0]);
  assert.equal(nodes.filter((element) => element.tag === "input").length, 1);
  assert.equal(nodes.filter((element) => element.tag === "label").length, 1);
  assert.equal(
    nodes.some(
      (element) => element.textContent === messages.findEnemySilos.message,
    ),
    true,
  );
  assert.equal(
    nodes.some(
      (element) => element.textContent === messages.advisorTitle.message,
    ),
    false,
  );
  assert.equal(
    nodes.find((element) => element.tag === "section").attributes["aria-label"],
    messages.advisorTitle.message,
  );
  const status = nodes.find((element) => element.attributes.role === "status");
  assert.equal(status.hidden, true);
  assert.equal(status.textContent, "");
});

await test("incoming attack details are not shown in the overlay", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send({
    status: "playing",
    troops: 1000,
    advisor: activeAdvisor({ incoming: 0, recommendation: "push" }),
  });
  const nodes = descendants(elements[0]);
  assert.equal(
    nodes.some((element) => Object.hasOwn(element.dataset, "urgent")),
    false,
  );
  assert.equal(
    nodes.some((element) =>
      element.textContent.startsWith("Incoming attacks:"),
    ),
    false,
  );
  assert.equal(
    nodes.some((element) => Object.hasOwn(element.dataset, "recommendation")),
    false,
  );
});

await test("activation during loading and rapid toggles ignore older bridge acknowledgements", () => {
  const { context, elements, send, controls } = createContext();
  runInNewContext(source, context);
  send({ status: "waiting", troops: null });
  const host = elements[0];
  const button = descendants(host).find((element) => element.tag === "button");
  assert.equal(button.disabled, false);
  button.listeners.click();
  assert.equal(host.dataset.minimized, "false");
  button.listeners.click();
  assert.equal(host.dataset.minimized, "true");
  send({ status: "waiting", troops: null, controlId: 0 });
  send({
    status: "waiting",
    troops: null,
    controlId: 1,
    advisor: activeAdvisor({ status: "waiting" }),
  });
  assert.equal(host.dataset.minimized, "true");
  send({ status: "waiting", troops: null, controlId: 2 });
  assert.equal(host.dataset.minimized, "true");
  button.listeners.click();
  send({
    status: "waiting",
    troops: null,
    advisor: activeAdvisor({ status: "waiting" }),
  });
  assert.equal(host.dataset.minimized, "false");
  assert.equal(controls.at(-1).data.enabled, true);
  send({ status: "playing", troops: 42, advisor: activeAdvisor() });
  assert.equal(host.dataset.minimized, "false");
});

await test("packaged MAIN bridge and isolated UI agree on loading activation and reset", () => {
  const { context, elements, send, controls } = createContext();
  let inGame = true;
  let poll;
  context.document.body.classList = { contains: () => inGame };
  context.document.querySelector = () => null;
  context.window.setInterval = (callback) => {
    poll = callback;
    return 1;
  };
  context.window.clearInterval = () => {};
  context.window.removeEventListener = () => {};
  context.window.postMessage = (data, origin) => {
    controls.push({ data, origin });
    send({}, { data });
  };
  runInNewContext(source, context);
  runInNewContext(readFileSync(new URL("inject.js", base), "utf8"), context);
  const host = elements[0];
  const button = descendants(host).find((element) => element.tag === "button");
  assert.equal(host.dataset.minimized, "true");
  assert.equal(button.disabled, false);
  button.listeners.click();
  assert.equal(host.dataset.minimized, "false");
  assert.equal(controls.at(-1).data.advisor.enabled, true);
  assert.equal(controls.at(-1).data.advisor.status, "waiting");
  assert.equal(controls.at(-1).data.controlId, 1);
  poll();
  assert.equal(host.dataset.minimized, "false");
  button.listeners.click();
  assert.equal(host.dataset.minimized, "true");
  assert.equal(controls.at(-1).data.advisor.enabled, false);
  assert.equal(controls.at(-1).data.controlId, 2);
  button.listeners.click();
  inGame = false;
  poll();
  assert.equal(host.dataset.minimized, "true");
  assert.equal(button.disabled, true);
  inGame = true;
  poll();
  assert.equal(controls.at(-1).data.advisor.enabled, false);
  assert.equal(host.dataset.minimized, "true");
});

await test("all phases and neighbor troop counts display correctly", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  for (const phase of [
    "opening",
    "economy",
    "contested",
    "nuclear",
    "endgame",
  ]) {
    for (const raw of [0, 9, 123456]) {
      send({
        status: "playing",
        troops: raw,
        advisor: activeAdvisor({ context: phase }),
      });
      const texts = descendants(elements[0]).map(
        (element) => element.textContent,
      );
      assert.ok(texts.includes(messages[`phase_${phase}`].message));
      assert.ok(
        texts.includes(
          `Ally - ${messages.friendlyNeighbor.message}: ${displayedTroops(80000)}`,
        ),
      );
      assert.equal(
        texts.some((text) => text.includes("Troop reserves:")),
        false,
      );
      assert.equal(
        texts.some((text) => text.startsWith("Incoming attacks:")),
        false,
      );
      assert.equal(elements.length, 2);
    }
  }
});

await test("missing localization fails explicitly without mounting incomplete UI", () => {
  const { context, elements } = createContext();
  context.chrome.i18n.getMessage = () => "";
  assert.throws(
    () => runInNewContext(source, context),
    /Missing translation: advisorTitle/,
  );
  assert.equal(elements.length, 0);
});
