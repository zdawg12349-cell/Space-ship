import { Group, Quaternion, Vector3 } from 'three';
import type { AssemblyRuntime, Vessel } from '../../physics/vessel';
import type { VehicleDef } from '../../vehicles/types';
import { AssemblyVisual, buildVehicleVisual, setHinge, VehicleVisual } from './VehicleBuilder';
import { setSolarDeploy } from './VehicleParts';

/**
 * Keeps vehicle meshes in step with the physics: one render group per physics body, placed
 * camera-relative in double precision; assembly visuals migrate between groups as stages
 * separate. Animates gimbals, legs, fins, flaps, arrays, chutes and the surface state
 * (frost shedding, soot build-up, aerodynamic heating glow).
 */
export class VesselVisuals {
  readonly root = new Group();
  private byRuntime = new Map<AssemblyRuntime, AssemblyVisual>();
  private groups = new Map<Vessel, Group>();
  private vehicles: VehicleVisual[] = [];
  private _v = new Vector3();
  private _q = new Quaternion();
  private _air = new Vector3();

  constructor() { this.root.name = 'vessels'; }

  /** Build visuals for a freshly created vessel and bind them to its assembly runtimes. */
  attach(vessel: Vessel, def: VehicleDef, opts: { flightProven?: boolean } = {}): VehicleVisual {
    const vv = buildVehicleVisual(def);
    this.vehicles.push(vv);
    for (const a of vessel.assemblies) {
      const av = vv.assemblies.get(a.id);
      if (!av) continue;
      this.byRuntime.set(a, av);
      av.state.uFrost.value = av.cryo ? 1 : 0;
      if (opts.flightProven && a.def.recovery && a.def.recovery !== 'none') { av.state.uWear.value = 0.6; av.state.uSoot.value = 0.35; }
    }
    return vv;
  }

  visualOf(a: AssemblyRuntime): AssemblyVisual | undefined { return this.byRuntime.get(a); }

  /** Render group of a vessel (camera-relative placement, vehicle-frame orientation). */
  groupOf(v: Vessel): Group | undefined { return this.groups.get(v); }

  /** Remove everything (end of flight). */
  clear(): void {
    for (const g of this.groups.values()) this.root.remove(g);
    this.groups.clear();
    this.byRuntime.clear();
    this.vehicles = [];
  }

  /**
   * @param vessels all physics bodies
   * @param bodyPos function giving the heliocentric position of a vessel's reference body
   * @param cameraHelio camera position (heliocentric, metres)
   */
  sync(vessels: Vessel[], bodyPos: (v: Vessel) => Vector3, cameraHelio: Vector3, dt: number): void {
    const alive = new Set<Vessel>();
    for (const v of vessels) {
      if (!v.assemblies.some((a) => this.byRuntime.has(a))) continue;
      alive.add(v);
      let g = this.groups.get(v);
      if (!g) { g = new Group(); g.name = `vessel-${v.id}`; this.groups.set(v, g); this.root.add(g); }
      // camera-relative placement of the shared vehicle-frame origin
      v.originInertial(this._v).add(bodyPos(v)).sub(cameraHelio);
      g.position.copy(this._v);
      g.quaternion.copy(v.rot);
      g.visible = !v.destroyed;
      // airflow direction in the vehicle frame (for heating glow / chutes)
      this._q.copy(v.rot).invert();
      this._air.copy(v.telemetry.airVelocity).applyQuaternion(this._q);
      const airSpeed = this._air.length();
      if (airSpeed > 1e-3) this._air.multiplyScalar(1 / airSpeed); else this._air.set(0, -1, 0);
      for (const a of v.assemblies) {
        const av = this.byRuntime.get(a);
        if (!av) continue;
        if (av.group.parent !== g) g.add(av.group);
        av.group.visible = !a.destroyed;
        this.animateAssembly(v, a, av, dt);
      }
    }
    for (const [v, g] of this.groups) {
      if (!alive.has(v)) { this.root.remove(g); this.groups.delete(v); }
    }
  }

