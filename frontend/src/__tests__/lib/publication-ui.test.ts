import { afterEach, expect, it, vi } from "vitest";
import {
  authorPreviewSnapshot,
  authorPreviewUrl,
  loadPublishedVersion,
} from "@/features/canvas/story/publication-ui";
import type { PublishedVersion } from "@/features/canvas/story/publication";

afterEach(() => vi.unstubAllGlobals());
it("guards pending preview media without changing the published snapshot", () => {
  const release: PublishedVersion = {
    public_id: "work",
    version: "pending",
    status: "ready",
    title: "Title",
    description: "",
    revision: 1,
    issues: [],
    cover: "/api/v1/public-stories/work/versions/pending/media/cover.png",
    snapshot: {
      groupId: "g",
      nodes: [
        {
          id: "n",
          type: "videoNode",
          position: { x: 0, y: 0 },
          data: {
            videoUrl:
              "/api/v1/public-stories/work/versions/pending/media/clip.mp4",
            choiceLoopVideoUrl:
              "/api/v1/public-stories/work/versions/pending/media/loop.mp4",
          },
        },
      ],
      edges: [],
    },
  };
  const result = authorPreviewSnapshot(release, "author");
  expect(JSON.stringify(result)).toContain(
    "/api/v1/author/work/versions/pending/media/clip.mp4",
  );
  expect(JSON.stringify(result)).toContain(
    "/api/v1/author/work/versions/pending/media/loop.mp4",
  );
  expect(authorPreviewUrl(release.cover, release, "author")).toContain(
    "/api/v1/author/",
  );
  expect(JSON.stringify(release.snapshot)).toContain("/api/v1/public-stories/");
});
it.each([404, 410])(
  "distinguishes unavailable content (%i) from network failure",
  async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status }));
    await expect(loadPublishedVersion("work")).rejects.toMatchObject({
      reason: "unavailable",
    });
  },
);
it("retains retryable network failures and requests the saved version", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503 });
  vi.stubGlobal("fetch", fetcher);
  await expect(loadPublishedVersion("work", "old")).rejects.toMatchObject({
    reason: "network",
  });
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/public-stories/work/versions/old",
    expect.objectContaining({ cache: "no-store" }),
  );
});
