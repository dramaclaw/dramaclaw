// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

import { samplePathPosition, samplePathRotation, sortedPathPoints } from './pathCurve';
import {
  PREVIZ_FPS,
  type PrevizClip,
  type PrevizPathClip,
  type PrevizPathPoint,
  type PrevizScene,
  type PrevizTrack,
  type Vec3,
} from './scene';

/**
 * 时间轴的查询与操作。全部是纯函数：入参是场景，出参是新场景，一次都不改原对象——
 * store 的 undo 栈存的就是整份场景快照，就地改会把历史里的旧快照一起改掉。
 */

export function isPathClip(clip: PrevizClip): clip is PrevizPathClip {
  return clip.kind === 'path';
}

export function trackFor(scene: PrevizScene, objectId: string): PrevizTrack | undefined {
  return scene.timeline.tracks.find((track) => track.objectId === objectId);
}

export function clipById(
  scene: PrevizScene,
  clipId: string,
): { track: PrevizTrack; clip: PrevizClip } | undefined {
  for (const track of scene.timeline.tracks) {
    const clip = track.clips.find((entry) => entry.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
}

/**
 * 这一帧生效的路径片段。区间闭合（两端都算），重叠时取起始帧较晚者——设计文档
 * 「同帧同对象存在多个同类片段时取起始帧较晚者」。起始帧也相同时取数组里靠后的那条，
 * 因为新建的片段总是 push 在后面，「后建的盖住先建的」是用户能预期的方向。
 */
export function pathClipAt(track: PrevizTrack, frame: number): PrevizPathClip | undefined {
  let best: PrevizPathClip | undefined;
  for (const clip of track.clips) {
    if (!isPathClip(clip)) continue;
    if (frame < clip.startFrame || frame > clip.endFrame) continue;
    if (!best || clip.startFrame >= best.startFrame) best = clip;
  }
  return best;
}

/**
 * 帧号 → 片段内归一化参数。区间外夹到两端；长度为 0 的片段返回 0 而不是 NaN
 * ——NaN 会一路流进节点的 position，症状是对象凭空消失，病因隔着五层。
 */
export function frameToU(clip: PrevizClip, frame: number): number {
  const span = clip.endFrame - clip.startFrame;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (frame - clip.startFrame) / span));
}

export function uToFrame(clip: PrevizClip, u: number): number {
  const span = Math.max(0, clip.endFrame - clip.startFrame);
  return clip.startFrame + Math.round(Math.min(1, Math.max(0, u)) * span);
}

/** 时间轴总秒数。fps 是 schema 里钉死的 30，不从 settings 里读一个可能被改脏的值。 */
export function timelineSeconds(scene: PrevizScene): number {
  return scene.settings.durationFrames / PREVIZ_FPS;
}

/**
 * 时间轴的横向比例：每秒占多少像素。存像素而不是「缩放倍率」，是因为刻度疏密、
 * 片段宽度、播放头落点全都要拿它换算，多一层倍率只会让每处都乘一遍同样的常数。
 */
export const PREVIZ_TIMELINE_ZOOM = { min: 20, max: 480, default: 120 } as const;

/** 主刻度之间至少留这么宽，否则标签会挨在一起糊成一片。 */
const RULER_MIN_MAJOR_PX = 80;

/** 主刻度可以取的整齐间隔（秒）。不整齐的间隔（比如 0.37s）读不出来。 */
const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60] as const;

/** 每个主刻度切成几段次刻度。 */
const RULER_MINORS_PER_MAJOR = 5;

/** 尺子渲染多少根就到头：缩放算错时不至于铺出十万个 DOM 节点把页面卡死。 */
const RULER_MAX_TICKS = 2000;

export interface PrevizRulerTick {
  /** 落点，单位秒。 */
  seconds: number;
  major: boolean;
  /** 只有主刻度带文字。 */
  label: string | null;
}

/** 秒数写成刻度上的标签。整秒不带小数点，细分刻度才带。 */
function rulerLabel(seconds: number): string {
  return `${Number(seconds.toFixed(2))}s`;
}

/**
 * 一把覆盖 `totalSeconds` 的刻度尺。间隔随比例自动粗细：比例小了退到 2s/5s，
 * 放大了细到 0.2s——固定间隔要么缩放后挤成一团，要么放大后整屏只有两根线。
 */
export function rulerTicks(totalSeconds: number, pxPerSecond: number): PrevizRulerTick[] {
  const span = Math.max(0, totalSeconds);
  if (span <= 0) return [{ seconds: 0, major: true, label: rulerLabel(0) }];

  const major =
    RULER_STEPS.find((step) => step * pxPerSecond >= RULER_MIN_MAJOR_PX) ??
    RULER_STEPS[RULER_STEPS.length - 1];
  const minor = major / RULER_MINORS_PER_MAJOR;
  const count = Math.min(Math.floor(span / minor), RULER_MAX_TICKS);

  const ticks: PrevizRulerTick[] = [];
  for (let index = 0; index <= count; index += 1) {
    // 累加会把浮点误差滚成 0.30000000000000004，乘完再圆一次才对得上标签。
    const seconds = Math.round(index * minor * 1000) / 1000;
    const isMajor = index % RULER_MINORS_PER_MAJOR === 0;
    ticks.push({ seconds, major: isMajor, label: isMajor ? rulerLabel(seconds) : null });
  }
  return ticks;
}

