import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { StoryVariablesPanel } from '@/components/canvas/StoryVariablesPanel';
import { StoryLintPanel } from '@/components/canvas/StoryLintPanel';
import { StoryTreePanel } from '@/components/canvas/StoryTreePanel';
import { FREEZONE_DOCK_OFFSET_ANIMATED_STYLE } from '@/features/freezone/dockOffset';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it.each([
  ['states', StoryVariablesPanel],
  ['readiness', StoryLintPanel],
  ['tree', StoryTreePanel],
] as const)('%s panel follows the chat dock offset and remains closable', (_name, Panel) => {
  useCanvasStore.setState({ nodes: [], edges: [] });
  const onClose = vi.fn();
  const view = render(<Panel groupId="story" onClose={onClose} />);
  const panel = view.container.firstElementChild!;
  expect(panel).toHaveStyle({ ...FREEZONE_DOCK_OFFSET_ANIMATED_STYLE });
  expect(panel).toHaveClass('right-4', 'top-16', 'z-30');
  expect(panel.className).toContain('max-w-[calc(100%_-_2rem_-_var(--freezone-dock-width,0px))]');
  fireEvent.click(view.getByRole('button', { name: 'common.close' }));
  expect(onClose).toHaveBeenCalledOnce();
});
