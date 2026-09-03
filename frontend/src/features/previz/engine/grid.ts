// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import type { ThreeModule } from './sceneGraph';

/**
 * 无限地面网格。
 *
 * 原来是一块 20×20 的 `GridHelper`：一转视角就看得见它的四条直边，场景像是浮在一张
 * 小地毯上，而人物走两步就走出了地毯。这里换成「一块永远跟着相机走的平面 + 在片元
 * 着色器里按**世界坐标**画线」——平面平移时线条不跟着漂，边缘用距离淡出化掉，于是
 * 无论视角怎么动都看不到尽头。
 *
 * 为什么不是真·无限（全屏四边形逐片元与地平面求交）：那种做法要自己写 `gl_FragDepth`，
 * 会关掉整块的早期深度测试，而这里只需要「看不见边」。跟随平面把复杂度全留在两个
 * 标量上（半径和边长），代价只是相机飞出远裁剪面之外时网格提前淡完——那时它本来
 * 也已经淡成零了。
 *
 * three 以参数传入，与本目录其余模块同理：jsdom 建不出 WebGL 上下文，而静态 import
 * 会把 three 从懒加载块里拽出来。
 */

/** 细线间距，单位米。1 m 是预演台的基本尺度（人物身高按厘米填，轨迹按米采样）。 */
export const PREVIZ_GRID_CELL_SIZE = 1;
/** 粗线间距。必须是细线的整数倍，否则两层线互相错开，画面上是一片乱纹。 */
export const PREVIZ_GRID_SECTION_SIZE = 10;

/** 淡出半径的上下限，单位米。 */
export const PREVIZ_GRID_FADE_MIN = 40;
/**
 * 上限压在编辑相机远裁剪面（500 m）之内：越过它网格会被裁出一条直边，
 * 而那条边正是本模块要消灭的东西。
 */
export const PREVIZ_GRID_FADE_MAX = 400;

/** 相机每高 1 米，网格多铺多远。 */
const HEIGHT_TO_FADE = 60;
/** 淡出从半径的这个比例处起步，到半径处收干净。 */
const FADE_NEAR_RATIO = 0.3;
/**
 * 平面边长相对淡出半径的倍数。2 只够到四条边的中点，角上的对角线方向会短一截；
 * 2.2 让整圈都落在平面之内。
 */
const EXTENT_RATIO = 2.2;

export interface GridFollowState {
  /** 平面边长。 */
  extent: number;
  /** 淡出起点半径。 */
  fadeNear: number;
  /** 淡出终点半径，到这里完全透明。 */
  fadeFar: number;
}

/**
 * 按相机离地高度算这一帧网格要铺多大。
 *
 * 挂在高度而不是轨道半径上：监看与截图那两趟用的是机位自己的相机，它们没有轨道
 * 半径可读，而「站得多高就看得多远」对任何相机都成立。
 */
export function gridFollowState(cameraHeight: number): GridFollowState {
  const fadeFar = Math.min(
    PREVIZ_GRID_FADE_MAX,
    Math.max(PREVIZ_GRID_FADE_MIN, Math.abs(cameraHeight) * HEIGHT_TO_FADE),
  );
  return {
    extent: fadeFar * EXTENT_RATIO,
    fadeNear: fadeFar * FADE_NEAR_RATIO,
    fadeFar,
  };
}

const VERTEX_SHADER = /* glsl */ `
varying vec3 vWorld;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * `cameraPosition` 是 three 自动注入的内置 uniform，逐趟按当前相机填好——监看与
 * 截图那两趟因此不用额外接线就能各自淡出。
 */
const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uCellColor;
uniform vec3 uSectionColor;
uniform float uCellSize;
uniform float uSectionSize;
uniform float uCellOpacity;
uniform float uFadeNear;
uniform float uFadeFar;

varying vec3 vWorld;

/**
 * 一层网格的覆盖度。fwidth 给出这一格在屏幕上有多大，线宽因此恒为约一个像素，
 * 不管相机离得多近多远——固定世界宽度的线在远处会碎成摩尔纹。
 */
float gridMask(vec2 p, float size) {
  vec2 uv = p / size;
  vec2 w = max(fwidth(uv), vec2(1e-6));
  vec2 a = abs(fract(uv - 0.5) - 0.5) / w;
  float mask = 1.0 - min(min(a.x, a.y), 1.0);
  // 一格窄到亚像素时整层淡出：再画下去只会糊成一片均匀的灰。
  float lod = 1.0 - smoothstep(0.4, 1.0, max(w.x, w.y));
  return mask * lod;
}

void main() {
  float cells = gridMask(vWorld.xz, uCellSize);
  float sections = gridMask(vWorld.xz, uSectionSize);

  float distanceFromEye = distance(cameraPosition.xz, vWorld.xz);
  float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, distanceFromEye);

  float alpha = max(cells * uCellOpacity, sections) * fade;
  // 空白处直接丢弃：整块地面都是半透明的，留着会白白走一遍混合。
  if (alpha < 0.002) discard;

  gl_FragColor = vec4(mix(uCellColor, uSectionColor, sections), alpha);
}
`;

