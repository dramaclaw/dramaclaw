// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 深度动作捕捉产出节点在拿到 videoUrl 之前的节点体：处理中显示进度；失败或刷新后
// 残留的 running 态（任务表里已没有它）显示错误与重试。
import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { DEPTH_MAX_DURATION_SEC } from "@/features/canvas/application/depthCapture/depthMath";
import {
  isDepthCaptureActive,
  startDepthCapture,
} from "@/features/canvas/application/depthCapture/runDepthCapture";
import type { DepthCaptureState } from "@/features/canvas/domain/canvasNodes";
import { RegenerateButton } from "@/features/canvas/ui/RegenerateButton";
import { readUrl } from "@/lib/url-params";

const ERROR_KEYS = {
  tooLong: "node.videoNode.depthCapture.errors.tooLong",
  noVideoTrack: "node.videoNode.depthCapture.errors.noVideoTrack",
  cannotDecode: "node.videoNode.depthCapture.errors.cannotDecode",
  cancelled: "node.videoNode.depthCapture.errors.cancelled",
  failed: "node.videoNode.depthCapture.errors.failed",
} as const;

export function DepthCaptureBody({ nodeId, state }: { nodeId: string; state: DepthCaptureState }) {
  const { t } = useTranslation();

  if (state.status === "running" && isDepthCaptureActive(nodeId)) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-muted/85">
        <Loader2 className="h-7 w-7 animate-spin opacity-70" />
        <span className="px-4 text-center text-[12px] leading-6">
          {state.progress > 0
            ? t("node.videoNode.depthCapture.processing", { percent: state.progress })
            : t("node.videoNode.depthCapture.preparing")}
        </span>
      </div>
    );
  }

  const reason =
    state.status === "running"
      ? t("node.videoNode.depthCapture.interrupted")
      : t(ERROR_KEYS[state.errorCode ?? "failed"], { seconds: DEPTH_MAX_DURATION_SEC });
  const detail = state.status === "failed" && state.errorCode === "failed" ? state.errorDetail : null;

  const handleRetry = () => {
    const projectId = readUrl().project;
    if (!projectId) {
      toast.error(t("node.videoNode.depthCapture.errors.noProject"));
      return;
    }
    void startDepthCapture({ nodeId, projectId, sourceVideoUrl: state.sourceVideoUrl });
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-red-300">
      <AlertTriangle className="h-7 w-7 opacity-90" />
      <span className="text-center text-[12px] font-medium leading-5 text-red-200">
        {t("node.videoNode.depthCapture.failed")}
      </span>
      <span className="max-h-[64px] overflow-y-auto break-words text-center text-[11px] leading-5 text-red-200/90 [overflow-wrap:anywhere]">
        {reason}
        {detail ? `：${detail}` : ""}
      </span>
      <div className="mt-1">
        <RegenerateButton onClick={handleRetry} label={t("node.videoNode.depthCapture.retry")} />
      </div>
    </div>
  );
}
