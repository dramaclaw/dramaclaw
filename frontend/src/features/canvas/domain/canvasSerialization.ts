// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Last-line defense against `previewImageUrl` shipping as a `data:image/...`
 * base64 blob in the save payload.
 *
 * The intended contract is: every node-creation site that calls
 * `uploadLocalImageToBackend` writes the returned static URL into BOTH
 * `imageUrl` and `previewImageUrl` (see RotateEditorOverlay / RedrawOverlay
 * for the canonical pattern). Historically a few sites only updated
 * `imageUrl`, leaving `previewImageUrl` as the local `data:` URL produced by
 * `prepareNodeImage` (which is a passthrough on the web). That base64 then
 * flowed straight into PUT /default, bloating the canvas to MBs and saturating
 * the request body cap.
 *
 * This sanitizer rewrites any `previewImageUrl` that still looks like a data
 * URL to the node's `imageUrl` (or `null` if `imageUrl` itself is unusable).
 * It runs at the single serialization chokepoint so we also clean up
 * already-polluted historical canvases the next time the user saves them.
 *
 * StoryboardSplitNode keeps per-frame `imageUrl` + `previewImageUrl` inside
 * `data.frames`, so we walk that list too. We log a single grouped `warn` per
 * save if anything was rewritten — that surfaces any new leak path without
 * spamming console for the steady-state historical-cleanup case.
 */
function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

function pickUsableUrl(url: unknown): string | null {
  return typeof url === "string" && url && !url.startsWith("data:") ? url : null;
}

interface SanitizedNodeRecord {
  nodeId: string;
  scope: "node" | `frame[${number}]`;
  replacedWith: "imageUrl" | "null";
}

export function sanitizePreviewImageUrls(nodes: unknown[]): unknown[] {
  const rewrites: SanitizedNodeRecord[] = [];

  const sanitized = nodes.map((rawNode) => {
    if (!rawNode || typeof rawNode !== "object") {
      return rawNode;
    }
    const node = rawNode as { id?: unknown; data?: unknown };
    const data = node.data;
    if (!data || typeof data !== "object") {
      return rawNode;
    }
    const dataRecord = data as Record<string, unknown>;
    const nodeId = typeof node.id === "string" ? node.id : "<unknown>";

    let nextData: Record<string, unknown> | null = null;

    if (isDataUrl(dataRecord.previewImageUrl)) {
      const fallback = pickUsableUrl(dataRecord.imageUrl);
      nextData = { ...dataRecord, previewImageUrl: fallback };
      rewrites.push({
        nodeId,
        scope: "node",
        replacedWith: fallback ? "imageUrl" : "null",
      });
    }

    const frames = dataRecord.frames;
    if (Array.isArray(frames)) {
      let framesChanged = false;
      const nextFrames = frames.map((frame, index) => {
        if (!frame || typeof frame !== "object") {
          return frame;
        }
        const frameRecord = frame as Record<string, unknown>;
        if (!isDataUrl(frameRecord.previewImageUrl)) {
          return frame;
        }
        const fallback = pickUsableUrl(frameRecord.imageUrl);
        framesChanged = true;
        rewrites.push({
          nodeId,
          scope: `frame[${index}]`,
          replacedWith: fallback ? "imageUrl" : "null",
        });
        return { ...frameRecord, previewImageUrl: fallback };
      });
      if (framesChanged) {
        nextData = { ...(nextData ?? dataRecord), frames: nextFrames };
      }
    }

    return nextData ? { ...node, data: nextData } : rawNode;
  });

  if (rewrites.length > 0) {
    console.warn(
      `[canvasSync] stripped base64 previewImageUrl from ${rewrites.length} field(s) before PUT`,
      rewrites,
    );
  }

  return sanitized;
}
