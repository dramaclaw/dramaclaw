// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { AgentKeySettings } from "@/components/settings/agent-key-settings";
import { confirmDialog } from "@/components/confirm-dialog-host";
import { enT } from "@/__tests__/helpers/i18n-fixtures";

const FAKE_KEY = "st_agent_TESTONLY";

const api = vi.hoisted(() => ({
  call: vi.fn(),
  keys: [] as Array<Record<string, unknown>>,
  projects: [] as Array<Record<string, unknown>>,
  revokeError: null as Error | null,
}));

vi.mock("@/api/client", () => ({ apiCall: api.call }));
vi.mock("@/components/confirm-dialog-host", () => ({ confirmDialog: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: enT, i18n: { language: "en", resolvedLanguage: "en" } }),
}));

function keyRecord(overrides: Record<string, unknown>) {
  return {
    id: "key-x",
    label: "Key",
    agent_kind: "external-mcp",
    scopes: ["projects:read"],
    max_ttl_seconds: 3600,
    allowed_projects: [],
    created_at: "2026-11-01T08:00:00Z",
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    ...overrides,
  };
}

function installApi() {
  api.call.mockImplementation(async (path: string, options?: { method?: string; json?: unknown }) => {
    const method = (options?.method ?? "GET").toUpperCase();
    if (path === "projects" && method === "GET") return api.projects;
    if (path === "agent/keys" && method === "GET") return api.keys;
    if (path === "agent/keys" && method === "POST") {
      const body = options?.json as { label: string; agent_kind: string };
      return {
        id: "key-new",
        key: FAKE_KEY,
        label: body.label,
        agent_kind: body.agent_kind,
        scopes: ["projects:read"],
        max_ttl_seconds: 3600,
      };
    }
    const revoke = /^agent\/keys\/([^/]+)\/revoke$/.exec(path);
    if (revoke && method === "POST" && api.revokeError) throw api.revokeError;
    if (revoke && method === "POST") return { id: decodeURIComponent(revoke[1]), revoked: true };
    throw new Error(`unexpected request ${method} ${path}`);
  });
}

function listCalls() {
  return api.call.mock.calls.filter(
    ([path, options]) => path === "agent/keys" && (options?.method ?? "GET").toUpperCase() === "GET",
  ).length;
}

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <AgentKeySettings open />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

function keyItem(label: string) {
  const item = screen.getByText(label).closest("li");
  if (!item) throw new Error(`no list item for ${label}`);
  return item as HTMLElement;
}

