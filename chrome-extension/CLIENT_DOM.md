# Modifying the client page from the extension

Use the extension content script in `openfront-overlay/content.js` for visual
changes to the game's DOM. It runs in Chrome's isolated world: it can query and
modify page elements, but cannot read JavaScript properties owned by the game.
For game state, use the existing MAIN-world bridge in `src/Main.ts` and pass
validated display data to the content script with same-origin `postMessage`.
Never treat page messages as trusted commands or use them for gameplay actions.

## Example: native troop bar

The current PUSH indicator is implemented by `syncHudColor()`:

1. Find `control-panel`, then locate the troop fill by its current
   `.bg-malibu-blue` class.
2. Walk to the containing bar and add extension-owned DOM there. The 42% marker
   is inserted immediately before the absolutely positioned troop-label layer,
   keeping it behind the troop numbers.
3. Use a unique `data-*` attribute to recognize your element. Check for an
   existing element before inserting so synchronization is idempotent.
4. Scope all queries and mutations to `control-panel`. Do not replace Lit-owned
   nodes or edit the game's source/template for an extension-only feature.

`control-panel` renders into its light DOM, but Lit rebuilds that DOM during
updates. `startHudColorSync()` therefore observes child changes (and fill style
changes) inside the panel, watches its parent for replacement, and reacts to
`body.in-game`. Keep synchronization safe to run repeatedly; marker insertion
itself causes a mutation. Remove extension-owned elements and restore any
overridden inline styles when leaving the game or stopping the observer. The
current code saves original fill colors in a `WeakMap` before applying green.

These selectors and DOM relationships are private client implementation
details, not a supported extension API. Recheck them against the current
`src/client/hud/layers/ControlPanel.ts` whenever the game's markup changes.
The isolated UI tests in `tests/overlay.test.mjs` cover marker placement,
Lit-style rerenders, color restoration, and game exit.

## Map markers

For markers positioned over the map, read game units and camera-projected
coordinates in the MAIN-world bridge, then send only validated display data to
the isolated content script. Render extension-owned circles in a fixed,
viewport-sized layer with `pointer-events: none`; refresh their positions as
the camera moves (ideally once per animation frame while markers are visible)
and remove stale markers when the bridge reports none. Skip unchanged positions
and avoid republishing unrelated HUD state at the marker rate. For off-screen
targets, intersect the center-to-target ray with an inset viewport rectangle
and show a directional marker there. Use a lightweight CSS triangle for the
marker. Do not rely on DOM positioning to infer the game's camera transform.

## Build and reload

Edit `openfront-overlay/content.js` directly; it is not generated. If changing
the MAIN-world bridge, edit `src/Main.ts` or `src/Observer.ts` and regenerate
`openfront-overlay/inject.js` with `node src/build.mjs` from `chrome-extension`.
Run `node --test tests/overlay.test.mjs` from the repository root, then reload
the unpacked extension and the game tab in Chrome.
