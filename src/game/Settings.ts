/**
 * Persistent settings: graphics preset and overrides, audio levels, camera and interface
 * options. Stored in localStorage (wrapped so private/blocked storage just falls back to
 * defaults).
 */

export type GraphicsPreset = 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA' | 'CINEMATIC';
export const PRESETS: GraphicsPreset[] = ['LOW', 'MEDIUM', 'HIGH', 'ULTRA', 'CINEMATIC'];

export interface GraphicsConfig {
  resolutionScale: number;
  msaa: number;
  shadows: number; // shadow map size, 0 = off
  terrainDetail: number; // quadtree split factor
  particles: number; // particle budget
  vegetation: number; // 0..1
  plumeQuality: number; // 0..1
  bloom: number;
  grain: number;
  vignette: number;
  chromatic: number;
  envProbe: number; // environment cube size
  maxPixelRatio: number;
  cloudSteps: number; // cloud-deck ray-march steps (half-resolution pass)
}

export const GRAPHICS: Record<GraphicsPreset, GraphicsConfig> = {
  LOW: { resolutionScale: 0.6, msaa: 0, shadows: 0, terrainDetail: 1.3, particles: 1500, vegetation: 0.25, plumeQuality: 0.6, bloom: 0.03, grain: 0.02, vignette: 0.2, chromatic: 0, envProbe: 32, maxPixelRatio: 1, cloudSteps: 24 },
  MEDIUM: { resolutionScale: 0.8, msaa: 2, shadows: 1024, terrainDetail: 1.8, particles: 3000, vegetation: 0.55, plumeQuality: 0.8, bloom: 0.04, grain: 0.03, vignette: 0.25, chromatic: 0.001, envProbe: 48, maxPixelRatio: 1, cloudSteps: 36 },
  HIGH: { resolutionScale: 1, msaa: 4, shadows: 2048, terrainDetail: 2.4, particles: 6000, vegetation: 1, plumeQuality: 1, bloom: 0.045, grain: 0.035, vignette: 0.28, chromatic: 0.0008, envProbe: 64, maxPixelRatio: 1.5, cloudSteps: 56 },
  ULTRA: { resolutionScale: 1, msaa: 4, shadows: 4096, terrainDetail: 3.0, particles: 10000, vegetation: 1, plumeQuality: 1, bloom: 0.045, grain: 0.035, vignette: 0.28, chromatic: 0.0008, envProbe: 96, maxPixelRatio: 2, cloudSteps: 80 },
  CINEMATIC: { resolutionScale: 1, msaa: 8, shadows: 4096, terrainDetail: 3.4, particles: 14000, vegetation: 1, plumeQuality: 1.15, bloom: 0.055, grain: 0.05, vignette: 0.36, chromatic: 0.0014, envProbe: 128, maxPixelRatio: 2, cloudSteps: 112 },
};

export interface Settings {
  preset: GraphicsPreset;
  master: number;
  music: number;
  sfx: number;
  voice: number;
  shake: number;
  subtitles: boolean;
  hudScale: number;
  invertPitch: boolean;
  units: 'metric';
  letterboxInCinematic: boolean;
  exposureComp: number;
}

export const DEFAULT_SETTINGS: Settings = {
  preset: 'HIGH', master: 0.85, music: 0.6, sfx: 0.9, voice: 0.9, shake: 1, subtitles: true, hudScale: 1, invertPitch: false, units: 'metric',
  letterboxInCinematic: true, exposureComp: 0,
};

const KEY = 'ascent.settings.v1';

export function loadSettings(): Settings {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('preset') : null;
  if (q && (PRESETS as string[]).includes(q)) return { ...DEFAULT_SETTINGS, preset: q as GraphicsPreset };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, preset: detectPreset() };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

/** Rough first-run guess from the GPU / device. */
function detectPreset(): GraphicsPreset {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return 'LOW';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    if (/swiftshader|llvmpipe|software/i.test(r)) return 'LOW';
    if (/intel|mali|adreno|apple gpu/i.test(r) && !/arc/i.test(r)) return 'MEDIUM';
    if (/rtx|radeon rx 6|radeon rx 7|apple m[2-9]/i.test(r)) return 'ULTRA';
    return 'HIGH';
  } catch {
    return 'MEDIUM';
  }
}
