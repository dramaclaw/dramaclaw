// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { MainlineContext } from '@/features/freezone/context/mainlineContext';

interface Props {
  /** Resolved mainline contexts for this node (from `collectNodeMainlineContexts`). */
  mainlineContexts: MainlineContext[];
  /** Workflow id this node will execute, e.g. `beat_to_sketch`, `sketch_to_frame`. */
  workflowDefaultId?: string;
  /** Optional extra className for layout tuning at call sites. */
  className?: string;
}

// 把 workflow_default_id 映射到 (短词, commit 后晋升的节点 id)。
//
// **必须跟 `SuperTale/src/novelvideo/freezone/presets.py` 里实际 emit 的
// `workflow_default_id=...` 完全对齐**(line 3603/3628/3653/3678/3703 附近)。
// 用 exact-match 字典而非前缀/后缀模糊匹配 — preset 改名时立刻 silent miss
// 而不是误匹配到错的槽位文案。
//
// `promotedNode` 对应 preset 里 ref 节点的 role(`_node_mainline_context_from_ref`
// 里 `current_sketch` / `current_frame` 等),commit 后下次 canvas reload
// 会以该 role 长出独立 asset 节点。
interface SlotMapping {
  /** 短词的词条 key —— 「草图」「分镜」这类要跟界面语言走。 */
  candidateKey: string;
  promotedNode: string;
}
const SLOT_MAPPING_BY_WORKFLOW: Record<string, SlotMapping> = {
  beat_to_sketch: { candidateKey: 'canvas.commitHint.sketch', promotedNode: 'current_sketch' },
  selected_background_to_sketch: {
    candidateKey: 'canvas.commitHint.sketch',
    promotedNode: 'current_sketch',
  },
  director_combined_to_sketch: {
    candidateKey: 'canvas.commitHint.sketch',
    promotedNode: 'current_sketch',
  },
  sketch_to_frame: { candidateKey: 'canvas.commitHint.frame', promotedNode: 'current_frame' },
  background_sketch_to_frame: {
    candidateKey: 'canvas.commitHint.frame',
    promotedNode: 'current_frame',
  },
};

function deriveSlotMapping(workflowDefaultId?: string): SlotMapping | null {
  if (!workflowDefaultId) return null;
  return SLOT_MAPPING_BY_WORKFLOW[workflowDefaultId] ?? null;
}

/**
 * Inline hint that tells the user what category of product a generation node
 * will produce. Three states:
 *
 * 1. "typed mainline candidate" — node has a beat-context binding AND its
 *    workflow has a known slot kind (sketch / frame / director_render / etc.).
 *    Commit can propose a default target.
 * 2. "untyped mainline candidate" — beat context binding but no resolvable
 *    slot kind. Commit will treat it as a mainline candidate, target picked
 *    at commit time.
 * 3. "free candidate" — no beat-context binding. User must choose target.
 *
 * The hint never auto-commits; it only labels what is about to be produced so
 * the user knows whether to expect the typed-mainline confirm path or the
 * generic "pick a target" path. See
 * `docs/mainline_canvas_projection_architecture.md` §Commit Boundary.
 */
export function CommitTargetHint({
  mainlineContexts,
  workflowDefaultId,
  className,
}: Props) {
  const { t } = useTranslation();
  const hint = useMemo(() => {
    const beatCtx = mainlineContexts.find((ctx) => ctx.kind === 'beat');
    const slotMapping = deriveSlotMapping(workflowDefaultId);
    if (beatCtx && typeof beatCtx.episode === 'number' && typeof beatCtx.beat === 'number') {
      if (slotMapping) {
        // 关键:主线技能节点是 trigger+display 一体,产物先落在本节点 imageUrl,
        // 没有下游的"分镜节点"。commit 之后 mainline DB 才生成 `current_xxx`
        // 资产 — 下次打开 canvas 才会看到独立的 asset 节点。
        return {
          variant: 'typed' as const,
          text: t('canvas.commitHint.typed', {
            episode: beatCtx.episode,
            beat: beatCtx.beat,
            candidate: t(slotMapping.candidateKey),
            promoted: slotMapping.promotedNode,
          }),
        };
      }
      return {
        variant: 'untyped' as const,
        text: t('canvas.commitHint.untyped', {
          episode: beatCtx.episode,
          beat: beatCtx.beat,
        }),
      };
    }
    return {
      variant: 'free' as const,
      text: t('canvas.commitHint.free'),
    };
  }, [mainlineContexts, t, workflowDefaultId]);

  const variantClass =
    hint.variant === 'typed'
      ? 'border-amber-300/35 bg-amber-300/12 text-amber-100'
      : hint.variant === 'untyped'
        ? 'border-amber-300/20 bg-amber-300/6 text-amber-50/85'
        : 'border-white/10 bg-black/20 text-text-muted';

  return (
    <div
      className={`shrink-0 rounded-md border px-2 py-1 text-[10px] leading-tight ${variantClass} ${className ?? ''}`}
      title={t('canvas.commitHint.title')}
    >
      {hint.text}
    </div>
  );
}
