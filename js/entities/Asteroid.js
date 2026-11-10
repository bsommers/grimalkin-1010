/* GRIMALKIN 1010 — asteroids and the shards locked inside them.
 *
 * Each rock carries a finite shard payload (yield table by size). Mining heats it
 * and pops shards loose one at a time; when the payload is spent the rock
 * fractures according to the breakup table.
 */

class Asteroid extends Entity {
    constructor(game, x, y, radius, seed) {
        super(game, 'asteroid', x, y);
        this.radius = radius;
        this.seed = seed | 0;
        const r = GMath.rng(this.seed * 7919 + 13);
        this.shape = [];
        for (let i = 0; i < 12; i++) this.shape.push(0.74 + r() * 0.4);
        this.spin = r() * GMath.TAU;
        this.spinRate = (r() - 0.5) * 0.5;
        const a = r() * GMath.TAU, sp = 6 + r() * 22;
        this.vx = Math.cos(a) * sp; this.vy = Math.sin(a) * sp;
        this.heat = 0;
        this.maxShards = Asteroid.yieldFor(radius);
        this.shards = this.maxShards;
        this.rich = 1;
        this.progress = 0;
    }

    /** Yield table: how many shards a rock of this size holds. */
    static yieldFor(radius) {
        const table = Asteroid.YIELD_TABLE;
        for (let i = 0; i < table.length; i++) if (radius >= table[i].minRadius) return table[i].shards;
        return 1;
    }

    /**
     * Apply mining work. `amount` 1.0 = one shard's worth. (hx, hy) is the bite
     * point on the surface; the shard is flung back towards `miner`.
     */
    mine(amount, hx, hy, miner) {
        if (!this.alive) return null;
        this.heat = Math.min(1, this.heat + amount * 0.9);
        this.progress += amount;
        if (this.progress < 1) return null;
        this.progress -= 1;
        return this.ejectShard(hx, hy, miner);
    }

    ejectShard(hx, hy, miner) {
        const game = this.game, w = game.worldSize;
        let nx = GMath.wrapDelta(hx - this.x, w.x), ny = GMath.wrapDelta(hy - this.y, w.y);
        const n = Math.hypot(nx, ny) || 1;
        nx /= n; ny /= n;
        const jitter = (game.rand() - 0.5) * 0.9;
        const ca = Math.cos(jitter), sa = Math.sin(jitter);
        const ox = nx * ca - ny * sa, oy = nx * sa + ny * ca;
        const sp = 70 + game.rand() * 60;
        const c = new Crystal(game, this.x + nx * (this.radius + 8), this.y + ny * (this.radius + 8),
            this.vx + ox * sp, this.vy + oy * sp);
        c.minedBy = miner || null;
        game.spawn(c);
        game.sfxAt('crystalPop', c.x, c.y);
        game.sparks(c.x, c.y, 6, [1, 0.82, 0.12], 200, 0.5, nx, ny);

        this.shards--;
        this.rich = this.shards / this.maxShards;
        if (this.shards <= 0) this.breakUp();
        return c;
    }

    /** Breakup table: spent rocks split into smaller, still-mineable fragments. */
    breakUp() {
        if (!this.alive) return;
        const game = this.game;
        this.alive = false;
        let rule = null;
        for (let i = 0; i < Asteroid.BREAKUP_TABLE.length; i++) {
            if (this.radius >= Asteroid.BREAKUP_TABLE[i].minRadius) { rule = Asteroid.BREAKUP_TABLE[i]; break; }
        }
        game.explode(this.x, this.y, this.radius * 0.8, [0.75, 0.6, 0.5], this.radius > 50 ? 'explodeBig' : 'explodeSmall', true);
        if (!rule) return;
        const n = rule.min + ((game.rand() * (rule.max - rule.min + 1)) | 0);
        const base = game.rand() * GMath.TAU;
        for (let i = 0; i < n; i++) {
            const a = base + (i / n) * GMath.TAU + (game.rand() - 0.5) * 0.5;
            const r = this.radius * rule.scale * (0.85 + game.rand() * 0.3);
            const child = new Asteroid(game, this.x + Math.cos(a) * this.radius * 0.45,
                this.y + Math.sin(a) * this.radius * 0.45, r, (game.rand() * 1e9) | 0);
            const sp = 35 + game.rand() * 45;
            child.vx = this.vx + Math.cos(a) * sp;
            child.vy = this.vy + Math.sin(a) * sp;
            child.heat = 0.6;
            game.spawn(child);
        }
    }

    update(dt) {
        this.spin += this.spinRate * dt;
        this.heat = Math.max(0, this.heat - dt * 0.55);
        super.update(dt);
    }
}

Asteroid.YIELD_TABLE = [
    { minRadius: 78, shards: 6 },
    { minRadius: 60, shards: 5 },
    { minRadius: 44, shards: 4 },
    { minRadius: 32, shards: 3 },
    { minRadius: 0, shards: 2 }
];

Asteroid.BREAKUP_TABLE = [
    { minRadius: 70, min: 2, max: 3, scale: 0.52 },
    { minRadius: 42, min: 2, max: 2, scale: 0.58 }
    // anything smaller crumbles to dust
];

/** A loose shard. Pilot turns it into a Nipbomb; a Scrapper turns it into a boss plate. */
class Crystal extends Entity {
    constructor(game, x, y, vx, vy) {
        super(game, 'crystal', x, y);
        this.radius = 6;
        this.vx = vx; this.vy = vy;
        this.seed = (game.rand() * 1e6) | 0;
        this.life = Crystal.LIFETIME;
        this.claimedBy = null;
        this.minedBy = null;
    }

    update(dt) {
        const k = Math.exp(-1.1 * dt);
        this.vx *= k; this.vy *= k;
        this.angle += dt * 3;
        super.update(dt);
        this.life -= dt;
        if (this.life <= 0) this.alive = false;
        if (this.claimedBy && !this.claimedBy.alive) this.claimedBy = null;
    }
}
Crystal.LIFETIME = 22;

if (typeof module !== 'undefined') module.exports = { Asteroid, Crystal };
