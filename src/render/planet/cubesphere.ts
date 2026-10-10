/** Cube-sphere face mapping (spherified cube, P. Nowell) shared by mesher, LOD and physics. */

export function cubePoint(face: number, u: number, v: number, out: number[]): number[] {
  switch (face) {
    case 0: out[0] = 1; out[1] = v; out[2] = -u; break;
    case 1: out[0] = -1; out[1] = v; out[2] = u; break;
    case 2: out[0] = u; out[1] = 1; out[2] = -v; break;
    case 3: out[0] = u; out[1] = -1; out[2] = v; break;
    case 4: out[0] = u; out[1] = v; out[2] = 1; break;
    default: out[0] = -u; out[1] = v; out[2] = -1; break;
  }
  return out;
}

export function spherify(p: number[], out: number[]): number[] {
  const x = p[0], y = p[1], z = p[2];
  const x2 = x * x, y2 = y * y, z2 = z * z;
  out[0] = x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3));
  out[1] = y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3));
  out[2] = z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3));
  return out;
}

const _c: number[] = [0, 0, 0];
export function faceUVToDir(face: number, u: number, v: number, out: number[]): number[] {
  return spherify(cubePoint(face, u, v, _c), out);
}

/** Which cube face a direction belongs to, and its (non-spherified) face coordinates. */
export function dirToFace(x: number, y: number, z: number): { face: number; u: number; v: number } {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) {
    return x > 0 ? { face: 0, u: -z / ax, v: y / ax } : { face: 1, u: z / ax, v: y / ax };
  }
  if (ay >= az) {
    return y > 0 ? { face: 2, u: x / ay, v: -z / ay } : { face: 3, u: x / ay, v: z / ay };
  }
  return z > 0 ? { face: 4, u: x / az, v: y / az } : { face: 5, u: -x / az, v: y / az };
}
