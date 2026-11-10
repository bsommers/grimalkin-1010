'use strict';
/* GRIMALKIN 1010 — NeoEngine: WebGL2 2.5D deferred HDR PBR renderer.
 * Pipeline: G-buffer (4 MRT + depth) -> ambient/IBL + backdrop -> instanced point-light
 * volumes (Cook-Torrance GGX) -> forward additive FX (depth tested) -> screen-space
 * gloss reflections -> motion blur -> multi-level bloom -> ACES composite.
 * World (rx, ry) maps to ground plane (X = rx, Y = up, Z = ry); camera is tilt-only. */

/* ---------- procedural mesh builder (flat-shaded, 12 floats / vertex) ---------- */
class NeoMesh {
  constructor() { this.d = []; this.c = [0.5, 0.5, 0.5]; this.m = [1, 0.4, 0]; }

  mat(col, met, rough, em) { this.c = col; this.m = [met, rough, em || 0]; return this; }

  /* triangle with normal flipped to agree with hint direction (hx,hy,hz) */
  tri(a, b, c, hx, hy, hz) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    if (nx * hx + ny * hy + nz * hz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const d = this.d, k = this.c, m = this.m;
    d.push(a[0], a[1], a[2], nx, ny, nz, k[0], k[1], k[2], m[0], m[1], m[2],
           b[0], b[1], b[2], nx, ny, nz, k[0], k[1], k[2], m[0], m[1], m[2],
           c[0], c[1], c[2], nx, ny, nz, k[0], k[1], k[2], m[0], m[1], m[2]);
  }
  /* triangle whose normal points away from interior reference point r */
  triR(a, b, c, r) {
    this.tri(a, b, c, (a[0] + b[0] + c[0]) / 3 - r[0], (a[1] + b[1] + c[1]) / 3 - r[1], (a[2] + b[2] + c[2]) / 3 - r[2]);
  }
  quadR(a, b, c, d, r) { this.triR(a, b, c, r); this.triR(a, c, d, r); }
  quadH(a, b, c, d, hx, hy, hz) { this.tri(a, b, c, hx, hy, hz); this.tri(a, c, d, hx, hy, hz); }

  box(cx, cy, cz, hx, hy, hz) {
    const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
    this.quadH([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], 0, 1, 0);
    this.quadH([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], 0, 0, -1);
    this.quadH([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 0, 0, 1);
    this.quadH([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], -1, 0, 0);
    this.quadH([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], 1, 0, 0);
    return this;
  }

  /* skin consecutive rings (equal point counts); degenerate rings make caps */
  loft(rings, ref) {
    for (let r = 0; r + 1 < rings.length; r++) {
      const A = rings[r], B = rings[r + 1], n = A.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        this.quadR(A[i], A[j], B[j], B[i], ref);
      }
    }
    return this;
  }

  /* 4-sided spike from base point to tip */
  spike(b, t, w) {
    const dx = t[0] - b[0], dz = t[2] - b[2];
    const l = Math.hypot(dx, dz) || 1;
    const px = -dz / l * w, pz = dx / l * w, h = w * 0.7;
    const ring = [[b[0] + px, b[1], b[2] + pz], [b[0], b[1] + h, b[2]], [b[0] - px, b[1], b[2] - pz], [b[0], b[1] - h, b[2]]];
    const back = [b[0] - dx / l * w * 0.5, b[1], b[2] - dz / l * w * 0.5];
    const ref = [b[0] + dx * 0.25, b[1], b[2] + dz * 0.25];
    this.loft([[back, back, back, back], ring, [t, t, t, t]], ref);
    return this;
  }

