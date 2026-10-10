// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import {
  fetchFreezoneBlockoutModels,
  fetchFreezoneImageToBlockoutResult,
  submitFreezoneImageToBlockout,
} from "@/api/ops";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  apiClient: vi.fn(),
}));

describe("image to blockout api", () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockReset();
  });

  it("posts the image, the note and the node context", async () => {
    vi.mocked(apiCall).mockResolvedValue({
      task_type: "freezone_image_to_blockout",
      job_id: "job-1",
      task_key: "freezone_image_to_blockout:job-1",
    });

    const ref = await submitFreezoneImageToBlockout("project a", {
      sourceUrl: "/static/projects/p/freezone/uploads/ref.png",
      description: "层高 3 米",
      pictureCheck: true,
      renderCheck: true,
      model: "GPT-6-Astra",
      canvasId: "default",
      nodeId: "previz-1",
    });

    expect(apiCall).toHaveBeenCalledWith("projects/project%20a/freezone/image-to-blockout", {
      method: "POST",
      json: {
        source_url: "/static/projects/p/freezone/uploads/ref.png",
        description: "层高 3 米",
        picture_check: true,
        render_check: true,
        model: "GPT-6-Astra",
        canvas_id: "default",
        node_id: "previz-1",
      },
    });
    expect(ref.task_key).toBe("freezone_image_to_blockout:job-1");
  });

  it("sends an empty note and no node context when neither is given", async () => {
    vi.mocked(apiCall).mockResolvedValue({});

    await submitFreezoneImageToBlockout("p", { sourceUrl: "/static/a.png" });

    expect(apiCall).toHaveBeenCalledWith("projects/p/freezone/image-to-blockout", {
      method: "POST",
      json: {
        source_url: "/static/a.png",
        description: "",
        picture_check: false,
        render_check: false,
      },
    });
  });

  it("lists the selectable models in the shape the picker reads", async () => {
    vi.mocked(apiCall).mockResolvedValue({
      ok: true,
      data: [
        {
          id: "DC-previz-blockout-LLM",
          providerId: "newapi",
          provider: "newapi",
          apiModel: "DC-previz-blockout-LLM",
          api_model: "DC-previz-blockout-LLM",
          label: "DC-previz-blockout-LLM",
        },
        {
          id: "GPT-6-Astra",
          providerId: "newapi",
          provider: "newapi",
          apiModel: "GPT-6-Astra",
          api_model: "GPT-6-Astra",
          label: "GPT-6-Astra",
        },
      ],
    });

    const models = await fetchFreezoneBlockoutModels("project a");

    expect(apiCall).toHaveBeenCalledWith("projects/project%20a/freezone/blockout/models");
    expect(models.map((model) => [model.id, model.providerId, model.apiModel, model.label])).toEqual([
      ["DC-previz-blockout-LLM", "newapi", "DC-previz-blockout-LLM", "DC-previz-blockout-LLM"],
      ["GPT-6-Astra", "newapi", "GPT-6-Astra", "GPT-6-Astra"],
    ]);
  });

  it("reads the object list from the job result endpoint", async () => {
    const result = {
      objects: [{ id: "blockout-a" }],
      reference_camera_id: "blockout-cam",
      counts: { prop: 1, camera: 1 },
      warnings: ["物件 a 悬空"],
      compiler_version: 1,
    };
    vi.mocked(apiCall).mockResolvedValue(result);

    await expect(fetchFreezoneImageToBlockoutResult("project a", "job/1")).resolves.toBe(result);
    expect(apiCall).toHaveBeenCalledWith(
      "projects/project%20a/freezone/jobs/freezone_image_to_blockout/job%2F1/result",
    );
  });
});
