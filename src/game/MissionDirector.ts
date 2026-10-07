import type { FlightSession, SessionEvent } from './FlightSession';
import type { MissionDef, ObjectiveDef } from './missions';

/**
 * Evaluates mission objectives against the live flight and decides success / failure.
 * Objectives latch once done. Flight statistics are collected for the debrief.
 */

export type ObjectiveState = 'open' | 'done' | 'failed';

export interface FlightStats {
  maxAltitude: number;
  maxSpeed: number;
  maxQ: number;
  maxG: number;
  boostersLanded: number;
  boostersLost: number;
  minMoonDistance: number;
  peakHeatFlux: number;
  touchdownSpeed: number;
}

export class MissionDirector {
  readonly states: ObjectiveState[];
  readonly stats: FlightStats = { maxAltitude: 0, maxSpeed: 0, maxQ: 0, maxG: 0, boostersLanded: 0, boostersLost: 0, minMoonDistance: Infinity, peakHeatFlux: 0, touchdownSpeed: NaN };
  result: 'running' | 'success' | 'failed' = 'running';
  failReason = '';
  private seps = new Set<string>();
  private chutesMain = false;
  private touchdown: { speed: number; water: boolean; body: string } | null = null;
  private orbitPe = -Infinity;
  private wasInOrbit = false;
  private startBody: string;
  private startedLanded: boolean;
  private nightAtLiftoff = false;
  onChange: (() => void) | null = null;
  private doneTimer = -1;

  constructor(readonly mission: MissionDef | null, readonly s: FlightSession) {
    this.states = (mission?.objectives ?? []).map(() => 'open' as ObjectiveState);
    this.startBody = s.active.body.id;
    this.startedLanded = s.active.landed;
    s.on((e) => this.onEvent(e));
  }

  private onEvent(e: SessionEvent): void {
    if (e.type === 'separation') {
      this.seps.add(e.kind);
      if (e.kind === 'radial' && e.vessel.assemblies.some((a) => a.engines.some((x) => x.isSolid))) this.seps.add('srb');
      if (e.vessel.assemblies.some((a) => a.def.sections.some((x) => x.kind === 'payload' || x.kind === 'probe'))) this.seps.add('payloadDeploy');
    }
    if (e.type === 'radio' && e.id === 'mains') this.chutesMain = true;
    if (e.type === 'touchdown' && e.vessel === this.s.vessel) this.touchdown = { speed: e.speed, water: e.water, body: e.vessel.body.id };
    if (e.type === 'milestone' && e.id === 'liftoff') this.nightAtLiftoff = this.s.rw.siteNight > 0.5;
    if (e.type === 'destroyed' && e.vessel === this.s.vessel && this.result === 'running') {
      this.result = 'failed';
      this.failReason = e.reason;
      this.onChange?.();
    }
  }

  get objectives(): { text: string; state: ObjectiveState; optional: boolean }[] {
    return (this.mission?.objectives ?? []).map((o, i) => ({ text: o.text + (o.optional ? ' (bonus)' : ''), state: this.states[i], optional: !!o.optional }));
  }

