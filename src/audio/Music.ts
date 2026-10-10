/**
 * Adaptive score, synthesised live. Layers fade in and out with an intensity value set by the
 * flight (quiet anticipation on the pad, a pulse that tightens through the final minute, the
 * full ensemble at liftoff, release after staging, silence at orbit insertion, then a sparse
 * "wonder" texture in orbit). Mood picks the harmony.
 *
 * Layers: sub drone, detuned string-like pad through a moving low-pass, a plucked arpeggio
 * pulse, FM bell shimmer, and one-shot hits (timpani + noise swell).
 */

export type Mood = 'hope' | 'tension' | 'wonder' | 'night' | 'menu';

const PROGRESSIONS: Record<Mood, number[][]> = {
  // MIDI notes; D-centred
  menu: [[50, 57, 62, 66, 69], [47, 54, 59, 62, 66], [43, 50, 55, 59, 62], [45, 52, 57, 61, 64]],
  hope: [[50, 57, 62, 66, 69], [47, 54, 62, 66, 69], [43, 55, 59, 62, 66], [45, 57, 61, 64, 69]],
  wonder: [[50, 57, 64, 66, 68], [52, 59, 64, 68, 71], [47, 54, 59, 62, 68], [43, 55, 59, 62, 66]],
  tension: [[50, 57, 62, 64, 65], [46, 53, 58, 62, 65], [41, 53, 57, 60, 65], [48, 55, 60, 64, 67]],
  night: [[50, 57, 60, 65, 69], [43, 55, 58, 62, 65], [46, 53, 57, 62, 65], [45, 52, 57, 62, 64]],
};

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Music {
  private out: GainNode;
  private reverb: ConvolverNode;
  private dry: GainNode;
  private wet: GainNode;
  // layer buses
  private droneG: GainNode;
  private padG: GainNode;
  private padLp: BiquadFilterNode;
  private pulseG: GainNode;
  private shimmerG: GainNode;
  private drones: OscillatorNode[] = [];
  private padVoices: { osc: OscillatorNode[]; g: GainNode }[] = [];
  mood: Mood = 'menu';
  /** 0..1 */
  intensity = 0.25;
  private target = 0.25;
  private chordIdx = 0;
  private chordTimer = 0;
  private nextPulse = 0;
  private pulseStep = 0;
  private tempo = 112;
  private shimmerTimer = 1;
  private time = 0;
  private hush = 0;
  private scene: 'menu' | 'flight' = 'menu';
  /** layer enables driven by the flight */
  pulseOn = 0;
  shimmerOn = 0.5;

  constructor(private readonly ctx: AudioContext, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(dest);
    this.reverb = ctx.createConvolver();
    const n = Math.floor(ctx.sampleRate * 5.5);
    const ir = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let s = 101 + ch;
      for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; d[i] = ((s / 2147483647) * 2 - 1) * Math.pow(1 - i / n, 2.6); }
    }
    this.reverb.buffer = ir;
    this.dry = ctx.createGain(); this.dry.gain.value = 0.55;
    this.wet = ctx.createGain(); this.wet.gain.value = 0.7;
    const bus = ctx.createGain();
    bus.connect(this.dry).connect(this.out);
    bus.connect(this.reverb).connect(this.wet).connect(this.out);
    this.droneG = ctx.createGain(); this.droneG.gain.value = 0; this.droneG.connect(bus);
    this.padLp = ctx.createBiquadFilter(); this.padLp.type = 'lowpass'; this.padLp.frequency.value = 900; this.padLp.Q.value = 0.6;
    this.padG = ctx.createGain(); this.padG.gain.value = 0; this.padLp.connect(this.padG).connect(bus);
    this.pulseG = ctx.createGain(); this.pulseG.gain.value = 0; this.pulseG.connect(bus);
    this.shimmerG = ctx.createGain(); this.shimmerG.gain.value = 0; this.shimmerG.connect(bus);
    // sub drone: root + fifth, slowly beating
    for (const [m, det] of [[38, 0], [45, 3], [38, -4]] as [number, number][]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = mtof(m);
      o.detune.value = det;
      const g = ctx.createGain(); g.gain.value = 0.33;
      o.connect(g).connect(this.droneG);
      o.start();
      this.drones.push(o);
    }
    // pad: five voices x two detuned saws
    for (let i = 0; i < 5; i++) {
      const g = ctx.createGain(); g.gain.value = 0;
      const oscs: OscillatorNode[] = [];
      for (const det of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.detune.value = det + (Math.random() - 0.5) * 4;
        o.connect(g);
        o.start();
        oscs.push(o);
      }
      g.connect(this.padLp);
      this.padVoices.push({ osc: oscs, g });
    }
    this.applyChord(0, true);
  }

  setScene(scene: 'menu' | 'flight'): void {
    this.scene = scene;
    if (scene === 'menu') { this.setMood('menu'); this.target = 0.3; this.pulseOn = 0; this.shimmerOn = 0.6; }
  }

  setMood(m: Mood): void {
    if (this.mood === m) return;
    this.mood = m;
    this.chordIdx = 0;
    this.chordTimer = 0;
    this.applyChord(0, false);
  }

  setIntensity(x: number): void { this.target = Math.max(0, Math.min(1, x)); }

  private applyChord(i: number, immediate: boolean): void {
    const prog = PROGRESSIONS[this.mood];
    const chord = prog[i % prog.length];
    const t = this.ctx.currentTime;
    this.padVoices.forEach((v, k) => {
      const f = mtof(chord[k % chord.length] + (k >= 3 ? 0 : 0));
      for (const o of v.osc) {
        if (immediate) o.frequency.setValueAtTime(f, t);
        else o.frequency.setTargetAtTime(f, t, 1.4);
      }
    });
    const root = chord[0];
    this.drones[0].frequency.setTargetAtTime(mtof(root - 12), t, 2);
    this.drones[1].frequency.setTargetAtTime(mtof(root - 5), t, 2);
    this.drones[2].frequency.setTargetAtTime(mtof(root - 12), t, 2);
  }

  /** Big cinematic hit (ignition, liftoff, staging). */
  hit(strength = 1): void {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * strength, t + 0.01);
    g.gain.setTargetAtTime(0, t + 0.05, 0.5);
    o.connect(g).connect(this.dry);
    g.connect(this.reverb);
    o.start(t);
    o.stop(t + 3);
    // low brass-like swell on the root
    const chord = PROGRESSIONS[this.mood][this.chordIdx % 4];
    for (const m of [chord[0] - 12, chord[0] - 5, chord[0]]) {
      const b = ctx.createOscillator();
      b.type = 'sawtooth';
      b.frequency.value = mtof(m);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(200, t); lp.frequency.linearRampToValueAtTime(1400, t + 0.4); lp.frequency.setTargetAtTime(300, t + 0.6, 1.2);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0, t);
      bg.gain.linearRampToValueAtTime(0.09 * strength, t + 0.25);
      bg.gain.setTargetAtTime(0, t + 1.2, 1.4);
      b.connect(lp).connect(bg).connect(this.dry);
      bg.connect(this.reverb);
      b.start(t);
      b.stop(t + 7);
    }
  }

  /** Rising noise swell into a hit (e.g. the last seconds of the count). */
  swell(seconds: number): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(i / n, 3);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(4000, t + seconds); bp.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = 0.12;
    s.connect(bp).connect(g).connect(this.reverb);
    s.start(t);
  }

  private pluck(midi: number, at: number, vel: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = mtof(midi);
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = mtof(midi + 12);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(3200 * vel + 600, at); lp.frequency.setTargetAtTime(500, at, 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.11 * vel, at + 0.004);
    g.gain.setTargetAtTime(0, at + 0.01, 0.16);
    o.connect(lp); o2.connect(lp);
    lp.connect(g).connect(this.pulseG);
    o.start(at); o2.start(at);
    o.stop(at + 1); o2.stop(at + 1);
  }

  private bell(midi: number, at: number, vel: number): void {
    const ctx = this.ctx;
    const car = ctx.createOscillator();
    car.frequency.value = mtof(midi);
    const mod = ctx.createOscillator();
    mod.frequency.value = mtof(midi) * 3.5;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(mtof(midi) * 2.2, at);
    mg.gain.setTargetAtTime(0, at, 0.8);
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.045 * vel, at + 0.01);
    g.gain.setTargetAtTime(0, at + 0.02, 1.6);
    car.connect(g).connect(this.shimmerG);
    car.start(at); mod.start(at);
    car.stop(at + 7); mod.stop(at + 7);
  }

  update(dt: number, hush: number): void {
    this.time += dt;
    this.hush = hush;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.intensity += (this.target - this.intensity) * Math.min(1, dt * 0.6);
    const I = this.intensity * (1 - hush);
    this.droneG.gain.setTargetAtTime(0.16 * Math.min(1, I * 1.6), t, 0.5);
    this.padG.gain.setTargetAtTime(0.05 * Math.min(1, 0.25 + I), t, 0.6);
    this.padLp.frequency.setTargetAtTime(500 + 2400 * I * I, t, 0.8);
    for (const v of this.padVoices) v.g.gain.setTargetAtTime(0.18, t, 2);
    this.pulseG.gain.setTargetAtTime(this.pulseOn * Math.min(1, I * 1.3), t, 0.4);
    this.shimmerG.gain.setTargetAtTime(this.shimmerOn * (1 - hush), t, 0.8);
    // harmony moves slower when calm
    this.chordTimer += dt;
    const chordLen = 14 - 6 * I;
    if (this.chordTimer > chordLen) {
      this.chordTimer = 0;
      this.chordIdx++;
      this.applyChord(this.chordIdx, false);
    }
    // pulse scheduler (lookahead)
    if (this.pulseOn > 0.01 && I > 0.05) {
      const step = 60 / this.tempo / 2;
      if (this.nextPulse < t) this.nextPulse = t + 0.05;
      while (this.nextPulse < t + 0.25) {
        const chord = PROGRESSIONS[this.mood][this.chordIdx % 4];
        const pattern = [0, 2, 1, 3, 2, 4, 1, 3];
        const n = chord[pattern[this.pulseStep % 8] % chord.length] + 12;
        const accent = this.pulseStep % 4 === 0 ? 1 : 0.65;
        this.pluck(n, this.nextPulse, accent * (0.5 + 0.5 * I));
        this.pulseStep++;
        this.nextPulse += step;
      }
    }
    // shimmer bells
    this.shimmerTimer -= dt;
    if (this.shimmerTimer <= 0) {
      this.shimmerTimer = 1.5 + Math.random() * 4;
      if (this.shimmerOn > 0.05) {
        const chord = PROGRESSIONS[this.mood][this.chordIdx % 4];
        const n = chord[1 + Math.floor(Math.random() * (chord.length - 1))] + 24;
        this.bell(n, t + 0.02, 0.6 + Math.random() * 0.4);
      }
    }
    void this.scene;
  }

  /** Countdown tension: tempo and pulse ramp with the clock. */
  setTempo(bpm: number): void { this.tempo = bpm; }
}
