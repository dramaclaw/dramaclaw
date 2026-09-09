import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { StoryGroupToolbar } from '@/features/canvas/ui/StoryGroupToolbar';
import { useCanvasStore } from '@/stores/canvasStore';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { FREEZONE_DOCK_OFFSET_ANIMATED_STYLE } from '@/features/freezone/dockOffset';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('选中故事组或其片段时显示右上角悬浮工具栏，非故事选择和试玩时隐藏', () => {
  useStoryRuntimeStore.setState({ mode: 'edit' });
  useCanvasStore.setState({ selectedNodeId: 'clip', nodes: [
    { id: 'g', type: 'groupNode', position: { x: 0, y: 0 }, data: { storyGroup: true, displayName: '小胡的故事' } },
    { id: 'clip', type: 'videoNode', parentId: 'g', position: { x: 0, y: 0 }, data: {} },
  ] as CanvasNode[] });
  const view = render(<StoryGroupToolbar />);
  expect(view.getByRole('toolbar')).toHaveAttribute('title', '小胡的故事');
  const region = view.container.querySelector('[data-story-toolbar-region]')!;
  expect(region).toHaveClass('absolute', 'right-4', 'top-1.5');
  expect(region).not.toHaveClass('relative', 'border-b');
  // 自动宽度配合抽屉右侧让位；w-full 会把按钮继续撑到抽屉下面。
  expect(region).not.toHaveClass('w-full');
  expect(region).toHaveClass('pointer-events-none');
  expect(region).toHaveStyle({ ...FREEZONE_DOCK_OFFSET_ANIMATED_STYLE });
  expect(view.getByRole('toolbar')).toHaveClass('flex-wrap');
  act(() => useCanvasStore.setState({ selectedNodeId: 'g' }));
  expect(view.getByRole('toolbar')).toBeInTheDocument();
  act(() => useCanvasStore.setState({ selectedNodeId: null }));
  expect(view.queryByRole('toolbar')).toBeNull();
  act(() => {
    useCanvasStore.setState({ selectedNodeId: 'g' });
    useStoryRuntimeStore.setState({ mode: 'play' });
  });
  expect(view.queryByRole('toolbar')).toBeNull();
});
