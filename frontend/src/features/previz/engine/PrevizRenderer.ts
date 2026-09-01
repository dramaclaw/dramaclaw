// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const GROUND_SIZE_METERS = 20;
const GROUND_DIVISIONS = 20;
// 上限 2：3x DPR 设备按原生比例渲染是 9 倍像素，收益远小于开销。
const MAX_PIXEL_RATIO = 2;

/**
 * three.js 渲染层。构造走静态 create() 而不是 new：three 与 OrbitControls 都在
 * 里面动态 import，只有真正打开预演台才下载那个 chunk。顶层只有 type import，
 * 编译后会被完全擦除，不会把 three 拉进首屏。
 */
export class PrevizRenderer {
  private rafHandle = 0;
  private disposed = false;
  private needsRender = true;

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
    // 轨道中心抬到地面之上 1 米，给后续落在网格上的主体留出视觉空间；
    // 代价是网格中心从画面正中下移到约 60% 高度处。
    controls.target.set(0, 1, 0);
    controls.update();

    const instance = new PrevizRenderer(renderer, scene, camera, controls, canvas);
    // 滚轮缩放走的是 OrbitControls 的 wheel 处理器：它自己就把 update() 调了、
    // 把 _scale 消化干净，只留下这个 change 事件。tick 里那次 update() 只会拿到
    // false，不订阅 change 的话相机确实动了、屏幕上却一帧都不重绘——缩放看起来
    // 就是彻底失灵，直到下一次拖拽（阻尼余速能让 update() 连着返回 true）才补上。
    controls.addEventListener('change', () => instance.requestRender());
    instance.resize();
    instance.start();
    return instance;
  }

  /** 跟随容器尺寸重设画布与相机宽高比；ResizeObserver 回调直接调它。 */
  resize(): void {
    if (this.disposed) return;
    // `|| 1`：容器尚未布局时 clientWidth 为 0，0/0 会把 aspect 变成 NaN，
    // 进而毒掉整个投影矩阵。别顺手精简掉。
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    // 每次 resize 都重设，而不是只在 create() 设一次：浏览器缩放会同时改变
    // devicePixelRatio 和视口 CSS 尺寸，全屏画布因此会走到这里。
    // 注意：拖到不同 DPR 的显示器只改 DPR、不改 CSS 尺寸，ResizeObserver 不会触发，
    // 这条路径当前覆盖不到。
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    // updateStyle=false：尺寸由 CSS 决定，渲染器只跟随，别反过来写死 style。
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /**
   * 场景内容变化后调用，请求下一帧重绘。相机自身的移动不需要调它——
   * tick 里 `controls.update()` 的返回值已经覆盖了那条路径。
   */
  requestRender(): void {
    this.needsRender = true;
  }

  private start(): void {
    const tick = () => {
      if (this.disposed) return;
      // update() 返回 true 表示相机确实动了（阻尼余速也算）。静止时跳过 render，
      // 否则一个只有网格和两盏灯的静态场景会在全屏里 60fps 空烧 GPU。
      if (this.controls.update() || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
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
    // dispose() 只摘监听、清 three 自己的 cache，不还底层 WebGL context（three 0.185
    // 实测）。浏览器并发 context 上限约 16 个，而预演台是反复开关的，不显式归还的话
    // 开到后面会静默黑屏。必须在 dispose() 之后调：dispose() 已经摘掉了
    // 'webglcontextlost' 监听，此时 loseContext() 不会再触发 three 的 onContextLost
    // （那个 handler 会打一行 "WebGLRenderer: Context Lost." 噪音日志）。
    this.renderer.forceContextLoss();
  }
}
