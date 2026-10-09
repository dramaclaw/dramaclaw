// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  fetchFreezoneImageToBlockoutResult,
  submitFreezoneImageToBlockout,
  uploadFreezoneImage,
} from '@/api/ops';
import { aspectRatioFromImageDimensions } from '@/features/canvas/application/imageNodeSizing';
import { handedOffGenerationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { CANVAS_NODE_TYPES, DEFAULT_ASPECT_RATIO } from '@/features/canvas/domain/canvasNodes';
import { backendErrorToastMessage } from '@/lib/api-errors';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { landBlockoutResult, type PrevizHeldBlockout } from '../blockoutLanding';
import { hasBlockout, type PrevizBlockoutImportMode } from '../domain/blockout';
import {
  PREVIZ_BLOCKOUT_DESCRIPTION_MAX_CHARS,
  blockoutImageExtension,
  isAcceptedBlockoutImage,
  type PrevizImageSize,
} from '../domain/blockoutImage';
import { PREVIZ_PRIMITIVE_LIMIT, canAddPrimitive } from '../domain/limits';
import { usePrevizStore } from '../store';

export type PrevizBlockoutStage = 'idle' | 'uploading' | 'generating' | 'importing';

export interface PrevizBlockoutRequest {
  file: File;
  /** 对话框量出来的像素尺寸，只用来给画布上那张参考图节点定比例；量不出来就不给。 */
  imageSize?: PrevizImageSize | null;
  description: string;
  /** 对话框里的「画面核对」「渲染核对」勾选，原样交给后端。 */
  pictureCheck: boolean;
  renderCheck: boolean;
  /** 下拉里选的网关模型；空串表示用服务端默认，不随请求发出。 */
  model: string;
  mode: PrevizBlockoutImportMode;
}

export interface BlockoutGeneration {
  stage: PrevizBlockoutStage;
  held: PrevizHeldBlockout | null;
  /** 返回 true 表示任务已经提交、句柄已经写到节点上；结果由画布接回来。 */
  start: (request: PrevizBlockoutRequest) => Promise<boolean>;
  /** 按任务号把留着的那份结果再取一次、再导入一次，不再调模型。返回 true 表示已写进场景。 */
  retryImport: (mode: PrevizBlockoutImportMode) => Promise<boolean>;
}

const readNodeData = (nodeId: string) =>
  (useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data ?? {}) as Record<
    string,
    unknown
  >;

/**
 * 把这次用的参考图留在画布上：预演台左边接一个上传图节点。编辑器里看不到这张图，
 * 退出去以后它还在，下次想对照、想换一张再生成都找得到。
 */
function keepReferenceOnCanvas(
  nodeId: string,
  imageUrl: string,
  size: PrevizImageSize | null | undefined,
  label: (index: number) => string,
): void {
  const store = useCanvasStore.getState();
  const upstreamIds = new Set(
    store.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source),
  );
  const references = store.nodes.filter(
    (node) => upstreamIds.has(node.id) && node.type === CANVAS_NODE_TYPES.upload,
  ).length;
  store.addUpstreamUploadNode(
    nodeId,
    imageUrl,
    (size && aspectRatioFromImageDimensions(size.width, size.height)) || DEFAULT_ASPECT_RATIO,
    label(references + 1),
  );
}

/**
 * 「从参考图生成场景」的提交侧：上传 → 提交任务 → 把任务句柄写到预演台节点上。
 *
 * 到这里就结束了。等结果、取结果、写进场景归画布的恢复路径（resumeGeneration），
 * 跟图片/视频节点一个待遇：任务出现在任务中心，关掉对话框、关掉编辑器、刷新页面
 * 都不会把结果弄丢。进度和留着的结果也都从节点数据上读，而不是这个 hook 的本地态。
 */
