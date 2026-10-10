import { Quaternion, Vector3 } from 'three';
import type { CelestialBody, SolarSystem } from '../physics/bodies';
import { keplerPropagate } from '../physics/orbit';
import { nominalLiftShare, predictEntry } from './entryGuidance';
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
  /** where the entry that follows should come down (trans-Earth injection) */
  landing?: LandingTarget;
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

/** A place on a body's surface for a deorbit to aim at (geodetic degrees). */
export interface LandingTarget { lat: number; lon: number; name: string }

/**
 * Deorbit burn: retrograde, lowering perigee into the entry corridor. Without a landing target it
 * burns in 45 s. With one, it picks the opportunity in the next day whose touchdown falls closest
 * to the target: a coarse scan follows each candidate's post-burn conic to entry interface and adds
 * a typical entry ground range, then the best opportunities are refined by flying the entry
 * through the atmosphere as a ballistic capsule.
 */
export function planDeorbit(v: Vessel, t: number, targetPe = 40_000, target?: LandingTarget): ManeuverNode {
  const body = v.body;
  const mu = body.gm;
  const burnAt = (tb: number, rOut: Vector3, vOut: Vector3) => {
    keplerPropagate(v.pos, v.vel, mu, tb - t, rOut, vOut);
    const r = rOut.length();
    const a2 = (r + body.radius + targetPe) / 2;
    const vNew = Math.sqrt(mu * (2 / r - 1 / a2));
    // retrograde along the current velocity (keeps the flight-path direction)
    const dvMag = vOut.length() - vNew;
    return dvMag;
  };
  let tb = t + 45;
  let note = `Perigee ${(targetPe / 1000).toFixed(0)} km — entry`;
  if (target && body.id === 'earth' && body.atmosphere) {
    const best = bestDeorbitTime(v, t, target, burnAt);
    if (best) {
      tb = best.t;
      note = `Lands near ${target.name} (~${Math.max(5, Math.round(best.miss / 5000) * 5)} km)`;
    }
  }
  const dvMag = burnAt(tb, _r, _v);
  const vHat = _v.clone().normalize();
  return { t: tb, dv: vHat.clone().multiplyScalar(-dvMag), prograde: -dvMag, label: 'Deorbit burn', result: note };
}

/** Great-circle distance (m) between a body-fixed unit direction and a lat/lon in degrees. */
function surfaceDistance(body: CelestialBody, dirFixed: Vector3, lat: number, lon: number): number {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  const d = dirFixed.x * Math.cos(la) * Math.cos(lo) + dirFixed.y * Math.cos(la) * Math.sin(lo) + dirFixed.z * Math.sin(la);
  return Math.acos(Math.max(-1, Math.min(1, d))) * body.radius;
}

