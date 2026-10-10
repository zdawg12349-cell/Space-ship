import { Vector3 } from 'three';
import type { AtmosphereParams } from './AtmosphereParams';

/**
 * CPU evaluation of the same atmosphere model the shaders use, for scalar lighting values
 * (sunlight colour at a vehicle, sky brightness for audio/exposure hints, fog colour).
 */

const _p = new Vector3();

export function opticalDepth(params: AtmosphereParams, posKm: Vector3, dir: Vector3, steps = 24): Vector3 {
  // distance to the top of the atmosphere along dir
  const R = params.topRadius;
  const b = posKm.dot(dir);
  const c = posKm.lengthSq() - R * R;
  const disc = b * b - c;
  const out = new Vector3();
  if (disc <= 0) return out;
  const t1 = -b + Math.sqrt(disc);
  const t0 = Math.max(0, -b - Math.sqrt(disc));
  if (t1 <= t0) return out;
  const dt = (t1 - t0) / steps;
  const rs = params.rayleighScattering, ab = params.absorptionExtinction;
  for (let i = 0; i < steps; i++) {
    _p.copy(dir).multiplyScalar(t0 + (i + 0.5) * dt).add(posKm);
    const h = _p.length() - params.bottomRadius;
    const dR = Math.exp(-Math.max(h, 0) / params.rayleighScaleHeight);
    const dM = Math.exp(-Math.max(h, 0) / params.mieScaleHeight);
    const dA = Math.max(0, 1 - Math.abs(h - params.absorptionCenter) / (0.5 * params.absorptionWidth));
    out.x += (rs.x * dR + params.mieExtinction * dM + ab.x * dA) * dt;
    out.y += (rs.y * dR + params.mieExtinction * dM + ab.y * dA) * dt;
    out.z += (rs.z * dR + params.mieExtinction * dM + ab.z * dA) * dt;
  }
  return out;
}

/**
 * Sunlight transmittance (RGB) at a point, including the planet's shadow (soft over the
 * sun's angular size plus a few km of grazing atmosphere).
 */
export function sunTransmittance(params: AtmosphereParams, posKm: Vector3, sunDir: Vector3, out = new Vector3()): Vector3 {
  const r = posKm.length();
  // planet shadow: does the ray hit the ground?
  const b = posKm.dot(sunDir);
  const closest2 = r * r - b * b;
  const R = params.bottomRadius;
  let shadow = 1;
  if (b < 0) {
    const closest = Math.sqrt(Math.max(0, closest2));
    // fade over ~6 km of grazing height (matches the GLSL planetShadow)
    shadow = smoothstep(R - 6, R + 2, closest);
  }
  if (r > params.topRadius + 1 && (b > 0 || closest2 > params.topRadius * params.topRadius)) return out.set(shadow, shadow, shadow);
  const od = opticalDepth(params, posKm, sunDir);
  return out.set(Math.exp(-od.x) * shadow, Math.exp(-od.y) * shadow, Math.exp(-od.z) * shadow);
}

function smoothstep(a: number, b: number, x: number): number { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

const _d = new Vector3();
const _od0 = new Vector3();
/**
 * Transmittance (RGB) along the straight segment a -> b (km, planet-centred). Uses the
 * difference of optical depths to the top of the atmosphere along the same direction, which
 * is exact as long as the segment doesn't pass through the planet.
 */
export function segmentTransmittance(params: AtmosphereParams, aKm: Vector3, bKm: Vector3, out = new Vector3()): Vector3 {
  _d.subVectors(bKm, aKm);
  const len = _d.length();
  if (len < 1e-6) return out.set(1, 1, 1);
  _d.multiplyScalar(1 / len);
  _od0.copy(opticalDepth(params, aKm, _d, 16));
  const odB = opticalDepth(params, bKm, _d, 16);
  const tx = Math.max(0, _od0.x - odB.x), ty = Math.max(0, _od0.y - odB.y), tz = Math.max(0, _od0.z - odB.z);
  return out.set(Math.exp(-tx), Math.exp(-ty), Math.exp(-tz));
}
