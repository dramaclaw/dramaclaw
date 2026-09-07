// SPDX-License-Identifier: Elastic-2.0
import { downloadUrlAsFile } from '@/lib/browserDownload';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { readUrl } from '@/lib/url-params';
import { generateDerivedMedia } from '../application/derivedMedia';
export function DerivedMediaNode({ id, data, selected, type }: NodeProps) {
  const store = useCanvasStore();
  const gif = type === 'animatedGifNode';
  const url = typeof data.imageUrl === 'string' ? data.imageUrl : '';
  const busy = data.isGenerating === true;
  const retry = () => {
    const { project, canvas } = readUrl();
    if (project && !busy)
      void generateDerivedMedia(
        project,
        id,
        gif ? 'gif' : 'svg',
        String(data.sourceImageUrl || ''),
        typeof data.sourceVideoUrl === 'string'
          ? data.sourceVideoUrl
          : undefined,
        canvas,
        (patch) => store.updateNodeData(id, patch),
      );
  };
  return (
    <div
      className={`rounded-xl border bg-surface-panel text-text-primary overflow-hidden ${selected ? 'border-primary' : 'border-border'}`}
      style={{ width: 360 }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="px-3 py-2 text-sm">
        {gif ? '动态图 · GIF' : '矢量图 · SVG'}
      </div>
      {url ? (
        <img
          src={url}
          alt={gif ? '动态图' : '矢量图'}
          className="w-full object-contain"
        />
      ) : (
        <div className="h-48 flex items-center justify-center text-text-muted">
          {busy ? '正在处理…' : '等待生成'}
        </div>
      )}
      {busy && (
        <p className="px-3 py-2 text-xs" role="status">
          {String(data.generationStage || '正在处理')}
        </p>
      )}
      {Boolean(data.generationError) && (
        <p className="px-3 py-2 text-xs text-red-400" role="alert">
          {String(data.generationError)}
        </p>
      )}
      <div className="nodrag flex gap-3 p-3 text-xs">
        {url && (
          <button
            onClick={() =>
              void downloadUrlAsFile(url, gif ? 'animation.gif' : 'vector.svg')
            }
          >
            下载
          </button>
        )}
        <button disabled={busy} onClick={retry}>
          {data.sourceVideoUrl ? '重试转换' : '重新生成'}
        </button>
        <button onClick={() => store.deleteNode(id)}>删除</button>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
