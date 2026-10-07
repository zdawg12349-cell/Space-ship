import { Vector3 } from 'three';
import type { App } from '../core/App';
import { dateToJ2000Seconds } from '../physics/constants';
import { EarthAtmosphere } from '../physics/atmosphere';
import { WARP_LEVELS } from '../physics/world';
import { CAMERA_MODES } from '../camera/CameraDirector';
import { HUD } from '../ui/HUD';
import { h, hide, show } from '../ui/dom';
import { MapView } from '../ui/MapView';
import { PhotoMode } from '../ui/PhotoMode';
import { SettingsPanel } from '../ui/SettingsPanel';
import type { AutopilotMode } from './Autopilot';
import { FlightSession, SessionEvent } from './FlightSession';
import { Action, Input } from './Input';
import { MissionDirector } from './MissionDirector';
import { getMission, MissionDef, MissionStart, MISSIONS } from './missions';
import type { WeatherKind } from './providers';
import { FlightSnapshot, saveProgress, snapshotVessel, writeSnapshot } from './SaveGame';
import type { Settings } from './Settings';
import { GRAPHICS } from './Settings';
import { Tutorial } from '../ui/Tutorial';
import { planCapture, planCircularize, planCorrection, planDeorbit, planTEI, planTLI, trajectoryForecast } from './Planner';

/**
 * Glue between a FlightSession and the player: input, HUD, audio, radio, music, the mission
 * director, pause / map / photo mode / debrief, and the per-frame render.
 */

export interface FlightLaunchOptions {
  missionId?: string;
  vehicleId?: string;
  siteId?: string;
  date?: Date;
  weather?: WeatherKind;
  targetOrbit?: number;
  inclination?: number;
  planeTarget?: 'moon';
  /** where a sandbox flight begins (missions define their own) */
  start?: MissionStart;
  countdownStart?: number;
  recovery?: boolean;
  orbitAssist?: boolean;
  snapshot?: FlightSnapshot;
}

const AP_KEYS: AutopilotMode[] = ['off', 'stability', 'prograde', 'retrograde', 'radial', 'antiradial', 'normal', 'antinormal', 'heading', 'altitude'];

const BANNERS: Record<string, [string, string]> = {
  liftoff: ['Liftoff', ''], maxq: ['Max-Q', 'maximum aerodynamic pressure'], karman: ['Space', '100 km · Kármán line'], orbit: ['Orbit', ''],
  supersonic: ['Supersonic', 'Mach 1'], entry: ['Entry interface', '120 km'],
};

const BOOSTER_VOICE: Record<string, string> = {
  boostback_start: 'boostback_start', boostback_end: 'boostback_end', gridfins: 'gridfins', entry_burn_start: 'entry_burn_start', entry_burn_end: 'entry_burn_end',
  landing_burn: 'landing_burn', legs_deploy: 'legs_deploy', landed: 'booster_landed', lost: 'booster_lost',
};

export class FlightController {
  readonly session: FlightSession;
  readonly hud: HUD;
  readonly input: Input;
  readonly mission: MissionDef | null;
  readonly director: MissionDirector;
  private map: MapView | null = null;
  private photo: PhotoMode | null = null;
  private pauseEl: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private summaryShown = false;
  private hushTimer = -1;
  private tutorial: Tutorial | null = null;
  private stageSoundT = 0;
  private boostersReported = new Set<string>();
  private cinematicHud = false;
  paused = false;

