// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export type ModelBillingEntitlement = "platform" | "org_sponsored" | "disabled";
export type OrgRole = "org_admin" | "org_member";
export type OrgStatus = "active" | "suspended";
export type MembershipStatus = "active" | "suspended" | "left";

export interface OrgMeUser {
  user_id: string;
  username: string;
  model_billing_entitlement: ModelBillingEntitlement;
}

export interface OrgMeOrganization {
  org_id: string;
  name: string;
  status: OrgStatus;
  updated_at?: string | null;
}

export interface OrgMeMembership {
  role: OrgRole;
  membership_status: Exclude<MembershipStatus, "left">;
  updated_at?: string | null;
}

export interface OrgCapabilities {
  manage_members: boolean;
  manage_invites: boolean;
}

export interface OrgMe {
  user: OrgMeUser;
  organization: OrgMeOrganization | null;
  membership: OrgMeMembership | null;
  capabilities: OrgCapabilities;
  denial_reason?: string | null;
}

export interface Member {
  user_id: string;
  username: string;
  role: OrgRole;
  membership_status: MembershipStatus;
  model_billing_entitlement: ModelBillingEntitlement;
  created_at?: string | null;
  updated_at?: string | null;
}

export type AddMemberRequest =
  | { mode: "existing"; user_id: string }
  | { mode: "create"; username: string; password: string };

export type BatchMemberItem =
  | { client_item_id: string; mode: "existing"; user_id: string }
  | { client_item_id: string; mode: "create"; username: string; password: string };

export interface BatchMembersRequest {
  items: BatchMemberItem[];
}

export interface PatchMemberRequest {
  role?: OrgRole | null;
  membership_status?: MembershipStatus | null;
  expected_updated_at: string;
}

export interface BatchMemberResultItem {
  client_item_id: string;
  status: "created" | "existing" | "rejected";
  code?: string | null;
  member?: Member | null;
}

export interface BatchMemberResult {
  accepted_count: number;
  rejected_count: number;
  items: BatchMemberResultItem[];
}

export type InviteStatus = "pending" | "expired" | "revoked" | "accepted";

export interface Invite {
  invite_id: string;
  target_masked: string;
  role?: "org_member";
  status: InviteStatus;
  expires_at: string;
  accepted_at?: string | null;
  created_at?: string | null;
}

export interface CreateInviteRequest {
  target_username: string;
  expires_in_hours?: number;
}

export interface InviteCreateResult {
  invite: Invite;
  token: string | null;
}

export interface InvitePreview {
  org_name: string;
  target_masked: string;
  role?: "org_member";
  status: "pending";
  expires_at: string;
}

export type AcceptInviteRequest =
  | { mode: "existing" }
  | { mode: "create"; username: string; password: string };

export interface InviteAcceptResult {
  user_id: string;
  org_id: string;
  role: "org_member";
  membership_status: "active";
  model_billing_entitlement: ModelBillingEntitlement;
}

export interface OrgFieldError {
  path: string;
  code: string;
  message: string;
}

export interface OrgErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    request_id: string;
    field_errors?: OrgFieldError[] | null;
  };
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
}

export interface MemberListParams {
  status?: MembershipStatus;
  role?: OrgRole;
  q?: string;
  sort?: "username" | "created_at" | "updated_at" | "role" | "status";
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface InviteListParams {
  status?: InviteStatus;
  sort?: "created_at" | "expires_at" | "status";
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface IdempotentRequest<T> {
  body: T;
  idempotencyKey: string;
}
