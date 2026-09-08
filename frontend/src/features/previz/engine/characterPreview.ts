// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { DEG_TO_RAD, clampToRange } from '../domain/camera';
import type { PrevizCharacterDraft } from '../domain/characterDraft';
import { PREVIZ_HEIGHT_CM_RANGE } from '../domain/objects';
import type { PrevizCharacter } from '../domain/scene';
import { blitCameraToCanvas, type CameraPreviewCanvas } from './cameraPreview';
import type { CharacterRigFactory } from './characterRig';
import { createInfiniteGrid } from './grid';
import { createCharacterPlaceholder, disposeSubtree, type ThreeModule } from './sceneGraph';

/**
 * 「创建人物」对话框那块木偶预览。
 *
 * 借视口那台 `WebGLRenderer`（浏览器并发的 WebGL 上下文上限约 16 个，为一个对话框再开
 * 一个是在拿整个编辑器冒险），但**不借视口那个 scene**：预览里只该有这一具木偶和一块
 * 地，把整场戏画进去等于给用户看一张缩略的视口——他正要看的是「这个人长什么样」，
 * 而不是「他会站在谁旁边」（那是左边俯视图那一栏的事）。
 *
 * 木偶本身仍由 `CharacterRigFactory` 建：共用工厂就共用了那份已经下好的 GLB 与动画库，
 * 预览不会再拉一次几 MB，姿势也保证跟视口里同一套。
 *
 * 画布尺寸不在这里定：取景直接读 `deps.canvas` 的宽高（木偶不受出片画幅约束，铺满就行，
 * 也就不需要 `previewFitRect` 那套留边）。对话框那边请用 `PREVIZ_PREVIEW_SIZE`——机位
 * 预览已经用的是它，两块预览各写各的尺寸会在同一个对话框里显出两种清晰度。
 */
export interface CharacterPreviewDeps {
  three: ThreeModule;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  canvas: CameraPreviewCanvas;
  /** 预览专用，构造一次留着（见 `createCharacterPreviewStage`）。 */
  scene: THREE.Scene;
  rig: CharacterRigFactory;
  /**
   * 这套家伙什还活着吗。`rig.build()` 可以挂上几秒，这期间用户完全可能关掉预演台：
   * 那时渲染器已经 `dispose()` 加 `forceContextLoss()`，场景的几何体也还回去了，而
   * 这次调用还停在 await 上。
   *
   * 醒来照画不会炸——three 0.185 的 `WebGLRenderer.render` 开头就是
   * `if (_isContextLost === true) return;`，而这里用的是**同步版**
   * `readRenderTargetPixels`，它读不到东西时只 `error(...)` 加 `return`（会 throw 的是
   * `readRenderTargetPixelsAsync`，不在这条路上）。真实症状是：白白分配一块 render
   * target，把一帧黑画到一块已经没人看得见的画布上，外加一串 console 噪声。挡住它是
   * 为了省这些，不是为了接住什么异常。
   *
   * 不传就是「一直活着」，给不关心生命周期的调用方（测试、一次性截图）留的。
   */
  alive?: () => boolean;
}

/** 预览场景与它那台相机。两样都是构造一次、整个会话留着。 */
export interface CharacterPreviewStage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

/**
 * 木偶预览那台相机的垂直视场角，度。
 *
 * 30° 在全画幅上约合 45 mm，也就是「标准镜头」那一档。再广（视口用的是 50°）就得站
 * 得很近，一个占满画面的人最靠前的那只脚会明显胀大，用户会以为是体型选错了；再窄要
 * 退到七八米开外，而地面那圈网格退远之后密得读不出比例。
 */
const PREVIEW_FOV_DEG = 30;

/**
 * 木偶占掉画面高度的几成。
 *
 * 取 1 是脚底与头顶正好压在画布的上下边上，而这块画布没有留白边框，压边看起来就是
 * 「人被裁掉了」。0.86 上下各留约 7%，「前倾」拖满时人往镜头这边折过来也还在画面内。
 */
const PREVIEW_FILL = 0.86;

