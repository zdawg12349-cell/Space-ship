import {
  BufferAttribute, BufferGeometry, Group, Mesh, Quaternion, ShaderMaterial, Sphere, Vector3,
} from 'three';
import { faceUVToDir } from './cubesphere';
import type { HeightContext } from './heightfield';

/**
 * Cube-sphere quadtree terrain with camera-relative chunk placement.
 * Each chunk's vertices are stored relative to the chunk centre (float32 precise near the
 * camera); the centre itself is positioned every frame in double precision.
 */

class Node {
  children: Node[] | null = null;
  mesh: Mesh | null = null;
  pending = false;
  lastUsed = 0;
  centerFixed = new Vector3(); // metres, body-fixed (valid once built; estimate before)
  centerDir = new Vector3();
  sizeM: number;
  maxH = 0;
  constructor(readonly face: number, readonly level: number, readonly x0: number, readonly y0: number, readonly size: number, R: number) {
    const d = faceUVToDir(face, x0 + size / 2, y0 + size / 2, [0, 0, 0]);
    this.centerDir.set(d[0], d[1], d[2]).normalize();
    this.centerFixed.copy(this.centerDir).multiplyScalar(R);
    this.sizeM = (size * R * Math.PI) / 4;
  }
}

export interface QuadtreeOptions {
  radius: number;
  ctx: HeightContext;
  material: ShaderMaterial;
  resolution?: number;
  maxLevel?: number;
  splitFactor?: number;
  detailPeriod?: number;
  maxChunks?: number;
  workers?: number;
}

let NODE_ID = 1;

export class QuadtreePlanet {
  readonly group = new Group();
  readonly radius: number;
  material: ShaderMaterial;
  private roots: Node[] = [];
  private N: number;
  maxLevel: number;
  splitFactor: number;
  private detailPeriod: number;
  private maxChunks: number;
  private workers: Worker[] = [];
  private busy: number[] = [];
  private queue: Node[] = [];
  private inflight = new Map<number, Node>();
  private index: BufferAttribute;
  private frame = 0;
  private renderList: Node[] = [];
  private allMeshes = new Set<Node>();
  private camFixed = new Vector3();
  private camDist = 0;
  private maxTerrain: number;
  ready = false;
  /** stats */
  stats = { chunks: 0, drawn: 0, pending: 0 };

  constructor(opts: QuadtreeOptions) {
    this.radius = opts.radius;
    this.material = opts.material;
    this.N = opts.resolution ?? 33;
    this.maxLevel = opts.maxLevel ?? 15;
    this.splitFactor = opts.splitFactor ?? 2.2;
    this.detailPeriod = opts.detailPeriod ?? 512;
    this.maxChunks = opts.maxChunks ?? 900;
    this.maxTerrain = opts.ctx.kind === 'earth' ? 9000 : opts.ctx.kind === 'moon' ? 11000 : 0;
    this.group.name = 'quadtree-planet';
    this.index = this.buildIndex(this.N);
    for (let f = 0; f < 6; f++) this.roots.push(new Node(f, 0, -1, -1, 2, this.radius));
    const nW = Math.max(1, Math.min(opts.workers ?? 3, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < nW; i++) {
      const w = new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => this.onBuilt(i, ev.data);
      w.postMessage({ type: 'init', ctx: opts.ctx });
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  setSites(sites: HeightContext['sites']): void {
    for (const w of this.workers) w.postMessage({ type: 'sites', sites });
  }

  private buildIndex(N: number): BufferAttribute {
    const idx: number[] = [];
    const g = (i: number, j: number) => j * N + i;
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = g(i, j), b = g(i + 1, j), c = g(i, j + 1), d = g(i + 1, j + 1);
      idx.push(a, b, c, b, d, c);
    }
    const S0 = N * N, S1 = S0 + N, S2 = S1 + N, S3 = S2 + N;
    const quad = (a: number, b: number, sa: number, sb: number) => { idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa); };
    for (let i = 0; i < N - 1; i++) quad(g(i, 0), g(i + 1, 0), S0 + i, S0 + i + 1);
    for (let i = 0; i < N - 1; i++) quad(g(i, N - 1), g(i + 1, N - 1), S1 + i, S1 + i + 1);
    for (let j = 0; j < N - 1; j++) quad(g(0, j), g(0, j + 1), S2 + j, S2 + j + 1);
    for (let j = 0; j < N - 1; j++) quad(g(N - 1, j), g(N - 1, j + 1), S3 + j, S3 + j + 1);
    return new BufferAttribute(new Uint16Array(idx), 1);
  }

  private request(n: Node): void {
    if (n.mesh || n.pending) return;
    n.pending = true;
    this.queue.push(n);
  }

  private onBuilt(worker: number, msg: any): void {
    this.busy[worker] = Math.max(0, this.busy[worker] - 1);
    const n = this.inflight.get(msg.id);
    this.inflight.delete(msg.id);
    if (!n) return;
    n.pending = false;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(msg.positions, 3));
    g.setAttribute('normal', new BufferAttribute(msg.normals, 3));
    g.setAttribute('aDir', new BufferAttribute(msg.dirs, 3));
    g.setAttribute('aExtra', new BufferAttribute(msg.extra, 4));
    g.setAttribute('aHeight', new BufferAttribute(msg.heights, 1));
    g.setAttribute('aDetail', new BufferAttribute(msg.detail, 2));
    g.setIndex(this.index);
    g.boundingSphere = new Sphere(new Vector3(), msg.radius);
    const mesh = new Mesh(g, this.material);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = true;
    mesh.visible = false;
    mesh.receiveShadow = true;
    n.mesh = mesh;
    n.centerFixed.set(msg.center[0], msg.center[1], msg.center[2]);
    n.maxH = msg.maxH;
    this.group.add(mesh);
    this.allMeshes.add(n);
  }

