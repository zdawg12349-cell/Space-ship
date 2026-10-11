import { Color, DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial, Vector4 } from 'three';

/**
 * Materials for ground infrastructure. Concrete and asphalt get procedural staining in object
 * space (water streaks, scorch around the flame hole, expansion joints); vegetation uses a
 * cheap wrap-lit two-sided leaf material.
 */

const NOISE = /* glsl */ `
float s_hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float s_noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(s_hash12(i), s_hash12(i + vec2(1, 0)), u.x), mix(s_hash12(i + vec2(0, 1)), s_hash12(i + vec2(1, 1)), u.x), u.y); }
float s_fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * s_noise(p); p *= 2.07; a *= 0.5; } return s; }
`;

export interface SiteMaterials {
  concrete: MeshStandardMaterial;
  concreteDark: MeshStandardMaterial;
  asphalt: MeshStandardMaterial;
  steelGrey: MeshStandardMaterial;
  steelWhite: MeshStandardMaterial;
  steelRed: MeshStandardMaterial;
  steelDark: MeshStandardMaterial;
  galvanized: MeshStandardMaterial;
  tankWhite: MeshPhysicalMaterial;
  glass: MeshPhysicalMaterial;
  grating: MeshStandardMaterial;
  cable: MeshStandardMaterial;
  lampOn: MeshStandardMaterial;
  /** small warm work lights (tower, roads, buildings) */
  lampWarm: MeshStandardMaterial;
  beaconRed: MeshStandardMaterial;
  leaf: MeshStandardMaterial;
  palmLeaf: MeshStandardMaterial;
  pineLeaf: MeshStandardMaterial;
  canopy: MeshStandardMaterial;
  grass: MeshStandardMaterial;
  dryGrass: MeshStandardMaterial;
  dryShrub: MeshStandardMaterial;
  berm: MeshStandardMaterial;
  gravel: MeshStandardMaterial;
  vabWall: MeshStandardMaterial;
  vabDark: MeshStandardMaterial;
  /** profiled metal wall cladding (hangars, sheds): white and light grey */
  cladding: MeshStandardMaterial;
  claddingGrey: MeshStandardMaterial;
  trenchFloor: MeshStandardMaterial;
  /** trunks of palms, pines and broadleaf trees: each bends as stiffly as its crown */
  trunk: MeshStandardMaterial;
  trunkPine: MeshStandardMaterial;
  trunkBroad: MeshStandardMaterial;
  sand: MeshStandardMaterial;
  water: MeshPhysicalMaterial;
  rubber: MeshStandardMaterial;
  vehiclePaint: MeshPhysicalMaterial;
  /** 2 tan(fov/2) / viewport height: world size of one pixel per metre of distance */
  pixelAngle: { value: number };
  /** shared scorch control (0 = clean, 1 = after launch) */
  scorch: { value: number };
  /** wetness from the deluge (darkens concrete, adds sheen) */
  wet: { value: number };
  /** surface wind for the plants: direction it blows toward in the site frame (x, z), speed (m/s), gustiness */
  wind: { value: Vector4 };
  /** clock for the plants' sway (s) */
  windTime: { value: number };
}

/**
 * Plants bend in the wind: a steady lean that grows with the square of the wind speed and of
 * height above the plant's foot, gusts with a per-plant phase, a little sideways rocking and a
 * fast flutter in the leaves. Applied after instancing, in the site frame, so every plant leans
 * the same way whatever its rotation; trunks use the same bend so crowns stay on them.
 */
