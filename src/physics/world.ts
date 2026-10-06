import { Matrix4, Quaternion, Vector3 } from 'three';
import type { VehicleDef } from '../vehicles/types';
import { CelestialBody, SolarSystem } from './bodies';
import { keplerPropagate } from './orbit';
import { AssemblyRuntime, PhysicsEnv, TerrainProvider, Vessel, VesselEvent, WeatherProvider } from './vessel';

export const WARP_LEVELS = [1, 2, 5, 10, 50, 100, 1000, 10000, 100000, 1000000];
export const MAX_PHYSICS_WARP = 10;

const _r = new Vector3();
const _v = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _q = new Quaternion();

export interface WorldEvent {
  vessel: Vessel;
  event: VesselEvent;
}

export type GuidanceFactory = (v: Vessel, world: PhysicsWorld) => Vessel['guidance'];

export class PhysicsWorld {
  readonly system: SolarSystem;
  t: number;
  terrain: TerrainProvider;
  weather: WeatherProvider;
  vessels: Vessel[] = [];
  active: Vessel | null = null;
  warp = 1;
  warpIndex = 0;
  warpReason = '';
  paused = false;
  events: WorldEvent[] = [];
  guidanceFactory: GuidanceFactory | null = null;
  /** debris older than this (s) and far from the camera is culled */
  debrisLifetime = 1800;
  /** called when vessels are created by separation */
  onVesselCreated: ((v: Vessel, parent: Vessel, kind: string) => void) | null = null;
  onVesselRemoved: ((v: Vessel) => void) | null = null;
  private env: PhysicsEnv;
  /** auto-slow requests (e.g. SOI change) */
  autoWarpStop = true;
  stepCount = 0;

  constructor(system: SolarSystem, t: number, terrain: TerrainProvider, weather: WeatherProvider) {
    this.system = system;
    this.t = t;
    this.terrain = terrain;
    this.weather = weather;
    this.env = { t, terrain, weather };
  }

  addVessel(v: Vessel): void {
    this.vessels.push(v);
    if (!this.active) this.active = v;
  }

  removeVessel(v: Vessel): void {
    this.vessels = this.vessels.filter((x) => x !== v);
    if (this.active === v) this.active = this.vessels[0] ?? null;
    this.onVesselRemoved?.(v);
  }

  /** Whether rails (on-rails Kepler) warp is currently permitted, with a reason if not. */
  railsAllowed(): { ok: boolean; reason: string } {
    for (const v of this.vessels) {
      if (v.destroyed) continue;
      const atmTop = v.body.atmosphereTop;
      const alt = v.pos.length() - v.body.radius;
      const isRelevant = v === this.active || !!v.guidance;
      if (!isRelevant) continue;
      if (v.clamped) return { ok: false, reason: 'On the launch pad' };
      if (!v.landed && atmTop > 0 && alt < atmTop) return { ok: false, reason: 'In atmosphere' };
      if (v.telemetry.thrust > 0) return { ok: false, reason: 'Engines firing' };
      if (v.guidance && !v.landed) return { ok: false, reason: 'Booster recovery in progress' };
    }
    return { ok: true, reason: '' };
  }

  setWarpIndex(i: number): void {
    i = Math.max(0, Math.min(WARP_LEVELS.length - 1, i));
    let w = WARP_LEVELS[i];
    if (w > MAX_PHYSICS_WARP) {
      const r = this.railsAllowed();
      if (!r.ok) {
        this.warpReason = r.reason;
        i = WARP_LEVELS.indexOf(MAX_PHYSICS_WARP);
        w = MAX_PHYSICS_WARP;
      } else this.warpReason = '';
    } else this.warpReason = '';
    this.warpIndex = i;
    this.warp = w;
  }

  /** Advance the simulation by a real-time interval. */
  update(realDt: number): void {
    if (this.paused) return;
    realDt = Math.min(realDt, 0.1);
    // re-validate rails warp each frame
    if (this.warp > MAX_PHYSICS_WARP) {
      const r = this.railsAllowed();
      if (!r.ok) { this.warpReason = r.reason; this.setWarpIndex(WARP_LEVELS.indexOf(MAX_PHYSICS_WARP)); }
    }
    const simDt = realDt * this.warp;
    if (this.warp > MAX_PHYSICS_WARP) this.updateRails(simDt);
    else this.updatePhysics(simDt);
    this.collectEvents();
    this.cullDebris();
  }

