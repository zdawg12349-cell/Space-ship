// Evaluate a JS snippet in the running debug page once ready: node scripts/probe.mjs "<query>" snippet.js [waitMs]
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const [, , query, file, waitMs = '120000'] = process.argv;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:5173/?${query}&w=960&h=540`, { waitUntil: 'load' });
const t0 = Date.now();
while (Date.now() - t0 < Number(waitMs)) {
  const s = await page.evaluate(() => window.__state).catch(() => null);
  if (s && (s.error || (s.ready && s.frames > 8))) break;
  await page.waitForTimeout(500);
}
const out = await page.evaluate(readFileSync(file, 'utf8'));
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 0));
await browser.close();
