/*
 * GRIMALKIN 1010 — AudioSynthMatrix
 * Everything is synthesised live with the Web Audio API. Zero sample files.
 *
 *  - Boss voice: a parallel formant / phoneme speech synthesiser
 *      glottal pulse oscillators (+ sub-harmonic growl AM, pitch jitter)
 *      + noise (aspiration / frication / stop bursts)
 *      -> 5 parallel band-pass formant filters with scheduled trajectories
 *    speaking hand-authored phoneme sequences (AudioSynthMatrix.LINES).
 *  - MODE_RETRO: voice + sfx run through a bit-crusher / sample-rate reducer
 *    (AudioWorklet from a Blob URL; ScriptProcessor or WaveShaper fallback).
 *  - MODE_NEO: sub layer, stereo widening, convolution reverb (generated impulse).
 *  - Voice has its own bus with an AnalyserNode -> getVoiceLevel()/getVoiceBands().
 *
 * Headless-safe: with no window / AudioContext every method is a no-op, except
 * that triggerTaunt still returns the line duration and drives a synthetic
 * voice envelope so visuals and game timing behave identically.
 */
class AudioSynthMatrix {
  constructor(opts) {
    opts = opts || {};
    this.maxHearingRadius = 1600;
    this.mode = 'MODE_RETRO';
    this.muted = false;
    this.ctx = null;
    this._ok = false;          // graph built successfully
    this._offline = false;     // injected (offline) context: treat as always live
    this._thrust = 0;
    this._dread = 0;
    this._nextBeat = 0;
    this._heartTimer = null;
    this._sfxLast = {};
    this._utt = null;          // currently scheduled utterance nodes
    this._speakStart = 0;      // wall-clock seconds
    this._speakEnd = 0;
    this._speakComp = null;
    this._voiceAudio = false;  // current utterance is really playing on the graph
    this._level = 0;
    this._levelT = 0;
    this._agc = 0.05;
    this._bands = [0, 0, 0];
    this._timeBuf = null;
    this._freqBuf = null;
    try {
      this._initContext(opts.context);
    } catch (e) {
      this._ok = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* public API                                                           */
  /* ------------------------------------------------------------------ */

  resume() {
    try {
      const ctx = this.ctx;
      if (!ctx) return;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
      if (this._ok && !this._unlocked) {
        // iOS-style unlock: play one silent sample inside the gesture
        this._unlocked = true;
        const b = ctx.createBufferSource();
        b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        b.connect(ctx.destination);
        b.start(0);
      }
    } catch (e) { /* ignore */ }
  }

  setMode(mode) {
    if (mode !== 'MODE_RETRO' && mode !== 'MODE_NEO') return;
    this.mode = mode;
    try { this._applyMode(false); } catch (e) { /* ignore */ }
  }

  setMuted(muted) {
    this.muted = !!muted;
    try {
      if (this._ok && this.muteGain) {
        const t = this.ctx.currentTime;
        this.muteGain.gain.cancelScheduledValues(t);
        this.muteGain.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.015);
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * Speak a line. volume = Math.max(0, 1 - distance / maxHearingRadius).
   * Skipped (returns 0) if inaudible, unknown, or already speaking — unless the
   * key is AWAKE or DEATH, which interrupt. Returns the line duration (s).
   */
  triggerTaunt(lineKey, distance) {
    try {
      const comp = AudioSynthMatrix.compileLine(lineKey);
      if (!comp) return 0;
      let d = Number(distance);
      if (d !== d) d = 0;            // NaN / undefined -> point blank
      if (d < 0) d = 0;
      const volume = Math.max(0, 1 - d / this.maxHearingRadius);
      if (!(volume > 0)) return 0;
      const priority = lineKey === 'AWAKE' || lineKey === 'DEATH';
      if (this.isSpeaking() && !priority) return 0;

      this._cutVoice();
      let lead = 0;
      this._voiceAudio = false;
      if (this._live()) {
        try {
          lead = this._speak(comp, volume);
          this._voiceAudio = true;
        } catch (e) {
          this._voiceAudio = false;
          lead = 0;
        }
      }
      const now = this._now();
      this._speakComp = comp;
      this._speakStart = now + lead;
      this._speakEnd = now + lead + comp.dur;
      return comp.dur;
    } catch (e) {
      return 0;
    }
  }

  isSpeaking() {
    return this._now() < this._speakEnd;
  }

  /** 0..1 smoothed envelope of the VOICE bus only (fast attack, slower release). */
  getVoiceLevel() {
    try {
      const now = this._now();
      let dt = now - this._levelT;
      this._levelT = now;
      if (!(dt > 0)) dt = 0;
      if (dt > 0.1) dt = 0.1;

      let target = 0;
      const speaking = now < this._speakEnd + 0.25;
      if (speaking && this._voiceAudio && this._live() && this.analyser) {
        target = this._analyserLevel();
      } else if (now < this._speakEnd) {
        target = this._synthLevel(now);
      }
      const tau = target > this._level ? 0.012 : 0.085;
      const k = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
      this._level += (target - this._level) * k;
      if (this._level < 0.0005) this._level = 0;
      if (this._level > 1) this._level = 1;
      this._pumpHeart();
      return this._level;
    } catch (e) {
      return 0;
    }
  }

  /** [low, mid, high] each 0..1 — spectrum of the voice right now. */
  getVoiceBands() {
    try {
      const now = this._now();
      const speaking = now < this._speakEnd + 0.25;
      let lo = 0, mi = 0, hi = 0;
      if (speaking && this._voiceAudio && this._live() && this.analyser) {
        const a = this.analyser;
        const n = this._fftSize >> 1;
        if (!this._freqBuf || this._freqBuf.length !== n) this._freqBuf = new Uint8Array(n);
        a.getByteFrequencyData(this._freqBuf);
        const binHz = this.ctx.sampleRate / this._fftSize;
        const band = (f0, f1) => {
          let i0 = Math.max(1, Math.floor(f0 / binHz));
          let i1 = Math.min(n - 1, Math.ceil(f1 / binHz));
          if (i1 < i0) i1 = i0;
          let s = 0, pk = 0;
          for (let i = i0; i <= i1; i++) { const v = this._freqBuf[i]; s += v; if (v > pk) pk = v; }
          // blend mean and peak so narrow formant peaks still register
          return (0.5 * s / (i1 - i0 + 1) + 0.5 * pk) / 255;
        };
        lo = Math.min(1, band(60, 420) * 1.15);
        mi = Math.min(1, band(420, 2000) * 1.3);
        hi = Math.min(1, band(2000, 7000) * 1.6);
      } else if (now < this._speakEnd && this._speakComp) {
        const s = this._segAt(now - this._speakStart);
        if (s) { lo = s.bands[0]; mi = s.bands[1]; hi = s.bands[2]; }
      }
      const b = this._bands;
      b[0] += (lo - b[0]) * 0.5;
      b[1] += (mi - b[1]) * 0.5;
      b[2] += (hi - b[2]) * 0.5;
      return [b[0] < 0.001 ? 0 : b[0], b[1] < 0.001 ? 0 : b[1], b[2] < 0.001 ? 0 : b[2]];
    } catch (e) {
      return [0, 0, 0];
    }
  }

  /** opts: { distance?: number, pan?: -1..1, pitch?: number } */
  sfx(name, opts) {
    try {
      const table = AudioSynthMatrix.SFX;
      if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(table, name)) return;
      if (!this._live()) return;
      opts = opts || {};
      let vol = 1;
      if (typeof opts.distance === 'number' && opts.distance === opts.distance) {
        vol = Math.max(0, 1 - Math.max(0, opts.distance) / this.maxHearingRadius);
      }
      if (!(vol > 0)) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      // rate-limit identical sounds so swarms do not stack into a wall of noise
      const gap = AudioSynthMatrix.SFX_MIN_GAP[name] || 0.02;
      if (this._sfxLast[name] != null && t - this._sfxLast[name] < gap && t >= this._sfxLast[name]) return;
      this._sfxLast[name] = t;

      let pitch = typeof opts.pitch === 'number' && opts.pitch > 0 ? opts.pitch : 1;
      pitch = Math.min(4, Math.max(0.25, pitch));
      let pan = typeof opts.pan === 'number' && opts.pan === opts.pan ? opts.pan : 0;
      pan = Math.min(1, Math.max(-1, pan));

      const out = ctx.createGain();
      out.gain.value = vol * (0.35 + 0.65 * vol);   // slightly steeper than linear
      out._n = 0;
      if (typeof ctx.createStereoPanner === 'function') {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        out.connect(p);
        p.connect(this.sfxBus);
        out._tail = p;
      } else {
        out.connect(this.sfxBus);
      }
      table[name](this, out, t + 0.004, pitch);
    } catch (e) { /* never throw */ }
  }

  /** 0..1 continuous engine noise */
  setThrust(level) {
    try {
      level = AudioSynthMatrix._clamp01(level);
      this._thrust = level;
      if (!this._live() || !this.thrustGain) return;
      const t = this.ctx.currentTime;
      this.thrustGain.gain.setTargetAtTime(level * 0.2, t, 0.035);
      this.thrustFilter.frequency.setTargetAtTime(240 + level * 950, t, 0.06);
      this.rumbleGain.gain.setTargetAtTime(level * 0.16, t, 0.05);
      this.rumbleOsc.frequency.setTargetAtTime(42 + level * 26, t, 0.08);
    } catch (e) { /* ignore */ }
  }

  /** 0..1 heartbeat + low drone; tempo, pitch and weight rise with level */
  setDread(level) {
    try {
      level = AudioSynthMatrix._clamp01(level);
      this._dread = level;
      if (!this._live() || !this.droneGain) return;
      const t = this.ctx.currentTime;
      this.droneGain.gain.setTargetAtTime(level > 0.01 ? 0.05 + level * 0.2 : 0, t, 0.3);
      this.droneFilter.frequency.setTargetAtTime(90 + level * 330, t, 0.3);
      const cents = level * 500;
      this.droneA.detune.setTargetAtTime(cents, t, 0.5);
      this.droneB.detune.setTargetAtTime(cents, t, 0.5);
      this.droneC.detune.setTargetAtTime(cents, t, 0.5);
      this.droneLfo.frequency.setTargetAtTime(0.4 + level * 5, t, 0.3);
      this._pumpHeart();
      if (level > 0.02 && !this._heartTimer && !this._offline && typeof setInterval === 'function') {
        const self = this;
        this._heartTimer = setInterval(function () { self._pumpHeart(); }, 100);
      } else if (level <= 0.02 && this._heartTimer) {
        clearInterval(this._heartTimer);
        this._heartTimer = null;
      }
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* internals: context + graph                                           */
  /* ------------------------------------------------------------------ */

  _now() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now() * 0.001;
    }
    return Date.now() * 0.001;
  }

  _live() {
    return !!(this._ok && this.ctx && (this._offline || this.ctx.state === 'running'));
  }

  _initContext(injected) {
    let ctx = injected || null;
    if (ctx) {
      this._offline = true;
    } else {
      if (typeof window === 'undefined' || !window) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
    }
    this.ctx = ctx;
    this._buildGraph();
    this._ok = true;
    this._applyMode(true);
    this._loadWorklet();
  }

  _gain(v) {
    const n = this.ctx.createGain();
    n.gain.value = v;
    return n;
  }

  _biquad(type, freq, q, gainDb) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q != null) f.Q.value = q;
    if (gainDb != null) f.gain.value = gainDb;
    return f;
  }

  _buildGraph() {
    const ctx = this.ctx;
    const sr = ctx.sampleRate || 44100;

    // --- shared buffers -------------------------------------------------
    const nLen = Math.floor(sr * 2);
    this._noiseBuf = ctx.createBuffer(1, nLen, sr);
    const nd = this._noiseBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) nd[i] = Math.random() * 2 - 1;

    // slow random walk (-1..1) used as pitch jitter for the voice
    const jLen = Math.floor(sr * 3);
    this._jitterBuf = ctx.createBuffer(1, jLen, sr);
    const jd = this._jitterBuf.getChannelData(0);
    const step = Math.max(1, Math.floor(sr / 45));
    let a = 0, b = Math.random() * 2 - 1;
    for (let i = 0; i < jLen; i++) {
      const ph = i % step;
      if (ph === 0) { a = b; b = Math.random() * 2 - 1; }
      const u = ph / step;
      jd[i] = a + (b - a) * (u * u * (3 - 2 * u));
    }
    // make the loop seamless
    for (let i = 0; i < step; i++) jd[jLen - step + i] *= 1 - i / step;

    // --- master ---------------------------------------------------------
    this.master = this._gain(0.9);
    this.muteGain = this._gain(this.muted ? 0 : 1);
    let comp = null;
    try {
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 10;
      comp.ratio.value = 8;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
    } catch (e) { comp = null; }
    if (comp) { this.master.connect(comp); comp.connect(this.muteGain); }
    else this.master.connect(this.muteGain);
    this.muteGain.connect(ctx.destination);

    // --- reverb (neo) ---------------------------------------------------
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this._makeImpulse(3.2);
    this.revOut = this._gain(0.85);
    this.convolver.connect(this.revOut);
    this.revOut.connect(this.master);

    // --- sfx bus --------------------------------------------------------
    this.sfxBus = this._gain(1);
    this.sfxRetro = this._gain(1);
    this.sfxNeo = this._gain(0);
    this.sfxRev = this._gain(0.22);
    this.crushS = this._makeCrusher(6, 11025);
    const sfxPost = this._biquad('lowpass', 7500, 0.5);
    this.sfxBus.connect(this.sfxRetro);
    this.sfxRetro.connect(this.crushS.input);
    this.crushS.output.connect(sfxPost);
    sfxPost.connect(this.master);
    this.sfxBus.connect(this.sfxNeo);
    this.sfxNeo.connect(this.master);
    this.sfxNeo.connect(this.sfxRev);
    this.sfxRev.connect(this.convolver);

    // --- ambience bus (dread drone / heartbeat) --------------------------
    this.ambBus = this._gain(1);
    this.ambRev = this._gain(0);
    this.ambBus.connect(this.master);
    this.ambBus.connect(this.ambRev);
    this.ambRev.connect(this.convolver);

    // --- voice bus ------------------------------------------------------
    this.voiceBus = this._gain(1);
    this._fftSize = 1024;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = this._fftSize;
    this.analyser.smoothingTimeConstant = 0.55;
    try { this.analyser.minDecibels = -85; this.analyser.maxDecibels = -22; } catch (e) { /* ignore */ }
    this.voiceBus.connect(this.analyser);
    const sink = this._gain(0);           // keep the analyser pulled in every browser
    this.analyser.connect(sink);
    sink.connect(ctx.destination);

    this.voiceVol = this._gain(1);        // distance attenuation
    this.voiceVol.connect(this.master);
    this.voiceRev = this._gain(0);
    this.voiceVol.connect(this.voiceRev);
    this.voiceRev.connect(this.convolver);

    // leveller so both paths get a hot, consistent signal
    let lev = null;
    try {
      lev = ctx.createDynamicsCompressor();
      lev.threshold.value = -26;
      lev.knee.value = 8;
      lev.ratio.value = 6;
      lev.attack.value = 0.003;
      lev.release.value = 0.12;
    } catch (e) { lev = null; }
    const levOut = this._gain(1);
    if (lev) { this.voiceBus.connect(lev); lev.connect(levOut); }
    else this.voiceBus.connect(levOut);

    // retro path: band-limit like a cheap DAC, then crush to low-rate PCM
    this.voiceRetro = this._gain(1);
    const rHp = this._biquad('highpass', 170, 0.7);
    const rPk = this._biquad('peaking', 2100, 0.8, 5);
    const rLp = this._biquad('lowpass', 3300, 0.7);
    this.crushV = this._makeCrusher(6, 6000);
    const rPost = this._biquad('lowpass', 4600, 0.6);
    const rOut = this._gain(1.0);
    levOut.connect(this.voiceRetro);
    this.voiceRetro.connect(rHp); rHp.connect(rPk); rPk.connect(rLp);
    rLp.connect(this.crushV.input);
    this.crushV.output.connect(rPost); rPost.connect(rOut); rOut.connect(this.voiceVol);

    // neo path: low shelf weight, centre + chorused Haas sides for width
    this.voiceNeo = this._gain(0);
    const nShelf = this._biquad('lowshelf', 150, null, 5);
    const nAir = this._biquad('highshelf', 3200, null, 3);
    levOut.connect(this.voiceNeo);
    this.voiceNeo.connect(nShelf); nShelf.connect(nAir);
    const mid = this._gain(0.85);
    nAir.connect(mid); mid.connect(this.voiceVol);
    const dL = ctx.createDelay(0.1), dR = ctx.createDelay(0.1);
    dL.delayTime.value = 0.011; dR.delayTime.value = 0.023;
    const lfoL = ctx.createOscillator(), lfoR = ctx.createOscillator();
    lfoL.frequency.value = 0.23; lfoR.frequency.value = 0.31;
    const lgL = this._gain(0.003), lgR = this._gain(0.004);
    lfoL.connect(lgL); lgL.connect(dL.delayTime);
    lfoR.connect(lgR); lgR.connect(dR.delayTime);
    lfoL.start(0); lfoR.start(0);
    const merger = ctx.createChannelMerger(2);
    nAir.connect(dL); nAir.connect(dR);
    dL.connect(merger, 0, 0); dR.connect(merger, 0, 1);
    const side = this._gain(0.6);
    merger.connect(side); side.connect(this.voiceVol);

    // neo sub layer (fed directly by the utterance's sub oscillator)
    this.voiceSub = this._gain(0);
    this.voiceSub.connect(this.voiceVol);

    // --- thrust ---------------------------------------------------------
    const tn = ctx.createBufferSource();
    tn.buffer = this._noiseBuf; tn.loop = true;
    this.thrustFilter = this._biquad('bandpass', 300, 0.9);
    this.thrustGain = this._gain(0);
    tn.connect(this.thrustFilter); this.thrustFilter.connect(this.thrustGain);
    this.thrustGain.connect(this.sfxBus);
    tn.start(0);
    this.rumbleOsc = ctx.createOscillator();
    this.rumbleOsc.type = 'sawtooth';
    this.rumbleOsc.frequency.value = 44;
    const rumLp = this._biquad('lowpass', 240, 0.7);
    this.rumbleGain = this._gain(0);
    this.rumbleOsc.connect(rumLp); rumLp.connect(this.rumbleGain);
    this.rumbleGain.connect(this.sfxBus);
    this.rumbleOsc.start(0);

    // --- dread drone ----------------------------------------------------
    this.droneA = ctx.createOscillator();
    this.droneB = ctx.createOscillator();
    this.droneC = ctx.createOscillator();
    this.droneA.frequency.value = 41.2;    // E1
    this.droneB.frequency.value = 43.65;   // F1 — minor-second beating
    this.droneC.frequency.value = 82.6;
    this.droneC.type = 'sine';
    this.droneFilter = this._biquad('lowpass', 100, 2.5);
    const dMix = this._gain(1);
    const dgA = this._gain(0.5), dgB = this._gain(0.42), dgC = this._gain(0.3);
    this.droneA.connect(dgA); this.droneB.connect(dgB); this.droneC.connect(dgC);
    dgA.connect(dMix); dgB.connect(dMix); dgC.connect(dMix);
    dMix.connect(this.droneFilter);
    const trem = this._gain(0.8);
    this.droneLfo = ctx.createOscillator();
    this.droneLfo.frequency.value = 0.4;
    const tremDepth = this._gain(0.2);
    this.droneLfo.connect(tremDepth); tremDepth.connect(trem.gain);
    this.droneFilter.connect(trem);
    this.droneGain = this._gain(0);
    trem.connect(this.droneGain);
    this.droneGain.connect(this.ambBus);
    this.droneA.start(0); this.droneB.start(0); this.droneC.start(0); this.droneLfo.start(0);
  }

