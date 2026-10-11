import type { App } from '../core/App';
import { GRAPHICS, GraphicsPreset, PRESETS, Settings } from '../game/Settings';
import { h, segmented } from './dom';

/** Settings overlay: graphics preset, audio levels, camera, interface. Changes apply live. */
export class SettingsPanel {
  readonly root: HTMLElement;

  constructor(readonly app: App, onClose: () => void) {
    const s: Settings = { ...app.settings };
    const commit = () => app.setSettings({ ...s });
    const slider = (label: string, key: keyof Settings, min: number, max: number, step: number) => {
      const val = h('span', { class: 'value', style: 'font-size:13px' }, String(s[key]));
      const input = h('input', { type: 'range', min, max, step, value: Number(s[key]) });
      input.addEventListener('input', () => { (s as unknown as Record<string, unknown>)[key] = Number(input.value); val.textContent = Number(input.value).toFixed(step < 1 ? 2 : 0); commit(); });
      return h('div', { class: 'field' }, h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' }, h('span', { class: 'label' }, label), val), input);
    };
    const toggle = (label: string, key: keyof Settings) => h('div', { class: 'field' }, h('span', { class: 'label' }, label),
      segmented([{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], s[key] ? 'on' : 'off', (v) => { (s as unknown as Record<string, unknown>)[key] = v === 'on'; commit(); }));
    const desc = h('p', { class: 'brief', style: 'font-size:13px;color:var(--dim);margin-top:10px' });
    const describe = (p: GraphicsPreset) => {
      const g = GRAPHICS[p];
      desc.textContent = `${Math.round(g.resolutionScale * 100)}% resolution · MSAA ${g.msaa || 'off'} · shadows ${g.shadows || 'off'} · ${g.particles.toLocaleString()} particles · terrain detail ${g.terrainDetail}` + (p === 'CINEMATIC' ? ' · heavier grain, vignette and lens character for film-like captures' : '');
    };
    describe(s.preset);
    const graphics = h('div', {},
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Graphics preset'),
        segmented(PRESETS.map((p) => ({ value: p, label: p })), s.preset, (p) => { s.preset = p as GraphicsPreset; describe(s.preset); commit(); }), desc),
      slider('Exposure compensation (EV)', 'exposureComp', -2, 2, 0.1),
      slider('Camera shake', 'shake', 0, 1.5, 0.05),
      toggle('Letterbox in cinematic camera', 'letterboxInCinematic'),
    );
    const audio = h('div', {},
      slider('Master volume', 'master', 0, 1, 0.01),
      slider('Music', 'music', 0, 1, 0.01),
      slider('Effects', 'sfx', 0, 1, 0.01),
      slider('Mission control voice', 'voice', 0, 1, 0.01),
      toggle('Engine sound in space', 'spaceSound'),
      toggle('Subtitles', 'subtitles'),
      toggle('Invert pitch', 'invertPitch'),
    );
    const close = h('button', { class: 'btn close' }, 'Done');
    close.addEventListener('click', onClose);
    this.root = h('div', { class: 'overlay' },
      h('h1', {}, 'Settings'), h('div', { class: 'crumb' }, 'Applied immediately · saved on this device'),
      h('div', { class: 'two-col' }, h('div', {}, h('div', { class: 'label', style: 'color:var(--amber);margin-bottom:14px' }, 'Graphics & camera'), graphics),
        h('div', {}, h('div', { class: 'label', style: 'color:var(--amber);margin-bottom:14px' }, 'Audio & controls'), audio)),
      close,
    );
  }
}
