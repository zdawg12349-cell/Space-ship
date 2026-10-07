import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Vector3 } from 'three';

/**
 * Geometry primitives for procedural vehicles. Every builder emits the custom attributes the
 * vehicle skin shader expects (aCyl, aMat, aLiv) so surface detail is laid out in physical
 * metres regardless of mesh tessellation.
 */

export interface SurfaceAttrs {
  frost?: number;
  soot?: number;
  livery?: number;
  panel?: number;
  /** livery v-range mapping: y range of the labelled section */
  livY0?: number;
  livY1?: number;
  /** livery u offset (rotation of decals around the axis, 0..1) */
  livU0?: number;
}

/** Accumulates triangles with the full vehicle attribute set. */
export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  cyl: number[] = [];
  mat: number[] = [];
  liv: number[] = [];
  idx: number[] = [];

  get vertexCount(): number { return this.pos.length / 3; }

  vertex(p: Vector3, n: Vector3, u: number, v: number, cyl: [number, number, number], a: SurfaceAttrs, liv: [number, number]): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.cyl.push(cyl[0], cyl[1], cyl[2]);
    this.mat.push(a.frost ?? 0, a.soot ?? 1, a.livery ?? 0, a.panel ?? 1);
    this.liv.push(liv[0], liv[1]);
    return this.vertexCount - 1;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aCyl', new BufferAttribute(new Float32Array(this.cyl), 3));
    g.setAttribute('aMat', new BufferAttribute(new Float32Array(this.mat), 4));
    g.setAttribute('aLiv', new BufferAttribute(new Float32Array(this.liv), 2));
    const n = this.vertexCount;
    g.setIndex(n > 65535 ? new BufferAttribute(new Uint32Array(this.idx), 1) : new BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** Append another builder's content transformed by m (normals by its rotation). */
  merge(o: GeoBuilder, m?: Matrix4): void {
    const base = this.vertexCount;
    const p = new Vector3(), n = new Vector3();
    // normals transform by the 3x3 inverse transpose (a 4x4 one would apply a perspective divide)
    const nm = m ? new Matrix3().getNormalMatrix(m) : null;
    for (let i = 0; i < o.vertexCount; i++) {
      p.set(o.pos[i * 3], o.pos[i * 3 + 1], o.pos[i * 3 + 2]);
      n.set(o.nor[i * 3], o.nor[i * 3 + 1], o.nor[i * 3 + 2]);
      if (m) { p.applyMatrix4(m); n.applyMatrix3(nm!).normalize(); }
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(n.x, n.y, n.z);
    }
    this.uv.push(...o.uv);
    this.cyl.push(...o.cyl);
    this.mat.push(...o.mat);
    this.liv.push(...o.liv);
    for (const i of o.idx) this.idx.push(i + base);
  }
}

export type Profile = [number, number][]; // (radius, y) pairs, bottom to top

export interface LatheOptions {
  segments?: number;
  thetaStart?: number;
  thetaLength?: number;
  /** lateral axis offset (x, z) */
  offset?: [number, number];
  attrs?: SurfaceAttrs;
  /** flip normals inward (inner surfaces) */
  inward?: boolean;
  /** close the ends with caps when the profile ends at r > 0 */
  capBottom?: boolean;
  capTop?: boolean;
  /** smooth normals across profile vertices (false = faceted rings, for sharp edges) */
  smooth?: boolean;
}

/**
 * Surface of revolution about the vehicle Y axis. Profile normals come from the profile
 * tangent; duplicate profile points create creases.
 */