  _applyMode(immediate) {
    if (!this._ok) return;
    const neo = this.mode === 'MODE_NEO';
    const t = this.ctx.currentTime;
    const set = (param, v) => {
      if (immediate) param.value = v;
      else { param.cancelScheduledValues(t); param.setTargetAtTime(v, t, 0.02); }
    };
    set(this.voiceRetro.gain, neo ? 0 : 1);
    set(this.voiceNeo.gain, neo ? 1 : 0);
    set(this.voiceSub.gain, neo ? 1 : 0);
    set(this.voiceRev.gain, neo ? 0.55 : 0);
    set(this.sfxRetro.gain, neo ? 0 : 1);
    set(this.sfxNeo.gain, neo ? 0.9 : 0);
    set(this.ambRev.gain, neo ? 0.35 : 0);
    try {
      this.droneA.type = neo ? 'sawtooth' : 'square';
      this.droneB.type = neo ? 'sawtooth' : 'triangle';
      this.rumbleOsc.type = neo ? 'sawtooth' : 'square';
    } catch (e) { /* ignore */ }
  }

  /** stereo impulse: early reflections + dark, exponentially decaying noise tail */
  _makeImpulse(seconds) {
    const ctx = this.ctx, sr = ctx.sampleRate || 44100;
    const len = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, len, sr);
    const pre = Math.floor(sr * 0.018);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / sr;
        const env = Math.exp(-t * (6.9 / (seconds * 0.9)));
        // tail gets darker over time
        const k = 0.55 * Math.exp(-t * 1.6) + 0.06;
        lp += ((Math.random() * 2 - 1) - lp) * k;
        d[i] = lp * env * 1.6;
      }
      for (let r = 0; r < 9; r++) {     // discrete early reflections
        const at = pre + Math.floor(sr * (0.006 + Math.random() * 0.085));
        if (at < len) d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.7 - r * 0.06);
      }
    }
    // normalise energy so the reverb level is predictable
    let e = 0;
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) e += d[i] * d[i]; }
    const norm = e > 0 ? 1 / Math.sqrt(e / 2) : 1;
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] *= norm; }
    return buf;
  }

  /* ---- bit-crusher / sample-rate reducer ------------------------------ */

  _makeCrusher(bits, rateHz) {
    const ctx = this.ctx;
    const c = {
      input: this._gain(1), output: this._gain(1), node: null, kind: 'none',
      bits: bits, hold: Math.max(1, (ctx.sampleRate || 44100) / rateHz)
    };
    c.set = function (node, kind) {
      try { c.input.disconnect(); } catch (e) { /* ignore */ }
      if (c.node) {
        try { c.node.disconnect(); } catch (e) { /* ignore */ }
        if (c.node.onaudioprocess) c.node.onaudioprocess = null;
      }
      c.node = node; c.kind = kind;
      c.input.connect(node);
      node.connect(c.output);
    };
    this._crushers = this._crushers || [];
    this._crushers.push(c);
    // If a worklet is on its way use the instant WaveShaper staircase meanwhile;
    // otherwise go straight to the best available fallback.
    if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function') {
      this._crusherShaper(c);
    } else if (!this._crusherScript(c)) {
      this._crusherShaper(c);
    }
    return c;
  }

  /** fallback 2: WaveShaper staircase (bit depth only, no rate reduction) */
  _crusherShaper(c) {
    const ws = this.ctx.createWaveShaper();
    const n = 4096, curve = new Float32Array(n);
    const levels = Math.pow(2, c.bits - 1);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(x * levels) / levels;
    }
    ws.curve = curve;
    try { ws.oversample = 'none'; } catch (e) { /* ignore */ }
    c.set(ws, 'waveshaper');
  }

  /** fallback 1: ScriptProcessor sample-and-hold + quantiser */
  _crusherScript(c) {
    const ctx = this.ctx;
    if (typeof ctx.createScriptProcessor !== 'function') return false;
    try {
      const sp = ctx.createScriptProcessor(1024, 2, 2);
      const levels = Math.pow(2, c.bits - 1), hold = c.hold;
      const held = [0, 0];
      let phase = 0;
      sp.onaudioprocess = function (ev) {
        const ib = ev.inputBuffer, ob = ev.outputBuffer;
        const chans = ob.numberOfChannels;
        let p = phase;
        for (let ch = 0; ch < chans; ch++) {
          const inp = ib.getChannelData(Math.min(ch, ib.numberOfChannels - 1));
          const out = ob.getChannelData(ch);
          let h = held[ch] || 0;
          p = phase;
          for (let i = 0; i < out.length; i++) {
            p += 1;
            if (p >= hold) {
              p -= hold;
              let x = inp[i];
              if (x > 1) x = 1; else if (x < -1) x = -1;
              h = Math.round(x * levels) / levels;
            }
            out[i] = h;
          }
          held[ch] = h;
        }
        phase = p;
      };
      c.set(sp, 'scriptprocessor');
      return true;
    } catch (e) {
      return false;
    }
  }

  /** preferred: AudioWorklet registered from a Blob URL */
  _loadWorklet() {
    const ctx = this.ctx;
    this._workletReady = null;
    const self = this;
    const fallback = function () {
      const list = self._crushers || [];
      for (let i = 0; i < list.length; i++) {
        if (list[i].kind !== 'worklet' && list[i].kind !== 'scriptprocessor') {
          try { self._crusherScript(list[i]); } catch (e) { /* keep waveshaper */ }
        }
      }
    };
    try {
      if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function' ||
          typeof Blob === 'undefined' || typeof URL === 'undefined' ||
          typeof URL.createObjectURL !== 'function' || typeof AudioWorkletNode === 'undefined') {
        fallback();
        return;
      }
      const blob = new Blob([AudioSynthMatrix.CRUSHER_WORKLET], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      this._workletReady = ctx.audioWorklet.addModule(url).then(function () {
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        const list = self._crushers || [];
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          const node = new AudioWorkletNode(ctx, 'grimalkin-crusher', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2]
          });
          node.parameters.get('bits').value = c.bits;
          node.parameters.get('hold').value = c.hold;
          c.set(node, 'worklet');
        }
        return true;
      }).catch(function () {
        fallback();
        return false;
      });
    } catch (e) {
      fallback();
    }
  }

  /* ------------------------------------------------------------------ */
  /* internals: voice                                                     */
  /* ------------------------------------------------------------------ */

  _glottalWave() {
    if (this._glottal) return this._glottal;
    // Pulse-like source: all harmonics in sine phase with ~ -7.5 dB/oct tilt.
    const n = 72;
    const real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
    for (let h = 1; h <= n; h++) imag[h] = 1 / Math.pow(h, 1.25);
    this._glottal = this.ctx.createPeriodicWave(real, imag);
    return this._glottal;
  }

  /** schedule keyframes [[time, value], ...] as linear ramps (monotonic-safe) */
  _sched(param, keys, mul) {
    if (mul == null) mul = 1;
    let last = 0;
    for (let i = 0; i < keys.length; i++) {
      let t = keys[i][0];
      const v = keys[i][1] * mul;
      if (i === 0) {
        param.setValueAtTime(v, t);
      } else {
        if (t < last + 0.0005) t = last + 0.0005;
        param.linearRampToValueAtTime(v, t);
      }
      last = t;
    }
  }

  _cutVoice() {
    const u = this._utt;
    this._utt = null;
    if (!u || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      const fade = (g) => {
        g.gain.cancelScheduledValues(t);
        g.gain.setTargetAtTime(0, t, 0.012);
      };
      fade(u.out); fade(u.sub);
      for (let i = 0; i < u.sources.length; i++) {
        try { u.sources[i].stop(t + 0.09); } catch (e) { /* already stopped */ }
      }
    } catch (e) { /* ignore */ }
  }

  /**
   * Build and schedule one utterance on the audio graph.
   * Returns the lead-in (seconds) before the first sample.
   */
  _speak(comp, volume) {
    const ctx = this.ctx;
    const lead = 0.05;
    const T = ctx.currentTime + lead;
    const S = comp.segs, line = comp.line;
    const neo = this.mode === 'MODE_NEO';
    const f0 = (neo ? 72 : 84) * (line.pitch || 1);   // deep: ~70..95 Hz with contour
    const fs = neo ? 0.86 : 0.92;                      // vocal-tract scale (bigger beast in neo)
    const end = T + comp.dur;
    const self = this;

    // key builders ------------------------------------------------------
    const keysFor = function (inFn, outFn, trFn) {
      const k = [[T, inFn(S[0])]];
      for (let i = 0; i < S.length; i++) {
        const s = S[i], st = T + s.t0;
        if (i > 0) {
          const p = S[i - 1];
          const tr = Math.min(trFn(s), s.d, p.d);
          k.push([st - tr * 0.5, outFn(p)]);
          k.push([st + tr * 0.5, inFn(s)]);
        }
        const vi = inFn(s), vo = outFn(s);
        if (vi !== vo) {
          k.push([st + s.d * 0.3, vi]);
          k.push([st + s.d * 0.88, vo]);
        }
      }
      return k;
    };
    const trF = function (s) { return s.tr; };
    const trA = function (s) { return s.ta; };
    const flat = function (name) {
      const fn = function (s) { return s[name]; };
      return keysFor(fn, fn, trA);
    };

    // output ---------------------------------------------------------------
    const out = ctx.createGain();
    out.gain.value = 2.4;
    out.connect(this.voiceBus);
    const sub = ctx.createGain();
    sub.gain.value = 1;
    sub.connect(this.voiceSub);

    this.voiceVol.gain.cancelScheduledValues(ctx.currentTime);
    this.voiceVol.gain.setValueAtTime(volume, ctx.currentTime);

    // sources ----------------------------------------------------------------
    const sources = [];
    const osc = function (type) {
      const o = ctx.createOscillator();
      if (type === 'glottal') o.setPeriodicWave(self._glottalWave());
      else o.type = type;
      sources.push(o);
      return o;
    };
    const oscA = osc('glottal'), oscB = osc('glottal'), oscS = osc('sawtooth');
    const growl = osc('sine'), rough = osc('triangle'), subOsc = osc('sine'), subOsc2 = osc('sine');

    // pitch contour: targets at phoneme centres (or in/out glides) with declination
    const decl = line.decl == null ? 0.07 : line.decl;
    const pk = [[T, f0 * S[0].pm]];
    for (let i = 0; i < S.length; i++) {
      const s = S[i], st = T + s.t0;
      const d0 = 1 - decl * (s.t0 / comp.dur), d1 = 1 - decl * ((s.t0 + s.d) / comp.dur);
      if (s.pmEnd != null && s.pmEnd !== s.pm) {
        pk.push([st + s.d * 0.12, f0 * s.pm * d0]);
        pk.push([st + s.d * 0.92, f0 * s.pmEnd * d1]);
      } else {
        pk.push([st + s.d * 0.5, f0 * s.pm * (d0 + d1) * 0.5]);
      }
    }
    this._sched(oscA.frequency, pk, 1);
    this._sched(oscB.frequency, pk, 1.0065);     // slow beating = thickness
    this._sched(oscS.frequency, pk, 0.5);        // octave-down sawtooth
    this._sched(growl.frequency, pk, 0.5);       // sub-harmonic AM (vocal fry growl)
    this._sched(subOsc.frequency, pk, 1);
    this._sched(subOsc2.frequency, pk, 0.5);
    rough.frequency.value = line.roughHz || 29;

    // jitter
    const jit = ctx.createBufferSource();
    jit.buffer = this._jitterBuf; jit.loop = true;
    sources.push(jit);
    const jitG = this._gain((neo ? 30 : 22) * (line.jitter || 1));   // cents
    jit.connect(jitG);
    jitG.connect(oscA.detune); jitG.connect(oscB.detune); jitG.connect(oscS.detune);
    jitG.connect(growl.detune);

    // glottal mix + growl AM
    const mix = this._gain(1);
    const gA = this._gain(0.55), gB = this._gain(0.4), gS = this._gain(0.3);
    oscA.connect(gA); oscB.connect(gB); oscS.connect(gS);
    gA.connect(mix); gB.connect(mix); gS.connect(mix);
    const am = this._gain(1);
    mix.connect(am);
    const growlG = this._gain(line.growl == null ? (neo ? 0.42 : 0.32) : line.growl);
    growl.connect(growlG); growlG.connect(am.gain);
    const roughG = this._gain(0);
    rough.connect(roughG); roughG.connect(am.gain);
    this._sched(roughG.gain, flat('ro'));

    const vAmp = this._gain(0);               // voicing amplitude
    am.connect(vAmp);
    this._sched(vAmp.gain, flat('av'));

    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuf; noise.loop = true;
    sources.push(noise);
    const aAmp = this._gain(0);               // aspiration (noise through the formants)
    noise.connect(aAmp);
    this._sched(aAmp.gain, flat('ah'));

    const fIn = this._gain(1);
    vAmp.connect(fIn); aAmp.connect(fIn);

    // 5 parallel formant resonators, alternating polarity -----------------
    const Q = [5.5, 11, 14, 12, 10];
    const AMP = [1.0, 1.0, 0.78, 0.42, 0.24];
    const fixed = [0, 0, 0, 3350 * fs, 4150 * fs];
    for (let k = 0; k < 5; k++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = Q[k];
      if (k < 3) {
        const idx = k;
        this._sched(bp.frequency, keysFor(
          function (s) { return s.f[idx]; },
          function (s) { return (s.g || s.f)[idx]; }, trF), fs);
      } else {
        bp.frequency.value = fixed[k];
      }
      const g = this._gain(0);
      const base = AMP[k] * (k % 2 ? -1 : 1);
      if (k === 0) {
        const fn = function (s) { return s.a1; };
        this._sched(g.gain, keysFor(fn, fn, trA), base);
      } else {
        const fn = function (s) { return s.hi; };
        this._sched(g.gain, keysFor(fn, fn, trA), base);
      }
      fIn.connect(bp); bp.connect(g); g.connect(out);
    }

    // nasal / voice-bar / chest bypass ------------------------------------
    const nLp = this._biquad('lowpass', 300 * fs, 0.9);
    const nAmp = this._gain(0);
    vAmp.connect(nLp); nLp.connect(nAmp); nAmp.connect(out);
    this._sched(nAmp.gain, flat('an'));

    // frication + stop bursts (bypass the formants) -------------------------
    const fBp = ctx.createBiquadFilter();
    fBp.type = 'bandpass';
    const fHp = this._biquad('highpass', 700, 0.5);
    const fAmp = this._gain(0);
    noise.connect(fBp); fBp.connect(fHp); fHp.connect(fAmp); fAmp.connect(out);
    this._sched(fAmp.gain, flat('af'));
    let first = true;
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (!(s.af > 0)) continue;
      let ff = s.ff;
      if (!neo && ff > 3000) ff = Math.max(3000, ff * 0.62);   // keep sibilance inside the chip's band
      const at = first ? T : Math.max(T, T + s.t0 - 0.012);
      fBp.frequency.setValueAtTime(ff, at);
      fBp.Q.setValueAtTime(s.fq, at);
      first = false;
    }

    // neo sub layer: pure fundamental + octave below, follows voicing -------
    const sMix = this._gain(0);
    const s1 = this._gain(0.5), s2 = this._gain(0.42);
    subOsc.connect(s1); subOsc2.connect(s2);
    s1.connect(sMix); s2.connect(sMix);
    this._sched(sMix.gain, flat('av'), 0.5);
    const sLp = this._biquad('lowpass', 190, 0.7);
    sMix.connect(sLp); sLp.connect(sub);

    // go --------------------------------------------------------------------
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (s === noise) s.start(T, Math.random() * 1.5);
      else if (s === jit) s.start(T, Math.random() * 2.5);
      else s.start(T);
      s.stop(end + 0.12);
    }
    const utt = { out: out, sub: sub, sources: sources, end: end };
    oscA.onended = function () {
      try { out.disconnect(); sub.disconnect(); } catch (e) { /* ignore */ }
      if (self._utt === utt) self._utt = null;
    };
    this._utt = utt;
    return lead;
  }

  _analyserLevel() {
    const a = this.analyser, n = this._fftSize;
    let rms = 0;
    if (typeof a.getFloatTimeDomainData === 'function') {
      if (!this._timeBuf || this._timeBuf.length !== n) this._timeBuf = new Float32Array(n);
      a.getFloatTimeDomainData(this._timeBuf);
      let s = 0;
      for (let i = 0; i < n; i++) s += this._timeBuf[i] * this._timeBuf[i];
      rms = Math.sqrt(s / n);
    } else {
      if (!this._timeBufB || this._timeBufB.length !== n) this._timeBufB = new Uint8Array(n);
      a.getByteTimeDomainData(this._timeBufB);
      let s = 0;
      for (let i = 0; i < n; i++) { const v = (this._timeBufB[i] - 128) / 128; s += v * v; }
      rms = Math.sqrt(s / n);
    }
    if (!(rms > 0.0015)) return 0;
    // self-calibrating: normalise against the recent loudest frame
    this._agc = Math.max(this._agc * 0.9985, rms, 0.012);
    return Math.min(1, Math.pow(rms / this._agc, 0.8) * 1.05);
  }

  _segAt(t) {
    const c = this._speakComp;
    if (!c || t < 0 || t > c.dur) return null;
    const S = c.segs;
    for (let i = 0; i < S.length; i++) {
      if (t < S[i].t0 + S[i].d) return S[i];
    }
    return null;
  }

  /** envelope derived from the phoneme timeline (used when no audio is running) */
  _synthLevel(now) {
    const t = now - this._speakStart;
    const s = this._segAt(t);
    if (!s) return 0;
    const wob = 0.82 + 0.18 * Math.sin(t * 43) * Math.sin(t * 17.3 + 1);
    return Math.min(1, s.lvl * wob);
  }

  /* ------------------------------------------------------------------ */
  /* internals: sfx primitives                                            */
  /* ------------------------------------------------------------------ */

  _track(o, src, tail) {
    o._n = (o._n || 0) + 1;
    src.onended = function () {
      try { tail.disconnect(); } catch (e) { /* ignore */ }
      o._n -= 1;
      if (o._n <= 0) {
        try { o.disconnect(); if (o._tail) o._tail.disconnect(); } catch (e) { /* ignore */ }
      }
    };
  }

  /** oscillator blip: exponential sweep f0->f1, attack `atk`, optional hold fraction, exp decay */
  _tone(o, type, f0, f1, t, dur, peak, atk, hold) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    f0 = Math.max(8, f0); f1 = Math.max(8, f1);
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    atk = Math.min(atk == null ? 0.003 : atk, dur * 0.9);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    if (hold > 0) g.gain.setValueAtTime(peak, t + Math.max(atk, dur * Math.min(0.95, hold)));
    g.gain.exponentialRampToValueAtTime(0.0002, t + dur);
    osc.connect(g); g.connect(o);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    this._track(o, osc, g);
    return osc;
  }

  /** filtered noise hit with a filter sweep */
  _noise(o, ftype, f0, f1, q, t, dur, peak, atk, hold) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = ftype;
    f0 = Math.max(20, f0); f1 = Math.max(20, f1);
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    atk = Math.min(atk == null ? 0.002 : atk, dur * 0.9);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    if (hold > 0) g.gain.setValueAtTime(peak, t + Math.max(atk, dur * Math.min(0.95, hold)));
    g.gain.exponentialRampToValueAtTime(0.0002, t + dur);
    src.connect(f); f.connect(g); g.connect(o);
    src.start(t, Math.random() * 1.8);
    src.stop(t + dur + 0.03);
    this._track(o, src, g);
    return src;
  }

  /** one explosion: filtered noise body + sine thump */
  _boom(o, t, size, p) {
    this._noise(o, 'lowpass', 2600 + 3200 * size, 90 + 120 * (1 - size), 0.8, t, 0.22 + 0.7 * size, 0.5 + 0.25 * size, 0.002);
    this._tone(o, 'sine', (150 - 50 * size) * p, (46 - 20 * size) * p, t, 0.2 + 0.6 * size, 0.55, 0.002);
    this._tone(o, 'square', (90 - 30 * size) * p, 30 * p, t, 0.1 + 0.2 * size, 0.18, 0.001);
  }

  /* ---- heartbeat ------------------------------------------------------ */

  _pumpHeart() {
    if (!(this._dread > 0.02) || !this._live()) { this._nextBeat = 0; return; }
    const now = this.ctx.currentTime;
    const bpm = 46 + this._dread * 118;           // tempo rises with dread
    const interval = 60 / bpm;
    if (this._nextBeat < now - 0.5 || this._nextBeat === 0) this._nextBeat = now + 0.06;
    let guard = 0;
    while (this._nextBeat < now + 0.25 && guard++ < 8) {
      if (this._nextBeat >= now) this._beat(this._nextBeat, this._dread, interval);
      this._nextBeat += interval;
    }
  }

  _beat(t, level, interval) {
    const neo = this.mode === 'MODE_NEO';
    const ctx = this.ctx;
    const o = ctx.createGain();
    o.gain.value = 0.3 + 0.55 * level;
    o.connect(neo ? this.ambBus : this.sfxBus);
    const gap = Math.min(0.2, Math.max(0.1, interval * 0.3));
    if (neo) {
      this._tone(o, 'sine', 74, 36, t, 0.16, 0.8, 0.004);
      this._tone(o, 'sine', 62, 32, t + gap, 0.14, 0.55, 0.004);
      this._noise(o, 'lowpass', 400, 80, 0.7, t, 0.05, 0.15, 0.002);
    } else {
      this._tone(o, 'triangle', 96, 44, t, 0.13, 0.9, 0.003);
      this._tone(o, 'triangle', 80, 40, t + gap, 0.11, 0.62, 0.003);
    }
  }

  /* ------------------------------------------------------------------ */
  /* static: phoneme compiler (pure — works headless)                     */
  /* ------------------------------------------------------------------ */

  static _clamp01(v) {
    v = Number(v);
    if (v !== v) return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /**
   * Expand a hand-authored phoneme line into timed synthesis segments.
   * Token: [phoneme, ms, pitchMul?, pitchMulEnd?, overrides?]
   */
  static compileLine(key) {
    const cache = AudioSynthMatrix._compiled || (AudioSynthMatrix._compiled = {});
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    const LINES = AudioSynthMatrix.LINES;
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(LINES, key)) return null;
    const line = LINES[key], P = AudioSynthMatrix.PHONEMES;
    const rate = line.rate || 1;
    const baseRo = line.rough == null ? 0.1 : line.rough;
    const segs = [];
    let pm = 1;
    const seg = function (o) {
      const s = {
        name: o.name, d: o.d, f: o.f || null, g: o.g || null,
        av: o.av || 0, ah: o.ah || 0, af: o.af || 0, ff: o.ff || 4000, fq: o.fq || 1,
        an: o.an || 0, hi: o.hi == null ? 1 : o.hi, a1: o.a1 == null ? 1 : o.a1,
        tr: o.tr == null ? 0.045 : o.tr, ta: 0,
        pm: o.pm, pmEnd: o.pmEnd == null ? null : o.pmEnd, ro: o.ro == null ? baseRo : o.ro
      };
      s.ta = o.ta == null ? Math.min(s.tr, 0.028) : o.ta;
      segs.push(s);
      return s;
    };
    for (let i = 0; i < line.seq.length; i++) {
      const tok = line.seq[i];
      const def = P[tok[0]];
      if (!def) continue;
      const d = Math.max(0.01, tok[1] * 0.001 * rate);
      if (typeof tok[2] === 'number') pm = tok[2];
      const pmEnd = typeof tok[3] === 'number' ? tok[3] : null;
      const ov = tok[4] || null;
      if (def.stop) {
        const bd = def.bd, ad = def.ad;
        const cl = Math.max(0.03, d - bd - ad);
        seg({ name: tok[0] + ':closure', d: cl, f: def.loc, av: def.vb ? 0.1 : 0, an: def.vb ? 0.5 : 0,
              hi: 0.15, a1: 0.5, tr: 0.03, ta: 0.014, pm: pm });
        seg({ name: tok[0] + ':burst', d: bd, f: def.loc, av: def.vb ? 0.1 : 0, af: def.ba, ff: def.bf,
              fq: def.bq, ah: def.vb ? 0 : 0.1, tr: 0.01, ta: 0.003, pm: pm });
        if (ad > 0) {
          seg({ name: tok[0] + ':asp', d: ad, f: def.loc, ah: def.aa, af: def.ba * 0.15, ff: def.bf,
                fq: def.bq, tr: 0.012, ta: 0.006, pm: pm });
        }
      } else {
        const s = seg({
          name: tok[0], d: d, f: def.f, g: def.g, av: def.av, ah: def.ah, af: def.af, ff: def.ff,
          fq: def.fq, an: def.an == null ? (def.av > 0.7 ? 0.14 : 0) : def.an, hi: def.hi, a1: def.a1,
          tr: (def.tr || 45) * 0.001, pm: pm, pmEnd: pmEnd
        });
        if (ov) { for (const k in ov) if (Object.prototype.hasOwnProperty.call(ov, k)) s[k] = ov[k]; }
        if (pmEnd != null) pm = pmEnd;
      }
    }
    if (!segs.length) return null;
    // tail of silence so every amplitude envelope closes
    seg({ name: '_', d: 0.07, tr: 0.05, ta: 0.05, pm: pm });

    // formant-less segments (pauses, /h/) borrow their neighbours' shape
    const neutral = [500, 1500, 2500];
    for (let i = segs.length - 1; i >= 0; i--) {
      if (!segs[i].f) segs[i].f = (i + 1 < segs.length && segs[i + 1].f) ? segs[i + 1].f : null;
    }
    for (let i = 0; i < segs.length; i++) {
      if (!segs[i].f) segs[i].f = i > 0 ? (segs[i - 1].g || segs[i - 1].f) : neutral;
    }
    // a transition into a segment that follows a stop piece is fast
    let t = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      s.t0 = t; t += s.d;
      s.lvl = Math.min(1, s.av * 0.95 + s.af * 0.7 + s.ah * 0.5 + (s.av > 0 ? 0 : s.an * 0.3));
      const f2 = s.f[1];
      s.bands = [
        Math.min(1, s.av * 0.8 + s.an * 0.4),
        Math.min(1, s.av * s.hi * (f2 > 1500 ? 0.75 : 0.5) + s.ah * 0.4),
        Math.min(1, s.af * 1.4 + s.ah * 0.5 + s.av * s.hi * (f2 > 1800 ? 0.35 : 0.12))
      ];
    }
    const comp = { key: key, line: line, segs: segs, dur: t };
    cache[key] = comp;
    return comp;
  }
}

