import type { PlaybackSnapshot, PublishedVersion, PlayerVersion } from "./publication";

export class PlaybackLoadError extends Error {
  constructor(public readonly reason: "unavailable" | "network") {
    super(reason);
  }
}

/** Public playback never depends on the editor's authenticated API client. */
export async function loadPublishedVersion(
  publicId: string,
  version?: string,
  signal?: AbortSignal,
): Promise<PlayerVersion> {
  const path = `/api/v1/public-stories/${encodeURIComponent(publicId)}${version ? `/versions/${encodeURIComponent(version)}` : ""}`;
  const response = await fetch(path, { cache: "no-store", signal });
  if (!response.ok)
    throw new PlaybackLoadError(
      [404, 410].includes(response.status) ? "unavailable" : "network",
    );
  return response.json();
}

/** Pending versions must use author-guarded media, including their cover. */
export function authorPreviewUrl(
  url: string | undefined,
  version: PublishedVersion,
  base: string,
): string | undefined {
  return url?.replace(
    `/api/v1/public-stories/${version.public_id}/versions/${version.version}/media/`,
    `/api/v1/${base}/${version.public_id}/versions/${version.version}/media/`,
  );
}

export function authorPreviewSnapshot(
  version: PublishedVersion,
  base: string,
): PlaybackSnapshot {
  if (!version.snapshot) throw new Error("Missing playback snapshot");
  const snapshot = structuredClone(version.snapshot);
  for (const node of snapshot.nodes) {
    const data = node.data as Record<string, unknown>;
    for (const key of ["videoUrl", "choiceLoopVideoUrl"]) {
      if (typeof data[key] === "string")
        data[key] = authorPreviewUrl(data[key], version, base);
    }
  }
  return snapshot;
}
