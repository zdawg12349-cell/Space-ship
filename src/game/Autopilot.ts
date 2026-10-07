import { Vector3 } from 'three';
import type { Vessel } from '../physics/vessel';
import type { PhysicsWorld } from '../physics/world';
import { AttitudeController } from './attitude';
import { AscentGuidance } from './guidance';
import type { ManeuverNode } from './Planner';

/**
 * Pilot assistance. Every mode only commands attitude (and throttle for altitude hold / orbit
 * assist) through the same control channels the player uses; the physics does the rest.
 */
export type AutopilotMode =
  | 'off' | 'stability' | 'prograde' | 'retrograde' | 'radial' | 'antiradial' | 'normal' | 'antinormal'
  | 'heading' | 'altitude' | 'orbit' | 'node' | 'land' | 'ascend';

export const AUTOPILOT_LABELS: Record<AutopilotMode, string> = {
  off: 'Manual',
  stability: 'Stability assist',
  prograde: 'Prograde',
  retrograde: 'Retrograde',
  radial: 'Radial out',
  antiradial: 'Radial in',
  normal: 'Normal',
  antinormal: 'Anti-normal',
  heading: 'Heading hold',
  altitude: 'Altitude hold',
  orbit: 'Orbit assist',
  node: 'Execute manoeuvre',
  land: 'Descent assist',
  ascend: 'Ascent to orbit',
};

const _d = new Vector3();
const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();
const _h = new Vector3();

export class Autopilot {
  mode: AutopilotMode = 'off';
  readonly att = new AttitudeController();
  /** heading hold target (deg from north) and pitch (deg above horizon) */
  heading = 90;
  pitch = 45;
  /** altitude hold target (m) */
  targetAltitude = 0;
  /** orbit assist */
  ascent: AscentGuidance | null = null;
  targetOrbit = 220_000;
  azimuth = Math.PI / 2;
  /** throttle the altitude-hold loop wants (null = leave to the player) */
  throttleCmd: number | null = null;
  /** set when orbit assist finishes (the session cuts the throttle) */
  completed = false;
  private altIntegral = 0;
  /** manoeuvre being executed */
  node: ManeuverNode | null = null;
  /** Δv still to deliver on the current node (m/s) */
  nodeRemaining = 0;
  private nodeStarted = false;
  private nodeDir = new Vector3();
  /** status line for the HUD */
  status = '';
  private landPhase: 'deorbit' | 'coast' | 'brake' | 'terminal' | 'down' = 'deorbit';
  private ascPhase: 'vertical' | 'pitch' | 'done' = 'vertical';
  private ascT = 0;
  /** ascent target (m) for 'ascend' */
  ascentTarget = 18_000;
  /** request staging (the session performs it) */
  wantStage = false;

  constructor(readonly world: PhysicsWorld, readonly vessel: Vessel) {}

  get burning(): boolean { return this.nodeStarted; }

  /** Arm a manoeuvre for execution. */
  setNode(n: ManeuverNode | null): void {
    this.node = n;
    this.nodeRemaining = n ? n.dv.length() : 0;
    this.nodeStarted = false;
    if (n) this.nodeDir.copy(n.dv).normalize();
  }

  /** Seconds of burn needed for a Δv at the current thrust/mass (vacuum). */
  burnTime(dv: number): number {
    const v = this.vessel;
    let thrust = 0, mdot = 0;
    for (const e of v.engines) {
      if (!e.armed || e.failed) continue;
      thrust += e.mount.spec.thrustVac;
      mdot += e.mount.spec.thrustVac / (e.mount.spec.ispVac * 9.80665);
    }
    if (thrust <= 0) {
      // next stage's engines
      const next = v.nextStage;
      if (next) for (const se of next) if (se.action === 'ignite') for (const id of se.targets) { const a = v.getAssembly(id); if (a) for (const e of a.engines) { thrust += e.mount.spec.thrustVac; mdot += e.mount.spec.thrustVac / (e.mount.spec.ispVac * 9.80665); } }
    }
    if (thrust <= 0) return Infinity;
    const ve = thrust / mdot;
    const m0 = v.mass;
    const m1 = m0 / Math.exp(dv / ve);
    return (m0 - m1) / mdot;
  }

