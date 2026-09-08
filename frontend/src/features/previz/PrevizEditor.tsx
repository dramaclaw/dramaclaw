// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, Monitor } from "lucide-react";
import { toast } from "sonner";

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
import {
  createAudioContext,
  createAudioPlayback,
  fetchAudioBuffer,
  type PrevizAudioPlayback,
} from "./engine/audioPlayback";
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
import { liveCameraAt } from "./domain/program";
import { uploadPrevizProp } from "./propAsset";
import { monitorCameraId, usePrevizStore } from "./store";
import { PrevizCameraCreateDialog } from "./ui/PrevizCameraCreateDialog";
import { PrevizClipInspector } from "./ui/PrevizClipInspector";
import { PrevizHeaderBar } from "./ui/PrevizHeaderBar";
import { PrevizInspector } from "./ui/PrevizInspector";
import { PrevizLayerPanel } from "./ui/PrevizLayerPanel";
import { PrevizMonitorFrame } from "./ui/PrevizMonitorFrame";
import { PrevizQuadPreview } from "./ui/PrevizQuadPreview";
import { PrevizTimeline } from "./ui/PrevizTimeline";
import { PREVIZ_DEFAULT_TOOL, PrevizToolbar } from "./ui/PrevizToolbar";
import type { PrevizTool } from "./ui/PrevizToolbar";
import { useCutToCamera } from "./ui/useCutToCamera";
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
  /**
   * 把当前场景交回节点落盘：停手 `PREVIZ_AUTOSAVE_MS` 之后一次，关窗时再兜一次。
   *
   * 返回值是「这一份到底存下没有」。`false` 表示节点拒收，编辑器就继续把场景记作
   * 未保存；今天唯一的拒收理由是场景撑爆了体积上限，取舍见 `flushIfDirty`。
   */
  onFlush: (scene: PrevizScene) => boolean;
}

/** 按下与抬起之间超过这个像素就算在转视角，不是在点选。 */
const CLICK_SLOP_PX = 4;

/**
 * 停手多久之后把场景写回节点。
 *
 * 取 600：写回只是把场景交给画布，画布自己还要再等 `useCanvasSync` 的
 * `DEBOUNCE_MS = 800` 才真落盘，两级串起来最坏约 1.4 秒。再往上加就到了「手停下
 * 来还要等两秒才敢刷新」的边上；再往下减，一次滑杆拖动中间的自然停顿就会被切成
 * 好几次写回，而每一次写回都是一整轮 JSON 序列化加一次整画布落盘。
 */
export const PREVIZ_AUTOSAVE_MS = 600;

/**
 * 哪颗工具支起哪种手柄；`null` 表示这颗工具下视口里不该有手柄。
 *
 * 值域直接写成 `GizmoMode | null` 而不是 `| undefined` 再在取值处补个 `?? null`：
 * `setGizmoMode` 收的本来就是 `GizmoMode | null`，多绕一道会让「这里少写一行」既能是
 * 编译期错误、也能是运行期悄悄补上的 null，白白削掉下面那条 Record 的保护。
 *
 * 写成完整的 `Record` 而不是 `Partial`：将来往工具列表里加一颗，这里少写一行是编译期
 * 错误，逼着作者当场表态「它要不要手柄」，而不是默默落进「没有手柄」——那种漏法只有
 * 用户点了半天发现拖不动才发现得了。
 */
