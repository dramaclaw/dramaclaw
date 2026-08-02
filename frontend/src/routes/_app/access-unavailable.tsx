// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { AccessUnavailable } from "@/components/organization/access-unavailable";
import { clearOrganizationAccessCache } from "@/lib/org-access-state";
import { isCeRuntime } from "@/lib/runtime-config";

function AccessUnavailableRoute() {
  const { t } = useTranslation();
  if (isCeRuntime()) {
    return (
      <section className="mx-auto max-w-xl rounded-xl border p-6">
        <p>{t("organization.unavailable")}</p>
      </section>
    );
  }
  return <EeAccessUnavailableRoute />;
}

function EeAccessUnavailableRoute() {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void clearOrganizationAccessCache(queryClient).then(() => {
      if (active) setReady(true);
    });
    return () => { active = false; };
  }, [queryClient]);

  return ready ? <AccessUnavailable /> : null;
}

export const Route = createFileRoute("/_app/access-unavailable")({
  component: AccessUnavailableRoute,
});
