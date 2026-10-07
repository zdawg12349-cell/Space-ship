import { Quaternion, Vector3 } from 'three';
import type { CelestialBody, SolarSystem } from '../physics/bodies';
import { keplerPropagate } from '../physics/orbit';
import type { Vessel } from '../physics/vessel';

/**
 * Manoeuvre planning on patched conics. Each planner returns an impulsive node (time and
 * inertial Δv) that the autopilot's burn executor flies as a finite burn centred on the node.
 *
 *  - deorbit: retrograde burn lowering perigee into the entry corridor
 *  - circularise: at the next apsis
 *  - translunar injection: grid search + refinement over burn time and Δv, evaluating the
 *    lunar periapsis exactly on the Moon-relative hyperbola at sphere-of-influence entry
 *  - trans-Earth injection: the same from lunar orbit, targeting a 45 km entry perigee
 *  - Jupiter orbit insertion: retrograde at perijove into a long capture ellipse
 */

export interface ManeuverNode {
  t: number;
  /** Δv in the inertial frame (m/s) */
  dv: Vector3;
  /** Δv components in the orbital frame at the node (prograde, normal, radial) for display */
  prograde: number;
  label: string;
  /** predicted result for display */
  result: string;
}

const _r = new Vector3();
const _v = new Vector3();
const _r2 = new Vector3();
const _v2 = new Vector3();

/** Periapsis radius of the conic through (r, v). */
function periapsisOf(r: Vector3, v: Vector3, mu: number): { rp: number; e: number; a: number } {
  const rm = r.length();
  const v2 = v.lengthSq();
  const h = new Vector3().crossVectors(r, v).length();
  const energy = v2 / 2 - mu / rm;
  const a = -mu / (2 * energy);
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
  const p = (h * h) / mu;
  return { rp: p / (1 + e), e, a };
}

function orbitPeriod(r: Vector3, v: Vector3, mu: number): number {
  const { a, e } = periapsisOf(r, v, mu);
  return e < 1 && a > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;
}

export function planDeorbit(v: Vessel, t: number, targetPe = 40_000): ManeuverNode {
  const body = v.body;
  const mu = body.gm;
  const tb = t + 45;
  keplerPropagate(v.pos, v.vel, mu, tb - t, _r, _v);
  const r = _r.length();
  const rpT = body.radius + targetPe;
  const a2 = (r + rpT) / 2;
  const vNew = Math.sqrt(mu * (2 / r - 1 / a2));
  // retrograde along the current velocity (keeps the flight-path direction)
  const vHat = _v.clone().normalize();
  const dvMag = _v.length() - vNew;
  return { t: tb, dv: vHat.clone().multiplyScalar(-dvMag), prograde: -dvMag, label: 'Deorbit burn', result: `Perigee ${(targetPe / 1000).toFixed(0)} km — entry` };
}

export function planCircularize(v: Vessel, t: number): ManeuverNode | null {
  const mu = v.body.gm;
  const o = v.updateOrbit(t);
  if (o.e >= 1) return null;
  // time to apoapsis: march the conic and find max radius
  const T = orbitPeriod(v.pos, v.vel, mu);
  let best = 0, bestR = 0;
  for (let i = 1; i <= 360; i++) {
    const dt = (i / 360) * T;
    keplerPropagate(v.pos, v.vel, mu, dt, _r, _v);
    const rr = _r.length();
    if (rr > bestR) { bestR = rr; best = dt; }
  }
  keplerPropagate(v.pos, v.vel, mu, best, _r, _v);
  const vc = Math.sqrt(mu / bestR);
  const radial = _r.clone().normalize();
  const horiz = _v.clone().addScaledVector(radial, -_v.dot(radial)).normalize();
  const target = horiz.multiplyScalar(vc);
  const dv = target.sub(_v);
  return { t: t + best, dv, prograde: dv.length(), label: 'Circularisation', result: `Circular ${((bestR - v.body.radius) / 1000).toFixed(0)} km` };
}

/**
 * Lunar periapsis (radius, m) reached by an Earth-relative conic starting at (r0, v0) at t0,
 * or Infinity if it never enters the Moon's sphere of influence within maxT.
 */
