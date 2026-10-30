// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { delay, http, HttpResponse } from "msw";
import { server } from "@/__mocks__/msw/server";
import ky from "ky";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/", timeout: 100 }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));
import {
  VoiceDesignDialog,
  type VoiceDesignTarget,
} from "@/components/assets/voice-design-dialog";
import { VoiceDesignApiError } from "@/lib/queries/voice-design";
import zh from "../../../../public/locales/zh/translation.json";
const i18n = i18next.createInstance();
const base = "http://localhost:3000/api/v1/projects/demo/voice-design";
const text = "今天的天气很好，我们沿着河边慢慢走回家。";
let creations = 0;
let candidateId = "";
const save = vi.fn(async (_input: unknown) => {});
const target: VoiceDesignTarget = {
  kind: "character",
  key: "秦:default",
  label: "秦 · 默认",
  saveLabel: "保存到默认",
  expectedSlot: { path: "old.wav", sha256: "old", updated_at: "before" },
  onSave: save,
  onRefresh: async () => {},
};
function ready(
  id: string,
  expiry = new Date(Date.now() + 3600000).toISOString(),
) {
  return {
    candidate_id: id,
    status: "ready",
    description: "温柔",
    preview_text: text,
    language: "zh",
    preview_url: `/api/v1/projects/demo/voice-design/candidates/${id}/audio`,
    mime_type: "audio/mpeg",
    duration_seconds: 8.4,
    sha256: "a".repeat(64),
    created_at: new Date().toISOString(),
    expires_at: expiry,
  };
}
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    resources: { zh: { translation: zh } },
    interpolation: { escapeValue: false },
  });
});
beforeEach(() => {
  creations = 0;
  save.mockClear();
  server.use(
    http.get(`${base}/quote`, () =>
      HttpResponse.json({
        ok: true,
        data: { cost: 7, display: "7", unit: "call", quantity: 1 },
      }),
    ),
    http.post(`${base}/candidates`, async ({ request }) => {
      creations++;
      const body = (await request.json()) as { request_id: string };
      candidateId = body.request_id;
      return HttpResponse.json(
        { ok: true, data: { candidate_id: candidateId, status: "generating" } },
        { status: 202 },
      );
    }),
    http.get(`${base}/candidates/:id`, ({ params }) =>
      HttpResponse.json({ ok: true, data: ready(String(params.id)) }),
    ),
    http.get(
      `${base}/candidates/:id/audio`,
      () =>
        new HttpResponse(new Uint8Array([1, 2]), {
          headers: { "Content-Type": "audio/mpeg" },
        }),
    ),
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn(),
    }),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Harness({ selected = target }: { selected?: VoiceDesignTarget }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>打开</button>
      <VoiceDesignDialog
        project="demo"
        surface="supertale"
        target={selected}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
function mount(selected = target) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <Harness selected={selected} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}
async function fill() {
  fireEvent.change(screen.getByLabelText("音色描述"), {
    target: { value: "温柔" },
  });
  fireEvent.change(screen.getByLabelText("试听文本"), {
    target: { value: text },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "生成试听" })).toBeEnabled(),
  );
}
async function generate() {
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  await screen.findByText("8.4 秒");
}
it("requires Unicode lengths and shows actual quote; retains draft on reopen", async () => {
  mount();
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("音色描述"), {
    target: { value: "😀".repeat(500) },
  });
  fireEvent.change(screen.getByLabelText("试听文本"), {
    target: { value: "😀".repeat(15) },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "生成试听" })).toBeEnabled(),
  );
  expect(screen.getByText("500/500")).toBeInTheDocument();
  expect(screen.getByText("本次生成：7 积分 / 次")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开" }));
  expect(screen.getByLabelText("音色描述")).toHaveValue("😀".repeat(500));
});
it("confirms occupied slot, cancel sends nothing, confirmed save uses snapshot", async () => {
  mount();
  await generate();
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  fireEvent.click(screen.getByRole("button", { name: "替换" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]).toEqual([
    expect.objectContaining({
      candidate_id: candidateId,
      expected_slot: target.expectedSlot,
      replace_existing: true,
    }),
  ]);
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty("name");
});
it.each(["fetch", "element", "play"])(
  "retains inputs after generation and playback failures: %s",
  async (mode) => {
    mount();
    await generate();
    if (mode === "fetch")
      server.use(
        http.get(`${base}/candidates/:id/audio`, () =>
          HttpResponse.json({ error: "bad" }, { status: 502 }),
        ),
      );
    if (mode === "play")
      vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(
        new Error("blocked"),
      );
    fireEvent.click(screen.getByRole("button", { name: "播放试听" }));
    if (mode === "element") {
      await waitFor(() =>
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalled(),
      );
      fireEvent.error(screen.getByLabelText("生成的试听音频"));
    }
    expect(
      await screen.findByRole("button", { name: "重试试听" }),
    ).toBeEnabled();
    expect(screen.getByLabelText("音色描述")).toHaveValue("温柔");
    expect(screen.getByLabelText("试听文本")).toHaveValue(text);
    expect(creations).toBe(1);
  },
);
it("queries original request after uncertain creation and never auto creates again", async () => {
  let queried = "";
  server.use(
    http.post(`${base}/candidates`, async ({ request }) => {
      creations++;
      candidateId = ((await request.json()) as { request_id: string })
        .request_id;
      return HttpResponse.error();
    }),
    http.get(`${base}/candidates/:id`, ({ params }) => {
      queried = String(params.id);
      return HttpResponse.json({
        ok: true,
        data: {
          candidate_id: queried,
          status: "unknown",
          failure: {
            code: "generation_unknown",
            message: "结果未知，请确认后重新生成",
            retryable: true,
          },
        },
      });
    }),
  );
  mount();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  await screen.findByText("结果未知，请确认后重新生成");
  expect(queried).toBe(candidateId);
  expect(creations).toBe(1);
  expect(screen.getByLabelText("试听文本")).toHaveValue(text);
});
it("failed regeneration retains the previous successful candidate", async () => {
  mount();
  await generate();
  server.use(
    http.post(`${base}/candidates`, () =>
      HttpResponse.json(
        {
          ok: false,
          code: "content_rejected",
          error: "请修改描述",
          retryable: false,
          request_id: candidateId,
        },
        { status: 422 },
      ),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  await screen.findByText("请修改描述");
  expect(screen.getByText("8.4 秒")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeEnabled();
});
it("expired candidate cannot save", async () => {
  server.use(
    http.get(`${base}/candidates/:id`, ({ params }) =>
      HttpResponse.json({
        ok: true,
        data: ready(
          String(params.id),
          new Date(Date.now() - 1000).toISOString(),
        ),
      }),
    ),
  );
  mount();
  await generate();
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled();
  expect(screen.getByText("试听已过期，请重新生成。")).toBeInTheDocument();
});
it("isolates account payload and retries saving with the same ID and retained name", async () => {
  const accountSave = vi.fn(async (_input: unknown) => {
    throw new Error("offline");
  });
  mount({
    kind: "account",
    key: "node-one",
    label: "我的音色",
    saveLabel: "保存到我的音色",
    onSave: accountSave,
  });
  fireEvent.change(screen.getByLabelText("音色名称"), {
    target: { value: "温柔女声" },
  });
  await generate();
  fireEvent.click(screen.getByRole("button", { name: "保存到我的音色" }));
  await screen.findByText("连接失败，请查询原任务或重试保存。");
  fireEvent.click(screen.getByRole("button", { name: "保存到我的音色" }));
  await waitFor(() => expect(accountSave).toHaveBeenCalledTimes(2));
  expect(accountSave.mock.calls[0]).toEqual(accountSave.mock.calls[1]);
  expect(accountSave.mock.calls[0]?.[0]).toEqual({
    name: "温柔女声",
    candidate_id: candidateId,
    save_request_id: expect.any(String),
  });
  expect(screen.getByLabelText("音色名称")).toHaveValue("温柔女声");
});
it("keeps an existing preview playable and savable when generation becomes unavailable", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <Harness />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  await generate();
  server.use(
    http.get(`${base}/quote`, () =>
      HttpResponse.json(
        {
          ok: false,
          code: "voice_design_unavailable",
          error: "服务暂停新建",
          retryable: false,
          request_id: candidateId,
        },
        { status: 503 },
      ),
    ),
  );
  await qc.invalidateQueries({
    queryKey: ["projects", "demo", "voice-design", "quote"],
  });
  await screen.findByText("服务暂停新建");
  expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "播放试听" })).toBeEnabled();
});
it("separates targets and late generation responses, and restores each draft", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.post(`${base}/candidates`, async ({ request }) => {
      const input = (await request.json()) as { request_id: string };
      await gate;
      return HttpResponse.json({ ok: true, data: ready(input.request_id) });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Root({ selected }: { selected: VoiceDesignTarget }) {
    return (
      <QueryClientProvider client={qc}>
        <I18nextProvider i18n={i18n}>
          <Harness selected={selected} />
        </I18nextProvider>
      </QueryClientProvider>
    );
  }
  const view = render(<Root selected={target} />);
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  view.rerender(
    <Root selected={{ ...target, key: "秦:elder", label: "秦 · 老年" }} />,
  );
  expect(screen.getByLabelText("音色描述")).toHaveValue("");
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(screen.queryByText("8.4 秒")).not.toBeInTheDocument();
  view.rerender(<Root selected={target} />);
  expect(screen.getByLabelText("音色描述")).toHaveValue("温柔");
  await screen.findByText("8.4 秒");
});
it("blocks duplicate clicks while generating and saves nothing until ready", async () => {
  server.use(
    http.get(`${base}/candidates/:id`, ({ params }) =>
      HttpResponse.json({
        ok: true,
        data: { candidate_id: String(params.id), status: "generating" },
      }),
    ),
  );
  mount();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  const again = await screen.findByRole("button", { name: "重新生成" });
  expect(again).toBeDisabled();
  fireEvent.click(again);
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled();
  await waitFor(() => expect(creations).toBe(1));
  expect(save).not.toHaveBeenCalled();
});

it.each([403, 422, 502, 504, "timeout"])(
  "retains inputs after generation failure %s",
  async (mode) => {
    let queried = "";
    server.use(
      http.post(`${base}/candidates`, async ({ request }) => {
        const input = (await request.json()) as { request_id: string };
        candidateId = input.request_id;
        creations++;
        if (mode === "timeout") await delay(180);
        return HttpResponse.json(
          {
            ok: false,
            code: "provider_unavailable",
            error: "生成暂不可用",
            retryable: true,
            request_id: candidateId,
          },
          { status: typeof mode === "number" ? mode : 504 },
        );
      }),
      http.get(`${base}/candidates/:id`, ({ params }) => {
        queried = String(params.id);
        return HttpResponse.json({
          ok: true,
          data: {
            candidate_id: queried,
            status: "failed",
            failure: {
              code: "provider_unavailable",
              message: "生成暂不可用",
              retryable: true,
            },
          },
        });
      }),
    );
    mount();
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
    await screen.findByText("生成暂不可用");
    expect(screen.getByLabelText("音色描述")).toHaveValue("温柔");
    expect(screen.getByLabelText("试听文本")).toHaveValue(text);
    expect(creations).toBe(1);
    if (mode === "timeout" || (typeof mode === "number" && mode >= 500))
      expect(queried).toBe(candidateId);
    if (mode === "timeout") await delay(100);
  },
);
it("requires refresh after slot conflict before another save", async () => {
  const refresh = vi.fn(async () => {});
  const conflictSave = vi.fn(async () => {
    throw new VoiceDesignApiError("slot_changed", "保存位置已改变", false, 409);
  });
  mount({ ...target, onSave: conflictSave, onRefresh: refresh });
  await generate();
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  fireEvent.click(screen.getByRole("button", { name: "替换" }));
  await screen.findByText("保存位置已改变");
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "刷新保存位置" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "保存到默认" })).toBeEnabled(),
  );
});
it("server expiry on playback prevents saving and preserves text", async () => {
  mount();
  await generate();
  server.use(
    http.get(`${base}/candidates/:id/audio`, () =>
      HttpResponse.json(
        {
          ok: false,
          code: "candidate_expired",
          error: "试听过期",
          retryable: false,
          request_id: candidateId,
        },
        { status: 410 },
      ),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "播放试听" }));
  await screen.findByText("试听已过期，请重新生成。");
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled();
  expect(screen.getByLabelText("音色描述")).toHaveValue("温柔");
});