/* -------------------------------------------------------------------- */
/* static data                                                            */
/* -------------------------------------------------------------------- */

AudioSynthMatrix.TAUNTS = {
  AWAKE: 'I am awake',
  HUNGER: 'Feed me',
  RUN: 'Run, little mouse',
  NAME: 'I am Grimalkin',
  ROAR: '<wordless yowl-roar>',
  DEATH: 'Nine lives... gone'
};

/*
 * Phoneme inventory. f = [F1, F2, F3] targets in Hz for an adult male tract
 * (scaled down at speak time for a much larger throat); g = diphthong off-glide.
 *   av voicing amp · ah aspiration amp · af frication amp · ff/fq frication band
 *   an nasal/chest low-pass bypass · hi upper-formant (F2..F5) level · a1 F1 level
 *   tr transition time into the phoneme (ms)
 * Stops: loc = formant locus, vb = voiced, bf/bq/ba/bd = burst freq/Q/amp/dur,
 *        ad/aa = aspiration dur/amp.
 */
AudioSynthMatrix.PHONEMES = {
  // vowels
  IY: { f: [270, 2290, 3010], av: 1 },
  IH: { f: [390, 1990, 2550], av: 1 },
  EH: { f: [530, 1840, 2480], av: 1 },
  AE: { f: [660, 1720, 2410], av: 1 },
  AA: { f: [730, 1090, 2440], av: 1 },
  AO: { f: [570, 840, 2410], av: 1 },
  AH: { f: [640, 1190, 2390], av: 1 },
  AX: { f: [500, 1500, 2500], av: 0.8 },
  UH: { f: [440, 1020, 2240], av: 1 },
  UW: { f: [300, 870, 2240], av: 0.95 },
  ER: { f: [490, 1350, 1690], av: 0.95 },
  // diphthongs
  AY: { f: [740, 1150, 2440], g: [400, 1950, 2550], av: 1 },
  EY: { f: [500, 1850, 2480], g: [310, 2200, 2900], av: 1 },
  AW: { f: [750, 1280, 2440], g: [420, 860, 2240], av: 1 },
  OW: { f: [540, 950, 2400], g: [340, 800, 2240], av: 1 },
  // glides + liquids
  W: { f: [290, 610, 2150], av: 0.6, hi: 0.6, tr: 65 },
  R: { f: [320, 1060, 1380], av: 0.66, hi: 0.8, tr: 65 },
  L: { f: [360, 1250, 2800], av: 0.66, hi: 0.7, tr: 45 },
  LL: { f: [450, 820, 2700], av: 0.62, hi: 0.6, tr: 65 },      // dark L
  // nasals
  M: { f: [250, 1000, 2200], av: 0.5, an: 0.95, hi: 0.22, a1: 0.7, tr: 26 },
  N: { f: [250, 1600, 2600], av: 0.5, an: 0.95, hi: 0.3, a1: 0.7, tr: 26 },
  // fricatives
  F: { f: [340, 1100, 2080], av: 0, af: 0.2, ff: 4600, fq: 0.6, tr: 30 },
  V: { f: [300, 1100, 2080], av: 0.42, af: 0.1, ff: 4600, fq: 0.6, an: 0.35, hi: 0.4, tr: 30 },
  S: { f: [320, 1400, 2530], av: 0, af: 0.5, ff: 5800, fq: 2.5, tr: 30 },
  Z: { f: [300, 1400, 2530], av: 0.4, af: 0.28, ff: 5800, fq: 2.5, an: 0.35, hi: 0.4, tr: 30 },
  H: { f: null, av: 0, ah: 0.5, tr: 30 },
  // stops
  D: { stop: 1, loc: [250, 1700, 2600], vb: 1, bf: 3400, bq: 1.2, ba: 0.3, bd: 0.012, ad: 0, aa: 0 },
  T: { stop: 1, loc: [300, 1750, 2650], vb: 0, bf: 3900, bq: 1.2, ba: 0.45, bd: 0.015, ad: 0.04, aa: 0.3 },
  K: { stop: 1, loc: [280, 2000, 2500], vb: 0, bf: 2100, bq: 3, ba: 0.6, bd: 0.025, ad: 0.045, aa: 0.3 },
  G: { stop: 1, loc: [260, 1650, 2150], vb: 1, bf: 1700, bq: 3, ba: 0.4, bd: 0.018, ad: 0, aa: 0 },
  // silence
  _: { f: null, av: 0, tr: 30 }
};

