<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="proprietary/images/OpenFrontLogoDark.svg">
    <source media="(prefers-color-scheme: light)" srcset="proprietary/images/OpenFrontLogo.svg">
    <img src="proprietary/images/OpenFrontLogo.svg" alt="OpenFrontIO Logo" width="300">
  </picture>
</p>

[OpenFront.io](https://openfront.io/) is an online real-time strategy game focused on territorial control and alliance building. Players compete to expand their territory, build structures, and form strategic alliances in various maps based on real-world geography.

This is a fork/rewrite of WarFront.io. Credit to https://github.com/WarFrontIO.

![CI](https://github.com/openfrontio/OpenFrontIO/actions/workflows/ci.yml/badge.svg)
[![Crowdin](https://badges.crowdin.net/openfront-mls/localized.svg)](https://crowdin.com/project/openfront-mls)
[![CLA assistant](https://cla-assistant.io/readme/badge/openfrontio/OpenFrontIO)](https://cla-assistant.io/openfrontio/OpenFrontIO)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Assets: CC BY-SA 4.0](https://img.shields.io/badge/Assets-CC%20BY--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-sa/4.0/)

## License

OpenFront source code is licensed under the **GNU Affero General Public License v3.0**

Current copyright notices appear in:

- Footer: "© OpenFront and Contributors"
- Loading screen: "© OpenFront and Contributors"

Modified versions must preserve these notices in reasonably visible locations.

See the [LICENSE](LICENSE) for complete requirements.

For asset licensing, see [LICENSE-ASSETS](LICENSE-ASSETS).  
For license history, see [LICENSING.md](LICENSING.md).

## 🌟 Features

- **Real-time Strategy Gameplay**: Expand your territory and engage in strategic battles
- **Alliance System**: Form alliances with other players for mutual defense
- **Multiple Maps**: Play across various geographical regions including Europe, Asia, Africa, and more
- **Resource Management**: Balance your expansion with defensive capabilities
- **Cross-platform**: Play in any modern web browser

## 📋 Prerequisites

- [Node.js](https://nodejs.org/) v24.15.0 or newer in the Node 24 release line
- [npm](https://www.npmjs.com/) v12.1.0 or newer in the npm 12 release line
- A modern web browser (Chrome, Firefox, Edge, etc.)

Node.js may bundle an older npm version. Upgrade it before installing project dependencies:

```bash
npm install --global --ignore-scripts npm@12.1.0
```

## 🚀 Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/openfrontio/OpenFrontIO.git
   cd OpenFrontIO
   ```

2. **Install dependencies**

   ```bash
   npm run inst
   ```

   Do NOT use `npm install` nor `npm i` for project dependencies. Use `npm run inst`; it runs the safer `npm ci --ignore-scripts` to install exactly the versions in `package-lock.json` without running lifecycle scripts.

   The repository also rejects dependency releases less than seven days old and dependencies sourced from Git, remote URLs, local tarballs, or directories. Wait until a new release passes the seven-day window before updating it; security exceptions require explicit maintainer review.

## 🎮 Running the Game

### Development Mode

Run both the client and server in development mode with live reloading:

```bash
npm run dev
```

This will:

- Start the webpack dev server for the client
- Launch the game server with development settings
- Open the game in your default browser (to disable this behavior, set `SKIP_BROWSER_OPEN=true` in your environment)

### Client Only

To run just the client with hot reloading:

```bash
npm run start:client
```

### Server Only

To run just the server with development settings:

```bash
npm run start:server-dev
```

### Connecting to staging or production backends

Sometimes it's useful to connect to production servers when replaying a game, testing user profiles, purchases, or login flow.

> To replay a production game, make sure you're on the same commit that the game you want to replay was executed on, you can find the `gitCommit` value via `https://api.openfront.io/game/[gameId]`.
> Unfinished games cannot be replayed on localhost.

To connect to staging api servers:

```bash
npm run dev:staging
```

To connect to production api servers:

```bash
npm run dev:prod
```

## 🛠️ Development Tools

### Local strategy adviser (experimental)

On a Vite development client opened through `localhost` or a loopback IP, a
**Strategy adviser** panel is available during a game. Start a solo game, choose
a spawn, and select **Enable adviser**. It is off by default and is not enabled
on production domains.

The adviser reads the existing client simulation state. With **Automatic play**
off it sends no gameplay intents. It never clicks the UI, changes your attack
slider, or calls an external AI service.
**Show location** only moves the camera. The default view shows three ranked
recommendations, with expandable evidence, dismissal, and a 30-second snooze
measured in simulation time. Pausing freezes observations and snoozes.

It covers accessible expansion, disconnected neighbors, incoming land attacks,
transports targeting your land, sampled economic investments, silo/SAM changes,
nuclear blast exposure, alliance expiry, and territory-based endgame pressure.
Observation and estimate labels distinguish facts from strategic heuristics.
An empty panel is **not** an all-clear.

A separate stronger-neighbor reminder compares every living land neighbor's
reserve with yours, even above 20% capacity and without an eligibility query.
Any strictly larger reserve triggers it. Friendly neighbors (allies or teammates)
are labeled separately and ranked below nonfriendly neighbors; troop superiority
alone establishes neither hostile intent nor attack legality.

The [community wiki](https://openfront.wiki/#explore) provides useful background,
but several pages retain historical formulas. Calculations use the checkout's
shared configuration, current game state, and read-only worker eligibility
queries instead. In particular, disconnected opponents are not free territory,
and SAM radius/readiness does not guarantee interception.

The adviser maintains a bounded-initialization frontier/coast index and consumes
tile deltas thereafter. Eligibility queries sample at most three frontier owners
and three build locations per round; this is not an exhaustive placement or combat
optimizer. Costs and eligibility are recent observations, so recheck them before
acting. Port advice requires verifying navigable trade routes, factory rail
previews are not guaranteed income, and boat ETA is unknown without a matching
motion plan. Upgrading SAM coverage is conservatively reported from its starting
radius. Nuclear warnings group overlapping missile footprints by launcher owner,
including friendly-fire risk. Active strikes show ready own-SAM destination
coverage and counts of your buildings strictly inside the outer blast circles,
which are destroyed if the strikes detonate at their current targets. This
includes construction sites and deduplicates buildings across missiles.
Coverage is not an interception guarantee; allied SAMs and SAM missiles already
in flight are not assessed. Friendly/self missiles are not counted as interceptable
by your SAMs. Proximity-only transport and warship alerts are deliberately omitted.
The panel is anchored in the bottom-left corner.

Advice is not enabled for replays, is withheld during spawn, initialization and catch-up, and cleared on
elimination/game end. Query failures are shown rather than treated as safe/legal
defaults. Production integration remains outside this feature.

#### Automatic play (local solo only)

The separate **Automatic play** checkbox is off by default. Enabling it also
enables observation. Choose your spawn manually; the policy begins after spawn
and indexing. It continues alongside manual play, but unchecking it (or disabling
the adviser) invalidates pending checks immediately. Already sent actions are
not undone. Catch-up, elimination, game end and analysis/query errors stop it;
re-enable explicitly after a catch-up or error.

This deterministic, experimental policy can spend troops/gold and launch nukes:

- The panel labels the current **phase** and explains its evidence: opening
  expansion, consolidation/economy, contested defense, nuclear, or endgame.
  Opening requires elapsed time below three simulated minutes and an adjacent
  neutral or living nonfriendly tribe frontier. Tribes are explicitly `BOT`
  players, not `NATION` or `HUMAN`. Incoming attacks/landings, stronger non-tribe
  neighbors, severe overcommitment, nuclear threats/capability, and endgame
  pressure take precedence. Labels and automatic policy share one classifier;
  phase changes take effect immediately.
- During opening, prioritize the weakest adjacent tribes ahead of neutral land.
  Start at >=45% reserve capacity with commitments below 50% of reserve.
  Send up to 30% of reserve against a tribe (its reserve plus outgoing commitments
  must be below 15% of yours, and the sent stack must exceed 1.5 times that total), or up to 25%
  toward neutral land. Clamp both to leave >=35% of capacity at dispatch.
  Skip defended/fallout tribe samples. Back off to the normal policy when an
  adjacent tribe exceeds half your reserve or a non-tribe exceeds 75%.
  Opening attacks may be issued every 1.5 simulated seconds, with a three-second
  repeat cooldown per target. This is a heuristic, not a conquest guarantee;
  manual actions and subsequent combat can still reduce reserves.
- At >=65% reserve capacity, with outgoing commitments below 25% of your reserve, expand into neutral
  land using 15% of reserve, attack substantially weaker nonfriendly neighbors
  using 20% when their reserve plus outgoing troops are below 12% of yours
  and the sent stack exceeds 1.5 times that total, or reclaim disconnected teammates
  using 10%. Rank eligible enemy targets from weakest to strongest; avoid defended/
  fallout samples and never add troops to a non-retreating outgoing attack on the
  same owner. Recheck priority, tile and relative strength before dispatch.
  Existing attacks (including manual attacks) are not automatically canceled.
  Incoming attacks, hostile landings and incoming nuclear footprints block
  offensive expansion. Economy may continue under minor land pressure below
  20% of reserve, but not under major land attacks, confirmed landings or nukes.
- At >=90% reserve capacity, try eligible expansion first, then build/upgrade a
  city even without a cached recommendation. An illegal expansion check falls
  through to capacity investment instead of waiting forever. Do not duplicate
  a city already under construction.
- Start economy investment during opening rather than waiting for its phase to
  end. An affordable, connected cached investment can take the first action;
  otherwise expansion and economy share turns. After ten simulated seconds
  without an economy turn, prioritize economy over ordinary expansion,
  patrols and nuclear spending. Emergency responses remain first. Continue
  considering investment at >=30% troop capacity, subject to current worker
  prices and the 20% gold reserve.
  An unavailable or unaffordable investment yields the turn back to ordinary
  actions rather than blocking expansion with repeated economic checks.
- Invest in distinct ports (at least four desired, scaling with coastline to at
  most twenty) and factories (one per three completed cities/ports, at most
  twelve). Sample separated coast cells, a sparse
  owned-land grid, and sites offset from stations rather than repeatedly clicking
  existing structures. Wait for in-progress builds of the same type. Require at
  least two completed city/port stations before adding factories, and recheck a
  worker rail preview ending at an owned completed city/port before building a
  new factory. Railways are created by the factory/station engine, not a separate
  railway intent. Connectivity evidence does not guarantee income or payback.
- Keep proposing cities and upgrades of completed cities, ports and factories
  even after new-port/factory count targets are reached, without waiting for
  cached advice or >=70% troop capacity. Prefer lower-level upgrade candidates.
  New factories still require a paying railway preview; incomplete structures
  are not upgrade candidates. Normal spending preserves 20% of current gold.
- Build SAM coverage when hostile silos or incoming strikes expose a sampled
  location. This may spend the available budget; a new SAM is not an instant
  interception. Existing SAM coverage, including construction sites, prevents
  duplicate placements rather than triggering constant upgrades.
- Redirect an existing warship toward a confirmed landing when a verified direct
  water route (up to 4096 steps) or a bounded 4096-cell flood search establishes
  connectivity, favoring the nearest reachable ship. Otherwise build a warship
  from a ready port connected to that sea, or
  build a port on the threatened shore first. Wait for port construction before
  trying the warship. A port or ship on another sea is not sufficient. Emergency
  port/warship spending may use the full available gold; new construction is not
  guaranteed to finish before landing. Once a reachable ship is already assigned
  to the boat's current tile, avoid redundant moves or builds. Consider every
  incoming transport, in arrival order, rather than letting an already-covered
  landing hide a second invasion. Keep assigned ships on their own interceptions;
  interception moves can refresh once per simulated second.
- After opening, maintain standing coastal patrols while hostile players remain.
  Before ordinary expansion or economic spending, build a warship at a completed
  port if no connected own ship is assigned within 80 tiles of its adjacent water.
  Ships under construction count toward coverage. Patrol builds retain the normal
  20% gold reserve; emergency landing responses can still use the full budget.
- At >=50% reserve with outgoing commitments below 35% of reserve, consider
  overseas invasions alongside normal land invasions, before economic spending.
  Both use the same enemy strength, defense-post cost, traitor advantage, troop
  sizing and home-reserve rules. Disconnected teammates can be reclaimed with
  10%; other friendly or disconnected players and fallout targets are excluded.
  Prefer land attacks, then rank all eligible overseas targets by straight-line
  distance to the nearest tile of the full owned coastline. Nearby unclaimed
  islands take precedence over distant enemies, and enemy strength or traitor
  status does not override distance after the troop-safety checks pass.
  Unclaimed shores are considered once adjacent neutral land is exhausted.
  Neither shore needs a port. Keep at most one transport active per target owner.
  Consider the three closest landing shores per owner and let worker eligibility
  confirm a reachable launch shore before sending. This distance is not a sailing
  ETA; water routes around land can be longer. Failed routes fall through to
  other targets or economic investment.
  It does not micromanage every ship or promise optimal routing.
- Request alliances with stronger neighbors and extend eligible existing
  alliances, no more than once per neighbor per 60 simulated seconds. Never
  automatically break alliances or donate resources.
- After opening, with >=50% troop capacity and no incoming attacks, landings or
  nuclear danger, prioritize nuclear strikes against living hostile non-tribe
  rivals with at least half our troop reserve in troops plus outgoing commitments.
  Try MIRV, hydrogen, then atom bombs against their infrastructure, before
  further expansion except when an economy turn is due. Rank infrastructure by
  missile silos, then SAMs, then exposed civilian structures above level one,
  then exposed level-one structures. Within each class, prefer shorter distance
  from a ready own silo, with higher levels breaking distance ties.
  Civilian infrastructure covered by a completed hostile SAM is excluded.
  Direct hydrogen/atom strikes require infrastructure targets; MIRVs retain
  territory fallback and strongest-rival selection because they scatter across
  a country rather than reliably striking one structure. Worker
  eligibility and current prices decide what is legal and affordable, including
  escalating MIRV prices; failed checks fall through to cheaper weapons. Avoid
  another strategic launch while our missile or MIRV warheads are already
  targeting that rival. Build a first silo on a free site
  after two completed cities when needed.
- Nuclear weapons and offensive silos require a sustainable economy, not just
  a large treasury. Observe two simulated minutes of worker, ship-trade and
  rail income; exclude donations, conquest and piracy windfalls. Recurring
  income/minute must cover the current worker-quoted purchase cost. After the
  purchase, retain at least that cost or half a minute of income, whichever is
  greater (and the ordinary 20% gold reserve still applies).
  Once income qualifies for a quoted nuclear purchase, allocate 40% of newly
  earned recurring income to one shared nuclear budget. Cap it at twice the
  largest quoted cost supported by current income; cheaper weapons and silos
  consume the same budget. Stop accruing and clear the allowance when income
  no longer supports any quoted purchase. Enabling automatic play starts
  observation and budgeting afresh; stockpiled gold grants no initial allowance.
  Recheck current prices, income, allowance and treasury before dispatch.
- Reject nuclear targets whose outer blast circle contains observed friendly land
  or units. MIRV checks conservatively cover possible warhead destinations across
  the target owner's territory within its 1500-tile dispersal range, including
  remote borders, rather than just the clicked tile. Friendly overlap can exclude
  a MIRV while still allowing a smaller targeted strike. Recheck ownership,
  alliances and collateral before dispatch. At >=70% capacity, retain the
  single-atom option against hostile silo/SAM or exposed infrastructure above
  level one even for weaker opponents, using the same target ranking.
  Enemy SAM interception along the flight path is not predicted.
- Collateral checks share lazily scanned 32-by-32 map cells within one policy
  evaluation, avoiding repeated full blast scans along fragmented MIRV borders.
  The cache is cleared for every evaluation, including the dispatch recheck, so
  changes in ownership or alliances are not reused. Friendly mobile units are
  checked separately, including over the interior of enemy territory.

Actions use existing client intent events after worker eligibility checks.
There is at most one additional check per simulated second. Outside opening
expansion there is one action per three seconds and a ten-second per-action
retry/repeat cooldown, except for the opening and emergency naval responses
described above. Results older than
one simulated second are discarded, current state is reconsidered before dispatch,
and async callbacks never send while paused. Server/engine validation remains
authoritative; simultaneous manual actions can change eligibility before execution.
Dismiss/snooze affect advice only, not this independent policy. The panel reports
checks, waiting, errors and the latest sent action. This is a baseline autoplayer,
not a competitive or guaranteed-safe strategy.

Focused tests: `npm test -- tests/client/advisor`.

- **Format code**:

  ```bash
  npm run format
  ```

- **Lint code with Oxlint**:

  ```bash
  npm run lint
  ```

- **Lint and fix code with Oxlint**:

  ```bash
  npm run lint:fix
  ```

- **Testing**
  ```bash
  npm test
  ```

## 🏗️ Project Structure

- `/src/client` - Frontend game client
- `/src/server` - Backend game server
- `/packages/engine` - Deterministic game simulation (`@openfront/engine`)
- `/packages/engine-api` - The engine's contract: types, schemas, game updates and the worker protocol (`@openfront/engine-api`)
- `/packages/engine-lib` - Engine code also used outside the engine: map grid, rules, helpers (`@openfront/engine-lib`)
- `/packages/shared` - Code shared by client and server: wire schemas, env, asset URLs (`@openfront/shared`)
- `/packages/zbin` - Compact binary wire format for zod schemas (self-contained, zod-only)
- `/resources` - Static assets (images, maps, etc.)

## 🤝 Contributing

Contributions and translations are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, the approved-issue process, project governance, and translation info.
