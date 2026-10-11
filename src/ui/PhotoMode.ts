import { Matrix4, Quaternion, Vector3 } from 'three';
import type { App } from '../core/App';
import type { FlightSession } from '../game/FlightSession';
import type { Input } from '../game/Input';
import type { Vessel } from '../physics/vessel';
import { h } from './dom';

/**
 * Photo mode: the simulation freezes, the camera floats free around the vehicle on screen (the
 * active one, or the booster a landing shot was following; orbit with the mouse, WASD/QE to move
 * the pivot, wheel to zoom), and the lens and grade are adjustable:
 * field of view, roll, exposure, letterbox, vignette, grain, saturation, contrast, colour
 * temperature. Capture saves a PNG without the interface.
 */
export class PhotoMode {
  readonly root: HTMLElement;
  private az = 0.8;
  private el = 0.15;
  private dist: number;
  private readonly pivotOffset = new Vector3();
  private fov = 45;
  private roll = 0;
  letterbox = 0;
  private saved: Record<string, number>;
  private flash: HTMLElement;
  private keys = new Set<string>();
  /** the vessel the camera floats around */
  private readonly subject: Vessel;

  constructor(readonly app: App, readonly s: FlightSession) {
    const post = app.rw.post.settings;
    this.saved = { vignette: post.vignette, grain: post.grain, saturation: post.saturation, contrast: post.contrast, temperature: post.temperature, exposureComp: post.exposureComp };
    const v = (this.subject = s.viewedVessels()[0]);
    let lo = Infinity, hi = -Infinity;
    for (const a of v.assemblies) { lo = Math.min(lo, a.bottomY); hi = Math.max(hi, a.topY); }
    this.dist = Math.max(20, (hi - lo) * 1.8);
    this.fov = app.rw.camera.fov;
    const slider = (label: string, min: number, max: number, step: number, value: number, on: (x: number) => void) => {
      const input = h('input', { type: 'range', min, max, step, value });
      const val = h('span', { class: 'value', style: 'font-size:12px' }, String(value));
      input.addEventListener('input', () => { const x = Number(input.value); val.textContent = x.toFixed(step < 1 ? 2 : 0); on(x); });
      return h('div', { class: 'field' }, h('div', { style: 'display:flex;justify-content:space-between' }, h('span', { class: 'label' }, label), val), input);
    };
    const capture = h('button', { class: 'btn primary', style: 'width:100%' }, 'Capture');
    capture.addEventListener('click', () => this.capture());
    const exit = h('button', { class: 'btn', style: 'width:100%;margin-top:6px' }, 'Exit photo mode');
    exit.addEventListener('click', () => (window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' }))));
    this.root = h('div', { class: 'photo-panel' },
      h('h3', {}, 'PHOTO MODE'),
      slider('Field of view', 5, 100, 1, Math.round(this.fov), (x) => { this.fov = x; }),
      slider('Camera roll', -45, 45, 1, 0, (x) => { this.roll = (x * Math.PI) / 180; }),
      slider('Exposure', -3, 3, 0.1, post.exposureComp, (x) => { post.exposureComp = x; }),
      slider('Letterbox', 0, 0.2, 0.01, 0, (x) => { this.letterbox = x; }),
      slider('Vignette', 0, 1, 0.01, post.vignette, (x) => { post.vignette = x; }),
      slider('Film grain', 0, 0.15, 0.005, post.grain, (x) => { post.grain = x; }),
      slider('Saturation', 0, 1.6, 0.01, post.saturation, (x) => { post.saturation = x; }),
      slider('Contrast', 0.7, 1.5, 0.01, post.contrast, (x) => { post.contrast = x; }),
      slider('Temperature', -1, 1, 0.01, post.temperature, (x) => { post.temperature = x; }),
      capture, exit,
      h('div', { class: 'label', style: 'margin-top:12px;line-height:1.7' }, 'Drag · orbit   Wheel · zoom   WASD/QE · move   P · exit'),
    );
    this.flash = h('div', { class: 'flash' });
    app.ui.append(this.root, this.flash);
    window.addEventListener('keydown', this.kd);
    window.addEventListener('keyup', this.ku);
  }

  private kd = (e: KeyboardEvent) => { this.keys.add(e.code); };
  private ku = (e: KeyboardEvent) => { this.keys.delete(e.code); };

  update(dt: number, input: Input): void {
    const m = input.consumeMouse();
    this.az += m.dx * 0.005;
    this.el = Math.max(-1.5, Math.min(1.5, this.el + m.dy * 0.004));
    if (m.wheel) this.dist = Math.max(3, this.dist * Math.pow(1.12, m.wheel));
    const s = this.s;
    const v = this.subject;
    const com = v.pos.clone().add(s.bodyPos(v.body));
    const up = com.clone().sub(s.bodyPos(v.body)).normalize();
    const rot = new Quaternion();
    v.body.orientationAt(s.world.t, rot);
    const north = new Vector3(0, 0, 1).applyQuaternion(rot);
    north.addScaledVector(up, -north.dot(up)).normalize();
    const east = new Vector3().crossVectors(north, up);
    // move the pivot in the horizon frame
    const sp = this.dist * dt * 0.8;
    const fwd = north.clone().multiplyScalar(-Math.cos(this.az)).addScaledVector(east, -Math.sin(this.az));
    if (this.keys.has('KeyW')) this.pivotOffset.addScaledVector(fwd, sp);
    if (this.keys.has('KeyS')) this.pivotOffset.addScaledVector(fwd, -sp);
    const right = new Vector3().crossVectors(fwd, up);
    if (this.keys.has('KeyD')) this.pivotOffset.addScaledVector(right, sp);
    if (this.keys.has('KeyA')) this.pivotOffset.addScaledVector(right, -sp);
    if (this.keys.has('KeyE')) this.pivotOffset.addScaledVector(up, sp);
    if (this.keys.has('KeyQ')) this.pivotOffset.addScaledVector(up, -sp);
    const pivot = com.add(this.pivotOffset);
    const ce = Math.cos(this.el);
    const cam = pivot.clone().addScaledVector(north, Math.cos(this.az) * ce * this.dist).addScaledVector(east, Math.sin(this.az) * ce * this.dist).addScaledVector(up, Math.sin(this.el) * this.dist);
    // keep above the ground
    const bp = s.bodyPos(v.body);
    const rr = cam.distanceTo(bp);
    const minR = v.body.radius + Math.max(0, v.telemetry.terrainHeight) + 1.5;
    if (rr < minR) cam.sub(bp).multiplyScalar(minR / rr).add(bp);
    const rw = this.app.rw;
    rw.cameraHelio.copy(cam);
    const dir = pivot.clone().sub(cam).normalize();
    const mtx = new Matrix4().lookAt(new Vector3(), dir, up);
    rw.camera.quaternion.setFromRotationMatrix(mtx).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), this.roll));
    if (rw.camera.fov !== this.fov) { rw.camera.fov = this.fov; rw.camera.updateProjectionMatrix(); }
  }

  private capture(): void {
    this.root.style.visibility = 'hidden';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const url = this.app.canvas.toDataURL('image/png');
      const a = h('a', { href: url, download: `ascent-photo-${Date.now()}.png` });
      a.click();
      this.root.style.visibility = '';
      this.flash.classList.add('on');
      setTimeout(() => this.flash.classList.remove('on'), 60);
      this.app.audio.play('shutter');
    }));
  }

  dispose(): void {
    const post = this.app.rw.post.settings;
    Object.assign(post, this.saved);
    window.removeEventListener('keydown', this.kd);
    window.removeEventListener('keyup', this.ku);
    this.root.remove();
    this.flash.remove();
  }
}
