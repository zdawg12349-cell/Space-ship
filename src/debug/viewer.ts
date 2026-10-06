import { Matrix4, Quaternion, Vector3, WebGLRenderer } from 'three';
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
  const assets = await loadAssets(() => {});
  const utc = q.get('utc') ?? '2026-10-06T22:40:00Z';
  const t0 = dateToJ2000Seconds(new Date(utc));
  const system = new SolarSystem(t0);
  const rw = new RenderWorld(renderer, assets, system, LAUNCH_SITES.map(siteToHeightDef));
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
  let t = t0;
  const timeScale = num('timescale', 0);
  let last = performance.now();
  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt * timeScale;
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
