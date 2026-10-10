import type { VehicleDef } from '../vehicles/types';

/**
 * Terminal countdown and the 13-step ignition sequence, as a timeline of events relative to
 * T-0. The session decides what each event does (arm retraction, deluge, ignition, release,
 * radio call, camera cue); this class only keeps time, supports holds and skips, and reports
 * which events fire in a frame.
 */

export interface CountdownEvent {
  /** seconds relative to T-0 (negative before liftoff) */
  t: number;
  id: string;
  /** shown in the countdown log */
  label: string;
  /** mission-control line to play */
  voice?: string;
  /** ignition-sequence step number (1..13) */
  step?: number;
  /** cinematic camera cue */
  cue?: string;
  /** fires only when the condition holds (evaluated by the session) */
  when?: 'liftoff' | 'towerClear';
}

export const IGNITION_STEPS = [
  'Igniters armed',
  'Prevalves open · chill-down complete',
  'Turbopump spin-start',
  'Ignition sequence start',
  'Igniter injection',
  'Main chamber ignition',
  'Thrust build-up',
  'Engine health check',
  'Full thrust',
  'Solid motor ignition',
  'Hold-down release',
  'Liftoff',
  'Tower clear',
];

export function buildCountdown(def: VehicleDef, opts: { weatherMarginal: boolean; crewed: boolean }): CountdownEvent[] {
  const hasLiquidFirst = def.staging[0]?.some((e) => e.action === 'ignite' && e.targets.some((id) => def.assemblies.find((a) => a.id === id)?.engines.some((m) => m.spec.propellant !== 'solid')));
  const hasSolids = def.assemblies.some((a) => a.ignitesAtLaunch && a.engines.some((m) => m.spec.propellant === 'solid'));
  const L = hasLiquidFirst ? Math.max(1.5, def.ignitionLead) : 0;
  const ev: CountdownEvent[] = [
    { t: -120, id: 'terminal', label: 'Terminal count', voice: 'pre_terminal', cue: 'establish' },
    { t: -110, id: 'weather', label: opts.weatherMarginal ? 'Weather marginal — go' : 'Weather go', voice: opts.weatherMarginal ? 'pre_weather_marginal' : 'pre_weather_go' },
    { t: -100, id: 'range', label: 'Range go', voice: 'pre_range_go' },
    { t: -90, id: 't90', label: 'T-90 s', voice: 'pre_t90', cue: 'detail' },
    { t: -80, id: 'prop', label: 'Propellant load complete', voice: 'pre_prop_complete' },
    { t: -70, id: 'flight_go', label: 'Flight director: go', voice: 'pre_flight_go' },
    { t: -60, id: 't60', label: 'T-1 minute', voice: 'pre_t1min', cue: 'tower' },
    { t: -52, id: 'internal_power', label: 'Internal power', voice: 'pre_internal_power' },
    { t: -45, id: 't45', label: 'Vehicle go for launch', voice: 'pre_t45' },
    { t: -40, id: 'poll', label: 'Launch poll complete', voice: 'pre_poll_go' },
    { t: opts.crewed ? -38 : -34, id: 'arms', label: opts.crewed ? 'Crew access arm retracting' : 'Umbilical arms retracting', voice: 'pre_arm_retract', cue: 'arms' },
    { t: -30, id: 't30', label: 'T-30 s', voice: 'pre_t30' },
    { t: -22, id: 'autoseq', label: 'Auto-sequence start', voice: 'pre_autoseq', cue: 'pad_low' },
    { t: -16, id: 'deluge', label: 'Sound suppression water on', voice: 'pre_deluge' },
    { t: -13, id: 'guidance', label: 'Guidance internal', voice: 'pre_guidance_internal' },
  ];
  // spoken count: 10..1, leaving room for the ignition calls
  for (let n = 10; n >= 1; n--) {
    if (L > 0 && n <= Math.ceil(L) && n >= 2) continue;
    ev.push({ t: -n, id: `cnt${n}`, label: `${n}`, voice: `cnt_${n}`, cue: n === 10 ? 'countdown' : undefined });
  }
  // the 13-step ignition sequence
  const tIgn = -L;
  ev.push({ t: Math.min(-11, tIgn - 8), id: 'ign1', label: IGNITION_STEPS[0], step: 1 });
  ev.push({ t: Math.min(-9, tIgn - 6), id: 'ign2', label: IGNITION_STEPS[1], step: 2, cue: 'engines' });
  ev.push({ t: tIgn - 2.6, id: 'ign3', label: IGNITION_STEPS[2], step: 3 });
  ev.push({ t: tIgn - 1.2, id: 'ign4', label: IGNITION_STEPS[3], step: 4, voice: hasLiquidFirst ? 'ign_seq' : undefined, cue: hasLiquidFirst ? 'ignition' : undefined });
  ev.push({ t: tIgn, id: 'ign5', label: IGNITION_STEPS[4], step: 5 });
  ev.push({ t: tIgn + 0.3, id: 'ign6', label: IGNITION_STEPS[5], step: 6, voice: hasLiquidFirst ? 'ign_main_start' : undefined });
  ev.push({ t: tIgn + Math.min(1, L * 0.3), id: 'ign7', label: IGNITION_STEPS[6], step: 7 });
  ev.push({ t: tIgn + L * 0.65, id: 'ign8', label: IGNITION_STEPS[7], step: 8 });
  ev.push({ t: -0.35, id: 'ign9', label: IGNITION_STEPS[8], step: 9, voice: hasLiquidFirst ? 'ign_full_power' : undefined });
  ev.push({ t: 0, id: 'ign10', label: hasSolids ? IGNITION_STEPS[9] : 'Solid motors: none', step: 10, voice: hasSolids ? 'ign_srb' : undefined, cue: 'liftoff' });
  ev.push({ t: 0.05, id: 'ign11', label: IGNITION_STEPS[10], step: 11 });
  ev.push({ t: 0.1, id: 'ign12', label: IGNITION_STEPS[11], step: 12, voice: 'liftoff', when: 'liftoff' });
  ev.push({ t: 0.2, id: 'ign13', label: IGNITION_STEPS[12], step: 13, voice: 'tower_clear', when: 'towerClear', cue: 'tower_clear' });
  if (!hasLiquidFirst) ev.push({ t: -3, id: 'cnt3b', label: '3', voice: 'cnt_3' }, { t: -2, id: 'cnt2b', label: '2', voice: 'cnt_2' });
  return ev.sort((a, b) => a.t - b.t);
}

