import { Color, Matrix4, PointLight, Quaternion, Vector3 } from 'three';
import type { CelestialBody } from '../physics/bodies';
import type { AssemblyRuntime, Vessel } from '../physics/vessel';
import type { PlumeStyle } from '../vehicles/types';
import type { LaunchComplex } from '../render/site/LaunchComplex';
import type { RenderWorld } from '../render/RenderWorld';
import { EmitOptions, ParticleKind, ParticleSystem } from './Particles';

/**
 * Drives the particle emitters from the simulation: the steam and smoke torrent out of the
 * flame trench, the ground cloud while the plume still reaches the pad, the exhaust trail,
 * deluge water, cryogenic venting, separation puffs, ignition sparks, explosions, landing
 * dust (or ballistic lunar regolith) and the reentry plasma wake.
 *
 * Particles live in a local tangent frame anchored to the body under the action (x east,
 * y up, z south); the anchor follows the active vessel in big jumps, re-expressing existing
 * particles so trails stay continuous.
 */

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();
const _up = new Vector3();
const _n = new Vector3();
const _e = new Vector3();

interface TrailState { acc: number; last: Vector3 | null }

export interface EffectsFlags {
  /** sound-suppression deluge flowing (0..1) */
  deluge: number;
  /** cryogenic venting intensity (0..1) */
  venting: number;
}

export class Effects {
  readonly particles: ParticleSystem;
  readonly flags: EffectsFlags = { deluge: 0, venting: 0 };
  /** lit radiance of white condensation near the focus (HDR), for flow-attached vapour */
  readonly sheetLight = new Vector3(10, 10, 10);
  /** surface wind in the local frame (x east, y up, z south), m/s */
  readonly surfaceWind = new Vector3(3.5, 0, -1.2);

  /** Surface wind: speed (m/s) and the direction it blows toward (rad from north). */
  setWind(speed: number, toward: number): void {
    this.surfaceWind.set(Math.sin(toward) * speed, 0, -Math.cos(toward) * speed);
  }
  /** anchor (body-fixed) */
  anchorBody: CelestialBody | null = null;
  readonly anchorDirFixed = new Vector3(1, 0, 0);
  anchorAlt = 0;
  /** world (camera-relative) placement of the anchor frame, refreshed each update */
  readonly frameQuat = new Quaternion();
  readonly framePos = new Vector3();
  private trails = new Map<Vessel, TrailState>();
  private acc = new Map<string, number>();
  private flash: PointLight;
  private flashLife = 0;
  private flashMax = 1;
  private flashI = 0;
  private time = 0;
  /** scales emission counts with the particle budget */
  private rateScale: number;

  constructor(private readonly rw: RenderWorld, maxParticles = 6000) {
    this.particles = new ParticleSystem(rw.fxScene, rw.detailTex, () => rw.post.linearDepth, maxParticles);
    this.rateScale = Math.min(2, maxParticles / 6000);
    this.flash = new PointLight(0xffaa66, 0, 0, 2);
    this.flash.visible = false;
    rw.scene.add(this.flash);
  }

  /** Anchor the particle frame at a body-fixed point (lat/lon radians, alt m above the reference radius). */
  setAnchor(body: CelestialBody, lat: number, lon: number, alt: number): void {
    this.anchorBody = body;
    this.anchorDirFixed.set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    this.anchorAlt = alt;
    this.particles.clear();
    this.trails.clear();
  }

  /** Local (anchor) frame rotation in the body-fixed frame. */
  private fixedBasis(dir: Vector3, out: Quaternion): Quaternion {
    _up.copy(dir).normalize();
    _n.set(-_up.z * _up.x, -_up.z * _up.y, 1 - _up.z * _up.z);
    if (_n.lengthSq() < 1e-10) _n.set(1, 0, 0);
    _n.normalize();
    _e.crossVectors(_n, _up);
    _m.makeBasis(_e, _up, _n.negate());
    return out.setFromRotationMatrix(_m);
  }

  private placeFrame(t: number): void {
    const body = this.anchorBody!;
    const rot = _q.identity();
    body.orientationAt(t, rot);
    this.fixedBasis(this.anchorDirFixed, this.frameQuat).premultiply(rot);
    body.globalPositionAt(t, _a);
    this.framePos.copy(this.anchorDirFixed).multiplyScalar(body.radius + this.anchorAlt).applyQuaternion(rot).add(_a).sub(this.rw.cameraHelio);
    this.particles.frameQuat.copy(this.frameQuat);
    this.particles.framePos.copy(this.framePos);
  }

