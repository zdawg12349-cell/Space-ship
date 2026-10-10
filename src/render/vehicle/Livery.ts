import { CanvasTexture, LinearMipmapLinearFilter, LinearFilter, RepeatWrapping, SRGBColorSpace, Texture } from 'three';
import type { VehicleDef } from '../../vehicles/types';

/**
 * Procedural liveries painted on a canvas laid out in physical units: x runs around the
 * circumference (u = theta / 2pi), y runs along the labelled section. Text is drawn
 * vertically like real launch-vehicle markings, with an original mission-agency emblem,
 * serial stencils and hazard markings.
 */

const cache = new Map<string, Texture>();

function css(c: [number, number, number], a = 1): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

function luminance(c: [number, number, number]): number { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

/** Emblem: original roundel (orbit swoosh + star) — no real-world agency marks. */
function drawEmblem(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, ink: string, paper: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = ink;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = paper;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = r * 0.1;
  ctx.beginPath(); ctx.ellipse(0, 0, r * 0.7, r * 0.28, -0.45, 0, Math.PI * 2); ctx.stroke();
  // four-point star
  ctx.fillStyle = ink;
  ctx.beginPath();
  const s = r * 0.42, w = r * 0.1;
  ctx.moveTo(0, -s); ctx.lineTo(w, -w); ctx.lineTo(s, 0); ctx.lineTo(w, w); ctx.lineTo(0, s); ctx.lineTo(-w, w); ctx.lineTo(-s, 0); ctx.lineTo(-w, -w);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

export interface LiveryRequest {
  def: VehicleDef;
  /** section length (m) and radius (m) */
  length: number;
  radius: number;
  /** what to paint on this section */
  kind: 'name' | 'bands' | 'fairing' | 'srb' | 'capsule';
  text?: string;
}

/** Livery texture for one section. The texture is transparent where the base paint shows. */
export function liveryTexture(req: LiveryRequest): Texture {
  const key = `${req.def.id}|${req.kind}|${req.length.toFixed(2)}|${req.radius.toFixed(2)}|${req.text ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const circ = Math.PI * 2 * req.radius;
  // ~1 cm per texel around, capped
  const W = 2048;
  const H = Math.min(4096, Math.max(512, Math.round((W * req.length) / Math.max(circ, 1)) & ~1));
  const pxPerM_u = W / circ;
  const pxPerM_v = H / req.length;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);
  const lv = req.def.livery;
  const primaryLight = luminance(lv.primary) > 0.35;
  const ink = primaryLight ? css(lv.accent) : css([0.94, 0.94, 0.94]);
  const inkSoft = primaryLight ? css(lv.accent, 0.85) : css([0.94, 0.94, 0.94], 0.9);
  const paper = css(lv.primary);

  // physical-unit drawing helper: (s, y) in metres -> canvas px; s around from u=0
  const X = (s: number) => s * pxPerM_u;
  const Y = (y: number) => H - y * pxPerM_v;

  const drawVerticalText = (text: string, sCenter: number, yBottom: number, height: number, letterH: number, weight = 800, family = '"Barlow Condensed", "Arial Narrow", sans-serif', color = ink) => {
    // text runs bottom->top along the vehicle; letters are letterH metres tall (measured around)
    ctx.save();
    ctx.translate(X(sCenter), Y(yBottom));
    ctx.rotate(-Math.PI / 2);
    // after rotation: +x is up the vehicle, +y is around (increasing s)
    // fonts are rasterised at K px per metre then scaled, avoiding tiny-font hinting issues
    const K = 64;
    ctx.scale(pxPerM_v / K, pxPerM_u / K);
    ctx.fillStyle = color;
    ctx.font = `${weight} ${letterH * K}px ${family}`;
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width / K;
    const sx = Math.min(1, height / Math.max(w, 1e-3));
    ctx.scale(sx, 1);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  };

  if (req.kind === 'name') {
    const text = req.text ?? lv.text;
    const letterH = Math.min(req.radius * 0.95, 3.2);
    const textLen = Math.min(req.length * 0.62, text.length * letterH * 0.62);
    const y0 = (req.length - textLen) * 0.5;
    // two copies, facing +Z and -Z (u = 0.25 / 0.75)
    for (const u of [0.25, 0.75]) drawVerticalText(text, u * circ, y0, textLen, letterH);
    // emblem above the text on the +Z side
    const er = Math.min(req.radius * 0.55, 1.6);
    const ey = Math.min(req.length - er * 1.6, y0 + textLen + er * 1.8);
    ctx.save();
    ctx.translate(X(0.25 * circ), Y(ey));
    ctx.scale(pxPerM_u, pxPerM_v);
    drawEmblem(ctx, 0, 0, er, ink, paper);
    ctx.restore();
    // serial stencil + hazard text near the bottom (small)
    const small = Math.max(0.12, Math.min(0.22, req.radius * 0.1));
    drawVerticalText(`${req.def.id.toUpperCase().replace(/_/g, '-')}-${String(1000 + (req.def.name.length * 37) % 900)}`, 0.5 * circ, 0.6, 1.8, small, 600, '"JetBrains Mono", monospace', inkSoft);
    drawVerticalText('NO STEP', 0.0001 * circ + 0.4, req.length * 0.15, 0.9, small * 0.9, 700, '"Barlow Semi Condensed", sans-serif', inkSoft);
    // flag-like tricolour band (original design)
    ctx.save();
    const fs = 0.75 * circ, fy = y0 + textLen * 0.5, fw = Math.min(1.6, req.radius * 0.7), fh = fw * 0.62;
    ctx.translate(X(fs), Y(fy));
    ctx.scale(pxPerM_u, pxPerM_v);
    ctx.fillStyle = css([0.12, 0.22, 0.5]); ctx.fillRect(-fw / 2, -fh / 2, fw, fh / 3);
    ctx.fillStyle = css([0.95, 0.95, 0.95]); ctx.fillRect(-fw / 2, -fh / 6, fw, fh / 3);
    ctx.fillStyle = css([0.75, 0.12, 0.12]); ctx.fillRect(-fw / 2, fh / 6, fw, fh / 3);
    ctx.restore();
  } else if (req.kind === 'bands') {
    const bh = Math.min(0.9, req.length * 0.08);
    ctx.fillStyle = css(lv.accent);
    ctx.fillRect(0, Y(req.length * 0.86 + bh), W, bh * pxPerM_v);
    ctx.fillRect(0, Y(req.length * 0.08 + bh), W, bh * pxPerM_v * 0.5);
  } else if (req.kind === 'fairing') {
    const letterH = Math.min(req.radius * 0.7, 2.2);
    const text = req.text ?? lv.text;
    const textLen = Math.min(req.length * 0.45, text.length * letterH * 0.62);
    for (const u of [0.25, 0.75]) drawVerticalText(text, u * circ, req.length * 0.12, textLen, letterH);
    ctx.save();
    ctx.translate(X(0.0 * circ + 1.2), Y(req.length * 0.5));
    ctx.scale(pxPerM_u, pxPerM_v);
    drawEmblem(ctx, 0, 0, Math.min(1.1, req.radius * 0.4), ink, paper);
    ctx.restore();
  } else if (req.kind === 'srb') {
    // segment joint bands + small marking
    const segs = Math.max(2, Math.round(req.length / 7));
    ctx.fillStyle = css([0.1, 0.1, 0.1], 0.8);
    for (let i = 1; i < segs; i++) ctx.fillRect(0, Y((i * req.length) / segs) - 0.05 * pxPerM_v, W, 0.1 * pxPerM_v);
    drawVerticalText(lv.text, 0.25 * circ, req.length * 0.35, Math.min(req.length * 0.3, lv.text.length * 0.9), Math.min(req.radius * 0.8, 1.3));
  } else if (req.kind === 'capsule') {
    const text = req.text ?? lv.text;
    drawVerticalText(text, 0.25 * circ, req.length * 0.3, req.length * 0.4, Math.min(0.5, req.radius * 0.25));
  }

  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  cache.set(key, tex);
  return tex;
}

/** Make sure the livery fonts are ready before painting (canvas falls back silently otherwise). */
export async function loadLiveryFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  await Promise.all([
    document.fonts.load('800 64px "Barlow Condensed"'),
    document.fonts.load('600 32px "JetBrains Mono"'),
    document.fonts.load('700 32px "Barlow Semi Condensed"'),
  ]).catch(() => undefined);
}
