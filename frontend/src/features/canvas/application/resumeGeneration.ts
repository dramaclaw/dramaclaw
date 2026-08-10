// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Persisting + resuming task_key-based generations across page reloads.
//
// Most canvas generations (image / video / audio / 3D / script / 反推提示词) submit
// a freezone job, get a `FreezoneJobRef`, then `await awaitTaskCompletion(task_key)`.
// That promise lives only in memory, so a page refresh used to drop the progress
// bar and stop polling entirely. We fix this by persisting the task identity on the
// node (so the 生成中 overlay re-appears from `generationStartedAt`) and re-attaching
// to the task API on reload via {@link resumeNodeGeneration}.

import type { CanvasNode, CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import {
  fetchFreezoneJobResult,
  fetchFreezoneReversePromptResult,
  fetchFreezoneStoryScriptResult,
  fetchFreezoneTextGenerateResult,
  type FreezoneJobRef,
} from '@/api/ops';
import {
  awaitTaskCompletion,
  isTaskCancelledError,
  isTaskPollTimeoutError,
  listTasks,
  type TaskState,
} from '@/api/tasks';
import { resolveErrorContent } from '@/features/canvas/application/errorDialog';
import { providerErrorMessage } from '@/lib/api-errors';
import {
  CURRENT_RUNTIME_SESSION_ID,
  extractRequestId,
} from '@/features/canvas/application/generationErrorReport';
import {
  isStaleGenerationTask,
  shouldWriteGenerationError,
} from '@/features/canvas/application/generationTaskArbitration';

type FreezoneTaskType = FreezoneJobRef['task_type'];

/**
 * The persisted handle that lets a refreshed page re-attach to a running job.
 * `generationTaskJobId` is intentionally separate from `generationJobId` — the
 * latter belongs to the canvasAiGateway image-job poller in Canvas.tsx and must
 * not be confused with a freezone task job id.
 */
export interface GenerationTaskDescriptor {
  generationTaskKey: string;
  generationTaskType: FreezoneTaskType;
  generationTaskJobId: string;
  // Index signature so the descriptor spreads cleanly into updateNodeData's
  // Partial<CanvasNodeData> union (some node-data members carry index signatures).
  [key: string]: unknown;
}

// Task keys whose awaitTaskCompletion promise is already owned by an in-session
// submit flow. The resume scanner must skip these — re-calling awaitTaskCompletion
// for the same key would overwrite the original resolver and strand that promise.
// This set is empty on a fresh page load, so persisted-but-orphaned tasks resume.
const sessionOwnedTaskKeys = new Set<string>();

/**
 * Build the patch that records a freezone job on a node right after submit so the
 * generation can be resumed after a refresh. Spread alongside the
 * `{ isGenerating: true, generationStartedAt }` patch each flow already writes.
 *
 * Also marks the task key as session-owned so {@link nodeNeedsGenerationResume}
 * won't double-attach while the originating flow is still awaiting it.
 */
export function generationTaskDescriptor(ref: FreezoneJobRef): GenerationTaskDescriptor {
  sessionOwnedTaskKeys.add(ref.task_key);
  return {
    generationTaskKey: ref.task_key,
    generationTaskType: ref.task_type,
    generationTaskJobId: ref.job_id,
  };
}

/**
 * 轮询脱离时写回节点的补丁。
 *
 * 只放掉 `generationJobId` —— 它是 canvasAiGateway 进程内 Map 的键，本来就活不
 * 过刷新，清掉正好让 Canvas.tsx 的轮询循环收工。`isGenerating` 和句柄三件套
 * 必须原样留着：{@link nodeNeedsGenerationResume} 要靠它们判定，少一个都会让
 * 「稍后刷新页面查看结果」变成空头支票。
 *
 * 单独提出来是为了能被测试直接断言 —— 内联在 Canvas.tsx 的 effect 里改错了没
 * 人拦得住。
 */
export const DETACHED_GENERATION_PATCH: Record<string, unknown> = {
  generationJobId: null,
};

/**
 * 这个节点的 `generationJobId` 是否值得本次会话去轮询。
 *
 * `generationJobId` 是 canvasAiGateway 那个模块级 `jobs` Map 的键,只在写下它的
 * 那个 JS 会话里有意义。刷新后 Map 是空的,再去轮询必然拿到 `not_found`,而
 * Canvas.tsx 的错误分支会把它当作生成失败:写 `generationError`、把
 * `isGenerating` 清成 false。于是同一个节点上两条路径打架 —— descriptor 那条
 * 正在 resume,jobId 这条在写失败,而且失败分支通常先到(查内存 Map 比发一次
 * listTasks 快)。一旦它先写进去,{@link nodeNeedsGenerationResume} 下次就不成立,
 * 恢复路径永久断掉。
 *
 * 所以轮询的前提是这个 id 由本次运行时会话写下。跨会话的遗留 id 交给
 * {@link staleGenerationJobPatch} 收拾。
 */
export function nodeOwnsLiveGenerationJob(node: CanvasNode): boolean {
  const data = node.data as Record<string, unknown>;
  const jobId = typeof data.generationJobId === 'string' ? data.generationJobId : '';
  return (
    data.isGenerating === true
    && jobId.length > 0
    && data.generationClientSessionId === CURRENT_RUNTIME_SESSION_ID
  );
}

/**
 * 上个会话遗留的 `generationJobId` 该怎么处理。返回 null 表示这个节点不用管。
 *
 * 两种遗留节点的命运不同:
 * - **有 descriptor**:清掉死 id,`isGenerating` 与句柄留着,让
 *   {@link resumeNodeGeneration} 独占恢复路径 —— 补丁正是
 *   {@link DETACHED_GENERATION_PATCH},跟 detached 分支同一份。
 * - **没有 descriptor**(本 PR 之前提交的老节点):后端句柄压根没落盘,谁都接不回
 *   来。原先的行为是轮询到 `not_found` 再写失败,结论一样,只是白跑一轮;这里
 *   直接给出终态,免得节点永远转圈。
 */
export function staleGenerationJobPatch(node: CanvasNode): Record<string, unknown> | null {
  const data = node.data as Record<string, unknown>;
  const jobId = typeof data.generationJobId === 'string' ? data.generationJobId : '';
  if (data.isGenerating !== true || jobId.length === 0) {
    return null;
  }
  if (data.generationClientSessionId === CURRENT_RUNTIME_SESSION_ID) {
    return null;
  }
  const taskKey = typeof data.generationTaskKey === 'string' ? data.generationTaskKey : '';
  if (taskKey.length > 0) {
    return DETACHED_GENERATION_PATCH;
  }
  return buildErrorPatch('image', new Error('生成任务已结束或不存在'));
}

/** 判定「任务不存在」需要连续 miss 的次数,以及每次之间的间隔。 */
export const TASK_MISS_CONFIRM_ATTEMPTS = 3;
export const TASK_MISS_CONFIRM_INTERVAL_MS = 5000;

/**
 * 反复确认任务是否真的从列表里消失了。
 *
 * 返回 true 只有一种情形:连续 {@link TASK_MISS_CONFIRM_ATTEMPTS} 次列表调用都
 * 成功、且都没有这个 task_key。任何一次命中就是 false(任务还在,交给
 * awaitTaskCompletion 按预算等);任何一次列表调用抛错也是 false —— 列不出来
 * 不等于任务没了,宁可去走完整轮询也别写失败。
 */
async function confirmTaskMissing(projectId: string, taskKey: string): Promise<boolean> {
  for (let attempt = 0; attempt < TASK_MISS_CONFIRM_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TASK_MISS_CONFIRM_INTERVAL_MS);
      });
    }
    let tasks: TaskState[];
    try {
      tasks = await listTasks(projectId);
    } catch {
      return false;
    }
    if (tasks.some((task) => task.task_key === taskKey)) {
      return false;
    }
  }
  return true;
}

type ResumeKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'ply'
  | 'script'
  | 'reverse-prompt'
  | 'text-generate';

function resumeKindForNode(type: CanvasNodeType, taskType: FreezoneTaskType): ResumeKind | null {
  switch (type) {
    case CANVAS_NODE_TYPES.imageGen:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.exportImage:
      return 'image';
    case CANVAS_NODE_TYPES.video:
      return 'video';
    case CANVAS_NODE_TYPES.audio:
      return 'audio';
    case CANVAS_NODE_TYPES.threeDWorld:
      return 'ply';
    case CANVAS_NODE_TYPES.script:
      return 'script';
    case CANVAS_NODE_TYPES.textAnnotation:
      return taskType === 'freezone_text_generate' ? 'text-generate' : 'reverse-prompt';
    default:
      return null;
  }
}

function resolveUrlFromResult(
  result: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!result) return null;
  for (const key of keys) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

// Mirror ThreeDWorldNode's pickPlyUrlFromResult so 3D scenes resume the same way.
function pickPlyUrlFromResult(result: TaskState['result'] | undefined): string | null {
  if (!result) return null;
  const candidates: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      if (/\.(ply|sog|splat|ksplat|spz)(\?|#|$)/i.test(value) || /scene_3gs|ply_fs|splat/i.test(value)) {
        candidates.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) visit(v, depth + 1);
    }
  };
  visit(result, 0);
  const sog = candidates.find((c) => /\.sog(\?|#|$)/i.test(c));
  if (sog) return sog;
  const packaged = candidates.find((c) => /\.(ksplat|splat|spz)(\?|#|$)/i.test(c));
  if (packaged) return packaged;
  const ply = candidates.find((c) => /\.ply(\?|#|$)/i.test(c));
  if (ply) return ply;
  return candidates[0] ?? null;
}

/** Fields cleared on every settle so the node leaves the 生成中 state cleanly. */
const CLEARED_TASK_FIELDS = {
  isGenerating: false,
  generationStartedAt: null,
  generationTaskKey: null,
  generationTaskType: null,
  generationTaskJobId: null,
} as const;

async function buildSuccessPatch(
  kind: ResumeKind,
  completed: TaskState,
  taskType: FreezoneTaskType,
  jobId: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  switch (kind) {
    case 'image': {
      let url = resolveUrlFromResult(completed.result, ['output_url', 'image_url', 'url']);
      if (!url && jobId) {
        url = await fetchFreezoneJobResult(projectId, taskType, jobId).then((r) => r.url).catch(() => null);
      }
      if (!url) {
        return { ...CLEARED_TASK_FIELDS, generationError: '生成未返回结果' };
      }
      return { ...CLEARED_TASK_FIELDS, imageUrl: url, previewImageUrl: url, generationError: null };
    }
    case 'video': {
      let url = resolveUrlFromResult(completed.result, ['video_url', 'output_url', 'url']);
      if (!url && jobId) {
        url = await fetchFreezoneJobResult(projectId, taskType, jobId).then((r) => r.url).catch(() => null);
      }
      if (!url) {
        return { ...CLEARED_TASK_FIELDS, generationError: '视频生成未返回结果' };
      }
      return {
        ...CLEARED_TASK_FIELDS,
        videoUrl: url,
        sourceFileName: null,
        generationError: null,
        generationErrorDetails: null,
        generationErrorRequestId: null,
      };
    }
    case 'audio': {
      let url = resolveUrlFromResult(completed.result, ['audio_url', 'output_url', 'url']);
      if (!url && jobId) {
        url = await fetchFreezoneJobResult(projectId, taskType, jobId).then((r) => r.url).catch(() => null);
      }
      if (!url) {
        return { ...CLEARED_TASK_FIELDS };
      }
      return { ...CLEARED_TASK_FIELDS, audioUrl: url, durationMs: null };
    }
    case 'ply': {
      const plyUrl = pickPlyUrlFromResult(completed.result);
      if (!plyUrl) {
        return { ...CLEARED_TASK_FIELDS, taskKey: null, errorMessage: '生成失败: 未能在 task.result 中找到 3D 世界地址' };
      }
      return { ...CLEARED_TASK_FIELDS, plyUrl, taskKey: null, errorMessage: null };
    }
    case 'script': {
      const result = await fetchFreezoneStoryScriptResult(projectId, jobId);
      return { ...CLEARED_TASK_FIELDS, scriptResult: result, scriptTitle: result.title ?? null };
    }
    case 'reverse-prompt': {
      const { prompt } = await fetchFreezoneReversePromptResult(projectId, jobId);
      if (prompt && prompt.trim().length > 0) {
        return { ...CLEARED_TASK_FIELDS, content: prompt };
      }
      return { ...CLEARED_TASK_FIELDS };
    }
    case 'text-generate': {
      const result = await fetchFreezoneTextGenerateResult(projectId, jobId);
      if (!result.generated_text.trim()) {
        return { ...CLEARED_TASK_FIELDS };
      }
      return {
        ...CLEARED_TASK_FIELDS,
        content: result.generated_text,
        model: result.model,
      };
    }
    default:
      return { ...CLEARED_TASK_FIELDS };
  }
}

function buildErrorPatch(kind: ResumeKind, error: unknown): Record<string, unknown> {
  if (isTaskCancelledError(error)) {
    // 用户主动终止过的任务恢复时只清理生成态，不当错误展示。
    return { ...CLEARED_TASK_FIELDS };
  }
  if (kind === 'ply') {
    const message = error instanceof Error ? error.message : String(error);
    return { ...CLEARED_TASK_FIELDS, taskKey: null, errorMessage: `生成失败: ${message}` };
  }
  if (kind === 'image' || kind === 'video') {
    const resolved = resolveErrorContent(error, kind === 'video' ? '视频生成失败' : '图像生成失败');
    const rawMessage = resolved.message;
    return {
      ...CLEARED_TASK_FIELDS,
      generationError: providerErrorMessage(rawMessage) ?? rawMessage,
      generationErrorDetails: resolved.details ?? rawMessage,
      generationErrorRequestId:
        extractRequestId(rawMessage) ?? extractRequestId(resolved.details),
    };
  }
  // audio / script / reverse-prompt / text-generate surface their own inline errors elsewhere;
  // just leave the 生成中 state.
  return { ...CLEARED_TASK_FIELDS };
}

/**
 * Re-attach to a running freezone task for a node that came back from storage
 * still flagged `isGenerating`. Resolves the result and writes it onto the node,
 * or records the failure — mirroring each flow's own success/error handling.
 *
 * Returns once the task settles (or is found to no longer exist). Safe to call
 * once per node; callers should dedupe.
 */
export async function resumeNodeGeneration(params: {
  node: CanvasNode;
  projectId: string;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  getNodeData?: (id: string) => Record<string, unknown> | null | undefined;
}): Promise<void> {
  const { node, projectId, updateNodeData, getNodeData } = params;
  const data = node.data as Record<string, unknown>;
  const taskKey = typeof data.generationTaskKey === 'string' ? data.generationTaskKey : '';
  const taskType =
    typeof data.generationTaskType === 'string' ? (data.generationTaskType as FreezoneTaskType) : null;
  const jobId = typeof data.generationTaskJobId === 'string' ? data.generationTaskJobId : '';
  const kind = taskType
    ? resumeKindForNode(node.type as CanvasNodeType, taskType)
    : null;

  if (!taskKey || !taskType || !kind) {
    return;
  }

  const readLatestNodeData = () =>
    getNodeData?.(node.id)
    ?? (node.data as Record<string, unknown>);

  // Quick pre-check: if the task no longer exists server-side (expired/cleaned),
  // avoid hanging on the full poll budget — clear the stuck 生成中 state now.
  //
  // 但一次 miss 不作数。列表接口会静默丢行:后端 list_tasks_for_project 对每行
  // 单独 _row_to_state,解析抛异常就只记一条 warning 然后跳过(task_state.py),
  // 任务其实还在库里跑。再算上提交后的可见性窗口,单次 miss 判「不存在」会把
  // 活着的任务写成失败 —— 这正是本 PR 要消除的那类误判,不该在恢复路径上重演。
  // 连续 miss 才算数:确认窗口约 10 秒,相对 20~35 分钟的完整预算可以忽略,
  // 却足以盖住瞬时漏项。
  if (await confirmTaskMissing(projectId, taskKey)) {
    const latestNodeData = readLatestNodeData();
    if (isStaleGenerationTask({ nodeData: latestNodeData, taskKey })) {
      return;
    }

    updateNodeData(node.id, buildErrorPatch(kind, new Error('生成任务已结束或不存在')));
    return;
  }

  try {
    // 按任务类型取预算，跟提交侧同一份口径（见 pollTimeoutForTaskType）。
    const completed = await awaitTaskCompletion(taskKey, projectId, { taskType });
    updateNodeData(node.id, await buildSuccessPatch(kind, completed, taskType, jobId, projectId));
  } catch (error) {
    console.warn('[resume-generation] task resume failed', { nodeId: node.id, taskKey, error });
    // 轮询超时只说明这一轮不再等了，任务还在后端跑：保留 isGenerating 与句柄，
    // 下次刷新再接一轮，别把还活着的任务写成失败。
    if (isTaskPollTimeoutError(error)) {
      return;
    }
    if (kind === 'image' || kind === 'video') {
      const latestNodeData = readLatestNodeData();
      if (isStaleGenerationTask({ nodeData: latestNodeData, taskKey })) {
        return;
      }
      if (!shouldWriteGenerationError({ nodeData: latestNodeData, taskKey, error })) {
        updateNodeData(node.id, { ...CLEARED_TASK_FIELDS });
        return;
      }
    }

    updateNodeData(node.id, buildErrorPatch(kind, error));
  }
}

/**
 * Whether a node restored from storage needs {@link resumeNodeGeneration}. Returns
 * false for tasks already being awaited by an in-session flow (see
 * {@link sessionOwnedTaskKeys}).
 */
export function nodeNeedsGenerationResume(node: CanvasNode): boolean {
  const data = node.data as Record<string, unknown>;
  const taskKey = typeof data.generationTaskKey === 'string' ? data.generationTaskKey : '';
  return data.isGenerating === true && taskKey.length > 0 && !sessionOwnedTaskKeys.has(taskKey);
}
