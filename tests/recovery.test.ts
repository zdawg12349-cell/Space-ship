import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { makeWorld, CAPE } from './helpers';
import { getVehicle } from '../src/vehicles/catalog';
import { AscentGuidance, FlightSoftware, launchAzimuth } from '../src/game/guidance';
import { BoosterGuidance, LandingZone } from '../src/game/recovery';
import type { TerrainProvider, Vessel } from '../src/physics/vessel';
import { GameTerrain, GameWeather, WEATHER_PRESETS } from '../src/game/providers';
import type { WeatherProvider } from '../src/physics/vessel';
import { landingZonesFor } from '../src/world/zones';
import { LAUNCH_SITES } from '../src/world/sites';
import { PhysicsWorld } from '../src/physics/world';
import { SolarSystem } from '../src/physics/bodies';
import { dateToJ2000Seconds } from '../src/physics/constants';
import { calm, flatTerrain as flatTerrainForTest } from './helpers';

function zoneAt(lat: number, lon: number, id: string): LandingZone {
  return { id, name: id, dir: new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)), height: 0, radius: 40, kind: 'pad' };
}

export function flyWithRecovery(vehicleId: string, maxTime = 1100) {
  const { world } = makeWorld();
  const def = getVehicle(vehicleId);
  const v = world.createVessel(def, world.system.earth);
  world.addVessel(v);
  world.placeOnSurface(v, world.system.earth, CAPE.lat, CAPE.lon, 5, 0);
  v.padSupportAlt = 5;
  const zones = [zoneAt(CAPE.lat - 0.07 * Math.PI / 180, CAPE.lon + 0.03 * Math.PI / 180, 'LZ-1'), zoneAt(CAPE.lat - 0.0735 * Math.PI / 180, CAPE.lon + 0.03 * Math.PI / 180, 'LZ-2')];
  const boosters: { v: Vessel; g: BoosterGuidance }[] = [];
  const said: string[] = [];
  world.guidanceFactory = (bv) => {
    const zone = zones.find((z) => !z.occupied)!;
    zone.occupied = true;
    const g = new BoosterGuidance(bv, world, zone);
    g.onEvent = (id) => said.push(`${bv.name}:${id}@${world.t.toFixed(0)}`);
    boosters.push({ v: bv, g });
    return { update: (vv, dt, env) => g.update(vv, dt, env) };
  };
  const az = launchAzimuth(CAPE.lat, 28.6 * Math.PI / 180);
  const g = new AscentGuidance(world, v, def.targetOrbit ?? 220000, az);
  const fsw = new FlightSoftware(v);
  world.stage(v);
  const dt = 1 / 60;
  let liftoff = false;
  const t0 = world.t;
  for (let i = 0; i < maxTime / dt; i++) {
    g.update(dt);
    fsw.update(world.t, liftoff);
    world.update(dt);
    if (!liftoff && v.telemetry.verticalSpeed > 0.5) { liftoff = true; v.hasLiftedOff = true; }
    if (liftoff && v.telemetry.altitude > 45) v.padSupportAlt = NaN;
    if (boosters.length && boosters.every((b) => b.v.landed || b.v.destroyed) && g.phase === 'done') break;
    if (i % (boosters.some((b) => b.g.phase === 'entry' || b.g.phase === 'landing' || b.g.phase === 'glide') ? 60 : 1800) === 0) for (const b of boosters) {
      const tm = b.v.telemetry;
      console.log(`t=${(world.t - t0).toFixed(0)} ${b.g.phase.padEnd(9)} alt ${(tm.altitude / 1000).toFixed(1)}km v ${tm.speedSurface.toFixed(0)} vz ${tm.verticalSpeed.toFixed(0)} miss ${(b.g.missDistance / 1000).toFixed(2)}km prop ${b.v.stagePropellant().current.toFixed(0)} thr ${(tm.thrust / 1000).toFixed(0)}kN q ${(tm.dynamicPressure/1000).toFixed(1)} aoa ${(Math.min(tm.aoa, 180 - tm.aoa)).toFixed(1)} run ${b.v.engines.filter((e) => e.running).length} mask ${b.v.controls.engineMask ? b.v.controls.engineMask.size : 'all'} thr ${b.v.controls.throttle.toFixed(2)}`);
    }
  }
  return { world, v, boosters, said, zones };
}

describe('booster recovery', () => {
  it('KESTREL 9 first stage returns to the landing zone', () => {
    const { boosters, said, world } = flyWithRecovery('kestrel9');
    console.log(said.join('\n'));
    expect(boosters.length).toBe(1);
    const b = boosters[0];
    const fix = b.v.fixedDirection(world.t, new Vector3());
    const dist = Math.acos(Math.min(1, fix.dot(b.g.zone.dir))) * 6371000;
    console.log('rest', b.v.telemetry.speedSurface.toFixed(3), b.v.angVel.length().toFixed(4), 'contact', b.v.contactForce.toFixed(0), 'thrust', b.v.telemetry.thrust.toFixed(0), 'pitch', b.v.telemetry.pitch.toFixed(1));
    console.log('landed', b.v.landed, 'destroyed', b.v.destroyReason, 'dist', dist.toFixed(1), 'impact', b.v.lastImpactSpeed.toFixed(2));
    expect(b.v.destroyed, b.v.destroyReason).toBe(false);
    expect(b.v.landed).toBe(true);
    // on the pad (48 m radius), not beside it
    expect(dist).toBeLessThan(40);
  });
});

