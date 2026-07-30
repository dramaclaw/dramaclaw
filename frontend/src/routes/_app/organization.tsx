// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  createFileRoute,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { OrganizationOverview } from "@/components/organization/organization-overview";
import { isCeRuntime } from "@/lib/runtime-config";

function OrganizationRoute() {
  const { t } = useTranslation();
  if (isCeRuntime()) {
    return (
      <section className="mx-auto max-w-xl rounded-xl border p-6">
        <p>{t("organization.unavailable")}</p>
      </section>
    );
  }
  return <EeOrganizationRoute />;
}

function EeOrganizationRoute() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return pathname === "/organization" || pathname === "/organization/"
    ? <OrganizationOverview />
    : <Outlet />;
}

export const Route = createFileRoute("/_app/organization")({
  component: OrganizationRoute,
});
