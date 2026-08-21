// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// OI-44: the generation entries never consumed `/org/me`. A member of an org
// whose tenant has no gateway key bound had `start_model_tasks: false` in the
// snapshot the backend already served, yet every canvas node let them press
// 生成 and walk into a server-side denial.
//
// This covers the shared gate the six entries read. Fail-closed is the whole
// point: an unreadable snapshot must disable, never allow.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse, type JsonBodyType } from "msw";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { useModelTaskAccess } from "@/lib/model-task-access";

const runtimeState = vi.hoisted(() => ({ isCeRuntime: false }));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const DENIAL_REASONS = [
  "MODEL_ACCESS_DENIED",
  "ORG_MEMBERSHIP_INACTIVE",
  "ORG_SUSPENDED",
  "ORG_CREDENTIAL_MISSING",
  "ORG_CREDENTIAL_DISABLED",
  "ORG_CREDENTIAL_GATEWAY_MISMATCH",
  "ORG_AUTHZ_STALE",
] as const;

const allowed = {
  user: { user_id: "u1", username: "alice", model_billing_entitlement: "platform" },
  organization: {
    org_id: "o1",
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

const noKeyBound = {
  ...allowed,
  capabilities: { ...allowed.capabilities, start_model_tasks: false },
  gateway_key: { state: "never_configured", key_version: null },
  denial_reason: "ORG_CREDENTIAL_MISSING",
};

function respondWith(body: JsonBodyType, status = 200) {
  const seen: string[] = [];
  server.use(
    http.get("*/api/v1/org/me", ({ request }) => {
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json(body, { status });
    }),
  );
  return seen;
}

function renderGate() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return renderHook(() => useModelTaskAccess(), {
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

describe("model task access gate", () => {
  beforeEach(() => {
    runtimeState.isCeRuntime = false;
  });

  it("allows a snapshot that grants start_model_tasks", async () => {
    respondWith(allowed);

    const { result } = renderGate();

    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(result.current.denialReason).toBeNull();
    expect(result.current.message).toBeNull();
  });

  it("blocks with the named reason when the tenant has no key bound", async () => {
    respondWith(noKeyBound);

    const { result } = renderGate();

    await waitFor(() =>
      expect(result.current.denialReason).toBe("ORG_CREDENTIAL_MISSING"),
    );
    expect(result.current.blocked).toBe(true);
    expect(result.current.message).toBe(
      "modelTaskAccess.blocked.ORG_CREDENTIAL_MISSING",
    );
  });

  it.each(DENIAL_REASONS)("blocks and names %s", async (reason) => {
    respondWith({
      ...allowed,
      capabilities: { ...allowed.capabilities, start_model_tasks: false },
      gateway_key: { state: "no_active", key_version: 2 },
      denial_reason: reason,
    });

    const { result } = renderGate();

    await waitFor(() => expect(result.current.denialReason).toBe(reason));
    expect(result.current.blocked).toBe(true);
    expect(result.current.message).toBe(`modelTaskAccess.blocked.${reason}`);
  });

  it("fails closed when the snapshot request errors", async () => {
    respondWith({ ok: false }, 500);

    const { result } = renderGate();

    await waitFor(() => expect(result.current.message).not.toBeNull());
    expect(result.current.blocked).toBe(true);
    expect(result.current.denialReason).toBeNull();
    expect(result.current.message).toBe("modelTaskAccess.blocked.generic");
  });

  it("fails closed when the snapshot fails its own coherence check", async () => {
    // `parseOrgMe` rejects `denial_reason: null` alongside `start_model_tasks:
    // false` and throws OrgApiError, so the query never yields `data`. Reading
    // only `data` would silently allow.
    respondWith({
      ...allowed,
      capabilities: { ...allowed.capabilities, start_model_tasks: false },
      denial_reason: null,
    });

    const { result } = renderGate();

    await waitFor(() => expect(result.current.message).not.toBeNull());
    expect(result.current.blocked).toBe(true);
    expect(result.current.message).toBe("modelTaskAccess.blocked.generic");
  });

  it("blocks without copy while the snapshot is still loading", () => {
    respondWith(allowed);

    const { result } = renderGate();

    expect(result.current.blocked).toBe(true);
    expect(result.current.message).toBeNull();
  });

  it("allows CE runtime without requesting the EE-only snapshot", async () => {
    runtimeState.isCeRuntime = true;
    const seen = respondWith(allowed);

    const { result } = renderGate();

    expect(result.current.blocked).toBe(false);
    expect(result.current.message).toBeNull();
    await waitFor(() => expect(result.current.blocked).toBe(false));
    expect(seen).toEqual([]);
  });
});

describe("model task access wiring", () => {
  const root = process.cwd();
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  // Gating one node is not a fix: a blocked member simply switches to another
  // node and hits the same denial. Every model-backed entry shares the gate.
  it.each([
    "src/features/canvas/nodes/ImageGenNode.tsx",
    "src/features/canvas/nodes/ImageEditNode.tsx",
    "src/features/canvas/nodes/VideoNode.tsx",
    "src/features/canvas/nodes/StoryboardGenNode.tsx",
    "src/features/canvas/nodes/ScriptNode.tsx",
    "src/features/canvas/nodes/useAudioGeneration.ts",
    "src/features/canvas/nodes/TextAnnotationNode.tsx",
    "src/features/canvas/nodes/ThreeDWorldNode.tsx",
  ])("%s consumes the shared gate", (path) => {
    expect(read(path)).toContain("useModelTaskAccess");
  });

  it.each(["zh", "en"])("%s defines copy for every denial reason", (language) => {
    const translations = JSON.parse(
      read(`public/locales/${language}/translation.json`),
    ) as { modelTaskAccess?: { blocked?: Record<string, unknown> } };
    const blocked = translations.modelTaskAccess?.blocked ?? {};

    for (const key of [...DENIAL_REASONS, "generic"]) {
      expect(blocked[key], `${language}: modelTaskAccess.blocked.${key}`)
        .toEqual(expect.any(String));
      expect(String(blocked[key]).length).toBeGreaterThan(0);
    }
  });
});
