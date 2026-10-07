import {
  AdditiveBlending, BufferGeometry, CustomBlending, DoubleSide, Float32BufferAttribute, Group, Mesh, OneFactor, OneMinusSrcAlphaFactor, Quaternion,
  Scene, ShaderMaterial, Vector3,
} from 'three';
import type { Vessel } from '../physics/vessel';
import type { VesselVisuals } from '../render/vehicle/VesselVisuals';

/**
 * Flow-attached aerodynamic visuals, drawn with the transparent FX after the atmosphere
 * composite:
 *
 *  - Transonic vapour cone: around Mach 1 the air expanding over the vehicle's shoulder drops
 *    below its dew point and a condensation collar flashes into view for a few seconds,
 *    streaming aft. Needs moist, dense air.
 *  - Entry plasma sheath: the shock layer ahead of a vehicle entering at orbital speed glows
 *    white-orange at the stagnation point, fading to pink and violet along the flanks.
 *
 * Shapes are expressed in the vehicle frame and follow the vessel's render group.
 */

const NOISE = /* glsl */ `
float ae_hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float ae_noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ae_hash(i), ae_hash(i + vec2(1, 0)), u.x), mix(ae_hash(i + vec2(0, 1)), ae_hash(i + vec2(1, 1)), u.x), u.y); }
float ae_fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * ae_noise(p); p *= 2.03; a *= 0.5; } return s; }
`;

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

