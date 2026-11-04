// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { delay, http, HttpResponse } from "msw";
import { server } from "@/__mocks__/msw/server";
import ky from "ky";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
// Budget for complete component flows; per-step waits and request deadlines stay unchanged.
vi.setConfig({ testTimeout: 15_000 });
afterAll(() => vi.resetConfig());
const requestDeadlines = vi.hoisted(
  (): {
    next: number | null;
    used: { method: string; timeout: number }[];
  } => ({ next: null, used: [] }),
);
vi.mock("@/lib/api", () => ({
  api: ky.create({
    baseUrl: "http://localhost:3000/",
    hooks: {
      init: [
        (options) => {
          const method = options.method?.toUpperCase() ?? "GET";
          const timeout =
            method === "POST" ? requestDeadlines.next ?? 30_000 : 30_000;
          if (method === "POST") requestDeadlines.next = null;
          options.timeout = timeout;
          requestDeadlines.used.push({ method, timeout });
        },
      ],
    },
  }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));
import {
  VoiceDesignDialog,
  type VoiceDesignTarget,
} from "@/components/assets/voice-design-dialog";
import { VoiceDesignApiError } from "@/lib/queries/voice-design";
import * as voiceDesignApi from "@/lib/queries/voice-design";
import zh from "../../../../public/locales/zh/translation.json";
import { queryKeys } from "@/lib/query-keys";
import { designModels } from "@/__tests__/voice-design-fixtures";
import type { SaveGeneratedAccountVoice, SaveGeneratedCharacterVoice, VoiceDesignReady } from "@/types/voice-design";
const i18n = i18next.createInstance();
const base = "http://localhost:3000/api/v1/projects/demo/voice-design";
const text = "今天的天气很好，我们沿着河边慢慢走回家。";
let creations = 0;
let candidateId = "";
let historyCandidates: VoiceDesignReady[] = [];
const save = vi.fn(async (_input: unknown) => {});
const target: Extract<VoiceDesignTarget, { kind: "character" }> = {
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
): VoiceDesignReady {
  return {
    model: designModels[0],
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
  requestDeadlines.next = null;
  requestDeadlines.used = [];
  creations = 0;
  historyCandidates = [];
  save.mockClear();
  server.use(
    http.get(`${base}/candidates`, () =>
      HttpResponse.json({ ok: true, data: { candidates: historyCandidates, next_cursor: null, retention_seconds: 604800 } }),
    ),
    http.get(`${base}/models`, () =>
      HttpResponse.json({ ok: true, data: { models: designModels } }),
    ),
    http.get(`${base}/quote`, () =>
      HttpResponse.json({
        ok: true,
        data: {
          cost: 7,
          display: "7",
          unit: "call",
          quantity: 1,
          model: designModels[0],
        },
      }),
    ),
    http.post(`${base}/candidates`, async ({ request }) => {
      creations++;
      const body = (await request.json()) as { request_id: string };
      candidateId = body.request_id;
      return HttpResponse.json(
        {
          ok: true,
          data: {
            candidate_id: candidateId,
            status: "generating",
            model: designModels[0],
          },
        },
        { status: 202 },
      );
    }),
    http.get(`${base}/candidates/:id`, ({ params }) => {
      const result = ready(String(params.id));
      if (!historyCandidates.some((item) => item.candidate_id === result.candidate_id))
        historyCandidates.unshift(result);
      return HttpResponse.json({ ok: true, data: result });
    }),
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
  cleanup();
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
function mount(selected: VoiceDesignTarget = target) {
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
async function selectModel(label: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "生成模型" }));
  await user.click(await screen.findByRole("option", { name: label }));
}
async function generate() {
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  await screen.findByLabelText("生成的试听音频");
}
it("loads the preview before playback without autoplay or a second audio fetch", async () => {
  let reads = 0;
  server.use(
    http.get(`${base}/candidates/:id/audio`, () => {
      reads++;
      return new HttpResponse(new Uint8Array([1, 2]), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    }),
  );
  mount();
  await generate();
  await waitFor(() =>
    expect(screen.getByLabelText("生成的试听音频")).toHaveAttribute(
      "src",
      "blob:test",
    ),
  );
  expect(reads).toBe(1);
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "播放试听" }));
  await waitFor(() =>
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce(),
  );
  expect(reads).toBe(1);
  expect(creations).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
});
it("retries a failed preview preload without creating another candidate", async () => {
  let reads = 0;
  server.use(
    http.get(`${base}/candidates/:id/audio`, () => {
      reads++;
      return reads === 1
        ? HttpResponse.json({ error: "bad" }, { status: 502 })
        : new HttpResponse(new Uint8Array([1, 2]), {
            headers: { "Content-Type": "audio/mpeg" },
          });
    }),
  );
  mount();
  await generate();
  const retry = await screen.findByRole("button", { name: "重试试听" });
  await waitFor(() => expect(retry).toBeEnabled());
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await waitFor(() => expect(screen.getByRole("button", { name: "播放试听" })).toBeEnabled());
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "播放试听" }));
  await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce());
  expect(reads).toBe(2);
  expect(creations).toBe(1);
  expect(screen.getByLabelText("音色描述")).toHaveValue("温柔");
});
it("cancels a pending preview on close and reloads it on reopen", async () => {
  let reads = 0;
  let pendingSignal: AbortSignal | undefined;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(`${base}/candidates/:id/audio`, async ({ request }) => {
      reads++;
      if (reads === 1) {
        pendingSignal = request.signal;
        await gate;
      }
      return new HttpResponse(new Uint8Array([1, 2]), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    }),
  );
  try {
    mount();
    await generate();
    await waitFor(() => expect(reads).toBe(1));
    expect(pendingSignal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(pendingSignal?.aborted).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    await waitFor(() =>
      expect(screen.getByLabelText("生成的试听音频")).toHaveAttribute(
        "src",
        "blob:test",
      ),
    );
    release();
    await delay(0);
    expect(reads).toBe(2);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(creations).toBe(1);
  } finally {
    release();
  }
});
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
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
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
    mount();
    await generate();
    if (mode !== "fetch") {
      const play = screen.getByRole("button", { name: "播放试听" });
      await waitFor(() => expect(play).toBeEnabled());
      fireEvent.click(play);
    }
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
          model: designModels[0],
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
  expect(screen.getByRole("combobox", { name: "生成模型" })).toBeDisabled();
  expect(screen.getByLabelText("试听文本")).toHaveValue(text);
});
it("explicitly restarts a terminal unknown without resubmitting until the user generates a new request", async () => {
  const previous = { ...ready("59152ef5-2466-4056-99e5-2192e18a993b"), description: "先前的试听" };
  historyCandidates = [previous];
  server.use(http.get(`${base}/candidates/:id`, ({ params }) => HttpResponse.json({
    ok: true,
    data: creations === 1 ? {
      candidate_id: String(params.id), model: designModels[0], status: "unknown",
      failure: { code: "generation_unknown", message: "结果未知，请确认后重新生成", retryable: true },
    } : ready(String(params.id)),
  })));
  mount();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  await screen.findByText("结果未知，请确认后重新生成");
  const originalId = candidateId;
  expect(screen.getByRole("combobox", { name: "生成模型" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "打开" }));
  fireEvent.click(await screen.findByRole("button", { name: "重新开始" }));
  let confirmation = await screen.findByRole("alertdialog");
  expect(confirmation).toHaveTextContent("再次生成会创建新任务，并可能再次计费");
  fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
  expect(screen.getByRole("combobox", { name: "生成模型" })).toBeDisabled();
  expect(creations).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "重新开始" }));
  confirmation = await screen.findByRole("alertdialog");
  fireEvent.click(within(confirmation).getByRole("button", { name: "重新开始" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "生成模型" })).toBeEnabled());
  expect(screen.getByLabelText("音色描述")).toHaveValue("温柔");
  expect(screen.getByLabelText("试听文本")).toHaveValue(text);
  expect(creations).toBe(1);
  const history = screen.getByRole("button", { name: "选择试听：先前的试听" });
  expect(history).toBeEnabled();
  fireEvent.click(history);
  await screen.findByText("生成时描述：先前的试听");
  expect(creations).toBe(1);
  const generateAgain = screen.getByRole("button", { name: "重新生成" });
  fireEvent.click(generateAgain);
  fireEvent.click(generateAgain);
  await waitFor(() => expect(creations).toBe(2));
  expect(candidateId).not.toBe(originalId);
  await screen.findByLabelText("生成的试听音频");
});

