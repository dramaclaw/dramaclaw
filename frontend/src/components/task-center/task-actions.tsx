// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { Copy, Download, ExternalLink, XCircle } from "lucide-react";

import { useCancelTask } from "@/lib/queries/tasks";
import { isActive, originDeepLink, taskLogLinesOf } from "@/task-center/derivations";
import type { TaskState } from "@/task-center/types";
import { Button } from "@/components/ui/button";

export function TaskActions({ task }: { task: TaskState }) {
  const { t } = useTranslation();
  const cancelMut = useCancelTask();
  const deepLink = originDeepLink(task);

  // useCancelTask now accepts `beatNum` + `scope`, so every active task is
  // precisely cancellable. The old "hide for scoped" guard is removed.
  const onCancel = () => {
    cancelMut.mutate(
      {
        type: task.task_type,
        project: task.project_id ?? task.project,
        episode: task.episode,
        beatNum: task.beat_num ?? undefined,
        scope: task.scope ?? undefined,
      },
      {
        onSuccess: (result) => {
          if (result.ok) {
            toast.success(
              result.message ??
                t("taskCenter.toast.canceled", { label: task.task_type }),
            );
          }
        },
      },
    );
  };

  const onCopyId = async () => {
    try {
      await navigator.clipboard.writeText(task.task_id);
      toast.success(t("taskCenter.toast.copied"));
    } catch {
      // Clipboard API may fail in non-HTTPS / non-focused contexts. Silent OK.
    }
  };

  const onDownloadLogs = () => {
    const blob = new Blob([taskLogLinesOf(task, t).join("\n")], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${task.task_key}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-border px-3 py-2">
      {isActive(task) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={cancelMut.isPending}
        >
          <XCircle className="size-4" />
          {t("taskCenter.actions.cancel")}
        </Button>
      )}
      {deepLink && (
        <Button
          variant="ghost"
          size="sm"
          render={<Link to={deepLink.to} params={deepLink.params} />}
        >
          <ExternalLink className="size-4" />
          {t("taskCenter.actions.openOrigin")}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onCopyId}>
        <Copy className="size-4" />
        {t("taskCenter.actions.copyId")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDownloadLogs}
        disabled={!task.logs.length}
      >
        <Download className="size-4" />
        {t("taskCenter.actions.downloadLogs")}
      </Button>
    </div>
  );
}
