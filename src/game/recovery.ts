import { Quaternion, Vector3 } from 'three';
import { keplerPropagate } from '../physics/orbit';
import { machDragFactor } from '../physics/aero';
import type { PhysicsEnv, Vessel } from '../physics/vessel';
import type { PhysicsWorld } from '../physics/world';
import { AttitudeController } from './attitude';

/**
 * Reusable-booster flight software: flip → boostback → coast → entry burn → grid-fin glide →
 * landing burn (hoverslam) → touchdown. Acts through throttle, attitude and engine selection
 * only; the booster's actual trajectory comes from the physics model.
 */

export interface LandingZone {
  id: string;
  name: string;
  /** body-fixed unit direction of the zone centre */
  dir: Vector3;
  /** surface height of the pad deck above the reference radius (m) */
  height: number;
  radius: number;
  kind: 'pad' | 'droneship' | 'tower';
  /** for tower catches: extra height of the catch arms above the deck */
  catchHeight?: number;
  occupied?: boolean;
}

export type RecoveryPhase = 'separation' | 'flip' | 'boostback' | 'coast' | 'entry' | 'glide' | 'landing' | 'landed' | 'lost';

const _r = new Vector3();
const _v = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();
const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();

export class BoosterGuidance {
  readonly att = new AttitudeController();
  phase: RecoveryPhase = 'separation';
  timer = 0;
  zone: LandingZone;
  /** predicted (vacuum ballistic) impact point, body-fixed unit direction */
  impact = new Vector3();
  missDistance = 0;
  rangeBias = 1.0;
  private announced = new Set<string>();
  onEvent: ((id: string) => void) | null = null;
  private landingIgnited = false;
  private bestMiss = Infinity;
  private lastMiss = -1;
  private missRate = 0;
  private lastPredT = 0;
  private legsDone = false;
  private entryDone = false;

  constructor(readonly vessel: Vessel, readonly world: PhysicsWorld, zone: LandingZone) {
    this.zone = zone;
    this.att.maxRate = 0.35;
    this.att.gain = 1.4;
    this.att.damping = 3.5;
    vessel.controls.rcs = true;
  }

  private say(id: string): void {
    if (this.announced.has(id)) return;
    this.announced.add(id);
    this.onEvent?.(id);
  }

  /** Zone centre, inertial position at time t (relative to the body centre). */
  zonePosition(t: number, out: Vector3): Vector3 {
    const body = this.vessel.body;
    body.orientationAt(t, _q);
    const h = this.zone.height + (this.zone.catchHeight ?? 0);
    return out.copy(this.zone.dir).multiplyScalar(body.radius + h).applyQuaternion(_q);
  }

  private predCache: { t: number; dir: Vector3; tof: number } | null = null;

  /**
   * Impact prediction with gravity, drag and the rotating atmosphere (point mass, RK2, 0.5 s steps).
   * Returns the body-fixed impact direction and time of flight.
   */
  predictImpact(t: number): { dir: Vector3; tof: number } {
    const cacheDt = this.phase === 'boostback' ? 0.04 : 0.2;
    if (this.predCache && Math.abs(t - this.predCache.t) < cacheDt) return this.predCache;
    const res = this.integrateImpact(t, null);
    this.impact.copy(res.dir);
    this.predCache = { t, dir: this.impact, tof: res.tof };
    return this.predCache;
  }

  private burnCache: { t: number; dir: Vector3; tof: number } | null = null;

  /**
   * Impact prediction that flies the entry burn too: retrograde at the three-engine thrust
   * (g-limited) once below `startAlt` and descending, until the airspeed falls to the burn's
   * cut-off speed or the propellant reserve is reached. The entry burn moves the impact point a
   * long way uprange on a shallow, fast descent, so stationing the drone ship and steering the
   * burn both need the burn's own effect included.
   */
  predictWithEntryBurn(t: number, startAlt: number): { dir: Vector3; tof: number } {
    if (this.burnCache && Math.abs(t - this.burnCache.t) < 0.25) return this.burnCache;
    const v = this.vessel;
    const { three } = this.engineSets(v.engines);
    let thrust = 0;
    for (const e of three) thrust += e.mount.spec.thrustVac;
    const dry = v.mass - v.stagePropellant().current;
    const reserve = dry * (Math.exp(450 / 3000) - 1);
    const usable = Math.max(0, v.stagePropellant().current - reserve);
    // Δv the burn can deliver before hitting the landing reserve
    let isp = 3000;
    for (const e of three) isp = e.mount.spec.ispVac * 9.80665;
    const res = this.integrateImpact(t, { thrust, ve: isp, gMax: 5.5 * 9.80665, stopSpeed: 650, startAlt, propUsable: usable });
    this.burnCache = { t, dir: res.dir, tof: res.tof };
    return this.burnCache;
  }

