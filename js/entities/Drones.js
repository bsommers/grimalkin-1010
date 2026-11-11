/* GRIMALKIN 1010 — enemy drones, each a small finite state machine.
 *
 *  Scrapper (worker):  SEEK ─► FETCH ─► DELIVER ─► SEEK
 *                        └──► MINE ──► FETCH            (ESCORT once the boss is awake)
 *
 *  Claw (warrior):     PATROL ─► ATTACK ─► EVADE ─► ATTACK ... ─► PATROL
 */

class WorkerDrone extends Entity {
    constructor(game, x, y) {
        super(game, 'worker', x, y);
        this.radius = 12;
        this.state = 'SEEK';
        this.carrying = false;
        this.mining = false;
        this.target = null;
        this.thinkTimer = 0;
        this.beam = new Beam(game, 'worker');
        this.orbit = game.rand() * GMath.TAU;
    }

    setState(s, target) {
        this.state = s;
        this.target = target || null;
        this.mining = false;
    }

    update(dt, worldSize) {
        const game = this.game;
        const boss = game.boss && game.boss.alive ? game.boss : null;
        this.mining = false;

        switch (this.state) {
            case 'SEEK': this.seek(dt, boss, worldSize); break;
            case 'FETCH': this.fetch(dt, worldSize); break;
            case 'MINE': this.mine(dt, worldSize); break;
            case 'DELIVER': this.deliver(dt, boss, worldSize); break;
            case 'ESCORT': this.escort(dt, boss); break;
        }

        const sp = Math.hypot(this.vx, this.vy);
        if (sp > 8) this.angle = GMath.turnToward(this.angle, Math.atan2(this.vy, this.vx), 8 * dt);
        super.update(dt);
    }

    seek(dt, boss, worldSize) {
        const game = this.game;
        if (boss && boss.awake) { this.setState('ESCORT'); return; }
        this.thinkTimer -= dt;
        this.vx *= Math.exp(-1.5 * dt); this.vy *= Math.exp(-1.5 * dt);
        if (this.thinkTimer > 0) return;
        this.thinkTimer = 0.3 + game.rand() * 0.3;

        // Prefer a loose shard nobody has claimed...
        let best = null, bd = WorkerDrone.SENSE_RANGE;
        const cs = game.byType.crystal;
        for (let i = 0; i < cs.length; i++) {
            const c = cs[i];
            if (!c.alive || (c.claimedBy && c.claimedBy !== this)) continue;
            const d = GMath.dist(this, c, worldSize);
            if (d < bd) { bd = d; best = c; }
        }
        if (best) { best.claimedBy = this; this.setState('FETCH', best); return; }

        // ...otherwise go and cut one out of the nearest rock.
        let rock = null; bd = Infinity;
        const rs = game.byType.asteroid;
        for (let i = 0; i < rs.length; i++) {
            const a = rs[i];
            if (!a.alive) continue;
            const d = GMath.dist(this, a, worldSize);
            if (d < bd) { bd = d; rock = a; }
        }
        if (rock) this.setState('MINE', rock);
    }

    fetch(dt, worldSize) {
        const c = this.target;
        if (!c || !c.alive) { this.setState('SEEK'); return; }
        const d = this.steerTo(c.x, c.y, WorkerDrone.SPEED, 520, dt);
        if (d < this.radius + c.radius + 4) {
            c.kill();
            this.carrying = true;
            this.game.sfxAt('crystalPickup', this.x, this.y, 0.5);
            this.setState('DELIVER');
        }
    }

    mine(dt, worldSize) {
        const game = this.game, rock = this.target;
        if (!rock || !rock.alive) { this.setState('SEEK'); return; }
        const dx = GMath.wrapDelta(rock.x - this.x, worldSize.x);
        const dy = GMath.wrapDelta(rock.y - this.y, worldSize.y);
        const d = Math.hypot(dx, dy) || 1;
        const stand = rock.radius + 70;
        if (d > stand + 30) {
            this.steerTo(rock.x, rock.y, WorkerDrone.SPEED, 420, dt);
        } else {
            // Hold station and cut.
            this.vx += (rock.vx - this.vx) * Math.min(1, dt * 3);
            this.vy += (rock.vy - this.vy) * Math.min(1, dt * 3);
            this.angle = GMath.turnToward(this.angle, Math.atan2(dy, dx), 6 * dt);
            const ux = dx / d, uy = dy / d;
            const reach = d - rock.radius;
            this.mining = true;
            this.beam.fire(this.x + ux * 10, this.y + uy * 10, ux * (reach - 10), uy * (reach - 10), 0.6);
            const speedUp = 1 + (game.wave - 1) * 0.15;
            const shard = rock.mine(WorkerDrone.MINE_POWER * speedUp * dt, rock.x - ux * rock.radius, rock.y - uy * rock.radius, this);
            if (shard) { shard.claimedBy = this; this.setState('FETCH', shard); return; }
        }
        // A free shard nearby beats cutting a new one.
        this.thinkTimer -= dt;
        if (this.thinkTimer <= 0) {
            this.thinkTimer = 0.5;
            const cs = game.byType.crystal;
            for (let i = 0; i < cs.length; i++) {
                const c = cs[i];
                if (c.alive && !c.claimedBy && GMath.dist(this, c, worldSize) < 420) {
                    c.claimedBy = this; this.setState('FETCH', c); return;
                }
            }
        }
    }

