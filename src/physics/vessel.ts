import { Quaternion, Vector3 } from 'three';
import type { AssemblyDef, EngineMount, StageEvent, VehicleDef } from '../vehicles/types';
import { AtmosphereSample, newAtmosphereSample } from './atmosphere';
import { AeroConfig, buildAeroConfig, cd0ForShape, convectiveHeating, machDragFactor, radiativeHeating } from './aero';
import type { CelestialBody } from './bodies';
import { G0, STEFAN_BOLTZMANN } from './constants';
import { Orbit } from './orbit';

// ---------------------------------------------------------------------------------------------
// Runtime components
// ---------------------------------------------------------------------------------------------

export class EngineRuntime {
  readonly mount: EngineMount;
  readonly assembly: AssemblyRuntime;
  readonly index: number;
  armed = false; // ignition commanded
  spool = 0; // 0..1 thrust build-up
  running = false;
  failed = false;
  restartsLeft: number;
  gimbalX = 0; // rad, deflection producing +X lateral force component
  gimbalZ = 0;
  thrust = 0; // N, current
  mdot = 0; // kg/s, current
  throttle = 0; // effective throttle 0..1
  ignitionAge = 0; // s since last ignition
  shutdownAge = 999; // s since shutdown
  temperature = 300; // nozzle temperature (K) for glow visuals
  /** solid motors: fraction of propellant burned */
  srbBurned = 0;
  /** flight-software throttle ceiling (heavy centre cores) */
  throttleScale = 1;
  lastFailReason = '';

  constructor(mount: EngineMount, assembly: AssemblyRuntime, index: number) {
    this.mount = mount;
    this.assembly = assembly;
    this.index = index;
    this.restartsLeft = mount.spec.restarts;
  }

  get isSolid(): boolean { return this.mount.spec.propellant === 'solid'; }
}

export class AssemblyRuntime {
  readonly def: AssemblyDef;
  readonly engines: EngineRuntime[] = [];
  propellant: number; // kg remaining
  readonly propellantCapacity: number;
  dryMass: number;
  rcsFuel = 0;
  // deployables
  legsDeployed = 0; // 0..1 animation
  legsTarget = 0;
  gridFinsDeployed = 0;
  gridFinsTarget = 0;
  solarDeployed = 0;
  solarTarget = 0;
  chuteState: 'stowed' | 'drogue' | 'main' | 'cut' | 'failed' = 'stowed';
  drogueInflation = 0;
  mainInflation = 0;
  chuteTime = 0;
  // thermal
  skinTemp = 290;
  shieldTemp = 290;
  ablator = 0;
  heatShieldFailed = false;
  overheatTime = 0;
  fairingOpen = 0;
  destroyed = false;
  retroFired = false;

  constructor(def: AssemblyDef) {
    this.def = def;
    let cap = 0;
    let dry = def.extraMass ?? 0;
    for (const s of def.sections) {
      cap += s.propellant ?? 0;
      dry += s.mass;
    }
    this.propellantCapacity = cap;
    this.propellant = cap;
    this.dryMass = dry;
    def.engines.forEach((m, i) => this.engines.push(new EngineRuntime(m, this, i)));
    if (def.features?.heatShield) this.ablator = def.features.heatShield.ablatorMass;
    if (def.features?.rcs) this.rcsFuel = 150;
  }

  get id(): string { return this.def.id; }
  get offX(): number { return this.def.offset ? this.def.offset[0] : 0; }
  get offZ(): number { return this.def.offset ? this.def.offset[1] : 0; }
  get mass(): number { return this.dryMass + this.propellant + this.ablator + this.rcsFuel; }
  get fuelFraction(): number { return this.propellantCapacity > 0 ? this.propellant / this.propellantCapacity : 0; }
  get bottomY(): number {
    let b = Infinity;
    for (const s of this.def.sections) b = Math.min(b, s.y);
    for (const e of this.def.engines) b = Math.min(b, e.pos[1] - e.spec.nozzleLength);
    return b;
  }
  get topY(): number {
    let t = -Infinity;
    for (const s of this.def.sections) t = Math.max(t, s.y + s.length);
    return t;
  }
  get maxRadius(): number {
    let r = 0;
    for (const s of this.def.sections) r = Math.max(r, s.radius, s.topRadius ?? 0);
    return r;
  }
}

export interface VesselControls {
  throttle: number; // 0..1
  pitch: number; // -1..1
  yaw: number;
  roll: number;
  tx: number; // RCS translation
  ty: number;
  tz: number;
  rcs: boolean;
  /** engines currently allowed to fire (null => all armed engines) */
  engineMask: Set<EngineRuntime> | null;
}

export interface TerrainProvider {
  /** height of the surface above the reference radius (m). dir is a unit vector in body-fixed frame */
  heightAt(body: CelestialBody, dirFixed: Vector3): number;
  isWater(body: CelestialBody, dirFixed: Vector3): boolean;
}

export interface WeatherProvider {
  /** wind velocity in local ENU (m/s) */
  windAt(body: CelestialBody, lat: number, lon: number, alt: number, t: number, out: Vector3): Vector3;
  /** turbulence intensity 0..1 at altitude */
  turbulence(alt: number): number;
}

export interface PhysicsEnv {
  t: number;
  terrain: TerrainProvider;
  weather: WeatherProvider;
  /** fixed launch support (pad deck) */
}

export type VesselEvent =
  | { type: 'engine_ignite'; engine: EngineRuntime }
  | { type: 'engine_shutdown'; engine: EngineRuntime; reason: string }
  | { type: 'engine_flameout'; engine: EngineRuntime }
  | { type: 'engine_fail'; engine: EngineRuntime; reason: string }
  | { type: 'separation'; assemblies: AssemblyRuntime[]; kind: string }
  | { type: 'clamps_release' }
  | { type: 'liftoff' }
  | { type: 'chutes'; stage: 'drogue' | 'main' | 'failed' | 'cut'; reason?: string }
  | { type: 'legs' }
  | { type: 'gridfins' }
  | { type: 'solar' }
  | { type: 'touchdown'; speed: number; water: boolean }
  | { type: 'destroyed'; reason: string }
  | { type: 'heatshield_fail' }
  | { type: 'soi_change'; from: CelestialBody; to: CelestialBody }
  | { type: 'stage'; index: number; events: StageEvent[] }
  | { type: 'retro_fire' }
  | { type: 'les_fire' };

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _tb = new Vector3();
const _up = new Vector3();
const _east = new Vector3();
const _north = new Vector3();
const _fixed = new Vector3();

let VESSEL_ID = 1;

export interface Telemetry {
  altitude: number; // above reference radius (sea level)
  radarAltitude: number; // above terrain/ocean
  terrainHeight: number;
  speedOrbital: number;
  speedSurface: number;
  verticalSpeed: number;
  horizontalSpeed: number;
  mach: number;
  dynamicPressure: number; // Pa
  density: number;
  pressure: number;
  temperatureAir: number;
  gForce: number;
  axialG: number;
  heading: number; // deg
  pitch: number; // deg (above horizon)
  roll: number; // deg
  aoa: number; // deg
  heatFlux: number; // W/m^2
  latitude: number;
  longitude: number;
  thrust: number;
  twr: number;
  massTotal: number;
  inAtmosphere: boolean;
  airVelocity: Vector3; // inertial-frame air-relative velocity of the vessel
  qAlpha: number; // Pa*deg
  maxQ: number;
  downrange: number;
}

export class Vessel {
  readonly id = VESSEL_ID++;
  name: string;
  def: VehicleDef | null;
  assemblies: AssemblyRuntime[];
  /** parent links (child -> parent) among attached assemblies */
  parentOf = new Map<AssemblyRuntime, AssemblyRuntime | null>();
  body: CelestialBody;
  pos = new Vector3(); // CoM relative to body centre, inertial axes
  vel = new Vector3();
  rot = new Quaternion(); // vehicle frame -> inertial
  angVel = new Vector3(); // vehicle frame, rad/s
  mass = 1;
  com = new Vector3(); // vehicle frame
  inertia = new Vector3(1, 1, 1); // principal approx (Ixx, Iyy, Izz)
  aero!: AeroConfig;
  controls: VesselControls = { throttle: 0, pitch: 0, yaw: 0, roll: 0, tx: 0, ty: 0, tz: 0, rcs: false, engineMask: null };
  stageIndex = 0;
  staging: StageEvent[][] = [];
  isDebris = false;
  destroyed = false;
  destroyReason = '';
  clamped = false;
  landed = false;
  splashed = false;
  landedFixedPos = new Vector3();
  landedFixedRot = new Quaternion();
  padSupportAlt = NaN; // altitude of launch-mount deck while near the pad
  padSupportCenter = new Vector3(); // body-fixed
  hasLiftedOff = false;
  timeSinceSeparation = 0;
  missionTime = 0;
  events: VesselEvent[] = [];
  /** aggregated per-step values */
  telemetry: Telemetry;
  orbit = new Orbit();
  orbitDirty = true;
  atm: AtmosphereSample = newAtmosphereSample();
  /** non-gravitational acceleration (inertial), for g-force and camera shake */
  properAccel = new Vector3();
  heatFluxShield = 0;
  plasmaIntensity = 0;
  vibration = 0; // 0..1 structural vibration for camera/audio
  contactForce = 0;
  lastImpactSpeed = 0;
  guidance: { update(v: Vessel, dt: number, env: PhysicsEnv): void } | null = null;
  /** propellant "settling" / tumble damping for debris */
  tumble = 0;
  launchSiteFixed = new Vector3();
  breakupPending = false;
  private _force = new Vector3();
  private _torque = new Vector3();
  private _vSurf = new Vector3();
  private _wind = new Vector3();
  private _qInv = new Quaternion();

