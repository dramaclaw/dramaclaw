// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { AudioLines, Image as ImageIcon, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LiblibMediaNodeData } from '../domain/canvasNodes';
import './liblibMediaNode.css';

type LiblibNode = Node<LiblibMediaNodeData, 'liblibMediaNode'>;

export function LiblibMediaNode({ data, selected, width, height }: NodeProps<LiblibNode>) {
  const { t } = useTranslation();
  const size = {
    width: width ?? (data.mediaKind === 'audio' ? 350 : 622),
    height: height ?? (data.mediaKind === 'audio' ? 148 : 350),
  };
  const source = data.localUrl ?? data.sourceUrl;
  const Icon = data.mediaKind === 'image' ? ImageIcon : data.mediaKind === 'video' ? Video : AudioLines;

  return (
    <div className={`liblib-media-node${selected ? ' liblib-media-node--selected' : ''}`} style={size}>
      <Handle type="target" position={Position.Left} id="target" />
      <Handle type="source" position={Position.Right} id="source" />
      <div className="liblib-media-node__header">
        <Icon aria-hidden className="liblib-media-node__icon" />
        <span className="liblib-media-node__title" title={data.displayName}>
          {data.displayName || t('node.displayName.liblibMediaNode')}
        </span>
      </div>
      <div className="liblib-media-node__body">
        {data.mediaKind === 'image' && source && (
          <img src={source} alt={data.displayName || ''} loading="lazy" draggable={false} />
        )}
        {data.mediaKind === 'video' && source && (
          <video src={source} poster={data.posterUrl ?? undefined} controls preload="metadata" playsInline />
        )}
        {data.mediaKind === 'audio' && source && (
          <audio src={source} controls preload="metadata" />
        )}
        {(!source || data.mediaKind === 'other') && (
          <span className="liblib-media-node__empty">
            {data.displayName || t('node.displayName.liblibMediaNode')}
          </span>
        )}
      </div>
    </div>
  );
}

LiblibMediaNode.displayName = 'LiblibMediaNode';
