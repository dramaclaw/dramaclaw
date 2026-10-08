// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 「参考图转白模」结果的落地：任务由画布的恢复路径（resumeGeneration）等到头，
// 取回结果后交给这里写进场景。编辑器开着还是关着，落地都得成立。

// 取 i18next 默认实例而不是 `@/i18n`，理由同 resumeGeneration.ts：这条链路会被
// 画布底层 import，不能把 react-i18next 一起拖进来。
import i18n from 'i18next';
import { toast } from 'sonner';

import { isTaskCancelledError } from '@/api/tasks';
import { backendErrorToastMessage } from '@/lib/api-errors';

import {
  planBlockoutImport,
  type PrevizBlockoutImportMode,
  type PrevizBlockoutPayload,
  type PrevizBlockoutHoldReason,
} from './domain/blockout';
import { createDefaultScene } from './domain/scene';
import { buildNodeScenePatch, loadNodeScene } from './nodeScene';
import { usePrevizStore } from './store';
import { blockoutRejectionMessage } from './ui/blockoutMessages';

/**
 * 生成成功、但没能写进场景的那份结果。只记任务号：结果留在后端，腾出名额后按号
 * 再取一次即可，不用再花一次积分。存在节点数据上，刷新页面也还在。
 */
export interface PrevizHeldBlockout {
  jobId: string;
  rejection: PrevizBlockoutHoldReason;
}

/** 提示里最多列几条检查意见，多了 toast 撑不下。 */
const SHOWN_WARNINGS = 3;
/** 多行意见按默认 2.2 秒根本读不完；给的时间同 SkillNode 里提交被拒的那条。 */
const WARNINGS_TOAST_MS = 8_000;

/** 任务结果是跨仓库契约上的不可信输入：形状不对就当成空结果，由导入那一步统一拒绝。 */
export function readBlockoutResult(body: unknown): {
  payload: PrevizBlockoutPayload;
  warnings: string[];
} {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const reference = record.reference_camera_id;
  return {
    payload: {
      objects: Array.isArray(record.objects) ? record.objects : [],
      referenceCameraId: typeof reference === 'string' ? reference : null,
    },
    warnings: Array.isArray(record.warnings)
      ? record.warnings.filter((line): line is string => typeof line === 'string')
      : [],
  };
}

/** 空结果留着也没用，其余的拒绝都是「这份结果本身没问题，只是现在放不进去」。 */
function holdOrDrop(jobId: string, rejection: PrevizBlockoutHoldReason): PrevizHeldBlockout | null {
  toast.error(blockoutRejectionMessage(rejection, i18n.t));
  return rejection.reason === 'empty' ? null : { jobId, rejection };
}

/**
 * 任务已经完成、积分已经扣了，只是结果这一趟没取回来：留着任务号，「重新导入」按号
 * 再取一次。清成什么都没发生过，这份花了钱的结果就找不回来了。
 */
export function holdUnfetchedBlockout(jobId: string, error: unknown): PrevizHeldBlockout {
  const rejection = {
    reason: 'fetch-failed',
    message: backendErrorToastMessage(error, i18n.t),
  } as const;
  toast.error(blockoutRejectionMessage(rejection, i18n.t));
  return { jobId, rejection };
}

function reportLanded(count: number, warnings: string[]): void {
  const done = i18n.t('previz.blockout.done', { count });
  if (warnings.length === 0) {
    toast.success(done);
    return;
  }
  // 全局 toaster 一次只显示一条：分成「已生成」+「意见」两条，后一条会把前一条顶掉。
  // 合成一条，「已生成」做标题、意见做正文。
  toast.warning(done, {
    description: [
      i18n.t('previz.blockout.warnings', { count: warnings.length }),
      ...warnings.slice(0, SHOWN_WARNINGS),
    ].join('\n'),
    duration: WARNINGS_TOAST_MS,
  });
}

/**
 * 把取回的结果写进预演台节点，返回要合进 node.data 的补丁。
 *
 * 编辑器正开着这个节点时，结果进 store（一步可撤销），场景由编辑器的自动保存写回
 * 节点；补丁里就不带 `scene`，否则会跟自动保存打架。其余情形——编辑器关着、或开着
 * 别的节点——直接从节点数据里读场景、导入、写回。
 *
 * 放不下时把任务号留在 `blockoutHeld` 上，对话框据此提供「再试一次」。
 */
export function landBlockoutResult(params: {
  nodeId: string;
  nodeData: Record<string, unknown>;
  jobId: string;
  body: unknown;
  mode: PrevizBlockoutImportMode;
}): Record<string, unknown> {
  const { nodeId, nodeData, jobId, body, mode } = params;
  const { payload, warnings } = readBlockoutResult(body);

  const store = usePrevizStore.getState();
  if (store.editingNodeId === nodeId) {
    const before = new Set(store.scene.objects);
    const rejection = store.importBlockout(payload, mode);
    if (rejection) return { blockoutHeld: holdOrDrop(jobId, rejection) };
    // 数实际落进场景的几何体，而不是结果里报的数：导入会丢掉不认识的记录。
    const count = usePrevizStore
      .getState()
      .scene.objects.filter((object) => object.kind === 'prop' && !before.has(object)).length;
    reportLanded(count, warnings);
    return { blockoutHeld: null };
  }

  let scene;
  if (nodeData.scene == null) {
    scene = createDefaultScene();
  } else {
    const loaded = loadNodeScene(nodeData.scene);
    if (!loaded.ok) {
      // 节点场景是更新版本写的，这个前端读不了，更不能拿旧结构盖掉它。结果本身
      // 没问题，留着：升级之后同一个任务号还能导入。
      return { blockoutHeld: holdOrDrop(jobId, { reason: 'version-too-new' }) };
    }
    scene = loaded.scene;
  }

  const plan = planBlockoutImport(scene, payload, mode);
  if (!plan.ok) return { blockoutHeld: holdOrDrop(jobId, plan.rejection) };
  const flush = buildNodeScenePatch(plan.scene);
  if (!flush.ok) {
    return { blockoutHeld: holdOrDrop(jobId, { reason: 'too-large', bytes: flush.bytes }) };
  }

  const added = new Set(plan.addedIds);
  const count = plan.scene.objects.filter(
    (object) => object.kind === 'prop' && added.has(object.id),
  ).length;
  reportLanded(count, warnings);
  return { ...flush.patch, blockoutHeld: null };
}

/** 任务没跑成：取消是消息，其余是错误。文案跟提交侧同一套。 */
export function reportBlockoutFailure(error: unknown): void {
  if (isTaskCancelledError(error)) {
    toast.info(i18n.t('previz.blockout.cancelled'));
    return;
  }
  // 同 useAudioImport：上传走原始 apiClient，给人看的那条挂在 `.cause` 上。
  const cause = (error as { cause?: unknown } | null)?.cause;
  const shown = cause instanceof Error ? cause : error;
  toast.error(
    i18n.t('previz.blockout.failed', { message: backendErrorToastMessage(shown, i18n.t) }),
  );
}
