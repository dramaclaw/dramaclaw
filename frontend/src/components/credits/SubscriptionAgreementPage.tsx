// SPDX-License-Identifier: Elastic-2.0
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useSubscriptionAgreement } from "@/lib/queries/subscription-agreement";
import { SubscriptionAgreementContent } from "./SubscriptionAgreementContent";

export function SubscriptionAgreementPage({
  agreementId,
  version,
}: {
  agreementId: string;
  version: string;
}) {
  const { t } = useTranslation();
  // A fresh tab can include about:blank in its history; only return to an app source.
  const hasPreviousPage =
    window.history.length > 1 &&
    document.referrer.startsWith(`${window.location.origin}/`);
  const query = useSubscriptionAgreement(agreementId, version);
  const valid = query.valid;
  const row = query.data?.data;
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="ui-scrollbar h-dvh overflow-y-auto overscroll-contain bg-background text-foreground"
    >
      <header className="sticky top-0 z-10 border-b border-border bg-background">
        <div className="px-5 py-3 sm:px-8">
          <a
            href="/credits"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            onClick={(event) => {
              if (hasPreviousPage) {
                event.preventDefault();
                window.history.back();
              }
            }}
          >
            <ArrowLeft aria-hidden="true" />
            {t(
              hasPreviousPage
                ? "subscriptionAgreementPage.back"
                : "subscriptionAgreementPage.backToSubscriptions",
            )}
          </a>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8">
        {valid && query.isPending && (
          <p role="status">{t("subscriptionAgreementPage.loading")}</p>
        )}
        {(!valid || query.isError) && (
          <section className="space-y-4" role="alert">
            <h1 className="text-xl font-semibold">
              {t("subscriptionAgreementPage.unavailable")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("subscriptionAgreementPage.unavailableHint")}
            </p>
            {valid && (
              <Button variant="outline" onClick={() => void query.refetch()}>
                {t("subscriptions.refresh")}
              </Button>
            )}
          </section>
        )}
        {row && (
          <article className="break-words">
            <h1 className="text-2xl font-semibold">{row.title}</h1>
            <SubscriptionAgreementContent agreement={row} />
          </article>
        )}
      </div>
    </main>
  );
}
