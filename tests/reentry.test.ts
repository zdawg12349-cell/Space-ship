import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { makeWorld, oceanTerrain } from './helpers';
import { getVehicle } from '../src/vehicles/catalog';
import { AttitudeController } from '../src/game/attitude';

describe('reentry', () => {
  it('AQUILA deorbits, survives peak heating, deploys chutes and splashes down', () => {
    const { world } = makeWorld(oceanTerrain);
    const def = getVehicle('aquila');
    const v = world.createVessel(def, world.system.earth);
    world.addVessel(v);
    const r = 6371e3 + 200e3;
    world.placeInOrbit(v, world.system.earth, new Vector3(r, 0, 0), new Vector3(0, Math.sqrt(world.system.earth.gm / r), 0));
    v.controls.rcs = true;
    for (const e of v.engines) e.armed = true;
    const att = new AttitudeController();
    let phase = 'orient';
    let maxG = 0, maxFlux = 0, maxShield = 0, maxQ = 0;
    const log: string[] = [];
    const dt = 1 / 30;
    let tPhase = 0;
    for (let i = 0; i < 3600 * 30 && !v.landed && !v.destroyed; i++) {
      const tm = v.telemetry;
      const retro = v.surfaceVelocity(new Vector3()).normalize().negate();
      const orbRetro = v.vel.clone().normalize().negate();
      tPhase += dt;
      if (phase === 'orient') { att.update(v, { dir: orbRetro }, dt); if (att.error < 0.02 && tPhase > 20) { phase = 'burn'; tPhase = 0; } }
      else if (phase === 'burn') {
        att.update(v, { dir: orbRetro }, dt);
        v.controls.throttle = 1;
        const o = v.updateOrbit(world.t);
        if (o.periapsis - 6371e3 < 45e3) { v.controls.throttle = 0; phase = 'coast'; tPhase = 0; log.push(`deorbit done pe ${((o.periapsis - 6371e3) / 1000).toFixed(1)} km`); }
      } else if (phase === 'coast') {
        att.update(v, { dir: orbRetro }, dt);
        if (tm.altitude < 140e3 && v.assemblies.some((a) => a.id === 'esm')) { world.separate(v, ['esm']); log.push('ESM jettison'); }
        if (tm.altitude < 125e3) phase = 'entry';
      } else if (phase === 'entry') {
        att.update(v, { dir: retro }, dt);
        if (tm.altitude < 7500 && tm.speedSurface < 230 && v.assemblies[0].chuteState === 'stowed') { v.deployChutes(); log.push(`drogues at ${tm.altitude.toFixed(0)} m, ${tm.speedSurface.toFixed(0)} m/s`); }
        if (tm.altitude < 3000 && tm.speedSurface < 95 && v.assemblies[0].chuteState === 'drogue') { v.deployChutes(); log.push(`mains at ${tm.altitude.toFixed(0)} m, ${tm.speedSurface.toFixed(0)} m/s`); }
      }
      world.update(dt);
      if (phase === 'entry') {
        maxG = Math.max(maxG, tm.gForce); maxFlux = Math.max(maxFlux, tm.heatFlux); maxQ = Math.max(maxQ, tm.dynamicPressure);
        maxShield = Math.max(maxShield, v.assemblies[0].shieldTemp);
      }
      if (i % 900 === 0 && phase === 'entry') log.push(`alt ${(tm.altitude / 1000).toFixed(1)} v ${tm.speedSurface.toFixed(0)} g ${tm.gForce.toFixed(1)} flux ${(tm.heatFlux / 1e4).toFixed(0)}W/cm2 shield ${v.assemblies[0].shieldTemp.toFixed(0)}K plasma ${v.plasmaIntensity.toFixed(2)} aoa ${tm.aoa.toFixed(0)}`);
    }
    const cm = v.assemblies[0];
    log.push(`end: landed ${v.landed} splashed ${v.splashed} destroyed ${v.destroyReason} maxG ${maxG.toFixed(1)} maxFlux ${(maxFlux / 1e4).toFixed(0)}W/cm2 shield ${maxShield.toFixed(0)}K ablator ${cm.ablator.toFixed(0)}kg impact ${v.lastImpactSpeed.toFixed(1)}m/s maxQ ${(maxQ / 1000).toFixed(1)}kPa`);
    console.log(log.join('\n'));
    expect(v.destroyed, v.destroyReason).toBe(false);
    expect(v.splashed).toBe(true);
    expect(maxShield).toBeGreaterThan(1000);
    expect(maxG).toBeLessThan(12);
  });
});
