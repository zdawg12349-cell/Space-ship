import { Quaternion, Vector3 } from 'three';
import { machDragFactor } from '../physics/aero';
import type { CelestialBody } from '../physics/bodies';
import type { Vessel } from '../physics/vessel';

/**
 * Guided entry for lifting capsules (bank-angle steering, after Apollo and Soyuz).
 *
 * The capsule flies heat shield first, trimmed at an angle that gives it a lift-to-drag ratio of
 * about 0.3 along its +X axis. Rolling the capsule about the velocity vector points that lift
 * up (longer range, gentler deceleration), down (shorter) or to the side. Once a second a
 * predictor flies the rest of the entry with a given vertical share of the lift and the
 * corrector bisects for the bank angle whose touchdown lands on the target's down-range
 * position. The sideways share of the lift is spent on cross-range: when the predicted
 * cross-range error leaves a deadband that narrows as the target approaches, the bank flips to
 * the other side (a bank reversal).
 */

/** lift-to-drag ratio of the trimmed capsule (the vessel's capsule lift model) */
export const CAPSULE_LD = 0.3;
const CD_SHIELD = 1.32;

const _q = new Quaternion();
const _a = new Vector3();
const _air = new Vector3();
const _up = new Vector3();

export interface EntryPrediction {
  /** along-track miss (m): + long, - short */
  down: number;
  /** cross-track miss (m): + to the left of the track */
  cross: number;
  /** remaining ground range to the target (m) */
  range: number;
  /** body-fixed landing direction */
  dir: Vector3;
}

/**
 * Fly a point-mass capsule from (r, vel) at time t down to `stopAlt` with a fixed vertical lift
 * share `c` (cos of the bank angle). Returns the body-fixed landing direction and the time.
 */
export function predictEntry(body: CelestialBody, r0: Vector3, v0: Vector3, t0: number, mass: number, area: number, c: number, stopAlt = 10_000): { dir: Vector3; t: number } {
  const atm = body.atmosphere;
  const mu = body.gm;
  const r = r0.clone(), vel = v0.clone();
  const omega = body.angularVelocity(new Vector3());
  const s = { pressure: 0, density: 0, temperature: 0, speedOfSound: 300 };
  let t = t0;
  const acc = (rr: Vector3, vv: Vector3, out: Vector3) => {
    const rl = rr.length();
    out.copy(rr).multiplyScalar(-mu / (rl * rl * rl));
    if (!atm) return out;
    atm.sample(rl - body.radius, s);
    if (s.density <= 0) return out;
    _air.copy(vv).sub(_a.crossVectors(omega, rr));
    const sp = _air.length();
    if (sp < 1) return out;
    const d = (0.5 * s.density * sp * sp * area * CD_SHIELD * machDragFactor(sp / Math.max(1, s.speedOfSound))) / mass;
    out.addScaledVector(_air, -d / sp);
    // lift in the vertical plane: the local vertical, made perpendicular to the airflow
    _up.copy(rr).multiplyScalar(1 / rl);
    _up.addScaledVector(_air, -_up.dot(_air) / (sp * sp));
    const ul = _up.length();
    if (ul > 1e-6) out.addScaledVector(_up, (CAPSULE_LD * d * c) / ul);
    return out;
  };
  const a1 = new Vector3(), a2 = new Vector3(), rm = new Vector3(), vm = new Vector3();
  for (let i = 0; i < 8000; i++) {
    const alt = r.length() - body.radius;
    if (alt < stopAlt) break;
    const h = alt > 90_000 ? 4 : alt > 40_000 ? 1 : 0.5;
    acc(r, vel, a1);
    rm.copy(r).addScaledVector(vel, h * 0.5);
    vm.copy(vel).addScaledVector(a1, h * 0.5);
    acc(rm, vm, a2);
    r.addScaledVector(vm, h);
    vel.addScaledVector(a2, h);
    t += h;
  }
  body.orientationAt(t, _q);
  return { dir: r.normalize().applyQuaternion(_q.invert()), t };
}

/**
 * Down-range / cross-range of a landing point relative to a target, measured in the ground-track
 * plane of a vehicle at `from` moving along `track` (body-fixed unit vectors; `track` is the
 * horizontal direction of motion). Free of the singularity a from→target plane has overhead.
 */
