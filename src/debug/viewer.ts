import { Matrix4, PCFSoftShadowMap, Quaternion, Vector3, WebGLRenderer } from 'three';
import { PhysicsWorld } from '../physics/world';
import type { Vessel } from '../physics/vessel';
import { getVehicle, LAUNCHERS } from '../vehicles/catalog';
import { loadLiveryFonts } from '../render/vehicle/Livery';
import { loadAssets } from '../core/assets';
import { SolarSystem } from '../physics/bodies';
import { dateToJ2000Seconds } from '../physics/constants';
import { RenderWorld } from '../render/RenderWorld';
import { LAUNCH_SITES, siteToHeightDef } from '../world/sites';

/**
 * Debug viewer: ?debug=view&body=earth&lat=..&lon=..&alt=..&heading=..&pitch=..&utc=..&fov=..
 * Exposes window.__state for the headless screenshot harness.
 */
export async function runViewer(canvas: HTMLCanvasElement): Promise<void> {
  const q = new URLSearchParams(location.search);
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  const renderer = new WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance', stencil: false });
  const w = window as any;
  w.__state = { frames: 0, ready: false, error: null };
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  const assets = await loadAssets(() => {});
  await loadLiveryFonts();
  const utc = q.get('utc') ?? '2026-10-06T22:40:00Z';
  const t0 = dateToJ2000Seconds(new Date(utc));
  const system = new SolarSystem(t0);
  const rw = new RenderWorld(renderer, assets, system, LAUNCH_SITES.map(siteToHeightDef));
  if (q.has('lod')) rw.earth.splitFactor = num('lod', 2.4);
  const W = num('w', window.innerWidth), H = num('h', window.innerHeight);
  rw.resize(W, H, num('dpr', 1));
  rw.camera.fov = num('fov', 55);
  rw.camera.updateProjectionMatrix();
  const bodyId = q.get('body') ?? 'earth';
  const body = system.get(bodyId);
  const lat = (num('lat', 28.6) * Math.PI) / 180;
  const lon = (num('lon', -80.6) * Math.PI) / 180;
  const alt = num('alt', 400000);
  const heading = (num('heading', 90) * Math.PI) / 180;
  const pitch = (num('pitch', -10) * Math.PI) / 180;
  rw.cloudCover = num('clouds', 1);
  rw.earthMat.uniforms.uDebug.value = num('dbg', 0);
  rw.post.compositeMat.uniforms.uAtmEnabled.value = num('atm', 1);
  rw.post.compositeMat.uniforms.uDebug.value = num('cdbg', 0);
  if (q.has('ev')) { rw.post.settings.autoExposure = false; rw.post.settings.manualEV = num('ev', 10); }
  if (q.get('wire') === '1') rw.earthMat.wireframe = true;
  if (q.has('bloom')) rw.post.settings.bloom = num('bloom', 0.05);
  if (q.has('ca')) rw.post.settings.chromatic = num('ca', 0);
  (window as any).__rw = rw;
  // optional vehicle on the pad: ?vehicle=id&dist=&az=&el=&ty=
  let vessel: Vessel | null = null;
  const extra: Vessel[] = [];
  const vehId = q.get('vehicle') ?? (q.get('lineup') ? LAUNCHERS[0].id : null);
  if (q.get('lineup')) {
    // all launchers side by side along the east axis, 70 m apart
    const world = new PhysicsWorld(system, t0, { heightAt: () => 0, isWater: () => false }, { windAt: (_b, _la, _lo, _a, _t, out) => out.set(0, 0, 0), turbulence: () => 0 });
    const site = LAUNCH_SITES[0];
    const ids = (q.get('lineup') === '1' ? LAUNCHERS.map((d) => d.id) : q.get('lineup')!.split(','));
    ids.forEach((id, i) => {
      const def = getVehicle(id);
      const v = world.createVessel(def, system.earth);
      const dLon = ((i - (ids.length - 1) / 2) * num('spacing', 70)) / (6371000 * Math.cos((site.lat * Math.PI) / 180));
      world.placeOnSurface(v, system.earth, (site.lat * Math.PI) / 180, (site.lon * Math.PI) / 180 + dLon, site.padHeight, Math.PI / 2);
      rw.vessels.attach(v, def);
      if (i === Math.floor(ids.length / 2)) vessel = v; else extra.push(v);
    });
  } else if (vehId) {
    const world = new PhysicsWorld(system, t0, { heightAt: () => 0, isWater: () => false }, { windAt: (_b, _la, _lo, _a, _t, out) => out.set(0, 0, 0), turbulence: () => 0 });
    const def = getVehicle(vehId);
    vessel = world.createVessel(def, system.earth);
    const site = LAUNCH_SITES.find((s) => s.id === (q.get('site') ?? 'cape'))!;
    // launch complex (pad=0 shows the bare vehicle on the ground)
    const complex = q.get('pad') === '0' ? null : rw.setComplex(site, def, num('veg', 1));
    if (complex && q.has('arms')) complex.setArm('all', q.get('arms') === 'retract');
    if (complex && q.get('arms') === 'retract') for (let i = 0; i < 400; i++) complex.update(0.25, 0);
    (window as any).__complex = complex;
    const deck = complex ? complex.deckHeight : 0;
    world.placeOnSurface(vessel, system.earth, (site.lat * Math.PI) / 180, (site.lon * Math.PI) / 180, site.padHeight + deck + num('lift', 0), (num('roll', 0) * Math.PI) / 180);
    rw.vessels.attach(vessel, def, { flightProven: q.get('proven') === '1' });
    const a0 = vessel.assemblies.find((a) => a.def.features?.landingLegs);
    if (a0 && q.get('legs') === '1') a0.legsDeployed = 1;
    const gf = vessel.assemblies.find((a) => a.def.features?.gridFins);
    if (gf && q.get('fins') === '1') gf.gridFinsDeployed = 1;
    for (const a of vessel.assemblies) if (q.get('frost') === '0') a.def.sections.forEach(() => undefined);
    (window as any).__vessel = vessel;
  }
  let t = t0;
  const timeScale = num('timescale', 0);
  let last = performance.now();
  const frame = () => {
    if (w.__freeze) { requestAnimationFrame(frame); return; }
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt * timeScale;
    if (vessel) {
      // orbit camera around the vehicle: dist, az (deg from north), el (deg), ty (target height m)
      const rot = new Quaternion();
      body.orientationAt(t, rot);
      const bodyPos = new Vector3();
      body.globalPositionAt(t, bodyPos);
      const origin = vessel.originInertial(new Vector3()).add(bodyPos);
      const vup = new Vector3(0, 1, 0).applyQuaternion(vessel.rot);
      const vnorth = new Vector3(0, 0, 1).applyQuaternion(rot); // pole
      vnorth.addScaledVector(vup, -vnorth.dot(vup)).normalize();
      const veast = new Vector3().crossVectors(vnorth, vup);
      const az = (num('az', 200) * Math.PI) / 180, el = (num('el', 8) * Math.PI) / 180, dist = num('dist', 120);
      const target = origin.clone().addScaledVector(vup, num('ty', 30));
      const offs = vnorth.clone().multiplyScalar(Math.cos(az) * Math.cos(el)).addScaledVector(veast, Math.sin(az) * Math.cos(el)).addScaledVector(vup, Math.sin(el)).multiplyScalar(dist);
      const camHelio = target.clone().add(offs);
      rw.cameraHelio.copy(camHelio);
      const m = new Matrix4().lookAt(new Vector3(), offs.clone().negate(), vup);
      rw.camera.quaternion.setFromRotationMatrix(m);
      rw.focusHelio.copy(origin).addScaledVector(vup, num('ty', 30));
      rw.focusRadius = Math.max(40, num('shadow', 90));
      rw.update(t, dt);
      rw.vessels.sync([vessel, ...extra], () => bodyPos, rw.cameraHelio, dt);
      rw.render(dt);
      w.__state.frames++;
      w.__state.ready = rw.earth.ready && rw.earth.stats.pending === 0;
      w.__state.stats = { earth: rw.earth.stats };
      requestAnimationFrame(frame);
      return;
    }
    // camera placement in the body-fixed frame
    const up = new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    const north = new Vector3(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat));
    const east = new Vector3().crossVectors(north, up);
    const R = body.radius + alt;
    const posFixed = up.clone().multiplyScalar(R);
    const fwd = north.clone().multiplyScalar(Math.cos(heading)).addScaledVector(east, Math.sin(heading)).multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch)).normalize();
    const rot = new Quaternion();
    body.orientationAt(t, rot);
    const bodyPos = new Vector3();
    body.globalPositionAt(t, bodyPos);
    const camHelio = posFixed.clone().applyQuaternion(rot).add(bodyPos);
    rw.cameraHelio.copy(camHelio);
    const fwdW = fwd.clone().applyQuaternion(rot);
    const upW = up.clone().applyQuaternion(rot);
    // near-vertical views: use north as the camera's up vector (lookAt degenerates otherwise)
    const camUp = Math.abs(fwdW.dot(upW)) > 0.99 ? north.clone().applyQuaternion(rot) : upW;
    const m = new Matrix4().lookAt(new Vector3(), fwdW, camUp);
    rw.camera.quaternion.setFromRotationMatrix(m);
    rw.update(t, dt);
    rw.render(dt);
    w.__state.frames++;
    w.__state.ready = rw.earth.ready && rw.moon.ready && rw.earth.stats.pending === 0 && rw.moon.stats.pending === 0;
    w.__state.stats = { earth: rw.earth.stats, moon: rw.moon.stats };
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
