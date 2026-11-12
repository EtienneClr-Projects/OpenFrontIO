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
    notation: "compact",
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

function strategySnapshot(extra = {}) {
  return {
    status: "ready",
    error: null,
    threatError: null,
    threats: [],
    builds: [
      {
        type: "City",
        reason: "foundation",
        cost: "125000",
        shortfall: "0",
        affordable: true,
        paused: false,
        placement: "valid",
        tile: 123,
        constructionSeconds: 2,
      },
    ],
    ...extra,
  };
}

await test("strategy cards refresh independently with exact gold, safe text and separate threat levels", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  const snapshot = {
    status: "playing",
    troops: 42000,
    advisor: activeAdvisor(),
  };
  const text = () =>
    descendants(elements[0])
      .map((e) => e.textContent)
      .join("\n");
  send({
    ...snapshot,
    strategy: strategySnapshot({
      threats: [
        { kind: "attack", id: 2, name: "<img src=x>", troops: 1230 },
        { kind: "neighbor", id: 3, name: "Neighbor", troops: 10000 },
        { kind: "capability", id: 4, name: "Silo owner", troops: 0 },
        { kind: "missile", id: 7, name: "Launcher", troops: 0 },
      ],
    }),
  });
  assert.match(text(), /City affordable now/);
  assert.match(
    text(),
    /Human attack underway: <img src=x> - 123 committed troops/,
  );
  assert.match(text(), /No attack implied/);
  assert.match(text(), /No launch implied/);
  assert.match(text(), /blast area overlaps your territory/);
  assert.equal(
    descendants(elements[0]).some((e) => e.tag === "img"),
    false,
  );
  const saving = strategySnapshot();
  Object.assign(saving.builds[0], {
    affordable: false,
    shortfall: "1",
    placement: "saving",
    tile: null,
  });
  send({ ...snapshot, strategy: saving });
  assert.match(text(), /need 1 more/);
  assert.doesNotMatch(text(), /City affordable now/);
  const paused = strategySnapshot();
  Object.assign(paused.builds[0], {
    paused: true,
    placement: "paused",
    tile: null,
  });
  send({ ...snapshot, strategy: paused });
  assert.match(text(), /Hold economy spending/);
  const noPlacement = strategySnapshot();
  Object.assign(noPlacement.builds[0], { placement: "not-found", tile: null });
  send({ ...snapshot, strategy: noPlacement });
  assert.ok(text().includes(messages.placement_not_found.message));
  send({
    ...snapshot,
    strategy: strategySnapshot({
      status: "unavailable",
      error: "Missing player.buildables().",
      builds: [],
      threats: [{ kind: "attack", id: 2, name: "Human", troops: 1000 }],
    }),
  });
  assert.match(text(), /Advice unavailable/);
  assert.match(text(), /Missing player.buildables/);
  assert.match(
    text(),
    /Human attack underway/,
    "cost failure does not hide detected threats",
  );
  send({
    ...snapshot,
    strategy: strategySnapshot({ status: "checking", builds: [] }),
  });
  assert.doesNotMatch(
    text(),
    /No observed human attacks/,
    "indexing is not evidence that the game is safe",
  );
});

await test("strategy payload validation rejects malformed costs, forged valid placements and unknown kinds", () => {
  const { context, elements, send, errors } = createContext();
  runInNewContext(source, context);
  const snapshot = {
    status: "playing",
    troops: 42000,
    advisor: activeAdvisor(),
  };
  send({ ...snapshot, strategy: strategySnapshot() });
  const bad = [
    { status: "success" },
    { error: 123 },
    { threats: [{ kind: "launch", id: 1, name: "Name", troops: 0 }] },
    { threats: [{ kind: "attack", id: 1, name: "x".repeat(201), troops: 0 }] },
    { builds: [{ ...strategySnapshot().builds[0], cost: "1e9" }] },
    { builds: [{ ...strategySnapshot().builds[0], cost: "-1" }] },
    { builds: [{ ...strategySnapshot().builds[0], type: "__proto__" }] },
    { builds: [{ ...strategySnapshot().builds[0], tile: null }] },
    { builds: [{ ...strategySnapshot().builds[0], affordable: false }] },
    { builds: [{ ...strategySnapshot().builds[0], paused: true }] },
    { builds: [{ ...strategySnapshot().builds[0], constructionSeconds: -1 }] },
  ];
  for (const extra of bad)
    send({ ...snapshot, strategy: strategySnapshot(extra) });
  assert.equal(errors.length, bad.length);
  assert.ok(
    descendants(elements[0]).some((e) =>
      e.textContent.includes("City affordable now"),
    ),
  );
  send({ ...snapshot, strategy: null });
  assert.equal(
    descendants(elements[0]).some((e) =>
      e.textContent.includes("City affordable now"),
    ),
    false,
  );
});

