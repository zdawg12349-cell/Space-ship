import { Vector3 } from 'three';

/**
 * Two-body (Keplerian) orbit mechanics in double precision.
 *
 * Propagation uses the universal-variable formulation (Vallado, "Fundamentals of
 * Astrodynamics", Alg. 8) which is valid for elliptic, parabolic and hyperbolic
 * conics and free of the angular singularities of classical elements.
 */

const _t1 = new Vector3();
const _t2 = new Vector3();
const _t3 = new Vector3();

function stumpffC(z: number): number {
  if (z > 1e-6) { const s = Math.sqrt(z); return (1 - Math.cos(s)) / z; }
  if (z < -1e-6) { const s = Math.sqrt(-z); return (Math.cosh(s) - 1) / (-z); }
  return 0.5 - z / 24 + z * z / 720;
}

function stumpffS(z: number): number {
  if (z > 1e-6) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
  if (z < -1e-6) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
  return 1 / 6 - z / 120 + z * z / 5040;
}

/**
 * Propagate a state vector by dt seconds under point-mass gravity mu.
 * Writes results into outR / outV (may alias r0 / v0).
 */
export function keplerPropagate(r0: Vector3, v0: Vector3, mu: number, dt: number, outR: Vector3, outV: Vector3): void {
  if (dt === 0) { outR.copy(r0); outV.copy(v0); return; }
  const r0x = r0.x, r0y = r0.y, r0z = r0.z, v0x = v0.x, v0y = v0.y, v0z = v0.z;
  const r0m = Math.sqrt(r0x * r0x + r0y * r0y + r0z * r0z);
  const v0m2 = v0x * v0x + v0y * v0y + v0z * v0z;
  const rdotv = r0x * v0x + r0y * v0y + r0z * v0z;
  const sqrtMu = Math.sqrt(mu);
  const alpha = 2 / r0m - v0m2 / mu; // 1/a
  const k = rdotv / sqrtMu;

  // Elliptic orbits are periodic: reduce the interval to less than one period.
  if (alpha > 1e-15) {
    const T = (2 * Math.PI) / (sqrtMu * Math.pow(alpha, 1.5));
    if (Math.abs(dt) > T) dt = dt - T * Math.trunc(dt / T);
    if (dt === 0) { outR.copy(r0); outV.copy(v0); return; }
  }

  // time of flight as a function of the universal anomaly (monotonic: dt/dchi = r / sqrt(mu) > 0)
  let psi = 0, c2 = 0.5, c3 = 1 / 6;
  const tof = (chi: number): number => {
    psi = chi * chi * alpha;
    c2 = stumpffC(psi);
    c3 = stumpffS(psi);
    const chi2 = chi * chi;
    return (chi2 * chi * c3 + k * chi2 * c2 + r0m * chi * (1 - psi * c3)) / sqrtMu;
  };
  const radius = (chi: number): number => {
    psi = chi * chi * alpha;
    c2 = stumpffC(psi);
    c3 = stumpffS(psi);
    return chi * chi * c2 + k * chi * (1 - psi * c3) + r0m * (1 - psi * c2);
  };

  // bracket the root, then safeguarded Newton (bisection whenever a step leaves the bracket)
  const sgn = dt > 0 ? 1 : -1;
  let lo = 0, hi = sgn * Math.max(1, (sqrtMu * Math.abs(dt)) / r0m);
  if (alpha > 1e-15) hi = sgn * Math.min(Math.abs(hi), (2 * Math.PI) / Math.sqrt(alpha));
  for (let i = 0; i < 200 && sgn * (tof(hi) - dt) < 0; i++) { lo = hi; hi *= 2; }
  if (sgn < 0) { const tmp = lo; lo = hi; hi = tmp; }
  let chi = 0.5 * (lo + hi);
  for (let iter = 0; iter < 100; iter++) {
    const f = tof(chi) - dt;
    if (f > 0) hi = chi; else lo = chi;
    const r = radius(chi);
    let next = chi - (f * sqrtMu) / Math.max(1e-9, r);
    if (!(next > lo && next < hi) || !isFinite(next)) next = 0.5 * (lo + hi);
    if (Math.abs(next - chi) < 1e-10 * Math.max(1, Math.abs(chi))) { chi = next; break; }
    chi = next;
  }
  psi = chi * chi * alpha;
  c2 = stumpffC(psi);
  c3 = stumpffS(psi);
  const chi2 = chi * chi;
  const r = chi2 * c2 + k * chi * (1 - psi * c3) + r0m * (1 - psi * c2);
  const f = 1 - chi2 / r0m * c2;
  const g = dt - chi2 * chi / sqrtMu * c3;
  const gdot = 1 - chi2 / r * c2;
  const fdot = sqrtMu / (r * r0m) * chi * (psi * c3 - 1);
  outR.set(f * r0x + g * v0x, f * r0y + g * v0y, f * r0z + g * v0z);
  outV.set(fdot * r0x + gdot * v0x, fdot * r0y + gdot * v0y, fdot * r0z + gdot * v0z);
}

