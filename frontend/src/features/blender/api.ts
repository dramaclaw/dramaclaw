// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Blender 插件相关端点的浏览器侧调用。
 *
 * 用 `@/lib/api` 的全局 ky 实例而不是 `@/api/client` 的 `apiCall`：后者是
 * freezone 专用的 `{ok,data,error}` 信封，而这几个端点返回的是裸对象。
 */
import { api } from "@/lib/api";
import { p } from "@/lib/api-path";

/** 一条待认领的 Blender 投递。字段跟后端 `_INBOX_FIELDS` 一一对应。 */
export interface BlenderInboxItem {
  delivery_id: string;
  url: string;
  kind: "image" | "video";
  filename: string;
  camera: string;
  frame: number | null;
  frame_start: number | null;
  frame_end: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  created_at: number;
}

export interface BlenderClient {
  token_id: string;
  label: string;
  created_at: number;
  expires_at: number;
  last_seen: number | null;
}

/**
 * 取走本项目所有待认领的投递。**这个调用有副作用**：返回的行在服务端已经删了，
 * 调用方必须把它们用掉（建成画布节点），不能丢。
 */
export async function takeBlenderInbox(
  project: string,
  options?: { signal?: AbortSignal },
): Promise<BlenderInboxItem[]> {
  const response = await api
    .post(p`api/v1/projects/${project}/blender/inbox:take`, { signal: options?.signal })
    .json<{ items: BlenderInboxItem[] }>();
  return response.items ?? [];
}

export async function approveBlenderPairing(code: string): Promise<void> {
  await api.post("api/v1/blender/pairing/approve", { json: { code } }).json();
}

export async function listBlenderClients(): Promise<BlenderClient[]> {
  const response = await api.get("api/v1/blender/clients").json<{ clients: BlenderClient[] }>();
  return response.clients ?? [];
}

export async function revokeBlenderClient(tokenId: string): Promise<void> {
  await api.delete(p`api/v1/blender/clients/${tokenId}`).json();
}
