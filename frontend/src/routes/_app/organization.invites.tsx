// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { normalizeInviteSearch } from "@/components/organization/invite-search";
import { OrganizationInvites } from "@/components/organization/organization-invites";
import { isCeRuntime } from "@/lib/runtime-config";
import type { InviteListParams } from "@/types/org";

function OrganizationInvitesRoute() {
  const { t } = useTranslation();
  if (isCeRuntime()) return <p>{t("organization.unavailable")}</p>;
  return <EeOrganizationInvitesRoute />;
}

function EeOrganizationInvitesRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <OrganizationInvites
      params={search}
      onParamsChange={(next: InviteListParams) => {
        void navigate({ to: "/organization/invites", search: normalizeInviteSearch(next as Record<string, unknown>), replace: true });
      }}
      onForbidden={() => { void navigate({ to: "/organization", replace: true }); }}
    />
  );
}

export const Route = createFileRoute("/_app/organization/invites")({
  validateSearch: (search) => normalizeInviteSearch(search as Record<string, unknown>),
  component: OrganizationInvitesRoute,
});
