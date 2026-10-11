import type { App } from '../core/App';
import { MISSIONS, MissionDef } from '../game/missions';
import type { WeatherKind } from '../game/providers';
import { readSnapshot } from '../game/SaveGame';
import { ALL_VEHICLES, LAUNCHERS, vehicleStats } from '../vehicles/catalog';
import { LAUNCH_SITES } from '../world/sites';
import { h, hide, segmented, show } from './dom';
import { SettingsPanel } from './SettingsPanel';

/**
 * Main menu and its screens: missions (with briefings), sandbox setup (vehicle, site, time,
 * weather, orbit, recovery), continue a saved flight, settings, credits.
 */
export class MainMenu {
  private root: HTMLElement;
  private sub: HTMLElement | null = null;
  /** where Back (or Escape) leads from the open screen: a parent screen, or the menu itself */
  private back: (() => void) | null = null;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape' && this.sub) { e.preventDefault(); this.goBack(); }
  };

  constructor(readonly app: App) {
    const items = h('div', { class: 'items' });
    const add = (label: string, hint: string, fn: () => void) => {
      const it = h('div', { class: 'menu-item' }, label, h('span', { class: 'hint' }, hint));
      it.addEventListener('click', () => { app.audio.start(); app.audio.play('ui_select'); fn(); });
      it.addEventListener('mouseenter', () => app.audio.play('ui'));
      items.appendChild(it);
    };
    const snap = readSnapshot();
    if (snap) add('Continue', `${snap.vehicleId.toUpperCase()} · saved ${new Date(snap.savedAt).toLocaleString()}`, () => app.startFlight({ snapshot: snap, missionId: snap.missionId }));
    const firstOpen = MISSIONS.find((m) => !app.progress.completed[m.id]) ?? MISSIONS[0];
    add('Missions', `${Object.keys(app.progress.completed).length} of ${MISSIONS.length} complete · next: ${firstOpen.title}`, () => this.openMissions());
    add('Sandbox', 'Any rocket, any site, any time of day', () => this.openSandbox());
    add('Tutorial', 'First Light — learn to fly', () => this.openBriefing(MISSIONS[0]));
    add('Settings', 'Graphics, audio, controls', () => this.openSub(new SettingsPanel(app, () => this.closeSub()).root));
    add('Credits', 'Data, imagery and licences', () => this.openCredits());
    this.root = h('div', { id: 'menu', class: 'screen' },
      h('div', { class: 'logo' }, 'ASCENT'),
      h('div', { class: 'tag' }, 'A cinematic spaceflight simulator'),
      items,
      h('div', { class: 'foot' }, 'Real orbital mechanics · procedural everything · v1.0'),
    );
    app.ui.appendChild(this.root);
    show(this.root);
    window.addEventListener('keydown', this.onKey);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.sub?.remove();
    void hide(this.root);
  }

  /** Open a screen over the menu (the menu's own items step aside); `back` is where Back leads. */
  private openSub(el: HTMLElement, back: (() => void) | null = null): void {
    this.closeSub();
    this.sub = el;
    this.back = back;
    el.classList.add('screen');
    this.root.classList.add('sub-open');
    this.app.ui.appendChild(el);
    show(el);
  }

  private closeSub(): void {
    if (this.sub) { void hide(this.sub); this.sub = null; }
    this.back = null;
    this.root.classList.remove('sub-open');
  }

  private goBack(): void {
    this.app.audio.play('ui');
    const back = this.back;
    if (back) back(); else this.closeSub();
  }

  private closeButton(): HTMLElement {
    const b = h('button', { class: 'btn close' }, 'Back');
    b.addEventListener('click', () => this.goBack());
    return b;
  }

  // ------------------------------------------------------------------------------ missions

  private openMissions(): void {
    const grid = h('div', { class: 'grid' });
    for (const m of MISSIONS) {
      const done = this.app.progress.completed[m.id];
      const card = h('div', { class: 'card' },
        h('div', { class: 'num' }, `MISSION ${String(m.number).padStart(2, '0')}`),
        h('h3', {}, m.title),
        h('p', {}, m.subtitle),
        h('div', { class: 'meta' }, ...m.tags.map((t) => h('span', { class: 'chip' }, t))),
        done ? h('div', { class: 'done' }, `✓ ${done.score}`) : null,
      );
      card.addEventListener('click', () => { this.app.audio.play('ui_select'); this.openBriefing(m, true); });
      grid.appendChild(card);
    }
    this.openSub(h('div', { class: 'overlay' }, h('h1', {}, 'Missions'), h('div', { class: 'crumb' }, 'From a first hop to the edge of space to Jupiter'), grid, this.closeButton()));
  }

  private openBriefing(m: MissionDef, fromList = false): void {
    const v = ALL_VEHICLES.find((x) => x.id === m.vehicle)!;
    const site = LAUNCH_SITES.find((x) => x.id === m.site)!;
    const st = vehicleStats(v);
    const row = (k: string, val: string) => h('div', { class: 'stat-row' }, h('span', {}, k), h('span', {}, val));
    const ul = h('ul', { class: 'objectives' });
    for (const o of m.objectives) ul.appendChild(h('li', {}, o.text + (o.optional ? ' (bonus)' : '')));
    const start = h('button', { class: 'btn primary', style: 'margin-top:24px' }, m.start === 'pad' ? 'Go to the pad' : 'Begin');
    start.addEventListener('click', () => { this.app.audio.play('ui_select'); this.app.startFlight({ missionId: m.id }); });
    const where = m.start === 'pad' ? `${site.name}, ${site.region}` : m.start === 'lunarOrbit' ? 'Lunar orbit, 100 km' : m.start === 'moonSurface' ? 'Sea of Tranquility, the Moon' : m.start === 'jupiterApproach' ? 'Jupiter approach' : 'Low Earth orbit';
    this.openSub(h('div', { class: 'overlay' },
      h('div', { class: 'crumb' }, `Mission ${String(m.number).padStart(2, '0')} · ${m.subtitle}`),
      h('h1', {}, m.title),
      h('div', { class: 'two-col', style: 'margin-top:18px' },
        h('div', {}, h('p', { class: 'brief' }, m.briefing), h('div', { class: 'label', style: 'margin-top:22px' }, 'Objectives'), ul, start),
        h('div', {},
          h('div', { class: 'label' }, 'Vehicle'),
          h('h3', { style: 'font-family:var(--cond);letter-spacing:.14em;font-size:26px;margin:6px 0 2px' }, v.name),
          h('p', { class: 'brief', style: 'font-size:13.5px;color:var(--dim)' }, v.tagline),
          row('Class', v.vehicleClass), row('Height', `${st.height.toFixed(1)} m`), row('Liftoff mass', `${(st.mass / 1000).toFixed(0)} t`),
          row('Liftoff thrust', `${(st.thrustSL / 1e6).toFixed(1)} MN`), row('Stages', String(st.stages)),
          h('div', { class: 'label', style: 'margin-top:18px' }, 'Where & when'),
          row('Location', where), row('Date', new Date(m.date).toUTCString().replace(' GMT', ' UTC')), row('Weather', m.weather[0].toUpperCase() + m.weather.slice(1)),
        ),
      ),
      this.closeButton(),
    ), fromList ? () => this.openMissions() : null);
  }

  // ------------------------------------------------------------------------------ sandbox

  private openSandbox(): void {
    const cfg = { vehicle: 'kestrel9', site: 'cape', hour: 21.5, day: 7, weather: 'fair' as WeatherKind, orbit: 220, recovery: true, countdown: -60, start: 'pad' as 'pad' | 'leo' | 'entry' };
    const hasEntryCapsule = (id: string) => {
      const v = LAUNCHERS.find((x) => x.id === id)!;
      const sc = v.spacecraft ? v.assemblies.find((a) => a.id === v.spacecraft) : null;
      return !!sc?.features?.heatShield;
    };
    const detail = h('div', {});
    const list = h('div', { class: 'vehicle-list' });
    const renderDetail = () => {
      const v = LAUNCHERS.find((x) => x.id === cfg.vehicle)!;
      const st = vehicleStats(v);
      const row = (k: string, val: string) => h('div', { class: 'stat-row' }, h('span', {}, k), h('span', {}, val));
      detail.innerHTML = '';
      detail.append(
        h('h3', { style: 'font-family:var(--cond);letter-spacing:.14em;font-size:28px;margin:0 0 4px' }, v.name),
        h('div', { class: 'label', style: 'color:var(--amber)' }, v.vehicleClass),
        h('p', { class: 'brief', style: 'font-size:14px;margin-top:10px' }, v.description),
        row('Inspired by', v.analog), row('Height', `${st.height.toFixed(1)} m`), row('Diameter', `${st.width.toFixed(1)} m`), row('Liftoff mass', `${(st.mass / 1000).toFixed(0)} t`),
        row('Liftoff thrust', `${(st.thrustSL / 1e6).toFixed(1)} MN`), row('Payload to LEO', `${(v.payloadLEO / 1000).toFixed(1)} t`),
        row('Recovery', v.assemblies.some((a) => a.recovery && a.recovery !== 'none') ? 'Reusable boosters' : 'Expendable'),
      );
    };
    for (const v of LAUNCHERS) {
      const r = h('div', { class: `row${v.id === cfg.vehicle ? ' on' : ''}` }, h('b', {}, v.name), h('small', {}, v.vehicleClass));
      r.addEventListener('click', () => {
        cfg.vehicle = v.id;
        for (const x of Array.from(list.children)) x.classList.remove('on');
        r.classList.add('on');
        // sensible defaults per vehicle
        if (v.id === 'leviathan') cfg.site = 'boca';
        else if (v.id === 'vostok') cfg.site = 'baikonur';
        else if (cfg.site === 'boca' || cfg.site === 'baikonur') cfg.site = 'cape';
        siteSeg.replaceWith(siteSeg = makeSiteSeg());
        if (cfg.start === 'entry' && !hasEntryCapsule(v.id)) cfg.start = 'pad';
        startSeg.replaceWith(startSeg = makeStartSeg());
        updateGo();
        renderDetail();
        this.app.audio.play('ui');
      });
      list.appendChild(r);
    }
    // more vehicles below the fold: fade the list's lower edge until it is scrolled to the end
    const moreBelow = () => list.classList.toggle('more', list.scrollTop + list.clientHeight < list.scrollHeight - 4);
    list.addEventListener('scroll', moreBelow);
    requestAnimationFrame(moreBelow);
    const makeSiteSeg = () => segmented(LAUNCH_SITES.map((s) => ({ value: s.id, label: s.name })), cfg.site, (x) => { cfg.site = x; });
    let siteSeg = makeSiteSeg();
    const hourVal = h('span', { class: 'value', style: 'font-size:13px' });
    const hour = h('input', { type: 'range', min: 0, max: 23.75, step: 0.25, value: cfg.hour });
    const fmtHour = () => { const s = LAUNCH_SITES.find((x) => x.id === cfg.site)!; const local = (cfg.hour + s.lon / 15 + 24) % 24; hourVal.textContent = `${String(Math.floor(cfg.hour)).padStart(2, '0')}:${String(Math.round((cfg.hour % 1) * 60)).padStart(2, '0')} UTC · ~${String(Math.floor(local)).padStart(2, '0')}:${String(Math.round((local % 1) * 60)).padStart(2, '0')} solar time`; };
    hour.addEventListener('input', () => { cfg.hour = Number(hour.value); fmtHour(); });
    fmtHour();
    const orbitVal = h('span', { class: 'value', style: 'font-size:13px' }, `${cfg.orbit} km`);
    const orbit = h('input', { type: 'range', min: 160, max: 600, step: 10, value: cfg.orbit });
    orbit.addEventListener('input', () => { cfg.orbit = Number(orbit.value); orbitVal.textContent = `${cfg.orbit} km`; });
    const go = h('button', { class: 'btn primary', style: 'margin-top:20px' }, 'Roll out to the pad');
    const updateGo = () => { go.textContent = cfg.start === 'pad' ? 'Roll out to the pad' : cfg.start === 'leo' ? 'Begin in orbit' : 'Begin at entry interface'; };
    const makeStartSeg = () => {
      const opts = [{ value: 'pad', label: 'Launch pad' }, { value: 'leo', label: 'Earth orbit' }];
      if (hasEntryCapsule(cfg.vehicle)) opts.push({ value: 'entry', label: 'Entry interface' });
      return segmented(opts, cfg.start, (x) => { cfg.start = x as typeof cfg.start; updateGo(); });
    };
    let startSeg = makeStartSeg();
    go.addEventListener('click', () => {
      this.app.audio.play('ui_select');
      const hh = Math.floor(cfg.hour), mm = Math.round((cfg.hour % 1) * 60);
      const date = new Date(Date.UTC(2026, 9, cfg.day, hh, mm, 0));
      this.app.startFlight({
        vehicleId: cfg.vehicle, siteId: cfg.site, date, weather: cfg.weather, targetOrbit: cfg.orbit * 1000, recovery: cfg.recovery, countdownStart: cfg.countdown,
        start: cfg.start,
      });
    });
    renderDetail();
    const field = (label: string, el: HTMLElement, extra?: HTMLElement) => h('div', { class: 'field' }, h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' }, h('span', { class: 'label' }, label), extra ?? ''), el);
    this.openSub(h('div', { class: 'overlay' },
      h('h1', {}, 'Sandbox'), h('div', { class: 'crumb' }, 'Choose a vehicle, a place and a moment'),
      h('div', { class: 'two-col' },
        h('div', { style: 'display:grid;grid-template-columns:minmax(220px,0.8fr) 1fr;gap:28px' }, list, detail),
        h('div', {},
          field('Begin at', startSeg),
          field('Launch site', siteSeg),
          field('Time of day', hour, hourVal),
          field('Weather', segmented([{ value: 'clear', label: 'Clear' }, { value: 'fair', label: 'Fair' }, { value: 'breezy', label: 'Breezy' }, { value: 'overcast', label: 'Overcast' }, { value: 'storm', label: 'Storm' }], cfg.weather, (x) => { cfg.weather = x as WeatherKind; })),
          field('Target orbit', orbit, orbitVal),
          field('Booster recovery', segmented([{ value: 'on', label: 'Fly home' }, { value: 'off', label: 'Expend' }], 'on', (x) => { cfg.recovery = x === 'on'; })),
          field('Countdown', segmented([{ value: '-120', label: 'T-2:00' }, { value: '-60', label: 'T-1:00' }, { value: '-15', label: 'T-0:15' }], String(cfg.countdown), (x) => { cfg.countdown = Number(x); })),
          go,
        ),
      ),
      this.closeButton(),
    ));
  }

  // ------------------------------------------------------------------------------ credits

  private openCredits(): void {
    const p = (t: string) => h('p', { class: 'brief', style: 'margin:6px 0' }, t);
    this.openSub(h('div', { class: 'overlay' },
      h('h1', {}, 'Credits'), h('div', { class: 'crumb' }, 'Everything here is original or used under its licence'),
      h('div', { class: 'two-col' },
        h('div', {},
          h('div', { class: 'label' }, 'Imagery & data'),
          p('Earth surface and relief, Jupiter\'s moons, Tycho star map: NASA (public domain).'),
          p('Earth night lights & clouds, Moon and planet maps: Solar System Scope textures, CC BY 4.0 (© INOVE).'),
          p('Star positions: Yale Bright Star Catalogue (public domain).'),
          p('Orbits: JPL approximate planetary elements (Standish); lunar elements after Meeus. Atmosphere: U.S. Standard Atmosphere 1976. Entry heating: Sutton–Graves and Tauber–Sutton correlations. Sky: after Hillaire (EGSR 2020).'),
        ),
        h('div', {},
          h('div', { class: 'label' }, 'Sound & type'),
          p('Mission-control voices synthesised for this project with Kokoro-82M (Apache-2.0). All music and effects are generated live with the Web Audio API.'),
          p('Fonts: Barlow family and JetBrains Mono, SIL Open Font Licence.'),
          p('Rendering: three.js (MIT).'),
          p('All vehicle names, liveries and logos are fictional; performance figures follow the public data of the real vehicles they are modelled on.'),
        ),
      ),
      this.closeButton(),
    ));
  }
}
