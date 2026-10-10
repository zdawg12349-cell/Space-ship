import { Quaternion, Vector3 } from 'three';
import { AUTOPILOT_LABELS } from '../game/Autopilot';
import type { FlightSession } from '../game/FlightSession';
import { IGNITION_STEPS, LaunchSequence } from '../game/LaunchSequence';
import { WARP_LEVELS } from '../physics/world';
import { CAMERA_LABELS } from '../camera/CameraDirector';
import { KEY_HELP } from '../game/Input';
import { clear, fmtDist, fmtSpeed, h } from './dom';

/**
 * Flight HUD: mission clock, telemetry, staging stack, propellant, engine status, navball,
 * throttle, autopilot, warp, banners, radio subtitles, event log and the ignition sequence
 * read-out during the count. Text refreshes at ~12 Hz; the navball and engine diagram redraw
 * every frame.
 */

const _q = new Quaternion();
const _v = new Vector3();
const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();

const PHASE_LABEL: Record<string, string> = {
  countdown: 'Terminal count', ascent: 'Powered ascent', upper: 'Upper stage flight', orbit: 'In orbit', coast: 'Coast', transfer: 'Transfer',
  entry: 'Atmospheric entry', descent: 'Descent', landed: 'Landed', splashed: 'Splashdown', destroyed: 'Vehicle lost',
};