/*
 * Hand-authored phoneme sequences. Token: [phoneme, ms, pitch×, pitchEnd×, overrides].
 * Pitch multipliers apply to the mode's base f0 (84 Hz retro / 72 Hz neo) and
 * carry forward until changed. Delivery is slow and deliberate — it is a very
 * large cat.
 */
AudioSynthMatrix.LINES = {
  // "I am awake"  /aɪ æm əˈweɪk/
  AWAKE: {
    text: AudioSynthMatrix.TAUNTS.AWAKE, rate: 1.08,
    seq: [
      ['AY', 300, 1.04, 1.0], ['_', 30], ['AE', 130, 0.97], ['M', 120, 0.95],
      ['AX', 90, 0.93], ['W', 120, 0.98], ['EY', 380, 1.14, 1.0], ['K', 170, 0.9]
    ]
  },
  // "Feed me"  /fiːd miː/
  HUNGER: {
    text: AudioSynthMatrix.TAUNTS.HUNGER, rate: 1.1,
    seq: [
      ['F', 150, 1.08], ['IY', 320, 1.12, 1.04], ['D', 90, 1.0], ['_', 50],
      ['M', 130, 0.94], ['IY', 420, 0.92, 0.8]
    ]
  },
  // "Run, little mouse"  /rʌn | ˈlɪtəl maʊs/
  RUN: {
    text: AudioSynthMatrix.TAUNTS.RUN, rate: 1.05,
    seq: [
      ['R', 140, 1.0], ['AH', 240, 1.13, 1.06], ['N', 160, 0.98], ['_', 150],
      ['L', 95, 0.98], ['IH', 115, 1.05], ['T', 85, 1.0], ['AX', 55, 0.96], ['LL', 135, 0.93],
      ['M', 115, 0.92], ['AW', 420, 1.02, 0.84], ['S', 250, 0.84]
    ]
  },
  // "I am Grimalkin"  /aɪ æm ɡrɪˈmælkɪn/
  NAME: {
    text: AudioSynthMatrix.TAUNTS.NAME, rate: 1.06,
    seq: [
      ['AY', 270, 1.04, 0.99], ['_', 25], ['AE', 115, 0.96], ['M', 115, 0.94], ['_', 35],
      ['G', 90, 0.95], ['R', 105, 0.97], ['IH', 115, 1.0], ['M', 105, 1.05],
      ['AE', 270, 1.16, 1.06], ['LL', 115, 0.98], ['K', 125, 0.92], ['IH', 150, 0.88], ['N', 240, 0.84, 0.76]
    ]
  },
  // wordless feline yowl-roar: mmRRR-eeAAAOOWW-rrr, pitch arcs up an octave and collapses
  ROAR: {
    text: AudioSynthMatrix.TAUNTS.ROAR, rate: 1, decl: 0, growl: 0.6, rough: 0.5, roughHz: 33, jitter: 1.8,
    seq: [
      ['M', 150, 0.8, 0.82, { ro: 0.5, av: 0.6 }],
      ['R', 230, 0.84, 1.1, { ro: 0.75, ah: 0.2, av: 0.9, hi: 0.9 }],
      ['IY', 170, 1.3, 1.8, { ro: 0.3, ah: 0.2 }],
      ['AE', 430, 1.9, 2.18, { ro: 0.35, ah: 0.35 }],
      ['AA', 540, 2.15, 1.7, { ro: 0.45, ah: 0.4 }],
      ['AO', 430, 1.62, 1.15, { ro: 0.55, ah: 0.35 }],
      ['UW', 300, 1.1, 0.86, { ro: 0.65, ah: 0.25 }],
      ['R', 440, 0.8, 0.6, { ro: 0.85, ah: 0.3, av: 0.8, hi: 0.9 }]
    ]
  },
  // "Nine lives... gone"  /naɪn laɪvz | ɡɔːn/ — slowing, sinking, dying
  DEATH: {
    text: AudioSynthMatrix.TAUNTS.DEATH, rate: 1.18, decl: 0.04, rough: 0.18, jitter: 1.5,
    seq: [
      ['N', 130, 1.0], ['AY', 330, 1.06, 0.98], ['N', 150, 0.96], ['_', 60],
      ['L', 110, 0.94], ['AY', 360, 0.98, 0.9], ['V', 100, 0.88], ['Z', 170, 0.85], ['_', 520],
      ['G', 110, 0.8], ['AO', 540, 0.8, 0.64, { ro: 0.3 }], ['N', 430, 0.62, 0.5, { ro: 0.45 }]
    ]
  }
};