await test("build placements use a labeled click-through layer, track position and clear on disable", () => {
  const { context, elements, send, controls, errors } = createContext();
  context.document.body.classList.add("in-game");
  runInNewContext(source, context);
  send({
    status: "playing",
    troops: 42000,
    advisor: activeAdvisor(),
    strategy: strategySnapshot(),
  });
  const layer = elements.find((e) => e.id === "openfront-build-placements");
  assert.equal(layer.style.pointerEvents, "none");
  assert.equal(layer.style.zIndex, "2147483646");
  const markers = [{ id: 0, type: "City", x: 200, y: 200, radius: 12 }];
  const show = (buildMarkers, extra = {}) =>
    send({
      type: "OPENFRONT_OVERLAY_BUILDS",
      buildMarkers,
      controlId: 0,
      ...extra,
    });
  show(markers);
  let ring = descendants(layer).find(
    (e) => e.dataset.openfrontBuildPlacement === "0",
  );
  assert.equal(ring.style.left, "200px");
  assert.ok(
    descendants(ring).some((e) => e.textContent === messages.buildCity.message),
  );
  show([{ ...markers[0], x: 300, y: 250 }]);
  assert.equal(ring.style.left, "300px");
  assert.equal(ring.style.top, "250px");
  show([{ ...markers[0], type: "Unknown" }]);
  assert.equal(errors.length, 1);
  const collapse = descendants(elements[0]).find((e) => e.tag === "button");
  collapse.listeners.click();
  assert.equal(controls.at(-1).data.enabled, false);
  assert.equal(
    descendants(layer).some((e) => e.dataset.openfrontBuildPlacement === "0"),
    false,
  );
  show(markers);
  assert.equal(
    descendants(layer).some((e) => e.dataset.openfrontBuildPlacement === "0"),
    false,
    "late markers cannot revive disabled UI",
  );
});

await test("human and missile warnings are localized, validated, activation-gated and cleared on exit", () => {
  const { context, elements, send, errors } = createContext();
  runInNewContext(source, context);
  send({ type: "OPENFRONT_OVERLAY_HUMAN_ATTACK", playerNames: ["Enemy"] });
  assert.equal(
    elements.some((e) => e.id === "openfront-human-attack-warning"),
    false,
  );
  send({ status: "playing", troops: 42000, advisor: activeAdvisor() });
  send({ type: "OPENFRONT_OVERLAY_HUMAN_ATTACK", playerNames: ["Enemy"] });
  send({ type: "OPENFRONT_OVERLAY_MISSILE_THREAT", playerNames: ["Nuker"] });
  const attack = elements.find(
    (e) => e.id === "openfront-human-attack-warning",
  );
  const missile = elements.find(
    (e) => e.id === "openfront-missile-threat-warning",
  );
  assert.equal(
    attack.textContent,
    messages.humanAttackWarning.message.replace("{name}", "Enemy"),
  );
  assert.match(missile.textContent, /may not finish in time/);
  assert.equal(attack.style.pointerEvents, "none");
  send({ type: "OPENFRONT_OVERLAY_HUMAN_ATTACK", playerNames: [7] });
  assert.equal(errors.length, 1);
  send({ status: "idle", troops: null });
  assert.equal(attack.style.display, "none");
  assert.equal(missile.style.display, "none");
});

