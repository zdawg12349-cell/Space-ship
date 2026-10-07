import { Simplex3, hash3 } from '../../util/noise';

/**
 * Planet height functions shared by the terrain mesher (worker) and the physics terrain
 * provider, so the ground the vehicle touches is exactly the ground that is drawn.
 * All inputs are unit vectors in the body-fixed frame; outputs are metres above the
 * reference radius.
 */

export interface GlobalMap {
  width: number;
  height: number;
  /** interleaved channels (water, elevation) 0..255 */
  data: Uint8Array;
  channels: number;
}

export interface SiteDef {
  id: string;
  /** body-fixed unit vector of the pad centre */
  dir: [number, number, number];
  padHeight: number; // m
  flatRadius: number; // m, fully flat
  blendRadius: number; // m, blend back to natural terrain
  /** local coastline: bearing (rad from north) toward the sea and distance from the pad (m) */
  coastBearing: number;
  coastDistance: number;
  regionRadius: number; // m, area where the local coastline overrides the global mask
  inland?: boolean; // no sea nearby (steppe/desert site)
}

export interface HeightContext {
  kind: 'earth' | 'moon' | 'flat';
  radius: number;
  map?: GlobalMap;
  moonMap?: { width: number; height: number; data: Uint8Array };
  sites: SiteDef[];
}

const simplex = new Simplex3(7);
const simplex2 = new Simplex3(42);

export interface HeightSample { h: number; water: number; sand: number; flat: number }

function sampleMap(map: GlobalMap, lat: number, lon: number, ch: number): number {
  // equirectangular, lon -180..180 => x 0..W, lat 90..-90 => y 0..H
  const W = map.width, H = map.height;
  let x = ((lon / (2 * Math.PI)) + 0.5) * W - 0.5;
  const y = (0.5 - lat / Math.PI) * H - 0.5;
  x = ((x % W) + W) % W;
  const x0 = Math.floor(x), y0 = Math.max(0, Math.min(H - 1, Math.floor(y)));
  const x1 = (x0 + 1) % W, y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0, fy = Math.min(1, Math.max(0, y - y0));
  const c = map.channels, d = map.data;
  const a = d[(y0 * W + x0) * c + ch], b = d[(y0 * W + x1) * c + ch];
  const e = d[(y1 * W + x0) * c + ch], f = d[(y1 * W + x1) * c + ch];
  return ((a * (1 - fx) + b * fx) * (1 - fy) + (e * (1 - fx) + f * fx) * fy) / 255;
}

/** Local tangent-plane coordinates (m) of dir relative to a site: east, north. */
function siteLocal(site: SiteDef, dx: number, dy: number, dz: number, R: number): [number, number, number] {
  const [sx, sy, sz] = site.dir;
  const dot = dx * sx + dy * sy + dz * sz;
  const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
  const dist = ang * R;
  // east/north at the site
  let nx = -sz * sx, ny = -sz * sy, nz = 1 - sz * sz;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  const ex = ny * sz - nz * sy, ey = nz * sx - nx * sz, ez = nx * sy - ny * sx;
  const px = dx - sx * dot, py = dy - sy * dot, pz = dz - sz * dot;
  const pl = Math.hypot(px, py, pz) || 1;
  const e = ((px * ex + py * ey + pz * ez) / pl) * dist;
  const n = ((px * nx + py * ny + pz * nz) / pl) * dist;
  return [e, n, dist];
}

function smooth01(x: number): number { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); }

