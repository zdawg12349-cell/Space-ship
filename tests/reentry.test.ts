import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { calm, flatTerrain, makeWorld, oceanTerrain } from './helpers';
import { getVehicle } from '../src/vehicles/catalog';
import { AttitudeController } from '../src/game/attitude';
import { Autopilot } from '../src/game/Autopilot';
import { planDeorbit, planTEI } from '../src/game/Planner';
import { nominalLiftShare, predictEntry } from '../src/game/entryGuidance';
import { SolarSystem } from '../src/physics/bodies';
import { dateToJ2000Seconds } from '../src/physics/constants';
import { PhysicsWorld } from '../src/physics/world';
import type { Vessel } from '../src/physics/vessel';

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

describe('lunar return', () => {
  function fly(w: PhysicsWorld, ap: Autopilot, seconds: number, until?: () => boolean) {
    const dt = 1 / 30;
    for (let i = 0; i < seconds / dt; i++) {
      ap.update(dt);
      const c = ap.vessel.controls;
      if (ap.throttleCmd !== null) c.throttle = ap.throttleCmd;
      if (ap.translateCmd) { c.rcs = true; c.tx = ap.translateCmd.x; c.ty = ap.translateCmd.y; c.tz = ap.translateCmd.z; } else { c.tx = 0; c.ty = 0; c.tz = 0; }
      if (ap.wantStage) { ap.wantStage = false; w.stage(ap.vessel); }
      w.update(dt);
      w.drainEvents();
      if (until?.()) break;
    }
  }

  /** The session's entry sequence: shed everything but the capsule, guided entry, chutes. */
  function entry(w: PhysicsWorld, ap: Autopilot, v: Vessel) {
    const cap = v.assemblies.find((a) => a.def.features?.heatShield)!;
    if (v.assemblies.length > 1) w.separate(v, v.assemblies.filter((a) => a !== cap).map((a) => a.id));
    ap.setMode('entry');
    let maxG = 0;
    const dt = 1 / 30;
    w.update(dt); // fresh telemetry before the first decision
    for (let i = 0; i < 4000 * 30 && !v.landed && !v.destroyed; i++) {
      const tm = v.telemetry;
      if (tm.altitude < 9000 && tm.speedSurface < 240 && cap.chuteState === 'stowed') { v.deployChutes(); ap.setMode('off'); }
      if (tm.altitude < 3200 && tm.speedSurface < 100 && cap.chuteState === 'drogue') v.deployChutes();
      if (ap.mode !== 'off') ap.update(dt);
      w.update(dt);
      w.drainEvents();
      if (tm.radarAltitude > 5) maxG = Math.max(maxG, tm.gForce);
    }
    return { maxG, fix: v.fixedDirection(w.t, new Vector3()) };
  }

  const dirOf = (lat: number, lon: number) => {
    const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
    return new Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
  };

  it('HORIZON lifts off the Moon, burns for home and splashes down at its recovery zone', () => {
    const t0 = dateToJ2000Seconds(new Date('2026-10-18T06:00:00Z'));
    const sys = new SolarSystem(t0);
    const w = new PhysicsWorld(sys, t0, oceanTerrain, calm);
    const v = w.createVessel(getVehicle('lrv'), sys.moon);
    w.addVessel(v);
    w.active = v;
    w.placeOnSurface(v, sys.moon, (0.674 * Math.PI) / 180, (23.473 * Math.PI) / 180, 0.05, 0);
    for (const a of v.assemblies) if (a.def.features?.landingLegs) { a.legsDeployed = 1; a.legsTarget = 1; }
    v.settleLanded(w.t, false);
    v.controls.rcs = true;
    const ap = new Autopilot(w, v);
    ap.setMode('ascend');
    fly(w, ap, 1500, () => ap.mode === 'stability' || v.destroyed);
    v.hasLiftedOff = true;
    const o = v.updateOrbit(w.t);
    expect(o.periapsis - sys.moon.radius).toBeGreaterThan(12_000);
    fly(w, ap, 20);
    const n = planTEI(v, sys, w.t, 45_000, () => true)!;
    expect(n.landing).toBeDefined();
    w.updateRails(Math.max(0, n.t - w.t - 300));
    ap.setNode(n);
    ap.setMode('node');
    fly(w, ap, 3000, () => ap.mode !== 'node' || v.destroyed);
    // the return stage keeps a margin for corrections after the burn
    const left = v.stagePropellant().current;
    for (let i = 0; i < 6 * 24 * 6 && !v.destroyed; i++) {
      w.updateRails(600);
      if (v.body === sys.earth && v.pos.length() - sys.earth.radius < sys.earth.atmosphereTop + 1) break;
    }
    expect(v.body).toBe(sys.earth);
    ap.entryTarget = dirOf(n.landing!.lat, n.landing!.lon);
    const { maxG, fix } = entry(w, ap, v);
    const miss = Math.acos(Math.min(1, fix.dot(ap.entryTarget))) * sys.earth.radius;
    console.log(`TEI ${n.dv.length().toFixed(0)} m/s, ${left.toFixed(0)} kg left · ${n.result} · splashdown ${(miss / 1000).toFixed(1)} km from the zone, peak ${maxG.toFixed(1)} g, ${ap.entryGuidance?.reversals} reversals`);
    expect(v.destroyed, v.destroyReason).toBe(false);
    expect(v.splashed).toBe(true);
    expect(left).toBeGreaterThan(500);
    expect(miss).toBeLessThan(15_000);
    expect(maxG).toBeLessThan(7.5);
  }, 120_000);

  it('a capsule with no recovery zone steers its 11 km/s entry clear of land', () => {
    const t0 = dateToJ2000Seconds(new Date('2026-10-21T00:00:00Z'));
    const sys = new SolarSystem(t0);
    const earth = sys.earth;
    // the return capsule alone on a lunar-return conic at entry interface (45 km vacuum perigee)
    const full = getVehicle('lrv');
    const def = { ...full, assemblies: full.assemblies.filter((a) => a.id === 'cm').map((a) => ({ ...a, parent: null })), staging: full.staging.slice(2) };
    const rp = earth.radius + 45_000, ra = 4.0e8;
    const a = (rp + ra) / 2, e = (ra - rp) / (ra + rp);
    const rEI = earth.radius + earth.atmosphereTop - 500;
    const speed = Math.sqrt(earth.gm * (2 / rEI - 1 / a));
    const gam = -Math.acos(Math.sqrt(earth.gm * a * (1 - e * e)) / (rEI * speed));
    const q = new Quaternion();
    earth.orientationAt(t0, q);
    const up = new Vector3(1, 0, 0).applyQuaternion(q), east = new Vector3(0, 1, 0).applyQuaternion(q);
    const r0 = up.clone().multiplyScalar(rEI);
    const v0 = up.clone().multiplyScalar(speed * Math.sin(gam)).addScaledVector(east, speed * Math.cos(gam));
    // a continent where the capsule would come down at its nominal bank
    const nominal = predictEntry(earth, r0, v0, t0, 4500, Math.PI * 1.9 * 1.9, nominalLiftShare(speed), 2_000).dir;
    const land = (d: Vector3) => d.dot(nominal) > Math.cos(300_000 / earth.radius);
    const terrain = { heightAt: () => 0, isWater: (b: { id: string }, d: Vector3) => b.id === 'earth' && !land(d) };
    const w = new PhysicsWorld(sys, t0, terrain as never, calm);
    const v = w.createVessel(def as typeof full, earth);
    w.addVessel(v);
    w.active = v;
    w.placeInOrbit(v, earth, r0, v0, v0.clone().negate());
    v.hasLiftedOff = true;
    v.controls.rcs = true;
    const ap = new Autopilot(w, v);
    const { maxG, fix } = entry(w, ap, v);
    const g = ap.entryGuidance!;
    const offNominal = Math.acos(Math.min(1, fix.dot(nominal))) * earth.radius;
    const miss = g.target ? Math.acos(Math.min(1, fix.dot(g.target))) * earth.radius : NaN;
    console.log(`designated ${JSON.stringify(g.designated)} · splashdown ${(offNominal / 1000).toFixed(0)} km from the nominal point, ${(miss / 1000).toFixed(1)} km from the chosen one, peak ${maxG.toFixed(1)} g`);
    expect(v.destroyed, v.destroyReason).toBe(false);
    expect(g.designated).not.toBeNull();
    expect(v.splashed).toBe(true);
    expect(offNominal).toBeGreaterThan(300_000);
    expect(miss).toBeLessThan(15_000);
    expect(maxG).toBeLessThan(8);
  }, 120_000);
});
