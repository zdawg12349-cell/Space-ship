import { Group, Matrix4, Mesh, MeshPhysicalMaterial, Vector3 } from 'three';
import type { EngineMount } from '../../vehicles/types';
import { bellProfile, box, GeoBuilder, lathe, tube } from './shapes';
import { AssemblyShaderState, createHardware, createSkin } from './VehicleMaterials';

/**
 * Moving / animated parts of vehicles: engines (gimballed nozzles with powerheads),
 * grid fins, landing legs, body flaps, solar arrays and parachutes.
 */

export interface EngineVisual {
  index: number;
  mount: EngineMount;
  pivot: Group;
  heat: { value: number };
  /** nozzle exit, local to the pivot */
  exitY: number;
  exitRadius: number;
  /** lateral chamber offsets (multi-chamber engines), metres in pivot space */
  chambers: [number, number][];
  /** verniers (small steering chambers) */
  verniers: [number, number][];
  kind: string;
}

export function chambersFor(mount: EngineMount): { chambers: [number, number][]; verniers: [number, number][] } {
  const n = mount.spec.name.toLowerCase();
  const re = mount.spec.exitRadius;
  if (n.includes('four-chamber')) {
    const d = re * 1.12;
    return { chambers: [[d, d], [-d, d], [d, -d], [-d, -d]], verniers: [[0, d * 2.1], [0, -d * 2.1]] };
  }
  if (n.includes('twin-chamber')) return { chambers: [[re * 1.08, 0], [-re * 1.08, 0]], verniers: [] };
  return { chambers: [[0, 0]], verniers: [] };
}