/**
 * 相机从人物正面绕开多少度。
 *
 * `applyPoseAdjust` 是 `rotation.set(pitch, turn, lean)`，所以前倾绕世界 X、侧倾绕世界
 * Z。方位角取 0 时相机站在 -Z 朝 +Z 看：前倾的转轴横在画面里、与视线垂直，绕它转只把
 * 人前后缩短，表现为「矮了一截」，看不出往哪边弯；侧倾的转轴则与视线平行，那是纯粹的
 * 画面内滚转，反倒是最显眼的一档。把头顶点投过这台相机实测的横向位移，取绝对值（两者
 * 符号相反，前倾往左、侧倾往右；身高 1.7 m，前倾 45° / 侧倾 35°，NDC）：
 *
 *     方位角      0°       15°      30°      45°
 *     前倾     0.0000   0.1347   0.2668   0.3932
 *     侧倾     0.5549   0.5017   0.4245   0.3306
 *
 * 所以这 30° 是**专为前倾买的**：把它从「一点看不出来」抬到能读，代价是侧倾少两成三。
 * 这笔买卖划算，因为侧倾在 0° 就已经过量，而前倾在 0° 是零。30° 同时也正是人像里的四
 * 分之三侧，脸还在。
 */
const PREVIEW_AZIMUTH_DEG = 30;

/** 预览相机的近 / 远裁剪面，米。近平面与视口那台同值，两处的裁切表现因此一致。 */
const PREVIEW_NEAR_M = 0.1;
/**
 * 远平面要装得下地面网格：它跟着相机走，铺开的那块平面**边长**至少是
 * `PREVIZ_GRID_FADE_MIN`（40 m）的 2.2 倍，即 88 m——半边 44 m，最远的角约 62 m。
 * 裁在那之内的话，地面会在画面深处露出一条直边。
 */
const PREVIEW_FAR_M = 200;

/** 装当前那具木偶的常驻容器，认它用的标记。 */
const PREVIEW_ROOT_KEY = 'previzCharacterPreviewRoot';
/** 当前这具木偶是按哪份判据建出来的，记在容器上。见 `mannequinKey`。 */
const PREVIEW_BUILD_KEY = 'previzCharacterPreviewBuild';
/**
 * 最后一次调用要画的那份人物。在途的 build 醒来后按它补刷，见 `renderCharacterPreview`。
 * 跟着容器走，所以 `disposeCharacterPreviewStage` 把容器摘掉时它自然一起没，不用清。
 */
const PREVIEW_LATEST = 'previzCharacterPreviewLatest';
/**
 * 第几次重建占着「往容器里挂」这个位置。醒来时它不是自己那一号，说明后面还有一次重建
 * 在跑，这一具就该丢掉。
 *
 * 不能拿 `PREVIEW_BUILD_KEY` 当这个用：key 是**按内容算**的，「真模型」那一档所有身高
 * 姿势颜色都是同一个 `'rig'`。真模型 → 胶囊 → 真模型这么切一轮，第一次与第三次重建的
 * key 一模一样，第一次醒来会以为位置还是自己的，把第三次刚建好的那具替掉。
 */
const PREVIEW_CLAIM = 'previzCharacterPreviewClaim';

/**
 * 建一套预览用的场景与相机。
 *
 * 灯光是照视口那两盏抄的（`PrevizRenderer.create` 里的环境光 1.2 + 主光 1.8 摆在
 * (4, 8, 6)）：同一个人物在对话框里和在视口里明暗对不上，用户会以为体型或颜色也变了。
 * 两处各留一份而不是共用一个对象——一个 `Object3D` 只能有一个父节点，把视口那两盏
 * 挪过来等于把视口的光关了。
 *
 * 地面用的就是视口那块无限网格（`createInfiniteGrid`）：它靠 `onBeforeRender` 自己
 * 跟着当时那台相机走，接线一步都不用，尺度也与视口逐格对应。同样得**新建一块**，
 * 理由同上。
 */
export function createCharacterPreviewStage(three: ThreeModule): CharacterPreviewStage {
  const scene = new three.Scene();
  scene.background = new three.Color(0x101216);
  scene.add(createInfiniteGrid(three));
  scene.add(new three.AmbientLight(0xffffff, 1.2));
  const keyLight = new three.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(4, 8, 6);
  scene.add(keyLight);

  // 视场角、近远平面在这里定死；每帧只改站位与画布宽高比（见 `placePreviewCamera`）。
  const camera = new three.PerspectiveCamera(PREVIEW_FOV_DEG, 1, PREVIEW_NEAR_M, PREVIEW_FAR_M);
  return { scene, camera };
}