export function useBlockoutGeneration(nodeId: string): BlockoutGeneration {
  const { t } = useTranslation();
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  // 「重新导入」在途标记。state 驱动按钮禁用，但 React 的那一拍到之前第二次点击已经
  // 进来了；ref 当场就能看到。
  const importingRef = useRef(false);
  const nodeData = useCanvasStore(
    (state) =>
      state.nodes.find((node) => node.id === nodeId)?.data as Record<string, unknown> | undefined,
  );
  const generating =
    nodeData?.isGenerating === true && nodeData.generationTaskType === 'freezone_image_to_blockout';
  const held = (nodeData?.blockoutHeld ?? null) as PrevizHeldBlockout | null;

  const start = useCallback(
    async ({ file, imageSize, description, pictureCheck, renderCheck, model, mode }: PrevizBlockoutRequest) => {
      if (readNodeData(nodeId).isGenerating === true) return false;
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
      // 白模会先被删掉，名额由它腾出来；够不够得等结果，由落地那一步兜底。
      const scene = usePrevizStore.getState().scene;
      if (!canAddPrimitive(scene) && !(mode === 'replace' && hasBlockout(scene))) {
        toast.error(t('previz.blockout.noRoom', { limit: PREVIZ_PRIMITIVE_LIMIT }));
        return false;
      }

      setUploading(true);
      try {
        // 名字里带时间戳，理由同 useAudioImport：同名上传会覆盖上一张参考图。
        const stamp = Date.now();
        const upload = await uploadFreezoneImage(
          project,
          file,
          `previz-blockout-${nodeId}-${stamp}.${blockoutImageExtension(file.name)}`,
        );
        const job = await submitFreezoneImageToBlockout(project, {
          sourceUrl: upload.url,
          description: description.trim().slice(0, PREVIZ_BLOCKOUT_DESCRIPTION_MAX_CHARS),
          pictureCheck,
          renderCheck,
          ...(model ? { model } : {}),
          canvasId: canvas ?? 'default',
          nodeId,
        });
        // 句柄一落到节点上，Canvas 的恢复扫描就会接管这个任务。
        useCanvasStore.getState().updateNodeData(nodeId, {
          ...handedOffGenerationTaskDescriptor(job),
          isGenerating: true,
          generationStartedAt: Date.now(),
          blockoutImportMode: mode,
          blockoutHeld: null,
        });
        keepReferenceOnCanvas(nodeId, upload.url, imageSize, (index) =>
          t('previz.blockout.referenceNodeName', { index }),
        );
        toast.info(t('previz.blockout.queued'));
        return true;
      } catch (error) {
        // 同 useAudioImport：上传走原始 apiClient，给人看的那条挂在 `.cause` 上。
        const cause = (error as { cause?: unknown } | null)?.cause;
        const shown = cause instanceof Error ? cause : error;
        toast.error(t('previz.blockout.failed', { message: backendErrorToastMessage(shown, t) }));
        return false;
      } finally {
        setUploading(false);
      }
    },
    [nodeId, t],
  );

  const retryImport = useCallback(
    async (mode: PrevizBlockoutImportMode) => {
      // 同一份结果取两次就会导入两次，白模翻倍；在途时第二次直接拒绝。
      if (importingRef.current) return false;
      const pending = (readNodeData(nodeId).blockoutHeld ?? null) as PrevizHeldBlockout | null;
      if (!pending) return false;
      const { project } = readUrl();
      if (!project) {
        toast.error(t('previz.blockout.noProject'));
        return false;
      }
      importingRef.current = true;
      setImporting(true);
      try {
        let body: unknown;
        try {
          body = await fetchFreezoneImageToBlockoutResult(project, pending.jobId);
        } catch (error) {
          toast.error(t('previz.blockout.failed', { message: backendErrorToastMessage(error, t) }));
          return false;
        }
        // 等结果的这段时间里节点上留的可能已经不是这一份了（又生成了一次、清掉了、
        // 节点没了）：取回来的那份就不该再写进去。
        const current = (readNodeData(nodeId).blockoutHeld ?? null) as PrevizHeldBlockout | null;
        if (!current || current.jobId !== pending.jobId) return false;
        const patch = landBlockoutResult({
          nodeId,
          nodeData: readNodeData(nodeId),
          jobId: pending.jobId,
          body,
          mode,
        });
        useCanvasStore.getState().updateNodeData(nodeId, patch);
        return patch.blockoutHeld === null;
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [nodeId, t],
  );

  return {
    stage: uploading ? 'uploading' : importing ? 'importing' : generating ? 'generating' : 'idle',
    held,
    start,
    retryImport,
  };
}
