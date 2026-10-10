import { Quaternion, Vector3 } from 'three';
import { keplerPropagate } from '../physics/orbit';
import { cd0ForShape, machDragFactor } from '../physics/aero';
import type { PhysicsEnv, Vessel } from '../physics/vessel';
import type { PhysicsWorld } from '../physics/world';
import { AttitudeController } from './attitude';

/**
 * Reusable-booster flight software: flip → boostback → coast → entry burn → grid-fin glide →
 * landing burn (hoverslam) → touchdown. Acts through throttle, attitude and engine selection
 * only; the booster's actual trajectory comes from the physics model.
 */

export interface LandingZone {
  id: string;
  name: string;
  /** body-fixed unit direction of the zone centre */
  dir: Vector3;
  /** surface height of the pad deck above the reference radius (m) */
  height: number;
  radius: number;
  kind: 'pad' | 'droneship' | 'tower';
  /** for tower catches: extra height of the catch arms above the deck */
  catchHeight?: number;
  occupied?: boolean;
}

export type RecoveryPhase = 'separation' | 'flip' | 'boostback' | 'coast' | 'entry' | 'glide' | 'landing' | 'landed' | 'lost';

const _r = new Vector3();
const _v = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();
const _wq = new Quaternion();
const _wp = new Vector3(), _wf = new Vector3(), _we = new Vector3(), _wu = new Vector3(), _wE = new Vector3(), _wN = new Vector3(), _ww = new Vector3();
const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();

export class BoosterGuidance {
  readonly att = new AttitudeController();
  phase: RecoveryPhase = 'separation';
  timer = 0;
  zone: LandingZone;
  /** predicted (vacuum ballistic) impact point, body-fixed unit direction */
  impact = new Vector3();
  missDistance = 0;
  rangeBias = 1.0;
  private announced = new Set<string>();
  onEvent: ((id: string) => void) | null = null;
  private landingIgnited = false;
  private bestMiss = Infinity;
  private lastMiss = -1;
  private missRate = 0;
  private lastPredT = 0;
  private legsDone = false;
  private entryDone = false;

  constructor(readonly vessel: Vessel, readonly world: PhysicsWorld, zone: LandingZone) {
    this.zone = zone;
    this.att.maxRate = 0.35;
    this.att.gain = 1.4;
    this.att.damping = 3.5;
    vessel.controls.rcs = true;
  }

  private say(id: string): void {
    if (this.announced.has(id)) return;
    this.announced.add(id);
    this.onEvent?.(id);
  }

  /** Zone centre, inertial position at time t (relative to the body centre). */
  zonePosition(t: number, out: Vector3): Vector3 {
    const body = this.vessel.body;
    body.orientationAt(t, _q);
    const h = this.zone.height + (this.zone.catchHeight ?? 0);
    return out.copy(this.zone.dir).multiplyScalar(body.radius + h).applyQuaternion(_q);
  }

  private predCache: { t: number; dir: Vector3; tof: number; qMax: number } | null = null;

  /**
   * Impact prediction with gravity, drag and the rotating atmosphere (point mass, RK2, 0.5 s steps).
   * Returns the body-fixed impact direction and time of flight.
   */
  predictImpact(t: number): { dir: Vector3; tof: number; qMax: number } {
    const cacheDt = this.phase === 'boostback' ? 0.04 : 0.2;
    if (this.predCache && Math.abs(t - this.predCache.t) < cacheDt) return this.predCache;
    const res = this.integrateImpact(t, null);
    this.impact.copy(res.dir);
    this.predCache = { t, dir: this.impact, tof: res.tof, qMax: res.qMax };
    return this.predCache;
  }

  private burnCache: { t: number; dir: Vector3; tof: number } | null = null;

  /**
   * Impact prediction that flies the entry burn too: retrograde at the three-engine thrust
   * (g-limited) once below `startAlt` and descending, until the airspeed falls to the burn's
   * cut-off speed or the propellant reserve is reached. The entry burn moves the impact point a
   * long way uprange on a shallow, fast descent, so stationing the drone ship and steering the
   * burn both need the burn's own effect included.
   */
  predictWithEntryBurn(t: number, startAlt: number): { dir: Vector3; tof: number } {
    if (this.burnCache && Math.abs(t - this.burnCache.t) < 0.25) return this.burnCache;
    const v = this.vessel;
    const entrySet = this.entryEngines(v);
    let thrust = 0;
    for (const e of entrySet) thrust += e.mount.spec.thrustVac;
    const dry = v.mass - v.stagePropellant().current;
    const reserve = dry * (Math.exp(450 / 3000) - 1);
    const usable = Math.max(0, v.stagePropellant().current - reserve);
    // Δv the burn can deliver before hitting the landing reserve
    let isp = 3000;
    for (const e of entrySet) isp = e.mount.spec.ispVac * 9.80665;
    const res = this.integrateImpact(t, { thrust, ve: isp, gMax: 5.5 * 9.80665, stopSpeed: this.entryStopSpeed, startAlt, propUsable: usable });
    this.burnCache = { t, dir: res.dir, tof: res.tof };
    return this.burnCache;
  }

