/*
 * GRIMALKIN 1010 — InputManager
 * Keyboard (ramped floating vector), gamepad (true 49-way), touch
 * (floating virtual stick + fire half + multi-finger taps).
 *
 *   input.update(dt)   once per frame, before game logic
 *   input.endFrame()   once per frame, after game logic (clears edge triggers)
 *   input.move         {x, y} each quantised to 7 steps => 49-way
 *   input.moveRaw      {x, y} smooth pre-quantisation vector
 *   input.fire         bool, held
 *   input.pressed(a)   edge: 'start' | 'bomb' | 'toggleMode' | 'pause' | 'mute'
 *   input.anyKey       bool edge: any key / button / tap went down this frame
 *
 * Headless-safe: with no window nothing is attached and everything still works.
 */
class InputManager {
  constructor(targetElement) {
    this.move = { x: 0, y: 0 };
    this.moveRaw = { x: 0, y: 0 };
    this.fire = false;
    this.anyKey = false;

    this._target = targetElement || null;
    this._held = {};            // action -> count of keys holding it
    this._down = {};            // key code -> action currently held by that key
    this._edges = {};           // latched edge triggers (cleared in endFrame)
    this._anyLatch = false;
    this._kb = { x: 0, y: 0 };  // ramped keyboard vector
    this._kick = { x: 0, y: 0 };// pending tap impulses
    this._pad = { x: 0, y: 0, fire: false };
    this._padPrev = {};         // pad index -> array of previous button states
    this._touch = {
      stickId: null, ox: 0, oy: 0, x: 0, y: 0,
      fireIds: {}, active: {}, count: 0,
      tapStart: 0, tapMax: 0, tapMoved: false
    };
    this._listeners = [];
    this.stickRadius = 56;      // px of travel for full deflection on touch
    this.deadzone = 0.16;
    this.rampTime = 0.12;       // seconds for the keyboard vector to reach full

    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      try { this._attach(); } catch (e) { /* stay inert */ }
    }
  }

  /* ------------------------------------------------------------------ */
  /* public                                                               */
  /* ------------------------------------------------------------------ */

  update(dt) {
    try {
      dt = Number(dt);
      if (!(dt >= 0)) dt = 1 / 60;
      if (dt > 0.1) dt = 0.1;

      // --- keyboard: ramp the floating vector toward the held direction ---
      const tx = (this._held.right ? 1 : 0) - (this._held.left ? 1 : 0);
      const ty = (this._held.down ? 1 : 0) - (this._held.up ? 1 : 0);
      this._kb.x = this._ramp(this._kb.x, tx, dt, this._kick.x);
      this._kb.y = this._ramp(this._kb.y, ty, dt, this._kick.y);
      this._kick.x = 0; this._kick.y = 0;

      // --- gamepad ---------------------------------------------------------
      this._pollPads();

      // --- combine ---------------------------------------------------------
      let x = this._kb.x + this._pad.x + this._touch.x;
      let y = this._kb.y + this._pad.y + this._touch.y;
      x = x < -1 ? -1 : x > 1 ? 1 : x;
      y = y < -1 ? -1 : y > 1 ? 1 : y;
      this.moveRaw.x = x;
      this.moveRaw.y = y;
      this.move.x = InputManager.quantise(x);
      this.move.y = InputManager.quantise(y);

      let touchFire = false;
      for (const k in this._touch.fireIds) { if (this._touch.fireIds[k]) { touchFire = true; break; } }
      this.fire = !!(this._held.fire || this._pad.fire || touchFire);
      this.anyKey = this._anyLatch;
    } catch (e) { /* never throw from a per-frame method */ }
  }

  endFrame() {
    this._edges = {};
    this._anyLatch = false;
    this.anyKey = false;
  }

  pressed(action) {
    return this._edges[action] === true;
  }

  /** Feed a key transition by KeyboardEvent.code (also usable by tests / remaps). */
  handleKey(code, isDown, isRepeat) {
    const action = InputManager.KEYMAP[code];
    if (isDown) {
      if (isRepeat) return !!action;
      this._anyLatch = true;
      if (!action) return false;
      if (this._down[code]) return true;          // already held (missed repeat flag)
      this._down[code] = action;
      this._held[action] = (this._held[action] || 0) + 1;
      if (InputManager.EDGE_ACTIONS[action]) this._edges[action] = true;
      // a tap always registers as at least one notch (1/3) of thrust
      if (action === 'left') this._kick.x = -1;
      else if (action === 'right') this._kick.x = 1;
      else if (action === 'up') this._kick.y = -1;
      else if (action === 'down') this._kick.y = 1;
      return true;
    }
    const held = this._down[code];
    if (held) {
      delete this._down[code];
      this._held[held] = Math.max(0, (this._held[held] || 0) - 1);
    }
    return !!action;
  }

  /** Release everything (window blur, tab hidden). */
  reset() {
    this._held = {};
    this._down = {};
    this._kick.x = 0; this._kick.y = 0;
    const t = this._touch;
    t.stickId = null; t.x = 0; t.y = 0; t.fireIds = {}; t.active = {}; t.count = 0;
  }

  /** Remove every listener this instance attached. */
  destroy() {
    for (let i = 0; i < this._listeners.length; i++) {
      const l = this._listeners[i];
      try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) { /* ignore */ }
    }
    this._listeners = [];
  }

  /** Snap -1..1 to the 7 steps (-1, -2/3, -1/3, 0, 1/3, 2/3, 1). */
  static quantise(v) {
    v = Number(v);
    if (v !== v) return 0;
    if (v > 1) v = 1; else if (v < -1) v = -1;
    const q = Math.round(v * 3);
    return q === 0 ? 0 : q / 3;
  }

  /* ------------------------------------------------------------------ */
  /* internals                                                            */
  /* ------------------------------------------------------------------ */

  _ramp(v, target, dt, kick) {
    const rate = dt / this.rampTime;
    if (target !== 0) {
      // reversing: drop the opposing component immediately
      if (v * target < 0) v = 0;
      // key just went down: jump to the first notch so even a 1-frame tap reads as 1/3
      if (kick * target > 0 && Math.abs(v) < 0.17) return 0.17 * target;
      v += target * rate;
      if (v * target > 1) v = target;
    } else {
      // tapped and released within one frame: still show one frame of 1/3
      if (kick !== 0 && Math.abs(v) < 0.17) return 0.17 * kick;
      const s = v > 0 ? 1 : -1;
      v -= s * rate * 1.25;
      if (v * s < 0) v = 0;
    }
    return v;
  }

  _on(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _attach() {
    const self = this;
    const w = window;

    this._on(w, 'keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;      // leave browser shortcuts alone
      const code = InputManager.codeOf(e);
      if (self.handleKey(code, true, e.repeat) && typeof e.preventDefault === 'function') e.preventDefault();
    }, false);
    this._on(w, 'keyup', function (e) {
      const code = InputManager.codeOf(e);
      if (self.handleKey(code, false, false) && typeof e.preventDefault === 'function') e.preventDefault();
    }, false);
    this._on(w, 'blur', function () { self.reset(); }, false);
    if (typeof document !== 'undefined' && document) {
      this._on(document, 'visibilitychange', function () { if (document.hidden) self.reset(); }, false);
    }
    this._on(w, 'gamepaddisconnected', function (e) {
      if (e && e.gamepad) delete self._padPrev[e.gamepad.index];
    }, false);

    const el = (this._target && typeof this._target.addEventListener === 'function') ? this._target : w;
    const opt = { passive: false };
    this._on(el, 'touchstart', function (e) { self._touchStart(e); }, opt);
    this._on(el, 'touchmove', function (e) { self._touchMove(e); }, opt);
    this._on(el, 'touchend', function (e) { self._touchEnd(e); }, opt);
    this._on(el, 'touchcancel', function (e) { self._touchEnd(e); }, opt);
    this._on(el, 'mousedown', function () { self._anyLatch = true; }, false);
  }

  static codeOf(e) {
    if (e.code) return e.code;
    // very old browsers: derive a code from e.key
    const k = e.key || '';
    if (k.length === 1) {
      if (k === ' ') return 'Space';
      return 'Key' + k.toUpperCase();
    }
    if (k === 'Esc') return 'Escape';
    if (k === 'Up' || k === 'Down' || k === 'Left' || k === 'Right') return 'Arrow' + k;
    if (k === 'Shift') return 'ShiftLeft';
    if (k === 'Spacebar') return 'Space';
    return k;
  }

  /* ---- gamepad -------------------------------------------------------- */

  _pollPads() {
    const pad = this._pad;
    pad.x = 0; pad.y = 0; pad.fire = false;
    if (typeof navigator === 'undefined' || !navigator || typeof navigator.getGamepads !== 'function') return;
    let pads = null;
    try { pads = navigator.getGamepads(); } catch (e) { return; }
    if (!pads) return;
    let best = 0;
    for (let i = 0; i < pads.length; i++) {
      const gp = pads[i];
      if (!gp || gp.connected === false) continue;
      const b = gp.buttons || [];
      const prev = this._padPrev[i] || (this._padPrev[i] = []);
      const isDown = function (n) {
        const bt = b[n];
        if (!bt) return false;
        return typeof bt === 'object' ? (bt.pressed || bt.value > 0.5) : bt > 0.5;
      };
      for (let n = 0; n < b.length; n++) {
        const d = isDown(n);
        if (d && !prev[n]) {
          this._anyLatch = true;
          const act = InputManager.PADMAP[n];
          if (act && InputManager.EDGE_ACTIONS[act]) this._edges[act] = true;
        }
        prev[n] = d;
      }
      if (isDown(0)) pad.fire = true;

      // left stick: radial deadzone, circle -> square so diagonals reach (1,1)
      const ax = gp.axes || [];
      let x = Number(ax[0]) || 0, y = Number(ax[1]) || 0;
      let m = Math.sqrt(x * x + y * y);
      if (m < this.deadzone) { x = 0; y = 0; m = 0; }
      else {
        const k = Math.min(1, (m - this.deadzone) / (1 - this.deadzone)) / m;
        x *= k; y *= k;
        m = Math.sqrt(x * x + y * y);
        const big = Math.max(Math.abs(x), Math.abs(y));
        if (big > 0) { const sq = m / big; x *= sq; y *= sq; }
      }
      // d-pad counts as full deflection
      if (isDown(14)) x = -1; else if (isDown(15)) x = 1;
      if (isDown(12)) y = -1; else if (isDown(13)) y = 1;
      x = x < -1 ? -1 : x > 1 ? 1 : x;
      y = y < -1 ? -1 : y > 1 ? 1 : y;
      const mag = Math.abs(x) + Math.abs(y);
      if (mag > best) { best = mag; pad.x = x; pad.y = y; }
    }
  }

  /* ---- touch ---------------------------------------------------------- */

  _nowMs() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
    return Date.now();
  }

  _halfWidth() {
    let wdt = 0;
    if (typeof window !== 'undefined' && window) wdt = window.innerWidth || 0;
    if (!wdt && this._target && this._target.clientWidth) wdt = this._target.clientWidth;
    return (wdt || 800) * 0.5;
  }

  _touchStart(e) {
    try {
      if (e && e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
      const t = this._touch, list = (e && e.changedTouches) || [];
      const now = this._nowMs();
      const half = this._halfWidth();
      for (let i = 0; i < list.length; i++) {
        const p = list[i], id = p.identifier;
        if (t.count === 0) { t.tapStart = now; t.tapMax = 0; t.tapMoved = false; }
        if (!t.active[id]) { t.active[id] = { x: p.clientX, y: p.clientY, t: now }; t.count++; }
        // a multi-finger tap needs all fingers to land almost together
        if (now - t.tapStart <= 160) { if (t.count > t.tapMax) t.tapMax = t.count; }
        else t.tapMoved = true;
        if (p.clientX < half && t.stickId === null) {
          t.stickId = id; t.ox = p.clientX; t.oy = p.clientY; t.x = 0; t.y = 0;
        } else {
          t.fireIds[id] = true;
        }
      }
      this._anyLatch = true;
    } catch (err) { /* ignore */ }
  }

  _touchMove(e) {
    try {
      if (e && e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
      const t = this._touch, list = (e && e.changedTouches) || [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i], id = p.identifier;
        const a = t.active[id];
        if (a) {
          const mx = p.clientX - a.x, my = p.clientY - a.y;
          if (mx * mx + my * my > 18 * 18) t.tapMoved = true;
        }
        if (id !== t.stickId) continue;
        const r = this.stickRadius;
        let dx = p.clientX - t.ox, dy = p.clientY - t.oy;
        const m = Math.sqrt(dx * dx + dy * dy);
        if (m > r) {
          // floating stick: drag the origin along so reversing is always instant
          const over = m - r;
          t.ox += dx / m * over; t.oy += dy / m * over;
          dx = p.clientX - t.ox; dy = p.clientY - t.oy;
        }
        let x = dx / r, y = dy / r;
        const mm = Math.sqrt(x * x + y * y);
        if (mm < this.deadzone) { x = 0; y = 0; }
        else {
          const big = Math.max(Math.abs(x), Math.abs(y));
          const sq = mm / big;                       // circle -> square
          x = Math.max(-1, Math.min(1, x * sq));
          y = Math.max(-1, Math.min(1, y * sq));
        }
        t.x = x; t.y = y;
      }
    } catch (err) { /* ignore */ }
  }

  _touchEnd(e) {
    try {
      if (e && e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
      const t = this._touch, list = (e && e.changedTouches) || [];
      const cancelled = e && e.type === 'touchcancel';
      for (let i = 0; i < list.length; i++) {
        const id = list[i].identifier;
        if (t.active[id]) { delete t.active[id]; t.count = Math.max(0, t.count - 1); }
        if (id === t.stickId) { t.stickId = null; t.x = 0; t.y = 0; }
        delete t.fireIds[id];
      }
      if (t.count === 0) {
        const quick = this._nowMs() - t.tapStart <= 380;
        if (!cancelled && quick && !t.tapMoved) {
          if (t.tapMax === 2) this._edges.bomb = true;            // two-finger tap
          else if (t.tapMax >= 3) this._edges.toggleMode = true;  // three-finger tap (extra)
        }
        t.tapMax = 0;
        t.fireIds = {};
      }
    } catch (err) { /* ignore */ }
  }
}

/* KeyboardEvent.code -> action */
InputManager.KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'fire', KeyJ: 'fire',
  KeyB: 'bomb', KeyK: 'bomb', ShiftLeft: 'bomb', ShiftRight: 'bomb',
  Enter: 'start', NumpadEnter: 'start',
  KeyM: 'toggleMode', Tab: 'toggleMode',
  KeyP: 'pause', Escape: 'pause',
  KeyN: 'mute'
};

/* standard-mapping gamepad button index -> action (0 = A = fire, handled as held) */
InputManager.PADMAP = {
  1: 'bomb',        // B
  2: 'bomb',        // X
  3: 'toggleMode',  // Y
  9: 'start'        // Start
};

InputManager.EDGE_ACTIONS = { start: true, bomb: true, toggleMode: true, pause: true, mute: true };

if (typeof module !== 'undefined') module.exports = { InputManager };
