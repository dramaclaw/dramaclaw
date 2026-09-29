// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureNodePreview, NodePreviewHandoff, type NodePreviewSnapshot } from '@/features/canvas/ui/NodePreviewHandoff';
import { setCanvasGestureActive, updateLowDetailFromZoom } from '@/features/canvas/application/canvasLod';
import { withLodShell } from '@/features/canvas/nodes/LodShellNode';

vi.mock('@xyflow/react', () => ({
  Handle: () => <span className="react-flow__handle" />,
  Position: { Left: 'left', Right: 'right' },
  useStore: (selector: (s: { transform: number[] }) => unknown) => selector({ transform: [0, 0, 0.2] }),
}));
vi.mock('@/stores/canvasStore', () => ({ useCanvasStore: (selector: (s: { selectedNodeId: null }) => unknown) => selector({ selectedNodeId: null }) }));
vi.mock('@/features/canvas/ui/ReferencePickNodeOverlay', () => ({ ReferencePickNodeOverlay: () => null }));
vi.mock('@/features/canvas/ui/AssetMigrationNodeOverlay', () => ({ AssetMigrationNodeOverlay: () => null }));
vi.mock('@/features/canvas/ui/ForeignMediaNodeOverlay', () => ({ ForeignMediaNodeOverlay: () => null }));
vi.mock('@/features/canvas/ui/RemoteMediaBadge', () => ({ RemoteMediaBadge: () => null }));

