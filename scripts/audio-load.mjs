// Measure the audio graph's processing cost offline (old vs new reverb lengths) and the output
// latency each latency hint gives: node scripts/audio-load.mjs
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.goto('about:blank');
const r = await page.evaluate(async () => {
  const ir = (ctx, sec, decay) => {
    const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
    return b;
  };
  // the game's always-running graph: 14 looping noise sources through filters, plus the two reverbs
  const run = async (sfxSec, musicSec) => {
    const sr = 48000, len = sr * 20;
    const ctx = new OfflineAudioContext(2, len, sr);
    const noise = ctx.createBuffer(1, sr * 4, sr); const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const sfx = ctx.createGain(); sfx.connect(ctx.destination);
    const rev = ctx.createConvolver(); rev.buffer = ir(ctx, sfxSec, 3); const send = ctx.createGain(); send.connect(rev).connect(sfx);
    const mrev = ctx.createConvolver(); mrev.buffer = ir(ctx, musicSec, 2.6); const mbus = ctx.createGain(); mbus.connect(mrev).connect(ctx.destination);
    for (let i = 0; i < 14; i++) {
      const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true;
      const f = ctx.createBiquadFilter(); f.frequency.value = 300 + i * 200; const g = ctx.createGain(); g.gain.value = 0.05;
      s.connect(f).connect(g).connect(sfx); if (i < 4) g.connect(send); s.start();
    }
    for (let i = 0; i < 3; i++) { const o = ctx.createOscillator(); o.frequency.value = 55 * (i + 1); const g = ctx.createGain(); g.gain.value = 0.05; o.connect(g).connect(mbus); o.start(); }
    const t0 = performance.now(); await ctx.startRendering(); return performance.now() - t0;
  };
  const old = [], neu = [];
  for (let k = 0; k < 3; k++) { old.push(await run(3.5, 5.5)); neu.push(await run(2.2, 3.0)); }
  const lat = {};
  for (const hint of ['interactive', 'playback']) { const c = new AudioContext({ latencyHint: hint }); lat[hint] = { base: c.baseLatency, output: c.outputLatency }; await c.close(); }
  return { oldMs: old.map((x) => x | 0), newMs: neu.map((x) => x | 0), latency: lat };
});
console.log(JSON.stringify(r));
await browser.close();
