/* GRIMALKIN 1010 — EngineBridge: the global game loop.
 *
 * Owns the world (entities, toroidal physics, collisions, spawning, scoring),
 * the camera, the HUD, and BOTH renderers. Gameplay state lives here and only
 * here, so swapping the active renderer (Retro <-> Neo) never touches it.
 */

class NullAudio {
    constructor() { this.maxHearingRadius = 1600; }
    resume() { } setMode() { } setThrust() { } setDread() { } setMuted() { } sfx() { }
    triggerTaunt() { return 0; }
    isSpeaking() { return false; }
    getVoiceLevel() { return 0; }
    getVoiceBands() { return [0, 0, 0]; }
}

class EngineBridge {
    constructor(opts) {
        opts = opts || {};
        this.headless = !!opts.headless;
        this.currentMode = opts.mode || 'MODE_NEO';      // default mode
        this.state = new StateManager();
        this.worldSize = { x: 5000, y: 5000 };           // 2D toroidal wrap grid
        this.camera = { x: 2500, y: 2500, zoom: 1.0, ux: 2500, uy: 2500, shakeX: 0, shakeY: 0 };
        this.entities = [];
        this.pending = [];
        this.byType = { player: [], asteroid: [], crystal: [], worker: [], warrior: [], shot: [], bomb: [], beam: [], particle: [], boss: [] };
        this.renderList = [];

        this.bossPartsCollected = 0;                     // out of 12 required
        this.playerBombs = 0;
        this.score = 0;
        this.hiScore = 0;
        this.lives = 3;
        this.wave = 1;
        this.bossKills = 0;

        this.player = null;
        this.boss = null;
        this.input = opts.input || null;
        this.audio = opts.audio || new NullAudio();
        this.engines = { MODE_RETRO: null, MODE_NEO: null };
        this.activeEngine = null;
        this.engineFactory = opts.engineFactory || null;

        this.rand = GMath.rng(opts.seed !== undefined ? opts.seed : (Date.now() & 0xffffffff));
        this.time = 0;
        this.paused = false;
        this.muted = false;
        this.voiceLevel = 0;
        this.voiceBands = [0, 0, 0];
        this.flash = 0;
        this.flashColor = [1, 1, 1];
        this.trauma = 0;
        this.dread = 0;
        this.respawnTimer = 0;
        this.bossRespawnTimer = 0;
        this.droneTimer = 4;
        this.attractTimer = 0;
        this.attractFocus = null;
        this.bannerTimer = 0;
        this.frame = {
            time: 0, dt: 0, state: this.state.current, voiceLevel: 0, voiceBands: this.voiceBands,
            flash: 0, flashColor: this.flashColor, bossAwake: false, dread: 0, badgeImage: null, paused: false
        };
        this.hudCache = {};
        this.fps = 60;
        this.debug = false;
        this.modeSwitches = 0;
    }

    /** The template's `gameState` string, backed by the state machine. */
    get gameState() { return this.state.current; }

    /* ================================================================ boot */

    init() {
        this.debug = /[?&]debug/.test(location.search);
        if (typeof AudioSynthMatrix !== 'undefined') {
            try { this.audio = new AudioSynthMatrix(); } catch (e) { console.warn('Audio unavailable', e); }
        }
        if (typeof InputManager !== 'undefined') this.input = new InputManager(document.body);
        try { this.hiScore = parseInt(localStorage.getItem('grimalkin.hi') || '0', 10) || 0; } catch (e) { }
        try {
            const saved = localStorage.getItem('grimalkin.mode');
            if (saved === 'MODE_RETRO' || saved === 'MODE_NEO') this.currentMode = saved;
        } catch (e) { }

        if (typeof BADGE_DATA_URI !== 'undefined') {
            const img = new Image();
            img.onload = () => { this.frame.badgeImage = img; };
            img.src = BADGE_DATA_URI;
        }

        this.cacheDom();
        this.setupContexts();
        this.bindGlobalInputs();
        this.populateWorld(null);
        this.state.set(StateManager.ATTRACT);
        this.showScreen('title');
        if (this.debug) this.applyDebugParams();
        this.loop();
    }

    /** ?debug&mode=retro|neo&autostart&awake&bombs — handy for demos and screenshots. */
    applyDebugParams() {
        const q = location.search;
        const m = /[?&]mode=(retro|neo)/.exec(q);
        if (m) this.applyMode(m[1] === 'retro' ? 'MODE_RETRO' : 'MODE_NEO');
        if (/[?&]autostart/.test(q)) {
            this.startGame();
            this.player.invuln = /[?&]god/.test(q) ? 1e9 : 3;
        }
        if (/[?&]bombs/.test(q)) this.playerBombs = PlayerShip.MAX_BOMBS;
        const b = /[?&](awake|built)(?:=(\d+))?/.exec(q);
        if (b && this.boss && this.player) {
            this.boss.x = GMath.wrap(this.player.x + 230, this.worldSize.x);
            this.boss.y = GMath.wrap(this.player.y - 150, this.worldSize.y);
            const n = b[1] === 'awake' ? 12 : Math.min(11, parseInt(b[2] || '7', 10));
            for (let i = 0; i < n; i++) this.boss.addPiece();
        }
    }

    setupContexts() {
        this.retroCanvas = document.getElementById('retroCanvas');
        this.neoCanvas = document.getElementById('neoCanvas');
        this.applyMode(this.currentMode);
    }

