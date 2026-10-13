// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Music } from 'lucide-react';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { useUpstreamNodes } from '@/features/canvas/application/useUpstreamGraph';
import {
  resolvePromptReferences,
  type PromptReferenceTarget,
} from '@/features/canvas/domain/promptReferences';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { buildMentionRegex } from '@/lib/mention-markers';

/**
 * 提示词里的引用 chip（只读）：缩略图方块 + 「图片N」标签，hover 在上方浮出大图预览。
 *
 * 与工作流节点内的引用 chip 同构（见 nodes/shared/ReferenceTextChip：portal + fixed
 * 定位，绕开祖先的 overflow 裁切），但**刻意不带 detach 角标**——详情是只读展示面。
 */
function PromptReferenceChip({
  target,
  onOpen,
}: {
  target: PromptReferenceTarget;
  onOpen?: (target: PromptReferenceTarget) => void;
}): ReactElement {
  const triggerRef = useRef<HTMLElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const previewUrl = target.thumbnailUrl ? resolveImageDisplayUrl(target.thumbnailUrl) : null;

  const showPreview = () => {
    if (!previewUrl) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 贴着 chip 上沿留 8px；浮层自身 translateY(-100%) 上移。
    setAnchor({ top: rect.top - 8, left: rect.left });
  };

  const clickable = Boolean(onOpen && target.nodeId);
  const Tag = clickable ? 'button' : 'span';

  return (
    <span
      className="relative inline-block align-middle"
      onMouseEnter={showPreview}
      onMouseLeave={() => setAnchor(null)}
    >
      <Tag
        ref={triggerRef as never}
        {...(clickable ? { type: 'button' as const, onClick: () => onOpen?.(target) } : {})}
        aria-label={target.label}
        title={target.label}
        className={`inline-flex items-center gap-1 rounded-[6px] border border-white/15 bg-white/10 py-0.5 pl-0.5 pr-1.5 align-middle text-[12px] leading-4 text-white/85 ${
          clickable ? 'cursor-pointer transition-colors hover:bg-white/20' : ''
        }`}
      >
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={target.label}
            className="h-4 w-4 shrink-0 rounded-[3px] object-cover"
          />
        ) : (
          <Music className="h-3.5 w-3.5 shrink-0 text-white/70" aria-hidden />
        )}
        {target.label}
      </Tag>
      {anchor &&
        previewUrl &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: anchor.top,
              left: anchor.left,
              transform: 'translateY(-100%)',
            }}
            className="pointer-events-none z-[2000] rounded-lg bg-black p-1.5 shadow-[0_10px_24px_rgba(0,0,0,0.45)]"
          >
            <img
              src={previewUrl}
              alt=""
              className="max-h-[220px] max-w-[280px] rounded-[6px] object-contain"
            />
          </div>,
          document.body,
        )}
    </span>
  );
}

interface AssetBoardPromptTextProps {
  node: CanvasNode;
  prompt: string;
  /** 点击 chip 跳到该引用的详情（可选；无 nodeId 的自带参考图不可点）。 */
  onOpenReference?: (target: PromptReferenceTarget) => void;
}

/**
 * 详情面板的提示词正文：把 `@图片N` / `@视频N` / `@音频N` 渲染成带缩略图的只读
 * chip（hover 出大图），其余文本原样展示。
 *
 * - **解析层复用 `buildMentionRegex`**（与工作流 mention-textarea 高亮层、
 *   mentionsToProgramMarkers 解析层同一份）：字典驱动、按标签长度降序匹配，
 *   `@图片1@图片2` 相邻也能各自命中，无需尾随空格。
 * - **编号映射复用 `resolvePromptReferences`**（内部就是工作流的
 *   orderedReferenceUrlsWithOwnFirst / sortUpstreamByReferenceOrder + 分类型计数）。
 * - 字典只包含**当前真的解析得到目标**的标签，所以引用已被删除 / 编号越界的
 *   `@图片9` 天然不匹配，原样显示为纯文本（不渲染空 chip、不报错）。
 */
export function AssetBoardPromptText({
  node,
  prompt,
  onOpenReference,
}: AssetBoardPromptTextProps): ReactElement {
  // 直接复用工作流的 useUpstreamNodes：只订阅本节点一跳上游、按连线顺序，且用
  // useShallow 稳定引用（裸 selector 每次返回新数组会把渲染打进无限循环）。
  const upstreamNodes = useUpstreamNodes(node.id);
  const targets = useMemo(
    () => resolvePromptReferences(node, upstreamNodes),
    [node, upstreamNodes],
  );

  const parts = useMemo<ReactNode[]>(() => {
    const pattern = buildMentionRegex([...targets.keys()]);
    if (!pattern) return [prompt];
    const out: ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(prompt)) !== null) {
      const target = targets.get(match[1]);
      if (!target) continue;
      if (match.index > lastIndex) out.push(prompt.slice(lastIndex, match.index));
      out.push(
        <PromptReferenceChip
          key={`${match.index}-${target.label}`}
          target={target}
          onOpen={onOpenReference}
        />,
      );
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < prompt.length) out.push(prompt.slice(lastIndex));
    return out;
  }, [onOpenReference, prompt, targets]);

  return (
    <p className="whitespace-pre-wrap text-[13px] leading-5 text-white/60">
      {parts.map((part, index) =>
        typeof part === 'string' ? <span key={index}>{part}</span> : part,
      )}
    </p>
  );
}
