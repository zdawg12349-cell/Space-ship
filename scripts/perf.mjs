// Profile the running game in real time (the app's own frame loop, not scripted steps):
//   node scripts/perf.mjs [missionId] [seconds] [preset] [w] [h] [advanceFirst]
// Prints frame-time statistics, long main-thread tasks and the functions using the most CPU
// (self time) from a CPU profile of the main thread. Run it against the dev server
// (scripts/with-server.sh) so function names are readable.
import { chromium } from 'playwright-core';

const [, , mission = 'leo', secs = '25', preset = 'LOW', w = '800', h = '450', advanceFirst = '0'] = process.argv;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
// count shader compiles (a compile during play is a hitch on a slow GPU)
await page.addInitScript(() => {
  const w = window;
  w.__compiles = 0;
  for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
    const orig = C.prototype.compileShader;
    C.prototype.compileShader = function (sh) {
      w.__compiles++;
      if (w.__perf) {
        const src = this.getShaderSource(sh) || '';
        const name = (src.match(/#define SHADER_NAME (.*)/) || [])[1] || '?';
        const uni = (src.match(/uniform [^;]* (u[A-Z]\w*)/g) || []).slice(0, 4).map((x) => x.split(' ').pop()).join(',');
        (w.__perf.compiled ??= []).push(`${name}[${uni}] @${(performance.now() / 1000).toFixed(1)}s`);
      }
      return orig.call(this, sh);
    };
  }
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${process.env.APP_URL ?? 'http://127.0.0.1:5173/'}?preset=${preset}`, { waitUntil: 'load', timeout: 180000 });
for (let t0 = Date.now(); Date.now() - t0 < 300000;) {
  const s = await page.evaluate(() => window.__state).catch(() => null);
  if (s && (s.error || s.screen === 'menu')) break;
  await page.waitForTimeout(1000);
}
await page.evaluate((id) => window.__ascent.startMission(id), mission);
for (let t0 = Date.now(); Date.now() - t0 < 120000;) {
  const s = await page.evaluate(() => window.__state).catch(() => null);
  if (s && s.screen === 'flight') break;
  await page.waitForTimeout(500);
}
if (Number(advanceFirst) > 0) await page.evaluate((s) => window.__ascent.advance(s, 30), Number(advanceFirst));
// frame times from the page's own animation frames, and long tasks
await page.evaluate(() => {
  const w = window;
  w.__perf = { frames: [], long: [], compiles0: w.__compiles };
  let last = performance.now();
  const tick = (now) => { w.__perf.frames.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.long.push(e.duration); }).observe({ type: 'longtask', buffered: false });
});
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
await cdp.send('Profiler.start');
// STAGE=1: press the staging key (space) a second in, as a player would
if (process.env.STAGE) { await page.waitForTimeout(1000); await page.mouse.click(5, 5); await page.keyboard.press('Space'); }
await page.waitForTimeout(Number(secs) * 1000);
const { profile } = await cdp.send('Profiler.stop');
const perf = await page.evaluate(() => ({ ...window.__perf, compiles: window.__compiles - window.__perf.compiles0 }));
const st = await page.evaluate(() => { const s = window.__ascent.session(); return s ? { met: s.met, phase: s.phase, alt: s.active.telemetry.altitude | 0 } : { screen: window.__state?.screen, error: window.__state?.error }; });
// self time per function
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dts = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i]);
  const cf = n.callFrame;
  const key = `${cf.functionName || '(anon)'}  ${cf.url.split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dts[i] ?? 0) / 1000);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const f = perf.frames.slice(5).sort((a, b) => a - b);
const pct = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))]?.toFixed(0);
console.log(JSON.stringify({ mission, preset, size: `${w}x${h}`, state: st, frames: f.length, fps: (f.length / Number(secs)).toFixed(1),
  p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: f[f.length - 1]?.toFixed(0), over250ms: f.filter((x) => x > 250).length,
  longTasks: perf.long.length, longMax: Math.max(0, ...perf.long).toFixed(0), shaderCompilesDuringPlay: perf.compiles }));
console.log(`cpu sampled ${total.toFixed(0)} ms; top self time:`);
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28)) console.log(`${v.toFixed(0).padStart(7)} ms ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`);
for (const c of perf.compiled ?? []) console.log('[compiled during play]', c);
for (const e of errors.slice(0, 10)) console.log('[error]', e);
await browser.close();
