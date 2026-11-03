// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import ky from "ky";
import { beforeEach, expect, it, vi } from "vitest";
import { server } from "@/__mocks__/msw/server";
import {
  VoiceDesignHistoryPanel,
  VoiceDesignRetentionHint,
} from "@/components/assets/voice-design-history";
import type { VoiceDesignReady } from "@/types/voice-design";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
}));
const base = "http://localhost:3000/api/v1/projects/demo";
const candidate = (index: number): VoiceDesignReady => ({
  candidate_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  model: null,
  status: "ready",
  description: `候选 ${index}`,
  preview_text: "今天我们沿着河边慢慢走回家，天色渐渐暗了。",
  language: "zh",
  preview_url: `/api/v1/projects/demo/voice-design/candidates/00000000-0000-4000-8000-${String(index).padStart(12, "0")}/audio`,
  mime_type: "audio/mpeg",
  duration_seconds: 4,
  sha256: "a".repeat(64),
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 604800000).toISOString(),
});
const asset = {
  asset_id: "11111111-1111-4111-8111-111111111111",
  name: "候选 1",
  url: "/static/voice.mp3",
  sha256: "a".repeat(64),
  duration_seconds: 4,
};
function show(onSelect = vi.fn(), onSaved = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <VoiceDesignHistoryPanel
        project="demo"
        onSelect={onSelect}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  );
  return { onSelect, onSaved };
}
beforeEach(() => server.resetHandlers());

it("pages beyond five previews and selects an older exact candidate without generating or quoting", async () => {
  const reads: URL[] = [];
  let writes = 0;
  server.use(
    http.get(`${base}/voice-design/candidates`, ({ request }) => {
      const url = new URL(request.url);
      reads.push(url);
      return HttpResponse.json({
        ok: true,
        data: {
          candidates: url.searchParams.has("cursor")
            ? [candidate(1)]
            : Array.from({ length: 20 }, (_, i) => candidate(21 - i)),
          next_cursor: url.searchParams.has("cursor") ? null : "older",
          retention_seconds: 604800,
        },
      });
    }),
    http.post(`${base}/voice-design/candidates`, () => {
      writes++;
      return HttpResponse.error();
    }),
  );
  const { onSelect } = show();
  expect(await screen.findByText("候选 21")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "选择此试听" })).toHaveLength(
    20,
  );
  expect(screen.getByText(/7 天/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByText("候选 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "选择此试听" }));
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({
      candidate_id: candidate(1).candidate_id,
      description: "候选 1",
    }),
  );
  expect(reads[0]?.searchParams.get("limit")).toBe("20");
  expect(reads[1]?.searchParams.get("cursor")).toBe("older");
  expect(writes).toBe(0);
  expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  expect(await screen.findByText("候选 21")).toBeInTheDocument();
});

it("saves explicitly to the project and retries the exact failed intent without applying to a role", async () => {
  const inputs: unknown[] = [];
  let saved = false;
  let roleWrites = 0;
  server.use(
    http.get(`${base}/voice-design/candidates`, () =>
      HttpResponse.json({
        ok: true,
        data: {
          candidates: saved ? [] : [candidate(1)],
          next_cursor: null,
          retention_seconds: 604800,
        },
      }),
    ),
    http.post(
      `${base}/voice-design/candidates/${candidate(1).candidate_id}/save-to-library`,
      async ({ request }) => {
        inputs.push(await request.json());
        if (inputs.length === 1)
          return HttpResponse.json(
            {
              ok: false,
              error: "保存失败",
              code: "save_failed",
              retryable: true,
              request_id: "test",
            },
            { status: 503 },
          );
        saved = true;
        return HttpResponse.json({ ok: true, data: asset });
      },
    ),
    http.post(
      `${base}/characters/:name/voice-samples/:slot/apply-library`,
      () => {
        roleWrites++;
        return HttpResponse.error();
      },
    ),
  );
  const { onSaved, onSelect } = show();
  fireEvent.click(
    await screen.findByRole("button", { name: "保存到项目资产库" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "确认保存到项目" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
  expect(screen.getByRole("textbox", { name: "资产名称" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(inputs[1]).toEqual(inputs[0]);
  expect(roleWrites).toBe(0);
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.getByText("暂无未保存的试听。")).toBeInTheDocument();
});

it("does not let an expired preview be chosen, played or published", async () => {
  server.use(
    http.get(`${base}/voice-design/candidates`, () =>
      HttpResponse.json({
        ok: true,
        data: {
          candidates: [
            {
              ...candidate(1),
              expires_at: new Date(Date.now() - 1000).toISOString(),
            },
          ],
          next_cursor: null,
          retention_seconds: 3600,
        },
      }),
    ),
  );
  show();
  await screen.findByText("候选 1");
  expect(screen.getByRole("button", { name: "选择此试听" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "试听" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "保存到项目资产库" }),
  ).toBeDisabled();
  expect(screen.getByText(/1 小时/)).toBeInTheDocument();
  expect(screen.queryByText(/7 天/)).toBeNull();
});

it("does not invent a retention duration before the server responds", () => {
  render(<VoiceDesignRetentionHint />);
  expect(
    screen.getByText("每条试听按显示的到期时间自动删除；已保存音频不受影响。"),
  ).toBeInTheDocument();
});

it("shows an explicitly configured short retention without rounding it up", () => {
  render(<VoiceDesignRetentionHint seconds={30} />);
  expect(screen.getByText("未保存试听保留 30 秒，到期后自动删除；已保存音频不受影响。")).toBeInTheDocument();
});

it("keeps a valid emoji in a sixty-character default asset name and response", async () => {
  const name = "a".repeat(59) + "🙂";
  const original = { ...candidate(1), description: name + "后续描述" };
  let savedName: unknown;
  server.use(
    http.get(`${base}/voice-design/candidates`, () => HttpResponse.json({ ok: true, data: { candidates: [original], next_cursor: null, retention_seconds: 604800 } })),
    http.post(`${base}/voice-design/candidates/${original.candidate_id}/save-to-library`, async ({ request }) => {
      const body = await request.json();
      savedName = typeof body === "object" && body !== null && "name" in body ? body.name : undefined;
      return HttpResponse.json({ ok: true, data: { ...asset, name } });
    }),
  );
  const { onSaved } = show();
  fireEvent.click(await screen.findByRole("button", { name: "保存到项目资产库" }));
  expect(screen.getByRole("textbox", { name: "资产名称" })).toHaveValue(name);
  fireEvent.click(screen.getByRole("button", { name: "确认保存到项目" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(savedName).toBe(name);
});