await test("live player lists follow stronger neighbors and refresh without advisor changes", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  const snapshot = {
    status: "playing",
    troops: 42000,
    advisor: activeAdvisor(),
  };
  const headings = () =>
    descendants(elements[0])
      .filter((element) => element.tag === "h3")
      .map((element) => element.textContent);
  const items = () =>
    descendants(elements[0]).filter((element) => element.tag === "li");
  send({
    ...snapshot,
    playerLists: {
      richPlayers: [{ id: 2, name: "<b>Rich player</b>" }],
      traitorNeighbors: [{ id: 4, name: "Traitor" }],
    },
  });
  assert.deepEqual(headings().slice(-3), [
    messages.strongNeighbors.message,
    messages.richPlayers.message,
    messages.traitorNeighbors.message,
  ]);
  assert.deepEqual(
    items()
      .slice(-2)
      .map((item) => item.textContent),
    ["<b>Rich player</b>", "Traitor"],
  );
  assert.equal(items().at(-2).children.length, 0, "names are text, not markup");
  const richCheckbox = descendants(elements[0]).find(
    (element) =>
      element.tag === "input" &&
      element.attributes["aria-label"] === messages.watchRichPlayers.message,
  );
  richCheckbox.checked = false;
  richCheckbox.listeners.change();
  send({
    ...snapshot,
    playerLists: {
      richPlayers: [{ id: 5, name: "New rich player" }],
      traitorNeighbors: [],
    },
  });
  assert.equal(items().at(-1).textContent, "New rich player");
  assert.equal(
    items().some((item) => item.textContent === "Traitor"),
    false,
  );
  assert.ok(
    descendants(elements[0]).some(
      (element) => element.textContent === messages.noTraitorNeighbors.message,
    ),
  );
  send({
    ...snapshot,
    playerLists: { richPlayers: [], traitorNeighbors: null },
  });
  assert.ok(
    descendants(elements[0]).some(
      (element) => element.textContent === messages.noRichPlayers.message,
    ),
  );
  assert.ok(
    descendants(elements[0]).some(
      (element) =>
        element.textContent === messages.playerListUnavailable.message,
    ),
  );
  send({ status: "idle", troops: null });
  assert.equal(items().length, 0);
});

await test("empty overlay lists display a simple dash below each title", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send({
    status: "playing",
    troops: 42000,
    advisor: activeAdvisor({ neighbors: [] }),
    playerLists: { richPlayers: [], traitorNeighbors: [] },
  });
  const headings = descendants(elements[0]).filter(
    (element) => element.tag === "h3",
  );
  assert.deepEqual(
    headings.slice(-3).map((heading) => {
      const siblings = heading.parentElement.children;
      const placeholder = siblings[siblings.indexOf(heading) + 1];
      return [heading.textContent, placeholder.tag, placeholder.textContent];
    }),
    [
      [messages.strongNeighbors.message, "p", "-"],
      [messages.richPlayers.message, "p", "-"],
      [messages.traitorNeighbors.message, "p", "-"],
    ],
  );
});

await test("malformed and foreign player lists cannot replace displayed lists", () => {
  const { context, elements, send, errors } = createContext();
  runInNewContext(source, context);
  const snapshot = {
    status: "playing",
    troops: 42000,
    advisor: activeAdvisor(),
  };
  const good = { richPlayers: [{ id: 2, name: "Rich" }], traitorNeighbors: [] };
  send({ ...snapshot, playerLists: good });
  const malformed = [
    null,
    {},
    { ...good, richPlayers: "Rich" },
    { ...good, richPlayers: [null] },
    { ...good, richPlayers: [{ id: -1, name: "Bad" }] },
    { ...good, richPlayers: [{ id: 2, name: 7 }] },
    { ...good, richPlayers: [{ id: 2, name: "x".repeat(201) }] },
    { ...good, richPlayers: [good.richPlayers[0], good.richPlayers[0]] },
    {
      ...good,
      traitorNeighbors: Array.from({ length: 513 }, (_, id) => ({
        id,
        name: "Bad",
      })),
    },
  ];
  for (const playerLists of malformed) send({ ...snapshot, playerLists });
  assert.equal(errors.length, malformed.length);
  send(
    { ...snapshot, playerLists: { richPlayers: [], traitorNeighbors: [] } },
    { origin: "https://example.com" },
  );
  send(
    { ...snapshot, playerLists: { richPlayers: [], traitorNeighbors: [] } },
    { source: {} },
  );
  assert.ok(
    descendants(elements[0]).some((element) => element.textContent === "Rich"),
  );
});

