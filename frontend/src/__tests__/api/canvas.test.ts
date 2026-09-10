// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall, apiCallEnvelope } from "@/api/client";
import {
  buildProjectionFromPreset,
  createBlankFreezoneCanvas,
  getFreezoneCanvas,
  getProjectionStatuses,
  putFreezoneCanvas,
} from "@/api/canvas";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  // 画布详情走整信封:`foreign_media` 挂在 `data` 同级,只解一层的 apiCall 会丢掉它。
  apiCallEnvelope: vi.fn(),
}));

describe("canvas projection api", () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockReset();
    vi.mocked(apiCallEnvelope).mockReset();
  });

  it("passes abort signals through canvas detail GETs", async () => {
    const controller = new AbortController();
    vi.mocked(apiCallEnvelope).mockResolvedValueOnce({
      ok: true,
      data: {
        nodes: [],
        edges: [],
        revision: 4,
      },
    });

    await getFreezoneCanvas("project-a", "user_eric", {
      signal: controller.signal,
    });

    expect(apiCallEnvelope).toHaveBeenCalledWith(
      "projects/project-a/freezone/canvases/user_eric",
      { signal: controller.signal },
    );
  });

  it("builds a preset projection graph without a target canvas", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      projection_key: "beat:1:4",
      facts_signature: "sig",
      nodes: [],
      edges: [],
      metadata: {},
    });

    await buildProjectionFromPreset("project-a", {
      scope: "beat",
      episode: 1,
      beat: 4,
      projection_key: "beat:1:4",
      base_revision: 0,
    });

    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-a/freezone/projections:build-from-preset",
      {
        method: "POST",
        json: {
          scope: "beat",
          episode: 1,
          beat: 4,
          projection_key: "beat:1:4",
          base_revision: 0,
        },
      },
    );
  });

  it("posts projection status request to a canvas", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      canvas_id: "user_eric",
      revision: 8,
      projections: [
        {
          projection_key: "beat:1:4",
          stale: true,
          stored_facts_signature: "old",
          current_facts_signature: "new",
        },
      ],
    });

    const result = await getProjectionStatuses("project-a", "user_eric", ["beat:1:4"]);

    expect(result.projections[0].stale).toBe(true);
    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-a/freezone/canvases/user_eric/projections:status",
      {
        method: "POST",
        json: { projection_keys: ["beat:1:4"] },
      },
    );
  });

  it("persists canvas changes with a PUT request body", async () => {
    const payload = {
      nodes: [{ id: "n1" }],
      edges: [],
      base_revision: 7,
      client_save_id: "save-1",
    };
    vi.mocked(apiCall).mockResolvedValueOnce({
      saved: true,
      revision: 8,
    });

    await putFreezoneCanvas("project-a", "user_eric", payload);

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiCall).mock.calls[0]).toEqual([
      "projects/project-a/freezone/canvases/user_eric",
      {
        method: "PUT",
        json: payload,
      },
    ]);
  });

  it("creates a named blank canvas with creator metadata", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      saved: true,
      revision: 1,
    });

    await createBlankFreezoneCanvas("project-a", {
      canvasId: "canvas_story_lab_abc123",
      name: "故事实验",
      creatorUsername: "alice",
    });

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiCall).mock.calls[0]).toEqual([
      "projects/project-a/freezone/canvases/canvas_story_lab_abc123",
      {
        method: "PUT",
        json: expect.objectContaining({
          schema_version: 2,
          canvas_id: "canvas_story_lab_abc123",
          project_id: "project-a",
          base_revision: null,
          save_source: "manual_save",
          nodes: [],
          edges: [],
          viewport: null,
          metadata: {
            canvas_origin: "user_created",
            display_name: "故事实验",
            creator_username: "alice",
          },
        }),
      },
    ]);
  });
});
