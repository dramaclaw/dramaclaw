// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ky from "ky";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { useSyncProviderChannel } from "@/lib/queries/model-gateway";
import { ChannelModelInput, ChannelModelsButton } from "../channel-model-input";

vi.mock("@/lib/api", () => ({ api: ky.create({ baseUrl: "http://localhost:3000/" }) }));
afterEach(cleanup);
const endpoint = "http://localhost:3000/api/v1/model-gateway/custom/newapi/provider-channel/models";

function Form({ provider = "openai", initial = "", disabled = false }: { provider?: string; initial?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  const input = { provider, newApiBaseUrl: "http://127.0.0.1:3001" };
  return <>
    <ChannelModelsButton {...input} disabled={disabled} />
    <ChannelModelInput {...input} value={value} onChange={setValue} placeholder="上游模型" disabled={disabled} />
    <button type="button">Save mapping</button>
  </>;
}

function setup(props: Parameters<typeof Form>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<QueryClientProvider client={client}><Form {...props} /></QueryClientProvider>);
  return { ...view, client, user: userEvent.setup() };
}

describe("channel model input", () => {
  it("shares fetched models and filters/selects with the keyboard", async () => {
    let requests = 0;
    server.use(http.post(endpoint, () => {
      requests += 1;
      return HttpResponse.json({ ok: true, data: { provider: "openai", channelId: 7, models: ["gpt-4.1", "claude-sonnet", "gpt-image-1"] } });
    }));
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));
    await screen.findByRole("button", { name: "获取模型列表 (3)" });
    await user.click(screen.getByRole("button", { name: "选择渠道模型" }));
    expect(await screen.findByRole("option", { name: "claude-sonnet" })).toBeVisible();
    const input = screen.getByRole("combobox", { name: "上游模型" });
    await user.type(input, "gpt-4");
    await waitFor(() => expect(screen.queryByRole("option", { name: "claude-sonnet" })).not.toBeInTheDocument());
    await user.keyboard("{ArrowDown}{Enter}");
    expect(input).toHaveValue("gpt-4.1");
    expect(requests).toBe(1);
  });

  it("opens the full list when replacing an already selected model", async () => {
    server.use(http.post(endpoint, () => HttpResponse.json({ ok: true, data: { provider: "openai", channelId: 7, models: ["gpt-4.1", "gpt-image-1"] } })));
    const { user } = setup({ initial: "gpt-4.1" });
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));
    await screen.findByRole("button", { name: "获取模型列表 (2)" });
    await user.click(screen.getByRole("button", { name: "选择渠道模型" }));
    await user.click(await screen.findByRole("option", { name: "gpt-image-1" }));
    expect(screen.getByRole("combobox", { name: "上游模型" })).toHaveValue("gpt-image-1");
  });

  it.each(["escape", "outside", "tab"])("preserves manual model names when dismissing with %s", async (dismiss) => {
    server.use(http.post(endpoint, () => HttpResponse.json({ ok: true, data: { provider: "openai", channelId: 7, models: ["gpt-4.1"] } })));
    const { user } = setup({ initial: "unlisted-model" });
    const saveButton = screen.getByRole("button", { name: "Save mapping" });
    const input = screen.getByRole("combobox", { name: "上游模型" });
    await user.click(screen.getByRole("button", { name: "选择渠道模型" }));
    await screen.findByRole("status");
    if (dismiss === "escape") await user.keyboard("{Escape}");
    else if (dismiss === "tab") { await user.click(input); await user.tab(); }
    else await user.click(saveButton);
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(input).toHaveValue("unlisted-model");
    await user.clear(input);
    await user.type(input, "new-manual-model");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("new-manual-model");
  });

  it("preserves manual input when fetching fails", async () => {
    server.use(http.post(endpoint, () => HttpResponse.json({ detail: "unsupported" }, { status: 502 })));
    const { user } = setup({ initial: "my-custom-model" });
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("未能获取模型列表");
    const input = screen.getByRole("combobox", { name: "上游模型" });
    expect(input).toHaveValue("my-custom-model");
    await user.clear(input);
    await user.type(input, "provider-model-v2");
    expect(input).toHaveValue("provider-model-v2");
  });

  it("keeps an empty upstream list usable for manual names", async () => {
    server.use(http.post(endpoint, () => HttpResponse.json({ ok: true, data: { provider: "openai", channelId: 7, models: [] } })));
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));
    await screen.findByRole("button", { name: "获取模型列表 (0)" });
    await user.click(screen.getByRole("button", { name: "选择渠道模型" }));
    expect(await screen.findByRole("status")).toHaveTextContent("没有匹配的模型");
    await user.type(screen.getByRole("combobox", { name: "上游模型" }), "unlisted-model");
    expect(screen.getByRole("combobox", { name: "上游模型" })).toHaveValue("unlisted-model");
  });

  it("uses only the selected provider's cached list after switching", async () => {
    server.use(http.post(endpoint, async ({ request }) => {
      const body = await request.json() as { provider: string };
      return HttpResponse.json({ ok: true, data: { provider: body.provider, channelId: 7, models: body.provider === "openai" ? ["gpt-4.1"] : ["qwen-plus"] } });
    }));
    const { user, rerender, client } = setup();
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));
    await screen.findByRole("button", { name: "获取模型列表 (1)" });
    rerender(<QueryClientProvider client={client}><Form provider="ali" /></QueryClientProvider>);
    await user.click(screen.getByRole("button", { name: "选择渠道模型" }));
    expect(await screen.findByRole("option", { name: "qwen-plus" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "gpt-4.1" })).not.toBeInTheDocument();
  });

  it("clears old models after channel sync while preserving the selected model", async () => {
    let models = ["gpt-4.1"];
    server.use(
      http.post(endpoint, () => HttpResponse.json({ ok: true, data: { provider: "openai", channelId: 7, models } })),
      http.post(endpoint.replace("/models", "/sync"), () => {
        models = ["gpt-image-1"];
        return HttpResponse.json({ ok: true, data: { provider: "openai", channelId: 7 } });
      }),
    );
    const { user, client } = setup({ initial: "gpt-4.1" });
    await user.click(screen.getByRole("button", { name: "获取模型列表" }));
    await screen.findByRole("button", { name: "获取模型列表 (1)" });
    const { result } = renderHook(() => useSyncProviderChannel(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    await act(async () => { await result.current.mutateAsync({ provider: "openai", newApiBaseUrl: "http://127.0.0.1:3001" }); });
    await screen.findByRole("button", { name: "获取模型列表" });
    expect(screen.getByRole("combobox", { name: "上游模型" })).toHaveValue("gpt-4.1");
    await user.click(screen.getByRole("button", { name: "选择渠道模型" }));
    const input = screen.getByRole("combobox", { name: "上游模型" });
    await user.clear(input);
    await screen.findByRole("option", { name: "gpt-image-1" });
    expect(screen.queryByRole("option", { name: "gpt-4.1" })).not.toBeInTheDocument();
  });

  it("disables discovery and model editing when no channel is configured", () => {
    setup({ disabled: true });
    expect(screen.getByRole("button", { name: "获取模型列表" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "上游模型" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "选择渠道模型" })).toBeDisabled();
  });
});