function bestDeorbitTime(v: Vessel, t: number, target: LandingTarget, burnAt: (tb: number, r: Vector3, v: Vector3) => number): { t: number; miss: number } | null {
  const body = v.body;
  const mu = body.gm;
  const entryR = body.radius + 100_000;
  const q = new Quaternion();
  const r0 = new Vector3(), v0 = new Vector3(), rE = new Vector3(), vE = new Vector3(), fx = new Vector3();
  // capsule ballistic coefficient: the module that flies the entry (the service module is shed)
  const sc = v.assemblies.find((a) => a.def.features?.heatShield);
  const mass = sc ? Math.max(500, sc.mass) : v.mass;
  const area = sc ? Math.PI * Math.pow(Math.max(...sc.def.sections.map((x) => x.radius)), 2) : v.aero.refArea;
  /** post-burn state at entry interface (100 km), or null */
  const toEntry = (tb: number): { t: number } | null => {
    const dv = burnAt(tb, r0, v0);
    if (!isFinite(dv) || dv < 0) return null;
    v0.addScaledVector(v0.clone().normalize(), -dv);
    const T = orbitPeriod(r0, v0, mu);
    if (!isFinite(T)) return null;
    let lo = 0, hi = T / 2;
    keplerPropagate(r0, v0, mu, hi, rE, vE);
    if (rE.length() > entryR) return null;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      keplerPropagate(r0, v0, mu, mid, rE, vE);
      if (rE.length() > entryR) lo = mid; else hi = mid;
    }
    keplerPropagate(r0, v0, mu, hi, rE, vE);
    return { t: tb + hi };
  };
  // coarse: entry point + the ground range of the entry itself along the track. That range is
  // calibrated once by flying a representative entry (a lifting capsule covers ~2,000 km from
  // entry interface; the Earth turning beneath it is part of the same correction)
  let entryRange = 1_800_000;
  const calibrate = (tb: number) => {
    const e = toEntry(tb);
    if (!e) return false;
    const p = predictEntry(body, rE, vE, e.t, mass, area, nominalLiftShare(vE.length()), 2_000);
    body.orientationAt(e.t, q);
    const entryFixed = rE.clone().normalize().applyQuaternion(q.invert());
    entryRange = Math.acos(Math.max(-1, Math.min(1, entryFixed.dot(p.dir)))) * body.radius;
    return true;
  };
  for (let k = 0; k < 20 && !calibrate(t + 120 + k * 300); k++);
  const coarse = (tb: number): number => {
    const e = toEntry(tb);
    if (!e) return Infinity;
    // advance along the track in the rotating frame: body-fixed entry point and track direction
    body.orientationAt(e.t, q);
    q.invert();
    const pos = rE.clone().normalize().applyQuaternion(q);
    const omega = body.angularVelocity(new Vector3());
    const vRel = vE.clone().sub(new Vector3().crossVectors(omega, rE)).applyQuaternion(q);
    const n = new Vector3().crossVectors(pos, vRel).normalize();
    const land = pos.applyAxisAngle(n, entryRange / body.radius);
    return surfaceDistance(body, land, target.lat, target.lon);
  };
  // fine: fly the entry as the guidance will, at the nominal bank (60° from orbit: the middle of the
  // capsule's footprint, leaving it room to steer either way)
  const fine = (tb: number): number => {
    const e = toEntry(tb);
    if (!e) return Infinity;
    const p = predictEntry(body, rE, vE, e.t, mass, area, nominalLiftShare(vE.length()), 2_000);
    return surfaceDistance(body, p.dir, target.lat, target.lon);
  };
  // scan three days of opportunities, keep the best few separate passes
  const passes: { t: number; d: number }[] = [];
  for (let tb = t + 120; tb < t + 3 * 86_400; tb += 30) {
    const d = coarse(tb);
    if (d < 900_000) {
      const last = passes[passes.length - 1];
      if (last && tb - last.t < 1200) { if (d < last.d) { last.t = tb; last.d = d; } }
      else passes.push({ t: tb, d });
    }
  }
  passes.sort((x, y) => x.d - y.d);
  const refined: { t: number; miss: number }[] = [];
  for (const p of passes.slice(0, 6)) {
    // a 10 s ladder around the coarse time, then 1 s
    let bt = p.t, bd = fine(p.t);
    for (let k = -12; k <= 12; k++) { const tb = p.t + k * 10; const d = fine(tb); if (d < bd) { bd = d; bt = tb; } }
    for (let k = -9; k <= 9; k++) { const tb = bt + k; const d = fine(tb); if (d < bd) { bd = d; bt = tb; } }
    refined.push({ t: bt, miss: bd });
  }
  if (!refined.length) return null;
  // the earliest opportunity that lands within reach of the recovery crews, else the closest
  const close = refined.filter((x) => x.miss < 60_000).sort((x, y) => x.t - y.t);
  const best = close[0] ?? refined.sort((x, y) => x.miss - y.miss)[0];
  return best;
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

/**
 * Time (s) for a conic to go from its current state to radius `rT`, on the inbound (falling) or
 * outbound branch, from Kepler's equation; null when the conic never reaches that radius there.
 */
