/**
 * Keyboard and mouse input. Continuous axes (pitch, yaw, roll, throttle) are read from held
 * keys every frame; discrete actions are dispatched to a handler as they happen.
 */

export type Action =
  | 'stage' | 'throttleMax' | 'throttleCut' | 'pause' | 'map' | 'camera' | 'cameraPrev' | 'onboardCycle' | 'hud' | 'photo'
  | 'warpUp' | 'warpDown' | 'warpReset' | 'sas' | 'rcs' | 'legs' | 'chutes' | 'hold' | 'skip' | 'screenshot' | 'help'
  | 'ap0' | 'ap1' | 'ap2' | 'ap3' | 'ap4' | 'ap5' | 'ap6' | 'ap7' | 'ap8' | 'ap9' | 'apOrbit' | 'quicksave' | 'abort' | 'goals';

export const KEYMAP: Record<string, Action> = {
  Space: 'stage', KeyZ: 'throttleMax', KeyX: 'throttleCut', Escape: 'pause', KeyM: 'map', KeyC: 'camera', KeyV: 'onboardCycle',
  KeyH: 'hud', KeyP: 'photo', Period: 'warpUp', Comma: 'warpDown', Slash: 'warpReset', KeyT: 'sas', KeyR: 'rcs', KeyG: 'legs', KeyU: 'chutes',
  Backspace: 'hold', Enter: 'skip', F2: 'screenshot', F1: 'help', Digit1: 'ap0', Digit2: 'ap1', Digit3: 'ap2', Digit4: 'ap3', Digit5: 'ap4',
  Digit6: 'ap5', Digit7: 'ap6', Digit8: 'ap7', Digit9: 'ap8', Digit0: 'ap9', KeyO: 'apOrbit', F5: 'quicksave', KeyB: 'abort', KeyY: 'goals',
};

export const KEY_HELP: [string, string][] = [
  ['Space', 'Stage'], ['Shift / Ctrl', 'Throttle up / down'], ['Z / X', 'Full throttle / cut'], ['W S', 'Pitch'], ['A D', 'Yaw'], ['Q E', 'Roll'],
  ['T', 'Stability assist'], ['1 – 0', 'Autopilot modes'], ['O', 'Orbit assist'], ['R', 'RCS'], ['G', 'Landing legs'], ['U', 'Parachutes'], ['Y', 'Choose a goal (autopilot flies it)'],
  [', .  /', 'Time warp down / up / reset'], ['C', 'Camera mode'], ['V', 'Onboard camera'], ['Mouse drag / wheel', 'Orbit / zoom camera'],
  ['M', 'Orbital map'], ['H', 'Cinematic (HUD off)'], ['P', 'Photo mode'], ['Enter', 'Skip countdown to T-10'], ['Backspace', 'Hold countdown'],
  ['F5', 'Quick save'], ['Esc', 'Pause'],
];

export class Input {
  private keys = new Set<string>();
  /** accumulated mouse drag (px) and wheel since last read */
  dragX = 0;
  dragY = 0;
  wheel = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  enabled = true;
  onAction: ((a: Action) => void) | null = null;
  private disposers: (() => void)[] = [];

  constructor(target: HTMLElement) {
    const kd = (e: KeyboardEvent) => {
      if (!this.enabled) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (!e.repeat) {
        const a = KEYMAP[e.code];
        if (a) { this.onAction?.(a); if (a !== 'screenshot' && a !== 'help') e.preventDefault(); }
      }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'KeyN', 'KeyY', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => { this.keys.delete(e.code); };
    const blur = () => this.keys.clear();
    const md = (e: MouseEvent) => { if (e.button === 0 || e.button === 2) { this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY; } };
    const mm = (e: MouseEvent) => {
      if (!this.dragging) return;
      this.dragX += e.clientX - this.lastX;
      this.dragY += e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
    };
    const mu = () => { this.dragging = false; };
    const wh = (e: WheelEvent) => { if (!this.enabled) return; this.wheel += Math.sign(e.deltaY); e.preventDefault(); };
    const ctx = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    target.addEventListener('mousedown', md);
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
    target.addEventListener('wheel', wh, { passive: false });
    target.addEventListener('contextmenu', ctx);
    this.disposers.push(() => {
      window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('blur', blur);
      target.removeEventListener('mousedown', md); window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu);
      target.removeEventListener('wheel', wh); target.removeEventListener('contextmenu', ctx);
    });
  }

  down(code: string): boolean { return this.enabled && this.keys.has(code); }

  /** pitch, yaw, roll in -1..1 */
  axes(): { pitch: number; yaw: number; roll: number; throttle: number } {
    const k = (a: string, b: string) => (this.down(a) ? 1 : 0) - (this.down(b) ? 1 : 0);
    return {
      pitch: k('KeyS', 'KeyW'),
      yaw: k('KeyD', 'KeyA'),
      roll: k('KeyE', 'KeyQ'),
      throttle: (this.down('ShiftLeft') || this.down('ShiftRight') ? 1 : 0) - (this.down('ControlLeft') || this.down('ControlRight') ? 1 : 0),
    };
  }

  /** translation (RCS): I/K forward/back, J/L left/right, Y/N up/down */
  translate(): { x: number; y: number; z: number } {
    const k = (a: string, b: string) => (this.down(a) ? 1 : 0) - (this.down(b) ? 1 : 0);
    return { x: k('KeyL', 'KeyJ'), y: k('KeyI', 'KeyK'), z: k('KeyN', 'KeyY') };
  }

  consumeMouse(): { dx: number; dy: number; wheel: number } {
    const r = { dx: this.dragX, dy: this.dragY, wheel: this.wheel };
    this.dragX = this.dragY = this.wheel = 0;
    return r;
  }

  dispose(): void { for (const d of this.disposers) d(); this.keys.clear(); }
}
