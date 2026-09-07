// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, Circle, Monitor, Square, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useViewerImmersiveBody } from "@/features/viewer-kit/useViewerImmersiveBody";
import { readUrl } from "@/lib/url-params";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/stores/canvasStore";
import { uploadFreezoneImage, uploadFreezoneVideo } from "@/api/ops";

import { publishCapture } from "./capture/publishCapture";
import { publishRecording } from "./capture/publishRecording";
import { resolveRecordTarget, type PrevizRecordMode } from "./capture/recordTarget";
import {
  PREVIZ_RECORD_FPS,
  createCanvasRecorder,
  pickRecordMimeType,
  recordFilename,
  recordQualityLabel,
  recordTimeline,
} from "./capture/recordTimeline";
import { PrevizRenderer } from "./engine/PrevizRenderer";
import type { CameraPreviewCanvas } from "./engine/cameraPreview";
import { monitorViewportRect, type MonitorSize } from "./engine/cameraRig";
import type { GizmoMode } from "./engine/gizmo";
import {
  cameraDraftOverrides,
  type PrevizCameraDraft,
  type PrevizCameraPlacement,
} from "./domain/cameraDraft";
import { canAddObject } from "./domain/limits";
import { drawPlaneHeight } from "./domain/pathDraw";
import { uploadPrevizProp } from "./propAsset";
import { usePrevizStore } from "./store";
import { PrevizCameraCreateDialog } from "./ui/PrevizCameraCreateDialog";
import { PrevizClipInspector } from "./ui/PrevizClipInspector";
import { PrevizInspector } from "./ui/PrevizInspector";
import { PrevizLayerPanel } from "./ui/PrevizLayerPanel";
import { PrevizMonitorFrame } from "./ui/PrevizMonitorFrame";
import { PrevizQuadPreview } from "./ui/PrevizQuadPreview";
import { PrevizTimeline } from "./ui/PrevizTimeline";
import { PrevizToolbar } from "./ui/PrevizToolbar";
import type { PrevizTool } from "./ui/PrevizToolbar";
import { PrevizHoverTip } from "./ui/PrevizHoverTip";
import { PrevizViewportControls } from "./ui/PrevizViewportControls";
import type { PrevizViewSource } from "./ui/PrevizAxisGizmo";
import type { PrevizAxisView } from "./domain/axisGizmo";
import type { PrevizObjectKind, PrevizScene, Vec3 } from "./domain/scene";
import { PREVIZ_DEFAULT_VIEW, type PrevizViewDirection } from "./domain/view";

interface PrevizEditorProps {
  open: boolean;
  /** 预演台节点自己的 id；截图要挂在它右边。 */
  nodeId: string;
  initialScene: PrevizScene;
  onOpenChange: (open: boolean) => void;
  /** 关闭时把当前场景交回节点落盘；编辑期不逐帧写 node.data。 */
  onFlush: (scene: PrevizScene) => void;
}

/** 录制选单里的两项，顺序就是屏幕上的顺序。 */
const RECORD_MODES: readonly PrevizRecordMode[] = ["global", "track"];

