// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Viewer, CONSTANTS } from "@photo-sphere-viewer/core";
import "@photo-sphere-viewer/core/index.css";
import { Camera, Loader2, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ViewerPurpose } from "../viewerPurpose";
import { viewerPurposeLabel } from "../viewerPurpose";
import type { PanoCaptureResult, PanoCaptureSaveResult, PanoViewerManifest } from "./panoManifest";
import {
  FOV_MAX,
  FOV_MIN,
  PANO_CAPTURE_ASPECTS,
  type PanoCaptureAspect,
  cropCanvasToAspect,
  cropCanvasToFrame,
  fovToFocal,
  fovToZoom,
  normalizePanoDegrees,
  panoCorrectionConfig,
  type PanoCropFrame,
  radiansToDegrees,
  waitFrames,
  zoomToFov,
} from "./panoCapture";

const { ROTATE_UP, ROTATE_DOWN, ROTATE_LEFT, ROTATE_RIGHT, ZOOM_IN, ZOOM_OUT } =
  CONSTANTS.ACTIONS;

const DEG_TO_RAD = Math.PI / 180;
const FOV_PRESETS = [
  { key: "fisheye", value: 160 },
  { key: "wide", value: 120 },
  { key: "standard", value: 70 },
  { key: "tele", value: 8 },
] as const;
const DIRECTION_OFFSETS = {
  Front: 0,
  Right: 90,
  Back: 180,
  Left: -90,
  Seam: -180,
} as const;
const NUMBER_INPUT_CLASS =
  "h-7 w-16 rounded-md border border-border bg-card px-2 text-right tabular-nums text-foreground";

type PanoViewerWithEvents = Viewer & {
  addEventListener?: (
    eventName: "position-updated" | "zoom-updated",
    handler: () => void,
  ) => void;
};

interface PanoCaptureSurfaceProps {
  manifest: PanoViewerManifest;
  className?: string;
  captureLabel?: string;
  viewerPurpose?: ViewerPurpose;
  onCapture: (result: PanoCaptureResult) => void | PanoCaptureSaveResult | Promise<void | PanoCaptureSaveResult>;
  onSaveCorrection?: (correction: PanoViewerManifest["correction"]) => void | Promise<void>;
  onClose?: () => void;
}

interface PanoOverlayBounds {
  width: number;
  height: number;
}

interface PanoFrameInteraction {
  mode: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  frame: PanoCropFrame;
}

interface PanoCaptureHistoryItem {
  id: number;
  url: string;
  width: number;
  height: number;
  aspect: PanoCaptureAspect;
  yawDeg: number;
  pitchDeg: number;
  fovDeg: number;
}

function aspectToWh(aspect: PanoCaptureAspect): [number, number] {
  switch (aspect) {
    case "16:9":
      return [16, 9];
    case "4:3":
      return [4, 3];
    case "1:1":
      return [1, 1];
    case "9:16":
      return [9, 16];
    case "2:3":
      return [2, 3];
  }
}

