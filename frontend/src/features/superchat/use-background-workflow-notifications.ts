import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CanvasChatCommandApplyResult } from "@/features/freezone/canvasChatCommands";

/** Completion asks for the next decision; it never sends an agent/generation turn. */
export function useBackgroundWorkflowNotifications({
  scopeKey,
  busy,
  appendNotification,
}: {
  scopeKey: string;
  busy: boolean;
  appendNotification: (text: string, idempotencyKey?: string) => boolean;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Record<string, { scopeKey: string; text: string }>>({});
  const notified = useRef(new Set<string>());

  const enqueue = useCallback((runId: string, result: CanvasChatCommandApplyResult) => {
    if (result.commandResults.some((step) => step.status === "pending")) return;
    const key = `canvas-workflow-completion:${scopeKey}:${runId}`;
    if (notified.current.has(key)) return;
    const text = result.commandResults.some((step) => step.status === "unverified")
      ? t("freezone.chat.workflowResultUnverifiedMessage")
      : result.errors.length || result.commandResults.some((step) => step.status === "error")
      ? t("freezone.chat.backgroundWorkflowFailedQuestion")
      : t("freezone.chat.backgroundWorkflowCompletedQuestion");
    setPending((current) => current[key] ? current : { ...current, [key]: { scopeKey, text } });
  }, [scopeKey, t]);

  useEffect(() => {
    if (busy) return;
    for (const [key, notice] of Object.entries(pending)) {
      if (notice.scopeKey !== scopeKey || notified.current.has(key)) continue;
      appendNotification(notice.text, key);
      // Mark local notices delivered so recovered workflows do not repeat them.
      notified.current.add(key);
      setPending((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }, [appendNotification, busy, pending, scopeKey]);

  return enqueue;
}