/** Engine: powerhead above the gimbal point, combustion chamber, throat and bell (one or more chambers). */
export function buildEngine(mount: EngineMount, index: number, state: AssemblyShaderState, opts: { hidePowerhead?: boolean } = {}): EngineVisual {
  const spec = mount.spec;
  const pivot = new Group();
  pivot.name = `engine-${index}`;
  pivot.position.set(mount.pos[0], mount.pos[1], mount.pos[2]);
  const heat = { value: 290 };
  const kind = spec.nozzle ?? 'regen';
  const { chambers, verniers } = chambersFor(mount);
  const re = spec.exitRadius;
  const L = spec.nozzleLength;
  const eps = kind === 'vacuum' ? 60 : kind === 'srb' ? 8 : kind === 'aerospike' ? 1 : 18;
  const rt = spec.throatRadius ?? Math.max(re / Math.sqrt(eps), re * 0.12);
  const outer = new GeoBuilder();
  const inner = new GeoBuilder();
  const ext = new GeoBuilder();
  const hw = new GeoBuilder();
  const segs = re > 1 ? 64 : re > 0.4 ? 40 : 24;
  const yThroat = -L * 0.12;
  const bellLen = L - Math.abs(yThroat);
  const buildChamber = (cx: number, cz: number, scale: number) => {
    const rtS = rt * scale, reS = re * scale, blS = bellLen * scale;
    const prof = bellProfile(rtS, reS, blS, yThroat * scale, kind === 'srb' ? 0.45 : 0.55, kind === 'srb' ? 0.24 : kind === 'vacuum' ? 0.1 : 0.16, 22);
    // split radiatively cooled extension (lower part)
    const splitIdx = spec.radiativeExtension ? Math.floor(prof.length * 0.42) : 0;
    const offset: [number, number] = [cx, cz];
    if (splitIdx > 0) {
      lathe(ext, prof.slice(0, splitIdx + 1), { segments: segs, offset });
      lathe(outer, prof.slice(splitIdx), { segments: segs, offset });
    } else {
      lathe(outer, prof, { segments: segs, offset });
    }
    // lip at the exit (thickness) and inner wall
    const lip = Math.max(0.01, reS * 0.025);
    const exitY = prof[0][1];
    lathe(splitIdx > 0 ? ext : outer, [[reS - lip, exitY], [reS, exitY]], { segments: segs, offset });
    lathe(inner, prof.map(([r, y]) => [Math.max(0.005, r - lip), y] as [number, number]), { segments: segs, inward: true, offset });
    // combustion chamber + injector dome
    const rc = rtS * (kind === 'srb' ? 1.1 : 1.65);
    const chamber: [number, number][] = [
      [rtS, yThroat * scale], [rc * 0.92, yThroat * scale + rtS * 0.7], [rc, yThroat * scale + rtS * 1.3], [rc, yThroat * scale + rtS * 1.3 + rc * 1.2],
      [rc * 0.7, yThroat * scale + rtS * 1.3 + rc * 1.55], [0, yThroat * scale + rtS * 1.3 + rc * 1.65],
    ];
    if (kind !== 'srb') lathe(outer, chamber, { segments: Math.max(16, segs / 2), offset });
    else lathe(hw, [[rtS * 1.6, yThroat * scale + rtS * 0.2], [rtS * 2.1, yThroat * scale + rtS * 0.9], [rtS * 2.1, yThroat * scale + rtS * 1.6], [0, yThroat * scale + rtS * 1.7]], { segments: 24, offset });
    // regen manifold torus-ish rings
    if (kind === 'regen' || kind === 'vacuum') {
      const yM = (prof[0][1] + prof[prof.length - 1][1]) * 0.55;
      const ringR = prof.find(([, y]) => y >= yM)?.[0] ?? reS * 0.7;
      lathe(hw, [[ringR + 0.012, yM - 0.03 * scale], [ringR + 0.03 * scale, yM], [ringR + 0.012, yM + 0.03 * scale]], { segments: segs, offset });
      if (kind === 'regen') {
        const yE = prof[1][1];
        lathe(hw, [[reS + 0.008, yE - 0.025 * scale], [reS + 0.025 * scale, yE], [reS + 0.008, yE + 0.03 * scale]], { segments: segs, offset });
      }
    }
    return exitY;
  };
  let exitY = 0;
  for (const [cx, cz] of chambers) exitY = Math.min(exitY, buildChamber(cx, cz, 1));
  for (const [cx, cz] of verniers) buildChamber(cx, cz, 0.32);

  // powerhead: turbopump, gas generator, ducts (only where visible: upper stages, ships)
  if (!opts.hidePowerhead && kind !== 'srb' && kind !== 'aerospike') {
    const top = yThroat + rt * 1.3 + rt * 1.65 * 1.65 + 0.02;
    const ph = Math.max(0.25, L * 0.42);
    const pr = Math.max(0.06, rt * 1.1);
    // turbopump body offset to one side
    lathe(hw, [[0, top], [pr, top], [pr, top + ph * 0.7], [pr * 0.6, top + ph * 0.8], [0, top + ph * 0.82]], { segments: 16, offset: [pr * 1.4, 0] });
    lathe(hw, [[0, top + ph * 0.1], [pr * 0.8, top + ph * 0.1], [pr * 0.8, top + ph * 0.6], [0, top + ph * 0.6]], { segments: 14, offset: [-pr * 1.2, pr * 0.6] });
    // gimbal block + actuators
    box(hw, rt * 1.6, ph * 0.25, rt * 1.6, new Matrix4().makeTranslation(0, top + ph * 0.12, 0));
    tube(hw, new Vector3(rt * 1.7, top + ph * 0.05, 0), new Vector3(rt * 2.4, top + ph * 0.75, 0.1), Math.max(0.02, rt * 0.16), 8);
    tube(hw, new Vector3(0, top + ph * 0.05, rt * 1.7), new Vector3(0.1, top + ph * 0.75, rt * 2.4), Math.max(0.02, rt * 0.16), 8);
    // ducts into the chamber
    tube(hw, new Vector3(pr * 1.4, top + ph * 0.2, 0), new Vector3(0, top - rt * 0.4, 0), Math.max(0.025, rt * 0.22), 10);
    tube(hw, new Vector3(-pr * 1.2, top + ph * 0.3, pr * 0.6), new Vector3(0, top - rt * 0.2, 0), Math.max(0.02, rt * 0.18), 10);
    // exhaust stub of the gas generator (dark)
    tube(hw, new Vector3(pr * 1.4, top + ph * 0.15, 0), new Vector3(pr * 2.2, exitY * 0.4, 0.05), Math.max(0.02, rt * 0.2), 10);
  }

  const tint = spec.nozzleTint ?? (kind === 'srb' ? [0.08, 0.075, 0.07] : kind === 'ablative' ? [0.35, 0.28, 0.2] : [0.32, 0.3, 0.28]);
  const mOuter = createSkin({ style: 'nozzle', state, color: tint as [number, number, number], heat });
  const mInner = createSkin({ style: 'nozzle_inner', state, heat });
  const mExt = createSkin({ style: 'extension', state, heat });
  const mHw = createHardware([0.18, 0.17, 0.16], 0.8, 0.45);
  const add = (gb: GeoBuilder, m: MeshPhysicalMaterial, cast = true) => {
    if (!gb.vertexCount) return;
    const mesh = new Mesh(gb.build(), m);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    pivot.add(mesh);
  };
  add(outer, mOuter);
  add(inner, mInner, false);
  add(ext, mExt);
  add(hw, mHw);
  return { index, mount, pivot, heat, exitY, exitRadius: re, chambers, verniers, kind };
}

