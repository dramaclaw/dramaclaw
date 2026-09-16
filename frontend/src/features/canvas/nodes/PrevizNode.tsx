// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  PREVIZ_BOOT_TIMEOUT_MS,
  PrevizBootOverlay,
  type PrevizBootPhase,
} from "@/features/previz/ui/PrevizBootOverlay";

// three 只在真正打开预演台时才下载 —— 这是本节点在包体积上的全部要求。
const PrevizEditor = lazy(() =>
  import("@/features/previz/PrevizEditor").then((module) => ({ default: module.PrevizEditor })),
);

/**
 * 与编辑器同在一个 Suspense 里，同一批提交：它挂上的那一刻就是编辑器代码块到了。
 * 入场遮罩靠它把文案从「加载引擎」换成「载入模型」。
 *
 * 不另写一次 `import()` 去等模块：那样多出一条与 lazy 并行的加载路径，关窗、重开、
 * 超时撤场几种时序都得各自对一遍号。
 */
function EditorChunkArrived({ onArrive }: { onArrive: () => void }) {
  useEffect(() => {
    onArrive();
  }, [onArrive]);
  return null;
}

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
  /**
   * 入场遮罩的阶段，`null` = 不盖。从点「打开」那一刻一直盖到编辑器报就绪：中间先是
   * 代码块下载（Suspense 这段什么都不画），再是人物模型与动画库那十几 MB。
   */
  const [bootPhase, setBootPhase] = useState<PrevizBootPhase | null>(null);
  const booting = bootPhase !== null;

  const openEditor = () => {
    setEditorOpen(true);
    setBootPhase("chunk");
  };

  // 只从 chunk 往前走：已经超时撤掉的遮罩不能被它叫回来。
  const handleChunkArrived = useCallback(
    () => setBootPhase((phase) => (phase === "chunk" ? "assets" : phase)),
    [],
  );

  const handleEditorReady = useCallback(() => setBootPhase(null), []);

  const handleOpenChange = useCallback((open: boolean) => {
    setEditorOpen(open);
    // 加载途中关掉（Esc）就一起撤；少了这一步，遮罩会盖着一个已经不存在的编辑器。
    if (!open) setBootPhase(null);
  }, []);

  // 硬上限只看「在不在盖」，不看阶段：chunk → assets 那一下不该把计时重新开始。
  // 也故意不依赖 `t`：切一次语言不该把 20 秒重新计起。
  useEffect(() => {
    if (!booting) return undefined;
    const timer = window.setTimeout(() => {
      setBootPhase(null);
      toast.warning(t("previz.boot.slow"));
    }, PREVIZ_BOOT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [booting]);

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

  /**
   * 「存不下」这句话只说一次。自动保存把 `handleFlush` 变成了「用户每停手一次就来
   * 一发」，而超限是个粘性状态：一旦超了，之后每一发都会失败。不加这道闸，用户每动
   * 一下就吃一条错误 toast，堆起来糊满屏幕、还挡住工具栏——而他要做的（删掉几个对象）
   * 恰恰得看得见界面才做得了。
   *
   * 放在节点而不是编辑器里：闸只有和「这次到底存没存下」贴在一起才关得准，而只有这里
   * 知道 `buildNodeScenePatch` 的结论。放这儿还顺带跨了编辑器的开关——关掉再打开不会
   * 重新弹一遍同一句话，用户第一次就已经读到了。存成功一次就复位，下次再撑爆会重新提醒；
   * 少了这一步，用户瘦身成功之后再撑爆，这个节点从此再也不吭声，界面看着一切正常、
   * 实际什么都没存。
   */
  const complainedTooLarge = useRef(false);

  /**
   * 返回值是给编辑器看的：`false` = 这一份没存下。少了它编辑器会把拒收记成保存成功，
   * 把场景标成干净，此后每一次自动保存都在空转——而这道 toast 闸保证它不会再吭声。
   */
  const handleFlush = useCallback(
    (scene: PrevizScene) => {
      const result = buildNodeScenePatch(scene);
      if (!result.ok) {
        // 超限载荷一旦进整画布 PUT，canvasSync 收到 413 会永久停掉自动保存。
        if (!complainedTooLarge.current) {
          complainedTooLarge.current = true;
          toast.error(t("previz.editor.sceneTooLarge"));
        }
        return false;
      }
      complainedTooLarge.current = false;
      updateNodeData(id, result.patch);
      return true;
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
              openEditor();
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
          <EditorChunkArrived onArrive={handleChunkArrived} />
          <PrevizEditor
            open={isEditorOpen}
            nodeId={id}
            initialScene={initialScene}
            onOpenChange={handleOpenChange}
            onFlush={handleFlush}
            onReady={handleEditorReady}
          />
        </Suspense>
      )}

      {/* 放在 Suspense 外面：同一个实例横跨「代码块下载」与「等模型」两段，淡出才连得上。 */}
      <PrevizBootOverlay phase={bootPhase} />
    </div>
  );
});

PrevizNode.displayName = "PrevizNode";