/** 按下与抬起之间超过这个像素就算在转视角，不是在点选。 */
const CLICK_SLOP_PX = 4;

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
  /**
   * 监看的三个开关。放在编辑器本地而不是场景设置里：它们只改「怎么看」，一个像素都不
   * 进出片，跟 `gizmoMode` / `tool` 是同一类东西。落进 `settings` 的话，切一次描边会
   * 进撤销栈、还会把节点数据标脏——用户会莫名其妙地被问「要不要保存」。
   */
  const [monitorSize, setMonitorSize] = useState<MonitorSize>("normal");
  const [showOutline, setShowOutline] = useState(true);
  const [showNamePlate, setShowNamePlate] = useState(true);
  const [tool, setTool] = useState<PrevizTool>("select");
  /** 正在画的那一笔，世界坐标。null 表示画笔没按下。 */
  const stroke = useRef<Vec3[] | null>(null);
  /**
   * 这一笔投在多高的水平面上，按下的那一刻定死。
   *
   * 每次 move 现算的话，笔画会在自己造成的移动上滑坡：画到一半 store 里的轨迹还没更新
   * 倒是不会，但重画已有轨迹时播放头一动高度就变，同一笔的前后段落在两个平面上。
   */
  const strokeHeight = useRef(0);
  /**
   * 正在逐点打的那条轨迹：给哪个对象打、落进了哪条片段、点投在多高的平面上。null 表示
   * 还没打第一个点。
   *
   * 片段 id 记在这里而不是每次按播放头找：片段随着点越打越长、播放头却停在原地，很快就
   * 落到片段外面，那时按播放头找会另起一条，把一次打点拆成两条轨迹。高度同 `strokeHeight`
   * 的道理，打第一个点时定死——第一个点一落，对象就被轨迹牵到了新位置，第二个点要是按
   * 当时的高度取平面，两个点就落在两个平面上。
   */
  const marking = useRef<{ objectId: string; clipId: string | null; height: number } | null>(
    null,
  );
  const [capturing, setCapturing] = useState(false);
  /**
   * 右侧那两块面板（图层 + 属性）是否展开。收起来的是整条侧栏而不是各收各的：
   * 这两块上下相接、共用一条左边框，单收一块会在接缝处留下半截悬空的边。
   * 视口是 flex-1，侧栏一收它就自己长满——canvas 的尺寸由 ResizeObserver 跟。
   */
  const [panelsOpen, setPanelsOpen] = useState(true);
  /**
   * 底下那条轨迹面板是否展开。摆位阶段（搭景、调机位）用不上时间轴，收起来能把视口
   * 还给画面；开关钉在左栏最下面，紧挨着它收起的那块面板。
   */
  const [timelineOpen, setTimelineOpen] = useState(true);
  /**
   * 四视图：右侧那两块正交预览开着没有。默认关——它要占掉一列视口宽度，而摆场景的
   * 大部分时间只看透视那一块。
   */
  const [quadView, setQuadView] = useState(false);
  /** 录制模式选单开着没有。只在没录的时候能开。 */
  const [recordMenuOpen, setRecordMenuOpen] = useState(false);
  /** 正在录的那一路；null 就是没在录。 */
  const [recording, setRecording] = useState<PrevizRecordMode | null>(null);
  /** 录制进度 0..1，只喂按钮上的读数。 */
  const [recordProgress, setRecordProgress] = useState(0);
  /**
   * 用户点了停止。ref 而不是 state：录制循环是在闭包里跑的，读 state 读到的永远是
   * 开录那一刻的 false。
   */
  const recordStopped = useRef(false);
  /** 录完之后的上传与建节点阶段。与 `recording` 分开：按钮上写的字不一样。 */
  const [recordPublishing, setRecordPublishing] = useState(false);
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
  const pathSpeedMps = usePrevizStore((state) => state.pathSpeedMps);
  const setPathSpeed = usePrevizStore((state) => state.setPathSpeed);
  const timelineFrame = usePrevizStore((state) => state.timelineFrame);
  const timelinePlaying = usePrevizStore((state) => state.timelinePlaying);
  const selectedClipId = usePrevizStore((state) => state.selectedClipId);
  const selectedPointId = usePrevizStore((state) => state.selectedPointId);
  const addDerivedUploadNode = useCanvasStore((state) => state.addDerivedUploadNode);
  const addDerivedVideoNode = useCanvasStore((state) => state.addDerivedVideoNode);
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
    () =>
      monitorViewportRect(
        canvasSize.width,
        canvasSize.height,
        scene.settings.outputAspect,
        monitorSize,
      ),
    [canvasSize.width, canvasSize.height, scene.settings.outputAspect, monitorSize],
  );

  /** 监看字幕要读机位自己的焦距与传感器，所以取的是对象而不只是 id。 */
  const monitoredCamera = useMemo(() => {
    const object = scene.objects.find((entry) => entry.id === activeCameraId);
    return object?.kind === "camera" ? object : null;
  }, [scene.objects, activeCameraId]);

  /**
   * 坐标轴小球读的视角。存在 ref 里、由订阅推给那一颗组件，而不是做成 state：轨道
   * 拖拽期间相机每帧都在变，做成 state 就是每帧把整棵编辑器（时间轴、监看边框、检视
   * 面板）重渲一遍，为的只是让左上角一颗 72px 的小球跟手。
   */
  const viewStore = useRef({
    pose: PREVIZ_DEFAULT_VIEW as PrevizAxisView,
    listeners: new Set<() => void>(),
  });
  const viewSource = useMemo<PrevizViewSource>(
    () => ({
      subscribe: (listener) => {
        viewStore.current.listeners.add(listener);
        return () => {
          viewStore.current.listeners.delete(listener);
        };
      },
      // 必须交回同一个引用：每次新建一个字面量的话 useSyncExternalStore 会认为值一直
      // 在变，当场无限重渲。
      snapshot: () => viewStore.current.pose,
    }),
    [],
  );

  /**
   * 拖手柄期间「东西在动」的订阅者，眼下只有右侧那两块正交预览。
   *
   * 和上面的视角小球同一个理由走订阅而不是 state：这条信号跟着鼠标采样率来，做成
   * state 就是每动一下把整棵编辑器重渲一遍。这里连值都不用带——收到通知的人自己去
   * 重画，渲染器那边的场景已经是新的了。
   */
  const dragListeners = useRef(new Set<() => void>());
  const subscribeDrag = useCallback((listener: () => void) => {
    dragListeners.current.add(listener);
    return () => {
      dragListeners.current.delete(listener);
    };
  }, []);

  /**
   * 四视图里机位那一格看的是哪台机位：优先右下角监看的那台，没设监看就用场景里的第一台。
   *
   * 不跟监看绑死：那一格答的是「镜头里是什么样」，而建完机位的下一件事就是想看它拍到
   * 什么。要求先去图层面板设一次监看才肯出画，等于让用户对着一格黑画面猜自己漏了哪步。
   */
  const quadCamera = useMemo(() => {
    const cameras = scene.objects.filter((object) => object.kind === "camera");
    return cameras.find((object) => object.id === activeCameraId) ?? cameras[0];
  }, [scene.objects, activeCameraId]);
  const quadCameraId = quadCamera?.id ?? null;

  const canAdd = useMemo(
    () => ({
      character: canAddObject(scene, "character"),
      camera: canAddObject(scene, "camera"),
      light: canAddObject(scene, "light"),
      prop: canAddObject(scene, "prop"),
    }),
    [scene],
  );

  // 同一颗把手既收也展，名字跟着当前状态换。
  const panelsLabel = t(panelsOpen ? "previz.editor.collapsePanels" : "previz.editor.expandPanels");

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
    renderer?.setViewOverlays({ outline: showOutline, namePlate: showNamePlate });
  }, [renderer, showOutline, showNamePlate]);

  useEffect(() => {
    renderer?.setMonitorSize(monitorSize);
  }, [renderer, monitorSize]);

  useEffect(() => {
    renderer?.setSelection(selectedObjectId);
  }, [renderer, selectedObjectId]);

  useEffect(() => {
    renderer?.setActiveCamera(activeCameraId);
  }, [renderer, activeCameraId]);

  useEffect(() => {
    renderer?.setGizmoMode(gizmoMode);
  }, [renderer, gizmoMode]);

  // 拿工具本身当开关，而不是在 pointerdown/up 里开关一次：中途松手在画布外、或者
  // 一笔没画完就切走工具，收尾那一下就不一定跑得到，左键会一直卡在摘掉的状态。
  useEffect(() => {
    renderer?.setDrawing(tool === "draw");
  }, [renderer, tool]);

  // 切走标记工具就是这一轮打完了；再切回来是重新起手（改播放头下的那条轨迹），不是接着
  // 上一轮往后加。
  useEffect(() => {
    if (tool !== "mark") marking.current = null;
  }, [tool]);

  useEffect(() => {
    if (!renderer) return undefined;
    // 走 getState() 而不是闭包里的 updateObject：拖手柄期间 scene 每次提交都在变，
    // 依赖它会让这个 effect 反复解绑重绑，正好卡在拖拽中间。
    renderer.onTransformCommit = (objectId, transform) => {
      usePrevizStore.getState().updateObject(objectId, { transform });
    };
    renderer.onTransformDrag = () => {
      for (const listener of dragListeners.current) listener();
    };
    return () => {
      renderer.onTransformCommit = null;
      renderer.onTransformDrag = null;
    };
  }, [renderer]);

  useEffect(() => {
    if (!renderer) return undefined;
    const publish = (pose: PrevizAxisView) => {
      viewStore.current.pose = pose;
      for (const listener of viewStore.current.listeners) listener();
    };
    // 渲染器是异步建起来的，挂上时先对一次：不然小球一直停在默认视角，直到用户第一次
    // 拖动轨道才跳到实际朝向。
    publish(renderer.viewPose());
    renderer.onViewChange = publish;
    return () => {
      renderer.onViewChange = null;
    };
  }, [renderer]);

  useEffect(() => {
    renderer?.setFrame(timelineFrame);
  }, [renderer, timelineFrame]);

  useEffect(() => {
    renderer?.setSelectedClip(selectedClipId, selectedPointId);
  }, [renderer, selectedClipId, selectedPointId]);

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

  const handleQuadPreview = useCallback(
    (previewCanvas: CameraPreviewCanvas, direction: PrevizViewDirection) => {
      renderer?.renderQuadPreview(previewCanvas, direction);
    },
    [renderer],
  );

  const handleQuadCamera = useCallback(
    (previewCanvas: CameraPreviewCanvas) => {
      if (quadCameraId) renderer?.renderCameraView(previewCanvas, quadCameraId);
    },
    [renderer, quadCameraId],
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

  const handleRecord = useCallback(
    async (mode: PrevizRecordMode) => {
      if (!renderer || recording || capturing) return;
      const project = readUrl().project;
      if (!project) {
        toast.error(t("previz.editor.noProject"));
        return;
      }

      const store = usePrevizStore.getState();
      const target = resolveRecordTarget(
        store.scene,
        mode,
        store.selectedObjectId,
        store.activeCameraId,
      );
      if (!target) {
        toast.error(t("previz.editor.record.noCamera"));
        return;
      }

      const mimeType = pickRecordMimeType();
      if (!mimeType) {
        toast.error(t("previz.editor.record.unsupported"));
        return;
      }

      const pass = renderer.startRecording(target.mode, target.cameraId);
      // 机位在解算与开录之间被删掉了；提示一句，别把导演视角录成「轨道录制」。
      if (!pass) {
        toast.error(t("previz.editor.record.noCamera"));
        return;
      }

      const aspect = store.scene.settings.outputAspect;
      const durationFrames = store.scene.settings.durationFrames;
      // 录制自己驱动播放头，不能让播放循环同时也在推：两边一起推的话帧号会跳着走。
      store.setTimelinePlaying(false);
      recordStopped.current = false;
      setRecordProgress(0);
      setRecording(mode);

      try {
        let blob: Blob;
        try {
          blob = await recordTimeline({
            durationFrames,
            fps: PREVIZ_RECORD_FPS,
            drawFrame: (frame) => {
              // 镜头轨还没接进来，全局录制先一律走导演视角。
              pass.drawFrame(frame, null);
              // 顺手把播放头推到同一帧：时间轴与视口跟着走，录制期间就是预览。
              usePrevizStore.getState().setTimelineFrame(frame);
            },
            recorder: createCanvasRecorder(pass.canvas, { fps: PREVIZ_RECORD_FPS, mimeType }),
            now: () => performance.now(),
            schedule: (callback) => {
              window.requestAnimationFrame(callback);
            },
            onProgress: setRecordProgress,
            shouldStop: () => recordStopped.current,
          });
        } finally {
          // 辅助物的可见性攥在这个句柄里，不还回去的话手柄与轨迹会一直不见。
          pass.end();
        }

        if (blob.size === 0) {
          toast.error(t("previz.editor.record.failed"));
          return;
        }

        setRecordPublishing(true);
        const quality = recordQualityLabel(aspect);
        const result = await publishRecording({
          project,
          sourceNodeId: nodeId,
          aspect,
          blob,
          filename: recordFilename(Date.now(), mimeType),
          displayName:
            target.mode === "track"
              ? t("previz.editor.record.trackNodeName", { index: target.index, quality })
              : t("previz.editor.record.globalNodeName", { quality }),
          // 先按时间轴总长估算，两个方向都不准：录满会比它长（录制在末帧后多留了一小段
          // 尾巴），提前停止又比它短。等录制回报实际画出的帧数后再换成准确值。
          durationMs: Math.round((durationFrames / PREVIZ_RECORD_FPS) * 1000),
          uploadVideo: (targetProject, file, filename) =>
            uploadFreezoneVideo(targetProject, file, filename),
          addDerivedVideoNode,
          addEdge,
        });
        if (result.ok) toast.success(t("previz.editor.record.done"));
        else if (result.reason === "node") toast.error(t("previz.editor.record.noNode"));
        else toast.error(t("previz.editor.record.uploadFailed"));
      } catch (error) {
        console.error("[previz] record failed", error);
        toast.error(t("previz.editor.record.failed"));
      } finally {
        setRecording(null);
        setRecordPublishing(false);
        setRecordProgress(0);
      }
    },
    [addDerivedVideoNode, addEdge, capturing, nodeId, recording, renderer, t],
  );

  // 编辑器关掉时把录制叫停：循环握着渲染器，弹窗一关渲染器就 dispose 了。
  useEffect(() => {
    if (!open) recordStopped.current = true;
  }, [open]);

  const handleOpenChange = useCallback(
    (next: boolean, details?: DialogPrimitive.Root.ChangeEventDetails) => {
      /*
        打点时 Esc 是「打完了」，不是「关掉预演台」：弹窗默认的 Esc 关闭得让位，不然打到
        一半一按整个编辑器没了。

        工具也在这里切回选择，而不是放进下面那个 window keydown：base-ui 的 useDismiss
        在 document 上接到 Escape、问过 onOpenChange 之后会 stopPropagation，window 上
        的监听根本收不到这一下。弹窗是唯一听得见 Esc 的地方。
      */
      if (!next && details?.reason === "escape-key" && tool === "mark") {
        details.cancel();
        setTool("select");
        return;
      }
      if (!next) onFlush(usePrevizStore.getState().scene);
      onOpenChange(next);
    },
    [onFlush, onOpenChange, tool],
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
        // 工具与手柄键位对齐 Blender：W/Q 选工具，G/R/S 选手柄。
        case "w":
          // 笔画画到一半换工具会让视口在笔下转起来，画完再说。
          if (stroke.current) break;
          setTool("select");
          break;
        case "q":
          // 笔画画到一半换工具会让视口在笔下转起来，画完再说。
          if (stroke.current) break;
          setTool("navigate");
          break;
        case "g":
          setGizmoMode("translate");
          break;
        case "r":
          setGizmoMode("rotate");
          break;
        case "s":
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
            gizmoMode={gizmoMode}
            tool={tool}
            timelineOpen={timelineOpen}
            onAdd={handleAdd}
            onImportProp={(file) => void handleImportProp(file)}
            onGizmoMode={setGizmoMode}
            onTool={setTool}
            onTimelineOpen={setTimelineOpen}
          />

          {/*
            视口四周那几颗浮着的图标按钮（关闭、侧栏把手、监看开关，以及浮层控件里的
            撤销与显示模式）共用一份延迟：少了这个 Provider，鼠标从一颗扫到相邻那颗还要
            再等一次，一排开关按下来像是每颗都卡一下。
          */}
          <TooltipProvider delay={120}>
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
                  const store = usePrevizStore.getState();
                  strokeHeight.current = drawPlaneHeight(
                    store.scene,
                    store.selectedObjectId,
                    store.timelineFrame,
                  );
                  const point = renderer.planePointAt(
                    event.clientX,
                    event.clientY,
                    strokeHeight.current,
                  );
                  stroke.current = point ? [point] : [];
                  renderer.setStroke(stroke.current);
                }}
                onPointerMove={(event) => {
                  if (!stroke.current || !renderer) return;
                  const point = renderer.planePointAt(
                    event.clientX,
                    event.clientY,
                    strokeHeight.current,
                  );
                  // 射线与该平面平行时 planePointAt 交出 null，这一段笔画直接丢掉：
                  // 补一个瞎编的点会在轨迹上留下一个乱跳的顶点。
                  if (point) stroke.current.push(point);
                  // 每一下都推给渲染器：这条线就是绘制过程中唯一的反馈，攒到松手才画
                  // 等于让用户盲画一整笔。
                  renderer.setStroke(stroke.current);
                }}
                onPointerUp={(event) => {
                  if (stroke.current) {
                    const points = stroke.current;
                    stroke.current = null;
                    // 收笔交给轨迹曲线接管：不收的话这条线会和刚生成的轨迹重叠着留在画面上。
                    renderer?.setStroke(null);
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
                  // 导航工具只负责转视角：点一下不选也不清选中，转到一半误点不会把面板换掉。
                  if (tool === "navigate") return;
                  // 轨道拖拽也会经过 pointerdown/up；位移超过阈值就是在转视角。
                  if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_SLOP_PX) {
                    return;
                  }
                  if (tool === "mark") {
                    const store = usePrevizStore.getState();
                    const targetId = store.selectedObjectId;
                    // 没选对象时这个点没有归属，同画笔：不建无主轨迹。
                    if (!targetId) return;
                    // 换了对象就是另一条轨迹，不能把第二个人的点接到第一个人的轨迹后面。
                    const session =
                      marking.current?.objectId === targetId
                        ? marking.current
                        : {
                            objectId: targetId,
                            clipId: null,
                            height: drawPlaneHeight(store.scene, targetId, store.timelineFrame),
                          };
                    const point = renderer.planePointAt(
                      event.clientX,
                      event.clientY,
                      session.height,
                    );
                    // 射线与平面平行时打不到点，这一下当没点。
                    if (!point) return;
                    session.clipId = store.markPathPoint(targetId, point, session.clipId);
                    marking.current = session;
                    return;
                  }
                  // 轨迹点优先于对象：球是画在被它牵着走的那个对象身上的，让对象先接
                  // 这一下，轨迹点就永远点不中。点中之后对象的选中状态原样留着——
                  // 右侧面板上下两半正好是「谁在动」和「动到哪」。
                  const point = renderer.pickPathPointAt(event.clientX, event.clientY);
                  if (point) {
                    // 先选片段：selectClip 会顺手清掉旧的轨迹点，两句写反的话刚选的点
                    // 当场就被清了。
                    usePrevizStore.getState().selectClip(point.clipId);
                    usePrevizStore.getState().selectPathPoint(point.pointId);
                    return;
                  }
                  selectObject(renderer.pickAt(event.clientX, event.clientY));
                }}
              />

              {monitoredCamera && (
                <PrevizMonitorFrame
                  rect={monitorRect}
                  camera={monitoredCamera}
                  outputAspect={scene.settings.outputAspect}
                  size={monitorSize}
                  showOutline={showOutline}
                  showNamePlate={showNamePlate}
                  onOutputAspect={setOutputAspect}
                  onSize={setMonitorSize}
                  onShowOutline={setShowOutline}
                  onShowNamePlate={setShowNamePlate}
                  onClose={() => setActiveCamera(null)}
                />
              )}

              {!activeCameraId && restorableCameraId && (
                /*
                  监看关掉之后留在原地的开关。没有画中画可以贴，就贴画布自己的右下角。
                  和上面那个叉是同一个位置量级，于是「关」和「开」在视觉上是同一颗按钮。
                */
                <span className="absolute right-4 bottom-4">
                  <PrevizHoverTip label={t("previz.editor.showMonitor")}>
                    <button
                      type="button"
                      data-testid="previz-monitor-show"
                      aria-label={t("previz.editor.showMonitor")}
                      onClick={() => setActiveCamera(restorableCameraId)}
                      className="grid h-7 w-7 place-items-center rounded bg-black/55 text-white/70 transition hover:bg-black/80 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
                    >
                      <Monitor className="h-3.5 w-3.5" />
                    </button>
                  </PrevizHoverTip>
                </span>
              )}

              <div className="pointer-events-none absolute bottom-4 left-4 rounded-lg bg-black/45 px-3 py-1.5 text-xs text-white/80">
                {t("previz.editor.duration", { frames: scene.settings.durationFrames })}
              </div>

              {/*
                收起/展开的把手。贴视口右边缘、垂直居中：展开时它正好落在侧栏那条左边框
                上，收起后原地不动——于是「收」和「展」在视觉上是同一颗按钮，不会出现
                「收起来之后找不到怎么开回去」。挂在视口里而不是侧栏里，正是为了让它在
                侧栏卸掉之后还在。上下两端留给右上角的关闭键与右下角的监看开关。
              */}
              <span className="absolute right-0 top-1/2 z-20 -translate-y-1/2">
                <PrevizHoverTip label={panelsLabel} side="left">
                  <button
                    type="button"
                    data-testid="previz-panels-toggle"
                    aria-expanded={panelsOpen}
                    aria-label={panelsLabel}
                    onClick={() => setPanelsOpen((next) => !next)}
                    className="grid h-14 w-4 place-items-center rounded-l-md bg-white/10 text-white/60 transition hover:bg-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
                  >
                    {panelsOpen ? (
                      <ChevronRight className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronLeft className="h-3.5 w-3.5" />
                    )}
                  </button>
                </PrevizHoverTip>
              </span>

              {/*
                选单开着时铺一层透明背板：点视口任何地方都收起来。靠 onBlur 收的话，
                点选单里的按钮会先触发 blur、把自己卸掉，那一下就永远点不中。
              */}
              {recordMenuOpen && (
                <div
                  className="absolute inset-0 z-10"
                  onPointerDown={() => setRecordMenuOpen(false)}
                />
              )}

              <div className="absolute right-14 top-4 z-30 flex items-center gap-2">
                <div className="relative">
                  <Button
                    variant="ghost"
                    aria-label={
                      recording ? t("previz.editor.record.stop") : t("previz.editor.record.open")
                    }
                    disabled={capturing || recordPublishing}
                    className="h-8 rounded-lg bg-white/10 px-3 text-[12px] text-white/85 hover:bg-white/20"
                    onClick={() => {
                      if (recording) {
                        recordStopped.current = true;
                        return;
                      }
                      setRecordMenuOpen((next) => !next);
                    }}
                  >
                    {recording ? (
                      <>
                        <Square className="mr-1 h-3 w-3 fill-current text-red-400" />
                        {t("previz.editor.record.stopWithProgress", {
                          percent: Math.round(recordProgress * 100),
                        })}
                      </>
                    ) : (
                      <>
                        <Circle
                          className={cn(
                            "mr-1 h-3 w-3 fill-current",
                            recordPublishing ? "text-white/40" : "text-red-400",
                          )}
                        />
                        {recordPublishing
                          ? t("previz.editor.record.publishing")
                          : t("previz.editor.record.open")}
                      </>
                    )}
                  </Button>

                  {recordMenuOpen && !recording && (
                    <div
                      role="menu"
                      aria-label={t("previz.editor.record.open")}
                      className="absolute right-0 top-9 w-44 overflow-hidden rounded-lg border border-white/10 bg-black/85 p-1 backdrop-blur-sm"
                    >
                      {RECORD_MODES.map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          role="menuitem"
                          className="block w-full rounded-md px-3 py-2 text-left text-[12px] text-white/85 transition hover:bg-white/10 hover:text-white"
                          onClick={() => {
                            setRecordMenuOpen(false);
                            void handleRecord(mode);
                          }}
                        >
                          {t(`previz.editor.record.mode.${mode}`)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <Button
                  variant="ghost"
                  aria-label={t("previz.editor.capture")}
                  disabled={capturing || Boolean(recording) || recordPublishing}
                  className="h-8 rounded-lg bg-white/10 px-3 text-[12px] text-white/85 hover:bg-white/20"
                  onClick={() => void handleCapture()}
                >
                  {capturing ? t("previz.editor.capturing") : t("previz.editor.capture")}
                </Button>
              </div>

              <PrevizViewportControls
                canUndo={canUndo}
                canRedo={canRedo}
                displayMode={scene.settings.displayMode}
                pathSpacingM={pathSpacingM}
                pathSpeedMps={pathSpeedMps}
                view={viewSource}
                hasSelection={Boolean(selectedObjectId)}
                quadView={quadView}
                onUndo={undo}
                onRedo={redo}
                onDisplayMode={setDisplayMode}
                onResetView={() => renderer?.resetView()}
                onPathSpacing={setPathSpacing}
                onPathSpeed={setPathSpeed}
                onViewDirection={(direction) => renderer?.applyViewDirection(direction)}
                onFocus={() => {
                  if (selectedObjectId) renderer?.focusObject(selectedObjectId);
                }}
                onQuadView={setQuadView}
              />

              <span className="absolute right-4 top-4 z-20">
                <PrevizHoverTip label={t("previz.editor.close")} side="bottom">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("previz.editor.close")}
                    className="text-white/80 hover:text-white"
                    onClick={() => handleOpenChange(false)}
                  >
                    <X className="h-5 w-5" />
                  </Button>
                </PrevizHoverTip>
              </span>

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
          </TooltipProvider>

          {/*
            两块正交预览自成一列，不跟着图层/属性面板一起收：它们回答的是「这场戏摆成
            什么样」，跟看不看得见图层树没关系。收起侧栏正是为了把地方让给画面，这时更
            需要这两张参照图留着。
          */}
          {quadView && (
            <PrevizQuadPreview
              scene={scene}
              frame={timelineFrame}
              cameraId={quadCameraId}
              cameraName={quadCamera?.name ?? null}
              subscribeDrag={subscribeDrag}
              onRenderOrtho={handleQuadPreview}
              onRenderCamera={handleQuadCamera}
            />
          )}

          {panelsOpen && (
            <>
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

              {/*
                没选中对象也没选中片段时整列不出来：两条「选中后在这里编辑」的占位叠在一起
                白占一列宽，用户想看的只是对象列表。片段单独算一路——时间轴上点片段不会
                顺带选中对象，这时片段属性照样得能编。

                列宽定在这一层，不靠子面板各自带宽度：这个 div 没有宽度时取的是子面板的
                max-content，最宽那一排会把整列撑出可视区，最后一个按钮直接被切在屏幕外。
                边框和底色也一起收到这里——两个面板上下相接，各画各的边会在接缝处露出来。
              */}
              {(selectedObject || selectedClipId) && (
                <div className="flex w-80 min-w-0 shrink-0 flex-col overflow-y-auto border-l border-white/10 bg-black/30">
                  <PrevizInspector
                    object={selectedObject}
                    onChange={(patch) => {
                      if (selectedObjectId) updateObject(selectedObjectId, patch);
                    }}
                  />
                  <PrevizClipInspector />
                </div>
              )}
            </>
          )}
          </div>

          {timelineOpen && <PrevizTimeline onCreateObject={handleAdd} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default PrevizEditor;