  update(dt: number): void {
    const s = this.s;
    const v = s.vessel;
    const tm = v.telemetry;
    const st = this.stats;
    st.maxAltitude = Math.max(st.maxAltitude, tm.altitude);
    st.maxSpeed = Math.max(st.maxSpeed, tm.speedOrbital);
    st.maxQ = Math.max(st.maxQ, tm.dynamicPressure);
    if (v.hasLiftedOff) st.maxG = Math.max(st.maxG, tm.gForce);
    st.peakHeatFlux = Math.max(st.peakHeatFlux, tm.heatFlux);
    st.boostersLanded = s.boosters.filter((b) => b.v.landed && !b.v.destroyed).length;
    st.boostersLost = s.boosters.filter((b) => b.v.destroyed).length;
    const moon = s.system.moon;
    if (v.body === moon) st.minMoonDistance = Math.min(st.minMoonDistance, v.pos.length() - moon.radius);
    else if (v.body.id === 'earth') {
      const mp = moon.globalPositionAt(s.world.t, s.rw.cameraHelio.clone());
      const vp = v.pos.clone().add(s.bodyPos(v.body));
      st.minMoonDistance = Math.min(st.minMoonDistance, vp.distanceTo(mp) - moon.radius);
    }
    if (this.touchdown) st.touchdownSpeed = this.touchdown.speed;
    // orbit tracking
    const o = v.updateOrbit(s.world.t);
    const pe = o.periapsis - v.body.radius;
    const top = v.body.atmosphereTop || 10_000;
    if (!v.landed && pe > top && o.e < 1) { this.wasInOrbit = true; this.orbitPe = Math.max(this.orbitPe, pe); }
    if (!this.mission || this.result !== 'running') return;
    let changed = false;
    this.mission.objectives.forEach((obj, i) => {
      if (this.states[i] !== 'open') return;
      const r = this.check(obj);
      if (r !== 'open') { this.states[i] = r; changed = true; if (r === 'done') s.emit({ type: 'radio', id: 'objective_complete' }); }
    });
    // mission end
    const required = this.mission.objectives.map((o, i) => ({ o, st: this.states[i] })).filter((x) => !x.o.optional);
    if (required.some((x) => x.st === 'failed')) { this.result = 'failed'; this.failReason = 'Objective failed'; changed = true; }
    else if (required.every((x) => x.st === 'done')) {
      // give optional objectives (booster landings) time to finish
      const pendingOptional = this.mission.objectives.some((o, i) => o.optional && this.states[i] === 'open' && this.optionalStillPossible(o));
      if (this.doneTimer < 0) this.doneTimer = pendingOptional ? 240 : 6;
      this.doneTimer -= dt;
      if (this.doneTimer <= 0 || (!pendingOptional && this.doneTimer > 6)) { this.result = 'success'; changed = true; }
    }
    if (changed) this.onChange?.();
  }

  private optionalStillPossible(o: ObjectiveDef): boolean {
    if (o.kind === 'boosterLanded' || o.kind === 'allBoostersLanded') return this.s.boosters.some((b) => !b.v.landed && !b.v.destroyed);
    if (o.kind === 'orbit') return !this.s.vessel.destroyed && this.s.phase !== 'orbit';
    if (o.kind === 'earthReturn') return true;
    return false;
  }