/** 「适配」按钮要的比例：整条时间轴正好铺满轨槽，再夹回缩放范围内。 */
export function zoomToFit(totalSeconds: number, laneWidthPx: number): number {
  // 面板还没量出宽度（首帧、或者被折叠着）时别算出 0——退回默认比例。
  if (laneWidthPx <= 0 || totalSeconds <= 0) return PREVIZ_TIMELINE_ZOOM.default;
  const raw = laneWidthPx / totalSeconds;
  return Math.min(PREVIZ_TIMELINE_ZOOM.max, Math.max(PREVIZ_TIMELINE_ZOOM.min, raw));
}

/** 片段最短长度（帧）。0 长片段的 `frameToU` 无解，时间轴上也点不中。 */
export const PREVIZ_MIN_CLIP_FRAMES = 1;

/** 换掉某条轨道，其余原样。所有写操作都经过它，免得每个函数各写一遍 map。 */
function withTrack(scene: PrevizScene, trackId: string, next: PrevizTrack): PrevizScene {
  return {
    ...scene,
    timeline: {
      tracks: scene.timeline.tracks.map((track) => (track.id === trackId ? next : track)),
    },
  };
}

/** 换掉某个片段（换成数组是为了让剃刀能用同一条路径把一个片段变成两个）。 */
function withClips(scene: PrevizScene, clipId: string, next: PrevizClip[]): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found) return scene;
  return withTrack(scene, found.track.id, {
    ...found.track,
    clips: found.track.clips.flatMap((clip) => (clip.id === clipId ? next : [clip])),
  });
}

/** 新建或替换一个路径片段；对象还没有轨道时顺手建一条。 */
export function upsertPathClip(
  scene: PrevizScene,
  objectId: string,
  clip: PrevizPathClip,
): PrevizScene {
  const track = trackFor(scene, objectId);
  if (!track) {
    return {
      ...scene,
      timeline: {
        tracks: [...scene.timeline.tracks, { id: uuidv4(), objectId, clips: [clip] }],
      },
    };
  }
  const exists = track.clips.some((entry) => entry.id === clip.id);
  return withTrack(scene, track.id, {
    ...track,
    clips: exists
      ? track.clips.map((entry) => (entry.id === clip.id ? clip : entry))
      : [...track.clips, clip],
  });
}

/**
 * 整体平移片段。撞到 0 或时间轴末尾时**保长**——夹的是起点，不是两端各夹各的，
 * 后者会在边界上把片段压扁。
 */
export function moveClip(
  scene: PrevizScene,
  clipId: string,
  deltaFrames: number,
  maxFrame: number,
): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found) return scene;
  const { clip } = found;
  const span = clip.endFrame - clip.startFrame;
  const start = Math.min(
    Math.max(0, maxFrame - span),
    Math.max(0, clip.startFrame + Math.round(deltaFrames)),
  );
  return withClips(scene, clipId, [{ ...clip, startFrame: start, endFrame: start + span }]);
}

/** 把某一边拉到指定帧。两边至少留 `PREVIZ_MIN_CLIP_FRAMES` 帧，不许交叉。 */
export function trimClip(
  scene: PrevizScene,
  clipId: string,
  edge: 'start' | 'end',
  frame: number,
): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found) return scene;
  const { clip } = found;
  const target = Math.round(frame);

  if (edge === 'start') {
    const start = Math.min(Math.max(0, target), clip.endFrame - PREVIZ_MIN_CLIP_FRAMES);
    return withClips(scene, clipId, [{ ...clip, startFrame: start }]);
  }
  const end = Math.max(target, clip.startFrame + PREVIZ_MIN_CLIP_FRAMES);
  return withClips(scene, clipId, [{ ...clip, endFrame: end }]);
}

/** 把点列按切点重新归一化到 0..1，并保证切点两侧各有一个点。 */
function halfPoints(clip: PrevizPathClip, uCut: number, side: 'left' | 'right'): PrevizPathPoint[] {
  const sorted = sortedPathPoints(clip.points);
  if (sorted.length === 0) return [];

  const cut: PrevizPathPoint = {
    id: uuidv4(),
    u: side === 'left' ? 1 : 0,
    position: samplePathPosition(sorted, uCut),
    rotation: samplePathRotation(sorted, uCut),
    // 切点的朝向是从曲线采出来的，不是用户调的——标成已编辑会让它把右半段后面所有
    // 点的朝向都传播成自己。
  };

  if (side === 'left') {
    const kept = sorted
      .filter((point) => point.u < uCut)
      .map((point) => ({ ...point, u: point.u / uCut }));
    return [...kept, cut];
  }
  const kept = sorted
    .filter((point) => point.u > uCut)
    .map((point) => ({ ...point, u: (point.u - uCut) / (1 - uCut) }));
  return [cut, ...kept];
}

