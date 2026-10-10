// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";
import {
  Camera,
  FileText,
  Gamepad2,
  Megaphone,
  Film,
  Globe,
  Image,
  LayoutGrid,
  Music,
  Orbit,
  Sparkles,
  Type,
  Upload,
  Video,
  type LucideIcon,
} from "lucide-react";

import {
  CANVAS_NODE_TYPES,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";
import { canvasCreationActions, nodeCatalog } from "@/features/canvas/application/nodeCatalog";
import type { MenuIconKey } from "@/features/canvas/domain/nodeRegistry";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";

export const canvasMenuIconMap: Record<MenuIconKey | "gamepad" | "megaphone", LucideIcon> = {
  gamepad: Gamepad2,
  megaphone: Megaphone,
  upload: Upload,
  sparkles: Sparkles,
  layout: LayoutGrid,
  text: Type,
  video: Video,
  audio: Music,
  script: FileText,
  pano360: Globe,
  threeDWorld: Orbit,
  videoCompose: Film,
  previz: Camera,
};

// 可直接创建画布节点的类型及其菜单顺序。新增普通节点仍在这里登记。
// 互动影游、互动广告属于打开虾导的创作动作，不是 CanvasNodeType，配置在 nodeCatalog.ts
// 的 canvasCreationActions 中，由下方 CANVAS_ADD_MENU_ENTRIES 合并到同一个菜单。
export const CANVAS_ADD_NODE_TYPES: readonly CanvasNodeType[] = [
  CANVAS_NODE_TYPES.textAnnotation,
  CANVAS_NODE_TYPES.beatContext,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.videoCompose,
  CANVAS_NODE_TYPES.audio,
  CANVAS_NODE_TYPES.script,
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.pano360Viewer,
  CANVAS_NODE_TYPES.threeDWorld,
  CANVAS_NODE_TYPES.previz,
  CANVAS_NODE_TYPES.htmlArtifact,
];

// 完整的「添加节点」菜单：普通节点在前，创作动作在后，共用按钮渲染与样式。
// entryType 区分点击行为：node 走节点创建，action 发事件交给虾导处理。
const CANVAS_ADD_MENU_ENTRIES = [
  ...CANVAS_ADD_NODE_TYPES.flatMap((type) => {
    const definition = nodeCatalog.getDefinition(type);
    return definition ? [{ ...definition, id: type, entryType: "node" as const }] : [];
  }),
  ...canvasCreationActions.map((action) => ({ ...action, entryType: "action" as const })),
];

export const CANVAS_MENU_ICON_CELL_CLASS =
  "flex min-w-[58px] max-w-[96px] flex-col items-center gap-1.5 rounded-xl px-2.5 py-2 text-center transition-colors";

export const CANVAS_MENU_ROW_CLASS =
  "flex w-full items-center gap-3 rounded-xl py-2 pl-[17px] pr-2 text-left transition-colors";

interface CanvasMenuSectionHeaderProps {
  label: string;
  className?: string;
}

export function CanvasMenuSectionHeader({
  label,
  className = "",
}: CanvasMenuSectionHeaderProps) {
  return (
    <div className={`text-[15px] font-semibold leading-none text-white/62 ${className}`}>
      {label}
    </div>
  );
}

interface CanvasAddNodeGridProps {
  onActionSelected?: () => void;
  onSelectNode: (type: CanvasNodeType, clientPosition?: { x: number; y: number }) => void;
  onItemPointerEnter?: () => void;
  transitionDelayForIndex?: (index: number) => string | undefined;
}

export function CanvasAddNodeGrid({
  onActionSelected,
  onSelectNode,
  onItemPointerEnter,
  transitionDelayForIndex,
}: CanvasAddNodeGridProps) {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-4 justify-items-center gap-x-2 gap-y-5">
      {CANVAS_ADD_MENU_ENTRIES.map((definition, index) => {
        const Icon = canvasMenuIconMap[definition.menuIcon] ?? Image;
        return (
          <button
            key={definition.id}
            type="button"
            onMouseEnter={onItemPointerEnter}
            className={`${CANVAS_MENU_ICON_CELL_CLASS} hover:bg-white/[0.075]`}
            style={{ transitionDelay: transitionDelayForIndex?.(index) }}
            onClick={(event) => {
              if (definition.entryType === "node") {
                onSelectNode(definition.type, { x: event.clientX, y: event.clientY });
              } else {
                // 创作入口只分发意图；聊天状态由 FreezoneShell 统一处理，不调用节点工厂。
                onActionSelected?.();
                canvasEventBus.publish("freezone/start-creation", { actionId: definition.id });
              }
            }}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-300/[0.12]">
              <Icon className="h-4 w-4 text-cyan-200" />
            </div>
            <span className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-5 text-white/82">
              {t(definition.menuLabelKey)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
