// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { GripVertical, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { safeLocalStorageSet } from "@/lib/localStorageQuota";
import {
  clampFloatingEntryPosition,
  normalizeFloatingEntryPosition,
  restoreFloatingEntryPosition,
  type FloatingEntryPosition,
  type FloatingEntrySize,
  type NormalizedFloatingEntryPosition,
} from "./floating-entry-position";

const STORAGE_KEY = "dramaclaw.piko-world-entry-position.v1";
const DEFAULT_RIGHT_PX = 24;
const DEFAULT_BOTTOM_PX = 52;
const DRAG_THRESHOLD_PX = 4;

function readStoredPosition(): NormalizedFloatingEntryPosition | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object") return null;
    const position = value as Partial<NormalizedFloatingEntryPosition>;
    if (!Number.isFinite(position.xPercent) || !Number.isFinite(position.yPercent)) return null;
    return { xPercent: position.xPercent!, yPercent: position.yPercent! };
  } catch {
    return null;
  }
}

function readViewportSize(): FloatingEntrySize {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.innerHeight };
}

export function PikoWorldFloatingEntry() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const router = useRouter();
  const entryRef = useRef<HTMLButtonElement>(null);
  const suppressClickRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [storedPosition, setStoredPosition] = useState(readStoredPosition);
  const [dragPosition, setDragPosition] = useState<FloatingEntryPosition | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [viewportSize, setViewportSize] = useState(readViewportSize);

  useEffect(() => {
    const handleResize = () => setViewportSize(readViewportSize());
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      dragCleanupRef.current?.();
    };
  }, []);

  const resolvedPosition = (() => {
    if (dragPosition) return dragPosition;
    const entry = entryRef.current;
    if (!entry || !storedPosition) return null;
    return restoreFloatingEntryPosition(
      storedPosition,
      viewportSize,
      { width: entry.offsetWidth, height: entry.offsetHeight },
    );
  })();

  const preloadWorld = useCallback(() => {
    void router.preloadRoute({ to: "/piko-world" });
  }, [router]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const entry = entryRef.current;
    if (!entry) return;
    dragCleanupRef.current?.();
    const startBounds = entry.getBoundingClientRect();
    const startPointer = { x: event.clientX, y: event.clientY };
    const grabOffset = { x: event.clientX - startBounds.left, y: event.clientY - startBounds.top };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const entrySize = { width: startBounds.width, height: startBounds.height };
    let moved = false;
    let latest = { left: startBounds.left, top: startBounds.top };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (
        !moved &&
        Math.hypot(moveEvent.clientX - startPointer.x, moveEvent.clientY - startPointer.y) <
          DRAG_THRESHOLD_PX
      ) {
        return;
      }
      moved = true;
      setIsDragging(true);
      latest = clampFloatingEntryPosition(
        { left: moveEvent.clientX - grabOffset.x, top: moveEvent.clientY - grabOffset.y },
        viewport,
        entrySize,
      );
      setDragPosition(latest);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      dragCleanupRef.current = null;
    };
    const handlePointerUp = () => {
      cleanup();
      setIsDragging(false);
      if (!moved) return;
      const normalized = normalizeFloatingEntryPosition(latest, viewport);
      setStoredPosition(normalized);
      setDragPosition(null);
      safeLocalStorageSet(STORAGE_KEY, JSON.stringify(normalized));
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };
    const handlePointerCancel = () => {
      cleanup();
      setIsDragging(false);
      setDragPosition(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerCancel, { once: true });
    dragCleanupRef.current = cleanup;
  }, []);

  return (
    <button
      ref={entryRef}
      type="button"
      onFocus={preloadWorld}
      onPointerEnter={preloadWorld}
      onPointerDown={handlePointerDown}
      onClick={() => {
        if (suppressClickRef.current) return;
        navigate({ to: "/piko-world" });
      }}
      className="backdrop-blur-tap fixed z-30 inline-flex h-10 cursor-grab touch-none select-none items-center gap-2 rounded-full border border-border bg-card/90 px-3 text-sm font-medium text-foreground shadow-lg shadow-black/20 transition-[background-color,border-color] duration-[var(--duration-fast)] hover:border-foreground/20 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 active:cursor-grabbing"
      style={
        resolvedPosition
          ? { left: resolvedPosition.left, top: resolvedPosition.top }
          : { right: DEFAULT_RIGHT_PX, bottom: DEFAULT_BOTTOM_PX }
      }
      data-dragging={isDragging || undefined}
      aria-label={t("project.pikoWorldEntry")}
      title={t("project.pikoWorldEntryDragHint")}
    >
      <GripVertical className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <Sparkles className="size-4 text-primary" aria-hidden="true" />
      <span>{t("project.pikoWorldEntry")}</span>
    </button>
  );
}