function timeToRadius(r0: Vector3, v0: Vector3, mu: number, rT: number, inbound: boolean): number | null {
  const rm = r0.length();
  const energy = v0.lengthSq() / 2 - mu / rm;
  const a = -mu / (2 * energy);
  const h = new Vector3().crossVectors(r0, v0).length();
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
  const out = r0.dot(v0) >= 0;
  if (e < 1) {
    if (rT < a * (1 - e) || rT > a * (1 + e)) return null;
    const n = Math.sqrt(mu / (a * a * a));
    const ecc = (rr: number) => Math.acos(Math.max(-1, Math.min(1, (1 - rr / a) / e)));
    const E0 = out ? ecc(rm) : -ecc(rm);
    const E1 = inbound ? -ecc(rT) : ecc(rT);
    let dt = (E1 - e * Math.sin(E1) - (E0 - e * Math.sin(E0))) / n;
    if (dt < 0) dt += (2 * Math.PI) / n;
    return dt;
  }
  if (e <= 1 || rT < a * (1 - e)) return null;
  const n = Math.sqrt(mu / Math.pow(-a, 3));
  const hyp = (rr: number) => Math.acosh(Math.max(1, (1 - rr / a) / e));
  const F0 = out ? hyp(rm) : -hyp(rm);
  const F1 = inbound ? -hyp(rT) : hyp(rT);
  const dt = (e * Math.sinh(F1) - F1 - (e * Math.sinh(F0) - F0)) / n;
  return dt >= 0 ? dt : null;
}

/** Which ocean a splashdown point lies in, for messages (coarse boxes; degrees). */
export function oceanName(lat: number, lon: number): string {
  if (lat < -60) return 'the Southern Ocean';
  if (lat > 66) return 'the Arctic Ocean';
  // inland seas first
  if (lat >= 40.5 && lat < 47 && lon >= 27 && lon < 42) return 'the Black Sea';
  if (lat >= 36 && lat < 47.5 && lon >= 46 && lon < 55) return 'the Caspian Sea';
  if (lat >= 30 && lat < 46 && lon >= -6 && lon < 36.5) return 'the Mediterranean';
  // the Red Sea and the Gulf reach north of the open Indian Ocean
  if (lon >= 32 && lon < 57 && lat >= 12 && lat < 31) return 'the Indian Ocean';
  if (lon >= 20 && lon < 147 && lat < 25 && !(lon > 100 && lat > -8)) return 'the Indian Ocean';
  if ((lon > -70 && lon < 20) || (lat > 8 && lon > -98 && lon < 20 && !(lat < 18 && lon < -84))) return 'the Atlantic';
  return 'the Pacific';
}

/**
 * Trans-Earth injection from lunar orbit: a prograde burn whose return conic grazes the Earth at
 * the entry perigee. Every Δv in the search range has burn times that hit that perigee exactly;
 * the faster returns cost more but arrive earlier, with the Earth turned differently beneath the
 * entry. Each solution's entry is flown (lifting capsule at the nominal bank) to its
 * splashdown point, and the cheapest burn that comes down in open water — in daylight when it
 * costs little — wins, as Apollo chose its return to reach the mid-Pacific recovery forces. The
 * node carries that point so the entry guidance can steer for it.
 */
