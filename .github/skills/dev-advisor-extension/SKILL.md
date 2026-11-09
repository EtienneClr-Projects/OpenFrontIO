---
name: dev-advisor-extension
description: Explain, modify, debug, build, or test the OpenFront advisor Chrome extension under chrome-extension/. Use for its read-only strategy analysis, native HUD integration, enemy silo markers, transport warnings, pirate tracking, localization, and compatibility with the deployed game client.
---

# Developing the advisor extension

## Start here

This is a standalone Manifest V3 Chrome extension, not a feature compiled into
the game. Its packaged directory is
[`chrome-extension/openfront-overlay/`](../../../chrome-extension/openfront-overlay/).
It works against the normal remote OpenFront client and localhost.
Keep changes read-only: display information and guidance, never issue gameplay
intents, automate actions, or introduce privileged commands from page messages.

Before editing:

1. Read the relevant implementation and tests below, plus any applicable
   repository instructions.
2. Identify whether the change belongs in the isolated UI, MAIN-world bridge,
   or observer analysis. Follow the actual data path rather than changing the
   game renderer for extension-only behavior.
3. Check current source before relying on documentation or remembered behavior.
   The deployed client's private APIs may differ from this checkout.

## File map and information sources

Paths in commands below are relative to the repository root.

| Source | What to find there |
| --- | --- |
| [manifest.json](../../../chrome-extension/openfront-overlay/manifest.json) | Supported origins, Chrome minimum, declarative script worlds and injection timing |
| [src/Main.ts](../../../chrome-extension/src/Main.ts) | Game discovery, bridge messages, polling, projections, silo/transport/pirate detection and teardown |
| [src/Observer.ts](../../../chrome-extension/src/Observer.ts) | Remote client interfaces, API guards, observation, recommendation, incremental map indexing and update hook |
| [content.js](../../../chrome-extension/openfront-overlay/content.js) | Isolated UI, message validation, controls, warning styles, marker rendering and native troop-bar integration |
| [English messages](../../../chrome-extension/openfront-overlay/_locales/en/messages.json) | Chrome i18n labels and warning text |
| [build.mjs](../../../chrome-extension/src/build.mjs) | Standalone bridge build, enum extraction and runtime dependency allowlist |
| [inject.js](../../../chrome-extension/openfront-overlay/inject.js) | Generated MAIN-world bundle shipped to Chrome; never edit manually |
| [observer.scenarios.ts](../../../chrome-extension/tests/observer.scenarios.ts) | Game fixtures, observer/reference parity, lifecycle, bridge and timing assertions |
| [observer.test.mjs](../../../chrome-extension/tests/observer.test.mjs) | Vite-based in-memory runner for the TypeScript scenarios |
| [overlay.test.mjs](../../../chrome-extension/tests/overlay.test.mjs) | Minimal-DOM UI tests, message validation and packaged-bridge integration |
| [README](../../../chrome-extension/openfront-overlay/README.md) | Installation, feature overview and manual Chrome verification |
| [CLIENT_DOM.md](../../../chrome-extension/CLIENT_DOM.md) | Extension-owned DOM patterns and Lit rerender handling |

For game-client API evidence, follow:

- [GameRenderer.ts](../../../src/client/hud/GameRenderer.ts): assigns the game
  view and transform to `build-menu`.
- [BuildMenu.ts](../../../src/client/hud/layers/BuildMenu.ts),
  [GameView.ts](../../../src/client/view/GameView.ts), and
  [TransformHandler.ts](../../../src/client/TransformHandler.ts): accessible
  view APIs, units, and world-to-screen conversion.
- [ControlPanel.ts](../../../src/client/hud/layers/ControlPanel.ts): current
  native troop-bar markup and `.bg-malibu-blue` anchors.
- [SpatialIndex.ts](../../../src/client/advisor/SpatialIndex.ts),
  [GamePhase.ts](../../../src/client/advisor/GamePhase.ts), and
  [Types.ts](../../../src/client/advisor/Types.ts): shared reference analysis,
  not a reason to import the whole game runtime.
- [GameTypes.ts](../../../packages/engine-api/src/game/GameTypes.ts): reference
  enums extracted by the extension build.

The [original brief](../../../chrome-extension/prompt_for_ai_agent.md) is
historical scope, not the current architecture: its network interception,
manual script injection and separate stylesheet proposals are not implemented
requirements. The [strategy guide](../../../chrome-extension/openfront_strategy_guide.md)
is heuristic background; verify formulas and thresholds against current rules
and tests before using them.

