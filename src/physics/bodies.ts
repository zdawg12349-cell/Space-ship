import { Quaternion, Vector3 } from 'three';
import { AU, DAY, DEG, G, JULIAN_CENTURY, OBLIQUITY_J2000 } from './constants';
import { keplerPropagate, soiRadius, solveKeplerElliptic } from './orbit';
import { AtmosphereModel, EarthAtmosphere, ExponentialAtmosphere } from './atmosphere';

/**
 * Solar-system bodies in a heliocentric, ecliptic-J2000 inertial frame (metres, seconds).
 *
 * Planet orbits: JPL "Keplerian Elements for Approximate Positions of the Major Planets"
 * (E.M. Standish), Table 1 (valid 1800–2050). Moon: Meeus mean lunar elements.
 * Galilean satellites: Meeus ch. 44 mean longitudes, circular orbits in Jupiter's equator.
 */

export interface KeplerElements {
  a: number; e: number; i: number; L: number; varpi: number; node: number; // deg / AU
  da: number; de: number; di: number; dL: number; dvarpi: number; dnode: number; // per century
}

export interface BodyDef {
  id: string;
  name: string;
  parent: string | null;
  gm: number;
  radius: number; // mean radius, m
  rotationPeriod: number; // sidereal, s (negative = retrograde)
  obliquity: number; // axial tilt relative to the ecliptic, rad (approx)
  poleLongitude?: number; // ecliptic longitude toward which the pole tilts, rad
  primeMeridianAtJ2000?: number; // rad
  elements?: KeplerElements; // heliocentric planets
  circular?: { a: number; L0: number; rate: number; incl?: number }; // L0 deg at J2000, rate deg/day
  atmosphere?: AtmosphereModel;
  hasSurface: boolean;
  /** visual / gameplay */
  color: [number, number, number];
}

const PLANET_ELEMENTS: Record<string, KeplerElements> = {
  mercury: { a: 0.38709927, e: 0.20563593, i: 7.00497902, L: 252.2503235, varpi: 77.45779628, node: 48.33076593, da: 0.00000037, de: 0.00001906, di: -0.00594749, dL: 149472.67411175, dvarpi: 0.16047689, dnode: -0.12534081 },
  venus: { a: 0.72333566, e: 0.00677672, i: 3.39467605, L: 181.9790995, varpi: 131.60246718, node: 76.67984255, da: 0.0000039, de: -0.00004107, di: -0.0007889, dL: 58517.81538729, dvarpi: 0.00268329, dnode: -0.27769418 },
  earth: { a: 1.00000261, e: 0.01671123, i: -0.00001531, L: 100.46457166, varpi: 102.93768193, node: 0.0, da: 0.00000562, de: -0.00004392, di: -0.01294668, dL: 35999.37244981, dvarpi: 0.32327364, dnode: 0.0 },
  mars: { a: 1.52371034, e: 0.0933941, i: 1.84969142, L: -4.55343205, varpi: -23.94362959, node: 49.55953891, da: 0.00001847, de: 0.00007882, di: -0.00813131, dL: 19140.30268499, dvarpi: 0.44441088, dnode: -0.29257343 },
  jupiter: { a: 5.202887, e: 0.04838624, i: 1.30439695, L: 34.39644051, varpi: 14.72847983, node: 100.47390909, da: -0.00011607, de: -0.00013253, di: -0.00183714, dL: 3034.74612775, dvarpi: 0.21252668, dnode: 0.20469106 },
  saturn: { a: 9.53667594, e: 0.05386179, i: 2.48599187, L: 49.95424423, varpi: 92.59887831, node: 113.66242448, da: -0.0012506, de: -0.00050991, di: 0.00193609, dL: 1222.49362201, dvarpi: -0.41897216, dnode: -0.28867794 },
  uranus: { a: 19.18916464, e: 0.04725744, i: 0.77263783, L: 313.23810451, varpi: 170.9542763, node: 74.01692503, da: -0.00196176, de: -0.00004397, di: -0.00242939, dL: 428.48202785, dvarpi: 0.40805281, dnode: 0.04240589 },
  neptune: { a: 30.06992276, e: 0.00859048, i: 1.77004347, L: -55.12002969, varpi: 44.96476227, node: 131.78422574, da: 0.00026291, de: 0.00005105, di: 0.00035372, dL: 218.45945325, dvarpi: -0.32241464, dnode: -0.00508664 },
};