/**
 * 剃刀：在某一帧把路径片段切成两条各自完整的轨迹。切点两侧各留一个关键帧——不留的话
 * 两半在接缝处会各自朝下一个远处的点甩出去，播放起来是一个明显的跳。
 * 切在端点或片段之外一律不动：那会产出长度为 0 的片段。
 */
export function splitClip(scene: PrevizScene, clipId: string, frame: number): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found || !isPathClip(found.clip)) return scene;
  const clip = found.clip;
  const cut = Math.round(frame);
  if (cut <= clip.startFrame || cut >= clip.endFrame) return scene;

  const uCut = frameToU(clip, cut);
  return withClips(scene, clipId, [
    { ...clip, id: uuidv4(), endFrame: cut, points: halfPoints(clip, uCut, 'left') },
    { ...clip, id: uuidv4(), startFrame: cut, points: halfPoints(clip, uCut, 'right') },
  ]);
}

export function removeClip(scene: PrevizScene, clipId: string): PrevizScene {
  return withClips(scene, clipId, []);
}

/**
 * 把一条轨道挪到最前面（时间轴上的「置顶」）。轨道没有单独的排序字段，数组顺序
 * 就是渲染顺序——盯着某个对象排戏时把它提到眼前，比一直往下滚要省事。
 */
export function pinTrack(scene: PrevizScene, objectId: string): PrevizScene {
  const target = trackFor(scene, objectId);
  if (!target) return scene;
  return {
    ...scene,
    timeline: {
      tracks: [target, ...scene.timeline.tracks.filter((track) => track.id !== target.id)],
    },
  };
}

export function removeTrack(scene: PrevizScene, objectId: string): PrevizScene {
  return {
    ...scene,
    timeline: { tracks: scene.timeline.tracks.filter((track) => track.objectId !== objectId) },
  };
}

/** 两个 u 差在这以内就算同一个关键帧。120 帧的片段上 1e-6 远小于半帧。 */
const U_EPSILON = 1e-6;

/** 只改路径片段的点列，其余原样。四个点操作共用。 */
function withPathPoints(
  scene: PrevizScene,
  clipId: string,
  update: (points: PrevizPathPoint[]) => PrevizPathPoint[],
): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found || !isPathClip(found.clip)) return scene;
  return withClips(scene, clipId, [{ ...found.clip, points: update(found.clip.points) }]);
}

/**
 * 在播放头处插一个关键帧，值取**曲线上**的当前位置与朝向。取曲线而不是取相邻两点的
 * 中点：插一个点不该改变轨迹的形状，只该把这一处钉住。
 */
export function insertPathPointAt(
  scene: PrevizScene,
  clipId: string,
  frame: number,
): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found || !isPathClip(found.clip)) return scene;
  const clip = found.clip;
  // 空片段上没有曲线可采，插出来的点只能是原点——那是把对象拽走，不是插关键帧。
  if (clip.points.length === 0) return scene;

  const u = frameToU(clip, frame);
  const inserted: PrevizPathPoint = {
    id: uuidv4(),
    u,
    position: samplePathPosition(clip.points, u),
    rotation: samplePathRotation(clip.points, u),
  };

  return withPathPoints(scene, clipId, (points) =>
    sortedPathPoints([
      // 同一帧上留两个关键帧是无解的：谁生效取决于数组顺序。
      ...points.filter((point) => Math.abs(point.u - u) > U_EPSILON),
      inserted,
    ]),
  );
}

/**
 * 改一个轨迹点。带 `rotation` 的补丁会顺带把 `rotationEdited` 置上——这个标记就是
 * 「该朝向沿用至下一个手动调整过朝向的点」的开关，由改朝向这个动作本身触发，而不是
 * 让每个调用方自己记得传。
 *
 * `rotation: null` 是反向操作：把这个点交还给自动朝向。没有它，手滑改过一次角度的点
 * 就永远脱离了轨迹，只能删掉重插。
 */
export function updatePathPoint(
  scene: PrevizScene,
  clipId: string,
  pointId: string,
  patch: { position?: Vec3; rotation?: Vec3 | null },
): PrevizScene {
  return withPathPoints(scene, clipId, (points) =>
    points.map((point) =>
      point.id === pointId
        ? {
            ...point,
            ...(patch.position ? { position: patch.position } : {}),
            ...(patch.rotation ? { rotation: patch.rotation, rotationEdited: true } : {}),
            ...(patch.rotation === null ? { rotationEdited: false } : {}),
          }
        : point,
    ),
  );
}

export function removePathPoint(
  scene: PrevizScene,
  clipId: string,
  pointId: string,
): PrevizScene {
  return withPathPoints(scene, clipId, (points) =>
    points.filter((point) => point.id !== pointId),
  );
}

/** 清空轨迹但保留片段：重画一条不需要先把片段删了再建。 */
export function clearPathPoints(scene: PrevizScene, clipId: string): PrevizScene {
  return withPathPoints(scene, clipId, () => []);
}
