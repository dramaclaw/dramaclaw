// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

/**
 * 在浏览器里把一份 glTF 重新打包成更小的 .glb。
 *
 * 这个文件是整条压缩链上唯一碰 three 与 canvas 的一层，所以它**不含任何判断**：压不压、
 * 压完算不算数、失败了怎么办，全在 `propCompress.ts` 里，那一层不碰 three，因此测得动。
 * 两层分开是有代价的（多一个文件），换来的是「要不要压」这个策略问题不必架在一套
 * WebGL 假替身上才能断言。
 *
 * three 是动态 import 的，与 `PrevizRenderer.create()` 同一条理由：整个 three 加上
 * 导入导出器有一兆多，而绝大多数进预演台的人不导模型。
 */

/** 贴图的最长边上限，像素。见 `propCompress.ts` 里那个同名常量的取值理由。 */
export async function repackGlb(file: File, maxTexturePx: number): Promise<ArrayBuffer> {
  const [gltfModule, exporterModule] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/exporters/GLTFExporter.js'),
  ]);

  // loader 只吃 URL。blob URL 必须自己还，不还的话这份几百兆的文件会一直被页面握着，
  // 直到整个标签页关掉。
  const url = URL.createObjectURL(file);
  try {
    const gltf = await new gltfModule.GLTFLoader().loadAsync(url);
    shrinkTextures(gltf.scene, maxTexturePx);
    const packed = await new exporterModule.GLTFExporter().parseAsync(gltf.scene, {
      binary: true,
      // 动画要显式交出去，导出器不会自己从场景里找。漏了这一条，一个带动画的模型
      // 会安安静静地变成一尊雕像——没有报错，只是不动了。
      animations: gltf.animations,
      // 刻意不用导出器自己的 `maxTextureSize`：它是两根轴各自 clamp 的
      // （`GLTFExporter.js` 里那两行 `Math.min(image.width, maxTextureSize)`），
      // 一张 4096×1024 的贴图会被压成 2048×1024，横向缩了纵向没缩，贴图直接歪掉。
      // 下面 `shrinkTexture` 按比例缩，缩完本来也轮不到它插手。
    });
    // `binary: true` 时 parseAsync 交出的就是 ArrayBuffer；这个断言只是把导出器那个
    // `ArrayBuffer | JSON` 的联合类型收窄，不是在猜。
    return packed as ArrayBuffer;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 把整棵场景上的贴图缩到 `maxPx` 以内，并统一改写成 WebP。
 *
 * 真正的体积几乎全在贴图上：一份几十兆的建筑模型，几何体通常只占一两兆，其余是几张
 * 4K PNG。PNG 换 WebP 常见五到十倍，再把 4K 缩到 2K 又是四分之一的像素。
 *
 * 代价是导出的 glb 会带上 `EXT_texture_webp` 这个**必需**扩展（导出器会写进
 * `extensionsRequired`），不认这个扩展的第三方查看器会拒绝打开。放行这条是因为这份
 * 文件的唯一消费者是预演台自己的 `PropLoader`，走的是 three 的 GLTFLoader，认。
 */
function shrinkTextures(root: THREE.Object3D, maxPx: number): void {
  // 同一张贴图会被多个材质共用（albedo 与 emissive 常常是同一张）。不去重的话第二次
  // 会拿已经缩过的 canvas 再缩一遍，越缩越糊。
  const seen = new Set<THREE.Texture>();
  root.traverse((object) => {
    const material = (object as THREE.Mesh).material;
    if (!material) return;
    for (const single of Array.isArray(material) ? material : [material]) {
      // 遍历材质的每一个字段找贴图，而不是列举 `map` / `normalMap` / `roughnessMap`
      // 这些名字：字段名随材质类型变，列举一定会漏，而漏掉的那张贴图会原样带进结果，
      // 「压了但没怎么小」这种症状最难查。
      for (const value of Object.values(single as unknown as Record<string, unknown>)) {
        const texture = value as THREE.Texture | null;
        if (!texture?.isTexture || seen.has(texture)) continue;
        seen.add(texture);
        shrinkTexture(texture, maxPx);
      }
    }
  });
}

function shrinkTexture(texture: THREE.Texture, maxPx: number): void {
  const image = texture.image as CanvasImageSource & { width?: number; height?: number };
  const width = image?.width;
  const height = image?.height;
  // 数据贴图（DataTexture）与压缩贴图（KTX2）没有可画的 image，跳过——交给导出器处理，
  // 它认不出来就整份导出失败，上一层会退回原件。
  if (typeof width !== 'number' || typeof height !== 'number' || !width || !height) return;

  texture.userData.mimeType = 'image/webp';
  const scale = Math.min(1, maxPx / Math.max(width, height));
  if (scale >= 1) return;

  const canvas = document.createElement('canvas');
  // 至少留 1 px：一张 8192×1 的贴图按比例缩会算出 0，而 0 宽的 canvas 画不出东西，
  // 导出的是一张空贴图。
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  texture.image = canvas;
}
