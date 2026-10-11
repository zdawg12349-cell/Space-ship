import {
  BackSide, Color, CustomBlending, CylinderGeometry, Matrix4, Mesh, OneFactor, OneMinusSrcAlphaFactor, PointLight, Scene, ShaderMaterial,
  Texture, Vector2, Vector3,
} from 'three';
import type { EngineRuntime, Vessel } from '../physics/vessel';
import type { PlumeStyle } from '../vehicles/types';
import type { VesselVisuals } from '../render/vehicle/VesselVisuals';
import type { EngineVisual } from '../render/vehicle/VehicleParts';

/**
 * Rocket exhaust plumes: one ray-marched volume per thrust chamber.
 *
 * The plume shape follows the nozzle's pressure ratio. At sea level an over-expanded jet stays
 * narrow, with a bright core and a train of shock diamonds; as ambient pressure falls the jet
 * becomes under-expanded and balloons into a broad, faint bell, and in vacuum only the glow
 * near the nozzle stays visible. Colour and soot depend on the propellant: kerosene burns
 * orange and sooty, hydrogen is nearly invisible apart from the diamonds, methane is blue,
 * solids are blinding white.
 *
 * Volumes are drawn after the atmosphere composite (premultiplied alpha: emission plus soot
 * extinction) and clip themselves against the scene's linear depth, so the plume tucks behind
 * the pad deck, the ground or the vehicle itself.
 */

interface StyleDef {
  core: [number, number, number];
  body: [number, number, number];
  edge: [number, number, number];
  diamond: [number, number, number];
  /** centre-line luminance at full thrust, sea level (kcd/m^2) */
  intensity: number;
  /** luminous length in exit radii at sea level */
  length: number;
  /** core length in exit radii */
  coreLen: number;
  /** shock-diamond strength (0..1) */
  diamonds: number;
  /** soot extinction (kerosene afterburning) */
  soot: number;
  /** how much the plume balloons with altitude (1 = typical bell) */
  expansion: number;
  /** illumination cast on the surroundings (kcd per MN of thrust) */
  light: number;
  lightColor: [number, number, number];
}

const STYLES: Record<PlumeStyle, StyleDef> = {
  kerolox: { core: [1.0, 0.88, 0.66], body: [1.0, 0.56, 0.18], edge: [0.9, 0.3, 0.06], diamond: [1.0, 0.92, 0.75], intensity: 2200, length: 42, coreLen: 5.5, diamonds: 0.55, soot: 0.9, expansion: 1, light: 9000, lightColor: [1.0, 0.62, 0.3] },
  hydrolox: { core: [0.62, 0.66, 1.0], body: [0.42, 0.38, 0.85], edge: [0.35, 0.25, 0.6], diamond: [1.0, 0.78, 0.86], intensity: 180, length: 14, coreLen: 3.0, diamonds: 1.0, soot: 0, expansion: 1.1, light: 1500, lightColor: [0.75, 0.75, 1.0] },
  methalox: { core: [0.62, 0.7, 1.0], body: [0.62, 0.42, 0.85], edge: [0.95, 0.45, 0.25], diamond: [0.95, 0.88, 1.0], intensity: 420, length: 18, coreLen: 4.0, diamonds: 0.85, soot: 0.06, expansion: 1, light: 4000, lightColor: [0.85, 0.75, 1.0] },
  hypergolic: { core: [1.0, 0.72, 0.55], body: [0.95, 0.5, 0.38], edge: [0.7, 0.28, 0.2], diamond: [1.0, 0.85, 0.75], intensity: 220, length: 12, coreLen: 3.0, diamonds: 0.35, soot: 0.04, expansion: 1.2, light: 3000, lightColor: [1.0, 0.7, 0.55] },
  solid: { core: [1.0, 0.97, 0.88], body: [1.0, 0.82, 0.55], edge: [1.0, 0.62, 0.3], diamond: [1.0, 0.95, 0.85], intensity: 2600, length: 44, coreLen: 9.0, diamonds: 0.15, soot: 0.25, expansion: 0.8, light: 12000, lightColor: [1.0, 0.86, 0.66] },
  nuclear: { core: [0.7, 0.78, 1.0], body: [0.5, 0.55, 0.95], edge: [0.4, 0.4, 0.8], diamond: [0.9, 0.9, 1.0], intensity: 60, length: 10, coreLen: 3.0, diamonds: 0.4, soot: 0, expansion: 1.3, light: 400, lightColor: [0.8, 0.85, 1.0] },
  aerospike: { core: [0.62, 0.66, 1.0], body: [0.48, 0.42, 0.9], edge: [0.4, 0.3, 0.7], diamond: [1.0, 0.8, 0.9], intensity: 200, length: 12, coreLen: 2.5, diamonds: 0.6, soot: 0, expansion: 0.25, light: 1500, lightColor: [0.75, 0.75, 1.0] },
};

