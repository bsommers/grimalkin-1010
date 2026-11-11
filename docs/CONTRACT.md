# GRIMALKIN 1010 — shared interface contract

An ORIGINAL two-mode arcade space shooter (not a replica of any existing game: no
borrowed names, characters, voice lines, or art). Theme: the user's cyberpunk
pixel-cat badge (orange tabby, cyan/blue neon city, palette: cyan `#19e6ff`,
electric blue `#1450ff`, orange `#ff8a1e`, amber `#ffd21e`, deep navy `#070b24`,
eye yellow `#fff200`, hot pink `#ff5fa2`).

Fiction: the pilot mines asteroids for **shards** and forges them into
**Nipbombs**. Enemy **Scrappers** (workers) haul shards to a build site where they
assemble **GRIMALKIN**, a colossal biomechanical cat-skull warship, from 12 plates.
Once complete it wakes (`STATE_AWAKE`) and hunts the pilot, taunting by proximity.
**Claws** (warriors) harass the pilot throughout. 13 Nipbomb hits kill Grimalkin.

## Ground rules for every file

- Plain browser scripts, **no ES modules, no build step, no external libraries, no
  network fetches**. Must work from `file://` and from a static server.
- Each file defines its class as a global (`class X {}` at top level) and ends with
  `if (typeof module !== 'undefined') module.exports = { X };`
- No DOM/`window` access at script load time (only inside constructors/methods).
- Never throw out of a per-frame method; tolerate unknown entity types (skip them).
- Only edit the files you own. Do not touch other files. Do not use git.
- Verify syntax with `node --check <file>` before you finish.

## Coordinates

- World is a 5000 x 5000 torus. x → right, y → down (canvas convention).
- Angles are radians, `0` = +x, `Math.atan2(dy, dx)`; positive = clockwise on screen.
- **Renderers never wrap or cull.** Before each render the bridge sets on every
  entity `rx, ry` = position relative to the camera centre (already wrapped to the
  nearest image, already includes nothing else) and passes only entities within
  ~1500 units. Draw at `(rx, ry)`; ignore `x, y`.
- Neo maps world `(rx, ry)` to the 3D ground plane `(X = rx, Y = up, Z = ry)`.

## Renderer interface (RetroEngine, NeoEngine)

```js
new RetroEngine(canvas)            // canvas is a <canvas>; engine owns its context
engine.resize(cssWidth, cssHeight, devicePixelRatio)   // called on create + window resize
engine.processSystemLogic(entities, camera, frame)     // draw one frame
engine.onEvent(evt)                // optional one-shot FX hooks (see below)
```

Both engines are created once and kept alive; the bridge shows one canvas and hides
the other. An engine may go many seconds without being called and must resume
cleanly (no reliance on continuous dt; use `frame.time` and clamp `frame.dt`).

`camera`: `{ x, y, zoom, ux, uy, shakeX, shakeY }`
- `ux, uy` = unwrapped continuous camera position — use for parallax backdrops.
- `shakeX, shakeY` = screen-shake offset in world units; add to the view.
- `zoom` 1.0 nominal. At zoom 1 the view should show roughly **1000 world units
  across the shorter screen dimension... no more than ~1300 across the longer**.
  (Retro: scale ≈ shorterSide/900.)

`frame`:
```js
{
  time,          // seconds since boot, monotonic
  dt,            // seconds, clamped <= 0.05
  state,         // 'STATE_BOOT' | 'STATE_ATTRACT' | 'STATE_MINING' | 'STATE_AWAKE' | 'STATE_GAMEOVER'
  voiceLevel,    // 0..1 instantaneous amplitude of the boss voice bus (audio analyser)
  voiceBands,    // [low, mid, high] each 0..1 — spectrum of the voice right now
  flash,         // 0..1 full-screen white/colour flash request (decays in bridge)
  flashColor,    // [r,g,b] 0..1
  bossAwake,     // bool
  dread,         // 0..1 — how close the awake boss is to the player (0 if asleep)
  badgeImage,    // HTMLImageElement (256x256 pixel-art cat badge, same-origin data URI) or null
  paused         // bool
}
```

