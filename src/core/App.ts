import { Matrix4, Quaternion, Vector3, WebGLRenderer } from 'three';
import { loadAssets, AssetBundle } from './assets';
import { SolarSystem } from '../physics/bodies';
import { dateToJ2000Seconds } from '../physics/constants';
import { RenderWorld } from '../render/RenderWorld';
import { loadLiveryFonts } from '../render/vehicle/Livery';
import { LAUNCH_SITES, siteToHeightDef } from '../world/sites';
import { GameTerrain } from '../game/providers';
import { loadSettings, saveSettings, Settings, GRAPHICS } from '../game/Settings';
import { FlightController, FlightLaunchOptions } from '../game/FlightController';
import { MainMenu } from '../ui/Menus';
import { h, hide, show } from '../ui/dom';
import { AudioEngine } from '../audio/AudioEngine';
import { loadProgress, Progress } from '../game/SaveGame';

/**
 * Application shell: boot + loading screen, a live orbital backdrop behind the main menu,
 * and hand-off to flights. One renderer and one render world are shared for the lifetime of
 * the page; flights rebuild only what they need (launch complex, vehicles, effects).
 */
export class App {
  readonly renderer: WebGLRenderer;
  assets!: AssetBundle;
  rw!: RenderWorld;
  system!: SolarSystem;
  terrain!: GameTerrain;
  settings: Settings;
  progress: Progress;
  readonly ui: HTMLElement;
  audio!: AudioEngine;
  private menu: MainMenu | null = null;
  flight: FlightController | null = null;
  private last = performance.now();
  private menuT = 0;
  private menuTime0 = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ui = document.getElementById('ui')!;
    this.settings = loadSettings();
    this.progress = loadProgress();
    this.renderer = new WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: true });
    this.renderer.shadowMap.enabled = true;
  }

  async boot(): Promise<void> {
    const loading = h('div', { id: 'loading', class: 'screen' },
      h('div', { class: 'title' }, 'ASCENT'),
      h('div', { class: 'sub' }, 'Cinematic spaceflight'),
      h('div', { class: 'bar' }, h('div', {})),
      h('div', { class: 'status' }, 'Initialising'),
    );
    this.ui.appendChild(loading);
    show(loading);
    const bar = loading.querySelector('.bar > div') as HTMLElement;
    const status = loading.querySelector('.status') as HTMLElement;
    const progress = (f: number, label: string) => { bar.style.width = `${Math.round(f * 85)}%`; status.textContent = label; };
    this.assets = await loadAssets(progress);
    status.textContent = 'Fonts';
    await loadLiveryFonts();
    status.textContent = 'Building the solar system';
    const date = new Date();
    this.system = new SolarSystem(dateToJ2000Seconds(date));
    this.rw = new RenderWorld(this.renderer, this.assets, this.system, LAUNCH_SITES.map(siteToHeightDef));
    this.terrain = new GameTerrain(this.rw.heightCtxEarth, this.rw.heightCtxMoon);
    this.applyGraphics();
    this.audio = new AudioEngine(this.settings, this.assets);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    // menu backdrop: warm up the planet before revealing
    this.menuTime0 = dateToJ2000Seconds(new Date('2026-10-07T06:13:30Z'));
    this.system.setEpoch(this.menuTime0);
    status.textContent = 'Streaming terrain';
    bar.style.width = '90%';
    const t0 = performance.now();
    while (performance.now() - t0 < 12000) {
      this.renderMenuBackdrop(1 / 60);
      if (this.rw.earth.ready && this.rw.earth.stats.pending === 0) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    bar.style.width = '100%';
    await hide(loading);
    this.showMenu();
    this.installDebugApi();
    requestAnimationFrame(this.frame);
  }

  applyGraphics(): void {
    const g = GRAPHICS[this.settings.preset];
    const rw = this.rw;
    rw.post.settings.resolutionScale = g.resolutionScale;
    rw.post.settings.msaa = g.msaa;
    rw.post.settings.bloom = g.bloom;
    rw.post.settings.grain = g.grain;
    rw.post.settings.vignette = g.vignette;
    rw.post.settings.chromatic = g.chromatic;
    rw.post.settings.exposureComp = this.settings.exposureComp;
    rw.earth.splitFactor = g.terrainDetail;
    rw.moon.splitFactor = g.terrainDetail;
    this.renderer.shadowMap.enabled = g.shadows > 0;
    rw.sunLight.castShadow = g.shadows > 0;
    if (g.shadows > 0 && rw.sunLight.shadow.mapSize.x !== g.shadows) {
      rw.sunLight.shadow.mapSize.set(g.shadows, g.shadows);
      rw.sunLight.shadow.map?.dispose();
      rw.sunLight.shadow.map = null;
    }
    rw.plumes.quality = g.plumeQuality;
    rw.effects.setBudget(g.particles);
    rw.envProbe.setSize(g.envProbe);
    this.resize(true);
  }

  resize(force = false): void {
    const g = GRAPHICS[this.settings.preset];
    const dpr = Math.min(window.devicePixelRatio || 1, g.maxPixelRatio);
    const w = window.innerWidth, hgt = window.innerHeight;
    if (force) { this.rw.post.resize(1, 1); }
    this.rw.resize(w, hgt, dpr);
  }

  setSettings(s: Settings): void {
    const presetChanged = s.preset !== this.settings.preset;
    this.settings = s;
    saveSettings(s);
    this.audio.applySettings(s);
    if (presetChanged) this.applyGraphics();
    this.rw.post.settings.exposureComp = s.exposureComp;
    if (this.flight) this.flight.applySettings(s);
  }

  // ------------------------------------------------------------------------------ menu

  showMenu(): void {
    this.flight = null;
    this.rw.setComplex(null, null);
    this.rw.vessels.clear();
    this.rw.plumes.clear();
    this.rw.effects.clear();
    this.rw.aero.clear();
    this.rw.zones.clear();
    this.rw.post.settings.letterbox = 0;
    this.system.setEpoch(this.menuTime0);
    this.menuT = 0;
    this.rw.post.settings.autoExposure = true;
    this.menu = new MainMenu(this);
    this.audio.setScene('menu');
  }

  startFlight(opts: FlightLaunchOptions): void {
    this.menu?.dispose();
    this.menu = null;
    // never stack two flights (and their HUDs / debriefs)
    this.flight?.dispose();
    this.flight = null;
    this.audio.setScene('flight');
    this.flight = new FlightController(this, opts);
  }

  /** Leave the current flight and start another (retry / next mission). */
  endFlightTo(opts: FlightLaunchOptions): void {
    this.flight?.dispose();
    this.flight = null;
    this.startFlight(opts);
  }

  endFlight(): void {
    this.flight?.dispose();
    this.flight = null;
    this.showMenu();
  }

  private renderMenuBackdrop(dt: number): void {
    // orbital sunrise over the Atlantic: the Earth still in night below, the limb glowing,
    // the Sun climbing out of the atmosphere as the camera drifts
    this.menuT += dt;
    const rw = this.rw;
    const t = this.menuTime0 + this.menuT * 2.5;
    const earth = this.system.earth;
    const rot = new Quaternion();
    earth.orientationAt(t, rot);
    const ep = earth.globalPositionAt(t, new Vector3());
    const lat = (15 + Math.sin(this.menuT * 0.013) * 1.5) * Math.PI / 180;
    const lon = (-30 + this.menuT * 0.004) * Math.PI / 180;
    const up = new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    const north = new Vector3(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat));
    const east = new Vector3().crossVectors(north, up);
    const alt = 900_000;
    const posFixed = up.clone().multiplyScalar(earth.radius + alt);
    rw.cameraHelio.copy(posFixed).applyQuaternion(rot).add(ep);
    const hd = (75 + Math.sin(this.menuT * 0.02) * 4) * Math.PI / 180, pt = -18 * Math.PI / 180;
    const fwd = north.clone().multiplyScalar(Math.cos(hd) * Math.cos(pt)).addScaledVector(east, Math.sin(hd) * Math.cos(pt)).addScaledVector(up, Math.sin(pt)).normalize().applyQuaternion(rot);
    const camUp = up.clone().applyQuaternion(rot);
    const m = new Matrix4().lookAt(new Vector3(), fwd, camUp);
    rw.camera.quaternion.setFromRotationMatrix(m);
    if (rw.camera.fov !== 50) { rw.camera.fov = 50; rw.camera.updateProjectionMatrix(); }
    rw.focusHelio.copy(rw.cameraHelio);
    rw.update(t, dt);
    rw.render(dt);
  }

  private frame = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    try {
      if (this.flight) this.flight.frame(dt);
      else this.renderMenuBackdrop(dt);
      this.audio.update(dt);
    } catch (e) {
      console.error(e);
      (window as any).__state = { ...(window as any).__state, error: String((e as Error).stack ?? e) };
    }
    const st = (window as any).__state ?? ((window as any).__state = { frames: 0 });
    st.frames = (st.frames ?? 0) + 1;
    st.ready = this.rw.earth.ready && this.rw.earth.stats.pending === 0;
    st.screen = this.flight ? 'flight' : 'menu';
    requestAnimationFrame(this.frame);
  };

  /** Automation hooks for the headless test harness. */
  private installDebugApi(): void {
    const w = window as any;
    w.__app = this;
    w.__ascent = {
      startMission: (id: string) => this.startFlight({ missionId: id }),
      startSandbox: (o: Partial<FlightLaunchOptions>) => this.startFlight({ ...o }),
      advance: (s: number, renderEvery?: number) => this.flight?.advance(s, renderEvery),
      session: () => this.flight?.session,
      flight: () => this.flight,
      shot: (id: string) => this.flight?.session.director.forceShot(id),
    };
  }
}

export async function startApp(canvas: HTMLCanvasElement): Promise<void> {
  const app = new App(canvas);
  await app.boot();
}
