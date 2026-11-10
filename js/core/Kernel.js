/* GRIMALKIN 1010 — Kernel: toroidal vector maths + base entity + lightweight FX entities.
 * Loaded first. Everything else builds on these globals. */

const GMath = {
    TAU: Math.PI * 2,

    clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },
    lerp(a, b, t) { return a + (b - a) * t; },

    /** Wrap a coordinate into [0, size). */
    wrap(v, size) { return ((v % size) + size) % size; },

    /** Shortest signed displacement on a ring of circumference `size`. */
    wrapDelta(d, size) {
        d = ((d % size) + size) % size;
        return d > size / 2 ? d - size : d;
    },

    /** Shortest toroidal displacement from a to b. */
    dx(a, b, world) { return GMath.wrapDelta(b.x - a.x, world.x); },
    dy(a, b, world) { return GMath.wrapDelta(b.y - a.y, world.y); },

    dist(a, b, world) {
        return Math.hypot(GMath.wrapDelta(b.x - a.x, world.x), GMath.wrapDelta(b.y - a.y, world.y));
    },

    /** Shortest signed angular difference a -> b. */
    angleDelta(a, b) {
        let d = (b - a) % GMath.TAU;
        if (d > Math.PI) d -= GMath.TAU;
        if (d < -Math.PI) d += GMath.TAU;
        return d;
    },

    /** Rotate `a` towards `b` by at most `maxStep` radians. */
    turnToward(a, b, maxStep) {
        const d = GMath.angleDelta(a, b);
        return Math.abs(d) <= maxStep ? b : a + Math.sign(d) * maxStep;
    },

    /** Deterministic PRNG (mulberry32). Returns a function yielding [0,1). */
    rng(seed) {
        let s = seed >>> 0;
        return function () {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    },

    /**
     * Ray vs circle on the torus. Ray starts at (ox,oy) heading along unit (ux,uy).
     * Returns distance along the ray to first intersection, or -1.
     */
    rayCircle(ox, oy, ux, uy, c, world, maxRange) {
        const cx = GMath.wrapDelta(c.x - ox, world.x);
        const cy = GMath.wrapDelta(c.y - oy, world.y);
        const proj = cx * ux + cy * uy;
        if (proj < 0) return -1;
        const perp2 = cx * cx + cy * cy - proj * proj;
        const r2 = c.radius * c.radius;
        if (perp2 > r2) return -1;
        const t = proj - Math.sqrt(r2 - perp2);
        if (t > maxRange) return -1;
        return Math.max(0, t);
    }
};

/** Base class for everything that lives in the world. */
class Entity {
    constructor(game, type, x, y) {
        this.game = game;
        this.type = type;
        this.x = x; this.y = y;
        this.vx = 0; this.vy = 0;
        this.angle = 0;
        this.radius = 10;
        this.age = 0;
        this.alive = true;
        this.rx = 0; this.ry = 0;     // camera-relative, set by the bridge before render
    }

    update(dt /*, worldSize */) {
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.age += dt;
    }

    kill() { this.alive = false; }

    /** Steer velocity towards a wrapped target point. Returns distance to target. */
    steerTo(tx, ty, speed, accel, dt) {
        const w = this.game.worldSize;
        const dx = GMath.wrapDelta(tx - this.x, w.x);
        const dy = GMath.wrapDelta(ty - this.y, w.y);
        const d = Math.hypot(dx, dy) || 1e-6;
        const dvx = (dx / d) * speed - this.vx;
        const dvy = (dy / d) * speed - this.vy;
        const dv = Math.hypot(dvx, dvy) || 1e-6;
        const step = Math.min(dv, accel * dt);
        this.vx += (dvx / dv) * step;
        this.vy += (dvy / dv) * step;
        return d;
    }
}

/** Short-lived visual particle. kind: spark | smoke | debris | ring */
class Particle extends Entity {
    constructor(game, x, y, vx, vy, life, size, color, kind) {
        super(game, 'particle', x, y);
        this.vx = vx; this.vy = vy;
        this.life = life; this.maxLife = life;
        this.size = size;
        this.color = color;
        this.kind = kind || 'spark';
        this.radius = size;
        this.grow = 0;
        this.drag = this.kind === 'smoke' ? 1.6 : this.kind === 'ring' ? 0 : 0.9;
    }

    update(dt) {
        super.update(dt);
        const k = Math.exp(-this.drag * dt);
        this.vx *= k; this.vy *= k;
        if (this.grow) { this.size += this.grow * dt; this.radius = this.size; }
        this.life -= dt;
        if (this.life <= 0) this.alive = false;
    }
}

/** Mining beam segment; owned and repositioned by its emitter each frame. */
class Beam extends Entity {
    constructor(game, kind) {
        super(game, 'beam', 0, 0);
        this.kind = kind;
        this.dx = 0; this.dy = 0;
        this.intensity = 0;
        this.radius = 300;
        this.ttl = 0;
    }

    /** Emitters call this every frame the beam is firing. */
    fire(x, y, dx, dy, intensity) {
        this.x = x; this.y = y; this.dx = dx; this.dy = dy;
        this.intensity = intensity;
        this.ttl = 0.05;
        this.alive = true;
        if (!this.listed) this.game.spawn(this);   // bridge maintains `listed`
    }

    update(dt) {
        this.age += dt;
        this.ttl -= dt;
        if (this.ttl <= 0) this.alive = false;
    }
}

if (typeof module !== 'undefined') module.exports = { GMath, Entity, Particle, Beam };
