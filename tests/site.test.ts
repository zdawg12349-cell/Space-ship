import { describe, expect, it } from 'vitest';
import { type InstancedMesh, type Material, Matrix4, type Mesh, Vector3 } from 'three';
import { LaunchComplex } from '../src/render/site/LaunchComplex';
import { getVehicle } from '../src/vehicles/catalog';
import { LAUNCH_SITES } from '../src/world/sites';

const site = (id: string) => LAUNCH_SITES.find((s) => s.id === id)!;

/** every instance position of the plants whose material has this name (site metres) */
function plants(c: LaunchComplex, name: string): Vector3[] {
  const out: Vector3[] = [];
  const m = new Matrix4();
  c.group.traverse((o) => {
    const im = o as InstancedMesh;
    if (!im.isInstancedMesh || (im.material as Material).name !== name) return;
    for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m); out.push(new Vector3().setFromMatrixPosition(m)); }
  });
  return out;
}

const meshWith = (c: LaunchComplex, mat: Material) => {
  let found: Mesh | null = null;
  c.group.traverse((o) => { if ((o as Mesh).isMesh && (o as Mesh).material === mat) found = o as Mesh; });
  return found as Mesh | null;
};

describe('launch site', () => {
  it('the integration hangar stands clear of the plants, and has its cladding', () => {
    const c = new LaunchComplex(site('cape'), getVehicle('kestrel9'));
    const hangar = meshWith(c, c.mats.cladding);
    expect(hangar).toBeTruthy();
    hangar!.geometry.computeBoundingBox();
    const box = hangar!.geometry.boundingBox!;
    // the hangar (95 x 40 m) and its office annex, a little west of the pad, doors to the north
    expect(box.max.x - box.min.x).toBeGreaterThan(95);
    expect(box.max.y).toBeGreaterThan(22);
    const grown = ['pineLeaf', 'canopy', 'palmLeaf', 'leaf', 'grass'].flatMap((n) => plants(c, n));
    expect(grown.length).toBeGreaterThan(1000);
    // nothing grows on the building or the apron in front of its doors
    const inside = grown.filter((p) => p.x > box.min.x - 2 && p.x < box.max.x + 2 && p.z > box.min.z - 40 && p.z < box.max.z + 2);
    expect(inside).toEqual([]);
  });

  it('a raised launch mount has no flame trench or earth berms beneath it', () => {
    const olm = new LaunchComplex(site('boca'), getVehicle('leviathan'));
    expect(olm.pad).toBe('olm');
    expect(meshWith(olm, olm.mats.berm)).toBeNull();
    // its exhaust spreads out under the table in every direction
    expect(olm.exits.length).toBe(6);
    const pad = new LaunchComplex(site('cape'), getVehicle('kestrel9'));
    expect(meshWith(pad, pad.mats.berm)).toBeTruthy();
    expect(pad.exits.length).toBe(2);
  });
});
