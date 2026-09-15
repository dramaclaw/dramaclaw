// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 画面裁切的底部浮条：退出、比例预设、实时尺寸、生成。只负责展示与回调，框状态在 VideoNode。
import { ArrowUp, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CROP_RATIO_PRESETS, type CropRatioId } from "@/features/canvas/application/videoCrop/cropMath";
import { CANVAS_NODE_OPS_PANEL_CLASS } from "@/features/canvas/ui/nodeFrameStyles";

interface VideoCropPanelProps {
  ratioId: CropRatioId;
  /** 偶数取整后的源像素尺寸；还没有框时传 0。 */
  width: number;
  height: number;
  isSubmitting: boolean;
  canSubmit: boolean;
  onRatioChange: (ratioId: CropRatioId) => void;
  onCancel: () => void;
  onSubmit: () => void;
  /** 提交中点 X：中止这次裁剪请求，不是退出裁剪模式——框还留着。 */
  onAbort: () => void;
}

export function VideoCropPanel({
  ratioId,
  width,
  height,
  isSubmitting,
  canSubmit,
  onRatioChange,
  onCancel,
  onSubmit,
  onAbort,
}: VideoCropPanelProps) {
  const { t } = useTranslation();

  const ratioLabel = (id: CropRatioId) => {
    if (id === "free") return t("node.videoNode.crop.ratio.free");
    if (id === "original") return t("node.videoNode.crop.ratio.original");
    return id;
  };

  // 提交中 X 的含义从「退出裁剪」变成「取消这次提交」，所以必须仍然可点，
  // 且换一套文案，不能让用户以为点了没反应。
  const closeLabel = isSubmitting ? t("node.videoNode.crop.abort") : t("node.videoNode.crop.cancel");

  return (
    <div
      className={`nodrag nopan nowheel flex items-center gap-2 rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} p-2`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={isSubmitting ? onAbort : onCancel}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-dark/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
      >
        <X className="h-4 w-4" />
      </button>

      <div role="group" aria-label={t("node.videoNode.crop.ratioGroup")} className="flex items-center gap-1">
        {CROP_RATIO_PRESETS.map((id) => {
          const active = id === ratioId;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              disabled={isSubmitting}
              onClick={() => onRatioChange(id)}
              className={`h-7 shrink-0 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                active
                  ? "bg-white text-black"
                  : "text-text-dark/80 hover:bg-white/[0.08] hover:text-white"
              }`}
            >
              {ratioLabel(id)}
            </button>
          );
        })}
      </div>

      <span className="min-w-[88px] shrink-0 whitespace-nowrap text-center text-[12px] tabular-nums text-text-muted">
        {width > 0 && height > 0 ? `${width} × ${height}` : "—"}
      </span>

      <button
        type="button"
        aria-label={t("node.videoNode.crop.submit")}
        title={t("node.videoNode.crop.submit")}
        disabled={isSubmitting || !canSubmit}
        onClick={onSubmit}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/30 disabled:text-text-muted"
      >
        {isSubmitting ? (
          <Loader2 className="h-4 w-4 animate-spin" data-testid="video-crop-submitting" />
        ) : (
          <ArrowUp className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