Resolve conflicting prose against implementation and regression tests. Known
documentation drift includes circle/ring terminology for silo triangles, the
README claim that markers remain while minimized, its old no-checkbox smoke
check, and the test path in CLIENT_DOM's build section. Use the root-relative
commands below. Do not copy these outdated statements into new documentation.

## Architecture and data flow

The manifest declares two `document_start` scripts:

- `inject.js` runs in the page's **MAIN world**, where it can read game-owned
  JavaScript properties.
- `content.js` runs in Chrome's **isolated world**. It can modify shared DOM,
  but cannot directly read `build-menu.game`.

The bridge discovers the game through `body.in-game` and
`document.querySelector("build-menu").game`. It observes the existing client
view, not raw network traffic or the simulation worker. It posts display
snapshots to the page's exact origin using `window.postMessage`.

The content script checks source, origin, and relevant payload shapes before
rendering. Same-origin page code can still spoof these messages: this is a
display boundary, not authentication.

| Message | Direction and purpose |
| --- | --- |
| `OPENFRONT_OVERLAY_CONTROL` | UI to bridge: explicit boolean `enabled`, optional positive `requestId` |
| `OPENFRONT_OVERLAY_STATE` | Bridge to UI: status, raw troops, advisor snapshot, `controlId`, silo markers |
| `OPENFRONT_OVERLAY_SILOS` | Bridge to UI: changed projected silo marker array |
| `OPENFRONT_OVERLAY_PIRATE_WARSHIPS` | Bridge to UI: changed projected pirate marker array |
| `OPENFRONT_OVERLAY_FIRST_ENEMY_SILO` | Bridge to UI: first observed enemy silo in this game |
| `OPENFRONT_OVERLAY_INCOMING_BOAT` | Bridge to UI: newly observed hostile transport targeting our territory |
| `OPENFRONT_OVERLAY_PIRATE_ALERT` | Bridge to UI: a tracked warship crosses the capture threshold |

Keep producers, consumers, validation, fixtures and tests aligned when changing
a payload. `requestId`/`controlId` prevents stale acknowledgements from reversing
rapid toggles; preserve it.

The panel uses a shadow root. Map markers and transient warnings instead use
extension-owned fixed layers on the page. Only the interactive panel should
capture pointer input. Marker layers use z-index `2147483646`; the panel and
warnings use `2147483647`. These are not browser top-layer elements.

## Current lifecycle and behavior

- Advice starts disabled and minimized for each game. Activate enables the
  observer; Minimize disables it. Activation can wait through loading/spawn.
  Leaving/replacing a game resets activation. Finished, unsupported and error
  states stop analysis. The finished state keeps the panel expanded with a
  diagnostic; unsupported and error states collapse it.
- `GameObserver` wraps only this game instance's `update`, preserving receiver,
  arguments, return value and original exceptions. It restores its own hook
  without overwriting a subsequent owner's hook. Do not patch global prototypes.
- The spatial index is initialized/updated in small scheduled batches with a
  time budget. Tick rollback, catchup and excessive pending changes rebuild it.
  Never replace this with a full map scan on every frame.
- PUSH requires no non-tribe incoming troops, no stronger living frontier player
  (including allies/tribes), and available troops strictly above 33% capacity
  in opening or 42% otherwise. Equal strength is not stronger. Raw troop values
  stay integer units; UI display divides by ten.
- The panel lists phase and stronger neighbors, not PUSH/RETAIN badges. PUSH
  colors the native troop bar green and adds the 42% marker. Brief indexing or
  catchup retains the last valid color; inactive/invalid guidance restores it.
- Silo detection selects active missile silos of living nonlocal, nonfriendly
  owners. Orange triangles follow their tile centers; off-screen positions
  intersect the center-to-target ray with an inset viewport rectangle.
- **Find enemy silos** starts checked and gates silo marker visibility and the
  first-silo warning in the UI. The bridge emits that warning once per game,
  on first detection, not necessarily at construction time. Suppressing it
  does not queue a replay when the checkbox is reenabled.
- Incoming transport warnings concern active, nonretreating hostile transports
  whose destination tile is locally owned. New IDs trigger a warning.
- Pirate tracking counts observed ownership changes of our trade ships,
  attributing them to a remembered hunter or a nearby matching-owner warship.
  This is polling-based attribution, not an authoritative capture event stream.
  A warship with more than ten attributed captures gets a warning and red circle.
  **Monitor pirated tradeships** starts checked and gates these UI indicators.