export class LaunchSequence {
  /** countdown clock (s relative to T-0) */
  T: number;
  held = false;
  readonly events: CountdownEvent[];
  private next = 0;
  private pending: CountdownEvent[] = [];
  readonly fired: CountdownEvent[] = [];
  step = 0;

  constructor(events: CountdownEvent[], startAt = -120) {
    this.events = events;
    this.T = startAt;
    while (this.next < events.length && events[this.next].t < startAt) this.next++;
  }

  /** Jump the clock forward (skipping intermediate radio calls but applying their actions). */
  skipTo(T: number): CountdownEvent[] {
    const out: CountdownEvent[] = [];
    while (this.next < this.events.length && this.events[this.next].t < T) {
      const e = this.events[this.next++];
      if (e.when) this.pending.push(e); else { out.push({ ...e, voice: undefined }); this.fired.push(e); }
    }
    this.T = Math.max(this.T, T);
    return out;
  }

  /**
   * Advance the clock. Conditional events (liftoff, tower clear) wait for their condition
   * after their time has come.
   */
  update(dt: number, cond: { liftoff: boolean; towerClear: boolean }): CountdownEvent[] {
    const out: CountdownEvent[] = [];
    if (!this.held) this.T += dt;
    while (this.next < this.events.length && this.events[this.next].t <= this.T) {
      const e = this.events[this.next++];
      if (e.when) this.pending.push(e); else out.push(e);
    }
    this.pending = this.pending.filter((e) => {
      if (cond[e.when!]) { out.push(e); return false; }
      return true;
    });
    for (const e of out) { this.fired.push(e); if (e.step) this.step = Math.max(this.step, e.step); }
    return out;
  }

  get done(): boolean { return this.next >= this.events.length && this.pending.length === 0; }

  /** "T-00:00:10" / "T+00:01:05" */
  static format(T: number): string {
    const sign = T < 0 ? '-' : '+';
    const a = Math.abs(T);
    const s = Math.floor(a) % 60, m = Math.floor(a / 60) % 60, h = Math.floor(a / 3600);
    return `T${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}