  constructor(readonly app: App, readonly opts: FlightLaunchOptions) {
    const mission = opts.missionId ? getMission(opts.missionId) ?? null : null;
    this.mission = mission;
    const date = opts.date ?? (mission ? new Date(mission.date) : new Date('2026-10-06T21:30:00Z'));
    const snap = opts.snapshot;
    const t0 = snap ? snap.t : dateToJ2000Seconds(date);
    app.system.setEpoch(t0);
    const g = GRAPHICS[app.settings.preset];
    this.session = new FlightSession(app.rw, app.system, app.terrain, {
      vehicleId: snap?.vehicleId ?? opts.vehicleId ?? mission?.vehicle ?? 'kestrel9',
      siteId: snap?.siteId ?? opts.siteId ?? mission?.site ?? 'cape',
      date,
      weather: (snap?.weather as WeatherKind) ?? opts.weather ?? mission?.weather ?? 'fair',
      targetOrbit: opts.targetOrbit ?? mission?.targetOrbit,
      inclination: opts.inclination ?? mission?.inclination,
      planeTarget: opts.planeTarget ?? mission?.planeTarget,
      countdownStart: opts.countdownStart ?? mission?.countdownStart ?? -120,
      orbitAssist: opts.orbitAssist ?? mission?.orbitAssist ?? true,
      recovery: opts.recovery ?? mission?.recovery ?? true,
      missionId: mission?.id,
      start: mission?.start ?? opts.start,
      snapshot: snap,
      vegetation: g.vegetation,
    });
    const s = this.session;
    s.director.shake.intensity = app.settings.shake;
    s.director.setMode('cinematic');
    app.rw.effects.particles.material.uniforms.uExposureHint.value = 1;
    this.hud = new HUD(app.ui);
    this.hud.subtitlesAlways = app.settings.subtitles;
    this.hud.onAutopilot = (m) => this.setAutopilot(m as AutopilotMode);
    this.hud.onNavAction = (id) => this.navAction(id);
    this.input = new Input(app.canvas);
    this.input.onAction = (a) => this.action(a);
    this.director = new MissionDirector(mission, s);
    this.director.onChange = () => this.hud.setObjectives(this.director.objectives);
    this.hud.setObjectives(this.director.objectives);
    s.on((e) => this.onEvent(e));
    // radio subtitles
    const radio = app.audio.radio;
    if (radio) {
      radio.onLine = (who, text, dur) => this.hud.subtitle(who, text, dur);
      radio.clear();
      radio.prefetch(s.seq.events.filter((e) => e.voice).map((e) => e.voice!));
    }
    // music mood
    app.audio.music?.setMood(mission?.mood ?? (app.rw.siteNight > 0.5 ? 'night' : 'hope'));
    app.audio.music?.setIntensity(0.3);
    if (app.audio.music) { app.audio.music.pulseOn = 0; app.audio.music.shimmerOn = 0.25; }
    app.audio.setHush(false);
    if (mission?.tutorial) this.tutorial = new Tutorial(app.ui, s);
    app.progress.flights++;
    saveProgress(app.progress);
    this.hud.banner(mission ? mission.title : s.def.name, mission ? mission.subtitle : `${s.site.name} · ${s.config.weather}`, 5);
  }

  applySettings(st: Settings): void {
    this.session.director.shake.intensity = st.shake;
    this.hud.subtitlesAlways = st.subtitles;
  }

  // ------------------------------------------------------------------------------ input

  private setAutopilot(m: AutopilotMode): void {
    this.session.setAutopilot(m);
    this.app.audio.play('ui');
  }

  private action(a: Action): void {
    const s = this.session;
    const audio = this.app.audio;
    if (this.photo && a !== 'photo' && a !== 'pause' && a !== 'screenshot') return;
    switch (a) {
      case 'pause': if (this.photo) this.togglePhoto(); else if (this.map) this.toggleMap(); else this.togglePause(); return;
    }
    if (this.paused) return;
    switch (a) {
      case 'stage':
        if (s.phase === 'countdown') { this.hud.log('Staging is locked until liftoff', s.met, 'warn'); return; }
        s.stageNow();
        audio.play('stage');
        break;
      case 'throttleMax': this.manualThrottle(1); break;
      case 'throttleCut': this.manualThrottle(0); break;
      case 'map': this.toggleMap(); break;
      case 'camera': {
        const i = CAMERA_MODES.indexOf(s.director.mode);
        s.director.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
        audio.play('ui');
        break;
      }
      case 'onboardCycle': s.director.setMode('onboard'); s.director.cycleOnboard(); break;
      case 'hud': this.toggleCinematic(); break;
      case 'photo': this.togglePhoto(); break;
      case 'warpUp': s.setWarp(s.world.warpIndex + 1); break;
      case 'warpDown': s.setWarp(s.world.warpIndex - 1); break;
      case 'warpReset': s.setWarp(0); break;
      case 'sas': this.setAutopilot(s.autopilot.mode === 'stability' ? 'off' : 'stability'); break;
      case 'apOrbit': this.setAutopilot('orbit'); break;
      case 'rcs': s.active.controls.rcs = !s.active.controls.rcs; this.hud.log(`RCS ${s.active.controls.rcs ? 'on' : 'off'}`, s.met); break;
      case 'legs': {
        const v = s.active;
        const anyDown = v.assemblies.some((x) => x.def.features?.landingLegs && x.legsTarget > 0.5);
        for (const x of v.assemblies) if (x.def.features?.landingLegs) x.legsTarget = anyDown ? 0 : 1;
        this.hud.log(`Landing legs ${anyDown ? 'stowed' : 'deployed'}`, s.met);
        break;
      }
      case 'chutes':
        if (s.active.deployChutes()) { this.hud.log('Parachutes armed', s.met, 'good'); audio.play('chute'); }
        else this.hud.log('No parachutes available', s.met, 'warn');
        break;
      case 'hold': s.holdCountdown(!s.seq.held); break;
      case 'skip': s.skipCountdown(-10); break;
      case 'screenshot': this.screenshot(); break;
      case 'help': this.toggleOverlay(HUD.helpPanel(() => this.toggleOverlay(null))); break;
      case 'quicksave': this.quicksave(); break;
      case 'abort': {
        const why = s.abort();
        if (why) this.hud.log(why, s.met, 'warn');
        else { this.app.audio.play('alarm'); this.app.audio.play('pyro', 0, true); }
        break;
      }
      default:
        if (a.startsWith('ap')) {
          const i = Number(a.slice(2));
          if (!Number.isNaN(i)) this.setAutopilot(AP_KEYS[i]);
        }
    }
  }

