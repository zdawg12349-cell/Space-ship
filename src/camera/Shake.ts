import { Euler, Quaternion, Vector3 } from 'three';

/**
 * Physically motivated camera shake.
 *
 *  - Acoustic: a ground camera feels the launch as pressure waves that arrive after
 *    distance / speed-of-sound and fall off with distance; low-frequency rumble with
 *    high-frequency crackle on top.
 *  - Structural: a camera bolted to the vehicle sees engine vibration, aerodynamic buffeting
 *    (peaks through transonic and max-Q) and impulsive jolts at staging.
 *  - Handheld: a slow wander for long-lens tracking cameras.
 *
 * Each band is a sum of incommensurate sinusoids (smooth, non-repeating) so the result reads
 * like footage rather than random jitter.
 */

const _e = new Euler();

class Band {
  private ph: number[];
  private fr: number[];
  constructor(readonly freq: number, n = 4, seed = 1) {
    this.ph = []; this.fr = [];
    let s = seed * 9301 + 49297;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < n; i++) { this.ph.push(rnd() * Math.PI * 2); this.fr.push(freq * (0.6 + rnd() * 0.9)); }
  }
  sample(t: number): number {
    let v = 0;
    for (let i = 0; i < this.ph.length; i++) v += Math.sin(t * this.fr[i] * Math.PI * 2 + this.ph[i]);
    return v / Math.sqrt(this.ph.length);
  }
}

export class CameraShake {
  private t = 0;
  private bands: Band[][] = [];
  /** delayed acoustic source history: [time, strength] */
  private history: [number, number][] = [];
  private jolt = 0;
  private joltDecay = 4;
  readonly offset = new Vector3();
  readonly rotation = new Quaternion();
  /** global multiplier from settings (0 disables) */
  intensity = 1;

  constructor() {
    // 3 axes x (low rumble 4 Hz, mid 11 Hz, high 27 Hz, wander 0.3 Hz)
    for (let axis = 0; axis < 6; axis++) this.bands.push([new Band(4, 4, axis * 7 + 1), new Band(11, 4, axis * 7 + 2), new Band(27, 3, axis * 7 + 3), new Band(0.25, 3, axis * 7 + 4)]);
  }

  /** Record the acoustic source strength (e.g. sum of plume thrust in MN) at simulation time. */
  pushSource(t: number, strength: number): void {
    this.history.push([t, strength]);
    // keep ~40 s of history (sound from 13 km)
    while (this.history.length > 2 && this.history[0][0] < t - 40) this.history.shift();
  }

  private sourceAt(t: number): number {
    const h = this.history;
    if (!h.length) return 0;
    if (t <= h[0][0]) return 0;
    for (let i = h.length - 1; i >= 0; i--) if (h[i][0] <= t) return h[i][1];
    return 0;
  }

  /** Impulsive jolt (staging, separation, touchdown). */
  kick(strength: number, decay = 4): void { this.jolt = Math.max(this.jolt, strength); this.joltDecay = decay; }

  /**
   * @param simT simulation time
   * @param mount 'ground' | 'vehicle' | 'free'
   * @param distance distance from the camera to the plume source (m) for ground cameras
   * @param vib vehicle vibration 0..1 (onboard)
   * @param q dynamic pressure (Pa) for buffeting
   * @param mach for transonic buffeting
   * @param handheld 0..1 wander amount (long lens tracking)
   * @param fovDeg narrow lenses magnify angular shake
   */
  update(dt: number, simT: number, mount: 'ground' | 'vehicle' | 'free', distance: number, vib: number, q: number, mach: number, handheld: number, fovDeg: number): void {
    this.t += dt;
    this.jolt *= Math.exp(-dt * this.joltDecay);
    let low = 0, mid = 0, high = 0, wander = handheld * 0.35;
    if (mount === 'ground') {
      const delay = distance / 343;
      const src = this.sourceAt(simT - delay);
      // sound pressure ~ sqrt(power)/r; perceived rumble saturates near the pad
      const amp = src > 0 ? Math.min(1.2, (Math.sqrt(src) * 900) / Math.max(150, distance)) : 0;
      low = amp * 0.9; mid = amp * 0.55; high = amp * 0.25;
    } else if (mount === 'vehicle') {
      const buffet = Math.min(1, q / 35000) * (0.4 + 0.6 * Math.exp(-Math.pow((mach - 1.05) / 0.25, 2)));
      low = vib * 0.25 + buffet * 0.6;
      mid = vib * 0.45 + buffet * 0.35;
      high = vib * 0.35;
    }
    low += this.jolt; mid += this.jolt * 0.6;
    const k = this.intensity;
    // narrow lenses magnify rotational shake (but a tripod damps the low end)
    const lens = Math.min(3, Math.max(0.6, 50 / Math.max(1, fovDeg)) ** 0.35);
    const rot = (axis: number, scale: number) => {
      const b = this.bands[axis];
      return (b[0].sample(this.t) * low * 0.006 + b[1].sample(this.t) * mid * 0.0035 + b[2].sample(this.t) * high * 0.0015 + b[3].sample(this.t) * wander * 0.004) * scale * k * lens;
    };
    _e.set(rot(0, 1), rot(1, 0.7), rot(2, 0.5));
    this.rotation.setFromEuler(_e);
    const pos = (axis: number) => {
      const b = this.bands[axis + 3];
      return (b[0].sample(this.t) * low * 0.06 + b[1].sample(this.t) * mid * 0.02) * k * (mount === 'vehicle' ? 0.3 : 1);
    };
    this.offset.set(pos(0), pos(1), pos(2));
  }

  /** Rough 0..1 rumble level (for audio / UI vibration). */
  get level(): number { return Math.min(1, Math.abs(this.offset.y) * 10 + this.jolt); }
}
