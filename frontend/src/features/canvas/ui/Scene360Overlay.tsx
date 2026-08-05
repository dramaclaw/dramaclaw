// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';
import { ArrowUp, ChevronDown, Globe2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { resolveFixedFeatureModelRequest } from '@/features/canvas/domain/fixedFeatureModelRequest';
import { CreditCostInline } from '@/components/credit-cost-inline';
import { useCanvasStore } from '@/stores/canvasStore';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { BillingRuleNotConfiguredError } from '@/lib/api-errors';
import {
  isAuthoritativeEmptyCatalog,
  useFreezoneImageModels,
} from '@/features/canvas/hooks/useFreezoneImageModels';
import { FREEZONE_IMAGE_FEATURES } from '@/features/canvas/application/freezoneImageFeatureBilling';
import {
  fetchFreezoneJobResult,
  submitFreezoneScene360,
  FREEZONE_SCENE_360_ASPECT_RATIOS,
  DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO,
  type FreezoneScene360AspectRatio,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { notifyTaskStillRunning } from '@/features/canvas/application/errorDialog';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { readUrl } from '@/lib/url-params';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { CANVAS_NODE_TOOLBAR_PILL_CLASS } from './nodeFrameStyles';
import { ZoomScaledToolbar } from './ZoomScaledToolbar';
import {
  NODE_FLOATING_PANEL_SURFACE_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
} from './nodeControlStyles';

const PANO_VIEWER_LAYOUT_WIDTH = 720;
const PANO_VIEWER_LAYOUT_HEIGHT = 420;

interface Scene360OverlayProps {
  node: CanvasNode;
  imageSource: string;
  onClose: () => void;
}

export const Scene360Overlay = memo(
  ({ node, imageSource, onClose }: Scene360OverlayProps) => {
    const { t } = useTranslation();
    const addNode = useCanvasStore((state) => state.addNode);
    const addEdge = useCanvasStore((state) => state.addEdge);
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const findNodePosition = useCanvasStore((state) => state.findNodePosition);
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const imageCatalog = useFreezoneImageModels();
    const imageModels = imageCatalog.models;
    const selectedModel = imageModels[0];
    // 后台确实一个图片模型都没配时禁止提交：这个面板没有模型选择器，提交下去
    // 后端拿不到目录条目会直接 409，先让用户点一下再报错是最糟的体验。
    const catalogIsEmpty = isAuthoritativeEmptyCatalog(imageCatalog);
    // 全景没有尺寸/画质选择器，按后台对该模型配置的档位取默认值；模型没配
    // 画质就不下发 quality。报价与提交必须来自同一次解析，见
    // `resolveFixedFeatureModelRequest` 的注释。
    const modelRequest = useMemo(
      () => resolveFixedFeatureModelRequest(selectedModel),
      [selectedModel],
    );
    const panoCost = useGenerationCreditCost(
      'feature',
      selectedModel ? FREEZONE_IMAGE_FEATURES.panorama : null,
      {
        surface: 'canvas',
        params: modelRequest.billingParams,
      },
    );
    const billingRuleMissing =
      panoCost.error instanceof BillingRuleNotConfiguredError;
    const submitDisabled = billingRuleMissing || catalogIsEmpty;
    const costDisplay =
      panoCost.data?.data.display ??
      (billingRuleMissing ? t('common.billingRuleNotConfiguredShort') : null);

    // 全景输出比例（生成参数，仅影响本次出图，不改节点的展示比例）。
    const [aspectRatio, setAspectRatio] = useState<FreezoneScene360AspectRatio>(
      DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO,
    );

    const handleSubmit = useCallback(async () => {
      // 按钮已经禁用，这里再挡一道：没有模型就绝不该发出请求。
      if (catalogIsEmpty) return;
      const project = readUrl().project;
      if (!project) {
        console.error('[scene-360] no project in URL — cannot submit');
        return;
      }

      const position = findNodePosition(
        node.id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
      );
      const generationStartedAt = Date.now();
      const nextNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        position,
        {
          displayName: t('scene360.label'),
          imageUrl: null,
          previewImageUrl: null,
          aspectRatio,
          resultKind: 'generic',
          output_role: 'scene_360_candidate',
          media_kind: 'pano360',
          isGenerating: true,
          generationStartedAt,
        },
      );
      addEdge(node.id, nextNodeId);
      setSelectedNode(nextNodeId);
      onClose();

      try {
        const ref = await submitFreezoneScene360(project, {
          referenceUrl: imageSource.split('?')[0],
          aspectRatio,
          ...modelRequest.submit,
        });
        updateNodeData(nextNodeId, generationTaskDescriptor(ref));
        const completed = await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
        const directUrl = completed.result?.['output_url'] as string | undefined;
        let url = directUrl;
        if (!url) {
          const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
          url = fallback.url;
        }
        updateNodeData(nextNodeId, {
          imageUrl: url,
          previewImageUrl: url,
          aspectRatio,
          output_role: 'scene_360_candidate',
          media_kind: 'pano360',
          isGenerating: false,
          generationStartedAt: null,
          generationError: null,
        });

        const viewerPosition = findNodePosition(
          nextNodeId,
          PANO_VIEWER_LAYOUT_WIDTH,
          PANO_VIEWER_LAYOUT_HEIGHT,
        );
        const viewerNodeId = addNode(CANVAS_NODE_TYPES.pano360Viewer, viewerPosition);
        addEdge(nextNodeId, viewerNodeId);
      } catch (err) {
        // 轮询超时 ≠ 生成失败：后端还在跑，节点上的任务句柄仍可续接。
        // 写错误横幅会把一个还活着的任务标成失败，并清掉句柄。
        if (isTaskPollTimeoutError(err)) {
          notifyTaskStillRunning(t);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error('[scene-360] generation failed', err);
        updateNodeData(nextNodeId, {
          isGenerating: false,
          generationStartedAt: null,
          generationError: message,
        });
      }
    }, [
      addEdge,
      addNode,
      aspectRatio,
      catalogIsEmpty,
      findNodePosition,
      imageSource,
      modelRequest,
      node,
      onClose,
      setSelectedNode,
      t,
      updateNodeData,
    ]);

    return (
      <ReactFlowNodeToolbar
        nodeId={node.id}
        isVisible
        position={Position.Bottom}
        align="center"
        offset={12}
        className={NODE_TOOLBAR_CLASS}
      >
        {/* 操作区跟随画布缩放（align=center → 锚点顶边中点，贴节点底边）。 */}
        <ZoomScaledToolbar origin="top center">
        <div
          className={`flex min-w-[420px] items-center gap-2 ${CANVAS_NODE_TOOLBAR_PILL_CLASS}`}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-dark/70 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
            onClick={onClose}
            title={t('scene360.exit')}
          >
            <X className="h-4 w-4" />
          </button>

          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-xs text-text-dark">
            <Globe2 className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            <span className="truncate font-medium">{t('scene360.label')}</span>
          </div>

          <AspectRatioDropdown
            value={aspectRatio}
            onChange={setAspectRatio}
            label={t('scene360.aspectRatioLabel')}
          />
          <CreditCostInline
            display={costDisplay}
            promotion={panoCost.data?.data.promotion}
          />

          <button
            type="button"
            disabled={submitDisabled}
            className={`${NODE_GENERATE_BUTTON_BASE_CLASS} shrink-0 ${
              submitDisabled
                ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                : NODE_GENERATE_BUTTON_ENABLED_CLASS
            }`}
            onClick={handleSubmit}
            title={
              catalogIsEmpty
                ? t('modelParams.noModelsAvailable')
                : t('scene360.submit')
            }
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
        </ZoomScaledToolbar>
      </ReactFlowNodeToolbar>
    );
  },
);

Scene360Overlay.displayName = 'Scene360Overlay';

interface AspectRatioDropdownProps {
  value: FreezoneScene360AspectRatio;
  onChange: (value: FreezoneScene360AspectRatio) => void;
  label: string;
}

function AspectRatioDropdown({ value, onChange, label }: AspectRatioDropdownProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [isOpen]);

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={label}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-xs font-medium text-text-dark/88 transition-colors hover:text-text-dark"
      >
        <span>{value}</span>
        <ChevronDown className="h-3 w-3 text-text-muted" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          role="listbox"
          className={`absolute bottom-full right-0 z-50 mb-2 min-w-[88px] p-1 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`}
          onClick={(event) => event.stopPropagation()}
        >
          {FREEZONE_SCENE_360_ASPECT_RATIOS.map((ratio) => {
            const isActive = ratio === value;
            return (
              <button
                key={ratio}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  onChange(ratio);
                  setIsOpen(false);
                }}
                className={`flex w-full items-center rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-white/[0.12] text-text-dark'
                    : 'text-text-dark/50 hover:bg-white/[0.07] hover:text-text-dark/78'
                }`}
              >
                {ratio}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
