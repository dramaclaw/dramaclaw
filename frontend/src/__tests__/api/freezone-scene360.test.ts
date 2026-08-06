// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import { submitFreezoneScene360 } from "@/api/ops";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  apiClient: vi.fn(),
}));

describe("scene 360 api", () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockReset();
    vi.mocked(apiCall).mockResolvedValue({
      task_type: "freezone_scene_360",
      job_id: "job-1",
      task_key: "freezone_scene_360:job-1",
    });
  });

  it("does not expose the upstream aspect ratio in the frontend request", async () => {
    await submitFreezoneScene360("project-a", {
      referenceUrl: "/static/master.png?v=1",
      imageSize: "2K",
      model: "LingShan-G2",
      catalogId: "cat-g2",
      quality: "medium",
    });

    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-a/freezone/scene-360",
      {
        method: "POST",
        json: {
          reference_url: "/static/master.png",
          image_size: "2K",
          mode: "candidate",
          model: "LingShan-G2",
          catalog_id: "cat-g2",
          quality: "medium",
        },
      },
    );
  });
});
