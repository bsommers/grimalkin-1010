/*
 * GRIMALKIN 1010 — RetroEngine
 * Early-80s colour vector monitor renderer (Canvas 2D).
 *
 * Pipeline per frame:
 *   1. frame buffer  (480x360, cleared to #000000, additive line art)
 *   2. phosphor buffer (fades toward black, takes the per-channel max of the new
 *      frame — so static lines never over-brighten, moving ones leave trails)
 *   3. display canvas: nearest-neighbour upscale (letterboxed), bilinear bloom
 *      mips added on top, then applyScanlineOverlay's CRT mask.
 *
 * Every asset is stroked from vertex matrices; nothing is textured or filled
 * except 1px star points and the attract-mode badge emblem.
 */
class RetroEngine {
  constructor(canvas) {
    this.canvas = canvas;

    // Contract palette (+ two derived tones: rock, white).
    this.colorPalette = {
      background: '#000000',
      cyan: '#19e6ff',
      blue: '#1450ff',
      orange: '#ff8a1e',
      amber: '#ffd21e',
      navy: '#070b24',
      eye: '#fff200',
      pink: '#ff5fa2',
      claw: '#ff3355',
      bomb: '#7dff6b',
      rock: '#7f93d8',
      white: '#ffffff'
    };

    this.bufferWidth = 480;
    this.bufferHeight = 360;
    this.persistence = 0.55;      // phosphor carry-over per 1/60 s
    this.bloom = 0.5;

    this.ok = false;
    this._time = -1e9;
    this._S = 0.4;
    this._ox = 240;
    this._oy = 180;
    this._camUx = 0;
    this._camUy = 0;
    this._shx = 0;
    this._shy = 0;
    this._glitch = 0;
    this._warmPending = true;
    this._warmT0 = -1;
    this._hardClear = true;
    this._px0 = 0; this._py0 = 0; this._pw = 480; this._ph = 360;
    this._multiplyOk = true;

    // boss scratch
    this._bx = 0; this._by = 0; this._bc = 1; this._bs = 0;
    this._qx = 0; this._qy = 0;
    this._pieceSrc = null;
    this._pcx = new Float32Array(16);
    this._pcy = new Float32Array(16);
    this._attachT = new Float64Array(16);
    this._had = new Uint8Array(16);
    this._bossLastT = -1e9;
    this._bossWx = 0; this._bossWy = 0;

    // one-shot FX pool (world anchored)
    this._fxN = 16;
    this._fxType = new Uint8Array(this._fxN);
    this._fxX = new Float64Array(this._fxN);
    this._fxY = new Float64Array(this._fxN);
    this._fxT = new Float64Array(this._fxN);
    this._fxSize = new Float32Array(this._fxN);
    this._fxCol = new Array(this._fxN);
    this._fxNext = 0;

    this._rgbCache = new Array(32768);
    this._dash = [2, 3];
    this._dashLong = [5, 4];
    this._noDash = [];

    try {
      this._init();
    } catch (err) {
      this.ok = false;
    }
  }

  /* ------------------------------------------------------------------ setup */

  _mk(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  _init() {
    if (typeof document === 'undefined' || !this.canvas || !this.canvas.getContext) return;
    const BW = this.bufferWidth, BH = this.bufferHeight;

    this.dctx = this.canvas.getContext('2d', { alpha: false }) || this.canvas.getContext('2d');
    if (!this.dctx) return;

    this.frameCanvas = this._mk(BW, BH);
    this.ctx = this.frameCanvas.getContext('2d', { alpha: false }) || this.frameCanvas.getContext('2d');
    this.trailCanvas = this._mk(BW, BH);
    this.tctx = this.trailCanvas.getContext('2d', { alpha: false }) || this.trailCanvas.getContext('2d');
    this.tctx.fillStyle = '#000000';
    this.tctx.fillRect(0, 0, BW, BH);

    // bloom mip chain
    this.g1 = this._mk(BW >> 1, BH >> 1); this.g1ctx = this.g1.getContext('2d');
    this.g2 = this._mk(BW >> 2, BH >> 2); this.g2ctx = this.g2.getContext('2d');
    this.g3 = this._mk(BW >> 3, BH >> 3); this.g3ctx = this.g3.getContext('2d');

    // hum bar
    this.band = this._mk(1, 32);
    const bctx = this.band.getContext('2d');
    const bg = bctx.createLinearGradient(0, 0, 0, 32);
    bg.addColorStop(0, 'rgba(255,255,255,0)');
    bg.addColorStop(0.5, 'rgba(210,235,255,0.07)');
    bg.addColorStop(1, 'rgba(255,255,255,0)');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, 1, 32);

    this.mask = this._mk(1, 1);
    this.mctx = this.mask.getContext('2d');

    // starfield: 3 parallax layers, [x, y, phase] in tile space 0..1
    let seed = 1010;
    const rnd = function () {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    };
    const counts = [70, 38, 16];
    this._stars = [];
    for (let l = 0; l < 3; l++) {
      const a = new Float32Array(counts[l] * 3);
      for (let i = 0; i < a.length; i++) a[i] = rnd();
      this._stars.push(a);
    }
    this._starPar = [0.12, 0.3, 0.55];
    this._starCol = [this.colorPalette.blue, this.colorPalette.cyan, this.colorPalette.white];
    this._starAlpha = [0.75, 0.6, 0.8];

    this.ok = true;

    const c = this.canvas;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.resize(c.clientWidth || c.width || 960, c.clientHeight || c.height || 720, dpr);
  }

