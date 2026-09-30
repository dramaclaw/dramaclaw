// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { submitFreezoneTemplateEdit } from '@/api/ops';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: 'demo-project', canvas: 'default' }),
}));

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ops')>()),
  fetchFreezoneImageModels: vi.fn(async () => [
    {
      id: 'huimeng/test-image',
      providerId: 'huimeng',
      apiModel: 'test_image_api',
      label: '测试模型',
    },
  ]),
  listFreezoneStyleTemplates: vi.fn(async () => []),
  fetchFreezoneCameraOptions: vi.fn(async () => null),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneTemplateEdit: vi.fn(async () => ({
    task_key: 'task-1',
    task_type: 'freezone_template_edit',
    job_id: 'job-1',
  })),
  fetchFreezoneJobResult: vi.fn(async () => ({ url: '/static/out.png' })),
}));

vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/tasks')>()),
  awaitTaskCompletion: vi.fn(async () => ({
    result: { output_url: '/static/out.png' },
  })),
}));

const SOURCE_NODE: CanvasNode = {
  id: 'src-1',
  type: CANVAS_NODE_TYPES.upload,
  position: { x: 0, y: 0 },
  data: {
    imageUrl: '/static/source.png',
    aspectRatio: '16:9',
    displayName: '源图',
  },
};

function detailPanel() {
  return screen.getByRole('region', { name: '资产详情' });
}

function nodeData(nodeId: string): Record<string, unknown> {
  const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  return (node?.data ?? {}) as Record<string, unknown>;
}

function spawnedOpNode(): CanvasNode {
  const spawned = useCanvasStore
    .getState()
    .nodes.find((candidate) => candidate.id !== SOURCE_NODE.id);
  if (!spawned) throw new Error('功能节点没有被创建');
  return spawned;
}

function promptEditor(): HTMLElement {
  const editor = detailPanel().querySelector('.prompt-mention-editor');
  if (!(editor instanceof HTMLElement)) throw new Error('提示词输入框没渲染出来');
  return editor;
}

function opChip(): HTMLElement {
  return within(detailPanel()).getByTitle(/点击切换功能，退格删除/);
}

/** 把光标塌缩到 chip 正后面——用户想删掉它时手指所在的位置。 */
function putCaretAfterChip(): void {
  const host = promptEditor().querySelector('[data-lead-chip]');
  if (!host) throw new Error('chip 宿主节点不在输入框里');
  const range = document.createRange();
  range.setStartAfter(host);
  range.collapse(true);
  const selection = window.getSelection();
  if (!selection) throw new Error('环境没有 Selection');
  selection.removeAllRanges();
  selection.addRange(range);
}

/** 打开源图详情 → 展开「宫格模板」下拉 → 点某个功能。 */
async function pickGridOp(label: string) {
  const user = userEvent.setup();
  useCanvasStore.getState().setCanvasData([SOURCE_NODE], []);
  render(<AssetBoardView visible onLocateNode={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '源图' }));
  await user.click(within(detailPanel()).getByRole('button', { name: '宫格模板' }));
  await user.click(await screen.findByRole('menuitem', { name: new RegExp(label) }));
  return user;
}

