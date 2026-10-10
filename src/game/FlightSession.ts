import { Matrix4, Quaternion, Vector3 } from 'three';
import { CameraDirector, CamContext } from '../camera/CameraDirector';
import type { CelestialBody, SolarSystem } from '../physics/bodies';
import { AssemblyRuntime, Vessel } from '../physics/vessel';
import { MAX_PHYSICS_WARP, PhysicsWorld, WARP_LEVELS } from '../physics/world';
import type { RenderWorld } from '../render/RenderWorld';
import type { LaunchComplex } from '../render/site/LaunchComplex';
import { getVehicle } from '../vehicles/catalog';
import type { VehicleDef } from '../vehicles/types';
import { LAUNCH_SITES, LaunchSite } from '../world/sites';
import { landingZonesFor, ZoneSpec } from '../world/zones';
import { Autopilot, AutopilotMode } from './Autopilot';
import { FlightSoftware, launchAzimuth } from './guidance';
import { buildCountdown, CountdownEvent, LaunchSequence } from './LaunchSequence';
import { GameTerrain, GameWeather, WEATHER_PRESETS, WeatherKind } from './providers';
import { BoosterGuidance } from './recovery';
import type { MissionStart } from './missions';
import { FlightSnapshot, restoreVessel } from './SaveGame';
import { keplerPropagate } from '../physics/orbit';
import { lunarLaunchPlane, type LandingTarget } from './Planner';

/**
 * One flight, from the terminal count to wherever it ends. Owns the physics world, the
 * countdown, flight software, autopilot, booster recovery and the camera director, and turns
 * simulation events into the effects, radio calls and camera cuts that make it a story.
 */

export type FlightPhase = 'countdown' | 'ascent' | 'upper' | 'orbit' | 'coast' | 'transfer' | 'entry' | 'descent' | 'landed' | 'splashed' | 'destroyed';

export interface FlightConfig {
  vehicleId: string;
  siteId: string;
  /** launch time (UTC) */
  date: Date;
  weather: WeatherKind;
  /** target orbit altitude (m) for orbit assist */
  targetOrbit?: number;
  /** orbit inclination (deg); defaults to the site latitude */
  inclination?: number;
  /** start the countdown at this T (s) */
  countdownStart?: number;
  /** orbit assist engaged at liftoff */
  orbitAssist?: boolean;
  /** fly reusable boosters home */
  recovery?: boolean;
  missionId?: string;
  /** where the flight begins */
  start?: MissionStart;
  /** resume from a saved snapshot */
  snapshot?: FlightSnapshot;
  /** vegetation density 0..1 */
  vegetation?: number;
  /** launch into the plane that contains the Moon at arrival (translunar missions) */
  planeTarget?: 'moon';
  /** where a crewed return should come down */
  landingTarget?: LandingTarget;
}

export type SessionEvent =
  | { type: 'countdown'; ev: CountdownEvent }
  | { type: 'radio'; id: string; priority?: number }
  | { type: 'message'; text: string; level?: 'info' | 'warn' | 'alert' | 'good' }
  | { type: 'phase'; phase: FlightPhase }
  | { type: 'milestone'; id: string }
  | { type: 'stage'; index: number; label: string }
  | { type: 'separation'; kind: string; vessel: Vessel }
  | { type: 'ignite'; vessel: Vessel; assembly: AssemblyRuntime }
  | { type: 'touchdown'; vessel: Vessel; speed: number; water: boolean }
  | { type: 'destroyed'; vessel: Vessel; reason: string }
  | { type: 'booster'; vessel: Vessel; id: string };

const _a = new Vector3();
const _b = new Vector3();
const _q = new Quaternion();

export class FlightSession {
  readonly world: PhysicsWorld;
  readonly system: SolarSystem;
  readonly def: VehicleDef;
  readonly site: LaunchSite;
  vessel!: Vessel;
  readonly autopilot: Autopilot;
  readonly fsw: FlightSoftware;
  readonly director: CameraDirector;
  readonly weather: GameWeather;
  readonly zones: ZoneSpec[];
  readonly seq: LaunchSequence;
  complex: LaunchComplex | null = null;
  readonly boosters: { v: Vessel; g: BoosterGuidance; zone: ZoneSpec }[] = [];
  phase: FlightPhase = 'countdown';
  /** simulation time of liftoff (NaN before) */
  liftoffT = NaN;
  readonly config: FlightConfig;
  /** where a crewed return should come down: the mission's, or the recovery area of an inland site */
  readonly landingTarget: LandingTarget | null;
  readonly azimuth: number;
  /** inclination of a computed launch-window plane (deg), if any */
  planeInclination = 0;
  /** player throttle (0..1) */
  throttle = 1;
  /** listeners */
  private listeners: ((e: SessionEvent) => void)[] = [];
  private milestones = new Set<string>();
  private maxQSeen = 0;
  private maxQDone = false;
  private lastMach = 0;
  private towerTopAlt = 0;
  private padAlt = 0;
  private realTime = 0;
  paused = false;
  /** the player has taken manual control (stops orbit assist from overriding) */
  manual = false;
  /** player stick input for this frame (overrides the autopilot's attitude commands) */
  manualOverride: { pitch: number; yaw: number; roll: number } | null = null;
  private ignitedAssemblies = new Set<AssemblyRuntime>();
  private wasInAtmo = true;
  private delugeT = -1e9;

