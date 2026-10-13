// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Crosshair, X } from "lucide-react";

import { useCanvasStore } from "@/stores/canvasStore";
import { useCanvasPickStore } from "@/stores/canvasPickStore";

/**
 * 「从画布选择」拾取模式的顶部提示条。
 *
 * 拾取期间画布上的候选节点会浮出「选择 xxx」覆盖层（见各节点实现），这条横幅负责
 * 告诉用户当前在选什么、怎么回到发起的节点、怎么退出。
 */
export function CanvasPickBanner() {
  const { t } = useTranslation();
  const request = useCanvasPickStore((state) => state.request);
  const cancelPick = useCanvasPickStore((state) => state.cancelPick);
  const nodes = useCanvasStore((state) => state.nodes);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const requestFocusNode = useCanvasStore((state) => state.requestFocusNode);

  const requesterNodeId = request?.requesterNodeId ?? null;
  const requesterExists =
    requesterNodeId !== null && nodes.some((node) => node.id === requesterNodeId);

  // 发起节点被删掉了就没人接收结果了，直接退出拾取模式，别把横幅挂死在画布上。
  useEffect(() => {
    if (requesterNodeId && !requesterExists) {
      cancelPick();
    }
  }, [cancelPick, requesterExists, requesterNodeId]);

  // Esc 退出：拾取模式下画布的常规交互被覆盖层挡住了，键盘是最顺手的逃生口。
  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        cancelPick();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancelPick, request]);

  if (!request || !requesterExists) return null;

  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-50 -translate-x-1/2">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/12 bg-[#242426]/95 py-2 pl-4 pr-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)] backdrop-blur-sm">
        <Crosshair className="h-4 w-4 shrink-0 text-cyan-200" />
        <div className="flex flex-col leading-tight">
          <span className="text-[13px] font-medium text-text-dark">
            {t("canvasPick.title")}
          </span>
          <span className="text-[11px] text-text-muted/90">
            {t("canvasPick.hint")}
          </span>
        </div>
        <button
          type="button"
          className="ml-1 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-[12px] text-text-dark transition-colors hover:bg-white/[0.12]"
          onClick={() => {
            setSelectedNode(request.requesterNodeId);
            requestFocusNode(request.requesterNodeId);
          }}
        >
          {t("canvasPick.backToNode")}
        </button>
        <button
          type="button"
          aria-label={t("canvasPick.cancel")}
          title={t("canvasPick.cancel")}
          className="rounded-full p-1.5 text-text-muted transition-colors hover:bg-white/[0.08] hover:text-text-dark"
          onClick={cancelPick}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
