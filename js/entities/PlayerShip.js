/* GRIMALKIN 1010 — the pilot's courier ship, its bolts, and its Nipbombs.
 *
 * Drifting Newtonian flight driven by the 49-way thrust vector, a short-range
 * mining beam resolved by raycast against asteroids, and the Nipbomb inventory
 * (stored on the bridge as `game.playerBombs` so it survives death and mode swaps).
 */

class PlayerShip extends Entity {
    constructor(game, x, y) {
        super(game, 'player', x, y);
        this.radius = 14;
        this.angle = -Math.PI / 2;
        this.thrust = 0;
        this.invuln = 3;
        this.firing = false;
        this.fireCooldown = 0;
        this.beam = new Beam(game, 'mine');
        this.mineTick = 0;
        /* Tests / attract autopilot can drive the ship through this instead of game.input. */
        this.control = null;
    }

    update(dt, worldSize) {
        const game = this.game;
        const inp = this.control || game.input;
        const mx = inp ? inp.move.x : 0, my = inp ? inp.move.y : 0;
        const mag = Math.min(1, Math.hypot(mx, my));

        // --- drifting physics -------------------------------------------------
        if (mag > 0.01) {
            const want = Math.atan2(my, mx);
            this.angle = GMath.turnToward(this.angle, want, PlayerShip.TURN_RATE * dt);
            // Thrust goes where the stick points; the hull swings round to follow.
            this.vx += mx * PlayerShip.ACCEL * dt;
            this.vy += my * PlayerShip.ACCEL * dt;
        }
        this.thrust += (mag - this.thrust) * Math.min(1, dt * 12);
        const drag = Math.exp(-PlayerShip.DRAG * dt);
        this.vx *= drag; this.vy *= drag;
        const sp = Math.hypot(this.vx, this.vy);
        if (sp > PlayerShip.MAX_SPEED) {
            this.vx *= PlayerShip.MAX_SPEED / sp;
            this.vy *= PlayerShip.MAX_SPEED / sp;
        }
        if (this.invuln > 0) this.invuln -= dt;

        // --- guns + mining beam ------------------------------------------------
        const ux = Math.cos(this.angle), uy = Math.sin(this.angle);
        this.firing = !!(inp && inp.fire);
        this.fireCooldown -= dt;
        if (this.firing) {
            if (this.fireCooldown <= 0) {
                this.fireCooldown = PlayerShip.FIRE_INTERVAL;
                const s = new Shot(game, this.x + ux * 18, this.y + uy * 18, this.angle, 'player',
                    this.vx * 0.5, this.vy * 0.5);
                game.spawn(s);
                game.sfxAt('shot', this.x, this.y);
            }
            this.mineRaycast(dt, ux, uy, worldSize);
        }

        // --- Nipbombs ----------------------------------------------------------
        if (inp && inp.pressed && inp.pressed('bomb')) this.launchBomb();

        // --- shard pickup ------------------------------------------------------
        const crystals = game.byType.crystal;
        for (let i = 0; i < crystals.length; i++) {
            const c = crystals[i];
            if (!c.alive) continue;
            const dx = GMath.wrapDelta(this.x - c.x, worldSize.x);
            const dy = GMath.wrapDelta(this.y - c.y, worldSize.y);
            const d = Math.hypot(dx, dy);
            if (d < this.radius + 12) {
                c.kill();
                game.collectShard(c);
            } else if (d < PlayerShip.MAGNET_RANGE) {
                const pull = 900 * (1 - d / PlayerShip.MAGNET_RANGE) * dt;
                c.vx += dx / d * pull; c.vy += dy / d * pull;
            }
        }

        super.update(dt);
    }

    /** Cast the mining beam along the nose; bite into the first asteroid it meets. */
    mineRaycast(dt, ux, uy, worldSize) {
        const game = this.game;
        const ox = this.x + ux * 14, oy = this.y + uy * 14;
        let best = -1, target = null;
        const rocks = game.byType.asteroid;
        for (let i = 0; i < rocks.length; i++) {
            const a = rocks[i];
            if (!a.alive) continue;
            const t = GMath.rayCircle(ox, oy, ux, uy, a, worldSize, PlayerShip.BEAM_RANGE);
            if (t >= 0 && (best < 0 || t < best)) { best = t; target = a; }
        }
        if (!target) return false;
        const hx = ox + ux * best, hy = oy + uy * best;
        this.beam.fire(ox, oy, ux * best, uy * best, 0.7 + 0.3 * Math.sin(this.age * 40));
        target.mine(PlayerShip.BEAM_POWER * dt, hx, hy, this);
        this.mineTick -= dt;
        if (this.mineTick <= 0) {
            this.mineTick = 0.07;
            game.sparks(hx, hy, 2, [0.6, 0.95, 1], 160, 0.35, -ux, -uy);
            game.sfxAt('mineTick', hx, hy);
        }
        return true;
    }

