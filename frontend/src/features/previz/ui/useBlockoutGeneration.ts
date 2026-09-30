// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  fetchFreezoneImageToBlockoutResult,
  submitFreezoneImageToBlockout,
  uploadFreezoneImage,
} from '@/api/ops';
import { TaskPollTimeoutError, awaitTaskCompletion, isTaskCancelledError } from '@/api/tasks';
import { backendErrorToastMessage } from '@/lib/api-errors';
import { readUrl } from '@/lib/url-params';

import {
  hasBlockout,
  type PrevizBlockoutImportMode,
  type PrevizBlockoutPayload,
  type PrevizBlockoutRejection,
} from '../domain/blockout';
import {
  PREVIZ_BLOCKOUT_DESCRIPTION_MAX_CHARS,
  blockoutImageExtension,
  isAcceptedBlockoutImage,
} from '../domain/blockoutImage';
import { PREVIZ_PRIMITIVE_LIMIT, canAddPrimitive } from '../domain/limits';
import { usePrevizStore } from '../store';
import { blockoutRejectionMessage } from './blockoutMessages';

export type PrevizBlockoutStage = 'idle' | 'uploading' | 'generating';

/** 提示里最多列几条检查意见，多了 toast 撑不下。 */
const SHOWN_WARNINGS = 3;

export interface PrevizBlockoutRequest {
  file: File;
  description: string;
  /** 对话框里的「画面核对」勾选，原样交给后端。 */
  pictureCheck: boolean;
  mode: PrevizBlockoutImportMode;
}

/** 生成成功、但没能写进场景的那份结果。留着它，腾出名额后不用再花一次积分。 */
export interface PrevizHeldBlockout {
  payload: PrevizBlockoutPayload;
  warnings: string[];
  rejection: PrevizBlockoutRejection;
}

export interface BlockoutGeneration {
  stage: PrevizBlockoutStage;
  held: PrevizHeldBlockout | null;
  /** 返回 true 表示白模已经写进场景。 */
  start: (request: PrevizBlockoutRequest) => Promise<boolean>;
  /** 把留着的那份结果再导入一次，不发任何请求。 */
  retryImport: (mode: PrevizBlockoutImportMode) => boolean;
  /** 不等了：在途的那次生成落地时不再导入，留着的结果也一并放掉。 */
  abandon: () => void;
}

interface Progress {
  /** 这份进度属于哪个预演台节点。编辑器换了节点，上一个节点的进度就不该再显示。 */
  owner: string;
  stage: PrevizBlockoutStage;
  held: PrevizHeldBlockout | null;
}

