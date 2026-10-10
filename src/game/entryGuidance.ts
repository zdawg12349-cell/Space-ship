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
 *
 * Returning from the Moon at 11 km/s the first plunge is flown lift-up (load relief, as Apollo
 * did) and the range is steered after the pull-out; the predictor treats any climb back out of
 * the atmosphere as a skip-out it must avoid.
 */

/** lift-to-drag ratio of the trimmed capsule (the vessel's capsule lift model) */
export const CAPSULE_LD = 0.3;
const CD_SHIELD = 1.32;
/** above this speed (m/s) the entry is supercircular: a lunar return */
const SUPERCIRCULAR = 8_500;
/** predicted peak deceleration (g) the bank is not allowed to exceed for the sake of range */
const G_LIMIT = 9;

/**
 * Vertical lift share actually flown for the guidance's share `c`. While a supercircular capsule
 * is still diving, the lift is rolled progressively upward as the deceleration builds from 1.5 to
 * 3 g, so the pull-out comes early and the peak stays near 6 g; slower, any diving capsule does
 * the same from 4.5 g (an orbital entry peaks below that). The predictor flies this same law, so
 * the range it promises includes it.
 */
export function reliefShare(c: number, sensedG: number, verticalSpeed: number, speed: number): number {
  if (verticalSpeed >= 0) return c;
  const g0 = speed > SUPERCIRCULAR ? 1.5 : 4.5, g1 = speed > SUPERCIRCULAR ? 3 : 6;
  if (sensedG <= g0) return c;
  const w = Math.min(1, (sensedG - g0) / (g1 - g0));
  return c + (1 - c) * w;
}

/**
 * The vertical lift share planners assume for a nominal entry, in the middle of the capsule's
 * reach: a 60° bank from orbit, lift neutral after the pull-out of a lunar return (more would
 * carry it toward a skip, the long side's limit).
 */
export function nominalLiftShare(entrySpeed: number): number {
  return entrySpeed > SUPERCIRCULAR + 500 ? 0 : 0.5;
}

const _q = new Quaternion();
const _a = new Vector3();
const _air = new Vector3();
const _up = new Vector3();

type Prediction = EntryPrediction & { skip: boolean; maxG: number };

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
 * share `c` (cos of the bank angle). Returns the body-fixed landing direction and the time, or
 * `skip` when the capsule climbs back out of the atmosphere (too much lift for a fast, shallow
 * entry: it would leave on a long arc through space instead of landing).
 */