it("does not offer restart for an unreachable original request without a verified terminal status", async () => {
  server.use(http.get(`${base}/candidates/:id`, () => HttpResponse.error()));
  mount();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  await screen.findByRole("button", { name: "查询原任务" });
  expect(screen.queryByRole("button", { name: "重新开始" })).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "生成模型" })).toBeDisabled();
  expect(creations).toBe(1);
});

it("retains terminal-unknown restart after a later status check loses its connection", async () => {
  let disconnected = false;
  let queries = 0;
  server.use(http.get(`${base}/candidates/:id`, ({ params }) => {
    queries++;
    return disconnected ? HttpResponse.error() : HttpResponse.json({
      ok: true, data: { candidate_id: String(params.id), model: designModels[0], status: "unknown",
        failure: { code: "generation_unknown", message: "结果未知", retryable: true } },
    });
  }));
  mount();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  await screen.findByRole("button", { name: "重新开始" });
  disconnected = true;
  fireEvent.click(screen.getByRole("button", { name: "查询原任务" }));
  await waitFor(() => expect(queries).toBe(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "查询原任务" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "重新开始" }));
  const confirmation = await screen.findByRole("alertdialog");
  fireEvent.click(within(confirmation).getByRole("button", { name: "重新开始" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "生成模型" })).toBeEnabled());
  expect(creations).toBe(1);
});