    launchBomb() {
        const game = this.game;
        if (game.playerBombs <= 0) { game.audio.sfx('noBombs'); return false; }
        game.playerBombs--;
        const ux = Math.cos(this.angle), uy = Math.sin(this.angle);
        game.spawn(new Bomb(game, this.x + ux * 20, this.y + uy * 20, this.angle, this.vx, this.vy));
        game.audio.sfx('bombLaunch');
        return true;
    }
}

PlayerShip.ACCEL = 760;
PlayerShip.DRAG = 0.85;
PlayerShip.MAX_SPEED = 520;
PlayerShip.TURN_RATE = 11;
PlayerShip.FIRE_INTERVAL = 0.115;
PlayerShip.BEAM_RANGE = 250;
PlayerShip.BEAM_POWER = 0.9;       // mining progress per second (1.0 = one shard)
PlayerShip.MAGNET_RANGE = 120;
PlayerShip.MAX_BOMBS = 12;

/** Energy bolt. owner: 'player' | 'enemy'. Collisions are resolved by the bridge. */
class Shot extends Entity {
    constructor(game, x, y, angle, owner, ivx, ivy) {
        super(game, 'shot', x, y);
        this.owner = owner;
        this.angle = angle;
        this.radius = 3;
        const sp = owner === 'player' ? Shot.PLAYER_SPEED : Shot.ENEMY_SPEED;
        this.vx = Math.cos(angle) * sp + (ivx || 0);
        this.vy = Math.sin(angle) * sp + (ivy || 0);
        this.life = owner === 'player' ? 0.62 : 1.5;
    }

    update(dt) {
        super.update(dt);
        this.life -= dt;
        if (this.life <= 0) this.alive = false;
    }
}
Shot.PLAYER_SPEED = 980;
Shot.ENEMY_SPEED = 470;

/** Nipbomb: homes on Grimalkin (asleep or awake). Each contact is one discrete hit. */
class Bomb extends Entity {
    constructor(game, x, y, angle, ivx, ivy) {
        super(game, 'bomb', x, y);
        this.radius = 7;
        this.angle = angle;
        this.vx = Math.cos(angle) * Bomb.SPEED + (ivx || 0) * 0.4;
        this.vy = Math.sin(angle) * Bomb.SPEED + (ivy || 0) * 0.4;
        this.life = 4.5;
        this.trail = 0;
    }

    update(dt, worldSize) {
        const game = this.game;
        const boss = game.boss;
        if (boss && boss.alive && !boss.dying && boss.built > 0) {
            // Homing: bend the velocity vector towards the target, keep the speed up.
            const dx = GMath.wrapDelta(boss.x - this.x, worldSize.x);
            const dy = GMath.wrapDelta(boss.y - this.y, worldSize.y);
            const want = Math.atan2(dy, dx);
            const cur = Math.atan2(this.vy, this.vx);
            const a = GMath.turnToward(cur, want, Bomb.TURN_RATE * dt);
            const sp = Math.min(Bomb.MAX_SPEED, Math.hypot(this.vx, this.vy) + 500 * dt);
            this.vx = Math.cos(a) * sp; this.vy = Math.sin(a) * sp;
        }
        this.angle += dt * 9;
        this.trail -= dt;
        if (this.trail <= 0) {
            this.trail = 0.03;
            game.spawnParticle(this.x, this.y, -this.vx * 0.1, -this.vy * 0.1, 0.4, 5, [0.5, 1, 0.42], 'smoke');
        }
        super.update(dt);
        this.life -= dt;
        if (this.life <= 0) {
            this.alive = false;
            game.explode(this.x, this.y, 22, [0.5, 1, 0.42], 'explodeSmall');
        }
    }
}
Bomb.SPEED = 430;
Bomb.MAX_SPEED = 820;
Bomb.TURN_RATE = 5.5;

if (typeof module !== 'undefined') module.exports = { PlayerShip, Shot, Bomb };
