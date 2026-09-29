// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useReactFlow } from '@xyflow/react';
import { applyGroupPaintProbe, type GroupPaintMode } from '@/features/canvas/application/canvasGroupPaintProbe';
import { prepareSingleSvgProbe, startManualSingleSvgProbe, type EdgePaintProbe } from '@/features/canvas/application/canvasEdgePaintProbe';

export interface PanProfile {
  active: boolean;
  commits: number;
  renderMs: number;
}

type Mode = 'normal' | 'single-svg' | 'single-svg-dom-transform' | 'no-edges' | 'no-media' | 'no-paint' | 'dom-transform' | 'stable-style' | 'composite';
type ScriptTiming = {
  duration: number;
  sourceFunctionName?: string;
  invoker?: string;
  sourceURL?: string;
};
type AnimationTiming = PerformanceEntry & {
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: ScriptTiming[];
};
type FrameCost = {
  duration: number;
  blocking: number;
  render: number;
  layout: number;
  scripts: { duration: number; function: string; invoker: string; source: string }[];
};
const modes: Mode[] = ['normal', 'single-svg', 'single-svg-dom-transform', 'no-edges', 'no-media', 'no-paint', 'dom-transform', 'stable-style', 'composite'];
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const rounded = (value: number) => Math.round(value * 100) / 100;