it("keeps the previous successful preview when restarting an unknown regeneration", async () => {
  server.use(http.get(`${base}/candidates/:id`, ({ params }) => HttpResponse.json({
    ok: true, data: creations === 1 ? ready(String(params.id)) : {
      candidate_id: String(params.id), model: designModels[0], status: "unknown",
      failure: { code: "generation_unknown", message: "结果未知", retryable: true },
    },
  })));
  mount();
  await generate();
  const previousId = candidateId;
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  fireEvent.click(await screen.findByRole("button", { name: "重新开始" }));
  const confirmation = await screen.findByRole("alertdialog");
  fireEvent.click(within(confirmation).getByRole("button", { name: "重新开始" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存到默认" })).toBeEnabled());
  expect(screen.getByLabelText("生成的试听音频")).toBeInTheDocument();
  expect(screen.getByText("8.4 秒")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "替换" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ candidate_id: previousId })));
  expect(creations).toBe(2);
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
  let entered: () => void = () => {};
  let completed: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const realCreate = voiceDesignApi.createVoiceDesign;
  vi.spyOn(voiceDesignApi, "createVoiceDesign").mockImplementation(async (...args) => {
    try {
      return await realCreate(...args);
    } finally {
      completed();
    }
  });
  server.use(
    http.post(`${base}/candidates`, async ({ request }) => {
      const input = (await request.json()) as { request_id: string };
      entered();
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
  const other = { ...target, key: "秦:elder", label: "秦 · 老年" };
  try {
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
    await started;
    view.rerender(<Root selected={other} />);
    expect(screen.getByLabelText("音色描述")).toHaveValue("");
    expect(screen.queryByLabelText("生成的试听音频")).not.toBeInTheDocument();
    await act(async () => {
      release();
      await finished;
    });
    expect(screen.getByLabelText("音色描述")).toHaveValue("");
    expect(screen.getByLabelText("试听文本")).toHaveValue("");
    expect(screen.queryByText("8.4 秒")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("生成的试听音频")).not.toBeInTheDocument();

    view.rerender(<Root selected={target} />);
    await screen.findByText("8.4 秒");
    expect(screen.getByLabelText("音色描述")).toHaveValue("温柔");
    expect(screen.getByLabelText("试听文本")).toHaveValue(text);
    expect(screen.getByLabelText("生成的试听音频")).toBeInTheDocument();

    view.rerender(<Root selected={other} />);
    expect(screen.getByLabelText("音色描述")).toHaveValue("");
    expect(screen.getByLabelText("试听文本")).toHaveValue("");
    expect(screen.queryByText("8.4 秒")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("生成的试听音频")).not.toBeInTheDocument();

    view.rerender(<Root selected={target} />);
    await screen.findByText("8.4 秒");
    expect(screen.getByLabelText("音色描述")).toHaveValue("温柔");
    expect(screen.getByLabelText("试听文本")).toHaveValue(text);
  } finally {
    release();
  }
});
it("blocks duplicate clicks while generating and saves nothing until ready", async () => {
  server.use(
    http.get(`${base}/candidates/:id`, ({ params }) =>
      HttpResponse.json({
        ok: true,
        data: {
          candidate_id: String(params.id),
          status: "generating",
          model: designModels[0],
        },
      }),
    ),
  );
  mount();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  const again = await screen.findByRole("button", { name: "重新生成" });
  expect(again).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "生成模型" })).toBeDisabled();
  fireEvent.click(again);
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled();
  await waitFor(() => expect(creations).toBe(1));
  expect(save).not.toHaveBeenCalled();
});