    deliver(dt, boss, worldSize) {
        if (!boss || boss.awake || boss.dying) {
            // Nowhere to deliver: hang on to it and wait near where the boss was.
            if (boss && boss.awake) { this.carrying = false; this.setState('ESCORT'); }
            else { this.vx *= Math.exp(-dt); this.vy *= Math.exp(-dt); }
            return;
        }
        const d = this.steerTo(boss.x, boss.y, WorkerDrone.SPEED * 0.85, 420, dt);
        if (d < boss.radius * 0.55) {
            this.carrying = false;
            boss.deliverShard();
            this.setState('SEEK');
        }
    }

    escort(dt, boss) {
        if (!boss || !boss.awake) { this.setState('SEEK'); return; }
        this.orbit += dt * 0.9;
        const r = boss.radius + 90;
        this.steerTo(boss.x + Math.cos(this.orbit) * r, boss.y + Math.sin(this.orbit) * r, 460, 900, dt);
    }

    /** Called by the bridge when destroyed: a carried shard is dropped. */
    onDestroyed() {
        if (this.carrying) {
            this.carrying = false;
            this.game.spawn(new Crystal(this.game, this.x, this.y, this.vx * 0.3, this.vy * 0.3));
        }
        if (this.target && this.target.type === 'crystal' && this.target.claimedBy === this) this.target.claimedBy = null;
    }
}
WorkerDrone.SPEED = 215;
WorkerDrone.SENSE_RANGE = 1500;
WorkerDrone.MINE_POWER = 0.22;

class WarriorDrone extends Entity {
    constructor(game, x, y) {
        super(game, 'warrior', x, y);
        this.radius = 16;
        this.state = 'PATROL';
        this.charge = 0;
        this.timer = 0;
        this.wpx = x; this.wpy = y;
        this.strafe = game.rand() < 0.5 ? 1 : -1;
        this.pickWaypoint();
    }

    pickWaypoint() {
        const g = this.game, a = g.rand() * GMath.TAU, r = 300 + g.rand() * 700;
        this.wpx = this.x + Math.cos(a) * r;
        this.wpy = this.y + Math.sin(a) * r;
        this.timer = 4 + g.rand() * 4;
    }

    update(dt, worldSize) {
        const game = this.game;
        const p = game.player && game.player.alive ? game.player : null;
        let dx = 0, dy = 0, dist = Infinity;
        if (p) {
            dx = GMath.wrapDelta(p.x - this.x, worldSize.x);
            dy = GMath.wrapDelta(p.y - this.y, worldSize.y);
            dist = Math.hypot(dx, dy);
        }
        let face = Math.atan2(this.vy, this.vx);

        switch (this.state) {
            case 'PATROL':
                this.charge = 0;
                this.timer -= dt;
                if (this.steerTo(this.wpx, this.wpy, WarriorDrone.SPEED * 0.55, 300, dt) < 60 || this.timer <= 0) this.pickWaypoint();
                if (dist < WarriorDrone.AGGRO_RANGE) { this.state = 'ATTACK'; this.timer = 0.6 + game.rand(); }
                break;

            case 'ATTACK': {
                if (!p || dist > WarriorDrone.LEASH_RANGE) { this.state = 'PATROL'; this.pickWaypoint(); break; }
                // Hold a standoff ring around the pilot and strafe along it.
                const ux = dx / dist, uy = dy / dist;
                const ring = 300;
                const tx = this.x + dx - ux * ring + -uy * this.strafe * 220;
                const ty = this.y + dy - uy * ring + ux * this.strafe * 220;
                this.steerTo(tx, ty, WarriorDrone.SPEED, 560, dt);
                // Aim with lead.
                const lead = dist / Shot.ENEMY_SPEED;
                face = Math.atan2(dy + p.vy * lead * 0.8, dx + p.vx * lead * 0.8);
                this.timer -= dt;
                if (this.timer <= 0 && dist < 620) {
                    this.charge += dt / WarriorDrone.CHARGE_TIME;
                    if (this.charge >= 1) {
                        this.charge = 0;
                        const s = new Shot(game, this.x + Math.cos(face) * 18, this.y + Math.sin(face) * 18, face, 'enemy', 0, 0);
                        game.spawn(s);
                        game.sfxAt('enemyShot', this.x, this.y);
                        this.state = 'EVADE';
                        this.timer = 0.7 + game.rand() * 0.6;
                        this.strafe = -this.strafe;
                    }
                }
                break;
            }

            case 'EVADE': {
                this.charge = 0;
                this.timer -= dt;
                if (p) {
                    const ux = dx / dist, uy = dy / dist;
                    this.steerTo(this.x - ux * 300 - uy * this.strafe * 300, this.y - uy * 300 + ux * this.strafe * 300,
                        WarriorDrone.SPEED * 1.15, 700, dt);
                }
                if (this.timer <= 0) { this.state = p ? 'ATTACK' : 'PATROL'; this.timer = 0.5 + game.rand() * Math.max(0.3, 1.6 - game.wave * 0.15); }
                break;
            }
        }

        this.angle = GMath.turnToward(this.angle, face, 7 * dt);
        super.update(dt);
    }

