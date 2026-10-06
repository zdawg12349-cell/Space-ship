import type { SectionDef } from '../vehicles/types';

/**
 * Semi-empirical aerodynamics for slender launch vehicles and blunt capsules.
 *
 * - Axial (frontal) drag: Cd0 for the end facing the flow, with a transonic drag rise.
 * - Lateral forces: Barrowman normal-force slopes (nose/transitions/fins) plus cross-flow
 *   drag on every body segment. Each element applies its force at its own centre, so the
 *   centre of pressure — and therefore static stability — emerges from the configuration
 *   (fins/grid fins stabilise, bare noses destabilise, capsules trim heat-shield first).
 */

export interface AeroElement {
  y: number; // vehicle-frame position of the element's centre of pressure
  x: number;
  z: number;
  cnAlpha: number; // Barrowman normal force slope, per rad, referenced to refArea
  sideArea: number; // projected planform area for cross-flow drag, m^2
  kind: 'nose' | 'body' | 'transition' | 'fin' | 'gridfin' | 'capsule' | 'chute';
}

export interface AeroConfig {
  refArea: number;
  refLength: number;
  topY: number;
  bottomY: number;
  topShape: 'ogive' | 'cone' | 'blunt' | 'flat' | 'capsule_apex';
  bottomShape: 'flat' | 'engines' | 'heatshield' | 'nozzle';
  elements: AeroElement[];
  isCapsule: boolean;
  noseRadiusTop: number; // effective radius for stagnation heating when flying nose-first
  noseRadiusBottom: number; // ... when flying base-first
}

/** Transonic drag-rise multiplier on Cd0. */
export function machDragFactor(m: number): number {
  if (m < 0.6) return 1;
  if (m < 1.0) { const t = (m - 0.6) / 0.4; return 1 + 0.75 * t * t; }
  if (m < 1.2) { const t = (m - 1.0) / 0.2; return 1.75 + 0.15 * t; }
  if (m < 3) { const t = (m - 1.2) / 1.8; return 1.9 - 0.65 * t; }
  if (m < 6) { const t = (m - 3) / 3; return 1.25 - 0.15 * t; }
  return 1.1;
}

export function cd0ForShape(shape: AeroConfig['topShape'] | AeroConfig['bottomShape']): number {
  switch (shape) {
    case 'ogive': return 0.22;
    case 'cone': return 0.3;
    case 'blunt': return 0.65;
    case 'capsule_apex': return 0.75;
    case 'flat': return 1.0;
    case 'engines': return 1.1;
    case 'nozzle': return 0.9;
    case 'heatshield': return 1.32;
  }
}

