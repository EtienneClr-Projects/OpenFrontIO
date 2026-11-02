# OpenFront Overlay

A standalone Chrome extension (Manifest V3). Version 0.3.0
shows a minimized **Strategy advisor** panel at the bottom left outside a game.
During a game it expands with an **Enable advisor for this game** toggle for
read-only strategy analysis, refreshed every 500 ms. There is no separate troop
badge; troop counts appear in the advisor's metrics. It runs on the normal remote
OpenFront.io client, not a locally compiled game.

## Advisor milestone

Advice is off by default for each game. Enable it after entering a game to see:

- Troop reserves: your troops, troop capacity, and capacity percentage.
- Incoming attacks: observed committed troops and defense guidance.
- Stronger bordering players: friendly/enemy labels and troop comparisons.
- Current phase: opening, economy, contested, nuclear, or endgame.

The advisor uses the existing reference advisor's spatial and phase logic.
Phase depends on territory, neighbors and unit evidence, not just elapsed time.
It is heuristic guidance, not a prediction of victory or guaranteed defenses.
You can minimize the advisor panel. Only the panel captures clicks; the rest
of the page remains available to the game's controls.

This milestone does **not** include automated actions, expansion/build advice,
worker eligibility queries, nuclear/transport alert cards, map focus, or
snooze/dismiss. Nuclear evidence can still affect the phase label.

## Load in Chrome

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `openfront-overlay` directory
   (the directory containing `manifest.json`, not its parent).
4. Open or reload <https://openfront.io/>. The overlay should appear.

The extension also matches HTTPS subdomains of `openfront.io` and
<http://localhost:9000/> for local development. The packaged directory is ready
to load; no background worker or additional permissions are needed.
Chrome 111 or newer is required
for the declarative main-world content script.

After editing the extension, click its **Reload** button in
`chrome://extensions/`, then reload the game tab. Disable the extension and
reload the tab to remove the overlay.

Reloading the extension invalidates Chrome APIs in already-open tabs. This
version caches localized labels at startup so live updates do not call those
APIs again. You must still reload the game tab to replace older content scripts
with the updated version; reloading only the extension does not replace them.

## Customize

- [`inject.js`](./inject.js) is a generated, self-contained bundle. Edit
  [`src/Main.ts`](../src/Main.ts) or [`src/Observer.ts`](../src/Observer.ts)
  and rebuild; do not edit the bundle by hand.
- Change the messages in [`_locales/en/messages.json`](./_locales/en/messages.json)
  to customize advisor labels.
- Change the shadow-root styles in [`content.js`](./content.js) for position,
  colors, or font size.
- [`content.js`](./content.js) waits for the DOM when loaded at
  `document_start` and guards against mounting duplicate overlays.
- The interactive advisor uses a shadow root to isolate its styles from the game.

Text uses a local `translateText()` helper backed by `chrome.i18n`. The game's
`translateText()` cannot be imported by this standalone, isolated content
script, so extension translations live in Chrome's `_locales` directory rather
than the game's translation resources.

## Client integration notes

- [`ClientGameRunner.ts`](../../src/client/ClientGameRunner.ts) attaches
  `#game-input-overlay` to the body to handle game input. Only the advisor panel
  occupies an interactive region above it.
- [`styles.css`](../../src/client/styles.css) locks body scrolling in-game,
  while the homepage scrolls normally. Fixed positioning keeps the panel
  visible in either mode; its shadow-root CSS isolates it from page styles.
- [`Main.ts`](../../src/client/Main.ts) toggles `body.in-game`. The read-only
  [`inject.js`](./inject.js) bridge uses that flag to detect game entry/exit,
  then reads `document.querySelector("build-menu").game.myPlayer().troops()`.
  [`GameRenderer.ts`](../../src/client/hud/GameRenderer.ts) assigns that game
  view to the element. Chrome runs the bridge in `MAIN` world because the
  isolated content script cannot access the element's JavaScript properties.
  Display snapshots are sent via same-origin `window.postMessage`; the content
  script validates the source, origin, and payload before rendering. The only
  reverse control is advisor enable/disable. The shared page can spoof messages,
  so they must never be used for privileged actions.
- The extension bundles its own analysis, using reference
  [`SpatialIndex.ts`](../../src/client/advisor/SpatialIndex.ts) and
  [`GamePhase.ts`](../../src/client/advisor/GamePhase.ts) at build time.
  It does not depend on the dev-only advisor existing on the remote page.
  Enabling advice observes completed updates of the discovered GameView and
  captures tile changes immediately, rather than missing intervening updates
  between 500 ms display refreshes. The original update behavior is preserved;
  no simulation data is changed and no gameplay intents are sent.
- Map indexing is incremental. Advice waits for initialization, rebuilds after
  catch-up, and resets on leaving or replacing a game. Disabling observation
  restores the original update method when it is still owned by the extension.
  The required client APIs are internal, not a stable public extension API:
  if OpenFront changes them, the panel reports **Unsupported client version**.
- The view returns raw troop units. Like `renderTroops()` in
  [`Format.ts`](../../packages/engine-lib/src/Format.ts), the overlay divides
  those units by 10 before display. It shows the full localized count with
  one decimal place rather than the game's compact K/M/B notation.
- Initialization and spectators without a local player do not receive fabricated
  counts. Advisor errors show an explicit status and log a diagnostic in DevTools.
  Returning home minimizes the panel and clears old advice, even if the element
  retains the previous game view.
- [`Transport.ts`](../../src/client/Transport.ts) uses the binary encoders and
  decoders in [`ZbinWire.ts`](../../packages/shared/src/ZbinWire.ts).
  Future traffic analysis must account for that protocol, not assume JSON.
  Network interception from the broader project brief remains deferred;
  the bridge only reads the existing client view.

## Verify

For development, use the repository's supported Node 24 runtime and installed
dependencies (`npm run inst` if needed). Rebuild from the repository root:

```sh
node chrome-extension/src/build.mjs
```

Only the extension bundle is compiled. This does not rebuild or deploy the
OpenFront game. The packaged directory remains ready to load in Chrome.

Run the extension observer/parity and isolated UI regression tests:

```sh
node --test chrome-extension/tests/overlay.test.mjs chrome-extension/tests/observer.test.mjs
```

The UI tests use a minimal DOM test double; the observer tests use reference
analysis logic and game fixtures. Verify layout and Chrome loading in the browser:

1. Check that Chrome reports no extension errors.
2. Reload the homepage and look for the compact bottom-left panel and the
   `[OpenFront Overlay] Advisor overlay mounted.` message in DevTools.
3. Open Solo and start a game; verify the panel expands. Return home to verify
   it minimizes again.
4. Click game controls outside the panel; they should work normally.
5. Reload the tab; there should be exactly one `#openfront-advisor-ui` and no
   old `#openfront-overlay-ui` troop badge.
6. Advice must initially be off. Enable it and wait for map indexing. Compare
   reserve capacity, incoming attacks and bordering players against the game.
7. Disable advice, return home, and enter another game; advice must be off again.
8. Try a team game and verify friendly stronger neighbors are not labeled enemies.

Real remote-client gameplay verification is user-run. Automated fixture tests
are not a substitute for checking compatibility with the deployed client.

The badge is an ordinary DOM overlay, not a top-layer dialog. Browser
fullscreen on a specific element or top-layer game dialogs may cover it.
