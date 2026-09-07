import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Position, type EdgeProps } from '@xyflow/react';
import { StoryChoiceEdge } from '@/features/canvas/edges/StoryChoiceEdge';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/domain/canvasNodes';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/canvas/StoryChoiceEditor', () => ({ StoryChoiceEditor: () => null }));

const props = {
  id: 'choice-a', source: 'a', target: 'b',
  sourceX: 0, sourceY: 0, targetX: 400, targetY: 0,
  sourcePosition: Position.Right, targetPosition: Position.Left,
  data: { choiceText: '进入房间' },
} as EdgeProps;

beforeEach(() => {
  vi.useFakeTimers();
  useCanvasStore.getState().setCanvasData(
    ['a', 'b'].map((id) => ({ id, type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 }, data: {} })),
    ['choice-a', 'choice-b'].map((id) => ({ id, source: 'a', target: 'b', type: STORY_CHOICE_EDGE_TYPE, data: { choiceText: id } })),
  );
});
afterEach(() => vi.useRealTimers());

it('悬停半秒后显示剪刀，跨入按钮不消失；只删当前边且可撤销', () => {
  const { getByRole, queryByRole } = render(<StoryChoiceEdge {...props} />);
  const label = getByRole('button', { name: 'canvas.story.choiceEditorTitle' });
  fireEvent.pointerEnter(label);
  act(() => vi.advanceTimersByTime(499));
  expect(queryByRole('button', { name: 'canvas.story.disconnect' })).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  const scissors = getByRole('button', { name: 'canvas.story.disconnect' });
  fireEvent.pointerLeave(label);
  // 从曲线移向旁边的剪刀，正常移动可能超过旧版 160ms 宽限。
  act(() => vi.advanceTimersByTime(500));
  expect(scissors).toBeInTheDocument();
  fireEvent.pointerEnter(scissors);
  act(() => vi.advanceTimersByTime(1000));
  expect(scissors).toBeInTheDocument();
  fireEvent.click(scissors);
  expect(useCanvasStore.getState().edges.map((edge) => edge.id)).toEqual(['choice-b']);
  expect(useCanvasStore.getState().nodes).toHaveLength(2);
  act(() => useCanvasStore.getState().undo());
  expect(useCanvasStore.getState().edges).toHaveLength(2);
});

it('短暂经过标签不会显示剪刀', () => {
  const { getByRole, queryByRole } = render(<StoryChoiceEdge {...props} />);
  const label = getByRole('button', { name: 'canvas.story.choiceEditorTitle' });
  fireEvent.pointerEnter(label);
  act(() => vi.advanceTimersByTime(200));
  fireEvent.pointerLeave(label);
  act(() => vi.advanceTimersByTime(600));
  expect(queryByRole('button', { name: 'canvas.story.disconnect' })).toBeNull();
});
