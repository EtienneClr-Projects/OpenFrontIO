# OpenFront Overlay

A standalone Chrome extension (Manifest V3). Version 0.3.0
shows the advisor control at the bottom left. Each game starts with
advice on, refreshed every 500 ms. Click the top-right **Disable** button to collapse
the panel and stop observation, and **Activate** to turn it back on. Troop counts appear in the advisor's metrics.
It runs on the normal remote OpenFront.io client, not a locally compiled game.

## Advisor milestone

Advice is on by default for each game. Click **Disable** to stop it; you will see:

- Stronger bordering players: enemies first in red, friendlies in green, with
  compact troop counts and friendly/enemy labels.
- Current phase: opening, economy, contested, nuclear, or endgame.
- Troop recommendation: PUSH strictly above 33% reserve in Opening or 42% in
  other phases, provided there are no non-tribe incoming attacks and no stronger
  living bordering players. Either condition forces RETAIN in every phase.
  Stronger bordering players include temporary allies and tribes, but exclude
  actual teammates; equal troop counts do
  not trigger this rule. Comparisons use current available troops, not troops
  already committed to outgoing attacks. Troop reserves and incoming attacks
  inform the recommendation but are not listed in the overlay. It does not
  display PUSH or RETAIN text; the native troop bar turns green for PUSH.

Empty player lists display `-` below their titles; unavailable lists retain
their diagnostic message.

After a PUSH recommendation, the green bar remains while the map index briefly
catches up and refreshes when analysis resumes. It resets when leaving the game
or when the advisor cannot provide valid guidance.

The advisor uses the existing reference advisor's spatial and phase logic.
Phase depends on territory, neighbors and unit evidence, not just elapsed time.
It is heuristic guidance, not a prediction of victory or guaranteed defenses.
Activation during loading or spawn is retained until the game view is ready.
Leaving or replacing a game resets activation. When a game finishes, analysis
stops and the overlay stays expanded with a diagnostic. Unsupported clients and
advisor errors collapse the panel, retaining a compact diagnostic beside the
disabled activation button.
Only the panel captures clicks; the rest
of the page remains available to the game's controls.

There are no automated actions, map focus, or snooze/dismiss controls.
Economy and defense guidance below uses read-only worker queries; it never
sends build or attack intents.

## Economy and defense advisors

The expanded panel includes one economic recommendation and, when warranted,
Defense Post and SAM recommendations. A single plan drives both each card and
its labeled green map marker; markers are click-through and follow the camera.
Disabling the advisor, leaving the game, catchup, or losing a suggested tile
clears these placements. Nothing is built automatically.

Economy recommendations are explicitly heuristic, not an optimal build order:

- Establish a first City; favor another City at 80% or more troop capacity.
- Otherwise balance coastal Ports with Factories, falling back to capacity.
- Exclude disabled building types and types already under construction.
- Pause economy spending during incoming attacks, overwhelming hostile-human
  frontier pressure, or missiles threatening your territory.

Cards distinguish **affordable**, **recommended**, and **validated placement**.
Gold and costs use exact integer arithmetic, with the current price from
`myPlayer().buildables()`, not copied price formulas. An unaffordable card shows
the exact remaining gold before compact formatting. Affordability includes
equality with the price; there is no hidden gold reserve. Saving or paused
recommendations have no location marker. An affordable building without a valid
sampled placement is explicitly labeled as such.

Defense distinguishes four kinds of evidence:

- A nonretreating hostile **human attack underway**, with attacker and troops.
  Tribes and nations are not mislabeled as human attackers.
- A hostile human neighbor with at least twice your available troops:
  **potential danger**, not evidence that they attacked.
- An observed enemy silo, including construction: **nuclear precaution**, not
  proof of a launch. Wealth alone is not labeled a launch or nuclear capability.
- An observed atom/hydrogen bomb or MIRV warhead whose blast overlaps your land,
  or a MIRV targeting your territory: **missile threat**.

Actual teammates and temporary friendlies are excluded from these hostile
threat categories. New human attackers and newly threatening missile IDs raise
short warnings; repeated polling does not repeat the same warning. Evidence is
limited to what the client exposes while the advisor is active.

Defense Post candidates are set back at least three tiles from sampled
threatening frontiers, within the configured protection radius, and avoid
nearby existing posts. SAM candidates prioritize economic infrastructure
outside completed SAM positional coverage, using configured ranges and
conservative coverage during upgrades. This is not a simulation of interception:
cooldowns, flight paths and saturation still matter. Construction times are
shown when available, and SAM cards explicitly warn that a new launcher may not
finish before impact.

Threats refresh every 500 ms. Build scans run at most once per 1.5 seconds, with
one price query and at most three location probes per recommendation (ten total
queries maximum). Candidate generation reuses the incremental map index rather
than rescanning the map. Defense search considers up to three threatening
players and 256 owned tiles. Later scans rotate through sampled sites.
Only worker-approved, currently owned locations are marked. These are recent
checks, not a reservation: the game can change before you build.

Missing APIs, rejected queries, and three-second query timeouts display an
explicit diagnostic rather than invented prices or valid-looking locations.
Build-query failures do not hide separately observed threats or disable existing
troop guidance. Late replies after disable, game replacement, rollback, or
catchup cannot restore old plans.

## Push indicator

When the activated advisor recommends PUSH, the filled portion of the native
troop bar turns green. A thin vertical marker shows the 42% capacity point.
The fill returns to its normal color for RETAIN, while advice is inactive, or
outside a game. The indicators are visual only and do not perform gameplay
actions.

