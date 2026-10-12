// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export interface PromptPreviewRouteContext {
  step: string | null;
  episode: number | null;
}

function subFromSearch(search: unknown): string {
  if (typeof search === "string") return new URLSearchParams(search).get("sub") ?? "";
  if (search && typeof search === "object" && "sub" in search) {
    const sub = (search as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : "";
  }
  return "";
}

/** Which pipeline step the current page is about, so the panel opens on the right one. */
export function promptPreviewContextFromRoute(
  pathname: string,
  search: unknown,
): PromptPreviewRouteContext {
  const episodeMatch = pathname.match(/\/episodes\/(\d+)(?:\/([^/]+))?/);
  const episode = episodeMatch ? Number(episodeMatch[1]) : null;
  const page = episodeMatch?.[2] ?? "";
  if (/\/characters(\/|$)/.test(pathname)) return { step: "portraits", episode };
  if (page === "script") return { step: "script", episode };
  if (page === "audio") return { step: "tts", episode };
  if (page === "video") return { step: "video", episode };
  if (page === "sketches") return { step: "sketches", episode };
  if (page === "beats") {
    const sub = subFromSearch(search).toLowerCase();
    if (sub.includes("video")) return { step: "video", episode };
    if (sub.includes("audio") || sub.includes("tts")) return { step: "tts", episode };
    if (sub.includes("render") || sub.includes("frame")) return { step: "first_frames", episode };
    if (sub.includes("sketch") || sub.includes("grid")) return { step: "sketches", episode };
  }
  return { step: null, episode };
}
