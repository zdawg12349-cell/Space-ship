import type { FlightSession } from './FlightSession';

/**
 * Flight goals: pick what the flight should do and the autopilot strings the steps together
 * (the same manoeuvre buttons and autopilot modes a player would use). "Fly the mission" adds
 * nothing to what the mission already does on its own.
 */
export type GoalId = 'mission' | 'home' | 'flyby' | 'moon_land' | 'moon_home';

export interface GoalHost {
  readonly session: FlightSession;
  /** press a manoeuvre button (plan_deorbit, execute, land, ...) */
  nav(id: string): void;
  log(text: string, level?: 'info' | 'good' | 'warn'): void;
}

type Step =
  | { label: string; run: (h: GoalHost) => void }
  | { label: string; until: (s: FlightSession) => boolean; warp?: boolean; max?: number; min?: number; optional?: boolean; realMax?: number };

const chutes = (s: FlightSession) => s.active.assemblies.some((a) => a.def.features?.parachutes && !a.destroyed);
const legs = (s: FlightSession) => s.active.assemblies.some((a) => a.def.features?.landingLegs && !a.destroyed);
const inOrbit = (s: FlightSession) => {
  const v = s.active;
  if (v.landed) return false;
  const o = v.updateOrbit(s.world.t);
  return o.e < 1 && o.periapsis - v.body.radius > (v.body.atmosphereTop || 5000);
};

/** wait for the planned burn, warping toward it, and let the autopilot fly it */
const burn = (what: string, optional = false): Step[] => [
  { label: `Planning ${what}`, until: (s) => !!s.autopilot.node, realMax: 20, optional },
  { label: `Executing ${what}`, run: (h) => { if (h.session.autopilot.node) h.nav('execute'); } },
  { label: `Burning: ${what}`, until: (s) => s.autopilot.mode !== 'node', warp: true, max: 400_000, optional },
];

/** the way down on Earth: through entry to the parachutes and the ground */
const descent: Step[] = [
  { label: 'Coasting to the atmosphere', until: (s) => s.phase === 'entry' || s.phase === 'descent' || s.active.telemetry.altitude < 120_000, warp: true, max: 400_000 },
  { label: 'Entry', until: (s) => s.active.telemetry.altitude < 7000 && s.active.telemetry.speedSurface < 300, max: 3000 },
  { label: 'Parachutes', run: (h) => { if (h.session.active.deployChutes()) h.log('Parachutes armed', 'good'); } },
  { label: 'Under parachutes', until: (s) => s.phase === 'landed' || s.phase === 'splashed', max: 3000 },
];

export const GOALS: { id: GoalId; label: string; hint: string; can: (s: FlightSession) => boolean; steps: Step[] }[] = [
  { id: 'mission', label: 'Fly the mission', hint: 'what the mission does on its own', can: () => true, steps: [] },
  {
    id: 'home', label: 'Orbit, then come home', hint: 'deorbit burn, entry, parachutes', can: (s) => s.active.body.id === 'earth' && chutes(s),
    steps: [
      { label: 'Climbing to orbit', until: (s) => s.phase === 'orbit' || inOrbit(s), max: 3000 },
      { label: 'Settling into orbit', until: () => true, min: 20 },
      { label: 'Planning the deorbit burn', run: (h) => h.nav('plan_deorbit') },
      ...burn('the deorbit burn'),
      ...descent,
    ],
  },
  {
    id: 'flyby', label: 'Around the Moon and home', hint: 'translunar injection, free return, entry', can: (s) => s.active.body.id === 'earth' && !!(s.def.capabilities.moon || s.def.capabilities.deepSpace) && chutes(s),
    steps: [
      { label: 'Climbing to orbit', until: (s) => s.phase === 'orbit' || inOrbit(s), max: 3000 },
      { label: 'Settling into orbit', until: () => true, min: 20 },
      { label: 'Planning translunar injection', run: (h) => h.nav('plan_tli') },
      ...burn('translunar injection'),
      { label: 'Leaving Earth', until: () => true, min: 3600, warp: true },
      { label: 'Planning a course correction', run: (h) => h.nav('plan_mcc') },
      ...burn('the course correction', true),
      { label: 'Coasting to the Moon', until: (s) => s.active.body.id === 'moon', warp: true, max: 2_000_000 },
      { label: 'Around the Moon, falling home', until: (s) => s.active.body.id === 'earth', warp: true, max: 2_000_000 },
      ...descent,
    ],
  },
  {
    id: 'moon_land', label: 'Land on the Moon', hint: 'powered descent to the surface', can: (s) => s.active.body.id === 'moon' && !s.active.landed && legs(s),
    steps: [
      { label: 'Starting the descent', run: (h) => h.nav('land') },
      { label: 'Powered descent', until: (s) => s.active.landed || s.phase === 'landed', max: 20_000 },
    ],
  },
  {
    id: 'moon_home', label: 'Leave the Moon, come home', hint: 'ascent, trans-Earth injection, entry, parachutes', can: (s) => s.active.body.id === 'moon' && s.active.assemblies.some((a) => a.def.features?.parachutes),
    steps: [
      { label: 'Lifting off', run: (h) => { if (h.session.active.landed) h.nav('ascend'); } },
      { label: 'Ascent to lunar orbit', until: (s) => inOrbit(s) && s.autopilot.mode !== 'ascend', max: 3000 },
      { label: 'Planning trans-Earth injection', run: (h) => h.nav('plan_tei') },
      ...burn('trans-Earth injection'),
      { label: 'Falling home to Earth', until: (s) => s.active.body.id === 'earth', warp: true, max: 2_000_000 },
      ...descent,
    ],
  },
];

