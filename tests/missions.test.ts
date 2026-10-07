import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { SolarSystem } from '../src/physics/bodies';
import { dateToJ2000Seconds } from '../src/physics/constants';
import { PhysicsWorld } from '../src/physics/world';
import { getVehicle } from '../src/vehicles/catalog';
import { Autopilot } from '../src/game/Autopilot';
import { planDeorbit, planTLI, planTEI, planCapture } from '../src/game/Planner';
import { calm, flatTerrain } from './helpers';
import { keplerPropagate } from '../src/physics/orbit';
import { Vessel } from '../src/physics/vessel';

function world(date = '2026-10-10T13:32:00Z') {
  const t0 = dateToJ2000Seconds(new Date(date));
  const sys = new SolarSystem(t0);
  return { sys, world: new PhysicsWorld(sys, t0, flatTerrain, calm) };
}

/** Circular orbit in the body's equatorial plane (inclined by incl). */
function circular(w: PhysicsWorld, v: Vessel, alt: number, inclDeg: number, phase = 0) {
  const body = v.body;
  const rot = new Quaternion();
  body.orientationAt(w.t, rot);
  const pole = new Vector3(0, 0, 1).applyQuaternion(rot);
  const ref = new Vector3(1, 0, 0).applyQuaternion(rot);
  const nrm = pole.clone().applyAxisAngle(ref, (inclDeg * Math.PI) / 180);
  const r = body.radius + alt;
  const p = ref.clone().applyAxisAngle(nrm, phase).multiplyScalar(r);
  const vel = new Vector3().crossVectors(nrm, p).normalize().multiplyScalar(Math.sqrt(body.gm / r));
  w.placeInOrbit(v, body, p, vel, vel);
}

function run(w: PhysicsWorld, ap: Autopilot, seconds: number, until?: () => boolean) {
  const dt = 1 / 30;
  for (let i = 0; i < seconds / dt; i++) {
    ap.update(dt);
    if (ap.mode !== 'orbit' && ap.throttleCmd !== null) ap.vessel.controls.throttle = ap.throttleCmd;
    if (ap.wantStage) { ap.wantStage = false; w.stage(ap.vessel); }
    w.update(dt);
    if (until?.()) break;
  }
}

describe('manoeuvre planning', () => {
  it('deorbit node lowers perigee into the entry corridor', () => {
    const { world: w } = world();
    const def = getVehicle('vostok');
    const v = w.createVessel(def, w.system.earth);
    w.addVessel(v);
    circular(w, v, 220_000, 51.6);
    const n = planDeorbit(v, w.t, 40_000);
    expect(n.dv.length()).toBeGreaterThan(40);
    expect(n.dv.length()).toBeLessThan(120);
  });

  it('TLI from a parking orbit reaches the Moon', () => {
    const { world: w, sys } = world();
    const def = getVehicle('colossus');
    const v = w.createVessel(def, w.system.earth);
    w.addVessel(v);
    // parking orbit whose plane contains the Moon's position ~3 days on (as the launch window ensures)
    const m3 = new Vector3(), mv = new Vector3();
    sys.moon.localStateAt(w.t + 3 * 86400, m3, mv);
    const rot = new Quaternion();
    sys.earth.orientationAt(w.t, rot);
    const pole = new Vector3(0, 0, 1).applyQuaternion(rot);
    const nrm = new Vector3().crossVectors(m3, pole).cross(m3).normalize();
    if (nrm.dot(pole) < 0) nrm.negate();
    const r0 = 6_371_000 + 190_000;
    const p0 = m3.clone().normalize().applyAxisAngle(nrm, 1.2).multiplyScalar(r0);
    const v0 = new Vector3().crossVectors(nrm, p0).normalize().multiplyScalar(Math.sqrt(sys.earth.gm / r0));
    w.placeInOrbit(v, sys.earth, p0, v0, v0);
    const n = planTLI(v, sys, w.t, 300_000);
    console.log(n?.label, n?.dv.length().toFixed(0), n?.result);
    expect(n).not.toBeNull();
    expect(n!.dv.length()).toBeGreaterThan(2900);
    expect(n!.dv.length()).toBeLessThan(3300);
    const m = /periapsis (-?\d+) km/.exec(n!.result);
    expect(m).not.toBeNull();
    expect(Math.abs(Number(m![1]) - 300)).toBeLessThan(400);
  });

  it('TEI from lunar orbit returns to an Earth entry corridor', () => {
    const { world: w, sys } = world('2026-10-14T18:00:00Z');
    const def = getVehicle('lrv');
    const v = w.createVessel(def, w.system.moon);
    w.addVessel(v);
    circular(w, v, 60_000, 5);
    const n = planTEI(v, sys, w.t);
    console.log(n?.label, n?.dv.length().toFixed(0), n?.result);
    expect(n).not.toBeNull();
    const m = /perigee (-?\d+) km/.exec(n!.result);
    expect(Math.abs(Number(m![1]) - 45)).toBeLessThan(60);
  });
});

