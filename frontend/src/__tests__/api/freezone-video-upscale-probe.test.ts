import { describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import { probeFreezoneVideoUpscale, quoteFreezoneVideoUpscale } from "@/api/ops";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  apiClient: {},
}));

describe("probeFreezoneVideoUpscale", () => {
  it("returns the video metadata already unwrapped by apiCall", async () => {
    const probe = { width: 854, height: 480, fps: 30, duration: 5 };
    vi.mocked(apiCall).mockResolvedValueOnce(probe);

    await expect(
      probeFreezoneVideoUpscale("project-1", "/static/source.mp4"),
    ).resolves.toEqual(probe);
    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-1/freezone/video/upscale/probe?source_url=%2Fstatic%2Fsource.mp4",
    );
  });
});

describe("quoteFreezoneVideoUpscale", () => {
  it("sends the selected processing options for a server-side price quote", async () => {
    const quote = { cost: 24, display: "24" };
    vi.mocked(apiCall).mockResolvedValueOnce(quote);

    await expect(quoteFreezoneVideoUpscale("project-1", {
      sourceUrl: "/static/source.mp4",
      resolution: "4k",
      targetFps: 60,
      slowdown: "2x",
      smartInterpolation: false,
      scene: "anime",
      faceEnhance: true,
    })).resolves.toEqual(quote);
    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-1/freezone/video/upscale/quote",
      {
        method: "POST",
        json: {
          source_url: "/static/source.mp4",
          resolution: "4k",
          target_fps: 60,
          slowdown: "2x",
          smart_interpolation: false,
          scene: "anime",
          face_enhance: true,
        },
      },
    );
  });
});