  private manualThrottle(x: number): void {
    const s = this.session;
    if (s.autopilot.mode === 'orbit') { s.setAutopilot('stability'); this.hud.log('Orbit assist disengaged — manual throttle', s.met, 'warn'); }
    s.throttle = x;
  }

  private applyManualControls(dt: number): void {
    const s = this.session;
    const v = s.active;
    const ax = this.input.axes();
    const inv = this.app.settings.invertPitch ? -1 : 1;
    if (ax.throttle !== 0) {
      if (s.autopilot.mode === 'orbit') { s.setAutopilot('stability'); this.hud.log('Orbit assist disengaged — manual throttle', s.met, 'warn'); }
      s.throttle = Math.max(0, Math.min(1, s.throttle + ax.throttle * dt * 0.6));
    }
    const steering = ax.pitch !== 0 || ax.yaw !== 0 || ax.roll !== 0;
    if (steering && s.phase !== 'countdown') {
      if (s.autopilot.mode === 'orbit') { s.setAutopilot('off'); this.hud.log('Orbit assist disengaged — manual flight', s.met, 'warn'); }
      // player input overrides the attitude hold for this frame (applied after the autopilot)
      s.manualOverride = { pitch: ax.pitch * inv, yaw: ax.yaw, roll: ax.roll };
    } else s.manualOverride = null;
    const tr = this.input.translate();
    if (v.controls.rcs) { v.controls.tx = tr.x; v.controls.ty = tr.y; v.controls.tz = tr.z; }
    // camera: drag orbits, wheel zooms
    const m = this.input.consumeMouse();
    const d = s.director;
    if (m.dx || m.dy || m.wheel) {
      if (d.mode === 'cinematic' && (m.dx || m.dy)) d.setMode('chase');
      if (d.mode === 'free') { d.freeYaw += m.dx * 0.004; d.freePitch = Math.max(-1.5, Math.min(1.5, d.freePitch - m.dy * 0.004)); }
      else d.orbitInput(m.dx * 0.005, m.dy * 0.004, m.wheel ? Math.pow(1.15, m.wheel) : 1);
    }
  }

  // ------------------------------------------------------------------------------ manoeuvres

  private navTimer = 0;

  /** Buttons that make sense right now. */
  private contextActions(): { id: string; label: string; primary?: boolean }[] {
    const s = this.session;
    const v = s.active;
    const ap = s.autopilot;
    const out: { id: string; label: string; primary?: boolean }[] = [];
    if (s.phase === 'countdown' || v.destroyed) return out;
    if (ap.node) {
      if (ap.mode !== 'node') out.push({ id: 'execute', label: 'Execute', primary: true });
      out.push({ id: 'cancel', label: 'Cancel burn' });
      return out;
    }
    const o = v.updateOrbit(s.world.t);
    const pe = o.periapsis - v.body.radius;
    const top = v.body.atmosphereTop || 5000;
    const inOrbit = !v.landed && pe > top && o.e < 1;
    if (v.body.id === 'earth' && inOrbit) {
      if (s.def.capabilities.moon || s.def.capabilities.deepSpace) out.push({ id: 'plan_tli', label: 'Plan TLI' });
      out.push({ id: 'plan_deorbit', label: 'Plan deorbit' });
      if (o.e > 0.01) out.push({ id: 'plan_circ', label: 'Circularise' });
    }
    if (v.body.id === 'moon') {
      const hasLegs = v.assemblies.some((a) => a.def.features?.landingLegs);
      if (v.landed) out.push({ id: 'ascend', label: 'Ascent to orbit', primary: true });
      else {
        if (hasLegs && ap.mode !== 'land') out.push({ id: 'land', label: 'Descent assist', primary: true });
        if (inOrbit) out.push({ id: 'plan_tei', label: 'Plan return to Earth' });
      }
    }
    // translunar / trans-Earth coast: trim the trajectory, or warp to the next event
    const fc = this.forecast;
    if (fc && !inOrbit && (v.body.id === 'earth' || v.body.id === 'moon')) {
      out.push({ id: 'plan_mcc', label: 'Course correction' });
      if (!s.warpTarget && fc.t - s.world.t > 1800) out.push({ id: 'warp_event', label: fc.what === 'Lunar periapsis' && v.body.id === 'earth' ? 'Warp to Moon' : `Warp to ${fc.what.toLowerCase()}` });
    }
    if (s.warpTarget) out.push({ id: 'warp_stop', label: 'Stop warp' });
    if (v.body.id === 'jupiter' && o.e >= 1 && v.pos.dot(v.vel) < 0) out.push({ id: 'plan_joi', label: 'Plan orbit insertion', primary: true });
    if (v.body.id === 'jupiter' && o.e < 1 && o.e > 0.01) out.push({ id: 'plan_circ', label: 'Circularise' });
    return out;
  }

