/* GRIMALKIN 1010 — the boss.
 *
 * A colossal biomechanical cat-skull warship assembled plate by plate (12 plates)
 * by Scrappers. When the 12th plate locks in it wakes, the game enters
 * STATE_AWAKE, and it hunts the pilot — taunting by proximity — until it has
 * taken exactly `hitsToKill` Nipbomb hits: Grimalkin.HITS_TO_KILL (13) on HARD,
 * fewer on the easier settings (see EngineBridge.DIFFICULTIES). Speed, lunge
 * cadence, wake-up grace and build pace all come from the same tuning table.
 * It is a cat: a space mouse nearby will distract it from the pilot.
 */

class Grimalkin extends Entity {
    constructor(game, x, y) {
        super(game, 'boss', x, y);
        this.radius = 120;
        this.pieces = new Array(12).fill(false);
        this.built = 0;
        this.shardsBanked = 0;        // delivered shards counting towards the next plate
        this.awake = false;
        this.hp = this.hitsToKill;
        this.bombHits = 0;            // discrete bomb hits taken while awake
        this.hitFlash = 0;
        this.mouthOpen = 0;
        this.lookX = 0; this.lookY = 0;
        this.tilt = 0;
        this.dying = 0;
        this.dead = false;

        this.tauntTimer = 3;
        this.mutterTimer = 10;        // talks in its sleep while being built
        this.grace = 0;               // seconds of groggy slow-motion after waking
        this.prey = null;             // a space mouse it is chasing instead of the pilot
        this.preyTime = 0;
        this.preyCooldown = 0;
        this.lungeTimer = 5;
        this.lunging = 0;
        this.nearToggle = false;
        this.deathFxTimer = 0;
        this.driftAngle = (game.rand ? game.rand() : Math.random()) * GMath.TAU;
    }

    get tuning() { return this.game.tuning || Grimalkin.DEFAULT_TUNING; }
    get hitsToKill() { return this.tuning.hits || Grimalkin.HITS_TO_KILL; }

    /** Hunting is gated on the GLOBAL state, not just the boss's own flag. */
    get hunting() {
        return this.awake && !this.dying && this.game.gameState === 'STATE_AWAKE';
    }

    /* ------------------------------------------------------------ assembly */

    /** A Scrapper delivers a shard. Every SHARDS_PER_PLATE of them forge one plate. */
    deliverShard() {
        if (this.awake || this.dying) return false;
        if (++this.shardsBanked < (this.tuning.shardsPerPlate || Grimalkin.SHARDS_PER_PLATE)) return true;
        this.shardsBanked = 0;
        return this.addPiece();
    }

    /** Lock in the next plate. Returns true if used. */
    addPiece() {
        if (this.awake || this.dying) return false;
        for (let i = 0; i < Grimalkin.ASSEMBLY_ORDER.length; i++) {
            const idx = Grimalkin.ASSEMBLY_ORDER[i];
            if (!this.pieces[idx]) {
                this.pieces[idx] = true;
                this.built++;
                this.game.onBossPieceAdded(this, idx);
                if (this.built >= 12) this.wake();
                return true;
            }
        }
        return false;
    }

    wake() {
        if (this.awake) return;
        this.awake = true;
        const T = this.tuning;
        this.hp = this.hitsToKill;
        this.bombHits = 0;
        this.tauntTimer = 3.2;
        this.grace = T.wakeGrace;
        this.lungeTimer = T.wakeGrace + 4 * T.lungeEvery;
        this.game.onBossAwake(this);
    }

    /* -------------------------------------------------------------- damage */