  private shouldSplit(n: Node): boolean {
    if (n.level >= this.maxLevel) return false;
    const d = this.camFixed.distanceTo(n.centerFixed) - n.sizeM * 0.71;
    return d < n.sizeM * this.splitFactor;
  }

  private visible(n: Node): boolean {
    // horizon culling (generous margin for mountains)
    const R = this.radius;
    const dc = this.camDist;
    if (dc < R + 2000) return true;
    const ang = Math.acos(Math.max(-1, Math.min(1, n.centerDir.dot(_cd))));
    const horizon = Math.acos(Math.min(1, R / dc)) + Math.acos(R / (R + this.maxTerrain));
    const nodeAng = (n.sizeM * 0.75) / R;
    return ang - nodeAng < horizon;
  }

  private collect(n: Node): boolean {
    n.lastUsed = this.frame;
    if (!this.visible(n)) return true;
    if (this.shouldSplit(n)) {
      if (!n.children) {
        const h = n.size / 2;
        n.children = [
          new Node(n.face, n.level + 1, n.x0, n.y0, h, this.radius),
          new Node(n.face, n.level + 1, n.x0 + h, n.y0, h, this.radius),
          new Node(n.face, n.level + 1, n.x0, n.y0 + h, h, this.radius),
          new Node(n.face, n.level + 1, n.x0 + h, n.y0 + h, h, this.radius),
        ];
      }
      const ready = n.children.every((c) => c.mesh || !this.visible(c));
      if (ready) {
        let ok = true;
        for (const c of n.children) ok = this.collect(c) && ok;
        return ok;
      }
      for (const c of n.children) { c.lastUsed = this.frame; if (this.visible(c)) this.request(c); }
      if (n.mesh) { this.renderList.push(n); return true; }
      this.request(n);
      return false;
    }
    if (n.mesh) { this.renderList.push(n); return true; }
    this.request(n);
    return false;
  }

  /**
   * Update LOD and chunk transforms.
   * @param camRel camera position relative to the planet centre (inertial, metres)
   * @param bodyRot body-fixed -> inertial rotation
   */
  update(camRel: Vector3, bodyRot: Quaternion, planetToCam: Vector3): void {
    this.frame++;
    _qi.copy(bodyRot).invert();
    this.camFixed.copy(camRel).applyQuaternion(_qi);
    this.camDist = this.camFixed.length();
    _cd.copy(this.camFixed).normalize();
    this.renderList.length = 0;
    let complete = true;
    for (const r of this.roots) complete = this.collect(r) && complete;
    this.ready = complete;

    // dispatch jobs, nearest first
    if (this.queue.length) {
      this.queue.sort((a, b) => a.centerFixed.distanceToSquared(this.camFixed) - b.centerFixed.distanceToSquared(this.camFixed));
      for (let w = 0; w < this.workers.length && this.queue.length; w++) {
        while (this.busy[w] < 6 && this.queue.length) {
          const n = this.queue.shift()!;
          if (this.frame - n.lastUsed > 2) { n.pending = false; continue; }
          const id = NODE_ID++;
          this.inflight.set(id, n);
          this.busy[w]++;
          this.workers[w].postMessage({ type: 'build', id, face: n.face, x0: n.x0, y0: n.y0, size: n.size, N: this.N, level: n.level, skirt: Math.max(5, n.sizeM * 0.03), detailPeriod: this.detailPeriod });
        }
      }
      // drop stale requests
      this.queue = this.queue.filter((n) => { if (this.frame - n.lastUsed > 2) { n.pending = false; return false; } return true; });
    }

    // transforms
    for (const n of this.allMeshes) n.mesh!.visible = false;
    for (const n of this.renderList) {
      const m = n.mesh!;
      m.visible = true;
      _p.copy(n.centerFixed).applyQuaternion(bodyRot).add(planetToCam);
      m.position.copy(_p);
      m.quaternion.copy(bodyRot);
      m.updateMatrix();
    }
    this.stats.drawn = this.renderList.length;
    this.stats.chunks = this.allMeshes.size;
    this.stats.pending = this.queue.length + this.inflight.size;

    // evict
    if (this.allMeshes.size > this.maxChunks) {
      const old = [...this.allMeshes].filter((n) => this.frame - n.lastUsed > 30).sort((a, b) => a.lastUsed - b.lastUsed);
      for (const n of old.slice(0, this.allMeshes.size - this.maxChunks + 50)) this.release(n);
    }
  }

  private release(n: Node): void {
    if (n.level === 0) return;
    if (n.mesh) {
      this.group.remove(n.mesh);
      n.mesh.geometry.dispose();
      n.mesh = null;
    }
    this.allMeshes.delete(n);
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const n of this.allMeshes) n.mesh?.geometry.dispose();
  }
}

const _qi = new Quaternion();
const _cd = new Vector3();
const _p = new Vector3();
