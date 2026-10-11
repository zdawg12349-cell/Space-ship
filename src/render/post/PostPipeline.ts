import {
  AlwaysDepth, DepthFormat, DepthTexture, FloatType, GLSL3, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Matrix3, Matrix4, NearestFilter, NoBlending, RedFormat,
  RGBAFormat, ShaderMaterial, Texture, UnsignedIntType, Vector2, Vector3, Vector4, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../util/Fullscreen';
import { ATMOSPHERE_COMMON, SKYVIEW_COMMON } from '../atmosphere/glsl';
import type { Atmosphere } from '../atmosphere/Atmosphere';
import { DECK_COMMON, DECK_PASS_FRAG } from '../weather/CloudDeck';

export interface PostSettings {
  msaa: number;
  bloom: number; // strength
  exposureComp: number; // EV
  autoExposure: boolean;
  manualEV: number;
  vignette: number;
  grain: number;
  chromatic: number;
  saturation: number;
  contrast: number;
  temperature: number; // -1..1 warm/cool
  tint: number;
  letterbox: number; // 0..1 bar height fraction of screen (each side)
  minEV: number;
  maxEV: number;
  adaptSpeed: number;
  resolutionScale: number;
}

export const DEFAULT_POST: PostSettings = {
  msaa: 4, bloom: 0.045, exposureComp: 0, autoExposure: true, manualEV: 13, vignette: 0.28, grain: 0.035, chromatic: 0.0015,
  saturation: 1.04, contrast: 1.05, temperature: 0.0, tint: 0, letterbox: 0, minEV: -4, maxEV: 17, adaptSpeed: 1.6, resolutionScale: 1,
};

/**
 * Frame pipeline: scene (HDR, MSAA) -> atmosphere composite (+ linear depth MRT) -> transparent
 * FX -> bloom -> auto exposure -> AgX tonemap + grade -> screen.
 */
export class PostPipeline {
  readonly renderer: WebGLRenderer;
  settings: PostSettings = { ...DEFAULT_POST };
  sceneRT!: WebGLRenderTarget;
  compRT!: WebGLRenderTarget;
  /** the cloud deck at half resolution: [radiance + opacity, cloud distances] */
  deckRT!: WebGLRenderTarget;
  private deckMat: ShaderMaterial;
  private deckOn: { value: unknown };
  linDepthRT!: WebGLRenderTarget;
  depthTex!: DepthTexture;
  private bloomRTs: WebGLRenderTarget[] = [];
  private lumRT!: WebGLRenderTarget;
  private adaptRTs!: [WebGLRenderTarget, WebGLRenderTarget];
  private adaptIdx = 0;
  private quad = new FullscreenQuad();
  readonly compositeMat: ShaderMaterial;
  private downMat: ShaderMaterial;
  private upMat: ShaderMaterial;
  private lumMat: ShaderMaterial;
  private adaptMat: ShaderMaterial;
  private linDepthMat: ShaderMaterial;
  readonly finalMat: ShaderMaterial;
  private width = 1;
  private height = 1;
  private frame = 0;
  /** exposure bias from the weather (EV, negative darkens): a storm should look dark */
  weatherEV = 0;
  private time = 0;

  constructor(renderer: WebGLRenderer, atmosphere: Atmosphere, deckUniforms: Record<string, { value: unknown }>) {
    this.renderer = renderer;
    // The composite also copies scene depth into compRT's own depth buffer (gl_FragDepth) so
    // transparent FX can depth-test against the scene without a framebuffer feedback loop.
    this.compositeMat = new ShaderMaterial({
      blending: NoBlending, depthTest: true, depthWrite: true, depthFunc: AlwaysDepth,
      uniforms: {
        ...atmosphere.uniforms,
        ...deckUniforms,
        tColor: { value: null },
        tDepth: { value: null },
        uInvProj: { value: new Matrix4() },
        uCamRot: { value: new Matrix3() },
        uCamPosKm: { value: new Vector3() },
        uSunDir: { value: new Vector3(1, 0, 0) },
        uLogFar: { value: 40 },
        uAtmEnabled: { value: 1 },
        uClouds: { value: null },
        uCloudRot: { value: 0 },
        uPlanetRotInv: { value: new Matrix3() },
        uCloudAlt: { value: 7.5 },
        uCloudOpacity: { value: 1 },
        uCloudShellFade: { value: 1 },
        uTime: { value: 0 },
        uDebug: { value: 0 },
        uHazeA: { value: [new Vector4(), new Vector4(), new Vector4()] },
        uHazeB: { value: [new Vector4(), new Vector4(), new Vector4()] },
        uAspect: { value: 1 },
        // rain on the camera: intensity, time, camera climb rate (m/s), angle of a pixel (rad)
        uRain: { value: new Vector4() },
        uRainUp: { value: new Vector3(0, 1, 0) },
        uRainE: { value: new Vector3(1, 0, 0) },
        tDeck0: { value: null },
        tDeck1: { value: null },
        uDeckSize: { value: new Vector2(1, 1) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform sampler2D uSkyViewLUT;
        uniform sampler2D uClouds;
        uniform mat4 uInvProj;
        uniform mat3 uCamRot;
        uniform mat3 uPlanetRotInv;
        uniform vec3 uCamPosKm;
        uniform vec3 uSunDir;
        uniform float uLogFar;
        uniform float uAtmEnabled;
        uniform float uCloudRot;
        uniform float uCloudAlt;
        uniform float uCloudOpacity;
        uniform float uCloudShellFade;
        uniform float uTime;
        uniform int uDebug;
        // heat shimmer: per source, exit and far end of the hot column in uv (A) and its
        // half-width (uv height units) and strength (B)
        uniform vec4 uHazeA[3];
        uniform vec4 uHazeB[3];
        uniform float uAspect;
        uniform vec4 uRain;
        uniform vec3 uRainUp;
        uniform vec3 uRainE;
        uniform sampler2D tDeck0;
        uniform sampler2D tDeck1;
        uniform vec2 uDeckSize;
        ${ATMOSPHERE_COMMON}
        ${DECK_COMMON}
        float hz_hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float hz_noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hz_hash(i), hz_hash(i + vec2(1, 0)), u.x), mix(hz_hash(i + vec2(0, 1)), hz_hash(i + vec2(1, 1)), u.x), u.y); }
        vec2 heatHaze(vec2 uv) {
          vec2 off = vec2(0.0);
          for (int i = 0; i < 3; i++) {
            float st = uHazeB[i].y;
            if (st <= 0.0) continue;
            vec2 a = uHazeA[i].xy, b = uHazeA[i].zw;
            vec2 ab = (b - a) * vec2(uAspect, 1.0);
            vec2 p = (uv - a) * vec2(uAspect, 1.0);
            float l2 = max(dot(ab, ab), 1e-8);
            float t = clamp(dot(p, ab) / l2, 0.0, 1.0);
            vec2 q = p - ab * t;
            float w = uHazeB[i].x * (0.7 + 1.6 * t);
            float m = exp(-dot(q, q) / (w * w)) * (1.0 - 0.6 * t);
            if (m < 0.01) continue;
            // rising, turbulent refraction cells, finer close to the nozzle
            vec2 sc = vec2(150.0, 95.0) / max(0.02, w * 6.0);
            vec2 n = vec2(hz_noise(uv * sc + vec2(0.0, -uTime * 3.1)), hz_noise(uv * sc * 1.3 + vec2(uTime * 1.7, -uTime * 4.3))) - 0.5;
            off += n * m * st;
          }
          return off;
        }
        ${SKYVIEW_COMMON}
        vec2 dirToUV(vec3 d) {
          float lon = atan(d.y, d.x);
          float lat = asin(clamp(d.z, -1.0, 1.0));
          return vec2(lon / (2.0 * ATM_PI) + 0.5, 0.5 + lat / ATM_PI);
        }
        vec3 rotZ(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z); }

        // 2D cloud shell seen from far away (orbit). Returns rgb radiance + alpha.
        vec4 cloudShell(vec3 ro, vec3 rd, float tMaxKm) {
          float rc = uAtmBottom + uCloudAlt;
          vec2 tt = raySphere2(ro, rd, rc);
          float t = tt.x > 0.0 ? tt.x : tt.y;
          if (t <= 0.0 || t > tMaxKm) return vec4(0.0);
          // within its reach the low cloud deck stands in for the planet-wide map. Across the
          // hand-over band the deck's cells shrink away inside this layer's, which comes in early
          // (opaque a third of the way in) and fills in around them (and low down the layer is
          // faded out altogether)
          // (measured, as the deck measures its own, at the deck's height: a downward ray meets
          // this layer well before it, and by this layer's distance the deck's cells were gone
          // before it came in, leaving a ring of open sea between the two)
          vec2 tm = raySphere2(ro, rd, uAtmBottom + 0.5 * (uDeckParams.x + uDeckParams.y));
          float tD = tm.x > 0.0 ? tm.x : (tm.y > 0.0 ? tm.y : t);
          float shown = uCloudOpacity * uCloudShellFade * (1.0 - step(1e-4, uDeckOn) * (1.0 - smoothstep(uDeckFadeStart, mix(uDeckFadeStart, uDeckMaxDist, 0.3), tD)));
          if (shown <= 0.001) return vec4(0.0);
          vec3 p = ro + rd * t;
          vec3 n = normalize(p);
          vec3 nf = uPlanetRotInv * n;
          vec2 uv = dirToUV(rotZ(nf, -uCloudRot));
          float c = texture(uClouds, uv).r;
          float a = smoothstep(0.08, 0.75, c);
          float wLocal = 0.0;
          float relief = 1.0;
          // around the launch site the layer is the local weather: the deck's own cells, so a fair
          // day stays fair as the camera climbs out of the deck's reach; the world's cloud map
          // returns over a few hundred kilometres. The cells are taken where the ray crosses the
          // deck at several heights: seen obliquely a cloud covers the union of its slices,
          // shifted by parallax, and only that footprint lines up with the volumetric deck it
          // takes over from (one mid-height slice showed beside it as a second, flat layer)
          if (uDeckRegion > 0.0) {
            float off = acos(clamp(dot(nf, uDeckCenter), -1.0, 1.0)) * uAtmBottom;
            // (its edge a ragged front a hundred-odd kilometres across, not a circle, and inside
            // the weather map)
            off += (texture(uDeckNoise, nf * 23.0).a - 0.5) * uDeckSpan * 0.14;
            float w = uDeckRegion * (1.0 - smoothstep(uDeckSpan * 0.2, uDeckSpan * 0.42, off));
            if (w > 0.0) {
              float thickKm = uDeckParams.y - uDeckParams.x;
              float clear = 1.0;
              // (in the order the ray meets them: the first slice in cloud is the surface it
              // shows, and how much cloud the ray crosses tells a thick core from a thin margin)
              bool fromAbove = length(ro) > uAtmBottom + uDeckParams.y;
              vec3 pS = vec3(0.0);
              float hS = -1.0, mass = 0.0;
              for (int k = 0; k < 4; k++) {
                float hn = fromAbove ? 0.87 - 0.25 * float(k) : 0.12 + 0.25 * float(k);
                vec2 tk = raySphere2(ro, rd, uAtmBottom + uDeckParams.x + hn * thickKm);
                float tq = tk.x > 0.0 ? tk.x : tk.y;
                if (tq <= 0.0 || tq > tMaxKm) continue;
                vec3 pk = uPlanetRotInv * (ro + rd * tq);
                // (seen edge-on even a cloud's thin margin is opaque in the deck's march, so
                // the slices count from low in the shape too, or the hand-over shows gaps)
                float s = deckShape(pk, hn, deckCoverage(pk));
                float m = smoothstep(0.0, 0.1, s);
                if (hS < 0.0 && m > 0.5) { hS = hn; pS = pk; }
                mass += s;
                clear *= 1.0 - m;
              }
              a = mix(a, 1.0 - clear, w);
              wLocal = w;
              // relief, as the deck's own march shades it: a dome's flank turned away from the sun
              // lies in the shadow of its crown (with the sun high only steep towers cast any),
              // and a thin margin sends back less light than a thick core
              if (hS >= 0.0) {
                vec3 sunF = uPlanetRotInv * uSunDir;
                float muF = max(dot(normalize(pS), sunF), 0.12);
                float occl = 0.0;
                for (int j = 1; j <= 2; j++) {
                  float hq = hS + 0.25 * float(j);
                  if (hq > 1.0) break;
                  vec3 q = pS + sunF * (0.25 * float(j) * thickKm / muF);
                  occl = max(occl, smoothstep(0.0, 0.25, deckShape(q, hq, deckCoverage(q))));
                }
                relief = mix(1.0, (1.0 - 0.6 * occl) * mix(0.8, 1.0, smoothstep(0.1, 0.9, mass)), w);
              }
            }
          }
          a *= shown;
          if (a <= 0.001) return vec4(0.0);
          float muS = dot(n, uSunDir);
          vec3 sunT = getTransmittance(length(p), muS) * planetShadow(p, uSunDir);
          // thickness-dependent self-shadowing: thick clouds darker on the side away from the sun
          vec3 nfs = uPlanetRotInv * normalize(p + uSunDir * 4.0);
          float c2 = texture(uClouds, dirToUV(rotZ(nfs, -uCloudRot))).r;
          float self = mix(1.0, 0.55, smoothstep(0.3, 1.0, c2) * smoothstep(0.2, 0.9, c) * (1.0 - wLocal)) * relief;
          float cosTheta = dot(rd, uSunDir);
          float phase = 0.75 * miePhaseCS(0.6, cosTheta) * 4.0 * ATM_PI * 0.08 + 0.75;
          vec3 amb = getMultiScat(length(p), muS) * 6.0;
          vec3 L = uSunIlluminance * (sunT * max(0.0, muS * 0.6 + 0.4) * self * phase + amb) * 0.9 / ATM_PI;
          return vec4(L * a, a);
        }

        float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

        // the half-resolution cloud deck (added radiance, transmittance), upsampled with a small
        // Gaussian that also averages away the march's jitter; a texel whose cloud lies behind
        // this pixel's surface (a vehicle against a cloudy sky) does not cover it
        vec4 deckUpsample(vec2 uv, float distFull, out float tFr) {
          vec2 st = uv * uDeckSize - 0.5;
          vec2 c0 = floor(st + 0.5);
          vec4 cl = vec4(0.0);
          float wsum = 0.0;
          tFr = -1.0;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            vec2 tp = c0 + vec2(float(i), float(j));
            vec2 dv = tp - st;
            float w = exp(-dot(dv, dv) * 1.3);
            wsum += w;
            ivec2 ip = ivec2(clamp(tp, vec2(0.0), uDeckSize - 1.0));
            vec4 c = texelFetch(tDeck0, ip, 0);
            vec4 dd = c.a < 1.0 ? texelFetch(tDeck1, ip, 0) : vec4(-1.0);
            if (c.a >= 1.0 || dd.x > distFull * 1.02 + 0.02) { cl.a += w; continue; }
            cl += c * w;
            if (dd.y >= 0.0) tFr = tFr < 0.0 ? dd.y : min(tFr, dd.y);
          }
          return cl / wsum;
        }

        // rain: streaks on cylinders of radius R (m) around the camera, fixed in the world so they
        // stay put as the camera turns; each drop is a short vertical stroke about a pixel wide
        float rainLayer(vec3 rd, float R, float seed, float sceneDistM) {
          if (sceneDistM < R) return 0.0;
          float el = dot(rd, uRainUp);
          vec3 h = rd - uRainUp * el;
          float hl = length(h);
          if (hl < 0.25) return 0.0;
          vec3 n2 = cross(uRainUp, uRainE);
          float az = atan(dot(h, n2), dot(h, uRainE));
          vec2 c = vec2(az * R, el / hl * R + uRain.y * (8.5 + uRain.z) + seed * 13.0);
          vec2 g = c / vec2(0.32, 2.6);
          vec2 cell = floor(g), f = fract(g);
          float hs = hz_hash(cell + seed * 7.7);
          if (hs > uRain.x * 0.55) return 0.0;
          float x0 = 0.15 + 0.7 * fract(hs * 17.31);
          float y0 = 0.1 + 0.6 * fract(hs * 41.73);
          float w = max(uRain.w * R / 0.32, 0.002);
          float m = 1.0 - smoothstep(w * 0.5, w * 1.5, abs(f.x - x0));
          float dy = f.y - y0;
          return m * smoothstep(0.0, 0.01, dy) * (1.0 - smoothstep(0.035, 0.055, dy));
        }

        void main() {
          vec3 scene = texture(tColor, vUv + heatHaze(vUv)).rgb;
          // a single bad pixel (NaN / Inf / negative from a degenerate triangle) must never
          // reach the bloom chain, where it would smear across the frame
          if (any(isnan(scene)) || any(isinf(scene))) scene = vec3(0.0);
          scene = clamp(scene, vec3(0.0), vec3(60000.0));
          float d = texture(tDepth, vUv).r;
          vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
          vec3 rdv = normalize(vp.xyz / vp.w);
          vec3 rd = normalize(uCamRot * rdv);
          bool isSky = d >= 0.999999;
          float viewZ = isSky ? 1e20 : exp2(d * uLogFar) - 1.0;
          float distM = viewZ / max(1e-6, -rdv.z);
          gl_FragDepth = d;
          if (uAtmEnabled < 0.5) { gl_FragColor = vec4(scene, 1.0); return; }
          vec3 ro = uCamPosKm;
          float r = length(ro);
          float distKm = distM * 0.001;
          vec3 L = vec3(0.0);
          vec3 T = vec3(1.0);
          vec2 tTop = raySphere2(ro, rd, uAtmTop);
          vec4 cloud = vec4(0.0);
          if (tTop.y > 0.0) {
            float t0 = max(tTop.x, 0.0);
            float t1 = tTop.y;
            float tG = raySphereNear(ro, rd, uAtmBottom);
            bool hitGround = tG > 0.0;
            if (hitGround) t1 = min(t1, tG);
            if (!isSky) t1 = min(t1, distKm);
            cloud = cloudShell(ro, rd, isSky ? (hitGround ? tG : 1e9) : distKm);
            if (t1 > t0) {
              if (isSky && r < uAtmTop && !hitGround) {
                vec3 up = ro / r;
                float vz = dot(rd, up);
                vec3 sunH = uSunDir - up * dot(uSunDir, up);
                vec3 rdH = rd - up * vz;
                float lvc = (length(sunH) > 1e-5 && length(rdH) > 1e-5) ? dot(normalize(sunH), normalize(rdH)) : 1.0;
                L = texture(uSkyViewLUT, skyViewUV(r, vz, lvc, false)).rgb;
                T = getTransmittance(r, vz);
              } else {
                int steps = int(clamp((t1 - t0) / 3.0 + 6.0, 6.0, 30.0));
                L = integrateScattering(ro, rd, t0, t1, uSunDir, steps, T);
              }
            }
          }
          if (uDebug == 4) { gl_FragColor = vec4(distKm, raySphereNear(ro, rd, uAtmBottom), tTop.x, cloud.a); return; }
          if (uDebug == 1) { gl_FragColor = vec4(vec3(fract(log2(max(distKm, 1e-3)))) * 30.0, 1.0); return; }
          if (uDebug == 2) { gl_FragColor = vec4(vec3(cloud.a) * 30.0, 1.0); return; }
          if (uDebug == 3) { gl_FragColor = vec4(L, 1.0); return; }
          // beneath an overcast the air is lit only by the grey light soaking through the deck
          vec3 roF = uPlanetRotInv * ro;
          bool underDeck = uDeckOn > 0.0 && r < uAtmBottom + uDeckParams.x;
          float under = 0.0, dimF = 1.0;
          if (underDeck) {
            under = smoothstep(0.55, 0.9, deckCoverage(roF)) * uDeckOn;
            float muC = dot(ro / r, uSunDir);
            dimF = clamp(ATM_PI * lum(uDeckUnderL) / max(lum(uSunIlluminance * getTransmittance(r, muC)), 1e-4), 0.02, 1.0);
            if (!isSky) L = mix(L, mix(L, vec3(lum(L)), 0.6) * dimF, under);
          }
          vec3 col = scene * T + L;
          // cloud shell composited in front (aerial perspective toward the cloud approximated by T)
          col = col * (1.0 - cloud.a) + cloud.rgb * mix(vec3(1.0), T, 0.5);
          // the low cloud deck (marched at half resolution)
          if (uDeckOn > 0.0) {
            float tFr;
            vec4 cl = deckUpsample(vUv, isSky ? 1e9 : distKm, tFr);
            if (uDebug == 5) { gl_FragColor = vec4(vec3(1.0 - cl.a) * 30.0, 1.0); return; }
            col = col * cl.a + cl.rgb;
            // an opaque cloud hides the exhaust and smoke drawn after this pass
            if (cl.a < 0.5 && tFr >= 0.0) gl_FragDepth = min(d, log2(tFr * 1000.0 * max(1e-6, -rdv.z) + 1.0) / uLogFar);
          }
          // rain beneath the deck: a grey veil with distance, and streaks close to the lens
          if (uRain.x > 0.0 && underDeck) {
            vec2 hbR = raySphere2(ro, rd, uAtmBottom + uDeckParams.x);
            float tUnder = min(isSky ? 1e9 : distKm, hbR.y > 0.0 ? hbR.y : 1e9);
            float Tr = exp(-uRain.x * 0.3 * min(tUnder, 20.0));
            col = col * Tr + uDeckUnderL * 1.1 * (1.0 - Tr);
            vec3 dg = uDeckGlowPos - roF;
            vec3 rainL = uDeckUnderL * 1.4 + uDeckGlowI * (0.06 / (dot(dg, dg) + 0.0004)) + uDeckCity * 4.0;
            float m = rainLayer(rd, 1.6, 0.0, distM) * 0.9 + rainLayer(rd, 3.5, 1.0, distM) * 0.7 + rainLayer(rd, 8.0, 2.0, distM) * 0.5;
            col += rainL * m * 0.22 * uRain.x;
          }
          if (any(isnan(col))) col = vec3(0.0);
          gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
        }`,
    });

    const cu = this.compositeMat.uniforms;
    this.deckOn = deckUniforms.uDeckOn;
    this.deckMat = new ShaderMaterial({
      glslVersion: GLSL3, blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: {
        ...atmosphere.uniforms,
        ...deckUniforms,
        tDepth: { value: null },
        uFullSize: { value: new Vector2(1, 1) },
        uInvProj: cu.uInvProj, uCamRot: cu.uCamRot, uPlanetRotInv: cu.uPlanetRotInv, uCamPosKm: cu.uCamPosKm, uSunDir: cu.uSunDir, uLogFar: cu.uLogFar, uTime: cu.uTime,
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: DECK_PASS_FRAG,
    });

    const mk = (frag: string, uniforms: Record<string, { value: unknown }>) => new ShaderMaterial({
      blending: NoBlending, depthTest: false, depthWrite: false, uniforms, vertexShader: FULLSCREEN_VERT, fragmentShader: frag,
    });
    // 13-tap downsample (CoD: AW) with Karis average on the first mip
    this.downMat = mk(/* glsl */ `
      precision highp float;
      in vec2 vUv;
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      uniform float uFirst;
      vec3 s(vec2 o) {
        vec3 c = texture(tSrc, vUv + o * uTexel).rgb;
        // FX drawn after the composite could still carry a bad value: keep it out of the bloom
        return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : max(c, vec3(0.0));
      }
      float karis(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)) * 0.25); }
      void main() {
        vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
        vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
        vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
        vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
        vec3 col;
        if (uFirst > 0.5) {
          vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
          float w0 = karis(g0) * 0.125, w1 = karis(g1) * 0.125, w2 = karis(g2) * 0.125, w3 = karis(g3) * 0.125, w4 = karis(g4) * 0.5;
          col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
          col = min(col, vec3(6.0e4));
        } else {
          col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
        }
        gl_FragColor = vec4(col, 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new Vector2() }, uFirst: { value: 0 } });
    this.upMat = mk(/* glsl */ `
      precision highp float;
      in vec2 vUv;
      uniform sampler2D tSrc;
      uniform sampler2D tPrev;
      uniform vec2 uTexel;
      uniform float uRadius;
      uniform float uFalloff;
      void main() {
        vec2 o = uTexel * uRadius;
        vec3 c = texture(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture(tSrc, vUv + vec2(0, o.y)).rgb * 2.0 + texture(tSrc, vUv + vec2(o.x, o.y)).rgb
               + texture(tSrc, vUv + vec2(-o.x, 0)).rgb * 2.0 + texture(tSrc, vUv).rgb * 4.0 + texture(tSrc, vUv + vec2(o.x, 0)).rgb * 2.0
               + texture(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture(tSrc, vUv + vec2(0, -o.y)).rgb * 2.0 + texture(tSrc, vUv + vec2(o.x, -o.y)).rgb;
        gl_FragColor = vec4(c / 16.0 * uFalloff + texture(tPrev, vUv).rgb, 1.0);
      }`, { tSrc: { value: null }, tPrev: { value: null }, uTexel: { value: new Vector2() }, uRadius: { value: 1 }, uFalloff: { value: 0.8 } });
    this.lumMat = mk(/* glsl */ `
      precision highp float;
      in vec2 vUv;
      uniform sampler2D tSrc;
      void main() {
        // centre-weighted log luminance; near-black pixels (deep space) get little weight so a
        // sunlit planet in frame is exposed for, rather than the void around it, and extreme
        // highlights (an exhaust plume at night, the sun's disc) are capped like a photographer
        // metering past them: the lit cloud around a night launch stays visible
        vec3 c = texture(tSrc, vUv).rgb;
        float l = min(dot(c, vec3(0.2126, 0.7152, 0.0722)), 250.0);
        vec2 d = vUv - 0.5;
        float w = exp(-dot(d, d) * 4.0) * (0.003 + smoothstep(0.002, 0.05, l));
        gl_FragColor = vec4(log2(max(l, 1e-7)) * w, w, 0.0, 1.0);
      }`, { tSrc: { value: null } });
    // distance to the first opaque thing along each pixel's ray (m): the scene, or the cloud deck
    // where it is opaque. Plumes and particles occlude themselves against it.
    this.linDepthMat = mk(/* glsl */ `
      precision highp float;
      in vec2 vUv;
      uniform sampler2D tDepth;
      uniform sampler2D tDeck0;
      uniform sampler2D tDeck1;
      uniform float uDeck;
      uniform mat4 uInvProj;
      uniform float uLogFar;
      void main() {
        float d = texture(tDepth, vUv).r;
        vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
        vec3 rdv = normalize(vp.xyz / vp.w);
        float viewZ = d >= 0.999999 ? 1e20 : exp2(d * uLogFar) - 1.0;
        float dist = viewZ / max(1e-6, -rdv.z);
        if (uDeck > 0.0 && texture(tDeck0, vUv).a < 0.5) {
          float tFront = texture(tDeck1, vUv).y;
          if (tFront >= 0.0) dist = min(dist, tFront * 1000.0);
        }
        gl_FragColor = vec4(dist, 0.0, 0.0, 1.0);
      }`, { tDepth: { value: null }, tDeck0: { value: null }, tDeck1: { value: null }, uDeck: { value: 0 }, uInvProj: { value: new Matrix4() }, uLogFar: { value: 40 } });
    this.adaptMat = mk(/* glsl */ `
      precision highp float;
      in vec2 vUv;
      uniform sampler2D tLum;
      uniform sampler2D tPrev;
      uniform float uDt;
      uniform float uSpeed;
      uniform float uMinEV;
      uniform float uMaxEV;
      uniform float uComp;
      uniform float uAuto;
      uniform float uManualEV;
      uniform float uReset;
      void main() {
        vec2 acc = textureLod(tLum, vec2(0.5), 20.0).rg;
        float logAvg = acc.x / max(acc.y, 1e-6);
        // EV100 from average luminance (units: kcd/m^2 -> cd/m^2), K = 12.5
        float lumCd = exp2(logAvg) * 1000.0;
        float ev = log2(max(lumCd, 1e-6) * 100.0 / 12.5);
        ev = clamp(ev, uMinEV, uMaxEV);
        // dark scenes stay dark (the eye / a film camera never lifts a night landscape to grey):
        // below EV 7 only part of the shortfall is compensated (higher EV = less exposure)
        ev += max(0.0, 7.0 - ev) * 0.55;
        // and very bright ones stay bright (a sea of sunlit cloud tops is white, not grey)
        ev -= max(0.0, ev - 14.5) * 0.45;
        float target = uAuto > 0.5 ? ev - uComp : uManualEV - uComp;
        float prev = texture(tPrev, vec2(0.5)).r;
        float k = uReset > 0.5 ? 1.0 : 1.0 - exp(-uDt * uSpeed * (target > prev ? 1.0 : 1.6));
        gl_FragColor = vec4(mix(prev, target, k), 0.0, 0.0, 1.0);
      }`, { tLum: { value: null }, tPrev: { value: null }, uDt: { value: 0.016 }, uSpeed: { value: 1.5 }, uMinEV: { value: -6 }, uMaxEV: { value: 17 }, uComp: { value: 0 }, uAuto: { value: 1 }, uManualEV: { value: 13 }, uReset: { value: 1 } });
    this.finalMat = mk(/* glsl */ `
      precision highp float;
      in vec2 vUv;
      uniform sampler2D tColor;
      uniform sampler2D tBloom;
      uniform sampler2D tEV;
      uniform float uBloom;
      uniform float uBloomNorm;
      uniform float uVignette;
      uniform float uGrain;
      uniform float uChromatic;
      uniform float uSaturation;
      uniform float uContrast;
      uniform float uTemperature;
      uniform float uTint;
      uniform float uLetterbox;
      uniform float uTime;
      uniform vec2 uResolution;
      uniform float uFade;
      uniform vec3 uFadeColor;
      uniform float uNightGrade;
      // AgX (Sobotka) — minimal approximation with a slightly punchy look
      vec3 agxDefaultContrastApprox(vec3 x) {
        vec3 x2 = x * x; vec3 x4 = x2 * x2;
        return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
      }
      vec3 agx(vec3 val) {
        const mat3 agx_mat = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                                  0.0784335999999992, 0.878468636469772, 0.0784336,
                                  0.0792237451477643, 0.0791661274605434, 0.879142973793104);
        const float min_ev = -12.47393; const float max_ev = 4.026069;
        val = agx_mat * val;
        val = clamp(log2(max(val, 1e-10)), min_ev, max_ev);
        val = (val - min_ev) / (max_ev - min_ev);
        return agxDefaultContrastApprox(val);
      }
      vec3 agxEotf(vec3 val) {
        const mat3 agx_mat_inv = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                                      -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                                      -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
        val = agx_mat_inv * val;
        return pow(max(val, 0.0), vec3(2.2));
      }
      vec3 agxLook(vec3 val) {
        float l = dot(val, vec3(0.2126, 0.7152, 0.0722));
        vec3 slope = vec3(1.0), power = vec3(1.18), offset = vec3(0.0);
        float sat = 1.18;
        val = pow(val * slope + offset, power);
        return l + sat * (val - l);
      }
      float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      vec3 linearToSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      void main() {
        vec2 uv = vUv;
        vec2 dc = uv - 0.5;
        float ev = texture(tEV, vec2(0.5)).r;
        // EV100 -> scene-referred scale placing the metered average at middle grey (0.18),
        // as the AgX transform expects (luminance in kcd/m^2, K = 12.5)
        float exposure = 1000.0 * 0.18 / (0.125 * exp2(ev));
        vec3 col;
        if (uChromatic > 0.0) {
          vec2 off = dc * uChromatic;
          vec3 c0 = texture(tColor, uv).rgb;
          float r = texture(tColor, uv + off).r, b = texture(tColor, uv - off).b;
          // this runs on scene radiance: a sub-pixel shift of a sunlit edge into a black shadow (1000:1)
          // would survive tone mapping as a saturated band, so each shifted channel stays within a
          // stop of the unshifted one
          float l0 = dot(c0, vec3(0.2126, 0.7152, 0.0722)) * 0.05 + 1e-6;
          col = vec3(clamp(r, c0.r * 0.5, c0.r * 2.0 + l0), c0.g, clamp(b, c0.b * 0.5, c0.b * 2.0 + l0));
        } else col = texture(tColor, uv).rgb;
        // energy-conserving glow: a small fraction of the light is spread by the lens
        col = mix(col, texture(tBloom, uv).rgb * uBloomNorm, uBloom);
        col *= exposure;
        // white balance (simple warm/cool + tint)
        col *= vec3(1.0 + uTemperature * 0.08, 1.0 + uTint * 0.05, 1.0 - uTemperature * 0.08);
        // night grade: as the light level falls toward scotopic, colour fades and shifts blue
        float scot = smoothstep(6.5, 0.5, ev) * uNightGrade;
        float ls = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, ls * vec3(0.78, 0.92, 1.25), scot * 0.55);
        col = agx(col);
        col = agxLook(col);
        col = agxEotf(col);
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, uSaturation);
        col = (col - 0.18) * uContrast + 0.18;
        col = max(col, 0.0);
        float vig = 1.0 - uVignette * smoothstep(0.25, 0.95, length(dc * vec2(uResolution.x / uResolution.y, 1.0)) );
        col *= vig;
        col = mix(col, uFadeColor, uFade);
        vec3 outc = linearToSRGB(clamp(col, 0.0, 1.0));
        float n = hash(uv * uResolution + fract(uTime * 13.37) * 100.0) - 0.5;
        outc += n * uGrain * (1.0 - l * 0.5);
        if (abs(dc.y) > 0.5 - uLetterbox) outc = vec3(0.0);
        gl_FragColor = vec4(outc, 1.0);
      }`, {
      tColor: { value: null }, tBloom: { value: null }, tEV: { value: null }, uBloom: { value: 0.05 }, uBloomNorm: { value: 0.2 }, uVignette: { value: 0.25 }, uGrain: { value: 0.03 },
      uChromatic: { value: 0.001 }, uSaturation: { value: 1 }, uContrast: { value: 1 }, uTemperature: { value: 0 }, uTint: { value: 0 }, uLetterbox: { value: 0 },
      uTime: { value: 0 }, uResolution: { value: new Vector2(1, 1) }, uFade: { value: 0 }, uFadeColor: { value: new Vector3() }, uNightGrade: { value: 1 },
    });
    this.resize(1, 1);
  }

  resize(w: number, h: number): void {
    const s = this.settings.resolutionScale;
    w = Math.max(1, Math.floor(w * s));
    h = Math.max(1, Math.floor(h * s));
    if (w === this.width && h === this.height && this.sceneRT) return;
    this.width = w;
    this.height = h;
    this.sceneRT?.dispose();
    this.compRT?.dispose();
    this.depthTex?.dispose();
    this.depthTex = new DepthTexture(w, h, FloatType);
    this.depthTex.format = DepthFormat;
    this.depthTex.minFilter = NearestFilter;
    this.depthTex.magFilter = NearestFilter;
    this.sceneRT = new WebGLRenderTarget(w, h, {
      type: HalfFloatType, format: RGBAFormat, samples: this.settings.msaa, depthBuffer: true, stencilBuffer: false,
      minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false,
    });
    this.sceneRT.depthTexture = this.depthTex;
    this.compRT = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, depthBuffer: true, stencilBuffer: false, generateMipmaps: false });
    this.linDepthRT?.dispose();
    this.linDepthRT = new WebGLRenderTarget(w, h, { type: FloatType, format: RedFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false });
    this.deckRT?.dispose();
    const dw = Math.ceil(w / 2), dh = Math.ceil(h / 2);
    this.deckRT = new WebGLRenderTarget(dw, dh, { count: 2, type: HalfFloatType, format: RGBAFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false });
    (this.compositeMat.uniforms.uDeckSize.value as Vector2).set(dw, dh);
    (this.deckMat.uniforms.uFullSize.value as Vector2).set(w, h);
    for (const rt of this.bloomRTs) rt.dispose();
    this.bloomRTs = [];
    let bw = w, bh = h;
    for (let i = 0; i < 7; i++) {
      bw = Math.max(1, Math.floor(bw / 2));
      bh = Math.max(1, Math.floor(bh / 2));
      this.bloomRTs.push(new WebGLRenderTarget(bw, bh, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false }));
    }
    this.lumRT?.dispose();
    this.lumRT = new WebGLRenderTarget(256, 256, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter });
    if (!this.adaptRTs) {
      const a = () => new WebGLRenderTarget(1, 1, { type: FloatType, format: RGBAFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter });
      this.adaptRTs = [a(), a()];
    }
  }

  get size(): Vector2 { return new Vector2(this.width, this.height); }

  /** Begin the HDR scene pass. */
  beginScene(): void {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
  }

  /** Atmosphere composite; afterwards transparent FX may be drawn into compRT with depth test. */
  composite(): void {
    if ((this.deckOn.value as number) > 0) {
      this.deckMat.uniforms.tDepth.value = this.depthTex;
      this.quad.render(this.renderer, this.deckRT, this.deckMat);
    }
    this.compositeMat.uniforms.tDeck0.value = this.deckRT.textures[0];
    this.compositeMat.uniforms.tDeck1.value = this.deckRT.textures[1];
    this.compositeMat.uniforms.tColor.value = this.sceneRT.texture;
    this.compositeMat.uniforms.tDepth.value = this.depthTex;
    this.quad.render(this.renderer, this.compRT, this.compositeMat);
    const lu = this.linDepthMat.uniforms;
    lu.tDepth.value = this.depthTex;
    lu.tDeck0.value = this.deckRT.textures[0];
    lu.tDeck1.value = this.deckRT.textures[1];
    lu.uDeck.value = this.deckOn.value;
    lu.uInvProj.value = this.compositeMat.uniforms.uInvProj.value;
    lu.uLogFar.value = this.compositeMat.uniforms.uLogFar.value;
    this.quad.render(this.renderer, this.linDepthRT, this.linDepthMat);
  }

  get linearDepth(): Texture { return this.linDepthRT.texture; }

  finish(dt: number, resetExposure = false): void {
    const r = this.renderer;
    const s = this.settings;
    this.frame++;
    this.time += dt;
    const src = this.compRT.textures[0];
    // bloom
    let prevTex: Texture = src;
    for (let i = 0; i < this.bloomRTs.length; i++) {
      const rt = this.bloomRTs[i];
      this.downMat.uniforms.tSrc.value = prevTex;
      (this.downMat.uniforms.uTexel.value as Vector2).set(1 / (i === 0 ? this.width : this.bloomRTs[i - 1].width), 1 / (i === 0 ? this.height : this.bloomRTs[i - 1].height));
      this.downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
      this.quad.render(r, rt, this.downMat);
      prevTex = rt.texture;
    }
    // luminance is metered on the plain 1/4-res downsample, before bloom accumulation
    this.lumMat.uniforms.tSrc.value = this.bloomRTs[1].texture;
    this.quad.render(r, this.lumRT, this.lumMat);
    // upsample: acc_i = mip_i + falloff * blur(acc_i+1); normalised by the summed weights
    const falloff = 0.62;
    this.upMat.uniforms.uFalloff.value = falloff;
    let wsum = 1;
    for (let i = 1; i < this.bloomRTs.length; i++) wsum = 1 + falloff * wsum;
    for (let i = this.bloomRTs.length - 1; i > 0; i--) {
      const src2 = this.bloomRTs[i];
      const dst = this.bloomRTs[i - 1];
      this.upMat.uniforms.tSrc.value = src2.texture;
      this.upMat.uniforms.tPrev.value = dst.texture;
      (this.upMat.uniforms.uTexel.value as Vector2).set(1 / src2.width, 1 / src2.height);
      // read & write the same target is illegal: render into a temp then swap
      this.quad.render(r, this.tmpFor(dst), this.upMat);
      this.swapTmp(i - 1);
    }
    // exposure metering
    const prev = this.adaptRTs[this.adaptIdx];
    const next = this.adaptRTs[1 - this.adaptIdx];
    const am = this.adaptMat.uniforms;
    am.tLum.value = this.lumRT.texture;
    am.tPrev.value = prev.texture;
    am.uDt.value = dt;
    am.uSpeed.value = s.adaptSpeed;
    am.uMinEV.value = s.minEV;
    am.uMaxEV.value = s.maxEV;
    am.uComp.value = s.exposureComp + this.weatherEV;
    am.uAuto.value = s.autoExposure ? 1 : 0;
    am.uManualEV.value = s.manualEV;
    am.uReset.value = resetExposure || this.frame < 3 ? 1 : 0;
    this.quad.render(r, next, this.adaptMat);
    this.adaptIdx = 1 - this.adaptIdx;
    // final
    const fu = this.finalMat.uniforms;
    fu.tColor.value = src;
    fu.tBloom.value = this.bloomRTs[0].texture;
    fu.tEV.value = next.texture;
    fu.uBloom.value = s.bloom;
    fu.uBloomNorm.value = 1 / wsum;
    fu.uVignette.value = s.vignette;
    fu.uGrain.value = s.grain;
    fu.uChromatic.value = s.chromatic;
    fu.uSaturation.value = s.saturation;
    fu.uContrast.value = s.contrast;
    fu.uTemperature.value = s.temperature;
    fu.uTint.value = s.tint;
    fu.uLetterbox.value = s.letterbox;
    fu.uTime.value = this.time;
    (fu.uResolution.value as Vector2).set(this.width, this.height);
    this.quad.render(r, null, this.finalMat);
  }

  // ping-pong helpers for in-place bloom accumulation
  private tmp: WebGLRenderTarget[] = [];
  private tmpFor(dst: WebGLRenderTarget): WebGLRenderTarget {
    const i = this.bloomRTs.indexOf(dst);
    if (!this.tmp[i] || this.tmp[i].width !== dst.width || this.tmp[i].height !== dst.height) {
      this.tmp[i]?.dispose();
      this.tmp[i] = new WebGLRenderTarget(dst.width, dst.height, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
    }
    return this.tmp[i];
  }
  private swapTmp(i: number): void {
    const t = this.tmp[i];
    this.tmp[i] = this.bloomRTs[i];
    this.bloomRTs[i] = t;
  }
}
