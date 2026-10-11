// Fly a mission (scripted, rendering every few steps) and list every shader compiled after the
// flight's first frames: each is a hitch on a slow GPU when it first appears.
//   node scripts/compiles.mjs [missionId] [simSeconds] [preset]
import { chromium } from 'playwright-core';

const [, , mission = 'leo', simSecs = '700', preset = 'LOW'] = process.argv;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.addInitScript(() => {
  const w = window;
  w.__compiled = [];
  w.__track = false;
  for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
    const orig = C.prototype.compileShader;
    C.prototype.compileShader = function (sh) {
      if (w.__track) {
        const src = this.getShaderSource(sh) || '';
        const name = (src.match(/#define SHADER_NAME (.*)/) || [])[1] || '?';
        const uni = (src.match(/uniform [^;]* (u[A-Z]\w*)/g) || []).slice(0, 4).map((x) => x.split(' ').pop()).join(',');
        const s = w.__ascent?.session?.();
        w.__compiled.push(`${name}[${uni}] at MET ${s ? s.met.toFixed(0) : '?'} (${s?.phase})`);
      }
      return orig.call(this, sh);
    };
  }
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${process.env.APP_URL ?? 'http://127.0.0.1:5173/'}?preset=${preset}`, { waitUntil: 'load', timeout: 180000 });
for (let t0 = Date.now(); Date.now() - t0 < 300000;) {
  const s = await page.evaluate(() => window.__state).catch(() => null);
  if (s && (s.error || s.screen === 'menu')) break;
  await page.waitForTimeout(1000);
}
await page.evaluate((id) => window.__ascent.startMission(id), mission);
for (let t0 = Date.now(); Date.now() - t0 < 120000;) {
  const s = await page.evaluate(() => window.__state).catch(() => null);
  if (s && s.screen === 'flight' && s.frames > 5) break;
  await page.waitForTimeout(500);
}
// a few real frames (the prewarm runs on the first), then count from here
await page.waitForTimeout(3000);
await page.evaluate(() => { window.__track = true; });
let done = 0;
while (done < Number(simSecs)) {
  const r = await page.evaluate(() => { try { window.__ascent.advance(20, 6); return window.__ascent.flight()?.director?.result ?? 'running'; } catch (e) { return String(e); } });
  done += 20;
  if (r !== 'running') { console.log('flight ended:', r); break; }
}
const out = await page.evaluate(() => ({ compiled: window.__compiled, met: window.__ascent.session()?.met }));
console.log(JSON.stringify({ mission, preset, simulated: done, met: out.met, compilesAfterStart: out.compiled.length }));
for (const c of out.compiled) console.log('  ', c);
for (const e of errors.slice(0, 10)) console.log('[error]', e);
await browser.close();
