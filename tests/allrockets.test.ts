import { describe, expect, it } from 'vitest';
import { flyAscent, vesselOrbit } from './helpers';
import { LAUNCHERS } from '../src/vehicles/catalog';

describe('every launcher reaches orbit on orbit assist', () => {
  for (const def of LAUNCHERS) {
    it(def.id, () => {
      const target = def.targetOrbit ?? 220_000;
      const { v, world, g, log } = flyAscent(def.id, target, 2400);
      const o = vesselOrbit(v, world.t);
      const last = log[log.length - 1];
      const summary = `${def.id.padEnd(14)} ${v.destroyed ? 'DESTROYED: ' + v.destroyReason : g.phase} ap ${(o.ap / 1000).toFixed(0)} pe ${(o.pe / 1000).toFixed(0)} t=${last.t.toFixed(0)} stage ${v.stageIndex}/${v.staging.length} mass ${(v.mass / 1000).toFixed(1)}t maxQ ${(v.telemetry.maxQ / 1000).toFixed(1)}kPa dv_left ${v.deltaV().total.toFixed(0)}`;
      console.log(summary);
      expect(v.destroyed, summary).toBe(false);
      expect(o.pe, summary).toBeGreaterThan(140e3);
    });
  }
});