export function buildAeroConfig(
  sections: { s: SectionDef; offX: number; offZ: number }[],
  fins: { y: number; area: number; grid: boolean; offX: number; offZ: number }[],
  hasHeatShieldAtBottom: boolean,
): AeroConfig {
  let maxR = 0.1;
  let top = -Infinity, bottom = Infinity;
  let topSection: SectionDef | null = null;
  let bottomSection: SectionDef | null = null;
  for (const { s, offX, offZ } of sections) {
    const lateral = Math.hypot(offX, offZ);
    maxR = Math.max(maxR, lateral + s.radius, lateral + (s.topRadius ?? s.radius));
    const t = s.y + s.length;
    if (t > top || (t === top && lateral === 0)) { top = t; topSection = s; }
    if (s.y < bottom || (s.y === bottom && lateral === 0)) { bottom = s.y; bottomSection = s; }
  }
  // Reference area: core diameter (largest axisymmetric radius on the axis) — side boosters add side area.
  let coreR = 0.1;
  for (const { s, offX, offZ } of sections) if (offX === 0 && offZ === 0) coreR = Math.max(coreR, s.radius, s.topRadius ?? 0);
  const refArea = Math.PI * coreR * coreR;
  const elements: AeroElement[] = [];
  let isCapsule = false;

  for (const { s, offX, offZ } of sections) {
    const r0 = s.radius;
    const r1 = s.topRadius ?? s.radius;
    // clamshell fairing halves each contribute half of the shell
    const half = s.kind === 'fairing' && s.style && s.style.startsWith('half') ? 0.5 : 1;
    const area0 = Math.PI * r0 * r0 * half;
    const area1 = Math.PI * r1 * r1 * half;
    const side = s.length * (r0 + r1) * half;
    if (s.kind === 'nose' || s.kind === 'les' || (s.kind === 'fairing' && r1 < r0 * 0.6)) {
      // Barrowman nose: CNa = 2 * A_base / A_ref, CP at 0.466 L from tip (ogive), 0.666 L (cone)
      const cpFromTip = (s.shape === 'cone' ? 0.666 : 0.466) * s.length;
      elements.push({ kind: 'nose', y: s.y + s.length - cpFromTip, x: offX, z: offZ, cnAlpha: (2 * area0) / refArea, sideArea: side * 0.6 });
    } else if (s.kind === 'capsule') {
      isCapsule = true;
      // Blunt body: aerodynamic centre near the heat-shield's centre of curvature (above the CoM)
      elements.push({ kind: 'capsule', y: s.y + Math.max(r0 * 1.6, s.length * 1.4), x: offX, z: offZ, cnAlpha: (1.2 * area0) / refArea, sideArea: side * 0.8 });
    } else if (Math.abs(r1 - r0) > 0.02) {
      // transition (flare positive / boattail negative)
      const cn = (2 * (area1 - area0)) / refArea;
      // a flare (r1<r0 going up means boattail at the top) — position at mid-length
      elements.push({ kind: 'transition', y: s.y + s.length * 0.5, x: offX, z: offZ, cnAlpha: -cn, sideArea: side * 0.9 });
    } else {
      elements.push({ kind: 'body', y: s.y + s.length * 0.5, x: offX, z: offZ, cnAlpha: 0.02 * (s.length / Math.max(r0, 0.1)) * (area0 / refArea), sideArea: side });
    }
  }
  for (const f of fins) {
    // Fin set normal force: ~ 2*pi*AR/(2+sqrt(AR^2+4)) per fin area; grid fins are effective at high AoA
    const cn = (f.grid ? 3.2 : 2.6) * f.area / refArea;
    elements.push({ kind: f.grid ? 'gridfin' : 'fin', y: f.y, x: f.offX, z: f.offZ, cnAlpha: cn, sideArea: f.area * 0.5 });
  }

  const topShape: AeroConfig['topShape'] = topSection
    ? topSection.kind === 'capsule' ? 'capsule_apex'
      : topSection.kind === 'nose' || topSection.kind === 'les' ? (topSection.shape === 'cone' ? 'cone' : 'ogive')
        : topSection.kind === 'fairing' ? 'ogive'
          : (topSection.topRadius ?? topSection.radius) < topSection.radius * 0.5 ? 'cone' : 'blunt'
    : 'blunt';
  const bottomShape: AeroConfig['bottomShape'] = hasHeatShieldAtBottom ? 'heatshield' : bottomSection && bottomSection.kind === 'thrust' ? 'engines' : 'flat';

  return {
    refArea,
    refLength: Math.max(1, top - bottom),
    topY: top,
    bottomY: bottom,
    topShape,
    bottomShape,
    elements,
    isCapsule,
    noseRadiusTop: topShape === 'ogive' ? Math.max(0.3, coreR * 0.35) : topShape === 'cone' ? coreR * 0.2 + 0.2 : coreR * 0.9,
    noseRadiusBottom: hasHeatShieldAtBottom ? coreR * 1.25 : coreR * 1.0,
  };
}

/**
 * Tauber–Sutton radiative heating velocity function for Earth entry (W/cm^2 basis),
 * tabulated at 0.5 km/s steps from 9 to 16 km/s.
 */
const RAD_V = [9000, 9250, 9500, 9750, 10000, 10250, 10500, 10750, 11000, 11500, 12000, 12500, 13000, 13500, 14000, 15000, 16000];
const RAD_F = [1.5, 3.4, 4.3, 6.4, 9.7, 13.7, 19.5, 26.8, 35.0, 55.0, 81.0, 115.0, 151.0, 205.0, 258.0, 386.0, 512.0];

export function radiativeHeating(rho: number, v: number, noseRadius: number): number {
  if (v < 9000 || rho <= 0) return 0;
  let i = 0;
  while (i < RAD_V.length - 2 && v > RAD_V[i + 1]) i++;
  const t = Math.min(1, (v - RAD_V[i]) / (RAD_V[i + 1] - RAD_V[i]));
  const f = RAD_F[i] + (RAD_F[i + 1] - RAD_F[i]) * t;
  const a = Math.min(1, 1.072e6 * Math.pow(v, -1.88) * Math.pow(rho, -0.325));
  return 4.736e4 * Math.pow(noseRadius, a) * Math.pow(rho, 1.22) * f * 1e4; // W/cm^2 -> W/m^2
}

/** Sutton–Graves stagnation-point convective heating, W/m^2. */
export function convectiveHeating(rho: number, v: number, noseRadius: number, k = 1.7415e-4): number {
  if (rho <= 0) return 0;
  return k * Math.sqrt(rho / Math.max(0.05, noseRadius)) * v * v * v;
}
