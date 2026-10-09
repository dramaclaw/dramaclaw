import { memo, useCallback } from "react";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface NodeIdBadgeProps {
  nodeId: string;
}

export const NodeIdBadge = memo(({ nodeId }: NodeIdBadgeProps) => {
  const { t } = useTranslation();

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(nodeId);
      toast.success(t("nodeToolbar.copied"));
    } catch (error) {
      console.warn("[canvas] failed to copy node id", error);
    }
  }, [nodeId, t]);

  return (
    <button
      type="button"
      className="flex h-9 max-w-[260px] items-center gap-1.5 rounded-[12px] border border-white/10 bg-white/[0.035] px-2.5 text-xs text-text-muted transition-colors hover:bg-white/[0.075] hover:text-text-dark"
      onClick={(event) => {
        event.stopPropagation();
        void handleCopy();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      title={t("nodeToolbar.copyNodeId")}
    >
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-text-faint">
        {t("nodeToolbar.nodeId")}
      </span>
      <span className="min-w-0 max-w-[160px] truncate font-mono text-[11px]">
        {nodeId}
      </span>
      <Copy className="h-3.5 w-3.5 shrink-0" />
    </button>
  );
});

NodeIdBadge.displayName = "NodeIdBadge";