export function predictEntry(body: CelestialBody, r0: Vector3, v0: Vector3, t0: number, mass: number, area: number, c: number, stopAlt = 10_000): { dir: Vector3; t: number; skip: boolean; maxG: number } {
  const atm = body.atmosphere;
  const mu = body.gm;
  const r = r0.clone(), vel = v0.clone();
  const omega = body.angularVelocity(new Vector3());
  const s = { pressure: 0, density: 0, temperature: 0, speedOfSound: 300 };
  const top = body.atmosphereTop || 140_000;
  let t = t0;
  let entered = false, skip = true, maxA = 0;
  // lift share flown this step (load relief included) and the sensed deceleration behind it
  let cNow = c, sensed = 0;
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
    sensed = d * Math.hypot(1, CAPSULE_LD);
    out.addScaledVector(_air, -d / sp);
    // lift in the vertical plane: the local vertical, made perpendicular to the airflow
    _up.copy(rr).multiplyScalar(1 / rl);
    _up.addScaledVector(_air, -_up.dot(_air) / (sp * sp));
    const ul = _up.length();
    if (ul > 1e-6) out.addScaledVector(_up, (CAPSULE_LD * d * cNow) / ul);
    return out;
  };
  const a1 = new Vector3(), a2 = new Vector3(), rm = new Vector3(), vm = new Vector3();
  for (let i = 0; i < 8000; i++) {
    const rl = r.length();
    const alt = rl - body.radius;
    if (alt < stopAlt) { skip = false; break; }
    if (alt < top - 15_000) entered = true;
    else if (entered && alt > top - 10_000 && r.dot(vel) > 0) break; // back out into space
    const h = alt > 90_000 ? 4 : alt > 40_000 ? 1 : 0.5;
    cNow = reliefShare(c, sensed / 9.80665, r.dot(vel), vel.length());
    acc(r, vel, a1);
    maxA = Math.max(maxA, sensed);
    rm.copy(r).addScaledVector(vel, h * 0.5);
    vm.copy(vel).addScaledVector(a1, h * 0.5);
    acc(rm, vm, a2);
    r.addScaledVector(vm, h);
    vel.addScaledVector(a2, h);
    t += h;
  }
  body.orientationAt(t, _q);
  return { dir: r.normalize().applyQuaternion(_q.invert()), t, skip, maxG: maxA / 9.80665 };
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
  /** body-fixed unit direction of the landing point being steered for (null: hold the nominal bank) */
  target: Vector3 | null;
  /** a splashdown point the guidance chose itself at entry interface (none planned, or out of reach) */
  designated: { lat: number; lon: number } | null = null;
  /** lift rolled upward to keep the deceleration in check (load relief) */
  relief = false;
  private nextT = -Infinity;
  private started = false;
  private footprintDone = false;

  /**
   * `target`: body-fixed unit direction of the landing site, or null to hold the nominal bank
   * (60° from orbit, 90° after a lunar return's pull-out).
   * `isWater`: for capsules that come down at sea — at entry interface a splashdown point is
   * chosen in open water inside the capsule's reach when none was planned or the planned one
   * can no longer be reached.
   */
  constructor(readonly vessel: Vessel, target: Vector3 | null, private readonly isWater: ((dirFixed: Vector3) => boolean) | null = null) {
    this.target = target;
    this.bank = Math.acos(0.5);
  }

  update(t: number): void {
    const v = this.vessel;
    const tm = v.telemetry;
    if (t < this.nextT) return;
    this.nextT = t + 1;
    if (!this.started) {
      this.started = true;
      this.bank = Math.acos(nominalLiftShare(v.vel.length()));
    }
    if (!this.footprintDone && this.isWater && tm.speedSurface > 2500 && tm.altitude > 50_000) {
      this.footprintDone = true;
      this.chooseSplashdown(t);
    }
    if (!this.target) return;
    // the last minutes are flown at the chosen bank: there is too little lift left to steer
    if (tm.speedSurface < 600 || tm.altitude < 18_000) return;
    const { here, track } = this.groundTrack(t);
    const evalC = (c: number) => this.predict(t, c, here, track);
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
        let c = (lo + hi) / 2;
        res = evalC(c);
        // a target beyond the longest entry that stays in the atmosphere: the bisection settles on
        // the edge of a skip-out, so keep some lift in hand below it
        if (res.down < -20_000) { c = Math.max(-1, c - 0.08); res = evalC(c); }
        this.bank = Math.acos(c);
      }
    }
    // the crew before the range: when reaching the target would mean a hard deceleration, fly
    // with enough lift to keep the peak in check and come down long instead
    // (more lift always lowers the peak; a skip-out, gentle as it is, is never an answer)
    if (res.maxG > G_LIMIT && !res.skip) {
      let a = Math.cos(this.bank), b = 1;
      for (let i = 0; i < 7; i++) {
        const mid = (a + b) / 2;
        if (evalC(mid).maxG > G_LIMIT) a = mid; else b = mid;
      }
      const eased = evalC(b);
      if (!eased.skip) { res = eased; this.bank = Math.acos(b); }
    }
    this.last = res;
    // bank reversal: the sideways lift is pushing the landing further off the track
    const deadband = Math.max(2500, 0.05 * Math.abs(res.range));
    if (Math.abs(res.cross) > deadband && Math.sign(res.cross) === this.sign && this.bank > 0.15 && this.bank < Math.PI - 0.15) {
      this.sign = -this.sign;
      this.reversals++;
    }
  }

  /** Where the capsule is over the ground and which way it is going (body-fixed unit vectors). */
  private groundTrack(t: number): { here: Vector3; track: Vector3 } {
    const v = this.vessel;
    v.body.orientationAt(t, _q);
    _q.invert();
    const here = v.pos.clone().normalize().applyQuaternion(_q);
    const track = v.telemetry.airVelocity.clone().applyQuaternion(_q);
    track.addScaledVector(here, -track.dot(here)).normalize();
    return { here, track };
  }

  /** The rest of the entry at vertical lift share `c`, against `target` (a skip-out counts as far too long). */
  private predict(t: number, c: number, here: Vector3, track: Vector3, target: Vector3 | null = this.target): Prediction {
    const v = this.vessel;
    const p = predictEntry(v.body, v.pos, v.vel, t, v.mass, v.aero.refArea, c);
    if (p.skip) return { down: 1e9, cross: 0, range: 0, dir: p.dir, skip: true, maxG: p.maxG };
    const e = target ? rangeErrors(v.body, here, track, p.dir, target) : { down: 0, cross: 0, range: 0 };
    return { ...e, dir: p.dir, skip: false, maxG: p.maxG };
  }

  /**
   * At entry interface: keep a planned landing point the capsule can still reach. Otherwise (or
   * with none planned) choose a splashdown point in open water inside the footprint, as near the
   * nominal bank as possible; failing that, a point the capsule reaches comfortably.
   */
  private chooseSplashdown(t: number): void {
    const body = this.vessel.body;
    const { here, track } = this.groundTrack(t);
    const cNom = nominalLiftShare(this.vessel.vel.length());
    if (this.target) {
      // reachable: between the shortest entry and the longest that stays in the atmosphere, and
      // within the cross-range the sideways lift can make up
      let longest: Prediction | null = null;
      for (const c of [1, 0.75, 0.5, 0.25, 0, -0.25, -0.5]) {
        const p = this.predict(t, c, here, track);
        if (!p.skip) { longest = p; break; }
      }
      const shortest = this.predict(t, -1, here, track);
      const nominal = this.predict(t, cNom, here, track);
      if (longest && longest.down >= 0 && !shortest.skip && shortest.down <= 0 && !nominal.skip
        && Math.abs(nominal.cross) < 60_000 + 0.03 * Math.abs(nominal.range)) return;
    }
    const isWater = this.isWater!;
    const openWater = (d: Vector3) => {
      // the point itself and a margin around it, along and across the track
      const pole = new Vector3().crossVectors(here, d).normalize();
      const fwd = new Vector3().crossVectors(pole, d).normalize();
      for (const [al, ac] of [[0, 0], [80, 0], [-80, 0], [0, 40], [0, -40]]) {
        const p = d.clone().applyAxisAngle(pole, (al * 1000) / body.radius).applyAxisAngle(fwd, (ac * 1000) / body.radius);
        if (!isWater(p)) return false;
      }
      return true;
    };
    // lift shares spreading out from the nominal: the nearer it, the more room left to steer
    const shares: number[] = [];
    for (const d of [0, 0.15, -0.15, 0.3, -0.3, 0.45, -0.45, 0.6, -0.6, 0.8, -0.8]) {
      const c = cNom + d;
      if (c >= -1 && c <= 1) shares.push(c);
    }
    let fallback: Vector3 | null = null;
    for (const c of shares) {
      const p = this.predict(t, c, here, track, null);
      if (p.skip || p.maxG > G_LIMIT) continue;
      if (!fallback) fallback = p.dir;
      if (openWater(p.dir)) { this.designate(p.dir, c); return; }
    }
    // only land in reach: a planned point that can't be reached gives way to a comfortable one
    if (this.target && fallback) this.designate(fallback, cNom);
  }

  private designate(dir: Vector3, c: number): void {
    this.target = dir.clone();
    this.designated = { lat: (Math.asin(Math.max(-1, Math.min(1, dir.z))) * 180) / Math.PI, lon: (Math.atan2(dir.y, dir.x) * 180) / Math.PI };
    this.bank = Math.acos(c);
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
    // load relief rolls the lift toward straight up while a steep dive builds deceleration
    const tm = this.vessel.telemetry;
    const c = Math.cos(this.bank);
    const cEff = reliefShare(c, tm.gForce, tm.verticalSpeed, this.vessel.vel.length());
    this.relief = cEff > c + 0.02;
    return out.copy(up).multiplyScalar(cEff).addScaledVector(left, Math.sqrt(Math.max(0, 1 - cEff * cEff)) * this.sign).normalize();
  }
}