  constructor(readonly rw: RenderWorld, system: SolarSystem, terrain: GameTerrain, config: FlightConfig) {
    this.config = config;
    {
      const site = LAUNCH_SITES.find((x) => x.id === config.siteId);
      // crews launched from an inland site come home to the steppe a few hundred km downrange
      this.landingTarget = config.landingTarget ?? (site?.inland ? { lat: site.lat + 1.4, lon: site.lon + 6.3, name: `the ${site.region} recovery area` } : null);
    }
    this.system = system;
    this.def = getVehicle(config.vehicleId);
    this.site = LAUNCH_SITES.find((s) => s.id === config.siteId) ?? LAUNCH_SITES[0];
    const preset = WEATHER_PRESETS[config.weather];
    this.weather = new GameWeather({ kind: config.weather, windDir: ((this.site.coastBearing + 180) * Math.PI) / 180, ...preset });
    rw.cloudCover = preset.clouds;
    rw.aero.humidity = { clear: 0.65, fair: 0.85, breezy: 0.75, overcast: 1, storm: 1 }[config.weather] ?? 0.8;
    const t0 = system.epoch;
    this.world = new PhysicsWorld(system, t0, terrain, this.weather);
    const lat = (this.site.lat * Math.PI) / 180, lon = (this.site.lon * Math.PI) / 180;
    const startKind = config.snapshot ? 'snapshot' : (config.start ?? 'pad');
    rw.vessels.clear();
    rw.plumes.clear();
    rw.effects.clear();
    rw.aero.clear();
    let v: Vessel;
    if (startKind === 'pad') {
      // pad + vehicle on the launch mount, held by the clamps
      this.complex = rw.setComplex(this.site, this.def, config.vegetation ?? 1);
      const deck = this.complex ? this.complex.deckHeight : 0;
      this.padAlt = this.site.padHeight + deck;
      v = this.world.createVessel(this.def, system.earth);
      this.world.addVessel(v);
      this.world.placeOnSurface(v, system.earth, lat, lon, this.padAlt, 0);
      v.padSupportAlt = this.padAlt;
      v.clampToSurface(this.world.t);
      this.towerTopAlt = this.padAlt + (this.complex ? this.complex.towerTop.y - deck : 60) + 5;
    } else {
      this.complex = rw.setComplex(null, null);
      this.padAlt = 0;
      v = this.createInSpace(startKind, terrain, config);
      this.liftoffT = this.world.t - (config.snapshot ? config.snapshot.t - config.snapshot.liftoffT : 0);
    }
    this.vessel = v;
    this.world.active = v;
    v.step(1e-4, { t: this.world.t, terrain, weather: this.weather });
    rw.vessels.attach(v, this.def, { flightProven: this.def.assemblies.some((a) => a.recovery && a.recovery !== 'none') && config.vehicleId !== 'leviathan' });
    const incl = ((config.inclination ?? Math.abs(this.site.lat)) * Math.PI) / 180;
    let planeNormal: Vector3 | null = null;
    if (config.planeTarget === 'moon' && startKind === 'pad') {
      // the launch window: the parking orbit must contain the Moon's position at arrival
      const tLift = this.world.t - (config.countdownStart ?? -120);
      const lp = lunarLaunchPlane(system, this.site.lat, this.site.lon, tLift);
      this.azimuth = lp.azimuth;
      planeNormal = lp.normal;
      this.planeInclination = (lp.inclination * 180) / Math.PI;
    } else {
      this.azimuth = launchAzimuth(lat, Math.max(incl, Math.abs(lat)));
    }
    // flight software, autopilot
    this.fsw = new FlightSoftware(v);
    this.autopilot = new Autopilot(this.world, v);
    this.autopilot.targetOrbit = config.targetOrbit ?? this.def.targetOrbit ?? 220_000;
    this.autopilot.azimuth = this.azimuth;
    this.autopilot.planeNormal = planeNormal;
    if (startKind === 'lunarOrbit') this.autopilot.landingSite = { lat: (0.674 * Math.PI) / 180, lon: (23.473 * Math.PI) / 180 };
    if (startKind === 'pad') {
      if (config.orbitAssist !== false) this.autopilot.setMode('orbit');
    } else if (startKind === 'entry') this.autopilot.setMode('retrograde');
    else if (startKind === 'leo') this.autopilot.setMode('stability');
    // recovery
    terrain.platforms = [];
    this.zones = landingZonesFor(this.site, this.def, this.azimuth, (dir) => terrain.heightAt(system.earth, dir));
    rw.zones.set(this.zones.filter((z) => z.kind !== 'tower').map((z) => ({
      kind: z.kind === 'droneship' ? 'droneship' as const : 'pad' as const, name: z.name, dir: z.dir.clone(), height: z.height, heading: this.azimuth,
    })));
    // landing pads and the drone ship's deck are real surfaces for the physics
    for (const z of this.zones) {
      if (z.kind === 'tower') continue;
      const east = new Vector3(0, 0, 1).cross(z.dir).normalize();
      const north = new Vector3().crossVectors(z.dir, east);
      const axis = z.kind === 'droneship' ? north.clone().multiplyScalar(Math.cos(this.azimuth)).addScaledVector(east, Math.sin(this.azimuth)).normalize() : north;
      terrain.platforms.push(z.kind === 'droneship'
        ? { bodyId: 'earth', dir: z.dir.clone(), height: z.height, halfLength: 45.5, halfWidth: 26, axis }
        : { bodyId: 'earth', dir: z.dir.clone(), height: z.height, halfLength: 48, halfWidth: 48, axis, round: true });
    }
    if (config.recovery !== false && this.zones.length) {
      this.world.guidanceFactory = (bv) => {
        const zone = this.zones.find((z) => !z.occupied && (z.kind !== 'droneship' || bv.assemblies.some((a) => a.def.recovery === 'droneship'))) ?? this.zones.find((z) => !z.occupied);
        if (!zone) return null;
        zone.occupied = true;
        const g = new BoosterGuidance(bv, this.world, zone);
        g.onEvent = (id) => this.emit({ type: 'booster', vessel: bv, id });
        const shipDir = g.stationAtImpact(this.world.t);
        if (shipDir) {
          // the ship (its deck as a physics platform, and its visual) holds station there
          const plat = terrain.platforms.find((p) => p.halfWidth < p.halfLength && !p.round);
          const east = new Vector3(0, 0, 1).cross(shipDir).normalize();
          const north = new Vector3().crossVectors(shipDir, east);
          if (plat) {
            plat.dir.copy(shipDir);
            plat.axis.copy(north).multiplyScalar(Math.cos(this.azimuth)).addScaledVector(east, Math.sin(this.azimuth)).normalize();
          }
          this.rw.zones.move(zone.name, shipDir);
        }
        this.boosters.push({ v: bv, g, zone });
        bv.name = `${bv.assemblies[0]?.def.name ?? 'Booster'}`;
        return { update: (vv, dt, env) => g.update(vv, dt, env) };
      };
    }
    this.world.onVesselCreated = (nv, parent, kind) => {
      this.rw.effects.separation(parent, nv.assemblies, kind);
      this.emit({ type: 'separation', kind, vessel: nv });
    };
    // countdown
    if (startKind === 'pad') {
      const events = buildCountdown(this.def, { weatherMarginal: config.weather === 'breezy' || config.weather === 'storm', crewed: this.def.crewed });
      this.seq = new LaunchSequence(events, config.countdownStart ?? -120);
      rw.effects.setAnchor(system.earth, lat, lon, this.site.padHeight);
      rw.effects.flags.venting = 1;
    } else {
      this.seq = new LaunchSequence([], 0);
      const ll = v.computeLatLon(this.world.t);
      rw.effects.setAnchor(v.body, ll.lat, ll.lon, Math.max(0, v.telemetry.terrainHeight));
      if (config.snapshot) {
        for (const m of config.snapshot.milestones) this.milestones.add(m);
        this.phase = config.snapshot.phase as FlightPhase;
        this.throttle = config.snapshot.throttle;
      }
    }
    // effects / camera
    this.director = new CameraDirector(rw.camera);
    this.director.orbitAz = 2.4;
  }

