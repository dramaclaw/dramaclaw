import { useCallback, useEffect, useState } from "react";
import i18next from "i18next";
import { api } from "@/lib/api";

export type CanvasConfirmation = {
  id: string;
  agent_id: string;
  turn_id: string;
  kinds: ("delete_nodes" | "clear_canvas" | "paid_generation")[];
  targets: { node_id: string; title: string; node_type: string; action: string }[];
  command_hash: string;
  created_at: number;
  expires_at: number;
};

export type CanvasConfirmationDecision = "confirmed" | "refused";

type CanvasConfirmationScope = {
  projectId: string;
  canvasId: string;
  agentIds: string[];
};

type CanvasConfirmationDecisionResult = {
  confirmation_id: string;
  status: "executed" | "submitted" | "refused";
};

function confirmationsPath(projectId: string, canvasId: string): string {
  return `api/v1/projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}/confirmations`;
}

export async function listCanvasConfirmations({
  projectId, canvasId, agentIds, signal,
}: CanvasConfirmationScope & { signal?: AbortSignal }): Promise<CanvasConfirmation[]> {
  const response = await api.get(confirmationsPath(projectId, canvasId), {
    searchParams: new URLSearchParams(agentIds.map((id) => ["agent_ids", id])),
    signal,
  }).json<{ ok: boolean; data: { confirmations: CanvasConfirmation[] } }>();
  return response.data.confirmations;
}

export async function decideCanvasConfirmation({
  projectId, canvasId, confirmation, decision,
}: Pick<CanvasConfirmationScope, "projectId" | "canvasId"> & {
  confirmation: CanvasConfirmation;
  decision: CanvasConfirmationDecision;
}): Promise<CanvasConfirmationDecisionResult> {
  const response = await api.post(
    `${confirmationsPath(projectId, canvasId)}/${encodeURIComponent(confirmation.id)}/decision`,
    {
      throwHttpErrors: false,
      json: {
        decision,
        via: "card",
        agent_id: confirmation.agent_id,
        turn_id: confirmation.turn_id,
        command_hash: confirmation.command_hash,
      },
    },
  );
  const body = await response.json<{
    data: CanvasConfirmationDecisionResult;
    detail?: { message?: unknown };
  }>().catch(() => null);
  if (!response.ok || !body) {
    throw new Error(typeof body?.detail?.message === "string"
      ? body.detail.message
      : i18next.t("freezone.chat.canvasConfirmation.failed"));
  }
  return body.data;
}

export function useCanvasConfirmations({
  projectId, canvasId, agentIds, intervalMs = 3000,
}: CanvasConfirmationScope & { intervalMs?: number }) {
  const [confirmations, setConfirmations] = useState<CanvasConfirmation[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const agentQuery = new URLSearchParams(agentIds.map((id) => ["agent_ids", id])).toString();
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    setConfirmations([]);
  }, [projectId, canvasId, agentQuery]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await listCanvasConfirmations({
          projectId, canvasId,
          agentIds: new URLSearchParams(agentQuery).getAll("agent_ids"),
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setConfirmations(next);
      } catch {
        // Keep the last list until a subsequent poll succeeds.
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, intervalMs);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [projectId, canvasId, agentQuery, intervalMs, refreshKey]);

  return { confirmations, refresh };
}
