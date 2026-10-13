// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { canvasNodeDefinitions, getMenuNodeDefinitions } from '../domain/nodeRegistry';
import type { CanvasNodeType } from '../domain/canvasNodes';
import type { NodeCatalog } from './ports';

export const nodeCatalog: NodeCatalog = {
  getDefinition: (type: CanvasNodeType) => canvasNodeDefinitions[type],
  getMenuDefinitions: getMenuNodeDefinitions,
};

/**
 * 展示在「添加节点」菜单中的创作入口，不是可直接落到画布上的 CanvasNodeType。
 * 普通节点走 nodeCatalog / nodeFactory；这两个入口通过事件打开虾导并预填草稿，
 * 用户发送需求、确认大纲后，再由专用故事工具创建剧本及其节点。
 * 名称、图标和草稿文案集中配置，添加面板与右键菜单共用同一套渲染。
 */
export const canvasCreationActions = [
  {
    id: 'interactive-story',
    menuLabelKey: 'node.menu.interactiveStory',
    menuIcon: 'gamepad',
    draftKey: 'node.menu.interactiveStoryDraft',
  },
  {
    id: 'interactive-ad',
    menuLabelKey: 'node.menu.interactiveAd',
    menuIcon: 'megaphone',
    draftKey: 'node.menu.interactiveAdDraft',
  },
] as const;

export type CanvasCreationActionId = (typeof canvasCreationActions)[number]['id'];
