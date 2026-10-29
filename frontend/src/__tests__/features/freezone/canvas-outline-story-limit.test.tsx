import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CanvasOutlineList } from '@/features/freezone/CanvasOutlineList';
import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

const warning = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { warning } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('outline group copy shows the limit without creating any nodes', async () => {
  useCanvasStore.setState({ nodes: [
    { id: 'story', type: 'groupNode', position: { x: 0, y: 0 }, data: { label: 'Story', storyGroup: true } },
    { id: 'clip', type: 'videoNode', parentId: 'story', position: { x: 0, y: 0 }, data: {} },
  ] as CanvasNode[], edges: [] });
  const before = useCanvasStore.getState().nodes;
  const view = render(<CanvasOutlineList />);
  fireEvent.click(view.getAllByRole('button', { name: 'freezone.canvasOutline.moreActions' })[0]);
  fireEvent.click(await view.findByRole('menuitem', { name: 'freezone.canvasOutline.duplicate' }));
  expect(warning).toHaveBeenCalledWith('canvas.story.messages.storyGroupLimit');
  expect(useCanvasStore.getState().nodes).toBe(before);
});
