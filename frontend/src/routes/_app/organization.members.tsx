// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { OrganizationMembers } from "@/components/organization/organization-members";
import { normalizeMemberSearch } from "@/components/organization/member-search";
import { isCeRuntime } from "@/lib/runtime-config";
import type { MemberListParams } from "@/types/org";

function OrganizationMembersRoute() {
  const { t } = useTranslation();
  if (isCeRuntime()) {
    return (
      <section className="mx-auto max-w-xl rounded-xl border p-6">
        <p>{t("organization.unavailable")}</p>
      </section>
    );
  }
  return <EeOrganizationMembersRoute />;
}

function EeOrganizationMembersRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <OrganizationMembers
      params={search}
      onParamsChange={(next: MemberListParams) => {
        void navigate({
          to: "/organization/members",
          search: normalizeMemberSearch(next as Record<string, unknown>),
          replace: true,
        });
      }}
      onForbidden={() => {
        void navigate({ to: "/organization", replace: true });
      }}
    />
  );
}

export const Route = createFileRoute("/_app/organization/members")({
  validateSearch: (search) =>
    normalizeMemberSearch(search as Record<string, unknown>),
  component: OrganizationMembersRoute,
});
