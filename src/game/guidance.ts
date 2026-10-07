import { Vector3 } from 'three';
import type { PhysicsWorld } from '../physics/world';
import type { EngineRuntime, Vessel } from '../physics/vessel';
import { AttitudeController } from './attitude';
import { G0 } from '../physics/constants';

/**
 * Flight software: ascent guidance ("orbit assist"), booster recovery, landing guidance.
 * Everything here acts only through the same controls a player has (throttle, attitude,
 * staging) — no forces are faked.
 */

const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();
const _d = new Vector3();
const _v = new Vector3();
const _w = new Vector3();
const _h = new Vector3();

export function launchAzimuth(latitude: number, inclination: number, vOrbit = 7800, vEq = 465.1): number {
  // inertial azimuth, then rotate for Earth's surface velocity
  const ci = Math.cos(inclination), cl = Math.cos(latitude);
  let sinB = cl > 1e-6 ? ci / cl : 1;
  sinB = Math.max(-1, Math.min(1, sinB));
  const b = Math.asin(sinB);
  const vx = vOrbit * Math.sin(b) - vEq * cl;
  const vy = vOrbit * Math.cos(b);
  return Math.atan2(vx, vy);
}

/** Point the AoA-limited command toward `desired`, staying within maxAoA of the airflow. */
function limitAoA(v: Vessel, desired: Vector3, maxAoA: number, out: Vector3): Vector3 {
  const air = _w.copy(v.telemetry.airVelocity);
  const sp = air.length();
  if (sp < 30) return out.copy(desired);
  air.multiplyScalar(1 / sp);
  const ang = Math.acos(Math.max(-1, Math.min(1, air.dot(desired))));
  if (ang <= maxAoA) return out.copy(desired);
  // slerp from air toward desired by maxAoA
  const axis = _h.crossVectors(air, desired);
  if (axis.lengthSq() < 1e-12) return out.copy(air);
  axis.normalize();
  return out.copy(air).applyAxisAngle(axis, maxAoA);
}

export interface AscentStatus {
  phase: string;
  targetPitch: number;
  message: string;
}

export class AscentGuidance {
  readonly world: PhysicsWorld;
  readonly vessel: Vessel;
  readonly att = new AttitudeController();
  targetAltitude: number;
  azimuth: number; // radians from north
  phase: 'vertical' | 'kick' | 'gravity' | 'closed' | 'coast' | 'circularize' | 'done' = 'vertical';
  autoStage = true;
  status: AscentStatus = { phase: 'vertical', targetPitch: 90, message: '' };
  private turnEnd = 110000;
  private turnShape = 0.53;
  private timer = 0;
  private stageCooldown = 0;
  private padAltitude = 0;
  private mecoHold = 0;
  enabled = true;
  /** fraction of propellant kept in a recoverable booster for its return */
  recoveryReserve = 0.155;
  /** target orbit plane (inertial normal, body-centred); steered into during the closed-loop phase */
  planeNormal: Vector3 | null = null;

  constructor(world: PhysicsWorld, vessel: Vessel, targetAltitude: number, azimuth: number) {
    this.world = world;
    this.vessel = vessel;
    this.targetAltitude = targetAltitude;
    this.azimuth = azimuth;
    this.padAltitude = vessel.telemetry.altitude;
  }

  private heading(out: Vector3, pitch: number): Vector3 {
    // direction with given pitch above horizon along azimuth (surface frame)
    const v = this.vessel;
    v.enuBasis(_e, _n, _u);
    const az = this.azimuth;
    _d.copy(_n).multiplyScalar(Math.cos(az)).addScaledVector(_e, Math.sin(az));
    return out.copy(_d).multiplyScalar(Math.cos(pitch)).addScaledVector(_u, Math.sin(pitch)).normalize();
  }

