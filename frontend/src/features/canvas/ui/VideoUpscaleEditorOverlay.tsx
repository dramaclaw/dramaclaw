// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';
import { ArrowUp, Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  fetchFreezoneJobResult,
  probeFreezoneVideoUpscale,
  quoteFreezoneVideoUpscale,
  submitFreezoneVideoUpscale,
  type FreezoneVideoProbe,
  type FreezoneVideoScene,
  type FreezoneVideoSlowdown,
  type FreezoneVideoTargetFps,
  type FreezoneVideoUpscaleResolution,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { notifyTaskStillRunning } from '@/features/canvas/application/errorDialog';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { readUrl } from '@/lib/url-params';
import { CreditCostPill, type CreditPromotionDisplay } from '@/components/credits/credit-visual';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { CANVAS_NODE_OPS_PANEL_CLASS } from './nodeFrameStyles';
import { ZoomScaledToolbar } from './ZoomScaledToolbar';
import {
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_CREDIT_PILL_FLAT_CLASS,
} from './nodeControlStyles';

const RESOLUTION_LONG_EDGE: Record<FreezoneVideoUpscaleResolution, number> = {
  '1080p': 1920,
  '2k': 2560,
  '4k': 3840,
};
const RESOLUTION_LABEL: Record<FreezoneVideoUpscaleResolution, string> = {
  '1080p': '1080P',
  '2k': '2K',
  '4k': '4K',
};
const ALL_RESOLUTIONS = Object.keys(RESOLUTION_LONG_EDGE) as FreezoneVideoUpscaleResolution[];
const TARGET_FPS_PRESETS = [10, 12, 20, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 90, 119.88, 120];

interface PersistedFields {
  upscaleSourceUrl?: string;
  upscaleResolution?: FreezoneVideoUpscaleResolution;
  upscaleTargetFps?: FreezoneVideoTargetFps;
  upscaleSlowdown?: FreezoneVideoSlowdown;
  upscaleSmartInterpolation?: boolean;
  upscaleScene?: FreezoneVideoScene;
  upscaleFaceEnhance?: boolean;
}

export const VideoUpscaleEditorOverlay = memo(({ node }: { node: CanvasNode }) => {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const persisted = node.data as PersistedFields;
  const sourceUrl = persisted.upscaleSourceUrl ?? '';
  const project = readUrl().project;
  const [probe, setProbe] = useState<FreezoneVideoProbe | null>(null);
  const [probeError, setProbeError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [creditQuote, setCreditQuote] = useState<{
    display: string; promotion?: CreditPromotionDisplay;
  } | null>(null);
  const [quoteError, setQuoteError] = useState('');

  const resolution = persisted.upscaleResolution ?? '1080p';
  const targetFps = persisted.upscaleTargetFps ?? 'auto';
  const slowdown = persisted.upscaleSlowdown ?? 'auto';
  const smartInterpolation = persisted.upscaleSmartInterpolation !== false;
  const scene = persisted.upscaleScene ?? 'realistic';
  const faceEnhance = persisted.upscaleFaceEnhance === true;

  useEffect(() => {
    let active = true;
    setProbe(null);
    setProbeError('');
    if (!project || !sourceUrl) return () => { active = false; };
    void probeFreezoneVideoUpscale(project, sourceUrl.split('?')[0])
      .then((value) => { if (active) setProbe(value); })
      .catch((error: unknown) => {
        if (active) setProbeError(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, [project, sourceUrl]);

  const availableResolutions = useMemo(() => {
    if (!probe) return ALL_RESOLUTIONS;
    const sourceLongEdge = Math.max(probe.width, probe.height);
    return ALL_RESOLUTIONS.filter((value) => RESOLUTION_LONG_EDGE[value] > sourceLongEdge);
  }, [probe]);

  useEffect(() => {
    let active = true;
    setCreditQuote(null);
    setQuoteError('');
    if (!project || !sourceUrl || !probe || !availableResolutions.includes(resolution)) {
      return () => { active = false; };
    }
    void quoteFreezoneVideoUpscale(project, {
      sourceUrl: sourceUrl.split('?')[0], resolution, targetFps, slowdown, smartInterpolation,
      scene, faceEnhance,
    }).then((value) => {
      if (active) setCreditQuote(value);
    }).catch((error: unknown) => {
      if (active) setQuoteError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [availableResolutions, faceEnhance, probe, project, resolution, scene, slowdown, smartInterpolation, sourceUrl, targetFps]);

  useEffect(() => {
    if (!availableResolutions.length || availableResolutions.includes(resolution)) return;
    const next = availableResolutions[0];
    updateNodeData(node.id, {
      upscaleResolution: next,
      displayName: `${t('node.videoUpscale.nodeTitle')}（${RESOLUTION_LABEL[next]}）`,
    });
  }, [availableResolutions, node.id, resolution, t, updateNodeData]);

  const setResolution = useCallback((next: FreezoneVideoUpscaleResolution) => {
    updateNodeData(node.id, {
      upscaleResolution: next,
      displayName: `${t('node.videoUpscale.nodeTitle')}（${RESOLUTION_LABEL[next]}）`,
    });
  }, [node.id, t, updateNodeData]);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting || !creditQuote || !project || !sourceUrl || !availableResolutions.includes(resolution)) return;
    const canvasId = readUrl().canvas ?? 'default';
    setIsSubmitting(true);
    updateNodeData(node.id, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationError: null,
      // A rerun must not briefly expose the previous task handle to the resume scanner.
      generationTaskKey: null,
      generationTaskType: null,
      generationTaskJobId: null,
    });
    try {
      const ref = await submitFreezoneVideoUpscale(project, {
        sourceUrl: sourceUrl.split('?')[0], resolution, targetFps, slowdown, smartInterpolation, scene,
        faceEnhance, canvasId, nodeId: node.id,
      });
      updateNodeData(node.id, generationTaskDescriptor(ref));
      const completed = await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
      let url = completed.result?.['output_url'] as string | undefined;
      if (!url) url = (await fetchFreezoneJobResult(project, ref.task_type, ref.job_id)).url;
      updateNodeData(node.id, {
        videoUrl: url,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
        generationTaskKey: null,
        generationTaskType: null,
        generationTaskJobId: null,
      });
    } catch (error) {
      if (isTaskPollTimeoutError(error)) {
        notifyTaskStillRunning(t);
        return;
      }
      updateNodeData(node.id, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: error instanceof Error ? error.message : String(error),
        generationTaskKey: null,
        generationTaskType: null,
        generationTaskJobId: null,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [availableResolutions, creditQuote, faceEnhance, isSubmitting, node.id, project, resolution, scene, slowdown, smartInterpolation, sourceUrl, t, targetFps, updateNodeData]);

  const disabled = isSubmitting || !probe || !creditQuote || Boolean(probeError) || availableResolutions.length === 0;
  return (
    <ReactFlowNodeToolbar nodeId={node.id} isVisible position={Position.Bottom} align="center" offset={12} className={NODE_TOOLBAR_CLASS}>
      <ZoomScaledToolbar origin="top center">
        <div className={`w-[440px] max-w-[calc(100vw-32px)] rounded-[var(--node-radius)] p-4 ${CANVAS_NODE_OPS_PANEL_CLASS}`} onClick={(event) => event.stopPropagation()}>
          <div className="space-y-3">
            <SelectRow
              label={t('node.videoUpscale.panel.resolution')}
              value={resolution}
              options={availableResolutions.map((value) => ({ value, label: RESOLUTION_LABEL[value] }))}
              onChange={(value) => setResolution(value as FreezoneVideoUpscaleResolution)}
              disabled={!availableResolutions.length}
            />
            <SelectRow
              label={t('node.videoUpscale.panel.targetFps')}
              value={String(targetFps)}
              options={[
                { value: 'auto', label: t('node.videoUpscale.panel.targetFpsAuto') },
                ...TARGET_FPS_PRESETS.map((value) => ({ value: String(value), label: `${value}fps` })),
              ]}
              onChange={(value) => updateNodeData(node.id, {
                upscaleTargetFps: value === 'auto' ? 'auto' : Number(value),
              })}
            />
            <SelectRow
              label={t('node.videoUpscale.panel.slowdown')}
              value={slowdown}
              options={[
                { value: 'auto', label: t('node.videoUpscale.panel.speedAuto') },
                ...[2, 3, 4, 5].map((multiplier) => ({
                  value: `${multiplier}x`,
                  label: t('node.videoUpscale.panel.speedMultiplier', { multiplier }),
                })),
              ]}
              onChange={(value) => updateNodeData(node.id, { upscaleSlowdown: value as FreezoneVideoSlowdown })}
            />
            <SelectRow
              label={t('node.videoUpscale.panel.scene')}
              value={scene}
              options={[
                { value: 'realistic', label: t('node.videoUpscale.panel.sceneRealistic') },
                { value: 'anime', label: t('node.videoUpscale.panel.sceneAnime') },
              ]}
              onChange={(value) => updateNodeData(node.id, { upscaleScene: value as FreezoneVideoScene })}
            />
            {(targetFps !== 'auto' || slowdown !== 'auto') && (
              <ToggleRow
                label={t('node.videoUpscale.panel.smartInterpolation')}
                checked={smartInterpolation}
                onChange={(checked) => updateNodeData(node.id, { upscaleSmartInterpolation: checked })}
              />
            )}
            <ToggleRow
              label={t('node.videoUpscale.panel.faceEnhance')}
              checked={faceEnhance}
              onChange={(checked) => updateNodeData(node.id, { upscaleFaceEnhance: checked })}
            />
          </div>
          {probe && <p className="mt-3 text-[11px] text-text-muted">{t('node.videoUpscale.panel.sourceInfo', { width: probe.width, height: probe.height, fps: probe.fps.toFixed(2) })}</p>}
          {availableResolutions.length === 0 && <p className="mt-3 text-xs text-red-400">{t('node.videoUpscale.panel.noHigherResolution')}</p>}
          {probeError && <p className="mt-3 text-xs text-red-400">{t('node.videoUpscale.panel.probeError', { error: probeError })}</p>}
          {quoteError && <p className="mt-3 text-xs text-red-400">{quoteError}</p>}
          <div className="mt-4 flex justify-end items-center gap-2">
            <CreditCostPill display={creditQuote?.display} promotion={creditQuote?.promotion} className={NODE_CREDIT_PILL_FLAT_CLASS} />
            <button type="button" onClick={handleSubmit} disabled={disabled} className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${disabled ? NODE_GENERATE_BUTTON_DISABLED_CLASS : NODE_GENERATE_BUTTON_ENABLED_CLASS}`} title={t('node.videoUpscale.panel.submit')}><ArrowUp className="h-4 w-4" /></button>
          </div>
        </div>
      </ZoomScaledToolbar>
    </ReactFlowNodeToolbar>
  );
});

VideoUpscaleEditorOverlay.displayName = 'VideoUpscaleEditorOverlay';

function ToggleRow({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between text-xs text-text-dark/80">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-rgb))] focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dark ${
          checked ? 'bg-[rgb(var(--accent-rgb))]' : 'bg-white/15'
        }`}
      >
        <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-md transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`} />
      </button>
    </div>
  );
}

interface SelectRowProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

function SelectRow({ label, value, options, onChange, disabled = false }: SelectRowProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [isOpen]);

  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  const selected = options.find((option) => option.value === value);

  return (
    <div className="grid grid-cols-[150px_1fr] items-center gap-3 text-xs text-text-dark/80">
      <span>{label}</span>
      <div ref={rootRef} className={`relative ${isOpen ? 'z-50' : ''}`}>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          disabled={disabled}
          onClick={() => setIsOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setIsOpen(false);
            if (event.key === 'ArrowDown' && !isOpen) {
              event.preventDefault();
              setIsOpen(true);
            }
          }}
          className="flex h-9 w-full items-center justify-between rounded-lg border border-white/20 bg-white/[0.04] px-3 text-left text-sm text-text-dark transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span>{selected?.label ?? value}</span>
          <ChevronDown className={`h-4 w-4 text-text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
        {isOpen && (
          <div
            role="listbox"
            aria-label={label}
            className="nowheel absolute left-0 right-0 top-full z-50 mt-1 max-h-[min(340px,60vh)] overflow-y-auto overscroll-y-contain rounded-xl border border-white/10 bg-[#28282c] p-1 shadow-2xl"
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs transition-colors ${
                  option.value === value
                    ? 'bg-white/[0.12] text-text-dark'
                    : 'text-text-muted hover:bg-white/[0.08] hover:text-text-dark'
                }`}
              >
                <span>{option.label}</span>
                {option.value === value && <Check className="h-3.5 w-3.5" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