export function rangeErrors(body: CelestialBody, from: Vector3, track: Vector3, landing: Vector3, target: Vector3): { down: number; cross: number; range: number } {
  const n = new Vector3().crossVectors(from, track);
  if (n.lengthSq() < 1e-14) return { down: 0, cross: 0, range: 0 };
  n.normalize();
  const along = (x: Vector3) => Math.atan2(new Vector3().crossVectors(from, x).dot(n), from.dot(x));
  const off = (x: Vector3) => Math.asin(Math.max(-1, Math.min(1, x.dot(n))));
  const sT = along(target);
  return { down: (along(landing) - sT) * body.radius, cross: (off(landing) - off(target)) * body.radius, range: sT * body.radius };
}

export class EntryGuidance {
  /** bank angle magnitude (rad); 0 = lift straight up */
  bank: number;
  /** +1: lift leans left of the ground track, -1: right */
  sign = 1;
  /** last prediction against the target (null without a target) */
  last: EntryPrediction | null = null;
  reversals = 0;
  private nextT = -Infinity;

  /** `target`: body-fixed unit direction of the landing site, or null for a fixed 60° bank */
  constructor(readonly vessel: Vessel, readonly target: Vector3 | null) {
    this.bank = target ? Math.acos(0.5) : (60 * Math.PI) / 180;
  }

  update(t: number): void {
    if (!this.target || t < this.nextT) return;
    this.nextT = t + 1;
    const v = this.vessel;
    const body = v.body;
    const tm = v.telemetry;
    // the last minutes are flown at the chosen bank: there is too little lift left to steer
    if (tm.speedSurface < 600 || tm.altitude < 18_000) return;
    const mass = v.mass;
    const area = v.aero.refArea;
    body.orientationAt(t, _q);
    _q.invert();
    const here = v.pos.clone().normalize().applyQuaternion(_q);
    // horizontal direction of motion over the ground, body-fixed
    const track = v.telemetry.airVelocity.clone().applyQuaternion(_q);
    track.addScaledVector(here, -track.dot(here)).normalize();
    const evalC = (c: number) => {
      const p = predictEntry(body, v.pos, v.vel, t, mass, area, c);
      return { ...rangeErrors(body, here, track, p.dir, this.target!), dir: p.dir };
    };
    // range grows with the vertical share of the lift: bisect cos(bank) for zero down-range error
    let lo = -1, hi = 1;
    let res = evalC(Math.cos(this.bank));
    const top = evalC(1);
    if (top.down <= 0) { this.bank = 0; res = top; }
    else {
      const bottom = evalC(-1);
      if (bottom.down >= 0) { this.bank = Math.PI; res = bottom; }
      else {
        for (let i = 0; i < 9; i++) {
          const mid = (lo + hi) / 2;
          const m = evalC(mid);
          if (m.down > 0) hi = mid; else lo = mid;
        }
        const c = (lo + hi) / 2;
        this.bank = Math.acos(c);
        res = evalC(c);
      }
    }
    this.last = res;
    // bank reversal: the sideways lift is pushing the landing further off the track
    const deadband = Math.max(2500, 0.05 * Math.abs(res.range));
    if (Math.abs(res.cross) > deadband && Math.sign(res.cross) === this.sign && this.bank > 0.15 && this.bank < Math.PI - 0.15) {
      this.sign = -this.sign;
      this.reversals++;
    }
  }

  /**
   * Desired lift direction (inertial unit vector, perpendicular to the airflow) for the current
   * bank: `r` the position, `air` the air-relative velocity.
   */
  liftDirection(r: Vector3, air: Vector3, out: Vector3): Vector3 {
    const vh = air.clone().normalize();
    const up = r.clone().normalize();
    up.addScaledVector(vh, -up.dot(vh));
    if (up.lengthSq() < 1e-10) return out.set(0, 0, 0);
    up.normalize();
    // left of the track, looking along the motion (north when flying east)
    const left = new Vector3().crossVectors(r.clone().normalize(), vh).normalize();
    return out.copy(up).multiplyScalar(Math.cos(this.bank)).addScaledVector(left, Math.sin(this.bank) * this.sign).normalize();
  }
}