describe('autopilot flight', () => {
  it('lunar descent assist lands softly', () => {
    const { world: w } = world('2026-10-13T20:17:00Z');
    const def = getVehicle('selene');
    const v = w.createVessel(def, w.system.moon);
    w.addVessel(v);
    w.active = v;
    circular(w, v, 100_000, 2);
    const ap = new Autopilot(w, v);
    ap.setMode('land');
    let touchdown = NaN;
    run(w, ap, 4000, () => {
      for (const e of v.events) if (e.type === 'touchdown') touchdown = e.speed;
      return v.landed || v.destroyed;
    });
    console.log('lunar landing', v.landed, v.destroyed, v.destroyReason, 'touchdown', touchdown, 'prop', v.stagePropellant().current.toFixed(0));
    expect(v.destroyed).toBe(false);
    expect(v.landed).toBe(true);
  });

  it('vacuum ascent reaches lunar orbit', () => {
    const { world: w } = world('2026-10-14T18:00:00Z');
    const def = getVehicle('lrv');
    const v = w.createVessel(def, w.system.moon);
    w.addVessel(v);
    w.active = v;
    w.placeOnSurface(v, w.system.moon, 0.0117, 0.4097, 0.1, 0);
    for (const a of v.assemblies) if (a.def.features?.landingLegs) { a.legsDeployed = 1; a.legsTarget = 1; }
    v.settleLanded(w.t, false);
    const ap = new Autopilot(w, v);
    ap.setMode('ascend');
    run(w, ap, 1500, () => ap.mode === 'stability' || v.destroyed);
    const o = v.updateOrbit(w.t);
    console.log('lunar ascent', ap.mode, 'pe', ((o.periapsis - v.body.radius) / 1000).toFixed(1), 'ap', ((o.apoapsis - v.body.radius) / 1000).toFixed(1));
    expect(v.destroyed).toBe(false);
    expect(o.periapsis - v.body.radius).toBeGreaterThan(8000);
  });

  it('executes a deorbit burn to the planned perigee', () => {
    const { world: w } = world();
    const def = getVehicle('vostok');
    // the spacecraft as it is in orbit after the launcher has separated
    const v = new Vessel('spacecraft', def, def.assemblies.filter((a) => ['sm', 'om', 'dm'].includes(a.id)), w.system.earth);
    w.addVessel(v);
    w.active = v;
    circular(w, v, 220_000, 51.6);
    // arm the service module like the staging sequence would after orbit
    for (const a of v.assemblies) for (const e of a.engines) e.armed = a.id === 'sm';
    const ap = new Autopilot(w, v);
    const n = planDeorbit(v, w.t, 40_000);
    ap.setNode(n);
    ap.setMode('node');
    run(w, ap, 600, () => ap.mode === 'stability');
    const o = v.updateOrbit(w.t);
    const pe = o.periapsis - v.body.radius;
    console.log('deorbit perigee', (pe / 1000).toFixed(1), 'remaining', ap.nodeRemaining.toFixed(2));
    expect(Math.abs(pe - 40_000)).toBeLessThan(15_000);
  });

  it('plans a Jupiter capture from the approach hyperbola', () => {
    const { world: w } = world('2026-10-07T00:00:00Z');
    const jup = w.system.get('jupiter');
    const def = getVehicle('juno_probe');
    const v = w.createVessel(def, jup);
    w.addVessel(v);
    const rot = new Quaternion();
    jup.orientationAt(w.t, rot);
    const ref = new Vector3(1, 0, 0).applyQuaternion(rot), side = new Vector3(0, 1, 0).applyQuaternion(rot);
    const rp = jup.radius * 2.6, vinf = 5800;
    const vp = Math.sqrt(vinf * vinf + (2 * jup.gm) / rp);
    const r = new Vector3(), vel = new Vector3();
    keplerPropagate(ref.clone().multiplyScalar(rp), side.clone().multiplyScalar(vp), jup.gm, -2 * 86400, r, vel);
    w.placeInOrbit(v, jup, r, vel, vel);
    const n = planCapture(v, w.t, 60, 'JOI');
    console.log('JOI', n?.dv.length().toFixed(0), n?.result, ((n!.t - w.t) / 3600).toFixed(1), 'h');
    expect(n).not.toBeNull();
    expect(Math.abs(n!.t - w.t - 2 * 86400)).toBeLessThan(3 * 3600);
  });
});
