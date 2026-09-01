// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';
import { ArrowUp, Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  type FreezoneVideoUpscaleDenoise,
  type FreezoneVideoUpscaleResolution,
} from '@/api/ops';
import { submitVideoUpscale } from '@/features/canvas/application/videoUpscale';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { CANVAS_NODE_OPS_PANEL_CLASS } from './nodeFrameStyles';
import { ZoomScaledToolbar } from './ZoomScaledToolbar';
import {
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
} from './nodeControlStyles';

const RESOLUTIONS: FreezoneVideoUpscaleResolution[] = ['1080p', '2k', '4k'];
const RESOLUTION_LABEL: Record<FreezoneVideoUpscaleResolution, string> = {
  '1080p': '1080P',
  '2k': '2K',
  '4k': '4K',
};
const DEFAULT_RESOLUTION: FreezoneVideoUpscaleResolution = '1080p';

const DENOISE_OPTIONS: FreezoneVideoUpscaleDenoise[] = ['none', '1x', '2x'];
const DEFAULT_DENOISE: FreezoneVideoUpscaleDenoise = '1x';

interface VideoUpscalePersistedFields {
  upscaleSourceUrl?: string;
  upscaleResolution?: FreezoneVideoUpscaleResolution;
  upscaleDenoise?: FreezoneVideoUpscaleDenoise;
}

interface VideoUpscaleEditorOverlayProps {
  /**
   * The video-upscale result node. The panel is always anchored beneath it while
   * the node is selected — settings persist on `node.data` so they survive
   * re-selection.
   */
  node: CanvasNode;
}

export const VideoUpscaleEditorOverlay = memo(
  ({ node }: VideoUpscaleEditorOverlayProps) => {
    const { t } = useTranslation();
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const deleteNode = useCanvasStore((state) => state.deleteNode);
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);

    const persisted = node.data as VideoUpscalePersistedFields;
    const sourceUrl = persisted.upscaleSourceUrl ?? '';
    const resolution: FreezoneVideoUpscaleResolution =
      persisted.upscaleResolution && RESOLUTIONS.includes(persisted.upscaleResolution)
        ? persisted.upscaleResolution
        : DEFAULT_RESOLUTION;
    const denoise: FreezoneVideoUpscaleDenoise =
      persisted.upscaleDenoise && DENOISE_OPTIONS.includes(persisted.upscaleDenoise)
        ? persisted.upscaleDenoise
        : DEFAULT_DENOISE;

    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleResolutionChange = useCallback(
      (next: FreezoneVideoUpscaleResolution) => {
        updateNodeData(node.id, {
          upscaleResolution: next,
          // Keep the title's resolution badge in sync.
          displayName: `${t('node.videoUpscale.nodeTitle')}（${RESOLUTION_LABEL[next]}）`,
        });
      },
      [node.id, t, updateNodeData],
    );

    const handleDenoiseChange = useCallback(
      (next: FreezoneVideoUpscaleDenoise) => {
        updateNodeData(node.id, { upscaleDenoise: next });
      },
      [node.id, updateNodeData],
    );

    const handleCancel = useCallback(() => {
      deleteNode(node.id);
      setSelectedNode(null);
    }, [deleteNode, node.id, setSelectedNode]);

    // 提交编排移到 application/videoUpscale（故事板详情工具条共用），语义零变化。
    const handleSubmit = useCallback(async () => {
      if (isSubmitting) return;
      if (!sourceUrl) {
        console.error('[video-upscale] missing upscaleSourceUrl on node.data — cannot submit');
        return;
      }
      setIsSubmitting(true);
      try {
        await submitVideoUpscale(node.id, { sourceUrl, resolution, denoise });
      } finally {
        setIsSubmitting(false);
      }
    }, [denoise, isSubmitting, node.id, resolution, sourceUrl]);

    return (
      <ReactFlowNodeToolbar
        nodeId={node.id}
        isVisible
        position={Position.Bottom}
        align="center"
        offset={12}
        className={NODE_TOOLBAR_CLASS}
      >
        {/* 操作区按画布缩放同步缩放，锚点取顶边（贴节点底边）——与 UpscaleEditorOverlay 一致。 */}
        <ZoomScaledToolbar origin="top center">
          <div
            className={`flex w-[520px] max-w-[calc(100vw-32px)] flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`}
            onClick={(event) => event.stopPropagation()}
          >
          <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-dark/72">
                  {t('node.videoUpscale.panel.resolution')}
                </span>
                <div className="inline-flex items-center gap-0.5 rounded border border-white/10 bg-white/[0.04] p-0.5">
                  {RESOLUTIONS.map((value) => {
                    const isActive = resolution === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => handleResolutionChange(value)}
                        className={`flex h-6 min-w-12 items-center justify-center rounded text-xs font-medium transition-colors ${
                          isActive
                            ? 'bg-white/[0.16] text-text-dark'
                            : 'text-text-muted/82 hover:bg-white/[0.06] hover:text-text-dark'
                        }`}
                      >
                        {RESOLUTION_LABEL[value]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <span
                className="inline-flex h-7 items-center rounded px-1 text-xs font-medium text-text-dark/70"
                title={t('node.videoUpscale.panel.frameInterpolationLockedHint')}
              >
                {t('node.videoUpscale.panel.frameInterpolationNone')}
              </span>

              <DenoisePicker value={denoise} onChange={handleDenoiseChange} />
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className="h-7 rounded px-1.5 text-xs font-medium text-text-dark/72 transition-colors hover:text-text-dark"
                onClick={handleCancel}
                title={t('common.cancel')}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={isSubmitting}
                className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
                  isSubmitting
                    ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                    : NODE_GENERATE_BUTTON_ENABLED_CLASS
                }`}
                title={t('node.videoUpscale.panel.submit')}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
          </div>
          </div>
        </ZoomScaledToolbar>
      </ReactFlowNodeToolbar>
    );
  },
);

VideoUpscaleEditorOverlay.displayName = 'VideoUpscaleEditorOverlay';

interface DenoisePickerProps {
  value: FreezoneVideoUpscaleDenoise;
  onChange: (value: FreezoneVideoUpscaleDenoise) => void;
}

function DenoisePicker({ value, onChange }: DenoisePickerProps) {
  const { t } = useTranslation();
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

  const denoiseLabel = (option: FreezoneVideoUpscaleDenoise) =>
    option === 'none' ? t('node.videoUpscale.panel.denoiseNone') : option;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="inline-flex h-7 items-center gap-1.5 rounded px-1 text-xs font-medium text-text-dark/88 transition-colors hover:text-text-dark"
      >
        <span>{denoiseLabel(value)}</span>
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className="absolute bottom-full right-0 z-50 mb-2 w-[160px] rounded-[10px] border border-white/[0.12] bg-[#282828]/96 p-1 shadow-[0_14px_34px_rgba(0,0,0,0.42)] backdrop-blur-md"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {DENOISE_OPTIONS.map((option) => {
            const isActive = value === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                }}
                className={`flex h-8 w-full items-center justify-between rounded-md px-2.5 text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-white/[0.10] text-text-dark'
                    : 'text-text-muted hover:bg-white/[0.06] hover:text-text-dark'
                }`}
              >
                {denoiseLabel(option)}
                {isActive && <Check className="h-3 w-3" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
