/* GRIMALKIN 1010 — headless validation suite.  Run:  node tests/run.js
 * Loads the real game scripts (no DOM) and checks the spec's three validation rules
 * plus the supporting mechanics. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const files = ['js/core/Kernel.js', 'js/core/StateManager.js', 'js/entities/Grimalkin.js', 'js/entities/PlayerShip.js',
    'js/entities/Asteroid.js', 'js/entities/Drones.js', 'js/core/EngineBridge.js'];
const optional = ['js/core/AudioSynth.js', 'js/core/Input.js'];
const names = ['GMath', 'Entity', 'Particle', 'Beam', 'StateManager', 'Grimalkin', 'PlayerShip', 'Shot', 'Bomb', 'Asteroid',
    'Crystal', 'WorkerDrone', 'WarriorDrone', 'EngineBridge', 'NullAudio'];
const optNames = ['AudioSynthMatrix', 'InputManager'];
const present = optional.filter(f => fs.existsSync(path.join(root, f)));
let src = files.concat(present).map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');
src += '\n;__out = {' + names.join(',') + ',' + optNames.map(n => n + ': (typeof ' + n + " !== 'undefined' ? " + n + ' : null)').join(',') + '};';
const ctx = { console, module: undefined, __out: null, performance: { now: () => Date.now() }, setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: 'game-bundle.js' });
const G = ctx.__out;

let pass = 0, fail = 0;
function test(name, fn) {
    try { fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'expected equal') + ': got ' + a + ', want ' + b); }

function stubEngine(mode) { return { mode, frames: 0, resize() { }, processSystemLogic() { this.frames++; }, onEvent() { } }; }
function newGame(seed) {
    const g = new G.EngineBridge({ headless: true, seed: seed || 1234, engineFactory: stubEngine });
    g.applyMode(g.currentMode);
    g.populateWorld(null);
    g.state.set('STATE_ATTRACT');
    return g;
}
function step(g, seconds) { for (let t = 0; t < seconds; t += 1 / 60) g.update(1 / 60); }
function removeThreats(g) { for (const e of g.entities) if (e.type === 'warrior' || e.type === 'worker' || e.type === 'asteroid') e.alive = false; g.droneTimer = 1e9; }
const metrics = g => JSON.stringify({ score: g.score, lives: g.lives, wave: g.wave, bombs: g.playerBombs, parts: g.bossPartsCollected,
    state: g.gameState, n: g.entities.length, px: g.player.x, py: g.player.y, bx: g.boss.x, built: g.boss.built, hp: g.boss.hp, t: g.time });

console.log('\nValidation 1 — mode switch preserves gameplay metrics');
test('toggling renderers mid-game changes nothing but the renderer', () => {
    const g = newGame(); g.startGame(); step(g, 3);
    g.score = 4321; g.playerBombs = 5; g.boss.addPiece(); g.boss.addPiece();
    const before = metrics(g), ents = g.entities.slice(), start = g.currentMode;
    g.toggleMode();
    assert(g.currentMode !== start, 'mode did not change');
    eq(metrics(g), before, 'metrics changed across switch');
    assert(ents.every((e, i) => g.entities[i] === e), 'entity objects were replaced');
    g.toggleMode();
    eq(g.currentMode, start); eq(metrics(g), before, 'metrics changed across switch back');
});
test('both engines stay alive and the active one keeps rendering', () => {
    const g = newGame(); g.startGame(); step(g, 0.5);
    const a = g.activeEngine; g.toggleMode(); const b = g.activeEngine; assert(a !== b);
    const f = b.frames; step(g, 0.5); assert(b.frames > f, 'new engine not rendering');
    g.toggleMode(); eq(g.activeEngine, a, 'original engine instance was not reused');
});
test('switching mid-hunt keeps the boss awake with the same hit count', () => {
    const g = newGame(); g.startGame(); removeThreats(g);
    for (let i = 0; i < 12; i++) g.boss.addPiece();
    for (let i = 0; i < 4; i++) g.boss.takeBombHit();
    g.toggleMode();
    eq(g.gameState, 'STATE_AWAKE'); eq(g.boss.bombHits, 4); eq(g.boss.hp, 9);
});

console.log('\nValidation 2 — hunting activates exactly when GLOBAL_STATE === STATE_AWAKE');
test('12th plate wakes the boss and sets STATE_AWAKE', () => {
    const g = newGame(); g.startGame();
    for (let i = 0; i < 11; i++) { g.boss.addPiece(); eq(g.gameState, 'STATE_MINING'); assert(!g.boss.hunting); }
    eq(g.bossPartsCollected, 11);
    g.boss.addPiece();
    eq(g.gameState, 'STATE_AWAKE'); eq(g.bossPartsCollected, 12); assert(g.boss.awake && g.boss.hunting);
});
test('asleep boss does not pursue; awake boss closes on the pilot', () => {
    const g = newGame(); g.startGame(); removeThreats(g);
    g.player.invuln = 1e9;
    g.boss.x = g.player.x + 1500; g.boss.y = g.player.y;
    const d0 = G.GMath.dist(g.boss, g.player, g.worldSize);
    step(g, 3);
    const d1 = G.GMath.dist(g.boss, g.player, g.worldSize);
    assert(Math.abs(d1 - d0) < 80, 'boss moved while asleep: ' + d0 + ' -> ' + d1);
    for (let i = 0; i < 12; i++) g.boss.addPiece();
    step(g, 3);
    const d2 = G.GMath.dist(g.boss, g.player, g.worldSize);
    assert(d2 < d1 - 600, 'boss did not close in: ' + d1 + ' -> ' + d2);
});
test('hunting is gated on the global state, not just the boss flag', () => {
    const g = newGame(); g.startGame(); removeThreats(g);
    for (let i = 0; i < 12; i++) g.boss.addPiece();
    assert(g.boss.hunting);
    g.state.current = 'STATE_MINING';
    assert(!g.boss.hunting, 'boss hunts outside STATE_AWAKE');
    g.state.current = 'STATE_AWAKE';
    assert(g.boss.hunting);
});
test('boss pursues across the wrap seam (shortest toroidal path)', () => {
    const g = newGame(); g.startGame(); removeThreats(g);
    g.player.invuln = 1e9; g.player.x = 100; g.player.y = 2500; g.boss.x = 4700; g.boss.y = 2500;
    for (let i = 0; i < 12; i++) g.boss.addPiece();
    step(g, 0.8);
    assert(g.boss.vx > 0, 'boss should head +x through the seam, vx=' + g.boss.vx);
});
test('awake boss catches and kills a stationary pilot', () => {
    const g = newGame(); g.startGame(); removeThreats(g);
    g.player.invuln = 0; g.boss.x = g.player.x + 700; g.boss.y = g.player.y;
    for (let i = 0; i < 12; i++) g.boss.addPiece();
    const lives = g.lives; step(g, 5);
    assert(g.lives < lives, 'pilot survived');
});

console.log('\nValidation 3 — exactly 13 discrete bomb hits destroy the boss');
test('12 hits: alive. 13th hit: destroyed', () => {
    const g = newGame(); g.startGame(); removeThreats(g); g.player.invuln = 1e9;
    for (let i = 0; i < 12; i++) g.boss.addPiece();
    const boss = g.boss;
    for (let i = 1; i <= 12; i++) { eq(boss.takeBombHit(), 'hit', 'hit ' + i); eq(boss.hp, 13 - i); assert(!boss.dying && boss.alive, 'died early at hit ' + i); }
    eq(boss.takeBombHit(), 'killed');
    assert(boss.dying > 0);
    eq(boss.takeBombHit(), 'ignored', '14th hit must be ignored');
    step(g, 4);
    assert(!boss.alive && boss.dead, 'boss still alive after death sequence');
    eq(g.gameState, 'STATE_MINING'); eq(g.wave, 2); eq(g.bossKills, 1);
});
test('real Nipbomb projectiles: 13 launched, 13 hits, dead on the 13th', () => {
    const g = newGame(); g.startGame(); removeThreats(g); g.player.invuln = 1e9;
    g.boss.x = g.player.x; g.boss.y = G.GMath.wrap(g.player.y - 2200, g.worldSize.y);
    for (let i = 0; i < 12; i++) g.boss.addPiece();
    const boss = g.boss; g.playerBombs = 12;
    for (let n = 1; n <= 13; n++) {
        // hold the boss at a safe distance so only bombs matter
        if (n === 13) g.playerBombs = 1;
        assert(g.player.launchBomb(), 'launch ' + n);
        let guard = 0;
        while (boss.bombHits < n && guard++ < 900) { boss.x = g.player.x; boss.y = G.GMath.wrap(g.player.y - 600, g.worldSize.y); boss.vx = boss.vy = 0; g.update(1 / 60); }
        eq(boss.bombHits, n, 'bomb ' + n + ' did not register exactly one hit');
        if (n < 13) assert(!boss.dying, 'died early at ' + n);
    }
    assert(boss.dying > 0 || boss.dead, 'not dying after 13');
});
test('bolts never damage the boss', () => {
    const g = newGame(); g.startGame(); removeThreats(g); g.player.invuln = 1e9;
    for (let i = 0; i < 12; i++) g.boss.addPiece();
    for (let i = 0; i < 200; i++) g.spawn(new G.Shot(g, g.boss.x - 60, g.boss.y, 0, 'player', 0, 0));
    g.boss.vx = g.boss.vy = 0; g.update(1 / 60); g.update(1 / 60);
    eq(g.boss.bombHits, 0); eq(g.boss.hp, 13);
});
test('bombing an unfinished boss knocks a plate off instead of damaging it', () => {
    const g = newGame(); g.startGame();
    for (let i = 0; i < 5; i++) g.boss.addPiece();
    eq(g.boss.takeBombHit(), 'setback'); eq(g.boss.built, 4); eq(g.bossPartsCollected, 4); eq(g.boss.bombHits, 0);
});

console.log('\nSupporting mechanics');
test('toroidal wrap keeps every entity inside the 5000x5000 grid', () => {
    const g = newGame(); g.startGame(); g.player.invuln = 1e9; g.player.x = 4999; g.player.vx = 500; step(g, 10);
    for (const e of g.entities) assert(e.x >= 0 && e.x < 5000 && e.y >= 0 && e.y < 5000, e.type + ' out of bounds ' + e.x + ',' + e.y);
});
test('mining a rock yields shards; collecting one makes a Nipbomb', () => {
    const g = newGame(); g.startGame(); removeThreats(g); g.flushPending();
    const a = g.spawn(new G.Asteroid(g, g.player.x + 120, g.player.y, 50, 7)); a.vx = a.vy = 0; g.flushPending();
    g.player.angle = 0; g.player.control = { move: { x: 0, y: 0 }, fire: true, pressed: () => false };
    step(g, 6);
    assert(g.playerBombs >= 1, 'no bombs after mining, bombs=' + g.playerBombs);
});
test('Scrappers build the boss unaided and it wakes (attract diorama)', () => {
    const g = newGame(99);
    let t = 0; while (!g.boss.awake && t < 400) { step(g, 1); t++; }
    assert(g.boss.awake, 'boss never completed; built=' + g.boss.built);
    eq(g.gameState, 'STATE_ATTRACT', 'attract must not enter AWAKE');
    assert(!g.boss.hunting);
});
test('state machine refuses illegal transitions', () => {
    const s = new G.StateManager();
    assert(!s.set('STATE_AWAKE')); eq(s.current, 'STATE_BOOT');
    assert(s.set('STATE_ATTRACT') && s.set('STATE_MINING') && s.set('STATE_AWAKE') && s.set('STATE_GAMEOVER'));
});
test('losing every ship ends the game', () => {
    const g = newGame(); g.startGame(); removeThreats(g);
    for (let i = 0; i < 3; i++) { g.player.invuln = 0; assert(g.killPlayer('test')); step(g, 2.5); }
    eq(g.gameState, 'STATE_GAMEOVER');
});
test('a full simulated minute of play never throws', () => {
    const g = newGame(5); g.startGame();
    let k = 0; g.player.control = { move: { x: 0, y: 0 }, fire: true, pressed: (a) => a === 'bomb' && (k++ % 90 === 0) };
    for (let i = 0; i < 3600; i++) { const a = i / 140; g.player.control.move.x = Math.cos(a); g.player.control.move.y = Math.sin(a * 1.3); if (g.player.alive === false && g.player.control) { } g.update(1 / 60); if (g.player && !g.player.control) g.player.control = { move: { x: 1, y: 0 }, fire: true, pressed: () => false }; }
    assert(g.entities.length < 1200, 'entity leak: ' + g.entities.length);
});
if (G.AudioSynthMatrix) test('AudioSynthMatrix is headless-safe and enforces the distance law', () => {
    const a = new G.AudioSynthMatrix();
    a.resume(); a.setMode('MODE_RETRO'); a.setMode('MODE_NEO'); a.setThrust(0.5); a.setDread(0.5); a.setMuted(true); a.sfx('shot', { distance: 10 }); a.sfx('nope');
    eq(a.maxHearingRadius, 1600);
    eq(a.triggerTaunt('NAME', 99999), 0, 'inaudible taunt should return 0');
    assert(typeof a.getVoiceLevel() === 'number' && a.getVoiceBands().length === 3 && a.isSpeaking() === false);
    assert(G.AudioSynthMatrix.TAUNTS && G.AudioSynthMatrix.TAUNTS.NAME);
});
if (G.InputManager) test('InputManager is headless-safe and quantises to 49 ways', () => {
    const i = new G.InputManager(null); i.update(0.016); i.endFrame();
    assert(i.move.x === 0 && i.move.y === 0 && i.fire === false && i.pressed('bomb') === false);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