  /** Move the anchor under a vessel when it gets far away, keeping existing particles in place. */
  private followVessel(v: Vessel, t: number): void {
    if (!this.anchorBody || v.body !== this.anchorBody) {
      const ll = v.computeLatLon(t);
      this.setAnchor(v.body, ll.lat, ll.lon, Math.max(0, v.telemetry.terrainHeight));
      return;
    }
    const R = this.anchorBody.radius;
    v.fixedDirection(t, _a);
    const ang = Math.acos(Math.max(-1, Math.min(1, _a.dot(this.anchorDirFixed))));
    if (ang * R < 40_000) return;
    // new anchor under the vessel: transform particles old-local -> fixed -> new-local
    const oldQ = this.fixedBasis(this.anchorDirFixed, new Quaternion());
    const oldP = this.anchorDirFixed.clone().multiplyScalar(R + this.anchorAlt);
    const newDir = _a.clone();
    const newAlt = Math.max(0, v.telemetry.terrainHeight);
    const newQ = this.fixedBasis(newDir, new Quaternion());
    const newP = newDir.clone().multiplyScalar(R + newAlt);
    const newQinv = newQ.clone().invert();
    // p_new = newQinv * (oldQ * p_old + oldP - newP)
    const Rq = newQinv.clone().multiply(oldQ);
    const tvec = oldP.sub(newP).applyQuaternion(newQinv);
    this.particles.reframe(Rq, tvec);
    for (const tr of this.trails.values()) if (tr.last) tr.last.applyQuaternion(Rq).add(tvec);
    this.anchorDirFixed.copy(newDir);
    this.anchorAlt = newAlt;
  }

  /** Particle budget for the graphics preset (the pool is allocated once at full size). */
  setBudget(n: number): void {
    this.particles.budget = n;
    this.rateScale = Math.min(2, n / 6000);
  }

  private rate(key: string, perSecond: number, dt: number): number {
    const v = (this.acc.get(key) ?? 0) + perSecond * dt * this.rateScale;
    const n = Math.floor(v);
    this.acc.set(key, v - n);
    return n;
  }

  /** World (camera-relative) point of a vehicle-frame position. */
  private vehiclePoint(v: Vessel, local: Vector3, out: Vector3): Vector3 {
    const g = this.rw.vessels.groupOf(v);
    if (g) return out.copy(local).applyQuaternion(g.quaternion).add(g.position);
    return v.originInertial(out).add(local.clone().applyQuaternion(v.rot));
  }

  /** Vessel velocity relative to the anchor's rotating ground, in the local frame. */
  private surfaceVelLocal(v: Vessel, out: Vector3): Vector3 {
    v.surfaceVelocity(out);
    _q.copy(this.frameQuat).invert();
    return out.applyQuaternion(_q);
  }