  /** Build the vehicle somewhere other than the pad (mission starts and saved flights). */
  private createInSpace(kind: string, terrain: GameTerrain, config: FlightConfig): Vessel {
    const sys = this.system;
    const t = this.world.t;
    if (kind === 'snapshot' && config.snapshot) {
      const snap = config.snapshot;
      const ids = new Set(snap.assemblies.map((a) => a.id));
      const body = sys.get(snap.body);
      const v = new Vessel(this.def.name, this.def, this.def.assemblies.filter((a) => ids.has(a.id)), body);
      this.world.addVessel(v);
      restoreVessel(v, snap);
      if (snap.landed) v.settleLanded(t, false);
      this.phase = snap.phase as FlightPhase;
      return v;
    }
    if (kind === 'entry') return this.createAtEntry(config);
    const body0 = kind === 'leo' ? sys.earth : kind === 'jupiterApproach' ? sys.get('jupiter') : sys.moon;
    // in Earth orbit only the orbital configuration remains (boosters and lower stages gone)
    const v = kind === 'leo'
      ? new Vessel(this.def.name, this.def, this.def.assemblies.filter((a) => orbitalAssemblies(this.def).has(a.id)), body0)
      : this.world.createVessel(this.def, body0);
    if (kind === 'leo') {
      v.stageIndex = orbitalStageIndex(this.def);
      // the upper stage is lit up to orbit: its engines stay armed for later burns
      for (let i = 0; i < v.stageIndex; i++) for (const e of this.def.staging[i]) if (e.action === 'ignite') {
        for (const id of e.targets) { const a = v.getAssembly(id); if (a) for (const en of a.engines) en.armed = true; }
      }
    }
    this.world.addVessel(v);
    const body = v.body;
    const rot = new Quaternion();
    body.orientationAt(t, rot);
    const pole = new Vector3(0, 0, 1).applyQuaternion(rot);
    // reference direction in the equatorial plane
    const ref = new Vector3(1, 0, 0).applyQuaternion(rot);
    const side = new Vector3().crossVectors(pole, ref);
    v.hasLiftedOff = true;
    if (kind === 'leo' || kind === 'lunarOrbit') {
      const alt = kind === 'leo' ? (config.targetOrbit ?? 300_000) : 100_000;
      const r = body.radius + alt;
      const vc = Math.sqrt(body.gm / r);
      const inc = ((config.inclination ?? (kind === 'leo' ? 28.6 : 2)) * Math.PI) / 180;
      // for the lunar descent, start a little more than half an orbit before Tranquility Base
      // (0.67N, 23.47E): the descent-orbit burn comes up within minutes
      const phase0 = kind === 'lunarOrbit' ? ((23.47 - 200) * Math.PI) / 180 : 0;
      const nrm = pole.clone().applyAxisAngle(ref, inc);
      const p = ref.clone().applyAxisAngle(nrm, phase0).multiplyScalar(r);
      const vel = new Vector3().crossVectors(nrm, p).normalize().multiplyScalar(vc);
      // nose retrograde, ready for a deorbit / descent burn
      this.world.placeInOrbit(v, body, p, vel, kind === 'lunarOrbit' ? vel.clone().negate() : vel);
      this.phase = 'orbit';
      this.milestones.add('orbit');
    } else if (kind === 'moonSurface') {
      const la = (0.674 * Math.PI) / 180, lo = (23.473 * Math.PI) / 180;
      const dir = new Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
      const h = terrain.heightAt(body, dir);
      this.world.placeOnSurface(v, body, la, lo, h + 0.05, 0);
      for (const a of v.assemblies) if (a.def.features?.landingLegs) { a.legsDeployed = 1; a.legsTarget = 1; }
      v.settleLanded(t, false);
      this.phase = 'landed';
    } else if (kind === 'jupiterApproach') {
      // hyperbolic approach: v_inf 5.8 km/s, perijove 2.6 Rj, starting 2 days out
      const mu = body.gm;
      const rp = body.radius * 2.6;
      const vinf = 5800;
      const vp = Math.sqrt(vinf * vinf + (2 * mu) / rp);
      const r0 = ref.clone().multiplyScalar(rp);
      const v0 = side.clone().multiplyScalar(vp);
      const outR = new Vector3(), outV = new Vector3();
      keplerPropagate(r0, v0, mu, -2 * 86400, outR, outV);
      this.world.placeInOrbit(v, body, outR, outV, outV.clone().normalize());
      this.phase = 'transfer';
      for (const a of v.assemblies) if (a.def.features?.solarPanels) { a.solarDeployed = 1; a.solarTarget = 1; }
    }
    return v;
  }