await test("localized MV3 manifest loads only the advisor and packaged bridge", () => {
  for (const key of Object.keys(messages))
    assert.match(key, /^[A-Za-z0-9_]+$/, `Invalid Chrome locale key: ${key}`);
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
    assert.equal(elements.length, 5);
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
    assert.equal(elements.length, 5);
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

await test("pirate warships are circled and the markers follow the monitor checkbox", () => {
  const { context, elements, send } = createContext();
  context.document.body.classList.add("in-game");
  runInNewContext(source, context);
  const checkboxes = descendants(elements[0]).filter(
    (element) => element.tag === "input",
  );
  const monitor = checkboxes[1];
  assert.equal(monitor.checked, true);
  assert.equal(
    monitor.attributes["aria-label"],
    messages.monitorPirates.message,
  );
  send(
    {},
    {
      data: {
        type: "OPENFRONT_OVERLAY_PIRATE_WARSHIPS",
        pirateWarships: [{ id: 7, x: 200, y: 150, radius: 20 }],
      },
    },
  );
  const layer = elements.find(
    (element) => element.id === "openfront-pirate-warships",
  );
  assert.ok(layer);
  assert.equal(layer.style.display, "block");
  const ring = descendants(layer).find(
    (element) => element.dataset.openfrontPirateWarship === "7",
  );
  assert.ok(ring);
  assert.equal(ring.style.left, "200px");
  assert.equal(ring.style.top, "150px");
  assert.equal(ring.style.borderRadius, "50%");
  monitor.checked = false;
  monitor.listeners.change();
  assert.equal(layer.style.display, "none");
  send(
    {},
    {
      data: {
        type: "OPENFRONT_OVERLAY_PIRATE_WARSHIPS",
        pirateWarships: [],
      },
    },
  );
  assert.equal(
    descendants(layer).some(
      (element) => element.dataset.openfrontPirateWarship === "7",
    ),
    false,
  );
});

await test("pirate alert shows below center and respects the monitor checkbox", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send({}, { data: { type: "OPENFRONT_OVERLAY_PIRATE_ALERT" } });
  const warning = elements.find(
    (element) => element.id === "openfront-pirate-warning",
  );
  assert.ok(warning);
  assert.equal(warning.textContent, messages.pirateWarning.message);
  assert.equal(warning.style.top, "65%");

  const other = createContext();
  runInNewContext(source, other.context);
  const monitor = descendants(other.elements[0]).filter(
    (element) => element.tag === "input",
  )[1];
  monitor.checked = false;
  monitor.listeners.change();
  other.send({}, { data: { type: "OPENFRONT_OVERLAY_PIRATE_ALERT" } });
  assert.equal(
    other.elements.some((element) => element.id === "openfront-pirate-warning"),
    false,
  );
});

await test("rich player warnings name the players and respect the rich player checkbox", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send(
    {},
    {
      data: {
        type: "OPENFRONT_OVERLAY_RICH_PLAYER",
        playerNames: ["Alice", "Bob"],
      },
    },
  );
  const rich = elements.find(
    (element) => element.id === "openfront-rich-player-warning",
  );
  assert.ok(rich);
  assert.equal(
    rich.textContent,
    messages.richPlayerWarning.message.replace("{name}", "Alice, Bob"),
  );
  assert.equal(rich.style.top, "20%");
  send(
    {},
    {
      data: {
        type: "OPENFRONT_OVERLAY_ABANDONED_RICH_PLAYER",
        playerNames: ["Carol"],
      },
    },
  );
  const free = elements.find(
    (element) => element.id === "openfront-abandoned-rich-warning",
  );
  assert.ok(free);
  assert.equal(
    free.textContent,
    messages.abandonedRichPlayerWarning.message.replace("{name}", "Carol"),
  );
  assert.equal(free.style.top, "50%");

  const other = createContext();
  runInNewContext(source, other.context);
  const watch = descendants(other.elements[0]).filter(
    (element) => element.tag === "input",
  )[2];
  assert.equal(watch.checked, true);
  assert.equal(
    watch.attributes["aria-label"],
    messages.watchRichPlayers.message,
  );
  watch.checked = false;
  watch.listeners.change();
  other.send(
    {},
    {
      data: {
        type: "OPENFRONT_OVERLAY_ABANDONED_RICH_PLAYER",
        playerNames: ["Carol"],
      },
    },
  );
  assert.equal(
    other.elements.some(
      (element) => element.id === "openfront-abandoned-rich-warning",
    ),
    false,
  );
});

