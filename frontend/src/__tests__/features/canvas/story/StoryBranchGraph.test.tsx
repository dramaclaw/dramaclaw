import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { StoryBranchGraph } from '@/features/canvas/story/StoryBranchGraph';
import { layoutExplorationGraph } from '@/features/canvas/story/layoutExplorationGraph';
import { emptyExploration, type ExplorationNode } from '@/features/canvas/story/storyExploration';

const nodes: ExplorationNode[] = [
  { id: 'a', label: '开场', successors: ['b', 'c'], choices: [{ target: 'b', text: '走左边' }, { target: 'c', text: '走右边' }], isEnding: false },
  { id: 'b', label: '已看的分支', successors: ['d'], isEnding: false },
  { id: 'c', label: '未发现的秘密', successors: ['d'], isEnding: false },
  { id: 'd', label: '隐藏结局', successors: ['a'], isEnding: true },
];
const t = (key: string, values?: Record<string, unknown>) => i18next.t(key, values ?? {}) as string;
function draw(selected: string | null = null) {
  const onSelect = vi.fn();
  const onClear = vi.fn();
  const onRewind = vi.fn();
  const exploration = { ...emptyExploration(), completedNodeIds: ['a', 'b'],
    route: [{ nodeId: 'a', visit: 1 }, { nodeId: 'b', visit: 2 }],
    checkpoints: { a: { inkState: '', route: [{ nodeId: 'a', visit: 1 }], completed: true } } };
  return { onSelect, onClear, onRewind, ...render(<StoryBranchGraph nodes={nodes} exploration={exploration}
    currentNodeId="b" selected={selected} onSelect={onSelect} onClear={onClear} onRewind={onRewind} t={t} />) };
}

describe('read-only desktop branch map', () => {
  it('lays out merges once and includes backward and self-loop edges without infinite traversal', () => {
    const layout = layoutExplorationGraph([...nodes, { id: 'self', label: '', successors: ['self', 'missing', 'self'], isEnding: false }]);
    expect(layout.positions.size).toBe(5);
    expect(layout.positions.get('d')!.x).toBeGreaterThan(layout.positions.get('b')!.x);
    expect(layout.positions.get('b')!.y).not.toBe(layout.positions.get('c')!.y);
    expect(layout.edges).toHaveLength(6);
    expect(layout.edges.find((edge) => edge.source === 'self')!.path).not.toContain('NaN');
    expect(layout.edges.some((edge) => edge.target === 'missing')).toBe(false);
    expect(layout.width).toBeGreaterThan(0);
  });

  it('shows explicit node states and locked titles, labels choices, and highlights actual traversed connections', () => {
    const { container, onSelect } = draw();
    for (const title of ['未发现的秘密', '隐藏结局']) {
      const node = screen.getByRole('button', { name: new RegExp(title) });
      expect(node).toBeDisabled();
      expect(node).toHaveTextContent(title);
      expect(node.querySelector('.lucide-lock-keyhole')).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /隐藏结局/ })).toHaveTextContent('结局');
    expect(screen.getByRole('button', { name: /未发现的秘密/ })).toHaveTextContent('未探索');
    expect(screen.getByRole('button', { name: /已看的分支/ }).querySelector('.lucide-circle-play')).toBeInTheDocument();
    expect(screen.getByText('走左边')).toHaveClass('story-graph-choice');
    expect(screen.getByText('走右边')).toHaveClass('story-graph-choice');
    fireEvent.click(screen.getByRole('button', { name: /已看的分支/ }));
    expect(onSelect).toHaveBeenCalledWith('b');
    const active = container.querySelectorAll('[data-story-graph-edge][data-route="true"]');
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveAttribute('data-story-graph-edge', JSON.stringify(['a', 'b']));
  });

  it('places replay on the selected node and disables unavailable checkpoints', () => {
    const view = draw('a');
    const replay = screen.getByRole('button', { name: '重玩' });
    expect(replay.closest('.story-graph-node')).toHaveTextContent('开场');
    fireEvent.click(replay);
    expect(view.onRewind).toHaveBeenCalledWith('a');
    expect(screen.queryByRole('button', { name: '回看片段' })).not.toBeInTheDocument();
    view.unmount();
    draw('b');
    expect(screen.getByRole('button', { name: '重玩' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '回看片段' })).not.toBeInTheDocument();
  });

  it('supports zoom, fit and current-node location without changing story state', () => {
    const { container, onSelect } = draw();
    const viewport = screen.getByRole('region', { name: '剧情地图' });
    Object.defineProperties(viewport, { clientWidth: { value: 600 }, clientHeight: { value: 300 } });
    fireEvent.click(screen.getByRole('button', { name: '放大剧情地图' }));
    expect(screen.getByLabelText('地图缩放比例')).toHaveTextContent('125%');
    fireEvent.click(screen.getByRole('button', { name: '缩小剧情地图' }));
    expect(screen.getByLabelText('地图缩放比例')).toHaveTextContent('100%');
    fireEvent.click(screen.getByRole('button', { name: '显示全图' }));
    expect(Number.parseFloat((container.querySelector('.story-graph-world') as HTMLElement).style.width)).toBeLessThanOrEqual(600);
    fireEvent.click(screen.getByRole('button', { name: '定位当前片段' }));
    expect(viewport.scrollLeft).toBeGreaterThanOrEqual(0);
    expect(screen.getByLabelText('地图缩放比例')).toHaveTextContent('100%');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
