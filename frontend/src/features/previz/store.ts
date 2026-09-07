// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

import {
  insertAudioClip,
  type AudioInsertRejection,
  type PrevizAudioSource,
} from './domain/audioTrack';
import { clampToRange } from './domain/camera';
import { canAddObject } from './domain/limits';
import {
  createPrevizObject,
  withoutUndefined,
  type PrevizObjectOverrides,
  type PrevizObjectPatch,
} from './domain/objects';
import {
  drawSeedRotation,
  pathPointSeeds,
  PREVIZ_PATH_SPACING_M,
  PREVIZ_PATH_SPEED_MPS,
  resampleByDistance,
  smoothStroke,
  strokeDurationFrames,
} from './domain/pathDraw';
import {
  createDefaultScene,
  PREVIZ_FPS,
  PREVIZ_MAX_DURATION_FRAMES,
  PREVIZ_MIN_DURATION_FRAMES,
  parseObject,
  type DisplayMode,
  type OutputAspect,
  type PrevizObject,
  type PrevizObjectKind,
  type PrevizPathClip,
  type PrevizScene,
  type Vec3,
} from './domain/scene';
import {
  addRigClip,
  createRigClip,
  rigClipToPath,
  updateRigClip,
  type CloseupTarget,
  type RigClipPatch,
} from './domain/closeupClip';
import { insertCut, liveCameraAt, retargetCut, type CutRejection } from './domain/program';
import {
  PREVIZ_TIMELINE_ZOOM,
  clearPathPoints,
  clipById,
  insertPathPointAt,
  moveClip,
  pathClipAt,
  pinTrack,
  removeClip,
  removePathPoint,
  removeTrack,
  setPathAim,
  splitClip,
  trackFor,
  timelineSeconds,
  trimClip,
  updatePathPoint,
  upsertClip,
  zoomToFit,
} from './domain/timeline';

/** 场景是纯数值 JSON，整份快照很便宜；50 步够覆盖一次连续编辑。 */
export const PREVIZ_HISTORY_LIMIT = 50;

/** 播放倍速下拉框的档位。照抄参照实现的 0.25×–2×。 */
export const PREVIZ_PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2] as const;

/**
 * 把一条刚编辑过的记录重新过一遍读盘时的逐字段校验：越界值夹回区间，非有限值回落
 * 默认值，不属于这个 kind 的字段丢掉。直接复用 `parseObject` 而不在 store 里另抄一份
 * 字段表与区间常量——两份实现迟早会对同一个越界值给出不同答案。
 *
 * `?? object` 不是形式主义：`parseObject` 的三种丢弃条件里，「记录不是对象」在这个
 * 调用点到不了（入参已经是对象），另外两种到得了——id 不可用（缺失、非字符串或空串）
 * 与 kind 不认识。光看类型这两样也该到不了（patch 与 overrides 都改不到 id / kind），
 * 但 `loadScene` / `applyScene` 的入参是调用方自建的 `PrevizScene`，**不经 `parseScene`**，
 * 空 id 这类脏值本来就能从那里进场景；JS 调用方也不受 patch 类型约束。而
 * `normalizeObject` 存在的全部理由就是拦运行时脏值，拿类型论证它够不着自相矛盾。
 * 丢弃时兜回原对象：宁可在场景里留一个没规范化的对象，也不能让 `undefined` 流进
 * `scene.objects`，再被 `JSON.stringify` 原样写进 `node.data`。
 * 编译期指望不上——`tsconfig.app.json` 没开 `noUncheckedIndexedAccess`，`?? object`
 * 少了也不会报错。
 */
function normalizeObject(object: PrevizObject): PrevizObject {
  return parseObject(object) ?? object;
}

