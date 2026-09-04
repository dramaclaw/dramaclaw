// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 双击引用素材跳到该素材所在位置后，画布底部浮出的「返回节点」提示条。
 *
 * 位置和形态与 [[BackToNodesHint]] 同一套（底部居中的胶囊）——两者都是「视口迷路了」
 * 的退路，长得一样用户不用重新认。两条同时出现时由 BackToNodesHint 让位上移。
 */
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useReactFlow } from '@xyflow/react';
import { X } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import { selectNodeExclusively } from '@/features/canvas/application/nodeSelection';
import { useViewportReturnStore } from '@/features/canvas/application/viewportReturnStore';

export function ViewportReturnHint() {
  const { t } = useTranslation();
  const request = useViewportReturnStore((state) => state.request);
  const stop = useViewportReturnStore((state) => state.stop);
  const reactFlow = useReactFlow();

  // 起点节点被删了，这条退路就没有意义了（回去也只剩空白），直接收掉。
  const originGone = useCanvasStore(
    (state) =>
      request !== null && !state.nodes.some((node) => node.id === request.originNodeId)
  );
  useEffect(() => {
    if (originGone) stop();
  }, [originGone, stop]);

  const handleReturn = useCallback(() => {
    if (!request) return;
    // 先选中再移视口：选中会把操作面板重新打开，用户回到的是「刚才正在写的那个节点」，
    // 而不只是一个坐标。
    selectNodeExclusively(request.originNodeId);
    void reactFlow.setViewport(request.originViewport, { duration: 320 });
    stop();
  }, [reactFlow, request, stop]);

  if (!request || originGone) return null;

  return (
    <div className="pointer-events-none absolute bottom-6 left-1/2 z-[132] -translate-x-1/2">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/10 bg-[#1f1f1f]/95 py-1.5 pl-4 pr-1.5 text-xs text-white/85 shadow-lg shadow-black/40 backdrop-blur">
        <span className="whitespace-nowrap">{t("canvas.viewportHint.focused")}</span>
        <button
          type="button"
          className="whitespace-nowrap rounded-full bg-white/[0.14] px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/25"
          onClick={handleReturn}
        >
          {t("canvas.viewportHint.returnToNode")}
        </button>
        <button
          type="button"
          title={t("common.close")}
          aria-label={t("common.close")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/[0.14] hover:text-white"
          onClick={stop}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
