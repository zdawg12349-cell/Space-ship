import { Matrix4, Quaternion, Vector3 } from 'three';
import type { FlightSession } from '../game/FlightSession';
import type { CelestialBody } from '../physics/bodies';
import { keplerPropagate } from '../physics/orbit';
import { fmtDist, fmtTime, h } from './dom';

/**
 * Orbital map: a vector view of the active vessel's body, its moons, the vessel's predicted
 * trajectory (patched conics, with the Moon's sphere of influence handled), apsides,
 * ascending/descending markers and other vessels. Drag to rotate, wheel to zoom.
 */

const _a = new Vector3();
const _q = new Quaternion();

/** Equirectangular surface maps for the textured globes (loaded once, shared by every map). */
const SURFACE_MAPS: Record<string, string> = { earth: 'earth/albedo_1k.webp', earth_night: 'earth/night.webp', moon: 'moon/albedo.webp' };
const surfaceCache = new Map<string, ImageData | 'loading'>();
function surfaceMap(id: string): ImageData | null {
  const hit = surfaceCache.get(id);
  if (hit && hit !== 'loading') return hit;
  if (hit === 'loading' || !SURFACE_MAPS[id] || typeof document === 'undefined') return null;
  surfaceCache.set(id, 'loading');
  const img = new Image();
  img.onload = () => {
    // keep the sampling cheap: at most 1024 x 512 texels
    const w = Math.min(1024, img.width), h = Math.round((w * img.height) / img.width);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    cx.drawImage(img, 0, 0, w, h);
    surfaceCache.set(id, cx.getImageData(0, 0, w, h));
  };
  img.onerror = () => surfaceCache.delete(id);
  img.src = `${import.meta.env.BASE_URL}assets/${SURFACE_MAPS[id]}`;
  return null;
}

