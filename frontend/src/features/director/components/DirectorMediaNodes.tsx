// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { moveDirectorMediaNode, type DirectorMediaNode, type DirectorMediaKind } from '@/api/director';
import { useDirectorMedia } from '../useDirectorMedia';
import { DirectorReferenceIcon } from './DirectorReferenceIcon';

export function DirectorMediaNodes({ project, work, onPlan }: { project: string; work: string; onPlan: (kind: DirectorMediaKind) => void }) {
  const { t } = useTranslation();
  const { batches, outcomes, error } = useDirectorMedia(project, work);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number; version?: number }>>({});
  const [moveError, setMoveError] = useState('');
  const drag = useRef<{ node: DirectorMediaNode; x: number; y: number; zoom: number } | null>(null);
  const pending = useRef(new Set<string>());
  const nodes = batches.flatMap(b => b.nodes);
  useEffect(() => {
    setPositions(previous => {
      const next = { ...previous }; let changed = false;
      for (const node of batches.flatMap(b => b.nodes)) {
        if (next[node.id]?.version && node.version >= next[node.id].version!) { delete next[node.id]; changed = true; }
      }
      return changed ? next : previous;
    });
  }, [batches]);
  const finish = async (node: DirectorMediaNode, clientX: number, clientY: number) => {
    const d = drag.current; drag.current = null;
    if (!d || d.node.id !== node.id) return;
    const x = d.node.x + (clientX - d.x) / d.zoom, y = d.node.y + (clientY - d.y) / d.zoom;
    if (x === d.node.x && y === d.node.y) return;
    pending.current.add(node.id);
    try {
      const saved = await moveDirectorMediaNode(project, work, d.node, x, y);
      setPositions(p => ({ ...p, [node.id]: { x, y, version: saved.version } }));
      setMoveError('');
    } catch (reason) {
      setMoveError(String(reason));
      setPositions(p => { const copy = { ...p }; delete copy[node.id]; return copy; });
    } finally { pending.current.delete(node.id); }
  };
  return <div className="dc-media-node-layer">
    {(error || moveError) && <p role="alert" className="dc-media-node-error">{error || moveError}</p>}
    {nodes.map(node => {
      const point = positions[node.id] ?? node, outcome = outcomes[node.id];
      const asset = node.intent.request.source.asset;
      const ratio = String(node.intent.request.actual.aspect_ratio).split(':').map(Number);
      const aspectRatio = ratio.length === 2 && ratio.every(v => v > 0 && Number.isFinite(v)) ? `${ratio[0]} / ${ratio[1]}` : '1 / 1';
      return <article key={node.id} className="dc-media-node" data-node-id={node.id} style={{ left: point.x, top: point.y }} aria-label={asset.name}>
        <header onPointerDown={event => {
          if (event.button !== 0 || pending.current.has(node.id)) return;
          event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
          const layer = event.currentTarget.closest('.dc-canvas-transform');
          const scale = layer ? new DOMMatrix(getComputedStyle(layer).transform).a : 1;
          drag.current = { node: { ...node, ...point }, x: event.clientX, y: event.clientY, zoom: scale || 1 };
        }} onPointerMove={event => { const d = drag.current; if (d?.node.id === node.id) setPositions(p => ({ ...p, [node.id]: { x: d.node.x + (event.clientX - d.x) / d.zoom, y: d.node.y + (event.clientY - d.y) / d.zoom } })); }}
          onPointerUp={event => void finish(node, event.clientX, event.clientY)} onPointerCancel={() => { drag.current = null; setPositions(p => { const copy = { ...p }; delete copy[node.id]; return copy; }); }}>
          <DirectorReferenceIcon name="Style" size={16} /><span>{node.ordinal + 1}. {asset.name}</span>
        </header>
        <button type="button" className="dc-media-node-image" style={{ aspectRatio }} onClick={() => onPlan(node.intent.request.source.kind)} aria-label={t('director.media.batch.inspect', { name: asset.name })}>
          {outcome?.url ? <img src={outcome.url} alt={asset.name} /> : <DirectorReferenceIcon name="Style" size={32} />}
          <span>{t(`director.media.status.${outcome?.status ?? node.intent.status}`)}</span>
        </button>
        <small>{node.intent.request.modelLabel} · {String(node.intent.request.actual.aspect_ratio)} · {String(node.intent.request.actual.image_size)}</small>
        {outcome?.url && <a href={outcome.url} target="_blank" rel="noreferrer">{t('director.media.download')}</a>}
      </article>;
    })}
  </div>;
}
