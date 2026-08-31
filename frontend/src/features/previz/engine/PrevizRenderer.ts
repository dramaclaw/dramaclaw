// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const GROUND_SIZE_METERS = 20;
const GROUND_DIVISIONS = 20;
const MAX_PIXEL_RATIO = 2;

/**
 * three.js 渲染层。构造走静态 create() 而不是 new：three 与 OrbitControls 都在
 * 里面动态 import，只有真正打开预演台才下载那个 chunk。顶层只有 type import，
 * 编译后会被完全擦除，不会把 three 拉进首屏。
 */
export class PrevizRenderer {
  private rafHandle = 0;
  private disposed = false;

  private constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  static async create(canvas: HTMLCanvasElement): Promise<PrevizRenderer> {
    const [three, controlsModule] = await Promise.all([
      import('three'),
      import('three/examples/jsm/controls/OrbitControls.js'),
    ]);

    const renderer = new three.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));

    const scene = new three.Scene();
    scene.background = new three.Color(0x101216);
    scene.add(new three.GridHelper(GROUND_SIZE_METERS, GROUND_DIVISIONS, 0x3a4150, 0x232833));
    scene.add(new three.AmbientLight(0xffffff, 1.2));

    const keyLight = new three.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(4, 8, 6);
    scene.add(keyLight);

    const camera = new three.PerspectiveCamera(50, 1, 0.1, 500);
    camera.position.set(6, 4, 8);

    const controls = new controlsModule.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    // 视线落在成人胸口高度，而不是地面 —— 空场景里对着原点会让网格贴着屏幕底边。
    controls.target.set(0, 1, 0);
    controls.update();

    const instance = new PrevizRenderer(renderer, scene, camera, controls, canvas);
    instance.resize();
    instance.start();
    return instance;
  }

  /** 跟随容器尺寸重设画布与相机宽高比；ResizeObserver 回调直接调它。 */
  resize(): void {
    if (this.disposed) return;
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    // updateStyle=false：尺寸由 CSS 决定，渲染器只跟随，别反过来写死 style。
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private start(): void {
    const tick = () => {
      if (this.disposed) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.rafHandle = window.requestAnimationFrame(tick);
    };
    this.rafHandle = window.requestAnimationFrame(tick);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.cancelAnimationFrame(this.rafHandle);
    this.controls.dispose();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    });
    this.renderer.dispose();
  }
}