  private navAction(id: string): void {
    const s = this.session;
    const v = s.active;
    const t = s.world.t;
    const ap = s.autopilot;
    this.app.audio.play('ui_select');
    let node: import('./Planner').ManeuverNode | null = null;
    switch (id) {
      case 'execute': s.setAutopilot('node'); this.app.audio.radio?.say('burn_start', 1); return;
      case 'cancel': ap.setNode(null); if (ap.mode === 'node') s.setAutopilot('stability'); return;
      case 'land': s.setAutopilot('land'); this.app.audio.radio?.say('pdi_go', 2); return;
      case 'ascend': s.setAutopilot('ascend'); this.app.audio.radio?.say('moon_ascent_go', 2); return;
      case 'plan_deorbit': node = planDeorbit(v, t); break;
      case 'plan_circ': node = planCircularize(v, t); break;
      case 'plan_tli': {
        // a second or so of trajectory search: let the HUD show the message first
        this.hud.log('Planning translunar injection…', s.met);
        setTimeout(() => {
          if (this.disposed) return;
          const nd = planTLI(v, s.system, s.world.t);
          if (!nd) { this.hud.log('No lunar trajectory from this orbit', s.met, 'warn'); return; }
          ap.setNode(nd);
          this.app.audio.radio?.say('tli_go', 2);
          this.hud.log(`${nd.label}: ${nd.dv.length().toFixed(0)} m/s · ${nd.result}`, s.met, 'good');
        }, 60);
        return;
      }
      case 'plan_mcc': node = planCorrection(v, s.system, t); break;
      case 'warp_event': {
        const fc = this.forecast;
        if (!fc) return;
        // arrive with a few minutes in hand (an hour before a lunar flyby periapsis)
        const lead = fc.what === 'Lunar periapsis' && v.body.id === 'moon' ? 3600 : 600;
        s.warpTarget = { t: fc.t - lead, label: fc.what === 'Lunar periapsis' && v.body.id === 'earth' ? 'Approaching the Moon' : `${fc.what} ahead` };
        return;
      }
      case 'warp_stop': s.warpTarget = null; s.setWarp(0); return;
      case 'plan_tei': node = planTEI(v, s.system, t); break;
      case 'plan_joi': node = planCapture(v, t, 60, 'Jupiter orbit insertion'); break;
    }
    if (!node) { this.hud.log(id === 'plan_mcc' ? 'Trajectory already on target' : 'No solution found from this orbit', s.met, 'warn'); return; }
    ap.setNode(node);
    this.hud.log(`${node.label}: ${node.dv.length().toFixed(0)} m/s · ${node.result}`, s.met, 'good');
  }

  /** next trajectory event (lunar periapsis, perigee) while coasting between bodies */
  private forecast: { what: string; km: number; t: number } | null = null;
  private forecastTimer = 0;

  private updateNav(dt: number): void {
    this.navTimer -= dt;
    this.forecastTimer -= dt;
    if (this.navTimer > 0) return;
    this.navTimer = 0.25;
    const s = this.session;
    const ap = s.autopilot;
    const n = ap.node;
    if (this.forecastTimer <= 0) {
      this.forecastTimer = 1;
      const v = s.active;
      this.forecast = !v.destroyed && !v.landed && s.phase !== 'countdown' ? trajectoryForecast(v, s.system, s.world.t) : null;
    }
    let nodeText = '';
    const fc = this.forecast;
    if (fc && !n) {
      const dtf = fc.t - s.world.t;
      const when = dtf > 86400 ? `${(dtf / 86400).toFixed(1)} d` : dtf > 3600 ? `${(dtf / 3600).toFixed(1)} h` : `${Math.max(0, dtf / 60).toFixed(0)} min`;
      nodeText = `${fc.what.toUpperCase()}\n${fc.km < 0 ? 'IMPACT' : fc.km.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' km'} · in ${when}`;
    }
    if (n) {
      const dtn = n.t - s.world.t;
      const bt = ap.burnTime(ap.nodeRemaining);
      nodeText = `${n.label.toUpperCase()}\nΔv ${ap.nodeRemaining.toFixed(0)} m/s · burn ${isFinite(bt) ? bt.toFixed(0) : '—'} s\nT${dtn >= 0 ? '−' : '+'}${Math.abs(dtn) > 3600 ? (Math.abs(dtn) / 3600).toFixed(1) + ' h' : Math.abs(dtn).toFixed(0) + ' s'} · ${n.result}`;
    }
    this.hud.setNav(this.contextActions(), ap.status, nodeText);
  }

