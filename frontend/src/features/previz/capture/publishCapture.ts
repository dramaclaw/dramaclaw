// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { OutputAspect } from '../domain/scene';

export interface PublishCaptureDeps {
  project: string;
  /** 预演台节点自己的 id，新节点挂在它右边。 */
  sourceNodeId: string;
  aspect: OutputAspect;
  blob: Blob;
  /** 注入而不是直接 import：这样测试不用去 mock 整个 @/api/ops。 */
  uploadImage: (project: string, file: Blob, filename: string) => Promise<{ url: string }>;
  addDerivedUploadNode: (
    sourceNodeId: string,
    imageUrl: string,
    aspectRatio: string,
  ) => string | null;
  addEdge: (source: string, target: string) => string | null;
  now?: () => number;
}

export type PublishCaptureResult =
  | { ok: true; nodeId: string; url: string }
  | { ok: false; reason: 'upload' | 'node'; blob: Blob };

/** `previz-20260901T123045.png`：可排序，且同一秒内不会重名到看不出来。 */
export function captureFilename(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `previz-${stamp}.png`;
}

/**
 * 上传截图并在画布上接出一个上传图节点。
 *
 * 任何一步失败都把 Blob 原样带回去：重试不必重渲，用户也还能自己存下来。
 */
export async function publishCapture(deps: PublishCaptureDeps): Promise<PublishCaptureResult> {
  const filename = captureFilename((deps.now ?? Date.now)());

  let url: string;
  try {
    const uploaded = await deps.uploadImage(deps.project, deps.blob, filename);
    url = uploaded.url;
  } catch {
    return { ok: false, reason: 'upload', blob: deps.blob };
  }

  const nodeId = deps.addDerivedUploadNode(deps.sourceNodeId, url, deps.aspect);
  // 源节点已经被删掉时返回 null。这时候连线会指向一个不存在的目标，画布 store
  // 会悄悄丢掉这条边，留下一个孤儿节点——不如直接报失败。
  if (!nodeId) return { ok: false, reason: 'node', blob: deps.blob };

  deps.addEdge(deps.sourceNodeId, nodeId);
  return { ok: true, nodeId, url };
}
