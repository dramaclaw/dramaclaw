// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import { useTranslation } from "react-i18next";

type CheckoutRefreshStatus = "stale" | "updated" | null;

export function useCheckoutPolicyRefresh(version: number | undefined) {
  const [rejectedVersion, setRejectedVersion] = useState<number | null>();
  const requiresRefresh = rejectedVersion !== undefined &&
    (version === undefined || version === rejectedVersion);
  const status: CheckoutRefreshStatus = requiresRefresh ? "stale" : rejectedVersion !== undefined ? "updated" : null;
  return {
    status,
    reject: () => setRejectedVersion(version ?? null),
    clear: () => setRejectedVersion(undefined),
  };
}

export function CheckoutRefreshNotice({
  status,
  refreshing,
  onRefresh,
}: {
  status: CheckoutRefreshStatus;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  if (!status) return null;
  const needsRefresh = status === "stale";
  const message = needsRefresh
    ? refreshing ? "checkout.settingsRefreshing" : "checkout.settingsRefreshFailed"
    : "checkout.settingsUpdated";
  return (
    <div className="mt-5 space-y-2 text-sm">
      <p role="status" className={needsRefresh && !refreshing ? "text-warning" : "text-muted-foreground"}>
        {t(message)}
      </p>
      {needsRefresh && !refreshing && (
        <button type="button" onClick={onRefresh} className="text-primary underline">
          {t("checkout.refreshSettings")}
        </button>
      )}
    </div>
  );
}