- Both checkboxes are hidden while minimized. Their values are local to the
  content-script lifetime, not persisted Chrome settings. They do not send
  separate bridge controls. Bridge marker/alert detection requires advisor
  activation; minimizing clears marker production as well. Do not infer
  independent background monitoring from a checkbox being checked.

Discovery and new-unit checks run every 500 ms. While silo or pirate markers
exist, animation frames resample projected positions and post only changed
arrays; full advisor snapshots do not run at frame rate. Detection latency and
camera-follow latency are different paths.

## Modification recipes

### UI, styles, labels or warnings

Edit `content.js` directly; it is not generated. Reuse `markerKinds`,
`syncMarkers`, `projectSiloMarker` and `showWarning` instead of duplicating
projection/layer code. Preserve pointer transparency, reduced-motion handling,
high contrast, accessible names and duplicate-mount guards.

Add visible text to the extension's English Chrome locale and access it through
the local `translateText()`/cached `advisorLabels`. Add new cached keys to
`advisorKeys`. Do not import game translation helpers or put extension labels
in the game's language files. Missing locale entries fail explicitly at startup.
Cache labels before Chrome extension reload can invalidate live tab APIs.

Example: changing the silo label requires its locale entry and relevant UI
assertions, not an edit to `inject.js` or a game build.

### Bridge data, detection or analysis

1. Extend `RemoteGame`/related interfaces and compatibility guards in
   `Observer.ts` when a newly consumed API requires it.
2. Read state and project coordinates in `Main.ts`; send minimal display data.
   Compute world coordinates from tile centers through `transformHandler`,
   never infer the camera transform from DOM positions.
3. Update corresponding UI payload validation/rendering and both test seams.
   Avoid fabricated counts or success-shaped compatibility fallbacks; retain
   explicit statuses and `[OpenFront Overlay]` diagnostics.
4. Preserve activation, game-change reset, `pagehide` cleanup, polling/frame
   separation and change deduplication.
5. Rebuild the packaged bridge and review the generated diff.

For recommendation changes, edit `analyze`/`observe` in `Observer.ts` and assert
exact threshold boundaries and reference parity in the scenarios. Shared
reference logic changes can affect both extension and game; do not make those
changes casually for an extension-only request.

The build deliberately permits only the extension sources, `SpatialIndex`,
`GamePhase` and extracted reference enums at runtime. Type-only imports do not
add runtime modules. If a new import fails the allowlist, investigate the
dependency rather than disabling the guard or bundling the whole game.

### Native HUD integration

Follow CLIENT_DOM and check current ControlPanel markup. Scope mutations to
`control-panel`; identify extension nodes with unique `data-*` attributes.
Synchronization must be idempotent and tolerate Lit replacing children or the
panel itself. Preserve original styles (currently in a `WeakMap`) and restore
them on disable/exit. Never replace Lit-owned nodes or change game templates
just to add extension decoration.

## Build, test and reload

Use the Node/npm versions required by the root
[package.json](../../../package.json) (currently Node `>=24.15.0 <25`).
If dependencies are missing, use `npm run inst` (`npm ci --ignore-scripts`),
not `npm install`. Do not add tooling just to edit this extension.

From the repository root:

```sh
# After bridge/observer or bundled reference-source changes:
node chrome-extension/src/build.mjs

# UI-only changes:
node --test chrome-extension/tests/overlay.test.mjs

# Bridge, analysis, payload, or cross-world changes:
node --test chrome-extension/tests/overlay.test.mjs chrome-extension/tests/observer.test.mjs

# After TypeScript source changes:
npx --no-install tsc --noEmit -p chrome-extension/src/tsconfig.json

# Lint/format the files actually changed; these are example source selectors:
npx --no-install oxlint chrome-extension/src/Main.ts chrome-extension/src/Observer.ts chrome-extension/openfront-overlay/content.js
npx --no-install oxfmt --check chrome-extension/src/Main.ts chrome-extension/src/Observer.ts chrome-extension/openfront-overlay/content.js
git diff --check
```

The bridge build uses Vite without the game's config and emits a self-contained
IIFE into the packaged directory without deleting its other files. UI/locale-only
changes require no bridge rebuild. Rebuild before tests that consume `inject.js`
when its source changes; do not let stale generated code mask a regression.
Use relevant game tests too if modifying shared game analysis.

Load unpacked from `chrome-extension/openfront-overlay`, not its parent, in
`chrome://extensions`. After edits, reload **both** the extension and the game
tab. Extension reload alone leaves old content scripts in open tabs.