    /**
     * One discrete Nipbomb hit.
     * Asleep: knocks the most recent plate off (sets the build back).
     * Awake: counts towards the `hitsToKill` hits needed to destroy it.
     * Returns 'ignored' | 'setback' | 'hit' | 'killed'.
     */
    takeBombHit() {
        if (this.dying || this.dead) return 'ignored';
        this.hitFlash = 1;

        if (!this.awake) {
            for (let i = Grimalkin.ASSEMBLY_ORDER.length - 1; i >= 0; i--) {
                const idx = Grimalkin.ASSEMBLY_ORDER[i];
                if (this.pieces[idx]) {
                    this.pieces[idx] = false;
                    this.built--;
                    this.game.onBossPieceLost(this, idx);
                    return 'setback';
                }
            }
            return 'ignored';
        }

        this.bombHits++;
        this.hp = Math.max(0, this.hitsToKill - this.bombHits);

        // Every second hit shears off an outer armour plate (cosmetic damage state).
        if (this.bombHits % 2 === 0) {
            const idx = Grimalkin.SHED_ORDER[this.bombHits / 2 - 1];
            if (idx !== undefined && this.pieces[idx]) {
                this.pieces[idx] = false;
                this.built--;
                this.game.onBossPieceLost(this, idx);
            }
        }

        if (this.bombHits >= this.hitsToKill) {
            this.dying = 0.0001;
            this.game.onBossDying(this);
            return 'killed';
        }
        this.game.onBossHit(this);
        return 'hit';
    }

    /* -------------------------------------------------------------- update */

    update(dt, worldSize) {
        const game = this.game;
        const player = game.player && game.player.alive ? game.player : null;
        this.hitFlash = Math.max(0, this.hitFlash - dt * 2.5);

        // The jaw follows the voice envelope so speech and mouth stay in sync.
        const voice = game.voiceLevel || 0;
        const jawTarget = this.dying ? 1 : Math.max(voice * 1.25, this.lunging > 0 ? 0.55 : 0);
        this.mouthOpen += (Math.min(1, jawTarget) - this.mouthOpen) * Math.min(1, dt * 22);

        if (this.dying) {
            this.updateDeath(dt);
        } else if (this.hunting) {
            this.hunt(dt, player, worldSize);
        } else {
            this.idle(dt);
        }

        // Eyes track the pilot.
        let lx = 0, ly = 0;
        if (player) {
            const dx = GMath.wrapDelta(player.x - this.x, worldSize.x);
            const dy = GMath.wrapDelta(player.y - this.y, worldSize.y);
            const d = Math.hypot(dx, dy) || 1;
            const k = Math.min(1, d / 300);
            lx = dx / d * k; ly = dy / d * k;
        }
        this.lookX += (lx - this.lookX) * Math.min(1, dt * 6);
        this.lookY += (ly - this.lookY) * Math.min(1, dt * 6);
        this.tilt += (GMath.clamp(this.vx / 500, -1, 1) * 0.16 - this.tilt) * Math.min(1, dt * 4);

        super.update(dt);
    }

    /** Asleep / under construction: drift lazily around the build site. */
    idle(dt) {
        this.driftAngle += dt * 0.07;
        const sp = 14;
        this.vx += (Math.cos(this.driftAngle) * sp - this.vx) * Math.min(1, dt);
        this.vy += (Math.sin(this.driftAngle) * sp - this.vy) * Math.min(1, dt);

        // Half-built, it already mutters to anyone in earshot.
        const game = this.game;
        if (this.built >= 3 && !this.awake && game.gameState === 'STATE_MINING') {
            this.mutterTimer -= dt;
            if (this.mutterTimer <= 0 && !game.audio.isSpeaking()) {
                this.mutterTimer = 8 + game.rand() * 7;
                game.audio.triggerTaunt(this.built >= 9 ? 'NAME' : 'HUNGER', game.distToPlayer(this));
            }
        }
    }

    /** Nearest space mouse within pouncing interest, or null. */
    findPrey(worldSize) {
        const mice = this.game.byType.mouse;
        if (!mice || this.preyCooldown > 0) return null;
        let best = null, bd = Grimalkin.PREY_RANGE;
        for (let i = 0; i < mice.length; i++) {
            const m = mice[i];
            if (!m.alive) continue;
            const d = GMath.dist(this, m, worldSize);
            if (d < bd) { bd = d; best = m; }
        }
        return best;
    }

