// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/stores/app-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TaskList } from "./task-list";
import { TaskDetail } from "./task-detail";

export function TaskPanel() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.taskPanelOpen);
  const height = useAppStore((s) => s.taskPanelHeight);
  const setOpen = useAppStore((s) => s.setTaskPanelOpen);
  const setHeight = useAppStore((s) => s.setTaskPanelHeight);
  const panelRef = useRef<HTMLDivElement>(null);
  const [contentMounted, setContentMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setContentMounted(true);
      return;
    }
    const timeout = window.setTimeout(() => setContentMounted(false), 300);
    return () => window.clearTimeout(timeout);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Make the panel itself focusable and pull focus on open so Esc works when
    // the user opened the panel via ⌘J (which doesn't move focus on its own).
    // Activating an input or control inside the panel keeps focus there and
    // Esc still works — this only seeds a focused target when focus was outside.
    const node = panelRef.current;
    if (node && !node.contains(document.activeElement)) {
      node.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!panelRef.current) return;
      if (panelRef.current.contains(document.activeElement)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const onResizeStart = (e: React.PointerEvent) => {
    if (!open) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => {
      // Dragging UP grows the panel (bottom-anchored).
      setHeight(startH + (startY - ev.clientY));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <>
      <div
        className={cn(
          "absolute inset-x-0 top-0 bottom-9 z-30 bg-background/10 backdrop-blur-sm transition-opacity duration-500 ease-[var(--ease-out-quint)]",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div
        ref={panelRef}
        className={cn(
          "absolute inset-x-0 bottom-9 z-40 flex flex-col overflow-hidden bg-background outline-none transition-all duration-500 ease-[var(--ease-out-quint)]",
          open
            ? "border-t border-border/70 opacity-100"
            : "pointer-events-none border-t border-transparent opacity-0",
        )}
        style={{ height: open ? height : 0 }}
        role="region"
        aria-label={t("taskCenter.title")}
        aria-hidden={!open}
        tabIndex={-1}
      >
        {contentMounted && (
          <>
            <div
              onPointerDown={onResizeStart}
              className="h-1 shrink-0 cursor-row-resize bg-border/50 transition-colors hover:bg-border"
              aria-label="Resize task panel"
              data-testid="task-panel-resize-handle"
            />
            <div className="flex shrink-0 items-center justify-between border-b border-border/40 px-3 py-2">
              <h2 className="text-xs font-semibold">{t("taskCenter.title")}</h2>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setOpen(false)}
                aria-label={t("taskCenter.panel.close")}
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div className="w-[340px] min-w-0 shrink-0 border-r border-border/40 xl:w-[380px]">
                <TaskList />
              </div>
              <div className="min-w-0 flex-1">
                <TaskDetail />
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
