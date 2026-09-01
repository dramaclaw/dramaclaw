// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';

import { canAddObject } from './domain/limits';
import {
  createPrevizObject,
  withoutUndefined,
  type PrevizObjectOverrides,
  type PrevizObjectPatch,
} from './domain/objects';
import {
  createDefaultScene,
  parseObject,
  type DisplayMode,
  type OutputAspect,
  type PrevizObject,
  type PrevizObjectKind,
  type PrevizScene,
} from './domain/scene';

/** 场景是纯数值 JSON，整份快照很便宜；50 步够覆盖一次连续编辑。 */
export const PREVIZ_HISTORY_LIMIT = 50;

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
  /** 打开编辑器时灌入初始场景，同时清空历史——上一次会话的 undo 不该跨节点串。 */
  loadScene: (scene: PrevizScene) => void;
  /** 场景改动的唯一入口：压历史、清 redo、置脏。 */
  applyScene: (next: PrevizScene) => void;
  undo: () => void;
  redo: () => void;
  markSaved: () => void;
  selectObject: (id: string | null) => void;
  setActiveCamera: (id: string | null) => void;
  /** 建对象并选中它；超出该类型数量上限时返回 null 且不动场景。 */
  addObject: <K extends PrevizObjectKind>(
    kind: K,
    overrides?: PrevizObjectOverrides<K>,
  ) => string | null;
  updateObject: (id: string, patch: PrevizObjectPatch) => void;
  removeObject: (id: string) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setOutputAspect: (aspect: OutputAspect) => void;
}

export const usePrevizStore = create<PrevizStoreState>((set, get) => ({
  scene: createDefaultScene(),
  dirty: false,
  past: [],
  future: [],
  selectedObjectId: null,
  activeCameraId: null,

  loadScene: (scene) =>
    set({
      scene,
      dirty: false,
      past: [],
      future: [],
      selectedObjectId: null,
      activeCameraId: null,
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

  selectObject: (id) => set({ selectedObjectId: id }),

  setActiveCamera: (id) => set({ activeCameraId: id }),

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
    const { scene, applyScene, selectedObjectId, activeCameraId } = get();
    if (!scene.objects.some((object) => object.id === id)) return;

    applyScene({
      ...scene,
      objects: scene.objects.filter((object) => object.id !== id),
      // 轨道跟着走：留下来就是一个悬空引用，P3 的求值器会撞上它。
      timeline: { tracks: scene.timeline.tracks.filter((track) => track.objectId !== id) },
    });
    set({
      selectedObjectId: selectedObjectId === id ? null : selectedObjectId,
      activeCameraId: activeCameraId === id ? null : activeCameraId,
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
}));
