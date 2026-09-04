// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GLASS_DIALOG_EMPTY_BODY_CLASS } from "@/lib/dialog-styles";
import { useTranslation } from "react-i18next";
import { useViewerImmersiveBody } from "../useViewerImmersiveBody";
import type { ViewerPurpose } from "../viewerPurpose";
import type { PanoCaptureResult, PanoCaptureSaveResult, PanoViewerManifest } from "./panoManifest";
import { PanoCaptureSurface } from "./PanoCaptureSurface";

interface PanoCaptureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifest: PanoViewerManifest | null;
  title?: string;
  description?: string;
  captureLabel?: string;
  viewerPurpose?: ViewerPurpose;
  onCapture: (result: PanoCaptureResult) => void | PanoCaptureSaveResult | Promise<void | PanoCaptureSaveResult>;
}

export function PanoCaptureDialog({
  open,
  onOpenChange,
  manifest,
  title,
  description,
  captureLabel,
  viewerPurpose,
  onCapture,
}: PanoCaptureDialogProps) {
  const { t } = useTranslation();
  useViewerImmersiveBody(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="inset-0 left-0 top-0 h-dvh w-dvw max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 p-0 ring-0 data-open:zoom-in-100 data-closed:zoom-out-100 sm:max-w-none"
        overlayClassName="bg-black/55 supports-backdrop-filter:backdrop-blur-none"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title ?? t("viewer.pano.dialogTitle")}</DialogTitle>
          <DialogDescription>{description ?? t("viewer.pano.dialogDescription")}</DialogDescription>
        </DialogHeader>
        {manifest ? (
          <PanoCaptureSurface
            manifest={manifest}
            className="!bg-transparent"
            captureLabel={captureLabel}
            viewerPurpose={viewerPurpose}
            onCapture={onCapture}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <div className={GLASS_DIALOG_EMPTY_BODY_CLASS}>
            {t("viewer.noPanoManifest")}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
