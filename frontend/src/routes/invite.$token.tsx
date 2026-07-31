// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { InviteAcceptance } from "@/components/organization/invite-acceptance";
import { isCeRuntime } from "@/lib/runtime-config";

function InviteRoute() {
  const { t } = useTranslation();
  if (isCeRuntime()) return <p>{t("organization.unavailable")}</p>;
  return <EeInviteRoute />;
}

function EeInviteRoute() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  return <InviteAcceptance key={token} token={token} onExistingAccepted={() => { void navigate({ to: "/organization", replace: true }); }} />;
}

function installNoReferrerPolicy() {
  let meta = document.head.querySelector<HTMLMetaElement>('meta[name="referrer"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "referrer";
    document.head.append(meta);
  }
  meta.content = "no-referrer";
}

export const Route = createFileRoute("/invite/$token")({
  beforeLoad: installNoReferrerPolicy,
  component: InviteRoute,
});
