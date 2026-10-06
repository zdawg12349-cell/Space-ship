import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { makeWorld } from './helpers';
import { getVehicle } from '../src/vehicles/catalog';
import { AttitudeController } from '../src/game/attitude';

function setup(id: string, assemblies?: string[]) {
  const { world } = makeWorld();
  const def = getVehicle(id);
  if (assemblies) def.assemblies = def.assemblies.filter((a) => assemblies.includes(a.id));
  const v = world.createVessel(def, world.system.earth);
  world.addVessel(v);
  const r = 6371e3 + 300e3;
  world.placeInOrbit(v, world.system.earth, new Vector3(r, 0, 0), new Vector3(0, Math.sqrt(world.system.earth.gm / r), 0), new Vector3(0, 0, 1));
  return { world, v };
}

function turn(id: string, assemblies: string[] | undefined, burn: boolean, label: string) {
  const { world, v } = setup(id, assemblies);
  const att = new AttitudeController();
  v.controls.rcs = true;
  if (burn) { for (const e of v.engines) e.armed = true; v.controls.throttle = 1; }
  const target = new Vector3(1, 0, 0);
  let maxErrAfter = 0;
  const trace: string[] = [];
  for (let i = 0; i < 60 * 60; i++) {
    att.update(v, { dir: target }, 1 / 60);
    world.update(1 / 60);
    const tsec = i / 60;
    if (i % 60 === 0) trace.push(`${tsec.toFixed(0)}s err ${(att.error * 57.3).toFixed(1)} w ${v.angVel.length().toFixed(3)}`);
    if (tsec > 40) maxErrAfter = Math.max(maxErrAfter, att.error);
  }
  console.log(label, trace.filter((_, k) => k % 4 === 0).join(' | '));
  return maxErrAfter * 57.3;
}

describe('attitude controller', () => {
  it('turns a coasting upper stage 90° and holds', () => {
    expect(turn('kestrel9', ['stage2'], false, 'S2 coast')).toBeLessThan(4);
  });
  it('turns a burning booster (gimbal authority) and holds', () => {
    expect(turn('kestrel9', ['core'], true, 'booster burn')).toBeLessThan(2);
  });
  it('turns a capsule', () => {
    expect(turn('aquila', undefined, false, 'capsule')).toBeLessThan(2);
  });
});
