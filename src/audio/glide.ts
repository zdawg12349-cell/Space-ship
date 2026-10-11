const last = new WeakMap<AudioParam, number>();

/**
 * setTargetAtTime, only when the target has moved. The engine, wind, ambience and score set
 * dozens of parameters every frame; scheduling each one every frame piles automation events
 * onto the audio thread until, on a slow machine, it can no longer keep up: the sound starts
 * to crackle and then drops out. Non-finite values are ignored.
 */
export function glide(p: AudioParam, v: number, t: number, tc: number): void {
  if (!Number.isFinite(v)) return;
  const l = last.get(p);
  if (l !== undefined && Math.abs(v - l) <= 1e-4 + Math.abs(l) * 0.004) return;
  last.set(p, v);
  p.cancelScheduledValues(t);
  p.setTargetAtTime(v, t, tc);
}
