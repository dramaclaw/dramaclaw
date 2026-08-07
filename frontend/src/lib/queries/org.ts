// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery } from "@tanstack/react-query";
import { HTTPError } from "ky";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { OrgMe } from "@/types/org";

const KNOWN_ERROR_CODES = new Set([
  "AUTH_REQUIRED",
  "ORG_CONTEXT_REQUIRED",
  "MODEL_ACCESS_DENIED",
  "ORG_MEMBERSHIP_INACTIVE",
  "ORG_SUSPENDED",
  "ORG_CREDENTIAL_MISSING",
  "ORG_CREDENTIAL_DISABLED",
  "ORG_AUTHZ_STALE",
  "ORG_INTERNAL_ERROR",
]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ORG_ME_FIELDS = new Set([
  "user",
  "organization",
  "membership",
  "capabilities",
  "gateway_key",
  "denial_reason",
]);
const ORG_ME_USER_FIELDS = new Set([
  "user_id",
  "username",
  "model_billing_entitlement",
]);
const ORG_ME_ORGANIZATION_FIELDS = new Set([
  "org_id",
  "name",
  "status",
  "updated_at",
]);
const ORG_ME_MEMBERSHIP_FIELDS = new Set([
  "role",
  "membership_status",
  "updated_at",
]);
const ORG_CAPABILITY_FIELDS = new Set([
  "manage_members",
  "manage_invites",
  "manage_gateway_key",
  "start_model_tasks",
]);
const ORG_GATEWAY_SUMMARY_FIELDS = new Set(["state", "key_version"]);
const ORG_ACCESS_DENIAL_REASONS = new Set([
  "MODEL_ACCESS_DENIED",
  "ORG_MEMBERSHIP_INACTIVE",
  "ORG_SUSPENDED",
  "ORG_CREDENTIAL_MISSING",
  "ORG_CREDENTIAL_DISABLED",
  "ORG_CREDENTIAL_GATEWAY_MISMATCH",
  "ORG_AUTHZ_STALE",
]);
const GATEWAY_ZONED_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: Set<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isZonedDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = GATEWAY_ZONED_DATETIME.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  return year >= 1 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 &&
    second <= 59 && offsetHour <= 14 && offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0) && Number.isFinite(Date.parse(value));
}

function isOrgMeUser(value: unknown): boolean {
  return isRecord(value) && hasExactFields(value, ORG_ME_USER_FIELDS) &&
    isNonEmptyString(value.user_id) && isNonEmptyString(value.username) &&
    ["platform", "org_sponsored", "disabled"].includes(
      String(value.model_billing_entitlement),
    );
}

function isOrgMeOrganization(value: unknown): boolean {
  return value === null || (
    isRecord(value) && hasExactFields(value, ORG_ME_ORGANIZATION_FIELDS) &&
    isNonEmptyString(value.org_id) && isNonEmptyString(value.name) &&
    ["active", "suspended"].includes(String(value.status)) &&
    (value.updated_at === null || isZonedDateTime(value.updated_at))
  );
}

function isOrgMeMembership(value: unknown): boolean {
  return value === null || (
    isRecord(value) && hasExactFields(value, ORG_ME_MEMBERSHIP_FIELDS) &&
    ["org_admin", "org_member"].includes(String(value.role)) &&
    ["active", "suspended"].includes(String(value.membership_status)) &&
    (value.updated_at === null || isZonedDateTime(value.updated_at))
  );
}

function isOrgCapabilities(value: unknown): boolean {
  return isRecord(value) && hasExactFields(value, ORG_CAPABILITY_FIELDS) &&
    [...ORG_CAPABILITY_FIELDS].every((field) => typeof value[field] === "boolean");
}

function parseGatewaySummary(value: unknown): OrgMe["gateway_key"] | null {
  if (!isRecord(value) || !hasExactFields(value, ORG_GATEWAY_SUMMARY_FIELDS) ||
    typeof value.state !== "string") return null;
  if (value.state === "never_configured") {
    return value.key_version === null
      ? { state: value.state, key_version: value.key_version }
      : null;
  }
  const hasValidVersion = Number.isSafeInteger(value.key_version) &&
    Number(value.key_version) > 0;
  // gateway_mismatch is the active row seen from a deployment pointed at a
  // different gateway, so it carries a real version like active/no_active.
  if (value.state === "active" || value.state === "no_active" ||
    value.state === "gateway_mismatch") {
    return hasValidVersion
      ? { state: value.state, key_version: Number(value.key_version) }
      : null;
  }
  return value.key_version === null || hasValidVersion
    ? {
        state: "unknown",
        key_version: value.key_version === null ? null : Number(value.key_version),
      }
    : null;
}

