import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene, Texture, Vector2, Vector3 } from 'three';
import { createPuffAtlas, ParticleSystem } from '../src/fx/Particles';
import { CameraDirector, type CamContext } from '../src/camera/CameraDirector';
import type { CelestialBody } from '../src/physics/bodies';
import { getVehicle } from '../src/vehicles/catalog';
import { CAPE, makeWorld } from './helpers';

/** private per-particle state the shading writes (sun visibility, ambient occlusion) */
type Shaded = { px: Float32Array; py: Float32Array; pz: Float32Array; ao: Float32Array; vis: Float32Array };

describe('particles', () => {
  const R = 6_371_000;
  /** height above the ground sphere through the frame origin */
  const height = (P: Shaded, i: number) => Math.hypot(P.px[i], P.py[i] + R, P.pz[i]) - R;
  const step = (P: ParticleSystem, n = 1) => {
    for (let k = 0; k < n; k++) P.update(1 / 30, new Vector3(0, 50, 0), new Vector3(1, 0, 0), 1e9, new Vector2(320, 180));
  };

  it('a puff far from the frame anchor is lit like one near it, not by negative light', () => {
    const P = new ParticleSystem(new Scene(), new Texture(), () => new Texture(), 64);
    P.bodyRadius = R;
    // 1500 km downrange the ground lies ~179 km below the anchor's tangent plane, and "up" there
    // is tilted by 13.6 degrees
    const d = 1_500_000;
    const up = new Vector3(d, Math.sqrt(R * R - d * d), 0).normalize();
    P.emit({ kind: 'vapor', pos: up.clone().multiplyScalar(R + 60).sub(new Vector3(0, R, 0)), vel: new Vector3(), size: 0.3, life: 5 });
    P.emit({ kind: 'vapor', pos: new Vector3(0, 60, 0), vel: new Vector3(), size: 0.3, life: 5 });
    step(P);
    const S = P as unknown as Shaded;
    expect(height(S, 0)).toBeCloseTo(60, 0);
    for (const i of [0, 1]) {
      expect(S.ao[i]).toBeGreaterThan(0.9);
      expect(S.ao[i]).toBeLessThanOrEqual(1);
      expect(S.vis[i]).toBeGreaterThan(0.9);
    }
    expect(S.ao[0]).toBeCloseTo(S.ao[1], 3);
  });

  it('smoke settles on the curved ground far from the anchor and spreads along it', () => {
    const P = new ParticleSystem(new Scene(), new Texture(), () => new Texture(), 64);
    P.bodyRadius = R;
    const d = 900_000;
    const ground = Math.sqrt(R * R - d * d) - R;
    // falling straight down (toward the centre) onto the ground there
    const down = new Vector3(0, ground + R, d).normalize().multiplyScalar(-20);
    P.emit({ kind: 'dust', pos: new Vector3(0, ground + 5, d), vel: down, size: 2, life: 30, drag: 0 });
    step(P, 60);
    const S = P as unknown as Shaded;
    const h = height(S, 0);
    expect(h).toBeGreaterThan(0.5);
    expect(h).toBeLessThan(3);
  });

  it('cold gas in vacuum is a smooth haze, seen only near the nozzle', () => {
    const P = new ParticleSystem(new Scene(), new Texture(), () => new Texture(), 64);
    const breakup = P.material.uniforms.uBreakup.value as number[];
    // the gas kind follows the original twelve in the per-kind uniform arrays
    expect(breakup.length).toBeGreaterThanOrEqual(13);
    expect(breakup[12]).toBe(0);
    // (the middle of every random spread)
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      P.emit({ kind: 'gas', pos: new Vector3(0, 100, 0), vel: new Vector3(140, 0, 0), size: 0.25, grow: 38, life: 0.25, opacity: 0.9, drag: 0 });
      const alpha = () => (P as unknown as { alphaTmp: Float32Array }).alphaTmp[0];
      step(P, 1);
      // a few metres out it is a visible puff...
      const near = alpha();
      expect(near).toBeGreaterThan(0.08);
      // ...twenty-odd metres out, as wide as a house, all but gone
      step(P, 5);
      expect((P as unknown as Shaded).px[0]).toBeGreaterThan(20);
      expect(alpha()).toBeLessThan(near * 0.25);
    } finally {
      rnd.mockRestore();
    }
  });
});

