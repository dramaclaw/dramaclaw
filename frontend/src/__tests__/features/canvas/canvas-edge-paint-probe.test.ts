// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it } from 'vitest';
import { prepareSingleSvgProbe, startManualSingleSvgProbe } from '@/features/canvas/application/canvasEdgePaintProbe';

afterEach(() => { document.body.replaceChildren(); });
function graph() {
  const root = document.createElement('div');
  root.innerHTML = `<div class="react-flow__viewport"><div class="react-flow__edges"><svg><defs><marker id="arrow"><path d="M0 0L4 2L0 4Z" /></marker></defs></svg><svg style="z-index:0"><g class="react-flow__edge" data-id="edge"><path id="path" d="M0 0L200 100" style="stroke:rgb(176,176,183);stroke-width:2;fill:none;marker-end:url(#arrow)"/><circle cx="2" cy="3" r="5" /></g></svg></div><div class="react-flow__node" style="transform:translate(200px,100px);width:50px;height:40px"></div></div>`;
  document.body.append(root);
  return root;
}
describe('single SVG edge paint probe', () => {
  it('rejects active default-edge flow before replacing its interactive paint', () => {
    const root = graph();
    root.querySelector('.react-flow__edge')!.insertAdjacentHTML('beforeend', '<g data-canvas-edge-flow="edge"><path d="M0 0L200 100" /></g>');
    expect(() => prepareSingleSvgProbe(root)).toThrow(/idle/);
    expect(root.querySelector<HTMLElement>('.react-flow__edges')!.style.display).toBe('');
    expect(root.querySelector('[data-canvas-edge-probe]')).toBeNull();
  });
  it('copies geometry and local marker references, retains nodes, restores idempotently', () => {
    const root = graph();
    const node = root.querySelector('.react-flow__node')!;
    const before = node.getAttribute('style');
    const original = root.querySelector<HTMLElement>('.react-flow__edges')!;
    const probe = prepareSingleSvgProbe(root);
    expect(root.querySelector('[data-canvas-edge-probe]')).toBeNull();
    probe.activate();
    const layer = root.querySelector('[data-canvas-edge-probe]')!;
    expect(probe.stats).toMatchObject({ sourceSvgCount: 2, paintedSvgCount: 1, edgeCount: 1 });
    expect(layer.querySelector('g path')?.getAttribute('d')).toBe('M0 0L200 100');
    const marker = layer.querySelector('marker')!;
    expect(layer.querySelector<SVGElement>('g path')?.style.markerEnd.replace(/"/g, '')).toBe(`url(#${marker.id})`);
    expect(marker.id).not.toBe('arrow');
    expect(layer.querySelector('[data-id]')).toBeNull();
    expect(node.getAttribute('style')).toBe(before);
    expect(original.style.display).toBe('none');
    expect(probe.valid()).toBe(true);
    probe.restore(); probe.restore();
    expect(original.style.display).toBe('');
    expect(root.querySelector('[data-canvas-edge-probe]')).toBeNull();
  });
  it('invalidates permanently if RF changes paths', () => {
    const root = graph(); const probe = prepareSingleSvgProbe(root); probe.activate();
    root.querySelector('.react-flow__edge path')!.setAttribute('d', 'M1 2L3 4');
    expect(probe.valid()).toBe(false); expect(probe.valid()).toBe(false); probe.restore();
  });
  it('does not invalidate for the parent camera transform', () => {
    const root = graph(); const probe = prepareSingleSvgProbe(root); probe.activate();
    root.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform = 'translate(100px, 0) scale(.2)';
    expect(probe.valid()).toBe(true); probe.restore();
  });
  it('does not overwrite a newer display edit during cleanup', () => {
    const root = graph(); const probe = prepareSingleSvgProbe(root); probe.activate();
    const edges = root.querySelector<HTMLElement>('.react-flow__edges')!;
    edges.style.display = 'block'; probe.restore(); expect(edges.style.display).toBe('block');
  });
  it.each(['<image href="https://example.invalid/image.png"/>', '<foreignObject/>', '<path style="stroke:url(#missing)"/>'])(
    'rejects unsupported content before hiding originals: %s', fragment => {
      const root = graph(); root.querySelector('.react-flow__edge')!.insertAdjacentHTML('beforeend', fragment);
      expect(() => prepareSingleSvgProbe(root)).toThrow();
      expect(root.querySelector<HTMLElement>('.react-flow__edges')!.style.display).toBe('');
      expect(root.querySelector('[data-canvas-edge-probe]')).toBeNull();
    },
  );
  it('rejects raised or selected edges', () => {
    const root = graph(); const svg = root.querySelectorAll('svg')[1];
    const other = svg.cloneNode(true) as SVGSVGElement; other.style.zIndex = '1000'; svg.after(other);
    expect(() => prepareSingleSvgProbe(root)).toThrow(/stacking/);
    other.remove(); root.querySelector('.react-flow__edge')!.classList.add('selected');
    expect(() => prepareSingleSvgProbe(root)).toThrow(/unselected/);
  });
});

describe('persistent manual single SVG comparison', () => {
  function manualGraph() { const root = graph(); root.dataset.canvasTool = 'hand'; return root; }
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  it('keeps the camera and snapshot stable during manual panning, until stopped', async () => {
    const root = manualGraph(); const errors: string[] = [];
    const stop = startManualSingleSvgProbe(root, error => errors.push(error));
    const layer = root.querySelector('[data-canvas-edge-probe]');
    const viewport = root.querySelector<HTMLElement>('.react-flow__viewport')!;
    viewport.style.transform = 'translate(520px, 120px) scale(.66)'; await flush();
    expect(root.querySelector('[data-canvas-edge-probe]')).toBe(layer);
    stop(); stop();
    expect(viewport.style.transform).toBe('translate(520px, 120px) scale(.66)');
    expect(root.querySelector('[data-canvas-edge-probe]')).toBeNull();
    expect(root.querySelector<HTMLElement>('.react-flow__edges')!.style.display).toBe('');
    expect(errors).toEqual([]);
  });
  it('refreshes geometry and newly mounted edges, including returning from an empty area', async () => {
    const root = manualGraph(); const errors: string[] = [];
    const stop = startManualSingleSvgProbe(root, error => errors.push(error));
    const original = root.querySelector('.react-flow__edges')!;
    original.querySelector('.react-flow__edge path')!.setAttribute('d', 'M10 20L30 40'); await flush();
    expect(root.querySelector('[data-canvas-edge-probe] g path')!.getAttribute('d')).toBe('M10 20L30 40');
    const svg = original.querySelectorAll('svg')[1];
    svg.remove(); await flush();
    expect(root.querySelector('[data-canvas-edge-probe]')).toBeNull();
    original.append(svg); await flush();
    expect(root.querySelector('[data-canvas-edge-probe] g path')).not.toBeNull();
    const clone = svg.cloneNode(true); original.append(clone); await flush();
    expect(root.querySelectorAll('[data-canvas-edge-probe] g')).toHaveLength(2);
    expect(root.querySelectorAll('[data-canvas-edge-probe]')).toHaveLength(1);
    stop(); expect(errors).toEqual([]);
  });
  it('restores originals immediately on a tool change and disconnects listeners', async () => {
    const root = manualGraph(); const errors: string[] = [];
    const stop = startManualSingleSvgProbe(root, error => errors.push(error));
    root.dataset.canvasTool = 'move'; await flush();
    expect(root.querySelector('[data-canvas-edge-probe]')).toBeNull();
    expect(root.querySelector<HTMLElement>('.react-flow__edges')!.style.display).toBe('');
    expect(errors).toHaveLength(1);
    root.dataset.canvasTool = 'hand'; await flush();
    expect(root.querySelector('[data-canvas-edge-probe]')).toBeNull(); stop();
  });
  it('falls back on selected nodes or unsupported new edges', async () => {
    for (const invalid of ['selection', 'graphic']) {
      const root = manualGraph(); const errors: string[] = [];
      const stop = startManualSingleSvgProbe(root, error => errors.push(error));
      if (invalid === 'selection') root.querySelector('.react-flow__node')!.classList.add('selected');
      else root.querySelector('.react-flow__edges .react-flow__edge')!.insertAdjacentHTML('beforeend', '<foreignObject/>');
      await flush();
      expect(root.querySelector('[data-canvas-edge-probe]')).toBeNull();
      expect(root.querySelector<HTMLElement>('.react-flow__edges')!.style.display).toBe('');
      expect(errors).toHaveLength(1); stop(); root.remove();
    }
  });
  it('does not overwrite a later external display change', async () => {
    const root = manualGraph(); const errors: string[] = [];
    const stop = startManualSingleSvgProbe(root, error => errors.push(error));
    root.querySelector<HTMLElement>('.react-flow__edges')!.style.display = 'block'; await flush();
    expect(root.querySelector<HTMLElement>('.react-flow__edges')!.style.display).toBe('block');
    expect(root.querySelector('[data-canvas-edge-probe]')).toBeNull();
    expect(errors).toHaveLength(1); stop();
  });
  it('refuses non-hand mode before replacing any edge layer', () => {
    const root = graph();
    expect(() => startManualSingleSvgProbe(root, () => {})).toThrow(/hand tool/);
    expect(root.querySelector('[data-canvas-edge-probe]')).toBeNull();
    expect(root.querySelector<HTMLElement>('.react-flow__edges')!.style.display).toBe('');
  });
});
