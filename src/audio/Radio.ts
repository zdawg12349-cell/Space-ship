/**
 * Mission-control radio. Plays the synthesised voice lines through a band-limited, lightly
 * saturated radio chain with carrier hiss, squelch tails and intro/outro tones, queues lines
 * so voices never talk over each other, drops stale call-outs (a countdown number that would
 * play late is skipped) and reports each line for subtitles.
 */

import { disposeOnEnd } from './glide';

export interface VoiceLine { role: string; text: string; duration: number }

const ROLE_NAMES: Record<string, string> = {
  LAUNCH: 'LAUNCH CONTROL', FLIGHT: 'FLIGHT', CAPCOM: 'CAPCOM', RANGE: 'RANGE', RECOVERY: 'RECOVERY', GNC: 'GUIDANCE',
};

interface Queued { id: string; at: number; simAt: number; priority: number }

export class Radio {
  private cache = new Map<string, Promise<AudioBuffer | null>>();
  private queue: Queued[] = [];
  private playing: { src: AudioBufferSourceNode; until: number; priority: number } | null = null;
  private input: GainNode;
  private hiss: GainNode;
  private time = 0;
  onLine: ((who: string, text: string, duration: number) => void) | null = null;
  enabled = true;
  /**
   * The flight's clock (simulation seconds), when there is a flight: a call-out goes stale by
   * the simulation's time too, so time warp or a fast-forward never plays "T minus forty five
   * seconds" minutes after liftoff.
   */
  clock: (() => number) | null = null;

  constructor(private readonly ctx: AudioContext, out: AudioNode, private readonly manifest: Record<string, VoiceLine>, white: AudioBuffer) {
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 330; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3300; lp.Q.value = 0.8;
    const peak = ctx.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 1800; peak.gain.value = 4; peak.Q.value = 1;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); }
    shaper.curve = curve;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.12;
    this.input = ctx.createGain();
    this.input.gain.value = 0.7;
    this.input.connect(hp).connect(peak).connect(lp).connect(shaper).connect(comp).connect(out);
    // carrier hiss while keyed
    const hs = ctx.createBufferSource();
    hs.buffer = white; hs.loop = true;
    const hbp = ctx.createBiquadFilter(); hbp.type = 'bandpass'; hbp.frequency.value = 2400; hbp.Q.value = 0.8;
    this.hiss = ctx.createGain();
    this.hiss.gain.value = 0;
    hs.connect(hbp).connect(this.hiss).connect(out);
    hs.start();
  }

  private load(id: string): Promise<AudioBuffer | null> {
    let p = this.cache.get(id);
    if (!p) {
      p = fetch(`${import.meta.env.BASE_URL}assets/audio/voice/${id}.mp3`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((b) => this.ctx.decodeAudioData(b))
        .catch(() => null);
      this.cache.set(id, p);
    }
    return p;
  }

  /** Warm the cache (e.g. the whole countdown before T-0). */
  prefetch(ids: string[]): void { for (const id of ids) if (this.manifest[id]) void this.load(id); }

  say(id: string, priority = 1): void {
    if (!this.enabled || !this.manifest[id]) return;
    void this.load(id);
    if (this.playing && priority > this.playing.priority + 1) {
      try { this.playing.src.stop(); } catch { /* already stopped */ }
      this.playing = null;
    }
    this.queue.push({ id, at: this.time, simAt: this.clock ? this.clock() : NaN, priority });
    this.queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    if (this.queue.length > 4) this.queue.length = 4;
  }

  private tone(freq: number, at: number, dur: number): void {
    const o = this.ctx.createOscillator();
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.09, at + 0.01);
    g.gain.setValueAtTime(0.09, at + dur - 0.01);
    g.gain.linearRampToValueAtTime(0, at + dur);
    o.connect(g).connect(this.input);
    disposeOnEnd(o, g);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  private async playNext(): Promise<void> {
    const q = this.queue.shift();
    if (!q) return;
    // count-outs and time-critical calls go stale fast
    const stale = q.id.startsWith('cnt_') || q.id.startsWith('ign') ? 1.2 : 8;
    if (this.time - q.at > stale) return;
    if (this.clock && this.clock() - q.simAt > stale) return;
    const line = this.manifest[q.id];
    const marker = { src: null as unknown as AudioBufferSourceNode, until: this.time + 0.5, priority: q.priority };
    this.playing = marker;
    const buf = await this.load(q.id);
    if (this.playing !== marker) return;
    if (!buf) { this.playing = null; return; }
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const quindar = line.role === 'CAPCOM' || line.role === 'FLIGHT';
    const lead = quindar ? 0.28 : 0.06;
    if (quindar) this.tone(2525, t, 0.25);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.input);
    disposeOnEnd(src);
    src.start(t + lead);
    const end = t + lead + buf.duration;
    if (quindar) this.tone(2475, end + 0.04, 0.25);
    // key up: hiss on, squelch tail after
    this.hiss.gain.setTargetAtTime(0.012, t, 0.02);
    this.hiss.gain.setValueAtTime(0.03, end + (quindar ? 0.3 : 0.02));
    this.hiss.gain.setTargetAtTime(0, end + (quindar ? 0.32 : 0.05), 0.05);
    marker.src = src;
    marker.until = this.time + lead + buf.duration + (quindar ? 0.4 : 0.15);
    this.onLine?.(ROLE_NAMES[line.role] ?? line.role, line.text, buf.duration + lead);
  }

  update(dt: number): void {
    this.time += dt;
    if (this.playing && this.time >= this.playing.until) this.playing = null;
    if (!this.playing && this.queue.length) void this.playNext();
  }

  /** Text of a line (for subtitles when audio is unavailable). */
  textOf(id: string): VoiceLine | undefined { return this.manifest[id]; }

  clear(): void {
    this.queue = [];
    if (this.playing?.src) try { this.playing.src.stop(); } catch { /* */ }
    this.playing = null;
  }
}
