import { describe, expect, it } from 'vitest';
import { Box3, Group, MeshPhysicalMaterial, Quaternion, Vector3 } from 'three';
import { buildLeg, buildStrut, type HingedPart, updateStrut } from '../src/render/vehicle/VehicleParts';

describe('landing legs', () => {
  it('the deployment actuator runs from the body to the leg, whether stowed or deployed', () => {
    const mat = new MeshPhysicalMaterial();
    const L = 9.6 * 0.96, R = 1.83, hingeY = 4.5;
    // a leg hinged at the body surface on the +x side, swinging out about the pivot's x axis
    const pivot = new Group();
    pivot.position.set(R + 0.02, hingeY, 0);
    pivot.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const base = pivot.quaternion.clone();
    const leg = buildLeg(L, R, mat, mat);
    pivot.add(leg);
    const attach = leg.userData.strutAttach as Vector3;
    expect(attach).toBeInstanceOf(Vector3);
    const anchor = new Vector3(R + 0.08, hingeY + L * 0.25, 0);
    const part: HingedPart = { pivot, axis: new Vector3(1, 0, 0), stowed: 0, deployed: 2.28, strut: buildStrut(anchor, attach, L * 0.36, 0.12, mat, mat) };
    const s = part.strut!;
    const end = (m: typeof s.rod) => m.position.clone().add(new Vector3(0, m.scale.y, 0).applyQuaternion(m.quaternion));
    for (const ang of [0, 1.2, part.deployed]) {
      pivot.quaternion.copy(base).multiply(new Quaternion().setFromAxisAngle(part.axis, ang));
      updateStrut(part);
      const target = attach.clone().applyQuaternion(pivot.quaternion).add(pivot.position);
      // the barrel stands on the body fitting, the piston ends on the leg's clevis
      expect(s.barrel.position.distanceTo(anchor)).toBeLessThan(1e-6);
      expect(end(s.rod).distanceTo(target)).toBeLessThan(1e-4);
      // and the piston runs out of the barrel's mouth, not beside it
      const mouth = end(s.barrel);
      const dir = target.clone().sub(anchor).normalize();
      expect(mouth.clone().sub(anchor).normalize().dot(dir)).toBeGreaterThan(0.9999);
    }
    // deployed, the actuator is a long brace well clear of the body; stowed, it folds away short
    pivot.quaternion.copy(base).multiply(new Quaternion().setFromAxisAngle(part.axis, part.deployed));
    updateStrut(part);
    const deployedLen = s.barrel.scale.y + s.rod.scale.y;
    pivot.quaternion.copy(base);
    updateStrut(part);
    const stowedLen = s.barrel.scale.y + s.rod.scale.y;
    expect(deployedLen).toBeGreaterThan(L * 0.45);
    expect(stowedLen).toBeLessThan(L * 0.25);
  });

  it('a leg is a deep beam, not a flat plate', () => {
    const mat = new MeshPhysicalMaterial();
    const leg = buildLeg(9.2, 1.83, mat, mat);
    const box = new Box3().setFromObject(leg);
    const size = box.getSize(new Vector3());
    // along the leg (y), across it (x) and its depth out from the body (z)
    expect(size.y).toBeGreaterThan(9.2);
    expect(size.x).toBeGreaterThan(0.6);
    expect(size.z).toBeGreaterThan(0.35);
  });
});