  /** Point-mass impact integration (gravity, drag in the rotating atmosphere, optional retro burn). */
  private integrateImpact(t: number, burn: { thrust: number; ve: number; gMax: number; stopSpeed: number; startAlt: number; propUsable: number } | null): { dir: Vector3; tof: number; qMax: number; qMaxAfterBurn: number } {
    const v = this.vessel;
    const body = v.body;
    const R = body.radius + this.zone.height + (this.zone.catchHeight ?? 0);
    const atm = body.atmosphere;
    const sample = { pressure: 0, density: 0, temperature: 0, speedOfSound: 300 };
    body.angularVelocity(_b);
    const omega = _b.clone();
    const area = v.aero.refArea;
    const cdBase = 1.1; // engines-first blunt base
    const r = v.pos.clone();
    const vel = v.vel.clone();
    let tof = 0;
    // the burn's acceleration grows as propellant is used (until the g limit throttles it)
    let mass = v.mass;
    let propLeft = burn ? burn.propUsable : 0;
    let burnAcc = 0;
    let burning = false;
    let burnEnded = false;
    let qMax = 0, qMaxAfterBurn = 0;
    // the mean wind (jet stream, boundary layer) pushes a falling stage hundreds of metres
    const weather = this.world.weather;
    body.orientationAt(t, _wq);
    const pole = _wp.set(0, 0, 1).applyQuaternion(_wq);
    _wq.invert();
    const windAt = (rr: Vector3, rl: number, out: Vector3): Vector3 => {
      out.set(0, 0, 0);
      const alt = rl - body.radius;
      if (!atm || alt > 60_000) return out;
      const f = _wf.copy(rr).applyQuaternion(_wq);
      weather.windAt(body, Math.asin(Math.max(-1, Math.min(1, f.z / rl))), Math.atan2(f.y, f.x), alt, t, _we);
      const up = _wu.copy(rr).multiplyScalar(1 / rl);
      const east = _wE.crossVectors(pole, up);
      if (east.lengthSq() < 1e-12) return out;
      east.normalize();
      const north = _wN.crossVectors(up, east);
      return out.copy(east).multiplyScalar(_we.x).addScaledVector(north, _we.y).addScaledVector(up, _we.z);
    };
    const acc = (rr: Vector3, vv: Vector3, out: Vector3) => {
      const rl = rr.length();
      out.copy(rr).multiplyScalar(-body.gm / (rl * rl * rl));
      const vAir = _c.copy(vv).sub(_a.crossVectors(omega, rr)).sub(windAt(rr, rl, _ww));
      const sp = vAir.length();
      if (atm) {
        atm.sample(rl - body.radius, sample);
        if (sample.density > 0) {
          const qq = 0.5 * sample.density * sp * sp;
          qMax = Math.max(qMax, qq);
          if (burnEnded) qMaxAfterBurn = Math.max(qMaxAfterBurn, qq);
          const cd = cdBase * machDragFactor(sp / Math.max(1, sample.speedOfSound));
          out.addScaledVector(vAir, (-0.5 * sample.density * sp * cd * area) / mass);
        }
      }
      if (burning && sp > 1) out.addScaledVector(vAir, -burnAcc / sp);
      return out;
    };
    const a1 = new Vector3(), a2 = new Vector3(), rMid = new Vector3(), vMid = new Vector3();
    for (let i = 0; i < 2400 && r.length() > R; i++) {
      const alt = r.length() - body.radius;
      const h = alt > 80000 ? 2.0 : alt > 15000 ? 0.5 : 0.25;
      if (burn) {
        const sp = _c.copy(vel).sub(_a.crossVectors(omega, r)).length();
        const was = burning;
        // one continuous burn: once it has ended it does not relight when the fall speeds up again
        burning = !burnEnded && propLeft > 0 && alt < burn.startAlt && r.dot(vel) < 0 && sp > burn.stopSpeed;
        // the fall "after the burn" also covers a burn that never runs (already below its stop speed)
        if (!burning && (was || sp <= burn.stopSpeed)) burnEnded = true;
        if (burning) {
          burnAcc = Math.min(burn.thrust / mass, burn.gMax);
          const used = ((burnAcc * mass) / burn.ve) * h;
          propLeft -= used;
          mass -= used;
        }
      }
      acc(r, vel, a1);
      rMid.copy(r).addScaledVector(vel, h * 0.5);
      vMid.copy(vel).addScaledVector(a1, h * 0.5);
      acc(rMid, vMid, a2);
      r.addScaledVector(vMid, h);
      vel.addScaledVector(a2, h);
      tof += h;
    }
    body.orientationAt(t + tof, _q);
    const dir = r.applyQuaternion(_q.invert()).normalize();
    return { dir, tof, qMax, qMaxAfterBurn };
  }

