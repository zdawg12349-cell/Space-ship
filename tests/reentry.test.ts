import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { flatTerrain, makeWorld, oceanTerrain } from './helpers';
import { getVehicle } from '../src/vehicles/catalog';
import { AttitudeController } from '../src/game/attitude';
import { Autopilot } from '../src/game/Autopilot';
import { planDeorbit } from '../src/game/Planner';

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

describe('targeted deorbit', () => {
  it('VOSTOK-R descent module lands on the Kazakh steppe', () => {
    const { world } = makeWorld(flatTerrain);
    const full = getVehicle('vostok');
    const keep = new Set(['sm', 'dm', 'om']);
    const def = {
      ...full,
      assemblies: full.assemblies.filter((a) => keep.has(a.id)).map((a) => (a.id === 'sm' ? { ...a, parent: null } : a)),
      staging: full.staging.slice(6),
    };
    const v = world.createVessel(def as typeof full, world.system.earth);
    world.addVessel(v);
    world.active = v;
    // 210 km circular orbit inclined 51.6° to the equator
    const earth = world.system.earth;
    const q = new Quaternion();
    earth.orientationAt(world.t, q);
    const pole = new Vector3(0, 0, 1).applyQuaternion(q);
    const node = new Vector3(1, 0, 0).applyQuaternion(q);
    const r = earth.radius + 210e3;
    const vDir = new Vector3().crossVectors(pole, node).applyAxisAngle(node, (51.6 * Math.PI) / 180);
    world.placeInOrbit(v, earth, node.clone().multiplyScalar(r), vDir.multiplyScalar(Math.sqrt(earth.gm / r)));
    for (const e of v.engines) e.armed = true;
    v.controls.rcs = true;
    const target = { lat: 47.35, lon: 69.6, name: 'the Kazakh steppe' };
    const n = planDeorbit(v, world.t, 40_000, target);
    console.log('deorbit', ((n.t - world.t) / 3600).toFixed(2), 'h from now,', n.dv.length().toFixed(1), 'm/s,', n.result);
    world.updateRails(Math.max(0, n.t - world.t - 300));
    const ap = new Autopilot(world, v);
    ap.setNode(n);
    ap.setMode('node');
    const dt = 1 / 30;
    let burnDone = false;
    let entryMode = false;
    let maxG = 0;
    const la0 = (target.lat * Math.PI) / 180, lo0 = (target.lon * Math.PI) / 180;
    ap.entryTarget = new Vector3(Math.cos(la0) * Math.cos(lo0), Math.cos(la0) * Math.sin(lo0), Math.sin(la0));
    for (let i = 0; i < 4000 * 30 && !v.landed && !v.destroyed; i++) {
      const tm = v.telemetry;
      if (!burnDone) {
        ap.update(dt);
        v.controls.throttle = ap.throttleCmd ?? 0;
        if (ap.translateCmd) { v.controls.tx = ap.translateCmd.x; v.controls.ty = ap.translateCmd.y; v.controls.tz = ap.translateCmd.z; } else { v.controls.tx = 0; v.controls.ty = 0; v.controls.tz = 0; }
        if (ap.mode !== 'node') { burnDone = true; v.controls.throttle = 0; ap.setMode('stability'); }
      } else {
        if (tm.altitude < 140e3 && v.assemblies.some((a) => a.def.id === 'sm')) { world.separate(v, ['om', 'sm']); ap.setMode('entry'); entryMode = true; }
        const dm = v.assemblies.find((a) => a.def.id === 'dm')!;
        if (tm.altitude < 9000 && tm.speedSurface < 240 && dm.chuteState === 'stowed') { v.deployChutes(); ap.setMode('off'); entryMode = false; }
        if (tm.altitude < 3200 && tm.speedSurface < 100 && dm.chuteState === 'drogue') v.deployChutes();
        if (ap.mode !== 'off') ap.update(dt);
        if (entryMode) maxG = Math.max(maxG, tm.gForce);
        if (entryMode && i % 900 === 0) console.log(`alt ${(tm.altitude / 1000).toFixed(1)} v ${tm.speedSurface.toFixed(0)} g ${tm.gForce.toFixed(1)} · ${ap.status} · cross ${((ap.entryGuidance?.last?.cross ?? 0) / 1000).toFixed(1)} km`);
      }
      world.update(dt);
      world.drainEvents();
    }
    const fix = v.fixedDirection(world.t, new Vector3());
    const la = (target.lat * Math.PI) / 180, lo = (target.lon * Math.PI) / 180;
    const miss = Math.acos(Math.min(1, fix.dot(new Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la))))) * earth.radius;
    console.log('touchdown', v.landed, 'destroyed', v.destroyReason, 'at', (Math.asin(fix.z) * 180 / Math.PI).toFixed(2), (Math.atan2(fix.y, fix.x) * 180 / Math.PI).toFixed(2), 'miss', (miss / 1000).toFixed(1), 'km, impact', v.lastImpactSpeed.toFixed(1), 'm/s, peak', maxG.toFixed(1), 'g, reversals', ap.entryGuidance?.reversals ?? '-');
    expect(v.destroyed, v.destroyReason).toBe(false);
    expect(v.landed).toBe(true);
    expect(miss).toBeLessThan(25_000);
    expect(maxG).toBeLessThan(6);
  }, 300_000);
});
