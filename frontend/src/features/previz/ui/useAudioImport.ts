// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { uploadFreezoneAudio } from '@/api/ops';
import { readUrl } from '@/lib/url-params';

import {
  audioFileExtension,
  isAcceptedAudioFile,
  type PrevizAudioSource,
} from '../domain/audioTrack';
import { PREVIZ_FPS } from '../domain/scene';
import { probeAudioDuration } from '../engine/audioProbe';
import { usePrevizStore } from '../store';

/** 上游音频节点里能拿来用的信息，由 PrevizNode 从画布算好传进编辑器。 */
export interface PrevizUpstreamAudio {
  nodeId: string;
  displayName: string;
  audioUrl: string;
  /** 节点没记时长时为 null，选中时再用 `<audio>` 探一次。 */
  durationMs: number | null;
}

/** 上传/探测期间挂在音频轨上的占位条，不进场景。 */
export interface PendingAudioClip {
  startFrame: number;
  endFrame: number;
  name: string;
}

export interface AudioImport {
  pending: PendingAudioClip | null;
  addFile: (file: File) => Promise<void>;
  addUpstream: (source: PrevizUpstreamAudio) => Promise<void>;
}

/**
 * 「添加音频」两条路的共同部分：记下点击那一刻的播放头（上传要几秒，播放头
 * 可能已经被拖走），挂占位条，拿到时长与 url 后交给 store 放片段。
 */
export function useAudioImport(nodeId: string): AudioImport {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingAudioClip | null>(null);
  /** 同一节点连传几个文件时文件名不撞。 */
  const seq = useRef(0);

  const place = useCallback(
    (source: PrevizAudioSource, frame: number) => {
      const rejection = usePrevizStore.getState().addAudioClip(source, frame);
      if (rejection === 'no-room') toast.error(t('previz.audio.noRoom'));
      else if (rejection === 'limit') toast.error(t('previz.audio.limit'));
    },
    [t],
  );

  const showPending = useCallback((name: string, frame: number) => {
    const { durationFrames } = usePrevizStore.getState().scene.settings;
    // 时长未知，先占一秒宽，让人看见轨道上有东西在来。
    setPending({
      startFrame: frame,
      endFrame: Math.min(frame + PREVIZ_FPS, durationFrames),
      name,
    });
  }, []);

  const failed = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('previz.audio.uploadFailed', { message }));
    },
    [t],
  );

  const addFile = useCallback(
    async (file: File) => {
      const verdict = isAcceptedAudioFile(file.name, file.size);
      if (verdict === 'extension') {
        toast.error(t('previz.audio.badExtension'));
        return;
      }
      if (verdict === 'size') {
        toast.error(t('previz.audio.tooLarge'));
        return;
      }
      const project = readUrl().project;
      if (!project) {
        toast.error(t('previz.editor.noProject'));
        return;
      }
      const frame = usePrevizStore.getState().timelineFrame;
      showPending(file.name, frame);
      try {
        seq.current += 1;
        const extension = audioFileExtension(file.name);
        const filename = `previz-audio-${nodeId}-${seq.current}.${extension}`;
        const [durationMs, upload] = await Promise.all([
          probeAudioDuration(file),
          uploadFreezoneAudio(project, file, filename),
        ]);
        place(
          { audioUrl: upload.url, sourceName: file.name, durationMs, sourceNodeId: null },
          frame,
        );
      } catch (error) {
        failed(error);
      } finally {
        setPending(null);
      }
    },
    [failed, nodeId, place, showPending, t],
  );

  const addUpstream = useCallback(
    async (source: PrevizUpstreamAudio) => {
      const frame = usePrevizStore.getState().timelineFrame;
      const base = {
        audioUrl: source.audioUrl,
        sourceName: source.displayName,
        sourceNodeId: source.nodeId,
      };
      if (source.durationMs !== null && source.durationMs > 0) {
        place({ ...base, durationMs: source.durationMs }, frame);
        return;
      }
      showPending(source.displayName, frame);
      try {
        const durationMs = await probeAudioDuration(source.audioUrl);
        place({ ...base, durationMs }, frame);
      } catch (error) {
        failed(error);
      } finally {
        setPending(null);
      }
    },
    [failed, place, showPending],
  );

  return { pending, addFile, addUpstream };
}