describe('故事板 · 功能 chip（点功能建节点 → 确认后生成）', () => {
  beforeEach(() => {
    vi.mocked(submitFreezoneTemplateEdit).mockClear();
  });

  it('点功能只建节点、不提交：新节点是 imageGen、节点名=功能名、记住源图并连边', async () => {
    await pickGridOp('多机位九宫格');

    const spawned = spawnedOpNode();
    expect(spawned.type).toBe(CANVAS_NODE_TYPES.imageGen);
    const data = spawned.data as Record<string, unknown>;
    expect(data.displayName).toBe('多机位九宫格');
    expect(data.imageOpKey).toBe('multiCameraGrid');
    expect(data.imageOpSourceUrl).toBe('/static/source.png');
    expect(data.isGenerating).toBe(false);
    // 连在源节点下游。
    expect(
      useCanvasStore
        .getState()
        .edges.some((edge) => edge.source === SOURCE_NODE.id && edge.target === spawned.id),
    ).toBe(true);
    // 关键：这一步不提交。
    expect(submitFreezoneTemplateEdit).not.toHaveBeenCalled();
  });

  it('chip 落在提示词输入框内部：功能说明当占位文案，且不混进 prompt', async () => {
    await pickGridOp('角色三视图生成');
    const spawnedId = spawnedOpNode().id;

    const editor = promptEditor();
    // chip 是输入框里的一个内联块，不是输入框上方另起的一行控件。
    expect(editor.contains(opChip())).toBe(true);
    // 功能说明就是占位文案（接在 chip 右边同一行）。
    expect(editor.getAttribute('data-placeholder')).toContain(
      '直接基于当前图像生成完整的角色三视图',
    );

    // chip 只是展示节点：用户打的字才是 prompt，chip 文案不会被序列化进去。
    editor.appendChild(document.createTextNode('侧脸再清楚点'));
    fireEvent.input(editor);
    expect(nodeData(spawnedId).prompt).toBe('侧脸再清楚点');
  });

  it('提示词留空也能提交（↑ 走对应模板，prompt 兜底用功能名）', async () => {
    await pickGridOp('产品三视图');

    const submit = within(detailPanel()).getByRole('button', { name: '生成' });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(submitFreezoneTemplateEdit).toHaveBeenCalled());
    const [project, payload] = vi.mocked(submitFreezoneTemplateEdit).mock.calls[0];
    expect(project).toBe('demo-project');
    expect(payload.sourceUrl).toBe('/static/source.png');
    expect(payload.mode).toBe('product_three_view');
    expect(payload.prompt).toBe('产品三视图');
    // 产物回填到功能节点自己身上，而不是再建一个结果节点。
    await waitFor(() => expect(nodeData(spawnedOpNode().id).imageUrl).toBe('/static/out.png'));
    expect(useCanvasStore.getState().nodes).toHaveLength(2);
  });

  it('场景设定图：功能框「设定图」栏里能切到，提交走 scene_setting_sheet 模板', async () => {
    const user = await pickGridOp('多机位九宫格');
    const spawnedId = spawnedOpNode().id;

    await user.click(opChip());
    await user.click(screen.getByRole('button', { name: /^场景设定图/ }));
    expect(nodeData(spawnedId).imageOpKey).toBe('sceneSettingSheet');
    expect(nodeData(spawnedId).displayName).toBe('场景设定图');

    fireEvent.click(within(detailPanel()).getByRole('button', { name: '生成' }));

    await waitFor(() => expect(submitFreezoneTemplateEdit).toHaveBeenCalled());
    const [, payload] = vi.mocked(submitFreezoneTemplateEdit).mock.calls[0];
    expect(payload.mode).toBe('scene_setting_sheet');
    expect(payload.prompt).toBe('场景设定图');
  });

  it('点 chip 展开功能框（四栏），选另一个功能 → key 与节点名一起换', async () => {
    const user = await pickGridOp('剧情推演四宫格');
    const spawnedId = spawnedOpNode().id;

    await user.click(opChip());
    for (const category of ['分镜叙事', '空间与机位', '设定图', '质感调节']) {
      expect(await screen.findByText(category)).toBeInTheDocument();
    }
    // 每行是「功能名 + 一句话说明」，所以按名字前缀匹配。
    await user.click(screen.getByRole('button', { name: /^全景/ }));

    expect(nodeData(spawnedId).imageOpKey).toBe('scene360');
    expect(nodeData(spawnedId).displayName).toBe('全景');
  });

  it('在 chip 后面退格就能删掉它 → 退化成普通图片生成节点', async () => {
    await pickGridOp('电影级光影校正');
    const spawnedId = spawnedOpNode().id;

    putCaretAfterChip();
    fireEvent.keyDown(promptEditor(), { key: 'Backspace' });

    expect(nodeData(spawnedId).imageOpKey).toBeNull();
    expect(within(detailPanel()).queryByTitle(/点击切换功能，退格删除/)).not.toBeInTheDocument();
    expect(promptEditor().querySelector('[data-lead-chip]')).toBeNull();
    // 退回常规文生图：空提示词重新禁用提交。
    expect(within(detailPanel()).getByRole('button', { name: '生成' })).toBeDisabled();
  });
});