it.each([403, 422, 502, 504, "timeout"])(
  "retains inputs after generation failure %s",
  async (mode) => {
    let queried = "";
    let handled: () => void = () => {};
    const handlerFinished = new Promise<void>((resolve) => {
      handled = resolve;
    });
    server.use(
      http.post(`${base}/candidates`, async ({ request }) => {
        const input = (await request.json()) as { request_id: string };
        candidateId = input.request_id;
        creations++;
        if (mode === "timeout") await delay(700);
        const response = HttpResponse.json(
          {
            ok: false,
            code: "provider_unavailable",
            error: "生成暂不可用",
            retryable: true,
            request_id: candidateId,
          },
          { status: typeof mode === "number" ? mode : 504 },
        );
        handled();
        return response;
      }),
      http.get(`${base}/candidates/:id`, ({ params }) => {
        queried = String(params.id);
        return HttpResponse.json({
          ok: true,
          data: {
            candidate_id: queried,
            status: "failed",
            model: designModels[0],
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
    if (mode === "timeout") requestDeadlines.next = 500;
    fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
    await screen.findByText("生成暂不可用");
    expect(screen.getByLabelText("音色描述")).toHaveValue("温柔");
    expect(screen.getByLabelText("试听文本")).toHaveValue(text);
    expect(creations).toBe(1);
    expect(
      requestDeadlines.used.filter((request) => request.timeout === 500),
    ).toEqual(mode === "timeout" ? [{ method: "POST", timeout: 500 }] : []);
    expect(
      requestDeadlines.used.every(
        (request) => request.timeout === 30_000 || request.timeout === 500,
      ),
    ).toBe(true);
    if (mode === "timeout" || (typeof mode === "number" && mode >= 500))
      expect(queried).toBe(candidateId);
    if (mode === "timeout") await handlerFinished;
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
it("server expiry while loading the preview prevents saving and preserves text", async () => {
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
  mount();
  await generate();
  await screen.findByText("试听已过期，请重新生成。");
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled();
  expect(screen.getByLabelText("音色描述")).toHaveValue("温柔");
});

it.each(["success", "failure"])(
  "keeps target save pending across remount and binds its %s result",
  async (outcome) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pendingSave = vi.fn(async (_input: unknown) => {
      await gate;
      if (outcome === "failure")
        throw new VoiceDesignApiError("save_failed", "旧保存失败", true, 500);
    });
    const onSaved = vi.fn();
    const original = { ...target, onSave: pendingSave, onSaved };
    const other = { ...target, key: "秦:elder", label: "秦 · 老年" };
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Root({ selected }: { selected: VoiceDesignTarget }) {
      return (
        <QueryClientProvider client={qc}>
          <I18nextProvider i18n={i18n}>
            <Harness selected={selected} />
          </I18nextProvider>
        </QueryClientProvider>
      );
    }
    const view = render(<Root selected={original} />);
    await generate();
    fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
    fireEvent.click(screen.getByRole("button", { name: "替换" }));
    await screen.findByRole("button", { name: "正在保存…" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    view.rerender(<Root selected={other} />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    view.rerender(<Root selected={original} />);
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    const selector = screen.getByRole("combobox", { name: "生成模型" });
    expect(selector).toBeDisabled();
    await userEvent.setup().click(selector);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(selector).toHaveTextContent("Qwen");
    expect(pendingSave).toHaveBeenCalledOnce();
    expect(creations).toBe(1);
    release();
    if (outcome === "success")
      await screen.findByText("已保存到目标位置，可重新生成试听。");
    else await screen.findByText("旧保存失败");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新生成" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(creations).toBe(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存到默认" })).toBeEnabled(),
    );
    expect(
      screen.queryByText("已保存到目标位置，可重新生成试听。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("旧保存失败")).not.toBeInTheDocument();
  },
);
it.each(["success", "failure"])(
  "late save %s leaves another target's candidate and dialog untouched",
  async (outcome) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onSaved = vi.fn();
    const pendingSave = vi.fn(async () => {
      await gate;
      if (outcome === "failure")
        throw new VoiceDesignApiError("slot_changed", "旧目标冲突", false, 409);
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Root({ selected }: { selected: VoiceDesignTarget }) {
      return (
        <QueryClientProvider client={qc}>
          <I18nextProvider i18n={i18n}>
            <Harness selected={selected} />
          </I18nextProvider>
        </QueryClientProvider>
      );
    }
    const view = render(
      <Root selected={{ ...target, onSave: pendingSave, onSaved }} />,
    );
    await generate();
    fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
    fireEvent.click(screen.getByRole("button", { name: "替换" }));
    await screen.findByRole("button", { name: "正在保存…" });
    view.rerender(
      <Root selected={{ ...target, key: "秦:elder", label: "秦 · 老年" }} />,
    );
    await generate();
    release();
    await waitFor(() =>
      expect(pendingSave.mock.settledResults[0]?.type).toBe(
        outcome === "success" ? "fulfilled" : "rejected",
      ),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("保存位置：秦 · 老年")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存到默认" })).toBeEnabled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByText("旧目标冲突")).not.toBeInTheDocument();
    expect(
      screen.queryByText("已保存到目标位置，可重新生成试听。"),
    ).not.toBeInTheDocument();
  },
);

it("selects all catalog models with matching quotes and restores each candidate and shared inputs", async () => {
  const requests: Array<{ catalog_id: string; config_digest: string }> = [];
  server.use(
    http.get(`${base}/quote`, ({ request }) => {
      const model = designModels.find(
        (m) =>
          m.catalog_id === new URL(request.url).searchParams.get("catalog_id"),
      );
      return HttpResponse.json({
        ok: true,
        data: { cost: 7, display: "7", unit: "call", quantity: 1, model },
      });
    }),
    http.post(`${base}/candidates`, async ({ request }) => {
      const body = (await request.json()) as {
        request_id: string;
        catalog_id: string;
        config_digest: string;
      };
      requests.push(body);
      return HttpResponse.json({
        ok: true,
        data: {
          ...ready(body.request_id),
          model: designModels.find((m) => m.catalog_id === body.catalog_id),
        },
      });
    }),
  );
  mount({
    kind: "account",
    key: "my-voices",
    label: "我的音色",
    saveLabel: "保存",
    onSave: save,
  });
  await fill();
  fireEvent.change(screen.getByLabelText("音色名称"), {
    target: { value: "海风" },
  });
  const selector = await screen.findByRole("combobox", { name: "生成模型" });
  expect(selector).toHaveTextContent("Qwen");
  for (const model of designModels) {
    await selectModel(model.label);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "生成试听" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
    await screen.findByText(`请求模型：${model.model}`);
    expect(screen.getByLabelText("音色名称")).toHaveValue("海风");
    expect(screen.getByLabelText("试听文本")).toHaveValue(text);
    if (model.target_model)
      expect(
        screen.getByText(`目标模型：${model.target_model.model}`),
      ).toBeInTheDocument();
  }
  expect(
    screen.getAllByText("测试回放，未调用真实模型").length,
  ).toBeGreaterThan(0);
  await selectModel("Qwen");
  expect(
    await screen.findByText("请求模型：qwen-voice-design"),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("请求模型：seed-audio-1.0"),
  ).not.toBeInTheDocument();
  expect(
    requests.map(({ catalog_id, config_digest }) => ({
      catalog_id,
      config_digest,
    })),
  ).toEqual(
    designModels.map(({ catalog_id, config_digest }) => ({
      catalog_id,
      config_digest,
    })),
  );
});

it("keeps a late quote for another catalog out of the selected price and request", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  let created: unknown;
  server.use(
    http.get(`${base}/quote`, async ({ request }) => {
      const model = designModels.find(
        (m) =>
          m.catalog_id === new URL(request.url).searchParams.get("catalog_id"),
      );
      if (model?.catalog_id === "qwen") {
        requested = true;
        await gate;
      }
      return HttpResponse.json({
        ok: true,
        data: {
          cost: 11,
          display: model?.catalog_id === "qwen" ? "99" : "11",
          unit: "call",
          quantity: 1,
          model,
        },
      });
    }),
    http.post(`${base}/candidates`, async ({ request }) => {
      const body = (await request.json()) as { request_id: string };
      created = body;
      return HttpResponse.json({
        ok: true,
        data: { ...ready(body.request_id), model: designModels[1] },
      });
    }),
  );
  try {
    mount();
    await waitFor(() => expect(requested).toBe(true));
    fireEvent.change(screen.getByLabelText("音色描述"), {
      target: { value: "温柔" },
    });
    fireEvent.change(screen.getByLabelText("试听文本"), {
      target: { value: text },
    });
    await selectModel("CosyVoice");
    await screen.findByText("本次生成：11 积分 / 次");
    release();
    await delay(0);
    expect(
      screen.queryByText("本次生成：99 积分 / 次"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
    await screen.findByText("请求模型：voice-enrollment");
    expect(created).toMatchObject({
      catalog_id: "cosy",
      config_digest: "b".repeat(64),
    });
  } finally {
    release();
  }
});
it("keeps an unavailable catalog's existing candidate playable and savable without selecting a fallback", async () => {
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
    http.get(`${base}/models`, () =>
      HttpResponse.json({ ok: true, data: { models: [designModels[1]] } }),
    ),
  );
  await qc.invalidateQueries({ queryKey: queryKeys.voiceDesignModels("demo") });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled(),
  );
  expect(screen.getByRole("combobox", { name: "生成模型" })).toHaveTextContent(
    "Qwen（不可用于新生成）",
  );
  expect(
    screen.getAllByText("所选模型已不可用，仍可试听和保存已有候选。").length,
  ).toBeGreaterThan(0);
  expect(screen.getByText("请求模型：qwen-voice-design")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeEnabled();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "播放试听" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "播放试听" }));
  await waitFor(() =>
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce(),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  fireEvent.click(screen.getByRole("button", { name: "替换" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
});
it("explains an empty model catalog and never requests a fallback quote or generation", async () => {
  let quotes = 0;
  server.use(
    http.get(`${base}/models`, () =>
      HttpResponse.json({ ok: true, data: { models: [] } }),
    ),
    http.get(`${base}/quote`, () => {
      quotes++;
      return HttpResponse.error();
    }),
  );
  mount();
  await waitFor(() =>
    expect(screen.getAllByText("暂无可用的生成模型。").length).toBeGreaterThan(
      0,
    ),
  );
  expect(screen.getByRole("combobox", { name: "生成模型" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "生成试听" })).toBeDisabled();
  expect(quotes).toBe(0);
  expect(creations).toBe(0);
});
it("displays a historical candidate with no model record without inventing a model", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const candidate = { ...ready(crypto.randomUUID()), model: null };
  qc.setQueryData(
    queryKeys.voiceDesignDraft("demo", "supertale", `character:${target.key}`),
    {
      description: "温柔",
      previewText: text,
      name: "",
      selectedCatalogId: "qwen",
      models: {
        qwen: {
          generation: { kind: "settled" },
          ready: candidate,
          error: "",
          save: { kind: "idle" },
          conflict: false,
        },
      },
    },
  );
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <Harness />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("模型记录不可用。");
  expect(
    screen.queryByText("请求模型：qwen-voice-design"),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeEnabled();
});

it("isolates a mismatched candidate snapshot and only unlocks after checking the original request", async () => {
  let correct = false;
  server.use(
    http.get(`${base}/candidates/:id`, ({ params }) =>
      HttpResponse.json({
        ok: true,
        data: {
          ...ready(String(params.id)),
          model: correct ? designModels[0] : designModels[2],
        },
      }),
    ),
  );
  mount();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  await screen.findByText("服务器响应无效，请稍后查询原任务。");
  expect(screen.queryByRole("button", { name: "重新开始" })).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "生成模型" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled();
  expect(screen.queryByText("8.4 秒")).not.toBeInTheDocument();
  correct = true;
  fireEvent.click(screen.getByRole("button", { name: "查询原任务" }));
  await screen.findByText("请求模型：qwen-voice-design");
  expect(screen.getByRole("combobox", { name: "生成模型" })).toBeEnabled();
  expect(creations).toBe(1);
});

it("opens a themed model listbox and supports keyboard selection and Escape", async () => {
  const user = userEvent.setup();
  mount();
  await fill();
  const trigger = screen.getByRole("combobox", { name: "生成模型" });
  await user.click(trigger);
  const menu = await screen.findByRole("listbox");
  expect(menu).toBeVisible();
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual(designModels.map((model) => model.label));
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Qwen" })).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("dialog")).toBeVisible();
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Qwen" })).toHaveFocus(),
  );
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "CosyVoice" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  await waitFor(() => expect(trigger).toHaveTextContent("CosyVoice"));
});

it("S29 selects an earlier temporary preview and saves its exact ID without generation", async () => {
  const first = { ...ready("59152ef5-2466-4056-99e5-2192e18a993b"), description: "第一版温柔女声" };
  const second = { ...ready("cf09708d-4a16-4cee-93eb-fee58deaa162"), description: "第二版清亮女声" };
  historyCandidates = [second, first];
  mount({ ...target, expectedSlot: { path: "", sha256: "", updated_at: "" } });
  fireEvent.click(await screen.findByRole("button", { name: "选择试听：第一版温柔女声" }));
  await waitFor(() => expect(screen.getByLabelText("音色描述")).toHaveValue(first.description));
  expect(screen.getByLabelText("试听文本")).toHaveValue(first.preview_text);
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ candidate_id: first.candidate_id })));
  expect(creations).toBe(0);
});

it("opens the shared full history and applies the sixth preview using its original snapshot", async () => {
  const all = Array.from({ length: 6 }, (_, i) => ({ ...ready(`00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`), description: `历史声音 ${i + 1}` }));
  server.use(http.get(`${base}/candidates`, ({ request }) => {
    const limit = Number(new URL(request.url).searchParams.get("limit"));
    return HttpResponse.json({ ok: true, data: { candidates: all.slice(0, limit), next_cursor: limit === 5 ? "older" : null, retention_seconds: 604800 } });
  }));
  mount({ ...target, expectedSlot: { path: "", sha256: "", updated_at: "" } });
  expect(await screen.findByRole("button", { name: "选择试听：历史声音 1" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "选择试听：历史声音 6" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
  expect(await screen.findByRole("tab", { name: "最近生成" })).toHaveAttribute("aria-selected", "true");
  await screen.findByText("历史声音 6");
  fireEvent.click(screen.getAllByRole("button", { name: "选择此试听" })[5]!);
  await waitFor(() => expect(screen.getByLabelText("音色描述")).toHaveValue("历史声音 6"));
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ candidate_id: all[5]?.candidate_id })));
  expect(creations).toBe(0);
});

it("hands focus to full history and returns it to view-all when the library closes", async () => {
  const user = userEvent.setup();
  mount();
  const opener = await screen.findByRole("button", { name: "查看全部" });
  await user.click(opener);
  const library = await screen.findByRole("dialog", { name: "资产库" });
  await waitFor(() => expect(library.contains(document.activeElement)).toBe(true));
  await user.click(within(library).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "查看全部" })).toHaveFocus());
});

it("S29 restores temporary previews after remount without silently generating", async () => {
  const item = { ...ready("59152ef5-2466-4056-99e5-2192e18a993b"), description: "刷新前的试听" };
  historyCandidates = [item];
  const first = mount();
  expect(await screen.findByRole("button", { name: "选择试听：刷新前的试听" })).toBeInTheDocument();
  first.unmount();
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "选择试听：刷新前的试听" }));
  await waitFor(() => expect(screen.getByLabelText("音色描述")).toHaveValue(item.description));
  expect(creations).toBe(0);
});