export const BODY_DEFS: BodyDef[] = [
  { id: 'sun', name: 'Sun', parent: null, gm: 1.32712440018e20, radius: 696_340_000, rotationPeriod: 25.38 * DAY, obliquity: 7.25 * DEG, hasSurface: false, color: [1, 0.95, 0.85] },
  { id: 'mercury', name: 'Mercury', parent: 'sun', gm: 2.2032e13, radius: 2_439_700, rotationPeriod: 58.646 * DAY, obliquity: 0.03 * DEG, elements: PLANET_ELEMENTS.mercury, hasSurface: true, color: [0.55, 0.53, 0.5] },
  { id: 'venus', name: 'Venus', parent: 'sun', gm: 3.24859e14, radius: 6_051_800, rotationPeriod: -243.025 * DAY, obliquity: 177.4 * DEG, elements: PLANET_ELEMENTS.venus, atmosphere: new ExponentialAtmosphere(65, 15_900, 250_000, 737, 3.5), hasSurface: true, color: [0.9, 0.82, 0.6] },
  { id: 'earth', name: 'Earth', parent: 'sun', gm: 3.986004418e14, radius: 6_371_000, rotationPeriod: 86164.0905, obliquity: OBLIQUITY_J2000, elements: PLANET_ELEMENTS.earth, atmosphere: EarthAtmosphere, hasSurface: true, color: [0.3, 0.5, 0.9] },
  { id: 'moon', name: 'Moon', parent: 'earth', gm: 4.9048695e12, radius: 1_737_400, rotationPeriod: 27.321661 * DAY, obliquity: 1.54 * DEG, hasSurface: true, color: [0.6, 0.6, 0.6] },
  { id: 'mars', name: 'Mars', parent: 'sun', gm: 4.282837e13, radius: 3_389_500, rotationPeriod: 88642.66, obliquity: 25.19 * DEG, elements: PLANET_ELEMENTS.mars, atmosphere: new ExponentialAtmosphere(0.020, 11_100, 125_000, 210, 2.3), hasSurface: true, color: [0.8, 0.45, 0.25] },
  { id: 'jupiter', name: 'Jupiter', parent: 'sun', gm: 1.26686534e17, radius: 69_911_000, rotationPeriod: 35730, obliquity: 3.13 * DEG, elements: PLANET_ELEMENTS.jupiter, atmosphere: new ExponentialAtmosphere(0.16, 27_000, 1_000_000, 165, 1.2), hasSurface: false, color: [0.85, 0.75, 0.6] },
  { id: 'io', name: 'Io', parent: 'jupiter', gm: 5.959916e12, radius: 1_821_600, rotationPeriod: 1.769137786 * DAY, obliquity: 0, circular: { a: 421_700_000, L0: 106.07719, rate: 203.48895579 }, hasSurface: true, color: [0.9, 0.85, 0.4] },
  { id: 'europa', name: 'Europa', parent: 'jupiter', gm: 3.202739e12, radius: 1_560_800, rotationPeriod: 3.551181 * DAY, obliquity: 0, circular: { a: 671_034_000, L0: 175.73161, rate: 101.374724735 }, hasSurface: true, color: [0.85, 0.8, 0.7] },
  { id: 'ganymede', name: 'Ganymede', parent: 'jupiter', gm: 9.887834e12, radius: 2_634_100, rotationPeriod: 7.15455296 * DAY, obliquity: 0, circular: { a: 1_070_412_000, L0: 120.55883, rate: 50.317609207 }, hasSurface: true, color: [0.6, 0.55, 0.5] },
  { id: 'callisto', name: 'Callisto', parent: 'jupiter', gm: 7.179289e12, radius: 2_410_300, rotationPeriod: 16.6890184 * DAY, obliquity: 0, circular: { a: 1_882_709_000, L0: 84.44459, rate: 21.571071177 }, hasSurface: true, color: [0.4, 0.38, 0.35] },
  { id: 'saturn', name: 'Saturn', parent: 'sun', gm: 3.7931187e16, radius: 58_232_000, rotationPeriod: 38362, obliquity: 26.73 * DEG, poleLongitude: 79.5 * DEG, elements: PLANET_ELEMENTS.saturn, atmosphere: new ExponentialAtmosphere(0.19, 59_500, 1_000_000, 134, 1.2), hasSurface: false, color: [0.9, 0.82, 0.62] },
  { id: 'uranus', name: 'Uranus', parent: 'sun', gm: 5.793939e15, radius: 25_362_000, rotationPeriod: -62064, obliquity: 97.77 * DEG, poleLongitude: 167 * DEG, elements: PLANET_ELEMENTS.uranus, atmosphere: new ExponentialAtmosphere(0.42, 27_700, 500_000, 76, 1.2), hasSurface: false, color: [0.6, 0.85, 0.9] },
  { id: 'neptune', name: 'Neptune', parent: 'sun', gm: 6.836529e15, radius: 24_622_000, rotationPeriod: 57996, obliquity: 28.32 * DEG, poleLongitude: 300 * DEG, elements: PLANET_ELEMENTS.neptune, atmosphere: new ExponentialAtmosphere(0.45, 19_700, 500_000, 72, 1.2), hasSurface: false, color: [0.3, 0.45, 0.95] },
];