  constructor(name: string, def: VehicleDef | null, assemblies: AssemblyDef[] | AssemblyRuntime[], body: CelestialBody) {
    this.name = name;
    this.def = def;
    this.body = body;
    if (assemblies.length && assemblies[0] instanceof AssemblyRuntime) {
      this.assemblies = assemblies as AssemblyRuntime[];
    } else {
      this.assemblies = (assemblies as AssemblyDef[]).map((a) => new AssemblyRuntime(a));
    }
    this.relink();
    this.telemetry = {
      altitude: 0, radarAltitude: 0, terrainHeight: 0, speedOrbital: 0, speedSurface: 0, verticalSpeed: 0, horizontalSpeed: 0, mach: 0,
      dynamicPressure: 0, density: 0, pressure: 0, temperatureAir: 288, gForce: 0, axialG: 0, heading: 0, pitch: 90, roll: 0, aoa: 0, heatFlux: 0,
      latitude: 0, longitude: 0, thrust: 0, twr: 0, massTotal: 0, inAtmosphere: true, airVelocity: new Vector3(), qAlpha: 0, maxQ: 0, downrange: 0,
    };
    if (def) this.staging = def.staging.map((g) => g.slice());
    this.rebuild();
  }

  relink(): void {
    this.parentOf.clear();
    const ids = new Map(this.assemblies.map((a) => [a.id, a] as const));
    for (const a of this.assemblies) {
      const p = a.def.parent ? ids.get(a.def.parent) ?? null : null;
      this.parentOf.set(a, p);
    }
  }

  get rootAssembly(): AssemblyRuntime {
    for (const a of this.assemblies) if (!this.parentOf.get(a)) return a;
    return this.assemblies[0];
  }

  get engines(): EngineRuntime[] {
    const out: EngineRuntime[] = [];
    for (const a of this.assemblies) for (const e of a.engines) out.push(e);
    return out;
  }

  get activeEngines(): EngineRuntime[] { return this.engines.filter((e) => e.armed && !e.failed); }

  getAssembly(id: string): AssemblyRuntime | undefined { return this.assemblies.find((a) => a.id === id); }

  hasFeature<K extends keyof NonNullable<AssemblyDef['features']>>(k: K): AssemblyRuntime | undefined {
    return this.assemblies.find((a) => a.def.features && a.def.features[k] !== undefined);
  }

  /** Recompute aero configuration (call when the set of attached assemblies changes). */
  rebuild(): void {
    const sections: { s: import('../vehicles/types').SectionDef; offX: number; offZ: number }[] = [];
    const fins: { y: number; area: number; grid: boolean; offX: number; offZ: number }[] = [];
    let heatShieldBottom = false;
    let lowest = Infinity;
    for (const a of this.assemblies) {
      for (const s of a.def.sections) {
        // fairings that have opened no longer contribute
        sections.push({ s, offX: a.offX, offZ: a.offZ });
      }
      if (a.def.features?.finArea) fins.push({ y: a.bottomY + 1.5, area: a.def.features.finArea, grid: false, offX: a.offX, offZ: a.offZ });
      if (a.def.features?.gridFins && a.gridFinsDeployed > 0.5) fins.push({ y: a.def.features.gridFins.y, area: a.def.features.gridFins.size * a.def.features.gridFins.size * 4, grid: true, offX: a.offX, offZ: a.offZ });
      const by = a.bottomY;
      if (by < lowest) {
        lowest = by;
        heatShieldBottom = !!a.def.features?.heatShield;
      }
    }
    this.aero = buildAeroConfig(sections, fins, heatShieldBottom);
    this.updateMassProperties();
  }

  updateMassProperties(): void {
    let m = 0;
    let cx = 0, cy = 0, cz = 0;
    // mass elements: [mass, x, y, z, radius, length]
    const els: number[][] = [];
    for (const a of this.assemblies) {
      const ox = a.offX, oz = a.offZ;
      let tankLen = 0, tankY0 = 0, tankR = 0, tankFound = false;
      for (const s of a.def.sections) {
        els.push([s.mass, ox, s.y + s.length * 0.5, oz, s.radius, s.length]);
        if (s.propellant) {
          if (!tankFound) { tankY0 = s.y; tankFound = true; }
          tankLen = s.y + s.length - tankY0;
          tankR = Math.max(tankR, s.radius);
        }
      }
      if (a.def.extraMass) els.push([a.def.extraMass, ox, a.bottomY + 1.0, oz, a.maxRadius * 0.7, 2]);
      if (a.propellant > 0 && tankFound) {
        const fill = Math.max(0.02, a.fuelFraction) * tankLen;
        els.push([a.propellant, ox, tankY0 + fill * 0.5, oz, tankR * 0.95, fill]);
      }
      if (a.ablator > 0) els.push([a.ablator, ox, a.bottomY + 0.2, oz, a.maxRadius, 0.3]);
      if (a.rcsFuel > 0) els.push([a.rcsFuel, ox, (a.bottomY + a.topY) * 0.5, oz, a.maxRadius * 0.5, 1]);
    }
    for (const e of els) {
      m += e[0];
      cx += e[0] * e[1];
      cy += e[0] * e[2];
      cz += e[0] * e[3];
    }
    m = Math.max(m, 1);
    const newCom = _v1.set(cx / m, cy / m, cz / m);
    // keep the vehicle origin fixed in space when the CoM shifts
    if (this.mass > 1) {
      _v2.copy(newCom).sub(this.com).applyQuaternion(this.rot);
      this.pos.add(_v2);
    }
    this.com.copy(newCom);
    this.mass = m;
    let ixx = 0, iyy = 0, izz = 0;
    for (const e of els) {
      const [mm, x, y, z, r, l] = e;
      const dx = x - this.com.x, dy = y - this.com.y, dz = z - this.com.z;
      const iAxial = 0.5 * mm * r * r;
      const iTrans = (mm * (3 * r * r + l * l)) / 12;
      ixx += iTrans + mm * (dy * dy + dz * dz);
      iyy += iAxial + mm * (dx * dx + dz * dz);
      izz += iTrans + mm * (dx * dx + dy * dy);
    }
    this.inertia.set(Math.max(ixx, 1), Math.max(iyy, 1), Math.max(izz, 1));
  }

  /** World (inertial, body-relative) position of a vehicle-frame point. */
  pointToInertial(local: Vector3, out: Vector3): Vector3 {
    return out.copy(local).sub(this.com).applyQuaternion(this.rot).add(this.pos);
  }

  /** Inertial position of the vehicle-frame origin (base of first stage). */
  originInertial(out: Vector3): Vector3 {
    return out.copy(this.com).negate().applyQuaternion(this.rot).add(this.pos);
  }

  /** Local up (radial) unit vector. */
  upVector(out: Vector3): Vector3 { return out.copy(this.pos).normalize(); }

  /** Nose direction (vehicle +Y) in inertial frame. */
  noseVector(out: Vector3): Vector3 { return out.set(0, 1, 0).applyQuaternion(this.rot); }

  surfaceVelocity(out: Vector3): Vector3 {
    this.body.angularVelocity(_v4);
    return out.crossVectors(_v4, this.pos).negate().add(this.vel);
  }

  /** Body-fixed direction of the vessel at time t. */
  fixedDirection(t: number, out: Vector3): Vector3 {
    this.body.orientationAt(t, _q1);
    return out.copy(this.pos).applyQuaternion(_q1.invert()).normalize();
  }

  computeLatLon(t: number): { lat: number; lon: number } {
    this.fixedDirection(t, _fixed);
    return { lat: Math.asin(Math.max(-1, Math.min(1, _fixed.z))), lon: Math.atan2(_fixed.y, _fixed.x) };
  }

  /** ENU basis at the vessel position (inertial frame). */
  enuBasis(east: Vector3, north: Vector3, up: Vector3): void {
    up.copy(this.pos).normalize();
    this.body.poleAxis(north);
    north.addScaledVector(up, -north.dot(up));
    if (north.lengthSq() < 1e-12) north.set(1, 0, 0).addScaledVector(up, -up.x);
    north.normalize();
    east.crossVectors(north, up).normalize();
  }

  updateOrbit(t: number): Orbit {
    if (this.orbitDirty || this.orbit.epoch !== t) {
      this.orbit.setFromState(this.pos, this.vel, this.body.gm, t);
      this.orbitDirty = false;
    }
    return this.orbit;
  }

