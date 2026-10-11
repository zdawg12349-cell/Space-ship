import {
  BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Material, Matrix4, Mesh, Object3D, Quaternion, Vector3,
} from 'three';
import { box, GeoBuilder, lathe, tube } from '../vehicle/shapes';

/**
 * Building blocks for launch-site infrastructure: steel lattice towers, trusses, catenary
 * wires, tanks, buildings, light masts and instanced vegetation. Everything is accumulated
 * into per-material batches so a whole complex renders in a few dozen draw calls.
 */

/** A lamp that lights the site's own surfaces after dark (site frame: x east, y up, z south). */
export interface SiteLamp {
  pos: Vector3;
  /** where the beam points (unit) */
  dir: Vector3;
  /** peak luminous intensity (kcd) */
  kcd: number;
  /** cosines of the beam's edge (dark) and of its core (full strength) */
  cone: [number, number];
  /** colour of the light (linear) */
  color: [number, number, number];
}

/** a small LED wall pack over a door: warm white, a broad downward spread */
const WALL_PACK = { kcd: 1.2, cone: [0.09, 0.7] as [number, number], color: [1, 0.8, 0.58] as [number, number, number] };

export class Batch {
  private gbs = new Map<Material, GeoBuilder>();
  get(m: Material): GeoBuilder {
    let g = this.gbs.get(m);
    if (!g) { g = new GeoBuilder(); this.gbs.set(m, g); }
    return g;
  }
  finish(parent: Object3D, shadows = true): Mesh[] {
    const out: Mesh[] = [];
    for (const [m, g] of this.gbs) {
      if (!g.vertexCount) continue;
      const mesh = new Mesh(g.build(), m);
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      parent.add(mesh);
      out.push(mesh);
    }
    this.gbs.clear();
    return out;
  }
}

const _m = new Matrix4();
const _q = new Quaternion();

/** Box member between two points (I-beam-ish rectangular section). */
export function beam(gb: GeoBuilder, a: Vector3, b: Vector3, w: number, h = w): void {
  const d = new Vector3().subVectors(b, a);
  const len = d.length();
  if (len < 1e-4) return;
  d.normalize();
  _q.setFromUnitVectors(new Vector3(0, 1, 0), d);
  _m.makeRotationFromQuaternion(_q).setPosition(a.clone().add(b).multiplyScalar(0.5));
  box(gb, w, len, h, _m);
}

export interface LatticeOptions {
  width: number; // square footprint (m)
  depth?: number;
  height: number;
  bay: number; // vertical bay height
  column: number; // column section
  brace: number; // brace section
  floors?: number; // every n bays a grating floor
  /** omit bracing on this face (0..3: +x, -z, -x, +z) e.g. where arms attach */
  openFaces?: number[];
}

/** Square lattice tower (4 columns, girders each bay, X bracing), origin at the base centre. */
export function latticeTower(steel: GeoBuilder, grate: GeoBuilder | null, at: Vector3, o: LatticeOptions): void {
  const hw = o.width / 2, hd = (o.depth ?? o.width) / 2;
  const corners = [new Vector3(hw, 0, hd), new Vector3(hw, 0, -hd), new Vector3(-hw, 0, -hd), new Vector3(-hw, 0, hd)];
  const nb = Math.max(1, Math.round(o.height / o.bay));
  const bh = o.height / nb;
  for (const c of corners) beam(steel, c.clone().add(at), c.clone().add(at).setY(at.y + o.height), o.column);
  for (let i = 0; i <= nb; i++) {
    const y = at.y + i * bh;
    for (let f = 0; f < 4; f++) {
      const a = corners[f].clone().add(at).setY(y), b = corners[(f + 1) % 4].clone().add(at).setY(y);
      beam(steel, a, b, o.brace * 1.2);
      if (i < nb && !(o.openFaces ?? []).includes(f)) {
        const a2 = a.clone().setY(y + bh), b2 = b.clone().setY(y + bh);
        beam(steel, a, b2, o.brace);
        beam(steel, b, a2, o.brace);
      }
    }
    if (grate && o.floors && i % o.floors === 0 && i > 0) {
      box(grate, o.width - o.column, 0.12, (o.depth ?? o.width) - o.column, new Matrix4().makeTranslation(at.x, y, at.z));
    }
  }
}

