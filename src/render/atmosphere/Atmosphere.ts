import {
  ClampToEdgeWrapping, FloatType, GLSL3, HalfFloatType, LinearFilter, NoBlending, RGBAFormat, ShaderMaterial, Vector3, WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../util/Fullscreen';
import { AtmosphereParams, earthAtmosphere } from './AtmosphereParams';
import { ATMOSPHERE_COMMON, SKYVIEW_COMMON } from './glsl';

/**
 * Owns the atmosphere look-up tables (transmittance, multiple scattering, sky view) and the
 * uniform block shared by every shader that needs atmospheric lighting.
 */
export class Atmosphere {
  params: AtmosphereParams;
  readonly transmittance: WebGLRenderTarget;
  readonly multiScat: WebGLRenderTarget;
  readonly skyView: WebGLRenderTarget;
  /** uniform block — share by reference into materials */
  readonly uniforms: Record<string, { value: unknown }>;
  private quad = new FullscreenQuad();
  private transMat: ShaderMaterial;
  private msMat: ShaderMaterial;
  private skyMat: ShaderMaterial;
  private dirty = true;

  constructor(params: AtmosphereParams = earthAtmosphere()) {
    this.params = params;
    const opts = (w: number, h: number, type: typeof HalfFloatType | typeof FloatType = HalfFloatType) => new WebGLRenderTarget(w, h, {
      type, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false,
      wrapS: ClampToEdgeWrapping, wrapT: ClampToEdgeWrapping, generateMipmaps: false,
    });
    this.transmittance = opts(256, 64, FloatType);
    this.multiScat = opts(32, 32, FloatType);
    this.skyView = opts(192, 108);
    this.uniforms = {
      uAtmBottom: { value: 0 }, uAtmTop: { value: 0 }, uRayleighScat: { value: new Vector3() }, uRayleighH: { value: 8 },
      uMieScat: { value: 0 }, uMieExt: { value: 0 }, uMieH: { value: 1.2 }, uMieG: { value: 0.8 }, uAbsExt: { value: new Vector3() },
      uAbsCenter: { value: 25 }, uAbsWidth: { value: 30 }, uGroundAlbedo: { value: new Vector3() }, uSunIlluminance: { value: new Vector3() },
      uMultiScatFactor: { value: 1 },
      uTransmittanceLUT: { value: this.transmittance.texture }, uMultiScatLUT: { value: this.multiScat.texture },
      uSkyViewLUT: { value: this.skyView.texture },
    };
    this.applyParams();

    this.transMat = new ShaderMaterial({
      blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: this.uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        ${ATMOSPHERE_COMMON}
        void main() {
          // inverse of transmittanceUV
          float xMu = fromSubUvsToUnit(vUv.x, TRANSMITTANCE_SIZE.x);
          float xR = fromSubUvsToUnit(vUv.y, TRANSMITTANCE_SIZE.y);
          float H = sqrt(uAtmTop * uAtmTop - uAtmBottom * uAtmBottom);
          float rho = H * xR;
          float r = sqrt(rho * rho + uAtmBottom * uAtmBottom);
          float dMin = uAtmTop - r;
          float dMax = rho + H;
          float d = dMin + xMu * (dMax - dMin);
          float mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
          mu = clamp(mu, -1.0, 1.0);
          vec3 ro = vec3(0.0, r, 0.0);
          vec3 rd = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
          float tMax = raySphereNear(ro, rd, uAtmTop);
          const int STEPS = 48;
          float dt = tMax / float(STEPS);
          vec3 od = vec3(0.0);
          for (int i = 0; i < STEPS; i++) {
            vec3 p = ro + rd * (float(i) + 0.5) * dt;
            od += sampleMedium(length(p) - uAtmBottom).extinction * dt;
          }
          gl_FragColor = vec4(exp(-od), 1.0);
        }`,
    });

    this.msMat = new ShaderMaterial({
      blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: this.uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        ${ATMOSPHERE_COMMON}
        // Second-order scattering with isotropic phase, integrated over the sphere (Hillaire 2020 §5.5)
        void main() {
          float u = fromSubUvsToUnit(vUv.x, MULTISCAT_SIZE.x);
          float v = fromSubUvsToUnit(vUv.y, MULTISCAT_SIZE.y);
          float muS = u * 2.0 - 1.0;
          float r = uAtmBottom + clamp(v, 0.0, 1.0) * (uAtmTop - uAtmBottom) + 0.01;
          vec3 ro = vec3(0.0, r, 0.0);
          vec3 sunDir = normalize(vec3(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0));
          const int SQRT_N = 8;
          const float isoPhase = 1.0 / (4.0 * ATM_PI);
          vec3 Lsum = vec3(0.0);
          vec3 fsum = vec3(0.0);
          for (int i = 0; i < SQRT_N; i++) {
            for (int j = 0; j < SQRT_N; j++) {
              float a = (float(i) + 0.5) / float(SQRT_N);
              float b = (float(j) + 0.5) / float(SQRT_N);
              float theta = 2.0 * ATM_PI * a;
              float phi = acos(1.0 - 2.0 * b);
              vec3 rd = vec3(cos(theta) * sin(phi), cos(phi), sin(theta) * sin(phi));
              float tTop = raySphereNear(ro, rd, uAtmTop);
              float tGround = raySphereNear(ro, rd, uAtmBottom);
              bool hitGround = tGround > 0.0;
              float tMax = hitGround ? tGround : tTop;
              const int STEPS = 20;
              float dt = tMax / float(STEPS);
              vec3 T = vec3(1.0);
              vec3 L = vec3(0.0);
              vec3 f = vec3(0.0);
              for (int k = 0; k < STEPS; k++) {
                vec3 p = ro + rd * (float(k) + 0.3) * dt;
                float rr = length(p);
                MediumSample m = sampleMedium(rr - uAtmBottom);
                vec3 sampleT = exp(-m.extinction * dt);
                vec3 sunT = getTransmittance(rr, dot(p / rr, sunDir)) * planetShadow(p, sunDir);
                vec3 S = m.scattering * isoPhase * sunT;
                vec3 Sint = (S - S * sampleT) / max(m.extinction, vec3(1e-9));
                L += T * Sint;
                vec3 fs = m.scattering;
                vec3 fint = (fs - fs * sampleT) / max(m.extinction, vec3(1e-9));
                f += T * fint;
                T *= sampleT;
              }
              if (hitGround) {
                vec3 p = ro + rd * tGround;
                vec3 n = normalize(p);
                float nl = max(0.0, dot(n, sunDir));
                vec3 sunT = getTransmittance(length(p), dot(n, sunDir));
                L += T * sunT * nl * uGroundAlbedo / ATM_PI;
              }
              Lsum += L;
              fsum += f;
            }
          }
          float N = float(SQRT_N * SQRT_N);
          vec3 L2 = Lsum / N;
          vec3 fms = fsum / N;
          vec3 psi = L2 / max(vec3(1e-4), 1.0 - fms);
          gl_FragColor = vec4(psi, 1.0);
        }`,
    });

    this.skyMat = new ShaderMaterial({
      blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: { ...this.uniforms, uCamR: { value: 6371.5 }, uSunZenithCos: { value: 1 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        ${ATMOSPHERE_COMMON}
        ${SKYVIEW_COMMON}
        uniform float uCamR;
        uniform float uSunZenithCos;
        void main() {
          float r = max(uCamR, uAtmBottom + 0.005);
          vec2 uv = vec2(fromSubUvsToUnit(vUv.x, SKYVIEW_SIZE.x), fromSubUvsToUnit(vUv.y, SKYVIEW_SIZE.y));
          float vHorizon = sqrt(max(0.0, r * r - uAtmBottom * uAtmBottom));
          float cosBeta = vHorizon / r;
          float beta = acos(clamp(cosBeta, -1.0, 1.0));
          float zenithHorizonAngle = ATM_PI - beta;
          float viewZenith;
          if (uv.y < 0.5) {
            float coord = 2.0 * uv.y;
            coord = 1.0 - coord;
            coord *= coord;
            coord = 1.0 - coord;
            viewZenith = zenithHorizonAngle * coord;
          } else {
            float coord = uv.y * 2.0 - 1.0;
            coord *= coord;
            viewZenith = zenithHorizonAngle + beta * coord;
          }
          float coordX = uv.x * uv.x;
          float lightViewCos = -(coordX * 2.0 - 1.0);
          float sinVZ = sin(viewZenith);
          vec3 rd = vec3(sinVZ * lightViewCos, cos(viewZenith), sinVZ * sqrt(max(0.0, 1.0 - lightViewCos * lightViewCos)));
          vec3 ro = vec3(0.0, r, 0.0);
          float sz = clamp(uSunZenithCos, -1.0, 1.0);
          vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - sz * sz)), sz, 0.0);
          float tTop = raySphereNear(ro, rd, uAtmTop);
          float tGround = raySphereNear(ro, rd, uAtmBottom);
          float tMax = tGround > 0.0 ? tGround : tTop;
          if (tMax <= 0.0) { gl_FragColor = vec4(0.0); return; }
          int steps = int(clamp(tMax / 6.0, 16.0, 40.0));
          vec3 T;
          vec3 L = integrateScattering(ro, rd, 0.0, tMax, sunDir, steps, T);
          gl_FragColor = vec4(L, 1.0);
        }`,
    });
  }

  applyParams(): void {
    const p = this.params;
    const u = this.uniforms;
    u.uAtmBottom.value = p.bottomRadius;
    u.uAtmTop.value = p.topRadius;
    (u.uRayleighScat.value as Vector3).copy(p.rayleighScattering);
    u.uRayleighH.value = p.rayleighScaleHeight;
    u.uMieScat.value = p.mieScattering;
    u.uMieExt.value = p.mieExtinction;
    u.uMieH.value = p.mieScaleHeight;
    u.uMieG.value = p.mieG;
    (u.uAbsExt.value as Vector3).copy(p.absorptionExtinction);
    u.uAbsCenter.value = p.absorptionCenter;
    u.uAbsWidth.value = p.absorptionWidth;
    (u.uGroundAlbedo.value as Vector3).copy(p.groundAlbedo);
    (u.uSunIlluminance.value as Vector3).copy(p.sunIlluminance);
    u.uMultiScatFactor.value = p.multiScatteringFactor;
    this.dirty = true;
  }

  /** Recompute static LUTs if parameters changed. */
  precompute(renderer: WebGLRenderer): void {
    if (!this.dirty) return;
    const prev = renderer.getRenderTarget();
    this.quad.render(renderer, this.transmittance, this.transMat);
    this.quad.render(renderer, this.multiScat, this.msMat);
    renderer.setRenderTarget(prev);
    this.dirty = false;
  }

  /** Update the sky-view LUT for a camera at radius camR (km) with sun zenith cosine. */
  updateSkyView(renderer: WebGLRenderer, camR: number, sunZenithCos: number): void {
    const u = this.skyMat.uniforms;
    u.uCamR.value = camR;
    u.uSunZenithCos.value = sunZenithCos;
    const prev = renderer.getRenderTarget();
    this.quad.render(renderer, this.skyView, this.skyMat);
    renderer.setRenderTarget(prev);
  }

  // ------------------------------------------------------------------ CPU helpers

  private density(h: number): { r: number; m: number; a: number } {
    const p = this.params;
    return {
      r: Math.exp(-Math.max(h, 0) / p.rayleighScaleHeight),
      m: Math.exp(-Math.max(h, 0) / p.mieScaleHeight),
      a: Math.max(0, 1 - Math.abs(h - p.absorptionCenter) / (0.5 * p.absorptionWidth)),
    };
  }

  /**
   * Transmittance from a point (km, relative to planet centre) toward the sun, including
   * planet shadow. Used to colour sunlight on vehicles and the launch site.
   */
  sunTransmittance(posKm: Vector3, sunDir: Vector3, out: Vector3): Vector3 {
    const p = this.params;
    const r = posKm.length();
    // planet shadow (soft)
    const b = posKm.dot(sunDir);
    let shadow = 1;
    if (b < 0) {
      const c2 = r * r - b * b;
      const R = p.bottomRadius;
      const e0 = R * R - 2 * R * 6, e1 = R * R + 2 * R * 2;
      const t = Math.min(1, Math.max(0, (c2 - e0) / (e1 - e0)));
      shadow = t * t * (3 - 2 * t);
    }
    if (r >= p.topRadius) {
      // above the atmosphere: the ray may still graze it
      const disc = b * b - (r * r - p.topRadius * p.topRadius);
      if (b >= 0 || disc <= 0) return out.set(shadow, shadow, shadow);
    }
    // march to the top of the atmosphere
    const disc = b * b - (r * r - p.topRadius * p.topRadius);
    if (disc < 0) return out.set(shadow, shadow, shadow);
    let tStart = 0;
    let tEnd = -b + Math.sqrt(disc);
    if (r > p.topRadius) tStart = -b - Math.sqrt(disc);
    const N = 32;
    const dt = (tEnd - tStart) / N;
    let odR = 0, odG = 0, odB = 0;
    for (let i = 0; i < N; i++) {
      const t = tStart + (i + 0.5) * dt;
      const x = posKm.x + sunDir.x * t, y = posKm.y + sunDir.y * t, z = posKm.z + sunDir.z * t;
      const h = Math.sqrt(x * x + y * y + z * z) - p.bottomRadius;
      const d = this.density(h);
      odR += (p.rayleighScattering.x * d.r + p.mieExtinction * d.m + p.absorptionExtinction.x * d.a) * dt;
      odG += (p.rayleighScattering.y * d.r + p.mieExtinction * d.m + p.absorptionExtinction.y * d.a) * dt;
      odB += (p.rayleighScattering.z * d.r + p.mieExtinction * d.m + p.absorptionExtinction.z * d.a) * dt;
    }
    return out.set(Math.exp(-odR) * shadow, Math.exp(-odG) * shadow, Math.exp(-odB) * shadow);
  }

  /**
   * Approximate sky irradiance (ambient) at a point, split into upper-hemisphere sky colour
   * and lower-hemisphere ground colour. Cheap analytic fit driven by sun elevation.
   */
  skyAmbient(posKm: Vector3, sunDir: Vector3, outSky: Vector3, outGround: Vector3): void {
    const p = this.params;
    const r = posKm.length();
    const up = posKm.clone().multiplyScalar(1 / r);
    const muS = up.dot(sunDir);
    const h = Math.max(0, r - p.bottomRadius);
    const thick = Math.exp(-h / 9); // fraction of atmosphere above the observer
    const sunT = this.sunTransmittance(posKm, sunDir, new Vector3());
    // daylight term: scales with sun elevation, bluish; twilight term: deep blue/purple
    const day = Math.max(0, Math.min(1, (muS + 0.06) / 0.4));
    const twilight = Math.max(0, Math.min(1, (muS + 0.18) / 0.18)) * (1 - day);
    const sun = p.sunIlluminance;
    outSky.set(
      (0.035 * day * (0.45 + 0.55 * sunT.x) + 0.006 * twilight) * sun.x,
      (0.055 * day * (0.5 + 0.5 * sunT.y) + 0.008 * twilight) * sun.y,
      (0.095 * day * (0.6 + 0.4 * sunT.z) + 0.016 * twilight) * sun.z,
    ).multiplyScalar(thick);
    const g = p.groundAlbedo.x * Math.max(0, muS) * 0.3;
    outGround.set(sunT.x * g * sun.x, sunT.y * g * sun.y, sunT.z * g * sun.z).multiplyScalar(0.35);
  }
}