function swayVertex(sh: { uniforms: Record<string, { value: unknown }>; vertexShader: string }, wind: { value: Vector4 }, time: { value: number }, stiffness: number, flutter: number): void {
  sh.uniforms.uWind = wind;
  sh.uniforms.uWindT = time;
  sh.uniforms.uWindK = { value: stiffness };
  sh.uniforms.uWindFlutter = { value: flutter };
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
      uniform vec4 uWind;
      uniform float uWindT;
      uniform float uWindK;
      uniform float uWindFlutter;`)
    .replace('#include <project_vertex>', `
      vec4 mvPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
      mvPosition = instanceMatrix * mvPosition;
      {
        float hh = max(0.0, mvPosition.y - instanceMatrix[3].y);
        float ph = dot(instanceMatrix[3].xz, vec2(0.037, 0.053));
        float A = 0.00088 * uWindK * uWind.z * uWind.z * hh * hh / (hh + 6.0);
        float gust = 0.5 + 0.5 * sin(uWindT * 1.1 + ph) * (0.55 + 0.45 * sin(uWindT * 0.29 + ph * 1.7));
        vec2 dir = uWind.xy, perp = vec2(-uWind.y, uWind.x);
        mvPosition.xz += dir * A * (0.55 + 0.45 * gust * (0.6 + uWind.w)) + perp * A * 0.12 * sin(uWindT * 2.3 + ph * 3.1);
        mvPosition.xyz += uWindFlutter * A * 0.09 * vec3(sin(uWindT * 7.1 + mvPosition.x * 1.3 + ph), sin(uWindT * 6.3 + mvPosition.z * 1.7), cos(uWindT * 7.9 + mvPosition.x * 0.9));
        // the tip comes down a little as the stem bends over
        mvPosition.y -= A * A / max(hh, 1.0) * 0.5;
      }
      #endif
      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;`);
}

function stained(base: [number, number, number], rough: number, opts: { scorch?: { value: number }; wet?: { value: number }; scale?: number; joints?: boolean; key: string }): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: new Color(base[0], base[1], base[2]), roughness: rough, metalness: 0 });
  const scorch = opts.scorch ?? { value: 0 };
  const wet = opts.wet ?? { value: 0 };
  m.customProgramCacheKey = () => `site-${opts.key}`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uScorch = scorch;
    sh.uniforms.uWet = wet;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSitePos;\nvarying vec3 vSiteN;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvSiteN = objectNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSitePos = (modelMatrix * vec4(position, 1.0)).xyz - (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;\nvSitePos = vec3(dot(vSitePos, normalize(modelMatrix[0].xyz)), dot(vSitePos, normalize(modelMatrix[1].xyz)), dot(vSitePos, normalize(modelMatrix[2].xyz)));');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vSitePos;\nvarying vec3 vSiteN;\nuniform float uScorch;\nuniform float uWet;\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 sp = vSitePos.xz * ${(opts.scale ?? 1).toFixed(3)};
        float n1 = s_fbm(sp * 0.35), n2 = s_noise(sp * 3.1), n3 = s_noise(vec2(sp.x * 0.2, vSitePos.y * 1.7));
        float stain = smoothstep(0.45, 0.85, n1) * 0.25 + (n2 - 0.5) * 0.06;
        // vertical rain streaks on walls
        float streak = smoothstep(0.55, 0.95, s_noise(vec2(vSitePos.x * 3.0 + vSitePos.z * 3.0, vSitePos.y * 0.15))) * 0.18;
        diffuseColor.rgb *= 1.0 - stain - streak * step(0.3, abs(vSiteN.y - 1.0));
        ${opts.joints ? `
        vec2 jg = abs(fract(vSitePos.xz / 6.0) - 0.5);
        float joint = 1.0 - smoothstep(0.0, 0.004 * 6.0, 0.5 - max(jg.x, jg.y));
        diffuseColor.rgb *= 1.0 - joint * 0.35;` : ''}
        // scorch: soot around the flame hole / deflector exits
        float r = length(vSitePos.xz);
        float sc = uScorch * smoothstep(55.0, 6.0, r + (n1 - 0.5) * 30.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.018, 0.016), clamp(sc, 0.0, 0.92));
        diffuseColor.rgb *= 1.0 - uWet * 0.35;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor - uWet * 0.55 + stain * 0.2, 0.05, 1.0);`);
  };
  return m;
}

