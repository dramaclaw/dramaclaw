// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { PREVIZ_MOTION_LIMITS } from '../domain/limits';
import { importedIdOf, type PrevizMotionLoadError, type PrevizMotionStatus } from '../domain/motionLibrary';
import type { PrevizImportedMotion, PrevizMotionFormat, PrevizSkeletonKind } from '../domain/scene';
import { detectSkeleton } from '../domain/skeletonMaps';
import type { PrevizGltf } from './characterRig';
import { looksLooped, retargetClip } from './retarget';
import type { ThreeModule } from './sceneGraph';

/**
 * 动作文件的解析器。由渲染器从动态 import 的 GLTFLoader / BVHLoader 包出来传进来：
 * 本文件静态 import 任何一个 loader 都会把它从预演台 chunk 里拽出去。
 */
export interface PrevizMotionParsers {
  /** GLB 与 glTF（JSON 文本）都走这里——GLTFLoader 按文件头自己分辨。 */
  parseGltf: (data: ArrayBuffer) => Promise<PrevizGltf>;
  parseBvh: (text: string) => { skeleton: THREE.Skeleton; clip: THREE.AnimationClip };
}

export interface PrevizParsedMotionFile {
  /** 源骨架根。重定向会改写它的姿势，所以 `prepareMotion` 每次都先克隆。 */
  root: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

export type PrevizMotionResult<T> = ({ ok: true } & T) | { ok: false; error: PrevizMotionLoadError };

export interface PrevizPreparedMotion {
  clip: THREE.AnimationClip;
  skeleton: PrevizSkeletonKind;
  /** 导入确认框「循环」开关的默认值。 */
  loop: boolean;
}

/** 扩展名 → 格式；不认识的给 null，由导入流程报 `bad_extension`。 */
export function motionFormatOf(fileName: string): PrevizMotionFormat | null {
  const extension = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase();
  return extension === 'glb' || extension === 'gltf' || extension === 'bvh' ? extension : null;
}

/**
 * 把文件内容解析成「源骨架 + clip 列表」。导入确认前读本地文件、打开编辑器后按 URL 拉取，
 * 走的都是这一步，报错因此共用一张表。
 */
export async function parseMotionData(
  three: ThreeModule,
  parsers: PrevizMotionParsers,
  format: PrevizMotionFormat,
  data: ArrayBuffer,
): Promise<PrevizMotionResult<{ file: PrevizParsedMotionFile }>> {
  let file: PrevizParsedMotionFile;
  try {
    if (format === 'bvh') {
      const { skeleton, clip } = parsers.parseBvh(new TextDecoder().decode(new Uint8Array(data)));
      // BVHLoader 只给骨骼，不给容器；套一层 Group，和 glTF 的 scene 一样从根往下找骨骼名。
      const root = new three.Group();
      root.add(skeleton.bones[0]!);
      file = { root, clips: [clip] };
    } else {
      const gltf = await parsers.parseGltf(data);
      file = { root: gltf.scene, clips: gltf.animations };
    }
  } catch (error) {
    console.warn('[previz] failed to parse a motion file', error);
    return { ok: false, error: { code: 'parse_failed' } };
  }
  if (file.clips.length === 0) return { ok: false, error: { code: 'no_animation' } };
  return { ok: true, file };
}

/**
 * 识别骨架并把第 `clipIndex` 条 clip 重定向到人物骨架上。
 *
 * 源与目标都先克隆：源会被逐帧采样改写，同一个文件里的下一条 clip 还要从静止姿势开始；
 * 目标是 `CharacterRigFactory` 共享的源模型，所有人物都从它克隆，一点都不能碰。
 */
export function prepareMotion(
  three: ThreeModule,
  clone: (object: THREE.Object3D) => THREE.Object3D,
  file: PrevizParsedMotionFile,
  clipIndex: number,
  actor: THREE.Object3D,
): PrevizMotionResult<{ motion: PrevizPreparedMotion }> {
  const clip = file.clips[clipIndex];
  if (!clip) return { ok: false, error: { code: 'no_animation' } };
  if (!(clip.duration > 0)) return { ok: false, error: { code: 'zero_duration' } };

  const boneNames: string[] = [];
  file.root.traverse((node) => {
    if (node.name) boneNames.push(node.name);
  });
  const detected = detectSkeleton(boneNames);
  if (!detected.ok) return { ok: false, error: { code: 'unsupported_skeleton', missing: detected.missing } };

  try {
    const retargeted = retargetClip(three, {
      source: clone(file.root),
      clip,
      map: detected.map,
      target: clone(actor),
    });
    return { ok: true, motion: { clip: retargeted, skeleton: detected.kind, loop: looksLooped(retargeted) } };
  } catch (error) {
    // 核心骨骼都在但层级畸形（比如脚挂在头下面）时，重定向里会取到 undefined。
    console.warn('[previz] failed to retarget a motion', error);
    return { ok: false, error: { code: 'parse_failed' } };
  }
}

/** 导入确认框要的那份清单：文件里每条能用的动画。 */
export interface PrevizInspectedClip {
  clipIndex: number;
  /** 默认名：clip 自己的名字，没有就取文件名。 */
  name: string;
  /** 截到上限之后的时长。 */
  durationSec: number;
  /** 原片超过 `PREVIZ_MOTION_LIMITS.durationSec`、被截断了，确认框要提示一句。 */
  truncated: boolean;
  loop: boolean;
  clip: THREE.AnimationClip;
}

export type PrevizMotionInspection = PrevizMotionResult<{
  format: PrevizMotionFormat;
  skeleton: PrevizSkeletonKind;
  clips: PrevizInspectedClip[];
}>;

export interface PrevizMotionInspectDeps {
  three: ThreeModule;
  clone: (object: THREE.Object3D) => THREE.Object3D;
  parsers: PrevizMotionParsers;
  loadActorSource: () => Promise<PrevizGltf>;
}

/**
 * 导入流程的本地试跑：扩展名、大小、解析、识别、重定向全在上传**之前**做完，任何一步不过
 * 都不发起上传。GLB 里有几条动画就试几条，能用的都列出来；一条都不能用时报第一条的原因
 * （同一个文件里各条共用骨架，原因多半是同一个）。
 */
export async function inspectMotionFile(
  deps: PrevizMotionInspectDeps,
  file: Pick<File, 'name' | 'size' | 'arrayBuffer'>,
): Promise<PrevizMotionInspection> {
  const format = motionFormatOf(file.name);
  if (!format) return { ok: false, error: { code: 'bad_extension' } };
  if (file.size > PREVIZ_MOTION_LIMITS.fileBytes) return { ok: false, error: { code: 'too_large' } };

  let data: ArrayBuffer;
  try {
    // 本地文件读不出来（比如移动硬盘中途拔掉）没有专门的错误码；本质也是「这份数据没法用」，
    // 并入 parse_failed，不额外加一种用户分不清跟 parse_failed 有什么区别的状态。
    data = await file.arrayBuffer();
  } catch {
    return { ok: false, error: { code: 'parse_failed' } };
  }
  const parsed = await parseMotionData(deps.three, deps.parsers, format, data);
  if (!parsed.ok) return parsed;
  let actor: PrevizGltf;
  try {
    actor = await deps.loadActorSource();
  } catch {
    return { ok: false, error: { code: 'fetch_failed' } };
  }

  const fallbackName = file.name.replace(/\.[^.]+$/, '');
  const clips: PrevizInspectedClip[] = [];
  let skeleton: PrevizSkeletonKind | null = null;
  let firstError: PrevizMotionLoadError | null = null;
  for (let clipIndex = 0; clipIndex < parsed.file.clips.length; clipIndex += 1) {
    const source = parsed.file.clips[clipIndex]!;
    const result = prepareMotion(deps.three, deps.clone, parsed.file, clipIndex, actor.scene);
    if (!result.ok) {
      firstError ??= result.error;
      continue;
    }
    skeleton = result.motion.skeleton;
    clips.push({
      clipIndex,
      name: source.name || fallbackName,
      durationSec: result.motion.clip.duration,
      truncated: source.duration > PREVIZ_MOTION_LIMITS.durationSec,
      loop: result.motion.loop,
      clip: result.motion.clip,
    });
  }
  if (!skeleton) return { ok: false, error: firstError ?? { code: 'no_animation' } };
  return { ok: true, format, skeleton, clips };
}

export interface PrevizMotionClipsDeps {
  three: ThreeModule;
  clone: (object: THREE.Object3D) => THREE.Object3D;
  parsers: PrevizMotionParsers;
  fetchFile: (url: string) => Promise<ArrayBuffer>;
  /** `CharacterRigFactory.loadActorSource`：重定向的目标骨架，与建人物共用一份下载。 */
  loadActorSource: () => Promise<PrevizGltf>;
  /**
   * 任一条导入动作的状态变了（开始加载、就绪、失败、被移除）。带的是全量状态表，
   * 渲染器拿去让 rig 失效重摆、写进 store。
   */
  onChange: (statuses: Readonly<Record<string, PrevizMotionStatus>>) => void;
}

interface Entry {
  motion: PrevizImportedMotion;
  status: PrevizMotionStatus;
  clip: THREE.AnimationClip | null;
}

/**
 * 场景里导入动作的 clip 缓存：按 URL 拉文件、解析、重定向，排队逐条做。
 *
 * 排队而不是并发：重定向在主线程上跑，一条 10 秒动作十余毫秒，三十条一起上会把入场那一下
 * 卡成一整秒不响应；逐条做，每条之间让出一次事件循环。
 */
export class PrevizMotionClips {
  private readonly entries = new Map<string, Entry>();
  /**
   * 按 URL 缓存解析结果：同一个 GLB 里勾了几条动画就写成几条 motion、共用一个 URL，
   * 50 MB 的文件不该下几遍。这一 URL 上没有还在排队的 motion 时就扔掉，不常驻内存。
   */
  private readonly files = new Map<string, Promise<PrevizMotionResult<{ file: PrevizParsedMotionFile }>>>();
  /**
   * 每个 URL 上还有几条 motion 排着队等它（引用计数，`enqueue` 时 +1，`load` 收尾时 -1）。
   * 归零才能扔 `files` 里那条缓存——包括排队中途被删掉、`load` 提前 return 的那条也要算数，
   * 不然一条失败的解析结果会在缓存里躺到 `dispose`，撤销删除后再也不会重新下载。
   */
  private readonly fileRefs = new Map<string, number>();
  /** 导入流程在上传前已经重定向过的 clip，`sync` 碰到这些 id 直接就绪，不再按 URL 拉一遍。 */
  private readonly primed = new Map<string, THREE.AnimationClip>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private waiters: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly deps: PrevizMotionClipsDeps) {}