/**
 * 还掉一套预览场景。木偶、地面网格各持有自己的几何体与材质，而这套场景是随编辑器
 * 一起活着的——不还的话，开一次预演台漏一份。
 */
export function disposeCharacterPreviewStage(stage: CharacterPreviewStage): void {
  for (const child of [...stage.scene.children]) {
    stage.scene.remove(child);
    disposeSubtree(child);
  }
}

/**
 * 按草稿画一帧木偶预览。
 *
 * 只在**换一具木偶**时才重建（见 `mannequinKey`）；姿态微调那三根滑杆、辨识色、体型
 * 宽窄都走 `applyCharacter` 刷到现有那具身上——每拖一像素克隆一副骨架，滑杆会卡死。
 *
 * 重叠调用是安全的，但「安全」分两种，别只记住一种：
 *
 * - **又起了一次重建**（体型在「简化圆柱体」与真模型之间切）：先发那次醒来发现挂载的
 *   位置已经不是自己那一号（`PREVIEW_CLAIM`），把手里这具丢掉走人，场上只留最后那具。
 * - **没起新重建**（真模型下载期间用户改了身高 / 姿势 / 颜色）：后发那几次走的是就地
 *   刷新那条路，而那时木偶**还没挂上**，刷了个空——所以最新那份草稿要记在
 *   `PREVIEW_LATEST` 上，由先发那次在挂载前按它收尾：骨架补刷一遍，兜底的占位胶囊按
 *   它现搭（尺寸与颜色烤死在几何体和材质里，改不动），相机也按它取景。少了这一步，
 *   木偶会停在**第一次**那份草稿上，直到用户再动一次任何字段；而对话框默认体型就是真
 *   模型，第一次打开必然要等模型落地，这个窗口里的每一次编辑都命中它。
 */
export async function renderCharacterPreview(
  deps: CharacterPreviewDeps,
  draft: PrevizCharacterDraft,
): Promise<void> {
  const root = mannequinRoot(deps);
  let character = previewCharacter(draft);
  // 每次调用都记一笔，包括还没轮到自己挂木偶的那几次：在途的那次 build 醒来要按它补刷。
  root.userData[PREVIEW_LATEST] = character;
  const key = mannequinKey(character);

  if (root.userData[PREVIEW_BUILD_KEY] === key) {
    const current = root.children[0];
    // 占位胶囊那一档没有可刷的东西：它的身高与颜色都在 key 里，变了就已经重建过了。
    // `current` 为空说明先发那次还在 await，上面记的那笔就是留给它的。
    if (current?.userData.previzRig) deps.rig.applyCharacter(current, character);
  } else {
    // 先占住位置再 await：`rig.build()` 是异步的，把体型下拉框一路拖过去时两次调用会
    // 重叠。key 不占的话两次都判成「要重建」，白克隆一副骨架；号不占的话见
    // `PREVIEW_CLAIM`。
    root.userData[PREVIEW_BUILD_KEY] = key;
    const claim = ((root.userData[PREVIEW_CLAIM] as number | undefined) ?? 0) + 1;
    root.userData[PREVIEW_CLAIM] = claim;
    const built = await buildMannequin(deps, character);
    if (!(deps.alive?.() ?? true)) {
      // 等它的这段时间里整套家伙什被拆了，见 `CharacterPreviewDeps.alive`。判据要还
      // 回去：位置上并没有木偶，留着的话这套东西万一又活过来就再也不会重建了。
      if (root.userData[PREVIEW_BUILD_KEY] === key) root.userData[PREVIEW_BUILD_KEY] = undefined;
      if (built.node) disposeSubtree(built.node);
      return;
    }
    if (root.userData[PREVIEW_CLAIM] !== claim) {
      // 等它的这段时间里又起了一次重建，这一具已经过时。挂进去会把那一具替掉，或者和
      // 它叠在一起。（草稿只是改了参数、没起新重建的那种，走的是下面的补刷。）
      if (built.node) disposeSubtree(built.node);
      return;
    }
    // 按等待期间最后一份草稿收尾，见函数头那两种「安全」。
    character = root.userData[PREVIEW_LATEST] as PrevizCharacter;
    // 占位胶囊拖到这里才建：尺寸烤在 `CapsuleGeometry` 里、辨识色烤在材质里，等待开始
    // 时那份草稿建出来的那一根改不动，只能按最新这份现搭。
    const node = built.node ?? createCharacterPlaceholder(deps.three, character);
    if (node.userData.previzRig) deps.rig.applyCharacter(node, character);
    // 模型没到手，挂上去的是兜底的胶囊：把判据抹掉，下一次编辑就等于一次重试。不抹的
    // 话这个对话框在这次会话里永远停在胶囊上，而用户什么提示都没有。
    if (!built.complete) root.userData[PREVIEW_BUILD_KEY] = undefined;
    for (const child of [...root.children]) {
      root.remove(child);
      disposeSubtree(child);
    }
    root.add(node);
  }

  const width = Math.max(1, Math.floor(deps.canvas.width));
  const height = Math.max(1, Math.floor(deps.canvas.height));
  placePreviewCamera(deps, character.heightCm, width / height);
  blitCameraToCanvas(deps, deps.camera, { x: 0, y: 0, width, height });
}

