# 预演台镜头轨与音频轨 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给预演台加上镜头轨（按播放头切换监看机位、全局录制按切片出片）与音频轨（本地文件或上游音频节点，播放与录制混音），并把音频节点接进画布白名单。

**Architecture:** 场景数据 `timeline` 从一张对象轨道表扩成三张表（`tracks` / `program` / `audio`），全部纯函数落在 `domain/`；镜头轨用 `liveCameraAt` 这一个查询把「监看跟随」「直播徽章」「全局录制逐帧换机位」串起来，渲染层只认 `setActiveCamera` / `setLiveCamera` / `drawFrame(frame, cameraId)` 三个入口；音频走一个独立的 `engine/audioPlayback.ts`（注入假 `AudioContext` 可测），编辑器按 `timelinePlaying` / 跳转 / 变速驱动它，录制时把输出接到 `MediaStreamAudioDestinationNode` 混进画布流。UI 复用既有的 `ClipBar`（导出后加 `tone` / `label` / `children`），镜头轨与音频轨各是一条固定行。

**Tech Stack:** TypeScript、React 19、zustand 5、three.js 0.185（动态 import）、vitest 4 + jsdom + @testing-library/react、react-i18next、Web Audio API、MediaRecorder。

规格：`docs/superpowers/specs/2026-09-07-previz-program-audio-design.md`。

---

## 约定（每个任务都适用）

- 前端根目录 `/Users/like/code/dramaclaw/frontend`，仓库根目录 `/Users/like/code/dramaclaw`。测试命令一律 `npx vitest run <文件>`；typecheck 是 `cd /Users/like/code/dramaclaw/frontend && npx tsc -p tsconfig.app.json --noEmit`（`tsconfig.json` 是空跑，别用）。没有 eslint。
- 基线里有 6 个与本工作无关的失败测试（`src/__tests__/lib/local-storage-quota.test.ts` ×5、`src/__tests__/lib/queries/ingest.test.tsx` ×1），跑全量时忽略它们。
- 引号风格跟文件走：`domain/`、`engine/`、`capture/`、`store.ts`、`PrevizTimeline*.tsx`、`PrevizClipInspector.tsx` 用单引号；`PrevizEditor.tsx`、`PrevizMonitorFrame.tsx`、`PrevizNode.tsx`、`canvas/` 下的文件、`stores/canvasStore.ts`、`api/ops.ts` 用双引号。新建文件按所在目录的风格。
- 每个新源文件与新测试文件开头两行：
  ```ts
  // SPDX-License-Identifier: Elastic-2.0
  // Copyright (c) 2026 ClaymoreLab
  ```
- 提交必须 `git commit -s`，消息末尾带两行 trailer：
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S
  ```
  工作区里有一批与本计划无关的未提交改动（视口控件重构、`uv.lock` 镜像地址），**只 `git add` 本任务列出的文件**，不要 `git add -A`。
- i18n key 全部在 Task 9 一次加齐；UI 任务的组件测试把 `react-i18next` mock 成 `t: (key) => key`，所以 UI 任务写在 Task 9 之后也不会因缺 key 挂掉。
- 注释写中文，说明「为什么」而不是「是什么」，与既有代码一致。

## 文件结构

| 文件 | 职责 | 动作 |
| --- | --- | --- |
| `src/features/previz/domain/scene.ts` | `PrevizCutClip` / `PrevizAudioClip` 类型、`timeline` 三张表、解析与默认值、`PREVIZ_MIN_CLIP_FRAMES` 迁入 | 修改 |
| `src/features/previz/domain/program.ts` | `liveCameraAt`、`insertCut`、`PREVIZ_MAX_CUTS` | 新建 |
| `src/features/previz/domain/audioTrack.ts` | `insertAudioClip`、帧↔毫秒换算、文件校验、上限常量 | 新建 |
| `src/features/previz/domain/timeline.ts` | `clipById` 三张表、move/trim/split/remove 统一生效、邻居夹取 | 修改 |
| `src/features/previz/domain/closeupClip.ts` | 适配 `clipById` 新返回类型 | 修改 |
| `src/features/previz/store.ts` | `cutToCamera`、`addAudioClip`、`relocateAudioClipToPlayhead`、`monitorFollowsProgram`、`seekSerial`、`monitorCameraId` 选择器 | 修改 |
| `src/features/previz/nodeScene.ts` | `summary.audioClipCount` | 修改 |
| `src/features/previz/engine/audioPlayback.ts` | `createAudioPlayback`、浏览器 `AudioContext` 与解码胶水 | 新建 |
| `src/features/previz/engine/audioProbe.ts` | `<audio>` 探测时长 | 新建 |
| `src/features/previz/engine/cameraModel.ts` | `setFrustumLive` | 修改 |
| `src/features/previz/engine/PrevizRenderer.ts` | `setLiveCamera`、`drawFrame(frame, cameraId)` | 修改 |
| `src/features/previz/capture/recordTimeline.ts` | `pickRecordMimeType(isSupported, withAudio)`、`audioStream` | 修改 |
| `src/features/previz/capture/publishRecording.ts` | `durationMs` 透传 | 修改 |
| `src/stores/canvasStore.ts` | `addDerivedVideoNode` 第五参 `durationMs` | 修改 |
| `src/api/ops.ts` | `uploadFreezoneAudio` | 修改 |
| `src/features/previz/ui/PrevizTimelineTrack.tsx` | 导出 `ClipBar`（加 `tone` / `label` / `children`）、机位轨表头「切到此机位」与「直播」徽章 | 修改 |
| `src/features/previz/ui/PrevizProgramTrack.tsx` | 镜头轨行 | 新建 |
| `src/features/previz/ui/useCutToCamera.ts` | 三个切镜入口共用的 store 调用 + toast | 新建 |
| `src/features/previz/ui/useAudioImport.ts` | 本地文件 / 上游节点 → 占位 → 探测 → 上传 → `addAudioClip` | 新建 |
| `src/features/previz/ui/PrevizAudioTrack.tsx` | 音频轨行、波形、「添加音频」菜单 | 新建 |
| `src/features/previz/ui/PrevizTimeline.tsx` | 挂两条固定行，给机位轨传 `onCut` / `live` | 修改 |
| `src/features/previz/ui/PrevizClipInspector.tsx` | 切片面板、音频面板 | 修改 |
| `src/features/previz/ui/PrevizMonitorFrame.tsx` | 「跟随镜头轨」/「跟随中」 | 修改 |
| `src/features/previz/PrevizEditor.tsx` | 监看跟随 effect、直播 effect、数字键、音频引擎生命周期、录制混音、`upstreamAudio` 透传 | 修改 |
| `src/features/canvas/domain/nodeRegistry.ts` | 音频→预演台白名单 | 修改 |
| `src/features/canvas/nodes/PrevizNode.tsx` | `upstreamAudio` 计算、卡片「已接入音频 N 段」 | 修改 |
| `public/locales/{zh,en}/translation.json` | 新 key | 修改 |

---

### Task 1: 场景数据结构——三张表、解析、默认值、摘要

**Files:**
- Modify: `src/features/previz/domain/scene.ts`
- Modify: `src/features/previz/domain/timeline.ts`（`PREVIZ_MIN_CLIP_FRAMES` 改为再导出；`withTrack` / `upsertClip` / `pinTrack` / `removeTrack` 展开 `...scene.timeline`）
- Modify: `src/features/previz/store.ts:296-310`（`removeObject` 展开 `...scene.timeline`）
- Modify: `src/features/previz/nodeScene.ts:47`
- Modify（类型修复）: `src/__tests__/features/previz/timeline.test.ts:42`、`evaluate.test.ts:129,224`、`closeup-clip.test.ts:43`、`path-preview.test.ts:106`、`store.test.ts:337,354`、`previz-renderer-scene.test.ts:1066`、`node-scene.test.ts:43`
- Test: `src/__tests__/features/previz/scene.test.ts`

- [ ] **Step 1: 写失败的解析测试**

在 `src/__tests__/features/previz/scene.test.ts` 末尾（最外层 `describe` 之外）追加：

```ts
describe("parseScene program and audio tables", () => {
  const camera = { id: "cam-1", kind: "camera", name: "机位 1" };
  const cut = (id: string, startFrame: number, endFrame: number, cameraId = "cam-1") => ({
    id,
    kind: "cut",
    startFrame,
    endFrame,
    cameraId,
  });
  const audio = (id: string, startFrame: number, endFrame: number, extra: object = {}) => ({
    id,
    kind: "audio",
    startFrame,
    endFrame,
    audioUrl: "/static/a.mp3",
    sourceName: "a.mp3",
    durationMs: 4000,
    offsetMs: 0,
    sourceNodeId: null,
    ...extra,
  });

  it("defaults both tables to empty for old scenes", () => {
    const parsed = parseScene({ schemaVersion: 1, objects: [], timeline: { tracks: [] } });
    expect(parsed.timeline.program).toEqual([]);
    expect(parsed.timeline.audio).toEqual([]);
  });

  it("drops cuts whose camera is missing or is not a camera", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [camera, { id: "man", kind: "character", name: "人" }],
      timeline: {
        tracks: [],
        program: [cut("c1", 0, 10), cut("c2", 10, 20, "gone"), cut("c3", 20, 30, "man")],
      },
    });
    expect(parsed.timeline.program.map((entry) => entry.id)).toEqual(["c1"]);
  });

  it("sorts cuts by start and drops the ones overlapping their predecessor", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [camera],
      timeline: {
        tracks: [],
        program: [cut("late", 40, 60), cut("early", 0, 30), cut("overlap", 20, 50)],
      },
    });
    expect(parsed.timeline.program.map((entry) => entry.id)).toEqual(["early", "late"]);
  });

  it("drops cuts with a non-positive span or non-numeric frames", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [camera],
      timeline: {
        tracks: [],
        program: [cut("zero", 10, 10), cut("flip", 20, 5), { ...cut("nan", 0, 5), endFrame: "5" }],
      },
    });
    expect(parsed.timeline.program).toEqual([]);
  });

  it("drops audio clips with an empty url or a non-positive duration", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [],
      timeline: {
        tracks: [],
        audio: [
          audio("ok", 0, 30),
          audio("nourl", 40, 50, { audioUrl: "" }),
          audio("zero", 60, 70, { durationMs: 0 }),
        ],
      },
    });
    expect(parsed.timeline.audio.map((entry) => entry.id)).toEqual(["ok"]);
    expect(parsed.timeline.audio[0]).toEqual({
      id: "ok",
      kind: "audio",
      startFrame: 0,
      endFrame: 30,
      audioUrl: "/static/a.mp3",
      sourceName: "a.mp3",
      durationMs: 4000,
      offsetMs: 0,
      sourceNodeId: null,
    });
  });

  it("repairs a missing offset and a non-string source node id", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [],
      timeline: {
        tracks: [],
        audio: [audio("a", 0, 30, { offsetMs: -5, sourceNodeId: 7, sourceName: undefined })],
      },
    });
    expect(parsed.timeline.audio[0]).toMatchObject({ offsetMs: 0, sourceNodeId: null, sourceName: "" });
  });

  it("sorts audio clips and drops overlaps", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [],
      timeline: { tracks: [], audio: [audio("b", 30, 60), audio("a", 0, 40), audio("c", 60, 90)] },
    });
    expect(parsed.timeline.audio.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("creates the default scene with all three tables", () => {
    expect(createDefaultScene().timeline).toEqual({ tracks: [], program: [], audio: [] });
  });
});
```

`scene.test.ts` 顶部已经 import 了 `parseScene` 与 `createDefaultScene`（用双引号）；若没有 `createDefaultScene`，补进同一条 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/scene.test.ts`
Expected: FAIL，`parsed.timeline.program` 为 `undefined`。

- [ ] **Step 3: 扩类型、默认值与解析**

`src/features/previz/domain/scene.ts`：

(a) 在 `PREVIZ_MIN_DURATION_FRAMES` 常量旁边加：

```ts
/** 片段最短长度（帧）。0 长片段的 `frameToU` 无解，时间轴上也点不中。 */
export const PREVIZ_MIN_CLIP_FRAMES = 1;
```

(b) 在 `PrevizRigClip` 接口之后、`export type PrevizClip = …`（约 204 行）之前插入：

```ts
/** 镜头轨的一段：这段帧区间内监看与全局录制看 `cameraId`。 */
export interface PrevizCutClip {
  id: string;
  kind: 'cut';
  /** 含。 */
  startFrame: number;
  /** 不含，与其它片段一致。 */
  endFrame: number;
  cameraId: string;
}

/** 音频轨的一段。`audioUrl` 固化在场景里，上游节点之后删了不影响它。 */
export interface PrevizAudioClip {
  id: string;
  kind: 'audio';
  startFrame: number;
  endFrame: number;
  audioUrl: string;
  /** 文件名或上游节点显示名，轨道与面板上给人看的。 */
  sourceName: string;
  /** 素材总时长。 */
  durationMs: number;
  /** 片段起点对应素材内的偏移。 */
  offsetMs: number;
  /** 来自上游节点时记节点 id，本地上传为 null。 */
  sourceNodeId: string | null;
}
```

把 `PrevizClip` 联合改成五种：

```ts
export type PrevizClip =
  | PrevizPathClip
  | PrevizActionClip
  | PrevizRigClip
  | PrevizCutClip
  | PrevizAudioClip;
```

(c) `PrevizScene.timeline`（约 220-225 行）改为：

```ts
  timeline: {
    /** 对象轨道。 */
    tracks: PrevizTrack[];
    /** 镜头轨：按 startFrame 升序、互不重叠。 */
    program: PrevizCutClip[];
    /** 音频轨：按 startFrame 升序、互不重叠。 */
    audio: PrevizAudioClip[];
  };
```

(d) `PrevizNodeSummary` 加一个字段：

```ts
export interface PrevizNodeSummary {
  objectCount: number;
  durationFrames: number;
  /** 老节点没写过这个字段，读的时候按 0 算。 */
  audioClipCount?: number;
}
```

(e) `createDefaultScene()` 里 `timeline: { tracks: [] }` 改为 `timeline: { tracks: [], program: [], audio: [] }`。

(f) 在 `parseTracks` 之后加三个解析函数与一个去重叠工具：

```ts
/** 起止帧都得是有限数、起点不为负、至少一帧，否则整段不要。 */
function parseClipRange(source: {
  startFrame?: unknown;
  endFrame?: unknown;
}): { startFrame: number; endFrame: number } | null {
  if (typeof source.startFrame !== 'number' || typeof source.endFrame !== 'number') return null;
  if (!Number.isFinite(source.startFrame) || !Number.isFinite(source.endFrame)) return null;
  const startFrame = Math.max(0, Math.round(source.startFrame));
  const endFrame = Math.round(source.endFrame);
  if (endFrame <= startFrame) return null;
  return { startFrame, endFrame };
}

/**
 * 按起点排序并丢掉与前一段重叠的。镜头轨与音频轨的一切操作都建立在「有序、不重叠」
 * 上（邻居夹取按下标找前后段），脏数据在这里不收口，后面每个函数都得自己防。
 */
function withoutOverlaps<T extends { startFrame: number; endFrame: number }>(clips: T[]): T[] {
  const sorted = [...clips].sort((left, right) => left.startFrame - right.startFrame);
  const kept: T[] = [];
  for (const clip of sorted) {
    const last = kept[kept.length - 1];
    if (last && clip.startFrame < last.endFrame) continue;
    kept.push(clip);
  }
  return kept;
}

function parseProgram(raw: unknown, objects: readonly PrevizObject[]): PrevizCutClip[] {
  if (!Array.isArray(raw)) return [];
  const cameraIds = new Set(
    objects.filter((object) => object.kind === 'camera').map((object) => object.id),
  );
  const cuts: PrevizCutClip[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const source = entry as Partial<PrevizCutClip>;
    if (typeof source.id !== 'string' || typeof source.cameraId !== 'string') continue;
    // 指向已删对象或非机位对象的切片直接丢：监看切过去只会是一片黑。
    if (!cameraIds.has(source.cameraId)) continue;
    const range = parseClipRange(source);
    if (!range) continue;
    cuts.push({ id: source.id, kind: 'cut', ...range, cameraId: source.cameraId });
  }
  return withoutOverlaps(cuts);
}

function parseAudio(raw: unknown): PrevizAudioClip[] {
  if (!Array.isArray(raw)) return [];
  const clips: PrevizAudioClip[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const source = entry as Partial<PrevizAudioClip>;
    if (typeof source.id !== 'string') continue;
    if (typeof source.audioUrl !== 'string' || source.audioUrl === '') continue;
    if (typeof source.durationMs !== 'number' || !(source.durationMs > 0)) continue;
    const range = parseClipRange(source);
    if (!range) continue;
    clips.push({
      id: source.id,
      kind: 'audio',
      ...range,
      audioUrl: source.audioUrl,
      sourceName: typeof source.sourceName === 'string' ? source.sourceName : '',
      durationMs: source.durationMs,
      offsetMs:
        typeof source.offsetMs === 'number' && source.offsetMs >= 0 ? source.offsetMs : 0,
      sourceNodeId: typeof source.sourceNodeId === 'string' ? source.sourceNodeId : null,
    });
  }
  return withoutOverlaps(clips);
}
```

(g) `parseScene` 的返回值末尾改为：

```ts
    objects,
    timeline: {
      tracks: parseTracks(source.timeline?.tracks, objectIds),
      program: parseProgram(source.timeline?.program, objects),
      audio: parseAudio(source.timeline?.audio),
    },
  };
```

- [ ] **Step 4: 让其它写 `timeline` 字面量的地方保住另外两张表**

`src/features/previz/domain/timeline.ts`：

- import 里从 `'./scene'` 多拿 `PREVIZ_MIN_CLIP_FRAMES`，并把原来的 `export const PREVIZ_MIN_CLIP_FRAMES = 1;`（含上一行注释）换成：

```ts
export { PREVIZ_MIN_CLIP_FRAMES };
```

- `withTrack`：

```ts
function withTrack(scene: PrevizScene, trackId: string, next: PrevizTrack): PrevizScene {
  return {
    ...scene,
    timeline: {
      ...scene.timeline,
      tracks: scene.timeline.tracks.map((track) => (track.id === trackId ? next : track)),
    },
  };
}
```

- `upsertClip` 里没有轨道时的分支：

```ts
    return {
      ...scene,
      timeline: {
        ...scene.timeline,
        tracks: [...scene.timeline.tracks, { id: uuidv4(), objectId, clips: [clip] }],
      },
    };
```

- `pinTrack`：

```ts
  return {
    ...scene,
    timeline: {
      ...scene.timeline,
      tracks: [target, ...scene.timeline.tracks.filter((track) => track.id !== target.id)],
    },
  };
```

- `removeTrack`：

```ts
export function removeTrack(scene: PrevizScene, objectId: string): PrevizScene {
  return {
    ...scene,
    timeline: {
      ...scene.timeline,
      tracks: scene.timeline.tracks.filter((track) => track.objectId !== objectId),
    },
  };
}
```

`src/features/previz/store.ts` 的 `removeObject`：

```ts
      timeline: {
        ...scene.timeline,
        // 轨道跟着走：留下来就是一个悬空引用，P3 的求值器会撞上它。
        tracks: scene.timeline.tracks.filter((track) => track.objectId !== id),
      },
```

`src/features/previz/nodeScene.ts` 第 47 行：

```ts
      summary: {
        objectCount: scene.objects.length,
        durationFrames: scene.settings.durationFrames,
        audioClipCount: scene.timeline.audio.length,
      },
```

- [ ] **Step 5: 修测试夹具的类型**

以下测试用 `PrevizScene` 类型写了 `timeline: { tracks: … }` 字面量，缺另外两张表会过不了 typecheck。逐处改：

- `src/__tests__/features/previz/timeline.test.ts:42`：`return { ...createDefaultScene(), timeline: { tracks } };` → `return { ...createDefaultScene(), timeline: { ...createDefaultScene().timeline, tracks } };`
- `src/__tests__/features/previz/evaluate.test.ts:129`：`timeline: { tracks: [{ id: 'rt', objectId: camera.id, clips: [clip] }] },` → `timeline: { ...createDefaultScene().timeline, tracks: [{ id: 'rt', objectId: camera.id, clips: [clip] }] },`
- `src/__tests__/features/previz/evaluate.test.ts:224`：同样在 `tracks:` 前加 `...createDefaultScene().timeline,`
- `src/__tests__/features/previz/closeup-clip.test.ts:43`：同上
- `src/__tests__/features/previz/path-preview.test.ts:106`：同上
- `src/__tests__/features/previz/store.test.ts:337`：`timeline: { tracks: [{ id: "t1", objectId: id, clips: [] }] },` → `timeline: { ...usePrevizStore.getState().scene.timeline, tracks: [{ id: "t1", objectId: id, clips: [] }] },`
- `src/__tests__/features/previz/store.test.ts:354`：`timeline: {` 下一行插入 `...usePrevizStore.getState().scene.timeline,`
- `src/__tests__/features/previz/previz-renderer-scene.test.ts:1066`：`timeline: {` 下一行插入 `...scene.timeline,`（该函数上面已有 `const scene = createDefaultScene()`）
- `src/__tests__/features/previz/node-scene.test.ts:43`：`summary: { objectCount: 1, durationFrames: 240 }` → `summary: { objectCount: 1, durationFrames: 240, audioClipCount: 0 }`

`evaluate.test.ts` / `closeup-clip.test.ts` / `path-preview.test.ts` 若尚未 import `createDefaultScene`，从 `@/features/previz/domain/scene` 补上。

- [ ] **Step 6: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz && npx tsc -p tsconfig.app.json --noEmit`
Expected: 全部 PASS；tsc 无输出，退出码 0。

- [ ] **Step 7: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/features/previz/domain/scene.ts frontend/src/features/previz/domain/timeline.ts frontend/src/features/previz/store.ts frontend/src/features/previz/nodeScene.ts frontend/src/__tests__/features/previz/scene.test.ts frontend/src/__tests__/features/previz/timeline.test.ts frontend/src/__tests__/features/previz/evaluate.test.ts frontend/src/__tests__/features/previz/closeup-clip.test.ts frontend/src/__tests__/features/previz/path-preview.test.ts frontend/src/__tests__/features/previz/store.test.ts frontend/src/__tests__/features/previz/previz-renderer-scene.test.ts frontend/src/__tests__/features/previz/node-scene.test.ts && git commit -s -m "feat(previz): add program and audio tables to the scene timeline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

注意：`store.ts` 此时还带着工作区里视口重构的未提交改动。只提交本任务改的那几行——用 `git add -p frontend/src/features/previz/store.ts` 只选 `removeObject` 的那一块；其它文件同理若有无关改动也用 `-p`。

---

### Task 2: `domain/program.ts`——`liveCameraAt` 与 `insertCut`

**Files:**
- Create: `src/features/previz/domain/program.ts`
- Test: `src/__tests__/features/previz/program.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { insertCut, liveCameraAt, PREVIZ_MAX_CUTS } from '@/features/previz/domain/program';
import { createPrevizObject } from '@/features/previz/domain/objects';
import {
  createDefaultScene,
  type PrevizCutClip,
  type PrevizScene,
} from '@/features/previz/domain/scene';

function cut(id: string, startFrame: number, endFrame: number, cameraId: string): PrevizCutClip {
  return { id, kind: 'cut', startFrame, endFrame, cameraId };
}

/** 两台机位 + 一个人物，时间轴 120 帧。 */
function seed(program: PrevizCutClip[] = []): { scene: PrevizScene; camA: string; camB: string } {
  const base = createDefaultScene();
  const camA = createPrevizObject('camera', base.objects);
  const camB = createPrevizObject('camera', [camA]);
  const man = createPrevizObject('character', [camA, camB]);
  const scene: PrevizScene = {
    ...base,
    objects: [camA, camB, man],
    timeline: { ...base.timeline, program },
  };
  return { scene, camA: camA.id, camB: camB.id };
}