function parseOrgMe(value: unknown, status: number): OrgMe {
  if (
    !isRecord(value) || !hasExactFields(value, ORG_ME_FIELDS) ||
    !isOrgMeUser(value.user) || !isOrgMeOrganization(value.organization) ||
    !isOrgMeMembership(value.membership) || !isOrgCapabilities(value.capabilities)
  ) {
    throw new OrgApiError({ status });
  }
  const gatewayKey = parseGatewaySummary(value.gateway_key);
  if (gatewayKey === null ||
    !(value.denial_reason === null || typeof value.denial_reason === "string")) {
    throw new OrgApiError({ status });
  }
  const capabilities = { ...(value.capabilities as OrgMe["capabilities"]) };
  let denialReason: OrgMe["denial_reason"];
  if (value.denial_reason === null || ORG_ACCESS_DENIAL_REASONS.has(value.denial_reason)) {
    denialReason = value.denial_reason as OrgMe["denial_reason"];
    const hasCoherentAccessDecision = denialReason === null
      ? gatewayKey.state === "unknown" || capabilities.start_model_tasks === true
      : capabilities.start_model_tasks === false;
    if (!hasCoherentAccessDecision) {
      throw new OrgApiError({ status });
    }
  } else {
    denialReason = null;
    capabilities.start_model_tasks = false;
  }
  if (gatewayKey.state === "unknown") {
    capabilities.start_model_tasks = false;
  }
  return {
    user: { ...(value.user as OrgMe["user"]) },
    organization: value.organization === null
      ? null
      : { ...(value.organization as NonNullable<OrgMe["organization"]>) },
    membership: value.membership === null
      ? null
      : { ...(value.membership as NonNullable<OrgMe["membership"]>) },
    capabilities,
    gateway_key: gatewayKey,
    denial_reason: denialReason,
  };
}

export class OrgApiError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly requestId: string | null;

  constructor(values: { status: number | null; code?: string; requestId?: string | null }) {
    super("Organization request failed");
    this.name = "OrgApiError";
    this.status = values.status;
    this.code = values.code ?? "ORG_REQUEST_FAILED";
    this.requestId = values.requestId ?? null;
  }
}

async function toOrgApiError(error: unknown): Promise<OrgApiError> {
  if (!(error instanceof HTTPError)) return new OrgApiError({ status: null });
  let value: unknown = (error as HTTPError & { data?: unknown }).data;
  if (value === undefined) {
    try {
      value = await error.response.clone().json();
    } catch {
      value = null;
    }
  }
  const envelope = isRecord(value) && value.ok === false && isRecord(value.error)
    ? value.error
    : null;
  const code = envelope && typeof envelope.code === "string" && KNOWN_ERROR_CODES.has(envelope.code)
    ? envelope.code
    : "ORG_REQUEST_FAILED";
  const requestId = envelope && typeof envelope.request_id === "string" &&
    REQUEST_ID_PATTERN.test(envelope.request_id)
    ? envelope.request_id
    : null;
  return new OrgApiError({ status: error.response.status, code, requestId });
}

function orgUrl(path: "me"): URL {
  return new URL(`/api/v1/org/${path}`, window.location.origin);
}

export async function getOrgMe(): Promise<OrgMe> {
  let response: Response;
  try {
    response = await api.get(orgUrl("me"));
  } catch (error) {
    throw await toOrgApiError(error);
  }
  try {
    return parseOrgMe(await response.json(), response.status);
  } catch (error) {
    if (error instanceof OrgApiError) throw error;
    throw new OrgApiError({ status: response.status });
  }
}

export function useOrgMe() {
  return useQuery({
    queryKey: queryKeys.orgMe(),
    queryFn: getOrgMe,
    refetchOnWindowFocus: true,
  });
}
