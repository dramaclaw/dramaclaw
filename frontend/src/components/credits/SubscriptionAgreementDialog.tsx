// SPDX-License-Identifier: Elastic-2.0
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSubscriptionAgreement } from "@/lib/queries/subscription-agreement";
import { SubscriptionAgreementContent } from "./SubscriptionAgreementContent";

export function SubscriptionAgreementDialog({
  agreementId,
  version,
  contentHash,
  fingerprint,
  disabled,
  onClose,
  onAccept,
}: {
  agreementId: string | null | undefined;
  version: number | null | undefined;
  contentHash: string | null | undefined;
  fingerprint: string;
  disabled: boolean;
  onClose: () => void;
  onAccept: () => void;
}) {
  const { t } = useTranslation();
  const query = useSubscriptionAgreement(
    agreementId ?? "",
    String(version ?? ""),
  );
  const row = query.data?.data;
  const [checkedFor, setCheckedFor] = useState<string | null>(null);
  const matches = Boolean(
    row &&
    row.agreement_id === agreementId &&
    row.version === version &&
    contentHash &&
    row.content_hash === contentHash &&
    typeof row.body === "string" &&
    row.body.trim() &&
    Date.parse(row.effective_at) <= Date.now(),
  );
  const canAccept =
    query.isSuccess && matches && !query.isFetching && !disabled;
  const checked = checkedFor === fingerprint;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(760px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden bg-[var(--ui-surface-modal)] p-0 text-foreground sm:max-w-3xl"
        overlayClassName="bg-black/40 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
      >
        <div className="relative shrink-0 border-b border-border p-5">
          <DialogTitle className="break-words pr-8 text-lg font-semibold leading-7">
            {matches && row ? row.title : t("subscriptions.terms")}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm leading-6">
            {t("subscriptionAgreementDialog.description")}
          </DialogDescription>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-3 top-3"
            aria-label={t("subscriptionAgreementDialog.closeLabel")}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div
          role="region"
          aria-label={t("subscriptionAgreementDialog.body")}
          tabIndex={0}
          className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4 [overflow-wrap:anywhere]"
        >
          {query.valid && query.isPending && (
            <p role="status">{t("subscriptionAgreementPage.loading")}</p>
          )}
          {(!query.valid || query.isError || (query.isSuccess && !matches)) && (
            <div role="alert" className="space-y-3">
              <p>{t("subscriptionAgreementPage.unavailable")}</p>
              <p className="text-sm text-muted-foreground">
                {query.isSuccess
                  ? t("subscriptionAgreementDialog.changed")
                  : t("subscriptionAgreementPage.unavailableHint")}
              </p>
              {query.valid && (
                <Button
                  variant="outline"
                  disabled={query.isFetching}
                  onClick={() => void query.refetch()}
                >
                  {t("subscriptions.refresh")}
                </Button>
              )}
            </div>
          )}
          {matches && row && <SubscriptionAgreementContent agreement={row} />}
        </div>
        <div className="shrink-0 border-t border-border p-5">
          <label className="flex items-start gap-3 text-sm leading-6">
            <input
              type="checkbox"
              checked={checked}
              disabled={!canAccept}
              onChange={(event) =>
                setCheckedFor(event.target.checked ? fingerprint : null)
              }
              className="mt-1 accent-primary"
            />
            <span>{t("subscriptionAgreementDialog.consent")}</span>
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("subscriptionAgreementDialog.close")}
            </Button>
            <Button
              disabled={!canAccept || !checked}
              onClick={() => {
                if (canAccept && checked) {
                  onAccept();
                  onClose();
                }
              }}
            >
              {t("subscriptionAgreementDialog.confirm")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
