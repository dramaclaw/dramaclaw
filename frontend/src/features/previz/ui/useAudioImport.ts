// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { uploadFreezoneAudio } from '@/api/ops';
import { backendErrorToastMessage } from '@/lib/api-errors';
import { readUrl } from '@/lib/url-params';

import {
  audioFileExtension,
  audioInsertBlockedAt,
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
  /**
   * 每次导入领一个号。两次导入撞在一起时，先落地的那次不能顺手把后一次的占位条
   * 抹掉——`pending` 是这个 hook 对外唯一的进度信号，抹早了轨道上就没东西了。
   */
  const serial = useRef(0);

  const place = useCallback(
    (source: PrevizAudioSource, frame: number) => {
      const rejection = usePrevizStore.getState().addAudioClip(source, frame);
      if (rejection === 'no-room') toast.error(t('previz.audio.noRoom'));
      else if (rejection === 'limit') toast.error(t('previz.audio.limit'));
    },
    [t],
  );

  /**
   * 上传/探测之前先问一次不看时长就能定的拒绝理由，顺手提示。返回 true 表示别再往下走。
   * 放不下是现在就知道的事，别让人等完一个 20 MB 的上传再被拒——那份文件后端已经落盘，
   * 留下的是一个没人引用的孤儿。剩下的「素材比空隙短」得等时长，仍由 `place` 兜底。
   */
  const refuseEarly = useCallback(
    (frame: number) => {
      const blocked = audioInsertBlockedAt(usePrevizStore.getState().scene, frame);
      if (!blocked) return false;
      toast.error(blocked === 'limit' ? t('previz.audio.limit') : t('previz.audio.noRoom'));
      return true;
    },
    [t],
  );

  /** 领号、挂占位条，返回一个只在本次导入仍是最新一次时才清空占位的收尾函数。 */
  const beginPending = useCallback((name: string, frame: number) => {
    serial.current += 1;
    const mine = serial.current;
    const { durationFrames } = usePrevizStore.getState().scene.settings;
    // 时长未知，先占一秒宽，让人看见轨道上有东西在来。夹到时间轴末尾，
    // 免得占位条画到轨道外面去。
    setPending({
      startFrame: frame,
      endFrame: Math.min(frame + PREVIZ_FPS, durationFrames),
      name,
    });
    return () => {
      if (serial.current === mine) setPending(null);
    };
  }, []);

  const failed = useCallback(
    (error: unknown) => {
      // `uploadFreezoneImage` 走的是原始 apiClient，抛出来的 ky `HTTPError` 的 message 里
      // 带着内部 API 地址；给人看的那条被挂在 `.cause` 上（见 api/client.ts 的 beforeError）。
      const cause = (error as { cause?: unknown } | null)?.cause;
      const shown = cause instanceof Error ? cause : error;
      toast.error(t('previz.audio.uploadFailed', { message: backendErrorToastMessage(shown, t) }));
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
        toast.error(t('previz.audio.noProject'));
        return;
      }
      const frame = usePrevizStore.getState().timelineFrame;
      if (refuseEarly(frame)) return;
      const settle = beginPending(file.name, frame);
      try {
        const extension = audioFileExtension(file.name);
        const [durationMs, upload] = await Promise.all([
          probeAudioDuration(file),
          uploadFreezoneAudio(project, file, `previz-audio-${nodeId}.${extension}`),
        ]);
        place(
          { audioUrl: upload.url, sourceName: file.name, durationMs, sourceNodeId: null },
          frame,
        );
      } catch (error) {
        failed(error);
      } finally {
        settle();
      }
    },
    [beginPending, failed, nodeId, place, refuseEarly, t],
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
      if (refuseEarly(frame)) return;
      const settle = beginPending(source.displayName, frame);
      try {
        const durationMs = await probeAudioDuration(source.audioUrl);
        place({ ...base, durationMs }, frame);
      } catch (error) {
        failed(error);
      } finally {
        settle();
      }
    },
    [beginPending, failed, place, refuseEarly],
  );

  return { pending, addFile, addUpstream };
}