/**
 * Profiled steel cladding: box ribs every metre across each wall (normals tilted on their flanks,
 * a little occlusion in the pans), panel end-laps every few metres up, rain streaks under the
 * eaves. The ribs fade out once they are smaller than a couple of pixels, so they never shimmer.
 */
function cladding(base: [number, number, number], rough: number, key: string): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: new Color(base[0], base[1], base[2]), roughness: rough, metalness: 0.15 });
  m.customProgramCacheKey = () => `site-${key}`;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSitePos;\nvarying vec3 vSiteN;\nvarying vec3 vRibT;')
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        vSiteN = objectNormal;
        {
          // across the ribs: horizontal along a wall
          vec3 t = cross(vec3(0.0, 1.0, 0.0), objectNormal);
          vRibT = normalize((modelViewMatrix * vec4(length(t) > 1e-3 ? normalize(t) : vec3(1.0, 0.0, 0.0), 0.0)).xyz);
        }`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSitePos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vSitePos;\nvarying vec3 vSiteN;\nvarying vec3 vRibT;\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float wall = 1.0 - smoothstep(0.4, 0.7, abs(vSiteN.y));
        vec3 ts = cross(vec3(0.0, 1.0, 0.0), vSiteN);
        float u = dot(vSitePos, length(ts) > 1e-3 ? normalize(ts) : vec3(1.0, 0.0, 0.0));
        float ph = fract(u);
        // box ribs 35 mm proud on a 1 m pitch. The flanks are band-limited: never narrower than
        // about a pixel and a half, their slope falling as they widen so the rib keeps its height;
        // past a third of a metre per pixel the ribs fade out altogether
        float fw = max(fwidth(u), 1e-4);
        float ribVis = wall * (1.0 - smoothstep(0.15, 0.35, fw));
        float w = max(0.05, fw * 1.5);
        float t1 = clamp(ph / w, 0.0, 1.0), t2 = clamp((ph - 0.25) / w, 0.0, 1.0);
        float ribSlope = 0.035 * 6.0 * (t1 * (1.0 - t1) - t2 * (1.0 - t2)) / w;
        // a little shadow in the pan beside each rib, as wide as the flank allows
        float occl = smoothstep(0.25, 0.25 + w, ph) * (1.0 - smoothstep(0.25 + w, 0.4 + w, ph));
        diffuseColor.rgb *= 1.0 - ribVis * occl * 0.15;
        // end-laps of the sheets: a fine line round the building every 6.1 m up
        float lap = abs(fract(vSitePos.y / 6.1) - 0.5);
        diffuseColor.rgb *= 1.0 - wall * (1.0 - smoothstep(0.0, 0.003 + fwidth(vSitePos.y) / 6.1, 0.5 - lap)) * 0.22;
        // weathering: faint mottling, rain streaks running down from the eaves
        float n1 = s_fbm(vec2(u, vSitePos.y) * 0.15);
        float streak = smoothstep(0.55, 0.95, s_noise(vec2(u * 1.7, vSitePos.y * 0.08))) * wall;
        diffuseColor.rgb *= 1.0 - (n1 - 0.5) * 0.08 - streak * 0.1;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // a rising flank faces back across the ribs
        normal = normalize(normal - vRibT * ribSlope * ribVis);`);
  };
  return m;
}