const _q = new Quaternion();
const _q2 = new Quaternion();
const _ax = new Vector3();
const _v = new Vector3();
const _w = new Vector3();

export class CelestialBody {
  readonly def: BodyDef;
  readonly id: string;
  readonly name: string;
  readonly gm: number;
  readonly radius: number;
  readonly mass: number;
  parent: CelestialBody | null = null;
  children: CelestialBody[] = [];
  soi = Infinity;
  /** state relative to parent at the reference epoch (Kepler rails) */
  private r0 = new Vector3();
  private v0 = new Vector3();
  private epoch = 0;
  /** orbital semi-major axis about parent (m), for SOI */
  semiMajor = 0;
  /** rotation: body-fixed -> inertial is  tilt * Rz(angle) */
  private tilt = new Quaternion();
  private rotationRate: number;
  private rotationAt0 = 0;
  // per-time cache for global position (frame coherence)
  private cacheT = NaN;
  private cachePos = new Vector3();
  private cacheVel = new Vector3();
  private scratchR = new Vector3();
  private scratchV = new Vector3();

  constructor(def: BodyDef) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.gm = def.gm;
    this.radius = def.radius;
    this.mass = def.gm / G;
    this.rotationRate = (2 * Math.PI) / def.rotationPeriod;
  }

  get atmosphere(): AtmosphereModel | undefined { return this.def.atmosphere; }
  /** practical edge of the atmosphere (m above the reference radius); 0 for airless bodies */
  get atmosphereTop(): number { return this.def.atmosphere ? this.def.atmosphere.edge : 0; }
  /** altitude where density becomes exactly zero in the model */
  get atmosphereCeiling(): number { return this.def.atmosphere ? this.def.atmosphere.top : 0; }

  /** Initialise rails at the given epoch (seconds past J2000). */
  initRails(epoch: number): void {
    this.epoch = epoch;
    const d = this.def;
    const T = epoch / JULIAN_CENTURY;
    if (d.elements) {
      const el = d.elements;
      const a = (el.a + el.da * T) * AU;
      const e = el.e + el.de * T;
      const inc = (el.i + el.di * T) * DEG;
      const L = (el.L + el.dL * T) * DEG;
      const varpi = (el.varpi + el.dvarpi * T) * DEG;
      const node = (el.node + el.dnode * T) * DEG;
      const argp = varpi - node;
      const M = L - varpi;
      stateFromElements(a, e, inc, node, argp, M, this.parent!.gm + this.gm, this.r0, this.v0);
      this.semiMajor = a;
    } else if (d.id === 'moon') {
      // Meeus mean elements of the Moon (ecliptic of date ≈ J2000 here)
      const Lp = 218.3164477 + 481267.88123421 * T;
      const Mp = 134.9633964 + 477198.8675055 * T;
      const F = 93.272095 + 483202.0175233 * T;
      const node = (Lp - F) * DEG;
      const varpi = (Lp - Mp) * DEG;
      const a = 384_748_000;
      const e = 0.0549;
      const inc = 5.145 * DEG;
      stateFromElements(a, e, inc, node, varpi - node, Mp * DEG, this.parent!.gm + this.gm, this.r0, this.v0);
      this.semiMajor = a;
      // Tidal lock: the prime meridian faces Earth on average -> rotation angle = mean longitude + 180
      this.rotationAt0 = (Lp + 180) * DEG;
    } else if (d.circular) {
      const c = d.circular;
      const days = epoch / DAY;
      const L = (c.L0 + c.rate * days) * DEG;
      const mu = this.parent!.gm + this.gm;
      const v = Math.sqrt(mu / c.a);
      // circular orbit in the parent's equatorial plane
      _v.set(Math.cos(L) * c.a, Math.sin(L) * c.a, 0);
      _w.set(-Math.sin(L) * v, Math.cos(L) * v, 0);
      this.parent!.getTilt(_q);
      this.r0.copy(_v).applyQuaternion(_q);
      this.v0.copy(_w).applyQuaternion(_q);
      this.semiMajor = c.a;
      this.rotationAt0 = L + Math.PI; // tidally locked
    }

    // Axial tilt: rotate the +Z pole by the obliquity toward ecliptic longitude (poleLongitude - 90°)
    if (d.id === 'earth') {
      // body-fixed (ECEF) -> ecliptic: Rx(-eps); Rz(GMST) applied separately
      this.tilt.setFromAxisAngle(_ax.set(1, 0, 0), -OBLIQUITY_J2000);
      // GMST at epoch (IAU 1982, simplified)
      const days = epoch / DAY;
      this.rotationAt0 = (280.46061837 + 360.98564736629 * days) * DEG;
    } else if (d.id !== 'moon' && !d.circular) {
      const pl = d.poleLongitude ?? 0;
      _ax.set(Math.cos(pl - Math.PI / 2), Math.sin(pl - Math.PI / 2), 0);
      this.tilt.setFromAxisAngle(_ax, d.obliquity);
      this.rotationAt0 = (d.primeMeridianAtJ2000 ?? 0) + this.rotationRate * epoch;
    } else if (d.id === 'moon') {
      this.tilt.setFromAxisAngle(_ax.set(1, 0, 0), d.obliquity);
    }
    if (this.parent) {
      this.soi = soiRadius(this.semiMajor, this.mass, this.parent.mass);
    }
    this.cacheT = NaN;
  }

  getTilt(out: Quaternion): Quaternion { return out.copy(this.tilt); }

  /** Body-fixed -> inertial rotation at time t. */
  orientationAt(t: number, out: Quaternion): Quaternion {
    const ang = this.rotationAt0 + this.rotationRate * (t - this.epoch);
    _q2.setFromAxisAngle(_ax.set(0, 0, 1), ang);
    return out.copy(this.tilt).multiply(_q2);
  }

  rotationAngleAt(t: number): number { return this.rotationAt0 + this.rotationRate * (t - this.epoch); }

  /** Angular velocity vector (inertial frame), rad/s. */
  angularVelocity(out: Vector3): Vector3 {
    return out.set(0, 0, this.rotationRate).applyQuaternion(this.tilt);
  }

  /** Spin axis (north pole) unit vector in inertial frame. */
  poleAxis(out: Vector3): Vector3 { return out.set(0, 0, 1).applyQuaternion(this.tilt); }

  /** State relative to parent at absolute time t. */
  localStateAt(t: number, outR: Vector3, outV: Vector3): void {
    if (!this.parent) { outR.set(0, 0, 0); outV.set(0, 0, 0); return; }
    keplerPropagate(this.r0, this.v0, this.parent.gm + this.gm, t - this.epoch, outR, outV);
  }

  /** Heliocentric (global) position at time t. */
  globalPositionAt(t: number, out: Vector3): Vector3 {
    if (!this.parent) return out.set(0, 0, 0);
    if (t === this.cacheT) return out.copy(this.cachePos);
    const pr = this.scratchR, pv = this.scratchV;
    this.parent.globalStateAt(t, pr, pv);
    this.localStateAt(t, this.cachePos, this.cacheVel);
    this.cachePos.add(pr);
    this.cacheVel.add(pv);
    this.cacheT = t;
    return out.copy(this.cachePos);
  }

  globalStateAt(t: number, outR: Vector3, outV: Vector3): void {
    if (!this.parent) { outR.set(0, 0, 0); outV.set(0, 0, 0); return; }
    if (t !== this.cacheT) this.globalPositionAt(t, _v);
    outR.copy(this.cachePos);
    outV.copy(this.cacheVel);
  }

  /** Convert latitude/longitude/altitude to a body-fixed position. */
  static llaToFixed(lat: number, lon: number, radius: number, out: Vector3): Vector3 {
    const cl = Math.cos(lat);
    return out.set(cl * Math.cos(lon) * radius, cl * Math.sin(lon) * radius, Math.sin(lat) * radius);
  }
}

