import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import { submitFreezoneVideoOmniGen } from "@/api/ops";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  apiClient: {},
}));

function sentJson(): Record<string, unknown> {
  const request = vi.mocked(apiCall).mock.calls[0]?.[1] as { json?: Record<string, unknown> };
  return request.json ?? {};
}

describe("submitFreezoneVideoOmniGen", () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockReset();
    vi.mocked(apiCall).mockResolvedValue({ job_id: "job-1" });
  });

  it("marks a smart-continue submit so the backend runs it as a video extension", async () => {
    await submitFreezoneVideoOmniGen("project-1", {
      prompt: "Continue the story",
      references: [{ type: "video", url: "/static/source.mp4" }],
      aspectRatio: "auto",
      genMode: "allReference",
      continuation: true,
    });

    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-1/freezone/video/omni-gen",
      expect.objectContaining({ method: "POST" }),
    );
    expect(sentJson()).toMatchObject({
      gen_mode: "allReference",
      continuation: true,
      aspect_ratio: "auto",
    });
  });

  it("leaves the flag out of a plain all-reference submit", async () => {
    await submitFreezoneVideoOmniGen("project-1", {
      prompt: "A cat jumps onto the table",
      references: [{ type: "image", url: "/static/a.png" }],
      genMode: "allReference",
      continuation: false,
    });

    expect(sentJson()).not.toHaveProperty("continuation");
  });
});