it("S29 keeps both same-model generations and saves the earlier audio", async () => {
  const ids: string[] = [];
  server.use(http.post(`${base}/candidates`, async ({ request }) => {
    const input = await request.json();
    if (!input || typeof input !== "object" || !("request_id" in input) || !("description" in input) || typeof input.request_id !== "string" || typeof input.description !== "string")
      return HttpResponse.json({ error: "invalid test request" }, { status: 422 });
    const result = { ...ready(input.request_id), description: input.description };
    ids.push(result.candidate_id);
    historyCandidates.unshift(result);
    creations++;
    return HttpResponse.json({ ok: true, data: result });
  }));
  mount({ ...target, expectedSlot: { path: "", sha256: "", updated_at: "" } });
  await generate();
  fireEvent.change(screen.getByLabelText("音色描述"), { target: { value: "第二次更清亮" } });
  await waitFor(() => expect(screen.getByLabelText("音色描述")).toHaveValue("第二次更清亮"));
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  await screen.findByRole("button", { name: "选择试听：第二次更清亮" });
  fireEvent.click(screen.getByRole("button", { name: "选择试听：温柔" }));
  await waitFor(() => expect(screen.getByLabelText("音色描述")).toHaveValue("温柔"));
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ candidate_id: ids[0] })));
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
  expect(creations).toBe(2);
});