  /**
   * Entry interface: the crew capsule alone at 122 km, 7.7 km/s, a 1.4° flight-path angle,
   * heat shield forward, some 1,800 km up-range of the site so it comes down nearby.
   */
  private createAtEntry(config: FlightConfig): Vessel {
    const sys = this.system, earth = sys.earth, t = this.world.t;
    const scId = this.def.spacecraft ?? this.def.assemblies[this.def.assemblies.length - 1].id;
    const keep = new Set<string>([scId]);
    const v = new Vessel(this.def.name, this.def, this.def.assemblies.filter((a) => keep.has(a.id)), earth);
    v.stageIndex = this.def.staging.findIndex((g) => g.some((e) => e.action === 'deploy_chutes'));
    if (v.stageIndex < 0) v.stageIndex = this.def.staging.length;
    this.world.addVessel(v);
    const rot = new Quaternion();
    earth.orientationAt(t, rot);
    const lat = (this.site.lat * Math.PI) / 180, lon = ((this.site.lon - 17) * Math.PI) / 180;
    const up = new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)).applyQuaternion(rot);
    const north = new Vector3(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)).applyQuaternion(rot);
    const east = new Vector3().crossVectors(north, up);
    const r = earth.radius + 122_000;
    const gamma = (-1.4 * Math.PI) / 180;
    const p = up.clone().multiplyScalar(r);
    const vel = east.clone().multiplyScalar(Math.cos(gamma)).addScaledVector(up, Math.sin(gamma)).multiplyScalar(7700);
    this.world.placeInOrbit(v, earth, p, vel, vel.clone().negate());
    v.hasLiftedOff = true;
    this.phase = 'coast';
    this.milestones.add('orbit');
    // we begin at the interface itself: the entry sequence starts on the first step
    this.wasInAtmo = false;
    void config;
    return v;
  }

  milestoneList(): string[] { return [...this.milestones]; }

  /** Render with the camera as it is (photo mode drives the camera itself). */
  renderStatic(realDt: number): void {
    const rw = this.rw;
    const v = this.active;
    rw.focusHelio.copy(v.pos).add(this.bodyPos(v.body));
    rw.focusRadius = Math.max(40, Math.min(400, this.vesselLength(v) * 1.2));
    rw.update(this.world.t, realDt);
    rw.updateVehicles(0, this.world.t, this.world.vessels, v, (x) => this.bodyPos(x.body));
  }

  /** Record a milestone without side effects (mission logic bookkeeping). */
  markMilestone(id: string): void { this.milestones.add(id); }

  on(fn: (e: SessionEvent) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
  }

  emit(e: SessionEvent): void {
    for (const f of this.listeners) f(e);
    if (e.type === 'radio') return;
  }

  private milestone(id: string, radio?: string, cue?: string, msg?: string): void {
    if (this.milestones.has(id)) return;
    this.milestones.add(id);
    this.emit({ type: 'milestone', id });
    if (radio) this.emit({ type: 'radio', id: radio });
    if (cue) this.director.cue(cue);
    if (msg) this.emit({ type: 'message', text: msg, level: 'info' });
  }

  hasMilestone(id: string): boolean { return this.milestones.has(id); }

  setPhase(p: FlightPhase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.emit({ type: 'phase', phase: p });
  }

  /** Mission elapsed time (s); negative during the count. */
  get met(): number { return isNaN(this.liftoffT) ? this.seq.T : this.world.t - this.liftoffT; }

  get active(): Vessel { return (this.world.active ?? this.vessel); }

  bodyPos = (b: CelestialBody): Vector3 => b.globalPositionAt(this.world.t, new Vector3());

  // ------------------------------------------------------------------------------ controls

  // ------------------------------------------------------------------------------ abort

  /** the launch escape system has fired */
  aborted = false;
  private abortT = 0;
  private abortStep = 0;

  /**
   * Launch abort: cut the launcher's engines, pull the crew module clear on the escape tower's
   * solid motor (about eight times the module's weight for three seconds), jettison the tower
   * near the top of the arc and come down under parachutes. Returns why it can't, if it can't.
   */
  abort(): string | null {
    const v = this.vessel;
    if (this.aborted) return null;
    if (v.destroyed) return 'Too late to abort';
    const scId = this.def.spacecraft;
    const sc = scId ? v.getAssembly(scId) : null;
    if (!sc || !sc.def.features?.crew) return 'Abort needs a crewed spacecraft with a launch escape system';
    const les = v.assemblies.find((a) => a.def.separation?.kind === 'les');
    if (!les) return 'The escape tower has already been jettisoned — abort by staging instead';
    this.aborted = true;
    this.abortT = this.world.t;
    this.abortStep = 0;
    const onPad = v.clamped;
    const padAlt = v.padSupportAlt;
    for (const e of v.engines) if (!e.isSolid) e.armed = false;
    v.controls.throttle = 0;
    this.throttle = 0;
    this.autopilot.setMode('off');
    this.manual = true;
    // the crew module and everything above it (the tower) leave the launcher
    const launcher = this.world.separate(v, [sc.def.id]);
    v.clamped = false;
    v.landed = false;
    v.padSupportAlt = NaN;
    v.hasLiftedOff = true;
    for (const lv of launcher) {
      if (onPad) { lv.padSupportAlt = padAlt; lv.clampToSurface(this.world.t); }
      lv.isDebris = true;
    }
    this.rangeSafety = onPad ? [] : launcher;
    v.auxBurns.push({ force: v.mass * 9.81 * 8, time: 3, kind: 'escape' });
    v.events.push({ type: 'les_fire' });
    if (this.phase === 'countdown') this.seq.held = true;
    this.setPhase('descent');
    this.emit({ type: 'radio', id: 'abort', priority: 3 });
    this.emit({ type: 'message', text: 'ABORT — launch escape system fired', level: 'alert' });
    this.director.cue('separation');
    this.director.shake.kick(1.2, 2);
    return null;
  }

  /** launcher pieces to destroy a few seconds after an in-flight abort */
  private rangeSafety: Vessel[] = [];

  private abortSequencer(v: Vessel): void {
    if (!this.aborted) return;
    const since = this.world.t - this.abortT;
    if (this.abortStep === 0 && since > 6 && this.rangeSafety.length) {
      // range safety: the abandoned launcher is destroyed before it can stray
      for (const lv of this.rangeSafety) if (!lv.destroyed) lv.destroy('Range safety destruct');
      this.rangeSafety = [];
    }
    if (this.abortStep === 0 && since > 4 && (v.telemetry.verticalSpeed < 15 || since > 14)) {
      // tower jettison near the top of the arc, then shed anything but the crew module
      this.abortStep = 1;
      const les = v.assemblies.find((a) => a.def.separation?.kind === 'les');
      if (les) this.world.separate(v, [les.def.id]);
      const scId = this.def.spacecraft;
      const rest = v.assemblies.filter((a) => a.def.id !== scId).map((a) => a.def.id);
      if (rest.length) this.world.separate(v, rest);
      this.emit({ type: 'radio', id: 'les_fire' });
      this.emit({ type: 'message', text: 'Escape tower jettisoned — parachutes armed', level: 'info' });
    }
  }

  stageNow(): void {
    const v = this.active;
    if (this.phase === 'countdown') return;
    const next = v.nextStage;
    if (!next) return;
    this.world.stage(v);
    this.emit({ type: 'stage', index: v.stageIndex - 1, label: next.map((e) => e.label).join(' · ') });
  }

  setAutopilot(m: AutopilotMode): void {
    this.autopilot.setMode(m);
    this.emit({ type: 'message', text: `Autopilot: ${m === 'off' ? 'manual' : m}`, level: 'info' });
  }

  setWarp(index: number): void {
    // the player's own warp choice ends any automatic coast
    this.warpTarget = null;
    const before = this.world.warpIndex;
    this.world.setWarpIndex(index);
    if (this.world.warpReason && index > this.world.warpIndex) this.emit({ type: 'message', text: `Time warp limited: ${this.world.warpReason}`, level: 'warn' });
    if (this.world.warpIndex !== before && this.world.warp > 1) this.emit({ type: 'message', text: `Time warp ${WARP_LEVELS[this.world.warpIndex]}×`, level: 'info' });
  }

  holdCountdown(hold: boolean): void {
    if (this.phase !== 'countdown') return;
    // no holds once the ignition sequence is under way
    if (hold && this.seq.T > -12) return;
    this.seq.held = hold;
    this.emit({ type: 'message', text: hold ? 'HOLD HOLD HOLD — countdown holding' : 'Countdown resumed', level: hold ? 'warn' : 'info' });
    this.emit({ type: 'radio', id: hold ? 'hold' : 'recycle' });
  }

  /** Skip the count forward (applies the actions of skipped events silently). */
  skipCountdown(toT = -10): void {
    if (this.phase !== 'countdown' || !Number.isFinite(toT) || this.seq.T >= toT) return;
    for (const e of this.seq.skipTo(toT)) this.handleCountdown(e, true);
    // let the arms finish moving instantly
    if (this.complex) for (let i = 0; i < 120; i++) this.complex.update(0.25, this.rw.siteNight);
  }

  // ------------------------------------------------------------------------------ update

  update(realDt: number): void {
    this.realTime += realDt;
    if (this.paused) return;
    const v = this.vessel;
    const world = this.world;
    // countdown clock (real time; the physics also runs so the vehicle sits on the pad)
    if (this.phase === 'countdown') {
      const fired = this.seq.update(realDt, { liftoff: v.hasLiftedOff, towerClear: false });
      for (const e of fired) this.handleCountdown(e, false);
    } else if (!this.seq.done) {
      const fired = this.seq.update(realDt, { liftoff: v.hasLiftedOff, towerClear: v.telemetry.altitude > this.towerTopAlt });
      for (const e of fired) this.handleCountdown(e, false);
    }
    // physics with sub-steps so guidance runs at >= 30 Hz of simulated time
    const warp = world.warp;
    const simDt = Math.min(realDt, 0.1) * warp;
    if (warp > MAX_PHYSICS_WARP) {
      this.preStep(simDt);
      world.update(realDt);
    } else {
      const n = Math.max(1, Math.ceil(simDt / (1 / 30)));
      for (let i = 0; i < n; i++) {
        this.preStep(simDt / n);
        world.update(simDt / n / warp);
      }
    }
    this.postStep();
  }

  private apTranslating = false;

  private preStep(dt: number): void {
    const v = this.vessel;
    if (v.destroyed) return;
    const ap = this.autopilot;
    // modes that fly engines need one that can fire: light (or separate to) the next stage if
    // nothing armed has propellant and an ignition left — e.g. the spacecraft leaves a third
    // stage whose engine has used its restarts
    const canFire = (e: Vessel['engines'][number]) => e.armed && !e.failed && (e.isSolid ? e.srbBurned < 1 : e.assembly.propellant > 0 && (e.running || e.restartsLeft > 0));
    if ((ap.mode === 'node' || ap.mode === 'land' || ap.mode === 'ascend') && !v.engines.some(canFire)) {
      const next = v.nextStage;
      if (next && next.some((e) => e.action === 'ignite' || e.action === 'separate')) ap.wantStage = true;
    }
    ap.update(dt);
    if (ap.wantStage) { ap.wantStage = false; this.stageNow(); }
    // trim burns translate on the RCS jets
    if (ap.translateCmd) {
      v.controls.rcs = true;
      v.controls.tx = ap.translateCmd.x; v.controls.ty = ap.translateCmd.y; v.controls.tz = ap.translateCmd.z;
      this.apTranslating = true;
    } else if (this.apTranslating) {
      v.controls.tx = 0; v.controls.ty = 0; v.controls.tz = 0;
      this.apTranslating = false;
    }
    if (ap.completed) {
      // orbit assist / burns hand back a vehicle with its engines off
      ap.completed = false;
      this.throttle = 0;
      this.emit({ type: 'message', text: ap.status || 'Autopilot sequence complete — engines safed, stability assist on', level: 'good' });
      if (ap.status.includes('injection') || ap.status.includes('Deorbit')) this.emit({ type: 'radio', id: 'burn_end' });
    }
    const apThrottle = this.autopilot.mode === 'orbit' ? null : this.autopilot.throttleCmd;
    if (this.autopilot.mode !== 'orbit' && this.phase !== 'countdown') v.controls.throttle = apThrottle ?? this.throttle;
    const mo = this.manualOverride;
    if (mo) { v.controls.pitch = mo.pitch; v.controls.yaw = mo.yaw; v.controls.roll = mo.roll; } else if (this.autopilot.mode === 'off') { v.controls.pitch = 0; v.controls.yaw = 0; v.controls.roll = 0; }
    if (this.phase === 'countdown') v.controls.throttle = 1;
    this.fsw.update(this.world.t, v.hasLiftedOff);
  }

  private postStep(): void {
    const v = this.vessel;
    const tm = v.telemetry;
    // liftoff detection and pad support release
    if (!v.hasLiftedOff && !v.clamped && tm.verticalSpeed > 0.5 && this.phase !== 'countdown') {
      v.hasLiftedOff = true;
      this.liftoffT = this.world.t;
    }
    if (v.hasLiftedOff && !isNaN(v.padSupportAlt) && tm.altitude > this.padAlt + 45) v.padSupportAlt = NaN;
    this.autoWarp();
    this.abortSequencer(v);
    this.entrySequencer(v);
    // world events -> session events
    for (const we of this.world.drainEvents()) this.handleWorldEvent(we.vessel, we.event);
    if (this.phase !== 'countdown' && !v.destroyed) this.milestones_(v);
    // pad state: deluge after liftoff, scorch, arms
    if (this.complex) {
      const fx = this.rw.effects.flags;
      const since = this.world.t - this.delugeT;
      if (v.hasLiftedOff && since > 25) fx.deluge = Math.max(0, fx.deluge - 0.02);
      const thrustMN = tm.thrust / 1e6;
      if (v.telemetry.radarAltitude < 300 && thrustMN > 0) this.complex.mats.scorch.value = Math.min(1, this.complex.mats.scorch.value + 0.02 * thrustMN * 0.016);
      this.complex.mats.wet.value = Math.max(this.complex.mats.wet.value * 0.9995, fx.deluge * 0.9);
    }
  }

  /** coast to an event under automatic time warp (lunar arrival, periapsis, entry) */
  warpTarget: { t: number; label: string } | null = null;

  /** While a manoeuvre is pending, warp toward it and drop out in time to turn and burn. */
  private autoWarp(): void {
    const ap = this.autopilot;
    const n = ap.node;
    // the descent assist marks the quiet stretches (waiting for the burn point, the long
    // coast down to the low point): warp through them, back to real time before they end
    if (ap.mode === 'land' && ap.coastUntil !== null && !this.warpTarget) {
      const remain = ap.coastUntil - this.world.t;
      let idx = 0;
      if (remain > 30) for (let i = WARP_LEVELS.length - 1; i >= 0; i--) if (remain > WARP_LEVELS[i] * 3) { idx = Math.min(i, 6); break; }
      if (idx !== this.world.warpIndex) this.world.setWarpIndex(idx);
      return;
    }
    const wt = this.warpTarget;
    if (wt && !(ap.mode === 'node' && n)) {
      const remain = wt.t - this.world.t;
      if (remain <= 2 || this.active.telemetry.thrust > 0) {
        this.warpTarget = null;
        this.world.setWarpIndex(0);
        this.emit({ type: 'message', text: `${wt.label}`, level: 'info' });
        return;
      }
      let idx = 0;
      for (let i = WARP_LEVELS.length - 1; i >= 0; i--) if (remain > WARP_LEVELS[i] * 3) { idx = i; break; }
      if (idx !== this.world.warpIndex) this.world.setWarpIndex(idx);
      return;
    }
    if (ap.mode !== 'node' || !n || ap.burning) return;
    const bt = ap.burnTime(ap.nodeRemaining);
    const tStart = n.t - (isFinite(bt) ? bt / 2 : 0) - 25;
    const remain = tStart - this.world.t;
    let idx = 0;
    for (let i = WARP_LEVELS.length - 1; i >= 0; i--) {
      if (remain > WARP_LEVELS[i] * 3) { idx = i; break; }
    }
    if (idx !== this.world.warpIndex) {
      this.world.setWarpIndex(idx);
    }
  }

  /** Crewed capsules: shed the service module before entry and arm the parachutes. */
  private entrySequencer(v: Vessel): void {
    const sc = this.def.spacecraft;
    if (!sc || v.landed || v.destroyed || v.body.id !== 'earth') return;
    const cap = v.getAssembly(sc);
    if (!cap?.def.features?.heatShield) return;
    const tm = v.telemetry;
    const o = v.updateOrbit(this.world.t);
    const entering = tm.altitude < 140_000 && tm.verticalSpeed < 0 && o.periapsis - v.body.radius < 70_000;
    if (entering && v.assemblies.length > 1 && !this.hasMilestone('entry_prep')) {
      this.markMilestone('entry_prep');
      // stage until only the capsule is left (stop before parachutes)
      for (let guard = 0; guard < 6 && v.assemblies.length > 1; guard++) {
        const next = v.nextStage;
        if (!next || next.some((e) => e.action === 'deploy_chutes')) break;
        this.stageNow();
      }
      if (v.assemblies.length > 1) {
        // separate everything but the capsule directly
        this.world.separate(v, v.assemblies.filter((a) => a !== cap).map((a) => a.id));
      }
      // guided entry: bank the capsule's lift toward the landing site when the deorbit was aimed
      // at one, otherwise hold a steady 60° bank
      this.autopilot.setMode('entry');
      this.emit({ type: 'message', text: 'Entry configuration: service module jettisoned, heat shield forward', level: 'info' });
      this.emit({ type: 'radio', id: 'entry_interface' });
    }
    const pc = cap.def.features.parachutes;
    if (pc && cap.chuteState === 'stowed' && tm.altitude < 9_000 && tm.speedSurface < 240 && tm.verticalSpeed < 0) {
      // drogues first (or the mains straight away on capsules without drogues)
      if (v.deployChutes()) {
        // drop any remaining staging step for the chutes so the player doesn't fire them twice
        if (v.nextStage?.some((e) => e.action === 'deploy_chutes')) v.stageIndex++;
        this.autopilot.setMode('off');
      }
    } else if (pc && cap.chuteState === 'drogue' && tm.altitude < 3_200 && tm.speedSurface < 100) {
      // drogues disreefed and cut away: the main canopies take over
      v.deployChutes();
    }
  }

  private handleCountdown(e: CountdownEvent, silent: boolean): void {
    const v = this.vessel;
    this.emit({ type: 'countdown', ev: e });
    if (e.voice && !silent) this.emit({ type: 'radio', id: e.voice });
    if (e.cue && !silent) this.director.cue(e.cue);
    const c = this.complex;
    switch (e.id) {
      case 'arms':
        c?.setArm('crew', true);
        c?.setArm('umbilical', true);
        break;
      case 'autoseq':
        c?.setArm('umbilical', true);
        break;
      case 'deluge':
        this.rw.effects.flags.deluge = 1;
        this.delugeT = this.world.t + 40;
        break;
      case 'ign2':
        this.rw.effects.flags.venting = 0.6;
        break;
      case 'ign5': {
        // liquid first-stage engines light while the clamps hold
        const g0 = this.def.staging[0] ?? [];
        for (const se of g0) if (se.action === 'ignite') for (const id of se.targets) {
          const a = v.getAssembly(id);
          if (!a) continue;
          for (const en of a.engines) if (!en.isSolid) en.armed = true;
        }
        this.rw.effects.flags.venting = 0;
        break;
      }
      case 'ign10': {
        // solids light at T-0
        const g0 = this.def.staging[0] ?? [];
        for (const se of g0) if (se.action === 'ignite') for (const id of se.targets) {
          const a = v.getAssembly(id);
          if (a) for (const en of a.engines) if (en.isSolid) en.armed = true;
        }
        for (const a of v.assemblies) if (a.def.ignitesAtLaunch) for (const en of a.engines) en.armed = true;
        break;
      }
      case 'ign11': {
        // release: consume staging group 0 (remaining actions) and let go
        const g0 = this.def.staging[0] ?? [];
        if (v.stageIndex === 0) {
          v.stageIndex = 1;
          for (const se of g0) if (se.action !== 'ignite' && se.action !== 'release') this.world.executeStageEvent(v, se.action, se.targets);
        }
        // engine-out check: a hold-down abort if thrust is short (player can't cause this pre-launch)
        v.releaseClamps();
        this.setPhase('ascent');
        c?.setArm('te', true);
        c?.setArm('tulip', true);
        c?.setArm('all', true);
        this.emit({ type: 'message', text: 'Hold-down release', level: 'good' });
        break;
      }
      case 'ign12':
        this.milestone('liftoff', undefined, undefined, `Liftoff · ${LaunchSequence.format(0)}`);
        break;
      case 'ign13':
        this.milestone('tower_clear');
        break;
    }
  }

  private handleWorldEvent(vs: Vessel, ev: import('../physics/vessel').VesselEvent): void {
    const main = vs === this.vessel;
    switch (ev.type) {
      case 'engine_ignite': {
        const a = ev.engine.assembly;
        if (!this.ignitedAssemblies.has(a)) {
          this.ignitedAssemblies.add(a);
          this.rw.effects.ignition(vs, a);
          this.emit({ type: 'ignite', vessel: vs, assembly: a });
        }
        break;
      }
      case 'separation':
        this.director.shake.kick(0.6, 5);
        break;
      case 'stage':
        if (main) this.emit({ type: 'stage', index: ev.index, label: ev.events.map((e) => e.label).join(' · ') });
        break;
      case 'chutes':
        if (main) {
          if (ev.stage === 'drogue') this.emit({ type: 'radio', id: 'drogues' });
          else if (ev.stage === 'main') { this.emit({ type: 'radio', id: 'mains' }); this.director.cue('chutes'); }
          else if (ev.stage === 'failed') this.emit({ type: 'radio', id: 'chute_fail' });
          this.director.shake.kick(0.4, 3);
        }
        break;
      case 'touchdown':
        this.emit({ type: 'touchdown', vessel: vs, speed: ev.speed, water: ev.water });
        if (main) {
          this.setPhase(ev.water ? 'splashed' : 'landed');
          this.emit({ type: 'radio', id: ev.water ? 'splashdown' : 'touchdown_land' });
          this.director.cue('splashdown');
        }
        this.director.shake.kick(0.5, 3);
        break;
      case 'destroyed': {
        const g = this.rw.vessels.groupOf(vs);
        const p = g ? g.position.clone() : vs.originInertial(new Vector3()).add(this.bodyPos(vs.body)).sub(this.rw.cameraHelio);
        const highAndFast = vs.body.atmosphereTop > 0 && vs.telemetry.altitude > 18_000 && vs.telemetry.speedSurface > 900;
        if (highAndFast) this.rw.effects.breakup(p, vs.surfaceVelocity(new Vector3()), Math.min(6, Math.cbrt(vs.mass / 1000) * 0.7));
        else this.rw.effects.explosion(p, Math.min(8, Math.cbrt(vs.mass / 1000) * 0.8));
        this.emit({ type: 'destroyed', vessel: vs, reason: ev.reason });
        if (main) {
          this.setPhase('destroyed');
          this.emit({ type: 'radio', id: 'vehicle_lost' });
          this.emit({ type: 'message', text: `Vehicle lost — ${ev.reason}`, level: 'alert' });
          this.director.cue('explosion');
        } else if (this.boosters.some((b) => b.v === vs)) this.emit({ type: 'radio', id: 'booster_lost' });
        this.director.shake.kick(1.0, 2);
        break;
      }
      case 'engine_fail':
        if (main) { this.emit({ type: 'radio', id: 'engine_fail' }); this.emit({ type: 'message', text: `Engine failure: ${ev.reason}`, level: 'alert' }); }
        break;
      case 'heatshield_fail':
        if (main) this.emit({ type: 'radio', id: 'heat_critical' });
        break;
      case 'soi_change':
        if (main) {
          const to = ev.to.id;
          if (to === 'moon') this.emit({ type: 'radio', id: 'moon_soi' });
          else if (to === 'earth' && ev.from.id === 'moon') this.emit({ type: 'radio', id: 'moon_soi_exit' });
          else if (to === 'sun') this.emit({ type: 'radio', id: 'earth_soi_exit' });
          else if (to === 'jupiter') this.emit({ type: 'radio', id: 'jupiter_soi' });
          this.emit({ type: 'message', text: `Entering ${ev.to.name} sphere of influence`, level: 'info' });
        }
        break;
      case 'les_fire':
        if (main) this.emit({ type: 'radio', id: 'les_fire' });
        break;
    }
  }

  /** Flight milestones derived from telemetry. */
  private milestones_(v: Vessel): void {
    const tm = v.telemetry;
    const met = this.met;
    if (!this.milestones.has('roll') && this.hasMilestone('tower_clear') && met > 6) this.milestone('roll', 'roll_program');
    if (!this.milestones.has('pitch') && met > 12 && tm.pitch < 86) this.milestone('pitch', 'pitch_program');
    if (this.lastMach < 1 && tm.mach >= 1 && tm.inAtmosphere) this.milestone('supersonic', 'supersonic', undefined, 'Supersonic');
    this.lastMach = tm.mach;
    // max-Q: dynamic pressure peaked and falling
    if (!this.maxQDone && tm.altitude > 5000) {
      if (tm.dynamicPressure > this.maxQSeen) this.maxQSeen = tm.dynamicPressure;
      else if (tm.dynamicPressure < this.maxQSeen * 0.93 && this.maxQSeen > 8000) {
        this.maxQDone = true;
        this.milestone('maxq', 'maxq', 'maxq', `Max-Q · ${(this.maxQSeen / 1000).toFixed(1)} kPa`);
      }
    }
    if (tm.altitude > 100_000 && v.body.id === 'earth') this.milestone('karman', 'karman', undefined, 'Kármán line — 100 km');
    // atmosphere exit / entry
    const inAtm = v.body.atmosphereTop > 0 && tm.altitude < v.body.atmosphereTop;
    if (this.wasInAtmo && !inAtm) this.wasInAtmo = false;
    // orbit
    if (v.body.atmosphereTop >= 0 && !v.landed) {
      const o = v.updateOrbit(this.world.t);
      const pe = o.periapsis - v.body.radius;
      const top = v.body.atmosphereTop || 20_000;
      if ((this.phase === 'ascent' || this.phase === 'upper') && pe > top && tm.thrust === 0 && o.e < 0.99) {
        this.setPhase('orbit');
        this.milestone('orbit', 'orbit_insertion', 'orbit', `Orbit · ${((o.apoapsis - v.body.radius) / 1000).toFixed(0)} × ${(pe / 1000).toFixed(0)} km`);
      }
      if (this.phase === 'ascent' && !v.assemblies.includes(this.vessel.rootAssembly) && tm.altitude > 40_000) this.setPhase('upper');
      if ((this.phase === 'orbit' || this.phase === 'coast') && !this.wasInAtmo && inAtm && tm.verticalSpeed < 0) {
        this.wasInAtmo = true;
        this.setPhase('entry');
        this.milestone('entry', 'entry_interface', 'entry', 'Entry interface');
      }
      if (this.phase === 'entry' && v.plasmaIntensity > 0.3) this.milestone('blackout', 'blackout');
      if (this.phase === 'entry' && this.hasMilestone('blackout') && v.plasmaIntensity < 0.05 && tm.speedSurface < 3000) this.milestone('blackout_end', 'blackout_end');
      if (this.phase === 'entry' && tm.speedSurface < 300 && tm.altitude < 15000) this.setPhase('descent');
    }
  }

  // ------------------------------------------------------------------------------ rendering

  /** Camera, lighting focus, vehicles, effects. Call once per rendered frame. */
  render(realDt: number): void {
    const rw = this.rw;
    const world = this.world;
    const v = this.active;
    const t = world.t;
    // camera
    const ctx = this.cameraContext(realDt);
    this.director.update(ctx);
    rw.cameraHelio.copy(this.director.posHelio);
    // lighting focus on the active vessel
    v.originInertial(_a).add(this.bodyPos(v.body));
    rw.focusHelio.copy(v.pos).add(this.bodyPos(v.body));
    rw.focusRadius = Math.max(40, Math.min(400, this.vesselLength(v) * 1.2));
    rw.update(t, realDt);
    this.system.earth.orientationAt(t, _q);
    rw.zones.update(realDt, this.bodyPos(this.system.earth), _q, this.system.earth.radius, rw.cameraHelio, rw.siteNight);
    rw.updateVehicles(realDt, t, world.vessels, v, (x) => this.bodyPos(x.body));
    // plasma wakes: the spacecraft on entry and any spent stage burning up within view
    for (const vs of world.vessels) {
      if (vs.destroyed || vs.plasmaIntensity <= 0.05) continue;
      if (vs !== v && vs.originInertial(_b).add(this.bodyPos(vs.body)).distanceTo(this.director.posHelio) > 600_000) continue;
      rw.effects.plasmaWake(vs, realDt, vs.plasmaIntensity);
    }
  }

  private vesselLength(v: Vessel): number {
    let lo = Infinity, hi = -Infinity;
    for (const a of v.assemblies) { lo = Math.min(lo, a.bottomY); hi = Math.max(hi, a.topY); }
    return isFinite(hi - lo) ? hi - lo : 10;
  }

  cameraContext(dt: number): CamContext {
    const rw = this.rw;
    const earth = this.system.earth;
    let plumeMN = 0;
    const plume = new Vector3();
    let w = 0;
    for (const vs of this.world.vessels) {
      const th = vs.telemetry.thrust;
      if (th <= 0 || vs.destroyed) continue;
      plumeMN += th / 1e6;
      vs.originInertial(_b).add(this.bodyPos(vs.body));
      plume.addScaledVector(_b, th);
      w += th;
    }
    // site frame at the current time (the renderer's copy is a frame old, and the Earth moves
    // ~500 m per frame along its orbit)
    const siteQuat = new Quaternion();
    const siteOrigin = new Vector3();
    {
      const la = (this.site.lat * Math.PI) / 180, lo = (this.site.lon * Math.PI) / 180;
      const up = new Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
      const north = new Vector3(-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la));
      const east = new Vector3().crossVectors(north, up);
      earth.orientationAt(this.world.t, _q);
      siteQuat.setFromRotationMatrix(new Matrix4().makeBasis(east, up, north.negate())).premultiply(_q);
      siteOrigin.copy(up).multiplyScalar(earth.radius + this.site.padHeight).applyQuaternion(_q).add(this.bodyPos(earth));
    }
    const terrain = this.world.terrain;
    return {
      t: this.world.t,
      dt,
      active: this.active,
      vessels: this.world.vessels,
      boosters: this.boosters.map((b) => b.v),
      bodyPos: this.bodyPos,
      site: { quat: siteQuat, origin: siteOrigin, body: earth },
      towerTop: this.complex ? this.complex.towerTop : null,
      deckHeight: this.complex ? this.complex.deckHeight : 0,
      siteQuery: this.complex,
      groundHeight: (body, helio) => {
        body.orientationAt(this.world.t, _q);
        _a.copy(helio).sub(this.bodyPos(body)).normalize().applyQuaternion(_q.invert());
        return terrain.heightAt(body, _a);
      },
      zones: this.zones.map((z) => {
        earth.orientationAt(this.world.t, _q);
        return { pos: z.dir.clone().multiplyScalar(earth.radius + z.height).applyQuaternion(_q).add(this.bodyPos(earth)), kind: z.kind };
      }),
      phase: this.phase,
      plumeMN,
      plumeSourceHelio: w > 0 ? plume.multiplyScalar(1 / w) : null,
    };
  }
}

