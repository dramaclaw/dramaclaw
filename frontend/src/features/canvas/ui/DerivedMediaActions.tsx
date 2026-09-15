// SPDX-License-Identifier: Elastic-2.0
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
        {String(node.data.generationStage || t('canvas.derivedMedia.processing'))}
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
          {t('canvas.derivedMedia.preview')}
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
              toast.error(t('canvas.derivedMedia.downloadFailed'));
            } finally {
              setDownloading(false);
            }
          }}
        >
          {downloading ? <Loader2 className="animate-spin" /> : <Download />}
          {t('canvas.derivedMedia.download', { format: gif ? 'GIF' : 'SVG' })}
        </UiChipButton>
      </>
    );
  if (!gif || videoUrl)
    return (
      <UiChipButton className={TOOLBAR_TEXT_BUTTON_CLASS} onClick={retry}>
        <RefreshCw />
        {t(node.data.generationError ? 'canvas.derivedMedia.retryFree' : 'canvas.derivedMedia.startFree')}
      </UiChipButton>
    );
  return (
    <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
      <PopoverTrigger
        render={<UiChipButton className={TOOLBAR_TEXT_BUTTON_CLASS} />}
      >
        <RefreshCw />
        {t('canvas.derivedMedia.regenerateVideo')}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className={`nodrag space-y-3 ${TOOLBAR_MENU_CONTENT_CLASS}`}
      >
        <p className="text-sm">{t('canvas.derivedMedia.regenerateDescription')}</p>
        <p className="text-xs text-text-muted">
          {t('canvas.derivedMedia.videoBilling')}
        </p>
        {cost.error && (
          <p role="alert" className="text-xs text-destructive">
            {t('canvas.derivedMedia.quoteUnavailable')}
          </p>
        )}
        <div className="flex items-center justify-between">
          <CreditCostInline display={cost.data?.data.display} promotion={cost.data?.data.promotion} />
          <UiChipButton
            disabled={!available || cost.isLoading || Boolean(cost.error)}
            onClick={retry}
          >
            {t('canvas.derivedMedia.confirm')}
          </UiChipButton>
        </div>
      </PopoverContent>
    </Popover>
  );
}