export function earthHeight(ctx: HeightContext, dx: number, dy: number, dz: number, out: HeightSample, detail = 1): HeightSample {
  const R = ctx.radius;
  const lat = Math.asin(Math.max(-1, Math.min(1, dz)));
  const lon = Math.atan2(dy, dx);
  let water = 0, elev = 0;
  if (ctx.map) {
    water = sampleMap(ctx.map, lat, lon, 0);
    // the relief map is a shaded-relief bump map, not metres: lowlands sit at ~24/255 and the
    // curve is compressive. Calibrated against known elevations (Kansas, Sahara, Colorado,
    // Greenland, Tibet, Everest).
    const v = sampleMap(ctx.map, lat, lon, 1) * 255;
    elev = v <= 24 ? 0 : 8848 * Math.pow((v - 24) / 230, 1.25);
  }
  let sand = 0;
  let flat = 0;
  // procedural relief scaled by the regional elevation (mountains rough, plains gentle)
  const px = dx * 2200, py = dy * 2200, pz = dz * 2200; // ~2.9 km base wavelength
  const ridged = simplex.ridged(px * 0.35, py * 0.35, pz * 0.35, 5);
  const hills = simplex.fbm(px, py, pz, detail > 0.5 ? 6 : 4);
  // plains stay plains: a few metres of undulation at sea level, full relief in the mountains
  const relief = (3 + Math.min(elev, 400) * 0.06 + elev * 0.2) * (hills * 0.6 + ridged * (elev > 600 ? 0.8 : 0.15));
  let h = elev + relief;
  // local coastline & launch site flattening
  for (const s of ctx.sites) {
    const [e, n, dist] = siteLocal(s, dx, dy, dz, R);
    if (dist > s.regionRadius + 5000) continue;
    if (!s.inland) {
      // signed distance toward the sea along the coast bearing (+ = seaward)
      const along = e * Math.sin(s.coastBearing) + n * Math.cos(s.coastBearing);
      const cross = e * Math.cos(s.coastBearing) - n * Math.sin(s.coastBearing);
      const wiggle = simplex2.fbm(cross * 0.00012, 3.1, 7.7, 4) * 1800 + simplex2.fbm(cross * 0.0011, 9.2, 1.3, 3) * 160;
      const sd = along - s.coastDistance - wiggle; // >0 sea
      const localWater = smooth01((sd + 25) / 50);
      const w = 1 - smooth01((dist - s.regionRadius) / 5000);
      water = water * (1 - w) + localWater * w;
      // gentle coastal plain: a metre or two near the beach, rising slowly inland
      const plain = Math.max(0.4, Math.min(12, 1.2 + (-sd) * 0.0009)) + simplex.fbm(e * 0.004, n * 0.004, 2.2, 3) * 1.3;
      h = h * (1 - w) + plain * w;
      sand += w * (1 - smooth01((-sd - 15) / 120)) * (1 - localWater);
    }
    // pad flattening
    const f = 1 - smooth01((dist - s.flatRadius) / Math.max(1, s.blendRadius - s.flatRadius));
    if (f > 0) {
      h = h * (1 - f) + s.padHeight * f;
      water *= 1 - f;
      flat = Math.max(flat, f);
    }
  }
  if (water > 0.5) h = Math.min(h, 0);
  out.h = Math.max(h, 0);
  out.water = water;
  out.sand = Math.min(1, sand);
  out.flat = flat;
  return out;
}

// ------------------------------------------------------------------------------- Moon

interface CraterLevel { cell: number; minR: number; maxR: number; prob: number; depth: number; mare: number }
// cell sizes in metres on the lunar surface; radii in metres. `mare` is the fraction of the craters that
// the young basalt plains lack (crater counts on Mare Tranquillitatis fall 5-10x below the highlands for
// kilometre-sized craters; below ~150 m both are saturated)
const CRATER_LEVELS: CraterLevel[] = [
  { cell: 120000, minR: 15000, maxR: 45000, prob: 0.55, depth: 0.12, mare: 0.9 },
  { cell: 40000, minR: 4000, maxR: 15000, prob: 0.6, depth: 0.15, mare: 0.85 },
  { cell: 12000, minR: 1200, maxR: 4500, prob: 0.65, depth: 0.18, mare: 0.87 },
  { cell: 3500, minR: 350, maxR: 1300, prob: 0.7, depth: 0.2, mare: 0.83 },
  { cell: 1000, minR: 90, maxR: 380, prob: 0.75, depth: 0.2, mare: 0.67 },
  { cell: 280, minR: 25, maxR: 100, prob: 0.8, depth: 0.2, mare: 0 },
  { cell: 80, minR: 6, maxR: 28, prob: 0.8, depth: 0.18, mare: 0 },
];

