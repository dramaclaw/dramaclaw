// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {
  BatchMemberItem,
  BatchMemberResultItem,
} from "@/types/org";

export interface BatchInputIssue {
  clientItemId: string;
  code: "invalid_format";
}

export function parseBatchMemberInput(value: string): {
  items: BatchMemberItem[];
  issues: BatchInputIssue[];
} {
  const items: BatchMemberItem[] = [];
  const issues: BatchInputIssue[] = [];
  value.split(/\r?\n/).forEach((rawLine, index) => {
    if (!rawLine.trim()) return;
    const clientItemId = `row-${String(index + 1).padStart(3, "0")}`;
    const parts = rawLine.split("|");
    if (parts[0] === "existing" && parts.length === 2 && parts[1].trim()) {
      items.push({
        client_item_id: clientItemId,
        mode: "existing",
        user_id: parts[1].trim(),
      });
      return;
    }
    if (
      parts[0] === "create" &&
      parts.length === 3 &&
      parts[1].trim().length >= 3 &&
      parts[2].length >= 8
    ) {
      items.push({
        client_item_id: clientItemId,
        mode: "create",
        username: parts[1].trim(),
        password: parts[2],
      });
      return;
    }
    issues.push({ clientItemId, code: "invalid_format" });
  });
  return { items, issues };
}

export function buildFailureSummary(items: BatchMemberResultItem[]): string {
  return items
    .filter((item) => item.status === "rejected")
    .map((item) => `${item.client_item_id}\t${safeBatchResultCode(item.code)}`)
    .join("\n");
}

const SAFE_ERROR_KEYS: Record<string, string> = {
  ORG_USER_ALREADY_MEMBER: "organization.errors.alreadyMember",
  ORG_MEMBER_ALREADY_EXISTS: "organization.errors.alreadyMember",
  ORG_USER_HAS_CURRENT_ORG: "organization.errors.otherOrganization",
  USER_CURRENT_ORG_CONFLICT: "organization.errors.otherOrganization",
  ORG_MEMBER_LIMIT_REACHED: "organization.errors.memberLimit",
  ORG_LAST_ADMIN: "organization.errors.lastAdmin",
  ORG_LAST_ACTIVE_ADMIN: "organization.errors.lastAdmin",
  ORG_CONCURRENT_MODIFICATION: "organization.errors.concurrent",
  RESOURCE_VERSION_CONFLICT: "organization.errors.concurrent",
  ORG_ADMIN_REQUIRED: "organization.errors.forbidden",
  ORG_MEMBERSHIP_INACTIVE: "organization.errors.inactive",
  ORG_SUSPENDED: "organization.errors.suspended",
  ORG_REQUEST_INVALID: "organization.errors.invalid",
};

const SAFE_BATCH_RESULT_CODES = new Set([
  "ORG_USER_ALREADY_MEMBER",
  "ORG_MEMBER_ALREADY_EXISTS",
  "ORG_USER_HAS_CURRENT_ORG",
  "USER_CURRENT_ORG_CONFLICT",
  "ORG_MEMBER_LIMIT_REACHED",
  "ORG_REQUEST_INVALID",
  "ORG_REQUEST_FAILED",
]);

export function safeBatchResultCode(code: string | null | undefined): string {
  return code && SAFE_BATCH_RESULT_CODES.has(code)
    ? code
    : "ORG_REQUEST_FAILED";
}

export function safeBatchResultStatus(status: string): string {
  return ["created", "existing", "rejected"].includes(status)
    ? status
    : "rejected";
}

export function safeOrgErrorKey(code: string | undefined): string {
  return code
    ? SAFE_ERROR_KEYS[code] ?? "organization.errors.generic"
    : "organization.errors.generic";
}