interface PrevizStoreState {
  scene: PrevizScene;
  /** 相对上次写回 node.data 是否有未落盘改动。 */
  dirty: boolean;
  past: PrevizScene[];
  future: PrevizScene[];
  /**
   * 选中对象与监看机位是**会话态**，刻意不进 PrevizScene、也不进 undo 栈：
   * 撤销一次删除该把对象撤回来，而不是顺带把用户当前选的东西也换掉。
   */
  selectedObjectId: string | null;
  activeCameraId: string | null;
  /**
   * 监看是否跟着镜头轨走。手动点一台机位就退出跟随；这是会话状态，不进 undo，
   * 也不存进场景——换个人打开同一节点，默认还是跟随。
   */
  monitorFollowsProgram: boolean;
  /**
   * 每次跳转/停止 +1，编辑器靠它知道该重新起播音频。播放 tick 不动它。
   * 播到头自动停也不动它：那时音频本来就已按片段长度排完，不需要重起。
   */
  seekSerial: number;
  /**
   * 时间轴会话态。和 `selectedObjectId` 同一类：刻意不进 `PrevizScene`、不进 undo 栈。
   * 播放头进了场景，每拖一格就是一次 `dirty`，关窗时会把一次纯浏览写回 `node.data`；
   * 进了 undo 栈则更糟——撤销一次删除会顺带把播放头拽回删除前的位置。
   */
  timelineFrame: number;
  timelinePlaying: boolean;
  /**
   * 播放时被取整丢掉的那小半帧。rAF 大约每 16ms 醒一次，而时间轴是 30fps——
   * 一次心跳只推进 0.48 帧，每次都取整就永远是 0，播放头卡在原地不动。
   * 把余数留到下一次心跳，攒够一帧才走一格。
   */
  playbackCarry: number;
  timelineRate: number;
  /** 时间轴的横向比例，每秒多少像素。是「怎么看」，不进场景也不进 undo 栈。 */
  timelineZoom: number;
  selectedClipId: string | null;
  selectedPointId: string | null;
  /** 绘制轨迹时的轨迹点间距，单位米。 */
  pathSpacingM: number;
  /** 绘制轨迹时按多快的速度走，米/秒。决定一笔画出来的片段有多长。 */
  pathSpeedMps: number;
  setTimelineFrame: (frame: number) => void;
  setTimelinePlaying: (playing: boolean) => void;
  /** 停止：回到第 0 帧。参照实现的「停止」按钮就是这个语义，不是暂停。 */
  stopPlayback: () => void;
  /** 推进播放头；走到末尾就停住，不循环。入参是这一帧的真实耗时，单位秒。 */
  tickPlayback: (deltaSeconds: number) => void;
  setTimelineRate: (rate: number) => void;
  /** 按倍数缩放时间轴（放大传 >1，缩小传 <1），夹在缩放范围内。 */
  zoomTimelineBy: (factor: number) => void;
  /** 「适配」：把整条时间轴铺进这么宽的轨槽。宽度由 UI 量出来传进来。 */
  fitTimelineZoom: (laneWidthPx: number) => void;
  selectClip: (id: string | null) => void;
  selectPathPoint: (id: string | null) => void;
  setPathSpacing: (metres: number) => void;
  setPathSpeed: (metresPerSecond: number) => void;
  /** 把一笔世界坐标笔画变成选中对象的轨迹。对象还没有轨道时顺手建一条。 */
  drawPath: (objectId: string, stroke: Vec3[]) => void;
  /** 给对象建一条空轨道与一个铺满时间轴的空片段（时间轴上的「+ 添加对象」）。 */
  addObjectToTimeline: (objectId: string) => void;
  insertKeyframe: (clipId: string) => void;
  updateKeyframe: (
    clipId: string,
    pointId: string,
    /** `rotation: null` 表示把这个点交还给自动朝向。 */
    patch: { position?: Vec3; rotation?: Vec3 | null },
  ) => void;
  removeKeyframe: (clipId: string, pointId: string) => void;
  clearPath: (clipId: string) => void;
  moveClipBy: (clipId: string, deltaFrames: number) => void;
  trimClipToPlayhead: (clipId: string, edge: 'start' | 'end') => void;
  /** 直接改片段终点（改长度，不是平移）。 */
  setClipEnd: (clipId: string, endFrame: number) => void;
  /** 把片段的某一端拖到某一帧（时间轴上的修剪把手）。 */
  setClipEdge: (clipId: string, edge: 'start' | 'end', frame: number) => void;
  /** 在最后一个片段之后、时间轴末尾之前追加一个空片段；没有空档时什么都不做。 */
  appendClip: (objectId: string) => void;
  /** 把一条轨道挪到最上面。 */
  pinTrackToTop: (objectId: string) => void;
  splitClipAtPlayhead: (clipId: string) => void;
  removeClipById: (clipId: string) => void;
  removeTrackFor: (objectId: string) => void;
  /** 路径片段的「看向」：走的是自己那条路，眼睛一路盯着谁。null 回到沿切线朝向。 */
  setClipAim: (clipId: string, aimObjectId: string | null) => void;
  /** 给机位新建一段特写，覆盖被跟对象在时间轴上已经占到的那一段。 */
  addCloseup: (cameraObjectId: string, target: CloseupTarget) => void;
  updateCloseup: (clipId: string, patch: RigClipPatch) => void;
  /** 「转为路径片段」：把跟踪结果烤成关键帧，从此不再跟着人物走。 */
  bakeCloseup: (clipId: string) => void;
  /** 打开编辑器时灌入初始场景，同时清空历史——上一次会话的 undo 不该跨节点串。 */
  loadScene: (scene: PrevizScene) => void;
  /** 场景改动的唯一入口：压历史、清 redo、置脏。 */
  applyScene: (next: PrevizScene) => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;
  selectObject: (id: string | null) => void;
  setActiveCamera: (id: string | null) => void;
  followProgram: () => void;
  /** 在播放头处切到某机位；返回拒绝原因，成功为 null。 */
  cutToCamera: (cameraId: string) => CutRejection | null;
  setCutCamera: (clipId: string, cameraId: string) => void;
  addAudioClip: (source: PrevizAudioSource, atFrame: number) => AudioInsertRejection | null;
  relocateAudioClipToPlayhead: (clipId: string) => void;
  /** 建对象并选中它；超出该类型数量上限时返回 null 且不动场景。 */
  addObject: <K extends PrevizObjectKind>(
    kind: K,
    overrides?: PrevizObjectOverrides<K>,
  ) => string | null;
  updateObject: (id: string, patch: PrevizObjectPatch) => void;
  removeObject: (id: string) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setOutputAspect: (aspect: OutputAspect) => void;
  setDurationFrames: (frames: number) => void;
}