/**
 * 换一具木偶的判据。**只有这两件事**要重建：
 *
 * - 在「简化圆柱体」与真模型之间来回切——那是两件完全不同的东西；
 * - 简化圆柱体自己的身高或辨识色变了——胶囊的尺寸是烤进 `CapsuleGeometry` 的，颜色
 *   烤进材质，改不动，只能换一件（两件小几何体，与克隆一副骨架不是一个量级）。
 *
 * 其余一律不重建，因为 `CharacterRigFactory` 已经替它们各留了一条就地改的路：身高走
 * `applyBodyScale` 的一次 uniform 缩放，体型宽窄走同一处的 `BODY_WIDTH_SCALE`，基础
 * 姿势走 `applyPose`（它本来就是为「rig 建好之后还能改姿势」写的），辨识色走
 * `applyTint`。为这些重建等于把那四层缓存全绕过去。
 *
 * 身高先夹进 `PREVIZ_HEIGHT_CM_RANGE` 再进 key（`previewCharacter` 里夹的）：用户在
 * 数字框里从 1000 敲到 1001，木偶两次都是 220 cm，不该因此拆一次几何体。
 */
function mannequinKey(character: PrevizCharacter): string {
  if (character.bodyType === 'capsule') {
    return `capsule:${character.heightCm}:${character.color}`;
  }
  return 'rig';
}

/** 建好的一具木偶。 */
interface BuiltMannequin {
  /** 那具骨架；`null` 表示这一具要用占位胶囊，由调用方按最新那份草稿现搭。 */
  node: THREE.Object3D | null;
  /** 为假表示要的是真模型、但只兜到了胶囊。 */
  complete: boolean;
}

/**
 * 按体型建一具木偶。
 *
 * 「简化圆柱体」不问 rig 工厂要模型：那一档的语义就是「这个人物不要 GLB」，问了等于
 * 把这一档存在的理由抹掉，还会替用户下几 MB 他明确不要的东西。
 *
 * 真模型建不出来（GLB 没下下来）时兜一根胶囊，与场景图里那条「加载失败就留着占位体」
 * 是同一个取舍：给用户一块空地，他会以为是自己选错了体型。
 */
async function buildMannequin(
  deps: CharacterPreviewDeps,
  character: PrevizCharacter,
): Promise<BuiltMannequin> {
  if (character.bodyType === 'capsule') return { node: null, complete: true };
  const rig = await deps.rig.build(character);
  return { node: rig, complete: rig !== null };
}

/** 预览场景里那个常驻的木偶容器，没有就建一个。 */
function mannequinRoot(deps: CharacterPreviewDeps): THREE.Object3D {
  const existing = deps.scene.children.find((child) => child.userData[PREVIEW_ROOT_KEY]);
  if (existing) return existing;
  const root = new deps.three.Group();
  root.userData[PREVIEW_ROOT_KEY] = true;
  deps.scene.add(root);
  return root;
}