  // -----------------------------------------------------------------------------------------
  // Staging
  // -----------------------------------------------------------------------------------------

  /** Descendants (children subtree) of an assembly. */
  subtree(root: AssemblyRuntime): AssemblyRuntime[] {
    const out = [root];
    for (let i = 0; i < out.length; i++) {
      for (const a of this.assemblies) if (this.parentOf.get(a) === out[i] && !out.includes(a)) out.push(a);
    }
    return out;
  }

  get nextStage(): StageEvent[] | null { return this.stageIndex < this.staging.length ? this.staging[this.stageIndex] : null; }

  /**
   * Detach assemblies (and everything attached above them that is not on the root path).
   * Returns the lists of runtimes that left, each forming a new body.
   */
  detach(ids: string[]): AssemblyRuntime[][] {
    const groups: AssemblyRuntime[][] = [];
    for (const id of ids) {
      const a = this.getAssembly(id);
      if (!a) continue;
      // If the detached assembly is the root (e.g. the first stage below everything), the *rest*
      // stays with the player: re-root on its child that leads to the spacecraft.
      const root = this.rootAssembly;
      let group: AssemblyRuntime[];
      if (a === root) {
        group = [a];
        // children of root become new roots
        for (const c of this.assemblies) if (this.parentOf.get(c) === a) this.parentOf.set(c, null);
      } else {
        group = this.subtree(a);
      }
      this.assemblies = this.assemblies.filter((x) => !group.includes(x));
      for (const g of group) this.parentOf.delete(g);
      // If removing the root left several independent roots, the player keeps the one carrying
      // the spacecraft (or the tallest stack); the others leave together with the detached part.
      const roots = this.assemblies.filter((x) => !this.parentOf.get(x));
      if (roots.length > 1) {
        const scId = this.def?.spacecraft;
        const score = (r: AssemblyRuntime) => {
          const sub = this.subtree(r);
          if (scId && sub.some((x) => x.id === scId)) return 1e9;
          return Math.max(...sub.map((x) => x.topY)) - Math.hypot(r.offX, r.offZ) * 100;
        };
        roots.sort((a2, b2) => score(b2) - score(a2));
        for (const r of roots.slice(1)) {
          const sub = this.subtree(r);
          this.assemblies = this.assemblies.filter((x) => !sub.includes(x));
          for (const x of sub) this.parentOf.delete(x);
          group.push(...sub);
        }
      }
      groups.push(group);
    }
    // collapse: if multiple roots remain, keep the one containing the spacecraft / most mass
    this.rebuild();
    return groups;
  }

  // -----------------------------------------------------------------------------------------
  // Physics step
  // -----------------------------------------------------------------------------------------

  /** Integrate one fixed physics step. */
  step(dt: number, env: PhysicsEnv): void {
    if (this.destroyed) return;
    this.missionTime += dt;
    this.timeSinceSeparation += dt;
    const t = env.t;
    const body = this.body;

    if (this.guidance) this.guidance.update(this, dt, env);

    // ---------------- environment
    const r = this.pos.length();
    const altitude = r - body.radius;
    this.enuBasis(_east, _north, _up);
    body.orientationAt(t, this._qInv).invert();
    _fixed.copy(this.pos).applyQuaternion(this._qInv).normalize();
    const lat = Math.asin(Math.max(-1, Math.min(1, _fixed.z)));
    const lon = Math.atan2(_fixed.y, _fixed.x);
    const terrainH = body.def.hasSurface ? env.terrain.heightAt(body, _fixed) : -1e9;
    const overWater = body.def.hasSurface ? env.terrain.isWater(body, _fixed) : false;
    const surfaceH = overWater ? Math.max(terrainH, 0) : terrainH;
    const atmModel = body.atmosphere;
    if (atmModel) atmModel.sample(altitude, this.atm);
    else { this.atm.density = 0; this.atm.pressure = 0; this.atm.temperature = 3; this.atm.speedOfSound = 300; }
    const rho = this.atm.density;
    const pAmb = this.atm.pressure;
    const p0 = atmModel ? atmModel.surfacePressure : 101325;

    // air-relative velocity
    const vSurf = this.surfaceVelocity(this._vSurf);
    const wind = this._wind.set(0, 0, 0);
    if (rho > 1e-9) {
      env.weather.windAt(body, lat, lon, altitude, t, _v3);
      wind.copy(_east).multiplyScalar(_v3.x).addScaledVector(_north, _v3.y).addScaledVector(_up, _v3.z);
    }
    const vAir = this.telemetry.airVelocity.copy(vSurf).sub(wind);
    const airspeed = vAir.length();
    const q = 0.5 * rho * airspeed * airspeed;
    const mach = airspeed / Math.max(1, this.atm.speedOfSound);

    // ---------------- landed / clamped kinematics
    if (this.clamped || this.landed) {
      this.stepEngines(dt, pAmb, p0);
      this.updateMassProperties();
      const thrustUp = this.totalThrustVector(_v3).dot(_up);
      const weight = this.mass * (body.gm / (r * r));
      this.contactForce = weight;
      // stay attached to the rotating body
      body.orientationAt(t + dt, _q1);
      this.pos.copy(this.landedFixedPos).applyQuaternion(_q1);
      this.rot.copy(_q1).multiply(this.landedFixedRot);
      body.angularVelocity(_v4);
      this.vel.crossVectors(_v4, this.pos);
      this.angVel.set(0, 0, 0);
      this.properAccel.copy(_up).multiplyScalar(body.gm / (r * r));
      this.fillTelemetry(t, altitude, terrainH, overWater, lat, lon, q, mach, 0, 0);
      if (!this.clamped && this.landed && thrustUp > weight * 1.02) {
        this.landed = false;
        this.splashed = false;
      }
      return;
    }

    // ---------------- engines & propellant
    this.stepEngines(dt, pAmb, p0);
    this.updateMassProperties();

    const force = this._force.set(0, 0, 0); // inertial, non-gravitational
    const torque = this._torque.set(0, 0, 0); // vehicle frame

    // thrust
    this.applyThrust(force, torque, dt);

    // ---------------- aerodynamics
    let aoaDeg = 0;
    let heatFlux = 0;
    if (q > 0.01) {
      aoaDeg = this.applyAero(vAir, airspeed, rho, q, mach, force, torque);
      // aero damping
      const L = this.aero.refLength;
      const damp = 0.5 * rho * airspeed * this.aero.refArea * L * L * 0.08;
      torque.x -= this.angVel.x * damp;
      torque.z -= this.angVel.z * damp;
      torque.y -= this.angVel.y * damp * 0.02;
      // turbulence buffeting
      const turb = env.weather.turbulence(altitude);
      if (turb > 0) {
        // gusts: smooth pseudo-random signals of time (deterministic, no per-step white noise)
        const s = q * this.aero.refArea * 0.02 * turb;
        const tt = env.t + this.id * 13.7;
        const n1 = Math.sin(tt * 1.7) * Math.sin(tt * 0.61 + 1.3), n2 = Math.sin(tt * 1.31 + 0.7) * Math.sin(tt * 0.47);
        const n3 = Math.sin(tt * 2.3 + 2.1) * Math.sin(tt * 0.83), n4 = Math.sin(tt * 1.9 + 0.4) * Math.sin(tt * 0.37 + 2.2);
        torque.x += n1 * 0.5 * s * L * 0.05;
        torque.z += n2 * 0.5 * s * L * 0.05;
        force.addScaledVector(_east, n3 * 0.5 * s * 0.5).addScaledVector(_north, n4 * 0.5 * s * 0.5);
      }
    }
    // heating (convective + radiative), leading end
    {
      const v = airspeed;
      const noseFirst = this.noseVector(_v2).dot(vAir) > 0;
      const rn = noseFirst ? this.aero.noseRadiusTop : this.aero.noseRadiusBottom;
      heatFlux = rho > 0 ? convectiveHeating(rho, v, rn) + (body.id === 'earth' ? radiativeHeating(rho, v, rn) : 0) : 0;
      this.stepThermal(dt, heatFlux, noseFirst, vAir, airspeed);
    }

    // ---------------- parachutes
    this.stepParachutes(dt, rho, airspeed, q, vAir, force);

    // ---------------- control torques (RCS / wheels / aero surfaces)
    this.applyControlTorques(q, torque, force);

    // ---------------- auxiliary solid motors (escape tower, soft-landing retros)
    this.applyAuxThrust(dt, altitude - surfaceH, vSurf, force);

    // ---------------- ground contact
    let contact = 0;
    if (body.def.hasSurface && altitude - surfaceH < this.aero.refLength + 200) {
      contact = this.applyContact(dt, t, surfaceH, overWater, force, torque, vSurf);
    } else if (!isNaN(this.padSupportAlt)) {
      // far from ground: drop pad support
    }
    this.contactForce = contact;

    // ---------------- integrate (semi-implicit Euler)
    const gAcc = body.gm / (r * r);
    this.properAccel.copy(force).multiplyScalar(1 / this.mass);
    // gravity
    this.vel.addScaledVector(this.pos, (-gAcc / r) * dt);
    this.vel.addScaledVector(this.properAccel, dt);
    this.pos.addScaledVector(this.vel, dt);

    // rotation: Euler's equations with diagonal inertia
    const I = this.inertia;
    const w = this.angVel;
    const ax = (torque.x - (I.z - I.y) * w.y * w.z) / I.x;
    const ay = (torque.y - (I.x - I.z) * w.z * w.x) / I.y;
    const az = (torque.z - (I.y - I.x) * w.x * w.y) / I.z;
    w.x += ax * dt;
    w.y += ay * dt;
    w.z += az * dt;
    // clamp absurd spin rates (numerical safety)
    const wl = w.length();
    if (wl > 20) w.multiplyScalar(20 / wl);
    _q1.set(w.x * 0.5 * dt, w.y * 0.5 * dt, w.z * 0.5 * dt, 0);
    _q1.premultiply(this.rot);
    this.rot.x += _q1.x;
    this.rot.y += _q1.y;
    this.rot.z += _q1.z;
    this.rot.w += _q1.w;
    // q_dot = 0.5 * q * w  (w as pure quaternion in body frame)
    this.rot.normalize();
    this.orbitDirty = true;

    // structural vibration estimate (for camera/audio)
    const thrustNow = this.telemetry.thrust;
    const vib = Math.min(1, (thrustNow / Math.max(1, this.mass * G0)) * 0.08 + q / 40000 * 0.6 + heatFlux / 3e6 * 0.5 + (mach > 0.85 && mach < 1.3 ? q / 30000 * 0.4 : 0));
    this.vibration += (vib - this.vibration) * Math.min(1, dt * 5);

    this.fillTelemetry(t, altitude, terrainH, overWater, lat, lon, q, mach, aoaDeg, heatFlux);
    this.checkStructural(q, aoaDeg, dt);
  }

