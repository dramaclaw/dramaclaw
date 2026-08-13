// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type SyntheticEvent,
} from 'react';
import {
  Handle,
  Position,
  useStore,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { Camera, Image as ImageIcon, Loader2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  EXPORT_RESULT_NODE_RESIZE_MIN_EDGE,
  type UploadImageNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveMinEdgeFittedSize,
  resolveResizeMinConstraintsByAspect,
} from '@/features/canvas/application/imageNodeSizing';
import {
  isNodeUsingDefaultDisplayName,
  resolveNodeDisplayName,
} from '@/features/canvas/domain/nodeDisplay';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { stashExternalFile } from '@/features/canvas/application/pendingExternalFiles';
import { useExternalFileHandoff } from '@/features/canvas/hooks/useExternalFileHandoff';
import { isVideoFile, VIDEO_FILE_ACCEPT } from '@/features/canvas/application/videoFileTypes';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import {
  CANVAS_NODE_INPUT_BODY_FRAME_CLASS,
  CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS,
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  CANVAS_NODE_PANEL_SURFACE_CLASS,
  canvasNodeFrameClass,
} from '@/features/canvas/ui/nodeFrameStyles';
import {
  prepareNodeImageFromFile,
  resolveImageDisplayUrl,
  shouldUseOriginalImageByZoom,
  withImageCacheBust,
} from '@/features/canvas/application/imageData';
import { uploadLocalImageToBackend } from '@/features/canvas/application/uploadToolOutput';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { DirectorControlBundleBadge } from '@/features/canvas/ui/DirectorControlBundleBadge';
import {
  NODE_SIDE_ACTION_BUTTON_CLASS,
  NODE_SIDE_ACTION_ICON_CLASS,
  NodeSideActionRail,
} from '@/features/canvas/ui/NodeSideActionRail';
import {
  CandidateBindingBadges,
  hasMainlineContexts,
} from '@/features/freezone/context/NodeContextBadges';
import { collectCandidateBindingsForNode } from '@/features/freezone/context/mainlineContext';
import { uploadFreezoneImage } from '@/api/ops';
import { getBeatDirectorStageManifest } from '@/api/viewerManifests';
import {
  ThreeDDirectorDialog,
  type ThreeDDirectorCaptureMeta,
} from '@/features/viewer-kit/three-d/ThreeDDirectorDialog';
import type { ThreeDSceneSnapshot } from '@/features/viewer-kit/three-d/engine/viewerApp';
import type {
  DirectorControlFrameBundle,
  DirectorStageManifest,
} from '@/features/viewer-kit/three-d/directorManifest';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from '@/stores/settingsStore';

type UploadNodeProps = NodeProps & {
  id: string;
  data: UploadImageNodeData;
  selected?: boolean;
};

function resolveNodeDimension(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.round(value);
  }
  return fallback;
}

function resolveDroppedMediaFile(event: DragEvent<HTMLElement>): File | null {
  const directFile = event.dataTransfer.files?.[0];
  if (directFile) {
    return directFile;
  }

  // items[].type 对 .mxf 等专业容器也是空串，先 MIME 粗筛（图片/音频），再对
  // 文件项用扩展名兜住无 MIME 的视频容器。
  const items = Array.from(event.dataTransfer.items || []).filter(
    (candidate) => candidate.kind === 'file',
  );
  for (const candidate of items) {
    if (
      candidate.type.startsWith('image/') ||
      candidate.type.startsWith('audio/')
    ) {
      return candidate.getAsFile();
    }
    const file = candidate.getAsFile();
    if (file && isVideoFile(file)) return file;
  }
  return null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('无法读取导演世界截图'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('无法读取导演世界截图'));
    reader.readAsDataURL(blob);
  });
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
    image.onerror = () => reject(new Error('无法解析导演世界截图尺寸'));
    image.src = dataUrl;
  });
}

function directorControlBundleFromData(value: unknown): DirectorControlFrameBundle | null {
  if (!value || typeof value !== 'object') return null;
  const bundle = value as Partial<DirectorControlFrameBundle>;
  if (bundle.schema_version !== 'director_control_bundle_v1') return null;
  return bundle as DirectorControlFrameBundle;
}

