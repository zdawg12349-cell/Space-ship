// Headless flight run: node scripts/flight.mjs "<query>" outPrefix "t1,t2,..." [w] [h]
// Advances the simulation to each mission time (MET, s; negative = countdown) and saves a screenshot.
import { chromium } from 'playwright-core';
const [, , query = 'debug=flight', prefix = 'flight', times = '-10,0,10', w = '960', h = '540', cuts = ''] = process.argv;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${process.env.APP_URL ?? 'http://127.0.0.1:5173/'}?${query}&w=${w}&h=${h}`, { waitUntil: 'load', timeout: 120000 });
const waitReady = async (minFrames, ms) => {
  const t0 = Date.now();
  let s = null;
  const f0 = (await page.evaluate(() => window.__state?.frames ?? 0).catch(() => 0));
  while (Date.now() - t0 < ms) {
    s = await page.evaluate(() => window.__state).catch(() => null);
    if (s && s.error) break;
    if (s && s.ready && s.frames >= f0 + minFrames) break;
    await page.waitForTimeout(400);
  }
  return s;
};
let s = await waitReady(3, 240000);
console.log('ready', JSON.stringify(s));
const cutList = cuts ? cuts.split(',') : [];
const list = times.split(',').map(Number);
for (let i = 0; i < list.length; i++) {
  const target = list[i];
  const met = await page.evaluate(() => window.__session.met);
  const dt = target - met;
  const t1 = Date.now();
  if (dt > 0) {
    const r = await page.evaluate((d) => window.__advance(d), dt).catch((e) => ({ error: String(e) }));
    console.log(`advance ${dt.toFixed(1)}s -> ${JSON.stringify(r)} (${((Date.now() - t1) / 1000).toFixed(0)}s)`);
  }
  if (cutList[i]) await page.evaluate((c) => window.__cut(c), cutList[i]);
  s = await waitReady(6, 300000);
  await page.evaluate(() => { window.__freeze = true; });
  await page.waitForTimeout(800);
  const file = `${prefix}_${String(i).padStart(2, '0')}_${target}.png`;
  await page.screenshot({ path: file, timeout: 180000 });
  await page.evaluate(() => { window.__freeze = false; });
  const info = await page.evaluate(() => ({ phase: window.__session.phase, met: window.__session.met, shot: window.__session.director.shotLabel, alt: window.__session.active.telemetry.altitude, err: window.__state.error }));
  console.log('shot', file, JSON.stringify(info));
  if (info.err) break;
}
const log = await page.evaluate(() => window.__log).catch(() => []);
console.log(log.join('\n'));
for (const l of logs.slice(0, 40)) console.log(l);
await browser.close();