  private physicsDt(v: Vessel): number {
    const alt = v.pos.length() - v.body.radius;
    const near = v.body.def.hasSurface && alt < 3000;
    if (v.clamped || near || v.telemetry.thrust > 0 || (v.body.atmosphereTop > 0 && alt < v.body.atmosphereTop)) return 1 / 120;
    return 1 / 30;
  }

  updatePhysics(simDt: number): void {
    // step each vessel with its own fixed substep, time-aligned per frame
    const t0 = this.t;
    for (const v of this.vessels) {
      if (v.destroyed) continue;
      let remaining = simDt;
      let tv = t0;
      let guard = 0;
      while (remaining > 1e-9 && guard++ < 4000) {
        const dt = Math.min(this.physicsDt(v), remaining);
        this.env.t = tv;
        v.step(dt, this.env);
        tv += dt;
        remaining -= dt;
        this.checkSOI(v, tv);
        if (v.destroyed) break;
        if (v.breakupPending) break;
      }
    }
    this.t = t0 + simDt;
    this.env.t = this.t;
    this.stepCount++;
  }

  updateRails(simDt: number): void {
    const t0 = this.t;
    const t1 = t0 + simDt;
    for (const v of this.vessels) {
      if (v.destroyed) continue;
      if (v.landed || v.clamped) {
        this.env.t = t1;
        v.step(1e-6, this.env); // kinematic re-attach
        continue;
      }
      const alt = v.pos.length() - v.body.radius;
      const inAtm = v.body.atmosphereTop > 0 && alt < v.body.atmosphereTop;
      if (inAtm && v !== this.active) {
        // coarse physics for falling debris
        let remaining = simDt;
        let tv = t0;
        let guard = 0;
        while (remaining > 1e-9 && guard++ < 300) {
          const dt = Math.min(0.5, remaining);
          this.env.t = tv;
          v.step(dt, this.env);
          tv += dt;
          remaining -= dt;
          if (v.destroyed || v.landed) break;
        }
        if (remaining > 1e-9 && !v.destroyed && !v.landed) v.destroy('lost');
        continue;
      }
      this.propagateRails(v, t0, t1);
    }
    this.t = t1;
    this.env.t = t1;
  }

  /** Kepler propagation with SOI and atmosphere-entry handling. */
  private propagateRails(v: Vessel, t0: number, t1: number): void {
    let t = t0;
    let guard = 0;
    while (t < t1 - 1e-9 && guard++ < 16) {
      const body = v.body;
      const mu = body.gm;
      // subdivide for event detection
      const span = t1 - t;
      const r0 = v.pos.length();
      const period = 2 * Math.PI * Math.sqrt(Math.pow(Math.max(r0, body.radius), 3) / mu);
      const n = Math.max(4, Math.min(512, Math.ceil(span / (period / 256))));
      const h = span / n;
      let crossed = false;
      let tPrev = t;
      for (let i = 1; i <= n; i++) {
        const tc = t + h * i;
        keplerPropagate(v.pos, v.vel, mu, tc - t, _a, _b);
        const ev = this.railsEvent(v, _a, tc);
        if (ev) {
          // bisect the crossing time between tPrev and tc
          let lo = tPrev, hi = tc;
          for (let k = 0; k < 40; k++) {
            const mid = 0.5 * (lo + hi);
            keplerPropagate(v.pos, v.vel, mu, mid - t, _a, _b);
            if (this.railsEvent(v, _a, mid)) hi = mid; else lo = mid;
          }
          keplerPropagate(v.pos, v.vel, mu, hi - t, _a, _b);
          v.pos.copy(_a); v.vel.copy(_b);
          this.rotateWithSAS(v, hi - t);
          t = hi;
          if (ev === 'atmosphere' || ev === 'surface') {
            this.setWarpIndex(0);
            this.warpReason = ev === 'atmosphere' ? 'Atmospheric entry' : 'Approaching surface';
            v.missionTime += t - t0;
            return; // remainder dropped: warp ends here this frame
          }
          this.checkSOI(v, t);
          if (this.autoWarpStop && v === this.active) {
            // slow down to admire the transition
            const idx = Math.min(this.warpIndex, WARP_LEVELS.indexOf(1000));
            this.setWarpIndex(idx);
          }
          crossed = true;
          break;
        }
        tPrev = tc;
      }
      if (!crossed) {
        keplerPropagate(v.pos, v.vel, mu, t1 - t, _a, _b);
        v.pos.copy(_a); v.vel.copy(_b);
        this.rotateWithSAS(v, t1 - t);
        v.missionTime += t1 - t;
        t = t1;
      }
    }
    v.orbitDirty = true;
  }

