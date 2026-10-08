// SPDX-License-Identifier: Elastic-2.0
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoryboardView, StoryboardModeSwitch } from '@/features/storyboard/StoryboardView';
import { useStoryboardMetadata, useStoryboardView } from '@/features/storyboard/storyboardStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { useReferencePickStore } from '@/features/canvas/application/referencePickStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { OperationPanelShell } from '@/features/canvas/ui/OperationPanelShell';
import { NodeGenerationHistory } from '@/features/canvas/ui/NodeGenerationHistory';
import type { FreezoneGenerationHistoryRecord } from '@/api/ops';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@xyflow/react', async importOriginal => ({ ...await importOriginal<typeof import('@xyflow/react')>(), useNodeId: () => 'a' }));
const fixture = (): CanvasNode[] => [
  { id: 'a', type: 'textAnnotationNode', position: { x: 10, y: 20 }, data: { displayName: 'Text A', content: '**Original text**', mode: 'writing' } },
  { id: 'b', type: 'textAnnotationNode', position: { x: 600, y: 20 }, data: { displayName: 'Text B', content: 'Second text', mode: 'writing' } },
  { id: 'image', type: 'imageGenNode', position: { x: 900, y: 20 }, data: { displayName: 'Image A', imageUrl: '/asset.png', aspectRatio: '16:9' } },
] as CanvasNode[];
const geometry = () => useCanvasStore.getState().nodes.map(({ id, position, parentId, width, height }) => ({ id, position, parentId, width, height }));
function Harness() {
  const mode = useStoryboardView(s => s.mode);
  return <><StoryboardModeSwitch scope="p::c" disabled={false} />{mode === 'storyboard' && <StoryboardView scope="p::c" />}</>;
}
beforeEach(() => {
  localStorage.clear();
  useCanvasStore.setState({ nodes: fixture(), edges: [], selectedNodeId: null });
  useStoryboardView.getState().leaveScope();
  useStoryboardView.getState().enterScope('p::c');
  useStoryboardView.getState().setMode('storyboard');
  useStoryboardMetadata.getState().hydrate('p::c', null);
});
afterEach(() => { cleanup(); useStoryboardView.getState().leaveScope(); });

describe('storyboard interactions', () => {
  it('switches modes twenty times without moving nodes or creating edges', () => {
    render(<Harness />);
    const before = geometry();
    for (let i = 0; i < 10; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'storyboard.workflow' }));
      expect(screen.queryByTestId('storyboard-view')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'storyboard.storyboard' }));
      expect(screen.getByTestId('storyboard-view')).toBeInTheDocument();
    }
    expect(geometry()).toEqual(before);
    expect(useCanvasStore.getState().edges).toEqual([]);
    expect(useStoryboardMetadata.getState().revision).toBe(0);
  });
  it('opens full text and edits the original node', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Text A' }));
    expect(screen.getByText('Original text')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'storyboard.editText' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'storyboard.editText' }), { target: { value: 'Changed text' } });
    fireEvent.click(screen.getByRole('button', { name: 'storyboard.saveText' }));
    expect(useCanvasStore.getState().nodes.find(n => n.id === 'a')!.data.content).toBe('Changed text');
    expect(screen.getByText('Changed text')).toBeInTheDocument();
  });
  it('adds and detaches a text reference through shared edges', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Text A' }));
    fireEvent.click(screen.getByRole('button', { name: 'storyboard.addReference' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Text B' }).slice(-1)[0]!);
    expect(useCanvasStore.getState().edges).toEqual([expect.objectContaining({ source: 'b', target: 'a' })]);
    fireEvent.click(screen.getByRole('button', { name: 'storyboard.detach: Text B' }));
    expect(useCanvasStore.getState().edges).toEqual([]);
  });
  it('saves column ordering separately from workflow geometry', () => {
    render(<Harness />);
    const before = geometry();
    fireEvent.keyDown(screen.getByRole('button', { name: 'storyboard.reorder: Text B' }), { key: 'ArrowUp' });
    expect(useStoryboardMetadata.getState().metadata.order.text).toEqual(['b', 'a']);
    expect(geometry()).toEqual(before);
  });
  it('routes the existing parameter panel reference picker into the board', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Image A' }));
    act(() => useReferencePickStore.getState().start({ targetNodeId: 'image', targetNodeType: 'imageGenNode', originViewport: null, candidates: new Map(), rejections: new Map() }));
    expect(screen.getByRole('textbox', { name: 'storyboard.searchReference' })).toBeInTheDocument();
    expect(useReferencePickStore.getState().request).toBeNull();
  });
  it('portals the existing editor to detail while preserving a single callback', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Text A' }));
    const submit = vi.fn();
    render(<OperationPanelShell expanded={false} onCollapse={() => {}} inlineClassName="inline-original" inlineStyle={{}}><button onClick={submit}>Existing generate action</button></OperationPanelShell>);
    const host = screen.getByTestId('storyboard-editor-host');
    fireEvent.click(within(host).getByRole('button', { name: 'Existing generate action' }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: 'Existing generate action' })).toHaveLength(1);
  });
  it('portals original history and retains its restore callback', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Text A' }));
    const restore = vi.fn();
    const record = { id: 'history-1', status: 'completed', recorded_at: new Date().toISOString(), media_type: 'image', result: { image_url: '/history.png' } } as unknown as FreezoneGenerationHistoryRecord;
    render(<NodeGenerationHistory records={[record]} onRestore={restore} />);
    const host = useStoryboardView.getState().historyHost!;
    fireEvent.click(within(host).getByRole('button'));
    expect(restore).toHaveBeenCalledWith(record);
  });
});
