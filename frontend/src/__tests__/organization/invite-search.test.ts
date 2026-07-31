// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { normalizeInviteSearch } from "@/components/organization/invite-search";

describe("invite search normalization", () => {
  it("keeps only valid invite filters including offset zero", () => {
    const input = {
      status: "pending",
      sort: "expires_at",
      dir: "asc",
      limit: 20,
      offset: 0,
    };

    expect(normalizeInviteSearch(input)).toEqual(input);
    expect(input).toEqual({
      status: "pending",
      sort: "expires_at",
      dir: "asc",
      limit: 20,
      offset: 0,
    });
  });

  it("drops tenant, credential, header and unknown selectors", () => {
    expect(
      normalizeInviteSearch({
        org_id: "org-canary",
        tenant_id: "tenant-canary",
        token: "token-canary",
        authorization: "Bearer canary",
        "X-Org-ID": "header-canary",
        callback: "https://evil.example",
      }),
    ).toEqual({});
  });

  it("drops malformed enum and pagination values", () => {
    expect(
      normalizeInviteSearch({
        status: "unknown",
        sort: "org_id",
        dir: "sideways",
        limit: 0,
        offset: -1,
      }),
    ).toEqual({});
  });
});
