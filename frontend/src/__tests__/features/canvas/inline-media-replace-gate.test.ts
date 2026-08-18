// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  hasInlineMediaReplaceButton,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { hasInlineCommitButton } from '@/features/canvas/ui/SelectedNodeOverlay';

function node(type: string, data: Record<string, unknown>): CanvasNode {
  return { id: 'n1', type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

describe('卡内「替换素材」按钮的开关', () => {
  it('只认逐帧拉片产出上的 allowLocalReplace', () => {
    expect(hasInlineMediaReplaceButton({ allowLocalReplace: true })).toBe(true);
    expect(hasInlineMediaReplaceButton({ allowLocalReplace: false })).toBe(false);
    expect(hasInlineMediaReplaceButton({})).toBe(false);
    expect(hasInlineMediaReplaceButton(null)).toBe(false);
    expect(hasInlineMediaReplaceButton(undefined)).toBe(false);
  });

  it('选中态本身不再是开关——普通生成结果不该长出这颗按钮', () => {
    // 选中与否是节点组件里的 selected，这里锁的是它已经不在判定式里：
    // 同一份 data 无论选中都只看 allowLocalReplace。
    expect(hasInlineMediaReplaceButton({ selected: true } as never)).toBe(false);
  });
});

describe('外侧 AssetCommitHandle 的互斥判定', () => {
  it('拉片产出的图片/视频/音频走卡内按钮，不再挂外侧抓手', () => {
    for (const type of [
      CANVAS_NODE_TYPES.exportImage,
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.audio,
    ]) {
      expect(hasInlineCommitButton(node(type, { allowLocalReplace: true }))).toBe(true);
    }
  });

  it('同类型的普通节点没有卡内按钮，外侧抓手必须留着', () => {
    // 这条是回归位：早先按 type 一刀切排除，普通视频/图片节点会连外侧抓手一起丢，
    // 「拖到素材库替换」彻底没入口。
    for (const type of [
      CANVAS_NODE_TYPES.exportImage,
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.audio,
    ]) {
      expect(hasInlineCommitButton(node(type, {}))).toBe(false);
    }
  });

  it('其余类型一律走外侧抓手', () => {
    expect(hasInlineCommitButton(node(CANVAS_NODE_TYPES.upload, { allowLocalReplace: true }))).toBe(
      false,
    );
    expect(hasInlineCommitButton(node(CANVAS_NODE_TYPES.imageGen, {}))).toBe(false);
  });
});
