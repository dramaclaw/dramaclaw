// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Sparkles } from 'lucide-react';

import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import type { SkillDefinition, SkillProvider } from '@/features/freezone/context/skillRoles';
import {
  translateSkillDescription,
  translateSkillName,
  translateSkillProviderLabel,
} from '@/features/freezone/context/skillI18n';
import {
  CanvasAddNodeGrid,
  CanvasMenuSectionHeader,
  CANVAS_MENU_ROW_CLASS,
} from '@/features/canvas/ui/canvas-node-menu-shared';

const skillProviderOrder: SkillProvider[] = ['freezone_mainline', 'agent', 'tool', 'workflow'];
const hiddenSkillIds = new Set(['agent.review_frame', 'workflow.plan_beat_graph']);
const SKILL_PANEL_CLOSE_DELAY_MS = 40;

interface CanvasAddNodePanelProps {
  skillItems: SkillDefinition[];
  onSelectNode: (type: CanvasNodeType) => void;
  onSelectSkill: (skill: SkillDefinition) => void;
  onClose: () => void;
}

export function CanvasAddNodePanel({
  skillItems,
  onSelectNode,
  onSelectSkill,
  onClose,
}: CanvasAddNodePanelProps) {
  const { t } = useTranslation();
  const [activeSkillProvider, setActiveSkillProvider] = useState<SkillProvider | null>(null);
  const panelRootRef = useRef<HTMLDivElement>(null);
  const skillRowsRef = useRef<HTMLDivElement>(null);
  const skillPanelRef = useRef<HTMLDivElement>(null);
  const skillPanelCloseTimerRef = useRef<number | null>(null);

  const skillGroups = useMemo(() => {
    if (!skillItems || skillItems.length === 0) {
      return [];
    }
    const byProvider = new Map<SkillProvider, SkillDefinition[]>();
    for (const provider of skillProviderOrder) {
      byProvider.set(provider, []);
    }
    for (const skill of skillItems) {
      if (hiddenSkillIds.has(skill.id)) {
        continue;
      }
      byProvider.get(skill.provider)?.push(skill);
    }
    return skillProviderOrder
      .map((provider) => ({ provider, items: byProvider.get(provider) ?? [] }))
      .filter((group) => group.items.length > 0);
  }, [skillItems]);

  const activeSkillGroup = useMemo(() => {
    if (!activeSkillProvider) {
      return null;
    }
    return skillGroups.find((group) => group.provider === activeSkillProvider) ?? null;
  }, [activeSkillProvider, skillGroups]);

  const handlePickNode = (type: CanvasNodeType) => {
    onSelectNode(type);
    onClose();
  };

  const handlePickSkill = (skill: SkillDefinition) => {
    onSelectSkill(skill);
    onClose();
  };

  const cancelSkillPanelClose = useCallback(() => {
    if (skillPanelCloseTimerRef.current !== null) {
      window.clearTimeout(skillPanelCloseTimerRef.current);
      skillPanelCloseTimerRef.current = null;
    }
  }, []);

  const scheduleSkillPanelClose = useCallback(() => {
    cancelSkillPanelClose();
    skillPanelCloseTimerRef.current = window.setTimeout(() => {
      setActiveSkillProvider(null);
      skillPanelCloseTimerRef.current = null;
    }, SKILL_PANEL_CLOSE_DELAY_MS);
  }, [cancelSkillPanelClose]);

  useEffect(() => {
    return () => {
      cancelSkillPanelClose();
    };
  }, [cancelSkillPanelClose]);

  useEffect(() => {
    if (!activeSkillProvider) {
      return;
    }

    const isPointInside = (element: HTMLElement | null, x: number, y: number) => {
      if (!element) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    const handlePointerMove = (event: PointerEvent) => {
      // 只有停在技能行列表或右侧弹窗上才保持打开；滑到主面板里的其它菜单项
      // (节点网格等)应当关闭弹窗，而不是因为「还在主面板内」就一直挂着。
      const insideSkillRows = isPointInside(skillRowsRef.current, event.clientX, event.clientY);
      const insideSkillPanel = isPointInside(skillPanelRef.current, event.clientX, event.clientY);
      if (insideSkillRows || insideSkillPanel) {
        cancelSkillPanelClose();
        return;
      }
      scheduleSkillPanelClose();
    };

    document.addEventListener('pointermove', handlePointerMove, true);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove, true);
    };
  }, [activeSkillProvider, cancelSkillPanelClose, scheduleSkillPanelClose]);

  return (
    <div
      ref={panelRootRef}
      className="relative"
      onPointerEnter={cancelSkillPanelClose}
      onPointerLeave={scheduleSkillPanelClose}
    >
      <div
        className="w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] border border-white/[0.10] bg-[#101217]/72 backdrop-blur-2xl"
      >
        <div className="ui-scrollbar max-h-[min(560px,70vh)] overflow-y-auto px-5 py-5 [scrollbar-gutter:stable]">
          <CanvasMenuSectionHeader label={t('node.menu.sectionAddNode')} className="pb-4" />
          <CanvasAddNodeGrid onSelectNode={handlePickNode} />

          {skillGroups.length > 0 && (
            <>
              <CanvasMenuSectionHeader label={t('node.menu.sectionSkillNode')} className="pb-3 pt-5" />
              <div ref={skillRowsRef}>
                {skillGroups.map((group) => (
                  <div key={group.provider}>
                    <button
                      type="button"
                      className={`${CANVAS_MENU_ROW_CLASS} hover:bg-white/[0.075] ${
                        activeSkillProvider === group.provider ? 'bg-white/[0.075]' : ''
                      }`}
                      onMouseEnter={() => {
                        cancelSkillPanelClose();
                        setActiveSkillProvider(group.provider);
                      }}
                      onFocus={() => {
                        cancelSkillPanelClose();
                        setActiveSkillProvider(group.provider);
                      }}
                      onClick={() => setActiveSkillProvider(group.provider)}
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cyan-300/[0.12]">
                        <Sparkles className="h-4 w-4 text-cyan-200" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] leading-5 text-white/82">
                          {translateSkillProviderLabel(group.provider, t)}
                        </div>
                        <div className="text-[11px] leading-4 text-white/35">
                          {t('canvas.addNodePanel.skillCount', { count: group.items.length })}
                        </div>
                      </div>
                      <ChevronRight
                        className="h-4 w-4 shrink-0 text-white/35"
                      />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {activeSkillGroup && (
        <div
          ref={skillPanelRef}
          className="absolute left-[calc(100%+8px)] top-0 w-[420px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] border border-white/[0.10] bg-[#101217]/85 shadow-2xl backdrop-blur-2xl"
          onPointerEnter={cancelSkillPanelClose}
          onPointerLeave={scheduleSkillPanelClose}
        >
          <div className="px-5 pb-3 pt-5 text-[15px] font-semibold leading-none text-white/62">
            {translateSkillProviderLabel(activeSkillGroup.provider, t)}
          </div>
          <div className="ui-scrollbar max-h-[420px] overflow-y-auto px-3 pb-4 [scrollbar-gutter:stable]">
            {activeSkillGroup.items.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className="flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
                onClick={() => handlePickSkill(skill)}
              >
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-300/[0.12]">
                  <Sparkles className="h-4 w-4 text-cyan-200" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] leading-5 text-white/82">
                    {translateSkillName(skill, t)}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-white/35">
                    {translateSkillDescription(skill, t) || skill.id}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
