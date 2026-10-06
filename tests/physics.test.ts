import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EarthAtmosphere, newAtmosphereSample } from '../src/physics/atmosphere';
import { keplerPropagate, Orbit } from '../src/physics/orbit';
import { AU } from '../src/physics/constants';
import { flyAscent, makeWorld, vesselOrbit } from './helpers';
import { LAUNCHERS, vehicleStats } from '../src/vehicles/catalog';

describe('atmosphere (USSA-1976)', () => {
  const s = newAtmosphereSample();
  it('matches standard values', () => {
    EarthAtmosphere.sample(0, s);
    expect(s.density).toBeCloseTo(1.225, 3);
    expect(s.speedOfSound).toBeCloseTo(340.3, 0);
    EarthAtmosphere.sample(11000, s);
    expect(s.density).toBeCloseTo(0.3639, 2);
    EarthAtmosphere.sample(20000, s);
    expect(s.density).toBeCloseTo(0.0889, 2);
    EarthAtmosphere.sample(50000, s);
    expect(s.density).toBeGreaterThan(9e-4);
    expect(s.density).toBeLessThan(1.1e-3);
    EarthAtmosphere.sample(100000, s);
    expect(s.density).toBeCloseTo(5.604e-7, 8);
  });
});

describe('orbit mechanics', () => {
  const mu = 3.986004418e14;
  it('propagates a circular orbit for a full period', () => {
    const r = 6771e3;
    const v = Math.sqrt(mu / r);
    const r0 = new Vector3(r, 0, 0), v0 = new Vector3(0, v, 0);
    const T = 2 * Math.PI * Math.sqrt(r ** 3 / mu);
    const R = new Vector3(), V = new Vector3();
    keplerPropagate(r0, v0, mu, T, R, V);
    expect(R.distanceTo(r0)).toBeLessThan(1e-2);
    keplerPropagate(r0, v0, mu, T / 4, R, V);
    expect(R.y).toBeCloseTo(r, -1);
  });
  it('handles hyperbolic trajectories', () => {
    const r0 = new Vector3(7000e3, 0, 0), v0 = new Vector3(0, 12000, 0);
    const R = new Vector3(), V = new Vector3();
    keplerPropagate(r0, v0, mu, 3600, R, V);
    const e0 = v0.lengthSq() / 2 - mu / r0.length();
    const e1 = V.lengthSq() / 2 - mu / R.length();
    expect(Math.abs(e1 - e0) / Math.abs(e0)).toBeLessThan(1e-9);
    const o = new Orbit().setFromState(r0, v0, mu, 0);
    expect(o.e).toBeGreaterThan(1);
  });
  it('computes apsides', () => {
    const o = new Orbit().setFromState(new Vector3(6771e3, 0, 0), new Vector3(0, 8000, 0), mu, 0);
    expect(o.periapsis).toBeCloseTo(6771e3, -1);
    expect(o.apoapsis).toBeGreaterThan(6771e3);
    expect(o.timeToApoapsis()).toBeCloseTo(o.period / 2, 0);
  });
});

describe('ephemeris', () => {
  const { sys, world } = makeWorld();
  it('places the planets at sensible heliocentric distances', () => {
    const p = new Vector3();
    sys.earth.globalPositionAt(world.t, p);
    expect(p.length() / AU).toBeGreaterThan(0.98);
    expect(p.length() / AU).toBeLessThan(1.02);
    sys.get('jupiter').globalPositionAt(world.t, p);
    expect(p.length() / AU).toBeGreaterThan(4.9);
    expect(p.length() / AU).toBeLessThan(5.5);
  });
  it('keeps the Moon at lunar distance and gives sane SOIs', () => {
    const r = new Vector3(), v = new Vector3();
    sys.moon.localStateAt(world.t, r, v);
    expect(r.length()).toBeGreaterThan(355e6);
    expect(r.length()).toBeLessThan(407e6);
    expect(sys.moon.soi / 1000).toBeGreaterThan(60000);
    expect(sys.moon.soi / 1000).toBeLessThan(70000);
    expect(sys.earth.soi / 1e6).toBeGreaterThan(900);
  });
});

describe('vehicle catalogue', () => {
  it('has at least 15 distinct launchers with liftoff TWR > 1', () => {
    expect(LAUNCHERS.length).toBeGreaterThanOrEqual(15);
    for (const v of LAUNCHERS) {
      const st = vehicleStats(v);
      const twr = st.thrustSL / (st.mass * 9.81);
      expect(twr, v.id).toBeGreaterThan(1.05);
      expect(twr, v.id).toBeLessThan(3.2);
    }
  });
});

describe('flight', () => {
  it('a vessel in LEO keeps its orbit under physics integration', () => {
    const { world } = makeWorld();
    const v = world.createVessel(LAUNCHERS.find((x) => x.id === 'sparrow')!, world.system.earth);
    world.addVessel(v);
    const r = 6371e3 + 400e3;
    world.placeInOrbit(v, world.system.earth, new Vector3(r, 0, 0), new Vector3(0, Math.sqrt(world.system.earth.gm / r), 0));
    for (let i = 0; i < 5600 * 2; i++) world.update(0.5); // physics warp 1x with 1/30 substeps = ~93 min
    const o = vesselOrbit(v, world.t);
    expect(Math.abs(o.ap - 400e3)).toBeLessThan(3000);
    expect(Math.abs(o.pe - 400e3)).toBeLessThan(3000);
  });

  it('KESTREL 9 reaches orbit on orbit assist', () => {
    const { v, world, g } = flyAscent('kestrel9', 220_000, 1200, { log: true });
    expect(v.destroyed, v.destroyReason).toBe(false);
    const o = vesselOrbit(v, world.t);
    expect(g.phase).toBe('done');
    expect(o.pe).toBeGreaterThan(150e3);
  });
});
