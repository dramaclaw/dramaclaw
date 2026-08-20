// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Images, Palette } from 'lucide-react';

import {
  CANVAS_NODE_TYPES,
  isImageGenNode,
  type StyleNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  DEFAULT_NODE_DISPLAY_NAME,
  resolveNodeDisplayName,
} from '@/features/canvas/domain/nodeDisplay';
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from '@/features/canvas/ui/NodeHeader';
import { StyleAssetImage } from '@/features/canvas/ui/StyleAssetImage';
import {
  StyleGalleryModal,
  describeStyleSelection,
  resolveStyleSelectionState,
  type StyleSelectionState,
} from '@/features/canvas/ui/StyleGalleryModal';
import {
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  canvasNodeFrameClass,
} from '@/features/canvas/ui/nodeFrameStyles';
import { useFreezoneStyleTemplates } from '@/features/canvas/hooks/useFreezoneStyleTemplates';
import { useCanvasStore } from '@/stores/canvasStore';
import { useShallow } from 'zustand/react/shallow';

type StyleNodeProps = NodeProps & {
  id: string;
  data: StyleNodeData;
  selected?: boolean;
};

// 卡片只放封面，不再挂名字行（风格名在节点标题里）。封面是 16:9（720×405），
// 宽度定死后高度就等于封面本身的高度，不按别的比例裁切。
export const STYLE_NODE_WIDTH = 220;
export const STYLE_NODE_HEIGHT = 124;

// 「查不到封面」有四种成因，卡片得说清是哪一种：说成「未选择风格」会让用户以为
// 这个节点是空的，而那个 id 其实还在跟着生成请求走（ready 态不会走到这里）。
const STYLE_NODE_PLACEHOLDER_TEXT: Record<StyleSelectionState, string> = {
  none: '未选择风格',
  ready: '',
  loading: '加载中…',
  failed: '风格清单加载失败，点一下重试',
  missing: '风格已失效，点一下重选',
};

export const StyleNode = memo(({ id, data, selected }: StyleNodeProps) => {
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const {
    templates,
    assetBase,
    isLoading: templatesLoading,
    error: templatesError,
    retry: retryTemplates,
  } = useFreezoneStyleTemplates();
  const templateId =
    typeof data.styleTemplateId === 'string' && data.styleTemplateId.length > 0
      ? data.styleTemplateId
      : null;
  const template = describeStyleSelection(templateId, templates);
  const selectionState = resolveStyleSelectionState(templateId, template, {
    isLoading: templatesLoading,
    hasError: templatesError != null,
  });
  // 打开图墙是明确的用户动作，顺手把上次失败的清单重拉一遍（成功态是空操作）。
  const openGallery = useCallback(() => {
    retryTemplates();
    setGalleryOpen(true);
  }, [retryTemplates]);

  // 真源是下游图片节点的 styleTemplateId —— 本节点只是它的投影，所以换风格先写
  // 下游，再由那边的对账把本节点的数据拉齐（见 styleNodeSync 的模块注释）。
  const downstreamImageNodeIds = useCanvasStore(
    useShallow((state) => {
      const targetIds = state.edges
        .filter((edge) => edge.source === id)
        .map((edge) => edge.target);
      return state.nodes
        .filter((node) => targetIds.includes(node.id) && isImageGenNode(node))
        .map((node) => node.id);
    }),
  );
  const isOrphan = downstreamImageNodeIds.length === 0;

  // 标题跟着选中的风格走：「风格 · 分类 · 风格名」。用户手工改过名（data.displayName
  // 有值）就以用户的为准，别把人家改的名字覆盖回去。
  const resolvedTitle = useMemo(() => {
    const customTitle =
      typeof data.displayName === 'string' ? data.displayName.trim() : '';
    if (customTitle) return customTitle;
    if (!template) return resolveNodeDisplayName(CANVAS_NODE_TYPES.style, data);
    return [
      DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.style],
      template.category,
      template.label,
    ]
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .join(' · ');
  }, [data, template]);
  const cardToneClass = canvasNodeFrameClass({ selected });

  const handleSelectStyle = useCallback(
    (nextId: string | null) => {
      downstreamImageNodeIds.forEach((imageNodeId) => {
        updateNodeData(imageNodeId, { styleTemplateId: nextId });
      });
      setGalleryOpen(false);
    },
    [downstreamImageNodeIds, updateNodeData],
  );

  return (
    <div
      className="group relative h-full w-full overflow-visible"
      style={{ width: STYLE_NODE_WIDTH, height: STYLE_NODE_HEIGHT }}
      onClick={() => setSelectedNode(id)}
    >
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Palette className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(next) => updateNodeData(id, { displayName: next })}
      />

      <div
        role="button"
        tabIndex={0}
        aria-label={template ? `风格 ${template.label}` : '选择风格'}
        aria-disabled={isOrphan}
        onClick={(event) => {
          event.stopPropagation();
          if (isOrphan) return;
          openGallery();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          if (isOrphan) return;
          openGallery();
        }}
        className={`relative flex h-full w-full flex-col overflow-hidden rounded-[var(--node-radius)] border ${CANVAS_NODE_INPUT_SURFACE_CLASS} transition-colors ${cardToneClass} ${
          isOrphan ? 'cursor-default' : 'cursor-pointer'
        }`}
      >
        <div className="relative flex-1 overflow-hidden bg-white/[0.04]">
          {template ? (
            <StyleAssetImage
              rel={template.cover}
              assetBase={assetBase}
              alt={template.label}
              draggable={false}
              className="h-full w-full object-cover"
            />
          ) : (
            <div
              className={`flex h-full w-full items-center justify-center text-[12px] ${
                selectionState === 'failed' || selectionState === 'missing'
                  ? 'text-amber-300/90'
                  : 'text-text-muted/90'
              }`}
            >
              {STYLE_NODE_PLACEHOLDER_TEXT[selectionState]}
            </div>
          )}
        </div>
        {isOrphan && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-center text-[11px] text-text-dark/80">
            未连接图片节点
          </span>
        )}
      </div>

      {/*
        整张封面点下去也能开图墙，但那是个没有任何提示的隐藏交互 —— 右上角这颗按钮
        才是能被看见的入口。放在卡片外面当兄弟节点：卡片本身是 role="button"，按钮
        嵌进去就成了互相嵌套的可交互元素。
      */}
      {!isOrphan && (
        <button
          type="button"
          aria-label="更换风格"
          title="更换风格"
          onClick={(event) => {
            event.stopPropagation();
            openGallery();
          }}
          className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-md bg-black/55 text-text-dark opacity-0 transition-opacity hover:bg-black/75 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Images className="size-4" />
        </button>
      )}

      {galleryOpen && (
        <StyleGalleryModal
          templates={templates}
          assetBase={assetBase}
          selectedId={templateId}
          isLoading={templatesLoading}
          onSelect={handleSelectStyle}
          onClose={() => setGalleryOpen(false)}
        />
      )}
    </div>
  );
});

StyleNode.displayName = 'StyleNode';
