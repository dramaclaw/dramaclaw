// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { ReferenceMaterialOption } from '@/features/canvas/application/referencePick';
import {
  PromptMentionEditor,
  type MentionCandidate,
} from '@/features/canvas/nodes/PromptMentionEditor';

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

const referenced: MentionCandidate[] = [
  { key: 'A', name: '图片1', imageUrl: 'https://example.com/a.png', index: 1 },
];

const materials: ReferenceMaterialOption[] = [
  { nodeId: 'N1', label: '场景设定图', kind: 'image', imageUrl: 'https://example.com/n1.png' },
  { nodeId: 'N2', label: '角色设定图', kind: 'image', imageUrl: 'https://example.com/n2.png' },
  { nodeId: 'N3', label: '空镜', kind: 'video', videoUrl: 'https://example.com/n3.mp4' },
];

function openReplaceMenu(container: HTMLElement) {
  const swap = container.querySelector('[data-mention-swap]');
  expect(swap).not.toBeNull();
  fireEvent.click(swap as Element);
}

describe('PromptMentionEditor — 替换引用选单', () => {
  it('chip 上的替换图标打开选单，分「已引用」和按种类分组的「素材引用」', () => {
    const { container } = render(
      <PromptMentionEditor
        value="@图片1 "
        onChange={() => {}}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={() => true}
      />,
    );

    expect(screen.queryByText('已引用')).toBeNull();
    openReplaceMenu(container);

    expect(screen.getByText('已引用')).toBeTruthy();
    expect(screen.getByText('素材引用')).toBeTruthy();
    // 分组行按种类聚合，画布素材不直接铺开。
    expect(screen.getByLabelText('图片素材')).toBeTruthy();
    expect(screen.getByLabelText('视频素材')).toBeTruthy();
    expect(screen.queryByText('场景设定图')).toBeNull();
  });

  it('悬停种类分组展开右侧清单', () => {
    const { container } = render(
      <PromptMentionEditor
        value="@图片1 "
        onChange={() => {}}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={() => true}
      />,
    );
    openReplaceMenu(container);

    fireEvent.mouseEnter(screen.getByLabelText('图片素材'));
    expect(screen.getByText('场景设定图')).toBeTruthy();
    expect(screen.getByText('角色设定图')).toBeTruthy();
    // 展开的是「图片」那组，视频素材不该混进来。
    expect(screen.queryByText('空镜')).toBeNull();
  });

  it('搜索时拉平成一个列表，跨已引用和画布素材一起筛', () => {
    const { container } = render(
      <PromptMentionEditor
        value="@图片1 "
        onChange={() => {}}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={() => true}
      />,
    );
    openReplaceMenu(container);

    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '角色' } });

    expect(screen.getByText('角色设定图')).toBeTruthy();
    expect(screen.queryByText('场景设定图')).toBeNull();
    // 已引用的「图片」对不上「角色」，整段消失。
    expect(screen.queryByText('已引用')).toBeNull();
  });

  it('选画布素材：先请宿主建引用，等它带编号进候选后才替换 @', () => {
    const onAttachMaterial = vi.fn(() => true);
    const onChange = vi.fn();
    const { container, rerender } = render(
      <PromptMentionEditor
        value="@图片1 "
        onChange={onChange}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={onAttachMaterial}
      />,
    );
    openReplaceMenu(container);
    fireEvent.mouseEnter(screen.getByLabelText('图片素材'));
    fireEvent.mouseDown(screen.getByText('场景设定图').closest('button') as Element);

    expect(onAttachMaterial).toHaveBeenCalledWith('N1');
    // 建边还没回流，此刻还不知道新引用的编号，chip 保持不动。
    expect(onChange).not.toHaveBeenCalled();
    expect(
      (container.querySelector('.mention-chip') as HTMLElement).dataset.mention,
    ).toBe('A');

    // 宿主连好线，新引用作为「图片2」进入候选。
    rerender(
      <PromptMentionEditor
        value="@图片1 "
        onChange={onChange}
        candidates={[
          ...referenced,
          { key: 'N1', name: '图片2', imageUrl: 'https://example.com/n1.png', index: 2 },
        ]}
        getMaterials={() => materials.filter((item) => item.nodeId !== 'N1')}
        onAttachMaterial={onAttachMaterial}
      />,
    );

    expect(onChange).toHaveBeenCalledWith('@图片2 ');
    const chips = container.querySelectorAll('.mention-chip');
    expect(chips.length).toBe(1);
    expect((chips[0] as HTMLElement).dataset.mention).toBe('N1');
  });

  it('没有 onAttachMaterial 的宿主只显示「已引用」', () => {
    const { container } = render(
      <PromptMentionEditor value="@图片1 " onChange={() => {}} candidates={referenced} />,
    );
    openReplaceMenu(container);

    expect(screen.getByText('已引用')).toBeTruthy();
    expect(screen.queryByText('素材引用')).toBeNull();
  });

  it('建引用被宿主拒绝时不留悬而未决的替换：后来同名候选出现也不动 chip', () => {
    const onChange = vi.fn();
    const reject = vi.fn(() => false);
    const { container, rerender } = render(
      <PromptMentionEditor
        value="@图片1 "
        onChange={onChange}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={reject}
      />,
    );
    openReplaceMenu(container);
    fireEvent.mouseEnter(screen.getByLabelText('图片素材'));
    fireEvent.mouseDown(screen.getByText('场景设定图').closest('button') as Element);

    expect(reject).toHaveBeenCalledWith('N1');
    // 用户过后从别的入口把同一个节点连上——那次的候选变化不该回头改这颗 chip。
    rerender(
      <PromptMentionEditor
        value="@图片1 "
        onChange={onChange}
        candidates={[
          ...referenced,
          { key: 'N1', name: '图片2', imageUrl: 'https://example.com/n1.png', index: 2 },
        ]}
        getMaterials={() => materials}
        onAttachMaterial={reject}
      />,
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(
      (container.querySelector('.mention-chip') as HTMLElement).dataset.mention,
    ).toBe('A');
  });

  it('Escape 关掉替换选单（焦点在选单自己的搜索框上）', () => {
    const { container } = render(
      <PromptMentionEditor
        value="@图片1 "
        onChange={() => {}}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={() => true}
      />,
    );
    openReplaceMenu(container);
    expect(screen.getByText('已引用')).toBeTruthy();

    fireEvent.keyDown(screen.getByPlaceholderText('搜索'), { key: 'Escape' });

    expect(screen.queryByText('已引用')).toBeNull();
  });
});
