// SPDX-License-Identifier: Elastic-2.0
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
          data.displayName || (gif ? "动态图 · GIF" : "矢量图 · SVG"),
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
            alt={gif ? "动态图" : "矢量图"}
            className="block w-full object-contain"
          />
        ) : (
          <div className="h-48 flex items-center justify-center text-text-muted">
            {busy
              ? ""
              : data.generationError
                ? "生成失败，选中节点后可重试"
                : "选中节点开始转换"}
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
              {String(data.generationStage || "正在处理")}
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
