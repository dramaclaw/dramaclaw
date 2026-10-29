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
  appendNotification: (text: string, idempotencyKey?: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Record<string, { scopeKey: string; text: string }>>({});
  const notified = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());

  const enqueue = useCallback((runId: string, result: CanvasChatCommandApplyResult) => {
    if (result.commandResults.some((step) => step.status === "pending")) return;
    const key = `canvas-workflow-completion:${scopeKey}:${runId}`;
    if (notified.current.has(key)) return;
    const text = result.errors.length || result.commandResults.some((step) => step.status === "error")
      ? t("freezone.chat.backgroundWorkflowFailedQuestion")
      : t("freezone.chat.backgroundWorkflowCompletedQuestion");
    setPending((current) => current[key] ? current : { ...current, [key]: { scopeKey, text } });
  }, [scopeKey, t]);

  useEffect(() => {
    if (busy) return;
    for (const [key, notice] of Object.entries(pending)) {
      if (notice.scopeKey !== scopeKey || inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      void appendNotification(notice.text, key).then(() => {
        // The hook also displays an offline fallback. Do not repeatedly insert
        // that fallback; the durable pending workflow can recover after reload.
        notified.current.add(key);
        setPending((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }).finally(() => inFlight.current.delete(key));
    }
  }, [appendNotification, busy, pending, scopeKey]);

  return enqueue;
}
