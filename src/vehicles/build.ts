import type { AssemblyDef, EngineMount, EngineSpec, MaterialStyle, SectionDef, SectionKind } from './types';

/** Small DSL for stacking sections and placing engine clusters. */

export interface SecOpts {
  material?: MaterialStyle;
  mass?: number;
  propellant?: number;
  topRadius?: number;
  label?: string;
  stringers?: boolean;
  raceway?: boolean;
  frost?: boolean;
  bands?: number;
  shape?: SectionDef['shape'];
  style?: string;
}

export class Stack {
  y: number;
  readonly sections: SectionDef[] = [];
  constructor(y0: number) { this.y = y0; }

  add(kind: SectionKind, length: number, radius: number, o: SecOpts = {}): this {
    this.sections.push({
      kind,
      y: this.y,
      length,
      radius,
      topRadius: o.topRadius,
      material: o.material ?? 'white',
      mass: o.mass ?? 0,
      propellant: o.propellant,
      label: o.label,
      stringers: o.stringers,
      raceway: o.raceway,
      frost: o.frost,
      bands: o.bands,
      shape: o.shape,
      style: o.style,
    });
    this.y += length;
    return this;
  }

  /** skip (gap) */
  gap(len: number): this { this.y += len; return this; }
  get top(): number { return this.y; }
}

export function center(spec: EngineSpec, y: number, group = 'center'): EngineMount[] {
  return [{ spec, pos: [0, y, 0], group }];
}

export function ring(spec: EngineSpec, n: number, r: number, y: number, phase = 0, group = 'ring', cant = 0): EngineMount[] {
  const out: EngineMount[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    out.push({ spec, pos: [Math.cos(a) * r, y, Math.sin(a) * r], group, cant });
  }
  return out;
}

export function asm(id: string, name: string, parent: string | null, sections: SectionDef[], engines: EngineMount[], extra: Partial<AssemblyDef> = {}): AssemblyDef {
  return { id, name, parent, sections, engines, ...extra };
}

/** Clone an assembly definition with a lateral offset (side boosters). */
export function offsetCopy(base: AssemblyDef, id: string, name: string, offset: [number, number], extra: Partial<AssemblyDef> = {}): AssemblyDef {
  return {
    ...base,
    id,
    name,
    offset,
    sections: base.sections.map((s) => ({ ...s })),
    engines: base.engines.map((e) => ({ ...e, pos: [...e.pos] as [number, number, number] })),
    features: base.features ? { ...base.features } : undefined,
    ...extra,
  };
}

/** Boosters arranged around the core at given angles (degrees). */
export function boosterRing(base: AssemblyDef, prefix: string, name: string, radius: number, anglesDeg: number[], extra: (i: number) => Partial<AssemblyDef> = () => ({})): AssemblyDef[] {
  return anglesDeg.map((deg, i) => {
    const a = (deg * Math.PI) / 180;
    return offsetCopy(base, `${prefix}${i + 1}`, `${name} ${i + 1}`, [Math.cos(a) * radius, Math.sin(a) * radius], extra(i));
  });
}

/** Two clamshell fairing halves (assemblies fairing_a / fairing_b). */
export function fairingHalves(parent: string, y: number, length: number, radius: number, mass: number, o: SecOpts = {}): AssemblyDef[] {
  const mk = (id: string, side: number): AssemblyDef => ({
    id,
    name: 'Payload fairing',
    parent,
    offset: [0, 0],
    sections: [{ kind: 'fairing', y, length, radius, topRadius: o.topRadius ?? 0, material: o.material ?? 'white', mass: mass / 2, shape: o.shape ?? 'ogive', style: side > 0 ? 'half_a' : 'half_b', label: o.label }],
    engines: [],
    separation: { kind: 'fairing', impulse: 3.2, spin: 0.5 },
    maxSkinTemp: 1000,
  });
  return [mk('fairing_a', 1), mk('fairing_b', -1)];
}
