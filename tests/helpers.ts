import { Vector3 } from 'three';
import { SolarSystem } from '../src/physics/bodies';
import { dateToJ2000Seconds } from '../src/physics/constants';
import type { CelestialBody } from '../src/physics/bodies';
import { PhysicsWorld } from '../src/physics/world';
import type { TerrainProvider, Vessel, WeatherProvider } from '../src/physics/vessel';
import { getVehicle } from '../src/vehicles/catalog';
import { AscentGuidance, FlightSoftware, launchAzimuth } from '../src/game/guidance';

export const flatTerrain: TerrainProvider = {
  heightAt: () => 0,
  isWater: () => false,
};
export const oceanTerrain: TerrainProvider = {
  heightAt: () => 0,
  isWater: () => true,
};
export const calm: WeatherProvider = {
  windAt: (_b: CelestialBody, _lat: number, _lon: number, _alt: number, _t: number, out: Vector3) => out.set(0, 0, 0),
  turbulence: () => 0,
};

export function makeWorld(terrain: TerrainProvider = flatTerrain) {
  const t0 = dateToJ2000Seconds(new Date('2026-10-06T22:30:00Z'));
  const sys = new SolarSystem(t0);
  const world = new PhysicsWorld(sys, t0, terrain, calm);
  return { sys, world };
}

export const CAPE = { lat: 28.5729 * Math.PI / 180, lon: -80.649 * Math.PI / 180 };

/** Put a launcher on the pad and fly it with orbit assist. Returns telemetry log. */
export function flyAscent(vehicleId: string, targetAlt: number, maxTime = 900, opts: { log?: boolean } = {}) {
  const { world } = makeWorld();
  const def = getVehicle(vehicleId);
  const v = world.createVessel(def, world.system.earth);
  world.addVessel(v);
  const padAlt = 5;
  world.placeOnSurface(v, world.system.earth, CAPE.lat, CAPE.lon, padAlt, 0);
  v.padSupportAlt = padAlt;
  const az = launchAzimuth(CAPE.lat, 28.6 * Math.PI / 180);
  const g = new AscentGuidance(world, v, targetAlt, az);
  const fsw = new FlightSoftware(v);
  world.stage(v); // ignite + release
  const dt = 1 / 60;
  const log: { t: number; alt: number; v: number; ap: number; pe: number; phase: string; stage: number; q: number; mass: number; pitch: number }[] = [];
  let tFlight = 0;
  let liftoff = false;
  for (let i = 0; i < maxTime / dt; i++) {
    g.update(dt);
    fsw.update(world.t, liftoff);
    world.update(dt);
    tFlight += dt;
    const tm = v.telemetry;
    if (!liftoff && tm.verticalSpeed > 0.5) { liftoff = true; v.hasLiftedOff = true; }
    if (liftoff && tm.altitude > padAlt + 40) v.padSupportAlt = NaN;
    if (i % 600 === 0 || v.destroyed) {
      const o = v.updateOrbit(world.t);
      log.push({ t: tFlight, alt: tm.altitude, v: tm.speedOrbital, ap: (o.apoapsis - 6371000) / 1000, pe: (o.periapsis - 6371000) / 1000, phase: g.phase, stage: v.stageIndex, q: tm.dynamicPressure, mass: v.mass, pitch: tm.pitch });
    }
    if (v.destroyed || g.phase === 'done') break;
  }
  if (opts.log) console.log(log.map((l) => `${l.t.toFixed(0).padStart(5)}s ${l.phase.padEnd(11)} st${l.stage} alt ${(l.alt / 1000).toFixed(1).padStart(6)}km v ${l.v.toFixed(0).padStart(5)} ap ${l.ap.toFixed(0).padStart(6)} pe ${l.pe.toFixed(0).padStart(6)} q ${(l.q / 1000).toFixed(1).padStart(5)}kPa m ${(l.mass / 1000).toFixed(1)}t pitch ${l.pitch.toFixed(1)}`).join('\n'));
  return { world, v, g, log };
}

export function vesselOrbit(v: Vessel, t: number) {
  const o = v.updateOrbit(t);
  return { ap: o.apoapsis - v.body.radius, pe: o.periapsis - v.body.radius, e: o.e };
}