/** Assemblies still attached once the vehicle is in orbit: staging is replayed through the
 *  upper stage's ignition and any jettisons (fairing, escape tower) that follow. */
function orbitalAssemblies(def: VehicleDef): Set<string> {
  const keep = new Set(def.assemblies.map((a) => a.id));
  const n = orbitalStageIndex(def);
  for (let i = 0; i < n; i++) for (const e of def.staging[i]) if (e.action === 'separate' || e.action === 'jettison') for (const id of e.targets) keep.delete(id);
  return keep;
}

function orbitalStageIndex(def: VehicleDef): number {
  const vacuumOnly = (id: string) => {
    const a = def.assemblies.find((x) => x.id === id);
    return !!a && a.engines.length > 0 && a.engines.every((m) => m.spec.nozzle === 'vacuum' || m.spec.thrustSL < m.spec.thrustVac * 0.6);
  };
  let i = 0;
  for (; i < def.staging.length; i++) {
    const g = def.staging[i];
    if (i > 0 && g.some((e) => e.action === 'ignite' && e.targets.some(vacuumOnly))) { i++; break; }
  }
  // then any jettison-only groups (fairings, escape tower)
  while (i < def.staging.length && def.staging[i].every((e) => e.action === 'jettison')) i++;
  return Math.min(i, def.staging.length);
}