describe('drone ship recovery', () => {
  const fair = new GameWeather({ kind: 'fair', windDir: (270 * Math.PI) / 180, ...WEATHER_PRESETS.fair });
  it.each([['calm air', calm], ['fair weather (jet stream, gusts)', fair]] as [string, WeatherProvider][])('KESTREL HEAVY in %s: side boosters land at the zones, the centre core on the drone ship deck', (_name, weather) => {
    // open ocean everywhere, except the landing pads and the ship's deck (the game's platforms)
    const gt = new GameTerrain(null as never, null as never);
    const terrain: TerrainProvider = {
      heightAt: (b, d) => gt.platformAt(b, d)?.height ?? 0,
      isWater: (b, d) => !gt.platformAt(b, d),
    };
    const site = LAUNCH_SITES.find((s) => s.id === 'cape')!;
    const t0 = dateToJ2000Seconds(new Date('2026-10-06T22:30:00Z'));
    const world = new PhysicsWorld(new SolarSystem(t0), t0, terrain, weather);
    const def = getVehicle('kestrel_heavy');
    const v = world.createVessel(def, world.system.earth);
    world.addVessel(v);
    world.active = v;
    const lat = (site.lat * Math.PI) / 180, lon = (site.lon * Math.PI) / 180;
    world.placeOnSurface(v, world.system.earth, lat, lon, 5, 0);
    v.padSupportAlt = 5;
    const az = launchAzimuth(lat, 28.6 * Math.PI / 180);
    const zones = landingZonesFor(site, def, az, (d) => terrain.heightAt(world.system.earth, d));
    for (const z of zones) {
      const east = new Vector3(0, 0, 1).cross(z.dir).normalize();
      const north = new Vector3().crossVectors(z.dir, east);
      const axis = north.clone().multiplyScalar(Math.cos(az)).addScaledVector(east, Math.sin(az)).normalize();
      gt.platforms.push(z.kind === 'droneship'
        ? { bodyId: 'earth', dir: z.dir.clone(), height: z.height, halfLength: 45.5, halfWidth: 26, axis }
        : { bodyId: 'earth', dir: z.dir.clone(), height: z.height, halfLength: 48, halfWidth: 48, axis, round: true });
    }
    expect(zones.some((z) => z.kind === 'droneship')).toBe(true);
    const boosters: { v: Vessel; g: BoosterGuidance }[] = [];
    world.guidanceFactory = (bv) => {
      const zone = zones.find((z) => !z.occupied && (z.kind !== 'droneship' || bv.assemblies.some((a) => a.def.recovery === 'droneship'))) ?? zones.find((z) => !z.occupied);
      if (!zone) return null;
      zone.occupied = true;
      const g = new BoosterGuidance(bv, world, zone);
      const shipDir = g.stationAtImpact(world.t);
      if (shipDir) {
        const plat = gt.platforms.find((p) => !p.round)!;
        plat.dir.copy(shipDir);
        const east = new Vector3(0, 0, 1).cross(shipDir).normalize();
        const north = new Vector3().crossVectors(shipDir, east);
        plat.axis.copy(north).multiplyScalar(Math.cos(az)).addScaledVector(east, Math.sin(az)).normalize();
        console.log('drone ship stationed', (Math.acos(Math.min(1, shipDir.dot(bv.fixedDirection(world.t, new Vector3())))) * 6371).toFixed(0), 'km downrange of the core');
      }
      boosters.push({ v: bv, g });
      return { update: (vv, dt, env) => g.update(vv, dt, env) };
    };
    const g = new AscentGuidance(world, v, def.targetOrbit ?? 220000, az);
    const fsw = new FlightSoftware(v);
    world.stage(v);
    const dt = 1 / 60;
    let liftoff = false;
    for (let i = 0; i < 1300 / dt; i++) {
      g.update(dt);
      fsw.update(world.t, liftoff);
      world.update(dt);
      if (!liftoff && v.telemetry.verticalSpeed > 0.5) { liftoff = true; v.hasLiftedOff = true; }
      if (liftoff && v.telemetry.altitude > 45) v.padSupportAlt = NaN;
      if (boosters.length >= 3 && boosters.every((b) => b.v.landed || b.v.destroyed)) break;
      world.drainEvents();
    }
    for (const b of boosters) {
      const fix = b.v.fixedDirection(world.t, new Vector3());
      const dist = Math.acos(Math.min(1, fix.dot(b.g.zone.dir))) * 6371000;
      console.log(b.g.zone.id, 'landed', b.v.landed, 'splashed', b.v.splashed, 'destroyed', b.v.destroyReason, 'dist', dist.toFixed(1), 'impact', b.v.lastImpactSpeed.toFixed(2));
    }
    expect(boosters.length).toBe(3);
    const core = boosters.find((b) => b.g.zone.kind === 'droneship');
    expect(core).toBeTruthy();
    expect(core!.v.destroyed, core!.v.destroyReason).toBe(false);
    expect(core!.v.landed).toBe(true);
    expect(core!.v.splashed).toBe(false);
    for (const b of boosters.filter((x) => x.g.zone.kind === 'pad')) {
      expect(b.v.destroyed, b.v.destroyReason).toBe(false);
      expect(b.v.landed).toBe(true);
      const d = Math.acos(Math.min(1, b.v.fixedDirection(world.t, new Vector3()).dot(b.g.zone.dir))) * 6371000;
      expect(d).toBeLessThan(40);
    }
  }, 300_000);
});

