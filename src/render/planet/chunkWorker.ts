/// <reference lib="webworker" />
import { faceUVToDir } from './cubesphere';
import { HeightContext, HeightSample, sampleHeight } from './heightfield';

/**
 * Terrain chunk mesher. Builds an (N x N) grid on a cube-sphere face patch plus a skirt,
 * with positions relative to the patch centre (so float32 stays precise near the camera),
 * smooth normals from a one-vertex border, and per-vertex shading data.
 */

interface BuildMsg {
  type: 'build';
  id: number;
  face: number;
  x0: number; // face coords [-1, 1]
  y0: number;
  size: number;
  N: number;
  level: number;
  skirt: number; // m
  detailPeriod: number; // m
}

let ctx: HeightContext | null = null;
const hs: HeightSample = { h: 0, water: 0, sand: 0, flat: 0 };

function siteWeight(c: HeightContext, x: number, y: number, z: number): number {
  let w = 0;
  for (const s of c.sites) {
    const d = Math.acos(Math.max(-1, Math.min(1, x * s.dir[0] + y * s.dir[1] + z * s.dir[2]))) * c.radius;
    const t = 1 - Math.min(1, Math.max(0, (d - s.regionRadius) / 6000));
    w = Math.max(w, t);
  }
  return w;
}

function build(m: BuildMsg) {
  const c = ctx!;
  const R = c.radius;
  const N = m.N;
  const G = N + 2; // with border
  const step = m.size / (N - 1);
  const pos = new Float64Array(G * G * 3);
  const dirs = new Float64Array(G * G * 3);
  const extra = new Float32Array(G * G * 4);
  const hts = new Float32Array(G * G);
  const d: number[] = [0, 0, 0];
  const spacing = (m.size * R * Math.PI) / 4 / (N - 1); // approx metres between vertices
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const u = m.x0 + (i - 1) * step;
      const v = m.y0 + (j - 1) * step;
      faceUVToDir(m.face, u, v, d);
      const l = Math.hypot(d[0], d[1], d[2]);
      const x = d[0] / l, y = d[1] / l, z = d[2] / l;
      sampleHeight(c, x, y, z, hs, spacing < 2000 ? 1 : 0, spacing * 1.5);
      const h = hs.h;
      const k = j * G + i;
      dirs[k * 3] = x; dirs[k * 3 + 1] = y; dirs[k * 3 + 2] = z;
      pos[k * 3] = x * (R + h); pos[k * 3 + 1] = y * (R + h); pos[k * 3 + 2] = z * (R + h);
      extra[k * 4] = hs.water; extra[k * 4 + 1] = hs.sand; extra[k * 4 + 2] = hs.flat; extra[k * 4 + 3] = siteWeight(c, x, y, z);
      hts[k] = h;
      if (i > 0 && j > 0 && i <= N && j <= N) { minH = Math.min(minH, h); maxH = Math.max(maxH, h); }
    }
  }
  // centre of the patch
  const ci = Math.floor(G / 2) * G + Math.floor(G / 2);
  const cx = pos[ci * 3], cy = pos[ci * 3 + 1], cz = pos[ci * 3 + 2];

  const vCount = N * N + 4 * N; // grid + skirt ring
  const P = new Float32Array(vCount * 3);
  const Nn = new Float32Array(vCount * 3);
  const D = new Float32Array(vCount * 3);
  const E = new Float32Array(vCount * 4);
  const H = new Float32Array(vCount);
  const T = new Float32Array(vCount * 2);
  const faceLen = (R * Math.PI) / 2;
  const per = m.detailPeriod;
  const baseU = Math.floor((((m.x0 + 1) / 2) * faceLen) / per);
  const baseV = Math.floor((((m.y0 + 1) / 2) * faceLen) / per);

  const idx = (i: number, j: number) => j * G + i;
  let vi = 0;
  const put = (k: number, skirt: boolean) => {
    const sx = skirt ? -dirs[k * 3] * m.skirt : 0;
    const sy = skirt ? -dirs[k * 3 + 1] * m.skirt : 0;
    const sz = skirt ? -dirs[k * 3 + 2] * m.skirt : 0;
    P[vi * 3] = pos[k * 3] - cx + sx;
    P[vi * 3 + 1] = pos[k * 3 + 1] - cy + sy;
    P[vi * 3 + 2] = pos[k * 3 + 2] - cz + sz;
    // normal from central differences
    const i = k % G, j = Math.floor(k / G);
    const l = idx(Math.max(0, i - 1), j), r = idx(Math.min(G - 1, i + 1), j);
    const b = idx(i, Math.max(0, j - 1)), t = idx(i, Math.min(G - 1, j + 1));
    const ax = pos[r * 3] - pos[l * 3], ay = pos[r * 3 + 1] - pos[l * 3 + 1], az = pos[r * 3 + 2] - pos[l * 3 + 2];
    const bx = pos[t * 3] - pos[b * 3], by = pos[t * 3 + 1] - pos[b * 3 + 1], bz = pos[t * 3 + 2] - pos[b * 3 + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // ensure outward
    if (nx * dirs[k * 3] + ny * dirs[k * 3 + 1] + nz * dirs[k * 3 + 2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
    Nn[vi * 3] = nx; Nn[vi * 3 + 1] = ny; Nn[vi * 3 + 2] = nz;
    D[vi * 3] = dirs[k * 3]; D[vi * 3 + 1] = dirs[k * 3 + 1]; D[vi * 3 + 2] = dirs[k * 3 + 2];
    E[vi * 4] = extra[k * 4]; E[vi * 4 + 1] = extra[k * 4 + 1]; E[vi * 4 + 2] = extra[k * 4 + 2]; E[vi * 4 + 3] = extra[k * 4 + 3];
    H[vi] = hts[k];
    const uu = m.x0 + (i - 1) * step, vv = m.y0 + (j - 1) * step;
    T[vi * 2] = (((uu + 1) / 2) * faceLen) / per - baseU;
    T[vi * 2 + 1] = (((vv + 1) / 2) * faceLen) / per - baseV;
    vi++;
  };
  for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) put(idx(i, j), false);
  // skirts: bottom row, top row, left col, right col (in that order)
  for (let i = 1; i <= N; i++) put(idx(i, 1), true);
  for (let i = 1; i <= N; i++) put(idx(i, N), true);
  for (let j = 1; j <= N; j++) put(idx(1, j), true);
  for (let j = 1; j <= N; j++) put(idx(N, j), true);

  // bounding radius
  let br = 0;
  for (let k = 0; k < N * N; k++) br = Math.max(br, Math.hypot(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]));

  const msg = { type: 'built', id: m.id, center: [cx, cy, cz], positions: P, normals: Nn, dirs: D, extra: E, heights: H, detail: T, minH, maxH, radius: br + m.skirt };
  (self as unknown as Worker).postMessage(msg, [P.buffer, Nn.buffer, D.buffer, E.buffer, H.buffer, T.buffer]);
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === 'init') ctx = m.ctx as HeightContext;
  else if (m.type === 'sites') { if (ctx) ctx.sites = m.sites; }
  else if (m.type === 'build') build(m as BuildMsg);
};