export const usePrevizStore = create<PrevizStoreState>((set, get) => ({
  scene: createDefaultScene(),
  dirty: false,
  past: [],
  future: [],
  selectedObjectId: null,
  activeCameraId: null,
  monitorFollowsProgram: true,
  seekSerial: 0,
  timelineFrame: 0,
  timelinePlaying: false,
  playbackCarry: 0,
  timelineRate: 1,
  timelineZoom: PREVIZ_TIMELINE_ZOOM.default,
  selectedClipId: null,
  selectedPointId: null,
  pathSpacingM: PREVIZ_PATH_SPACING_M.default,
  pathSpeedMps: PREVIZ_PATH_SPEED_MPS.default,

  loadScene: (scene) =>
    set({
      scene,
      dirty: false,
      past: [],
      future: [],
      selectedObjectId: null,
      activeCameraId: null,
      monitorFollowsProgram: true,
      timelineFrame: 0,
      timelinePlaying: false,
      playbackCarry: 0,
      // 换节点等于换一条时间轴，上一条缩到多大跟这条的时长没关系。
      timelineZoom: PREVIZ_TIMELINE_ZOOM.default,
      selectedClipId: null,
      selectedPointId: null,
    }),

  applyScene: (next) => {
    const { scene, past } = get();
    set({
      scene: next,
      dirty: true,
      past: [...past, scene].slice(-PREVIZ_HISTORY_LIMIT),
      future: [],
    });
  },

  undo: () => {
    const { past, scene, future } = get();
    const previous = past[past.length - 1];
    if (!previous) return;
    set({ scene: previous, past: past.slice(0, -1), future: [scene, ...future], dirty: true });
  },

  redo: () => {
    const { future, scene, past } = get();
    const [next, ...rest] = future;
    if (!next) return;
    set({
      scene: next,
      future: rest,
      past: [...past, scene].slice(-PREVIZ_HISTORY_LIMIT),
      dirty: true,
    });
  },

  markSaved: () => set({ dirty: false }),

  selectObject: (id) => set({ selectedObjectId: id, selectedClipId: null, selectedPointId: null }),

  setActiveCamera: (id) => set({ activeCameraId: id, monitorFollowsProgram: false }),

  followProgram: () => set({ monitorFollowsProgram: true }),

  addObject: (kind, overrides) => {
    const { scene, applyScene } = get();
    // 越界时连新场景都不建：建了就等于往 undo 栈里塞一步什么都没干的操作。
    if (!canAddObject(scene, kind)) return null;

    // overrides 会从导入路径带进脏数值，所以新建这一步也收敛一次；
    // 不带 overrides 时 `createPrevizObject` 的默认值本就合法，这一步是幂等的。
    const created = normalizeObject(createPrevizObject(kind, scene.objects, overrides));
    applyScene({ ...scene, objects: [...scene.objects, created] });
    set({ selectedObjectId: created.id });
    return created.id;
  },

  updateObject: (id, patch) => {
    const { scene, applyScene } = get();
    if (!scene.objects.some((object) => object.id === id)) return;

    applyScene({
      ...scene,
      objects: scene.objects.map((object) =>
        // patch 是四种对象 Partial 的交集，往人物身上写 focalMm 编译期拦不住；
        // `normalizeObject` 会把不属于这个 kind 的字段丢掉。类型上 patch 不含 `kind`，
        // 所以正常路径下 kind 由被改对象保留；JS 调用方硬塞一个 `kind` 则会让这条记录
        // 按新 kind 重新解析、却留着旧 id。结构性拦下来（合并后再钉回 `object.kind`）
        // 会把 kind 拓宽成整个联合而报 TS2345，等于要把 `as PrevizObject` 断言请回来，
        // 不划算。
        // `withoutUndefined`：exactOptionalPropertyTypes 关着，`{ name: maybeName }` 能
        // 过类型检查，原样合并会把已有值盖成 undefined，再被规范化「修」成默认值。
        object.id === id ? normalizeObject({ ...object, ...withoutUndefined(patch) }) : object,
      ),
    });
  },

  removeObject: (id) => {
    const { scene, applyScene, selectedObjectId, activeCameraId, monitorFollowsProgram } = get();
    if (!scene.objects.some((object) => object.id === id)) return;

    applyScene({
      ...scene,
      objects: scene.objects.filter((object) => object.id !== id),
      timeline: {
        ...scene.timeline,
        // 轨道跟着走：留下来就是一个悬空引用，P3 的求值器会撞上它。
        tracks: scene.timeline.tracks.filter((track) => track.objectId !== id),
        // 机位没了，指向它的切片一起走，同一步 undo 能整体回来。
        program: scene.timeline.program.filter((cut) => cut.cameraId !== id),
      },
    });
    set({
      selectedObjectId: selectedObjectId === id ? null : selectedObjectId,
      activeCameraId: activeCameraId === id ? null : activeCameraId,
      // 手动挑的那台没了，监看回到跟随，而不是黑着等人再点一次「跟随」。
      monitorFollowsProgram: activeCameraId === id ? true : monitorFollowsProgram,
    });
  },

  setDisplayMode: (mode) => {
    const { scene, applyScene } = get();
    applyScene({ ...scene, settings: { ...scene.settings, displayMode: mode } });
  },

  setOutputAspect: (aspect) => {
    const { scene, applyScene } = get();
    applyScene({ ...scene, settings: { ...scene.settings, outputAspect: aspect } });
  },

  setDurationFrames: (frames) => {
    const { scene, applyScene, timelineFrame } = get();
    const clamped = Math.min(
      PREVIZ_MAX_DURATION_FRAMES,
      Math.max(PREVIZ_MIN_DURATION_FRAMES, Math.round(frames) || PREVIZ_MIN_DURATION_FRAMES),
    );
    applyScene({ ...scene, settings: { ...scene.settings, durationFrames: clamped } });
    // 时间轴缩短到播放头以内时把播放头拽回来，否则它停在时间轴外面，拖都拖不动。
    // 走 setTimelineFrame 而不是直接 set：这也是一次跳转，seekSerial 该跟着走一格。
    if (timelineFrame > clamped) get().setTimelineFrame(clamped);
  },

  setTimelineFrame: (frame) => {
    const { scene } = get();
    // 四舍五入到整帧：小数帧在刻度尺上落在两格之间，读数也会抖。
    const clamped = Math.min(scene.settings.durationFrames, Math.max(0, Math.round(frame)));
    // 手动定位播放头会把攒着的半帧作废：那半帧是上一段连续播放的余数，
    // 留着会让下一次播放的第一格提前跳。
    // seekSerial +1：编辑器靠它识别「这是一次跳转」，该重新起播音频而不是接着上次的播放位置。
    set((state) => ({
      timelineFrame: Number.isFinite(clamped) ? clamped : 0,
      playbackCarry: 0,
      seekSerial: state.seekSerial + 1,
    }));
  },

  setTimelinePlaying: (playing) => set({ timelinePlaying: playing }),

  stopPlayback: () =>
    set((state) => ({
      timelinePlaying: false,
      timelineFrame: 0,
      playbackCarry: 0,
      seekSerial: state.seekSerial + 1,
    })),

  tickPlayback: (deltaSeconds) => {
    const { timelinePlaying, timelineFrame, timelineRate, scene, playbackCarry } = get();
    if (!timelinePlaying) return;
    const last = scene.settings.durationFrames;
    const next = timelineFrame + playbackCarry + deltaSeconds * PREVIZ_FPS * timelineRate;
    // 停在最后一帧，不回零、不循环——实测参照实现就是这样（循环默认关）。
    if (next >= last) {
      set({ timelineFrame: last, timelinePlaying: false, playbackCarry: 0 });
      return;
    }
    // 向下取整而不是四舍五入，余数攒进 playbackCarry：见那个字段的注释，
    // 每次心跳都取整会把 0.48 帧全丢掉，播放头一格都不走。
    const frame = Math.floor(next);
    set({ timelineFrame: frame, playbackCarry: next - frame });
  },

  zoomTimelineBy: (factor) => {
    const next = get().timelineZoom * factor;
    set({
      timelineZoom: Math.min(
        PREVIZ_TIMELINE_ZOOM.max,
        Math.max(PREVIZ_TIMELINE_ZOOM.min, next),
      ),
    });
  },

  fitTimelineZoom: (laneWidthPx) => {
    set({ timelineZoom: zoomToFit(timelineSeconds(get().scene), laneWidthPx) });
  },

  setTimelineRate: (rate) => {
    // 下拉框只给这五档，其它值一律夹到最近的一档：99 倍速一帧就跑完整条时间轴。
    const nearest = PREVIZ_PLAYBACK_RATES.reduce((best, option) =>
      Math.abs(option - rate) < Math.abs(best - rate) ? option : best,
    );
    set({ timelineRate: nearest });
  },

  selectClip: (id) => set({ selectedClipId: id, selectedPointId: null }),

  selectPathPoint: (id) => set({ selectedPointId: id }),

  setPathSpacing: (metres) => set({ pathSpacingM: clampToRange(metres, PREVIZ_PATH_SPACING_M) }),

  setPathSpeed: (metresPerSecond) =>
    set({ pathSpeedMps: clampToRange(metresPerSecond, PREVIZ_PATH_SPEED_MPS) }),

  drawPath: (objectId, stroke) => {
    const { scene, applyScene, pathSpacingM, pathSpeedMps, timelineFrame } = get();
    if (!scene.objects.some((object) => object.id === objectId)) return;
    // 空笔画（点一下没拖）不建片段：建了就是往 undo 栈里塞一步什么都没干的操作。
    if (stroke.length < 2) return;

    const positions = resampleByDistance(smoothStroke(stroke), pathSpacingM);
    const points = pathPointSeeds(positions, drawSeedRotation(scene, objectId, timelineFrame));
    if (points.length < 2) return;

    const track = trackFor(scene, objectId);
    // 重画是改播放头下的那条轨迹，不是叠一条新的——叠起来两条同时覆盖同一帧，
    // 谁生效全靠 `pathClipAt` 的取舍，用户看到的是随机结果。
    const existing = track ? pathClipAt(track, timelineFrame) : undefined;
    /*
      片段有多长由这一笔的长度和画笔速度定（见 [strokeDurationFrames]），不再一律铺满
      时间轴。铺满的老做法等于「画多长都是 4 秒」，长轨迹只是走得更快，而用户画得更长
      想要的正是走得更久。

      重画沿用原来的起点、只重新定终点：那条片段可能已经被挪到时间轴中段、跟别的片段
      排好了先后，把它甩回 0 帧等于把编排推翻重来。
    */
    const startFrame = existing?.startFrame ?? 0;
    const endFrame = Math.min(
      PREVIZ_MAX_DURATION_FRAMES,
      startFrame + strokeDurationFrames(positions, pathSpeedMps),
    );
    const clip: PrevizPathClip = existing
      ? { ...existing, endFrame, points }
      : { id: uuidv4(), kind: 'path', startFrame, endFrame, points };

    /*
      片段伸到时间轴外面就把时间轴撑长，不然这一笔后半段既播不到也剪不着。只撑不缩：
      时间轴是整个场景共用的，为了一条短轨迹把它裁短，别的对象的片段就跟着被裁了。
    */
    const withClip = upsertClip(scene, objectId, clip);
    const durationFrames = Math.max(withClip.settings.durationFrames, clip.endFrame);
    applyScene(
      durationFrames === withClip.settings.durationFrames
        ? withClip
        : { ...withClip, settings: { ...withClip.settings, durationFrames } },
    );
    set({ selectedClipId: clip.id, selectedPointId: null });
  },

  addObjectToTimeline: (objectId) => {
    const { scene, applyScene } = get();
    if (!scene.objects.some((object) => object.id === objectId)) return;
    const clip: PrevizPathClip = {
      id: uuidv4(),
      kind: 'path',
      startFrame: 0,
      endFrame: scene.settings.durationFrames,
      points: [],
    };
    applyScene(upsertClip(scene, objectId, clip));
    set({ selectedClipId: clip.id, selectedPointId: null });
  },

  insertKeyframe: (clipId) => {
    const { scene, applyScene, timelineFrame } = get();
    applyScene(insertPathPointAt(scene, clipId, timelineFrame));
  },

  updateKeyframe: (clipId, pointId, patch) => {
    const { scene, applyScene } = get();
    applyScene(updatePathPoint(scene, clipId, pointId, patch));
  },

  removeKeyframe: (clipId, pointId) => {
    const { scene, applyScene, selectedPointId } = get();
    applyScene(removePathPoint(scene, clipId, pointId));
    if (selectedPointId === pointId) set({ selectedPointId: null });
  },

  clearPath: (clipId) => {
    const { scene, applyScene } = get();
    applyScene(clearPathPoints(scene, clipId));
    set({ selectedPointId: null });
  },

  moveClipBy: (clipId, deltaFrames) => {
    const { scene, applyScene } = get();
    const next = moveClip(scene, clipId, deltaFrames, scene.settings.durationFrames);
    if (next === scene) return;
    applyScene(next);
  },

  trimClipToPlayhead: (clipId, edge) => {
    const { scene, applyScene, timelineFrame } = get();
    applyScene(trimClip(scene, clipId, edge, timelineFrame));
  },

  setClipEnd: (clipId, endFrame) => {
    const { scene, applyScene } = get();
    // 复用 trimClip 的夹取：最小长度与时间轴上下界只有一处真相。
    applyScene(trimClip(scene, clipId, 'end', Math.round(endFrame)));
  },

  setClipEdge: (clipId, edge, frame) => {
    const { scene, applyScene } = get();
    applyScene(trimClip(scene, clipId, edge, frame));
  },

  appendClip: (objectId) => {
    const { scene, applyScene } = get();
    const track = trackFor(scene, objectId);
    const end = track
      ? track.clips.reduce((last, clip) => Math.max(last, clip.endFrame), 0)
      : 0;
    // 已经铺到末尾就不追加：追出来的是个 0 长片段，点不中也画不了。
    if (end >= scene.settings.durationFrames) return;

    const clip: PrevizPathClip = {
      id: uuidv4(),
      kind: 'path',
      startFrame: end,
      endFrame: scene.settings.durationFrames,
      points: [],
    };
    applyScene(upsertClip(scene, objectId, clip));
    set({ selectedClipId: clip.id, selectedPointId: null });
  },

  pinTrackToTop: (objectId) => {
    const { scene, applyScene } = get();
    applyScene(pinTrack(scene, objectId));
  },

  splitClipAtPlayhead: (clipId) => {
    const { scene, applyScene, timelineFrame, selectedClipId } = get();
    const next = splitClip(scene, clipId, timelineFrame);
    if (next === scene) return;
    applyScene(next);
    // 被切的那条已经不存在了（剃刀交出的是两条新片段），选中态得跟着放开。
    if (selectedClipId === clipId) set({ selectedClipId: null, selectedPointId: null });
  },

  removeClipById: (clipId) => {
    const { scene, applyScene, selectedClipId } = get();
    applyScene(removeClip(scene, clipId));
    if (selectedClipId === clipId) set({ selectedClipId: null, selectedPointId: null });
  },

  removeTrackFor: (objectId) => {
    const { scene, applyScene } = get();
    applyScene(removeTrack(scene, objectId));
    set({ selectedClipId: null, selectedPointId: null });
  },

  cutToCamera: (cameraId) => {
    const { scene, timelineFrame, applyScene } = get();
    const result = insertCut(scene, timelineFrame, cameraId);
    if (!result.ok) return result.reason;
    applyScene(result.scene);
    return null;
  },

  setCutCamera: (clipId, cameraId) => {
    const { scene, applyScene } = get();
    const next = retargetCut(scene, clipId, cameraId);
    // 引用相等：机位不是 camera、片段不存在、或已是这台，`retargetCut` 都原样交回同一个
    // 对象，这里不必再重复判一遍就知道是不是空操作。
    if (next === scene) return;
    applyScene(next);
  },

  addAudioClip: (source, atFrame) => {
    const { scene, applyScene } = get();
    const result = insertAudioClip(scene, atFrame, source);
    if (!result.ok) return result.reason;
    applyScene(result.scene);
    set({ selectedClipId: result.clipId, selectedPointId: null });
    return null;
  },

  relocateAudioClipToPlayhead: (clipId) => {
    const { scene, timelineFrame, applyScene } = get();
    const found = clipById(scene, clipId);
    if (!found || found.table !== 'audio') return;
    const next = moveClip(
      scene,
      clipId,
      timelineFrame - found.clip.startFrame,
      scene.settings.durationFrames,
    );
    if (next !== scene) applyScene(next);
  },

  addCloseup: (cameraObjectId, target) => {
    const { scene, applyScene } = get();
    if (!scene.objects.some((object) => object.id === cameraObjectId)) return;
    if (!scene.objects.some((object) => object.id === target.objectId)) return;

    const clip = createRigClip({
      anchorObjectId: target.objectId,
      startFrame: target.startFrame,
      endFrame: target.endFrame,
    });
    applyScene(addRigClip(scene, cameraObjectId, clip));
    // 选中它：新建之后要调的就是取景那几个数，不选中的话属性面板还停在上一条片段上。
    set({ selectedClipId: clip.id, selectedPointId: null });
  },

  updateCloseup: (clipId, patch) => {
    const { scene, applyScene } = get();
    applyScene(updateRigClip(scene, clipId, patch));
  },

  setClipAim: (clipId, aimObjectId) => {
    const { scene, applyScene } = get();
    if (aimObjectId !== null && !scene.objects.some((object) => object.id === aimObjectId)) return;
    const next = setPathAim(scene, clipId, aimObjectId);
    if (next === scene) return;
    applyScene(next);
  },

  bakeCloseup: (clipId) => {
    const { scene, applyScene } = get();
    const next = rigClipToPath(scene, clipId);
    if (next === scene) return;
    applyScene(next);
  },
}));

/**
 * 监看该看哪台机位。跟随时按镜头轨取；空隙或没切片时退回手动选的那台。
 * 参数写成结构类型，测试可以直接喂 `getState()`，组件用 `usePrevizStore(monitorCameraId)`。
 */
export function monitorCameraId(state: {
  scene: PrevizScene;
  timelineFrame: number;
  activeCameraId: string | null;
  monitorFollowsProgram: boolean;
}): string | null {
  if (!state.monitorFollowsProgram) return state.activeCameraId;
  return liveCameraAt(state.scene, state.timelineFrame) ?? state.activeCameraId;
}