  /** Point-mass impact integration (gravity, drag in the rotating atmosphere, optional retro burn). */
  private integrateImpact(t: number, burn: { thrust: number; ve: number; gMax: number; stopSpeed: number; startAlt: number; propUsable: number } | null): { dir: Vector3; tof: number } {
    const v = this.vessel;
    const body = v.body;
    const R = body.radius + this.zone.height + (this.zone.catchHeight ?? 0);
    const atm = body.atmosphere;
    const sample = { pressure: 0, density: 0, temperature: 0, speedOfSound: 300 };
    body.angularVelocity(_b);
    const omega = _b.clone();
    const area = v.aero.refArea;
    const cdBase = 1.1; // engines-first blunt base
    const r = v.pos.clone();
    const vel = v.vel.clone();
    let tof = 0;
    // the burn's acceleration grows as propellant is used (until the g limit throttles it)
    let mass = v.mass;
    let propLeft = burn ? burn.propUsable : 0;
    let burnAcc = 0;
    let burning = false;
    const acc = (rr: Vector3, vv: Vector3, out: Vector3) => {
      const rl = rr.length();
      out.copy(rr).multiplyScalar(-body.gm / (rl * rl * rl));
      const vAir = _c.copy(vv).sub(_a.crossVectors(omega, rr));
      const sp = vAir.length();
      if (atm) {
        atm.sample(rl - body.radius, sample);
        if (sample.density > 0) {
          const cd = cdBase * machDragFactor(sp / Math.max(1, sample.speedOfSound));
          out.addScaledVector(vAir, (-0.5 * sample.density * sp * cd * area) / mass);
        }
      }
      if (burning && sp > 1) out.addScaledVector(vAir, -burnAcc / sp);
      return out;
    };
    const a1 = new Vector3(), a2 = new Vector3(), rMid = new Vector3(), vMid = new Vector3();
    for (let i = 0; i < 2400 && r.length() > R; i++) {
      const alt = r.length() - body.radius;
      const h = alt > 80000 ? 2.0 : alt > 15000 ? 0.5 : 0.25;
      if (burn) {
        const sp = _c.copy(vel).sub(_a.crossVectors(omega, r)).length();
        burning = propLeft > 0 && alt < burn.startAlt && r.dot(vel) < 0 && sp > burn.stopSpeed;
        if (burning) {
          burnAcc = Math.min(burn.thrust / mass, burn.gMax);
          const used = ((burnAcc * mass) / burn.ve) * h;
          propLeft -= used;
          mass -= used;
        }
      }
      acc(r, vel, a1);
      rMid.copy(r).addScaledVector(vel, h * 0.5);
      vMid.copy(vel).addScaledVector(a1, h * 0.5);
      acc(rMid, vMid, a2);
      r.addScaledVector(vMid, h);
      vel.addScaledVector(a2, h);
      tof += h;
    }
    body.orientationAt(t + tof, _q);
    const dir = r.applyQuaternion(_q.invert()).normalize();
    return { dir, tof };
  }

  /**
   * Drone ships hold station where the stage will come down. Called at separation: move the
   * zone onto the booster's predicted (drag-corrected) impact point, pulled back along the
   * track by a few percent of the remaining range to leave room for the entry burn, which
   * shortens the trajectory. Returns the new zone direction (body-fixed).
   */
  stationAtImpact(t: number): Vector3 | null {
    if (this.zone.kind !== 'droneship') return null;
    // (a freshly separated stage has no telemetry yet: use its state vector)
    const sp = this.vessel.surfaceVelocity(new Vector3()).length();
    const p = this.predictWithEntryBurn(t, sp > 2600 ? 78000 : sp > 2000 ? 70000 : 62000).dir.clone();
    this.zone.dir.copy(p);
    this.predCache = null;
    this.burnCache = null;
    return p;
  }