describe('liveCameraAt', () => {
  it('returns the camera whose cut covers the frame, start inclusive and end exclusive', () => {
    const { scene, camA, camB } = seed([cut('c1', 0, 30, 'x'), cut('c2', 30, 60, 'y')]);
    const program = [cut('c1', 0, 30, camA), cut('c2', 30, 60, camB)];
    const staged = { ...scene, timeline: { ...scene.timeline, program } };
    expect(liveCameraAt(staged, 0)).toBe(camA);
    expect(liveCameraAt(staged, 29)).toBe(camA);
    expect(liveCameraAt(staged, 30)).toBe(camB);
    expect(liveCameraAt(staged, 60)).toBeNull();
  });

  it('returns null in a gap and on an empty program', () => {
    const { scene, camA } = seed();
    expect(liveCameraAt(scene, 10)).toBeNull();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 20, 30, camA)] } };
    expect(liveCameraAt(staged, 10)).toBeNull();
  });
});

describe('insertCut', () => {
  it('case 3: fills the gap from the playhead to the end of the timeline', () => {
    const { scene, camA } = seed();
    const result = insertCut(scene, 10, camA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.timeline.program).toMatchObject([
      { kind: 'cut', startFrame: 10, endFrame: 120, cameraId: camA },
    ]);
  });

  it('case 3: stops at the next cut when inserting into a gap', () => {
    const { scene, camA, camB } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 50, 80, camB)] } };
    const result = insertCut(staged, 10, camA);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.program.map((c) => [c.startFrame, c.endFrame, c.cameraId])).toEqual([
      [10, 50, camA],
      [50, 80, camB],
    ]);
  });

  it('case 2: splits the cut under the playhead and hands the tail to the new camera', () => {
    const { scene, camA, camB } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 0, 60, camA)] } };
    const result = insertCut(staged, 20, camB);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.program.map((c) => [c.startFrame, c.endFrame, c.cameraId])).toEqual([
      [0, 20, camA],
      [20, 60, camB],
    ]);
    expect(result.scene.timeline.program[0]?.id).toBe('c1');
  });

  it('case 1: retargets the cut whose start is exactly at the playhead', () => {
    const { scene, camA, camB } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 20, 60, camA)] } };
    const result = insertCut(staged, 20, camB);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.program).toEqual([cut('c1', 20, 60, camB)]);
  });

  it('case 0: rejects when the covering cut already uses that camera', () => {
    const { scene, camA } = seed();
    const staged = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 0, 60, camA)] } };
    expect(insertCut(staged, 30, camA)).toEqual({ ok: false, reason: 'same-camera' });
    expect(insertCut(staged, 0, camA)).toEqual({ ok: false, reason: 'same-camera' });
  });

  it('case 4: rejects at the very end of the timeline', () => {
    const { scene, camA } = seed();
    expect(insertCut(scene, 120, camA)).toEqual({ ok: false, reason: 'no-room' });
    const packed = { ...scene, timeline: { ...scene.timeline, program: [cut('c1', 100, 120, camA)] } };
    // 播放头压在最后一段的末尾之后：空隙是 0 帧。
    expect(insertCut(packed, 120, camA)).toEqual({ ok: false, reason: 'no-room' });
  });

  it('case 5: rejects once the program holds PREVIZ_MAX_CUTS cuts', () => {
    const { scene, camA, camB } = seed();
    const program = Array.from({ length: PREVIZ_MAX_CUTS }, (_, index) =>
      cut(`c${index}`, index, index + 1, index % 2 ? camA : camB),
    );
    const staged = { ...scene, timeline: { ...scene.timeline, program } };
    expect(insertCut(staged, PREVIZ_MAX_CUTS + 5, camA)).toEqual({ ok: false, reason: 'limit' });
  });

  it('rejects an id that is not a camera', () => {
    const { scene } = seed();
    const man = scene.objects.find((object) => object.kind === 'character')!;
    expect(insertCut(scene, 0, man.id)).toEqual({ ok: false, reason: 'no-camera' });
    expect(insertCut(scene, 0, 'nope')).toEqual({ ok: false, reason: 'no-camera' });
  });

  it('never mutates the input scene', () => {
    const { scene, camA } = seed();
    const before = JSON.stringify(scene);
    insertCut(scene, 10, camA);
    expect(JSON.stringify(scene)).toBe(before);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/program.test.ts`
Expected: FAIL，找不到模块 `@/features/previz/domain/program`。

- [ ] **Step 3: 实现**

`src/features/previz/domain/program.ts`：

```ts
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

import { PREVIZ_MIN_CLIP_FRAMES, type PrevizCutClip, type PrevizScene } from './scene';

/**
 * 镜头轨：一串按起点排好、互不重叠的切片，每段说「这几帧监看谁」。
 * 全是纯函数——store 的 undo 存的是整份场景快照，就地改会把历史一起改掉。
 */

/** 切片上限。60 段对应 360 帧时长下平均 6 帧一切，比任何正常剪辑都密了。 */
export const PREVIZ_MAX_CUTS = 60;

/** 覆盖这一帧的切片机位；null 是导演视角。起点含、终点不含，与其它片段一致。 */
export function liveCameraAt(scene: PrevizScene, frame: number): string | null {
  const cut = scene.timeline.program.find(
    (entry) => entry.startFrame <= frame && frame < entry.endFrame,
  );
  return cut?.cameraId ?? null;
}

export type CutRejection = 'same-camera' | 'no-room' | 'limit' | 'no-camera';

export type InsertCutResult =
  | { ok: true; scene: PrevizScene }
  | { ok: false; reason: CutRejection };

function withProgram(scene: PrevizScene, program: PrevizCutClip[]): PrevizScene {
  return { ...scene, timeline: { ...scene.timeline, program } };
}

/**
 * 在 `frame` 处切到 `cameraId`。五种情形见设计文档「切镜操作」：
 * 0 同机位不动；1 起点恰在播放头只换机位；2 播放头在段内则截断并新建后半段；
 * 3 空隙里新建到下一段或时间轴末尾；4 末尾没空间；5 达上限。
 * 拒绝时不返回场景：调用方拿到场景就会 applyScene，等于往 undo 栈塞一步空操作。
 */
export function insertCut(scene: PrevizScene, frame: number, cameraId: string): InsertCutResult {
  const camera = scene.objects.find((object) => object.id === cameraId);
  if (camera?.kind !== 'camera') return { ok: false, reason: 'no-camera' };

  const at = Math.max(0, Math.round(frame));
  const program = scene.timeline.program;
  const index = program.findIndex((cut) => cut.startFrame <= at && at < cut.endFrame);
  const current = index >= 0 ? program[index] : undefined;

  if (current) {
    if (current.cameraId === cameraId) return { ok: false, reason: 'same-camera' };
    if (current.startFrame === at) {
      return {
        ok: true,
        scene: withProgram(
          scene,
          program.map((cut) => (cut.id === current.id ? { ...cut, cameraId } : cut)),
        ),
      };
    }
    if (program.length >= PREVIZ_MAX_CUTS) return { ok: false, reason: 'limit' };
    // at 严格落在 (startFrame, endFrame) 内，两半都至少一帧。
    const head: PrevizCutClip = { ...current, endFrame: at };
    const tail: PrevizCutClip = {
      id: uuidv4(),
      kind: 'cut',
      startFrame: at,
      endFrame: current.endFrame,
      cameraId,
    };
    return {
      ok: true,
      scene: withProgram(scene, [
        ...program.slice(0, index),
        head,
        tail,
        ...program.slice(index + 1),
      ]),
    };
  }

  // 空隙：表是有序的，第一段起点在播放头之后的就是下一段。
  const nextIndex = program.findIndex((cut) => cut.startFrame > at);
  const end = nextIndex >= 0 ? program[nextIndex]!.startFrame : scene.settings.durationFrames;
  if (end - at < PREVIZ_MIN_CLIP_FRAMES) return { ok: false, reason: 'no-room' };
  if (program.length >= PREVIZ_MAX_CUTS) return { ok: false, reason: 'limit' };

  const cut: PrevizCutClip = { id: uuidv4(), kind: 'cut', startFrame: at, endFrame: end, cameraId };
  const next =
    nextIndex >= 0
      ? [...program.slice(0, nextIndex), cut, ...program.slice(nextIndex)]
      : [...program, cut];
  return { ok: true, scene: withProgram(scene, next) };
}
```

- [ ] **Step 4: 跑测试**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/program.test.ts`
Expected: PASS（10 个）。

- [ ] **Step 5: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/features/previz/domain/program.ts frontend/src/__tests__/features/previz/program.test.ts && git commit -s -m "feat(previz): resolve the live camera and insert cuts on the program track

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---

### Task 3: `domain/audioTrack.ts`——`insertAudioClip`、换算与文件校验

**Files:**
- Create: `src/features/previz/domain/audioTrack.ts`
- Test: `src/__tests__/features/previz/audio-track.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  audioFileExtension,
  audioFramesAvailable,
  framesToMs,
  insertAudioClip,
  isAcceptedAudioFile,
  PREVIZ_MAX_AUDIO_BYTES,
  PREVIZ_MAX_AUDIO_CLIPS,
  type PrevizAudioSource,
} from '@/features/previz/domain/audioTrack';
import {
  createDefaultScene,
  type PrevizAudioClip,
  type PrevizScene,
} from '@/features/previz/domain/scene';

function audio(id: string, startFrame: number, endFrame: number): PrevizAudioClip {
  return {
    id,
    kind: 'audio',
    startFrame,
    endFrame,
    audioUrl: `/static/${id}.mp3`,
    sourceName: `${id}.mp3`,
    durationMs: 10_000,
    offsetMs: 0,
    sourceNodeId: null,
  };
}

function sceneWith(clips: PrevizAudioClip[]): PrevizScene {
  const base = createDefaultScene();
  return { ...base, timeline: { ...base.timeline, audio: clips } };
}

const source: PrevizAudioSource = {
  audioUrl: '/static/new.mp3',
  sourceName: 'new.mp3',
  durationMs: 2000,
  sourceNodeId: null,
};

describe('conversions', () => {
  it('turns the remaining material into whole frames, rounding down', () => {
    expect(audioFramesAvailable(2000, 0, 30)).toBe(60);
    expect(audioFramesAvailable(2000, 500, 30)).toBe(45);
    expect(audioFramesAvailable(1050, 0, 30)).toBe(31);
    expect(audioFramesAvailable(500, 800, 30)).toBe(0);
  });

  it('turns frames into milliseconds without rounding', () => {
    expect(framesToMs(30, 30)).toBe(1000);
    expect(framesToMs(1, 30)).toBeCloseTo(33.333, 3);
  });
});

describe('insertAudioClip', () => {
  it('starts at the playhead and lasts as long as the material when the gap is wider', () => {
    const result = insertAudioClip(createDefaultScene(), 10, source);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.audio).toMatchObject([
      {
        kind: 'audio',
        startFrame: 10,
        endFrame: 70,
        audioUrl: '/static/new.mp3',
        sourceName: 'new.mp3',
        durationMs: 2000,
        offsetMs: 0,
        sourceNodeId: null,
      },
    ]);
    expect(result.clipId).toBe(result.scene.timeline.audio[0]?.id);
  });

  it('is cut short by the next audio clip', () => {
    const result = insertAudioClip(sceneWith([audio('b', 40, 80)]), 10, source);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.audio.map((c) => [c.id === 'b' ? 'b' : 'new', c.startFrame, c.endFrame])).toEqual([
      ['new', 10, 40],
      ['b', 40, 80],
    ]);
  });

  it('is cut short by the end of the timeline', () => {
    const result = insertAudioClip(createDefaultScene(), 100, source);
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.audio[0]).toMatchObject({ startFrame: 100, endFrame: 120 });
  });

  it('refuses when the playhead sits inside an existing clip', () => {
    expect(insertAudioClip(sceneWith([audio('a', 0, 30)]), 15, source)).toEqual({
      ok: false,
      reason: 'no-room',
    });
    expect(insertAudioClip(sceneWith([audio('a', 0, 30)]), 0, source)).toEqual({
      ok: false,
      reason: 'no-room',
    });
  });

  it('refuses when the gap is under one frame', () => {
    expect(insertAudioClip(createDefaultScene(), 120, source)).toEqual({
      ok: false,
      reason: 'no-room',
    });
  });

  it('allows the playhead right at the end of a clip', () => {
    const result = insertAudioClip(sceneWith([audio('a', 0, 30)]), 30, source);
    expect(result.ok).toBe(true);
  });

  it('refuses at the clip limit', () => {
    const clips = Array.from({ length: PREVIZ_MAX_AUDIO_CLIPS }, (_, index) =>
      audio(`a${index}`, index, index + 1),
    );
    expect(insertAudioClip(sceneWith(clips), 100, source)).toEqual({ ok: false, reason: 'limit' });
  });

  it('records the upstream node id when given', () => {
    const result = insertAudioClip(createDefaultScene(), 0, { ...source, sourceNodeId: 'audio-9' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.scene.timeline.audio[0]?.sourceNodeId).toBe('audio-9');
  });
});

describe('file validation', () => {
  it('reads the extension case-insensitively', () => {
    expect(audioFileExtension('Take 1.MP3')).toBe('mp3');
    expect(audioFileExtension('noext')).toBe('');
  });

  it('accepts mp3 / wav / m4a / ogg under the size limit', () => {
    expect(isAcceptedAudioFile('a.mp3', 1024)).toBe('ok');
    expect(isAcceptedAudioFile('a.wav', 1024)).toBe('ok');
    expect(isAcceptedAudioFile('a.m4a', 1024)).toBe('ok');
    expect(isAcceptedAudioFile('a.ogg', 1024)).toBe('ok');
    expect(isAcceptedAudioFile('a.flac', 1024)).toBe('extension');
    expect(isAcceptedAudioFile('a.mp3', PREVIZ_MAX_AUDIO_BYTES + 1)).toBe('size');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/audio-track.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现**

`src/features/previz/domain/audioTrack.ts`：

```ts
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

import { PREVIZ_MIN_CLIP_FRAMES, type PrevizAudioClip, type PrevizScene } from './scene';

/** 音频片段上限。一条轨道 20 段已经是配音级别的密度，再多就该去剪辑软件里做。 */
export const PREVIZ_MAX_AUDIO_CLIPS = 20;
/** 单个音频文件上限：20 MB，约一小时的 48 kbps 或十分钟的 wav。 */
export const PREVIZ_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** 浏览器 `decodeAudioData` 在三大内核上都稳的四种容器。 */
export const PREVIZ_AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'ogg'] as const;

/** 建片段需要的素材信息。`durationMs` 由调用方探测好再传进来，域层不碰 DOM。 */
export interface PrevizAudioSource {
  audioUrl: string;
  sourceName: string;
  durationMs: number;
  sourceNodeId: string | null;
}

/** 素材从 `offsetMs` 起还剩多少整帧。向下取整：多出的半帧没有声音可放。 */
export function audioFramesAvailable(durationMs: number, offsetMs: number, fps: number): number {
  return Math.max(0, Math.floor(((durationMs - offsetMs) * fps) / 1000));
}

export function framesToMs(frames: number, fps: number): number {
  return (frames * 1000) / fps;
}

export type AudioInsertRejection = 'no-room' | 'limit';

export type InsertAudioClipResult =
  | { ok: true; scene: PrevizScene; clipId: string }
  | { ok: false; reason: AudioInsertRejection };

/**
 * 在播放头处放一段音频：起点 = 播放头，长度 = min(素材帧数, 到下一段或时间轴末尾的空隙)。
 * 播放头压在既有片段里、空隙不足一帧、或已到上限时不建——同 `insertCut`，拒绝时不给场景。
 */
export function insertAudioClip(
  scene: PrevizScene,
  frame: number,
  source: PrevizAudioSource,
): InsertAudioClipResult {
  const audio = scene.timeline.audio;
  if (audio.length >= PREVIZ_MAX_AUDIO_CLIPS) return { ok: false, reason: 'limit' };

  const at = Math.max(0, Math.round(frame));
  if (audio.some((clip) => clip.startFrame <= at && at < clip.endFrame)) {
    return { ok: false, reason: 'no-room' };
  }
  const nextIndex = audio.findIndex((clip) => clip.startFrame > at);
  const gapEnd = nextIndex >= 0 ? audio[nextIndex]!.startFrame : scene.settings.durationFrames;
  const length = Math.min(
    gapEnd - at,
    audioFramesAvailable(source.durationMs, 0, scene.settings.fps),
  );
  if (length < PREVIZ_MIN_CLIP_FRAMES) return { ok: false, reason: 'no-room' };

  const clip: PrevizAudioClip = {
    id: uuidv4(),
    kind: 'audio',
    startFrame: at,
    endFrame: at + length,
    audioUrl: source.audioUrl,
    sourceName: source.sourceName,
    durationMs: source.durationMs,
    offsetMs: 0,
    sourceNodeId: source.sourceNodeId,
  };
  const next =
    nextIndex >= 0
      ? [...audio.slice(0, nextIndex), clip, ...audio.slice(nextIndex)]
      : [...audio, clip];
  return { ok: true, scene: { ...scene, timeline: { ...scene.timeline, audio: next } }, clipId: clip.id };
}

/** 小写、不带点的扩展名；没有点就是空串。 */
export function audioFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** 前端能做的两项校验。后端还会再查一次类型，这里只是省一次白传。 */
export function isAcceptedAudioFile(name: string, bytes: number): 'ok' | 'extension' | 'size' {
  const extension = audioFileExtension(name);
  if (!(PREVIZ_AUDIO_EXTENSIONS as readonly string[]).includes(extension)) return 'extension';
  if (bytes > PREVIZ_MAX_AUDIO_BYTES) return 'size';
  return 'ok';
}
```

- [ ] **Step 4: 跑测试**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/audio-track.test.ts`
Expected: PASS（12 个）。

- [ ] **Step 5: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/features/previz/domain/audioTrack.ts frontend/src/__tests__/features/previz/audio-track.test.ts && git commit -s -m "feat(previz): insert audio clips at the playhead

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---
### Task 4: `timeline.ts` 三张表——`clipById`、move/trim/split/remove 统一生效

**Files:**
- Modify: `src/features/previz/domain/timeline.ts`
- Modify: `src/features/previz/domain/closeupClip.ts`（`updateRigClip`、`rigClipToPath` 加 `found.table` 守卫）
- Test: `src/__tests__/features/previz/timeline-tables.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  createDefaultScene,
  type PrevizAudioClip,
  type PrevizCutClip,
  type PrevizScene,
} from '@/features/previz/domain/scene';
import {
  clipById,
  isAudioClip,
  isCutClip,
  moveClip,
  removeClip,
  splitClip,
  trimClip,
} from '@/features/previz/domain/timeline';

function cut(id: string, startFrame: number, endFrame: number): PrevizCutClip {
  return { id, kind: 'cut', startFrame, endFrame, cameraId: 'cam' };
}

function audio(
  id: string,
  startFrame: number,
  endFrame: number,
  extra: Partial<PrevizAudioClip> = {},
): PrevizAudioClip {
  return {
    id,
    kind: 'audio',
    startFrame,
    endFrame,
    audioUrl: '/static/a.mp3',
    sourceName: 'a.mp3',
    durationMs: 4000, // 30 fps 下 120 帧
    offsetMs: 0,
    sourceNodeId: null,
    ...extra,
  };
}

function sceneWith(tables: { program?: PrevizCutClip[]; audio?: PrevizAudioClip[] }): PrevizScene {
  const base = createDefaultScene();
  return {
    ...base,
    timeline: { ...base.timeline, program: tables.program ?? [], audio: tables.audio ?? [] },
  };
}

describe('clipById across tables', () => {
  it('finds cuts and audio clips and reports which table they live in', () => {
    const scene = sceneWith({ program: [cut('c1', 0, 10)], audio: [audio('a1', 0, 10)] });
    expect(clipById(scene, 'c1')).toEqual({ table: 'program', clip: cut('c1', 0, 10) });
    expect(clipById(scene, 'a1')).toEqual({ table: 'audio', clip: audio('a1', 0, 10) });
    expect(clipById(scene, 'nope')).toBeUndefined();
  });

  it('exposes type guards for the two new kinds', () => {
    expect(isCutClip(cut('c', 0, 1))).toBe(true);
    expect(isAudioClip(cut('c', 0, 1))).toBe(false);
    expect(isAudioClip(audio('a', 0, 1))).toBe(true);
  });
});

describe('moveClip on program and audio', () => {
  it('moves a cut and clamps it against its neighbours', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20), cut('b', 30, 50), cut('c', 60, 80)] });
    const left = moveClip(scene, 'b', -100, 120);
    expect(left.timeline.program.map((c) => [c.startFrame, c.endFrame])).toEqual([
      [0, 20],
      [20, 40],
      [60, 80],
    ]);
    const right = moveClip(scene, 'b', 100, 120);
    expect(right.timeline.program[1]).toMatchObject({ startFrame: 40, endFrame: 60 });
  });

  it('clamps the last cut to the timeline end', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20)] });
    expect(moveClip(scene, 'a', 500, 120).timeline.program[0]).toMatchObject({
      startFrame: 100,
      endFrame: 120,
    });
  });

  it('moves an audio clip and keeps its offset', () => {
    const scene = sceneWith({ audio: [audio('a', 10, 40, { offsetMs: 500 })] });
    expect(moveClip(scene, 'a', 5, 120).timeline.audio[0]).toMatchObject({
      startFrame: 15,
      endFrame: 45,
      offsetMs: 500,
    });
  });
});

describe('trimClip on program', () => {
  it('trims the start no earlier than the previous cut ends', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20), cut('b', 30, 50)] });
    expect(trimClip(scene, 'b', 'start', 5).timeline.program[1]).toMatchObject({
      startFrame: 20,
      endFrame: 50,
    });
  });

  it('trims the end no later than the next cut starts', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20), cut('b', 30, 50)] });
    expect(trimClip(scene, 'a', 'end', 45).timeline.program[0]).toMatchObject({
      startFrame: 0,
      endFrame: 30,
    });
  });

  it('keeps at least one frame', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20)] });
    expect(trimClip(scene, 'a', 'start', 99).timeline.program[0]).toMatchObject({
      startFrame: 19,
      endFrame: 20,
    });
  });
});

describe('trimClip on audio', () => {
  it('shifts the offset when the start moves right', () => {
    const scene = sceneWith({ audio: [audio('a', 0, 60, { offsetMs: 0 })] });
    expect(trimClip(scene, 'a', 'start', 30).timeline.audio[0]).toMatchObject({
      startFrame: 30,
      endFrame: 60,
      offsetMs: 1000,
    });
  });

  it('cannot pull the start earlier than the material allows', () => {
    // 偏移 1000 ms = 30 帧，最多只能往左拉 30 帧。
    const scene = sceneWith({ audio: [audio('a', 40, 60, { offsetMs: 1000 })] });
    expect(trimClip(scene, 'a', 'start', 0).timeline.audio[0]).toMatchObject({
      startFrame: 10,
      endFrame: 60,
      offsetMs: 0,
    });
  });

  it('caps the end at what is left of the material', () => {
    // 4000 ms − 1000 ms = 3000 ms = 90 帧。
    const scene = sceneWith({ audio: [audio('a', 10, 40, { offsetMs: 1000 })] });
    expect(trimClip(scene, 'a', 'end', 500).timeline.audio[0]).toMatchObject({
      startFrame: 10,
      endFrame: 100,
      offsetMs: 1000,
    });
  });

  it('caps the end at the next audio clip', () => {
    const scene = sceneWith({ audio: [audio('a', 0, 20), audio('b', 30, 50)] });
    expect(trimClip(scene, 'a', 'end', 45).timeline.audio[0]).toMatchObject({ endFrame: 30 });
  });
});

describe('splitClip on program and audio', () => {
  it('splits a cut into two with fresh ids', () => {
    const scene = sceneWith({ program: [cut('a', 0, 20)] });
    const next = splitClip(scene, 'a', 5);
    expect(next.timeline.program.map((c) => [c.startFrame, c.endFrame, c.cameraId])).toEqual([
      [0, 5, 'cam'],
      [5, 20, 'cam'],
    ]);
    expect(next.timeline.program[0]?.id).not.toBe('a');
    expect(next.timeline.program[0]?.id).not.toBe(next.timeline.program[1]?.id);
  });

  it('splits an audio clip and advances the right half offset', () => {
    const scene = sceneWith({ audio: [audio('a', 0, 60, { offsetMs: 500 })] });
    const next = splitClip(scene, 'a', 30);
    expect(next.timeline.audio.map((c) => [c.startFrame, c.endFrame, c.offsetMs])).toEqual([
      [0, 30, 500],
      [30, 60, 1500],
    ]);
  });

  it('ignores a cut outside the clip', () => {
    const scene = sceneWith({ program: [cut('a', 10, 20)] });
    expect(splitClip(scene, 'a', 10)).toBe(scene);
    expect(splitClip(scene, 'a', 20)).toBe(scene);
  });
});

describe('removeClip on program and audio', () => {
  it('removes from whichever table holds the id', () => {
    const scene = sceneWith({ program: [cut('c1', 0, 10)], audio: [audio('a1', 0, 10)] });
    expect(removeClip(scene, 'c1').timeline.program).toEqual([]);
    expect(removeClip(scene, 'c1').timeline.audio).toHaveLength(1);
    expect(removeClip(scene, 'a1').timeline.audio).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/features/previz/timeline-tables.test.ts`
Expected: FAIL，`isCutClip` 不存在 / `clipById` 找不到切片。

- [ ] **Step 3: 改 `timeline.ts`**

(a) import 从 `'./scene'` 补上 `PrevizAudioClip`、`PrevizCutClip`；新增一行 `import { audioFramesAvailable, framesToMs } from './audioTrack';`。

(b) 在 `isRigClip` 旁加两个守卫：

```ts
export function isCutClip(clip: PrevizClip): clip is PrevizCutClip {
  return clip.kind === 'cut';
}

export function isAudioClip(clip: PrevizClip): clip is PrevizAudioClip {
  return clip.kind === 'audio';
}
```

(c) 把 `clipById`（约 34-43 行）换成：

```ts
/** 片段在哪张表里。对象轨道带 `track`，另外两张表没有轨道这一层。 */
export type PrevizClipLocation =
  | { table: 'tracks'; track: PrevizTrack; clip: PrevizClip }
  | { table: 'program'; clip: PrevizCutClip }
  | { table: 'audio'; clip: PrevizAudioClip };

export function clipById(scene: PrevizScene, clipId: string): PrevizClipLocation | undefined {
  for (const track of scene.timeline.tracks) {
    const clip = track.clips.find((entry) => entry.id === clipId);
    if (clip) return { table: 'tracks', track, clip };
  }
  const cut = scene.timeline.program.find((entry) => entry.id === clipId);
  if (cut) return { table: 'program', clip: cut };
  const audio = scene.timeline.audio.find((entry) => entry.id === clipId);
  if (audio) return { table: 'audio', clip: audio };
  return undefined;
}
```

(d) 在 `withTrack` 之后加两个私有写入器：

```ts
function withProgram(scene: PrevizScene, program: PrevizCutClip[]): PrevizScene {
  return { ...scene, timeline: { ...scene.timeline, program } };
}

function withAudio(scene: PrevizScene, audio: PrevizAudioClip[]): PrevizScene {
  return { ...scene, timeline: { ...scene.timeline, audio } };
}
```

(e) `withClips` 换成三张表都认的版本：

```ts
/** 用 `next` 替换 `clipId` 所在位置（空数组即删除），三张表通用。 */
function withClips(scene: PrevizScene, clipId: string, next: PrevizClip[]): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found) return scene;
  if (found.table === 'program') {
    return withProgram(
      scene,
      scene.timeline.program.flatMap((cut) => (cut.id === clipId ? next.filter(isCutClip) : [cut])),
    );
  }
  if (found.table === 'audio') {
    return withAudio(
      scene,
      scene.timeline.audio.flatMap((clip) => (clip.id === clipId ? next.filter(isAudioClip) : [clip])),
    );
  }
  return withTrack(scene, found.track.id, {
    ...found.track,
    clips: found.track.clips.flatMap((clip) => (clip.id === clipId ? next : [clip])),
  });
}
```

（原实现是把 `found.track.clips` 里的目标换成 `next`；保持同样语义，只是多了两张表的分支。）

(f) 在 `withClips` 后加邻居边界：

```ts
/**
 * 镜头轨与音频轨里一段的可动范围：前一段的终点到后一段的起点。
 * 两张表都有序且不重叠，所以按下标取前后即可。
 */
function neighbourBounds(
  siblings: readonly { id: string; startFrame: number; endFrame: number }[],
  clipId: string,
): { lower: number; upper: number } {
  const index = siblings.findIndex((clip) => clip.id === clipId);
  return {
    lower: siblings[index - 1]?.endFrame ?? 0,
    upper: siblings[index + 1]?.startFrame ?? Number.POSITIVE_INFINITY,
  };
}

function siblingsOf(scene: PrevizScene, found: PrevizClipLocation): readonly PrevizClip[] | null {
  if (found.table === 'program') return scene.timeline.program;
  if (found.table === 'audio') return scene.timeline.audio;
  return null;
}
```

(g) `moveClip` 换成：

```ts
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
  let start = Math.min(
    Math.max(0, maxFrame - span),
    Math.max(0, clip.startFrame + Math.round(deltaFrames)),
  );
  const siblings = siblingsOf(scene, found);
  if (siblings) {
    // 固定行里的段不能压到邻居身上，卡在两边之间。
    const { lower, upper } = neighbourBounds(siblings, clipId);
    start = Math.min(Math.max(start, lower), Math.max(lower, upper - span));
  }
  if (start === clip.startFrame) return scene;
  return withClips(scene, clipId, [{ ...clip, startFrame: start, endFrame: start + span }]);
}
```

（原函数的最后两行若与此不同——例如没有 `start === clip.startFrame` 短路——以这里为准，对象轨道行为不变。）

(h) `trimClip` 换成：

```ts
export function trimClip(
  scene: PrevizScene,
  clipId: string,
  edge: 'start' | 'end',
  frame: number,
): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found) return scene;
  const { clip } = found;
  const fps = scene.settings.fps;
  const target = Math.round(frame);
  const siblings = siblingsOf(scene, found);
  const bounds = siblings ? neighbourBounds(siblings, clipId) : null;

  if (edge === 'start') {
    let start = Math.min(Math.max(0, target), clip.endFrame - PREVIZ_MIN_CLIP_FRAMES);
    if (bounds) start = Math.max(start, bounds.lower);
    if (found.table === 'audio') {
      // 往左拉等于把素材偏移往回退，退到 0 就到头了。
      start = Math.max(start, clip.startFrame - Math.floor((found.clip.offsetMs * fps) / 1000));
      const offsetMs = Math.max(0, found.clip.offsetMs + framesToMs(start - clip.startFrame, fps));
      return withClips(scene, clipId, [{ ...found.clip, startFrame: start, offsetMs }]);
    }
    return withClips(scene, clipId, [{ ...clip, startFrame: start }]);
  }

  let end = Math.max(target, clip.startFrame + PREVIZ_MIN_CLIP_FRAMES);
  if (bounds) end = Math.min(end, bounds.upper);
  if (found.table === 'audio') {
    // 素材放完就没有声音了，片段不能比剩余素材长。
    end = Math.max(
      clip.startFrame + PREVIZ_MIN_CLIP_FRAMES,
      Math.min(end, clip.startFrame + audioFramesAvailable(found.clip.durationMs, found.clip.offsetMs, fps)),
    );
  }
  return withClips(scene, clipId, [{ ...clip, endFrame: end }]);
}
```

（对象轨道原逻辑是 `start = Math.min(Math.max(0, target), clip.endFrame - PREVIZ_MIN_CLIP_FRAMES)` / `end = Math.max(target, clip.startFrame + PREVIZ_MIN_CLIP_FRAMES)`，保留不变。）

(i) `splitClip` 换成：

```ts
export function splitClip(scene: PrevizScene, clipId: string, frame: number): PrevizScene {
  const found = clipById(scene, clipId);
  if (!found) return scene;
  const { clip } = found;
  const cut = Math.round(frame);
  if (cut <= clip.startFrame || cut >= clip.endFrame) return scene;

  if (found.table === 'program') {
    return withClips(scene, clipId, [
      { ...found.clip, id: uuidv4(), endFrame: cut },
      { ...found.clip, id: uuidv4(), startFrame: cut },
    ]);
  }
  if (found.table === 'audio') {
    const fps = scene.settings.fps;
    return withClips(scene, clipId, [
      { ...found.clip, id: uuidv4(), endFrame: cut },
      {
        ...found.clip,
        id: uuidv4(),
        startFrame: cut,
        // 右半段从素材更靠后的位置起播，声音才接得上。
        offsetMs: found.clip.offsetMs + framesToMs(cut - clip.startFrame, fps),
      },
    ]);
  }
  if (!isPathClip(clip)) return scene;
  const uCut = frameToU(clip, cut);
  return withClips(scene, clipId, [
    { ...clip, id: uuidv4(), endFrame: cut, points: halfPoints(clip, uCut, 'left') },
    { ...clip, id: uuidv4(), startFrame: cut, points: halfPoints(clip, uCut, 'right') },
  ]);
}
```

（原来对象轨道的分支是 `if (!found || !isPathClip(found.clip)) return scene;` 开头；路径片段的行为不变。）

(j) `removeClip` 不用改（走 `withClips`）。`setPathAim` 里 `const objectId = found.track.objectId;` 之前的守卫改成 `if (!found || found.table !== 'tracks' || !isPathClip(found.clip)) return scene;`（原守卫若写成别的形式，就在原守卫后面追加 `if (found.table !== 'tracks') return scene;`）。`withPathPoints` 只用 `found.clip`，`isPathClip` 守卫已经把切片和音频排除掉了，不用动。

- [ ] **Step 4: 改 `closeupClip.ts`**

`updateRigClip`：`if (!found || !isRigClip(found.clip)) return scene;` → `if (!found || found.table !== 'tracks' || !isRigClip(found.clip)) return scene;`

`rigClipToPath`：同样把它的守卫改成带 `found.table !== 'tracks'` 的版本（`const objectId = found.track.objectId;` 之前）。

- [ ] **Step 5: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz && npx tsc -p tsconfig.app.json --noEmit`
Expected: 全部 PASS，tsc 退出码 0。若 `PrevizClipInspector.tsx` 因 `found.track` 报类型错，先在它的 `found` 判断处临时加 `if (!found || found.table !== 'tracks') return <空状态>;`（Task 15 会重写这一段），不要在这里做别的。

- [ ] **Step 6: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/features/previz/domain/timeline.ts frontend/src/features/previz/domain/closeupClip.ts frontend/src/features/previz/ui/PrevizClipInspector.tsx frontend/src/__tests__/features/previz/timeline-tables.test.ts && git commit -s -m "feat(previz): edit cuts and audio clips with the shared clip operations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---

### Task 5: store——切镜、加音频、跟随监看、`seekSerial`

**Files:**
- Modify: `src/features/previz/store.ts`
- Test: `src/__tests__/features/previz/store-program-audio.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultScene, type PrevizAudioClip } from '@/features/previz/domain/scene';
import { monitorCameraId, usePrevizStore } from '@/features/previz/store';

