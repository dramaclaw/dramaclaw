// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useEffect, useMemo, useState } from 'react';
import {
  Handle,
  Position,
  useStore,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { AlertTriangle, Image as ImageIcon, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_RESIZE_MIN_EDGE,
  type CanvasNodeType,
  type ExportImageNodeData,
  type ImageEditNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  aspectRatioFromImageDimensions,
  resolveMinEdgeFittedSize,
  resolveResizeMinConstraintsByAspect,
  shouldForceNaturalImageSize,
} from '@/features/canvas/application/imageNodeSizing';
import {
  nodeBodyImageMeasurement,
  nodeBodyImageSrc,
  nodeBodyRecordDescribesImage,
  planNaturalSizeRecordWrite,
  readNodeNaturalSize,
  resolveImageDisplayUrl,
  shouldUseOriginalImageByZoom,
  withImageCacheBust,
} from '@/features/canvas/application/imageData';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { DirectorControlBundleBadge } from '@/features/canvas/ui/DirectorControlBundleBadge';
import { CANVAS_NODE_PANEL_SURFACE_CLASS, canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import {
  CandidateBindingBadges,
  hasMainlineContexts,
} from '@/features/freezone/context/NodeContextBadges';
import { collectCandidateBindingsForNode } from '@/features/freezone/context/mainlineContext';
import { RegenerateButton } from '@/features/canvas/ui/RegenerateButton';
import {
  canRegenerateExportImageNode,
  regenerateExportImageNode,
} from '@/features/canvas/application/regenerateExportNode';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { useNaturalSizeRecordTrust } from '@/features/canvas/hooks/useNaturalSizeRecordTrust';
import { useNodeBodyVariantBudget } from '@/features/canvas/hooks/useNodeBodyVariantBudget';
import { useCanvasStore } from '@/stores/canvasStore';
import { useShallow } from 'zustand/react/shallow';

type ImageNodeProps = NodeProps & {
  id: string;
  data: ImageEditNodeData | ExportImageNodeData;
  selected?: boolean;
};

function resolveNodeDimension(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.round(value);
  }
  return fallback;
}

export const ImageNode = memo(({ id, data, selected, type, width, height }: ImageNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeSize = useCanvasStore((state) => state.updateNodeSize);
  // 只订阅连到本节点的边(useShallow 逐元素比较),避免拖动无关节点触发重渲染。
  const connectedEdges = useCanvasStore(
    useShallow((state) => state.edges.filter((edge) => edge.source === id || edge.target === id)),
  );
  // 只订阅「是否该用原图」这个离散布尔(在 zoom 阈值处翻转),而非连续 zoom 值 ——
  // 缩放过程中本节点只在跨过阈值的那一帧重渲染,而非每一帧。
  const preferOriginalImage = useStore((state) => shouldUseOriginalImageByZoom(state.transform[2]));
  const [now, setNow] = useState(() => Date.now());
  const isExportResultNode = type === CANVAS_NODE_TYPES.exportImage;
  const { isGenerating } = useNodeGenerationTaskState(data);
  const generationError =
    typeof (data as { generationError?: unknown }).generationError === 'string'
      ? ((data as { generationError?: string }).generationError ?? '').trim()
      : '';
  const hasGenerationError =
    isExportResultNode && !isGenerating && !data.imageUrl && generationError.length > 0;
  const generationErrorRequestId =
    typeof (data as { generationErrorRequestId?: unknown }).generationErrorRequestId === 'string' &&
    (data as { generationErrorRequestId?: string }).generationErrorRequestId
      ? (data as { generationErrorRequestId?: string }).generationErrorRequestId ?? ''
      : '';
  const generationStartedAt =
    typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const generationDurationMs =
    typeof data.generationDurationMs === 'number' ? data.generationDurationMs : 60000;
  const resolvedAspectRatio = data.aspectRatio || DEFAULT_ASPECT_RATIO;
  const compactSize = resolveMinEdgeFittedSize(resolvedAspectRatio, {
    minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
    minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
  });
  const resizeConstraints = resolveResizeMinConstraintsByAspect(resolvedAspectRatio, {
    minWidth: EXPORT_RESULT_NODE_RESIZE_MIN_EDGE,
    minHeight: EXPORT_RESULT_NODE_RESIZE_MIN_EDGE,
  });
  const resizeMinWidth = resizeConstraints.minWidth;
  const resizeMinHeight = resizeConstraints.minHeight;
  const resolvedWidth = resolveNodeDimension(width, compactSize.width);
  const resolvedHeight = resolveNodeDimension(height, compactSize.height);
  // 这一格要多少设备像素，决定挑哪一档副本（拉大的节点会一路挑到原图）。
  const bodyVariantBudget = useNodeBodyVariantBudget({
    width: resolvedWidth,
    height: resolvedHeight,
  });
  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(type as CanvasNodeType, data),
    [data, type]
  );
  const hasMainlineContext = hasMainlineContexts(
    (data as { mainline_context?: unknown }).mainline_context,
  );
  const candidateBindingRoles = useMemo(
    () => collectCandidateBindingsForNode(connectedEdges, id).map((binding) => binding.role),
    [connectedEdges, id],
  );

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    if (!isGenerating) {
      return;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 120);

    return () => {
      window.clearInterval(timer);
    };
  }, [isGenerating]);

  const waitedMinutes = useMemo(() => {
    if (!isGenerating || generationStartedAt === null) {
      return 0;
    }

    const elapsed = Math.max(0, now - generationStartedAt);
    return Math.floor(elapsed / 60000);
  }, [generationStartedAt, isGenerating, now]);

  const waitingResultText = useMemo(() => {
    if (!isExportResultNode) {
      return t('node.imageNode.selectToEdit');
    }

    if (!isGenerating || waitedMinutes < 2) {
      return t('node.imageNode.waitingResult');
    }

    return t('node.imageNode.waitingResultDelayed', { minutes: waitedMinutes });
  }, [isExportResultNode, isGenerating, t, waitedMinutes]);

  // 已记录的原图像素尺寸；决定主体图能不能喂降采样副本，也是角标的初值。
  // 跟着 data 的引用走（与下面的 imageSource 同一节奏），避免每次渲染都换新对象。
  const recordedNaturalSize = useMemo(() => readNodeNaturalSize(data), [data]);

  // 记录归属的是哪张图。只认「换图」，不认缩放：preferOriginalImage 翻转时下面
  // 那一支会挑到另一个字段，但那是同一个节点的两种画法，不该当成换了图。
  const recordSubject = useMemo(() => {
    const picked = data.previewImageUrl || data.imageUrl;
    if (!picked) return null;
    const committedAt = (data as { committed_at?: unknown }).committed_at;
    return `${picked}\u0000${typeof committedAt === 'string' ? committedAt : ''}`;
  }, [data]);

  const { distrusted, distrustRecord, trustAgain } = useNaturalSizeRecordTrust(recordSubject);

  const bodyImage = useMemo(() => {
    const picked = preferOriginalImage
      ? data.imageUrl || data.previewImageUrl
      : data.previewImageUrl || data.imageUrl;
    if (!picked) return null;
    const resolved = resolveImageDisplayUrl(
      withImageCacheBust(picked, (data as { committed_at?: unknown }).committed_at as string | undefined),
    );
    // 节点主体把整幅原图解码进几百 CSS px 的盒子里；变体只在真实尺寸已知、
    // 且没放大到细看那一档时启用，详见 nodeBodyImageSrc 的注释。
    return nodeBodyImageSrc(resolved, recordedNaturalSize, {
      preferOriginal: preferOriginalImage || distrusted,
      requiredEdge: bodyVariantBudget,
    });
  }, [
    bodyVariantBudget,
    data,
    data.imageUrl,
    data.previewImageUrl,
    distrusted,
    preferOriginalImage,
    recordedNaturalSize,
  ]);
  const imageSource = bodyImage?.src ?? null;

  // 获取原图 URL 用于查看器
  const originalImageUrl = useMemo(() => {
    if (!data.imageUrl) return null;
    return resolveImageDisplayUrl(data.imageUrl);
  }, [data.imageUrl]);

  // Natural pixel size of the displayed image, mirrored from data when present
  // (persisted by the onLoad handler below) and refreshed on every <img> load so
  // the resolution badge shows even for nodes whose size already matched (those
  // skip the persist branch). Drives a top-right resolution chip like the video node.
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(
    () => readNodeNaturalSize(data),
  );

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} p-0 transition-colors duration-150
        ${hasGenerationError
          ? (selected
            ? 'border-red-400 shadow-[0_0_0_1px_rgba(248,113,113,0.42)]'
            : 'border-red-500/70 bg-[rgba(127,29,29,0.12)] hover:border-red-400/80 dark:border-red-500/70 dark:hover:border-red-400/80')
          : canvasNodeFrameClass({ selected, mainline: hasMainlineContext })}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={isExportResultNode
          ? <ImageIcon className="h-4 w-4" />
          : <Sparkles className="h-4 w-4" />}
        titleText={resolvedTitle}
        titleClassName="inline-block max-w-[220px] truncate whitespace-nowrap align-bottom"
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />
      <CandidateBindingBadges roles={candidateBindingRoles} />

      {data.imageUrl && naturalSize ? (
        <div
          className="absolute -top-7 right-1 z-20 flex items-center gap-1 rounded-md border border-white/10 bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/70 backdrop-blur-sm"
          title={t('node.imageNode.resolution')}
        >
          <ImageIcon className="h-3 w-3 text-white/45" />
          {naturalSize.width}×{naturalSize.height}
        </div>
      ) : null}

      <div
        className={`relative h-full w-full overflow-hidden rounded-[var(--node-radius)] ${hasGenerationError ? 'bg-[rgba(127,29,29,0.2)]' : 'bg-bg-dark'}`}
      >
        <DirectorControlBundleBadge bundle={(data as { director_control_bundle?: unknown }).director_control_bundle} />
        {data.imageUrl ? (
          <CanvasNodeImage
            src={imageSource ?? ''}
            alt={isExportResultNode ? t('node.imageNode.resultAlt') : t('node.imageNode.generatedAlt')}
            viewerSourceUrl={originalImageUrl}
            onLoad={(event) => {
              // 记录描述的不是这张图：降采样副本上量不出源图真尺寸。第一次退回
              // 原图重测（preferOriginal 会让下一轮 downscaled 为 false，不会来回
              // 抖）；已经退过一次还是对不上，就什么都不写——记录和副本都不是真
              // 相，保留旧值好过写一个确定错误的尺寸。
              if (
                bodyImage?.downscaled &&
                !nodeBodyRecordDescribesImage(
                  event.currentTarget,
                  recordedNaturalSize,
                  bodyImage.maxEdge ?? 0,
                )
              ) {
                distrustRecord();
                return;
              }
              // 眼下加载的是不是记录归属的那张图。放大档挑的是 imageUrl，那可能
              // 是完全另一张图——旋转、补光、多视角都把结果写进 previewImageUrl，
              // 两者尺寸不必相同。拿它去纠正记录就是把错的换成另一个错的。
              const measuringRecordSubject = !preferOriginalImage;
              // 为纠正记录才退回来的那一轮，真尺寸这就量到了：解除不信任，下一轮
              // 回到副本。这张图已经纠正过，钩子记着，不会再退第二次。
              if (measuringRecordSubject) {
                trustAgain();
              }
              // 喂的是降采样副本时元素上的 naturalWidth 是变体的尺寸，改用记录里的
              // 真实尺寸——下面的角标、比例、自动尺寸因此与喂原图时完全一致。
              const measured = bodyImage
                ? nodeBodyImageMeasurement(event.currentTarget, bodyImage, recordedNaturalSize)
                : { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
              if (measured.width > 0 && measured.height > 0) {
                setNaturalSize((prev) =>
                  prev && prev.width === measured.width && prev.height === measured.height
                    ? prev
                    : { width: measured.width, height: measured.height },
                );
              }
              const forceNaturalSize = shouldForceNaturalImageSize(data as Record<string, unknown>);
              // 用户拖定过尺寸：屏幕上的尺寸归他。但记录归事实——这里原本直接
              // return，于是换图之后真实尺寸永远写不回去，重新挂载读到的还是
              // 旧记录，同比例换图时副本校验那层也认不出来。
              const sizeLockedByUser = data.isSizeManuallyAdjusted === true && !forceNaturalSize;
              const nextAspectRatio = aspectRatioFromImageDimensions(
                measured.width,
                measured.height,
              );
              if (!nextAspectRatio) {
                return;
              }
              const nextSize = resolveMinEdgeFittedSize(nextAspectRatio, {
                minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
                minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
              });
              const displaySizeMismatch =
                Math.abs(resolvedWidth - nextSize.width) > 1 ||
                Math.abs(resolvedHeight - nextSize.height) > 1;
              // 记录空着、或者和刚量到的真相对不上，都得写回去——比例和显示尺寸
              // 这两个条件盖不住它们（同比例换图、老项目里早就贴合的节点）。哪些
              // 算用户可撤销的改动、哪些只是补记事实，见 planNaturalSizeRecordWrite。
              const recordWrite = planNaturalSizeRecordWrite({
                aspectRatioChanged: nextAspectRatio !== data.aspectRatio,
                displaySizeMismatch,
                record: recordedNaturalSize,
                measured,
                measuringRecordSubject,
                sizeLockedByUser,
              });
              if (!recordWrite.persist) {
                return;
              }
              // 只是补记事实那一类：不碰节点尺寸，也不碰比例。
              if (!recordWrite.applySize) {
                updateNodeData(
                  id,
                  { imageNaturalWidth: measured.width, imageNaturalHeight: measured.height },
                  { recordHistory: false },
                );
                return;
              }
              updateNodeSize(id, nextSize, {
                lockManualSize: forceNaturalSize ? false : undefined,
                recordHistory: recordWrite.recordHistory,
                data: {
                  aspectRatio: nextAspectRatio,
                  imageNaturalWidth: measured.width,
                  imageNaturalHeight: measured.height,
                  imageAspectRatioUpdatedAt: Date.now(),
                },
              });
            }}
            className="h-full w-full object-contain"
          />
        ) : isGenerating ? (
          <div className="h-full w-full" />
        ) : hasGenerationError ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-red-300">
            <AlertTriangle className="h-7 w-7 opacity-90" />
            <span className="text-center text-[12px] font-medium leading-5 text-red-200">
              {t('node.imageNode.generationFailed')}
            </span>
            <span className="max-h-[88px] overflow-y-auto break-words text-center text-[11px] leading-5 text-red-200/90 [overflow-wrap:anywhere]">
              {generationError}
            </span>
            {generationErrorRequestId && (
              <div className="flex w-full max-w-[240px] items-center gap-1 rounded bg-red-500/10 px-2 py-1">
                <span className="shrink-0 text-[10px] text-red-300/70">请求ID</span>
                <code
                  className="min-w-0 flex-1 truncate font-mono text-[10px] text-red-200"
                  title={generationErrorRequestId}
                >
                  {generationErrorRequestId}
                </code>
              </div>
            )}
            {canRegenerateExportImageNode(data as Record<string, unknown>) && (
              <div className="mt-1">
                <RegenerateButton
                  onClick={() => void regenerateExportImageNode(id)}
                  busy={isGenerating}
                />
              </div>
            )}
          </div>
        ) : isGenerating ? (
          // 生成中只保留 NodeGenerationOverlay 的「蒙层 + 进度」，不再渲染占位
          // 图标 / 等待文案，避免它们透出在百分比下方重叠成杂乱内容。
          <div className="h-full w-full" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-muted/85">
            {isExportResultNode ? (
              <ImageIcon className="h-7 w-7 opacity-60" />
            ) : (
              <Sparkles className="h-7 w-7 opacity-60" />
            )}
            <span className="px-4 text-center text-[12px] leading-6">
              {waitingResultText}
            </span>
          </div>
        )}

        {isGenerating && (
          <NodeGenerationOverlay
            startedAt={generationStartedAt}
            durationMs={generationDurationMs}
            hasBackground={Boolean(data.imageUrl)}
          />
        )}
      </div>

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
      />
      <NodeResizeHandle
        minWidth={resizeMinWidth}
        minHeight={resizeMinHeight}
        maxWidth={1600}
        maxHeight={1600}
        keepAspectRatio
      />
    </div>
  );
});

ImageNode.displayName = 'ImageNode';
