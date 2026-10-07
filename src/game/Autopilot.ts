import { Vector3 } from 'three';
import type { Vessel } from '../physics/vessel';
import type { PhysicsWorld } from '../physics/world';
import { AttitudeController } from './attitude';
import { AscentGuidance } from './guidance';

/**
 * Pilot assistance. Every mode only commands attitude (and throttle for altitude hold / orbit
 * assist) through the same control channels the player uses; the physics does the rest.
 */
export type AutopilotMode =
  | 'off' | 'stability' | 'prograde' | 'retrograde' | 'radial' | 'antiradial' | 'normal' | 'antinormal'
  | 'heading' | 'altitude' | 'orbit';

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
  private altIntegral = 0;

  constructor(readonly world: PhysicsWorld, readonly vessel: Vessel) {}

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
          if (this.ascent.phase === 'done') { this.ascent.enabled = false; this.mode = 'stability'; }
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
}