  update(v: Vessel, dt: number, env: PhysicsEnv): void {
    if (v.destroyed) { if (this.phase !== 'lost') { this.phase = 'lost'; this.say('booster_lost'); } return; }
    if (v.landed || this.phase === 'landed') {
      if (v.landed && !this.announced.has('booster_landed')) this.say('booster_landed');
      this.phase = 'landed';
      const c = v.controls;
      c.throttle = 0; c.pitch = 0; c.yaw = 0; c.roll = 0; c.rcs = false; c.engineMask = null;
      for (const e of v.engines) e.armed = false;
      return;
    }
    this.timer += dt;
    const t = env.t;
    const tm = v.telemetry;
    const body = v.body;
    v.enuBasis(_e, _n, _u);
    const zonePos = this.zonePosition(t, new Vector3());
    const toZone = zonePos.clone().sub(v.pos);
    const toZoneH = toZone.clone().addScaledVector(_u, -toZone.dot(_u));
    const distH = toZoneH.length();
    const alt = v.pos.length() - body.radius - (this.zone.height + (this.zone.catchHeight ?? 0));
    const ctl = v.controls;
    const engines = v.engines;
    const { three, landing: landEngines } = this.engineSets(engines);
    const boost3 = three;

    // predicted impact vs zone
    const pred = this.predictImpact(t);
    const zDir = this.zone.dir;
    const miss = Math.acos(Math.max(-1, Math.min(1, pred.dir.dot(zDir)))) * body.radius;
    this.missDistance = miss;

    const vSurf = v.surfaceVelocity(new Vector3());
    const retro = vSurf.clone().normalize().negate();

    switch (this.phase) {
      case 'separation': {
        ctl.throttle = 0;
        this.att.killRotation(v);
        // drone-ship stages coast straight to the ship stationed under their trajectory
        if (this.timer > 3) { this.phase = this.zone.kind === 'droneship' ? 'coast' : 'flip'; this.timer = 0; }
        break;
      }
      case 'flip': {
        // point engines back toward the zone: thrust direction = horizontal toward zone + loft
        const dir = this.boostbackDirection(pred.dir, new Vector3());
        this.att.update(v, { dir }, dt);
        ctl.throttle = 0;
        // cold-gas thrusters alone turn a 90-tonne stage slowly: once roughly aligned, light
        // the engines and let the gimbals finish the flip (the burn throttles low until aligned)
        if ((this.att.error < 0.3 && v.angVel.length() < 0.08) || (this.att.error < 1.2 && this.timer > 6) || this.timer > 45) {
          this.phase = 'boostback';
          this.timer = 0;
          this.arm(boost3);
          this.say('boostback_start');
        }
        break;
      }
      case 'boostback': {
        const dir = this.boostbackDirection(pred.dir, new Vector3());
        this.att.update(v, { dir }, dt);
        // fine trim at the end of the burn: drop to the single centre engine at minimum throttle
        const fine = miss < 12000;
        const set = fine ? landEngines : boost3;
        ctl.engineMask = new Set(set);
        ctl.throttle = fine ? 0.4 : (this.att.error < 0.25 ? 1 : 0.4) * this.gLimitThrottle(v, boost3, 5);
        if (fine) for (const e of set) e.armed = true;
        // extrapolate the miss between predictions to time the cutoff precisely
        const dMiss = this.lastMiss >= 0 ? (miss - this.lastMiss) : 0;
        if (dMiss !== 0 && this.predCache && this.predCache.t !== this.lastPredT) { this.missRate = dMiss / Math.max(1e-3, this.predCache.t - this.lastPredT); this.lastPredT = this.predCache.t; }
        this.lastMiss = miss;
        const projected = miss + this.missRate * (t - this.lastPredT);
        if (miss < this.bestMiss) this.bestMiss = miss;
        const along = this.alongTrack(pred.dir);
        const done = (Math.min(miss, projected) < 60 && this.timer > 3) || (this.bestMiss < 3000 && miss > this.bestMiss + 40) || (along > 300 && this.timer > 3);
        if (done) {
          ctl.throttle = 0;
          this.phase = 'coast';
          this.timer = 0;
          this.say('boostback_end');
        }
        if (!v.stagePropellant().current) { this.phase = 'coast'; }
        break;
      }
      case 'coast': {
        ctl.throttle = 0;
        ctl.engineMask = null;
        // engines-first: the nose (+Y) points along retrograde so the engine end leads
        this.att.update(v, { dir: retro }, dt);
        if (this.timer > 5) for (const a of v.assemblies) if (a.def.features?.gridFins && a.gridFinsTarget === 0) { a.gridFinsTarget = 1; v.events.push({ type: 'gridfins' }); this.say('gridfins'); }
        // entry burn: above ~60 km heading down fast (higher still for very fast stages, so
        // the burn finishes before the air gets thick)
        const entryAlt = tm.speedSurface > 2600 ? 78000 : tm.speedSurface > 2000 ? 70000 : 62000;
        if (!this.entryDone && tm.verticalSpeed < 0 && alt < entryAlt && tm.speedSurface > 1300) {
          this.phase = 'entry'; this.timer = 0; this.arm(three); this.say('entry_burn_start');
        }
        if (alt < 45000 && tm.verticalSpeed < 0 && (this.entryDone || tm.speedSurface <= 1300)) { this.phase = 'glide'; this.timer = 0; }
        break;
      }
      case 'entry': {
        // retrograde, tilted so the burn also steers the predicted impact onto the zone
        // Steering error. On a steep return to the launch site the ballistic impact is a good
        // guide; on a fast, shallow descent to the ship the burn itself moves the impact point a
        // long way, so steer on where the stage will come down once this burn is finished.
        const ship = this.zone.kind === 'droneship';
        let errE: Vector3;
        if (ship) {
          const pb = this.predictWithEntryBurn(t, Infinity);
          body.orientationAt(t, _q);
          errE = zonePos.clone().sub(_d.copy(pb.dir).multiplyScalar(body.radius + this.zone.height).applyQuaternion(_q));
        } else errE = zonePos.clone().sub(this.predictedPointInertial(t, pred.tof));
        errE.addScaledVector(_u, -errE.dot(_u));
        const em = errE.length();
        const burnDir = retro.clone();
        if (em > 15) burnDir.addScaledVector(errE.normalize(), ship ? Math.min(0.3, em / 3000) : Math.min(0.6, em / 1200)).normalize();
        this.att.update(v, { dir: burnDir }, dt);
        ctl.engineMask = new Set(three);
        ctl.throttle = (this.att.error < 0.2 ? 1 : 0.4) * this.gLimitThrottle(v, three, 5.5);
        // burn down toward ~650 m/s but keep enough propellant for the landing burn
        const dry = v.mass - v.stagePropellant().current;
        const landingReserve = dry * (Math.exp(450 / 3000) - 1);
        if (tm.speedSurface < 650 || v.stagePropellant().current < landingReserve || this.timer > 75) {
          ctl.throttle = 0; this.entryDone = true; this.phase = 'glide'; this.timer = 0; this.say('entry_burn_end');
        }
        break;
      }
      case 'glide': {
        ctl.throttle = 0;
        ctl.engineMask = null;
        // engines-first with a small angle of attack that moves the impact point toward the zone:
        // tilt the leading (engine) end toward the target — like a wing's leading edge — so the
        // body's normal force pushes the trajectory that way.
        const lead = vSurf.clone().normalize();
        const errH = zonePos.clone().sub(this.predictedPointInertial(t, pred.tof));
        errH.addScaledVector(_u, -errH.dot(_u));
        const errMag = errH.length();
        // steering authority up to ~93% of the structural q·α limit
        const maxA = Math.max(0.5, Math.min(12, 205000 / Math.max(1, tm.dynamicPressure))) * Math.PI / 180;
        if (errMag > 1) {
          const k = Math.min(1, errMag / 90);
          lead.addScaledVector(errH.normalize(), Math.tan(maxA) * k).normalize();
        }
        // nose = -lead (engines lead)
        this.att.update(v, { dir: lead.clone().negate() }, dt);
        // landing burn trigger (hoverslam)
        if (this.shouldIgniteLanding(v, alt, landEngines)) {
          this.phase = 'landing'; this.timer = 0; this.arm(landEngines); this.landingIgnited = true; this.say('landing_burn');
        }
        break;
      }
      case 'landing': {
        ctl.engineMask = new Set(landEngines);
        const vz = tm.verticalSpeed;
        const g = body.gm / v.pos.lengthSq();
        const h = Math.max(0.5, alt - this.footClearance(v) - 0.6);
        let thrustMax = 0;
        for (const e of landEngines) thrustMax += e.mount.spec.thrustSL + (e.mount.spec.thrustVac - e.mount.spec.thrustSL) * (1 - Math.min(1, tm.pressure / 101325));
        // required vertical deceleration to stop at the deck (drag still helps a little)
        const aReq = vz < 0 ? Math.max(0, (vz * vz) / (2 * h) + g - 0.5 * this.dragAccel(v)) : g * 0.6;
        // horizontal: null velocity & position error
        const vh = vSurf.clone().addScaledVector(_u, -vSurf.dot(_u));
        // horizontal: terminal guidance that arrives over the pad with zero drift exactly at
        // touchdown (time-to-go from the vertical channel); the last seconds only kill drift
        const posErr = toZoneH.clone();
        const tgo = vz < -1 ? Math.max(1.5, (2 * h) / -vz) : 3;
        const latCmd = tgo > 4 && h > 40
          ? posErr.multiplyScalar(6 / (tgo * tgo)).addScaledVector(vh, -4 / tgo)
          : vh.clone().multiplyScalar(-1.2);
        // divert authority limited by thrust and, while q is high, by the structural AoA limit
        const qNow = Math.max(1, tm.dynamicPressure);
        // (firing into the flow relieves bending loads, so the burn may tilt further than the glide)
        // close to the ground the stage must be upright for the legs to take the load evenly
        const tiltCap = h < 80 ? 1.5 + (h / 80) * 8 : 20;
        const maxTilt = Math.min(tiltCap, Math.max(4, Math.min(20, 420000 / qNow))) * Math.PI / 180;
        const latMax = Math.min(0.5 * aReq, Math.tan(maxTilt) * aReq);
        if (latCmd.length() > latMax) latCmd.setLength(latMax);
        const thrustDir = _u.clone().multiplyScalar(aReq).add(latCmd);
        const aCmd = thrustDir.length();
        thrustDir.normalize();
        this.att.update(v, { dir: thrustDir }, dt);
        let thr = (aCmd * v.mass) / Math.max(1, thrustMax);
        ctl.throttle = Math.max(0.01, Math.min(1, thr));
        // touchdown: shut the engine down and let the legs take the load
        if (v.contactForce > 0 || h < 0.25 || (vz > -0.6 && h < 2.5)) {
          ctl.throttle = 0;
          for (const e of v.engines) e.armed = false;
          this.phase = 'landed';
        }
        if (!this.legsDone && h < 900) {
          for (const a of v.assemblies) if (a.def.features?.landingLegs) a.legsTarget = 1;
          this.legsDone = true;
          v.events.push({ type: 'legs' });
          this.say('legs_deploy');
        }
        if (this.zone.kind === 'tower' && h < 6 && Math.abs(vz) < 3 && distH < 25) this.catchAtTower(v, t);
        break;
      }
    }
    void distH;
  }

