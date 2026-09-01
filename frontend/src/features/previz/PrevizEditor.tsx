// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useViewerImmersiveBody } from "@/features/viewer-kit/useViewerImmersiveBody";
import { readUrl } from "@/lib/url-params";
import { useCanvasStore } from "@/stores/canvasStore";
import { uploadFreezoneImage } from "@/api/ops";

import { publishCapture } from "./capture/publishCapture";
import { PrevizRenderer } from "./engine/PrevizRenderer";
import type { GizmoMode } from "./engine/gizmo";
import { canAddObject } from "./domain/limits";
import { uploadPrevizProp } from "./propAsset";
import { usePrevizStore } from "./store";
import { PrevizInspector } from "./ui/PrevizInspector";
import { PrevizLayerPanel } from "./ui/PrevizLayerPanel";
import { PrevizToolbar } from "./ui/PrevizToolbar";
import { PrevizViewportHud } from "./ui/PrevizViewportHud";
import type { PrevizObjectKind, PrevizScene } from "./domain/scene";

interface PrevizEditorProps {
  open: boolean;
  /** 预演台节点自己的 id；截图要挂在它右边。 */
  nodeId: string;
  initialScene: PrevizScene;
  onOpenChange: (open: boolean) => void;
  /** 关闭时把当前场景交回节点落盘；编辑期不逐帧写 node.data。 */
  onFlush: (scene: PrevizScene) => void;
}

/** 按下与抬起之间超过这个像素就算在转视角，不是在点选。 */
const CLICK_SLOP_PX = 4;