export function planTEI(v: Vessel, sys: SolarSystem, t: number, entryPe = 45_000, isWater?: (dirFixed: Vector3) => boolean): ManeuverNode | null {
  if (v.body.id !== 'moon') return null;
  const moon = sys.moon, earth = sys.earth;
  const mu = moon.gm;
  const T = orbitPeriod(v.pos, v.vel, mu);
  if (!isFinite(T)) return null;
  const target = earth.radius + entryPe;
  const eiR = earth.radius + (earth.atmosphereTop || 140_000);
  const rB = new Vector3(), vB = new Vector3(), rX = new Vector3(), vX = new Vector3(), mr = new Vector3(), mv = new Vector3();
  /** Earth-relative state at lunar sphere-of-influence exit after a prograde burn of dv at tb */
  const depart = (tb: number, dv: number): { t: number } | null => {
    keplerPropagate(v.pos, v.vel, mu, tb - t, rB, vB);
    vB.multiplyScalar(1 + dv / vB.length());
    const dtx = timeToRadius(rB, vB, mu, moon.soi, false);
    if (dtx === null) return null;
    keplerPropagate(rB, vB, mu, dtx, rX, vX);
    moon.localStateAt(tb + dtx, mr, mv);
    rX.add(mr); vX.add(mv);
    return rX.dot(vX) < 0 ? { t: tb + dtx } : null;
  };
  const perigeeError = (tb: number, dv: number) => (depart(tb, dv) ? periapsisOf(rX, vX, earth.gm).rp - target : NaN);
  // every (Δv, burn time) whose return grazes the entry perigee: sign changes of the perigee
  // error around the orbit, bisected
  const sols: { tb: number; dv: number }[] = [];
  const N = 90;
  for (let dv = 750; dv <= 1250; dv += 10) {
    let prevT = NaN, prevE = NaN;
    for (let i = 0; i <= N * 1.25; i++) {
      const tb = t + 180 + (i / N) * T;
      const err = perigeeError(tb, dv);
      if (isFinite(err) && isFinite(prevE) && Math.sign(err) !== Math.sign(prevE)) {
        let lo = prevT, hi = tb, elo = prevE;
        for (let k = 0; k < 32; k++) {
          const mid = 0.5 * (lo + hi);
          const em = perigeeError(mid, dv);
          if (!isFinite(em)) break;
          if (Math.sign(em) === Math.sign(elo)) { lo = mid; elo = em; } else hi = mid;
        }
        sols.push({ tb: 0.5 * (lo + hi), dv });
      }
      prevT = tb; prevE = err;
    }
  }
  if (!sols.length) return null;
  // the capsule that flies the entry (whatever else is attached is shed before entry interface)
  const sc = v.assemblies.find((a) => a.def.features?.heatShield);
  const mass = sc ? Math.max(500, sc.mass) : v.mass;
  const area = sc ? Math.PI * Math.pow(Math.max(...sc.def.sections.map((x) => x.radius)), 2) : v.aero.refArea;
  const q = new Quaternion(), rE = new Vector3(), vE = new Vector3(), sun = new Vector3(), n = new Vector3(), p = new Vector3();
  let best: { cost: number; tb: number; dv: number; lat: number; lon: number; water: boolean; day: boolean } | null = null;
  for (const s of sols) {
    const d = depart(s.tb, s.dv);
    if (!d) continue;
    const dtE = timeToRadius(rX, vX, earth.gm, eiR, true);
    if (dtE === null) continue;
    keplerPropagate(rX, vX, earth.gm, dtE, rE, vE);
    const tEI = d.t + dtE;
    const land = predictEntry(earth, rE, vE, tEI, mass, area, nominalLiftShare(vE.length()), 2_000);
    // open water: the splashdown point and the footprint around it (along and across the track)
    let water = true;
    if (isWater) {
      earth.orientationAt(tEI, q);
      const ei = rE.clone().normalize().applyQuaternion(q.clone().invert());
      // rotating about the ground track's pole moves along the track, about the track's tangent across it
      n.crossVectors(ei, land.dir).normalize();
      const fwd = new Vector3().crossVectors(n, land.dir).normalize();
      for (const [al, ac] of [[0, 0], [150, 0], [-150, 0], [0, 60], [0, -60]]) {
        p.copy(land.dir).applyAxisAngle(n, (al * 1000) / earth.radius).applyAxisAngle(fwd, (ac * 1000) / earth.radius);
        if (!isWater(p)) { water = false; break; }
      }
    }
    // daylight at the recovery point: the Sun's direction against the local vertical
    earth.orientationAt(land.t, q);
    earth.globalPositionAt(land.t, sun).negate().normalize();
    const day = land.dir.clone().applyQuaternion(q).dot(sun) > 0.1;
    // slow returns barely escape the Moon: cheap, but their arrival is very sensitive to small
    // burn errors (and the crew is longer in space), so they pay for every day past three
    const tof = (tEI - s.tb) / 86_400;
    const cost = s.dv + Math.max(0, tof - 3) * 150 + (water ? 0 : 600) + (day ? 0 : 40);
    if (!best || cost < best.cost) {
      best = { cost, tb: s.tb, dv: s.dv, lat: (Math.asin(land.dir.z) * 180) / Math.PI, lon: (Math.atan2(land.dir.y, land.dir.x) * 180) / Math.PI, water, day };
    }
  }
  if (!best) return null;
  keplerPropagate(v.pos, v.vel, mu, best.tb - t, _r, _v);
  const node: ManeuverNode = { t: best.tb, dv: _v.clone().normalize().multiplyScalar(best.dv), prograde: best.dv, label: 'Trans-Earth injection', result: `Entry perigee ${(entryPe / 1000).toFixed(0)} km` };
  if (isWater && best.water) {
    const name = oceanName(best.lat, best.lon);
    node.landing = { lat: best.lat, lon: best.lon, name: `${name} recovery zone` };
    node.result += ` · splashdown in ${name}`;
  }
  return node;
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