/** Classical elements -> state (relative to focus), angles in radians. */
export function stateFromElements(a: number, e: number, i: number, node: number, argp: number, M: number, mu: number, outR: Vector3, outV: Vector3): void {
  const E = solveKeplerElliptic(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), e);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const xp = a * (cosE - e);
  const yp = a * Math.sqrt(1 - e * e) * sinE;
  const r = a * (1 - e * cosE);
  const n = Math.sqrt(mu / (a * a * a));
  const vxp = -a * n * sinE * a / r;
  const vyp = a * n * Math.sqrt(1 - e * e) * cosE * a / r;
  const cO = Math.cos(node), sO = Math.sin(node), cw = Math.cos(argp), sw = Math.sin(argp), ci = Math.cos(i), si = Math.sin(i);
  const r11 = cO * cw - sO * sw * ci, r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci, r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si, r32 = cw * si;
  outR.set(r11 * xp + r12 * yp, r21 * xp + r22 * yp, r31 * xp + r32 * yp);
  outV.set(r11 * vxp + r12 * vyp, r21 * vxp + r22 * vyp, r31 * vxp + r32 * vyp);
}

export class SolarSystem {
  readonly bodies: CelestialBody[] = [];
  readonly byId = new Map<string, CelestialBody>();
  readonly sun: CelestialBody;
  readonly earth: CelestialBody;
  readonly moon: CelestialBody;
  epoch = 0;

  constructor(epoch: number) {
    for (const d of BODY_DEFS) {
      const b = new CelestialBody(d);
      this.bodies.push(b);
      this.byId.set(d.id, b);
    }
    for (const b of this.bodies) {
      if (b.def.parent) {
        b.parent = this.byId.get(b.def.parent)!;
        b.parent.children.push(b);
      }
    }
    this.sun = this.byId.get('sun')!;
    this.earth = this.byId.get('earth')!;
    this.moon = this.byId.get('moon')!;
    this.setEpoch(epoch);
  }

  setEpoch(epoch: number): void {
    this.epoch = epoch;
    // parents first (galilean moons need Jupiter's tilt)
    const order = [...this.bodies].sort((a, b) => depth(a) - depth(b));
    for (const b of order) b.initRails(epoch);
  }

  get(id: string): CelestialBody { return this.byId.get(id)!; }
}

function depth(b: CelestialBody): number {
  let d = 0;
  let p = b.parent;
  while (p) { d++; p = p.parent; }
  return d;
}
