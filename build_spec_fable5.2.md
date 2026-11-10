# MASTER BUILD PROMPT: TWO-MODE SINISTAR REMAKE
# TARGET ENGINE: Claude Fable 5.2 (High/Max Effort Mode)

Please review the full project breakdown and the boilerplate code matrix below. Build me a complete, functional codebase that implements BOTH versions of this classic space shooter game, allowing a seamless toggle between them via a master UI shell.

================================================================================
PART 1: THE CREATIVE VISION & GAMEPLAY LOOPS
================================================================================
Core Gameplay: Multi-directional 2D grid space shooter. Player mines planetoids for crystals to craft "Sinibombs" while enemy workers gather crystals to build a massive, aggressive boss ship ("Sinistar"). Once built, Sinistar hunts the player relentlessly, utilizing terrifying proximity-based voice taunts.

VERSION 1: THE OLD SCHOOL REPLICA (Retro Mode)
- Visuals: 2D Canvas API, rigid arcade monitor resolution downscaling, custom CRT scanline overlay filter.
- Palette: Constrained to stark, high-contrast neon vector lines over a deep black background (#000000).
- Sprites: Player ship, drone ships, and Sinistar rendered as strict geometric, non-textured vector matrices.
- Audio: Low-bitrate, highly compressed 8-bit PCM audio samples mimicking the classic 1982 Williams custom speech-chip output.

VERSION 2: THE NEW SCHOOL EVOLUTION (Neo 2.5D Mode)
- Visuals: WebGL 2.0 / WebGPU framework with a 2.5D isometric orthographic view and modern hardware-accelerated shaders.
- Materials: Physically Based Rendering (PBR) workflows on all assets (deep metallic maps, micro-roughness variances, high-intensity ambient occlusion).
- Ray Tracing/Gloss: Real-time Screen-Space Reflections (SSR) or global illumination shader modules. Every laser blast and crystal explosion must cast vibrant, hyper-glossy specular highlights bouncing off metallic hulls.
- Sinistar Face: High-fidelity, photorealistic biomechanical skull ship. Eyes and mouth must utilize dynamic emission maps (EMISSIVE_GLOW) that pulse violently in perfect synchronicity with the audio playback frequency of the voice lines.
- VFX: Rich, multi-layered parallax backdrop with star nebulae. Active bloom, motion blur, and localized volumetric lighting around active thrusters.

================================================================================
PART 2: FILE MATRIX & COMPONENT BOILERPLATE REGISTRY
================================================================================
Instantiate the following file schema and write the complete underlying logic for each block:

- /index.html                    # Unified UI Shell, Mode Toggle Bootloader, and CSS Overlay
- /css/style.css                 # HUD layouts, Retro Vector Glow Filters, CRT Shader Configurations
- /js/core/EngineBridge.js       # Global Game Loop, Multi-directional Vector Physics, Wraparound Logic
- /js/core/StateManager.js       # Global Game States (Boot, Attract, Mining, SinistarAwake, GameOver)
- /js/core/Input.js              # 49-Way Joy-Emu Mapping, Keyboard Physics, Floating Thrust Vectors
- /js/core/AudioSynth.js         # Audio Context Speech-Synthesis, Distance-Biased Sound Matrices
- /js/engines/RetroEngine.js     # V1 Engine: 2D Canvas Context API Rasterizer & Scanline Filter
- /js/engines/NeoEngine.js       # V2 Engine: WebGL2/WebGPU 2.5D Isometric Ray-Traced PBR Renderer
- /js/entities/PlayerShip.js     # Drifting physics, Mining Beam Raycasts, SiniBomb Inventory
- /js/entities/Asteroid.js       # Structural planetoid mechanics, Breakup tables, Crystal yield drops
- /js/entities/Drones.js         # Finite State Machine for Enemy Workers (Mine/Build) & Warriors (Attack)
- /js/entities/Sinistar.js       # 12-Piece Assembly Matrix, Pathfinding Interp, Proximity Aggression

--- [EngineBridge.js Template] ---
class EngineBridge {
    constructor() {
        this.currentMode = 'MODE_NEO'; // Default mode
        this.gameState = 'STATE_BOOT';
        this.worldSize = { x: 5000, y: 5000 }; // 2D bounded loop wrap grid
        this.camera = { x: 0, y: 0, zoom: 1.0 };
        this.entities = [];
        this.sinistarPartsCollected = 0; // Out of 12 required
        this.playerBombs = 0;
    }
    init() {
        this.setupContexts();
        this.bindGlobalInputs();
        this.audio = new AudioSynthMatrix();
        this.loop();
    }
    setupContexts() {
        this.retroCanvas = document.getElementById('retroCanvas');
        this.neoCanvas = document.getElementById('neoCanvas');
        if (this.currentMode === 'MODE_RETRO') {
            this.retroCanvas.style.display = 'block';
            this.neoCanvas.style.display = 'none';
            this.activeEngine = new RetroEngine(this.retroCanvas);
        } else {
            this.retroCanvas.style.display = 'none';
            this.neoCanvas.style.display = 'block';
            this.activeEngine = new NeoEngine(this.neoCanvas);
        }
    }
    update(deltaTime) {
        this.entities.forEach(ent => {
            ent.update(deltaTime, this.worldSize);
            this.enforceBoundaryWrap(ent);
        });
        this.activeEngine.processSystemLogic(this.entities, this.camera);
    }
    enforceBoundaryWrap(entity) {
        if (entity.x  this.worldSize.x) entity.x -= this.worldSize.x;
        if (entity.y  this.worldSize.y) entity.y -= this.worldSize.y;
    }
    loop() { /* Implement requestAnimationFrame loop */ }
}

--- [RetroEngine.js Template] ---
class RetroEngine {
    constructor(canvas) {
        this.ctx = canvas.getContext('2d');
        this.colorPalette = { background: '#000000', player: '#00ffcc', sinistar: '#ff3333', vectorLine: '#ffffff' };
    }
    processSystemLogic(entities, camera) {
        this.ctx.fillStyle = this.colorPalette.background;
        this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
        this.ctx.save();
        this.ctx.translate(this.ctx.canvas.width/2 - camera.x, this.ctx.canvas.height/2 - camera.y);
        entities.forEach(ent => this.drawVectorAsset(ent));
        this.ctx.restore();
        this.applyScanlineOverlay();
    }
    drawVectorAsset(entity) { /* Retro geometric line matrices drawing logic */ }
    applyScanlineOverlay() { /* Retro CRT rendering logic */ }
}

--- [NeoEngine.js Template] ---
class NeoEngine {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2') || canvas.getContext('webgpu');
        this.initPBRRenderPipeline();
    }
    initPBRRenderPipeline() { /* WebGL2 Program setup, vertex/fragment shaders, roughness variables */ }
    processSystemLogic(entities, camera) {
        this.clearBufferPass();
        this.computeRayTracedGlossReflections();
        this.renderEntities3DPlane(entities, camera);
        this.applyVolumetricPostFX();
    }
    computeRayTracedGlossReflections() { /* SSR/Gloss shader execution */ }
    renderEntities3DPlane(entities, camera) { /* Map 2D physics into 3D isometric meshes */ }
    applyVolumetricPostFX() { /* Bloom, HDR, dynamic emissive audio sync */ }
}

--- [AudioSynth.js Template] ---
class AudioSynthMatrix {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    triggerTaunt(lineKey, distanceVector) {
        // Enforce: Volume = Math.max(0, 1 - (distanceVector / maxHearingRadius))
        // Synthesize/play via Web Audio API: "I hunger!", "Beware, I live!", "Run, coward!", "I am Sinistar!"
    }
}

================================================================================
PART 3: VALIDATION AND TESTS
================================================================================
1. Switching modes must happen smoothly via DOM event listener without resetting gameplay metrics.
2. Sinistar's vector hunting logic must activate flawlessly when GLOBAL_STATE === 'STATE_AWAKE'.
3. Hit testing must require exactly 13 discrete bomb hits to defeat Sinistar.

Please generate the complete, unbroken source files for this layout.

