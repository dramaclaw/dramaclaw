// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  clearOrganizationAccessCache,
  presentOrganizationAccess,
} from "@/lib/org-access-state";

const snapshot = {
  user: {
    user_id: "user-1",
    username: "alice",
    model_billing_entitlement: "platform",
  },
  organization: {
    org_id: "org-1",
    name: "Acme",
    status: "active",
    updated_at: "2026-08-02T00:00:00Z",
  },
  membership: {
    role: "org_member",
    membership_status: "active",
    updated_at: "2026-08-02T00:00:00Z",
  },
  capabilities: {
    manage_members: false,
    manage_invites: false,
    manage_gateway_key: false,
    start_model_tasks: true,
  },
  gateway_key: { state: "active", key_version: 3 },
  denial_reason: null,
};

describe("organization access presentation", () => {
  it("passes through only the authoritative start boolean", () => {
    expect(presentOrganizationAccess(snapshot)).toEqual({
      canStart: true,
      denialReason: null,
      hasCurrentOrganization: true,
    });
    expect(
      presentOrganizationAccess({
        ...snapshot,
        capabilities: { ...snapshot.capabilities, start_model_tasks: false },
        denial_reason: "MODEL_ACCESS_DENIED",
      }),
    ).toEqual({
      canStart: false,
      denialReason: "MODEL_ACCESS_DENIED",
      hasCurrentOrganization: true,
    });
  });

  it("presents a normalized unknown denial as unavailable for the current organization", () => {
    expect(
      presentOrganizationAccess({
        ...snapshot,
        capabilities: { ...snapshot.capabilities, start_model_tasks: false },
        denial_reason: null,
      }),
    ).toEqual({
      canStart: false,
      denialReason: null,
      hasCurrentOrganization: true,
    });
  });

  it.each([
    ["missing capability", { ...snapshot, capabilities: {} }],
    [
      "inferred-looking active facts",
      { ...snapshot, capabilities: { ...snapshot.capabilities, start_model_tasks: "yes" } },
    ],
    [
      "contradictory denial",
      { ...snapshot, denial_reason: "ORG_CREDENTIAL_MISSING" },
    ],
  ])("fails closed for %s", (_name, value) => {
    expect(presentOrganizationAccess(value).canStart).toBe(false);
  });

  it("clears only organization cache and preserves unrelated state", async () => {
    const client = new QueryClient();
    client.setQueryData(["org", "me"], snapshot);
    client.setQueryData(["org", "members"], ["member"]);
    client.setQueryData(["projects", "p1"], "project-sentinel");
    client.setQueryData(["episodes", "p1"], "episode-sentinel");
    client.setQueryData(["media", "p1"], "media-sentinel");
    client.setQueryData(["tasks"], "task-sentinel");

    await clearOrganizationAccessCache(client);

    expect(client.getQueryData(["org", "me"])).toBeUndefined();
    expect(client.getQueryData(["org", "members"])).toBeUndefined();
    expect(client.getQueryData(["projects", "p1"])).toBe("project-sentinel");
    expect(client.getQueryData(["episodes", "p1"])).toBe("episode-sentinel");
    expect(client.getQueryData(["media", "p1"])).toBe("media-sentinel");
    expect(client.getQueryData(["tasks"])).toBe("task-sentinel");
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
});