  // ---------------------------------------------------------------- engines

  private stepEngines(dt: number, pAmb: number, p0: number): void {
    const ctl = this.controls;
    for (const a of this.assemblies) {
      for (const e of a.engines) {
        const spec = e.mount.spec;
        e.shutdownAge += dt;
        if (!e.armed || e.failed) {
          e.spool = Math.max(0, e.spool - dt / 0.6);
          e.thrust = 0; e.mdot = 0; e.running = false;
          e.temperature += (300 - e.temperature) * Math.min(1, dt * 0.05);
          continue;
        }
        const allowed = !ctl.engineMask || ctl.engineMask.has(e);
        let throttle: number;
        if (e.isSolid) throttle = 1;
        else throttle = allowed ? ctl.throttle : 0;
        if (!e.isSolid && throttle > 0) throttle = Math.min(throttle, e.throttleScale);
        if (!e.isSolid && throttle > 0 && spec.minThrottle > 0) throttle = Math.max(throttle, spec.minThrottle);
        if (!e.isSolid && spec.minThrottle === 0 && throttle > 0) throttle = 1;

        const hasProp = e.isSolid ? e.srbBurned < 1 : a.propellant > 0;
        const wantRun = throttle > 0.001 && hasProp;
        if (wantRun && !e.running) {
          // (re)ignition
          if (e.ignitionAge > 0 && e.shutdownAge < 0.05) {
            // continuous
          } else if (e.restartsLeft <= 0) {
            if (!e.lastFailReason) { e.lastFailReason = 'no restarts'; this.events.push({ type: 'engine_shutdown', engine: e, reason: 'No ignitions remaining' }); }
            e.thrust = 0; e.mdot = 0;
            continue;
          } else {
            e.restartsLeft--;
            e.ignitionAge = 0;
            this.events.push({ type: 'engine_ignite', engine: e });
          }
          e.running = true;
          e.lastFailReason = '';
        } else if (!wantRun && e.running) {
          e.running = false;
          e.shutdownAge = 0;
          if (!hasProp) this.events.push({ type: 'engine_flameout', engine: e });
          else this.events.push({ type: 'engine_shutdown', engine: e, reason: 'commanded' });
        }
        if (e.running) {
          e.ignitionAge += dt;
          e.spool = Math.min(1, e.spool + dt / Math.max(0.05, spec.spoolUp));
          e.throttle += (throttle - e.throttle) * Math.min(1, dt * 4);
        } else {
          e.spool = Math.max(0, e.spool - dt / 0.5);
          e.throttle *= Math.max(0, 1 - dt * 3);
        }
        const eff = e.spool * e.spool * (3 - 2 * e.spool) * e.throttle; // smooth start
        let curve = 1;
        if (e.isSolid && spec.thrustCurve) curve = sampleCurve(spec.thrustCurve, e.srbBurned);
        const fvac = spec.thrustVac * eff * curve;
        const fsl = spec.thrustSL * eff * curve;
        const pr = Math.min(1, pAmb / p0);
        let thrust = fvac - (fvac - fsl) * pr;
        if (thrust < 0) thrust = 0;
        const mdot = (spec.thrustVac * eff * curve) / (spec.ispVac * G0);
        e.thrust = thrust;
        e.mdot = mdot;
        if (e.isSolid) {
          const totalProp = a.propellantCapacity > 0 ? a.propellantCapacity : 1;
          const burn = mdot * dt;
          a.propellant = Math.max(0, a.propellant - burn);
          e.srbBurned = 1 - a.propellant / totalProp;
          if (a.propellant <= 0) { e.srbBurned = 1; }
        } else {
          a.propellant = Math.max(0, a.propellant - mdot * dt);
        }
        // nozzle heating for glow visuals
        const targetT = e.running ? 600 + 900 * eff : 300;
        e.temperature += (targetT - e.temperature) * Math.min(1, dt * (e.running ? 0.25 : 0.04));
      }
    }
  }

  totalThrustVector(out: Vector3): Vector3 {
    out.set(0, 0, 0);
    for (const a of this.assemblies) for (const e of a.engines) {
      if (e.thrust <= 0) continue;
      _v2.set(Math.sin(e.gimbalX), 1, Math.sin(e.gimbalZ)).normalize().multiplyScalar(e.thrust);
      out.add(_v2);
    }
    return out.applyQuaternion(this.rot);
  }

  /** Thrust forces & gimbal torques. Gimbal angles come from the control allocator. */
  private applyThrust(force: Vector3, torque: Vector3, dt: number): void {
    const ctl = this.controls;
    let total = 0;
    const com = this.com;
    for (const a of this.assemblies) {
      for (const e of a.engines) {
        const spec = e.mount.spec;
        // gimbal allocation
        const ry = e.mount.pos[1] - com.y;
        const rx = e.mount.pos[0] + a.offX - com.x;
        const rz = e.mount.pos[2] + a.offZ - com.z;
        const g = spec.gimbal;
        let tx = 0, tz = 0;
        if (g > 0 && e.running) {
          // pitch (torque about X) needs lateral Z force with the sign of ry; yaw (about Z) lateral X
          const s = ry < 0 ? -1 : 1;
          tz += ctl.pitch * g * s;
          tx += -ctl.yaw * g * s;
          // roll via differential (tangential) gimbal on off-axis engines
          const rl = Math.hypot(rx, rz);
          if (rl > 0.3) {
            const k = -ctl.roll * g;
            tx += k * (-rz / rl);
            tz += k * (rx / rl);
          }
          const mag = Math.hypot(tx, tz);
          if (mag > g) { tx *= g / mag; tz *= g / mag; }
        }
        // slew rate limit ~25 deg/s
        const slew = 0.44 * dt;
        e.gimbalX += Math.max(-slew, Math.min(slew, tx - e.gimbalX));
        e.gimbalZ += Math.max(-slew, Math.min(slew, tz - e.gimbalZ));
        if (e.thrust <= 0) continue;
        const cant = e.mount.cant ?? 0;
        let dx = Math.sin(e.gimbalX), dz = Math.sin(e.gimbalZ);
        if (cant) {
          // cant is measured outward from the vehicle axis (strap-ons sit on an offset axis)
          const px = e.mount.pos[0] + a.offX, pz = e.mount.pos[2] + a.offZ;
          const rl = Math.hypot(px, pz) || 1;
          dx -= (px / rl) * Math.sin(cant);
          dz -= (pz / rl) * Math.sin(cant);
        }
        _v1.set(dx, 1, dz).normalize().multiplyScalar(e.thrust);
        // torque = r x F
        torque.x += ry * _v1.z - rz * _v1.y;
        torque.y += rz * _v1.x - rx * _v1.z;
        torque.z += rx * _v1.y - ry * _v1.x;
        _v1.applyQuaternion(this.rot);
        force.add(_v1);
        total += e.thrust;
      }
    }
    this.telemetry.thrust = total;
  }

  // ---------------------------------------------------------------- aero

