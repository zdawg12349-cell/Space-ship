import type { FlightSession } from '../game/FlightSession';
import { h } from './dom';

/**
 * Tutorial tips for the first mission: short, timed cards keyed to the flight's progress.
 * Each appears once, stays for a few seconds (or until the condition it teaches is met).
 */

interface Tip {
  id: string;
  when: (s: FlightSession) => boolean;
  title: string;
  html: string;
  duration: number;
  done?: (s: FlightSession) => boolean;
}

const TIPS: Tip[] = [
  { id: 'welcome', when: () => true, title: 'Welcome to the pad', html: 'This is the terminal count. Mission control will call out each step; the <b>13-step ignition sequence</b> appears on the left near T-10. Press <kbd>Enter</kbd> to jump to T-10, or <kbd>Backspace</kbd> to hold the count.', duration: 11 },
  { id: 'cameras', when: (s) => s.met > -50 && s.phase === 'countdown', title: 'Cameras', html: 'The <b>cinematic director</b> cuts between shots on its own. Press <kbd>C</kbd> to cycle camera modes, drag with the mouse to orbit, and use the wheel to zoom. <kbd>H</kbd> hides the HUD for a clean view.', duration: 10 },
  { id: 'liftoff', when: (s) => s.hasMilestone('liftoff'), title: 'Liftoff', html: '<b>Orbit assist</b> is flying the ascent: a vertical climb, a roll and pitch program, then a gravity turn. Watch altitude and velocity on the left; the staging stack is on the right.', duration: 9 },
  { id: 'maxq', when: (s) => s.met > 40 && s.active.telemetry.dynamicPressure > 15000, title: 'Max-Q', html: 'Dynamic pressure (<b>Q</b>) is peaking: the air is thick and the vehicle is fast. Flying straight into the airflow keeps the structure safe — large angles of attack here can break a rocket apart.', duration: 9 },
  { id: 'staging', when: (s) => s.met > 100 && s.active.stageIndex >= 1, title: 'Staging', html: 'Press <kbd>Space</kbd> to fire the next stage yourself, or leave it to the flight computer. Spent stages separate and fall back — reusable ones fly themselves home.', duration: 9 },
  { id: 'warp', when: (s) => s.met > 160, title: 'Time warp', html: '<kbd>.</kbd> and <kbd>,</kbd> change time warp (1× to 1000× and beyond in space). Warp is limited while engines fire or in the atmosphere. Open the <b>orbital map</b> with <kbd>M</kbd>.', duration: 10 },
  { id: 'space', when: (s) => s.active.telemetry.altitude > 100_000, title: 'Space', html: 'You have crossed the Kármán line. Try the autopilot modes: <kbd>1</kbd> manual, <kbd>2</kbd> stability, <kbd>3</kbd> prograde, <kbd>4</kbd> retrograde. <kbd>P</kbd> opens photo mode.', duration: 11 },
];

export class Tutorial {
  private shown = new Set<string>();
  private card: HTMLElement | null = null;
  private timer = 0;

  constructor(readonly parent: HTMLElement, readonly s: FlightSession) {}

  update(dt: number): void {
    this.timer -= dt;
    if (this.card && this.timer <= 0) { this.card.remove(); this.card = null; }
    if (this.card) return;
    for (const t of TIPS) {
      if (this.shown.has(t.id) || !t.when(this.s)) continue;
      this.shown.add(t.id);
      this.card = h('div', { class: 'tip' }, h('span', { class: 'label' }, t.title), h('div', { html: t.html }));
      this.parent.appendChild(this.card);
      this.timer = t.duration;
      break;
    }
  }

  dispose(): void { this.card?.remove(); }
}