/* minimum seconds between two triggers of the same sfx */
AudioSynthMatrix.SFX_MIN_GAP = {
  shot: 0.035, enemyShot: 0.04, mineTick: 0.05, crystalPop: 0.03, crystalPickup: 0.03,
  explodeSmall: 0.03, explodeBig: 0.06, bossAwake: 0.5, bossDie: 0.5
};

/*
 * SFX table: fn(A, o, t, p)  A = AudioSynthMatrix, o = voice output node,
 * t = start time, p = pitch multiplier.
 */
AudioSynthMatrix.SFX = {
  shot: function (A, o, t, p) {
    A._tone(o, 'square', 940 * p, 200 * p, t, 0.1, 0.3, 0.001);
    A._tone(o, 'sawtooth', 1880 * p, 400 * p, t, 0.05, 0.12, 0.001);
    A._noise(o, 'highpass', 3200, 3200, 0.7, t, 0.025, 0.16, 0.001);
  },
  enemyShot: function (A, o, t, p) {
    A._tone(o, 'sawtooth', 390 * p, 115 * p, t, 0.17, 0.3, 0.002);
    A._tone(o, 'square', 585 * p, 172 * p, t, 0.13, 0.13, 0.002);
    A._noise(o, 'bandpass', 1400, 500, 2, t, 0.05, 0.14, 0.001);
  },
  mineTick: function (A, o, t, p) {
    const f = (1500 + Math.random() * 900) * p;
    A._tone(o, 'triangle', f, f * 0.6, t, 0.035, 0.2, 0.001);
    A._noise(o, 'bandpass', 4200, 2600, 2, t, 0.025, 0.15, 0.001);
  },
  crystalPop: function (A, o, t, p) {
    A._noise(o, 'bandpass', 2400, 5400, 1.5, t, 0.07, 0.3, 0.001);
    A._tone(o, 'sine', 1100 * p, 2300 * p, t, 0.09, 0.26, 0.002);
    A._tone(o, 'triangle', 3300 * p, 3300 * p, t + 0.03, 0.06, 0.1, 0.001);
  },
  crystalPickup: function (A, o, t, p) {
    A._tone(o, 'square', 988 * p, 988 * p, t, 0.07, 0.19, 0.002);
    A._tone(o, 'square', 1319 * p, 1319 * p, t + 0.055, 0.07, 0.19, 0.002);
    A._tone(o, 'square', 1976 * p, 1976 * p, t + 0.11, 0.12, 0.17, 0.002);
  },
  mouseSqueak: function (A, o, t, p) {
    A._tone(o, 'sine', 2900 * p, 4300 * p, t, 0.06, 0.16, 0.003);
    A._tone(o, 'sine', 3300 * p, 4700 * p, t + 0.09, 0.07, 0.14, 0.003);
  },
  bombLaunch: function (A, o, t, p) {
    A._tone(o, 'sawtooth', 130 * p, 740 * p, t, 0.34, 0.3, 0.008, 0.6);
    A._tone(o, 'square', 65 * p, 370 * p, t, 0.34, 0.2, 0.008, 0.6);
    A._noise(o, 'bandpass', 500, 3800, 1.2, t, 0.32, 0.26, 0.04, 0.5);
    A._tone(o, 'sine', 180 * p, 50 * p, t, 0.09, 0.4, 0.001);
  },
  bombHit: function (A, o, t, p) {
    A._boom(o, t, 0.75, p);
    A._tone(o, 'sawtooth', 220 * p, 55 * p, t, 0.3, 0.3, 0.002);
    A._tone(o, 'square', 1320 * p, 330 * p, t, 0.12, 0.16, 0.001);
    A._noise(o, 'bandpass', 3000, 900, 3, t + 0.02, 0.2, 0.2, 0.002);
  },
  explodeSmall: function (A, o, t, p) {
    A._boom(o, t, 0.15, p);
    A._noise(o, 'bandpass', 1800, 600, 1.2, t, 0.12, 0.2, 0.001);
  },
  explodeBig: function (A, o, t, p) {
    A._boom(o, t, 1, p);
    A._noise(o, 'bandpass', 900, 200, 1, t + 0.05, 0.6, 0.3, 0.01);
    for (let i = 0; i < 4; i++) {
      A._noise(o, 'highpass', 2500, 1200, 0.8, t + 0.12 + i * 0.09 + Math.random() * 0.04, 0.06, 0.18 - i * 0.03, 0.001);
    }
  },
  playerDie: function (A, o, t, p) {
    A._boom(o, t, 0.6, p);
    for (let i = 0; i < 11; i++) {
      const f = 990 * Math.pow(0.82, i) * p;
      A._tone(o, 'square', f, f * 0.94, t + 0.05 + i * 0.075, 0.085, 0.22, 0.002, 0.6);
    }
    A._tone(o, 'sawtooth', 600 * p, 34 * p, t, 0.95, 0.22, 0.004, 0.3);
    A._noise(o, 'lowpass', 1500, 100, 0.8, t + 0.85, 0.45, 0.3, 0.01);
  },
  workerDeliver: function (A, o, t, p) {
    A._tone(o, 'triangle', 523 * p, 523 * p, t, 0.08, 0.26, 0.002, 0.5);
    A._tone(o, 'triangle', 392 * p, 392 * p, t + 0.075, 0.08, 0.26, 0.002, 0.5);
    A._tone(o, 'square', 311 * p, 311 * p, t + 0.15, 0.14, 0.16, 0.002, 0.4);
  },
  pieceAttach: function (A, o, t, p) {
    // heavy metallic clank: inharmonic partials + thud + ratchet
    const parts = [311, 827, 1291, 2143];
    for (let i = 0; i < parts.length; i++) {
      A._tone(o, i % 2 ? 'square' : 'triangle', parts[i] * p, parts[i] * p * 0.985, t, 0.34 - i * 0.05, 0.2 - i * 0.03, 0.001);
    }
    A._tone(o, 'sine', 120 * p, 48 * p, t, 0.26, 0.55, 0.002);
    A._noise(o, 'bandpass', 3400, 1800, 1.5, t, 0.05, 0.3, 0.001);
    for (let i = 0; i < 3; i++) A._noise(o, 'highpass', 4000, 4000, 0.7, t + 0.2 + i * 0.045, 0.02, 0.12, 0.001);
  },
  bossAwake: function (A, o, t, p) {
    A._tone(o, 'sawtooth', 36 * p, 150 * p, t, 2.0, 0.34, 0.25, 0.85);
    A._tone(o, 'sawtooth', 36.6 * p, 153 * p, t, 2.0, 0.3, 0.25, 0.85);
    A._tone(o, 'square', 18 * p, 75 * p, t, 2.0, 0.2, 0.25, 0.85);
    A._noise(o, 'lowpass', 180, 4500, 1.5, t, 1.9, 0.3, 1.5, 0.85);
    for (let i = 0; i < 7; i++) {
      A._tone(o, 'square', (1245 + i * 62) * p, (1245 + i * 62) * p, t + i * 0.26, 0.11, 0.13, 0.002, 0.6);
    }
    const s = t + 1.85;
    A._boom(o, s, 1, p);
    A._tone(o, 'sawtooth', 110 * p, 104 * p, s, 1.3, 0.3, 0.004, 0.3);
    A._tone(o, 'sawtooth', 116.5 * p, 110 * p, s, 1.3, 0.28, 0.004, 0.3);
    A._tone(o, 'square', 164.8 * p, 155 * p, s, 1.1, 0.16, 0.004, 0.3);
    A._tone(o, 'sine', 55 * p, 27 * p, s, 1.4, 0.5, 0.004, 0.2);
  },
  bossDie: function (A, o, t, p) {
    const at = [0, 0.33, 0.61, 1.0, 1.28, 1.7, 2.05, 2.3];
    for (let i = 0; i < at.length; i++) A._boom(o, t + at[i], 0.3 + 0.5 * ((i * 7) % 5) / 5, p * (1 - i * 0.04));
    A._tone(o, 'sawtooth', 270 * p, 22 * p, t, 3.0, 0.3, 0.01, 0.6);
    A._tone(o, 'sawtooth', 287 * p, 24 * p, t, 3.0, 0.26, 0.01, 0.6);
    A._tone(o, 'square', 404 * p, 31 * p, t, 2.8, 0.14, 0.01, 0.6);
    const s = t + 2.65;
    A._noise(o, 'lowpass', 7000, 60, 0.8, s, 2.2, 0.75, 0.003);
    A._tone(o, 'sine', 92 * p, 20 * p, s, 1.9, 0.7, 0.003);
    A._tone(o, 'square', 60 * p, 20 * p, s, 0.6, 0.25, 0.002);
    for (let i = 0; i < 6; i++) {
      A._noise(o, 'highpass', 2200, 900, 0.8, s + 0.2 + i * 0.16 + Math.random() * 0.05, 0.08, 0.2 - i * 0.025, 0.001);
    }
  },
  uiSelect: function (A, o, t, p) {
    A._tone(o, 'square', 660 * p, 660 * p, t, 0.05, 0.2, 0.001, 0.6);
    A._tone(o, 'square', 990 * p, 990 * p, t + 0.045, 0.08, 0.2, 0.001, 0.5);
  },
  uiToggle: function (A, o, t, p) {
    A._tone(o, 'sawtooth', 220 * p, 1760 * p, t, 0.14, 0.2, 0.002, 0.7);
    A._noise(o, 'bandpass', 800, 6000, 3, t, 0.14, 0.18, 0.01, 0.6);
    A._tone(o, 'square', 1760 * p, 1760 * p, t + 0.14, 0.09, 0.16, 0.001, 0.4);
  },
  bombReady: function (A, o, t, p) {
    const n = [523, 659, 784, 1047];
    for (let i = 0; i < n.length; i++) {
      A._tone(o, 'square', n[i] * p, n[i] * p, t + i * 0.055, i === 3 ? 0.2 : 0.07, 0.18, 0.002, 0.5);
      A._tone(o, 'triangle', n[i] * 2 * p, n[i] * 2 * p, t + i * 0.055, i === 3 ? 0.2 : 0.07, 0.1, 0.002, 0.5);
    }
  },
  noBombs: function (A, o, t, p) {
    A._tone(o, 'square', 116 * p, 104 * p, t, 0.1, 0.28, 0.002, 0.7);
    A._tone(o, 'square', 98 * p, 88 * p, t + 0.12, 0.16, 0.28, 0.002, 0.7);
  },
  respawn: function (A, o, t, p) {
    A._tone(o, 'sine', 180 * p, 1250 * p, t, 0.42, 0.3, 0.02, 0.7);
    A._tone(o, 'triangle', 360 * p, 2500 * p, t, 0.42, 0.14, 0.02, 0.7);
    A._noise(o, 'bandpass', 600, 5000, 2, t, 0.4, 0.14, 0.05, 0.6);
    const n = [784, 1047, 1568];
    for (let i = 0; i < 3; i++) A._tone(o, 'square', n[i] * p, n[i] * p, t + 0.4 + i * 0.06, 0.1, 0.16, 0.002, 0.5);
  }
};

