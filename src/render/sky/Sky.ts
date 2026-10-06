import {
  AdditiveBlending, BufferGeometry, Float32BufferAttribute, GLSL3, Matrix3, Matrix4, Points, ShaderMaterial, Texture, Vector3,
} from 'three';
import { FULLSCREEN_VERT } from '../util/Fullscreen';

/**
 * Deep-sky background: Milky Way glow (NASA Tycho map, re-projected to the ecliptic frame),
 * the solar disc with limb darkening, and a point-sprite starfield built from the Yale Bright
 * Star Catalogue plus procedurally distributed faint stars following the galactic density.
 */

export class SkyBackground {
  readonly material: ShaderMaterial;
  constructor(milkyWay: Texture) {
    this.material = new ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: {
        uMilkyWay: { value: milkyWay },
        uInvProj: { value: new Matrix4() },
        uCamRot: { value: new Matrix3() },
        uSunDir: { value: new Vector3(1, 0, 0) },
        uSunAngularRadius: { value: 0.004654 },
        uSunRadiance: { value: new Vector3(1, 1, 1).multiplyScalar(50000) },
        uMilkyWayIntensity: { value: 0.002 },
        uSkyFade: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        uniform sampler2D uMilkyWay;
        uniform mat4 uInvProj;
        uniform mat3 uCamRot;
        uniform vec3 uSunDir;
        uniform float uSunAngularRadius;
        uniform vec3 uSunRadiance;
        uniform float uMilkyWayIntensity;
        uniform float uSkyFade;
        #define PI 3.14159265358979
        float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
        void main() {
          vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
          vec3 rd = normalize(uCamRot * normalize(v.xyz / v.w));
          float lon = atan(rd.y, rd.x);
          float lat = asin(clamp(rd.z, -1.0, 1.0));
          vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 + lat / PI);
          vec3 mw = texture(uMilkyWay, uv).rgb;
          // dust-lane breakup at fine scale where the band is bright
          float lum = dot(mw, vec3(0.3, 0.5, 0.2));
          float fine = vnoise(uv * vec2(900.0, 450.0)) * 0.6 + vnoise(uv * vec2(2600.0, 1300.0)) * 0.4;
          mw *= mix(1.0, 0.55 + 0.9 * fine, smoothstep(0.05, 0.4, lum));
          vec3 col = mw * mw * uMilkyWayIntensity;
          // sun disc with limb darkening
          float cosA = dot(rd, uSunDir);
          float ang = acos(clamp(cosA, -1.0, 1.0));
          if (ang < uSunAngularRadius * 1.15) {
            float x = clamp(ang / uSunAngularRadius, 0.0, 1.0);
            float mu = sqrt(max(0.0, 1.0 - x * x));
            float limb = 1.0 - 0.6 * (1.0 - mu) - 0.15 * (1.0 - mu) * (1.0 - mu);
            float edge = 1.0 - smoothstep(0.97, 1.12, ang / uSunAngularRadius);
            col += uSunRadiance * limb * edge;
          }
          gl_FragColor = vec4(col * uSkyFade, 1.0);
        }`,
    });
  }
}

export class Starfield {
  readonly points: Points;
  readonly material: ShaderMaterial;

  constructor(catalog: ArrayBuffer, densityImage: ImageData | null) {
    const dv = new DataView(catalog);
    const n = dv.getUint32(0, true);
    const pos: number[] = [];
    const col: number[] = [];
    const mag: number[] = [];
    for (let i = 0; i < n; i++) {
      const o = 4 + i * 28;
      pos.push(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
      mag.push(dv.getFloat32(o + 12, true));
      col.push(dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true), dv.getFloat32(o + 24, true));
    }
    // faint procedural stars, denser toward the galactic plane (density map in ecliptic coords)
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const faint = 42000;
    let added = 0, guard = 0;
    while (added < faint && guard++ < faint * 20) {
      const z = rnd() * 2 - 1;
      const t = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      const x = s * Math.cos(t), y = s * Math.sin(t);
      let accept = 0.18;
      if (densityImage) {
        const u = (Math.atan2(y, x) / (2 * Math.PI) + 0.5) * densityImage.width;
        const v = (0.5 - Math.asin(z) / Math.PI) * densityImage.height;
        const px = Math.min(densityImage.width - 1, Math.max(0, Math.floor(u)));
        const py = Math.min(densityImage.height - 1, Math.max(0, Math.floor(v)));
        accept = 0.12 + 0.88 * (densityImage.data[(py * densityImage.width + px) * 4] / 255);
      }
      if (rnd() > accept) continue;
      pos.push(x, y, z);
      // magnitude distribution ~ more faint stars
      mag.push(6.5 + Math.pow(rnd(), 0.6) * 3.2);
      const temp = rnd();
      const c = temp < 0.15 ? [0.75, 0.82, 1.0] : temp < 0.55 ? [1.0, 0.97, 0.92] : temp < 0.85 ? [1.0, 0.86, 0.7] : [1.0, 0.72, 0.55];
      col.push(c[0], c[1], c[2]);
      added++;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new Float32BufferAttribute(col, 3));
    g.setAttribute('aMag', new Float32BufferAttribute(mag, 1));
    this.material = new ShaderMaterial({
      depthTest: false, depthWrite: false, transparent: true, blending: AdditiveBlending,
      uniforms: {
        uViewRot: { value: new Matrix4() },
        uProj: { value: new Matrix4() },
        uPixelRatio: { value: 1 },
        uStarIntensity: { value: 0.02 },
        uTwinkle: { value: 0 },
        uTime: { value: 0 },
        uFov: { value: 1 },
        uLimitingMag: { value: 9.5 },
      },
      vertexShader: /* glsl */ `
        in float aMag;
        in vec3 aColor;
        uniform mat4 uViewRot;
        uniform mat4 uProj;
        uniform float uPixelRatio;
        uniform float uStarIntensity;
        uniform float uTwinkle;
        uniform float uTime;
        uniform float uFov;
        uniform float uLimitingMag;
        out vec3 vColor;
        void main() {
          vec4 p = uProj * uViewRot * vec4(position * 1.0e3, 1.0);
          gl_Position = p;
          float flux = pow(10.0, -0.4 * aMag);
          // narrower fields of view reveal fainter stars (longer focal length)
          float zoom = clamp(1.0 / uFov, 0.6, 6.0);
          float tw = 1.0 + uTwinkle * 0.45 * sin(uTime * (11.0 + fract(position.x * 977.0) * 17.0) + position.y * 400.0);
          float vis = smoothstep(uLimitingMag + log2(zoom) * 1.2, uLimitingMag - 1.5, aMag);
          float size = clamp(1.3 + (6.0 - aMag) * 0.42, 1.0, 5.5) * uPixelRatio;
          gl_PointSize = size;
          vColor = aColor * flux * uStarIntensity * tw * vis * zoom * zoom * 40.0 / (size * size * 0.35);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec3 vColor;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(c, c);
          float a = exp(-r2 * 4.0);
          if (a < 0.003) discard;
          gl_FragColor = vec4(vColor * a, 1.0);
        }`,
    });
    this.points = new Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -1000;
  }
}
