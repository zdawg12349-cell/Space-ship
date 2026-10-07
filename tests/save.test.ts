import { describe, expect, it } from 'vitest';
import { flyAscent, makeWorld } from './helpers';
import { getVehicle } from '../src/vehicles/catalog';
import { Vessel } from '../src/physics/vessel';
import { restoreVessel, snapshotVessel, type FlightSnapshot } from '../src/game/SaveGame';

describe('saves', () => {
  it('a vessel restored from a quicksave flies on exactly as the original', () => {
    const { world, v } = flyAscent('kestrel9', 220_000);
    // let the upper stage's thrust tail off completely before saving
    for (let i = 0; i < 20 * 30; i++) world.update(1 / 30);
    expect(v.telemetry.thrust).toBe(0);
    const o = v.updateOrbit(world.t);
    expect(o.periapsis - world.system.earth.radius).toBeGreaterThan(150_000);
    // save (through JSON, as localStorage would)
    const snap: FlightSnapshot = JSON.parse(JSON.stringify({
      version: 1, savedAt: new Date().toISOString(), vehicleId: 'kestrel9', siteId: 'cape', weather: 'fair', t: world.t, liftoffT: 0,
      ...snapshotVessel(v), phase: 'orbit', milestones: ['orbit'], throttle: 0, autopilot: 'stability',
    }));
    // load into a fresh world at the saved time
    const { world: w2 } = makeWorld();
    w2.t = snap.t;
    const def = getVehicle(snap.vehicleId);
    const ids = new Set(snap.assemblies.map((a) => a.id));
    const r = new Vessel(def.name, def, def.assemblies.filter((a) => ids.has(a.id)), w2.system.get(snap.body));
    w2.addVessel(r);
    restoreVessel(r, snap);
    expect(r.assemblies.map((a) => a.id)).toEqual(v.assemblies.map((a) => a.id));
    expect(Math.abs(r.mass - v.mass)).toBeLessThan(1);
    expect(r.stageIndex).toBe(v.stageIndex);
    expect(r.pos.distanceTo(v.pos)).toBeLessThan(1e-6);
    // both coast for ten minutes
    for (let i = 0; i < 600 * 30; i++) { world.update(1 / 30); w2.update(1 / 30); }
    const drift = r.pos.distanceTo(v.pos);
    console.log('restored vs original after 10 min:', drift.toFixed(3), 'm');
    expect(drift).toBeLessThan(5);
  });
});