it.each([designModels[1], null])("S29 reads and saves history for unavailable or legacy model %s", async (model) => {
  const item = { ...ready("59152ef5-2466-4056-99e5-2192e18a993b"), model, description: "旧目录试听" };
  historyCandidates = [item];
  server.use(http.get(`${base}/models`, () => HttpResponse.json({ ok: true, data: { models: [designModels[0]] } })));
  mount({ ...target, expectedSlot: { path: "", sha256: "", updated_at: "" } });
  fireEvent.click(await screen.findByRole("button", { name: "选择试听：旧目录试听" }));
  await screen.findByText("生成时描述：旧目录试听");
  expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole("button", { name: "播放试听" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ candidate_id: item.candidate_id })));
  expect(creations).toBe(0);
});

it("S29 blocks switching history while generation status is unresolved", async () => {
  historyCandidates = [{ ...ready("59152ef5-2466-4056-99e5-2192e18a993b"), description: "另一条旧试听" }];
  server.use(http.get(`${base}/candidates/:id`, ({ params }) => HttpResponse.json({
    ok: true, data: { candidate_id: String(params.id), model: designModels[0], status: "unknown", failure: { code: "generation_unknown", message: "请查询原任务", retryable: true } },
  })));
  mount();
  await screen.findByRole("button", { name: "选择试听：另一条旧试听" });
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  await screen.findByRole("button", { name: "查询原任务" });
  const previous = screen.getByRole("button", { name: "选择试听：另一条旧试听" });
  expect(previous).toBeDisabled();
  fireEvent.click(previous);
  expect(screen.getByLabelText("音色描述")).toHaveValue("温柔");
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled();
  expect(creations).toBe(1);
});

it("S29 shows clear temporary retention and a single playback and close control", async () => {
  mount();
  await generate();
  expect(screen.getByText("未保存试听保留 7 天，到期后自动删除；已保存音频不受影响。")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "播放试听" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("生成的试听音频")).not.toHaveAttribute("controls");
  const details = screen.getAllByText("模型详情");
  expect(details).toHaveLength(2);
  expect(details.every((summary) => !summary.closest("details")?.open)).toBe(true);
});

it("S29 locks history during a pending save and removes saved previews", async () => {
  const first = { ...ready("59152ef5-2466-4056-99e5-2192e18a993b"), description: "正在保存的试听" };
  const second = { ...ready("cf09708d-4a16-4cee-93eb-fee58deaa162"), description: "另一条未保存试听" };
  historyCandidates = [first, second];
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pendingSave = vi.fn(async () => { await gate; historyCandidates = [second]; });
  mount({ ...target, expectedSlot: { path: "", sha256: "", updated_at: "" }, onSave: pendingSave });
  fireEvent.click(await screen.findByRole("button", { name: "选择试听：正在保存的试听" }));
  await screen.findByText("生成时描述：正在保存的试听");
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  await waitFor(() => expect(pendingSave).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "选择试听：另一条未保存试听" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "选择试听：另一条未保存试听" }));
  expect(screen.getByLabelText("音色描述")).toHaveValue(first.description);
  release();
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "打开" }));
  await screen.findByRole("button", { name: "选择试听：另一条未保存试听" });
  await waitFor(() => expect(screen.queryByRole("button", { name: "选择试听：正在保存的试听" })).not.toBeInTheDocument());
  expect(creations).toBe(0);
});