  setMode(m: AutopilotMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.throttleCmd = null;
    this.altIntegral = 0;
    const v = this.vessel;
    if (m === 'heading') {
      this.heading = v.telemetry.heading;
      this.pitch = v.telemetry.pitch;
    } else if (m === 'altitude') {
      this.targetAltitude = v.telemetry.altitude;
    } else if (m === 'orbit') {
      if (!this.ascent) this.ascent = new AscentGuidance(this.world, v, this.targetOrbit, this.azimuth);
      this.ascent.enabled = true;
    }
    if (m !== 'orbit' && this.ascent) this.ascent.enabled = false;
    if (m === 'land') this.landPhase = 'deorbit';
    if (m === 'ascend') { this.ascPhase = 'vertical'; this.ascT = 0; }
    this.status = '';
  }

  /** Called before the physics step. Returns true when it is steering. */
  update(dt: number): boolean {
    const v = this.vessel;
    if (this.mode === 'off' || v.destroyed) return false;
    const tm = v.telemetry;
    const target = _d;
    switch (this.mode) {
      case 'stability':
        this.att.killRotation(v);
        return true;
      case 'orbit':
        if (this.ascent) {
          this.ascent.update(dt);
          if (this.ascent.phase === 'done') { this.ascent.enabled = false; this.mode = 'stability'; this.completed = true; }
        }
        return true;
      case 'prograde': case 'retrograde': {
        // surface prograde in the atmosphere, orbital prograde above it
        const inAtm = v.body.atmosphereTop > 0 && tm.altitude < v.body.atmosphereTop * 0.6;
        if (inAtm) v.surfaceVelocity(target); else target.copy(v.vel);
        if (target.lengthSq() < 1) { this.att.killRotation(v); return true; }
        target.normalize();
        if (this.mode === 'retrograde') target.negate();
        break;
      }
      case 'radial': case 'antiradial':
        target.copy(v.pos).normalize();
        if (this.mode === 'antiradial') target.negate();
        break;
      case 'normal': case 'antinormal':
        target.crossVectors(v.pos, v.vel);
        if (target.lengthSq() < 1e-6) { this.att.killRotation(v); return true; }
        target.normalize();
        if (this.mode === 'antinormal') target.negate();
        break;
      case 'heading': {
        v.enuBasis(_e, _n, _u);
        const hd = (this.heading * Math.PI) / 180, pt = (this.pitch * Math.PI) / 180;
        _h.copy(_n).multiplyScalar(Math.cos(hd)).addScaledVector(_e, Math.sin(hd));
        target.copy(_h).multiplyScalar(Math.cos(pt)).addScaledVector(_u, Math.sin(pt)).normalize();
        break;
      }
      case 'node': {
        const n = this.node;
        if (!n) { this.mode = 'stability'; this.att.killRotation(v); return true; }
        const t = this.world.t;
        const bt = this.burnTime(this.nodeRemaining);
        const start = n.t - (isFinite(bt) ? bt / 2 : 0);
        target.copy(this.nodeDir);
        if (!this.nodeStarted) {
          this.throttleCmd = 0;
          this.status = t < start ? `${n.label} in ${Math.max(0, start - t).toFixed(0)} s · ${this.nodeRemaining.toFixed(0)} m/s` : '';
          if (t >= start && this.att.error < 0.08) { this.nodeStarted = true; }
          else if (t >= start + 30 && this.att.error < 0.2) this.nodeStarted = true;
        }
        if (this.nodeStarted) {
          // integrate delivered Δv along the burn direction
          const acc = v.telemetry.thrust / Math.max(1, v.mass);
          const along = acc * dt * Math.max(0, _h.set(0, 1, 0).applyQuaternion(v.rot).dot(this.nodeDir));
          this.nodeRemaining -= along;
          const thrMax = v.telemetry.thrust > 0 ? v.telemetry.thrust / Math.max(0.05, v.controls.throttle) : 0;
          const aMax = thrMax / Math.max(1, v.mass);
          // throttle down for the last second of the burn
          this.throttleCmd = this.att.error > 0.25 ? 0 : aMax > 0 ? Math.max(0.05, Math.min(1, this.nodeRemaining / Math.max(0.5, aMax))) : 1;
          this.status = `${n.label}: ${this.nodeRemaining.toFixed(1)} m/s remaining`;
          if (v.stagePropellant().current <= 0 && v.nextStage) this.wantStage = true;
          if (this.nodeRemaining <= 0.15) {
            this.throttleCmd = 0;
            this.node = null;
            this.mode = 'stability';
            this.completed = true;
            this.status = `${n.label} complete`;
            this.att.killRotation(v);
            return true;
          }
        }
        break;
      }
      case 'land': return this.updateLanding(dt);
      case 'ascend': return this.updateVacuumAscent(dt);
      case 'altitude': {
        // point up (with a little tilt to null horizontal speed) and regulate throttle on vertical speed
        v.enuBasis(_e, _n, _u);
        v.surfaceVelocity(_h);
        const vh = _h.addScaledVector(_u, -_h.dot(_u));
        target.copy(_u).addScaledVector(vh, -0.02).normalize();
        const err = this.targetAltitude - tm.altitude;
        const vzCmd = Math.max(-15, Math.min(15, err * 0.25));
        const vzErr = vzCmd - tm.verticalSpeed;
        this.altIntegral = Math.max(-1, Math.min(1, this.altIntegral + vzErr * dt * 0.02));
        const g = v.body.gm / v.pos.lengthSq();
        const hover = tm.thrust > 0 ? (v.mass * g) / Math.max(1, tm.thrust / Math.max(0.05, v.controls.throttle)) : 0.5;
        this.throttleCmd = Math.max(0, Math.min(1, hover + vzErr * 0.08 + this.altIntegral));
        break;
      }
    }
    this.att.update(v, { dir: target }, dt);
    return true;
  }