function lunarArrival(sys: SolarSystem, r0: Vector3, v0: Vector3, t0: number, maxT: number, exact = true): { rp: number; tSoi: number } {
  const earth = sys.earth, moon = sys.moon;
  const mu = earth.gm;
  const mr = new Vector3(), mv = new Vector3();
  // quick rejection: an ellipse whose apoapsis falls short of the Moon's sphere never arrives
  const rm = r0.length(), energy = v0.lengthSq() / 2 - mu / rm;
  if (energy < 0) {
    const a = -mu / (2 * energy);
    const hh = _r2.crossVectors(r0, v0).lengthSq();
    const e = Math.sqrt(Math.max(0, 1 - hh / (mu * a)));
    if (a * (1 + e) < 356_000_000 - moon.soi) return { rp: Infinity, tSoi: Infinity };
  }
  const step = 3600;
  const inside = (dt: number) => {
    keplerPropagate(r0, v0, mu, dt, _r2, _v2);
    moon.localStateAt(t0 + dt, mr, mv);
    return _r2.distanceTo(mr) < moon.soi;
  };
  for (let dt = step; dt <= maxT; dt += step) {
    keplerPropagate(r0, v0, mu, dt, _r2, _v2);
    if (_r2.length() < earth.radius) return { rp: Infinity, tSoi: Infinity };
    if (inside(dt)) {
      // the crossing itself, as the flight's rails propagation will find it
      let lo = dt - step, hi = dt;
      for (let k = 0; k < (exact ? 40 : 6); k++) { const mid = 0.5 * (lo + hi); if (inside(mid)) hi = mid; else lo = mid; }
      inside(hi);
      const rel = _r2.clone().sub(mr), relV = _v2.clone().sub(mv);
      const pe = periapsisOf(rel, relV, moon.gm);
      // periapsis only counts if we're still approaching
      return { rp: rel.dot(relV) < 0 ? pe.rp : rel.length(), tSoi: t0 + hi };
    }
  }
  return { rp: Infinity, tSoi: Infinity };
}

export function planTLI(v: Vessel, sys: SolarSystem, t: number, targetAlt = 300_000): ManeuverNode | null {
  if (v.body.id !== 'earth') return null;
  const mu = v.body.gm;
  const T = orbitPeriod(v.pos, v.vel, mu);
  if (!isFinite(T)) return null;
  const moonR = sys.moon.radius;
  const target = moonR + targetAlt;
  // Δv = prograde + normal (plane change toward the Moon's arrival position)
  const burnVector = (tb: number, dvP: number, dvN: number) => {
    keplerPropagate(v.pos, v.vel, mu, tb - t, _r, _v);
    const pHat = _v.clone().normalize();
    const nHat = new Vector3().crossVectors(_r, _v).normalize();
    return { rB: _r.clone(), vB0: _v.clone(), dv: pHat.multiplyScalar(dvP).addScaledVector(nHat, dvN) };
  };
  const evaluate = (tb: number, dvP: number, dvN: number, exact = true) => {
    const b = burnVector(tb, dvP, dvN);
    const arr = lunarArrival(sys, b.rB, b.vB0.clone().add(b.dv), tb, 6 * 86400, exact);
    const cost = !isFinite(arr.rp) ? 1e12 : Math.abs(arr.rp - target) + (arr.rp < moonR + 30_000 ? 5e6 : 0) + (arr.tSoi - tb) * 0.3 + Math.abs(dvN) * 200;
    return { cost, arr };
  };
  let best = { cost: Infinity, tb: 0, p: 0, n: 0 };
  const t0 = t + 240;
  for (let i = 0; i < 60; i++) {
    const tb = t0 + (i / 60) * T;
    for (let dvP = 3020; dvP <= 3260; dvP += 40) {
      for (let dvN = -600; dvN <= 600; dvN += 150) {
        const r = evaluate(tb, dvP, dvN, false);
        if (r.cost < best.cost) best = { cost: r.cost, tb, p: dvP, n: dvN };
      }
    }
  }
  if (!isFinite(best.cost) || best.cost >= 1e12) return null;
  best.cost = evaluate(best.tb, best.p, best.n).cost;
  let sT = T / 60, sP = 40, sN = 150;
  for (let it = 0; it < 26; it++) {
    sT *= 0.7; sP *= 0.7; sN *= 0.7;
    for (const [a, b, c] of [[sT, 0, 0], [-sT, 0, 0], [0, sP, 0], [0, -sP, 0], [0, 0, sN], [0, 0, -sN], [sT, sP, 0], [-sT, -sP, 0]]) {
      const tb = best.tb + a, p = best.p + b, n = best.n + c;
      if (tb < t + 120) continue;
      const r = evaluate(tb, p, n);
      if (r.cost < best.cost) best = { cost: r.cost, tb, p, n };
    }
  }
  const bv = burnVector(best.tb, best.p, best.n);
  const arr = evaluate(best.tb, best.p, best.n).arr;
  return {
    t: best.tb, dv: bv.dv, prograde: best.p, label: 'Translunar injection',
    result: `Lunar periapsis ${((arr.rp - moonR) / 1000).toFixed(0)} km · arrival in ${((arr.tSoi - best.tb) / 86400).toFixed(1)} d`,
  };
}

