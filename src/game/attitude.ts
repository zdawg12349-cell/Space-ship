import { Quaternion, Vector3 } from 'three';
import type { Vessel } from '../physics/vessel';

/**
 * Attitude controller: rate-limited proportional-derivative law sized by the vessel's actual
 * control authority, so the same gains fly a 13-tonne smallsat launcher and a 5000-tonne
 * super-heavy. Outputs normalised pitch/yaw/roll commands in [-1, 1].
 */

const _n = new Vector3();
const _axis = new Vector3();
const _q = new Quaternion();
const _auth = new Vector3();
const _top = new Vector3();
const _refUp = new Vector3();
const _cross = new Vector3();

export interface AttitudeTarget {
  dir: Vector3; // desired nose direction (inertial, unit)
  up?: Vector3; // desired direction of the vehicle's -Z ("roof"); optional roll target
}

export class AttitudeController {
  maxRate = 0.25; // rad/s cap
  rollMaxRate = 0.2;
  gain = 1.2; // 1/s, proportional on angle
  damping = 3.0; // 1/s, rate error -> angular acceleration
  /** last computed error (rad) */
  error = 0;
  rollError = 0;

  /** Compute control commands toward the target; writes into vessel.controls. */
  update(v: Vessel, target: AttitudeTarget, dt: number, strength = 1): void {
    v.noseVector(_n);
    const dot = Math.max(-1, Math.min(1, _n.dot(target.dir)));
    _axis.crossVectors(_n, target.dir);
    let s = _axis.length();
    let angle = Math.atan2(s, dot);
    if (s < 1e-9) {
      if (dot > 0) { _axis.set(1, 0, 0).applyQuaternion(v.rot); angle = 0; } else {
        // 180°: pick any perpendicular axis
        _axis.set(1, 0, 0).applyQuaternion(v.rot);
      }
      s = 1;
    } else _axis.multiplyScalar(1 / s);
    this.error = angle;
    // into body frame
    _q.copy(v.rot).invert();
    const ab = _axis.applyQuaternion(_q);

    v.controlAuthority(_auth);
    const I = v.inertia;
    const amaxX = Math.max(1e-4, _auth.x / I.x);
    const amaxY = Math.max(1e-4, _auth.y / I.y);
    const amaxZ = Math.max(1e-4, _auth.z / I.z);
    const amax = Math.min(amaxX, amaxZ);

    // desired rate magnitude: min(cap, k*angle, sqrt(2 * 0.5 a angle)) — a braking-aware profile
    const rate = Math.min(this.maxRate, this.gain * angle, Math.sqrt(2 * 0.5 * amax * angle));
    const wdx = ab.x * rate, wdz = ab.z * rate;
    let wdy = 0;

    // roll target
    if (target.up) {
      _top.set(0, 0, -1).applyQuaternion(v.rot);
      _refUp.copy(target.up).addScaledVector(_n, -target.up.dot(_n));
      if (_refUp.lengthSq() > 1e-6) {
        _refUp.normalize();
        _cross.crossVectors(_top, _refUp);
        const rollErr = Math.atan2(_cross.dot(_n), _top.dot(_refUp));
        this.rollError = rollErr;
        const rr = Math.min(this.rollMaxRate, Math.abs(rollErr) * this.gain, Math.sqrt(Math.abs(rollErr) * amaxY));
        wdy = Math.sign(rollErr) * rr;
      }
    }

    const w = v.angVel;
    const ax = (wdx - w.x) * this.damping;
    const ay = (wdy - w.y) * this.damping;
    const az = (wdz - w.z) * this.damping;
    const c = v.controls;
    c.pitch = clamp((ax / amaxX) * strength);
    c.yaw = clamp((az / amaxZ) * strength);
    c.roll = clamp((ay / amaxY) * strength);
    void dt;
  }

  /** Kill rotation (stability assist without a target). */
  killRotation(v: Vessel): void {
    v.controlAuthority(_auth);
    const I = v.inertia;
    const w = v.angVel;
    v.controls.pitch = clamp((-w.x * this.damping * I.x) / Math.max(1, _auth.x));
    v.controls.yaw = clamp((-w.z * this.damping * I.z) / Math.max(1, _auth.z));
    v.controls.roll = clamp((-w.y * this.damping * I.y) / Math.max(1, _auth.y));
  }
}

function clamp(x: number): number { return x > 1 ? 1 : x < -1 ? -1 : x; }