export function lathe(gb: GeoBuilder, profile: Profile, o: LatheOptions = {}): void {
  const segs = o.segments ?? 64;
  const t0 = o.thetaStart ?? 0;
  const tl = o.thetaLength ?? Math.PI * 2;
  const full = Math.abs(tl - Math.PI * 2) < 1e-6;
  const ox = o.offset?.[0] ?? 0, oz = o.offset?.[1] ?? 0;
  const a = o.attrs ?? {};
  const n = profile.length;
  // profile normals (2D): per vertex averaged between adjacent segment normals unless creased
  const pn: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = profile[Math.max(0, i - 1)], next = profile[Math.min(n - 1, i + 1)];
    let dr: number, dy: number;
    // crease when duplicated points
    if (i > 0 && profile[i][0] === profile[i - 1][0] && profile[i][1] === profile[i - 1][1]) {
      dr = next[0] - profile[i][0]; dy = next[1] - profile[i][1];
    } else if (i < n - 1 && profile[i][0] === profile[i + 1][0] && profile[i][1] === profile[i + 1][1]) {
      dr = profile[i][0] - prev[0]; dy = profile[i][1] - prev[1];
    } else {
      dr = next[0] - prev[0]; dy = next[1] - prev[1];
    }
    const l = Math.hypot(dr, dy) || 1;
    // outward normal of a profile going up: (dy, -dr)
    let nr = dy / l, ny = -dr / l;
    if (o.inward) { nr = -nr; ny = -ny; }
    pn.push([nr, ny]);
  }
  // cumulative profile length for uv
  const vlen: number[] = [0];
  for (let i = 1; i < n; i++) vlen.push(vlen[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  const total = vlen[n - 1] || 1;
  const y0 = a.livY0 ?? profile[0][1], y1 = a.livY1 ?? profile[n - 1][1];
  const base = gb.vertexCount;
  const cols = segs + 1;
  const P = new Vector3(), N = new Vector3();
  for (let i = 0; i < n; i++) {
    const [r, y] = profile[i];
    for (let s = 0; s <= segs; s++) {
      const th = t0 + (s / segs) * tl;
      const c = Math.cos(th), sn = Math.sin(th);
      P.set(ox + c * r, y, oz + sn * r);
      N.set(c * pn[i][0], pn[i][1], sn * pn[i][0]);
      const thetaWrapped = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      // decal u runs opposite to theta so text reads correctly from outside
      const lu = (((1 - thetaWrapped / (Math.PI * 2)) + (a.livU0 ?? 0)) % 1 + 1) % 1;
      gb.vertex(P, N, s / segs, vlen[i] / total, [full && s === segs ? Math.PI * 2 : th, y, r], a, [lu, (y - y0) / Math.max(1e-3, y1 - y0)]);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < segs; s++) {
      const a0 = base + i * cols + s, b0 = a0 + 1, c0 = a0 + cols, d0 = c0 + 1;
      if (o.inward) { gb.tri(a0, b0, c0); gb.tri(b0, d0, c0); } else { gb.tri(a0, c0, b0); gb.tri(b0, c0, d0); }
    }
  }
  const cap = (i: number, up: boolean) => {
    const [r, y] = profile[i];
    if (r <= 1e-6) return;
    const cb = gb.vertexCount;
    N.set(0, up ? 1 : -1, 0);
    gb.vertex(P.set(ox, y, oz), N, 0.5, 0.5, [0, y, 0], a, [0, 0]);
    for (let s = 0; s <= segs; s++) {
      const th = t0 + (s / segs) * tl;
      gb.vertex(P.set(ox + Math.cos(th) * r, y, oz + Math.sin(th) * r), N, 0.5 + Math.cos(th) * 0.5, 0.5 + Math.sin(th) * 0.5, [th, y, r], a, [0, 0]);
    }
    for (let s = 0; s < segs; s++) {
      if (up) gb.tri(cb, cb + 2 + s, cb + 1 + s); else gb.tri(cb, cb + 1 + s, cb + 2 + s);
    }
  };
  if (o.capBottom) cap(0, false);
  if (o.capTop) cap(n - 1, true);
}

/** Axis-aligned box (optionally transformed) with flat normals. */
export function box(gb: GeoBuilder, sx: number, sy: number, sz: number, m: Matrix4, a: SurfaceAttrs = {}): void {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces: [Vector3, Vector3, Vector3][] = [
    [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, -1)],
    [new Vector3(-1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
    [new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(1, 0, 0)],
    [new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0)],
    [new Vector3(0, 0, 1), new Vector3(0, 1, 0), new Vector3(1, 0, 0)],
    [new Vector3(0, 0, -1), new Vector3(0, 1, 0), new Vector3(-1, 0, 0)],
  ];
  const nm = new Matrix3().getNormalMatrix(m);
  const P = new Vector3(), N = new Vector3(), C = new Vector3();
  for (const [n, u, v] of faces) {
    const b = gb.vertexCount;
    const ext = (d: Vector3) => Math.abs(d.x) * hx + Math.abs(d.y) * hy + Math.abs(d.z) * hz;
    const en = ext(n), eu = ext(u), ev = ext(v);
    // orient u x v along n
    const cross = new Vector3().crossVectors(u, v);
    const flip = cross.dot(n) < 0;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      P.copy(n).multiplyScalar(en).addScaledVector(u, su * eu).addScaledVector(v, sv * ev).applyMatrix4(m);
      N.copy(n).applyMatrix3(nm).normalize();
      C.copy(P);
      gb.vertex(P, N, (su + 1) / 2, (sv + 1) / 2, [Math.atan2(C.z, C.x), C.y, Math.hypot(C.x, C.z)], a, [0, 0]);
    }
    if (flip) { gb.tri(b, b + 2, b + 1); gb.tri(b, b + 3, b + 2); } else { gb.tri(b, b + 1, b + 2); gb.tri(b, b + 2, b + 3); }
  }
}

