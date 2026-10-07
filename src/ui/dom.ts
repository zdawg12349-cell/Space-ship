/** Tiny DOM helpers (no framework). */

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement): void { while (el.firstChild) el.removeChild(el.firstChild); }

/** Show a screen with a fade. */
export function show(el: HTMLElement): void { requestAnimationFrame(() => el.classList.add('visible')); }

export function hide(el: HTMLElement, remove = true): Promise<void> {
  el.classList.remove('visible');
  return new Promise((res) => setTimeout(() => { if (remove) el.remove(); res(); }, 600));
}

/** Segmented control. */
export function segmented<T extends string>(options: { value: T; label: string }[], current: T, onChange: (v: T) => void): HTMLElement {
  const wrap = h('div', { class: 'seg' });
  const btns = options.map((o) => {
    const b = h('button', { class: o.value === current ? 'on' : '' }, o.label);
    b.addEventListener('click', () => {
      for (const x of btns) x.classList.remove('on');
      b.classList.add('on');
      onChange(o.value);
    });
    wrap.appendChild(b);
    return b;
  });
  return wrap;
}

export function fmtDist(m: number): [string, string] {
  const a = Math.abs(m);
  if (a < 10_000) return [m.toFixed(0), 'm'];
  if (a < 1e7) return [(m / 1000).toFixed(a < 1e5 ? 2 : 1), 'km'];
  if (a < 1e10) return [(m / 1e6).toFixed(2), 'Mm'];
  return [(m / 1.495978707e11).toFixed(3), 'AU'];
}

export function fmtSpeed(ms: number): [string, string] {
  return Math.abs(ms) < 10_000 ? [ms.toFixed(0), 'm/s'] : [(ms / 1000).toFixed(2), 'km/s'];
}

export function fmtTime(s: number): string {
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(s);
  const d = Math.floor(a / 86400), hh = Math.floor((a % 86400) / 3600), mm = Math.floor((a % 3600) / 60), ss = Math.floor(a % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return d > 0 ? `${sign}${d}d ${p(hh)}:${p(mm)}:${p(ss)}` : `${sign}${p(hh)}:${p(mm)}:${p(ss)}`;
}
