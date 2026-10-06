import {
  GLSL3, LinearMipmapLinearFilter, LinearFilter, NoBlending, RepeatWrapping, RGBAFormat, ShaderMaterial, UnsignedByteType, WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from './Fullscreen';

/**
 * GPU-generated tileable noise textures (perfectly periodic lattice noise), used for terrain
 * micro-detail, smoke breakup, plume turbulence and material grime.
 *  R: fbm (value+gradient blend), G/B: derivative-like normal noise, A: cellular (Worley)
 */
export function createTileableNoise(renderer: WebGLRenderer, size = 512, seed = 1): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(size, size, {
    type: UnsignedByteType, format: RGBAFormat, depthBuffer: false, generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, wrapS: RepeatWrapping, wrapT: RepeatWrapping,
  });
  rt.texture.anisotropy = 8;
  const mat = new ShaderMaterial({
    blending: NoBlending, depthTest: false, depthWrite: false,
    uniforms: { uSeed: { value: seed } },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec2 vUv;
      uniform float uSeed;
      float hash(vec2 p, float period) {
        p = mod(p, period);
        vec3 p3 = fract(vec3(p.xyx) * 0.1031 + uSeed * 0.137);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      vec2 hash2(vec2 p, float period) { return vec2(hash(p, period), hash(p + 17.31, period)); }
      float vnoise(vec2 p, float period) {
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        float a = hash(i, period), b = hash(i + vec2(1, 0), period), c = hash(i + vec2(0, 1), period), d = hash(i + vec2(1, 1), period);
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }
      float gnoise(vec2 p, float period) {
        vec2 i = floor(p); vec2 f = fract(p);
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        vec2 ga = hash2(i, period) * 2.0 - 1.0, gb = hash2(i + vec2(1, 0), period) * 2.0 - 1.0;
        vec2 gc = hash2(i + vec2(0, 1), period) * 2.0 - 1.0, gd = hash2(i + vec2(1, 1), period) * 2.0 - 1.0;
        float a = dot(ga, f), b = dot(gb, f - vec2(1, 0)), c = dot(gc, f - vec2(0, 1)), d = dot(gd, f - vec2(1, 1));
        return 0.5 + 0.7 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }
      float fbm(vec2 p, float period) {
        float s = 0.0, a = 0.5, n = 0.0;
        for (int o = 0; o < 7; o++) { s += a * mix(vnoise(p, period), gnoise(p, period), 0.6); n += a; a *= 0.5; p *= 2.0; period *= 2.0; }
        return s / n;
      }
      float worley(vec2 p, float period) {
        vec2 i = floor(p); vec2 f = fract(p);
        float d = 1.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          vec2 o = vec2(x, y);
          vec2 r = o + hash2(i + o, period) - f;
          d = min(d, dot(r, r));
        }
        return sqrt(d);
      }
      void main() {
        vec2 p = vUv * 8.0;
        float r = fbm(p, 8.0);
        float g = fbm(p * 2.0 + 13.7, 16.0);
        float b = fbm(p * 2.0 + 71.3, 16.0);
        float w = 1.0 - worley(vUv * 16.0, 16.0) * 0.6 - worley(vUv * 32.0, 32.0) * 0.4;
        gl_FragColor = vec4(r, g, b, w);
      }`,
  });
  const q = new FullscreenQuad(mat);
  const prev = renderer.getRenderTarget();
  q.render(renderer, rt);
  renderer.setRenderTarget(prev);
  mat.dispose();
  return rt;
}
