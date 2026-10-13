// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const submitFreezoneTemplateEdit = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneTemplateEdit,
  fetchFreezoneJobResult,
}));
vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  awaitTaskCompletion,
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));

import {
  runAssetBoardImageOp,
  spawnAssetBoardImageOpNode,
} from '@/features/canvas/application/assetBoardImageOps';

const JOB_REF = { task_key: 'tk-1', task_type: 'freezone_template_edit', job_id: 'job-1' };

function seedSourceNode() {
  const nodes: CanvasNode[] = [
    {
      id: 'img-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/a.png', aspectRatio: '1:1' },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

/**
 * 工作流工具条「九宫格」下拉的交互：与故事板详情工具条完全一致——点某一项只建
 * 一个功能节点（空的图片生成节点，节点名=功能名），提示词/参考图/比例都在那个节点
 * 上改，按 ↑ 才提交。原来那条「确认即提交」的浮条（GridActionConfirmOverlay）已撤掉。
 */
describe('工作流 · 宫格功能（点功能建节点 → ↑ 才提交）', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    submitFreezoneTemplateEdit.mockReset();
    fetchFreezoneJobResult.mockReset();
    awaitTaskCompletion.mockReset();
    seedSourceNode();
  });

  it('点功能只建节点、不提交：新节点是 imageGen、节点名=功能名、记住源图并连边', () => {
    const nextNodeId = spawnAssetBoardImageOpNode('img-1', '/static/a.png?sig=x', 'multiCameraGrid');

    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === nextNodeId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.imageGen);
    expect(created?.data).toMatchObject({
      displayName: '多机位九宫格',
      imageOpKey: 'multiCameraGrid',
      // 源图去掉签名 query 后记在节点上，↑ 时按它提交。
      imageOpSourceUrl: '/static/a.png',
      isGenerating: false,
    });
    expect(
      state.edges.some((edge) => edge.source === 'img-1' && edge.target === nextNodeId),
    ).toBe(true);
    // 关键：这一步不提交。
    expect(submitFreezoneTemplateEdit).not.toHaveBeenCalled();
  });

  it('↑ 提交：按功能映射的 mode 下发，产物回填到功能节点自己身上', async () => {
    submitFreezoneTemplateEdit.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: { output_url: '/static/out.png' } });

    const nextNodeId = spawnAssetBoardImageOpNode('img-1', '/static/a.png', 'sceneSettingSheet');
    await runAssetBoardImageOp(nextNodeId as string);

    expect(submitFreezoneTemplateEdit).toHaveBeenCalledWith('proj-1', {
      sourceUrl: '/static/a.png',
      mode: 'scene_setting_sheet',
      // 提示词留空 → 用功能名兜底。
      prompt: '场景设定图',
    });
    expect(awaitTaskCompletion).toHaveBeenCalledWith('tk-1', 'proj-1');
    // output_url 已有 → 不再兜底查 job result。
    expect(fetchFreezoneJobResult).not.toHaveBeenCalled();

    const state = useCanvasStore.getState();
    expect(state.nodes.find((node) => node.id === nextNodeId)?.data).toMatchObject({
      imageUrl: '/static/out.png',
      previewImageUrl: '/static/out.png',
      isGenerating: false,
      generationError: null,
    });
    // 不再额外建结果节点：源图 + 功能节点，就两个。
    expect(state.nodes).toHaveLength(2);
  });

  it('工具条下拉挂的是「建功能节点」而不是确认浮条', () => {
    const toolbar = readSource('src/features/canvas/ui/NodeActionToolbar.tsx');
    expect(toolbar).toContain('onSpawnGridActionNode({');
    // 下拉项不再自带提示词/算力——那是确认浮条时代的东西。
    expect(toolbar).not.toContain('gridMenu.multiCameraGridPrompt');

    const overlay = readSource('src/features/canvas/ui/SelectedNodeOverlay.tsx');
    expect(overlay).toContain('spawnAssetBoardImageOpNode(sourceNode.id, imageSource, request.key)');
    expect(overlay).toContain('selectAndFocusCanvasNode(nextNodeId)');
    expect(overlay).not.toContain('GridActionConfirmOverlay');
  });

  it('工作流与故事板的生成表单共用同一份功能 props（chip / 占位文案 / ↑ 走模板）', () => {
    for (const host of [
      'src/features/canvas/nodes/ImageGenNode.tsx',
      'src/features/canvas/ui/asset-board/AssetBoardImageGenForm.tsx',
    ]) {
      const source = readSource(host);
      expect(source).toContain('useImageOpFormProps(');
      expect(source).toContain('{...(opFormProps ?? {})}');
    }
  });
});
