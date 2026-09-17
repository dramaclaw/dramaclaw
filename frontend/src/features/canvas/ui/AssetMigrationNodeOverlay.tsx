// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 跨项目粘贴进来的节点，在素材拷进本项目之前 / 拷贝失败之后盖在节点上的占位遮罩
 * （withLodShell 注入，shell 档和完整组件都有）。
 *
 * - `copying` 且迁移任务在跑：转圈 + 「素材复制中」；
 * - `failed`，或标记还是 `copying` 但任务已不在（刷新过页面、迁移意外中断）：错误占位 +
 *   「移除节点」——节点里本来就没有源项目 URL，用户删掉重贴即可。
 *
 * 遮罩不拦 pointerdown：占位节点照样能拖、能选、能右键删除；只吃 click / 双击，免得
 * 点穿到底下空节点的「上传 / 选图」入口，把半成品当成正常节点继续用。
 */
import { memo, useSyncExternalStore, type MouseEvent, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  isAssetMigrationInFlight,
  readAssetMigrationState,
  subscribeAssetMigrations,
  type AssetMigrationState,
} from '@/features/canvas/application/crossProjectAssets';

function stopEvent(event: SyntheticEvent) {
  event.stopPropagation();
}

const OVERLAY_CLASS =
  'absolute inset-0 z-[45] flex items-center justify-center rounded-[var(--node-radius)]';
const PILL_CLASS =
  'flex max-w-[90%] items-center gap-2 rounded-md bg-[#1b1b1b]/95 px-3 py-1.5 text-[12px] font-medium text-white shadow-[0_8px_20px_rgba(0,0,0,0.45)] ring-1 ring-white/12';

function CopyingOverlay() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="asset-migration-copying"
      className={`${OVERLAY_CLASS} bg-black/45`}
      onClick={stopEvent}
      onDoubleClick={stopEvent}
    >
      <span className={PILL_CLASS}>
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span className="truncate">{t('canvas.crossProjectAssets.copying')}</span>
      </span>
    </div>
  );
}

function FailedOverlay({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation();
  const handleRemove = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    useCanvasStore.getState().deleteNode(nodeId);
  };
  return (
    <div
      data-testid="asset-migration-failed"
      className={`${OVERLAY_CLASS} bg-black/55 ring-2 ring-red-500/70`}
      onClick={stopEvent}
      onDoubleClick={stopEvent}
    >
      <span className={`${PILL_CLASS} flex-col items-start gap-1.5`}>
        <span className="flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
          <span>{t('canvas.crossProjectAssets.failedPlaceholder')}</span>
        </span>
        <button
          type="button"
          className="nodrag nopan self-end rounded bg-white/12 px-2 py-0.5 text-[11px] hover:bg-white/20"
          onClick={handleRemove}
          onPointerDown={stopEvent}
          onMouseDown={stopEvent}
        >
          {t('canvas.crossProjectAssets.removeNode')}
        </button>
      </span>
    </div>
  );
}

function AssetMigrationNodeOverlayImpl({
  nodeId,
  state,
}: {
  nodeId: string;
  state: AssetMigrationState;
}) {
  // 快照是 boolean，登记表变化只让在途状态真正翻转的那个节点重渲染。
  const inFlight = useSyncExternalStore(subscribeAssetMigrations, () =>
    isAssetMigrationInFlight(nodeId)
  );
  if (state === 'copying' && inFlight) {
    return <CopyingOverlay />;
  }
  return <FailedOverlay nodeId={nodeId} />;
}

function AssetMigrationNodeOverlayBase({ nodeId, data }: { nodeId: string; data: unknown }) {
  // 绝大多数节点没有标记：这里不订阅任何东西、直接 null，不给每个节点多一份开销。
  const state = readAssetMigrationState(data);
  if (!state) {
    return null;
  }
  return <AssetMigrationNodeOverlayImpl nodeId={nodeId} state={state} />;
}

export const AssetMigrationNodeOverlay = memo(AssetMigrationNodeOverlayBase);
