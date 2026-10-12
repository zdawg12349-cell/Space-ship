import type { FlightSession } from '../game/FlightSession';
import { h } from './dom';

/**
 * Tutorial tips: short, timed cards keyed to the flight's progress. Each appears once, stays
 * for a few seconds (or until the condition it teaches is met). The first mission teaches the
 * launch; every flight with parachutes teaches the way home.
 */

interface Tip {
  id: string;
  when: (s: FlightSession) => boolean;
  title: string;
  html: string;
  duration: number;
  done?: (s: FlightSession) => boolean;
}

export const LAUNCH_TIPS: Tip[] = [
  { id: 'welcome', when: () => true, title: 'Welcome to the pad', html: 'This is the terminal count. Mission control will call out each step; the <b>13-step ignition sequence</b> appears on the left near T-10. Press <kbd>Enter</kbd> to jump to T-10, or <kbd>Backspace</kbd> to hold the count.', duration: 11 },
  { id: 'cameras', when: (s) => s.met > -50 && s.phase === 'countdown', title: 'Cameras', html: 'The <b>cinematic director</b> cuts between shots on its own. Press <kbd>C</kbd> to cycle camera modes, drag with the mouse to orbit, and use the wheel to zoom. <kbd>H</kbd> hides the HUD for a clean view.', duration: 10 },
  { id: 'liftoff', when: (s) => s.hasMilestone('liftoff'), title: 'Liftoff', html: '<b>Orbit assist</b> is flying the ascent: a vertical climb, a roll and pitch program, then a gravity turn. Watch altitude and velocity on the left; the staging stack is on the right.', duration: 9 },
  { id: 'maxq', when: (s) => s.met > 40 && s.active.telemetry.dynamicPressure > 15000, title: 'Max-Q', html: 'Dynamic pressure (<b>Q</b>) is peaking: the air is thick and the vehicle is fast. Flying straight into the airflow keeps the structure safe — large angles of attack here can break a rocket apart.', duration: 9 },
  { id: 'staging', when: (s) => s.met > 100 && s.active.stageIndex >= 1, title: 'Staging', html: 'Press <kbd>Space</kbd> to fire the next stage yourself, or leave it to the flight computer. Spent stages separate and fall back — reusable ones fly themselves home.', duration: 9 },
  { id: 'warp', when: (s) => s.met > 160, title: 'Time warp', html: '<kbd>.</kbd> and <kbd>,</kbd> change time warp (1× to 1000× and beyond in space). Warp is limited while engines fire or in the atmosphere. Open the <b>orbital map</b> with <kbd>M</kbd>.', duration: 10 },
  { id: 'space', when: (s) => s.active.telemetry.altitude > 100_000, title: 'Space', html: 'You have crossed the Kármán line. Try the autopilot modes: <kbd>1</kbd> manual, <kbd>2</kbd> stability, <kbd>3</kbd> prograde, <kbd>4</kbd> retrograde. <kbd>P</kbd> opens photo mode.', duration: 11 },
];

const hasChutes = (s: FlightSession) => s.active.assemblies.some((a) => a.def.features?.parachutes && !a.destroyed);
const chutesStowed = (s: FlightSession) => s.active.assemblies.some((a) => a.def.features?.parachutes && a.chuteState === 'stowed');

/** Coming home: deorbit, entry, parachutes, touchdown. */
export const HOME_TIPS: Tip[] = [
  { id: 'home_goal', when: (s) => s.phase === 'orbit' && hasChutes(s), title: 'Coming home', html: 'Press <kbd>Y</kbd> and pick <b>Come home</b>: the autopilot plans the deorbit burn, fires it, flies the entry and opens the parachutes for you.<br>To do it yourself: click <b>Plan deorbit</b>, then <b>Execute</b> (bottom right), and speed time up with <kbd>.</kbd> until the burn.', duration: 14 },
  { id: 'home_burn', when: (s) => s.autopilot.mode === 'node' && s.active.body.id === 'earth' && hasChutes(s), title: 'Deorbit burn', html: 'The engine fires <b>backwards</b> (retrograde) to slow you down. Lose about 100 m/s and the lowest point of your orbit dips into the air: from there the atmosphere does the rest of the braking.', duration: 11 },
  { id: 'home_entry', when: (s) => s.phase === 'entry' && hasChutes(s), title: 'Entry', html: 'Heat shield first. The air brakes you from 7.8 km/s to a few hundred metres per second; the glow is the air itself, compressed and white-hot. <b>Keep the parachutes stowed</b>: at this speed they would tear or burn.', duration: 12 },
  {
    id: 'home_chutes', when: (s) => s.active.body.id === 'earth' && chutesStowed(s) && s.active.telemetry.altitude < 9000 && s.active.telemetry.speedSurface < 330 && s.active.telemetry.verticalSpeed < 0,
    title: 'Parachutes — now', html: 'Press <kbd>U</kbd>. The small <b>drogues</b> open first to steady and slow the capsule; press <kbd>U</kbd> again (or wait) for the big <b>mains</b>, which bring it down to a gentle 7–8 m/s. Opened too high and fast, they tear.',
    duration: 14, done: (s) => !chutesStowed(s),
  },
  { id: 'home_down', when: (s) => (s.phase === 'landed' || s.phase === 'splashed') && hasChutes(s), title: 'Welcome home', html: 'Touchdown. That is the whole trip: launch, orbit, deorbit burn, entry, parachutes.', duration: 9 },
];

export class Tutorial {
  private shown = new Set<string>();
  private card: HTMLElement | null = null;
  private timer = 0;

  constructor(readonly parent: HTMLElement, readonly s: FlightSession, readonly tips: Tip[] = LAUNCH_TIPS) {}
  private current: Tip | null = null;

  update(dt: number): void {
    this.timer -= dt;
    if (this.card && (this.timer <= 0 || this.current?.done?.(this.s))) { this.card.remove(); this.card = null; }
    if (this.card) return;
    for (const t of this.tips) {
      if (this.shown.has(t.id) || !t.when(this.s)) continue;
      this.shown.add(t.id);
      this.card = h('div', { class: 'tip' }, h('span', { class: 'label' }, t.title), h('div', { html: t.html }));
      this.parent.appendChild(this.card);
      this.timer = t.duration;
      this.current = t;
      break;
    }
  }

  dispose(): void { this.card?.remove(); }
}
