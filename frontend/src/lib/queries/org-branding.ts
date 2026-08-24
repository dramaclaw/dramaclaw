// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { OrgBrandingResponse } from "@/types/org-branding";

const LOGO_PATH = /^\/assets\/org-brand\/([A-Za-z0-9_-]+)\/logo$/;
const ZONED_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBranding(value: unknown): OrgBrandingResponse | null {
  if (!isRecord(value) || value.schema_version !== 1) return null;
  if (value.organization === null && value.branding === null) {
    return { schema_version: 1, organization: null, branding: null };
  }
  if (!isRecord(value.organization) ||
      typeof value.organization.org_id !== "string" || !value.organization.org_id.trim() ||
      typeof value.organization.name !== "string" || !value.organization.name.trim()) {
    return null;
  }
  const organization = {
    org_id: value.organization.org_id.trim(),
    name: value.organization.name.trim(),
  };
  if (value.branding === null) {
    return { schema_version: 1, organization, branding: null };
  }
  if (!isRecord(value.branding) || typeof value.branding.logo_url !== "string" ||
      typeof value.branding.updated_at !== "string" ||
      !ZONED_TIME.test(value.branding.updated_at) ||
      !Number.isFinite(Date.parse(value.branding.updated_at))) {
    return null;
  }
  const match = LOGO_PATH.exec(value.branding.logo_url);
  if (!match || match[1] !== organization.org_id) {
    return null;
  }
  return {
    schema_version: 1,
    organization,
    branding: {
      logo_url: value.branding.logo_url,
      updated_at: value.branding.updated_at,
    },
  };
}

export async function getOrgBranding(): Promise<OrgBrandingResponse | null> {
  try {
    const url = new URL("/api/v1/org/branding", window.location.origin);
    const value = await api.get(url, { retry: 0 }).json<unknown>();
    return parseBranding(value);
  } catch {
    return null;
  }
}

export function useOrgBranding(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.orgBranding(),
    queryFn: getOrgBranding,
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
