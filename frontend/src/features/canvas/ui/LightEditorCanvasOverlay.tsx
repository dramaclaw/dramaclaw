import { memo, useMemo } from "react";

import { resolveNodeSourceImageUrl } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";
import { LightEditorOverlay } from "./LightEditorOverlay";

export const LightEditorCanvasOverlay = memo(() => {
  const nodes = useCanvasStore((state) => state.nodes);
  const nodeId = useCanvasStore((state) => state.activeLightEditorNodeId);
  const setNodeId = useCanvasStore((state) => state.setActiveLightEditorNodeId);

  const node = useMemo(() => {
    if (!nodeId) return null;
    return nodes.find((candidate) => candidate.id === nodeId) ?? null;
  }, [nodeId, nodes]);

  const imageSource = useMemo(() => resolveNodeSourceImageUrl(node), [node]);

  if (!node || !imageSource) return null;

  return (
    <LightEditorOverlay
      node={node}
      imageSource={imageSource}
      onClose={() => setNodeId(null)}
    />
  );
});

LightEditorCanvasOverlay.displayName = "LightEditorCanvasOverlay";