  private applyAero(vAir: Vector3, speed: number, rho: number, q: number, mach: number, force: Vector3, torque: Vector3): number {
    if (speed < 0.05) return 0;
    // relative wind in vehicle frame: w = -vAir
    _q1.copy(this.rot).invert();
    const wv = _v1.copy(vAir).multiplyScalar(-1 / speed).applyQuaternion(_q1); // unit relative wind (vehicle frame)
    const cosA = -wv.y; // >0 when flying nose-first
    const aoa = Math.acos(Math.max(-1, Math.min(1, cosA)));
    const aero = this.aero;
    // axial drag on the leading end
    const shape = cosA >= 0 ? aero.topShape : aero.bottomShape;
    const cd = cd0ForShape(shape) * machDragFactor(mach);
    const axialMag = q * aero.refArea * cd * Math.abs(cosA);
    // apply along the axial component of the relative wind (vehicle frame)
    const fAx = _v2.set(0, wv.y >= 0 ? 1 : -1, 0).multiplyScalar(axialMag);
    // lateral relative wind (vehicle frame)
    const latX = wv.x, latZ = wv.z;
    const latMag = Math.hypot(latX, latZ);
    const sinA = latMag;
    let fx = 0, fz = 0;
    const absCos = Math.abs(cosA);
    for (const el of aero.elements) {
      // Barrowman (linear) + cross-flow drag
      let c = el.cnAlpha * aero.refArea * absCos + 1.2 * el.sideArea * sinA;
      if (el.kind === 'capsule') c *= 1.0;
      const f = q * c; // multiply by lateral unit vector * sinA
      const ex = f * latX, ez = f * latZ;
      fx += ex; fz += ez;
      const ry = el.y - this.com.y;
      const rx = el.x - this.com.x;
      const rz = el.z - this.com.z;
      // torque = r x F, F = (ex, 0, ez)
      torque.x += ry * ez;
      torque.y += rz * ex - rx * ez;
      torque.z += -ry * ex;
    }
    // capsule lift (offset-CoM trim, L/D ~0.3) in the direction of vehicle +X when flying base-first
    if (aero.isCapsule && cosA < -0.8) {
      const liftMag = axialMag * 0.3;
      // lift perpendicular to relative wind, along the capsule's +X lift vector projected
      const lv = _v3.set(1, 0, 0).addScaledVector(wv, -wv.x).normalize().multiplyScalar(liftMag);
      fx += lv.x; fz += lv.z;
      fAx.y += lv.y;
    }
    _v2.x += fx;
    _v2.z += fz;
    _v2.applyQuaternion(this.rot);
    force.add(_v2);
    return (aoa * 180) / Math.PI;
  }

  // ---------------------------------------------------------------- auxiliary thrust

  /** Short solid-motor pulses along the vehicle axis (+Y): [force N, seconds left]. */
  auxBurns: { force: number; time: number; kind: 'escape' | 'retro' }[] = [];

  private applyAuxThrust(dt: number, heightAboveSurface: number, vSurf: Vector3, force: Vector3): void {
    // soft-landing retro-rockets: fire a fraction of a second before touchdown under the main canopy
    for (const a of this.assemblies) {
      const rr = a.def.features?.retroRockets;
      if (!rr || a.retroFired || a.chuteState !== 'main' || a.mainInflation < 0.9) continue;
      const clearance = heightAboveSurface - Math.max(0, this.com.y - this.lowestY());
      const vz = vSurf.dot(_v1.copy(this.pos).normalize());
      // fire at the height the pulse needs to bring the descent down to ~1.5 m/s, so it ends
      // right at the ground (~0.8 m for a Soyuz-class module under its main canopy)
      const decel = Math.max(5, rr.thrust / this.mass - 0.5 * 9.81);
      const stopDist = Math.max(0, vz * vz - 2.25) / (2 * decel);
      if (vz < -2 && clearance < Math.min(rr.altitude, stopDist + 0.12) && clearance > -1) {
        a.retroFired = true;
        // take the descent from ~7 m/s down to ~1.5 m/s in one short pulse
        const dv = Math.max(0, -vz - 1.5);
        this.auxBurns.push({ force: rr.thrust, time: Math.min(0.4, (dv * this.mass) / rr.thrust), kind: 'retro' });
        this.events.push({ type: 'retro_fire' });
      }
    }
    if (!this.auxBurns.length) return;
    let f = 0;
    for (const b of this.auxBurns) {
      const step = Math.min(dt, b.time);
      f += (b.force * step) / dt;
      b.time -= step;
    }
    this.auxBurns = this.auxBurns.filter((b) => b.time > 1e-6);
    force.add(_v1.set(0, 1, 0).applyQuaternion(this.rot).multiplyScalar(f));
    this.telemetry.thrust += f;
  }

  /** Thrust currently delivered by auxiliary motors (N), for effects and audio. */
  get auxThrust(): number { return this.auxBurns.reduce((s, b) => s + b.force, 0); }

  // ---------------------------------------------------------------- thermal

  private stepThermal(dt: number, flux: number, noseFirst: boolean, vAir: Vector3, speed: number): void {
    // Radiative / convective sink temperature. The thermosphere's gas is ~1000 K but so thin it
    // exchanges no meaningful heat; out there the skin radiates to space and Earthshine
    // (~250 K). The gas temperature only matters where the air is dense enough to couple.
    const couple = Math.min(1, this.atm.density / 1e-4);
    const amb = Math.max(3, 250 + (Math.min(this.atm.temperature, 330) - 250) * couple);
    this.heatFluxShield = flux;
    // leading assembly receives the flux
    let lead: AssemblyRuntime | null = null;
    let best = noseFirst ? -Infinity : Infinity;
    for (const a of this.assemblies) {
      const y = noseFirst ? a.topY : a.bottomY;
      if (noseFirst ? y > best : y < best) { best = y; lead = a; }
    }
    // orientation of heat shield relative to the flow
    const noseDir = this.noseVector(_v2);
    const cosFlow = speed > 1 ? -noseDir.dot(vAir) / speed : 0; // >0 when base faces the flow (moving base-first)
    // Lumped skin temperature uses an area-averaged flux: on slender noses only a small cap sees
    // stagnation heating; blunt leading faces (capsules flying base-first) see most of it.
    const leadShape = noseFirst ? this.aero.topShape : this.aero.bottomShape;
    const avgFactor = leadShape === 'ogive' ? 0.08 : leadShape === 'cone' ? 0.12 : leadShape === 'capsule_apex' ? 0.5 : leadShape === 'heatshield' ? 0.7 : 0.3;
    for (const a of this.assemblies) {
      const hs = a.def.features?.heatShield;
      const isLead = a === lead;
      let qIn = (isLead ? flux : flux * 0.04) * avgFactor;
      if (hs && !a.heatShieldFailed) {
        // shield covers the base: effective when within ~35 deg of the flow
        const align = Math.max(0, (cosFlow - 0.8) / 0.2);
        const shieldIn = flux * align;
        const backshellIn = flux * (1 - align) * (isLead || !noseFirst ? 0.6 : 0.1);
        // ablative shield: radiates at high temperature, ablates above 1300 K
        const cap = 18000; // J/(m^2 K) effective
        const emit = 0.85 * STEFAN_BOLTZMANN * (Math.pow(a.shieldTemp, 4) - Math.pow(amb, 4));
        a.shieldTemp += ((shieldIn - emit) / cap) * dt;
        if (a.shieldTemp > 1300 && shieldIn > emit && !hs.reusable) {
          const excess = shieldIn - emit;
          const area = Math.PI * hs.radius * hs.radius;
          const ablate = ((excess * area) / 3.0e7) * dt; // kg; effective heat of ablation 30 MJ/kg
          a.ablator = Math.max(0, a.ablator - ablate);
          a.shieldTemp = Math.min(a.shieldTemp, 1300 + (a.shieldTemp - 1300) * 0.5);
          if (a.ablator <= 0 && hs.ablatorMass > 0) {
            a.heatShieldFailed = true;
            this.events.push({ type: 'heatshield_fail' });
          }
        }
        if (a.shieldTemp > hs.maxTemp + 600) {
          a.heatShieldFailed = true;
          this.events.push({ type: 'heatshield_fail' });
        }
        qIn = backshellIn;
      }
      const capSkin = a.def.features?.heatShield ? 9000 : 6000;
      const emitS = 0.8 * STEFAN_BOLTZMANN * (Math.pow(a.skinTemp, 4) - Math.pow(amb, 4));
      a.skinTemp += ((qIn * (isLead ? 1 : 0.3) - emitS) / capSkin) * dt;
      if (a.skinTemp < amb) a.skinTemp += (amb - a.skinTemp) * Math.min(1, dt * 0.01);
      const maxT = a.def.maxSkinTemp ?? (a.def.features?.heatShield ? 900 : 1100);
      if (a.skinTemp > maxT) {
        a.overheatTime += dt;
        if (a.overheatTime > 1.5 && !this.isDebris) {
          this.destroy(a.def.features?.heatShield ? 'Thermal failure — the spacecraft burned up on reentry' : `${a.def.name} overheated and broke apart`);
        } else if (a.overheatTime > 2.5 && this.isDebris) {
          this.breakupPending = true;
        }
      } else a.overheatTime = Math.max(0, a.overheatTime - dt * 0.5);
    }
    // plasma visual intensity
    const target = Math.min(1.6, Math.max(0, (flux - 4e4) / 1.2e6));
    this.plasmaIntensity += (target - this.plasmaIntensity) * Math.min(1, dt * 3);
  }

