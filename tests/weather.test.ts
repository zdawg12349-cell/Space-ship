import { describe, expect, it } from 'vitest';
import { Quaternion, Scene, Vector3 } from 'three';
import { DECK_PRESETS, type CloudDeck } from '../src/render/weather/CloudDeck';
import { Lightning } from '../src/render/weather/Lightning';
import { WEATHER_PRESETS, type WeatherKind } from '../src/game/providers';

describe('weather', () => {
  it('every weather has a cloud deck, heavier as the weather worsens', () => {
    for (const k of Object.keys(WEATHER_PRESETS)) expect(DECK_PRESETS[k as WeatherKind]).toBeTruthy();
    const order: WeatherKind[] = ['clear', 'fair', 'breezy', 'overcast'];
    for (let i = 1; i < order.length; i++) expect(DECK_PRESETS[order[i]].cover).toBeGreaterThan(DECK_PRESETS[order[i - 1]].cover);
    for (const p of Object.values(DECK_PRESETS)) {
      expect(p.top).toBeGreaterThan(p.base);
      expect(p.base).toBeGreaterThan(0.3);
      expect(p.cover).toBeLessThanOrEqual(1);
    }
    // only the storm rains hard and throws lightning; cumulonimbus tops reach far higher
    expect(DECK_PRESETS.storm.rain).toBe(1);
    expect(DECK_PRESETS.storm.lightning).toBeGreaterThan(0);
    expect(DECK_PRESETS.fair.lightning).toBe(0);
    expect(DECK_PRESETS.storm.top).toBeGreaterThan(DECK_PRESETS.overcast.top * 2);
  });

  it('lightning strikes at the storm rate, kilometres away, and the thunder knows how far', () => {
    const flashes: number[] = [];
    const strikes: { d: number; k: number }[] = [];
    const deck = {
      params: DECK_PRESETS.storm,
      active: 1,
      uniforms: { uDeckFlashIrr: { value: new Vector3() } },
      setFlash: (p: Vector3 | null, i = 0) => { if (p && i > 0) flashes.push(p.length() - 6371); },
    } as unknown as CloudDeck;
    const lightning = new Lightning(new Scene());
    lightning.onStrike = (d, k) => strikes.push({ d, k });
    const cam = new Vector3(6371.05, 0, 0);
    const rot = new Quaternion();
    const minutes = 20;
    for (let t = 0; t < minutes * 60; t += 0.05) lightning.update(0.05, deck, cam, rot, new Vector3(6_371_050, 0, 0));
    const rate = strikes.length / minutes;
    expect(rate).toBeGreaterThan(DECK_PRESETS.storm.lightning * 0.6);
    expect(rate).toBeLessThan(DECK_PRESETS.storm.lightning * 1.4);
    for (const s of strikes) {
      expect(s.d).toBeGreaterThan(2_500);
      expect(s.d).toBeLessThan(26_000);
      expect(s.k).toBeGreaterThan(0);
    }
    // the light is inside the cloud, between its base and its tops
    for (const h of flashes) {
      expect(h).toBeGreaterThan(DECK_PRESETS.storm.base - 0.01);
      expect(h).toBeLessThan(DECK_PRESETS.storm.top);
    }
    // nothing while the camera is high above the weather
    const before = strikes.length;
    const high = new Vector3(6371 + 60, 0, 0);
    for (let t = 0; t < 600; t += 0.05) lightning.update(0.05, deck, high, rot, new Vector3());
    expect(strikes.length).toBe(before);
  });
});