  /**
   * 导入流程读完文件就调用：把本地已经算好的 clip 交给缓存。确认框里的预览靠它先动起来，
   * 确认后写入场景时 `sync` 直接拿去用；取消或上传失败要 `discardPrimed`，否则一直占着内存。
   */
  prime(importedId: string, clip: THREE.AnimationClip): void {
    this.primed.set(importedId, clip);
  }

  discardPrimed(importedId: string): void {
    this.primed.delete(importedId);
  }

  /** 跟上场景里的 `motions[]`：新增的排队加载，删掉的（或换了文件的）丢弃。 */
  sync(motions: readonly PrevizImportedMotion[]): void {
    if (this.disposed) return;
    const wanted = new Map(motions.map((motion) => [motion.id, motion]));
    let changed = false;
    for (const [id, entry] of this.entries) {
      const next = wanted.get(id);
      // 改名、改循环不用重算：名字不进 clip，循环由求值器按场景里的值处理。
      if (next && next.url === entry.motion.url && next.clipIndex === entry.motion.clipIndex) continue;
      this.entries.delete(id);
      changed = true;
    }
    for (const motion of motions) {
      if (this.entries.has(motion.id)) continue;
      const clip = this.primed.get(motion.id);
      this.primed.delete(motion.id);
      const entry: Entry = clip
        ? { motion, status: { state: 'ready' }, clip }
        : { motion, status: { state: 'loading' }, clip: null };
      this.entries.set(motion.id, entry);
      if (!clip) this.enqueue(entry);
      changed = true;
    }
    if (changed) this.emit();
  }