function reset() {
  usePrevizStore.getState().loadScene(createDefaultScene());
}

function addCamera(): string {
  return usePrevizStore.getState().addObject('camera')!;
}

const source = { audioUrl: '/static/a.mp3', sourceName: 'a.mp3', durationMs: 2000, sourceNodeId: null };

describe('cutToCamera', () => {
  beforeEach(reset);

  it('inserts a cut at the playhead and records an undo step', () => {
    const cam = addCamera();
    usePrevizStore.getState().setTimelineFrame(10);
    const pastBefore = usePrevizStore.getState().past.length;
    expect(usePrevizStore.getState().cutToCamera(cam)).toBeNull();
    expect(usePrevizStore.getState().scene.timeline.program).toMatchObject([
      { startFrame: 10, endFrame: 120, cameraId: cam },
    ]);
    expect(usePrevizStore.getState().past.length).toBe(pastBefore + 1);
  });

  it('returns the rejection and leaves history alone', () => {
    const cam = addCamera();
    usePrevizStore.getState().setTimelineFrame(10);
    usePrevizStore.getState().cutToCamera(cam);
    const pastBefore = usePrevizStore.getState().past.length;
    usePrevizStore.getState().setTimelineFrame(50);
    expect(usePrevizStore.getState().cutToCamera(cam)).toBe('same-camera');
    expect(usePrevizStore.getState().past.length).toBe(pastBefore);
  });

  it('retargets a cut through setCutCamera', () => {
    const camA = addCamera();
    const camB = addCamera();
    usePrevizStore.getState().cutToCamera(camA);
    const clipId = usePrevizStore.getState().scene.timeline.program[0]!.id;
    usePrevizStore.getState().setCutCamera(clipId, camB);
    expect(usePrevizStore.getState().scene.timeline.program[0]?.cameraId).toBe(camB);
  });

  it('drops the cuts of a removed camera in the same undo step', () => {
    const camA = addCamera();
    const camB = addCamera();
    usePrevizStore.getState().cutToCamera(camA);
    usePrevizStore.getState().setTimelineFrame(60);
    usePrevizStore.getState().cutToCamera(camB);
    const pastBefore = usePrevizStore.getState().past.length;
    usePrevizStore.getState().removeObject(camA);
    const { scene, past } = usePrevizStore.getState();
    expect(scene.timeline.program.map((cut) => cut.cameraId)).toEqual([camB]);
    expect(past.length).toBe(pastBefore + 1);
  });
});

describe('monitor follow', () => {
  beforeEach(reset);

  it('follows the program by default and resolves the live camera', () => {
    const cam = addCamera();
    usePrevizStore.getState().cutToCamera(cam);
    usePrevizStore.getState().setTimelineFrame(5);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(true);
    expect(monitorCameraId(usePrevizStore.getState())).toBe(cam);
  });

  it('falls back to the active camera in a gap', () => {
    const camA = addCamera();
    const camB = addCamera();
    usePrevizStore.getState().setTimelineFrame(60);
    usePrevizStore.getState().cutToCamera(camA);
    usePrevizStore.getState().setTimelineFrame(10);
    usePrevizStore.setState({ activeCameraId: camB });
    expect(monitorCameraId(usePrevizStore.getState())).toBe(camB);
  });

  it('stops following when a camera is picked by hand and resumes on followProgram', () => {
    const camA = addCamera();
    const camB = addCamera();
    usePrevizStore.getState().cutToCamera(camA);
    usePrevizStore.getState().setActiveCamera(camB);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(false);
    expect(monitorCameraId(usePrevizStore.getState())).toBe(camB);
    usePrevizStore.getState().followProgram();
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(true);
    expect(monitorCameraId(usePrevizStore.getState())).toBe(camA);
  });

  it('resets to following when a scene is loaded', () => {
    usePrevizStore.getState().setActiveCamera(null);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(false);
    reset();
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(true);
  });

  it('does not put the follow flag into undo history', () => {
    const cam = addCamera();
    const pastBefore = usePrevizStore.getState().past.length;
    usePrevizStore.getState().setActiveCamera(cam);
    usePrevizStore.getState().followProgram();
    expect(usePrevizStore.getState().past.length).toBe(pastBefore);
  });
});

describe('audio clips', () => {
  beforeEach(reset);

  it('adds a clip at the given frame, selects it and records undo', () => {
    const pastBefore = usePrevizStore.getState().past.length;
    expect(usePrevizStore.getState().addAudioClip(source, 10)).toBeNull();
    const { scene, selectedClipId, past } = usePrevizStore.getState();
    expect(scene.timeline.audio).toMatchObject([{ startFrame: 10, endFrame: 70 }]);
    expect(selectedClipId).toBe(scene.timeline.audio[0]?.id);
    expect(past.length).toBe(pastBefore + 1);
  });

  it('returns the rejection when there is no room', () => {
    usePrevizStore.getState().addAudioClip(source, 0);
    expect(usePrevizStore.getState().addAudioClip(source, 30)).toBe('no-room');
  });

  it('relocates a clip to the playhead', () => {
    usePrevizStore.getState().addAudioClip(source, 0);
    const clipId = usePrevizStore.getState().scene.timeline.audio[0]!.id;
    usePrevizStore.getState().setTimelineFrame(40);
    usePrevizStore.getState().relocateAudioClipToPlayhead(clipId);
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({
      startFrame: 40,
      endFrame: 100,
    });
  });

  it('keeps audio clips when the duration is shortened below them', () => {
    usePrevizStore.getState().addAudioClip(source, 100);
    usePrevizStore.getState().setDurationFrames(60);
    const clip: PrevizAudioClip | undefined = usePrevizStore.getState().scene.timeline.audio[0];
    expect(clip).toMatchObject({ startFrame: 100, endFrame: 120 });
  });
});

describe('seekSerial', () => {
  beforeEach(reset);

  it('bumps on seek and stop but not on playback ticks', () => {
    const start = usePrevizStore.getState().seekSerial;
    usePrevizStore.getState().setTimelineFrame(3);
    expect(usePrevizStore.getState().seekSerial).toBe(start + 1);
    usePrevizStore.getState().setTimelinePlaying(true);
    usePrevizStore.getState().tickPlayback(1000 / 30);
    expect(usePrevizStore.getState().seekSerial).toBe(start + 1);
    usePrevizStore.getState().stopPlayback();
    expect(usePrevizStore.getState().seekSerial).toBe(start + 2);
  });
});
```

`addObject('camera')` 与 `setDurationFrames` 是 store 里已有的动作；若 `addObject` 的签名是 `addObject(kind, …)` 带更多参数，按现有 `store.test.ts` 的调用方式传。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/store-program-audio.test.ts`
Expected: FAIL，`cutToCamera` 不是函数 / `monitorCameraId` 未导出。

- [ ] **Step 3: 改 `store.ts`**

(a) import：

```ts
import { insertAudioClip, type AudioInsertRejection, type PrevizAudioSource } from './domain/audioTrack';
import { insertCut, liveCameraAt, type CutRejection } from './domain/program';
```

并确认 `moveClip` 与 `clipById` 已在从 `./domain/timeline` 的 import 里（没有就补）。

(b) `interface PrevizStoreState` 加字段（放在 `activeCameraId` 之后）：

```ts
  /**
   * 监看是否跟着镜头轨走。手动点一台机位就退出跟随；这是会话状态，不进 undo，
   * 也不存进场景——换个人打开同一节点，默认还是跟随。
   */
  monitorFollowsProgram: boolean;
  /** 每次跳转/停止 +1，编辑器靠它知道该重新起播音频。播放 tick 不动它。 */
  seekSerial: number;
```

以及动作：

```ts
  followProgram: () => void;
  /** 在播放头处切到某机位；返回拒绝原因，成功为 null。 */
  cutToCamera: (cameraId: string) => CutRejection | null;
  setCutCamera: (clipId: string, cameraId: string) => void;
  addAudioClip: (source: PrevizAudioSource, atFrame: number) => AudioInsertRejection | null;
  relocateAudioClipToPlayhead: (clipId: string) => void;
```

(c) 初始值（`activeCameraId: null` 附近）加 `monitorFollowsProgram: true, seekSerial: 0,`。

(d) `loadScene` 的 `set({...})` 里加 `monitorFollowsProgram: true,`。

(e) `setActiveCamera`：

```ts
  setActiveCamera: (id) => set({ activeCameraId: id, monitorFollowsProgram: false }),
  followProgram: () => set({ monitorFollowsProgram: true }),
```

(f) `removeObject` 的 `timeline` 部分补一行：

```ts
      timeline: {
        ...scene.timeline,
        tracks: scene.timeline.tracks.filter((track) => track.objectId !== id),
        // 机位没了，指向它的切片一起走，同一步 undo 能整体回来。
        program: scene.timeline.program.filter((cut) => cut.cameraId !== id),
      },
```

(g) `setTimelineFrame` 的 `set({ timelineFrame: clamped, playbackCarry: 0 })` 改为 `set((state) => ({ timelineFrame: clamped, playbackCarry: 0, seekSerial: state.seekSerial + 1 }))`；`stopPlayback` 里的 `set(...)` 同样加 `seekSerial: state.seekSerial + 1`（若它现在是 `set({ timelinePlaying: false, … })` 形式，改成函数式 `set((state) => ({ …, seekSerial: state.seekSerial + 1 }))`）。`tickPlayback` 不动。

(h) 在 `addCloseup` 附近加四个动作：

```ts
  cutToCamera: (cameraId) => {
    const { scene, timelineFrame, applyScene } = get();
    const result = insertCut(scene, timelineFrame, cameraId);
    if (!result.ok) return result.reason;
    applyScene(result.scene);
    return null;
  },

  setCutCamera: (clipId, cameraId) => {
    const { scene, applyScene } = get();
    const camera = scene.objects.find((object) => object.id === cameraId);
    if (camera?.kind !== 'camera') return;
    if (!scene.timeline.program.some((cut) => cut.id === clipId)) return;
    applyScene({
      ...scene,
      timeline: {
        ...scene.timeline,
        program: scene.timeline.program.map((cut) => (cut.id === clipId ? { ...cut, cameraId } : cut)),
      },
    });
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
    const next = moveClip(scene, clipId, timelineFrame - found.clip.startFrame, scene.settings.durationFrames);
    if (next !== scene) applyScene(next);
  },
```

`get()` 里若拿不到 `applyScene`（它是 store 内部的闭包函数而不是 state 字段），就按文件里其它动作的写法直接调用闭包 `applyScene(...)`。

(i) 文件末尾（`}));` 之后）加选择器：

```ts
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
```

- [ ] **Step 4: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/store-program-audio.test.ts src/__tests__/features/previz/store.test.ts && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS；tsc 退出码 0。

- [ ] **Step 5: 提交**

```bash
cd /Users/like/code/dramaclaw && git add -p frontend/src/features/previz/store.ts && git add frontend/src/__tests__/features/previz/store-program-audio.test.ts && git commit -s -m "feat(previz): drive cuts, audio clips and monitor follow from the store

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

（`git add -p` 只选本任务的 hunk，视口重构的改动留在工作区。）

---

### Task 6: `engine/audioPlayback.ts` 与 `engine/audioProbe.ts`

**Files:**
- Create: `src/features/previz/engine/audioPlayback.ts`
- Create: `src/features/previz/engine/audioProbe.ts`
- Test: `src/__tests__/features/previz/audio-playback.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';

import {
  createAudioPlayback,
  type AudioBufferSourceLike,
  type AudioContextLike,
} from '@/features/previz/engine/audioPlayback';
import type { PrevizAudioClip } from '@/features/previz/domain/scene';

function clip(id: string, startFrame: number, endFrame: number, offsetMs = 0): PrevizAudioClip {
  return {
    id,
    kind: 'audio',
    startFrame,
    endFrame,
    audioUrl: `/static/${id}.mp3`,
    sourceName: `${id}.mp3`,
    durationMs: 10_000,
    offsetMs,
    sourceNodeId: null,
  };
}