/** 建地面网格。尺寸与淡出半径由 `syncInfiniteGrid` 在每一趟渲染之前填。 */
export function createInfiniteGrid(three: ThreeModule): THREE.Mesh {
  const material = new three.ShaderMaterial({
    uniforms: {
      uCellColor: { value: new three.Color(0x2b3140) },
      uSectionColor: { value: new three.Color(0x3f4759) },
      uCellSize: { value: PREVIZ_GRID_CELL_SIZE },
      uSectionSize: { value: PREVIZ_GRID_SECTION_SIZE },
      uCellOpacity: { value: 0.55 },
      uFadeNear: { value: PREVIZ_GRID_FADE_MIN * FADE_NEAR_RATIO },
      uFadeFar: { value: PREVIZ_GRID_FADE_MIN },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    // 半透明的地面写进深度缓冲的话，它淡出的那一圈会把后面的对象整块挡掉。
    depthWrite: false,
    side: three.DoubleSide,
  });

  // 1×1 的平面，实际尺寸全靠 scale：跟着相机改大小时不必重建几何体。
  const grid = new three.Mesh(new three.PlaneGeometry(1, 1), material);
  grid.rotation.x = -Math.PI / 2;
  grid.renderOrder = -1;
  grid.userData.previzGrid = true;
  // 地面铺满整个视野，留着默认的射线检测会让每一次空点都命中它，于是永远点不到「空白」。
  grid.raycast = () => {};
  // 平面每趟都要挪到当时那台相机脚下，视锥剔除按的却是挪之前的位置；关掉它，
  // 免得网格在自己被摆正之前就被判成「在画面外」而整片消失。
  grid.frustumCulled = false;

  // 跟随挂在 onBeforeRender 上，而不是在每个渲染调用点手动同步：视口、右下角监看、
  // 出片截图、机位对话框的取景预览，四趟各用各的相机，逐个接线迟早会漏掉一处，
  // 而漏掉的那一趟画面里地面会整片消失（网格还停在别的相机脚下）。
  const eye = new three.Vector3();
  grid.onBeforeRender = (_renderer, _scene, camera) => {
    // 取世界坐标而不是 camera.position：机位监看那台相机的位姿是从场景节点抄来的，
    // 将来若挂到父节点下，本地坐标就不再是它实际站的地方。
    camera.getWorldPosition(eye);
    syncInfiniteGrid(grid, eye);
    // onBeforeRender 发生在 three 算完这一趟的世界矩阵之后，不补这一下的话，
    // 位置要等到下一帧才生效——表现是网格拖着相机慢一拍地漂。
    grid.updateMatrixWorld();
  };
  return grid;
}

/** 把网格挪到相机脚下并按高度调整大小。每一趟渲染之前调一次。 */
export function syncInfiniteGrid(
  grid: THREE.Mesh,
  cameraPosition: { x: number; y: number; z: number },
): void {
  const state = gridFollowState(cameraPosition.y);
  grid.position.set(cameraPosition.x, 0, cameraPosition.z);
  // 平面绕 X 转平之后本地 y 就是世界 z，所以两个方向填的是同一个边长。
  grid.scale.set(state.extent, state.extent, 1);

  const material = grid.material as THREE.ShaderMaterial;
  material.uniforms.uFadeNear!.value = state.fadeNear;
  material.uniforms.uFadeFar!.value = state.fadeFar;
}