/** Classical description of a conic, derived from a state vector. */
export class Orbit {
  mu = 1;
  epoch = 0;
  r0 = new Vector3();
  v0 = new Vector3();
  // derived
  a = 0; // semi-major axis (negative for hyperbolic)
  e = 0;
  i = 0; // inclination (rad) relative to reference plane (frame XY)
  raan = 0;
  argp = 0;
  nu0 = 0; // true anomaly at epoch
  p = 0; // semi-latus rectum
  h = new Vector3(); // specific angular momentum
  eVec = new Vector3();
  P = new Vector3(); // unit vector to periapsis
  Q = new Vector3(); // in-plane perpendicular (direction of motion at periapsis)
  W = new Vector3(); // orbit normal
  energy = 0;

  setFromState(r: Vector3, v: Vector3, mu: number, epoch: number): this {
    this.mu = mu;
    this.epoch = epoch;
    this.r0.copy(r);
    this.v0.copy(v);
    const rm = r.length();
    const v2 = v.lengthSq();
    this.h.crossVectors(r, v);
    const hm = this.h.length();
    this.energy = v2 / 2 - mu / rm;
    // e vector = ((v^2 - mu/r) r - (r.v) v) / mu
    const rv = r.dot(v);
    this.eVec.copy(r).multiplyScalar(v2 - mu / rm).addScaledVector(v, -rv).multiplyScalar(1 / mu);
    this.e = this.eVec.length();
    this.p = hm * hm / mu;
    this.a = Math.abs(1 - this.e) < 1e-10 ? Infinity : this.p / (1 - this.e * this.e);

    if (hm > 1e-9) this.W.copy(this.h).multiplyScalar(1 / hm);
    else this.W.set(0, 0, 1);
    this.i = Math.acos(Math.max(-1, Math.min(1, this.W.z)));
    // node vector n = z x h
    const nx = -this.h.y, ny = this.h.x;
    const nm = Math.hypot(nx, ny);
    this.raan = nm > 1e-9 * hm ? Math.atan2(ny, nx) : 0;
    if (this.raan < 0) this.raan += Math.PI * 2;

    if (this.e > 1e-9) {
      this.P.copy(this.eVec).multiplyScalar(1 / this.e);
    } else {
      // circular: periapsis defined at the ascending node (or along r if equatorial)
      if (nm > 1e-9 * hm) this.P.set(nx / nm, ny / nm, 0);
      else this.P.copy(r).normalize();
    }
    this.Q.crossVectors(this.W, this.P).normalize();
    // argument of periapsis: angle from node to P in the orbital plane
    if (nm > 1e-9 * hm) {
      const nX = nx / nm, nY = ny / nm;
      const cosw = nX * this.P.x + nY * this.P.y;
      // sin via (n x P) . W
      _t1.set(nX, nY, 0).cross(this.P);
      const sinw = _t1.dot(this.W);
      this.argp = Math.atan2(sinw, cosw);
    } else {
      this.argp = Math.atan2(this.P.y, this.P.x) * (this.W.z >= 0 ? 1 : -1);
    }
    if (this.argp < 0) this.argp += Math.PI * 2;
    // true anomaly at epoch
    this.nu0 = Math.atan2(r.dot(this.Q), r.dot(this.P));
    return this;
  }

  get isHyperbolic(): boolean { return this.e >= 1; }
  get periapsis(): number { return this.p / (1 + this.e); }
  get apoapsis(): number { return this.e < 1 ? this.p / (1 - this.e) : Infinity; }
  get period(): number { return this.e < 1 ? 2 * Math.PI * Math.sqrt(this.a * this.a * this.a / this.mu) : Infinity; }
  get meanMotion(): number { return Math.sqrt(this.mu / Math.abs(this.a * this.a * this.a)); }

  /** Radius at a true anomaly. */
  radiusAt(nu: number): number { return this.p / (1 + this.e * Math.cos(nu)); }

  /** Position (relative to the focus) at true anomaly nu. */
  positionAtTrueAnomaly(nu: number, out: Vector3): Vector3 {
    const r = this.radiusAt(nu);
    const c = Math.cos(nu), s = Math.sin(nu);
    return out.set(
      r * (c * this.P.x + s * this.Q.x),
      r * (c * this.P.y + s * this.Q.y),
      r * (c * this.P.z + s * this.Q.z),
    );
  }

  /** Mean anomaly (or hyperbolic mean anomaly) corresponding to a true anomaly. */
  meanAnomalyFromTrue(nu: number): number {
    const e = this.e;
    if (e < 1) {
      const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
      return E - e * Math.sin(E);
    }
    if (e > 1) {
      const H = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
      return e * Math.sinh(H) - H;
    }
    const D = Math.tan(nu / 2);
    return D + D * D * D / 3;
  }

  /** Time from periapsis passage to true anomaly nu (signed; negative before periapsis). */
  timeFromPeriapsis(nu: number): number {
    if (Math.abs(this.e - 1) < 1e-9) {
      const D = Math.tan(nu / 2);
      return 0.5 * Math.sqrt(this.p * this.p * this.p / this.mu) * (D + D * D * D / 3);
    }
    return this.meanAnomalyFromTrue(nu) / this.meanMotion;
  }

