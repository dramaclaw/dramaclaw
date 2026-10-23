// SPDX-License-Identifier: Elastic-2.0
import { createFileRoute } from "@tanstack/react-router";
import { SubscriptionAgreementPage } from "@/components/credits/SubscriptionAgreementPage";

export const Route = createFileRoute(
  "/terms/subscription/$agreementId/$version",
)({
  component: AgreementRoute,
});

function AgreementRoute() {
  const { agreementId, version } = Route.useParams();
  return (
    <SubscriptionAgreementPage agreementId={agreementId} version={version} />
  );
}
