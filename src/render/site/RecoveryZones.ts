import { Color, DoubleSide, Group, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { box, GeoBuilder, lathe, tube } from '../vehicle/shapes';
import { createSiteMaterials, SiteMaterials } from './siteMaterials';
import { Batch, beam, building, lightMast } from './structures';

/**
 * Booster recovery infrastructure: concrete landing-zone pads near the launch site and the
 * autonomous drone ship holding station far downrange. Each zone is built in its own local
 * frame (x east / across, y up, z south / along) and placed camera-relative on the rotating
 * planet every frame. Deck markings (target ring and cross, worn paint, landing scorch) are
 * painted procedurally in object space.
 */

export interface ZoneVisualSpec {
  kind: 'pad' | 'droneship';
  name: string;
  /** body-fixed unit direction of the zone centre */
  dir: Vector3;
  /** deck height above the reference radius (m) */
  height: number;
  /** long-axis heading of the drone ship (rad from north) */
  heading: number;
}

/** Worn white / yellow paint: target ring and cross (pattern 0 = land pad, 1 = ship deck). */
function markingMaterial(pattern: number): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: new Color(0.78, 0.78, 0.76), roughness: 0.75, metalness: 0, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  m.customProgramCacheKey = () => `zone-mark-${pattern}`;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vZP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvZP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vZP;
        float zm_hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float zm_noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(zm_hash(i), zm_hash(i + vec2(1, 0)), u.x), mix(zm_hash(i + vec2(0, 1)), zm_hash(i + vec2(1, 1)), u.x), u.y); }
        float band(float d, float w) { return 1.0 - smoothstep(w * 0.5 - 0.06, w * 0.5 + 0.06, abs(d)); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 p = vZP.xz;
        float r = length(p);
        float paint = 0.0;
        vec3 yellow = vec3(0.72, 0.55, 0.06);
        float isYellow = 0.0;
        ${pattern === 0 ? `
        // land pad: outer yellow ring, white target ring, centre cross
        float outer = band(r - 45.0, 1.4);
        paint = max(paint, outer); isYellow = max(isYellow, outer);
        paint = max(paint, band(r - 30.0, 2.6));
        paint = max(paint, band(r - 6.0, 1.4));
        paint = max(paint, band(p.x, 2.4) * step(abs(p.y), 21.0) * step(8.0, abs(p.y)));
        paint = max(paint, band(p.y, 2.4) * step(abs(p.x), 21.0) * step(8.0, abs(p.x)));` : `
        // ship deck: white target ring and cross, yellow edge hazard line
        paint = max(paint, band(r - 17.0, 1.6));
        paint = max(paint, band(r - 4.0, 1.0));
        paint = max(paint, band(p.x, 1.6) * step(abs(p.y), 12.0) * step(5.5, abs(p.y)));
        paint = max(paint, band(p.y, 1.6) * step(abs(p.x), 12.0) * step(5.5, abs(p.x)));
        float edge = band(abs(p.x) - 24.6, 0.7) * step(abs(p.y), 44.0) + band(abs(p.y) - 44.0, 0.7) * step(abs(p.x), 24.6);
        paint = max(paint, edge); isYellow = max(isYellow, edge);`}
        // worn: scuffed by landings and weather, scorched toward the centre
        float wear = smoothstep(0.35, 0.75, zm_noise(p * 0.35) * 0.6 + zm_noise(p * 2.7) * 0.4);
        float scorch = smoothstep(16.0, 2.0, r + (zm_noise(p * 0.2) - 0.5) * 10.0);
        paint *= 1.0 - wear * 0.55;
        diffuseColor.rgb = mix(diffuseColor.rgb, yellow, isYellow) * (1.0 - scorch * 0.75);
        diffuseColor.a *= clamp(paint, 0.0, 1.0);`);
  };
  return m;
}

/** Dark steel deck with rust bloom, blast scorch and tyre-like scuffs (ship) or stained concrete (pad). */
function deckMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: new Color(0.075, 0.075, 0.078), roughness: 0.62, metalness: 0.55 });
  m.customProgramCacheKey = () => 'zone-deck';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vZP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvZP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vZP;
        float zd_hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float zd_noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(zd_hash(i), zd_hash(i + vec2(1, 0)), u.x), mix(zd_hash(i + vec2(0, 1)), zd_hash(i + vec2(1, 1)), u.x), u.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 p = vZP.xz;
        float n = zd_noise(p * 0.18) * 0.6 + zd_noise(p * 1.3) * 0.4;
        vec3 rust = vec3(0.16, 0.075, 0.035);
        diffuseColor.rgb = mix(diffuseColor.rgb, rust, smoothstep(0.55, 0.9, n) * 0.6);
        // deck plates
        vec2 g = abs(fract(p / vec2(6.0, 2.4)) - 0.5);
        diffuseColor.rgb *= 1.0 - (1.0 - smoothstep(0.0, 0.02, 0.5 - max(g.x, g.y))) * 0.35;
        float scorch = smoothstep(22.0, 3.0, length(p) + (n - 0.5) * 12.0);
        diffuseColor.rgb *= 1.0 - scorch * 0.6;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + (zd_noise(vZP.xz * 0.5) - 0.5) * 0.3, 0.2, 1.0);');
  };
  return m;
}

interface ZoneItem { spec: ZoneVisualSpec; obj: Group; bob: boolean; phase: number }

const _up = new Vector3();
const _east = new Vector3();
const _north = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _qb = new Quaternion();

export class RecoveryZones {
  readonly group = new Group();
  private items: ZoneItem[] = [];
  private mats: SiteMaterials | null = null;
  private deck: MeshStandardMaterial | null = null;
  private markPad: MeshStandardMaterial | null = null;
  private markShip: MeshStandardMaterial | null = null;
  private time = 0;

  constructor() { this.group.name = 'recovery-zones'; }

  set(specs: ZoneVisualSpec[]): void {
    this.clear();
    if (!specs.length) return;
    if (!this.mats) {
      this.mats = createSiteMaterials();
      this.mats.scorch.value = 0.35;
      this.deck = deckMaterial();
      this.markPad = markingMaterial(0);
      this.markShip = markingMaterial(1);
    }
    for (const spec of specs) {
      const obj = spec.kind === 'pad' ? this.buildPad() : this.buildShip();
      obj.name = spec.name;
      this.group.add(obj);
      this.items.push({ spec, obj, bob: spec.kind === 'droneship', phase: Math.random() * 10 });
    }
  }

  /** Re-station a zone (the drone ship moves to where the booster will come down). */
  move(name: string, dir: Vector3, heading?: number): void {
    for (const it of this.items) if (it.spec.name === name) {
      it.spec.dir.copy(dir);
      if (heading !== undefined) it.spec.heading = heading;
    }
  }

  clear(): void {
    for (const it of this.items) {
      this.group.remove(it.obj);
      it.obj.traverse((o) => { const g = (o as { geometry?: { dispose(): void } }).geometry; g?.dispose(); });
    }
    this.items = [];
  }

  /**
   * @param bodyPos Earth's heliocentric position
   * @param bodyRot Earth's orientation (body-fixed -> inertial)
   * @param radius Earth's reference radius
   */
  update(dt: number, bodyPos: Vector3, bodyRot: Quaternion, radius: number, cameraHelio: Vector3, night: number): void {
    this.time += dt;
    for (const it of this.items) {
      const s = it.spec;
      _up.copy(s.dir).applyQuaternion(bodyRot);
      const pole = new Vector3(0, 0, 1).applyQuaternion(bodyRot);
      _east.crossVectors(pole, _up).normalize();
      _north.crossVectors(_up, _east);
      // local frame: x east, y up, z south; the ship's long axis is rotated to its heading
      _m.makeBasis(_east, _up, _north.clone().negate());
      _q.setFromRotationMatrix(_m);
      if (s.kind === 'droneship') _q.multiply(_qb.setFromAxisAngle(new Vector3(0, 1, 0), -s.heading));
      const o = it.obj;
      o.quaternion.copy(_q);
      o.position.copy(_up).multiplyScalar(radius + s.height).add(bodyPos).sub(cameraHelio);
      if (it.bob) {
        // gentle swell: heave, roll and pitch (kept small: the physics deck is fixed)
        const t = this.time + it.phase;
        o.position.addScaledVector(_up, 0.1 * Math.sin(t * 0.62));
        o.quaternion.multiply(_qb.setFromAxisAngle(new Vector3(0, 0, 1), 0.006 * Math.sin(t * 0.47 + 1.3)));
        o.quaternion.multiply(_qb.setFromAxisAngle(new Vector3(1, 0, 0), 0.0035 * Math.sin(t * 0.39)));
      }
      // far away: skip the draw
      o.visible = o.position.length() < 400_000;
    }
    if (this.mats) {
      this.mats.lampOn.emissiveIntensity = 60 * night;
      this.mats.lampWarm.emissiveIntensity = 25 * night;
      this.mats.beaconRed.emissiveIntensity = 2 + 40 * night * (Math.sin(this.time * 3) > 0.6 ? 1 : 0.05);
    }
  }

  // ------------------------------------------------------------------------------ builders

  /** Landing zone: 96 m concrete pad with markings, apron road, light masts and a blockhouse. */
  private buildPad(): Group {
    const M = this.mats!;
    const g = new Group();
    const B = new Batch();
    // pad slab: a raised disc with a bevelled edge sinking into the ground (profile inward so normals face up)
    lathe(B.get(M.concrete), [[49.5, -2.5], [48, 0.0], [0, 0.0]], { segments: 64 });
    // ring road and access road
    for (let i = 0; i < 48; i++) {
      const a0 = (i / 48) * Math.PI * 2, a1 = ((i + 1) / 48) * Math.PI * 2;
      const r = 58;
      const p0 = new Vector3(Math.cos(a0) * r, -0.2, Math.sin(a0) * r), p1 = new Vector3(Math.cos(a1) * r, -0.2, Math.sin(a1) * r);
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      box(B.get(M.asphalt), p0.distanceTo(p1) + 0.3, 0.3, 7, new Matrix4().makeRotationY(-(a0 + a1) / 2 + Math.PI / 2).setPosition(mid));
    }
    box(B.get(M.asphalt), 7, 0.3, 300, new Matrix4().makeTranslation(-62, -0.2, 180));
    // light masts and their lamp heads aimed at the centre
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      lightMast(B.get(M.galvanized), B.get(M.lampOn), new Vector3(Math.cos(a) * 68, -0.2, Math.sin(a) * 68), 22, new Vector3(0, 0, 0));
    }
    // blockhouse and a fuel-safe equipment shelter
    building(B.get(M.concreteDark), B.get(M.steelGrey), B.get(M.glass), new Vector3(-95, -0.2, 120), 18, 5, 12, 0.3);
    building(B.get(M.steelWhite), B.get(M.steelGrey), B.get(M.glass), new Vector3(-80, -0.2, 150), 9, 4, 7, 0.3);
    // perimeter beacons
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      box(B.get(M.beaconRed), 0.4, 0.4, 0.4, new Matrix4().makeTranslation(Math.cos(a) * 49, 0.3, Math.sin(a) * 49));
    }
    B.finish(g);
    // painted markings: a thin disc just above the slab
    const mark = new GeoBuilder();
    lathe(mark, [[48, 0.04], [0, 0.04]], { segments: 96 });
    const markMesh = new Batch();
    markMesh.get(this.markPad!).merge(mark);
    for (const mm of markMesh.finish(g, false)) { mm.receiveShadow = true; mm.renderOrder = 1; }
    return g;
  }

  /** Autonomous drone ship: barge hull with deck wings, blast walls, equipment and thrusters. */
  private buildShip(): Group {
    const M = this.mats!;
    const g = new Group();
    const B = new Batch();
    const L = 91, W = 52, hullW = 36;
    // hull: deck top at y = 0 (the zone height is the deck), keel 7 m below
    box(B.get(M.steelDark), hullW, 7, L, new Matrix4().makeTranslation(0, -3.5, 0));
    // red antifouling below the waterline band
    box(B.get(M.steelRed), hullW + 0.05, 2.2, L + 0.05, new Matrix4().makeTranslation(0, -5.6, 0));
    // deck plate spanning the wings
    box(B.get(this.deck!), W, 0.6, L - 2, new Matrix4().makeTranslation(0, -0.3, 0));
    // wing supports under the overhangs
    for (const sx of [-1, 1]) {
      for (let k = -4; k <= 4; k++) {
        const z = k * 10;
        beam(B.get(M.steelGrey), new Vector3(sx * hullW / 2, -4.5, z), new Vector3(sx * (W / 2 - 0.5), -0.7, z), 0.5);
      }
      // edge railing posts and rail
      for (let k = -22; k <= 22; k++) box(B.get(M.galvanized), 0.08, 1.1, 0.08, new Matrix4().makeTranslation(sx * (W / 2 - 0.2), 0.55, k * 2));
      box(B.get(M.galvanized), 0.06, 0.06, 88, new Matrix4().makeTranslation(sx * (W / 2 - 0.2), 1.1, 0));
      // azimuth thruster housings at the corners
      for (const sz of [-1, 1]) box(B.get(M.steelGrey), 4, 3, 5, new Matrix4().makeTranslation(sx * (hullW / 2 - 2.5), -6.5, sz * 38));
    }
    // aft blast walls protecting the equipment, angled outward
    for (const sx of [-1, 1]) {
      const m = new Matrix4().makeRotationY(sx * 0.35).setPosition(sx * 12, 3, 40);
      box(B.get(M.steelWhite), 16, 6, 0.5, m);
      // equipment containers behind the walls
      box(B.get(M.steelGrey), 6, 2.6, 2.4, new Matrix4().makeTranslation(sx * 12, 1.3, 43.2));
      box(B.get(M.steelWhite), 3, 2.2, 2.2, new Matrix4().makeTranslation(sx * 19, 1.1, 43));
      // lamp bars on the walls
      box(B.get(M.lampOn), 3.2, 0.3, 0.3, new Matrix4().makeTranslation(sx * 12, 6.2, 39.7));
    }
    // generator stacks and a mast with navigation lights
    tube(B.get(M.steelGrey), new Vector3(0, 0, 44), new Vector3(0, 9, 44), 0.18, 6);
    box(B.get(M.beaconRed), 0.5, 0.5, 0.5, new Matrix4().makeTranslation(0, 9.3, 44));
    box(B.get(M.lampWarm), 0.4, 0.4, 0.4, new Matrix4().makeTranslation(0, 7.5, 44));
    B.finish(g);
    // deck markings
    const mark = new GeoBuilder();
    box(mark, W - 0.4, 0.02, L - 2.4, new Matrix4().makeTranslation(0, 0.02, 0));
    const mb = new Batch();
    mb.get(this.markShip!).merge(mark);
    for (const mm of mb.finish(g, false)) { mm.receiveShadow = true; mm.renderOrder = 1; }
    void DoubleSide;
    return g;
  }
}
