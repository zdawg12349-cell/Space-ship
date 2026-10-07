import { Group, Matrix4, Mesh, MeshPhysicalMaterial, Quaternion, Texture, Vector3 } from 'three';
import type { AssemblyDef, MaterialStyle, SectionDef, VehicleDef } from '../../vehicles/types';
import { liveryTexture } from './Livery';
import { box, domeProfile, GeoBuilder, lathe, ogiveProfile, Profile, radialFrame, SurfaceAttrs, tube } from './shapes';
import { AssemblyShaderState, createHardware, createSkin, newAssemblyState } from './VehicleMaterials';
import {
  buildChute, buildEngine, buildFlap, buildGridFin, buildLeg, buildSolarArrays, ChuteVisual, EngineVisual, HingedPart, PanelVisual,
} from './VehicleParts';

/**
 * Procedural vehicle builder. Turns a VehicleDef (the same data the physics uses) into
 * detailed meshes per assembly, built in the shared vehicle frame (+Y up, y = 0 at the base
 * of the first stage, side boosters offset laterally) so assemblies can be re-parented to
 * whichever physics body they belong to after staging.
 */

export interface AssemblyVisual {
  id: string;
  def: AssemblyDef;
  group: Group;
  state: AssemblyShaderState;
  engines: EngineVisual[];
  gridFins: HingedPart[];
  legs: HingedPart[];
  flapsFwd: HingedPart[];
  flapsAft: HingedPart[];
  panels: PanelVisual | null;
  drogues: ChuteVisual[];
  mains: ChuteVisual[];
  chuteAnchorY: number;
  yMin: number;
  yMax: number;
  radius: number;
  /** frost-coated (cryogenic) sections exist */
  cryo: boolean;
  /** heat-shield material uniforms target uShieldHeat */
  hasHeatShield: boolean;
}

export interface VehicleVisual {
  def: VehicleDef;
  assemblies: Map<string, AssemblyVisual>;
  height: number;
}

const segFor = (r: number) => (r > 3 ? 128 : r > 1.5 ? 96 : r > 0.7 ? 64 : 40);

class AssemblyBuild {
  readonly gbs = new Map<string, { gb: GeoBuilder; style: MaterialStyle; double: boolean; livery: Texture | null; color?: [number, number, number]; heatShield?: boolean }>();
  readonly vis: AssemblyVisual;
  readonly off: [number, number];
  readonly mats = new Map<string, MeshPhysicalMaterial>();

  constructor(readonly def: VehicleDef, readonly asm: AssemblyDef, readonly parentRadius: number) {
    let yMin = Infinity, yMax = -Infinity, rMax = 0.2;
    for (const s of asm.sections) { yMin = Math.min(yMin, s.y); yMax = Math.max(yMax, s.y + s.length); rMax = Math.max(rMax, s.radius, s.topRadius ?? 0); }
    for (const e of asm.engines) yMin = Math.min(yMin, e.pos[1] - e.spec.nozzleLength);
    if (!isFinite(yMin)) { yMin = 0; yMax = 1; }
    this.off = asm.offset ?? [0, 0];
    this.vis = {
      id: asm.id, def: asm, group: new Group(), state: newAssemblyState(yMin, yMax, null), engines: [], gridFins: [], legs: [], flapsFwd: [], flapsAft: [],
      panels: null, drogues: [], mains: [], chuteAnchorY: yMax, yMin, yMax, radius: rMax, cryo: asm.sections.some((s) => s.frost), hasHeatShield: !!asm.features?.heatShield,
    };
    this.vis.group.name = `asm-${asm.id}`;
  }

  /** geometry bucket for a material style (+ optional decal texture / colour override) */
  gb(style: MaterialStyle, o: { double?: boolean; livery?: Texture | null; color?: [number, number, number]; heatShield?: boolean; key?: string } = {}): GeoBuilder {
    const k = `${style}|${o.double ? 1 : 0}|${o.livery ? o.livery.uuid : ''}|${o.color ? o.color.join(',') : ''}|${o.heatShield ? 1 : 0}|${o.key ?? ''}`;
    let e = this.gbs.get(k);
    if (!e) { e = { gb: new GeoBuilder(), style, double: !!o.double, livery: o.livery ?? null, color: o.color, heatShield: o.heatShield }; this.gbs.set(k, e); }
    return e.gb;
  }

  hardware(): GeoBuilder { return this.gb('soot', { key: 'hw' }); }
  metal(): GeoBuilder { return this.gb('aluminium', { key: 'metal' }); }

  /** Primary colour override (materials in the catalogue already carry the livery). */
  paint(_sec: SectionDef): [number, number, number] | undefined {
    return undefined;
  }