  // ------------------------------------------------------------------------------ lunar descent

  /** Simulate a retrograde full-throttle braking burn in 2D; returns the altitude where speed reaches ~0. */
  private stopAltitude(h: number, vh: number, vz: number, aMax: number, g: number): number {
    let x = vh, z = vz, alt = h;
    const dt = 0.25;
    for (let i = 0; i < 2400; i++) {
      const sp = Math.hypot(x, z);
      if (sp < 2) return alt;
      const ax = (-x / sp) * aMax, az = (-z / sp) * aMax - g;
      x += ax * dt; z += az * dt; alt += z * dt;
      if (alt < -500) return alt;
    }
    return alt;
  }

  private updateLanding(dt: number): boolean {
    const v = this.vessel;
    const tm = v.telemetry;
    const body = v.body;
    const g = body.gm / v.pos.lengthSq();
    v.enuBasis(_e, _n, _u);
    v.surfaceVelocity(_h);
    const vz = _h.dot(_u);
    const vHorizVec = _h.clone().addScaledVector(_u, -vz);
    const vh = vHorizVec.length();
    const h = tm.radarAltitude;
    // available deceleration at full throttle
    let thrust = 0;
    for (const e of v.engines) if (e.armed && !e.failed) thrust += e.mount.spec.thrustVac;
    if (thrust <= 0 && v.nextStage) { this.wantStage = true; }
    const aMax = thrust / Math.max(1, v.mass);
    if (v.landed) { this.landPhase = 'down'; this.throttleCmd = 0; this.status = 'Touchdown'; this.att.killRotation(v); return true; }
    if (h < 1500) for (const a of v.assemblies) if (a.def.features?.landingLegs) a.legsTarget = 1;
    const o = v.updateOrbit(this.world.t);
    const pe = o.periapsis - body.radius;
    const retro = _h.lengthSq() > 1 ? _h.clone().normalize().negate() : _u.clone();
    switch (this.landPhase) {
      case 'deorbit':
        // lower periapsis to ~9 km
        this.att.update(v, { dir: retro }, dt);
        this.throttleCmd = this.att.error < 0.1 ? 1 : 0;
        this.status = `Descent orbit insertion · periapsis ${(pe / 1000).toFixed(1)} km`;
        if (pe < 9000 || o.e >= 1 || tm.altitude < 15_000) { this.throttleCmd = 0; this.landPhase = 'coast'; }
        return true;
      case 'coast': {
        this.att.update(v, { dir: retro }, dt);
        this.throttleCmd = 0;
        const hs = this.stopAltitude(h, vh, vz, aMax * 0.9, g);
        this.status = `Coasting to powered descent · ${(h / 1000).toFixed(1)} km · ignition at stop alt ${hs.toFixed(0)} m`;
        if (hs < 450 || h < 2000) this.landPhase = 'brake';
        return true;
      }
      case 'brake': {
        // gravity-turn braking: thrust retrograde, throttle so the predicted stop is ~150 m up
        this.att.update(v, { dir: vh < 25 ? _u.clone().addScaledVector(vHorizVec, -0.03).normalize() : retro }, dt);
        const hs = this.stopAltitude(h, vh, vz, aMax * 0.92, g);
        const err = hs - 150;
        this.throttleCmd = Math.max(0.15, Math.min(1, 0.92 - err / 900));
        this.status = `Powered descent · ${h.toFixed(0)} m · ${vh.toFixed(0)} m/s horizontal · ${(-vz).toFixed(1)} m/s down`;
        if (h < 160 || (vh < 8 && Math.abs(vz) < 15)) this.landPhase = 'terminal';
        return true;
      }
      case 'terminal': {
        // vertical, null the drift, descend at a speed that shrinks with height
        const tilt = vHorizVec.clone().multiplyScalar(-0.04);
        this.att.update(v, { dir: _u.clone().add(tilt).normalize() }, dt);
        const vzT = -Math.max(1.0, Math.min(12, h * 0.12));
        const need = g + (vzT - vz) * 1.6;
        this.throttleCmd = Math.max(0, Math.min(1, need / Math.max(0.1, aMax)));
        this.status = `Final descent · ${h.toFixed(0)} m · ${(-vz).toFixed(1)} m/s`;
        return true;
      }
      default:
        this.throttleCmd = 0;
        this.att.killRotation(v);
        return true;
    }
  }

