import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MultiSelectionToolbar } from '@/features/canvas/ui/MultiSelectionToolbar';
import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

const warning = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { warning, success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  NodeToolbar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/features/canvas/ui/ZoomScaledToolbar', () => ({
  ZoomScaledToolbar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/features/freezone/canvasChatCommands', () => ({
  applyCanvasChatCommandsAsync: vi.fn(),
  cancelCanvasWorkflowExecution: vi.fn(),
  CANVAS_CHAT_COMMANDS_SCHEMA_VERSION: 1,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function seed(inGroup = false) {
  useCanvasStore.setState({ nodes: [
    { id: 'g', type: 'groupNode', position: { x: 0, y: 0 }, data: { storyGroup: true } },
    ...['a', 'b'].map((id) => ({ id, type: 'videoNode', selected: true,
      ...(inGroup ? { parentId: 'g' } : {}), position: { x: 0, y: 0 }, data: {} })),
  ] as CanvasNode[], edges: [] });
}

it('clicking the unavailable story creation entry explains the one-group limit', () => {
  seed();
  const before = useCanvasStore.getState().nodes;
  const view = render(<MultiSelectionToolbar />);
  fireEvent.click(view.getByRole('button', { name: 'canvas.multiSelect.group' }));
  fireEvent.click(view.getByRole('button', { name: 'canvas.story.messages.createStoryGroup' }));
  expect(warning).toHaveBeenCalledWith('canvas.story.messages.storyGroupLimit');
  expect(useCanvasStore.getState().nodes).toBe(before);
});

it('copying a selected whole story group explains why it was rejected', () => {
  seed(true);
  const before = useCanvasStore.getState().nodes;
  const view = render(<MultiSelectionToolbar />);
  fireEvent.click(view.getByRole('button', { name: 'canvas.multiSelect.duplicate' }));
  expect(warning).toHaveBeenCalledWith('canvas.story.messages.storyGroupLimit');
  expect(useCanvasStore.getState().nodes).toBe(before);
});
