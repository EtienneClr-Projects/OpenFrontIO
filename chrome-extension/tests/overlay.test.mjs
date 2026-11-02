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
  const body = { appendChild: (element) => elements.push(element) };
  const document = {
    readyState,
    body: readyState === "loading" ? null : body,
    createElement: (tag) => ({
      tag,
      dataset: {},
      children: [],
      textContent: "",
      attributes: {},
      listeners: {},
      appendChild(child) {
        this.children.push(child);
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
      attachShadow() {
        this.shadowRoot = document.createElement("shadow-root");
        return this.shadowRoot;
      },
    }),
    getElementById: (id) => elements.find((element) => element.id === id),
    addEventListener: (event, callback, options) =>
      listeners.push({ event, callback, options }),
  };
  const context = {
    document,
    chrome: { i18n: { getMessage: (key) => messages[key]?.message ?? "" } },
    window: {
      location: { origin: "https://openfront.io" },
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
      data: { type: "OPENFRONT_OVERLAY_STATE", ...data },
      ...overrides,
    };
    for (const listener of windowListeners) listener.callback(event);
  }
  return { context, elements, listeners, body, send, errors, controls };
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
    assert.equal(elements.length, 1);
    assert.equal(elements[0].id, "openfront-advisor-ui");
    assert.equal(elements[0].dataset.minimized, "true");
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
    assert.equal(elements.length, 1);
  });
}

await test("per-game opt-in, safe names and returning home reset the panel", () => {
  const { context, elements, send, controls } = createContext();
  runInNewContext(source, context);
  const host = elements[0];
  send({ status: "playing", troops: 42000 });
  assert.equal(host.dataset.minimized, "false");
  const checkbox = descendants(host).find(
    (element) => element.type === "checkbox",
  );
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  checkbox.listeners.change();
  assert.equal(controls[0].data.type, "OPENFRONT_OVERLAY_CONTROL");
  assert.equal(controls[0].data.enabled, true);
  assert.equal(controls[0].origin, "https://openfront.io");
  send({ status: "playing", troops: 42000, advisor: activeAdvisor() });
  assert.equal(checkbox.checked, true);
  const neighbor = descendants(host).find((element) => element.tag === "li");
  assert.ok(neighbor.textContent.startsWith("<img src=x onerror=alert(1)>"));
  assert.equal(neighbor.children.length, 0);
  send({ status: "idle", troops: null });
  assert.equal(host.dataset.minimized, "true");
  assert.equal(checkbox.checked, false);
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
    { context: "invalid" },
    { neighbors: [{}] },
  ]) {
    send({ status: "playing", troops: 1000, advisor: activeAdvisor(extra) });
  }
  send({ status: "playing", troops: -1 });
  send({ status: "playing", troops: 1.5 });
  assert.equal(errors.length, 8);
  assert.deepEqual(
    descendants(elements[0]).map((element) => element.textContent),
    before,
  );
});

await test("unsupported status is explicit and panel can be minimized", () => {
  const { context, elements, send } = createContext();
  runInNewContext(source, context);
  send({
    status: "playing",
    troops: 42,
    advisor: activeAdvisor({
      status: "unsupported",
      enabled: false,
      error: "Missing game API",
    }),
  });
  const nodes = descendants(elements[0]);
  assert.ok(
    nodes.some(
      (element) => element.textContent === messages.advisor_unsupported.message,
    ),
  );
  assert.ok(
    nodes.some((element) => element.textContent === "Missing game API"),
  );
  assert.equal(
    nodes.find((element) => element.type === "checkbox").disabled,
    true,
  );
  const collapse = nodes.find((element) => element.tag === "button");
  collapse.listeners.click();
  assert.equal(collapse.attributes["aria-expanded"], "false");
  assert.equal(collapse.textContent, messages.expandAdvisor.message);
  assert.equal(elements[0].dataset.minimized, "true");
});

await test("all phases and troop metrics retain one-decimal display units without a separate badge", () => {
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
          `${messages.incoming.message}: ${displayedTroops(1234)}`,
        ),
      );
      assert.ok(
        texts.includes(
          `${messages.reserve.message}: 42% (${displayedTroops(raw)} / ${displayedTroops(100000)})`,
        ),
      );
      assert.ok(
        texts.includes(
          `Ally - ${messages.friendlyNeighbor.message}: ${displayedTroops(80000)}`,
        ),
      );
      assert.equal(elements.length, 1);
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