  /** Time (from epoch) until the vessel next reaches true anomaly nu. */
  timeToTrueAnomaly(nu: number): number {
    const t0 = this.timeFromPeriapsis(this.nu0);
    let t1 = this.timeFromPeriapsis(nu);
    let dt = t1 - t0;
    if (this.e < 1) {
      const T = this.period;
      dt = ((dt % T) + T) % T;
    }
    return dt;
  }

  timeToPeriapsis(): number { return this.timeToTrueAnomaly(0); }
  timeToApoapsis(): number { return this.e < 1 ? this.timeToTrueAnomaly(Math.PI) : Infinity; }

  /** True anomaly where the conic reaches radius r on the outbound (ascending) leg, or NaN. */
  trueAnomalyAtRadius(r: number): number {
    if (this.e < 1e-12) return NaN;
    const c = (this.p / r - 1) / this.e;
    if (c < -1 || c > 1) return NaN;
    return Math.acos(c);
  }

  /** State at absolute time t. */
  stateAt(t: number, outR: Vector3, outV: Vector3): void {
    keplerPropagate(this.r0, this.v0, this.mu, t - this.epoch, outR, outV);
  }

  /** Current true anomaly at absolute time t. */
  trueAnomalyAt(t: number): number {
    this.stateAt(t, _t2, _t3);
    return Math.atan2(_t2.dot(this.Q), _t2.dot(this.P));
  }
}

/** Sphere-of-influence radius (Laplace). */
export function soiRadius(aParent: number, mBody: number, mParent: number): number {
  return aParent * Math.pow(mBody / mParent, 2 / 5);
}

/** Solve Kepler's equation M = E - e sin E (elliptic). */
export function solveKeplerElliptic(M: number, e: number): number {
  M = M % (2 * Math.PI);
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 50; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return E;
}

/** Circular orbit speed and escape speed helpers. */
export const circularSpeed = (mu: number, r: number) => Math.sqrt(mu / r);
export const escapeSpeed = (mu: number, r: number) => Math.sqrt(2 * mu / r);

/**
 * Lambert's problem (single revolution, universal variables — Bate, Mueller & White §5.3):
 * the velocity needed at r1 to reach r2 after `tof` seconds, travelling the way round that
 * matches the angular-momentum direction `hDir`. Writes v1 (and v2 at arrival if given).
 * Returns false if no solution exists (degenerate 180° geometry, or tof out of range).
 */
export function lambert(r1: Vector3, r2: Vector3, tof: number, mu: number, hDir: Vector3, v1: Vector3, v2?: Vector3): boolean {
  const r1m = r1.length(), r2m = r2.length();
  if (tof <= 0 || r1m <= 0 || r2m <= 0) return false;
  const cosDnu = Math.max(-1, Math.min(1, r1.dot(r2) / (r1m * r2m)));
  let dnu = Math.acos(cosDnu);
  if (_t1.crossVectors(r1, r2).dot(hDir) < 0) dnu = 2 * Math.PI - dnu;
  const A = Math.sin(dnu) * Math.sqrt((r1m * r2m) / Math.max(1e-12, 1 - cosDnu));
  if (Math.abs(A) < 1e-6) return false;
  const sqrtMu = Math.sqrt(mu);
  const yOf = (z: number) => r1m + r2m + (A * (z * stumpffS(z) - 1)) / Math.sqrt(stumpffC(z));
  const tofOf = (z: number) => {
    const y = yOf(z);
    if (y < 0) return -Infinity;
    const C = stumpffC(z);
    return (Math.pow(y / C, 1.5) * stumpffS(z) + A * Math.sqrt(y)) / sqrtMu;
  };
  // time of flight increases monotonically with z on the single-revolution branch
  let lo = -4 * Math.PI * Math.PI, hi = 4 * Math.PI * Math.PI - 1e-6;
  // expand the lower bound for very short (hyperbolic) transfers
  for (let i = 0; i < 60 && tofOf(lo) > tof; i++) lo *= 2;
  if (!(tofOf(hi) >= tof)) return false;
  let z = 0;
  for (let i = 0; i < 200; i++) {
    z = 0.5 * (lo + hi);
    const t = tofOf(z);
    if (t < tof) lo = z; else hi = z;
    if (hi - lo < 1e-12 * Math.max(1, Math.abs(z))) break;
  }
  const y = yOf(z);
  if (!(y > 0)) return false;
  const f = 1 - y / r1m;
  const g = A * Math.sqrt(y / mu);
  const gdot = 1 - y / r2m;
  if (Math.abs(g) < 1e-12) return false;
  _t2.copy(r2).addScaledVector(r1, -f).multiplyScalar(1 / g);
  if (v2) v2.copy(r2).multiplyScalar(gdot).sub(r1).multiplyScalar(1 / g);
  v1.copy(_t2);
  return true;
}