/** Planar truss between two points (two chords + zig-zag web), width along `side`. */
export function planarTruss(gb: GeoBuilder, a: Vector3, b: Vector3, side: Vector3, width: number, panels: number, chord: number, web: number): void {
  const s = side.clone().normalize().multiplyScalar(width / 2);
  const a1 = a.clone().add(s), a2 = a.clone().sub(s), b1 = b.clone().add(s), b2 = b.clone().sub(s);
  beam(gb, a1, b1, chord);
  beam(gb, a2, b2, chord);
  for (let i = 0; i < panels; i++) {
    const t0 = i / panels, t1 = (i + 1) / panels;
    const p0 = a1.clone().lerp(b1, t0), q1 = a2.clone().lerp(b2, t1), q0 = a2.clone().lerp(b2, t0);
    beam(gb, p0, q1, web);
    beam(gb, p0, q0, web * 0.8);
  }
}

/** Box truss (4 chords) for arms and booms; returns nothing, adds into gb. */
export function boxTruss(gb: GeoBuilder, a: Vector3, b: Vector3, up: Vector3, w: number, h: number, panels: number, chord: number, web: number): void {
  const d = new Vector3().subVectors(b, a).normalize();
  const u = up.clone().sub(d.clone().multiplyScalar(up.dot(d))).normalize();
  const s = new Vector3().crossVectors(d, u).normalize();
  const offs = [u.clone().multiplyScalar(h / 2).add(s.clone().multiplyScalar(w / 2)), u.clone().multiplyScalar(h / 2).sub(s.clone().multiplyScalar(w / 2)),
    u.clone().multiplyScalar(-h / 2).sub(s.clone().multiplyScalar(w / 2)), u.clone().multiplyScalar(-h / 2).add(s.clone().multiplyScalar(w / 2))];
  for (const o of offs) beam(gb, a.clone().add(o), b.clone().add(o), chord);
  for (let i = 0; i < panels; i++) {
    const t0 = i / panels, t1 = (i + 1) / panels;
    for (let k = 0; k < 4; k++) {
      const p0 = a.clone().lerp(b, t0).add(offs[k]), p1 = a.clone().lerp(b, t1).add(offs[(k + 1) % 4]);
      beam(gb, p0, p1, web);
    }
  }
}

/** Sagging cable between two points (catenary approximated by a parabola). */
export function cable(gb: GeoBuilder, a: Vector3, b: Vector3, sag: number, radius: number, segs = 24): void {
  let prev = a.clone();
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const p = a.clone().lerp(b, t);
    p.y -= sag * 4 * t * (1 - t);
    tube(gb, prev, p, radius, 4);
    prev = p;
  }
}

/** Vertical cylindrical tank with domed roof (or a sphere on a skirt). */
export function verticalTank(gb: GeoBuilder, at: Vector3, r: number, h: number, segs = 40): void {
  lathe(gb, [[r, 0], [r, h], [r * 0.85, h + r * 0.25], [r * 0.4, h + r * 0.38], [0, h + r * 0.4]].map(([x, y]) => [x, y + at.y] as [number, number]), { segments: segs, offset: [at.x, at.z] });
}

export function sphereTank(gb: GeoBuilder, legs: GeoBuilder, at: Vector3, r: number, legH: number): void {
  const prof: [number, number][] = [];
  for (let i = 0; i <= 18; i++) { const a = -Math.PI / 2 + (i / 18) * Math.PI; prof.push([Math.cos(a) * r, at.y + legH + r + Math.sin(a) * r]); }
  prof[0][0] = 0; prof[prof.length - 1][0] = 0;
  lathe(gb, prof, { segments: 48, offset: [at.x, at.z] });
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const top = new Vector3(at.x + Math.cos(a) * r, at.y + legH + r, at.z + Math.sin(a) * r);
    const bot = new Vector3(at.x + Math.cos(a) * r * 1.05, at.y, at.z + Math.sin(a) * r * 1.05);
    tube(legs, bot, top, r * 0.045, 8);
    const a2 = ((i + 1) / n) * Math.PI * 2;
    tube(legs, bot, new Vector3(at.x + Math.cos(a2) * r, at.y + legH * 0.6, at.z + Math.sin(a2) * r), r * 0.02, 6);
  }
}