function craterProfile(d: number, depth: number, rim: number): number {
  // d = distance / radius
  if (d < 1) {
    const bowl = (d * d - 1) * depth; // parabolic bowl
    const rimIn = rim * Math.exp(-((d - 1) * (d - 1)) / 0.02);
    return bowl + rimIn;
  }
  const ejecta = rim * Math.pow(d, -3.2);
  return rim * Math.exp(-((d - 1) * (d - 1)) / 0.03) * 0.65 + ejecta * 0.35;
}

export function moonHeight(ctx: HeightContext, dx: number, dy: number, dz: number, out: HeightSample, minFeature = 0): HeightSample {
  const R = ctx.radius;
  let h = 0;
  // maria (dark basalt plains) are smooth and young: little rolling relief, few large craters
  let mare = 0;
  if (ctx.moonMap) {
    const lat = Math.asin(Math.max(-1, Math.min(1, dz)));
    const lon = Math.atan2(dy, dx);
    const m = ctx.moonMap;
    const v = sampleMap({ width: m.width, height: m.height, data: m.data, channels: 1 }, lat, lon, 0);
    h = (v - 0.55) * 5200; // maria ~ -2.8 km, highlands ~ +2.3 km
    const t = Math.max(0, Math.min(1, (0.5 - v) / 0.14));
    mare = t * t * (3 - 2 * t);
  }
  // rolling regolith relief: hummocky highlands, nearly level basalt plains (a few degrees of slope)
  h += simplex.fbm(dx * 900, dy * 900, dz * 900, 5, 2, 0.45) * 380 * (1 - 0.8 * mare);
  h += simplex2.fbm(dx * 9000, dy * 9000, dz * 9000, 4) * 22 * (1 - 0.75 * mare);
  // craters on a 3D grid of cells per level
  for (const L of CRATER_LEVELS) {
    if (L.maxR * 2 < minFeature) break;
    const cs = L.cell / R; // cell size on the unit sphere
    const cx = Math.floor(dx / cs), cy = Math.floor(dy / cs), cz = Math.floor(dz / cs);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      const gx = cx + i, gy = cy + j, gz = cz + k;
      const r0 = hash3(gx, gy, gz * 7 + L.cell);
      if (r0 > L.prob * (1 - L.mare * mare)) continue;
      // crater centre inside the cell, projected onto the sphere
      let ox = (gx + hash3(gx + 11, gy, gz)) * cs;
      let oy = (gy + hash3(gx, gy + 17, gz)) * cs;
      let oz = (gz + hash3(gx, gy, gz + 23)) * cs;
      const ol = Math.hypot(ox, oy, oz);
      if (ol < 1e-9) continue;
      ox /= ol; oy /= ol; oz /= ol;
      // must lie near this cell's projection, otherwise skip (avoids duplicates far away)
      const rad = L.minR + (L.maxR - L.minR) * Math.pow(hash3(gx + 5, gy + 3, gz + 1), 2.2);
      const ddot = dx * ox + dy * oy + dz * oz;
      if (ddot < 0) continue;
      const dist = Math.acos(Math.min(1, ddot)) * R;
      if (dist > rad * 3) continue;
      const age = hash3(gx + 31, gy + 37, gz + 41); // older craters are shallower & softer
      const depth = L.depth * rad * 2 * (0.35 + 0.65 * (1 - age * age));
      h += craterProfile(dist / rad, depth, depth * 0.22);
    }
  }
  out.h = h;
  out.water = 0;
  out.sand = 0;
  out.flat = 0;
  return out;
}

export function sampleHeight(ctx: HeightContext, dx: number, dy: number, dz: number, out: HeightSample, detail = 1, minFeature = 0): HeightSample {
  if (ctx.kind === 'earth') return earthHeight(ctx, dx, dy, dz, out, detail);
  if (ctx.kind === 'moon') return moonHeight(ctx, dx, dy, dz, out, minFeature);
  out.h = 0; out.water = 0; out.sand = 0; out.flat = 0;
  return out;
}
