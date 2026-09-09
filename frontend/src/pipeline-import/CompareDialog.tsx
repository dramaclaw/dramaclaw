// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface CompareDialogProps {
  /** Two image URLs (cookie-protected /static/...). */
  left: { url: string; label: string };
  right: { url: string; label: string };
  onClose: () => void;
}

/**
 * Side-by-side AB compare with a draggable vertical slider.
 *
 * Implementation:
 *   - Both images stacked into a relatively positioned div.
 *   - Right image's width is clipped via CSS clip-path inset() controlled by
 *     a state value (0..1).
 *   - A draggable handle line sits at the boundary.
 *
 * Implemented as a freezone modal to avoid adding a new node type to
 * upstream nodeRegistry — keeps the upstream sync surface clean.
 */
export function CompareDialog({ left, right, onClose }: CompareDialogProps) {
  const { t } = useTranslation();
  const [position, setPosition] = useState(0.5); // 0 = all left, 1 = all right
  const wrapperRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const onUp = () => {
      draggingRef.current = false;
    };
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current || !wrapperRef.current) return;
      const rect = wrapperRef.current.getBoundingClientRect();
      const next = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      setPosition(next);
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6">
      <div className="bg-surface border border-border-default rounded-2xl w-[80vw] max-w-[1100px] h-[80vh] flex flex-col overflow-hidden">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border-default">
          <div>
            <div className="text-sm font-semibold text-text">{t("pipelineImport.compare.title")}</div>
            <div className="text-xs text-text-muted mt-0.5">
              {t("pipelineImport.compare.position", { percent: Math.round(position * 100) })}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text transition text-sm"
            aria-label={t("common.close")}
          >
            ✕
          </button>
        </header>

        <div className="flex-1 relative bg-bg-dark overflow-hidden flex items-center justify-center">
          <div
            ref={wrapperRef}
            className="relative max-w-full max-h-full select-none"
            style={{ width: "min(100%, 1024px)" }}
          >
            <img
              src={left.url}
              alt={left.label}
              className="block w-full h-auto"
              draggable={false}
            />
            <img
              src={right.url}
              alt={right.label}
              className="absolute inset-0 w-full h-auto"
              draggable={false}
              style={{
                clipPath: `inset(0 0 0 ${position * 100}%)`,
              }}
            />
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                draggingRef.current = true;
              }}
              className="absolute top-0 bottom-0 w-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)] cursor-ew-resize"
              style={{ left: `${position * 100}%`, transform: "translateX(-0.5px)" }}
              aria-label={t("pipelineImport.compare.dragHandle")}
            >
              <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white border-2 border-bg-dark text-bg-dark text-[10px] flex items-center justify-center">
                ◄►
              </span>
            </button>

            <div className="absolute top-2 left-2 text-xs text-white px-2 py-1 rounded bg-black/60">
              {left.label}
            </div>
            <div className="absolute top-2 right-2 text-xs text-white px-2 py-1 rounded bg-black/60">
              {right.label}
            </div>
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-border-default flex items-center justify-between text-xs text-text-muted">
          <span>{t("pipelineImport.compare.hint")}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(position * 100)}
            onChange={(e) => setPosition(Number(e.target.value) / 100)}
            className="w-48 accent-accent"
          />
        </footer>
      </div>
    </div>
  );
}