export class MapView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private yaw = 0.6;
  private pitch = 0.75;
  private zoom = 1;
  private drag: { x: number; y: number } | null = null;
  private focus: CelestialBody;
  private info: HTMLElement;
  private time = 0;
  /** rendered textured globe (re-rendered when the view, size or lighting changes) */
  private globe: { canvas: HTMLCanvasElement; key: string; at: number } | null = null;

  constructor(parent: HTMLElement, readonly s: FlightSession) {
    this.canvas = h('canvas', {});
    this.ctx = this.canvas.getContext('2d')!;
    this.info = h('div', { class: 'map-info' });
    this.root = h('div', { id: 'map' }, this.canvas, h('div', { class: 'map-title' }, 'ORBITAL MAP'), this.info,
      h('div', { class: 'keys' }, 'Rotate', h('b', {}, 'DRAG'), ' · Zoom', h('b', {}, 'WHEEL'), ' · Focus', h('b', {}, 'TAB'), ' · Close', h('b', {}, 'M')));
    parent.appendChild(this.root);
    this.focus = s.active.body;
    this.root.addEventListener('mousedown', (e) => { this.drag = { x: e.clientX, y: e.clientY }; });
    window.addEventListener('mouseup', this.mu);
    window.addEventListener('mousemove', this.mm);
    this.root.addEventListener('wheel', (e) => { this.zoom *= Math.pow(1.15, -Math.sign(e.deltaY)); this.zoom = Math.max(0.02, Math.min(400, this.zoom)); e.preventDefault(); }, { passive: false });
    window.addEventListener('keydown', this.kd);
    this.resize();
  }

  private mu = () => { this.drag = null; };
  private mm = (e: MouseEvent) => {
    if (!this.drag) return;
    this.yaw += (e.clientX - this.drag.x) * 0.006;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + (e.clientY - this.drag.y) * 0.006));
    this.drag = { x: e.clientX, y: e.clientY };
  };
  private kd = (e: KeyboardEvent) => {
    if (e.code === 'Tab') {
      e.preventDefault();
      const sys = this.s.system;
      const order = ['earth', 'moon', 'jupiter', 'sun'].map((id) => sys.get(id));
      const i = order.indexOf(this.focus);
      this.focus = order[(i + 1) % order.length];
      this.zoom = 1;
    }
  };

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
  }

  dispose(): void {
    window.removeEventListener('mouseup', this.mu);
    window.removeEventListener('mousemove', this.mm);
    window.removeEventListener('keydown', this.kd);
    this.root.remove();
  }

  /** world (relative to focus body, metres) -> screen */
  private project(p: Vector3, scale: number, out: { x: number; y: number; z: number }): void {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // rotate about the ecliptic normal (z) then tilt
    const x1 = p.x * cy - p.y * sy, y1 = p.x * sy + p.y * cy;
    const y2 = y1 * cp - p.z * sp, z2 = y1 * sp + p.z * cp;
    out.x = this.canvas.width / 2 + x1 * scale;
    out.y = this.canvas.height / 2 + y2 * scale;
    out.z = z2;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.canvas.width !== Math.floor(window.innerWidth * Math.min(2, window.devicePixelRatio || 1))) this.resize();
    const s = this.s;
    const c = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    this.labelRects.length = 0;
    const t = s.world.t;
    const v = s.active;
    const focus = this.focus;
    const fpos = focus.globalPositionAt(t, new Vector3());
    // scale: fit the vessel's orbit (or the focus body's moons)
    const o = v.updateOrbit(t);
    let extent: number;
    if (v.body === focus) extent = o.e < 1 ? Math.max(o.apoapsis, focus.radius * 1.6) : Math.max(v.pos.length() * 1.5, focus.radius * 3);
    else extent = focus.id === 'sun' ? 1.6e12 : focus.id === 'jupiter' ? 2.2e9 : focus.id === 'earth' ? 4.6e8 : focus.radius * 6;
    const scale = (Math.min(W, H) * 0.42 / extent) * this.zoom;
    const P = { x: 0, y: 0, z: 0 };
    const Q = { x: 0, y: 0, z: 0 };
    const rel = (b: CelestialBody) => b.globalPositionAt(t, new Vector3()).sub(fpos);
    // body disc: sunlit hemisphere, terminator and graticule
    this.project(_a.set(0, 0, 0), scale, P);
    const rpx = Math.max(3, focus.radius * scale);
    this.drawBody(focus, fpos, t, P.x, P.y, rpx, scale);
    if (focus.atmosphereTop > 0) {
      c.strokeStyle = 'rgba(120,180,255,0.35)';
      c.lineWidth = 1;
      c.beginPath(); c.arc(P.x, P.y, (focus.radius + focus.atmosphereTop) * scale, 0, Math.PI * 2); c.stroke();
    }
    this.label(focus.name, P.x, P.y + rpx + 16, '#8b94a5');
    const disc = { x: P.x, y: P.y, r: rpx };
    // child bodies and their orbits
    for (const ch of focus.children) {
      const p = rel(ch);
      const r = p.length();
      // orbit circle (approx: in the plane of the current position & velocity)
      c.strokeStyle = 'rgba(255,255,255,0.12)';
      c.lineWidth = 1;
      c.beginPath();
      const vel = new Vector3();
      const pr = new Vector3();
      ch.localStateAt(t, pr, vel);
      const nrm = new Vector3().crossVectors(pr, vel).normalize();
      const u = pr.clone().normalize();
      const w = new Vector3().crossVectors(nrm, u);
      for (let k = 0; k <= 128; k++) {
        const ang = (k / 128) * Math.PI * 2;
        const q = u.clone().multiplyScalar(Math.cos(ang) * r).addScaledVector(w, Math.sin(ang) * r);
        this.project(q, scale, Q);
        if (k === 0) c.moveTo(Q.x, Q.y); else c.lineTo(Q.x, Q.y);
      }
      c.stroke();
      this.project(p, scale, Q);
      c.fillStyle = `rgb(${ch.def.color.map((x) => x * 255).join(',')})`;
      c.beginPath(); c.arc(Q.x, Q.y, Math.max(3, ch.radius * scale), 0, Math.PI * 2); c.fill();
      // SOI
      const soi = ch.soi;
      if (soi && soi * scale > 6) {
        c.strokeStyle = 'rgba(179,148,255,0.25)';
        c.setLineDash([4, 6]);
        c.beginPath(); c.arc(Q.x, Q.y, soi * scale, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
      }
      this.label(ch.name, Q.x, Q.y - 12, '#b394ff');
    }
    // vessel trajectory
    const flying = v.hasLiftedOff && !v.landed && !v.splashed;
    if (flying && (v.body === focus || v.body.parent === focus || focus.parent === v.body)) this.drawTrajectory(v, focus, fpos, scale);
    // other vessels
    for (const x of s.world.vessels) {
      if (x === v || x.destroyed) continue;
      const p = x.pos.clone().add(x.body.globalPositionAt(t, new Vector3())).sub(fpos);
      this.project(p, scale, Q);
      c.fillStyle = 'rgba(139,148,165,0.8)';
      c.fillRect(Q.x - 2, Q.y - 2, 4, 4);
    }
    // vessel marker
    const vp = v.pos.clone().add(v.body.globalPositionAt(t, new Vector3())).sub(fpos);
    this.project(vp, scale, Q);
    c.strokeStyle = '#ffb04a';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(Q.x, Q.y - 8); c.lineTo(Q.x + 7, Q.y + 6); c.lineTo(Q.x - 7, Q.y + 6); c.closePath();
    c.stroke();
    this.label(v.name, Q.x + 12, Q.y - 10, '#ffb04a', 'left');
    // the marker itself is in the way of later labels too
    this.labelRects.push({ x0: Q.x - 9, y0: Q.y - 10, x1: Q.x + 9, y1: Q.y + 8 });
    // where the entry is headed: a planned landing site or recovery zone, turning with the Earth
    this.drawLandingTarget(focus, t, scale, disc.x, disc.y, disc.r);
    // info panel
    const R = v.body.radius;
    const per = o.e < 1 ? 2 * Math.PI * Math.sqrt(Math.pow(o.a, 3) / v.body.gm) : NaN;
    const sub = o.periapsis < R;
    const [ap, apu] = o.e < 1 ? fmtDist(o.apoapsis - R) : ['∞', 'escape'];
    const [pe, peu] = fmtDist(o.periapsis - R);
    v.body.orientationAt(t, _q);
    const inc = (Math.acos(Math.max(-1, Math.min(1, o.W.dot(_a.set(0, 0, 1).applyQuaternion(_q))))) * 180) / Math.PI;
    this.info.innerHTML = '';
    const row = (k: string, val: string) => this.info.appendChild(h('div', { class: 'tel', style: 'width:260px' }, h('span', { class: 'label' }, k), h('span', { class: 'value', style: 'font-size:14px' }, val)));
    row('Reference', v.body.name);
    if (v.landed || v.splashed || (!v.hasLiftedOff && s.phase === 'countdown')) {
      row('Status', v.splashed ? 'Splashed down' : s.phase === 'countdown' ? 'On the pad' : 'Landed');
      row('Surface speed', `${v.telemetry.speedSurface.toFixed(1)} m/s`);
    } else {
      row('Status', o.e >= 1 ? 'Escape trajectory' : sub ? 'Sub-orbital' : 'In orbit');
      row('Apoapsis', `${ap} ${apu}`);
      row('Periapsis', sub ? 'below the surface' : `${pe} ${peu}`);
      row('Inclination', `${inc.toFixed(2)}°`);
      row('Eccentricity', o.e.toFixed(4));
      row('Period', isNaN(per) || sub ? '—' : fmtTime(per));
      row('Speed', `${(v.vel.length() / 1000).toFixed(3)} km/s`);
    }
  }

  private drawLandingTarget(focus: CelestialBody, t: number, scale: number, cx: number, cy: number, rpx: number): void {
    const s = this.s;
    const v = s.active;
    const ap = s.autopilot;
    const eg = ap.mode === 'entry' ? ap.entryGuidance : null;
    const dir = eg?.target ?? ap.entryTarget;
    if (!dir || focus.id !== 'earth' || v.landed || v.splashed || v.destroyed || rpx < 12) return;
    focus.orientationAt(t, _q);
    const w = dir.clone().applyQuaternion(_q).multiplyScalar(focus.radius);
    const Q = { x: 0, y: 0, z: 0 };
    this.project(w, scale, Q);
    // on the far side of the globe: nothing to point at
    if (Q.z < 0 && (Q.x - cx) ** 2 + (Q.y - cy) ** 2 < rpx * rpx) return;
    const c = this.ctx;
    const pulse = 0.6 + 0.4 * Math.sin(this.time * 3);
    c.globalAlpha = 1;
    c.setLineDash([]);
    c.strokeStyle = '#7dffb0';
    c.lineWidth = 2;
    c.beginPath(); c.arc(Q.x, Q.y, 5, 0, Math.PI * 2); c.stroke();
    c.globalAlpha = pulse * 0.6;
    c.beginPath(); c.arc(Q.x, Q.y, 9 + 3 * pulse, 0, Math.PI * 2); c.stroke();
    c.globalAlpha = 1;
    const name = eg?.designated ? 'the recovery zone' : ap.entryTargetName ?? 'the landing site';
    this.label(name.replace(/^the /, '').replace(/^./, (m) => m.toUpperCase()), Q.x + 12, Q.y - 8, '#7dffb0', 'left');
  }

  /** A lit globe: night side, the sunlit part bounded by the projected terminator, limb shading, graticule. */
  private drawBody(b: CelestialBody, fpos: Vector3, t: number, cx: number, cy: number, r: number, scale: number): void {
    const c = this.ctx;
    const [cr, cg, cb] = b.def.color;
    const rgb = (k: number, a = 1) => `rgba(${Math.round(Math.min(255, cr * 255 * k))},${Math.round(Math.min(255, cg * 255 * k))},${Math.round(Math.min(255, cb * 255 * k))},${a})`;
    if (b.id === 'sun') {
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, r * 1.6);
      g.addColorStop(0, 'rgba(255,244,220,1)'); g.addColorStop(0.62, 'rgba(255,214,150,0.95)'); g.addColorStop(1, 'rgba(255,180,90,0)');
      c.fillStyle = g;
      c.beginPath(); c.arc(cx, cy, r * 1.6, 0, Math.PI * 2); c.fill();
      return;
    }
    if (this.drawTexturedGlobe(b, fpos, t, cx, cy, r)) return;
    // night side
    c.fillStyle = rgb(0.16, 0.95);
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    // sun direction in view space (the Sun sits at the heliocentric origin)
    const sd = _a.copy(fpos).negate().normalize();
    const cyw = Math.cos(this.yaw), syw = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const x1 = sd.x * cyw - sd.y * syw, y1 = sd.x * syw + sd.y * cyw;
    const sx = x1, sy = y1 * cp - sd.z * sp, sz = y1 * sp + sd.z * cp;
    const phi = Math.atan2(sy, sx);
    // lit region: the sunward half of the disc plus (or minus) half the terminator ellipse
    const k = -sz * r;
    const cph = Math.cos(phi), sph = Math.sin(phi);
    c.save();
    c.beginPath();
    c.arc(cx, cy, r, phi - Math.PI / 2, phi + Math.PI / 2);
    for (let i = 0; i <= 48; i++) {
      const a = Math.PI / 2 - (i / 48) * Math.PI;
      const lx = k * Math.cos(a), ly = r * Math.sin(a);
      c.lineTo(cx + lx * cph - ly * sph, cy + lx * sph + ly * cph);
    }
    c.closePath();
    const g = c.createRadialGradient(cx + cph * r * 0.35, cy + sph * r * 0.35, r * 0.05, cx, cy, r * 1.05);
    g.addColorStop(0, rgb(1.25));
    g.addColorStop(0.7, rgb(0.85));
    g.addColorStop(1, rgb(0.45));
    c.fillStyle = g;
    c.fill();
    c.restore();
    // graticule on the near hemisphere (body-fixed, so it turns with the planet)
    if (r > 24) {
      b.orientationAt(t, _q);
      const P = { x: 0, y: 0, z: 0 };
      const pt = new Vector3();
      const line = (f: (u: number) => [number, number], strong: boolean) => {
        c.strokeStyle = strong ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.09)';
        c.lineWidth = 1;
        c.beginPath();
        let pen = false;
        for (let i = 0; i <= 72; i++) {
          const [la, lo] = f(i / 72);
          pt.set(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)).multiplyScalar(b.radius).applyQuaternion(_q);
          this.project(pt, scale, P);
          if (P.z < 0) { pen = false; continue; }
          if (!pen) { c.moveTo(P.x, P.y); pen = true; } else c.lineTo(P.x, P.y);
        }
        c.stroke();
      };
      for (let lat = -60; lat <= 60; lat += 30) line((u) => [(lat * Math.PI) / 180, u * Math.PI * 2], lat === 0);
      for (let lon = 0; lon < 360; lon += 30) line((u) => [(u - 0.5) * Math.PI, (lon * Math.PI) / 180], lon === 0);
    }
    // rim
    c.strokeStyle = rgb(1.1, 0.5);
    c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
  }

  /**
   * Earth and Moon as real globes: each pixel of the disc is unprojected through the view, turned
   * into the body-fixed frame and coloured from the surface map, lit by the Sun (with a soft
   * terminator and a little earthshine-like fill). Rendered at up to 280 px and scaled up.
   */
  private drawTexturedGlobe(b: CelestialBody, fpos: Vector3, t: number, cx: number, cy: number, r: number): boolean {
    const map = surfaceMap(b.id);
    if (!map || r < 6) return false;
    const c = this.ctx;
    const res = Math.max(32, Math.min(280, Math.round(r * 2)));
    const key = `${b.id}|${res}|${this.yaw.toFixed(3)}|${this.pitch.toFixed(3)}`;
    // the planet turns and the Sun moves slowly: refresh at most twice a second unless the view changed
    if (!this.globe || this.globe.key !== key || this.time - this.globe.at > 0.5) {
      const cv = this.globe?.canvas ?? document.createElement('canvas');
      cv.width = res; cv.height = res;
      const gx = cv.getContext('2d')!;
      const img = gx.createImageData(res, res);
      const d = img.data, src = map.data, W = map.width, H = map.height;
      const cyw = Math.cos(this.yaw), syw = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      // inertial -> body-fixed rotation, and the Sun direction (heliocentric origin)
      b.orientationAt(t, _q);
      const qi = _q.clone().invert();
      const sun = _a.copy(fpos).negate().normalize();
      const sx0 = sun.x, sy0 = sun.y, sz0 = sun.z;
      const m = new Matrix4().makeRotationFromQuaternion(qi).elements;
      const hazy = b.atmosphereTop > 0;
      // city lights on the Earth's night side (same 1024 x 512 grid as the day map)
      const night = b.id === 'earth' ? surfaceMap('earth_night') : null;
      const nd = night && night.width === W && night.height === H ? night.data : null;
      for (let j = 0; j < res; j++) {
        const y2 = (j + 0.5) / res * 2 - 1;
        for (let i = 0; i < res; i++) {
          const x1 = (i + 0.5) / res * 2 - 1;
          const rr = x1 * x1 + y2 * y2;
          const o = (j * res + i) * 4;
          if (rr > 1) { d[o + 3] = 0; continue; }
          const z2 = Math.sqrt(1 - rr);
          // undo the map's tilt and yaw (see project())
          const y1 = y2 * cp + z2 * sp;
          const pz = -y2 * sp + z2 * cp;
          const px = x1 * cyw + y1 * syw;
          const py = -x1 * syw + y1 * cyw;
          // body-fixed direction -> lat/lon -> texel
          const fx = m[0] * px + m[4] * py + m[8] * pz, fy = m[1] * px + m[5] * py + m[9] * pz, fz = m[2] * px + m[6] * py + m[10] * pz;
          const lon = Math.atan2(fy, fx), lat = Math.asin(Math.max(-1, Math.min(1, fz)));
          const u = Math.min(W - 1, Math.max(0, Math.floor((lon / (2 * Math.PI) + 0.5) * W)));
          const v = Math.min(H - 1, Math.max(0, Math.floor((0.5 - lat / Math.PI) * H)));
          const k = (v * W + u) * 4;
          // sunlight with a soft terminator; the night side keeps a faint blue fill
          const ndl = px * sx0 + py * sy0 + pz * sz0;
          const day = Math.max(0, Math.min(1, ndl * 3 + 0.15));
          const light = 0.07 + 0.93 * day * (0.55 + 0.45 * Math.max(0, ndl));
          // limb darkening toward the edge of the disc
          const limb = 0.75 + 0.25 * z2;
          // daylit air scatters blue over the dark oceans, more toward the limb
          const haze = hazy ? day * (1.5 - z2 * 0.8) : 0;
          const lights = nd ? (1 - day) * (1 - day) * 1.15 : 0;
          d[o] = Math.min(255, src[k] * light * limb + 6 * (1 - day) + 14 * haze + (nd ? nd[k] * lights : 0));
          d[o + 1] = Math.min(255, src[k + 1] * light * limb + 9 * (1 - day) + 30 * haze + (nd ? nd[k + 1] * lights * 0.85 : 0));
          d[o + 2] = Math.min(255, src[k + 2] * light * limb + 18 * (1 - day) + 62 * haze + (nd ? nd[k + 2] * lights * 0.6 : 0));
          d[o + 3] = 255;
        }
      }
      gx.putImageData(img, 0, 0);
      this.globe = { canvas: cv, key, at: this.time };
    }
    c.save();
    c.imageSmoothingEnabled = true;
    c.drawImage(this.globe.canvas, cx - r, cy - r, r * 2, r * 2);
    c.restore();
    // a thin atmosphere glow on the sunward limb of the Earth
    if (b.atmosphereTop > 0) {
      c.strokeStyle = 'rgba(120,180,255,0.45)';
      c.lineWidth = Math.max(1, r * 0.02);
      c.beginPath(); c.arc(cx, cy, r * 1.005, 0, Math.PI * 2); c.stroke();
    }
    return true;
  }

  private drawTrajectory(v: import('../physics/vessel').Vessel, focus: CelestialBody, fpos: Vector3, scale: number): void {
    const c = this.ctx;
    const s = this.s;
    const t0 = s.world.t;
    const o = v.updateOrbit(t0);
    const mu = v.body.gm;
    const period = o.e < 1 ? 2 * Math.PI * Math.sqrt(Math.pow(o.a, 3) / mu) : Infinity;
    const span = Math.min(isFinite(period) ? period : 1e9, v.body.id === 'earth' ? 12 * 86400 : 6e6);
    const steps = 360;
    const r = v.pos.clone(), vel = v.vel.clone();
    const outR = new Vector3(), outV = new Vector3();
    // a body's position relative to the map's focus at the same instant (the focus moves too:
    // relative to its position now, a 90-minute orbit would smear 160,000 km along Earth's path)
    const relAt = (b: CelestialBody, tt: number) => b === focus ? new Vector3() : b.globalPositionAt(tt, new Vector3()).sub(focus.globalPositionAt(tt, new Vector3()));
    const P = { x: 0, y: 0, z: 0 };
    let body = v.body;
    let base = r.clone(), baseV = vel.clone(), baseT = t0;
    // segments behind the focus body are drawn faint and dashed (the far side of the orbit)
    const C0 = { x: 0, y: 0, z: 0 };
    this.project(_a.set(0, 0, 0), scale, C0);
    const rDisc = focus.radius * scale;
    let color = '#5fd2ff';
    let last: { x: number; y: number; hidden: boolean } | null = null;
    const seg = (x: number, y: number, z: number) => {
      const hidden = z < 0 && (x - C0.x) ** 2 + (y - C0.y) ** 2 < rDisc * rDisc;
      if (last) {
        const dim = hidden || last.hidden;
        c.globalAlpha = dim ? 0.25 : 1;
        c.setLineDash(dim ? [3, 5] : []);
        c.strokeStyle = color;
        c.lineWidth = dim ? 1.5 : 2;
        c.beginPath(); c.moveTo(last.x, last.y); c.lineTo(x, y); c.stroke();
      }
      last = { x, y, hidden };
    };
    let apT = NaN, peT = NaN;
    let prevR = r.length(), prevD = 0;
    for (let i = 0; i <= steps; i++) {
      const tt = t0 + (i / steps) * span;
      keplerPropagate(base, baseV, body.gm, tt - baseT, outR, outV);
      // ground impact: mark where and when the trajectory meets the surface
      if (outR.length() < body.radius && i > 0) {
        const world = outR.clone().setLength(body.radius).add(relAt(body, tt));
        this.project(world, scale, P);
        seg(P.x, P.y, P.z);
        c.globalAlpha = 1; c.setLineDash([]);
        c.strokeStyle = '#ff6b5a';
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(P.x - 5, P.y - 5); c.lineTo(P.x + 5, P.y + 5); c.moveTo(P.x + 5, P.y - 5); c.lineTo(P.x - 5, P.y + 5);
        c.stroke();
        this.label(`Impact · T−${fmtTime(tt - t0)}`, P.x + 10, P.y + 4, '#ff6b5a', 'left');
        last = null;
        break;
      }
      // SOI change (Moon from Earth)
      if (body.id === 'earth') {
        const moon = s.system.moon;
        const mp = moon.globalPositionAt(tt, new Vector3()).sub(body.globalPositionAt(tt, new Vector3()));
        if (outR.distanceTo(mp) < moon.soi) {
          // switch to moon-relative conic
          const mv = new Vector3(); const mr = new Vector3();
          moon.localStateAt(tt, mr, mv);
          base = outR.clone().sub(mr); baseV = outV.clone().sub(mv); baseT = tt; body = moon;
          color = '#b394ff';
          last = null;
          continue;
        }
      } else if (body.id === 'moon' && outR.length() > body.soi) {
        const mv = new Vector3(); const mr = new Vector3();
        body.localStateAt(tt, mr, mv);
        base = outR.clone().add(mr); baseV = outV.clone().add(mv); baseT = tt; body = s.system.earth;
        color = '#5fd2ff';
        last = null;
        continue;
      }
      const world = outR.clone().add(relAt(body, tt));
      this.project(world, scale, P);
      seg(P.x, P.y, P.z);
      const rr = outR.length();
      const d = rr - prevR;
      if (i > 1 && prevD > 0 && d <= 0 && isNaN(apT) && body === v.body) apT = tt;
      if (i > 1 && prevD < 0 && d >= 0 && isNaN(peT) && body === v.body) peT = tt;
      prevD = d; prevR = rr;
    }
    c.globalAlpha = 1;
    c.setLineDash([]);
    // apsis markers
    const mark = (tt: number, label: string) => {
      if (isNaN(tt)) return;
      keplerPropagate(v.pos, v.vel, mu, tt - t0, outR, outV);
      const world = outR.clone().add(relAt(v.body, tt));
      this.project(world, scale, P);
      c.fillStyle = '#5fd2ff';
      c.beginPath(); c.arc(P.x, P.y, 4, 0, Math.PI * 2); c.fill();
      const [d, u] = fmtDist(outR.length() - v.body.radius);
      this.label(`${label} ${d} ${u} · T−${fmtTime(tt - t0)}`, P.x + 10, P.y + 4, '#5fd2ff', 'left');
    };
    mark(apT, 'Ap');
    mark(peT, 'Pe');
    void _q;
  }

  /** labels drawn this frame (screen rectangles), so later ones step aside instead of overprinting */
  private labelRects: { x0: number; y0: number; x1: number; y1: number }[] = [];

  private label(text: string, x: number, y: number, color: string, align: CanvasTextAlign = 'center'): void {
    const c = this.ctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = Math.round(11 * dpr);
    c.font = `600 ${size}px "Barlow Condensed", sans-serif`;
    const t = text.toUpperCase();
    const w = c.measureText(t).width;
    const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    // several markers can sit on one spot (a vessel just off the pad: the vessel, apoapsis and
    // impact): stack their labels downward
    let yy = y;
    for (let k = 0; k < 6; k++) {
      const hit = this.labelRects.some((r) => x0 < r.x1 && x0 + w > r.x0 && yy - size < r.y1 && yy + 2 > r.y0);
      if (!hit) break;
      yy += size + 3;
    }
    this.labelRects.push({ x0, y0: yy - size, x1: x0 + w, y1: yy + 2 });
    c.fillStyle = color;
    c.textAlign = align;
    c.fillText(t, x, yy);
  }
}