  /* extrude a 2D (x,z) polygon into a bevelled plate. hf(x,z) = base height field */
  extrude(poly, y0, h, bevel, hf, skirt) {
    const n = poly.length;
    if (n < 3) return this;
    hf = hf || NeoMesh.zero; skirt = skirt || 0;
    let area = 0;
    for (let i = 0; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
    const s = area >= 0 ? 1 : -1;
    const en = [];
    for (let i = 0; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      const dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1;
      en.push([s * dz / l, -s * dx / l]);
    }
    const ins = [];
    for (let i = 0; i < n; i++) {
      const n1 = en[(i + n - 1) % n], n2 = en[i];
      const k = 1 + n1[0] * n2[0] + n1[1] * n2[1];
      const f = bevel / Math.max(k, 0.35);
      ins.push([poly[i][0] - (n1[0] + n2[0]) * f, poly[i][1] - (n1[1] + n2[1]) * f]);
    }
    const lo = [], mid = [], top = [];
    for (let i = 0; i < n; i++) {
      const p = poly[i], q = ins[i], b = y0 + hf(p[0], p[1]);
      lo.push([p[0], b - skirt, p[1]]);
      mid.push([p[0], b + h - bevel, p[1]]);
      top.push([q[0], y0 + hf(q[0], q[1]) + h, q[1]]);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, e = en[i];
      this.quadH(lo[i], lo[j], mid[j], mid[i], e[0], 0, e[1]);
      this.quadH(mid[i], mid[j], top[j], top[i], e[0], 1, e[1]);
    }
    const t = NeoMesh.triangulate(ins);
    for (let i = 0; i < t.length; i += 3) this.tri(top[t[i]], top[t[i + 1]], top[t[i + 2]], 0, 1, 0);
    return this;
  }

  static zero() { return 0; }

  /* ear-clipping triangulation of a simple polygon; returns flat index list */
  static triangulate(pts) {
    const n = pts.length, out = [];
    let area = 0;
    for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(area >= 0 ? i : n - 1 - i);
    const cr = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    let guard = 0;
    while (idx.length > 3 && guard++ < 2000) {
      let clipped = false;
      const m = idx.length;
      for (let i = 0; i < m; i++) {
        const ia = idx[(i + m - 1) % m], ib = idx[i], ic = idx[(i + 1) % m];
        const a = pts[ia], b = pts[ib], c = pts[ic];
        if (cr(a, b, c) <= 1e-9) continue;
        let ok = true;
        for (let k = 0; k < m; k++) {
          const j = idx[k];
          if (j === ia || j === ib || j === ic) continue;
          const p = pts[j];
          if (cr(a, b, p) >= 0 && cr(b, c, p) >= 0 && cr(c, a, p) >= 0) { ok = false; break; }
        }
        if (!ok) continue;
        out.push(ia, ib, ic);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) { out.push(idx[0], idx[1], idx[2]); idx.splice(1, 1); }
    }
    if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
    return out;
  }

  static ringX(x, ry, rz, n, y0) {
    const r = [];
    for (let i = 0; i < n; i++) { const t = i / n * 6.283185307; r.push([x, (y0 || 0) + ry * Math.cos(t), rz * Math.sin(t)]); }
    return r;
  }
  static ringY(y, rx, rz, n, cx, cz) {
    const r = [];
    for (let i = 0; i < n; i++) { const t = i / n * 6.283185307; r.push([(cx || 0) + rx * Math.cos(t), y, (cz || 0) + rz * Math.sin(t)]); }
    return r;
  }
  static rng(seed) {
    let s = (seed | 0) ^ 0x9e3779b9;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- entity meshes ---------------- */
  static player() {
    const m = new NeoMesh(), hull = [0.56, 0.62, 0.70], cy = [0.03, 0.78, 1.0], dark = [0.07, 0.08, 0.11];
    const R = (x, ry, rz, y0) => NeoMesh.ringX(x, ry, rz, 8, y0);
    m.mat(hull, 1, 0.24, 0);
    m.loft([R(20, 0, 0, 0), R(11, 1.8, 2.4, 0), R(2, 3.4, 4.6, 0.3), R(-7, 3.6, 5.2, 0.3), R(-12, 2.6, 3.8, 0)], [-2, 0, 0]);
    m.mat(cy, 0, 0.4, 1);
    m.loft([R(-12, 2.4, 3.6, 0), R(-12.6, 0, 0, 0)], [0, 0, 0]);
    m.mat(hull, 1, 0.3, 0);
    m.extrude([[5, 3], [-9, 15], [-14, 15], [-11, 4]], -0.6, 1.6, 0.5);
    m.extrude([[5, -3], [-11, -4], [-14, -15], [-9, -15]], -0.6, 1.6, 0.5);
    m.mat(cy, 0.2, 0.3, 1);
    m.box(-11.5, 1.3, 15, 2.5, 0.5, 0.7); m.box(-11.5, 1.3, -15, 2.5, 0.5, 0.7);
    m.mat([0.02, 0.22, 0.32], 0, 0.06, 0.3);
    m.loft([R(9, 0, 0, 2.2), R(5, 1.4, 1.7, 2.6), R(-1, 1.6, 2.0, 2.8), R(-4, 0, 0, 2.6)], [2, 1, 0]);
    m.mat(dark, 1, 0.4, 0);
    m.extrude([[-4, -0.6], [-12, -0.6], [-12, 0.6], [-4, 0.6]], 3, 3, 0.3);
    m.mat([1.0, 0.25, 0.02], 1, 0.3, 0);
    m.box(-2, 3.6, 4.4, 4, 0.3, 0.5); m.box(-2, 3.6, -4.4, 4, 0.3, 0.5);
    return m;
  }

  static worker() {
    const m = new NeoMesh();
    m.mat([0.04, 0.14, 0.85], 0.75, 0.42, 0); m.box(0, 3.5, 0, 8, 4, 6);
    m.mat([0.35, 0.38, 0.45], 1, 0.33, 0);
    m.box(-3, 3, 9, 6, 3, 2.5); m.box(-3, 3, -9, 6, 3, 2.5);
    m.box(10.5, 2, 5, 3, 1.4, 1.2); m.box(10.5, 2, -5, 3, 1.4, 1.2);
    m.box(13, 2, 3.4, 0.8, 1.4, 1.6); m.box(13, 2, -3.4, 0.8, 1.4, 1.6);
    m.mat([0.03, 0.78, 1.0], 0, 0.3, 1);
    m.box(2, 7.7, 0, 3, 0.3, 2.5);
    m.box(-9.3, 3, 9, 0.4, 2, 1.8); m.box(-9.3, 3, -9, 0.4, 2, 1.8);
    m.mat([1.0, 0.62, 0.02], 0.4, 0.5, 0); m.box(8.2, 3.5, 0, 0.3, 2.6, 4.2);
    m.mat([0.06, 0.07, 0.1], 1, 0.5, 0); m.box(-8.4, 3.5, 0, 0.5, 3, 4);
    return m;
  }

  static warrior() {
    const m = new NeoMesh(), red = [0.85, 0.03, 0.09], dark = [0.1, 0.05, 0.08];
    const R = (x, ry, rz, y0) => NeoMesh.ringX(x, ry, rz, 6, y0);
    m.mat(dark, 1, 0.3, 0);
    m.loft([R(7, 0, 0, 1.5), R(3, 2.6, 4.5, 1.5), R(-6, 3.2, 6, 1.5), R(-10, 1.8, 3, 1.5), R(-10.5, 0, 0, 1.5)], [-2, 1.5, 0]);
    m.mat(red, 0.9, 0.26, 0);
    m.spike([3, 1.5, 0], [21, 1.5, 0], 2.2);
    m.spike([-3, 1.5, 6], [16, 1.5, 10], 2.4); m.spike([-3, 1.5, -6], [16, 1.5, -10], 2.4);
    m.spike([-5, 1.5, 5], [-15, 1.5, 13], 2.0); m.spike([-5, 1.5, -5], [-15, 1.5, -13], 2.0);
    m.mat([1.0, 0.08, 0.22], 0, 0.3, 1);
    m.box(2.5, 4.3, 0, 1.8, 0.5, 1.3);
    m.box(-10.6, 1.5, 0, 0.4, 1.4, 2.4);
    return m;
  }

  static crystal() {
    const m = new NeoMesh();
    m.mat([1.0, 0.64, 0.05], 0, 0.07, 1);
    const b = [0, -6, 0], t = [0, 6, 0], ring = NeoMesh.ringY(0, 3.2, 3.2, 6);
    m.loft([[b, b, b, b, b, b], ring, [t, t, t, t, t, t]], [0, 0, 0]);
    return m;
  }

  static bomb() {
    const m = new NeoMesh(), r = 7;
    const v = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const f = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [0, 4, 3], [4, 1, 3], [1, 5, 3], [5, 0, 3]];
    const nm = (a, b) => { const x = a[0] + b[0], y = a[1] + b[1], z = a[2] + b[2], l = Math.hypot(x, y, z) || 1; return [x / l * r, y / l * r, z / l * r]; };
    let k = 0;
    for (const t of f) {
      const a = v[t[0]], b = v[t[1]], c = v[t[2]];
      const A = [a[0] * r, a[1] * r, a[2] * r], B = [b[0] * r, b[1] * r, b[2] * r], C = [c[0] * r, c[1] * r, c[2] * r];
      const ab = nm(a, b), bc = nm(b, c), ca = nm(c, a);
      const sub = [[A, ab, ca], [ab, B, bc], [ca, bc, C], [ab, bc, ca]];
      for (let i = 0; i < 4; i++) {
        if ((k + i) % 2 === 0) m.mat([0.45, 1.0, 0.4], 0, 0.15, 1); else m.mat([0.75, 0.8, 0.78], 1, 0.18, 0.12);
        m.triR(sub[i][0], sub[i][1], sub[i][2], [0, 0, 0]);
      }
      k++;
    }
    return m;
  }

  /* unit-radius faceted rock whose equator silhouette is exactly `shape` */
  static asteroid(shape, seed) {
    const m = new NeoMesh(), rnd = NeoMesh.rng(seed || 1);
    const n = (shape && shape.length) || 12;
    const lats = [-58, -27, 0, 27, 58], rings = [];
    const pb = [0, -0.72 * (0.85 + 0.2 * rnd()), 0], pt = [0, 0.72 * (0.85 + 0.2 * rnd()), 0];
    const capB = [], capT = [];
    for (let i = 0; i < n; i++) { capB.push(pb); capT.push(pt); }
    rings.push(capB);
    for (const la of lats) {
      const c = Math.cos(la * Math.PI / 180), s = Math.sin(la * Math.PI / 180), ring = [];
      for (let i = 0; i < n; i++) {
        const sh = shape ? (+shape[i] || 1) : 1;
        const j = la === 0 ? 1 : 0.8 + 0.28 * rnd();
        const a = i / n * 6.283185307, rr = sh * c * j;
        ring.push([Math.cos(a) * rr, 0.75 * s * (0.85 + 0.3 * rnd()), Math.sin(a) * rr]);
      }
      rings.push(ring);
    }
    rings.push(capT);
    m.mat([0.34, 0.31, 0.30], 0.25, 0.62, 0);
    m.loft(rings, [0, 0, 0]);
    return m;
  }

  static bossDome(x, z) {
    const q = (x * x + z * z) / (120 * 120 * 1.15);
    return 42 * (1 - Math.min(1, q));
  }

  /* one of the 12 Grimalkin plates, built at radius 120 */
  static bossPlate(i, poly, eyes) {
    const m = new NeoMesh(), S = 120, hf = NeoMesh.bossDome;
    const P = [];
    let cx = 0, cz = 0;
    for (const p of poly) { const x = p[0] * S, z = p[1] * S; P.push([x, z]); cx += x; cz += z; }
    cx /= P.length || 1; cz /= P.length || 1;
    const thick = [12, 12, 10, 10, 14, 8, 8, 16, 9, 9, 12, 12][i] || 10;
    const copper = i === 7 || i === 8 || i === 9;
    const base = copper ? [0.62, 0.3, 0.1] : (i === 5 || i === 6) ? [0.12, 0.13, 0.17] : [0.3, 0.32, 0.37];
    m.mat(base, 1, copper ? 0.3 : 0.36, 0);
    m.extrude(P, 0, thick, 3, hf, 14);
    if (i !== 5 && i !== 6) {
      const Q = P.map(p => [cx + (p[0] - cx) * 0.6, cz + (p[1] - cz) * 0.6]);
      m.mat(copper ? [0.8, 0.42, 0.14] : [0.42, 0.45, 0.52], 1, 0.2, 0);
      m.extrude(Q, thick - 0.5, 4.5, 1.6, hf, 0);
    } else {
      const e = eyes[i - 5], ex = e.x * S, ez = e.y * S, y = hf(ex, ez) + thick;
      m.mat([0.05, 0.05, 0.07], 1, 0.22, 0);
      m.loft([NeoMesh.ringY(y - 1, 27, 27, 14, ex, ez), NeoMesh.ringY(y + 7, 24, 24, 14, ex, ez), NeoMesh.ringY(y + 4, 20.5, 20.5, 14, ex, ez)], [ex, y - 30, ez]);
      m.mat([0.7, 0.36, 0.12], 1, 0.25, 0);
      for (let k = 0; k < 14; k += 2) {
        const a = k / 14 * 6.283185307;
        m.box(ex + Math.cos(a) * 25.5, y + 7.5, ez + Math.sin(a) * 25.5, 1.6, 1.2, 1.6);
      }
    }
    const ivory = [0.86, 0.82, 0.68];
    if (i === 4) {
      m.mat(ivory, 0.3, 0.22, 0);
      for (const tx of [-0.2, -0.08, 0.08, 0.2]) {
        const len = Math.abs(tx) > 0.1 ? 0.17 : 0.09, x = tx * S, z = 0.5 * S;
        m.spike([x, hf(x, z) + 9, z], [x * 0.92, hf(x, z) + 6, z + len * S], 0.036 * S);
      }
    } else if (i === 0 || i === 1) {
      const sg = i === 0 ? -1 : 1;
      m.mat(ivory, 0.3, 0.22, 0);
      for (const tx of [0.14, 0.27]) {
        const x = sg * tx * S, z = 0.75 * S;
        m.spike([x, hf(x, z) + 9, z], [x, hf(x, z) + 7, z - 0.11 * S], 0.03 * S);
      }
    } else if (i === 7) {
      m.mat([0.09, 0.09, 0.12], 1, 0.28, 0);
      for (let k = 0; k < 4; k++) {
        const z = cz - 22 + k * 15;
        m.box(cx, hf(cx, z) + thick + 7, z, 2.4, 5 - k * 0.6, 5.5);
      }
    } else if (i === 8 || i === 9) {
      let tip = P[0];
      for (const p of P) if (p[1] < tip[1]) tip = p;
      m.mat([0.09, 0.09, 0.12], 1, 0.25, 0);
      m.spike([cx, hf(cx, cz) + thick + 3, cz], [tip[0], hf(tip[0], tip[1]) + thick + 2, tip[1] - 6], 5);
    }
    return m;
  }

  static bossEye() {
    const m = new NeoMesh(), r = 20.4;
    m.mat([1, 1, 1], 0, 0.05, 1);
    m.loft([NeoMesh.ringY(0, r, r, 16), NeoMesh.ringY(2.6, r * 0.82, r * 0.82, 16), NeoMesh.ringY(4.6, r * 0.46, r * 0.46, 16), NeoMesh.ringY(5.4, 0, 0, 16)], [0, -20, 0]);
    return m;
  }
  static bossPupil() {
    const m = new NeoMesh();
    m.mat([0.005, 0.005, 0.008], 0, 0.04, 0);
    m.loft([NeoMesh.ringY(3, 3.4, 16.5, 10), NeoMesh.ringY(7.2, 2.2, 13.5, 10), NeoMesh.ringY(7.8, 0, 0, 10)], [0, -10, 0]);
    return m;
  }
  static bossThroat() {
    const m = new NeoMesh(), S = 120, z = 0.63 * S, y = NeoMesh.bossDome(0, z) - 4;
    m.mat([1, 1, 1], 0, 0.5, 1);
    const c = [0, y, z], ring = NeoMesh.ringY(y, 0.31 * S, 0.17 * S, 12, 0, z);
    for (let i = 0; i < 12; i++) m.tri(c, ring[i], ring[(i + 1) % 12], 0, 1, 0);
    m.mat([0.02, 0.02, 0.03], 1, 0.5, 0);
    for (let k = -3; k <= 3; k++) m.box(k * 9.5, y + 1.2, z, 1.3, 1.2, 0.16 * S);
    return m;
  }

  static fallbackPieces() {
    const L = [
      ['jawL', [[-0.5, 0.64], [-0.02, 0.72], [-0.02, 0.95], [-0.3, 0.9], [-0.56, 0.76]]],
      ['cheekL', [[-0.9, 0.12], [-0.6, 0.27], [-0.32, 0.3], [-0.33, 0.56], [-0.56, 0.62], [-0.86, 0.42]]],
      ['eyeL', [[-0.8, -0.2], [-0.25, -0.15], [-0.25, 0.2], [-0.6, 0.25], [-0.88, 0.1]]],
      ['earL', [[-0.86, -0.45], [-0.72, -1.0], [-0.3, -0.56], [-0.56, -0.42]]],
      ['skullL', [[-0.96, 0.06], [-0.9, -0.43], [-0.56, -0.4], [-0.3, -0.54], [-0.23, -0.42], [-0.25, -0.17], [-0.8, -0.22], [-0.9, 0.1]]]
    ];
    const mir = poly => poly.map(p => [-p[0], p[1]]).reverse();
    const g = k => L[k][1];
    const polys = [g(0), mir(g(0)), g(1), mir(g(1)),
      [[-0.3, 0.22], [0.3, 0.22], [0.31, 0.55], [0, 0.63], [-0.31, 0.55]],
      g(2), mir(g(2)),
      [[-0.22, -0.4], [0.22, -0.4], [0.24, 0.2], [-0.24, 0.2]],
      g(3), mir(g(3)), g(4), mir(g(4))];
    return polys.map((poly, i) => ({ name: 'p' + i, poly: poly, order: i }));
  }
}

/* ---------- GLSL ES 3.00 sources ---------- */
class NeoGLSL {
  static get() {
    const HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';
    const NOISE = `
float hash21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float hash31(vec3 p){ p=fract(p*vec3(0.1031,0.1030,0.0973)); p+=dot(p,p.yzx+33.33); return fract((p.x+p.y)*p.z); }
float vnoise(vec2 p){
  vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash21(i), b=hash21(i+vec2(1.0,0.0)), c=hash21(i+vec2(0.0,1.0)), d=hash21(i+vec2(1.0,1.0));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
float vnoise3(vec3 p){
  vec3 i=floor(p); vec3 f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash31(i), b=hash31(i+vec3(1.0,0.0,0.0)), c=hash31(i+vec3(0.0,1.0,0.0)), d=hash31(i+vec3(1.0,1.0,0.0));
  float e=hash31(i+vec3(0.0,0.0,1.0)), g=hash31(i+vec3(1.0,0.0,1.0)), h=hash31(i+vec3(0.0,1.0,1.0)), k=hash31(i+vec3(1.0,1.0,1.0));
  return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y),mix(mix(e,g,f.x),mix(h,k,f.x),f.y),f.z);
}
float fbm(vec2 p){
  float a=0.5; float s=0.0;
  for(int i=0;i<4;i++){ s+=a*vnoise(p); p=p*2.03+vec2(17.1,9.3); a*=0.5; }
  return s;
}
float fbm3(vec3 p){
  float a=0.5; float s=0.0;
  for(int i=0;i<3;i++){ s+=a*vnoise3(p); p=p*2.07+vec3(11.3,5.7,8.1); a*=0.5; }
  return s;
}
`;
    const BRDF = `
vec3 brdfGGX(vec3 N, vec3 V, vec3 L, vec3 alb, float met, float rough){
  vec3 H=normalize(V+L);
  float NoL=max(dot(N,L),0.0); float NoV=max(dot(N,V),0.001);
  float NoH=max(dot(N,H),0.0); float VoH=clamp(dot(V,H),0.0,1.0);
  float a=max(rough*rough,0.002); float a2=a*a;
  float dd=NoH*NoH*(a2-1.0)+1.0;
  float D=a2/(3.14159265*dd*dd+1e-7);
  float k=(rough+1.0); k=k*k/8.0;
  float G=(NoL/(NoL*(1.0-k)+k))*(NoV/(NoV*(1.0-k)+k));
  vec3 F0=mix(vec3(0.04),alb,met);
  vec3 F=F0+(1.0-F0)*pow(1.0-VoH,5.0);
  vec3 spec=min(D*G*F/(4.0*NoL*NoV+1e-4),vec3(48.0));
  vec3 kd=(1.0-F)*(1.0-met);
  return (kd*alb/3.14159265+spec)*NoL;
}
`;
    const FS_VS = HEAD + `
out vec2 vUv;
void main(){
  vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  vUv=p; gl_Position=vec4(p*2.0-1.0,0.0,1.0);
}`;

    const G_VS = HEAD + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
layout(location=2) in vec3 aCol;
layout(location=3) in vec3 aMat;
uniform mat4 uVP; uniform mat4 uModel;
out vec3 vN; out vec3 vCol; out vec3 vMat; out vec3 vObj; out vec3 vW;
void main(){
  vec4 w=uModel*vec4(aPos,1.0);
  vW=w.xyz; vObj=aPos; vN=mat3(uModel)*aNor; vCol=aCol; vMat=aMat;
  gl_Position=uVP*w;
}`;

    const G_FS = HEAD + NOISE + `
in vec3 vN; in vec3 vCol; in vec3 vMat; in vec3 vObj; in vec3 vW;
uniform vec3 uTint; uniform vec3 uEmis; uniform vec4 uFx; uniform int uKind;
uniform vec2 uVel; uniform float uEmK; uniform float uSeed;
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;
layout(location=2) out vec4 o2;
layout(location=3) out vec4 o3;
void main(){
  vec3 n=normalize(vN);
  vec3 alb=vCol*uTint; float met=vMat.x; float rough=vMat.y; float em=vMat.z;
  vec3 e=vCol*em*uEmis; float ao=1.0;
  vec3 q=vObj+vec3(uSeed);
  float mn=fbm3(q*0.35);
  float nonEm=1.0-step(0.01,em);
  if(uKind==0||uKind==3){
    float sc=(uKind==3)?0.085:0.21;
    vec3 g=abs(fract(vObj*sc+0.5)-0.5);
    float line=(1.0-smoothstep(0.0,0.04,min(g.x,g.z)))*nonEm;
    float grime=fbm3(q*0.08);
    alb*=mix(1.0,0.4,line)*(0.72+0.56*grime);
    rough=clamp(rough+(mn-0.5)*0.34+line*0.3+(grime-0.5)*0.2,0.05,1.0);
    ao*=1.0-line*0.5;
    if(uKind==3){
      float rib=smoothstep(0.34,0.5,abs(fract(length(vObj.xz)*0.065)-0.5))*nonEm;
      rough=clamp(rough+rib*0.18,0.05,1.0); alb*=1.0-rib*0.25; ao*=1.0-rib*0.25;
      float vein=smoothstep(0.52,0.5,abs(fbm3(q*0.045+vec3(9.0))-0.5)*4.0)*nonEm;
      e+=vec3(1.0,0.28,0.04)*vein*0.0;
    }
  } else if(uKind==1){
    float cr=fbm3(q*4.5); float f2=fbm3(q*9.0+vec3(7.0));
    alb*=0.55+0.9*cr;
    rough=clamp(rough+(mn-0.5)*0.3,0.3,1.0);
    float crack=smoothstep(0.07,0.0,abs(f2-0.5));
    ao*=1.0-crack*0.6;
    e+=vec3(1.0,0.33,0.04)*uFx.x*(crack*3.5+0.06+0.3*cr);
    float vein=smoothstep(0.6,0.68,fbm3(q*7.0+vec3(3.0)))*uFx.y;
    e+=vec3(1.0,0.7,0.1)*vein*1.3;
    alb=mix(alb,vec3(1.0,0.78,0.2),vein*0.7); rough=mix(rough,0.14,vein); met=mix(met,0.9,vein);
  } else {
    rough=clamp(rough+(mn-0.5)*0.08,0.04,1.0);
  }
  e+=vec3(uFx.z*2.5);
  if(uFx.w>0.0){
    float b=fbm3(vObj*0.06+vec3(uSeed));
    float edge=b-(uFx.w*1.1-0.15);
    if(edge<0.0) discard;
    e+=vec3(1.0,0.4,0.06)*smoothstep(0.12,0.0,edge)*14.0;
  }
  o0=vec4(alb,met);
  o1=vec4(n*0.5+0.5,rough);
  o2=vec4(e*uEmK,ao);
  o3=vec4((clamp(uVel/0.05,-1.0,1.0)*127.0+128.0)/255.0,0.0,1.0);
}`;

    const AMB_FS = HEAD + NOISE + BRDF + `
in vec2 vUv;
uniform sampler2D uG0; uniform sampler2D uG1; uniform sampler2D uG2; uniform sampler2D uDepth; uniform sampler2D uBadge;
uniform vec3 uV; uniform vec2 uHalf; uniform vec2 uCam; uniform float uTime;
uniform vec3 uMoon; uniform float uHasBadge; uniform float uVoice; uniform float uDread;
uniform float uEmK; uniform float uHdrK; uniform float uZR2; uniform vec2 uAoR;
out vec4 o;
float starLayer(vec2 p, float cell, float dens){
  vec2 q=p/cell; vec2 g=floor(q); vec2 f=fract(q)-0.5;
  float h=hash21(g);
  if(h>dens) return 0.0;
  vec2 off=(vec2(hash21(g+vec2(3.1,1.7)),hash21(g+vec2(7.7,4.3)))-0.5)*0.7;
  float d=length(f-off);
  float tw=0.6+0.4*sin(uTime*(1.0+h*40.0)+h*100.0);
  return smoothstep(0.07,0.0,d)*tw*(0.35+h/dens);
}
vec3 backdrop(vec2 s){
  vec2 p1=(s+uCam*0.06)*0.0011;
  vec2 p2=(s+uCam*0.14)*0.0021;
  float w=fbm(p1*0.8+vec2(0.0,uTime*0.004));
  vec2 wq=vec2(w,1.0-w);
  float n1=fbm(p1+wq*1.6);
  float n2=fbm(p2+wq*0.9+vec2(31.7,-12.4));
  float n3=fbm(p1*0.7+vec2(-40.0,22.0)+wq.yx);
  vec3 c=vec3(0.005,0.009,0.032);
  c+=vec3(0.03,0.12,0.65)*pow(n1,2.2)*0.8;
  c+=vec3(0.04,0.75,1.0)*pow(max(n2-0.36,0.0),2.0)*1.5;
  c+=vec3(1.0,0.36,0.06)*pow(max(n3-0.46,0.0),2.0)*2.4;
  c+=vec3(1.0,0.2,0.45)*pow(max(n1*n2-0.3,0.0),2.0)*1.6;
  c=mix(c,c.r*vec3(1.4,0.25,0.2)+c*vec3(0.9,0.5,0.5),uDread*0.6);
  float st=starLayer(s+uCam*0.03,38.0,0.10)*0.8+starLayer(s+uCam*0.09,61.0,0.08)*1.3+starLayer(s+uCam*0.2,97.0,0.06)*2.2;
  c+=vec3(0.75,0.9,1.0)*st;
  vec2 md=(s-uMoon.xy)/uMoon.z; float ml=length(md);
  if(ml<1.5){
    c+=vec3(0.04,0.5,0.95)*exp(-pow((ml-1.0)*9.0,2.0))*0.45;
    if(ml<1.0){
      float scan=0.6+0.4*sin(s.y*0.9+uTime*3.0);
      float edge=smoothstep(1.0,0.9,ml);
      if(uHasBadge>0.5){
        vec4 b=textureLod(uBadge,md*0.5+0.5,0.0);
        vec3 bc=pow(b.rgb,vec3(2.2));
        float lum=dot(bc,vec3(0.3,0.6,0.1));
        vec3 holo=mix(vec3(0.05,0.7,1.0),vec3(1.0,0.5,0.1),smoothstep(0.1,0.6,b.r-b.b))*(0.15+lum*1.4);
        c+=vec3(0.01,0.06,0.14)*edge;
        c+=holo*b.a*scan*edge*0.32*(0.85+0.15*sin(uTime*1.7))*(1.0+uVoice*1.5);
      } else {
        c+=vec3(0.03,0.22,0.45)*0.12*scan*edge;
      }
    }
  }
  return c;
}
vec3 envD(vec3 d){
  vec3 c=mix(vec3(0.02,0.03,0.09),vec3(0.05,0.2,0.42),smoothstep(-0.3,0.9,d.y));
  c+=vec3(0.5,0.22,0.04)*max(0.0,dot(d,normalize(vec3(-0.6,0.35,-0.7))))*0.5;
  return c;
}
vec3 env(vec3 d, float r){
  vec3 c=mix(vec3(0.02,0.035,0.12),vec3(0.03,0.22,0.5),smoothstep(-0.2,0.9,d.y));
  float az=atan(d.z,d.x);
  float band=fbm(vec2(az*1.5,d.y*3.0)+vec2(uTime*0.01,0.0));
  c+=vec3(0.1,0.85,1.0)*pow(band,3.0)*1.6*(1.0-r*0.7);
  c+=vec3(1.0,0.5,0.1)*pow(max(0.0,dot(d,normalize(vec3(-0.6,0.35,-0.7)))),mix(28.0,2.0,r))*1.8;
  c+=vec3(0.1,0.32,1.0)*pow(max(0.0,dot(d,normalize(vec3(0.7,0.5,0.4)))),mix(18.0,2.0,r))*1.4;
  return c;
}
void main(){
  ivec2 pc=ivec2(gl_FragCoord.xy);
  float d=texelFetch(uDepth,pc,0).r;
  vec2 ndc=vUv*2.0-1.0;
  if(d>=1.0){
    o=vec4(backdrop(vec2(ndc.x*uHalf.x,-ndc.y*uHalf.y))*uHdrK,1.0);
    return;
  }
  vec4 g0=texelFetch(uG0,pc,0); vec4 g1=texelFetch(uG1,pc,0); vec4 g2=texelFetch(uG2,pc,0);
  vec3 N=normalize(g1.xyz*2.0-1.0); float rough=g1.a; float met=g0.a; vec3 alb=g0.rgb;
  float occ=0.0; float jit=hash21(gl_FragCoord.xy)*6.2831853;
  for(int i=0;i<8;i++){
    float a=float(i)*0.7853982+jit;
    vec2 off=vec2(cos(a),sin(a))*uAoR*(0.3+float(i)*0.25);
    float sd=textureLod(uDepth,vUv+off,0.0).r;
    float dz=(d-sd)*uZR2;
    occ+=smoothstep(1.5,10.0,dz)*(1.0-smoothstep(40.0,90.0,dz));
  }
  float ao=g2.a*(1.0-occ*0.125*0.75);
  vec3 R=reflect(-uV,N);
  vec3 F0=mix(vec3(0.04),alb,met); float NoV=clamp(dot(N,uV),0.0,1.0);
  vec3 F=F0+(max(vec3(1.0-rough),F0)-F0)*pow(1.0-NoV,5.0);
  vec3 col=(1.0-F)*(1.0-met)*alb*envD(N)+F*env(R,rough);
  col+=brdfGGX(N,uV,normalize(vec3(-0.45,0.8,-0.35)),alb,met,rough)*vec3(0.7,0.88,1.0)*1.5;
  col+=brdfGGX(N,uV,normalize(vec3(0.75,0.3,0.6)),alb,met,rough)*vec3(1.0,0.5,0.15)*0.9;
  col*=ao;
  col+=g2.rgb/uEmK;
  o=vec4(col*uHdrK,1.0);
}`;

    const LIGHT_VS = HEAD + `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aLPos;
layout(location=2) in vec3 aLCol;
uniform mat4 uVP; uniform vec2 uScale;
flat out vec4 vL; flat out vec3 vC;
void main(){
  vec4 c=uVP*vec4(aLPos.xyz,1.0);
  gl_Position=vec4(c.xy+aCorner*aLPos.w*uScale,0.0,1.0);
  vL=aLPos; vC=aLCol;
}`;

    const LIGHT_FS = HEAD + BRDF + `
flat in vec4 vL; flat in vec3 vC;
uniform sampler2D uG0; uniform sampler2D uG1; uniform sampler2D uDepth;
uniform mat4 uInvVP; uniform vec3 uV; uniform vec2 uPx; uniform float uHdrK;
out vec4 o;
void main(){
  ivec2 pc=ivec2(gl_FragCoord.xy);
  float d=texelFetch(uDepth,pc,0).r;
  if(d>=1.0) discard;
  vec2 uv=gl_FragCoord.xy*uPx;
  vec3 pos=(uInvVP*vec4(uv*2.0-1.0,d*2.0-1.0,1.0)).xyz;
  vec3 Lv=vL.xyz-pos; float dist=length(Lv);
  float x=dist/vL.w;
  if(x>=1.0) discard;
  vec4 g0=texelFetch(uG0,pc,0); vec4 g1=texelFetch(uG1,pc,0);
  vec3 N=normalize(g1.xyz*2.0-1.0);
  float win=1.0-x*x; float att=win*win/(1.0+22.0*x*x);
  vec3 c=brdfGGX(N,uV,Lv/max(dist,1e-3),g0.rgb,g0.a,g1.a)*vC*att*3.14159265;
  o=vec4(c*uHdrK,0.0);
}`;

    const SPR_VS = HEAD + `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aP;
layout(location=2) in vec3 aSR;
layout(location=3) in vec4 aC;
layout(location=4) in vec2 aK;
uniform mat4 uVP; uniform vec3 uUp;
out vec2 vQ; out vec4 vC; flat out vec2 vK;
void main(){
  float cs=cos(aSR.z); float sn=sin(aSR.z);
  vec2 l=aCorner*aSR.xy;
  vec2 r=vec2(l.x*cs-l.y*sn,l.x*sn+l.y*cs);
  int k=int(aK.x+0.5);
  vec3 w;
  if(k==0||k==2||k==4||k==7) w=aP+vec3(r.x,0.0,0.0)-uUp*r.y;
  else w=aP+vec3(r.x,0.0,r.y);
  gl_Position=uVP*vec4(w,1.0);
  vQ=aCorner; vC=aC; vK=aK;
}`;

    const SPR_FS = HEAD + NOISE + `
in vec2 vQ; in vec4 vC; flat in vec2 vK;
uniform sampler2D uBadge; uniform float uTime; uniform float uHdrK; uniform float uHasBadge;
out vec4 o;
void main(){
  int k=int(vK.x+0.5);
  float r=length(vQ);
  vec3 col=vC.rgb; float a=0.0;
  if(k==0){
    float f=max(0.0,1.0-r);
    a=f*f*f*0.7+exp(-r*r*40.0)*0.9;
    col=mix(col,vec3(max(col.r,max(col.g,col.b))),exp(-r*r*40.0)*0.6);
  } else if(k==1){
    float w=(r-0.87)*16.0;
    a=exp(-w*w)+0.06*max(0.0,1.0-r/0.87)*step(r,0.87);
  } else if(k==2){
    float f=max(0.0,1.0-r);
    a=f*f*(0.35+0.65*vnoise(vQ*3.0+vec2(vK.y*13.0,vK.y*7.0)));
  } else if(k==3){
    float cap=smoothstep(1.0,0.55,abs(vQ.x));
    float core=exp(-vQ.y*vQ.y*90.0)*cap;
    a=exp(-vQ.y*vQ.y*9.0)*cap*0.6+core*1.6;
    col=mix(col,vec3(max(col.r,max(col.g,col.b))),clamp(core,0.0,1.0)*0.75);
  } else if(k==4){
    vec2 b=abs(vQ);
    a=step(max(b.x,b.y*1.6),0.75)*(0.6+0.4*sin(uTime*30.0+vK.y*50.0));
  } else if(k==5){
    float fl=0.65+0.35*vnoise(vec2(vQ.x*vK.y*0.06-uTime*24.0,uTime*9.0));
    float core=exp(-vQ.y*vQ.y*70.0);
    float cap=smoothstep(1.0,0.97,abs(vQ.x));
    a=(exp(-vQ.y*vQ.y*7.0)*0.55*fl+core*1.5)*cap;
    col=mix(col,vec3(max(col.r,max(col.g,col.b))),core*0.8);
  } else if(k==6){
    float t=vQ.x*0.5+0.5;
    float w=mix(0.22,1.0,t);
    float y=vQ.y/w;
    float fl=0.7+0.3*vnoise(vec2(t*6.0-uTime*30.0,vK.y*31.0));
    float fall=pow(max(0.0,1.0-t),1.6);
    float core=exp(-y*y*14.0)*pow(max(0.0,1.0-t*1.8),2.0);
    a=(exp(-y*y*3.2)*fall*fl+core*1.5)*smoothstep(0.0,0.04,t)*step(abs(y),1.6);
    col=mix(col,vec3(max(col.r,max(col.g,col.b))),clamp(core,0.0,1.0)*0.8);
  } else {
    vec2 b=abs(vQ);
    if(uHasBadge>0.5){
      vec4 t=textureLod(uBadge,vQ*0.5+0.5,0.0);
      vec3 bc=pow(t.rgb,vec3(2.2));
      float scan=0.55+0.45*sin(vQ.y*90.0-uTime*8.0);
      float gli=step(0.985,hash21(vec2(floor(vQ.y*24.0),floor(uTime*14.0))));
      col=(bc*1.3+vec3(0.02,0.25,0.4))*vC.rgb;
      a=t.a*scan*(0.75+0.25*sin(uTime*23.0))*(1.0+gli*1.5);
    } else {
      float fr=smoothstep(0.82,0.9,max(b.x,b.y));
      a=fr*0.5+0.06;
    }
    a*=step(max(b.x,b.y),1.0);
  }
  o=vec4(col*a*vC.a*uHdrK,0.0);
}`;

    const HOLO_FS = HEAD + `
in vec3 vN; in vec3 vObj; in vec3 vW;
uniform float uTime; uniform vec4 uHolo; uniform float uHdrK;
out vec4 o;
void main(){
  float scan=0.5+0.5*sin(vW.z*0.8-uTime*6.0);
  vec3 g=abs(fract(vObj*0.08)-0.5);
  float grid=smoothstep(0.44,0.5,max(g.x,g.z));
  float rim=1.0-abs(normalize(vN).y);
  float a=(0.04+0.22*grid+0.4*rim+0.07*scan)*uHolo.a;
  o=vec4(uHolo.rgb*a*uHdrK,0.0);
}`;

    const SSR_FS = HEAD + NOISE + `
in vec2 vUv;
uniform sampler2D uScene; uniform sampler2D uDepth; uniform sampler2D uG0; uniform sampler2D uG1;
uniform mat4 uVP; uniform mat4 uInvVP; uniform vec3 uV; uniform float uTime; uniform float uThick; uniform float uHdrK;
out vec4 o;
void main(){
  ivec2 pc=ivec2(gl_FragCoord.xy);
  vec3 col=texelFetch(uScene,pc,0).rgb;
  float d=texelFetch(uDepth,pc,0).r;
  if(d<1.0){
    vec4 g1=texelFetch(uG1,pc,0); float rough=g1.a;
    if(rough<0.8){
      vec4 g0=texelFetch(uG0,pc,0);
      vec3 N=normalize(g1.xyz*2.0-1.0);
      vec3 pos=(uInvVP*vec4(vUv*2.0-1.0,d*2.0-1.0,1.0)).xyz;
      vec3 R=reflect(-uV,N);
      vec3 F0=mix(vec3(0.04),g0.rgb,g0.a);
      vec3 F=F0+(1.0-F0)*pow(1.0-clamp(dot(N,uV),0.0,1.0),5.0);
      float gloss=1.0-rough/0.8;
      float jit=hash21(gl_FragCoord.xy+vec2(fract(uTime)*91.0,0.0));
      /* depth-tested ray march */
      vec3 hitc=vec3(0.0); float hit=0.0;
      float stepLen=5.0; vec3 p=pos+N*2.0+R*stepLen*jit;
      for(int i=0;i<14;i++){
        p+=R*stepLen; stepLen*=1.28;
        vec4 c=uVP*vec4(p,1.0); vec2 uv=c.xy*0.5+0.5;
        if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0) break;
        float sd=textureLod(uDepth,uv,0.0).r;
        float df=(c.z*0.5+0.5)-sd;
        if(df>0.0&&df<uThick){ hitc=textureLod(uScene,uv,0.0).rgb; hit=1.0-float(i)/14.0; break; }
      }
      col+=hitc*F*hit*gloss;
      /* screen-space gloss: bright emitters near the reflected ray footprint */
      vec3 Rs=normalize(R+N*0.35);
      vec3 glo=vec3(0.0); float wsum=0.0;
      for(int i=0;i<5;i++){
        float t=(12.0+float(i)*float(i)*9.0)*(0.8+0.4*jit)*(1.0+rough*1.5);
        vec4 c=uVP*vec4(pos+Rs*t,1.0); vec2 uv=clamp(c.xy*0.5+0.5,vec2(0.001),vec2(0.999));
        vec3 s=textureLod(uScene,uv,0.0).rgb/uHdrK;
        float l=max(s.r,max(s.g,s.b));
        float wgt=1.0/(1.0+float(i));
        glo+=s*smoothstep(1.2,4.0,l)*wgt; wsum+=wgt;
      }
      col+=min(glo/wsum,vec3(12.0))*F*gloss*0.35*(1.0-hit)*uHdrK;
    }
  }
  o=vec4(col,1.0);
}`;

    const MBLUR_FS = HEAD + `
in vec2 vUv;
uniform sampler2D uScene; uniform sampler2D uG3; uniform sampler2D uDepth;
uniform vec2 uBgVel; uniform float uShutter;
out vec4 o;
void main(){
  vec2 v=(texture(uG3,vUv).xy*255.0-128.0)/127.0*0.05;
  float d=texture(uDepth,vUv).r;
  if(d>=1.0) v=uBgVel;
  v*=0.5*uShutter;
  vec3 c=texture(uScene,vUv).rgb;
  if(dot(v,v)>2.0e-7){
    for(int i=1;i<8;i++){
      float t=float(i)/7.0-0.5;
      c+=texture(uScene,vUv+v*t).rgb;
    }
    c*=0.125;
  }
  o=vec4(c,1.0);
}`;

    const PRE_FS = HEAD + `
in vec2 vUv;
uniform sampler2D uTex; uniform vec2 uPx; uniform float uHdrK; uniform float uThr;
out vec4 o;
void main(){
  vec3 c=texture(uTex,vUv+uPx*vec2(-1.0,-1.0)).rgb+texture(uTex,vUv+uPx*vec2(1.0,-1.0)).rgb
        +texture(uTex,vUv+uPx*vec2(-1.0,1.0)).rgb+texture(uTex,vUv+uPx*vec2(1.0,1.0)).rgb;
  c=c*0.25/uHdrK;
  float br=max(c.r,max(c.g,c.b));
  float k=max(br-uThr,0.0)/max(br,1e-4);
  o=vec4(min(c*k,vec3(40.0))*uHdrK,1.0);
}`;

    const DOWN_FS = HEAD + `
in vec2 vUv;
uniform sampler2D uTex; uniform vec2 uPx;
out vec4 o;
void main(){
  vec3 c=texture(uTex,vUv).rgb*4.0;
  c+=texture(uTex,vUv+uPx*vec2(-1.0,-1.0)).rgb+texture(uTex,vUv+uPx*vec2(1.0,-1.0)).rgb
    +texture(uTex,vUv+uPx*vec2(-1.0,1.0)).rgb+texture(uTex,vUv+uPx*vec2(1.0,1.0)).rgb;
  o=vec4(c*0.125,1.0);
}`;

    const UP_FS = HEAD + `
in vec2 vUv;
uniform sampler2D uTex; uniform vec2 uPx; uniform float uGain;
out vec4 o;
void main(){
  vec3 c=texture(uTex,vUv).rgb*4.0;
  c+=(texture(uTex,vUv+uPx*vec2(-1.0,0.0)).rgb+texture(uTex,vUv+uPx*vec2(1.0,0.0)).rgb
     +texture(uTex,vUv+uPx*vec2(0.0,-1.0)).rgb+texture(uTex,vUv+uPx*vec2(0.0,1.0)).rgb)*2.0;
  c+=texture(uTex,vUv+uPx*vec2(-1.0,-1.0)).rgb+texture(uTex,vUv+uPx*vec2(1.0,-1.0)).rgb
    +texture(uTex,vUv+uPx*vec2(-1.0,1.0)).rgb+texture(uTex,vUv+uPx*vec2(1.0,1.0)).rgb;
  o=vec4(c*0.0625*uGain,1.0);
}`;

    const COMP_FS = HEAD + `
in vec2 vUv;
uniform sampler2D uScene; uniform sampler2D uBloom;
uniform float uHdrK; uniform float uTime; uniform float uCA; uniform float uBloomK; uniform float uExposure;
uniform vec4 uFlash; uniform float uDread; uniform float uVoice;
out vec4 o;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
void main(){
  vec2 c=vUv-0.5; float r2=dot(c,c);
  vec2 off=c*(r2*uCA+uCA*0.04);
  vec3 col;
  col.r=texture(uScene,vUv+off).r; col.g=texture(uScene,vUv).g; col.b=texture(uScene,vUv-off).b;
  vec3 bl=texture(uBloom,vUv).rgb;
  bl.r=mix(bl.r,texture(uBloom,vUv+off*2.0).r,0.5); bl.b=mix(bl.b,texture(uBloom,vUv-off*2.0).b,0.5);
  col=(col+bl*uBloomK)/uHdrK;
  col*=uExposure;
  float lum=dot(col,vec3(0.2126,0.7152,0.0722));
  col=mix(col,vec3(lum*1.5,lum*0.35,lum*0.3)+col*vec3(0.5,0.25,0.25),uDread*0.35*smoothstep(0.02,0.4,r2));
  col=aces(col);
  col=pow(col,vec3(0.4545));
  float vig=1.0-smoothstep(0.12,0.62,r2)*(0.55+0.3*uDread);
  col*=vig;
  col=mix(col,uFlash.rgb,clamp(uFlash.a,0.0,1.0)*0.65);
  float gr=fract(sin(dot(gl_FragCoord.xy+vec2(uTime*61.0,uTime*17.0),vec2(12.9898,78.233)))*43758.5453);
  col+=(gr-0.5)*0.018;
  o=vec4(col,1.0);
}`;

    return {
      gbuf: [G_VS, G_FS], holo: [G_VS, HOLO_FS], amb: [FS_VS, AMB_FS], light: [LIGHT_VS, LIGHT_FS],
      sprite: [SPR_VS, SPR_FS], ssr: [FS_VS, SSR_FS], mblur: [FS_VS, MBLUR_FS], pre: [FS_VS, PRE_FS],
      down: [FS_VS, DOWN_FS], up: [FS_VS, UP_FS], comp: [FS_VS, COMP_FS]
    };
  }
}

/* ---------- the engine ---------- */
class NeoEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.failed = false;
    this.lost = false;
    this.gl = null;
    this.resolutionScale = 1;      // internal resolution multiplier (0.5..1)
    this.autoResolution = true;    // drop resolutionScale automatically if frames run long
    this.cssW = 0; this.cssH = 0; this.dpr = 1; this.W = 0; this.H = 0;
    this._logged = {};
    this._time = 0; this._dt = 0.016; this._frameNo = 0;
    this._f = {}; this._fx = [];
    this._prevUx = null; this._prevUy = 0; this._camUx = 0; this._camUy = 0;
    this._dux = 0; this._duy = 0;
    this._lastNow = 0; this._ema = 16; this._slow = 0; this._emaN = 0;
    this.MAXL = 224; this.MAXS = 4096;
    this.lightData = new Float32Array(this.MAXL * 7); this.nLights = 0;
    this.spriteData = new Float32Array(this.MAXS * 12); this.nSprites = 0;
    this.ghostModels = new Float32Array(12 * 16); this.ghostMeshes = []; this.nGhosts = 0;
    this.vp = new Float32Array(16); this.ivp = new Float32Array(16); this.model = new Float32Array(16);
    this._vn = [0, 0]; this._sparkLights = 0;
    this.sx = 1; this.sy = 1; this.zoom = 1;
    const TILT = 35 * Math.PI / 180;
    this.st = Math.sin(TILT); this.ct = Math.cos(TILT); this.ZR = 2600;
    this.T = null; this.P = null; this.M = null; this.rocks = new Map(); this.plates = null;
    this.hdr = false; this.hdrK = 0.25; this.emK = 0.125;
    this.badgeTex = null; this.hasBadge = false; this._badgeSrc = null;
    try {
      const gl = (canvas && canvas.getContext) ? canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        powerPreference: 'high-performance', preserveDrawingBuffer: false
      }) : null;
      if (!gl) { this.failed = true; this._logOnce('nogl', 'WebGL2 unavailable; NeoEngine disabled'); return; }
      this.gl = gl;
      if (canvas.addEventListener) {
        canvas.addEventListener('webglcontextlost', (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); this.lost = true; }, false);
        canvas.addEventListener('webglcontextrestored', () => {
          try {
            this.lost = false; this.T = null; this.rocks = new Map(); this.plates = null;
            this._badgeSrc = null; this.hasBadge = false;
            this.initPBRRenderPipeline();
            if (this.cssW > 0) { this.W = 0; this.resize(this.cssW, this.cssH, this.dpr); }
          } catch (e) { this.failed = true; this._logOnce('restore', e); }
        }, false);
      }
      this.initPBRRenderPipeline();
    } catch (e) {
      this.failed = true;
      this._logOnce('init', e);
    }
  }

  _logOnce(key, e) {
    if (this._logged[key]) return;
    this._logged[key] = true;
    try { if (typeof console !== 'undefined') console.error('[NeoEngine] ' + key + ':', e); } catch (_) { /* ignore */ }
  }

  /* ---------- pipeline setup ---------- */
  initPBRRenderPipeline() {
    const gl = this.gl;
    if (!gl) { this.failed = true; return; }
    const src = NeoGLSL.get();
    this.P = {};
    for (const name in src) {
      const p = this._program(name, src[name][0], src[name][1]);
      if (!p) { this.failed = true; return; }
      this.P[name] = p;
    }
    /* HDR capability: need renderable half-float targets, else scaled LDR fallback */
    this.hdr = false;
    try {
      const ext = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
      if (ext) {
        const t = this._tex(gl.RGBA16F, 4, 4, gl.LINEAR);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        this.hdr = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb); gl.deleteTexture(t);
      }
    } catch (e) { this.hdr = false; }
    this.hdrK = this.hdr ? 1 : 0.25;
    this.emK = this.hdr ? 1 : 0.125;
    if (!this.hdr) this._logOnce('ldr', 'float render targets unavailable; using scaled 8-bit HDR fallback');

    /* static geometry */
    this.fsVAO = gl.createVertexArray();
    this.quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.lightVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lightVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.lightData.byteLength, gl.DYNAMIC_DRAW);
    this.lightVAO = gl.createVertexArray();
    gl.bindVertexArray(this.lightVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lightVBO);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, 16); gl.vertexAttribDivisor(2, 1);

    this.spriteVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteVBO);
    gl.bufferData(gl.ARRAY_BUFFER, this.spriteData.byteLength, gl.DYNAMIC_DRAW);
    this.spriteVAO = gl.createVertexArray();
    gl.bindVertexArray(this.spriteVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteVBO);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 48, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 48, 12); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 48, 24); gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 2, gl.FLOAT, false, 48, 40); gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);

    this.M = {
      player: this._mesh(NeoMesh.player()), worker: this._mesh(NeoMesh.worker()),
      warrior: this._mesh(NeoMesh.warrior()), crystal: this._mesh(NeoMesh.crystal()),
      bomb: this._mesh(NeoMesh.bomb()), eye: this._mesh(NeoMesh.bossEye()),
      pupil: this._mesh(NeoMesh.bossPupil()), throat: this._mesh(NeoMesh.bossThroat())
    };

    /* 1x1 placeholder badge texture */
    this.badgeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.badgeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.disable(gl.CULL_FACE);
    gl.depthFunc(gl.LESS);
    gl.clearColor(0, 0, 0, 1);
    if (this.cssW > 0 && this.W > 0) this._allocTargets();
  }

  _shader(type, source, name) {
    const gl = this.gl, s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      this._logOnce('shader:' + name + (type === gl.VERTEX_SHADER ? ':vs' : ':fs'), 'compile failed\n' + log);
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  _program(name, vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this._shader(gl.VERTEX_SHADER, vsSrc, name), fs = this._shader(gl.FRAGMENT_SHADER, fsSrc, name);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      this._logOnce('link:' + name, 'link failed\n' + gl.getProgramInfoLog(p));
      gl.deleteProgram(p);
      return null;
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (!info) continue;
      u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { p: p, u: u };
  }

  _mesh(builder) {
    const gl = this.gl, data = new Float32Array(builder.d);
    const vao = gl.createVertexArray(), vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 3, gl.FLOAT, false, 48, i * 12);
    }
    gl.bindVertexArray(null);
    return { vao: vao, vbo: vbo, n: data.length / 12, last: 0, cx: 0, cz: 0 };
  }

  _tex(ifmt, w, h, filter) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _fbo(colors, depth) {
    const gl = this.gl, fb = gl.createFramebuffer(), bufs = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    for (let i = 0; i < colors.length; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, colors[i], 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    gl.drawBuffers(bufs);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) this._logOnce('fbo', 'framebuffer incomplete: 0x' + st.toString(16));
    return fb;
  }

  _freeTargets() {
    const gl = this.gl, T = this.T;
    if (!T) return;
    for (const t of T.textures) gl.deleteTexture(t);
    for (const f of T.fbos) gl.deleteFramebuffer(f);
    this.T = null;
  }

  _allocTargets() {
    const gl = this.gl, W = this.W, H = this.H;
    this._freeTargets();
    const hf = this.hdr ? gl.RGBA16F : gl.RGBA8;
    const T = { textures: [], fbos: [], bloom: [] };
    const tex = (f, w, h, filt) => { const t = this._tex(f, w, h, filt); T.textures.push(t); return t; };
    const fbo = (c, d) => { const f = this._fbo(c, d); T.fbos.push(f); return f; };
    T.g0 = tex(gl.RGBA8, W, H, gl.NEAREST);
    T.g1 = tex(gl.RGBA8, W, H, gl.NEAREST);
    T.g2 = tex(hf, W, H, gl.NEAREST);
    T.g3 = tex(gl.RGBA8, W, H, gl.NEAREST);
    T.depth = tex(gl.DEPTH_COMPONENT24, W, H, gl.NEAREST);
    T.fboG = fbo([T.g0, T.g1, T.g2, T.g3], T.depth);
    T.hdrA = tex(hf, W, H, gl.LINEAR);
    T.hdrB = tex(hf, W, H, gl.LINEAR);
    T.fboA = fbo([T.hdrA], null);
    T.fboAD = fbo([T.hdrA], T.depth);
    T.fboB = fbo([T.hdrB], null);
    let w = W >> 1, h = H >> 1;
    for (let i = 0; i < 6 && w >= 4 && h >= 4; i++) {
      const t = tex(hf, w, h, gl.LINEAR);
      T.bloom.push({ tex: t, fbo: fbo([t], null), w: w, h: h });
      w >>= 1; h >>= 1;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.T = T;
  }

  resize(cssWidth, cssHeight, devicePixelRatio) {
    try {
      this.cssW = Math.max(1, +cssWidth || 1);
      this.cssH = Math.max(1, +cssHeight || 1);
      this.dpr = Math.min(2, Math.max(0.5, +devicePixelRatio || 1));
      const s = Math.min(1, Math.max(0.35, this.resolutionScale));
      const W = Math.max(8, Math.round(this.cssW * this.dpr * s));
      const H = Math.max(8, Math.round(this.cssH * this.dpr * s));
      if (W === this.W && H === this.H && this.T) return;
      this.W = W; this.H = H;
      if (this.canvas) { this.canvas.width = W; this.canvas.height = H; }
      if (this.failed || this.lost || !this.gl) return;
      this._allocTargets();
    } catch (e) { this._logOnce('resize', e); }
  }

  setResolutionScale(s) {
    this.resolutionScale = Math.min(1, Math.max(0.35, +s || 1));
    if (this.cssW > 0) this.resize(this.cssW, this.cssH, this.dpr);
  }

  /* ---------- small helpers ---------- */
  _use(prog) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.uniform1f(prog.u.uHdrK, this.hdrK);
    gl.uniform1f(prog.u.uEmK, this.emK);
    gl.uniform1f(prog.u.uTime, this._time % 3600);
    return prog.u;
  }
  _bind(unit, tex, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }
  _fs() { const gl = this.gl; gl.bindVertexArray(this.fsVAO); gl.drawArrays(gl.TRIANGLES, 0, 3); }

  _light(x, y, z, r, cr, cg, cb) {
    if (this.nLights >= this.MAXL || !(r > 0)) return;
    const d = this.lightData, o = this.nLights++ * 7;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = r; d[o + 4] = cr; d[o + 5] = cg; d[o + 6] = cb;
  }
  _sprite(x, y, z, sx, sy, rot, r, g, b, a, kind, extra) {
    if (this.nSprites >= this.MAXS) return;
    const d = this.spriteData, o = this.nSprites++ * 12;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = sx; d[o + 4] = sy; d[o + 5] = rot;
    d[o + 6] = r; d[o + 7] = g; d[o + 8] = b; d[o + 9] = a; d[o + 10] = kind; d[o + 11] = extra || 0;
  }
  /* model = T(x,y,z) * Ry(yaw) * Rx(roll) * S(s) * T(lx,ly,lz) */
  _model(x, y, z, yaw, roll, s, lx, ly, lz) {
    const m = this.model, ca = Math.cos(yaw), sa = Math.sin(yaw), cr = Math.cos(roll), sr = Math.sin(roll);
    m[0] = ca * s; m[1] = 0; m[2] = sa * s; m[3] = 0;
    m[4] = -sa * sr * s; m[5] = cr * s; m[6] = ca * sr * s; m[7] = 0;
    m[8] = -sa * cr * s; m[9] = -sr * s; m[10] = ca * cr * s; m[11] = 0;
    m[12] = x + m[0] * lx + m[4] * ly + m[8] * lz;
    m[13] = y + m[1] * lx + m[5] * ly + m[9] * lz;
    m[14] = z + m[2] * lx + m[6] * ly + m[10] * lz;
    m[15] = 1;
  }
  /* G-buffer draw of a mesh with the current model matrix */
  _draw(mesh, kind, tr, tg, tb, er, eg, eb, f0, f1, f2, f3, vx, vy, seed) {
    const gl = this.gl, u = this.P.gbuf.u;
    const dt = this._dt;
    const nx = ((vx || 0) * dt - this._dux) * this.sx;
    const ny = -((vy || 0) * dt - this._duy) * this.ct * this.sy;
    gl.uniformMatrix4fv(u.uModel, false, this.model);
    gl.uniform3f(u.uTint, tr, tg, tb);
    gl.uniform3f(u.uEmis, er, eg, eb);
    gl.uniform4f(u.uFx, f0, f1, f2, f3);
    gl.uniform1i(u.uKind, kind);
    gl.uniform2f(u.uVel, nx, ny);
    gl.uniform1f(u.uSeed, seed || 0);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.n);
  }

  static _invert(m, o) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) det = 1e-12;
    det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  }

  /* ---------- frame ---------- */
  processSystemLogic(entities, camera, frame) {
    try {
      if (this.failed || this.lost || !this.gl) return;
      if (this.gl.isContextLost && this.gl.isContextLost()) return;
      if (!this.T) { if (this.W > 0) this._allocTargets(); if (!this.T) return; }
      frame = frame || {}; camera = camera || {};
      this._f = frame;
      this._time = +frame.time || 0;
      this._dt = frame.paused ? 0 : Math.min(0.05, Math.max(0, +frame.dt || 0));
      this._frameNo++;
      this._adapt();
      this._setupCamera(camera);
      this._updateBadge(frame.badgeImage);
      this.clearBufferPass();
      this.renderEntities3DPlane(Array.isArray(entities) ? entities : [], camera);
      this.computeRayTracedGlossReflections();
      this.applyVolumetricPostFX();
    } catch (e) {
      this._logOnce('frame', e);
    }
  }

  _adapt() {
    if (!this.autoResolution || typeof performance === 'undefined' || !performance.now) return;
    const now = performance.now(), d = now - this._lastNow;
    this._lastNow = now;
    if (!(d > 0 && d < 100)) { this._emaN = 0; return; }
    this._ema = this._ema * 0.95 + d * 0.05;
    if (++this._emaN < 90) return;
    this._emaN = 0;
    if (this._ema > 22) this._slow++; else this._slow = 0;
    if (this._slow >= 3 && this.resolutionScale > 0.5) {
      this._slow = 0; this._ema = 16;
      this.resolutionScale = Math.max(0.5, this.resolutionScale * 0.85);
      this.resize(this.cssW, this.cssH, this.dpr);
    }
  }

  _setupCamera(camera) {
    const W = this.W, H = this.H, zoom = camera.zoom > 0 ? +camera.zoom : 1;
    const short = Math.min(W, H), long = Math.max(W, H);
    let units = 900;
    if (units * long / short > 1600) units = 1600 * short / long;
    const ppu = short * zoom / units;
    const sx = 2 * ppu / W, sy = 2 * ppu / H, st = this.st, ct = this.ct, ZR = this.ZR;
    const cx = +camera.shakeX || 0, cz = +camera.shakeY || 0;
    const m = this.vp;
    m[0] = sx; m[1] = 0; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = sy * st; m[6] = -ct / ZR; m[7] = 0;
    m[8] = 0; m[9] = -sy * ct; m[10] = -st / ZR; m[11] = 0;
    m[12] = -sx * cx; m[13] = sy * ct * cz; m[14] = st * cz / ZR; m[15] = 1;
    NeoEngine._invert(m, this.ivp);
    this.sx = sx; this.sy = sy; this.zoom = zoom;
    const ux = (typeof camera.ux === 'number') ? camera.ux : (+camera.x || 0);
    const uy = (typeof camera.uy === 'number') ? camera.uy : (+camera.y || 0);
    let dux = 0, duy = 0;
    if (this._prevUx !== null && this._dt > 0) {
      dux = ux - this._prevUx; duy = uy - this._prevUy;
      if (Math.abs(dux) > 300 || Math.abs(duy) > 300) { dux = 0; duy = 0; }
    }
    this._prevUx = ux; this._prevUy = uy;
    this._camUx = ux; this._camUy = uy; this._dux = dux; this._duy = duy;
  }

  _updateBadge(img) {
    if (!img || img === this._badgeSrc) return;
    if (img.complete === false) return;
    const w = img.naturalWidth || img.width || 0;
    if (!(w > 0)) return;
    this._badgeSrc = img;
    const gl = this.gl;
    try {
      gl.bindTexture(gl.TEXTURE_2D, this.badgeTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.hasBadge = true;
    } catch (e) {
      this.hasBadge = false;
      this._logOnce('badge', e);
    }
  }

  clearBufferPass() {
    const gl = this.gl, T = this.T;
    if (!this._clr) {
      this._clr = [new Float32Array([0, 0, 0, 0]), new Float32Array([0.5, 0.5, 1, 1]),
        new Float32Array([0, 0, 0, 1]), new Float32Array([128 / 255, 128 / 255, 0, 1]), new Float32Array([1])];
    }
    this.nLights = 0; this.nSprites = 0; this.nGhosts = 0; this._sparkLights = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fboG);
    gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    for (let i = 0; i < 4; i++) gl.clearBufferfv(gl.COLOR, i, this._clr[i]);
    gl.clearBufferfv(gl.DEPTH, 0, this._clr[4]);
  }

  /* ---------- entities -> G-buffer + lights + sprites, then lighting + forward FX ---------- */
  renderEntities3DPlane(entities, camera) {
    const gl = this.gl, T = this.T;
    const u = this._use(this.P.gbuf);
    gl.uniformMatrix4fv(u.uVP, false, this.vp);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!e || typeof e.rx !== 'number' || typeof e.ry !== 'number') continue;
      try {
        switch (e.type) {
          case 'player': this._ePlayer(e); break;
          case 'asteroid': this._eAsteroid(e); break;
          case 'crystal': this._eCrystal(e); break;
          case 'worker': this._eWorker(e); break;
          case 'warrior': this._eWarrior(e); break;
          case 'shot': this._eShot(e); break;
          case 'bomb': this._eBomb(e); break;
          case 'beam': this._eBeam(e); break;
          case 'particle': this._eParticle(e); break;
          case 'boss': this._eBoss(e); break;
          default: break;
        }
      } catch (err) { this._logOnce('entity:' + e.type, err); }
    }
    this._transients();
    if ((this._frameNo & 127) === 0) this._evictRocks();

    /* lighting: ambient/IBL/backdrop, then additive point-light volumes */
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fboA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    const f = this._f, voice = Math.min(1, Math.max(0, +f.voiceLevel || 0)), dread = Math.min(1, Math.max(0, +f.dread || 0));
    let a = this._use(this.P.amb);
    this._bind(0, T.g0, a.uG0); this._bind(1, T.g1, a.uG1); this._bind(2, T.g2, a.uG2);
    this._bind(3, T.depth, a.uDepth); this._bind(4, this.badgeTex, a.uBadge);
    gl.uniform3f(a.uV, 0, this.ct, this.st);
    const hx = 1 / this.sx, hy = 1 / this.sy;
    gl.uniform2f(a.uHalf, hx, hy);
    gl.uniform2f(a.uCam, this._camUx % 200000, this._camUy % 200000);
    const P = 2800, wrap = v => (((v + P / 2) % P) + P) % P - P / 2;
    gl.uniform3f(a.uMoon, wrap(-this._camUx * 0.02 + 380), wrap(-this._camUy * 0.02 - 170), 235);
    gl.uniform1f(a.uHasBadge, this.hasBadge ? 1 : 0);
    gl.uniform1f(a.uVoice, voice);
    gl.uniform1f(a.uDread, dread);
    gl.uniform1f(a.uZR2, this.ZR * 2);
    gl.uniform2f(a.uAoR, 14 * this.sx * 0.5, 14 * this.sy * 0.5);
    this._fs();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (this.nLights > 0) {
      a = this._use(this.P.light);
      this._bind(0, T.g0, a.uG0); this._bind(1, T.g1, a.uG1); this._bind(3, T.depth, a.uDepth);
      gl.uniformMatrix4fv(a.uVP, false, this.vp);
      gl.uniformMatrix4fv(a.uInvVP, false, this.ivp);
      gl.uniform3f(a.uV, 0, this.ct, this.st);
      gl.uniform2f(a.uScale, this.sx, this.sy);
      gl.uniform2f(a.uPx, 1 / this.W, 1 / this.H);
      gl.bindVertexArray(this.lightVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lightVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lightData, 0, this.nLights * 7);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nLights);
    }

    /* forward additive FX, depth-tested against the G-buffer (depth not sampled here) */
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fboAD);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    if (this.nGhosts > 0) {
      a = this._use(this.P.holo);
      gl.uniformMatrix4fv(a.uVP, false, this.vp);
      const pulse = 0.55 + 0.25 * Math.sin(this._time * 2.3);
      gl.uniform4f(a.uHolo, 0.1, 0.75, 1.0, pulse);
      for (let i = 0; i < this.nGhosts; i++) {
        gl.uniformMatrix4fv(a.uModel, false, this.ghostModels.subarray(i * 16, i * 16 + 16));
        gl.bindVertexArray(this.ghostMeshes[i].vao);
        gl.drawArrays(gl.TRIANGLES, 0, this.ghostMeshes[i].n);
      }
    }
    if (this.nSprites > 0) {
      a = this._use(this.P.sprite);
      this._bind(4, this.badgeTex, a.uBadge);
      gl.uniformMatrix4fv(a.uVP, false, this.vp);
      gl.uniform3f(a.uUp, 0, this.st, -this.ct);
      gl.uniform1f(a.uHasBadge, this.hasBadge ? 1 : 0);
      gl.bindVertexArray(this.spriteVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.spriteData, 0, this.nSprites * 12);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nSprites);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  /* thruster: volumetric cone lying in the ground plane, nozzle at (x,z), pointing along `dir` */
  _cone(x, y, z, dir, halfLen, halfW, r, g, b, a, seed) {
    this._sprite(x + Math.cos(dir) * halfLen, y, z + Math.sin(dir) * halfLen, halfLen, halfW, dir, r, g, b, a, 6, seed || 0);
  }

  _ePlayer(e) {
    const t = this._time;
    if (e.invuln > 0 && (Math.floor(t * 14) & 1)) return;
    const th = Math.min(1, Math.max(0, +e.thrust || 0)), a = +e.angle || 0, s = (e.radius || 14) / 14 * 1.35;
    const ca = Math.cos(a), sa = Math.sin(a), vx = +e.vx || 0, vy = +e.vy || 0;
    const roll = Math.max(-0.55, Math.min(0.55, (-vx * sa + vy * ca) * 0.0016));
    this._model(e.rx, 14, e.ry, a, roll, s, 0, 0, 0);
    const k = 1.6 + th * 6;
    this._draw(this.M.player, 0, 1, 1, 1, k, k, k, 0, 0, 0, 0, vx, vy, 1.7);
    const tx = e.rx - ca * 13 * s, tz = e.ry - sa * 13 * s;
    this._cone(tx, 13, tz, a + Math.PI, (9 + th * 46) * s, (4.5 + th * 4) * s, 0.1, 0.75, 1.0, 0.5 + th * 3.2, 1);
    this._sprite(tx, 14, tz, (7 + th * 12) * s, (7 + th * 12) * s, 0, 0.2, 0.85, 1.0, 0.5 + th * 1.4, 0, 0);
    this._light(tx - ca * 12, 16, tz - sa * 12, 130 + th * 130, 0.1 * (1 + th * 8), 0.7 * (1 + th * 8), 1.0 * (1 + th * 8));
    if (e.firing) {
      const fl = 0.6 + 0.4 * Math.sin(t * 90);
      this._light(e.rx + ca * 24 * s, 18, e.ry + sa * 24 * s, 120, 1.2 * fl, 4.5 * fl, 5 * fl);
      this._sprite(e.rx + ca * 21 * s, 15, e.ry + sa * 21 * s, 8 * s, 8 * s, 0, 0.4, 0.95, 1.0, 1.2 * fl, 0, 0);
    }
    if (e.invuln > 0) this._sprite(e.rx, 14, e.ry, 30 * s, 30 * s, 0, 0.1, 0.8, 1.0, 0.7, 1, 0);
  }

  _eAsteroid(e) {
    const R = e.radius || 40, seed = (e.seed | 0);
    let mesh = this.rocks.get(seed);
    if (!mesh) {
      mesh = this._mesh(NeoMesh.asteroid(Array.isArray(e.shape) ? e.shape : null, seed));
      this.rocks.set(seed, mesh);
    }
    mesh.last = this._frameNo;
    const heat = Math.min(1, Math.max(0, +e.heat || 0)), rich = Math.min(1, Math.max(0, e.rich === undefined ? 0.5 : +e.rich || 0));
    this._model(e.rx, 0, e.ry, +e.spin || 0, 0, R, 0, 0, 0);
    this._draw(mesh, 1, 1, 1, 1, 0, 0, 0, heat, rich, 0, 0, e.vx, e.vy, (Math.abs(seed) % 89) * 0.37);
    if (heat > 0.03) {
      this._light(e.rx, R * 0.9 + 10, e.ry, R * 2.2 + 70, 7 * heat, 2.6 * heat, 0.5 * heat);
      this._sprite(e.rx, R * 0.75, e.ry, R * 1.5, R * 1.5, 0, 1.0, 0.4, 0.08, 0.3 * heat, 0, 0);
    }
  }

  _eCrystal(e) {
    const t = this._time, sd = (e.seed | 0) % 97, s = (e.radius || 6) / 6;
    const tw = 0.6 + 0.4 * Math.sin(t * 7 + sd * 1.3);
    const y = 13 + 2.5 * Math.sin(t * 3 + sd);
    this._model(e.rx, y, e.ry, (+e.age || t) * 1.7 + sd, 0.45, s, 0, 0, 0);
    const k = 2.0 + 2.2 * tw;
    this._draw(this.M.crystal, 2, 1, 1, 1, k, k, k, 0, 0, 0, 0, e.vx, e.vy, sd);
    this._sprite(e.rx, y + 2, e.ry, 15 * s, 15 * s, 0, 1.0, 0.7, 0.12, 0.45 * tw, 0, 0);
    this._light(e.rx, y + 8, e.ry, 90, 2.4 * tw, 1.7 * tw, 0.25 * tw);
  }

  _eWorker(e) {
    const t = this._time, a = +e.angle || 0, s = (e.radius || 12) / 12 * 1.35, ca = Math.cos(a), sa = Math.sin(a);
    const vx = +e.vx || 0, vy = +e.vy || 0, sp = Math.hypot(vx, vy);
    this._model(e.rx, 9, e.ry, a, 0, s, 0, 0, 0);
    this._draw(this.M.worker, 0, 1, 1, 1, 2.2, 2.2, 2.2, 0, 0, 0, 0, vx, vy, 4.3);
    const tx = e.rx - ca * 10 * s, tz = e.ry - sa * 10 * s, pw = Math.min(1, sp / 160);
    if (pw > 0.03) this._cone(tx, 11, tz, a + Math.PI, (5 + pw * 16) * s, 5 * s, 0.15, 0.4, 1.0, 0.4 + pw * 1.6, 2);
    this._light(tx - ca * 6, 14, tz - sa * 6, 80, 0.2 + pw, 0.5 + pw * 1.5, 1.4 + pw * 3);
    if (e.carrying) {
      this._model(e.rx + ca * 14 * s, 12, e.ry + sa * 14 * s, t * 2.2, 0.5, 0.75 * s, 0, 0, 0);
      this._draw(this.M.crystal, 2, 1, 1, 1, 3, 3, 3, 0, 0, 0, 0, vx, vy, 2);
      this._light(e.rx + ca * 14 * s, 20, e.ry + sa * 14 * s, 75, 2.2, 1.5, 0.2);
    }
    if (e.mining) {
      const fl = 0.5 + 0.5 * Math.sin(t * 50 + e.rx);
      this._light(e.rx + ca * 16 * s, 16, e.ry + sa * 16 * s, 70, 0.4 * fl, 1.2 * fl, 3.5 * fl);
    }
  }

  _eWarrior(e) {
    const a = +e.angle || 0, s = (e.radius || 16) / 16 * 1.3, ca = Math.cos(a), sa = Math.sin(a);
    const ch = Math.min(1, Math.max(0, +e.charge || 0)), vx = +e.vx || 0, vy = +e.vy || 0, sp = Math.hypot(vx, vy);
    const roll = Math.max(-0.6, Math.min(0.6, (-vx * sa + vy * ca) * 0.002));
    this._model(e.rx, 13, e.ry, a, roll, s, 0, 0, 0);
    const k = 1.6 + ch * 10;
    this._draw(this.M.warrior, 0, 1, 1, 1, k, k, k, 0, 0, ch * ch * 0.15, 0, vx, vy, 8.1);
    const tx = e.rx - ca * 11 * s, tz = e.ry - sa * 11 * s, pw = Math.min(1, sp / 220);
    this._cone(tx, 13, tz, a + Math.PI, (7 + pw * 26) * s, 5 * s, 1.0, 0.12, 0.3, 0.5 + pw * 2, 3);
    this._light(tx - ca * 8, 16, tz - sa * 8, 90, 2.5 + pw * 3, 0.3, 0.7 + pw);
    if (ch > 0.03) {
      this._light(e.rx + ca * 18 * s, 20, e.ry + sa * 18 * s, 100 + 170 * ch, 11 * ch, 1.0 * ch, 2.6 * ch);
      this._sprite(e.rx + ca * 20 * s, 15, e.ry + sa * 20 * s, (6 + 18 * ch) * s, (6 + 18 * ch) * s, 0, 1.0, 0.15, 0.35, 0.5 + 1.8 * ch, 0, 0);
    }
  }

  _eShot(e) {
    const enemy = e.owner === 'enemy';
    const r = enemy ? 1.0 : 0.1, g = enemy ? 0.14 : 0.9, b = enemy ? 0.4 : 1.0;
    const vx = +e.vx || 0, vy = +e.vy || 0;
    const a = (vx * vx + vy * vy > 1) ? Math.atan2(vy, vx) : (+e.angle || 0);
    const s = (e.radius || 3) / 3;
    this._sprite(e.rx, 14, e.ry, 15 * s, 4.5 * s, a, r, g, b, 3.2, 3, 0);
    this._sprite(e.rx, 14, e.ry, 17 * s, 17 * s, 0, r, g, b, 0.7, 0, 0);
    this._light(e.rx, 20, e.ry, 140, r * 7.5, g * 7.5, b * 7.5);
  }

  _eBomb(e) {
    const t = this._time, age = +e.age || t, s = (e.radius || 7) / 7;
    const vx = +e.vx || 0, vy = +e.vy || 0;
    const pu = 0.75 + 0.25 * Math.sin(t * 22);
    this._model(e.rx, 16, e.ry, age * 6, age * 4.3, s, 0, 0, 0);
    this._draw(this.M.bomb, 2, 1, 1, 1, 3.5 * pu, 3.5 * pu, 3.5 * pu, 0, 0, 0, 0, vx, vy, 5);
    this._sprite(e.rx, 16, e.ry, 30 * s, 30 * s, 0, 0.45, 1.0, 0.4, 1.3 * pu, 0, 0);
    if (vx * vx + vy * vy > 4) {
      const va = Math.atan2(vy, vx) + Math.PI;
      this._cone(e.rx + Math.cos(va) * 5, 15, e.ry + Math.sin(va) * 5, va, 34 * s, 8 * s, 0.4, 1.0, 0.35, 1.8, 4);
    }
    this._light(e.rx, 26, e.ry, 250, 5 * pu, 11.5 * pu, 4.4 * pu);
  }

  _eBeam(e) {
    const dx = +e.dx || 0, dy = +e.dy || 0, len = Math.hypot(dx, dy);
    if (len < 1) return;
    const I = Math.min(1, Math.max(0, e.intensity === undefined ? 1 : +e.intensity || 0));
    if (I <= 0.01) return;
    const wk = e.kind === 'worker';
    const r = wk ? 0.12 : 0.5, g = wk ? 0.38 : 0.95, b = 1.0;
    const a = Math.atan2(dy, dx), t = this._time;
    const fl = 0.75 + 0.25 * Math.sin(t * 61 + len);
    this._sprite(e.rx + dx * 0.5, 14, e.ry + dy * 0.5, len * 0.5, 4 + 5 * I, a, r, g, b, (0.4 + 1.6 * I) * fl, 5, len);
    const ex = e.rx + dx, ez = e.ry + dy;
    this._sprite(ex, 16, ez, 14 + 12 * I, 14 + 12 * I, 0, r, g, b, (0.8 + 1.2 * I) * fl, 0, 0);
    this._light(ex, 22, ez, 160, r * 9 * I * fl, g * 9 * I * fl, b * 9 * I * fl);
    const n = Math.min(4, Math.floor(len / 110));
    for (let i = 1; i <= n; i++) {
      const k = i / (n + 1);
      this._light(e.rx + dx * k, 20, e.ry + dy * k, 115, r * 3 * I, g * 3 * I, b * 3 * I);
    }
  }

  _eParticle(e) {
    const ml = e.maxLife > 0 ? e.maxLife : 1;
    const f = Math.min(1, Math.max(0, (+e.life || 0) / ml));
    if (f <= 0) return;
    const c = e.color || NeoEngine.WHITE, r = +c[0] || 0, g = +c[1] || 0, b = +c[2] || 0;
    const sz = Math.max(0.5, +e.size || 2);
    switch (e.kind) {
      case 'smoke':
        this._sprite(e.rx, 18, e.ry, sz * (1.7 - 0.7 * f), sz * (1.7 - 0.7 * f), 0, r * 0.35 + 0.02, g * 0.35 + 0.03, b * 0.35 + 0.05, 0.5 * f, 2, (+e.age || 0) + sz);
        break;
      case 'debris':
        this._sprite(e.rx, 14, e.ry, sz, sz, (+e.age || 0) * 6 + sz, r, g, b, 1.6 * f, 4, sz);
        break;
      case 'ring':
        this._sprite(e.rx, 10, e.ry, sz / 0.87, sz / 0.87, 0, r, g, b, 2.2 * f, 1, 0);
        if (this._sparkLights < 56) { this._sparkLights++; this._light(e.rx, 30, e.ry, Math.max(140, sz * 1.6), r * 3.5 * f, g * 3.5 * f, b * 3.5 * f); }
        break;
      default: {
        const vx = +e.vx || 0, vy = +e.vy || 0, sp = Math.hypot(vx, vy);
        const a = sp > 1 ? Math.atan2(vy, vx) : 0;
        this._sprite(e.rx, 14, e.ry, sz * 1.6 + sp * 0.022, Math.max(1.3, sz * 0.6), a, r, g, b, 2.6 * f, 3, 0);
        if (sz >= 1.5 && this._sparkLights < 56) {
          this._sparkLights++;
          this._light(e.rx, 16, e.ry, 48 + sz * 12, r * 2.6 * f, g * 2.6 * f, b * 2.6 * f);
        }
      }
    }
  }

  _bossPlates() {
    if (this.plates) return this.plates;
    let pieces = null, eyes = null;
    try {
      if (typeof Grimalkin !== 'undefined' && Grimalkin) {
        if (Array.isArray(Grimalkin.PIECES) && Grimalkin.PIECES.length >= 12) pieces = Grimalkin.PIECES;
        if (Array.isArray(Grimalkin.EYES) && Grimalkin.EYES.length >= 2) eyes = Grimalkin.EYES;
      }
    } catch (e) { pieces = null; }
    if (!pieces) pieces = NeoMesh.fallbackPieces();
    if (!eyes) eyes = [{ x: -0.5, y: 0.02 }, { x: 0.5, y: 0.02 }];
    const out = [];
    for (let i = 0; i < 12; i++) {
      let mesh = null;
      try {
        const poly = pieces[i] && pieces[i].poly;
        if (Array.isArray(poly) && poly.length >= 3) {
          mesh = this._mesh(NeoMesh.bossPlate(i, poly, eyes));
          let cx = 0, cz = 0;
          for (const p of poly) { cx += p[0] * 120; cz += p[1] * 120; }
          mesh.cx = cx / poly.length; mesh.cz = cz / poly.length;
        }
      } catch (e) { this._logOnce('plate' + i, e); mesh = null; }
      out.push(mesh);
    }
    this.plates = out; this.eyes = eyes;
    return out;
  }

  _eBoss(e) {
    const f = this._f, t = this._time, R = e.radius || 120, s = R / 120;
    const c01 = v => Math.min(1, Math.max(0, +v || 0));
    const voice = c01(f.voiceLevel), vb = Array.isArray(f.voiceBands) ? f.voiceBands : NeoEngine.ZERO3;
    const lo = c01(vb[0]), mi = c01(vb[1]), hi = c01(vb[2]);
    const awake = !!e.awake, dying = c01(e.dying), hit = c01(e.hitFlash), mo = c01(e.mouthOpen);
    const pieces = Array.isArray(e.pieces) ? e.pieces : [];
    const plates = this._bossPlates(), tilt = +e.tilt || 0, vx = +e.vx || 0, vy = +e.vy || 0;
    const baseY = 4 + (awake ? 5 * Math.sin(t * 1.3) : 0);
    const jaw = mo * 0.18 * 120;
    const ca = Math.cos(tilt), sa = Math.sin(tilt);
    const dim = 1 - 0.65 * dying;
    let built = 0;
    for (let i = 0; i < 12; i++) {
      const mesh = plates[i];
      if (pieces[i]) built++;
      if (!mesh) continue;
      const jz = i < 2 ? jaw : 0;
      if (pieces[i]) {
        const d2 = dying * dying;
        this._model(e.rx, baseY + d2 * ((i * 7) % 5) * 12, e.ry, tilt + d2 * ((i % 3) - 1) * 0.9, dying * (((i * 5) % 7) - 3) * 0.28, s,
          mesh.cx * dying * 1.5, 0, jz + mesh.cz * dying * 1.5);
        this._draw(mesh, 3, dim, dim, dim, 0, 0, 0, 0, 0, hit, dying, vx, vy, i * 3.7);
      } else if (!awake && dying === 0 && this.nGhosts < 12) {
        this._model(e.rx, baseY, e.ry, tilt, 0, s, 0, 0, jz);
        this.ghostModels.set(this.model, this.nGhosts * 16);
        this.ghostMeshes[this.nGhosts++] = mesh;
      }
    }
    const fade = (1 - dying) * (dying > 0 ? 0.45 + 0.55 * Math.abs(Math.sin(t * 43)) : 1);

    /* EMISSIVE_GLOW: eyes, driven by voiceLevel + voiceBands every frame */
    const eyes = this.eyes;
    let er, eg, eb, eI;
    if (awake) { er = 1.0; eg = Math.max(0.3, 0.9 - 0.45 * lo + 0.1 * hi); eb = 0.02 + 0.55 * hi; eI = 2.2 + 9 * voice + 0.4 * Math.sin(t * 9); }
    else { er = 1.0; eg = 0.5 + 0.2 * mi; eb = 0.08 + 0.3 * hi; eI = 0.32 + 0.12 * Math.sin(t * 1.5) + 3.2 * voice; }
    eI *= fade;
    const lookX = Math.max(-1, Math.min(1, +e.lookX || 0)), lookY = Math.max(-1, Math.min(1, +e.lookY || 0));
    for (let k = 0; k < 2; k++) {
      if (!pieces[5 + k]) continue;
      const ex = eyes[k].x * 120, ez = eyes[k].y * 120, ey = NeoMesh.bossDome(ex, ez) + 9;
      const sc = awake ? 1 : 1 - 0.0;
      this._model(e.rx, baseY, e.ry, tilt, 0, s, ex, ey, ez);
      this._draw(this.M.eye, 2, 0.1, 0.09, 0.02, er * eI, eg * eI, eb * eI, 0, 0, hit, 0, vx, vy, 3 + k);
      this._model(e.rx, baseY, e.ry, tilt, 0, s * sc, ex + lookX * 0.06 * 120, ey, ez + lookY * 0.04 * 120);
      this._draw(this.M.pupil, 2, 1, 1, 1, 0, 0, 0, 0, 0, hit * 0.3, 0, vx, vy, 6 + k);
      const wx = e.rx + s * (ex * ca - ez * sa), wz = e.ry + s * (ex * sa + ez * ca), wy = baseY + s * ey;
      const lI = eI * (awake ? 0.55 : 0.6);
      this._light(wx, wy + 34 * s, wz, (awake ? 430 : 210) * s, er * lI, eg * lI, eb * lI);
      const gs = (awake ? 30 + 34 * voice : 20 + 28 * voice) * s;
      this._sprite(wx, wy + 12, wz, gs, gs, 0, er, eg, eb, (awake ? 0.3 + 0.5 * voice : 0.12 + 0.55 * voice) * fade, 0, 0);
    }

    /* EMISSIVE_GLOW: mouth furnace */
    if (pieces[4] || pieces[0] || pieces[1]) {
      const mr = 1.0, mg = Math.min(1, 0.26 + 0.45 * mi), mb = 0.04 + 0.6 * hi;
      const mI = (awake ? 1.0 + 11 * voice + 2 * mo : 0.1 + 4.2 * voice) * fade;
      this._model(e.rx, baseY, e.ry, tilt, 0, s, 0, 0, jaw * 0.5);
      this._draw(this.M.throat, 2, 0.05, 0.02, 0.02, mr * mI, mg * mI, mb * mI, 0, 0, hit, 0, vx, vy, 9);
      const mz = 0.64 * 120 + jaw * 0.5, my = NeoMesh.bossDome(0, mz) + 22;
      const wx = e.rx + s * (-mz * sa), wz = e.ry + s * (mz * ca), wy = baseY + s * my;
      this._light(wx, wy + 20 * s, wz, (awake ? 500 : 230) * s, mr * mI * 0.5, mg * mI * 0.5, mb * mI * 0.5);
      if (awake || voice > 0.02) {
        const gs = (26 + 40 * voice + 14 * mo) * s;
        this._sprite(wx, wy, wz, gs, gs * 0.7, 0, mr, mg, mb, (0.2 + 0.6 * voice) * fade, 0, 0);
      }
    }

    if (awake && dying < 1) {
      this._sprite(e.rx, -40, e.ry, R * 2.3, R * 2.3, 0, 1.0, 0.14, 0.05, (0.12 + 0.3 * voice) * (1 - dying), 0, 0);
    } else if (!awake && dying === 0) {
      /* build site: holographic badge projected above the scaffold + marker ring */
      const frac = built / 12, pu = 0.7 + 0.3 * Math.sin(t * 2.1);
      this._sprite(e.rx, 190 * s, e.ry - 30 * s, 62 * s, 62 * s, 0, 0.55, 0.95, 1.0, (0.55 + 0.35 * frac) * pu, 7, 0);
      this._sprite(e.rx, 0, e.ry, R * 1.3 / 0.87, R * 1.3 / 0.87, 0, 0.1, 0.8, 1.0, 0.22 * pu, 1, 0);
      this._sprite(e.rx, 60 * s, e.ry, R * 0.9, R * 0.9, 0, 0.1, 0.6, 1.0, 0.1 * pu, 0, 0);
      this._light(e.rx, 150 * s, e.ry, 330 * s, 0.3 * pu, 1.6 * pu, 2.4 * pu);
    }
    if (hit > 0.01) this._light(e.rx, 140, e.ry, 620 * s, 12 * hit, 12 * hit, 12 * hit);
    if (dying > 0 && dying < 1) {
      const b = Math.sin(dying * Math.PI) * (0.5 + 0.5 * Math.abs(Math.sin(t * 31)));
      this._light(e.rx + Math.sin(t * 13) * R * 0.5, 120, e.ry + Math.cos(t * 17) * R * 0.5, 700 * s, 30 * b, 12 * b, 2 * b);
      this._sprite(e.rx, 60, e.ry, R * (1 + 2 * dying), R * (1 + 2 * dying), 0, 1.0, 0.5, 0.12, 1.4 * b, 0, 0);
    }
  }

  _transients() {
    const fx = this._fx, t = this._time;
    for (let i = fx.length - 1; i >= 0; i--) {
      const x = fx[i], k = (t - x.t0) / x.dur;
      if (!(k >= 0 && k < 1)) { fx.splice(i, 1); continue; }
      const f = (1 - k) * (1 - k), rx = x.x - this._camUx, ry = x.y - this._camUy, c = x.c, sz = x.size;
      this._light(rx, 40, ry, sz * 5 + 160, c[0] * 15 * f, c[1] * 15 * f, c[2] * 15 * f);
      this._sprite(rx, 24, ry, sz * (1.2 + 2.2 * k), sz * (1.2 + 2.2 * k), 0, c[0], c[1], c[2], 1.7 * f, 0, 0);
      this._sprite(rx, 12, ry, sz * (0.6 + 3.4 * k) / 0.87, sz * (0.6 + 3.4 * k) / 0.87, 0, c[0], c[1], c[2], 1.2 * f, 1, 0);
    }
  }

  _evictRocks() {
    const gl = this.gl;
    for (const [k, m] of this.rocks) {
      if (this._frameNo - m.last > 600) {
        gl.deleteVertexArray(m.vao); gl.deleteBuffer(m.vbo);
        this.rocks.delete(k);
      }
    }
  }

  /* ---------- screen-space gloss reflections (G-buffer ray march + emitter gloss) ---------- */
  computeRayTracedGlossReflections() {
    const gl = this.gl, T = this.T;
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fboB);
    gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    const u = this._use(this.P.ssr);
    this._bind(0, T.hdrA, u.uScene); this._bind(1, T.depth, u.uDepth);
    this._bind(2, T.g0, u.uG0); this._bind(3, T.g1, u.uG1);
    gl.uniformMatrix4fv(u.uVP, false, this.vp);
    gl.uniformMatrix4fv(u.uInvVP, false, this.ivp);
    gl.uniform3f(u.uV, 0, this.ct, this.st);
    gl.uniform1f(u.uThick, 45 / (2 * this.ZR));
    this._fs();
  }

  /* ---------- motion blur, bloom, ACES composite (voice-synced grade) ---------- */
  applyVolumetricPostFX() {
    const gl = this.gl, T = this.T, f = this._f, W = this.W, H = this.H;
    const c01 = v => Math.min(1, Math.max(0, +v || 0));
    const voice = c01(f.voiceLevel), dread = c01(f.dread);

    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fboA);
    let u = this._use(this.P.mblur);
    this._bind(0, T.hdrB, u.uScene); this._bind(1, T.g3, u.uG3); this._bind(2, T.depth, u.uDepth);
    gl.uniform2f(u.uBgVel, -this._dux * 0.12 * this.sx, this._duy * 0.12 * this.sy);
    gl.uniform1f(u.uShutter, this._dt > 0 ? 0.85 : 0);
    this._fs();

    const B = T.bloom, n = B.length;
    if (n > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, B[0].fbo);
      gl.viewport(0, 0, B[0].w, B[0].h);
      u = this._use(this.P.pre);
      this._bind(0, T.hdrA, u.uTex);
      gl.uniform2f(u.uPx, 0.5 / W, 0.5 / H);
      gl.uniform1f(u.uThr, 1.0);
      this._fs();
      u = this._use(this.P.down);
      for (let i = 1; i < n; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, B[i].fbo);
        gl.viewport(0, 0, B[i].w, B[i].h);
        this._bind(0, B[i - 1].tex, u.uTex);
        gl.uniform2f(u.uPx, 1 / B[i - 1].w, 1 / B[i - 1].h);
        this._fs();
      }
      u = this._use(this.P.up);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.uGain, 1.0);
      for (let i = n - 2; i >= 0; i--) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, B[i].fbo);
        gl.viewport(0, 0, B[i].w, B[i].h);
        this._bind(0, B[i + 1].tex, u.uTex);
        gl.uniform2f(u.uPx, 1 / B[i + 1].w, 1 / B[i + 1].h);
        this._fs();
      }
      gl.disable(gl.BLEND);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    u = this._use(this.P.comp);
    this._bind(0, T.hdrA, u.uScene);
    this._bind(1, n > 0 ? B[0].tex : T.hdrB, u.uBloom);
    const pulse = this._awakeT !== undefined ? Math.max(0, 1 - (this._time - this._awakeT) / 1.4) : 0;
    const speak = f.bossAwake ? voice : voice * 0.3;
    gl.uniform1f(u.uCA, 0.006 + 0.008 * dread + 0.04 * pulse + 0.006 * speak);
    gl.uniform1f(u.uBloomK, n > 0 ? (0.15 + 0.05 * speak + 0.1 * pulse) : 0);
    gl.uniform1f(u.uExposure, 1.0 + 0.5 * pulse);
    const fc = Array.isArray(f.flashColor) ? f.flashColor : NeoEngine.WHITE;
    gl.uniform4f(u.uFlash, +fc[0] || 0, +fc[1] || 0, +fc[2] || 0, c01(f.flash));
    gl.uniform1f(u.uDread, dread);
    gl.uniform1f(u.uVoice, voice);
    this._fs();
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /* ---------- one-shot FX hooks ---------- */
  onEvent(evt) {
    try {
      if (!evt || this.failed) return;
      const t = this._time;
      const add = (rx, ry, size, c, dur) => {
        if (this._fx.length > 48) this._fx.shift();
        this._fx.push({ x: this._camUx + (+rx || 0), y: this._camUy + (+ry || 0), t0: t, dur: dur, size: size, c: c });
      };
      switch (evt.type) {
        case 'explosion': {
          const size = Math.max(8, Math.min(400, +evt.size || 40));
          const c = Array.isArray(evt.color) ? [+evt.color[0] || 0, +evt.color[1] || 0, +evt.color[2] || 0] : [1, 0.6, 0.2];
          add(evt.rx, evt.ry, size, c, 0.4 + size * 0.004);
          break;
        }
        case 'bossAwake': this._awakeT = t; break;
        case 'bossDeath': add(evt.rx, evt.ry, 320, [1, 0.75, 0.3], 2.6); add(evt.rx, evt.ry, 160, [1, 1, 1], 0.9); this._awakeT = t; break;
        case 'playerDeath': add(evt.rx, evt.ry, 90, [0.2, 0.85, 1], 1.0); break;
        case 'modeEnter': this._fx.length = 0; this._prevUx = null; this._lastNow = 0; this._emaN = 0; break;
        default: break;
      }
    } catch (e) { this._logOnce('event', e); }
  }
}

NeoEngine.WHITE = [1, 1, 1];
NeoEngine.ZERO3 = [0, 0, 0];

if (typeof module !== "undefined") module.exports = { NeoEngine };
