import {
  ClampToEdgeWrapping, FloatType, LinearFilter, NearestFilter, NoBlending, Quaternion, RepeatWrapping, RGBAFormat, ShaderMaterial, Texture, UnsignedByteType,
  Vector2, Vector3, Vector4, WebGL3DRenderTarget, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../util/Fullscreen';
import { ATMOSPHERE_COMMON } from '../atmosphere/glsl';
import type { Atmosphere } from '../atmosphere/Atmosphere';

/**
 * Low-level weather: a volumetric cloud deck over the region around the camera, from a few
 * fair-weather cumulus to a grey stratus sheet or towering cumulonimbus.
 *
 * - Cell shapes come from a tiling Perlin-Worley noise volume, generated on the GPU once.
 * - Regional cover comes from a drifting weather map around the camera.
 * - The atmosphere composite ray-marches the deck. It is lit by the same transmittance and
 *   sky LUTs as the air, so it takes on sunset colours, and by the exhaust plumes and
 *   lightning.
 * - The terrain shader and the environment probe use the same functions for cloud shadows
 *   and the grey light under an overcast sky.
 * - A two-pixel probe, read back asynchronously, reports how much sunlight reaches the
 *   vehicle and whether the camera is in cloud or under rain.
 *
 * Far from the camera (and from orbit) the planet-wide cloud map in the composite takes over.
 */

export type DeckWeather = 'clear' | 'fair' | 'breezy' | 'overcast' | 'storm';

export interface DeckParams {
  /** fraction of the sky covered, 0..1 */
  cover: number;
  /** regional variation of that cover (± around it) */
  variation: number;
  /** cloud base and tops, km above sea level */
  base: number;
  top: number;
  /** extinction at full density (1/km); 40/km is about 75 m visibility inside */
  density: number;
  /** 0 = cumulus, 1 = stratus sheet, 2 = cumulonimbus */
  form: number;
  /** how much the detail noise erodes the edges, 0..1 */
  erosion: number;
  /** rain falling beneath the deck, 0..1 */
  rain: number;
  /** lightning flashes per minute */
  lightning: number;
  /** drift speed at cloud level (m/s) */
  wind: number;
  /** exposure bias under the deck (EV, negative darkens): storms should look dark */
  ev: number;
}

export const DECK_PRESETS: Record<DeckWeather, DeckParams> = {
  clear: { cover: 0.2, variation: 0.26, base: 1.5, top: 2.3, density: 36, form: 0, erosion: 0.6, rain: 0, lightning: 0, wind: 5, ev: 0 },
  fair: { cover: 0.42, variation: 0.34, base: 1.2, top: 2.8, density: 40, form: 0, erosion: 0.55, rain: 0, lightning: 0, wind: 7, ev: 0 },
  breezy: { cover: 0.58, variation: 0.3, base: 1.0, top: 2.3, density: 40, form: 0.45, erosion: 0.5, rain: 0, lightning: 0, wind: 13, ev: 0 },
  overcast: { cover: 0.88, variation: 0.1, base: 0.75, top: 2.4, density: 24, form: 1, erosion: 0.3, rain: 0.15, lightning: 0, wind: 8, ev: -0.3 },
  storm: { cover: 0.9, variation: 0.1, base: 0.6, top: 9.5, density: 30, form: 2, erosion: 0.35, rain: 1, lightning: 6, wind: 14, ev: -0.7 },
};

/** Tiles (km) of the shape and erosion noise; the origin snaps to the larger so both stay seamless. */
const BASE_TILE = 9.6;
const DETAIL_TILE = 2.4;
/** half-width of the weather map (km) and how far the camera may wander before it is rebuilt */
const MAP_HALF = 240;
const MAP_RECENTRE = 90;
const R_EARTH_KM = 6371;

/** Uniform declarations shared by every shader that sees the deck. */
export const DECK_UNIFORMS = /* glsl */ `
uniform float uDeckOn;
uniform vec4 uDeckParams;   // base, top (km above sea level), extinction (1/km), cover
uniform vec4 uDeckForm;     // form (0 cumulus .. 1 stratus .. 2 cumulonimbus), rain, erosion, time (s)
uniform sampler2D uDeckWeather;
uniform highp sampler3D uDeckNoise;
uniform vec3 uDeckCenter;
uniform vec3 uDeckE;
uniform vec3 uDeckN;
uniform float uDeckSpan;
uniform vec2 uDeckShift;
uniform vec3 uDeckOrigin;
uniform vec3 uDeckUnderL;   // radiance of the grey daylight beneath a full deck
uniform vec3 uDeckTopL;     // radiance of the sunlit top of the deck
uniform vec4 uDeckProbe;    // camera: x under a deck (0..1), y above one (its cover), z under broken cloud (its cover)
uniform vec3 uDeckCloudL;   // mean radiance of a broken deck seen from below (sunlit sides, grey bases)
uniform vec3 uDeckFlashIrr; // lightning: irradiance on the ground around the camera
uniform float uDeckSteps;
uniform float uDeckMaxDist;
uniform float uDeckFadeStart; // the deck thins out from here to uDeckMaxDist (km from the camera)
uniform vec3 uDeckGlowPos;   // exhaust light (body-fixed km) and its intensity x colour
uniform vec3 uDeckGlowI;
uniform vec3 uDeckFlashPos;  // lightning inside the cloud
uniform float uDeckFlashI;
uniform vec3 uDeckCity;      // night: town light on the cloud bases
uniform vec3 uDeckGroundL;   // daylight bounced off the ground onto the cloud bases
uniform vec3 uDeckSkyE;      // clear-sky irradiance at the deck (horizontal surface, whole dome)
uniform vec2 uDeckSkyK;      // the sky term at a cloud's top, as a multiple of the dome's radiance; the fraction at its base
uniform vec3 uDeckHoleA;     // the channel a climbing rocket punched through the deck
uniform vec3 uDeckHoleB;
uniform vec2 uDeckHoleR;     // its radius (km) at A and at B
`;

/** Cover, shape and density of the deck at body-fixed points (km). Needs ATMOSPHERE_COMMON. */
export const DECK_COMMON = /* glsl */ `
${DECK_UNIFORMS}
const float DECK_BASE_TILE = ${BASE_TILE.toFixed(1)};
const float DECK_DETAIL_TILE = ${DETAIL_TILE.toFixed(1)};
float deckRemap(float v, float a, float b, float c, float d) { return c + (v - a) / max(1e-5, b - a) * (d - c); }
// slow noise at the last shape sample (0..1): thicker and thinner patches of a sheet's base
float gDeckLow = 0.5;
// set while measuring the cloud at the vehicle itself (which sits at the head of its own channel)
bool gDeckNoHole = false;

// regional cover (0..1) of the column through p
float deckCoverage(vec3 p) {
  vec3 d = normalize(p);
  float k = dot(d, uDeckCenter);
  if (k < 0.2) return 0.0;
  vec2 xy = vec2(dot(d, uDeckE), dot(d, uDeckN)) * (uAtmBottom / k) - uDeckShift;
  return texture(uDeckWeather, xy / uDeckSpan + 0.5).r;
}

// the channel a rocket punched through the deck: a cone around its path, oldest and widest at
// the bottom, that opens a few seconds behind the vehicle as the exhaust pushes the cloud aside
// and never quite clears it
float deckHole(vec3 p) {
  if (uDeckHoleR.x <= 0.0 || gDeckNoHole) return 1.0;
  vec3 ab = uDeckHoleB - uDeckHoleA;
  vec3 ap = p - uDeckHoleA;
  float h = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  float r = mix(uDeckHoleR.x, uDeckHoleR.y, h);
  return 1.0 - 0.9 * (1.0 - smoothstep(r * 0.4, r * 1.5, length(ap - ab * h)));
}

// cloud shape 0..1 at p, height hn (0 at the base, 1 at the tops) in a column of cover cov
float deckShape(vec3 p, float hn, float cov) {
  float form = uDeckForm.x;
  // the cells are columns: the shape noise changes slowly with height (towers most of all), so
  // the height profile rounds them into domes instead of slicing a 3D blob
  float squash = form <= 1.0 ? mix(0.35, 0.5, form) : mix(0.5, 0.15, form - 1.0);
  float rb = uAtmBottom + uDeckParams.x;
  vec3 pc = normalize(p) * (rb + (length(p) - rb) * squash);
  vec4 n = texture(uDeckNoise, (pc - uDeckOrigin) / DECK_BASE_TILE);
  gDeckLow = n.a;
  // cumulus: flat bases, tops that narrow; stratus: an even slab; cumulonimbus: towers that
  // spread into an anvil under the tropopause
  float cu = smoothstep(0.0, 0.1, hn) * smoothstep(1.0, 0.4, hn);
  float st = smoothstep(0.0, 0.22, hn) * smoothstep(1.0, 0.68, hn);
  float cb = smoothstep(0.0, 0.05, hn) * smoothstep(1.0, 0.9, hn) * (0.78 + 0.22 * smoothstep(0.72, 0.9, hn));
  float prof = form <= 1.0 ? mix(cu, st, form) : mix(st, cb, form - 1.0);
  // a stratus sheet loses the cellular structure, except in the lumpy rolls along its top
  float sheet = clamp(form, 0.0, 1.0) * (1.0 - clamp(form - 1.0, 0.0, 1.0));
  float base = mix(n.r, 0.5 + 0.5 * n.a, sheet * 0.75 * (1.0 - smoothstep(0.55, 0.95, hn)));
  float s = deckRemap(base * prof, 1.0 - cov, 1.0, 0.0, 1.0);
  return clamp(s, 0.0, 1.0) * smoothstep(0.0, 0.2, cov) * deckHole(p);
}

// extinction (1/km); detail erodes the edges into wisps at the base and billows on top
float deckDensity(vec3 p, float hn, float cov, bool detail) {
  float s = deckShape(p, hn, cov);
  if (s <= 0.0) return 0.0;
  if (detail) {
    vec4 d = texture(uDeckNoise, (p - uDeckOrigin) / DECK_DETAIL_TILE + vec3(0.0, 0.0, uDeckForm.w * 0.0025));
    float det = d.g * 0.6 + d.b * 0.4;
    float er = mix(1.0 - det, det, clamp(hn * 2.5, 0.0, 1.0));
    s = clamp(deckRemap(s, er * uDeckForm.z, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  // density climbs quickly inside the edge: crisp outlines rather than cotton wool
  s = 1.0 - (1.0 - s) * (1.0 - s);
  return s * uDeckParams.z;
}

// sunlight reaching body-fixed point p through the deck (0..1), cheap single estimate:
// the deck's shape where the sun ray crosses its lower third
float deckSunShadow(vec3 p, vec3 sunF) {
  if (uDeckOn <= 0.0) return 1.0;
  float r = length(p);
  float muS = dot(p / r, sunF);
  float hm = uAtmBottom + mix(uDeckParams.x, uDeckParams.y, 0.3);
  if (r >= hm || muS <= -0.05) return 1.0;
  float mu = max(muS, 0.08);
  vec3 pm = p + sunF * ((hm - r) / mu);
  float s = deckShape(pm, 0.3, deckCoverage(pm));
  float od = s * uDeckParams.z * (uDeckParams.y - uDeckParams.x) * 0.55 / mu;
  return mix(1.0, exp(-od), uDeckOn);
}
`;

/** The ray-march itself (atmosphere composite only). Needs ATMOSPHERE_COMMON and DECK_COMMON. */
export const DECK_MARCH = /* glsl */ `
// debug view: 1 sun term only, 2 sky, 3 ground bounce, 4 the air in front only, 5 the cloud only
uniform float uDeckDbg;
float deckHG(float g, float c) { float g2 = g * g; return (1.0 - g2) / (4.0 * ATM_PI * pow(max(1e-4, 1.0 + g2 - 2.0 * g * c), 1.5)); }

// March the deck along a body-fixed ray. Returns in-scattered radiance (rgb) and transmittance (a).
// tFront: distance (km) where the transmittance fell below one half (-1 if it never did);
// tMean: opacity-weighted distance, for the air in front of the cloud.
vec4 deckMarch(vec3 ro, vec3 rd, vec3 sunF, float tLimit, float jitter, out float tFront, out float tMean) {
  tFront = -1.0;
  tMean = -1.0;
  float rb = uAtmBottom + uDeckParams.x, rt = uAtmBottom + uDeckParams.y;
  float r0 = length(ro);
  vec2 ht = raySphere2(ro, rd, rt);
  if (ht.y <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec2 hb = raySphere2(ro, rd, rb);
  float tA, tB;
  if (r0 < rb) { tA = hb.y; tB = ht.y; }
  else if (r0 < rt) { tA = 0.0; tB = hb.x > 0.0 ? hb.x : ht.y; }
  else { tA = max(ht.x, 0.0); tB = hb.x > 0.0 ? hb.x : ht.y; }
  tB = min(tB, min(tLimit, uDeckMaxDist));
  if (tB <= tA) return vec4(0.0, 0.0, 0.0, 1.0);
  float ds = (tB - tA) / uDeckSteps;
  // sunlight and skylight once per ray, where it enters the deck
  vec3 pe = ro + rd * min(tA + ds, tB);
  float re = length(pe);
  float muS = dot(pe / re, sunF);
  vec3 sunE = uSunIlluminance * getTransmittance(re, muS) * planetShadow(pe, sunF);
  // skylight: the whole blue dome (single and multiple scattering), not just its multiply
  // scattered part, so a cloud's shaded side and base come out grey-blue, not brown
  vec3 skyL = uDeckSkyE * (uDeckSkyK.x / ATM_PI);
  float sunUp = max(muS, 0.0);
  float c = dot(rd, sunF);
  // scattering orders, each softer and more blurred in angle (after Wrenninge); a thick cloud
  // returns most of the light it receives, so the higher orders carry a lot of energy
  float ph0 = mix(deckHG(0.8, c), deckHG(-0.3, c), 0.25);
  float ph1 = mix(deckHG(0.4, c), deckHG(-0.15, c), 0.25);
  float ph2 = mix(deckHG(0.2, c), deckHG(-0.08, c), 0.25);
  const float PH_ISO = 1.0 / (4.0 * ATM_PI);
  float powderMix = 0.5 - 0.5 * c;
  float thick = rt - rb;
  bool glow = uDeckGlowI.x + uDeckGlowI.y + uDeckGlowI.z > 0.0;
  vec3 L = vec3(0.0);
  float T = 1.0;
  float wT = 0.0, wSum = 0.0;
  for (int i = 0; i < 128; i++) {
    if (float(i) >= uDeckSteps || T < 0.01) break;
    float t = tA + (float(i) + jitter) * ds;
    vec3 p = ro + rd * t;
    float hn = (length(p) - rb) / thick;
    if (hn < 0.0 || hn > 1.0) continue;
    float cov = deckCoverage(p);
    if (cov < 0.03) continue;
    float sig = deckDensity(p, hn, cov, t < 30.0) * (1.0 - smoothstep(uDeckFadeStart, uDeckMaxDist, t));
    if (sig < 0.05) continue;
    // a sheet's (or storm's) base is not even: thicker rolls above darken it, thin spots glow
    float patchy = mix(1.0, 0.45 + 1.1 * gDeckLow, clamp(uDeckForm.x, 0.0, 1.0) * (1.0 - hn));
    // optical depth toward the sun: two taps, then the rest of the column above
    vec3 p1 = p + sunF * 0.15;
    vec3 p2 = p + sunF * 0.6;
    float h1 = (length(p1) - rb) / thick, h2 = (length(p2) - rb) / thick;
    float od = (h1 >= 0.0 && h1 <= 1.0 ? deckDensity(p1, h1, cov, false) * 0.3 : 0.0)
             + (h2 >= 0.0 && h2 <= 1.0 ? deckDensity(p2, h2, cov, false) * 0.6 : 0.0);
    // (near a base the cloud above is dense even where the soft underside is thin: with the sun
    // low the taps run along that underside and would let orange light leak into thick bases)
    float colSig = max(sig, uDeckParams.z * 0.75 * (1.0 - smoothstep(0.0, 0.3, hn)));
    od += colSig * 0.2 * max(0.0, (1.0 - hn) * thick / max(sunUp, 0.15) - 0.75);
    float ms = ph0 * exp(-od) + 0.75 * ph1 * exp(-od * 0.35) + 0.6 * ph2 * exp(-od * 0.12) + 0.5 * PH_ISO * exp(-od * 0.04);
    float powder = mix(1.0, 1.0 - exp(-sig * 0.3), powderMix);
    // light that has diffused down through the deck: what lights the base of an overcast
    float Td = 1.0 / (1.0 + 0.11 * sig * max(0.0, 1.0 - hn) * thick);
    vec3 sunS = sunE * (ms * powder + sunUp * max(0.0, Td - exp(-od)) * (0.55 / ATM_PI)) * patchy;
    vec3 skyS = skyL * mix(uDeckSkyK.y, 1.0, hn * hn) * patchy;
    vec3 gndS = (uDeckGroundL + uDeckCity) * (1.0 - hn);
    vec3 S = uDeckDbg < 0.5 || uDeckDbg > 3.5 ? sunS + skyS + gndS : uDeckDbg < 1.5 ? sunS : uDeckDbg < 2.5 ? skyS : gndS;
    if (glow) {
      // exhaust light, spread through the cloud by many scatterings (a soft, wide glow)
      vec3 dg = uDeckGlowPos - p;
      float d2 = dot(dg, dg);
      S += uDeckGlowI * (0.5 / (d2 + 0.004)) * exp(-sqrt(d2) * (0.35 + sig * 0.02));
    }
    if (uDeckFlashI > 0.0) {
      vec3 df = uDeckFlashPos - p;
      float d2 = dot(df, df);
      S += vec3(0.82, 0.88, 1.0) * uDeckFlashI / (d2 + 0.4) * exp(-sqrt(d2) * 0.45);
    }
    float Ts = exp(-sig * ds);
    L += T * S * (1.0 - Ts);
    float Tn = T * Ts;
    wT += t * (T - Tn);
    wSum += T - Tn;
    if (tFront < 0.0 && Tn < 0.5) tFront = t;
    T = Tn;
  }
  tMean = wSum > 1e-4 ? wT / wSum : -1.0;
  return vec4(L, T);
}
`;

/**
 * The deck at half resolution (MRT, GLSL3): radiance added in front of the scene and the
 * transmittance through the cloud (stored as such: half floats keep precision near zero, so a
 * thick cloud really hides the sun), and the cloud's distances for the depth-aware upsample.
 */
export const DECK_PASS_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 oCloud;
layout(location = 1) out vec4 oDepth;
uniform sampler2D tDepth;
uniform vec2 uFullSize;
uniform mat4 uInvProj;
uniform mat3 uCamRot;
uniform mat3 uPlanetRotInv;
uniform vec3 uCamPosKm;
uniform vec3 uSunDir;
uniform float uLogFar;
uniform float uTime;
${ATMOSPHERE_COMMON}
${DECK_COMMON}
${DECK_MARCH}
float dkHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float dkLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  oCloud = vec4(0.0, 0.0, 0.0, 1.0);
  oDepth = vec4(-1.0, -1.0, 0.0, 0.0);
  if (uDeckOn <= 0.0) return;
  // the farthest of the four full-resolution depths under this texel: the march runs to the
  // background and the upsampler keeps the cloud off anything nearer
  ivec2 fp = ivec2(gl_FragCoord.xy) * 2;
  ivec2 fmax = ivec2(uFullSize) - 1;
  float d = 0.0;
  for (int k = 0; k < 4; k++) d = max(d, texelFetch(tDepth, min(fp + ivec2(k & 1, k >> 1), fmax), 0).r);
  vec2 uv = (vec2(fp) + 1.0) / uFullSize;
  vec4 vp = uInvProj * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec3 rdv = normalize(vp.xyz / vp.w);
  vec3 rd = normalize(uCamRot * rdv);
  float distKm = d >= 0.999999 ? 1e9 : (exp2(d * uLogFar) - 1.0) / max(1e-6, -rdv.z) * 0.001;
  vec3 ro = uCamPosKm;
  float r = length(ro);
  vec2 tTop = raySphere2(ro, rd, uAtmTop);
  if (tTop.y <= 0.0) return;
  float tLim = distKm;
  float tGr = raySphereNear(ro, rd, uAtmBottom);
  if (tGr > 0.0) tLim = min(tLim, tGr);
  vec3 roF = uPlanetRotInv * ro;
  float tFront, tMean;
  vec4 dk = deckMarch(roF, uPlanetRotInv * rd, uPlanetRotInv * uSunDir, tLim, dkHash(gl_FragCoord.xy + fract(uTime * 7.13) * 97.0), tFront, tMean);
  float a = (1.0 - dk.a) * uDeckOn;
  if (a <= 0.001) return;
  // the air between the camera and the cloud
  float t0 = max(tTop.x, 0.0);
  vec3 Tf;
  vec3 Lf = integrateScattering(ro, rd, t0, max(tMean, t0), uSunDir, 6, Tf);
  // beneath an overcast that air is lit only by the grey light soaking through the deck
  if (r < uAtmBottom + uDeckParams.x) {
    float under = smoothstep(0.55, 0.9, deckCoverage(roF)) * uDeckOn;
    float dimF = clamp(ATM_PI * dkLum(uDeckUnderL) / max(dkLum(uSunIlluminance * getTransmittance(r, dot(ro / r, uSunDir))), 1e-4), 0.02, 1.0);
    Lf = mix(Lf, mix(Lf, vec3(dkLum(Lf)), 0.6) * dimF, under);
  }
  if (uDeckDbg > 3.5) { if (uDeckDbg < 4.5) dk.rgb = vec3(0.0); else Lf = vec3(0.0); }
  oCloud = vec4(a * Lf + Tf * dk.rgb * uDeckOn, mix(1.0, dk.a, uDeckOn));
  oDepth = vec4(tMean, tFront, 0.0, 0.0);
}
`;

const NOISE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform float uZ;
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// tiling Worley (1 at the feature points)
float worley(vec3 p, float freq) {
  vec3 x = p * freq;
  vec3 i = floor(x), f = fract(x);
  float d = 1.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int k = -1; k <= 1; k++) {
    vec3 o = vec3(float(k), float(y), float(z));
    vec3 r = o + hash33(mod(i + o, freq) + freq * 7.31) - f;
    d = min(d, dot(r, r));
  }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}
// tiling gradient noise, about -1..1
float perlin(vec3 p, float freq) {
  vec3 x = p * freq;
  vec3 i = floor(x), f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n[8];
  for (int c = 0; c < 8; c++) {
    vec3 o = vec3(float(c & 1), float((c >> 1) & 1), float((c >> 2) & 1));
    vec3 g = hash33(mod(i + o, freq) + freq * 3.17 + 0.5) * 2.0 - 1.0;
    n[c] = dot(normalize(g + 1e-5), f - o);
  }
  return mix(mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y), mix(mix(n[4], n[5], u.x), mix(n[6], n[7], u.x), u.y), u.z) * 1.6;
}
void main() {
  vec3 p = vec3(vUv, uZ);
  float w4 = worley(p, 4.0), w8 = worley(p, 8.0), w16 = worley(p, 16.0);
  float wf = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;
  float pf = perlin(p, 3.0) * 0.6 + perlin(p, 6.0) * 0.28 + perlin(p, 12.0) * 0.12;
  pf = clamp(pf * 0.5 + 0.5, 0.0, 1.0);
  // Perlin-Worley: Perlin dilated by the Worley cells, billows with soft, connected edges
  float pw = wf + pf * (1.0 - wf);
  pw = clamp((pw - 0.3) / 0.7, 0.0, 1.0);
  gl_FragColor = vec4(pw, wf, w8 * 0.6 + w16 * 0.4, pf);
}
`;