await test("inactive neighbor warning names players and follows its own checkbox", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send(
    {},
    {
      data: {
        type: "OPENFRONT_OVERLAY_INACTIVE_NEIGHBOR",
        playerNames: ["Dave"],
      },
    },
  );
  const warning = elements.find(
    (element) => element.id === "openfront-inactive-neighbor-warning",
  );
  assert.ok(warning);
  assert.equal(
    warning.textContent,
    messages.inactiveNeighborWarning.message.replace("{name}", "Dave"),
  );
  assert.equal(warning.style.top, "80%");

  const other = createContext();
  runInNewContext(source, other.context);
  const inputs = descendants(other.elements[0]).filter(
    (element) => element.tag === "input",
  );
  assert.equal(
    inputs[3].attributes["aria-label"],
    messages.watchInactiveNeighbors.message,
  );
  inputs[3].checked = false;
  inputs[3].listeners.change();
  other.send(
    {},
    {
      data: {
        type: "OPENFRONT_OVERLAY_INACTIVE_NEIGHBOR",
        playerNames: ["Dave"],
      },
    },
  );
  assert.equal(
    other.elements.some(
      (element) => element.id === "openfront-inactive-neighbor-warning",
    ),
    false,
  );
  // Rich player warnings are unaffected by the neighbor checkbox.
  other.send(
    {},
    {
      data: { type: "OPENFRONT_OVERLAY_RICH_PLAYER", playerNames: ["Dave"] },
    },
  );
  assert.ok(
    other.elements.some(
      (element) => element.id === "openfront-rich-player-warning",
    ),
  );
  // Inherited object keys are not message types.
  other.send({}, { data: { type: "constructor" } });
});

await test("traitor neighbor warning displays validated names", () => {
  const { context, elements, send, errors } = createContext();
  runInNewContext(source, context);
  send(
    {},
    { data: { type: "OPENFRONT_OVERLAY_TRAITOR_NEIGHBOR", playerNames: [] } },
  );
  assert.equal(errors.length, 1);
  send(
    {},
    {
      data: {
        type: "OPENFRONT_OVERLAY_TRAITOR_NEIGHBOR",
        playerNames: ["Alice", "Bob"],
      },
    },
  );
  const warning = elements.find(
    (element) => element.id === "openfront-traitor-neighbor-warning",
  );
  assert.ok(warning);
  assert.equal(
    warning.textContent,
    messages.traitorNeighborWarning.message.replace("{name}", "Alice, Bob"),
  );
});

await test("invalid rich player messages are rejected", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  for (const playerNames of [
    undefined,
    [],
    [1],
    ["a", "b", "c", "d", "e", "f"],
  ])
    send({}, { data: { type: "OPENFRONT_OVERLAY_RICH_PLAYER", playerNames } });
  assert.equal(
    elements.some((element) => element.id === "openfront-rich-player-warning"),
    false,
  );
});

