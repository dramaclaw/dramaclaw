// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 创作阶段（虾本）的通用文档存储客户端。
 *
 * 后端只认「一个 doc_id 对应一份 JSON」，不认识具体是圣经还是分集草稿。
 * 新增一种创作产物 = 在 storyDocs.ts 里加一个 doc id，**后端零改动**。
 */
import { apiCall } from "./client";

export interface StoryDoc<T = unknown> {
  doc_id: string;
  /** 从未写过时为 null——「还没写」是这个页面的正常初始态，不是错误。 */
  content: T | null;
  revision: number;
  updated_at: number;
}

export interface StoryDocSummary {
  doc_id: string;
  revision: number;
  updated_at: number;
}

export async function listStoryDocs(projectId: string): Promise<StoryDocSummary[]> {
  return await apiCall<StoryDocSummary[]>(
    `projects/${encodeURIComponent(projectId)}/story/docs`,
  );
}

export async function getStoryDoc<T = unknown>(
  projectId: string,
  docId: string,
): Promise<StoryDoc<T>> {
  return await apiCall<StoryDoc<T>>(
    `projects/${encodeURIComponent(projectId)}/story/docs/${encodeURIComponent(docId)}`,
  );
}

export async function putStoryDoc<T = unknown>(
  projectId: string,
  docId: string,
  content: T,
  baseRevision?: number,
): Promise<StoryDoc<T>> {
  return await apiCall<StoryDoc<T>>(
    `projects/${encodeURIComponent(projectId)}/story/docs/${encodeURIComponent(docId)}`,
    {
      method: "PUT",
      json: baseRevision === undefined
        ? { content }
        : { content, base_revision: baseRevision },
    },
  );
}

export async function deleteStoryDoc(projectId: string, docId: string): Promise<void> {
  await apiCall(
    `projects/${encodeURIComponent(projectId)}/story/docs/${encodeURIComponent(docId)}`,
    { method: "DELETE" },
  );
}

export interface StoryWriteResult {
  title: string | null;
  text: string;
  scene_count?: number;
}

/**
 * 用配置好的文本模型写某一步的产物。
 *
 * 提示词在前端组装（`buildStoryPrompt`），约束层只有一处实现；后端负责选模型、
 * 调用，以及把单集结果渲染成导入契约格式。
 */
export async function writeStoryStep(
  projectId: string,
  payload: { step_id: string; prompt: string; episode_number?: number },
): Promise<StoryWriteResult> {
  return await apiCall<StoryWriteResult>(
    `projects/${encodeURIComponent(projectId)}/story/write`,
    { method: "POST", json: payload, timeout: 5 * 60_000 },
  );
}
