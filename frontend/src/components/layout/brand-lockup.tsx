// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";

import type { OrgBrandingResponse } from "@/types/org-branding";

function OrganizationBrand({ logoUrl }: { logoUrl: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <span
      data-testid="organization-brand"
      className="hidden min-w-0 items-center xl:flex"
    >
      <span aria-hidden="true" className="mx-3 shrink-0 text-red-500">×</span>
      <img
        src={logoUrl}
        alt=""
        aria-hidden="true"
        onError={() => setFailed(true)}
        className="h-[22px] max-w-[96px] object-contain"
      />
    </span>
  );
}

export function BrandLockup({ value }: {
  value: OrgBrandingResponse | null | undefined;
}) {
  const organizationBrand = value?.organization && value.branding
    ? { logoUrl: value.branding.logo_url, updatedAt: value.branding.updated_at }
    : null;
  return (
    <span className="flex min-w-0 shrink-0 items-center">
      <img
        src="/brand/dramaclaw-wordmark.png"
        alt=""
        aria-hidden="true"
        className="h-[22.7px] w-auto max-w-[113px] object-contain"
      />
      {organizationBrand ? (
        <OrganizationBrand key={organizationBrand.updatedAt} logoUrl={organizationBrand.logoUrl} />
      ) : null}
    </span>
  );
}
