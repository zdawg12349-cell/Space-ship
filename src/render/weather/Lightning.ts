import { AdditiveBlending, BufferGeometry, Float32BufferAttribute, LineSegments, Matrix4, Quaternion, Scene, ShaderMaterial, Vector3 } from 'three';
import type { CloudDeck } from './CloudDeck';

/**
 * Lightning in a storm deck. Flashes come at random (a Poisson process at the storm's rate),
 * a few to twenty kilometres from the camera. Each one lights the cloud from inside. About half
 * reach the ground as a branched bolt that flickers through two to four return strokes. The
 * flash lights the ground for an instant, and thunder follows at the speed of sound.
 * Lightning is scenery only: it never strikes the vehicle.
 */

interface Flash {
  /** body-fixed km: the light inside the cloud, and the bolt's foot on the ground */
  cloud: Vector3;
  ground: Vector3;
  t: number;
  /** return strokes: start times and lengths (s) */
  strokes: [number, number][];
  dur: number;
  bolt: boolean;
  distM: number;
}

const BOLT_VERT = /* glsl */ `
attribute float aW;
varying float vW;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vW = aW;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const BOLT_FRAG = /* glsl */ `
uniform float uI;
varying float vW;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vec3(0.82, 0.88, 1.0) * uI * vW, 1.0);
}`;

const _m = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();

export class Lightning {
  /** thunder: called at the flash with the distance (m) and strength 0..1 */
  onStrike: ((distanceM: number, strength: number) => void) | null = null;
  /** 0..1 brightness of the current flash (for the scene's ambient light) */
  level = 0;
  private timer = 4;
  private flash: Flash | null = null;
  private readonly mat: ShaderMaterial;
  private readonly mesh: LineSegments;
  private readonly frame = new Quaternion();

  constructor(fxScene: Scene) {
    this.mat = new ShaderMaterial({
      uniforms: { uI: { value: 0 } }, vertexShader: BOLT_VERT, fragmentShader: BOLT_FRAG,
      blending: AdditiveBlending, depthTest: true, depthWrite: false, transparent: true,
    });
    this.mesh = new LineSegments(new BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    fxScene.add(this.mesh);
  }

  /**
   * @param camF camera, body-fixed km from the Earth's centre
   * @param earthRot body-fixed -> world rotation; earthToCam: camera minus Earth centre (world, m)
   */
  update(dt: number, deck: CloudDeck, camF: Vector3, earthRot: Quaternion, earthToCam: Vector3): void {
    const p = deck.params;
    const on = p && p.lightning > 0 && deck.active > 0.5 && camF.length() - 6371 < 40;
    if (!on) {
      if (this.flash) this.end(deck);
      return;
    }
    if (!this.flash) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = -Math.log(1 - Math.random()) * (60 / p.lightning);
        this.start(deck, camF);
      }
    }
    const f = this.flash;
    if (!f) return;
    f.t += dt;
    if (f.t > f.dur) { this.end(deck); return; }
    // the strokes: a sharp rise, a flicker, a decaying afterglow in the cloud
    let level = 0;
    for (const [s, len] of f.strokes) {
      const x = f.t - s;
      if (x < 0) continue;
      level = Math.max(level, x < len ? 1 - 0.35 * Math.random() : Math.exp(-(x - len) / 0.07) * 0.5);
    }
    this.level = level;
    const near = Math.min(1, 6000 / Math.max(2000, f.distM));
    deck.setFlash(f.cloud, 2600 * level * (f.bolt ? 1 : 0.7));
    // the flash lights the ground around the camera (scene irradiance units; sunlight is ~110)
    deck.uniforms.uDeckFlashIrr.value.set(0.85, 0.9, 1).multiplyScalar(14 * level * near * near);
    if (f.bolt) {
      this.mesh.visible = level > 0.25;
      this.mat.uniforms.uI.value = 900 * level;
      // place the bolt camera-relative: its foot, in the local frame (x east, y up, z south)
      _a.copy(f.ground).multiplyScalar(1000).applyQuaternion(earthRot).sub(earthToCam);
      this.mesh.position.copy(_a);
      this.mesh.quaternion.copy(this.frame).premultiply(earthRot);
    }
  }

  /** Strike now, ahead along `aheadF` (body-fixed) if given: for capture tools and tests. */
  strikeNow(deck: CloudDeck, camF: Vector3, aheadF?: Vector3): void {
    if (!deck.params) return;
    this.start(deck, camF, aheadF);
  }

  private start(deck: CloudDeck, camF: Vector3, aheadF?: Vector3): void {
    const p = deck.params!;
    const up = _a.copy(camF).normalize();
    const east = _b.set(-up.y, up.x, 0);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    const north = _c.crossVectors(up, east);
    const az = aheadF ? Math.atan2(aheadF.dot(east), aheadF.dot(north)) + (Math.random() - 0.5) * 0.4 : Math.random() * Math.PI * 2;
    const dist = aheadF ? 6 + Math.random() * 6 : 3 + Math.pow(Math.random(), 0.7) * 19; // km
    const dir = new Vector3().copy(north).multiplyScalar(Math.cos(az) * dist).addScaledVector(east, Math.sin(az) * dist);
    const groundDir = new Vector3().copy(up).multiplyScalar(6371).add(dir).normalize();
    const ground = groundDir.clone().multiplyScalar(6371);
    const base = p.base, h = base + (p.top - base) * (0.25 + Math.random() * 0.3);
    const cloud = groundDir.clone().multiplyScalar(6371 + h);
    const bolt = Math.random() < 0.55;
    const n = 1 + Math.floor(Math.random() * 3) + (bolt ? 1 : 0);
    const strokes: [number, number][] = [];
    let t = 0;
    for (let i = 0; i < n; i++) { strokes.push([t, 0.03 + Math.random() * 0.05]); t += 0.06 + Math.random() * 0.12; }
    const distM = Math.hypot(dist * 1000, (camF.length() - 6371 - (bolt ? 0 : h)) * 1000);
    this.flash = { cloud, ground, t: 0, strokes, dur: t + 0.5, bolt, distM };
    if (bolt) {
      this.buildBolt(base * 1000);
      // local frame at the foot: x east, y up, z south
      const ge = new Vector3(-groundDir.y, groundDir.x, 0);
      if (ge.lengthSq() < 1e-8) ge.set(1, 0, 0);
      ge.normalize();
      const gn = new Vector3().crossVectors(groundDir, ge);
      _m.makeBasis(ge, groundDir, gn.negate());
      this.frame.setFromRotationMatrix(_m);
    }
    this.onStrike?.(distM, bolt ? 1 : 0.6);
  }

  /** A jagged channel from the cloud base to the ground with a few forks. */
  private buildBolt(height: number): void {
    const pos: number[] = [];
    const w: number[] = [];
    const seg = (a: number[], b: number[], k: number) => { pos.push(a[0], a[1], a[2], b[0], b[1], b[2]); w.push(k, k); };
    const main: number[][] = [[0, height, 0]];
    let x = 0, y = height, z = 0;
    while (y > 0) {
      const dy = 50 + Math.random() * 130;
      y = Math.max(0, y - dy);
      x += (Math.random() - 0.5) * dy * 0.9;
      z += (Math.random() - 0.5) * dy * 0.9;
      main.push([x, y, z]);
    }
    for (let i = 1; i < main.length; i++) seg(main[i - 1], main[i], 1);
    const forks = 3 + Math.floor(Math.random() * 4);
    for (let b = 0; b < forks; b++) {
      let q = main[1 + Math.floor(Math.random() * Math.max(1, main.length * 0.6))].slice();
      const dx = (Math.random() - 0.5) * 2, dz = (Math.random() - 0.5) * 2;
      const steps = 3 + Math.floor(Math.random() * 6);
      for (let k = 0; k < steps && q[1] > 60; k++) {
        const dy = 40 + Math.random() * 90;
        const nq = [q[0] + dx * dy * 0.7 + (Math.random() - 0.5) * dy * 0.6, q[1] - dy * (0.35 + Math.random() * 0.5), q[2] + dz * dy * 0.7 + (Math.random() - 0.5) * dy * 0.6];
        seg(q, nq, 0.3 * (1 - k / steps) + 0.08);
        q = nq;
      }
    }
    const g = this.mesh.geometry;
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('aW', new Float32BufferAttribute(w, 1));
    g.computeBoundingSphere();
  }

  private end(deck: CloudDeck): void {
    this.flash = null;
    this.level = 0;
    this.mesh.visible = false;
    deck.setFlash(null);
    deck.uniforms.uDeckFlashIrr.value.set(0, 0, 0);
  }

  reset(deck: CloudDeck): void {
    this.end(deck);
    this.timer = 4;
  }
}
