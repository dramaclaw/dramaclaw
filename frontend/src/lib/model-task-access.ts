// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { presentOrganizationAccess } from "@/lib/org-access-state";
import { useOrgMe } from "@/lib/queries/org";
import { isCeRuntime } from "@/lib/runtime-config";
import type { OrgAccessDenialReason } from "@/types/org";

export interface ModelTaskAccess {
  /** True while a model task must not be started from this client. */
  blocked: boolean;
  denialReason: OrgAccessDenialReason | null;
  /** Translated reason for the block, or null when there is nothing to say. */
  message: string | null;
}

const ALLOWED: ModelTaskAccess = { blocked: false, denialReason: null, message: null };

function messageKey(reason: OrgAccessDenialReason | null): string {
  return `modelTaskAccess.blocked.${reason ?? "generic"}`;
}

/**
 * Shared admission gate for every generation entry.
 *
 * `/org/me` already decides whether the signed-in member may start model
 * tasks — a tenant with no gateway key bound comes back with
 * `start_model_tasks: false` — but no canvas node read that decision, so the
 * member pressed 生成 and met a server-side denial instead of a disabled
 * button (OI-44).
 *
 * Fail-closed: an unreadable or still-loading snapshot blocks. The endpoint is
 * EE-only, so CE builds never consult it and are never blocked.
 */
export function useModelTaskAccess(): ModelTaskAccess {
  const { t } = useTranslation();
  const ce = isCeRuntime();
  const query = useOrgMe(!ce);
  const { data, isError } = query;

  // Memoised: consumers put this in `useCallback` dependency arrays, and a
  // fresh object every render would invalidate every submit handler.
  return useMemo(() => {
    if (ce) return ALLOWED;
    // `parseOrgMe` throws OrgApiError on an incoherent snapshot, so a denial
    // can arrive with no `data` at all. Reading only `data` would allow.
    if (isError) {
      return { blocked: true, denialReason: null, message: t(messageKey(null)) };
    }
    // Disable while loading, but say nothing — copy that flashes on every
    // mount reads as a real denial.
    if (data === undefined) {
      return { blocked: true, denialReason: null, message: null };
    }
    const access = presentOrganizationAccess(data);
    if (access.canStart) return ALLOWED;
    return {
      blocked: true,
      denialReason: access.denialReason,
      message: t(messageKey(access.denialReason)),
    };
  }, [ce, data, isError, t]);
}
