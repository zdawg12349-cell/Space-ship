import { Quaternion, Vector3 } from 'three';
import { keplerPropagate, lambert } from '../physics/orbit';
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
  /** target orbit plane for the ascent (inertial normal), e.g. a lunar launch window */
  planeNormal: Vector3 | null = null;
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
  /**
   * Burn targeting: a point on the planned post-burn conic (body-relative) and the time the
   * vessel should pass it. During the burn the velocity to be gained is the Lambert velocity
   * to that point minus the current velocity, so a finite burn ends on the impulsive plan
   * regardless of its length, a late start or a thrust shortfall.
   */
  private nodeAim: { body: Vessel['body']; p: Vector3; tArr: number; h: Vector3 } | null = null;
  private lastVg = new Vector3();
  /** status line for the HUD */
  status = '';
  private landPhase: 'deorbit' | 'coast' | 'brake' | 'terminal' | 'down' = 'deorbit';
  /** descent target (body-fixed lat/lon, radians): the descent-orbit burn waits for the right phase */
  landingSite: { lat: number; lon: number } | null = null;
  private doiStarted = false;
  /** sim time until which nothing needs attention (the session time-warps toward it) */
  coastUntil: number | null = null;
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
    this.nodeAim = null;
    this.lastVg.set(0, 0, 0);
    if (!n) return;
    this.nodeDir.copy(n.dv).normalize();
    // aim point on the planned conic, far enough past the node to outlast the burn but well
    // short of the 180° transfer where Lambert's plane becomes undefined
    const v = this.vessel, mu = v.body.gm;
    const rB = new Vector3(), vB = new Vector3();
    keplerPropagate(v.pos, v.vel, mu, n.t - this.world.t, rB, vB);
    vB.add(n.dv);
    const h = new Vector3().crossVectors(rB, vB);
    if (h.lengthSq() < 1) return;
    h.normalize();
    const bt = this.burnTime(n.dv.length());
    const energy = vB.lengthSq() / 2 - mu / rB.length();
    const period = energy < 0 ? 2 * Math.PI * Math.sqrt(Math.pow(-mu / (2 * energy), 3) / mu) : Infinity;
    // the furthest point (up to ~150° of transfer) keeps the post-burn conic closest to the plan
    const p = new Vector3(), pv = new Vector3();
    const angleAt = (dt: number) => {
      keplerPropagate(rB, vB, mu, dt, p, pv);
      return Math.acos(Math.max(-1, Math.min(1, p.dot(rB) / (p.length() * rB.length()))));
    };
    const maxAng = (150 * Math.PI) / 180;
    const minLead = Math.max(120, isFinite(bt) ? bt * 3 : 600);
    let lo = minLead, hi = Math.min(isFinite(period) ? period * 0.45 : 4 * 86400, 4 * 86400);
    if (hi <= lo || angleAt(lo) > maxAng) hi = lo;
    else if (angleAt(hi) > maxAng) {
      for (let i = 0; i < 40; i++) { const mid = 0.5 * (lo + hi); if (angleAt(mid) > maxAng) hi = mid; else lo = mid; }
      hi = lo;
    }
    const lead = hi;
    keplerPropagate(rB, vB, mu, lead, p, pv);
    this.nodeAim = { body: v.body, p: p.clone(), tArr: n.t + lead, h };
  }

  /** Velocity to be gained toward the aim point (writes the vector, returns false if unusable). */
  private velocityToGain(out: Vector3): boolean {
    const a = this.nodeAim, v = this.vessel;
    if (!a || a.body !== v.body) return false;
    const tof = a.tArr - this.world.t;
    if (tof < 30) return false;
    if (!lambert(v.pos, a.p, tof, v.body.gm, a.h, out)) return false;
    out.sub(v.vel);
    return isFinite(out.x);
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
      if (!this.ascent) {
        this.ascent = new AscentGuidance(this.world, v, this.targetOrbit, this.azimuth);
        this.ascent.planeNormal = this.planeNormal;
      }
      this.ascent.enabled = true;
    }
    if (m !== 'orbit' && this.ascent) this.ascent.enabled = false;
    if (m === 'land') { this.landPhase = 'deorbit'; this.doiStarted = false; }
    this.coastUntil = null;
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
          const acc = v.telemetry.thrust / Math.max(1, v.mass);
          let finished = false;
          if (this.velocityToGain(_d)) {
            // velocity-to-be-gained steering: thrust along Vg until it is nulled
            const vg = _d.length();
            if (this.lastVg.lengthSq() > 0 && _d.dot(this.lastVg) < 0) finished = true; // overshoot: Vg flipped
            if (vg < 1 && this.att.error > 0.3) finished = true; // residual too small to chase
            this.lastVg.copy(_d);
            this.nodeRemaining = vg;
            if (vg > 0.05) this.nodeDir.copy(_d).multiplyScalar(1 / vg);
            target.copy(this.nodeDir);
          } else {
            // fallback: integrate delivered Δv along the fixed burn direction
            const along = acc * dt * Math.max(0, _h.set(0, 1, 0).applyQuaternion(v.rot).dot(this.nodeDir));
            this.nodeRemaining -= along;
          }
          const thrMax = v.telemetry.thrust > 0 ? v.telemetry.thrust / Math.max(0.05, v.controls.throttle) : 0;
          const aMax = thrMax / Math.max(1, v.mass);
          // throttle down for the last second of the burn
          this.throttleCmd = this.att.error > 0.25 ? 0 : aMax > 0 ? Math.max(0.05, Math.min(1, this.nodeRemaining / Math.max(0.5, aMax))) : 1;
          this.status = `${n.label}: ${this.nodeRemaining.toFixed(1)} m/s remaining`;
          if (v.stagePropellant().current <= 0 && v.nextStage) this.wantStage = true;
          if (this.nodeRemaining <= 0.15 || finished) {
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
    const R = this.vessel.body.radius;
    const dt = 0.25;
    for (let i = 0; i < 2400; i++) {
      const sp = Math.hypot(x, z);
      if (sp < 2) return alt;
      // gravity less the centrifugal relief of the horizontal speed (86% of lunar g in orbit)
      const ax = (-x / sp) * aMax, az = (-z / sp) * aMax - g + (x * x) / (R + alt);
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
      case 'deorbit': {
        this.att.update(v, { dir: retro }, dt);
        // with a landing site: burn half an orbit (plus the braking arc) before it, so the
        // descent orbit's low point and the powered descent fall on the site
        if (this.landingSite && !this.doiStarted && o.e < 0.2) {
          const ahead = this.siteAngleAhead();
          const DOI_LEAD = (173 * Math.PI) / 180;
          let wait = ahead - DOI_LEAD;
          if (wait < 0) wait += Math.PI * 2;
          if (wait > (0.6 * Math.PI) / 180) {
            const tWait = (wait / (Math.PI * 2)) * o.period;
            this.throttleCmd = 0;
            this.coastUntil = this.world.t + tWait - 90;
            this.status = `Descent orbit insertion in ${Math.ceil(tWait / 60)} min · landing site ${((ahead * 180) / Math.PI).toFixed(0)}° ahead`;
            return true;
          }
          this.doiStarted = true;
          this.coastUntil = null;
        }
        // lower periapsis to ~9 km
        this.throttleCmd = this.att.error < 0.1 ? 1 : 0;
        this.status = `Descent orbit insertion · periapsis ${(pe / 1000).toFixed(1)} km`;
        if (pe < 9000 || o.e >= 1 || tm.altitude < 15_000) { this.throttleCmd = 0; this.landPhase = 'coast'; }
        return true;
      }
      case 'coast': {
        this.att.update(v, { dir: retro }, dt);
        this.throttleCmd = 0;
        const hs = this.stopAltitude(h, vh, vz, aMax * 0.9, g);
        this.status = `Coasting to powered descent · ${(h / 1000).toFixed(1)} km · ignition at stop alt ${hs.toFixed(0)} m`;
        // powered descent straddles the low point: begin about half the braking time before it
        const tp = o.timeToPeriapsis();
        const tBrake = vh / Math.max(0.1, aMax * 0.85);
        this.coastUntil = tp > tBrake * 0.55 + 240 && tp < o.period * 0.9 ? this.world.t + tp - tBrake * 0.55 - 120 : null;
        const nearLow = (tp < tBrake * 0.55 && tp < o.period * 0.5) || o.period - tp < 30;
        if (nearLow || h < 2000) { this.landPhase = 'brake'; this.coastUntil = null; }
        return true;
      }
      case 'brake': {
        // altitude-managed braking (like the Apollo braking phase): most of the thrust kills
        // horizontal speed, the rest holds a descent profile that reaches ~150 m as the
        // horizontal speed runs out, so a low-thrust lander doesn't sink into the ground
        const aBudget = aMax * 0.95;
        const tgoH = vh / Math.max(0.1, aBudget * 0.9);
        const vzT = -Math.max(0, h - 150) / Math.max(25, tgoH);
        const aVneed = g - (vh * vh) / (body.radius + Math.max(0, h)) + (vzT - vz) * 0.3;
        const aV = Math.max(-0.3 * aBudget, Math.min(0.85 * aBudget, aVneed));
        const aH = Math.sqrt(Math.max(0, aBudget * aBudget - aV * aV));
        const hDir = vh > 1 ? vHorizVec.clone().multiplyScalar(-1 / vh) : new Vector3();
        const dir = hDir.multiplyScalar(vh > 25 ? aH : aH * (vh / 25)).addScaledVector(_u, Math.max(0.05, aV)).normalize();
        this.att.update(v, { dir }, dt);
        this.throttleCmd = this.att.error < 0.35 ? Math.max(0.15, Math.min(1, Math.hypot(vh > 25 ? aH : aH * (vh / 25), aV) / Math.max(0.1, aMax))) : 0.1;
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

  /** Angle (rad, 0..2π) from the vessel to the landing site, measured along the direction of motion. */
  siteAngleAhead(): number {
    const v = this.vessel, site = this.landingSite;
    if (!site) return 0;
    const q = v.body.orientationAt(this.world.t, new Quaternion());
    const sd = new Vector3(Math.cos(site.lat) * Math.cos(site.lon), Math.cos(site.lat) * Math.sin(site.lon), Math.sin(site.lat)).applyQuaternion(q);
    const r = v.pos.clone().normalize();
    const hn = new Vector3().crossVectors(v.pos, v.vel).normalize();
    sd.addScaledVector(hn, -sd.dot(hn)).normalize();
    let a = Math.atan2(new Vector3().crossVectors(r, sd).dot(hn), r.dot(sd));
    if (a < 0) a += Math.PI * 2;
    return a;
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
