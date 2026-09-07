// SPDX-License-Identifier: Elastic-2.0
import { useState } from "react";
import { Download, Expand, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { UiChipButton } from "@/components/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { downloadUrlAsFile } from "@/lib/browserDownload";
import { readUrl } from "@/lib/url-params";
import { useCanvasStore } from "@/stores/canvasStore";
import type { CanvasNode } from "../domain/canvasNodes";
import { generateDerivedMedia } from "../application/derivedMedia";
import { useDerivedVideoCost } from "./ImageDerivedActions";
import {
  TOOLBAR_MENU_CONTENT_CLASS,
  TOOLBAR_TEXT_BUTTON_CLASS,
} from "./nodeToolbarStyles";

export function DerivedMediaActions({ node }: { node: CanvasNode }) {
  const store = useCanvasStore();
  const { cost, available } = useDerivedVideoCost();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const gif = node.type === "animatedGifNode";
  const url = typeof node.data.imageUrl === "string" ? node.data.imageUrl : "";
  const videoUrl =
    typeof node.data.sourceVideoUrl === "string"
      ? node.data.sourceVideoUrl
      : undefined;
  const busy = node.data.isGenerating === true;
  const retry = () => {
    const { project, canvas } = readUrl();
    if (!project || busy) return;
    setConfirmOpen(false);
    void generateDerivedMedia(
      project,
      node.id,
      gif ? "gif" : "svg",
      String(node.data.sourceImageUrl || ""),
      videoUrl,
      canvas,
      (patch) => store.updateNodeData(node.id, patch),
    );
  };
  if (busy)
    return (
      <span
        role="status"
        className="flex h-9 items-center gap-2 px-3 text-text-muted"
      >
        <Loader2 className="animate-spin" />
        {String(node.data.generationStage || "正在处理")}
      </span>
    );
  if (url)
    return (
      <>
        <UiChipButton
          className={TOOLBAR_TEXT_BUTTON_CLASS}
          onClick={() => store.openImageViewer(url, [url])}
        >
          <Expand />
          预览
        </UiChipButton>
        <UiChipButton
          className={TOOLBAR_TEXT_BUTTON_CLASS}
          disabled={downloading}
          onClick={async () => {
            setDownloading(true);
            try {
              await downloadUrlAsFile(
                url,
                gif ? "animation.gif" : "vector.svg",
              );
            } catch {
              toast.error("下载失败，请重试");
            } finally {
              setDownloading(false);
            }
          }}
        >
          {downloading ? <Loader2 className="animate-spin" /> : <Download />}
          下载 {gif ? "GIF" : "SVG"}
        </UiChipButton>
      </>
    );
  if (!gif || videoUrl)
    return (
      <UiChipButton className={TOOLBAR_TEXT_BUTTON_CLASS} onClick={retry}>
        <RefreshCw />
        {node.data.generationError ? "重试转换" : "开始转换"} · 免费
      </UiChipButton>
    );
  return (
    <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
      <PopoverTrigger
        render={<UiChipButton className={TOOLBAR_TEXT_BUTTON_CLASS} />}
      >
        <RefreshCw />
        重新生成视频
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className={`nodrag space-y-3 ${TOOLBAR_MENU_CONTENT_CLASS}`}
      >
        <p className="text-sm">重新生成视频后转换为 GIF</p>
        <p className="text-xs text-text-muted">
          首帧锁定 · 4 秒 · 720P · 无音频，视频按报价计费，GIF 转换免费。
        </p>
        {cost.error && (
          <p role="alert" className="text-xs text-destructive">
            暂时无法获取积分报价，请稍后重试。
          </p>
        )}
        <div className="flex items-center justify-between">
          <CreditCostInline display={cost.data?.data.display} />
          <UiChipButton
            disabled={!available || cost.isLoading || Boolean(cost.error)}
            onClick={retry}
          >
            确认生成
          </UiChipButton>
        </div>
      </PopoverContent>
    </Popover>
  );
}