    /**
     * Vector hunting: lead the pilot's position, interpolate the velocity vector
     * towards the intercept course, and periodically lunge faster than the pilot
     * can fly.
     */
    hunt(dt, player, worldSize) {
        const game = this.game;
        const wave = game.wave || 1, T = this.tuning;
        // Groggy for a few seconds after waking: it stretches before it hunts.
        if (this.grace > 0) this.grace -= dt;
        const groggy = this.grace > 0 ? 0.3 : 1;
        const cruise = Math.min(470, 330 + wave * 22) * T.speed * groggy;
        const lungeSpeed = Math.min(760, 620 + wave * 20) * T.lungeSpeed;

        // A cat is a cat: a space mouse nearby beats the pilot for attention.
        if (this.preyCooldown > 0) this.preyCooldown -= dt;
        if (this.prey && (!this.prey.alive || this.preyTime > 5)) {
            if (this.prey.alive) this.preyCooldown = 6;      // gave up, sulks for a bit
            this.prey = null;
        }
        if (!this.prey) {
            this.prey = this.findPrey(worldSize);
            if (this.prey) {
                this.preyTime = 0;
                if (!game.audio.isSpeaking()) game.audio.triggerTaunt('RUN', game.distToPlayer(this));
                this.tauntTimer = Math.max(this.tauntTimer, 2);
            }
        }
        if (this.prey) {
            this.preyTime += dt;
            this.lunging = 0;
            const d = this.steerTo(this.prey.x, this.prey.y, cruise * 1.1, 520, dt);
            if (d < this.radius * 0.6) {
                game.onMouseEaten(this.prey, this);
                this.prey = null; this.preyCooldown = 3;
            }
            this.lungeTimer = Math.max(this.lungeTimer, 1.5);
            return;
        }

        let tx, ty, dist = Infinity;
        if (player) {
            const dx = GMath.wrapDelta(player.x - this.x, worldSize.x);
            const dy = GMath.wrapDelta(player.y - this.y, worldSize.y);
            dist = Math.hypot(dx, dy);
            const lead = GMath.clamp(dist / 700, 0, 1.1);        // intercept interpolation
            tx = this.x + dx + player.vx * lead;
            ty = this.y + dy + player.vy * lead;
        } else {
            // Pilot is dead / respawning: prowl.
            this.driftAngle += dt * 0.5;
            tx = this.x + Math.cos(this.driftAngle) * 400;
            ty = this.y + Math.sin(this.driftAngle) * 400;
        }

        this.lungeTimer -= dt;
        if (this.lunging > 0) {
            this.lunging -= dt;
        } else if (player && this.lungeTimer <= 0 && dist < 820) {
            this.lunging = 1.1;
            this.lungeTimer = (Math.max(3.2, 6.5 - wave * 0.4) + game.rand() * 1.5) * T.lungeEvery;
            game.audio.triggerTaunt('ROAR', dist);
        }

        const speed = this.lunging > 0 ? lungeSpeed : (player ? cruise : cruise * 0.4);
        const accel = this.lunging > 0 ? 1500 * T.lungeSpeed : 440 * T.speed;
        this.steerTo(tx, ty, speed, accel, dt);

        // Proximity-based taunts: the closer it is, the more personal it gets.
        this.tauntTimer -= dt;
        if (player && this.tauntTimer <= 0 && !game.audio.isSpeaking()) {
            let key;
            if (dist > 1100) key = 'HUNGER';
            else if (dist > 520) key = 'RUN';
            else { key = this.nearToggle ? 'ROAR' : 'NAME'; this.nearToggle = !this.nearToggle; }
            game.audio.triggerTaunt(key, dist);
            this.tauntTimer = 1.8 + game.rand() * 2.2;       // chatty
        }
    }

