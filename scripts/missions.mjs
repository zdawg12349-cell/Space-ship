// Fly missions end to end in the real app, headless and without screenshots:
//   node scripts/missions.mjs [missionId ...]
// Each plan is a list of steps run in the page: {advance: seconds} (simulation, 1/30 s steps),
// {nav: 'plan_deorbit'} (the HUD's manoeuvre buttons), {stage: true}, {warp: index},
// {until: 'js condition', max: seconds} (advance in 10 s chunks), {wait: ms}.
import { chromium } from 'playwright-core';

const PLANS = {
  first_light: [{ until: 'r() !== "running"', max: 900 }],
  leo: [{ until: 'ph() === "orbit"', max: 900 }, { advance: 20 }, { stage: true }, { until: 'r() !== "running"', max: 600 }],
  rtls: [{ until: 'r() !== "running"', max: 1200 }],
  heavy: [{ until: 'r() !== "running"', max: 1200 }],
  night: [{ until: 'r() !== "running"', max: 1200 }],
  crew: [
    { until: 'ph() === "orbit"', max: 900 }, { advance: 30 },
    { nav: 'plan_deorbit' }, { nav: 'execute' }, { until: 'ap().mode !== "node"', max: 900 },
    { warp: 6 }, { until: 'ph() === "entry" || r() !== "running"', max: 120 }, { warp: 0 },
    { until: 'r() !== "running"', max: 1500 },
  ],
  superheavy: [{ until: 'r() !== "running"', max: 1500 }],
  flyby: [
    { until: 'ph() === "orbit"', max: 1200 }, { advance: 20 },
    { nav: 'plan_tli' }, { wait: 6000 }, { nav: 'execute' }, { until: 'ap().mode !== "node"', max: 7000 },
    { advance: 30 }, { warp: 6 }, { advance: 20 }, { warp: 0 },
    { nav: 'plan_mcc' }, { nav: 'execute' }, { until: 'ap().mode !== "node"', max: 1200 },
    { nav: 'warp_event' }, { until: 'v().body.id === "moon" || r() !== "running"', max: 600 },
    { warp: 7 }, { until: 'r() !== "running"', max: 300 },
  ],
  landing: [{ nav: 'land' }, { until: 'r() !== "running"', max: 4000 }],
  homeward: [
    { nav: 'ascend' }, { until: 'ap().mode === "stability" || r() !== "running"', max: 1500 }, { advance: 20 },
    { nav: 'plan_tei' }, { nav: 'execute' }, { until: 'ap().mode !== "node"', max: 9000 },
    { advance: 30 }, { warp: 7 }, { until: 'ph() === "entry" || r() !== "running"', max: 600 }, { warp: 0 },
    { until: 'r() !== "running"', max: 1500 },
  ],
  jupiter: [{ nav: 'plan_joi' }, { nav: 'execute' }, { until: 'ap().mode !== "node" || r() !== "running"', max: 2000 }, { advance: 30 }, { until: 'r() !== "running"', max: 200 }],
};

const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PLANS);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(0);
await page.goto(`${process.env.APP_URL ?? 'http://127.0.0.1:5173/'}?preset=LOW`, { waitUntil: 'load', timeout: 180000 });
for (let i = 0; i < 300; i++) {
  const s = await page.evaluate(() => window.__state).catch(() => null);
  if (s && (s.error || s.screen === 'menu')) break;
  await page.waitForTimeout(1000);
}
// helpers available to conditions
await page.evaluate(() => {
  const A = window.__ascent;
  window.__h = {
    s: () => A.session(), f: () => A.flight(), v: () => A.session().active, ph: () => A.session().phase,
    r: () => A.flight().director.result, ap: () => A.session().autopilot,
  };
});
const summary = [];
for (const id of ids) {
  const t0 = Date.now();
  await page.evaluate((m) => window.__ascent.startMission(m), id);
  await page.waitForTimeout(1500);
  const log = [];
  for (const st of PLANS[id] ?? []) {
    if (st.advance) await page.evaluate((s) => window.__ascent.advance(s), st.advance);
    if (st.wait) await page.waitForTimeout(st.wait);
    if (st.stage) await page.evaluate(() => window.__h.s().stageNow());
    if (st.warp !== undefined) await page.evaluate((w) => window.__h.s().setWarp(w), st.warp);
    if (st.nav) {
      const r = await page.evaluate((n) => { const f = window.__h.f(); f.forecastTimer = 0; f.updateNav(1); f.navAction(n); return f.session.autopilot.node ? `${f.session.autopilot.node.label} ${f.session.autopilot.node.dv.length().toFixed(0)} m/s · ${f.session.autopilot.node.result}` : `mode ${f.session.autopilot.mode}`; }, st.nav).catch((e) => String(e));
      log.push(`nav ${st.nav}: ${r}`);
    }
    if (st.until) {
      const res = await page.evaluate(({ cond, max }) => {
        const { s, f, v, ph, r, ap } = window.__h;
        void s; void f; void v; void ph; void r; void ap;
        const test = new Function('s', 'f', 'v', 'ph', 'r', 'ap', `return (${cond});`);
        let waited = 0;
        while (waited < max && !test(s, f, v, ph, r, ap)) { window.__ascent.advance(10); waited += 10; }
        return waited;
      }, { cond: st.until, max: st.max });
      log.push(`until ${st.until} after ${res} s`);
    }
  }
  const out = await page.evaluate(() => {
    const f = window.__h.f(), s = f.session, v = s.active, d = f.director;
    return {
      result: d.result, reason: d.failReason, phase: s.phase, met: Math.round(s.met), body: v.body.id,
      alt: Math.round(v.telemetry.altitude), objectives: d.objectives.map((o) => `${o.state === 'done' ? '✓' : o.state === 'failed' ? '✗' : '·'} ${o.text}`),
      boosters: s.boosters.map((b) => `${b.zone.id}:${b.v.landed ? 'landed' : b.v.destroyed ? 'lost (' + b.v.destroyReason + ')' : b.g.phase}`),
      stats: { maxAlt: Math.round(d.stats.maxAltitude / 1000), touchdown: d.stats.touchdownSpeed, moon: Math.round(d.stats.minMoonDistance / 1000) },
    };
  });
  const line = `${id}: ${out.result.toUpperCase()} ${out.reason ? '(' + out.reason + ')' : ''} phase=${out.phase} MET=${out.met}s body=${out.body} alt=${out.alt}m [${((Date.now() - t0) / 1000).toFixed(0)} s real]\n    ${out.objectives.join('\n    ')}${out.boosters.length ? '\n    boosters: ' + out.boosters.join(', ') : ''}\n    stats ${JSON.stringify(out.stats)}\n    ${log.join('\n    ')}`;
  console.log(line);
  summary.push(line);
  await page.evaluate(() => window.__ascent.flight()?.app.endFlight());
  await page.waitForTimeout(1000);
}
for (const e of errors.slice(0, 20)) console.log('[pageerror]', e);
await browser.close();