/** Opt-in development measurement; camera is restored, node data is never edited. */
export default function CanvasPanDiagnostics({
  rootRef,
  profile,
  onGestureChange,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  profile: RefObject<PanProfile>;
  onGestureChange: (active: boolean) => void;
}) {
  const flow = useReactFlow();
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<Mode>('normal');
  const [groupPaint, setGroupPaint] = useState<GroupPaintMode>('normal');
  const [viewportCache, setViewportCache] = useState('default');
  const [manualPaint, setManualPaint] = useState<'normal' | 'single-svg'>('normal');
  const [manualError, setManualError] = useState('');
  const [results, setResults] = useState<object[]>([]);
  const cancelled = useRef(false);
  const runningRef = useRef(false);
  const activeProbe = useRef<EdgePaintProbe | null>(null);
  useEffect(() => () => { cancelled.current = true; activeProbe.current?.restore(); }, []);
  useEffect(() => {
    const root = rootRef.current;
    if (root) return applyGroupPaintProbe(root, groupPaint);
  }, [rootRef, groupPaint]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || manualPaint !== 'single-svg') return;
    const failed = (reason: string) => { setManualError(reason); setManualPaint('normal'); };
    try { return startManualSingleSvgProbe(root, failed); }
    catch (error) { failed(error instanceof Error ? error.message : 'Manual comparison stopped'); }
  }, [rootRef, manualPaint]);

  const selectManualPaint = (value: 'normal' | 'single-svg') => {
    setManualError('');
    // A manual comparison must not inherit the rejected cache experiment or
    // combine group changes with edge changes. This never moves the camera.
    setViewportCache('default');
    setGroupPaint('normal');
    setManualPaint(value);
  };

  const run = async (selectedMode: Mode, manual = false) => {
    if (runningRef.current || manualPaint !== 'normal') return;
    runningRef.current = true;
    cancelled.current = false;
    const origin = flow.getViewport();
    const originLocation = window.location.href;
    const root = rootRef.current;
    if (!root) { runningRef.current = false; return; }
    setRunning(true);
    setMode(selectedMode);
    const samples: number[] = [];
    const cameraCosts: number[] = [];
    const geometry = new Map(
      [...root.querySelectorAll<HTMLElement>('.react-flow__node')]
        .map(node => [node, node.getAttribute('style')]),
    );
    const longFrames: number[] = [];
    const visibility = new Set<DocumentVisibilityState>();
    const frameCosts: FrameCost[] = [];
    const imageSources = new Map([...root.querySelectorAll<HTMLImageElement>('.react-flow__node img')].map(image => [image, image.currentSrc || image.src]));
    let edgeProbe: EdgePaintProbe | undefined;
    let invalidReason: string | null = null;
    let added = 0;
    let removed = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        added += record.addedNodes.length;
        removed += record.removedNodes.length;
      }
    });
    const performanceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longFrames.push(entry.duration);
        const frame = entry as AnimationTiming;
        const end = frame.startTime + frame.duration;
        frameCosts.push({
          duration: rounded(frame.duration),
          blocking: rounded(frame.blockingDuration ?? 0),
          render: frame.renderStart ? rounded(end - frame.renderStart) : 0,
          layout: frame.styleAndLayoutStart ? rounded(end - frame.styleAndLayoutStart) : 0,
          scripts: (frame.scripts ?? []).map(script => ({
            duration: rounded(script.duration),
            function: script.sourceFunctionName ?? '',
            invoker: script.invoker ?? '',
            // Only the script filename, never signed URLs or query parameters.
            source: script.sourceURL
              ? new URL(script.sourceURL, window.location.href).pathname.split('/').pop() ?? ''
              : '',
          })),
        });
      }
    });
    const supportsLoaf = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame');
    try {
      // Leave the control click / automation observation outside the measured window.
      await new Promise(resolve => setTimeout(resolve, 700));
      await nextFrame();
      await nextFrame();
      const viewportElement = root.querySelector('.react-flow__viewport');
      if (cancelled.current || !viewportElement || window.location.href !== originLocation) return;
      // Programmatic setViewport emits start/end per frame. Treat the whole
      // trajectory as one gesture, just like a real pointer or minimap drag.
      if (!manual) onGestureChange(true);
      await nextFrame();
      const domOnly = selectedMode === 'dom-transform' || selectedMode === 'single-svg-dom-transform';
      if (selectedMode === 'single-svg' || selectedMode === 'single-svg-dom-transform') {
        if (groupPaint !== 'normal') throw new Error('Use Normal group paint for the edge comparison');
        // A snapshot can remain valid at high zoom only if the comparison holds
        // RF's camera (and therefore its visible edge set) still. Compare against
        // dom-transform, not normal: this is a paint experiment, not real input.
        if (!domOnly && origin.zoom >= 0.35) throw new Error('Use a low zoom without viewport culling for this comparison');
        if (manual && root.dataset.canvasTool !== 'hand') throw new Error('Select the hand tool before recording');
        edgeProbe = prepareSingleSvgProbe(root);
        activeProbe.current = edgeProbe;
        edgeProbe.activate();
        await nextFrame();
      }
      observer.observe(viewportElement, { childList: true, subtree: true });
      if (supportsLoaf) performanceObserver.observe({ type: 'long-animation-frame' });
      Object.assign(profile.current, { active: true, commits: 0, renderMs: 0 });
      const start = await nextFrame();
      let previous = start;
      while (!cancelled.current && window.location.href === originLocation) {
        const now = await nextFrame();
        if (edgeProbe && (!edgeProbe.valid() || flow.getViewport().zoom !== origin.zoom || (manual && root.dataset.canvasTool !== 'hand'))) {
          invalidReason = 'Graph, zoom or tool changed during snapshot';
          break;
        }
        visibility.add(document.visibilityState);
        samples.push(now - previous);
        previous = now;
        const progress = Math.min(1, (now - start) / 4000);
        if (!manual) {
          // Return to the origin twice, with identical screen-space travel in every mode.
          const cameraStart = performance.now();
          const x = origin.x + 420 * Math.sin(progress * 2 * Math.PI);
          if (domOnly) {
            // Isolate browser painting from React Flow/store work for this
            // experiment. Never used by the actual canvas input path.
            (viewportElement as HTMLElement).style.transform = `translate(${x}px, ${origin.y}px) scale(${origin.zoom})`;
          } else {
            void flow.setViewport({ ...origin, x });
          }
          cameraCosts.push(performance.now() - cameraStart);
        }
        if (progress === 1) break;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const percentile = (p: number) => rounded(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
      const result = {
        mode: selectedMode, groupPaint, viewportCache, manual, zoom: origin.zoom, visibility: [...visibility],
        invalidReason, edgePaint: edgeProbe?.stats ?? null,
        changedImageSources: [...imageSources].filter(([image, src]) => !image.isConnected || (image.currentSrc || image.src) !== src).length,
        samePageAndVisible: !cancelled.current && window.location.href === originLocation && visibility.size === 1 && visibility.has('visible'),
        frames: samples.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99),
        over33ms: samples.filter((value) => value > 33.4).length,
        maxMs: rounded(Math.max(0, ...samples)),
        reactCommits: profile.current.commits, reactMs: rounded(profile.current.renderMs),
        added, removed, longFrames: supportsLoaf ? longFrames.length : null,
        cameraMs: rounded(cameraCosts.reduce((sum, value) => sum + value, 0)),
        maxCameraMs: rounded(Math.max(0, ...cameraCosts)),
        changedNodeGeometry: [...geometry].filter(([node, style]) => !node.isConnected || node.getAttribute('style') !== style).length,
        nodes: root.querySelectorAll('.react-flow__node').length,
        // A visible tab can still be throttled by an occluded browser window.
        // This signal is a warning for the experiment, not a diagnosis of GPU time.
        possibleThrottleFrames: frameCosts.filter(frame => frame.duration > 500
          && frame.render + frame.scripts.reduce((sum, script) => sum + script.duration, 0) < frame.duration / 4).length,
        frameCosts: frameCosts.sort((a,b) => b.duration - a.duration).slice(0,3),
        edgeSvgs: root.querySelectorAll('.react-flow__edges > svg').length,
        videos: root.querySelectorAll('.react-flow__node video').length,
      };
      if (!cancelled.current) setResults((current) => [...current.slice(-11), result]);
    } catch (error) {
      if (!cancelled.current) setResults(current => [...current.slice(-11), { mode: selectedMode, invalidReason: error instanceof Error ? error.message : 'Diagnostic failed' }]);
    } finally {
      edgeProbe?.restore();
      activeProbe.current = null;
      profile.current.active = false;
      observer.disconnect();
      performanceObserver.disconnect();
      try {
        if (root.isConnected && window.location.href === originLocation) await flow.setViewport(origin);
      } finally {
        if (!manual && root.isConnected) onGestureChange(false);
        runningRef.current = false;
        if (!cancelled.current) { setMode('normal'); setRunning(false); }
      }
    }
  };

  return (
    <aside className="nopan nodrag nowheel absolute right-14 top-14 z-[10001] max-w-xl rounded-lg border border-border bg-surface p-3 text-xs text-text" data-testid="canvas-pan-diagnostics" onPointerDown={(event) => event.stopPropagation()}>
      <style data-testid="canvas-viewport-cache-probe">{viewportCache === 'transform'
        ? '.dc-canvas:not(.dc-canvas--low-detail) .react-flow__viewport { will-change: transform !important; }'
        : viewportCache === 'auto'
          ? '.dc-canvas .react-flow__viewport { will-change: auto !important; }'
        : viewportCache === 'edges'
          ? '.dc-canvas:not(.dc-canvas--low-detail) .react-flow__edges { will-change: transform !important; }'
        : viewportCache === 'edge-svg'
          ? '.dc-canvas:not(.dc-canvas--low-detail) .react-flow__edges > svg { will-change: transform !important; }'
          : ''}</style>
      <style>{groupPaint === 'no-fill'
        ? '.dc-canvas .react-flow__node-groupNode > .group { background-color:transparent!important;border-color:transparent!important;transition:none!important; }'
        : groupPaint === 'no-label'
          ? '.dc-canvas .react-flow__node-groupNode > .group > .origin-bottom-left { visibility:hidden!important; }'
          : ''}</style>
      <style>{mode === 'no-edges'
        ? '.dc-canvas .react-flow__edges { display: none !important; }'
        : mode === 'no-paint'
          ? '.dc-canvas .react-flow__viewport { visibility: hidden !important; }'
        : mode === 'no-media'
          ? '.dc-canvas .react-flow__viewport img, .dc-canvas .react-flow__viewport video { visibility: hidden !important; }'
        : mode === 'stable-style'
          ? '.dc-canvas .react-flow__viewport * { box-shadow:none!important;filter:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;animation:none!important; }'
          : mode === 'composite'
            ? '.dc-canvas .react-flow__viewport { will-change: transform; }'
            : ''}</style>
      <div className="mb-2">Canvas pan diagnostics · DEV</div>
      <div className="mb-2 flex gap-2" role="group" aria-label="Manual drag comparison">
        <button className="rounded border border-border px-2 py-1 aria-pressed:bg-surface-field" aria-pressed={manualPaint === 'normal'} disabled={running} onClick={() => selectManualPaint('normal')}>Normal · manual</button>
        <button className="rounded border border-border px-2 py-1 aria-pressed:bg-surface-field" aria-pressed={manualPaint === 'single-svg'} disabled={running} onClick={() => selectManualPaint('single-svg')}>Single SVG · manual</button>
      </div>
      <p className="mb-2" role="status" data-testid="canvas-manual-paint-status">{manualError
        ? `Restored Normal: ${manualError}`
        : `${manualPaint === 'normal' ? 'Normal' : 'Single SVG'} active. Use the hand tool (H) and drag freely. No timer or camera reset.`}</p>
      <details>
      <summary className="cursor-pointer">Automatic measurements · 4s · {running ? mode : 'ready'}</summary>
      <label>Viewport cache <select aria-label="Viewport cache" value={viewportCache} disabled={running || manualPaint !== 'normal'} onChange={event => setViewportCache(event.target.value)}>
        <option value="default">Product default</option>
        <option value="auto">Browser auto (baseline)</option>
        <option value="transform">Retain high zoom transform</option>
        <option value="edges">Retain edge container</option>
        <option value="edge-svg">Retain each edge SVG</option>
      </select></label>
      <label>Group paint <select aria-label="Group paint" value={groupPaint} disabled={running || manualPaint !== 'normal'} onChange={event => setGroupPaint(event.target.value as GroupPaintMode)}>
        <option value="normal">Normal</option>
        <option value="no-fill">Hide group backgrounds</option>
        <option value="no-label">Hide group labels</option>
        <option value="wrapper-fill">Group fill on wrapper</option>
        <option value="lower-layer">Group layer behind edges</option>
        <option value="reference">Reference group paint</option>
      </select></label>
      <div className="flex flex-wrap gap-2">
        {modes.map((item) => <button className="rounded border border-border px-2 py-1" key={item} disabled={running || manualPaint !== 'normal'} onClick={() => void run(item)}>{item}</button>)}
        <button disabled={running || manualPaint !== 'normal'} onClick={() => void run('normal', true)}>Record drag</button>
        <button disabled={running || manualPaint !== 'normal'} onClick={() => void run('single-svg', true)}>Record single SVG drag</button>
      </div>
      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap" data-testid="canvas-pan-results">{JSON.stringify(results, null, 2)}</pre>
      </details>
    </aside>
  );
}
