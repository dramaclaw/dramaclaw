// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState, type ComponentProps } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SUBTLE_HEADER_ACTION_BUTTON_CLASS } from "@/components/ui/header-action-styles";
import { useTransientConfirmation } from "@/hooks/use-transient-confirmation";
import { cn } from "@/lib/utils";

type HeaderRefreshButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "disabled" | "onClick" | "size" | "variant"
> & {
  label: string;
  onRefresh: () => Promise<boolean>;
  refreshing: boolean;
  disabled?: boolean;
};

export function HeaderRefreshButton({
  label,
  onRefresh,
  refreshing,
  disabled = false,
  className,
  ...buttonProps
}: HeaderRefreshButtonProps) {
  const { t } = useTranslation();
  const confirmation = useTransientConfirmation();
  const [locallyPending, setLocallyPending] = useState(false);
  const pending = refreshing || locallyPending;
  const confirmationLabel = t("common.refreshDone");

  return (
    <Button
      {...buttonProps}
      variant="outline"
      size="sm"
      onClick={async () => {
        if (pending) return;
        confirmation.clearConfirmation();
        setLocallyPending(true);
        try {
          if (await onRefresh()) confirmation.showConfirmation();
        } catch {
          toast.error(t("common.error"));
        } finally {
          setLocallyPending(false);
        }
      }}
      disabled={disabled || pending}
      className={cn(SUBTLE_HEADER_ACTION_BUTTON_CLASS, className)}
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : confirmation.confirmed ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <RefreshCw className="size-3.5" aria-hidden="true" />
      )}
      <span className="grid" aria-live="polite">
        <span
          className="invisible col-start-1 row-start-1"
          aria-hidden="true"
        >
          {label}
        </span>
        <span
          className="invisible col-start-1 row-start-1"
          aria-hidden="true"
        >
          {confirmationLabel}
        </span>
        <span className="col-start-1 row-start-1">
          {confirmation.confirmed ? confirmationLabel : label}
        </span>
      </span>
    </Button>
  );
}
