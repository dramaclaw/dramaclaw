// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { apiCall } from "./client";

/**
 * Beat 的 selected_background.png 是从场景资产 (master / reverse / director_env)
 * "选源 → 复制" 而来。后端实现在 utils/background_anchor.py
 * (select_background_anchor) + 路由 PATCH /background-anchor。
 *
 * 我们前端把这条 API 暴露在 beat workbench 上 — 用户点 scene_master /
 * scene_reverse_master 节点上的 "用作背景源" 按钮 → 调这个 → 选定背景被
 * 刷新到本 beat slot。
 *
 * 支持的 anchor_id (见 background_anchor.py:22-25):
 *   - "master"               (= scene_master 图)
 *   - "reverse"              (= scene_reverse_master 图)
 *   - "director_env_only"    (= 导演阶段环境渲染,不带 actor)
 *   - "selected_background"  (self,已选定的;一般不主动 set)
 *
 * scene_director_pano_360 / scene_3gs_*_ply 暂不直接支持 (360 panorama 是 2:1,
 * 需要 cropper 选区域;3GS world 需要先 capture 截图)。这两条留作后续 cropper
 * / capture step UI 接入。
 */
export type BackgroundAnchorId =
  | "master"
  | "reverse"
  | "director_env_only"
  | "selected_background";

export interface BackgroundAnchorsResponse {
  ok: boolean;
  data?: {
    scene_id?: string;
    selected_anchor_id?: string;
    anchors?: Array<{
      id?: string;
      anchor_id?: string;
      label?: string;
      url?: string;
      exists?: boolean;
    }>;
  };
  error?: string;
}

/**
 * PATCH /background-anchor — 选择 anchor_id 作为 beat 的背景源,
 * backend 会把对应 source 文件 (master.png / reverse.png 等) snapshot 到
 * beat 的 selected_background.png slot。
 */
export async function selectBeatBackgroundAnchor(
  project: string,
  episode: number,
  beat: number,
  anchorId: BackgroundAnchorId,
): Promise<BackgroundAnchorsResponse> {
  return await apiCall<BackgroundAnchorsResponse>(
    `projects/${encodeURIComponent(project)}/episodes/${episode}/beats/${beat}/background-anchor`,
    {
      method: "PATCH",
      json: { anchor_id: anchorId },
    },
  );
}

/**
 * POST /background-anchor/upload — 上传一张外部图片作为 beat 的
 * selected_background.png。后端 RGB 转换 + 保存 + 更新 scene_ref。
 *
 * 用途: 360 panorama 当前视角截图 + 3GS world 取景截图 — 这两种来源
 * 不是 anchor_id 直接支持的固定文件 (master/reverse/director_env_only),
 * 而是用户在 viewer 里实时取景产生的 blob,所以走 upload 路径。
 *
 * 后端 multipart/form-data,field 名 'file'。
 */
export async function uploadBeatBackgroundAnchor(
  project: string,
  episode: number,
  beat: number,
  blob: Blob,
  filename: string,
): Promise<BackgroundAnchorsResponse> {
  const form = new FormData();
  form.append("file", blob, filename);
  return await apiCall<BackgroundAnchorsResponse>(
    `projects/${encodeURIComponent(project)}/episodes/${episode}/beats/${beat}/background-anchor/upload`,
    {
      method: "POST",
      body: form,
      // No timeout on uploads: the clock would race the user's uplink, not the
      // server (see uploadApi in lib/api.ts).
      timeout: false,
    },
  );
}