function roundDegrees(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sphereCorrectionOption(correction: PanoViewerManifest["correction"]["sphere_correction_deg"]) {
  return {
    roll: correction.roll * DEG_TO_RAD,
    tilt: correction.pitch * DEG_TO_RAD,
    pan: correction.yaw * DEG_TO_RAD,
  };
}

export function panoCaptureOverlayStyle(
  aspect: PanoCaptureAspect,
  bounds: PanoOverlayBounds | null,
  frame?: PanoCropFrame | null,
): CSSProperties {
  const [aspectWidth, aspectHeight] = aspectToWh(aspect);
  const aspectRatio = `${aspectWidth} / ${aspectHeight}`;

  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return {
      aspectRatio,
      width: "calc(100% - 48px)",
      maxHeight: "calc(100% - 48px)",
    };
  }

  const rect = frame ?? panoCaptureOverlayRect(aspect, bounds);
  return {
    aspectRatio,
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

export function panoCaptureOverlayRect(
  aspect: PanoCaptureAspect,
  bounds: PanoOverlayBounds,
): PanoCropFrame {
  const [aspectWidth, aspectHeight] = aspectToWh(aspect);
  const ratio = aspectWidth / aspectHeight;
  const maxWidth = Math.max(1, bounds.width - 48);
  const maxHeight = Math.max(1, bounds.height - 48);
  let width = maxWidth;
  let height = width / ratio;

  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }

  return {
    x: Math.round((bounds.width - width) / 2),
    y: Math.round((bounds.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function resizePanoCaptureFrame(
  frame: PanoCropFrame,
  bounds: PanoOverlayBounds,
  aspect: PanoCaptureAspect,
  scale: number,
): PanoCropFrame {
  const [aspectWidth, aspectHeight] = aspectToWh(aspect);
  const ratio = aspectWidth / aspectHeight;
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  const maxWidth = Math.max(1, bounds.width);
  const maxHeight = Math.max(1, bounds.height);
  const minWidth = 80;
  let width = Math.max(minWidth, Math.min(maxWidth, frame.width * scale));
  let height = width / ratio;

  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }

  const x = Math.max(0, Math.min(maxWidth - width, centerX - width / 2));
  const y = Math.max(0, Math.min(maxHeight - height, centerY - height / 2));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function PanoCaptureSurface({
  manifest,
  className,
  captureLabel,
  viewerPurpose,
  onCapture,
  onSaveCorrection,
  onClose,
}: PanoCaptureSurfaceProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cropFrameElementRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const cameraFrameRef = useRef<number | null>(null);
  const frameInteractionRef = useRef<PanoFrameInteraction | null>(null);
  const captureHistoryRef = useRef<PanoCaptureHistoryItem[]>([]);
  const captureIdRef = useRef(0);
  const [aspect, setAspect] = useState<PanoCaptureAspect>("16:9");
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [overlayBounds, setOverlayBounds] = useState<PanoOverlayBounds | null>(null);
  const [cropFrame, setCropFrame] = useState<PanoCropFrame | null>(null);
  const [captureHistory, setCaptureHistory] = useState<PanoCaptureHistoryItem[]>([]);
  const [saveResult, setSaveResult] = useState<(PanoCaptureSaveResult & { width: number; height: number }) | null>(null);
  const [liveCamera, setLiveCamera] = useState(() => ({
    yawDeg: manifest.correction.front_yaw_deg || 0,
    pitchDeg: 0,
    fovDeg: zoomToFov(45),
  }));
  const [planetBackup, setPlanetBackup] = useState<{
    fovDeg: number;
    yawDeg: number;
    pitchDeg: number;
  } | null>(null);
  const [frontYawDeg, setFrontYawDeg] = useState(manifest.correction.front_yaw_deg || 0);
  const [sphereCorrection, setSphereCorrection] = useState(manifest.correction.sphere_correction_deg);
  const correction = useMemo(
    () => panoCorrectionConfig(manifest),
    [
      manifest.correction.front_yaw_deg,
      manifest.correction.sphere_correction_deg.pitch,
      manifest.correction.sphere_correction_deg.roll,
      manifest.correction.sphere_correction_deg.yaw,
    ],
  );

  useEffect(() => {
    setFrontYawDeg(manifest.correction.front_yaw_deg || 0);
    setSphereCorrection(manifest.correction.sphere_correction_deg);
    setLiveCamera({
      yawDeg: manifest.correction.front_yaw_deg || 0,
      pitchDeg: 0,
      fovDeg: zoomToFov(45),
    });
    setPlanetBackup(null);
  }, [
    manifest.correction.front_yaw_deg,
    manifest.correction.sphere_correction_deg.pitch,
    manifest.correction.sphere_correction_deg.roll,
    manifest.correction.sphere_correction_deg.yaw,
  ]);

  const refreshLiveCamera = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const position = viewer.getPosition();
    setLiveCamera({
      yawDeg: radiansToDegrees(position.yaw),
      pitchDeg: radiansToDegrees(position.pitch),
      fovDeg: zoomToFov(viewer.getZoomLevel()),
    });
  }, []);

  const scheduleLiveCameraRefresh = useCallback(() => {
    if (cameraFrameRef.current !== null) return;
    cameraFrameRef.current = requestAnimationFrame(() => {
      cameraFrameRef.current = null;
      refreshLiveCamera();
    });
  }, [refreshLiveCamera]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    const updateBounds = () => {
      const rect = viewport.getBoundingClientRect();
      setOverlayBounds({ width: rect.width, height: rect.height });
    };
    updateBounds();

    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(updateBounds);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!overlayBounds) return;
    setCropFrame(panoCaptureOverlayRect(aspect, overlayBounds));
  }, [aspect, overlayBounds]);

  useEffect(() => {
    return () => {
      captureHistoryRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, []);

  const clearCaptureHistory = useCallback(() => {
    captureHistoryRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    captureHistoryRef.current = [];
    setCaptureHistory([]);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !manifest.source.url) {
      return undefined;
    }
    let cancelled = false;
    let viewer: Viewer | null = null;
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        viewer = new Viewer({
          container: host,
          panorama: manifest.source.url,
          navbar: ["zoom", "move", "fullscreen"],
          defaultYaw: correction.defaultYaw,
          defaultPitch: "0deg",
          defaultZoomLvl: 45,
          minFov: FOV_MIN,
          maxFov: FOV_MAX,
          sphereCorrection: correction.sphereCorrection,
          mousemove: true,
          mousewheel: true,
          keyboard: "always",
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
            "+": ZOOM_IN,
            "-": ZOOM_OUT,
          },
          rendererParameters: { preserveDrawingBuffer: true },
        });
        viewerRef.current = viewer;
        const position = viewer.getPosition();
        setLiveCamera({
          yawDeg: radiansToDegrees(position.yaw),
          pitchDeg: radiansToDegrees(position.pitch),
          fovDeg: zoomToFov(viewer.getZoomLevel()),
        });
        (viewer as PanoViewerWithEvents).addEventListener?.(
          "position-updated",
          scheduleLiveCameraRefresh,
        );
        (viewer as PanoViewerWithEvents).addEventListener?.(
          "zoom-updated",
          scheduleLiveCameraRefresh,
        );
        setViewerError(null);
      } catch (error) {
        setViewerError(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (viewerRef.current === viewer) {
        viewerRef.current = null;
      }
      if (cameraFrameRef.current !== null) {
        cancelAnimationFrame(cameraFrameRef.current);
        cameraFrameRef.current = null;
      }
      viewer?.destroy();
    };
  }, [correction, manifest.source.url, scheduleLiveCameraRefresh]);

  const resetView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.animate({
      yaw: `${frontYawDeg}deg`,
      pitch: "0deg",
      zoom: 45,
      speed: 250,
    });
    setLiveCamera({
      yawDeg: frontYawDeg,
      pitchDeg: 0,
      fovDeg: zoomToFov(45),
    });
    setPlanetBackup(null);
  }, [frontYawDeg]);

  const setFovDeg = useCallback(
    (next: number) => {
      const clamped = Math.max(FOV_MIN, Math.min(FOV_MAX, next));
      viewerRef.current?.zoom(fovToZoom(clamped));
      setLiveCamera((prev) => ({ ...prev, fovDeg: clamped }));
    },
    [],
  );

  const enterPlanetView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const position = viewer.getPosition();
    setPlanetBackup({
      fovDeg: zoomToFov(viewer.getZoomLevel()),
      yawDeg: radiansToDegrees(position.yaw),
      pitchDeg: radiansToDegrees(position.pitch),
    });
    setFovDeg(160);
    viewer.rotate({ yaw: 0, pitch: -Math.PI / 2 });
    setLiveCamera({ yawDeg: 0, pitchDeg: -90, fovDeg: 160 });
  }, [setFovDeg]);

  const exitPlanetView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || !planetBackup) return;
    setFovDeg(planetBackup.fovDeg);
    viewer.rotate({
      yaw: planetBackup.yawDeg * DEG_TO_RAD,
      pitch: planetBackup.pitchDeg * DEG_TO_RAD,
    });
    setLiveCamera(planetBackup);
    setPlanetBackup(null);
  }, [planetBackup, setFovDeg]);

  const beginFrameInteraction = useCallback(
    (mode: PanoFrameInteraction["mode"], event: ReactPointerEvent<HTMLDivElement>) => {
      if (!cropFrame) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      frameInteractionRef.current = {
        mode,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        frame: cropFrame,
      };
    },
    [cropFrame],
  );

  const moveFrameInteraction = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const interaction = frameInteractionRef.current;
      if (!interaction || !overlayBounds) return;
      event.preventDefault();
      event.stopPropagation();
      const dx = event.clientX - interaction.startX;
      const dy = event.clientY - interaction.startY;
      if (interaction.mode === "move") {
        setCropFrame({
          ...interaction.frame,
          x: Math.max(0, Math.min(overlayBounds.width - interaction.frame.width, interaction.frame.x + dx)),
          y: Math.max(0, Math.min(overlayBounds.height - interaction.frame.height, interaction.frame.y + dy)),
        });
        return;
      }

      const [aspectWidth, aspectHeight] = aspectToWh(aspect);
      const ratio = aspectWidth / aspectHeight;
      const minWidth = 80;
      const deltaWidth = Math.max(dx, dy * ratio);
      let width = Math.max(
        minWidth,
        Math.min(overlayBounds.width - interaction.frame.x, interaction.frame.width + deltaWidth),
      );
      let height = width / ratio;
      if (height > overlayBounds.height - interaction.frame.y) {
        height = overlayBounds.height - interaction.frame.y;
        width = height * ratio;
      }
      setCropFrame({
        ...interaction.frame,
        width: Math.round(width),
        height: Math.round(height),
      });
    },
    [aspect, overlayBounds],
  );

  const endFrameInteraction = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = frameInteractionRef.current;
    if (!interaction) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.releasePointerCapture(interaction.pointerId);
    frameInteractionRef.current = null;
  }, []);

  const resetCropFrame = useCallback(() => {
    if (!overlayBounds) return;
    setCropFrame(panoCaptureOverlayRect(aspect, overlayBounds));
  }, [aspect, overlayBounds]);

  const zoomCropFrame = useCallback(
    (event: WheelEvent) => {
      if (!cropFrame || !overlayBounds) return;
      event.preventDefault();
      event.stopPropagation();
      setCropFrame(
        resizePanoCaptureFrame(cropFrame, overlayBounds, aspect, event.deltaY < 0 ? 1.08 : 0.92),
      );
    },
    [aspect, cropFrame, overlayBounds],
  );

  useEffect(() => {
    const frame = cropFrameElementRef.current;
    if (!frame) return undefined;
    frame.addEventListener("wheel", zoomCropFrame, { passive: false });
    return () => frame.removeEventListener("wheel", zoomCropFrame);
  }, [zoomCropFrame]);

  const setFrontYaw = useCallback((next: number) => {
    setFrontYawDeg(roundDegrees(normalizePanoDegrees(next)));
  }, []);

  const applySphereCorrection = useCallback(
    (next: PanoViewerManifest["correction"]["sphere_correction_deg"]) => {
      const normalized = {
        roll: roundDegrees(normalizePanoDegrees(next.roll)),
        pitch: roundDegrees(Math.max(-90, Math.min(90, next.pitch))),
        yaw: roundDegrees(normalizePanoDegrees(next.yaw)),
      };
      setSphereCorrection(normalized);
      viewerRef.current?.setOption("sphereCorrection", sphereCorrectionOption(normalized));
    },
    [],
  );

  const updateSphereCorrection = useCallback(
    (axis: keyof PanoViewerManifest["correction"]["sphere_correction_deg"], next: number) => {
      applySphereCorrection({ ...sphereCorrection, [axis]: next });
    },
    [applySphereCorrection, sphereCorrection],
  );

  const resetSphereCorrection = useCallback(() => {
    applySphereCorrection({ roll: 0, pitch: 0, yaw: 0 });
  }, [applySphereCorrection]);

  const rotateToDirection = useCallback((direction: keyof typeof DIRECTION_OFFSETS) => {
    const yawDeg = normalizePanoDegrees(
      frontYawDeg + DIRECTION_OFFSETS[direction],
    );
    viewerRef.current?.rotate({
      yaw: yawDeg * DEG_TO_RAD,
      pitch: 0,
    });
    setLiveCamera((prev) => ({ ...prev, yawDeg, pitchDeg: 0 }));
  }, [frontYawDeg]);

  const setFrontYawFromView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    setFrontYaw(radiansToDegrees(viewer.getPosition().yaw));
  }, [setFrontYaw]);

  const lockCurrentView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const position = viewer.getPosition();
    const nextCorrection = {
      roll: roundDegrees(sphereCorrection.roll),
      pitch: roundDegrees(
        Math.max(-90, Math.min(90, sphereCorrection.pitch + radiansToDegrees(position.pitch))),
      ),
      yaw: roundDegrees(normalizePanoDegrees(sphereCorrection.yaw + radiansToDegrees(position.yaw))),
    };
    applySphereCorrection(nextCorrection);
    viewer.rotate({ yaw: 0, pitch: 0 });
    setLiveCamera((prev) => ({ ...prev, yawDeg: 0, pitchDeg: 0 }));
  }, [applySphereCorrection, sphereCorrection]);

  const copyCorrectionJson = useCallback(async () => {
    const payload = {
      project: manifest.project,
      scene_id: manifest.scene_id,
      mode: manifest.mode,
      source: manifest.source,
      front_yaw_deg: roundDegrees(frontYawDeg),
      sphere_correction_deg: {
        roll: roundDegrees(sphereCorrection.roll),
        pitch: roundDegrees(sphereCorrection.pitch),
        yaw: roundDegrees(sphereCorrection.yaw),
      },
      sphere_correction_rad: {
        roll: Number((sphereCorrection.roll * DEG_TO_RAD).toFixed(6)),
        tilt: Number((sphereCorrection.pitch * DEG_TO_RAD).toFixed(6)),
        pan: Number((sphereCorrection.yaw * DEG_TO_RAD).toFixed(6)),
      },
      cubemap_contract: {
        front_yaw_deg: roundDegrees(frontYawDeg),
        right_yaw_deg: roundDegrees(normalizePanoDegrees(frontYawDeg + DIRECTION_OFFSETS.Right)),
        back_yaw_deg: roundDegrees(normalizePanoDegrees(frontYawDeg + DIRECTION_OFFSETS.Back)),
        left_yaw_deg: roundDegrees(normalizePanoDegrees(frontYawDeg + DIRECTION_OFFSETS.Left)),
        seam_yaw_deg: roundDegrees(normalizePanoDegrees(frontYawDeg + DIRECTION_OFFSETS.Seam)),
      },
      yaw_deg: roundDegrees(liveCamera.yawDeg),
      pitch_deg: roundDegrees(liveCamera.pitchDeg),
      fov_deg: roundDegrees(liveCamera.fovDeg),
      timestamp: new Date().toISOString(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : String(error));
    }
  }, [frontYawDeg, liveCamera.fovDeg, liveCamera.pitchDeg, liveCamera.yawDeg, manifest, sphereCorrection]);

  const saveCorrection = useCallback(async () => {
    if (!onSaveCorrection) return;
    setIsSavingCorrection(true);
    try {
      await onSaveCorrection({
        front_yaw_deg: roundDegrees(frontYawDeg),
        sphere_correction_deg: {
          roll: roundDegrees(sphereCorrection.roll),
          pitch: roundDegrees(sphereCorrection.pitch),
          yaw: roundDegrees(sphereCorrection.yaw),
        },
      });
      setViewerError(null);
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingCorrection(false);
    }
  }, [frontYawDeg, onSaveCorrection, sphereCorrection]);

  const capture = useCallback(async () => {
    const canvas = hostRef.current?.querySelector("canvas");
    const viewer = viewerRef.current;
    if (!canvas || !viewer) {
      setViewerError(t("viewer.pano.notReady"));
      return;
    }
    setIsCapturing(true);
    try {
      await waitFrames();
      const position = viewer.getPosition();
      const { blob, width, height, crop } =
        cropFrame && overlayBounds
          ? await cropCanvasToFrame(canvas, cropFrame, overlayBounds)
          : await cropCanvasToAspect(canvas, aspect);
      const yawDeg = radiansToDegrees(position.yaw);
      const pitchDeg = radiansToDegrees(position.pitch);
      const fovDeg = zoomToFov(viewer.getZoomLevel());
      const result = await onCapture({
        blob,
        width,
        height,
        aspect,
        yaw_deg: yawDeg,
        pitch_deg: pitchDeg,
        fov_deg: fovDeg,
        crop,
        source: manifest.source,
      });
      if (result?.anchor_id || result?.rel_path || result?.path) {
        setSaveResult({ ...result, width, height });
      }
      const nextItem = {
        id: captureIdRef.current + 1,
        url: URL.createObjectURL(blob),
        width,
        height,
        aspect,
        yawDeg,
        pitchDeg,
        fovDeg,
      };
      captureIdRef.current = nextItem.id;
      setCaptureHistory((current) => {
        const combined = [nextItem, ...current];
        const next = combined.slice(0, 12);
        // Revoke object URLs of items dropped by the 12-item cap; otherwise each
        // capture past the 12th leaks its blob for the page lifetime.
        combined.slice(12).forEach((item) => URL.revokeObjectURL(item.url));
        captureHistoryRef.current = next;
        return next;
      });
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCapturing(false);
    }
  }, [aspect, cropFrame, manifest.source, onCapture, overlayBounds]);

  const liveFov = Math.round(liveCamera.fovDeg);
  const activeFrame =
    cropFrame ?? (overlayBounds ? panoCaptureOverlayRect(aspect, overlayBounds) : null);
  const contextLabels = [
    `project ${manifest.project}`,
    `scene ${manifest.scene_id}`,
    manifest.beat_context
      ? `EP ${manifest.beat_context.episode} / Beat ${manifest.beat_context.beat}`
      : null,
    viewerPurposeLabel(viewerPurpose ?? (manifest.mode === "beat" ? "beat" : "asset"), t),
    "canonical pano",
    manifest.allowed_destinations.includes("beat_selected_background")
      ? t("viewer.pano.contextSaveTarget")
      : t("viewer.pano.contextDownloadOnly"),
  ].filter((label): label is string => Boolean(label));

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <div className="flex shrink-0 flex-col gap-3 border-b border-border/60 px-4 py-3">
        {/* 标题行右侧给弹窗自带的关闭按钮(右上角)留出空间,避免文字被盖住。 */}
        <div className="min-w-0 pr-14">
          <div className="truncate text-sm font-medium">{manifest.display_name}</div>
          <div className="truncate text-xs text-muted-foreground">{manifest.source.slot_kind}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {contextLabels.map((label) => (
              <span
                key={label}
                className="rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
        {/* 工具栏单独成行,下移避开右上角关闭按钮。 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border bg-card p-0.5">
            {PANO_CAPTURE_ASPECTS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={cn(
                  "h-7 rounded-md px-2 text-xs text-muted-foreground transition-colors",
                  aspect === item.value && "bg-primary text-primary-foreground",
                )}
                onClick={() => setAspect(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={resetView}>
            <RotateCcw className="size-3.5" />
            {t("viewer.pano.resetView")}
          </Button>
          <Button size="sm" onClick={() => void capture()} disabled={isCapturing}>
            {isCapturing ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
            {captureLabel ?? t("viewer.pano.capture")}
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("common.close")}>
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2 text-xs">
        <div className="rounded-md bg-muted px-2 py-1 tabular-nums text-muted-foreground">
          yaw {liveCamera.yawDeg.toFixed(1)}° · pitch {liveCamera.pitchDeg.toFixed(1)}° · fov{" "}
          {liveFov}° · {fovToFocal(liveCamera.fovDeg)}mm
        </div>
        <label className="flex min-w-[220px] items-center gap-2 text-muted-foreground">
          FOV
          <input
            aria-label="FOV"
            type="range"
            min={FOV_MIN}
            max={FOV_MAX}
            step={1}
            value={Math.round(liveCamera.fovDeg)}
            onChange={(event) => setFovDeg(Number(event.target.value))}
            onPointerUp={refreshLiveCamera}
            className="min-w-0 flex-1"
          />
          <input
            aria-label="FOV value"
            type="number"
            min={FOV_MIN}
            max={FOV_MAX}
            step={1}
            value={liveFov}
            onChange={(event) => setFovDeg(Number(event.target.value))}
            onBlur={refreshLiveCamera}
            className={NUMBER_INPUT_CLASS}
          />
        </label>
        <div className="flex flex-wrap gap-1">
          {FOV_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => setFovDeg(preset.value)}
              className="h-7 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {t(`viewer.pano.fovPresets.${preset.key}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {Object.keys(DIRECTION_OFFSETS).map((direction) => (
            <button
              key={direction}
              type="button"
              onClick={() => rotateToDirection(direction as keyof typeof DIRECTION_OFFSETS)}
              className="h-7 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {direction}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={lockCurrentView}>
          {t("viewer.pano.lockCurrentView")}
        </Button>
        <Button
          variant={planetBackup ? "secondary" : "outline"}
          size="sm"
          onClick={planetBackup ? exitPlanetView : enterPlanetView}
        >
          {planetBackup ? t("viewer.pano.exitPlanet") : t("viewer.pano.enterPlanet")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void copyCorrectionJson()}>
          {t("viewer.pano.copyParamsJson")}
        </Button>
        {onSaveCorrection && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void saveCorrection()}
            disabled={isSavingCorrection}
          >
            {isSavingCorrection ? t("viewer.pano.saving") : t("viewer.pano.saveCorrection")}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setShowGuides((value) => !value)}>
          {showGuides ? t("viewer.pano.hideGuides") : t("viewer.pano.showGuides")}
        </Button>
        <Button variant="outline" size="sm" onClick={resetCropFrame}>
          {t("viewer.pano.resetCropFrame")}
        </Button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2 text-xs">
        <label className="flex min-w-[240px] items-center gap-2 text-muted-foreground">
          Front yaw
          <input
            aria-label="Front yaw"
            type="range"
            min={-180}
            max={180}
            step={1}
            value={frontYawDeg}
            onChange={(event) => setFrontYaw(Number(event.target.value))}
            className="min-w-0 flex-1"
          />
          <input
            aria-label="Front yaw value"
            type="number"
            min={-180}
            max={180}
            step={1}
            value={frontYawDeg}
            onChange={(event) => setFrontYaw(Number(event.target.value))}
            className={NUMBER_INPUT_CLASS}
          />
        </label>
        <Button variant="outline" size="sm" onClick={setFrontYawFromView}>
          {t("viewer.pano.setFrontFromView")}
        </Button>
        <label className="flex items-center gap-2 text-muted-foreground">
          roll
          <input
            aria-label="Correction roll"
            type="range"
            min={-180}
            max={180}
            step={1}
            value={sphereCorrection.roll}
            onChange={(event) => updateSphereCorrection("roll", Number(event.target.value))}
            className="w-24"
          />
          <input
            aria-label="Correction roll value"
            type="number"
            min={-180}
            max={180}
            step={1}
            value={sphereCorrection.roll}
            onChange={(event) => updateSphereCorrection("roll", Number(event.target.value))}
            className={NUMBER_INPUT_CLASS}
          />
        </label>
        <label className="flex items-center gap-2 text-muted-foreground">
          pitch
          <input
            aria-label="Correction pitch"
            type="range"
            min={-90}
            max={90}
            step={1}
            value={sphereCorrection.pitch}
            onChange={(event) => updateSphereCorrection("pitch", Number(event.target.value))}
            className="w-24"
          />
          <input
            aria-label="Correction pitch value"
            type="number"
            min={-90}
            max={90}
            step={1}
            value={sphereCorrection.pitch}
            onChange={(event) => updateSphereCorrection("pitch", Number(event.target.value))}
            className={NUMBER_INPUT_CLASS}
          />
        </label>
        <label className="flex items-center gap-2 text-muted-foreground">
          yaw
          <input
            aria-label="Correction yaw"
            type="range"
            min={-180}
            max={180}
            step={1}
            value={sphereCorrection.yaw}
            onChange={(event) => updateSphereCorrection("yaw", Number(event.target.value))}
            className="w-24"
          />
          <input
            aria-label="Correction yaw value"
            type="number"
            min={-180}
            max={180}
            step={1}
            value={sphereCorrection.yaw}
            onChange={(event) => updateSphereCorrection("yaw", Number(event.target.value))}
            className={NUMBER_INPUT_CLASS}
          />
        </label>
        <Button variant="outline" size="sm" onClick={resetSphereCorrection}>
          {t("viewer.pano.resetCorrection")}
        </Button>
      </div>
      {viewerError && (
        <div className="mx-4 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {viewerError}
        </div>
      )}
      <div ref={viewportRef} className="relative min-h-0 flex-1 bg-black">
        <div ref={hostRef} className="absolute inset-0" />
        <div className="pointer-events-none absolute inset-0">
          <div
            ref={cropFrameElementRef}
            data-testid="pano-capture-frame"
            className="pointer-events-auto absolute cursor-move touch-none overflow-hidden rounded-md border border-white/80 bg-white/[0.03] shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
            style={panoCaptureOverlayStyle(aspect, overlayBounds, activeFrame)}
            onPointerDown={(event) => beginFrameInteraction("move", event)}
            onPointerMove={moveFrameInteraction}
            onPointerUp={endFrameInteraction}
            onPointerCancel={endFrameInteraction}
          >
            {showGuides && (
              <>
                <div
                  data-testid="pano-guide-horizon"
                  className="absolute left-0 right-0 top-1/2 border-t border-white/55"
                />
                <div data-testid="pano-guide-thirds" className="absolute inset-0">
                  <div className="absolute bottom-0 left-1/3 top-0 border-l border-dashed border-white/35" />
                  <div className="absolute bottom-0 right-1/3 top-0 border-l border-dashed border-white/35" />
                  <div className="absolute left-0 right-0 top-1/3 border-t border-dashed border-white/35" />
                  <div className="absolute bottom-1/3 left-0 right-0 border-t border-dashed border-white/35" />
                </div>
                <div
                  data-testid="pano-guide-center"
                  className="absolute left-1/2 top-1/2 size-8 -translate-x-1/2 -translate-y-1/2"
                >
                  <div className="absolute left-1/2 top-0 h-full border-l border-white/70" />
                  <div className="absolute left-0 top-1/2 w-full border-t border-white/70" />
                </div>
              </>
            )}
            <div
              data-testid="pano-capture-resize-handle"
              className="pointer-events-auto absolute bottom-0 right-0 size-5 cursor-nwse-resize border-b-2 border-r-2 border-white/90 bg-black/30"
              onPointerDown={(event) => beginFrameInteraction("resize", event)}
            />
          </div>
        </div>
        {saveResult && (
          <div className="pointer-events-auto absolute bottom-3 right-3 z-10 max-w-[min(460px,calc(100%-24px))] rounded-lg border border-emerald-500/40 bg-background/90 p-3 text-xs shadow-lg backdrop-blur">
            <div className="font-medium text-emerald-600">
              {t("viewer.pano.saved", { name: saveResult.anchor_id || t("viewer.pano.captureNoun") })}
            </div>
            <div className="mt-1 break-all text-muted-foreground">
              {saveResult.rel_path || saveResult.path || t("viewer.pano.noPathReturned")}
            </div>
            <div className="mt-1 text-muted-foreground">
              {saveResult.width} x {saveResult.height}
            </div>
          </div>
        )}
        {captureHistory.length > 0 && (
          <div className="pointer-events-auto absolute bottom-3 left-3 z-10 max-w-[min(560px,calc(100%-24px))] rounded-lg border border-border/70 bg-background/90 p-2 shadow-lg backdrop-blur">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-xs font-medium text-foreground">{t("viewer.pano.captureList")}</div>
              <Button variant="ghost" size="sm" onClick={clearCaptureHistory}>
                {t("viewer.pano.clearCaptureList")}
              </Button>
            </div>
            <div className="flex gap-2 overflow-x-auto">
              {captureHistory.map((item) => (
                <div key={item.id} className="w-32 shrink-0 overflow-hidden rounded-md border border-border bg-card">
                  <img
                    src={item.url}
                    alt={t("viewer.pano.captureN", { id: item.id })}
                    className="h-16 w-full object-cover"
                  />
                  <div className="space-y-0.5 p-2 text-[11px] leading-tight">
                    <div className="font-medium text-foreground">{t("viewer.pano.captureN", { id: item.id })}</div>
                    <div className="text-muted-foreground">
                      {item.width} x {item.height} · {item.aspect}
                    </div>
                    <div className="truncate text-muted-foreground">
                      yaw {item.yawDeg.toFixed(1)} / pitch {item.pitchDeg.toFixed(1)} / fov{" "}
                      {Math.round(item.fovDeg)}
                    </div>
                    <a
                      href={item.url}
                      download={`pano-capture-${item.id}.png`}
                      className="inline-flex text-primary hover:underline"
                    >
                      {t("viewer.pano.downloadCaptureN", { id: item.id })}
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