/** Earth periapsis after leaving the Moon on a Moon-relative conic. */
function earthReturn(sys: SolarSystem, r0: Vector3, v0: Vector3, t0: number): { rp: number; tExit: number } {
  const moon = sys.moon;
  const mu = moon.gm;
  const step = 600;
  for (let dt = step; dt <= 3 * 86400; dt += step) {
    keplerPropagate(r0, v0, mu, dt, _r2, _v2);
    if (_r2.length() < moon.radius) return { rp: Infinity, tExit: Infinity };
    if (_r2.length() > moon.soi) {
      let lo = dt - step, hi = dt;
      for (let k = 0; k < 40; k++) {
        const mid = 0.5 * (lo + hi);
        keplerPropagate(r0, v0, mu, mid, _r2, _v2);
        if (_r2.length() > moon.soi) hi = mid; else lo = mid;
      }
      keplerPropagate(r0, v0, mu, hi, _r2, _v2);
      const mr = new Vector3(), mv = new Vector3();
      moon.localStateAt(t0 + hi, mr, mv);
      const r = _r2.clone().add(mr), vv = _v2.clone().add(mv);
      const pe = periapsisOf(r, vv, sys.earth.gm);
      return { rp: r.dot(vv) < 0 || pe.e < 1 ? pe.rp : Infinity, tExit: t0 + hi };
    }
  }
  return { rp: Infinity, tExit: Infinity };
}

export function planTEI(v: Vessel, sys: SolarSystem, t: number, entryPe = 45_000): ManeuverNode | null {
  if (v.body.id !== 'moon') return null;
  const mu = v.body.gm;
  const T = orbitPeriod(v.pos, v.vel, mu);
  if (!isFinite(T)) return null;
  const target = sys.earth.radius + entryPe;
  const evaluate = (tb: number, dv: number) => {
    keplerPropagate(v.pos, v.vel, mu, tb - t, _r, _v);
    const vB = _v.clone().multiplyScalar(1 + dv / _v.length());
    const ret = earthReturn(sys, _r.clone(), vB, tb);
    return isFinite(ret.rp) ? Math.abs(ret.rp - target) : 1e12;
  };
  let best = { cost: Infinity, tb: 0, dv: 0 };
  for (let i = 0; i < 72; i++) {
    const tb = t + 180 + (i / 72) * T;
    for (let dv = 750; dv <= 1150; dv += 25) {
      const c = evaluate(tb, dv);
      if (c < best.cost) best = { cost: c, tb, dv };
    }
  }
  if (best.cost >= 1e12) return null;
  let stepT = T / 72, stepV = 25;
  for (let it = 0; it < 18; it++) {
    stepT *= 0.6; stepV *= 0.6;
    for (const [a, b] of [[stepT, 0], [-stepT, 0], [0, stepV], [0, -stepV]]) {
      const tb = best.tb + a, dv = best.dv + b;
      if (tb < t + 90) continue;
      const c = evaluate(tb, dv);
      if (c < best.cost) best = { cost: c, tb, dv };
    }
  }
  keplerPropagate(v.pos, v.vel, mu, best.tb - t, _r, _v);
  return { t: best.tb, dv: _v.clone().normalize().multiplyScalar(best.dv), prograde: best.dv, label: 'Trans-Earth injection', result: `Entry perigee ${((best.cost + target - sys.earth.radius) / 1000).toFixed(0)} km` };
}

