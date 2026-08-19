import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import { submitFreezoneVideoEdit } from "@/api/ops";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  apiClient: {},
}));

describe("submitFreezoneVideoEdit", () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockReset();
    vi.mocked(apiCall).mockResolvedValue({ job_id: "job-1" });
  });

  it("forwards references while leaving geometry and duration to the source video", async () => {
    await submitFreezoneVideoEdit("project-1", {
      videoUrl: "/static/source.mp4",
      imageUrls: ["/static/style.png"],
      audioUrls: ["/static/music.mp3"],
      model: "catalog-video",
      genMode: "videoEdit",
    });

    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-1/freezone/video/video-edit",
      expect.objectContaining({
        method: "POST",
        json: expect.objectContaining({
          video_url: "/static/source.mp4",
          image_urls: ["/static/style.png"],
          audio_urls: ["/static/music.mp3"],
          gen_mode: "videoEdit",
        }),
      }),
    );
    const request = vi.mocked(apiCall).mock.calls[0]?.[1] as {
      json?: Record<string, unknown>;
    };
    expect(request.json).not.toHaveProperty("aspect_ratio");
    expect(request.json).not.toHaveProperty("duration_seconds");
  });
});
