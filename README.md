# GRIMALKIN 1010

An original two-mode arcade space shooter, built around the cyberpunk pixel-cat badge.

Mine asteroids for **shards** and forge them into **Nipbombs** while enemy **Scrappers**
haul shards to a build site and assemble **GRIMALKIN** — a colossal biomechanical
cat-skull warship — out of 12 armour plates. When the last plate locks in, it wakes,
talks, and hunts you. Only Nipbombs hurt it, and it takes exactly 13.

One game, two renderers, switchable at any moment with **M** without touching game state:

| | RETRO | NEO 2.5D |
|---|---|---|
| Renderer | Canvas 2D, 480×360 buffer, nearest-neighbour upscale | WebGL2, tilted orthographic 2.5D |
| Look | Neon vector line art on pure black, phosphor trails, scanlines, aperture mask, CRT bezel | GGX PBR metal, dynamic point lights, screen-space gloss reflections, bloom, motion blur, volumetric thrusters, parallax nebula |
| Voice | Formant speech synth through a bit-crusher (8-bit speech-chip grit) | Same synth, wide, with sub layer and reverb |

The boss's eyes and mouth glow are driven every frame by the live amplitude and
spectrum of its synthesised voice. All audio is synthesised with the Web Audio API;
there are no sample files and no external libraries.

## Play

Open `index.html` in a recent Chrome, Edge, Safari or Firefox — or serve the folder:

```sh
python3 -m http.server 8765    # then http://127.0.0.1:8765/
```

| Key | Action |
|---|---|
| WASD / arrows | Thrust (49-way: tap for a nudge, hold for full burn) |
| Space / J | Fire bolts + short-range mining beam |
| B / K / Shift | Launch a Nipbomb (homes on Grimalkin) |
| M / Tab | Switch Retro ⇄ Neo |
| P / Esc, N | Pause, mute |
| Enter | Start |

Gamepad and touch are supported. Tips: bolts cut shards out of rocks; fly over shards
to bank bombs (max 12). Shoot Scrappers carrying shards. Bombing the unfinished boss
knocks plates back off. Once it is awake, keep moving — it lunges faster than you fly.

Demo flags: `index.html?debug&mode=retro|neo&autostart&awake&bombs&god`
(with `debug`, keys 9 / 8 / 0 add a plate / land a bomb hit / fill bombs).

## Tests

```sh
node tests/run.js
```

Headless suite over the real game scripts covering the three validation rules — mode
switches preserve all gameplay state, hunting activates exactly in `STATE_AWAKE`, and
exactly 13 discrete bomb hits destroy the boss — plus wrap, mining, drone AI and
state-machine checks.

## Layout

```
index.html                  UI shell, HUD, bootloader
css/style.css               HUD + screens, Neo/Retro skins
css/retro-crt.css           CRT bezel and tube glass
js/core/Kernel.js           toroidal vector maths, base Entity, particles, beams
js/core/EngineBridge.js     game loop, physics, collisions, spawning, camera, HUD, mode toggle
js/core/StateManager.js     BOOT / ATTRACT / MINING / AWAKE / GAMEOVER
js/core/Input.js            49-way keyboard / gamepad / touch
js/core/AudioSynth.js       formant speech synth, sfx, distance-biased mixing
js/engines/RetroEngine.js   Canvas 2D vector monitor
js/engines/NeoEngine.js     WebGL2 PBR renderer
js/entities/PlayerShip.js   ship, bolts, Nipbombs
js/entities/Asteroid.js     rocks, yield + breakup tables, shards
js/entities/Drones.js       Scrapper and Claw state machines
js/entities/Grimalkin.js    the boss: 12-plate assembly, hunting, taunts, 13-hit kill
docs/CONTRACT.md            interface contract between the bridge, renderers, audio and input
```

## License

Apache License 2.0 — see [LICENSE](LICENSE).