    /** Show one renderer, hide the other. Engines are created once and kept. */
    applyMode(mode) {
        this.currentMode = mode;
        if (!this.engines[mode]) this.engines[mode] = this.createEngine(mode);
        let engine = this.engines[mode];

        if (mode === 'MODE_NEO' && (!engine || engine.failed)) {
            // No WebGL2: fall back to the vector monitor rather than a black screen.
            this.notice('WebGL2 unavailable — staying on RETRO');
            this.currentMode = mode = 'MODE_RETRO';
            if (!this.engines[mode]) this.engines[mode] = this.createEngine(mode);
            engine = this.engines[mode];
        }
        this.activeEngine = engine;

        if (!this.headless) {
            const retro = mode === 'MODE_RETRO';
            this.retroCanvas.style.display = retro ? 'block' : 'none';
            this.neoCanvas.style.display = retro ? 'none' : 'block';
            document.body.classList.toggle('mode-retro', retro);
            document.body.classList.toggle('mode-neo', !retro);
            if (this.dom.modeLabel) this.dom.modeLabel.textContent = retro ? 'RETRO' : 'NEO 2.5D';
            this.resize();
            try { localStorage.setItem('grimalkin.mode', mode); } catch (e) { }
        }
        this.audio.setMode(mode);
        if (engine && engine.onEvent) { try { engine.onEvent({ type: 'modeEnter' }); } catch (e) { } }
    }

    createEngine(mode) {
        try {
            if (this.engineFactory) return this.engineFactory(mode);
            if (mode === 'MODE_RETRO') return new RetroEngine(this.retroCanvas);
            return new NeoEngine(this.neoCanvas);
        } catch (e) {
            console.error('Engine init failed for ' + mode, e);
            return null;
        }
    }

    /** Swap renderers. Deliberately touches no gameplay state. */
    toggleMode() {
        this.modeSwitches++;
        this.applyMode(this.currentMode === 'MODE_RETRO' ? 'MODE_NEO' : 'MODE_RETRO');
        this.audio.sfx('uiToggle');
    }

