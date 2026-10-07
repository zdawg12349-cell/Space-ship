import {
  BufferAttribute, CustomBlending, DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, UnsignedByteType, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, OneFactor, OneMinusSrcAlphaFactor,
  Quaternion, Scene, ShaderMaterial, Texture, Vector2, Vector3,
} from 'three';

/**
 * Soft, lit particle system for everything gaseous or granular around a launch: steam and
 * smoke billowing out of the flame trench, exhaust trails, deluge water, cryogenic vapour,
 * separation puffs, sparks, fireballs, dust.
 *
 * Particles live in a local tangent frame anchored to a point on the planet (x east, y up,
 * z south), so smoke stays where it was made while the vehicle climbs away, and drifts with the
 * wind. Each frame they are depth-sorted and split around the plume distance into two batches,
 * so a cloud can sit both behind and in front of the flame.
 */

export type ParticleKind = 'steam' | 'smoke' | 'soot' | 'srbsmoke' | 'dust' | 'water' | 'vapor' | 'spark' | 'fire' | 'trail' | 'plasma' | 'regolith';

interface KindDef {
  albedo: [number, number, number];
  /** emission (kcd/m^2 at full heat) */
  emissive: [number, number, number];
  opacity: number;
  /** relative drag toward the wind (1/s) */
  drag: number;
  /** upward acceleration (m/s^2): hot steam rises, cold vapour sinks */
  buoyancy: number;
  gravity: number;
  /** emissive heat decay (1/s) */
  cool: number;
  /** soft edge / noise breakup amount */
  breakup: number;
  /** how quickly opacity thins as the puff expands */
  thin: number;
  /** stretches into streaks along velocity */
  streak: number;
  /** 0 = lit, 1 = unlit additive glow */
  glow: number;
}

const KINDS: Record<ParticleKind, KindDef> = {
  steam: { albedo: [0.9, 0.9, 0.91], emissive: [1.0, 0.55, 0.25], opacity: 0.85, drag: 0.35, buoyancy: 1.6, gravity: 0, cool: 1.6, breakup: 0.7, thin: 0.55, streak: 0, glow: 0 },
  smoke: { albedo: [0.56, 0.52, 0.47], emissive: [1.0, 0.45, 0.12], opacity: 0.8, drag: 0.3, buoyancy: 1.0, gravity: 0, cool: 1.2, breakup: 0.55, thin: 0.5, streak: 0, glow: 0 },
  soot: { albedo: [0.07, 0.065, 0.06], emissive: [1.0, 0.35, 0.08], opacity: 0.85, drag: 0.4, buoyancy: 0.8, gravity: 0, cool: 1.6, breakup: 0.6, thin: 0.6, streak: 0, glow: 0 },
  srbsmoke: { albedo: [0.88, 0.87, 0.85], emissive: [1.0, 0.8, 0.5], opacity: 0.95, drag: 0.25, buoyancy: 0.6, gravity: 0, cool: 1.4, breakup: 0.45, thin: 0.35, streak: 0, glow: 0 },
  dust: { albedo: [0.45, 0.4, 0.32], emissive: [0, 0, 0], opacity: 0.7, drag: 0.8, buoyancy: 0.2, gravity: 0.5, cool: 1, breakup: 0.6, thin: 0.6, streak: 0, glow: 0 },
  water: { albedo: [0.75, 0.78, 0.8], emissive: [0, 0, 0], opacity: 0.55, drag: 0.6, buoyancy: 0, gravity: 9.81, cool: 1, breakup: 0.75, thin: 0.3, streak: 0.6, glow: 0 },
  vapor: { albedo: [0.9, 0.91, 0.93], emissive: [0, 0, 0], opacity: 0.5, drag: 0.9, buoyancy: -1.2, gravity: 0, cool: 1, breakup: 0.65, thin: 0.6, streak: 0, glow: 0 },
  spark: { albedo: [0, 0, 0], emissive: [1.0, 0.65, 0.25], opacity: 1, drag: 0.15, buoyancy: 0, gravity: 9.81, cool: 0.8, breakup: 0, thin: 0, streak: 1, glow: 1 },
  fire: { albedo: [0.1, 0.08, 0.06], emissive: [1.0, 0.5, 0.15], opacity: 0.9, drag: 0.6, buoyancy: 4.0, gravity: 0, cool: 0.9, breakup: 0.5, thin: 0.4, streak: 0, glow: 0 },
  trail: { albedo: [0.8, 0.8, 0.81], emissive: [1.0, 0.6, 0.3], opacity: 0.6, drag: 0.05, buoyancy: 0, gravity: 0, cool: 2.0, breakup: 0.5, thin: 0.7, streak: 0, glow: 0 },
  plasma: { albedo: [0, 0, 0], emissive: [1.0, 0.45, 0.6], opacity: 0.8, drag: 0.5, buoyancy: 0, gravity: 0, cool: 3.0, breakup: 0.4, thin: 0.5, streak: 0.8, glow: 1 },
  regolith: { albedo: [0.32, 0.31, 0.3], emissive: [0, 0, 0], opacity: 0.8, drag: 0, buoyancy: 0, gravity: 1.62, cool: 1, breakup: 0.5, thin: 0.6, streak: 0.4, glow: 0 },
};
const KIND_LIST = Object.keys(KINDS) as ParticleKind[];
const KIND_INDEX = new Map(KIND_LIST.map((k, i) => [k, i] as const));

