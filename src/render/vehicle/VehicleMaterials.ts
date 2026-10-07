import { Color, DoubleSide, MeshPhysicalMaterial, Texture, Vector3 } from 'three';
import type { MaterialStyle } from '../../vehicles/types';

/**
 * Vehicle surface materials: three.js physical materials extended with procedural surface
 * detail evaluated in the section's cylindrical coordinates (panel seams, weld lines, foil
 * crinkle, thermal tiles, foam texture) plus dynamic state shared per assembly: engine soot,
 * cryogenic frost, aerodynamic heating glow and livery decals.
 *
 * Geometry must provide:
 *   aCyl   (theta [rad], y [m], r [m])  cylindrical coordinates about the section axis
 *   aMat   (frost weight, soot weight, livery weight, panel scale)
 *   aLiv   (u, v) livery texture coordinates
 */

export interface AssemblyShaderState {
  uSoot: { value: number };
  uFrost: { value: number };
  uHeat: { value: number }; // skin temperature, K
  uHeatDir: { value: Vector3 }; // airflow direction in vehicle frame (glow on windward side)
  uShieldHeat: { value: number }; // heat shield temperature, K
  uChar: { value: number }; // permanent charring 0..1
  uBaseY: { value: number }; // assembly base (soot reference)
  uTopY: { value: number };
  uTime: { value: number };
  uLivery: { value: Texture | null };
  uWear: { value: number }; // flight-proven grime 0..1
}

export function newAssemblyState(baseY: number, topY: number, livery: Texture | null): AssemblyShaderState {
  return {
    uSoot: { value: 0 }, uFrost: { value: 0 }, uHeat: { value: 290 }, uHeatDir: { value: new Vector3(0, -1, 0) }, uShieldHeat: { value: 290 },
    uChar: { value: 0 }, uBaseY: { value: baseY }, uTopY: { value: topY }, uTime: { value: 0 }, uLivery: { value: livery }, uWear: { value: 0 },
  };
}

interface StyleDef {
  color: [number, number, number]; // linear
  metalness: number;
  roughness: number;
  clearcoat?: number;
  pattern: 'paint' | 'carbon' | 'steel' | 'foil' | 'tiles' | 'foam' | 'insulation' | 'cork' | 'soot' | 'plain' | 'roll' | 'nozzle' | 'nozzle_inner' | 'extension';
  panel?: number; // seam strength
}

const srgb = (r: number, g: number, b: number): [number, number, number] => {
  const c = new Color().setRGB(r, g, b, 'srgb');
  return [c.r, c.g, c.b];
};

export const STYLES: Record<MaterialStyle, StyleDef> = {
  white: { color: srgb(0.88, 0.88, 0.87), metalness: 0, roughness: 0.42, clearcoat: 0.25, pattern: 'paint', panel: 1 },
  white_dirty: { color: srgb(0.8, 0.79, 0.76), metalness: 0, roughness: 0.55, clearcoat: 0.1, pattern: 'paint', panel: 1 },
  black_carbon: { color: srgb(0.07, 0.07, 0.075), metalness: 0, roughness: 0.38, clearcoat: 0.5, pattern: 'carbon', panel: 0.6 },
  steel: { color: [0.62, 0.62, 0.64], metalness: 1, roughness: 0.27, pattern: 'steel' },
  orange_foam: { color: srgb(0.78, 0.4, 0.16), metalness: 0, roughness: 0.88, pattern: 'foam' },
  aluminium: { color: [0.82, 0.83, 0.85], metalness: 1, roughness: 0.38, pattern: 'paint', panel: 0.8 },
  grey: { color: srgb(0.55, 0.56, 0.56), metalness: 0, roughness: 0.55, clearcoat: 0.1, pattern: 'paint', panel: 1 },
  gold_foil: { color: [0.95, 0.66, 0.24], metalness: 1, roughness: 0.22, pattern: 'foil' },
  silver_foil: { color: [0.86, 0.86, 0.88], metalness: 1, roughness: 0.2, pattern: 'foil' },
  cork: { color: srgb(0.5, 0.36, 0.24), metalness: 0, roughness: 0.92, pattern: 'cork' },
  soot: { color: srgb(0.11, 0.105, 0.1), metalness: 0.1, roughness: 0.82, pattern: 'soot' },
  insulation_white: { color: srgb(0.86, 0.85, 0.82), metalness: 0, roughness: 0.82, pattern: 'insulation' },
  green_soyuz: { color: srgb(0.33, 0.39, 0.3), metalness: 0, roughness: 0.62, pattern: 'paint', panel: 0.8 },
  black_white_roll: { color: srgb(0.88, 0.88, 0.87), metalness: 0, roughness: 0.45, clearcoat: 0.2, pattern: 'roll', panel: 1 },
  teal: { color: srgb(0.24, 0.52, 0.55), metalness: 0, roughness: 0.48, clearcoat: 0.2, pattern: 'paint', panel: 1 },
  bronze: { color: [0.55, 0.38, 0.22], metalness: 0.7, roughness: 0.42, pattern: 'paint', panel: 0.6 },
  tiles: { color: srgb(0.06, 0.06, 0.065), metalness: 0, roughness: 0.75, pattern: 'tiles' },
};