const VERT = /* glsl */ `
uniform float uLen;
uniform float uRmax;
uniform float uR0;
uniform float uRe;
uniform float uRfar;
uniform float uSexp;
uniform float uSpread;
uniform float uLcore;
out vec3 vLocal;
void main() {
  vec3 p = position;
  // unit cylinder y in [-0.5, 0.5] -> s in [0, L] downstream, rings packed near the exit where
  // the jet balloons fastest
  float u = 0.5 - p.y;
  float s = uLen * u * u;
  p.y = -s;
  // rasterise a hull hugging the jet's own radius profile (the march draws out to ~1.7 radii;
  // the march itself is bounded by a cylinder)
  float R = uRe + (uRfar - uRe) * (1.0 - exp(-s / max(uSexp, 1e-3))) + uSpread * pow(max(0.0, s - uLcore * 0.4), 0.92);
  p.xz *= max(uR0, R * 1.85);
  vLocal = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vLocal;
uniform vec3 uCamLocal;
uniform sampler2D uNoise;
uniform sampler2D uLinDepth;
uniform vec2 uResolution;
uniform float uTime;
uniform float uSeed;
uniform float uLen;
uniform float uRmax;
uniform float uRe;
uniform float uRfar;
uniform float uSexp;
uniform float uLp;
uniform float uLcore;
uniform float uLambda;
uniform float uDiamond;
uniform float uSoot;
uniform float uIntensity;
// how fast the glow fades as an under-expanded jet balloons and cools (0 in dense air)
uniform float uCool;
uniform float uFlow;
uniform float uIgnite;
uniform float uSpread;
uniform vec3 uColCore;
uniform vec3 uColBody;
uniform vec3 uColEdge;
uniform vec3 uColDiamond;
uniform vec3 uAtmT;

vec2 cyl(vec3 ro, vec3 rd, float R) {
  float a = dot(rd.xz, rd.xz);
  float b = dot(ro.xz, rd.xz);
  float c = dot(ro.xz, ro.xz) - R * R;
  if (a < 1e-8) return c < 0.0 ? vec2(-1e9, 1e9) : vec2(1.0, -1.0);
  float h = b * b - a * c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2((-b - h) / a, (-b + h) / a);
}

void main() {
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - ro);
  vec2 tc = cyl(ro, rd, uRmax);
  // slab y in [-L, 0]
  float ty0, ty1;
  if (abs(rd.y) < 1e-6) { ty0 = (ro.y < 0.0 && ro.y > -uLen) ? -1e9 : 1.0; ty1 = (ro.y < 0.0 && ro.y > -uLen) ? 1e9 : -1.0; }
  else { float a = (0.0 - ro.y) / rd.y, b = (-uLen - ro.y) / rd.y; ty0 = min(a, b); ty1 = max(a, b); }
  float t0 = max(max(tc.x, ty0), 0.0);
  float t1 = min(tc.y, ty1);
  float scene = texture(uLinDepth, gl_FragCoord.xy / uResolution).r;
  t1 = min(t1, scene);
  if (t1 <= t0) discard;
  const int N = 22;
  float dt = (t1 - t0) / float(N);
  // interleaved gradient noise to hide step banding
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uSeed);
  vec3 emis = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < N; i++) {
    float t = t0 + (float(i) + jit) * dt;
    vec3 p = ro + rd * t;
    float s = -p.y;
    // pressure-driven expansion near the exit + turbulent spreading of the mixing layer
    float R = uRe + (uRfar - uRe) * (1.0 - exp(-s / uSexp)) + uSpread * pow(max(0.0, s - uLcore * 0.4), 0.92);
    float r = length(p.xz);
    float rho = r / R;
    if (rho > 1.7) continue;
    // flowing turbulence in cylindrical coordinates: streaks along the jet, eddies at the rim
    float ang = atan(p.z, p.x) * 0.15915 + uSeed;
    // (one noise tile = 8 cells: ~3 eddies around the jet, one every ~2 radii downstream)
    float sc = s / (R * 16.0);
    vec2 q = vec2(ang * 0.4 + rho * 0.03, sc - uTime * uFlow / (R * 16.0));
    float n1 = texture(uNoise, q).r;
    float n2 = texture(uNoise, q * vec2(2.3, 2.1) + vec2(0.37, 0.11)).g;
    float n3 = texture(uNoise, q * vec2(4.1, 4.7) + vec2(0.71, 0.53)).b;
    float turb = (n1 * 0.55 + n2 * 0.3 + n3 * 0.15 - 0.5) * 2.4;
    float mixing = clamp(s / (uLcore * 1.6), 0.0, 1.0);
    // ragged rim: the shear layer eats into the jet downstream
    float rimR = 1.0 + turb * 0.5 * mixing;
    float body = exp(-pow(rho / max(0.3, rimR), 2.0) * 2.2) * exp(-s / uLp);
    // far field breaks up into burning lumps
    float breakup = smoothstep(0.35, 1.3, s / uLp);
    body *= mix(1.0, smoothstep(0.05, 0.65, turb * 0.5 + 0.45), breakup);
    float core = exp(-rho * rho * 12.0) * exp(-s / uLcore) * (0.85 + 0.3 * n3);
    // shock diamonds: periodic compressions along the core, decaying downstream
    float ph = s / uLambda;
    float dia = uDiamond * pow(0.5 + 0.5 * cos(6.2831853 * ph), 8.0) * exp(-ph * 0.55) * exp(-rho * rho * 7.0) * smoothstep(0.15, 0.9, ph);
    // colour runs from the white-hot core through the body colour to a cooler, redder rim
    float cool = clamp(rho * 0.9 + mixing * 0.3 + s / uLp * 0.35 - turb * 0.25, 0.0, 1.0);
    vec3 cBody = mix(mix(uColCore, uColBody, smoothstep(0.0, 0.35, cool)), uColEdge, smoothstep(0.35, 1.0, cool));
    float bodyLum = body * (0.7 + 0.6 * clamp(turb * mixing + 0.3, 0.0, 1.0));
    // the gas cools as it expands: a vacuum jet's white-hot core fades within a few nozzle radii
    // (so looking down the jet from beside the nozzle does not add up to a white ball), while the
    // broad bell beyond, seen side-on, keeps most of its glow
    float expand = uRe / R;
    vec3 c = uColCore * core * 2.5 * pow(expand, uCool * 1.4) + cBody * bodyLum * pow(expand, uCool * 0.3) + uColDiamond * dia * 2.5;
    // ignition transient (TEA-TEB green for kerosene engines)
    c = mix(c, vec3(0.25, 1.0, 0.35) * (core * 2.0 + body), uIgnite);
    float dens = uIntensity / R;
    emis += trans * c * dens * dt;
    // soot: dark smoke in the turbulent afterburning zone
    float sootD = uSoot * body * smoothstep(uLcore * 0.6, uLcore * 2.5, s) * clamp(0.6 + turb, 0.0, 1.5) / R;
    trans *= exp(-sootD * dt * 1.4);
    if (trans < 0.02) break;
  }
  // the hot gas absorbs what it emits: however far a line of sight runs down the jet (a camera on
  // the stage looking aft, or one beneath the engines looking up), the glow cannot pile up far
  // beyond a few times the core's brightness seen side-on. Side views stay below the knee
  float lum = dot(emis, vec3(0.2126, 0.7152, 0.0722));
  float knee = 3.0 * uIntensity * dot(uColCore, vec3(0.2126, 0.7152, 0.0722));
  if (lum > knee) emis *= (knee + knee * (1.0 - exp(-(lum - knee) / knee))) / lum;
  // a vacuum jet seen from a camera on its own stage, right beside the nozzle: the camera sits in
  // the cold fringe of the bell and, as the stage's own cameras show, sees the glowing nozzle with
  // only a faint plume beyond it (at sea level the jet stays bright from anywhere)
  emis *= mix(1.0, smoothstep(uRe * 2.0, uRe * 12.0, length(uCamLocal)), smoothstep(1.0, 1.4, uCool));
  emis *= uAtmT;
  gl_FragColor = vec4(emis, 1.0 - trans);
}`;

