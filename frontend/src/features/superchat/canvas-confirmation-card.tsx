import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  decideCanvasConfirmation,
  useCanvasConfirmations,
  type CanvasConfirmation,
  type CanvasConfirmationDecision,
} from "@/features/superchat/canvas-confirmations";

export function CanvasConfirmationCard({
  confirmation, nowMs, busy, error, onDecide,
}: {
  confirmation: CanvasConfirmation;
  nowMs: number;
  busy: boolean;
  error?: string;
  onDecide: (decision: CanvasConfirmationDecision) => void;
}) {
  const { t } = useTranslation();
  const title = confirmation.kinds.map((kind) => t(`freezone.chat.canvasConfirmation.kind.${kind}`))
    .join(t("freezone.chat.canvasConfirmation.separator"));
  const minutes = Math.max(1, Math.ceil((confirmation.expires_at * 1000 - nowMs) / 60_000));

  return (
    <div className="mt-3 w-full min-w-0 overflow-hidden rounded-xl border border-amber-400/25 bg-background/95 text-xs text-muted-foreground shadow-lg backdrop-blur-sm">
      <div className="flex items-start gap-2 border-b border-amber-400/15 px-3 py-2">
        <div className="text-sm font-medium text-foreground">{title}</div>
      </div>
      <div className="space-y-1 px-3 py-2">
        {confirmation.targets.map((target, index) => (
          <p key={`${target.node_id}:${index}`}>{target.title || target.node_id} · {target.node_type}</p>
        ))}
        {confirmation.kinds.includes("paid_generation") && (
          <p>{t("freezone.chat.canvasConfirmation.credits")}</p>
        )}
        <p>{t("freezone.chat.canvasConfirmation.expiresIn", { minutes })}</p>
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-amber-400/15 px-3 py-2.5">
        <Button size="xs" variant="outline" disabled={busy} onClick={() => onDecide("refused")}>
          {t("freezone.chat.canvasConfirmation.refuse")}
        </Button>
        <Button size="xs" disabled={busy} onClick={() => onDecide("confirmed")}>
          {t("freezone.chat.canvasConfirmation.confirm")}
        </Button>
      </div>
    </div>
  );
}

export function CanvasConfirmationStack({
  projectId, canvasId, agentIds,
}: {
  projectId: string;
  canvasId: string;
  agentIds: string[];
}) {
  const { t } = useTranslation();
  const { confirmations, refresh } = useCanvasConfirmations({ projectId, canvasId, agentIds });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [decisions, setDecisions] = useState<Record<string, { busy: boolean; error?: string }>>({});
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const onDecide = async (confirmation: CanvasConfirmation, decision: CanvasConfirmationDecision) => {
    setDecisions((current) => ({ ...current, [confirmation.id]: { busy: true } }));
    try {
      await decideCanvasConfirmation({ projectId, canvasId, confirmation, decision });
      setDecisions((current) => ({ ...current, [confirmation.id]: { busy: false } }));
    } catch (error) {
      setDecisions((current) => ({
        ...current,
        [confirmation.id]: {
          busy: false,
          error: error instanceof Error ? error.message : t("freezone.chat.canvasConfirmation.failed"),
        },
      }));
    } finally {
      refresh();
    }
  };

  if (confirmations.length === 0) return null;
  return (
    <div className="mb-2.5">
      {confirmations.map((confirmation) => (
        <CanvasConfirmationCard
          key={confirmation.id}
          confirmation={confirmation}
          nowMs={nowMs}
          busy={decisions[confirmation.id]?.busy ?? false}
          error={decisions[confirmation.id]?.error}
          onDecide={(decision) => { void onDecide(confirmation, decision); }}
        />
      ))}
    </div>
  );
}