describe('tower catch', () => {
  // the Catch mission flies in breezy weather (onshore wind, as the session sets it up)
  const breezy = new GameWeather({ kind: 'breezy', windDir: ((90 + 180) * Math.PI) / 180, ...WEATHER_PRESETS.breezy });
  it.each([['calm air', calm, '2026-10-06T22:30:00Z'], ['breezy weather, mission date', breezy, '2026-10-09T13:00:00Z']] as [string, WeatherProvider, string][])('LEVIATHAN booster flies back to the tower and is caught (%s)', (_name, weather, date) => {
    const site = LAUNCH_SITES.find((s) => s.id === 'boca')!;
    const epoch = dateToJ2000Seconds(new Date(date));
    const world = new PhysicsWorld(new SolarSystem(epoch), epoch, flatTerrainForTest, weather);
    const def = getVehicle('leviathan');
    const v = world.createVessel(def, world.system.earth);
    world.addVessel(v);
    world.active = v;
    const lat = (site.lat * Math.PI) / 180, lon = (site.lon * Math.PI) / 180;
    world.placeOnSurface(v, world.system.earth, lat, lon, 5, 0);
    v.padSupportAlt = 5;
    const az = launchAzimuth(lat, 26.5 * Math.PI / 180);
    const zones = landingZonesFor(site, def, az, () => 5);
    expect(zones.map((z) => z.kind)).toEqual(['tower']);
    const boosters: { v: Vessel; g: BoosterGuidance }[] = [];
    const said: string[] = [];
    world.guidanceFactory = (bv) => {
      const zone = zones.find((z) => !z.occupied);
      if (!zone) return null;
      zone.occupied = true;
      const g = new BoosterGuidance(bv, world, zone);
      g.onEvent = (id) => said.push(`${id}@${world.t.toFixed(0)}`);
      boosters.push({ v: bv, g });
      return { update: (vv, dt, env) => g.update(vv, dt, env) };
    };
    const g = new AscentGuidance(world, v, def.targetOrbit ?? 200000, az);
    const fsw = new FlightSoftware(v);
    world.stage(v);
    const dt = 1 / 60;
    let liftoff = false;
    let peakQA = 0;
    const t0 = world.t;
    for (let i = 0; i < 900 / dt; i++) {
      g.update(dt);
      fsw.update(world.t, liftoff);
      world.update(dt);
      if (!liftoff && v.telemetry.verticalSpeed > 0.5) { liftoff = true; v.hasLiftedOff = true; }
      if (liftoff && v.telemetry.altitude > 45) v.padSupportAlt = NaN;
      for (const b of boosters) {
        const tm = b.v.telemetry;
        const qa = (tm.dynamicPressure / 1000) * Math.min(tm.aoa, 180 - tm.aoa);
        if (!b.v.destroyed && !b.v.landed) peakQA = Math.max(peakQA, qa);
        if (i % (b.g.phase === 'landing' ? 30 : 120) === 0 && !b.v.landed && !b.v.destroyed) console.log(`t=${(world.t - t0).toFixed(1)} ${b.g.phase.padEnd(9)} alt ${(tm.altitude / 1000).toFixed(2)}km v ${tm.speedSurface.toFixed(0)} vz ${tm.verticalSpeed.toFixed(0)} q ${(tm.dynamicPressure / 1000).toFixed(1)} aoa ${Math.min(tm.aoa, 180 - tm.aoa).toFixed(1)} qa ${qa.toFixed(0)} miss ${(b.g.missDistance / 1000).toFixed(2)}km prop ${b.v.stagePropellant().current.toFixed(0)}${b.g.phase === 'landing' ? ' | ' + b.g.landingInfo : ''}`);
      }
      if (boosters.length && boosters.every((b) => b.v.landed || b.v.destroyed)) break;
      world.drainEvents();
    }
    console.log(said.join(' '));
    const b = boosters[0];
    expect(b).toBeTruthy();
    const dist = Math.acos(Math.min(1, b.v.fixedDirection(world.t, new Vector3()).dot(b.g.zone.dir))) * 6371000;
    console.log('caught', b.v.landed, 'destroyed', b.v.destroyReason, 'dist', dist.toFixed(1), 'peak q·α', peakQA.toFixed(0), 'kPa·deg');
    expect(b.v.destroyed, b.v.destroyReason).toBe(false);
    expect(b.v.landed).toBe(true);
    expect(dist).toBeLessThan(15);
  }, 300_000);
});
