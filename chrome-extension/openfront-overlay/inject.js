var OpenFrontOverlay = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	//#region ../packages/engine-api/src/game/GameTypes.ts
	var GameMode = /* @__PURE__ */ function(GameMode) {
		GameMode["FFA"] = "Free For All";
		GameMode["Team"] = "Team";
		return GameMode;
	}({});
	var UnitType = /* @__PURE__ */ function(UnitType) {
		UnitType["TransportShip"] = "Transport";
		UnitType["Warship"] = "Warship";
		UnitType["Shell"] = "Shell";
		UnitType["SAMMissile"] = "SAMMissile";
		UnitType["Port"] = "Port";
		UnitType["AtomBomb"] = "Atom Bomb";
		UnitType["HydrogenBomb"] = "Hydrogen Bomb";
		UnitType["TradeShip"] = "Trade Ship";
		UnitType["MissileSilo"] = "Missile Silo";
		UnitType["DefensePost"] = "Defense Post";
		UnitType["SAMLauncher"] = "SAM Launcher";
		UnitType["City"] = "City";
		UnitType["MIRV"] = "MIRV";
		UnitType["MIRVWarhead"] = "MIRV Warhead";
		UnitType["Train"] = "Train";
		UnitType["Factory"] = "Factory";
		return UnitType;
	}({});
	var PlayerType = /* @__PURE__ */ function(PlayerType) {
		PlayerType["Bot"] = "BOT";
		PlayerType["Human"] = "HUMAN";
		PlayerType["Nation"] = "NATION";
		return PlayerType;
	}({});
	//#endregion
	//#region ../src/client/advisor/GamePhase.ts
	/** Strategic phase inferred from current evidence, not a fixed match timeline. */
	function gamePhase(o, map, spatial) {
		const me = o.players.find((p) => p.id === o.myID);
		if (!me) return "economy";
		if (o.clockEnabled && me.doomed || o.landShare >= o.winShare * .8) return "endgame";
		const hostile = (id) => o.players.some((p) => p.id === id && !p.friendly && !(me.team !== null && p.team === me.team));
		const units = o.units.filter((u) => u.active);
		const neutralFrontSize = spatial.fronts.get(0)?.size ?? 0;
		const nearbyTribe = o.players.some((p) => p.alive && hostile(p.id) && p.type === PlayerType.Bot && spatial.fronts.has(p.id));
		const hasFrontier = neutralFrontSize > 0 || nearbyTribe;
		const hasSubstantialFrontier = neutralFrontSize >= 8 || o.players.some((p) => p.alive && hostile(p.id) && p.type === PlayerType.Bot && p.tiles >= 64 && spatial.fronts.has(p.id));
		if (units.some((u) => u.type === UnitType.MissileSilo && hostile(u.owner) || u.target !== null && u.range > 0 && [
			UnitType.AtomBomb,
			UnitType.HydrogenBomb,
			UnitType.MIRVWarhead
		].includes(u.type) && spatial.blastTouches(u.target, u.range))) return "nuclear";
		if (me.incoming > 0 || units.some((u) => u.type === UnitType.TransportShip && hostile(u.owner) && !u.retreating && u.target !== null && map.ownerID(u.target) === me.id) || o.players.some((p) => p.alive && hostile(p.id) && p.type !== PlayerType.Bot && spatial.fronts.has(p.id) && p.troops > me.troops) || me.troops < o.cap * .2 && me.outgoing > me.troops) return "contested";
		if (o.elapsed < 1800 && hasFrontier || hasSubstantialFrontier) return "opening";
		return "economy";
	}
	//#endregion
	//#region ../src/client/advisor/SpatialIndex.ts
	/** Retain frontiers, coasts and sparse build sites, not a second full map. */
	var SpatialIndex = class {
		constructor(map, myID) {
			this.map = map;
			this.myID = myID;
			this.fronts = /* @__PURE__ */ new Map();
			this.coast = /* @__PURE__ */ new Set();
			this.sites = /* @__PURE__ */ new Set();
			this.landingCoasts = /* @__PURE__ */ new Map();
			this.landingOwners = /* @__PURE__ */ new Map();
			this.frontierOwners = /* @__PURE__ */ new Map();
			this.coastCells = /* @__PURE__ */ new Map();
			this.scratch = /* @__PURE__ */ new Set();
			this.cursor = 0;
			this.width = map.width();
			this.size = this.width * map.height();
			this.columns = Math.ceil(this.width / 64);
		}
		get ready() {
			return this.cursor === this.size;
		}
		/** Bounded baseline work; callers choose how many tiles fit their budget. */
		initialize(count = 8192) {
			const end = Math.min(this.size, this.cursor + count);
			for (; this.cursor < end; this.cursor++) this.refresh(this.cursor);
		}
		ingest(changed) {
			this.scratch.clear();
			for (const tile of changed) {
				this.scratch.add(tile);
				this.neighbors(tile, (n) => this.scratch.add(n));
			}
			for (const tile of this.scratch) this.refresh(tile);
		}
		neighbors(tile, visit) {
			const x = tile % this.width;
			if (tile >= this.width) visit(tile - this.width);
			if (tile + this.width < this.size) visit(tile + this.width);
			if (x > 0) visit(tile - 1);
			if (x + 1 < this.width) visit(tile + 1);
		}
		cell(tile) {
			return Math.floor(tile % this.width / 64) + Math.floor(tile / this.width / 64) * this.columns;
		}
		refresh(tile) {
			this.sites.delete(tile);
			const oldLandingOwner = this.landingOwners.get(tile);
			if (oldLandingOwner !== void 0) {
				const coast = this.landingCoasts.get(oldLandingOwner);
				coast.delete(tile);
				if (coast.size === 0) this.landingCoasts.delete(oldLandingOwner);
				this.landingOwners.delete(tile);
			}
			const oldOwner = this.frontierOwners.get(tile);
			if (oldOwner !== void 0) {
				const front = this.fronts.get(oldOwner);
				front.delete(tile);
				if (front.size === 0) this.fronts.delete(oldOwner);
				this.frontierOwners.delete(tile);
			}
			if (this.coast.delete(tile)) {
				const cell = this.cell(tile);
				const entries = this.coastCells.get(cell);
				entries.delete(tile);
				if (entries.size === 0) this.coastCells.delete(cell);
			}
			if (!this.map.isLand(tile) || this.map.isImpassable(tile)) return;
			const owner = this.map.ownerID(tile);
			if (owner === this.myID && tile % this.width % 16 === 0 && Math.floor(tile / this.width) % 16 === 0 && (this.map.tileState(tile) & 8192) === 0) this.sites.add(tile);
			let ownNeighbor = false;
			let waterNeighbor = false;
			this.neighbors(tile, (n) => {
				if (this.map.ownerID(n) === this.myID && this.map.isLand(n)) ownNeighbor = true;
				if (!this.map.isLand(n)) waterNeighbor = true;
			});
			if (owner !== this.myID && ownNeighbor) {
				let front = this.fronts.get(owner);
				if (!front) this.fronts.set(owner, front = /* @__PURE__ */ new Set());
				front.add(tile);
				this.frontierOwners.set(tile, owner);
			}
			if (owner === this.myID && waterNeighbor) {
				this.coast.add(tile);
				const cell = this.cell(tile);
				let entries = this.coastCells.get(cell);
				if (!entries) this.coastCells.set(cell, entries = /* @__PURE__ */ new Set());
				entries.add(tile);
			} else if (owner !== this.myID && waterNeighbor && (this.map.tileState(tile) & 8192) === 0) {
				let coast = this.landingCoasts.get(owner);
				if (!coast) this.landingCoasts.set(owner, coast = /* @__PURE__ */ new Set());
				coast.add(tile);
				this.landingOwners.set(tile, owner);
			}
		}
		landingSites(owner, round, limit = 3) {
			const coast = [...this.landingCoasts.get(owner) ?? []].map((tile) => ({
				tile,
				distance: this.coastDistance(tile)
			})).sort((a, b) => a.distance - b.distance || a.tile - b.tile);
			const result = [];
			for (let i = 0; i < Math.min(limit, coast.length); i++) result.push(coast[(round * limit + i) % coast.length].tile);
			return result;
		}
		sample(owner) {
			let best;
			let magnitude = Infinity;
			let count = 0;
			for (const tile of this.fronts.get(owner) ?? []) {
				const m = (this.map.terrainByte(tile) & 31) + ((this.map.tileState(tile) & 8192) !== 0 ? 100 : 0);
				if (m < magnitude) {
					best = tile;
					magnitude = m;
				}
				if (++count === 32) break;
			}
			return best;
		}
		coastalSites(round, limit = 8) {
			const cells = [...this.coastCells.values()];
			if (cells.length === 0) return [];
			const result = [];
			for (let i = 0; i < Math.min(limit, cells.length); i++) {
				const entries = cells[(round + i) % cells.length];
				const offset = round % Math.min(32, entries.size);
				let index = 0;
				for (const tile of entries) if (index++ === offset) {
					result.push(tile);
					break;
				}
			}
			return result;
		}
		coastDistance(tile) {
			const nearest = this.nearCoast(tile);
			return nearest === void 0 ? Infinity : Math.hypot(nearest % this.width - tile % this.width, Math.floor(nearest / this.width) - Math.floor(tile / this.width));
		}
		nearCoast(tile, radius = Infinity) {
			const x = tile % this.width;
			const y = Math.floor(tile / this.width);
			let nearest;
			let distance = radius * radius;
			for (const [cell, entries] of this.coastCells) {
				const left = cell % this.columns * 64;
				const top = Math.floor(cell / this.columns) * 64;
				const dx = Math.max(left - x, 0, x - (left + 63));
				const dy = Math.max(top - y, 0, y - (top + 63));
				if (dx * dx + dy * dy > distance) continue;
				for (const ref of entries) {
					const d = (ref % this.width - x) ** 2 + (Math.floor(ref / this.width) - y) ** 2;
					if (d < distance || d === distance && (nearest === void 0 || ref < nearest)) {
						nearest = ref;
						distance = d;
					}
				}
			}
			return nearest;
		}
		/** Test blast overlap against current ownership, including outside targets. */
		blastTouches(tile, radius) {
			const x = tile % this.width;
			const y = Math.floor(tile / this.width);
			for (let yy = Math.max(0, y - radius); yy <= Math.min(this.map.height() - 1, y + radius); yy++) {
				const span = Math.floor(Math.sqrt(radius ** 2 - (yy - y) ** 2));
				for (let xx = Math.max(0, x - span); xx <= Math.min(this.width - 1, x + span); xx++) {
					const ref = yy * this.width + xx;
					if (this.map.isLand(ref) && this.map.ownerID(ref) === this.myID) return true;
				}
			}
			return false;
		}
	};
	//#endregion
	//#region src/Observer.ts
	var UnsupportedClient = class extends Error {};
	function methods(value, names, label) {
		if (!value || typeof value !== "object") throw new UnsupportedClient(`Missing ${label}.`);
		const object = value;
		for (const name of names) if (typeof object[name] !== "function") throw new UnsupportedClient(`Missing ${label}.${name}().`);
	}
	function bool(value, label) {
		if (typeof value !== "boolean") throw new UnsupportedClient(`Invalid ${label}.`);
		return value;
	}
	function finite(value, label) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new UnsupportedClient(`Invalid ${label}.`);
		return value;
	}
	function rawTroops(value) {
		const raw = Math.floor(finite(value, "troop count"));
		if (!Number.isSafeInteger(raw)) throw new UnsupportedClient("Invalid troop count.");
		return raw;
	}
	function emptyAdvisor(status = "disabled", enabled = false) {
		return {
			status,
			enabled,
			cap: null,
			reservePercent: null,
			incoming: null,
			recommendation: null,
			context: null,
			neighbors: []
		};
	}
	function validateGame(game) {
		methods(game, [
			"update",
			"myPlayer",
			"players",
			"units",
			"config",
			"ticks",
			"ticksSinceStart",
			"elapsedGameSeconds",
			"numLandTiles",
			"numTilesWithFallout",
			"recentlyUpdatedTiles",
			"gameOver",
			"inSpawnPhase",
			"isCatchingUp",
			"width",
			"height",
			"ownerID",
			"isLand",
			"isImpassable",
			"tileState"
		], "GameView");
		const size = game.width() * game.height();
		if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(game.width()) || !Number.isSafeInteger(game.height()) || game.width() <= 0 || game.height() <= 0) throw new UnsupportedClient("Invalid map dimensions.");
		methods(game.config(), [
			"maxTroops",
			"gameConfig",
			"percentageTilesOwnedToWin",
			"doomsdayClockConfig",
			"nukeMagnitudes"
		], "config");
	}
	function observe(game) {
		const me = game.myPlayer();
		methods(me, ["smallID", "isFriendly"], "myPlayer");
		const config = game.config();
		const remotePlayers = game.players();
		if (!Array.isArray(remotePlayers) || remotePlayers.length > 512) throw new UnsupportedClient("Invalid or unsupported player roster size.");
		const players = remotePlayers.map((p) => {
			methods(p, [
				"smallID",
				"displayName",
				"type",
				"team",
				"isAlive",
				"numTilesOwned",
				"troops",
				"incomingAttacks",
				"outgoingAttacks"
			], "player");
			const id = finite(p.smallID(), "player ID");
			if (!Number.isSafeInteger(id) || id === 0) throw new UnsupportedClient("Invalid player ID.");
			const name = p.displayName();
			const team = p.team();
			const type = p.type();
			if (typeof name !== "string" || team !== null && typeof team !== "string" || !Object.values(PlayerType).includes(type)) throw new UnsupportedClient("Invalid player identity.");
			const disconnected = bool(p.state?.isDisconnected, "player disconnection");
			const sum = (attacks) => {
				if (!Array.isArray(attacks)) throw new UnsupportedClient("Invalid attacks.");
				return rawTroops(attacks.reduce((n, a) => n + finite(a.troops, "attack troops"), 0));
			};
			return {
				id,
				name,
				team,
				type,
				alive: bool(p.isAlive(), "player alive"),
				disconnected,
				friendly: p === me || !disconnected && bool(me.isFriendly(p), "friendship"),
				tiles: finite(p.numTilesOwned(), "player territory"),
				troops: rawTroops(p.troops()),
				incoming: 0,
				outgoing: sum(p.outgoingAttacks()),
				doomed: bool(p.state?.inDoomsdayClock, "doomsday state"),
				traitor: false,
				alliances: []
			};
		});
		const playerTypes = new Map(players.map((p) => [p.id, p.type]));
		for (const [index, p] of remotePlayers.entries()) {
			const attacks = p.incomingAttacks();
			if (!Array.isArray(attacks)) throw new UnsupportedClient("Invalid attacks.");
			players[index].incoming = rawTroops(attacks.reduce((total, attack) => {
				const troops = finite(attack.troops, "attack troops");
				if (!Number.isSafeInteger(attack.attackerID) || attack.attackerID <= 0) throw new UnsupportedClient("Invalid attack sender.");
				return playerTypes.get(attack.attackerID) === PlayerType.Bot ? total : total + troops;
			}, 0));
		}
		const myID = me.smallID();
		const own = players.find((p) => p.id === myID);
		if (!own) throw new UnsupportedClient("Local player absent from players().");
		const tile = (value) => {
			if (!Number.isSafeInteger(value) || value < 0 || value >= game.width() * game.height()) throw new UnsupportedClient("Invalid unit tile.");
			return value;
		};
		const units = game.units().map((u) => {
			methods(u, [
				"id",
				"owner",
				"type",
				"tile",
				"targetTile",
				"isActive"
			], "unit");
			methods(u.owner(), ["smallID"], "unit owner");
			const type = u.type();
			if (!Object.values(UnitType).includes(type)) throw new UnsupportedClient("Invalid unit type.");
			const target = u.targetTile();
			const nuclear = [
				UnitType.AtomBomb,
				UnitType.HydrogenBomb,
				UnitType.MIRVWarhead
			].includes(type);
			return {
				id: finite(u.id(), "unit ID"),
				owner: finite(u.owner().smallID(), "unit owner ID"),
				type,
				tile: tile(u.tile()),
				target: target === null || target === void 0 ? null : tile(target),
				active: bool(u.isActive(), "unit active"),
				retreating: type === UnitType.TransportShip ? bool(u.state?.retreating, "transport retreating") : false,
				range: nuclear ? finite(config.nukeMagnitudes(type).outer, "blast radius") : 0,
				constructing: false,
				level: 0,
				ready: 0,
				troops: 0,
				arrivalTick: null
			};
		});
		const mode = config.gameConfig()?.gameMode;
		if (!Object.values(GameMode).includes(mode)) throw new UnsupportedClient("Invalid game mode.");
		const sideTiles = players.filter((p) => p.id === myID || mode !== GameMode.FFA && own.team !== null && p.team === own.team && p.alive).reduce((n, p) => n + p.tiles, 0);
		return {
			tick: finite(game.ticks(), "tick"),
			elapsed: finite(game.ticksSinceStart(), "elapsed ticks"),
			myID,
			players,
			units,
			cap: rawTroops(config.maxTroops(me)),
			landShare: sideTiles / Math.max(1, finite(game.numLandTiles(), "land tiles") - finite(game.numTilesWithFallout(), "fallout tiles")),
			winShare: finite(config.percentageTilesOwnedToWin(finite(game.elapsedGameSeconds(), "elapsed seconds")), "win percentage") / 100,
			clockEnabled: bool(config.doomsdayClockConfig()?.enabled, "doomsday enabled"),
			growth: 0,
			gold: 0n,
			builds: [],
			queryState: "checking",
			attackable: /* @__PURE__ */ new Set()
		};
	}
	function analyze(o, map, spatial) {
		const me = o.players.find((p) => p.id === o.myID);
		const context = gamePhase(o, map, spatial);
		const reserveThreshold = context === "opening" ? .33 : .42;
		const strongerNeighbors = o.players.filter((p) => p.id !== me.id && p.alive && spatial.fronts.has(p.id) && p.troops > me.troops);
		return {
			status: "active",
			enabled: true,
			cap: rawTroops(o.cap),
			reservePercent: Math.round(me.troops / Math.max(1, o.cap) * 100),
			incoming: rawTroops(me.incoming),
			recommendation: me.incoming === 0 && strongerNeighbors.length === 0 && me.troops > o.cap * reserveThreshold ? "push" : "retain",
			context,
			neighbors: strongerNeighbors.map((p) => ({
				id: p.id,
				name: p.name.slice(0, 200),
				troops: rawTroops(p.troops),
				friendly: p.friendly || me.team !== null && p.team === me.team
			})).sort((a, b) => a.id - b.id)
		};
	}
	var scheduler = {
		now: () => performance.now(),
		schedule: (callback) => setTimeout(callback, 0),
		cancel: (handle) => clearTimeout(handle)
	};
	var observers = /* @__PURE__ */ new WeakMap();
	/** Instance-local, read-only observer. Only the display snapshot escapes it. */
	var GameObserver = class {
		constructor(game, onSnapshot, clock = scheduler, maxPending = 32768) {
			this.game = game;
			this.onSnapshot = onSnapshot;
			this.clock = clock;
			this.maxPending = maxPending;
			this.snapshot = emptyAdvisor();
			this.spatial = null;
			this.pending = /* @__PURE__ */ new Set();
			this.original = null;
			this.wrapper = null;
			this.ownUpdate = false;
			this.handle = null;
			this.lastTick = -1;
			this.lastSeenTick = -1;
			this.myID = null;
			this.active = false;
			this.rebuilding = false;
		}
		setEnabled(enabled) {
			this.stop();
			this.snapshot = emptyAdvisor(enabled ? "waiting" : "disabled", enabled);
			if (!enabled) {
				this.emit();
				return;
			}
			observers.get(this.game)?.dispose();
			observers.set(this.game, this);
			this.active = true;
			this.guard(() => {
				validateGame(this.game);
				this.original = this.game.update;
				this.ownUpdate = Object.hasOwn(this.game, "update");
				const original = this.original;
				const completed = (receiver) => {
					if (receiver === this.game && this.active) this.guard(() => this.updated());
				};
				this.wrapper = function(...args) {
					const result = Reflect.apply(original, this, args);
					completed(this);
					return result;
				};
				this.game.update = this.wrapper;
				this.work();
			});
			this.emit();
		}
		dispose() {
			this.stop();
			this.snapshot = emptyAdvisor();
		}
		/** Discovery-loop health check also handles paused games and replaced hooks. */
		poll() {
			if (!this.active) return;
			this.guard(() => {
				if (this.game.update !== this.wrapper) throw new UnsupportedClient("GameView.update observer was replaced.");
				this.work();
			});
		}
		clearIndex() {
			this.spatial = null;
			this.pending.clear();
			this.lastTick = -1;
			if (this.handle !== null) this.clock.cancel(this.handle);
			this.handle = null;
		}
		stop() {
			this.active = false;
			if (observers.get(this.game) === this) observers.delete(this.game);
			this.clearIndex();
			if (this.wrapper && this.game.update === this.wrapper && this.original) if (this.ownUpdate) this.game.update = this.original;
			else delete this.game.update;
			this.wrapper = this.original = null;
			this.lastSeenTick = -1;
			this.myID = null;
			this.rebuilding = false;
		}
		emit(urgent = false) {
			try {
				this.onSnapshot(this.snapshot, urgent);
			} catch {}
		}
		guard(run) {
			try {
				run();
			} catch (error) {
				this.stop();
				this.snapshot = {
					...emptyAdvisor(error instanceof UnsupportedClient ? "unsupported" : "error"),
					error: error instanceof Error ? error.message.slice(0, 240) : "Advisor observation failed."
				};
				this.emit(true);
			}
		}
		updated() {
			const tick = this.game.ticks();
			if (tick < this.lastSeenTick) {
				this.clearIndex();
				this.rebuilding = true;
			}
			this.lastSeenTick = tick;
			if (this.spatial) {
				const tiles = this.game.recentlyUpdatedTiles();
				if (!Array.isArray(tiles)) throw new UnsupportedClient("Invalid recentlyUpdatedTiles().");
				if (tiles.length > this.maxPending) {
					this.clearIndex();
					this.rebuilding = true;
				} else for (const ref of tiles) {
					if (!Number.isSafeInteger(ref) || ref < 0 || ref >= this.game.width() * this.game.height()) throw new UnsupportedClient("Invalid changed tile.");
					this.pending.add(ref);
					if (this.pending.size > this.maxPending) {
						this.clearIndex();
						this.rebuilding = true;
						break;
					}
				}
			}
			this.work();
		}
		work() {
			if (!this.active) return;
			const me = this.game.myPlayer();
			if (me) methods(me, ["isAlive", "smallID"], "myPlayer");
			if (bool(this.game.inSpawnPhase(), "spawn phase")) {
				this.clearIndex();
				this.snapshot = emptyAdvisor("waiting", true);
				this.emit();
				return;
			}
			if (bool(this.game.gameOver(), "gameOver") || me && !bool(me.isAlive(), "player alive")) {
				this.stop();
				this.snapshot = emptyAdvisor("finished");
				this.emit(true);
				return;
			}
			if (!me) {
				this.clearIndex();
				this.snapshot = emptyAdvisor("waiting", true);
				this.emit();
				return;
			}
			if (bool(this.game.isCatchingUp(), "catchup")) {
				this.clearIndex();
				this.snapshot = emptyAdvisor("catchup", true);
				this.emit();
				return;
			}
			if (me.smallID() !== this.myID) {
				this.clearIndex();
				this.myID = me.smallID();
			}
			this.spatial ??= new SpatialIndex(this.game, this.myID);
			const deadline = this.clock.now() + 2;
			do {
				const batch = [];
				for (const ref of this.pending) {
					batch.push(ref);
					this.pending.delete(ref);
					if (batch.length === 128) break;
				}
				if (batch.length) this.spatial.ingest(batch);
				else if (!this.spatial.ready) this.spatial.initialize(128);
				else break;
			} while (this.clock.now() < deadline);
			if (!this.spatial.ready || this.pending.size) {
				this.snapshot = emptyAdvisor(this.rebuilding ? "catchup" : "indexing", true);
				if (this.handle === null) this.handle = this.clock.schedule(() => {
					this.handle = null;
					this.guard(() => this.work());
				});
				this.emit();
				return;
			}
			this.rebuilding = false;
			const tick = this.game.ticks();
			if (tick === this.lastTick) return;
			const previousIncoming = this.snapshot.incoming;
			this.snapshot = analyze(observe(this.game), this.game, this.spatial);
			this.lastTick = tick;
			this.emit(this.snapshot.incoming !== previousIncoming && this.snapshot.incoming > 0);
		}
	};
	//#endregion
	//#region src/Main.ts
	function postWarning(type) {
		window.postMessage({ type }, window.location.origin);
	}
	function isControl(data) {
		if (!data || typeof data !== "object") return false;
		const value = data;
		return Object.keys(value).every((key) => [
			"type",
			"enabled",
			"requestId"
		].includes(key)) && value.type === "OPENFRONT_OVERLAY_CONTROL" && typeof value.enabled === "boolean" && (value.requestId === void 0 || Number.isSafeInteger(value.requestId) && Number(value.requestId) > 0);
	}
	function startBridge() {
		let game = null;
		let buildMenu = null;
		let observer = null;
		let advisor = emptyAdvisor();
		let stopped = false;
		let inGame = false;
		let lastError = null;
		let lastSiloError = null;
		let lastBoatError = null;
		let incomingBoatIds = /* @__PURE__ */ new Set();
		let lastSiloSignature = null;
		let hasEnemySilos = false;
		let hasWarnedFirstEnemySilo = false;
		let discoveryError = null;
		let requestedEnabled = false;
		let controlId = 0;
		let siloFrame = null;
		const discover = () => {
			try {
				readDiscovery();
				discoveryError = null;
			} catch (error) {
				observer?.dispose();
				observer = null;
				game = null;
				requestedEnabled = false;
				discoveryError = /* @__PURE__ */ new Error(`Cannot discover GameView: ${error instanceof Error ? error.message : String(error)}`);
				advisor = {
					...emptyAdvisor("error"),
					error: discoveryError.message.slice(0, 240)
				};
			}
		};
		const readDiscovery = () => {
			const playing = !!document.body?.classList.contains("in-game");
			const foundMenu = playing ? document.querySelector("build-menu") : null;
			const found = foundMenu?.game ?? null;
			if (found !== game || playing !== inGame) {
				if (!playing || playing !== inGame || game !== null) requestedEnabled = false;
				observer?.dispose();
				observer = null;
				game = found;
				buildMenu = foundMenu;
				inGame = playing;
				lastSiloError = null;
				lastBoatError = null;
				incomingBoatIds = /* @__PURE__ */ new Set();
				lastSiloSignature = null;
				hasEnemySilos = false;
				hasWarnedFirstEnemySilo = false;
				advisor = emptyAdvisor(requestedEnabled ? "waiting" : "disabled", requestedEnabled);
			} else buildMenu = foundMenu;
		};
		const enableObserver = () => {
			if (!game || observer || !requestedEnabled) return;
			observer = new GameObserver(game, (snapshot, urgent) => {
				advisor = snapshot;
				if (!snapshot.enabled) requestedEnabled = false;
				if (urgent) publish();
			});
			observer.setEnabled(true);
			advisor = observer.snapshot;
		};
		const readEnemySilos = () => {
			let missileSilos = [];
			try {
				if (inGame && game) {
					const currentGame = game;
					if (typeof currentGame.myPlayer !== "function") throw new Error("Missing GameView.myPlayer().");
					const player = currentGame.myPlayer();
					if (!player) {
						hasEnemySilos = false;
						return missileSilos;
					}
					const transform = buildMenu?.transformHandler;
					if (!transform || typeof transform.worldToScreenCoordinates !== "function" || !Number.isFinite(transform.scale) || transform.scale <= 0) throw new Error("Missing BuildMenu.transformHandler.");
					if (typeof currentGame.units !== "function" || typeof currentGame.x !== "function" || typeof currentGame.y !== "function" || typeof player.smallID !== "function" || typeof player.isFriendly !== "function") throw new Error("Missing GameView unit coordinates.");
					const units = currentGame.units(UnitType.MissileSilo);
					if (!Array.isArray(units)) throw new Error("Invalid GameView units.");
					missileSilos = [];
					for (const unit of units) {
						if (typeof unit.isActive !== "function") throw new Error("Missing unit.isActive().");
						if (!unit.isActive()) continue;
						if (typeof unit.id !== "function" || typeof unit.owner !== "function" || typeof unit.tile !== "function") throw new Error("Missing enemy silo data.");
						const owner = unit.owner();
						if (!owner || typeof owner.smallID !== "function" || typeof owner.isAlive !== "function") throw new Error("Missing enemy silo owner data.");
						const ownerID = owner.smallID();
						if (!Number.isSafeInteger(ownerID)) throw new Error("Invalid enemy silo owner.");
						if (!owner.isAlive() || ownerID === player.smallID() || player.isFriendly(owner)) continue;
						const tile = unit.tile();
						if (!Number.isSafeInteger(tile) || tile < 0) throw new Error("Invalid enemy silo tile.");
						const world = {
							x: currentGame.x(tile) + .5,
							y: currentGame.y(tile) + .5
						};
						const screen = transform.worldToScreenCoordinates(world);
						const marker = {
							id: unit.id(),
							x: screen.x,
							y: screen.y,
							radius: Math.max(12, Math.min(42, transform.scale * 1.7))
						};
						if (!Number.isSafeInteger(marker.id) || !Number.isFinite(marker.x) || !Number.isFinite(marker.y)) throw new Error("Invalid enemy silo position.");
						missileSilos.push(marker);
					}
				}
				lastSiloError = null;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message !== lastSiloError) {
					console.error("[OpenFront Overlay] Cannot read enemy silo positions:", error);
					lastSiloError = message;
				}
			}
			hasEnemySilos = missileSilos.length > 0;
			if (hasEnemySilos && !hasWarnedFirstEnemySilo) {
				hasWarnedFirstEnemySilo = true;
				postWarning("OPENFRONT_OVERLAY_FIRST_ENEMY_SILO");
			}
			return missileSilos;
		};
		const warnIncomingBoats = () => {
			if (stopped) return;
			const current = /* @__PURE__ */ new Set();
			let hasNew = false;
			try {
				if (inGame && game) {
					const currentGame = game;
					const player = currentGame.myPlayer?.();
					if (player) {
						if (typeof currentGame.units !== "function" || typeof currentGame.ownerID !== "function" || typeof player.smallID !== "function" || typeof player.isFriendly !== "function") throw new Error("Missing GameView transport data.");
						const units = currentGame.units(UnitType.TransportShip);
						if (!Array.isArray(units)) throw new Error("Invalid GameView units.");
						const myID = player.smallID();
						for (const unit of units) {
							if (typeof unit.isActive !== "function" || typeof unit.id !== "function" || typeof unit.owner !== "function" || typeof unit.targetTile !== "function") throw new Error("Missing transport unit data.");
							if (!unit.isActive() || unit.state?.retreating !== false) continue;
							const owner = unit.owner();
							if (!owner || typeof owner.smallID !== "function" || typeof owner.isAlive !== "function") throw new Error("Missing transport owner data.");
							if (!owner.isAlive() || owner.smallID() === myID || player.isFriendly(owner)) continue;
							const target = unit.targetTile();
							if (target === void 0 || target === null || !Number.isSafeInteger(target) || currentGame.ownerID(target) !== myID) continue;
							const id = unit.id();
							if (!Number.isSafeInteger(id)) throw new Error("Invalid transport ID.");
							current.add(id);
							if (!incomingBoatIds.has(id)) hasNew = true;
						}
					}
				}
				lastBoatError = null;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message !== lastBoatError) {
					console.error("[OpenFront Overlay] Cannot read incoming transports:", error);
					lastBoatError = message;
				}
				return;
			}
			incomingBoatIds = current;
			if (hasNew) postWarning("OPENFRONT_OVERLAY_INCOMING_BOAT");
		};
		const publishSiloMarkers = (force = false) => {
			if (stopped) return;
			const missileSilos = readEnemySilos();
			const signature = JSON.stringify(missileSilos);
			if (!force && signature === lastSiloSignature) return;
			lastSiloSignature = signature;
			window.postMessage({
				type: "OPENFRONT_OVERLAY_SILOS",
				missileSilos
			}, window.location.origin);
		};
		const publish = () => {
			if (stopped) return;
			let status = "idle";
			let troops = null;
			try {
				if (discoveryError) throw discoveryError;
				if (inGame) {
					status = "waiting";
					if (game) {
						if (typeof game.myPlayer !== "function") throw new Error("Missing myPlayer().");
						const me = game.myPlayer();
						if (me) {
							if (typeof me.troops !== "function") throw new Error("Missing player.troops().");
							troops = rawTroops(me.troops());
							status = "playing";
						}
					}
				}
				lastError = null;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message !== lastError) {
					console.error("[OpenFront Overlay] Cannot read game state:", error);
					lastError = message;
				}
				status = "unavailable";
			}
			const missileSilos = readEnemySilos();
			lastSiloSignature = JSON.stringify(missileSilos);
			window.postMessage({
				type: "OPENFRONT_OVERLAY_STATE",
				status,
				troops,
				advisor,
				controlId,
				missileSilos
			}, window.location.origin);
		};
		const control = (event) => {
			if (event.source !== window || event.origin !== window.location.origin || !isControl(event.data)) return;
			discover();
			controlId = event.data.requestId ?? controlId;
			requestedEnabled = inGame && !discoveryError && event.data.enabled;
			if (!game) {
				if (!discoveryError) advisor = emptyAdvisor(requestedEnabled ? "waiting" : "disabled", requestedEnabled);
				publish();
				return;
			}
			observer?.dispose();
			observer = null;
			advisor = emptyAdvisor();
			enableObserver();
			publish();
		};
		const scheduleSiloFrame = () => {
			if (stopped || !inGame || !game || !hasEnemySilos || siloFrame !== null) return;
			siloFrame = window.requestAnimationFrame(() => {
				siloFrame = null;
				if (!inGame || !game || stopped) return;
				publishSiloMarkers();
				scheduleSiloFrame();
			});
		};
		const poll = () => {
			discover();
			enableObserver();
			observer?.poll();
			warnIncomingBoats();
			publish();
			scheduleSiloFrame();
		};
		const stop = () => {
			stopped = true;
			observer?.dispose();
			window.clearInterval(timer);
			if (siloFrame !== null) window.cancelAnimationFrame(siloFrame);
			window.removeEventListener("message", control);
			window.removeEventListener("pagehide", stop);
			window.__openfrontOverlayBridgeStarted = false;
		};
		window.addEventListener("message", control);
		window.addEventListener("pagehide", stop);
		poll();
		const timer = window.setInterval(poll, 500);
		return stop;
	}
	if (typeof window !== "undefined" && !window.__openfrontOverlayBridgeStarted) {
		window.__openfrontOverlayBridgeStarted = true;
		startBridge();
	}
	//#endregion
	exports.isControl = isControl;
	exports.startBridge = startBridge;
	return exports;
})({});
