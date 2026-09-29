// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

const NS = 'http://www.w3.org/2000/svg';
const tags = new Set(['g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'defs', 'marker', 'linearGradient', 'radialGradient', 'stop']);
const attributes = new Set(['id', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points', 'transform', 'viewBox', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'gradientUnits', 'gradientTransform', 'offset', 'href']);
const paintProperties = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'marker-start', 'marker-mid', 'marker-end', 'stop-color', 'stop-opacity', 'vector-effect', 'visibility'];
let sequence = 0;

export interface EdgePaintProbe {
  activate(): void;
  restore(): void;
  valid(): boolean;
  stats: { sourceSvgCount: number; paintedSvgCount: number; edgeCount: number; preparationMs: number };
}

/** DEV only. Retains RF's original components; compares painted SVG containers. */
export function prepareSingleSvgProbe(root: HTMLElement): EdgePaintProbe {
  const started = performance.now();
  const edges = root.querySelector<HTMLElement>('.react-flow__edges');
  if (!edges || !edges.parentElement || getComputedStyle(edges).display === 'none') throw new Error('No visible edge layer');
  if (root.querySelector('.react-flow__node.selected, .react-flow__edge.selected, .canvas-processing-edge__flow, .canvas-data-edge__packet, [data-canvas-edge-flow], .react-flow__edge.animated')) {
    throw new Error('Use an unselected, idle graph for this comparison');
  }
  const source = [...edges.querySelectorAll<SVGSVGElement>(':scope > svg')];
  const edgeCount = edges.querySelectorAll('.react-flow__edge').length;
  if (!source.length || !edgeCount) throw new Error('No mounted edges');
  const graphics = source.filter(svg => svg.querySelector('.react-flow__edge'));
  const layerZ = getComputedStyle(graphics[0]).zIndex || 'auto';
  if (getComputedStyle(edges).transform && getComputedStyle(edges).transform !== 'none') throw new Error('Unsupported edge layer transform');
  for (const svg of source) {
    const style = getComputedStyle(svg);
    if (svg.hasAttribute('viewBox') || svg.hasAttribute('transform') ||
        (style.transform && style.transform !== 'none') ||
        (svg.querySelector('.react-flow__edge') && (style.zIndex || 'auto') !== layerZ) ||
        [style.left, style.top].some(value => value && value !== 'auto' && Number.parseFloat(value) !== 0)) {
      throw new Error('Edge coordinate systems or stacking levels differ');
    }
  }
  const prefix = `dc-edge-probe-${++sequence}-`;
  const ids = new Map([...edges.querySelectorAll('[id]')].map((el, index) => [el.id, `${prefix}${index}`]));
  const rewrite = (value: string) => value.replace(/url\(["']?([^)'"\s]+)["']?\)/g, (_match, reference: string) => {
    const hash = reference.indexOf('#');
    if (hash < 0 || (hash > 0 && reference.slice(0, hash) !== location.href.split('#')[0])) throw new Error('External SVG paint reference is unsupported');
    const id = ids.get(reference.slice(hash + 1));
    if (!id) throw new Error('Unresolved SVG paint reference');
    return `url(#${id})`;
  });
  const copy = (element: Element): SVGElement => {
    if (!tags.has(element.localName)) throw new Error('Unsupported edge graphic');
    const next = document.createElementNS(NS, element.localName);
    for (const name of element.getAttributeNames()) {
      if (!attributes.has(name)) continue;
      const value = element.getAttribute(name)!;
      if (name === 'id') next.id = ids.get(value)!;
      else if (name === 'href') {
        if (!value.startsWith('#') || !ids.has(value.slice(1))) throw new Error('Unsupported SVG link');
        next.setAttribute(name, `#${ids.get(value.slice(1))}`);
      } else next.setAttribute(name, value);
    }
    const style = getComputedStyle(element);
    if ((style.filter && style.filter !== 'none') || (style.clipPath && style.clipPath !== 'none')) throw new Error('Filtered edges need a separate comparison');
    for (const name of paintProperties) {
      const value = style.getPropertyValue(name) || element.getAttribute(name);
      if (value) next.style.setProperty(name, rewrite(value));
    }
    next.style.pointerEvents = 'none';
    for (const child of element.children) next.appendChild(copy(child));
    return next;
  };
  const layer = document.createElementNS(NS, 'svg');
  layer.dataset.canvasEdgeProbe = 'true';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none;z-index:0';
  layer.style.zIndex = layerZ;
  for (const svg of source) for (const child of svg.children) layer.appendChild(copy(child));
  const before = { value: edges.style.getPropertyValue('display'), priority: edges.style.getPropertyPriority('display') };
  let active = false;
  let restored = false;
  let stale = false;
  const observer = new MutationObserver(() => { stale = true; });
  const stats = { sourceSvgCount: source.length, paintedSvgCount: 1, edgeCount, preparationMs: performance.now() - started };
  const valid = () => {
    if (observer.takeRecords().length) stale = true;
    return !restored && !stale && root.isConnected && edges.isConnected && (!active || layer.isConnected);
  };
  return {
    stats,
    valid,
    activate() {
      if (active || restored) return;
      edges.after(layer);
      edges.style.setProperty('display', 'none', 'important');
      active = true;
      // Do not observe the viewport transform or our own layer insertion.
      observer.observe(edges, { subtree: true, childList: true, attributes: true });
    },
    restore() {
      if (restored) return;
      restored = true;
      observer.disconnect();
      layer.remove();
      if (active && edges.style.display === 'none' && edges.style.getPropertyPriority('display') === 'important') {
        if (before.value) edges.style.setProperty('display', before.value, before.priority);
        else edges.style.removeProperty('display');
      }
    },
  };
}

/** DEV manual comparison. RF still owns the camera, culling and graph data.
 * Rebuild only when source edges change, before the browser's next paint;
 * a stationary snapshot would silently lose edges when panning at high zoom.
 */
export function startManualSingleSvgProbe(root: HTMLElement, onFailure: (reason: string) => void): () => void {
  const edges = root.querySelector<HTMLElement>('.react-flow__edges');
  if (!edges) throw new Error('No edge layer');
  let probe: EdgePaintProbe | undefined;
  let stopped = false;
  const assertHand = () => {
    if (root.dataset.canvasTool !== 'hand') throw new Error('Select the hand tool (H) first');
    if (root.querySelector('.react-flow__node.selected, .react-flow__edge.selected')) {
      throw new Error('Clear node and edge selection before comparing');
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    probe?.restore();
    probe = undefined;
  };
  const watch = () => observer.observe(root, { childList: true, subtree: true, attributes: true });
  const rebuild = () => {
    observer.disconnect();
    probe?.restore();
    probe = undefined;
    assertHand();
    if (!root.isConnected || !edges.isConnected) throw new Error('Canvas edge layer changed');
    // An empty viewport is valid. Keep listening so returning to the graph
    // paints newly mounted edges instead of retaining the previous snapshot.
    if (edges.querySelector('.react-flow__edge')) {
      probe = prepareSingleSvgProbe(root);
      probe.activate();
    }
    watch();
  };
  const observer = new MutationObserver(records => {
    if (stopped) return;
    try {
      if (!root.isConnected || !edges.isConnected) throw new Error('Canvas edge layer changed');
      const toolChanged = records.some(record => record.target === root && record.attributeName === 'data-canvas-tool');
      const sourceChanged = records.some(record => edges.contains(record.target));
      const nodeSelectionChanged = records.some(record => record.target instanceof Element && (
        (record.attributeName === 'class' && record.target.matches('.react-flow__node.selected')) ||
        (record.type === 'childList' && record.target.matches('.react-flow__nodes'))
      ));
      if (toolChanged || nodeSelectionChanged) assertHand();
      if (sourceChanged) {
        if (probe && (edges.style.display !== 'none' || edges.style.getPropertyPriority('display') !== 'important')) {
          throw new Error('Edge display was changed outside the comparison');
        }
        rebuild();
      }
    } catch (error) {
      stop();
      onFailure(error instanceof Error ? error.message : 'Manual comparison stopped');
    }
  });
  try { rebuild(); } catch (error) { stop(); throw error; }
  return stop;
}