export function createSiteMaterials(): SiteMaterials {
  const scorch = { value: 0 };
  const wet = { value: 0 };
  const wind = { value: new Vector4(0.94, 0.34, 4, 0.15) };
  const windTime = { value: 0 };
  const lin = (r: number, g: number, b: number): [number, number, number] => {
    const c = new Color().setRGB(r, g, b, 'srgb');
    return [c.r, c.g, c.b];
  };
  const std = (c: [number, number, number], rough: number, metal: number) => new MeshStandardMaterial({ color: new Color(...c), roughness: rough, metalness: metal });
  // foliage albedos (linear): saw palmetto ~0.05-0.08, sabal palm fronds a little brighter
  const foliage = (c: [number, number, number], rough = 0.78) => new MeshStandardMaterial({ color: new Color(c[0], c[1], c[2]), roughness: rough, metalness: 0, side: DoubleSide });
  const leaf = foliage([0.07, 0.09, 0.045]);
  const palmLeaf = foliage([0.09, 0.115, 0.05], 0.7);
  const pineLeaf = foliage([0.07, 0.092, 0.052], 0.85);
  const canopy = foliage([0.082, 0.11, 0.055], 0.82);
  const grass = foliage([0.085, 0.1, 0.05], 0.85);
  const dryGrass = foliage([0.2, 0.17, 0.09], 0.9);
  const dryShrub = foliage([0.12, 0.11, 0.07], 0.9);
  // named so tools can find each kind of plant in the scene
  Object.entries({ leaf, palmLeaf, pineLeaf, canopy, grass, dryGrass, dryShrub }).forEach(([k, m]) => { m.name = k; });
  // foliage: wrap lighting, per-plant tint variation; tree crowns also shade as one soft volume
  // (crown-envelope normals + baked occlusion) and glow when back-lit by the sun
  // how readily each kind of plant gives to the wind (palms most, pines least)
  const K_PALM = 1, K_PINE = 0.4, K_BROAD = 0.55;
  const stiff = new Map<MeshStandardMaterial, number>([[leaf, 0.6], [palmLeaf, K_PALM], [pineLeaf, K_PINE], [canopy, K_BROAD], [grass, 1.6], [dryGrass, 1.6], [dryShrub, 0.6]]);
  const trunkMat = (k: number, key: string) => {
    const t = std(lin(0.38, 0.32, 0.25), 0.9, 0);
    t.customProgramCacheKey = () => key;
    t.onBeforeCompile = (sh) => swayVertex(sh, wind, windTime, k, 0);
    return t;
  };
  for (const m of [leaf, palmLeaf, pineLeaf, canopy, grass, dryGrass, dryShrub]) {
    const crown = m === pineLeaf || m === canopy;
    if (crown) m.defines = { ...(m.defines ?? {}), CROWN: '' };
    m.customProgramCacheKey = () => (crown ? 'site-leaf-crown' : 'site-leaf');
    m.onBeforeCompile = (sh) => {
      swayVertex(sh, wind, windTime, stiff.get(m) ?? 0.6, 1);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          varying float vTint;
          #ifdef CROWN
          attribute vec4 aCrown;
          varying float vCrownAO;
          varying vec3 vLeafP;
          varying vec3 vBlobN;
          #endif`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          #ifdef USE_INSTANCING
          vTint = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
          #else
          vTint = 0.5;
          #endif
          #ifdef CROWN
          objectNormal = normalize(mix(objectNormal, aCrown.xyz, 0.62));
          vCrownAO = aCrown.w;
          // tree-local position (shifted per tree so no two crowns share a pattern) and the
          // clump's own surface normal, for its silhouette
          vLeafP = position + vec3(vTint * 37.0, 0.0, vTint * 53.0);
          #ifdef USE_INSTANCING
          vBlobN = normalize(normalMatrix * (mat3(instanceMatrix) * normal));
          #else
          vBlobN = normalize(normalMatrix * normal);
          #endif
          #endif`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vTint;
          #ifdef CROWN
          varying float vCrownAO;
          varying vec3 vLeafP;
          varying vec3 vBlobN;
          float leafHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
          float leafNoise(vec3 x) {
            vec3 i = floor(x), f = fract(x);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(leafHash(i), leafHash(i + vec3(1, 0, 0)), f.x), mix(leafHash(i + vec3(0, 1, 0)), leafHash(i + vec3(1, 1, 0)), f.x), f.y),
                       mix(mix(leafHash(i + vec3(0, 0, 1)), leafHash(i + vec3(1, 0, 1)), f.x), mix(leafHash(i + vec3(0, 1, 1)), leafHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
          }
          #endif`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          #ifdef CROWN
          {
            // a crown is a mass of needle tufts, not a smooth skin. Close up: the gaps between
            // tufts open at each clump's edge (ragged, see-through outlines), the surface breaks
            // into tufts that catch the light at their own angles, and the gaps are dark. All of
            // it fades out by ~30 cm per pixel, before it could shimmer.
            float near = 1.0 - smoothstep(0.06, 0.3, length(fwidth(vLeafP)));
            if (near > 0.0) {
              float n = leafNoise(vLeafP * 1.9) * 0.6 + leafNoise(vLeafP * 6.3 + 11.0) * 0.4;
              float facing = abs(dot(normalize(vBlobN), normalize(vViewPosition)));
              if (n < (0.62 - facing * 0.9) * near) discard;
              leafThin = mix(0.5, clamp((0.75 - n) * 2.0 + (1.0 - facing) * 0.5, 0.0, 1.0), near);
              vec3 jit = vec3(leafNoise(vLeafP * 4.1 + 3.0), leafNoise(vLeafP * 4.1 + 7.0), leafNoise(vLeafP * 4.1 + 13.0)) - 0.5;
              normal = normalize(normal + jit * 1.1 * near);
              diffuseColor.rgb *= mix(1.0, 0.62 + 0.6 * n, near);
            }
          }
          #endif`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.rgb *= mix(vec3(0.82, 0.88, 0.8), vec3(1.18, 1.1, 0.92), vTint);
          #ifdef CROWN
          diffuseColor.rgb *= vCrownAO;
          // how thin the foliage is here (0 dense .. 1 open tufts), set by the tuft noise below
          float leafThin = 0.5;
          #endif`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          reflectedLight.directDiffuse *= 1.25;
          reflectedLight.indirectDiffuse *= 1.15;
          // leaves have only a faint waxy sheen: against the sun a full specular lobe on tufted
          // normals would frost the tops of the crowns white
          reflectedLight.directSpecular *= 0.25;
          reflectedLight.indirectSpecular *= 0.5;
          #if defined(CROWN) && NUM_DIR_LIGHTS > 0
          {
            // light scattered through the leaves toward the viewer when the sun is behind the crown
            vec3 Ls = directionalLights[0].direction;
            float back = pow(clamp(dot(-geometryViewDir, Ls), 0.0, 1.0), 3.0);
            float thin = clamp(0.5 - 0.5 * dot(geometryNormal, Ls), 0.0, 1.0);
            // leaves pass on nearly as much light as they reflect: the outer needles of the
            // shaded side glow a little whatever the view, and strongly against the sun
            // (the open tufts at the clumps' edges most of all; the dense core stays dark)
            reflectedLight.directDiffuse += directionalLights[0].color * diffuseColor.rgb * thin * (0.05 + back * 0.32) * (0.3 + 1.4 * leafThin) * vec3(0.9, 1.0, 0.55);
          }
          #endif`);
    };
  }
  // wires: inflate to at least ~0.8 px and fade coverage instead, so thin catenaries don't break
  // up into dashes at distance (alpha-to-coverage under MSAA)
  const pixelAngle = { value: 0.001 };
  const cable = new MeshStandardMaterial({ color: new Color(0.06, 0.06, 0.06), roughness: 0.6, metalness: 0.3, alphaToCoverage: true });
  cable.customProgramCacheKey = () => 'site-cable';
  cable.onBeforeCompile = (sh) => {
    sh.uniforms.uPixelAngle = pixelAngle;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aCyl;\nuniform float uPixelAngle;\nvarying float vCov;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float r0 = max(aCyl.z, 1e-4);
          float dist = max(0.1, -(modelViewMatrix * vec4(transformed, 1.0)).z);
          float r1 = max(r0, uPixelAngle * dist * 0.4);
          transformed += objectNormal * (r1 - r0);
          vCov = r0 / r1;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCov;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.a *= clamp(vCov * 1.3, 0.12, 1.0);');
  };
  const lampWarm = new MeshStandardMaterial({ color: new Color(0.05, 0.05, 0.05), emissive: new Color(1, 0.72, 0.42), emissiveIntensity: 0, roughness: 0.4 });
  const lampOn = new MeshStandardMaterial({ color: new Color(0, 0, 0), emissive: new Color(1, 0.86, 0.62), emissiveIntensity: 0, roughness: 0.3 });
  const beaconRed = new MeshStandardMaterial({ color: new Color(0.1, 0, 0), emissive: new Color(1, 0.05, 0.02), emissiveIntensity: 0, roughness: 0.4 });
  return {
    concrete: stained(lin(0.62, 0.61, 0.58), 0.88, { scorch, wet, joints: true, key: 'concrete' }),
    concreteDark: stained(lin(0.42, 0.41, 0.39), 0.9, { scorch, wet, key: 'concrete-dark' }),
    asphalt: stained(lin(0.13, 0.13, 0.135), 0.82, { wet, scale: 2, key: 'asphalt' }),
    steelGrey: std(lin(0.5, 0.52, 0.53), 0.55, 0.3),
    steelWhite: std(lin(0.82, 0.82, 0.8), 0.5, 0.1),
    steelRed: std(lin(0.55, 0.12, 0.08), 0.55, 0.1),
    steelDark: std(lin(0.16, 0.16, 0.17), 0.6, 0.4),
    galvanized: std([0.42, 0.43, 0.44], 0.58, 0.6),
    tankWhite: new MeshPhysicalMaterial({ color: new Color(...lin(0.9, 0.9, 0.88)), roughness: 0.35, metalness: 0, clearcoat: 0.4 }),
    glass: new MeshPhysicalMaterial({ color: new Color(0.02, 0.03, 0.035), roughness: 0.05, metalness: 0.2, clearcoat: 1, emissive: new Color(1, 0.78, 0.5), emissiveIntensity: 0 }),
    grating: std([0.4, 0.4, 0.41], 0.6, 0.7),
    cable,
    pixelAngle,
    lampOn,
    lampWarm,
    beaconRed,
    leaf,
    palmLeaf,
    pineLeaf,
    canopy,
    grass,
    dryGrass,
    dryShrub,
    gravel: stained(lin(0.5, 0.48, 0.44), 0.95, { key: 'gravel', scale: 3 }),
    vabWall: stained(lin(0.66, 0.66, 0.64), 0.75, { key: 'vab', scale: 0.25 }),
    vabDark: std(lin(0.25, 0.26, 0.27), 0.7, 0.2),
    cladding: cladding(lin(0.84, 0.85, 0.84), 0.55, 'cladding'),
    claddingGrey: cladding(lin(0.56, 0.58, 0.59), 0.6, 'cladding-grey'),
    berm: stained(lin(0.3, 0.32, 0.2), 0.95, { key: 'berm', scale: 0.7 }),
    trenchFloor: stained(lin(0.3, 0.29, 0.27), 0.9, { scorch, wet, key: 'trench' }),
    trunk: trunkMat(K_PALM, 'site-trunk'),
    trunkPine: trunkMat(K_PINE, 'site-trunk'),
    trunkBroad: trunkMat(K_BROAD, 'site-trunk'),
    sand: stained(lin(0.78, 0.72, 0.58), 0.95, { key: 'sand', scale: 0.5 }),
    water: new MeshPhysicalMaterial({ color: new Color(0.01, 0.03, 0.04), roughness: 0.08, metalness: 0, clearcoat: 1 }),
    rubber: std([0.03, 0.03, 0.03], 0.85, 0),
    vehiclePaint: new MeshPhysicalMaterial({ color: new Color(...lin(0.85, 0.85, 0.82)), roughness: 0.35, clearcoat: 0.8 }),
    scorch,
    wet,
    wind,
    windTime,
  };
}
