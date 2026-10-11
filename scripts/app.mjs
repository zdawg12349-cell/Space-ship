// Drive the real app headlessly: node scripts/app.mjs outPrefix "<steps json>" [w] [h]
// steps: [{"menu":true}|{"mission":"leo"}|{"sandbox":{...}}|{"advance":s, "every"?:n}|{"until":"js cond","max":s}|{"shot":"name"}|{"eval":"js"}|{"key":"KeyC"}|{"wait":ms}
//          |{"nav":"plan_deorbit"}|{"warp":index}]
// (advance renders every 2nd 1/30 s step unless "every" says otherwise; until advances in 5 s chunks, rendering once a second
// unless its "every" says otherwise;
// conditions see s (session) and v (active vessel), and evals the helpers window.__h: s() f() v() ph() r() ap())
import { chromium } from 'playwright-core';
const [, , prefix = 'app', stepsJson = '[{"shot":"menu"}]', w = '1280', h = '720', query = ''] = process.argv;
const steps = JSON.parse(stepsJson);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${process.env.APP_URL ?? 'http://127.0.0.1:5173/'}?${query}`, { waitUntil: 'load', timeout: 120000 });
const waitReady = async (ms, minFrames = 4) => {
  const t0 = Date.now();
  const f0 = await page.evaluate(() => window.__state?.frames ?? 0).catch(() => 0);
  let s = null;
  while (Date.now() - t0 < ms) {
    s = await page.evaluate(() => window.__state).catch(() => null);
    if (s && s.error) break;
    if (s && s.ready && s.frames >= f0 + minFrames) break;
    await page.waitForTimeout(500);
  }
  return s;
};
// wait for the menu
{
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    const s = await page.evaluate(() => window.__state).catch(() => null);
    if (s && (s.error || s.screen === 'menu')) break;
    await page.waitForTimeout(1000);
  }
}
// helpers for conditions and evals (as in missions.mjs)
await page.evaluate(() => {
  const A = window.__ascent;
  window.__h = {
    s: () => A.session(), f: () => A.flight(), v: () => A.session().active, ph: () => A.session().phase,
    r: () => A.flight().director.result, ap: () => A.session().autopilot,
  };
});
let i = 0;
for (const st of steps) {
  if (st.mission) await page.evaluate((id) => window.__ascent.startMission(id), st.mission);
  if (st.sandbox) await page.evaluate((o) => window.__ascent.startSandbox(o), st.sandbox);
  if (st.advance) { const r = await page.evaluate(([s, n]) => window.__ascent.advance(s, n), [st.advance, st.every ?? 2]).catch((e) => String(e)); console.log('advance', st.advance, JSON.stringify(r)); }
  if (st.until) {
    const r = await page.evaluate(([cond, max, every]) => {
      const A = window.__ascent;
      const test = new Function('s', 'v', `return (${cond});`);
      let t = 0;
      while (t < max && !test(A.session(), A.session().active)) { A.advance(5, every); t += 5; }
      return { t, met: A.session().met, phase: A.session().phase, alt: A.session().active.telemetry.altitude | 0 };
    }, [st.until, st.max ?? 600, st.every ?? 30]).catch((e) => String(e));
    console.log('until', st.until, JSON.stringify(r));
  }
  if (st.warp !== undefined) await page.evaluate((w) => window.__h.s().setWarp(w), st.warp);
  if (st.nav) {
    const r = await page.evaluate((n) => { const f = window.__h.f(); f.forecastTimer = 0; f.updateNav(1); f.navAction(n); return f.session.autopilot.node ? `${f.session.autopilot.node.label} ${f.session.autopilot.node.dv.length().toFixed(0)} m/s` : `mode ${f.session.autopilot.mode}`; }, st.nav).catch((e) => String(e));
    console.log('nav', st.nav, r);
  }
  if (st.eval) { const r = await page.evaluate(st.eval).catch((e) => String(e)); console.log('eval', JSON.stringify(r)?.slice(0, 400)); }
  if (st.key) { await page.keyboard.press(st.key); await page.waitForTimeout(300); }
  if (st.click) { await page.click(st.click).catch((e) => console.log('click fail', String(e).slice(0, 200))); await page.waitForTimeout(800); }
  if (st.wait) await page.waitForTimeout(st.wait);
  if (st.shot) {
    // hold the simulation still while the terrain streams in for the capture
    await page.evaluate(() => { window.__freezeSim = true; });
    const s = await waitReady(st.timeout ?? 240000, st.frames ?? 4);
    await page.evaluate(() => { window.__freezeHud = true; });
    const file = `${prefix}_${String(i++).padStart(2, '0')}_${st.shot}.png`;
    await page.screenshot({ path: file, timeout: 180000 });
    console.log('shot', file, JSON.stringify({ screen: s?.screen, err: s?.error ? String(s.error).slice(0, 300) : null }));
    await page.evaluate(() => { window.__freezeSim = false; window.__freezeHud = false; });
  }
}
for (const l of logs.slice(0, 40)) console.log(l);
await browser.close();
