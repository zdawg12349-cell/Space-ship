import { MathUtils, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { CelestialBody } from '../physics/bodies';
import type { Vessel } from '../physics/vessel';
import { CameraShake } from './Shake';

/**
 * Camera system: player-controlled chase / orbit / onboard / tracking / free cameras, plus a
 * cinematic director that cuts between a library of shots chosen for the flight phase and
 * driven by events (ignition, liftoff, max-Q, staging, fairing, orbit, booster landing, entry,
 * parachutes, splashdown).
 *
 * All positions are heliocentric (double precision); the renderer places the camera at the
 * origin and everything else relative to it.
 */

export type CameraMode = 'cinematic' | 'chase' | 'orbit' | 'onboard' | 'tracking' | 'free';
export const CAMERA_MODES: CameraMode[] = ['cinematic', 'chase', 'orbit', 'onboard', 'tracking', 'free'];
export const CAMERA_LABELS: Record<CameraMode, string> = {
  cinematic: 'Cinematic director', chase: 'Chase', orbit: 'Orbit', onboard: 'Onboard', tracking: 'Ground tracking', free: 'Free',
};

export interface CamContext {
  t: number;
  dt: number;
  active: Vessel | null;
  vessels: Vessel[];
  /** recovering boosters (for cut-aways) */
  boosters: Vessel[];
  bodyPos(b: CelestialBody): Vector3;
  /** site frame (x east, y up, z south) -> world rotation, and its origin (helio) */
  site: { quat: Quaternion; origin: Vector3; body: CelestialBody } | null;
  /** tower top, deck height (site local) */
  towerTop: Vector3 | null;
  deckHeight: number;
  /** site-local terrain and vegetation queries for placing ground cameras with a clear view */
  siteQuery: SiteQuery | null;
  /** ground height (m above the body's reference radius) under a helio point */
  groundHeight(body: CelestialBody, helio: Vector3): number;
  /** landing zones (helio) */
  zones: { pos: Vector3; kind: string }[];
  phase: string;
  /** total plume thrust of all vessels (MN), for acoustic shake */
  plumeMN: number;
  plumeSourceHelio: Vector3 | null;
}

export interface SiteQuery {
  groundAt(x: number, z: number): number;
  canopyTop(x: number, z: number, r: number): number;
  lineOfSight(a: Vector3, b: Vector3): boolean;
}

/** Placement adjustment found for a ground shot so nothing blocks the view. */
interface SpotAdj { da: number; dd: number; dh: number }

interface ShotState {
  id: string;
  dur: number;
  tau: number;
  seed: number;
  /** fixed anchor in helio (ground cameras) or body-fixed */
  anchor: Vector3;
  anchorFixed: Vector3 | null;
  anchorBody: CelestialBody | null;
  subject: Vessel | null;
  a: number; b: number; c: number;
  adj: SpotAdj | null;
}

interface CamOut {
  pos: Vector3;
  look: Vector3;
  up: Vector3;
  fov: number;
  mount: 'ground' | 'vehicle' | 'free';
  handheld: number;
  /** look direction is a fixed vehicle-frame direction (onboard) */
  dirOverride: Vector3 | null;
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _q = new Quaternion();
const _m = new Matrix4();

const ONBOARD_MOUNTS = ['down', 'up', 'engines', 'side'] as const;
type OnboardMount = (typeof ONBOARD_MOUNTS)[number];

export class CameraDirector {
  mode: CameraMode = 'cinematic';
  readonly shake = new CameraShake();
  /** final camera (helio) */
  readonly posHelio = new Vector3();
  readonly quat = new Quaternion();
  fov = 50;
  /** cinematic letterbox amount 0..1 */
  letterbox = 0;
  // player orbit/chase state
  orbitAz = 0.6;
  orbitEl = 0.15;
  orbitDist = 0;
  private orbitTargetDist = 0;
  onboardIndex = 0;
  // free camera
  readonly freePos = new Vector3();
  freeYaw = 0;
  freePitch = 0;
  // cinematic state
  private shot: ShotState | null = null;
  private queue: string[] = [];
  private lastIds: string[] = [];
  private cutCooldown = 0;
  private smoothLook = new Vector3();
  private smoothLookInit = false;
  private smoothFov = 50;
  /** text shown briefly when the shot changes (HUD) */
  shotLabel = '';
  private rngSeed = 1;
  /** last computed camera mount, for shake */
  private lastMount: CamOut['mount'] = 'free';

  constructor(readonly camera: PerspectiveCamera) {}

  private rnd(): number { this.rngSeed = (this.rngSeed * 16807) % 2147483647; return this.rngSeed / 2147483647; }

  setMode(m: CameraMode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.shot = null;
    this.smoothLookInit = false;
    this.letterbox = m === 'cinematic' ? this.letterbox : 0;
  }

  cycleOnboard(): void { this.onboardIndex = (this.onboardIndex + 1) % ONBOARD_MOUNTS.length; }

  /** Player input: orbit drag (radians) and zoom (factor). */
  orbitInput(dAz: number, dEl: number, zoom: number): void {
    this.orbitAz += dAz;
    this.orbitEl = MathUtils.clamp(this.orbitEl + dEl, -1.45, 1.45);
    if (zoom !== 1) this.orbitTargetDist = Math.max(4, Math.min(5e7, (this.orbitTargetDist || 100) * zoom));
  }

  /** Event from the flight: request a cut to a fitting shot (cinematic mode only). */
  cue(name: string): void {
    const map: Record<string, string[]> = {
      establish: ['pad_wide'], detail: ['vent_close'], tower: ['tower_up'], arms: ['arm_detail'], pad_low: ['pad_low'],
      countdown: ['pad_hero'], engines: ['engine_bay'], ignition: ['engine_close'], liftoff: ['liftoff_low', 'tower_rise'],
      tower_clear: ['tracking_long'], maxq: ['chase_side'], separation: ['interstage', 'chase_upper'], fairing: ['payload_cam'],
      meco: ['onboard_down'], orbit: ['orbit_beauty'], boostback: ['booster_chase'], entryburn: ['booster_chase'], landing: ['lz_ground'],
      entry: ['entry_front'], chutes: ['chute_below'], splashdown: ['splash'], explosion: ['tracking_long'], moon: ['orbit_beauty'], touchdown: ['lz_ground'],
    };
    const list = map[name];
    if (!list || this.mode !== 'cinematic') return;
    if (this.shot && this.shot.id === list[0] && this.shot.tau < 2) return;
    this.queue = list.slice(1);
    this.startShot(list[0]);
  }

  /** Cut straight to a named shot (debug / photo tools). */
  forceShot(id: string): void { this.queue = []; this.startShot(id); }

  private startShot(id: string, subject: Vessel | null = null): void {
    this.shot = { id, dur: 8, tau: 0, seed: this.rnd(), anchor: new Vector3(), anchorFixed: null, anchorBody: null, subject, a: this.rnd(), b: this.rnd(), c: this.rnd(), adj: null };
    this.lastIds.push(id);
    if (this.lastIds.length > 4) this.lastIds.shift();
    this.smoothLookInit = false;
    this.cutCooldown = 1.5;
    this.shotLabel = id;
  }

  /** Pick the next shot for the phase, avoiding immediate repeats. */
  private pickShot(ctx: CamContext): string {
    if (this.queue.length) return this.queue.shift()!;
    const p = ctx.phase;
    let pool: string[];
    const v = ctx.active;
    const alt = v ? v.telemetry.altitude : 0;
    const inAtm = v ? v.telemetry.inAtmosphere && alt < 70_000 : false;
    if (p === 'countdown') pool = ['pad_wide', 'pad_dolly', 'tower_up', 'vent_close', 'pad_low', 'engine_bay', 'pad_hero', 'arm_detail'];
    else if (p === 'ascent' && alt < 3000) pool = ['tracking_long', 'tower_rise', 'chase_below', 'pad_low'];
    else if (p === 'ascent' && inAtm) pool = ['tracking_long', 'chase_below', 'chase_side', 'onboard_down', 'flyby', 'onboard_engines'];
    else if (p === 'ascent' || p === 'upper') pool = ['chase_upper', 'onboard_down', 'orbit_beauty', 'chase_side', 'onboard_engines'];
    else if (p === 'orbit' || p === 'coast' || p === 'transfer') pool = ['orbit_beauty', 'orbit_drift', 'onboard_down', 'orbit_limb'];
    else if (p === 'entry') pool = ['entry_front', 'entry_chase', 'tracking_long'];
    else if (p === 'descent') pool = ['chute_below', 'entry_chase', 'splash'];
    else if (p === 'landed') pool = ['orbit_drift', 'lz_ground'];
    else pool = ['chase_side', 'orbit_beauty'];
    // occasionally cut away to a recovering booster
    if (ctx.boosters.length && p !== 'countdown' && this.rnd() < 0.3) {
      const b = ctx.boosters.find((x) => !x.destroyed && !x.landed);
      if (b) return 'booster_chase';
    }
    const fresh = pool.filter((s) => !this.lastIds.includes(s));
    const choice = (fresh.length ? fresh : pool)[Math.floor(this.rnd() * (fresh.length ? fresh.length : pool.length))];
    return choice;
  }

  // ------------------------------------------------------------------------------ helpers

  private sitePoint(ctx: CamContext, x: number, y: number, z: number, out: Vector3): Vector3 {
    if (!ctx.site) return out.set(0, 0, 0);
    return out.set(x, y, z).applyQuaternion(ctx.site.quat).add(ctx.site.origin);
  }

  private com(ctx: CamContext, v: Vessel, out: Vector3): Vector3 { return out.copy(v.pos).add(ctx.bodyPos(v.body)); }

  /** Pad-shot bearing in the site frame, kept on the open (south, +z) side away from the tower. */
  private padAngle(f: number, spread = 1): number { return Math.PI / 2 + (f - 0.5) * (Math.PI - 0.8) * spread; }

  /** Terrain height (site-local y) under a site-local point. */
  private gy(ctx: CamContext, x: number, z: number): number { return ctx.siteQuery ? ctx.siteQuery.groundAt(x, z) : 0; }

  /** Sight lines a pad camera needs: vehicle base / middle / top, each optionally only near-field. */
  private padSight(ctx: CamContext, L: number, near: number, full: boolean): [Vector3, number][] {
    const d = ctx.deckHeight;
    return [
      [new Vector3(0, d + L * 0.12, 0), full ? Infinity : near],
      [new Vector3(0, d + L * 0.5, 0), Infinity],
      [new Vector3(0, d + L * 0.92, 0), Infinity],
    ];
  }

  /**
   * Ground camera placement with a clear view. `place(adj, tau, out)` gives the site-local
   * camera position for a candidate adjustment of bearing / distance / height. The first
   * candidate whose start and end positions see every target (a target with a finite range
   * only needs that much of its sight line clear, so a treeline in the distance can frame the
   * bottom of a long-lens shot) wins; failing that the camera goes up a mast over the canopy.
   */
  private clearSpot(ctx: CamContext, st: ShotState, sight: [Vector3, number][], place: (adj: SpotAdj, tau: number, out: Vector3) => Vector3): SpotAdj {
    if (st.adj) return st.adj;
    const q = ctx.siteQuery;
    const zero: SpotAdj = { da: 0, dd: 1, dh: 0 };
    if (!q) return (st.adj = zero);
    const p = new Vector3(), e = new Vector3();
    const sees = (adj: SpotAdj) => {
      for (const tau of [0, st.dur * 0.5, st.dur]) {
        place(adj, tau, p);
        for (const [to, range] of sight) {
          e.copy(to);
          const len = e.distanceTo(p);
          if (len > range) e.sub(p).multiplyScalar(range / len).add(p);
          if (!q.lineOfSight(p, e)) return false;
        }
      }
      return true;
    };
    const cands: SpotAdj[] = [zero];
    for (const dd of [1, 0.8, 1.25]) for (const da of [0.08, -0.08, 0.17, -0.17, 0.28, -0.28, 0.4, -0.4]) cands.push({ da, dd, dh: 0 });
    for (const c of cands) if (sees(c)) return (st.adj = c);
    // up a mast above the surrounding canopy
    place(zero, 0, p);
    const top = q.canopyTop(p.x, p.z, 25);
    return (st.adj = { da: 0, dd: 1, dh: Math.max(0, top - p.y + 3) });
  }

  private vPoint(ctx: CamContext, v: Vessel, x: number, y: number, z: number, out: Vector3): Vector3 {
    v.originInertial(out);
    return out.add(_d.set(x, y, z).applyQuaternion(v.rot)).add(ctx.bodyPos(v.body));
  }

  private upAt(ctx: CamContext, body: CelestialBody, helio: Vector3, out: Vector3): Vector3 {
    return out.copy(helio).sub(ctx.bodyPos(body)).normalize();
  }

  private vesselLength(v: Vessel): number {
    let lo = Infinity, hi = -Infinity;
    for (const a of v.assemblies) { lo = Math.min(lo, a.bottomY); hi = Math.max(hi, a.topY); }
    return isFinite(hi - lo) ? Math.max(2, hi - lo) : 10;
  }

  /** Keep a ground camera above the terrain. */
  private clampGround(ctx: CamContext, body: CelestialBody, p: Vector3, minH = 1.6): void {
    const bp = ctx.bodyPos(body);
    const r = p.distanceTo(bp);
    const g = body.radius + Math.max(0, ctx.groundHeight(body, p)) + minH;
    if (r < g) p.sub(bp).multiplyScalar(g / r).add(bp);
  }

  // ------------------------------------------------------------------------------ main

  update(ctx: CamContext): void {
    const out: CamOut = { pos: new Vector3(), look: new Vector3(), up: new Vector3(0, 1, 0), fov: 50, mount: 'free', handheld: 0, dirOverride: null };
    const v = ctx.active;
    if (!v) return;
    if (!this.orbitTargetDist) this.orbitTargetDist = Math.max(30, this.vesselLength(v) * 2.2);
    switch (this.mode) {
      case 'cinematic': this.cinematic(ctx, out); break;
      case 'chase': this.chase(ctx, v, out); break;
      case 'orbit': this.orbit(ctx, v, out); break;
      case 'onboard': this.onboard(ctx, v, ONBOARD_MOUNTS[this.onboardIndex], out); break;
      case 'tracking': this.tracking(ctx, v, out, null); break;
      case 'free': this.free(ctx, v, out); break;
    }
    this.letterbox += ((this.mode === 'cinematic' ? 1 : 0) - this.letterbox) * Math.min(1, ctx.dt * 2);
    this.apply(ctx, v, out);
  }

  private apply(ctx: CamContext, v: Vessel, out: CamOut): void {
    // orientation
    const dir = _a;
    if (out.dirOverride) dir.copy(out.dirOverride);
    else dir.copy(out.look).sub(out.pos);
    if (dir.lengthSq() < 1e-9) dir.set(0, 0, -1);
    dir.normalize();
    let up = out.up;
    if (Math.abs(dir.dot(up)) > 0.995) up = _b.set(up.y, up.z, up.x).normalize();
    // (Matrix4.lookAt with eye 0 and target dir builds a camera basis looking along dir)
    _m.lookAt(_c.set(0, 0, 0), _d.copy(dir), up);
    this.quat.setFromRotationMatrix(_m);
    // shake
    const plumeDist = ctx.plumeSourceHelio ? out.pos.distanceTo(ctx.plumeSourceHelio) : 1e9;
    this.shake.update(ctx.dt, ctx.t, out.mount, plumeDist, v.vibration, v.telemetry.dynamicPressure, v.telemetry.mach, out.handheld, out.fov);
    this.shake.pushSource(ctx.t, ctx.plumeMN);
    this.quat.multiply(this.shake.rotation);
    this.posHelio.copy(out.pos).add(_c.copy(this.shake.offset).applyQuaternion(this.quat));
    this.fov = out.fov;
    this.lastMount = out.mount;
    this.camera.quaternion.copy(this.quat);
    if (Math.abs(this.camera.fov - this.fov) > 1e-3) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }
  }

  get mount(): CamOut['mount'] { return this.lastMount; }

  // ------------------------------------------------------------------------------ player modes

  private chase(ctx: CamContext, v: Vessel, out: CamOut): void {
    // behind the velocity vector (surface-relative low down, orbital up high), local up as reference
    const com = this.com(ctx, v, out.look);
    const up = this.upAt(ctx, v.body, com, _b);
    const vel = _c;
    if (v.telemetry.altitude < 60_000 && v.body.atmosphereTop > 0) v.surfaceVelocity(vel); else vel.copy(v.vel);
    let back = vel.lengthSq() > 4 ? vel.normalize().negate() : _d.set(0, -1, 0).applyQuaternion(v.rot);
    if (v.clamped || v.landed) back = _d.set(0, 0, 1).applyQuaternion(v.rot);
    this.orbitDist += ((this.orbitTargetDist || 80) - this.orbitDist) * Math.min(1, ctx.dt * 3);
    const d = this.orbitDist;
    // rotate the "behind" vector by the player's orbit offsets
    const side = _a.crossVectors(back, up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const q1 = new Quaternion().setFromAxisAngle(up, this.orbitAz - 0.6);
    const off = back.clone().applyQuaternion(q1);
    const q2 = new Quaternion().setFromAxisAngle(side.applyQuaternion(q1), -this.orbitEl * 0.9);
    off.applyQuaternion(q2).normalize();
    out.pos.copy(com).addScaledVector(off, d).addScaledVector(up, d * 0.12);
    out.up.copy(up);
    out.fov = 55;
    out.mount = 'free';
    if (v.body.def.hasSurface) this.clampGround(ctx, v.body, out.pos, 2);
  }

  private orbit(ctx: CamContext, v: Vessel, out: CamOut): void {
    // free orbit around the vessel in the local horizon frame
    const com = this.com(ctx, v, out.look);
    const up = this.upAt(ctx, v.body, com, _b);
    const north = _c.set(0, 0, 1).applyQuaternion(_q.identity());
    // body pole (approx: ecliptic z tilted) -> use body orientation
    const rot = new Quaternion();
    v.body.orientationAt(ctx.t, rot);
    north.set(0, 0, 1).applyQuaternion(rot);
    north.addScaledVector(up, -north.dot(up));
    if (north.lengthSq() < 1e-8) north.set(1, 0, 0);
    north.normalize();
    const east = _a.crossVectors(north, up);
    this.orbitDist += ((this.orbitTargetDist || 80) - this.orbitDist) * Math.min(1, ctx.dt * 3);
    const d = this.orbitDist;
    const ce = Math.cos(this.orbitEl);
    out.pos.copy(com).addScaledVector(north, Math.cos(this.orbitAz) * ce * d).addScaledVector(east, Math.sin(this.orbitAz) * ce * d).addScaledVector(up, Math.sin(this.orbitEl) * d);
    out.up.copy(up);
    out.fov = 50;
    if (v.body.def.hasSurface) this.clampGround(ctx, v.body, out.pos, 2);
  }

  private free(ctx: CamContext, v: Vessel, out: CamOut): void {
    if (this.freePos.lengthSq() === 0) this.com(ctx, v, this.freePos).add(_a.set(60, 20, 60));
    out.pos.copy(this.freePos);
    const up = this.upAt(ctx, v.body, out.pos, _b);
    // yaw/pitch around local up
    const rot = new Quaternion();
    v.body.orientationAt(ctx.t, rot);
    const north = _c.set(0, 0, 1).applyQuaternion(rot);
    north.addScaledVector(up, -north.dot(up)).normalize();
    const east = _a.crossVectors(north, up);
    const dir = new Vector3().copy(north).multiplyScalar(Math.cos(this.freeYaw) * Math.cos(this.freePitch)).addScaledVector(east, Math.sin(this.freeYaw) * Math.cos(this.freePitch)).addScaledVector(up, Math.sin(this.freePitch));
    out.dirOverride = dir;
    out.up.copy(up);
    out.fov = 55;
  }

  /** Move the free camera (local horizon frame: forward/right/up in metres). */
  freeMove(ctx: CamContext, fwd: number, right: number, upm: number): void {
    const v = ctx.active;
    if (!v) return;
    const up = this.upAt(ctx, v.body, this.freePos, new Vector3());
    const rot = new Quaternion();
    v.body.orientationAt(ctx.t, rot);
    const north = new Vector3(0, 0, 1).applyQuaternion(rot);
    north.addScaledVector(up, -north.dot(up)).normalize();
    const east = new Vector3().crossVectors(north, up);
    const f = north.clone().multiplyScalar(Math.cos(this.freeYaw)).addScaledVector(east, Math.sin(this.freeYaw));
    const r = new Vector3().crossVectors(f, up);
    this.freePos.addScaledVector(f, fwd).addScaledVector(r, right).addScaledVector(up, upm);
  }

  private onboard(ctx: CamContext, v: Vessel, mount: OnboardMount, out: CamOut): void {
    // mounts on the topmost assembly that has engines (upper stage) or the root
    let a = v.rootAssembly;
    for (const x of v.assemblies) if (x.engines.length && x.topY > a.topY && !x.def.offset) a = x;
    const r = a.maxRadius;
    const vehUp = _b.set(0, 1, 0).applyQuaternion(v.rot);
    out.mount = 'vehicle';
    out.fov = 72;
    switch (mount) {
      case 'down': {
        // on the side of the vehicle looking down its length (the classic launch view)
        const y = Math.min(a.topY - 1.5, a.bottomY + Math.max(4, (a.topY - a.bottomY) * 0.7));
        this.vPoint(ctx, v, r + 0.35, y, 0, out.pos);
        out.dirOverride = _c.set(0.16, -1, 0.02).normalize().applyQuaternion(v.rot).clone();
        out.up.copy(_d.set(1, 0, 0).applyQuaternion(v.rot));
        out.fov = 78;
        break;
      }
      case 'up': {
        const y = a.bottomY + (a.topY - a.bottomY) * 0.35;
        this.vPoint(ctx, v, r + 0.35, y, 0, out.pos);
        out.dirOverride = _c.set(0.12, 1, 0.0).normalize().applyQuaternion(v.rot).clone();
        out.up.copy(_d.set(1, 0, 0).applyQuaternion(v.rot));
        break;
      }
      case 'engines': {
        const y = a.bottomY + 0.8;
        this.vPoint(ctx, v, r * 0.9 + 0.6, y + 2.2, r * 0.3, out.pos);
        out.dirOverride = _c.set(-0.45, -1, -0.1).normalize().applyQuaternion(v.rot).clone();
        out.up.copy(vehUp);
        out.fov = 85;
        break;
      }
      case 'side': {
        const L = this.vesselLength(v);
        this.vPoint(ctx, v, r + L * 0.35, L * 0.45, L * 0.2, out.pos);
        this.com(ctx, v, out.look);
        out.up.copy(vehUp);
        out.fov = 60;
        out.mount = 'vehicle';
        break;
      }
    }
  }

  /** Long-lens ground tracking camera (press site / range camera). */
  private tracking(ctx: CamContext, v: Vessel, out: CamOut, st: ShotState | null): void {
    const site = ctx.site;
    const com = this.com(ctx, v, _c);
    if (st && !st.anchorBody) {
      // choose a camera site ~3-6 km from the pad (or under the vessel's ground track)
      if (site && com.distanceTo(site.origin) < 80_000) {
        const ang = st.a * Math.PI * 2;
        const dist = 3500 + st.b * 2500;
        this.sitePoint(ctx, Math.cos(ang) * dist, 3, Math.sin(ang) * dist, st.anchor);
        st.anchorBody = site.body;
      } else {
        const up = this.upAt(ctx, v.body, com, _a);
        const alt = v.telemetry.altitude;
        st.anchor.copy(com).addScaledVector(up, -alt + 5).add(_b.set(st.a - 0.5, st.b - 0.5, st.c - 0.5).normalize().multiplyScalar(Math.max(2000, alt * 0.6)));
        st.anchorBody = v.body;
      }
      // store body-fixed so the camera turns with the planet
      const rot = new Quaternion();
      st.anchorBody.orientationAt(ctx.t, rot);
      st.anchorFixed = st.anchor.clone().sub(ctx.bodyPos(st.anchorBody)).applyQuaternion(rot.invert());
    }
    if (st && st.anchorFixed && st.anchorBody) {
      const rot = new Quaternion();
      st.anchorBody.orientationAt(ctx.t, rot);
      out.pos.copy(st.anchorFixed).applyQuaternion(rot).add(ctx.bodyPos(st.anchorBody));
      this.clampGround(ctx, st.anchorBody, out.pos, 1.7);
    } else if (site) {
      this.sitePoint(ctx, -4200, 3, 2600, out.pos);
      this.clampGround(ctx, site.body, out.pos, 1.7);
    } else {
      this.chase(ctx, v, out);
      return;
    }
    // operator lag on the look point + auto zoom keeping the vehicle (and some plume) framed
    const target = com.clone();
    const d = out.pos.distanceTo(target);
    const L = this.vesselLength(v);
    const frame = v.telemetry.thrust > 0 && v.telemetry.altitude < 40_000 ? L * 3.2 : L * 2.2;
    const fovT = MathUtils.clamp(MathUtils.radToDeg(2 * Math.atan(frame / 2 / Math.max(1, d))), 0.35, 45);
    // the operator is already framed when the shot cuts in, a little loose, and eases in tighter
    if (!this.smoothLookInit) { this.smoothLook.copy(target); this.smoothLookInit = true; this.smoothFov = Math.min(30, fovT * 1.8); }
    this.smoothLook.lerp(target, Math.min(1, ctx.dt * 3.2));
    // keep up with fast targets
    if (this.smoothLook.distanceTo(target) > d * 0.08) this.smoothLook.copy(target).lerp(this.smoothLook, 0.5);
    out.look.copy(this.smoothLook);
    this.smoothFov += (fovT - this.smoothFov) * Math.min(1, ctx.dt * 1.5);
    out.fov = this.smoothFov;
    out.up.copy(this.upAt(ctx, st?.anchorBody ?? v.body, out.pos, _a));
    out.mount = 'ground';
    out.handheld = 0.6;
  }

  // ------------------------------------------------------------------------------ cinematic

  private cinematic(ctx: CamContext, out: CamOut): void {
    const v = ctx.active!;
    this.cutCooldown -= ctx.dt;
    if (!this.shot) this.startShot(this.pickShot(ctx));
    const st = this.shot!;
    st.tau += ctx.dt;
    if (st.tau > st.dur && this.cutCooldown <= 0) {
      this.startShot(this.pickShot(ctx));
      return this.cinematic(ctx, out);
    }
    const ok = this.renderShot(ctx, v, st, out);
    if (!ok) { this.startShot(this.pickShot(ctx)); this.renderShot(ctx, v, this.shot!, out); }
  }

  /** Returns false if the shot can't be shown (e.g. no launch site). */
  private renderShot(ctx: CamContext, v: Vessel, st: ShotState, out: CamOut): boolean {
    const site = ctx.site;
    const near = site ? this.com(ctx, v, _c).distanceTo(site.origin) < 30_000 : false;
    const L = this.vesselLength(v);
    const tau = st.tau;
    const deck = ctx.deckHeight;
    const vehicleBase = () => this.vPoint(ctx, v, 0, 0, 0, new Vector3());
    out.mount = 'ground';
    out.handheld = 0.15;
    const siteUp = () => (site ? _a.set(0, 1, 0).applyQuaternion(site.quat).clone() : this.upAt(ctx, v.body, this.com(ctx, v, _b), _a).clone());
    switch (st.id) {
      // ---------------------------------------------------------------- pad (countdown)
      case 'pad_wide': {
        if (!site || !near) return false;
        st.dur = 10;
        const place = (adj: SpotAdj, tt: number, o: Vector3) => {
          const ang = this.padAngle(st.a) + adj.da + tt * 0.012;
          const dist = (380 + st.b * 260) * adj.dd;
          const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
          return o.set(x, this.gy(ctx, x, z) + 6 + st.c * 14 + adj.dh, z);
        };
        const adj = this.clearSpot(ctx, st, this.padSight(ctx, L, 120, false), place);
        place(adj, tau, _e);
        this.sitePoint(ctx, _e.x, _e.y, _e.z, out.pos);
        this.vPoint(ctx, v, 0, L * 0.42, 0, out.look);
        out.up.copy(siteUp());
        out.fov = MathUtils.radToDeg(2 * Math.atan((L * 1.7) / 2 / Math.hypot(_e.x, _e.z)));
        return true;
      }
      case 'pad_dolly': {
        if (!site || !near) return false;
        st.dur = 9;
        const place = (adj: SpotAdj, tt: number, o: Vector3) => {
          const ang = this.padAngle(st.a) + adj.da;
          const dist = (160 - tt * 6) * adj.dd;
          return o.set(Math.cos(ang) * dist, 3 + tt * 1.2 + adj.dh, Math.sin(ang) * dist);
        };
        const adj = this.clearSpot(ctx, st, this.padSight(ctx, L, 0, true), place);
        place(adj, tau, _e);
        this.sitePoint(ctx, _e.x, _e.y, _e.z, out.pos);
        this.vPoint(ctx, v, 0, L * 0.5 + tau * 0.8, 0, out.look);
        out.up.copy(siteUp());
        out.fov = 38;
        return true;
      }
      case 'pad_hero': {
        if (!site || !near) return false;
        st.dur = 11;
        // low, slow orbit close to the base looking up the full height
        const place = (adj: SpotAdj, tt: number, o: Vector3) => {
          const ang = this.padAngle(st.a, 0.8) + adj.da + tt * 0.04;
          const dist = Math.max(30, L * 0.75) * adj.dd;
          return o.set(Math.cos(ang) * dist, 1.8 + adj.dh, Math.sin(ang) * dist);
        };
        const adj = this.clearSpot(ctx, st, this.padSight(ctx, L, 0, true), place);
        place(adj, tau, _e);
        this.sitePoint(ctx, _e.x, _e.y, _e.z, out.pos);
        this.vPoint(ctx, v, 0, L * 0.55, 0, out.look);
        out.up.copy(siteUp());
        out.fov = 62;
        return true;
      }
      case 'pad_low': {
        if (!site || !near) return false;
        st.dur = 8;
        // on a camera mast out in the scrub, long lens compressing the treeline, pad and vehicle
        const place = (adj: SpotAdj, _tt: number, o: Vector3) => {
          const ang = this.padAngle(st.a) + adj.da;
          const dist = (900 + st.b * 500) * adj.dd;
          const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
          return o.set(x, this.gy(ctx, x, z) + 7 + adj.dh, z);
        };
        const adj = this.clearSpot(ctx, st, this.padSight(ctx, L, 160, false), place);
        place(adj, tau, _e);
        this.sitePoint(ctx, _e.x, _e.y, _e.z, out.pos);
        this.vPoint(ctx, v, 0, L * 0.45, 0, out.look);
        out.up.copy(siteUp());
        out.fov = MathUtils.radToDeg(2 * Math.atan((L * 1.5) / 2 / Math.hypot(_e.x, _e.z)));
        out.handheld = 0.3;
        return true;
      }
      case 'tower_up': {
        if (!site || !near || !ctx.towerTop) return false;
        st.dur = 8;
        // beside the tower, low on the structure, looking up the vehicle toward the nose
        const tt = ctx.towerTop;
        const r = v.rootAssembly.maxRadius;
        const towerAng = Math.atan2(tt.z, tt.x);
        const ang = towerAng + (st.b < 0.5 ? -1 : 1) * (0.75 + st.a * 0.25);
        const rr = Math.hypot(tt.x, tt.z) + r + 6;
        const y = deck + L * (0.08 + st.a * 0.1);
        this.sitePoint(ctx, Math.cos(ang) * rr, y, Math.sin(ang) * rr, out.pos);
        this.vPoint(ctx, v, 0, L * 0.98, 0, out.look);
        out.up.copy(siteUp());
        out.fov = 64;
        return true;
      }
      case 'vent_close': {
        if (!site || !near) return false;
        st.dur = 7;
        // tight on the venting tank top with a long lens
        let y = L * 0.6;
        for (const a of v.assemblies) for (const s of a.def.sections) if (s.frost && s.propellant) y = s.y + s.length - 0.6;
        // out in the vegetation: placed where the line of sight to the tank top is clear
        const place = (adj: SpotAdj, _tt: number, o: Vector3) => {
          const ang = this.padAngle(st.a) + adj.da;
          const dist = 260 * adj.dd;
          const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
          return o.set(x, Math.max(deck + y * 0.5, this.gy(ctx, x, z) + 2) + adj.dh, z);
        };
        const adj = this.clearSpot(ctx, st, [[new Vector3(0, deck + y, 0), Infinity]], place);
        place(adj, tau, _e);
        this.sitePoint(ctx, _e.x, _e.y, _e.z, out.pos);
        this.vPoint(ctx, v, 0, y, 0, out.look);
        out.up.copy(siteUp());
        out.fov = MathUtils.radToDeg(2 * Math.atan(14 / 2 / Math.hypot(_e.x, _e.z)));
        out.handheld = 0.4;
        return true;
      }
      case 'arm_detail': {
        if (!site || !near || !ctx.towerTop) return false;
        st.dur = 8;
        const tt = ctx.towerTop;
        const place = (adj: SpotAdj, _tt: number, o: Vector3) => {
          const ang = Math.atan2(tt.z, tt.x) + 0.9 + st.a * 0.5 + adj.da;
          const dist = 120 * adj.dd;
          return o.set(Math.cos(ang) * dist, deck + L * 0.5 + adj.dh, Math.sin(ang) * dist);
        };
        const adj = this.clearSpot(ctx, st, [[new Vector3(tt.x * 0.4, deck + L * 0.62, tt.z * 0.4), Infinity]], place);
        place(adj, tau, _e);
        this.sitePoint(ctx, _e.x, _e.y, _e.z, out.pos);
        this.sitePoint(ctx, tt.x * 0.4, deck + L * 0.62, tt.z * 0.4, out.look);
        out.up.copy(siteUp());
        out.fov = 30;
        return true;
      }
      case 'engine_bay': {
        if (!site || !near) return false;
        st.dur = 7;
        // on the deck beside the hold-down clamps, looking across the engine section
        const ang = this.padAngle(st.a, 0.7);
        const r = v.rootAssembly.maxRadius;
        this.sitePoint(ctx, Math.cos(ang) * (r + 11), deck + 1.6, Math.sin(ang) * (r + 11), out.pos);
        this.vPoint(ctx, v, 0, 2.5, 0, out.look);
        out.up.copy(siteUp());
        out.fov = 58;
        return true;
      }
      case 'engine_close': {
        if (!site || !near) return false;
        st.dur = 3.2;
        // beside the flame trench, low, looking at the nozzles as they light
        const r = v.rootAssembly.maxRadius;
        const ang = this.padAngle(0.4 + st.a * 0.2, 0.5);
        this.sitePoint(ctx, Math.cos(ang) * (r + 26), deck + 0.6, Math.sin(ang) * (r + 26), out.pos);
        this.vPoint(ctx, v, 0, 1.0, 0, out.look);
        out.up.copy(siteUp());
        out.fov = 48;
        return true;
      }
      case 'liftoff_low': {
        if (!site || !near) return false;
        st.dur = 4.5;
        // low and long: far enough out (and on a longer lens) that the ground cloud boiling out
        // from the pad has not reached the camera before the cut
        const place = (adj: SpotAdj, _tt: number, o: Vector3) => {
          const ang = this.padAngle(st.a, 0.6) + adj.da;
          const dist = 420 * adj.dd;
          return o.set(Math.cos(ang) * dist, 2.2 + adj.dh, Math.sin(ang) * dist);
        };
        const adj = this.clearSpot(ctx, st, this.padSight(ctx, L, 0, true), place);
        place(adj, tau, _e);
        this.sitePoint(ctx, _e.x, _e.y, _e.z, out.pos);
        const base = vehicleBase();
        out.look.copy(base).addScaledVector(siteUp(), L * 0.5);
        out.up.copy(siteUp());
        out.fov = 30;
        return true;
      }
      case 'tower_rise': {
        if (!site || !near) return false;
        st.dur = 6;
        // fixed camera on the deck looking straight up past the vehicle as it climbs
        const r = v.rootAssembly.maxRadius;
        this.sitePoint(ctx, r + 10, deck + 1.5, -r - 6, out.pos);
        this.com(ctx, v, out.look);
        out.up.copy(_a.set(-1, 0, 0).applyQuaternion(site.quat));
        out.fov = 75;
        return true;
      }
      // ---------------------------------------------------------------- flight
      case 'tracking_long': {
        st.dur = 11;
        this.tracking(ctx, v, out, st);
        return true;
      }
      case 'chase_below': case 'chase_side': case 'chase_upper': {
        st.dur = st.id === 'chase_upper' ? 9 : 8;
        const com = this.com(ctx, v, out.look);
        const up = this.upAt(ctx, v.body, com, _b).clone();
        const vehUp = _a.set(0, 1, 0).applyQuaternion(v.rot).clone();
        const side = _d.set(1, 0, 0).applyQuaternion(v.rot).applyAxisAngle(vehUp, st.a * Math.PI * 2).clone();
        const dist = L * (st.id === 'chase_side' ? 1.6 : 1.3) + 10;
        const below = st.id === 'chase_below' ? -0.9 : st.id === 'chase_upper' ? -0.55 : -0.15;
        out.pos.copy(com).addScaledVector(side, dist).addScaledVector(vehUp, below * dist + Math.sin(tau * 0.2) * 3);
        out.up.copy(st.id === 'chase_side' ? up : vehUp);
        out.fov = st.id === 'chase_below' ? 62 : 48;
        out.mount = 'vehicle';
        out.handheld = 0.25;
        if (v.body.def.hasSurface) this.clampGround(ctx, v.body, out.pos, 3);
        return true;
      }
      case 'flyby': {
        // camera placed ahead of the vehicle; it roars past
        st.dur = 4;
        if (!st.anchorBody) {
          const com = this.com(ctx, v, _b);
          const vel = new Vector3();
          v.surfaceVelocity(vel);
          const speed = vel.length();
          if (speed < 50) return false;
          const vehUp = new Vector3(0, 1, 0).applyQuaternion(v.rot);
          const side = new Vector3().crossVectors(vel, this.upAt(ctx, v.body, com, _a)).normalize();
          if (side.lengthSq() < 0.5) side.set(1, 0, 0).applyQuaternion(v.rot);
          st.anchor.copy(com).addScaledVector(vel, 1.6).addScaledVector(side, L * 0.8 + 12).addScaledVector(vehUp, L * 0.2);
          st.anchorBody = v.body;
          const rot = new Quaternion();
          v.body.orientationAt(ctx.t, rot);
          st.anchorFixed = st.anchor.clone().sub(ctx.bodyPos(v.body)).applyQuaternion(rot.invert());
        }
        const rot = new Quaternion();
        st.anchorBody!.orientationAt(ctx.t, rot);
        out.pos.copy(st.anchorFixed!).applyQuaternion(rot).add(ctx.bodyPos(st.anchorBody!));
        this.com(ctx, v, out.look);
        out.up.copy(this.upAt(ctx, v.body, out.pos, _a));
        out.fov = 50;
        out.handheld = 0.5;
        out.mount = 'ground';
        return true;
      }
      case 'onboard_down': st.dur = 8; this.onboard(ctx, v, 'down', out); return true;
      case 'onboard_engines': st.dur = 6; this.onboard(ctx, v, 'engines', out); return true;
      case 'interstage': {
        // camera on the upper stage looking aft at the departing booster
        st.dur = 7;
        // lowest engine-bearing assembly still attached (the stage that just took over)
        let a = v.rootAssembly;
        for (const x of v.assemblies) if (x.engines.length && !x.def.offset && x.bottomY < a.bottomY) a = x;
        let skirt = a.bottomY;
        for (const s of a.def.sections) skirt = Math.min(skirt, s.y);
        const r = a.maxRadius;
        // on the skirt edge, looking aft past the engine bell at the departing booster
        this.vPoint(ctx, v, r * 0.98 + 0.15, skirt + 0.4, 0, out.pos);
        out.dirOverride = _c.set(0.22, -1, 0.05).normalize().applyQuaternion(v.rot).clone();
        out.up.copy(_d.set(1, 0, 0).applyQuaternion(v.rot));
        out.fov = 80;
        out.mount = 'vehicle';
        return true;
      }
      case 'payload_cam': {
        st.dur = 6;
        const top = Math.max(...v.assemblies.map((x) => x.topY));
        const r = v.rootAssembly.maxRadius;
        this.vPoint(ctx, v, r + 0.3, top - 6, 0, out.pos);
        out.dirOverride = _c.set(0.3, 1, 0).normalize().applyQuaternion(v.rot).clone();
        out.up.copy(_d.set(1, 0, 0).applyQuaternion(v.rot));
        out.fov = 75;
        out.mount = 'vehicle';
        return true;
      }
      case 'orbit_beauty': case 'orbit_drift': case 'orbit_limb': {
        st.dur = st.id === 'orbit_drift' ? 18 : 14;
        const com = this.com(ctx, v, out.look);
        const up = this.upAt(ctx, v.body, com, _b).clone();
        const along = _a.copy(v.vel).addScaledVector(up, -v.vel.dot(up)).normalize().clone();
        const normal = new Vector3().crossVectors(up, along);
        const dist = L * (st.id === 'orbit_limb' ? 3.5 : 1.8) + 15;
        const ang = st.a * Math.PI * 2 + tau * (st.id === 'orbit_drift' ? 0.025 : 0.012);
        const elev = st.id === 'orbit_limb' ? -0.25 : 0.25 + st.b * 0.3;
        out.pos.copy(com).addScaledVector(along, Math.cos(ang) * dist * Math.cos(elev)).addScaledVector(normal, Math.sin(ang) * dist * Math.cos(elev)).addScaledVector(up, Math.sin(elev) * dist);
        if (st.id === 'orbit_limb') out.look.addScaledVector(up, -dist * 0.4);
        out.up.copy(up);
        out.fov = st.id === 'orbit_limb' ? 60 : 42;
        out.mount = 'free';
        out.handheld = 0.08;
        return true;
      }
      case 'booster_chase': {
        const b = ctx.boosters.find((x) => !x.destroyed && !x.landed) ?? null;
        if (!b) return false;
        st.dur = 7;
        const com = this.com(ctx, b, out.look);
        const up = this.upAt(ctx, b.body, com, _b).clone();
        const vel = new Vector3();
        b.surfaceVelocity(vel);
        const bl = this.vesselLength(b);
        const side = new Vector3().crossVectors(vel.lengthSq() > 1 ? vel.normalize() : up, up).normalize();
        if (side.lengthSq() < 0.5) side.set(1, 0, 0);
        out.pos.copy(com).addScaledVector(side, bl * 1.8 + 15).addScaledVector(up, bl * 0.4);
        out.up.copy(up);
        out.fov = 50;
        out.mount = 'free';
        out.handheld = 0.2;
        if (b.body.def.hasSurface) this.clampGround(ctx, b.body, out.pos, 3);
        return true;
      }
      case 'lz_ground': {
        const b = st.subject ?? ctx.boosters.find((x) => !x.destroyed) ?? null;
        const target = b ?? v;
        const zone = ctx.zones.length ? ctx.zones.reduce((best, z) => (z.pos.distanceTo(this.com(ctx, target, _a)) < best.pos.distanceTo(this.com(ctx, target, _a)) ? z : best)) : null;
        if (!zone) return false;
        st.dur = 14;
        // twin landings: when another pad lies close by, frame both boosters coming down together
        const twins = ctx.zones.filter((z) => z.kind === 'pad' && z.pos.distanceTo(zone.pos) < 1500);
        const twin = twins.length >= 2 && ctx.boosters.filter((x) => !x.destroyed).length >= 2;
        if (!st.anchorBody) {
          const up = this.upAt(ctx, target.body, zone.pos, _b).clone();
          let centre = zone.pos.clone();
          let side = new Vector3(up.y, -up.x, 0).normalize();
          let dist = 320;
          if (twin) {
            centre = twins.reduce((acc, z) => acc.add(z.pos), new Vector3()).multiplyScalar(1 / twins.length);
            const span = twins[0].pos.clone().sub(twins[1].pos);
            span.addScaledVector(up, -span.dot(up));
            side = new Vector3().crossVectors(up, span.normalize()).normalize();
            dist = 650 + span.length() * 0.5;
          }
          st.anchor.copy(centre).addScaledVector(side, dist).addScaledVector(up, 4);
          st.anchorBody = target.body;
          const rot = new Quaternion();
          target.body.orientationAt(ctx.t, rot);
          st.anchorFixed = st.anchor.clone().sub(ctx.bodyPos(target.body)).applyQuaternion(rot.invert());
        }
        const rot = new Quaternion();
        st.anchorBody!.orientationAt(ctx.t, rot);
        out.pos.copy(st.anchorFixed!).applyQuaternion(rot).add(ctx.bodyPos(st.anchorBody!));
        this.clampGround(ctx, st.anchorBody!, out.pos, 1.8);
        // look at the booster, or at the middle of the pair
        const pair = twin ? ctx.boosters.filter((x) => !x.destroyed).slice(0, 2) : [];
        const com = pair.length === 2 ? this.com(ctx, pair[0], _c).add(this.com(ctx, pair[1], _d)).multiplyScalar(0.5) : this.com(ctx, target, _c);
        if (!this.smoothLookInit) { this.smoothLook.copy(com); this.smoothLookInit = true; }
        this.smoothLook.lerp(com, Math.min(1, ctx.dt * 4));
        out.look.copy(this.smoothLook);
        const d = out.pos.distanceTo(com);
        const extent = pair.length === 2 ? Math.max(this.vesselLength(target) * 3, this.com(ctx, pair[0], _a).distanceTo(this.com(ctx, pair[1], _b)) * 1.5 + this.vesselLength(target) * 1.5) : this.vesselLength(target) * 3;
        out.fov = MathUtils.clamp(MathUtils.radToDeg(2 * Math.atan(extent / 2 / d)), 1, 55);
        out.up.copy(this.upAt(ctx, st.anchorBody!, out.pos, _a));
        out.handheld = 0.5;
        return true;
      }
      case 'entry_front': case 'entry_chase': {
        st.dur = 9;
        const com = this.com(ctx, v, out.look);
        const vel = new Vector3();
        v.surfaceVelocity(vel);
        const dir = vel.lengthSq() > 1 ? vel.normalize() : new Vector3(0, -1, 0).applyQuaternion(v.rot);
        const up = this.upAt(ctx, v.body, com, _b).clone();
        const side = new Vector3().crossVectors(dir, up).normalize();
        const dist = L * 3 + 12;
        if (st.id === 'entry_front') out.pos.copy(com).addScaledVector(dir, dist * 0.8).addScaledVector(side, dist * 0.6).addScaledVector(up, -dist * 0.2);
        else out.pos.copy(com).addScaledVector(dir, -dist).addScaledVector(side, dist * 0.35).addScaledVector(up, dist * 0.25);
        out.up.copy(up);
        out.fov = 50;
        out.mount = 'vehicle';
        out.handheld = 0.4;
        return true;
      }
      case 'chute_below': {
        st.dur = 10;
        const com = this.com(ctx, v, out.look);
        const up = this.upAt(ctx, v.body, com, _b).clone();
        const east = new Vector3(up.y, -up.x, 0).normalize();
        out.pos.copy(com).addScaledVector(up, -L * 4 - 20).addScaledVector(east, L * 3 + 15);
        out.look.addScaledVector(up, L * 2);
        out.up.copy(up);
        out.fov = 55;
        out.mount = 'free';
        out.handheld = 0.3;
        if (v.body.def.hasSurface) this.clampGround(ctx, v.body, out.pos, 2);
        return true;
      }
      case 'splash': {
        st.dur = 12;
        const com = this.com(ctx, v, out.look);
        const up = this.upAt(ctx, v.body, com, _b).clone();
        const east = new Vector3(up.y, -up.x, 0).normalize();
        const alt = v.telemetry.radarAltitude;
        out.pos.copy(com).addScaledVector(up, -alt + 2.5).addScaledVector(east, 90 + st.a * 40);
        out.up.copy(up);
        out.fov = 40;
        out.handheld = 0.6;
        this.clampGround(ctx, v.body, out.pos, 2);
        return true;
      }
    }
    return false;
  }
}

void ONBOARD_MOUNTS;
