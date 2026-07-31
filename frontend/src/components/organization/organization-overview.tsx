// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Building2, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrgMe } from "@/lib/queries/org";

type RuntimeRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RuntimeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSafeActiveContext(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isRecord(value.user) ||
    !isRecord(value.organization) ||
    !isRecord(value.membership) ||
    !isRecord(value.capabilities)
  ) {
    return false;
  }
  return (
    typeof value.user.user_id === "string" &&
    typeof value.user.username === "string" &&
    ["platform", "org_sponsored", "disabled"].includes(
      String(value.user.model_billing_entitlement),
    ) &&
    typeof value.organization.org_id === "string" &&
    value.organization.org_id.trim().length > 0 &&
    typeof value.organization.name === "string" &&
    value.organization.status === "active" &&
    typeof value.organization.updated_at === "string" &&
    value.organization.updated_at.trim().length > 0 &&
    ["org_admin", "org_member"].includes(String(value.membership.role)) &&
    value.membership.membership_status === "active" &&
    typeof value.membership.updated_at === "string" &&
    value.membership.updated_at.trim().length > 0 &&
    typeof value.capabilities.manage_members === "boolean" &&
    typeof value.capabilities.manage_invites === "boolean"
  );
}

export function OrganizationOverview() {
  const { t } = useTranslation();
  const query = useOrgMe();

  if (query.isPending) {
    return (
      <section
        role="status"
        aria-label={t("organization.loading")}
        className="mx-auto max-w-5xl space-y-5"
      >
        <Skeleton className="h-9 w-56" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
      </section>
    );
  }

  if (query.isError || !isRecord(query.data)) {
    return (
      <section className="mx-auto flex max-w-xl flex-col items-start gap-4 rounded-xl border p-6">
        <h1 className="text-xl font-semibold">{t("organization.title")}</h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {t("organization.errors.generic")}
        </p>
        <Button type="button" variant="outline" onClick={() => query.refetch()}>
          <RefreshCw className="size-4" />
          {t("organization.retry")}
        </Button>
      </section>
    );
  }

  const org = isRecord(query.data.organization) ? query.data.organization : null;
  const membership = isRecord(query.data.membership) ? query.data.membership : null;
  const user = isRecord(query.data.user) ? query.data.user : null;
  const capabilities = isRecord(query.data.capabilities)
    ? query.data.capabilities
    : null;
  const safeActive = hasSafeActiveContext(query.data);
  const canManageMembers =
    safeActive &&
    !query.isFetching &&
    membership?.role === "org_admin" &&
    capabilities?.manage_members === true;
  const canManageInvites =
    safeActive &&
    !query.isFetching &&
    membership?.role === "org_admin" &&
    capabilities?.manage_invites === true;
  const readOnly = Boolean(org && membership && (!safeActive || !canManageMembers));

  return (
    <section
      className="mx-auto max-w-5xl space-y-6"
      aria-busy={query.isFetching && !query.isPending}
    >
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("organization.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("organization.subtitle")}
        </p>
      </header>

      {!org || !membership ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("organization.empty.title")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {t("organization.empty.description")}
          </CardContent>
        </Card>
      ) : (
        <>
          {readOnly ? (
            <div
              role="status"
              className="rounded-lg border border-amber-500/35 bg-amber-500/8 p-4"
            >
              <p className="font-medium">{t("organization.readOnly.title")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("organization.readOnly.description")}
              </p>
            </div>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="size-4" />
                  {t("organization.cards.organization")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Detail label={t("organization.fields.name")} value={org.name} />
                <Detail
                  label={t("organization.fields.status")}
                  value={statusLabel(org.status, t)}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserRound className="size-4" />
                  {t("organization.cards.membership")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Detail label={t("organization.fields.user")} value={user?.username} />
                <Detail
                  label={t("organization.fields.role")}
                  value={roleLabel(membership.role, t)}
                />
                <Detail
                  label={t("organization.fields.membershipStatus")}
                  value={statusLabel(membership.membership_status, t)}
                />
                <Detail
                  label={t("organization.fields.entitlement")}
                  value={entitlementLabel(user?.model_billing_entitlement, t)}
                />
              </CardContent>
            </Card>
          </div>
          {canManageMembers || canManageInvites ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="size-4" />
                  {t("organization.cards.management")}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {canManageMembers ? (
                  <Button render={<Link to="/organization/members" />}>
                    {t("organization.actions.manageMembers")}
                  </Button>
                ) : null}
                {canManageInvites ? (
                  <Button render={<Link to="/organization/invites" />}>
                    {t("organization.actions.manageInvites")}
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">
        {typeof value === "string" || typeof value === "number" ? value : "—"}
      </dd>
    </div>
  );
}

function roleLabel(value: unknown, t: (key: string) => string): string {
  if (value === "org_admin") return t("organization.roles.admin");
  if (value === "org_member") return t("organization.roles.member");
  return t("organization.values.unknown");
}

function statusLabel(value: unknown, t: (key: string) => string): string {
  if (value === "active") return t("organization.status.active");
  if (value === "suspended") return t("organization.status.suspended");
  if (value === "left") return t("organization.status.left");
  return t("organization.values.unknown");
}

function entitlementLabel(value: unknown, t: (key: string) => string): string {
  if (value === "platform") return t("organization.entitlement.platform");
  if (value === "org_sponsored") {
    return t("organization.entitlement.orgSponsored");
  }
  if (value === "disabled") return t("organization.entitlement.disabled");
  return t("organization.values.unknown");
}
