import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage();
const info = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return 'no webgl2';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    exts: gl.getSupportedExtensions(),
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    max3D: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
    samples: gl.getParameter(gl.MAX_SAMPLES),
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