  /** Detect rails events at state r (relative to v.body) at time tc. */
  private railsEvent(v: Vessel, r: Vector3, tc: number): 'soi_exit' | 'soi_enter' | 'atmosphere' | 'surface' | null {
    const body = v.body;
    const rl = r.length();
    if (body.parent && rl > body.soi) return 'soi_exit';
    if (body.atmosphereTop > 0 && rl < body.radius + body.atmosphereTop) return 'atmosphere';
    if (body.def.hasSurface && rl < body.radius + 12000 && !body.atmosphere) return 'surface';
    for (const c of body.children) {
      c.localStateAt(tc, _a, _b);
      const dx = r.x - _a.x, dy = r.y - _a.y, dz = r.z - _a.z;
      if (dx * dx + dy * dy + dz * dz < c.soi * c.soi) return 'soi_enter';
    }
    return null;
  }

  /** During rails warp the vessel keeps an inertial attitude (angular velocity is frozen). */
  private rotateWithSAS(v: Vessel, _dt: number): void {
    v.angVel.set(0, 0, 0);
  }

  checkSOI(v: Vessel, t: number): void {
    const body = v.body;
    const rl = v.pos.length();
    if (body.parent && rl > body.soi) {
      body.localStateAt(t, _a, _b);
      v.pos.add(_a);
      v.vel.add(_b);
      const from = body;
      v.body = body.parent;
      v.orbitDirty = true;
      v.events.push({ type: 'soi_change', from, to: v.body });
      return;
    }
    for (const c of body.children) {
      c.localStateAt(t, _a, _b);
      const dx = v.pos.x - _a.x, dy = v.pos.y - _a.y, dz = v.pos.z - _a.z;
      if (dx * dx + dy * dy + dz * dz < c.soi * c.soi) {
        v.pos.sub(_a);
        v.vel.sub(_b);
        const from = body;
        v.body = c;
        v.orbitDirty = true;
        v.events.push({ type: 'soi_change', from, to: c });
        return;
      }
    }
  }

  private collectEvents(): void {
    for (const v of this.vessels) {
      for (const e of v.events) this.events.push({ vessel: v, event: e });
      v.events.length = 0;
      if (v.breakupPending && !v.destroyed) {
        v.breakupPending = false;
        v.destroy('broke up');
      }
    }
  }

