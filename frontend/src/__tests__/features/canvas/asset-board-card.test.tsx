// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AssetBoardItem } from '@/features/canvas/domain/assetBoard';
import { AssetBoardCard } from '@/features/canvas/ui/asset-board/AssetBoardCard';

function item(overrides: Partial<AssetBoardItem>): AssetBoardItem {
  return {
    nodeId: 'n1',
    column: 'video',
    title: '测试卡片',
    mediaUrl: null,
    thumbnailUrl: null,
    textPreview: null,
    model: null,
    durationSec: null,
    widthPx: null,
    heightPx: null,
    videoRole: null,
    references: [],
    timestamp: null,
    isGenerating: false,
    generationError: null,
    generationStartedAt: null,
    keyElementCategory: null,
    ...overrides,
  };
}

describe('AssetBoardCard', () => {
  it('视频卡渲染标题 + 模型/时长/分辨率徽标 + 成片角标', () => {
    render(
      <AssetBoardCard
        item={item({
          title: 'SB-01 街头发现光',
          model: 'wan2.5',
          durationSec: 5,
          widthPx: 720,
          heightPx: 1280,
          videoRole: 'final',
          thumbnailUrl: '/static/poster.png',
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    expect(screen.getByText('SB-01 街头发现光')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SB-01 街头发现光' })).toBeInTheDocument();
    expect(screen.getByText('wan2.5')).toBeInTheDocument();
    expect(screen.getByText('5秒')).toBeInTheDocument();
    expect(screen.getByText('720 × 1280')).toBeInTheDocument();
    expect(screen.getByText('成片')).toBeInTheDocument();
  });

  it('视频卡没记模型 → 不占位（只剩时长/分辨率）', () => {
    render(
      <AssetBoardCard
        item={item({ model: null, durationSec: 5, widthPx: 720, heightPx: 1280 })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    expect(screen.getByText('5秒')).toBeInTheDocument();
    expect(screen.getByText('720 × 1280')).toBeInTheDocument();
  });

  it('图片卡节点没记尺寸 → 用图片加载出的原始尺寸补分辨率徽标', () => {
    const { container } = render(
      <AssetBoardCard
        item={item({
          column: 'image',
          widthPx: null,
          heightPx: null,
          thumbnailUrl: '/static/a.png',
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    // jsdom 不真的解码图片：naturalWidth/complete 恒 0/false，手动桩成「已加载的 1024×768」。
    Object.defineProperty(img, 'naturalWidth', { value: 1024, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 768, configurable: true });
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    fireEvent.load(img);
    expect(screen.getByText('1024 × 768')).toBeInTheDocument();
  });

  it('图片卡节点已记尺寸 → 以节点数据为准，不去读图片', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'image', widthPx: 800, heightPx: 1328, thumbnailUrl: '/static/a.png' })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    expect(screen.getByText('800 × 1328')).toBeInTheDocument();
  });

  it('图片卡只显示分辨率，不挂模型徽标（用户拍板：图片栏不看模型）', () => {
    render(
      <AssetBoardCard
        item={item({
          column: 'image',
          model: 'seedream4.0',
          widthPx: 800,
          heightPx: 1328,
          thumbnailUrl: '/static/a.png',
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    expect(screen.getByText('800 × 1328')).toBeInTheDocument();
    expect(screen.queryByText('seedream4.0')).not.toBeInTheDocument();
  });

  it('参考素材行：有引用时渲染缩略图，点击触发 onPreviewImage', () => {
    const onPreviewImage = vi.fn();
    render(
      <AssetBoardCard
        item={item({
          references: [
            { nodeId: 'r1', label: '角色图A', thumbnailUrl: '/static/a.png' },
            { nodeId: 'r2', label: '道具图B', thumbnailUrl: '/static/b.png' },
          ],
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={onPreviewImage}
      />,
    );
    // 「参考素材」标题已去掉，只留缩略图本身。
    expect(screen.queryByText('参考素材')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '角色图A' }));
    expect(onPreviewImage).toHaveBeenCalledWith('/static/a.png');
  });

  it('参考素材 hover 出菜单：编辑→onOpenReference(ref)，定位→onLocateReference(nodeId)，都不冒泡 onOpen', () => {
    const onOpen = vi.fn();
    const onOpenReference = vi.fn();
    const onLocateReference = vi.fn();
    const ref = { nodeId: 'r1', label: '角色图A', thumbnailUrl: '/static/a.png' };
    render(
      <AssetBoardCard
        item={item({ references: [ref] })}
        onOpen={onOpen}
        onLocate={() => {}}
        onPreviewImage={() => {}}
        onOpenReference={onOpenReference}
        onLocateReference={onLocateReference}
      />,
    );
    const thumb = screen.getByRole('button', { name: '角色图A' });
    // hover 前没有菜单；移入缩略图才展开（与详情面板的参考菜单同一组件）。
    expect(screen.queryByRole('menuitem', { name: '编辑' })).not.toBeInTheDocument();
    fireEvent.mouseEnter(thumb.parentElement as HTMLElement);

    fireEvent.click(screen.getByRole('menuitem', { name: '编辑' }));
    expect(onOpenReference).toHaveBeenCalledWith(ref);

    fireEvent.mouseEnter(thumb.parentElement as HTMLElement);
    fireEvent.click(screen.getByRole('menuitem', { name: '定位' }));
    expect(onLocateReference).toHaveBeenCalledWith('r1');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('自带参考图（nodeId=null）：故事板里无卡可滚 → 菜单只留「编辑」，不给「定位」', () => {
    render(
      <AssetBoardCard
        item={item({
          references: [{ nodeId: null, label: '自带图', thumbnailUrl: '/static/own.png' }],
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
        onOpenReference={() => {}}
        onLocateReference={() => {}}
      />,
    );
    const thumb = screen.getByRole('button', { name: '自带图' });
    fireEvent.mouseEnter(thumb.parentElement as HTMLElement);
    expect(screen.getByRole('menuitem', { name: '编辑' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '定位' })).not.toBeInTheDocument();
  });

  it('挂了菜单后，点缩略图仍是开灯箱预览（菜单只由 hover 驱动）', () => {
    const onPreviewImage = vi.fn();
    render(
      <AssetBoardCard
        item={item({
          references: [{ nodeId: 'r1', label: '角色图A', thumbnailUrl: '/static/a.png' }],
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={onPreviewImage}
        onOpenReference={() => {}}
        onLocateReference={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '角色图A' }));
    expect(onPreviewImage).toHaveBeenCalledWith('/static/a.png');
  });

  it('不传参考回调（纯导航窄列表）→ 光缩略图，不挂菜单', () => {
    const onPreviewImage = vi.fn();
    render(
      <AssetBoardCard
        item={item({
          references: [{ nodeId: 'r1', label: '角色图A', thumbnailUrl: '/static/a.png' }],
        })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={onPreviewImage}
      />,
    );
    const thumb = screen.getByRole('button', { name: '角色图A' });
    fireEvent.mouseEnter(thumb.parentElement as HTMLElement);
    expect(screen.queryByRole('menuitem', { name: '编辑' })).not.toBeInTheDocument();
    fireEvent.click(thumb);
    expect(onPreviewImage).toHaveBeenCalledWith('/static/a.png');
  });

  it('点击参考素材缩略图不冒泡触发 onOpen', () => {
    const onOpen = vi.fn();
    render(
      <AssetBoardCard
        item={item({
          references: [{ nodeId: 'r1', label: '角色图A', thumbnailUrl: '/static/a.png' }],
        })}
        onOpen={onOpen}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '角色图A' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('无封面有 mediaUrl 的视频卡渲染 <video> 且 src 带 #t=0.1 首帧定位', () => {
    const { container } = render(
      <AssetBoardCard
        item={item({ mediaUrl: '/static/clip.mp4', thumbnailUrl: null })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('/static/clip.mp4#t=0.1');
  });

  it('点击卡片主体触发 onOpen，点击定位按钮触发 onLocate 且不冒泡成 onOpen', () => {
    const onOpen = vi.fn();
    const onLocate = vi.fn();
    render(
      <AssetBoardCard
        item={item({ title: '定位测试' })}
        onOpen={onOpen}
        onLocate={onLocate}
        onPreviewImage={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('定位测试'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '在画布中定位' }));
    expect(onLocate).toHaveBeenCalledWith('n1');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('生成中（图片卡）：进度「生成中 X%...」叠在媒体区蒙层里，不跟在标题后面', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'image', thumbnailUrl: '/static/a.png', isGenerating: true })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    const overlay = screen.getByRole('status', { name: '生成中' });
    // 未给 generationStartedAt → 估算 hook 退化为「从挂载时刻计时」，渲染瞬间
    // elapsed≈0，百分比是 0。进度文案在媒体蒙层里（与 spinner 同框）。
    expect(within(overlay).getByText('生成中 0%...')).toBeInTheDocument();
    // 整卡只有这一处「生成中 X%」——不再在标题行另挂一份。
    expect(screen.getAllByText(/生成中 \d+%/)).toHaveLength(1);
  });

  it('生成中（文本卡）：无媒体区 → 进度回落到标题行内联', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'text', textPreview: '一段脚本', isGenerating: true })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    // 文本卡没有媒体蒙层（role=status），进度只能挂在标题行。
    expect(screen.queryByRole('status', { name: '生成中' })).not.toBeInTheDocument();
    expect(screen.getByText('生成中 0%...')).toBeInTheDocument();
  });

  it('生成中：给定 generationStartedAt 时，百分比按经过时间估算推进', () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      render(
        <AssetBoardCard
          item={item({
            column: 'image',
            thumbnailUrl: '/static/a.png',
            isGenerating: true,
            generationStartedAt: startedAt,
          })}
          onOpen={() => {}}
          onLocate={() => {}}
          onPreviewImage={() => {}}
        />,
      );
      expect(screen.getByText('生成中 0%...')).toBeInTheDocument();

      // 图片栏预估时长 20s（见 AssetBoardCard 的 ESTIMATED_GENERATION_DURATION_MS）：
      // 推进 4s → 33 个 120ms 轮询节拍（最后一拍落在 3960ms）→ 指数饱和估算为 24%。
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.getByText('生成中 24%...')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('生成失败：媒体区显示「失败」角标，title 含错误信息', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'image', generationError: '算力不足，生成失败' })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    const badge = screen.getByText('失败');
    expect(badge.closest('[title]')?.getAttribute('title')).toBe('算力不足，生成失败');
  });

  it('文本卡失败：标题旁显示内联「失败」指示，title 含错误信息', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'text', textPreview: '脚本正文', generationError: '生成超时' })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    const badge = screen.getByText('失败');
    expect(badge.closest('[title]')?.getAttribute('title')).toBe('生成超时');
  });

  it('定位令牌：scrollTargetToken 变化 → 滚进视野 + 加高亮标记；回 null → 清除高亮', () => {
    const scrollSpy = vi.fn();
    // jsdom 未实现 scrollIntoView —— 挂 spy 既避免报错也能断言「定位」触发滚动。
    Element.prototype.scrollIntoView = scrollSpy;
    const fixed = item({ nodeId: 'loc', title: '被定位卡' });
    const props = {
      item: fixed,
      onOpen: () => {},
      onLocate: () => {},
      onPreviewImage: () => {},
    };

    const { container, rerender } = render(<AssetBoardCard {...props} scrollTargetToken={null} />);
    const card = container.firstElementChild as HTMLElement;
    expect(card).not.toHaveAttribute('data-locate-highlight');
    expect(scrollSpy).not.toHaveBeenCalled();

    // 令牌置 1（本卡被定位）→ 滚进视野 + 高亮标记。
    rerender(<AssetBoardCard {...props} scrollTargetToken={1} />);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(card).toHaveAttribute('data-locate-highlight', 'true');

    // 令牌换 2（重复定位同一卡）→ 再次触发滚动。
    rerender(<AssetBoardCard {...props} scrollTargetToken={2} />);
    expect(scrollSpy).toHaveBeenCalledTimes(2);

    // 令牌回 null（定位切走）→ 高亮清除。
    rerender(<AssetBoardCard {...props} scrollTargetToken={null} />);
    expect(card).not.toHaveAttribute('data-locate-highlight');
  });

  it('文本卡片只渲染图标 + 标题，正文不进列表', () => {
    render(
      <AssetBoardCard
        item={item({ column: 'text', title: '锚点清单', textPreview: '广告分镜脚本正文……' })}
        onOpen={() => {}}
        onLocate={() => {}}
        onPreviewImage={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '锚点清单' })).toBeInTheDocument();
    // 正文预览已从列表移除（去详情里看）。
    expect(screen.queryByText('广告分镜脚本正文……')).not.toBeInTheDocument();
  });
});