const WEATHER_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform vec3 uCenter;
uniform vec3 uE;
uniform vec3 uN;
uniform vec3 uDrift;
uniform float uSpan;
uniform float uR;
uniform float uCover;
uniform float uVar;
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vn3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1, 0, 0)), u.x), mix(h13(i + vec3(0, 1, 0)), h13(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(h13(i + vec3(0, 0, 1)), h13(i + vec3(1, 0, 1)), u.x), mix(h13(i + vec3(0, 1, 1)), h13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
void main() {
  vec2 xy = (vUv - 0.5) * uSpan;
  vec3 P = normalize(uCenter * uR + uE * xy.x + uN * xy.y) * uR - uDrift;
  float n = vn3(P / 70.0) * 0.42 + vn3(P / 28.0 + 7.1) * 0.33 + vn3(P / 13.7 + 3.3) * 0.25;
  float c = clamp(uCover + (n - 0.5) * 2.4 * uVar, 0.0, 1.0);
  gl_FragColor = vec4(c, n, 0.0, 1.0);
}
`;

const PROBE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uProbe0;
uniform vec3 uProbe1;
uniform vec3 uSunF;
${ATMOSPHERE_COMMON}
${DECK_COMMON}
void main() {
  vec3 p = gl_FragCoord.x < 1.0 ? uProbe0 : uProbe1;
  float r = length(p);
  float rb = uAtmBottom + uDeckParams.x, rt = uAtmBottom + uDeckParams.y;
  float od = 0.0;
  if (r < rt) {
    float t0 = 0.0;
    if (r < rb) t0 = max(raySphere2(p, uSunF, rb).y, 0.0);
    float t1 = min(raySphere2(p, uSunF, rt).y, t0 + 30.0);
    float ds = max(0.0, t1 - t0) / 12.0;
    for (int k = 0; k < 12; k++) {
      vec3 q = p + uSunF * (t0 + (float(k) + 0.5) * ds);
      float hn = (length(q) - rb) / (rt - rb);
      if (hn < 0.0 || hn > 1.0) continue;
      od += deckDensity(q, hn, deckCoverage(q), false) * ds;
    }
  }
  float cov = deckCoverage(p);
  float hn = (r - rb) / (rt - rb);
  gDeckNoHole = true;
  float inside = hn >= 0.0 && hn <= 1.0 ? deckDensity(p, hn, cov, true) / max(1.0, uDeckParams.z) : 0.0;
  gl_FragColor = vec4(sqrt(exp(-od)), cov, clamp(inside, 0.0, 1.0), 1.0);
}
`;

/**
 * Clear-sky irradiance on a horizontal surface at radius uR (km) with the sun at cosine uMuS:
 * the whole dome, single and multiple scattering, from rays in rings of equal projected solid
 * angle (so each carries the same cosine weight). One pixel, refreshed as the sun moves.
 */
const SKY_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
${ATMOSPHERE_COMMON}
uniform float uR;
uniform float uMuS;
void main() {
  vec3 ro = vec3(0.0, max(uR, uAtmBottom + 0.01), 0.0);
  float mu = clamp(uMuS, -1.0, 1.0);
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  vec3 E = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float u = (float(i) + 0.5) / 6.0;
    float sinT = sqrt(u), cosT = sqrt(1.0 - u);
    for (int j = 0; j < 8; j++) {
      float ph = (float(j) + 0.5 * mod(float(i), 2.0)) * (2.0 * ATM_PI / 8.0);
      vec3 rd = vec3(sinT * cos(ph), cosT, sinT * sin(ph));
      float t1 = raySphereNear(ro, rd, uAtmTop);
      if (t1 <= 0.0) continue;
      vec3 T;
      E += integrateScattering(ro, rd, 0.0, t1, sunDir, 20, T);
    }
  }
  gl_FragColor = vec4(E * (ATM_PI / 48.0), 1.0);
}
`;

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const _v = new Vector3();
const _w = new Vector3();
const _s = new Vector3();

export class CloudDeck {
  readonly uniforms = {
    uDeckOn: { value: 0 },
    uDeckParams: { value: new Vector4(1.2, 2.8, 40, 0.42) },
    uDeckForm: { value: new Vector4(0, 0, 0.45, 0) },
    uDeckWeather: { value: null as Texture | null },
    uDeckNoise: { value: null as Texture | null },
    uDeckCenter: { value: new Vector3(1, 0, 0) },
    uDeckE: { value: new Vector3(0, 1, 0) },
    uDeckN: { value: new Vector3(0, 0, 1) },
    uDeckSpan: { value: MAP_HALF * 2 },
    uDeckShift: { value: new Vector2() },
    uDeckOrigin: { value: new Vector3() },
    uDeckUnderL: { value: new Vector3() },
    uDeckTopL: { value: new Vector3() },
    uDeckProbe: { value: new Vector4() },
    uDeckFlashIrr: { value: new Vector3() },
    uDeckSteps: { value: 32 },
    uDeckMaxDist: { value: 150 },
    uDeckFadeStart: { value: 100 },
    uDeckGlowPos: { value: new Vector3() },
    uDeckGlowI: { value: new Vector3() },
    uDeckFlashPos: { value: new Vector3() },
    uDeckFlashI: { value: 0 },
    uDeckCity: { value: new Vector3() },
    uDeckGroundL: { value: new Vector3() },
    uDeckSkyE: { value: new Vector3() },
    uDeckCloudL: { value: new Vector3() },
    uDeckSkyK: { value: new Vector2(1.6, 0.5) },
    uDeckDbg: { value: 0 },
    uDeckHoleA: { value: new Vector3() },
    uDeckHoleB: { value: new Vector3() },
    uDeckHoleR: { value: new Vector2() },
  };
  /** current weather (null: no deck) */
  params: DeckParams | null = null;
  kind: DeckWeather | null = null;
  /** ray-march steps of the half-resolution pass (graphics preset) */
  steps = 56;
  /** 0.5..1: trimmed when frames run long while the deck is in view (see App) */
  stepScale = 1;
  /** sunlight reaching the lighting focus through the deck (0..1, smoothed) */
  focusSun = 1;
  /** regional cover over the camera, whether the camera is beneath the base, in cloud (0..1) */
  camCover = 0;
  camBelow = false;
  camInCloud = 0;
  /** density at the lighting focus (the vehicle), 0..1 */
  focusInCloud = 0;
  /** 0..1: how much of the deck is drawn (fades out as the camera climbs toward space) */
  active = 0;
  /** rain falling on the camera (0..1) */
  rainAtCamera = 0;
  /** grey daylight under a full deck, as a fraction of clear-sky light (for particles and lamps) */
  overcast = 0;
  /** ground under the camera (km above sea level, smoothed): cloud bases stand above the terrain */
  ground = 0;
  private groundInit = false;

  /**
   * The sky term: its scale at a cloud's top (a multiple of the dome's radiance) and its share at
   * a base under a deck of ordinary depth (deeper decks pass on less). Tuned by eye against
   * morning, noon, sunset, overcast and storm decks: grey (not brown) bases under a low sun,
   * white noon cumulus, pink sunset tops with lilac shadows.
   */
  skyScale = 1.6;
  skyBase = 0.5;

  /** cloud base and tops in use (km above sea level) */
  get baseKm(): number { return (this.params?.base ?? 0) + this.ground; }
  get topKm(): number { return (this.params?.top ?? 0) + this.ground; }

  private noiseRT: WebGL3DRenderTarget | null = null;
  private weatherRT: WebGLRenderTarget;
  private weatherMat: ShaderMaterial;
  private probeRT: WebGLRenderTarget;
  private probeMat: ShaderMaterial;
  private quad = new FullscreenQuad();
  private probeBuf = new Uint8Array(8);
  private probePending = false;
  private probeTimer = 0;
  private probeFresh = false;
  /** clear-sky irradiance at the deck (RGB, scene units), read back from the GPU */
  readonly skyIrr = new Vector3();
  private skyRT: WebGLRenderTarget;
  private skyMat: ShaderMaterial;
  private skyBuf = new Float32Array(4);
  private skyPending = false;
  private skyFresh = false;
  private skyAt = new Vector2(NaN, NaN);
  private focusSunTarget = 1;
  private mapCenter = new Vector3();
  private mapDrift = new Vector3();
  private mapDirty = true;
  /** accumulated wind drift of the whole deck (body-fixed km) */
  private drift = new Vector3();
  private windFixed = new Vector3();
  private windDir = 0;
  private origin = new Vector3();
  private time = 0;
  /** the channel the climbing vehicle punched: its path through the deck (body-fixed km, deck
   *  time), the drift when it began, and the clock */
  private hole: { path: { p: Vector3; t: number }[]; drift: Vector3; clock: number; done: boolean } | null = null;

  constructor(private renderer: WebGLRenderer, atmosphere: Atmosphere) {
    this.weatherRT = new WebGLRenderTarget(256, 256, {
      type: UnsignedByteType, format: RGBAFormat, depthBuffer: false, generateMipmaps: false,
      minFilter: LinearFilter, magFilter: LinearFilter, wrapS: ClampToEdgeWrapping, wrapT: ClampToEdgeWrapping,
    });
    this.weatherMat = new ShaderMaterial({
      blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: {
        uCenter: { value: new Vector3() }, uE: { value: new Vector3() }, uN: { value: new Vector3() }, uDrift: { value: new Vector3() },
        uSpan: { value: MAP_HALF * 2 }, uR: { value: R_EARTH_KM }, uCover: { value: 0.4 }, uVar: { value: 0.2 },
      },
      vertexShader: FULLSCREEN_VERT, fragmentShader: WEATHER_FRAG,
    });
    this.uniforms.uDeckWeather.value = this.weatherRT.texture;
    this.probeRT = new WebGLRenderTarget(2, 1, {
      type: UnsignedByteType, format: RGBAFormat, depthBuffer: false, generateMipmaps: false, minFilter: NearestFilter, magFilter: NearestFilter,
    });
    this.probeMat = new ShaderMaterial({
      blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: { ...atmosphere.uniforms, ...this.uniforms, uProbe0: { value: new Vector3() }, uProbe1: { value: new Vector3() }, uSunF: { value: new Vector3(1, 0, 0) } },
      vertexShader: FULLSCREEN_VERT, fragmentShader: PROBE_FRAG,
    });
    this.skyRT = new WebGLRenderTarget(1, 1, {
      type: FloatType, format: RGBAFormat, depthBuffer: false, generateMipmaps: false, minFilter: NearestFilter, magFilter: NearestFilter,
    });
    this.skyMat = new ShaderMaterial({
      blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: { ...atmosphere.uniforms, uR: { value: R_EARTH_KM + 1.5 }, uMuS: { value: 1 } },
      vertexShader: FULLSCREEN_VERT, fragmentShader: SKY_FRAG,
    });
  }

  /** Generate the noise volume (once, on first use: it is a few hundred thousand texels). */
  private ensureNoise(): void {
    if (this.noiseRT) return;
    const N = 64;
    const rt = new WebGL3DRenderTarget(N, N, N, { type: UnsignedByteType, format: RGBAFormat, depthBuffer: false, generateMipmaps: false });
    const tex = rt.texture;
    tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
    tex.minFilter = tex.magFilter = LinearFilter;
    const mat = new ShaderMaterial({ blending: NoBlending, depthTest: false, depthWrite: false, uniforms: { uZ: { value: 0 } }, vertexShader: FULLSCREEN_VERT, fragmentShader: NOISE_FRAG });
    this.quad.material = mat;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    for (let z = 0; z < N; z++) {
      mat.uniforms.uZ.value = (z + 0.5) / N;
      r.setRenderTarget(rt, z);
      r.render(this.quad.mesh, this.quad.camera);
    }
    r.setRenderTarget(prev);
    mat.dispose();
    this.noiseRT = rt;
    this.uniforms.uDeckNoise.value = tex;
  }

  /**
   * Set the weather (null switches the deck off). `windDir` is the direction the surface wind
   * blows toward (rad from north); the clouds drift a little veered from it.
   */
  setWeather(kind: DeckWeather | null, windDir = 0): void {
    this.kind = kind;
    this.params = kind ? { ...DECK_PRESETS[kind] } : null;
    this.windDir = windDir + 0.5;
    this.drift.set(0, 0, 0);
    this.mapDirty = true;
    this.focusSun = this.focusSunTarget = 1;
    this.probeFresh = false;
    this.hole = null;
    this.uniforms.uDeckHoleR.value.set(0, 0);
    this.uniforms.uDeckOn.value = 0;
    this.groundInit = false;
    if (!this.params) return;
    const p = this.params;
    this.uniforms.uDeckParams.value.set(p.base + this.ground, p.top + this.ground, p.density, p.cover);
    this.uniforms.uDeckForm.value.set(p.form, p.rain, p.erosion, 0);
  }

  /**
   * Per frame, before rendering.
   * @param camF camera position (body-fixed, km from the Earth's centre)
   * @param focusF lighting focus (body-fixed km)
   * @param sunF sun direction (body-fixed)
   * @param sunE sun irradiance at the top of the atmosphere over the camera, already
   *   multiplied by the air's transmittance (rendering units)
   * @param simDt simulation seconds this frame (clouds drift with the sim, capped at 60x)
   * @param groundKm terrain height under the camera (km above sea level)
   */
  update(dt: number, simDt: number, camF: Vector3, focusF: Vector3, sunF: Vector3, sunE: Vector3, skyE: number, groundKm = 0): void {
    // a deep deck (storm towers) gets proportionally more steps
    const depth = this.params ? this.params.top - this.params.base : 2;
    this.uniforms.uDeckSteps.value = Math.min(128, Math.round(this.steps * this.stepScale * Math.min(2, Math.max(1, depth / 2.5))));
    const u = this.uniforms;
    const p = this.params;
    const camAlt = camF.length() - R_EARTH_KM;
    // from high up the planet-wide cloud map reads better: hand over between 20 and 50 km, and
    // as the camera climbs the deck already gives way to it closer in, so there is no rim
    this.active = p ? 1 - smooth(20, 50, camAlt) : 0;
    u.uDeckFadeStart.value = u.uDeckMaxDist.value * (0.65 - 0.5 * smooth(3, 30, camAlt));
    u.uDeckOn.value = this.active;
    // the deck stands on the terrain: follow the ground under the camera, slowly (mountains
    // in passing should not make the sky bob)
    const g = Math.max(0, groundKm);
    if (!this.groundInit) { this.ground = g; this.groundInit = true; }
    else this.ground += (g - this.ground) * (1 - Math.exp(-dt / 8));
    if (p) { u.uDeckParams.value.x = p.base + this.ground; u.uDeckParams.value.y = p.top + this.ground; }
    if (!p || this.active <= 0) {
      this.rainAtCamera = 0; this.camInCloud = 0; this.focusInCloud = 0; this.overcast = 0; this.focusSun = 1;
      u.uDeckProbe.value.set(0, 0, 0, 0);
      return;
    }
    this.ensureNoise();
    this.time += dt;
    // wind drift (body-fixed km): toward windDir in the local horizontal plane at the camera
    const up = _v.copy(camF).normalize();
    const east = _w.set(-up.y, up.x, 0);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    const north = new Vector3().crossVectors(up, east);
    this.windFixed.copy(north).multiplyScalar(Math.cos(this.windDir)).addScaledVector(east, Math.sin(this.windDir)).multiplyScalar(p.wind / 1000);
    this.drift.addScaledVector(this.windFixed, Math.min(Math.max(0, simDt), Math.max(dt, 1 / 240) * 60));
    // weather map around the camera
    const k = up.dot(this.mapCenter);
    if (this.mapDirty || k < Math.cos(MAP_RECENTRE / R_EARTH_KM) || this.drift.distanceTo(this.mapDrift) > MAP_RECENTRE * 0.5) this.buildMap(up);
    const dd = _w.copy(this.drift).sub(this.mapDrift);
    u.uDeckShift.value.set(dd.dot(u.uDeckE.value), dd.dot(u.uDeckN.value));
    // noise origin: snapped to the shape tile near the camera, plus the drift
    const snap = (x: number) => Math.round(x / BASE_TILE) * BASE_TILE;
    if (this.origin.distanceTo(camF) > 200 || this.origin.lengthSq() === 0) this.origin.set(snap(camF.x), snap(camF.y), snap(camF.z));
    u.uDeckOrigin.value.copy(this.origin).add(this.drift);
    u.uDeckForm.value.w = this.time;
    // grey daylight under a full deck: sunlight diffusing through the whole column (two-stream)
    const muS = up.dot(sunF);
    // the clear sky's light at the deck (GPU, read back as the sun moves); a rough bluish
    // estimate until the first readback arrives
    const rMid = R_EARTH_KM + this.ground + (p.base + p.top) / 2;
    if (!this.skyPending && (!(Math.abs(muS - this.skyAt.x) < 0.002) || !(Math.abs(rMid - this.skyAt.y) < 0.2))) this.runSky(rMid, muS);
    const sky = this.skyFresh ? _s.copy(this.skyIrr) : _s.set(0.78, 0.92, 1.25).multiplyScalar(skyE);
    u.uDeckSkyE.value.copy(sky);
    const od = p.density * (p.top - p.base) * 0.7;
    const Td = 1 / (1 + 0.11 * od);
    // the sunlit ground lights the cloud bases from below (albedo ~0.12, a little green), less so
    // under a full deck that keeps sun and sky off the ground
    const groundK = 1 - p.cover * p.cover * (1 - Td);
    u.uDeckGroundL.value.copy(sunE).multiplyScalar(Math.max(0, muS)).add(sky).multiplyScalar(groundK).multiply(_w.set(0.11, 0.125, 0.1)).multiplyScalar(1 / Math.PI);
    // the grey daylight under a full deck is the radiance of its base as the march renders it
    // (sunlight diffused down the column, the sky's share at a base, light back from the ground),
    // so the ground and everything under the deck are lit by the cloud the camera sees
    // the sky's share at a base falls with the column's diffuse transmission (a storm's base is
    // dark), relative to the 1.3 km breezy deck the share was tuned on
    const kSky = u.uDeckSkyK.value.set(this.skyScale, this.skyBase * Math.min(1.2, Math.max(0.15, Td / 0.2)));
    u.uDeckUnderL.value.copy(sunE).multiplyScalar((Math.max(0, muS) * Td * 0.55) / Math.PI).addScaledVector(sky, (kSky.x * kSky.y) / Math.PI).add(u.uDeckGroundL.value);
    // night: towns light the cloud bases a dull orange
    const night = 1 - smooth(-0.15, 0.05, muS);
    u.uDeckCity.value.set(1, 0.62, 0.34).multiplyScalar(0.0009 * night * (0.5 + 0.5 * p.cover));
    // probe: sunlight at the focus, conditions at the camera
    this.probeTimer -= dt;
    if (!this.probePending && this.probeTimer <= 0) this.runProbe(focusF, camF, sunF);
    const kf = 1 - Math.exp(-dt / (this.probeFresh ? 0.6 : 0.01));
    this.focusSun += (this.focusSunTarget - this.focusSun) * kf;
    const rb = R_EARTH_KM + this.baseKm;
    this.camBelow = camF.length() < rb;
    const under = this.camBelow ? smooth(0.55, 0.9, this.camCover) : 0;
    this.overcast = under * this.active;
    // the sunlit top seen from above: bright, slightly warm with the low sun
    u.uDeckTopL.value.copy(sunE).multiplyScalar(((0.3 + 0.7 * Math.max(0, muS)) * 0.8) / Math.PI);
    const above = camF.length() > R_EARTH_KM + this.topKm;
    // broken cloud seen from below: its sunlit sides and grey bases send down far more light
    // than the patch of blue they hide, and less blue (on the ground a fair-weather sky gives
    // about twice the diffuse light of a clear one)
    u.uDeckCloudL.value.copy(sunE).multiplyScalar(Math.max(0, muS) * 0.3).addScaledVector(sky, 0.5).multiplyScalar(1 / Math.PI);
    u.uDeckProbe.value.set(this.overcast, above ? p.cover * this.active : 0, above ? 0 : p.cover * this.active * (1 - under), 0);
    this.rainAtCamera = this.camBelow ? p.rain * smooth(0.6, 0.9, this.camCover) * this.active : 0;
  }

  private buildMap(up: Vector3): void {
    const p = this.params!;
    const u = this.uniforms;
    this.mapCenter.copy(up);
    this.mapDrift.copy(this.drift);
    const e = u.uDeckE.value.set(-up.y, up.x, 0);
    if (e.lengthSq() < 1e-8) e.set(1, 0, 0);
    e.normalize();
    u.uDeckN.value.crossVectors(up, e);
    u.uDeckCenter.value.copy(up);
    const wu = this.weatherMat.uniforms;
    (wu.uCenter.value as Vector3).copy(up);
    (wu.uE.value as Vector3).copy(e);
    (wu.uN.value as Vector3).copy(u.uDeckN.value);
    (wu.uDrift.value as Vector3).copy(this.drift);
    wu.uCover.value = p.cover;
    wu.uVar.value = p.variation;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this.quad.render(r, this.weatherRT, this.weatherMat);
    r.setRenderTarget(prev);
    this.mapDirty = false;
  }

  private runSky(rKm: number, muS: number): void {
    const su = this.skyMat.uniforms;
    su.uR.value = rKm;
    su.uMuS.value = muS;
    this.skyAt.set(muS, rKm);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this.quad.render(r, this.skyRT, this.skyMat);
    r.setRenderTarget(prev);
    this.skyPending = true;
    r.readRenderTargetPixelsAsync(this.skyRT, 0, 0, 1, 1, this.skyBuf).then(() => {
      const b = this.skyBuf;
      if (Number.isFinite(b[0] + b[1] + b[2])) { this.skyIrr.set(b[0], b[1], b[2]); this.skyFresh = true; }
    }).catch(() => undefined).finally(() => { this.skyPending = false; });
  }

  private runProbe(focusF: Vector3, camF: Vector3, sunF: Vector3): void {
    const pu = this.probeMat.uniforms;
    (pu.uProbe0.value as Vector3).copy(focusF);
    (pu.uProbe1.value as Vector3).copy(camF);
    (pu.uSunF.value as Vector3).copy(sunF);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this.quad.render(r, this.probeRT, this.probeMat);
    r.setRenderTarget(prev);
    this.probePending = true;
    this.probeTimer = 0.1;
    r.readRenderTargetPixelsAsync(this.probeRT, 0, 0, 2, 1, this.probeBuf).then(() => {
      const b = this.probeBuf;
      const s = b[0] / 255;
      this.focusSunTarget = s * s;
      this.focusInCloud = b[2] / 255;
      this.camCover = b[5] / 255;
      this.camInCloud = b[6] / 255;
      if (!this.probeFresh) this.focusSun = this.focusSunTarget;
      this.probeFresh = true;
    }).catch(() => {
      // no async readback: fall back to the mean cover
      const p = this.params;
      this.focusSunTarget = p ? 1 - p.cover * p.cover : 1;
      this.camCover = p?.cover ?? 0;
    }).finally(() => { this.probePending = false; });
  }

  /**
   * Exhaust light for the deck: the brightest plume cluster, body-fixed km, with its intensity
   * (the point light's, in candela-like scene units) and colour.
   */
  setGlow(posF: Vector3 | null, intensity = 0, color?: Vector3): void {
    const u = this.uniforms;
    if (!posF || intensity <= 0) { u.uDeckGlowI.value.set(0, 0, 0); return; }
    u.uDeckGlowPos.value.copy(posF);
    // I / d^2 with d in metres -> per km^2
    u.uDeckGlowI.value.copy(color ?? _v.set(1, 0.6, 0.3)).multiplyScalar(intensity * 1e-6);
  }

  /**
   * The active vehicle (body-fixed km) and whether it is climbing under power: going up through
   * the deck it punches a channel that spreads and drifts with the cloud.
   */
  trackVehicle(posF: Vector3 | null, climbing: boolean, dt: number): void {
    const p = this.params;
    const u = this.uniforms;
    if (!p) { this.hole = null; u.uDeckHoleR.value.set(0, 0); return; }
    if (this.hole) this.hole.clock += dt;
    if (posF && climbing) {
      const alt = posF.length() - R_EARTH_KM;
      if (alt > this.baseKm - 0.1 && alt < this.topKm + 0.3) {
        if (!this.hole || this.hole.done) this.hole = { path: [], drift: this.drift.clone(), clock: 0, done: false };
        const path = this.hole.path;
        if (!path.length || path[path.length - 1].p.distanceTo(posF) > 0.03) path.push({ p: posF.clone(), t: this.hole.clock });
      } else if (this.hole && alt >= this.topKm + 0.3) this.hole.done = true;
    }
    const h = this.hole;
    // the channel opens LAG seconds behind the vehicle and spreads at RATE km/s
    const LAG = 4, RATE = 0.006;
    const open = h ? h.path.filter((q) => h.clock - q.t >= LAG) : [];
    if (!h || open.length < 2) { u.uDeckHoleR.value.set(0, 0); return; }
    const a = open[0], b = open[open.length - 1];
    const dd = _w.copy(this.drift).sub(h.drift);
    u.uDeckHoleA.value.copy(a.p).add(dd);
    u.uDeckHoleB.value.copy(b.p).add(dd);
    const rad = (q: { t: number }) => Math.min(0.45, 0.005 + RATE * (h.clock - q.t - LAG));
    u.uDeckHoleR.value.set(rad(a), rad(b));
  }

  /** Lightning inside the deck (body-fixed km), or off. */
  setFlash(posF: Vector3 | null, intensity = 0): void {
    const u = this.uniforms;
    u.uDeckFlashI.value = posF ? intensity : 0;
    if (posF) u.uDeckFlashPos.value.copy(posF);
  }

  /** World -> body-fixed helper for callers holding the Earth's rotation. */
  static toFixed(world: Vector3, earthRotInv: Quaternion, out: Vector3): Vector3 { return out.copy(world).applyQuaternion(earthRotInv); }

  dispose(): void {
    this.noiseRT?.dispose();
    this.weatherRT.dispose();
    this.probeRT.dispose();
    this.skyRT.dispose();
    this.weatherMat.dispose();
    this.probeMat.dispose();
    this.skyMat.dispose();
  }
}