  drainEvents(): WorldEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private cullDebris(): void {
    const active = this.active;
    for (const v of [...this.vessels]) {
      if (v === active) continue;
      if (v.destroyed && v.isDebris) {
        // keep destroyed debris briefly for effects, then remove
        (v as any)._deadTime = ((v as any)._deadTime ?? 0) + 1 / 60;
        if ((v as any)._deadTime > 20) this.removeVessel(v);
        continue;
      }
      if (v.isDebris && v.missionTime > this.debrisLifetime && !v.guidance) this.removeVessel(v);
      if (v.isDebris && (v.landed || v.splashed) && v.missionTime > 120 && !v.guidance) this.removeVessel(v);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Staging & separation
  // ---------------------------------------------------------------------------------------

  /** Execute the next staging group on a vessel. Returns the events executed. */
  stage(v: Vessel): boolean {
    const group = v.nextStage;
    if (!group || v.destroyed) return false;
    v.stageIndex++;
    v.events.push({ type: 'stage', index: v.stageIndex - 1, events: group });
    for (const ev of group) this.executeStageEvent(v, ev.action, ev.targets);
    return true;
  }

  executeStageEvent(v: Vessel, action: string, targets: string[]): void {
    switch (action) {
      case 'ignite':
        for (const id of targets) {
          const a = v.getAssembly(id);
          if (!a) continue;
          for (const e of a.engines) e.armed = true;
        }
        break;
      case 'release':
        v.releaseClamps();
        break;
      case 'shutdown':
        for (const id of targets) {
          const a = v.getAssembly(id);
          if (!a) continue;
          for (const e of a.engines) if (!e.isSolid) e.armed = false;
        }
        break;
      case 'separate':
      case 'jettison': {
        this.separate(v, targets);
        break;
      }
      case 'deploy_chutes':
        v.deployChutes();
        break;
      case 'deploy_legs':
        for (const a of v.assemblies) if (a.def.features?.landingLegs) a.legsTarget = 1;
        v.events.push({ type: 'legs' });
        break;
      case 'deploy_solar':
        for (const a of v.assemblies) if (a.def.features?.solarPanels) a.solarTarget = 1;
        v.events.push({ type: 'solar' });
        break;
    }
  }

  /** Separate assemblies from a vessel, creating new physical bodies for them. */
  separate(v: Vessel, ids: string[]): Vessel[] {
    const present = ids.filter((id) => v.getAssembly(id));
    if (!present.length) return [];
    const parentRot = v.rot.clone();
    const parentVel = v.vel.clone();
    const parentAng = v.angVel.clone();
    const comBefore = v.com.clone();
    const posBefore = v.pos.clone();
    // inertial position of the shared vehicle-frame origin
    const origin = _a.copy(comBefore).negate().applyQuaternion(parentRot).add(posBefore).clone();
    const groups = v.detach(present);
    const created: Vessel[] = [];
    for (const g of groups) {
      // which group keeps the spacecraft? If the detached group contains the vessel's spacecraft,
      // swap roles so the player stays with the spacecraft (e.g. LES abort).
      const nv = new Vessel(g.map((x) => x.def.name).join(' + '), v.def, g, v.body);
      nv.isDebris = true;
      nv.rot.copy(parentRot);
      // place so that the shared vehicle frame origin coincides
      nv.pos.copy(nv.com).applyQuaternion(parentRot).add(origin);
      // rigid-body velocity at the new CoM
      const rRel = _b.copy(nv.com).sub(comBefore);
      const wxr = _r.copy(parentAng).cross(rRel).applyQuaternion(parentRot);
      nv.vel.copy(parentVel).add(wxr);
      nv.angVel.copy(parentAng);
      nv.hasLiftedOff = true;
      nv.missionTime = 0;
      nv.timeSinceSeparation = 0;
      nv.telemetry.maxQ = 0;
      this.applySeparationImpulse(v, nv, g);
      // The player always stays with the crew / designated spacecraft.
      const scId = v.def?.spacecraft;
      const groupHasCraft = (scId && g.some((a) => a.id === scId)) || (!v.assemblies.some((a) => a.def.features?.crew) && g.some((a) => a.def.features?.crew));
      if (groupHasCraft && v.assemblies.length) swapBodies(v, nv);
      if (!v.assemblies.length) swapBodies(v, nv);
      created.push(nv);
      this.vessels.push(nv);
      const kind = nv.assemblies[0]?.def.separation?.kind ?? g[0].def.separation?.kind ?? 'stack';
      v.events.push({ type: 'separation', assemblies: nv.assemblies, kind });
      if (nv.assemblies.some((a) => a.def.recovery && a.def.recovery !== 'none') && this.guidanceFactory) {
        nv.isDebris = false;
        nv.guidance = this.guidanceFactory(nv, this);
      }
      this.onVesselCreated?.(nv, v, kind);
    }
    v.timeSinceSeparation = 0;
    v.orbitDirty = true;
    return created;
  }

  private applySeparationImpulse(parent: Vessel, child: Vessel, group: AssemblyRuntime[]): void {
    const root = group[0];
    const sep = root.def.separation ?? { kind: 'stack', impulse: 1.5 };
    const rot = parent.rot;
    const mTot = parent.mass + child.mass;
    const dvChild = sep.impulse * (parent.mass / mTot);
    const dvParent = sep.impulse * (child.mass / mTot);
    switch (sep.kind) {
      case 'radial': {
        // push outward from the core axis, rotate nose outward (Korolev cross)
        const ox = root.offX, oz = root.offZ;
        const l = Math.hypot(ox, oz) || 1;
        _a.set(ox / l, 0, oz / l).applyQuaternion(rot);
        child.vel.addScaledVector(_a, dvChild);
        parent.vel.addScaledVector(_a, -dvParent * 0.2);
        const spin = sep.spin ?? 0.25;
        // angular velocity about the axis perpendicular to radial & long axis
        child.angVel.x += (oz / l) * spin;
        child.angVel.z += (-ox / l) * spin;
        break;
      }
      case 'fairing': {
        const ox = root.offX || (root.id.endsWith('b') ? -1 : 1);
        const oz = root.offZ;
        const l = Math.hypot(ox, oz) || 1;
        _a.set(ox / l, 0, oz / l).applyQuaternion(rot);
        child.vel.addScaledVector(_a, sep.impulse);
        child.angVel.x += (oz / l) * (sep.spin ?? 0.6);
        child.angVel.z += (-ox / l) * (sep.spin ?? 0.6);
        break;
      }
      case 'les': {
        // escape motor pulls the tower up and slightly sideways
        _a.set(0.18, 1, 0.05).normalize().applyQuaternion(rot);
        child.vel.addScaledVector(_a, sep.impulse);
        child.angVel.x += 0.15;
        break;
      }
      default: {
        // stack separation: child goes "down" if it is below the parent's CoM
        const below = child.com.y < parent.com.y;
        _a.set(0, below ? -1 : 1, 0).applyQuaternion(rot);
        child.vel.addScaledVector(_a, dvChild);
        parent.vel.addScaledVector(_a, -dvParent);
        if (sep.spin) child.angVel.x += sep.spin;
        // small random tumble
        child.angVel.x += (Math.random() - 0.5) * 0.01;
        child.angVel.z += (Math.random() - 0.5) * 0.01;
      }
    }
    child.orbitDirty = true;
    parent.orbitDirty = true;
  }

  // ---------------------------------------------------------------------------------------
  // Placement helpers
  // ---------------------------------------------------------------------------------------

  /**
   * Place a vessel standing upright on a body-fixed site (lat, lon, alt of vehicle base),
   * rotated so that the vehicle's -Z axis ("roof") faces `azimuth` (radians from north).
   */
  placeOnSurface(v: Vessel, body: CelestialBody, lat: number, lon: number, altBase: number, azimuth = 0): void {
    v.body = body;
    const up = new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    const north = new Vector3(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat));
    const east = new Vector3().crossVectors(north, up);
    // vehicle +Y = up; vehicle -Z points along azimuth heading
    const head = north.clone().multiplyScalar(Math.cos(azimuth)).addScaledVector(east, Math.sin(azimuth));
    const yAxis = up;
    const zAxis = head.clone().negate();
    const xAxis = new Vector3().crossVectors(yAxis, zAxis);
    const m = new Matrix4();
    m.makeBasis(xAxis, yAxis, zAxis);
    const qFixed = new Quaternion().setFromRotationMatrix(m);
    body.orientationAt(this.t, _q);
    v.rot.copy(_q).multiply(qFixed);
    const baseFixed = up.clone().multiplyScalar(body.radius + altBase);
    const origin = baseFixed.applyQuaternion(_q);
    v.pos.copy(v.com).applyQuaternion(v.rot).add(origin);
    body.angularVelocity(_a);
    v.vel.crossVectors(_a, v.pos);
    v.angVel.set(0, 0, 0);
    v.launchSiteFixed.set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    v.orbitDirty = true;
  }

  /** Place a vessel on a given orbit state relative to a body (inertial). */
  placeInOrbit(v: Vessel, body: CelestialBody, r: Vector3, vel: Vector3, noseDir?: Vector3): void {
    v.body = body;
    v.pos.copy(r);
    v.vel.copy(vel);
    const dir = (noseDir ?? vel).clone().normalize();
    v.rot.setFromUnitVectors(new Vector3(0, 1, 0), dir);
    v.angVel.set(0, 0, 0);
    v.hasLiftedOff = true;
    v.orbitDirty = true;
  }

  createVessel(def: VehicleDef, body: CelestialBody): Vessel {
    const v = new Vessel(def.name, def, def.assemblies, body);
    return v;
  }
}

/** Exchange the physical identity of two vessels (the player's Vessel object keeps the crew). */
function swapBodies(a: Vessel, b: Vessel): void {
  const swap = <K extends keyof Vessel>(k: K) => { const t = a[k]; (a as any)[k] = b[k]; (b as any)[k] = t; };
  swap('assemblies');
  swap('parentOf');
  const tmpV = new Vector3();
  const tmpQ = new Quaternion();
  tmpV.copy(a.pos); a.pos.copy(b.pos); b.pos.copy(tmpV);
  tmpV.copy(a.vel); a.vel.copy(b.vel); b.vel.copy(tmpV);
  tmpV.copy(a.angVel); a.angVel.copy(b.angVel); b.angVel.copy(tmpV);
  tmpV.copy(a.com); a.com.copy(b.com); b.com.copy(tmpV);
  tmpQ.copy(a.rot); a.rot.copy(b.rot); b.rot.copy(tmpQ);
  const m = a.mass; a.mass = b.mass; b.mass = m;
  const name = a.name; a.name = b.name; b.name = name;
  a.rebuild();
  b.rebuild();
  a.orbitDirty = b.orbitDirty = true;
}