  // ------------------------------------------------------------------------------ vacuum ascent

  private updateVacuumAscent(dt: number): boolean {
    // Airless ascent: hold a vertical-speed profile that tapers to zero at the target altitude
    // while the remaining thrust builds horizontal speed toward circular velocity.
    const v = this.vessel;
    const body = v.body;
    this.ascT += dt;
    v.enuBasis(_e, _n, _u);
    const east = _e.clone();
    const tm = v.telemetry;
    const r = v.pos.length();
    const g = body.gm / (r * r);
    const vz = tm.verticalSpeed, vh = tm.horizontalSpeed;
    const h = tm.altitude;
    const target = this.ascentTarget;
    const o = v.updateOrbit(this.world.t);
    const pe = o.periapsis - body.radius;
    let pitch: number;
    if (this.ascPhase === 'vertical') {
      pitch = 90;
      this.throttleCmd = 1;
      if (v.nextStage && !v.engines.some((e) => e.armed && !e.failed) && this.ascT > 0.3) this.wantStage = true;
      if (this.ascT > 5 && tm.radarAltitude > 40) { this.ascPhase = 'pitch'; this.ascT = 0; }
      this.status = 'Vertical rise';
    } else if (this.ascPhase === 'pitch') {
      const thrMax = tm.thrust > 0 ? tm.thrust / Math.max(0.05, v.controls.throttle) : 0;
      const aT = thrMax / Math.max(1, v.mass);
      const gEff = Math.max(0.05, g - (vh * vh) / r);
      const vzT = Math.sqrt(2 * gEff * Math.max(0, target - h)) * 0.75;
      const az = Math.max(-1.5, Math.min(2.5, (vzT - vz) * 0.5));
      const sinP = aT > 0 ? Math.max(0.03, Math.min(1, (gEff + az) / aT)) : 1;
      pitch = (Math.asin(sinP) * 180) / Math.PI;
      const vc = Math.sqrt(body.gm / r);
      this.throttleCmd = 1;
      this.status = `Ascent guidance · ${(h / 1000).toFixed(1)} km · ${vh.toFixed(0)} / ${vc.toFixed(0)} m/s`;
      if ((vh >= vc * 0.998 && pe > target * 0.6) || pe >= target * 0.85 || v.stagePropellant().current <= 0) {
        this.ascPhase = 'done';
        this.throttleCmd = 0;
        this.completed = true;
        this.mode = 'stability';
        this.status = `Lunar orbit · ${(pe / 1000).toFixed(0)} × ${((o.apoapsis - body.radius) / 1000).toFixed(0)} km`;
      }
    } else {
      pitch = 0;
      this.throttleCmd = 0;
    }
    const p = (pitch * Math.PI) / 180;
    const dir = east.multiplyScalar(Math.cos(p)).addScaledVector(_u, Math.sin(p)).normalize();
    this.att.update(v, { dir }, dt);
    return true;
  }
}
