// SPDX-License-Identifier: Elastic-2.0
import { useTranslation } from "react-i18next";
import type { PublishedSubscriptionAgreement } from "@/lib/queries/subscription-agreement";

export function SubscriptionAgreementContent({
  agreement,
}: {
  agreement: PublishedSubscriptionAgreement;
}) {
  const { t, i18n } = useTranslation();
  return (
    <>
      <p className="mt-3 text-sm text-muted-foreground">
        {t("subscriptionAgreementPage.version", { version: agreement.version })}{" "}
        ·{" "}
        {t("subscriptionAgreementPage.effectiveAt", {
          date: new Date(agreement.effective_at).toLocaleString(i18n.language),
        })}
      </p>
      {Date.parse(agreement.effective_at) > Date.now() && (
        <p className="mt-3 text-sm text-muted-foreground">
          {t("subscriptionAgreementPage.upcoming")}
        </p>
      )}
      <div className="mt-8 whitespace-pre-wrap break-words text-sm leading-8">
        {agreement.body}
      </div>
    </>
  );
}