  // ---------------------------------------------------------------- parachutes

  private stepParachutes(dt: number, rho: number, speed: number, q: number, vAir: Vector3, force: Vector3): void {
    for (const a of this.assemblies) {
      const pc = a.def.features?.parachutes;
      if (!pc || a.chuteState === 'stowed' || a.chuteState === 'cut' || a.chuteState === 'failed') continue;
      a.chuteTime += dt;
      if (a.chuteState === 'drogue') {
        a.drogueInflation = Math.min(1, a.drogueInflation + dt / 1.6);
        if (q > 18000 && a.drogueInflation > 0.3) { a.chuteState = 'failed'; this.events.push({ type: 'chutes', stage: 'failed', reason: 'Drogue chutes torn — dynamic pressure too high' }); continue; }
      } else if (a.chuteState === 'main') {
        a.drogueInflation = Math.max(0, a.drogueInflation - dt / 1.0);
        // reefed inflation: ~3s reefed, then full
        const reef = a.chuteTime < 3.5 ? 0.12 + a.chuteTime * 0.04 : Math.min(1, 0.26 + (a.chuteTime - 3.5) / 2.5);
        a.mainInflation += (reef - a.mainInflation) * Math.min(1, dt * 3);
        if (q > 5200 && a.mainInflation > 0.2) { a.chuteState = 'failed'; this.events.push({ type: 'chutes', stage: 'failed', reason: 'Main chutes failed — deployed too fast' }); continue; }
      }
      if (speed < 0.1 || rho <= 0) continue;
      const dA = (Math.PI * (pc.drogueDiameter / 2) ** 2) * pc.drogues * a.drogueInflation;
      const mA = (Math.PI * (pc.mainDiameter / 2) ** 2) * pc.mains * a.mainInflation;
      const drag = q * (dA * 0.55 + mA * 0.8);
      force.addScaledVector(vAir, -drag / speed);
      // chutes pull the attachment point (apex) into the wind: strong stabilising torque handled in control
    }
  }

  deployChutes(mainsOnly = false): boolean {
    let any = false;
    for (const a of this.assemblies) {
      const pc = a.def.features?.parachutes;
      if (!pc) continue;
      if (a.chuteState === 'stowed') {
        if (pc.drogues > 0 && !mainsOnly) { a.chuteState = 'drogue'; a.chuteTime = 0; this.events.push({ type: 'chutes', stage: 'drogue' }); }
        else { a.chuteState = 'main'; a.chuteTime = 0; this.events.push({ type: 'chutes', stage: 'main' }); }
        any = true;
      } else if (a.chuteState === 'drogue') {
        a.chuteState = 'main'; a.chuteTime = 0; this.events.push({ type: 'chutes', stage: 'main' });
        any = true;
      }
    }
    return any;
  }

  // ---------------------------------------------------------------- control

  /** Maximum control torque per axis currently available (vehicle frame, N·m). */
  controlAuthority(out: Vector3): Vector3 {
    let px = 0, py = 0, pz = 0;
    const q = this.telemetry.dynamicPressure;
    for (const a of this.assemblies) {
      for (const e of a.engines) {
        if (!e.running || e.mount.spec.gimbal <= 0) continue;
        const ry = Math.abs(e.mount.pos[1] - this.com.y);
        const lat = e.thrust * Math.sin(e.mount.spec.gimbal);
        px += lat * ry;
        pz += lat * ry;
        const rl = Math.hypot(e.mount.pos[0] + a.offX - this.com.x, e.mount.pos[2] + a.offZ - this.com.z);
        py += lat * rl;
      }
      const f = a.def.features;
      if (f?.rcs && a.rcsFuel > 0 && this.controls.rcs) {
        const tq = f.rcs.thrust * f.rcs.arm * 2;
        px += tq; py += tq * 0.6; pz += tq;
      }
      if (f?.reactionWheel) { px += f.reactionWheel.torque; py += f.reactionWheel.torque; pz += f.reactionWheel.torque; }
      if (f?.gridFins && a.gridFinsDeployed > 0.5) {
        const arm = Math.abs(f.gridFins.y - this.com.y);
        const tq = q * f.gridFins.size * f.gridFins.size * 4 * 0.9 * arm;
        px += tq; pz += tq; py += tq * 0.3;
      }
      if (f?.flaps) {
        const tq = q * 12 * Math.max(1, this.aero.refLength * 0.4);
        px += tq; pz += tq * 0.5;
      }
    }
    // tiny baseline (vernier/attitude jets) so every vessel can be controlled a little
    const base = this.mass * 0.02;
    return out.set(px + base, py + base, pz + base);
  }

  private applyControlTorques(q: number, torque: Vector3, force: Vector3): void {
    const c = this.controls;
    for (const a of this.assemblies) {
      const f = a.def.features;
      if (!f) continue;
      if (f.rcs && a.rcsFuel > 0 && c.rcs) {
        const tq = f.rcs.thrust * f.rcs.arm * 2;
        torque.x += c.pitch * tq;
        torque.y += c.roll * tq * 0.6;
        torque.z += c.yaw * tq;
        const use = (Math.abs(c.pitch) + Math.abs(c.yaw) + Math.abs(c.roll)) * f.rcs.thrust / (220 * G0) / 120;
        // translation
        const tr = f.rcs.thrust * 2;
        if (c.tx || c.ty || c.tz) {
          _v1.set(c.tx * tr, c.ty * tr, c.tz * tr).applyQuaternion(this.rot);
          force.add(_v1);
        }
        const useT = (Math.abs(c.tx) + Math.abs(c.ty) + Math.abs(c.tz)) * tr / (220 * G0) / 120;
        a.rcsFuel = Math.max(0, a.rcsFuel - use - useT);
      }
      if (f.reactionWheel) {
        const tq = f.reactionWheel.torque;
        torque.x += c.pitch * tq;
        torque.y += c.roll * tq;
        torque.z += c.yaw * tq;
      }
      if (f.gridFins && a.gridFinsDeployed > 0.5 && q > 1) {
        const arm = Math.abs(f.gridFins.y - this.com.y);
        const tq = q * f.gridFins.size * f.gridFins.size * 4 * 0.9 * arm;
        torque.x += c.pitch * tq;
        torque.z += c.yaw * tq;
        torque.y += c.roll * tq * 0.3;
      }
      if (f.flaps && q > 1) {
        const tq = q * 12 * Math.max(1, this.aero.refLength * 0.4);
        torque.x += c.pitch * tq;
        torque.z += c.yaw * tq * 0.5;
      }
    }
    const base = this.mass * 0.02;
    torque.x += c.pitch * base;
    torque.y += c.roll * base;
    torque.z += c.yaw * base;
    // deployable animations
    for (const a of this.assemblies) {
      a.legsDeployed += Math.sign(a.legsTarget - a.legsDeployed) * Math.min(Math.abs(a.legsTarget - a.legsDeployed), 1 / 120 / 2.5);
      a.gridFinsDeployed += Math.sign(a.gridFinsTarget - a.gridFinsDeployed) * Math.min(Math.abs(a.gridFinsTarget - a.gridFinsDeployed), 1 / 120 / 1.2);
      a.solarDeployed += Math.sign(a.solarTarget - a.solarDeployed) * Math.min(Math.abs(a.solarTarget - a.solarDeployed), 1 / 120 / 8);
    }
  }

  // ---------------------------------------------------------------- contact