const NOISE = /* glsl */ `
float vh_hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vh_hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vh_noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(vh_hash12(i), vh_hash12(i + vec2(1, 0)), u.x), mix(vh_hash12(i + vec2(0, 1)), vh_hash12(i + vec2(1, 1)), u.x), u.y);
}
float vh_fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vh_noise(p); p *= 2.03; a *= 0.5; } return s; }
// anti-aliased line: distance d (in metres) to a seam of half-width w, fading when sub-pixel
float vh_line(float d, float w, float fw) {
  float aa = max(fw, 1e-5);
  float l = 1.0 - smoothstep(w - aa, w + aa, abs(d));
  return l * clamp(w * 6.0 / aa, 0.0, 1.0);
}
vec3 vh_blackbody(float T) {
  // approximate blackbody chromaticity (Planckian locus fit) and radiance growth
  float t = clamp((T - 700.0) / 2300.0, 0.0, 1.0);
  vec3 c = mix(vec3(1.0, 0.12, 0.0), vec3(1.0, 0.55, 0.18), smoothstep(0.0, 0.45, t));
  c = mix(c, vec3(1.0, 0.86, 0.68), smoothstep(0.45, 1.0, t));
  float I = pow(max(T - 750.0, 0.0) / 1000.0, 4.0) * 30.0;
  return c * I;
}
vec3 vh_perturbNormal(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
  vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
  vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
  vec3 vN = surf_norm;
  vec3 R1 = cross(vSigmaY, vN);
  vec3 R2 = cross(vN, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDirection;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

/** Surface pattern code; outputs: h (bump height, m), alb (albedo multiplier), rgh (roughness offset). */
function patternGLSL(p: StyleDef['pattern']): string {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (p) {
    case 'paint':
    case 'roll':
      return /* glsl */ `
        // panel seams: rings every ~2.4 m, longitudinal seams every ~1.9 m of arc
        float ringD = mod(cy.y + 0.37, 2.4) - 1.2;
        float seamD = mod(arcS + 0.4, 1.9) - 0.95;
        float fwY = fwidth(cy.y), fwS = fwidth(arcS);
        float seams = max(vh_line(ringD, 0.006, fwY), vh_line(seamD, 0.005, fwS) * step(0.2, abs(ringD)));
        h -= seams * 0.0025 * panelScale;
        // rivet rows beside ring seams
        float rivet = vh_line(mod(arcS, 0.11) - 0.055, 0.008, fwS) * vh_line(abs(ringD) - 0.035, 0.008, fwY);
        h += rivet * 0.0012 * panelScale;
        float blot = vh_fbm(vec2(arcS, cy.y) * 0.6);
        alb *= 0.97 + 0.06 * blot - seams * 0.15 * panelScale;
        rgh += (blot - 0.5) * 0.08;
        ${p === 'roll' ? `
        // black/white roll-pattern quadrants
        float q = floor(mod(cy.x / 1.5707963, 4.0));
        float band = step(0.5, fract(cy.y / 9.0));
        float isBlack = mod(q + band, 2.0);
        alb = mix(alb, alb * 0.06, isBlack);` : ''}
      `;
    case 'carbon':
      return /* glsl */ `
        float fwS = fwidth(arcS), fwY = fwidth(cy.y);
        float weave = (sin(arcS * 420.0) * sin(cy.y * 420.0)) * clamp(0.004 / max(fwS, 1e-5), 0.0, 1.0);
        h += weave * 0.00008;
        float ringD = mod(cy.y + 0.2, 3.1) - 1.55;
        float seams = vh_line(ringD, 0.008, fwY);
        h -= seams * 0.002;
        float blot = vh_fbm(vec2(arcS, cy.y) * 1.3);
        alb *= 0.9 + 0.2 * blot;
        rgh += (blot - 0.5) * 0.12 + seams * 0.1;
      `;
    case 'steel':
      return /* glsl */ `
        float fwS = fwidth(arcS), fwY = fwidth(cy.y);
        // welded rings every 1.83 m, vertical welds staggered per ring
        float ringIdx = floor(cy.y / 1.83);
        float ringD = cy.y - (ringIdx + 0.5) * 1.83;
        float weldR = vh_line(abs(ringD) - 0.915, 0.012, fwY);
        float off = vh_hash12(vec2(ringIdx, 3.0)) * 6.2831;
        float seamD = mod(arcS + off * cy.z, 9.0) - 4.5;
        float weldV = vh_line(seamD, 0.01, fwS);
        h += (weldR + weldV) * 0.0015;
        // brushed streaks + heat tint + mottled oxidation
        float streak = vh_noise(vec2(arcS * 1.8, cy.y * 46.0));
        float mott = vh_fbm(vec2(arcS, cy.y) * 0.45);
        alb *= 0.86 + 0.18 * mott + 0.06 * streak - (weldR + weldV) * 0.25;
        rgh += (streak - 0.5) * 0.1 + (mott - 0.5) * 0.12 + (weldR + weldV) * 0.2;
        tint = mix(vec3(1.0), vec3(1.03, 0.98, 0.9), smoothstep(0.55, 0.8, mott));
      `;
    case 'foil':
      return /* glsl */ `
        // MLI blanket: crinkled facets + taped seams
        vec2 q = vec2(arcS, cy.y);
        float c1 = vh_noise(q * 9.0), c2 = vh_noise(q * 23.0 + 3.1), c3 = vh_noise(q * 61.0 + 7.7);
        float fw = fwidth(q.x) + fwidth(q.y);
        float hf = c1 * 0.6 + c2 * 0.3 * clamp(0.02 / max(fw, 1e-5), 0.0, 1.0) + c3 * 0.1 * clamp(0.008 / max(fw, 1e-5), 0.0, 1.0);
        h += hf * 0.004;
        float tape = max(vh_line(mod(q.y, 0.9) - 0.45, 0.02, fwidth(q.y)), vh_line(mod(q.x, 1.1) - 0.55, 0.02, fwidth(q.x)));
        alb *= 0.8 + 0.35 * c1 - tape * 0.25;
        rgh += (c2 - 0.5) * 0.25 + tape * 0.35;
      `;
    case 'tiles':
      return /* glsl */ `
        // hexagonal thermal protection tiles (~0.32 m across) with dark gaps
        vec2 q = vec2(arcS, cy.y) / 0.32;
        vec2 r = vec2(1.0, 1.7320508);
        vec2 hq = r * 0.5;
        vec2 a = mod(q, r) - hq;
        vec2 b = mod(q - hq, r) - hq;
        vec2 g = dot(a, a) < dot(b, b) ? a : b;
        vec2 id = q - g;
        vec2 ag = abs(g);
        float edge = 0.5 - max(dot(ag, normalize(vec2(1.0, 1.7320508))), ag.x);
        float fw = fwidth(q.x) + fwidth(q.y);
        float gap = 1.0 - smoothstep(0.02, 0.02 + fw, edge);
        h -= gap * 0.004;
        float var = vh_hash12(floor(id * 3.0 + 0.5));
        alb *= mix(0.85 + 0.3 * var, 0.4, gap);
        rgh += (var - 0.5) * 0.15;
      `;
    case 'foam':
      return /* glsl */ `
        vec2 q = vec2(arcS, cy.y);
        float b1 = vh_fbm(q * 3.0), b2 = vh_noise(q * 18.0);
        float fw = fwidth(q.x) + fwidth(q.y);
        h += (b1 * 0.006 + b2 * 0.002 * clamp(0.03 / max(fw, 1e-5), 0.0, 1.0));
        float streak = vh_noise(vec2(arcS * 6.0, cy.y * 0.25));
        alb *= 0.82 + 0.25 * b1 - 0.1 * smoothstep(0.6, 0.9, streak);
        rgh += (b2 - 0.5) * 0.1;
      `;
    case 'insulation':
      return /* glsl */ `
        vec2 q = vec2(arcS, cy.y);
        vec2 cell = abs(fract(q / vec2(0.45, 0.6)) - 0.5);
        float quilt = smoothstep(0.5, 0.3, max(cell.x, cell.y));
        h += quilt * 0.006;
        float b = vh_fbm(q * 4.0);
        alb *= 0.9 + 0.15 * b - (1.0 - quilt) * 0.06;
        rgh += (b - 0.5) * 0.1;
      `;
    case 'cork':
      return /* glsl */ `
        vec2 q = vec2(arcS, cy.y);
        float b = vh_noise(q * 40.0), b2 = vh_fbm(q * 5.0);
        h += b * 0.0015;
        alb *= 0.75 + 0.45 * b * b2;
      `;
    case 'soot':
      return /* glsl */ `
        vec2 q = vec2(arcS, cy.y);
        float b = vh_fbm(q * 1.5), s2 = vh_noise(vec2(arcS * 8.0, cy.y * 0.7));
        alb *= 0.6 + 0.8 * b * (0.7 + 0.3 * s2);
        rgh += (b - 0.5) * 0.15;
        h += vh_noise(q * 12.0) * 0.002;
      `;
    case 'nozzle':
      return /* glsl */ `
        // regeneratively cooled tube wall: hundreds of axial tubes + hoop bands
        float tubes = cy.x * 180.0;
        float tw = fract(tubes) - 0.5;
        float fwT = fwidth(tubes);
        h += (0.25 - tw * tw) * 0.004 * clamp(0.3 / max(fwT, 1e-4), 0.0, 1.0);
        float hoop = vh_line(mod(cy.y, 0.35) - 0.175, 0.012, fwidth(cy.y));
        h += hoop * 0.003;
        float b = vh_fbm(vec2(cy.x * 3.0, cy.y * 2.0));
        alb *= 0.8 + 0.35 * b;
        rgh += (b - 0.5) * 0.2;
      `;
    case 'nozzle_inner':
      return /* glsl */ `
        float b = vh_fbm(vec2(cy.x * 4.0, cy.y * 3.0));
        alb *= 0.5 + 0.6 * b;
      `;
    case 'extension':
      return /* glsl */ `
        float b = vh_fbm(vec2(cy.x * 2.0, cy.y * 4.0));
        float hoop = vh_line(mod(cy.y, 0.5) - 0.25, 0.01, fwidth(cy.y));
        h += hoop * 0.002;
        alb *= 0.85 + 0.25 * b;
      `;
    default:
      return '';
  }
}

const NOZZLE_STYLES: Record<string, StyleDef> = {
  nozzle: { color: [0.3, 0.28, 0.26], metalness: 0.85, roughness: 0.48, pattern: 'nozzle' as StyleDef['pattern'] },
  nozzle_inner: { color: [0.05, 0.045, 0.04], metalness: 0.3, roughness: 0.75, pattern: 'nozzle_inner' as StyleDef['pattern'] },
  extension: { color: [0.06, 0.06, 0.065], metalness: 0.6, roughness: 0.55, pattern: 'extension' as StyleDef['pattern'] },
};

export interface SkinOptions {
  style: MaterialStyle | 'nozzle' | 'nozzle_inner' | 'extension';
  state: AssemblyShaderState;
  /** livery decal texture for this mesh (overrides the assembly default) */
  livery?: Texture | null;
  /** per-mesh heat override (engines): separate uniform object */
  heat?: { value: number };
  /** override base colour (linear) e.g. livery primary */
  color?: [number, number, number];
  doubleSided?: boolean;
  emissive?: [number, number, number];
}

const _cacheKeys = new Map<string, number>();

/** Create a skin material bound to an assembly's dynamic state. */
export function createSkin(o: SkinOptions): MeshPhysicalMaterial {
  const st = (o.style in STYLES ? STYLES[o.style as MaterialStyle] : NOZZLE_STYLES[o.style]) ?? STYLES.white;
  const col = o.color ?? st.color;
  const m = new MeshPhysicalMaterial({
    color: new Color(col[0], col[1], col[2]),
    metalness: st.metalness,
    roughness: st.roughness,
    clearcoat: st.clearcoat ?? 0,
    clearcoatRoughness: 0.35,
    envMapIntensity: 1,
  });
  if (o.doubleSided) m.side = DoubleSide;
  if (o.emissive) m.emissive = new Color(o.emissive[0], o.emissive[1], o.emissive[2]);
  const pattern = st.pattern;
  const key = `vskin-${pattern}`;
  _cacheKeys.set(key, (_cacheKeys.get(key) ?? 0) + 1);
  m.customProgramCacheKey = () => key;
  const state = o.state;
  const livery = { value: o.livery !== undefined ? o.livery : state.uLivery.value };
  const heat = o.heat ?? state.uHeat;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, state);
    shader.uniforms.uLivery = livery;
    shader.uniforms.uHeat = heat;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aCyl;
        attribute vec4 aMat;
        attribute vec2 aLiv;
        varying vec3 vCyl;
        varying vec4 vMat;
        varying vec2 vLiv;
        varying vec3 vLocalPos;
        varying vec3 vLocalNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCyl = aCyl; vMat = aMat; vLiv = aLiv; vLocalPos = position; vLocalNormal = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vCyl;
        varying vec4 vMat;
        varying vec2 vLiv;
        varying vec3 vLocalPos;
        varying vec3 vLocalNormal;
        uniform float uSoot;
        uniform float uFrost;
        uniform float uHeat;
        uniform vec3 uHeatDir;
        uniform float uShieldHeat;
        uniform float uChar;
        uniform float uBaseY;
        uniform float uTopY;
        uniform float uTime;
        uniform float uWear;
        uniform sampler2D uLivery;
        ${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 cy = vCyl;
        float arcS = cy.x * max(cy.z, 0.05);
        float panelScale = vMat.w;
        float h = 0.0;
        float alb = 1.0;
        float rgh = 0.0;
        vec3 tint = vec3(1.0);
        ${patternGLSL(pattern)}
        // livery decals (text, stripes, flags)
        vec4 liv = vMat.z > 0.0 ? texture2D(uLivery, vLiv) : vec4(0.0);
        diffuseColor.rgb = mix(diffuseColor.rgb * alb * tint, liv.rgb, liv.a * vMat.z);
        float livA = liv.a * vMat.z;
        // grime from flight wear: streaks running down from vents and seams
        float wearN = vh_fbm(vec2(arcS * 2.5, cy.y * 0.18));
        diffuseColor.rgb *= 1.0 - uWear * 0.35 * smoothstep(0.45, 0.85, wearN);
        // engine soot: heavy at the base, streaky upward
        float yRel = clamp((cy.y - uBaseY) / max(uTopY - uBaseY, 1.0), 0.0, 1.0);
        float sootN = vh_fbm(vec2(arcS * 1.4, cy.y * 0.12) + 4.0);
        float sootAmt = uSoot * vMat.y * smoothstep(0.75, 0.0, yRel + (sootN - 0.5) * 0.45);
        sootAmt = max(sootAmt, uChar * smoothstep(0.3, 0.8, sootN));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.022, 0.02), clamp(sootAmt, 0.0, 0.96));
        // cryogenic frost: white rime patches over cold tank walls
        float frostN = vh_fbm(vec2(arcS, cy.y) * 2.2 + 9.0);
        float frostAmt = uFrost * vMat.x * smoothstep(0.42, 0.62, frostN + 0.12 * uFrost * vMat.x);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.9), frostAmt);
        h += frostAmt * vh_noise(vec2(arcS, cy.y) * 30.0) * 0.004;
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + rgh + sootAmt * 0.5 + frostAmt * 0.6 - livA * 0.05, 0.04, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor *= (1.0 - sootAmt) * (1.0 - frostAmt) * (1.0 - livA);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 dH = vec2(dFdx(h), dFdy(h));
          normal = vh_perturbNormal(-vViewPosition, normal, dH, faceDirection);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // aerodynamic heating glow on the windward side (vehicle frame)
          float wind = clamp(dot(normalize(vLocalNormal), -normalize(uHeatDir)), 0.0, 1.0);
          float T = mix(290.0, uHeat, 0.35 + 0.65 * wind);
          totalEmissiveRadiance += vh_blackbody(T) * (1.0 - frostAmt);
        }`);
  };
  return m;
}

/** Simple non-procedural material for small hardware (struts, legs, nozzles internals). */
export function createHardware(color: [number, number, number], metalness: number, roughness: number, doubleSided = false): MeshPhysicalMaterial {
  const m = new MeshPhysicalMaterial({ color: new Color(color[0], color[1], color[2]), metalness, roughness });
  if (doubleSided) m.side = DoubleSide;
  return m;
}