The client currently renders `control-panel` into its light DOM, but Lit owns
and updates that DOM during the match. The extension watches those updates and
reapplies the color. It locates the bar through the client's `.bg-malibu-blue`
fill class, an internal implementation detail rather than a stable extension
API; a client markup change may disable the indicator until the extension is
updated.

## Enemy missile silos

While in a game, active missile silos owned by living players who are not the
local player or a friendly are marked with orange triangles when **Find enemy
silos** is checked (the default). Unchecking it hides the triangles and
disables the first-silo warning. The markers match the silo icon's pointed
silhouette, follow the map camera and zoom, and do not intercept clicks or send
gameplay actions. Disabling the advisor also clears the markers.
While an enemy silo is present, its screen position is checked each animation
frame; unchanged markers are not resent. When a silo is outside the viewport,
its triangle moves to the nearest point on the viewport edge along the ray from
the screen center, with a chevron pointing toward the silo. The marker layer
stays above game overlays and does not intercept pointer input; a light and
dark outline keeps the triangle visible against varied terrain.

The first time a living enemy silo is detected in a game, a centered warning
appears for about two seconds and then fades away.

## Rich players

While the advisor is active, living non-bot players outside your team who
hold at least 25M gold are reported (one warning per player until their gold
drops below the threshold). **Watch rich players** (checked by default) gates
both behaviours:

- A connected player gets a warning to beware of nukes and MIRVs.
- A player who has left the game (disconnected) with that much gold is free
  money: a centered warning appears and their territory is circled in orange.
  The circle is centered on the player's name label and sized from their
  territory; when off-screen, a chevron points toward it.

The **Rich players (25M+ gold)** list below **Stronger bordering players**
includes both connected and disconnected qualifying players anywhere on the
map. It refreshes every 500 ms, removing players who spend their gold, die,
or join your team. Temporary allies on other teams remain eligible for the list,
warnings, and markers. The checkbox controls warnings and markers, not this list.

## Inactive neighbors

While the advisor is active, a warning appears when a living, non-friendly
player who shares a frontier with you has disconnected (left the game), so
their land can be taken. It is shown once per player, and again if they
reconnect and leave anew. **Watch inactive neighbors** (checked by default)
turns it off.

## Betraying neighbors

While the advisor is active, a warning names living bordering
players who betray someone other than you and receive the traitor defense
debuff. Their defense is halved for 30 seconds, creating an opportunity to
attack. The alert is based on observed alliance-break updates and may be missed
while the advisor is inactive or the game is catching up.

The **Betraying neighbors (halved defense)** list follows the rich-player list
and refreshes every 500 ms. Observed betrayers remain listed only while alive,
outside your team, bordering you, and still debuffed. Temporary allies on
other teams remain eligible for both the list and alerts. Betraying you removes them
from this opportunity list. Minimizing or leaving a game clears both lists;
reactivating starts observing betrayals anew.

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

- See [`../CLIENT_DOM.md`](../CLIENT_DOM.md) for how to add extension-owned
  elements to the native client DOM and handle Lit updates.
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
  reverse control is advisor enable/disable, with an optional request ID echoed
  as `controlId` in snapshots so older responses cannot undo newer toggles.
  The shared page can spoof messages,
  so they must never be used for privileged actions.
- Enemy silo positions are projected through the build menu's
  `transformHandler` and passed as validated screen coordinates. The isolated
  content script draws the rings in a fixed, pointer-transparent layer.
- The PUSH indicator in [`content.js`](./content.js) colors the troop-bar fill
  inside `control-panel` and observes Lit updates. It does not alter game state
  or send gameplay intents.
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
3. Open Solo and start a game; verify the panel is expanded and advice is
   on. Click **Disable** to collapse it, then **Activate** to enable it again.
   Return home to verify it resets.
4. Click game controls outside the panel; they should work normally.
5. Reload the tab; there should be exactly one `#openfront-advisor-ui`.
6. Advice must initially be on. Wait for map indexing. Compare
   reserve capacity, incoming attacks and bordering players against the game.
7. Click **Disable**; advice must stop and the panel must collapse. Activate
   again, return home, and enter another game; advice must be on again.
8. Try a team game and verify friendly stronger neighbors are not labeled enemies.
   The advisor panel should never display PUSH or RETAIN text. When the
   recommendation is PUSH, the filled troop bar should turn green and show the
   vertical 42% marker; RETAIN or inactive advice should restore its normal color.
9. Click **Disable** during loading/spawn, then **Activate**; the panel should stay expanded while waiting
   and automatically begin analysis when ready.
10. Check the monitoring checkboxes appear only while expanded. A finished game
    keeps its diagnostic expanded; unsupported/error states collapse.
11. Compare economy costs with the game's build menu. At exact affordability,
    confirm the card changes, and that only a validated location gets a labeled
    green marker. Check spending, construction, capture, and camera pan/zoom.
12. Check defense evidence separately: a human attack, a stronger neighbor,
    enemy silo construction, and a missile whose target or blast threatens
    your land. Confirm no launch warning is inferred from a silo alone.
13. Disable and reactivate during a pending build query; no old placement should
    return. Repeat after returning home and starting another game.

Real remote-client gameplay verification is user-run. Automated fixture tests
are not a substitute for checking compatibility with the deployed client.

The badge is an ordinary DOM overlay, not a top-layer dialog. Browser
fullscreen on a specific element or top-layer game dialogs may cover it.
