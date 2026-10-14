// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { compileFreezoneRecipePrompt, generateFreezoneRecipeText } from '@/api/ops';
import { CANVAS_NODE_TYPES } from '../domain/canvasNodes';
import {
  compileWorkflowNodePrompt,
  generateWorkflowText,
  selectWorkflowUpstreamText,
} from './workflowRecipeRuntime';
import {
  bindWorkflowProductOperation,
  clearWorkflowProductOperation,
  WORKFLOW_EXECUTION_ACTIVITY_EVENT,
  type WorkflowExecutionActivityDetail,
} from './workflowExecutionActivity';

vi.mock('@/api/ops', () => ({
  compileFreezoneRecipePrompt: vi.fn(),
  generateFreezoneRecipeText: vi.fn(),
}));

const compileMock = vi.mocked(compileFreezoneRecipePrompt);
const generateTextMock = vi.mocked(generateFreezoneRecipeText);

describe('workflowRecipeRuntime', () => {
  beforeEach(() => {
    compileMock.mockReset();
    generateTextMock.mockReset();
  });

  it('keeps legacy node prompts unchanged', async () => {
    const result = await compileWorkflowNodePrompt({
      nodeData: { prompt: 'manual' },
      nodeKind: 'image',
      nodePrompt: 'manual',
      fallbackPrompt: 'upstream\n\nmanual',
    });

    expect(result).toBe('upstream\n\nmanual');
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('compiles catalog-backed nodes with user goal and upstream context', async () => {
    compileMock.mockResolvedValue('compiled prompt');

    const result = await compileWorkflowNodePrompt({
      nodeData: {
        workflowCatalog: {
          skillId: 'ecommerce-product',
          skillVersion: '2.0.0',
          confirmedInputs: { aspect_ratio: '9:16', language: 'zh' },
          recipeId: 'ecommerce-scene-image',
          recipeVersion: '1',
          promptStrategy: 'previous_output',
          promptBuilder: { userGoal: '生成三张商品图' },
        },
      },
      nodeKind: 'image',
      nodePrompt: '北欧厨房',
      upstreamText: '银色咖啡机',
      fallbackPrompt: 'fallback',
      referenceMedia: [{ kind: 'image', label: '产品参考图' }],
    });

    expect(result).toBe('compiled prompt');
    expect(compileMock).toHaveBeenCalledWith({
      recipeId: 'ecommerce-scene-image',
      recipeVersion: '1',
      skillId: 'ecommerce-product',
      skillVersion: '2.0.0',
      confirmedInputs: { aspect_ratio: '9:16', language: 'zh' },
      nodeKind: 'image',
      promptStrategy: 'previous_output',
      nodePrompt: '北欧厨房',
      upstreamText: '银色咖啡机',
      userGoal: '生成三张商品图',
      referenceMedia: [{ kind: 'image', label: '产品参考图' }],
    });
  });

  it('does not forward legacy dependency arrays as confirmed Skill inputs', async () => {
    compileMock.mockResolvedValue('compiled background music prompt');

    await compileWorkflowNodePrompt({
      nodeData: {
        workflowCatalog: {
          skillId: 'short-drama-quick',
          confirmedInputs: ['n_script'],
          recipeId: 'drama-background-music',
          promptStrategy: 'ambient_bgm',
          inputStrategy: 'script_to_bgm',
          promptBuilder: 'episode_bgm',
        },
      },
      nodeKind: 'audio',
      nodePrompt: '冷灰海浪氛围配乐',
      upstreamText: '',
      fallbackPrompt: '第1集剧本\n\n冷灰海浪氛围配乐',
    });

    expect(compileMock).toHaveBeenCalledWith({
      recipeId: 'drama-background-music',
      recipeVersion: '',
      skillId: 'short-drama-quick',
      skillVersion: '',
      confirmedInputs: {},
      nodeKind: 'audio',
      promptStrategy: 'llm_refine',
      nodePrompt: '冷灰海浪氛围配乐',
      upstreamText: '',
      userGoal: '',
      referenceMedia: undefined,
    });
  });

  it('reports Recipe compilation and task submission phases', async () => {
    compileMock.mockResolvedValue('compiled prompt');
    const phases: string[] = [];
    const listener = (event: Event) => {
      phases.push(
        (event as CustomEvent<WorkflowExecutionActivityDetail>).detail.phase,
      );
    };
    window.addEventListener(WORKFLOW_EXECUTION_ACTIVITY_EVENT, listener);

    try {
      await compileWorkflowNodePrompt({
        nodeId: 'image-1',
        nodeData: { workflowCatalog: { recipeId: 'product-image' } },
        nodeKind: 'image',
        nodePrompt: '商品图',
        fallbackPrompt: 'fallback',
      });
    } finally {
      window.removeEventListener(WORKFLOW_EXECUTION_ACTIVITY_EVENT, listener);
    }

    expect(phases).toEqual(['compiling_recipe', 'submitting']);
  });

  it('binds workflow Recipe compilation to its admitted product operation', async () => {
    compileMock.mockResolvedValue('compiled prompt');
    bindWorkflowProductOperation('image-billed', {
      projectId: 'project-a',
      operationId: 'agent_product_a',
    });

    try {
      await compileWorkflowNodePrompt({
        nodeId: 'image-billed',
        nodeData: { workflowCatalog: { recipeId: 'product-image' } },
        nodeKind: 'image',
        nodePrompt: '商品图',
        fallbackPrompt: 'fallback',
      });
    } finally {
      clearWorkflowProductOperation('image-billed');
    }

    expect(compileMock).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
      productOperationId: 'agent_product_a',
    }));
  });

  it('reuses the saved compiled prompt when manually rerunning after the product operation ends', async () => {
    const result = await compileWorkflowNodePrompt({
      nodeId: 'image-finished',
      nodeData: {
        workflowCatalog: { recipeId: 'metered-product-image' },
        workflowRecipeCompiledPrompt: '已编译的商品图提示词',
      },
      nodeKind: 'image',
      nodePrompt: '已编译的商品图提示词',
      fallbackPrompt: '不应使用的回退提示词',
      executionSource: 'manual',
    });

    expect(result).toBe('已编译的商品图提示词');
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('uses the edited prompt directly when manually rerunning a compiled node', async () => {
    const result = await compileWorkflowNodePrompt({
      nodeId: 'image-edited',
      nodeData: {
        workflowCatalog: { recipeId: 'metered-product-image' },
        workflowRecipeCompiledPrompt: '旧的编译结果',
      },
      nodeKind: 'image',
      nodePrompt: '用户修改后的最终提示词',
      fallbackPrompt: '不应使用的回退提示词',
      executionSource: 'manual',
    });

    expect(result).toBe('用户修改后的最终提示词');
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('supports manually rerunning an older completed node without saved compile metadata', async () => {
    const result = await compileWorkflowNodePrompt({
      nodeId: 'legacy-completed-image',
      nodeData: {
        workflowCatalog: { recipeId: 'metered-product-image' },
        imageUrl: '/static/existing-result.png',
      },
      nodeKind: 'image',
      nodePrompt: '旧节点当前保存的提示词',
      fallbackPrompt: 'fallback',
      executionSource: 'manual',
    });

    expect(result).toBe('旧节点当前保存的提示词');
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('still recompiles a saved prompt while an admitted product operation is bound', async () => {
    compileMock.mockResolvedValue('本轮重新编译结果');
    bindWorkflowProductOperation('image-running', {
      projectId: 'project-a',
      operationId: 'agent_product_rerun',
    });

    try {
      const result = await compileWorkflowNodePrompt({
        nodeId: 'image-running',
        nodeData: {
          workflowCatalog: { recipeId: 'metered-product-image' },
          workflowRecipeCompiledPrompt: '上轮编译结果',
        },
        nodeKind: 'image',
        nodePrompt: '本轮输入',
        fallbackPrompt: 'fallback',
      });
      expect(result).toBe('本轮重新编译结果');
    } finally {
      clearWorkflowProductOperation('image-running');
    }

    expect(compileMock).toHaveBeenCalledWith(expect.objectContaining({
      productOperationId: 'agent_product_rerun',
    }));
  });

  it('recompiles an existing CE workflow node without a product operation', async () => {
    compileMock.mockResolvedValue('根据新上游编译的提示词');

    const result = await compileWorkflowNodePrompt({
      nodeId: 'ce-workflow-image',
      nodeData: {
        workflowCatalog: { recipeId: 'ce-product-image' },
        workflowRecipeCompiledPrompt: '上轮编译结果',
        imageUrl: '/static/existing-result.png',
      },
      nodeKind: 'image',
      nodePrompt: '本轮输入',
      upstreamText: '新的上游内容',
      fallbackPrompt: 'fallback',
      executionSource: 'workflow',
    });

    expect(result).toBe('根据新上游编译的提示词');
    expect(compileMock).toHaveBeenCalledWith(expect.objectContaining({
      recipeId: 'ce-product-image',
      nodePrompt: '本轮输入',
      upstreamText: '新的上游内容',
    }));
    expect(compileMock).not.toHaveBeenCalledWith(expect.objectContaining({
      productOperationId: expect.anything(),
    }));
  });

  it('keeps explicitly connected HTML text even when Recipe selects user assets', async () => {
    generateTextMock.mockResolvedValue('<html></html>');
    await generateWorkflowText({nodeData: {workflowCatalog: {recipeId: 'page', inputStrategy: {type: 'user_assets'}}}, nodePrompt: 'Build', upstreamText: 'Manually connected copy', upstreamInputMode: 'connected'});
    expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({upstreamText: 'Manually connected copy'}));
  });

  it('executes a catalog-backed text node', async () => {
    generateTextMock.mockResolvedValue('# 电商方案');

    const result = await generateWorkflowText({
      nodeData: {
        workflowCatalog: {
          recipeId: 'ecommerce-text-plan',
          recipeVersion: 1,
          userGoal: '生成三屏详情页',
        },
      },
      nodePrompt: '咖啡机卖点',
      upstreamText: '银色金属机身',
    });

    expect(result).toBe('# 电商方案');
    expect(generateTextMock).toHaveBeenCalledWith({
      recipeId: 'ecommerce-text-plan',
      recipeVersion: '1',
      nodePrompt: '咖啡机卖点',
      upstreamText: '银色金属机身',
      userGoal: '生成三屏详情页',
    });
  });

  it('passes an ordered supplemental Recipe pipeline to the compiler', async () => {
    compileMock.mockResolvedValue('combined prompt');

    await compileWorkflowNodePrompt({
      nodeData: {
        workflowCatalog: {
          recipeId: 'shotlist',
          recipePipeline: [
            { id: 'cinematic-lighting', version: 2 },
            'identity-continuity',
          ],
        },
      },
      nodeKind: 'image',
      nodePrompt: '雨夜街道中的主角',
      fallbackPrompt: 'fallback',
    });

    expect(compileMock).toHaveBeenCalledWith(expect.objectContaining({
      recipeId: 'shotlist',
      recipePipeline: [
        { id: 'cinematic-lighting', version: '2' },
        { id: 'identity-continuity' },
      ],
    }));
  });

  it('selects only upstream text declared by inputStrategy', () => {
    const result = selectWorkflowUpstreamText(
      {
        workflowCatalog: {
          inputStrategy: { type: 'previous_step', step_id: 'brief' },
        },
      },
      [
        {
          nodeId: 'outline-node',
          nodeType: CANVAS_NODE_TYPES.textAnnotation,
          workflowStepId: 'outline',
          text: '创意大纲',
        },
        {
          nodeId: 'brief-node',
          nodeType: CANVAS_NODE_TYPES.textAnnotation,
          workflowStepId: 'brief',
          text: '广告脚本',
        },
      ],
      '创意大纲\n\n广告脚本',
    );

    expect(result).toBe('广告脚本');
  });

  it('suppresses text context for user-assets-only strategies', () => {
    expect(selectWorkflowUpstreamText(
      { workflowCatalog: { inputStrategy: { type: 'user_assets' } } },
      undefined,
      '不应传入模型',
    )).toBe('');
  });
});
