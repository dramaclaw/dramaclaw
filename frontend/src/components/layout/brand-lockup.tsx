// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";

import type { OrgBrandingResponse } from "@/types/org-branding";

function OrganizationBrand({
  logoUrl,
  onError,
  onLoad,
}: {
  logoUrl: string;
  onError?: (logoUrl: string) => void;
  onLoad?: (logoUrl: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <span
      data-testid="organization-brand"
      className="hidden min-w-0 items-center xl:flex"
    >
      <span aria-hidden="true" className="mx-3 h-5 w-px shrink-0 bg-white/20" />
      <img
        src={logoUrl}
        alt=""
        aria-hidden="true"
        onLoad={() => onLoad?.(logoUrl)}
        onError={() => {
          setFailed(true);
          onError?.(logoUrl);
        }}
        className="h-[22px] max-w-[96px] object-contain"
      />
    </span>
  );
}

export function BrandLockup({
  value,
  onOrganizationBrandError,
  onOrganizationBrandLoad,
}: {
  value: OrgBrandingResponse | null | undefined;
  onOrganizationBrandError?: (logoUrl: string) => void;
  onOrganizationBrandLoad?: (logoUrl: string) => void;
}) {
  const organizationBrand = value?.organization && value.branding
    ? { logoUrl: value.branding.logo_url }
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
        <OrganizationBrand
          key={organizationBrand.logoUrl}
          logoUrl={organizationBrand.logoUrl}
          onError={onOrganizationBrandError}
          onLoad={onOrganizationBrandLoad}
        />
      ) : null}
    </span>
  );
}
