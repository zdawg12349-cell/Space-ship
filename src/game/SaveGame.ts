import { Quaternion, Vector3 } from 'three';
import type { Vessel } from '../physics/vessel';

/**
 * Local saves: campaign progress (completed missions, best results) and flight snapshots.
 * A snapshot stores the active vessel's state relative to its body — position, velocity,
 * attitude, attached assemblies with their propellant and deployables, staging progress and
 * mission time — which is enough to resume a coast, an orbit or a lunar descent.
 */

export interface Progress {
  completed: Record<string, { score: number; date: string; time: number }>;
  flights: number;
}

const PKEY = 'ascent.progress.v1';
const SKEY = 'ascent.save.v1';

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(PKEY);
    if (raw) return { completed: {}, flights: 0, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { completed: {}, flights: 0 };
}

export function saveProgress(p: Progress): void {
  try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export interface AssemblySnapshot {
  id: string;
  propellant: number;
  ablator: number;
  legs: number;
  fins: number;
  solar: number;
  chute: string;
  skinTemp: number;
  shieldTemp: number;
  engines: { armed: boolean; restartsLeft: number; srbBurned: number }[];
}

export interface FlightSnapshot {
  version: 1;
  savedAt: string;
  missionId?: string;
  vehicleId: string;
  siteId: string;
  weather: string;
  t: number;
  liftoffT: number;
  body: string;
  pos: number[];
  vel: number[];
  rot: number[];
  angVel: number[];
  stageIndex: number;
  assemblies: AssemblySnapshot[];
  landed: boolean;
  phase: string;
  milestones: string[];
  throttle: number;
  autopilot: string;
}

export function snapshotVessel(v: Vessel): Pick<FlightSnapshot, 'body' | 'pos' | 'vel' | 'rot' | 'angVel' | 'stageIndex' | 'assemblies' | 'landed'> {
  return {
    body: v.body.id,
    pos: v.pos.toArray(), vel: v.vel.toArray(), rot: v.rot.toArray(), angVel: v.angVel.toArray(),
    stageIndex: v.stageIndex,
    landed: v.landed,
    assemblies: v.assemblies.map((a) => ({
      id: a.id, propellant: a.propellant, ablator: a.ablator, legs: a.legsDeployed, fins: a.gridFinsDeployed, solar: a.solarDeployed, chute: a.chuteState,
      skinTemp: a.skinTemp, shieldTemp: a.shieldTemp, engines: a.engines.map((e) => ({ armed: e.armed, restartsLeft: e.restartsLeft, srbBurned: e.srbBurned })),
    })),
  };
}

/** Restore runtime state onto a vessel built from the same assemblies. */
export function restoreVessel(v: Vessel, s: FlightSnapshot): void {
  v.stageIndex = s.stageIndex;
  for (const as of s.assemblies) {
    const a = v.getAssembly(as.id);
    if (!a) continue;
    a.propellant = as.propellant;
    a.ablator = as.ablator;
    a.legsDeployed = a.legsTarget = as.legs;
    a.gridFinsDeployed = a.gridFinsTarget = as.fins;
    a.solarDeployed = a.solarTarget = as.solar;
    a.chuteState = as.chute as never;
    a.skinTemp = as.skinTemp;
    a.shieldTemp = as.shieldTemp;
    as.engines.forEach((es, i) => { const e = a.engines[i]; if (e) { e.armed = es.armed; e.restartsLeft = es.restartsLeft; e.srbBurned = es.srbBurned; } });
  }
  v.hasLiftedOff = true;
  // mass properties first (they move the centre of mass), then the saved state of that centre
  v.updateMassProperties();
  v.pos.fromArray(s.pos);
  v.vel.fromArray(s.vel);
  v.rot.fromArray(s.rot);
  v.angVel.fromArray(s.angVel);
  v.orbitDirty = true;
}

export function writeSnapshot(s: FlightSnapshot): boolean {
  try { localStorage.setItem(SKEY, JSON.stringify(s)); return true; } catch { return false; }
}

export function readSnapshot(): FlightSnapshot | null {
  try {
    const raw = localStorage.getItem(SKEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as FlightSnapshot;
    return s.version === 1 ? s : null;
  } catch { return null; }
}

export function clearSnapshot(): void { try { localStorage.removeItem(SKEY); } catch { /* ignore */ } }

void Quaternion; void Vector3;
