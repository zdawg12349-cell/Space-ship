import type { AssetBundle } from '../core/assets';
import type { Settings } from '../game/Settings';
import { Music } from './Music';
import { Radio } from './Radio';

/**
 * Procedural audio. Every sound except the recorded mission-control voices is synthesised
 * with the Web Audio API:
 *
 *  - Rocket noise: sub-bass rumble, a broadband roar and the impulsive "crackle" of shock
 *    waves, mixed by thrust. Heard from the ground it arrives late (distance / 343 m/s, with
 *    Doppler as the delay stretches), loses its highs to air absorption and fades with
 *    distance; onboard it is structure-borne and muffled; in vacuum there is nothing to carry
 *    it, so external cameras fall silent.
 *  - Aerodynamic wind and transonic buffeting, reentry plasma roar.
 *  - Pad ambience: sea breeze, surf, insects and birds, cryogenic venting hiss, deluge water.
 *  - One-shots: clamp release, pyrotechnic separation, chute deploy, touchdown, splashdown,
 *    explosion, RCS puffs, turbopump spin-up whine, interface clicks.
 *  - Adaptive score (Music) and the radio voice chain (Radio).
 */

export interface EngineSoundState {
  /** total thrust audible (MN) */
  thrustMN: number;
  /** camera-to-source distance (m); 0 for onboard */
  distance: number;
  onboard: boolean;
  /** ambient pressure ratio at the camera (0 = vacuum) */
  airAtCamera: number;
  /** ambient pressure ratio at the vehicle */
  airAtVehicle: number;
  /** solid-motor fraction (crackle character) */
  solid: number;
  /** dynamic pressure (Pa), Mach, for wind / buffeting (onboard / chase) */
  q: number;
  mach: number;
  /** reentry plasma 0..1 */
  plasma: number;
  /** camera close to the vehicle (chase) gets wind too */
  nearVehicle: boolean;
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number, kind: 'white' | 'pink' | 'brown' | 'crackle', seed = 1): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let s = seed * 9973 + ch * 7919;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    let env = 0;
    for (let i = 0; i < n; i++) {
      const w = rnd() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else {
        // crackle: sparse N-wave impulses of random size on a rough bed
        if (rnd() < 0.0035) env = (rnd() * 0.8 + 0.2) * (rnd() < 0.15 ? 2.2 : 1);
        env *= 0.93;
        d[i] = env * (rnd() < 0.5 ? 1 : -1) * (0.6 + 0.4 * rnd()) + w * 0.05;
      }
    }
    // fade the loop seam
    const f = Math.min(2000, n / 4);
    for (let i = 0; i < f; i++) { const k = i / f; d[i] *= k; d[n - 1 - i] *= k; }
  }
  return buf;
}