// ------------------------------------------------------------------------------- grid fins

export interface HingedPart {
  pivot: Group;
  /** rotation axis (pivot local) and angles */
  axis: Vector3;
  stowed: number;
  deployed: number;
}

/** Titanium/aluminium lattice grid fin hinged at the body surface. */
export function buildGridFin(size: number, mat: MeshPhysicalMaterial): Group {
  const gb = new GeoBuilder();
  const w = size, h = size * 0.82, depth = size * 0.11, bar = size * 0.018;
  // frame
  box(gb, w, bar * 2.2, depth, new Matrix4().makeTranslation(0, 0, 0));
  box(gb, w, bar * 2.2, depth, new Matrix4().makeTranslation(0, h, 0));
  box(gb, bar * 2.2, h, depth, new Matrix4().makeTranslation(-w / 2, h / 2, 0));
  box(gb, bar * 2.2, h, depth, new Matrix4().makeTranslation(w / 2, h / 2, 0));
  // lattice (diagonal cells): lines x -/+ y = c clipped to the panel (Liang-Barsky)
  const n = 9;
  const clip = (px: number, py: number, dx: number, dy: number): [Vector3, Vector3] | null => {
    let t0 = -1e9, t1 = 1e9;
    const p = [-dx, dx, -dy, dy], q = [px + w / 2, w / 2 - px, py, h - py];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return null; continue; }
      const r = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    }
    if (t0 >= t1) return null;
    return [new Vector3(px + dx * t0, py + dy * t0, 0), new Vector3(px + dx * t1, py + dy * t1, 0)];
  };
  for (let i = -n; i <= n; i++) {
    const c = (i / n) * (w / 2 + h / 2);
    for (const sgn of [1, -1]) {
      const seg = clip(c, h / 2, sgn * Math.SQRT1_2, Math.SQRT1_2);
      if (!seg) continue;
      const [a, b] = seg;
      const len = a.distanceTo(b);
      if (len < bar * 2) continue;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      box(gb, len, bar, depth * 0.92, new Matrix4().makeRotationZ(ang).setPosition(mid));
    }
  }
  // hinge + actuator housing
  box(gb, w * 0.3, size * 0.12, depth * 1.6, new Matrix4().makeTranslation(0, -size * 0.06, 0));
  const g = new Group();
  const mesh = new Mesh(gb.build(), mat);
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

// ------------------------------------------------------------------------------- landing legs