/** Horizontal cylindrical tank on saddles. */
export function horizontalTank(gb: GeoBuilder, saddle: GeoBuilder, at: Vector3, r: number, len: number, yaw: number): void {
  const g = new GeoBuilder();
  const prof: [number, number][] = [[0, -len / 2 - r * 0.5], [r * 0.7, -len / 2 - r * 0.35], [r, -len / 2], [r, len / 2], [r * 0.7, len / 2 + r * 0.35], [0, len / 2 + r * 0.5]];
  lathe(g, prof, { segments: 32 });
  const m = new Matrix4().makeRotationY(yaw).multiply(new Matrix4().makeRotationZ(Math.PI / 2)).setPosition(at.x, at.y + r + 0.8, at.z);
  gb.merge(g, m);
  for (const s of [-0.35, 0.35]) {
    const p = new Vector3(s * len, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), yaw).add(at);
    box(saddle, 0.6, r + 0.8, r * 1.6, new Matrix4().makeRotationY(yaw).setPosition(p.x, at.y + (r + 0.8) / 2, p.z));
  }
}

/** Simple building: box with a parapet, door and window band. */
/** A plain block with a window band on its long sides and, given a lamp, a wall pack over each. */
export function building(wall: GeoBuilder, roof: GeoBuilder, glass: GeoBuilder, at: Vector3, sx: number, sy: number, sz: number, yaw = 0, lamp?: GeoBuilder): SiteLamp[] {
  const m = new Matrix4().makeRotationY(yaw).setPosition(at.x, at.y + sy / 2, at.z);
  box(wall, sx, sy, sz, m);
  box(roof, sx + 0.3, 0.4, sz + 0.3, new Matrix4().makeRotationY(yaw).setPosition(at.x, at.y + sy + 0.2, at.z));
  // window band on the long sides
  const Y = new Vector3(0, 1, 0);
  const n = Math.max(1, Math.floor(sx / 3));
  for (let i = 0; i < n; i++) {
    const x = -sx / 2 + (i + 0.5) * (sx / n);
    for (const s of [1, -1]) {
      const p = new Vector3(x, sy * 0.62, s * (sz / 2 + 0.02)).applyAxisAngle(Y, yaw).add(at);
      box(glass, 1.6, 1.1, 0.05, new Matrix4().makeRotationY(yaw).setPosition(p));
    }
  }
  if (!lamp) return [];
  const lamps: SiteLamp[] = [];
  for (const s of [1, -1]) {
    const out = new Vector3(0, 0, s).applyAxisAngle(Y, yaw);
    const p = new Vector3(sx * 0.3 * s, Math.min(sy - 0.7, 3.4), s * (sz / 2 + 0.15)).applyAxisAngle(Y, yaw).add(at);
    box(lamp, 0.35, 0.2, 0.25, new Matrix4().makeRotationY(yaw).setPosition(p));
    lamps.push({ ...WALL_PACK, pos: p.clone().addScaledVector(out, 0.2), dir: new Vector3(0, -1, 0).addScaledVector(out, 0.6).normalize() });
  }
  return lamps;
}

export interface HangarParts {
  wall: GeoBuilder; door: GeoBuilder; trim: GeoBuilder; plinth: GeoBuilder; dark: GeoBuilder; roof: GeoBuilder; lamp: GeoBuilder; glass: GeoBuilder;
}

/**
 * Integration hangar, its footprint centred on `at` (on the ground) with the doors on the -z side:
 * - profiled-steel walls on a concrete plinth, rising into a capped parapet round a flat roof
 *   that carries ridge vents and plant;
 * - a sliding door of six leaves on staggered tracks across most of the front, between deep
 *   posts under a header, with a track sill and flood lights above;
 * - personnel doors, louvres high on the end walls, downpipes, and a two-storey office annex
 *   with window bands on the +x end.
 */