  resize(cssW, cssH, dpr) {
    if (!this.ok) return;
    try {
      cssW = Math.max(1, +cssW || 1);
      cssH = Math.max(1, +cssH || 1);
      let k = dpr > 0 ? Math.min(dpr, 2) : 1;
      const area = cssW * cssH * k * k;
      if (area > 5.2e6) k *= Math.sqrt(5.2e6 / area);
      const cw = Math.max(1, Math.round(cssW * k));
      const ch = Math.max(1, Math.round(cssH * k));
      if (this.canvas.width !== cw) this.canvas.width = cw;
      if (this.canvas.height !== ch) this.canvas.height = ch;

      const BW = this.bufferWidth, BH = this.bufferHeight;
      const fit = Math.min(cw / BW, ch / BH);
      const whole = Math.floor(fit);
      // prefer a rigid integer pixel grid when it costs < 14% of the picture
      const s = (whole >= 1 && whole / fit >= 0.86) ? whole : fit;
      this._pw = Math.max(1, Math.round(BW * s));
      this._ph = Math.max(1, Math.round(BH * s));
      this._px0 = (cw - this._pw) >> 1;
      this._py0 = (ch - this._ph) >> 1;

      this._buildMask();

      // publish the picture rectangle (CSS px) for css/retro-crt.css
      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.style) {
        const st = document.documentElement.style;
        const q = cssW / cw;
        st.setProperty('--crt-x', (this._px0 * q).toFixed(2) + 'px');
        st.setProperty('--crt-y', (this._py0 * q).toFixed(2) + 'px');
        st.setProperty('--crt-w', (this._pw * q).toFixed(2) + 'px');
        st.setProperty('--crt-h', (this._ph * q).toFixed(2) + 'px');
        st.setProperty('--crt-r', (this._pw * q * 0.035).toFixed(2) + 'px');
      }
    } catch (err) { /* keep previous layout */ }
  }

  // Pre-rendered CRT mask (multiplied over the picture): RGB aperture stripes,
  // scanlines aligned to the internal pixel rows, barrel vignette, round corners.
  _buildMask() {
    const pw = this._pw, ph = this._ph;
    const m = this.mask;
    m.width = pw;
    m.height = ph;
    const g = this.mctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, pw, ph);

    // aperture grille
    const tri = this._mk(3, 1);
    const tg = tri.getContext('2d');
    tg.fillStyle = 'rgb(255,196,196)'; tg.fillRect(0, 0, 1, 1);
    tg.fillStyle = 'rgb(196,255,196)'; tg.fillRect(1, 0, 1, 1);
    tg.fillStyle = 'rgb(196,196,255)'; tg.fillRect(2, 0, 1, 1);
    const pat = g.createPattern(tri, 'repeat');
    if (pat) {
      g.fillStyle = pat;
      g.fillRect(0, 0, pw, ph);
    }

    // scanlines
    const rows = this.bufferHeight;
    const s = ph / rows;
    if (s >= 2) {
      const th = s >= 3 ? Math.max(1, Math.round(s * 0.36)) : 1;
      g.fillStyle = s >= 3 ? 'rgba(0,0,0,0.46)' : 'rgba(0,0,0,0.3)';
      for (let y = 0; y < rows; y++) {
        const y1 = Math.round((y + 1) * s);
        g.fillRect(0, y1 - th, pw, th);
      }
    }

    // barrel vignette
    const diag = Math.sqrt(pw * pw + ph * ph) * 0.5;
    const vg = g.createRadialGradient(pw / 2, ph / 2, diag * 0.5, pw / 2, ph / 2, diag * 1.02);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(0.7, 'rgba(0,0,0,0.22)');
    vg.addColorStop(1, 'rgba(0,0,0,0.78)');
    g.fillStyle = vg;
    g.fillRect(0, 0, pw, ph);

    // tube corners
    const r = Math.max(2, pw * 0.035);
    g.fillStyle = '#000000';
    g.beginPath();
    g.rect(0, 0, pw, ph);
    g.moveTo(r, 0);
    g.arcTo(pw, 0, pw, ph, r);
    g.arcTo(pw, ph, 0, ph, r);
    g.arcTo(0, ph, 0, 0, r);
    g.arcTo(0, 0, pw, 0, r);
    g.closePath();
    g.fill('evenodd');
  }

  /* ----------------------------------------------------------------- events */

  onEvent(evt) {
    if (!evt || !this.ok) return;
    try {
      switch (evt.type) {
        case 'explosion': {
          const c = evt.color;
          const col = c ? this._rgb(c[0], c[1], c[2]) : this.colorPalette.orange;
          let size = +evt.size || 40;
          if (size < 8) size = 8; else if (size > 400) size = 400;
          this._spawnFx(1, +evt.rx || 0, +evt.ry || 0, size, col);
          if (size > 80 && this._glitch < 0.25) this._glitch = 0.25;
          break;
        }
        case 'bossAwake':
          this._spawnFx(2, this._bossWx - this._camUx, this._bossWy - this._camUy, 950, this.colorPalette.eye);
          this._glitch = 1;
          break;
        case 'bossDeath':
          this._spawnFx(3, +evt.rx || 0, +evt.ry || 0, 700, this.colorPalette.orange);
          this._glitch = 1;
          break;
        case 'playerDeath':
          this._spawnFx(4, +evt.rx || 0, +evt.ry || 0, 70, this.colorPalette.cyan);
          this._glitch = 0.55;
          break;
        case 'modeEnter':
          this._warmPending = true;
          this._hardClear = true;
          break;
        default:
          break;
      }
    } catch (err) { /* ignore */ }
  }

  _spawnFx(type, rx, ry, size, col) {
    const i = this._fxNext;
    this._fxNext = (i + 1) % this._fxN;
    this._fxType[i] = type;
    this._fxX[i] = this._camUx + rx;
    this._fxY[i] = this._camUy + ry;
    this._fxT[i] = this._time;
    this._fxSize[i] = size;
    this._fxCol[i] = col;
  }

  /* ------------------------------------------------------------- main frame */

  processSystemLogic(entities, camera, frame) {
    if (!this.ok) return;
    try {
      this._render(entities || RetroEngine.EMPTY, camera || RetroEngine.DEFAULT_CAMERA, frame || RetroEngine.DEFAULT_FRAME);
    } catch (err) {
      this._recover();
    }
  }

  _recover() {
    try {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.setLineDash(this._noDash);
      ctx.globalAlpha = 1;
      this.dctx.setTransform(1, 0, 0, 1, 0, 0);
      this.dctx.globalAlpha = 1;
      this.dctx.globalCompositeOperation = 'source-over';
    } catch (e) { /* nothing more to do */ }
  }

  _render(entities, camera, frame) {
    const ctx = this.ctx, P = this.colorPalette;
    const BW = this.bufferWidth, BH = this.bufferHeight;

    const time = +frame.time || 0;
    let dt = +frame.dt;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.05) dt = 0.05;
    const gap = time - this._time;
    const resumed = !(gap >= 0 && gap < 0.25);
    this._time = time;
    if (this._warmPending) {
      this._warmPending = false;
      this._warmT0 = time;
    }
    if (this._glitch > 0) {
      this._glitch -= dt * 1.6;
      if (this._glitch < 0) this._glitch = 0;
    }

    let v = +frame.voiceLevel || 0;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    const bands = frame.voiceBands;
    const low = bands ? RetroEngine.clamp01(+bands[0] || 0) : 0;
    const high = bands ? RetroEngine.clamp01(+bands[2] || 0) : 0;
    const dread = RetroEngine.clamp01(+frame.dread || 0);
    if (dread > 0.5 && Math.random() < dread * 0.02 && this._glitch < 0.3) this._glitch = 0.3;

    const zoom = camera.zoom > 0 ? camera.zoom : 1;
    const S0 = BH / 900;
    const S = S0 * zoom;
    const shx = +camera.shakeX || 0, shy = +camera.shakeY || 0;
    const ux = (camera.ux !== undefined ? +camera.ux : +camera.x) || 0;
    const uy = (camera.uy !== undefined ? +camera.uy : +camera.y) || 0;
    this._S = S;
    this._shx = shx; this._shy = shy;
    this._ox = BW * 0.5 - shx * S;
    this._oy = BH * 0.5 - shy * S;
    this._camUx = ux;
    this._camUy = uy;
    const ox = this._ox, oy = this._oy;

    // ---- clear to pure black, then everything is additive light
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = P.background;
    ctx.fillRect(0, 0, BW, BH);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 1;

    this._drawStars(time, ux, uy, S0);
    this._drawGrid(ux + shx, uy + shy, S, frame.bossAwake ? P.pink : P.blue, frame.bossAwake ? 0.1 + 0.16 * dread : 0.16);
    if (frame.state === 'STATE_ATTRACT') this._drawBadge(frame.badgeImage, time);

    // ---- entities
    const n = entities.length | 0;
    const halfW = BW * 0.5 + 24, halfH = BH * 0.5 + 24;
    const cx = BW * 0.5, cy = BH * 0.5;
    for (let i = 0; i < n; i++) {
      const e = entities[i];
      if (!e) continue;
      const sx = ox + e.rx * S, sy = oy + e.ry * S;
      if (!(sx === sx && sy === sy)) continue;
      const type = e.type;
      let m = (e.radius || 0) * S;
      if (type === 'beam') m += (Math.abs(e.dx || 0) + Math.abs(e.dy || 0)) * S;
      else if (type === 'particle') m += (e.size || 0) * S;
      else if (type === 'boss') m *= 1.6;
      const ax = sx - cx, ay = sy - cy;
      if (ax > halfW + m || ax < -halfW - m || ay > halfH + m || ay < -halfH - m) continue;

      switch (type) {
        case 'particle': this._drawParticle(e, sx, sy, S); break;
        case 'asteroid': this._drawAsteroid(e, sx, sy, S); break;
        case 'shot': this._drawShot(e, sx, sy, S); break;
        case 'crystal': this._drawCrystal(e, sx, sy, S, time); break;
        case 'worker': this._drawWorker(e, sx, sy, S, time); break;
        case 'warrior': this._drawWarrior(e, sx, sy, S, time); break;
        case 'beam': this._drawBeam(e, sx, sy, S); break;
        case 'bomb': this._drawBomb(e, sx, sy, S, time); break;
        case 'player': this._drawPlayer(e, sx, sy, S, time); break;
        case 'boss': this._drawBoss(e, sx, sy, time, v, low, high); break;
        default: break;
      }
    }

    this._drawFx(time, S);

    ctx.globalAlpha = 1;
    ctx.setLineDash(this._noDash);

    // ---- phosphor persistence
    const t = this.tctx;
    t.globalCompositeOperation = 'source-over';
    t.fillStyle = '#000000';
    if (resumed || this._hardClear) {
      this._hardClear = false;
      t.globalAlpha = 1;
    } else {
      let fa = 1 - Math.pow(this.persistence, dt * 60);
      if (fa < 0.2) fa = 0.2;
      t.globalAlpha = fa;
    }
    t.fillRect(0, 0, BW, BH);
    t.globalAlpha = 1;
    t.globalCompositeOperation = 'lighten';
    t.drawImage(this.frameCanvas, 0, 0);

    this.applyScanlineOverlay(frame);
  }

  /* --------------------------------------------------- CRT presentation pass */

  applyScanlineOverlay(frame) {
    const d = this.dctx;
    if (!d) return;
    const cw = this.canvas.width, ch = this.canvas.height;
    const px = this._px0, py = this._py0, pw = this._pw, ph = this._ph;
    const BW = this.bufferWidth, BH = this.bufferHeight;
    const time = this._time;
    const src = this.trailCanvas;
    const v = RetroEngine.clamp01(+(frame && frame.voiceLevel) || 0);
    const dread = RetroEngine.clamp01(+(frame && frame.dread) || 0);

    // bloom mips (bilinear, each half the previous)
    this.g1ctx.globalCompositeOperation = 'copy';
    this.g1ctx.drawImage(src, 0, 0, this.g1.width, this.g1.height);
    this.g2ctx.globalCompositeOperation = 'copy';
    this.g2ctx.drawImage(this.g1, 0, 0, this.g2.width, this.g2.height);
    this.g3ctx.globalCompositeOperation = 'copy';
    this.g3ctx.drawImage(this.g2, 0, 0, this.g3.width, this.g3.height);

    d.setTransform(1, 0, 0, 1, 0, 0);
    d.globalCompositeOperation = 'source-over';
    d.globalAlpha = 1;
    d.fillStyle = '#000000';
    d.fillRect(0, 0, cw, ch);

    // tube warm-up: picture unfolds from a bright horizontal line
    let vy = py, vh = ph, warm = 0;
    if (this._warmT0 >= 0) {
      const w = (time - this._warmT0) / 0.5;
      if (w >= 0 && w < 1) {
        const q = 1 - w;
        vh = Math.max(2, Math.round(ph * (1 - q * q * q)));
        vy = py + ((ph - vh) >> 1);
        warm = q;
      } else {
        this._warmT0 = -1;
      }
    }

    // flicker
    let fl = 0.955 + 0.025 * Math.sin(time * 314) + Math.random() * 0.02 - dread * 0.05 * Math.random();
    if (fl > 1) fl = 1;

    d.imageSmoothingEnabled = false;
    d.globalAlpha = fl;
    const gl = this._glitch;
    if (gl > 0.01) {
      // horizontal tearing
      d.save();
      d.beginPath();
      d.rect(px, py, pw, ph);
      d.clip();
      const nb = 9, sh = BH / nb, dh = vh / nb;
      for (let b = 0; b < nb; b++) {
        const off = Math.random() < 0.55 ? Math.round((Math.random() - 0.5) * gl * pw * 0.09) : 0;
        d.drawImage(src, 0, b * sh, BW, sh, px + off, vy + b * dh, pw, dh + 1);
      }
      d.restore();
    } else {
      d.drawImage(src, 0, 0, BW, BH, px, vy, pw, vh);
    }

    // additive phosphor bloom (throbs with the boss voice)
    d.imageSmoothingEnabled = true;
    d.globalCompositeOperation = 'lighter';
    const bl = this.bloom + (frame && frame.bossAwake ? 0.3 * v : 0) + warm * 0.6;
    d.globalAlpha = bl > 1 ? 1 : bl;
    d.drawImage(this.g2, 0, 0, this.g2.width, this.g2.height, px, vy, pw, vh);
    d.globalAlpha = bl * 0.8 > 1 ? 1 : bl * 0.8;
    d.drawImage(this.g3, 0, 0, this.g3.width, this.g3.height, px, vy, pw, vh);

    // full-screen flash request
    const flash = RetroEngine.clamp01(+(frame && frame.flash) || 0);
    if (flash > 0.004) {
      const fc = frame.flashColor;
      d.fillStyle = fc ? this._rgb(fc[0], fc[1], fc[2]) : '#ffffff';
      d.globalAlpha = flash * 0.8;
      d.fillRect(px, py, pw, ph);
    }
    if (warm > 0) {
      d.fillStyle = '#ffffff';
      d.globalAlpha = warm * 0.55;
      d.fillRect(px, vy, pw, vh);
    }

    // rolling hum bar
    const bh = Math.max(4, Math.round(ph * 0.2));
    const bf = (time * 0.11) % 1;
    d.globalAlpha = 1;
    d.drawImage(this.band, 0, 0, 1, 32, px, py + bf * (ph - bh), pw, bh);

    // aperture mask + scanlines + vignette
    if (this._multiplyOk) {
      d.globalCompositeOperation = 'multiply';
      if (d.globalCompositeOperation !== 'multiply') {
        this._multiplyOk = false;
      } else {
        d.globalAlpha = 1;
        d.drawImage(this.mask, px, py);
      }
    }

    d.globalCompositeOperation = 'source-over';
    d.globalAlpha = 1;
  }

  /* -------------------------------------------------------------- utilities */

  _rgb(r, g, b) {
    const ri = r <= 0 ? 0 : r >= 1 ? 31 : (r * 31 + 0.5) | 0;
    const gi = g <= 0 ? 0 : g >= 1 ? 31 : (g * 31 + 0.5) | 0;
    const bi = b <= 0 ? 0 : b >= 1 ? 31 : (b * 31 + 0.5) | 0;
    const key = (ri << 10) | (gi << 5) | bi;
    let s = this._rgbCache[key];
    if (s === undefined) {
      s = 'rgb(' + Math.round(ri * 255 / 31) + ',' + Math.round(gi * 255 / 31) + ',' + Math.round(bi * 255 / 31) + ')';
      this._rgbCache[key] = s;
    }
    return s;
  }

  /**
   * Stroke a vertex-matrix model. model = { paths:[Float32Array x,y...], closed:[bool] }.
   * glow: 0 = single hairline stroke; >0 = wide dim under-stroke first (cheap neon halo).
   */
  drawVectorAsset(model, x, y, scale, angle, color, alpha, glow) {
    if (!model || !(alpha > 0.004)) return;
    const ctx = this.ctx;
    const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
    const paths = model.paths, closed = model.closed;
    ctx.beginPath();
    for (let p = 0; p < paths.length; p++) {
      const vt = paths[p];
      const n = vt.length;
      ctx.moveTo(x + vt[0] * c - vt[1] * s, y + vt[0] * s + vt[1] * c);
      for (let i = 2; i < n; i += 2) {
        ctx.lineTo(x + vt[i] * c - vt[i + 1] * s, y + vt[i] * s + vt[i + 1] * c);
      }
      if (closed[p]) ctx.closePath();
    }
    ctx.strokeStyle = color;
    if (glow > 0) {
      const ga = alpha * 0.3 * glow;
      ctx.globalAlpha = ga > 1 ? 1 : ga;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.globalAlpha = alpha > 1 ? 1 : alpha;
    ctx.stroke();
  }

  _ring(x, y, rad, color, alpha, glow) {
    if (!(alpha > 0.004) || !(rad > 0)) return;
    const ctx = this.ctx, C = RetroEngine.CIRCLE;
    const step = rad < 5 ? 8 : rad < 28 ? 4 : 2;   // 8 / 16 / 32-gon (table holds 64 pts)
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    for (let i = step; i < 64; i += step) ctx.lineTo(x + C[i * 2] * rad, y + C[i * 2 + 1] * rad);
    ctx.closePath();
    ctx.strokeStyle = color;
    if (glow > 0) {
      const ga = alpha * 0.3 * glow;
      ctx.globalAlpha = ga > 1 ? 1 : ga;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.globalAlpha = alpha > 1 ? 1 : alpha;
    ctx.stroke();
  }

  /* --------------------------------------------------------------- backdrop */

  _drawStars(time, ux, uy, S0) {
    const ctx = this.ctx;
    const BW = this.bufferWidth, BH = this.bufferHeight;
    for (let l = 0; l < 3; l++) {
      const a = this._stars[l];
      const par = this._starPar[l] * S0;
      const offx = ux * par, offy = uy * par;
      const base = this._starAlpha[l];
      const rate = 0.9 + l * 0.8;
      ctx.fillStyle = this._starCol[l];
      for (let i = 0; i < a.length; i += 3) {
        let x = (a[i] * BW - offx) % BW;
        if (x < 0) x += BW;
        let y = (a[i + 1] * BH - offy) % BH;
        if (y < 0) y += BH;
        x |= 0; y |= 0;
        ctx.globalAlpha = base * (0.55 + 0.45 * Math.sin(time * rate + a[i + 2] * 6.2832));
        if (l < 2) {
          ctx.fillRect(x, y, 1, 1);
        } else {
          ctx.fillRect(x - 1, y, 3, 1);
          ctx.fillRect(x, y - 1, 1, 3);
        }
      }
    }
  }

  _drawGrid(wx, wy, S, color, alpha) {
    const ctx = this.ctx;
    const BW = this.bufferWidth, BH = this.bufferHeight;
    const G = 500;
    const cx = BW * 0.5, cy = BH * 0.5;
    const hw = cx / S, hh = cy / S;
    let fx = -(wx % G); if (fx > 0) fx -= G;
    let fy = -(wy % G); if (fy > 0) fy -= G;
    const x0 = fx - Math.ceil(hw / G) * G, y0 = fy - Math.ceil(hh / G) * G;

    ctx.beginPath();
    for (let x = x0; x <= hw; x += G) {
      const sx = ((cx + x * S) | 0) + 0.5;
      if (sx < 0 || sx > BW) continue;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, BH);
    }
    for (let y = y0; y <= hh; y += G) {
      const sy = ((cy + y * S) | 0) + 0.5;
      if (sy < 0 || sy > BH) continue;
      ctx.moveTo(0, sy);
      ctx.lineTo(BW, sy);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = alpha;
    ctx.stroke();

    // brighter registration crosses on the intersections
    ctx.beginPath();
    for (let x = x0; x <= hw; x += G) {
      const sx = ((cx + x * S) | 0) + 0.5;
      if (sx < -4 || sx > BW + 4) continue;
      for (let y = y0; y <= hh; y += G) {
        const sy = ((cy + y * S) | 0) + 0.5;
        if (sy < -4 || sy > BH + 4) continue;
        ctx.moveTo(sx - 3, sy); ctx.lineTo(sx + 3, sy);
        ctx.moveTo(sx, sy - 3); ctx.lineTo(sx, sy + 3);
      }
    }
    ctx.globalAlpha = alpha * 2.4 > 1 ? 1 : alpha * 2.4;
    ctx.stroke();
  }

  _drawBadge(img, time) {
    if (!img || img.complete === false) return;
    const iw = img.naturalWidth || img.width;
    if (!iw) return;
    const ctx = this.ctx;
    const BW = this.bufferWidth, BH = this.bufferHeight;
    const size = BH >= 300 ? 256 : 128;       // 1:1 or exact 2:1 — stays pixel crisp
    const bob = Math.round(Math.sin(time * 0.9) * 7);
    const x = (BW - size) >> 1, y = ((BH - size) >> 1) + bob;
    try {
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.25 + 0.05 * Math.sin(time * 0.5);
      ctx.drawImage(img, x, y, size, size);
    } catch (err) { /* image not drawable yet */ }
    // slow emblem rings
    const P = this.colorPalette;
    ctx.setLineDash(this._dashLong);
    ctx.lineDashOffset = -time * 5;
    this._ring(BW * 0.5, BH * 0.5 + bob, size * 0.56, P.cyan, 0.22, 0);
    ctx.lineDashOffset = time * 3;
    this._ring(BW * 0.5, BH * 0.5 + bob, size * 0.6, P.orange, 0.14, 0);
    ctx.setLineDash(this._noDash);
    ctx.lineDashOffset = 0;
  }

  /* --------------------------------------------------------------- entities */

  _drawPlayer(e, sx, sy, S, time) {
    if (e.invuln > 0 && (((time * 14) | 0) & 1)) return;
    const P = this.colorPalette, M = RetroEngine.MODELS;
    const ang = e.angle || 0;
    let sc = (e.radius || 14) * S * 1.2;
    if (sc < 5.5) sc = 5.5;
    this.drawVectorAsset(M.PLAYER, sx, sy, sc, ang, P.cyan, 1, 1.3);
    this.drawVectorAsset(M.PLAYER_CANOPY, sx, sy, sc, ang, e.firing ? P.white : P.amber, 0.8, 0);

    const th = e.thrust > 0 ? (e.thrust > 1 ? 1 : e.thrust) : 0;
    if (th > 0.03) {
      const ctx = this.ctx;
      const c = Math.cos(ang) * sc, s = Math.sin(ang) * sc;
      const len = -0.5 - th * (1.0 + Math.random() * 0.9);
      ctx.beginPath();
      ctx.moveTo(sx - 0.5 * c - 0.3 * s, sy - 0.5 * s + 0.3 * c);
      ctx.lineTo(sx + len * c, sy + len * s);
      ctx.lineTo(sx - 0.5 * c + 0.3 * s, sy - 0.5 * s - 0.3 * c);
      ctx.strokeStyle = P.orange;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.3 * th;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6 + 0.4 * th;
      ctx.stroke();
    }
  }

  _drawWorker(e, sx, sy, S, time) {
    const P = this.colorPalette, M = RetroEngine.MODELS;
    const ang = e.angle || 0;
    let sc = (e.radius || 12) * S * 1.15;
    if (sc < 4.5) sc = 4.5;
    this.drawVectorAsset(M.SCRAPPER, sx, sy, sc, ang, P.blue, 1, 2.2);
    const blink = e.mining ? 0.55 + 0.45 * Math.sin(time * 30) : 0.9;
    this.drawVectorAsset(M.SCRAPPER_CAB, sx, sy, sc, ang, P.cyan, blink, 0);
    if (e.carrying) {
      const c = Math.cos(ang), s = Math.sin(ang);
      this.drawVectorAsset(M.SHARD, sx + c * sc * 1.2, sy + s * sc * 1.2, sc * 0.42, ang + time * 3, P.amber, 1, 1.5);
    }
  }

  _drawWarrior(e, sx, sy, S, time) {
    const P = this.colorPalette, M = RetroEngine.MODELS;
    const ang = e.angle || 0;
    const ch = e.charge > 0 ? (e.charge > 1 ? 1 : e.charge) : 0;
    let sc = (e.radius || 16) * S * 1.15;
    if (sc < 5.5) sc = 5.5;
    sc *= 1 + ch * 0.12;
    this.drawVectorAsset(M.CLAW, sx, sy, sc, ang, P.claw, 1, 1.4 + ch * 1.6);
    this.drawVectorAsset(M.CLAW_CORE, sx, sy, sc, ang, P.pink, 0.55, 0);
    if (ch > 0.02) {
      const f = ch > 0.7 ? 0.6 + 0.4 * Math.sin(time * 60) : 1;
      this.drawVectorAsset(M.CLAW_CORE, sx, sy, sc * (1 + ch * 0.9), ang + time * 9, P.white, ch * f, 1.5);
    }
  }

  _drawCrystal(e, sx, sy, S, time) {
    const P = this.colorPalette, M = RetroEngine.MODELS;
    const seed = (e.seed | 0) * 0.7131;
    let sc = (e.radius || 6) * S * 1.35;
    if (sc < 3) sc = 3;
    const tw = 0.5 + 0.5 * Math.sin(time * 7 + seed * 9);
    this.drawVectorAsset(M.SHARD, sx, sy, sc, seed + time * 1.4, P.amber, 0.7 + 0.3 * tw, 1.4);
    if (tw > 0.72) this.drawVectorAsset(M.TWINKLE, sx, sy, sc * (1.2 + tw), 0, P.eye, (tw - 0.72) * 3, 0);
  }

  _drawShot(e, sx, sy, S) {
    const ctx = this.ctx, P = this.colorPalette;
    const ang = e.angle || 0;
    const L = 15 * S > 4 ? 15 * S : 4;
    const c = Math.cos(ang) * L, s = Math.sin(ang) * L;
    ctx.beginPath();
    ctx.moveTo(sx - c, sy - s);
    ctx.lineTo(sx + c * 0.35, sy + s * 0.35);
    ctx.strokeStyle = e.owner === 'enemy' ? P.pink : P.cyan;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.32;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.fillStyle = P.white;
    ctx.globalAlpha = 0.8;
    ctx.fillRect((sx + c * 0.35) | 0, (sy + s * 0.35) | 0, 1, 1);
  }

  _drawBomb(e, sx, sy, S, time) {
    const ctx = this.ctx, P = this.colorPalette, M = RetroEngine.MODELS;
    let sc = (e.radius || 7) * S * 1.3;
    if (sc < 3.5) sc = 3.5;
    const vx = e.vx || 0, vy = e.vy || 0;
    const sp = Math.sqrt(vx * vx + vy * vy);
    if (sp > 1) {
      const k = (sc * 4.5) / sp;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - vx * k, sy - vy * k);
      ctx.strokeStyle = P.bomb;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.22;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
    }
    const pulse = 1 + 0.18 * Math.sin(time * 22);
    this.drawVectorAsset(M.ORB, sx, sy, sc * pulse, time * 7, P.bomb, 1, 2);
    this.drawVectorAsset(M.TWINKLE, sx, sy, sc * 0.75, -time * 11, P.white, 0.95, 0);
  }

  _drawBeam(e, sx, sy, S) {
    const ctx = this.ctx, P = this.colorPalette;
    let I = e.intensity === undefined ? 1 : +e.intensity;
    if (!(I > 0.01)) return;
    if (I > 1) I = 1;
    const ex = sx + (e.dx || 0) * S, ey = sy + (e.dy || 0) * S;
    const dx = ex - sx, dy = ey - sy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 0.5)) return;
    const nx = -dy / len, ny = dx / len;
    const amp = 1.6 * I;
    const mine = e.kind !== 'worker';

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    for (let k = 1; k < 5; k++) {
      const t = k / 5, j = (Math.random() - 0.5) * 2 * amp;
      ctx.lineTo(sx + dx * t + nx * j, sy + dy * t + ny * j);
    }
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = mine ? P.cyan : P.blue;
    ctx.lineWidth = 3;
    ctx.globalAlpha = (mine ? 0.3 : 0.5) * I;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55 + 0.45 * I;
    ctx.stroke();

    // straight hot core + impact star
    const a = Math.random() * 3.1416, r = 2 + 2.5 * I;
    const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.moveTo(ex - ca, ey - sa); ctx.lineTo(ex + ca, ey + sa);
    ctx.moveTo(ex + sa, ey - ca); ctx.lineTo(ex - sa, ey + ca);
    ctx.strokeStyle = mine ? P.white : P.cyan;
    ctx.globalAlpha = 0.6 * I;
    ctx.stroke();
  }

  _drawAsteroid(e, sx, sy, S) {
    const ctx = this.ctx, P = this.colorPalette;
    const R = (e.radius || 30) * S;
    const sh = e.shape;
    const n = sh && sh.length >= 3 ? sh.length : 0;
    const spin = e.spin || 0;
    const TAU = 6.283185307179586;

    ctx.beginPath();
    if (n) {
      const da = TAU / n;
      for (let i = 0; i < n; i++) {
        const a = i * da + spin, rr = R * sh[i];
        const x = sx + Math.cos(a) * rr, y = sy + Math.sin(a) * rr;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
    } else {
      for (let i = 0; i < 12; i++) {
        const a = i * (TAU / 12) + spin;
        const x = sx + Math.cos(a) * R, y = sy + Math.sin(a) * R;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
    }
    ctx.closePath();
    ctx.strokeStyle = P.rock;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.16;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;
    ctx.stroke();

    const heat = e.heat > 0 ? (e.heat > 1 ? 1 : e.heat) : 0;
    if (heat > 0.02) {
      ctx.strokeStyle = P.orange;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.45 * heat;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = heat;
      ctx.stroke();
    }

    const seed = e.seed | 0;
    // fracture line through the body
    if (R > 12 && n) {
      const h = (Math.imul(seed + 17, 0x9e3779b1) >>> 0);
      const i0 = h % n, i1 = (i0 + 4 + ((h >>> 8) % 3)) % n;
      const a0 = i0 * (TAU / n) + spin, a1 = i1 * (TAU / n) + spin;
      const am = spin + ((h >>> 12) & 255) * (TAU / 256);
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(a0) * R * sh[i0], sy + Math.sin(a0) * R * sh[i0]);
      ctx.lineTo(sx + Math.cos(am) * R * 0.28, sy + Math.sin(am) * R * 0.28);
      ctx.lineTo(sx + Math.cos(a1) * R * sh[i1], sy + Math.sin(a1) * R * sh[i1]);
      ctx.strokeStyle = P.rock;
      ctx.globalAlpha = 0.3;
      ctx.stroke();
    }

    // shard veins: fewer as the rock is mined out
    const rich = e.rich === undefined ? 0 : +e.rich;
    if (rich > 0.01) {
      const M = RetroEngine.MODELS;
      const veins = rich > 0.66 ? 3 : rich > 0.33 ? 2 : 1;
      let vs = R * 0.13;
      if (vs < 1.6) vs = 1.6;
      for (let k = 0; k < veins; k++) {
        const h = (Math.imul(seed + k * 7919 + 3, 0x85ebca6b) >>> 0);
        const a = spin + (h & 1023) * (TAU / 1024);
        const d = R * (0.2 + ((h >>> 10) & 255) / 255 * 0.36);
        this.drawVectorAsset(M.SHARD, sx + Math.cos(a) * d, sy + Math.sin(a) * d, vs, a, P.amber, 0.4 + 0.4 * rich + 0.2 * heat, 0);
      }
    }
  }

  _drawParticle(e, sx, sy, S) {
    const ctx = this.ctx;
    const ml = e.maxLife > 0 ? e.maxLife : 1;
    let f = e.life / ml;
    if (!(f > 0)) return;
    if (f > 1) f = 1;
    const c = e.color;
    const col = c ? this._rgb(c[0], c[1], c[2]) : this.colorPalette.white;
    const size = (e.size || 2) * S;

    switch (e.kind) {
      case 'ring':
        this._ring(sx, sy, size, col, f, 1.2);
        return;
      case 'smoke': {
        const r = size * (1.6 - 0.6 * f) + 1;
        this.drawVectorAsset(RetroEngine.MODELS.DIAMOND, sx, sy, r, (e.age || 0) * 1.5, col, f * 0.35, 0);
        return;
      }
      case 'debris': {
        const a = (e.angle || 0) + (e.age || 0) * 7;
        const r = size > 1.5 ? size : 1.5;
        const dx = Math.cos(a) * r, dy = Math.sin(a) * r;
        ctx.beginPath();
        ctx.moveTo(sx - dx, sy - dy);
        ctx.lineTo(sx + dx, sy + dy);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.globalAlpha = f;
        ctx.stroke();
        return;
      }
      default: {
        // spark: streak along its velocity
        const k = 0.035 * S;
        const dx = (e.vx || 0) * k, dy = (e.vy || 0) * k;
        ctx.globalAlpha = f;
        if (dx * dx + dy * dy < 1) {
          ctx.fillStyle = col;
          ctx.fillRect(sx | 0, sy | 0, 1, 1);
        } else {
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx - dx, sy - dy);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
  }

  /* ------------------------------------------------------------------- boss */

  _indexPieces(pieces) {
    this._pieceSrc = pieces;
    const n = pieces.length < 16 ? pieces.length : 16;
    for (let i = 0; i < n; i++) {
      const poly = pieces[i] && pieces[i].poly;
      let x = 0, y = 0, m = 0;
      if (poly) {
        for (let j = 0; j < poly.length; j++) { x += poly[j][0]; y += poly[j][1]; m++; }
      }
      this._pcx[i] = m ? x / m : 0;
      this._pcy[i] = m ? y / m : 0;
    }
  }

  // boss unit coords -> buffer coords (result in _qx/_qy)
  _bpt(ux, uy) {
    this._qx = this._bx + ux * this._bc - uy * this._bs;
    this._qy = this._by + ux * this._bs + uy * this._bc;
  }

  _bmove(ux, uy) {
    this.ctx.moveTo(this._bx + ux * this._bc - uy * this._bs, this._by + ux * this._bs + uy * this._bc);
  }

  _bline(ux, uy) {
    this.ctx.lineTo(this._bx + ux * this._bc - uy * this._bs, this._by + ux * this._bs + uy * this._bc);
  }

  // append one plate polygon, offset (ox,oy) and shrunk by k about (pcx,pcy)
  _polyPath(poly, ox, oy, k, pcx, pcy) {
    const ctx = this.ctx;
    const bx = this._bx, by = this._by, bc = this._bc, bs = this._bs;
    const n = poly.length;
    for (let j = 0; j < n; j++) {
      const p = poly[j];
      const ux = pcx + (p[0] - pcx) * k + ox, uy = pcy + (p[1] - pcy) * k + oy;
      const x = bx + ux * bc - uy * bs, y = by + ux * bs + uy * bc;
      if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  _drawBoss(e, sx, sy, time, v, low, high) {
    const ctx = this.ctx, P = this.colorPalette, M = RetroEngine.MODELS;
    const G = (typeof Grimalkin !== 'undefined' && Grimalkin) ? Grimalkin : null;
    const pieces = (G && G.PIECES && G.PIECES.length) ? G.PIECES : RetroEngine.FALLBACK_PIECES;
    const eyes = (G && G.EYES && G.EYES.length >= 2) ? G.EYES : RetroEngine.FALLBACK_EYES;
    if (this._pieceSrc !== pieces) this._indexPieces(pieces);
    const n = pieces.length < 16 ? pieces.length : 16;
    const pcx = this._pcx, pcy = this._pcy;

    const R = (e.radius || 120) * this._S;
    const tilt = e.tilt || 0;
    this._bx = sx; this._by = sy;
    this._bc = Math.cos(tilt) * R;
    this._bs = Math.sin(tilt) * R;
    this._bossWx = this._camUx + e.rx;
    this._bossWy = this._camUy + e.ry;

    const has = e.pieces || RetroEngine.EMPTY;
    const awake = !!e.awake;
    const dying = RetroEngine.clamp01(+e.dying || 0);
    const hit = RetroEngine.clamp01(+e.hitFlash || 0);
    const open = RetroEngine.clamp01(+e.mouthOpen || 0);
    const lookX = +e.lookX || 0, lookY = +e.lookY || 0;
    const spread = dying * 1.1;

    // plate attach tracking (flash a plate white as it is welded on)
    const fresh = (time - this._bossLastT) < 0.5 && time >= this._bossLastT;
    this._bossLastT = time;
    for (let i = 0; i < n; i++) {
      const now = has[i] === true ? 1 : 0;
      if (now && !this._had[i]) this._attachT[i] = fresh ? time : -1e9;
      this._had[i] = now;
    }

    // ---- construction scaffold: ghost wireframe of the missing plates
    if (!awake && dying <= 0) {
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const pc = pieces[i];
        if (has[i] === true || !pc || !pc.poly) continue;
        this._polyPath(pc.poly, 0, 0, 1, 0, 0);
        any = true;
      }
      if (any) {
        ctx.setLineDash(this._dash);
        ctx.lineDashOffset = -time * 4;
        ctx.strokeStyle = P.blue;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.34 + 0.08 * Math.sin(time * 3.1);
        ctx.stroke();
        ctx.setLineDash(this._dashLong);
        ctx.lineDashOffset = time * 7;
        this._ring(sx, sy, R * 1.24, P.cyan, 0.2, 0);
        ctx.setLineDash(this._noDash);
        ctx.lineDashOffset = 0;
      }
    }

    // ---- plates
    const plateCol = awake ? P.orange : P.cyan;
    const insetCol = awake ? P.pink : P.blue;
    for (let i = 0; i < n; i++) {
      const pc = pieces[i];
      if (has[i] !== true || !pc || !pc.poly) continue;
      let ox = 0, oy = (i < 2) ? open * 0.18 : 0, a = 1;
      if (dying > 0) {
        ox += pcx[i] * spread + (Math.random() - 0.5) * dying * 0.07;
        oy += pcy[i] * spread + (Math.random() - 0.5) * dying * 0.07;
        a = (1 - dying) * (0.55 + 0.45 * Math.random());
        if (a < 0.01) continue;
      }
      let fl = 1 - (time - this._attachT[i]) / 0.7;
      if (!(fl > 0)) fl = 0; else if (fl > 1) fl = 1;
      const white = hit > 0.05 || fl > 0.35 || (dying > 0 && Math.random() < dying * 0.5);

      ctx.beginPath();
      this._polyPath(pc.poly, ox, oy, 1, 0, 0);
      ctx.strokeStyle = white ? P.white : plateCol;
      ctx.lineWidth = 3;
      const pg = a * (0.3 + 0.45 * hit + 0.4 * fl);
      ctx.globalAlpha = pg > 1 ? 1 : pg;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = a;
      ctx.stroke();

      ctx.beginPath();
      this._polyPath(pc.poly, ox, oy, 0.6, pcx[i], pcy[i]);
      ctx.strokeStyle = white ? P.white : insetCol;
      ctx.globalAlpha = a * (awake ? 0.5 : 0.7);
      ctx.stroke();
    }

    const burn = dying > 0 ? (1 - dying) * (0.4 + 0.6 * Math.random()) : 1;

    // ---- whiskers (antenna filaments off the cheek plates)
    for (let side = 0; side < 2; side++) {
      if (has[2 + side] !== true) continue;
      const sg = side ? 1 : -1;
      const wx = pcx[2 + side] * spread, wy = pcy[2 + side] * spread;
      ctx.beginPath();
      for (let j = 0; j < 3; j++) {
        const tw = v * 0.035 * Math.sin(time * 38 + j * 2.1 + side);
        this._bmove(sg * 0.34 + wx, 0.4 + j * 0.035 + wy);
        this._bline(sg * 1.08 + wx, 0.3 + j * 0.13 + tw + wy);
      }
      ctx.strokeStyle = P.cyan;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5 * burn;
      ctx.stroke();
    }

    // ---- eyes: EMISSIVE_GLOW, pulses with the voice bus
    let E = awake ? 0.7 + 0.3 * v : 0.24 + 0.07 * Math.sin(time * 1.6) + 0.45 * v;
    E = (E + hit * 0.4) * burn;
    const eyeCol = (hit > 0.05) ? P.white
      : awake ? this._rgb(1, 0.95 - 0.28 * low * v, 0.75 * high * v) : P.amber;
    const eR = 0.17 * R;
    for (let k = 0; k < 2; k++) {
      if (has[5 + k] !== true) continue;
      const ep = eyes[k];
      const dx = pcx[5 + k] * spread, dy = pcy[5 + k] * spread;
      this._bpt(ep.x + dx, ep.y + dy);
      const ex = this._qx, ey = this._qy;
      const ang = tilt + (k ? -0.12 : 0.12);
      this.drawVectorAsset(M.EYE, ex, ey, eR * (1 + 0.1 * v), ang, eyeCol, E, awake ? 2 + 2 * v : 1);
      this.drawVectorAsset(M.EYE_HATCH, ex, ey, eR * (1 + 0.1 * v), ang, eyeCol, E * (awake ? 0.35 + 0.65 * v : 0.3), 0);
      if (awake) this.drawVectorAsset(M.EYE, ex, ey, eR * (1.3 + 0.55 * v), ang, eyeCol, (0.12 + 0.6 * v) * burn, 0);
      this._bpt(ep.x + dx + lookX * 0.06, ep.y + dy + lookY * 0.04);
      this.drawVectorAsset(M.PUPIL, this._qx, this._qy, eR, tilt, awake ? P.white : P.orange, E > 1 ? 1 : E, awake ? 1.5 : 0);
    }

    // ---- mouth: fangs, glow bars and a voice oscilloscope trace
    if (has[4] === true || has[0] === true || has[1] === true) {
      let Mg = awake ? 0.35 + 0.65 * v : 0.12 + 0.55 * v;
      Mg = (Mg + hit * 0.4) * burn;
      if (Mg > 1) Mg = 1;
      const mCol = (hit > 0.05) ? P.white
        : awake ? this._rgb(1, 0.54 + 0.42 * v, 0.12 + 0.7 * high * v) : P.orange;
      const mdx = pcx[4] * spread, mdy = pcy[4] * spread;
      const y0 = 0.5 + mdy, y1 = 0.6 + open * 0.18 + mdy;

      ctx.beginPath();
      if (has[4] === true) {
        for (let j = 0; j <= 6; j++) {
          const x = -0.3 + j * 0.1 + mdx, y = y0 + ((j & 1) ? 0.08 + open * 0.03 : 0);
          if (j) this._bline(x, y); else this._bmove(x, y);
        }
      }
      if (has[0] === true || has[1] === true) {
        const j0 = has[0] === true ? 0 : 3, j1 = has[1] === true ? 6 : 3;
        for (let j = j0; j <= j1; j++) {
          const x = -0.3 + j * 0.1 + mdx, y = y1 + ((j & 1) ? 0 : -0.07);
          if (j > j0) this._bline(x, y); else this._bmove(x, y);
        }
      }
      ctx.strokeStyle = mCol;
      ctx.lineWidth = 3;
      ctx.globalAlpha = Mg * 0.4;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = Mg;
      ctx.stroke();

      // glow bars filling the gape
      ctx.beginPath();
      for (let j = 0; j < 3; j++) {
        const t = (j + 0.5) / 3;
        const y = y0 + 0.07 + (y1 - y0 - 0.1) * t;
        const w = 0.27 - 0.06 * t;
        this._bmove(-w + mdx, y);
        this._bline(w + mdx, y);
      }
      ctx.lineWidth = 3;
      ctx.globalAlpha = Mg * (0.15 + 0.5 * v);
      ctx.stroke();
      ctx.lineWidth = 1;

      // oscilloscope trace of the voice
      if (v > 0.03) {
        const ym = (y0 + y1) * 0.5 + 0.02;
        const amp = v * (0.035 + open * 0.07);
        ctx.beginPath();
        for (let j = 0; j <= 12; j++) {
          const x = -0.26 + j * (0.52 / 12);
          const env = 1 - Math.abs(j - 6) / 7;
          const y = ym + Math.sin(j * 1.9 + time * 47) * amp * env + Math.sin(j * 0.7 - time * 23) * amp * 0.5 * env;
          if (j) this._bline(x + mdx, y); else this._bmove(x + mdx, y);
        }
        ctx.strokeStyle = P.white;
        ctx.globalAlpha = (0.3 + 0.7 * v) * burn;
        ctx.stroke();
      }
    }

    // ---- voice aura
    if (awake && dying <= 0 && v > 0.04) {
      this._ring(sx, sy, R * (1.22 + 0.22 * v), eyeCol, 0.1 + 0.45 * v, 0);
    }

    // ---- death: arcing discharge spokes
    if (dying > 0) {
      const C = RetroEngine.CIRCLE;
      ctx.beginPath();
      for (let j = 0; j < 7; j++) {
        const q = ((Math.random() * 64) | 0) * 2;
        const r0 = R * (0.2 + Math.random() * 0.5), r1 = r0 + R * (0.3 + dying * 1.2) * Math.random();
        ctx.moveTo(sx + C[q] * r0, sy + C[q + 1] * r0);
        ctx.lineTo(sx + C[q] * r1, sy + C[q + 1] * r1);
      }
      ctx.strokeStyle = Math.random() < 0.5 ? P.white : P.orange;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.35 + 0.65 * Math.sin(dying * 3.1416);
      ctx.stroke();
    }
  }

  /* -------------------------------------------------------------- event FX */

  _drawFx(time, S) {
    const ctx = this.ctx, P = this.colorPalette, C = RetroEngine.CIRCLE;
    const ux = this._camUx, uy = this._camUy, ox = this._ox, oy = this._oy;
    for (let i = 0; i < this._fxN; i++) {
      const type = this._fxType[i];
      if (!type) continue;
      const age = time - this._fxT[i];
      const size = this._fxSize[i];
      const life = type === 1 ? Math.min(1.1, 0.4 + size * 0.004) : type === 2 ? 1.6 : type === 3 ? 2.6 : 1.1;
      if (!(age >= 0 && age < life)) { this._fxType[i] = 0; continue; }
      const t = age / life;
      const ease = 1 - (1 - t) * (1 - t);
      const x = ox + (this._fxX[i] - ux) * S, y = oy + (this._fxY[i] - uy) * S;
      const col = this._fxCol[i];

      if (type === 1) {
        const rad = size * S * (0.25 + 1.15 * ease);
        this._ring(x, y, rad, col, 1 - t, 1);
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const q = ((k * 8 + i * 3) & 63) * 2;
          ctx.moveTo(x + C[q] * rad * 0.5, y + C[q + 1] * rad * 0.5);
          ctx.lineTo(x + C[q] * rad * 0.85, y + C[q + 1] * rad * 0.85);
        }
        ctx.strokeStyle = P.white;
        ctx.lineWidth = 1;
        ctx.globalAlpha = (1 - t) * 0.8;
        ctx.stroke();
      } else if (type === 2 || type === 3) {
        const rings = type === 2 ? 3 : 5;
        for (let k = 0; k < rings; k++) {
          const tk = t - k * 0.13;
          if (tk <= 0) continue;
          const c2 = (type === 3 && (k & 1)) ? P.white : col;
          this._ring(x, y, size * S * tk, c2, (1 - t) * 0.9, 1);
        }
        if (type === 3) {
          const r0 = size * S * ease * 0.15, r1 = size * S * ease * 0.6;
          ctx.beginPath();
          for (let k = 0; k < 12; k++) {
            const q = ((k * 5 + 2) & 63) * 2;
            ctx.moveTo(x + C[q] * r0, y + C[q + 1] * r0);
            ctx.lineTo(x + C[q] * r1, y + C[q + 1] * r1);
          }
          ctx.strokeStyle = P.amber;
          ctx.lineWidth = 1;
          ctx.globalAlpha = 1 - t;
          ctx.stroke();
        }
      } else {
        // player wreck: hull segments tumbling outward
        const d = size * S * ease;
        ctx.beginPath();
        for (let k = 0; k < 7; k++) {
          const q = ((k * 9 + 4) & 63) * 2;
          const px = x + C[q] * d * (0.6 + 0.07 * k), py = y + C[q + 1] * d * (0.6 + 0.07 * k);
          const a = k * 1.7 + age * (4 + k);
          const lx = Math.cos(a) * 3.2, ly = Math.sin(a) * 3.2;
          ctx.moveTo(px - lx, py - ly);
          ctx.lineTo(px + lx, py + ly);
        }
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 1 - t * t;
        ctx.stroke();
        this._ring(x, y, d * 1.3, P.white, (1 - t) * 0.6, 1);
      }
    }
  }

  static clamp01(x) {
    return x > 0 ? (x > 1 ? 1 : x) : 0;
  }
}

/* ------------------------------------------------------------ static data */

RetroEngine.EMPTY = [];
RetroEngine.DEFAULT_CAMERA = { x: 0, y: 0, zoom: 1, ux: 0, uy: 0, shakeX: 0, shakeY: 0 };
RetroEngine.DEFAULT_FRAME = {
  time: 0, dt: 1 / 60, state: 'STATE_BOOT', voiceLevel: 0, voiceBands: null,
  flash: 0, flashColor: null, bossAwake: false, dread: 0, badgeImage: null, paused: false
};

// 64-point unit circle (x,y pairs)
RetroEngine.CIRCLE = (function () {
  const a = new Float32Array(128);
  for (let i = 0; i < 64; i++) {
    a[i * 2] = Math.cos(i / 64 * Math.PI * 2);
    a[i * 2 + 1] = Math.sin(i / 64 * Math.PI * 2);
  }
  return a;
})();

// Vertex matrices. Unit = entity radius, nose along +x.
RetroEngine.MODELS = (function () {
  function model() {
    const paths = [], closed = [];
    for (let i = 0; i < arguments.length; i += 2) {
      closed.push(!!arguments[i]);
      paths.push(new Float32Array(arguments[i + 1]));
    }
    return { paths: paths, closed: closed };
  }
  const orb = [];
  for (let i = 0; i < 8; i++) orb.push(Math.cos(i / 8 * Math.PI * 2), Math.sin(i / 8 * Math.PI * 2));

  return {
    // sleek courier dart with swept tail
    PLAYER: model(
      true, [1.35, 0, -0.2, 0.42, -0.95, 0.85, -0.5, 0, -0.95, -0.85, -0.2, -0.42]
    ),
    PLAYER_CANOPY: model(
      true, [0.55, 0, 0.05, 0.17, -0.15, 0, 0.05, -0.17]
    ),
    // boxy tug with forward grapple forks and an engine block
    SCRAPPER: model(
      true, [-0.85, -0.75, 0.5, -0.75, 0.8, -0.42, 0.8, 0.42, 0.5, 0.75, -0.85, 0.75],
      false, [0.8, -0.42, 1.4, -0.58],
      false, [0.8, 0.42, 1.4, 0.58],
      false, [-0.85, -0.4, -1.2, -0.4, -1.2, 0.4, -0.85, 0.4]
    ),
    SCRAPPER_CAB: model(
      true, [-0.3, -0.36, 0.3, -0.36, 0.3, 0.36, -0.3, 0.36]
    ),
    // three-pronged fighter
    CLAW: model(
      true, [1.45, 0, 0.2, 0.3, 1.05, 1.1, -0.4, 0.72, -0.9, 0, -0.4, -0.72, 1.05, -1.1, 0.2, -0.3]
    ),
    CLAW_CORE: model(
      true, [0.3, 0, -0.1, 0.24, -0.5, 0, -0.1, -0.24]
    ),
    SHARD: model(
      true, [0, -1.3, 0.65, 0, 0, 1.3, -0.65, 0],
      false, [0, -1.3, 0, 1.3]
    ),
    DIAMOND: model(
      true, [0, -1, 1, 0, 0, 1, -1, 0]
    ),
    TWINKLE: model(
      false, [-1, 0, 1, 0],
      false, [0, -1, 0, 1]
    ),
    ORB: model(
      true, orb,
      false, [-1.5, 0, -1, 0],
      false, [1, 0, 1.5, 0]
    ),
    // almond eye, unit = eye radius
    EYE: model(
      true, [-1.2, 0, -0.6, -0.52, 0, -0.72, 0.6, -0.52, 1.2, 0, 0.6, 0.52, 0, 0.72, -0.6, 0.52]
    ),
    EYE_HATCH: model(
      false, [-0.55, -0.4, 0.55, -0.4],
      false, [-0.85, -0.2, 0.85, -0.2],
      false, [-1.05, 0, 1.05, 0],
      false, [-0.85, 0.2, 0.85, 0.2],
      false, [-0.55, 0.4, 0.55, 0.4]
    ),
    // vertical slit pupil
    PUPIL: model(
      true, [0, -0.66, 0.17, 0, 0, 0.66, -0.17, 0]
    )
  };
})();

// Used only if the shared Grimalkin data has not loaded (keeps the engine standalone).
RetroEngine.FALLBACK_EYES = [{ x: -0.5, y: 0.02 }, { x: 0.5, y: 0.02 }];
RetroEngine.FALLBACK_PIECES = (function () {
  function mirror(poly) {
    const out = [];
    for (let i = poly.length - 1; i >= 0; i--) out.push([-poly[i][0], poly[i][1]]);
    return out;
  }
  const jawL = [[-0.75, 0.5], [-0.35, 0.62], [0, 0.7], [0, 0.92], [-0.5, 0.85]];
  const cheekL = [[-0.9, -0.2], [-0.78, -0.1], [-0.72, 0.2], [-0.35, 0.45], [-0.75, 0.5], [-0.95, 0.15]];
  const eyeL = [[-0.78, -0.1], [-0.22, -0.14], [-0.2, 0.2], [-0.72, 0.2]];
  const earL = [[-0.85, -0.45], [-0.7, -1.0], [-0.3, -0.62]];
  const skullL = [[-0.85, -0.45], [-0.3, -0.62], [0, -0.66], [0, -0.38], [-0.8, -0.25]];
  return [
    { name: 'jawL', poly: jawL, order: 0 },
    { name: 'jawR', poly: mirror(jawL), order: 1 },
    { name: 'cheekL', poly: cheekL, order: 2 },
    { name: 'cheekR', poly: mirror(cheekL), order: 3 },
    { name: 'muzzle', poly: [[-0.2, 0.2], [0.2, 0.2], [0.35, 0.45], [0, 0.55], [-0.35, 0.45]], order: 4 },
    { name: 'eyeL', poly: eyeL, order: 5 },
    { name: 'eyeR', poly: mirror(eyeL), order: 6 },
    { name: 'brow', poly: [[-0.8, -0.25], [0, -0.38], [0.8, -0.25], [0.55, -0.12], [0, -0.2], [-0.55, -0.12]], order: 7 },
    { name: 'earL', poly: earL, order: 8 },
    { name: 'earR', poly: mirror(earL), order: 9 },
    { name: 'skullL', poly: skullL, order: 10 },
    { name: 'skullR', poly: mirror(skullL), order: 11 }
  ];
})();

if (typeof module !== 'undefined') module.exports = { RetroEngine };
