// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  Handle,
  NodeToolbar as ReactFlowNodeToolbar,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Camera,
  Globe,
  Grid2x2,
  Grid3x3,
  ImageDown,
  Loader2,
  Lock,
  Maximize2,
  RotateCcw,
  Save,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Viewer, CONSTANTS } from '@photo-sphere-viewer/core';
import '@photo-sphere-viewer/core/index.css';

const { ROTATE_UP, ROTATE_DOWN, ROTATE_LEFT, ROTATE_RIGHT, ZOOM_IN, ZOOM_OUT } = CONSTANTS.ACTIONS;

import {
  CANVAS_NODE_TYPES,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isStoryboardGenNode,
  isUploadNode,
  type CanvasNode,
  type Pano360ViewerNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { dataUrlToBlob, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { CANVAS_NODE_PANEL_SURFACE_CLASS, canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import { NODE_INLINE_ERROR_MESSAGE_CLASS } from '@/features/canvas/ui/nodeControlStyles';
import { uploadLocalImageToBackend } from '@/features/canvas/application/uploadToolOutput';
import { useUpstreamNodes } from '@/features/canvas/application/useUpstreamGraph';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  uploadAndAutoCommitSelectedBackgroundCandidate,
} from '@/features/canvas/application/selectedBackgroundSlot';
import { getFreezoneCanvasMetadata } from '@/features/freezone/canvasMetadataContext';

type Pano360ViewerNodeProps = NodeProps & {
  id: string;
  data: Pano360ViewerNodeData;
  selected?: boolean;
};

// 上游链接节点（upload / imageGen / imageEdit / exportImage / storyboardGen）
// 都可能给我们提供全景贴图。
function upstreamPanoUrl(node: CanvasNode | undefined | null): string | null {
  if (!node) return null;
  if (isImageGenNode(node)) {
    const data = node.data;
    const ref =
      typeof data.referenceImageUrl === 'string' && data.referenceImageUrl.length > 0
        ? data.referenceImageUrl
        : null;
    return data.imageUrl || ref;
  }
  if (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isStoryboardGenNode(node)
  ) {
    return node.data.imageUrl || null;
  }
  return null;
}

const D = Math.PI / 180;
const FOV_MIN = 5;
const FOV_MAX = 170;

const fovToFocal = (fov: number) => Math.round(18 / Math.tan((fov / 2) * D));
const fovToZoom = (fov: number) => ((FOV_MAX - fov) / (FOV_MAX - FOV_MIN)) * 100;
const zoomToFov = (zoom: number) => FOV_MAX - (zoom / 100) * (FOV_MAX - FOV_MIN);
const wrapDeg = (value: number) => ((Number(value) + 540) % 360) - 180;

const clampPitch = (value: number) => Math.max(-90, Math.min(90, value));
const clampFov = (value: number) => Math.max(FOV_MIN, Math.min(FOV_MAX, value));

const DIRECTION_OFFSETS: Record<string, number> = {
  front: 0,
  right: 90,
  back: 180,
  left: -90,
  seam: -180,
};

type CaptureFrameSpec = { yawOffset: number; pitch: number; label: string };

// 2×2：四个水平方向，平视，排成两列两行。
const GRID_2X2_FRAMES: CaptureFrameSpec[] = [
  { yawOffset: DIRECTION_OFFSETS.front, pitch: 0, label: '前方' },
  { yawOffset: DIRECTION_OFFSETS.right, pitch: 0, label: '右侧' },
  { yawOffset: DIRECTION_OFFSETS.back, pitch: 0, label: '后方' },
  { yawOffset: DIRECTION_OFFSETS.left, pitch: 0, label: '左侧' },
];

// 4×3：四个方向 × 三个俯仰（上 / 平 / 下），共 12 张，每行一个俯仰。
const GRID_4X3_DIRS: { offset: number; name: string }[] = [
  { offset: DIRECTION_OFFSETS.front, name: '前方' },
  { offset: DIRECTION_OFFSETS.right, name: '右侧' },
  { offset: DIRECTION_OFFSETS.back, name: '后方' },
  { offset: DIRECTION_OFFSETS.left, name: '左侧' },
];
const GRID_4X3_PITCHES: { value: number; name: string }[] = [
  { value: 40, name: '上' },
  { value: 0, name: '平' },
  { value: -40, name: '下' },
];
const GRID_4X3_FRAMES: CaptureFrameSpec[] = GRID_4X3_PITCHES.flatMap((pitch) =>
  GRID_4X3_DIRS.map((dir) => ({
    yawOffset: dir.offset,
    pitch: pitch.value,
    label: `${dir.name}·${pitch.name}`,
  })),
);

// 把任意比例的截图中心裁剪成 16:9，落到画布上的图片节点统一是宽屏格式。
async function cropDataUrlTo16x9(
  dataUrl: string,
  width: number,
  height: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const TARGET = 16 / 9;
  const srcRatio = width / Math.max(1, height);
  let cropW = width;
  let cropH = height;
  if (srcRatio > TARGET) {
    cropW = Math.round(height * TARGET);
  } else {
    cropH = Math.round(width / TARGET);
  }
  const sx = Math.round((width - cropW) / 2);
  const sy = Math.round((height - cropH) / 2);
  const out = document.createElement('canvas');
  out.width = cropW;
  out.height = cropH;
  const ctx = out.getContext('2d');
  if (!ctx) return { dataUrl, width, height };
  const image = new Image();
  image.src = dataUrl;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('image load failed'));
  });
  ctx.drawImage(image, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
  return { dataUrl: out.toDataURL('image/png'), width: cropW, height: cropH };
}

const waitFrames = (count = 3) =>
  new Promise<void>((resolve) => {
    let remaining = count;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

function resolveNodeDimension(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.round(value);
  }
  return fallback;
}

type SliderRowProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (next: number) => void;
};