export function hangar(g: HangarParts, at: Vector3, sx: number, sy: number, sz: number): SiteLamp[] {
  const lamps: SiteLamp[] = [];
  const T = (x: number, y: number, z: number) => new Matrix4().makeTranslation(at.x + x, at.y + y, at.z + z);
  const hx = sx / 2, hz = sz / 2;
  box(g.plinth, sx + 0.4, 1, sz + 0.4, T(0, 0.5, 0));
  box(g.wall, sx, sy - 1, sz, T(0, 1 + (sy - 1) / 2, 0));
  // parapet and its coping
  const pH = 1.4, top = sy + pH;
  box(g.wall, sx, pH, 0.3, T(0, sy + pH / 2, -hz + 0.15));
  box(g.wall, sx, pH, 0.3, T(0, sy + pH / 2, hz - 0.15));
  box(g.wall, 0.3, pH, sz - 0.6, T(-hx + 0.15, sy + pH / 2, 0));
  box(g.wall, 0.3, pH, sz - 0.6, T(hx - 0.15, sy + pH / 2, 0));
  box(g.trim, sx + 0.2, 0.14, 0.5, T(0, top + 0.07, -hz + 0.15));
  box(g.trim, sx + 0.2, 0.14, 0.5, T(0, top + 0.07, hz - 0.15));
  box(g.trim, 0.5, 0.14, sz, T(-hx + 0.15, top + 0.07, 0));
  box(g.trim, 0.5, 0.14, sz, T(hx - 0.15, top + 0.07, 0));
  // roof: membrane, a line of ridge vents, two air handlers and a stair hatch
  box(g.roof, sx - 0.6, 0.25, sz - 0.6, T(0, sy + 0.12, 0));
  const vents = Math.max(3, Math.round(sx / 12));
  for (let i = 0; i < vents; i++) {
    const x = -hx + (i + 0.5) * (sx / vents);
    box(g.dark, 2.2, 0.9, 1.6, T(x, sy + 0.7, 0));
    box(g.trim, 2.6, 0.14, 2.0, T(x, sy + 1.22, 0));
  }
  for (const [x, z] of [[hx * 0.45, hz * 0.45], [-hx * 0.3, hz * 0.5]]) {
    box(g.trim, 4.4, 2.0, 2.6, T(x, sy + 1.25, z));
    box(g.dark, 3.6, 0.2, 2.0, T(x, sy + 2.35, z));
    tube(g.dark, new Vector3(at.x + x - 1.2, at.y + sy + 2.45, at.z + z), new Vector3(at.x + x - 1.2, at.y + sy + 2.75, at.z + z), 0.6, 10);
    tube(g.dark, new Vector3(at.x + x + 1.2, at.y + sy + 2.45, at.z + z), new Vector3(at.x + x + 1.2, at.y + sy + 2.75, at.z + z), 0.6, 10);
  }
  box(g.trim, 1.6, 1.0, 1.6, T(-hx + 4, sy + 0.75, hz - 4));
  // the main door: six leaves on staggered tracks, posts, header, sill
  const dw = sx * 0.76, dh = Math.min(sy - 3.5, sy * 0.82), leaves = 6;
  const lw = dw / leaves;
  for (let i = 0; i < leaves; i++) {
    const x = -dw / 2 + (i + 0.5) * lw;
    const z = -hz - 0.2 - (i % 2) * 0.45;
    box(g.door, lw + 0.25, dh, 0.22, T(x, 0.2 + dh / 2, z));
    // a stiffening rail across each leaf at mid-height and its bottom guide
    box(g.trim, lw + 0.1, 0.25, 0.1, T(x, 0.2 + dh * 0.5, z - 0.15));
    box(g.dark, lw + 0.25, 0.3, 0.3, T(x, 0.35, z));
    // the meeting edge of the next leaf: a dark rubber seal down its full height
    if (i < leaves - 1) box(g.dark, 0.16, dh, 0.06, T(x + lw / 2, 0.2 + dh / 2, -hz - 0.2 - 0.45 - 0.16));
  }
  const postD = 1.4;
  for (const s of [-1, 1]) box(g.wall, 1.6, sy - 0.2, postD, T(s * (dw / 2 + 0.8), (sy - 0.2) / 2 + 0.1, -hz - postD / 2 + 0.1));
  box(g.wall, dw + 3.2, sy - dh - 0.2, postD, T(0, dh + 0.2 + (sy - dh - 0.2) / 2, -hz - postD / 2 + 0.1));
  box(g.trim, dw + 3.4, 0.35, postD + 0.2, T(0, dh + 0.25, -hz - postD / 2 + 0.1));
  box(g.plinth, dw + 4, 0.12, 2.6, T(0, 0.06, -hz - 1.3));
  // flood lights on short arms over the door, washing down the leaves and out over the apron
  for (let i = 0; i < 4; i++) {
    const x = -dw / 2 + (i + 0.5) * (dw / 4);
    box(g.trim, 0.15, 0.15, 1.3, T(x, dh + 1.6, -hz - postD - 0.6));
    box(g.lamp, 0.8, 0.25, 0.5, T(x, dh + 1.45, -hz - postD - 1.2));
    lamps.push({
      pos: new Vector3(at.x + x, at.y + dh + 1.3, at.z - hz - postD - 1.2), dir: new Vector3(0, -1, -0.62).normalize(),
      kcd: 9, cone: [0.3, 0.8], color: [1, 0.93, 0.84],
    });
  }
  // personnel doors with canopies
  const pdoor = (x: number, z: number, along: 'x' | 'z') => {
    const ax = along === 'x';
    box(g.dark, ax ? 1.2 : 0.12, 2.3, ax ? 0.12 : 1.2, T(x, 1.15 + 0.2, z));
    box(g.trim, ax ? 1.8 : 1.0, 0.12, ax ? 1.0 : 1.8, T(x + (ax ? 0 : Math.sign(x) * 0.45), 2.75, z + (ax ? Math.sign(z) * 0.45 : 0)));
    box(g.lamp, 0.3, 0.12, 0.2, T(x + (ax ? 0 : Math.sign(x) * 0.15), 2.95, z + (ax ? Math.sign(z) * 0.15 : 0)));
    const out = ax ? new Vector3(0, 0, Math.sign(z)) : new Vector3(Math.sign(x), 0, 0);
    lamps.push({ ...WALL_PACK, pos: new Vector3(at.x + x, at.y + 2.85, at.z + z).addScaledVector(out, 0.35), dir: new Vector3(0, -1, 0).addScaledVector(out, 0.6).normalize() });
  };
  pdoor(-dw / 2 - 4.5, -hz - 0.07, 'x');
  pdoor(dw / 2 + 4.5, -hz - 0.07, 'x');
  pdoor(-hx - 0.07, hz * 0.4, 'z');
  pdoor(hx * 0.3, hz + 0.07, 'x');
  // louvres high on the end walls
  for (const s of [-1, 1]) for (const z of [-hz * 0.45, 0, hz * 0.45]) {
    box(g.dark, 0.14, 1.6, 3.2, T(s * (hx + 0.07), sy - 2.6, z));
    for (let k = 0; k < 5; k++) box(g.trim, 0.2, 0.06, 3.2, T(s * (hx + 0.14), sy - 3.3 + k * 0.35, z));
  }
  // downpipes from the gutters behind the parapet
  const pipe = (x: number, z: number) => tube(g.trim, new Vector3(at.x + x, at.y + 1, at.z + z), new Vector3(at.x + x, at.y + sy + 0.2, at.z + z), 0.09, 6);
  for (let i = 0; i <= 4; i++) pipe(-hx + 0.6 + i * ((sx - 1.2) / 4), hz + 0.18);
  pipe(-hx - 0.18, -hz + 0.6);
  pipe(hx + 0.18, -hz + 0.6);
  // office annex: two storeys on the +x end
  const ax = hx + 6.5, aw = 13, ah = 8.4, ad = sz * 0.62, az = hz - ad / 2 - 2;
  box(g.plinth, aw + 0.4, 0.8, ad + 0.4, T(ax, 0.4, az));
  box(g.wall, aw, ah - 0.8, ad, T(ax, 0.8 + (ah - 0.8) / 2, az));
  box(g.trim, aw + 0.5, 0.5, ad + 0.5, T(ax, ah + 0.25, az));
  for (const fy of [2.4, 5.8]) {
    box(g.glass, 0.06, 1.3, ad - 2, T(ax + aw / 2 + 0.03, fy, az));
    box(g.glass, aw - 2, 1.3, 0.06, T(ax, fy, az - ad / 2 - 0.03));
    box(g.trim, 0.3, 0.12, ad - 1.6, T(ax + aw / 2 + 0.15, fy - 0.72, az));
  }
  box(g.dark, 0.12, 2.3, 1.8, T(ax + aw / 2 + 0.06, 1.95, az + ad * 0.3));
  return lamps;
}