  /**
   * Drone ships hold station where the stage will come down. Called at separation: move the
   * zone onto the booster's predicted (drag-corrected) impact point, pulled back along the
   * track by a few percent of the remaining range to leave room for the entry burn, which
   * shortens the trajectory. Returns the new zone direction (body-fixed).
   */
  stationAtImpact(t: number): Vector3 | null {
    if (this.zone.kind !== 'droneship') return null;
    // (a freshly separated stage has no telemetry yet: use its state vector)
    const sp = this.vessel.surfaceVelocity(new Vector3()).length();
    const p = this.predictWithEntryBurn(t, sp > 2600 ? 78000 : sp > 2000 ? 70000 : 62000).dir.clone();
    this.zone.dir.copy(p);
    this.predCache = null;
    this.burnCache = null;
    return p;
  }

  update(v: Vessel, dt: number, env: PhysicsEnv): void {
    if (v.destroyed) { if (this.phase !== 'lost') { this.phase = 'lost'; this.say('booster_lost'); } return; }
    if (v.landed || this.phase === 'landed') {
      if (v.landed && !this.announced.has('booster_landed')) this.say('booster_landed');
      this.phase = 'landed';
      const c = v.controls;
      c.throttle = 0; c.pitch = 0; c.yaw = 0; c.roll = 0; c.rcs = false; c.engineMask = null;
      for (const e of v.engines) e.armed = false;
      return;
    }
    this.timer += dt;
    const t = env.t;
    const tm = v.telemetry;
    const body = v.body;
    v.enuBasis(_e, _n, _u);
    const zonePos = this.zonePosition(t, new Vector3());
    const toZone = zonePos.clone().sub(v.pos);
    const toZoneH = toZone.clone().addScaledVector(_u, -toZone.dot(_u));
    const distH = toZoneH.length();
    const alt = v.pos.length() - body.radius - (this.zone.height + (this.zone.catchHeight ?? 0));
    const ctl = v.controls;
    const engines = v.engines;
    const { three, landing: landEngines, boost: boost3 } = this.engineSets(engines);

    // predicted impact vs zone
    const pred = this.predictImpact(t);
    const zDir = this.zone.dir;
    const miss = Math.acos(Math.max(-1, Math.min(1, pred.dir.dot(zDir)))) * body.radius;
    this.missDistance = miss;

    const vSurf = v.surfaceVelocity(new Vector3());
    // attitude references follow the airflow, not the ground: a 45 m/s jet stream across a
    // 700 m/s descent is a 3.7° angle of attack the structure has to carry
    const vAirW = tm.airVelocity.lengthSq() > 1 ? tm.airVelocity.clone() : vSurf.clone();
    const retro = vAirW.clone().normalize().negate();

    switch (this.phase) {
      case 'separation': {
        ctl.throttle = 0;
        this.att.killRotation(v);
        // drone-ship stages coast straight to the ship stationed under their trajectory
        if (this.timer > 3) { this.phase = this.zone.kind === 'droneship' ? 'coast' : 'flip'; this.timer = 0; }
        break;
      }
      case 'flip': {
        // point engines back toward the zone: thrust direction = horizontal toward zone + loft
        const dir = this.boostbackDirection(pred.dir, new Vector3());
        this.att.update(v, { dir }, dt);
        ctl.throttle = 0;
        // cold-gas thrusters alone turn a 90-tonne stage slowly: once roughly aligned, light
        // the engines and let the gimbals finish the flip (the burn throttles low until aligned)
        if ((this.att.error < 0.3 && v.angVel.length() < 0.08) || (this.att.error < 1.2 && this.timer > 6) || this.timer > 45) {
          this.phase = 'boostback';
          this.timer = 0;
          this.arm(boost3);
          this.say('boostback_start');
        }
        break;
      }
      case 'boostback': {
        const dir = this.boostbackDirection(pred.dir, new Vector3());
        this.att.update(v, { dir }, dt);
        // fine trim at the end of the burn: drop to the single centre engine at minimum throttle
        const fine = miss < 12000;
        const set = fine ? landEngines : boost3;
        ctl.engineMask = new Set(set);
        ctl.throttle = fine ? 0.4 : (this.att.error < 0.25 ? 1 : 0.4) * this.gLimitThrottle(v, boost3, 5);
        if (fine) for (const e of set) e.armed = true;
        // extrapolate the miss between predictions to time the cutoff precisely
        const dMiss = this.lastMiss >= 0 ? (miss - this.lastMiss) : 0;
        if (dMiss !== 0 && this.predCache && this.predCache.t !== this.lastPredT) { this.missRate = dMiss / Math.max(1e-3, this.predCache.t - this.lastPredT); this.lastPredT = this.predCache.t; }
        this.lastMiss = miss;
        const projected = miss + this.missRate * (t - this.lastPredT);
        if (miss < this.bestMiss) this.bestMiss = miss;
        const along = this.alongTrack(pred.dir);
        const done = (Math.min(miss, projected) < 60 && this.timer > 3) || (this.bestMiss < 3000 && miss > this.bestMiss + 40) || (along > 300 && this.timer > 3);
        if (done) {
          ctl.throttle = 0;
          this.phase = 'coast';
          this.timer = 0;
          this.say('boostback_end');
        }
        if (!v.stagePropellant().current) { this.phase = 'coast'; }
        break;
      }
      case 'coast': {
        ctl.throttle = 0;
        ctl.engineMask = null;
        // engines-first: the nose (+Y) points along retrograde so the engine end leads
        this.att.update(v, { dir: retro }, dt);
        if (this.timer > 5) for (const a of v.assemblies) if (a.def.features?.gridFins && a.gridFinsTarget === 0) { a.gridFinsTarget = 1; v.events.push({ type: 'gridfins' }); this.say('gridfins'); }
        // entry burn: above ~60 km heading down fast (higher still for very fast stages, so
        // the burn finishes before the air gets thick)
        const entryAlt = tm.speedSurface > 2600 ? 78000 : tm.speedSurface > 2000 ? 70000 : 62000;
        if (!this.entryDone && tm.verticalSpeed < 0 && alt < entryAlt && tm.speedSurface > 1300) {
          this.phase = 'entry'; this.timer = 0; this.arm(this.entryEngines(v)); this.say('entry_burn_start');
          this.planEntryStop(t);
        }
        if (alt < 45000 && tm.verticalSpeed < 0 && (this.entryDone || tm.speedSurface <= 1300)) { this.phase = 'glide'; this.timer = 0; }
        break;
      }
      case 'entry': {
        // retrograde, tilted so the burn also steers the predicted impact onto the zone
        // Steering error. On a steep return to the launch site the ballistic impact is a good
        // guide; on a fast, shallow descent to the ship the burn itself moves the impact point a
        // long way, so steer on where the stage will come down once this burn is finished.
        const ship = this.zone.kind === 'droneship';
        // a hard-braking burn (a heavy booster on many engines) moves the impact point fast as well
        const burnAware = ship || this.entryGain < 1;
        let errE: Vector3;
        if (burnAware) {
          const pb = this.predictWithEntryBurn(t, Infinity);
          body.orientationAt(t, _q);
          errE = zonePos.clone().sub(_d.copy(pb.dir).multiplyScalar(body.radius + this.zone.height).applyQuaternion(_q));
        } else errE = zonePos.clone().sub(this.predictedPointInertial(t, pred.tof));
        errE.addScaledVector(_u, -errE.dot(_u));
        const em = errE.length();
        const burnDir = retro.clone();
        // the tilt is an angle of attack: keep it inside the unpowered q·α budget, which is what the
        // structure is left with the moment the burn ends
        const tiltMax = Math.tan(Math.max(0.5, Math.min(35, 190000 / Math.max(1, tm.dynamicPressure))) * Math.PI / 180);
        if (em > 15) burnDir.addScaledVector(errE.normalize(), Math.min(tiltMax, ship ? Math.min(0.3, em / 3000) : Math.min(0.6 * this.entryGain, em / (1200 / this.entryGain)))).normalize();
        this.att.update(v, { dir: burnDir }, dt);
        const entrySet = this.entryEngines(v);
        ctl.engineMask = new Set(entrySet);
        ctl.throttle = (this.att.error < 0.2 ? 1 : 0.4) * this.gLimitThrottle(v, entrySet, 5.5);
        // burn down toward ~650 m/s — and on, for a dense stage, until the fall that follows stays
        // inside the dynamic-pressure limit — but keep enough propellant for the landing burn
        const dry = v.mass - v.stagePropellant().current;
        const landingReserve = dry * (Math.exp(450 / 3000) - 1);
        // the stop speed is re-planned from the current state twice a second and used both by the
        // steering's burn model and for the cutoff, so the burn ends where the steering expects
        if (t - this.entryPlanT > 0.5) { this.planEntryStop(t); this.entryPlanT = t; }
        const slowEnough = tm.speedSurface < this.entryStopSpeed;
        if (slowEnough || v.stagePropellant().current < landingReserve || this.timer > 75) {
          ctl.throttle = 0; this.entryDone = true; this.phase = 'glide'; this.timer = 0; this.say('entry_burn_end');
        }
        break;
      }
      case 'glide': {
        ctl.throttle = 0;
        ctl.engineMask = null;
        // Engines-first with a small angle of attack that moves the impact point toward the zone.
        // A stage falling end-first is a blunt body: at small angles the tilted axial drag beats
        // the cross-flow and the lift points away from the leading end's tilt; past a few degrees
        // the cross-flow wins and it points toward it. Use the stage's own lift curve to choose the
        // tilt (and which way to lean) that pushes hardest toward the zone.
        const lead = vAirW.clone().normalize();
        const errH = zonePos.clone().sub(this.predictedPointInertial(t, pred.tof));
        errH.addScaledVector(_u, -errH.dot(_u));
        const errMag = errH.length();
        // steering authority up to ~80% of the structural q·α limit (gusts and the attitude loop's
        // overshoot use the rest)
        const maxA = Math.max(0.5, Math.min(12, 175000 / Math.max(1, tm.dynamicPressure))) * Math.PI / 180;
        if (errMag > 1) {
          const k = Math.min(1, errMag / 90);
          const cdAx = cd0ForShape(v.aero.bottomShape) * machDragFactor(tm.mach);
          let dNeg = 0, lNeg = 0, dZero = maxA;
          for (let i = 1; i <= 16; i++) {
            const d = (maxA * i) / 16;
            const l = this.liftPerQ(v, d, cdAx);
            if (l < lNeg) { lNeg = l; dNeg = d; }
            if (l < 0) dZero = Math.min(maxA, (maxA * (i + 1)) / 16);
          }
          const lMax = this.liftPerQ(v, maxA, cdAx);
          const toward = lMax > 0 && lMax >= -lNeg;
          const tilt = toward ? dZero + (maxA - dZero) * k : dNeg * k;
          lead.addScaledVector(errH.normalize(), (toward ? 1 : -1) * Math.tan(tilt)).normalize();
        }
        // nose = -lead (engines lead)
        this.att.update(v, { dir: lead.clone().negate() }, dt);
        // landing burn trigger (hoverslam)
        if (this.shouldIgniteLanding(v, alt, landEngines)) {
          this.phase = 'landing'; this.timer = 0; this.arm(landEngines); this.landingIgnited = true; this.say('landing_burn');
        }
        break;
      }
      case 'landing': {
        ctl.engineMask = new Set(landEngines);
        const vz = tm.verticalSpeed;
        const g = body.gm / v.pos.lengthSq();
        const h = Math.max(0.5, alt - this.footClearance(v) - 0.6);
        let thrustMax = 0;
        for (const e of landEngines) thrustMax += e.mount.spec.thrustSL + (e.mount.spec.thrustVac - e.mount.spec.thrustSL) * (1 - Math.min(1, tm.pressure / 101325));
        // A tower catch has no legs to land on and a booster that can throttle down to hover: it
        // brakes to a gate 40 m above the catch point with its drift nulled, then descends slowly
        // and vertically into the arms while a position loop holds it over them (pausing while it
        // is off-centre). Landings on legs fly the hoverslam all the way down.
        const tower = this.zone.kind === 'tower';
        const gateH = tower ? 40 : 0;
        const terminal = tower && h <= gateH + 5;
        const vh = vSurf.clone().addScaledVector(_u, -vSurf.dot(_u));
        const posErr = toZoneH.clone();
        let aReq: number;
        let latCmd: Vector3;
        if (terminal) {
          const centred = distH < 8;
          const vzCmd = centred ? (h > 10 ? -2.5 : -1.2) : h > 12 ? -1 : 0;
          aReq = Math.max(0, g + (vzCmd - vz) * 1.5);
          // a gentle, speed-limited position loop with bandwidth well inside the booster's attitude
          // response (a faster loop swings it to and fro across the arms)
          const pe = posErr.length();
          const vDes = pe > 0.01 ? posErr.clone().multiplyScalar(Math.min(pe * 0.15, 4) / pe) : new Vector3();
          latCmd = vDes.sub(vh).multiplyScalar(0.5);
        } else {
          // required vertical deceleration to stop at the deck (or reach the gate), drag still helping
          const hg = Math.max(0.5, h - gateH);
          const vEnd = tower ? 2.5 : 0;
          aReq = vz < 0 ? Math.max(0, (vz * vz - vEnd * vEnd) / (2 * hg) + g - 0.5 * this.dragAccel(v)) : g * 0.6;
          // horizontal: terminal guidance that arrives over the pad (or the gate) with zero drift
          // exactly then (time-to-go from the vertical channel); a landing's last seconds only kill drift
          const tgo = vz < -1 ? Math.max(1.5, (2 * hg) / (-vz + vEnd)) : 3;
          if (tower) {
            // to the gate: zero-miss guidance with a floor on time-to-go, so the gains stay within
            // what a slow-turning booster can follow (the gate's terminal loop finishes the job)
            const tg = Math.max(8, tgo);
            latCmd = posErr.multiplyScalar(6 / (tg * tg)).addScaledVector(vh, -4 / tg);
          } else {
            const zemTo = tgo > 4 && h > 40;
            latCmd = zemTo
              ? posErr.multiplyScalar(6 / (tgo * tgo)).addScaledVector(vh, -4 / tgo)
              : vh.clone().multiplyScalar(-1.2);
          }
        }
        // divert authority limited by thrust and, while q is high, by the structural AoA limit
        const qNow = Math.max(1, tm.dynamicPressure);
        // (firing into the flow relieves bending loads, so the burn may tilt further than the glide)
        // close to the ground the stage must be upright for the legs to take the load evenly
        const tiltCap = tower ? 18 : h < 80 ? 1.5 + (h / 80) * 8 : 20;
        // until the engines have spooled up there is no plume to relieve the loads
        const powered = tm.thrust > 0.3 * (thrustMax / Math.max(1, landEngines.length)) * (this.landCount || landEngines.length);
        const maxTilt = Math.min(tiltCap, Math.max(powered ? 4 : 0.5, Math.min(20, (powered ? 420000 : 175000) / qNow))) * Math.PI / 180;
        const latMax = Math.min(0.5 * aReq, Math.tan(maxTilt) * aReq);
        if (latCmd.length() > latMax) latCmd.setLength(latMax);
        if (tower) {
          // a 70 m booster turns slowly: smooth the lateral command to its attitude bandwidth so the
          // thrust direction never runs away from the vehicle
          this.latFilt.lerp(latCmd, Math.min(1, dt / 1.2));
          latCmd.copy(this.latFilt);
        }
        const thrustDir = _u.clone().multiplyScalar(aReq).add(latCmd);
        const aCmd = thrustDir.length();
        thrustDir.normalize();
        // until the plume shields it, the stage carries the airflow's full bending load: stay in line
        // with it while the engines spool up (high up, where q is still large)
        if (!powered && qNow > 8000) thrustDir.copy(retro);
        this.att.update(v, { dir: thrustDir }, dt);
        // run as many of the landing engines as the thrust needed keeps above their minimum
        // throttle: a nearly empty booster can't hover on three engines whose floor alone
        // out-lifts its weight (it would stop high, climb and burn its last propellant)
        const need = aCmd * v.mass;
        const per = thrustMax / Math.max(1, landEngines.length);
        const minT = landEngines.reduce((m, e) => Math.max(m, e.mount.spec.minThrottle), 0);
        // (hysteresis: drop an engine only when the rest would still have margin, so a hover
        // doesn't flip engines on and off — each relight spends one of their restarts)
        const sets = this.engineSets(engines);
        // the fewest engines that can run balanced: one only with a centre engine, two only as an
        // opposed pair; otherwise the full landing set
        const nMin = landEngines.length === 1 || sets.center ? 1 : sets.pair ? 2 : landEngines.length;
        // engines relight with a spool-up of a few seconds and a limited number of restarts: change
        // the set rarely (a lockout after each change) and only add engines when the set is at full
        // throttle
        const prevN = Math.min(this.landCount || landEngines.length, landEngines.length);
        let n = prevN;
        if (t - this.landSwitchT > 5) {
          while (n > nMin && need < n * per * minT * 1.15 && need < (n - 1) * per * 0.8) n--;
          while (n < landEngines.length && need > n * per * 0.97) n++;
        } else if (n < landEngines.length && need > n * per * 1.25) n++;
        if (n !== prevN) this.landSwitchT = t;
        this.landCount = n;
        const active = n >= landEngines.length ? landEngines : n === 1 && sets.center ? [sets.center] : n === 2 && sets.pair ? sets.pair : landEngines.slice(0, n);
        ctl.engineMask = new Set(active);
        for (const e of active) e.armed = true;
        let thr = need / Math.max(1, per * n);
        ctl.throttle = Math.max(0.01, Math.min(1, thr));
        // touchdown: shut the engine down and let the legs take the load (a tower catch keeps
        // flying until the arms have it)
        if (v.contactForce > 0 || (!tower && (h < 0.25 || (vz > -0.6 && h < 2.5)))) {
          ctl.throttle = 0;
          for (const e of v.engines) e.armed = false;
          this.phase = 'landed';
        }
        if (!this.legsDone && h < 900) {
          for (const a of v.assemblies) if (a.def.features?.landingLegs) a.legsTarget = 1;
          this.legsDone = true;
          v.events.push({ type: 'legs' });
          this.say('legs_deploy');
        }
        this.landingInfo = `h ${h.toFixed(1)} distH ${distH.toFixed(1)} vz ${vz.toFixed(1)} vh ${vh.length().toFixed(1)}${terminal ? ' terminal' : ''} engines ${n} thr ${ctl.throttle.toFixed(2)}`;
        if (tower && h < 6 && Math.abs(vz) < 3 && distH < 25) this.catchAtTower(v, t);
        break;
      }
    }
    void distH;
  }