describe('camera director', () => {
  it('names the booster its landing shots show, so lighting and particles can follow it', () => {
    const { world } = makeWorld();
    const earth = world.system.earth;
    // the active upper stage far downrange and high; the booster coming down near the site
    const ship = world.createVessel(getVehicle('kestrel9'), earth);
    world.addVessel(ship);
    world.placeOnSurface(ship, earth, CAPE.lat + 0.05, CAPE.lon + 0.25, 210_000, 0);
    const booster = world.createVessel(getVehicle('kestrel9'), earth);
    world.addVessel(booster);
    world.placeOnSurface(booster, earth, CAPE.lat, CAPE.lon, 400, 0);
    const bodyPos = (b: CelestialBody) => b.globalPositionAt(world.t, new Vector3());
    const pad = new Vector3().copy(booster.pos).add(bodyPos(earth));
    const ctx: CamContext = {
      t: world.t, dt: 1 / 30, active: ship, vessels: [ship, booster], boosters: [booster], bodyPos,
      site: null, towerTop: null, cloudTop: null, deckHeight: 0, siteQuery: null, groundHeight: () => 0,
      zones: [{ pos: pad, kind: 'pad' }], phase: 'orbit', plumeMN: 0, plumeSourceHelio: null, aspect: 16 / 9,
    };
    const d = new CameraDirector(new PerspectiveCamera());
    d.forceShot('booster_chase');
    d.update(ctx);
    expect(d.viewed).toEqual([booster]);
    d.forceShot('orbit_beauty');
    d.update(ctx);
    expect(d.viewed).toEqual([]);
    d.forceShot('lz_ground');
    d.update(ctx);
    expect(d.viewed).toEqual([booster]);
    // the player's own cameras always show the active vessel
    d.setMode('chase');
    d.update(ctx);
    expect(d.viewed).toEqual([]);
  });
});

describe('puff atlas', () => {
  it('has no step at a billow\'s rim (a lit cloud must not read as a heap of bubbles)', () => {
    const tex = createPuffAtlas();
    const { data, width: S } = tex.image as { data: Uint8Array; width: number };
    const C = S / 4;
    const A = (x: number, y: number) => data[(y * S + x) * 4 + 3];
    // a step: one jump in coverage far larger than the jumps either side of it (a steep but
    // smooth flank rises over several texels, each jump much like its neighbours)
    let steps = 0, filled = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if (A(x, y) > 128) filled++;
      const cx = x % C, cy = y % C;
      if (cx >= 1 && cx <= C - 3) {
        const d0 = Math.abs(A(x, y) - A(x - 1, y)), d1 = Math.abs(A(x + 1, y) - A(x, y)), d2 = Math.abs(A(x + 2, y) - A(x + 1, y));
        if (d1 > 60 && d1 > 2.5 * (Math.max(d0, d2) + 8)) steps++;
      }
      if (cy >= 1 && cy <= C - 3) {
        const d0 = Math.abs(A(x, y) - A(x, y - 1)), d1 = Math.abs(A(x, y + 1) - A(x, y)), d2 = Math.abs(A(x, y + 2) - A(x, y + 1));
        if (d1 > 60 && d1 > 2.5 * (Math.max(d0, d2) + 8)) steps++;
      }
    }
    // (the old atlas, a lifted hemisphere per billow, had thousands)
    expect(steps).toBe(0);
    // and the puffs still fill a good part of their sprites
    expect(filled / (S * S)).toBeGreaterThan(0.25);
  });
});
