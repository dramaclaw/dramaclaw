// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { QueryClient } from "@tanstack/react-query";

import type { OrgAccessDenialReason, OrgMe } from "@/types/org";

const DENIAL_REASONS = new Set<OrgAccessDenialReason>([
  "MODEL_ACCESS_DENIED",
  "ORG_MEMBERSHIP_INACTIVE",
  "ORG_SUSPENDED",
  "ORG_CREDENTIAL_MISSING",
  "ORG_CREDENTIAL_DISABLED",
  "ORG_AUTHZ_STALE",
]);

export interface OrganizationAccessPresentation {
  canStart: boolean;
  denialReason: OrgAccessDenialReason | null;
  hasCurrentOrganization: boolean;
}

export function presentOrganizationAccess(value: unknown): OrganizationAccessPresentation {
  const unavailable: OrganizationAccessPresentation = {
    canStart: false,
    denialReason: null,
    hasCurrentOrganization: false,
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return unavailable;
  }
  const snapshot = value as Partial<OrgMe>;
  const capabilities = snapshot.capabilities as Record<string, unknown> | undefined;
  const start = capabilities?.start_model_tasks;
  const denial = snapshot.denial_reason;
  if (
    typeof start !== "boolean" ||
    !(denial === null || (typeof denial === "string" &&
      DENIAL_REASONS.has(denial as OrgAccessDenialReason))) ||
    start !== (denial === null)
  ) {
    return {
      ...unavailable,
      hasCurrentOrganization: snapshot.organization !== null &&
        snapshot.organization !== undefined,
    };
  }
  return {
    canStart: start,
    denialReason: denial as OrgAccessDenialReason | null,
    hasCurrentOrganization: snapshot.organization !== null,
  };
}

export async function clearOrganizationAccessCache(client: QueryClient): Promise<void> {
  await client.cancelQueries({ queryKey: ["org"] });
  client.removeQueries({ queryKey: ["org"] });
}
