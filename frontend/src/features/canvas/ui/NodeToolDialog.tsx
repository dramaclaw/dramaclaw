// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Suspense, lazy, useMemo, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import {
  NODE_TOOL_TYPES,
  resolveNodeSourceImageUrl,
  type NodeToolType,
} from '@/features/canvas/domain/canvasNodes';
import { EXPORT_RESULT_DISPLAY_NAME } from '@/features/canvas/domain/nodeDisplay';
import {
  canvasEventBus,
  canvasToolProcessor,
} from '@/features/canvas/application/canvasServices';
import { prepareNodeImage, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { readStoryboardImageMetadata } from '@/commands/image';
import { uploadLocalImageToBackend } from '@/features/canvas/application/uploadToolOutput';
import { getToolPlugin, type ToolOptions } from '@/features/canvas/tools';
import { useCanvasStore } from '@/stores/canvasStore';
import { inheritMainlineFields } from '@/features/canvas/domain/inheritMainlineFields';
import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import { UiButton, UiModal } from '@/components/ui';
import { UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { FormToolEditor } from './tool-editors/FormToolEditor';
import { CropToolEditor } from './tool-editors/CropToolEditor';
// 标注编辑器拖着 react-konva（预打包 1.05MB），而它只在用户点开「标注」工具时
// 才会出现 —— 静态 import 会让它跟着本弹窗进入画布路由的模块图。打开工具时再拉。
const AnnotateToolEditor = lazy(() =>
  import('./tool-editors/AnnotateToolEditor').then((m) => ({ default: m.AnnotateToolEditor })),
);
import { SplitStoryboardToolEditor } from './tool-editors/SplitStoryboardToolEditor';

/** 工具编辑器 chunk 在途时的占位：与编辑器同区域，避免弹窗内容区塌成 0 高。 */
function ToolEditorLoading() {
  return <div className="flex min-h-[320px] flex-1 items-center justify-center text-sm text-text-muted/70" />;
}

const VISUAL_TOOL_MODAL_CLASS =
  'relative flex flex-col overflow-hidden rounded-[10px] border border-white/[0.12] bg-[#15161b]/96 shadow-[0_18px_48px_rgba(0,0,0,0.45)] backdrop-blur-md';
const VISUAL_TOOL_HEADER_BUTTON_CLASS =
  'inline-flex h-8 w-8 items-center justify-center rounded-md text-text-dark/62 transition-colors hover:bg-white/[0.06] hover:text-text-dark disabled:opacity-30';
const VISUAL_TOOL_CANCEL_CLASS =
  'inline-flex h-8 items-center px-2 text-sm font-medium text-text-dark/76 transition-colors hover:text-text-dark disabled:opacity-40';
const VISUAL_TOOL_CONFIRM_CLASS =
  'inline-flex h-8 items-center justify-center rounded-[8px] bg-white px-4 text-sm font-medium text-bg-dark transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-text-muted/40';

export function NodeToolDialog() {
  const { t } = useTranslation();
  const activeToolDialog = useCanvasStore((state) => state.activeToolDialog);
  const nodes = useCanvasStore((state) => state.nodes);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addStoryboardSplitNode = useCanvasStore((state) => state.addStoryboardSplitNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addEdge = useCanvasStore((state) => state.addEdge);

  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<ToolOptions>({});
  const [isSplitImageReady, setIsSplitImageReady] = useState(true);
  const [displayToolDialog, setDisplayToolDialog] = useState(activeToolDialog);

  useEffect(() => {
    if (activeToolDialog) {
      setDisplayToolDialog(activeToolDialog);
      return;
    }

    const timer = setTimeout(() => {
      setDisplayToolDialog(null);
    }, UI_DIALOG_TRANSITION_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [activeToolDialog]);

  const sourceNode = useMemo(() => {
    if (!displayToolDialog) {
      return null;
    }

    return nodes.find((node) => node.id === displayToolDialog.nodeId) ?? null;
  }, [displayToolDialog, nodes]);

  const sourceImageUrl = useMemo(
    () => resolveNodeSourceImageUrl(sourceNode),
    [sourceNode],
  );

  const activePlugin = useMemo(() => {
    if (!displayToolDialog) {
      return null;
    }

    return getToolPlugin(displayToolDialog.toolType);
  }, [displayToolDialog]);

  const dialogKey = displayToolDialog
    ? `${displayToolDialog.nodeId}:${displayToolDialog.toolType}`
    : null;

  useEffect(() => {
    if (!sourceNode || !activePlugin) {
      return;
    }

    let cancelled = false;
    setError(null);
    const initialOptions = activePlugin.createInitialOptions(sourceNode);
    setOptions(initialOptions);

    if (activePlugin.editor !== 'split' || !sourceImageUrl) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const metadata = await readStoryboardImageMetadata(sourceImageUrl);
        if (!metadata || cancelled) {
          return;
        }

        const nextRows = Math.max(1, Math.min(8, Math.floor(metadata.gridRows)));
        const nextCols = Math.max(1, Math.min(8, Math.floor(metadata.gridCols)));
        if (!Number.isFinite(nextRows) || !Number.isFinite(nextCols)) {
          return;
        }

        setOptions((previous) => ({
          ...previous,
          rows: nextRows,
          cols: nextCols,
        }));
      } catch (error) {
        console.warn('[StoryboardMetadata] read failed on split dialog init', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dialogKey, sourceNode, activePlugin, sourceImageUrl]);

  useEffect(() => {
    const requiresSplitPreload = activePlugin?.editor === 'split' && Boolean(sourceImageUrl);
    if (!requiresSplitPreload || !sourceImageUrl) {
      setIsSplitImageReady(true);
      return;
    }

    let cancelled = false;
    const image = new Image();
    const displayImageUrl = resolveImageDisplayUrl(sourceImageUrl);

    setIsSplitImageReady(false);

    image.onload = () => {
      if (cancelled) {
        return;
      }
      setIsSplitImageReady(true);
    };

    image.onerror = () => {
      if (cancelled) {
        return;
      }
      setIsSplitImageReady(true);
    };

    image.src = displayImageUrl;
    if (image.complete) {
      setIsSplitImageReady(true);
    }

    return () => {
      cancelled = true;
    };
  }, [activePlugin?.editor, sourceImageUrl]);

  const closeDialog = useCallback(() => {
    canvasEventBus.publish('tool-dialog/close', undefined);
  }, []);

  const resolveToolLabel = useCallback((toolType: NodeToolType | undefined) => {
    if (!toolType) {
      return '';
    }
    if (toolType === NODE_TOOL_TYPES.crop) {
      return t('tool.crop');
    }
    if (toolType === NODE_TOOL_TYPES.annotate) {
      return t('tool.annotate');
    }
    if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
      return t('tool.split');
    }
    return '';
  }, [t]);
  const resolveResultNodeTitle = useCallback((toolType: NodeToolType | undefined) => {
    if (toolType === NODE_TOOL_TYPES.crop) {
      return t('toolDialog.cropResultTitle');
    }
    if (toolType === NODE_TOOL_TYPES.annotate) {
      return t('toolDialog.annotateResultTitle');
    }
    return EXPORT_RESULT_DISPLAY_NAME.generic;
  }, [t]);

  const handleApply = useCallback(async () => {
    if (!activeToolDialog || !sourceNode || !sourceImageUrl || !activePlugin) {
      setError(t('toolDialog.noProcessableImage'));
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      const result = await activePlugin.execute(sourceImageUrl, options, {
        processTool: (toolType, imageUrl, toolOptions) =>
          canvasToolProcessor.process(toolType, imageUrl, toolOptions),
      });

      if (result.storyboardFrames && result.rows && result.cols) {
        // Upload each split frame so frame.imageUrl is a real backend URL.
        // previewImageUrl mirrors the uploaded URL so the canvas save payload
        // never serializes the local base64 (which would bloat PUT /default
        // and the persisted canvas). Per-frame best-effort — a failed frame
        // falls back to its local URL on both fields.
        const uploadedFrames = await Promise.all(
          result.storyboardFrames.map(async (frame, index) => {
            if (!frame.imageUrl) {
              return frame;
            }
            const uploadedUrl = await uploadLocalImageToBackend(
              frame.imageUrl,
              `split-${sourceNode.id}-${Date.now()}-${index}.png`
            );
            return {
              ...frame,
              imageUrl: uploadedUrl,
              previewImageUrl: uploadedUrl,
            };
          })
        );
        const createdNodeId = addStoryboardSplitNode(
          sourceNode.id,
          result.rows,
          result.cols,
          uploadedFrames,
          result.frameAspectRatio
        );
        if (createdNodeId) {
          addEdge(sourceNode.id, createdNodeId);
        }
      } else if (result.outputImageUrl) {
        const prepared = await prepareNodeImage(result.outputImageUrl);
        // Upload the processed full-res image so imageUrl is a backend URL.
        // previewImageUrl mirrors it so the persisted node never carries the
        // local base64 produced by prepareNodeImage (which would otherwise
        // bloat PUT /default — see exportImageNode preview-base64 bug).
        const uploadedUrl = await uploadLocalImageToBackend(
          prepared.imageUrl,
          `${activeToolDialog.toolType}-${sourceNode.id}-${Date.now()}.png`
        );
        const createdNodeId = addDerivedExportNode(
          sourceNode.id,
          uploadedUrl,
          prepared.aspectRatio,
          uploadedUrl,
          {
            defaultTitle: resolveResultNodeTitle(activeToolDialog.toolType),
            resultKind: 'generic',
            aspectRatioStrategy: 'provided',
            sizeStrategy: 'autoMinEdge',
          }
        );
        if (createdNodeId) {
          // Tool dialogs go through addDerivedExportNode which doesn't accept
          // arbitrary data — patch the freshly-created child with inherited
          // mainline fields so it still represents the same canonical slot
          // at Push time. inheritMainlineFields stamps user_spawned: true and
          // never writes preset_managed (so this child is correctly preserved
          // by `_merge_restored_preset_canvas`).
          const inherited = inheritMainlineFields(
            { data: sourceNode.data as Record<string, unknown> },
            {},
          );
          updateNodeData(createdNodeId, inherited as unknown as Partial<CanvasNodeData>);
          addEdge(sourceNode.id, createdNodeId);
        }
      }

      closeDialog();
    } catch (processError) {
      setError(processError instanceof Error ? processError.message : t('toolDialog.processFailed'));
    } finally {
      setIsProcessing(false);
    }
  }, [
    activeToolDialog,
    sourceNode,
    sourceImageUrl,
    activePlugin,
    options,
    addStoryboardSplitNode,
    addDerivedExportNode,
    addEdge,
    closeDialog,
    resolveResultNodeTitle,
    t,
  ]);

  const widthClassName = useMemo(() => {
    if (!activePlugin) {
      return 'w-[min(460px,calc(100vw-40px))]';
    }
    if (activePlugin.editor === 'crop') {
      return 'w-[min(980px,calc(100vw-40px))]';
    }
    if (activePlugin.editor === 'annotate') {
      return 'w-[min(1120px,calc(100vw-40px))]';
    }
    if (activePlugin.editor === 'split') {
      return 'w-[min(1120px,calc(100vw-40px))]';
    }
    return 'w-[min(460px,calc(100vw-40px))]';
  }, [activePlugin]);

  const editorContent = useMemo(() => {
    if (!activePlugin) {
      return null;
    }

    if (activePlugin.editor === 'crop' && sourceImageUrl) {
      return (
        <CropToolEditor
          plugin={activePlugin}
          sourceImageUrl={sourceImageUrl}
          options={options}
          onOptionsChange={setOptions}
        />
      );
    }

    if (activePlugin.editor === 'annotate' && sourceImageUrl) {
      return (
        <Suspense fallback={<ToolEditorLoading />}>
          <AnnotateToolEditor
            plugin={activePlugin}
            sourceImageUrl={sourceImageUrl}
            options={options}
            onOptionsChange={setOptions}
          />
        </Suspense>
      );
    }

    if (activePlugin.editor === 'split' && sourceImageUrl) {
      return (
        <SplitStoryboardToolEditor
          plugin={activePlugin}
          sourceImageUrl={sourceImageUrl}
          options={options}
          onOptionsChange={setOptions}
        />
      );
    }

    return (
      <FormToolEditor
        plugin={activePlugin}
        fields={activePlugin.fields}
        options={options}
        onOptionsChange={setOptions}
      />
    );
  }, [activePlugin, options, sourceImageUrl]);

  const isOpen = Boolean(activeToolDialog && isSplitImageReady);
  const usesVisualToolFrame =
    activePlugin?.editor === 'crop'
    || activePlugin?.editor === 'annotate'
    || activePlugin?.editor === 'split';
  const visualToolWidthClassName =
    activePlugin?.editor === 'split'
      ? 'w-[min(1060px,88vw)]'
      : activePlugin?.editor === 'annotate'
        ? 'w-[min(980px,86vw)]'
      : 'w-[min(980px,86vw)]';
  const visualToolHeightClassName =
    activePlugin?.editor === 'split'
      ? 'h-[min(640px,82vh)]'
      : 'max-h-[82vh]';
  const visualToolContentClassName =
    activePlugin?.editor === 'split'
      ? 'ui-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-4'
      : 'ui-scrollbar overflow-y-auto px-5 pb-4';

  if (usesVisualToolFrame) {
    if (!isOpen) {
      return null;
    }

    const dialog = (
      <div
        className="fixed inset-0 z-[300] flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm"
        onClick={() => {
          if (!isProcessing) {
            closeDialog();
          }
        }}
      >
        <div
          className={`${VISUAL_TOOL_MODAL_CLASS} ${visualToolWidthClassName} ${visualToolHeightClassName}`}
          role="dialog"
          aria-modal="true"
          aria-label={`${resolveToolLabel(activePlugin?.type)}${t('toolDialog.suffix')}`}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex h-14 shrink-0 items-center justify-between px-5">
            <h2 className="flex min-w-0 items-baseline gap-2 text-base font-semibold text-text-dark">
              <span className="shrink-0">{`${resolveToolLabel(activePlugin?.type)}${t('toolDialog.suffix')}`}</span>
              {activePlugin?.editor === 'split' && (
                <span className="truncate text-xs font-normal text-text-muted">
                  {t('toolDialog.splitDiscardHint')}
                </span>
              )}
            </h2>
            <button
              type="button"
              className={VISUAL_TOOL_HEADER_BUTTON_CLASS}
              onClick={closeDialog}
              disabled={isProcessing}
              aria-label={t('common.close')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className={visualToolContentClassName}>
            {editorContent}
            {error && <div className="mt-3 text-xs text-red-400">{error}</div>}
          </div>

          <div className="flex h-14 shrink-0 items-center justify-end gap-3 px-5">
            <button
              type="button"
              className={VISUAL_TOOL_CANCEL_CLASS}
              onClick={closeDialog}
              disabled={isProcessing}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={isProcessing || !sourceImageUrl}
              className={VISUAL_TOOL_CONFIRM_CLASS}
              aria-label={isProcessing ? t('toolDialog.processing') : t('toolDialog.apply')}
              title={isProcessing ? t('toolDialog.processing') : t('toolDialog.apply')}
            >
              {t('toolDialog.confirm')}
            </button>
          </div>
        </div>
      </div>
    );

    return createPortal(dialog, document.body);
  }

  return (
    <UiModal
      isOpen={isOpen}
      title={`${resolveToolLabel(activePlugin?.type)}${t('toolDialog.suffix')}`}
      onClose={closeDialog}
      widthClassName={widthClassName}
      footer={
        <>
          <UiButton variant="ghost" size="sm" onClick={closeDialog}>
            {t('common.cancel')}
          </UiButton>
          <UiButton size="sm" variant="primary" onClick={handleApply} disabled={isProcessing || !sourceImageUrl}>
            {isProcessing ? t('toolDialog.processing') : t('toolDialog.apply')}
          </UiButton>
        </>
      }
    >
      <div className="space-y-3 max-h-[82vh] overflow-y-auto pr-1">
        {editorContent}
        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>
    </UiModal>
  );
}