export function PrevizEditor({
  open,
  nodeId,
  initialScene,
  onOpenChange,
  onFlush,
}: PrevizEditorProps) {
  const { t } = useTranslation();
  // 不能用 useRef：base-ui 的 Dialog.Portal 靠 store 里的 `mounted` 决定是否渲染子树，
  // 而 `mounted` 是在 open 生效之后的一次提交里才置上的，所以本组件第一次跑 effect 时
  // 弹窗内容还没进 DOM、ref 还是 null；effect 只依赖 [open]，之后再也不会重跑，
  // 渲染器就永远建不起来。改成把 canvas 存进 state：元素真正挂上时触发一次重渲染，
  // effect 这才拿得到它。
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  // 渲染器也进 state 而不是 ref：面板的回调要在它就绪后重新绑定，ref 变化不会触发重渲染。
  const [renderer, setRenderer] = useState<PrevizRenderer | null>(null);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>("translate");
  const [capturing, setCapturing] = useState(false);
  const pointerDownAt = useRef<{ x: number; y: number } | null>(null);

  const scene = usePrevizStore((state) => state.scene);
  const selectedObjectId = usePrevizStore((state) => state.selectedObjectId);
  const activeCameraId = usePrevizStore((state) => state.activeCameraId);
  const canUndo = usePrevizStore((state) => state.past.length > 0);
  const canRedo = usePrevizStore((state) => state.future.length > 0);
  const loadScene = usePrevizStore((state) => state.loadScene);
  const addObject = usePrevizStore((state) => state.addObject);
  const updateObject = usePrevizStore((state) => state.updateObject);
  const removeObject = usePrevizStore((state) => state.removeObject);
  const selectObject = usePrevizStore((state) => state.selectObject);
  const setActiveCamera = usePrevizStore((state) => state.setActiveCamera);
  const setDisplayMode = usePrevizStore((state) => state.setDisplayMode);
  const setOutputAspect = usePrevizStore((state) => state.setOutputAspect);
  const undo = usePrevizStore((state) => state.undo);
  const redo = usePrevizStore((state) => state.redo);
  const addDerivedUploadNode = useCanvasStore((state) => state.addDerivedUploadNode);
  const addEdge = useCanvasStore((state) => state.addEdge);

  const selectedObject = useMemo(
    () => scene.objects.find((object) => object.id === selectedObjectId) ?? null,
    [scene.objects, selectedObjectId],
  );

  const canAdd = useMemo(
    () => ({
      character: canAddObject(scene, "character"),
      camera: canAddObject(scene, "camera"),
      light: canAddObject(scene, "light"),
      prop: canAddObject(scene, "prop"),
    }),
    [scene],
  );

  // 全屏时独占键盘，让画布的 Delete / 复制粘贴快捷键让位。
  useViewerImmersiveBody(open);

  useEffect(() => {
    if (!open) return;
    loadScene(initialScene);
  }, [open, initialScene, loadScene]);

  useEffect(() => {
    if (!open || !canvas) return undefined;

    let instance: PrevizRenderer | null = null;
    let cancelled = false;

    void PrevizRenderer.create(canvas).then((created) => {
      // create() 是异步的，弹窗可能在 three chunk 落地前就关了。
      if (cancelled) {
        created.dispose();
        return;
      }
      // 这里不用再调 resize()：`create()` 内部已经在 `start()` 之前调过一次。
      // 下面 ResizeObserver 首次 observe 时也会立刻回调一次，但那一次很可能早于
      // create() 落地、`instance` 还是 null——首帧尺寸正确靠的是 create() 内部那次。
      instance = created;
      setRenderer(created);
    });

    const observer = new ResizeObserver(() => instance?.resize());
    observer.observe(canvas);

    return () => {
      cancelled = true;
      observer.disconnect();
      instance?.dispose();
      setRenderer(null);
    };
  }, [open, canvas]);

  // 场景先灌、选中后设：反过来的话手柄要挂的那个节点还没建出来，第一次选中会挂空。
  useEffect(() => {
    renderer?.setScene(scene);
  }, [renderer, scene]);

  useEffect(() => {
    renderer?.setSelection(selectedObjectId);
  }, [renderer, selectedObjectId]);

  useEffect(() => {
    renderer?.setActiveCamera(activeCameraId);
  }, [renderer, activeCameraId]);

  useEffect(() => {
    renderer?.setGizmoMode(gizmoMode);
  }, [renderer, gizmoMode]);

  useEffect(() => {
    if (!renderer) return undefined;
    // 走 getState() 而不是闭包里的 updateObject：拖手柄期间 scene 每次提交都在变，
    // 依赖它会让这个 effect 反复解绑重绑，正好卡在拖拽中间。
    renderer.onTransformCommit = (objectId, transform) => {
      usePrevizStore.getState().updateObject(objectId, { transform });
    };
    return () => {
      renderer.onTransformCommit = null;
    };
  }, [renderer]);

  const handleAdd = useCallback(
    (kind: PrevizObjectKind) => {
      const id = addObject(kind);
      if (!id) toast.error(t("previz.editor.limitReached"));
    },
    [addObject, t],
  );

  const handleImportProp = useCallback(
    async (file: File) => {
      const project = readUrl().project;
      if (!project) {
        toast.error(t("previz.editor.noProject"));
        return;
      }
      const result = await uploadPrevizProp(project, file);
      if (!result.ok) {
        toast.error(
          t(
            result.reason === "format"
              ? "previz.editor.propUpload.format"
              : result.reason === "too-large"
                ? "previz.editor.propUpload.tooLarge"
                : "previz.editor.propUpload.failed",
          ),
        );
        return;
      }
      const id = addObject("prop", {
        name: result.name,
        assetUrl: result.assetUrl,
        assetFormat: result.assetFormat,
      });
      if (!id) toast.error(t("previz.editor.limitReached"));
    },
    [addObject, t],
  );

  const handleCapture = useCallback(async () => {
    if (!renderer || capturing) return;
    const project = readUrl().project;
    if (!project) {
      toast.error(t("previz.editor.noProject"));
      return;
    }
    setCapturing(true);
    try {
      const blob = await renderer.capture();
      if (!blob) return;
      const result = await publishCapture({
        project,
        sourceNodeId: nodeId,
        aspect: usePrevizStore.getState().scene.settings.outputAspect,
        blob,
        uploadImage: (targetProject, file, filename) =>
          uploadFreezoneImage(targetProject, file, filename),
        addDerivedUploadNode,
        addEdge,
      });
      if (result.ok) toast.success(t("previz.editor.captureDone"));
      else if (result.reason === "node") toast.error(t("previz.editor.captureNoNode"));
      else toast.error(t("previz.editor.captureFailed"));
    } finally {
      setCapturing(false);
    }
  }, [addDerivedUploadNode, addEdge, capturing, nodeId, renderer, t]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onFlush(usePrevizStore.getState().scene);
      onOpenChange(next);
    },
    [onFlush, onOpenChange],
  );

  useEffect(() => {
    if (!open || !renderer) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // 焦点在输入框里时 F 是在打字，不是快捷键。
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      const store = usePrevizStore.getState();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key.toLowerCase()) {
        case "f":
          if (store.selectedObjectId) renderer.focusObject(store.selectedObjectId);
          break;
        case "h":
          renderer.resetView();
          break;
        case "w":
          setGizmoMode("translate");
          break;
        case "e":
          setGizmoMode("rotate");
          break;
        case "r":
          setGizmoMode("scale");
          break;
        case "delete":
        case "backspace":
          if (store.selectedObjectId) store.removeObject(store.selectedObjectId);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, renderer]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="inset-0 left-0 top-0 h-dvh w-dvw max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 p-0 ring-0 sm:max-w-none"
        overlayClassName="bg-black/55 supports-backdrop-filter:backdrop-blur-none"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("previz.editor.title")}</DialogTitle>
          <DialogDescription>{t("previz.editor.description")}</DialogDescription>
        </DialogHeader>

        {/*
          absolute inset-0 而不是 h-full w-full：DialogContent 的基础类是 `grid gap-4`，
          行高是 auto。`h-full` 在 auto 行里是循环百分比，浏览器改用内容高度回落，而
          canvas 的内容高度就是它 width/height 属性给的固有尺寸——ResizeObserver 把
          量到的高写回属性，属性又撑高行，行再撑高 canvas，每次窗口缩放都把画布越滚
          越大（实测 960 → 1785），相机 aspect 也跟着偏离可见区域。绝对定位让它彻底
          退出网格流，尺寸只认 DialogContent 的 h-dvh。
        */}
        <div className="absolute inset-0 flex bg-[#101216]">
          <PrevizToolbar
            canAdd={canAdd}
            canUndo={canUndo}
            canRedo={canRedo}
            onAdd={handleAdd}
            onImportProp={(file) => void handleImportProp(file)}
            onUndo={undo}
            onRedo={redo}
          />

          <div className="relative min-w-0 flex-1">
            <canvas
              ref={setCanvas}
              data-testid="previz-canvas"
              className="block h-full w-full"
              onPointerDown={(event) => {
                pointerDownAt.current = { x: event.clientX, y: event.clientY };
              }}
              onPointerUp={(event) => {
                const down = pointerDownAt.current;
                pointerDownAt.current = null;
                if (!renderer || !down) return;
                // 轨道拖拽也会经过 pointerdown/up；位移超过阈值就是在转视角。
                if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_SLOP_PX) {
                  return;
                }
                selectObject(renderer.pickAt(event.clientX, event.clientY));
              }}
            />

            <PrevizViewportHud
              displayMode={scene.settings.displayMode}
              outputAspect={scene.settings.outputAspect}
              gizmoMode={gizmoMode}
              hasSelection={Boolean(selectedObjectId)}
              onDisplayMode={setDisplayMode}
              onOutputAspect={setOutputAspect}
              onGizmoMode={setGizmoMode}
              onViewDirection={(direction) => renderer?.applyViewDirection(direction)}
              onFocus={() => {
                if (selectedObjectId) renderer?.focusObject(selectedObjectId);
              }}
              onResetView={() => renderer?.resetView()}
            />

            <div className="pointer-events-none absolute bottom-4 left-4 rounded-lg bg-black/45 px-3 py-1.5 text-xs text-white/80">
              {t("previz.editor.duration", { frames: scene.settings.durationFrames })}
            </div>

            <Button
              variant="ghost"
              aria-label={t("previz.editor.capture")}
              disabled={capturing}
              className="absolute right-16 top-4 z-10 h-8 rounded-lg bg-white/10 px-3 text-[12px] text-white/85 hover:bg-white/20"
              onClick={() => void handleCapture()}
            >
              {capturing ? t("previz.editor.capturing") : t("previz.editor.capture")}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              aria-label={t("previz.editor.close")}
              className="absolute right-4 top-4 z-10 text-white/80 hover:text-white"
              onClick={() => handleOpenChange(false)}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>

          <PrevizLayerPanel
            objects={scene.objects}
            selectedId={selectedObjectId}
            activeCameraId={activeCameraId}
            onSelect={selectObject}
            onToggleVisible={(id) => {
              const object = scene.objects.find((entry) => entry.id === id);
              if (object) updateObject(id, { visible: !object.visible });
            }}
            onToggleLocked={(id) => {
              const object = scene.objects.find((entry) => entry.id === id);
              if (object) updateObject(id, { locked: !object.locked });
            }}
            onRemove={removeObject}
            onSetActiveCamera={setActiveCamera}
          />

          <PrevizInspector
            object={selectedObject}
            onChange={(patch) => {
              if (selectedObjectId) updateObject(selectedObjectId, patch);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default PrevizEditor;