it("S29 removes expired history and disables playback and save without regeneration", async () => {
  const item = { ...ready("59152ef5-2466-4056-99e5-2192e18a993b", new Date(Date.now() + 1500).toISOString()), description: "即将过期的试听" };
  historyCandidates = [item];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "选择试听：即将过期的试听" }));
  await screen.findByText("生成时描述：即将过期的试听");
  await waitFor(() => expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled(), { timeout: 3500 });
  expect(screen.queryByRole("button", { name: "选择试听：即将过期的试听" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "播放试听" })).toBeDisabled();
  expect(creations).toBe(0);
});

it.each([false, true])("S29 preserves a failed save request when reselecting history (via another preview: %s)", async (viaOther) => {
  const first = { ...ready("59152ef5-2466-4056-99e5-2192e18a993b"), description: "保存断线的试听" };
  const second = { ...ready("cf09708d-4a16-4cee-93eb-fee58deaa162"), description: "另一条试听" };
  historyCandidates = [first, second];
  const attempts: SaveGeneratedAccountVoice[] = [];
  mount({
    kind: "account", key: "mine", label: "我的音色", saveLabel: "保存到我的音色",
    onSave: async (input) => { attempts.push(input); if (attempts.length === 1) throw new Error("connection lost"); },
  });
  fireEvent.click(await screen.findByRole("button", { name: "选择试听：保存断线的试听" }));
  fireEvent.change(screen.getByLabelText("音色名称"), { target: { value: "满意的女声" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "保存到我的音色" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "保存到我的音色" }));
  await screen.findByRole("alert");
  if (viaOther) {
    fireEvent.click(screen.getByRole("button", { name: "选择试听：另一条试听" }));
    await screen.findByText("生成时描述：另一条试听");
  }
  fireEvent.click(screen.getByRole("button", { name: "选择试听：保存断线的试听" }));
  await screen.findByText("生成时描述：保存断线的试听");
  fireEvent.click(screen.getByRole("button", { name: "保存到我的音色" }));
  await waitFor(() => expect(attempts).toHaveLength(2));
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[1]?.candidate_id).toBe(first.candidate_id);
  expect(creations).toBe(0);
});

it("S29 treats an edited account voice name as a new save intent after reselecting history", async () => {
  const first = { ...ready("59152ef5-2466-4056-99e5-2192e18a993b"), description: "需要改名的试听" };
  historyCandidates = [first];
  const attempts: SaveGeneratedAccountVoice[] = [];
  mount({
    kind: "account", key: "mine", label: "我的音色", saveLabel: "保存到我的音色",
    onSave: async (input) => { attempts.push(input); if (attempts.length === 1) throw new Error("connection lost"); },
  });
  fireEvent.click(await screen.findByRole("button", { name: "选择试听：需要改名的试听" }));
  fireEvent.change(screen.getByLabelText("音色名称"), { target: { value: "旧名称" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "保存到我的音色" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "保存到我的音色" }));
  await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("音色名称"), { target: { value: "新名称" } });
  await waitFor(() => expect(screen.getByLabelText("音色名称")).toHaveValue("新名称"));
  fireEvent.click(screen.getByRole("button", { name: "选择试听：需要改名的试听" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "选择试听：需要改名的试听" })).toHaveAttribute("aria-pressed", "true"));
  fireEvent.click(screen.getByRole("button", { name: "保存到我的音色" }));
  await waitFor(() => expect(attempts).toHaveLength(2));
  expect(attempts[0]?.name).toBe("旧名称");
  expect(attempts[1]?.name).toBe("新名称");
  expect(attempts[1]?.candidate_id).toBe(first.candidate_id);
  expect(attempts[1]?.save_request_id).not.toBe(attempts[0]?.save_request_id);
  expect(creations).toBe(0);
});

it("S29 uses the refreshed character slot snapshot after reselecting failed-save history", async () => {
  const first = { ...ready("59152ef5-2466-4056-99e5-2192e18a993b"), description: "刷新位置后的试听" };
  historyCandidates = [first];
  const attempts: SaveGeneratedCharacterVoice[] = [];
  const refreshedSlot = { path: "changed.wav", sha256: "changed-sha", updated_at: "after" };
  function RefreshHarness() {
    const [expectedSlot, setSlot] = useState(target.expectedSlot);
    const [open, setOpen] = useState(true);
    return <VoiceDesignDialog project="demo" surface="supertale" open={open} onOpenChange={setOpen} target={{
      ...target, expectedSlot,
      onRefresh: async () => { setSlot(refreshedSlot); },
      onSave: async (input: SaveGeneratedCharacterVoice) => {
        attempts.push(input);
        if (attempts.length === 1) throw new VoiceDesignApiError("slot_changed", "保存位置已改变", false, 409);
      },
    }} />;
  }
  render(<QueryClientProvider client={new QueryClient()}><I18nextProvider i18n={i18n}><RefreshHarness /></I18nextProvider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "选择试听：刷新位置后的试听" }));
  await screen.findByText("生成时描述：刷新位置后的试听");
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  fireEvent.click(await screen.findByRole("button", { name: "替换" }));
  fireEvent.click(await screen.findByRole("button", { name: "刷新保存位置" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存到默认" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "选择试听：刷新位置后的试听" }));
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  fireEvent.click(await screen.findByRole("button", { name: "替换" }));
  await waitFor(() => expect(attempts).toHaveLength(2));
  expect(attempts[0]?.expected_slot).toEqual(target.expectedSlot);
  expect(attempts[1]?.expected_slot).toEqual(refreshedSlot);
  expect(attempts[1]?.save_request_id).not.toBe(attempts[0]?.save_request_id);
  expect(attempts[1]?.candidate_id).toBe(first.candidate_id);
  expect(creations).toBe(0);
});

it("S29 preserves a slot conflict when selecting another preview and returning", async () => {
  const first = { ...ready("59152ef5-2466-4056-99e5-2192e18a993b"), description: "冲突的试听" };
  const second = { ...ready("cf09708d-4a16-4cee-93eb-fee58deaa162"), description: "另一条试听" };
  historyCandidates = [first, second];
  const conflictedSave = vi.fn(async () => { throw new VoiceDesignApiError("slot_changed", "保存位置已改变", false, 409); });
  mount({ ...target, onSave: conflictedSave });
  fireEvent.click(await screen.findByRole("button", { name: "选择试听：冲突的试听" }));
  await screen.findByText("生成时描述：冲突的试听");
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  fireEvent.click(await screen.findByRole("button", { name: "替换" }));
  await screen.findByRole("button", { name: "刷新保存位置" });
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "选择试听：另一条试听" }));
  await screen.findByText("生成时描述：另一条试听");
  fireEvent.click(screen.getByRole("button", { name: "选择试听：冲突的试听" }));
  await screen.findByText("生成时描述：冲突的试听");
  expect(screen.getByRole("button", { name: "保存到默认" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "刷新保存位置" })).toBeInTheDocument();
  expect(conflictedSave).toHaveBeenCalledOnce();
  expect(creations).toBe(0);
});