beforeEach(() => {
  api.call.mockReset();
  api.keys = [];
  api.revokeError = null;
  api.projects = [
    { id: "proj-a", name: "alpha", display_name: "Alpha Story" },
    { id: "proj-b", name: "beta" },
  ];
  installApi();
  vi.mocked(confirmDialog).mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("AgentKeySettings", () => {
  it("shows the empty state when the user has no keys", async () => {
    renderSettings();
    expect(await screen.findByText(enT("settings.agentKeys.list.empty"))).toBeInTheDocument();
    expect(screen.getByText(enT("settings.agentKeys.intro"))).toBeInTheDocument();
  });

  it("creates a key for a selected project, reveals it once and clears it on Done", async () => {
    const { client } = renderSettings();
    await screen.findByText(enT("settings.agentKeys.list.empty"));
    const submit = screen.getByRole("button", { name: enT("settings.agentKeys.create.submit") });

    fireEvent.change(screen.getByLabelText(enT("settings.agentKeys.create.label")), {
      target: { value: "  Laptop MCP  " },
    });
    expect(submit).toBeDisabled();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Alpha Story" }));
    expect(submit).toBeEnabled();

    const listCallsBefore = listCalls();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(api.call).toHaveBeenCalledWith("agent/keys", {
        method: "POST",
        json: { label: "Laptop MCP", agent_kind: "external-mcp", allowed_projects: ["proj-a"] },
      }),
    );
    const revealed = await screen.findByLabelText(enT("settings.agentKeys.reveal.keyLabel"));
    expect(revealed).toHaveValue(FAKE_KEY);
    expect(revealed).toHaveAttribute("readonly");
    expect(screen.getByText(enT("settings.agentKeys.reveal.warning"))).toBeInTheDocument();
    expect(screen.getByText("Authorization: Bearer <key>")).toBeInTheDocument();
    // The web address serves /mcp, so clients get a URL they can paste as is.
    expect(screen.getByText(`${window.location.origin}/mcp/tools`)).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/mcp/workflows`)).toBeInTheDocument();
    await waitFor(() => expect(listCalls()).toBeGreaterThan(listCallsBefore));

    // The one-time secret must not be held by the shared query cache.
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(FAKE_KEY);
    expect(JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state.data))).not.toContain(FAKE_KEY);

    fireEvent.click(screen.getByRole("button", { name: enT("settings.agentKeys.reveal.done") }));
    expect(screen.queryByLabelText(enT("settings.agentKeys.reveal.keyLabel"))).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(FAKE_KEY)).not.toBeInTheDocument();
  });

  it("sends an empty project list for All projects and warns about the wider access", async () => {
    renderSettings();
    await screen.findByText(enT("settings.agentKeys.list.empty"));
    fireEvent.change(screen.getByLabelText(enT("settings.agentKeys.create.label")), {
      target: { value: "Everywhere" },
    });
    fireEvent.click(screen.getByRole("radio", { name: enT("settings.agentKeys.create.scopeAll") }));
    expect(screen.getByText(enT("settings.agentKeys.create.allWarning"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: enT("settings.agentKeys.create.submit") }));

    await waitFor(() =>
      expect(api.call).toHaveBeenCalledWith("agent/keys", {
        method: "POST",
        json: { label: "Everywhere", agent_kind: "external-mcp", allowed_projects: [] },
      }),
    );
  });

  it("keeps submit disabled without a label or without a selected project", async () => {
    renderSettings();
    await screen.findByRole("checkbox", { name: "Alpha Story" });
    const submit = screen.getByRole("button", { name: enT("settings.agentKeys.create.submit") });
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Alpha Story" }));
    fireEvent.change(screen.getByLabelText(enT("settings.agentKeys.create.label")), {
      target: { value: "   " },
    });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(enT("settings.agentKeys.create.label")), {
      target: { value: "Valid" },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Alpha Story" }));
    expect(submit).toBeDisabled();
  });

  it("copies the revealed key to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderSettings();
    await screen.findByText(enT("settings.agentKeys.list.empty"));
    fireEvent.change(screen.getByLabelText(enT("settings.agentKeys.create.label")), {
      target: { value: "Copy me" },
    });
    fireEvent.click(screen.getByRole("radio", { name: enT("settings.agentKeys.create.scopeAll") }));
    fireEvent.click(screen.getByRole("button", { name: enT("settings.agentKeys.create.submit") }));
    await screen.findByLabelText(enT("settings.agentKeys.reveal.keyLabel"));

    fireEvent.click(screen.getByRole("button", { name: enT("settings.agentKeys.reveal.copy") }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FAKE_KEY));
    expect(toast.success).toHaveBeenCalledWith(enT("settings.agentKeys.reveal.copied"));
  });

  it("shows status badges, scope and usage details for each key", async () => {
    api.keys = [
      keyRecord({ id: "key-active", label: "Laptop MCP", allowed_projects: ["proj-a", "proj-gone"] }),
      keyRecord({
        id: "key-revoked",
        label: "Old client",
        revoked_at: "2026-11-02T08:00:00Z",
        last_used_at: "2026-11-02T07:00:00Z",
      }),
      keyRecord({ id: "key-expired", label: "Short lived", expires_at: "2020-01-01T00:00:00Z" }),
    ];
    renderSettings();
    await screen.findByText("Laptop MCP");

    const active = keyItem("Laptop MCP");
    expect(within(active).getByText(enT("settings.agentKeys.status.active"))).toBeInTheDocument();
    await waitFor(() => expect(within(active).getByText(/Alpha Story/)).toBeInTheDocument());
    expect(within(active).getByText(/proj-gone/)).toBeInTheDocument();
    expect(within(active).getByText(enT("settings.agentKeys.list.neverUsed"))).toBeInTheDocument();
    expect(within(active).getByRole("button", { name: /Revoke/ })).toBeInTheDocument();

    const revoked = keyItem("Old client");
    expect(within(revoked).getByText(enT("settings.agentKeys.status.revoked"))).toBeInTheDocument();
    expect(within(revoked).getByText(enT("settings.agentKeys.list.allProjects"))).toBeInTheDocument();
    expect(within(revoked).queryByText(enT("settings.agentKeys.list.neverUsed"))).not.toBeInTheDocument();
    expect(within(revoked).queryByRole("button", { name: /Revoke/ })).not.toBeInTheDocument();

    const expired = keyItem("Short lived");
    expect(within(expired).getByText(enT("settings.agentKeys.status.expired"))).toBeInTheDocument();
    expect(within(expired).queryByRole("button", { name: /Revoke/ })).not.toBeInTheDocument();
  });

  it("revokes an active key only after confirmation and refetches the list", async () => {
    api.keys = [keyRecord({ id: "key-active", label: "Laptop MCP" })];
    renderSettings();
    await screen.findByText("Laptop MCP");
    const revokeButton = within(keyItem("Laptop MCP")).getByRole("button", { name: /Revoke/ });

    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    fireEvent.click(revokeButton);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(api.call).not.toHaveBeenCalledWith("agent/keys/key-active/revoke", { method: "POST" });

    const listCallsBefore = listCalls();
    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    fireEvent.click(revokeButton);
    await waitFor(() =>
      expect(api.call).toHaveBeenCalledWith("agent/keys/key-active/revoke", { method: "POST" }),
    );
    await waitFor(() => expect(listCalls()).toBeGreaterThan(listCallsBefore));
    expect(toast.success).toHaveBeenCalledWith(enT("settings.agentKeys.revoke.done"));
  });

  it("refetches the list and shows an error when revoking fails", async () => {
    api.keys = [keyRecord({ id: "key-active", label: "Laptop MCP" })];
    renderSettings();
    await screen.findByText("Laptop MCP");
    const listCallsBefore = listCalls();
    api.revokeError = new Error("Agent key not found");
    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    fireEvent.click(within(keyItem("Laptop MCP")).getByRole("button", { name: /Revoke/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Agent key not found"));
    await waitFor(() => expect(listCalls()).toBeGreaterThan(listCallsBefore));
  });

  it("shows a readable error when the key list cannot be loaded", async () => {
    api.call.mockImplementation(async (path: string) => {
      if (path === "agent/keys") throw new Error("Service unavailable");
      return api.projects;
    });
    renderSettings();
    expect(await screen.findByText("Service unavailable")).toBeInTheDocument();
  });
});
