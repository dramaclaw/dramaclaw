// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, X } from "lucide-react";
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
import { monitorViewportRect } from "./engine/cameraRig";
import type { GizmoMode } from "./engine/gizmo";
import {
  cameraDraftOverrides,
  type PrevizCameraDraft,
  type PrevizCameraPlacement,
} from "./domain/cameraDraft";
import { canAddObject } from "./domain/limits";
import { uploadPrevizProp } from "./propAsset";
import { usePrevizStore } from "./store";
import { PrevizCameraCreateDialog } from "./ui/PrevizCameraCreateDialog";
import { PrevizClipInspector } from "./ui/PrevizClipInspector";
import { PrevizInspector } from "./ui/PrevizInspector";
import { PrevizLayerPanel } from "./ui/PrevizLayerPanel";
import { PrevizTimeline } from "./ui/PrevizTimeline";
import { PrevizToolbar } from "./ui/PrevizToolbar";
import { PrevizViewportHud } from "./ui/PrevizViewportHud";
import type { PrevizTool } from "./ui/PrevizViewportHud";
import type { PrevizObjectKind, PrevizScene, Vec3 } from "./domain/scene";
import { PREVIZ_DEFAULT_VIEW } from "./domain/view";

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

/** 监看画中画右上角那个「隐藏」按钮的边长与内缩，单位 CSS 像素。 */
const MONITOR_HIDE_SIZE = 20;
const MONITOR_HIDE_INSET = 6;

/**
 * 把后续的指针事件锁在画布上，这样一笔画到视口外面也不会中途断掉。
 *
 * 包一层 try：`setPointerCapture` 对一个已经不活跃的 pointerId 会抛 NotFoundError
 * （鼠标在别处松开、笔离开数位板都能造出这种时序），而捕获失败只是「画出视口那段丢了」，
 * 不该把整笔轨迹连同后面的 pointerup 一起吞掉。
 */