/** Light mast with a lamp bank aimed at `target`; returns the lamp position. */
export function lightMast(pole: GeoBuilder, lamps: GeoBuilder, at: Vector3, height: number, target: Vector3): Vector3 {
  tube(pole, at, at.clone().setY(at.y + height), 0.35, 10);
  const top = at.clone().setY(at.y + height);
  const dir = target.clone().sub(top).normalize();
  const side = new Vector3(0, 1, 0).cross(dir).normalize();
  // lamp frame (4 x 3 lamps)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    const p = top.clone().addScaledVector(side, (i - 1.5) * 0.9).add(new Vector3(0, (j - 1) * 0.8 + 0.6, 0));
    const m = new Matrix4().lookAt(p, p.clone().add(dir), new Vector3(0, 1, 0)).setPosition(p);
    box(lamps, 0.7, 0.6, 0.35, m);
  }
  return top.clone().add(new Vector3(0, 0.6, 0));
}

// --------------------------------------------------------------------------------- vegetation

/** Palm: curved tapered trunk + drooping fronds (merged geometry, unit height 1 => scaled). */
export function palmGeometry(): { trunk: BufferGeometry; crown: BufferGeometry } {
  const t = new GeoBuilder();
  const H = 9;
  let prev = new Vector3(0, 0, 0);
  for (let i = 1; i <= 8; i++) {
    const f = i / 8;
    const p = new Vector3(Math.sin(f * 1.2) * 0.9, f * H, 0);
    tube(t, prev, p, 0.24 - f * 0.08, 8);
    prev = p;
  }
  const c = new GeoBuilder();
  const top = prev.clone();
  const fronds = 11;
  for (let k = 0; k < fronds; k++) {
    const a = (k / fronds) * Math.PI * 2 + (k % 2) * 0.2;
    const dir = new Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new Vector3(-dir.z, 0, dir.x);
    const len = 3.6 + (k % 3) * 0.5;
    const segs = 6;
    const pts: Vector3[] = [];
    for (let i = 0; i <= segs; i++) {
      const f = i / segs;
      pts.push(top.clone().addScaledVector(dir, f * len).add(new Vector3(0, 0.9 * Math.sin(f * 2.1) - f * f * 2.4 + 0.4, 0)));
    }
    for (let i = 0; i < segs; i++) {
      const w0 = 0.65 * Math.sin(((i + 0.2) / segs) * Math.PI), w1 = 0.65 * Math.sin(((i + 1.2) / segs) * Math.PI);
      const a0 = pts[i].clone().addScaledVector(side, w0), b0 = pts[i].clone().addScaledVector(side, -w0);
      const a1 = pts[i + 1].clone().addScaledVector(side, w1), b1 = pts[i + 1].clone().addScaledVector(side, -w1);
      // V-folded leaf: centre rib slightly raised
      const n = new Vector3(0, 1, 0);
      const base = c.vertexCount;
      for (const p of [a0, b0, a1, b1, pts[i].clone().add(new Vector3(0, 0.08, 0)), pts[i + 1].clone().add(new Vector3(0, 0.08, 0))]) c.vertex(p, n, 0, 0, [0, p.y, 0], {}, [0, 0]);
      c.tri(base, base + 4, base + 2); c.tri(base + 4, base + 5, base + 2);
      c.tri(base + 4, base + 1, base + 5); c.tri(base + 1, base + 3, base + 5);
    }
  }
  const crown = c.build();
  crown.computeVertexNormals();
  return { trunk: t.build(), crown };
}