function resolveDirectorControlBundleSourceId(bundle: DirectorControlFrameBundle | null): string | null {
  const sourceId = bundle?.frame_meta?.source?.source_id ?? bundle?.source?.source_id;
  return typeof sourceId === 'string' && sourceId.trim() ? sourceId : null;
}

function numberTuple3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const next = value.slice(0, 3).map((item) => Number(item));
  return next.every((item) => Number.isFinite(item))
    ? [next[0], next[1], next[2]]
    : fallback;
}

function snapshotMarkerFromDirectorLayerItem(item: unknown): ThreeDSceneSnapshot["actors"][number] {
  const data = item && typeof item === 'object' ? item as Record<string, unknown> : {};
  const placementData = data.placement && typeof data.placement === 'object'
    ? data.placement as Record<string, unknown>
    : {};
  const placement = placementData.space === 'pano_view'
    ? {
        space: 'pano_view' as const,
        yawDeg: Number(placementData.yaw_deg ?? 0),
        pitchDeg: Number(placementData.pitch_deg ?? 0),
        distance: Number(placementData.distance ?? 6),
      }
    : {
        space: 'world' as const,
        position: numberTuple3(placementData.position, [0, 0, 0]),
        yawDeg: Number(placementData.yaw_deg ?? 0),
      };
  const position = placement.space === 'world' ? placement.position : [0, 0, 0] as [number, number, number];
  return {
    label: typeof data.label === 'string' ? data.label : '导演元素',
    color: typeof data.color === 'string' ? data.color : '#38bdf8',
    placement,
    position,
    yawDeg: placement.yawDeg,
    scale: numberTuple3(data.scale, [1, 1, 1]),
    ...(typeof data.pose === 'string' ? { pose: data.pose as never } : {}),
    ...(typeof data.action_playing === 'boolean' ? { actionPlaying: data.action_playing } : {}),
    ...(typeof data.shape_hint === 'string' ? { shapeHint: data.shape_hint as never } : {}),
  };
}

function sceneSnapshotFromDirectorControlBundle(
  bundle: DirectorControlFrameBundle | null,
): ThreeDSceneSnapshot | null {
  const frameMeta = bundle?.frame_meta;
  if (!frameMeta?.layer) return null;
  return {
    schemaVersion: 1,
    savedAt: Date.now(),
    actors: (frameMeta.layer.actors ?? []).map(snapshotMarkerFromDirectorLayerItem),
    props: (frameMeta.layer.props ?? []).map(snapshotMarkerFromDirectorLayerItem),
    stagings: (frameMeta.layer.stagings ?? []).map(snapshotMarkerFromDirectorLayerItem),
    world: { activeSourceId: resolveDirectorControlBundleSourceId(bundle) ?? undefined },
    camera: frameMeta.camera?.state as ThreeDSceneSnapshot["camera"],
  };
}

async function uploadDirectorCaptureBundle(
  projectId: string,
  nodeId: string,
  meta: NonNullable<ThreeDDirectorCaptureMeta["captureBundle"]>,
): Promise<DirectorControlFrameBundle> {
  const stamp = Date.now();
  const [combined, envOnly, frameMeta] = await Promise.all([
    uploadFreezoneImage(projectId, meta.combined, `director-world-${nodeId}-combined-${stamp}.png`, { timeoutMs: false }),
    uploadFreezoneImage(projectId, meta.env_only, `director-world-${nodeId}-env-only-${stamp}.png`, { timeoutMs: false }),
    uploadFreezoneImage(
      projectId,
      new Blob([JSON.stringify(meta.frame_meta)], { type: 'application/json' }),
      `director-world-${nodeId}-frame-meta-${stamp}.json`,
      { timeoutMs: false },
    ),
  ]);

  return {
    schema_version: "director_control_bundle_v1",
    dir: "freezone/director-world",
    paths: {
      combined: combined.filename,
      env_only: envOnly.filename,
      frame_meta: frameMeta.filename,
    },
    rel_paths: {
      combined: combined.filename,
      env_only: envOnly.filename,
      frame_meta: frameMeta.filename,
    },
    urls: {
      combined: combined.url,
      env_only: envOnly.url,
      frame_meta: frameMeta.url,
    },
    source: meta.frame_meta.source,
    frame_meta: meta.frame_meta,
  };
}

