// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { OrganizationGatewayKey } from "@/components/organization/organization-gateway-key";
import { isCeRuntime } from "@/lib/runtime-config";

function OrganizationGatewayKeyRoute() {
  const { t } = useTranslation();
  if (isCeRuntime()) {
    return (
      <section className="mx-auto max-w-xl rounded-xl border p-6">
        <p>{t("organization.unavailable")}</p>
      </section>
    );
  }
  return <EeOrganizationGatewayKeyRoute />;
}

function EeOrganizationGatewayKeyRoute() {
  const navigate = useNavigate();
  return (
    <OrganizationGatewayKey
      onForbidden={() => { void navigate({ to: "/organization", replace: true }); }}
    />
  );
}

export const Route = createFileRoute("/_app/organization/gateway-key")({
  component: OrganizationGatewayKeyRoute,
});
