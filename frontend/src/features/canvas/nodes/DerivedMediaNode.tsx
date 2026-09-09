// SPDX-License-Identifier: Elastic-2.0
import { useTranslation } from 'react-i18next';
import { Film, Shapes } from "lucide-react";
import { CanvasNodeImage } from "../ui/CanvasNodeImage";
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from "../ui/NodeHeader";
import { NodeGenerationOverlay } from "../ui/NodeGenerationOverlay";
import {
  CANVAS_NODE_PANEL_SURFACE_CLASS,
  canvasNodeFrameClass,
} from "../ui/nodeFrameStyles";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useCanvasStore } from "@/stores/canvasStore";
export function DerivedMediaNode({ id, data, selected, type }: NodeProps) {
  const { t } = useTranslation();
  const store = useCanvasStore();
  const gif = type === "animatedGifNode";
  const url = typeof data.imageUrl === "string" ? data.imageUrl : "";
  const busy = data.isGenerating === true;
  return (
    <div
      className={`group relative overflow-visible rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} ${canvasNodeFrameClass({ selected: Boolean(selected), mainline: false })}`}
      style={{ width: 360 }}
      onClick={() => store.setSelectedNode(id)}
    >
      <Handle id="target" type="target" position={Position.Left} />
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={gif ? <Film /> : <Shapes />}
        titleText={String(
          data.displayName || (gif ? t('canvas.derivedMedia.animatedTitle') : t('canvas.derivedMedia.vectorTitle')),
        )}
        editable
        onTitleChange={(displayName) =>
          store.updateNodeData(id, { displayName })
        }
      />
      <div className="relative overflow-hidden rounded-[var(--node-radius)] bg-bg-dark">
        {url ? (
          <CanvasNodeImage
            src={url}
            alt={gif ? t('canvas.derivedMedia.animated') : t('canvas.derivedMedia.vector')}
            className="block w-full object-contain"
          />
        ) : (
          <div className="h-48 flex items-center justify-center text-text-muted">
            {busy
              ? ""
              : data.generationError
                ? t('canvas.derivedMedia.failedSelect')
                : t('canvas.derivedMedia.selectConvert')}
          </div>
        )}
        {busy && (
          <>
            <NodeGenerationOverlay
              startedAt={
                typeof data.generationStartedAt === "number"
                  ? data.generationStartedAt
                  : null
              }
            />
            <p
              className="absolute inset-x-0 bottom-3 text-center text-xs text-text-muted"
              role="status"
            >
              {String(data.generationStage || t('canvas.derivedMedia.processing'))}
            </p>
          </>
        )}
        {Boolean(data.generationError) && (
          <p className="px-3 py-2 text-xs text-red-400" role="alert">
            {String(data.generationError)}
          </p>
        )}
      </div>
      <Handle id="source" type="source" position={Position.Right} />
    </div>
  );
}
