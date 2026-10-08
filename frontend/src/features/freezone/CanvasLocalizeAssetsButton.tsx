// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 画布右上角的「一键本地化」。
 *
 * 为什么需要它：导入当时素材没存下来的原因往往是**环境性**的——代理软件的 fake-IP
 * 把 CDN 域名解析进私有段、源站限流、单文件超限。环境修好之后，唯一的补救手段本来是
 * 重新导入整张画布，而那会丢掉用户已经在画布上做的全部改动。这个按钮只按地址补下载，
 * 落盘目录与导入完全一致，画布结构一个字节都不动。
 *
 * 只在真的有远端素材时出现——没有待办就不该在画布上多一块 chrome。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudDownload, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  nodeHasRemoteMediaUrl,
} from '@/features/canvas/domain/canvasRemoteMedia';
import { CANVAS_CONTROL_GLASS_CLASS } from '@/features/canvas/ui/canvasControlStyles';
import { useCanvasStore } from '@/stores/canvasStore';
import { flushFreezoneCanvasRuntime } from './canvasSyncRuntime';
import { localizeLiblibCanvasInBackground, type LocalizationProgress } from './liblibBackgroundLocalization';

export function CanvasLocalizeAssetsButton({
  project,
  canvasId,
  sourceProjectId,
  autoStartKey = null,
  ready = true,
}: {
  project: string;
  canvasId: string;
  sourceProjectId: string | null;
  autoStartKey?: string | null;
  ready?: boolean;
}) {
  const { t } = useTranslation();
  // 只订阅「有没有远端素材」这个布尔量,不订阅 nodes 本身。
  // 订阅 nodes 的代价是:拖动节点时 applyNodeChanges 每帧产生新数组,这个组件就会
  // 每帧重渲染 + 深走一遍全部节点数据。地址清单在点击那一刻现算就够了。
  const hasRemote = useCanvasStore((state) => state.nodes.some(nodeHasRemoteMediaUrl));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [progress, setProgress] = useState<LocalizationProgress | null>(null);
  const alive = useRef(true);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const busy = useRef(false);
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = useCallback(async () => {
    if (busy.current || !readyRef.current) return;
    busy.current = true;
    setRunning(true);
    setResult(null);
    const isActive = () => alive.current && readyRef.current;
    try {
      const outcome = await localizeLiblibCanvasInBackground({
        project,
        sourceProjectId,
        isActive,
        onProgress: setProgress,
        save: async () => {
          const saved = await flushFreezoneCanvasRuntime(project, canvasId);
          if (saved !== true) throw new Error(t('freezone.canvases.currentSaveFailed'));
        },
      });
      if (!outcome || !isActive()) return;
      const { done, failed } = outcome;
      setResult(
        done === 0 && failed === 0
          ? t('canvas.remoteMedia.localize.none')
          : failed > 0
            ? t('canvas.remoteMedia.localize.partial', { done, failed })
            : t('canvas.remoteMedia.localize.done', { count: done }),
      );
    } catch (error) {
      if (!isActive()) return;
      setResult(
        t('canvas.remoteMedia.localize.failed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      busy.current = false;
      if (alive.current) setRunning(false);
    }
  }, [project, canvasId, sourceProjectId, t]);

  useEffect(() => {
    if (!ready || !autoStartKey || !hasRemote || attempted.current === autoStartKey) return;
    attempted.current = autoStartKey;
    void run();
  }, [ready, autoStartKey, hasRemote, run]);

  if (!hasRemote && !running && !result) return null;

  const label = running
    ? progress
      ? t('canvas.remoteMedia.localize.runningProgress', { completed: progress.completed, total: progress.total })
      : t('canvas.remoteMedia.localize.running')
    : result ?? t('canvas.remoteMedia.localize.label');

  return (
    <div
      // FPS 计量器占着 `right-3 top-3`，开启读数后会向左撑开；错开一行，两者永远不会打架。
      className="nopan nowheel pointer-events-auto absolute right-3 top-14 z-30"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={run}
        disabled={running || !ready}
        title={t('canvas.remoteMedia.localize.hint')}
        className={`inline-flex items-center gap-1.5 rounded-full border-amber-300/40 bg-amber-300/10 px-2.5 py-1 text-[11px] leading-none text-amber-100 transition hover:bg-amber-300/20 disabled:cursor-default disabled:opacity-70 ${CANVAS_CONTROL_GLASS_CLASS}`}
      >
        {running
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : <CloudDownload className="h-3 w-3" />}
        <span>{label}</span>
      </button>
    </div>
  );
}