  // ------------------------------------------------------------------------------ events

  private onEvent(e: SessionEvent): void {
    const s = this.session;
    const audio = this.app.audio;
    const music = audio.music;
    const camDist = (helio: Vector3 | null) => (helio ? helio.distanceTo(s.director.posHelio) : 300);
    switch (e.type) {
      case 'radio': audio.radio?.say(e.id, e.priority ?? 1); break;
      case 'message': this.hud.log(e.text, s.met, e.level); break;
      case 'countdown': {
        const ev = e.ev;
        if (ev.step) this.hud.log(`${String(ev.step).padStart(2, '0')} · ${ev.label}`, s.met, 'info');
        else if (!ev.id.startsWith('cnt')) this.hud.log(ev.label, s.met);
        const src = s.cameraContext(0).plumeSourceHelio ?? s.vessel.pos.clone().add(s.bodyPos(s.vessel.body));
        const d = camDist(src);
        if (ev.id === 'ign3') audio.play('spinup');
        if (ev.id === 'ign5') audio.play('ignition', d);
        if (ev.id === 'ign11') audio.play('clamps', d);
        if (ev.id === 't60') { music?.setIntensity(0.45); if (music) music.pulseOn = 0.6; music?.setTempo(104); }
        if (ev.id === 't30') { music?.setIntensity(0.6); music?.setTempo(116); }
        if (ev.id === 'cnt10') { music?.setIntensity(0.75); music?.setTempo(126); music?.swell(10); }
        if (ev.id === 'ign10') { music?.hit(1.2); music?.setIntensity(1); }
        break;
      }
      case 'milestone': {
        const b = BANNERS[e.id];
        if (b) this.hud.banner(b[0], b[1] || LaunchSeqFormat(s.met), 3.5);
        if (e.id === 'maxq') music?.setIntensity(0.85);
        if (e.id === 'orbit') {
          // the deliberate silence: engines quiet, music gone, only the radio and the view
          audio.setHush(true);
          this.hushTimer = 28;
          if (music) { music.pulseOn = 0; }
          music?.setIntensity(0);
        }
        break;
      }
      case 'separation': {
        const kind = e.kind;
        const label = kind === 'fairing' ? 'Fairing separation' : kind === 'radial' ? 'Booster separation' : kind === 'les' ? 'Escape tower jettison' : kind === 'payload' ? 'Payload deploy' : 'Stage separation';
        this.hud.banner(label, LaunchSeqFormat(s.met), 3);
        const onboard = s.director.mount === 'vehicle';
        audio.play(kind === 'fairing' || kind === 'payload' ? 'pyro' : 'separation', camDist(e.vessel.pos.clone().add(s.bodyPos(e.vessel.body))), onboard);
        if (kind === 'stack') { music?.hit(0.7); music?.setIntensity(0.7); s.director.cue('separation'); }
        if (kind === 'fairing') s.director.cue('fairing');
        if (kind === 'radial') s.director.cue('separation');
        const voice = kind === 'fairing' ? 'fairing_sep' : kind === 'les' ? 'les_jettison' : kind === 'payload' ? 'payload_deploy' : kind === 'radial' ? (e.vessel.assemblies.some((a) => a.engines.some((x) => x.isSolid)) ? 'srb_sep' : 'booster_sep') : 'stage_sep';
        audio.radio?.say(voice, 2);
        break;
      }
      case 'stage': this.hud.log(`Stage ${e.index + 1}: ${e.label}`, s.met, 'good'); break;
      case 'phase':
        if (e.phase === 'entry') { music?.setMood('tension'); music?.setIntensity(0.55); if (music) music.pulseOn = 0.4; audio.setHush(false); }
        if (e.phase === 'destroyed') { music?.setIntensity(0.2); if (music) music.pulseOn = 0; }
        break;
      case 'touchdown': audio.play(e.water ? 'splash' : 'touchdown', camDist(e.vessel.pos.clone().add(s.bodyPos(e.vessel.body)))); break;
      case 'destroyed': audio.play('explosion', camDist(e.vessel.pos.clone().add(s.bodyPos(e.vessel.body)))); if (e.vessel === s.vessel) audio.play('alarm'); break;
      case 'booster': {
        const v = BOOSTER_VOICE[e.id];
        const key = `${e.vessel.id}:${e.id}`;
        if (v && !this.boostersReported.has(key)) {
          this.boostersReported.add(key);
          if (e.id === 'landed' && s.boosters.filter((b) => b.v.landed).length >= 2) audio.radio?.say('boosters_landed_both', 2);
          else audio.radio?.say(v, e.id === 'landed' || e.id === 'lost' ? 3 : 1);
          this.hud.log(`${e.vessel.name}: ${e.id.replace(/_/g, ' ')}`, s.met, e.id === 'lost' ? 'alert' : e.id === 'landed' ? 'good' : 'info');
          if (e.id === 'landing_burn' || e.id === 'entry_burn_start' || e.id === 'boostback_start') s.director.cue(e.id === 'landing_burn' ? 'landing' : e.id === 'boostback_start' ? 'boostback' : 'entryburn');
          if (e.id === 'landed') this.hud.banner('Booster landed', e.vessel.name, 4);
        }
        break;
      }
      case 'ignite': {
        const d = camDist(e.vessel.pos.clone().add(s.bodyPos(e.vessel.body)));
        if (s.phase !== 'countdown') audio.play('ignition', d * 0.5 + 200, s.director.mount === 'vehicle');
        break;
      }
    }
  }