it("S29 does not let a late target refresh reset a different preview's pending save", async () => {
  const first = { ...ready("59152ef5-2466-4056-99e5-2192e18a993b"), description: "等待刷新位置的试听" };
  const second = { ...ready("cf09708d-4a16-4cee-93eb-fee58deaa162"), description: "正在保存的另一条试听" };
  historyCandidates = [first, second];
  let releaseRefresh = () => {};
  let releaseSave = () => {};
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let attempts = 0;
  const refreshed = vi.fn(async () => { await refreshGate; });
  mount({ ...target,
    onRefresh: refreshed,
    onSave: async () => {
      attempts++;
      if (attempts === 1) throw new VoiceDesignApiError("slot_changed", "保存位置已改变", false, 409);
      await saveGate;
    },
  });
  try {
    fireEvent.click(await screen.findByRole("button", { name: "选择试听：等待刷新位置的试听" }));
    await screen.findByText("生成时描述：等待刷新位置的试听");
    fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
    fireEvent.click(await screen.findByRole("button", { name: "替换" }));
    fireEvent.click(await screen.findByRole("button", { name: "刷新保存位置" }));
    await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "选择试听：正在保存的另一条试听" }));
    await screen.findByText("生成时描述：正在保存的另一条试听");
    fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
    fireEvent.click(await screen.findByRole("button", { name: "替换" }));
    await waitFor(() => expect(attempts).toBe(2));
    releaseRefresh();
    await delay(20);
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "选择试听：等待刷新位置的试听" })).toBeDisabled();
    expect(creations).toBe(0);
  } finally {
    releaseRefresh();
    releaseSave();
  }
});


it("keeps a definitive 503 rejection visible without polling a nonexistent candidate", async () => {
  const reads = vi.fn();
  server.use(
    http.post(`${base}/candidates`, () => HttpResponse.json({
      ok: false, code: "voice_design_unavailable", error: "声音设计暂不可用",
      retryable: false, request_id: "rejected",
    }, { status: 503 })),
    http.get(`${base}/candidates/:id`, () => {
      reads();
      return HttpResponse.json({ ok: false, code: "candidate_not_found", error: "生成结果不存在", retryable: false, request_id: "missing" }, { status: 404 });
    }),
  );
  mount();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  await screen.findByText("声音设计暂不可用");
  await waitFor(() => expect(screen.getByLabelText("音色描述")).toBeEnabled());
  expect(reads).not.toHaveBeenCalled();
  expect(screen.queryByText("生成结果不存在")).not.toBeInTheDocument();
});

it("manually retries an uncertain submission with the exact original request", async () => {
  const bodies: unknown[] = [];
  server.use(http.post(`${base}/candidates`, async ({ request }) => {
    const body = await request.json();
    bodies.push(body);
    if (bodies.length === 1) return HttpResponse.json({
      ok: false, code: "generation_unknown", error: "提交结果未知", retryable: true, request_id: "pending",
    }, { status: 504 });
    return HttpResponse.json({ ok: true, data: ready(candidateId) });
  }), http.get(`${base}/candidates/:id`, ({ params }) => {
    candidateId = String(params.id);
    return HttpResponse.json({ ok: true, data: { candidate_id: candidateId, status: "generating", model: designModels[0] } });
  }));
  mount();
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  const retry = await screen.findByRole("button", { name: "重试原请求" });
  expect(bodies).toHaveLength(1);
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await screen.findByLabelText("生成的试听音频");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
});


it("retains history duration and pagination after saving a candidate", async () => {
  const item = ready("59152ef5-2466-4056-99e5-2192e18a993b");
  historyCandidates = [item];
  server.use(http.get(`${base}/candidates`, () => HttpResponse.json({
    ok: true, data: { candidates: historyCandidates, retention_seconds: 3600, next_cursor: "older" },
  })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><I18nextProvider i18n={i18n}>
    <Harness selected={{ ...target, expectedSlot: { path: "", sha256: "", updated_at: "" } }} />
  </I18nextProvider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: `选择试听：${item.description}` }));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存到默认" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "保存到默认" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(qc.getQueryData(queryKeys.voiceDesignHistory("demo"))).toMatchObject({
    candidates: [], retention_seconds: 3600, next_cursor: "older",
  });
});
