/**
 * Shared GLSL for physically based atmospheric scattering (Hillaire 2020, Bruneton 2017 LUT
 * parameterisations). Lengths in kilometres. Include ATMOSPHERE_COMMON in any shader that
 * needs sun transmittance, sky light or aerial perspective.
 */

export const ATMOSPHERE_UNIFORMS = /* glsl */ `
uniform float uAtmBottom;
uniform float uAtmTop;
uniform vec3 uRayleighScat;
uniform float uRayleighH;
uniform float uMieScat;
uniform float uMieExt;
uniform float uMieH;
uniform float uMieG;
uniform vec3 uAbsExt;
uniform float uAbsCenter;
uniform float uAbsWidth;
uniform vec3 uGroundAlbedo;
uniform vec3 uSunIlluminance;
uniform float uMultiScatFactor;
uniform sampler2D uTransmittanceLUT;
uniform sampler2D uMultiScatLUT;
`;

export const ATMOSPHERE_COMMON = /* glsl */ `
${ATMOSPHERE_UNIFORMS}
#ifndef ATM_PI
#define ATM_PI 3.14159265358979
#endif
const vec2 TRANSMITTANCE_SIZE = vec2(256.0, 64.0);
const vec2 MULTISCAT_SIZE = vec2(32.0, 32.0);

// nearest non-negative intersection (from inside or outside), -1 if none
float raySphereNear(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc);
  float t0 = -b - s;
  float t1 = -b + s;
  if (t0 >= 0.0) return t0;
  if (t1 >= 0.0) return t1;
  return -1.0;
}
vec2 raySphere2(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

float fromUnitToSubUvs(float u, float res) { return (u + 0.5 / res) * (res / (res + 1.0)); }
float fromSubUvsToUnit(float u, float res) { return (u - 0.5 / res) * (res / (res - 1.0)); }

struct MediumSample {
  vec3 scatR;
  vec3 scatM;
  vec3 scattering;
  vec3 extinction;
};

MediumSample sampleMedium(float h) {
  MediumSample m;
  float dR = exp(-max(h, 0.0) / uRayleighH);
  float dM = exp(-max(h, 0.0) / uMieH);
  float dA = max(0.0, 1.0 - abs(h - uAbsCenter) / (0.5 * uAbsWidth));
  m.scatR = uRayleighScat * dR;
  m.scatM = vec3(uMieScat * dM);
  vec3 extM = vec3(uMieExt * dM);
  vec3 extA = uAbsExt * dA;
  m.scattering = m.scatR + m.scatM;
  m.extinction = m.scatR + extM + extA;
  return m;
}

vec2 transmittanceUV(float r, float mu) {
  float H = sqrt(max(0.0, uAtmTop * uAtmTop - uAtmBottom * uAtmBottom));
  float rho = sqrt(max(0.0, r * r - uAtmBottom * uAtmBottom));
  float disc = r * r * (mu * mu - 1.0) + uAtmTop * uAtmTop;
  float d = max(0.0, -r * mu + sqrt(max(0.0, disc)));
  float dMin = uAtmTop - r;
  float dMax = rho + H;
  float xMu = (d - dMin) / max(1e-6, dMax - dMin);
  float xR = rho / H;
  return vec2(fromUnitToSubUvs(xMu, TRANSMITTANCE_SIZE.x), fromUnitToSubUvs(xR, TRANSMITTANCE_SIZE.y));
}

vec3 getTransmittance(float r, float mu) {
  r = clamp(r, uAtmBottom, uAtmTop);
  return texture(uTransmittanceLUT, transmittanceUV(r, mu)).rgb;
}

vec3 getMultiScat(float r, float muS) {
  vec2 uv = vec2(clamp(muS * 0.5 + 0.5, 0.0, 1.0), clamp((r - uAtmBottom) / (uAtmTop - uAtmBottom), 0.0, 1.0));
  uv = vec2(fromUnitToSubUvs(uv.x, MULTISCAT_SIZE.x), fromUnitToSubUvs(uv.y, MULTISCAT_SIZE.y));
  return texture(uMultiScatLUT, uv).rgb * uMultiScatFactor;
}

float rayleighPhase(float c) { return 3.0 / (16.0 * ATM_PI) * (1.0 + c * c); }
float miePhaseCS(float g, float c) {
  float g2 = g * g;
  float k = 3.0 / (8.0 * ATM_PI) * (1.0 - g2) / (2.0 + g2);
  return k * (1.0 + c * c) / pow(max(1e-4, 1.0 + g2 - 2.0 * g * c), 1.5);
}

// soft planet shadow for a point p looking toward the sun
float planetShadow(vec3 p, vec3 sunDir) {
  float b = dot(p, sunDir);
  float c = dot(p, p) - uAtmBottom * uAtmBottom;
  if (b > 0.0) return 1.0;
  float closest2 = dot(p, p) - b * b;
  float rr = uAtmBottom;
  // smooth over ~6 km of grazing height to avoid hard terminator banding
  return smoothstep(rr * rr - 2.0 * rr * 6.0, rr * rr + 2.0 * rr * 2.0, closest2);
}

/** Sun radiance-transfer at point p (km): transmittance × shadow. */
vec3 sunTransmittanceAt(vec3 p, vec3 sunDir) {
  float r = length(p);
  float mu = dot(p / r, sunDir);
  return getTransmittance(r, mu) * planetShadow(p, sunDir);
}

/**
 * Raymarch in-scattered radiance and transmittance between ro + t0*rd and ro + t1*rd.
 * Returns radiance (already multiplied by sun illuminance).
 */
vec3 integrateScattering(vec3 ro, vec3 rd, float t0, float t1, vec3 sunDir, int steps, out vec3 transmittance) {
  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  float len = t1 - t0;
  if (len <= 0.0) { transmittance = T; return L; }
  float cosTheta = dot(rd, sunDir);
  float phR = rayleighPhase(cosTheta);
  float phM = miePhaseCS(uMieG, cosTheta);
  float dt = len / float(steps);
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    float t = t0 + (float(i) + 0.3) * dt;
    vec3 p = ro + rd * t;
    float r = length(p);
    float h = r - uAtmBottom;
    MediumSample m = sampleMedium(h);
    vec3 up = p / r;
    float muS = dot(up, sunDir);
    vec3 sunT = getTransmittance(r, muS) * planetShadow(p, sunDir);
    vec3 ms = getMultiScat(r, muS);
    vec3 S = sunT * (m.scatR * phR + m.scatM * phM) + ms * m.scattering;
    vec3 sampleT = exp(-m.extinction * dt);
    vec3 Sint = (S - S * sampleT) / max(m.extinction, vec3(1e-9));
    L += T * Sint;
    T *= sampleT;
  }
  transmittance = T;
  return L * uSunIlluminance;
}
`;

