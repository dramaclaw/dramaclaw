// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  FileText,
  Globe,
  Image,
  Music,
  Orbit,
  Sparkles,
  Video,
  Type,
} from 'lucide-react';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';

import {
  CANVAS_NODE_TYPES,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import type { SkillDefinition, SkillProvider } from '@/features/freezone/context/skillRoles';
import {
  translateSkillDescription,
  translateSkillName,
  translateSkillProviderLabel,
} from '@/features/freezone/context/skillI18n';
import {
  CanvasAddNodeGrid,
  CanvasMenuSectionHeader,
  CANVAS_MENU_ICON_CELL_CLASS,
  CANVAS_MENU_ROW_CLASS,
} from '@/features/canvas/ui/canvas-node-menu-shared';

interface NodeSelectionMenuProps {
  position: { x: number; y: number };
  allowedTypes?: CanvasNodeType[];
  onSelect: (type: CanvasNodeType, clientPosition?: { x: number; y: number }) => void;
  skillItems?: SkillDefinition[];
  onSelectSkill?: (skill: SkillDefinition) => void;
  onClose: () => void;
}

const skillProviderOrder: SkillProvider[] = ['freezone_mainline', 'agent', 'tool', 'workflow'];

const hiddenSkillIds = new Set(['agent.review_frame', 'workflow.plan_beat_graph']);

const SKILL_PANEL_CLOSE_DELAY_MS = 40;
const MENU_VIEWPORT_MARGIN = 12;
const SKILL_PANEL_GAP = 8;

interface ReferenceGenerateAction {
  key: string;
  label: string;
  Icon: typeof Image;
  type?: CanvasNodeType;
  disabled?: boolean;
  beta?: boolean;
}

export function NodeSelectionMenu({
  position,
  allowedTypes,
  onSelect,
  skillItems,
  onSelectSkill,
  onClose,
}: NodeSelectionMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const mainPanelRef = useRef<HTMLDivElement>(null);
  const skillPanelRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isPositioned, setIsPositioned] = useState(false);
  const [panelPosition, setPanelPosition] = useState(position);
  const [skillPanelSide, setSkillPanelSide] = useState<'left' | 'right'>('right');
  const [activeSkillProvider, setActiveSkillProvider] = useState<SkillProvider | null>(null);
  const skillPanelCloseTimerRef = useRef<number | null>(null);

  const allowedTypeSet = useMemo(
    () => (allowedTypes ? new Set(allowedTypes) : null),
    [allowedTypes]
  );

  const referenceGenerateItems = useMemo<ReferenceGenerateAction[] | null>(() => {
    if (!allowedTypeSet) {
      return null;
    }

    const items: ReferenceGenerateAction[] = [
      {
        key: 'text',
        label: '文本',
        Icon: Type,
        type: allowedTypeSet.has(CANVAS_NODE_TYPES.textAnnotation)
          ? CANVAS_NODE_TYPES.textAnnotation
          : undefined,
        disabled: !allowedTypeSet.has(CANVAS_NODE_TYPES.textAnnotation),
      },
      {
        key: 'image',
        label: '图片',
        Icon: Image,
        // 创建顺序：imageGen（默认生成节点） → imageEdit（编辑节点） →
        // upload（纯上传节点，目标端创建参考图时用）。
        type: allowedTypeSet.has(CANVAS_NODE_TYPES.imageGen)
          ? CANVAS_NODE_TYPES.imageGen
          : allowedTypeSet.has(CANVAS_NODE_TYPES.imageEdit)
            ? CANVAS_NODE_TYPES.imageEdit
            : allowedTypeSet.has(CANVAS_NODE_TYPES.upload)
              ? CANVAS_NODE_TYPES.upload
              : undefined,
        disabled:
          !allowedTypeSet.has(CANVAS_NODE_TYPES.imageGen)
          && !allowedTypeSet.has(CANVAS_NODE_TYPES.imageEdit)
          && !allowedTypeSet.has(CANVAS_NODE_TYPES.upload),
      },
      {
        key: 'video',
        label: '视频',
        Icon: Video,
        type: allowedTypeSet.has(CANVAS_NODE_TYPES.video)
          ? CANVAS_NODE_TYPES.video
          : undefined,
        disabled: !allowedTypeSet.has(CANVAS_NODE_TYPES.video),
      },
      {
        key: 'audio',
        label: '音频',
        Icon: Music,
        type: allowedTypeSet.has(CANVAS_NODE_TYPES.audio)
          ? CANVAS_NODE_TYPES.audio
          : undefined,
        disabled: !allowedTypeSet.has(CANVAS_NODE_TYPES.audio),
      },
      {
        key: 'script',
        label: '脚本',
        Icon: FileText,
        type: allowedTypeSet.has(CANVAS_NODE_TYPES.script)
          ? CANVAS_NODE_TYPES.script
          : undefined,
        disabled: !allowedTypeSet.has(CANVAS_NODE_TYPES.script),
      },
      {
        key: 'pano360',
        label: '360° 全景',
        Icon: Globe,
        type: allowedTypeSet.has(CANVAS_NODE_TYPES.pano360Viewer)
          ? CANVAS_NODE_TYPES.pano360Viewer
          : undefined,
        disabled: !allowedTypeSet.has(CANVAS_NODE_TYPES.pano360Viewer),
      },
      {
        key: 'threeDWorld',
        label: '3D 世界',
        Icon: Orbit,
        type: allowedTypeSet.has(CANVAS_NODE_TYPES.threeDWorld)
          ? CANVAS_NODE_TYPES.threeDWorld
          : undefined,
        disabled: !allowedTypeSet.has(CANVAS_NODE_TYPES.threeDWorld),
        beta: true,
      },
    ];

    const enabled = items.filter((item) => !item.disabled && item.type);
    return enabled.length > 0 ? enabled : null;
  }, [allowedTypeSet]);

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

  useEffect(() => {
    if (skillGroups.length === 0) {
      setActiveSkillProvider(null);
      return;
    }
    // Drop a stale selection (the provider list changed and the previously
    // active one is no longer here), but do NOT auto-select the first group:
    // the menu should open with no skill group expanded — the right panel
    // only appears once the user hovers or clicks a group on the left.
    if (
      activeSkillProvider &&
      !skillGroups.some((group) => group.provider === activeSkillProvider)
    ) {
      setActiveSkillProvider(null);
    }
  }, [activeSkillProvider, skillGroups]);

  useEffect(() => {
    requestAnimationFrame(() => {
      setIsVisible(true);
    });
  }, []);

  useLayoutEffect(() => {
    const menuElement = menuRef.current;
    const mainPanelElement = mainPanelRef.current;
    const viewportElement = menuElement?.offsetParent as HTMLElement | null;
    if (!menuElement || !mainPanelElement || !viewportElement) {
      return;
    }

    const mainWidth = mainPanelElement.offsetWidth;
    const mainHeight = mainPanelElement.offsetHeight;
    const viewportWidth = viewportElement.clientWidth;
    const viewportHeight = viewportElement.clientHeight;
    const maxX = Math.max(MENU_VIEWPORT_MARGIN, viewportWidth - mainWidth - MENU_VIEWPORT_MARGIN);
    const maxY = Math.max(MENU_VIEWPORT_MARGIN, viewportHeight - mainHeight - MENU_VIEWPORT_MARGIN);
    const nextX = Math.min(Math.max(position.x, MENU_VIEWPORT_MARGIN), maxX);
    const nextY = Math.min(Math.max(position.y, MENU_VIEWPORT_MARGIN), maxY);
    const skillPanelWidth = skillPanelRef.current?.offsetWidth ?? 0;
    const hasSpaceOnRight =
      !activeSkillProvider ||
      nextX + mainWidth + SKILL_PANEL_GAP + skillPanelWidth <= viewportWidth - MENU_VIEWPORT_MARGIN;
    const hasSpaceOnLeft =
      activeSkillProvider &&
      nextX - SKILL_PANEL_GAP - skillPanelWidth >= MENU_VIEWPORT_MARGIN;

    setPanelPosition((current) => (
      current.x === nextX && current.y === nextY ? current : { x: nextX, y: nextY }
    ));
    setSkillPanelSide(hasSpaceOnRight || !hasSpaceOnLeft ? 'right' : 'left');
    setIsPositioned(true);
  }, [activeSkillProvider, position.x, position.y]);

  const handleClose = useCallback(() => {
    setIsVisible(false);
    setTimeout(onClose, UI_POPOVER_TRANSITION_MS);
  }, [onClose]);

  const handleSkillPick = useCallback(
    (skill: SkillDefinition) => {
      if (!onSelectSkill) {
        return;
      }
      onSelectSkill(skill);
      handleClose();
    },
    [handleClose, onSelectSkill],
  );

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
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }

      handleClose();
    };

    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [handleClose]);

  useEffect(() => {
    if (!activeSkillProvider) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      scheduleSkillPanelClose();
    };

    document.addEventListener('pointermove', onPointerMove, true);
    return () => {
      document.removeEventListener('pointermove', onPointerMove, true);
    };
  }, [activeSkillProvider, scheduleSkillPanelClose]);

  return (
    <div
      ref={menuRef}
      onPointerLeave={scheduleSkillPanelClose}
      onPointerEnter={cancelSkillPanelClose}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      className={`
        absolute z-50
        transition-opacity duration-150
        ${isVisible && isPositioned ? 'opacity-100' : 'opacity-0'}
      `}
      style={{ left: panelPosition.x, top: panelPosition.y }}
    >
      <div
        ref={mainPanelRef}
        className="w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] border border-white/[0.10] bg-[#101217]/72 backdrop-blur-2xl"
      >
        {/*
          Inner scroll container. The outer wrapper keeps `overflow-hidden` so
          the rounded corners + border clip cleanly; without this inner div the
          menu just runs off the bottom of the viewport once 技能节点 / 添加资源
          push the height past the screen. `max-h-[70vh]` adapts to short
          screens; the right-side skill panel already has its own 520px cap.
        */}
        <div className="ui-scrollbar max-h-[min(560px,70vh)] overflow-y-auto px-5 py-5 [scrollbar-gutter:stable]">
        {referenceGenerateItems ? (
          <>
            <CanvasMenuSectionHeader label="引用该节点生成" className="pb-4" />
            <div className="grid grid-cols-4 justify-items-center gap-x-2 gap-y-5">
              {referenceGenerateItems.map((item, index) => {
                const Icon = item.Icon;
                return (
                  <button
                    key={item.key}
                    disabled={item.disabled}
                    onMouseEnter={scheduleSkillPanelClose}
                    className={`${CANVAS_MENU_ICON_CELL_CLASS} ${item.disabled
                        ? 'cursor-not-allowed opacity-35'
                        : 'hover:bg-white/[0.075]'
                      }`}
                    style={{ transitionDelay: isVisible ? `${index * 30}ms` : '0ms' }}
                    onClick={(event) => {
                      const selectedType = item.type;
                      if (!selectedType || item.disabled) {
                        return;
                      }
                      const clientPosition = { x: event.clientX, y: event.clientY };
                      handleClose();
                      setTimeout(() => onSelect(selectedType, clientPosition), UI_POPOVER_TRANSITION_MS + 10);
                    }}
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-300/[0.12]">
                      <Icon className="h-4 w-4 text-cyan-200" />
                    </div>
                    <span className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-5 text-white/82">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (() => {
          return (
            <>
              <CanvasMenuSectionHeader label={t('node.menu.sectionAddNode')} className="pb-4" />
              <CanvasAddNodeGrid
                onItemPointerEnter={scheduleSkillPanelClose}
                transitionDelayForIndex={(index) => (isVisible ? `${index * 30}ms` : '0ms')}
                onSelectNode={(type, clientPosition) => {
                  handleClose();
                  setTimeout(() => onSelect(type, clientPosition), UI_POPOVER_TRANSITION_MS + 10);
                }}
              />
              {onSelectSkill && skillGroups.length > 0 && (
                <>
                  <CanvasMenuSectionHeader label={t('node.menu.sectionSkillNode')} className="pb-3 pt-5" />
                  {skillGroups.map((group, index) => (
                    <button
                      key={group.provider}
                      type="button"
                      className={`${CANVAS_MENU_ROW_CLASS} hover:bg-white/[0.075] ${
                        activeSkillProvider === group.provider ? 'bg-white/[0.075]' : ''
                      }`}
                      style={{ transitionDelay: isVisible ? `${(index + 10) * 30}ms` : '0ms' }}
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
                          {group.items.length} 个技能
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-white/35" />
                    </button>
                  ))}
                </>
              )}
            </>
          );
        })()}
        </div>
      </div>
      {onSelectSkill && activeSkillGroup && (
        <div
          ref={skillPanelRef}
          className={`absolute top-0 w-[420px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] border border-white/[0.10] bg-[#101217]/72 backdrop-blur-2xl ${
            skillPanelSide === 'right'
              ? 'left-[calc(100%+8px)]'
              : 'right-[calc(100%+8px)]'
          }`}
          onPointerEnter={cancelSkillPanelClose}
          onPointerLeave={scheduleSkillPanelClose}
        >
          <div className="px-5 pb-3 pt-5 text-[15px] font-semibold leading-none text-white/62">
            {translateSkillProviderLabel(activeSkillGroup.provider, t)}
          </div>
          <div className="ui-scrollbar max-h-[420px] overflow-y-auto px-3 pb-4 [scrollbar-gutter:stable]">
            {activeSkillGroup.items.map((skill, index) => (
              <button
                key={skill.id}
                type="button"
                className="flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
                style={{ transitionDelay: isVisible ? `${index * 30}ms` : '0ms' }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handleSkillPick(skill);
                }}
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