  private sets: { three: Vessel['engines']; landing: Vessel['engines'] } | null = null;

  /** Engine subsets: a three-engine set (centre + two opposite) and the landing set. */
  private engineSets(engines: Vessel['engines']): { three: Vessel['engines']; landing: Vessel['engines'] } {
    if (this.sets) return this.sets;
    const dist = (e: Vessel['engines'][number]) => Math.hypot(e.mount.pos[0], e.mount.pos[2]);
    const sorted = [...engines].sort((a, b) => dist(a) - dist(b));
    let three: Vessel['engines'];
    const inner = engines.filter((e) => e.mount.group === 'inner');
    if (inner.length >= 3) three = inner.slice(0, 3);
    else if (sorted.length >= 3 && dist(sorted[0]) < 0.3) {
      const c = sorted[0];
      const ring = sorted.slice(1).filter((e) => Math.abs(dist(e) - dist(sorted[1])) < 0.2);
      const a = ring[0];
      let b = ring[1] ?? sorted[2];
      let best = -Infinity;
      for (const r of ring) {
        const d = Math.hypot(r.mount.pos[0] - a.mount.pos[0], r.mount.pos[2] - a.mount.pos[2]);
        if (d > best) { best = d; b = r; }
      }
      three = [c, a, b];
    } else three = sorted.slice(0, Math.min(3, sorted.length));
    const landing = inner.length >= 3 ? inner.slice(0, 3) : dist(sorted[0]) < 0.3 ? [sorted[0]] : sorted.slice(0, Math.min(2, sorted.length));
    this.sets = { three, landing };
    return this.sets;
  }