`engine.onEvent(evt)` (optional; ignore unknown): `{type:'explosion', rx, ry, size, color:[r,g,b]}`,
`{type:'bossAwake'}`, `{type:'bossDeath', rx, ry}`, `{type:'playerDeath', rx, ry}`,
`{type:'modeEnter'}`.

## Entities (render view)

Common: `type, rx, ry, vx, vy, angle, radius, age` (age in seconds).

| type | extra fields | notes |
|---|---|---|
| `player` | `thrust` 0..1, `invuln` seconds remaining (blink if >0), `firing` bool | radius 14. Sleek courier ship, nose along `angle`. Cyan `#19e6ff`. |
| `asteroid` | `shape` (array of 12 radius multipliers 0.7..1.15, vertex i at angle `i/12*2π + spin`), `spin` radians, `heat` 0..1 (glows orange when mined), `seed` int, `rich` 0..1 (remaining shard fraction) | radius 22..90. |
| `crystal` | `seed` | radius 6. Shard: amber/yellow `#ffd21e`, twinkles, emissive light source. |
| `worker` | `carrying` bool, `mining` bool | radius 12. Scrapper: small boxy tug, blue `#1450ff` w/ cyan; shows amber shard when carrying. |
| `warrior` | `charge` 0..1 (about to fire) | radius 16. Claw: aggressive three-pronged fighter, hot pink/red `#ff3355`. |
| `shot` | `owner` `'player'`\|`'enemy'` | radius 3. Fast bolt along `angle`. Player cyan, enemy pink. Light source. |
| `bomb` | — | radius 7. Nipbomb: spinning green-white `#7dff6b` orb with trail, homing. Light source. |
| `beam` | `dx, dy` (end point relative to start `rx, ry`), `kind` `'mine'`\|`'worker'`, `intensity` 0..1 | Mining beam. Player cyan-white, worker blue. |
| `particle` | `color` `[r,g,b]` 0..1, `life` (remaining s), `maxLife`, `size` (world units), `kind` `'spark'`\|`'smoke'`\|`'debris'`\|`'ring'` | Fade by `life/maxLife`. `ring` = expanding shockwave ring of radius `size`. Sparks are light-emitting. |
| `boss` | see below | radius 120. |

### Space mouse (`type: 'mouse'`)

`radius` 11, `angle` = heading (nose along it), `panic` (bool, fleeing), `scurry` (animation
phase in radians, advances with distance run), `squeak` (1 → 0 flash). Harmless; drawn pink.

### Boss (`type: 'boss'`)

```js
{
  radius: 120,
  pieces: [bool x12],   // which plates are attached
  built: 0..12,         // count of attached plates
  awake: bool,
  hp: 13..0,            // bomb hits remaining (only meaningful when awake)
  hitFlash: 0..1,       // decays after each bomb hit
  mouthOpen: 0..1,      // jaw drop — already driven by voice level
  lookX, lookY,         // -1..1 where the eyes look (towards player)
  tilt,                 // small roll in radians (banking)
  dying: 0..1           // 0 normally; ramps to 1 during death sequence
}
```

The face is an upright mask (ears at top = −y, never rotated except `tilt`).
Plate polygons are shared data in `Grimalkin.PIECES` (global, loaded before the
engines): array of 12 `{ name, poly: [[x,y],...], order }` in unit coordinates
(multiply by `radius`; x right, y down, within [-1,1]). Piece indices:

`0 jawL, 1 jawR, 2 cheekL, 3 cheekR, 4 muzzle, 5 eyeL, 6 eyeR, 7 brow, 8 earL, 9 earR, 10 skullL, 11 skullR`

- Draw only plates with `pieces[i] === true`. Missing plates may show a faint
  ghost/wireframe scaffold so the build site reads as "under construction".
- Jaw plates (0, 1) are offset by `+mouthOpen * 0.18` in unit y.
- Eyes: `Grimalkin.EYES = [{x:-0.5,y:0.02},{x:0.5,y:0.02}]`, radius ≈ 0.17 unit;
  vertical slit pupils offset by `lookX*0.06, lookY*0.04`. Eyes glow only when the
  matching eye plate (5 / 6) is attached; dim amber while asleep, **blazing yellow
  `#fff200` when awake**.
