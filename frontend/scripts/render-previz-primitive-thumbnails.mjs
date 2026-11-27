// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 给模型库里的基础几何体渲染缩略图，写到 public/previz/primitives/<形状>.webp。
 *
 * 几何体与白模颜色都直接取预演台自己的代码（`primitiveBuilder.ts` / `CLAY_COLOR`），
 * 所以要借正在跑的 vite dev server 把 TS 编出来：
 *
 *   cd frontend && npx vite --port 5174   # 另开一个终端
 *   node scripts/render-previz-primitive-thumbnails.mjs [http://127.0.0.1:5174]
 *
 * 改了几何体的形状或新增形状后重跑一次，把产物一起提交。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const ORIGIN = process.argv[2] ?? "http://127.0.0.1:5174";
const EDGE = 256;
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/previz/primitives");

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-gl=angle"] });
try {
  const page = await browser.newPage();
  // 随便一个同源静态文件当落脚点，下面的动态 import 才能走 vite 的模块转换。
  // 落脚点是 SVG 文档，所以画布得按 HTML 命名空间建。
  await page.goto(`${ORIGIN}/favicon.svg`);
  const images = await page.evaluate(async (edge) => {
    const three = await import("/node_modules/three/build/three.module.js");
    const { buildPrimitive } = await import("/src/features/previz/engine/primitiveBuilder.ts");
    const { CLAY_COLOR } = await import("/src/features/previz/engine/importedMaterials.ts");
    const { PREVIZ_PRIMITIVE_SHAPES } = await import("/src/features/previz/domain/primitives.ts");

    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = canvas.height = edge;
    const renderer = new three.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = three.SRGBColorSpace;

    const scene = new three.Scene();
    // 顶面最亮、左前面次之、右侧面最暗：和模型库里其它缩略图同一种等轴受光。
    scene.add(new three.HemisphereLight(0xffffff, 0x5a5f68, 1.4));
    const key = new three.DirectionalLight(0xffffff, 2.2);
    key.position.set(-2, 5, 3);
    scene.add(key);
    const camera = new three.PerspectiveCamera(24, 1, 0.1, 100);

    const out = {};
    for (const shape of Object.keys(PREVIZ_PRIMITIVE_SHAPES)) {
      const model = buildPrimitive(three, shape);
      model.traverse((node) => {
        if (!node.isMesh) return;
        node.material = new three.MeshStandardMaterial({
          color: CLAY_COLOR, roughness: 0.7, metalness: 0.05, side: three.DoubleSide,
        });
      });
      scene.add(model);
      const sphere = new three.Box3().setFromObject(model).getBoundingSphere(new three.Sphere());
      const distance = sphere.radius / Math.sin(three.MathUtils.degToRad(camera.fov / 2)) * 1.08;
      const direction = new three.Vector3(-1, 0.85, 1.25).normalize();
      camera.position.copy(sphere.center).addScaledVector(direction, distance);
      camera.lookAt(sphere.center);
      renderer.render(scene, camera);
      out[shape] = canvas.toDataURL("image/webp", 0.9);
      scene.remove(model);
      model.traverse((node) => {
        if (!node.isMesh) return;
        node.geometry.dispose();
        node.material.dispose();
      });
    }
    renderer.dispose();
    return out;
  }, EDGE);

  await mkdir(OUT, { recursive: true });
  for (const [shape, url] of Object.entries(images)) {
    if (!url.startsWith("data:image/webp")) throw new Error(`${shape}: 浏览器没编出 webp`);
    await writeFile(path.join(OUT, `${shape}.webp`), Buffer.from(url.split(",")[1], "base64"));
  }
  console.log(`wrote ${Object.keys(images).length} thumbnails to ${OUT}`);
} finally {
  await browser.close();
}