/** Lumpy crown blob: a squashed sphere whose vertices are pushed in and out by a hash of their position. */
function crownBlob(gb: GeoBuilder, c: Vector3, rx: number, ry: number, seed: number, segs = 10): void {
  let sd = seed;
  const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  const prof: [number, number][] = [];
  const rings = 7;
  for (let i = 0; i <= rings; i++) {
    const a = -Math.PI / 2 + (i / rings) * Math.PI;
    // flatter underside, fuller top: foliage clumps sag under their own weight
    prof.push([Math.cos(a) * rx, c.y + Math.sin(a) * ry * (i < rings / 2 ? 0.75 : 1)]);
  }
  prof[0][0] = 0; prof[rings][0] = 0;
  const v0 = gb.vertexCount;
  lathe(gb, prof, { segments: segs, offset: [c.x, c.z], thetaStart: rnd() * 6.28 });
  // displace: clumps of foliage (hash of the rounded position keeps seam vertices together)
  const hash = (x: number, y: number, z: number) => {
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453;
    return h - Math.floor(h);
  };
  for (let i = v0; i < gb.vertexCount; i++) {
    const px = gb.pos[i * 3], py = gb.pos[i * 3 + 1], pz = gb.pos[i * 3 + 2];
    const k = 0.8 + 0.4 * hash(Math.round(px * 3), Math.round(py * 3), Math.round(pz * 3));
    gb.pos[i * 3] = c.x + (px - c.x) * k;
    gb.pos[i * 3 + 1] = c.y + (py - c.y) * (0.88 + 0.24 * k);
    gb.pos[i * 3 + 2] = c.z + (pz - c.z) * k;
  }
}

