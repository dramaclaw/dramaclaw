import { Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCanvasStore } from "@/stores/canvasStore";

/** Display-only preview: never submits a generation or upscale action. */
export function CanvasImagePreviewButton({ imageUrl }: { imageUrl: string }) {
  const { t } = useTranslation();
  const openImageViewer = useCanvasStore((state) => state.openImageViewer);
  const label = t("node.imageGen.previewFullImage");
  return (
    <button
      type="button"
      className="nodrag nopan absolute right-2 top-2 z-30 flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-surface-dark text-text shadow-sm hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      title={label}
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        openImageViewer(imageUrl, [imageUrl]);
      }}
    >
      <Maximize2 size={16} aria-hidden="true" />
    </button>
  );
}
