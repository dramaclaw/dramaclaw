// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { DirectorStageOrientationMode } from "./directorManifest";
import type { DirectorWorldSourceTransform } from "./sourceTransform";
import {
  createViewerApp,
  type SplatLoadProgress,
  type ViewerApp,
} from "./engine/viewerApp";

const CLICK_DRAG_THRESHOLD_PX = 5;

export interface ThreeDStageCanvasProps {
  splatUrl: string | null;
  panoUrl?: string | null;
  orientationMode?: DirectorStageOrientationMode;
  sourceTransform?: Partial<DirectorWorldSourceTransform> | null;
  collisionUrl?: string | null;
  interactionActive?: boolean;
  onInteractionActiveChange?: (active: boolean) => void;
  onReady?: (app: ViewerApp) => void;
  onError?: (error: Error) => void;
  onStatus?: (status: string) => void;
  onLoadProgress?: (progress: SplatLoadProgress) => void;
  onSourceReady?: () => void;
  onPlaceRequest?: () => void;
  showInteractionHint?: boolean;
}

export function ThreeDStageCanvas({
  splatUrl,
  panoUrl,
  orientationMode,
  sourceTransform,
  collisionUrl,
  interactionActive = false,
  onInteractionActiveChange,
  onReady,
  onError,
  onStatus,
  onLoadProgress,
  onSourceReady,
  onPlaceRequest,
  showInteractionHint = true,
}: ThreeDStageCanvasProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<ViewerApp | null>(null);
  const onReadyRef = useRef<typeof onReady>(onReady);
  const onErrorRef = useRef<typeof onError>(onError);
  const onStatusRef = useRef<typeof onStatus>(onStatus);
  const onLoadProgressRef = useRef<typeof onLoadProgress>(onLoadProgress);
  const onSourceReadyRef = useRef<typeof onSourceReady>(onSourceReady);
  const onPlaceRequestRef = useRef<(() => void) | undefined>(onPlaceRequest);
  const sourceTransformRef = useRef<typeof sourceTransform>(sourceTransform);
  const interactionActiveRef = useRef(interactionActive);
  // viewer 只在挂载时建一次，t 却会随语言切换换实例；用 ref 保证引擎拿到的永远是最新那个。
  const tRef = useRef(t);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  onStatusRef.current = onStatus;
  onLoadProgressRef.current = onLoadProgress;
  onSourceReadyRef.current = onSourceReady;
  onPlaceRequestRef.current = onPlaceRequest;
  sourceTransformRef.current = sourceTransform;
  interactionActiveRef.current = interactionActive;
  tRef.current = t;

  useEffect(() => {
    let disposed = false;
    let unsubStatus: (() => void) | undefined;
    let unsubProgress: (() => void) | undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let downX = 0;
    let downY = 0;
    let downButton = -1;
    let downShift = false;

    const onPointerDown = (event: PointerEvent) => {
      if (!interactionActiveRef.current) return;
      downX = event.clientX;
      downY = event.clientY;
      downButton = event.button;
      downShift = event.shiftKey;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!interactionActiveRef.current) return;
      if (downButton < 0) return;
      const dx = event.clientX - downX;
      const dy = event.clientY - downY;
      const isClick = Math.hypot(dx, dy) <= CLICK_DRAG_THRESHOLD_PX;
      const button = downButton;
      const shift = downShift;
      downButton = -1;
      downShift = false;
      if (event.button !== button || !isClick) return;

      const viewer = viewerRef.current;
      if (!viewer) return;
      if (button === 2 || (button === 0 && shift)) {
        onPlaceRequestRef.current?.();
        return;
      }
      if (button !== 0) return;
      const hit = viewer.selectAtScreen(event.clientX, event.clientY);
      if (!hit) viewer.clearSelection();
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("contextmenu", onContextMenu);

    const initFrame = window.requestAnimationFrame(() => {
      void (async () => {
        try {
          const viewer = await createViewerApp({
            canvas,
            translate: (key, params) => tRef.current(key, params),
          });
          if (disposed) {
            viewer.destroy();
            return;
          }
          viewerRef.current = viewer;
          viewer.fly.setInputEnabled(interactionActiveRef.current);
          if (onStatusRef.current) {
            unsubStatus = viewer.onStatus((next) => onStatusRef.current?.(next));
          }
          if (onLoadProgressRef.current) {
            unsubProgress = viewer.onSplatProgress((next) =>
              onLoadProgressRef.current?.(next),
            );
          }
          onReadyRef.current?.(viewer);
        } catch (error) {
          if (disposed) return;
          onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });

    return () => {
      disposed = true;
      window.cancelAnimationFrame(initFrame);
      unsubStatus?.();
      unsubProgress?.();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("contextmenu", onContextMenu);
      const viewer = viewerRef.current;
      viewerRef.current = null;
      viewer?.destroy();
    };
  }, []);

  useEffect(() => {
    if (!splatUrl) return undefined;
    const load = () => {
      const viewer = viewerRef.current;
      if (!viewer) return false;
      viewer
        .loadSplat(splatUrl, {
          orientationMode,
          sourceTransform: sourceTransformRef.current,
        })
        .then(() => onSourceReadyRef.current?.())
        .catch((error: unknown) => {
          onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
        });
      return true;
    };
    if (load()) return undefined;
    const handle = window.setInterval(() => {
      if (load()) window.clearInterval(handle);
    }, 80);
    return () => window.clearInterval(handle);
  }, [orientationMode, splatUrl]);

  useEffect(() => {
    if (!panoUrl && !splatUrl) {
      const clear = () => {
        const viewer = viewerRef.current;
        if (!viewer) return false;
        viewer.clearWorldSource();
        onSourceReadyRef.current?.();
        return true;
      };
      if (clear()) return undefined;
      const handle = window.setInterval(() => {
        if (clear()) window.clearInterval(handle);
      }, 80);
      return () => window.clearInterval(handle);
    }
    if (!panoUrl && splatUrl) return undefined;
    const load = () => {
      const viewer = viewerRef.current;
      if (!viewer) return false;
      viewer
        .loadPano(panoUrl ?? null, {
          sourceTransform: sourceTransformRef.current,
        })
        .then(() => onSourceReadyRef.current?.())
        .catch((error: unknown) => {
          onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
        });
      return true;
    };
    if (load()) return undefined;
    const handle = window.setInterval(() => {
      if (load()) window.clearInterval(handle);
    }, 80);
    return () => window.clearInterval(handle);
  }, [panoUrl, splatUrl]);

  useEffect(() => {
    const load = () => {
      const viewer = viewerRef.current;
      if (!viewer) return false;
      viewer.loadCollision(collisionUrl ?? null).catch((error: unknown) => {
        onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
      });
      return true;
    };
    if (load()) return undefined;
    const handle = window.setInterval(() => {
      if (load()) window.clearInterval(handle);
    }, 80);
    return () => window.clearInterval(handle);
  }, [collisionUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    viewerRef.current?.fly.setInputEnabled(interactionActive);
    if (interactionActive) {
      canvas.focus();
    } else {
      if (document.activeElement === canvas) {
        canvas.blur();
      }
      window.getSelection()?.removeAllRanges();
    }
  }, [interactionActive]);

  const activate = () => {
    onInteractionActiveChange?.(true);
    window.requestAnimationFrame(() => canvasRef.current?.focus());
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        onFocus={() => onInteractionActiveChange?.(true)}
        onBlur={() => onInteractionActiveChange?.(false)}
        className="block h-full w-full cursor-crosshair outline-none"
      />
      {showInteractionHint && !interactionActive && (
        <button
          type="button"
          onClick={activate}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/35 text-[#fff8df] backdrop-blur-[1px]"
        >
          <span className="rounded-xl border border-[rgba(255,226,166,0.28)] bg-[rgba(20,16,11,0.86)] px-5 py-3 text-sm shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
            {t("viewer.threeD.stageClickToEnter")} · {t("viewer.threeD.stageExitInteraction")}
          </span>
        </button>
      )}
    </div>
  );
}