- Mouth glow: between muzzle and jaw around unit `(0, 0.6)`, width ≈ 0.6.
- **EMISSIVE_GLOW rule:** eye + mouth emission must pulse with `frame.voiceLevel`
  (and may colour-shift with `frame.voiceBands`) — this is the audio-sync requirement.
- `hitFlash` → flash the whole face white. `dying` → break apart / burn out.

## Audio interface (`AudioSynthMatrix`, js/core/AudioSynth.js)

```js
audio = new AudioSynthMatrix()      // may create AudioContext immediately (suspended is fine)
audio.resume()                      // call from a user gesture
audio.setMode('MODE_RETRO' | 'MODE_NEO')   // retro = 8-bit crushed, low sample-rate; neo = full, wide, reverb
audio.maxHearingRadius              // 1600
audio.triggerTaunt(lineKey, distance)   // volume = Math.max(0, 1 - distance / maxHearingRadius); returns duration (s), 0 if inaudible/skipped
audio.isSpeaking()                  // bool
audio.getVoiceLevel()               // 0..1, smoothed envelope of the VOICE bus only
audio.getVoiceBands()               // [low, mid, high] 0..1
audio.sfx(name, opts)               // opts: { distance?: number, pan?: -1..1, pitch?: number }
audio.setThrust(level)              // 0..1 continuous engine noise
audio.setDread(level)               // 0..1 heartbeat/drone as the awake boss closes in
audio.setMuted(bool)
```

`AudioSynthMatrix.TAUNTS` (static): `{ AWAKE: 'I am awake', HUNGER: 'Feed me', RUN: 'Run, little mouse', NAME: 'I am Grimalkin', ROAR: '<wordless yowl-roar>', DEATH: 'Nine lives... gone' }`

sfx names: `shot, enemyShot, mineTick, crystalPop, crystalPickup, bombLaunch, bombHit, explodeSmall, explodeBig, playerDie, workerDeliver, pieceAttach, bossAwake, bossDie, uiSelect, uiToggle, bombReady, noBombs, respawn`.
Unknown names must be ignored silently. Every method must be a safe no-op if the
AudioContext is unavailable (headless tests construct this class under Node with
no `window` — guard for that).

## Input interface (`InputManager`, js/core/Input.js)

```js
input = new InputManager(targetElement)   // attaches key/gamepad/touch listeners; headless-safe if no window
input.update(dt)        // once per frame, before game logic
input.endFrame()        // once per frame, after game logic (clears edge triggers)
input.move              // {x, y} each quantised to 7 steps (-1, -2/3, -1/3, 0, 1/3, 2/3, 1) => 49-way
input.moveRaw           // {x, y} smooth pre-quantisation floating thrust vector
input.turn              // -1..1 keyboard rotation (left/right), ramped
input.throttle          // -1..1 keyboard thrust: +1 forward (up), -1 brake then slow reverse (down)
input.aim               // {x, y} right-stick aim direction; (0,0) when centred
input.fire              // bool, held
input.pressed(action)   // edge-triggered this frame: 'start' | 'bomb' | 'toggleMode' | 'pause' | 'mute' | 'menu'
input.anyKey            // bool edge: any key/button/tap went down this frame
```

Keys: left/right (A/D) rotate, up (W) thrusts along the nose, down (S) brakes then
reverses slowly — these feed `turn`/`throttle`, never `move` (ramped over ~120 ms so
taps are fine adjustments); Space/J fire; B/K/Shift bomb; Enter start; M or Tab toggle
mode; P/Esc pause; N mute. Gamepad: left stick / d-pad fills `move` (true 49-way
quantise, ship flies where pushed), right stick fills `aim` and fires, A/RT fire,
B/X/RB/LT bomb, Y toggle mode, Start = 'menu' (start, pause, resume), Back mute. Touch: left half =
floating virtual stick, right half = fire, two-finger tap = bomb.
`preventDefault` on game keys so the page does not scroll.
