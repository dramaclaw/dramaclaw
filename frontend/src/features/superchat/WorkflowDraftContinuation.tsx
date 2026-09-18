// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiCall } from "@/api/client";
import type { ChatMessage } from "./types";

type Draft = {
  draft_id: string;
  revision: number;
  status: string;
  run_after_create: boolean;
  updated_at?: number;
  expires_at?: number;
  preview?: { title?: string; node_count?: number; edge_count?: number;
    external_inputs?: Array<{id: string; node_id: string; display_name?: string}> };
};

export type CancelledWorkflowDraft = { draftId: string; updatedAt: number };

export function insertWorkflowDraftCancellationMessage(
  messages: ChatMessage[], cancelled: CancelledWorkflowDraft | null, text: string,
): ChatMessage[] {
  if (!cancelled || !Number.isFinite(cancelled.updatedAt)) return messages;
  const feedback: ChatMessage = {
    id: `workflow-draft-cancelled:${cancelled.draftId}`,
    role: "assistant",
    text,
    timestamp: cancelled.updatedAt * 1000,
  };
  const position = messages.findIndex((message) => message.timestamp > feedback.timestamp);
  if (position < 0) return [...messages, feedback];
  return [...messages.slice(0, position), feedback, ...messages.slice(position)];
}

function objects(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    try { return objects(JSON.parse(value)); } catch { return []; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return [record, ...objects(record.structuredContent), ...objects(record.data),
    ...(Array.isArray(record.content) ? record.content.flatMap((item) =>
      objects((item as { text?: unknown })?.text)) : [])];
}

export function latestWorkflowDraftId(messages: ChatMessage[]): string | null {
  for (const message of [...messages].reverse()) {
    for (const part of [...(message.parts ?? [])].reverse()) {
      if (part.type !== "tool_status") continue;
      const raw = (part.event as ChatMessage)?.raw as Record<string, unknown> | undefined;
      const name = String(raw?.name ?? "").split(".").pop();
      if (!["freezone_prepare_workflow_draft", "freezone_prepare_workflow_plan_draft",
        "freezone_prepare_workflow", "freezone_patch_workflow_draft"].includes(name ?? "")) continue;
      const draft = [...objects(raw?.result_json), ...objects(raw?.output)].find((item) =>
        item.ok === true && typeof item.draft_id === "string" && item.draft_id);
      if (draft) return String(draft.draft_id);
    }
  }
  return null;
}

/** Recover the actionable continuation even when the agent stops at draft-ready. */
export function WorkflowDraftContinuation({ messages, projectId, canvasId, busy, hasApproval = false, onConfirm, onCancelled }: {
  messages: ChatMessage[];
  projectId: string;
  canvasId: string;
  busy: boolean;
  hasApproval?: boolean;
  onConfirm: (display: string, transport: string) => boolean | Promise<boolean>;
  onCancelled?: (cancelled: CancelledWorkflowDraft) => void;
}) {
  const { t } = useTranslation();
  const draftId = latestWorkflowDraftId(messages);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sending, setSending] = useState<"confirm" | "cancel" | null>(null);
  const [awaitingTurn, setAwaitingTurn] = useState(false);
  const sawBusy = useRef(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const onCancelledRef = useRef(onCancelled);
  onCancelledRef.current = onCancelled;
  const scope = `${projectId}:${canvasId}:${draftId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    setDraft(null);
    setError("");
    setSending(null);
    setAwaitingTurn(false);
    sawBusy.current = false;
    inFlight.current = false;
    if (!draftId || !projectId || !canvasId) return;
    let active = true;
    const read = async () => {
      try {
        const value = await apiCall<Draft>(`projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}/workflow-drafts/${encodeURIComponent(draftId)}`);
        if (active) {
          setDraft((current) => current?.status === "cancelled" ? current : value);
          if (value.status === "cancelled" && value.updated_at != null) {
            onCancelledRef.current?.({ draftId: value.draft_id, updatedAt: value.updated_at });
          }
          setError("");
        }
      } catch {
        if (active) { setDraft(null); setError(""); }
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId, canvasId, draftId]);
  useEffect(() => {
    if (!awaitingTurn) return;
    if (busy) sawBusy.current = true;
    if (!busy && sawBusy.current) {
      sawBusy.current = false;
      setAwaitingTurn(false);
    }
  }, [busy, awaitingTurn]);
  if (busy || hasApproval || awaitingTurn || !draft || draft.status !== "ready" ||
    (draft.expires_at && draft.expires_at * 1000 <= Date.now())) return null;
  const confirm = async () => {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    setSending("confirm");
    setError("");
    const currentScope = scope;
    try {
      // Re-read before authorization: stale revisions/policies are never confirmed.
      const current = await apiCall<Draft>(`projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}/workflow-drafts/${encodeURIComponent(draftId!)}`);
      if (scopeRef.current !== currentScope) return;
      if (current.status !== "ready" || current.revision !== draft.revision ||
        current.run_after_create !== draft.run_after_create ||
        (current.expires_at && current.expires_at * 1000 <= Date.now())) {
        setDraft(current);
        setError(t("workflowDraftContinuation.changed"));
        return;
      }
      const display = t(current.run_after_create ? "workflowDraftContinuation.confirmRunMessage" : "workflowDraftContinuation.confirmMessage");
      // i18n-exempt-start: internal agent transport, not UI copy
      const transport = `${display}。请调用 freezone_confirm_workflow_draft，参数为 ${JSON.stringify({
        project_id: projectId, canvas_id: canvasId, draft_id: current.draft_id,
        revision: current.revision,
      })}。使用这份已确认草稿，不要重新准备方案。等待真实画布回执后再报告创建结果。`; // i18n-exempt
      // i18n-exempt-end
      if (!await onConfirm(display, transport)) throw new Error("not sent");
      if (scopeRef.current === currentScope) setAwaitingTurn(true);
    } catch {
      if (scopeRef.current === currentScope) {
        setError(t("workflowDraftContinuation.failed"));
      }
    } finally {
      if (scopeRef.current === currentScope) { inFlight.current = false; setSending(null); }
    }
  };
  const cancel = async () => {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    setSending("cancel");
    setError("");
    const currentScope = scope;
    try {
      const cancelled = await apiCall<Draft>(
        `projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}/workflow-drafts/${encodeURIComponent(draftId!)}/cancel`,
        { method: "post", json: { expected_revision: draft.revision } },
      );
      if (scopeRef.current === currentScope) {
        setDraft(cancelled);
        if (cancelled.status === "cancelled" && cancelled.updated_at != null) {
          onCancelled?.({ draftId: cancelled.draft_id, updatedAt: cancelled.updated_at });
        }
      }
    } catch {
      if (scopeRef.current === currentScope) setError(t("workflowDraftContinuation.cancelFailed"));
    } finally {
      if (scopeRef.current === currentScope) { inFlight.current = false; setSending(null); }
    }
  };
  return <section className="rounded-lg border border-border bg-background p-3 text-sm" aria-label={t("workflowDraftContinuation.ariaLabel")}>
    <div className="font-medium">{t("workflowDraftContinuation.title")}</div>
    <p className="mt-2 break-words">{draft.preview?.title}</p>
    <p className="mt-2 text-muted-foreground">{t("workflowDraftContinuation.summary", { nodes: draft.preview?.node_count ?? 0, edges: draft.preview?.edge_count ?? 0 })}</p>
    {(draft.preview?.external_inputs?.length ?? 0) > 0 &&
      <p className="mt-2 text-muted-foreground">{t("workflowDraftContinuation.referenceImages")}: {draft.preview!.external_inputs!.map(
        (source) => source.display_name || source.node_id,
      ).join("、")}</p>}
    {error && <p role="alert" className="mt-2">{error}</p>}
    <div className="mt-3 flex justify-end gap-2">
      <button type="button" className="tap-button" disabled={busy || sending !== null} onClick={() => void cancel()}>
        {t(sending === "cancel" ? "workflowDraftContinuation.cancelling" : "workflowDraftContinuation.cancel")}
      </button>
      <button type="button" className="tap-button tap-button-quiet-primary" disabled={busy || sending !== null} onClick={() => void confirm()}>
        {t(sending === "confirm" ? "workflowDraftContinuation.sending" : draft.run_after_create ? "workflowDraftContinuation.confirmRun" : "workflowDraftContinuation.confirm")}
      </button>
    </div>
  </section>;
}
