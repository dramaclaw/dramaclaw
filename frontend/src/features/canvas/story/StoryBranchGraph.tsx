import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, CirclePlay, Crosshair, Flag, LockKeyhole, Maximize, Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { ExplorationNode, StoryExploration } from './storyExploration';
import { EXPLORATION_NODE_HEIGHT, EXPLORATION_NODE_WIDTH, layoutExplorationGraph } from './layoutExplorationGraph';

export function StoryBranchGraph({ nodes, exploration, currentNodeId, selected, onSelect, onClear, onRewind, t }: {
  nodes: ExplorationNode[];
  exploration: StoryExploration;
  currentNodeId: string | null;
  selected: string | null;
  onSelect: (nodeId: string) => void;
  onClear: () => void;
  onRewind: (nodeId: string) => void;
  t: (key: string, values?: Record<string, unknown>) => string;
}) {
  const graph = useMemo(() => layoutExplorationGraph(nodes), [nodes]);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const pendingCenter = useRef<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const [panning, setPanning] = useState(false);
  const markerId = useId();
  const [confirmClear, setConfirmClear] = useState(false);
  const clearButton = useRef<HTMLButtonElement>(null);
  const dismissClear = () => { setConfirmClear(false); clearButton.current?.focus(); };
  const completed = new Set(exploration.completedNodeIds);
  const route = new Set(exploration.route.map((step) => step.nodeId));
  const routeEdges = new Set(exploration.route.slice(1).map((step, index) => JSON.stringify([exploration.route[index].nodeId, step.nodeId])));
  const label = (key: string) => t(`canvas.story.exploration.${key}`);

  function centerOnNode(nodeId: string | null) {
    const position = nodeId ? graph.positions.get(nodeId) : null;
    const element = viewport.current;
    if (!position || !element) return;
    element.scrollLeft = Math.max(0, (position.x + EXPLORATION_NODE_WIDTH / 2) * zoomRef.current - element.clientWidth / 2);
    element.scrollTop = Math.max(0, (position.y + EXPLORATION_NODE_HEIGHT / 2) * zoomRef.current - element.clientHeight / 2);
  }
  useLayoutEffect(() => {
    centerOnNode(currentNodeId);
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => centerOnNode(currentNodeId));
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph, currentNodeId]);
  useLayoutEffect(() => {
    const element = viewport.current;
    const center = pendingCenter.current;
    if (!element || !center) return;
    element.scrollLeft = Math.max(0, center.x * zoom - element.clientWidth / 2);
    element.scrollTop = Math.max(0, center.y * zoom - element.clientHeight / 2);
    pendingCenter.current = null;
  }, [zoom]);
  function changeZoom(next: number) {
    const element = viewport.current;
    if (element) pendingCenter.current = {
      x: (element.scrollLeft + element.clientWidth / 2) / zoom,
      y: (element.scrollTop + element.clientHeight / 2) / zoom,
    };
    setZoom(Math.max(0.1, Math.min(2, next)));
  }
  function locateCurrent() {
    const position = currentNodeId ? graph.positions.get(currentNodeId) : null;
    if (!position) return;
    if (zoom === 1) centerOnNode(currentNodeId);
    else {
      pendingCenter.current = { x: position.x + EXPLORATION_NODE_WIDTH / 2, y: position.y + EXPLORATION_NODE_HEIGHT / 2 };
      setZoom(1);
    }
  }
  function fitAll() {
    const element = viewport.current;
    if (!element) return;
    pendingCenter.current = { x: graph.width / 2, y: graph.height / 2 };
    setZoom(Math.max(0.1, Math.min(1, element.clientWidth / graph.width, element.clientHeight / graph.height)));
    element.scrollLeft = 0;
    element.scrollTop = 0;
  }
  return <div className="story-branch-graph">
    <div className="story-graph-controls">
      <div className="story-graph-legend" aria-label={label('map')}>
        <span data-current="true"><CirclePlay size={14} />{label('current')}</span>
        <span><Check size={14} />{label('unlocked')}</span>
        <span><LockKeyhole size={14} />{label('unexplored')}</span>
      </div>
      <div className="story-graph-tools">
        <div className="story-graph-tool-group">
          <button type="button" disabled={zoom <= 0.1} onClick={() => changeZoom(zoom / 1.25)} aria-label={label('zoomOut')} title={label('zoomOut')}><Minus size={16} /></button>
          <output aria-label={label('zoom')}>{Math.round(zoom * 100)}%</output>
          <button type="button" disabled={zoom >= 2} onClick={() => changeZoom(zoom * 1.25)} aria-label={label('zoomIn')} title={label('zoomIn')}><Plus size={16} /></button>
        </div>
        <div className="story-graph-tool-group">
          <button type="button" onClick={fitAll} aria-label={label('fitGraph')} title={label('fitGraph')}><Maximize size={16} /><span>{label('fitGraph')}</span></button>
          <button type="button" onClick={locateCurrent} disabled={!currentNodeId} aria-label={label('locateCurrent')} title={label('locateCurrent')}><Crosshair size={16} /><span>{label('locateCurrent')}</span></button>
        </div>
        <button ref={clearButton} className="story-graph-clear" type="button" onClick={() => setConfirmClear((open) => !open)}
          aria-label={label('clear')} title={label('clear')} aria-expanded={confirmClear}><Trash2 size={16} /></button>
        {confirmClear && <section className="story-graph-clear-confirmation" aria-label={label('clearConfirm')}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissClear(); } }}>
          <p>{label('clearConfirm')}</p>
          <div className="story-exploration-confirm-buttons">
            <button type="button" autoFocus onClick={dismissClear}>{label('cancel')}</button>
            <button type="button" onClick={onClear}>{label('clear')}</button>
          </div>
        </section>}
      </div>
    </div>
    <div ref={viewport} className="story-graph-viewport" role="region" aria-label={label('map')} tabIndex={0} data-panning={panning}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.pointerType !== 'mouse' || (event.target as Element).closest('button')) return;
        const element = event.currentTarget;
        drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
        element.setPointerCapture(event.pointerId);
        element.focus();
        event.preventDefault();
        setPanning(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
        event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
      }}
      onPointerUp={() => { drag.current = null; setPanning(false); }}
      onPointerCancel={() => { drag.current = null; setPanning(false); }}>
      <div className="story-graph-world" style={{ width: graph.width * zoom, height: graph.height * zoom }}>
        <div className="story-graph-content" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}>
          <svg aria-hidden="true" width={graph.width} height={graph.height}>
            <defs>
              <marker id={`${markerId}-normal`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" className="story-graph-arrow" /></marker>
              <marker id={`${markerId}-route`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" className="story-graph-arrow-route" /></marker>
            </defs>
            {graph.edges.map((edge) => <path key={edge.id} data-story-graph-edge={edge.id} data-route={routeEdges.has(edge.id)}
              d={edge.path} fill="none" strokeWidth={2} markerEnd={`url(#${markerId}-${routeEdges.has(edge.id) ? 'route' : 'normal'})`} />)}
          </svg>
          {graph.edges.filter((edge) => edge.text).map((edge) => <span key={edge.id}
            className="story-graph-choice" data-route={routeEdges.has(edge.id)} title={edge.text}
            style={{ left: edge.labelX, top: edge.labelY }}>{edge.text}</span>)}
          {nodes.map((node, index) => {
            const position = graph.positions.get(node.id)!;
            const unlocked = completed.has(node.id);
            const current = currentNodeId === node.id;
            const text = node.label || t('canvas.story.exploration.segment', { number: index + 1 });
            const status = current ? label('current') : unlocked ? label('unlocked') : label('unexplored');
            const ending = node.isEnding ? t('canvas.story.tree.ending') : null;
            return <div key={node.id} className="story-graph-node" data-unlocked={unlocked}
              data-current={current} data-route={route.has(node.id)} data-selected={selected === node.id}
              style={{ left: position.x, top: position.y, width: EXPLORATION_NODE_WIDTH, height: EXPLORATION_NODE_HEIGHT }}>
              <button type="button" className="story-graph-node-select" disabled={!unlocked} aria-pressed={selected === node.id}
              aria-label={`${text} · ${ending ? `${ending} · ` : ''}${status}`} title={text} onClick={() => onSelect(node.id)}
              >
                {current ? <CirclePlay size={18} aria-hidden="true" /> : !unlocked ? <LockKeyhole size={16} aria-hidden="true" /> : node.isEnding ? <Flag size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                <span className="story-graph-node-copy"><strong>{text}</strong><small>{status}{ending && ` · ${ending}`}</small></span>
              </button>
              {unlocked && selected === node.id && <div className="story-graph-node-actions">
                <button type="button" className="story-graph-replay" disabled={!exploration.checkpoints[node.id]}
                  title={label('rewindHint')} onClick={() => onRewind(node.id)}><RotateCcw size={14} />{label('replay')}</button>
              </div>}
            </div>;
          })}
        </div>
      </div>
    </div>
    <p className="story-graph-hint">{label('mapHint')}</p>
  </div>;
}
