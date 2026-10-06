import {
  AmbientLight, Color, DirectionalLight, GLSL3, HemisphereLight, Matrix3, Matrix4, Mesh, PerspectiveCamera, Quaternion, RingGeometry, Scene,
  ShaderMaterial, SphereGeometry, Texture, Vector3, WebGLRenderer, DoubleSide,
} from 'three';
import type { AssetBundle } from '../core/assets';
import type { CelestialBody, SolarSystem } from '../physics/bodies';
import { Atmosphere } from './atmosphere/Atmosphere';
import { PostPipeline } from './post/PostPipeline';
import { QuadtreePlanet } from './planet/QuadtreePlanet';
import { createEarthMaterial, createMoonMaterial } from './planet/TerrainMaterial';
import type { GlobalMap, HeightContext, SiteDef } from './planet/heightfield';
import { SkyBackground, Starfield } from './sky/Sky';
import { FullscreenQuad } from './util/Fullscreen';
import { createTileableNoise } from './util/ProceduralTextures';

const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _m3 = new Matrix3();
const _m4 = new Matrix4();

/** Simple textured sphere for distant planets and moons (gas giants get banded flow). */
class SimpleBody {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  rings: Mesh | null = null;
  constructor(readonly body: CelestialBody, map: Texture, opts: { rim?: [number, number, number]; rimStrength?: number; gas?: boolean; ring?: Texture }) {
    this.material = new ShaderMaterial({
      
      uniforms: {
        uMap: { value: map }, uSunDir: { value: new Vector3() }, uSunIrr: { value: new Vector3(110, 108, 103) },
        uRim: { value: new Vector3(...(opts.rim ?? [0, 0, 0])) }, uRimStrength: { value: opts.rimStrength ?? 0 }, uGas: { value: opts.gas ? 1 : 0 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        out vec3 vLocal; out vec3 vNormalW; out vec3 vViewW; out float vFragDepth;
        void main() {
          vLocal = position;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vViewW = -wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
          vFragDepth = 1.0 + gl_Position.w;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec3 vLocal; in vec3 vNormalW; in vec3 vViewW; in float vFragDepth;
        uniform sampler2D uMap; uniform vec3 uSunDir; uniform vec3 uSunIrr; uniform vec3 uRim; uniform float uRimStrength; uniform float uGas; uniform float uTime;
        uniform float logDepthBufFC;
        #define PI 3.14159265358979
        void main() {
          vec3 d = normalize(vLocal);
          float lon = atan(d.y, d.x);
          float lat = asin(clamp(d.z, -1.0, 1.0));
          // gas giants: zonal winds shear the bands slowly with latitude
          float shear = uGas * sin(lat * 7.0) * uTime * 2.0e-6;
          vec2 uv = vec2(fract((lon + shear) / (2.0 * PI) + 0.5), 0.5 + lat / PI);
          vec3 alb = texture(uMap, uv).rgb;
          vec3 N = normalize(vNormalW);
          vec3 V = normalize(vViewW);
          vec3 L = normalize(uSunDir);
          float ndl = dot(N, L);
          float diff = max(0.0, ndl);
          // limb darkening for cloudy worlds (Minnaert-like)
          float ndv = max(0.0, dot(N, V));
          float limb = mix(1.0, pow(max(ndv, 0.0), 0.35), uGas * 0.6 + uRimStrength * 0.3);
          vec3 col = alb / PI * uSunIrr * diff * limb;
          float rim = pow(1.0 - ndv, 3.0) * smoothstep(-0.25, 0.3, ndl) * uRimStrength;
          col += uRim * rim * uSunIrr * 0.02;
          gl_FragColor = vec4(col, 1.0);
          gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
        }`,
    });
    this.mesh = new Mesh(new SphereGeometry(1, 192, 96), this.material);
    this.mesh.frustumCulled = false;
    if (opts.ring) {
      const inner = 1.24, outer = 2.27;
      const g = new RingGeometry(inner, outer, 256, 1);
      const pos = g.attributes.position;
      const uv = g.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i));
        uv.setXY(i, (r - inner) / (outer - inner), 0.5);
      }
      const rm = new ShaderMaterial({
        transparent: true, side: DoubleSide, depthWrite: false,
        uniforms: { uMap: { value: opts.ring }, uSunDir: this.material.uniforms.uSunDir, uSunIrr: this.material.uniforms.uSunIrr, uPlanetPos: { value: new Vector3() }, uPlanetR: { value: 1 } },
        vertexShader: /* glsl */ `
          out vec2 vUv; out vec3 vWorld; out float vFragDepth;
          void main() { vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; vFragDepth = 1.0 + gl_Position.w; }`,
        fragmentShader: /* glsl */ `
          precision highp float;
          in vec2 vUv; in vec3 vWorld; in float vFragDepth;
          uniform sampler2D uMap; uniform vec3 uSunDir; uniform vec3 uSunIrr; uniform vec3 uPlanetPos; uniform float uPlanetR; uniform float logDepthBufFC;
          void main() {
            vec4 t = texture(uMap, vec2(vUv.x, 0.5));
            // planet shadow on the rings
            vec3 p = vWorld - uPlanetPos;
            float b = dot(p, uSunDir);
            float c2 = dot(p, p) - b * b;
            float shadow = b < 0.0 ? smoothstep(uPlanetR * uPlanetR * 0.97, uPlanetR * uPlanetR * 1.03, c2) : 1.0;
            vec3 col = t.rgb * uSunIrr * 0.12 * shadow;
            gl_FragColor = vec4(col, t.a * 0.95);
            gl_FragDepth = log2(vFragDepth) * logDepthBufFC * 0.5;
          }`,
      });
      this.rings = new Mesh(g, rm);
      this.rings.frustumCulled = false;
    }
  }
}

export class RenderWorld {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly bgScene = new Scene();
  readonly fxScene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly atmosphere: Atmosphere;
  readonly post: PostPipeline;
  readonly sky: SkyBackground;
  readonly stars: Starfield;
  readonly earth: QuadtreePlanet;
  readonly moon: QuadtreePlanet;
  readonly earthMat: ShaderMaterial;
  readonly moonMat: ShaderMaterial;
  readonly sunLight: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly ambient: AmbientLight;
  readonly system: SolarSystem;
  readonly heightCtxEarth: HeightContext;
  readonly heightCtxMoon: HeightContext;
  readonly detailTex: Texture;
  /** camera position, heliocentric inertial metres (double) */
  readonly cameraHelio = new Vector3();
  private simpleBodies: SimpleBody[] = [];
  private skyQuad = new FullscreenQuad();
  /** sun direction from the camera (world) */
  readonly sunDir = new Vector3(1, 0, 0);
  readonly earthPos = new Vector3();
  readonly earthRot = new Quaternion();
  readonly moonPos = new Vector3();
  readonly moonRot = new Quaternion();
  time = 0;
  cloudRotation = 0;
  cloudCover = 1;
  starBoost = 1;

  constructor(renderer: WebGLRenderer, assets: AssetBundle, system: SolarSystem, sites: SiteDef[]) {
    this.renderer = renderer;
    this.system = system;
    this.camera = new PerspectiveCamera(55, 1, 0.05, 1e13);
    this.camera.position.set(0, 0, 0);
    this.atmosphere = new Atmosphere();
    this.post = new PostPipeline(renderer, this.atmosphere);
    this.detailTex = createTileableNoise(renderer, 512, 3).texture;

    this.sky = new SkyBackground(assets.milkyWay);
    this.stars = new Starfield(assets.stars, assets.starDensity);
    this.bgScene.add(this.stars.points);

    // Earth height data: interleave water (R) and elevation (G)
    const img = assets.earthDataImage;
    const map: GlobalMap = { width: img.width, height: img.height, channels: 2, data: new Uint8Array(img.width * img.height * 2) };
    for (let i = 0, j = 0; i < img.width * img.height; i++, j += 2) { map.data[j] = img.data[i * 4]; map.data[j + 1] = img.data[i * 4 + 1]; }
    this.heightCtxEarth = { kind: 'earth', radius: 6_371_000, map, sites };
    const mimg = assets.moonHeightImage;
    const md = new Uint8Array(mimg.width * mimg.height);
    for (let i = 0; i < md.length; i++) md[i] = mimg.data[i * 4];
    this.heightCtxMoon = { kind: 'moon', radius: 1_737_400, moonMap: { width: mimg.width, height: mimg.height, data: md }, sites: [] };

    this.earthMat = createEarthMaterial({ albedo: assets.earthAlbedo, night: assets.earthNight, data: assets.earthData, clouds: assets.earthClouds, detail: this.detailTex }, this.atmosphere.uniforms);
    this.post.compositeMat.uniforms.uClouds.value = assets.earthClouds;
    this.earth = new QuadtreePlanet({ radius: 6_371_000, ctx: this.heightCtxEarth, material: this.earthMat, maxLevel: 16, splitFactor: 2.4, workers: 3 });
    this.scene.add(this.earth.group);
    this.moonMat = createMoonMaterial({ albedo: assets.moonAlbedo, detail: this.detailTex });
    this.moon = new QuadtreePlanet({ radius: 1_737_400, ctx: this.heightCtxMoon, material: this.moonMat, maxLevel: 15, splitFactor: 2.4, workers: 2 });
    this.scene.add(this.moon.group);

    const add = (id: string, tex: Texture, opts: ConstructorParameters<typeof SimpleBody>[2]) => {
      const sb = new SimpleBody(system.get(id), tex, opts);
      this.simpleBodies.push(sb);
      this.scene.add(sb.mesh);
      if (sb.rings) this.scene.add(sb.rings);
    };
    const P = assets.planets;
    add('mercury', P.mercury, {});
    add('venus', P.venus, { rim: [1, 0.9, 0.7], rimStrength: 1.2, gas: true });
    add('mars', P.mars, { rim: [0.9, 0.6, 0.45], rimStrength: 0.6 });
    add('jupiter', P.jupiter, { rim: [0.8, 0.75, 0.7], rimStrength: 0.8, gas: true });
    add('saturn', P.saturn, { rim: [0.9, 0.85, 0.7], rimStrength: 0.8, gas: true, ring: P.saturn_ring });
    add('uranus', P.uranus, { rim: [0.6, 0.85, 0.9], rimStrength: 1.0, gas: true });
    add('neptune', P.neptune, { rim: [0.4, 0.5, 1.0], rimStrength: 1.0, gas: true });
    add('io', P.io, {});
    add('europa', P.europa, {});
    add('ganymede', P.ganymede, {});
    add('callisto', P.callisto, {});

    this.sunLight = new DirectionalLight(0xffffff, 1);
    this.sunLight.castShadow = false;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    this.hemi = new HemisphereLight(0x8899bb, 0x443322, 0.0);
    this.scene.add(this.hemi);
    this.ambient = new AmbientLight(0xffffff, 0.0);
    this.scene.add(this.ambient);
  }

  setSites(sites: SiteDef[]): void {
    this.heightCtxEarth.sites = sites;
    this.earth.setSites(sites);
  }

  resize(w: number, h: number, pixelRatio: number): void {
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(pixelRatio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.resize(Math.floor(w * pixelRatio), Math.floor(h * pixelRatio));
  }

  /**
   * Position everything relative to the camera. `t` is simulation time (s past J2000).
   */
  update(t: number, dt: number): void {
    this.time = t;
    const sys = this.system;
    const cam = this.camera;
    cam.updateMatrixWorld();
    sys.earth.globalPositionAt(t, this.earthPos);
    sys.earth.orientationAt(t, this.earthRot);
    sys.moon.globalPositionAt(t, this.moonPos);
    sys.moon.orientationAt(t, this.moonRot);
    // sun direction (from the camera)
    this.sunDir.copy(this.cameraHelio).negate().normalize();

    // ---- Earth
    const camRelEarth = _v.copy(this.cameraHelio).sub(this.earthPos);
    const earthToCam = _v2.copy(this.earthPos).sub(this.cameraHelio);
    this.earth.update(camRelEarth, this.earthRot, earthToCam);
    const qi = _q.copy(this.earthRot).invert();
    const eu = this.earthMat.uniforms;
    (eu.uSunDirF.value as Vector3).copy(this.sunDir).applyQuaternion(qi);
    _m4.makeRotationFromQuaternion(qi).multiply(_m4.clone().extractRotation(cam.matrixWorld));
    (eu.uViewToFixed.value as Matrix3).setFromMatrix4(_m4);
    eu.uTime.value = (eu.uTime.value as number) + dt;
    eu.uCloudRot.value = this.cloudRotation;
    eu.uCloudShadow.value = this.cloudCover;

    // atmosphere: camera relative to Earth (km, inertial axes)
    const camKm = camRelEarth.clone().multiplyScalar(0.001);
    const cu = this.post.compositeMat.uniforms;
    (cu.uCamPosKm.value as Vector3).copy(camKm);
    (cu.uSunDir.value as Vector3).copy(this.sunDir);
    (cu.uInvProj.value as Matrix4).copy(cam.projectionMatrixInverse);
    (cu.uCamRot.value as Matrix3).setFromMatrix4(_m4.extractRotation(cam.matrixWorld));
    cu.uLogFar.value = Math.log2(cam.far + 1);
    cu.uCloudRot.value = this.cloudRotation;
    (cu.uPlanetRotInv.value as Matrix3).setFromMatrix4(_m4.makeRotationFromQuaternion(qi));
    cu.uCloudOpacity.value = this.cloudCover;
    const camR = camKm.length();
    // the 2D cloud shell fades out when the camera is low (volumetric/clear-sky near field)
    cu.uCloudShellFade.value = Math.min(1, Math.max(0, (camR - 6371 - 12) / 25));
    cu.uTime.value = t;
    const up = camKm.clone().normalize();
    this.atmosphere.precompute(this.renderer);
    if (camR < this.atmosphere.params.topRadius + 1) this.atmosphere.updateSkyView(this.renderer, camR, up.dot(this.sunDir));

    // ---- Moon
    const camRelMoon = _v.copy(this.cameraHelio).sub(this.moonPos);
    const moonToCam = _v2.copy(this.moonPos).sub(this.cameraHelio);
    this.moon.update(camRelMoon, this.moonRot, moonToCam);
    const mqi = _q.copy(this.moonRot).invert();
    const mu = this.moonMat.uniforms;
    (mu.uSunDirF.value as Vector3).copy(this.moonPos).negate().normalize().applyQuaternion(mqi);
    _m4.makeRotationFromQuaternion(mqi).multiply(_m4.clone().extractRotation(cam.matrixWorld));
    (mu.uViewToFixed.value as Matrix3).setFromMatrix4(_m4);
    (mu.uEarthDirF.value as Vector3).copy(this.earthPos).sub(this.moonPos).normalize().applyQuaternion(mqi);

    // ---- distant bodies
    for (const sb of this.simpleBodies) {
      const b = sb.body;
      b.globalPositionAt(t, _v);
      const rel = _v.sub(this.cameraHelio);
      sb.mesh.position.copy(rel);
      b.orientationAt(t, sb.mesh.quaternion);
      sb.mesh.scale.setScalar(b.radius);
      (sb.material.uniforms.uSunDir.value as Vector3).copy(rel).add(this.cameraHelio).negate().normalize();
      sb.material.uniforms.uTime.value = t;
      if (sb.rings) {
        sb.rings.position.copy(rel);
        b.getTilt(sb.rings.quaternion);
        sb.rings.scale.setScalar(b.radius);
        const ru = (sb.rings.material as ShaderMaterial).uniforms;
        (ru.uPlanetPos.value as Vector3).copy(rel);
        ru.uPlanetR.value = b.radius;
      }
    }

    // ---- sky background
    const su = this.sky.material.uniforms;
    (su.uInvProj.value as Matrix4).copy(cam.projectionMatrixInverse);
    (su.uCamRot.value as Matrix3).setFromMatrix4(_m4.extractRotation(cam.matrixWorld));
    (su.uSunDir.value as Vector3).copy(this.sunDir);
    const distAU = this.cameraHelio.length() / 1.495978707e11;
    const sunR = Math.atan(696340e3 / Math.max(1, this.cameraHelio.length()));
    su.uSunAngularRadius.value = sunR;
    // irradiance falls with distance^2; disc radiance stays constant (clamped for fp16)
    (su.uSunRadiance.value as Vector3).set(1, 0.97, 0.92).multiplyScalar(52000);
    const irr = 110 / (distAU * distAU);
    for (const sb of this.simpleBodies) (sb.material.uniforms.uSunIrr.value as Vector3).set(irr, irr * 0.98, irr * 0.94);
    const stu = this.stars.material.uniforms;
    (stu.uViewRot.value as Matrix4).copy(cam.matrixWorldInverse);
    (stu.uProj.value as Matrix4).copy(cam.projectionMatrix);
    stu.uPixelRatio.value = this.renderer.getPixelRatio();
    stu.uTime.value = t;
    stu.uFov.value = cam.fov / 55;
    stu.uStarIntensity.value = 0.02 * this.starBoost;
    stu.uTwinkle.value = camR < 6371 + 30 ? 1 : 0;
  }

  render(dt: number, extra?: () => void): void {
    const r = this.renderer;
    r.autoClear = false;
    this.post.beginScene();
    this.skyQuad.render(r, this.post.sceneRT, this.sky.material);
    r.render(this.bgScene, this.camera);
    r.render(this.scene, this.camera);
    this.post.composite();
    r.setRenderTarget(this.post.compRT);
    r.render(this.fxScene, this.camera);
    extra?.();
    this.post.finish(dt);
  }
}