export class HUD {
  readonly root: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private tel: Record<string, { v: HTMLElement; u: HTMLElement }> = {};
  private stagesEl: HTMLElement;
  private propEl: HTMLElement;
  private recoveryEl: HTMLElement;
  private logEl: HTMLElement;
  private bannerEl: HTMLElement;
  private subEl: HTMLElement;
  private ignitionEl: HTMLElement;
  private cdBig: HTMLElement;
  private navball: HTMLCanvasElement;
  private navCtx: CanvasRenderingContext2D;
  private navImg: ImageData | null = null;
  private engCanvas: HTMLCanvasElement;
  private engCtx: CanvasRenderingContext2D;
  private throttleBar: HTMLElement;
  private apPanel: HTMLElement;
  private objEl: HTMLElement;
  private keysEl: HTMLElement;
  private leftEl!: HTMLElement;
  private navEl!: HTMLElement;
  private navKey = '';
  onNavAction: ((id: string) => void) | null = null;
  private textTimer = 0;
  private bannerTimer = 0;
  private subTimer = 0;
  private lastStageKey = '';
  visible = true;
  /** show subtitles even in cinematic mode */
  subtitlesAlways = true;
  onAutopilot: ((mode: string) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = h('div', { id: 'hud' });
    const tl = h('div', { class: 'hud-tl' },
      (this.els.mission = h('div', { class: 'mission' })),
      (this.els.vehicle = h('div', { class: 'vehicle' })),
      (this.els.met = h('div', { class: 'met' })),
      (this.els.phase = h('div', { class: 'phase' })),
    );
    this.objEl = h('div', { class: 'objective-hud' });
    const tr = h('div', { class: 'hud-tr' },
      h('div', { style: 'display:flex;gap:10px;align-items:center' }, (this.els.cam = h('div', { class: 'chip' })), (this.els.warp = h('div', { class: 'warp' }))),
      (this.apPanel = h('div', { class: 'ap-panel interactive' })),
      (this.navEl = h('div', { class: 'nav-panel interactive' })),
      this.objEl,
    );
    for (const [mode, label] of [['off', 'MAN'], ['stability', 'SAS'], ['prograde', 'PRO'], ['retrograde', 'RETRO'], ['radial', 'RAD+'], ['antiradial', 'RAD−'], ['normal', 'NRM'], ['antinormal', 'ANRM'], ['heading', 'HDG'], ['altitude', 'ALT'], ['orbit', 'ORBIT']] as const) {
      const b = h('button', { class: 'btn small', 'data-mode': mode, title: AUTOPILOT_LABELS[mode] }, label);
      b.addEventListener('click', () => this.onAutopilot?.(mode));
      this.apPanel.appendChild(b);
    }
    const left = h('div', { class: 'hud-left' });
    const telRow = (key: string, label: string, big = false) => {
      const v = h('span', { class: 'value' }), u = h('span', { class: 'unit' });
      left.appendChild(h('div', { class: `tel${big ? ' big' : ''}` }, h('span', { class: 'label' }, label), h('span', {}, v, u)));
      this.tel[key] = { v, u };
    };
    telRow('alt', 'Altitude', true);
    telRow('vel', 'Velocity', true);
    telRow('vs', 'Vertical speed');
    telRow('dr', 'Downrange');
    telRow('mach', 'Mach');
    telRow('q', 'Dynamic pressure');
    telRow('g', 'Acceleration');
    telRow('ap', 'Apoapsis');
    telRow('pe', 'Periapsis');
    telRow('inc', 'Inclination');
    telRow('dv', 'Δv remaining');
    const right = h('div', { class: 'hud-right' },
      h('div', { class: 'label' }, 'Staging'),
      (this.stagesEl = h('div', { class: 'stages', style: 'margin-top:8px' })),
      (this.propEl = h('div', { class: 'prop' })),
      (this.recoveryEl = h('div', { class: 'recovery' })),
    );
    this.navball = h('canvas', { width: 170, height: 170 });
    this.navCtx = this.navball.getContext('2d')!;
    this.engCanvas = h('canvas', { width: 150, height: 150, class: 'engines' });
    this.engCtx = this.engCanvas.getContext('2d')!;
    this.throttleBar = h('div', {});
    const bottom = h('div', { class: 'hud-bottom' },
      h('div', {}, h('div', { class: 'label', style: 'text-align:center;margin-bottom:6px' }, 'Engines'), this.engCanvas),
      this.navball,
      h('div', {}, h('div', { class: 'label', style: 'margin-bottom:6px' }, 'Thr'), h('div', { class: 'throttle' }, this.throttleBar)),
    );
    this.bannerEl = h('div', { class: 'banner' }, h('div', { class: 'big' }), h('div', { class: 'small' }));
    this.subEl = h('div', { class: 'subtitles' }, h('div', { class: 'line' }));
    this.logEl = h('div', { class: 'log' });
    this.ignitionEl = h('div', { class: 'ignition' });
    IGNITION_STEPS.forEach((s, i) => this.ignitionEl.appendChild(h('div', { class: 'step' }, h('span', { class: 'n' }, String(i + 1).padStart(2, '0')), s)));
    this.cdBig = h('div', { class: 'countdown-big' });
    this.keysEl = h('div', { class: 'keys' });
    this.keysEl.innerHTML = `Stage<b>SPACE</b> · Throttle<b>⇧/CTRL</b> · Camera<b>C</b> · Map<b>M</b> · Cinematic<b>H</b> · Help<b>F1</b>`;
    this.leftEl = left;
    tr.appendChild(right);
    this.root.append(tl, tr, left, bottom, this.bannerEl, this.logEl, this.ignitionEl, this.cdBig, this.keysEl);
    parent.append(this.root, this.subEl);
  }