  update(dt: number): void {
    const v = this.vessel;
    if (!this.enabled || v.destroyed) return;
    const tm = v.telemetry;
    this.timer += dt;
    this.stageCooldown -= dt;
    const alt = tm.altitude;
    const target = new Vector3();
    let throttle = 1;
    const body = v.body;
    const r = v.pos.length();
    const orbit = v.updateOrbit(this.world.t);
    const atmTop = body.atmosphereTop;
    const ap = orbit.apoapsis - body.radius;
    const pe = orbit.periapsis - body.radius;

    // upper-stage orientation helpers
    v.enuBasis(_e, _n, _u);
    const vel = v.vel;
    const vz = vel.dot(_u);
    const vh = Math.sqrt(Math.max(0, vel.lengthSq() - vz * vz));
    const gLocal = body.gm / (r * r);
    const gEff = gLocal - (vh * vh) / r;
    const acc = tm.thrust > 0 ? tm.thrust / v.mass : this.estimatedAccel();

    switch (this.phase) {
      case 'vertical': {
        this.heading(target, Math.PI / 2);
        if (alt - this.padAltitude > 120 && tm.verticalSpeed > 35) {
          this.phase = 'kick';
          this.timer = 0;
          // high-TWR vehicles finish the turn a little lower, sluggish ones a little higher
          const twr = tm.twr;
          this.turnEnd = Math.max(85000, Math.min(135000, 110000 - (twr - 1.4) * 30000));
        }
        break;
      }
      case 'kick':
      case 'gravity': {
        // Altitude-scheduled pitch programme (≈65° at 10 km, 45° at 30 km, 34° at 45 km),
        // clamped below to the AoA limit so dense-air flight stays close to prograde.
        const h = Math.max(0, alt - this.padAltitude);
        const f = Math.min(1, h / this.turnEnd);
        let pitch = (Math.PI / 2) * (1 - Math.pow(f, this.turnShape));
        // ease the first seconds of the programme in
        const ease = Math.min(1, this.timer / 6);
        pitch = Math.PI / 2 - (Math.PI / 2 - pitch) * ease;
        // unthrottleable vehicles climb steeper when dynamic pressure runs high
        if (tm.dynamicPressure > 40000) pitch += Math.min(8, (tm.dynamicPressure - 40000) / 3000) * Math.PI / 180;
        this.heading(target, Math.min(pitch, Math.PI / 2 - 0.5 * Math.PI / 180));
        if (this.phase === 'kick' && this.timer > 6) this.phase = 'gravity';
        if (alt > 52000 || (atmTop > 0 && tm.dynamicPressure < 1200 && alt > 38000)) this.phase = 'closed';
        if (ap > this.targetAltitude - 2000 && pe > atmTop - 30000) this.phase = 'closed';
        break;
      }
      case 'closed': {
        // Linear terminal guidance: choose the vertical acceleration (linear in time) that arrives at
        // the target altitude with zero vertical speed exactly when horizontal speed reaches orbital.
        // insert at the target altitude — or, if an unthrottleable stage has already overshot,
        // at the current apoapsis (raising periapsis there is far cheaper than diving back down)
        const solidOnly = v.engines.some((e) => e.running) && v.engines.every((e) => !e.running || e.isSolid);
        const hT = solidOnly && ap > this.targetAltitude + 40000 && pe < this.targetAltitude ? Math.max(this.targetAltitude, ap - 5000) : this.targetAltitude;
        const vT = Math.sqrt(body.gm / (body.radius + hT));
        const dvh = vT - vh;
        // time-to-go from the rocket equation across the remaining stages
        let T = v.burnTimeFor(Math.max(0, dvh));
        if (!isFinite(T)) T = dvh / Math.max(0.2, acc);
        T = Math.max(6, T);
        let a0 = (6 * (hT - alt)) / (T * T) - (4 * vz) / T;
        // never let an upper stage sag back into the atmosphere
        const floor = Math.max(atmTop, 110000);
        if (alt < floor + 15000 && vz < 0) a0 = Math.max(a0, (-vz * vz) / Math.max(2000, 2 * (alt - floor + 5000)) + 1.0);
        const sinP = Math.max(-0.45, Math.min(0.97, (a0 + gEff) / Math.max(0.3, acc)));
        _h.copy(vel).addScaledVector(_u, -vz);
        if (_h.lengthSq() < 1) this.heading(_h, 0); else _h.normalize();
        const cosP = Math.sqrt(1 - sinP * sinP);
        if (this.planeNormal) {
          // yaw steering: fly along the target plane and null the out-of-plane velocity by burnout
          const n = this.planeNormal;
          const along = _w.crossVectors(n, _u);
          if (along.dot(_h) < 0) along.negate();
          along.normalize();
          const w = vel.dot(n);
          const s = Math.max(-0.3, Math.min(0.3, -w / (Math.max(10, T) * Math.max(0.3, acc))));
          _h.copy(along).multiplyScalar(Math.sqrt(1 - s * s)).addScaledVector(n, s);
        }
        target.copy(_h).multiplyScalar(cosP).addScaledVector(_u, sinP).normalize();
        const done = pe > hT - 12000 || (pe > Math.max(atmTop + 10000, 150000) && ap > hT + 40000) || (dvh <= 0 && pe > atmTop);
        if (done) { throttle = 0; this.phase = pe > atmTop + 10000 ? 'done' : 'coast'; }
        break;
      }
      case 'coast': {
        throttle = 0;
        if (pe > atmTop + 5000 && ap > this.targetAltitude + 30000) { this.phase = 'done'; break; }
        // prograde hold, circularise at apoapsis
        target.copy(vel).normalize();
        const tAp = orbit.timeToApoapsis();
        const vAp = Math.sqrt(body.gm * (2 / orbit.apoapsis - 1 / orbit.a));
        const dv = Math.sqrt(body.gm / orbit.apoapsis) - vAp;
        const burn = dv / Math.max(0.05, this.estimatedAccel());
        if (tAp < burn * 0.55 + 2 || tAp > orbit.period * 0.75) this.phase = 'circularize';
        break;
      }
      case 'circularize': {
        _h.copy(vel).addScaledVector(_u, -vz).normalize();
        const sinP = Math.max(-0.3, Math.min(0.3, (-vz) / 120));
        target.copy(_h).multiplyScalar(Math.sqrt(1 - sinP * sinP)).addScaledVector(_u, sinP).normalize();
        const pointErr = this.att.error;
        throttle = pointErr < 0.12 ? 1 : 0;
        if (pe > Math.min(this.targetAltitude, orbit.apoapsis - body.radius) - 8000 || pe > this.targetAltitude - 5000) {
          throttle = 0;
          this.phase = 'done';
        }
        break;
      }
      case 'done': {
        throttle = 0;
        target.copy(vel).normalize();
        this.status.message = 'Orbit achieved';
        break;
      }
    }

    // structural protection: limit angle of attack while dynamic pressure is significant
    const q = tm.dynamicPressure;
    let cmd = target;
    if (q > 500 && this.phase !== 'vertical') {
      const maxA = Math.max(1.5, Math.min(60, 60000 / q)) * Math.PI / 180;
      cmd = limitAoA(v, target, maxA, _d.clone());
    }
    // max-Q throttle bucket for liquid stages (keeps q under ~35 kPa)
    if (q > 30000 && tm.mach > 0.8 && tm.mach < 2.0) throttle = Math.min(throttle, Math.max(0.65, 1 - (q - 30000) / 20000));
    // acceleration limit (crew & structure): throttle liquid engines back near 4.5 g
    if (throttle > 0 && v.hasLiftedOff) {
      let liquidMax = 0, solid = 0;
      for (const e of v.engines) {
        if (!e.armed || e.failed) continue;
        if (e.isSolid) solid += e.thrust; else liquidMax += e.mount.spec.thrustVac * e.throttleScale;
      }
      if (liquidMax > 0) {
        const allowed = 4.5 * G0 * v.mass - solid;
        throttle = Math.min(throttle, Math.max(0.05, allowed / liquidMax));
      }
    }

    // recovery reserve: cut the booster early so it can fly home
    const next = v.nextStage;
    if (next && this.autoStage) {
      const sepTargets = next.filter((e) => e.action === 'separate').flatMap((e) => e.targets);
      const recover = sepTargets.map((id) => v.getAssembly(id)).filter((a) => a && a.def.recovery && a.def.recovery !== 'none');
      for (const a of recover) {
        if (!a) continue;
        const reserve = a.def.recovery === 'droneship' ? this.recoveryReserve * 0.62 : this.recoveryReserve;
        if (a === v.rootAssembly && a.engines.some((e) => e.running) && a.fuelFraction < reserve) {
          throttle = 0; // MECO
          this.mecoHold += dt;
        }
      }
    }

    // keep the up vector so the vehicle rolls "heads down" toward the azimuth
    const upTarget = this.phase === 'vertical' ? undefined : _u.clone();
    this.att.update(v, { dir: cmd, up: upTarget }, dt);
    v.controls.throttle = throttle;
    this.status.phase = this.phase;
    this.status.targetPitch = Math.asin(Math.max(-1, Math.min(1, cmd.dot(_u)))) * 180 / Math.PI;

    if (this.autoStage) this.autoStaging(dt);
  }

