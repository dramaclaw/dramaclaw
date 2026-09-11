// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import type { ThreeModule } from './sceneGraph';

/**
 * 把刚导进来的模型的材质改成预演台照得亮的样子：整棵子树改双面，并把 Phong / Lambert
 * 换成 `MeshStandardMaterial`。
 *
 * 两件事写在一个函数里，是因为它们是同一次遍历、同一个时机（加载完、进场景之前），
 * 拆成两遍只会多走一趟整棵子树，还得记住两边都不能漏调。
 *
 * **双面**：用户自备的模型普遍有翻面。`Room.obj` 那份三室一厅，地板是一张法线朝下的
 * 单面片（面积 18 万单位，室内最大的一块），默认的 `FrontSide` 从室内往下看正好把它
 * 剔掉，于是整片地板变成背景色——看上去像模型没加载完。这类错在导出环节极常见，而
 * 预演台的职责是**把导进来的东西显示出来**，不是替素材守正确性。代价是背面的片元要
 * 多画一遍，半透明模式下背面也会跟着叠；拿这个换「不静默丢掉几何体」是划算的。
 *
 * **换 standard**：预演台自己建的东西全是 `MeshStandardMaterial`（占位胶囊、占位方块），
 * 人物 rig 走 glTF、出来的也是 standard。而 OBJLoader 没有 .mtl 时给的兜底材质是
 * `MeshPhongMaterial`，它的高光走的是另一套模型（`shininess` + `specular`，不是
 * `roughness`），在同一盏主光下和旁边的占位体明显不是一个质感。统一到 standard，
 * 「同一个场景里的东西按同一套规则受光」才成立。
 *
 * 顺带一条将来的：`scene.environment` 那张 IBL 只有 standard / physical 吃得到。今天
 * 场景里没挂环境贴图（试过 `RoomEnvironment`，它把整个场景提亮一档，暗底调没了），
 * 真要加回来时，这一步已经在了。
 */
export function prepareImportedMaterials(three: ThreeModule, root: THREE.Object3D): void {
  // 一份材质常被整棵子树的几十个 mesh 共用（OBJ 的兜底材质更是全模型独一份）。
  // 不记账的话同一份会被转换几十次：几十份各自带一套 uniform 的 standard 材质，
  // 几十次着色器编译，而画面上完全看不出区别。
  const converted = new Map<THREE.Material, THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const material = mesh.material;
    if (!material) return;
    mesh.material = Array.isArray(material)
      ? material.map((entry) => prepareOne(three, entry, converted))
      : prepareOne(three, material, converted);
  });
}

function prepareOne(
  three: ThreeModule,
  material: THREE.Material,
  converted: Map<THREE.Material, THREE.Material>,
): THREE.Material {
  const seen = converted.get(material);
  if (seen) return seen;

  const legacy = material as THREE.MeshPhongMaterial & THREE.MeshLambertMaterial;
  // `isMeshStandardMaterial` 在 physical 上也是 true（它是 standard 的子类），于是
  // 那一支照样原样放行——它本来就是要的那套受光模型，重建一份只会丢掉 clearcoat 这些字段。
  const next = legacy.isMeshPhongMaterial || legacy.isMeshLambertMaterial
    ? toStandard(three, legacy)
    : material;
  // 只在加载完、进场景之前改 `side`。它参与着色程序的缓存键（`WebGLPrograms` 的
  // `flipSided` / `doubleSided`），进了场景再改会触发一次重编译。
  next.side = three.DoubleSide;
  converted.set(material, next);
  if (next !== material) {
    // 换下来的那份再没人引用了。`Material.dispose()` 不碰贴图，而贴图刚被下面原样
    // 转交给了新材质——还掉的只是那份材质自己的 GPU 程序。
    material.dispose();
  }
  return next;
}

function toStandard(
  three: ThreeModule,
  source: THREE.MeshPhongMaterial & THREE.MeshLambertMaterial,
): THREE.Material {
  const standard = new three.MeshStandardMaterial(
    // 带 undefined 的字段必须先筛掉：three 的 `Material.setValues` 碰到 undefined 会
    // 打一句 warning 再跳过，而 Lambert 身上本来就没有 `shininess` 这类字段——不筛的话
    // 每导一个 Lambert 模型，控制台里就是一串和用户毫无关系的黄字。
    defined({
      name: source.name,
      color: source.color,
      map: source.map,
      alphaMap: source.alphaMap,
      aoMap: source.aoMap,
      aoMapIntensity: source.aoMapIntensity,
      bumpMap: source.bumpMap,
      bumpScale: source.bumpScale,
      normalMap: source.normalMap,
      normalMapType: source.normalMapType,
      normalScale: source.normalScale,
      displacementMap: source.displacementMap,
      displacementScale: source.displacementScale,
      displacementBias: source.displacementBias,
      lightMap: source.lightMap,
      lightMapIntensity: source.lightMapIntensity,
      emissive: source.emissive,
      emissiveMap: source.emissiveMap,
      emissiveIntensity: source.emissiveIntensity,
      transparent: source.transparent,
      opacity: source.opacity,
      alphaTest: source.alphaTest,
      depthWrite: source.depthWrite,
      flatShading: source.flatShading,
      vertexColors: source.vertexColors,
      wireframe: source.wireframe,
      // 金属度给 0：Phong 与 Lambert 里没有任何一个字段表达「这是金属」，
      // 猜一个非零值等于替素材编造材质属性。真金属的模型会带 PBR 贴图，走 glTF 那条路。
      metalness: 0,
      roughness: roughnessOf(source.shininess),
    }),
  );
  // 贴图的色彩空间跟着源材质走就行（loader 已经标过），这里不重设。
  // userData 要带上：全灰模式把本色记在材质的 userData 上（见 `applyDisplayMode`），
  // 换材质时丢掉它，切回实体就还不了原色。
  standard.userData = source.userData;
  return standard;
}

/**
 * Blinn-Phong 的高光指数换粗糙度，用的是 `sqrt(2 / (shininess + 2))`——把两种模型的
 * 高光瓣宽度对齐，是这类转换的通行公式。
 *
 * 下限压在 0.3：shininess 是 .mtl 里最常被随手填的一个数（`Room.mtl` 干脆没写 `Ns`，
 * OBJLoader 于是用了自己的默认值 30，算出来 0.25），而一面 0.05 粗糙度的墙在 IBL 下
 * 就是一面镜子。宁可偏哑光——偏哑光只是不够漂亮，镜面墙是一眼看得出的错。
 */
function roughnessOf(shininess: number | undefined): number {
  // Lambert 没有 shininess，它本来就是纯漫反射。
  if (typeof shininess !== 'number' || !Number.isFinite(shininess) || shininess <= 0) return 1;
  return Math.min(1, Math.max(0.3, Math.sqrt(2 / (shininess + 2))));
}

function defined(params: Record<string, unknown>): THREE.MeshStandardMaterialParameters {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) kept[key] = value;
  }
  return kept as THREE.MeshStandardMaterialParameters;
}
