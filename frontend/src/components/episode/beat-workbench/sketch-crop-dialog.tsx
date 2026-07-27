// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Crop, Loader2, Save, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useCropSketch,
  useSketchPoseEditor,
  type SketchCrop,
} from "@/lib/queries/sketch-pose-editor";
import { resolveMediaUrl } from "@/lib/media-url";
import { centerCropBoxForRatio, zoomCropBox } from "@/lib/aspect-ratio";
import { useProjectAspectRatio } from "@/stores/aspect-ratio-store";
import { withImageCacheBust } from "@/features/canvas/application/imageData";
import { CROP_DIALOG_SAVE_BUTTON_CLASS } from "./media-styles";

interface SketchCropDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string;
  episode: number;
  beatNum: number;
}

export function SketchCropDialog({
  open,
  onOpenChange,
  project,
  episode,
  beatNum,
}: SketchCropDialogProps) {
  const { t } = useTranslation();
  const { spec } = useProjectAspectRatio(project);
  const poseQuery = useSketchPoseEditor(project, episode, beatNum, open);
  const cropSketch = useCropSketch(project, episode);
  const data = poseQuery.data?.ok ? poseQuery.data.data : null;
  const sketchUrl = data?.sketch_url
    ? withImageCacheBust(resolveMediaUrl(data.sketch_url) ?? data.sketch_url, poseQuery.dataUpdatedAt)
    : "";
  const loadError =
    !data && poseQuery.error instanceof Error
      ? poseQuery.error.message
      : !data && poseQuery.isError
        ? t("common.error")
        : null;
  const imageRef = useRef<HTMLImageElement | null>(null);
  const cropBoxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    crop: SketchCrop;
  } | null>(null);
  const [crop, setCrop] = useState<SketchCrop>({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });

  useEffect(() => {
    if (!data || !open) return;
    setCrop(centerCropBoxForRatio(data.width, data.height, spec.ratioValue));
  }, [data?.height, data?.width, open, spec.ratioValue]);

  useEffect(() => {
    const cropBox = cropBoxRef.current;
    if (!cropBox || !data || !open) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setCrop((current) =>
        zoomCropBox(
          current,
          data.width,
          data.height,
          event.deltaY < 0 ? 0.9 : 1.1,
        ),
      );
    };

    cropBox.addEventListener("wheel", handleWheel, { passive: false });
    return () => cropBox.removeEventListener("wheel", handleWheel);
  }, [data?.height, data?.width, open]);

  const cropBoxStyle = data ? cropBoxPercentStyle(crop, data.width, data.height) : undefined;

  const moveCropBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !data || !imageRef.current) return;
    const imageRect = imageRef.current.getBoundingClientRect();
    if (imageRect.width <= 0 || imageRect.height <= 0) return;

    const scaleX = data.width / imageRect.width;
    const scaleY = data.height / imageRect.height;
    const drag = dragRef.current;
    setCrop(
      clampCropBox(
        {
          ...drag.crop,
          x: drag.crop.x + (event.clientX - drag.clientX) * scaleX,
          y: drag.crop.y + (event.clientY - drag.clientY) * scaleY,
        },
        data.width,
        data.height,
      ),
    );
  };

  const handleSave = async () => {
    try {
      const res = await cropSketch.mutateAsync({ beatNum, crop });
      if (!res.ok) {
        toast.error(res.error || t("common.error"));
        return;
      }
      toast.success(t("episode.workbench.sketch.cropSaved"));
      onOpenChange(false);
    } catch {
      toast.error(t("common.error"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden rounded-none border-0 bg-black p-0 text-white ring-white/10 sm:max-w-[min(96vw,1120px)]"
      >
        <div className="relative flex h-12 items-center border-b border-white/10 px-4">
          <div className="flex items-center gap-2 text-sm font-medium text-white">
            <Crop className="size-4" />
            {t("episode.workbench.sketch.cropTitleWithAspect", { aspect: spec.label })}
          </div>
          <DialogTitle className="absolute left-1/2 max-w-[52vw] -translate-x-1/2 truncate text-center text-sm font-medium text-white">
            {t("episode.workbench.sketch.cropTitle", { n: beatNum })}
          </DialogTitle>
          <button
            type="button"
            aria-label={t("common.close")}
            className="absolute right-4 flex size-7 items-center justify-center text-white/90 hover:text-white"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-5" />
          </button>
        </div>
        {!data ? (
          loadError ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 p-6 text-center text-sm text-white/70">
              <AlertCircle className="size-5 text-amber-300" />
              <div className="max-w-md">{loadError}</div>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.close", "Close")}
              </Button>
            </div>
          ) : (
            <div className="flex min-h-[360px] items-center justify-center p-6 text-sm text-white/70">
              <Loader2 className="mr-2 size-4 animate-spin" />
              {t("common.loading", "Loading")}
            </div>
          )
        ) : (
          <>
            <div className="relative flex min-h-[360px] items-center justify-center bg-black p-4">
              <div className="relative inline-block max-h-[72vh] max-w-full">
                <img
                  ref={imageRef}
                  src={sketchUrl}
                  alt={`B${beatNum}`}
                  className="block max-h-[72vh] max-w-full object-contain"
                  loading="lazy"
                  decoding="async"
                />
                {cropBoxStyle ? (
                  <div
                    ref={cropBoxRef}
                    role="button"
                    tabIndex={0}
                    aria-label={t("episode.workbench.sketch.cropDragHandle")}
                    className="absolute cursor-move touch-none border-2 border-cyan-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.58)]"
                    style={cropBoxStyle}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                      dragRef.current = {
                        pointerId: event.pointerId,
                        clientX: event.clientX,
                        clientY: event.clientY,
                        crop,
                      };
                    }}
                    onPointerMove={moveCropBox}
                    onPointerUp={(event) => {
                      event.currentTarget.releasePointerCapture?.(event.pointerId);
                      dragRef.current = null;
                    }}
                    onPointerCancel={(event) => {
                      event.currentTarget.releasePointerCapture?.(event.pointerId);
                      dragRef.current = null;
                    }}
                  >
                    <div className="pointer-events-none absolute inset-y-0 left-1/3 border-l border-white/30" />
                    <div className="pointer-events-none absolute inset-y-0 left-2/3 border-l border-white/30" />
                    <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-white/30" />
                    <div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-white/30" />
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-white/10 bg-black px-4 py-3">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                onClick={handleSave}
                disabled={cropSketch.isPending}
                className={CROP_DIALOG_SAVE_BUTTON_CLASS}
              >
                {cropSketch.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                {t("common.save", "Save")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function cropBoxPercentStyle(
  crop: SketchCrop,
  sourceWidth: number,
  sourceHeight: number,
): CSSProperties {
  const safeWidth = Math.max(1, sourceWidth);
  const safeHeight = Math.max(1, sourceHeight);

  return {
    left: `${(crop.x / safeWidth) * 100}%`,
    top: `${(crop.y / safeHeight) * 100}%`,
    width: `${(crop.width / safeWidth) * 100}%`,
    height: `${(crop.height / safeHeight) * 100}%`,
  };
}

function clampCropBox(
  crop: SketchCrop,
  sourceWidth: number,
  sourceHeight: number,
): SketchCrop {
  const width = Math.max(1, Math.min(Math.round(crop.width), sourceWidth));
  const height = Math.max(1, Math.min(Math.round(crop.height), sourceHeight));

  return {
    x: Math.min(Math.max(0, Math.round(crop.x)), Math.max(0, sourceWidth - width)),
    y: Math.min(Math.max(0, Math.round(crop.y)), Math.max(0, sourceHeight - height)),
    width,
    height,
  };
}