  /** mass flow and exhaust velocity of the currently armed engines */
  private stagePropulsion(): { mdot: number; ve: number } {
    let mdot = 0, f = 0;
    for (const e of this.vessel.engines) if (e.armed && !e.failed) {
      const m = e.mount.spec.thrustVac / (e.mount.spec.ispVac * G0);
      mdot += m * (e.isSolid ? 1 : e.throttleScale);
      f += e.mount.spec.thrustVac * (e.isSolid ? 1 : e.throttleScale);
    }
    return { mdot, ve: mdot > 0 ? f / mdot : 3000 };
  }

  private estimatedAccel(): number {
    const v = this.vessel;
    let f = 0;
    for (const e of v.engines) if (e.armed && !e.failed) f += e.mount.spec.thrustVac;
    return f / v.mass;
  }

  /** Stage when the current stage is spent, boosters burn out, or the fairing can go. */
  private autoStaging(dt: number): void {
    const v = this.vessel;
    if (this.stageCooldown > 0 || v.clamped) return;
    const next = v.nextStage;
    if (!next) return;
    const tm = v.telemetry;
    const ids = (a: string) => next.filter((e) => e.action === a).flatMap((e) => e.targets);
    const sep = [...ids('separate'), ...ids('jettison')];
    const ign = ids('ignite');
    const doStage = () => { this.world.stage(v); this.stageCooldown = 1.5; this.mecoHold = 0; };

    // fairing / tower jettison
    const jet = next.every((e) => e.action === 'jettison');
    if (jet && sep.length) {
      const isLes = sep.some((id) => v.getAssembly(id)?.def.sections.some((s) => s.kind === 'les'));
      if ((isLes && tm.altitude > 85000) || (!isLes && tm.altitude > 105000 && tm.dynamicPressure < 30)) doStage();
      return;
    }
    // side boosters: separate when all their engines are out of propellant
    const sepAsm = sep.map((id) => v.getAssembly(id)).filter(Boolean) as NonNullable<ReturnType<Vessel['getAssembly']>>[];
    if (!sepAsm.length) {
      if (ign.length && v.activeEngines.every((e) => !e.running)) doStage();
      return;
    }
    const allSpent = sepAsm.every((a) => a.engines.length === 0 ? false : a.engines.every((e) => (e.isSolid ? e.srbBurned >= 0.999 : a.propellant <= 1) || e.failed));
    const rootSep = sepAsm.includes(v.rootAssembly);
    const recoverMeco = rootSep && sepAsm.some((a) => a.def.recovery && a.def.recovery !== 'none') && this.mecoHold > 2.0;
    if (allSpent || recoverMeco) {
      // payload deployment and other non-propulsive events wait for orbit
      if (next.some((e) => e.action === 'separate' && e.targets.some((id) => v.getAssembly(id)?.def.separation?.kind === 'payload'))) return;
      doStage();
      return;
    }
    // stages with no engines (e.g. spacecraft separation) wait
    void dt;
  }
}

/** Fires air-started boosters and throttles heavy centre cores — always active, like real avionics. */
export class FlightSoftware {
  private liftoffTime = -1;
  private airLit = new Set<string>();
  constructor(readonly vessel: Vessel) {}

  update(t: number, liftedOff: boolean): void {
    const v = this.vessel;
    if (liftedOff && this.liftoffTime < 0) this.liftoffTime = t;
    if (this.liftoffTime < 0) return;
    const met = t - this.liftoffTime;
    for (const a of v.assemblies) {
      if (a.def.airStart !== undefined && met >= a.def.airStart && !this.airLit.has(a.id)) {
        this.airLit.add(a.id);
        for (const e of a.engines) e.armed = true;
      }
    }
    // centre-core throttle schedule while side boosters are attached
    for (const a of v.assemblies) {
      const ct = a.def.coreThrottle;
      if (!ct) continue;
      const sidesAttached = v.assemblies.some((x) => x !== a && x.def.ignitesAtLaunch && x.engines.some((e) => e.mount.spec.propellant !== 'solid'));
      const scale = met > ct.from && sidesAttached ? ct.level : 1;
      for (const e of a.engines) e.throttleScale = scale;
    }
  }
}

export const ACCEL_G0 = G0;