const _m = new Matrix4();
const _inv = new Matrix4();
const _v = new Vector3();
const _c = new Vector3();

interface PlumeVolume {
  mesh: Mesh;
  mat: ShaderMaterial;
  engine: EngineRuntime;
  ev: EngineVisual;
  vessel: Vessel;
  offset: Vector3;
  style: StyleDef;
  re: number;
  /** fraction of the engine's thrust carried by this chamber */
  share: number;
}

/** Cluster light: one per burning stage, lighting the vehicle, the pad and the smoke. */
export interface PlumeLight {
  light: PointLight;
  /** camera-relative world position (for the particle shader) */
  pos: Vector3;
  color: Color;
  intensity: number;
}

/** A hot exhaust region for the heat-shimmer pass (camera-relative world space). */
export interface HazeSource { pos: Vector3; dir: Vector3; length: number; radius: number; strength: number; w: number }

export class PlumeSystem {
  /** hottest exhaust regions this frame, strongest first (up to three) */
  haze: HazeSource[] = [];
  readonly lights: PlumeLight[] = [];
  private volumes: PlumeVolume[] = [];
  private known = new Set<EngineRuntime>();
  private geom = new CylinderGeometry(1, 1, 1, 20, 24, false);
  private time = 0;
  private resolution = new Vector2(1, 1);
  quality = 1;
  /** lights in use (the rest stay hidden for the whole flight: see setLightCount) */
  private lightCount = 3;