  contactPoints(out: Vector3[]): number {
    let n = 0;
    let bottom = Infinity, top = -Infinity, rMax = 0.5;
    for (const a of this.assemblies) {
      bottom = Math.min(bottom, a.bottomY);
      top = Math.max(top, a.topY);
      rMax = Math.max(rMax, Math.hypot(a.offX, a.offZ) + a.maxRadius);
    }
    const push = (x: number, y: number, z: number) => {
      if (!out[n]) out[n] = new Vector3();
      out[n++].set(x, y, z);
    };
    // legs
    let legs = false;
    for (const a of this.assemblies) {
      const L = a.def.features?.landingLegs;
      if (L && a.legsDeployed > 0.9) {
        legs = true;
        const reach = a.maxRadius + L.length * 0.72;
        const foot = L.y - L.length * 0.62;
        for (let i = 0; i < L.count; i++) {
          const ang = (i / L.count) * Math.PI * 2 + Math.PI / L.count;
          push(a.offX + Math.cos(ang) * reach, Math.min(foot, a.bottomY), a.offZ + Math.sin(ang) * reach);
        }
      }
    }
    if (!legs) {
      const rb = Math.max(0.4, rMax * 0.8);
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        push(Math.cos(ang) * rb, bottom, Math.sin(ang) * rb);
      }
    }
    // top ring (for tipping over)
    const rt = Math.max(0.3, rMax * 0.6);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      push(Math.cos(ang) * rt, top, Math.sin(ang) * rt);
    }
    // mid ring
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + 0.6;
      push(Math.cos(ang) * rMax, (top + bottom) * 0.5, Math.sin(ang) * rMax);
    }
    return n;
  }

  private _cps: Vector3[] = [];
  private lastTouching = 0;

  private applyContact(dt: number, t: number, surfaceH: number, overWater: boolean, force: Vector3, torque: Vector3, vSurf: Vector3): number {
    const R = this.body.radius;
    const padAlt = this.padSupportAlt;
    let n: number;
    let usePad = false;
    if (!isNaN(padAlt)) {
      // launch mount: the vehicle rests on its hold-down ring at y = 0 (nozzles hang into the trench)
      usePad = true;
      n = 0;
      const rb = Math.max(0.6, this.rootAssembly.maxRadius * 0.9);
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        if (!this._cps[n]) this._cps[n] = new Vector3();
        this._cps[n++].set(Math.cos(ang) * rb, 0, Math.sin(ang) * rb);
      }
    } else {
      n = this.contactPoints(this._cps);
    }
    let total = 0;
    const kBase = this.mass * 400;
    const cBase = 2 * Math.sqrt(kBase * this.mass) * 0.25;
    let touching = 0;
    let maxImpact = 0;
    const water = overWater && !usePad;
    const touchingEstimate = Math.max(1, this.lastTouching);
    for (let i = 0; i < n; i++) {
      const lp = this._cps[i];
      const wp = this.pointToInertial(lp, _v1);
      const rr = wp.length();
      const ground = usePad ? R + padAlt : R + surfaceH;
      const pen = ground - rr;
      if (pen <= 0) continue;
      touching++;
      const nrm = _v2.copy(wp).multiplyScalar(1 / rr);
      const rLocal = _v3.copy(lp).sub(this.com);
      const rlx = rLocal.x, rly = rLocal.y, rlz = rLocal.z;
      const pv = _v4.copy(this.angVel).cross(rLocal).applyQuaternion(this.rot).add(vSurf);
      const vn = pv.dot(nrm);
      if (-vn > maxImpact) maxImpact = -vn;
      let fn: number;
      if (water) {
        const area = Math.max(3, this.aero.refArea);
        fn = (1000 * 9.81 * area * Math.min(pen, 3)) / Math.max(1, n * 0.5) - (vn * this.mass * 1.2) / n;
      } else {
        fn = (kBase * pen * 6) / n - ((cBase * vn) / n) * 3;
      }
      if (fn < 0) fn = 0;
      const fN = _v3.copy(nrm).multiplyScalar(fn);
      const vt = pv.addScaledVector(nrm, -vn);
      const vtl = vt.length();
      if (vtl > 1e-4) {
        const mu = water ? 0.15 : 0.7;
        // effective mass of the contact point along the slip direction:
        // 1/m_eff = 1/m + (r x t) . I^-1 (r x t)   (body frame, diagonal inertia)
        _q2.copy(this.rot).invert();
        const tb = _tb.copy(vt).multiplyScalar(1 / vtl).applyQuaternion(_q2);
        const cx = rly * tb.z - rlz * tb.y, cy = rlz * tb.x - rlx * tb.z, cz = rlx * tb.y - rly * tb.x;
        const invM = 1 / this.mass + (cx * cx) / this.inertia.x + (cy * cy) / this.inertia.y + (cz * cz) / this.inertia.z;
        const mEff = 1 / invM;
        const ft = Math.min(mu * fn, ((mEff / Math.max(1, touchingEstimate)) * vtl) / dt * 0.3);
        fN.addScaledVector(vt, -ft / vtl);
      }
      force.add(fN);
      const fLocal = _v4.copy(fN).applyQuaternion(this._qInv.copy(this.rot).invert());
      const rl = _v2.copy(lp).sub(this.com);
      torque.x += rl.y * fLocal.z - rl.z * fLocal.y;
      torque.y += rl.z * fLocal.x - rl.x * fLocal.z;
      torque.z += rl.x * fLocal.y - rl.y * fLocal.x;
      total += fn;
    }
    this.lastTouching = touching;
    if (touching > 0) {
      this.angVel.multiplyScalar(Math.max(0, 1 - dt * (water ? 1.5 : 6)));
      this.lastImpactSpeed = Math.max(this.lastImpactSpeed * 0.99, maxImpact);
      if (usePad) return total;
      const speed = vSurf.length();
      if (this.hasLiftedOff && maxImpact > 0.5 && !this.landed) this.onTouchdown(maxImpact, water);
      if (this.hasLiftedOff && !this.destroyed && !this.aero.isCapsule) {
        // tipped over?
        const up = _v1.copy(this.pos).normalize();
        const tilt = Math.acos(Math.max(-1, Math.min(1, this.noseVector(_v2).dot(up))));
        if (tilt > 0.7 && this.touchdownReported) this.destroy(water ? 'The vehicle tipped over in the water' : 'The vehicle tipped over after touchdown');
      }
      if (this.hasLiftedOff && speed < 0.25 && this.angVel.length() < 0.05 && !this.destroyed && touching >= 3 && this.telemetry.thrust < this.mass * 9) {
        this.settleLanded(t, water);
      }
    }
    return total;
  }

  private touchdownReported = false;

  private onTouchdown(speed: number, water: boolean): void {
    if (this.touchdownReported) return;
    this.touchdownReported = true;
    this.events.push({ type: 'touchdown', speed, water });
    const tol = this.landingTolerance(water);
    if (speed > tol) {
      this.destroy(water ? `Impacted the ocean at ${speed.toFixed(1)} m/s` : `Impacted the surface at ${speed.toFixed(1)} m/s`);
    }
  }

  landingTolerance(water: boolean): number {
    const capsule = this.assemblies.some((a) => a.def.features?.heatShield);
    const legs = this.assemblies.some((a) => a.def.features?.landingLegs && a.legsDeployed > 0.9);
    if (capsule) return water ? 14 : 9;
    if (legs) return 7;
    return 3.5;
  }

  settleLanded(t: number, water: boolean): void {
    if (this.landed) return;
    this.landed = true;
    this.splashed = water;
    this.body.orientationAt(t, _q1);
    const inv = _q1.clone().invert();
    this.landedFixedPos.copy(this.pos).applyQuaternion(inv);
    this.landedFixedRot.copy(inv).multiply(this.rot);
  }

  /** Hold the vessel kinematically fixed to the body surface (used for the pad). */
  clampToSurface(t: number): void {
    this.clamped = true;
    this.body.orientationAt(t, _q1);
    const inv = _q1.clone().invert();
    this.landedFixedPos.copy(this.pos).applyQuaternion(inv);
    this.landedFixedRot.copy(inv).multiply(this.rot);
  }

  releaseClamps(): void {
    if (!this.clamped) return;
    this.clamped = false;
    this.events.push({ type: 'clamps_release' });
  }

  // ---------------------------------------------------------------- structure

  private checkStructural(q: number, aoaDeg: number, dt: number): void {
    if (this.isDebris || this.destroyed) return;
    // q·alpha bending limit (Pa·deg) — typical launchers ~150–250 kPa·deg
    const capsuleOnly = this.aero.isCapsule && this.assemblies.length <= 3;
    // bending loads depend on the angle to the nearest axial direction (tail-first flight is fine)
    const effA = Math.min(aoaDeg, 180 - aoaDeg);
    // engines firing into the flow (powered descent) shield the body: relieve bending loads
    const poweredTailFirst = aoaDeg > 90 && this.telemetry.thrust > 0;
    const qa = q * effA * (poweredTailFirst ? 0.4 : 1);
    this.telemetry.qAlpha = qa;
    const limit = capsuleOnly ? 2.5e6 : 2.2e5;
    if (qa > limit && q > 2000) {
      this.destroy(capsuleOnly ? 'Aerodynamic loads tore the spacecraft apart' : 'Structural failure — aerodynamic bending loads exceeded (q·α)');
    }
    // axial g limit (flight loads only — ground contact is judged by impact speed instead)
    const g = this.contactForce > 0 ? 0 : this.telemetry.gForce;
    if (g > (capsuleOnly ? 25 : 12) && this.hasLiftedOff) {
      this.destroy(`Structural failure at ${g.toFixed(1)} g`);
    }
    if (q > (capsuleOnly ? 2e5 : 9e4)) this.destroy('Dynamic pressure exceeded structural limits');
    void dt;
  }

  destroy(reason: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyReason = reason;
    for (const e of this.engines) { e.armed = false; e.running = false; e.thrust = 0; }
    this.events.push({ type: 'destroyed', reason });
  }

  // ---------------------------------------------------------------- telemetry

  private fillTelemetry(t: number, altitude: number, terrainH: number, water: boolean, lat: number, lon: number, q: number, mach: number, aoa: number, heat: number): void {
    const tm = this.telemetry;
    tm.altitude = altitude;
    tm.terrainHeight = water ? 0 : terrainH;
    tm.radarAltitude = altitude - Math.max(water ? 0 : terrainH, water ? 0 : -1e9);
    if (this.body.def.hasSurface && !water) tm.radarAltitude = altitude - terrainH;
    // radar altitude measured from the vehicle's lowest point
    tm.radarAltitude -= Math.max(0, this.com.y - this.lowestY());
    tm.latitude = lat;
    tm.longitude = lon;
    tm.dynamicPressure = q;
    tm.mach = mach;
    tm.density = this.atm.density;
    tm.pressure = this.atm.pressure;
    tm.temperatureAir = this.atm.temperature;
    tm.aoa = aoa;
    tm.heatFlux = heat;
    tm.inAtmosphere = this.atm.density > 1e-9;
    if (q > tm.maxQ && this.hasLiftedOff) tm.maxQ = q;
    const up = _up.copy(this.pos).normalize();
    tm.speedOrbital = this.vel.length();
    const vs = this.surfaceVelocity(_v1);
    tm.speedSurface = vs.length();
    tm.verticalSpeed = vs.dot(up);
    tm.horizontalSpeed = Math.sqrt(Math.max(0, tm.speedSurface * tm.speedSurface - tm.verticalSpeed * tm.verticalSpeed));
    const gProper = this.properAccel.length();
    tm.gForce = gProper / G0;
    tm.axialG = this.properAccel.dot(this.noseVector(_v2)) / G0;
    tm.massTotal = this.mass;
    const localG = this.body.gm / Math.max(1, this.pos.lengthSq());
    tm.twr = tm.thrust / (this.mass * localG);
    // attitude in ENU
    this.enuBasis(_east, _north, _up);
    const nose = this.noseVector(_v2);
    tm.pitch = (Math.asin(Math.max(-1, Math.min(1, nose.dot(_up)))) * 180) / Math.PI;
    let hdg = (Math.atan2(nose.dot(_east), nose.dot(_north)) * 180) / Math.PI;
    if (hdg < 0) hdg += 360;
    tm.heading = hdg;
    // roll: angle of vehicle -Z (canopy/top) about the nose relative to local vertical
    const top = _v3.set(0, 0, -1).applyQuaternion(this.rot);
    const refUp = _v4.copy(_up).addScaledVector(nose, -_up.dot(nose));
    if (refUp.lengthSq() < 1e-6) refUp.copy(_north).addScaledVector(nose, -_north.dot(nose));
    refUp.normalize();
    const cross = _v1.crossVectors(refUp, top);
    tm.roll = (Math.atan2(cross.dot(nose), refUp.dot(top)) * 180) / Math.PI;
    void t;
  }

  lowestY(): number {
    let b = Infinity;
    for (const a of this.assemblies) b = Math.min(b, a.bottomY);
    for (const a of this.assemblies) {
      const L = a.def.features?.landingLegs;
      if (L && a.legsDeployed > 0.5) b = Math.min(b, L.y - L.length * 0.62);
    }
    return b;
  }

  /** Propellant of all attached assemblies with active (armed) engines. */
  stagePropellant(): { current: number; capacity: number } {
    let cur = 0, cap = 0;
    const seen = new Set<AssemblyRuntime>();
    for (const e of this.engines) if (e.armed && !seen.has(e.assembly)) {
      seen.add(e.assembly);
      cur += e.assembly.propellant;
      cap += e.assembly.propellantCapacity;
    }
    return { current: cur, capacity: cap };
  }

  /**
   * Predicted burn sequence: the currently armed engines first, then each future "ignite" stage
   * with the masses that separation events will drop. Vacuum performance.
   */
  stageSequence(): { mdot: number; ve: number; prop: number; m0: number; thrust: number }[] {
    const g0 = G0;
    const out: { mdot: number; ve: number; prop: number; m0: number; thrust: number }[] = [];
    // Assemblies that a future staging event will separate (so they are dropped when spent).
    const dropLater = new Set<string>();
    for (let si = this.stageIndex; si < this.staging.length; si++)
      for (const ev of this.staging[si]) if (ev.action === 'separate' || ev.action === 'jettison') ev.targets.forEach((t) => dropLater.add(t));
    const props = new Map<AssemblyRuntime, number>();
    for (const a of this.assemblies) props.set(a, a.propellant);
    const remaining = new Set(this.assemblies);
    let mass = this.mass;
    type Burner = { a: AssemblyRuntime; mdot: number; thrust: number };
    const burnerFor = (a: AssemblyRuntime, scaleCurrent: boolean): Burner | null => {
      let th = 0, md = 0;
      for (const e of a.engines) {
        if (e.failed) continue;
        const sc = scaleCurrent && !e.isSolid ? e.throttleScale : 1;
        th += e.mount.spec.thrustVac * sc;
        md += (e.mount.spec.thrustVac * sc) / (e.mount.spec.ispVac * g0);
      }
      return md > 0 ? { a, mdot: md, thrust: th } : null;
    };
    const dropOne = (sub: AssemblyRuntime) => {
      if (!remaining.has(sub)) return;
      mass -= sub.dryMass + (props.get(sub) ?? 0) + sub.ablator + sub.rcsFuel;
      remaining.delete(sub);
    };
    const dropSubtree = (a: AssemblyRuntime) => {
      // separating a stack's root (bottom stage) only removes that stage
      const p = this.parentOf.get(a);
      if (!p || !remaining.has(p)) { dropOne(a); return; }
      for (const sub of this.subtree(a)) dropOne(sub);
    };
    const burnSet = (active: Burner[]) => {
      let guard = 0;
      while (active.length && guard++ < 32) {
        let dt = Infinity;
        for (const b of active) dt = Math.min(dt, (props.get(b.a) ?? 0) / b.mdot);
        if (!isFinite(dt) || dt <= 0) dt = 0;
        const md = active.reduce((x, b) => x + b.mdot, 0);
        const th = active.reduce((x, b) => x + b.thrust, 0);
        const burned = md * dt;
        if (burned > 0) out.push({ mdot: md, ve: th / md, prop: burned, m0: mass, thrust: th });
        mass -= burned;
        for (const b of active) props.set(b.a, Math.max(0, (props.get(b.a) ?? 0) - b.mdot * dt));
        const spent = active.filter((b) => (props.get(b.a) ?? 0) <= 1e-6);
        for (const b of spent) {
          const p = this.parentOf.get(b.a);
          if (dropLater.has(b.a.id) && p && remaining.has(p)) dropSubtree(b.a);
        }
        active = active.filter((b) => !spent.includes(b));
      }
    };
    const current: Burner[] = [];
    for (const a of this.assemblies) {
      if (!a.engines.some((e) => e.armed && !e.failed)) continue;
      const b = burnerFor(a, true);
      if (b && (props.get(a) ?? 0) > 0) current.push(b);
    }
    burnSet(current);
    for (let si = this.stageIndex; si < this.staging.length; si++) {
      for (const ev of this.staging[si]) {
        if (ev.action === 'separate' || ev.action === 'jettison') {
          for (const id of ev.targets) { const a = this.getAssembly(id); if (a && remaining.has(a)) dropSubtree(a); }
        } else if (ev.action === 'ignite') {
          const set: Burner[] = [];
          for (const id of ev.targets) {
            const a = this.getAssembly(id);
            if (!a || !remaining.has(a)) continue;
            if (a.engines.some((e) => e.armed)) continue; // already burning above
            const b = burnerFor(a, false);
            if (b && (props.get(a) ?? 0) > 0) set.push(b);
          }
          burnSet(set);
        }
      }
    }
    return out;
  }

  /** Estimated vacuum delta-v of the currently armed stage and the full remaining stack. */
  deltaV(): { stage: number; total: number } {
    const seq = this.stageSequence();
    let total = 0;
    let stage = 0;
    seq.forEach((st, i) => {
      const dv = st.ve * Math.log(st.m0 / Math.max(1, st.m0 - st.prop));
      if (i === 0 && this.engines.some((e) => e.armed && !e.failed)) stage = dv;
      total += dv;
    });
    return { stage, total };
  }

  /** Burn time needed to deliver `dv` using the remaining stage sequence (s), or Infinity. */
  burnTimeFor(dv: number): number {
    let t = 0;
    let rem = dv;
    for (const st of this.stageSequence()) {
      const stDv = st.ve * Math.log(st.m0 / Math.max(1, st.m0 - st.prop));
      if (stDv >= rem) return t + (st.m0 / st.mdot) * (1 - Math.exp(-rem / st.ve));
      t += st.prop / st.mdot;
      rem -= stDv;
    }
    return rem > 0 ? Infinity : t;
  }
}

function sampleCurve(curve: [number, number][], x: number): number {
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 0; i < curve.length - 1; i++) {
    const [x0, y0] = curve[i];
    const [x1, y1] = curve[i + 1];
    if (x <= x1) return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
  }
  return curve[curve.length - 1][1];
}