const TOOL_GIZMO_MODE: Record<PrevizTool, GizmoMode | null> = {
  select: null,
  navigate: null,
  draw: null,
  mark: null,
  translate: "translate",
  rotate: "rotate",
  scale: "scale",
};

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
  /**
   * 监看的三个开关。放在编辑器本地而不是场景设置里：它们只改「怎么看」，一个像素都不
   * 进出片，跟 `tool` 是同一类东西。落进 `settings` 的话，切一次描边会进撤销栈、还会把
   * 节点数据标脏——用户会莫名其妙地被问「要不要保存」。
   */
  const [monitorSize, setMonitorSize] = useState<MonitorSize>("normal");
  const [showOutline, setShowOutline] = useState(true);
  const [showNamePlate, setShowNamePlate] = useState(true);
  const [tool, setTool] = useState<PrevizTool>(PREVIZ_DEFAULT_TOOL);
  /**
   * 视口里支哪种手柄，从**工具**派生，不再是第二份 state。
   *
   * 原先工具和手柄模式是两个互不相干的 state，工具栏各算各的按下态，于是 W 和 R 永远
   * 同时亮着；现在七颗按钮是一条互斥列表，手柄在不在只由「亮着的那颗是不是变换工具」
   * 决定，两份 state 不可能再对不上。
   */
  const gizmoMode = TOOL_GIZMO_MODE[tool];
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
  /** 正在录的那一路；null 就是没在录。 */
  const [recording, setRecording] = useState<PrevizRecordMode | null>(null);
  /** 录制进度 0..1，只喂按钮上的读数。 */
  const [recordProgress, setRecordProgress] = useState(0);
  /**
   * 用户点了停止。ref 而不是 state：录制循环是在闭包里跑的，读 state 读到的永远是
   * 开录那一刻的 false。
   */
  const recordStopped = useRef(false);
  /**
   * 「这一次录制已经受理了」。必须是 ref 而不是 `recording` 那个 state：`handleRecord`
   * 在开录之前要先 await 音频解码，那期间 `recording` 还是 null、按钮上还写着「开始录制」，
   * 而解码是网络取样再 decodeAudioData，首次录制轻松几百毫秒到几秒。用户按惯例再点一下，
   * 第二路录制就在同一块画布上跑起来了——第一路的 `pass.end()` 会在第二路录制中途把辅助物
   * 还回去，手柄、轨迹、机位锥就被烤进第二路的成片里；两个 MediaRecorder 抢同一块画布、
   * 都在推播放头，第二路的排程还会把第一路的音频 stop 掉。ref 是同步写的，不等渲染。
   */
  const recordBusy = useRef(false);
  /** 录完之后的上传与建节点阶段。与 `recording` 分开：按钮上写的字不一样。 */
  const [recordPublishing, setRecordPublishing] = useState(false);
  /**
   * 机位创建对话框打开时，锁着的那一份导演视角。存下来而不是每帧现取：对话框开着时
   * 视口仍能被轨道拖动（预览渲染本身就会重画视口），现取的话用户拖一下取景就飘了。
   */
  const [cameraPose, setCameraPose] = useState<PrevizCameraPlacement | null>(null);
  const pointerDownAt = useRef<{ x: number; y: number } | null>(null);
  /**
   * Web Audio 上下文按需建、整个编辑器共用一份：浏览器对 AudioContext 数量有上限，
   * 每次播放都新建的话开关几次就静音了。首次真正需要（播放/录制且轨上有片段）才建，
   * 空音频轨的场景根本不碰它。
   */
  const audioPlaybackRef = useRef<PrevizAudioPlayback | null>(null);
  const ensureAudioPlayback = useCallback((): PrevizAudioPlayback | null => {
    if (audioPlaybackRef.current) return audioPlaybackRef.current;
    const context = createAudioContext();
    if (!context) return null;
    audioPlaybackRef.current = createAudioPlayback({
      context,
      fetchBuffer: (url) => fetchAudioBuffer(context, url),
    });
    return audioPlaybackRef.current;
  }, []);

  const scene = usePrevizStore((state) => state.scene);
  const selectedObjectId = usePrevizStore((state) => state.selectedObjectId);
  const activeCameraId = usePrevizStore((state) => state.activeCameraId);
  /** 监看此刻看的机位：跟随时是镜头轨的直播机位，手选后是 activeCameraId。 */
  const monitorId = usePrevizStore(monitorCameraId);
  const monitorFollowsProgram = usePrevizStore((state) => state.monitorFollowsProgram);
  /**
   * 监看钉在哪台上。跟随中一台都没钉住：`activeCameraId` 这时只是镜头轨空隙里的兜底
   * 值，用户并没有把监看交给它。原样传给图层面板的话，那台会报 `aria-pressed="true"`
   * 却不在监看里，点它拿到的是「关掉监看」——而用户点一颗暗按钮想要的是「回到这台」。
   */
  const pinnedCameraId = monitorFollowsProgram ? null : activeCameraId;
  const followProgram = usePrevizStore((state) => state.followProgram);
  const cutToCamera = useCutToCamera();
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
  const timelineRate = usePrevizStore((state) => state.timelineRate);
  const seekSerial = usePrevizStore((state) => state.seekSerial);
  // 音频片段进依赖而不是每次从 getState 现读：store 对 `timeline.audio` 是结构共享的，
  // 拖对象、改机位、剪镜头轨都只换 `objects`/`tracks`/`program`，音频那个数组引用原样传下去，
  // 只有真编辑音频轨才换新的。所以这条依赖恰好等于「音频轨被改了」，播放中的其他编辑不会
  // 白白重排一次音频。
  const audioClips = usePrevizStore((state) => state.scene.timeline.audio);
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
  // 记的是「上一次显示的」而不是「用户上一次选的」：跟随中这台可能由镜头轨给出、用户
  // 从没点过它。重开监看要接上的正是关掉前眼前那块画面，所以按显示过的算。
  const lastMonitoredCameraId = useRef<string | null>(null);
  if (monitorId) lastMonitoredCameraId.current = monitorId;
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
    const object = scene.objects.find((entry) => entry.id === monitorId);
    return object?.kind === "camera" ? object : null;
  }, [scene.objects, monitorId]);

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
   * 「监看的那台」既可能是用户手选的，也可能是跟随中镜头轨切过去的——这一格跟着监看
   * 走，切镜时它和右下角画中画换成同一台。
   *
   * 但不跟监看绑死：那一格答的是「镜头里是什么样」，而建完机位的下一件事就是想看它拍到
   * 什么。要求先设一次监看（手选或切一刀）才肯出画，等于让用户对着一格黑画面猜漏了哪步。
   */
  const quadCamera = useMemo(() => {
    const cameras = scene.objects.filter((object) => object.kind === "camera");
    return cameras.find((object) => object.id === monitorId) ?? cameras[0];
  }, [scene.objects, monitorId]);
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

  /*
    灌初始场景：每次「打开」只做一次，跟着 `open` / `nodeId` 走，**不**跟着
    `initialScene` 的引用走。

    以前依赖里挂着 `initialScene`，自动保存上线之后那就成了一条自噬回路：写回
    `node.data.scene` → 节点重算 `loadNodeScene`，而 `parseScene` 永远吐一个全新
    对象 → `initialScene` 换引用 → 这条 effect 重跑 → `loadScene` 把 past / future
    / 选中对象 / 监看机位 / 播放头 / 播放状态 / 时间轴缩放**一起清零**。用户看到
    的是：手停 0.6 秒，播放头啪一下跳回第 0 帧、预览画面整个变了、右边检查器收起、
    Ctrl+Z 从此撤不动。以前这条回路不存在，因为写回只在关窗那一下发生，那时编辑器
    马上就卸载了，没人看得见 `data.scene` 变没变。

    代价是「编辑器开着时外部改 node.data.scene 能同步进来」这条通道**故意关掉了**。
    核过：常规写入方只有编辑器自己。写 previz 节点 `scene` 的只有本编辑器的 `onFlush`
    （`nodeRegistry` 里那个 `scene: null` 是建节点时的初值）；画布级 Ctrl+Z 走
    `Canvas.tsx` 那个 keydown，开头就被 `isImmersiveViewerActive()` 挡掉（本组件的
    `useViewerImmersiveBody(open)` 正是把这个开关按下的），右键菜单那条 undo 藏在全屏
    弹窗底下点不到；协作、多标签页、本地草稿都没有第二条写回路径。

    但**有一条中途替换的路**：BeatContextNode 的「同步到主线」会走
    `restoreCurrentMainlinePresetCanvas`，它保底串三次网络往返（读基线、按 preset 重建、
    再读一次远端；前面那次 `flushFreezoneCanvasRuntime` 有待存改动时还要多一次）才落一次
    `setCanvasData`，这期间用户完全来得及点开某个预演台。

    换进来的是哪一份，看这个节点在不在远端那张画布里。那边的合并吐的是
    `[...remoteNodes, ...preservedNodes]`：id 在远端的按远端那份重建；不在的（用户自建的
    预演台多半属于这一类，preset 重建不出它）从 `localNodes` 保留下来——而那份快照是
    **几次 await 之前**抓的，于是 `data.scene` 被换回一个旧值。两条路都是中途替换掉
    `data.scene`。React Flow 按 id 复用，`PrevizNode` 不卸载，编辑器也不重挂。有了上面
    这条 ref，编辑器会**保留用户手上的会话**，并在下一次自动保存时把自己这份写回去、盖掉
    换进来的那份。这是有意选的：用户正编到一半，把他的场景连同撤销栈一起换成另一份，比
    「他自己那份赢」更糟——何况另一份要么是他刚存上去的，要么干脆就是几秒前的旧快照。

    `initialScene` 走 ref 而不是直接进依赖：ref 在渲染期同步最新值，读到的一定是当下
    那一份，而它换引用不会把这条 effect 叫醒。

    下面那行渲染期赋值今天在生产上不起作用：`PrevizNode` 是条件挂载
    （`isEditorOpen && <PrevizEditor …/>`），关窗整棵子树就卸载，重开是重新挂载，
    `useRef(initialScene)` 的初值本来就是当下那一份。它是留给将来的：谁要把编辑器改成
    常驻挂载、拿 `open` 开关，那时这行就是「ref 必须跟着最新 prop」的唯一保证，测试里
    那条 `loads whatever scene the node holds…` 钉的也是这条不变量，不是今天的症状。

    也正因为挂载期 `open` / `nodeId` / `loadScene` 三项恒定、这条 effect 每次挂载只跑
    一次且跑在任何重渲染之前，渲染期写 ref 在 React 19 并发下才是安全的（被丢弃的渲染
    留下的值会被随后以当前 props 的重跑收敛掉）。改成常驻挂载会同时打破这个前提，届时
    要重新想一遍。同理，依赖里的 `nodeId` / `loadScene` 今天都是常量，留着是为了那一天。
  */
  const initialSceneRef = useRef(initialScene);
  initialSceneRef.current = initialScene;

  useEffect(() => {
    if (!open) return;
    loadScene(initialSceneRef.current);
  }, [open, nodeId, loadScene]);

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
    renderer?.setActiveCamera(monitorId);
  }, [renderer, monitorId]);

  // 视口里那圈直播红框标的是「此刻正在播的是谁」，所以它认镜头轨与播放头，而不是监看：
  // 手选脱离跟随之后，监看看的是 A、正在播的仍是 B，两者本来就该各画各的。
  // 依赖只列 `scene.timeline.program`：`liveCameraAt` 就读这一条，挂整个 `scene` 会让
  // 拖一下物件也重算一遍。
  useEffect(() => {
    renderer?.setLiveCamera(liveCameraAt(scene, timelineFrame));
    // （`program` 换了引用不等于真的换了内容：删对象会顺手重建 timeline，于是这条
    // effect 白跑一次。`setLiveCamera` 首行同 id 就 return，白跑不要钱。）
  }, [renderer, scene.timeline.program, timelineFrame]);

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

  // 时间轴一播就把音频对上；seekSerial 一变（拖播放头 / 停下来）就从新位置重排。
  // 起播帧从 getState 读而不进依赖：播放中它每帧都在变，进了依赖就是每帧重排一次音频，
  // 声音会碎成一片咔哒。要的是「起播那一刻在哪」，seekSerial 已经替我们盯住了跳转。
  useEffect(() => {
    if (!open || !timelinePlaying || recording) return undefined;
    if (audioClips.length === 0) return undefined;
    const playback = ensureAudioPlayback();
    if (!playback) return undefined;
    void playback.play(audioClips, usePrevizStore.getState().timelineFrame, timelineRate);
    return () => playback.stop();
  }, [
    open,
    timelinePlaying,
    timelineRate,
    seekSerial,
    recording,
    audioClips,
    ensureAudioPlayback,
  ]);

  // 关编辑器就把上下文关掉；卸载同理。
  useEffect(() => {
    if (open) return undefined;
    audioPlaybackRef.current?.dispose();
    audioPlaybackRef.current = null;
    return undefined;
  }, [open]);
  useEffect(
    () => () => {
      audioPlaybackRef.current?.dispose();
      audioPlaybackRef.current = null;
    },
    [],
  );

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
    // 录制期间不出图：capture() 的 finally 同样会把录制正藏着的辅助物还成可见。
    if (!renderer || capturing || recording) return;
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
  }, [addDerivedUploadNode, addEdge, capturing, nodeId, recording, renderer, t]);

  const handleRecord = useCallback(
    async (mode: PrevizRecordMode) => {
      if (!renderer || recording || capturing || recordBusy.current) return;
      // 受理即上锁，同步的。下面第一件事就是 await（解码音频），锁必须在那之前立住。
      recordBusy.current = true;
      try {
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

        const audioClips = store.scene.timeline.audio;
        // 轨上有音频才混；混不了（没有 AudioContext / 没有带音轨的 mimeType）就退回无声，
        // 但要说一声，别让人以为音频丢了。
        // 这里拿「轨上有片段」当「流里有音轨」用：`createMediaStreamDestination()` 出来的
        // 节点恒带且只带一条音轨，两者在浏览器里不会分叉，空流只存在于测试的假引擎里。
        let playback: PrevizAudioPlayback | null =
          audioClips.length > 0 ? ensureAudioPlayback() : null;
        let mimeType = playback ? pickRecordMimeType(undefined, true) : null;
        if (audioClips.length > 0 && (!playback || !mimeType)) {
          toast.warning(t("previz.editor.record.noAudioMix"));
          playback = null;
        }
        if (!mimeType) mimeType = pickRecordMimeType();
        if (!mimeType) {
          toast.error(t("previz.editor.record.unsupported"));
          return;
        }

        // 解码赶在开录之前：`startRecording()` 一调辅助物就藏了、视口也切到了输出分辨率，
        // 这期间界面看着像卡死，几百毫秒的解码不该塞进这个窗口。`load()` 自己吞掉失败
        // （失败的 url 记进 failedUrls，播的时候跳过），所以这里不必接错。
        if (playback) await playback.load(audioClips);

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
          // 录制按真正走到的那一帧算时长，不拿设置里的总长充数：中途叫停的成片只有画出来
          // 的那一段。存的是帧号而不是画了几帧——第 0 帧落在 0 秒上，所以帧号本身就是成片
          // 的跨度（画了 0..N 共 N+1 帧，片长是 N 帧）。
          let drawn = 0;
          // 逐帧要问「这一帧谁在播」，问的是开录那一刻的场景：录制自己在推播放头，
          // 每帧重读 store 只会把中途的编辑读进成片。
          const programScene = store.scene;
          const mixed = playback;
          // 播放头只按约 10Hz 推进：每推一次整棵编辑器都要重渲一遍，再经 timelineFrame 那个
          // effect 把这一帧重新解算一次，30fps 下这占掉了每帧预算的一大块；录制是模态的，
          // 播放头只要看得出在走就够了。首帧与末帧必推：开录播放头要跳回开头（那一帧画在
          // 计时开始之前，不占预算），录完时间轴得停在结尾。
          let lastPushed = Number.NEGATIVE_INFINITY;
          // 进度同理：每报一次都是一次 setState，整棵编辑器重渲一遍，而录制期间它是每帧
          // 都报的。按 2% 一档攒着报——进度条上写的是整数百分比，比这更细的变化根本显示
          // 不出来。末尾那个 1 必须原样报到，否则最后一档差之毫厘，进度条就停在 99%。
          // 中途叫停时最后显示的仍是真报过的那一档。
          let lastProgress = 0;
          let blob: Blob;
          try {
            // 从这里往下都在 try 里，一句都不许漏出去：`new MediaRecorder()` 会因为容器谈不
            // 拢当场抛（混音那条候选里还有裸 `video/mp4`/`video/webm`，Safari 需要它们，谈崩
            // 的概率不低），`createMediaStreamDestination()` 理论上也能抛。漏出去的话
            // `pass.end()` 就不会跑，辅助物、手柄、机位锥全留在隐藏状态，视口也卡在输出分辨
            // 率上不再跟随窗口——只能重开编辑器才能救回来。
            // 混音出口每次录制都新开一个，不复用：`createCanvasRecorder` 收工时会把并进画布
            // 流的那条音轨一起 stop 掉，而停掉的轨道不会再复活，复用就是一部默片。
            const destination = mixed ? mixed.context.createMediaStreamDestination() : null;
            const canvasRecorder = createCanvasRecorder(pass.canvas, {
              fps: PREVIZ_RECORD_FPS,
              mimeType,
              audioStream: destination?.stream,
            });
            // 混音时录制器一开就把音频从第 0 帧、1 倍速排进混音节点；停就一起停。
            // 这里的 1 倍速是刻意的：成片是按 30fps 逐帧画出来的实速素材，跟着时间轴当前的
            // 播放倍速排音频只会让成片音画对不上。
            const recorder =
              mixed && destination
                ? {
                    start: () => {
                      canvasRecorder.start();
                      void mixed.play(audioClips, 0, 1, destination);
                    },
                    stop: () => {
                      mixed.stop();
                      return canvasRecorder.stop();
                    },
                  }
                : canvasRecorder;
            blob = await recordTimeline({
              durationFrames,
              fps: PREVIZ_RECORD_FPS,
              drawFrame: (frame) => {
                // 全局录制按镜头轨逐帧换机位；轨道录制固定一台，传 null 让 pass 用自己那台。
                pass.drawFrame(
                  frame,
                  target.mode === "global" ? liveCameraAt(programScene, frame) : null,
                );
                drawn = frame;
                // 顺手把播放头推到同一帧，时间轴跟着走。
                if (frame - lastPushed >= 3 || frame >= durationFrames) {
                  lastPushed = frame;
                  usePrevizStore.getState().setTimelineFrame(frame);
                }
              },
              recorder,
              now: () => performance.now(),
              schedule: (callback) => {
                window.requestAnimationFrame(callback);
              },
              onProgress: (ratio) => {
                if (ratio - lastProgress < 0.02 && ratio < 1) return;
                lastProgress = ratio;
                setRecordProgress(ratio);
              },
              shouldStop: () => recordStopped.current,
            });
          } finally {
            // 辅助物的可见性攥在这个句柄里，不还回去的话手柄与轨迹会一直不见。
            pass.end();
            // 正常收工时 `recorder.stop()` 已经停过一次，这里兜的是抛出去的那条路：
            // 排进混音节点的源没人停，就一直挂在 AudioContext 上。stop() 可重入。
            mixed?.stop();
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
            // 按真正画出的帧数算，而不是设置里的总长：中途叫停的成片比总长短，末帧后
            // 那截采样尾巴又让它比总长长，两个方向都得靠 `drawn` 才对得上。
            durationMs: Math.round((drawn / PREVIZ_RECORD_FPS) * 1000),
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
      } finally {
        recordBusy.current = false;
      }
    },
    [
      addDerivedVideoNode,
      addEdge,
      capturing,
      ensureAudioPlayback,
      nodeId,
      recording,
      renderer,
      t,
    ],
  );

  // 编辑器关掉时把录制叫停：循环握着渲染器，弹窗一关渲染器就 dispose 了。
  useEffect(() => {
    if (!open) recordStopped.current = true;
  }, [open]);

  /**
   * 把当前场景写回节点，但只在真有改动、且节点真收下了的时候才记作「已保存」。
   *
   * 判据用 store 的 `dirty` 而不是自己比场景引用：播放头、时间轴缩放、选中项都刻意
   * 不在 `PrevizScene` 里（store 里那段注释讲了为什么），只有 `applyScene` /
   * `undo` / `redo` 会置脏。所以「打开看一眼再关掉」不会白写一次 `node.data`——
   * 白写一次画布就 `trackEdit` 一次，紧接着把整张画布推去落盘，用户其实什么都没改。
   *
   * `markSaved()` 挂在 `onFlush` 的返回值上，是因为节点会拒收：场景撑爆体积上限时
   * `buildNodeScenePatch` 失败，`handleFlush` 直接返回、**一个字节都没存**。以前这里
   * 无条件 `markSaved()`，于是编辑器把一次拒收记成了保存成功——而节点那边「存不下」
   * 的 toast 一辈子只弹一次。合起来就是：用户吃一条提示，接着干一小时，此后每一次
   * 停手都在空转，`dirty` 一直读 false，关窗兜底也被判据挡掉，界面上毫无异样。
   *
   * 取舍：超限是**粘性失败**（场景就是那么大），所以拒收之后 `dirty` 会一直挂着。这
   * 不会变成「每 600ms 重试一次」的空转——下面那条 effect 挂在 `scene` 引用上，定时器
   * 开完火不会自己续命，用户不动手就不会有第二次尝试。等他删掉几个对象，那次编辑既
   * 换了 `scene` 引用又置了脏，下一个防抖窗口自然把整份场景重新试一遍，成功即复位。
   * 代价只有关窗时多试一次（一轮 JSON 序列化）。真正救不回来的是「超限状态下直接关
   * 窗」：装不下就是装不下，那条 toast 是唯一的信号。
   *
   * `onFlush()` 在前、`markSaved()` 在后还多防一层：将来写回改成会抛的实现时，异常
   * 同样落不到 `markSaved()`。今天 `handleFlush` 不抛（失败是 return，`updateNodeData`
   * 是 zustand set），而且真抛了还有别的后果——见 `handleOpenChange` 那条兜底。
   */
  const flushIfDirty = useCallback(() => {
    const state = usePrevizStore.getState();
    if (!state.dirty) return;
    if (!onFlush(state.scene)) return;
    state.markSaved();
  }, [onFlush]);

  /**
   * 自动保存：场景一变就起一个防抖窗口，停手 `PREVIZ_AUTOSAVE_MS` 之后写回节点。
   *
   * 防的是这个丢数据：以前 `onFlush` 只在关对话框那一下触发，用户导入 obj、摆完位置、
   * 不关对话框直接刷新页面，这一场戏从没进过 `node.data`，刷完就空了。
   *
   * 依赖挂 `scene` 而不是 `dirty`：`dirty` 是布尔，在一个还没写回过的爆发窗口里它
   * 一直是 true，effect 不会重跑，定时器也就不会被推后（写回之后 `markSaved()` 把它
   * 翻回 false，下一次编辑才叫得醒它）——那是「每 600ms 写一次」的节流，拖一次滑杆
   * 要写十几遍。挂在 `scene` 引用上才是真防抖：每一次 `applyScene` 都换一个新场景
   * 对象，effect 重跑、清掉上一个定时器、重新计时。
   *
   * `markSaved()` 只动 `dirty`、不动 `scene` 引用，所以写回之后 effect 不会被自己叫醒，
   * 不存在「存一次又排一次」的自激。
   */
  useEffect(() => {
    // `open` 在挂载期恒为 true（`PrevizNode` 条件挂载），这道早退今天不会命中，
    // 是留给「改成常驻挂载」那一天的。
    if (!open) return undefined;
    // `scene` 是依赖但不是判据：`loadScene` 也换 `scene` 引用，而它同时把 `dirty`
    // 清成 false，于是「刚打开编辑器」这一下不会立刻排一次没必要的写回。这道预检
    // 省的是一次空定时器，不是行为差异——真到点了 `flushIfDirty` 还会再看一次。
    if (!usePrevizStore.getState().dirty) return undefined;
    const timer = window.setTimeout(flushIfDirty, PREVIZ_AUTOSAVE_MS);
    // 卸载/关窗时必须清掉：定时器攥着 `onFlush`，而 `onFlush` 攥着节点 id，编辑器都
    // 没了还开火，写的可能是一个刚被删掉的节点；关窗那条兜底也已经写过一次了。
    return () => window.clearTimeout(timer);
  }, [open, scene, flushIfDirty]);

  const handleOpenChange = useCallback(
    (next: boolean, details?: DialogPrimitive.Root.ChangeEventDetails) => {
      /*
        打点时 Esc 是「打完了」，不是「关掉预演台」：弹窗默认的 Esc 关闭得让位，不然打到
        一半一按整个编辑器没了。

        工具也在这里回落，而不是放进下面那个 window keydown：base-ui 的 useDismiss
        在 document 上接到 Escape、问过 onOpenChange 之后会 stopPropagation，window 上
        的监听根本收不到这一下。弹窗是唯一听得见 Esc 的地方。

        回落到哪一颗跟画完一笔那处走同一个常量：两处是同一件事——「这一轮收手了，别让
        下一次点击又接着放点/画线」，任何非绘制非标记的工具都满足。各写各的字面量就会
        变成「画完能直接拖、Esc 完不能」，用户读不出这里面有什么道理，只会觉得手柄时
        有时无。
      */
      if (!next && details?.reason === "escape-key" && tool === "mark") {
        details.cancel();
        setTool(PREVIZ_DEFAULT_TOOL);
        return;
      }
      // 关窗仍然兜一次底：改完立刻关是最常见的路径，等不到防抖到点。上面那个
      // effect 的清理会顺手把待发的定时器清掉，`dirty` 判据保证这里和它不会重复写。
      // 这里是同步调用：`onFlush` 将来若改成会抛的实现，异常会从这儿窜出去，
      // 下面那行 `onOpenChange(next)` 就跑不到——弹窗关不掉。到那天要先包住它。
      if (!next) flushIfDirty();
      onOpenChange(next);
    },
    [flushIfDirty, onOpenChange, tool],
  );

  useEffect(() => {
    if (!open || !renderer) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      // instanceof 而不是 as：`window.dispatchEvent` 的 target 是 window，`tagName` 与
      // `closest` 一个都没有，断言成元素只会让下面两道守卫静静读到 undefined。收到
      // `Element` 而不是 `HTMLElement`：`closest` 定义在 `Element` 上，SVG 目标也该受
      // 弹窗守卫管——这里排除掉的只是「压根不是元素」的 target，不含 SVG。
      const target = event.target instanceof Element ? event.target : null;
      // 焦点在输入框里时 F 是在打字，不是快捷键。
      // `isContentEditable` 只长在 HTMLElement 上，所以单独收窄这一项，别为它把整个
      // target 降格成 HTMLElement（那会连带让弹窗守卫看不见 SVG 目标）。
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          (target instanceof HTMLElement && target.isContentEditable))
      ) {
        return;
      }

      // 机位创建对话框之类的嵌套弹窗开着时，按键是给它的。这道守卫落在 store 之前，
      // 收严的是**全部**快捷键（F/H/W/Q/G/R/S/空格/方向键/Delete/Cmd+Z），不只数字键：
      // 弹窗开着时按 Delete 删掉背后场景里的对象，和数字键切镜一样不是用户要的。
      //
      // 用 data- 属性白名单而不是 `contains()`/ref：没有元素获得焦点时 keydown 的 target
      // 是 body，body 不在 DialogContent 里，`contains()` 会把最常见的那种情况整个挡掉、
      // 所有快捷键当场失效。白名单反过来只挡「落在**别的** dialog 里」的按键，默认放行。
      const dialog = target?.closest('[role="dialog"]');
      if (dialog && !dialog.hasAttribute("data-previz-editor")) return;

      const store = usePrevizStore.getState();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // 1–9 按机位在对象列表里的顺序切镜；没有那一台就当没按。
      if (/^[1-9]$/.test(event.key)) {
        const cameras = store.scene.objects.filter((object) => object.kind === "camera");
        const camera = cameras[Number(event.key) - 1];
        if (camera) {
          event.preventDefault();
          cutToCamera(camera.id);
        }
        return;
      }

      switch (event.key.toLowerCase()) {
        case "f":
          if (store.selectedObjectId) renderer.focusObject(store.selectedObjectId);
          break;
        case "h":
          renderer.resetView();
          break;
        // 键位对齐 Blender：W/Q 选指针工具，G/R/S 选变换工具。五颗都在同一条互斥
        // 列表上，所以五条分支做的是同一件事——换 `tool`。
        //
        // 每一条都要挡笔画：换工具会让 `setDrawing` 把左键重新挂回轨道旋转，视口就在
        // 笔下转起来了。G/R/S 原先只改手柄模式，中途按下去是无害的，合并之后它们和
        // W/Q 掉进同一个坑，守卫一条都不能少。
        case "w":
          if (stroke.current) break;
          setTool("select");
          break;
        case "q":
          if (stroke.current) break;
          setTool("navigate");
          break;
        case "g":
          if (stroke.current) break;
          setTool("translate");
          break;
        case "r":
          if (stroke.current) break;
          setTool("rotate");
          break;
        case "s":
          if (stroke.current) break;
          setTool("scale");
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
  }, [open, renderer, cutToCamera]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="inset-0 left-0 top-0 h-dvh w-dvw max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 p-0 ring-0 sm:max-w-none"
        overlayClassName="bg-black/55 supports-backdrop-filter:backdrop-blur-none"
        showCloseButton={false}
        data-previz-editor=""
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
          <PrevizHeaderBar
            canUndo={canUndo}
            canRedo={canRedo}
            capturing={capturing}
            recording={recording}
            recordProgress={recordProgress}
            recordPublishing={recordPublishing}
            onUndo={undo}
            onRedo={redo}
            onCapture={() => void handleCapture()}
            onRecord={(mode) => void handleRecord(mode)}
            // 停止走 ref 而不是 state：录制循环在闭包里跑，读 state 读到的永远是开录
            // 那一刻的 false。
            onStopRecord={() => {
              recordStopped.current = true;
            }}
            onClose={() => handleOpenChange(false)}
          />

          <div className="flex min-h-0 flex-1">
          <PrevizToolbar
            canAdd={canAdd}
            tool={tool}
            timelineOpen={timelineOpen}
            onAdd={handleAdd}
            onImportProp={(file) => void handleImportProp(file)}
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
                    // 画完得离开画笔，否则下一次想选个对象反而又画了一条。这一步只
                    // 要求「不是 draw」，任何工具都满足；落在移动上，用户画完选中物体
                    // 就直接能拖，比落回「选择」少按一次键。
                    setTool(PREVIZ_DEFAULT_TOOL);
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
                  following={monitorFollowsProgram}
                  onFollow={followProgram}
                  /*
                    关监看顺带退出跟随（`setActiveCamera` 一并置 false）：关掉之后播放头
                    再越过切点也不该把画中画自己弹回来——那是用户刚亲手关掉的东西。代价是
                    重开之后要再按一下「跟随」，这一步换的是「关掉就是真的关掉」。
                  */
                  onClose={() => setActiveCamera(null)}
                />
              )}

              {!monitorId && restorableCameraId && (
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

              <PrevizViewportControls
                displayMode={scene.settings.displayMode}
                pathSpacingM={pathSpacingM}
                pathSpeedMps={pathSpeedMps}
                view={viewSource}
                hasSelection={Boolean(selectedObjectId)}
                quadView={quadView}
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
                monitorCameraId={monitorId}
                pinnedCameraId={pinnedCameraId}
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