  /**
   * rig 的解析器：`import:<id>` → 就绪的 clip；加载中、失败、不认识都给 null。
   * 还没进场景的 prime 也认，导入确认框的预览走的就是这条。
   */
  resolve(ref: string): THREE.AnimationClip | null {
    const importedId = importedIdOf(ref);
    if (!importedId) return null;
    return this.entries.get(importedId)?.clip ?? this.primed.get(importedId) ?? null;
  }

  statuses(): Readonly<Record<string, PrevizMotionStatus>> {
    return Object.fromEntries([...this.entries].map(([id, entry]) => [id, entry.status]));
  }

  /** 排队的全部落地（成功失败都算）。等待期间新加的也要等完——录制前不能漏掉刚导入的那条。 */
  whenSettled(): Promise<void> {
    // 销毁之后没有「落地」这回事了：`dispose()` 已经把还没接的 waiters 都叫醒过一次，
    // 但那之后才调用 `whenSettled()` 的人赶不上那一轮。此时在途的下载即使还没决出
    // 胜负也不再重要——不该让调用方陪着一条早已作废的请求，等到它自己的超时才罢休。
    if (this.disposed || this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.files.clear();
    this.fileRefs.clear();
    this.primed.clear();
    // 不叫醒的话，编辑器关掉时正等着录制的那一方永远挂着。
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private enqueue(entry: Entry): void {
    this.pending += 1;
    this.fileRefs.set(entry.motion.url, (this.fileRefs.get(entry.motion.url) ?? 0) + 1);
    this.queue = this.queue
      .then(() => this.load(entry))
      .catch((error: unknown) => console.error('[previz] motion load crashed', error))
      .finally(() => {
        this.pending -= 1;
        if (this.pending > 0) return;
        for (const resolve of this.waiters.splice(0)) resolve();
      });
  }

  private isCurrent(entry: Entry): boolean {
    return !this.disposed && this.entries.get(entry.motion.id) === entry;
  }

  /** 一条 motion 用完了它排队时占的那份引用；归零就把 URL 缓存一起扔掉。 */
  private releaseFile(url: string): void {
    const refs = (this.fileRefs.get(url) ?? 1) - 1;
    if (refs > 0) {
      this.fileRefs.set(url, refs);
      return;
    }
    this.fileRefs.delete(url);
    this.files.delete(url);
  }

  private async load(entry: Entry): Promise<void> {
    const { url } = entry.motion;
    try {
      // 让出一次宏任务：promise 链上的微任务不会让浏览器插进一帧绘制与输入处理。
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // 排队期间被删掉（或换了文件）的，不必再算——但引用计数仍要在 finally 里释放，
      // 否则这条从没跑到底的 motion 会让它的 URL 缓存永远留着。
      if (!this.isCurrent(entry)) return;
      const result = await this.prepare(entry.motion);
      if (!this.isCurrent(entry)) return;
      if (result.ok) {
        entry.clip = result.motion.clip;
        entry.status = { state: 'ready' };
      } else {
        entry.status = { state: 'error', error: result.error };
      }
      this.emit();
    } finally {
      this.releaseFile(url);
    }
  }

  private async prepare(motion: PrevizImportedMotion): Promise<PrevizMotionResult<{ motion: PrevizPreparedMotion }>> {
    let parsing = this.files.get(motion.url);
    if (!parsing) {
      parsing = this.readFile(motion);
      this.files.set(motion.url, parsing);
    }
    const parsed = await parsing;
    if (!parsed.ok) return parsed;
    let actor: PrevizGltf;
    try {
      actor = await this.deps.loadActorSource();
    } catch {
      return { ok: false, error: { code: 'fetch_failed' } };
    }
    return prepareMotion(this.deps.three, this.deps.clone, parsed.file, motion.clipIndex, actor.scene);
  }

  private async readFile(motion: PrevizImportedMotion): Promise<PrevizMotionResult<{ file: PrevizParsedMotionFile }>> {
    let data: ArrayBuffer;
    try {
      data = await this.deps.fetchFile(motion.url);
    } catch (error) {
      console.warn('[previz] failed to fetch a motion file', error);
      return { ok: false, error: { code: 'fetch_failed' } };
    }
    return parseMotionData(this.deps.three, this.deps.parsers, motion.format, data);
  }

  private emit(): void {
    if (this.disposed) return;
    this.deps.onChange(this.statuses());
  }
}
