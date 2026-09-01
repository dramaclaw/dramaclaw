// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Suspense, lazy, memo, useCallback, useMemo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Camera } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useCanvasStore } from "@/stores/canvasStore";
import { type PrevizNodeData } from "@/features/canvas/domain/canvasNodes";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from "@/features/canvas/ui/NodeHeader";
import {
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  canvasNodeFrameClass,
} from "@/features/canvas/ui/nodeFrameStyles";
import { buildNodeScenePatch, loadNodeScene } from "@/features/previz/nodeScene";
import { createDefaultScene, type PrevizScene } from "@/features/previz/domain/scene";

// three 只在真正打开预演台时才下载 —— 这是本节点在包体积上的全部要求。
const PrevizEditor = lazy(() =>
  import("@/features/previz/PrevizEditor").then((module) => ({ default: module.PrevizEditor })),
);

type PrevizNodeProps = NodeProps & {
  id: string;
  data: PrevizNodeData;
  selected?: boolean;
};

const NODE_WIDTH = 340;
const NODE_HEIGHT = 210;

export const PrevizNode = memo(({ id, data, selected }: PrevizNodeProps) => {
  const { t } = useTranslation();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isEditorOpen, setEditorOpen] = useState(false);

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.previz, data),
    [data],
  );

  const loaded = useMemo(() => loadNodeScene(data.scene), [data.scene]);
  // 必须 memo：`PrevizEditor` 里灌初始场景的 effect 依赖 `initialScene`，而 `loadScene`
  // 会清空 undo 历史。空节点走 `createDefaultScene()` 分支，不 memo 的话每次重渲染都
  // 是一个新对象，编辑期任何一次重渲染都会把用户的历史连同当前场景一起打回原点。
  const initialScene = useMemo(
    () => (loaded.ok ? loaded.scene : createDefaultScene()),
    [loaded],
  );

  const handleFlush = useCallback(
    (scene: PrevizScene) => {
      const result = buildNodeScenePatch(scene);
      if (!result.ok) {
        // 超限载荷一旦进整画布 PUT，canvasSync 收到 413 会永久停掉自动保存。
        toast.error(t("previz.editor.sceneTooLarge"));
        return;
      }
      updateNodeData(id, result.patch);
    },
    [id, t, updateNodeData],
  );

  return (
    <div
      className="group relative h-full w-full overflow-visible"
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      onClick={() => setSelectedNode(id)}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="target"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Camera className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(next) => updateNodeData(id, { displayName: next })}
      />

      <div
        className={`relative flex h-full w-full flex-col overflow-hidden rounded-[var(--node-radius)] border ${CANVAS_NODE_INPUT_SURFACE_CLASS} transition-colors ${canvasNodeFrameClass({ selected })}`}
      >
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-5 py-4 text-center">
          <button
            type="button"
            disabled={!loaded.ok}
            onClick={(event) => {
              event.stopPropagation();
              setEditorOpen(true);
            }}
            className="flex h-10 w-full items-center justify-center rounded-[12px] border border-white/15 bg-white/[0.04] px-4 text-center text-[13px] text-text-dark transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {t("previz.node.open")}
          </button>

          <span className="text-[12px] text-text-muted/90">
            {!loaded.ok
              ? t("previz.node.versionTooNew")
              : data.summary
                ? t("previz.node.summary", {
                    objects: data.summary.objectCount,
                    frames: data.summary.durationFrames,
                  })
                : t("previz.node.empty")}
          </span>

          <span className="text-[11px] text-text-muted/70">{t("previz.node.hint")}</span>
        </div>
      </div>

      {isEditorOpen && (
        <Suspense fallback={null}>
          <PrevizEditor
            open={isEditorOpen}
            nodeId={id}
            initialScene={initialScene}
            onOpenChange={setEditorOpen}
            onFlush={handleFlush}
          />
        </Suspense>
      )}
    </div>
  );
});

PrevizNode.displayName = "PrevizNode";