  dispose(): void { this.root.remove(); this.subEl.remove(); }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.classList.toggle('hidden', !v);
  }

  banner(big: string, small = '', seconds = 4): void {
    (this.bannerEl.children[0] as HTMLElement).textContent = big;
    (this.bannerEl.children[1] as HTMLElement).textContent = small;
    this.bannerEl.classList.add('show');
    this.bannerTimer = seconds;
  }

  subtitle(who: string, text: string, seconds: number): void {
    const line = this.subEl.children[0] as HTMLElement;
    clear(line);
    line.append(h('span', { class: 'who' }, who), text);
    line.classList.add('show');
    this.subTimer = seconds + 0.6;
  }

  log(text: string, met: number, level: string = 'info'): void {
    const sign = met < 0 ? '-' : '+';
    const a = Math.abs(met);
    const t = `T${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(Math.floor(a % 60)).padStart(2, '0')}`;
    this.logEl.prepend(h('div', { class: level }, h('span', { class: 't' }, t), text));
    while (this.logEl.children.length > 4) this.logEl.lastChild!.remove();
  }

  /** Contextual manoeuvre buttons + autopilot status / node read-out. */
  setNav(actions: { id: string; label: string; primary?: boolean }[], status: string, node: string): void {
    const key = actions.map((a) => a.id).join(',') + '|' + status + '|' + node;
    if (key === this.navKey) return;
    this.navKey = key;
    clear(this.navEl);
    if (node) this.navEl.appendChild(h('div', { class: 'node' }, node));
    if (status) this.navEl.appendChild(h('div', { class: 'ap-status' }, status));
    if (actions.length) {
      const row = h('div', { class: 'nav-buttons' });
      for (const a of actions) {
        const b = h('button', { class: `btn small${a.primary ? ' primary' : ''}` }, a.label);
        b.addEventListener('click', () => this.onNavAction?.(a.id));
        row.appendChild(b);
      }
      this.navEl.appendChild(row);
    }
  }

  setObjectives(items: { text: string; state: 'open' | 'done' | 'failed' }[]): void {
    clear(this.objEl);
    if (!items.length) return;
    const ul = h('ul', { class: 'objectives' });
    for (const it of items) ul.appendChild(h('li', { class: it.state === 'open' ? '' : it.state }, it.text));
    this.objEl.append(h('div', { class: 'label' }, 'Objectives'), ul);
  }

  update(s: FlightSession, dt: number, missionName: string): void {
    this.bannerTimer -= dt;
    if (this.bannerTimer <= 0) this.bannerEl.classList.remove('show');
    this.subTimer -= dt;
    if (this.subTimer <= 0) (this.subEl.children[0] as HTMLElement).classList.remove('show');
    this.subEl.style.display = this.visible || this.subtitlesAlways ? '' : 'none';
    if (!this.visible) return;
    this.drawNavball(s);
    this.drawEngines(s);
    const v = s.active;
    this.throttleBar.style.height = `${Math.round(v.controls.throttle * 100)}%`;
    this.textTimer -= dt;
    if (this.textTimer > 0) return;
    this.textTimer = 0.08;
    const tm = v.telemetry;
    this.els.mission.textContent = missionName;
    this.els.vehicle.textContent = s.def.name;
    this.els.met.textContent = LaunchSequence.format(s.met);
    this.els.phase.textContent = (s.seq.held ? 'HOLD · ' : '') + (PHASE_LABEL[s.phase] ?? s.phase);
    const warp = WARP_LEVELS[s.world.warpIndex];
    this.els.warp.textContent = warp > 1 ? `▶▶ ${warp}×` : '▶ 1×';
    this.els.warp.classList.toggle('on', warp > 1);
    this.els.cam.textContent = CAMERA_LABELS[s.director.mode];
    for (const b of Array.from(this.apPanel.children) as HTMLElement[]) b.classList.toggle('active', b.dataset.mode === s.autopilot.mode);
    // telemetry
    const set = (k: string, pair: [string, string]) => { const t = this.tel[k]; if (t.v.textContent !== pair[0]) t.v.textContent = pair[0]; if (t.u.textContent !== pair[1]) t.u.textContent = pair[1]; };
    set('alt', fmtDist(tm.altitude));
    const orbital = tm.altitude > 40_000 || !tm.inAtmosphere;
    set('vel', fmtSpeed(orbital ? tm.speedOrbital : tm.speedSurface));
    this.tel.vel.u.textContent += orbital ? ' orb' : ' srf';
    set('vs', fmtSpeed(tm.verticalSpeed));
    set('dr', fmtDist(tm.downrange));
    set('mach', [tm.inAtmosphere ? tm.mach.toFixed(2) : '—', '']);
    set('q', [(tm.dynamicPressure / 1000).toFixed(1), 'kPa']);
    set('g', [tm.gForce.toFixed(2), 'g']);
    const o = v.updateOrbit(s.world.t);
    const R = v.body.radius;
    const launched = v.hasLiftedOff || s.phase !== 'countdown';
    if (!launched) { set('ap', ['—', '']); set('pe', ['—', '']); }
    else {
      if (o.e < 1) set('ap', fmtDist(o.apoapsis - R)); else set('ap', ['∞', 'escape']);
      set('pe', o.periapsis - R < 0 ? ['sub-orbital', ''] : fmtDist(o.periapsis - R));
    }
    // inclination relative to the body's equator (the inertial frame is ecliptic)
    v.body.orientationAt(s.world.t, _q);
    const pole = _v.set(0, 0, 1).applyQuaternion(_q);
    set('inc', [(Math.acos(Math.max(-1, Math.min(1, o.W.dot(pole)))) * 180 / Math.PI).toFixed(1), '°']);
    set('dv', [v.deltaV().total.toFixed(0), 'm/s']);
    // countdown / ignition sequence
    const counting = s.phase === 'countdown' || (s.met < 15 && s.seq.step > 0 && s.seq.step < 13);
    const showIgn = counting && s.met > -15;
    // the checklist takes the telemetry column's place until the tower is cleared
    this.ignitionEl.classList.toggle('show', showIgn);
    this.leftEl.classList.toggle('soft-hide', showIgn);
    Array.from(this.ignitionEl.children).forEach((c, i) => c.classList.toggle('on', s.seq.step > i));
    const T = s.met;
    const showBig = s.phase === 'countdown' && T > -10.5 && T < 0;
    this.cdBig.classList.toggle('show', showBig);
    if (showBig) this.cdBig.textContent = String(Math.ceil(-T));
    this.updateStages(s);
  }

  private updateStages(s: FlightSession): void {
    const v = s.active;
    const key = `${v.id}:${v.stageIndex}:${v.staging.length}`;
    if (key !== this.lastStageKey) {
      this.lastStageKey = key;
      clear(this.stagesEl);
      v.staging.forEach((g, i) => {
        if (i < v.stageIndex - 2) return;
        const cls = i < v.stageIndex ? 'stage done' : i === v.stageIndex ? 'stage next' : 'stage';
        this.stagesEl.appendChild(h('div', { class: cls }, h('span', { class: 'k' }, i === v.stageIndex ? 'NEXT' : String(i + 1)), g.map((e) => e.label).join(' · ')));
      });
      if (v.stageIndex >= v.staging.length) this.stagesEl.appendChild(h('div', { class: 'stage' }, 'No stages remaining'));
    }
    // propellant per engine-bearing assembly
    clear(this.propEl);
    for (const a of v.assemblies) {
      if (!a.engines.length || a.propellantCapacity <= 0) continue;
      const f = a.fuelFraction;
      const solid = a.engines.some((e) => e.isSolid);
      const running = a.engines.some((e) => e.running);
      this.propEl.appendChild(h('div', { class: 'row' }, h('span', { class: 'label', style: running ? 'color:var(--text)' : '' }, a.def.name), h('span', { class: 'value', style: 'font-size:12px' }, `${(f * 100).toFixed(0)}%`)));
      const bar = h('div', { class: `bar${solid ? ' solid' : ''}` }, h('div', { style: `width:${(f * 100).toFixed(1)}%` }));
      this.propEl.appendChild(bar);
    }
    // booster recovery
    clear(this.recoveryEl);
    if (s.boosters.length) {
      this.recoveryEl.appendChild(h('div', { class: 'label' }, 'Recovery'));
      for (const b of s.boosters) {
        const st = b.v.destroyed ? 'LOST' : b.v.landed ? 'LANDED' : b.g.phase.toUpperCase();
        this.recoveryEl.appendChild(h('div', { class: 'item' }, h('b', {}, b.zone.id), h('span', { style: b.v.destroyed ? 'color:var(--red)' : b.v.landed ? 'color:var(--green)' : '' }, `${st} · ${(b.v.telemetry.altitude / 1000).toFixed(1)} km`)));
      }
    }
  }

  private drawNavball(s: FlightSession): void {
    const c = this.navCtx;
    const W = this.navball.width, H = this.navball.height;
    const R = W / 2 - 6;
    const v = s.active;
    if (!this.navImg) this.navImg = c.createImageData(W, H);
    const img = this.navImg;
    const d = img.data;
    // vehicle basis in world (right = +X, screen-up = -Z roof, forward = +Y nose)
    v.enuBasis(_e, _n, _u);
    _q.copy(v.rot);
    const rx = new Vector3(1, 0, 0).applyQuaternion(_q), ry = new Vector3(0, 0, -1).applyQuaternion(_q), rz = new Vector3(0, 1, 0).applyQuaternion(_q);
    const cx = W / 2, cy = H / 2;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const o = (py * W + px) * 4;
        const x = (px - cx) / R, y = -(py - cy) / R;
        const r2 = x * x + y * y;
        if (r2 > 1) { d[o + 3] = 0; continue; }
        const z = Math.sqrt(1 - r2);
        // world direction of this point on the ball
        const wx = rx.x * x + ry.x * y + rz.x * z, wy = rx.y * x + ry.y * y + rz.y * z, wz = rx.z * x + ry.z * y + rz.z * z;
        const up = wx * _u.x + wy * _u.y + wz * _u.z;
        const ea = wx * _e.x + wy * _e.y + wz * _e.z, no = wx * _n.x + wy * _n.y + wz * _n.z;
        const elev = Math.asin(Math.max(-1, Math.min(1, up)));
        const hd = Math.atan2(ea, no);
        const shade = 0.55 + 0.45 * z;
        let r: number, g: number, b: number;
        if (up >= 0) { r = 38; g = 96 + 40 * up; b = 150 + 60 * up; } else { r = 120 + 30 * up; g = 82 + 20 * up; b = 52; }
        // grid: every 10° of pitch, every 30° of heading, horizon line
        const pl = Math.abs(elev * 57.2958) % 10;
        const hl = Math.abs((hd * 57.2958 + 360) % 30);
        let line = 0;
        if (pl < 0.6 || pl > 9.4) line = 0.35;
        if ((hl < 0.8 || hl > 29.2) && Math.abs(up) < 0.97) line = Math.max(line, 0.25);
        if (Math.abs(up) < 0.012) line = 1;
        r = r + (235 - r) * line; g = g + (235 - g) * line; b = b + (235 - b) * line;
        const edge = r2 > 0.92 ? 0.6 : 1;
        d[o] = r * shade * edge; d[o + 1] = g * shade * edge; d[o + 2] = b * shade * edge; d[o + 3] = 255;
      }
    }
    c.clearRect(0, 0, W, H);
    c.putImageData(img, 0, 0);
    // markers
    const mark = (dir: Vector3, kind: 'pro' | 'retro' | 'target') => {
      const fx = dir.dot(rx), fy = dir.dot(ry), fz = dir.dot(rz);
      if (fz < 0) return;
      const sx = cx + fx * R, sy = cy - fy * R;
      c.strokeStyle = kind === 'pro' ? '#d8ff5c' : kind === 'retro' ? '#d8ff5c' : '#ff6ad5';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(sx, sy, 7, 0, Math.PI * 2);
      c.stroke();
      if (kind === 'pro') {
        c.beginPath();
        c.moveTo(sx - 13, sy); c.lineTo(sx - 7, sy); c.moveTo(sx + 7, sy); c.lineTo(sx + 13, sy); c.moveTo(sx, sy - 7); c.lineTo(sx, sy - 13);
        c.stroke();
      } else if (kind === 'retro') {
        c.beginPath();
        c.moveTo(sx - 5, sy - 5); c.lineTo(sx + 5, sy + 5); c.moveTo(sx + 5, sy - 5); c.lineTo(sx - 5, sy + 5);
        c.stroke();
      }
    };
    const vel = _v;
    if (v.telemetry.altitude < 60_000 && v.body.atmosphereTop > 0) v.surfaceVelocity(vel); else vel.copy(v.vel);
    if (vel.lengthSq() > 1) {
      vel.normalize();
      mark(vel, 'pro');
      mark(vel.clone().negate(), 'retro');
    }
    // fixed reticle
    c.strokeStyle = '#ffb04a';
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(cx - 26, cy); c.lineTo(cx - 9, cy); c.lineTo(cx - 4, cy + 6); c.moveTo(cx + 26, cy); c.lineTo(cx + 9, cy); c.lineTo(cx + 4, cy + 6);
    c.stroke();
    c.beginPath(); c.arc(cx, cy, 2, 0, Math.PI * 2); c.fillStyle = '#ffb04a'; c.fill();
    // bezel + heading / pitch read-outs
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, R + 2, 0, Math.PI * 2); c.stroke();
    c.font = '600 11px "JetBrains Mono", monospace';
    c.fillStyle = '#e9edf3';
    c.textAlign = 'center';
    c.fillText(`${v.telemetry.heading.toFixed(0).padStart(3, '0')}°`, cx, 12);
    c.textAlign = 'left';
    c.fillText(`${v.telemetry.pitch.toFixed(0)}°`, 2, H - 4);
    c.textAlign = 'right';
    c.fillText(`R${v.telemetry.roll.toFixed(0)}`, W - 2, H - 4);
  }

  private drawEngines(s: FlightSession): void {
    const c = this.engCtx;
    const W = this.engCanvas.width, H = this.engCanvas.height;
    c.clearRect(0, 0, W, H);
    // dark backing disc so the diagram reads over a bright sky
    c.beginPath(); c.arc(W / 2, H / 2, W / 2 - 1.5, 0, Math.PI * 2);
    c.fillStyle = 'rgba(5, 7, 11, 0.55)'; c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.14)'; c.lineWidth = 1; c.stroke();
    const v = s.active;
    const pts: { x: number; z: number; r: number; state: number; failed: boolean; solid: boolean }[] = [];
    let ext = 0.5;
    for (const a of v.assemblies) for (const e of a.engines) {
      const x = e.mount.pos[0] + a.offX, z = e.mount.pos[2] + a.offZ;
      ext = Math.max(ext, Math.hypot(x, z) + e.mount.spec.exitRadius);
      const state = e.failed ? -1 : e.running ? Math.max(0.25, e.throttle) * e.spool : e.armed ? 0.12 : 0;
      pts.push({ x, z, r: e.mount.spec.exitRadius, state, failed: e.failed, solid: e.isSolid });
    }
    const scale = (W / 2 - 10) / ext;
    for (const p of pts) {
      const sx = W / 2 + p.x * scale, sy = H / 2 + p.z * scale, r = Math.max(3, p.r * scale * 0.92);
      c.beginPath();
      c.arc(sx, sy, r, 0, Math.PI * 2);
      if (p.failed) { c.strokeStyle = '#ff5b5b'; c.lineWidth = 2; c.stroke(); continue; }
      if (p.state > 0.2) {
        const g = c.createRadialGradient(sx, sy, 0, sx, sy, r * 1.6);
        g.addColorStop(0, p.solid ? 'rgba(255,240,210,1)' : 'rgba(255,214,140,1)');
        g.addColorStop(0.6, `rgba(255,150,40,${0.6 * p.state + 0.3})`);
        g.addColorStop(1, 'rgba(255,120,20,0)');
        c.fillStyle = g;
        c.beginPath(); c.arc(sx, sy, r * 1.6, 0, Math.PI * 2); c.fill();
      } else if (p.state > 0) {
        c.fillStyle = 'rgba(255,176,74,0.25)'; c.fill();
      } else {
        c.fillStyle = 'rgba(0,0,0,0.35)'; c.fill();
      }
      c.strokeStyle = p.state > 0 ? 'rgba(255,190,110,0.9)' : 'rgba(255,255,255,0.5)';
      c.lineWidth = 1.2;
      c.beginPath(); c.arc(sx, sy, r, 0, Math.PI * 2); c.stroke();
    }
  }

  /** Full key reference (F1). */
  static helpPanel(onClose: () => void): HTMLElement {
    const list = h('div', { style: 'display:grid;grid-template-columns:repeat(2,minmax(240px,1fr));gap:4px 40px;margin-top:20px' });
    for (const [k, d] of KEY_HELP) list.appendChild(h('div', { class: 'stat-row' }, h('span', {}, d), h('span', {}, k)));
    const ov = h('div', { class: 'overlay' }, h('h1', {}, 'Controls'), h('div', { class: 'crumb' }, 'Keyboard & mouse'), list);
    const btn = h('button', { class: 'btn close' }, 'Close');
    btn.addEventListener('click', onClose);
    ov.appendChild(btn);
    return ov;
  }
}

void _q;
