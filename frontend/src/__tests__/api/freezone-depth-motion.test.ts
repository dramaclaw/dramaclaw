import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import { fetchFreezoneJobResult, submitFreezoneDepthMotion } from "@/api/ops";

vi.mock("@/api/client", () => ({ apiCall: vi.fn(), apiClient: {} }));

describe("Depth Anything 3 canvas job API", () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockReset();
    vi.mocked(apiCall).mockResolvedValue({ job_id: "job-1" });
  });

  it("posts only the project-local source and resolution", async () => {
    await submitFreezoneDepthMotion("project-1", {
      sourceUrl: "/static/projects/project-1/source.mp4",
      resolution: "720p",
    });
    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-1/freezone/video/depth-motion",
      { method: "POST", json: {
        source_url: "/static/projects/project-1/source.mp4",
        resolution: "720p",
      } },
    );
  });

  it("reads the derived MP4 and manifest from the task result", async () => {
    await fetchFreezoneJobResult("project-1", "freezone_depth_motion", "job-1");
    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-1/freezone/jobs/freezone_depth_motion/job-1/result",
    );
  });
});
