<p align="center">
  <img src="assets/brand/banner.svg" alt="GRIMALKIN 1010 — one game, two renderers: Retro vector CRT on the left, Neo 2.5D on the right, with the cat-skull boss straddling the seam" width="100%">
</p>

<h1 align="center">
  <img src="assets/brand/logo.svg" alt="" width="40" height="40" align="top">
  GRIMALKIN 1010
</h1>

<p align="center">
  <b>Mine the rocks. Arm the bombs. Do not let them finish the cat.</b><br>
  An original two-mode arcade space shooter, built around the cyberpunk pixel-cat badge.
</p>

<p align="center">
  <img alt="No dependencies" src="https://img.shields.io/badge/dependencies-none-19e6ff?style=flat-square&labelColor=070b24">
  <img alt="Plain JavaScript" src="https://img.shields.io/badge/plain-JavaScript-ffd21e?style=flat-square&labelColor=070b24">
  <img alt="Renderers: Canvas 2D and WebGL2" src="https://img.shields.io/badge/renderers-Canvas%202D%20%2B%20WebGL2-ff8a1e?style=flat-square&labelColor=070b24">
  <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-7dff6b?style=flat-square&labelColor=070b24">
</p>

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
assets/brand/               logo, banner, social card, favicons, web manifest
```

## Brand assets

Everything in `assets/brand/` is original vector art, self-contained (no external fonts
or images), with PNG renders alongside.

| File | Use |
|---|---|
| `banner.svg` / `banner.png` | README and site hero (1280×400, PNG at 2×) |
| `social-card.svg` / `social-card.png` | Social preview / Open Graph card (1280×640) |
| `logo.svg` / `logo-512.png` | Full emblem |
| `logo-mark.svg` / `favicon.svg` | Simplified mark for small sizes |
| `favicon.ico`, `icon-16…512.png` | Browser tab, Apple touch (180), PWA (192, 512) |
| `site.webmanifest` | Install metadata |

<p align="center">
  <img src="assets/brand/logo.svg" alt="GRIMALKIN 1010 emblem" width="160">
  &nbsp;&nbsp;&nbsp;
  <img src="assets/badge.png" alt="The cyberpunk pixel-cat badge that started it" width="160">
</p>

## License

Apache License 2.0 — see [LICENSE](LICENSE).