    onDestroyed() { }
}
WarriorDrone.SPEED = 310;
WarriorDrone.AGGRO_RANGE = 800;
WarriorDrone.LEASH_RANGE = 1500;
WarriorDrone.CHARGE_TIME = 0.55;

/**
 * Space mouse: a harmless stowaway that darts about between the rocks. Fly over
 * one to rescue it (score + a Nipbomb). It bolts from Claws and from Grimalkin —
 * who, being a cat, will drop everything to chase it.
 */
class SpaceMouse extends Entity {
    constructor(game, x, y) {
        super(game, 'mouse', x, y);
        this.radius = 11;
        this.angle = game.rand() * GMath.TAU;
        this.heading = this.angle;
        this.scurry = 0;              // animation phase, advances with distance run
        this.squeak = 0;              // 1 -> 0 flash when it squeaks
        this.panic = false;
        this.darting = true;
        this.moveTimer = 0.5;
        this.life = SpaceMouse.LIFETIME;
    }

    update(dt, worldSize) {
        const game = this.game;
        // Nearest thing with teeth.
        let threat = null, td = Infinity;
        const boss = game.boss;
        if (boss && boss.alive && boss.built > 0) {
            const d = GMath.dist(this, boss, worldSize) - boss.radius;
            if (d < SpaceMouse.FEAR_BOSS) { threat = boss; td = d; }
        }
        const claws = game.byType.warrior;
        for (let i = 0; i < claws.length; i++) {
            const c = claws[i];
            if (!c.alive) continue;
            const d = GMath.dist(this, c, worldSize);
            if (d < SpaceMouse.FEAR_CLAW && d < td) { threat = c; td = d; }
        }

        if (threat) {
            if (!this.panic) { this.panic = true; this.squeak = 1; game.sfxAt('mouseSqueak', this.x, this.y); }
            const dx = GMath.wrapDelta(this.x - threat.x, worldSize.x);
            const dy = GMath.wrapDelta(this.y - threat.y, worldSize.y);
            // Run directly away, with a little zig-zag so it is not a straight line.
            const a = Math.atan2(dy, dx) + Math.sin(this.age * 5) * 0.5;
            this.steerTo(this.x + Math.cos(a) * 200, this.y + Math.sin(a) * 200, SpaceMouse.PANIC_SPEED, 1100, dt);
        } else {
            this.panic = false;
            this.moveTimer -= dt;
            if (this.moveTimer <= 0) {
                this.darting = !this.darting;
                this.moveTimer = this.darting ? 0.5 + game.rand() * 0.9 : 0.4 + game.rand() * 1.2;
                if (this.darting) this.heading += (game.rand() - 0.5) * 2.6;
            }
            const sp = this.darting ? SpaceMouse.SPEED : 0;
            this.steerTo(this.x + Math.cos(this.heading) * 200, this.y + Math.sin(this.heading) * 200, sp, 700, dt);
        }

        const v = Math.hypot(this.vx, this.vy);
        if (v > 12) this.angle = GMath.turnToward(this.angle, Math.atan2(this.vy, this.vx), 14 * dt);
        this.scurry += dt * (2 + v * 0.11);
        this.squeak = Math.max(0, this.squeak - dt * 2.2);
        super.update(dt);
        this.life -= dt;
        if (this.life <= 0) this.alive = false;
    }
}
SpaceMouse.SPEED = 150;
SpaceMouse.PANIC_SPEED = 330;
SpaceMouse.FEAR_BOSS = 520;
SpaceMouse.FEAR_CLAW = 300;
SpaceMouse.LIFETIME = 50;

if (typeof module !== 'undefined') module.exports = { SpaceMouse, WorkerDrone, WarriorDrone };