/** Carbon/aluminium honeycomb leg with telescoping strut and footpad (stowed pointing up). */
export function buildLeg(length: number, bodyRadius: number, carbon: MeshPhysicalMaterial, metal: MeshPhysicalMaterial, lunar = false): Group {
  const g = new Group();
  const gb = new GeoBuilder();
  const hw = new GeoBuilder();
  if (!lunar) {
    // A-frame: tapered beam along +Y (stowed against the body), hinge at origin
    const wBase = Math.max(0.35, bodyRadius * 0.32), wTip = wBase * 0.55, thick = Math.max(0.12, bodyRadius * 0.08);
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      const y0 = (i / steps) * length, y1 = ((i + 1) / steps) * length;
      const w0 = wBase + (wTip - wBase) * (i / steps), w1 = wBase + (wTip - wBase) * ((i + 1) / steps);
      box(gb, (w0 + w1) / 2, y1 - y0 + 0.01, thick, new Matrix4().makeTranslation(0, (y0 + y1) / 2, thick / 2));
    }
    // telescoping strut from mid-leg back to the body (pneumatic damper)
    tube(hw, new Vector3(0, length * 0.55, thick), new Vector3(0, length * 0.1, -bodyRadius * 0.05 + 0.02), Math.max(0.05, thick * 0.35), 10);
    // footpad
    lathe(hw, [[0, length], [wTip * 0.9, length], [wTip * 0.75, length + 0.12], [0, length + 0.12]], { segments: 16, offset: [0, thick * 0.6] });
  } else {
    // lunar: primary strut + secondary braces + saucer footpad, fixed deployed (pointing down/out)
    const r = Math.max(0.05, length * 0.03);
    const foot = new Vector3(0, -length * 0.82, length * 0.6);
    tube(hw, new Vector3(0, 0, 0), foot, r, 10);
    tube(hw, new Vector3(-0.3, -length * 0.45, 0), foot.clone().multiplyScalar(0.55), r * 0.6, 8);
    tube(hw, new Vector3(0.3, -length * 0.45, 0), foot.clone().multiplyScalar(0.55), r * 0.6, 8);
    lathe(hw, [[0, foot.y - 0.08], [length * 0.14, foot.y - 0.06], [length * 0.16, foot.y + 0.02], [0, foot.y + 0.04]], { segments: 18, offset: [foot.x, foot.z] });
  }
  if (gb.vertexCount) { const m = new Mesh(gb.build(), carbon); m.castShadow = true; g.add(m); }
  if (hw.vertexCount) { const m = new Mesh(hw.build(), metal); m.castShadow = true; g.add(m); }
  return g;
}

// ------------------------------------------------------------------------------- flaps

export function buildFlap(span: number, chord: number, thick: number, mat: MeshPhysicalMaterial): Group {
  const gb = new GeoBuilder();
  // tapered plate along +X (outward), chord along Y
  const steps = 4;
  for (let i = 0; i < steps; i++) {
    const x0 = (i / steps) * span, x1 = ((i + 1) / steps) * span;
    const c = chord * (1 - 0.35 * ((x0 + x1) / 2 / span));
    box(gb, x1 - x0 + 0.01, c, thick, new Matrix4().makeTranslation((x0 + x1) / 2, c / 2, 0));
  }
  const g = new Group();
  const m = new Mesh(gb.build(), mat);
  m.castShadow = true;
  g.add(m);
  return g;
}

// ------------------------------------------------------------------------------- solar arrays

export interface PanelVisual {
  group: Group;
  wings: { pivot: Group; segs: Group[] }[];
  style: 'wings' | 'cross' | 'circular';
}

