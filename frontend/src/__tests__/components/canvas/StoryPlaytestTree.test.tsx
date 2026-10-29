import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { StoryPlaytestTree } from '@/components/canvas/StoryPlaytestTree';
import { useCanvasStore } from '@/stores/canvasStore';
import { type CanvasNode, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className, horizontal }: { children: React.ReactNode; className?: string; horizontal?: boolean }) => (
    <div className={className} data-horizontal={horizontal ? 'true' : 'false'}>
      <div data-slot="scroll-area-viewport">{children}</div>
    </div>
  ),
}));

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  useCanvasStore.setState({
    nodes: ['a', 'b', 'orphan'].map((id) => ({
      id, type: 'videoNode', parentId: 'g', position: { x: 0, y: 0 },
      data: { displayName: id, ...(id === 'a' ? { storyRole: 'start' } : {}) },
    })) as CanvasNode[],
    edges: ['one', 'two'].map((id, order) => ({
      id, source: 'a', target: 'b', type: 'storyChoiceEdge', data: { choiceText: 'same', order },
    })) as CanvasEdge[],
  });
});
afterEach(cleanup);

it('点击同节点的另一入口只选中该行，改文案保持选择，删除入口安全回退', () => {
  const onSelect = vi.fn();
  const view = render(<StoryPlaytestTree groupId="g" selectedNodeId="b" onSelectNode={onSelect} onAddNode={vi.fn()} />);
  const selected = () => view.container.querySelectorAll('[aria-current="true"]');
  const second = () => view.container.querySelector('[data-story-row-id="edge:two"] button')!;
  const viewport = view.container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  const secondRow = view.container.querySelector<HTMLElement>('[data-story-row-id="edge:two"]')!;
  viewport.scrollLeft = 24;
  viewport.getBoundingClientRect = vi.fn(() => ({ top: 0, bottom: 100 } as DOMRect));
  secondRow.getBoundingClientRect = vi.fn(() => ({ top: 130, bottom: 150 } as DOMRect));
  expect(selected()).toHaveLength(1);
  fireEvent.click(second());
  expect(onSelect).toHaveBeenCalledWith('b');
  expect(selected()).toHaveLength(1);
  expect(selected()[0]).toBe(second());
  expect(viewport.scrollTop).toBe(50);
  expect(viewport.scrollLeft).toBe(24);
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(view.container.querySelector('[data-horizontal]')).toHaveAttribute('data-horizontal', 'false');
  expect(view.container.querySelector('[data-slot="scroll-area-viewport"] > div')).toHaveClass('w-max', 'min-w-full');
  expect(view.container.querySelector('[data-horizontal]')?.className).toContain('overflow-x-auto');
  act(() => useCanvasStore.setState({ edges: useCanvasStore.getState().edges.map((e) => ({ ...e, data: { ...e.data, choiceText: 'renamed' } })) }));
  expect(selected()[0]).toBe(second());
  act(() => useCanvasStore.setState({ edges: useCanvasStore.getState().edges.filter((e) => e.id !== 'two') }));
  expect(selected()).toHaveLength(1);
  expect(selected()[0].closest('[data-story-row-id]')?.getAttribute('data-story-row-id')).toBe('edge:one');
});

it('保留横向手势与 Shift 滚轮，点击节点时不自动横移', () => {
  const view = render(<StoryPlaytestTree groupId="g" selectedNodeId="a" onSelectNode={vi.fn()} onAddNode={vi.fn()} />);
  const viewport = view.container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  expect(view.container.querySelector('[data-horizontal]')).toHaveAttribute('data-horizontal', 'false');
  fireEvent.wheel(viewport, { deltaY: 60, shiftKey: true });
  expect(viewport.scrollLeft).toBe(60);
  fireEvent.wheel(viewport, { deltaY: 40 });
  expect(viewport.scrollLeft).toBe(60);
});

it('跨节点点击与孤立节点也只保留一个选中入口', () => {
  function Harness() {
    const [node, setNode] = useState('a');
    return <StoryPlaytestTree groupId="g" selectedNodeId={node} onSelectNode={setNode} onAddNode={vi.fn()} />;
  }
  const view = render(<Harness />);
  fireEvent.click(view.container.querySelector('[data-story-row-id="edge:two"] button')!);
  expect(view.container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  expect(view.container.querySelector('[data-story-row-id="edge:two"] [aria-current="true"]')).not.toBeNull();
  fireEvent.click(view.container.querySelector('[data-story-row-id="orphan:orphan"]')!);
  expect(view.container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  expect(view.container.querySelector('[data-story-row-id="orphan:orphan"]')?.getAttribute('aria-current')).toBe('true');
});