  private animateAssembly(v: Vessel, a: AssemblyRuntime, av: AssemblyVisual, dt: number): void {
    const st = av.state;
    st.uTime.value += dt;
    // engines: gimbal + nozzle temperature
    for (const ev of av.engines) {
      const e = a.engines[ev.index];
      if (!e) continue;
      const base = ev.pivot.userData.baseQuat as Quaternion | undefined;
      const gq = this._q.setFromAxisAngle(_Z, -e.gimbalX);
      const gq2 = _tmpQ.setFromAxisAngle(_X, e.gimbalZ);
      if (base) ev.pivot.quaternion.copy(base).multiply(gq).multiply(gq2);
      else ev.pivot.quaternion.copy(gq).multiply(gq2);
      ev.heat.value = e.temperature;
    }
    // soot build-up while engines burn (heavier for kerosene), frost sheds after liftoff
    let burning = 0;
    for (const e of a.engines) if (e.thrust > 0) burning = Math.max(burning, e.mount.spec.propellant === 'kerolox' ? 1 : e.mount.spec.propellant === 'solid' ? 0.6 : 0.3);
    st.uSoot.value = Math.min(1, st.uSoot.value + dt * burning * 0.006 * (v.telemetry.inAtmosphere ? 1 : 0.2));
    if (av.cryo) {
      if (v.hasLiftedOff) st.uFrost.value = Math.max(0, st.uFrost.value - dt * (0.012 + v.telemetry.dynamicPressure * 1.2e-6));
      if (a.propellantCapacity > 0 && a.propellant <= 0) st.uFrost.value = Math.max(0, st.uFrost.value - dt * 0.05);
    }
    st.uHeat.value = a.skinTemp;
    st.uShieldHeat.value = a.shieldTemp;
    (st.uHeatDir.value as Vector3).copy(this._air);
    if (a.shieldTemp > 1400 || a.skinTemp > 900) st.uChar.value = Math.min(1, st.uChar.value + dt * 0.01);
    // mechanisms
    for (const h of av.legs) setHinge(h, a.legsDeployed);
    for (const h of av.gridFins) setHinge(h, a.gridFinsDeployed, a.gridFinsDeployed > 0.95 ? v.controls.roll * 0.25 : 0);
    const flapCmd = v.telemetry.inAtmosphere ? 1 : 0;
    for (const h of av.flapsFwd) setHinge(h, flapCmd, -v.controls.pitch * 0.4 + v.controls.roll * 0.3);
    for (const h of av.flapsAft) setHinge(h, flapCmd, v.controls.pitch * 0.4 + v.controls.roll * 0.3);
    if (av.panels) setSolarDeploy(av.panels, a.solarDeployed);
    // parachutes: canopy streams opposite the airflow; inflation scales the canopy
    const showDrogue = a.chuteState === 'drogue' && a.drogueInflation > 0.01;
    const showMain = a.chuteState === 'main' && a.mainInflation > 0.01;
    const orient = (g: Group, k: number, i: number, n: number) => {
      // up = -airflow (canopy above the capsule when descending), slight cluster splay
      const up = _tmpV.copy(this._air).negate();
      if (n > 1) {
        const ang = (i / n) * Math.PI * 2;
        up.add(_tmpV2.set(Math.cos(ang) * 0.18, 0, Math.sin(ang) * 0.18)).normalize();
      }
      g.quaternion.setFromUnitVectors(_Y, up);
      const s = Math.max(0.05, k);
      g.scale.set(0.15 + 0.85 * s, 1, 0.15 + 0.85 * s);
    };
    av.drogues.forEach((c, i) => { c.group.visible = showDrogue; if (showDrogue) orient(c.group, a.drogueInflation, i, av.drogues.length); });
    av.mains.forEach((c, i) => { c.group.visible = showMain; if (showMain) orient(c.group, a.mainInflation, i, av.mains.length); });
  }
}

const _X = new Vector3(1, 0, 0);
const _Y = new Vector3(0, 1, 0);
const _Z = new Vector3(0, 0, 1);
const _tmpQ = new Quaternion();
const _tmpV = new Vector3();
const _tmpV2 = new Vector3();
