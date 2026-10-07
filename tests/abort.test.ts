import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { makeWorld, oceanTerrain, flatTerrain, CAPE } from './helpers';
import { getVehicle } from '../src/vehicles/catalog';
import { Vessel } from '../src/physics/vessel';

describe('launch escape and soft landing', () => {
  it('pad abort: the escape tower pulls the command module clear and it lands under parachutes', () => {
    const { world } = makeWorld(oceanTerrain);
    const def = getVehicle('colossus');
    const v = world.createVessel(def, world.system.earth);
    world.addVessel(v);
    world.active = v;
    world.placeOnSurface(v, world.system.earth, CAPE.lat, CAPE.lon, 20, 0);
    v.padSupportAlt = 20;
    v.clampToSurface(world.t);
    // abort: the crew module and its tower leave the stack
    world.separate(v, ['cm']);
    v.clamped = false; v.landed = false; v.padSupportAlt = NaN; v.hasLiftedOff = true;
    expect(v.assemblies.map((a) => a.def.id).sort()).toEqual(['cm', 'les']);
    v.auxBurns.push({ force: v.mass * 9.81 * 8, time: 3, kind: 'escape' });
    let apex = 0, maxG = 0, jettisoned = false;
    const dt = 1 / 60;
    const t0 = world.t;
    for (let i = 0; i < 400 / dt && !v.landed && !v.destroyed; i++) {
      world.update(dt);
      const tm = v.telemetry;
      apex = Math.max(apex, tm.altitude);
      maxG = Math.max(maxG, tm.gForce);
      if (!jettisoned && world.t - t0 > 4 && tm.verticalSpeed < 15) { world.separate(v, ['les']); jettisoned = true; }
      const cm = v.assemblies[0];
      if (jettisoned && cm.chuteState === 'stowed' && tm.verticalSpeed < 0 && tm.speedSurface < 240) v.deployChutes();
      if (cm.chuteState === 'drogue' && tm.altitude < 3200 && tm.speedSurface < 100) v.deployChutes();
    }
    console.log('pad abort apex', apex.toFixed(0), 'm, max g', maxG.toFixed(1), 'landed', v.landed, 'splashed', v.splashed, 'impact', v.lastImpactSpeed.toFixed(1), v.destroyReason);
    expect(apex).toBeGreaterThan(800);
    expect(v.destroyed, v.destroyReason).toBe(false);
    expect(v.splashed).toBe(true);
    expect(v.lastImpactSpeed).toBeLessThan(12);
  });

  it('soft-landing retro-rockets fire just before a descent module touches down on land', () => {
    const { world } = makeWorld(flatTerrain);
    const def = getVehicle('vostok');
    const v = new Vessel('dm', def, def.assemblies.filter((a) => a.id === 'dm'), world.system.earth);
    world.addVessel(v);
    world.active = v;
    // falling under the main canopy from 1.5 km
    world.placeOnSurface(v, world.system.earth, CAPE.lat, CAPE.lon, 1500, 0);
    v.landed = false; v.hasLiftedOff = true;
    v.vel.addScaledVector(v.pos.clone().normalize(), -8);
    v.deployChutes(true);
    let fired = false;
    for (let i = 0; i < 600 * 60 && !v.landed && !v.destroyed; i++) {
      world.update(1 / 60);
      for (const e of world.drainEvents()) if (e.event.type === 'retro_fire') fired = true;
    }
    console.log('retro fired', fired, 'touchdown', v.lastImpactSpeed.toFixed(2), 'm/s', v.destroyReason);
    expect(fired).toBe(true);
    expect(v.destroyed, v.destroyReason).toBe(false);
    expect(v.lastImpactSpeed).toBeLessThan(3.5);
  });
});