  // ------------------------------------------------------------------------------ frame

  frame(dt: number): void {
    const s = this.session;
    const app = this.app;
    if (!this.paused && !this.photo) {
      this.applyManualControls(dt);
      s.update(dt);
      this.director.update(dt);
      this.tutorial?.update(dt);
      if (this.director.result !== 'running' && !this.summaryShown) this.showSummary();
    } else this.input.consumeMouse();
    if (this.photo) this.photo.update(dt, this.input);
    else s.render(dt);
    if (this.photo) s.renderStatic(dt);
    // post settings: letterbox in cinematic
    const post = app.rw.post.settings;
    // letterbox only for the clean cinematic view (HUD hidden)
    const cin = s.director.mode === 'cinematic' && app.settings.letterboxInCinematic && this.cinematicHud;
    post.letterbox = this.photo ? this.photo.letterbox : cin ? 0.12 * s.director.letterbox : 0;
    // audio
    this.updateAudio(dt);
    this.hud.update(s, dt, this.mission ? `Mission ${this.mission.number} · ${this.mission.title}` : 'Sandbox');
    this.updateNav(dt);
    if (this.map) this.map.update(dt);
    else app.rw.render(dt);
    if (this.hushTimer > 0) {
      this.hushTimer -= dt;
      if (this.hushTimer <= 0) {
        app.audio.setHush(false);
        app.audio.music?.setMood('wonder');
        app.audio.music?.setIntensity(0.32);
        if (app.audio.music) app.audio.music.shimmerOn = 0.8;
      }
    }
  }

  private updateAudio(dt: number): void {
    const s = this.session;
    const audio = this.app.audio;
    const v = s.active;
    const camPos = s.director.posHelio;
    // loudest burning vessel as the source
    let best: { thrust: number; d: number; v: typeof v; solid: number } | null = null;
    for (const x of s.world.vessels) {
      if (x.destroyed || x.telemetry.thrust <= 0) continue;
      const p = x.pos.clone().add(s.bodyPos(x.body));
      const d = p.distanceTo(camPos);
      let solid = 0;
      for (const a of x.assemblies) for (const e of a.engines) if (e.isSolid && e.thrust > 0) solid += e.thrust;
      const score = x.telemetry.thrust / Math.max(100, d);
      if (!best || score > best.thrust / Math.max(100, best.d)) best = { thrust: x.telemetry.thrust, d, v: x, solid: solid / x.telemetry.thrust };
    }
    const earth = s.system.earth;
    const camAlt = camPos.distanceTo(s.bodyPos(earth)) - earth.radius;
    const camAir = v.body.id === 'earth' || best?.v.body.id === 'earth' ? EarthAtmosphere.sample(Math.max(0, camAlt), { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 }).pressure / 101325 : 0;
    const comDist = v.pos.clone().add(s.bodyPos(v.body)).distanceTo(camPos);
    const onboard = s.director.mount === 'vehicle' && comDist < 120;
    audio.setEngine(best ? {
      thrustMN: best.thrust / 1e6, distance: best.d, onboard: onboard && best.v === v, airAtCamera: Math.min(1, camAir), airAtVehicle: Math.min(1, best.v.atm.pressure / 101325),
      solid: best.solid, q: v.telemetry.dynamicPressure, mach: v.telemetry.mach, plasma: v.plasmaIntensity, nearVehicle: comDist < 400,
    } : { thrustMN: 0, distance: 0, onboard, airAtCamera: camAir, airAtVehicle: 0, solid: 0, q: v.telemetry.dynamicPressure, mach: v.telemetry.mach, plasma: v.plasmaIntensity, nearVehicle: comDist < 400 });
    // pad ambience while the camera is near the ground at the site
    const nearSite = s.complex && camAlt < 3000 && s.phase !== 'orbit';
    audio.setAmbience(nearSite ? 1 : 0, s.phase === 'countdown' ? this.app.rw.effects.flags.venting : 0, this.app.rw.effects.flags.deluge, this.app.rw.siteNight);
    void dt;
    this.stageSoundT += dt;
  }