  private check(o: ObjectiveDef): ObjectiveState {
    const s = this.s;
    const v = s.vessel;
    const tm = v.telemetry;
    const ms = (id: string) => s.hasMilestone(id);
    switch (o.kind) {
      case 'liftoff': return ms('liftoff') ? 'done' : 'open';
      case 'maxq': return ms('maxq') ? 'done' : 'open';
      case 'karman': return tm.altitude > 100_000 ? 'done' : 'open';
      case 'orbit': return this.wasInOrbit && this.orbitPe > (o.param ?? (v.body.atmosphereTop || 10_000)) ? 'done' : 'open';
      case 'payload': return this.seps.has('payloadDeploy') || this.seps.has('payload') ? 'done' : 'open';
      case 'fairing': return this.seps.has('fairing') ? 'done' : 'open';
      case 'boosterLanded': {
        if (s.boosters.some((b) => b.v.landed && !b.v.destroyed && b.zone.kind !== 'droneship')) return 'done';
        if (s.boosters.length && s.boosters.every((b) => b.v.destroyed)) return o.optional ? 'open' : 'failed';
        return 'open';
      }
      case 'allBoostersLanded': {
        const side = s.boosters.filter((b) => b.zone.kind === 'pad');
        if (side.length >= 2 && side.every((b) => b.v.landed && !b.v.destroyed)) return 'done';
        if (side.some((b) => b.v.destroyed)) return 'failed';
        return 'open';
      }
      case 'towerCatch': {
        const t = s.boosters.find((b) => b.zone.kind === 'tower');
        if (t?.v.landed && !t.v.destroyed) return 'done';
        if (t?.v.destroyed) return 'failed';
        return 'open';
      }
      case 'srbSep': return this.seps.has('srb') || this.seps.has('radial') ? 'done' : 'open';
      case 'lesJettison': return this.seps.has('les') ? 'done' : 'open';
      case 'deorbit': {
        if (!this.wasInOrbit) return 'open';
        const o2 = v.updateOrbit(s.world.t);
        return o2.periapsis - v.body.radius < 60_000 && v.body.id === 'earth' ? 'done' : 'open';
      }
      case 'survivedEntry': return ms('entry') && tm.altitude < 25_000 && tm.speedSurface < 600 && !v.destroyed ? 'done' : 'open';
      case 'chutes': return this.chutesMain ? 'done' : 'open';
      case 'softLanding': {
        if (!this.touchdown || this.touchdown.body !== 'earth') return 'open';
        return v.destroyed ? 'failed' : 'done';
      }
      case 'splashdown': {
        if (!this.touchdown) return 'open';
        return v.destroyed ? 'failed' : 'done';
      }
      case 'tli': return v.body.id === 'earth' && this.wasInOrbit && (v.updateOrbit(s.world.t).apoapsis > 250_000_000 || v.updateOrbit(s.world.t).e >= 1) ? 'done' : v.body.id === 'moon' ? 'done' : 'open';
      case 'moonSoi': return v.body.id === 'moon' ? 'done' : 'open';
      case 'moonFlyby': return this.stats.minMoonDistance < (o.param ?? 1e6) ? 'done' : 'open';
      case 'earthReturn': return this.stats.minMoonDistance < 1e8 && v.body.id === 'earth' && ms('moonVisited') ? 'done' : (v.body.id === 'moon' ? (s.markMilestone('moonVisited'), 'open') : 'open');
      case 'lunarTouchdown': {
        if (!this.touchdown || this.touchdown.body !== 'moon') return 'open';
        if (v.destroyed) return 'failed';
        return this.touchdown.speed <= (o.param ?? 3) + 0.5 ? 'done' : 'failed';
      }
      case 'lunarLiftoff': return v.body.id === 'moon' && !v.landed && tm.radarAltitude > 50 ? 'done' : 'open';
      case 'lunarOrbit': return v.body.id === 'moon' && this.wasInOrbit ? 'done' : 'open';
      case 'tei': return (this.startBody === 'moon' && v.body.id === 'earth') || (v.body.id === 'moon' && v.updateOrbit(s.world.t).e >= 1) ? 'done' : 'open';
      case 'jupiterSoi': return v.body.id === 'jupiter' ? 'done' : 'open';
      case 'perijove': {
        if (v.body.id !== 'jupiter') return 'open';
        return v.pos.length() < (o.param ?? 3e8) ? 'done' : 'open';
      }
      case 'joi': return v.body.id === 'jupiter' && v.updateOrbit(s.world.t).e < 1 ? 'done' : 'open';
      case 'nightLaunch': return ms('liftoff') ? (this.nightAtLiftoff ? 'done' : 'failed') : 'open';
    }
    return 'open';
  }

  /** Score for the debrief (0..1000). */
  score(): number {
    if (!this.mission) return 0;
    let sc = 0;
    this.mission.objectives.forEach((o, i) => { if (this.states[i] === 'done') sc += o.optional ? 150 : 250; });
    const req = this.mission.objectives.filter((o) => !o.optional).length;
    sc = Math.min(1000, Math.round((sc / Math.max(1, req * 250 + this.mission.objectives.filter((o) => o.optional).length * 150)) * 1000));
    void this.startedLanded;
    return sc;
  }
}
