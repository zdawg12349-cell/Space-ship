import {
  BufferGeometry, Float32BufferAttribute, Mesh, OrthographicCamera, RawShaderMaterial, ShaderMaterial, WebGLRenderer, WebGLRenderTarget,
} from 'three';

/** A single triangle covering the viewport; used by every full-screen pass. */
export class FullscreenQuad {
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly mesh: Mesh;
  constructor(material?: ShaderMaterial | RawShaderMaterial) {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    g.setAttribute('uv', new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
  }
  set material(m: ShaderMaterial | RawShaderMaterial) { this.mesh.material = m; }
  get material(): ShaderMaterial | RawShaderMaterial { return this.mesh.material as ShaderMaterial; }

  render(renderer: WebGLRenderer, target: WebGLRenderTarget | null, material?: ShaderMaterial | RawShaderMaterial): void {
    if (material) this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, this.camera);
  }
}

export const FULLSCREEN_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
