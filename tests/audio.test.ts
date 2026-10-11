import { describe, expect, it, vi } from 'vitest';
import { AudioEngine, type EngineSoundState } from '../src/audio/AudioEngine';
import type { AssetBundle } from '../src/core/assets';
import { DEFAULT_SETTINGS } from '../src/game/Settings';

/** the private parts the travel delay uses */
type Inner = { time: number; heardT: number; doppler: number; heard(st: EngineSoundState | null, dt: number): { thrust: number } };

const state = (thrustMN: number, distance: number): EngineSoundState => ({
  thrustMN, distance, onboard: false, airAtCamera: 1, airAtVehicle: 1, solid: 0, q: 0, mach: 0, plasma: 0, nearVehicle: false,
});

describe('engine sound travel delay', () => {
  vi.stubGlobal('window', { addEventListener: () => undefined });
  const make = () => new AudioEngine(DEFAULT_SETTINGS, {} as AssetBundle) as unknown as Inner;
  /** run the engine at `thrust` seen from `distance` for `seconds`, returning what is heard each frame */
  const run = (A: Inner, seconds: number, thrust: number, distance: number) => {
    const out: number[] = [];
    for (let t = 0; t < seconds; t += 1 / 30) {
      A.time += 1 / 30;
      out.push(A.heard(state(thrust, distance), 1 / 30).thrust);
    }
    return out;
  };

  it('a camera far away hears the ignition late, and keeps hearing it across a cut to a farther camera', () => {
    const A = make();
    run(A, 2, 0, 300);
    // ignition, seen from the pad camera 300 m away: heard ~0.9 s later
    const pad = run(A, 3, 7.6, 300);
    expect(pad[10]).toBe(0);
    expect(pad[pad.length - 1]).toBeCloseTo(7.6, 3);
    // cut to a tracking camera 5 km out: its sound would have left before ignition, but the
    // engine never falls silent again
    const far = run(A, 8, 7.6, 5000);
    expect(Math.min(...far)).toBeGreaterThan(7);
    // and the wait never exceeds six seconds, however far the camera
    run(A, 10, 7.6, 100_000);
    expect(A.time - A.heardT).toBeLessThanOrEqual(6 + 1e-6);
    expect(A.doppler).toBeGreaterThanOrEqual(0.75);
    expect(A.doppler).toBeLessThanOrEqual(1.15);
  });

  it('the cutoff reaches a distant camera late too', () => {
    const A = make();
    run(A, 5, 7.6, 2000);
    const after = run(A, 8, 0, 2000);
    // 2 km: the last of the engine arrives ~5.8 s after it stopped
    expect(after[30 * 4]).toBeGreaterThan(7);
    expect(after[after.length - 1]).toBe(0);
  });
});