/* AudioWorklet source: sample-and-hold rate reducer + mid-tread quantiser */
AudioSynthMatrix.CRUSHER_WORKLET = [
  'class GrimalkinCrusher extends AudioWorkletProcessor {',
  '  static get parameterDescriptors() {',
  '    return [',
  '      { name: "bits", defaultValue: 8, minValue: 1, maxValue: 16, automationRate: "k-rate" },',
  '      { name: "hold", defaultValue: 1, minValue: 1, maxValue: 128, automationRate: "k-rate" }',
  '    ];',
  '  }',
  '  constructor() { super(); this.phase = 0; this.held = [0, 0]; }',
  '  process(inputs, outputs, params) {',
  '    const inp = inputs[0], out = outputs[0];',
  '    if (!out || !out.length) return true;',
  '    const levels = Math.pow(2, params.bits[0] - 1), hold = params.hold[0];',
  '    const has = inp && inp.length > 0;',
  '    let p = this.phase;',
  '    for (let c = 0; c < out.length; c++) {',
  '      const o = out[c], i = has ? (inp[c] || inp[0]) : null;',
  '      let h = this.held[c] || 0;',
  '      p = this.phase;',
  '      for (let n = 0; n < o.length; n++) {',
  '        p += 1;',
  '        if (p >= hold) {',
  '          p -= hold;',
  '          let x = i ? i[n] : 0;',
  '          if (x > 1) x = 1; else if (x < -1) x = -1;',
  '          h = Math.round(x * levels) / levels;',
  '        }',
  '        o[n] = h;',
  '      }',
  '      this.held[c] = h;',
  '    }',
  '    this.phase = p;',
  '    return true;',
  '  }',
  '}',
  'registerProcessor("grimalkin-crusher", GrimalkinCrusher);'
].join('\n');

if (typeof module !== 'undefined') module.exports = { AudioSynthMatrix };