function fakeContext(currentTime = 100) {
  const sources: Array<AudioBufferSourceLike & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }> = [];
  const destination = { id: 'speakers' } as unknown as AudioNode;
  const context: AudioContextLike = {
    currentTime,
    destination,
    createBufferSource: () => {
      const source = {
        buffer: null,
        playbackRate: { value: 1 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
      sources.push(source);
      return source;
    },
    createMediaStreamDestination: () => ({ stream: {} }) as unknown as MediaStreamAudioDestinationNode,
    close: vi.fn(async () => {}),
  };
  return { context, sources, destination };
}

function setup(failing: string[] = []) {
  const { context, sources, destination } = fakeContext();
  const fetchBuffer = vi.fn(async (url: string) => {
    if (failing.includes(url)) throw new Error(`boom ${url}`);
    return { url } as unknown as AudioBuffer;
  });
  const playback = createAudioPlayback({ context, fetchBuffer });
  return { playback, sources, destination, fetchBuffer };
}

describe('createAudioPlayback', () => {
  it('loads each url once and remembers failures', async () => {
    const { playback, fetchBuffer } = setup(['/static/bad.mp3']);
    await playback.load([clip('a', 0, 30), clip('a', 40, 60), clip('bad', 0, 10)]);
    await playback.load([clip('a', 0, 30)]);
    expect(fetchBuffer).toHaveBeenCalledTimes(2);
    expect([...playback.failedUrls]).toEqual(['/static/bad.mp3']);
  });

  it('starts a clip under the playhead at the matching material offset', async () => {
    const { playback, sources, destination } = setup();
    await playback.play([clip('a', 30, 90, 500)], 45, 1);
    expect(sources).toHaveLength(1);
    const [source] = sources;
    // 偏移 0.5 s，再加播放头进入片段 15 帧 = 0.5 s；剩余 45 帧 = 1.5 s。
    expect(source!.start).toHaveBeenCalledWith(100, 1, 1.5);
    expect(source!.connect).toHaveBeenCalledWith(destination);
    expect(source!.playbackRate.value).toBe(1);
  });

  it('schedules a future clip relative to the playhead, scaled by rate', async () => {
    const { playback, sources } = setup();
    await playback.play([clip('a', 60, 90)], 30, 2);
    // 30 帧 = 1 s，倍速 2 → 0.5 s 后开始；整段 30 帧 = 1 s 素材。
    expect(sources[0]!.start).toHaveBeenCalledWith(100.5, 0, 1);
    expect(sources[0]!.playbackRate.value).toBe(2);
  });

  it('skips clips that already ended and clips whose buffer failed', async () => {
    const { playback, sources } = setup(['/static/bad.mp3']);
    await playback.play([clip('a', 0, 10), clip('bad', 20, 40)], 15, 1);
    expect(sources).toHaveLength(0);
  });

  it('routes to the given destination when recording', async () => {
    const { playback, sources } = setup();
    const mix = { id: 'mix' } as unknown as AudioNode;
    await playback.play([clip('a', 0, 30)], 0, 1, mix);
    expect(sources[0]!.connect).toHaveBeenCalledWith(mix);
  });

  it('stops and disconnects every live source', async () => {
    const { playback, sources } = setup();
    await playback.play([clip('a', 0, 30), clip('b', 40, 60)], 0, 1);
    playback.stop();
    for (const source of sources) {
      expect(source.stop).toHaveBeenCalled();
      expect(source.disconnect).toHaveBeenCalled();
    }
  });

  it('drops a play that was superseded while its buffers were loading', async () => {
    const { context, sources } = fakeContext();
    let release: (() => void) | undefined;
    const fetchBuffer = vi.fn(
      (url: string) =>
        new Promise<AudioBuffer>((resolve) => {
          release = () => resolve({ url } as unknown as AudioBuffer);
        }),
    );
    const playback = createAudioPlayback({ context, fetchBuffer });
    const first = playback.play([clip('a', 0, 30)], 0, 1);
    playback.stop();
    release?.();
    await first;
    expect(sources).toHaveLength(0);
  });

  it('closes the context on dispose', async () => {
    const { playback } = setup();
    playback.dispose();
    expect(playback.context.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/audio-playback.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 `audioPlayback.ts`**

```ts
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { PREVIZ_FPS, type PrevizAudioClip } from '../domain/scene';

/**
 * 音频轨的播放引擎。只认「一组片段 + 从哪一帧起 + 倍速」，把每段换算成
 * `AudioBufferSourceNode.start(when, offset, duration)` 一次排完；播放头一跳、
 * 倍速一改，编辑器就 stop 再 play，不做增量。
 *
 * `AudioContext` 与解码由外面注入，测试给假的即可；浏览器胶水在文件底部。
 */

export interface AudioBufferSourceLike {
  buffer: AudioBuffer | null;
  playbackRate: { value: number };
  connect(destination: AudioNode): unknown;
  start(when?: number, offset?: number, duration?: number): void;
  stop(): void;
  disconnect(): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNode;
  createBufferSource(): AudioBufferSourceLike;
  createMediaStreamDestination(): MediaStreamAudioDestinationNode;
  close(): Promise<void>;
}

export interface AudioPlaybackDeps {
  context: AudioContextLike;
  fetchBuffer: (url: string) => Promise<AudioBuffer>;
}

export interface PrevizAudioPlayback {
  readonly context: AudioContextLike;
  /** 预取并解码所有片段的素材；失败的 url 记进 `failedUrls`，不抛。 */
  load(clips: readonly PrevizAudioClip[]): Promise<void>;
  /** 从 `fromFrame` 起按 `rate` 播；`destination` 缺省为扬声器，录制时传混音节点。 */
  play(
    clips: readonly PrevizAudioClip[],
    fromFrame: number,
    rate: number,
    destination?: AudioNode,
  ): Promise<void>;
  stop(): void;
  dispose(): void;
  readonly failedUrls: ReadonlySet<string>;
}

export function createAudioPlayback({ context, fetchBuffer }: AudioPlaybackDeps): PrevizAudioPlayback {
  const buffers = new Map<string, AudioBuffer>();
  const loading = new Map<string, Promise<void>>();
  const failedUrls = new Set<string>();
  let live: AudioBufferSourceLike[] = [];
  // 每次 play/stop +1；load 期间又来了一次 stop 或 play，旧的那次拿到 buffer 后什么都不做。
  let generation = 0;

  function loadOne(url: string): Promise<void> {
    if (buffers.has(url) || failedUrls.has(url)) return Promise.resolve();
    const pending = loading.get(url);
    if (pending) return pending;
    const task = fetchBuffer(url)
      .then((buffer) => {
        buffers.set(url, buffer);
      })
      .catch((error: unknown) => {
        failedUrls.add(url);
        console.warn('[previz] audio decode failed', url, error);
      })
      .finally(() => {
        loading.delete(url);
      });
    loading.set(url, task);
    return task;
  }

  function stop() {
    generation += 1;
    for (const source of live) {
      try {
        source.stop();
      } catch {
        // 还没 start 过的源 stop 会抛 InvalidStateError，忽略。
      }
      source.disconnect();
    }
    live = [];
  }

  return {
    context,
    failedUrls,
    load(clips) {
      return Promise.all([...new Set(clips.map((clip) => clip.audioUrl))].map(loadOne)).then(() => {});
    },
    async play(clips, fromFrame, rate, destination) {
      stop();
      const mine = generation;
      await this.load(clips);
      if (mine !== generation) return;
      const now = context.currentTime;
      const target = destination ?? context.destination;
      for (const clip of clips) {
        if (clip.endFrame <= fromFrame) continue;
        const buffer = buffers.get(clip.audioUrl);
        if (!buffer) continue;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        source.connect(target);
        if (clip.startFrame <= fromFrame) {
          // 播放头已在段内：从素材里对应的位置起，放到段尾。
          const offset = clip.offsetMs / 1000 + (fromFrame - clip.startFrame) / PREVIZ_FPS;
          source.start(now, offset, (clip.endFrame - fromFrame) / PREVIZ_FPS);
        } else {
          // 还没到：按倍速折算等待时间，整段素材照常。
          const when = now + (clip.startFrame - fromFrame) / PREVIZ_FPS / rate;
          source.start(when, clip.offsetMs / 1000, (clip.endFrame - clip.startFrame) / PREVIZ_FPS);
        }
        live.push(source);
      }
    },
    stop,
    dispose() {
      stop();
      void context.close();
      buffers.clear();
      loading.clear();
    },
  };
}

let warnedNoAudioContext = false;

/** 浏览器不给 AudioContext（隐私模式、无音频设备）时静音继续，只在控制台说一次。 */
export function createAudioContext(): AudioContext | null {
  try {
    return new AudioContext();
  } catch (error) {
    if (!warnedNoAudioContext) {
      warnedNoAudioContext = true;
      console.warn('[previz] AudioContext unavailable, audio track is muted', error);
    }
    return null;
  }
}

export async function fetchAudioBuffer(context: AudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`audio fetch failed: ${response.status}`);
  return context.decodeAudioData(await response.arrayBuffer());
}
```

注意 `play` 里的 `this.load(clips)` 依赖对象字面量的 `this`；为避免解构后丢 `this`，把 `load` 抽成局部函数 `loadAll` 再在 `play` 里直接调用——实现时用局部函数，不要依赖 `this`：

```ts
  function loadAll(clips: readonly PrevizAudioClip[]): Promise<void> {
    return Promise.all([...new Set(clips.map((clip) => clip.audioUrl))].map(loadOne)).then(() => {});
  }
```

然后 `load: loadAll`，`play` 中 `await loadAll(clips);`。

- [ ] **Step 4: 实现 `audioProbe.ts`**

```ts
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 用一个不挂进文档的 `<audio>` 读素材时长（毫秒）。本地文件走 object URL，
 * 上游节点没记时长时走它的 url。读不出有限值就当上传失败处理，由调用方提示。
 */
export function probeAudioDuration(source: File | string): Promise<number> {
  return new Promise((resolve, reject) => {
    const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const cleanup = () => {
      audio.removeAttribute('src');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    audio.onloadedmetadata = () => {
      const seconds = audio.duration;
      cleanup();
      if (!Number.isFinite(seconds) || seconds <= 0) {
        reject(new Error('audio duration unavailable'));
        return;
      }
      resolve(Math.round(seconds * 1000));
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('audio metadata failed'));
    };
    audio.src = objectUrl ?? (source as string);
  });
}
```

- [ ] **Step 5: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/audio-playback.test.ts && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS（8 个）；tsc 退出码 0。

- [ ] **Step 6: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/features/previz/engine/audioPlayback.ts frontend/src/features/previz/engine/audioProbe.ts frontend/src/__tests__/features/previz/audio-playback.test.ts && git commit -s -m "feat(previz): schedule audio clips on a Web Audio context

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---

### Task 7: 直播机位——`setFrustumLive`、`setLiveCamera`、`drawFrame(frame, cameraId)`

**Files:**
- Modify: `src/features/previz/engine/cameraModel.ts`
- Modify: `src/features/previz/engine/PrevizRenderer.ts`
- Test: `src/__tests__/features/previz/camera-model.test.ts`
- Test: `src/__tests__/features/previz/previz-renderer-scene.test.ts`

- [ ] **Step 1: 写失败的 `setFrustumLive` 测试**

在 `camera-model.test.ts` 的 import 里加 `setFrustumLive, PREVIZ_LIVE_FRUSTUM_COLOR`（与 `syncCameraFrustum` 同一条 import），并在文件末尾追加：

```ts
describe('setFrustumLive', () => {
  it('recolours the frustum and its placeholder colour when live', () => {
    const model = buildCameraModel(three, cameraWith(), '16:9');
    const frustum = frustumOf(model);
    setFrustumLive(model, true);
    expect(frustum.userData.previzPlaceholderColor).toBe(PREVIZ_LIVE_FRUSTUM_COLOR);
    expect(frustum.material.color.set).toHaveBeenLastCalledWith(PREVIZ_LIVE_FRUSTUM_COLOR);
  });

  it('restores the default colour when no longer live', () => {
    const model = buildCameraModel(three, cameraWith(), '16:9');
    const frustum = frustumOf(model);
    setFrustumLive(model, true);
    setFrustumLive(model, false);
    expect(frustum.userData.previzPlaceholderColor).toBe(PREVIZ_CAMERA_COLOR.frustum);
    expect(frustum.material.color.set).toHaveBeenLastCalledWith(PREVIZ_CAMERA_COLOR.frustum);
  });
});
```

`frustumOf(model)` 返回的对象若类型上没有 `material.color.set`，用 `(frustum.material as { color: { set: ReturnType<typeof vi.fn> } }).color.set`。`PREVIZ_CAMERA_COLOR` 若尚未 import，一并加。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/camera-model.test.ts`
Expected: FAIL，`setFrustumLive` 不是函数。

- [ ] **Step 3: 实现 `setFrustumLive`**

`cameraModel.ts` 的 `PREVIZ_CAMERA_COLOR` 常量之后加：

```ts
/** 镜头轨正在直播的机位，视锥涂成红色——导播台的 tally 灯就是这个颜色。 */
export const PREVIZ_LIVE_FRUSTUM_COLOR = 0xff4d4f;

/**
 * 切换视锥的直播色。同时改 `previzPlaceholderColor`：`applyDisplayMode` 切显示模式时
 * 会拿这个字段把颜色写回去，不改它的话切一次模式就掉回橙色。
 */
export function setFrustumLive(model: Object3D, live: boolean): void {
  const color = live ? PREVIZ_LIVE_FRUSTUM_COLOR : PREVIZ_CAMERA_COLOR.frustum;
  model.traverse((child) => {
    if (!child.userData.previzCameraFrustum) return;
    child.userData.previzPlaceholderColor = color;
    const material = (child as { material?: { color?: { set(value: number): unknown } } }).material;
    material?.color?.set(color);
  });
}
```

`Object3D` 类型按文件里已有的 three 类型 import 方式拿（该文件用 `ThreeModule` 之类的动态类型时，用与 `syncCameraFrustum` 的 `model` 参数相同的类型）。

- [ ] **Step 4: 跑测试**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/camera-model.test.ts`
Expected: PASS。

- [ ] **Step 5: 写失败的渲染器测试**

在 `previz-renderer-scene.test.ts` 末尾追加（该文件已有创建 renderer 与 `sceneWithWalk` 之类的工具；下面用文件里已有的 `createRenderer()`/`setup()` 名称，对不上就改成文件里实际的工厂名）：

```ts
describe('live camera highlight', () => {
  it('recolours the live camera frustum and restores the previous one', async () => {
    const { renderer, three } = await setup();
    const scene = createDefaultScene();
    const camA = createPrevizObject('camera', scene.objects);
    const camB = createPrevizObject('camera', [camA]);
    renderer.setScene({ ...scene, objects: [camA, camB] });
    const frustumOf = (id: string) => {
      let hit: { userData: Record<string, unknown> } | undefined;
      renderer.graph.nodeFor(id)?.traverse((child: { userData: Record<string, unknown> }) => {
        if (child.userData.previzCameraFrustum) hit = child;
      });
      return hit!;
    };
    renderer.setLiveCamera(camA.id);
    expect(frustumOf(camA.id).userData.previzPlaceholderColor).toBe(PREVIZ_LIVE_FRUSTUM_COLOR);
    renderer.setLiveCamera(camB.id);
    expect(frustumOf(camA.id).userData.previzPlaceholderColor).toBe(PREVIZ_CAMERA_COLOR.frustum);
    expect(frustumOf(camB.id).userData.previzPlaceholderColor).toBe(PREVIZ_LIVE_FRUSTUM_COLOR);
    renderer.setLiveCamera(null);
    expect(frustumOf(camB.id).userData.previzPlaceholderColor).toBe(PREVIZ_CAMERA_COLOR.frustum);
    void three;
  });

  it('keeps the highlight across setScene', async () => {
    const { renderer } = await setup();
    const scene = createDefaultScene();
    const camA = createPrevizObject('camera', scene.objects);
    renderer.setScene({ ...scene, objects: [camA] });
    renderer.setLiveCamera(camA.id);
    renderer.setScene({ ...scene, objects: [{ ...camA, name: 'renamed' }] });
    let color: unknown;
    renderer.graph.nodeFor(camA.id)?.traverse((child: { userData: Record<string, unknown> }) => {
      if (child.userData.previzCameraFrustum) color = child.userData.previzPlaceholderColor;
    });
    expect(color).toBe(PREVIZ_LIVE_FRUSTUM_COLOR);
  });
});
```

若 `renderer.graph` 是 private，测试里用 `(renderer as unknown as { graph: { nodeFor(id: string): … } }).graph`。补 import：`PREVIZ_CAMERA_COLOR, PREVIZ_LIVE_FRUSTUM_COLOR` 来自 `@/features/previz/engine/cameraModel`，`createPrevizObject` 来自 `@/features/previz/domain/objects`。

- [ ] **Step 6: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-renderer-scene.test.ts -t "live camera"`
Expected: FAIL，`setLiveCamera` 不是函数。

- [ ] **Step 7: 改 `PrevizRenderer.ts`**

(a) import 从 `./cameraModel` 多拿 `setFrustumLive`。

(b) 字段区（`activeCameraId` 附近）加：

```ts
  /** 镜头轨当前直播的机位；视锥涂红。与 `activeCameraId`（监看/操作对象）无关。 */
  private liveCameraId: string | null = null;
```

(c) `setActiveCamera` 之后加：

```ts
  setLiveCamera(objectId: string | null): void {
    if (objectId === this.liveCameraId) return;
    if (this.liveCameraId) {
      const previous = this.graph.nodeFor(this.liveCameraId);
      if (previous) setFrustumLive(previous, false);
    }
    this.liveCameraId = objectId;
    if (objectId) {
      const next = this.graph.nodeFor(objectId);
      if (next) setFrustumLive(next, true);
    }
    this.requestRender();
  }
```

(d) `setScene` 里在 `this.graph.sync(...)`（或等价的同步调用）之后加：

```ts
    // sync 可能重建了机位模型，直播色要重新涂上去。
    if (this.liveCameraId) {
      const node = this.graph.nodeFor(this.liveCameraId);
      if (node) setFrustumLive(node, true);
    }
```

(e) `PrevizRecordingPass.drawFrame` 的签名改成 `drawFrame(frame: number, cameraId: string | null): void;`，注释：「全局录制每帧传镜头轨当前机位（null 走导演视角）；单轨录制忽略这个参数。」

(f) `startRecording` 的 `drawFrame` 换成：

```ts
      drawFrame: (frame, liveId) => {
        if (ended || this.disposed) return;
        this.setFrame(frame);
        // 单轨录制锁死在指定机位；全局录制每帧看镜头轨说该看谁。
        const shot =
          mode === 'track' ? camera : liveId ? scene.objects.find((object) => object.id === liveId) : undefined;
        const shotNode = mode === 'track' ? cameraNode : liveId ? this.graph.nodeFor(liveId) : undefined;
        if (shot?.kind === 'camera' && shotNode && monitor) {
          // 直播机位自己的模型不能出现在自己拍的画面里。
          const wasVisible = shotNode.visible;
          shotNode.visible = false;
          try {
            syncMonitorCamera(monitor, shotNode, shot, aspect);
            painter.paint(monitor);
          } finally {
            shotNode.visible = wasVisible;
          }
          return;
        }
        const editorAspect = this.camera.aspect;
        this.camera.aspect = aspectRatio(aspect);
        this.camera.updateProjectionMatrix();
        try {
          painter.paint(this.camera);
        } finally {
          this.camera.aspect = editorAspect;
          this.camera.updateProjectionMatrix();
        }
      },
```

`scene` 这里指 `startRecording` 里已经拿到的当前场景（`this.currentScene`）；若函数体内没有这个局部变量，在解析 `camera` 的地方加 `const scene = this.currentScene; if (!scene) return null;`。单轨模式原本在 `startRecording` 开头就把 `cameraNode.visible = false` 且在 `end()` 恢复，这段逻辑保留；上面的 `wasVisible` 只是让全局模式也做同样的事。

- [ ] **Step 8: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-renderer-scene.test.ts src/__tests__/features/previz/previz-renderer.test.ts src/__tests__/features/previz/camera-model.test.ts && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS。tsc 会在 `PrevizEditor.tsx` 的 `pass.drawFrame(frame)` 处报少一个参数——先改成 `pass.drawFrame(frame, null)`（Task 17 会换成镜头轨查询）。`previz-editor.test.tsx` 的假渲染器需要加 `setLiveCamera: vi.fn()`（在 mock 的方法列表里与 `setActiveCamera` 并列），否则 Task 16 之前编辑器测试不受影响，但为了 typecheck 一并加上。

- [ ] **Step 9: 提交**

```bash
cd /Users/like/code/dramaclaw && git add -p frontend/src/features/previz/engine/PrevizRenderer.ts frontend/src/features/previz/PrevizEditor.tsx frontend/src/__tests__/features/previz/previz-editor.test.tsx && git add frontend/src/features/previz/engine/cameraModel.ts frontend/src/__tests__/features/previz/camera-model.test.ts frontend/src/__tests__/features/previz/previz-renderer-scene.test.ts && git commit -s -m "feat(previz): highlight the live camera and record the program cut by cut

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---

### Task 8: 录制混音——`pickRecordMimeType(…, withAudio)`、`audioStream`、`durationMs`

**Files:**
- Modify: `src/features/previz/capture/recordTimeline.ts`
- Modify: `src/features/previz/capture/publishRecording.ts`
- Modify: `src/stores/canvasStore.ts:225-230, 2317-2335`
- Test: `src/__tests__/features/previz/record-timeline.test.ts`
- Test: `src/__tests__/features/previz/publish-recording.test.ts`

- [ ] **Step 1: 写失败的测试**

`record-timeline.test.ts` 的 `describe("pickRecordMimeType")` 里追加：

```ts
  it("prefers a mixed container when audio is wanted", () => {
    expect(pickRecordMimeType(() => true, true)).toBe("video/mp4;codecs=avc1.42E01E,mp4a.40.2");
    expect(
      pickRecordMimeType((type) => type.startsWith("video/webm"), true),
    ).toBe("video/webm;codecs=vp9,opus");
  });

  it("returns null when no mixed container is supported so the caller can fall back", () => {
    expect(pickRecordMimeType((type) => !type.includes("opus") && !type.includes("mp4a"), true)).toBeNull();
  });
```

文件末尾追加：

```ts
describe("createCanvasRecorder", () => {
  class FakeMediaRecorder {
    static isTypeSupported = () => true;
    state = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(
      public stream: { getTracks: () => unknown[]; addTrack: (track: unknown) => void },
      public options: { mimeType: string },
    ) {}
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.onstop?.();
    }
  }

  it("adds the audio tracks of the given stream to the canvas stream", async () => {
    const original = globalThis.MediaRecorder;
    globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
    try {
      const addTrack = vi.fn();
      const canvas = {
        captureStream: () => ({ getTracks: () => [], addTrack }),
      } as unknown as HTMLCanvasElement;
      const audioTrack = { kind: "audio", stop: vi.fn() };
      const audioStream = { getAudioTracks: () => [audioTrack] } as unknown as MediaStream;
      const recorder = createCanvasRecorder(canvas, { fps: 30, mimeType: "video/webm", audioStream });
      expect(addTrack).toHaveBeenCalledWith(audioTrack);
      recorder.start();
      await expect(recorder.stop()).resolves.toBeInstanceOf(Blob);
    } finally {
      globalThis.MediaRecorder = original;
    }
  });
});
```

补 import：`createCanvasRecorder` 来自 `@/features/previz/capture/recordTimeline`。

`publish-recording.test.ts`：`setup` 的默认 deps 加 `durationMs: 4000`，并把断言 `toHaveBeenCalledWith("previz-1", url, "16:9", displayName)` 改成 `toHaveBeenCalledWith("previz-1", url, "16:9", displayName, 4000)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/record-timeline.test.ts src/__tests__/features/previz/publish-recording.test.ts`
Expected: FAIL，`pickRecordMimeType(() => true, true)` 仍返回无声容器；`durationMs` 断言不匹配。

- [ ] **Step 3: 改 `recordTimeline.ts`**

(a) `MIME_CANDIDATES` 改名为 `VIDEO_MIME_CANDIDATES`，并在其后加：

```ts
/** 带音轨的候选。mp4 配 AAC，webm 配 Opus；顺序同无声版，先 mp4 后 webm。 */
const MIXED_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;
```

（"video/mp4" 与 "video/webm" 这两个裸类型在有音轨时是否真的混进声音由浏览器决定；把它们留在混音列表里是为了 Safari——它只报告裸类型支持，但录出来带 AAC。）

(b) `pickRecordMimeType` 签名改为：

```ts
export function pickRecordMimeType(
  isSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
  withAudio = false,
): string | null {
  const candidates = withAudio ? MIXED_MIME_CANDIDATES : VIDEO_MIME_CANDIDATES;
  return candidates.find((type) => isSupported(type)) ?? null;
}
```

（原函数体若是 `for` 循环形式，保留原形式，只把候选列表换成三元选择。）

(c) `CanvasRecorderOptions` 加：

```ts
  /** 音频轨的混音流；给了就并进画布流，MediaRecorder 会把它编成音轨。 */
  audioStream?: MediaStream;
```

(d) `createCanvasRecorder` 里 `const stream = canvas.captureStream(options.fps);` 之后加：

```ts
  for (const track of options.audioStream?.getAudioTracks() ?? []) {
    stream.addTrack(track);
  }
```

- [ ] **Step 4: 改 `publishRecording.ts` 与 `canvasStore.ts`**

`publishRecording.ts`：`PublishRecordingDeps` 加 `durationMs: number;`，`addDerivedVideoNode` 的类型改为 `(sourceNodeId: string, videoUrl: string, aspectRatio: string, displayName: string, durationMs: number) => string | null;`，调用处改为 `deps.addDerivedVideoNode(deps.sourceNodeId, url, deps.aspect, deps.displayName, deps.durationMs)`。

`canvasStore.ts` 接口（约 225-230 行）：

```ts
  addDerivedVideoNode: (
    sourceNodeId: string,
    videoUrl: string,
    aspectRatio: string,
    displayName?: string | null,
    durationMs?: number | null,
  ) => string | null;
```

实现（约 2317 行）：参数列表加 `durationMs`，`createNode` 的数据加 `durationMs: durationMs ?? null,`（与 `sourceFileName: null` 并列）。若 `VideoNodeData` 没有 `durationMs` 字段，在 `canvasNodes.ts` 的 `VideoNodeData` 里加 `durationMs?: number | null;`——先 `grep -n "durationMs" src/features/canvas/domain/canvasNodes.ts` 确认。

- [ ] **Step 5: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/record-timeline.test.ts src/__tests__/features/previz/publish-recording.test.ts src/__tests__/features/previz/previz-editor.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: `record-timeline` 与 `publish-recording` PASS。tsc 在 `PrevizEditor.tsx` 的 `publishRecording({...})` 处报缺 `durationMs`——先传 `durationMs: Math.round((durationFrames / PREVIZ_RECORD_FPS) * 1000)`（`durationFrames` 是该函数里已有的局部变量，Task 17 会换成实际绘制帧数）；`previz-editor.test.tsx` 里录制测试的 `addDerivedVideoNode` 断言加第五个参数 `expect.any(Number)`。

- [ ] **Step 6: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/features/previz/capture/recordTimeline.ts frontend/src/features/previz/capture/publishRecording.ts frontend/src/stores/canvasStore.ts frontend/src/__tests__/features/previz/record-timeline.test.ts frontend/src/__tests__/features/previz/publish-recording.test.ts && git add -p frontend/src/features/previz/PrevizEditor.tsx frontend/src/__tests__/features/previz/previz-editor.test.tsx && git commit -s -m "feat(previz): mix an audio stream into the recording and stamp its duration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

若 `canvasNodes.ts` 也改了，加进 `git add`。

---
### Task 9: i18n key 与 locale 测试

**Files:**
- Modify: `public/locales/zh/translation.json`
- Modify: `public/locales/en/translation.json`
- Test: `src/__tests__/i18n/previz-locale.test.ts`

- [ ] **Step 1: 改 locale 测试**

`TIMELINE_KEYS` 数组末尾追加 `'cutHere', 'live'`。

`CLIP_KEYS` 不变。在它旁边加：

```ts
const CUT_KEYS = ['camera'];
const AUDIO_CLIP_KEYS = ['source', 'offset', 'relocate'];
const PROGRAM_KEYS = ['title', 'cutTo', 'empty', 'noRoom', 'limit'];
const AUDIO_KEYS = [
  'title',
  'add',
  'local',
  'upstream',
  'noUpstream',
  'uploading',
  'badExtension',
  'tooLarge',
  'noRoom',
  'limit',
  'uploadFailed',
];
```

clip 用例里的解构 `const { point, closeup, ...rest } = bundle.previz.clip` 改成 `const { point, closeup, cut, audio, ...rest } = bundle.previz.clip`，并在同一用例末尾加：

```ts
      expect(Object.keys(cut)).toEqual(CUT_KEYS);
      expect(Object.keys(audio)).toEqual(AUDIO_CLIP_KEYS);
```

新增一个 `describe`（与 timeline 用例同样按 `[zh, en]` 循环，沿用文件里 bundle 的取法）：

```ts
describe('previz program and audio locale', () => {
  it.each([['zh', zh], ['en', en]] as const)('%s carries the program and audio keys', (_name, bundle) => {
    expect(Object.keys(bundle.previz.program)).toEqual(PROGRAM_KEYS);
    expect(Object.keys(bundle.previz.audio)).toEqual(AUDIO_KEYS);
    expect(bundle.previz.monitor).toHaveProperty('follow');
    expect(bundle.previz.monitor).toHaveProperty('following');
    expect(bundle.previz.node).toHaveProperty('audioSummary');
    expect(bundle.previz.editor.record).toHaveProperty('noAudioMix');
    // 上传失败要把后端原话带出来，占位符不能丢。
    expect(bundle.previz.audio.uploadFailed).toContain('{{message}}');
    expect(bundle.previz.node.audioSummary).toContain('{{count}}');
  });
});
```

文件里若 `zh` / `en` 变量名不同（比如 `zhBundle`），按文件里的名字。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/i18n/previz-locale.test.ts`
Expected: FAIL，`bundle.previz.program` 为 undefined。

- [ ] **Step 3: 加 key**

两个文件都在 `previz` 对象里改。每个子对象都**追加到该对象末尾**（timeline/clip 的用例比较的是 key 顺序）。`previz.program` 与 `previz.audio` 两个新对象插在 `previz.timeline` 与 `previz.clip` 之间（zh、en 位置一致，最后一条用例比较的是 `Object.keys(previz)`）。

zh：

```json
"timeline": { …已有 key…,
  "cutHere": "切到此机位",
  "live": "直播"
},
"program": {
  "title": "镜头轨",
  "cutTo": "切到…",
  "empty": "按 1–9 或在机位轨表头点「切到此机位」",
  "noRoom": "时间轴末尾没有空间",
  "limit": "镜头轨最多 60 段"
},
"audio": {
  "title": "音频轨",
  "add": "添加音频",
  "local": "本地文件…",
  "upstream": "上游音频",
  "noUpstream": "把音频节点连到预演台即可在此选择",
  "uploading": "上传中",
  "badExtension": "只支持 mp3 / wav / m4a / ogg",
  "tooLarge": "音频文件不能超过 20 MB",
  "noRoom": "此处没有空位",
  "limit": "音频轨最多 20 段",
  "uploadFailed": "音频上传失败：{{message}}"
},
"clip": { …已有 key…,
  "cut": { "camera": "机位" },
  "audio": { "source": "素材", "offset": "素材偏移（毫秒）", "relocate": "重新定位到播放头" }
}
```

`previz.monitor` 追加 `"follow": "跟随镜头轨", "following": "跟随中"`；`previz.editor.record` 追加 `"noAudioMix": "本浏览器无法混音，已录制无声视频"`；`previz.node` 追加 `"audioSummary": "已接入音频 {{count}} 段"`。

en：

```json
"timeline": { …,
  "cutHere": "Cut to this camera",
  "live": "LIVE"
},
"program": {
  "title": "Program",
  "cutTo": "Cut to…",
  "empty": "Press 1–9 or use “Cut to this camera” on a camera track",
  "noRoom": "No room at the end of the timeline",
  "limit": "The program track holds at most 60 cuts"
},
"audio": {
  "title": "Audio",
  "add": "Add audio",
  "local": "Local file…",
  "upstream": "Upstream audio",
  "noUpstream": "Connect an audio node to the previz node to pick it here",
  "uploading": "Uploading",
  "badExtension": "Only mp3 / wav / m4a / ogg files are supported",
  "tooLarge": "Audio files must be 20 MB or smaller",
  "noRoom": "No room at the playhead",
  "limit": "The audio track holds at most 20 clips",
  "uploadFailed": "Audio upload failed: {{message}}"
},
"clip": { …,
  "cut": { "camera": "Camera" },
  "audio": { "source": "Source", "offset": "Offset (ms)", "relocate": "Move to playhead" }
}
```

`previz.monitor`: `"follow": "Follow program", "following": "Following"`；`previz.editor.record`: `"noAudioMix": "This browser cannot mix audio; recorded without sound"`；`previz.node`: `"audioSummary": "{{count}} audio clips attached"`。

- [ ] **Step 4: 跑测试**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/i18n/previz-locale.test.ts && node -e "JSON.parse(require('fs').readFileSync('public/locales/zh/translation.json','utf8'));JSON.parse(require('fs').readFileSync('public/locales/en/translation.json','utf8'));console.log('json ok')"`
Expected: PASS；打印 `json ok`。

- [ ] **Step 5: 提交**

```bash
cd /Users/like/code/dramaclaw && git add -p frontend/public/locales/zh/translation.json frontend/public/locales/en/translation.json frontend/src/__tests__/i18n/previz-locale.test.ts && git commit -s -m "feat(previz): add program and audio track strings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

（这三个文件在工作区里已有视口相关的未提交改动，`-p` 只挑本任务的 hunk。）

---

### Task 10: `ClipBar` 导出（`tone` / `label` / `children`）与机位轨表头的切镜按钮、直播徽章

**Files:**
- Modify: `src/features/previz/ui/PrevizTimelineTrack.tsx`
- Test: `src/__tests__/features/previz/previz-timeline-track.test.tsx`

- [ ] **Step 1: 写失败的测试**

```tsx
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { PrevizCutClip, PrevizTrack } from '@/features/previz/domain/scene';
import { ClipBar, PrevizTimelineTrack } from '@/features/previz/ui/PrevizTimelineTrack';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const cut: PrevizCutClip = { id: 'c1', kind: 'cut', startFrame: 10, endFrame: 40, cameraId: 'cam' };

function trackProps(overrides: Partial<Parameters<typeof PrevizTimelineTrack>[0]> = {}) {
  const track: PrevizTrack = { id: 't1', objectId: 'cam', clips: [] };
  return {
    track,
    name: '机位 1',
    kind: 'camera' as const,
    pxPerFrame: 2,
    laneWidthPx: 400,
    frame: 0,
    expanded: false,
    selectedClipId: null,
    selectedPointId: null,
    onToggleExpand: vi.fn(),
    onSelectClip: vi.fn(),
    onSelectPoint: vi.fn(),
    onTrimClip: vi.fn(),
    onSplit: vi.fn(),
    onAppend: vi.fn(),
    onPin: vi.fn(),
    onRemove: vi.fn(),
    onInsertKeyframe: vi.fn(),
    onClearPath: vi.fn(),
    onSeek: vi.fn(),
    closeupTargets: [],
    onAddCloseup: vi.fn(),
    ...overrides,
  };
}

describe('ClipBar', () => {
  it('shows the given label instead of the frame range and paints the tone', () => {
    render(
      <ClipBar clip={cut} pxPerFrame={2} selected={false} onSelect={vi.fn()} onTrim={vi.fn()} label="机位 1" tone="cut" />,
    );
    const bar = screen.getByTestId('previz-clip-c1');
    expect(bar).toHaveTextContent('机位 1');
    expect(bar).not.toHaveTextContent('previz.timeline.clipLabel');
    expect(bar.className).toContain('bg-[#b8801f]');
    expect(bar).toHaveStyle({ left: '20px', width: '60px' });
  });

  it('renders children under the label', () => {
    render(
      <ClipBar clip={cut} pxPerFrame={2} selected onSelect={vi.fn()} onTrim={vi.fn()} tone="audio">
        <span data-testid="wave" />
      </ClipBar>,
    );
    expect(screen.getByTestId('wave')).toBeInTheDocument();
    expect(screen.getByTestId('previz-clip-c1').className).toContain('bg-[#37b39c]');
  });
});

describe('PrevizTimelineTrack camera header', () => {
  it('offers a cut button on camera tracks only', async () => {
    const user = userEvent.setup();
    const onCut = vi.fn();
    render(<ul><PrevizTimelineTrack {...trackProps({ onCut })} /></ul>);
    await user.click(screen.getByRole('button', { name: 'previz.timeline.cutHere' }));
    expect(onCut).toHaveBeenCalledTimes(1);
  });

  it('hides the cut button on other kinds', () => {
    render(<ul><PrevizTimelineTrack {...trackProps({ kind: 'character', onCut: vi.fn() })} /></ul>);
    expect(screen.queryByRole('button', { name: 'previz.timeline.cutHere' })).toBeNull();
  });

  it('shows the live badge when told to', () => {
    const { rerender } = render(<ul><PrevizTimelineTrack {...trackProps({ live: true })} /></ul>);
    expect(screen.getByTestId('previz-track-live')).toHaveTextContent('previz.timeline.live');
    rerender(<ul><PrevizTimelineTrack {...trackProps({ live: false })} /></ul>);
    expect(screen.queryByTestId('previz-track-live')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-timeline-track.test.tsx`
Expected: FAIL，`ClipBar` 未导出。

- [ ] **Step 3: 改 `PrevizTimelineTrack.tsx`**

(a) import：`react` 的 import 补 `type ReactNode`；`lucide-react` 补 `SwitchCamera`。

(b) `PrevizTimelineTrackProps` 末尾加两个可选 prop：

```ts
  /** 机位轨才有：把播放头处切到这台机位。 */
  onCut?: () => void;
  /** 镜头轨此刻正播这台机位；表头亮「直播」。 */
  live?: boolean;
```

函数参数解构里加 `onCut, live = false`。

(c) 表头里名字 `<span className="min-w-0 flex-1 truncate text-xs text-[#c7cedb]">{name}</span>` 之后、`{kind === 'camera' && (` 之前插入：

```tsx
          {live && (
            <span
              data-testid="previz-track-live"
              className="rounded-sm bg-[#ff4d4f] px-1 text-[9px] font-semibold uppercase leading-4 text-white"
            >
              {t('previz.timeline.live')}
            </span>
          )}
          {kind === 'camera' && onCut && (
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={t('previz.timeline.cutHere')}
              title={t('previz.timeline.cutHere')}
              onClick={onCut}
            >
              <SwitchCamera className="h-3.5 w-3.5" />
            </button>
          )}
```

(d) `ClipBar` 改成导出，签名与色板：

```tsx
/** 片段条的配色：对象轨道两种（蓝=轨迹、紫=特写），固定行两种（橙=切片、青=音频）。 */
const TONE_CLASS = {
  path: { idle: 'bg-[#3560ba]', selected: 'bg-[#4a7de0] ring-1 ring-[#a8c4ff]' },
  closeup: { idle: 'bg-[#6c43ae]', selected: 'bg-[#8a5cd6] ring-1 ring-[#d5bcff]' },
  cut: { idle: 'bg-[#b8801f]', selected: 'bg-[#d69a24] ring-1 ring-[#ffd27a]' },
  audio: { idle: 'bg-[#2a8c7a]', selected: 'bg-[#37b39c] ring-1 ring-[#9ff0dc]' },
} as const;

export type ClipBarTone = keyof typeof TONE_CLASS;

export function ClipBar({
  clip,
  pxPerFrame,
  selected,
  onSelect,
  onTrim,
  label,
  tone,
  children,
}: {
  clip: PrevizClip;
  pxPerFrame: number;
  selected: boolean;
  onSelect: () => void;
  onTrim: (edge: 'start' | 'end', frame: number) => void;
  /** 不给就按帧区间写「片段 a~b」/「特写 a~b」。 */
  label?: string;
  /** 不给就按片段种类：特写紫、其它蓝。 */
  tone?: ClipBarTone;
  /** 画在标签底下的内容（音频波形）。 */
  children?: ReactNode;
}) {
```

函数体里原来的 `const closeup = isRigClip(clip);` 之后加 `const paint = TONE_CLASS[tone ?? (closeup ? 'closeup' : 'path')];`，根元素的 className 模板里把 `${closeup ? (selected ? … : …) : (selected ? … : …)}` 那段换成 `${selected ? paint.selected : paint.idle}`。根元素的第一个子节点（起点滑块之前）插入 `{children}`，标签 span 的内容改成：

```tsx
            {label ?? t(closeup ? 'previz.timeline.closeupLabel' : 'previz.timeline.clipLabel', { start: clip.startFrame, end: clip.endFrame })}
```

（原来的 `{ start, end }` 若是局部变量名，沿用。）

- [ ] **Step 4: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-timeline-track.test.tsx src/__tests__/features/previz/previz-timeline.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS；tsc 退出码 0。

- [ ] **Step 5: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/features/previz/ui/PrevizTimelineTrack.tsx frontend/src/__tests__/features/previz/previz-timeline-track.test.tsx && git commit -s -m "feat(previz): reuse the clip bar for fixed rows and add the camera cut button

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---

### Task 11: `useCutToCamera` 与 `PrevizProgramTrack`

**Files:**
- Create: `src/features/previz/ui/useCutToCamera.ts`
- Create: `src/features/previz/ui/PrevizProgramTrack.tsx`
- Test: `src/__tests__/features/previz/previz-program-track.test.tsx`

- [ ] **Step 1: 写失败的测试**

```tsx
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { PREVIZ_MAX_CUTS } from '@/features/previz/domain/program';
import { createPrevizObject } from '@/features/previz/domain/objects';
import { createDefaultScene, type PrevizCutClip, type PrevizScene } from '@/features/previz/domain/scene';
import { usePrevizStore } from '@/features/previz/store';
import { PrevizProgramTrack } from '@/features/previz/ui/PrevizProgramTrack';
import { useCutToCamera } from '@/features/previz/ui/useCutToCamera';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

function sceneWithCameras(program: PrevizCutClip[] = []): { scene: PrevizScene; camA: string; camB: string } {
  const base = createDefaultScene();
  const camA = createPrevizObject('camera', base.objects);
  const camB = createPrevizObject('camera', [camA]);
  return {
    scene: { ...base, objects: [camA, camB], timeline: { ...base.timeline, program } },
    camA: camA.id,
    camB: camB.id,
  };
}

function trackProps(scene: PrevizScene, overrides: Partial<Parameters<typeof PrevizProgramTrack>[0]> = {}) {
  return {
    scene,
    pxPerFrame: 2,
    laneWidthPx: 400,
    selectedClipId: null,
    onSelect: vi.fn(),
    onTrim: vi.fn(),
    onCut: vi.fn(),
    ...overrides,
  };
}

describe('PrevizProgramTrack', () => {
  it('lists the cuts with their camera names', () => {
    const { scene, camA, camB } = sceneWithCameras();
    const program: PrevizCutClip[] = [
      { id: 'c1', kind: 'cut', startFrame: 0, endFrame: 30, cameraId: camA },
      { id: 'c2', kind: 'cut', startFrame: 30, endFrame: 60, cameraId: camB },
    ];
    render(<PrevizProgramTrack {...trackProps({ ...scene, timeline: { ...scene.timeline, program } })} />);
    expect(screen.getByTestId('previz-program-track')).toBeInTheDocument();
    expect(screen.getByTestId('previz-clip-c1')).toHaveTextContent(scene.objects[0]!.name);
    expect(screen.getByTestId('previz-clip-c2')).toHaveTextContent(scene.objects[1]!.name);
    expect(screen.queryByText('previz.program.empty')).toBeNull();
  });

  it('shows the hint when the program is empty', () => {
    const { scene } = sceneWithCameras();
    render(<PrevizProgramTrack {...trackProps(scene)} />);
    expect(screen.getByText('previz.program.empty')).toBeInTheDocument();
  });

  it('cuts to the camera picked from the header dropdown', async () => {
    const user = userEvent.setup();
    const { scene, camB } = sceneWithCameras();
    const onCut = vi.fn();
    render(<PrevizProgramTrack {...trackProps(scene, { onCut })} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'previz.program.cutTo' }), camB);
    expect(onCut).toHaveBeenCalledWith(camB);
  });

  it('disables the dropdown without cameras and at the cut limit', () => {
    const { rerender } = render(<PrevizProgramTrack {...trackProps(createDefaultScene())} />);
    expect(screen.getByRole('combobox', { name: 'previz.program.cutTo' })).toBeDisabled();
    const { scene, camA } = sceneWithCameras();
    const program = Array.from({ length: PREVIZ_MAX_CUTS }, (_, i) => ({
      id: `c${i}`,
      kind: 'cut' as const,
      startFrame: i,
      endFrame: i + 1,
      cameraId: camA,
    }));
    rerender(<PrevizProgramTrack {...trackProps({ ...scene, timeline: { ...scene.timeline, program } })} />);
    expect(screen.getByRole('combobox', { name: 'previz.program.cutTo' })).toBeDisabled();
  });

  it('selects and trims through the callbacks', async () => {
    const user = userEvent.setup();
    const { scene, camA } = sceneWithCameras([
      { id: 'c1', kind: 'cut', startFrame: 0, endFrame: 30, cameraId: camA },
    ]);
    const onSelect = vi.fn();
    const onTrim = vi.fn();
    render(<PrevizProgramTrack {...trackProps(scene, { onSelect, onTrim })} />);
    await user.click(screen.getByTestId('previz-clip-c1'));
    expect(onSelect).toHaveBeenCalledWith('c1');
    const endHandle = screen.getByRole('slider', { name: 'previz.timeline.trimEnd' });
    endHandle.focus();
    await user.keyboard('{ArrowRight}');
    expect(onTrim).toHaveBeenCalledWith('c1', 'end', 31);
  });
});

describe('useCutToCamera', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  it('inserts a cut through the store', () => {
    const cam = usePrevizStore.getState().addObject('camera')!;
    const { result } = renderHook(() => useCutToCamera());
    result.current(cam);
    expect(usePrevizStore.getState().scene.timeline.program).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts when there is no room at the end', () => {
    const cam = usePrevizStore.getState().addObject('camera')!;
    usePrevizStore.getState().setTimelineFrame(usePrevizStore.getState().scene.settings.durationFrames);
    const { result } = renderHook(() => useCutToCamera());
    result.current(cam);
    expect(toast.error).toHaveBeenCalledWith('previz.program.noRoom');
  });

  it('stays quiet when the same camera is already live', () => {
    const cam = usePrevizStore.getState().addObject('camera')!;
    const { result } = renderHook(() => useCutToCamera());
    result.current(cam);
    result.current(cam);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
```

`ClipBar` 的末端滑块按 ArrowRight 时调用 `onTrim('end', clip.endFrame + 1)`——若既有实现的步长不是 1（看 `PrevizTimelineTrack.tsx` 里滑块的 `onKeyDown`），把 `31` 改成对应的值。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-program-track.test.tsx`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 `useCutToCamera.ts`**

```ts
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { usePrevizStore } from '../store';

/**
 * 三个切镜入口（镜头轨下拉、机位轨表头按钮、数字键）共用的一层：调 store，
 * 把「没空间」「到上限」翻成 toast。同机位与非机位静默——连按两下 1 不该弹窗。
 */
export function useCutToCamera(): (cameraId: string) => void {
  const { t } = useTranslation();
  const cutToCamera = usePrevizStore((state) => state.cutToCamera);
  return useCallback(
    (cameraId: string) => {
      const rejection = cutToCamera(cameraId);
      if (rejection === 'no-room') toast.error(t('previz.program.noRoom'));
      else if (rejection === 'limit') toast.error(t('previz.program.limit'));
    },
    [cutToCamera, t],
  );
}
```

- [ ] **Step 4: 实现 `PrevizProgramTrack.tsx`**

```tsx
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { SwitchCamera } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PREVIZ_MAX_CUTS } from '../domain/program';
import type { PrevizScene } from '../domain/scene';
import { ClipBar, PREVIZ_TRACK_HEADER_PX } from './PrevizTimelineTrack';

export interface PrevizProgramTrackProps {
  scene: PrevizScene;
  pxPerFrame: number;
  laneWidthPx: number;
  selectedClipId: string | null;
  onSelect: (clipId: string) => void;
  onTrim: (clipId: string, edge: 'start' | 'end', frame: number) => void;
  onCut: (cameraId: string) => void;
}

/**
 * 镜头轨：一条固定行，摆在对象轨道上面。表头的下拉是切镜的第一个入口，
 * 选中即在播放头处切；下拉本身不保持选中值，每次都从「切到…」开始。
 */
export function PrevizProgramTrack({
  scene,
  pxPerFrame,
  laneWidthPx,
  selectedClipId,
  onSelect,
  onTrim,
  onCut,
}: PrevizProgramTrackProps) {
  const { t } = useTranslation();
  const cameras = scene.objects.filter((object) => object.kind === 'camera');
  const nameOf = (cameraId: string) =>
    cameras.find((camera) => camera.id === cameraId)?.name ?? cameraId;
  const program = scene.timeline.program;
  const full = program.length >= PREVIZ_MAX_CUTS;

  return (
    <div
      data-testid="previz-program-track"
      aria-label={t('previz.program.title')}
      className="flex h-8 items-stretch border-b border-[#1c202a]"
    >
      <div
        className="sticky left-0 z-30 flex shrink-0 items-center gap-1 bg-[#15181f] pl-2 pr-2"
        style={{ width: PREVIZ_TRACK_HEADER_PX }}
      >
        <SwitchCamera className="h-3.5 w-3.5 shrink-0 text-[#d69a24]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[#c7cedb]">{t('previz.program.title')}</span>
        <select
          aria-label={t('previz.program.cutTo')}
          title={full ? t('previz.program.limit') : undefined}
          value=""
          disabled={cameras.length === 0 || full}
          className="h-6 max-w-[104px] rounded border border-white/10 bg-white/[0.04] px-1 text-[11px] text-white/80 outline-none focus:border-white/25 disabled:opacity-40"
          onChange={(event) => {
            if (event.target.value) onCut(event.target.value);
          }}
        >
          <option value="">{t('previz.program.cutTo')}</option>
          {cameras.map((camera) => (
            <option key={camera.id} value={camera.id}>
              {camera.name}
            </option>
          ))}
        </select>
      </div>

      <div className="relative shrink-0" style={{ width: laneWidthPx }}>
        {program.length === 0 && (
          <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[11px] text-white/30">
            {t('previz.program.empty')}
          </span>
        )}
        {program.map((cut) => (
          <ClipBar
            key={cut.id}
            clip={cut}
            pxPerFrame={pxPerFrame}
            selected={cut.id === selectedClipId}
            onSelect={() => onSelect(cut.id)}
            onTrim={(edge, frame) => onTrim(cut.id, edge, frame)}
            label={nameOf(cut.cameraId)}
            tone="cut"
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-program-track.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS（8 个）；tsc 退出码 0。

- [ ] **Step 6: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/features/previz/ui/useCutToCamera.ts frontend/src/features/previz/ui/PrevizProgramTrack.tsx frontend/src/__tests__/features/previz/previz-program-track.test.tsx && git commit -s -m "feat(previz): render the program track with a cut-to dropdown

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---

### Task 12: `uploadFreezoneAudio` 与 `useAudioImport`

**Files:**
- Modify: `src/api/ops.ts:2465`
- Create: `src/features/previz/ui/useAudioImport.ts`
- Test: `src/__tests__/features/previz/use-audio-import.test.tsx`

- [ ] **Step 1: 写失败的测试**

```tsx
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

import { createDefaultScene } from '@/features/previz/domain/scene';
import { usePrevizStore } from '@/features/previz/store';
import { useAudioImport } from '@/features/previz/ui/useAudioImport';

const uploadFreezoneAudio = vi.fn(async () => ({ url: '/static/take.mp3' }));
const probeAudioDuration = vi.fn(async () => 2000);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'message' in options ? `${key}:${options.message}` : key,
  }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/url-params', () => ({ readUrl: vi.fn(() => ({ project: 'demo' })) }));
vi.mock('@/api/ops', () => ({
  uploadFreezoneAudio: (...args: unknown[]) => uploadFreezoneAudio(...(args as [])),
}));
vi.mock('@/features/previz/engine/audioProbe', () => ({
  probeAudioDuration: (...args: unknown[]) => probeAudioDuration(...(args as [])),
}));

function file(name: string, bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type: 'audio/mpeg' });
}

beforeEach(() => {
  vi.clearAllMocks();
  usePrevizStore.getState().loadScene(createDefaultScene());
});

describe('useAudioImport local file', () => {
  it('rejects unsupported extensions and oversized files before uploading', async () => {
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('a.flac')));
    expect(toast.error).toHaveBeenCalledWith('previz.audio.badExtension');
    await act(() => result.current.addFile(file('a.mp3', 21 * 1024 * 1024)));
    expect(toast.error).toHaveBeenCalledWith('previz.audio.tooLarge');
    expect(uploadFreezoneAudio).not.toHaveBeenCalled();
  });

  it('shows a placeholder at the playhead, then places the clip where the playhead was', async () => {
    usePrevizStore.getState().setTimelineFrame(20);
    let release: (() => void) | undefined;
    uploadFreezoneAudio.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ url: '/static/take.mp3' });
        }),
    );
    const { result } = renderHook(() => useAudioImport('previz-1'));
    let done: Promise<void> | undefined;
    act(() => {
      done = result.current.addFile(file('take.mp3'));
    });
    await waitFor(() => expect(result.current.pending).toEqual({ startFrame: 20, endFrame: 50, name: 'take.mp3' }));
    expect(uploadFreezoneAudio).toHaveBeenCalledWith('demo', expect.any(File), 'previz-audio-previz-1-1.mp3');

    // 上传期间播放头挪走了，片段仍落在点「添加」时的位置。
    act(() => usePrevizStore.getState().setTimelineFrame(90));
    release?.();
    await act(async () => {
      await done;
    });

    expect(result.current.pending).toBeNull();
    expect(usePrevizStore.getState().scene.timeline.audio).toMatchObject([
      { startFrame: 20, endFrame: 80, audioUrl: '/static/take.mp3', sourceName: 'take.mp3', durationMs: 2000, sourceNodeId: null },
    ]);
  });

  it('drops the placeholder and toasts the backend message when the upload fails', async () => {
    uploadFreezoneAudio.mockRejectedValueOnce(new Error('413 too large'));
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('take.mp3')));
    expect(result.current.pending).toBeNull();
    expect(usePrevizStore.getState().scene.timeline.audio).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith('previz.audio.uploadFailed:413 too large');
  });

  it('treats a probe failure like an upload failure', async () => {
    probeAudioDuration.mockRejectedValueOnce(new Error('audio metadata failed'));
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('take.mp3')));
    expect(usePrevizStore.getState().scene.timeline.audio).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith('previz.audio.uploadFailed:audio metadata failed');
  });

  it('toasts when the store has no room', async () => {
    usePrevizStore.getState().addAudioClip(
      { audioUrl: '/static/x.mp3', sourceName: 'x', durationMs: 4000, sourceNodeId: null },
      0,
    );
    usePrevizStore.getState().setTimelineFrame(30);
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() => result.current.addFile(file('take.mp3')));
    expect(toast.error).toHaveBeenCalledWith('previz.audio.noRoom');
  });
});