/** Crown envelope of a tree (tree-local metres), shared with the camera line-of-sight test. */
export interface CrownShape { cx: number; cy: number; cz: number; rx: number; ry: number; bottom: number; top: number; radius: number }

/**
 * Per-vertex crown attributes: a normal pointing out of the whole crown's envelope (blended
 * with the clump normal in the shader so the canopy shades as one soft volume rather than a
 * pile of facets) and an ambient-occlusion term that darkens the inside and underside.
 */
function crownAttributes(g: BufferGeometry, s: CrownShape): void {
  const pos = g.getAttribute('position');
  const out = new Float32Array(pos.count * 4);
  const n = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) - s.cx, y = pos.getY(i) - s.cy, z = pos.getZ(i) - s.cz;
    n.set(x / (s.rx * s.rx), y / (s.ry * s.ry), z / (s.rx * s.rx)).normalize();
    const hf = Math.min(1, Math.max(0, (pos.getY(i) - s.bottom) / (s.top - s.bottom)));
    const rf = Math.min(1, Math.hypot(x, z) / s.rx);
    const ao = Math.min(1, 0.55 + 0.35 * hf + 0.25 * rf * rf);
    out[i * 4] = n.x; out[i * 4 + 1] = n.y; out[i * 4 + 2] = n.z; out[i * 4 + 3] = ao;
  }
  g.setAttribute('aCrown', new Float32BufferAttribute(out, 4));
}

/** Slash pine: tall straight trunk, open crown of rounded needle clumps at the branch tips. */
export const PINE_CROWN: CrownShape = { cx: 0.2, cy: 15.4, cz: 0, rx: 3.6, ry: 2.8, bottom: 12.3, top: 18.5, radius: 4.1 };
export function pineGeometry(): { trunk: BufferGeometry; crown: BufferGeometry } {
  const t = new GeoBuilder();
  const H = 16.5;
  const top = new Vector3(0.25, H, 0.1);
  tube(t, new Vector3(0, -0.3, 0), top, 0.22, 7);
  const c = new GeoBuilder();
  let sd = 1213;
  const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  // branches spiral up the top third (golden angle), irregular in length and lift; each carries
  // two tufts of needles, so the crown is ragged and deep rather than a stack of plates
  const golden = 2.39996;
  const n = 11;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const y = H * (0.74 + f * 0.22) + (rnd() - 0.5) * 0.5;
    const a = i * golden + 0.4 + (rnd() - 0.5) * 0.5;
    const len = (2.6 - f * 1.4) * (0.75 + rnd() * 0.5);
    const rise = 0.35 + f * 0.7 + rnd() * 0.3;
    const from = new Vector3(0.25 * (y / H), y, 0.1 * (y / H));
    const tip = from.clone().add(new Vector3(Math.cos(a) * len, rise, Math.sin(a) * len));
    tube(t, from, tip, 0.07 - f * 0.02, 4);
    const size = 0.95 + (1 - f) * 0.4;
    crownBlob(c, tip, size * (0.9 + rnd() * 0.25), size * 0.85, 97 + i * 13, 8);
    // an inner tuft part-way along the branch, a little lower and smaller
    const mid = from.clone().lerp(tip, 0.55).add(new Vector3((rnd() - 0.5) * 0.4, -0.15, (rnd() - 0.5) * 0.4));
    crownBlob(c, mid, size * 0.7, size * 0.65, 331 + i * 17, 7);
  }
  // a lumpy, flat-topped crown on the leader
  crownBlob(c, top.clone().add(new Vector3(0, 0.6, 0)), 1.3, 0.95, 211, 9);
  crownBlob(c, top.clone().add(new Vector3(0.7, 0.2, -0.4)), 0.95, 0.8, 223, 8);
  crownBlob(c, top.clone().add(new Vector3(-0.6, 0.3, 0.5)), 0.9, 0.75, 229, 8);
  // dead stubs lower down
  tube(t, new Vector3(0.05, H * 0.5, 0), new Vector3(1.0, H * 0.54, 0.3), 0.04, 4);
  tube(t, new Vector3(0.1, H * 0.62, 0), new Vector3(-0.8, H * 0.66, -0.5), 0.04, 4);
  const crown = c.build();
  crown.computeVertexNormals();
  crownAttributes(crown, PINE_CROWN);
  return { trunk: t.build(), crown };
}