/**
 * 把草稿摊成 rig 工厂与占位体工厂都收的那个形状。
 *
 * 身高在这里就夹进 `PREVIZ_HEIGHT_CM_RANGE`，而不是留给下游各夹各的：`applyBodyScale`
 * 与 `createCharacterPlaceholder` 确实都会自己夹一次，但**摆相机的那一步不会**。用户
 * 在身高框里敲进 1000，木偶还是 220 cm，相机却按 10 m 的人退到二十多米开外——画面上
 * 是一个远处的小点，而每一处夹取都「工作正常」。
 *
 * id 与 transform 是凑给 `PrevizCharacter` 这个类型的：rig 工厂只读体型、身高、姿势、
 * 姿态微调与辨识色（见 `applyCharacter`），预览里这具木偶也没有场景身份可言。
 */
function previewCharacter(draft: PrevizCharacterDraft): PrevizCharacter {
  return {
    id: 'previz-character-preview',
    kind: 'character',
    name: draft.name,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    color: draft.color,
    bodyType: draft.bodyType,
    heightCm: clampToRange(draft.heightCm, PREVIZ_HEIGHT_CM_RANGE),
    heightPolicy: draft.heightPolicy,
    planeY: 0,
    basePoseId: draft.basePoseId,
    // 摊平一份。建出来的这个 `PrevizCharacter` 会作为 `PREVIEW_LATEST` 挂在容器上留到
    // 下一次调用，也就是说它要在**调用方的这一帧之外**继续有效；共用引用的话它就跟着
    // 调用方那个对象走，谁原地改一下都会追溯改掉这份「等待期间的最后一份草稿」。今天
    // 的调用方是换新对象的 React state，碰巧不会——这份拷贝是为了不必依赖那个碰巧。
    poseAdjust: { ...draft.poseAdjust },
  };
}

/**
 * 按身高把相机摆好。
 *
 * 让身高 h 的木偶占掉 `PREVIEW_FILL` 那么多画面高度：相机在距离 d 处看到的画面高度是
 * `2 · d · tan(fov / 2)`，令它等于 `h / FILL` 解得
 *
 *     d = h / (2 · FILL · tan(fov / 2))
 *
 * 于是 d 与身高成正比——120 cm 与 220 cm 拿到的是同一个构图，只是尺子不一样，用户拖
 * 身高滑杆时人在画面里的大小不变，变的是脚下那圈网格的疏密（他能从那里读出高矮）。
 *
 * 只按**垂直**方向解：预览画布是 16:9 的横幅，而人是竖的，水平方向永远有富余，拿宽度
 * 去解会得到一个近得多的距离，人反而顶出画面。
 *
 * 视线抬到半身高、看向 `(0, h/2, 0)`：贴着地面平视的话人在画面上半截，而俯视会把身高
 * 压短——这块预览恰恰是用来比较身高的。
 */
function placePreviewCamera(
  deps: CharacterPreviewDeps,
  heightCm: number,
  aspect: number,
): void {
  const height = heightCm / 100;
  const distance = height / (2 * PREVIEW_FILL * Math.tan((PREVIEW_FOV_DEG / 2) * DEG_TO_RAD));
  const azimuth = PREVIEW_AZIMUTH_DEG * DEG_TO_RAD;
  const eyeY = height / 2;
  // 人物零旋转时朝 -Z（`characterRig.build` 把克隆体转了半圈就为这条约定），所以正面
  // 在 -Z 那侧；站到 +Z 去看的是后脑勺。
  deps.camera.position.set(distance * Math.sin(azimuth), eyeY, -distance * Math.cos(azimuth));
  // 视场角每帧写一次而不是只在建相机时写：上面那个距离是按它解出来的，两者必须是同一
  // 个数。分开写的话，谁改了一处构图就整个错位，而画面上只表现为「人怎么变小了」。
  deps.camera.fov = PREVIEW_FOV_DEG;
  deps.camera.aspect = aspect;
  deps.camera.updateProjectionMatrix();
  deps.camera.lookAt(0, eyeY, 0);
}