describe('useAudioImport upstream node', () => {
  it('places the clip without probing when the node knows its duration', async () => {
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() =>
      result.current.addUpstream({ nodeId: 'audio-1', displayName: '旁白', audioUrl: '/static/vo.mp3', durationMs: 3000 }),
    );
    expect(probeAudioDuration).not.toHaveBeenCalled();
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({
      sourceName: '旁白',
      audioUrl: '/static/vo.mp3',
      durationMs: 3000,
      sourceNodeId: 'audio-1',
      endFrame: 90,
    });
  });

  it('probes the url when the node has no duration', async () => {
    const { result } = renderHook(() => useAudioImport('previz-1'));
    await act(() =>
      result.current.addUpstream({ nodeId: 'audio-1', displayName: '旁白', audioUrl: '/static/vo.mp3', durationMs: null }),
    );
    expect(probeAudioDuration).toHaveBeenCalledWith('/static/vo.mp3');
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({ durationMs: 2000, endFrame: 60 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/use-audio-import.test.tsx`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 加 `uploadFreezoneAudio`**

`src/api/ops.ts` 里 `uploadFreezoneVideo` 之后：

```ts
/** 与图片、视频同一个端点——后端把上传当通用 blob 存，扩展名由文件名带过去。 */
export async function uploadFreezoneAudio(
  project: string,
  file: File | Blob,
  filename?: string,
): Promise<FreezoneUploadResult> {
  return await uploadFreezoneImage(project, file, filename);
}
```

- [ ] **Step 4: 实现 `useAudioImport.ts`**

```ts
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { uploadFreezoneAudio } from '@/api/ops';
import { readUrl } from '@/lib/url-params';

import {
  audioFileExtension,
  isAcceptedAudioFile,
  type PrevizAudioSource,
} from '../domain/audioTrack';
import { PREVIZ_FPS } from '../domain/scene';
import { probeAudioDuration } from '../engine/audioProbe';
import { usePrevizStore } from '../store';

/** 上游音频节点里能拿来用的信息，由 PrevizNode 从画布算好传进编辑器。 */
export interface PrevizUpstreamAudio {
  nodeId: string;
  displayName: string;
  audioUrl: string;
  /** 节点没记时长时为 null，选中时再用 `<audio>` 探一次。 */
  durationMs: number | null;
}

/** 上传/探测期间挂在音频轨上的占位条，不进场景。 */
export interface PendingAudioClip {
  startFrame: number;
  endFrame: number;
  name: string;
}

export interface AudioImport {
  pending: PendingAudioClip | null;
  addFile: (file: File) => Promise<void>;
  addUpstream: (source: PrevizUpstreamAudio) => Promise<void>;
}

/**
 * 「添加音频」两条路的共同部分：记下点击那一刻的播放头（上传要几秒，播放头
 * 可能已经被拖走），挂占位条，拿到时长与 url 后交给 store 放片段。
 */
export function useAudioImport(nodeId: string): AudioImport {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingAudioClip | null>(null);
  /** 同一节点连传几个文件时文件名不撞。 */
  const seq = useRef(0);

  const place = useCallback(
    (source: PrevizAudioSource, frame: number) => {
      const rejection = usePrevizStore.getState().addAudioClip(source, frame);
      if (rejection === 'no-room') toast.error(t('previz.audio.noRoom'));
      else if (rejection === 'limit') toast.error(t('previz.audio.limit'));
    },
    [t],
  );

  const showPending = useCallback((name: string, frame: number) => {
    const { durationFrames } = usePrevizStore.getState().scene.settings;
    // 时长未知，先占一秒宽，让人看见轨道上有东西在来。
    setPending({ startFrame: frame, endFrame: Math.min(frame + PREVIZ_FPS, durationFrames), name });
  }, []);

  const failed = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('previz.audio.uploadFailed', { message }));
    },
    [t],
  );

  const addFile = useCallback(
    async (file: File) => {
      const verdict = isAcceptedAudioFile(file.name, file.size);
      if (verdict === 'extension') {
        toast.error(t('previz.audio.badExtension'));
        return;
      }
      if (verdict === 'size') {
        toast.error(t('previz.audio.tooLarge'));
        return;
      }
      const project = readUrl().project;
      if (!project) {
        toast.error(t('previz.editor.noProject'));
        return;
      }
      const frame = usePrevizStore.getState().timelineFrame;
      showPending(file.name, frame);
      try {
        seq.current += 1;
        const filename = `previz-audio-${nodeId}-${seq.current}.${audioFileExtension(file.name)}`;
        const [durationMs, upload] = await Promise.all([
          probeAudioDuration(file),
          uploadFreezoneAudio(project, file, filename),
        ]);
        place({ audioUrl: upload.url, sourceName: file.name, durationMs, sourceNodeId: null }, frame);
      } catch (error) {
        failed(error);
      } finally {
        setPending(null);
      }
    },
    [failed, nodeId, place, showPending, t],
  );

  const addUpstream = useCallback(
    async (source: PrevizUpstreamAudio) => {
      const frame = usePrevizStore.getState().timelineFrame;
      const base = { audioUrl: source.audioUrl, sourceName: source.displayName, sourceNodeId: source.nodeId };
      if (source.durationMs !== null && source.durationMs > 0) {
        place({ ...base, durationMs: source.durationMs }, frame);
        return;
      }
      showPending(source.displayName, frame);
      try {
        const durationMs = await probeAudioDuration(source.audioUrl);
        place({ ...base, durationMs }, frame);
      } catch (error) {
        failed(error);
      } finally {
        setPending(null);
      }
    },
    [failed, place, showPending],
  );

  return { pending, addFile, addUpstream };
}
```

- [ ] **Step 5: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/use-audio-import.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS（7 个）；tsc 退出码 0。

- [ ] **Step 6: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/api/ops.ts frontend/src/features/previz/ui/useAudioImport.ts frontend/src/__tests__/features/previz/use-audio-import.test.tsx && git commit -s -m "feat(previz): import audio from a local file or an upstream node

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---

### Task 13: `PrevizAudioTrack` 与波形

**Files:**
- Create: `src/features/previz/ui/PrevizAudioTrack.tsx`
- Test: `src/__tests__/features/previz/previz-audio-track.test.tsx`

- [ ] **Step 1: 写失败的测试**

```tsx
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PREVIZ_MAX_AUDIO_CLIPS } from '@/features/previz/domain/audioTrack';
import { createDefaultScene, type PrevizAudioClip, type PrevizScene } from '@/features/previz/domain/scene';
import { PrevizAudioTrack } from '@/features/previz/ui/PrevizAudioTrack';

const loadAudioPeaks = vi.fn(async (_src: string) => new Float32Array(240).fill(0.5));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/features/canvas/compose/audioPeaks', () => ({
  PEAK_BUCKETS_PER_SEC: 120,
  loadAudioPeaks: (src: string) => loadAudioPeaks(src),
}));

