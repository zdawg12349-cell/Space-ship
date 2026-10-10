import { Vector3 } from 'three';
import type { LandingZone } from '../game/recovery';
import type { VehicleDef } from '../vehicles/types';
import { LaunchSite, offsetDir } from './sites';

/**
 * Recovery infrastructure per launch site: concrete landing pads near the coast (return to
 * launch site), an autonomous drone ship downrange, and the tower itself for vehicles caught
 * by the launch-tower arms.
 */

export interface ZoneSpec extends LandingZone {
  /** local offset from the pad (m east, m north) for visuals */
  east: number;
  north: number;
}

export function landingZonesFor(site: LaunchSite, def: VehicleDef, launchAzimuthRad: number, heightAt: (dir: Vector3) => number): ZoneSpec[] {
  const zones: ZoneSpec[] = [];
  const mk = (id: string, name: string, east: number, north: number, kind: LandingZone['kind'], extra: Partial<ZoneSpec> = {}): ZoneSpec => {
    const d = offsetDir(site, east, north);
    const dir = new Vector3(d[0], d[1], d[2]);
    return { id, name, dir, height: heightAt(dir) + (kind === 'droneship' ? 2.5 : 0.3), radius: kind === 'tower' ? 12 : 45, kind, east, north, ...extra };
  };
  const recoverable = def.assemblies.filter((a) => a.recovery && a.recovery !== 'none');
  if (!recoverable.length) return zones;
  if (def.id === 'leviathan') {
    // booster returns to the tower and is caught by the arms
    zones.push(mk('TOWER', 'Launch tower catch', 0, 0, 'tower', { catchHeight: 75 }));
    return zones;
  }
  const [lzE, lzN] = site.lz;
  const rtls = recoverable.filter((a) => a.recovery === 'rtls');
  rtls.forEach((_, i) => zones.push(mk(`LZ-${i + 1}`, `Landing Zone ${i + 1}`, lzE + i * 380, lzN - i * 120, 'pad')));
  if (recoverable.some((a) => a.recovery === 'droneship') && !site.inland) {
    // ~600 km downrange along the launch azimuth, at sea
    const dist = 610_000;
    zones.push(mk('ASDS', 'Drone ship "Tidewater Resolve"', Math.sin(launchAzimuthRad) * dist, Math.cos(launchAzimuthRad) * dist, 'droneship'));
  }
  return zones;
}
