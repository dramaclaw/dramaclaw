// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CanvasPanDiagnostics from '@/features/canvas/ui/CanvasPanDiagnostics';
const mock = vi.hoisted(() => ({ zoom: .2, activate: vi.fn(), restore: vi.fn(), valid: vi.fn(() => true), prepare: vi.fn(), manual: vi.fn(), stopManual: vi.fn(), viewport: vi.fn(async () => {}) }));
vi.mock('@xyflow/react', () => ({ useReactFlow: () => ({ getViewport: () => ({ x: 0, y: 0, zoom: mock.zoom }), setViewport: mock.viewport }) }));
vi.mock('@/features/canvas/application/canvasEdgePaintProbe', () => ({ prepareSingleSvgProbe: mock.prepare, startManualSingleSvgProbe: mock.manual }));
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mock.zoom = .2;
  mock.valid.mockReturnValue(true);
  mock.prepare.mockReturnValue({ activate: mock.activate, restore: mock.restore, valid: mock.valid, stats: {} });
  mock.manual.mockReturnValue(mock.stopManual);
  vi.stubGlobal('PerformanceObserver', class { static supportedEntryTypes: string[] = []; observe() {} disconnect() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function mount(automatic = true) {
  const root = document.createElement('div'); root.innerHTML = '<div class="react-flow__viewport"/>'; document.body.append(root);
  const gesture = vi.fn();
  const view = render(<CanvasPanDiagnostics rootRef={{ current: root }} profile={{ current: { active: false, commits: 0, renderMs: 0 } }} onGestureChange={gesture} />);
  if (automatic) view.container.querySelector('details')!.open = true;
  return { ...view, gesture };
}
it('restores the prepared layer and gesture after a normal record', async () => {
  const view = mount(); fireEvent.click(view.getByRole('button', { name: /^single-svg$/ }));
  await act(async () => vi.advanceTimersByTimeAsync(5100));
  expect(mock.activate).toHaveBeenCalledOnce(); expect(mock.restore).toHaveBeenCalledOnce();
  expect(view.gesture).toHaveBeenLastCalledWith(false);
  expect(view.getByTestId('canvas-pan-results').textContent).toContain('"invalidReason": null');
});

it('lets the user drag indefinitely without a camera reset and restores on Normal', async () => {
  const view = mount(false);
  expect(view.container.querySelector('details')!.open).toBe(false);
  fireEvent.click(view.getByRole('button', { name: 'Single SVG · manual' }));
  expect(mock.manual).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(mock.stopManual).not.toHaveBeenCalled(); expect(mock.viewport).not.toHaveBeenCalled();
  expect(view.gesture).not.toHaveBeenCalled();
  expect(view.getByRole('button', { name: 'Single SVG · manual' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(view.getByRole('button', { name: 'Normal · manual' }));
  expect(mock.stopManual).toHaveBeenCalledOnce(); expect(mock.viewport).not.toHaveBeenCalled();
});

it('isolates manual mode from cache, group and automatic experiments and cleans up on unmount', () => {
  const view = mount();
  fireEvent.change(view.getByRole('combobox', { name: 'Viewport cache' }), { target: { value: 'edge-svg' } });
  fireEvent.change(view.getByRole('combobox', { name: 'Group paint' }), { target: { value: 'no-fill' } });
  fireEvent.click(view.getByRole('button', { name: 'Single SVG · manual' }));
  expect(view.getByTestId('canvas-viewport-cache-probe').textContent).toBe('');
  expect((view.getByRole('combobox', { name: 'Group paint' }) as HTMLSelectElement).value).toBe('normal');
  expect(view.getByRole('button', { name: /^normal$/ })).toBeDisabled();
  expect(view.getByRole('combobox', { name: 'Viewport cache' })).toBeDisabled();
  view.unmount(); expect(mock.stopManual).toHaveBeenCalledOnce();
});

it('shows a failure and returns to Normal instead of leaving a stale manual mode', () => {
  mock.manual.mockImplementationOnce(() => { throw new Error('Select the hand tool (H) first'); });
  const view = mount(false); fireEvent.click(view.getByRole('button', { name: 'Single SVG · manual' }));
  expect(view.getByTestId('canvas-manual-paint-status').textContent).toContain('Restored Normal');
  expect(view.getByRole('button', { name: 'Normal · manual' }).getAttribute('aria-pressed')).toBe('true');
  expect(mock.viewport).not.toHaveBeenCalled();
});
it('cleans up on unmount without waiting for the next frame', async () => {
  const view = mount(); fireEvent.click(view.getByRole('button', { name: /^single-svg$/ }));
  await act(async () => vi.advanceTimersByTimeAsync(900)); expect(mock.activate).toHaveBeenCalledOnce();
  view.unmount(); expect(mock.restore).toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(200));
});
it('reports a refused comparison and still releases the gesture', async () => {
  mock.prepare.mockImplementationOnce(() => { throw new Error('unsupported'); });
  const view = mount(); fireEvent.click(view.getByRole('button', { name: /^single-svg$/ }));
  await act(async () => vi.advanceTimersByTimeAsync(1200));
  expect(view.gesture).toHaveBeenLastCalledWith(false);
  expect(view.getByTestId('canvas-pan-results').textContent).toContain('unsupported');
});

it('compares high zoom snapshot painting without driving RF culling', async () => {
  mock.zoom = .66;
  const view = mount(); fireEvent.click(view.getByRole('button', { name: /^single-svg-dom-transform$/ }));
  await act(async () => vi.advanceTimersByTimeAsync(5100));
  expect(mock.activate).toHaveBeenCalledOnce(); expect(mock.restore).toHaveBeenCalledOnce();
  // Only the final camera restoration may touch React Flow.
  expect(mock.viewport).toHaveBeenCalledTimes(1);
  expect(mock.viewport).toHaveBeenLastCalledWith({ x: 0, y: 0, zoom: .66 });
  expect(view.getByTestId('canvas-pan-results').textContent).toContain('"invalidReason": null');
  expect(view.gesture).toHaveBeenLastCalledWith(false);
});

it('still refuses the real-camera snapshot at high zoom', async () => {
  mock.zoom = .66;
  const view = mount(); fireEvent.click(view.getByRole('button', { name: /^single-svg$/ }));
  await act(async () => vi.advanceTimersByTimeAsync(5100));
  expect(mock.prepare).not.toHaveBeenCalled();
  expect(view.getByTestId('canvas-pan-results').textContent).toContain('Use a low zoom');
});

it('aborts high zoom snapshot when the graph changes', async () => {
  mock.zoom = .66; mock.valid.mockReturnValue(false);
  const view = mount(); fireEvent.click(view.getByRole('button', { name: /^single-svg-dom-transform$/ }));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(mock.restore).toHaveBeenCalledOnce();
  expect(mock.viewport).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('canvas-pan-results').textContent).toContain('Graph, zoom or tool changed');
});

it('keeps the persistent cache comparison outside low detail and restores default', () => {
  const view = mount();
  const choice = view.getByRole('combobox', { name: 'Viewport cache' });
  const style = view.getByTestId('canvas-viewport-cache-probe');
  expect(style.textContent).toBe('');
  fireEvent.change(choice, { target: { value: 'transform' } });
  expect(style.textContent).toContain('.dc-canvas:not(.dc-canvas--low-detail)');
  expect(style.textContent).toContain('will-change: transform !important');
  fireEvent.change(choice, { target: { value: 'auto' } });
  expect(style.textContent).toContain('will-change: auto !important');
  fireEvent.change(choice, { target: { value: 'edges' } });
  expect(style.textContent).toContain('.react-flow__edges { will-change: transform');
  fireEvent.change(choice, { target: { value: 'edge-svg' } });
  expect(style.textContent).toContain('.react-flow__edges > svg { will-change: transform');
  expect(style.textContent).toContain(':not(.dc-canvas--low-detail)');
  fireEvent.change(choice, { target: { value: 'default' } });
  expect(style.textContent).toBe('');
  view.unmount();
  expect(document.querySelector('[data-testid="canvas-viewport-cache-probe"]')).toBeNull();
});