/** Broadleaf hammock tree (live oak / tropical): short trunk splitting into limbs, broad domed canopy. */
export const BROAD_CROWN: CrownShape = { cx: 0, cy: 7.2, cz: 0, rx: 5.0, ry: 2.6, bottom: 5.1, top: 9.9, radius: 5.8 };
export function broadleafGeometry(): { trunk: BufferGeometry; crown: BufferGeometry } {
  const t = new GeoBuilder();
  const fork = new Vector3(0.15, 2.7, 0);
  tube(t, new Vector3(0, -0.3, 0), fork, 0.34, 7);
  const c = new GeoBuilder();
  const limbs = 4;
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + 0.5;
    const end = new Vector3(Math.cos(a) * 3.0, 5.6 + (i % 2) * 0.6, Math.sin(a) * 3.0);
    tube(t, fork, end, 0.17, 5);
  }
  // a solid inner mass so the canopy reads as one crown, then clumps over an oblate dome
  crownBlob(c, new Vector3(0.1, 6.9, 0), 3.7, 1.9, 5, 14);
  let sd = 77;
  const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  const n = 13;
  for (let i = 0; i < n; i++) {
    const az = i * 2.39996;
    const el = i === 0 ? Math.PI / 2 : Math.asin(0.15 + 0.85 * (1 - i / n) * (0.6 + 0.4 * rnd()));
    const p = new Vector3(Math.cos(az) * Math.cos(el) * 3.8, 6.0 + Math.sin(el) * 2.1, Math.sin(az) * Math.cos(el) * 3.8);
    const big = i === 0 ? 2.3 : 1.6 + rnd() * 0.7;
    crownBlob(c, p, big, big * 0.8, 31 + i * 7, 10);
  }
  const crown = c.build();
  crown.computeVertexNormals();
  crownAttributes(crown, BROAD_CROWN);
  return { trunk: t.build(), crown };
}

/** Saw-palmetto / scrub clump: fan-shaped leaf cards around a centre. */
export function shrubGeometry(): BufferGeometry {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const cards = 14;
  for (let k = 0; k < cards; k++) {
    const a = rnd() * Math.PI * 2;
    const tilt = 0.5 + rnd() * 0.7;
    const len = 0.9 + rnd() * 0.7;
    const dir = new Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    const side = new Vector3(-Math.sin(a), 0, Math.cos(a));
    const base = pos.length / 3;
    const fan = 6;
    pos.push(0, 0.05, 0); nor.push(0, 1, 0);
    for (let i = 0; i <= fan; i++) {
      const s = (i / fan - 0.5) * 1.4;
      const p = dir.clone().multiplyScalar(len).addScaledVector(side, s * len * 0.6);
      p.y -= Math.abs(s) * 0.25;
      pos.push(p.x, p.y, p.z); nor.push(dir.x * 0.3, 1, dir.z * 0.3);
    }
    for (let i = 0; i < fan; i++) idx.push(base, base + 1 + i, base + 2 + i);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Grass/reed tuft (crossed blades). */
export function tuftGeometry(): BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < 12; k++) {
    const a = rnd() * Math.PI * 2, h = 0.4 + rnd() * 0.5, lean = rnd() * 0.3;
    const base = pos.length / 3;
    const dx = Math.cos(a), dz = Math.sin(a);
    pos.push(-dz * 0.03, 0, dx * 0.03, dz * 0.03, 0, -dx * 0.03, dx * lean, h, dz * lean);
    idx.push(base, base + 1, base + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Instanced scatter from a list of transforms. */
export function instanced(geo: BufferGeometry, mat: Material, transforms: Matrix4[], shadows = true): InstancedMesh {
  const im = new InstancedMesh(geo, mat, Math.max(1, transforms.length));
  transforms.forEach((m, i) => im.setMatrixAt(i, m));
  im.count = transforms.length;
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = shadows;
  im.receiveShadow = true;
  im.computeBoundingSphere();
  return im;
}

export function groupOf(...objs: Object3D[]): Group {
  const g = new Group();
  for (const o of objs) g.add(o);
  return g;
}
