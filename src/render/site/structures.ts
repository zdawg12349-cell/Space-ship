import {
  BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Material, Matrix4, Mesh, Object3D, Quaternion, Vector3,
} from 'three';
import { box, GeoBuilder, lathe, tube } from '../vehicle/shapes';

/**
 * Building blocks for launch-site infrastructure: steel lattice towers, trusses, catenary
 * wires, tanks, buildings, light masts and instanced vegetation. Everything is accumulated
 * into per-material batches so a whole complex renders in a few dozen draw calls.
 */

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
export function building(wall: GeoBuilder, roof: GeoBuilder, glass: GeoBuilder, at: Vector3, sx: number, sy: number, sz: number, yaw = 0): void {
  const m = new Matrix4().makeRotationY(yaw).setPosition(at.x, at.y + sy / 2, at.z);
  box(wall, sx, sy, sz, m);
  box(roof, sx + 0.3, 0.4, sz + 0.3, new Matrix4().makeRotationY(yaw).setPosition(at.x, at.y + sy + 0.2, at.z));
  // window band on the long sides
  const n = Math.max(1, Math.floor(sx / 3));
  for (let i = 0; i < n; i++) {
    const x = -sx / 2 + (i + 0.5) * (sx / n);
    for (const s of [1, -1]) {
      const p = new Vector3(x, sy * 0.62, s * (sz / 2 + 0.02)).applyAxisAngle(new Vector3(0, 1, 0), yaw).add(at);
      box(glass, 1.6, 1.1, 0.05, new Matrix4().makeRotationY(yaw).setPosition(p));
    }
  }
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

/** Lumpy crown blob (subdivided octahedron with radial noise), for tree canopies. */
function crownBlob(gb: GeoBuilder, c: Vector3, rx: number, ry: number, seed: number): void {
  // icosphere-ish: lathe of a squashed sphere with jittered rings
  let sd = seed;
  const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  const prof: [number, number][] = [];
  const rings = 6;
  for (let i = 0; i <= rings; i++) {
    const a = -Math.PI / 2 + (i / rings) * Math.PI;
    const j = i === 0 || i === rings ? 0 : 0.85 + rnd() * 0.3;
    prof.push([Math.cos(a) * rx * j, c.y + Math.sin(a) * ry * (i === 0 ? 0.6 : 1)]);
  }
  prof[0][0] = 0; prof[rings][0] = 0;
  lathe(gb, prof, { segments: 7, offset: [c.x, c.z], thetaStart: rnd() * 6.28 });
}

/** Slash pine: tall straight trunk, flat irregular crown of clustered blobs. */
export function pineGeometry(): { trunk: BufferGeometry; crown: BufferGeometry } {
  const t = new GeoBuilder();
  const H = 16;
  tube(t, new Vector3(0, -0.3, 0), new Vector3(0.25, H, 0.1), 0.22, 7);
  // a couple of dead lower branches
  tube(t, new Vector3(0.05, H * 0.55, 0), new Vector3(1.4, H * 0.62, 0.3), 0.05, 4);
  tube(t, new Vector3(0.1, H * 0.7, 0), new Vector3(-1.1, H * 0.8, -0.6), 0.05, 4);
  const c = new GeoBuilder();
  const blobs: [number, number, number, number, number][] = [
    [0.2, H + 0.3, 0.1, 2.4, 1.3], [1.6, H - 0.6, 0.6, 1.6, 0.9], [-1.4, H - 0.2, -0.5, 1.7, 1.0], [0.4, H - 1.6, -1.3, 1.4, 0.8], [-0.3, H + 1.2, 0.6, 1.5, 0.9],
  ];
  blobs.forEach(([x, y, z, rx, ry], i) => crownBlob(c, new Vector3(x, y, z), rx, ry, 97 + i * 13));
  return { trunk: t.build(), crown: c.build() };
}

/** Broadleaf hammock tree (live oak / tropical): short trunk, broad domed canopy. */
export function broadleafGeometry(): { trunk: BufferGeometry; crown: BufferGeometry } {
  const t = new GeoBuilder();
  tube(t, new Vector3(0, -0.3, 0), new Vector3(0.2, 3.2, 0), 0.32, 7);
  tube(t, new Vector3(0.2, 3.0, 0), new Vector3(2.0, 5.4, 0.8), 0.16, 5);
  tube(t, new Vector3(0.2, 3.0, 0), new Vector3(-1.6, 5.8, -0.9), 0.16, 5);
  const c = new GeoBuilder();
  const blobs: [number, number, number, number, number][] = [
    [0, 6.4, 0, 3.6, 2.2], [2.3, 5.6, 1.0, 2.4, 1.6], [-2.1, 5.9, -1.0, 2.5, 1.7], [0.6, 7.4, -1.6, 2.1, 1.4], [-0.8, 5.2, 2.0, 2.2, 1.5],
  ];
  blobs.forEach(([x, y, z, rx, ry], i) => crownBlob(c, new Vector3(x, y, z), rx, ry, 31 + i * 7));
  return { trunk: t.build(), crown: c.build() };
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
