// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Link } from "@tanstack/react-router";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { presentOrganizationAccess } from "@/lib/org-access-state";
import { useOrgMe } from "@/lib/queries/org";

export function AccessUnavailable() {
  const { t } = useTranslation();
  const query = useOrgMe();

  if (query.isPending) {
    return (
      <section role="status" aria-label={t("organization.access.loading")}
        className="mx-auto max-w-xl space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40" />
      </section>
    );
  }

  if (query.isError) {
    return (
      <section className="mx-auto max-w-xl space-y-4 rounded-xl border p-6">
        <h1 className="text-xl font-semibold">{t("organization.access.title")}</h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {t("organization.access.reasons.generic")}
        </p>
        <Button type="button" variant="outline" onClick={() => query.refetch()}>
          <RefreshCw className="size-4" />
          {t("organization.access.retry")}
        </Button>
      </section>
    );
  }

  const access = presentOrganizationAccess(query.data);
  const reasonKey = access.canStart
    ? "organization.access.available"
    : access.denialReason
      ? `organization.access.reasons.${access.denialReason}`
      : "organization.access.reasons.generic";

  return (
    <section className="mx-auto max-w-xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4" />
            {t("organization.access.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p role="status" className="text-sm text-muted-foreground">
            {t(reasonKey)}
          </p>
          <Link className="text-sm font-medium text-primary hover:underline"
            to="/organization">
            {t("organization.access.back")}
          </Link>
        </CardContent>
      </Card>
    </section>
  );
}