  constructor(private readonly fxScene: Scene, private readonly mainScene: Scene, private readonly noise: Texture, private readonly linDepth: () => Texture) {
    for (let i = 0; i < 3; i++) {
      const light = new PointLight(0xffaa66, 0, 0, 2);
      light.castShadow = false;
      mainScene.add(light);
      this.lights.push({ light, pos: new Vector3(), color: new Color(), intensity: 0 });
    }
  }

  /** Create volumes for every engine chamber of the vessels' visuals that doesn't have one yet. */
  private sync(vessels: Vessel[], visuals: VesselVisuals): void {
    for (const v of vessels) {
      for (const a of v.assemblies) {
        const av = visuals.visualOf(a);
        if (!av) continue;
        for (const ev of av.engines) {
          const e = a.engines[ev.index];
          if (!e || this.known.has(e)) continue;
          this.known.add(e);
          const style = STYLES[e.mount.spec.plume] ?? STYLES.kerolox;
          const chambers = ev.chambers.length ? ev.chambers : [[0, 0] as [number, number]];
          for (const [cx, cz] of chambers) {
            const mat = this.makeMaterial(style);
            const mesh = new Mesh(this.geom, mat);
            mesh.frustumCulled = false;
            mesh.matrixAutoUpdate = false;
            mesh.matrixWorldAutoUpdate = false;
            mesh.visible = false;
            mesh.renderOrder = 10;
            this.fxScene.add(mesh);
            this.volumes.push({ mesh, mat, engine: e, ev, vessel: v, offset: new Vector3(cx, ev.exitY, cz), style, re: ev.exitRadius, share: 1 / chambers.length });
          }
        }
      }
    }
  }