## Verification and troubleshooting

Automated UI tests use a minimal DOM double; observer tests use fixtures and
reference analysis. They do not prove real Chrome loading, visual layout or
compatibility with the currently deployed client.

Manual smoke checks:

1. Confirm no Chrome extension errors and exactly one `#openfront-advisor-ui`.
2. Enter a game: advice is initially off; activate, including during spawn.
   Compare phase/neighbors and troop-bar color with the game state.
3. Verify both checkboxes appear only expanded and default checked. Test
   marker/warning gating, camera pan/zoom, off-screen arrows and click-through.
4. Minimize: analysis and marker production stop. Reactivate, then leave/start
   another game: activation and detection state reset as implemented.
5. Exercise error/unsupported states and normal game controls outside the panel.

For local gameplay, use the repository's
[run-openfront skill](../../../.claude/skills/run-openfront/SKILL.md) when
applicable. Testing the game page alone does not install or test the extension;
ensure the unpacked extension is actually loaded. Do not claim remote-client
verification from local fixtures.

### Optional real-Chrome testing with Chrome DevTools MCP

Use Chrome DevTools MCP **only when the user asks for it or accepts an offer**
to run a browser smoke test. You may propose it when live-client or visual
verification would help, but do not launch a browser, connect to the user's
profile, or start a game without that agreement. Clarify live
`https://openfront.io/` versus local `http://localhost:9000` if unspecified.
The MCP server is browser tooling, not the OpenFront Overlay extension.
Testing through it does not change the extension's read-only design: gameplay
interactions belong only to the agreed test, never to extension code.

#### Prerequisites and actions on the user's side

Explain these requirements before attempting the flow; do not assume agent
permissions imply Chrome is configured:

1. **Chrome connection:** for the `--autoConnect` route, the user needs Chrome
   144 or newer running on the same machine as the MCP server. Ask them to open
   `chrome://inspect/#remote-debugging`, enable remote debugging, and approve
   Chrome's connection prompt when it appears. MCP can access other tabs in
   the selected profile; recommend a testing profile without sensitive tabs.
   Multiple profiles can cause connection to a different profile than expected.
2. **MCP server:** the user must add/start Chrome DevTools MCP in their client
   and enable its tools for this chat. In VS Code, use **MCP: List Servers** to
   start/restart it and the chat's tool picker if needed. Verify tools are
   actually exposed; if absent, request reconnection or a new chat rather than
   repeatedly attempting unavailable tools. An integrated VS Code browser is
   not evidence of access to the user's Chrome or installed extensions.
3. **Runtime:** use a supported Node version for the selected MCP release;
   Node 24 LTS also matches this repository. A GUI-launched VS Code may resolve
   `/usr/bin/node` even when the user's terminal uses a newer Node. Diagnose
   MCP output and the relevant npm log before changing installations. Runtime
   or user-configuration changes require user agreement.
4. **Overlay installation:** the user must open `chrome://extensions/`, enable
   Developer mode, and load unpacked from this checkout's
   `chrome-extension/openfront-overlay` directory in the connected profile.
   For an existing installation, ensure the correct directory and enable it.
5. **Reload after changes:** after any necessary bridge build, ask the user to
   click the extension's **Reload** in `chrome://extensions/`. Then reload the
   game tab yourself through MCP. Both reloads are required, including after
   locale/content-script changes. Report explicitly which user action remains
   pending; do not claim new code was tested while old scripts are still loaded.

Example VS Code **user MCP configuration** (merge into existing `servers`;
do not overwrite other servers or commit personal configuration):

```json
{
  "servers": {
    "chrome-devtools": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@latest",
        "--autoConnect",
        "--no-usage-statistics",
        "--no-performance-crux"
      ]
    }
  }
}
```

Check the installed release's options if this example drifts. For `EBADENGINE`
or a request to upgrade Node, inspect the actual runtime in the npm log.
If needed, configure an absolute supported Node executable with its matching
`npx-cli.js` as the first argument, and ensure child processes inherit a PATH
containing that Node's `bin` plus system directories. Do not rely on shell
startup files or assume `${env:PATH}` interpolation works in every MCP host.
An unresolved PATH substitution can cause `spawn sh ENOENT`, even though the
parent process runs Node 24. Re-test using the configured environment; a
successful `--help` or MCP handshake proves startup, not Chrome connectivity.
Do not disable engine checks to force an unsupported runtime.