function audio(id: string, startFrame: number, endFrame: number): PrevizAudioClip {
  return {
    id,
    kind: 'audio',
    startFrame,
    endFrame,
    audioUrl: `/static/${id}.mp3`,
    sourceName: `${id}.mp3`,
    durationMs: 4000,
    offsetMs: 0,
    sourceNodeId: null,
  };
}

function sceneWith(clips: PrevizAudioClip[]): PrevizScene {
  const base = createDefaultScene();
  return { ...base, timeline: { ...base.timeline, audio: clips } };
}

function props(scene: PrevizScene, overrides: Partial<Parameters<typeof PrevizAudioTrack>[0]> = {}) {
  return {
    scene,
    pxPerFrame: 2,
    laneWidthPx: 400,
    selectedClipId: null,
    onSelect: vi.fn(),
    onTrim: vi.fn(),
    upstreamAudio: [],
    pending: null,
    onAddFile: vi.fn(),
    onAddUpstream: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom 没有 canvas 2D 上下文；波形绘制得能在 getContext 返回 null 时安静跳过。
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

describe('PrevizAudioTrack', () => {
  it('draws each clip with its source name and a waveform', async () => {
    render(<PrevizAudioTrack {...props(sceneWith([audio('a', 0, 60)]))} />);
    expect(screen.getByTestId('previz-audio-track')).toBeInTheDocument();
    expect(screen.getByTestId('previz-clip-a')).toHaveTextContent('a.mp3');
    const wave = screen.getByTestId('previz-audio-wave-a');
    expect(wave).toHaveAttribute('data-state', 'loading');
    await waitFor(() => expect(wave).toHaveAttribute('data-state', 'ready'));
    expect(loadAudioPeaks).toHaveBeenCalledWith('/static/a.mp3');
  });

  it('marks the waveform failed when the peaks cannot be loaded', async () => {
    loadAudioPeaks.mockRejectedValueOnce(new Error('decode'));
    render(<PrevizAudioTrack {...props(sceneWith([audio('a', 0, 60)]))} />);
    await waitFor(() => expect(screen.getByTestId('previz-audio-wave-a')).toHaveAttribute('data-state', 'failed'));
  });

  it('opens the add menu with a local file entry and the upstream hint', async () => {
    const user = userEvent.setup();
    render(<PrevizAudioTrack {...props(sceneWith([]))} />);
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    expect(screen.getByRole('menuitem', { name: 'previz.audio.local' })).toBeInTheDocument();
    expect(screen.getByText('previz.audio.noUpstream')).toBeInTheDocument();
  });

  it('lists upstream nodes and hands the picked one back', async () => {
    const user = userEvent.setup();
    const onAddUpstream = vi.fn();
    const upstream = { nodeId: 'audio-1', displayName: '旁白', audioUrl: '/static/vo.mp3', durationMs: 3000 };
    render(<PrevizAudioTrack {...props(sceneWith([]), { upstreamAudio: [upstream], onAddUpstream })} />);
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    await user.click(screen.getByRole('menuitem', { name: '旁白' }));
    expect(onAddUpstream).toHaveBeenCalledWith(upstream);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('forwards a chosen local file', async () => {
    const user = userEvent.setup();
    const onAddFile = vi.fn();
    render(<PrevizAudioTrack {...props(sceneWith([]), { onAddFile })} />);
    await user.click(screen.getByRole('button', { name: 'previz.audio.add' }));
    await user.click(screen.getByRole('menuitem', { name: 'previz.audio.local' }));
    const file = new File(['x'], 'take.mp3', { type: 'audio/mpeg' });
    await user.upload(screen.getByTestId('previz-audio-file'), file);
    expect(onAddFile).toHaveBeenCalledWith(file);
  });

  it('disables the add button at the clip limit', () => {
    const clips = Array.from({ length: PREVIZ_MAX_AUDIO_CLIPS }, (_, i) => audio(`a${i}`, i, i + 1));
    render(<PrevizAudioTrack {...props(sceneWith(clips))} />);
    expect(screen.getByRole('button', { name: 'previz.audio.add' })).toBeDisabled();
  });

  it('shows the pending placeholder while an upload is running', () => {
    render(
      <PrevizAudioTrack
        {...props(sceneWith([]), { pending: { startFrame: 10, endFrame: 40, name: 'take.mp3' } })}
      />,
    );
    const placeholder = screen.getByTestId('previz-audio-pending');
    expect(placeholder).toHaveTextContent('previz.audio.uploading');
    expect(placeholder).toHaveStyle({ left: '20px', width: '60px' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-audio-track.test.tsx`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 `PrevizAudioTrack.tsx`**

```tsx
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { AudioLines, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { loadAudioPeaks, PEAK_BUCKETS_PER_SEC } from '@/features/canvas/compose/audioPeaks';

import { PREVIZ_MAX_AUDIO_CLIPS, framesToMs } from '../domain/audioTrack';
import type { PrevizScene } from '../domain/scene';
import { ClipBar, PREVIZ_TRACK_HEADER_PX } from './PrevizTimelineTrack';
import type { PendingAudioClip, PrevizUpstreamAudio } from './useAudioImport';

export interface PrevizAudioTrackProps {
  scene: PrevizScene;
  pxPerFrame: number;
  laneWidthPx: number;
  selectedClipId: string | null;
  onSelect: (clipId: string) => void;
  onTrim: (clipId: string, edge: 'start' | 'end', frame: number) => void;
  upstreamAudio: readonly PrevizUpstreamAudio[];
  pending: PendingAudioClip | null;
  onAddFile: (file: File) => void;
  onAddUpstream: (source: PrevizUpstreamAudio) => void;
}

const ICON_BUTTON =
  'flex h-6 w-6 items-center justify-center rounded text-[#8b93a5] hover:bg-[#2a2f3a] hover:text-white disabled:opacity-40 disabled:hover:bg-transparent';
const MENU_ITEM = 'px-2 py-1 text-left text-xs text-[#c7cedb] hover:bg-[#2a2f3a]';

/** 音频轨：固定一行，挂在对象轨道下面。 */
export function PrevizAudioTrack({
  scene,
  pxPerFrame,
  laneWidthPx,
  selectedClipId,
  onSelect,
  onTrim,
  upstreamAudio,
  pending,
  onAddFile,
  onAddUpstream,
}: PrevizAudioTrackProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const clips = scene.timeline.audio;
  const full = clips.length >= PREVIZ_MAX_AUDIO_CLIPS;
  const fps = scene.settings.fps;

  return (
    <div
      data-testid="previz-audio-track"
      aria-label={t('previz.audio.title')}
      className="flex h-8 items-stretch border-b border-[#1c202a]"
    >
      <div
        className="sticky left-0 z-30 flex shrink-0 items-center gap-1 bg-[#15181f] pl-2 pr-2"
        style={{ width: PREVIZ_TRACK_HEADER_PX }}
      >
        {menuOpen && (
          <div
            role="menu"
            aria-label={t('previz.audio.add')}
            className="absolute left-6 top-7 z-40 flex min-w-44 flex-col rounded border border-[#2f3542] bg-[#1d222b] py-1 shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                setMenuOpen(false);
                fileInput.current?.click();
              }}
            >
              {t('previz.audio.local')}
            </button>
            <span className="px-2 pb-0.5 pt-1 text-[10px] text-[#6d7585]">{t('previz.audio.upstream')}</span>
            {upstreamAudio.length === 0 && (
              <span className="px-2 py-1 text-[11px] text-[#6d7585]">{t('previz.audio.noUpstream')}</span>
            )}
            {upstreamAudio.map((source) => (
              <button
                key={source.nodeId}
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  setMenuOpen(false);
                  onAddUpstream(source);
                }}
              >
                {source.displayName}
              </button>
            ))}
          </div>
        )}
        {/* 隐藏的文件框：菜单项点它，选完立刻清空 value，同一个文件才能再选一次。 */}
        <input
          ref={fileInput}
          type="file"
          accept="audio/*"
          data-testid="previz-audio-file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onAddFile(file);
          }}
        />
        <AudioLines className="h-3.5 w-3.5 shrink-0 text-[#37b39c]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[#c7cedb]">{t('previz.audio.title')}</span>
        <button
          type="button"
          className={ICON_BUTTON}
          aria-label={t('previz.audio.add')}
          title={full ? t('previz.audio.limit') : t('previz.audio.add')}
          disabled={full || pending !== null}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="relative shrink-0" style={{ width: laneWidthPx }}>
        {clips.map((clip) => (
          <ClipBar
            key={clip.id}
            clip={clip}
            pxPerFrame={pxPerFrame}
            selected={clip.id === selectedClipId}
            onSelect={() => onSelect(clip.id)}
            onTrim={(edge, frame) => onTrim(clip.id, edge, frame)}
            label={clip.sourceName}
            tone="audio"
          >
            <AudioWave
              clipId={clip.id}
              audioUrl={clip.audioUrl}
              offsetMs={clip.offsetMs}
              clipMs={framesToMs(clip.endFrame - clip.startFrame, fps)}
            />
          </ClipBar>
        ))}
        {pending && (
          <div
            data-testid="previz-audio-pending"
            className="absolute top-1 flex h-6 items-center overflow-hidden rounded border border-dashed border-white/30 bg-white/5 px-3 text-[11px] text-white/60"
            style={{ left: pending.startFrame * pxPerFrame, width: (pending.endFrame - pending.startFrame) * pxPerFrame }}
          >
            <span className="truncate">
              {t('previz.audio.uploading')} · {pending.name}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

type WaveState = 'loading' | 'ready' | 'failed';

/**
 * 片段底下的波形。峰值按 120 桶/秒缓存在 audioPeaks 里，这里只按片段的
 * 偏移与长度取一段画到 canvas 上。灰=还在读，红=读不出来（多半是解不了码，
 * 播放也会静音）。
 */
function AudioWave({
  clipId,
  audioUrl,
  offsetMs,
  clipMs,
}: {
  clipId: string;
  audioUrl: string;
  offsetMs: number;
  clipMs: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<WaveState>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    loadAudioPeaks(audioUrl)
      .then((peaks) => {
        if (cancelled) return;
        drawPeaks(canvasRef.current, peaks, offsetMs, clipMs);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [audioUrl, offsetMs, clipMs]);

  return (
    <canvas
      ref={canvasRef}
      data-testid={`previz-audio-wave-${clipId}`}
      data-state={state}
      className={`pointer-events-none absolute inset-0 h-full w-full ${
        state === 'failed' ? 'bg-[#8f2f31]/70' : state === 'loading' ? 'bg-white/10' : ''
      }`}
    />
  );
}

function drawPeaks(canvas: HTMLCanvasElement | null, peaks: Float32Array, offsetMs: number, clipMs: number) {
  if (!canvas) return;
  const width = Math.max(1, Math.floor(canvas.clientWidth || canvas.width || 1));
  const height = Math.max(1, Math.floor(canvas.clientHeight || canvas.height || 1));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  const first = Math.floor((offsetMs / 1000) * PEAK_BUCKETS_PER_SEC);
  const count = Math.max(1, Math.floor((clipMs / 1000) * PEAK_BUCKETS_PER_SEC));
  context.clearRect(0, 0, width, height);
  context.fillStyle = 'rgba(255,255,255,0.55)';
  const middle = height / 2;
  for (let x = 0; x < width; x += 1) {
    const bucket = first + Math.floor((x / width) * count);
    const peak = peaks[bucket] ?? 0;
    const bar = Math.max(1, peak * height);
    context.fillRect(x, middle - bar / 2, 1, bar);
  }
}
```

`PEAK_BUCKETS_PER_SEC` 若在 `audioPeaks.ts` 里不是 export（第 12 行是 `export const`，应当是），直接用。

- [ ] **Step 4: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-audio-track.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS（7 个）；tsc 退出码 0。

- [ ] **Step 5: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/features/previz/ui/PrevizAudioTrack.tsx frontend/src/__tests__/features/previz/previz-audio-track.test.tsx && git commit -s -m "feat(previz): render the audio track with waveforms and an add menu

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---
### Task 14: 把镜头轨与音频轨装进 `PrevizTimeline`

**Files:**
- Modify: `src/features/previz/ui/PrevizTimeline.tsx`
- Test: `src/__tests__/features/previz/previz-timeline-fixed-rows.test.tsx`

- [ ] **Step 1: 写失败的测试**

```tsx
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultScene } from '@/features/previz/domain/scene';
import { usePrevizStore } from '@/features/previz/store';
import { PrevizTimeline } from '@/features/previz/ui/PrevizTimeline';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/url-params', () => ({ readUrl: vi.fn(() => ({ project: 'demo' })) }));
vi.mock('@/api/ops', () => ({ uploadFreezoneAudio: vi.fn() }));
vi.mock('@/features/canvas/compose/audioPeaks', () => ({
  PEAK_BUCKETS_PER_SEC: 120,
  loadAudioPeaks: vi.fn(async () => new Float32Array(120)),
}));

function addCameraTrack(): string {
  const cameraId = usePrevizStore.getState().addObject('camera')!;
  usePrevizStore.getState().addObjectToTimeline(cameraId);
  return cameraId;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePrevizStore.getState().loadScene(createDefaultScene());
});

describe('PrevizTimeline fixed rows', () => {
  it('mounts the program row above the tracks and the audio row below', () => {
    render(<PrevizTimeline />);
    const program = screen.getByTestId('previz-program-track');
    const audio = screen.getByTestId('previz-audio-track');
    // compareDocumentPosition 的 FOLLOWING 位：镜头轨在前，音频轨在后。
    expect(program.compareDocumentPosition(audio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('cuts to a camera from its track header and marks it live', async () => {
    const user = userEvent.setup();
    const cameraId = addCameraTrack();
    render(<PrevizTimeline />);
    await user.click(screen.getByRole('button', { name: 'previz.timeline.cutHere' }));
    expect(usePrevizStore.getState().scene.timeline.program).toMatchObject([{ cameraId, startFrame: 0 }]);
    expect(screen.getByTestId('previz-track-live')).toBeInTheDocument();
  });

  it('cuts to a camera from the program dropdown', async () => {
    const user = userEvent.setup();
    const cameraId = addCameraTrack();
    render(<PrevizTimeline />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'previz.program.cutTo' }), cameraId);
    expect(usePrevizStore.getState().scene.timeline.program).toHaveLength(1);
  });

  it('selects a cut so the inspector can pick it up', async () => {
    const user = userEvent.setup();
    const cameraId = addCameraTrack();
    usePrevizStore.getState().cutToCamera(cameraId);
    const cutId = usePrevizStore.getState().scene.timeline.program[0]!.id;
    render(<PrevizTimeline />);
    await user.click(screen.getByTestId(`previz-clip-${cutId}`));
    expect(usePrevizStore.getState().selectedClipId).toBe(cutId);
  });

  it('shows no live badge on a camera the program is not on', () => {
    const first = addCameraTrack();
    addCameraTrack();
    usePrevizStore.getState().cutToCamera(first);
    render(<PrevizTimeline />);
    expect(screen.getAllByTestId('previz-track-live')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/features/previz/previz-timeline-fixed-rows.test.tsx`
Expected: FAIL，`previz-program-track` 找不到。

- [ ] **Step 3: 改 `PrevizTimeline.tsx`**

(a) import 追加：

```ts
import { liveCameraAt } from '../domain/program';
import { PrevizAudioTrack } from './PrevizAudioTrack';
import { PrevizProgramTrack } from './PrevizProgramTrack';
import { useAudioImport, type PrevizUpstreamAudio } from './useAudioImport';
import { useCutToCamera } from './useCutToCamera';
```

(b) 组件签名加两个可选 prop（模块顶部加 `const NO_UPSTREAM: readonly PrevizUpstreamAudio[] = [];`，避免默认值每次渲染都是新数组）：

```tsx
export function PrevizTimeline({
  onCreateObject,
  nodeId = 'previz',
  upstreamAudio = NO_UPSTREAM,
}: {
  onCreateObject?: (kind: PrevizObjectKind) => void;
  /** 上传音频的文件名要带节点 id，同一项目里两个预演台才不会互相覆盖。 */
  nodeId?: string;
  /** 连进预演台的音频节点，给「添加音频」菜单列出来。 */
  upstreamAudio?: readonly PrevizUpstreamAudio[];
} = {}) {
```

（原有的 `onCreateObject` 注释保留。）

(c) store 选择器那一串之后加：

```ts
  const cutToCamera = useCutToCamera();
  const audioImport = useAudioImport(nodeId);
  const liveCameraId = liveCameraAt(scene, frame);
```

(d) 标尺那一行（`<div className="sticky top-0 z-10 flex items-stretch bg-[#15181f]">…</div>`）之后、`<ul>` 之前插入：

```tsx
          <PrevizProgramTrack
            scene={scene}
            pxPerFrame={pxPerFrame}
            laneWidthPx={laneWidthPx}
            selectedClipId={selectedClipId}
            onSelect={selectClip}
            onTrim={setClipEdge}
            onCut={cutToCamera}
          />
```

(e) `<PrevizTimelineTrack … />` 的 `onAddCloseup` 之后加两个 prop：

```tsx
                onCut={kindOf(track.objectId) === 'camera' ? () => cutToCamera(track.objectId) : undefined}
                live={liveCameraId === track.objectId}
```

(f) `{tracks.length === 0 && (…)}` 空态块之后、播放头 `<div className="pointer-events-none absolute inset-y-0 z-20"` 之前插入：

```tsx
          <PrevizAudioTrack
            scene={scene}
            pxPerFrame={pxPerFrame}
            laneWidthPx={laneWidthPx}
            selectedClipId={selectedClipId}
            onSelect={selectClip}
            onTrim={setClipEdge}
            upstreamAudio={upstreamAudio}
            pending={audioImport.pending}
            onAddFile={(file) => void audioImport.addFile(file)}
            onAddUpstream={(source) => void audioImport.addUpstream(source)}
          />
```

- [ ] **Step 4: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-timeline-fixed-rows.test.tsx src/__tests__/features/previz/previz-timeline.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS；tsc 退出码 0。

- [ ] **Step 5: 提交**

```bash
cd /Users/like/code/dramaclaw && git add -p frontend/src/features/previz/ui/PrevizTimeline.tsx && git add frontend/src/__tests__/features/previz/previz-timeline-fixed-rows.test.tsx && git commit -s -m "feat(previz): mount the program and audio rows in the timeline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

（`PrevizTimeline.tsx` 工作区里已有视口相关改动，`-p` 只挑本任务的 hunk。）

---

### Task 15: 片段面板的切片分支与音频分支

**Files:**
- Modify: `src/features/previz/ui/PrevizClipInspector.tsx`
- Test: `src/__tests__/features/previz/previz-clip-inspector-tables.test.tsx`

- [ ] **Step 1: 写失败的测试**

```tsx
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultScene } from '@/features/previz/domain/scene';
import { usePrevizStore } from '@/features/previz/store';
import { PrevizClipInspector } from '@/features/previz/ui/PrevizClipInspector';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function twoCameras(): [string, string] {
  const store = usePrevizStore.getState();
  return [store.addObject('camera')!, store.addObject('camera')!];
}

function seedCut(): { cutId: string; camA: string; camB: string } {
  const [camA, camB] = twoCameras();
  usePrevizStore.getState().cutToCamera(camA);
  const cutId = usePrevizStore.getState().scene.timeline.program[0]!.id;
  usePrevizStore.getState().selectClip(cutId);
  return { cutId, camA, camB };
}

function seedAudio(): string {
  usePrevizStore.getState().addAudioClip(
    { audioUrl: '/static/vo.mp3', sourceName: 'vo.mp3', durationMs: 4000, sourceNodeId: null },
    10,
  );
  const clipId = usePrevizStore.getState().scene.timeline.audio[0]!.id;
  usePrevizStore.getState().selectClip(clipId);
  return clipId;
}

beforeEach(() => {
  usePrevizStore.getState().loadScene(createDefaultScene());
});

describe('PrevizClipInspector cut panel', () => {
  it('lets the cut be retargeted to another camera', async () => {
    const user = userEvent.setup();
    const { cutId, camB } = seedCut();
    render(<PrevizClipInspector />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'previz.clip.cut.camera' }), camB);
    expect(usePrevizStore.getState().scene.timeline.program[0]).toMatchObject({ id: cutId, cameraId: camB });
  });

  it('edits the frame range and removes the cut', async () => {
    const user = userEvent.setup();
    const { cutId } = seedCut();
    render(<PrevizClipInspector />);
    const end = screen.getByRole('spinbutton', { name: 'previz.clip.endFrame' });
    await user.clear(end);
    await user.type(end, '45{Enter}');
    expect(usePrevizStore.getState().scene.timeline.program[0]).toMatchObject({ id: cutId, endFrame: 45 });
    await user.click(screen.getByRole('button', { name: 'previz.clip.remove' }));
    expect(usePrevizStore.getState().scene.timeline.program).toEqual([]);
  });

  it('does not offer the object-clip controls on a cut', () => {
    seedCut();
    render(<PrevizClipInspector />);
    expect(screen.queryByRole('combobox', { name: 'previz.clip.aim' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'previz.clip.insertPoint' })).toBeNull();
  });
});

describe('PrevizClipInspector audio panel', () => {
  it('shows the source, the offset and moves the clip to the playhead', async () => {
    const user = userEvent.setup();
    const clipId = seedAudio();
    usePrevizStore.getState().setTimelineFrame(40);
    render(<PrevizClipInspector />);
    expect(screen.getByText('vo.mp3')).toBeInTheDocument();
    expect(screen.getByLabelText('previz.clip.audio.offset')).toHaveValue('0');
    await user.click(screen.getByRole('button', { name: 'previz.clip.audio.relocate' }));
    expect(usePrevizStore.getState().scene.timeline.audio[0]).toMatchObject({ id: clipId, startFrame: 40 });
  });

  it('removes the audio clip', async () => {
    const user = userEvent.setup();
    seedAudio();
    render(<PrevizClipInspector />);
    await user.click(screen.getByRole('button', { name: 'previz.clip.remove' }));
    expect(usePrevizStore.getState().scene.timeline.audio).toEqual([]);
  });
});
```

`NumberInput` 若不是按 Enter 提交（看 `src/features/previz/ui/NumberInput.tsx` 的 `onCommit` 触发时机：blur 或 Enter），把 `'45{Enter}'` 改成 `'45'` 再 `await user.tab()`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-clip-inspector-tables.test.tsx`
Expected: FAIL，切片分支现在被 Task 4 的临时守卫当成空态。

- [ ] **Step 3: 改 `PrevizClipInspector.tsx`**

(a) `import type {…} from '../domain/scene'` 里加 `PrevizAudioClip, PrevizCutClip`。

(b) 在 `PointCard` 之后、`export function PrevizClipInspector()` 之前加两个面板：

```tsx
/** 镜头轨的切片：只有机位、起止帧、删除。起点改的是整条平移，与对象片段一致。 */
function CutPanel({ clip }: { clip: PrevizCutClip }) {
  const { t } = useTranslation();
  const objects = usePrevizStore((state) => state.scene.objects);
  const moveClipBy = usePrevizStore((state) => state.moveClipBy);
  const setClipEnd = usePrevizStore((state) => state.setClipEnd);
  const setCutCamera = usePrevizStore((state) => state.setCutCamera);
  const removeClipById = usePrevizStore((state) => state.removeClipById);
  const cameras = objects.filter((object) => object.kind === 'camera');

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 p-3">
      <SelectField
        label={t('previz.clip.cut.camera')}
        value={clip.cameraId}
        options={cameras.map((camera) => ({ value: camera.id, label: camera.name }))}
        onCommit={(cameraId) => setCutCamera(clip.id, cameraId)}
      />
      <NumberField
        label={t('previz.clip.startFrame')}
        value={clip.startFrame}
        step={1}
        onCommit={(next) => moveClipBy(clip.id, Math.round(next) - clip.startFrame)}
      />
      <NumberField
        label={t('previz.clip.endFrame')}
        value={clip.endFrame}
        step={1}
        onCommit={(next) => setClipEnd(clip.id, next)}
      />
      <button type="button" className={DANGER} onClick={() => removeClipById(clip.id)}>
        {t('previz.clip.remove')}
      </button>
    </div>
  );
}

/**
 * 音频片段：素材名与偏移只读——偏移是裁起点时算出来的，手改它等于让波形和声音错位。
 * 想换位置就「重新定位到播放头」，那会把偏移清零、按素材长度重铺。
 */
function AudioPanel({ clip }: { clip: PrevizAudioClip }) {
  const { t } = useTranslation();
  const moveClipBy = usePrevizStore((state) => state.moveClipBy);
  const setClipEnd = usePrevizStore((state) => state.setClipEnd);
  const relocateAudioClipToPlayhead = usePrevizStore((state) => state.relocateAudioClipToPlayhead);
  const removeClipById = usePrevizStore((state) => state.removeClipById);

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 p-3">
      <Row label={t('previz.clip.audio.source')}>
        <span className="min-w-0 flex-1 truncate text-[12px] text-white/80" title={clip.sourceName}>
          {clip.sourceName}
        </span>
      </Row>
      <NumberField
        label={t('previz.clip.startFrame')}
        value={clip.startFrame}
        step={1}
        onCommit={(next) => moveClipBy(clip.id, Math.round(next) - clip.startFrame)}
      />
      <NumberField
        label={t('previz.clip.endFrame')}
        value={clip.endFrame}
        step={1}
        onCommit={(next) => setClipEnd(clip.id, next)}
      />
      <Row label={t('previz.clip.audio.offset')}>
        <input
          aria-label={t('previz.clip.audio.offset')}
          className={FIELD}
          value={String(Math.round(clip.offsetMs))}
          readOnly
        />
      </Row>
      <button type="button" className={ACTION} onClick={() => relocateAudioClipToPlayhead(clip.id)}>
        {t('previz.clip.audio.relocate')}
      </button>
      <button type="button" className={DANGER} onClick={() => removeClipById(clip.id)}>
        {t('previz.clip.remove')}
      </button>
    </div>
  );
}
```

(c) `PrevizClipInspector` 里：删掉 Task 4 加的临时守卫；在空态 `return` 之后、`const point: PrevizPathPoint | undefined = …` 之前加：

```tsx
  if (found.table === 'program') return <CutPanel clip={found.clip} />;
  if (found.table === 'audio') return <AudioPanel clip={found.clip} />;
```

这两行之后 TypeScript 把 `found` 收窄成 `{ table: 'tracks'; track; clip }`，下面原有的 `found.track.objectId` 不再报错。

- [ ] **Step 4: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-clip-inspector-tables.test.tsx src/__tests__/features/previz/previz-clip-inspector.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS；tsc 退出码 0。

- [ ] **Step 5: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/features/previz/ui/PrevizClipInspector.tsx frontend/src/__tests__/features/previz/previz-clip-inspector-tables.test.tsx && git commit -s -m "feat(previz): inspect cuts and audio clips

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---

### Task 16: 监看跟随镜头轨、直播机位高亮、数字键切镜

**Files:**
- Modify: `src/features/previz/ui/PrevizMonitorFrame.tsx`
- Modify: `src/features/previz/PrevizEditor.tsx`
- Test: `src/__tests__/features/previz/previz-editor.test.tsx`

- [ ] **Step 1: 写失败的测试**

`previz-editor.test.tsx` 顶部若还没有 `const setActiveCamera = vi.fn();`（与 `setScene` 并列的模块级 fn），加上，并让 `fakeRenderer()` 里的 `setActiveCamera` 指向它。`setLiveCamera` 同样（Task 7 已加 `setLiveCamera: vi.fn()`，改成模块级 `const setLiveCamera = vi.fn();` 再引用）。

文件末尾追加：

```tsx
describe("program follow", () => {
  function renderWithCameras(): { camA: string; camB: string } {
    const scene = createDefaultScene();
    const camA = createPrevizObject("camera", scene.objects);
    const camB = createPrevizObject("camera", [camA]);
    scene.objects.push(camA, camB);
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );
    return { camA: camA.id, camB: camB.id };
  }

  it("moves the monitor to the camera the program cuts to", async () => {
    const { camB } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().cutToCamera(camB);
    });
    expect(setActiveCamera).toHaveBeenLastCalledWith(camB);
    expect(setLiveCamera).toHaveBeenLastCalledWith(camB);
    expect(screen.getByTestId("previz-monitor-frame")).toBeInTheDocument();
  });

  it("stops following when a camera is picked by hand and resumes from the follow button", async () => {
    const user = userEvent.setup();
    const { camA, camB } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().cutToCamera(camB);
      usePrevizStore.getState().setActiveCamera(camA);
    });
    expect(setActiveCamera).toHaveBeenLastCalledWith(camA);
    const follow = screen.getByTestId("previz-monitor-follow");
    expect(follow).toHaveAccessibleName("previz.monitor.follow");
    await user.click(follow);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(true);
    expect(setActiveCamera).toHaveBeenLastCalledWith(camB);
    expect(screen.getByTestId("previz-monitor-follow")).toBeDisabled();
    expect(screen.getByTestId("previz-monitor-follow")).toHaveAccessibleName("previz.monitor.following");
  });

  it("cuts to the nth camera on a digit key", async () => {
    const { camB } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    expect(usePrevizStore.getState().scene.timeline.program).toMatchObject([{ cameraId: camB }]);
    // 没有第九台机位：什么都不发生，也不报错。
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "9", bubbles: true }));
    });
    expect(usePrevizStore.getState().scene.timeline.program).toHaveLength(1);
  });

  it("ignores digit keys typed into an input", async () => {
    renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    expect(usePrevizStore.getState().scene.timeline.program).toEqual([]);
    input.remove();
  });

  it("ignores digit keys inside a nested dialog", async () => {
    renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("button");
    dialog.appendChild(inner);
    document.body.appendChild(dialog);
    act(() => {
      inner.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    expect(usePrevizStore.getState().scene.timeline.program).toEqual([]);
    dialog.remove();
  });
});
```

`createPrevizObject` 若文件里尚未 import，从 `@/features/previz/domain/objects` 引入（录制用例已经用了它，多半已有）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-editor.test.tsx -t "program follow"`
Expected: FAIL，`previz-monitor-follow` 找不到 / `setActiveCamera` 最后一次不是 camB。

- [ ] **Step 3: 改 `PrevizMonitorFrame.tsx`**

(a) `lucide-react` import 加 `Radio`。

(b) `PrevizMonitorFrameProps` 的 `onClose` 之前加：

```ts
  /** 监看正跟着镜头轨走；按钮变成灰的「跟随中」。 */
  following: boolean;
  /** 手选过机位之后点它回到跟随。 */
  onFollow: () => void;
```

解构里加 `following, onFollow`。

(c) 「隐藏监看」那颗 `PrevizHoverTip` 之前插入：

```tsx
          <PrevizHoverTip label={t(following ? "previz.monitor.following" : "previz.monitor.follow")}>
            <button
              type="button"
              data-testid="previz-monitor-follow"
              aria-label={t(following ? "previz.monitor.following" : "previz.monitor.follow")}
              className={cn(CHIP, following && CHIP_ON)}
              disabled={following}
              onClick={onFollow}
            >
              <Radio className="h-3.5 w-3.5" />
            </button>
          </PrevizHoverTip>
```

文件若没 import `cn`，加 `import { cn } from "@/lib/utils";`；若文件里其它 chip 是用模板串拼 `CHIP_ON` 的，就照那个写法。

- [ ] **Step 4: 改 `PrevizEditor.tsx`**

(a) import：`import { monitorCameraId, usePrevizStore } from "./store";`（替换原来的 `usePrevizStore` 单独 import）；加 `import { liveCameraAt } from "./domain/program";`。

(b) store 选择器：`const activeCameraId = usePrevizStore((state) => state.activeCameraId);` 之后加：

```ts
  /** 监看此刻看的机位：跟随时是镜头轨的直播机位，手选后是 activeCameraId。 */
  const monitorId = usePrevizStore(monitorCameraId);
  const monitorFollowsProgram = usePrevizStore((state) => state.monitorFollowsProgram);
  const followProgram = usePrevizStore((state) => state.followProgram);
```

(c) 把下面几处的 `activeCameraId` 换成 `monitorId`（`activeCameraId` 本身保留——`setActiveCamera(null)` 关监看仍靠它）：
- `if (activeCameraId) lastMonitoredCameraId.current = activeCameraId;` → `if (monitorId) lastMonitoredCameraId.current = monitorId;`
- `monitoredCamera` 的 `useMemo`：`find((entry) => entry.id === monitorId)`，依赖 `[scene.objects, monitorId]`。
- `quadCamera` 的 `useMemo`：`find((object) => object.id === monitorId) ?? cameras[0]`，依赖 `[scene.objects, monitorId]`。
- `useEffect(() => { renderer?.setActiveCamera(activeCameraId); }, [renderer, activeCameraId]);` → 用 `monitorId`。
- `{!activeCameraId && restorableCameraId && (` → `{!monitorId && restorableCameraId && (`。
- `<PrevizLayerPanel … activeCameraId={activeCameraId}` → `activeCameraId={monitorId}`。

(d) `setActiveCamera` 那个 effect 后面加直播机位 effect：

```ts
  // 直播机位的红框：跟着播放头走，切片一换就换。
  useEffect(() => {
    renderer?.setLiveCamera(liveCameraAt(scene, timelineFrame));
  }, [renderer, scene, timelineFrame]);
```

(e) `<PrevizMonitorFrame …>` 加两个 prop：

```tsx
                  following={monitorFollowsProgram}
                  onFollow={followProgram}
```

(f) `DialogContent` 加属性 `data-previz-editor=""`（放在 `showCloseButton={false}` 旁边）。

(g) 键盘 effect 里，输入框守卫之后、`const store = usePrevizStore.getState();` 之前加嵌套对话框守卫；`if (event.metaKey || event.ctrlKey || event.altKey) return;` 之后、`switch` 之前加数字键：

```ts
      // 机位创建对话框之类的嵌套弹窗开着时，按键是给它的。编辑器自己的 DialogContent
      // 带 data-previz-editor，只放行落在它里面（而不是更里层 dialog 里）的按键。
      const dialog = (event.target as Element | null)?.closest?.('[role="dialog"]');
      if (dialog && !dialog.hasAttribute("data-previz-editor")) return;
```

```ts
      // 1–9 按机位在对象列表里的顺序切镜；没有那一台就当没按。
      if (/^[1-9]$/.test(event.key)) {
        const cameras = store.scene.objects.filter((object) => object.kind === "camera");
        const camera = cameras[Number(event.key) - 1];
        if (camera) {
          event.preventDefault();
          cutToCamera(camera.id);
        }
        return;
      }
```

`cutToCamera` 来自 `import { useCutToCamera } from "./ui/useCutToCamera";`，在组件顶部 `const cutToCamera = useCutToCamera();`，并把它加进这个 effect 的依赖数组：`[open, renderer, cutToCamera]`。

- [ ] **Step 5: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-editor.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: 全部 PASS；tsc 退出码 0。

- [ ] **Step 6: 提交**

```bash
cd /Users/like/code/dramaclaw && git add -p frontend/src/features/previz/PrevizEditor.tsx frontend/src/__tests__/features/previz/previz-editor.test.tsx && git add frontend/src/features/previz/ui/PrevizMonitorFrame.tsx && git commit -s -m "feat(previz): follow the program in the monitor and cut with digit keys

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

（`PrevizEditor.tsx` 与它的测试在工作区里有视口相关的未提交 hunk，`-p` 只挑本任务的。）

---
### Task 17: 编辑器的音频播放与录制混音

**Files:**
- Modify: `src/features/previz/PrevizEditor.tsx`
- Test: `src/__tests__/features/previz/previz-editor.test.tsx`

- [ ] **Step 1: 补 mock、写失败的测试**

`previz-editor.test.tsx` 的 mock 段改三处：

```ts
vi.mock("@/api/ops", () => ({
  uploadFreezoneImage: vi.fn(async () => ({ url: "/static/shot.png" })),
  uploadFreezoneVideo: () => uploadFreezoneVideo(),
  uploadFreezoneAudio: vi.fn(async () => ({ url: "/static/take.mp3" })),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
```

并在 `vi.mock("@/features/previz/capture/recordTimeline", …)` 之后加一段音频引擎的 mock（jsdom 没有 AudioContext；编辑器只经由这三个导出碰它）：

```ts
const audioDestination = { stream: { getAudioTracks: () => [] } };
const audioContext = { createMediaStreamDestination: () => audioDestination };
const audioPlayback = {
  context: audioContext,
  load: vi.fn(async () => {}),
  play: vi.fn(async () => {}),
  stop: vi.fn(),
  dispose: vi.fn(),
  failedUrls: new Set<string>(),
};
const createAudioContext = vi.fn(() => audioContext);

vi.mock("@/features/previz/engine/audioPlayback", () => ({
  createAudioContext: () => createAudioContext(),
  fetchAudioBuffer: vi.fn(),
  createAudioPlayback: () => audioPlayback,
}));
```

顶部 import 加 `import { toast } from "sonner";`（若已有就不用）。

文件末尾追加：

```tsx
describe("audio playback and mix", () => {
  const source = { audioUrl: "/static/vo.mp3", sourceName: "vo.mp3", durationMs: 2000, sourceNodeId: null };

  function renderOneFrame(): string {
    const scene = createDefaultScene();
    scene.settings.durationFrames = 1;
    const camera = createPrevizObject("camera", scene.objects);
    scene.objects.push(camera);
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );
    return camera.id;
  }

  async function recordGlobal(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
    await user.click(screen.getByRole("menuitem", { name: "previz.editor.record.mode.global" }));
    await vi.waitFor(() => expect(addDerivedVideoNode).toHaveBeenCalled(), { timeout: 3000 });
  }

  it("plays the audio track while the timeline plays and stops with it", async () => {
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
      usePrevizStore.getState().setTimelinePlaying(true);
    });
    expect(audioPlayback.play).toHaveBeenCalledWith(
      usePrevizStore.getState().scene.timeline.audio,
      0,
      1,
    );
    act(() => usePrevizStore.getState().setTimelinePlaying(false));
    expect(audioPlayback.stop).toHaveBeenCalled();
  });

  it("does not touch the audio engine when the track is empty", async () => {
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => usePrevizStore.getState().setTimelinePlaying(true));
    expect(createAudioContext).not.toHaveBeenCalled();
  });

  it("mixes the audio track into a recording and stamps the duration", async () => {
    const user = userEvent.setup();
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
    });
    const clips = usePrevizStore.getState().scene.timeline.audio;
    await recordGlobal(user);
    expect(audioPlayback.load).toHaveBeenCalledWith(clips);
    expect(audioPlayback.play).toHaveBeenCalledWith(clips, 0, 1, audioDestination);
    expect(audioPlayback.stop).toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    // 一帧 @ 30fps ≈ 33ms：时长来自真正画出的帧数，不是设置里的总长。
    expect(addDerivedVideoNode).toHaveBeenLastCalledWith(
      "previz-1",
      "/static/take.mp4",
      "16:9",
      "previz.editor.record.globalNodeName",
      33,
    );
  });

  it("records silent video with a warning when the browser cannot mix", async () => {
    const user = userEvent.setup();
    createAudioContext.mockReturnValueOnce(null as unknown as typeof audioContext);
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
    });
    await recordGlobal(user);
    expect(toast.warning).toHaveBeenCalledWith("previz.editor.record.noAudioMix");
    expect(audioPlayback.play).not.toHaveBeenCalled();
    expect(addDerivedVideoNode).toHaveBeenCalled();
  });

  it("paints the live camera frame by frame in a global recording", async () => {
    const user = userEvent.setup();
    const cameraId = renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().cutToCamera(cameraId);
    });
    await recordGlobal(user);
    expect(recordDrawFrame).toHaveBeenCalledWith(0, cameraId);
  });

  it("disposes the audio engine when the editor closes", async () => {
    const scene = createDefaultScene();
    const { rerender } = render(
      <PrevizEditor open nodeId="previz-1" initialScene={scene} onOpenChange={vi.fn()} onFlush={vi.fn()} />,
    );
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
      usePrevizStore.getState().setTimelinePlaying(true);
    });
    expect(audioPlayback.play).toHaveBeenCalled();
    rerender(
      <PrevizEditor open={false} nodeId="previz-1" initialScene={scene} onOpenChange={vi.fn()} onFlush={vi.fn()} />,
    );
    expect(audioPlayback.dispose).toHaveBeenCalled();
  });
});
```

`toHaveBeenLastCalledWith(…, 33)`：`Math.round((1 / 30) * 1000) = 33`。`previz.editor.record.mode.global` 这个 menuitem 名字以录制选单里现有的 key 为准（看 Task 8 前录制用例用的 `previz.editor.record.mode.track` 的兄弟 key）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/features/previz/previz-editor.test.tsx -t "audio playback and mix"`
Expected: FAIL，`audioPlayback.play` 未被调用。