function impulseResponse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let s = 31 + ch * 17;
    for (let i = 0; i < n; i++) {
      s = (s * 16807) % 2147483647;
      const w = (s / 2147483647) * 2 - 1;
      d[i] = w * Math.pow(1 - i / n, decay) * (i < ctx.sampleRate * 0.02 ? i / (ctx.sampleRate * 0.02) : 1);
    }
  }
  return buf;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfx!: GainNode;
  musicBus!: GainNode;
  voiceBus!: GainNode;
  ambBus!: GainNode;
  reverb!: ConvolverNode;
  reverbSend!: GainNode;
  music: Music | null = null;
  radio: Radio | null = null;
  private buffers: Record<string, AudioBuffer> = {};
  // rocket layers
  private engine: {
    rumble: GainNode; roar: GainNode; crackle: GainNode; lp: BiquadFilterNode; delay: DelayNode; out: GainNode; roarBp: BiquadFilterNode;
    onboard: GainNode; onboardLp: BiquadFilterNode;
  } | null = null;
  private wind: { gain: GainNode; bp: BiquadFilterNode; buffet: GainNode } | null = null;
  private amb: { breeze: GainNode; surf: GainNode; insects: GainNode; vent: GainNode; deluge: GainNode; rain: GainNode; rainLow: GainNode } | null = null;
  /** weather: wind strength multiplier for the breeze, rain falling on the camera 0..1 */
  private windLevel = 1;
  private plasma: GainNode | null = null;
  private scene: 'menu' | 'flight' = 'menu';
  private time = 0;
  private birdTimer = 2;
  private settings: Settings;
  /** silence after orbit insertion: 0..1 fade on everything but the radio */
  hush = 0;
  private hushTarget = 0;
  private started = false;

  constructor(settings: Settings, readonly assets: AssetBundle) {
    this.settings = settings;
    const resume = () => { this.start(); };
    window.addEventListener('pointerdown', resume, { once: false });
    window.addEventListener('keydown', resume, { once: false });
  }

  /** Create the context on the first user gesture (browser autoplay policy). */
  start(): void {
    if (this.started) { if (this.ctx?.state === 'suspended') void this.ctx.resume(); return; }
    this.started = true;
    let ctx: AudioContext;
    // (the 'playback' latency's larger buffers ride out a busy main thread and a slow CPU: with
    // the smallest buffers the sound kept breaking up on low-end laptops. A tenth of a second
    // more latency is inaudible against engine sound that already arrives with its distance delay)
    try { ctx = new AudioContext({ latencyHint: 'playback' }); } catch { try { ctx = new AudioContext(); } catch { return; } }
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.musicBus = ctx.createGain(); this.musicBus.connect(this.master);
    this.voiceBus = ctx.createGain(); this.voiceBus.connect(this.master);
    this.ambBus = ctx.createGain(); this.ambBus.connect(this.sfx);
    this.reverb = ctx.createConvolver();
    // (a long convolution is the costliest node in the graph: 2.2 s keeps the pad's echo but
    // leaves the audio thread headroom on a weak CPU)
    this.reverb.buffer = impulseResponse(ctx, 2.2, 3.0);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.35;
    this.reverbSend.connect(this.reverb).connect(this.sfx);
    this.buffers.white = noiseBuffer(ctx, 4, 'white', 1);
    this.buffers.pink = noiseBuffer(ctx, 6, 'pink', 2);
    this.buffers.brown = noiseBuffer(ctx, 6, 'brown', 3);
    this.buffers.crackle = noiseBuffer(ctx, 5, 'crackle', 4);
    this.buildEngine();
    this.buildWind();
    this.buildAmbience();
    this.music = new Music(ctx, this.musicBus);
    this.radio = new Radio(ctx, this.voiceBus, this.assets.voiceManifest, this.buffers.white);
    this.applySettings(this.settings);
    this.music.setScene(this.scene);
  }

  private loop(name: string, rate = 1): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.buffers[name];
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(ctx.currentTime + Math.random() * 0.05, Math.random() * (s.buffer!.duration - 0.1));
    return s;
  }

  private buildEngine(): void {
    const ctx = this.ctx!;
    // external path: layers -> air absorption -> distance delay (Doppler) -> out
    const sum = ctx.createGain();
    const rumbleSrc = this.loop('brown', 1);
    const rumbleLp = ctx.createBiquadFilter(); rumbleLp.type = 'lowpass'; rumbleLp.frequency.value = 140; rumbleLp.Q.value = 0.7;
    const rumble = ctx.createGain(); rumble.gain.value = 0;
    rumbleSrc.connect(rumbleLp).connect(rumble).connect(sum);
    const roarSrc = this.loop('pink', 1);
    const roarBp = ctx.createBiquadFilter(); roarBp.type = 'bandpass'; roarBp.frequency.value = 420; roarBp.Q.value = 0.45;
    const roar = ctx.createGain(); roar.gain.value = 0;
    roarSrc.connect(roarBp).connect(roar).connect(sum);
    const crSrc = this.loop('crackle', 1);
    const crHp = ctx.createBiquadFilter(); crHp.type = 'highpass'; crHp.frequency.value = 600;
    const crackle = ctx.createGain(); crackle.gain.value = 0;
    crSrc.connect(crHp).connect(crackle).connect(sum);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 8000; lp.Q.value = 0.5;
    const delay = ctx.createDelay(90);
    delay.delayTime.value = 0;
    const out = ctx.createGain(); out.gain.value = 0;
    sum.connect(lp).connect(delay).connect(out).connect(this.sfx);
    out.connect(this.reverbSend);
    // onboard (structure-borne) path: the same layers, muffled, no delay
    const onboardLp = ctx.createBiquadFilter(); onboardLp.type = 'lowpass'; onboardLp.frequency.value = 900; onboardLp.Q.value = 0.9;
    const onboard = ctx.createGain(); onboard.gain.value = 0;
    sum.connect(onboardLp).connect(onboard).connect(this.sfx);
    this.engine = { rumble, roar, crackle, lp, delay, out, roarBp, onboard, onboardLp };
  }

  private buildWind(): void {
    const ctx = this.ctx!;
    const src = this.loop('white', 0.5);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.6;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(bp).connect(gain).connect(this.sfx);
    const bsrc = this.loop('brown', 2.2);
    const buffet = ctx.createGain(); buffet.gain.value = 0;
    bsrc.connect(buffet).connect(this.sfx);
    this.wind = { gain, bp, buffet };
    // reentry plasma roar
    const psrc = this.loop('pink', 0.7);
    const plp = ctx.createBiquadFilter(); plp.type = 'lowpass'; plp.frequency.value = 600;
    this.plasma = ctx.createGain(); this.plasma.gain.value = 0;
    psrc.connect(plp).connect(this.plasma).connect(this.sfx);
  }

  private buildAmbience(): void {
    const ctx = this.ctx!;
    const mk = (buf: string, rate: number, type: BiquadFilterType, f: number, q: number) => {
      const s = this.loop(buf, rate);
      const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      s.connect(flt).connect(g).connect(this.ambBus);
      return g;
    };
    const breeze = mk('pink', 0.35, 'lowpass', 700, 0.4);
    const surf = mk('brown', 0.8, 'lowpass', 900, 0.3);
    const insects = mk('white', 1, 'bandpass', 5200, 9);
    const vent = mk('white', 1, 'highpass', 2600, 0.5);
    const deluge = mk('pink', 1.3, 'bandpass', 1400, 0.5);
    // rain: a broad hiss of drops plus the low roar of a downpour on the ground
    const rain = mk('white', 0.9, 'bandpass', 3800, 0.35);
    const rainLow = mk('pink', 0.8, 'lowpass', 700, 0.5);
    this.amb = { breeze, surf, insects, vent, deluge, rain, rainLow };
  }

  applySettings(s: Settings): void {
    this.settings = s;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.master, t, 0.1);
    this.musicBus.gain.setTargetAtTime(s.music * 0.8, t, 0.1);
    this.sfx.gain.setTargetAtTime(s.sfx, t, 0.1);
    this.voiceBus.gain.setTargetAtTime(s.voice, t, 0.1);
  }

  setScene(scene: 'menu' | 'flight'): void {
    this.scene = scene;
    this.music?.setScene(scene);
    if (scene === 'menu') { this.setEngine(null); this.setAmbience(0, 0, 0, 0); this.hush = this.hushTarget = 0; }
  }

  /** Deliberate silence (orbit insertion): fade engine/wind/music out, radio stays. */
  setHush(on: boolean): void { this.hushTarget = on ? 1 : 0; }

  setEngine(st: EngineSoundState | null): void {
    if (!this.ctx || !this.engine) return;
    const e = this.engine;
    const t = this.ctx.currentTime;
    const tc = 0.08;
    if (!st || st.thrustMN <= 0) {
      e.out.gain.setTargetAtTime(0, t, 0.4);
      e.onboard.gain.setTargetAtTime(0, t, 0.3);
      for (const g of [e.rumble, e.roar, e.crackle]) g.gain.setTargetAtTime(0, t, 0.5);
    } else {
      const P = Math.sqrt(st.thrustMN);
      const vacVehicle = st.airAtVehicle;
      // the jet only becomes loud in air: in vacuum the noise sources vanish
      const sourceAir = Math.min(1, 0.04 + vacVehicle * 1.4);
      e.rumble.gain.setTargetAtTime(Math.min(1.2, 0.35 * P) * sourceAir, t, tc);
      e.roar.gain.setTargetAtTime(Math.min(0.9, 0.22 * P) * sourceAir, t, tc);
      e.crackle.gain.setTargetAtTime(Math.min(1.1, (0.25 + st.solid * 0.25) * P) * sourceAir, t, tc);
      e.roarBp.frequency.setTargetAtTime(380 + 200 / (1 + st.thrustMN), t, 0.3);
      if (st.onboard) {
        e.out.gain.setTargetAtTime(0, t, 0.1);
        e.onboard.gain.setTargetAtTime(0.55 * Math.min(1, 0.4 + P * 0.15) * (1 - this.hush), t, 0.1);
        e.onboardLp.frequency.setTargetAtTime(500 + 900 * st.airAtCamera, t, 0.2);
        e.delay.delayTime.setTargetAtTime(0, t, 0.05);
      } else {
        const d = Math.max(30, st.distance);
        // spherical spreading (relative to 300 m) and air absorption of the highs
        const level = Math.min(1.4, 300 / d) * st.airAtCamera * (1 - this.hush);
        e.out.gain.setTargetAtTime(level, t, 0.15);
        e.onboard.gain.setTargetAtTime(0, t, 0.1);
        e.lp.frequency.setTargetAtTime(Math.max(180, 14000 * Math.exp(-d / 2500)), t, 0.2);
        // delay follows the distance smoothly: as it grows the pitch drops (Doppler)
        e.delay.delayTime.setTargetAtTime(Math.min(85, d / 343), t, 0.5);
      }
    }
    // wind & buffeting for onboard / close cameras
    if (this.wind && st) {
      const w = st.onboard || st.nearVehicle ? Math.min(1, st.q / 30000) : 0;
      this.wind.gain.gain.setTargetAtTime(w * 0.5 * (1 - this.hush), t, 0.2);
      this.wind.bp.frequency.setTargetAtTime(300 + st.mach * 500, t, 0.3);
      const buffet = st.onboard ? Math.min(1, st.q / 25000) * Math.exp(-Math.pow((st.mach - 1.05) / 0.3, 2)) : 0;
      this.wind.buffet.gain.setTargetAtTime(buffet * 0.6, t, 0.2);
      this.plasma!.gain.setTargetAtTime(st.plasma * (st.onboard || st.nearVehicle ? 0.6 : 0.2), t, 0.3);
    } else if (this.wind) {
      this.wind.gain.gain.setTargetAtTime(0, t, 0.3);
      this.wind.buffet.gain.setTargetAtTime(0, t, 0.3);
      this.plasma?.gain.setTargetAtTime(0, t, 0.3);
    }
  }

  /** Pad ambience levels 0..1 (outdoor near the pad). */
  setAmbience(outdoor: number, vent: number, deluge: number, night: number): void {
    if (!this.ctx || !this.amb) return;
    const t = this.ctx.currentTime;
    const a = this.amb;
    const k = 1 - this.hush;
    a.breeze.gain.setTargetAtTime(0.12 * outdoor * k * this.windLevel, t, 0.5);
    a.surf.gain.setTargetAtTime(0.1 * outdoor * k, t, 0.5);
    a.insects.gain.setTargetAtTime(0.012 * outdoor * (0.4 + 0.6 * night) * k, t, 0.5);
    a.vent.gain.setTargetAtTime(0.05 * vent * outdoor, t, 0.3);
    a.deluge.gain.setTargetAtTime(0.18 * deluge * outdoor, t, 0.3);
    this.birdOutdoor = outdoor * (1 - night);
  }
  private birdOutdoor = 0;

  /** Weather around the camera: rain falling on it (0..1) and how windy it is (1 = a sea breeze). */
  setWeather(rain: number, wind: number): void {
    this.windLevel = wind;
    if (!this.ctx || !this.amb) return;
    const t = this.ctx.currentTime;
    const k = 1 - this.hush * 0.7;
    this.amb.rain.gain.setTargetAtTime(0.11 * rain * k, t, 0.6);
    this.amb.rainLow.gain.setTargetAtTime(0.09 * rain * k, t, 0.6);
  }

  /** Thunder from a strike `distance` m away: a crack if it is close, then the long roll. */
  thunder(distance: number, strength = 1): void {
    if (!this.ctx) return;
    const delay = Math.min(60, distance / 343);
    const far = Math.min(1, 2500 / Math.max(1200, distance)) * strength;
    const lp = Math.max(110, 900 * Math.exp(-distance / 6000));
    if (distance < 4000) this.burst({ buf: 'white', dur: 0.45, gain: 0.45 * far, hp: 900, lp: 6000, decay: 0.08, delay, reverb: 0.7 });
    this.burst({ buf: 'brown', dur: 6, gain: 1.0 * far, lp, attack: 0.15, decay: 1.6, delay: delay + 0.05, reverb: 0.9, rate: 0.7 });
    // the sound from different parts of the channel arrives spread over seconds: it rolls
    let d = delay + 0.6;
    for (let i = 0; i < 3; i++) {
      this.burst({ buf: 'brown', dur: 3, gain: (0.55 - i * 0.12) * far, lp: lp * 0.8, attack: 0.3, decay: 0.9, delay: d, rate: 0.6 + Math.random() * 0.2 });
      d += 0.7 + Math.random() * 0.9;
    }
  }

  // ------------------------------------------------------------------------------ one-shots

  private burst(opts: { buf?: string; dur: number; gain: number; lp?: number; hp?: number; attack?: number; decay?: number; rate?: number; delay?: number; reverb?: number; pitchDrop?: number }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[opts.buf ?? 'white'];
    src.playbackRate.value = opts.rate ?? 1;
    if (opts.pitchDrop) src.playbackRate.exponentialRampToValueAtTime(Math.max(0.05, (opts.rate ?? 1) * opts.pitchDrop), t + opts.dur);
    let node: AudioNode = src;
    if (opts.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.lp; node.connect(f); node = f; }
    if (opts.hp) { const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = opts.hp; node.connect(f); node = f; }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(opts.gain, t + (opts.attack ?? 0.005));
    g.gain.setTargetAtTime(0, t + (opts.attack ?? 0.005), (opts.decay ?? opts.dur / 4));
    node.connect(g).connect(this.sfx);
    if (opts.reverb) { const r = ctx.createGain(); r.gain.value = opts.reverb; g.connect(r).connect(this.reverbSend); }
    src.start(t, Math.random() * 2);
    src.stop(t + opts.dur + 1);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', delay = 0, freqEnd?: number, dest?: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.setTargetAtTime(0, t + dur * 0.4, dur / 4);
    o.connect(g).connect(dest ?? this.sfx);
    o.start(t);
    o.stop(t + dur + 0.5);
  }

  /** Named sound effects; `distance` delays & muffles external sounds. */
  play(name: string, distance = 0, onboard = false): void {
    if (!this.ctx) return;
    const delay = onboard ? 0 : Math.min(30, distance / 343);
    const far = onboard ? 1 : Math.min(1, 400 / Math.max(50, distance));
    const lp = onboard ? 1500 : Math.max(250, 9000 * Math.exp(-distance / 3000));
    switch (name) {
      case 'clamps': this.burst({ buf: 'brown', dur: 0.8, gain: 0.9 * far, lp: 400, delay, reverb: 0.6 }); this.burst({ buf: 'white', dur: 0.25, gain: 0.25 * far, hp: 1500, lp, delay }); break;
      case 'pyro': this.burst({ buf: 'white', dur: 0.35, gain: 0.8 * far, lp: Math.min(lp, 5000), delay, reverb: 0.4 }); this.burst({ buf: 'brown', dur: 1.2, gain: 0.6 * far, lp: 220, delay }); break;
      case 'separation': this.burst({ buf: 'white', dur: 0.5, gain: 0.55 * far, lp: Math.min(lp, 3000), delay, reverb: 0.3 }); this.tone(70, 0.8, 0.4 * far, 'sine', delay, 35); break;
      case 'ignition': this.burst({ buf: 'brown', dur: 2.5, gain: 1.0 * far, lp: 300, attack: 0.08, decay: 0.8, delay, reverb: 0.8 }); break;
      case 'spinup': this.tone(180, 3.0, 0.05, 'sawtooth', 0, 1400); this.tone(240, 3.0, 0.03, 'triangle', 0.2, 2200); break;
      case 'chute': this.burst({ buf: 'pink', dur: 1.4, gain: 0.5, lp: 2500, attack: 0.15, decay: 0.4 }); this.burst({ buf: 'brown', dur: 0.4, gain: 0.6, lp: 300, delay: 0.7 }); break;
      case 'touchdown': this.burst({ buf: 'brown', dur: 0.8, gain: 0.9 * far, lp: 260, delay }); break;
      case 'splash': this.burst({ buf: 'pink', dur: 2.5, gain: 0.7 * far, lp: 3000, attack: 0.02, decay: 0.7, delay }); this.burst({ buf: 'brown', dur: 1, gain: 0.8 * far, lp: 200, delay }); break;
      case 'explosion':
        this.burst({ buf: 'brown', dur: 6, gain: 1.4 * far, lp: 180, attack: 0.01, decay: 1.8, delay, reverb: 1 });
        this.burst({ buf: 'crackle', dur: 4, gain: 0.8 * far, lp: Math.min(lp, 4000), attack: 0.01, decay: 1.2, delay });
        this.burst({ buf: 'white', dur: 0.4, gain: 0.9 * far, lp, delay, reverb: 0.8 });
        break;
      // landing legs: the pneumatic push as they swing out, then the clunk as they lock
      case 'legs':
        this.burst({ buf: 'white', dur: 0.7, gain: 0.3 * far, hp: 500, lp: Math.min(lp, 4000), attack: 0.03, decay: 0.35, delay });
        this.burst({ buf: 'brown', dur: 0.35, gain: 0.5 * far, lp: 260, delay: delay + 2.4 });
        break;
      // a cold-gas thruster's hiss is quiet: heard close by, or through the structure on board
      case 'rcs': this.burst({ buf: 'white', dur: 0.12, gain: 0.08 * (onboard ? 1 : Math.min(1, 60 / Math.max(15, distance))), hp: 1800, lp: Math.min(lp, 7000), decay: 0.03, delay }); break;
      case 'ui': this.tone(1400, 0.06, 0.03, 'sine'); break;
      case 'ui_select': this.tone(880, 0.09, 0.04, 'sine'); this.tone(1320, 0.12, 0.03, 'sine', 0.05); break;
      case 'stage': this.tone(520, 0.12, 0.05, 'square'); break;
      case 'alarm': for (let i = 0; i < 3; i++) this.tone(990, 0.18, 0.06, 'square', i * 0.3); break;
      case 'shutter': this.burst({ buf: 'white', dur: 0.08, gain: 0.25, hp: 2000, decay: 0.02 }); this.burst({ buf: 'white', dur: 0.06, gain: 0.2, hp: 3000, decay: 0.015, delay: 0.09 }); break;
    }
  }

  /** Per-frame: birds, hush fade, music. */
  update(dt: number): void {
    this.time += dt;
    if (!this.ctx) return;
    this.hush += (this.hushTarget - this.hush) * Math.min(1, dt * 0.35);
    this.music?.update(dt, this.hush);
    this.radio?.update(dt);
    // occasional bird calls near the pad in daylight
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 2 + Math.random() * 7;
      if (this.birdOutdoor > 0.3 && this.hush < 0.5) {
        const f = 2400 + Math.random() * 1800;
        const n = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < n; i++) this.tone(f * (1 + (Math.random() - 0.5) * 0.15), 0.09, 0.006 * this.birdOutdoor, 'sine', i * 0.13, f * 1.25, this.ambBus);
      }
    }
  }
}