The current MCP server blocks navigation to `chrome:` URLs. There is no
extension-reload tool, and this extension has no background worker to target
for reload. Ask the user to handle remote-debugging setup and extension
installation/reload manually; do not promise to automate these steps or
substitute manually injected scripts for a genuinely loaded extension.

#### Solo -> Activate -> Quit smoke test

1. Call `list_pages` to verify the Chrome connection. Open a new game tab with
   `new_page` when requested, preserving the user's existing tabs. Use returned
   page IDs on subsequent calls; snapshots provide current element UIDs.
2. Verify exactly one `#openfront-advisor-ui` exists and inspect console errors
   before starting. Its open shadow root is inspectable with `evaluate_script`.
   If missing, inspect diagnostics rather than assuming it is hidden outside a
   game. For example, `Missing translation: hideEnemySilos` was caused by stale
   loaded code in a real test: compare current source/locale, ask for extension
   reload, then reload the tab. Do not invent missing translations as a fallback.
3. Click the visible **Solo** button, inspect the singleplayer options, and
   click **Start Game**. Never select a public lobby. Retain defaults unless
   the user requests other settings. If a click reports success without opening
   the modal, inspect fresh state and the actual visible button; a targeted DOM
   `.click()` through `evaluate_script` is a fallback for an ineffective tool
   click, not a reason to call private game-start APIs.
4. Confirm advice starts minimized/off. Click **Activate** and verify the
   expanded panel, both checked monitoring options, and the bridge status.
   `Waiting for your player to spawn.` is valid during spawn, but not proof
   that live analysis works.
5. If the agreed test includes analysis, select a valid, unowned land tile
   through the normal game input surface. Read `build-menu.game` and
   `.transformHandler` only as needed to find/project a tile center and avoid
   HUD obstructions; see the run-openfront helpers. Do not send private intents
   or alter simulation state. Confirm the player owns tiles and the panel
   displays actual phase/neighbors rather than waiting, unsupported or error.
6. Quit with the game's **exit** control and **Confirm**, including after a
   failed activation when possible. Verify homepage return, `body.in-game`
   cleared, and advisor reset to minimized/inactive with checkboxes hidden and
   extension-owned HUD decorations/markers removed. Do not merely navigate
   away and call that a verified normal exit.
7. Leave or close the test tab as agreed. Report actual observed results,
   blockers and any required user reload. Do not claim silo/pirate warning
   behavior was tested by an activation/exit-only smoke test.

Use `take_snapshot`, `click`, `evaluate_script`, and console tools for evidence;
take screenshots when visual verification is needed. Prefer current snapshots
over stale UIDs and limit inspection to the agreed game tab. Do not change
browser flags, install tools, rebuild, or modify code merely to complete this
flow without a separately justified need and appropriate user agreement.

Upstream setup references:
[VS Code configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/client-configurations.md)
and [connecting to running Chrome](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md).

| Symptom | First checks |
| --- | --- |
| Overlay missing | Manifest match, unpacked directory, missing translation, console initialization error, reload extension and tab |
| Isolated script cannot read game properties | Read them in MAIN-world Main.ts and send validated display data |
| Unsupported client or missing HUD anchor | Compare remote API/markup with GameView, BuildMenu and ControlPanel; do not silently invent replacements |
| New silo delayed, but camera tracking smooth | 500 ms discovery cadence versus animation-frame projection |
| Markers lag during camera movement | Frame scheduling, world-to-screen projection, changed-array publishing, then UI positioning |
| Markers absent | Advisor activation, checkbox, valid local player, enemy/active filters, transform validity and console diagnostics |
| Green bar disappears after a Lit update | Scoped mutation observers, panel replacement and idempotent resynchronization |
| Reload has no effect/context invalidated | Reload the game tab too; live tabs retain scripts from the prior extension instance |

## Keep this skill improving

When work using this skill uncovers a durable, evidence-backed improvement to
the workflow or guidance, update this `SKILL.md` as part of the same task.
Prefer findings that prevent repeated investigation, clarify a source of truth,
or make implementation and verification more efficient or reliable. Check
proposed guidance against current code, tests, and repository instructions;
revise or replace outdated guidance rather than layering on conflicting
instructions. Keep edits focused and reusable: do not record speculation,
one-off task details, or facts that belong in implementation documentation.
Mention any skill update in the task summary.

When finishing a change, state what was rebuilt, which commands passed, what was
manually checked, and whether the user must reload. Do not equate fixture tests
with visual or deployed-client verification.
