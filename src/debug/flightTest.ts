import { WebGLRenderer } from 'three';
import { loadAssets } from '../core/assets';
import { FlightSession } from '../game/FlightSession';
import { GameTerrain } from '../game/providers';
import { SolarSystem } from '../physics/bodies';
import { dateToJ2000Seconds } from '../physics/constants';
import { RenderWorld } from '../render/RenderWorld';
import { loadLiveryFonts } from '../render/vehicle/Livery';
import { LAUNCH_SITES, siteToHeightDef } from '../world/sites';
import type { CameraMode } from '../camera/CameraDirector';

/**
 * Headless flight harness: ?debug=flight&vehicle=..&site=..&utc=..&T=-30&cam=cinematic[&smoke=0.5&particles=1500]
 * Exposes window.__advance(seconds) to fast-forward the simulation deterministically and
 * renders continuously (without advancing the sim unless live=1).
 */
export async function runFlightTest(canvas: HTMLCanvasElement): Promise<void> {
  const q = new URLSearchParams(location.search);
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  const w = window as any;
  w.__state = { frames: 0, ready: false, error: null };
  const renderer = new WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance', stencil: false });
  renderer.shadowMap.enabled = true;
  const assets = await loadAssets(() => {});
  await loadLiveryFonts();
  const date = new Date(q.get('utc') ?? '2026-10-06T21:30:00Z');
  const system = new SolarSystem(dateToJ2000Seconds(date));
  const rw = new RenderWorld(renderer, assets, system, LAUNCH_SITES.map(siteToHeightDef));
  if (q.has('lod')) rw.earth.splitFactor = num('lod', 2.4);
  // smoke resolution and particle budget, as a graphics preset sets them
  if (q.has('smoke')) rw.post.settings.smokeScale = num('smoke', 1);
  if (q.has('particles')) rw.effects.setBudget(num('particles', 6000));
  const W = num('w', window.innerWidth), H = num('h', window.innerHeight);
  rw.resize(W, H, 1);
  const terrain = new GameTerrain(rw.heightCtxEarth, rw.heightCtxMoon);
  const session = new FlightSession(rw, system, terrain, {
    vehicleId: q.get('vehicle') ?? 'kestrel9', siteId: q.get('site') ?? 'cape', date, weather: (q.get('weather') as never) ?? 'fair',
    countdownStart: num('T', -120), recovery: q.get('recovery') !== '0',
    start: (q.get('start') as never) ?? 'pad', targetOrbit: q.has('orbit') ? num('orbit', 220) * 1000 : undefined,
  });
  session.director.setMode((q.get('cam') as CameraMode) ?? 'cinematic');
  const log: string[] = [];
  session.on((e) => {
    if (e.type === 'radio') log.push(`[${session.met.toFixed(1)}] radio ${e.id}`);
    else if (e.type === 'message') log.push(`[${session.met.toFixed(1)}] ${e.text}`);
    else if (e.type === 'countdown') log.push(`[${session.met.toFixed(1)}] count ${e.ev.label}`);
    else if (e.type === 'phase') log.push(`[${session.met.toFixed(1)}] phase ${e.phase}`);
    else if (e.type === 'booster') log.push(`[${session.met.toFixed(1)}] booster ${e.id}`);
    else if (e.type === 'separation') log.push(`[${session.met.toFixed(1)}] separation ${e.kind}`);
  });
  w.__session = session;
  w.__rw = rw;
  w.__log = log;
  const live = q.get('live') === '1';
  /** fast-forward the simulation (render-free) */
  w.__advance = (seconds: number, dt = 1 / 30) => {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      session.update(dt);
      // keep the effects simulation in step (particles, plumes) without drawing
      if (i % 2 === 0) session.render(dt * 2);
    }
    return { met: session.met, phase: session.phase, alt: session.active.telemetry.altitude, v: session.active.telemetry.speedSurface, particles: rw.effects.particles.stats.count };
  };
  w.__cut = (shot: string) => session.director.forceShot(shot);
  let last = performance.now();
  const frame = () => {
    if (w.__freeze) { requestAnimationFrame(frame); return; }
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    try {
      if (live) session.update(dt);
      session.render(live ? dt : 1 / 60);
      rw.render(dt);
    } catch (e) {
      w.__state.error = String((e as Error).stack ?? e);
      throw e;
    }
    w.__state.frames++;
    w.__state.ready = rw.earth.ready && rw.earth.stats.pending === 0;
    w.__state.met = session.met;
    w.__state.phase = session.phase;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
