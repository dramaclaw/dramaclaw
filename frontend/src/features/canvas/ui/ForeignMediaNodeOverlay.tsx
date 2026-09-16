// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 「素材属于其他项目」节点遮罩（withLodShell 注入，shell 档和完整组件都有）。
 *
 * 守卫上线之前存下的画布里，有些媒体 URL 指向别的项目。静态资源按 URL 里的项目 id
 * 独立鉴权，所以源项目成员看着一切正常，换个同样合法的本项目成员打开就是一片 403 裂图
 * （SuperTale#192）。后端读取画布时会把这些引用报出来（`foreign_media`），这里把它变成
 * 一句解释 + 一键「复制到本项目」——修复只动节点数据，随下一次自动保存落库。
 *
 * 和 `AssetMigrationNodeOverlay` 的分工：那个管**新粘贴进来**、URL 从没进过 store 的
 * 占位节点；这个管**已经存进画布**的历史脏引用。
 */
import { useCallback, useState, useSyncExternalStore, type MouseEvent, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  foreignMediaTargetProject,
  readForeignMediaRefsForNode,
  repairForeignMediaRefs,
  resolveForeignMediaRefs,
  subscribeForeignMediaRefs,
} from '@/features/canvas/application/canvasMediaScope';

function stopEvent(event: SyntheticEvent) {
  event.stopPropagation();
}

const OVERLAY_CLASS =
  'absolute inset-0 z-[45] flex items-center justify-center rounded-[var(--node-radius)] bg-black/55 ring-2 ring-amber-500/70';
const PILL_CLASS =
  'flex max-w-[90%] flex-col items-start gap-1.5 rounded-md bg-[#1b1b1b]/95 px-3 py-1.5 text-[12px] font-medium text-white shadow-[0_8px_20px_rgba(0,0,0,0.45)] ring-1 ring-white/12';

function ForeignMediaNodeOverlayImpl({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  // 失败时给出的那句解释（i18n key）；什么都不显示的话按钮看着就是坏的，用户只会反复点。
  const [hint, setHint] = useState<string | null>(null);

  const handleRepair = useCallback(
    async (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const refs = readForeignMediaRefsForNode(nodeId);
      const targetProject = foreignMediaTargetProject();
      if (busy || refs.length === 0 || !targetProject) {
        return;
      }
      setBusy(true);
      setHint(null);
      try {
        const { urlMap, failedUrls, retryable } = await repairForeignMediaRefs({
          refs,
          targetProject,
          getLiveNodeData: (id) =>
            (useCanvasStore.getState().nodes.find((node) => node.id === id)?.data ??
              null) as never,
          updateNodeData: (id, patch) => {
            // 修复历史数据,不是用户的编辑动作:不进撤销栈。
            useCanvasStore.getState().updateNodeData(id, patch, { recordHistory: false });
          },
          // 拷不动就原样留着:这份数据后端已经放行,修不成也不该顺手删掉用户仅剩的线索。
          blankOnFailure: false,
        });
        if (retryable) {
          // 这一趟根本没走通(网络/5xx),一个字段都没动。说清楚是"再试一次"而不是
          // "没权限",否则用户会跑去要一个他其实已经有的权限。
          setHint('canvas.crossProjectAssets.foreignMediaCopyRetryable');
          return;
        }
        resolveForeignMediaRefs(nodeId, urlMap.keys());
        // 拷不动通常就是对源项目没权限。把原因说出来,他才知道该去要权限而不是重试。
        setHint(failedUrls.size > 0 ? 'canvas.crossProjectAssets.foreignMediaCopyFailed' : null);
      } finally {
        setBusy(false);
      }
    },
    [busy, nodeId],
  );

  return (
    <div
      data-testid="foreign-media-overlay"
      className={OVERLAY_CLASS}
      onClick={stopEvent}
      onDoubleClick={stopEvent}
    >
      <span className={PILL_CLASS}>
        <span className="flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span>{t('canvas.crossProjectAssets.foreignMedia')}</span>
        </span>
        {hint ? (
          <span className="text-[11px] font-normal text-amber-300">{t(hint)}</span>
        ) : null}
        <button
          type="button"
          className="nodrag nopan self-end rounded bg-white/12 px-2 py-0.5 text-[11px] hover:bg-white/20 disabled:opacity-60"
          onClick={handleRepair}
          onPointerDown={stopEvent}
          onMouseDown={stopEvent}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            t('canvas.crossProjectAssets.copyIntoProject')
          )}
        </button>
      </span>
    </div>
  );
}

export function ForeignMediaNodeOverlay({ nodeId }: { nodeId: string }) {
  // 快照是稳定引用（干净节点共用同一个空数组），登记表变化只让真正受影响的节点重渲染。
  const refs = useSyncExternalStore(subscribeForeignMediaRefs, () =>
    readForeignMediaRefsForNode(nodeId),
  );
  if (refs.length === 0) {
    return null;
  }
  return <ForeignMediaNodeOverlayImpl nodeId={nodeId} />;
}
