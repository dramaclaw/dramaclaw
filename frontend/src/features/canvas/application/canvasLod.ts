// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 画布平移的「细节降级」(LOD) 规则。
 *
 * 背景（实测，69 个节点 / zoom 0.1 / 同一台机器）：
 *   基线                                    62.3 fps，p90 帧时 26.6ms
 *   只去掉 backdrop-filter/shadow/filter    66.8 fps，p90 帧时 26.2ms
 *   只藏掉 <video>                          66.3 fps，p90 帧时 26.4ms
 *   两者都去掉                              74.5 fps，p90 帧时 14.1ms
 *
 * p90 是 26ms —— 恰好两个 vsync 周期，也就是每 10 帧固定丢 1 帧；肉眼看到的
 * 「顿挫」就是它，而不是平均 fps。单独砍一项都跨不回 13.3ms 的预算线，必须
 * 同时砍。参照组 liblib.tv 同缩放下是 74.6 fps / p90 14.1ms，其画布卡片上
 * 有 0 个 <video>、backdrop-filter 密度只有我们的 1/4——这是取舍不是技巧。
 *
 * 于是分两档：
 *   - 手势档（平移/缩放进行中）：只关视觉效果。动的时候没人看得见毛玻璃和
 *     投影，手势一停就恢复，稳态零视觉变化。
 *   - 低缩放档：节点在屏幕上已经很小，额外把 <video> 换成静态首帧/占位块。
 *     视频层是独立合成层，数量随节点数线性增长，只有换掉才能跨回预算线。
 */

/**
 * 低缩放档阈值。低于它才把视频降级成静态图。
 *
 * 画布节点标准宽度约 320–400px，0.35 倍下屏幕占位约 110–140px；此时首帧里
 * 已经看不清任何有效信息，换成静态图不损失可读性。高于该值保持原样，避免在
 * 常用工作缩放区间（0.5–1）出现任何行为变化。
 */
export const LOW_DETAIL_ZOOM_THRESHOLD = 0.35;

export function isLowDetailZoom(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom < LOW_DETAIL_ZOOM_THRESHOLD;
}

/**
 * 低缩放档下不做 shell 替换的节点类型。
 *
 * - skillNode：生成任务的恢复逻辑在组件内部（SkillNode 自带 resume effect，不在
 *   resumeGeneration 的 Canvas 层覆盖内），卸载期间任务完成会无人写回；且其
 *   handle id 集合是动态的（按 spec role / beat 引用 / 现存边求并集），shell 复刻
 *   不划算。技能节点数量极少，保持完整渲染。
 * - groupNode：故事板组带 dragHandle（.storyboard-group-drag-handle）和条件渲染的
 *   handle 对，shell 会破坏拖拽与边锚定；组本身只是一个标题框，渲染成本可忽略。
 * - beatContextNode：起始画面草稿只在 onBlur 落盘，React 卸载不派发 blur，编辑中
 *   shell 化会直接丢输入。
 */
export const LOD_SHELL_EXEMPT_TYPES: ReadonlySet<string> = new Set([
  'skillNode',
  'groupNode',
  'beatContextNode',
]);

/* ------------------------------------------------------------------------- *
 * 「节点媒体活跃中」信号
 *
 * 正在播放的视频不能被 shell 化——用户主动播了就说明他在看，缩放小也不该把
 * 播放器抽走（还会丢播放进度）。播放态原本是 VideoNode 组件内的 ref，shell
 * 决策发生在组件外层，读不到，所以提升成模块级注册表。
 *
 * 刻意不做成响应式：注册表变化不触发重渲染，下一次跨档/重挂时自然生效。
 * 代价是「低缩放档下暂停后节点仍保持完整渲染直到下次跨档」——单个节点，可接受。
 * ------------------------------------------------------------------------- */

const mediaActiveNodes = new Set<string>();

export function setNodeMediaActive(nodeId: string, active: boolean): void {
  if (active) mediaActiveNodes.add(nodeId);
  else mediaActiveNodes.delete(nodeId);
}

export function isNodeMediaActive(nodeId: string): boolean {
  return mediaActiveNodes.has(nodeId);
}

/** 手势进行中挂在画布容器上；CSS 侧据此关掉 backdrop-filter / shadow / filter。 */
export const CANVAS_PANNING_CLASS = 'dc-canvas--panning';

/** 低缩放档挂在画布容器上；同样关效果，另外给节点内部提供降级钩子。 */
export const CANVAS_LOW_DETAIL_CLASS = 'dc-canvas--low-detail';

/**
 * 手势结束后延迟多久摘掉 panning 类。
 *
 * React Flow 的 onMoveEnd 在惯性滚动（触控板/滚轮）真正停下之前就可能触发，
 * 立刻恢复效果会在滑行的尾巴上重新掉帧。80ms 足够盖住尾帧，又短到不会被
 * 感知成「效果慢半拍才回来」。
 */