function capturePointer(event: PointerEvent<HTMLCanvasElement>): void {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // 见上：捕获不上就退化成不捕获。
  }
}

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
  // 监看画中画是画在 WebGL 里的，右下角那个「隐藏」按钮却是普通 DOM。要让按钮
  // 正好压在画中画的角上，React 这边得跟着量一份画布尺寸——两边都走
  // `monitorViewportRect`，位置才不会各算各的。
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  // 渲染器也进 state 而不是 ref：面板的回调要在它就绪后重新绑定，ref 变化不会触发重渲染。
  const [renderer, setRenderer] = useState<PrevizRenderer | null>(null);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>("translate");
  const [tool, setTool] = useState<PrevizTool>("select");
  /** 正在画的那一笔，世界坐标。null 表示画笔没按下。 */
  const stroke = useRef<Vec3[] | null>(null);
  const [capturing, setCapturing] = useState(false);
  /**
   * 机位创建对话框打开时，锁着的那一份导演视角。存下来而不是每帧现取：对话框开着时
   * 视口仍能被轨道拖动（预览渲染本身就会重画视口），现取的话用户拖一下取景就飘了。
   */
  const [cameraPose, setCameraPose] = useState<PrevizCameraPlacement | null>(null);
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
  const pathSpacingM = usePrevizStore((state) => state.pathSpacingM);
  const setPathSpacing = usePrevizStore((state) => state.setPathSpacing);
  const timelineFrame = usePrevizStore((state) => state.timelineFrame);
  const timelinePlaying = usePrevizStore((state) => state.timelinePlaying);
  const selectedClipId = usePrevizStore((state) => state.selectedClipId);
  const addDerivedUploadNode = useCanvasStore((state) => state.addDerivedUploadNode);
  const addEdge = useCanvasStore((state) => state.addEdge);

  const selectedObject = useMemo(
    () => scene.objects.find((object) => object.id === selectedObjectId) ?? null,
    [scene.objects, selectedObjectId],
  );

  // 关掉监看时记住关的是哪一台：右下角那个开关重新打开的必须是同一台机位，
  // 否则机位不止一台的场景里「关掉再打开」会顺手换成第一台。
  const lastMonitoredCameraId = useRef<string | null>(null);
  if (activeCameraId) lastMonitoredCameraId.current = activeCameraId;
  // 这里不套 useMemo：它读的是一个 ref，而 ref 变了不会让 memo 失效，缓存下来的
  // 会一直是首帧那台（那时还没人监看过，也就是第一台）。逐帧过一遍几个对象而已。
  const restorableCameraId = (() => {
    const cameras = scene.objects.filter((object) => object.kind === "camera");
    // 记下的那台可能已经被删了，这时退回第一台；一台都没有就没什么可开的。
    return (
      cameras.find((camera) => camera.id === lastMonitoredCameraId.current)?.id ??
      cameras[0]?.id ??
      null
    );
  })();

  const monitorRect = useMemo(
    () => monitorViewportRect(canvasSize.width, canvasSize.height, scene.settings.outputAspect),
    [canvasSize.width, canvasSize.height, scene.settings.outputAspect],
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

    const measure = () => {
      setCanvasSize({ width: canvas.clientWidth, height: canvas.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(() => {
      instance?.resize();
      measure();
    });
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

  useEffect(() => {
    renderer?.setFrame(timelineFrame);
  }, [renderer, timelineFrame]);

  useEffect(() => {
    renderer?.setSelectedClip(selectedClipId);
  }, [renderer, selectedClipId]);

  /**
   * 播放循环。跑在编辑器里而不是 store 里：store 是纯状态，不该握着 rAF 句柄，
   * 那样一个没卸载干净的循环会跨编辑器实例继续推播放头。
   */
  useEffect(() => {
    if (!open || !timelinePlaying) return undefined;
    let handle = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // 用真实耗时而不是「每帧推一帧」：显示器是 120Hz 时后者会双倍速播放。
      const delta = (now - last) / 1000;
      last = now;
      usePrevizStore.getState().tickPlayback(delta);
      handle = window.requestAnimationFrame(tick);
    };
    handle = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(handle);
  }, [open, timelinePlaying]);

  // 关掉编辑器时把播放停下来：循环虽然随 effect 一起卸了，但 `timelinePlaying`
  // 还留在 true 上，下次打开会从半路自动播起来。
  useEffect(() => {
    if (!open) usePrevizStore.getState().setTimelinePlaying(false);
  }, [open]);

  const handleAdd = useCallback(
    (kind: PrevizObjectKind) => {
      // 机位不直接建：先开创建对话框，让用户定焦距、画幅与朝向。上限在开框前就查，
      // 不然填完一屏参数再告诉人家建不了。
      if (kind === "camera") {
        if (!canAddObject(usePrevizStore.getState().scene, "camera")) {
          toast.error(t("previz.editor.limitReached"));
          return;
        }
        setCameraPose(renderer?.viewPose() ?? PREVIZ_DEFAULT_VIEW);
        return;
      }
      const id = addObject(kind);
      if (!id) toast.error(t("previz.editor.limitReached"));
    },
    [addObject, renderer, t],
  );

  const handleCreateCamera = useCallback(
    (draft: PrevizCameraDraft) => {
      setCameraPose(null);
      const id = addObject("camera", cameraDraftOverrides(draft));
      if (!id) {
        toast.error(t("previz.editor.limitReached"));
        return;
      }
      // 建完把监看切过去：用户刚定完这台的取景，右下角还盯着上一台没有道理。
      setActiveCamera(id);
    },
    [addObject, setActiveCamera, t],
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
        case " ":
          // 空格是播放/暂停。上面已经挡掉了输入框里的按键，这里不会抢走打字的空格。
          event.preventDefault();
          store.setTimelinePlaying(!store.timelinePlaying);
          break;
        case "arrowright":
          store.setTimelineFrame(store.timelineFrame + 1);
          break;
        case "arrowleft":
          store.setTimelineFrame(store.timelineFrame - 1);
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
        <div className="absolute inset-0 flex flex-col bg-[#101216]">
          <div className="flex min-h-0 flex-1">
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
                if (tool !== "draw" || !renderer) return;
                // 画笔按下这一下不能同时走拾取，否则一笔画完选中的对象已经换人了。
                pointerDownAt.current = null;
                capturePointer(event);
                const point = renderer.groundPointAt(event.clientX, event.clientY);
                stroke.current = point ? [point] : [];
              }}
              onPointerMove={(event) => {
                if (!stroke.current || !renderer) return;
                const point = renderer.groundPointAt(event.clientX, event.clientY);
                // 射线与地面平行时 groundPointAt 交出 null，这一段笔画直接丢掉：
                // 补一个瞎编的点会在轨迹上留下一个乱跳的顶点。
                if (point) stroke.current.push(point);
              }}
              onPointerUp={(event) => {
                if (stroke.current) {
                  const points = stroke.current;
                  stroke.current = null;
                  const targetId = usePrevizStore.getState().selectedObjectId;
                  // 没选对象时这一笔没有归属，直接丢——建一条无主轨迹只会在时间轴上
                  // 多一行删不掉的东西。
                  if (targetId) usePrevizStore.getState().drawPath(targetId, points);
                  // 画完自动切回选择：实测参照实现就是这样，否则下一次想选个对象
                  // 反而又画了一条。
                  setTool("select");
                  return;
                }

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
              tool={tool}
              pathSpacingM={pathSpacingM}
              onTool={setTool}
              onPathSpacing={setPathSpacing}
            />

            {activeCameraId && (
              /*
                贴在监看画中画的右上角内侧。位置用的是渲染器同一个 `monitorViewportRect`：
                自己按 26% 加 padding 拼一遍 CSS 也能对上大多数情况，但竖幅画幅在矮画布上
                会走那条「改按高度回推宽度」的分支，两套算法立刻错开，按钮飘到画面外。
                `bottom` 而不是 `top`：那个 rect 是 WebGL 视口坐标，y 从底边量起。
              */
              <button
                type="button"
                data-testid="previz-monitor-hide"
                aria-label={t("previz.editor.hideMonitor")}
                title={t("previz.editor.hideMonitor")}
                onClick={() => setActiveCamera(null)}
                style={{
                  left: monitorRect.x + monitorRect.width - MONITOR_HIDE_SIZE - MONITOR_HIDE_INSET,
                  bottom: monitorRect.y + monitorRect.height - MONITOR_HIDE_SIZE - MONITOR_HIDE_INSET,
                  width: MONITOR_HIDE_SIZE,
                  height: MONITOR_HIDE_SIZE,
                }}
                className="absolute grid place-items-center rounded bg-black/55 text-white/70 transition hover:bg-black/80 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
              >
                <X className="h-3 w-3" />
              </button>
            )}

            {!activeCameraId && restorableCameraId && (
              /*
                监看关掉之后留在原地的开关。没有画中画可以贴，就贴画布自己的右下角。
                和上面那个叉是同一个位置量级，于是「关」和「开」在视觉上是同一颗按钮。
              */
              <button
                type="button"
                data-testid="previz-monitor-show"
                aria-label={t("previz.editor.showMonitor")}
                title={t("previz.editor.showMonitor")}
                onClick={() => setActiveCamera(restorableCameraId)}
                className="absolute right-4 bottom-4 grid h-7 w-7 place-items-center rounded bg-black/55 text-white/70 transition hover:bg-black/80 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
              >
                <Monitor className="h-3.5 w-3.5" />
              </button>
            )}

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

            {/*
              铺在视口上而不是再套一层 base-ui Dialog：编辑器本身已经是个全屏 Dialog，
              嵌套 Dialog 会把焦点陷阱和 Esc 各自劫持一遍，Esc 一按连编辑器一起关掉。
            */}
            <PrevizCameraCreateDialog
              open={Boolean(cameraPose)}
              viewPose={cameraPose ?? PREVIZ_DEFAULT_VIEW}
              outputAspect={scene.settings.outputAspect}
              onRenderPreview={(previewCanvas, draft) => {
                renderer?.renderCameraPreview(previewCanvas, draft);
              }}
              onCreate={handleCreateCamera}
              onClose={() => setCameraPose(null)}
            />
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

          <div className="flex shrink-0 flex-col overflow-y-auto">
            <PrevizInspector
              object={selectedObject}
              onChange={(patch) => {
                if (selectedObjectId) updateObject(selectedObjectId, patch);
              }}
            />
            <PrevizClipInspector />
          </div>
          </div>

          <PrevizTimeline onCreateObject={handleAdd} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default PrevizEditor;