await test("abandoned rich territories are circled in orange and follow the checkbox", () => {
  const { context, elements, send } = createContext();
  context.document.body.classList.add("in-game");
  runInNewContext(source, context);
  const layer = elements.find(
    (element) => element.id === "openfront-abandoned-territories",
  );
  assert.ok(layer);
  send(
    {},
    {
      data: {
        type: "OPENFRONT_OVERLAY_ABANDONED_TERRITORIES",
        abandonedPlayers: [{ id: 3, x: 200, y: 150, radius: 300 }],
      },
    },
  );
  const ring = descendants(layer).find(
    (element) => element.dataset.openfrontAbandonedTerritory === "3",
  );
  assert.ok(ring);
  assert.equal(ring.style.borderRadius, "50%");
  assert.match(ring.style.border, /#ff8c00/);
  assert.equal(ring.style.width, "600px");
  assert.equal(ring.dataset.offscreen, "false");
  const watch = descendants(elements[0]).filter(
    (element) => element.tag === "input",
  )[2];
  watch.checked = false;
  watch.listeners.change();
  assert.equal(layer.style.display, "none");
  send(
    {},
    {
      data: {
        type: "OPENFRONT_OVERLAY_ABANDONED_TERRITORIES",
        abandonedPlayers: [{ id: 3, x: 0, y: 0, radius: 401 }],
      },
    },
  );
  assert.ok(
    descendants(layer).some(
      (element) => element.dataset.openfrontAbandonedTerritory === "3",
    ),
  );
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
  const nodes = descendants(elements[0]);
  assert.ok(
    nodes.some(
      (element) => element.textContent === messages.advisor_waiting.message,
    ),
  );
  const style = nodes.find((element) => element.tag === "style");
  assert.match(style.textContent, /header \{[^}]*display: grid/);
  assert.match(
    style.textContent,
    /header > \[role="status"\] \{[^}]*grid-column: 1 \/ -1;[^}]*min-width: 0;/,
  );
  assert.match(style.textContent, /\.settings \{[^}]*flex-wrap: wrap;/);
  assert.equal(
    nodes.find((element) => element.className === "settings").children.length,
    4,
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

await test("terminal states retain explicit diagnostics", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  for (const status of ["unsupported", "error"]) {
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
  send({
    status: "playing",
    troops: 42,
    advisor: activeAdvisor({
      status: "finished",
      enabled: false,
    }),
  });
  const nodes = descendants(elements[0]);
  const diagnostic = nodes.find(
    (element) => element.attributes.role === "status",
  );
  const collapse = nodes.find((element) => element.tag === "button");
  assert.equal(diagnostic.hidden, false);
  assert.equal(diagnostic.textContent, messages.advisor_finished.message);
  assert.equal(collapse.disabled, true);
  assert.equal(collapse.attributes["aria-expanded"], "true");
  assert.equal(elements[0].dataset.minimized, "false");
});

await test("UI keeps accessible names and renders the silo visibility checkbox", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send({ status: "playing", troops: 42, advisor: activeAdvisor() });
  const nodes = descendants(elements[0]);
  assert.equal(nodes.filter((element) => element.tag === "input").length, 4);
  assert.equal(nodes.filter((element) => element.tag === "label").length, 4);
  assert.equal(
    nodes.some(
      (element) => element.textContent === messages.findEnemySilos.message,
    ),
    true,
  );
  assert.equal(
    nodes.some(
      (element) => element.textContent === messages.monitorPirates.message,
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
  assert.equal(host.dataset.minimized, "false", "enabled by default");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, messages.collapseAdvisor.message);
  assert.equal(messages.collapseAdvisor.message, "Disable");
  assert.equal(controls.at(-1).data.advisor.enabled, true);
  assert.equal(controls.at(-1).data.advisor.status, "waiting");
  poll();
  assert.equal(host.dataset.minimized, "false");
  button.listeners.click();
  assert.equal(host.dataset.minimized, "true");
  assert.equal(controls.at(-1).data.advisor.enabled, false);
  assert.equal(controls.at(-1).data.controlId, 1);
  poll();
  assert.equal(
    host.dataset.minimized,
    "true",
    "disable persists while polling",
  );
  button.listeners.click();
  assert.equal(host.dataset.minimized, "false");
  assert.equal(controls.at(-1).data.advisor.enabled, true);
  assert.equal(controls.at(-1).data.controlId, 2);
  button.listeners.click();
  inGame = false;
  poll();
  assert.equal(host.dataset.minimized, "true");
  assert.equal(button.disabled, true);
  inGame = true;
  poll();
  assert.equal(
    controls.at(-1).data.advisor.enabled,
    true,
    "a new game is enabled again",
  );
  assert.equal(host.dataset.minimized, "false");
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
      assert.equal(elements.length, 5);
    }
  }
});

await test("stronger neighbors show non-allies first, colored and compact", () => {
  const { context, elements, send } = createContext();
  context.Intl = {
    NumberFormat: class extends Intl.NumberFormat {
      constructor(_locale, options) {
        super("en-US", options);
      }
    },
  };
  runInNewContext(source, context);
  const neighbors = [
    { id: 1, name: "Ally", friendly: true, troops: 11499990 },
    { id: 2, name: "Enemy", friendly: false, troops: 680490 },
    { id: 3, name: "Other", friendly: false, troops: 12000 },
    { id: 4, name: "Friend", friendly: true, troops: 999 },
  ];
  send({
    status: "playing",
    troops: 42,
    advisor: activeAdvisor({ neighbors }),
  });

  const host = elements[0];
  const items = descendants(host).filter((element) => element.tag === "li");
  assert.deepEqual(
    items.map((item) => item.textContent),
    [
      `Enemy - ${messages.hostileNeighbor.message}: 68K`,
      `Other - ${messages.hostileNeighbor.message}: 1.2K`,
      `Ally - ${messages.friendlyNeighbor.message}: 1.1M`,
      `Friend - ${messages.friendlyNeighbor.message}: 99.9`,
    ],
  );
  assert.deepEqual(
    items.map((item) => item.className),
    ["hostile", "hostile", "friendly", "friendly"],
  );
  const stylesheet = descendants(host).find(
    (element) => element.tag === "style",
  );
  assert.match(stylesheet.textContent, /li\.friendly \{ color: #86efac; \}/);
  assert.match(stylesheet.textContent, /li\.hostile \{ color: #fca5a5; \}/);

  send({
    status: "playing",
    troops: 42,
    advisor: activeAdvisor({
      neighbors: neighbors.map((neighbor) =>
        neighbor.id === 1 ? { ...neighbor, friendly: false } : neighbor,
      ),
    }),
  });
  const updated = descendants(host).filter((element) => element.tag === "li");
  assert.ok(updated[0].textContent.startsWith("Ally - "));
  assert.equal(updated[0].className, "hostile");
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
