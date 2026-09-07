// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { OutputAspect } from '../domain/scene';

/**
 * 把录好的一段画面挂到画布上：上传 → 在预演台节点右边建一个视频节点 → 连边。
 * 与 `publishCapture` 同构，差别只在承载物是视频、并且带一个可读的节点标题。
 */
export interface PublishRecordingDeps {
  project: string;
  /** 预演台节点自己的 id，新节点挂在它右边。 */
  sourceNodeId: string;
  aspect: OutputAspect;
  blob: Blob;
  filename: string;
  /** 视频节点的标题，例如「预演台轨道录制 1(1080p 16:9)」。 */
  displayName: string;
  /** 成片时长，盖到视频节点上：节点有了这个值就不用再加载一遍元数据去探。 */
  durationMs: number;
  /** 注入而不是直接 import：这样测试不用去 mock 整个 @/api/ops。 */
  uploadVideo: (project: string, file: Blob, filename: string) => Promise<{ url: string }>;
  addDerivedVideoNode: (
    sourceNodeId: string,
    videoUrl: string,
    aspectRatio: string,
    displayName: string,
    durationMs: number,
  ) => string | null;
  addEdge: (source: string, target: string) => string | null;
}

export type PublishRecordingResult =
  | { ok: true; nodeId: string; url: string }
  | { ok: false; reason: 'upload' | 'node'; blob: Blob };

export async function publishRecording(
  deps: PublishRecordingDeps,
): Promise<PublishRecordingResult> {
  let url: string;
  try {
    const uploaded = await deps.uploadVideo(deps.project, deps.blob, deps.filename);
    url = uploaded.url;
  } catch {
    return { ok: false, reason: 'upload', blob: deps.blob };
  }
  const nodeId = deps.addDerivedVideoNode(
    deps.sourceNodeId,
    url,
    deps.aspect,
    deps.displayName,
    deps.durationMs,
  );
  // 源节点已经被删掉时返回 null。这时候连线会指向一个不存在的目标，画布 store
  // 会悄悄丢掉这条边，留下一个孤儿节点——不如直接报失败。
  if (!nodeId) return { ok: false, reason: 'node', blob: deps.blob };
  deps.addEdge(deps.sourceNodeId, nodeId);
  return { ok: true, nodeId, url };
}