  private sets: { three: Vessel['engines']; landing: Vessel['engines']; boost: Vessel['engines']; pair: Vessel['engines'] | null; center: Vessel['engines'][number] | null } | null = null;

  /**
   * Engine subsets: a three-engine set (centre + two opposite) for the entry burn, the boostback set
   * (the engines a vehicle marks for it — a 33-engine booster turns back on its 13 inner engines —
   * otherwise the three) and the landing set.
   */
  private engineSets(engines: Vessel['engines']): { three: Vessel['engines']; landing: Vessel['engines']; boost: Vessel['engines']; pair: Vessel['engines'] | null; center: Vessel['engines'][number] | null } {
    if (this.sets) return this.sets;
    const dist = (e: Vessel['engines'][number]) => Math.hypot(e.mount.pos[0], e.mount.pos[2]);
    const sorted = [...engines].sort((a, b) => dist(a) - dist(b));
    let three: Vessel['engines'];
    const inner = engines.filter((e) => e.mount.group === 'inner');
    if (inner.length >= 3) three = inner.slice(0, 3);
    else if (sorted.length >= 3 && dist(sorted[0]) < 0.3) {
      const c = sorted[0];
      const ring = sorted.slice(1).filter((e) => Math.abs(dist(e) - dist(sorted[1])) < 0.2);
      const a = ring[0];
      let b = ring[1] ?? sorted[2];
      let best = -Infinity;
      for (const r of ring) {
        const d = Math.hypot(r.mount.pos[0] - a.mount.pos[0], r.mount.pos[2] - a.mount.pos[2]);
        if (d > best) { best = d; b = r; }
      }
      three = [c, a, b];
    } else three = sorted.slice(0, Math.min(3, sorted.length));
    const landing = inner.length >= 3 ? inner.slice(0, 3) : dist(sorted[0]) < 0.3 ? [sorted[0]] : sorted.slice(0, Math.min(2, sorted.length));
    const marked = engines.filter((e) => e.mount.roles?.includes('boostback'));
    // for a two-engine hover: an opposed pair (thrust on the axis, no torque for the gimbals to fight)
    const pool = engines.filter((e) => e.mount.roles?.includes('landing') || landing.includes(e));
    let pair: Vessel['engines'] | null = null;
    let bestPair = Infinity;
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i].mount.pos, b = pool[j].mount.pos;
      const off = Math.hypot(a[0] + b[0], a[2] + b[2]) + Math.abs(Math.hypot(a[0], a[2]) - Math.hypot(b[0], b[2]));
      const r = Math.hypot(a[0], a[2]);
      if (off < 0.05 && r < bestPair) { bestPair = r; pair = [pool[i], pool[j]]; }
    }
    const center = sorted.length && dist(sorted[0]) < 0.3 ? sorted[0] : null;
    this.sets = { three, landing, boost: marked.length >= 3 ? marked : three, pair, center };
    return this.sets;
  }

  private entrySet: Vessel['engines'] | null = null;
  /** airspeed at which the entry burn ends (the predictor and the burn share it) */
  private entryStopSpeed = 650;
  private entryPlanT = -Infinity;

  /**
   * Choose where the entry burn ends: ~650 m/s, or slower for a dense stage, so that the fall
   * that follows stays under ~70 kPa. Searched once at burn start by flying the burn and the fall.
   */
  private planEntryStop(t: number): void {
    const v = this.vessel;
    const entrySet = this.entryEngines(v);
    let thrust = 0, isp = 3000;
    for (const e of entrySet) { thrust += e.mount.spec.thrustVac; isp = e.mount.spec.ispVac * 9.80665; }
    const dry = v.mass - v.stagePropellant().current;
    const usable = Math.max(0, v.stagePropellant().current - dry * (Math.exp(450 / 3000) - 1));
    const fly = (stop: number) => this.integrateImpact(t, { thrust, ve: isp, gMax: 5.5 * 9.80665, stopSpeed: stop, startAlt: Infinity, propUsable: usable }).qMaxAfterBurn;
    // (62 kPa planned against a 90 kPa structure: the model is simpler than the flight)
    const prev = this.entryStopSpeed;
    if (fly(650) <= 62000) this.entryStopSpeed = 650;
    else {
      let lo = 250, hi = 650;
      for (let i = 0; i < 8; i++) { const mid = 0.5 * (lo + hi); if (fly(mid) <= 62000) lo = mid; else hi = mid; }
      this.entryStopSpeed = lo;
    }
    if (this.entryStopSpeed !== prev) this.burnCache = null;
  }
  /** landing-burn state for the HUD and diagnostics */
  landingInfo = '';
  private latFilt = new Vector3();
  private landSwitchT = -Infinity;
  /** landing-burn engines in use (0 = not chosen yet) */
  private landCount = 0;
  /** steering gain of the entry burn: a hard-braking burn moves the ballistic impact point quickly */
  private entryGain = 1;

  /**
   * Entry-burn engines: the three-engine set, unless it can't reach ~4 g on this stage (a heavy
   * booster with many smaller engines), in which case the boostback set does the job.
   */
  private entryEngines(v: Vessel): Vessel['engines'] {
    if (this.entrySet) return this.entrySet;
    const { three, boost } = this.engineSets(v.engines);
    let thrust = 0;
    for (const e of three) thrust += e.mount.spec.thrustVac;
    this.entrySet = thrust / v.mass < 4 * 9.80665 && boost.length > three.length ? boost : three;
    if (this.entrySet === boost && boost !== three) this.entryGain = 0.35;
    return this.entrySet;
  }

  /** throttle factor that keeps the burn under `gMax` g */
  private gLimitThrottle(v: Vessel, engines: { mount: { spec: { thrustVac: number } } }[], gMax: number): number {
    let t = 0;
    for (const e of engines) t += e.mount.spec.thrustVac;
    if (t <= 0) return 1;
    return Math.min(1, (gMax * 9.80665 * v.mass) / t);
  }

  private footClearance(v: Vessel): number {
    // distance from CoM to the lowest point (legs or engine bells)
    return v.com.y - v.lowestY();
  }

  private arm(list: { armed: boolean }[]): void { for (const e of list) e.armed = true; }

  /** signed along-track distance of the impact point past (+) / short of (-) the zone */
  private alongTrack(impactDir: Vector3): number {
    const body = this.vessel.body;
    const z = this.zone.dir;
    // track direction: from the current sub-vessel point toward the zone
    const here = this.vessel.fixedDirection(this.world.t, new Vector3());
    const track = z.clone().sub(here);
    track.addScaledVector(z, -track.dot(z));
    if (track.lengthSq() < 1e-12) return 0;
    track.normalize();
    const d = impactDir.clone().sub(z);
    return d.dot(track) * body.radius;
  }

  private boostbackDirection(impactDir: Vector3, out: Vector3): Vector3 {
    // horizontal direction (inertial) from the predicted impact toward the zone, lofted 12°
    const body = this.vessel.body;
    body.orientationAt(this.world.t, _q);
    const z = this.zone.dir.clone().applyQuaternion(_q);
    const p = impactDir.clone().applyQuaternion(_q);
    const d = z.sub(p);
    this.vessel.enuBasis(_e, _n, _u);
    d.addScaledVector(_u, -d.dot(_u));
    if (d.lengthSq() < 1e-12) d.copy(this.vessel.vel).negate();
    d.normalize();
    return out.copy(d).multiplyScalar(Math.cos(0.21)).addScaledVector(_u, Math.sin(0.21)).normalize();
  }

  private predictedPointInertial(t: number, tof: number): Vector3 {
    const body = this.vessel.body;
    body.orientationAt(t, _q);
    return this.impact.clone().multiplyScalar(body.radius + this.zone.height).applyQuaternion(_q);
  }

  /**
   * Lift per unit dynamic pressure (N/Pa, positive toward the leading end's tilt) for engines-first
   * flight at angle of attack `d`, from the same normal-force and cross-flow terms the vessel's
   * aerodynamics use, minus the sideways share of the tilted axial drag.
   */
  private liftPerQ(v: Vessel, d: number, cdAx: number): number {
    const a = v.aero;
    let cn = 0, side = 0;
    for (const el of a.elements) { cn += el.cnAlpha; side += el.sideArea; }
    const sn = Math.sin(d), cs = Math.cos(d);
    const normal = cn * a.refArea * cs * sn + 1.2 * side * sn * sn;
    return normal * cs - cdAx * a.refArea * cs * sn;
  }

  /** current aerodynamic deceleration estimate (engines-first, Cd ≈ 1) */
  private dragAccel(v: Vessel): number {
    return (v.telemetry.dynamicPressure * v.aero.refArea * 1.0) / v.mass;
  }

  private shouldIgniteLanding(v: Vessel, alt: number, engines: { mount: { spec: { thrustSL: number; thrustVac: number } } }[]): boolean {
    const tm = v.telemetry;
    if (tm.verticalSpeed >= 0) return false;
    const h = alt - this.footClearance(v);
    if (h > 9000) return false; // still decelerating aerodynamically toward terminal velocity
    const g = v.body.gm / v.pos.lengthSq();
    let thrust = 0;
    for (const e of engines) thrust += e.mount.spec.thrustSL;
    const aMax = thrust / v.mass;
    const vz = -tm.verticalSpeed;
    // drag keeps helping during the burn; count roughly half of today's value
    const aReq = (vz * vz) / (2 * Math.max(1, h)) + g - 0.5 * this.dragAccel(v);
    return aReq > 0.72 * aMax || h < 150;
  }

  private catchAtTower(v: Vessel, t: number): void {
    v.controls.throttle = 0;
    v.settleLanded(t, false);
    this.say('booster_landed');
  }
}