    updateDeath(dt) {
        const game = this.game;
        this.dying = Math.min(1, this.dying + dt / Grimalkin.DEATH_TIME);
        this.vx *= Math.exp(-2 * dt); this.vy *= Math.exp(-2 * dt);
        this.deathFxTimer -= dt;
        if (this.deathFxTimer <= 0) {
            this.deathFxTimer = 0.09;
            const a = game.rand() * GMath.TAU, r = game.rand() * this.radius;
            game.explode(this.x + Math.cos(a) * r, this.y + Math.sin(a) * r, 26 + game.rand() * 30,
                game.rand() < 0.5 ? [1, 0.55, 0.12] : [1, 0.95, 0.3], 'explodeSmall');
            // plates tear off as it burns
            const attached = [];
            for (let i = 0; i < 12; i++) if (this.pieces[i]) attached.push(i);
            if (attached.length > 2 && game.rand() < 0.3) {
                this.pieces[attached[(game.rand() * attached.length) | 0]] = false;
                this.built--;
            }
        }
        if (this.dying >= 1 && !this.dead) {
            this.dead = true;
            this.alive = false;
            game.onBossKilled(this);
        }
    }
}

Grimalkin.HITS_TO_KILL = 13;      // HARD / RIDICULOUS; easier settings lower it via tuning.hits
Grimalkin.PREY_RANGE = 650;       // how close a space mouse must be to distract it
/* Used when the bridge supplies no tuning (bare unit tests): the original HARD numbers. */
Grimalkin.DEFAULT_TUNING = { hits: 13, speed: 1, lungeSpeed: 1, lungeEvery: 1, wakeGrace: 0, shardsPerPlate: 3 };
Grimalkin.SHARDS_PER_PLATE = 3;   // Scrapper deliveries needed per armour plate (build pace)
Grimalkin.DEATH_TIME = 2.6;

/* Plate geometry, unit coordinates (x right, y down), shared by both renderers. */
(function () {
    const mirror = (poly) => poly.map(([x, y]) => [-x, y]).reverse();
    const earL = [[-0.85, -0.45], [-0.72, -1.0], [-0.30, -0.62]];
    const skullL = [[-0.85, -0.45], [-0.30, -0.62], [0, -0.66], [0, -0.25], [-0.45, -0.20], [-0.90, -0.15]];
    const eyeL = [[-0.90, -0.15], [-0.45, -0.20], [-0.12, -0.02], [-0.20, 0.20], [-0.62, 0.22], [-0.92, 0.10]];
    const cheekL = [[-0.92, 0.10], [-0.62, 0.22], [-0.20, 0.20], [-0.35, 0.50], [-0.60, 0.62], [-0.88, 0.40]];
    const jawL = [[-0.60, 0.62], [-0.35, 0.50], [0, 0.58], [0, 0.95], [-0.40, 0.90]];
    const brow = [[0, -0.25], [0.45, -0.20], [0.12, -0.02], [0, 0.05], [-0.12, -0.02], [-0.45, -0.20]];
    const muzzle = [[-0.12, -0.02], [0, 0.05], [0.12, -0.02], [0.20, 0.20], [0.35, 0.50], [0, 0.58], [-0.35, 0.50], [-0.20, 0.20]];

    Grimalkin.PIECES = [
        { name: 'jawL', poly: jawL },
        { name: 'jawR', poly: mirror(jawL) },
        { name: 'cheekL', poly: cheekL },
        { name: 'cheekR', poly: mirror(cheekL) },
        { name: 'muzzle', poly: muzzle },
        { name: 'eyeL', poly: eyeL },
        { name: 'eyeR', poly: mirror(eyeL) },
        { name: 'brow', poly: brow },
        { name: 'earL', poly: earL },
        { name: 'earR', poly: mirror(earL) },
        { name: 'skullL', poly: skullL },
        { name: 'skullR', poly: mirror(skullL) }
    ];

    /* Build from the jaw up; the eyes go in last — then it opens them. */
    Grimalkin.ASSEMBLY_ORDER = [0, 1, 2, 3, 4, 10, 11, 7, 8, 9, 5, 6];
    Grimalkin.PIECES.forEach((p, i) => { p.order = Grimalkin.ASSEMBLY_ORDER.indexOf(i); });

    /* Plates sheared off by every second bomb hit once awake (ears, cheeks, jaws). */
    Grimalkin.SHED_ORDER = [8, 9, 2, 3, 0, 1];

    Grimalkin.EYES = [{ x: -0.5, y: 0.02 }, { x: 0.5, y: 0.02 }];
})();

if (typeof module !== 'undefined') module.exports = { Grimalkin };
