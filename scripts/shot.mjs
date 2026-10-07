// Headless screenshot harness: node scripts/shot.mjs "<query>" out.png [waitMs] [w] [h]
import { chromium } from 'playwright-core';
const [, , query = 'debug=view', out = 'shot.png', waitMs = '60000', w = '960', h = '540'] = process.argv;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const url = `http://127.0.0.1:5173/?${query}&w=${w}&h=${h}`;
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
const t0 = Date.now();
let state = null;
while (Date.now() - t0 < Number(waitMs)) {
  state = await page.evaluate(() => window.__state).catch(() => null);
  if (state && (state.error || (state.ready && state.frames > 8))) break;
  await page.waitForTimeout(500);
}
// a few more frames for exposure adaptation
const f0 = state?.frames ?? 0;
const t1 = Date.now();
while (Date.now() - t1 < 20000) {
  const s = await page.evaluate(() => window.__state).catch(() => null);
  if (s && s.frames >= f0 + 6) { state = s; break; }
  await page.waitForTimeout(300);
}
// freeze the render loop so the compositor can capture a stable frame
await page.evaluate(() => { window.__freeze = true; }).catch(() => undefined);
await page.waitForTimeout(1500);
await page.screenshot({ path: out, timeout: 180000 });
console.log(JSON.stringify({ state, elapsed: Date.now() - t0 }));
for (const l of logs.slice(0, 30)) console.log(l);
await browser.close();