  /** throttle factor that keeps the burn under `gMax` g */
  private gLimitThrottle(v: Vessel, engines: { mount: { spec: { thrustVac: number } } }[], gMax: number): number {
    let t = 0;
    for (const e of engines) t += e.mount.spec.thrustVac;
    if (t <= 0) return 1;
    return Math.min(1, (gMax * 9.80665 * v.mass) / t);
  }

  private footClearance(v: Vessel): number {
    // distance from CoM to the lowest point (legs or engine bells)
    return v.com.y - v.lowestY();
  }

  private arm(list: { armed: boolean }[]): void { for (const e of list) e.armed = true; }

  /** signed along-track distance of the impact point past (+) / short of (-) the zone */
  private alongTrack(impactDir: Vector3): number {
    const body = this.vessel.body;
    const z = this.zone.dir;
    // track direction: from the current sub-vessel point toward the zone
    const here = this.vessel.fixedDirection(this.world.t, new Vector3());
    const track = z.clone().sub(here);
    track.addScaledVector(z, -track.dot(z));
    if (track.lengthSq() < 1e-12) return 0;
    track.normalize();
    const d = impactDir.clone().sub(z);
    return d.dot(track) * body.radius;
  }

  private boostbackDirection(impactDir: Vector3, out: Vector3): Vector3 {
    // horizontal direction (inertial) from the predicted impact toward the zone, lofted 12°
    const body = this.vessel.body;
    body.orientationAt(this.world.t, _q);
    const z = this.zone.dir.clone().applyQuaternion(_q);
    const p = impactDir.clone().applyQuaternion(_q);
    const d = z.sub(p);
    this.vessel.enuBasis(_e, _n, _u);
    d.addScaledVector(_u, -d.dot(_u));
    if (d.lengthSq() < 1e-12) d.copy(this.vessel.vel).negate();
    d.normalize();
    return out.copy(d).multiplyScalar(Math.cos(0.21)).addScaledVector(_u, Math.sin(0.21)).normalize();
  }