export const UploadNode = memo(({ id, data, selected, width, height }: UploadNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const convertNodeType = useCanvasStore((state) => state.convertNodeType);
  const addPanoCaptureGroup = useCanvasStore((state) => state.addPanoCaptureGroup);
  // 只订阅连到本节点的边(useShallow 逐元素比较),避免拖动无关节点触发重渲染。
  const connectedEdges = useCanvasStore(
    useShallow((state) => state.edges.filter((edge) => edge.source === id || edge.target === id)),
  );
  const useUploadFilenameAsNodeTitle = useSettingsStore((state) => state.useUploadFilenameAsNodeTitle);
  // 离散布尔订阅,缩放时仅在阈值翻转那帧重渲染,而非每帧。
  const preferOriginalImage = useStore((state) => shouldUseOriginalImageByZoom(state.transform[2]));
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadSequenceRef = useRef(0);
  const captureCanvasNodeBusyRef = useRef(false);
  const uploadPerfRef = useRef<{
    sequence: number;
    name: string;
    size: number;
    startedAt: number;
    transientLoaded: boolean;
    stableLoaded: boolean;
  } | null>(null);
  const [transientPreviewUrl, setTransientPreviewUrl] = useState<string | null>(null);
  const imageOnly = Boolean(data.imageOnly);
  const resolvedAspectRatio = data.aspectRatio || '1:1';
  const compactSize = resolveMinEdgeFittedSize(resolvedAspectRatio, {
    minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
    minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
  });
  const resolvedWidth = resolveNodeDimension(width, compactSize.width);
  const resolvedHeight = resolveNodeDimension(height, compactSize.height);
  const resizeConstraints = resolveResizeMinConstraintsByAspect(resolvedAspectRatio, {
    minWidth: EXPORT_RESULT_NODE_RESIZE_MIN_EDGE,
    minHeight: EXPORT_RESULT_NODE_RESIZE_MIN_EDGE,
  });
  const resizeMinWidth = resizeConstraints.minWidth;
  const resizeMinHeight = resizeConstraints.minHeight;
  const resolvedTitle = useMemo(() => {
    const sourceFileName = typeof data.sourceFileName === 'string' ? data.sourceFileName.trim() : '';
    if (
      useUploadFilenameAsNodeTitle
      && sourceFileName
      && isNodeUsingDefaultDisplayName(CANVAS_NODE_TYPES.upload, data)
    ) {
      return sourceFileName;
    }

    if (imageOnly && isNodeUsingDefaultDisplayName(CANVAS_NODE_TYPES.upload, data)) {
      return '上传图片';
    }
    return resolveNodeDisplayName(CANVAS_NODE_TYPES.upload, data);
  }, [data, imageOnly, useUploadFilenameAsNodeTitle]);
  const hasMainlineContext = hasMainlineContexts(
    (data as { mainline_context?: unknown }).mainline_context,
  );
  const candidateBindingRoles = useMemo(
    () => collectCandidateBindingsForNode(connectedEdges, id).map((binding) => binding.role),
    [connectedEdges, id],
  );
  const freezoneSource = (data.__freezone_source as
    | {
      role?: string;
      meta?: Record<string, unknown>;
      episode?: number;
      beat?: number;
    }
    | undefined) ?? undefined;
  const sourceRole = typeof freezoneSource?.role === "string" ? freezoneSource.role : "";
  const sourceMeta = (freezoneSource?.meta ?? {}) as Record<string, unknown>;
  const sourceEpisode =
    typeof sourceMeta.episode === "number"
      ? sourceMeta.episode
      : typeof freezoneSource?.episode === "number"
        ? freezoneSource.episode
        : null;
  const sourceBeat =
    typeof sourceMeta.beat === "number"
      ? sourceMeta.beat
      : typeof freezoneSource?.beat === "number"
        ? freezoneSource.beat
        : null;
  const canOpenDirectorStage = sourceRole === "director_combined"
    && sourceEpisode !== null
    && sourceBeat !== null;
  const [directorStageBusy, setDirectorStageBusy] = useState(false);
  const [directorStageOpen, setDirectorStageOpen] = useState(false);
  const [directorStageManifest, setDirectorStageManifest] = useState<DirectorStageManifest | null>(null);
  const directorControlBundle = useMemo(
    () => directorControlBundleFromData(data.director_control_bundle),
    [data.director_control_bundle],
  );
  const directorInitialScene = useMemo(
    () => sceneSnapshotFromDirectorControlBundle(directorControlBundle),
    [directorControlBundle],
  );
  const directorInitialSourceId = directorInitialScene?.world?.activeSourceId;

  const clearTransientPreview = useCallback(() => {
    setTransientPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
  }, []);

  const processFile = useCallback(
    async (file: File) => {
      const projectId = readUrl().project;
      if (!projectId) {
        console.error('[upload-node] no project in URL — cannot upload');
        return;
      }

      const sequence = uploadSequenceRef.current + 1;
      uploadSequenceRef.current = sequence;
      const started = performance.now();
      clearTransientPreview();
      const optimisticPreviewUrl = URL.createObjectURL(file);
      setTransientPreviewUrl(optimisticPreviewUrl);
      uploadPerfRef.current = {
        sequence,
        name: file.name,
        size: file.size,
        startedAt: started,
        transientLoaded: false,
        stableLoaded: false,
      };
      requestAnimationFrame(() => {
        const perf = uploadPerfRef.current;
        if (!perf || perf.sequence !== sequence) {
          return;
        }
        console.info(
          `[upload-perf][e2e] preview-state-committed nodeId=${id} name="${file.name}" elapsed=${Math.round(performance.now() - started)}ms`
        );
      });

      updateNodeData(id, { isUploading: true, uploadError: null });

      try {
        // Local prep is best-effort: it gives us aspect ratio + a small preview
        // URL for instant display. Backend upload is the authoritative source
        // for `imageUrl` — downstream nodes need a real http(s) URL.
        const [preparedSettled, uploaded] = await Promise.all([
          prepareNodeImageFromFile(file).catch((err: unknown) => {
            console.warn('[upload-node] local prepare failed, continuing with backend URL only', err);
            return null;
          }),
          uploadFreezoneImage(projectId, file, file.name),
        ]);

        if (uploadSequenceRef.current !== sequence) {
          return;
        }

        const nextData: Partial<UploadImageNodeData> = {
          imageUrl: uploaded.url,
          // Always mirror the uploaded URL — preparedSettled.previewImageUrl
          // is a base64 data URL on the web (persistImageLocally is a
          // passthrough), and persisting that would bloat PUT /default.
          // transientPreviewUrl already covers instant pre-upload display.
          previewImageUrl: uploaded.url,
          aspectRatio: preparedSettled?.aspectRatio || '1:1',
          sourceFileName: file.name,
          isUploading: false,
          uploadError: null,
        };
        if (useUploadFilenameAsNodeTitle) {
          nextData.displayName = file.name;
        }
        updateNodeData(id, nextData);

        console.info(
          `[upload-perf][node] processFile success nodeId=${id} name="${file.name}" size=${file.size}B backendUrl=${uploaded.url} elapsed=${Math.round(performance.now() - started)}ms`
        );
      } catch (error) {
        if (uploadSequenceRef.current === sequence) {
          clearTransientPreview();
          const message = error instanceof Error ? error.message : String(error);
          updateNodeData(id, { isUploading: false, uploadError: message });
        }
        console.error(
          `[upload-perf][node] processFile failed nodeId=${id} name="${file.name}" size=${file.size}B elapsed=${Math.round(performance.now() - started)}ms`,
          error
        );
      }
    },
    [clearTransientPreview, id, updateNodeData, useUploadFilenameAsNodeTitle]
  );

  const handleImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const perf = uploadPerfRef.current;
    if (!perf) {
      return;
    }

    const displayedSrc = event.currentTarget.currentSrc || event.currentTarget.src || '';
    const isTransient = displayedSrc.startsWith('blob:');
    const now = performance.now();

    if (isTransient && !perf.transientLoaded) {
      perf.transientLoaded = true;
      console.info(
        `[upload-perf][e2e] first-visible transient nodeId=${id} name="${perf.name}" size=${perf.size}B elapsed=${Math.round(now - perf.startedAt)}ms`
      );
      requestAnimationFrame(() => {
        const nextPerf = uploadPerfRef.current;
        if (!nextPerf || nextPerf.sequence !== perf.sequence) {
          return;
        }
        console.info(
          `[upload-perf][e2e] first-painted transient nodeId=${id} name="${nextPerf.name}" elapsed=${Math.round(performance.now() - nextPerf.startedAt)}ms`
        );
      });
      return;
    }

    if (!isTransient && !perf.stableLoaded) {
      perf.stableLoaded = true;
      console.info(
        `[upload-perf][e2e] stable-visible nodeId=${id} name="${perf.name}" size=${perf.size}B elapsed=${Math.round(now - perf.startedAt)}ms`
      );
      if (uploadSequenceRef.current === perf.sequence) {
        clearTransientPreview();
      }
      requestAnimationFrame(() => {
        const nextPerf = uploadPerfRef.current;
        if (!nextPerf || nextPerf.sequence !== perf.sequence) {
          return;
        }
        console.info(
          `[upload-perf][e2e] stable-painted nodeId=${id} name="${nextPerf.name}" elapsed=${Math.round(performance.now() - nextPerf.startedAt)}ms`
        );
      });
    }
  }, [clearTransientPreview, id]);

  /**
   * Switch this upload node into a video node and hand the file off to the
   * VideoNode's processFile via the canvas event bus. Same id + position, so
   * any edges already connected to this node survive intact.
   */
  const morphToVideoWithFile = useCallback(
    (file: File) => {
      const ok = convertNodeType(id, CANVAS_NODE_TYPES.video, {
        referenceOnly: true,
        sourceFileName: file.name,
      });
      if (!ok) return;
      // File 走暂存、事件只是敲一下：变形后的 video 节点在低缩放档同样先以 LOD
      // shell 挂载，晚于下面这一帧才挂上订阅（见 [[pendingExternalFiles]]）。
      stashExternalFile('video-node/external-file', id, file);
      requestAnimationFrame(() => {
        canvasEventBus.publish('video-node/external-file', { nodeId: id, file });
      });
    },
    [convertNodeType, id]
  );

  /**
   * Switch this upload node into an audio node and hand the file off to the
   * AudioNode's upload flow via the canvas event bus. Same id + position, so
   * any edges already connected to this node survive intact.
   */
  const morphToAudioWithFile = useCallback(
    (file: File) => {
      const ok = convertNodeType(id, CANVAS_NODE_TYPES.audio, {
        sourceFileName: file.name,
      });
      if (!ok) return;
      // 同 morphToVideoWithFile：File 走暂存，事件只是敲一下。
      stashExternalFile('audio-node/external-file', id, file);
      requestAnimationFrame(() => {
        canvasEventBus.publish('audio-node/external-file', { nodeId: id, file });
      });
    },
    [convertNodeType, id]
  );

  const handleMediaFile = useCallback(
    async (file: File) => {
      // isVideoFile 兜住 .mxf 等 file.type 为空串的容器，避免落到最后被忽略。
      if (isVideoFile(file)) {
        if (imageOnly) {
          console.warn('[upload-node] image-only node: dropped video ignored');
          return;
        }
        morphToVideoWithFile(file);
        return;
      }
      if (file.type.startsWith('audio/')) {
        if (imageOnly) {
          console.warn('[upload-node] image-only node: dropped audio ignored');
          return;
        }
        morphToAudioWithFile(file);
        return;
      }
      if (file.type.startsWith('image/')) {
        await processFile(file);
      }
    },
    [imageOnly, morphToAudioWithFile, morphToVideoWithFile, processFile]
  );

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const file = resolveDroppedMediaFile(event);
      if (!file) {
        return;
      }
      await handleMediaFile(file);
    },
    [handleMediaFile]
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      await handleMediaFile(file);
      event.target.value = '';
    },
    [handleMediaFile]
  );

  useEffect(() => {
    return canvasEventBus.subscribe('upload-node/reupload', ({ nodeId }) => {
      if (nodeId !== id) {
        return;
      }
      inputRef.current?.click();
    });
  }, [id]);

  useEffect(() => {
    return canvasEventBus.subscribe('upload-node/paste-image', ({ nodeId, file }) => {
      if (nodeId !== id || !file.type.startsWith('image/')) {
        return;
      }
      void processFile(file);
    });
  }, [id, processFile]);

  const consumeExternalFile = useCallback(
    (file: File) => {
      void handleMediaFile(file);
    },
    [handleMediaFile],
  );
  // File 本体走 pendingExternalFiles 暂存、挂载时补投 —— 低缩放档下本节点先以 LOD
  // shell 挂载，只订阅事件会漏掉投递（见 useExternalFileHandoff）。
  useExternalFileHandoff('upload-node/external-file', id, consumeExternalFile);

  const handleNodeClick = useCallback(() => {
    setSelectedNode(id);
  }, [id, setSelectedNode]);

  const handlePickFile = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleOpenDirectorStage = useCallback(async () => {
    if (!canOpenDirectorStage) return;
    const projectId = readUrl().project;
    if (!projectId || sourceEpisode === null || sourceBeat === null) return;
    setDirectorStageBusy(true);
    try {
      const manifest = await getBeatDirectorStageManifest(projectId, sourceEpisode, sourceBeat);
      const directorControlBundleSourceId = resolveDirectorControlBundleSourceId(directorControlBundle);
      const allowedDestinations = manifest.allowed_destinations.includes("canvas_screenshot_node")
        ? manifest.allowed_destinations
        : [...manifest.allowed_destinations, "canvas_screenshot_node" as const];
      setDirectorStageManifest(
        directorControlBundleSourceId
          ? { ...manifest, allowed_destinations: allowedDestinations, active_source_id: directorControlBundleSourceId }
          : { ...manifest, allowed_destinations: allowedDestinations },
      );
      setDirectorStageOpen(true);
    } catch (error) {
      console.error('[upload-node] director world manifest failed', error);
    } finally {
      setDirectorStageBusy(false);
    }
  }, [canOpenDirectorStage, directorControlBundle, sourceBeat, sourceEpisode]);

  const handleDirectorCaptureCombined = useCallback(
    async (_blob: Blob, meta: ThreeDDirectorCaptureMeta) => {
      const projectId = readUrl().project;
      if (!meta.captureBundle) {
        throw new Error('导演合成图缺少 combined/env_only/frame_meta');
      }
      if (!projectId) {
        throw new Error('缺少项目，无法保存画布导演合成图');
      }
      const bundle = await uploadDirectorCaptureBundle(projectId, id, meta.captureBundle);
      const imageUrl = bundle.urls?.combined ?? '';
      if (!imageUrl) throw new Error('画布导演合成图缺少图片地址');
      updateNodeData(id, {
        imageUrl,
        previewImageUrl: withImageCacheBust(imageUrl, Date.now()),
        director_control_bundle: bundle,
        slot_target: {
          kind: 'director_render',
          episode: sourceEpisode,
          beat: sourceBeat,
        },
        uploadError: null,
      });
    },
    [id, sourceBeat, sourceEpisode, updateNodeData],
  );

  const handleDirectorOutputCanvasNode = useCallback(
    async (blob: Blob, meta: ThreeDDirectorCaptureMeta) => {
      if (captureCanvasNodeBusyRef.current) return;
      captureCanvasNodeBusyRef.current = true;
      try {
        const projectId = readUrl().project;
        if (projectId && meta.captureBundle) {
          const bundle = await uploadDirectorCaptureBundle(projectId, id, meta.captureBundle);
          const [combinedDataUrl, envOnlyDataUrl] = await Promise.all([
            blobToDataUrl(meta.captureBundle.combined),
            blobToDataUrl(meta.captureBundle.env_only),
          ]);
          const [combinedSize, envOnlySize] = await Promise.all([
            imageSize(combinedDataUrl),
            imageSize(envOnlyDataUrl),
          ]);
          const baseMetadata = {
            viewer: 'director_world',
            source_kind: meta.source.source_kind,
            snapshot: meta.snapshot,
            director_control_bundle: bundle,
          };
          const groupId = addPanoCaptureGroup(
            id,
            [
              {
                dataUrl: combinedDataUrl,
                uploadedUrl: bundle.urls?.combined ?? '',
                width: combinedSize.width,
                height: combinedSize.height,
                label: '导演合成图',
                metadata: {
                  ...baseMetadata,
                  render_mode: 'combined',
                },
              },
              {
                dataUrl: envOnlyDataUrl,
                uploadedUrl: bundle.urls?.env_only ?? '',
                width: envOnlySize.width,
                height: envOnlySize.height,
                label: '纯背景图',
                metadata: {
                  ...baseMetadata,
                  render_mode: 'env_only',
                },
              },
            ],
            { cols: 2, groupName: '导演世界输出' },
          );
          updateNodeData(id, {
            uploadError: groupId ? null : '导演世界截图输出到画布失败',
          });
          if (groupId) {
            toast.success(t('viewer.threeD.outputToCanvasNodeSuccess'));
          }
          return;
        }
        const dataUrl = await blobToDataUrl(blob);
        const size = await imageSize(dataUrl);
        const uploadedUrl = await uploadLocalImageToBackend(
          dataUrl,
          `director-world-${id}-combined-${Date.now()}.png`,
        );
        const groupId = addPanoCaptureGroup(id, [
          {
            dataUrl,
            uploadedUrl,
            width: size.width,
            height: size.height,
            label: '导演世界导出',
            metadata: {
              viewer: 'director_world',
              render_mode: meta.kind,
              source_kind: meta.source.source_kind,
              snapshot: meta.snapshot,
            },
          },
        ]);
        updateNodeData(id, {
          uploadError: groupId ? null : '导演世界截图输出到画布失败',
        });
        if (groupId) {
          toast.success(t('viewer.threeD.outputToCanvasNodeSuccess'));
        }
      } finally {
        captureCanvasNodeBusyRef.current = false;
      }
    },
    [addPanoCaptureGroup, id, t, updateNodeData],
  );

  useEffect(() => () => {
    uploadPerfRef.current = null;
    clearTransientPreview();
  }, [clearTransientPreview]);

  const imageSource = useMemo(() => {
    if (transientPreviewUrl) {
      return transientPreviewUrl;
    }
    const picked = preferOriginalImage
      ? data.imageUrl || data.previewImageUrl
      : data.previewImageUrl || data.imageUrl;
    return picked
      ? resolveImageDisplayUrl(withImageCacheBust(picked, data.committed_at))
      : null;
  }, [data.committed_at, data.imageUrl, data.previewImageUrl, transientPreviewUrl, preferOriginalImage]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  const hasMediaContent = Boolean(data.imageUrl || transientPreviewUrl);
  const frameToneClass = hasMediaContent
    ? canvasNodeFrameClass({ selected, mainline: hasMainlineContext })
    : selected
      ? CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS
      : CANVAS_NODE_INPUT_BODY_FRAME_CLASS;
  const surfaceClass = hasMediaContent
    ? CANVAS_NODE_PANEL_SURFACE_CLASS
    : CANVAS_NODE_INPUT_SURFACE_CLASS;

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border ${surfaceClass} p-0 transition-colors duration-150
        ${frameToneClass}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={handleNodeClick}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={imageOnly || hasMainlineContext
          ? <ImageIcon className="h-4 w-4" />
          : <Upload className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />
      <CandidateBindingBadges roles={candidateBindingRoles} />

      {!data.imageUrl && !transientPreviewUrl && (
        <NodeSideActionRail nodeId={id}>
          <button
            type="button"
            disabled={Boolean(data.isUploading)}
            onClick={(event) => {
              event.stopPropagation();
              handlePickFile();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            title={imageOnly ? '上传图片' : (t('node.upload.hint') ?? '上传资源')}
            className={NODE_SIDE_ACTION_BUTTON_CLASS}
          >
            {data.isUploading ? (
              <Loader2 className={`${NODE_SIDE_ACTION_ICON_CLASS} animate-spin`} />
            ) : (
              <Upload className={NODE_SIDE_ACTION_ICON_CLASS} />
            )}
            <span>{data.isUploading ? '上传中' : imageOnly ? '上传图片' : '上传资源'}</span>
          </button>
        </NodeSideActionRail>
      )}

      {data.imageUrl || transientPreviewUrl ? (
        <div
          className="relative block h-full w-full overflow-hidden rounded-[var(--node-radius)] bg-bg-dark"
        >
          <DirectorControlBundleBadge bundle={(data as { director_control_bundle?: unknown }).director_control_bundle} />
          <CanvasNodeImage
            src={imageSource ?? ''}
            viewerSourceUrl={data.imageUrl ? resolveImageDisplayUrl(data.imageUrl) : null}
            alt={t('node.upload.uploadedAlt')}
            className="h-full w-full object-contain"
            onLoad={handleImageLoad}
          />
        </div>
      ) : (
        <div
          className="block h-full w-full overflow-hidden rounded-[var(--node-radius)] bg-transparent"
        >
          <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-2 text-text-muted/85">
            <Upload className="h-7 w-7 opacity-60" />
            <span className="px-3 text-center text-[12px] leading-6">{t('node.upload.hint')}</span>
          </div>
        </div>
      )}

      {selected && canOpenDirectorStage && (
        <button
          type="button"
          disabled={directorStageBusy}
          onClick={(event) => {
            event.stopPropagation();
            void handleOpenDirectorStage();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          title={t("viewer.threeD.openDirectorWorldTitle")}
          className="nodrag absolute bottom-2 right-2 z-[6] inline-flex h-7 items-center gap-1.5 rounded-md border border-sky-300/55 bg-[rgba(15,67,107,0.82)] px-2.5 text-[11px] font-medium text-sky-100 shadow-[0_0_0_1px_rgba(0,0,0,0.45)] transition-colors hover:bg-[rgba(22,90,140,0.9)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {directorStageBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Camera className="h-3.5 w-3.5" />
          )}
          <span>{t("viewer.threeD.directorWorld")}</span>
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={imageOnly ? 'image/*' : `image/*,${VIDEO_FILE_ACCEPT},audio/*`}
        className="hidden"
        onChange={handleFileChange}
      />

      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
      />
      <NodeResizeHandle
        minWidth={resizeMinWidth}
        minHeight={resizeMinHeight}
        maxWidth={1400}
        maxHeight={1400}
        keepAspectRatio
      />
      {canOpenDirectorStage && (
        <ThreeDDirectorDialog
          open={directorStageOpen}
          onOpenChange={setDirectorStageOpen}
          manifest={directorStageManifest}
          title={t("viewer.threeD.beatDirectorWorld")}
          description={t("viewer.threeD.beatDirectorWorldDescription")}
          viewerPurpose="beat"
          onSubmitDirectorCombined={handleDirectorCaptureCombined}
          onCaptureCanvasNode={handleDirectorOutputCanvasNode}
          initialScene={directorInitialScene}
          initialScenesBySourceId={
            directorInitialScene && directorInitialSourceId
              ? { [directorInitialSourceId]: directorInitialScene }
              : null
          }
        />
      )}
    </div>
  );
});

UploadNode.displayName = 'UploadNode';
