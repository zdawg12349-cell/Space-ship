import { Group, Matrix4, Mesh, Object3D, PointLight, Quaternion, SpotLight, Vector3 } from 'three';
import type { VehicleDef } from '../../vehicles/types';
import type { LaunchSite } from '../../world/sites';
import { box, GeoBuilder, lathe, tube } from '../vehicle/shapes';
import { createSiteMaterials, SiteMaterials } from './siteMaterials';
import {
  Batch, beam, boxTruss, BROAD_CROWN, broadleafGeometry, building, cable, CrownShape, hangar, horizontalTank, instanced, latticeTower, lightMast, palmGeometry,
  PINE_CROWN, pineGeometry, planarTruss, shrubGeometry, sphereTank, tuftGeometry, verticalTank,
} from './structures';

/**
 * Procedural launch complex, built in the site's local frame: x = east, y = up (0 = pad ground
 * level), z = south. The vehicle stands at the origin on its launch mount at `deckHeight`.
 * The layout adapts to the vehicle: hold-down table + strongback for medium launchers, a mobile
 * launcher platform with an umbilical tower for heavy rockets, an elevated orbital launch
 * mount with a catch tower for the super-heavy, and a support-arm "tulip" pad for the
 * Soyuz-class vehicle.
 */

export type PadStyle = 'mount' | 'mlp' | 'olm' | 'soyuz';
export type TowerStyle = 'fss' | 'te' | 'catch' | 'tulip' | 'ml';

export interface SwingArm {
  name: string;
  pivot: Group;
  axis: Vector3;
  retracted: number; // angle when retracted
  t: number; // 0 attached .. 1 retracted
  target: number;
  speed: number; // fraction per second
  kind: 'crew' | 'umbilical' | 'te' | 'tulip' | 'chopstick' | 'tsm';
}

export interface ExhaustExit { pos: Vector3; dir: Vector3; width: number }

export interface ComplexOptions {
  heightAt?: (east: number, north: number) => number; // terrain height relative to pad ground (m)
  isWater?: (east: number, north: number) => boolean;
  quality?: number; // 0..1 vegetation density
}

export function padStyleFor(def: VehicleDef): { pad: PadStyle; tower: TowerStyle } {
  switch (def.id) {
    case 'leviathan': return { pad: 'olm', tower: 'catch' };
    case 'vostok': return { pad: 'soyuz', tower: 'tulip' };
    case 'sparrow': case 'kestrel9': case 'kestrel_heavy': return { pad: 'mount', tower: 'te' };
    case 'colossus': case 'odyssey': case 'prometheus': return { pad: 'mlp', tower: 'ml' };
    case 'europa5': return { pad: 'mlp', tower: 'fss' };
    default: return { pad: 'mount', tower: 'fss' };
  }
}

/** Lateral extent of the vehicle at its base (m), including strap-ons. */
export function vehicleFootprint(def: VehicleDef): number {
  let r = 1;
  for (const a of def.assemblies) {
    const o = a.offset ? Math.hypot(a.offset[0], a.offset[1]) : 0;
    for (const s of a.sections) if (s.y < 10) r = Math.max(r, o + Math.max(s.radius, s.topRadius ?? 0));
  }
  return r;
}

export function vehicleHeight(def: VehicleDef): number {
  let h = 0;
  for (const a of def.assemblies) for (const s of a.sections) h = Math.max(h, s.y + s.length);
  return h;
}

export class LaunchComplex {
  readonly group = new Group();
  readonly mats: SiteMaterials;
  readonly deckHeight: number;
  readonly pad: PadStyle;
  readonly tower: TowerStyle;
  readonly arms: SwingArm[] = [];
  readonly exits: ExhaustExit[] = [];
  /** deluge nozzles (local) */
  readonly deluge: Vector3[] = [];
  readonly floodlights: SpotLight[] = [];
  readonly apronLights: SpotLight[] = [];
  readonly beacons: PointLight[] = [];
  /** lamp positions for lens glows */
  readonly lampPositions: Vector3[] = [];
  readonly towerTop = new Vector3();
  private time = 0;
  private night = 0;
  private towerLightY: number[] = [];
  private workLights: PointLight[] = [];
  /** terrain height (m, relative to the pad ground) at local (east, north) */
  private hAt: (east: number, north: number) => number = () => 0;
  /** vegetation occluders for camera line-of-sight: grid cell -> flat [x, z, bottom, top, radius]* */
  private occ = new Map<number, number[]>();
  private static readonly OCC_CELL = 40;

  constructor(readonly site: LaunchSite, readonly vehicle: VehicleDef, opts: ComplexOptions = {}) {
    this.group.name = `complex-${site.id}`;
    this.mats = createSiteMaterials();
    const st = padStyleFor(vehicle);
    this.pad = st.pad;
    this.tower = st.tower;
    const fp = vehicleFootprint(vehicle);
    const H = vehicleHeight(vehicle);
    this.deckHeight = this.pad === 'olm' ? 20 : this.pad === 'mlp' ? 10.5 : this.pad === 'soyuz' ? 8 : fp > 4 ? 7.5 : fp < 1 ? 4.5 : 6.5;
    const B = new Batch();
    const M = this.mats;
    this.hAt = opts.heightAt ?? (() => 0);
    this.buildGround(B, fp);
    this.buildMount(B, fp);
    this.buildTower(B, fp, H);
    this.buildPerimeter(B, fp, H);
    this.buildFarField(B);
    this.buildWorkLights(B);
    B.finish(this.group);
    this.buildVegetation(opts);
    this.buildLights(H);
    void M;
  }

  // ------------------------------------------------------------------------------- queries

  /** Terrain height (m above pad ground) at site-local (x east, z south). */
  groundAt(x: number, z: number): number {
    const r = Math.hypot(x, z);
    // the apron and pad mound are flat at pad level
    return r < 140 ? 0 : this.hAt(x, -z);
  }