  update(dt: number, t: number, vessels: Vessel[], active: Vessel | null, complex: LaunchComplex | null): void {
    this.time += dt;
    if (active && !active.destroyed) this.followVessel(active, t);
    if (!this.anchorBody) return;
    this.placeFrame(t);
    const P = this.particles;
    const air = this.anchorBody.atmosphereTop > 0;
    // surface wind at the site (a sea breeze unless the weather says otherwise; the physics
    // weather supplies the full profile to the vehicle in flight)
    if (air) P.wind.copy(this.surfaceWind); else P.wind.set(0, 0, 0);
    P.groundY = 0;
    P.bodyRadius = this.anchorBody.radius;

    for (const v of vessels) {
      if (v.destroyed || v.body !== this.anchorBody) continue;
      this.exhaust(v, dt, complex);
      this.rcsPuffs(v, dt);
      if (v.auxBurns.length) this.auxMotors(v, dt);
    }
    if (complex && this.anchorDirFixed.distanceTo(_d.set(...siteDir(complex))) < 1e-4) {
      this.deluge(dt, complex);
      if (active) this.venting(dt, active);
    }

    // lighting
    const rw = this.rw;
    const sunIrr = _a.copy(rw.sunColorAtFocus).multiplyScalar(rw.sunLight.visible ? rw.sunLight.intensity / Math.max(1e-6, Math.max(rw.sunColorAtFocus.x, rw.sunColorAtFocus.y, rw.sunColorAtFocus.z)) : 0);
    const upW = _c.set(0, 1, 0).applyQuaternion(this.frameQuat);
    const sunEl = upW.dot(rw.sunDir);
    const day = smooth(-0.12, 0.25, sunEl);
    const amb = new Vector3(0.75, 0.85, 1.0).multiplyScalar(110 * 0.1 * day + 0.004);
    if (!air) amb.set(0.002, 0.002, 0.002);
    // under an overcast the sky light is the deck's grey base
    const ov = rw.deck.overcast;
    if (air && ov > 0) amb.lerp(_d.copy(rw.deck.uniforms.uDeckUnderL.value).multiplyScalar(Math.PI * 0.85), ov);
    const lights = rw.plumes.lights.map((l) => ({ pos: l.pos, color: l.color, intensity: l.intensity }));
    if (this.flashI > 0) lights.push({ pos: this.flash.position, color: this.flash.color, intensity: this.flashI });
    P.setLighting(rw.sunDir, sunIrr, amb, rw.camera.matrixWorldInverse, lights, rw.atmToFocus);
    // radiance of a bright, thin cloud sheet near the action (vapour cones)
    this.sheetLight.copy(sunIrr).multiplyScalar((0.85 / Math.PI) * 0.7).addScaledVector(amb, 0.85 / Math.PI * 2.2);

    // camera in the local frame
    const camL = P.toLocal(_a.set(0, 0, 0), new Vector3());
    const fwd = P.dirToLocal(_b.set(0, 0, -1).applyQuaternion(this.rw.camera.quaternion), new Vector3());
    // split depth: the active vessel's plume
    let split = 1e9;
    const L0 = this.rw.plumes.lights[0];
    if (L0 && L0.intensity > 0) split = Math.max(0, L0.pos.dot(_c.set(0, 0, -1).applyQuaternion(this.rw.camera.quaternion)));
    P.update(dt, camL, fwd, split, this.rw.post.size);

    // explosion flash decay
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      const k = Math.max(0, this.flashLife / this.flashMax);
      this.flash.intensity = this.flashI * k * k;
      this.flash.visible = this.flashLife > 0;
      if (this.flashLife <= 0) this.flashI = 0;
    }
  }

  // ------------------------------------------------------------------------------ emitters

  private exhaust(v: Vessel, dt: number, complex: LaunchComplex | null): void {
    const P = this.particles;
    let thrust = 0;
    const exitV = _a.set(0, 0, 0);
    let wsum = 0;
    const styleThrust = new Map<PlumeStyle, number>();
    let lowest = Infinity;
    for (const a of v.assemblies) {
      for (const e of a.engines) {
        if (e.thrust <= 0) continue;
        thrust += e.thrust;
        const m = e.mount;
        exitV.x += (m.pos[0] + a.offX) * e.thrust;
        exitV.y += (m.pos[1] - m.spec.nozzleLength) * e.thrust;
        exitV.z += (m.pos[2] + a.offZ) * e.thrust;
        wsum += e.thrust;
        lowest = Math.min(lowest, m.pos[1] - m.spec.nozzleLength);
        styleThrust.set(m.spec.plume, (styleThrust.get(m.spec.plume) ?? 0) + e.thrust);
      }
    }
    const tr = this.trails.get(v) ?? { acc: 0, last: null };
    this.trails.set(v, tr);
    if (thrust <= 0) { tr.last = null; return; }
    exitV.multiplyScalar(1 / wsum);
    exitV.y = lowest;
    const exitW = this.vehiclePoint(v, exitV, new Vector3());
    const exitL = P.toLocal(exitW, new Vector3());
    const dirL = P.dirToLocal(_b.set(0, -1, 0).applyQuaternion(v.rot), new Vector3()).normalize();
    const MN = thrust / 1e6;
    let style: PlumeStyle = 'kerolox';
    let best = 0;
    for (const [s, f] of styleThrust) if (f > best) { best = f; style = s; }
    const solid = (styleThrust.get('solid') ?? 0) / thrust;
    const kerolox = (styleThrust.get('kerolox') ?? 0) / thrust;
    const hyper = (styleThrust.get('hypergolic') ?? 0) / thrust;
    const airBody = this.anchorBody!.atmosphereTop > 0;
    const rho = v.atm.density;
    const h = exitL.y - P.groundY;
    const reach = 30 * Math.sqrt(MN) + 20;
    const vSurf = this.surfaceVelLocal(v, new Vector3());

    // ------------------------------------------------------------- pad / ground interaction
    const onPad = complex && Math.hypot(exitL.x, exitL.z) < 60 && h < complex.deckHeight + 12;
    if (onPad && complex) {
      // the jet is turned by the deflector and blasts out of the trench exits
      const n = this.rate('trench', Math.min(240, 18 + MN * 22), dt);
      const exits = complex.exits;
      for (let i = 0; i < n; i++) {
        const ex = exits[i % exits.length];
        const kind: ParticleKind = solid > 0.4 ? 'srbsmoke' : Math.random() < kerolox * 0.16 + hyper * 0.5 ? 'smoke' : 'steam';
        const speed = 25 + Math.sqrt(MN) * 14;
        P.emit({
          kind, pos: _c.copy(ex.pos).addScaledVector(ex.dir, -ex.width * 0.6), vel: _d.copy(ex.dir).multiplyScalar(speed * (0.7 + Math.random() * 0.6)).add(_e.set(0, 4 + Math.random() * 6, 0)),
          spread: speed * 0.22, jitter: ex.width * 0.35, size: 3 + Math.sqrt(MN) * 1.6, grow: 2.2 + Math.sqrt(MN) * 0.9, life: 26 + Math.random() * 14, heat: 0.45, tint: kind === 'smoke' ? 0.85 : 1,
        });
      }
      // billowing around the mount itself
      const n2 = this.rate('mount', Math.min(60, 6 + MN * 5), dt);
      for (let i = 0; i < n2; i++) {
        const ang = Math.random() * Math.PI * 2;
        const r = complex.deckHeight * 0.6 + Math.random() * 6;
        P.emit({
          kind: solid > 0.4 ? 'srbsmoke' : 'steam', pos: _c.set(Math.cos(ang) * r, complex.deckHeight * 0.4, Math.sin(ang) * r),
          vel: _d.set(Math.cos(ang) * 8, 6 + Math.random() * 8, Math.sin(ang) * 8), spread: 4, size: 4 + Math.sqrt(MN), grow: 2.5, life: 18, heat: 0.3,
        });
      }
    } else if (airBody && h < reach && dirL.y < -0.2) {
      // the jet still hits the ground: radial ground cloud from the impingement point
      const tHit = h / -dirL.y;
      const hit = _c.copy(exitL).addScaledVector(dirL, tHit);
      hit.y = P.groundY + 1;
      const strength = 1 - h / reach;
      const n = this.rate(`gnd${v.id}`, Math.min(200, (12 + MN * 16) * strength), dt);
      const nearPad = complex && Math.hypot(hit.x, hit.z) < 400;
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = (20 + Math.sqrt(MN) * 18) * (0.4 + strength);
        const kind: ParticleKind = solid > 0.4 ? 'srbsmoke' : nearPad || v.splashed ? (Math.random() < kerolox * 0.4 ? 'smoke' : 'steam') : 'dust';
        P.emit({
          kind, pos: hit, vel: _d.set(Math.cos(ang) * sp, 2 + Math.random() * 5, Math.sin(ang) * sp), spread: sp * 0.2, jitter: 2 + Math.sqrt(MN),
          size: 3 + Math.sqrt(MN) * 1.4, grow: 2 + Math.sqrt(MN) * 0.7, life: 18 + Math.random() * 10, heat: 0.6 * strength,
        });
      }
    } else if (!airBody && h < 60 && dirL.y < -0.2) {
      // vacuum: regolith sprays ballistically from under the descent engine
      const tHit = h / -dirL.y;
      const hit = _c.copy(exitL).addScaledVector(dirL, tHit);
      hit.y = P.groundY + 0.2;
      const strength = 1 - h / 60;
      const n = this.rate(`reg${v.id}`, Math.min(160, 40 + MN * 2000) * strength, dt);
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 30 + Math.random() * 60 * strength;
        P.emit({ kind: 'regolith', pos: hit, vel: _d.set(Math.cos(ang) * sp, sp * 0.08 + Math.random() * 2, Math.sin(ang) * sp), jitter: 2, size: 0.6 + Math.random() * 1.5, grow: 2.5, life: 2.5, drag: 0 });
      }
    }

    // ------------------------------------------------------------- exhaust trail
    if (airBody && rho > 2e-5 && !v.landed && !onPad && h > reach * 0.6) {
      const alt = v.telemetry.altitude;
      const contrail = smooth(6500, 9000, alt) * (1 - smooth(13000, 17000, alt));
      let opacity: number;
      let kind: ParticleKind;
      let life: number;
      let heat = 0;
      if (solid > 0.3) { kind = 'srbsmoke'; opacity = 0.95 * (1 - smooth(25000, 50000, alt)); life = 300; heat = 0.7; } else if (kerolox > 0.5) {
        kind = 'smoke'; opacity = 0.42 * Math.exp(-alt / 9000) + 0.3 * contrail; life = 120; heat = 0.45;
      } else if (hyper > 0.5) { kind = 'smoke'; opacity = 0.3 * Math.exp(-alt / 9000) + 0.25 * contrail; life = 90; heat = 0.3; } else {
        kind = 'trail'; opacity = 0.12 * Math.exp(-alt / 12000) + 0.45 * contrail; life = 80;
      }
      // trail starts where the luminous plume ends
      const tailLen = 22 * Math.sqrt(MN) * (1 + alt / 12000);
      const tail = _c.copy(exitL).addScaledVector(dirL, tailLen);
      const expand = Math.sqrt(1.225 / Math.max(0.005, rho));
      const size = Math.min(400, (2.5 * Math.sqrt(MN) + 2) * Math.min(12, expand));
      const speed = vSurf.length();
      const maxRate = 70;
      const spacing = Math.max(size * 0.32, speed / maxRate);
      const sizeEff = Math.max(size, spacing / 0.32);
      if (tr.last) {
        const dist = tr.last.distanceTo(tail);
        tr.acc += dist;
        let k = 0;
        while (tr.acc >= spacing && k < 40) {
          tr.acc -= spacing;
          const f = 1 - tr.acc / Math.max(dist, 1e-3);
          const pos = _d.copy(tr.last).lerp(tail, Math.min(1, Math.max(0, f)));
          if (opacity > 0.02) {
            P.emit({
              kind, pos, vel: _e.copy(P.wind).addScaledVector(dirL, 8), spread: 2, jitter: sizeEff * 0.15, size: sizeEff, grow: sizeEff * 0.04 + 0.6, life: life * (alt > 20000 ? 0.6 : 1),
              heat, opacity: Math.min(1, opacity), drag: 1,
            });
          }
          k++;
        }
        if (tr.acc > spacing * 4) tr.acc = 0;
        tr.last.copy(tail);
      } else tr.last = tail.clone();
    } else tr.last = null;

    // ------------------------------------------------------------- SRB sparks (aluminium slag)
    if (solid > 0.3 && airBody) {
      const n = this.rate(`slag${v.id}`, 25, dt);
      for (let i = 0; i < n; i++) {
        P.emit({ kind: 'spark', pos: _c.copy(exitL).addScaledVector(dirL, 8 + Math.random() * 20), vel: _d.copy(vSurf).multiplyScalar(0.8).addScaledVector(dirL, 30), spread: 25, size: 0.25, life: 1.2, heat: 1, drag: 0.5 });
      }
    }
    void style;
  }

  private deluge(dt: number, complex: LaunchComplex): void {
    const f = this.flags.deluge;
    if (f <= 0.01) return;
    const P = this.particles;
    const n = this.rate('deluge', 220 * f, dt);
    for (let i = 0; i < n; i++) {
      const nz = complex.deluge[(Math.random() * complex.deluge.length) | 0];
      const inward = _d.set(-nz.x, 0, -nz.z).normalize();
      const up = nz.y > 2 ? 5 : 14;
      P.emit({ kind: 'water', pos: nz, vel: _e.copy(inward).multiplyScalar(9 + Math.random() * 5).add(_c.set(0, up, 0)), spread: 2.5, size: 0.7, grow: 1.2, life: 1.6, opacity: 0.7 });
    }
    // mist hanging over the wet deck
    const m = this.rate('mist', 10 * f, dt);
    for (let i = 0; i < m; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * 14;
      P.emit({ kind: 'vapor', pos: _c.set(Math.cos(ang) * r, complex.deckHeight * 0.6, Math.sin(ang) * r), vel: _d.set(0, 0.5, 0), spread: 1.2, size: 3, grow: 1.4, life: 6, opacity: 0.25 });
    }
  }

  private venting(dt: number, v: Vessel): void {
    const f = this.flags.venting;
    if (f <= 0.01 || v.hasLiftedOff) return;
    const P = this.particles;
    let k = 0;
    for (const a of v.assemblies) {
      a.def.sections.forEach((s, si) => {
        if (!s.frost || !s.propellant) return;
        const key = `vent${a.id}${si}`;
        const n = this.rate(key, 14 * f, dt);
        const ang = (k++ * 2.39996) % (Math.PI * 2);
        for (let i = 0; i < n; i++) {
          const local = _c.set(a.offX + Math.cos(ang) * s.radius * 1.02, s.y + s.length - 0.6, a.offZ + Math.sin(ang) * s.radius * 1.02);
          const w = this.vehiclePoint(v, local, new Vector3());
          const pl = P.toLocal(w, new Vector3());
          const out = P.dirToLocal(_d.set(Math.cos(ang), 0, Math.sin(ang)).applyQuaternion(v.rot), new Vector3());
          P.emit({ kind: 'vapor', pos: pl, vel: out.multiplyScalar(3 + Math.random() * 2), spread: 0.8, size: 0.6, grow: 1.1, life: 5.5, opacity: 0.55 });
        }
      });
    }
    // chill-down mist pooling under the engines
    const root = v.rootAssembly;
    if (root.def.sections.some((s) => s.frost)) {
      const n = this.rate('chill', 6 * f, dt);
      for (let i = 0; i < n; i++) {
        const w = this.vehiclePoint(v, _c.set(0, root.bottomY, 0), new Vector3());
        const pl = P.toLocal(w, new Vector3());
        P.emit({ kind: 'vapor', pos: pl, vel: _d.set(0, -1.5, 0), spread: 1.5, jitter: root.maxRadius, size: 1.4, grow: 1.3, life: 7, opacity: 0.4 });
      }
    }
  }

  // ------------------------------------------------------------------------------ events

  /** Separation: gas puff ring at the separation plane, debris sparks. */
  separation(v: Vessel, parts: AssemblyRuntime[], kind: string): void {
    if (!this.anchorBody) return;
    const P = this.particles;
    const vac = v.atm.density < 1e-4;
    const vel = this.surfaceVelLocal(v, new Vector3());
    for (const a of parts) {
      const y = kind === 'radial' ? (a.topY + a.bottomY) * 0.5 : a.topY;
      const r = Math.max(0.5, a.maxRadius);
      for (let i = 0; i < 26; i++) {
        const ang = (i / 26) * Math.PI * 2;
        const local = _c.set(a.offX + Math.cos(ang) * r, y, a.offZ + Math.sin(ang) * r);
        const w = this.vehiclePoint(v, local, new Vector3());
        const pl = P.toLocal(w, new Vector3());
        const out = P.dirToLocal(_d.set(Math.cos(ang), 0, Math.sin(ang)).applyQuaternion(v.rot), new Vector3());
        P.emit({ kind: 'vapor', pos: pl, vel: out.multiplyScalar(vac ? 25 : 10).add(vel), spread: vac ? 8 : 3, size: r * 0.5, grow: vac ? 12 : 3, life: vac ? 1.2 : 3.5, opacity: 0.6, drag: vac ? 0 : 1 });
      }
      for (let i = 0; i < 12; i++) {
        const local = _c.set(a.offX, y, a.offZ);
        const pl = P.toLocal(this.vehiclePoint(v, local, new Vector3()), new Vector3());
        P.emit({ kind: 'spark', pos: pl, vel: _d.copy(vel), spread: 18, size: 0.15, life: 0.8, heat: 1, drag: vac ? 0 : 1 });
      }
    }
  }

  /** Ignition sparks + TEA-TEB flash (kerosene engines) at the nozzles. */
  ignition(v: Vessel, a: AssemblyRuntime): void {
    if (!this.anchorBody) return;
    const P = this.particles;
    for (const e of a.engines) {
      const m = e.mount;
      const local = _c.set(m.pos[0] + a.offX, m.pos[1] - m.spec.nozzleLength, m.pos[2] + a.offZ);
      const pl = P.toLocal(this.vehiclePoint(v, local, new Vector3()), new Vector3());
      const dir = P.dirToLocal(_d.set(0, -1, 0).applyQuaternion(v.rot), new Vector3());
      for (let i = 0; i < 10; i++) P.emit({ kind: 'spark', pos: pl, vel: _e.copy(dir).multiplyScalar(20 + Math.random() * 30), spread: 12, size: 0.12, life: 1.0, heat: 1 });
    }
  }

  /** Fireball + soot + debris sparks + light flash at a world (camera-relative) point. */
  explosion(worldPos: Vector3, scale: number, inheritVelLocal?: Vector3): void {
    if (!this.anchorBody) return;
    const P = this.particles;
    const pl = P.toLocal(worldPos, new Vector3());
    const vel = inheritVelLocal ?? new Vector3();
    const air = this.anchorBody.atmosphereTop > 0;
    const s = Math.max(1, scale);
    for (let i = 0; i < 40; i++) {
      P.emit({ kind: 'fire', pos: pl, vel: _d.copy(vel).multiplyScalar(0.3), spread: 14 * Math.sqrt(s), jitter: s * 2, size: s * 3, grow: s * 2.5, life: air ? 4 : 1.5, heat: 1, drag: air ? 1 : 0 });
    }
    if (air) for (let i = 0; i < 36; i++) P.emit({ kind: 'soot', pos: pl, vel: _d.copy(vel).multiplyScalar(0.3), spread: 9 * Math.sqrt(s), jitter: s * 3, size: s * 3.5, grow: s * 1.6, life: 40, heat: 0.6 });
    for (let i = 0; i < 60; i++) P.emit({ kind: 'spark', pos: pl, vel: _d.copy(vel), spread: 60 * Math.sqrt(s), size: 0.3, life: 2.5, heat: 1, drag: air ? 0.6 : 0 });
    this.flash.position.copy(worldPos);
    this.flash.color.setRGB(1, 0.62, 0.3);
    this.flashI = 4e4 * s * s;
    this.flashMax = this.flashLife = 1.2;
    this.flash.intensity = this.flashI;
    this.flash.visible = true;
  }

  /**
   * Reaction-control puffs: short white jets from the thruster quads whenever the attitude
   * system commands torque with RCS enabled (or translation). In vacuum the gas flashes out
   * into a wide, fast-fading cone; in air it is a small, quickly dispersed puff.
   */
  private rcsPuffs(v: Vessel, dt: number): void {
    const c = v.controls;
    if (!c.rcs) return;
    const rot = Math.abs(c.pitch) + Math.abs(c.yaw) + Math.abs(c.roll);
    const trans = Math.abs(c.tx) + Math.abs(c.ty) + Math.abs(c.tz);
    if (rot + trans < 0.06) return;
    const P = this.particles;
    const vac = v.atm.pressure < 50;
    const vel = this.surfaceVelLocal(v, new Vector3());
    for (const a of v.assemblies) {
      const f = a.def.features?.rcs;
      if (!f || a.rcsFuel <= 0 || a.destroyed) continue;
      const y = a.bottomY + (a.topY - a.bottomY) * 0.72;
      const R = a.maxRadius + 0.08;
      for (let q = 0; q < 4; q++) {
        const ang = (q / 4) * Math.PI * 2 + Math.PI / 4;
        const cx = Math.cos(ang), cz = Math.sin(ang);
        // which nozzles of this quad fire: roll -> tangential, pitch/yaw -> radial (up/down pairs)
        const roll = c.roll * (q % 2 === 0 ? 1 : -1);
        const pitchYaw = (q < 2 ? c.pitch : -c.pitch) * 0.7 + (q % 3 === 0 ? c.yaw : -c.yaw) * 0.7;
        const fireT = Math.abs(roll) > 0.05, fireR = Math.abs(pitchYaw) > 0.05 || trans > 0.06;
        if (!fireT && !fireR) continue;
        const n = this.rate(`rcs${v.id}-${a.def.id}-${q}`, 42 * Math.min(1, rot + trans), dt);
        if (!n) continue;
        const base = this.vehiclePoint(v, _c.set(a.offX + cx * R, y, a.offZ + cz * R), new Vector3());
        const pl = P.toLocal(base, new Vector3());
        for (let i = 0; i < n; i++) {
          // jet direction in the vehicle frame
          const dir = fireT ? _e.set(-cz * Math.sign(roll), 0, cx * Math.sign(roll)) : _e.set(0, Math.sign(pitchYaw || 1), 0);
          const dw = P.dirToLocal(dir.applyQuaternion(v.rot), new Vector3()).normalize();
          P.emit({
            kind: 'vapor', pos: pl, vel: dw.multiplyScalar(vac ? 260 : 40).add(vel), spread: vac ? 90 : 6,
            size: 0.12, grow: vac ? 9 : 1.6, life: vac ? 0.28 : 0.6, opacity: vac ? 0.4 : 0.5, drag: vac ? 0 : 1,
          });
        }
      }
    }
  }

  /**
   * Solid auxiliary motors: the escape tower's canted nozzles (a ring of fire and a dense
   * white smoke trail as it drags the crew module clear) and the soft-landing retro-rockets
   * (a flash and a burst of dust under the capsule a moment before touchdown).
   */
  private auxMotors(v: Vessel, dt: number): void {
    const P = this.particles;
    const vel = this.surfaceVelLocal(v, new Vector3());
    const air = v.atm.pressure > 100;
    for (const b of v.auxBurns) {
      if (b.kind === 'escape') {
        const les = v.assemblies.find((a) => a.def.separation?.kind === 'les');
        if (!les) continue;
        const y = les.bottomY + (les.topY - les.bottomY) * 0.62;
        for (let k = 0; k < 4; k++) {
          const ang = (k / 4) * Math.PI * 2 + Math.PI / 4;
          const out = _e.set(Math.cos(ang), 0, Math.sin(ang));
          const nozzle = this.vehiclePoint(v, _c.set(les.offX + out.x * 0.45, y, les.offZ + out.z * 0.45), new Vector3());
          const pl = P.toLocal(nozzle, new Vector3());
          // jets canted ~35° outward from straight down
          const dirV = _d.set(out.x * 0.57, -0.82, out.z * 0.57).applyQuaternion(v.rot);
          const dl = P.dirToLocal(dirV, new Vector3()).normalize();
          const n = this.rate(`les${v.id}-${k}`, 70, dt);
          for (let i = 0; i < n; i++) {
            P.emit({ kind: 'fire', pos: pl, vel: dl.clone().multiplyScalar(260).add(vel), spread: 25, size: 0.6, grow: 5, life: 0.35, heat: 1, drag: air ? 1 : 0 });
            if (air) P.emit({ kind: 'srbsmoke', pos: pl, vel: dl.clone().multiplyScalar(90).add(vel.clone().multiplyScalar(0.6)), spread: 12, jitter: 0.4, size: 1.0, grow: 3.5, life: 14, opacity: 0.85, heat: 0.7 });
          }
        }
      } else {
        const sc = v.rootAssembly;
        const base = this.vehiclePoint(v, _c.set(sc.offX, sc.bottomY + 0.2, sc.offZ), new Vector3());
        const pl = P.toLocal(base, new Vector3());
        const down = P.dirToLocal(_d.set(0, -1, 0).applyQuaternion(v.rot), new Vector3()).normalize();
        const n = this.rate(`retro${v.id}`, 900, dt);
        for (let i = 0; i < n; i++) {
          P.emit({ kind: 'fire', pos: pl, vel: down.clone().multiplyScalar(120), spread: 60, jitter: sc.maxRadius * 0.6, size: 0.5, grow: 6, life: 0.3, heat: 1, drag: 1 });
          P.emit({ kind: v.splashed || v.atm.pressure <= 100 ? 'vapor' : 'dust', pos: pl, vel: down.clone().multiplyScalar(30), spread: 35, jitter: sc.maxRadius, size: 1.2, grow: 4, life: 5, opacity: 0.7, drag: 1 });
        }
      }
    }
  }

  /**
   * Aerodynamic break-up of a stage high in the atmosphere: a shower of incandescent fragments
   * streaking along the flight path, burning gobs of propellant and a brief flash. `velWorld`
   * is the debris velocity relative to the ground (world axes).
   */
  breakup(worldPos: Vector3, velWorld: Vector3, scale: number): void {
    if (!this.anchorBody) return;
    const P = this.particles;
    const pl = P.toLocal(worldPos, new Vector3());
    const vel = P.dirToLocal(velWorld, new Vector3());
    const s = Math.max(1, scale);
    const dense = this.anchorBody.atmosphereTop > 0;
    for (let i = 0; i < 120; i++) {
      // fragments shed at a fraction of the parent's speed, fanning out a little
      const k = 0.55 + Math.random() * 0.4;
      P.emit({ kind: 'spark', pos: pl, vel: _d.copy(vel).multiplyScalar(k), spread: 40 + s * 10, jitter: s * 2, size: 0.5 + Math.random() * 0.8, life: 3 + Math.random() * 4, heat: 1, drag: 0.35 });
    }
    for (let i = 0; i < 30; i++) P.emit({ kind: 'plasma', pos: pl, vel: _d.copy(vel).multiplyScalar(0.7), spread: 30, jitter: s * 3, size: s * 2.5, grow: s * 4, life: 1.2, heat: 1, drag: 0.4 });
    if (dense) for (let i = 0; i < 24; i++) P.emit({ kind: 'fire', pos: pl, vel: _d.copy(vel).multiplyScalar(0.5), spread: 18, jitter: s * 2, size: s * 2, grow: s * 2, life: 2.5, heat: 1, drag: 0.8 });
    if (dense) for (let i = 0; i < 18; i++) P.emit({ kind: 'soot', pos: pl, vel: _d.copy(vel).multiplyScalar(0.4), spread: 10, jitter: s * 3, size: s * 2.5, grow: s * 1.5, life: 30, heat: 0.5 });
    this.flash.position.copy(worldPos);
    this.flash.color.setRGB(1, 0.55, 0.35);
    this.flashI = 1.5e4 * s * s;
    this.flashMax = this.flashLife = 0.8;
    this.flash.intensity = this.flashI;
    this.flash.visible = true;
  }

  /** Glowing plasma wake behind an entry vehicle (called every frame while heating). */
  plasmaWake(v: Vessel, dt: number, intensity: number): void {
    if (!this.anchorBody || intensity < 0.05) return;
    const P = this.particles;
    const vel = this.surfaceVelLocal(v, new Vector3());
    const speed = vel.length();
    if (speed < 100) return;
    const dirV = _d.copy(vel).multiplyScalar(1 / speed);
    const centre = P.toLocal(this.vehiclePoint(v, _c.set(0, v.com.y, 0), new Vector3()), new Vector3());
    const r = v.rootAssembly.maxRadius;
    const n = this.rate(`plasma${v.id}`, 90 * intensity, dt);
    for (let i = 0; i < n; i++) {
      const back = r * (1 + Math.random() * 3);
      P.emit({ kind: 'plasma', pos: _e.copy(centre).addScaledVector(dirV, -back), vel: _b.copy(vel).multiplyScalar(0.92), spread: speed * 0.01, jitter: r * 0.8, size: r * (1.2 + intensity), grow: r * 2, life: 0.35, heat: Math.min(1, intensity), drag: 0 });
    }
  }

  clear(): void {
    this.particles.clear();
    this.trails.clear();
    this.flags.deluge = 0;
    this.flags.venting = 0;
  }
}

function smooth(a: number, b: number, x: number): number { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

function siteDir(c: LaunchComplex): [number, number, number] {
  const la = (c.site.lat * Math.PI) / 180, lo = (c.site.lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

void Color; void _q2;
