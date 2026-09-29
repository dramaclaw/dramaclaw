// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAINT_TAGS = new Set([
  'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect',
  'defs', 'marker', 'linearGradient', 'radialGradient', 'stop',
]);
let cloneSequence = 0;

function sourceSvg(target: Node, edges: HTMLElement): SVGSVGElement | null {
  let element = target instanceof Element ? target : target.parentElement;
  while (element && element.parentElement !== edges) element = element.parentElement;
  return element instanceof SVGSVGElement && element.parentElement === edges ? element : null;
}

function canMirror(svg: SVGSVGElement): boolean {
  const style = getComputedStyle(svg);
  if (svg.querySelector('.react-flow__edge.selected') ||
      svg.hasAttribute('viewBox') || svg.hasAttribute('transform') ||
      (style.transform !== 'none' && style.transform !== '') ||
      (style.left !== '0px' && style.left !== 'auto') ||
      (style.top !== '0px' && style.top !== 'auto') ||
      // RF raises selected edges above their neighbours. Keep those in its own
      // layer so selection, markers and actions retain their stacking order.
      (style.zIndex !== '1' && style.zIndex !== 'auto')) return false;
  return [...svg.querySelectorAll('*')].every(element => PAINT_TAGS.has(element.localName)) &&
    !svg.querySelector('[filter], [clip-path], [mask]');
}

function clonePaint(svg: SVGSVGElement): SVGGElement {
  const group = document.createElementNS(SVG_NS, 'g');
  for (const child of svg.children) group.appendChild(child.cloneNode(true));
  // The RF paths remain in the DOM as hit targets. Their wide transparent
  // copies add no visible detail and need not enter the shared paint tree.
  group.querySelectorAll('.react-flow__edge-interaction, path[stroke="transparent"]').forEach(path => path.remove());

  const prefix = `dc-single-edge-${++cloneSequence}-`;
  const ids = new Map<string, string>();
  group.querySelectorAll('[id]').forEach((element, index) => {
    ids.set(element.id, `${prefix}${index}`);
  });
  group.querySelectorAll('[id]').forEach(element => {
    element.id = ids.get(element.id)!;
  });
  group.querySelectorAll('*').forEach(element => {
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name);
      if (!value) continue;
      let next = value.replace(/url\(#([^)]*)\)/g, (match, id: string) =>
        ids.has(id) ? `url(#${ids.get(id)})` : match);
      if ((name === 'href' || name === 'xlink:href') && next.startsWith('#')) {
        next = `#${ids.get(next.slice(1)) ?? next.slice(1)}`;
      }
      if (next !== value) element.setAttribute(name, next);
    }
  });
  return group;
}

/** RF keeps the graph, geometry and pointer handlers. Only compatible edge
 * paint is mirrored into one SVG; source SVGs stay transparent hit targets.
 * Camera transforms apply to the whole viewport and never rebuild this tree.
 */
export function mountSingleSvgEdgeLayer(root: HTMLElement): () => void {
  const viewport = root.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport) return () => undefined;
  let detach: (() => void) | undefined;

  const attach = (edges: HTMLElement): (() => void) => {
    const layer = document.createElementNS(SVG_NS, 'svg');
    layer.dataset.canvasSingleSvgLayer = 'true';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none';
    edges.after(layer);

    const painted = new Map<SVGSVGElement, SVGGElement>();
    const restoreSource = (svg: SVGSVGElement) => {
      svg.removeAttribute('data-canvas-single-svg-source');
      painted.get(svg)?.remove();
      painted.delete(svg);
    };
    const syncSource = (svg: SVGSVGElement) => {
      if (!svg.isConnected || svg.parentElement !== edges || !canMirror(svg)) {
        restoreSource(svg);
        return;
      }
      try {
        const next = clonePaint(svg);
        const previous = painted.get(svg);
        if (previous) previous.replaceWith(next);
        else layer.appendChild(next);
        painted.set(svg, next);
        // Make the source transparent only after its replacement is ready.
        svg.dataset.canvasSingleSvgSource = 'true';
      } catch {
        restoreSource(svg);
      }
    };
    const syncStructure = () => {
      const current = new Set(edges.querySelectorAll<SVGSVGElement>(':scope > svg'));
      for (const svg of painted.keys()) if (!current.has(svg)) restoreSource(svg);
      for (const svg of current) if (!painted.has(svg)) syncSource(svg);
      // RF may reorder edges when selection or z-index changes.
      let previous: SVGGElement | null = null;
      for (const svg of current) {
        const group = painted.get(svg);
        if (!group) continue;
        if (group.previousElementSibling !== previous) layer.insertBefore(group, previous?.nextSibling ?? layer.firstChild);
        previous = group;
      }
    };
    syncStructure();

    const observer = new MutationObserver(records => {
      const changed = new Set<SVGSVGElement>();
      let structureChanged = false;
      for (const record of records) {
        if (record.target === edges && record.type === 'childList') {
          structureChanged = true;
          continue;
        }
        const svg = sourceSvg(record.target, edges);
        if (!svg) continue;
        // Ignore the one attribute written by this mirror to avoid a loop.
        if (record.target === svg && record.attributeName === 'data-canvas-single-svg-source') continue;
        changed.add(svg);
      }
      if (structureChanged) syncStructure();
      for (const svg of changed) syncSource(svg);
    });
    observer.observe(edges, { subtree: true, childList: true, attributes: true, characterData: true });
    return () => {
      observer.disconnect();
      for (const svg of painted.keys()) restoreSource(svg);
      layer.remove();
    };
  };

  const refresh = () => {
    detach?.();
    const edges = viewport.querySelector<HTMLElement>(':scope > .react-flow__edges');
    detach = edges ? attach(edges) : undefined;
  };
  refresh();
  const viewportObserver = new MutationObserver(records => {
    if (records.some(record => record.target === viewport && record.type === 'childList' &&
      [...record.addedNodes, ...record.removedNodes].some(node =>
        node instanceof HTMLElement && node.classList.contains('react-flow__edges')))) refresh();
  });
  viewportObserver.observe(viewport, { childList: true });
  return () => {
    viewportObserver.disconnect();
    detach?.();
  };
}