/** Capture burn at the next periapsis into an orbit with the given apoapsis radius. */
export function planCapture(v: Vessel, t: number, apoRadiusFactor: number, label: string): ManeuverNode | null {
  const body: CelestialBody = v.body;
  const mu = body.gm;
  const pe = periapsisOf(v.pos, v.vel, mu);
  // time to periapsis: march forward until the radius starts increasing
  let prev = v.pos.length(), tp = 0;
  const approaching = v.pos.dot(v.vel) < 0;
  if (!approaching) return null;
  const span = Math.min(30 * 86400, (v.pos.length() / Math.max(1, v.vel.length())) * 4);
  for (let i = 1; i <= 4000; i++) {
    const dt = (i / 4000) * span;
    keplerPropagate(v.pos, v.vel, mu, dt, _r, _v);
    const rr = _r.length();
    if (rr > prev) { tp = dt; break; }
    prev = rr;
    tp = dt;
  }
  keplerPropagate(v.pos, v.vel, mu, tp, _r, _v);
  const rp = _r.length();
  const ra = body.radius * apoRadiusFactor;
  const a = (rp + ra) / 2;
  const vT = Math.sqrt(mu * (2 / rp - 1 / a));
  const dv = _v.length() - vT;
  void pe;
  return { t: t + tp, dv: _v.clone().normalize().multiplyScalar(-dv), prograde: -dv, label, result: `Capture: ${((rp - body.radius) / 1e6).toFixed(0)} × ${((ra - body.radius) / 1e6).toFixed(0)} Mm` };
}

/**
 * Launch plane for a lunar mission: the parking orbit must contain the Moon's position at
 * arrival (about three days after translunar injection), so the plane through the launch
 * site at liftoff and that direction fixes the launch azimuth. Returns the inertial plane
 * normal (Earth-centred), its inclination and the surface-relative launch azimuth (rad from
 * north, corrected for the ground's eastward motion), choosing the eastward-going branch.
 */
export function lunarLaunchPlane(sys: SolarSystem, latDeg: number, lonDeg: number, tLiftoff: number, coast = 3 * 86400 + 2 * 3600):
  { normal: Vector3; inclination: number; azimuth: number } {
  const earth = sys.earth;
  const q = new Quaternion();
  earth.orientationAt(tLiftoff, q);
  const la = (latDeg * Math.PI) / 180, lo = (lonDeg * Math.PI) / 180;
  const up = new Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)).applyQuaternion(q);
  const north = new Vector3(-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)).applyQuaternion(q);
  const east = new Vector3().crossVectors(north, up);
  const pole = new Vector3(0, 0, 1).applyQuaternion(q);
  const m = new Vector3(), mv = new Vector3();
  sys.moon.localStateAt(tLiftoff + coast, m, mv);
  const n = new Vector3().crossVectors(up, m).normalize();
  const d = new Vector3().crossVectors(n, up);
  if (d.dot(east) < 0) { n.negate(); d.negate(); }
  // inertial azimuth of the plane at the site, then remove the ground's own eastward speed
  const beta = Math.atan2(d.dot(east), d.dot(north));
  const vOrbit = 7800, vEq = (2 * Math.PI * earth.radius) / 86164.1;
  const vx = vOrbit * Math.sin(beta) - vEq * Math.cos(la), vy = vOrbit * Math.cos(beta);
  return { normal: n, inclination: Math.acos(Math.max(-1, Math.min(1, n.dot(pole)))), azimuth: Math.atan2(vx, vy) };
}

/**
 * Mid-course correction: a small burn a few minutes from now that trims the trajectory's
 * next target — lunar periapsis on the way out (or inside the Moon's sphere while still
 * approaching), Earth entry perigee on the way home. Pattern search over the burn's
 * prograde / normal / radial components with a small penalty on Δv.
 */