  private makeMaterial(st: StyleDef): ShaderMaterial {
    return new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      uniforms: {
        uCamLocal: { value: new Vector3() }, uNoise: { value: this.noise }, uLinDepth: { value: null }, uResolution: { value: this.resolution },
        uTime: { value: 0 }, uSeed: { value: Math.random() }, uLen: { value: 10 }, uRmax: { value: 1 }, uRe: { value: 0.5 }, uRfar: { value: 0.6 },
        uSexp: { value: 2 }, uLp: { value: 8 }, uLcore: { value: 2 }, uLambda: { value: 1 }, uDiamond: { value: 0 }, uSoot: { value: 0 }, uIntensity: { value: 0 }, uCool: { value: 0 },
        uFlow: { value: 60 }, uIgnite: { value: 0 }, uSpread: { value: 0.08 }, uR0: { value: 1 },
        uColCore: { value: new Vector3(...st.core) }, uColBody: { value: new Vector3(...st.body) }, uColEdge: { value: new Vector3(...st.edge) },
        uColDiamond: { value: new Vector3(...st.diamond) }, uAtmT: { value: new Vector3(1, 1, 1) },
      },
    });
  }

  /** Forget volumes of vessels that no longer exist. */
  private prune(vessels: Vessel[]): void {
    const alive = new Set(vessels);
    this.volumes = this.volumes.filter((p) => {
      if (alive.has(p.vessel) && p.vessel.assemblies.includes(p.engine.assembly)) return true;
      // the engine may have moved to a new vessel (separation): keep it if any vessel owns it
      const owner = vessels.find((v) => v.assemblies.includes(p.engine.assembly));
      if (owner) { p.vessel = owner; return true; }
      this.fxScene.remove(p.mesh);
      p.mat.dispose();
      this.known.delete(p.engine);
      return false;
    });
  }

  /**
   * @param atmT approximate atmospheric transmittance camera -> vehicle (RGB)
   * @param seaLevelPressure for pressure ratios (Pa)
   */
  update(dt: number, vessels: Vessel[], visuals: VesselVisuals, resolution: Vector2, atmT: Vector3, seaLevelPressure = 101325): void {
    this.time += dt;
    this.resolution.copy(resolution);
    this.sync(vessels, visuals);
    this.prune(vessels);
    visuals.root.updateMatrixWorld(true);
    const linDepth = this.linDepth();
    // per-vessel cluster light accumulation
    const clusters = new Map<Vessel, { sum: Vector3; w: number; intensity: number; color: Vector3 }>();
    const hz = new Map<Vessel, HazeSource>();
    for (const p of this.volumes) {
      const e = p.engine;
      const v = p.vessel;
      const alive = !v.destroyed && !e.assembly.destroyed && visuals.visualOf(e.assembly)?.group.visible !== false;
      const spec = e.mount.spec;
      const thrustFrac = spec.thrustVac > 0 ? e.thrust / spec.thrustVac : 0;
      const on = alive && (e.thrust > 0 || e.spool > 0.02);
      p.mesh.visible = on;
      if (!on) continue;
      const st = p.style;
      const re = p.re;
      // pressure ratio: exit pressure is roughly sea-level for booster engines, a few kPa for vacuum bells
      const vac = spec.nozzle === 'vacuum' || spec.thrustSL < spec.thrustVac * 0.6;
      const pe = (vac ? 6000 : 70000) * Math.max(0.2, e.throttle);
      const pa = Math.max(1, v.atm.pressure);
      const k = Math.min(5000, pe / pa);
      const kk = Math.pow(k, 0.5 * st.expansion);
      const rfar = re * Math.min(40, Math.max(0.9, 0.85 + kk * 0.7));
      const sexp = re * (1.5 + Math.min(30, Math.pow(k, 0.35) * 2.2));
      const air = Math.min(1, pa / seaLevelPressure);
      // luminous length grows as the jet expands; the body fades in thin air
      const lp = re * st.length * (0.55 + 0.45 * Math.min(1, e.throttle * 1.2)) * (1 + Math.min(4, Math.log10(1 + k) * 0.9));
      const lcore = re * st.coreLen * (1 + Math.min(2, Math.log10(1 + k) * 0.5));
      // shock-cell spacing ~1.3 D sqrt(M^2 - 1) at the design point, stretching as the jet under-expands
      const lambda = re * 6.5 * Math.max(0.7, Math.min(4, Math.sqrt(k)));
      const diamonds = st.diamonds * Math.max(0, 1 - Math.max(0, Math.log10(k) - 0.1) / 0.9) * Math.min(1, e.throttle * 1.5);
      // brightness: thrust fraction, spool, expansion dimming
      const spoolLum = e.spool * e.spool;
      // an expanded jet spreads its light thin and cools as it expands: in near-vacuum the far
      // plume is a faint, translucent bell around a bright core at the nozzle
      const expDim = Math.pow(re / rfar, 0.6) * Math.pow(Math.min(1, (3 * re) / rfar), 0.9);
      const intensity = st.intensity * re * Math.pow(Math.max(0.05, thrustFrac), 0.7) * spoolLum * expDim * (0.1 + 0.9 * Math.pow(air, 0.15)) * this.quality;
      const len = Math.min(lp * 3.2, 4000);
      // jet spreading half-angle ~5 deg in air; the vacuum plume is shaped by expansion alone
      const spread = 0.03 + 0.06 * Math.pow(air, 0.3);
      const u = p.mat.uniforms;
      u.uLen.value = len;
      u.uSpread.value = spread;
      u.uR0.value = re * 1.5;
      u.uRmax.value = (rfar + spread * len) * 1.6;
      u.uRe.value = re * 0.92;
      u.uRfar.value = rfar;
      u.uSexp.value = sexp;
      u.uLp.value = lp;
      u.uLcore.value = lcore;
      u.uLambda.value = lambda;
      u.uDiamond.value = diamonds;
      u.uSoot.value = st.soot * air * Math.min(1, thrustFrac * 1.5);
      u.uIntensity.value = intensity;
      u.uCool.value = Math.min(1.5, Math.max(0, Math.log10(k) * 0.5));
      u.uFlow.value = Math.min(300, 40 + re * 30);
      u.uTime.value = this.time;
      u.uLinDepth.value = linDepth;
      u.uIgnite.value = spec.propellant === 'kerolox' && e.ignitionAge < 0.5 && e.running ? Math.max(0, 1 - e.ignitionAge / 0.5) * 0.8 : 0;
      (u.uAtmT.value as Vector3).copy(atmT);
      // world transform: engine pivot (gimbal) x chamber exit
      _m.makeTranslation(p.offset.x, p.offset.y, p.offset.z);
      p.mesh.matrixWorld.multiplyMatrices(p.ev.pivot.matrixWorld, _m);
      _inv.copy(p.mesh.matrixWorld).invert();
      (u.uCamLocal.value as Vector3).set(0, 0, 0).applyMatrix4(_inv);
      // heat shimmer: hot exhaust gas in dense air bends the light behind it
      if (air > 0.05) {
        let h = hz.get(v);
        if (!h) { h = { pos: new Vector3(), dir: new Vector3(), length: 0, radius: 0, strength: 0, w: 0 }; hz.set(v, h); }
        const w = Math.max(1e-3, e.thrust);
        h.pos.add(_v.set(p.offset.x, p.offset.y, p.offset.z).applyMatrix4(p.ev.pivot.matrixWorld).multiplyScalar(w));
        h.dir.add(_c.set(0, -1, 0).transformDirection(p.ev.pivot.matrixWorld).multiplyScalar(w));
        h.w += w;
        h.length = Math.max(h.length, lp * 2.2);
        h.radius = Math.max(h.radius, rfar * 2.5 + re * 4);
        h.strength = Math.max(h.strength, Math.min(1, air) * Math.min(1, thrustFrac * 1.4) * e.spool);
      }
      // light accumulation (position a few radii below the exit)
      _v.set(p.offset.x, p.offset.y - Math.min(lp * 0.15, 6), p.offset.z).applyMatrix4(p.ev.pivot.matrixWorld);
      let c = clusters.get(v);
      if (!c) { c = { sum: new Vector3(), w: 0, intensity: 0, color: new Vector3() }; clusters.set(v, c); }
      const w = Math.max(1e-3, e.thrust);
      c.sum.addScaledVector(_v, w);
      c.w += w;
      const li = (e.thrust / 1e6) * st.light * spoolLum * p.share * (0.4 + 0.6 * air);
      c.intensity += li;
      c.color.addScaledVector(_c.set(...st.lightColor), li);
    }
    this.haze = [...hz.values()].filter((h) => h.w > 0).map((h) => {
      h.pos.multiplyScalar(1 / h.w);
      h.dir.normalize();
      return h;
    }).sort((a, b) => b.strength * b.radius - a.strength * a.radius).slice(0, 3);
    // assign the brightest clusters to the light pool
    const list = [...clusters.values()].filter((c) => c.intensity > 0).sort((a, b) => b.intensity - a.intensity);
    this.lights.forEach((L, i) => {
      const c = i < this.lightCount ? list[i] : undefined;
      // (lights are never hidden, only dimmed: three.js bakes the number of visible lights into every
      // lit material, so switching one off at each ignition or cutoff recompiled them all, a freeze)
      if (!c) { L.light.intensity = 0; L.intensity = 0; return; }
      L.pos.copy(c.sum).multiplyScalar(1 / c.w);
      L.light.position.copy(L.pos);
      L.color.setRGB(c.color.x / c.intensity, c.color.y / c.intensity, c.color.z / c.intensity);
      L.light.color.copy(L.color);
      // flicker
      const fl = 1 + 0.06 * Math.sin(this.time * 37 + i) + 0.04 * Math.sin(this.time * 91 + i * 2);
      L.intensity = c.intensity * fl;
      L.light.intensity = L.intensity;
    });
  }

  /**
   * How many exhaust lights light the scene (graphics preset). Each visible light costs every lit
   * pixel, idle or not, so a low-end preset uses one; the count is fixed until the preset changes,
   * since changing it recompiles every lit material.
   */
  setLightCount(n: number): void {
    this.lightCount = Math.max(0, Math.min(this.lights.length, Math.round(n)));
    this.lights.forEach((L, i) => { L.light.visible = i < this.lightCount; if (i >= this.lightCount) { L.light.intensity = 0; L.intensity = 0; } });
  }

  /** Total visible plume brightness near the camera (for exposure / audio hints). */
  get anyActive(): boolean { return this.volumes.some((p) => p.mesh.visible); }

  clear(): void {
    for (const p of this.volumes) { this.fxScene.remove(p.mesh); p.mat.dispose(); }
    this.volumes = [];
    this.known.clear();
    for (const L of this.lights) { L.light.intensity = 0; L.intensity = 0; }
  }
}

export { STYLES as PLUME_STYLES };
