import { GLSL3, Matrix3, ShaderMaterial, Texture, Vector2, Vector3, Vector4 } from 'three';
import { ATMOSPHERE_COMMON } from '../atmosphere/glsl';
import { DECK_COMMON } from '../weather/CloudDeck';
import { SITE_LAMPS, type SiteLampUniforms } from '../site/siteMaterials';

/**
 * Earth & Moon terrain shaders. Lighting is done in the body-fixed frame (km) so the atmosphere
 * functions (transmittance, multiple scattering) apply directly; the atmosphere composite pass
 * later adds aerial perspective between the camera and each fragment.
 */

const COMMON_VERT = /* glsl */ `
in vec3 aDir;
in vec4 aExtra;
in float aHeight;
in vec2 aDetail;
out vec3 vDir;
out vec4 vExtra;
out float vHeight;
out vec2 vDetail;
out vec3 vNormalF;
out vec3 vViewPos;
uniform float logDepthBufFC;
out float vFragDepth;
void main() {
  vDir = aDir;
  vExtra = aExtra;
  vHeight = aHeight;
  vDetail = aDetail;
  vNormalF = normal;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
  vFragDepth = 1.0 + gl_Position.w;
}
`;

const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
`;

export const EARTH_FRAG = /* glsl */ `
precision highp float;
in vec3 vDir;
in vec4 vExtra;
in float vHeight;
in vec2 vDetail;
in vec3 vNormalF;
in vec3 vViewPos;
in float vFragDepth;
uniform float logDepthBufFC;
uniform sampler2D uAlbedo;
uniform sampler2D uNight;
uniform sampler2D uData;
uniform sampler2D uClouds;
uniform sampler2D uDetailTex;
uniform vec3 uSunDirF;          // body-fixed sun direction
uniform mat3 uViewToFixed;      // view-space -> body-fixed rotation
uniform float uRadiusM;
uniform float uCloudRot;        // cloud-layer drift (radians of longitude)
uniform float uTime;
uniform float uCityLights;
uniform float uCloudShadow;
uniform float uDetailStrength;
uniform vec3 uPalScrub, uPalGrass, uPalForest, uPalWet, uPalDry, uPalSoil, uPalSand;
uniform int uDebug;
// the launch site's lamps after dark, in view space (shared with the site's own materials)
uniform int uLampCount;
uniform vec3 uLampPos[${SITE_LAMPS}];
uniform vec3 uLampDir[${SITE_LAMPS}];
uniform vec4 uLampCol[${SITE_LAMPS}];
uniform vec2 uLampCone[${SITE_LAMPS}];
${ATMOSPHERE_COMMON}
${DECK_COMMON}
${NOISE_GLSL}

vec2 dirToUV(vec3 d) {
  float lon = atan(d.y, d.x);
  float lat = asin(clamp(d.z, -1.0, 1.0));
  return vec2(lon / (2.0 * ATM_PI) + 0.5, 0.5 + lat / ATM_PI);
}
vec4 sampleSeamless(sampler2D t, vec2 uv) {
  vec2 uvB = vec2(fract(uv.x + 0.5), uv.y);
  vec2 dxA = dFdx(uv), dyA = dFdy(uv), dxB = dFdx(uvB), dyB = dFdy(uvB);
  vec2 dx = abs(dxA.x) <= abs(dxB.x) ? dxA : dxB;
  vec2 dy = abs(dyA.x) <= abs(dyB.x) ? dyA : dyB;
  return textureGrad(t, uv, dx, dy);
}
vec3 rotateZ(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z); }

float ggx(float NdotH, float a) { float a2 = a * a; float d = NdotH * NdotH * (a2 - 1.0) + 1.0; return a2 / (ATM_PI * d * d); }

