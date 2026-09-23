import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Editor from './PikoNavigationEditor';
import type { PikoNavigation, PikoOcclusion } from './runtime/map-package-schema';

beforeEach(() => vi.stubGlobal('PointerEvent', MouseEvent));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(occlusion?: PikoOcclusion) {
  const navigation: PikoNavigation = { schemaVersion: 1, mapId: 'welcome-courtyard',
    walkableAreas: [{ id: 'ground', points: [{ x: 0, y: 0 }, { x: 2048, y: 0 }, { x: 2048, y: 1152 }, { x: 0, y: 1152 }] }],
    colliders: [], spawnPoints: [], exits: [] };
  const onApply = vi.fn(), onEditing = vi.fn(), onOcclusionApply = vi.fn();
  const view = render(<Editor navigation={navigation} occlusion={occlusion} fit={{ x: 0, y: 0, scale: 1 }}
    player={{ x: 500, y: 500 }} onApply={onApply} onEditing={onEditing} onPlay={vi.fn()} onOcclusionApply={onOcclusionApply} />);
  fireEvent.click(screen.getByText('场景调试'));
  const svg = screen.getByLabelText('地图区域编辑层');
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 2048, height: 1152, right: 2048, bottom: 1152, x: 0, y: 0, toJSON() {} });
  Object.defineProperty(svg, 'setPointerCapture', { value: vi.fn() });
  const draw = (points = [[100, 100], [200, 100], [200, 200]]) => {
    for (const [clientX, clientY] of points) fireEvent.pointerDown(svg, { clientX, clientY, button: 0 });
    fireEvent.keyDown(window, { key: 'Enter' });
  };
  const showPanel = () => fireEvent.click(screen.getByLabelText('显示调试工具'));
  return { ...view, navigation, onApply, onEditing, onOcclusionApply, svg, draw, showPanel };
}

it('previews a draft, restores the original on exit, and reopens the tools', () => {
  const { draw, showPanel, onApply, onEditing, navigation, unmount } = setup();
  fireEvent.click(screen.getByText('开始画区域')); draw();
  expect(onApply.mock.lastCall?.[0].colliders).toHaveLength(1);
  expect(navigation.colliders).toHaveLength(0);
  showPanel(); fireEvent.click(screen.getByText('退出调试'));
  expect(onApply).toHaveBeenLastCalledWith(navigation);
  fireEvent.click(screen.getByText('场景调试'));
  expect(screen.getByRole('button', { name: '开始画区域' })).toBeVisible();
  unmount(); expect(onEditing).toHaveBeenLastCalledWith(false);
});

it('deletes a selected region after releasing the pointer', () => {
  const { draw, svg, onApply } = setup();
  fireEvent.click(screen.getByText('开始画区域')); draw();
  const polygon = svg.querySelector('polygon')!;
  expect(polygon).not.toBeNull();
  fireEvent.pointerDown(polygon, { clientX: 150, clientY: 120, button: 0 });
  fireEvent.pointerUp(svg);
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ colliders: [] }));
});

it('resumes drawing after walking and releases movement again on exit', () => {
  const { onEditing, draw, onApply } = setup();
  fireEvent.click(screen.getByText('试走')); expect(onEditing).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByText('开始画区域')); expect(onEditing).toHaveBeenLastCalledWith(true);
  draw(); expect(onApply.mock.lastCall?.[0].colliders).toHaveLength(1);
});

it('retains existing occluders and uses world position rather than atlas coordinates for selection', () => {
  const occlusion: PikoOcclusion = { schemaVersion: 1, mapId: 'welcome-courtyard', occluders: [{ id: 'tree', src: 'base.png', position: { x: 300, y: 300 }, depthY: 400,
    frame: { x: 0, y: 0, width: 100, height: 100 }, outline: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] }] };
  const { svg, onOcclusionApply } = setup(occlusion);
  fireEvent.click(screen.getByText('遮挡层'));
  expect(svg.querySelector('polygon')).toHaveAttribute('points', '300,300 400,300 400,400');
  fireEvent.click(svg, { clientX: 370, clientY: 320 });
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(onOcclusionApply).toHaveBeenLastCalledWith({ ...occlusion, occluders: [] });
  fireEvent.click(screen.getByText('退出调试'));
  expect(onOcclusionApply).toHaveBeenLastCalledWith(occlusion);
});

it('rejects self-intersecting occlusion and reveals the error while retaining the editable path', () => {
  const { draw, onOcclusionApply } = setup();
  fireEvent.click(screen.getByText('遮挡层'));
  fireEvent.click(screen.getByText('开始画遮挡区'));
  draw([[100, 100], [250, 200], [100, 250], [200, 100]]);
  expect(onOcclusionApply).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toBeVisible();
  fireEvent.keyDown(window, { key: 'Backspace' });
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(onOcclusionApply.mock.lastCall?.[0].occluders).toHaveLength(1);
});

it('exports the draft without applying additional changes', () => {
  const { onApply } = setup();
  const createObjectURL = vi.fn(() => 'blob:test');
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByText('导出 JSON'));
  expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  expect(click).toHaveBeenCalledOnce();
  expect(click.mock.instances[0]).toHaveAttribute('download', 'welcome-courtyard-navigation.json');
  expect(onApply).not.toHaveBeenCalled();
});