function SliderRow({ label, value, min, max, step = 0.1, unit = '°', onChange }: SliderRowProps) {
  const handleNumber = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.max(min, Math.min(max, parsed)));
  };
  return (
    <div className="flex w-full items-center gap-2 text-[11px] text-text-dark/78">
      <span className="w-12 shrink-0 text-left tabular-nums text-text-dark/72">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => handleNumber(event.target.value)}
        onPointerDown={(event) => event.stopPropagation()}
        className="pano360-slider nodrag min-w-0 flex-1"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0}
        onChange={(event) => handleNumber(event.target.value)}
        onPointerDown={(event) => event.stopPropagation()}
        className="nodrag h-7 w-[58px] rounded-[7px] border border-white/[0.14] bg-transparent px-1.5 text-right text-[11px] tabular-nums text-text-dark/92 outline-none transition-colors hover:border-white/[0.22] focus:border-white/28"
      />
      <span className="w-3 text-[11px] text-text-dark/58">{unit}</span>
    </div>
  );
}

type ChipButtonProps = {
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
  tone?: 'default' | 'accent';
};

function ChipButton({ onClick, title, disabled, children, tone = 'default' }: ChipButtonProps) {
  const toneClass =
    tone === 'accent'
      ? 'border-[rgb(var(--accent-rgb))]/35 bg-[rgb(var(--accent-rgb))]/14 text-[rgb(var(--accent-rgb))] hover:bg-[rgb(var(--accent-rgb))]/22'
      : 'border-white/[0.12] bg-transparent text-text-dark/72 hover:border-white/[0.2] hover:bg-white/[0.06] hover:text-text-dark';
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className={`nodrag inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
    >
      {children}
    </button>
  );
}

type PanoToolbarButtonProps = {
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
};

function PanoToolbarButton({ onClick, title, disabled, children }: PanoToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className="nodrag inline-flex h-8 w-8 items-center justify-center rounded-full text-text-dark/72 transition-colors hover:bg-white/[0.08] hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function PanoViewportButton({ onClick, title, children }: PanoToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className="nodrag inline-flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition-colors hover:text-white/92 active:text-white"
    >
      {children}
    </button>
  );
}

export const Pano360ViewerNode = memo(({ id, data, selected, width, height }: Pano360ViewerNodeProps) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addPanoCaptureGroup = useCanvasStore((state) => state.addPanoCaptureGroup);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);

  // 组合选中 / 多选时 React Flow 也会把组内子节点标记为 selected，但此时不应唤醒
  // 全景交互（拖拽 / 滚轮）或弹出截图工具栏 —— 那属于「误激活 360 节点」。仅当本节点
  // 是画布上唯一选中项（selectedNodeId === id）时才算真正激活；节点边框高亮仍走
  // 原始 selected，组合选中时依旧能看到子节点被框选。
  const isActive = Boolean(selected) && selectedNodeId === id;

  const resolvedWidth = Math.max(900, resolveNodeDimension(width, 900));
  const resolvedHeight = Math.max(540, resolveNodeDimension(height, 540));

  // Subscribe to ONLY one-hop upstream (not the whole nodes array) so unrelated
  // node drags don't re-render this node. See useUpstreamGraph.
  const upstreamNodes = useUpstreamNodes(id);

  // 上游节点连过来的图片 URL，沿用项目里"按 y 坐标升序"的惯例。
  const upstreamPano = useMemo(() => {
    const upstream = [...upstreamNodes];
    upstream.sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));
    for (const node of upstream) {
      const url = upstreamPanoUrl(node);
      if (url) {
        return { nodeId: node.id, url };
      }
    }
    return null;
  }, [upstreamNodes]);

  // 上游图变化 → 同步进 data.imageUrl，便于保存 / 截图标签。
  useEffect(() => {
    if (upstreamPano) {
      if (
        upstreamPano.url !== data.imageUrl ||
        upstreamPano.nodeId !== (data.sourceNodeId ?? null)
      ) {
        updateNodeData(id, { imageUrl: upstreamPano.url, sourceNodeId: upstreamPano.nodeId });
      }
      return;
    }
    // 没有上游连接时，保留节点自带的 imageUrl（例如预设直接塞进来的全景图）；
    // 只有当前图本来就来自上游（sourceNodeId 有值）才在断连后清掉。
    if (data.sourceNodeId) {
      updateNodeData(id, { imageUrl: null, sourceNodeId: null });
    }
  }, [data.imageUrl, data.sourceNodeId, id, updateNodeData, upstreamPano]);

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.pano360Viewer, data),
    [data],
  );

  const viewerHostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const selectedRef = useRef(isActive);
  selectedRef.current = isActive;
  // PSV 自己的全屏状态（跨浏览器可靠，不依赖 document.fullscreenElement —— 后者在
  // Safari/WebKit/模拟全屏下可能为 null，导致全屏内拖拽判定直接失败）。
  const isFsRef = useRef(false);

  const [status, setStatus] = useState<string>('');
  const [viewerError, setViewerError] = useState<string>('');
  const [livePos, setLivePos] = useState<{ yawDeg: number; pitchDeg: number; fovDeg: number }>({
    yawDeg: 0,
    pitchDeg: 0,
    fovDeg: data.fovDeg,
  });
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);
  const [planetBackup, setPlanetBackup] = useState<{ fov: number; yawDeg: number; pitchDeg: number } | null>(null);

  // 显示用 URL 走项目里的 /static 代理。
  const displayUrl = useMemo(
    () => (data.imageUrl ? resolveImageDisplayUrl(data.imageUrl) : null),
    [data.imageUrl],
  );

  const applyCorrectionOn = useCallback((viewer: Viewer) => {
    // PSV 的 setOption('sphereCorrection') 直接访问 meshContainer.rotation，
    // 而 meshContainer 是 setPanorama → setTexture 才创建的。在首次加载完成
    // 之前调用（比如 panorama 还在 Loading 时用户拖了校正 slider）会抛
    // "Cannot read properties of undefined (reading 'rotation')"。
    // 这里依靠 viewer.state.ready 守护；slider 改的值已经写进 dataRef，
    // setPanorama.then 与 'ready' 回调都会拿最新值再 apply，不会丢。
    if (!viewer.state.ready) return;
    const { roll, pitch, yaw } = dataRef.current.sphereCorrectionDeg;
    viewer.setOption('sphereCorrection', {
      pan: yaw * D,
      tilt: pitch * D,
      roll: roll * D,
    });
  }, []);

  const applyFovOn = useCallback((viewer: Viewer, fovDeg: number) => {
    if (!viewer.state.ready) return;
    viewer.zoom(fovToZoom(fovDeg));
  }, []);

  const applyCorrection = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    applyCorrectionOn(viewer);
  }, [applyCorrectionOn]);

  const applyFov = useCallback((fovDeg: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    applyFovOn(viewer, fovDeg);
  }, [applyFovOn]);

  // 创建 / 切图。每次 displayUrl 变化时：清理旧 viewer，重新建一个 + 挂监听 + 加载。
  // StrictMode 下 effect 会跑两次：第一次 cleanup 销毁 Viewer A、第二次创建 Viewer B。
  // 不能让 Viewer A 的 listener 在 destroy 后仍然访问 viewerRef.current（那时它已经
  // 指向 Viewer B），否则 ready 回调里的 applyCorrection 会在 Viewer B 还没创建 mesh
  // 时调用 setSphereCorrection → meshContainer === undefined → "Cannot read properties
  // of undefined (reading 'rotation')"。
  useEffect(() => {
    const host = viewerHostRef.current;
    if (!host) return;
    if (!displayUrl) {
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
      setStatus('');
      setViewerError('');
      return;
    }

    const fovDeg = clampFov(dataRef.current.fovDeg || 70);
    let cancelled = false;
    let viewer: Viewer | null = null;

    // 把 Viewer 构造推迟到下一帧：StrictMode 下 mount→cleanup→mount 会在
    // 同一个微任务里跑完两轮，先 cancelAnimationFrame 再创建 —— 第一轮 RAF
    // 还没 fire 就被 cancel，整个 viewer 链路只走第二轮真正存活的 mount。
    // 等价于「断开重连」时只跑一次干净的 effect，避开了双实例污染。
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        viewer = new Viewer({
          container: host,
          defaultZoomLvl: fovToZoom(fovDeg),
          navbar: false,
          minFov: FOV_MIN,
          maxFov: FOV_MAX,
          // 拖拽旋转 / 滚轮缩放都走 PSV 原生：窗口内随节点选中开关，全屏时由 PSV 的
          // fullscreen 事件强制打开（见下方 v.addEventListener('fullscreen')）。
          mousemove: isActive,
          mousewheel: isActive,
          // 全屏下用方向键 / WASD 转视野、+- 缩放（C 方案）。
          keyboard: 'fullscreen',
          // 覆写默认映射，补上 WASD（含 shift 大写形态）。
          keyboardActions: {
            ArrowUp: ROTATE_UP,
            ArrowDown: ROTATE_DOWN,
            ArrowLeft: ROTATE_LEFT,
            ArrowRight: ROTATE_RIGHT,
            w: ROTATE_UP,
            W: ROTATE_UP,
            s: ROTATE_DOWN,
            S: ROTATE_DOWN,
            a: ROTATE_LEFT,
            A: ROTATE_LEFT,
            d: ROTATE_RIGHT,
            D: ROTATE_RIGHT,
            PageUp: ZOOM_IN,
            PageDown: ZOOM_OUT,
            '+': ZOOM_IN,
            '-': ZOOM_OUT,
          },
          // 全局关掉默认 transition —— 切图时也不再做旧→新的 fade+rotation 过渡。
          // 单图查看器没必要，而且能避开 PSV 在某些时序下 transition.rotation 的 NPE。
          // PSV 类型签名说 TransitionOptions | undefined，但运行时（CONFIG_PARSERS）
          // 显式支持 null，比类型更准 —— 直接 cast。
          defaultTransition: null as unknown as undefined,
          rendererParameters: { preserveDrawingBuffer: true },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `Photo Sphere Viewer 初始化失败: ${String(error)}`;
        setViewerError(message);
        setStatus(message);
        return;
      }
      viewerRef.current = viewer;
      setViewerError('');

      const v = viewer;
      // 所有 listener 都从闭包取 `v`，不从 viewerRef 现读 —— viewerRef 可能已经
      // 被后续 effect 覆盖成另一个实例。`cancelled` 也用闭包，防止 destroyed viewer
      // 的延迟回调更新 React state。
      v.addEventListener('ready', () => {
        if (cancelled) return;
        setStatus('就绪');
        applyCorrectionOn(v);
        applyFovOn(v, clampFov(dataRef.current.fovDeg || 70));
      });
      v.addEventListener('panorama-loaded', () => {
        if (cancelled) return;
        setStatus('已加载');
      });
      v.addEventListener('panorama-error', (event: unknown) => {
        if (cancelled) return;
        const err = event as { error?: Error | string; panorama?: string } | null;
        const errorObj = err?.error;
        const message =
          errorObj instanceof Error ? errorObj.message : typeof errorObj === 'string' ? errorObj : '加载失败';
        setStatus(message);
        setViewerError(message);
      });
      v.addEventListener('position-updated', ({ position }: { position: { yaw: number; pitch: number } }) => {
        if (cancelled) return;
        setLivePos((prev) => ({
          ...prev,
          yawDeg: position.yaw / D,
          pitchDeg: position.pitch / D,
        }));
      });
      v.addEventListener('zoom-updated', ({ zoomLevel }: { zoomLevel: number }) => {
        if (cancelled) return;
        const fov = zoomToFov(zoomLevel);
        setLivePos((prev) => ({ ...prev, fovDeg: fov }));
      });
      // PSV 的全屏开关（跨浏览器可靠）：全屏内即便节点没选中，也强制打开拖拽 + 滚轮。
      v.addEventListener('fullscreen', ({ fullscreenEnabled }: { fullscreenEnabled: boolean }) => {
        isFsRef.current = fullscreenEnabled;
        const on = fullscreenEnabled || selectedRef.current;
        v.setOption('mousemove', on);
        v.setOption('mousewheel', on);
      });

      setStatus('加载中...');
      // showLoader: false 这里其实只对「之后」的切图生效（PSV 源码 line 6148
      // 是 `||`，首次加载会被 `!state.ready` 强制 show loader）。真正不让 PSV
      // 的 loader 卡住的，是 viewerHost 上的 `[&_.psv-loader-container]:!hidden`
      // CSS，从渲染层直接切断；这里保留 false 是 belt-and-suspenders。
      v.setPanorama(displayUrl, { showLoader: false, transition: false })
        .then(() => {
          if (cancelled) return;
          setStatus('已加载');
          applyCorrectionOn(v);
          applyFovOn(v, clampFov(dataRef.current.fovDeg || 70));
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : `加载失败: ${String(error)}`;
          setStatus(message);
          setViewerError(message);
        });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (viewer) {
        if (viewerRef.current === viewer) {
          viewerRef.current = null;
        }
        viewer.destroy();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyCorrectionOn, applyFovOn, displayUrl]);

  // 拖拽 + 滚轮：未选中时关掉让画布事件透传；全屏时强制开启（全屏下节点可能并非
  // selected）。全屏状态以 PSV 自己的事件（isFsRef）为准；进出全屏由那个事件同步。
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const on = isFsRef.current || isActive;
    viewer.setOption('mousemove', on);
    viewer.setOption('mousewheel', on);
  }, [isActive, displayUrl]);

  // 「无限拖拽」叠加层（不替换 PSV 原生拖拽，只是叠在上面）：
  //   按下左键 → 请求 Pointer Lock（隐藏并锁定光标）。
  //   锁定成功后，光标的 clientX/Y 被冻结，PSV 原生拖拽算出的位移恒为 0（自然失效），
  //   改由这里用 movementX/Y 增量旋转 —— 鼠标永不撞到屏幕边缘，可一口气连续转。
  //   锁定失败（被拒/被策略禁用）则什么都不做，PSV 原生有边界拖拽照常兜底，不会卡死。
  // 用 capture 阶段挂 mousedown，确保先于子节点 / React 的 stopPropagation 触发。
  useEffect(() => {
    const host = viewerHostRef.current;
    if (!host) return;

    // 我们自己记录是否「正在拖拽」（左键按下到抬起）。不能只靠
    // document.pointerLockElement 判断旋转 —— 浏览器对「刚请求就退出」有节流，
    // 选中态下的一次单击可能让锁请求成功、exitPointerLock 没生效，锁就留住了；
    // 之后随便移动鼠标都会产生 movementX/Y → 画面一直转（且光标被隐藏）。
    let dragging = false;

    const radPerPx = () => {
      const fovRad = clampFov(dataRef.current.fovDeg || 70) * D;
      return fovRad / (host.clientHeight || 1);
    };
    const rotateBy = (dx: number, dy: number) => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      const k = radPerPx();
      const pos = viewer.getPosition();
      viewer.rotate({ yaw: pos.yaw - dx * k, pitch: pos.pitch + dy * k });
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return; // 仅左键
      // 全屏内总是启用；窗口内仅当节点选中时启用。用 PSV 的全屏状态，不依赖
      // document.fullscreenElement（Safari/WebKit/模拟全屏下可能为 null）。
      if (!isFsRef.current && !selectedRef.current) return;
      // 控制面板 / 自定义按钮（nodrag）、PSV 导航栏上的按下不劫持。
      if ((event.target as HTMLElement | null)?.closest('.nodrag, .psv-navbar')) return;
      dragging = true;
      // 锁全屏元素（全屏下只接受全屏元素或其后代）；拿不到就锁 host。
      const fsEl = (document.fullscreenElement ||
        (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement ||
        null) as HTMLElement | null;
      const target = fsEl ?? host;
      try {
        const ret = target.requestPointerLock?.() as unknown;
        if (ret && typeof (ret as Promise<void>).catch === 'function') {
          (ret as Promise<void>).catch(() => {});
        }
      } catch {
        /* 不支持 / 被拒 —— PSV 原生拖拽兜底 */
      }
    };

    const onMove = (event: MouseEvent) => {
      const lockEl = document.pointerLockElement as HTMLElement | null;
      if (!lockEl) return; // 仅在指针锁定时接管旋转
      // 只有「锁定的元素属于本节点」才接管旋转 —— 否则画布上每个查看器都挂了
      // window mousemove，拖一个会把所有查看器一起转。窗口内锁的是 host；
      // 全屏内锁的是 host 里的 PSV 容器（host.contains 覆盖）。
      if (lockEl !== host && !host.contains(lockEl)) return;
      if (!dragging) {
        // 锁属于本节点、但我们并不在拖拽（多半是上面说的「单击残留锁」）。
        // 主动退出，恢复光标并停止旋转，而不是继续吃 movementX/Y 转画面。
        document.exitPointerLock();
        return;
      }
      event.preventDefault();
      rotateBy(event.movementX, event.movementY);
    };

    const onMouseUp = () => {
      dragging = false;
      if (document.pointerLockElement) document.exitPointerLock();
    };

    host.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      host.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  const updateCorrectionAxis = useCallback(
    (axis: 'roll' | 'pitch' | 'yaw', next: number) => {
      const wrapped = axis === 'pitch' ? clampPitch(next) : wrapDeg(next);
      const current = dataRef.current.sphereCorrectionDeg;
      updateNodeData(id, {
        sphereCorrectionDeg: { ...current, [axis]: wrapped },
      });
      requestAnimationFrame(() => applyCorrection());
    },
    [applyCorrection, id, updateNodeData],
  );

  const resetCorrection = useCallback(() => {
    updateNodeData(id, { sphereCorrectionDeg: { roll: 0, pitch: 0, yaw: 0 } });
    requestAnimationFrame(() => applyCorrection());
  }, [applyCorrection, id, updateNodeData]);

  const resetView = useCallback(() => {
    viewerRef.current?.rotate({ yaw: 0, pitch: 0 });
  }, []);

  const toggleFullscreen = useCallback(() => {
    viewerRef.current?.toggleFullscreen();
  }, []);

  // 把当前视角的 yaw / pitch 烘焙进校正参数。
  const lockCurrentView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pos = viewer.getPosition();
    const current = dataRef.current.sphereCorrectionDeg;
    let nextYaw = current.yaw + pos.yaw / D;
    let nextPitch = current.pitch + pos.pitch / D;
    nextYaw = wrapDeg(nextYaw);
    nextPitch = clampPitch(nextPitch);
    updateNodeData(id, {
      sphereCorrectionDeg: { roll: current.roll, pitch: nextPitch, yaw: nextYaw },
    });
    requestAnimationFrame(() => {
      applyCorrection();
      viewer.rotate({ yaw: 0, pitch: 0 });
    });
  }, [applyCorrection, id, updateNodeData]);

  const setFrontYawFromView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pos = viewer.getPosition();
    const yawDeg = wrapDeg(pos.yaw / D);
    updateNodeData(id, { frontYawDeg: yawDeg });
    setStatus(`已设当前视角为 Front: ${yawDeg.toFixed(1)}°`);
  }, [id, updateNodeData]);

  const setFovDeg = useCallback(
    (next: number) => {
      const clamped = clampFov(next);
      updateNodeData(id, { fovDeg: clamped });
      applyFov(clamped);
    },
    [applyFov, id, updateNodeData],
  );

  const rotateToDirection = useCallback(
    (dir: keyof typeof DIRECTION_OFFSETS) => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      const yaw = wrapDeg(dataRef.current.frontYawDeg + DIRECTION_OFFSETS[dir]);
      viewer.rotate({ yaw: yaw * D, pitch: 0 });
    },
    [],
  );

  const enterPlanet = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pos = viewer.getPosition();
    setPlanetBackup({
      fov: dataRef.current.fovDeg,
      yawDeg: pos.yaw / D,
      pitchDeg: pos.pitch / D,
    });
    setFovDeg(160);
    viewer.rotate({ yaw: 0, pitch: -Math.PI / 2 });
  }, [setFovDeg]);

  const exitPlanet = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || !planetBackup) return;
    setFovDeg(planetBackup.fov);
    viewer.rotate({ yaw: planetBackup.yawDeg * D, pitch: planetBackup.pitchDeg * D });
    setPlanetBackup(null);
  }, [planetBackup, setFovDeg]);

  // 校正参数导出为 JSON，复制到剪贴板（替代了原 viewer 的 /__dramaclaw 接口）。
  const buildCorrectionEntry = useCallback(() => {
    const { roll, pitch, yaw } = dataRef.current.sphereCorrectionDeg;
    const front = dataRef.current.frontYawDeg;
    return {
      pano_url: dataRef.current.imageUrl,
      front_yaw_deg: front,
      sphere_correction_deg: { roll, pitch, yaw },
      sphere_correction_rad: {
        roll: +(roll * D).toFixed(6),
        tilt: +(pitch * D).toFixed(6),
        pan: +(yaw * D).toFixed(6),
      },
      cubemap_contract: {
        front_yaw_deg: front,
        right_yaw_deg: wrapDeg(front + DIRECTION_OFFSETS.right),
        back_yaw_deg: wrapDeg(front + DIRECTION_OFFSETS.back),
        left_yaw_deg: wrapDeg(front + DIRECTION_OFFSETS.left),
        seam_yaw_deg: wrapDeg(front + DIRECTION_OFFSETS.seam),
      },
      fov_deg: dataRef.current.fovDeg,
      ts: new Date().toISOString(),
    };
  }, []);

  const copyCorrectionJson = useCallback(async () => {
    const entry = buildCorrectionEntry();
    updateNodeData(id, { lastExportedEntry: entry });
    const text = JSON.stringify(entry, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setStatus('校正 JSON 已复制到剪贴板');
    } catch (error) {
      console.warn('[pano360] clipboard write failed', error);
      setStatus('已生成校正 JSON（剪贴板不可用，见控制台）');
      console.info('[pano360] correction JSON:\n' + text);
    }
  }, [buildCorrectionEntry, id, updateNodeData]);

  const getViewerCanvas = useCallback((): HTMLCanvasElement | null => {
    return viewerHostRef.current?.querySelector('canvas') ?? null;
  }, []);

  const snapCurrent = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer || !data.imageUrl) return;
    setIsCapturing(true);
    try {
      await waitFrames();
      const canvas = getViewerCanvas();
      if (!canvas) return;
      const cropped = await cropDataUrlTo16x9(
        canvas.toDataURL('image/png'),
        canvas.width,
        canvas.height,
      );
      // Upload so the node's imageUrl is a real backend URL (not base64).
      const uploadedUrl = await uploadLocalImageToBackend(
        cropped.dataUrl,
        `pano-${id}-${Date.now()}.png`,
      );
      const nodeId = addPanoCaptureGroup(id, [{ ...cropped, uploadedUrl, label: '当前视角' }]);
      setStatus(nodeId ? '已生成当前视角截图' : '截图失败');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`截图失败: ${message}`);
    } finally {
      setIsCapturing(false);
    }
  }, [addPanoCaptureGroup, data.imageUrl, getViewerCanvas, id]);

  // "用作背景源": 把当前 viewer 视角(yaw/pitch/fov 决定的画面)16:9 crop 后
  // 先生成当前背景候选节点,再走主线 commit 写入 selected_background。
  // 跟 snapCurrent 区别: snapCurrent 只生成普通截图节点;这里生成的是可提交的
  // 主线候选节点。
  // Viewer 本身就是 cropper(用户用 yaw/pitch/fov 取景),所以不需要额外
  // BackgroundCropperDialog — 用户已经在 viewer 里把"想要的 16:9 框"调好了。
  const snapAsBackgroundAnchor = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer || !data.imageUrl) return;
    const canvasMeta = getFreezoneCanvasMetadata();
    const presetMeta = (canvasMeta?.preset as
      | { episode?: number; beat?: number }
      | undefined) ?? undefined;
    const episode = typeof presetMeta?.episode === 'number' ? presetMeta.episode : null;
    const beat = typeof presetMeta?.beat === 'number' ? presetMeta.beat : null;
    if (episode === null || beat === null) {
      setStatus('当前不在镜头上下文中,无法设为背景源');
      return;
    }
    setIsCapturing(true);
    try {
      await waitFrames();
      const canvas = getViewerCanvas();
      if (!canvas) return;
      const cropped = await cropDataUrlTo16x9(
        canvas.toDataURL('image/png'),
        canvas.width,
        canvas.height,
      );
      // dataUrl → Blob (fetch trick 比 atob 干净)
      // CSP `connect-src 'self'` blocks fetching data: URLs in production.
      const blob = dataUrlToBlob(cropped.dataUrl);
      await uploadAndAutoCommitSelectedBackgroundCandidate(
        { episode, beat },
        blob,
        `background_pano360_${Date.now()}.png`,
        {
          sourceNodeId: id,
          label: '当前背景',
          successMessage: '已设置当前背景',
        },
      );
      setStatus('已生成当前背景候选并提交');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`设置失败: ${message}`);
    } finally {
      setIsCapturing(false);
    }
  }, [data.imageUrl, getViewerCanvas]);

  const captureFrame = useCallback(
    async (yawDeg: number, pitchDeg: number, fovDeg: number) => {
      const viewer = viewerRef.current;
      if (!viewer) throw new Error('viewer not ready');
      viewer.zoom(fovToZoom(fovDeg));
      viewer.rotate({ yaw: yawDeg * D, pitch: pitchDeg * D });
      await waitFrames(3);
      const canvas = getViewerCanvas();
      if (!canvas) throw new Error('canvas not found');
      return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
    },
    [getViewerCanvas],
  );

  // 多方向截图：逐帧捕获后，每张都落成独立的图片节点，并放进一个前端展示用的
  // 分组里（不新建组合节点类型）。yaw 以用户设定的「正前方」为基准。
  const captureToGroup = useCallback(
    async (cols: number, frames: CaptureFrameSpec[], fov: number, groupName: string) => {
      const viewer = viewerRef.current;
      if (!viewer || !data.imageUrl) return;
      setIsCapturing(true);
      const savedPos = viewer.getPosition();
      const savedFov = dataRef.current.fovDeg;
      try {
        setStatus(`截图中（${frames.length} 张）…`);
        const frontYaw = dataRef.current.frontYawDeg;
        const captures: {
          dataUrl: string;
          width: number;
          height: number;
          label: string;
          uploadedUrl?: string;
        }[] = [];
        for (const frame of frames) {
          const yaw = wrapDeg(frontYaw + frame.yawOffset);
          const shot = await captureFrame(yaw, frame.pitch, fov);
          const cropped = await cropDataUrlTo16x9(shot.dataUrl, shot.width, shot.height);
          captures.push({ ...cropped, label: frame.label });
        }
        viewer.rotate(savedPos);
        applyFov(savedFov);
        // Upload every frame so each child node's imageUrl is a real backend URL;
        // per-frame best-effort, dataUrl stays as the preview.
        setStatus(`上传中（${captures.length} 张）…`);
        await Promise.all(
          captures.map(async (capture, index) => {
            capture.uploadedUrl = await uploadLocalImageToBackend(
              capture.dataUrl,
              `pano-${id}-${Date.now()}-${index}.png`,
            );
          }),
        );
        const groupId = addPanoCaptureGroup(id, captures, { cols, groupName });
        setStatus(groupId ? `已生成 ${captures.length} 张截图` : '截图失败');
      } catch (error) {
        viewer.rotate(savedPos);
        applyFov(savedFov);
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`截图失败: ${message}`);
      } finally {
        setIsCapturing(false);
      }
    },
    [addPanoCaptureGroup, applyFov, captureFrame, data.imageUrl, id],
  );

  const snap2x2 = useCallback(
    () => captureToGroup(2, GRID_2X2_FRAMES, 90, '全景截图组 (4 张)'),
    [captureToGroup],
  );
  const snap4x3 = useCallback(
    () => captureToGroup(4, GRID_4X3_FRAMES, 75, '全景截图组 (12 张)'),
    [captureToGroup],
  );

  const handleNodeClick = useCallback(() => {
    setSelectedNode(id);
  }, [id, setSelectedNode]);

  const zoomViewportBy = useCallback(
    (deltaFov: number) => {
      const baseFov = dataRef.current.fovDeg || livePos.fovDeg || 70;
      setFovDeg(baseFov + deltaFov);
    },
    [livePos.fovDeg, setFovDeg],
  );

  const rotateViewportBy = useCallback((yawDeltaDeg: number, pitchDeltaDeg: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const position = viewer.getPosition();
    viewer.rotate({
      yaw: position.yaw + yawDeltaDeg * D,
      pitch: clampPitch(position.pitch / D + pitchDeltaDeg) * D,
    });
  }, []);

  const containerStyle: CSSProperties = {
    width: resolvedWidth,
    height: resolvedHeight,
  };

  const correction = data.sphereCorrectionDeg;
  const liveFov = livePos.fovDeg || data.fovDeg;
  const focal = Number.isFinite(liveFov) ? fovToFocal(clampFov(liveFov)) : null;

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} p-0 transition-colors duration-150
        ${canvasNodeFrameClass({ selected })}
      `}
      style={containerStyle}
      onClick={handleNodeClick}
    >
      {/* 截图工具栏：放在节点正上方（删除 pill 已隐藏，可贴近节点）。 */}
      <ReactFlowNodeToolbar
        nodeId={id}
        isVisible={isActive && Boolean(data.imageUrl)}
        position={Position.Top}
        align="center"
        offset={16}
        className="pointer-events-auto"
      >
        <div className="flex items-center gap-1 rounded-full border border-white/[0.12] bg-[#282828]/95 px-1.5 py-1 shadow-[0_10px_24px_rgba(0,0,0,0.32)] backdrop-blur-md">
          <PanoToolbarButton onClick={snapCurrent} disabled={isCapturing} title="当前视角截图">
            {isCapturing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
          </PanoToolbarButton>
          <PanoToolbarButton onClick={snap2x2} disabled={isCapturing} title="4 大视角截图">
            <Grid2x2 className="h-4 w-4" />
          </PanoToolbarButton>
          <PanoToolbarButton onClick={snap4x3} disabled={isCapturing} title="12 大视角截图">
            <Grid3x3 className="h-4 w-4" />
          </PanoToolbarButton>
          <span className="mx-1 h-5 w-px bg-white/15" aria-hidden />
          {/* 用作背景源: viewer 本身是 cropper,截当前 view 16:9 区域写
              beat selected_background.png(不开 dialog)。仅在镜头上下文有效。 */}
          <PanoToolbarButton
            onClick={snapAsBackgroundAnchor}
            disabled={isCapturing}
            title="用作背景源(写入本 beat selected_background)"
          >
            <ImageDown className="h-4 w-4" />
          </PanoToolbarButton>
          <span className="mx-1 h-5 w-px bg-white/15" aria-hidden />
          <PanoToolbarButton onClick={resetView} title="复位视角">
            <RotateCcw className="h-4 w-4" />
          </PanoToolbarButton>
        </div>
      </ReactFlowNodeToolbar>

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Globe className="h-4 w-4" />}
        titleText={resolvedTitle}
        metaText={status || (data.imageUrl ? '360 自由画布查看器' : '等待上游连接全景图')}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="flex h-full w-full overflow-hidden rounded-[var(--node-radius)] bg-[#282828]">
        {/* 渲染区。激活时 PSV 独占拖拽 / 滚轮（nopan nowheel + stopPropagation），
            未激活时让事件透传，画布 pan / zoom / 选中节点正常工作。 */}
        <div className="relative flex-1 min-w-0">
          {/* 两个 PSV 视觉覆盖我们都要切掉：
              - `[&_.psv-loader-container]:!hidden`：PSV 自带 loader 在
                AbortError 路径下不会 hide（源码 line 6134 `isAbortError`
                短路 done()），从 DOM 层永久切断。
              - `[&_.psv-container]:[background:transparent_!important]`：
                PSV 默认给 container 一个白→灰径向渐变（index.css line 17-25），
                走的是 `background:` shorthand（背景图像）。不能用
                `bg-transparent`（那只改 background-color，干不掉
                background-image）。必须用 arbitrary 整组覆盖。
              header 的 status 文本是唯一加载状态来源。 */}
          <div
            ref={viewerHostRef}
            className={`pano360-viewer-host absolute inset-0 bg-black [&_.psv-loader-container]:!hidden [&_.psv-container]:[background:transparent_!important] ${isActive ? 'nopan nowheel' : ''}`}
            onPointerDown={isActive ? (event) => event.stopPropagation() : undefined}
            onWheel={isActive ? (event) => event.stopPropagation() : undefined}
          />
          {!data.imageUrl ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-muted/85">
              <Globe className="h-7 w-7 opacity-60" />
              <span className="px-3 text-center text-[12px] leading-6">
                连接上游图片节点开始浏览全景
              </span>
            </div>
          ) : null}

          {viewerError ? (
            <div className={`pointer-events-none absolute left-2 right-2 top-2 max-h-24 overflow-y-auto ${NODE_INLINE_ERROR_MESSAGE_CLASS}`}>
              {viewerError}
            </div>
          ) : null}

          {/* 左上角实时数值 HUD */}
          {data.imageUrl ? (
            <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/34 px-2.5 py-1 text-[10px] tabular-nums text-white/74 backdrop-blur-sm">
              yaw {livePos.yawDeg.toFixed(1)}° · pitch {livePos.pitchDeg.toFixed(1)}° · fov {liveFov.toFixed(0)}°{focal ? ` · ${focal}mm` : ''}
            </div>
          ) : null}

          {data.imageUrl ? (
            <div
              className="nodrag absolute bottom-3 left-3 flex items-center gap-1 rounded-full border border-white/[0.08] bg-black/28 px-1.5 py-1 backdrop-blur-sm"
              onPointerDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
            >
              <PanoViewportButton onClick={() => zoomViewportBy(10)} title="缩小">
                <ZoomOut className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={() => zoomViewportBy(-10)} title="放大">
                <ZoomIn className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={() => rotateViewportBy(-12, 0)} title="向左">
                <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={() => rotateViewportBy(12, 0)} title="向右">
                <ArrowRight className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={() => rotateViewportBy(0, 8)} title="向上">
                <ArrowUp className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={() => rotateViewportBy(0, -8)} title="向下">
                <ArrowDown className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={toggleFullscreen} title="进入全屏">
                <Maximize2 className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
            </div>
          ) : null}

          {/* 顶部右侧：面板折叠 */}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setIsPanelOpen((open) => !open);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            title={isPanelOpen ? '收起控制面板' : '展开控制面板'}
            className="nodrag absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.1] bg-black/35 text-white/72 backdrop-blur-sm transition-colors hover:bg-black/50 hover:text-white"
          >
            {isPanelOpen ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>

        {/* 右侧控制面板 */}
        {isPanelOpen ? (
          <div
            className="pano360-control-panel nopan nowheel flex h-full w-[336px] shrink-0 flex-col gap-4 overflow-y-auto overflow-x-hidden border-l border-white/[0.08] bg-[#191a1f]/94 p-4 text-[12px] text-text-dark backdrop-blur-sm"
            onWheel={(event) => event.stopPropagation()}
          >
            {/* FOV */}
            <section className="flex flex-col gap-2">
              <header className="flex items-center justify-between gap-3 text-[11px] font-medium text-text-dark/72">
                <span>视场角 FOV</span>
                <span className="tabular-nums text-text-dark/64">{liveFov.toFixed(0)}° · {focal ?? '—'}mm</span>
              </header>
              <SliderRow
                label="fov"
                value={data.fovDeg}
                min={FOV_MIN}
                max={FOV_MAX}
                step={1}
                onChange={setFovDeg}
              />
              <div className="flex flex-wrap gap-1.5">
                {[20, 35, 50, 70, 90, 120, 150].map((preset) => (
                  <ChipButton key={preset} onClick={() => setFovDeg(preset)}>
                    {preset}°
                  </ChipButton>
                ))}
              </div>
            </section>

            {/* 校正 */}
            <section className="flex flex-col gap-2">
              <header className="flex items-center justify-between gap-3 text-[11px] font-medium text-text-dark/72">
                <span>球面校正</span>
                <button
                  type="button"
                  className="nodrag rounded-full px-2 py-1 text-[11px] text-text-dark/62 transition-colors hover:bg-white/[0.06] hover:text-text-dark"
                  onClick={(event) => {
                    event.stopPropagation();
                    resetCorrection();
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  重置
                </button>
              </header>
              <SliderRow
                label="roll"
                value={correction.roll}
                min={-180}
                max={180}
                onChange={(next) => updateCorrectionAxis('roll', next)}
              />
              <SliderRow
                label="pitch"
                value={correction.pitch}
                min={-90}
                max={90}
                onChange={(next) => updateCorrectionAxis('pitch', next)}
              />
              <SliderRow
                label="yaw"
                value={correction.yaw}
                min={-180}
                max={180}
                onChange={(next) => updateCorrectionAxis('yaw', next)}
              />
              <div className="flex flex-wrap gap-1.5">
                <ChipButton onClick={lockCurrentView} title="把当前视角烘焙进校正参数">
                  <Lock className="h-3 w-3" /> 锁定当前视角
                </ChipButton>
              </div>
            </section>

            {/* 方向 */}
            <section className="flex flex-col gap-2">
              <header className="flex items-center justify-between gap-3 text-[11px] font-medium text-text-dark/72">
                <span>正前方</span>
                <span className="tabular-nums text-text-dark/64">{data.frontYawDeg.toFixed(1)}°</span>
              </header>
              <SliderRow
                label="front"
                value={data.frontYawDeg}
                min={-180}
                max={180}
                onChange={(next) => updateNodeData(id, { frontYawDeg: wrapDeg(next) })}
              />
              <div className="flex flex-wrap gap-1.5">
                <ChipButton onClick={setFrontYawFromView} title="把当前视角的 yaw 设为正前">
                  设为当前视角
                </ChipButton>
                {(['front', 'right', 'back', 'left', 'seam'] as const).map((dir) => (
                  <ChipButton key={dir} onClick={() => rotateToDirection(dir)}>
                    {dir}
                  </ChipButton>
                ))}
              </div>
            </section>

            {/* 小行星 / 截图 / 导出 */}
            <section className="flex flex-col gap-2">
              <header className="text-[11px] font-medium text-text-dark/72">效果与导出</header>
              <div className="flex flex-wrap gap-1.5">
                {planetBackup ? (
                  <ChipButton onClick={exitPlanet} tone="accent">
                    退出小行星
                  </ChipButton>
                ) : (
                  <ChipButton onClick={enterPlanet}>小行星模式</ChipButton>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <ChipButton onClick={copyCorrectionJson} title="把当前 frontYaw / 校正参数 / FOV 复制为 JSON">
                  <Save className="h-3 w-3" /> 复制校正 JSON
                </ChipButton>
              </div>
            </section>
          </div>
        ) : null}
      </div>

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
      />
      <NodeResizeHandle
        minWidth={900}
        minHeight={540}
        maxWidth={1600}
        maxHeight={1200}
      />
    </div>
  );
});

Pano360ViewerNode.displayName = 'Pano360ViewerNode';