  private predictedPointInertial(t: number, tof: number): Vector3 {
    const body = this.vessel.body;
    body.orientationAt(t, _q);
    return this.impact.clone().multiplyScalar(body.radius + this.zone.height).applyQuaternion(_q);
  }

  /** current aerodynamic deceleration estimate (engines-first, Cd ≈ 1) */
  private dragAccel(v: Vessel): number {
    return (v.telemetry.dynamicPressure * v.aero.refArea * 1.0) / v.mass;
  }

  private shouldIgniteLanding(v: Vessel, alt: number, engines: { mount: { spec: { thrustSL: number; thrustVac: number } } }[]): boolean {
    const tm = v.telemetry;
    if (tm.verticalSpeed >= 0) return false;
    const h = alt - this.footClearance(v);
    if (h > 9000) return false; // still decelerating aerodynamically toward terminal velocity
    const g = v.body.gm / v.pos.lengthSq();
    let thrust = 0;
    for (const e of engines) thrust += e.mount.spec.thrustSL;
    const aMax = thrust / v.mass;
    const vz = -tm.verticalSpeed;
    // drag keeps helping during the burn; count roughly half of today's value
    const aReq = (vz * vz) / (2 * Math.max(1, h)) + g - 0.5 * this.dragAccel(v);
    return aReq > 0.72 * aMax || h < 150;
  }

  private catchAtTower(v: Vessel, t: number): void {
    v.controls.throttle = 0;
    v.settleLanded(t, false);
    this.say('booster_landed');
  }
}