export const PANNING_CLASS_RELEASE_DELAY_MS = 80;

/* ------------------------------------------------------------------------- *
 * 「画布静止了吗」信号
 *
 * 节点里有若干处需要读 scrollWidth / clientWidth / getBoundingClientRect 才能
 * 决定怎么渲染（例如标题溢出淡出）。这类读取会强制同步布局，单次在这个体量的
 * DOM 上约 2ms。平时无所谓，但快速平移时 React Flow 的可见性剔除每帧要挂载
 * 3~4 个节点，每个新挂载的节点都跑一遍——每帧就是 20ms 量级的布局抖动，实测
 * 拖拽帧率因此掉到 20fps 上下。
 *
 * 所以给它们一个统一的「现在别量」信号：手势进行中、或低缩放档（此时文字只有
 * 几个像素高，量了也没有可读性收益）一律跳过，等画布静下来再补测一次。
 *
 * 刻意不做成 React state：这信号一变就要通知上百个节点，走 state 等于把省下的
 * 布局时间还给 render。订阅方拿到回调后自己决定要不要 setState。
 * ------------------------------------------------------------------------- */

let gestureActive = false;
let lowDetailActive = false;
const resumeListeners = new Set<() => void>();

function notifyIfSettled(wasDeferred: boolean): void {
  if (wasDeferred && !isCanvasMeasurementDeferred()) {
    for (const listener of resumeListeners) listener();
  }
}

export function setCanvasGestureActive(active: boolean): void {
  if (gestureActive === active) return;
  const wasDeferred = isCanvasMeasurementDeferred();
  gestureActive = active;
  notifyIfSettled(wasDeferred);
}

export function setCanvasLowDetail(active: boolean): void {
  if (lowDetailActive === active) return;
  const wasDeferred = isCanvasMeasurementDeferred();
  lowDetailActive = active;
  notifyIfSettled(wasDeferred);
}

/** true 表示「现在读布局不划算」，调用方应跳过测量。 */
export function isCanvasMeasurementDeferred(): boolean {
  return gestureActive || lowDetailActive;
}

/** 手势（平移/缩放）是否进行中。shell 升级泵据此暂停放行。 */
export function isCanvasGestureActive(): boolean {
  return gestureActive;
}

/* ------------------------------------------------------------------------- *
 * shell → 完整组件的分批升级队列
 *
 * 完整节点组件的挂载很贵（VideoNode 一次 ~5ms：上百个 hook + handle 测量回流 +
 * store 订阅风暴），一帧里挂多个就丢帧。所以 shell 升级成完整组件一律排队领
 * 名额：每帧只放行 UPGRADES_PER_FRAME 个，手势进行中完全不放行（此时用户在动
 * 画布，shell 本来就是这一档该有的样子）。
 *
 * 两个来源共用这一条队列：
 *   1. 缩放升档（退出低缩放）时视口内的全部 shell——原先一次提交全升，实测
 *      179ms + 234ms 两个长帧；分批后摊平。
 *   2. 手势进行中新进视口挂载的节点——原先直接挂完整组件，快速平移时每秒
 *      几十次，是稳态 40fps 尖刺的来源。
 * ------------------------------------------------------------------------- */

/**
 * 每帧放行的升级数。VideoNode 级别的挂载单个 ~5ms，3 个 ≈ 15ms，恰好贴着
 * 75Hz 的 13.3ms 预算线；再大就会重新可感知。
 */
const UPGRADES_PER_FRAME = 3;

type UpgradeGrant = () => void;
const upgradeQueue: UpgradeGrant[] = [];
let upgradePumpScheduled = false;

function pumpUpgrades(): void {
  upgradePumpScheduled = false;
  if (upgradeQueue.length === 0) return;
  // 手势中不放行，但保持泵活着，手势一停下一帧就继续。
  if (!gestureActive) {
    for (const grant of upgradeQueue.splice(0, UPGRADES_PER_FRAME)) grant();
  }
  if (upgradeQueue.length > 0) scheduleUpgradePump();
}

function scheduleUpgradePump(): void {
  if (upgradePumpScheduled) return;
  upgradePumpScheduled = true;
  requestAnimationFrame(pumpUpgrades);
}

/**
 * 排队申请一次 shell → 完整组件的升级名额；轮到时回调 `grant`。
 * 返回取消函数（节点在排队期间被卸载/重新降档时调用）。
 */
export function requestShellUpgrade(grant: UpgradeGrant): () => void {
  upgradeQueue.push(grant);
  scheduleUpgradePump();
  return () => {
    const index = upgradeQueue.indexOf(grant);
    if (index >= 0) upgradeQueue.splice(index, 1);
  };
}

/** 画布重新静止时回调；返回取消订阅函数。 */
export function onCanvasMeasurementResume(listener: () => void): () => void {
  resumeListeners.add(listener);
  return () => {
    resumeListeners.delete(listener);
  };
}