/** Lathe surface of revolution around +Y: profile of (radius, y) with u around, v along. */
function shell(profile: [number, number][], segs: number): BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const [r, y] = profile[i];
    const [rp, yp] = profile[Math.max(0, i - 1)], [rn, yn] = profile[Math.min(n - 1, i + 1)];
    // profile normal (2D): perpendicular to the tangent, pointing outward
    let dr = rn - rp, dy = yn - yp;
    const l = Math.hypot(dr, dy) || 1;
    dr /= l; dy /= l;
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      pos.push(r * c, y, r * s);
      nor.push(dy * c, -dr, dy * s);
      uv.push(k / segs, i / (n - 1));
    }
  }
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < segs; k++) {
    const a = i * (segs + 1) + k, b = a + segs + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function vaporMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uI: { value: 0 }, uTime: { value: 0 }, uLight: { value: new Vector3(1, 1, 1) }, uSeed: { value: 0 } },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      uniform float uI;
      uniform float uTime;
      uniform vec3 uLight;
      uniform float uSeed;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vView;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${NOISE}
      void main() {
        #include <logdepthbuf_fragment>
        float v = vUv.y;
        // sharp leading edge at the shoulder, ragged dissolving trailing edge
        float n = ae_fbm(vec2(vUv.x * 26.0 + uSeed, v * 3.5 - uTime * 7.0));
        float n2 = ae_noise(vec2(vUv.x * 70.0 - uSeed, v * 9.0 - uTime * 11.0));
        float tail = 1.0 - smoothstep(0.25 + 0.45 * n, 0.95, v);
        float a = uI * smoothstep(0.0, 0.06, v) * tail * (0.35 + 0.85 * n) * (0.75 + 0.5 * n2);
        // the collar is a thin sheet: denser where we look along it
        vec3 N = normalize(vN), V = normalize(vView);
        a *= 0.3 + 0.7 * pow(1.0 - abs(dot(N, V)), 1.5);
        a = clamp(a, 0.0, 0.85);
        gl_FragColor = vec4(uLight * a, a);
      }`,
    transparent: true, depthWrite: false, side: DoubleSide,
    blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor,
  });
}

const VERT_X = VERT.replace('varying vec2 vUv;', 'varying vec2 vUv;\nvarying float vX;').replace('vUv = uv;', 'vUv = uv;\n  vX = position.y;');

function plasmaMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uI: { value: 0 }, uTime: { value: 0 }, uLum: { value: 40 }, uSeed: { value: 0 } },
    vertexShader: VERT_X,
    fragmentShader: /* glsl */ `
      uniform float uI;
      uniform float uTime;
      uniform float uLum;
      uniform float uSeed;
      varying vec2 vUv;
      varying float vX;
      varying vec3 vN;
      varying vec3 vView;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${NOISE}
      void main() {
        #include <logdepthbuf_fragment>
        // x: distance downstream of the stagnation point (body radii)
        float x = -vX;
        vec3 N = normalize(vN), V = normalize(vView);
        // optically thin glowing layer: brightest where the line of sight grazes it
        float fr = pow(1.0 - abs(dot(N, V)), 1.4);
        float n = ae_fbm(vec2(vUv.x * 18.0 + uSeed, x * 2.2 - uTime * 9.0));
        float n2 = ae_noise(vec2(vUv.x * 46.0 - uSeed, x * 6.0 - uTime * 15.0));
        // stagnation cap, shoulder (where the shock layer wraps round the edge) and the wake
        float cap = exp(-x * 5.0);
        float shoulder = exp(-pow((x - 0.45) / 0.25, 2.0));
        float wake = exp(-x * 0.75) * smoothstep(0.3, 0.8, x) * (1.0 - smoothstep(3.6, 4.6, x));
        float glow = uI * (cap * 1.4 + shoulder * 0.8 * (0.5 + fr) + wake * (0.35 + 0.9 * fr) * (0.5 + 0.9 * n2)) * (0.65 + 0.7 * n);
        vec3 hot = vec3(1.0, 0.86, 0.62), mid = vec3(1.0, 0.46, 0.16), edge = vec3(0.9, 0.3, 0.62);
        vec3 col = mix(hot, mid, smoothstep(0.03, 0.4, x));
        col = mix(col, edge, smoothstep(0.6, 2.6, x) * 0.8 + fr * 0.15);
        gl_FragColor = vec4(col * glow * uLum, 1.0);
      }`,
    transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending,
  });
}

interface Shells {
  holder: Group;
  vapor: Mesh;
  vaporMat: ShaderMaterial;
  sheath: Mesh;
  sheathMat: ShaderMaterial;
  /** vapour intensity (smoothed) */
  vi: number;
  pi: number;
  sig: string;
  station: number;
  stationR: number;
  y0: number;
  y1: number;
  R: number;
  seed: number;
}

const _air = new Vector3();
const _q = new Quaternion();
const _Y = new Vector3(0, 1, 0);
const _h = new Vector3();

export class AeroShells {
  private items = new Map<Vessel, Shells>();
  private vaporGeo = shell(Array.from({ length: 14 }, (_, i) => {
    const s = i / 13;
    return [1.02 + 0.95 * Math.pow(s, 0.65), -s * 1.7] as [number, number];
  }), 48);
  // bow shock hugging the leading face (r = sqrt(2 Rs x), Rs ~ 2.4 body radii), then the
  // luminous wake converging behind the vehicle
  private sheathGeo = shell([
    [0, 0], [0.31, -0.02], [0.54, -0.06], [0.76, -0.12], [0.98, -0.2], [1.2, -0.3], [1.38, -0.4], [1.47, -0.5],
    [1.45, -0.7], [1.3, -1.0], [1.08, -1.5], [0.82, -2.2], [0.55, -3.0], [0.32, -3.8], [0.12, -4.6],
  ], 40);
  private time = 0;
  /** 0..1 moisture available for condensation (weather) */
  humidity = 0.8;

  constructor(private readonly scene: Scene) {}

  clear(): void {
    for (const s of this.items.values()) this.scene.remove(s.holder);
    this.items.clear();
  }

  /**
   * @param light vapour lighting: sun + sky radiance reaching the vehicle (HDR, already / pi)
   */
  update(dt: number, vessels: Vessel[], visuals: VesselVisuals, light: Vector3): void {
    this.time += dt;
    const alive = new Set<Vessel>();
    for (const v of vessels) {
      const g = visuals.groupOf(v);
      if (!g || v.destroyed || !g.visible) continue;
      const tm = v.telemetry;
      // only vessels that can show either effect get shells
      const transonic = tm.inAtmosphere && tm.mach > 0.8 && tm.mach < 1.4;
      if (!transonic && v.plasmaIntensity < 0.02 && !this.items.has(v)) continue;
      alive.add(v);
      let s = this.items.get(v);
      if (!s) s = this.create(v);
      this.refreshShape(v, s);
      s.holder.position.copy(g.position);
      s.holder.quaternion.copy(g.quaternion);
      // ---------------------------------------------------------------- vapour cone
      const M = tm.mach;
      const rho = tm.density / 1.225;
      let target = 0;
      if (tm.inAtmosphere && v.hasLiftedOff) {
        target = smooth(0.86, 0.96, M) * (1 - smooth(1.06, 1.28, M)) * smooth(0.12, 0.4, rho) * this.humidity;
        // flickers as the shock wanders over the shoulder
        target *= 0.75 + 0.25 * Math.sin(this.time * 23 + s.seed) * Math.sin(this.time * 7.3);
      }
      s.vi += (target - s.vi) * Math.min(1, dt * 6);
      s.vapor.visible = s.vi > 0.01;
      if (s.vapor.visible) {
        s.vapor.position.set(0, s.station, 0);
        const k = s.stationR * (1 + 0.35 * s.vi);
        s.vapor.scale.set(k, s.stationR * (0.8 + 1.2 * s.vi), k);
        const u = s.vaporMat.uniforms;
        u.uI.value = s.vi;
        u.uTime.value = this.time;
        (u.uLight.value as Vector3).copy(light);
      }
      // ---------------------------------------------------------------- plasma sheath
      s.pi += (Math.min(1.6, v.plasmaIntensity) - s.pi) * Math.min(1, dt * 4);
      const speed = tm.airVelocity.length();
      s.sheath.visible = s.pi > 0.02 && speed > 300;
      if (s.sheath.visible) {
        // flow direction in the vehicle frame (the side meeting the air leads)
        _q.copy(v.rot).invert();
        const a = _air.copy(tm.airVelocity).applyQuaternion(_q).normalize();
        const ay = a.y, ah = Math.sqrt(Math.max(0, 1 - ay * ay));
        const mid = (s.y0 + s.y1) / 2;
        const endY = ay > 0 ? s.y1 : s.y0;
        const yS = Math.abs(ay) > 0.3 ? endY : mid + (endY - mid) * (Math.abs(ay) / 0.3);
        _h.set(a.x, 0, a.z);
        if (_h.lengthSq() > 1e-8) _h.normalize().multiplyScalar(s.R * Math.min(1, ah * 3));
        const reff = Math.max(s.R, s.R * Math.abs(ay) + 0.5 * (s.y1 - s.y0) * ah);
        const standoff = 0.12 * reff;
        s.sheath.position.set(_h.x, yS, _h.z).addScaledVector(a, standoff);
        s.sheath.quaternion.setFromUnitVectors(_Y, a);
        s.sheath.scale.setScalar(reff * (1 + 0.1 * s.pi));
        const u = s.sheathMat.uniforms;
        u.uI.value = Math.min(1.2, s.pi);
        u.uTime.value = this.time;
        u.uLum.value = 14 + 50 * Math.min(1, s.pi);
      }
    }
    for (const [v, s] of this.items) {
      if (!alive.has(v) || (!s.vapor.visible && !s.sheath.visible && s.vi < 0.005 && s.pi < 0.005 && !(v.telemetry.mach > 0.8 && v.telemetry.mach < 1.4))) {
        this.scene.remove(s.holder);
        this.items.delete(v);
      }
    }
  }

  private create(v: Vessel): Shells {
    const holder = new Group();
    holder.name = `aero-${v.id}`;
    const vaporMat = vaporMaterial();
    const sheathMat = plasmaMaterial();
    const seed = (v.id * 7.31) % 100;
    vaporMat.uniforms.uSeed.value = seed;
    sheathMat.uniforms.uSeed.value = seed;
    const vapor = new Mesh(this.vaporGeo, vaporMat);
    const sheath = new Mesh(this.sheathGeo, sheathMat);
    vapor.frustumCulled = false;
    sheath.frustumCulled = false;
    vapor.renderOrder = 5;
    sheath.renderOrder = 6;
    holder.add(vapor, sheath);
    this.scene.add(holder);
    const s: Shells = { holder, vapor, vaporMat, sheath, sheathMat, vi: 0, pi: 0, sig: '', station: 0, stationR: 1, y0: 0, y1: 1, R: 1, seed };
    this.items.set(v, s);
    return s;
  }

  /** Vehicle extents and the shoulder where the vapour collar forms (re-derived after staging). */
  private refreshShape(v: Vessel, s: Shells): void {
    const sig = v.assemblies.map((a) => a.def.id).join(',');
    if (sig === s.sig) return;
    s.sig = sig;
    let y0 = Infinity, y1 = -Infinity, R = 0.5;
    let shoulderY = -Infinity, shoulderR = 0;
    for (const a of v.assemblies) {
      y0 = Math.min(y0, a.bottomY);
      y1 = Math.max(y1, a.topY);
      const off = Math.hypot(a.offX, a.offZ);
      R = Math.max(R, a.maxRadius + off * 0.5);
      if (off > 0.01) continue;
      for (const sec of a.def.sections) {
        // the base of the uppermost nose / fairing taper: flow accelerates over that shoulder
        const top = sec.topRadius ?? sec.radius;
        const tapering = (sec.kind === 'nose' || sec.kind === 'fairing' || sec.kind === 'taper' || sec.kind === 'capsule') && top < sec.radius * 0.9;
        if (tapering && sec.y > shoulderY) { shoulderY = sec.y; shoulderR = sec.radius; }
      }
    }
    s.y0 = isFinite(y0) ? y0 : 0;
    s.y1 = isFinite(y1) ? y1 : 10;
    s.R = R;
    if (!isFinite(shoulderY)) { shoulderY = s.y0 + (s.y1 - s.y0) * 0.8; shoulderR = R; }
    s.station = shoulderY;
    s.stationR = Math.max(0.5, shoulderR);
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