void main() {
  vec3 dir = normalize(vDir);
  vec2 uv = dirToUV(dir);
  vec3 albedo = sampleSeamless(uAlbedo, uv).rgb;
  vec4 data = sampleSeamless(uData, uv);
  float viewDist = length(vViewPos);
  float siteW = vExtra.w;
  float water = mix(data.r, vExtra.x, siteW);
  float sand = vExtra.y;
  float shallow = data.b;

  // geometric normal (body-fixed) + far-field relief from the elevation map
  vec3 N = normalize(vNormalF);
  vec3 up = dir;
  float texelAng = 1.0 / 4096.0 * 6.2831853;
  vec3 east = normalize(vec3(-dir.y, dir.x, 0.0) + 1e-6);
  vec3 north = normalize(cross(up, east));
  float hE = texture(uData, dirToUV(normalize(dir + east * texelAng))).g;
  float hN = texture(uData, dirToUV(normalize(dir + north * texelAng))).g;
  float hC = data.g;
  float reliefScale = smoothstep(2000.0, 60000.0, viewDist) * (1.0 - water) * 9.0;
  N = normalize(N - (east * (hE - hC) + north * (hN - hC)) * reliefScale);

  // near-field ground cover (tileable noise at five scales, integer multiples keep it seamless):
  // vegetation communities at km scale, patches at 10-100 m, texture at metre scale
  float near = 1.0 - smoothstep(1500.0, 14000.0, viewDist);
  float nearer = 1.0 - smoothstep(40.0, 700.0, viewDist);
  // fbm is concentrated around 0.5: stretch the contrast so thresholds carve real patches
  vec3 dM = clamp((texture(uDetailTex, vDetail * 0.25).rgb - 0.5) * 2.6 + 0.5, 0.0, 1.0);
  vec3 det3 = clamp((texture(uDetailTex, vDetail * 1.0).rgb - 0.5) * 2.6 + 0.5, 0.0, 1.0);
  vec3 det = clamp((texture(uDetailTex, vDetail * 8.0).rgb - 0.5) * 2.4 + 0.5, 0.0, 1.0);
  vec3 det2 = clamp((texture(uDetailTex, vDetail * 64.0).rgb - 0.5) * 2.0 + 0.5, 0.0, 1.0);
  vec3 det4 = clamp((texture(uDetailTex, vDetail * 512.0).rgb - 0.5) * 2.0 + 0.5, 0.0, 1.0);
  if (near > 0.0 && water < 0.5) {
    float veg = dM.r * 0.5 + det3.r * 0.35 + det.r * 0.15;
    float moist = dM.g * 0.55 + det3.b * 0.3 + det.b * 0.15;
    vec3 local = mix(uPalScrub, uPalGrass, smoothstep(0.42, 0.66, veg));
    local = mix(local, uPalForest, smoothstep(0.56, 0.74, det3.g * 0.7 + dM.b * 0.3) * 0.85);
    local = mix(local, uPalWet, smoothstep(0.66, 0.8, moist) * 0.75);
    // bare soil, dry patches and tracks
    local = mix(local, uPalDry, smoothstep(0.6, 0.85, det.b * 0.6 + det2.g * 0.4) * 0.6);
    local = mix(local, uPalSoil, smoothstep(0.76, 0.92, det.g) * 0.55);
    // cleared, mowed ground inside the launch site
    float cleared = smoothstep(0.15, 0.85, vExtra.z);
    vec3 mowed = mix(uPalGrass, uPalDry, smoothstep(0.42, 0.78, det.b * 0.55 + det2.r * 0.45));
    mowed = mix(mowed, uPalSoil, smoothstep(0.8, 0.95, det2.g) * 0.4);
    local = mix(local, mowed, cleared);
    local *= 0.78 + 0.44 * det2.r;
    local *= mix(1.0, 0.72 + 0.56 * det4.g, nearer);
    vec3 sandC = uPalSand * (0.85 + 0.3 * det2.b) * mix(1.0, 0.85 + 0.3 * det4.r, nearer);
    local = mix(local, sandC, sand);
    albedo = mix(albedo, local, near * uDetailStrength);
    vec3 dn = (vec3(det2.g, det2.b, 0.0) - 0.5) * 0.45 * near + (vec3(det.g, det.b, 0.0) - 0.5) * 0.3 * near
            + (vec3(det4.b, det4.r, 0.0) - 0.5) * 0.6 * nearer;
    N = normalize(N + east * dn.x + north * dn.y);
  }
  // positions in km (body-fixed)
  vec3 pKm = dir * (uRadiusM + max(vHeight, 0.0)) * 0.001;
  float r = length(pKm);
  vec3 L = normalize(uSunDirF);
  vec3 sunT = sunTransmittanceAt(pKm, L);
  float muS = dot(up, L);

  // cloud shadows: sample the cloud layer along the sun ray
  vec3 shadowDir = normalize(dir + L * (8.0 / 6371.0) / max(0.08, muS));
  float cl = texture(uClouds, dirToUV(rotateZ(shadowDir, -uCloudRot))).r;
  float cloudShade = 1.0 - uCloudShadow * smoothstep(0.15, 0.8, cl) * 0.85;
  // near the camera the low cloud deck casts the shadows instead of the planet-wide map
  cloudShade = mix(cloudShade, 1.0, uDeckOn * (1.0 - smoothstep(90000.0, 150000.0, viewDist)));
  float deckSun = deckSunShadow(pKm, L);
  // under an overcast the light is the grey glow of the cloud base, from every direction
  float deckUnder = uDeckOn > 0.0 ? smoothstep(0.55, 0.9, deckCoverage(pKm)) * uDeckOn * (1.0 - smoothstep(90000.0, 150000.0, viewDist)) : 0.0;

  vec3 V = normalize(uViewToFixed * (-vViewPos));
  vec3 sunIrr = uSunIlluminance * sunT * cloudShade * deckSun;
  // sky ambient approximated from the multiple-scattering LUT
  vec3 skyAmb = getMultiScat(r, muS) * uSunIlluminance * 4.0;
  skyAmb = mix(skyAmb, uDeckUnderL * ATM_PI, deckUnder) + uDeckFlashIrr;
  vec3 color;
  if (water > 0.5) {
    // ocean: deep colour + shallow tint + Fresnel sky reflection + GGX sun glint
    // water body colour (subsurface): deep navy; only very shallow sandy banks turn turquoise
    vec3 deep = vec3(0.0035, 0.014, 0.032);
    vec3 shelf = vec3(0.012, 0.055, 0.07);
    vec3 baseW = mix(deep, shelf, smoothstep(0.55, 1.0, shallow) * 0.85 + shallow * 0.1);
    // waves (near: animated normal noise; far: statistical roughness)
    float wscale = vDetail.x * 160.0;
    vec2 wp = vDetail * 160.0;
    float n1 = vnoise(wp + vec2(uTime * 0.35, uTime * 0.21));
    float n2 = vnoise(wp * 2.3 - vec2(uTime * 0.5, -uTime * 0.31));
    vec3 Nw = normalize(up + (east * (n1 - 0.5) + north * (n2 - 0.5)) * 0.18 * near);
    float NdotL = max(0.0, dot(Nw, L));
    float NdotV = max(1e-3, dot(Nw, V));
    vec3 H = normalize(L + V);
    float rough = mix(0.08, 0.32, smoothstep(5000.0, 400000.0, viewDist));
    float spec = ggx(max(0.0, dot(Nw, H)), rough) * 0.25 / max(0.15, NdotV);
    float fres = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
    vec3 skyRefl = skyAmb * 0.9 + vec3(0.02, 0.04, 0.08) * uSunIlluminance * max(0.0, muS) * 0.05;
    color = baseW * (sunIrr * NdotL + skyAmb) / ATM_PI + fres * skyRefl / ATM_PI + spec * fres * sunIrr * NdotL * 4.0;
    // surf line near the coast
    float surf = smoothstep(0.5, 0.56, water) * (1.0 - smoothstep(0.56, 0.75, water)) * near;
    color += vec3(0.6) * surf * (sunIrr * max(0.0, muS) + skyAmb) / ATM_PI * (0.4 + 0.6 * det2.r);
  } else {
    float NdotL = max(0.0, dot(N, L));
    // soft wrap so the terminator isn't a hard line on rough terrain
    float wrap = max(0.0, (dot(N, L) + 0.08) / 1.08);
    color = albedo / ATM_PI * (sunIrr * mix(NdotL, wrap, 0.25) + skyAmb * (0.6 + 0.4 * dot(N, up)));
    // pools of lamplight around the site after dark, carrying on past the roads and aprons
    for (int i = 0; i < ${SITE_LAMPS}; i++) {
      if (i >= uLampCount) break;
      vec3 Lv = uLampPos[i] - vViewPos;
      float d2 = dot(Lv, Lv);
      if (d2 >= uLampCol[i].w) continue;
      vec3 l = Lv * inversesqrt(max(d2, 1e-6));
      float q = d2 / uLampCol[i].w;
      float beam = smoothstep(uLampCone[i].x, uLampCone[i].y, dot(-l, uLampDir[i]));
      float ndl = max(0.0, dot(N, uViewToFixed * l));
      color += albedo / ATM_PI * uLampCol[i].rgb * (beam * (1.0 - q * q) * (1.0 - q * q) * ndl / max(d2, 0.25));
    }
  }
  // city lights on the night side (hidden under clouds)
  float night = 1.0 - smoothstep(-0.12, 0.02, muS);
  vec3 lights = sampleSeamless(uNight, uv).rgb;
  float cloudOver = texture(uClouds, dirToUV(rotateZ(dir, -uCloudRot))).r;
  // (the map is ~10 km per texel: close up it would paint a uniform orange glow on the ground,
  // so it only appears with distance - towns on the horizon, cities from altitude)
  float cityFade = smoothstep(4000.0, 40000.0, viewDist);
  color += lights * lights * night * uCityLights * cityFade * (1.0 - 0.75 * smoothstep(0.2, 0.8, cloudOver)) * (1.0 - water * 0.9);

  if (uDebug == 1) color = albedo * 10.0;
  else if (uDebug == 2) color = (normalize(vNormalF) * 0.5 + 0.5) * 10.0;
  else if (uDebug == 3) color = vec3(fract(uv * 8.0), 0.0) * 10.0;
  gl_FragColor = vec4(color, 1.0);
  gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
}
`;

export const MOON_FRAG = /* glsl */ `
precision highp float;
in vec3 vDir;
in vec4 vExtra;
in float vHeight;
in vec2 vDetail;
in vec3 vNormalF;
in vec3 vViewPos;
in float vFragDepth;
uniform float logDepthBufFC;
uniform sampler2D uAlbedo;
uniform sampler2D uDetailTex;
uniform vec3 uSunDirF;
uniform mat3 uViewToFixed;
uniform vec3 uSunIrradiance;
uniform vec3 uEarthshine;
uniform vec3 uEarthDirF;
${NOISE_GLSL}
#define PI 3.14159265358979
vec2 dirToUV(vec3 d) {
  float lon = atan(d.y, d.x);
  float lat = asin(clamp(d.z, -1.0, 1.0));
  return vec2(lon / (2.0 * PI) + 0.5, 0.5 + lat / PI);
}
vec4 sampleSeamless(sampler2D t, vec2 uv) {
  vec2 uvB = vec2(fract(uv.x + 0.5), uv.y);
  vec2 dxA = dFdx(uv), dyA = dFdy(uv), dxB = dFdx(uvB), dyB = dFdy(uvB);
  return textureGrad(t, uv, abs(dxA.x) <= abs(dxB.x) ? dxA : dxB, abs(dyA.x) <= abs(dyB.x) ? dyA : dyB);
}
// Hapke-inspired lunar photometry: Lommel-Seeliger with opposition surge
vec3 lunarBRDF(vec3 albedo, float mu0, float mu, float g) {
  float ls = mu0 / max(1e-3, mu0 + mu);
  float surge = 1.0 + 0.6 * exp(-g / 0.06);
  return albedo * ls * surge * 2.0;
}
void main() {
  vec3 dir = normalize(vDir);
  vec2 uv = dirToUV(dir);
  vec3 albedo = sampleSeamless(uAlbedo, uv).rgb;
  float viewDist = length(vViewPos);
  vec3 N = normalize(vNormalF);
  float near = 1.0 - smoothstep(300.0, 6000.0, viewDist);
  vec3 det = texture(uDetailTex, vDetail * 16.0).rgb;
  vec3 det2 = texture(uDetailTex, vDetail * 128.0).rgb;
  vec3 east = normalize(vec3(-dir.y, dir.x, 0.0) + 1e-6);
  vec3 north = normalize(cross(dir, east));
  // fine regolith texture: gentle (strong normal noise turns a low sun into black speckle)
  N = normalize(N + (east * (det2.g - 0.5) + north * (det2.b - 0.5)) * 0.14 * near + (east * (det.g - 0.5) + north * (det.b - 0.5)) * 0.1 * near);
  albedo *= mix(1.0, 0.85 + 0.3 * det2.r, near);
  vec3 L = normalize(uSunDirF);
  vec3 V = normalize(uViewToFixed * (-vViewPos));
  float mu0 = max(0.0, dot(N, L));
  float mu = max(0.0, dot(N, V));
  float g = acos(clamp(dot(L, V), -1.0, 1.0));
  vec3 color = lunarBRDF(albedo, mu0, mu, g) * uSunIrradiance / PI;
  // earthshine on the night side
  color += albedo * max(0.0, dot(N, normalize(uEarthDirF))) * uEarthshine / PI;
  gl_FragColor = vec4(color, 1.0);
  gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
}
`;

/** Linear-albedo ground-cover palettes by climate (scrub, grass, forest, wetland, dry grass, soil, sand). */
export type GroundClimate = 'subtropical' | 'tropical' | 'steppe' | 'coastal' | 'arid';
const PALETTES: Record<GroundClimate, number[][]> = {
  //            scrub                    grass                  forest                  wetland                 dry grass             soil                  sand
  subtropical: [[0.05, 0.058, 0.036], [0.085, 0.098, 0.052], [0.036, 0.045, 0.03], [0.04, 0.046, 0.036], [0.15, 0.14, 0.09], [0.19, 0.16, 0.12], [0.46, 0.42, 0.33]],
  tropical: [[0.038, 0.052, 0.028], [0.068, 0.09, 0.042], [0.026, 0.038, 0.022], [0.034, 0.044, 0.032], [0.12, 0.115, 0.07], [0.22, 0.14, 0.09], [0.44, 0.4, 0.31]],
  steppe: [[0.15, 0.135, 0.095], [0.19, 0.175, 0.12], [0.11, 0.11, 0.08], [0.1, 0.1, 0.075], [0.26, 0.225, 0.16], [0.23, 0.19, 0.15], [0.42, 0.38, 0.3]],
  coastal: [[0.075, 0.078, 0.052], [0.11, 0.11, 0.07], [0.05, 0.056, 0.04], [0.055, 0.058, 0.045], [0.2, 0.18, 0.12], [0.24, 0.2, 0.15], [0.5, 0.45, 0.35]],
  arid: [[0.2, 0.16, 0.11], [0.22, 0.19, 0.12], [0.12, 0.11, 0.08], [0.15, 0.13, 0.1], [0.3, 0.25, 0.17], [0.32, 0.24, 0.16], [0.5, 0.42, 0.3]],
};
const PAL_NAMES = ['uPalScrub', 'uPalGrass', 'uPalForest', 'uPalWet', 'uPalDry', 'uPalSoil', 'uPalSand'];
export function groundPaletteUniforms(c: GroundClimate): Record<string, { value: Vector3 }> {
  const out: Record<string, { value: Vector3 }> = {};
  PALETTES[c].forEach((v, i) => { out[PAL_NAMES[i]] = { value: new Vector3(v[0], v[1], v[2]) }; });
  return out;
}
export function setGroundPalette(mat: ShaderMaterial, c: GroundClimate): void {
  PALETTES[c].forEach((v, i) => (mat.uniforms[PAL_NAMES[i]].value as Vector3).set(v[0], v[1], v[2]));
}

export function createEarthMaterial(
  tex: { albedo: Texture; night: Texture; data: Texture; clouds: Texture; detail: Texture },
  atmUniforms: Record<string, { value: unknown }>,
  deckUniforms: Record<string, { value: unknown }>,
): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      ...atmUniforms,
      ...deckUniforms,
      uAlbedo: { value: tex.albedo },
      uNight: { value: tex.night },
      uData: { value: tex.data },
      uClouds: { value: tex.clouds },
      uDetailTex: { value: tex.detail },
      uSunDirF: { value: new Vector3(1, 0, 0) },
      uViewToFixed: { value: new Matrix3() },
      uRadiusM: { value: 6371000 },
      uCloudRot: { value: 0 },
      uTime: { value: 0 },
      uCityLights: { value: 0.02 },
      uCloudShadow: { value: 1 },
      uDetailStrength: { value: 1 },
      ...groundPaletteUniforms('subtropical'),
      uDebug: { value: 0 },
      ...lampUniforms(null),
    },
    vertexShader: COMMON_VERT,
    fragmentShader: EARTH_FRAG,
  });
}

/** The terrain's view of the launch site's lamps: the site's own uniforms, or none. */
export function lampUniforms(L: SiteLampUniforms | null): Record<string, { value: unknown }> {
  if (L) return { uLampCount: L.count, uLampPos: L.pos, uLampDir: L.dir, uLampCol: L.col, uLampCone: L.cone };
  const n = SITE_LAMPS;
  return {
    uLampCount: { value: 0 },
    uLampPos: { value: Array.from({ length: n }, () => new Vector3()) },
    uLampDir: { value: Array.from({ length: n }, () => new Vector3(0, -1, 0)) },
    uLampCol: { value: Array.from({ length: n }, () => new Vector4()) },
    uLampCone: { value: Array.from({ length: n }, () => new Vector2(0, 1)) },
  };
}

export function createMoonMaterial(tex: { albedo: Texture; detail: Texture }): ShaderMaterial {
  return new ShaderMaterial({
    
    uniforms: {
      uAlbedo: { value: tex.albedo },
      uDetailTex: { value: tex.detail },
      uSunDirF: { value: new Vector3(1, 0, 0) },
      uViewToFixed: { value: new Matrix3() },
      uSunIrradiance: { value: new Vector3(110, 108, 103) },
      uEarthshine: { value: new Vector3(0.02, 0.025, 0.035) },
      uEarthDirF: { value: new Vector3(1, 0, 0) },
    },
    vertexShader: COMMON_VERT,
    fragmentShader: MOON_FRAG,
  });
}