const snapshot: NodePreviewSnapshot = { src: '/old.png', width: 580, height: 360, objectFit: 'contain', identity: 'same' };
function loaded(image: HTMLImageElement) {
  Object.defineProperties(image, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 320 } });
}
beforeEach(() => { vi.useFakeTimers(); setCanvasGestureActive(false); });
afterEach(() => { cleanup(); updateLowDetailFromZoom(1); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('preview handoff', () => {
  it('exits when the current image had already failed before the cover mounted', () => {
    const onDone = vi.fn();
    const view = render(<div><img data-canvas-preview src="/failed.png" alt="" /></div>);
    Object.defineProperties(view.container.querySelector('img')!, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 0 } });
    view.rerender(<div><img data-canvas-preview src="/failed.png" alt="" /><NodePreviewHandoff snapshot={snapshot} onDone={onDone} /></div>);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('retains a valid slow target beyond five seconds, including a slow decode', async () => {
    const onDone = vi.fn(); let done!: () => void;
    const view = render(<div><img data-canvas-preview src="/slow.png" alt="" /><NodePreviewHandoff snapshot={snapshot} onDone={onDone} /></div>);
    act(() => vi.advanceTimersByTime(6000)); expect(onDone).not.toHaveBeenCalled();
    const full = view.container.querySelector<HTMLImageElement>('img[data-canvas-preview]')!;
    loaded(full); full.decode = () => new Promise(resolve => { done = resolve; }); fireEvent.load(full);
    act(() => vi.advanceTimersByTime(6000)); expect(onDone).not.toHaveBeenCalled();
    await act(async () => { done(); await Promise.resolve(); });
    act(() => vi.advanceTimersByTime(600)); expect(onDone).toHaveBeenCalledOnce();
  });

  it('exits a current decode rejection without a successful fade', async () => {
    const onDone = vi.fn();
    const view = render(<div><img data-canvas-preview src="/bad.png" alt="" /><NodePreviewHandoff snapshot={snapshot} onDone={onDone} /></div>);
    const full = view.container.querySelector<HTMLImageElement>('img[data-canvas-preview]')!;
    loaded(full); full.decode = () => Promise.reject(new Error('decode'));
    await act(async () => { fireEvent.load(full); await Promise.resolve(); });
    act(() => vi.advanceTimersByTime(6000));
    expect(onDone).toHaveBeenCalledOnce(); expect(view.container.querySelector('.dc-node-preview-handoff--fading')).toBeNull();
  });

  it('ignores an obsolete decode rejection and cancels a fade on sizes changes', async () => {
    const onDone = vi.fn(); let reject!: (error: Error) => void;
    const view = render(<div><img data-canvas-preview src="/first.png" alt="" /><NodePreviewHandoff snapshot={snapshot} onDone={onDone} /></div>);
    const full = view.container.querySelector<HTMLImageElement>('img[data-canvas-preview]')!;
    loaded(full); full.decode = () => new Promise((_, fail) => { reject = fail; }); fireEvent.load(full);
    await act(async () => { full.src = '/next.png'; full.decode = () => Promise.resolve(); await Promise.resolve(); });
    await act(async () => { reject(new Error('old')); await Promise.resolve(); });
    act(() => vi.advanceTimersByTime(40)); expect(onDone).not.toHaveBeenCalled();
    expect(view.container.querySelector('.dc-node-preview-handoff--fading')).not.toBeNull();
    await act(async () => { Object.defineProperty(full, 'complete', { configurable: true, value: false }); full.sizes = '400px'; await Promise.resolve(); });
    expect(view.container.querySelector('.dc-node-preview-handoff--fading')).toBeNull();
    act(() => vi.advanceTimersByTime(6000)); expect(onDone).not.toHaveBeenCalled();
  });

  it('captures only an already loaded shell image and its existing dimensions', () => {
    const { container } = render(<div style={{ width: 580, height: 360 }}><img src="/old.png" alt="" style={{ objectFit: 'contain' }} /></div>);
    const shell = container.firstElementChild as HTMLDivElement;
    expect(captureNodePreview(shell, 'same')).toBeNull();
    loaded(shell.querySelector('img')!);
    expect(captureNodePreview(shell, 'same')).toMatchObject({ width: 580, height: 360, objectFit: 'contain', identity: 'same' });
  });

  it('keeps the cover through loading and decoding, then fades without extra handles', async () => {
    let resolveDecode!: () => void;
    const onDone = vi.fn();
    const { container } = render(<div><img data-canvas-preview src="/full.png" alt="" /><NodePreviewHandoff snapshot={snapshot} onDone={onDone} /></div>);
    const full = container.querySelector('img[data-canvas-preview]') as HTMLImageElement;
    full.decode = vi.fn(() => new Promise<void>(resolve => { resolveDecode = resolve; }));
    loaded(full);
    fireEvent.load(full);
    act(() => vi.advanceTimersByTime(100));
    expect(container.querySelector('.dc-node-preview-handoff--fading')).toBeNull();
    await act(async () => { resolveDecode(); await Promise.resolve(); });
    act(() => vi.advanceTimersByTime(40));
    expect(container.querySelector('.dc-node-preview-handoff--fading')).not.toBeNull();
    expect(container.querySelectorAll('.react-flow__handle')).toHaveLength(0);
    fireEvent.transitionEnd(container.querySelector('.dc-node-preview-handoff')!, { propertyName: 'opacity' });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('exits on an image error and bounds waits for a missing preview', () => {
    const onDone = vi.fn();
    const view = render(<div><img data-canvas-preview src="/bad.png" alt="" /><NodePreviewHandoff snapshot={snapshot} onDone={onDone} /></div>);
    fireEvent.error(view.container.querySelector('img[data-canvas-preview]')!);
    expect(onDone).toHaveBeenCalledOnce();
    view.unmount();
    const timeoutDone = vi.fn();
    render(<div><NodePreviewHandoff snapshot={snapshot} onDone={timeoutDone} /></div>);
    act(() => vi.advanceTimersByTime(5000));
    expect(timeoutDone).toHaveBeenCalledOnce();
  });

  it('does not fade for a preview replaced between decode and paint', async () => {
    const onDone = vi.fn();
    const view = render(<div><img data-canvas-preview src="/full.png" alt="" /><NodePreviewHandoff snapshot={snapshot} onDone={onDone} /></div>);
    const full = view.container.querySelector('img[data-canvas-preview]') as HTMLImageElement;
    loaded(full);
    full.decode = () => Promise.resolve();
    await act(async () => { fireEvent.load(full); await Promise.resolve(); });
    Object.defineProperty(full, 'complete', { configurable: true, value: false });
    full.src = '/next-variant.png';
    act(() => vi.advanceTimersByTime(40));
    expect(view.container.querySelector('.dc-node-preview-handoff--fading')).toBeNull();
    loaded(full);
    await act(async () => { fireEvent.load(full); await Promise.resolve(); });
    act(() => vi.advanceTimersByTime(40));
    expect(view.container.querySelector('.dc-node-preview-handoff--fading')).not.toBeNull();
  });

  it('respects reduced motion after the preview loads', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const onDone = vi.fn();
    const { container } = render(<div><img data-canvas-preview src="/full.png" alt="" /><NodePreviewHandoff snapshot={snapshot} onDone={onDone} /></div>);
    const full = container.querySelector('img[data-canvas-preview]') as HTMLImageElement;
    loaded(full);
    fireEvent.load(full);
    expect(onDone).toHaveBeenCalledOnce();
    expect(container.querySelector('.dc-node-preview-handoff--fading')).toBeNull();
  });

  it('cleans up a pending decode after unmount', async () => {
    let resolveDecode!: () => void;
    const onDone = vi.fn();
    const view = render(<div><img data-canvas-preview src="/full.png" alt="" /><NodePreviewHandoff snapshot={snapshot} onDone={onDone} /></div>);
    const full = view.container.querySelector('img[data-canvas-preview]') as HTMLImageElement;
    full.decode = () => new Promise<void>(resolve => { resolveDecode = resolve; });
    loaded(full); fireEvent.load(full); view.unmount();
    await act(async () => { resolveDecode(); await Promise.resolve(); vi.advanceTimersByTime(6000); });
    expect(onDone).not.toHaveBeenCalled();
  });

  it('removes the cover as soon as a requested video has a decoded frame', () => {
    const onDone = vi.fn();
    const { container } = render(<div><video data-canvas-preview /><NodePreviewHandoff snapshot={snapshot} onDone={onDone} /></div>);
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'readyState', { value: 2 });
    fireEvent.loadedData(video);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('covers a shell upgrade, cancels immediately on source replacement and preserves handles', () => {
    const Full = ({ data }: { data: { imageUrl: string } }) => <div><span className="react-flow__handle" /><span className="react-flow__handle" /><img data-canvas-preview src={data.imageUrl} alt="" /></div>;
    const Wrapped = withLodShell('imageGenNode', Full);
    const props = { id: 'node', type: 'imageGenNode', data: { imageUrl: '/old.png' }, width: 580, height: 360, dragging: false, draggable: true, selected: false, selectable: true, deletable: true, zIndex: 0, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0 };
    updateLowDetailFromZoom(0.2);
    const view = render(<Wrapped {...props} />);
    loaded(view.container.querySelector<HTMLImageElement>('.dc-lod-shell img')!);
    act(() => updateLowDetailFromZoom(0.5));
    act(() => vi.advanceTimersByTime(20));
    expect(view.container.querySelector('.dc-node-preview-handoff')).not.toBeNull();
    expect(view.container.querySelectorAll('.react-flow__handle')).toHaveLength(2);
    view.rerender(<Wrapped {...props} data={{ imageUrl: '/new.png' }} />);
    expect(view.container.querySelector('.dc-node-preview-handoff')).toBeNull();
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('/new.png');
  });

  it('cancels on downgrade and does not cover generation progress with an old preview', () => {
    const Full = () => <div data-full-node />;
    const Wrapped = withLodShell('imageGenNode', Full);
    const props = { id: 'node', type: 'imageGenNode', data: { imageUrl: '/old.png', isGenerating: false }, width: 580, height: 360, dragging: false, draggable: true, selected: false, selectable: true, deletable: true, zIndex: 0, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0 };
    updateLowDetailFromZoom(0.2);
    const view = render(<Wrapped {...props} />);
    loaded(view.container.querySelector<HTMLImageElement>('.dc-lod-shell img')!);
    act(() => updateLowDetailFromZoom(0.5));
    act(() => vi.advanceTimersByTime(20));
    expect(view.container.querySelector('.dc-node-preview-handoff')).not.toBeNull();
    act(() => updateLowDetailFromZoom(0.2));
    expect(view.container.querySelector('.dc-node-preview-handoff')).toBeNull();
    expect(view.container.querySelector('.dc-lod-shell')).not.toBeNull();
    view.rerender(<Wrapped {...props} data={{ ...props.data, isGenerating: true }} />);
    loaded(view.container.querySelector<HTMLImageElement>('.dc-lod-shell img')!);
    act(() => updateLowDetailFromZoom(0.5));
    act(() => vi.advanceTimersByTime(20));
    expect(view.container.querySelector('[data-full-node]')).not.toBeNull();
    expect(view.container.querySelector('.dc-node-preview-handoff')).toBeNull();
  });

  it('uses a bounded static poster for oversized legacy video shells', () => {
    const Wrapped = withLodShell('liblibMediaNode', () => <div />);
    updateLowDetailFromZoom(0.2);
    const view = render(<Wrapped id="legacy-video" type="liblibMediaNode" data={{ mediaKind: 'video', videoUrl: '/clip.mp4', posterUrl: '/static/projects/p/images/poster.jpg' }} width={20000} height={10000} dragging={false} draggable selected={false} selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />);
    expect(view.container.querySelector('video')).toBeNull();
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('/static/projects/p/images/poster.jpg?st_thumb=card');
    expect(view.container.querySelector('img')?.getAttribute('decoding')).toBe('async');
  });

  it('uses the current edited image in shells and invalidates a same-address new version', () => {
    const Wrapped = withLodShell('imageGenNode', () => <img data-canvas-preview src="/edited.png" alt="" />);
    const props = { id: 'edited', type: 'imageGenNode', data: { imageUrl: '/original.png', previewImageUrl: '/edited.png', committed_at: 'v1' }, width: 580, height: 360, dragging: false, draggable: true, selected: false, selectable: true, deletable: true, zIndex: 0, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0 };
    updateLowDetailFromZoom(0.2);
    const view = render(<Wrapped {...props} />);
    const image = view.container.querySelector<HTMLImageElement>('.dc-lod-shell img')!;
    expect(image.getAttribute('src')).toBe('/edited.png'); loaded(image);
    act(() => updateLowDetailFromZoom(0.5)); act(() => vi.advanceTimersByTime(20));
    expect(view.container.querySelector('.dc-node-preview-handoff')).not.toBeNull();
    view.rerender(<Wrapped {...props} data={{ ...props.data, committed_at: 'v2' }} />);
    expect(view.container.querySelector('.dc-node-preview-handoff')).toBeNull();
  });
});
