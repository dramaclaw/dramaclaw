// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Play, Sparkles, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  fetchFreezoneJobResult,
  submitFreezoneVideoCompose,
  uploadFreezoneImage,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  CREATIVE_INTRO_DESIGN_STYLES,
  CREATIVE_INTRO_MOTION_STYLES,
  spawnCreativeIntroWorkflow,
  type CreativeIntroDesignStyle,
  type CreativeIntroMotionStyle,
} from '@/features/canvas/application/creativeIntroWorkflow';
import {
  creativeIntroBlendStartBounds,
  normalizeCreativeIntroBlendRange,
  renderCreativeIntroBlendClip,
  resolveCreativeIntroBlendCapability,
} from '@/features/canvas/application/creativeIntroBlend';
import { captureVideoFrameBlob } from '@/features/canvas/application/videoFrameCapture';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { isVideoNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useFreezoneVideoModels } from '@/features/canvas/hooks/useFreezoneVideoModels';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

interface CreativeIntroDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceNode: CanvasNode | null;
}

export function CreativeIntroDialog({ open, onOpenChange, sourceNode }: CreativeIntroDialogProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [title, setTitle] = useState('');
  const [frameSec, setFrameSec] = useState(0);
  const [loadedDuration, setLoadedDuration] = useState(0);
  const [designStyle, setDesignStyle] = useState<CreativeIntroDesignStyle>('minimal');
  const [motionStyle, setMotionStyle] = useState<CreativeIntroMotionStyle>('blurFade');
  const [blendOriginal, setBlendOriginal] = useState(false);
  const [blendStartSec, setBlendStartSec] = useState(0);
  const [previewingBlend, setPreviewingBlend] = useState(false);
  const [creatingStep, setCreatingStep] = useState<'idle' | 'clip' | 'workflow'>('idle');
  const creating = creatingStep !== 'idle';

  const videoData = sourceNode && isVideoNode(sourceNode) ? sourceNode.data : null;
  const videoUrl = typeof videoData?.videoUrl === 'string' ? videoData.videoUrl : null;
  const aspectRatio =
    typeof videoData?.aspectRatio === 'string' ? videoData.aspectRatio : '16:9';
  const knownDuration =
    typeof videoData?.durationMs === 'number' && videoData.durationMs > 0
      ? videoData.durationMs / 1000
      : loadedDuration;
  const duration = Math.max(0, knownDuration);
  const displayUrl = useMemo(
    () => (videoUrl ? resolveImageDisplayUrl(videoUrl) : null),
    [videoUrl],
  );
  const projectId = readUrl().project;
  const canvasId = readUrl().canvas ?? 'default';
  const { models: videoModels, isLoading: videoModelsLoading } =
    useFreezoneVideoModels(projectId);
  const blendCapability = useMemo(
    () => resolveCreativeIntroBlendCapability(videoModels),
    [videoModels],
  );
  const blendBounds = useMemo(
    () => creativeIntroBlendStartBounds(frameSec, duration),
    [duration, frameSec],
  );
  const blendRange = useMemo(
    () => normalizeCreativeIntroBlendRange(blendStartSec, frameSec, duration),
    [blendStartSec, duration, frameSec],
  );
  const canBlend = Boolean(blendCapability && blendRange);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setFrameSec(0);
    setLoadedDuration(0);
    setDesignStyle('minimal');
    setMotionStyle('blurFade');
    setBlendOriginal(false);
    setBlendStartSec(0);
    setPreviewingBlend(false);
    setCreatingStep('idle');
  }, [open, sourceNode?.id]);

  useEffect(() => {
    if (canBlend || !blendOriginal) return;
    setBlendOriginal(false);
    setPreviewingBlend(false);
    videoRef.current?.pause();
  }, [blendOriginal, canBlend]);

  const seekPreview = (next: number) => {
    videoRef.current?.pause();
    setPreviewingBlend(false);
    setFrameSec(next);
    if (videoRef.current && Number.isFinite(next)) videoRef.current.currentTime = next;
  };

  const toggleBlendPreview = async () => {
    const video = videoRef.current;
    if (!video || !blendRange) return;
    if (previewingBlend) {
      video.pause();
      setPreviewingBlend(false);
      return;
    }
    video.currentTime = blendRange.startSec;
    try {
      await video.play();
      setPreviewingBlend(true);
    } catch (error) {
      console.warn('[creative-intro] source clip preview failed', error);
      setPreviewingBlend(false);
    }
  };

  const handleCreate = async () => {
    if (!sourceNode || !videoUrl || !projectId || !title.trim() || creating) return;
    setCreatingStep(blendOriginal ? 'clip' : 'workflow');
    try {
      let blend:
        | {
            clipUrl: string;
            range: NonNullable<typeof blendRange>;
            capability: NonNullable<typeof blendCapability>;
          }
        | undefined;
      if (blendOriginal) {
        if (!blendRange || !blendCapability) {
          throw new Error('Creative-intro source blending is not available.');
        }
        const resolution =
          (typeof videoData?.widthPx === 'number' && videoData.widthPx >= 1920) ||
          String(videoData?.quality ?? '').toLowerCase() === '1080p'
            ? '1080p'
            : '720p';
        const clipUrl = await renderCreativeIntroBlendClip(
          {
            submit: submitFreezoneVideoCompose,
            awaitCompletion: (taskKey, activeProjectId, taskType) =>
              awaitTaskCompletion(taskKey, activeProjectId, { taskType }),
            fetchResult: fetchFreezoneJobResult,
          },
          {
            projectId,
            sourceNodeId: sourceNode.id,
            sourceUrl: videoUrl,
            range: blendRange,
            resolution,
            canvasId,
          },
        );
        blend = { clipUrl, range: blendRange, capability: blendCapability };
        setCreatingStep('workflow');
      }
      const blob = await captureVideoFrameBlob(displayUrl ?? videoUrl, frameSec);
      const filename = `creative-intro-${Date.now()}.png`;
      const uploaded = await uploadFreezoneImage(
        projectId,
        new File([blob], filename, { type: 'image/png' }),
        filename,
      );
      const store = useCanvasStore.getState();
      spawnCreativeIntroWorkflow(
        {
          addDerivedExportNode: store.addDerivedExportNode,
          addNode: (type, position, data) => store.addNode(type, position, data),
          addEdge: store.addEdge,
          findNodePosition: store.findNodePosition,
          updateNodeData: store.updateNodeData,
          setSelectedNode: store.setSelectedNode,
          requestFocusNode: store.requestFocusNode,
        },
        {
          sourceNodeId: sourceNode.id,
          keyframeUrl: uploaded.url,
          aspectRatio,
          plan: { title: title.trim(), frameSec, designStyle, motionStyle },
          blend,
          labels: {
            keyframe: t('canvas.creativeIntro.keyframeNode'),
            design: t('canvas.creativeIntro.designNode'),
            motion: t('canvas.creativeIntro.motionNode'),
            clip: t('canvas.creativeIntro.blendClipNode'),
          },
        },
      );
      toast.success(t('canvas.creativeIntro.created'));
      onOpenChange(false);
    } catch (error) {
      console.error('[creative-intro] workflow creation failed', error);
      toast.error(t('canvas.creativeIntro.createFailed'));
    } finally {
      setCreatingStep('idle');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100vh-32px)] max-w-2xl overflow-y-auto border-white/10 bg-[#1b1c23] text-text-dark">
        <DialogHeader>
          <DialogTitle>{t('canvas.creativeIntro.title')}</DialogTitle>
          <DialogDescription>{t('canvas.creativeIntro.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="overflow-hidden rounded-[var(--radius)] border border-white/10 bg-black">
            {displayUrl ? (
              <video
                ref={videoRef}
                src={displayUrl}
                preload="metadata"
                muted
                playsInline
                className="aspect-video w-full object-contain"
                onLoadedMetadata={(event) => {
                  const next = event.currentTarget.duration;
                  if (Number.isFinite(next)) setLoadedDuration(next);
                }}
                onTimeUpdate={(event) => {
                  if (!previewingBlend || !blendRange) return;
                  if (event.currentTarget.currentTime < blendRange.endSec) return;
                  event.currentTarget.pause();
                  event.currentTarget.currentTime = blendRange.endSec;
                  setPreviewingBlend(false);
                }}
                onEnded={() => setPreviewingBlend(false)}
              />
            ) : null}
          </div>

          <label className="block space-y-2 text-sm">
            <span>{t('canvas.creativeIntro.frame')}</span>
            <input
              type="range"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.05}
              value={Math.min(frameSec, Math.max(duration, 0.1))}
              onChange={(event) => seekPreview(Number(event.target.value))}
              className="w-full accent-[rgb(var(--accent-rgb))]"
            />
            <span className="block text-xs text-[rgb(var(--text-muted-rgb))]">
              {t('canvas.creativeIntro.frameTime', { current: frameSec.toFixed(2), duration: duration.toFixed(2) })}
            </span>
          </label>

          <label className="block space-y-2 text-sm">
            <span>{t('canvas.creativeIntro.workTitle')}</span>
            <Input
              value={title}
              maxLength={60}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('canvas.creativeIntro.titlePlaceholder')}
              className="border-white/10 bg-[#0d0e14]"
            />
          </label>

          <StyleChoices
            title={t('canvas.creativeIntro.designStyle')}
            values={CREATIVE_INTRO_DESIGN_STYLES}
            selected={designStyle}
            onSelect={(value) => setDesignStyle(value as CreativeIntroDesignStyle)}
          />
          <StyleChoices
            title={t('canvas.creativeIntro.motionStyle')}
            values={CREATIVE_INTRO_MOTION_STYLES}
            selected={motionStyle}
            onSelect={(value) => setMotionStyle(value as CreativeIntroMotionStyle)}
          />

          <div className="space-y-3 rounded-[var(--radius)] border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id="creative-intro-blend-original"
                checked={blendOriginal}
                disabled={!canBlend || creating}
                onCheckedChange={(checked) => {
                  const enabled = checked === true;
                  setBlendOriginal(enabled);
                  if (enabled && blendBounds) {
                    setBlendStartSec(
                      Math.min(Math.max(frameSec - 2.5, blendBounds.min), blendBounds.max),
                    );
                  }
                }}
              />
              <label htmlFor="creative-intro-blend-original" className="min-w-0 flex-1 cursor-pointer">
                <span className="block text-sm font-medium">
                  {t('canvas.creativeIntro.blendOriginal')}
                </span>
                <span className="mt-1 block text-xs leading-5 text-[rgb(var(--text-muted-rgb))]">
                  {videoModelsLoading
                    ? t('canvas.creativeIntro.blendModelsLoading')
                    : duration > 0 && duration < 5
                      ? t('canvas.creativeIntro.blendTooShort')
                      : !blendCapability
                        ? t('canvas.creativeIntro.blendUnsupported')
                        : t('canvas.creativeIntro.blendReady', {
                            model: blendCapability.modelLabel,
                          })}
                </span>
              </label>
            </div>

            {blendOriginal && blendRange && blendBounds ? (
              <div className="space-y-2 border-t border-white/10 pt-3">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span>{t('canvas.creativeIntro.blendRange')}</span>
                  <span className="text-[rgb(var(--text-muted-rgb))]">
                    {t('canvas.creativeIntro.blendRangeValue', {
                      start: blendRange.startSec.toFixed(2),
                      end: blendRange.endSec.toFixed(2),
                      offset: blendRange.keyframeOffsetSec.toFixed(2),
                    })}
                  </span>
                </div>
                <input
                  type="range"
                  min={blendBounds.min}
                  max={blendBounds.max}
                  step={0.05}
                  value={blendRange.startSec}
                  disabled={creating}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    videoRef.current?.pause();
                    setPreviewingBlend(false);
                    setBlendStartSec(next);
                    if (videoRef.current) videoRef.current.currentTime = next;
                  }}
                  className="w-full accent-[rgb(var(--accent-rgb))]"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={creating}
                  onClick={() => void toggleBlendPreview()}
                >
                  {previewingBlend ? (
                    <Square className="mr-2 h-3.5 w-3.5" />
                  ) : (
                    <Play className="mr-2 h-3.5 w-3.5" />
                  )}
                  {t(
                    previewingBlend
                      ? 'canvas.creativeIntro.stopBlendPreview'
                      : 'canvas.creativeIntro.previewBlend',
                  )}
                </Button>
              </div>
            ) : null}
          </div>

          <p className="rounded-[var(--radius)] bg-white/[0.04] p-3 text-xs leading-5 text-[rgb(var(--text-muted-rgb))]">
            {t(
              blendOriginal
                ? 'canvas.creativeIntro.blendNoChargeHint'
                : 'canvas.creativeIntro.noChargeHint',
            )}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={creating} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!title.trim() || !videoUrl || creating} onClick={() => void handleCreate()}>
            {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            {t(
              creatingStep === 'clip'
                ? 'canvas.creativeIntro.creatingBlendClip'
                : 'canvas.creativeIntro.createWorkflow',
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StyleChoices({
  title,
  values,
  selected,
  onSelect,
}: {
  title: string;
  values: readonly string[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm">{title}</legend>
      <div className="flex flex-wrap gap-2">
        {values.map((value) => (
          <button
            key={value}
            type="button"
            data-state={selected === value ? 'active' : 'inactive'}
            className="tap-chip transition-colors"
            onClick={() => onSelect(value)}
          >
            {t(`canvas.creativeIntro.styles.${value}`)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
