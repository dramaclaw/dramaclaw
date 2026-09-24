// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  generateClientSaveId,
  getFreezoneCanvas,
  getLiblibShareCanvasDetail,
  listFreezoneCanvases,
  putFreezoneCanvas,
} from "@/api/canvas";
import {
  fetchFreezoneImageModels,
  fetchFreezoneVideoModels,
} from "@/api/ops";
import {
  convertLiblibCanvasDetail,
  LiblibCanvasImportError,
  mergeLiblibCanvasGraph,
  parseLiblibShareUrl,
  liblibImportAssetStats,
} from "./liblibCanvasImport";
import type { CanvasEdge, CanvasNode } from "@/features/canvas/domain/canvasNodes";

export function suggestedProjectNameForLiblibShare(shareUrl: string): string {
  return `liblib_${parseLiblibShareUrl(shareUrl).projectId}`;
}

export async function importLiblibCanvasIntoProject(options: {
  projectId: string;
  shareUrl: string;
  creatorUsername?: string | null;
  viewportSize?: { width: number; height: number };
}): Promise<{ canvasId: string; skippedMediaCount: number }> {
  const share = parseLiblibShareUrl(options.shareUrl);
  const canvasId = `liblib_${share.projectId}`;
  // The compatibility GET endpoint returns an empty graph for a missing
  // canvas, so it cannot be used as an existence check. The listing is the
  // storage authority and prevents a first import from being misclassified as
  // an overwrite of an unrelated blank canvas.
  const summaries = await listFreezoneCanvases(options.projectId);
  const exists = summaries.some((item) => item.id === canvasId);
  const previous = exists
    ? await getFreezoneCanvas(options.projectId, canvasId)
    : null;
  if (previous && !previous.metadata?.liblib_import) {
    throw new LiblibCanvasImportError('canvas_conflict', { canvasId });
  }
  const [detail, imageModels, videoModels] = await Promise.all([
    getLiblibShareCanvasDetail(options.projectId, share.shareUrl, true),
    fetchFreezoneImageModels(options.projectId),
    fetchFreezoneVideoModels(options.projectId),
  ]);
  const graph = convertLiblibCanvasDetail(
    detail,
    share.shareUrl,
    options.viewportSize ?? { width: 1440, height: 900 },
    {
      imageModelId: imageModels[0]?.id,
      videoModelId: videoModels[0]?.id,
    },
  );
  const merged = previous
    ? mergeLiblibCanvasGraph(
        previous.nodes as CanvasNode[],
        previous.edges as CanvasEdge[],
        graph,
      )
    : graph;
  await putFreezoneCanvas(options.projectId, canvasId, {
    schema_version: 2,
    canvas_id: canvasId,
    project_id: options.projectId,
    base_revision: previous?.revision ?? null,
    client_save_id: generateClientSaveId(),
    save_source: "import",
    nodes: merged.nodes,
    edges: merged.edges,
    viewport: previous?.viewport ?? graph.viewport,
    metadata: {
      ...(previous?.metadata ?? {}),
      canvas_origin: "user_created",
      display_name: graph.name,
      creator_username: options.creatorUsername ?? null,
      liblib_import: {
        source_url: graph.shareUrl,
        source_project_id: graph.projectId,
        space_id: graph.spaceId,
        imported_at: new Date().toISOString(),
        ...liblibImportAssetStats(detail),
      },
    },
  });
  // 后端镜像不下来的素材(陌生域名、源站取不到、超限…)不再让导入失败,而是保留远端
  // 地址。这里把条数带回去,调用方据此提示「N 个素材未本地保存」。
  const skippedMedia = (detail as { skippedMedia?: unknown }).skippedMedia;
  return {
    canvasId,
    skippedMediaCount: Array.isArray(skippedMedia) ? skippedMedia.length : 0,
  };
}