  /** Fast-forward the simulation (automation / debugging). */
  /**
   * Fast-forward (tests and tools): simulate `seconds` in 1/30 s steps. The scene is updated
   * every `renderEvery` steps (effects and camera follow; lower = closer to live play).
   */
  advance(seconds: number, renderEvery = 2): { met: number; phase: string } {
    const s = this.session;
    const dt = 1 / 30;
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      s.update(dt);
      this.director.update(dt);
      if (i % renderEvery === 0) s.render(dt * renderEvery);
    }
    return { met: s.met, phase: s.phase };
  }

  // ------------------------------------------------------------------------------ overlays

  private toggleOverlay(el: HTMLElement | null): void {
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    if (el) { this.overlay = el; this.app.ui.appendChild(el); }
  }

  private toggleCinematic(): void {
    this.cinematicHud = !this.cinematicHud;
    this.hud.setVisible(!this.cinematicHud);
    if (this.cinematicHud) this.session.director.setMode('cinematic');
  }

  private toggleMap(): void {
    if (this.map) { this.map.dispose(); this.map = null; return; }
    this.map = new MapView(this.app.ui, this.session);
  }

  private togglePhoto(): void {
    if (this.photo) {
      this.photo.dispose();
      this.photo = null;
      this.hud.setVisible(!this.cinematicHud);
      return;
    }
    this.photo = new PhotoMode(this.app, this.session);
    this.hud.setVisible(false);
  }

  private togglePause(): void {
    if (this.pauseEl) {
      this.paused = false;
      void hide(this.pauseEl);
      this.pauseEl = null;
      this.toggleOverlay(null);
      return;
    }
    this.paused = true;
    const btn = (label: string, fn: () => void, primary = false) => {
      const b = h('button', { class: `btn${primary ? ' primary' : ''}` }, label);
      b.addEventListener('click', () => { this.app.audio.play('ui_select'); fn(); });
      return b;
    };
    const box = h('div', { class: 'box' },
      h('h2', {}, 'Paused'),
      btn('Resume', () => this.togglePause(), true),
      btn('Save flight', () => this.quicksave()),
      btn('Settings', () => this.toggleOverlay(new SettingsPanel(this.app, () => this.toggleOverlay(null)).root)),
      btn('Controls', () => this.toggleOverlay(HUD.helpPanel(() => this.toggleOverlay(null)))),
      btn('Restart flight', () => { const o = this.opts; this.app.endFlightTo(o); }),
      btn('Quit to main menu', () => this.app.endFlight()),
    );
    this.pauseEl = h('div', { class: 'screen overlay pause' }, box);
    this.app.ui.appendChild(this.pauseEl);
    show(this.pauseEl);
  }

  private quicksave(): void {
    const s = this.session;
    if (s.phase === 'countdown') { this.hud.log('Cannot save during the countdown', s.met, 'warn'); return; }
    const snap: FlightSnapshot = {
      version: 1, savedAt: new Date().toISOString(), missionId: this.mission?.id, vehicleId: s.def.id, siteId: s.site.id, weather: s.config.weather,
      t: s.world.t, liftoffT: isNaN(s.liftoffT) ? s.world.t : s.liftoffT, ...snapshotVessel(s.vessel), phase: s.phase, milestones: s.milestoneList(),
      throttle: s.throttle, autopilot: s.autopilot.mode,
    };
    const ok = writeSnapshot(snap);
    this.hud.log(ok ? 'Flight saved' : 'Save failed (storage unavailable)', s.met, ok ? 'good' : 'alert');
  }

  private screenshot(): void {
    const url = this.app.canvas.toDataURL('image/png');
    const a = h('a', { href: url, download: `ascent-${Date.now()}.png` });
    a.click();
    this.app.audio.play('shutter');
  }

  private showSummary(): void {
    this.summaryShown = true;
    const d = this.director;
    const m = this.mission;
    const ok = d.result === 'success';
    if (m && ok) {
      const prev = this.app.progress.completed[m.id];
      const score = d.score();
      if (!prev || prev.score < score) this.app.progress.completed[m.id] = { score, date: new Date().toISOString(), time: this.session.met };
      saveProgress(this.app.progress);
      this.app.audio.radio?.say('mission_success', 3);
    } else if (!ok) this.app.audio.radio?.say('mission_fail', 3);
    const st = d.stats;
    const row = (k: string, v: string) => h('div', { class: 'stat-row' }, h('span', {}, k), h('span', {}, v));
    const ul = h('ul', { class: 'objectives' });
    for (const o of d.objectives) ul.appendChild(h('li', { class: o.state === 'open' ? '' : o.state }, o.text));
    const next = m ? MISSIONS.find((x) => x.number === m.number + 1) : undefined;
    const buttons = h('div', { style: 'display:flex;gap:10px;margin-top:26px;flex-wrap:wrap' });
    const btn = (label: string, fn: () => void, primary = false) => { const b = h('button', { class: `btn${primary ? ' primary' : ''}` }, label); b.addEventListener('click', fn); buttons.appendChild(b); };
    if (ok && next) btn(`Next: ${next.title}`, () => this.app.endFlightTo({ missionId: next.id }), true);
    btn('Retry', () => this.app.endFlightTo(this.opts), !ok);
    btn('Keep flying', () => { panel.remove(); this.hud.setVisible(!this.cinematicHud); });
    btn('Main menu', () => this.app.endFlight());
    const panel = h('div', { class: 'overlay summary' },
      h('div', { class: 'crumb' }, m ? `Mission ${m.number} · ${m.subtitle}` : 'Sandbox'),
      h('h1', { style: `color:${ok ? 'var(--text)' : 'var(--red)'}` }, ok ? 'Mission complete' : 'Mission failed'),
      h('div', { class: 'two-col', style: 'margin-top:20px' },
        h('div', {},
          h('div', { class: 'label' }, 'Objectives'), ul,
          !ok && d.failReason ? h('p', { class: 'brief', style: 'color:var(--red)' }, d.failReason) : null,
          ok ? h('div', { style: 'margin-top:20px' }, h('div', { class: 'label' }, 'Score'), h('div', { class: 'score' }, String(d.score()))) : null,
        ),
        h('div', {},
          h('div', { class: 'label' }, 'Flight data'),
          row('Mission time', LaunchSeqFormat(this.session.met)),
          row('Max altitude', `${(st.maxAltitude / 1000).toFixed(1)} km`),
          row('Max speed', `${(st.maxSpeed / 1000).toFixed(2)} km/s`),
          row('Max-Q', `${(st.maxQ / 1000).toFixed(1)} kPa`),
          row('Peak acceleration', `${st.maxG.toFixed(2)} g`),
          row('Boosters recovered', `${st.boostersLanded}${st.boostersLost ? ` · lost ${st.boostersLost}` : ''}`),
          isFinite(st.minMoonDistance) && st.minMoonDistance < 5e8 ? row('Closest lunar approach', `${(st.minMoonDistance / 1000).toFixed(0)} km`) : null,
          !isNaN(st.touchdownSpeed) ? row('Touchdown speed', `${st.touchdownSpeed.toFixed(1)} m/s`) : null,
        ),
      ),
      buttons,
    );
    setTimeout(() => {
      if (this.disposed) return;
      this.app.ui.appendChild(panel);
      this.hud.setVisible(false);
    }, ok ? 2500 : 4000);
  }

  private disposed = false;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.dispose();
    this.hud.dispose();
    this.map?.dispose();
    this.photo?.dispose();
    this.pauseEl?.remove();
    this.overlay?.remove();
    this.tutorial?.dispose();
    this.app.audio.radio?.clear();
    this.app.audio.setEngine(null);
    this.app.audio.setAmbience(0, 0, 0, 0);
    this.app.audio.setHush(false);
    for (const el of Array.from(this.app.ui.querySelectorAll('.summary'))) el.remove();
    void WARP_LEVELS;
  }
}

function LaunchSeqFormat(met: number): string {
  const sign = met < 0 ? '-' : '+';
  const a = Math.abs(met);
  const p = (n: number) => String(Math.floor(n)).padStart(2, '0');
  return `T${sign}${p(a / 3600)}:${p((a % 3600) / 60)}:${p(a % 60)}`;
}