export function planCorrection(v: Vessel, sys: SolarSystem, t: number, moonAlt = 300_000, entryPe = 45_000): ManeuverNode | null {
  const body = v.body;
  const mu = body.gm;
  const tb = t + 300;
  keplerPropagate(v.pos, v.vel, mu, tb - t, _r, _v);
  const rB = _r.clone(), vB = _v.clone();
  const pHat = vB.clone().normalize();
  const nHat = new Vector3().crossVectors(rB, vB).normalize();
  const rHat = new Vector3().crossVectors(pHat, nHat).normalize().negate();
  let goal: 'moon' | 'earth' | null = null;
  let target = 0;
  let metric: (vv: Vector3) => number;
  if (body.id === 'earth') {
    const arr = lunarArrival(sys, rB, vB, tb, 6 * 86400);
    const pe = periapsisOf(rB, vB, mu);
    if (isFinite(arr.rp)) {
      goal = 'moon'; target = sys.moon.radius + moonAlt;
      metric = (vv) => lunarArrival(sys, rB, vv, tb, 6 * 86400).rp;
    } else if (rB.dot(vB) < 0 && pe.rp < body.radius + 2_000_000 && rB.length() > body.radius + 1_000_000) {
      goal = 'earth'; target = body.radius + entryPe;
      metric = (vv) => periapsisOf(rB, vv, mu).rp;
    } else return null;
  } else if (body.id === 'moon') {
    if (rB.dot(vB) < 0 && periapsisOf(rB, vB, mu).e >= 1) {
      goal = 'moon'; target = body.radius + moonAlt;
      metric = (vv) => (rB.dot(vv) < 0 ? periapsisOf(rB, vv, mu).rp : Infinity);
    } else if (rB.dot(vB) > 0) {
      goal = 'earth'; target = sys.earth.radius + entryPe;
      metric = (vv) => earthReturn(sys, rB, vv, tb).rp;
    } else return null;
  } else return null;
  const dvOf = (p: number, n: number, r: number) => pHat.clone().multiplyScalar(p).addScaledVector(nHat, n).addScaledVector(rHat, r);
  const cost = (p: number, n: number, r: number) => {
    const rp = metric!(vB.clone().add(dvOf(p, n, r)));
    if (!isFinite(rp)) return 1e12;
    return Math.abs(rp - target) + Math.hypot(p, n, r) * 400;
  };
  let best = { c: cost(0, 0, 0), p: 0, n: 0, r: 0 };
  const start = best.c;
  let step = 8;
  for (let it = 0; it < 90 && step > 0.004; it++) {
    let improved = false;
    for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const p = best.p + a * step, n = best.n + b * step, r = best.r + c * step;
      if (Math.hypot(p, n, r) > 250) continue;
      const cc = cost(p, n, r);
      if (cc < best.c) { best = { c: cc, p, n, r }; improved = true; }
    }
    if (!improved) step *= 0.5;
  }
  const dv = dvOf(best.p, best.n, best.r);
  if (dv.length() < 0.05 || best.c >= start) return null;
  const rp = metric!(vB.clone().add(dv));
  const what = goal === 'moon' ? `Lunar periapsis ${((rp - sys.moon.radius) / 1000).toFixed(0)} km` : `Entry perigee ${((rp - sys.earth.radius) / 1000).toFixed(0)} km`;
  return { t: tb, dv, prograde: best.p, label: 'Course correction', result: what };
}

/** Predicted next event of a coasting trajectory, for the HUD (km above the surface, event time), or null. */
export function trajectoryForecast(v: Vessel, sys: SolarSystem, t: number): { what: string; km: number; t: number } | null {
  const body = v.body;
  if (body.id === 'earth') {
    const o = periapsisOf(v.pos, v.vel, body.gm);
    if (o.e < 0.9 && o.a < 200_000_000) return null;
    const arr = lunarArrival(sys, v.pos, v.vel, t, 6 * 86400);
    if (isFinite(arr.rp)) return { what: 'Lunar periapsis', km: (arr.rp - sys.moon.radius) / 1000, t: arr.tSoi };
    if (v.pos.dot(v.vel) < 0) return { what: 'Perigee', km: (o.rp - body.radius) / 1000, t: t + v.updateOrbit(t).timeToPeriapsis() };
    return null;
  }
  if (body.id === 'moon') {
    const o = periapsisOf(v.pos, v.vel, body.gm);
    if (o.e < 1) return null;
    if (v.pos.dot(v.vel) < 0) return { what: 'Lunar periapsis', km: (o.rp - body.radius) / 1000, t: t + v.updateOrbit(t).timeToPeriapsis() };
    const ret = earthReturn(sys, v.pos, v.vel, t);
    if (isFinite(ret.rp)) return { what: 'Earth perigee', km: (ret.rp - sys.earth.radius) / 1000, t: ret.tExit };
  }
  return null;
}