/** 任务结果是跨仓库契约上的不可信输入：形状不对就当成空结果，由导入那一步统一拒绝。 */
function readResult(body: unknown): { payload: PrevizBlockoutPayload; warnings: string[] } {
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

/**
 * 「从参考图生成场景」的整条流程：上传 → 提交任务 → 等任务 → 取结果 → 导入。
 *
 * 一次生成要等几分钟，这期间对话框可能被关掉、编辑器可能被关掉再打开另一个节点。
 * store 是模块级单例，迟到的结果要是照样导入，白模就落进了别人的场景——所以每次
 * 生成领一个号，每个 await 之后都先对号。
 */
export function useBlockoutGeneration(nodeId: string): BlockoutGeneration {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<Progress>({ owner: nodeId, stage: 'idle', held: null });
  const serial = useRef(0);
  /** 在途那次生成的号；没有在途的为 null。 */
  const active = useRef<number | null>(null);

  useEffect(
    () => () => {
      active.current = null;
    },
    [nodeId],
  );

  /** 导入并报告结果。返回拒绝理由，成功为 null。 */
  const land = useCallback(
    (payload: PrevizBlockoutPayload, warnings: string[], mode: PrevizBlockoutImportMode) => {
      const before = new Set(usePrevizStore.getState().scene.objects);
      const rejection = usePrevizStore.getState().importBlockout(payload, mode);
      if (rejection) {
        toast.error(blockoutRejectionMessage(rejection, t));
        return rejection;
      }
      // 数实际落进场景的几何体，而不是结果里报的数：导入会丢掉不认识的记录。
      const count = usePrevizStore
        .getState()
        .scene.objects.filter((object) => object.kind === 'prop' && !before.has(object)).length;
      toast.success(t('previz.blockout.done', { count }));
      if (warnings.length > 0) {
        toast.warning(t('previz.blockout.warnings', { count: warnings.length }), {
          description: warnings.slice(0, SHOWN_WARNINGS).join('\n'),
        });
      }
      return null;
    },
    [t],
  );

  const start = useCallback(
    async ({ file, description, pictureCheck, mode }: PrevizBlockoutRequest) => {
      if (active.current !== null) return false;
      const verdict = isAcceptedBlockoutImage(file.name, file.size);
      if (verdict === 'extension') {
        toast.error(t('previz.blockout.badExtension'));
        return false;
      }
      if (verdict === 'size') {
        toast.error(t('previz.blockout.tooLarge'));
        return false;
      }
      const { project, canvas } = readUrl();
      if (!project) {
        toast.error(t('previz.blockout.noProject'));
        return false;
      }
      // 一个名额都没有是现在就知道的事，别等花完积分再说放不下。替换模式下已有的
      // 白模会先被删掉，名额由它腾出来；够不够得等结果，由导入那一步兜底。
      const scene = usePrevizStore.getState().scene;
      if (!canAddPrimitive(scene) && !(mode === 'replace' && hasBlockout(scene))) {
        toast.error(t('previz.blockout.noRoom', { limit: PREVIZ_PRIMITIVE_LIMIT }));
        return false;
      }

      serial.current += 1;
      const mine = serial.current;
      active.current = mine;
      const alive = () => active.current === mine;
      setProgress({ owner: nodeId, stage: 'uploading', held: null });
      try {
        // 名字里带时间戳，理由同 useAudioImport：同名上传会覆盖上一张参考图。
        const stamp = Date.now();
        const upload = await uploadFreezoneImage(
          project,
          file,
          `previz-blockout-${nodeId}-${stamp}.${blockoutImageExtension(file.name)}`,
        );
        if (!alive()) return false;
        setProgress({ owner: nodeId, stage: 'generating', held: null });
        const job = await submitFreezoneImageToBlockout(project, {
          sourceUrl: upload.url,
          description: description.trim().slice(0, PREVIZ_BLOCKOUT_DESCRIPTION_MAX_CHARS),
          pictureCheck,
          canvasId: canvas ?? 'default',
          nodeId,
        });
        if (!alive()) return false;
        await awaitTaskCompletion(job.task_key, project, { taskType: job.task_type });
        if (!alive()) return false;
        const body: unknown = await fetchFreezoneImageToBlockoutResult(project, job.job_id);
        if (!alive()) return false;

        const { payload, warnings } = readResult(body);
        const rejection = land(payload, warnings, mode);
        // 空结果留着也没用，其余的拒绝都是「这份结果本身没问题，只是现在放不进去」。
        const held =
          rejection && rejection.reason !== 'empty' ? { payload, warnings, rejection } : null;
        setProgress({ owner: nodeId, stage: 'idle', held });
        return rejection === null;
      } catch (error) {
        if (!alive()) return false;
        setProgress({ owner: nodeId, stage: 'idle', held: null });
        if (isTaskCancelledError(error)) {
          toast.info(t('previz.blockout.cancelled'));
        } else if (error instanceof TaskPollTimeoutError) {
          // 页面跟丢了任务，不等于任务失败；但这一页已经没法把结果接回来了。
          toast.warning(t('previz.blockout.detached'));
        } else {
          // 同 useAudioImport：上传走原始 apiClient，给人看的那条挂在 `.cause` 上。
          const cause = (error as { cause?: unknown } | null)?.cause;
          const shown = cause instanceof Error ? cause : error;
          toast.error(t('previz.blockout.failed', { message: backendErrorToastMessage(shown, t) }));
        }
        return false;
      } finally {
        if (alive()) active.current = null;
      }
    },
    [land, nodeId, t],
  );

  const held = progress.owner === nodeId ? progress.held : null;

  const retryImport = useCallback(
    (mode: PrevizBlockoutImportMode) => {
      if (!held) return false;
      const rejection = land(held.payload, held.warnings, mode);
      setProgress({
        owner: nodeId,
        stage: 'idle',
        held: rejection && rejection.reason !== 'empty' ? { ...held, rejection } : null,
      });
      return rejection === null;
    },
    [held, land, nodeId],
  );

  const abandon = useCallback(() => {
    active.current = null;
    setProgress({ owner: nodeId, stage: 'idle', held: null });
  }, [nodeId]);

  return {
    stage: progress.owner === nodeId ? progress.stage : 'idle',
    held,
    start,
    retryImport,
    abandon,
  };
}
