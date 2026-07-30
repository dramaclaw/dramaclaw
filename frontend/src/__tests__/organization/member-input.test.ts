// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  buildFailureSummary,
  parseBatchMemberInput,
  safeBatchResultCode,
  safeBatchResultStatus,
  safeOrgErrorKey,
} from "@/components/organization/member-input";
import { normalizeMemberSearch } from "@/components/organization/member-search";

describe("organization member input", () => {
  it("allowlists route search, preserves offset zero, and leaves the caller unchanged", () => {
    const input = {
      status: "active",
      role: "org_admin",
      q: "ali",
      sort: "updated_at",
      dir: "desc",
      limit: 20,
      offset: 0,
      org_id: "selector-canary",
      "X-Org-ID": "selector-canary",
      tenant_id: "selector-canary",
      token: "selector-canary",
      unknown: "selector-canary",
    };
    const snapshot = structuredClone(input);

    expect(normalizeMemberSearch(input)).toEqual({
      status: "active",
      role: "org_admin",
      q: "ali",
      sort: "updated_at",
      dir: "desc",
      limit: 20,
      offset: 0,
    });
    expect(input).toEqual(snapshot);
  });

  it("creates stable non-sensitive batch ids and never echoes malformed passwords", () => {
    const password = "SQL-DSN-password-canary";
    const parsed = parseBatchMemberInput(
      `existing|user-42\ncreate|new_user|Secret-pass-123\ncreate|short|${password}|extra`,
    );

    expect(parsed.items.map((item) => item.client_item_id)).toEqual([
      "row-001",
      "row-002",
    ]);
    expect(JSON.stringify(parsed.issues)).not.toContain(password);
  });

  it("renders only stable result status/code and maps unknown errors to a safe key", () => {
    const summary = buildFailureSummary([
      {
        client_item_id: "row-002",
        status: "rejected",
        code: "ORG_USER_HAS_CURRENT_ORG",
        member: null,
      },
    ]);

    expect(summary).toBe("row-002\tORG_USER_HAS_CURRENT_ORG");
    expect(safeBatchResultCode("PASSWORD_CANARY")).toBe("ORG_REQUEST_FAILED");
    expect(safeBatchResultStatus("SQL_DSN_TOKEN_CANARY")).toBe("rejected");
    expect(safeOrgErrorKey("SQL://token-password-canary")).toBe(
      "organization.errors.generic",
    );
  });
});