export interface EmitOptions {
  kind: ParticleKind;
  /** local-frame position (m) */
  pos: Vector3;
  vel: Vector3;
  /** random velocity spread (m/s, isotropic) */
  spread?: number;
  /** position jitter radius (m) */
  jitter?: number;
  size: number;
  /** size growth (m/s) */
  grow?: number;
  life: number;
  /** initial emissive heat 0..1 */
  heat?: number;
  opacity?: number;
  /** albedo multiplier (0..1) for variation */
  tint?: number;
  /** multiplier on the kind's drag toward the wind (0 in vacuum) */
  drag?: number;
}

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aParams; // size, alpha, seed, kind
attribute vec4 aExtra;  // heat, age fraction, stretch, glow
attribute vec4 aVel;    // velocity, ambient occlusion
attribute vec4 aAlbedo; // albedo, sun visibility through the cloud
uniform vec3 uSunDirV;     // view space
uniform vec3 uSunIrr;      // klux-ish RGB
uniform vec3 uAmbient;
uniform vec3 uLightPos[3]; // view space
uniform vec3 uLightCol[3]; // colour * intensity
uniform vec3 uEmissive[12];
uniform float uExposureHint;
varying vec2 vUv;
varying vec4 vParams;
varying vec4 vExtra;
varying vec3 vLight;
varying vec3 vEmis;
varying vec3 vAlbedo;
varying float vDepth;
varying vec2 vRot;
varying vec2 vShade;
void main() {
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  float size = aParams.x;
  float ang = aParams.z * 6.2831 + aExtra.y * (aParams.z - 0.5) * 2.0;
  vec2 c = position.xy;
  // streaking along the projected velocity (sparks, water jets)
  vec3 vv = (modelViewMatrix * vec4(aVel.xyz, 0.0)).xyz;
  vec2 vdir = length(vv.xy) > 1e-4 ? normalize(vv.xy) : vec2(0.0, 1.0);
  float stretch = 1.0 + aExtra.z * min(8.0, length(vv) * 0.06);
  vec2 off;
  if (aExtra.z > 0.0) {
    vec2 perp = vec2(-vdir.y, vdir.x);
    off = (vdir * c.y * stretch + perp * c.x) * size;
    vRot = vec2(1.0, 0.0);
  } else {
    float cs = cos(ang), sn = sin(ang);
    off = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
    vRot = vec2(cs, sn);
  }
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
  vParams = aParams;
  vExtra = aExtra;
  vDepth = -mv.z;
  vAlbedo = aAlbedo.rgb;
  vShade = vec2(aAlbedo.a, aVel.w);
  // lighting at the particle centre
  vec3 centre = (modelViewMatrix * vec4(aPos, 1.0)).xyz;
  vec3 L = uAmbient * aVel.w;
  for (int i = 0; i < 3; i++) {
    vec3 d = uLightPos[i] - centre;
    float d2 = max(dot(d, d), size * size * 0.5 + 4.0);
    L += uLightCol[i] / d2;
  }
  vLight = L;
  int k = int(aParams.w + 0.5);
  vEmis = uEmissive[k] * aExtra.x * aExtra.x;
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uNoise;
uniform sampler2D uPuff;
uniform sampler2D uLinDepth;
uniform vec2 uResolution;
uniform vec3 uSunDirV;
uniform vec3 uSunIrr;
uniform vec3 uAtmT;
uniform float uBreakup[12];
varying vec2 vUv;
varying vec4 vParams;
varying vec4 vExtra;
varying vec3 vLight;
varying vec3 vEmis;
varying vec3 vAlbedo;
varying float vDepth;
varying vec2 vRot;
varying vec2 vShade;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  int k = int(vParams.w + 0.5);
  float seed = vParams.z;
  float age = vExtra.y;
  // rotated uv (the sprite spins slowly as it ages)
  vec2 ruv = vec2(vUv.x * vRot.x - vUv.y * vRot.y, vUv.x * vRot.y + vUv.y * vRot.x);
  vec2 nuv = ruv * 0.22 + vec2(seed * 7.13, seed * 3.71 + age * 0.05);
  float n = texture(uNoise, nuv).r * 0.65 + texture(uNoise, nuv * 2.7 + 0.31).g * 0.35;
  float br = uBreakup[k];
  float dens;
  vec3 N;
  if (vExtra.w > 0.5 || br < 0.01) {
    dens = pow(1.0 - r2, 2.0);
    N = vec3(0.0, 0.0, 1.0);
  } else {
    // cauliflower puff from the atlas: lumpy outline + per-pixel normal
    float cellI = floor(seed * 15.99);
    vec2 cell = vec2(mod(cellI, 4.0), floor(cellI / 4.0));
    vec4 pf = texture(uPuff, (cell + ruv * 0.5 + 0.5) * 0.25);
    // dissolve with age: the threshold climbs so puffs thin from the edges inward
    float thr = mix(0.04, 0.5, age * age) * br;
    dens = smoothstep(thr, thr + 0.35, pf.a * (0.8 + 0.4 * n));
    vec2 nxy = pf.xy * 2.0 - 1.0;
    // rotate the atlas normal back into screen orientation
    nxy = vec2(nxy.x * vRot.x + nxy.y * vRot.y, -nxy.x * vRot.y + nxy.y * vRot.x);
    N = normalize(vec3(nxy, pf.z * 1.2 + 0.25));
  }
  float alpha = dens * vParams.y;
  // soft intersection with opaque geometry
  float scene = texture(uLinDepth, gl_FragCoord.xy / uResolution).r;
  alpha *= clamp((scene - vDepth) / max(0.5, vParams.x * 0.6), 0.0, 1.0);
  if (alpha < 0.003) discard;
  float ndl = dot(N, uSunDirV);
  float wrap = clamp((ndl + 0.45) / 1.45, 0.0, 1.0);
  // sun visibility through the rest of the cloud (density grid march) + per-pixel shading
  float vis = vShade.x;
  float selfShadow = mix(0.22, 1.0, wrap) * vis;
  // forward scattering when looking toward the sun (silver lining on thin edges)
  float fwd = pow(clamp(-uSunDirV.z, 0.0, 1.0), 6.0) * (1.0 - dens) * 1.5 * vis;
  // multiple scattering keeps shadowed parts from going black; sky light from above
  float skyN = 0.55 + 0.45 * N.y;
  vec3 lit = vAlbedo * (uSunIrr * (selfShadow + fwd + 0.3 * (1.0 - vis) * vShade.y) + vLight * skyN) / 3.14159;
  vec3 col = lit + vEmis * (0.6 + 0.8 * n);
  col *= uAtmT;
  if (vExtra.w > 0.5) { gl_FragColor = vec4(col * alpha, 0.0); return; }
  gl_FragColor = vec4(col * alpha, alpha);
}`;

const _v = new Vector3();
const _q = new Quaternion();

/**
 * 4x4 atlas of cauliflower-shaped puffs. Each cell is a cluster of overlapping spheres whose
 * upper envelope gives a lumpy outline and a height field; we store the envelope normal (xy),
 * its height (z) and a soft coverage (a).
 */
function createPuffAtlas(): DataTexture {
  const C = 128, S = C * 4;
  const data = new Uint8Array(S * S * 4);
  let seed = 4242;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const hf = new Float32Array(C * C);
  for (let cell = 0; cell < 16; cell++) {
    const spheres: [number, number, number][] = [];
    // big core blobs + smaller surface billows
    const nBig = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < nBig; i++) {
      const a = rnd() * Math.PI * 2, r = rnd() * 0.25;
      spheres.push([Math.cos(a) * r, Math.sin(a) * r, 0.38 + rnd() * 0.18]);
    }
    const nSmall = 14 + Math.floor(rnd() * 10);
    for (let i = 0; i < nSmall; i++) {
      const a = rnd() * Math.PI * 2, r = 0.3 + rnd() * 0.42;
      spheres.push([Math.cos(a) * r, Math.sin(a) * r, 0.1 + rnd() * 0.16]);
    }
    for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
      const u = ((x + 0.5) / C) * 2 - 1, v = ((y + 0.5) / C) * 2 - 1;
      let h = 0;
      for (const [sx, sy, sr] of spheres) {
        const d2 = (u - sx) * (u - sx) + (v - sy) * (v - sy);
        if (d2 < sr * sr) h = Math.max(h, Math.sqrt(sr * sr - d2) + (sr > 0.3 ? 0 : 0.18));
      }
      // keep the puff inside the sprite
      h *= Math.max(0, Math.min(1, (1 - Math.hypot(u, v)) * 6));
      hf[y * C + x] = h;
    }
    const cx = (cell % 4) * C, cy = Math.floor(cell / 4) * C;
    for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
      const h = hf[y * C + x];
      const hx = hf[y * C + Math.min(C - 1, x + 1)] - hf[y * C + Math.max(0, x - 1)];
      const hy = hf[Math.min(C - 1, y + 1) * C + x] - hf[Math.max(0, y - 1) * C + x];
      const k = C * 0.5;
      let nx = -hx * k * 0.5, ny = -hy * k * 0.5, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = ((cy + y) * S + cx + x) * 4;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(Math.min(1, h * 1.6) * 255);
      data[o + 3] = Math.round(Math.min(1, h * 3.2) * 255);
    }
  }
  const tex = new DataTexture(data, S, S, RGBAFormat, UnsignedByteType);
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Pool of particles in an anchored local frame, drawn as two depth-split instanced batches. */
export class ParticleSystem {
  readonly max: number;
  count = 0;
  // state (local frame)
  private px: Float32Array; private py: Float32Array; private pz: Float32Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array;
  private age: Float32Array; private life: Float32Array; private size: Float32Array; private grow: Float32Array;
  private heat: Float32Array; private alpha0: Float32Array; private seed: Float32Array; private kind: Uint8Array; private tint: Float32Array;
  private size0: Float32Array;
  private dragMul: Float32Array;
  // render
  private batches: { mesh: Mesh; geo: InstancedBufferGeometry; aPos: InstancedBufferAttribute; aParams: InstancedBufferAttribute; aExtra: InstancedBufferAttribute; aVel: InstancedBufferAttribute; aAlbedo: InstancedBufferAttribute }[] = [];
  readonly material: ShaderMaterial;
  private order: Uint32Array;
  private depth: Float32Array;
  private bucketCount = new Uint32Array(2048);
  /** local frame -> world (camera-relative) */
  readonly frameQuat = new Quaternion();
  readonly framePos = new Vector3();
  /** ground height in the local frame (smoke stops at the ground) */
  groundY = 0;
  /** radius of the anchor body (ground curvature in the tangent frame) */
  bodyRadius = 6_371_000;
  /** wind in the local frame (m/s) */
  readonly wind = new Vector3();
  private resolution = new Vector2(1, 1);
  private time = 0;
  // coarse density grid around the anchor for cloud self-shadowing
  private static readonly GX = 60; private static readonly GY = 15; private static readonly GZ = 60; private static readonly CELL = 24;
  private grid = new Float32Array(ParticleSystem.GX * ParticleSystem.GY * ParticleSystem.GZ);
  private alphaTmp: Float32Array;
  private vis: Float32Array;
  private ao: Float32Array;
  /** sun direction in the local frame */
  readonly sunLocal = new Vector3(0, 1, 0);

  constructor(scene: Scene, noise: Texture, private readonly linDepth: () => Texture, max = 6000) {
    this.max = max;
    const F = () => new Float32Array(max);
    this.px = F(); this.py = F(); this.pz = F(); this.vx = F(); this.vy = F(); this.vz = F();
    this.age = F(); this.life = F(); this.size = F(); this.grow = F(); this.heat = F(); this.alpha0 = F(); this.seed = F(); this.tint = F(); this.size0 = F(); this.dragMul = F();
    this.kind = new Uint8Array(max);
    this.order = new Uint32Array(max);
    this.alphaTmp = new Float32Array(max);
    this.vis = new Float32Array(max);
    this.ao = new Float32Array(max);
    this.depth = new Float32Array(max);
    const emissive: Vector3[] = [];
    const breakup: number[] = [];
    for (let i = 0; i < 12; i++) {
      const k = KINDS[KIND_LIST[i]] ?? KINDS.steam;
      emissive.push(new Vector3(...k.emissive).multiplyScalar(i < KIND_LIST.length ? (k.glow > 0 ? 60 : 25) : 0));
      breakup.push(k.breakup);
    }
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      uniforms: {
        uNoise: { value: noise }, uPuff: { value: createPuffAtlas() }, uLinDepth: { value: null }, uResolution: { value: this.resolution },
        uSunDirV: { value: new Vector3(0, 1, 0) }, uSunIrr: { value: new Vector3(100, 100, 100) }, uAmbient: { value: new Vector3(10, 12, 15) },
        uLightPos: { value: [new Vector3(), new Vector3(), new Vector3()] }, uLightCol: { value: [new Vector3(), new Vector3(), new Vector3()] },
        uEmissive: { value: emissive }, uBreakup: { value: breakup }, uAtmT: { value: new Vector3(1, 1, 1) }, uExposureHint: { value: 1 },
      },
    });
    for (let b = 0; b < 2; b++) {
      const geo = new InstancedBufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      const mk = (n: number) => { const a = new InstancedBufferAttribute(new Float32Array(max * n), n); a.setUsage(DynamicDrawUsage); return a; };
      const aPos = mk(3), aParams = mk(4), aExtra = mk(4), aVel = mk(4), aAlbedo = mk(4);
      geo.setAttribute('aPos', aPos); geo.setAttribute('aParams', aParams); geo.setAttribute('aExtra', aExtra); geo.setAttribute('aVel', aVel); geo.setAttribute('aAlbedo', aAlbedo);
      geo.instanceCount = 0;
      const mesh = new Mesh(geo, this.material);
      mesh.frustumCulled = false;
      mesh.renderOrder = b === 0 ? 5 : 15; // far batch before the plumes, near batch after
      scene.add(mesh);
      this.batches.push({ mesh, geo, aPos, aParams, aExtra, aVel, aAlbedo });
    }
  }

  emit(o: EmitOptions, n = 1): void {
    const kd = KINDS[o.kind];
    const ki = KIND_INDEX.get(o.kind)!;
    for (let j = 0; j < n; j++) {
      let i: number;
      if (this.count < this.max) i = this.count++;
      else {
        // pool full: recycle the oldest-looking particle (highest age fraction) from a small sample
        let best = 0, bestF = -1;
        for (let s = 0; s < 8; s++) {
          const c = (Math.random() * this.count) | 0;
          const f = this.age[c] / this.life[c];
          if (f > bestF) { bestF = f; best = c; }
        }
        i = best;
      }
      const jt = o.jitter ?? 0, sp = o.spread ?? 0;
      this.px[i] = o.pos.x + (Math.random() - 0.5) * 2 * jt;
      this.py[i] = o.pos.y + (Math.random() - 0.5) * 2 * jt;
      this.pz[i] = o.pos.z + (Math.random() - 0.5) * 2 * jt;
      this.vx[i] = o.vel.x + (Math.random() - 0.5) * 2 * sp;
      this.vy[i] = o.vel.y + (Math.random() - 0.5) * 2 * sp;
      this.vz[i] = o.vel.z + (Math.random() - 0.5) * 2 * sp;
      this.age[i] = 0;
      this.life[i] = o.life * (0.75 + Math.random() * 0.5);
      this.size[i] = o.size * (0.8 + Math.random() * 0.4);
      this.size0[i] = this.size[i];
      this.grow[i] = (o.grow ?? 0) * (0.7 + Math.random() * 0.6);
      this.heat[i] = o.heat ?? 0;
      this.alpha0[i] = (o.opacity ?? 1) * kd.opacity;
      this.seed[i] = Math.random();
      this.kind[i] = ki;
      this.tint[i] = (o.tint ?? 1) * (0.88 + Math.random() * 0.24);
      this.dragMul[i] = o.drag ?? 1;
    }
  }

  /** Re-express all particles in a new local frame: p' = R p + t (positions), v' = R v. */
  reframe(R: Quaternion, t: Vector3): void {
    for (let i = 0; i < this.count; i++) {
      _v.set(this.px[i], this.py[i], this.pz[i]).applyQuaternion(R).add(t);
      this.px[i] = _v.x; this.py[i] = _v.y; this.pz[i] = _v.z;
      _v.set(this.vx[i], this.vy[i], this.vz[i]).applyQuaternion(R);
      this.vx[i] = _v.x; this.vy[i] = _v.y; this.vz[i] = _v.z;
    }
  }

  clear(): void { this.count = 0; for (const b of this.batches) b.geo.instanceCount = 0; }

  private kill(i: number): void {
    const j = --this.count;
    if (i === j) return;
    this.px[i] = this.px[j]; this.py[i] = this.py[j]; this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
    this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.size[i] = this.size[j]; this.grow[i] = this.grow[j];
    this.heat[i] = this.heat[j]; this.alpha0[i] = this.alpha0[j]; this.seed[i] = this.seed[j]; this.kind[i] = this.kind[j]; this.tint[i] = this.tint[j];
    this.size0[i] = this.size0[j]; this.dragMul[i] = this.dragMul[j];
  }

  /**
   * @param camLocal camera position in the local frame
   * @param camFwdLocal camera forward in the local frame
   * @param splitDist distance from the camera separating the far and near batches (plume)
   */
  update(dt: number, camLocal: Vector3, camFwdLocal: Vector3, splitDist: number, resolution: Vector2): void {
    this.time += dt;
    this.resolution.copy(resolution);
    const wx = this.wind.x, wy = this.wind.y, wz = this.wind.z;
    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.kill(i); i--; continue; }
      const kd = KINDS[KIND_LIST[this.kind[i]]];
      const k = Math.min(1, kd.drag * this.dragMul[i] * dt);
      this.vx[i] += (wx - this.vx[i]) * k;
      this.vz[i] += (wz - this.vz[i]) * k;
      this.vy[i] += (wy - this.vy[i]) * k * (kd.gravity > 0 ? 0.2 : 1) + (kd.buoyancy * Math.max(0.2, this.heat[i] + 0.3) - kd.gravity) * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      // the ground: clouds roll along it, water splashes and dies
      const r = this.size[i] * 0.35;
      // the local frame is a tangent plane: the ground falls away with distance (curvature)
      const h2 = this.px[i] * this.px[i] + this.pz[i] * this.pz[i];
      const gy = this.groundY - h2 / (2 * this.bodyRadius);
      if (h2 < 4e10 && this.py[i] < gy + r) {
        if (kd.gravity > 5) { this.kill(i); i--; continue; }
        this.py[i] = gy + r;
        if (this.vy[i] < 0) {
          // convert downward momentum into radial spread
          const sp = -this.vy[i] * 0.6;
          const h = Math.hypot(this.vx[i], this.vz[i]) || 1;
          this.vx[i] += (this.vx[i] / h) * sp; this.vz[i] += (this.vz[i] / h) * sp;
          this.vy[i] = 0;
        }
      }
      this.size[i] += this.grow[i] * dt * (1 - 0.5 * this.age[i] / this.life[i]);
      this.heat[i] = Math.max(0, this.heat[i] - kd.cool * dt * (0.4 + this.heat[i]));
    }
    this.shade();
    // depth sort (counting sort on quantised view depth, far first)
    const n = this.count;
    const cx = camLocal.x, cy = camLocal.y, cz = camLocal.z, fx = camFwdLocal.x, fy = camFwdLocal.y, fz = camFwdLocal.z;
    let dmax = 1;
    for (let i = 0; i < n; i++) {
      const d = (this.px[i] - cx) * fx + (this.py[i] - cy) * fy + (this.pz[i] - cz) * fz;
      this.depth[i] = d;
      if (d > dmax) dmax = d;
    }
    const B = this.bucketCount.length;
    this.bucketCount.fill(0);
    const scale = (B - 1) / Math.sqrt(dmax);
    const bucketOf = (d: number) => B - 1 - Math.min(B - 1, Math.max(0, Math.floor(Math.sqrt(Math.max(0, d)) * scale)));
    for (let i = 0; i < n; i++) this.bucketCount[bucketOf(this.depth[i])]++;
    let acc = 0;
    for (let b = 0; b < B; b++) { const c = this.bucketCount[b]; this.bucketCount[b] = acc; acc += c; }
    for (let i = 0; i < n; i++) this.order[this.bucketCount[bucketOf(this.depth[i])]++] = i;
    // fill batches
    const far = this.batches[0], near = this.batches[1];
    let nf = 0, nn = 0;
    for (let o = 0; o < n; o++) {
      const i = this.order[o];
      if (this.depth[i] < -this.size[i]) continue; // behind the camera
      const b = this.depth[i] > splitDist ? far : near;
      const w = b === far ? nf++ : nn++;
      const kd = KINDS[KIND_LIST[this.kind[i]]];
      const f = this.age[i] / this.life[i];
      const alpha = this.alphaTmp[i];
      b.aPos.setXYZ(w, this.px[i], this.py[i], this.pz[i]);
      b.aParams.setXYZW(w, this.size[i], alpha, this.seed[i], this.kind[i]);
      b.aExtra.setXYZW(w, this.heat[i], f, kd.streak, kd.glow);
      b.aVel.setXYZW(w, this.vx[i], this.vy[i], this.vz[i], this.ao[i]);
      const t = this.tint[i];
      b.aAlbedo.setXYZW(w, kd.albedo[0] * t, kd.albedo[1] * t, kd.albedo[2] * t, this.vis[i]);
    }
    for (const [b, c] of [[far, nf], [near, nn]] as const) {
      b.geo.instanceCount = c;
      for (const a of [b.aPos, b.aParams, b.aExtra, b.aVel, b.aAlbedo]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, c * a.itemSize);
        a.needsUpdate = true;
      }
      b.mesh.position.copy(this.framePos);
      b.mesh.quaternion.copy(this.frameQuat);
      b.mesh.visible = c > 0;
    }
    this.material.uniforms.uLinDepth.value = this.linDepth();
  }

  /** Per-particle opacity, then sun visibility / ambient occlusion from a coarse density grid. */
  private shade(): void {
    const n = this.count;
    const { GX, GY, GZ, CELL } = ParticleSystem;
    const g = this.grid;
    g.fill(0);
    const x0 = -GX * CELL * 0.5, z0 = -GZ * CELL * 0.5, y0 = this.groundY;
    const inv = 1 / CELL;
    const V = CELL * CELL * CELL;
    for (let i = 0; i < n; i++) {
      const kd = KINDS[KIND_LIST[this.kind[i]]];
      const f = this.age[i] / this.life[i];
      const fadeIn = Math.min(1, this.age[i] / Math.min(0.6, this.life[i] * 0.1));
      const fadeOut = 1 - f * f * f;
      const thin = Math.pow(this.size0[i] / Math.max(this.size0[i], this.size[i]), kd.thin);
      const a = this.alpha0[i] * fadeIn * fadeOut * thin;
      this.alphaTmp[i] = a;
      if (kd.glow > 0) continue;
      const gx = Math.floor((this.px[i] - x0) * inv), gy = Math.floor((this.py[i] - y0) * inv), gz = Math.floor((this.pz[i] - z0) * inv);
      if (gx < 0 || gy < 0 || gz < 0 || gx >= GX || gy >= GY || gz >= GZ) continue;
      const sz = this.size[i];
      g[(gy * GZ + gz) * GX + gx] += (2.09 * a * sz * sz) / V;
    }
    const sample = (x: number, y: number, z: number) => {
      const fx = (x - x0) * inv - 0.5, fy = (y - y0) * inv - 0.5, fz = (z - z0) * inv - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      if (ix < 0 || iy < 0 || iz < 0 || ix >= GX - 1 || iy >= GY - 1 || iz >= GZ - 1) return 0;
      const tx = fx - ix, ty = fy - iy, tz = fz - iz;
      const b = (iy * GZ + iz) * GX + ix;
      const c00 = g[b] * (1 - tx) + g[b + 1] * tx, c01 = g[b + GX] * (1 - tx) + g[b + GX + 1] * tx;
      const b2 = b + GX * GZ;
      const c10 = g[b2] * (1 - tx) + g[b2 + 1] * tx, c11 = g[b2 + GX] * (1 - tx) + g[b2 + GX + 1] * tx;
      return ((c00 * (1 - tz) + c01 * tz) * (1 - ty) + (c10 * (1 - tz) + c11 * tz) * ty);
    };
    const sx = this.sunLocal.x * CELL, sy = this.sunLocal.y * CELL, sz = this.sunLocal.z * CELL;
    for (let i = 0; i < n; i++) {
      const px = this.px[i], py = this.py[i], pz = this.pz[i];
      let tau = 0;
      for (let k = 1; k <= 8; k++) tau += sample(px + sx * k, py + sy * k, pz + sz * k);
      tau *= CELL;
      // the sun below the horizon is blocked by the ground for low clouds anyway
      this.vis[i] = Math.exp(-tau * 0.5);
      this.ao[i] = Math.exp(-sample(px, py, pz) * 14) * 0.7 + 0.3 * Math.min(1, (py - this.groundY) / 60 + 0.4);
    }
  }

  /** Lighting inputs (world = camera-relative). */
  setLighting(sunDirWorld: Vector3, sunIrr: Vector3, ambient: Vector3, viewMatrix: { elements: ArrayLike<number> }, lights: { pos: Vector3; color: { r: number; g: number; b: number }; intensity: number }[], atmT: Vector3): void {
    const u = this.material.uniforms;
    const m = viewMatrix.elements;
    // rotate the sun direction into view space (no translation)
    const sx = sunDirWorld.x, sy = sunDirWorld.y, sz = sunDirWorld.z;
    (u.uSunDirV.value as Vector3).set(m[0] * sx + m[4] * sy + m[8] * sz, m[1] * sx + m[5] * sy + m[9] * sz, m[2] * sx + m[6] * sy + m[10] * sz).normalize();
    (u.uSunIrr.value as Vector3).copy(sunIrr);
    this.dirToLocal(sunDirWorld, this.sunLocal).normalize();
    (u.uAmbient.value as Vector3).copy(ambient);
    (u.uAtmT.value as Vector3).copy(atmT);
    const lp = u.uLightPos.value as Vector3[], lc = u.uLightCol.value as Vector3[];
    for (let i = 0; i < 3; i++) {
      const L = lights[i];
      if (!L || L.intensity <= 0) { lc[i].set(0, 0, 0); continue; }
      const p = L.pos;
      lp[i].set(m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12], m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13], m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]);
      lc[i].set(L.color.r, L.color.g, L.color.b).multiplyScalar(L.intensity);
    }
  }

  /** World (camera-relative) -> local frame. */
  toLocal(world: Vector3, out: Vector3): Vector3 {
    _q.copy(this.frameQuat).invert();
    return out.copy(world).sub(this.framePos).applyQuaternion(_q);
  }

  /** Direction world -> local. */
  dirToLocal(world: Vector3, out: Vector3): Vector3 {
    _q.copy(this.frameQuat).invert();
    return out.copy(world).applyQuaternion(_q);
  }

  get stats(): { count: number; max: number } { return { count: this.count, max: this.max }; }
}