- [ ] **Step 3: 改 `PrevizEditor.tsx`**

(a) import 追加：

```ts
import {
  createAudioContext,
  createAudioPlayback,
  fetchAudioBuffer,
  type PrevizAudioPlayback,
} from "./engine/audioPlayback";
```

(b) store 选择器：`timelinePlaying` 之后加 `const timelineRate = usePrevizStore((state) => state.timelineRate);` 与 `const seekSerial = usePrevizStore((state) => state.seekSerial);`。

(c) `pointerDownAt` ref 旁边加音频引擎的 ref 与惰性创建：

```ts
  /**
   * Web Audio 上下文按需建、整个编辑器共用一份：浏览器对 AudioContext 数量有上限，
   * 每次播放都新建的话开关几次就静音了。首次真正需要（播放/录制且轨上有片段）才建，
   * 空音频轨的场景根本不碰它。
   */
  const audioPlaybackRef = useRef<PrevizAudioPlayback | null>(null);
  const ensureAudioPlayback = useCallback((): PrevizAudioPlayback | null => {
    if (audioPlaybackRef.current) return audioPlaybackRef.current;
    const context = createAudioContext();
    if (!context) return null;
    audioPlaybackRef.current = createAudioPlayback({
      context,
      fetchBuffer: (url) => fetchAudioBuffer(context, url),
    });
    return audioPlaybackRef.current;
  }, []);
```

