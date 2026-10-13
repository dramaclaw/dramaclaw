// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PushTarget } from "@/api/push";
import { CommitDialog } from "@/features/freezone/commit/CommitDialog";
import { promoteToAsset, previewAssetImpact } from "@/features/freezone/commit/promoteToAsset";

vi.mock("@/api/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/projects")>()),
  listCharacters: vi.fn(async () => []),
  listEpisodes: vi.fn(async () => []),
  listBeats: vi.fn(async () => []),
  listScenes: vi.fn(async () => [{ name: "公寓楼电梯间" }]),
  listCharacterIdentities: vi.fn(async () => []),
}));

vi.mock("@/features/freezone/commit/promoteToAsset", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/freezone/commit/promoteToAsset")>()),
  promoteToAsset: vi.fn(),
  previewAssetImpact: vi.fn(async () => ({
    target: { kind: "scene_3gs_reverse_ply", scene_id: "公寓楼电梯间" },
    affected_beats: [],
    affected_count: 0,
  })),
}));

describe("CommitDialog submit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(previewAssetImpact).mockResolvedValue({
      target: { kind: "scene_3gs_reverse_ply", scene_id: "公寓楼电梯间" },
      affected_beats: [],
      affected_count: 0,
    });
  });

  it("returns a node patch after committing a custom 3D world to a source slot", async () => {
    const sourceUrl = "/static/admin/proj/freezone/generated/custom-world.sog";
    const target: PushTarget = { kind: "scene_3gs_reverse_ply", scene_id: "公寓楼电梯间" };
    vi.mocked(promoteToAsset).mockResolvedValue({
      target_path: "director_worlds/公寓楼电梯间/v1/reverse_sharp.sog",
      target_url: "/static/projects/proj/director_worlds/公寓楼电梯间/v1/reverse_sharp.sog?v=2",
      backup: null,
    });
    const onSuccess = vi.fn();

    render(
      <CommitDialog
        project="proj"
        sourceUrl={sourceUrl}
        mediaType="model"
        defaultTarget={target}
        nodeData={{
          user_spawned: true,
          activeSourceId: "custom-local",
          plyUrl: sourceUrl,
          sources: [
            {
              id: "custom-local",
              source_type: "sog",
              source_kind: "custom",
              ply_url: sourceUrl,
            },
          ],
        }}
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onSuccess.mock.calls[0]?.[2]).toEqual(target);
    expect(onSuccess.mock.calls[0]?.[3]).toMatchObject({
      slot_target: target,
      committed_slot_url: "/static/projects/proj/director_worlds/公寓楼电梯间/v1/reverse_sharp.sog?v=2",
      committed_target_label: "公寓楼电梯间 / 背面世界",
    });
  });

  it("keeps the manual commit open and does not report success when persistence fails", async () => {
    const failure = new Error("主线写入失败");
    vi.mocked(promoteToAsset).mockRejectedValue(failure);
    const onClose = vi.fn();
    const onSuccess = vi.fn();

    render(
      <CommitDialog
        project="proj"
        sourceUrl="/static/admin/proj/freezone/generated/frame.png"
        defaultTarget={{ kind: "frame", episode: 1, beat: 2 }}
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    expect(await screen.findByText("主线写入失败")).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
