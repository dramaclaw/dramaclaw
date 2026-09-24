import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import { submitFreezoneVideoExtend } from "@/api/ops";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  apiClient: {},
}));

describe("submitFreezoneVideoExtend", () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockReset();
    vi.mocked(apiCall).mockResolvedValue({ job_id: "job-1" });
  });

  it("submits one source video with automatic geometry and a requested extension duration", async () => {
    await submitFreezoneVideoExtend("project-1", {
      videoUrl: "/static/source.mp4",
      prompt: "Continue the story for five seconds",
      durationSeconds: 5,
      model: "catalog-video",
      genMode: "videoExtend",
    });

    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-1/freezone/video/video-extend",
      expect.objectContaining({
        method: "POST",
        json: expect.objectContaining({
          video_url: "/static/source.mp4",
          duration_seconds: 5,
          gen_mode: "videoExtend",
        }),
      }),
    );
    const request = vi.mocked(apiCall).mock.calls[0]?.[1] as {
      json?: Record<string, unknown>;
    };
    expect(request.json).not.toHaveProperty("aspect_ratio");
  });
});