export function buildSolarArrays(span: number, style: 'wings' | 'cross' | 'circular', mount: { y: number; radius: number }, cellMat: MeshPhysicalMaterial, frameMat: MeshPhysicalMaterial): PanelVisual {
  const group = new Group();
  const wings: PanelVisual['wings'] = [];
  const nWings = style === 'cross' ? 4 : 2;
  const wingLen = style === 'cross' ? span / 2 - mount.radius : (span - mount.radius * 2) / 2;
  const nSegs = Math.max(2, Math.min(6, Math.round(wingLen / 1.6)));
  const segLen = wingLen / nSegs;
  const width = Math.max(0.5, Math.min(3, span * 0.11));
  for (let w = 0; w < nWings; w++) {
    const ang = (w / nWings) * Math.PI * 2 + (style === 'cross' ? Math.PI / 4 : 0);
    const pivot = new Group();
    pivot.position.set(Math.cos(ang) * mount.radius, mount.y, Math.sin(ang) * mount.radius);
    pivot.rotation.y = -ang;
    group.add(pivot);
    // yoke
    const yoke = new GeoBuilder();
    tube(yoke, new Vector3(0, 0, 0), new Vector3(segLen * 0.3, 0, 0), 0.03, 6);
    pivot.add(new Mesh(yoke.build(), frameMat));
    const segs: Group[] = [];
    let parent: Group = pivot;
    for (let i = 0; i < nSegs; i++) {
      const sg = new Group();
      sg.position.set(i === 0 ? segLen * 0.3 : segLen, 0, 0);
      const gb = new GeoBuilder();
      box(gb, segLen * 0.98, width, 0.035, new Matrix4().makeTranslation(segLen / 2, 0, 0));
      const cells = new Mesh(gb.build(), cellMat);
      cells.castShadow = true;
      sg.add(cells);
      const fr = new GeoBuilder();
      box(fr, segLen, 0.04, 0.05, new Matrix4().makeTranslation(segLen / 2, width / 2, 0));
      box(fr, segLen, 0.04, 0.05, new Matrix4().makeTranslation(segLen / 2, -width / 2, 0));
      sg.add(new Mesh(fr.build(), frameMat));
      parent.add(sg);
      segs.push(sg);
      parent = sg;
    }
    wings.push({ pivot, segs });
  }
  return { group, wings, style };
}

/** Animate accordion-folded arrays: t = 0 stowed (folded against the bus) .. 1 deployed. */
export function setSolarDeploy(p: PanelVisual, t: number): void {
  const e = t * t * (3 - 2 * t);
  for (const w of p.wings) {
    w.pivot.rotation.z = (1 - e) * (Math.PI / 2);
    w.segs.forEach((s, i) => {
      if (i === 0) { s.rotation.y = 0; return; }
      s.rotation.y = (1 - e) * (i % 2 ? Math.PI * 0.98 : -Math.PI * 0.98);
    });
  }
}

// ------------------------------------------------------------------------------- parachutes

export interface ChuteVisual {
  group: Group;
  canopy: Group;
  lines: Mesh;
  diameter: number;
}

/** Ring-sail style canopy with alternating orange/white gores and suspension lines. */
export function buildChute(diameter: number, lineLength: number, orange: MeshPhysicalMaterial, white: MeshPhysicalMaterial, lineMat: MeshPhysicalMaterial): ChuteVisual {
  const group = new Group();
  const R = diameter / 2;
  const gores = 16;
  const gbO = new GeoBuilder(), gbW = new GeoBuilder();
  const prof: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * (Math.PI / 2) * 0.92;
    prof.push([R * Math.sin(a + 0.08), lineLength + R * 0.55 * Math.cos(a)]);
  }
  prof.reverse();
  for (let g = 0; g < gores; g++) {
    const target = g % 2 ? gbO : gbW;
    lathe(target, prof, { segments: 3, thetaStart: (g / gores) * Math.PI * 2, thetaLength: (Math.PI * 2) / gores });
  }
  const canopy = new Group();
  const mO = new Mesh(gbO.build(), orange);
  const mW = new Mesh(gbW.build(), white);
  canopy.add(mO, mW);
  const lines = new GeoBuilder();
  for (let g = 0; g < gores; g += 2) {
    const a = (g / gores) * Math.PI * 2;
    tube(lines, new Vector3(0, 0, 0), new Vector3(Math.cos(a) * prof[0][0], prof[0][1], Math.sin(a) * prof[0][0]), Math.max(0.01, diameter * 0.0015), 4);
  }
  const linesMesh = new Mesh(lines.build(), lineMat);
  group.add(canopy, linesMesh);
  group.visible = false;
  return { group, canopy, lines: linesMesh, diameter };
}