    resize() {
        if (this.headless || !this.activeEngine || !this.activeEngine.resize) return;
        try { this.activeEngine.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1); }
        catch (e) { console.error(e); }
    }

    bindGlobalInputs() {
        const unlock = () => this.audio.resume();
        window.addEventListener('keydown', unlock);
        window.addEventListener('pointerdown', unlock);
        window.addEventListener('resize', () => this.resize());
        document.addEventListener('visibilitychange', () => { if (document.hidden && this.state.inPlay) this.setPaused(true); });

        // The mode toggle is a plain DOM event listener.
        this.dom.modeBtn.addEventListener('click', (e) => { e.preventDefault(); this.toggleMode(); this.dom.modeBtn.blur(); });
        this.dom.muteBtn.addEventListener('click', (e) => { e.preventDefault(); this.toggleMute(); this.dom.muteBtn.blur(); });
        this.dom.startBtn.addEventListener('click', (e) => { e.preventDefault(); this.audio.resume(); this.startGame(); });

        if (this.debug) {
            window.addEventListener('keydown', (e) => {
                if (e.key === '9' && this.boss) this.boss.addPiece();
                if (e.key === '0') this.playerBombs = PlayerShip.MAX_BOMBS;
                if (e.key === '8' && this.boss) this.boss.takeBombHit();
            });
        }
    }

    /* =============================================================== world */

    spawn(ent) {
        ent.listed = true;
        this.pending.push(ent);
        return ent;
    }

    randomPointAwayFrom(p, minDist) {
        const w = this.worldSize;
        for (let i = 0; i < 40; i++) {
            const x = this.rand() * w.x, y = this.rand() * w.y;
            if (!p || Math.hypot(GMath.wrapDelta(x - p.x, w.x), GMath.wrapDelta(y - p.y, w.y)) >= minDist) return { x, y };
        }
        return { x: GMath.wrap((p ? p.x : 0) + w.x / 2, w.x), y: GMath.wrap((p ? p.y : 0) + w.y / 2, w.y) };
    }

    /** Rebuild the whole playfield. `keep` = the player's position to stay clear of. */
    populateWorld(keep) {
        for (let i = 0; i < this.entities.length; i++) { this.entities[i].alive = false; this.entities[i].listed = false; }
        for (let i = 0; i < this.pending.length; i++) this.pending[i].listed = false;
        this.entities.length = 0;
        this.pending.length = 0;
        for (const k in this.byType) this.byType[k].length = 0;
        this.player = null;
        this.boss = null;
        this.bossPartsCollected = 0;

        for (let i = 0; i < EngineBridge.ASTEROID_TARGET; i++) this.spawnAsteroid(keep, 260);
        this.spawnBoss(keep);
        const nw = this.workerTarget(), nc = this.warriorTarget();
        for (let i = 0; i < nw; i++) this.spawnDrone('worker', keep, 700);
        for (let i = 0; i < nc; i++) this.spawnDrone('warrior', keep, 1100);
        this.flushPending();
    }

    workerTarget() { return Math.min(9, 4 + this.wave); }
    warriorTarget() { return Math.min(7, 1 + this.wave); }

    spawnAsteroid(avoid, minDist) {
        const p = this.randomPointAwayFrom(avoid, minDist);
        const radius = 30 + Math.pow(this.rand(), 1.4) * 60;
        return this.spawn(new Asteroid(this, p.x, p.y, radius, (this.rand() * 1e9) | 0));
    }

    spawnBoss(avoid) {
        const p = this.randomPointAwayFrom(avoid, 1700);
        this.boss = this.spawn(new Grimalkin(this, p.x, p.y));
        this.bossPartsCollected = 0;
        return this.boss;
    }

    spawnDrone(kind, avoid, minDist) {
        const p = this.randomPointAwayFrom(avoid, minDist);
        return this.spawn(kind === 'worker' ? new WorkerDrone(this, p.x, p.y) : new WarriorDrone(this, p.x, p.y));
    }

    spawnPlayer(x, y) {
        this.player = this.spawn(new PlayerShip(this, x, y));
        return this.player;
    }

    /* ================================================================ flow */

    startGame() {
        this.score = 0;
        this.lives = 3;
        this.wave = 1;
        this.bossKills = 0;
        this.playerBombs = 0;
        this.respawnTimer = 0;
        this.bossRespawnTimer = 0;
        const start = { x: this.worldSize.x / 2, y: this.worldSize.y / 2 };
        this.populateWorld(start);
        // Clear a little breathing room around the start point.
        for (const a of this.byType.asteroid) if (GMath.dist(a, start, this.worldSize) < a.radius + 120) a.alive = false;
        this.spawnPlayer(start.x, start.y);
        this.flushPending();
        this.camera.x = start.x; this.camera.y = start.y;
        if (this.state.is(StateManager.GAMEOVER)) this.state.set(StateManager.ATTRACT);
        this.state.set(StateManager.MINING);
        this.setPaused(false);
        this.showScreen(null);
        this.banner('MINE THE ROCKS', 'shards become Nipbombs — the Scrappers want them too', 4);
        this.audio.sfx('uiSelect');
    }

    gameOver() {
        this.state.set(StateManager.GAMEOVER);
        if (this.score > this.hiScore) {
            this.hiScore = this.score;
            if (!this.headless) { try { localStorage.setItem('grimalkin.hi', String(this.hiScore)); } catch (e) { } }
        }
        this.showScreen('gameover');
        this.audio.setThrust(0);
    }

    toAttract() {
        this.wave = 1;
        this.populateWorld(null);
        this.state.set(StateManager.ATTRACT);
        this.showScreen('title');
    }

    setPaused(p) {
        if (!this.state.inPlay) p = false;
        this.paused = p;
        if (p) { this.audio.setThrust(0); this.audio.setDread(0); }
        if (!this.headless && this.dom.pause) this.dom.pause.classList.toggle('show', p);
    }

    toggleMute() {
        this.muted = !this.muted;
        this.audio.setMuted(this.muted);
        if (!this.headless) this.dom.muteBtn.textContent = this.muted ? 'SOUND OFF' : 'SOUND ON';
    }

    addScore(n) { this.score += n; }

    /* ------------------------------------------------------ entity callbacks */

    collectShard(c) {
        this.addScore(100);
        if (this.playerBombs < PlayerShip.MAX_BOMBS) {
            this.playerBombs++;
            this.audio.sfx('crystalPickup');
            if (this.playerBombs === PlayerShip.MAX_BOMBS) this.audio.sfx('bombReady');
        } else {
            this.addScore(150);
            this.audio.sfx('crystalPickup', { pitch: 1.5 });
        }
        this.sparks(c.x, c.y, 8, [1, 0.85, 0.2], 140, 0.4);
    }

    onBossPieceAdded(boss, idx) {
        this.bossPartsCollected = boss.built;
        this.sfxAt('pieceAttach', boss.x, boss.y);
        this.sparks(boss.x, boss.y, 14, [0.3, 0.9, 1], 260, 0.6);
        if (this.state.is(StateManager.MINING)) {
            if (boss.built === 6) { this.banner('GRIMALKIN IS HALF BUILT', 'bomb it now to knock plates off', 3); this.audio.triggerTaunt('HUNGER', this.distToPlayer(boss)); }
            if (boss.built === 10) this.banner('IT IS ALMOST COMPLETE', '', 2.5);
        }
    }

    onBossPieceLost(boss, idx) {
        this.bossPartsCollected = boss.built;
        const piece = Grimalkin.PIECES[idx], c = piece.poly[0];
        this.explode(boss.x + c[0] * boss.radius, boss.y + c[1] * boss.radius, 34, [1, 0.6, 0.15], 'explodeSmall', true);
    }

    onBossAwake(boss) {
        this.bossPartsCollected = 12;
        this.emit({ type: 'bossAwake' });
        this.sfxAt('bossAwake', boss.x, boss.y);
        this.flash = 0.8; this.flashColor[0] = 1; this.flashColor[1] = 0.85; this.flashColor[2] = 0.1;
        this.trauma = Math.max(this.trauma, 0.8);
        if (this.state.is(StateManager.ATTRACT)) {
            this.attractTimer = 9;            // show it off, then rebuild the diorama
            this.audio.triggerTaunt('NAME', 300);
            return;
        }
        this.state.set(StateManager.AWAKE);
        this.audio.triggerTaunt('AWAKE', Math.min(this.distToPlayer(boss), 600));
        this.banner('GRIMALKIN IS AWAKE', '13 Nipbombs. Run.', 4, true);
    }

    onBossHit(boss) {
        this.addScore(1000);
        this.sfxAt('bombHit', boss.x, boss.y);
        this.explode(boss.x, boss.y, 60, [0.6, 1, 0.45], null);
        this.trauma = Math.max(this.trauma, 0.5);
        this.flash = Math.max(this.flash, 0.25); this.flashColor[0] = 0.5; this.flashColor[1] = 1; this.flashColor[2] = 0.45;
    }

    onBossDying(boss) {
        this.addScore(1000);
        this.sfxAt('bossDie', boss.x, boss.y);
        this.audio.triggerTaunt('DEATH', 0);
        this.emit({ type: 'bossDeath', rx: boss.rx, ry: boss.ry });
        this.trauma = 1;
        this.banner('GRIMALKIN IS FALLING', '', 3);
    }

    onBossKilled(boss) {
        this.explode(boss.x, boss.y, 220, [1, 0.9, 0.4], 'explodeBig', true);
        this.flash = 1; this.flashColor[0] = 1; this.flashColor[1] = 1; this.flashColor[2] = 1;
        this.trauma = 1;
        for (let i = 0; i < 8; i++) {
            const a = this.rand() * GMath.TAU;
            this.spawn(new Crystal(this, boss.x, boss.y, Math.cos(a) * 260, Math.sin(a) * 260));
        }
        this.boss = null;
        this.bossPartsCollected = 0;
        if (!this.state.inPlay) return;
        this.addScore(20000);
        this.bossKills++;
        this.wave++;
        this.lives = Math.min(6, this.lives + 1);
        this.state.set(StateManager.MINING);
        this.bossRespawnTimer = 5;
        this.banner('GRIMALKIN DESTROYED', 'extra ship — wave ' + this.wave + ' incoming', 5);
    }

    killPlayer(cause) {
        const p = this.player;
        if (!p || !p.alive || p.invuln > 0) return false;
        p.alive = false;
        this.explode(p.x, p.y, 70, [0.1, 0.9, 1], 'playerDie', true);
        this.emit({ type: 'playerDeath', rx: p.rx, ry: p.ry });
        this.trauma = 1;
        this.flash = 0.6; this.flashColor[0] = 1; this.flashColor[1] = 0.2; this.flashColor[2] = 0.3;
        this.lives--;
        this.respawnTimer = 2.2;
        this.audio.setThrust(0);
        if (cause === 'boss' && this.boss) this.audio.triggerTaunt('ROAR', 0);
        return true;
    }

    killDrone(d, byPlayer) {
        if (!d.alive) return;
        d.alive = false;
        d.onDestroyed();
        const warrior = d.type === 'warrior';
        this.explode(d.x, d.y, warrior ? 44 : 34, warrior ? [1, 0.25, 0.4] : [0.2, 0.5, 1], 'explodeSmall', true);
        if (byPlayer) this.addScore(warrior ? 500 : 150);
    }

    /* --------------------------------------------------------------- effects */

    spawnParticle(x, y, vx, vy, life, size, color, kind) {
        if (this.byType.particle.length + this.pending.length > EngineBridge.MAX_PARTICLES) return null;
        return this.spawn(new Particle(this, x, y, vx, vy, life, size, color, kind));
    }

    sparks(x, y, n, color, speed, life, dirx, diry) {
        for (let i = 0; i < n; i++) {
            let a = this.rand() * GMath.TAU;
            if (dirx !== undefined) a = Math.atan2(diry, dirx) + (this.rand() - 0.5) * 1.6;
            const sp = speed * (0.3 + this.rand() * 0.9);
            this.spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, life * (0.5 + this.rand() * 0.8), 2 + this.rand() * 2, color, 'spark');
        }
    }

    explode(x, y, size, color, sfxName, debris) {
        const n = Math.min(40, 8 + (size / 4) | 0);
        this.sparks(x, y, n, color, 120 + size * 5, 0.5 + size / 160);
        const ring = this.spawnParticle(x, y, 0, 0, 0.35 + size / 300, size * 0.3, color, 'ring');
        if (ring) ring.grow = size * 4;
        for (let i = 0; i < Math.min(8, 2 + size / 20); i++) {
            const a = this.rand() * GMath.TAU, sp = 20 + this.rand() * size;
            this.spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.6 + this.rand() * 0.8, size * (0.25 + this.rand() * 0.3), [color[0] * 0.5, color[1] * 0.5, color[2] * 0.5], 'smoke');
        }
        if (debris) {
            for (let i = 0; i < Math.min(10, 3 + size / 15); i++) {
                const a = this.rand() * GMath.TAU, sp = 60 + this.rand() * size * 3;
                this.spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.8 + this.rand() * 1.0, 3 + this.rand() * 5, [0.7, 0.7, 0.75], 'debris');
            }
        }
        if (sfxName) this.sfxAt(sfxName, x, y);
        const ref = this.player && this.player.alive ? this.player : this.camera;
        const d = GMath.dist(ref, { x, y }, this.worldSize);
        if (d < 900) this.trauma = Math.min(1, this.trauma + (size / 220) * (1 - d / 900));
        this.emit({
            type: 'explosion', size, color,
            rx: GMath.wrapDelta(x - this.camera.x, this.worldSize.x), ry: GMath.wrapDelta(y - this.camera.y, this.worldSize.y)
        });
    }

    emit(evt) {
        const e = this.activeEngine;
        if (e && e.onEvent) { try { e.onEvent(evt); } catch (err) { } }
    }

    /** Positional sound: attenuate by distance to the listener and pan by x offset. */
    sfxAt(name, x, y, gain) {
        const w = this.worldSize;
        const dx = GMath.wrapDelta(x - this.camera.x, w.x), dy = GMath.wrapDelta(y - this.camera.y, w.y);
        const d = Math.hypot(dx, dy);
        if (d > this.audio.maxHearingRadius) return;
        this.audio.sfx(name, { distance: d, pan: GMath.clamp(dx / 600, -1, 1), gain: gain });
    }

    distToPlayer(e) {
        const ref = this.player && this.player.alive ? this.player : this.camera;
        return GMath.dist(ref, e, this.worldSize);
    }

    /* ============================================================== update */

    update(deltaTime) {
        const dt = Math.min(0.05, Math.max(0, deltaTime));
        this.time += dt;
        if (this.input) this.input.update(dt);
        this.handleGlobalInput();

        if (!this.paused) {
            this.state.update(dt);
            this.voiceLevel = this.audio.getVoiceLevel();
            this.voiceBands = this.audio.getVoiceBands() || this.voiceBands;
            this.simulate(dt);
        }
        if (this.input) this.input.endFrame();
        this.render(dt);
    }

    handleGlobalInput() {
        const inp = this.input;
        if (!inp || !inp.pressed) return;
        if (inp.pressed('toggleMode')) this.toggleMode();
        if (inp.pressed('mute')) this.toggleMute();
        if (inp.pressed('pause') && this.state.inPlay) this.setPaused(!this.paused);
        if (inp.pressed('start')) {
            this.audio.resume();
            if (this.state.is(StateManager.ATTRACT)) this.startGame();
            else if (this.state.is(StateManager.GAMEOVER) && this.state.timeInState > 1) this.startGame();
            else if (this.paused) this.setPaused(false);
        }
    }

    simulate(dt) {
        // Type buckets for this tick.
        const ents = this.entities, by = this.byType, world = this.worldSize;
        for (const k in by) by[k].length = 0;
        for (let i = 0; i < ents.length; i++) { const e = ents[i]; if (e.alive && by[e.type]) by[e.type].push(e); }

        for (let i = 0; i < ents.length; i++) {
            const ent = ents[i];
            if (!ent.alive) continue;
            ent.update(dt, world);
            this.enforceBoundaryWrap(ent);
        }

        this.resolveCollisions();
        this.director(dt);
        this.flushPending();
        this.updateCamera(dt);

        // Feedback decay + continuous audio.
        this.flash = Math.max(0, this.flash - dt * 2.2);
        this.trauma = Math.max(0, this.trauma - dt * 1.3);
        const p = this.player && this.player.alive ? this.player : null;
        this.audio.setThrust(p && this.state.inPlay ? p.thrust : 0);
        let dread = 0;
        if (this.boss && this.boss.hunting && p) dread = GMath.clamp(1 - GMath.dist(p, this.boss, world) / 1600, 0, 1);
        this.dread = dread;
        this.audio.setDread(this.state.is(StateManager.AWAKE) ? Math.max(0.12, dread) : 0);
    }

    enforceBoundaryWrap(entity) {
        if (entity.x < 0) entity.x += this.worldSize.x;
        else if (entity.x >= this.worldSize.x) entity.x -= this.worldSize.x;
        if (entity.y < 0) entity.y += this.worldSize.y;
        else if (entity.y >= this.worldSize.y) entity.y -= this.worldSize.y;
    }

    /** Remove the dead, admit the newly spawned. */
    flushPending() {
        const ents = this.entities;
        let w = 0;
        for (let i = 0; i < ents.length; i++) {
            const e = ents[i];
            if (e.alive) ents[w++] = e; else e.listed = false;
        }
        ents.length = w;
        const pend = this.pending;
        for (let i = 0; i < pend.length; i++) {
            const e = pend[i];
            if (e.alive) { ents.push(e); if (this.byType[e.type]) this.byType[e.type].push(e); }
            else e.listed = false;
        }
        pend.length = 0;
    }

    hit(a, b, pad) {
        const w = this.worldSize;
        const dx = GMath.wrapDelta(b.x - a.x, w.x), dy = GMath.wrapDelta(b.y - a.y, w.y);
        const r = a.radius + b.radius + (pad || 0);
        return dx * dx + dy * dy < r * r;
    }

    resolveCollisions() {
        const by = this.byType, w = this.worldSize;
        const p = this.player && this.player.alive ? this.player : null;
        const boss = this.boss && this.boss.alive ? this.boss : null;
        const bossSolid = boss && boss.built > 0 && !boss.dying;
        const rocks = by.asteroid, workers = by.worker, warriors = by.warrior;

        // --- bolts ---------------------------------------------------------
        for (let i = 0; i < by.shot.length; i++) {
            const s = by.shot[i];
            if (!s.alive) continue;
            const mine = s.owner === 'player';
            if (mine) {
                let done = false;
                for (let j = 0; j < warriors.length && !done; j++) if (warriors[j].alive && this.hit(s, warriors[j], 4)) { this.killDrone(warriors[j], true); done = true; }
                for (let j = 0; j < workers.length && !done; j++) if (workers[j].alive && this.hit(s, workers[j], 4)) { this.killDrone(workers[j], true); done = true; }
                if (!done && bossSolid && this.hit(s, boss, -30)) {
                    // Bolts cannot hurt it. Only Nipbombs can.
                    this.sparks(s.x, s.y, 3, [1, 1, 1], 180, 0.25, -Math.cos(s.angle), -Math.sin(s.angle));
                    done = true;
                }
                if (done) { s.alive = false; continue; }
            } else if (p && this.hit(s, p, 0)) {
                s.alive = false;
                if (!this.killPlayer('shot')) this.sparks(s.x, s.y, 5, [1, 0.4, 0.6], 150, 0.3);
                continue;
            }
            for (let j = 0; j < rocks.length; j++) {
                const a = rocks[j];
                if (a.alive && this.hit(s, a, 0)) {
                    s.alive = false;
                    this.sparks(s.x, s.y, 3, mine ? [0.5, 0.95, 1] : [1, 0.4, 0.6], 170, 0.3, -Math.cos(s.angle), -Math.sin(s.angle));
                    if (mine) a.mine(EngineBridge.SHOT_MINE_POWER, s.x, s.y, p);
                    break;
                }
            }
        }

        // --- Nipbombs -------------------------------------------------------
        for (let i = 0; i < by.bomb.length; i++) {
            const b = by.bomb[i];
            if (!b.alive) continue;
            if (bossSolid && this.hit(b, boss, -22)) {
                b.alive = false;
                this.explode(b.x, b.y, 40, [0.5, 1, 0.42], null);
                const r = boss.takeBombHit();
                if (r === 'setback') { this.addScore(300); this.sfxAt('bombHit', boss.x, boss.y); }
                continue;
            }
            for (let j = 0; j < warriors.length; j++) if (warriors[j].alive && this.hit(b, warriors[j], 6)) this.killDrone(warriors[j], true);
            for (let j = 0; j < workers.length; j++) if (workers[j].alive && this.hit(b, workers[j], 6)) this.killDrone(workers[j], true);
        }

        // --- the awake boss ploughs through rock and eats pilots ---------------
        if (boss && boss.hunting) {
            for (let j = 0; j < rocks.length; j++) {
                const a = rocks[j];
                if (a.alive && this.hit(boss, a, -40)) { a.shards = 0; a.breakUp(); }
            }
            if (p && this.hit(boss, p, -34)) this.killPlayer('boss');
        }

        // --- pilot vs world --------------------------------------------------
        if (p && p.alive) {
            for (let j = 0; j < rocks.length; j++) {
                const a = rocks[j];
                if (!a.alive || !this.hit(p, a, -4)) continue;
                const dx = GMath.wrapDelta(p.x - a.x, w.x), dy = GMath.wrapDelta(p.y - a.y, w.y);
                const d = Math.hypot(dx, dy) || 1, nx = dx / d, ny = dy / d;
                const overlap = p.radius + a.radius - 4 - d;
                p.x += nx * overlap; p.y += ny * overlap;
                const vn = (p.vx - a.vx) * nx + (p.vy - a.vy) * ny;
                if (vn < 0) {
                    p.vx -= 1.5 * vn * nx; p.vy -= 1.5 * vn * ny;
                    if (vn < -160) { this.sparks(p.x - nx * p.radius, p.y - ny * p.radius, 6, [1, 0.8, 0.5], 200, 0.3); this.trauma = Math.min(1, this.trauma + 0.25); }
                }
            }
            for (let j = 0; j < warriors.length; j++) {
                const c = warriors[j];
                if (c.alive && this.hit(p, c, -6)) { this.killDrone(c, true); this.killPlayer('ram'); break; }
            }
            if (p.alive) {
                for (let j = 0; j < workers.length; j++) {
                    const c = workers[j];
                    if (c.alive && this.hit(p, c, -2)) {          // Scrappers just get shoved aside
                        const dx = GMath.wrapDelta(c.x - p.x, w.x), dy = GMath.wrapDelta(c.y - p.y, w.y);
                        const d = Math.hypot(dx, dy) || 1;
                        c.vx += dx / d * 260; c.vy += dy / d * 260;
                    }
                }
            }
        }
    }

    /** Spawn director: respawns, reinforcements, rock supply, attract diorama. */
    director(dt) {
        const st = this.state;

        if (st.inPlay && (!this.player || !this.player.alive)) {
            this.respawnTimer -= dt;
            if (this.respawnTimer <= 0) {
                if (this.lives <= 0) { this.gameOver(); return; }
                const old = this.player || this.camera;
                let x = old.x, y = old.y;
                if (this.boss && this.boss.awake && GMath.dist(this.boss, old, this.worldSize) < 900) {
                    const pt = this.randomPointAwayFrom(this.boss, 1500); x = pt.x; y = pt.y;
                }
                const p = this.spawnPlayer(x, y);
                p.invuln = 3;
                this.audio.sfx('respawn');
            }
        }

        if (st.inPlay && !this.boss) {
            this.bossRespawnTimer -= dt;
            if (this.bossRespawnTimer <= 0) {
                this.spawnBoss(this.player);
                this.banner('WAVE ' + this.wave, 'the Scrappers are building again', 3);
            }
        }

        this.droneTimer -= dt;
        if (this.droneTimer <= 0) {
            this.droneTimer = Math.max(2.5, 7 - this.wave * 0.5);
            const avoid = this.player && this.player.alive ? this.player : this.camera;
            if (this.byType.worker.length < this.workerTarget()) this.spawnDrone('worker', avoid, 1300);
            if (this.byType.warrior.length < this.warriorTarget()) this.spawnDrone('warrior', avoid, 1400);
            let rocks = this.byType.asteroid.length;
            while (rocks < EngineBridge.ASTEROID_TARGET - 6) { this.spawnAsteroid(avoid, 1300); rocks += 4; }
        }

        if (st.is(StateManager.ATTRACT) && this.attractTimer > 0) {
            this.attractTimer -= dt;
            if (this.attractTimer <= 0) this.populateWorld(null);
        }
        if (st.is(StateManager.GAMEOVER) && st.timeInState > 14) this.toAttract();
    }

    updateCamera(dt) {
        const cam = this.camera, w = this.worldSize;
        let tx, ty, k = 6;
        const p = this.player;
        if (p && (p.alive || this.state.inPlay || this.state.is(StateManager.GAMEOVER))) {
            tx = p.x + (p.alive ? p.vx * 0.22 : 0); ty = p.y + (p.alive ? p.vy * 0.22 : 0);
        } else {
            // Attract: slow orbit around the build site.
            const f = this.boss || this.attractFocus || cam;
            const a = this.time * 0.12;
            tx = f.x + Math.cos(a) * 260; ty = f.y + Math.sin(a) * 180; k = 1.2;
        }
        const dx = GMath.wrapDelta(tx - cam.x, w.x) * Math.min(1, dt * k);
        const dy = GMath.wrapDelta(ty - cam.y, w.y) * Math.min(1, dt * k);
        cam.x = GMath.wrap(cam.x + dx, w.x); cam.y = GMath.wrap(cam.y + dy, w.y);
        cam.ux += dx; cam.uy += dy;
        const t2 = this.trauma * this.trauma, t = this.time;
        cam.shakeX = t2 * 22 * Math.sin(t * 91.7 + 1.3) * Math.cos(t * 47.1);
        cam.shakeY = t2 * 22 * Math.sin(t * 77.3 + 4.1) * Math.cos(t * 53.9);
    }

    /* ============================================================== render */

    render(dt) {
        const cam = this.camera, w = this.worldSize, list = this.renderList, ents = this.entities;
        list.length = 0;
        for (let i = 0; i < ents.length; i++) {
            const e = ents[i];
            if (!e.alive) continue;
            e.rx = GMath.wrapDelta(e.x - cam.x, w.x);
            e.ry = GMath.wrapDelta(e.y - cam.y, w.y);
            const lim = EngineBridge.VIEW_RADIUS + e.radius;
            if (e.rx > -lim && e.rx < lim && e.ry > -lim && e.ry < lim) list.push(e);
        }
        list.sort(EngineBridge.layerSort);

        const f = this.frame;
        f.time = this.time; f.dt = dt; f.state = this.state.current;
        f.voiceLevel = this.voiceLevel; f.voiceBands = this.voiceBands;
        f.flash = this.flash; f.flashColor = this.flashColor;
        f.bossAwake = !!(this.boss && this.boss.awake);
        f.dread = this.dread; f.paused = this.paused;

        if (this.activeEngine) {
            try { this.activeEngine.processSystemLogic(list, cam, f); }
            catch (e) { if (!this._renderErr) { this._renderErr = true; console.error('render error', e); } }
        }
        if (!this.headless) this.updateHud(dt);
    }

    loop() {
        let last = performance.now();
        const tick = (now) => {
            const dt = (now - last) / 1000;
            last = now;
            if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
            this.update(dt);
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    /* ================================================================= HUD */

    cacheDom() {
        const $ = (id) => document.getElementById(id);
        this.dom = {
            score: $('score'), hi: $('hiscore'), lives: $('lives'), wave: $('wave'),
            bombs: $('bombPips'), boss: $('bossPips'), bossLabel: $('bossLabel'),
            banner: $('banner'), bannerMain: $('bannerMain'), bannerSub: $('bannerSub'),
            radar: $('radar'), title: $('titleScreen'), over: $('gameOverScreen'), pause: $('pauseScreen'),
            modeBtn: $('modeBtn'), muteBtn: $('muteBtn'), startBtn: $('startBtn'), modeLabel: $('modeLabel'),
            arrow: $('bossArrow'), fps: $('fps'), finalScore: $('finalScore'), notice: $('notice'), hud: $('hud')
        };
        this.radarCtx = this.dom.radar.getContext('2d');
        const pips = (el, n) => { for (let i = 0; i < n; i++) el.appendChild(document.createElement('i')); };
        pips(this.dom.bombs, PlayerShip.MAX_BOMBS);
        pips(this.dom.boss, 13);
    }

    showScreen(name) {
        if (this.headless) return;
        this.dom.title.classList.toggle('show', name === 'title');
        this.dom.over.classList.toggle('show', name === 'gameover');
        this.dom.hud.classList.toggle('playing', name === null);
        if (name === 'gameover') this.dom.finalScore.textContent = this.score.toLocaleString();
    }

    banner(main, sub, seconds, alarm) {
        if (this.headless) return;
        this.dom.bannerMain.textContent = main;
        this.dom.bannerSub.textContent = sub || '';
        this.dom.banner.classList.toggle('alarm', !!alarm);
        this.dom.banner.classList.add('show');
        this.bannerTimer = seconds || 3;
    }

    notice(text) {
        if (this.headless || !this.dom || !this.dom.notice) return;
        this.dom.notice.textContent = text;
        this.dom.notice.classList.add('show');
        setTimeout(() => this.dom.notice.classList.remove('show'), 4000);
    }

    setText(key, el, value) {
        if (this.hudCache[key] !== value) { this.hudCache[key] = value; el.textContent = value; }
    }

    setPips(key, el, n, cls) {
        const k = n + ':' + cls;
        if (this.hudCache[key] === k) return;
        this.hudCache[key] = k;
        const kids = el.children;
        for (let i = 0; i < kids.length; i++) kids[i].className = i < n ? cls : '';
    }

    updateHud(dt) {
        const d = this.dom, boss = this.boss;
        this.setText('score', d.score, this.score.toLocaleString());
        this.setText('hi', d.hi, Math.max(this.hiScore, this.score).toLocaleString());
        this.setText('lives', d.lives, '▲'.repeat(Math.max(0, this.lives)) || '—');
        this.setText('wave', d.wave, String(this.wave));
        this.setPips('bombs', d.bombs, this.playerBombs, 'on');
        if (boss && boss.awake) {
            this.setText('bossLabel', d.bossLabel, 'GRIMALKIN — HULL');
            this.setPips('boss', d.boss, boss.hp, 'hp');
        } else {
            this.setText('bossLabel', d.bossLabel, boss ? 'GRIMALKIN — ASSEMBLY' : 'GRIMALKIN — DESTROYED');
            this.setPips('boss', d.boss, boss ? boss.built : 0, 'built');
        }
        d.boss.children[12].style.visibility = boss && boss.awake ? 'visible' : 'hidden';
        document.body.classList.toggle('awake', this.state.is(StateManager.AWAKE));

        if (this.bannerTimer > 0) {
            this.bannerTimer -= dt;
            if (this.bannerTimer <= 0) d.banner.classList.remove('show');
        }
        this.setText('fps', d.fps, Math.round(this.fps) + ' FPS');

        // Off-screen threat arrow pointing at the awake boss.
        let showArrow = false;
        if (boss && boss.awake && this.player && this.player.alive) {
            const lim = Math.min(window.innerWidth, window.innerHeight) * 0.5;
            if (Math.hypot(boss.rx, boss.ry) > lim * 1.1) {
                const a = Math.atan2(boss.ry, boss.rx), r = Math.min(window.innerWidth, window.innerHeight) * 0.4;
                d.arrow.style.transform = 'translate(' + (Math.cos(a) * r).toFixed(1) + 'px,' + (Math.sin(a) * r * 0.8).toFixed(1) + 'px) rotate(' + a.toFixed(3) + 'rad)';
                showArrow = true;
            }
        }
        d.arrow.classList.toggle('show', showArrow);
        this.drawRadar();
    }

    /** Long-range scanner: the whole torus, centred on the camera. */
    drawRadar() {
        const ctx = this.radarCtx, S = this.dom.radar.width, w = this.worldSize, cam = this.camera;
        const retro = this.currentMode === 'MODE_RETRO';
        ctx.clearRect(0, 0, S, S);
        const k = S / w.x, c = S / 2;
        const ents = this.entities;
        for (let i = 0; i < ents.length; i++) {
            const e = ents[i];
            let col, sz;
            switch (e.type) {
                case 'asteroid': col = retro ? '#555' : 'rgba(140,160,200,0.45)'; sz = Math.max(1.5, e.radius * k * 1.3); break;
                case 'crystal': col = '#ffd21e'; sz = 1.5; break;
                case 'worker': col = e.carrying ? '#ffd21e' : '#3d7bff'; sz = 2; break;
                case 'warrior': col = '#ff3355'; sz = 2.5; break;
                default: continue;
            }
            const x = c + GMath.wrapDelta(e.x - cam.x, w.x) * k, y = c + GMath.wrapDelta(e.y - cam.y, w.y) * k;
            ctx.fillStyle = col;
            ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        }
        const boss = this.boss;
        if (boss && boss.alive) {
            const x = c + GMath.wrapDelta(boss.x - cam.x, w.x) * k, y = c + GMath.wrapDelta(boss.y - cam.y, w.y) * k;
            const pulse = boss.awake ? 0.5 + 0.5 * Math.sin(this.time * 10) : 0;
            ctx.strokeStyle = boss.awake ? '#fff200' : '#ff8a1e';
            ctx.lineWidth = 1.5;
            ctx.beginPath();                                   // little cat head
            ctx.moveTo(x - 5, y - 2); ctx.lineTo(x - 4, y - 7); ctx.lineTo(x - 1, y - 4);
            ctx.lineTo(x + 1, y - 4); ctx.lineTo(x + 4, y - 7); ctx.lineTo(x + 5, y - 2);
            ctx.lineTo(x + 3, y + 4); ctx.lineTo(x - 3, y + 4); ctx.closePath();
            ctx.stroke();
            if (boss.awake) { ctx.globalAlpha = 0.25 + pulse * 0.5; ctx.beginPath(); ctx.arc(x, y, 9 + pulse * 4, 0, 6.283); ctx.stroke(); ctx.globalAlpha = 1; }
            else { ctx.fillStyle = '#ff8a1e'; ctx.fillRect(x - 5, y + 7, 10 * boss.built / 12, 1.5); }
        }
        if (this.player && this.player.alive) {
            ctx.fillStyle = '#19e6ff';
            ctx.fillRect(c - 2, c - 2, 4, 4);
        }
    }
}

EngineBridge.ASTEROID_TARGET = 36;
EngineBridge.MAX_PARTICLES = 420;
EngineBridge.VIEW_RADIUS = 1500;
EngineBridge.SHOT_MINE_POWER = 0.12;
EngineBridge.LAYERS = { asteroid: 0, crystal: 1, boss: 2, worker: 3, warrior: 4, player: 5, beam: 6, shot: 7, bomb: 8, particle: 9 };
EngineBridge.layerSort = function (a, b) { return (EngineBridge.LAYERS[a.type] || 0) - (EngineBridge.LAYERS[b.type] || 0); };

if (typeof module !== 'undefined') module.exports = { EngineBridge, NullAudio };