/** Sky-view LUT parameterisation (Hillaire). */
export const SKYVIEW_COMMON = /* glsl */ `
const vec2 SKYVIEW_SIZE = vec2(192.0, 108.0);

vec2 skyViewUV(float r, float viewZenithCos, float lightViewCos, bool intersectGround) {
  float vHorizon = sqrt(max(0.0, r * r - uAtmBottom * uAtmBottom));
  float cosBeta = vHorizon / r;
  float beta = acos(clamp(cosBeta, -1.0, 1.0));
  float zenithHorizonAngle = ATM_PI - beta;
  vec2 uv;
  if (!intersectGround) {
    float coord = acos(clamp(viewZenithCos, -1.0, 1.0)) / zenithHorizonAngle;
    coord = 1.0 - coord;
    coord = sqrt(max(coord, 0.0));
    coord = 1.0 - coord;
    uv.y = coord * 0.5;
  } else {
    float coord = (acos(clamp(viewZenithCos, -1.0, 1.0)) - zenithHorizonAngle) / beta;
    coord = sqrt(max(coord, 0.0));
    uv.y = coord * 0.5 + 0.5;
  }
  float c = -lightViewCos * 0.5 + 0.5;
  uv.x = sqrt(max(c, 0.0));
  return vec2(fromUnitToSubUvs(uv.x, SKYVIEW_SIZE.x), fromUnitToSubUvs(uv.y, SKYVIEW_SIZE.y));
}
`;