  /** Tallest vegetation top (site-local y) within `r` metres of (x, z), or ground level. */
  canopyTop(x: number, z: number, r: number): number {
    const C = LaunchComplex.OCC_CELL;
    let top = this.groundAt(x, z);
    const i0 = Math.floor((x - r - 8) / C), i1 = Math.floor((x + r + 8) / C);
    const k0 = Math.floor((z - r - 8) / C), k1 = Math.floor((z + r + 8) / C);
    for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
      const list = this.occ.get(this.occKey(i, k));
      if (!list) continue;
      for (let j = 0; j < list.length; j += 5) {
        if (Math.hypot(list[j] - x, list[j + 1] - z) < r + list[j + 4]) top = Math.max(top, list[j + 3]);
      }
    }
    return top;
  }

  /**
   * True if the straight segment a->b (site-local) passes clear of tree crowns and scrub.
   * Each plant is a vertical cylinder spanning its foliage band; the segment's height range
   * across the cylinder's footprint is tested against that band.
   */
  lineOfSight(a: Vector3, b: Vector3): boolean {
    const C = LaunchComplex.OCC_CELL;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / (C * 0.5)));
    const seen = new Set<number>();
    const dd = dx * dx + dz * dz;
    for (let s = 0; s <= steps; s++) {
      const px = a.x + (dx * s) / steps, pz = a.z + (dz * s) / steps;
      const ci = Math.floor(px / C), ck = Math.floor(pz / C);
      for (let i = ci - 1; i <= ci + 1; i++) for (let k = ck - 1; k <= ck + 1; k++) {
        const key = this.occKey(i, k);
        if (seen.has(key)) continue;
        seen.add(key);
        const list = this.occ.get(key);
        if (!list) continue;
        for (let j = 0; j < list.length; j += 5) {
          const tx = list[j], tz = list[j + 1], bot = list[j + 2], top = list[j + 3], r = list[j + 4];
          // segment parameter range where the xz distance to the plant axis is below r
          let t0: number, t1: number;
          if (dd < 1e-6) {
            if (Math.hypot(a.x - tx, a.z - tz) > r) continue;
            t0 = 0; t1 = 1;
          } else {
            const fx = a.x - tx, fz = a.z - tz;
            const B = 2 * (fx * dx + fz * dz), Cc = fx * fx + fz * fz - r * r;
            const disc = B * B - 4 * dd * Cc;
            if (disc <= 0) continue;
            const sq = Math.sqrt(disc);
            t0 = Math.max(0, (-B - sq) / (2 * dd)); t1 = Math.min(1, (-B + sq) / (2 * dd));
            if (t0 >= t1) continue;
          }
          const y0 = a.y + (b.y - a.y) * t0, y1 = a.y + (b.y - a.y) * t1;
          if (Math.max(y0, y1) > bot && Math.min(y0, y1) < top) return false;
        }
      }
    }
    return true;
  }

  private occKey(i: number, k: number): number { return (i + 512) * 1024 + (k + 512); }

  private addOccluders(list: Matrix4[], shape: CrownShape, radiusScale = 1): void {
    const C = LaunchComplex.OCC_CELL;
    const p = new Vector3(), q = new Quaternion(), sc = new Vector3();
    for (const m of list) {
      m.decompose(p, q, sc);
      const cx = p.x + shape.cx * sc.x, cz = p.z + shape.cz * sc.z;
      const key = this.occKey(Math.floor(cx / C), Math.floor(cz / C));
      let arr = this.occ.get(key);
      if (!arr) { arr = []; this.occ.set(key, arr); }
      arr.push(cx, cz, p.y + shape.bottom * sc.y, p.y + shape.top * sc.y, shape.radius * sc.x * radiusScale);
    }
  }

  // ------------------------------------------------------------------------------- ground

  private buildGround(B: Batch, fp: number): void {
    const M = this.mats;
    const apronR = this.pad === 'mlp' ? 95 : this.pad === 'olm' ? 85 : 70;
    // concrete hardstand (octagon) slightly above the terrain to avoid z-fighting
    // (profile runs inward so the lathe normals face up)
    lathe(B.get(M.concrete), [[apronR + 1.5, -0.6], [apronR, 0.06], [0, 0.06]], { segments: 8, thetaStart: Math.PI / 8 });
    // access road west + perimeter ring road
    this.roadStrip(B.get(M.asphalt), new Vector3(-apronR, 0, 0), new Vector3(-apronR - 2400, 0, 0), 9, 0.08);
    const ringR = 210;
    for (let i = 0; i < 64; i++) {
      const a0 = (i / 64) * Math.PI * 2, a1 = ((i + 1) / 64) * Math.PI * 2;
      const p0 = new Vector3(Math.cos(a0) * ringR, 0.04, Math.sin(a0) * ringR), p1 = new Vector3(Math.cos(a1) * ringR, 0.04, Math.sin(a1) * ringR);
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      box(B.get(M.asphalt), p0.distanceTo(p1) + 0.4, 0.1, 7, new Matrix4().makeRotationY(-(a0 + a1) / 2 + Math.PI / 2).setPosition(mid));
    }
    if (this.pad === 'mlp') {
      // crawlerway: two gravel lanes running west
      for (const z of [-11, 11]) this.roadStrip(B.get(M.gravel), new Vector3(-apronR, 0, z), new Vector3(-5000, 0, z - 1100 * (z > 0 ? 1 : 1)), 12, 0.12);
    }
    // flame trench: concrete-lined channel guiding the exhaust east and west under the mount,
    // walls buttressed by earth berms, scorched floor (a raised orbital launch mount has none:
    // its jet spreads under the table over a flat deflector, built with the mount)
    if (this.pad !== 'olm') {
      const w = Math.max(6, fp * 2.2);
      const wallH = Math.max(3, this.deckHeight * 0.45);
      const trenchL = apronR * 1.25;
      for (const s of [-1, 1]) {
        box(B.get(M.concreteDark), trenchL, wallH, 1.4, new Matrix4().makeTranslation(0, wallH / 2, s * (w / 2 + 0.7)));
        // berm: sloped wedge outside each wall
        const g = B.get(M.berm);
        const z0 = s * (w / 2 + 1.4), z1 = s * (w / 2 + 1.4 + wallH * 2.2);
        const n = new Vector3(0, wallH * 2.2, s * wallH).normalize();
        const v = (x: number, y: number, z: number) => g.vertex(new Vector3(x, y, z), n, 0, 0, [0, y, 0], {}, [0, 0]);
        const hl = trenchL / 2;
        const a0 = v(-hl, wallH, z0), a1 = v(hl, wallH, z0), b0 = v(-hl, 0.02, z1), b1 = v(hl, 0.02, z1);
        if (s > 0) { g.tri(a0, b0, a1); g.tri(a1, b0, b1); } else { g.tri(a0, a1, b0); g.tri(a1, b1, b0); }
        // end slopes of the berm
        for (const ex of [-1, 1]) {
          const ne = new Vector3(ex, 0.6, 0).normalize();
          const ve = (x: number, y: number, z: number) => g.vertex(new Vector3(x, y, z), ne, 0, 0, [0, y, 0], {}, [0, 0]);
          const c0 = ve(ex * hl, wallH, z0), c1 = ve(ex * hl, 0.02, z1), c2 = ve(ex * (hl + wallH * 1.5), 0.02, z0);
          if (ex * s > 0) g.tri(c0, c1, c2); else g.tri(c0, c2, c1);
        }
      }
      box(B.get(M.trenchFloor), trenchL, 0.1, w, new Matrix4().makeTranslation(0, 0.1, 0));
      // deflector: double wedge with steel facing, ridge along z
      const dh = Math.max(2.5, this.deckHeight * 0.55), dl = Math.max(6, fp * 3);
      const g = B.get(M.steelDark);
      for (const sx of [-1, 1]) {
        // one sloped face per side, normal tilted toward its exit
        const n = new Vector3(sx * dh, dl, 0).normalize();
        const v = (x: number, y: number, z: number) => g.vertex(new Vector3(x, y, z), n, 0, 0, [0, y, 0], {}, [0, 0]);
        const p0 = v(0, dh, -w / 2), p1 = v(0, dh, w / 2), p2 = v(sx * dl, 0.05, w / 2), p3 = v(sx * dl, 0.05, -w / 2);
        if (sx > 0) { g.tri(p0, p1, p2); g.tri(p0, p2, p3); } else { g.tri(p0, p2, p1); g.tri(p0, p3, p2); }
      }
      // exits for the exhaust FX (both ends of the trench)
      this.exits.push({ pos: new Vector3(trenchL / 2, 1.5, 0), dir: new Vector3(1, 0.18, 0).normalize(), width: w });
      this.exits.push({ pos: new Vector3(-trenchL / 2, 1.5, 0), dir: new Vector3(-1, 0.18, 0).normalize(), width: w });
    }
  }

  /** Flat strip (road / crawlerway) following the terrain in ~25 m segments. */
  private roadStrip(gb: GeoBuilder, a: Vector3, b: Vector3, width: number, lift: number): void {
    const len = a.distanceTo(b);
    const n = Math.max(1, Math.ceil(len / 25));
    const d = b.clone().sub(a).normalize();
    const side = new Vector3(-d.z, 0, d.x).multiplyScalar(width / 2);
    const up = new Vector3(0, 1, 0);
    let prevL: number | null = null, prevR: number | null = null;
    for (let i = 0; i <= n; i++) {
      const p = a.clone().lerp(b, i / n);
      // inside the apron the ground is the pad level
      const ground = Math.hypot(p.x, p.z) < 100 ? 0 : this.hAt(p.x, -p.z);
      const y = ground + lift;
      const l = gb.vertex(new Vector3(p.x + side.x, y, p.z + side.z), up, 0, i, [0, y, 0], {}, [0, 0]);
      const r = gb.vertex(new Vector3(p.x - side.x, y, p.z - side.z), up, 1, i, [0, y, 0], {}, [0, 0]);
      if (prevL !== null && prevR !== null) {
        // winding so the face points up regardless of direction
        const cross = side.x * d.z - side.z * d.x;
        if (cross < 0) { gb.tri(prevL, l, prevR); gb.tri(prevR, l, r); } else { gb.tri(prevL, prevR, l); gb.tri(prevR, r, l); }
      }
      prevL = l; prevR = r;
    }
  }

  /** Landmarks beyond the pad: an assembly building on the horizon, hangars, a second pad. */
  private buildFarField(B: Batch): void {
    const M = this.mats;
    if (this.pad === 'mlp') {
      // vehicle assembly building ~5 km west, at the end of the crawlerway
      const at = new Vector3(-5200, this.hAt(-5200, 1100), -1100);
      const g = B.get(M.vabWall);
      box(g, 218, 160, 158, new Matrix4().makeTranslation(at.x, at.y + 80, at.z));
      box(B.get(M.vabDark), 30, 140, 2, new Matrix4().makeTranslation(at.x + 40, at.y + 70, at.z + 79.2));
      box(B.get(M.vabDark), 30, 140, 2, new Matrix4().makeTranslation(at.x - 40, at.y + 70, at.z + 79.2));
      box(B.get(M.vabDark), 2, 140, 30, new Matrix4().makeTranslation(at.x + 109.2, at.y + 70, at.z + 30));
      box(B.get(M.vabDark), 2, 140, 30, new Matrix4().makeTranslation(at.x + 109.2, at.y + 70, at.z - 30));
      // low-bay annex
      box(g, 135, 64, 40, new Matrix4().makeTranslation(at.x - 20, at.y + 32, at.z + 99));
      box(B.get(M.concreteDark), 220, 1, 160, new Matrix4().makeTranslation(at.x, at.y + 160.5, at.z));
    } else {
      // horizontal integration hangar beside the access road, its doors toward the road
      const { x: hx, z: hz } = HANGAR;
      const y = this.hAt(hx, -hz);
      box(B.get(M.concrete), 150, 0.2, 76, new Matrix4().makeTranslation(hx, y + 0.1, hz - 12));
      hangar({
        wall: B.get(M.cladding), door: B.get(M.claddingGrey), trim: B.get(M.steelWhite), plinth: B.get(M.concrete), dark: B.get(M.vabDark),
        roof: B.get(M.concreteDark), lamp: B.get(M.lampWarm), glass: B.get(M.glass),
      }, new Vector3(hx, y + 0.2, hz), 95, 22, 40);
    }
    // a neighbouring pad's lightning towers on the horizon (2.6 km north)
    for (let i = 0; i < 3; i++) {
      const x = -60 + i * 70, z = -2600 - (i % 2) * 40;
      const y = this.hAt(x, -z);
      latticeTower(B.get(M.galvanized), null, new Vector3(x, y, z), { width: 3, height: 85, bay: 5, column: 0.35, brace: 0.12 });
    }
    const x2 = 10, z2 = -2620, y2 = this.hAt(x2, -z2);
    latticeTower(B.get(M.steelRed), B.get(M.grating), new Vector3(x2, y2, z2), { width: 10, height: 95, bay: 5, column: 0.5, brace: 0.2, floors: 3 });
  }

  // ------------------------------------------------------------------------------- mount

  private buildMount(B: Batch, fp: number): void {
    const M = this.mats;
    const D = this.deckHeight;
    const hole = fp * 1.08 + 0.6;
    const clamps = Math.max(3, this.vehicle.clamps || 4);
    if (this.pad === 'mount' || this.pad === 'soyuz') {
      const half = hole + (this.pad === 'soyuz' ? 9 : 3.2);
      const th = this.pad === 'soyuz' ? D : 1.6;
      // table plate with a square opening (four slabs)
      const t = th;
      const yC = D - t / 2;
      const m = this.pad === 'soyuz' ? M.concrete : M.steelGrey;
      box(B.get(m), half * 2, t, half - hole, new Matrix4().makeTranslation(0, yC, -(hole + half) / 2));
      box(B.get(m), half * 2, t, half - hole, new Matrix4().makeTranslation(0, yC, (hole + half) / 2));
      box(B.get(m), half - hole, t, hole * 2, new Matrix4().makeTranslation(-(hole + half) / 2, yC, 0));
      box(B.get(m), half - hole, t, hole * 2, new Matrix4().makeTranslation((hole + half) / 2, yC, 0));
      if (this.pad === 'mount') {
        // concrete piers under the four corners
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          box(B.get(M.concrete), 2.6, D - t, 2.6, new Matrix4().makeTranslation(sx * (half - 1.3), (D - t) / 2, sz * (half - 1.3)));
        }
        // stairway + handrails to the deck
        for (let i = 0; i < 10; i++) box(B.get(M.grating), 1.2, 0.08, 0.35, new Matrix4().makeTranslation(half + 1.2, (i + 1) * ((D - 0.5) / 10), -half + 2 + i * 0.4));
      }
      // hold-down clamps around the vehicle base
      for (let i = 0; i < clamps; i++) {
        const a = (i / clamps) * Math.PI * 2 + Math.PI / clamps;
        const r = Math.min(fp, 2.4) + 0.25;
        const p = new Vector3(Math.cos(a) * r, D + 0.45, Math.sin(a) * r);
        box(B.get(M.steelDark), 0.5, 0.9, 0.7, new Matrix4().makeRotationY(-a).setPosition(p));
      }
    } else if (this.pad === 'mlp') {
      // mobile launcher platform: steel box deck on six pedestals, exhaust hole in the middle
      const L = Math.max(48, fp * 7), W = Math.max(40, fp * 5.5);
      const t = 6.5;
      const yC = D - t / 2;
      box(B.get(M.steelGrey), L, t, (W - hole * 2) / 2, new Matrix4().makeTranslation(0, yC, -(hole + W / 2) / 2));
      box(B.get(M.steelGrey), L, t, (W - hole * 2) / 2, new Matrix4().makeTranslation(0, yC, (hole + W / 2) / 2));
      box(B.get(M.steelGrey), L / 2 - hole, t, hole * 2, new Matrix4().makeTranslation(-(hole + L / 2) / 2, yC, 0));
      box(B.get(M.steelGrey), L / 2 - hole, t, hole * 2, new Matrix4().makeTranslation((hole + L / 2) / 2, yC, 0));
      for (const x of [-L * 0.4, 0, L * 0.4]) for (const s of [-1, 1]) {
        if (x === 0) continue;
        box(B.get(M.concrete), 4, D - t, 4, new Matrix4().makeTranslation(x, (D - t) / 2, s * W * 0.35));
      }
      for (const s of [-1, 1]) box(B.get(M.concrete), 4, D - t, 4, new Matrix4().makeTranslation(0, (D - t) / 2, s * W * 0.42));
      // hold-down posts
      for (let i = 0; i < Math.max(4, clamps); i++) {
        const a = (i / Math.max(4, clamps)) * Math.PI * 2 + Math.PI / 4;
        const r = Math.min(fp * 0.98, fp - 0.3) + 0.4;
        box(B.get(M.steelDark), 0.9, 1.4, 0.9, new Matrix4().makeRotationY(-a).setPosition(Math.cos(a) * r, D + 0.7, Math.sin(a) * r));
      }
      // tail service masts (umbilicals to the first stage base)
      for (const s of [-1, 1]) {
        const p = new Vector3(s * (fp + 4), D, -fp - 2.5);
        latticeTower(B.get(M.steelRed), null, p, { width: 2.2, height: 9, bay: 1.8, column: 0.25, brace: 0.1 });
        box(B.get(M.steelDark), 1.8, 1.4, 2.2, new Matrix4().makeTranslation(p.x, D + 9.6, p.z));
      }
    } else if (this.pad === 'olm') {
      // orbital launch mount: six steel legs carrying a ring table 20 m up
      const R = fp + 4.5;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        const p = new Vector3(Math.cos(a) * R, 0, Math.sin(a) * R);
        box(B.get(M.steelGrey), 2.2, D - 2, 2.2, new Matrix4().makeRotationY(-a).setPosition(p.x, (D - 2) / 2, p.z));
        // diagonal bracing between legs
        const a2 = ((i + 1) / 6) * Math.PI * 2 + Math.PI / 6;
        const q = new Vector3(Math.cos(a2) * R, 0, Math.sin(a2) * R);
        beam(B.get(M.steelGrey), p.clone().setY(2), q.clone().setY(D - 4), 0.7);
      }
      lathe(B.get(M.steelGrey), [[fp * 1.02 + 0.4, D - 2.6], [R + 1.6, D - 2.6], [R + 1.6, D], [fp * 1.02 + 0.4, D]], { segments: 6, thetaStart: Math.PI / 6 });
      // clamps ring
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        const r = fp + 0.6;
        box(B.get(M.steelDark), 0.6, 1.2, 1.0, new Matrix4().makeRotationY(-a).setPosition(Math.cos(a) * r, D + 0.6, Math.sin(a) * r));
      }
      // water-cooled steel deflector plate under the mount
      lathe(B.get(M.steelDark), [[fp * 1.8, 0.1], [fp * 1.6, 0.6], [0, 1.4]], { segments: 48 });
      this.exits.length = 0;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        this.exits.push({ pos: new Vector3(Math.cos(a) * (R + 4), 2, Math.sin(a) * (R + 4)), dir: new Vector3(Math.cos(a), 0.12, Math.sin(a)).normalize(), width: R });
      }
    }
    // deluge nozzles: ring around the hole + under the deck
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      this.deluge.push(new Vector3(Math.cos(a) * (hole + 0.8), D + 0.2, Math.sin(a) * (hole + 0.8)));
    }
    for (const s of [-1, 1]) this.deluge.push(new Vector3(s * hole * 1.6, 1.0, 0));
  }

  // ------------------------------------------------------------------------------- towers

  private addArm(name: string, kind: SwingArm['kind'], pivot: Group, axis: Vector3, retracted: number, speed: number): SwingArm {
    const arm: SwingArm = { name, pivot, axis, retracted, t: 0, target: 0, speed, kind };
    pivot.userData.baseQuat = pivot.quaternion.clone();
    this.arms.push(arm);
    this.group.add(pivot);
    return arm;
  }

  /** levels (m above the deck) where umbilical arms meet the vehicle */
  private armLevels(): { y: number; kind: 'crew' | 'umbilical'; radius: number }[] {
    const out: { y: number; kind: 'crew' | 'umbilical'; radius: number }[] = [];
    const def = this.vehicle;
    for (const a of def.assemblies) {
      if (a.offset && Math.hypot(a.offset[0], a.offset[1]) > 0.1) continue;
      if (a.parent === null) continue;
      const s0 = a.sections[0];
      if (!s0) continue;
      if (a.features?.crew) out.push({ y: s0.y + s0.length * 0.6, kind: 'crew', radius: s0.radius });
      else if (a.engines.length && a.sections.some((s) => s.propellant)) out.push({ y: s0.y + s0.length * 0.5, kind: 'umbilical', radius: Math.max(...a.sections.map((s) => s.radius)) });
    }
    return out;
  }

  private buildTower(B: Batch, fp: number, H: number): void {
    const M = this.mats;
    const D = this.deckHeight;
    if (this.tower === 'fss' || this.tower === 'ml') {
      const tw = this.tower === 'ml' ? 12 : 9;
      const dist = fp + 3.5 + tw / 2;
      const baseY = this.tower === 'ml' ? D : 0;
      const height = (this.tower === 'ml' ? H + 18 : H + D + 10) - (this.tower === 'ml' ? 0 : 0);
      const steel = this.tower === 'ml' ? M.steelRed : M.galvanized;
      const at = new Vector3(0, baseY, -dist);
      latticeTower(B.get(steel), B.get(M.grating), at, { width: tw, height, bay: 4, column: 0.55, brace: 0.22, floors: 2, openFaces: [] });
      // elevator shaft + stair core inside
      box(B.get(M.steelWhite), 3, height, 3, new Matrix4().makeTranslation(at.x + 2.2, baseY + height / 2, at.z - 2.2));
      // lightning mast on top
      tube(B.get(M.galvanized), at.clone().setY(baseY + height), at.clone().setY(baseY + height + 16), 0.35, 8);
      this.towerTop.copy(at).setY(baseY + height + 16);
      if (this.tower === 'ml') {
        // hammerhead crane
        box(B.get(M.steelWhite), 26, 3, 3, new Matrix4().makeTranslation(at.x, baseY + height + 2, at.z));
        box(B.get(M.steelWhite), 4, 5, 4, new Matrix4().makeTranslation(at.x - 9, baseY + height + 5, at.z));
      }
      // swing arms
      for (const lv of this.armLevels()) {
        const y = D + lv.y;
        const len = dist - tw / 2 - lv.radius - 0.25;
        if (len < 1) continue;
        const pivot = new Group();
        pivot.position.set(tw / 2 - 0.5, y, -dist + tw / 2);
        const ag = new GeoBuilder();
        // arm truss along +z from the hinge, with a hood at the end
        boxTruss(ag, new Vector3(-tw / 2 + 0.5, 0, 0), new Vector3(-tw / 2 + 0.5, 0, len), new Vector3(0, 1, 0), lv.kind === 'crew' ? 2.4 : 1.6, lv.kind === 'crew' ? 3 : 1.8, Math.max(2, Math.round(len / 2)), 0.25, 0.1);
        if (lv.kind === 'crew') {
          // enclosed walkway + white room
          box(ag, 2.2, 2.6, len * 0.9, new Matrix4().makeTranslation(-tw / 2 + 0.5, 0, len * 0.45));
          box(ag, 3.6, 3.2, 3.0, new Matrix4().makeTranslation(-tw / 2 + 0.5, 0, len - 1.2));
        } else {
          box(ag, 1.4, 1.4, 1.2, new Matrix4().makeTranslation(-tw / 2 + 0.5, -0.4, len - 0.4));
        }
        const mesh = new GeoBuilder();
        mesh.merge(ag);
        const mat = lv.kind === 'crew' ? M.steelWhite : (this.tower === 'ml' ? M.steelRed : M.galvanized);
        const armGroup = new Group();
        const b = new Batch();
        b.get(mat).merge(mesh);
        b.finish(armGroup);
        pivot.add(armGroup);
        this.addArm(`${lv.kind}-${Math.round(lv.y)}`, lv.kind, pivot, new Vector3(0, 1, 0), lv.kind === 'crew' ? -Math.PI * 0.55 : -Math.PI * 0.5, lv.kind === 'crew' ? 0.04 : 0.6);
      }
    } else if (this.tower === 'te') {
      // transporter-erector strongback: twin planar trusses beside the vehicle, hinged at the base
      const pivot = new Group();
      const gap = fp + 1.2;
      pivot.position.set(0, D - 1.0, -gap - 1.0);
      const g = new GeoBuilder();
      const h = H + 1.5;
      for (const sx of [-1, 1]) planarTruss(g, new Vector3(sx * 1.6, 0, 0), new Vector3(sx * 1.6, h, 0), new Vector3(0, 0, 1), 2.0, Math.round(h / 3), 0.32, 0.12);
      for (let i = 0; i <= Math.round(h / 3); i++) beam(g, new Vector3(-1.6, i * 3, 0), new Vector3(1.6, i * 3, 0), 0.2);
      // clamp arms hugging the vehicle at three levels
      for (const f of [0.25, 0.55, 0.85]) {
        const y = h * f;
        boxTruss(g, new Vector3(0, y, 0), new Vector3(0, y, gap + 1.0 - fp - 0.2), new Vector3(0, 1, 0), 1.2, 0.8, 2, 0.15, 0.06);
        lathe(g, [[fp * 0.98 + 0.05, y - 0.3], [fp + 0.25, y - 0.3], [fp + 0.25, y + 0.3], [fp * 0.98 + 0.05, y + 0.3]], { segments: 24, thetaStart: Math.PI * 1.2, thetaLength: Math.PI * 0.6, offset: [0, gap + 1.0] });
      }
      const grp = new Group();
      const b = new Batch();
      b.get(M.steelWhite).merge(g);
      b.finish(grp);
      pivot.add(grp);
      this.addArm('strongback', 'te', pivot, new Vector3(1, 0, 0), -0.35, 0.05);
      // TE base and hydraulic pistons
      box(B.get(M.concrete), 8, 3, 6, new Matrix4().makeTranslation(0, 1.5, -gap - 6));
      tube(B.get(M.steelDark), new Vector3(-2, 3, -gap - 6), new Vector3(-1.5, D + h * 0.25, -gap - 1.3), 0.35, 10);
      tube(B.get(M.steelDark), new Vector3(2, 3, -gap - 6), new Vector3(1.5, D + h * 0.25, -gap - 1.3), 0.35, 10);
      this.towerTop.set(0, D + h, -gap);
      // separate lightning masts carry protection for TE pads (built in perimeter)
    } else if (this.tower === 'catch') {
      const tw = 12;
      const dist = fp + 13;
      const at = new Vector3(0, 0, -dist);
      const height = Math.max(145, H + D + 12);
      latticeTower(B.get(M.steelGrey), B.get(M.grating), at, { width: tw, height, bay: 9, column: 0.9, brace: 0.4, floors: 4 });
      box(B.get(M.steelDark), 6, height, 6, new Matrix4().makeTranslation(at.x, height / 2, at.z));
      this.towerTop.set(0, height, -dist);
      // chopsticks: two long arms on a carriage near the booster/ship interface
      const carriageY = D + 70;
      box(B.get(M.steelDark), tw + 3, 8, tw + 3, new Matrix4().makeTranslation(at.x, carriageY, at.z));
      for (const s of [-1, 1]) {
        const pivot = new Group();
        pivot.position.set(s * (tw / 2 + 1), carriageY, -dist + tw / 2);
        const g = new GeoBuilder();
        boxTruss(g, new Vector3(0, 0, 0), new Vector3(0, 0, dist + fp + 2 - tw / 2), new Vector3(0, 1, 0), 2.4, 4.5, 8, 0.4, 0.15);
        const grp = new Group();
        const b = new Batch();
        b.get(M.steelGrey).merge(g);
        b.finish(grp);
        pivot.add(grp);
        // open angle swings each arm outward
        this.addArm(`chopstick-${s}`, 'chopstick', pivot, new Vector3(0, 1, 0), s * 0.55, 0.08);
      }
      // ship quick-disconnect arm
      const qd = new Group();
      qd.position.set(tw / 2, D + 95, -dist + tw / 2);
      const g = new GeoBuilder();
      boxTruss(g, new Vector3(0, 0, 0), new Vector3(-tw / 2, 0, dist - fp - tw / 2 + 0.5), new Vector3(0, 1, 0), 2, 2, 5, 0.3, 0.1);
      const grp = new Group();
      const b = new Batch();
      b.get(M.steelGrey).merge(g);
      b.finish(grp);
      qd.add(grp);
      this.addArm('ship-qd', 'umbilical', qd, new Vector3(0, 1, 0), -Math.PI * 0.45, 0.4);
    } else if (this.tower === 'tulip') {
      // four support arms rising from the deck to the booster shoulders; they fall away at liftoff
      const def = this.vehicle;
      const booster = def.assemblies.find((a) => a.separation?.kind === 'radial');
      const reach = booster ? (booster.sections[booster.sections.length - 1].y + booster.sections[0].y) * 0.62 : 14;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const pivot = new Group();
        const r0 = fp + 3.5;
        pivot.position.set(Math.cos(a) * r0, D, Math.sin(a) * r0);
        pivot.rotation.y = -a;
        const g = new GeoBuilder();
        // truss from the hinge (deck) up/inward to the contact point
        const contact = new Vector3(-(r0 - fp * 0.62), reach, 0);
        boxTruss(g, new Vector3(0, 0, 0), contact, new Vector3(1, 0, 0), 1.2, 1.4, 6, 0.28, 0.1);
        box(g, 1.6, 1.0, 1.4, new Matrix4().makeTranslation(contact.x, contact.y, 0));
        // counterweight
        box(g, 2.5, 2.5, 2.0, new Matrix4().makeTranslation(1.4, -1.0, 0));
        const grp = new Group();
        const b = new Batch();
        b.get(M.steelGrey).merge(g);
        b.finish(grp);
        pivot.add(grp);
        this.addArm(`support-${i}`, 'tulip', pivot, new Vector3(0, 0, 1), -0.95, 0.35);
      }
      // cable mast (umbilical) beside the vehicle
      const p = new Vector3(0, D, -(fp + 6));
      latticeTower(B.get(M.steelGrey), null, p, { width: 2.5, height: 42, bay: 3, column: 0.3, brace: 0.12 });
      this.towerTop.set(0, D + 42, -(fp + 6));
    }
  }

  // ------------------------------------------------------------------------------- perimeter

  private buildPerimeter(B: Batch, fp: number, H: number): void {
    const M = this.mats;
    const rich = this.vehicle.assemblies.some((a) => a.engines.some((e) => e.spec.propellant === 'hydrolox'));
    const methane = this.vehicle.assemblies.some((a) => a.engines.some((e) => e.spec.propellant === 'methalox'));
    // lightning protection: four masts + catenary wires
    const mastR = 115;
    const mastH = Math.max(70, H * 0.85 + 20);
    const tops: Vector3[] = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const p = new Vector3(Math.cos(a) * mastR, 0, Math.sin(a) * mastR);
      latticeTower(B.get(M.galvanized), null, p, { width: 3, height: mastH, bay: 4, column: 0.3, brace: 0.1 });
      tops.push(p.clone().setY(mastH + 3));
      tube(B.get(M.galvanized), p.clone().setY(mastH), p.clone().setY(mastH + 4), 0.15, 6);
    }
    for (let i = 0; i < 4; i++) cable(B.get(M.cable), tops[i], tops[(i + 1) % 4], 14, 0.03, 20);
    if (this.towerTop.lengthSq() > 0) for (const t of tops) cable(B.get(M.cable), this.towerTop, t, 9, 0.025, 16);
    // water tower ("golf ball" on a column) + deluge pipe
    const wt = new Vector3(-260, 0, 190);
    tube(B.get(M.tankWhite), wt, wt.clone().setY(62), 2.6, 16);
    lathe(B.get(M.tankWhite), (() => { const p: [number, number][] = []; for (let i = 0; i <= 16; i++) { const a = -Math.PI / 2 + (i / 16) * Math.PI; p.push([Math.cos(a) * 10, 72 + Math.sin(a) * 10]); } p[0][0] = 0; p[16][0] = 0; return p; })(), { segments: 40, offset: [wt.x, wt.z] });
    const pipeY = 0.9;
    tube(B.get(M.steelGrey), new Vector3(wt.x, pipeY, wt.z), new Vector3(wt.x, pipeY, 0), 0.9, 10);
    tube(B.get(M.steelGrey), new Vector3(wt.x, pipeY, 0), new Vector3(-30, pipeY, 0), 0.9, 10);
    // tank farm
    const lox = new Vector3(190, 0, -170);
    sphereTank(B.get(M.tankWhite), B.get(M.steelGrey), lox, 10.5, 6);
    if (rich) sphereTank(B.get(M.tankWhite), B.get(M.steelGrey), new Vector3(-200, 0, -180), 11.5, 6);
    if (methane) {
      for (let i = 0; i < 4; i++) verticalTank(B.get(M.tankWhite), new Vector3(150 + i * 14, 0, 150), 5, 24);
    } else {
      for (let i = 0; i < 3; i++) horizontalTank(B.get(M.tankWhite), B.get(M.concrete), new Vector3(170, 0, 120 + i * 10), 3.2, 22, 0.1);
    }
    // propellant lines along the ground to the pad
    for (const [x, z] of [[lox.x, lox.z], [170, 125]] as [number, number][]) {
      tube(B.get(M.steelGrey), new Vector3(x, 0.6, z), new Vector3(x * 0.15, 0.6, z * 0.15), 0.45, 8);
      tube(B.get(M.steelGrey), new Vector3(x * 0.15, 0.6, z * 0.15), new Vector3(0, 0.6, -fp - 4), 0.45, 8);
    }
    // pad buildings
    building(B.get(M.concrete), B.get(M.concreteDark), B.get(M.glass), new Vector3(70, 0, 95), 22, 6, 12, 0.2);
    building(B.get(M.steelWhite), B.get(M.steelGrey), B.get(M.glass), new Vector3(-95, 0, -110), 16, 8, 10, -0.4);
    building(B.get(M.concrete), B.get(M.concreteDark), B.get(M.glass), new Vector3(-180, 0, 60), 30, 5, 14, 0);
    // fence posts on a ring
    for (let i = 0; i < 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      const p = new Vector3(Math.cos(a) * 330, 1.2, Math.sin(a) * 330);
      if (Math.abs(p.z) < 8 && p.x < 0) continue;
      box(B.get(M.galvanized), 0.08, 2.4, 0.08, new Matrix4().makeTranslation(p.x, p.y, p.z));
    }
    // remote cameras (sound-triggered) around the mount
    for (let i = 0; i < 5; i++) {
      const a = 0.4 + i * 1.1;
      const p = new Vector3(Math.cos(a) * (fp + 26 + i * 7), 0, Math.sin(a) * (fp + 26 + i * 7));
      for (let k = 0; k < 3; k++) {
        const la = (k / 3) * Math.PI * 2;
        beam(B.get(M.steelDark), p.clone().add(new Vector3(Math.cos(la) * 0.35, 0, Math.sin(la) * 0.35)), p.clone().setY(1.1), 0.03);
      }
      box(B.get(M.rubber), 0.25, 0.2, 0.35, new Matrix4().makeTranslation(p.x, 1.25, p.z));
    }
    // parked service trucks near the west gate
    for (let i = 0; i < 4; i++) {
      const p = new Vector3(-300 - i * 9, 0, -14 - (i % 2) * 5);
      box(B.get(M.vehiclePaint), 7.5, 2.6, 2.5, new Matrix4().makeTranslation(p.x, 1.6, p.z));
      box(B.get(M.glass), 0.1, 1.0, 2.2, new Matrix4().makeTranslation(p.x + 3.76, 2.2, p.z));
      for (const wx of [-2.6, 2.4]) for (const wz of [-1.2, 1.2]) {
        const w = new GeoBuilder();
        lathe(w, [[0.5, -0.15], [0.5, 0.15]], { segments: 12, capBottom: true, capTop: true });
        B.get(M.rubber).merge(w, new Matrix4().makeRotationX(Math.PI / 2).setPosition(p.x + wx, 0.5, p.z + wz));
      }
    }
    // floodlight masts aiming at the vehicle
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.3;
      const p = new Vector3(Math.cos(a) * 85, 0, Math.sin(a) * 85);
      const lamp = lightMast(B.get(M.galvanized), B.get(M.lampOn), p, 28, new Vector3(0, H * 0.45, 0));
      this.lampPositions.push(lamp);
    }
  }

  /** Work lights on the tower and road lamps along the access road (emissive at night). */
  private buildWorkLights(B: Batch): void {
    const M = this.mats;
    if (this.towerTop.lengthSq() > 0) {
      const top = this.towerTop.y - 16;
      for (let y = 8; y < top; y += 11) {
        for (const [dx, dz] of [[1, 1], [-1, 1]]) {
          const p = new Vector3(this.towerTop.x + dx * 4.6, y, this.towerTop.z + dz * 4.6);
          box(B.get(M.lampWarm), 0.35, 0.25, 0.35, new Matrix4().makeTranslation(p.x, p.y, p.z));
        }
      }
      this.towerLightY = [top * 0.3, top * 0.75];
    }
    // road lamps every 60 m along the access road (both sides alternating)
    for (let x = -130, i = 0; x > -1300; x -= 60, i++) {
      const z = (i % 2 ? 1 : -1) * 7;
      const y = this.hAt(x, -z);
      tube(B.get(M.galvanized), new Vector3(x, y, z), new Vector3(x, y + 9, z), 0.12, 6);
      tube(B.get(M.galvanized), new Vector3(x, y + 9, z), new Vector3(x, y + 9.3, z - Math.sign(z) * 1.6), 0.06, 4);
      box(B.get(M.lampWarm), 0.5, 0.15, 0.3, new Matrix4().makeTranslation(x, y + 9.2, z - Math.sign(z) * 1.6));
    }
  }

  // ------------------------------------------------------------------------------- vegetation

  private buildVegetation(opts: ComplexOptions): void {
    const M = this.mats;
    const climate = this.site.climate;
    const density = opts.quality ?? 1;
    let seed = 1234;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const hAt = opts.heightAt ?? (() => 0);
    const wet = opts.isWater ?? (() => false);
    const q = new Quaternion(), s = new Vector3(), p = new Vector3();
    // natural ground cover per climate: counts are for the full 1.2 km disc outside the fence
    const C = {
      subtropical: { scrub: 9000, palm: 520, pine: 700, broad: 260, tuft: 2600, innerTuft: 2400 },
      tropical: { scrub: 7000, palm: 900, pine: 0, broad: 1600, tuft: 2000, innerTuft: 2400 },
      steppe: { scrub: 500, palm: 0, pine: 0, broad: 0, tuft: 9000, innerTuft: 5000 },
      coastal: { scrub: 3500, palm: 90, pine: 0, broad: 60, tuft: 6000, innerTuft: 3000 },
      arid: { scrub: 1600, palm: 0, pine: 0, broad: 0, tuft: 3000, innerTuft: 1500 },
    }[climate];
    const FENCE = 330;
    const blocked = (x: number, z: number, r: number) =>
      (Math.abs(z) < 12 && x < -60) // access road
      || Math.abs(r - 210) < 7 // ring road
      || (x > 120 && x < 270 && z > -210 && z < 185) // tank farm
      || (x < -230 && x > -300 && z > 160 && z < 220) // water tower
      || (this.pad !== 'mlp' && Math.abs(x - HANGAR.x) < 78 && z > HANGAR.z - 52 && z < HANGAR.z + 28) // hangar and apron
      || (this.pad === 'mlp' && Math.abs(z) < 26 && x < -60); // crawlerway
    const place = (n: number, rMin: number, rMax: number, list: Matrix4[], scale: [number, number], clump: number, clumpR = 14) => {
      const target = Math.round(n * density);
      for (let tries = 0; list.length < target && tries < target * 4; tries++) {
        let x: number, z: number;
        if (list.length > 4 && rnd() < clump) {
          // grow near an existing plant (natural clustering)
          const e = list[Math.floor(rnd() * list.length)].elements;
          x = e[12] + (rnd() - 0.5) * clumpR * 2; z = e[14] + (rnd() - 0.5) * clumpR * 2;
        } else {
          const a = rnd() * Math.PI * 2;
          const r = Math.sqrt(rMin * rMin + rnd() * (rMax * rMax - rMin * rMin));
          x = Math.cos(a) * r; z = Math.sin(a) * r;
        }
        const rr = Math.hypot(x, z);
        if (rr < rMin || rr > rMax * 1.05 || blocked(x, z, rr)) continue;
        if (wet(x, -z)) continue;
        const y = hAt(x, -z);
        const sc = scale[0] + rnd() * (scale[1] - scale[0]);
        q.setFromAxisAngle(_up, rnd() * Math.PI * 2);
        // slight lean for trees
        if (scale[1] > 1.5) q.multiply(new Quaternion().setFromAxisAngle(new Vector3(rnd() - 0.5, 0, rnd() - 0.5).normalize(), rnd() * 0.06));
        s.set(sc, sc * (0.85 + rnd() * 0.3), sc);
        p.set(x, y - 0.1, z);
        list.push(new Matrix4().compose(p, q, s));
      }
    };
    const scrub: Matrix4[] = [], palms: Matrix4[] = [], pines: Matrix4[] = [], broad: Matrix4[] = [], tufts: Matrix4[] = [], inner: Matrix4[] = [];
    place(C.scrub, FENCE + 12, 1150, scrub, [0.9, 2.1], 0.7, 10);
    place(C.pine, FENCE + 25, 1150, pines, [0.75, 1.2], 0.55, 30);
    place(C.palm, FENCE + 15, 1150, palms, [0.75, 1.25], 0.5, 22);
    place(C.broad, FENCE + 30, 1150, broad, [0.8, 1.35], 0.65, 18);
    place(C.tuft, FENCE + 5, 900, tufts, [0.8, 1.7], 0.3);
    place(C.innerTuft, 72, FENCE - 6, inner, [0.6, 1.2], 0.2);
    // a few ornamental palms by the pad buildings
    if (C.palm > 0) for (const [bx, bz] of [[70, 95], [-180, 60]]) for (let i = 0; i < 5; i++) {
      const x = bx + (rnd() - 0.5) * 40, z = bz + 14 + rnd() * 10;
      palms.push(new Matrix4().compose(new Vector3(x, hAt(x, -z) - 0.1, z), new Quaternion().setFromAxisAngle(_up, rnd() * 6.28), new Vector3(1, 1, 1)));
    }
    // line-of-sight occluders for camera placement (crowns are partly see-through: shrink a little)
    this.addOccluders(pines, PINE_CROWN, 0.8);
    this.addOccluders(broad, BROAD_CROWN, 0.85);
    this.addOccluders(palms, { cx: 0.84, cy: 9, cz: 0, rx: 4, ry: 1.5, bottom: 7.4, top: 10.4, radius: 3.2 });
    this.addOccluders(scrub, { cx: 0, cy: 0.7, cz: 0, rx: 1.3, ry: 0.8, bottom: 0, top: 1.45, radius: 1.0 });
    const shrubMat = climate === 'steppe' || climate === 'arid' ? M.dryShrub : M.leaf;
    const tuftMat = climate === 'steppe' || climate === 'arid' || climate === 'coastal' ? M.dryGrass : M.grass;
    if (scrub.length) this.group.add(instanced(shrubGeometry(), shrubMat, scrub, false));
    if (palms.length) {
      const pg = palmGeometry();
      this.group.add(instanced(pg.trunk, M.trunk, palms, false));
      this.group.add(instanced(pg.crown, M.palmLeaf, palms, false));
    }
    if (pines.length) {
      const pg = pineGeometry();
      this.group.add(instanced(pg.trunk, M.trunkPine, pines, false));
      this.group.add(instanced(pg.crown, M.pineLeaf, pines, false));
    }
    if (broad.length) {
      const bg = broadleafGeometry();
      this.group.add(instanced(bg.trunk, M.trunkBroad, broad, false));
      this.group.add(instanced(bg.crown, M.canopy, broad, false));
    }
    if (tufts.length) this.group.add(instanced(tuftGeometry(), tuftMat, tufts, false));
    if (inner.length) this.group.add(instanced(tuftGeometry(), M.grass, inner, false));
  }

  // ------------------------------------------------------------------------------- lights

  private buildLights(H: number): void {
    const target = new Object3D();
    target.position.set(0, H * 0.45, 0);
    this.group.add(target);
    for (const lp of this.lampPositions) {
      const s = new SpotLight(0xfff0dc, 0, 500, 0.3, 0.75, 1.6);
      s.position.copy(lp);
      s.target = target;
      s.castShadow = false;
      this.group.add(s);
      this.floodlights.push(s);
    }
    // wide apron floods from two masts so the deck and the base of the vehicle read at night
    const deck = new Object3D();
    deck.position.set(0, this.deckHeight, 0);
    this.group.add(deck);
    for (const lp of this.lampPositions.slice(0, 2)) {
      const s = new SpotLight(0xffe6c8, 0, 400, 0.75, 0.9, 1.6);
      s.position.copy(lp).add(new Vector3(0, -1.5, 0));
      s.target = deck;
      this.group.add(s);
      this.apronLights.push(s);
    }
    // warm work lights on the tower structure
    for (const y of this.towerLightY) {
      const l = new PointLight(0xffb070, 0, 45, 2);
      l.position.set(this.towerTop.x, y, this.towerTop.z + 6);
      this.group.add(l);
      this.workLights.push(l);
    }
    // red aviation beacons on the tower top and lightning masts
    if (this.towerTop.lengthSq() > 0) {
      const b = new PointLight(0xff2010, 0, 30, 2);
      b.position.copy(this.towerTop);
      this.group.add(b);
      this.beacons.push(b);
    }
  }

  // ------------------------------------------------------------------------------- animation

  /** Command an arm group to retract (or reattach). */
  setArm(kind: SwingArm['kind'] | 'all', retract: boolean): void {
    for (const a of this.arms) if (kind === 'all' || a.kind === kind) a.target = retract ? 1 : 0;
  }

  /**
   * @param night 0 day .. 1 night (floodlights)
   * @param exposureHint lamp intensity scaling for HDR
   */
  /** Surface wind for the plants: speed (m/s), the direction it blows toward (rad from north), gustiness 0..1. */
  setWind(speed: number, toward: number, gust: number): void {
    // site frame: x east, z south
    this.mats.wind.value.set(Math.sin(toward), -Math.cos(toward), speed, gust);
  }

  update(dt: number, night: number): void {
    this.time += dt;
    this.mats.windTime.value = this.time;
    for (const a of this.arms) {
      const d = a.target - a.t;
      if (Math.abs(d) > 1e-4) a.t += Math.sign(d) * Math.min(Math.abs(d), a.speed * dt);
      const e = a.t * a.t * (3 - 2 * a.t);
      const base = a.pivot.userData.baseQuat as Quaternion;
      _q.setFromAxisAngle(a.axis, a.retracted * e);
      a.pivot.quaternion.copy(base).multiply(_q);
    }
    this.night = night;
    const lamp = night;
    // floodlights: physically ~1e6 lm aimed at the vehicle; scaled to kcd units
    // xenon floodlights (~1e6 cd per bank, intensity in kcd for the HDR units)
    for (const f of this.floodlights) f.intensity = lamp * 1400;
    for (const f of this.apronLights) f.intensity = lamp * 700;
    for (const l of this.workLights) l.intensity = lamp * 60;
    this.mats.lampOn.emissiveIntensity = lamp * 60;
    this.mats.lampWarm.emissiveIntensity = lamp * 25;
    this.mats.glass.emissiveIntensity = lamp * 0.6;
    const blink = (Math.sin(this.time * Math.PI * 2 * 0.5) > 0.2 ? 1 : 0.05) * (0.3 + night * 0.7);
    this.mats.beaconRed.emissiveIntensity = blink * 60;
    for (const b of this.beacons) b.intensity = blink * 1.5 * night;
  }

  get nightFactor(): number { return this.night; }

  /** Free GPU resources (geometry + materials). */
  dispose(): void {
    const mats = new Set<{ dispose(): void }>();
    this.group.traverse((o) => {
      const m = o as Partial<Mesh>;
      if (m.geometry) m.geometry.dispose();
      if (m.material) for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mm);
    });
    for (const m of mats) m.dispose();
    for (const l of [...this.floodlights, ...this.apronLights, ...this.workLights, ...this.beacons]) l.dispose();
  }
}

const _up = new Vector3(0, 1, 0);
const _q = new Quaternion();
/** the integration hangar beside the access road (pads without a crawlerway), site metres */
const HANGAR = { x: -420, z: 95 };
