// Listen to a launch the way a player would: run the game in real time and log, once a second,
// how loud the final output is over the full band and over the band small laptop speakers can
// play (above ~300 Hz), the master compressor's gain reduction (the first compressor made), and what the camera is doing.
//   node scripts/audio-probe.mjs [missionId] [seconds] [preset] [startMET] [draw]
// (draw=0 skips the GPU work so a software renderer keeps the flight running in real time)
// Run it against the dev server (scripts/with-server.sh).
import { chromium } from 'playwright-core';

const [, , mission = 'leo', secs = '120', preset = 'LOW', startMet = '-12', draw = '0'] = process.argv;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.addInitScript(() => {
  const w = window;
  w.__comps = [];
  w.__taps = null;
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = origConnect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      const ctx = this.context;
      if (!w.__taps) {
        const full = ctx.createAnalyser(); full.fftSize = 4096;
        const h1 = ctx.createBiquadFilter(); h1.type = 'highpass'; h1.frequency.value = 300;
        const h2 = ctx.createBiquadFilter(); h2.type = 'highpass'; h2.frequency.value = 300;
        const spk = ctx.createAnalyser(); spk.fftSize = 4096;
        h1.connect(h2); origConnect.call(h2, spk);
        w.__taps = { full, h1, spk, buf: new Float32Array(4096) };
      }
      origConnect.call(this, w.__taps.full);
      origConnect.call(this, w.__taps.h1);
    }
    return r;
  };
  const origComp = BaseAudioContext.prototype.createDynamicsCompressor;
  BaseAudioContext.prototype.createDynamicsCompressor = function () { const c = origComp.call(this); w.__comps.push(c); return c; };
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${process.env.APP_URL ?? 'http://127.0.0.1:5173/'}?preset=${preset}`, { waitUntil: 'load', timeout: 180000 });
for (let t0 = Date.now(); Date.now() - t0 < 300000;) {
  const s = await page.evaluate(() => window.__state).catch(() => null);
  if (s && (s.error || s.screen === 'menu')) break;
  await page.waitForTimeout(1000);
}
await page.evaluate(() => window.__app.audio.start());
await page.evaluate((id) => window.__ascent.startMission(id), mission);
for (let t0 = Date.now(); Date.now() - t0 < 120000;) {
  const s = await page.evaluate(() => window.__state).catch(() => null);
  if (s && s.screen === 'flight' && s.frames > 5) break;
  await page.waitForTimeout(500);
}
if (draw === '0') await page.evaluate(() => { window.__app.rw.render = () => undefined; });
const met0 = await page.evaluate(() => window.__ascent.session().met);
if (Number(startMet) > met0) await page.evaluate((s) => window.__ascent.advance(s, 15), Number(startMet) - met0);
// sample every animation frame, report per second
await page.evaluate(() => {
  const w = window;
  // per-bus levels (effects, music, voice), after their volume settings
  const a0 = w.__app.audio;
  w.__bus = {};
  for (const k of ['sfx', 'musicBus', 'voiceBus']) { const an = a0.ctx.createAnalyser(); an.fftSize = 4096; a0[k].connect(an); w.__bus[k] = an; }
  const db = (an) => { an.getFloatTimeDomainData(w.__taps.buf); let s = 0; for (const x of w.__taps.buf) s += x * x; return 10 * Math.log10(s / w.__taps.buf.length + 1e-12); };
  w.__log = [];
  let acc = null;
  const tick = () => {
    const a = w.__app.audio, s = w.__ascent.session();
    if (w.__taps && s) {
      const d = s.director;
      const e = a.engine;
      const now = a.ctx.currentTime;
      if (!acc) acc = { t: now, n: 0, full: 0, spk: 0, minSpk: 0, red: 0, sfx: 0, mus: 0, voc: -200 };
      const f = db(w.__taps.full), k = db(w.__taps.spk);
      acc.n++; acc.full += f; acc.spk += k; acc.minSpk = Math.min(acc.minSpk, k);
      acc.sfx += db(w.__bus.sfx); acc.mus += db(w.__bus.musicBus); acc.voc = Math.max(acc.voc, db(w.__bus.voiceBus));
      acc.red = Math.min(acc.red, w.__comps[0]?.reduction ?? 0);
      if (now - acc.t >= 1) {
        const ps = a.ctx.playoutStats;
        w.__log.push({
          met: s.met.toFixed(0), phase: s.phase, shot: d.shot?.id ?? '-', mount: d.mount,
          full: (acc.full / acc.n).toFixed(1), spk: (acc.spk / acc.n).toFixed(1), minSpk: acc.minSpk.toFixed(1), compRed: acc.red.toFixed(1),
          sfx: (acc.sfx / acc.n).toFixed(0), mus: (acc.mus / acc.n).toFixed(0), voc: acc.voc.toFixed(0),
          engOut: e ? e.out.gain.value.toFixed(3) : '-', onb: e ? e.onboard.gain.value.toFixed(3) : '-', delay: e?.delay ? e.delay.delayTime.value.toFixed(2) : (Number.isFinite(a.heardT) ? (a.time - a.heardT).toFixed(2) : '-'),
          dist: Math.round(w.__app.flight?.session?.director ? (() => { const v = s.active; return v.pos.clone().add(s.bodyPos(v.body)).distanceTo(d.posHelio); })() : 0),
          glitch: ps ? `${ps.fallbackFramesEvents ?? '?'}/${(ps.fallbackDuration ?? 0).toFixed?.(0) ?? ''}` : 'n/a',
          fps: (acc.n / (now - acc.t)).toFixed(0),
        });
        acc = null;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(Number(secs) * 1000);
const log = await page.evaluate(() => window.__log);
console.log(JSON.stringify({ mission, preset, sampleRate: await page.evaluate(() => window.__app.audio.ctx.sampleRate), baseLatency: await page.evaluate(() => window.__app.audio.ctx.baseLatency) }));
console.log(' met phase      shot              mount   camDist  full   spk minSpk compRed  sfx  mus  voc engOut   onb  delay fps');
for (const r of log) console.log([r.met.padStart(4), r.phase.padEnd(10), String(r.shot).padEnd(17), r.mount.padEnd(7), String(r.dist).padStart(7), r.full.padStart(5), r.spk.padStart(5), r.minSpk.padStart(6), r.compRed.padStart(6), r.sfx.padStart(4), r.mus.padStart(4), r.voc.padStart(4), r.engOut.padStart(6), r.onb.padStart(6), r.delay.padStart(6), r.fps].join(' '));
for (const e of errors.slice(0, 10)) console.log('[error]', e);
await browser.close();
