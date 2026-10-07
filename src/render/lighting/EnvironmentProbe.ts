import {
  CubeUVReflectionMapping, HalfFloatType, LinearFilter, Matrix3, NoBlending, PMREMGenerator, ShaderMaterial, Texture, Vector3, WebGLCubeRenderTarget,
  WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { ATMOSPHERE_COMMON } from '../atmosphere/glsl';
import type { Atmosphere } from '../atmosphere/Atmosphere';
import { FullscreenQuad } from '../util/Fullscreen';

/**
 * Image-based lighting probe: renders the physically based sky (and the sunlit planet below,
 * which becomes Earthshine in orbit) into a small HDR cube map, then prefilters it with
 * PMREM for the physical materials' diffuse and specular environment lighting.
 * The sun disc itself is excluded; the directional light carries direct sunlight.
 */
export class EnvironmentProbe {
  cube: WebGLCubeRenderTarget;
  private pmrem: PMREMGenerator;
  private pmremRT: WebGLRenderTarget | null = null;
  private quad: FullscreenQuad;
  private mat: ShaderMaterial;
  private timer = 1e9;
  private lastSun = new Vector3();
  private lastAlt = -1e9;
  texture: Texture | null = null;
  /** seconds between refreshes (also refreshes on large sun/altitude changes) */
  interval = 0.35;

  /** Change the cube resolution (graphics preset); the next update re-renders it. */
  setSize(size: number): void {
    if (size === this.cube.width) return;
    this.cube.dispose();
    this.cube = new WebGLCubeRenderTarget(size, { type: HalfFloatType, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
    this.mat.uniforms.uSize.value = size;
    this.pmremRT?.dispose();
    this.pmremRT = null;
    this.timer = 1e9;
  }

  constructor(private renderer: WebGLRenderer, atmosphere: Atmosphere, size = 64) {
    this.cube = new WebGLCubeRenderTarget(size, { type: HalfFloatType, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
    this.pmrem = new PMREMGenerator(renderer);
    this.mat = new ShaderMaterial({
      blending: NoBlending, depthTest: false, depthWrite: false,
      uniforms: {
        ...atmosphere.uniforms,
        uFace: { value: 0 },
        uSize: { value: size },
        uCamPosKm: { value: new Vector3(0, 6371.1, 0) },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uGroundAlbedoAvg: { value: 0.12 },
        uPlanetRotInv: { value: new Matrix3() },
        uStarGlow: { value: 0.0 },
      },
      vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform int uFace;
        uniform float uSize;
        uniform vec3 uCamPosKm;
        uniform vec3 uSunDir;
        uniform float uGroundAlbedoAvg;
        uniform float uStarGlow;
        ${ATMOSPHERE_COMMON}
        vec3 faceDir(int f, vec2 st) {
          vec2 c = st * 2.0 - 1.0;
          if (f == 0) return vec3(1.0, -c.y, -c.x);
          if (f == 1) return vec3(-1.0, -c.y, c.x);
          if (f == 2) return vec3(c.x, 1.0, c.y);
          if (f == 3) return vec3(c.x, -1.0, -c.y);
          if (f == 4) return vec3(c.x, -c.y, 1.0);
          return vec3(-c.x, -c.y, -1.0);
        }
        void main() {
          vec2 st = gl_FragCoord.xy / uSize;
          vec3 rd = normalize(faceDir(uFace, st));
          vec3 ro = uCamPosKm;
          float r = length(ro);
          vec3 L = vec3(0.0);
          vec3 T = vec3(1.0);
          float tG = raySphereNear(ro, rd, uAtmBottom);
          vec2 tTop = raySphere2(ro, rd, uAtmTop);
          if (tTop.y > 0.0) {
            float t0 = max(tTop.x, 0.0);
            float t1 = tG > 0.0 ? tG : tTop.y;
            int steps = int(clamp((t1 - t0) / 4.0 + 6.0, 6.0, 24.0));
            L = integrateScattering(ro, rd, t0, t1, uSunDir, steps, T);
          }
          vec3 col = L;
          if (tG > 0.0) {
            // lit ground (diffuse, average albedo) seen through the atmosphere
            vec3 p = ro + rd * tG;
            vec3 n = normalize(p);
            float muS = dot(n, uSunDir);
            vec3 sunT = getTransmittance(length(p), muS);
            vec3 skyIrr = getMultiScat(length(p), muS) * uSunIlluminance * 4.0 * ATM_PI;
            vec3 E = uSunIlluminance * sunT * max(muS, 0.0) + skyIrr * 0.5;
            col += T * uGroundAlbedoAvg * E / ATM_PI;
          } else if (tTop.y <= 0.0 || r > uAtmTop) {
            col += vec3(uStarGlow);
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.quad = new FullscreenQuad(this.mat);
  }

  /** Request an immediate refresh on the next update. */
  invalidate(): void { this.timer = 1e9; }

  /**
   * @param camPosKm probe position relative to the planet centre (km, world axes)
   * @param sunDir world-space sun direction
   */
  update(dt: number, camPosKm: Vector3, sunDir: Vector3, groundAlbedo: number): Texture | null {
    this.timer += dt;
    const alt = camPosKm.length();
    const big = this.lastSun.dot(sunDir) < 0.9995 || Math.abs(alt - this.lastAlt) > Math.max(0.5, Math.abs(alt - 6371) * 0.15);
    if (this.timer < this.interval && !big && this.texture) return this.texture;
    this.timer = 0;
    this.lastSun.copy(sunDir);
    this.lastAlt = alt;
    const u = this.mat.uniforms;
    (u.uCamPosKm.value as Vector3).copy(camPosKm);
    (u.uSunDir.value as Vector3).copy(sunDir);
    u.uGroundAlbedoAvg.value = groundAlbedo;
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = false;
    for (let f = 0; f < 6; f++) {
      u.uFace.value = f;
      r.setRenderTarget(this.cube, f);
      r.render(this.quad.mesh, this.quad.camera);
    }
    this.pmremRT = this.pmrem.fromCubemap(this.cube.texture, this.pmremRT ?? undefined);
    this.pmremRT.texture.mapping = CubeUVReflectionMapping;
    this.texture = this.pmremRT.texture;
    r.setRenderTarget(prevRT);
    r.autoClear = prevAuto;
    return this.texture;
  }
}
