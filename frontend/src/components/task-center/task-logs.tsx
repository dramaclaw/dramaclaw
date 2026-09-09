// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";
import { taskLogLinesOf } from "@/task-center/derivations";
import type { TaskState } from "@/task-center/types";

export function TaskLogs({ task }: { task: TaskState }) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Auto-scroll to bottom when new log lines arrive.
    // The project's ScrollArea is built on base-ui, whose viewport carries
    // `data-slot="scroll-area-viewport"`. We also check the radix attribute
    // as a defensive fallback in case the primitive is swapped out later.
    const root = scrollRef.current;
    if (!root) return;
    const viewport =
      root.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ??
      root.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [task.logs.length]);

  if (!task.logs.length) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("taskCenter.detail.logs.placeholder")}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full">
      <ScrollArea className="h-full">
        <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-snug">
          {taskLogLinesOf(task, t).join("\n")}
        </pre>
      </ScrollArea>
    </div>
  );
}
