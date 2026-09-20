// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { uploadFreezoneImage } from '@/api/ops';
import { Button } from '@/components/ui/button';
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
import { captureVideoFrameBlob } from '@/features/canvas/application/videoFrameCapture';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { isVideoNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
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
  const [creating, setCreating] = useState(false);

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

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setFrameSec(0);
    setLoadedDuration(0);
    setDesignStyle('minimal');
    setMotionStyle('blurFade');
    setCreating(false);
  }, [open, sourceNode?.id]);

  const seekPreview = (next: number) => {
    setFrameSec(next);
    if (videoRef.current && Number.isFinite(next)) videoRef.current.currentTime = next;
  };

  const handleCreate = async () => {
    const projectId = readUrl().project;
    if (!sourceNode || !videoUrl || !projectId || !title.trim() || creating) return;
    setCreating(true);
    try {
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
          labels: {
            keyframe: t('canvas.creativeIntro.keyframeNode'),
            design: t('canvas.creativeIntro.designNode'),
            motion: t('canvas.creativeIntro.motionNode'),
          },
        },
      );
      toast.success(t('canvas.creativeIntro.created'));
      onOpenChange(false);
    } catch (error) {
      console.error('[creative-intro] workflow creation failed', error);
      toast.error(t('canvas.creativeIntro.createFailed'));
    } finally {
      setCreating(false);
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

          <p className="rounded-[var(--radius)] bg-white/[0.04] p-3 text-xs leading-5 text-[rgb(var(--text-muted-rgb))]">
            {t('canvas.creativeIntro.noChargeHint')}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={creating} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!title.trim() || !videoUrl || creating} onClick={() => void handleCreate()}>
            {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            {t('canvas.creativeIntro.createWorkflow')}
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