export class GoalPilot {
  goal: GoalId = 'mission';
  private steps: Step[] = [];
  private i = 0;
  /** simulated seconds spent on the current step */
  private stepT = 0;
  /** real seconds on the current step (planning runs in the background, whatever the warp) */
  private stepReal = 0;
  private stopped = false;
  status = '';

  /** a sandbox flight: the do-nothing goal is free flight, not a mission */
  sandbox = false;

  get label(): string { return this.goal === 'mission' && this.sandbox ? 'Free flight' : GOALS.find((x) => x.id === this.goal)?.label ?? ''; }

  /** Goals that make sense right now, labelled for this flight. */
  menu(): { id: GoalId; label: string; hint: string }[] {
    return this.available().map((g) => (g.id === 'mission' && this.sandbox ? { id: g.id, label: 'Free flight', hint: 'you fly; the autopilot only helps when asked' } : g));
  }

  constructor(private readonly host: GoalHost) {}

  /** Goals that make sense right now (the current one always listed). */
  available(): typeof GOALS {
    const s = this.host.session;
    return GOALS.filter((g) => g.id === this.goal || g.can(s));
  }

  choose(id: GoalId): void {
    const g = GOALS.find((x) => x.id === id);
    if (!g) return;
    this.goal = id;
    this.steps = g.steps;
    this.i = 0;
    this.stepT = 0;
    this.stepReal = 0;
    this.stopped = false;
    this.status = g.steps.length ? g.steps[0].label : '';
    this.host.log(`Goal: ${g.label}`, 'good');
  }

  /** Per frame (live play): advance through the steps. */
  update(dt: number): void {
    const s = this.host.session;
    if (this.i >= this.steps.length) {
      if (this.steps.length) this.status = s.active.destroyed ? 'Vehicle lost' : this.stopped ? 'Stopped — fly it yourself or pick a goal' : 'Done';
      return;
    }
    if (s.active.destroyed) { this.status = 'Vehicle lost'; this.i = this.steps.length; return; }
    const st = this.steps[this.i];
    this.status = st.label;
    if ('run' in st) { st.run(this.host); this.next(); return; }
    this.stepT += dt * Math.max(1, s.world.warp ?? 1);
    this.stepReal += dt;
    if (st.until(s) && this.stepT >= (st.min ?? 0)) {
      if (st.warp) { if (s.warpTarget?.label === 'Autopilot') s.warpTarget = null; if (s.world.warpIndex > 0) s.setWarp(0); }
      this.next();
      return;
    }
    // a long wait is warped through (the flight drops warp itself near burns and the atmosphere)
    if (st.warp && !s.warpTarget && s.world.warpIndex === 0 && this.stepT > 2) {
      const node = s.autopilot.node;
      if (node && node.t - s.world.t > 90) s.warpTarget = { t: node.t - 60, label: 'Autopilot' };
      else if (!node) s.setWarp(5);
    }
    if ((st.max !== undefined && this.stepT > st.max) || (st.realMax !== undefined && this.stepReal > st.realMax)) {
      if (st.optional) { this.next(); return; }
      this.host.log(`Autopilot could not finish "${st.label}" — take over, or pick another goal`, 'warn');
      this.i = this.steps.length;
      this.stopped = true;
    }
  }

  private next(): void { this.i++; this.stepT = 0; this.stepReal = 0; }
}
