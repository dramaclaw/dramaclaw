// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 把编译好的剧本全文送进主线导入。
 *
 * 走的是现成的 `ingest/upload` + `ingest/start`，**后端零改动**——upload 收的是
 * multipart 文件，而我们手上正好有一段文本，在前端包成 File 即可。多加一条
 * 「文本导入」的后端接口只会多出一份要维护的入口，并且绕开 upload 那边已经做好的
 * 文件名清洗、格式校验和 spine_template 处理。
 */
import { api, uploadApi } from '@/lib/api';
import { p } from '@/lib/api-path';

export interface CompiledImportResult {
  filename: string;
}

/** 导入用的文件名。固定名字，重复导入即覆盖同一份草稿，不会在 uploads/ 里堆一堆同源文件。 */
export const COMPILED_SCREENPLAY_FILENAME = 'story-workspace.txt';

export async function importCompiledScreenplay(
  project: string,
  screenplay: string,
  options: { rebuild?: boolean } = {},
): Promise<CompiledImportResult> {
  const blob = new Blob([screenplay], { type: 'text/plain;charset=utf-8' });
  const formData = new FormData();
  formData.append('file', blob, COMPILED_SCREENPLAY_FILENAME);
  // 创作流程产出的是剧本（逐行台词），不是解说稿。
  formData.append('spine_template', 'drama');

  const uploaded = await uploadApi
    .post(p`api/v1/projects/${project}/ingest/upload`, { body: formData })
    .json<{ ok: boolean; error?: string; data?: { filename?: string } }>();
  if (!uploaded.ok) throw new Error(uploaded.error || 'upload failed');

  const filename = uploaded.data?.filename || COMPILED_SCREENPLAY_FILENAME;
  const started = await api
    .post(p`api/v1/projects/${project}/ingest/start`, {
      json: { filename, rebuild: options.rebuild ?? false },
    })
    .json<{ ok: boolean; error?: string }>();
  if (!started.ok) throw new Error(started.error || 'ingest failed');

  return { filename };
}
