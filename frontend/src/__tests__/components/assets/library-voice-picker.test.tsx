// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import ky from "ky";
import { beforeEach, expect, it, vi } from "vitest";
import { server } from "@/__mocks__/msw/server";
import { LibraryVoicePicker } from "@/components/assets/library-voice-picker";
import type { CharacterVoiceSlot } from "@/types/character";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
}));
const library = vi.fn();
const sync = vi.fn();
vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneVideoCharacterLibrary: () => library(),
  fetchFreezoneAssetLibraryFolders: async () => [],
  syncFreezoneAssetLibraryFromMainline: () => sync(),
}));
const asset = {
  asset_id: "11111111-1111-4111-8111-111111111111",
  name: "女声候选",
  url: "/static/voice.mp3",
  sha256: "a".repeat(64),
  duration_seconds: 4,
  model: null,
};
const empty: CharacterVoiceSlot = {
  slot: "child",
  label: "幼年",
  path: "",
  url: "",
  sha256: "",
  updated_at: "",
  inherited_from_default: false,
  required: false,
};
const occupied: CharacterVoiceSlot = {
  ...empty,
  path: "assets/old.mp3",
  sha256: "b".repeat(64),
  updated_at: "old",
};
const base =
  "http://localhost:3000/api/v1/projects/demo/characters/Lin/voice-samples/child/apply-library";
function show(slot = empty) {
  const client = new QueryClient();
  const onClose = vi.fn();
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const rendered = render(
    <QueryClientProvider client={client}>
      <LibraryVoicePicker
        project="demo"
        character="Lin"
        slot={slot}
        onClose={onClose}
        onRefresh={onRefresh}
      />
    </QueryClientProvider>,
  );
  return { ...rendered, onClose, onRefresh, client };
}
beforeEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
  library.mockResolvedValue({
    items: [
      {
        id: asset.asset_id,
        name: asset.name,
        media: "audio",
        source: "upload",
        category: "audio",
        audio_url: asset.url,
        voice_design: asset,
      },
    ],
  });
});
it("applies the selected long-lived asset to the exact child slot with CAS and without generating", async () => {
  const inputs: unknown[] = [];
  server.use(
    http.post(base, async ({ request }) => {
      inputs.push(await request.json());
      return HttpResponse.json({
        ok: true,
        data: {
          ...empty,
          path: "assets/child.mp3",
          sha256: asset.sha256,
          updated_at: "new",
        },
      });
    }),
  );
  const { onClose } = show();
  fireEvent.click(await screen.findByRole("button", { name: "使用此声音" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toEqual({
    save_request_id: expect.any(String),
    asset_id: asset.asset_id,
    expected_slot: { path: "", sha256: "", updated_at: "" },
    replace_existing: false,
  });
  expect(sync).not.toHaveBeenCalled();
});
it("does not replace an occupied slot until the user confirms", async () => {
  const apply = vi.fn();
  server.use(
    http.post(base, () => {
      apply();
      return HttpResponse.error();
    }),
  );
  const { onClose } = show(occupied);
  fireEvent.click(await screen.findByRole("button", { name: "使用此声音" }));
  expect(await screen.findByText("替换已有声线？")).toBeInTheDocument();
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
});

it("shows the current library name when an asset has been renamed", async () => {
  library.mockResolvedValue({ items: [{ id: asset.asset_id, name: "已改名的女声", media: "audio", source: "upload", category: "audio", audio_url: asset.url, voice_design: asset }] });
  show(occupied);
  fireEvent.click(await screen.findByRole("button", { name: "使用此声音" }));
  expect(await screen.findByText("替换已有声线？")).toBeInTheDocument();
  expect(screen.getByText("已改名的女声")).toBeInTheDocument();
  expect(screen.queryByText(asset.name)).toBeNull();
});
it("retains the exact failed save request for an explicit retry", async () => {
  const inputs: unknown[] = [];
  server.use(
    http.post(base, async ({ request }) => {
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
      return HttpResponse.json({
        ok: true,
        data: { ...occupied, sha256: asset.sha256 },
      });
    }),
  );
  const { onClose } = show(occupied);
  fireEvent.click(await screen.findByRole("button", { name: "使用此声音" }));
  fireEvent.click(await screen.findByRole("button", { name: "替换" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(inputs[1]).toEqual(inputs[0]);
  expect(inputs[0]).toEqual(
    expect.objectContaining({
      replace_existing: true,
      expected_slot: {
        path: occupied.path,
        sha256: occupied.sha256,
        updated_at: occupied.updated_at,
      },
    }),
  );
});

it("requires refreshing a changed slot rather than retrying a stale CAS", async () => {
  server.use(
    http.post(base, () =>
      HttpResponse.json(
        {
          ok: false,
          error: "槽位已变化",
          code: "slot_changed",
          retryable: false,
          request_id: "test",
        },
        { status: 409 },
      ),
    ),
  );
  const { onRefresh } = show(occupied);
  fireEvent.click(await screen.findByRole("button", { name: "使用此声音" }));
  fireEvent.click(await screen.findByRole("button", { name: "替换" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("槽位已变化");
  expect(screen.queryByRole("button", { name: "重试保存" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "刷新保存位置" }));
  await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
  expect(
    await screen.findByRole("button", { name: "使用此声音" }),
  ).toBeInTheDocument();
});