/** Cylinder between two points (struts, pipes, truss members). */
export function tube(gb: GeoBuilder, from: Vector3, to: Vector3, radius: number, segs = 8, a: SurfaceAttrs = {}, caps = false): void {
  const dir = new Vector3().subVectors(to, from);
  const len = dir.length();
  if (len < 1e-6) return;
  dir.normalize();
  const m = new Matrix4();
  const up = new Vector3(0, 1, 0);
  const q = new Matrix4().lookAt(new Vector3(), dir, Math.abs(dir.y) > 0.99 ? new Vector3(1, 0, 0) : up);
  // lookAt aligns -Z with dir; rotate so +Y aligns with dir
  const rot = new Matrix4().makeRotationX(-Math.PI / 2);
  m.copy(q).multiply(rot).setPosition(from);
  const t = new GeoBuilder();
  lathe(t, [[radius, 0], [radius, len]], { segments: segs, attrs: a, capBottom: caps, capTop: caps });
  gb.merge(t, m);
}

/** Ogive nose profile (tangent ogive) from base radius R over length L, optionally blunted. */
export function ogiveProfile(R: number, L: number, y0: number, steps = 24, tipRadius = 0): Profile {
  const rho = (R * R + L * L) / (2 * R);
  const out: Profile = [];
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * L; // distance from base
    const r = Math.sqrt(Math.max(0, rho * rho - x * x)) + R - rho;
    out.push([Math.max(tipRadius, r), y0 + x]);
  }
  if (tipRadius > 0) out.push([0, y0 + L + tipRadius * 0.3]);
  else out[out.length - 1][0] = 0;
  return out;
}

/** Ellipsoidal dome profile from radius R rising by height H (k: 0 = flat ... 1 = hemisphere). */
export function domeProfile(R: number, H: number, y0: number, up = true, steps = 12): Profile {
  const out: Profile = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI / 2;
    out.push([R * Math.cos(a), y0 + (up ? 1 : -1) * H * Math.sin(a)]);
  }
  return up ? out : out;
}

/**
 * Rocket nozzle bell: throat radius rt at y=yThroat, exit radius re at yThroat - L.
 * Rao-style parabola: initial angle thN, exit angle thE.
 */
export function bellProfile(rt: number, re: number, L: number, yThroat: number, thN = 0.52, thE = 0.14, steps = 20): Profile {
  // quadratic Bezier between throat (after a short circular arc) and exit
  const arcR = rt * 0.382;
  const nx = arcR * Math.sin(thN), ny = rt + arcR * (1 - Math.cos(thN));
  const ex = L, ey = re;
  // control point from intersection of tangent lines
  const m1 = Math.tan(thN), m2 = Math.tan(thE);
  const c1 = ny - m1 * nx, c2 = ey - m2 * ex;
  let qx = (c2 - c1) / (m1 - m2);
  let qy = m1 * qx + c1;
  if (!isFinite(qx) || qx < nx || qx > ex) { qx = (nx + ex) / 2; qy = (ny + ey) / 2; }
  const out: Profile = [];
  // from exit (bottom) to throat (top) so the profile goes upward in y
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const x = (1 - t) * (1 - t) * nx + 2 * (1 - t) * t * qx + t * t * ex;
    const r = (1 - t) * (1 - t) * ny + 2 * (1 - t) * t * qy + t * t * ey;
    out.push([r, yThroat - x]);
  }
  // throat arc
  for (let i = 1; i <= 4; i++) {
    const a = thN * (1 - i / 4);
    out.push([rt + arcR * (1 - Math.cos(a)), yThroat - arcR * Math.sin(a)]);
  }
  return out;
}

/** Utility: rotation matrix placing local +Y along the vehicle axis at angle theta around it. */
export function radialFrame(theta: number, radius: number, y: number, offset: [number, number] = [0, 0]): Matrix4 {
  const m = new Matrix4().makeRotationY(-theta);
  m.setPosition(offset[0] + Math.cos(theta) * radius, y, offset[1] + Math.sin(theta) * radius);
  return m;
}
