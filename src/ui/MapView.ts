import { Quaternion, Vector3 } from 'three';
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
    // body disc
    this.project(_a.set(0, 0, 0), scale, P);
    const rpx = Math.max(3, focus.radius * scale);
    const [cr, cg, cb] = focus.def.color;
    const grad = c.createRadialGradient(P.x - rpx * 0.3, P.y - rpx * 0.3, rpx * 0.1, P.x, P.y, rpx);
    grad.addColorStop(0, `rgba(${cr * 255},${cg * 255},${cb * 255},0.95)`);
    grad.addColorStop(1, `rgba(${cr * 90},${cg * 90},${cb * 110},0.9)`);
    c.fillStyle = grad;
    c.beginPath(); c.arc(P.x, P.y, rpx, 0, Math.PI * 2); c.fill();
    if (focus.atmosphereTop > 0) {
      c.strokeStyle = 'rgba(120,180,255,0.35)';
      c.lineWidth = 1;
      c.beginPath(); c.arc(P.x, P.y, (focus.radius + focus.atmosphereTop) * scale, 0, Math.PI * 2); c.stroke();
    }
    this.label(focus.name, P.x, P.y + rpx + 16, '#8b94a5');
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
    if (v.body === focus || v.body.parent === focus || focus.parent === v.body) this.drawTrajectory(v, focus, fpos, scale);
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
    // info panel
    const R = v.body.radius;
    const per = o.e < 1 ? 2 * Math.PI * Math.sqrt(Math.pow(o.a, 3) / v.body.gm) : NaN;
    const [ap, apu] = o.e < 1 ? fmtDist(o.apoapsis - R) : ['∞', ''];
    const [pe, peu] = fmtDist(o.periapsis - R);
    this.info.innerHTML = '';
    const row = (k: string, val: string) => this.info.appendChild(h('div', { class: 'tel', style: 'width:260px' }, h('span', { class: 'label' }, k), h('span', { class: 'value', style: 'font-size:14px' }, val)));
    row('Reference', v.body.name);
    row('Apoapsis', `${ap} ${apu}`);
    row('Periapsis', `${pe} ${peu}`);
    row('Eccentricity', o.e.toFixed(4));
    row('Period', isNaN(per) ? '—' : fmtTime(per));
    row('Speed', `${(v.vel.length() / 1000).toFixed(3)} km/s`);
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
    const bodyPos0 = v.body.globalPositionAt(t0, new Vector3());
    const P = { x: 0, y: 0, z: 0 };
    let body = v.body;
    let base = r.clone(), baseV = vel.clone(), baseT = t0;
    c.lineWidth = 2;
    c.strokeStyle = '#5fd2ff';
    c.beginPath();
    let moved = false;
    let apT = NaN, peT = NaN;
    let prevR = r.length(), prevD = 0;
    for (let i = 0; i <= steps; i++) {
      const tt = t0 + (i / steps) * span;
      keplerPropagate(base, baseV, body.gm, tt - baseT, outR, outV);
      // ground / atmosphere impact
      if (outR.length() < body.radius) break;
      // SOI change (Moon from Earth)
      if (body.id === 'earth') {
        const moon = s.system.moon;
        const mp = moon.globalPositionAt(tt, new Vector3()).sub(body.globalPositionAt(tt, new Vector3()));
        if (outR.distanceTo(mp) < moon.soi) {
          // switch to moon-relative conic
          const mv = new Vector3(); const mr = new Vector3();
          moon.localStateAt(tt, mr, mv);
          base = outR.clone().sub(mr); baseV = outV.clone().sub(mv); baseT = tt; body = moon;
          c.stroke();
          c.strokeStyle = '#b394ff';
          c.beginPath();
          moved = false;
          continue;
        }
      } else if (body.id === 'moon' && outR.length() > body.soi) {
        const mv = new Vector3(); const mr = new Vector3();
        body.localStateAt(tt, mr, mv);
        base = outR.clone().add(mr); baseV = outV.clone().add(mv); baseT = tt; body = s.system.earth;
        c.stroke();
        c.strokeStyle = '#5fd2ff';
        c.beginPath();
        moved = false;
        continue;
      }
      const world = outR.clone().add(body.globalPositionAt(tt, new Vector3())).sub(fpos);
      this.project(world, scale, P);
      if (!moved) { c.moveTo(P.x, P.y); moved = true; } else c.lineTo(P.x, P.y);
      const rr = outR.length();
      const d = rr - prevR;
      if (i > 1 && prevD > 0 && d <= 0 && isNaN(apT) && body === v.body) apT = tt;
      if (i > 1 && prevD < 0 && d >= 0 && isNaN(peT) && body === v.body) peT = tt;
      prevD = d; prevR = rr;
    }
    c.stroke();
    void bodyPos0;
    // apsis markers
    const mark = (tt: number, label: string) => {
      if (isNaN(tt)) return;
      keplerPropagate(v.pos, v.vel, mu, tt - t0, outR, outV);
      const world = outR.clone().add(v.body.globalPositionAt(tt, new Vector3())).sub(fpos);
      this.project(world, scale, P);
      c.fillStyle = '#5fd2ff';
      c.beginPath(); c.arc(P.x, P.y, 4, 0, Math.PI * 2); c.fill();
      const [d, u] = fmtDist(outR.length() - v.body.radius);
      this.label(`${label} ${d} ${u} · T−${fmtTime(tt - t0)}`, P.x + 10, P.y + 4, '#5fd2ff', 'left');
    };
    mark(apT, 'Ap');
    mark(peT, 'Pe');
    void focus;
    void _q;
  }

  private label(text: string, x: number, y: number, color: string, align: CanvasTextAlign = 'center'): void {
    const c = this.ctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.font = `600 ${Math.round(11 * dpr)}px "Barlow Condensed", sans-serif`;
    c.fillStyle = color;
    c.textAlign = align;
    c.fillText(text.toUpperCase(), x, y);
  }
}