  finish(): AssemblyVisual {
    for (const e of this.gbs.values()) {
      if (!e.gb.vertexCount) continue;
      const mat = createSkin({ style: e.style, state: this.vis.state, livery: e.livery, color: e.color, doubleSided: e.double, heat: e.heatShield ? this.vis.state.uShieldHeat : undefined });
      const mesh = new Mesh(e.gb.build(), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.vis.group.add(mesh);
    }
    return this.vis;
  }
}

/** How readily a cryogenic tank wall grows frost: foam/blanket insulation keeps it mostly clear. */
const FROST_BY_MATERIAL: Partial<Record<MaterialStyle, number>> = { orange_foam: 0.12, insulation_white: 0.1, cork: 0.1, silver_foil: 0.25, gold_foil: 0.2 };

function attrsFor(sec: SectionDef, extra: Partial<SurfaceAttrs> = {}): SurfaceAttrs {
  const frost = sec.frost ? (FROST_BY_MATERIAL[sec.material] ?? 0.85) : 0;
  return { frost, soot: 1, livery: 0, panel: 1, ...extra };
}

/** Thin raised ring (joint, bolt flange) */
function jointRing(gb: GeoBuilder, r: number, y: number, h: number, t: number, off: [number, number], a: SurfaceAttrs = {}): void {
  lathe(gb, [[r, y - h / 2], [r + t, y - h / 3], [r + t, y + h / 3], [r, y + h / 2]], { segments: segFor(r), offset: off, attrs: { ...a, panel: 0 } });
}

// ===================================================================================== sections

function buildSection(B: AssemblyBuild, sec: SectionDef, index: number): void {
  const off = B.off;
  const r = sec.radius;
  const rt = sec.topRadius ?? r;
  const y = sec.y, L = sec.length;
  const segs = segFor(Math.max(r, rt));
  const col = B.paint(sec);
  const style = sec.style ?? '';
  const ship = !!B.asm.features?.flaps;
  const a = attrsFor(sec);

  // the starship-like vehicle: steel leeward half, tiled windward half (+Z belly)
  const shipLathe = (prof: Profile, attrs: SurfaceAttrs) => {
    lathe(B.gb('steel'), prof, { segments: segs / 2, thetaStart: Math.PI, thetaLength: Math.PI, offset: off, attrs });
    lathe(B.gb('tiles'), prof, { segments: segs / 2, thetaStart: 0, thetaLength: Math.PI, offset: off, attrs });
  };
  const skin = (prof: Profile, attrs: SurfaceAttrs = a, o: { material?: MaterialStyle; livery?: Texture | null; double?: boolean; thetaStart?: number; thetaLength?: number; cap?: boolean } = {}) => {
    if (ship && sec.material === 'steel' && !o.livery) { shipLathe(prof, attrs); return; }
    lathe(B.gb(o.material ?? sec.material, { livery: o.livery, color: col, double: o.double }), prof, {
      segments: segs, offset: off, attrs, thetaStart: o.thetaStart, thetaLength: o.thetaLength, capBottom: o.cap,
    });
  };
  const labelTex = (kind: 'name' | 'bands' | 'fairing' | 'srb' | 'capsule', text?: string) => liveryTexture({ def: B.def, length: L, radius: Math.max(r, rt), kind, text });

  switch (sec.kind) {
    case 'tank': {
      const prof: Profile = [[r, y], [r, y + L]];
      if (sec.label) skin(prof, { ...a, livery: 1, livY0: y, livY1: y + L }, { livery: labelTex('name', sec.label) });
      else if (sec.bands) skin(prof, { ...a, livery: 1, livY0: y, livY1: y + L }, { livery: labelTex('bands') });
      else skin(prof);
      jointRing(B.gb(sec.material, { color: col }), r, y + L, 0.06, Math.max(0.008, r * 0.006), off, a);
      if (sec.raceway) {
        const w = Math.max(0.12, r * 0.16), d = Math.max(0.05, r * 0.045);
        for (const th of [0.35, 0.35 + Math.PI]) {
          box(B.gb(sec.material === 'black_carbon' ? 'black_carbon' : 'grey'), d, L * 0.96, w, radialFrame(th, r + d / 2, y + L / 2, off), { panel: 0, soot: 1 });
        }
      }
      if (style === 'centaur' || style === 'sivb' || style === 'icps') {
        // aft skirt band and forward ring
        jointRing(B.metal(), r, y + 0.15, 0.3, 0.02, off);
      }
      if (style === 'sivb') {
        // auxiliary propulsion module pods
        for (const th of [Math.PI / 2, -Math.PI / 2]) box(B.gb('white'), 0.5, 1.6, 1.0, radialFrame(th, r + 0.25, y + 0.9, off));
      }
      if (style === 'lh2_tank' || style === 'icps') {
        // stringer-reinforced feed lines along the tank
        const th = 1.2;
        tube(B.metal(), new Vector3(off[0] + Math.cos(th) * (r + 0.15), y + 0.2, off[1] + Math.sin(th) * (r + 0.15)), new Vector3(off[0] + Math.cos(th) * (r + 0.15), y + L - 0.2, off[1] + Math.sin(th) * (r + 0.15)), 0.12, 10);
      }
      break;
    }
    case 'taper': {
      const prof: Profile = [[r, y], [rt, y + L]];
      if (style === 'soyuz_booster') {
        // conical strap-on with a pointed nose (the nose continues the taper)
        skin([[r, y], [rt, y + L], [rt * 0.55, y + L + 0.6], [0.02, y + L + 1.6]], { ...a, frost: 1 });
      } else if (sec.label) skin(prof, { ...a, livery: 1, livY0: y, livY1: y + L }, { livery: labelTex('name', sec.label) });
      else skin(prof);
      if (style === 'isa' || style === 'lvsa') jointRing(B.metal(), Math.max(r, rt), y + (r > rt ? 0.05 : L - 0.05), 0.1, 0.02, off);
      break;
    }
    case 'interstage': {
      if (style === 'truss') {
        // open truss: bottom/top rings and a zig-zag of tubular struts
        const hw = B.hardware();
        jointRing(hw, r, y + 0.08, 0.16, 0.05, off);
        jointRing(hw, rt, y + L - 0.08, 0.16, 0.05, off);
        const n = 12;
        for (let i = 0; i < n; i++) {
          const a0 = (i / n) * Math.PI * 2, a1 = ((i + 0.5) / n) * Math.PI * 2, a2 = ((i + 1) / n) * Math.PI * 2;
          const p0 = new Vector3(off[0] + Math.cos(a0) * r * 0.97, y + 0.12, off[1] + Math.sin(a0) * r * 0.97);
          const p1 = new Vector3(off[0] + Math.cos(a1) * rt * 0.97, y + L - 0.12, off[1] + Math.sin(a1) * rt * 0.97);
          const p2 = new Vector3(off[0] + Math.cos(a2) * r * 0.97, y + 0.12, off[1] + Math.sin(a2) * r * 0.97);
          tube(hw, p0, p1, Math.max(0.03, r * 0.025), 8);
          tube(hw, p1, p2, Math.max(0.03, r * 0.025), 8);
        }
      } else if (style === 'hotstage') {
        // vented hot-staging ring: steel bars with dark openings
        const n = 36;
        for (let i = 0; i < n; i++) {
          const th = (i / n) * Math.PI * 2;
          box(B.gb('steel'), 0.14, L * 0.7, 0.32, radialFrame(th, r - 0.07, y + L / 2, off));
        }
        lathe(B.gb('soot'), [[r * 0.94, y], [r * 0.94, y + L]], { segments: segs, offset: off });
        lathe(B.gb('steel'), [[r, y], [r, y + L * 0.15]], { segments: segs, offset: off });
        lathe(B.gb('steel'), [[r, y + L * 0.85], [r, y + L]], { segments: segs, offset: off });
      } else if (style === 'iu') {
        skin([[r, y], [r, y + L]], a, { material: 'grey' });
        for (let i = 0; i < 10; i++) box(B.hardware(), 0.1, L * 0.6, 0.5, radialFrame((i / 10) * Math.PI * 2, r + 0.02, y + L / 2, off));
      } else if (style === 'saturn_interstage') {
        skin([[r, y], [r, y + L]]);
        // ullage motor fairings
        for (let i = 0; i < 4; i++) {
          const th = Math.PI / 4 + (i * Math.PI) / 2;
          const c = new Vector3(off[0] + Math.cos(th) * (r + 0.25), 0, off[1] + Math.sin(th) * (r + 0.25));
          lathe(B.gb('white'), [[0.02, y + 0.4], [0.28, y + 1.2], [0.28, y + 3.2], [0.02, y + 3.6]], { segments: 16, offset: [c.x, c.z] });
        }
        for (let s = 0; s < 3; s++) jointRing(B.gb('white'), r, y + L * (0.2 + s * 0.3), 0.12, 0.03, off);
      } else {
        const prof: Profile = [[r, y], [rt, y + L]];
        if (sec.label) skin(prof, { ...a, livery: 1, livY0: y, livY1: y + L }, { livery: labelTex('name', sec.label) });
        else skin(prof);
        jointRing(B.gb(sec.material, { color: col }), r, y + 0.03, 0.06, Math.max(0.008, r * 0.006), off, a);
        if (style === 'gridfin_mount') {
          // grid-fin actuator housings + cold-gas thruster pods
          for (let i = 0; i < 4; i++) {
            const th = (i * Math.PI) / 2;
            box(B.gb('black_carbon'), 0.18, 0.7, 0.5, radialFrame(th, r + 0.09, y + L - 1.6, off));
          }
          for (const th of [Math.PI / 4, Math.PI / 4 + Math.PI]) {
            box(B.gb('grey'), 0.35, 0.5, 0.55, radialFrame(th, r + 0.17, y + L - 0.8, off));
          }
        }
      }
      break;
    }
    case 'thrust': {
      const prof: Profile = [[r, y], [rt, y + L]];
      if (style === 'saturn_aft') {
        skin(prof);
        // engine fairings around the outboard engines + fin roots
        for (let i = 0; i < 4; i++) {
          const th = Math.PI / 4 + (i * Math.PI) / 2;
          const cx = off[0] + Math.cos(th) * (r + 0.1), cz = off[1] + Math.sin(th) * (r + 0.1);
          lathe(B.gb('white'), [[1.25, y - 0.6], [1.25, y + 0.6], [0.9, y + 3.0], [0.25, y + 5.6], [0.02, y + 5.9]], { segments: 32, offset: [cx, cz], capBottom: true });
        }
      } else if (style === 'aerospike_base') {
        skin(prof, a, { material: 'tiles' });
        // annular aerospike plug below the base
        lathe(B.gb('soot', { key: 'plug' }), [[r * 0.93, y], [r * 0.82, y - 0.6], [r * 0.6, y - 1.6], [r * 0.38, y - 2.4], [r * 0.3, y - 2.6], [0, y - 2.62]], { segments: segs, offset: off });
        // combustion chamber ring
        lathe(B.gb('steel', { key: 'ring' }), [[r * 0.98, y + 0.02], [r * 1.0, y - 0.25], [r * 0.9, y - 0.3], [r * 0.9, y + 0.02]], { segments: segs, offset: off });
      } else if (ship || style === 'ship_aft' || style === 'superheavy_aft') {
        skin(prof);
        // aft chines / engine shielding skirt
        for (const th of [0, Math.PI]) box(B.gb('steel'), 0.35, L * 0.9, 0.25, radialFrame(th, r + 0.15, y + L * 0.5, off));
      } else if (style === 'soyuz_tail') {
        skin([[r * 1.35, y], [r * 1.18, y + L * 0.35], [rt, y + L]]);
      } else if (style === 'srb_aft_skirt') {
        skin([[r, y], [rt * 1.08, y + L * 0.7], [rt, y + L]]);
        for (let i = 0; i < 4; i++) box(B.hardware(), 0.2, 0.5, 0.4, radialFrame((i * Math.PI) / 2, r * 0.95, y + 0.3, off));
      } else {
        if (sec.label) skin(prof, { ...a, livery: 1, livY0: y, livY1: y + L }, { livery: labelTex('name', sec.label) });
        else skin(prof);
      }
      // base heat shield
      const shieldR = Math.min(r, rt) * 0.985;
      lathe(B.gb('soot', { key: 'baseshield' }), [[0, y + 0.06], [shieldR, y + 0.06]], { segments: segs, offset: off });
      if (style === 'octaweb' || style === 'cbc_aft' || style === 'vulcain_aft') {
        lathe(B.gb('soot', { key: 'skirt' }), [[r * 1.002, y], [r * 1.002, y + Math.min(0.5, L * 0.25)]], { segments: segs, offset: off });
      }
      break;
    }
    case 'nose': {
      let prof: Profile;
      if (sec.shape === 'starship') {
        const cyl = L * 0.18;
        prof = [[r, y], [r, y + cyl], ...ogiveProfile(r, L - cyl, y + cyl, 28, r * 0.22).slice(1)];
      } else if (sec.shape === 'cone') {
        prof = [[r, y], [r * 0.12, y + L * 0.97], [r * 0.05, y + L], [0, y + L + r * 0.02]];
      } else {
        prof = ogiveProfile(r, L, y, 28, Math.max(0.02, r * 0.04));
      }
      skin(prof);
      break;
    }
    case 'fairing': {
      const half = style === 'half_a' ? 1 : style === 'half_b' ? -1 : 0;
      const tr = sec.topRadius ?? 0;
      let prof: Profile;
      const pr = B.parentRadius;
      const boat = half && pr > 0 && r > pr * 1.05 ? Math.min(L * 0.12, (r - pr) * 1.8) : 0;
      if (style === 'esm_panels') prof = [[r, y], [r, y + L]];
      else if (style === 'bpc' || sec.shape === 'cone') {
        const cyl = style === 'bpc' ? 0 : L * 0.35;
        prof = [[r, y], [r, y + cyl], [Math.max(tr, 0.03), y + L]];
      } else {
        const cyl = tr > 0 ? 0 : L * 0.42;
        const og = ogiveProfile(r - tr, L - cyl - boat, 0, 28, 0).map(([rr, yy]) => [rr + tr, y + boat + cyl + yy] as [number, number]);
        prof = [...(boat ? [[pr, y] as [number, number]] : []), [r, y + boat], [r, y + boat + cyl], ...og.slice(1)];
        if (tr <= 0) prof[prof.length - 1] = [0, prof[prof.length - 1][1]];
        else prof.push([0, prof[prof.length - 1][1]]);
      }
      const tex = half ? labelTex('fairing') : null;
      const th0 = half > 0 ? -Math.PI / 2 : Math.PI / 2;
      skin(prof, { ...a, livery: tex ? 1 : 0, livY0: y, livY1: y + L }, half ? { livery: tex, double: true, thetaStart: th0, thetaLength: Math.PI } : {});
      if (half) {
        // separation rail along both split edges
        for (const th of [th0 + 0.002, th0 + Math.PI - 0.002]) {
          for (let i = 0; i < prof.length - 1; i++) {
            const [r0, y0] = prof[i], [r1, y1] = prof[i + 1];
            if (r0 < 0.05 && r1 < 0.05) continue;
            tube(B.hardware(), new Vector3(off[0] + Math.cos(th) * r0, y0, off[1] + Math.sin(th) * r0), new Vector3(off[0] + Math.cos(th) * r1, y1, off[1] + Math.sin(th) * r1), 0.025, 6);
          }
        }
        // inner acoustic blanket (visible after separation)
        lathe(B.gb('insulation_white', { double: true, key: 'inner' }), prof.map(([rr, yy]) => [Math.max(0, rr - 0.04), yy] as [number, number]), { segments: segs / 2, thetaStart: th0, thetaLength: Math.PI, offset: off, inward: true });
      }
      if (style === 'orion_las' || style === 'bpc') {
        // escape-tower attach ring at the top
        jointRing(B.hardware(), Math.max(tr, 0.3), y + L - 0.05, 0.1, 0.04, off);
      }
      break;
    }
    case 'capsule': buildCapsule(B, sec); break;
    case 'service': {
      if (style === 'soyuz_om') {
        const prof: Profile = [[r * 0.45, y], [r * 0.85, y + L * 0.12], [r, y + L * 0.38], [r, y + L * 0.62], [r * 0.85, y + L * 0.88], [r * 0.4, y + L], [0, y + L]];
        skin(prof);
        // docking probe
        lathe(B.metal(), [[0.3, y + L], [0.25, y + L + 0.25], [0.06, y + L + 0.45], [0.02, y + L + 0.7], [0, y + L + 0.72]], { segments: 20, offset: off });
      } else if (style === 'soyuz_sm') {
        skin([[r * 1.12, y], [r * 1.12, y + L * 0.5], [r, y + L * 0.62], [r * 0.95, y + L]]);
        // instrument-compartment radiator panels
        for (let i = 0; i < 8; i++) box(B.gb('white'), 0.04, L * 0.4, 0.7, radialFrame((i / 8) * Math.PI * 2, r * 1.12 + 0.02, y + L * 0.25, off));
      } else if (style === 'apollo_sm') {
        skin([[r, y], [r, y + L]], { ...a, panel: 0.6 });
        // radiator panels (white) and RCS quads
        for (let i = 0; i < 6; i++) box(B.gb('white'), 0.02, L * 0.55, 1.1, radialFrame((i / 6) * Math.PI * 2 + 0.2, r + 0.01, y + L * 0.55, off));
        for (let i = 0; i < 4; i++) {
          const th = (i * Math.PI) / 2 + Math.PI / 4;
          box(B.gb('aluminium'), 0.45, 0.8, 0.8, radialFrame(th, r + 0.22, y + L * 0.62, off));
          for (const dy of [-0.5, 0.5]) tube(B.hardware(), new Vector3(off[0] + Math.cos(th) * (r + 0.3), y + L * 0.62 + dy * 0.5, off[1] + Math.sin(th) * (r + 0.3)), new Vector3(off[0] + Math.cos(th) * (r + 0.3), y + L * 0.62 + dy * 1.1, off[1] + Math.sin(th) * (r + 0.3)), 0.06, 8);
        }
        // high-gain antenna on a boom
        const hb = new Vector3(off[0] + r * 0.7, y + 0.1, off[1]);
        tube(B.hardware(), hb, hb.clone().add(new Vector3(0.8, -1.4, 0)), 0.05, 8);
        for (const [dx, dz] of [[0.35, 0.35], [-0.35, 0.35], [0.35, -0.35], [-0.35, -0.35]]) {
          lathe(B.gb('white', { double: true, key: 'dish' }), [[0, -0.15], [0.25, -0.1], [0.38, 0.02]].map(([rr, yy]) => [rr, y + yy - 1.5] as [number, number]), { segments: 16, offset: [off[0] + r * 0.7 + 0.8 + dx, off[1] + dz] });
        }
      } else if (style === 'orion_esm') {
        skin([[r, y], [r, y + L]]);
        for (let i = 0; i < 8; i++) box(B.gb('white'), 0.03, L * 0.5, 0.5, radialFrame((i / 8) * Math.PI * 2, r + 0.015, y + L * 0.55, off));
      } else {
        skin([[r, y], [rt, y + L]]);
      }
      break;
    }
    case 'lander': buildLander(B, sec); break;
    case 'payload': buildPayload(B, sec); break;
    case 'les': buildLes(B, sec); break;
    case 'srb': {
      const prof: Profile = [[r, y], [r, y + L]];
      skin(prof, { ...a, livery: 1, livY0: y, livY1: y + L }, { livery: labelTex('srb') });
      const segsN = Math.max(2, Math.round(L / 7));
      for (let i = 1; i < segsN; i++) jointRing(B.gb('white'), r, y + (i * L) / segsN, 0.22, 0.035, off);
      break;
    }
    case 'probe': buildProbe(B, sec); break;
    case 'kick': {
      if (style === 'star48') {
        const R = r * 0.98;
        const prof: Profile = [];
        for (let i = 0; i <= 16; i++) { const t = -Math.PI / 2 + (i / 16) * Math.PI; prof.push([Math.max(0.0, Math.cos(t) * R), y + L / 2 + Math.sin(t) * L * 0.5]); }
        prof[0][0] = 0; prof[prof.length - 1][0] = 0;
        skin(prof, a, { material: 'black_carbon' });
        jointRing(B.metal(), R * 0.92, y + L * 0.5, 0.12, 0.04, off);
      } else skin([[r, y], [rt, y + L]]);
      break;
    }
    case 'ship':
    default:
      skin([[r, y], [rt, y + L]]);
  }
  void index;
}

function buildCapsule(B: AssemblyBuild, sec: SectionDef): void {
  const off = B.off;
  const r = sec.radius, y = sec.y, L = sec.length;
  const shape = sec.shape ?? 'apollo';
  const segs = segFor(r);
  const a = attrsFor(sec, { soot: 0.4 });
  let body: Profile;
  let shield: Profile;
  if (shape === 'soyuz') {
    shield = [[0, y], [r * 0.6, y + 0.04], [r * 0.95, y + 0.12]];
    body = [[r * 0.95, y + 0.12], [r, y + 0.28], [r * 0.99, y + L * 0.32], [r * 0.9, y + L * 0.55], [r * 0.72, y + L * 0.78], [r * 0.48, y + L * 0.95], [r * 0.4, y + L]];
  } else {
    // Apollo / Orion: spherical-section heat shield, toroidal shoulder, 32.5 deg conical back shell
    const depth = r * 0.16;
    shield = [];
    for (let i = 0; i <= 10; i++) { const t = i / 10; shield.push([r * 0.97 * Math.sin((t * Math.PI) / 2), y + depth * (1 - Math.cos((t * Math.PI) / 2))]); }
    const sh = r * 0.04;
    const coneTop = Math.max(0.35, r * 0.24);
    const coneLen = L - depth - sh - 0.35;
    body = [[r * 0.97, y + depth], [r, y + depth + sh], [coneTop, y + depth + sh + coneLen], [coneTop * 0.95, y + depth + sh + coneLen + 0.02], [coneTop * 0.95, y + L], [0, y + L]];
  }
  lathe(B.gb('cork', { heatShield: true, key: 'shield' }), shield, { segments: segs, offset: off, attrs: { ...a, soot: 0 } });
  lathe(B.gb(sec.material, { key: 'capsule' }), body, { segments: segs, offset: off, attrs: a });
  // windows (dark glass) + hatch outline + RCS doublets
  const winR = Math.max(0.12, r * 0.1);
  const glass = B.gb('black_carbon', { key: 'glass' });
  const yWin = y + L * (shape === 'soyuz' ? 0.42 : 0.42);
  const rAt = (yy: number) => {
    for (let i = 0; i < body.length - 1; i++) if (yy >= body[i][1] && yy <= body[i + 1][1]) {
      const t = (yy - body[i][1]) / Math.max(1e-6, body[i + 1][1] - body[i][1]);
      return body[i][0] + (body[i + 1][0] - body[i][0]) * t;
    }
    return r * 0.6;
  };
  for (const th of [0.4, -0.4, Math.PI * 0.5, Math.PI - 0.4, Math.PI + 0.4]) {
    const rr = rAt(yWin);
    const m = radialFrame(th, rr + 0.005, yWin, off);
    // tilt with the cone
    const tilt = new Matrix4().makeRotationZ(shape === 'soyuz' ? 0 : -0.57);
    box(glass, 0.02, winR * 1.4, winR * 1.4, m.multiply(tilt));
  }
  for (let i = 0; i < 6; i++) {
    const th = (i / 6) * Math.PI * 2 + 0.5;
    const yy = y + L * 0.62;
    box(B.hardware(), 0.08, 0.14, 0.22, radialFrame(th, rAt(yy) + 0.02, yy, off));
  }
  // docking ring / forward hatch
  lathe(B.metal(), [[0.42, y + L], [0.42, y + L + 0.18], [0.36, y + L + 0.22], [0, y + L + 0.22]], { segments: 32, offset: off });
  // livery band
  B.vis.chuteAnchorY = y + L;
}

function buildLander(B: AssemblyBuild, sec: SectionDef): void {
  const off = B.off;
  const r = sec.radius, y = sec.y, L = sec.length;
  const style = sec.style ?? '';
  const a = attrsFor(sec, { soot: 0.8 });
  if (style === 'lm_ascent') {
    lathe(B.gb('silver_foil'), [[r * 0.75, y], [r, y + L * 0.2], [r * 0.95, y + L * 0.7], [r * 0.55, y + L * 0.95], [0, y + L]], { segments: 7, offset: off, attrs: a });
    // forward hatch, windows, docking tunnel, antennas
    box(B.gb('black_carbon', { key: 'glass' }), 0.05, 0.5, 0.45, radialFrame(0.3, r * 0.97, y + L * 0.62, off));
    box(B.gb('black_carbon', { key: 'glass' }), 0.05, 0.5, 0.45, radialFrame(-0.3, r * 0.97, y + L * 0.62, off));
    lathe(B.metal(), [[0.45, y + L - 0.05], [0.45, y + L + 0.35], [0, y + L + 0.35]], { segments: 20, offset: off });
    tube(B.hardware(), new Vector3(off[0] - r * 0.4, y + L * 0.9, off[1]), new Vector3(off[0] - r * 0.4, y + L + 1.2, off[1] + 0.4), 0.03, 6);
    lathe(B.gb('white', { double: true, key: 'dish' }), [[0, y + L + 1.2], [0.3, y + L + 1.25], [0.45, y + L + 1.38]], { segments: 18, offset: [off[0] - r * 0.4, off[1] + 0.4] });
  } else {
    // octagonal descent stage in gold MLI with black panels between the leg bays
    lathe(B.gb('gold_foil'), [[r * 0.92, y + 0.2], [r * 0.92, y + L * 0.85]], { segments: 8, thetaStart: Math.PI / 8, offset: off, attrs: a, capBottom: true });
    lathe(B.gb('black_carbon'), [[r * 0.93, y + L * 0.85], [r * 0.6, y + L], [0, y + L]], { segments: 8, thetaStart: Math.PI / 8, offset: off, attrs: a });
    if (style === 'lm_folded') {
      // ascent stage visible above (folded LM inside the adapter)
      lathe(B.gb('silver_foil', { key: 'asc' }), [[r * 0.65, y + L * 0.85], [r * 0.8, y + L * 0.95], [r * 0.6, y + L * 1.25], [0, y + L * 1.3]], { segments: 7, offset: off, attrs: a });
    }
  }
}

function buildPayload(B: AssemblyBuild, sec: SectionDef): void {
  const off = B.off;
  const r = sec.radius, y = sec.y, L = sec.length;
  const style = sec.style ?? 'comsat';
  const a = attrsFor(sec, { soot: 0.1 });
  // payload adapter cone
  lathe(B.gb('black_carbon', { key: 'pa' }), [[r * 0.9, y], [r * 0.6, y + 0.35], [r * 0.55, y + 0.45]], { segments: 48, offset: off, attrs: a });
  const by = y + 0.45, bh = L * 0.75;
  const bw = r * 1.15;
  if (style === 'spysat') {
    lathe(B.gb('silver_foil'), [[r * 0.85, by], [r * 0.85, by + bh], [r * 0.8, by + bh + 0.1]], { segments: 48, offset: off, attrs: a, capBottom: true });
    lathe(B.gb('black_carbon', { key: 'ap' }), [[r * 0.8, by + bh + 0.1], [r * 0.7, by + bh + 0.3], [0, by + bh + 0.35]], { segments: 48, offset: off, attrs: a });
  } else {
    box(B.gb('gold_foil'), bw, bh, bw, new Matrix4().makeTranslation(off[0], by + bh / 2, off[1]), a);
    // radiator panels (white) on two faces
    box(B.gb('white', { key: 'rad' }), 0.02, bh * 0.8, bw * 0.8, new Matrix4().makeTranslation(off[0] + bw / 2 + 0.01, by + bh / 2, off[1]));
    box(B.gb('white', { key: 'rad' }), 0.02, bh * 0.8, bw * 0.8, new Matrix4().makeTranslation(off[0] - bw / 2 - 0.01, by + bh / 2, off[1]));
    // antenna dishes (stowed against the bus)
    const dishR = Math.min(r * 0.9, L * 0.35);
    if (style === 'comsat' || style === 'gps_sat') {
      for (const s of [1, -1]) {
        const c = new Vector3(off[0], by + bh * 0.55, off[1] + s * (bw / 2 + 0.25));
        const g = new GeoBuilder();
        const prof: Profile = [];
        for (let i = 0; i <= 8; i++) { const t = i / 8; prof.push([dishR * t, dishR * 0.18 * t * t]); }
        lathe(g, prof, { segments: 32 });
        const m = new Matrix4().makeRotationX(s * Math.PI / 2).setPosition(c);
        const dg = B.gb('white', { double: true, key: 'dish' });
        dg.merge(g, m);
      }
    }
    // omni antenna + thruster nozzles on top
    tube(B.hardware(), new Vector3(off[0], by + bh, off[1]), new Vector3(off[0], by + bh + 0.6, off[1]), 0.03, 6);
    lathe(B.metal(), [[0, by + bh + 0.6], [0.12, by + bh + 0.65], [0, by + bh + 0.75]], { segments: 12, offset: off });
  }
  const sp = B.asm.features?.solarPanels;
  if (sp) {
    const cell = createSkin({ style: 'black_carbon', state: B.vis.state, color: [0.02, 0.025, 0.07] });
    cell.metalness = 0.4; cell.roughness = 0.25;
    const frame = createHardware([0.7, 0.7, 0.72], 0.8, 0.4);
    const pv = buildSolarArrays(sp.span, sp.style, { y: sp.y, radius: bw / 2 }, cell, frame);
    pv.group.position.set(off[0], 0, off[1]);
    B.vis.group.add(pv.group);
    B.vis.panels = pv;
  }
}

function buildLes(B: AssemblyBuild, sec: SectionDef): void {
  const off = B.off;
  const r = sec.radius, y = sec.y, L = sec.length;
  const style = sec.style ?? '';
  const hw = B.hardware();
  if (style === 'apollo_les') {
    // truss from the boost cover up to the escape motor
    const trussH = L * 0.32;
    const rb = 0.62, rtop = 0.32;
    for (let i = 0; i < 4; i++) {
      const th = (i * Math.PI) / 2 + Math.PI / 4;
      const p0 = new Vector3(off[0] + Math.cos(th) * rb, y, off[1] + Math.sin(th) * rb);
      const p1 = new Vector3(off[0] + Math.cos(th) * rtop, y + trussH, off[1] + Math.sin(th) * rtop);
      tube(B.gb('grey', { key: 'truss' }), p0, p1, 0.05, 8);
      const th2 = th + Math.PI / 2;
      const p2 = new Vector3(off[0] + Math.cos(th2) * rtop, y + trussH, off[1] + Math.sin(th2) * rtop);
      tube(B.gb('grey', { key: 'truss' }), p0, p2, 0.035, 6);
    }
    const my = y + trussH;
    lathe(B.gb('white', { key: 'motor' }), [[rtop, my], [r * 0.55, my + 0.4], [r * 0.55, my + L * 0.45], [r * 0.4, my + L * 0.55], [0.12, my + L * 0.66], [0.04, my + L * 0.68 - 0.02], [0, my + L * 0.68]], { segments: 32, offset: off });
    // canted escape nozzles
    for (let i = 0; i < 4; i++) {
      const th = (i * Math.PI) / 2;
      const c = new Vector3(off[0] + Math.cos(th) * 0.3, my + 0.25, off[1] + Math.sin(th) * 0.3);
      tube(hw, c, c.clone().add(new Vector3(Math.cos(th) * 0.25, -0.35, Math.sin(th) * 0.25)), 0.08, 10);
    }
    // canards / Q-ball nose
    for (let i = 0; i < 2; i++) box(B.gb('white', { key: 'motor' }), 0.02, 0.4, 0.3, radialFrame(i * Math.PI, 0.2, my + L * 0.55, off));
  } else if (style === 'orion_tower') {
    lathe(B.gb('white', { key: 'tower' }), [[r, y], [r, y + L * 0.7], [rt(sec), y + L * 0.92], [0.05, y + L], [0, y + L + 0.05]], { segments: 40, offset: off });
    for (let i = 0; i < 4; i++) {
      const th = (i * Math.PI) / 2 + Math.PI / 4;
      const c = new Vector3(off[0] + Math.cos(th) * r * 0.9, y + L * 0.18, off[1] + Math.sin(th) * r * 0.9);
      lathe(B.gb('soot', { key: 'noz' }), [[0.22, -0.4], [0.12, 0], [0.13, 0.1]].map(([rr, yy]) => [rr, c.y + yy] as [number, number]), { segments: 16, offset: [c.x + Math.cos(th) * 0.1, c.z + Math.sin(th) * 0.1] });
    }
  } else {
    // simple escape tower: cylinder, cone, small nozzle ring
    lathe(B.gb(sec.material, { key: 'tower' }), [[r, y], [r, y + L * 0.6], [0.06, y + L], [0, y + L]], { segments: 32, offset: off });
    for (let i = 0; i < 6; i++) {
      const th = (i / 6) * Math.PI * 2;
      box(hw, 0.12, 0.25, 0.12, radialFrame(th, r * 1.02, y + L * 0.12, off));
    }
  }
}

function rt(sec: SectionDef): number { return sec.topRadius ?? sec.radius; }

function buildProbe(B: AssemblyBuild, sec: SectionDef): void {
  const off = B.off;
  const r = sec.radius, y = sec.y, L = sec.length;
  const style = sec.style ?? '';
  const a = attrsFor(sec, { soot: 0.1 });
  const sides = style === 'flyby_probe' ? 3 : 6;
  lathe(B.gb('gold_foil'), [[r * 0.9, y], [r * 0.9, y + L * 0.55]], { segments: sides, offset: off, attrs: a, capBottom: true });
  lathe(B.gb('black_carbon', { key: 'top' }), [[r * 0.9, y + L * 0.55], [r * 0.85, y + L * 0.58], [0, y + L * 0.58]], { segments: sides, offset: off, attrs: a });
  // high-gain antenna
  const dishR = style === 'flyby_probe' ? r * 1.0 : r * 1.25;
  const prof: Profile = [];
  for (let i = 0; i <= 10; i++) { const t = i / 10; prof.push([dishR * t, y + L * 0.62 + dishR * 0.22 * t * t]); }
  lathe(B.gb('white', { double: true, key: 'hga' }), prof, { segments: 48, offset: off });
  tube(B.hardware(), new Vector3(off[0], y + L * 0.62, off[1]), new Vector3(off[0], y + L * 0.62 + dishR * 0.5, off[1]), 0.04, 6);
  if (style === 'flyby_probe') {
    // radioisotope generator on a boom
    const p0 = new Vector3(off[0] + r * 0.8, y + L * 0.2, off[1]);
    const p1 = p0.clone().add(new Vector3(1.4, 0.1, 0.3));
    tube(B.hardware(), p0, p1, 0.04, 6);
    lathe(B.gb('soot', { key: 'rtg' }), [[0.18, -0.55], [0.18, 0.55]].map(([rr, yy]) => [rr, p1.y + yy] as [number, number]), { segments: 12, offset: [p1.x, p1.z], capBottom: true, capTop: true });
    for (let i = 0; i < 8; i++) box(B.gb('soot', { key: 'rtg' }), 0.25, 1.0, 0.02, radialFrame((i / 8) * Math.PI * 2, 0.24, p1.y, [p1.x, p1.z]));
  }
  const sp = B.asm.features?.solarPanels;
  if (sp) {
    const cell = createSkin({ style: 'black_carbon', state: B.vis.state, color: [0.02, 0.025, 0.08] });
    cell.metalness = 0.4; cell.roughness = 0.25;
    const frame = createHardware([0.7, 0.7, 0.72], 0.8, 0.4);
    const pv = buildSolarArrays(sp.span, sp.style, { y: sp.y, radius: r * 0.9 }, cell, frame);
    pv.group.position.set(off[0], 0, off[1]);
    B.vis.group.add(pv.group);
    B.vis.panels = pv;
  }
}

// ===================================================================================== features

function pivotFrame(theta: number, radius: number, y: number, off: [number, number]): Group {
  const g = new Group();
  const X = new Vector3(Math.sin(theta), 0, -Math.cos(theta));
  const Y = new Vector3(0, 1, 0);
  const Z = new Vector3(Math.cos(theta), 0, Math.sin(theta));
  const m = new Matrix4().makeBasis(X, Y, Z);
  g.quaternion.setFromRotationMatrix(m);
  g.position.set(off[0] + Z.x * radius, y, off[1] + Z.z * radius);
  return g;
}

function buildFeatures(B: AssemblyBuild): void {
  const f = B.asm.features;
  const off = B.off;
  if (!f) return;
  const radiusAt = (y: number) => {
    let best = B.vis.radius;
    for (const s of B.asm.sections) if (y >= s.y && y <= s.y + s.length) {
      const t = (y - s.y) / s.length;
      best = s.radius + ((s.topRadius ?? s.radius) - s.radius) * t;
    }
    return best;
  };
  if (f.gridFins) {
    const mat = createHardware([0.32, 0.3, 0.29], 0.85, 0.42);
    const r = radiusAt(f.gridFins.y);
    for (let i = 0; i < 4; i++) {
      const th = (i * Math.PI) / 2;
      const pivot = pivotFrame(th, r + 0.05, f.gridFins.y - f.gridFins.size * 0.9, off);
      const fin = buildGridFin(f.gridFins.size, mat);
      fin.position.set(0, 0, f.gridFins.size * 0.08);
      pivot.add(fin);
      B.vis.group.add(pivot);
      B.vis.gridFins.push({ pivot, axis: new Vector3(1, 0, 0), stowed: 0, deployed: Math.PI / 2 });
    }
  }
  if (f.landingLegs) {
    const L = f.landingLegs;
    const r = radiusAt(L.y);
    const carbon = createSkin({ style: 'black_carbon', state: B.vis.state });
    const metal = createHardware([0.55, 0.55, 0.57], 0.9, 0.35);
    for (let i = 0; i < L.count; i++) {
      const th = (i / L.count) * Math.PI * 2 + Math.PI / L.count;
      const pivot = pivotFrame(th, r + 0.02, L.y, off);
      const leg = buildLeg(f.legsLunar ? L.length : L.length * 0.96, r, carbon, metal, !!f.legsLunar);
      pivot.add(leg);
      B.vis.group.add(pivot);
      if (f.legsLunar) {
        B.vis.legs.push({ pivot, axis: new Vector3(1, 0, 0), stowed: 0, deployed: 0 });
      } else {
        // deployed angle chosen so the footpads land where the physics contact points are
        const reach = B.vis.radius + L.length * 0.72;
        const foot = L.y - L.length * 0.62;
        const ang = Math.PI - Math.atan2(reach - r, L.y - foot);
        B.vis.legs.push({ pivot, axis: new Vector3(1, 0, 0), stowed: 0, deployed: ang });
      }
    }
  }
  if (f.flaps) {
    const yTop = B.vis.yMax, yBot = B.vis.yMin;
    const r = B.vis.radius;
    const steel = createSkin({ style: 'steel', state: B.vis.state });
    const tiles = createSkin({ style: 'tiles', state: B.vis.state });
    const mk = (th: number, y: number, span: number, chord: number, aft: boolean) => {
      const pivot = pivotFrame(th, radiusAt(y) - 0.05, y, off);
      const flap = buildFlap(span, chord, 0.35, aft ? tiles : steel);
      flap.rotation.y = -Math.PI / 2; // span along radial
      pivot.add(flap);
      B.vis.group.add(pivot);
      (aft ? B.vis.flapsAft : B.vis.flapsFwd).push({ pivot, axis: new Vector3(0, 1, 0), stowed: 0, deployed: 0 });
    };
    for (const th of [0, Math.PI]) {
      mk(th, yTop - (yTop - yBot) * 0.28, r * 0.75, (yTop - yBot) * 0.16, false);
      mk(th, yBot + 1.0, r * 1.0, (yTop - yBot) * 0.22, true);
    }
  }
  if (f.finArea && !f.flaps) {
    const per = f.finArea / 4;
    const root = Math.sqrt(per) * 1.7;
    const span = per / (root * 0.7);
    const yb = B.vis.yMin + B.asm.engines.reduce((m, e) => Math.max(m, 0), 0);
    const base = Math.max(B.asm.sections[0]?.y ?? 0, 0);
    const r = radiusAt(base + 0.5);
    for (let i = 0; i < 4; i++) {
      const th = Math.PI / 4 + (i * Math.PI) / 2;
      const gb = B.gb(B.asm.sections[0]?.material === 'grey' ? 'grey' : 'white', { key: 'fins' });
      const fg = new GeoBuilder();
      // trapezoid in the (radial, y) plane, thickness along tangent
      const steps = 4;
      for (let k = 0; k < steps; k++) {
        const s0 = (k / steps) * span, s1 = ((k + 1) / steps) * span;
        const c = root * (1 - 0.45 * ((s0 + s1) / 2) / span);
        const sweep = ((s0 + s1) / 2) * 0.5;
        box(fg, s1 - s0 + 0.01, c, Math.max(0.06, root * 0.04), new Matrix4().makeTranslation(r + (s0 + s1) / 2, base + c / 2 + sweep - 0.3, 0));
      }
      gb.merge(fg, new Matrix4().makeRotationY(-th).setPosition(off[0], 0, off[1]));
    }
    void yb;
  }
  if (f.parachutes) {
    const P = f.parachutes;
    const orange = createHardware([0.9, 0.3, 0.05], 0, 0.85, true);
    const white = createHardware([0.92, 0.92, 0.9], 0, 0.85, true);
    const line = createHardware([0.8, 0.78, 0.7], 0, 0.9);
    for (let i = 0; i < P.drogues; i++) {
      const c = buildChute(P.drogueDiameter, P.drogueDiameter * 2.2, orange, white, line);
      c.group.position.set(off[0], P.y, off[1]);
      B.vis.group.add(c.group);
      B.vis.drogues.push(c);
    }
    for (let i = 0; i < P.mains; i++) {
      const c = buildChute(P.mainDiameter, P.mainDiameter * 1.4, orange, white, line);
      c.group.position.set(off[0], P.y, off[1]);
      B.vis.group.add(c.group);
      B.vis.mains.push(c);
    }
  }
}

/** Strut attachments for strap-on boosters (between the booster and the core). */
function buildBoosterStruts(B: AssemblyBuild): void {
  const o = B.asm.offset;
  if (!o || (Math.abs(o[0]) < 1e-3 && Math.abs(o[1]) < 1e-3)) return;
  if (B.asm.separation?.kind !== 'radial') return;
  const d = Math.hypot(o[0], o[1]);
  const dir = new Vector3(-o[0] / d, 0, -o[1] / d);
  const rb = B.vis.radius;
  const rc = Math.max(0.3, B.parentRadius);
  const gap = d - rb - rc;
  if (gap < 0.02) return;
  const ys = [B.asm.sections[0].y + 1.2, B.vis.yMax - Math.max(2, (B.vis.yMax - B.vis.yMin) * 0.12)];
  for (const yy of ys) {
    const p0 = new Vector3(o[0], yy, o[1]).addScaledVector(dir, rb);
    const p1 = new Vector3(o[0], yy, o[1]).addScaledVector(dir, rb + gap + 0.05);
    tube(B.hardware(), p0, p1, Math.max(0.06, rb * 0.08), 10);
    const side = new Vector3(-dir.z, 0, dir.x);
    tube(B.hardware(), p0.clone().addScaledVector(side, rb * 0.3), p1, Math.max(0.04, rb * 0.05), 8);
    tube(B.hardware(), p0.clone().addScaledVector(side, -rb * 0.3), p1, Math.max(0.04, rb * 0.05), 8);
  }
}

// ===================================================================================== entry

export function buildVehicleVisual(def: VehicleDef): VehicleVisual {
  const assemblies = new Map<string, AssemblyVisual>();
  const byId = new Map(def.assemblies.map((a) => [a.id, a]));
  const topRadius = (a: AssemblyDef | undefined): number => {
    if (!a || !a.sections.length) return 0;
    const s = a.sections[a.sections.length - 1];
    return s.topRadius ?? s.radius;
  };
  // vehicles without explicit markings get the name painted on the longest tank of each
  // first-stage-class assembly (core and strap-ons)
  const labelled = new Set<SectionDef>();
  if (!def.assemblies.some((a) => a.sections.some((s) => s.label))) {
    for (const a of def.assemblies) {
      if (a.parent !== null && a.separation?.kind !== 'radial') continue;
      let best: SectionDef | null = null;
      for (const s of a.sections) if ((s.kind === 'tank' || s.kind === 'srb') && (!best || s.length > best.length)) best = s;
      if (best && best.kind === 'tank' && best.length > best.radius * 3) labelled.add(best);
    }
  }
  let height = 0;
  for (const asmDef0 of def.assemblies) {
    const asmDef: AssemblyDef = labelled.size ? { ...asmDef0, sections: asmDef0.sections.map((s) => (labelled.has(s) ? { ...s, label: def.livery.text } : s)) } : asmDef0;
    const parent = asmDef.parent ? byId.get(asmDef.parent) : undefined;
    const pr = asmDef.separation?.kind === 'radial' ? Math.max(...(parent?.sections.map((s) => s.radius) ?? [0])) : topRadius(parent);
    const B = new AssemblyBuild(def, asmDef, pr);
    asmDef.sections.forEach((s, i) => buildSection(B, s, i));
    buildFeatures(B);
    buildBoosterStruts(B);
    // engines: hide powerheads when buried inside a thrust section
    asmDef.engines.forEach((m, i) => {
      const inside = asmDef.sections.some((s) => (s.kind === 'thrust' || s.kind === 'srb' || s.kind === 'interstage') && m.pos[1] >= s.y - 0.01 && m.pos[1] <= s.y + s.length);
      const ev = buildEngine(m, i, B.vis.state, { hidePowerhead: inside && asmDef.parent === null });
      // engine mounts are relative to the assembly axis
      ev.pivot.position.x += B.off[0];
      ev.pivot.position.z += B.off[1];
      if (m.cant) {
        // nozzle canted outward from the vehicle axis (thrust line through the vehicle CoM)
        const ox = ev.pivot.position.x, oz = ev.pivot.position.z;
        const l = Math.hypot(ox, oz);
        if (l > 1e-3) {
          const desired = new Vector3((ox / l) * Math.sin(m.cant), -Math.cos(m.cant), (oz / l) * Math.sin(m.cant));
          ev.pivot.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), desired);
        }
      }
      ev.pivot.userData.baseQuat = ev.pivot.quaternion.clone();
      B.vis.engines.push(ev);
      B.vis.group.add(ev.pivot);
    });
    const vis = B.finish();
    assemblies.set(asmDef.id, vis);
    height = Math.max(height, vis.yMax);
  }
  return { def, assemblies, height };
}

const _q = new Quaternion();
const _ax = new Vector3();

/** Set a hinged part to a deployment fraction 0..1 (with optional extra angle). */
export function setHinge(h: HingedPart, t: number, extra = 0): void {
  const e = t * t * (3 - 2 * t);
  const ang = h.stowed + (h.deployed - h.stowed) * e + extra;
  _ax.copy(h.axis);
  const base = h.pivot.userData.baseQuat as Quaternion | undefined;
  if (!base) h.pivot.userData.baseQuat = h.pivot.quaternion.clone();
  _q.setFromAxisAngle(_ax, ang);
  h.pivot.quaternion.copy(h.pivot.userData.baseQuat as Quaternion).multiply(_q);
}