(d) 播放循环那个 effect（`if (!open || !timelinePlaying) return undefined;` 的那个）之后加：

```ts
  // 时间轴一播就把音频对上；seekSerial 一变（拖播放头 / 停下来）就从新位置重排。
  // 片段与当前帧从 getState 读而不进依赖：播放中每帧都在变，跟着重排会卡成一片。
  useEffect(() => {
    if (!open || !timelinePlaying || recording) return undefined;
    const store = usePrevizStore.getState();
    const clips = store.scene.timeline.audio;
    if (clips.length === 0) return undefined;
    const playback = ensureAudioPlayback();
    if (!playback) return undefined;
    void playback.play(clips, store.timelineFrame, timelineRate);
    return () => playback.stop();
  }, [open, timelinePlaying, timelineRate, seekSerial, recording, ensureAudioPlayback]);

  // 关编辑器就把上下文关掉；卸载同理。
  useEffect(() => {
    if (open) return undefined;
    audioPlaybackRef.current?.dispose();
    audioPlaybackRef.current = null;
    return undefined;
  }, [open]);
  useEffect(
    () => () => {
      audioPlaybackRef.current?.dispose();
      audioPlaybackRef.current = null;
    },
    [],
  );
```

(e) `handleRecord` 里：

`const mimeType = pickRecordMimeType();` 到它的 `unsupported` 判断这一段换成：

```ts
      const audioClips = store.scene.timeline.audio;
      // 轨上有音频才混；混不了（没有 AudioContext / 没有带音轨的 mimeType）就退回无声，
      // 但要说一声，别让人以为音频丢了。
      let playback: PrevizAudioPlayback | null =
        audioClips.length > 0 ? ensureAudioPlayback() : null;
      let mimeType = playback ? pickRecordMimeType(undefined, true) : null;
      if (audioClips.length > 0 && (!playback || !mimeType)) {
        toast.warning(t("previz.editor.record.noAudioMix"));
        playback = null;
      }
      if (!mimeType) mimeType = pickRecordMimeType();
      if (!mimeType) {
        toast.error(t("previz.editor.record.unsupported"));
        return;
      }
```

`try {` 之后、`let blob: Blob;` 之前加：

```ts
        // 录制按帧数算时长：中途停下的话只有画出来的那些帧，不能拿设置里的总长充数。
        let drawn = 0;
        const programScene = store.scene;
        const destination = playback ? playback.context.createMediaStreamDestination() : null;
        if (playback) await playback.load(audioClips);
        const canvasRecorder = createCanvasRecorder(pass.canvas, {
          fps: PREVIZ_RECORD_FPS,
          mimeType,
          audioStream: destination?.stream,
        });
        // 混音时录制器一开就把音频从第 0 帧、1 倍速排进混音节点；停就一起停。
        const mixed = playback;
        const recorder =
          mixed && destination
            ? {
                start: () => {
                  canvasRecorder.start();
                  void mixed.play(audioClips, 0, 1, destination);
                },
                stop: () => {
                  mixed.stop();
                  return canvasRecorder.stop();
                },
              }
            : canvasRecorder;
```

`recordTimeline({...})` 里：

```ts
            drawFrame: (frame) => {
              // 全局录制按镜头轨逐帧换机位；轨道录制固定一台，传 null 让 pass 用自己那台。
              pass.drawFrame(frame, target.mode === "global" ? liveCameraAt(programScene, frame) : null);
              drawn = frame + 1;
              usePrevizStore.getState().setTimelineFrame(frame);
            },
            recorder,
```

（原来的 `recorder: createCanvasRecorder(pass.canvas, { fps: PREVIZ_RECORD_FPS, mimeType }),` 删掉。）

`publishRecording({...})` 里 Task 8 临时写的 `durationMs: Math.round((durationFrames / PREVIZ_RECORD_FPS) * 1000)` 改成 `durationMs: Math.round((drawn / PREVIZ_RECORD_FPS) * 1000)`。`durationFrames` 仍传给 `recordTimeline`，别删。

`handleRecord` 的 `useCallback` 依赖数组加 `ensureAudioPlayback`。

- [ ] **Step 4: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/previz/previz-editor.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: 全部 PASS（含 Task 16 的用例）；tsc 退出码 0。

- [ ] **Step 5: 提交**

```bash
cd /Users/like/code/dramaclaw && git add -p frontend/src/features/previz/PrevizEditor.tsx frontend/src/__tests__/features/previz/previz-editor.test.tsx && git commit -s -m "feat(previz): play the audio track and mix it into recordings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---

### Task 18: 画布接线——音频节点可连预演台、`PrevizNode` 传上游音频、卡片摘要

**Files:**
- Modify: `src/features/canvas/domain/nodeRegistry.ts`
- Modify: `src/features/canvas/nodes/PrevizNode.tsx`
- Modify: `src/features/previz/PrevizEditor.tsx`
- Test: `src/__tests__/features/canvas/node-registry.test.ts`
- Test: `src/__tests__/features/previz/previz-node.test.tsx`

- [ ] **Step 1: 写失败的测试**

`node-registry.test.ts`：「其余节点的菜单候选不受影响」用例里 `getDownstreamSpawnTypes(CANVAS_NODE_TYPES.audio)` 的期望改成：

```ts
    expect(getDownstreamSpawnTypes(CANVAS_NODE_TYPES.audio)).toEqual([
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.videoCompose,
      CANVAS_NODE_TYPES.previz,
    ]);
```

同一个 `describe('连线菜单候选')` 里加：

```ts
  it("音频节点能连进预演台", () => {
    expect(isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.audio, CANVAS_NODE_TYPES.previz)).toBe(true);
    expect(isManualConnectionAllowed(CANVAS_NODE_TYPES.audio, CANVAS_NODE_TYPES.previz)).toBe(true);
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.previz)).toEqual([CANVAS_NODE_TYPES.audio]);
    // 图片、视频仍然进不了预演台：它只读声音。
    expect(isManualConnectionAllowed(CANVAS_NODE_TYPES.imageGen, CANVAS_NODE_TYPES.previz)).toBe(false);
  });
```

（`isManualConnectionAllowed(imageGen, previz)` 现在若已经是 `false`，这一行只是把它钉住；若为 `true`，说明预演台没按目标收口——本任务不动它，删掉这一行即可，spec 只要求音频进得来。）

`previz-node.test.tsx`：
- `describe("previz upstream spawn")` 那段的注释与用例改成：

```tsx
// 预演台从左侧 target handle 只能拉出音频节点：它读的上游只有音频轨的素材。
describe("previz upstream spawn", () => {
  it("offers only audio nodes from the previz target handle", () => {
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.previz)).toEqual([CANVAS_NODE_TYPES.audio]);
  });
});
```

- `vi.mock("@/features/previz/PrevizEditor", …)` 改成把上游音频名字渲染出来：

```tsx
vi.mock("@/features/previz/PrevizEditor", () => ({
  PrevizEditor: ({
    open,
    upstreamAudio,
  }: {
    open: boolean;
    upstreamAudio?: readonly { displayName: string }[];
  }) =>
    open ? (
      <div data-testid="previz-editor-open">
        {(upstreamAudio ?? []).map((source) => source.displayName).join(",")}
      </div>
    ) : null,
}));
```

- 文件末尾追加：

```tsx
describe("PrevizNode upstream audio", () => {
  it("hands connected audio nodes to the editor and skips ones still uploading", async () => {
    const user = userEvent.setup();
    const previzId = renderNode();
    const store = useCanvasStore.getState();
    const ready = store.addNode(CANVAS_NODE_TYPES.audio, { x: -300, y: 0 }, {
      displayName: "旁白",
      audioUrl: "/static/vo.mp3",
      durationMs: 3000,
    });
    const uploading = store.addNode(CANVAS_NODE_TYPES.audio, { x: -300, y: 200 }, {
      displayName: "还在传",
      audioUrl: "/static/bg.mp3",
      isUploading: true,
    });
    expect(store.addEdge(ready, previzId)).not.toBeNull();
    expect(store.addEdge(uploading, previzId)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "previz.node.open" }));
    expect(screen.getByTestId("previz-editor-open")).toHaveTextContent("旁白");
    expect(screen.getByTestId("previz-editor-open")).not.toHaveTextContent("还在传");
  });

  it("shows the audio clip count on the card", () => {
    renderNode({
      summary: { objectCount: 1, durationFrames: 120, audioClipCount: 2 },
    });
    expect(screen.getByText("previz.node.audioSummary:2")).toBeInTheDocument();
  });

  it("hides the audio line when there are no clips", () => {
    renderNode({ summary: { objectCount: 1, durationFrames: 120, audioClipCount: 0 } });
    expect(screen.queryByText(/previz\.node\.audioSummary/)).toBeNull();
  });
});
```

`renderNode` 建节点后组件是用 `node?.data` 渲染的，`summary` 的字段名以 `PrevizNodeSummary`（Task 1）为准；若它还有别的必填字段，按类型补齐。`addNode` 返回的是 id 字符串（看 `canvasStore.ts:1631`）；若返回的是节点对象，取 `.id`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/canvas/node-registry.test.ts src/__tests__/features/previz/previz-node.test.tsx`
Expected: FAIL，`getUpstreamSpawnTypes(previz)` 仍是 `[]`；`addEdge(ready, previzId)` 返回 null。

- [ ] **Step 3: 改 `nodeRegistry.ts`**

三张表各改一行：

```ts
const DOWNSTREAM_TARGET_WHITELIST: Partial<Record<CanvasNodeType, readonly CanvasNodeType[]>> = {
  // 预演台读上游音频节点做音频轨素材。
  [CANVAS_NODE_TYPES.audio]: [
    CANVAS_NODE_TYPES.video,
    CANVAS_NODE_TYPES.videoCompose,
    CANVAS_NODE_TYPES.previz,
  ],
```

```ts
  // 音频：下游是视频（声轨素材）、视频合成（音频轨）与预演台（音频轨）。
  [CANVAS_NODE_TYPES.audio]: [
    CANVAS_NODE_TYPES.video,
    CANVAS_NODE_TYPES.videoCompose,
    CANVAS_NODE_TYPES.previz,
  ],
```

`UPSTREAM_SPAWN_WHITELIST` 里预演台那一段（连同「P0 不读任何上游」那四行注释）换成：

```ts
  // 预演台：上游只收音频——它的音频轨从连进来的音频节点里选素材。
  [CANVAS_NODE_TYPES.previz]: [CANVAS_NODE_TYPES.audio],
```

- [ ] **Step 4: 改 `PrevizNode.tsx`**

(a) import：

```ts
import { useUpstreamNodes } from "@/features/canvas/application/useUpstreamGraph";
import { CANVAS_NODE_TYPES, isAudioNode, type PrevizNodeData } from "@/features/canvas/domain/canvasNodes";
import type { PrevizUpstreamAudio } from "@/features/previz/ui/useAudioImport";
```

（原来两行分开的 `canvasNodes` import 合成这一行。`import type` 在打包时被擦掉，不会把 three 拉进节点包。）

(b) `const loaded = useMemo(…)` 之前加：

```ts
  const upstreamNodes = useUpstreamNodes(id);
  // 只给有 url 且传完了的音频节点；还在上传的那一个连 url 都可能是临时的。
  const upstreamAudio = useMemo<PrevizUpstreamAudio[]>(
    () =>
      upstreamNodes.flatMap((node) => {
        if (!isAudioNode(node) || !node.data.audioUrl || node.data.isUploading) return [];
        return [
          {
            nodeId: node.id,
            displayName: resolveNodeDisplayName(CANVAS_NODE_TYPES.audio, node.data),
            audioUrl: node.data.audioUrl,
            durationMs: node.data.durationMs ?? null,
          },
        ];
      }),
    [upstreamNodes],
  );
```

(c) 卡片摘要那个 `<span className="text-[12px] text-text-muted/90">…</span>` 之后加：

```tsx
          {loaded.ok && data.summary?.audioClipCount ? (
            <span className="text-[11px] text-text-muted/80">
              {t("previz.node.audioSummary", { count: data.summary.audioClipCount })}
            </span>
          ) : null}
```

(d) `<PrevizEditor …>` 加 `upstreamAudio={upstreamAudio}`。

- [ ] **Step 5: 改 `PrevizEditor.tsx`**

`PrevizEditorProps` 加：

```ts
  /** 连进这个节点的音频节点，转给时间轴的「添加音频」菜单。 */
  upstreamAudio?: readonly PrevizUpstreamAudio[];
```

（`import type { PrevizUpstreamAudio } from "./ui/useAudioImport";`）。函数参数解构里加 `upstreamAudio`，时间轴的挂载改成：

```tsx
          {timelineOpen && (
            <PrevizTimeline nodeId={nodeId} upstreamAudio={upstreamAudio} onCreateObject={handleAdd} />
          )}
```

- [ ] **Step 6: 跑测试与 typecheck**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run src/__tests__/features/canvas/node-registry.test.ts src/__tests__/features/previz/previz-node.test.tsx src/__tests__/features/previz/previz-editor.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: 全部 PASS；tsc 退出码 0。

- [ ] **Step 7: 全量回归**

Run: `cd /Users/like/code/dramaclaw/frontend && npx vitest run 2>&1 | tail -15`
Expected: 只有基线里那 6 个失败（`lib/local-storage-quota.test.ts` ×5、`lib/queries/ingest.test.tsx` ×1）；previz 与 canvas 目录全绿。

- [ ] **Step 8: 提交**

```bash
cd /Users/like/code/dramaclaw && git add frontend/src/features/canvas/domain/nodeRegistry.ts frontend/src/features/canvas/nodes/PrevizNode.tsx frontend/src/__tests__/features/canvas/node-registry.test.ts frontend/src/__tests__/features/previz/previz-node.test.tsx && git add -p frontend/src/features/previz/PrevizEditor.tsx && git commit -s -m "feat(previz): accept upstream audio nodes and summarise the audio track

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---

### Task 19: 刷新 license 清单

**Files:**
- Modify: `license-inventory.csv`

新建的文件（`domain/program.ts`、`domain/audioTrack.ts`、`engine/audioPlayback.ts`、`engine/audioProbe.ts`、`ui/useCutToCamera.ts`、`ui/PrevizProgramTrack.tsx`、`ui/useAudioImport.ts`、`ui/PrevizAudioTrack.tsx` 与各测试）都要进清单，否则合规检查会红。

- [ ] **Step 1: 重新生成清单**

Run:

```bash
cd /Users/like/code/dramaclaw && python3 -c "from scripts.compliance.generate_p0b_artifacts import run_git_ls_files, write_license_inventory; write_license_inventory(run_git_ls_files())" && git diff --stat -- license-inventory.csv
```

Expected: 只有 `license-inventory.csv` 变化，新增行数 ≈ 本计划新建的文件数（16 上下）。`git ls-files` 只看已跟踪文件，所以前面每个任务的提交都得先做完。

- [ ] **Step 2: 检查新增行**

Run: `cd /Users/like/code/dramaclaw && git diff -- license-inventory.csv | grep '^+' | grep -v '^+++' | grep -c 'Elastic-2.0'`
Expected: 与新增行数相同——每个新文件都带 `Elastic-2.0` 头。少了就回去补 SPDX 头再重跑 Step 1。

- [ ] **Step 3: 提交**

```bash
cd /Users/like/code/dramaclaw && git add license-inventory.csv && git commit -s -m "chore(previz): refresh the license inventory

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01W5iVzVKKrRGTMJUYVJ1w1S"
```

---

## 收尾检查（全部任务做完后）

- `cd /Users/like/code/dramaclaw/frontend && npx tsc -p tsconfig.app.json --noEmit` 退出码 0。
- `npx vitest run` 只剩基线那 6 个失败。
- 浏览器手工过一遍 spec 的验收清单：建两台机位 → 按 1/2 切镜 → 监看跟着换、时间轴红框在直播机位上 → 添加本地 mp3 → 波形出现、播放有声 → 全局录制 → 画布上的视频节点有声且按切片换机位 → 连一个音频节点到预演台 → 「添加音频」里能选到它 → 卡片写「已接入音频 N 段」。
