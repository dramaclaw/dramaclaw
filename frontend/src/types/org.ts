// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export type ModelBillingEntitlement = "platform" | "org_sponsored" | "disabled";
export type OrgRole = "org_admin" | "org_member";
export type OrgStatus = "active" | "suspended";

export interface OrgMeUser {
  user_id: string;
  username: string;
  model_billing_entitlement: ModelBillingEntitlement;
}

export interface OrgMeOrganization {
  org_id: string;
  name: string;
  status: OrgStatus;
  updated_at: string | null;
}

export interface OrgMeMembership {
  role: OrgRole;
  membership_status: "active" | "suspended";
  updated_at: string | null;
}

/** Exact capability fields returned by the authoritative /org/me wire contract. */
export interface OrgCapabilities {
  manage_members: boolean;
  manage_invites: boolean;
  manage_gateway_key: boolean;
  start_model_tasks: boolean;
}

export type OrgAccessDenialReason =
  | "MODEL_ACCESS_DENIED"
  | "ORG_MEMBERSHIP_INACTIVE"
  | "ORG_SUSPENDED"
  | "ORG_CREDENTIAL_MISSING"
  | "ORG_CREDENTIAL_DISABLED"
  | "ORG_AUTHZ_STALE";

export interface GatewayKeySummary {
  state: "never_configured" | "active" | "no_active" | "unknown";
  key_version: number | null;
}

export interface OrgMe {
  user: OrgMeUser;
  organization: OrgMeOrganization | null;
  membership: OrgMeMembership | null;
  capabilities: OrgCapabilities;
  gateway_key: GatewayKeySummary;
  denial_reason: OrgAccessDenialReason | null;
}
