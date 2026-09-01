// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitFreezoneTextTranslate = vi.hoisted(() => vi.fn());
const fetchFreezoneTextTranslateResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneTextTranslate,
  fetchFreezoneTextTranslateResult,
}));
vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  awaitTaskCompletion,
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));

import { translateNodeText } from '@/features/canvas/application/translateText';

describe('translateNodeText（共享翻译核心，原 5 处节点内联实现）', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    submitFreezoneTextTranslate.mockReset();
    fetchFreezoneTextTranslateResult.mockReset();
    awaitTaskCompletion.mockReset();
  });

  it('提交（带 canvasId/nodeId 上下文）→ 等完成 → 返回译文', async () => {
    submitFreezoneTextTranslate.mockResolvedValue({
      task_key: 'tk-t',
      task_type: 'freezone_text_translate',
      job_id: 'job-t',
    });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneTextTranslateResult.mockResolvedValue({
      translated_text: 'a cinematic shot',
      source_language: 'zh',
      target_language: 'en',
      node_type: 'video',
    });

    const translated = await translateNodeText('proj-1', {
      text: '一个电影感镜头',
      nodeId: 'vid-1',
      nodeType: 'video',
    });

    expect(submitFreezoneTextTranslate).toHaveBeenCalledWith('proj-1', {
      text: '一个电影感镜头',
      nodeType: 'video',
      canvasId: 'canvas-1',
      nodeId: 'vid-1',
    });
    expect(awaitTaskCompletion).toHaveBeenCalledWith('tk-t', 'proj-1');
    expect(fetchFreezoneTextTranslateResult).toHaveBeenCalledWith('proj-1', 'job-t');
    expect(translated).toBe('a cinematic shot');
  });

  it('canvasId 缺省回退 default（与原实现一致）', async () => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: null });
    submitFreezoneTextTranslate.mockResolvedValue({
      task_key: 'tk',
      task_type: 'freezone_text_translate',
      job_id: 'j',
    });
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneTextTranslateResult.mockResolvedValue({ translated_text: 'x' });

    await translateNodeText('proj-1', { text: 'hi', nodeId: 'n1', nodeType: 'text' });
    expect(submitFreezoneTextTranslate.mock.calls[0][1]).toMatchObject({
      canvasId: 'default',
    });
  });

  it('失败向上抛（加载态/回写由调用方自持）', async () => {
    submitFreezoneTextTranslate.mockRejectedValue(new Error('translate down'));
    await expect(
      translateNodeText('proj-1', { text: 'hi', nodeId: 'n1', nodeType: 'text' }),
    ).rejects.toThrow('translate down');
  });
});
